import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import { TRANSACTION_SOURCES, TRANSACTION_STATUS, TRANSACTION_TYPES, TYPE_LIST } from '../domain.js';
import { isPositiveCents, toCents } from '../utils/money.js';
import {
  isValidMonthKey,
  monthKey,
  monthLabel,
  monthRange,
  resolveMonthKey,
} from '../utils/dates.js';

const RATE_WINDOW_MS = 60_000;
const RATE_PRUNE_EVERY = 200;

/** Ventanas deslizantes de ingesta, compartidas por instancia (key: IP). */
const ingestHits = new Map();
let rateCounter = 0;

/**
 * Limpia el estado del rate limit en memoria. Pensado para tests.
 */
export function resetRateLimits() {
  ingestHits.clear();
  rateCounter = 0;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest();
}

/**
 * Compara dos cadenas en tiempo constante sobre sus digests SHA-256.
 * Evita filtrar longitud o prefijos validos del token.
 */
export function safeEqual(a, b) {
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return crypto.timingSafeEqual(sha256(a), sha256(b));
}

function extractToken(req) {
  const header = String(req.get('authorization') || '').trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  if (bearer) return bearer[1].trim();
  const alt = req.get('x-api-token');
  return alt ? String(alt).trim() : null;
}

function pruneRateLimits(now) {
  if (rateCounter < RATE_PRUNE_EVERY) return;
  rateCounter = 0;
  for (const [ip, hits] of ingestHits) {
    const fresh = hits.filter((stamp) => now - stamp < RATE_WINDOW_MS);
    if (fresh.length === 0) ingestHits.delete(ip);
    else ingestHits.set(ip, fresh);
  }
}

function isStoreError(error) {
  return error?.name === 'StoreError' || error?.code === 'DUPLICATE_CATEGORY';
}

/**
 * Traduce errores de dominio a respuestas HTTP. Devuelve true si respondio.
 */
function respondStoreError(res, error) {
  if (!error || res.headersSent) return false;
  if (error.code === 'DUPLICATE_CATEGORY') {
    res.status(409).json({ error: 'categoria-duplicada', message: error.message });
    return true;
  }
  if (isStoreError(error)) {
    res.status(400).json({ error: 'solicitud-invalida', message: error.message });
    return true;
  }
  return false;
}

function isoOf(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
}

/**
 * Servidor HTTP de la app: API JSON para ingesta, consulta y webhook de Telegram.
 * No arranca al importarse; el llamador decide cuando hacer start().
 *
 * @param {{config: object, repos: object, services: object, logger: object, bot?: object|null}} deps
 * @returns {{app: import('express').Express, server: import('node:http').Server, start: Function, stop: Function, url: string, port: number}}
 */
export function createWebServer({ config, repos, services, logger, bot = null }) {
  const timezone = config.app.timezone;
  const currency = config.app.currency;
  const locale = config.app.locale;
  const version = config.app.version;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '25mb' }));

  // Identificador de request + cabeceras de seguridad + cache de API.
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    req.id = requestId;
    res.setHeader('x-request-id', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      logger?.debug?.('http', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs),
      });
    });
    next();
  });

  /** Resuelve el mes de un query string; null si vino invalido. */
  function monthFromQuery(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    const text = raw === undefined || raw === null ? '' : String(raw).trim();
    if (!text) return monthKey(new Date(), timezone);
    const resolved = resolveMonthKey(text, new Date(), timezone);
    return resolved && isValidMonthKey(resolved) ? resolved : null;
  }

  function requireApiToken(req, res, next) {
    const expected = String(config.api.token || '');
    if (!expected) {
      res.status(503).json({
        error: 'api-deshabilitada',
        message: 'La API está deshabilitada: falta configurar API_TOKEN.',
      });
      return;
    }
    const provided = extractToken(req);
    if (!provided || !safeEqual(provided, expected)) {
      res.status(401).json({ error: 'no-autorizado', message: 'Token de API inválido.' });
      return;
    }
    next();
  }

  function requireIngestToken(req, res, next) {
    const expected = [config.api.emailIngestToken, config.api.token]
      .map((value) => String(value || ''))
      .filter(Boolean);
    if (expected.length === 0) {
      res.status(503).json({
        error: 'ingesta-deshabilitada',
        message: 'La ingesta por email está deshabilitada: falta configurar un token.',
      });
      return;
    }
    const provided = extractToken(req);
    if (!provided || !expected.some((token) => safeEqual(provided, token))) {
      res.status(401).json({ error: 'no-autorizado', message: 'Token de ingesta inválido.' });
      return;
    }
    next();
  }

  function ingestRateLimit(req, res, next) {
    const limit = Number(config.api.rateLimitPerMinute) || 0;
    if (limit <= 0) {
      next();
      return;
    }
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const hits = (ingestHits.get(ip) || []).filter((stamp) => now - stamp < RATE_WINDOW_MS);
    if (hits.length >= limit) {
      const retryAfter = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - hits[0])) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: 'demasiadas-solicitudes',
        message: 'Demasiadas solicitudes de ingesta. Probá de nuevo en un minuto.',
      });
      return;
    }
    hits.push(now);
    ingestHits.set(ip, hits);
    rateCounter += 1;
    pruneRateLimits(now);
    next();
  }

  /** Envuelve handlers async para que los rechazos lleguen al error handler. */
  function route(handler) {
    return (req, res, next) => {
      Promise.resolve(handler(req, res, next)).catch((error) => {
        if (!respondStoreError(res, error)) next(error);
      });
    };
  }

  async function readiness(res) {
    try {
      await repos.ping();
      res.status(200).json({
        status: 'ok',
        uptime: process.uptime(),
        version,
        timestamp: new Date().toISOString(),
        db: 'ok',
      });
    } catch (error) {
      logger?.error?.('healthcheck de base de datos fallido', { error });
      res.status(503).json({ status: 'error', db: 'error', version });
    }
  }

  function resolveApiUser(body) {
    if (body?.userId) return repos.users.get(String(body.userId));
    if (body?.telegramId) {
      return services.users.resolveTelegramUser({ telegramId: body.telegramId }).then((result) => (
        result.ok ? result.user : null
      ));
    }
    if (body?.email) return services.users.resolveEmailUser(body.email);
    return Promise.resolve(null);
  }

  // ---------------------------------------------------------------------------
  // Raiz y salud
  // ---------------------------------------------------------------------------
  app.get('/', (req, res) => {
    res.json({
      name: config.app.name,
      version,
      status: 'ok',
      docs: '/healthz',
      time: new Date().toISOString(),
    });
  });

  app.get('/healthz', route(async (req, res) => {
    await readiness(res);
  }));

  app.get('/readyz', route(async (req, res) => {
    await readiness(res);
  }));

  // ---------------------------------------------------------------------------
  // Telegram
  // ---------------------------------------------------------------------------
  app.post('/api/telegram/webhook', route(async (req, res) => {
    const secret = String(config.telegram.webhookSecret || '');
    if (secret) {
      const provided = req.get('x-telegram-bot-api-secret-token');
      if (!provided || !safeEqual(provided, secret)) {
        res.status(401).json({ error: 'no-autorizado', message: 'Secreto de webhook inválido.' });
        return;
      }
    }
    if (!bot) {
      res.status(503).json({ error: 'bot-deshabilitado', message: 'El bot de Telegram no está disponible.' });
      return;
    }
    const update = req.body;
    if (!update || update.update_id === undefined || update.update_id === null) {
      res.status(400).json({ error: 'update-invalido', message: 'Falta update_id en el update.' });
      return;
    }
    try {
      await bot.handleUpdate(update);
    } catch (error) {
      logger?.error?.('fallo procesando update de Telegram', { requestId: req.id, error });
      res.status(500).json({ error: 'error-interno', message: 'No pude procesar la actualización.' });
      return;
    }
    res.json({ ok: true });
  }));

  // ---------------------------------------------------------------------------
  // Ingesta de email
  // ---------------------------------------------------------------------------
  app.post('/api/email/inbound', requireIngestToken, ingestRateLimit, route(async (req, res) => {
    const payload = req.body || {};
    if (!payload.from || String(payload.from).trim() === '') {
      res.status(400).json({ error: 'from-requerido', message: 'El email debe incluir remitente ("from").' });
      return;
    }
    if (!services.email?.ingestEmail) {
      res.status(503).json({ error: 'email-deshabilitado', message: 'La ingesta de email no está disponible.' });
      return;
    }
    try {
      const result = await services.email.ingestEmail(payload);
      const status = result?.httpStatus || (result?.ok ? 202 : 400);
      res.status(status).json(result);
    } catch (error) {
      logger?.error?.('fallo la ingesta de email', { requestId: req.id, error });
      res.status(500).json({ error: 'error-interno', message: 'No pude procesar el email.' });
    }
  }));

  // ---------------------------------------------------------------------------
  // Resumen y movimientos
  // ---------------------------------------------------------------------------
  app.get('/api/summary', requireApiToken, route(async (req, res) => {
    const key = monthFromQuery(req.query.month);
    if (!key) {
      res.status(400).json({ error: 'mes-invalido', message: 'El mes debe tener formato YYYY-MM.' });
      return;
    }
    const snapshot = await services.alerts.getSummary(key);
    const range = snapshot.range || monthRange(key, timezone);
    const { transactions, ...totals } = snapshot.totals || {};
    res.json({
      monthKey: snapshot.monthKey || key,
      label: range.label || monthLabel(key),
      range: {
        start: range.startIso || isoOf(range.start),
        end: range.endIso || isoOf(range.end),
      },
      totals,
      budget: snapshot.summary,
      overallBudgetCents: snapshot.overallBudgetCents ?? null,
    });
  }));

  app.get('/api/transactions', requireApiToken, route(async (req, res) => {
    const key = monthFromQuery(req.query.month);
    if (!key) {
      res.status(400).json({ error: 'mes-invalido', message: 'El mes debe tener formato YYYY-MM.' });
      return;
    }
    const rawType = typeof req.query.type === 'string' && req.query.type.trim() ? req.query.type.trim() : null;
    if (rawType && !TYPE_LIST.includes(rawType)) {
      res.status(400).json({ error: 'tipo-invalido', message: 'Tipo de movimiento inválido.' });
      return;
    }
    const rawStatus = typeof req.query.status === 'string' && req.query.status.trim() ? req.query.status.trim() : null;
    if (rawStatus && !Object.values(TRANSACTION_STATUS).includes(rawStatus)) {
      res.status(400).json({ error: 'estado-invalido', message: 'Estado de movimiento inválido.' });
      return;
    }
    const range = monthRange(key, timezone);
    const transactions = await repos.transactions.list({
      from: range.startIso,
      to: range.endIso,
      limit: req.query.limit,
      type: rawType,
      userId: req.query.userId ? String(req.query.userId) : null,
      status: rawStatus,
    });
    res.json({ monthKey: key, count: transactions.length, transactions });
  }));

  app.post('/api/transactions', requireApiToken, route(async (req, res) => {
    const body = req.body || {};
    if (!TYPE_LIST.includes(body.type)) {
      res.status(400).json({ error: 'tipo-invalido', message: 'Tipo de movimiento inválido.' });
      return;
    }
    const amountCents = body.amountCents !== undefined && body.amountCents !== null
      ? Number(body.amountCents)
      : toCents(body.amount);
    if (!isPositiveCents(amountCents)) {
      res.status(400).json({ error: 'monto-invalido', message: 'El monto debe ser mayor a cero.' });
      return;
    }

    let user = null;
    if (body.userId || body.telegramId || body.email) {
      user = await resolveApiUser(body);
      if (!user) {
        res.status(400).json({ error: 'usuario-desconocido', message: 'No pude identificar al usuario indicado.' });
        return;
      }
    }

    const result = await services.transactions.create({
      user,
      userId: body.userId ? String(body.userId) : null,
      type: body.type,
      amountCents,
      category: body.category ?? null,
      categoryId: body.categoryId ?? null,
      note: body.note || '',
      occurredAt: body.occurredAt || new Date(),
      source: TRANSACTION_SOURCES.API,
      metadata: { api: true, requestId: req.id },
    });

    res.status(201).json({
      transaction: result.transaction,
      category: result.category,
      alerts: Array.isArray(result.alerts) ? result.alerts.length : 0,
    });
  }));

  app.get('/api/alerts', requireApiToken, route(async (req, res) => {
    const key = monthFromQuery(req.query.month);
    if (!key) {
      res.status(400).json({ error: 'mes-invalido', message: 'El mes debe tener formato YYYY-MM.' });
      return;
    }
    const [snapshot, alerts] = await Promise.all([
      services.alerts.getSummary(key),
      repos.alerts.list({ period: key }),
    ]);
    res.json({
      monthKey: key,
      label: monthLabel(key),
      alerts,
      budget: snapshot.summary,
      overallBudgetCents: snapshot.overallBudgetCents ?? null,
    });
  }));

  // ---------------------------------------------------------------------------
  // Categorias
  // ---------------------------------------------------------------------------
  app.get('/api/categories', requireApiToken, route(async (req, res) => {
    const categories = await repos.categories.list({ includeInactive: req.query.all === '1' });
    res.json({ categories });
  }));

  app.post('/api/categories', requireApiToken, route(async (req, res) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'nombre-requerido', message: 'El nombre de la categoría es obligatorio.' });
      return;
    }
    if (!TYPE_LIST.includes(body.type)) {
      res.status(400).json({ error: 'tipo-invalido', message: 'Tipo de categoría inválido.' });
      return;
    }
    let monthlyBudgetCents = null;
    if (body.monthlyBudgetCents !== undefined && body.monthlyBudgetCents !== null) {
      monthlyBudgetCents = Number(body.monthlyBudgetCents);
    } else if (body.budget !== undefined && body.budget !== null) {
      monthlyBudgetCents = toCents(body.budget);
    }
    if (monthlyBudgetCents !== null && (!Number.isSafeInteger(monthlyBudgetCents) || monthlyBudgetCents < 0)) {
      res.status(400).json({ error: 'presupuesto-invalido', message: 'El presupuesto mensual es inválido.' });
      return;
    }
    const category = await repos.categories.create({
      name,
      type: body.type,
      emoji: body.emoji,
      monthlyBudgetCents,
      keywords: body.keywords,
    });
    res.status(201).json({ category });
  }));

  // ---------------------------------------------------------------------------
  // Metas de ahorro
  // ---------------------------------------------------------------------------
  app.get('/api/goals', requireApiToken, route(async (req, res) => {
    const goals = await repos.goals.list();
    res.json({ goals });
  }));

  app.post('/api/goals', requireApiToken, route(async (req, res) => {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'nombre-requerido', message: 'El nombre de la meta es obligatorio.' });
      return;
    }
    const targetCents = body.targetCents !== undefined && body.targetCents !== null
      ? Number(body.targetCents)
      : toCents(body.target);
    if (!isPositiveCents(targetCents)) {
      res.status(400).json({ error: 'objetivo-invalido', message: 'El objetivo debe ser mayor a cero.' });
      return;
    }
    const goal = await repos.goals.create({
      name,
      targetCents,
      deadline: body.deadline,
      userId: body.userId,
    });
    res.status(201).json({ goal });
  }));

  app.post('/api/goals/:id/contribute', requireApiToken, route(async (req, res) => {
    const goal = await repos.goals.get(req.params.id);
    if (!goal) {
      res.status(404).json({ error: 'meta-no-encontrada', message: 'No encontré la meta indicada.' });
      return;
    }
    const body = req.body || {};
    const amountCents = body.amountCents !== undefined && body.amountCents !== null
      ? Number(body.amountCents)
      : toCents(body.amount);
    if (!isPositiveCents(amountCents)) {
      res.status(400).json({ error: 'monto-invalido', message: 'El aporte debe ser mayor a cero.' });
      return;
    }
    const user = body.userId ? await repos.users.get(String(body.userId)) : (goal.userId ? await repos.users.get(goal.userId) : null);
    const result = await services.transactions.create({
      user,
      userId: body.userId || goal.userId || null,
      type: TRANSACTION_TYPES.INVESTMENT,
      amountCents,
      category: 'Inversiones',
      note: body.note || `Aporte a meta: ${goal.name}`,
      occurredAt: body.occurredAt || new Date(),
      source: TRANSACTION_SOURCES.API,
      metadata: { goalId: goal.id, api: true, requestId: req.id },
    });
    const updated = await repos.goals.contribute(goal.id, amountCents);
    res.json({ goal: updated, transaction: result.transaction });
  }));

  // ---------------------------------------------------------------------------
  // 404 y manejo de errores
  // ---------------------------------------------------------------------------
  app.use((req, res) => {
    res.status(404).json({ error: 'no-encontrado', message: 'Ruta no encontrada.' });
  });

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error?.type === 'entity.parse.failed' || (error instanceof SyntaxError && error.status === 400)) {
      res.status(400).json({ error: 'json-invalido', message: 'El cuerpo JSON es inválido.' });
      return;
    }
    if (error?.type === 'entity.too.large') {
      res.status(413).json({ error: 'cuerpo-demasiado-grande', message: 'El cuerpo supera el límite permitido.' });
      return;
    }
    if (isStoreError(error)) {
      respondStoreError(res, error);
      return;
    }
    logger?.error?.('error no controlado en la API', {
      requestId: req.id,
      method: req.method,
      path: req.path,
      error,
    });
    const payload = {
      error: 'error-interno',
      message: 'Ocurrió un error inesperado.',
    };
    if (config.app.env !== 'production') payload.stack = error?.stack;
    res.status(500).json(payload);
  });

  const server = http.createServer(app);
  let listening = false;

  function currentPort() {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  /**
   * Arranca el servidor. Acepta puerto 0 para obtener uno libre (tests).
   * @param {number} [port]
   * @returns {Promise<{port: number, url: string}>}
   */
  async function start(port = config.app.port) {
    if (listening) return { port: currentPort(), url: `http://127.0.0.1:${currentPort()}` };
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port);
    });
    listening = true;
    const actualPort = currentPort();
    logger?.info?.('servidor web escuchando', { port: actualPort });
    return { port: actualPort, url: `http://127.0.0.1:${actualPort}` };
  }

  /**
   * Cierra el servidor y sus conexiones keep-alive. Es seguro llamarlo si no
   * estaba escuchando.
   * @returns {Promise<void>}
   */
  function stop() {
    return new Promise((resolve) => {
      if (!server.listening) {
        listening = false;
        resolve();
        return;
      }
      server.close(() => {
        listening = false;
        resolve();
      });
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
    });
  }

  return {
    app,
    server,
    start,
    stop,
    get url() {
      return `http://127.0.0.1:${currentPort()}`;
    },
    get port() {
      return currentPort();
    },
  };
}
