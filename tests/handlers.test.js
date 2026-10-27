/**
 * Pruebas de integracion de los handlers del bot con base SQLite en memoria.
 * Ejecutar: node --test tests/handlers.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIXED_MONTH,
  allReplyText,
  createFakeCtx,
  createHarness,
  createPendingDocument,
  lastReply,
} from './helpers/bot-harness.js';
import {
  handleBalance,
  handleBudget,
  handleCallbackQuery,
  handleCategories,
  handleCorrect,
  handleExpenseCommand,
  handleExpenses,
  handleExport,
  handleGoals,
  handleId,
  handleIncomeCommand,
  handleInvestments,
  handleNewCategory,
  handleRecent,
  handleReport,
  handleSetBudget,
  handleStart,
  handleText,
} from '../src/bot/handlers.js';
import { createAuthMiddleware } from '../src/bot/index.js';

/** Crea harness + ctx y limpia la base al terminar. */
async function setup(t, options = {}) {
  const harness = await createHarness(options);
  t.after(async () => {
    await harness.close();
  });
  const ctx = createFakeCtx({ user: harness.user });
  return { harness, ctx };
}

test('/start saluda al usuario con su nombre', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleStart(ctx, harness.deps);

  const reply = lastReply(ctx);
  assert.ok(reply, 'deberia responder');
  assert.match(reply.html, /Hola/);
  assert.match(reply.html, /Ana/);
  assert.equal(reply.extra.parse_mode, 'HTML');
});

test('usuario desconocido es rechazado por el middleware', async (t) => {
  const { harness } = await setup(t);
  const middleware = createAuthMiddleware(harness.deps);
  const ctx = createFakeCtx({
    user: null,
    from: { id: 999, first_name: 'Intruso', username: 'intruso' },
  });

  let nextCalls = 0;
  await middleware(ctx, async () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 0);
  assert.equal(ctx.state.user, undefined);
  assert.match(allReplyText(ctx), /permiso/i);
});

test('el middleware autentica a un miembro de la familia', async (t) => {
  const { harness } = await setup(t);
  const middleware = createAuthMiddleware(harness.deps);
  const ctx = createFakeCtx({ user: null, from: { id: 111, first_name: 'Ana', username: 'ana' } });

  let nextCalls = 0;
  await middleware(ctx, async () => {
    nextCalls += 1;
  });

  assert.equal(nextCalls, 1);
  assert.equal(ctx.state.user.name, 'Ana');
  assert.equal(ctx.state.resolved.ok, true);
});

test('/gasto crea un gasto variable con categoria inferida', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.payload = '15000 super #comida';

  await handleExpenseCommand(ctx, harness.deps);

  const transactions = await harness.repos.transactions.list({ limit: 10 });
  assert.equal(transactions.length, 1);
  const [transaction] = transactions;
  assert.equal(transaction.type, 'variable_expense');
  assert.equal(transaction.amountCents, 1_500_000);
  assert.equal(transaction.source, 'text');

  const category = await harness.repos.categories.get(transaction.categoryId);
  assert.equal(category.name, 'Supermercado');

  assert.match(allReplyText(ctx), /registrado/i);
  assert.match(allReplyText(ctx), /15\.000/);
});

test('texto libre registra el movimiento', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.message = { text: 'Gasté 15.000 en el super #comida' };

  await handleText(ctx, harness.deps);

  const [transaction] = await harness.repos.transactions.list({ limit: 5 });
  assert.ok(transaction, 'deberia crear el movimiento');
  assert.equal(transaction.amountCents, 1_500_000);
  assert.equal(transaction.type, 'variable_expense');
  assert.equal(transaction.note.toLowerCase().includes('super'), true);
});

test('/ingreso crea un ingreso', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.payload = '250000 sueldo';

  await handleIncomeCommand(ctx, harness.deps);

  const [transaction] = await harness.repos.transactions.list({ limit: 5 });
  assert.ok(transaction);
  assert.equal(transaction.type, 'income');
  assert.equal(transaction.amountCents, 25_000_000);
  assert.match(allReplyText(ctx), /registrado/i);
});

test('/balance muestra el monto del mes', async (t) => {
  const { harness, ctx } = await setup(t);
  const expenseCtx = createFakeCtx({ user: harness.user, payload: '15000 super #comida' });
  await handleExpenseCommand(expenseCtx, harness.deps);

  await handleBalance(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /15\.000/);
  assert.match(text, /2026/);
});

test('/presupuesto muestra la fila de la categoria', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleBudget(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /Supermercado/);
  assert.match(text, /350\.000/);
  assert.match(text, /presupuesto/i);
});

test('un gasto al 80% dispara la alerta al chat familiar', async (t) => {
  const { harness } = await setup(t);
  const comida = await harness.repos.categories.getByName('Comida');
  await harness.repos.categories.update(comida.id, { monthlyBudgetCents: 100_000 });

  const result = await harness.services.transactions.create({
    user: harness.user,
    type: 'variable_expense',
    amountCents: 90_000,
    category: 'Comida',
    note: 'Cena',
    source: 'text',
  });

  assert.ok(result.alerts.length > 0, 'deberia detectar el umbral del 80%');
  assert.ok(harness.sent.length > 0, 'deberia enviar la alerta');
  assert.equal(harness.sent[0].chatId, '-100');
  assert.match(harness.sent[0].html, /presupuesto/i);
});

test('subir una factura crea un documento pendiente con teclado', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.message = { photo: [{ file_id: 'photo-1', file_size: 2048 }] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() {
      return new Uint8Array([1, 2, 3, 4]).buffer;
    },
  });

  try {
    const { handleDocument } = await import('../src/bot/handlers.js');
    await handleDocument(ctx, harness.deps);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const pending = await harness.repos.documents.list({ status: 'pending' });
  assert.equal(pending.length, 1);
  const [document] = pending;
  assert.equal(document.totalCents, 1_250_000);
  assert.equal(document.vendor, 'Edenor');

  const reply = lastReply(ctx);
  assert.ok(reply);
  const callbacks = reply.extra.reply_markup.inline_keyboard
    .flat()
    .map((button) => button.callback_data);
  assert.ok(callbacks.includes(`doc:confirm:${document.id}`));
  assert.ok(callbacks.includes(`doc:cancel:${document.id}`));
});

test('callback confirmar crea el movimiento y edita el mensaje', async (t) => {
  const { harness } = await setup(t);
  const document = await createPendingDocument(harness);
  const ctx = createFakeCtx({ user: harness.user });
  ctx.callbackQuery = { data: `doc:confirm:${document.id}` };

  await handleCallbackQuery(ctx, harness.deps);

  const stored = await harness.repos.documents.get(document.id);
  assert.equal(stored.status, 'confirmed');

  const transactions = await harness.repos.transactions.list({ limit: 5 });
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].documentId, document.id);
  assert.equal(transactions[0].type, 'fixed_expense');

  const edited = ctx.captured.filter((entry) => entry.kind === 'edit');
  assert.equal(edited.length, 1);
  assert.match(edited[0].html, /confirmado/i);
});

test('callback descartar marca el documento como descartado', async (t) => {
  const { harness } = await setup(t);
  const document = await createPendingDocument(harness);
  const ctx = createFakeCtx({ user: harness.user });
  ctx.callbackQuery = { data: `doc:cancel:${document.id}` };

  await handleCallbackQuery(ctx, harness.deps);

  const stored = await harness.repos.documents.get(document.id);
  assert.equal(stored.status, 'discarded');
  assert.equal((await harness.repos.transactions.list({ limit: 5 })).length, 0);

  const edited = ctx.captured.filter((entry) => entry.kind === 'edit');
  assert.equal(edited.length, 1);
  assert.match(edited[0].html, /descartado/i);
});

test('/nueva_categoria crea la categoria y rechaza duplicados', async (t) => {
  const { harness } = await setup(t);

  const first = createFakeCtx({ user: harness.user, payload: 'Mascotas | variable_expense | 20000' });
  await handleNewCategory(first, harness.deps);

  const created = await harness.repos.categories.getByName('Mascotas');
  assert.ok(created, 'deberia crear la categoria');
  assert.equal(created.type, 'variable_expense');

  const second = createFakeCtx({ user: harness.user, payload: 'Mascotas | variable_expense | 20000' });
  await handleNewCategory(second, harness.deps);

  const categories = await harness.repos.categories.list({ includeInactive: true });
  assert.equal(categories.filter((category) => category.name === 'Mascotas').length, 1);
  assert.match(allReplyText(second), /existe/i);
});

test('/presupuesto_set actualiza el limite de una categoria', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.payload = 'Supermercado 400000';

  await handleSetBudget(ctx, harness.deps);

  const category = await harness.repos.categories.getByName('Supermercado');
  assert.equal(category.monthlyBudgetCents, 40_000_000);
  assert.match(allReplyText(ctx), /400\.000/);
});

test('/metas incluye la meta creada', async (t) => {
  const { harness, ctx } = await setup(t);
  await harness.repos.goals.create({
    name: 'Viaje',
    targetCents: 100_000_000,
    savedCents: 25_000_000,
    deadline: '2027-01-15',
    userId: harness.user.id,
  });

  await handleGoals(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /Viaje/);
  assert.match(text, /250\.000/);
  assert.match(text, /25%/);
});

test('/inversiones incluye la meta de ahorro', async (t) => {
  const { harness, ctx } = await setup(t);
  await harness.repos.goals.create({
    name: 'Auto',
    targetCents: 500_000_000,
    savedCents: 50_000_000,
    userId: harness.user.id,
  });
  await handleInvestments(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /Auto/);
  assert.match(text, /500\.000/);
});

test('/corregir actualiza el monto del documento pendiente', async (t) => {
  const { harness, ctx } = await setup(t);
  const document = await createPendingDocument(harness, { totalCents: null });
  assert.equal(document.totalCents, null);

  ctx.payload = '9999';
  await handleCorrect(ctx, harness.deps);

  const stored = await harness.repos.documents.get(document.id);
  assert.equal(stored.totalCents, 999_900);
  const reply = lastReply(ctx);
  assert.ok(reply.extra.reply_markup, 'deberia mostrar los botones del documento');
});

test('/movimientos lista los ultimos movimientos', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleExpenseCommand(
    createFakeCtx({ user: harness.user, payload: '8000 cafe #comida' }),
    harness.deps,
  );
  ctx.payload = '5';

  await handleRecent(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /movimientos/i);
  assert.match(text, /8\.000/);
  assert.match(text, /Ana/);
});

test('/categorias lista las categorias activas', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleCategories(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /Supermercado/);
  assert.match(text, /Servicios/);
  assert.match(text, /Ingreso/);
});

test('/exportar envia un CSV del mes', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleExpenseCommand(
    createFakeCtx({ user: harness.user, payload: '15000 super #comida' }),
    harness.deps,
  );

  await handleExport(ctx, harness.deps);

  const document = ctx.captured.find((entry) => entry.kind === 'document');
  assert.ok(document, 'deberia enviar un documento');
  assert.equal(document.document.filename, `movimientos-${FIXED_MONTH}.csv`);
  const csv = Buffer.from(document.document.source).toString('utf8');
  assert.match(csv, /fecha,tipo,categoria/);
  assert.match(csv, /variable_expense/);
});

test('/id muestra los identificadores del usuario', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleId(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /111/);
  assert.match(text, /Ana/);
});

test('un comando desconocido recibe ayuda amable', async (t) => {
  const { harness, ctx } = await setup(t);
  ctx.message = { text: '/comando_raro' };

  await handleText(ctx, harness.deps);

  assert.match(allReplyText(ctx), /No conozco ese comando/);
  assert.match(allReplyText(ctx), /\/ayuda/);
});

test('/reporte arma el resumen mensual con movimientos', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleExpenseCommand(
    createFakeCtx({ user: harness.user, payload: '20000 super #comida' }),
    harness.deps,
  );

  await handleReport(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /Octubre 2026/);
  assert.match(text, /20\.000/);
});

test('/gastos filtra por categoria', async (t) => {
  const { harness, ctx } = await setup(t);
  await handleExpenseCommand(
    createFakeCtx({ user: harness.user, payload: '15000 super #comida' }),
    harness.deps,
  );
  ctx.payload = 'octubre Supermercado';

  await handleExpenses(ctx, harness.deps);

  const text = allReplyText(ctx);
  assert.match(text, /15\.000/);
  assert.match(text, /Supermercado/);
});

test('cada update queda en el log sin el texto del mensaje', async () => {
  const { createUpdateLogger } = await import('../src/bot/index.js');
  const lines = [];
  const logger = { info: (msg, data) => lines.push({ msg, data }), debug: () => {} };
  const middleware = createUpdateLogger(logger);
  let called = false;
  await middleware({
    updateType: 'message',
    chat: { id: 5, type: 'private' },
    from: { id: 119 },
    message: { text: '/balance octubre' },
  }, async () => { called = true; });
  await middleware({ updateType: 'message', chat: { id: -100, type: 'group' }, from: { id: 7 }, message: { photo: [{}] } }, async () => {});
  await middleware({ updateType: 'message', chat: { id: 5, type: 'private' }, from: { id: 7 }, message: { text: 'gasté 100 en pan' } }, async () => {});
  assert.equal(called, true);
  assert.deepEqual(lines.map((line) => line.data.kind), ['comando', 'foto', 'texto']);
  assert.equal(lines[0].data.command, 'balance');
  assert.equal(lines[1].data.chatType, 'group');
  assert.ok(!JSON.stringify(lines).includes('pan'), 'no guarda el texto');
});
