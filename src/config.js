import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { ROLES } from './domain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

const TRUTHY = new Set(['1', 'true', 'yes', 'si', 'sí', 'on']);
const FALSY = new Set(['0', 'false', 'no', 'off', '']);

function str(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function int(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function bool(value, fallback = false) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (TRUTHY.has(normalized)) return true;
  if (FALSY.has(normalized)) return false;
  return fallback;
}

/**
 * Valor de Express "trust proxy". Default 1 (un proxy delante: Render, Nginx).
 * Nunca usar `true` en produccion: cualquiera podria falsear X-Forwarded-For
 * y evadir el rate limit por IP.
 */
function parseTrustProxy(value) {
  const text = str(value, '1').toLowerCase();
  if (['false', 'no', 'off', '0'].includes(text)) return false;
  if (['true', 'yes', 'on'].includes(text)) return true;
  const hops = Number.parseInt(text, 10);
  if (Number.isInteger(hops) && hops > 0 && String(hops) === text) return hops;
  // Lista de IPs/subredes o presets de Express (loopback, uniquelocal...).
  return str(value);
}

function list(value) {
  return str(value)
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isTimeOfDay(value) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(str(value));
}

function normalizeTimezone(value) {
  const candidate = str(value) || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return 'UTC';
  }
}

/**
 * Parsea FAMILY_MEMBERS: "Nombre|rol|telegramId|email;Nombre|rol||email".
 * Los campos vacios se devuelven como null. Ignora entradas sin nombre.
 */
export function parseFamilyMembers(raw) {
  const members = [];
  const seenIds = new Set();
  for (const chunk of String(raw ?? '').split(/[;\n]+/)) {
    const line = chunk.trim();
    if (!line) continue;
    const [rawName, rawRole, rawTelegramId, rawEmail] = line.split('|').map((part) => part.trim());
    if (!rawName) continue;
    const role = Object.values(ROLES).includes(rawRole) ? rawRole : ROLES.OTHER;
    const telegramId = rawTelegramId ? rawTelegramId.replace(/[^\d-]/g, '') : null;
    const email = rawEmail ? rawEmail.toLowerCase() : null;
    const key = telegramId || email || rawName.toLowerCase();
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    members.push({
      name: rawName,
      role,
      telegramId: telegramId || null,
      email: email || null,
    });
  }
  return members;
}

/**
 * Construye la configuracion completa a partir de un objeto de entorno.
 * No lanza por valores faltantes: devuelve flags `enabled` y validateConfig()
 * informa que funciones quedan apagadas.
 */
export function loadConfig(env = process.env, { loadEnvFile = false } = {}) {
  if (loadEnvFile) dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });

  const timezone = normalizeTimezone(env.TZ || env.REPORT_TIMEZONE || 'UTC');
  const familyChatId = str(env.FAMILY_CHAT_ID) || null;
  const telegramChatIds = list(env.TELEGRAM_ALLOWED_CHAT_IDS);

  const thresholds = list(env.BUDGET_ALERT_THRESHOLDS)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0 && value <= 1000);
  const alertThresholds = (thresholds.length ? thresholds : [80, 100])
    .sort((a, b) => a - b)
    .filter((value, index, all) => all.indexOf(value) === index);

  const dailyAt = isTimeOfDay(env.DAILY_SUMMARY_AT) ? str(env.DAILY_SUMMARY_AT) : '21:00';
  const weeklyAt = isTimeOfDay(env.WEEKLY_SUMMARY_AT) ? str(env.WEEKLY_SUMMARY_AT) : '09:00';
  const monthlyAt = isTimeOfDay(env.MONTHLY_SUMMARY_AT) ? str(env.MONTHLY_SUMMARY_AT) : '08:00';

  const rawSqlitePath = str(env.SQLITE_PATH) || ':memory:';
  const sqlitePath = rawSqlitePath === ':memory:' || path.isAbsolute(rawSqlitePath)
    ? rawSqlitePath
    : path.join(PROJECT_ROOT, rawSqlitePath);
  const dbDriver = str(env.DB_DRIVER, 'sqlite').toLowerCase() === 'supabase' ? 'supabase' : 'sqlite';

  const apiToken = str(env.API_TOKEN);
  const emailIngestToken = str(env.EMAIL_INGEST_TOKEN) || apiToken;

  const telegramToken = str(env.TELEGRAM_BOT_TOKEN);
  const mode = str(env.TELEGRAM_MODE, 'polling').toLowerCase() === 'webhook' ? 'webhook' : 'polling';

  const config = {
    app: {
      name: str(env.APP_NAME, 'Finanzas Familiares'),
      version: '1.0.0',
      env: str(env.NODE_ENV, 'development'),
      port: int(env.PORT, 3000, { min: 1, max: 65535 }),
      timezone,
      locale: str(env.LOCALE, 'es-AR'),
      currency: str(env.CURRENCY, 'ARS').toUpperCase(),
      logLevel: str(env.LOG_LEVEL, 'info').toLowerCase(),
    },
    telegram: {
      token: telegramToken,
      enabled: Boolean(telegramToken),
      mode,
      publicUrl: str(env.PUBLIC_URL).replace(/\/+$/, ''),
      webhookSecret: str(env.TELEGRAM_WEBHOOK_SECRET),
      familyChatId,
      allowedChatIds: telegramChatIds,
      alertAuthorDm: bool(env.ALERT_AUTHOR_DM, true),
    },
    db: {
      driver: dbDriver,
      sqlitePath,
      supabase: {
        url: str(env.SUPABASE_URL).replace(/\/+$/, ''),
        key: str(env.SUPABASE_SERVICE_ROLE_KEY),
        schema: str(env.SUPABASE_SCHEMA, 'public'),
      },
    },
    gemini: {
      apiKey: str(env.GEMINI_API_KEY),
      enabled: Boolean(str(env.GEMINI_API_KEY)),
      baseUrl: str(env.GEMINI_BASE_URL, 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, ''),
      textModel: str(env.GEMINI_MODEL, 'gemini-2.5-flash'),
      visionModel: str(env.GEMINI_VISION_MODEL, str(env.GEMINI_MODEL, 'gemini-2.5-flash')),
      audioModel: str(env.GEMINI_AUDIO_MODEL, str(env.GEMINI_MODEL, 'gemini-2.5-flash')),
      maxUploadBytes: int(env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024, { min: 1024, max: 40 * 1024 * 1024 }),
    },
    api: {
      token: apiToken,
      emailIngestToken,
      enabled: Boolean(apiToken),
      rateLimitPerMinute: int(env.INGEST_RATE_LIMIT_PER_MINUTE, 30, { min: 0, max: 10000 }),
      trustProxy: parseTrustProxy(env.TRUST_PROXY),
    },
    email: {
      forwardAddress: str(env.EMAIL_FORWARD_ADDRESS) || null,
      imap: {
        host: str(env.IMAP_HOST),
        port: int(env.IMAP_PORT, 993, { min: 1, max: 65535 }),
        secure: bool(env.IMAP_SECURE, true),
        user: str(env.IMAP_USER),
        password: str(env.IMAP_PASSWORD),
        mailbox: str(env.IMAP_MAILBOX, 'INBOX'),
        pollSeconds: int(env.IMAP_POLL_SECONDS, 300, { min: 30, max: 86400 }),
        enabled: Boolean(str(env.IMAP_HOST) && str(env.IMAP_USER) && str(env.IMAP_PASSWORD)),
      },
    },
    alerts: {
      enabled: bool(env.ALERTS_ENABLED, true),
      thresholds: alertThresholds,
    },
    reports: {
      timezone,
      dailyAt,
      weeklyDay: int(env.WEEKLY_SUMMARY_DAY, 1, { min: 0, max: 6 }),
      weeklyAt,
      monthlyAt,
    },
    family: {
      members: parseFamilyMembers(env.FAMILY_MEMBERS),
    },
  };

  return Object.freeze(config);
}

/**
 * Devuelve errores bloqueantes y advertencias de configuracion.
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.telegram.enabled && !/^\d+:[A-Za-z0-9_-]{20,}$/.test(config.telegram.token)) {
    errors.push('TELEGRAM_BOT_TOKEN no tiene un formato valido (esperado "123456:ABC...").');
  }
  if (config.telegram.mode === 'webhook') {
    if (!config.telegram.publicUrl) errors.push('TELEGRAM_MODE=webhook requiere PUBLIC_URL.');
    if (!config.telegram.webhookSecret) {
      errors.push('TELEGRAM_MODE=webhook requiere TELEGRAM_WEBHOOK_SECRET (sin el, cualquiera podria enviar updates falsos).');
    }
    if (config.telegram.publicUrl && !config.telegram.publicUrl.startsWith('https://')) {
      errors.push('PUBLIC_URL debe ser HTTPS para webhooks de Telegram.');
    }
  }
  if (!config.telegram.enabled) warnings.push('TELEGRAM_BOT_TOKEN vacio: el bot de Telegram queda deshabilitado.');
  if (config.db.driver === 'supabase') {
    if (!config.db.supabase.url) errors.push('DB_DRIVER=supabase requiere SUPABASE_URL.');
    if (!config.db.supabase.key) errors.push('DB_DRIVER=supabase requiere SUPABASE_SERVICE_ROLE_KEY.');
  }
  if (!config.gemini.enabled) {
    warnings.push('GEMINI_API_KEY vacio: OCR de facturas y transcripcion de voz deshabilitados.');
  }
  if (!config.api.token) {
    warnings.push('API_TOKEN vacio: los endpoints /api/* quedan bloqueados (el bot sigue funcionando).');
  }
  if (!config.telegram.familyChatId) {
    warnings.push('FAMILY_CHAT_ID vacio: resumenes y alertas se enviaran al chat del autor del movimiento.');
  }
  if (config.family.members.length === 0) {
    warnings.push('FAMILY_MEMBERS vacio: cualquier usuario de Telegram podra registrar movimientos como "Familiar".');
  }
  const telegramIds = config.family.members.map((m) => m.telegramId).filter(Boolean);
  if (telegramIds.length !== new Set(telegramIds).size) {
    errors.push('FAMILY_MEMBERS contiene telegram_id duplicados.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/** Devuelve el nombre de la familia a mostrar. */
export function familyTitle(config) {
  const names = config.family.members.map((member) => member.name);
  if (names.length === 0) return config.app.name;
  if (names.length <= 2) return `Familia ${names.join(' & ')}`;
  return `Familia ${names[0]}`;
}
