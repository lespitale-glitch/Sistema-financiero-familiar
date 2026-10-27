/**
 * Vencimientos: parseo de /vence, servicio, recordatorio diario, comandos y
 * boton "Pagué".
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allReplyText,
  createFakeCtx,
  createFakeOcr,
  createHarness,
} from './helpers/bot-harness.js';
import {
  addDays,
  daysUntil,
  nextMonthlyDate,
  parseBillCallback,
  parseBillCommand,
} from '../src/services/bills.js';
import {
  handleBills,
  handleCallbackQuery,
  handleDocument,
  handleNewBill,
  handlePaid,
} from '../src/bot/handlers.js';
import { createScheduler } from '../src/services/scheduler.js';

const TODAY = '2026-10-15'; // FIXED_DATE del harness en Buenos Aires

async function setup(t, options) {
  const harness = await createHarness(options);
  t.after(async () => {
    await harness.close();
  });
  const ctx = createFakeCtx({ user: harness.user });
  return { harness, ctx };
}

test('fechas: addDays, daysUntil y nextMonthlyDate ajusta fin de mes', () => {
  assert.equal(addDays('2026-10-30', 3), '2026-11-02');
  assert.equal(daysUntil('2026-10-18', TODAY), 3);
  assert.equal(daysUntil('2026-10-13', TODAY), -2);
  assert.equal(nextMonthlyDate('2026-01-31'), '2026-02-28');
  assert.equal(nextMonthlyDate('2026-12-10'), '2027-01-10');
  assert.equal(nextMonthlyDate('2026-02-28', 31), '2026-03-31');
});

test('parseBillCommand entiende fecha, monto, nombre y #mensual', () => {
  const full = parseBillCommand('15/11 45.000 Luz Edesur', { todayKey: TODAY });
  assert.deepEqual(
    { name: full.name, amountCents: full.amountCents, dueDate: full.dueDate, recurrence: full.recurrence },
    { name: 'Luz Edesur', amountCents: 4_500_000, dueDate: '2026-11-15', recurrence: null },
  );

  const monthly = parseBillCommand('10 350000 Alquiler #mensual', { todayKey: TODAY });
  assert.equal(monthly.dueDate, '2026-11-10'); // el 10 de octubre ya paso
  assert.equal(monthly.recurrence, 'monthly');
  assert.equal(monthly.name, 'Alquiler');

  const noAmount = parseBillCommand('2026-12-01 Patente', { todayKey: TODAY });
  assert.equal(noAmount.amountCents, null);
  assert.equal(noAmount.dueDate, '2026-12-01');

  const nextYear = parseBillCommand('05/01 Seguro', { todayKey: TODAY });
  assert.equal(nextYear.dueDate, '2027-01-05');

  assert.equal(parseBillCommand('', { todayKey: TODAY }).ok, false);
  assert.equal(parseBillCommand('mañana luz', { todayKey: TODAY }).reason, 'fecha-invalida');
  assert.equal(parseBillCommand('15/11 45000', { todayKey: TODAY }).reason, 'sin-nombre');
});

test('parseBillCallback solo acepta bill:paid:<id>', () => {
  assert.deepEqual(parseBillCallback('bill:paid:abc'), { action: 'paid', billId: 'abc' });
  assert.equal(parseBillCallback('doc:confirm:abc'), null);
  assert.equal(parseBillCallback('bill:paid:'), null);
});

test('recordatorio: vencidos + dias configurados (3,1,0), sin los lejanos', async (t) => {
  const { harness } = await setup(t);
  const bills = harness.services.bills;
  await bills.add({ name: 'Gas', amountCents: 1_200_000, dueDate: '2026-10-13' }); // vencido
  await bills.add({ name: 'Luz', amountCents: 4_500_000, dueDate: TODAY }); // hoy
  await bills.add({ name: 'Internet', amountCents: 2_000_000, dueDate: '2026-10-18' }); // en 3 dias
  await bills.add({ name: 'Agua', amountCents: 900_000, dueDate: '2026-10-17' }); // en 2 dias: no toca
  await bills.add({ name: 'Patente', dueDate: '2026-11-30' }); // lejos

  const reminder = await bills.buildReminder();
  assert.equal(reminder.count, 3);
  assert.deepEqual(reminder.bills.map((bill) => bill.name), ['Gas', 'Luz', 'Internet']);
  assert.match(reminder.html, /Vencidos/);
  assert.match(reminder.html, /Vencen hoy/);
  assert.match(reminder.html, /en 3 días/);
  assert.doesNotMatch(reminder.html, /Agua|Patente/);
  assert.equal(reminder.keyboard.inline_keyboard.length, 3);
  assert.match(reminder.keyboard.inline_keyboard[0][0].callback_data, /^bill:paid:/);
});

test('pagar un vencimiento mensual agenda el del mes siguiente', async (t) => {
  const { harness } = await setup(t);
  const bills = harness.services.bills;
  const rent = await bills.add({ name: 'Alquiler', amountCents: 35_000_000, dueDate: '2026-10-10', recurrence: 'monthly' });

  const result = await bills.markPaid(rent.id);
  assert.equal(result.ok, true);
  assert.equal(result.bill.status, 'paid');
  assert.ok(result.bill.paidAt);
  assert.equal(result.next.dueDate, '2026-11-10');
  assert.equal(result.next.recurrence, 'monthly');

  const again = await bills.markPaid(rent.id);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'already-closed');
});

test('una factura con vencimiento se agenda una sola vez y se cancela al descartarla', async (t) => {
  const { harness } = await setup(t);
  const document = await harness.repos.documents.create({
    vendor: 'Edesur',
    totalCents: 4_532_050,
    dueDate: '2026-11-10',
    status: 'pending',
  });
  const first = await harness.services.bills.trackDocument(document);
  const second = await harness.services.bills.trackDocument(document);
  assert.equal(first.id, second.id);
  assert.equal(first.name, 'Edesur');
  assert.equal(first.amountCents, 4_532_050);

  await harness.services.bills.cancelForDocument(document.id);
  const pending = await harness.repos.bills.list({ status: 'pending' });
  assert.equal(pending.length, 0);
});

test('/vence agenda y /vencimientos lista con botones', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.payload = '20/10 45000 Luz Edesur';
  await handleNewBill(ctx, harness.deps);
  assert.match(allReplyText(ctx), /Vencimiento agendado/);
  assert.match(allReplyText(ctx), /20\/10\/2026/);

  const [bill] = await harness.repos.bills.list({ status: 'pending' });
  const category = await harness.repos.categories.get(bill.categoryId);
  assert.equal(category.name, 'Servicios');

  const listCtx = createFakeCtx({ user: harness.user });
  await handleBills(listCtx, harness.deps);
  const reply = listCtx.captured.find((entry) => entry.kind === 'reply');
  assert.match(reply.html, /1\.<\/b> Luz Edesur/);
  assert.match(reply.html, /en 5 días/);
  assert.ok(reply.extra.reply_markup.inline_keyboard.length >= 1);
});

test('/vence sin datos muestra la ayuda', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.payload = '';
  await handleNewBill(ctx, harness.deps);
  assert.match(allReplyText(ctx), /Formato/);
});

test('/pagado <n> y el boton Pagué cierran vencimientos', async (t) => {
  const { harness, ctx } = await setup(t);
  await harness.services.bills.add({ name: 'Luz', amountCents: 4_500_000, dueDate: '2026-10-20' });
  const gas = await harness.services.bills.add({ name: 'Gas', amountCents: 1_200_000, dueDate: '2026-10-25' });

  ctx.payload = '1';
  await handlePaid(ctx, harness.deps);
  assert.match(allReplyText(ctx), /Pagado:<\/b> Luz/);

  const buttonCtx = createFakeCtx({ user: harness.user });
  buttonCtx.callbackQuery = { data: `bill:paid:${gas.id}` };
  await handleCallbackQuery(buttonCtx, harness.deps);
  assert.ok(buttonCtx.captured.some((entry) => entry.kind === 'answer' && /pagado/i.test(entry.data)));

  const pending = await harness.repos.bills.list({ status: 'pending' });
  assert.equal(pending.length, 0);

  const missing = createFakeCtx({ user: harness.user });
  missing.payload = '9';
  await handlePaid(missing, harness.deps);
  assert.match(allReplyText(missing), /No encontré/);
});

test('subir una factura con vencimiento la agenda y lo avisa', async (t) => {
  const ocr = createFakeOcr({
    async extractDocument() {
      return {
        ok: true,
        vendor: 'Metrogas',
        amountCents: 1_248_035,
        currency: 'ARS',
        dueDate: '2026-11-05',
        categoryName: 'Servicios',
        type: 'fixed_expense',
        confidence: 0.9,
        warnings: [],
      };
    },
  });
  const { harness } = await setup(t, { ocr });
  const ctx = createFakeCtx({
    user: harness.user,
    message: { photo: [{ file_id: 'foto-1', file_size: 1000 }] },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(Buffer.from('imagen'));
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  await handleDocument(ctx, harness.deps);

  const [bill] = await harness.repos.bills.list({ status: 'pending' });
  assert.equal(bill.name, 'Metrogas');
  assert.equal(bill.dueDate, '2026-11-05');
  assert.ok(bill.documentId);
  assert.match(allReplyText(ctx), /Te recuerdo el vencimiento del <b>05\/11\/2026/);
});

test('el scheduler manda el recordatorio de vencimientos una vez por dia', async (t) => {
  const { harness } = await setup(t);
  await harness.services.bills.add({ name: 'Luz', amountCents: 4_500_000, dueDate: TODAY });
  const scheduler = createScheduler({
    config: harness.config,
    repos: harness.repos,
    services: harness.services,
    notifier: harness.notifier,
    clock: () => new Date('2026-10-15T12:30:00.000Z'),
  });

  // 09:30 en Buenos Aires: ya paso DUE_REMINDER_AT (09:00).
  const first = await scheduler.tick(new Date('2026-10-15T12:30:00.000Z'));
  const job = first.ran.find((entry) => entry.job === 'dueReminders');
  assert.ok(job, 'deberia correr el job de vencimientos');
  assert.equal(job.sent, true);
  const message = harness.sent.find((entry) => /Recordatorio de vencimientos/.test(entry.html));
  assert.ok(message);
  assert.ok(message.extra.reply_markup.inline_keyboard.length === 1);

  const second = await scheduler.tick(new Date('2026-10-15T13:30:00.000Z'));
  assert.ok(second.skipped.some((entry) => entry.job === 'dueReminders' && entry.reason === 'ya-ejecutado'));
});
