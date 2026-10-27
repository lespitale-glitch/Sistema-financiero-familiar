import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/index.js';
import { DEFAULT_CATEGORIES } from '../src/domain.js';
import { createLogger } from '../src/logger.js';
import { createUsersService } from '../src/services/users.js';
import { createTransactionsService } from '../src/services/transactions.js';
import { createWebServer, resetRateLimits } from '../src/web/server.js';
import { monthRange } from '../src/utils/dates.js';

const silentLogger = createLogger({ level: 'silent' });
const API_TOKEN = 'api-secreto-de-test';
const INGEST_TOKEN = 'ingesta-secreto-de-test';

/** Ruta aislada en el directorio temporal (SQLite no acepta ":memory:" aca). */
function tempDbPath() {
  return path.join(os.tmpdir(), `finanzas-web-${process.pid}-${randomUUID()}.sqlite`);
}

function removeDb(filePath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${filePath}${suffix}`, { force: true });
    } catch {
      // limpieza best-effort
    }
  }
}

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SQLITE_PATH: tempDbPath(),
    API_TOKEN,
    EMAIL_INGEST_TOKEN: INGEST_TOKEN,
    TELEGRAM_WEBHOOK_SECRET: 'webhook-secreto',
    FAMILY_MEMBERS: 'Ana|wife|111|ana@example.com;Beto|husband|222|beto@example.com',
    FAMILY_CHAT_ID: '999',
    INGEST_RATE_LIMIT_PER_MINUTE: '0',
    TZ: 'UTC',
    CURRENCY: 'ARS',
    LOCALE: 'es-AR',
    ...overrides,
  });
}

function apiFetch(baseUrl, path, { method = 'GET', token, body, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(response) {
  return response.json();
}

/**
 * Arma una app completa con base en memoria, servicios reales y alertas
 * simuladas (el objetivo de este archivo es la capa HTTP).
 */
async function setup({ env = {}, email = null, bot = null } = {}) {
  const config = makeConfig(env);
  const repos = await createDatabase(config, { logger: silentLogger });
  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
  const users = createUsersService({ repos, config, logger: silentLogger });
  await users.syncFamilyMembers();

  const alerts = {
    async getSummary(key) {
      const range = monthRange(key, 'UTC');
      const totals = await repos.transactions.totals({ from: range.startIso, to: range.endIso });
      return {
        monthKey: key,
        range,
        totals,
        summary: { overall: { budgetCents: null, spentCents: totals.expenseCents, percent: null }, categories: [] },
        overallBudgetCents: null,
      };
    },
    async evaluateForTransaction() {
      return { skipped: false, alerts: [] };
    },
    async evaluateMonth() {
      return { skipped: false, alerts: [] };
    },
  };

  const transactions = createTransactionsService({
    repos,
    config,
    alerts,
    logger: silentLogger,
    clock: () => new Date('2026-10-15T15:00:00.000Z'),
  });

  const services = {
    users,
    alerts,
    transactions,
    email: email || {
      async ingestEmail() {
        return { ok: true, status: 'logged', httpStatus: 202, transactionId: 'fake-tx' };
      },
    },
  };

  const web = createWebServer({ config, repos, services, logger: silentLogger, bot });
  const { port, url } = await web.start(0);
  return { config, repos, services, web, port, url };
}

test('GET / expone metadatos y /healthz + /readyz verifican la base', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const root = await apiFetch(ctx.url, '/');
  assert.equal(root.status, 200);
  const rootBody = await json(root);
  assert.equal(rootBody.status, 'ok');
  assert.equal(rootBody.docs, '/healthz');
  assert.ok(rootBody.version);

  for (const path of ['/healthz', '/readyz']) {
    const response = await apiFetch(ctx.url, path);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.db, 'ok');
    assert.equal(body.status, 'ok');
  }
});

test('GET /api/summary exige token valido y devuelve totales y presupuesto', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const missing = await apiFetch(ctx.url, '/api/summary');
  assert.equal(missing.status, 401);

  const wrong = await apiFetch(ctx.url, '/api/summary', { token: 'token-invalido' });
  assert.equal(wrong.status, 401);

  const invalidMonth = await apiFetch(ctx.url, '/api/summary?month=2026-13', { token: API_TOKEN });
  assert.equal(invalidMonth.status, 400);

  const response = await apiFetch(ctx.url, '/api/summary?month=2026-10', { token: API_TOKEN });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.monthKey, '2026-10');
  assert.equal(body.label, 'Octubre 2026');
  assert.ok(body.range.start && body.range.end);
  assert.ok(body.totals);
  assert.equal(body.totals.transactions, undefined);
  assert.equal(typeof body.totals.expenseCents, 'number');
  assert.ok(body.budget);
});

test('POST /api/transactions acepta monto en unidades y GET lo lista', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const created = await apiFetch(ctx.url, '/api/transactions', {
    method: 'POST',
    token: API_TOKEN,
    body: {
      type: 'variable_expense',
      amount: 1500.5,
      category: 'Supermercado',
      note: 'Compra semanal',
      occurredAt: '2026-10-15T12:00:00.000Z',
      userId: (await ctx.repos.users.getByEmail('ana@example.com')).id,
    },
  });
  assert.equal(created.status, 201);
  const createdBody = await json(created);
  assert.equal(createdBody.transaction.amountCents, 150050);
  assert.equal(createdBody.transaction.source, 'api');
  assert.equal(createdBody.category.name, 'Supermercado');
  assert.equal(createdBody.alerts, 0);

  const listed = await apiFetch(ctx.url, '/api/transactions?month=2026-10', { token: API_TOKEN });
  assert.equal(listed.status, 200);
  const listedBody = await json(listed);
  assert.equal(listedBody.monthKey, '2026-10');
  assert.equal(listedBody.count, 1);
  assert.equal(listedBody.transactions[0].id, createdBody.transaction.id);
});

test('POST /api/transactions valida tipo y monto', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const badType = await apiFetch(ctx.url, '/api/transactions', {
    method: 'POST',
    token: API_TOKEN,
    body: { type: 'regalo', amount: 10 },
  });
  assert.equal(badType.status, 400);

  const badAmount = await apiFetch(ctx.url, '/api/transactions', {
    method: 'POST',
    token: API_TOKEN,
    body: { type: 'variable_expense', amount: 0 },
  });
  assert.equal(badAmount.status, 400);
});

test('POST /api/categories crea y detecta duplicados; GET las lista', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const payload = {
    name: 'Mascotas',
    type: 'variable_expense',
    budget: 25000.75,
    emoji: '🐶',
    keywords: ['veterinaria', 'alimento'],
  };
  const created = await apiFetch(ctx.url, '/api/categories', {
    method: 'POST',
    token: API_TOKEN,
    body: payload,
  });
  assert.equal(created.status, 201);
  const createdBody = await json(created);
  assert.equal(createdBody.category.name, 'Mascotas');
  assert.equal(createdBody.category.monthlyBudgetCents, 2500075);

  const duplicate = await apiFetch(ctx.url, '/api/categories', {
    method: 'POST',
    token: API_TOKEN,
    body: payload,
  });
  assert.equal(duplicate.status, 409);
  const duplicateBody = await json(duplicate);
  assert.equal(duplicateBody.error, 'categoria-duplicada');

  const listed = await apiFetch(ctx.url, '/api/categories', { token: API_TOKEN });
  assert.equal(listed.status, 200);
  const listedBody = await json(listed);
  assert.ok(listedBody.categories.some((category) => category.name === 'Mascotas'));
});

test('POST /api/goals y contribute crean inversion y actualizan la meta', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const created = await apiFetch(ctx.url, '/api/goals', {
    method: 'POST',
    token: API_TOKEN,
    body: { name: 'Vacaciones', target: 100000, deadline: '2027-01-01' },
  });
  assert.equal(created.status, 201);
  const goal = (await json(created)).goal;
  assert.equal(goal.targetCents, 10000000);

  const contributed = await apiFetch(ctx.url, `/api/goals/${goal.id}/contribute`, {
    method: 'POST',
    token: API_TOKEN,
    body: { amount: 5000, note: 'Aporte de octubre' },
  });
  assert.equal(contributed.status, 200);
  const contributedBody = await json(contributed);
  assert.equal(contributedBody.goal.savedCents, 500000);
  assert.equal(contributedBody.transaction.type, 'investment');
  assert.equal(contributedBody.transaction.amountCents, 500000);

  const missing = await apiFetch(ctx.url, '/api/goals/no-existe/contribute', {
    method: 'POST',
    token: API_TOKEN,
    body: { amount: 10 },
  });
  assert.equal(missing.status, 404);
});

test('webhook de Telegram valida secreto y llama al bot', async (t) => {
  const calls = [];
  const bot = { handleUpdate: async (update) => { calls.push(update); } };
  const ctx = await setup({ bot });
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const wrong = await apiFetch(ctx.url, '/api/telegram/webhook', {
    method: 'POST',
    body: { update_id: 1 },
    headers: { 'x-telegram-bot-api-secret-token': 'incorrecto' },
  });
  assert.equal(wrong.status, 401);

  const ok = await apiFetch(ctx.url, '/api/telegram/webhook', {
    method: 'POST',
    body: { update_id: 42, message: { text: 'hola' } },
    headers: { 'x-telegram-bot-api-secret-token': 'webhook-secreto' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await json(ok), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].update_id, 42);

  const invalid = await apiFetch(ctx.url, '/api/telegram/webhook', {
    method: 'POST',
    body: { message: {} },
    headers: { 'x-telegram-bot-api-secret-token': 'webhook-secreto' },
  });
  assert.equal(invalid.status, 400);
});

test('webhook sin bot responde 503', async (t) => {
  const ctx = await setup({ bot: null });
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const response = await apiFetch(ctx.url, '/api/telegram/webhook', {
    method: 'POST',
    body: { update_id: 7 },
    headers: { 'x-telegram-bot-api-secret-token': 'webhook-secreto' },
  });
  assert.equal(response.status, 503);
  assert.equal((await json(response)).error, 'bot-deshabilitado');
});

test('ingesta de email usa el servicio y valida el remitente', async (t) => {
  const received = [];
  const email = {
    async ingestEmail(payload) {
      received.push(payload);
      return { ok: true, status: 'logged', httpStatus: 202, transactionId: 'tx-1' };
    },
  };
  const ctx = await setup({ email });
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const missingFrom = await apiFetch(ctx.url, '/api/email/inbound', {
    method: 'POST',
    token: INGEST_TOKEN,
    body: { subject: 'sin remitente' },
  });
  assert.equal(missingFrom.status, 400);

  const ok = await apiFetch(ctx.url, '/api/email/inbound', {
    method: 'POST',
    token: INGEST_TOKEN,
    body: { from: 'ana@example.com', subject: 'Factura', text: 'Gasté 1000' },
  });
  assert.equal(ok.status, 202);
  const body = await json(ok);
  assert.equal(body.status, 'logged');
  assert.equal(received.length, 1);
  assert.equal(received[0].from, 'ana@example.com');

  const unauthorized = await apiFetch(ctx.url, '/api/email/inbound', {
    method: 'POST',
    body: { from: 'ana@example.com' },
  });
  assert.equal(unauthorized.status, 401);
});

test('rate limit de ingesta corta en el limite configurado', async (t) => {
  resetRateLimits();
  const ctx = await setup({ env: { INGEST_RATE_LIMIT_PER_MINUTE: '2' } });
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
    resetRateLimits();
  });

  const send = () => apiFetch(ctx.url, '/api/email/inbound', {
    method: 'POST',
    token: INGEST_TOKEN,
    body: { from: 'ana@example.com', text: 'Gasté 1000' },
  });

  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 202);
  const limited = await send();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('retry-after'));
  assert.equal((await json(limited)).error, 'demasiadas-solicitudes');
});

test('rate limit no se evade falseando X-Forwarded-For (trust proxy = 1 salto)', async (t) => {
  resetRateLimits();
  const ctx = await setup({ env: { INGEST_RATE_LIMIT_PER_MINUTE: '2' } });
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
    resetRateLimits();
  });

  // El atacante controla las entradas de la izquierda; el proxy real agrega la ultima.
  const send = (fakeIp) => apiFetch(ctx.url, '/api/email/inbound', {
    method: 'POST',
    token: INGEST_TOKEN,
    headers: { 'x-forwarded-for': `${fakeIp}, 203.0.113.7` },
    body: { from: 'ana@example.com', text: 'Gasté 1000' },
  });

  assert.equal(ctx.config.api.trustProxy, 1);
  assert.equal((await send('1.1.1.1')).status, 202);
  assert.equal((await send('2.2.2.2')).status, 202);
  assert.equal((await send('3.3.3.3')).status, 429);
});

test('body JSON mayor a 1 MB se rechaza fuera de la ingesta de email', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const big = await apiFetch(ctx.url, '/api/transactions', {
    method: 'POST',
    token: API_TOKEN,
    body: { type: 'expense', amount: 100, description: 'x'.repeat(1_100_000) },
  });
  assert.equal(big.status, 413);

  const email = await apiFetch(ctx.url, '/api/email/inbound', {
    method: 'POST',
    token: INGEST_TOKEN,
    body: { from: 'ana@example.com', text: 'Gasté 1000', html: 'x'.repeat(1_100_000) },
  });
  assert.equal(email.status, 202);
});

test('GET /api/alerts devuelve alertas y presupuesto del mes', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const response = await apiFetch(ctx.url, '/api/alerts?month=2026-10', { token: API_TOKEN });
  assert.equal(response.status, 200);
  const body = await json(response);
  assert.equal(body.monthKey, '2026-10');
  assert.ok(Array.isArray(body.alerts));
  assert.ok(body.budget);
});

test('ruta desconocida devuelve 404 JSON y JSON invalido devuelve 400', async (t) => {
  const ctx = await setup();
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.web.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });

  const notFound = await apiFetch(ctx.url, '/no-existe');
  assert.equal(notFound.status, 404);
  assert.equal((await json(notFound)).error, 'no-encontrado');

  const badJson = await fetch(`${ctx.url}/api/transactions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_TOKEN}`, 'content-type': 'application/json' },
    body: '{ esto no es json',
  });
  assert.equal(badJson.status, 400);
  assert.equal((await json(badJson)).error, 'json-invalido');
});
