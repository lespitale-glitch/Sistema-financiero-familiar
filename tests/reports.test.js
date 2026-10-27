/**
 * Pruebas de los generadores de reportes HTML para Telegram.
 * Ejecutar: node --test tests/reports.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  MONTH_KEY,
  buildTotals,
  categoryByName,
  makeGoal,
  makeTransaction,
} from './helpers/finance-fixtures.js';
import { buildBudgetSummary } from '../src/services/budgets.js';
import {
  buildBalanceReport,
  buildBudgetReport,
  buildCategoryListMessage,
  buildExpensesReport,
  buildInvestmentsReport,
  buildPendingDocumentMessage,
  buildSummaryMessage,
  buildTransactionConfirmation,
  formatMonthTitle,
  formatTypeLabel,
} from '../src/services/reports.js';

const BASE = { currency: 'ARS', locale: 'es-AR' };

const USERS = [
  { id: 'user-ana', name: 'Ana', role: 'wife', telegramId: '111', email: 'ana@test.com', active: true },
  { id: 'user-leo', name: 'Leo', role: 'husband', telegramId: '222', email: null, active: true },
];

function totals(transactions) {
  return buildTotals(transactions);
}

// ---------------------------------------------------------------------------
// Helpers basicos
// ---------------------------------------------------------------------------

test('formatTypeLabel y formatMonthTitle', () => {
  assert.equal(formatTypeLabel('income'), 'Ingreso');
  assert.equal(formatTypeLabel('fixed_expense'), 'Gasto fijo');
  assert.equal(formatTypeLabel('variable_expense'), 'Gasto variable');
  assert.equal(formatTypeLabel('investment'), 'Inversión');
  assert.equal(formatTypeLabel('desconocido'), 'Movimiento');
  assert.equal(formatMonthTitle(MONTH_KEY), 'Octubre 2026');
  assert.equal(formatMonthTitle(null), '');
  assert.equal(formatMonthTitle('nada'), 'nada');
});

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

test('balance en blanco', () => {
  const text = buildBalanceReport({ monthKey: MONTH_KEY, totals: totals([]), ...BASE });
  assert.match(text, /Balance · Octubre 2026/);
  assert.match(text, /No hay movimientos/);
  assert.ok(text.length < 4000);
});

test('balance muestra ingresos, gastos, inversiones y neto', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Sueldo').id, type: 'income', amountCents: 50_000_000, userId: 'user-ana' }),
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 10_000_000, userId: 'user-ana' }),
    makeTransaction({ categoryId: categoryByName('Alquiler').id, type: 'fixed_expense', amountCents: 20_000_000, userId: 'user-leo' }),
    makeTransaction({ categoryId: categoryByName('Ahorro').id, type: 'investment', amountCents: 5_000_000, userId: 'user-leo' }),
  ]);
  const text = buildBalanceReport({ monthKey: MONTH_KEY, totals: data, userName: 'Ana', ...BASE });
  assert.match(text, /Hola, Ana/);
  assert.match(text, /Ingresos: <b>\$ 500\.000/);
  assert.match(text, /Gastos: <b>\$ 300\.000/);
  assert.match(text, /Inversiones: <b>\$ 50\.000/);
  assert.match(text, /Ahorro neto: \$ 150\.000/);
  assert.match(text, /Movimientos: 4/);
});

test('balance con deficit y presupuesto general', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 40_000_000 }),
  ]);
  const summary = buildBudgetSummary({ categories: CATEGORIES, transactions: data.transactions, overallBudgetCents: 30_000_000 });
  const text = buildBalanceReport({ monthKey: MONTH_KEY, totals: data, budgetSummary: summary, ...BASE });
  assert.match(text, /Déficit/);
  assert.match(text, /Presupuesto general: <b>\$ 400\.000<\/b> de \$ 300\.000 · <b>133%/);
});

test('balance escapa HTML en el nombre', () => {
  const data = totals([]);
  const text = buildBalanceReport({ monthKey: MONTH_KEY, totals: data, userName: '<script>&', ...BASE });
  assert.match(text, /&lt;script&gt;&amp;/);
  assert.ok(!text.includes('<script>'));
});

// ---------------------------------------------------------------------------
// Presupuesto
// ---------------------------------------------------------------------------

test('presupuesto sin configuracion da instrucciones', () => {
  const summary = buildBudgetSummary({ categories: [], transactions: [] });
  const text = buildBudgetReport({ monthKey: MONTH_KEY, budgetSummary: summary, ...BASE });
  assert.match(text, /No hay presupuestos configurados/);
  assert.match(text, /\/presupuesto_set/);
});

test('presupuesto con presupuesto general y filas por categoria', () => {
  const transactions = [
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 30_000_000 }), // 86%
    makeTransaction({ categoryId: categoryByName('Comida').id, amountCents: 13_000_000 }), // 108%
  ];
  const summary = buildBudgetSummary({
    categories: CATEGORIES,
    transactions,
    overallBudgetCents: 60_000_000,
  });
  const text = buildBudgetReport({ monthKey: MONTH_KEY, budgetSummary: summary, ...BASE });
  assert.match(text, /Presupuesto · Octubre 2026/);
  assert.match(text, /<b>General<\/b>/);
  assert.match(text, /Quedan <b>\$ 170\.000/);
  assert.match(text, /Supermercado/);
  assert.match(text, /Comida/);
  assert.match(text, /Excedido por \$ 10\.000/);
});

test('presupuesto lista categorias presupuestadas aunque no se hayan gastado', () => {
  const transactions = [makeTransaction({ categoryId: null, amountCents: 5_000_000, note: 'varios' })];
  const summary = buildBudgetSummary({ categories: CATEGORIES, transactions });
  const text = buildBudgetReport({ monthKey: MONTH_KEY, budgetSummary: summary, ...BASE });
  assert.match(text, /Supermercado/);
  // Lo sin categoría no aparece como fila presupuestada.
  assert.ok(!text.includes('Sin categoría'));
});

// ---------------------------------------------------------------------------
// Gastos
// ---------------------------------------------------------------------------

test('gastos en blanco', () => {
  const text = buildExpensesReport({ monthKey: MONTH_KEY, totals: totals([]), categories: CATEGORIES, users: USERS, ...BASE });
  assert.match(text, /No hay gastos registrados/);
});

test('gastos muestra top categorias y por persona', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 20_000_000, userId: 'user-ana', note: 'compra del mes' }),
    makeTransaction({ categoryId: categoryByName('Comida').id, amountCents: 10_000_000, userId: 'user-leo' }),
    makeTransaction({ categoryId: categoryByName('Transporte').id, amountCents: 5_000_000, userId: 'user-ana' }),
  ]);
  const text = buildExpensesReport({ monthKey: MONTH_KEY, totals: data, categories: CATEGORIES, users: USERS, ...BASE });
  assert.match(text, /Total: <b>\$ 350\.000/);
  assert.match(text, /Top categorías/);
  assert.match(text, /Supermercado/);
  assert.match(text, /57%/);
  assert.match(text, /Por persona/);
  assert.match(text, /Ana/);
  assert.match(text, /Leo/);
});

test('gastos de una categoria filtrada incluye movimientos y total', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 20_000_000, userId: 'user-ana', note: 'compra' }),
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 30_000_000, userId: 'user-leo' }),
    makeTransaction({ categoryId: categoryByName('Comida').id, amountCents: 5_000_000, userId: 'user-leo' }),
  ]);
  const superCategory = categoryByName('Supermercado');
  const text = buildExpensesReport({
    monthKey: MONTH_KEY,
    totals: data,
    categories: CATEGORIES,
    users: USERS,
    categoryFilter: superCategory,
    ...BASE,
  });
  assert.match(text, /Categoría: 🛒 <b>Supermercado<\/b>/);
  assert.match(text, /compra/);
  assert.match(text, /Leo/);
  assert.match(text, /Total: <b>\$ 500\.000/);
  assert.match(text, /2 movimientos/);
  assert.ok(!/Top categorías/.test(text));
});

test('gastos filtra por id aunque el nombre venga difuso', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Comida').id, amountCents: 5_000_000 }),
  ]);
  const text = buildExpensesReport({
    monthKey: MONTH_KEY,
    totals: data,
    categories: CATEGORIES,
    categoryFilter: categoryByName('Comida').id,
    ...BASE,
  });
  assert.match(text, /Categoría/);
  assert.match(text, /Comida/);
});

test('gastos con filtro sin movimientos avisa', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Comida').id, amountCents: 5_000_000 }),
  ]);
  const text = buildExpensesReport({
    monthKey: MONTH_KEY,
    totals: data,
    categories: CATEGORIES,
    categoryFilter: categoryByName('Salud'),
    ...BASE,
  });
  assert.match(text, /No hay gastos de esa categoría/);
});

// ---------------------------------------------------------------------------
// Inversiones y metas
// ---------------------------------------------------------------------------

test('inversiones en blanco', () => {
  const text = buildInvestmentsReport({ monthKey: MONTH_KEY, totals: totals([]), goals: [], ...BASE });
  assert.match(text, /No hay inversiones|sin aportes/i);
  assert.match(text, /\/meta/);
});

test('inversiones con aportes y metas con progreso', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Inversiones').id, type: 'investment', amountCents: 10_000_000, note: 'plazo fijo' }),
    makeTransaction({ categoryId: categoryByName('Ahorro').id, type: 'investment', amountCents: 2_500_000 }),
  ]);
  const goals = [
    makeGoal({ name: 'Vacaciones', targetCents: 100_000_000, savedCents: 25_000_000, deadline: '2027-01-15' }),
    makeGoal({ name: 'Auto', targetCents: 50_000_000, savedCents: 50_000_000 }),
  ];
  const text = buildInvestmentsReport({ monthKey: MONTH_KEY, totals: data, goals, ...BASE });
  assert.match(text, /\$ 125\.000/);
  assert.match(text, /Vacaciones/);
  assert.match(text, /25%/);
  assert.match(text, /100%/);
  assert.match(text, /15\/01\/2027/);
});

// ---------------------------------------------------------------------------
// Resumen generico
// ---------------------------------------------------------------------------

test('resumen en blanco y con datos', () => {
  const empty = buildSummaryMessage({ title: 'Resumen diario', rangeLabel: 'Hoy · 24/10/2026', totals: totals([]), ...BASE });
  assert.match(empty, /Resumen diario · Hoy · 24\/10\/2026/);
  assert.match(empty, /No hay movimientos/);

  const data = totals([
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 30_000_000, userId: 'user-ana' }),
    makeTransaction({ categoryId: categoryByName('Comida').id, amountCents: 12_000_000, userId: 'user-leo' }),
    makeTransaction({ categoryId: categoryByName('Sueldo').id, type: 'income', amountCents: 60_000_000, userId: 'user-ana' }),
  ]);
  const summary = buildBudgetSummary({
    categories: CATEGORIES,
    transactions: data.transactions,
    overallBudgetCents: 50_000_000,
  });
  const goals = [makeGoal({ name: 'Viaje', targetCents: 90_000_000, savedCents: 45_000_000 })];
  const text = buildSummaryMessage({
    title: 'Cierre de mes',
    monthKey: MONTH_KEY,
    totals: data,
    budgetSummary: summary,
    categories: CATEGORIES,
    goals,
    ...BASE,
  });
  assert.match(text, /Cierre de mes · Octubre 2026/);
  assert.match(text, /Ingresos: <b>\$ 600\.000/);
  assert.match(text, /Balance|Ahorro neto/);
  assert.match(text, /Top categorías/);
  assert.match(text, /Supermercado/);
  assert.match(text, /Presupuesto/);
  assert.match(text, /⚠️/);
  assert.match(text, /Metas/);
  assert.match(text, /Viaje/);
  assert.ok(text.length < 3900);
});

// ---------------------------------------------------------------------------
// Confirmaciones y documentos
// ---------------------------------------------------------------------------

test('confirmacion de movimiento con presupuesto de la categoria', () => {
  const data = totals([
    makeTransaction({ categoryId: categoryByName('Supermercado').id, amountCents: 700_000 }), // 2%
  ]);
  const summary = buildBudgetSummary({ categories: CATEGORIES, transactions: data.transactions });
  const transaction = {
    ...data.transactions[0],
    note: '超级<script>alert(1)</script>',
  };
  transaction.categoryId = categoryByName('Supermercado').id;
  const text = buildTransactionConfirmation({
    transaction,
    category: categoryByName('Supermercado'),
    user: USERS[0],
    budgetSummary: summary,
    ...BASE,
  });
  assert.match(text, /Movimiento registrado/);
  assert.match(text, /Gasto variable<\/b> · <b>-\$ 7\.000/);
  assert.match(text, /Supermercado/);
  assert.match(text, /Usuario: Ana/);
  assert.match(text, /10\/10\/2026/);
  assert.match(text, /Presupuesto: <b>2%<\/b> \(\$ 7\.000 de \$ 350\.000\)/);
  assert.ok(!text.includes('<script>'));
});

test('confirmacion sin movimiento y sin categoria', () => {
  const text = buildTransactionConfirmation({ ...BASE });
  assert.match(text, /No se pudo leer/);
  const withTx = buildTransactionConfirmation({
    transaction: makeTransaction({ categoryId: null, amountCents: 10_000 }),
    ...BASE,
  });
  assert.match(withTx, /Sin categoría/);
});

test('factura pendiente con datos de extraccion', () => {
  const text = buildPendingDocumentMessage({
    document: {
      id: 'doc-1',
      fileName: 'factura.pdf',
      vendor: 'Edenor <&>',
      totalCents: 15_000_50,
      dueDate: '2026-10-30',
      extracted: {
        categoryName: 'Servicios',
        type: 'fixed_expense',
        confidence: 0.9,
        lineItems: [
          { description: 'Consumo luz', amountCents: 12_000_00 },
          { description: 'IVA', amountCents: 3_000_50 },
        ],
        warnings: ['Fecha leída dudosa'],
      },
    },
    category: categoryByName('Servicios'),
    ...BASE,
  });
  assert.match(text, /Factura detectada/);
  assert.match(text, /Edenor &lt;&amp;&gt;/);
  assert.match(text, /Total: <b>\$ 15\.000,50/);
  assert.match(text, /30\/10\/2026/);
  assert.match(text, /Servicios/);
  assert.match(text, /Gasto fijo/);
  assert.match(text, /Confianza: 90%/);
  assert.match(text, /Consumo luz — \$ 12\.000/);
  assert.match(text, /⚠️/);
  assert.match(text, /Revisá los datos y confirmá/);
  assert.ok(text.length < 3000);
});

test('factura pendiente sin datos criticos', () => {
  const text = buildPendingDocumentMessage({
    document: { id: 'doc-2', fileName: 'foto.jpg', totalCents: null, extracted: {} },
    ...BASE,
  });
  assert.match(text, /No detectado/);
  assert.match(text, /Sin categoría/);
  assert.ok(!text.includes('undefined') && !text.includes('null'));
});

test('lista de categorias agrupada por tipo', () => {
  const text = buildCategoryListMessage({ categories: CATEGORIES, ...BASE });
  assert.match(text, /Supermercado/);
  assert.match(text, /Sueldo/);
  assert.match(text, /Inversiones/);
  assert.ok(text.length < 4000);
});
