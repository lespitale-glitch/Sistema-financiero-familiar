/**
 * Pruebas de integracion de la capa SQLite en memoria y repositorios.
 * Ejecutar: node --test tests/store.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/index.js';
import { StoreError } from '../src/db/rows.js';
import { DEFAULT_CATEGORIES, TRANSACTION_TYPES } from '../src/domain.js';
import { TEST_ENV, silentLogger } from './helpers/bot-harness.js';

const CLOCK_NOW = new Date('2026-10-24T15:00:00.000Z');
const OCT_BEGINS = new Date('2026-10-01T03:00:00.000Z');
const NOV_BEGINS = new Date('2026-11-01T03:00:00.000Z');

async function withRepos(t, options = {}) {
  const config = loadConfig({ ...TEST_ENV, ...options.env }, { loadEnvFile: false });
  const repos = await createDatabase(config, {
    logger: silentLogger,
    clock: () => CLOCK_NOW,
    ...options.db,
  });
  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
  t.after(async () => {
    await repos.close();
  });
  return { repos, config };
}

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

test('ensureDefaults siembra y no duplica al re-ejecutarse', async (t) => {
  const { repos } = await withRepos(t);
  const first = await repos.categories.list();
  assert.ok(first.length >= 15);
  const before = first.map((category) => category.id).sort();

  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
  const second = await repos.categories.list();
  assert.equal(second.length, first.length);
  assert.deepEqual(second.map((category) => category.id).sort(), before);
});

test('create/get/getByName/deactivate de categorias', async (t) => {
  const { repos } = await withRepos(t);
  const created = await repos.categories.create({
    name: 'Mascotas',
    type: 'variable_expense',
    emoji: '🐶',
    monthlyBudgetCents: 5_000_000,
    keywords: ['veterinaria', 'vete'],
  });
  assert.equal(created.name, 'Mascotas');
  assert.equal(created.monthlyBudgetCents, 5_000_000);
  assert.equal(created.active, true);

  const byName = await repos.categories.getByName('mascotas');
  assert.equal(byName.id, created.id);
  assert.ok((byName.keywords || []).includes('veterinaria'));

  await assert.rejects(
    () => repos.categories.create({ name: 'Mascotas', type: 'variable_expense' }),
    StoreError,
  );

  await repos.categories.deactivate(created.id);
  const refreshed = await repos.categories.get(created.id);
  assert.equal(refreshed.active, false);
  const activeOnly = await repos.categories.list({ includeInactive: false });
  assert.ok(!activeOnly.some((category) => category.id === created.id));
});

test('getOrFallback devuelve Otros', async (t) => {
  const { repos } = await withRepos(t);
  const fallback = await repos.categories.getOrFallback('variable_expense');
  assert.equal(fallback.name, 'Otros');
});

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------

test('usuarios: create, upsertFromConfig y desactivacion', async (t) => {
  const { repos } = await withRepos(t);

  const upserted = await repos.users.upsertFromConfig({
    name: 'Ana',
    role: 'wife',
    telegramId: '111',
    email: 'ana@test.com',
  });
  assert.equal(upserted.name, 'Ana');
  assert.equal(upserted.active, true);

  // Cambia el email, mismo telegramId: actualiza sin duplicar.
  const again = await repos.users.upsertFromConfig({
    name: 'Ana G.',
    role: 'wife',
    telegramId: '111',
    email: 'ana2@test.com',
  });
  assert.equal(again.id, upserted.id);
  const all = await repos.users.list();
  assert.equal(all.filter((user) => user.telegramId === '111').length, 1);

  const byEmail = await repos.users.getByEmail('ana2@test.com');
  assert.equal(byEmail.id, upserted.id);

  await repos.users.deactivate(again.id);
  const inactive = await repos.users.get(again.id);
  assert.equal(inactive.active, false);
});

// ---------------------------------------------------------------------------
// Transacciones
// ---------------------------------------------------------------------------

function txData({ occurredAt = CLOCK_NOW, ...rest }) {
  return {
    type: TRANSACTION_TYPES.VARIABLE_EXPENSE,
    amountCents: 1_000_000,
    source: 'text',
    status: 'confirmed',
    occurredAt,
    metadata: {},
    ...rest,
  };
}

test('transactions: create, list con filtros y totales', async (t) => {
  const { repos } = await withRepos(t);
  const superCat = await repos.categories.getByName('Supermercado');
  const foodCat = await repos.categories.getByName('Comida');

  await repos.users.upsertFromConfig({ name: 'Ana', role: 'wife', telegramId: '111' });
  const ana = await repos.users.getByTelegramId('111');
  await repos.users.upsertFromConfig({ name: 'Leo', role: 'husband', telegramId: '222' });
  const leo = await repos.users.getByTelegramId('222');

  await repos.transactions.create(txData({ userId: ana.id, categoryId: superCat.id, amountCents: 2_000_000, occurredAt: new Date('2026-10-05T12:00:00Z') }));
  await repos.transactions.create(txData({ userId: leo.id, categoryId: foodCat.id, amountCents: 3_000_000 }));
  await repos.transactions.create(txData({ userId: ana.id, type: 'income', categoryId: foodCat.id, amountCents: 50_000_000 }));
  await repos.transactions.create({ ...txData({ categoryId: superCat.id, amountCents: 999_999 }), status: 'discarded' });

  const october = await repos.transactions.list({ from: OCT_BEGINS, to: NOV_BEGINS, order: 'asc' });
  assert.equal(october.length, 4);
  assert.equal(october[0].amountCents, 2_000_000);
  assert.equal(october[0].createdAt, '2026-10-24T15:00:00.000Z');

  const inAllTime = await repos.transactions.list({ userId: ana.id });
  assert.ok(inAllTime.filter((row) => row.status === 'confirmed').length >= 2);

  const byCategory = await repos.transactions.list({ categoryId: superCat.id, status: 'confirmed' });
  assert.ok(byCategory.every((row) => row.categoryId === superCat.id));
  assert.ok(byCategory.every((row) => row.status === 'confirmed'));

  const byType = await repos.transactions.list({ type: 'income' });
  assert.equal(byType.length, 1);
  assert.equal(byType[0].amountCents, 50_000_000);

  const totals = await repos.transactions.totals({ from: OCT_BEGINS, to: NOV_BEGINS });
  assert.equal(totals.count, 3); // el descartado queda fuera por status confirmed
  assert.equal(totals.incomeCents, 50_000_000);
  assert.equal(totals.expenseCents, 5_000_000);
  assert.equal(totals.investmentCents, 0);
  assert.equal(totals.balanceCents, 45_000_000);
  assert.equal(totals.byUser.length, 2);
  assert.equal(totals.byUser[0].userId, ana.id); // Ana suma ingreso + gasto, queda primero
  assert.equal(totals.byUser[0].totalCents, 52_000_000);
  assert.ok(totals.byCategory.some((row) => row.categoryId === superCat.id));

  const discarded = await repos.transactions.totals({ includeDiscarded: true, status: null });
  assert.equal(discarded.count, 4);

  const single = await repos.transactions.get(october[0].id);
  assert.equal(single.note === '' || single.note === null, true);
});

test('transactions: update y remove', async (t) => {
  const { repos } = await withRepos(t);
  const created = await repos.transactions.create(txData({ note: 'compra' }));
  const updated = await repos.transactions.update(created.id, { note: 'compra del mes' });
  assert.equal(updated.note, 'compra del mes');

  const got = await repos.transactions.get(created.id);
  assert.equal(got.note, 'compra del mes');

  await repos.transactions.remove(created.id);
  assert.equal(await repos.transactions.get(created.id), null);
});

// ---------------------------------------------------------------------------
// Documentos
// ---------------------------------------------------------------------------

test('documents: create, list, update y vinculo de transaccion', async (t) => {
  const { repos } = await withRepos(t);
  await repos.users.upsertFromConfig({ name: 'Ana', role: 'wife', telegramId: '111' });
  const ana = await repos.users.getByTelegramId('111');

  const document = await repos.documents.create({
    userId: ana.id,
    telegramFileId: 'tg-file-1',
    fileName: 'edenor.pdf',
    mimeType: 'application/pdf',
    vendor: 'Edenor',
    totalCents: 15_000_000,
    status: 'pending',
    extracted: { categoryName: 'Servicios', type: 'fixed_expense', confidence: 0.9 },
  });
  assert.equal(document.status, 'pending');
  assert.equal(document.extracted.categoryName, 'Servicios');

  const pending = await repos.documents.list({ userId: ana.id, status: 'pending' });
  assert.equal(pending.length, 1);

  const transaction = await repos.transactions.create(txData({
    userId: ana.id,
    amountCents: 15_000_000,
    documentId: document.id,
    source: 'document',
  }));
  const updated = await repos.documents.update(document.id, { status: 'confirmed', transactionId: transaction.id });
  assert.equal(updated.status, 'confirmed');

  const fromTransaction = await repos.transactions.getByDocument(document.id);
  assert.equal(fromTransaction.id, transaction.id);
});

// ---------------------------------------------------------------------------
// Metas
// ---------------------------------------------------------------------------

test('goals: create, getByName y contribute', async (t) => {
  const { repos } = await withRepos(t);
  await repos.users.upsertFromConfig({ name: 'Ana', role: 'wife', telegramId: '111' });
  const ana = await repos.users.getByTelegramId('111');

  const goal = await repos.goals.create({
    name: 'Vacaciones',
    targetCents: 100_000_000,
    savedCents: 20_000_000,
    deadline: '2027-01-15',
    userId: ana.id,
  });
  assert.equal(goal.targetCents, 100_000_000);

  const byName = await repos.goals.getByName('vacaciones');
  assert.equal(byName.id, goal.id);

  const updated = await repos.goals.contribute(goal.id, 5_000_000);
  assert.equal(updated.savedCents, 25_000_000);

  const listed = await repos.goals.list();
  assert.equal(listed.length, 1);
});

// ---------------------------------------------------------------------------
// Settings y alerts
// ---------------------------------------------------------------------------

test('settings: set/get/all y claves deserializadas', async (t) => {
  const { repos } = await withRepos(t);
  await repos.settings.set('budget.overall_cents', 60_000_000);
  await repos.settings.set('app.feature_x', 'texto');

  assert.equal(await repos.settings.get('budget.overall_cents', null), 60_000_000);
  assert.equal(await repos.settings.get('app.feature_x'), 'texto');
  assert.equal(await repos.settings.get('no.existe', 'defecto'), 'defecto');

  const all = await repos.settings.all();
  assert.equal(all['budget.overall_cents'], 60_000_000);
});

test('alerts.claim deduplica por clave y list filtra por periodo', async (t) => {
  const { repos } = await withRepos(t);
  const key = 'budget:2026-10:category:cat-food:80';

  const first = await repos.alerts.claim(key, { categoryId: 'cat-food', threshold: 80, period: '2026-10', payload: { scope: 'category' } });
  assert.equal(first, true);
  const duplicate = await repos.alerts.claim(key, { categoryId: 'cat-food', threshold: 80, period: '2026-10' });
  assert.equal(duplicate, false);

  await repos.alerts.claim('budget:2026-11:category:cat-food:80', { categoryId: 'cat-food', threshold: 80, period: '2026-11' });
  const october = await repos.alerts.list({ period: '2026-10' });
  assert.equal(october.length, 1);
  assert.equal(october[0].key, key);
  assert.equal(october[0].payload?.scope, 'category');
});

// ---------------------------------------------------------------------------
// Email log
// ---------------------------------------------------------------------------

test('emailLog: mark y seen', async (t) => {
  const { repos } = await withRepos(t);
  assert.equal(await repos.emailLog.seen('msg-1'), false);
  await repos.emailLog.mark({
    messageId: 'msg-1',
    fromAddress: 'facturas@ejemplo.com',
    status: 'logged',
    transactionId: 'tx-1',
  });
  assert.equal(await repos.emailLog.seen('msg-1'), true);
  const entry = await repos.emailLog.get('msg-1');
  assert.equal(entry.status, 'logged');
  assert.equal(entry.from_address != null, true);
});
