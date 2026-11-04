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
import { createBillsService } from '../src/services/bills.js';
import { cleanMerchant, isBankSender, parseBankAlert, parseCardStatement } from '../src/services/bank-alerts.js';

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
  // Solo los últimos 4 dígitos (para separar tarjetas), nunca el titular.
  assert.equal(alert.cardBrand, 'Visa');
  assert.equal(alert.cardLast4, '9876');
  assert.ok(!/JUAN|EJEMPLO/.test(JSON.stringify(alert)), 'no guarda el titular');
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
  const bills = createBillsService({ repos, config, logger: silentLogger, clock });
  const email = createEmailService({ config, repos, services: { users, transactions, alerts, bills }, logger: silentLogger, notifier, clock });
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

const RESUMEN = {
  subject: 'E-Resumen de Tarjeta Visa',
  text: `Tu E-RESUMEN ya está disponible
Estimado/a
EJEMPLO JUAN P
Ya podés consultar el Resumen de tu Tarjeta
Accedé a tu Resumen
Vencimiento: 11-Nov-26
Saldo en Pesos: $250000,00
Saldo en Dólares: $12,50
Pago mínimo en pesos: $30.000,00`,
};

test('parser: e-resumen de tarjeta (vencimiento, saldos y marca)', () => {
  const statement = parseCardStatement(RESUMEN);
  assert.equal(statement.dueDate, '2026-11-11');
  assert.equal(statement.pesosCents, 25_000_000);
  assert.equal(statement.dollarsCents, 1_250);
  assert.equal(statement.minimumCents, 3_000_000);
  assert.equal(statement.name, 'Tarjeta Visa Macro');
  const master = parseCardStatement({ ...RESUMEN, subject: 'E-Resumen de Tarjeta Mastercard', text: RESUMEN.text.replace('11-Nov-26', '05-Dic-26') });
  assert.equal(master.name, 'Tarjeta Mastercard Macro');
  assert.equal(master.dueDate, '2026-12-05');
  assert.equal(parseCardStatement(DEBITO), null);
});

test('email del Macro: el e-resumen se agenda como vencimiento y no como gasto', async (t) => {
  const { repos, email, messages } = await setup(t);
  const result = await email.ingestEmail({ from: 'avisos@macro.com.ar', messageId: 'res-1', ...RESUMEN });
  assert.equal(result.status, 'scheduled');
  assert.equal((await repos.transactions.list({ limit: 5 })).length, 0);
  const bills = await repos.bills.list();
  assert.deepEqual(bills.map((bill) => [bill.name, bill.amountCents, bill.currency, bill.dueDate]), [
    ['Tarjeta Visa Macro', 25_000_000, 'ARS', '2026-11-11'],
    ['Tarjeta Visa Macro (dólares)', 1_250, 'USD', '2026-11-11'],
  ]);
  assert.match(messages.at(-1).html, /Vence el <b>11\/11<\/b>/);
  assert.match(messages.at(-1).html, /No lo cuento como gasto/);

  // Si el mismo resumen llega reenviado (otro messageId), no se duplica.
  const again = await email.ingestEmail({ from: 'avisos@macro.com.ar', messageId: 'res-2', ...RESUMEN });
  assert.equal(again.status, 'ignored');
  assert.equal((await repos.bills.list()).length, 2);
});

test('email del Macro: si el texto plano no trae el aviso, se lee del HTML', async (t) => {
  const { repos, email } = await setup(t);
  const html = `<table><tr><td><p>Estimado Cliente:</p><p>Queremos informarte que ingresó una autorización de compra de <b>$&nbsp;95.999,00</b> en el establecimiento <b>MERPAGO*TIENDAEJEMPLO</b> el día <b>02/11/2026</b> a las <b>19:31hs</b>, con la <b>Tarjeta de Crédito VISA</b> de <b>JUAN EJEMPLO</b> finalizada en <b>1111</b>.</p></td></tr></table>`;
  const result = await email.ingestEmail({
    from: 'info@notificaciones.bancomacro.com.ar',
    messageId: 'html-1',
    subject: 'Aviso de compra con Tarjeta de Crédito VISA',
    text: 'Para ver este mensaje correctamente, habilitá la vista HTML.',
    html,
  });
  assert.equal(result.status, 'logged');
  const [transaction] = await repos.transactions.list({ limit: 1 });
  assert.equal(transaction.amountCents, 9_599_900);
  assert.match(transaction.note, /Tiendaejemplo \(crédito, Mercado Pago\)/);
});

test('parser: aviso con entidades HTML sin decodificar (autorizaci&oacute;n, d&iacute;a)', () => {
  const alert = parseBankAlert({
    subject: 'Aviso de compra con Tarjeta de Crédito VISA',
    text: ':: MACRO :: Estimado Cliente: Queremos informarte que ingres&oacute; una autorizaci&oacute;n de compra de $ 95.999,00 en el establecimiento MERPAGO*TIENDAEJEMPLO el d&iacute;a 02/11/2026 a las 19:31hs , con la Tarjeta de Crédito VISA de JUAN EJEMPLO finalizada en 1111 . Si no lo reconoc&eacute;s...',
    timezone: TZ,
    now: NOW,
  });
  assert.equal(alert.amountCents, 9_599_900);
  assert.equal(alert.merchant, 'Tiendaejemplo');
  assert.equal(alert.cardType, 'credito');
  assert.equal(alert.occurredAt, '2026-11-02T22:31:00.000Z');
});
