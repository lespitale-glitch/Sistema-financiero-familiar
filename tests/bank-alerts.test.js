/**
 * Avisos del Banco Macro por email: parser y registro automatico.
 */
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
import { cleanMerchant, isBankSender, parseBankAlert } from '../src/services/bank-alerts.js';

const silentLogger = createLogger({ level: 'silent' });
const NOW = new Date('2026-10-21T15:00:00.000Z');
const TZ = 'America/Argentina/Buenos_Aires';

const DEBITO = {
  subject: 'Aviso de compra con Tarjeta de Débito VISA',
  text: `Estimado Cliente:
Queremos informarte que ingresó una autorización de compra de $ 29.500,00 en el establecimiento
MERPAGO*PANADERIAEJEMPLO el día 13/10/2026 a las 19:42hs, con la Tarjeta de Débito VISA de JUAN P
EJEMPLO finalizada en 9876.
Si no lo reconocés o tenés alguna consulta, podés comunicarte con el Centro de Atención Telefónica al 0810-666-1221`,
};

const TRANSFERENCIA_PROPIA = {
  subject: '¡Tu transferencia fue exitosa!',
  text: `Hola Ejemplo Juan Pablo
Enviamos tu transferencia de $100.000,00 a tu cuenta de Bco. Nacion Argentina a través de App Macro.
Si vos no hiciste esta transacción o tenés alguna duda, por favor, comunicate a nuestro Centro de Atención Telefónica: 0810-555-7353.`,
};

test('parser: compra con débito (monto, comercio, fecha y hora local)', () => {
  const alert = parseBankAlert({ ...DEBITO, timezone: TZ, now: NOW });
  assert.equal(alert.kind, 'card');
  assert.equal(alert.cardType, 'debito');
  assert.equal(alert.amountCents, 2_950_000);
  assert.equal(alert.currency, 'ARS');
  assert.equal(alert.merchant, 'Panaderiaejemplo');
  assert.equal(alert.viaMercadoPago, true);
  assert.equal(alert.occurredAt, '2026-10-13T22:42:00.000Z'); // 19:42 en Buenos Aires
  assert.equal(alert.ownTransfer, false);
  assert.ok(!JSON.stringify(alert).includes('9876'), 'no guarda la tarjeta');
});

test('parser: transferencia a cuenta propia y a terceros', () => {
  const own = parseBankAlert({ ...TRANSFERENCIA_PROPIA, now: NOW });
  assert.equal(own.kind, 'transfer');
  assert.equal(own.ownTransfer, true);
  assert.equal(own.destination, 'Bco. Nacion Argentina');
  assert.equal(own.amountCents, 10_000_000);

  const other = parseBankAlert({ text: 'Enviamos tu transferencia de $ 35.000,00 a Juan Perez a través de App Macro.', now: NOW });
  assert.equal(other.ownTransfer, false);
  assert.equal(other.merchant, 'Transferencia a Juan Perez');
});

test('parser: crédito en dólares y textos que no son avisos', () => {
  const usd = parseBankAlert({
    text: 'ingresó una autorización de compra de U$S 15,49 en el establecimiento NETFLIX.COM el día 01/11/2026 a las 08:05hs, con la Tarjeta de Crédito VISA',
    timezone: TZ,
  });
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.cardType, 'credito');
  assert.equal(usd.amountCents, 1_549);
  assert.equal(parseBankAlert({ subject: 'Promociones de octubre', text: 'Aprovechá 30% en supermercados' }), null);
});

test('isBankSender y cleanMerchant', () => {
  assert.equal(isBankSender('avisos@macro.com.ar', ['macro.com.ar']), true);
  assert.equal(isBankSender('noreply@mail.macro.com.ar', ['macro.com.ar']), true);
  assert.equal(isBankSender('macro.com.ar@estafa.com', ['macro.com.ar']), false);
  assert.equal(isBankSender('ana@example.com', ['macro.com.ar']), false);
  assert.deepEqual(cleanMerchant('COTO*SUC 45'), { name: 'Coto Suc 45', viaMercadoPago: false });
});

function tempDbPath() {
  return path.join(os.tmpdir(), `finanzas-banco-${process.pid}-${randomUUID()}.sqlite`);
}

async function setup(t, env = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    SQLITE_PATH: tempDbPath(),
    FAMILY_MEMBERS: 'Juan|husband|119|juan@example.com;Ana|wife|222|ana@example.com',
    FAMILY_CHAT_ID: '999',
    TZ,
    CURRENCY: 'ARS',
    ALERTS_ENABLED: 'false',
    ...env,
  });
  const repos = await createDatabase(config, { logger: silentLogger });
  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
  const users = createUsersService({ repos, config, logger: silentLogger });
  await users.syncFamilyMembers();
  const messages = [];
  const notifier = { async sendMessage(chatId, html, extra = {}) { messages.push({ chatId, html, extra }); return { ok: true }; } };
  const clock = () => NOW;
  const alerts = createAlertsService({ repos, config, notifier, logger: silentLogger, clock });
  const transactions = createTransactionsService({ repos, config, alerts, logger: silentLogger, clock });
  const email = createEmailService({ config, repos, services: { users, transactions, alerts }, logger: silentLogger, notifier, clock });
  t.after(async () => {
    const filePath = repos.store.filePath;
    await repos.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${filePath}${suffix}`, { force: true });
  });
  return { repos, email, messages };
}

test('email del Macro: la compra con débito se registra sola con botón Borrar', async (t) => {
  const { repos, email, messages } = await setup(t);
  const result = await email.ingestEmail({ from: 'Banco Macro <avisos@macro.com.ar>', messageId: 'deb-1', ...DEBITO });
  assert.equal(result.status, 'logged');

  const [transaction] = await repos.transactions.list({ limit: 5 });
  assert.equal(transaction.amountCents, 2_950_000);
  assert.equal(transaction.source, 'email');
  assert.equal(transaction.occurredAt, '2026-10-13T22:42:00.000Z');
  assert.match(transaction.note, /Panaderiaejemplo \(débito, Mercado Pago\)/);
  const juan = await repos.users.getByTelegramId('119');
  assert.equal(transaction.userId, juan.id, 'por defecto se asigna al primer familiar');

  assert.equal(messages.length, 1);
  assert.match(messages[0].html, /desde el banco/);
  assert.match(messages[0].extra.reply_markup.inline_keyboard[0][0].callback_data, /^tx:del:/);

  // El mismo email no se registra dos veces.
  const again = await email.ingestEmail({ from: 'avisos@macro.com.ar', messageId: 'deb-1', ...DEBITO });
  assert.equal(again.status, 'duplicate');
});

test('email del Macro: transferencia entre cuentas propias no cuenta como gasto', async (t) => {
  const { repos, email, messages } = await setup(t);
  const result = await email.ingestEmail({ from: 'avisos@macro.com.ar', messageId: 'tr-1', ...TRANSFERENCIA_PROPIA });
  assert.equal(result.status, 'ignored');
  assert.equal((await repos.transactions.list({ limit: 5 })).length, 0);
  assert.match(messages[0].html, /entre cuentas propias/);
});

test('email del Macro: BANK_ALERT_OWNER asigna al familiar elegido y formato desconocido avisa', async (t) => {
  const { repos, email, messages } = await setup(t, { BANK_ALERT_OWNER: 'Ana' });
  await email.ingestEmail({ from: 'avisos@macro.com.ar', messageId: 'deb-2', ...DEBITO });
  const [transaction] = await repos.transactions.list({ limit: 5 });
  const ana = await repos.users.getByTelegramId('222');
  assert.equal(transaction.userId, ana.id);

  const unknown = await email.ingestEmail({ from: 'avisos@macro.com.ar', messageId: 'x-1', subject: 'Resumen de cuenta', text: 'Tu resumen ya está disponible' });
  assert.equal(unknown.status, 'unparsed');
  assert.match(messages.at(-1).html, /todavía no sé leer/);
});

test('un remitente que no es el banco no puede inyectar avisos', async (t) => {
  const { repos, email } = await setup(t);
  const result = await email.ingestEmail({ from: 'macro.com.ar@estafa.com', messageId: 'fake-1', ...DEBITO });
  assert.equal(result.status, 'rejected');
  assert.equal((await repos.transactions.list({ limit: 5 })).length, 0);
});

test('un familiar puede reenviar el aviso a mano', async (t) => {
  const { repos, email } = await setup(t);
  const result = await email.ingestEmail({
    from: 'ana@example.com',
    messageId: 'fwd-1',
    subject: 'Fwd: Aviso de compra con Tarjeta de Débito VISA',
    text: `---------- Forwarded message ---------\nDe: Banco Macro <avisos@macro.com.ar>\n${DEBITO.text}`,
  });
  assert.equal(result.status, 'logged');
  const [transaction] = await repos.transactions.list({ limit: 5 });
  const ana = await repos.users.getByTelegramId('222');
  assert.equal(transaction.userId, ana.id);
});
