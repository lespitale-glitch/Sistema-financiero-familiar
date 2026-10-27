/**
 * Fixtures deterministas para los tests de parser, presupuestos y reportes.
 * No tocan la base ni el reloj real.
 */

import { DEFAULT_CATEGORIES, TRANSACTION_TYPES } from '../../src/domain.js';

export const NOW = new Date('2026-10-24T15:00:00.000Z');
export const MONTH_KEY = '2026-10';

const CATEGORY_IDS = {
  Supermercado: 'cat-super',
  Comida: 'cat-food',
  Transporte: 'cat-transport',
  Servicios: 'cat-services',
  Alquiler: 'cat-rent',
  Salud: 'cat-health',
  Educacion: 'cat-education',
  Entretenimiento: 'cat-fun',
  Hogar: 'cat-home',
  Sueldo: 'cat-salary',
  Freelance: 'cat-freelance',
  'Otros ingresos': 'cat-other-income',
  Ahorro: 'cat-savings',
  Inversiones: 'cat-investments',
  Otros: 'cat-other',
};

/** Categorias equivalentes a las que devuelve el repositorio. */
export const CATEGORIES = DEFAULT_CATEGORIES.map((definition) => ({
  id: CATEGORY_IDS[definition.name] || `cat-${definition.name.toLowerCase()}`,
  name: definition.name,
  type: definition.type,
  emoji: definition.emoji,
  monthlyBudgetCents: definition.budget === null || definition.budget === undefined
    ? null
    : definition.budget * 100,
  keywords: [...definition.keywords],
  active: true,
}));

export function categoryByName(name) {
  return CATEGORIES.find((category) => category.name === name) || null;
}

let transactionSequence = 0;

export function makeTransaction({
  id = null,
  categoryId = null,
  type = TRANSACTION_TYPES.VARIABLE_EXPENSE,
  amountCents = 0,
  status = 'confirmed',
  occurredAt = '2026-10-10T12:00:00.000Z',
  note = '',
  userId = null,
  currency = 'ARS',
  metadata = {},
} = {}) {
  transactionSequence += 1;
  return {
    id: id || `tx-${transactionSequence}`,
    userId,
    categoryId,
    type,
    amountCents,
    currency,
    note,
    source: 'text',
    status,
    occurredAt,
    createdAt: occurredAt,
    updatedAt: null,
    documentId: null,
    metadata,
  };
}

export function makeGoal({
  id = null,
  name = 'Meta',
  targetCents = 0,
  savedCents = 0,
  deadline = null,
  active = true,
} = {}) {
  return { id: id || `goal-${name}`, name, targetCents, savedCents, deadline, active };
}

/**
 * Agregados con la misma forma que repos.transactions.totals().
 */
export function buildTotals(transactions = []) {
  const byType = Object.fromEntries(Object.values(TRANSACTION_TYPES).map((type) => [type, 0]));
  const byCategory = new Map();
  const byUser = new Map();
  let incomeCents = 0;
  let expenseCents = 0;
  let investmentCents = 0;

  for (const transaction of transactions) {
    byType[transaction.type] = (byType[transaction.type] || 0) + transaction.amountCents;
    if (transaction.type === TRANSACTION_TYPES.INCOME) incomeCents += transaction.amountCents;
    else if (transaction.type === TRANSACTION_TYPES.INVESTMENT) investmentCents += transaction.amountCents;
    else expenseCents += transaction.amountCents;

    const categoryKey = transaction.categoryId || 'uncategorized';
    const categoryEntry = byCategory.get(categoryKey) || {
      categoryId: transaction.categoryId,
      type: transaction.type,
      totalCents: 0,
      count: 0,
    };
    categoryEntry.totalCents += transaction.amountCents;
    categoryEntry.count += 1;
    byCategory.set(categoryKey, categoryEntry);

    const userKey = transaction.userId || 'anonymous';
    const userEntry = byUser.get(userKey) || {
      userId: transaction.userId,
      totalCents: 0,
      count: 0,
      incomeCents: 0,
      expenseCents: 0,
      investmentCents: 0,
    };
    userEntry.totalCents += transaction.amountCents;
    userEntry.count += 1;
    if (transaction.type === TRANSACTION_TYPES.INCOME) userEntry.incomeCents += transaction.amountCents;
    else if (transaction.type === TRANSACTION_TYPES.INVESTMENT) userEntry.investmentCents += transaction.amountCents;
    else userEntry.expenseCents += transaction.amountCents;
    byUser.set(userKey, userEntry);
  }

  return {
    count: transactions.length,
    byType,
    byCategory: [...byCategory.values()].sort((a, b) => b.totalCents - a.totalCents),
    byUser: [...byUser.values()].sort((a, b) => b.totalCents - a.totalCents),
    incomeCents,
    expenseCents,
    investmentCents,
    balanceCents: incomeCents - expenseCents - investmentCents,
    transactions: [...transactions],
  };
}
