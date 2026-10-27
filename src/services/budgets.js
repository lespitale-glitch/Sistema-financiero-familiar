/**
 * Presupuestos mensuales. Calcula el estado por categoria, los totales del mes
 * y los umbrales de alerta. Funciones puras, sin I/O.
 */

import { EXPENSE_TYPES } from '../domain.js';
import { percentOf } from '../utils/money.js';

const DEFAULT_THRESHOLDS = Object.freeze([80, 100]);
const DEFAULT_EMOJI = '🏷️';

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeThresholds(thresholds) {
  const source = Array.isArray(thresholds) ? thresholds : DEFAULT_THRESHOLDS;
  return source
    .map((value) => toNumber(value, NaN))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function normalizeBudgetCents(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function isConfirmed(transaction) {
  return !transaction.status || transaction.status === 'confirmed';
}

function isExpense(transaction) {
  return EXPENSE_TYPES.includes(transaction.type);
}

/**
 * Estado de un porcentaje frente a los umbrales configurados.
 * @param {number|null} percent
 * @param {number[]} [thresholds]
 * @returns {'exceeded'|'warning'|'ok'|'unbudgeted'}
 */
export function budgetStatus(percent, thresholds = DEFAULT_THRESHOLDS) {
  if (percent === null || percent === undefined || !Number.isFinite(Number(percent))) return 'unbudgeted';
  const value = Number(percent);
  if (value >= 100) return 'exceeded';
  const normalized = normalizeThresholds(thresholds);
  if (normalized.length > 0 && value >= normalized[0]) return 'warning';
  return 'ok';
}

function thresholdReached(percent, thresholds) {
  if (percent === null || percent === undefined) return null;
  let reached = null;
  for (const threshold of thresholds) {
    if (percent >= threshold) reached = threshold;
  }
  return reached;
}

/**
 * Construye el resumen de presupuesto del mes.
 * @param {{categories?: Array<object>, transactions?: Array<object>, overallBudgetCents?: number|null, thresholds?: number[]}} [input]
 */
export function buildBudgetSummary({
  categories = [],
  transactions = [],
  overallBudgetCents = null,
  thresholds = DEFAULT_THRESHOLDS,
} = {}) {
  const categoryList = Array.isArray(categories) ? categories : [];
  const transactionList = Array.isArray(transactions) ? transactions : [];
  const normalizedThresholds = normalizeThresholds(thresholds);
  const categoryIds = new Set(categoryList.map((category) => category && category.id).filter(Boolean));

  const expenseTransactions = transactionList.filter(
    (transaction) => transaction && isConfirmed(transaction) && isExpense(transaction),
  );

  const spentByCategory = new Map();
  for (const transaction of expenseTransactions) {
    const key = transaction.categoryId || null;
    spentByCategory.set(key, (spentByCategory.get(key) || 0) + toNumber(transaction.amountCents));
  }

  const overallCents = normalizeBudgetCents(overallBudgetCents);
  const rows = [];

  for (const category of categoryList) {
    if (!category || !EXPENSE_TYPES.includes(category.type)) continue;
    const budgetCents = normalizeBudgetCents(category.monthlyBudgetCents ?? category.budgetCents);
    const spentCents = toNumber(spentByCategory.get(category.id));
    if (!budgetCents && spentCents <= 0) continue;
    const percent = budgetCents ? percentOf(spentCents, budgetCents) : null;
    rows.push({
      categoryId: category.id ?? null,
      name: category.name || 'Sin nombre',
      emoji: category.emoji || DEFAULT_EMOJI,
      type: category.type,
      budgetCents,
      spentCents,
      remainingCents: budgetCents ? budgetCents - spentCents : null,
      percent,
      status: budgetStatus(percent, normalizedThresholds),
      thresholdReached: thresholdReached(percent, normalizedThresholds),
    });
  }

  rows.sort((a, b) => {
    const aBudgeted = a.budgetCents !== null ? 0 : 1;
    const bBudgeted = b.budgetCents !== null ? 0 : 1;
    if (aBudgeted !== bBudgeted) return aBudgeted - bBudgeted;
    const aPercent = a.percent ?? -1;
    const bPercent = b.percent ?? -1;
    if (bPercent !== aPercent) return bPercent - aPercent;
    return b.spentCents - a.spentCents;
  });

  const sumRowBudgets = rows.reduce((total, row) => total + (row.budgetCents || 0), 0);
  const spentCents = expenseTransactions.reduce((total, transaction) => total + toNumber(transaction.amountCents), 0);
  const budgetCents = overallCents ?? sumRowBudgets;
  const percent = budgetCents > 0 ? percentOf(spentCents, budgetCents) : null;

  const uncategorizedCents = expenseTransactions
    .filter((transaction) => !transaction.categoryId || !categoryIds.has(transaction.categoryId))
    .reduce((total, transaction) => total + toNumber(transaction.amountCents), 0);

  const overallPercent = overallCents ? percentOf(spentCents, overallCents) : null;

  return {
    rows,
    totals: {
      budgetCents,
      spentCents,
      remainingCents: budgetCents > 0 ? budgetCents - spentCents : null,
      percent,
      status: budgetStatus(percent, normalizedThresholds),
      hasBudget: budgetCents > 0,
    },
    overall: {
      configured: Boolean(overallCents),
      budgetCents: overallCents,
      spentCents,
      remainingCents: overallCents ? overallCents - spentCents : null,
      percent: overallPercent,
      status: budgetStatus(overallPercent, normalizedThresholds),
    },
    uncategorizedCents,
    thresholds: normalizedThresholds,
  };
}

/**
 * Genera las alertas de umbral alcanzadas por el resumen.
 * @param {{summary: object, thresholds?: number[], periodKey?: string, onlyCategoryId?: string|null, includeOverall?: boolean}} [input]
 */
export function evaluateBudgetAlerts({
  summary = null,
  thresholds = DEFAULT_THRESHOLDS,
  periodKey = '',
  onlyCategoryId = null,
  includeOverall = true,
} = {}) {
  if (!summary || typeof summary !== 'object') return [];

  const normalizedThresholds = normalizeThresholds(thresholds);
  const period = periodKey || summary.monthKey || '';
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const categoryAlerts = [];
  const overallAlerts = [];
  const seen = new Set();

  const push = (target, alert) => {
    if (!alert.key || seen.has(alert.key)) return;
    seen.add(alert.key);
    target.push(alert);
  };

  for (const row of rows) {
    if (onlyCategoryId !== null && onlyCategoryId !== undefined) {
      if (String(row.categoryId) !== String(onlyCategoryId)) continue;
    }
    const budgetCents = toNumber(row.budgetCents);
    if (budgetCents <= 0 || row.percent === null || row.percent === undefined) continue;
    for (const threshold of normalizedThresholds) {
      if (row.percent < threshold) continue;
      push(categoryAlerts, {
        key: `budget:${period}:category:${row.categoryId}:${threshold}`,
        scope: 'category',
        categoryId: row.categoryId ?? null,
        categoryName: row.name || 'Sin nombre',
        emoji: row.emoji || DEFAULT_EMOJI,
        threshold,
        percent: row.percent,
        spentCents: toNumber(row.spentCents),
        budgetCents,
        remainingCents: toNumber(row.remainingCents),
        periodKey: period,
      });
    }
  }

  const overall = summary.overall;
  if (includeOverall && overall && overall.configured && overall.percent !== null && overall.percent !== undefined) {
    const budgetCents = toNumber(overall.budgetCents);
    if (budgetCents > 0) {
      for (const threshold of normalizedThresholds) {
        if (overall.percent < threshold) continue;
        push(overallAlerts, {
          key: `budget:${period}:overall:${threshold}`,
          scope: 'overall',
          categoryId: null,
          categoryName: 'Presupuesto general',
          emoji: '🧮',
          threshold,
          percent: overall.percent,
          spentCents: toNumber(overall.spentCents),
          budgetCents,
          remainingCents: toNumber(overall.remainingCents),
          periodKey: period,
        });
      }
    }
  }

  categoryAlerts.sort((a, b) => a.threshold - b.threshold || b.percent - a.percent);
  overallAlerts.sort((a, b) => a.threshold - b.threshold);
  return [...categoryAlerts, ...overallAlerts];
}
