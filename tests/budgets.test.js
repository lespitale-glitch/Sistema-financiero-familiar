/**
 * Pruebas del calculo de presupuestos y alertas de umbral.
 * Ejecutar: node --test tests/budgets.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  MONTH_KEY,
  buildTotals,
  categoryByName,
  makeTransaction,
} from './helpers/finance-fixtures.js';
import { buildBudgetSummary, budgetStatus, evaluateBudgetAlerts } from '../src/services/budgets.js';
import { TRANSACTION_TYPES } from '../src/domain.js';

const SUPER = categoryByName('Supermercado'); // presupuesto 350000 * 100 = 35.000.000
const COMIDA = categoryByName('Comida'); // 120000 * 100 = 12.000.000
const SERVICIOS = categoryByName('Servicios'); // 90000 * 100 = 9.000.000

function summaryOf({ categories = CATEGORIES, transactions = [], overallBudgetCents = null, thresholds = [80, 100] } = {}) {
  return buildBudgetSummary({ categories, transactions, overallBudgetCents, thresholds });
}

test('budgetStatus clasifica con los umbrales configurados', () => {
  assert.equal(budgetStatus(79), 'ok');
  assert.equal(budgetStatus(80), 'warning');
  assert.equal(budgetStatus(99), 'warning');
  assert.equal(budgetStatus(100), 'exceeded');
  assert.equal(budgetStatus(150), 'exceeded');
  assert.equal(budgetStatus(null), 'unbudgeted');
  assert.equal(budgetStatus(70, [90]), 'ok');
  assert.equal(budgetStatus(90, [90, 100]), 'warning');
});

test('buildBudgetSummary arma filas con datos de los repositorios', () => {
  const transactions = [
    makeTransaction({ categoryId: SUPER.id, amountCents: 10_000_000 }), // 100.000
    makeTransaction({ categoryId: SUPER.id, amountCents: 5_000_000 }), // 50.000
    makeTransaction({ categoryId: SERVICIOS.id, amountCents: 2_000_000, type: TRANSACTION_TYPES.FIXED_EXPENSE }),
    makeTransaction({ categoryId: categoryByName('Inversiones').id, amountCents: 8_000_000, type: TRANSACTION_TYPES.INVESTMENT }),
    makeTransaction({ categoryId: null, amountCents: 300_000 }),
    makeTransaction({ categoryId: COMIDA.id, amountCents: 1_000_000, status: 'discarded' }),
  ];

  const summary = summaryOf({ transactions });

  const superRow = summary.rows.find((row) => row.categoryId === SUPER.id);
  assert.equal(superRow.spentCents, 15_000_000);
  assert.equal(superRow.budgetCents, 35_000_000);
  assert.equal(superRow.remainingCents, 20_000_000);
  assert.equal(superRow.percent, 43);
  assert.equal(superRow.status, 'ok');

  const servicesRow = summary.rows.find((row) => row.categoryId === SERVICIOS.id);
  assert.equal(servicesRow.spentCents, 2_000_000);

  // Los descartados y las inversiones no suman al presupuesto de gastos.
  assert.equal(summary.totals.spentCents, 17_300_000);
  assert.equal(summary.uncategorizedCents, 300_000);
  // Las filas solo incluyen categorias con presupuesto o gasto.
  assert.ok(summary.rows.every((row) => row.budgetCents > 0 || row.spentCents > 0));
});

test('ordena filas: presupuestadas primero, mas consumidas arriba', () => {
  const transactions = [
    makeTransaction({ categoryId: SUPER.id, amountCents: 30_000_000 }), // 86%
    makeTransaction({ categoryId: COMIDA.id, amountCents: 11_000_000 }), // 92%
    makeTransaction({ categoryId: categoryByName('Salud').id, amountCents: 1_000_000 }), // sin presupuesto
  ];
  const rows = summaryOf({ transactions }).rows;
  assert.equal(rows[0].categoryId, COMIDA.id);
  assert.ok(rows.every((row, index, all) => (
    index === 0 || (all[index - 1].budgetCents !== null) || (row.budgetCents === null)
  )));
  const healthIndex = rows.findIndex((row) => row.categoryId === categoryByName('Salud').id);
  assert.ok(healthIndex > 0);
});

test('estado del total: con presupuesto general explicito', () => {
  const transactions = [makeTransaction({ categoryId: SUPER.id, amountCents: 30_000_000 })];
  const summary = summaryOf({ transactions, overallBudgetCents: 40_000_000 });
  assert.equal(summary.overall.configured, true);
  assert.equal(summary.overall.budgetCents, 40_000_000);
  assert.equal(summary.overall.percent, 75);
  assert.equal(summary.overall.status, 'ok');
  assert.equal(summary.totals.hasBudget, true);
  assert.equal(summary.totals.percent, 75);
});

test('sin presupuesto general: usa la suma de presupuestos por categoria', () => {
  const summary = summaryOf({ transactions: [] });
  const expectedBudget = SUPER.monthlyBudgetCents + COMIDA.monthlyBudgetCents + SERVICIOS.monthlyBudgetCents
    + categoryByName('Transporte').monthlyBudgetCents + categoryByName('Alquiler').monthlyBudgetCents
    + categoryByName('Salud').monthlyBudgetCents + categoryByName('Educacion').monthlyBudgetCents
    + categoryByName('Entretenimiento').monthlyBudgetCents + categoryByName('Hogar').monthlyBudgetCents;
  assert.equal(summary.overall.configured, false);
  assert.equal(summary.totals.budgetCents, expectedBudget);
  assert.equal(summary.totals.percent, 0);
  assert.equal(summary.totals.hasBudget, true);
});

test('sin presupuestos configurados queda unbudgeted', () => {
  const summary = summaryOf({
    categories: [{ id: 'x', name: 'X', type: 'variable_expense', monthlyBudgetCents: null, emoji: 'x' }],
    transactions: [],
  });
  assert.equal(summary.totals.hasBudget, false);
  assert.equal(summary.totals.percent, null);
  assert.equal(summary.overall.configured, false);
  assert.equal(summary.rows.length, 0);
});

test('umbral al 80% y 100% en una categoria', () => {
  const transactions = [makeTransaction({ categoryId: COMIDA.id, amountCents: 9_000_000 })]; // 75%
  const summary = summaryOf({ transactions });
  const row = summary.rows.find((row) => row.categoryId === COMIDA.id);
  assert.equal(row.percent, 75);
  assert.equal(row.status, 'ok');
  assert.equal(row.thresholdReached, null);

  const row80 = summaryOf({ transactions: [makeTransaction({ categoryId: COMIDA.id, amountCents: 10_000_000 })] })
    .rows.find((row) => row.categoryId === COMIDA.id); // 83%
  assert.equal(row80.status, 'warning');
  assert.equal(row80.thresholdReached, 80);

  const row100 = summaryOf({ transactions: [makeTransaction({ categoryId: COMIDA.id, amountCents: 13_000_000 })] })
    .rows.find((row) => row.categoryId === COMIDA.id); // 108%
  assert.equal(row100.status, 'exceeded');
  assert.equal(row100.thresholdReached, 100);
  assert.equal(row100.remainingCents, -1_000_000);
});

test('evaluateBudgetAlerts genera alertas con las claves de deduplicacion', () => {
  const transactions = [makeTransaction({ categoryId: COMIDA.id, amountCents: 13_000_000 })];
  const summary = summaryOf({ transactions });
  const alerts = evaluateBudgetAlerts({ summary, thresholds: [80, 100], periodKey: MONTH_KEY });

  const keys = alerts.map((alert) => alert.key);
  assert.deepEqual(keys, [
    `budget:${MONTH_KEY}:category:${COMIDA.id}:80`,
    `budget:${MONTH_KEY}:category:${COMIDA.id}:100`,
  ]);
  const [first] = alerts;
  assert.equal(first.scope, 'category');
  assert.equal(first.categoryName, 'Comida');
  assert.equal(first.percent, 108);
  assert.equal(first.spentCents, 13_000_000);
  assert.equal(first.remainingCents, -1_000_000);
  assert.equal(first.periodKey, MONTH_KEY);
});

test('evaluateBudgetAlerts filtra por categoria y no repite claves', () => {
  const transactions = [
    makeTransaction({ categoryId: COMIDA.id, amountCents: 13_000_000 }),
    makeTransaction({ categoryId: SUPER.id, amountCents: 16_000_000 }), // 46%
  ];
  const summary = summaryOf({ transactions });
  const alerts = evaluateBudgetAlerts({
    summary, thresholds: [80, 100], periodKey: MONTH_KEY, onlyCategoryId: COMIDA.id,
  });
  assert.equal(alerts.every((alert) => alert.categoryId === COMIDA.id), true);
  assert.equal(alerts.length, 2);

  const noDupes = evaluateBudgetAlerts({ summary, thresholds: [80, 80, 100], periodKey: MONTH_KEY });
  const keys = new Set(noDupes.map((alert) => alert.key));
  assert.equal(keys.size, noDupes.length);
});

test('evaluateBudgetAlerts sin resumen vuelve vacio', () => {
  assert.deepEqual(evaluateBudgetAlerts({}), []);
  assert.deepEqual(evaluateBudgetAlerts({ summary: summaryOf(), thresholds: [80] }), []);
});

test('presupuesto general configurado dispara alerta overall', () => {
  const transactions = [makeTransaction({ categoryId: SUPER.id, amountCents: 36_000_000 })];
  const summary = summaryOf({ transactions, overallBudgetCents: 38_500_000 }); // 94%
  const alerts = evaluateBudgetAlerts({ summary, thresholds: [80, 100], periodKey: MONTH_KEY });
  const overall = alerts.filter((alert) => alert.scope === 'overall');
  assert.deepEqual(overall.map((alert) => alert.threshold), [80]);
  assert.equal(overall[0].key, `budget:${MONTH_KEY}:overall:80`);
});

test('alerta overall al 100% estando excedido', () => {
  const transactions = [makeTransaction({ categoryId: SUPER.id, amountCents: 40_000_000 })];
  const summary = summaryOf({ transactions, overallBudgetCents: 39_000_000 }); // 103%
  const alerts = evaluateBudgetAlerts({ summary, thresholds: [80, 100], periodKey: MONTH_KEY });
  assert.deepEqual(
    alerts.filter((alert) => alert.scope === 'overall').map((alert) => alert.threshold),
    [80, 100],
  );
});

test('sin presupuesto general no hay alertas overall', () => {
  const summary = summaryOf({ overallBudgetCents: null });
  const alerts = evaluateBudgetAlerts({ summary, thresholds: [80, 100], periodKey: MONTH_KEY });
  assert.equal(alerts.some((alert) => alert.scope === 'overall'), false);
});

test('solo alertas de categoria al pasar includeOverall:false y periodKey por defecto', () => {
  const summary = { ...summaryOf({ overallBudgetCents: 10_000_000 }), monthKey: MONTH_KEY };
  const alerts = evaluateBudgetAlerts({ summary, thresholds: [80], includeOverall: false });
  assert.equal(alerts.length, 0);
  // monthKey del summary como fallback del periodo.
  const withCat = { ...summary, rows: summary.rows.map((row) => ({ ...row, percent: 120 })) };
  const alertsCat = evaluateBudgetAlerts({ summary: withCat, thresholds: [100], includeOverall: false });
  assert.equal(alertsCat[0].key, `budget:${MONTH_KEY}:category:${alertsCat[0].categoryId}:100`);
});

test('buildTotals del fixture es JSON-safe para Supabase', () => {
  const totals = buildTotals([
    makeTransaction({ categoryId: SUPER.id, amountCents: 10, userId: 'user-ana' }),
    makeTransaction({ categoryId: null, amountCents: 5, userId: 'user-leo' }),
  ]);
  assert.equal(typeof totals.transactions[0].categoryId, 'string');
  assert.equal(totals.byUser.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(totals)), totals);
});
