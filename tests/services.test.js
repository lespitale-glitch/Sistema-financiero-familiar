/**
 * Pruebas de los servicios de transactions + alerts con la base real en memoria.
 * Ejecutar: node --test tests/services.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_MONTH, createHarness } from './helpers/bot-harness.js';

const COMIDA_BUDGET = 12_000_000; // $ 120.000

async function setup(t, { env = {} } = {}) {
  const harness = await createHarness({ env });
  t.after(async () => {
    await harness.close();
  });
  return harness;
}


// ---------------------------------------------------------------------------
// transactions.create
// ---------------------------------------------------------------------------

test('create resuelve categoria por nombre y aplica fallback', async (t) => {
  const harness = await setup(t);
  const { services, user, repos } = harness;

  const result = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 1_500_000,
    category: 'Comida',
    note: 'delivery',
    source: 'text',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });
  assert.equal(result.transaction.categoryId !== null, true);
  const category = await repos.categories.get(result.transaction.categoryId);
  assert.equal(category.name, 'Comida');

  const fallback = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 100_000,
  });
  const fallbackCategory = await repos.categories.get(fallback.transaction.categoryId);
  assert.equal(fallbackCategory.name, 'Otros');
});

test('create con tipo o monto invalido lanza error', async (t) => {
  const harness = await setup(t);
  const { services, user } = harness;

  await assert.rejects(
    () => services.transactions.create({ user, type: 'roto', amountCents: 1_000 }),
    /Tipo de movimiento/,
  );
  await assert.rejects(
    () => services.transactions.create({ user, type: 'income', amountCents: 0 }),
    /monto/,
  );
});

// ---------------------------------------------------------------------------
// Alertas de presupuesto
// ---------------------------------------------------------------------------

test('gasto que cruza 80% dispara la alerta una sola vez', async (t) => {
  const harness = await setup(t);
  const { services, user, repos, notifier, sent } = harness;
  const food = await repos.categories.getByName('Comida');

  // 83% del presupuesto de Comida.
  const first = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 10_000_000,
    category: 'Comida',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });
  assert.equal(first.alerts.length, 1);
  const [alert] = first.alerts;
  assert.equal(alert.key, `budget:${FIXED_MONTH}:category:${food.id}:80`);
  assert.equal(alert.percent, 83);

  const firstDelivery = first.alertResult.deliveries[0];
  assert.equal(firstDelivery.sent, true);

  // Otro gasto del mes sigue >= 80%: la alerta ya se notifico.
  const second = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 1_000_000,
    category: 'Comida',
    occurredAt: new Date('2026-10-15T13:00:00.000Z'),
  });
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alertResult.deliveries[0].sent, false);
  assert.equal(second.alertResult.deliveries[0].reason, 'duplicate');

  // Una sola notificacion: al chat familiar y, por ALERT_AUTHOR_DM (default
  // true), tambien al privado del autor.
  assert.deepEqual(
    sent.filter((message) => message.html.includes('Umbral de presupuesto 80%')).map((message) => message.chatId),
    ['-100', '111'],
  );
});

test('cruzar 100% dispara la alerta de excedido', async (t) => {
  const harness = await setup(t);
  const { services, user, repos, notifier, sent } = harness;
  const food = await repos.categories.getByName('Comida');

  const result = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 13_000_000, // 108%
    category: 'Comida',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });

  assert.deepEqual(
    result.alerts.map((alert) => alert.key).sort(),
    [
      `budget:${FIXED_MONTH}:category:${food.id}:100`,
      `budget:${FIXED_MONTH}:category:${food.id}:80`,
    ].sort(),
  );
  const exceededAlert = result.alerts.find((alert) => alert.threshold === 100);
  assert.equal(exceededAlert.percent, 108);
  assert.ok(sent.some((message) => message.html.includes('Presupuesto superado')));
});

test('presupuesto general configurado dispara la alerta overall', async (t) => {
  const harness = await setup(t);
  const { services, user, repos, sent } = harness;
  await repos.settings.set('budget.overall_cents', 11_000_000);

  const result = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 10_000_000, // 91% del general
    category: 'Comida',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });

  const overall = result.alerts.filter((alert) => alert.scope === 'overall');
  assert.equal(overall.length, 1);
  assert.equal(overall[0].key, `budget:${FIXED_MONTH}:overall:80`);
  assert.equal(overall[0].percent, 91);
  assert.ok(sent.some((message) => message.html.includes('Presupuesto general')));
});

test('skipAlerts y alerts-disabled no notifican', async (t) => {
  const harness = await setup(t, { env: { ALERTS_ENABLED: 'false' } });
  const { services, user } = harness;

  const skipped = await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 10_000_000,
    category: 'Comida',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });
  assert.equal(skipped.alertResult.skipped, true);
  assert.equal(harness.sent.length, 0);

  const harness2 = await setup(t);
  const result = await harness2.services.transactions.create({
    user: harness2.user,
    type: 'variable_expense',
    amountCents: 10_000_000,
    category: 'Comida',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
    skipAlerts: true,
  });
  assert.equal(result.alerts.length, 0);
  assert.equal(harness2.sent.length, 0);

  const alertsRepoCount = await harness2.repos.alerts.list({ period: FIXED_MONTH });
  assert.equal(alertsRepoCount.filter((row) => row.categoryId != null).length, 0);
});

test('ingresos no disparan alertas', async (t) => {
  const harness = await setup(t);
  const { services, user } = harness;
  const result = await services.transactions.create({
    user,
    type: 'income',
    amountCents: 50_000_000,
    category: 'Sueldo',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });
  assert.equal(result.alerts.length, 0);
  assert.equal(harness.sent.length, 0);
});

test('evaluateMonth recalcula todas las alertas del mes', async (t) => {
  const harness = await setup(t);
  const { services, user, repos } = harness;
  const food = await repos.categories.getByName('Comida');

  await services.transactions.create({
    user,
    type: 'variable_expense',
    amountCents: 10_000_000,
    category: 'Comida',
    occurredAt: new Date('2026-10-15T12:00:00.000Z'),
  });

  const month = await services.alerts.evaluateMonth(FIXED_MONTH, { notify: false });
  assert.equal(month.skipped, false);
  assert.equal(month.monthKey, FIXED_MONTH);
  assert.deepEqual(
    month.alerts.map((alert) => alert.key),
    [`budget:${FIXED_MONTH}:category:${food.id}:80`],
  );

  // Con notify reintenta y encuentra la alerta ya notificada.
  const monthNotify = await services.alerts.evaluateMonth(FIXED_MONTH, { notify: true });
  assert.equal(monthNotify.alerts.length, 1);
  assert.equal(monthNotify.deliveries[0].sent, false);
  assert.equal(monthNotify.deliveries[0].reason, 'duplicate');
});

test('buildAlertMessage arma el mensaje con formato esperado', async (t) => {
  const harness = await setup(t);
  const { services } = harness;
  const message = services.alerts.buildAlertMessage({
    scope: 'category',
    categoryName: 'Comida',
    emoji: '🍔',
    periodKey: FIXED_MONTH,
    threshold: 80,
    percent: 83,
    spentCents: 10_000_000,
    budgetCents: COMIDA_BUDGET,
    remainingCents: 2_000_000,
  });
  assert.match(message, /Umbral de presupuesto 80%/);
  assert.match(message, /83%/);
  assert.match(message, /Comida/);
  assert.match(message, /Gastado: <b>\$ 100\.000<\/b> de \$ 120\.000/);
  assert.match(message, /Te quedan/);
});
