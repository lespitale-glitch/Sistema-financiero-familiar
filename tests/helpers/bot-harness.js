/**
 * Harness de pruebas para el bot: base SQLite en memoria, servicios reales y
 * un contexto de Telegram falso que captura las respuestas.
 */

import { loadConfig } from '../../src/config.js';
import { createDatabase } from '../../src/db/index.js';
import { DEFAULT_CATEGORIES } from '../../src/domain.js';
import { createAlertsService } from '../../src/services/alerts.js';
import { createTransactionsService } from '../../src/services/transactions.js';
import { createUsersService } from '../../src/services/users.js';
import { createBillsService } from '../../src/services/bills.js';
import { createFxService } from '../../src/services/fx.js';

/** Fecha fija: 15/10/2026 09:00 en America/Argentina/Buenos_Aires. */
export const FIXED_DATE = new Date('2026-10-15T12:00:00.000Z');
export const FIXED_MONTH = '2026-10';

/** Logger que no imprime nada. */
export const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};

export const TEST_ENV = Object.freeze({
  NODE_ENV: 'test',
  FAMILY_MEMBERS: 'Ana|wife|111|ana@test.com;Leo|husband|222|leo@test.com',
  FAMILY_CHAT_ID: '-100',
  CURRENCY: 'ARS',
  TZ: 'America/Argentina/Buenos_Aires',
  SQLITE_PATH: ':memory:',
  GEMINI_API_KEY: '',
  ALERTS_ENABLED: 'true',
});

/** OCR falso con respuestas configurables. */
export function createFakeOcr(overrides = {}) {
  return {
    enabled: true,
    async extractDocument() {
      return {
        ok: true,
        amountCents: 1_250_000,
        vendor: 'Edenor',
        description: 'Factura de luz',
        dueDate: '2026-10-30',
        issuedDate: '2026-10-01',
        categoryName: 'Servicios',
        type: 'fixed_expense',
        confidence: 0.92,
        lineItems: [],
        warnings: [],
      };
    },
    async transcribeAudio() {
      return { ok: true, text: 'Gasté 15000 en el super' };
    },
    ...overrides,
  };
}

/**
 * Crea una base limpia + servicios + deps para un test.
 * @param {{ocr?: object, env?: object}} [options]
 */
export async function createHarness({ ocr, env = {} } = {}) {
  const config = loadConfig({ ...TEST_ENV, ...env }, { loadEnvFile: false });
  const repos = await createDatabase(config, { logger: silentLogger, clock: () => FIXED_DATE });

  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);

  const users = createUsersService({ repos, config, logger: silentLogger });
  await users.syncFamilyMembers();

  const sent = [];
  const notifier = {
    available: true,
    async sendMessage(chatId, html, extra = {}) {
      sent.push({ chatId: String(chatId), html, extra, kind: 'message' });
      return { ok: true, messageId: sent.length };
    },
    async sendDocument(chatId, document, extra = {}) {
      sent.push({ chatId: String(chatId), document, extra, kind: 'document' });
      return { ok: true, messageId: sent.length };
    },
  };

  const clock = () => FIXED_DATE;
  const alerts = createAlertsService({ repos, config, notifier, logger: silentLogger, clock });
  // Sin red en tests: la cotizacion sale de USD_ARS_RATE o falla.
  const fx = createFxService({
    config,
    logger: silentLogger,
    clock,
    fetchImpl: async () => { throw new Error('sin red en tests'); },
  });
  const transactions = createTransactionsService({ repos, config, alerts, fx, logger: silentLogger, clock });
  const bills = createBillsService({ repos, config, logger: silentLogger, clock });

  const services = {
    users,
    transactions,
    alerts,
    fx,
    bills,
    ocr: ocr || createFakeOcr(),
  };

  const deps = { config, repos, services, logger: silentLogger, notifier, clock };
  const user = await repos.users.getByTelegramId('111');

  return {
    config,
    repos,
    services,
    deps,
    notifier,
    sent,
    user,
    async close() {
      await repos.close();
    },
  };
}

/**
 * Contexto de Telegram falso. Guarda todo lo respondido en `captured`.
 */
export function createFakeCtx({
  user = null,
  text,
  payload,
  chatType = 'private',
  chatId,
  from,
  message,
} = {}) {
  const captured = [];
  const ctx = {
    updateType: 'message',
    from: from || { id: 111, first_name: 'Ana', username: 'ana' },
    chat: {
      id: chatId ?? (chatType === 'private' ? 111 : -100),
      type: chatType,
    },
    message: message || (text === undefined ? undefined : { text }),
    state: { user },
    captured,
    async reply(html, extra = {}) {
      captured.push({ kind: 'reply', html, extra });
      return { message_id: captured.length };
    },
    async replyWithDocument(document, extra = {}) {
      captured.push({ kind: 'document', document, extra });
      return { message_id: captured.length };
    },
    telegram: {
      async getFileLink() {
        return { href: 'https://fake.local/file' };
      },
    },
    async answerCbQuery(data, extra = {}) {
      captured.push({ kind: 'answer', data, extra });
      return true;
    },
    async editMessageText(html, extra = {}) {
      captured.push({ kind: 'edit', html, extra });
      return true;
    },
  };
  if (payload !== undefined) ctx.payload = payload;
  return ctx;
}

/** Ultima respuesta de texto capturada. */
export function lastReply(ctx) {
  const replies = ctx.captured.filter((entry) => entry.kind === 'reply');
  return replies[replies.length - 1] || null;
}

/** Todo el HTML respondido, concatenado (util para asserts). */
export function allReplyText(ctx) {
  return ctx.captured
    .filter((entry) => entry.kind === 'reply' || entry.kind === 'edit')
    .map((entry) => entry.html || '')
    .join('\n');
}

/** Crea un documento pendiente de prueba. */
export async function createPendingDocument(harness, overrides = {}) {
  const category = overrides.categoryId === undefined
    ? await harness.repos.categories.getByName('Servicios')
    : null;
  const base = {
    userId: harness.user.id,
    telegramFileId: 'file-1',
    fileName: 'factura.jpg',
    mimeType: 'image/jpeg',
    vendor: 'Edenor',
    totalCents: 5_000_000,
    currency: 'ARS',
    dueDate: '2026-10-30',
    categoryId: category?.id ?? null,
    extracted: {
      ok: true,
      categoryName: 'Servicios',
      type: 'fixed_expense',
      description: 'Factura de luz',
    },
    status: 'pending',
    source: 'telegram',
  };
  return harness.repos.documents.create({
    ...base,
    ...overrides,
    categoryId: overrides.categoryId ?? base.categoryId,
    extracted: { ...base.extracted, ...(overrides.extracted || {}) },
  });
}
