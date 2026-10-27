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
import { createAlertsService } from '../src/services/alerts.js';
import { createEmailService } from '../src/services/email.js';
import { createTransactionsService } from '../src/services/transactions.js';
import { createUsersService } from '../src/services/users.js';

const silentLogger = createLogger({ level: 'silent' });
const FIXED_NOW = new Date('2026-10-15T15:00:00.000Z');
const clock = () => new Date(FIXED_NOW.getTime());

function tempDbPath() {
  return path.join(os.tmpdir(), `finanzas-email-${process.pid}-${randomUUID()}.sqlite`);
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
    API_TOKEN: 'api-test',
    FAMILY_MEMBERS: 'Ana|wife|111|ana@example.com',
    FAMILY_CHAT_ID: '999',
    TZ: 'UTC',
    CURRENCY: 'ARS',
    LOCALE: 'es-AR',
    ALERTS_ENABLED: 'false',
    MAX_UPLOAD_BYTES: '1048576',
    ...overrides,
  });
}

function createFakeNotifier() {
  const messages = [];
  return {
    available: true,
    messages,
    async sendMessage(chatId, html, extra = {}) {
      messages.push({ chatId, html, extra });
      return { ok: true, messageId: messages.length };
    },
  };
}

async function setup({ ocr = null, env = {} } = {}) {
  const config = makeConfig(env);
  const repos = await createDatabase(config, { logger: silentLogger });
  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
  const users = createUsersService({ repos, config, logger: silentLogger });
  await users.syncFamilyMembers();
  const notifier = createFakeNotifier();
  const alerts = createAlertsService({ repos, config, notifier, logger: silentLogger, clock });
  const transactions = createTransactionsService({ repos, config, alerts, logger: silentLogger, clock });
  const email = createEmailService({
    config,
    repos,
    services: { users, transactions, alerts, ocr },
    logger: silentLogger,
    notifier,
    clock,
  });
  return { config, repos, notifier, users, alerts, transactions, email };
}

function cleanup(t, ctx) {
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    await ctx.repos.close();
    removeDb(filePath);
  });
}

function pngAttachment(overrides = {}) {
  return {
    filename: 'factura.png',
    contentType: 'image/png',
    size: 12,
    contentBase64: Buffer.from('fake-image-bytes').toString('base64'),
    ...overrides,
  };
}

test('email de remitente desconocido se rechaza con 403 y queda registrado', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-desconocido',
    from: 'Desconocido <otro@example.com>',
    subject: 'Hola',
    text: 'Gasté 1000',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rejected');
  assert.equal(result.httpStatus, 403);
  assert.match(result.message, /no está registrado/);

  const log = await ctx.repos.emailLog.get('msg-desconocido');
  assert.equal(log.status, 'rejected');
  assert.equal(log.error, 'remitente-no-registrado');
  const transactions = await ctx.repos.transactions.list();
  assert.equal(transactions.length, 0);
});

test('email duplicado no se procesa dos veces', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const payload = {
    messageId: 'msg-duplicado',
    from: 'Ana <ana@example.com>',
    subject: 'Supermercado',
    text: 'Gasté $15.000 ayer',
  };
  const first = await ctx.email.ingestEmail(payload);
  assert.equal(first.ok, true);
  assert.equal(first.status, 'logged');

  const second = await ctx.email.ingestEmail(payload);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.status, 'duplicate');
  assert.equal(second.httpStatus, 200);

  const transactions = await ctx.repos.transactions.list();
  assert.equal(transactions.length, 1);
});

test('factura con OCR crea documento pendiente, notifica y registra el email', async (t) => {
  const calls = [];
  const ocr = {
    enabled: true,
    async extractDocument(input) {
      calls.push(input);
      return {
        ok: true,
        amountCents: 1250000,
        vendor: 'Edenor',
        description: 'Servicio de luz',
        dueDate: '2026-10-30',
        issuedDate: '2026-10-01',
        categoryName: 'Servicios',
        type: 'fixed_expense',
        confidence: 0.92,
        lineItems: [],
        warnings: [],
      };
    },
  };
  const ctx = await setup({ ocr });
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-factura',
    from: 'ana@example.com',
    subject: 'Factura de luz',
    text: 'Adjunto la factura.',
    attachments: [pngAttachment()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'pending_confirmation');
  assert.ok(result.documentId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mimeType, 'image/png');
  assert.ok(Buffer.isBuffer(calls[0].buffer));

  const documents = await ctx.repos.documents.list();
  assert.equal(documents.length, 1);
  assert.equal(documents[0].status, 'pending');
  assert.equal(documents[0].vendor, 'Edenor');
  assert.equal(documents[0].totalCents, 1250000);
  assert.equal(documents[0].source, 'email');

  assert.equal(ctx.notifier.messages.length, 1);
  const message = ctx.notifier.messages[0];
  assert.equal(message.chatId, '999');
  assert.ok(message.html.length > 0);
  assert.ok(Array.isArray(message.extra.reply_markup.inline_keyboard));

  const log = await ctx.repos.emailLog.get('msg-factura');
  assert.equal(log.status, 'pending_confirmation');
  assert.equal(log.document_id, documents[0].id);
});

test('si el OCR no encuentra monto, cae al texto y registra el movimiento', async (t) => {
  const ocr = {
    enabled: true,
    async extractDocument() {
      return {
        ok: true,
        amountCents: null,
        vendor: 'Proveedor',
        categoryName: null,
        type: 'variable_expense',
        confidence: 0.4,
        lineItems: [],
        warnings: ['No se pudo interpretar el monto total del comprobante.'],
      };
    },
  };
  const ctx = await setup({ ocr });
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-sin-monto-ocr',
    from: 'ana@example.com',
    subject: 'Factura',
    text: 'Total a pagar: $8.000',
    attachments: [pngAttachment()],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'logged');
  const documents = await ctx.repos.documents.list();
  assert.equal(documents.length, 0);
  const transaction = await ctx.repos.transactions.get(result.transactionId);
  assert.equal(transaction.amountCents, 800000);
});

test('email solo texto registra el movimiento con categoria y fecha', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-texto',
    from: 'Ana <ana@example.com>',
    subject: 'Supermercado',
    text: 'Gasté $15.000 ayer',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'logged');
  const transaction = await ctx.repos.transactions.get(result.transactionId);
  assert.equal(transaction.amountCents, 1500000);
  assert.equal(transaction.source, 'email');
  assert.equal(transaction.type, 'variable_expense');
  const category = await ctx.repos.categories.get(transaction.categoryId);
  assert.equal(category.name, 'Supermercado');
  assert.ok(transaction.occurredAt.startsWith('2026-10-14'));

  assert.equal(ctx.notifier.messages.length, 1);
  assert.equal(ctx.notifier.messages[0].chatId, '999');
});

test('email sin monto responde 422 y marca unparsed', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-sin-monto',
    from: 'ana@example.com',
    subject: 'Consulta',
    text: 'Hola, adjunto la factura. Gracias.',
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unparsed');
  assert.equal(result.httpStatus, 422);
  const log = await ctx.repos.emailLog.get('msg-sin-monto');
  assert.equal(log.status, 'unparsed');
  assert.equal(log.error, 'sin-monto');
});

test('un adjunto base64 invalido no rompe la ingesta y sigue con el texto', async (t) => {
  const ocr = {
    enabled: true,
    async extractDocument() {
      throw new Error('el OCR no debería ejecutarse con un adjunto inválido');
    },
  };
  const ctx = await setup({ ocr });
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-base64-roto',
    from: 'ana@example.com',
    subject: 'Cena',
    text: 'Gasté 5000 en pizza',
    attachments: [pngAttachment({ contentBase64: 'data:image/png;base64,%%%no-es-base64%%%' })],
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'logged');
  const transaction = await ctx.repos.transactions.get(result.transactionId);
  assert.equal(transaction.amountCents, 500000);
});

test('deriva un messageId determinista cuando falta el original', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const payload = {
    from: 'ana@example.com',
    subject: 'Transporte',
    text: 'Gasté 2000 en nafta',
  };
  const first = await ctx.email.ingestEmail(payload);
  assert.equal(first.ok, true);

  const rows = await ctx.repos.store.findMany('email_log', {}, { orderBy: 'processed_at', ascending: true });
  assert.equal(rows.length, 1);
  assert.match(rows[0].message_id, /^[0-9a-f]{64}$/);

  const second = await ctx.email.ingestEmail(payload);
  assert.equal(second.duplicate, true);
  const after = await ctx.repos.store.findMany('email_log', {}, { orderBy: 'processed_at', ascending: true });
  assert.equal(after.length, 1);
});

test('email solo HTML se convierte a texto antes de parsear', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.email.ingestEmail({
    messageId: 'msg-html',
    from: 'ana@example.com',
    subject: 'Salida',
    html: '<p>Gasté <b>$5.000</b> en pizza</p>',
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'logged');
  const transaction = await ctx.repos.transactions.get(result.transactionId);
  assert.equal(transaction.amountCents, 500000);
  const category = await ctx.repos.categories.get(transaction.categoryId);
  assert.equal(category.name, 'Comida');
});
