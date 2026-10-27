/**
 * Constructores de mensajes HTML para Telegram (parse_mode: HTML).
 * Todas las funciones son puras, escapan el texto dinamico y acotan la
 * longitud para no superar el limite de Telegram.
 */

import { EXPENSE_TYPES, TRANSACTION_TYPES, TYPE_LIST, TYPE_META } from '../domain.js';
import { formatCents } from '../utils/money.js';
import { monthLabel } from '../utils/dates.js';
import { escapeHtml, progressBar } from '../utils/telegram-html.js';

const MAX_MESSAGE = 3900;
const FALLBACK_EMOJI = '🏷️';

const TYPE_LABELS = Object.freeze({
  [TRANSACTION_TYPES.INCOME]: 'Ingreso',
  [TRANSACTION_TYPES.FIXED_EXPENSE]: 'Gasto fijo',
  [TRANSACTION_TYPES.VARIABLE_EXPENSE]: 'Gasto variable',
  [TRANSACTION_TYPES.INVESTMENT]: 'Inversión',
});

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function money(cents, currency, locale) {
  return formatCents(toNumber(cents), currency || 'ARS', locale || 'es-AR');
}

function truncate(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function safeEmoji(value) {
  return escapeHtml(value || FALLBACK_EMOJI);
}

function formatPercent(percent) {
  return percent === null || percent === undefined ? '—' : `${Math.round(Number(percent))}%`;
}

function finalize(lines, max = MAX_MESSAGE) {
  const text = lines
    .filter((line) => line !== null && line !== undefined)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length <= max) return text || 'Sin datos.';
  const kept = text.split('\n');
  while (kept.length > 1 && kept.join('\n').length > max) kept.pop();
  const clipped = kept.join('\n');
  if (clipped.length <= max) return `${clipped}\n…`;
  return `${clipped.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function readTotals(totals) {
  const source = totals && typeof totals === 'object' ? totals : {};
  const byType = source.byType && typeof source.byType === 'object' ? source.byType : {};
  const transactions = toArray(source.transactions).filter(
    (transaction) => transaction && typeof transaction === 'object',
  );

  const has = (value) => Number.isFinite(Number(value));
  const incomeCents = has(source.incomeCents) ? toNumber(source.incomeCents) : toNumber(byType.income);
  const expenseCents = has(source.expenseCents)
    ? toNumber(source.expenseCents)
    : toNumber(byType.fixed_expense) + toNumber(byType.variable_expense);
  const investmentCents = has(source.investmentCents) ? toNumber(source.investmentCents) : toNumber(byType.investment);
  const count = has(source.count) ? toNumber(source.count) : transactions.length;
  const balanceCents = has(source.balanceCents)
    ? toNumber(source.balanceCents)
    : incomeCents - expenseCents - investmentCents;

  return {
    ...source,
    byType,
    byCategory: toArray(source.byCategory),
    byUser: toArray(source.byUser),
    transactions,
    incomeCents,
    expenseCents,
    investmentCents,
    balanceCents,
    count,
  };
}

function categoryMapOf(categories) {
  const map = new Map();
  for (const category of toArray(categories)) {
    if (category && category.id) map.set(String(category.id), category);
  }
  return map;
}

function userMapOf(users) {
  const map = new Map();
  for (const user of toArray(users)) {
    if (user && user.id) map.set(String(user.id), user);
  }
  return map;
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

function formatFullDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

function formatDueDate(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (ymd) return `${ymd[3]}/${ymd[2]}/${ymd[1]}`;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(raw)) return raw;
  const formatted = formatFullDate(raw);
  return formatted || raw;
}

function expenseCategoryEntries(totals) {
  return totals.byCategory
    .filter((entry) => entry && EXPENSE_TYPES.includes(entry.type) && toNumber(entry.totalCents) > 0)
    .sort((a, b) => toNumber(b.totalCents) - toNumber(a.totalCents));
}

function expenseTransactionList(totals) {
  return totals.transactions.filter(
    (transaction) => EXPENSE_TYPES.includes(transaction.type) && transaction.status !== 'discarded',
  );
}

function netLabel(cents) {
  return cents >= 0 ? 'Ahorro neto' : 'Déficit';
}

/** Etiqueta humana del tipo de movimiento. */
export function formatTypeLabel(type) {
  return TYPE_LABELS[type] || 'Movimiento';
}

/** Titulo del mes: "Octubre 2026". */
export function formatMonthTitle(monthKey) {
  return monthLabel(monthKey) || '';
}

/**
 * Reporte de balance mensual.
 * @param {{monthKey?: string, totals?: object, budgetSummary?: object|null, currency?: string, locale?: string, userName?: string|null}} input
 */
export function buildBalanceReport({
  monthKey = null,
  totals = {},
  budgetSummary = null,
  currency = 'ARS',
  locale = 'es-AR',
  userName = null,
} = {}) {
  const data = readTotals(totals);
  const month = formatMonthTitle(monthKey);
  const lines = [`📊 <b>Balance${month ? ` · ${escapeHtml(month)}` : ''}</b>`];
  if (userName) lines.push(`Hola, ${escapeHtml(truncate(userName, 40))}`);
  lines.push('');

  const empty = data.count === 0 && data.incomeCents === 0 && data.expenseCents === 0 && data.investmentCents === 0;
  if (empty) {
    lines.push('No hay movimientos registrados este mes.');
  } else {
    lines.push(`💰 Ingresos: <b>${money(data.incomeCents, currency, locale)}</b>`);
    lines.push(`💸 Gastos: <b>${money(data.expenseCents, currency, locale)}</b>`);
    lines.push(`📈 Inversiones: <b>${money(data.investmentCents, currency, locale)}</b>`);
    lines.push('');
    lines.push(
      `${data.balanceCents >= 0 ? '🏦' : '🔻'} <b>${netLabel(data.balanceCents)}: ${money(Math.abs(data.balanceCents), currency, locale)}</b>`,
    );
    lines.push(`🧾 Movimientos: ${data.count}`);
  }

  const overall = budgetSummary?.overall;
  if (overall?.configured) {
    lines.push('');
    lines.push(
      `🧮 Presupuesto general: <b>${money(overall.spentCents, currency, locale)}</b> de ${money(overall.budgetCents, currency, locale)}${overall.percent !== null && overall.percent !== undefined ? ` · <b>${formatPercent(overall.percent)}</b>` : ''}`,
    );
  }

  return finalize(lines);
}

/**
 * Reporte de presupuestos por categoria.
 * @param {{monthKey?: string, budgetSummary?: object|null, currency?: string, locale?: string}} input
 */
export function buildBudgetReport({
  monthKey = null,
  budgetSummary = null,
  currency = 'ARS',
  locale = 'es-AR',
} = {}) {
  const summary = budgetSummary && typeof budgetSummary === 'object' ? budgetSummary : {};
  const rows = toArray(summary.rows);
  const budgeted = rows.filter((row) => toNumber(row.budgetCents) > 0);
  const unbudgeted = rows.filter((row) => !(toNumber(row.budgetCents) > 0) && toNumber(row.spentCents) > 0);
  const month = formatMonthTitle(monthKey);

  const lines = [`📊 <b>Presupuesto${month ? ` · ${escapeHtml(month)}` : ''}</b>`, ''];

  if (budgeted.length === 0) {
    lines.push('No hay presupuestos configurados para este mes.');
    lines.push('Configurá un límite por categoría con /presupuesto_set.');
  } else {
    const overall = summary.overall;
    if (overall?.configured) {
      const percent = overall.percent ?? 0;
      lines.push('<b>General</b>');
      lines.push(
        `${money(overall.spentCents, currency, locale)} de ${money(overall.budgetCents, currency, locale)} · <b>${formatPercent(percent)}</b>`,
      );
      lines.push(progressBar(percent));
      const remaining = toNumber(overall.remainingCents);
      lines.push(
        remaining >= 0
          ? `Quedan <b>${money(remaining, currency, locale)}</b>`
          : `Excedido por <b>${money(Math.abs(remaining), currency, locale)}</b>`,
      );
      lines.push('');
    }

    const visible = budgeted.slice(0, 12);
    for (const row of visible) {
      const percent = row.percent ?? 0;
      const remaining = row.remainingCents !== null && row.remainingCents !== undefined
        ? toNumber(row.remainingCents)
        : toNumber(row.budgetCents) - toNumber(row.spentCents);
      lines.push(`${safeEmoji(row.emoji)} <b>${escapeHtml(row.name || 'Sin nombre')}</b>`);
      lines.push(
        `${money(row.spentCents, currency, locale)} de ${money(row.budgetCents, currency, locale)} · <b>${formatPercent(percent)}</b>`,
      );
      lines.push(progressBar(percent));
      lines.push(
        remaining >= 0
          ? `Quedan ${money(remaining, currency, locale)}`
          : `Excedido por ${money(Math.abs(remaining), currency, locale)}`,
      );
      lines.push('');
    }
    if (budgeted.length > visible.length) {
      lines.push(`… y ${budgeted.length - visible.length} categorías más.`);
      lines.push('');
    }
  }

  if (unbudgeted.length > 0) {
    lines.push('<b>Sin presupuesto</b>');
    for (const row of unbudgeted.slice(0, 10)) {
      lines.push(`${safeEmoji(row.emoji)} ${escapeHtml(row.name || 'Sin nombre')}: ${money(row.spentCents, currency, locale)}`);
    }
    if (unbudgeted.length > 10) lines.push(`… y ${unbudgeted.length - 10} más.`);
  }

  return finalize(lines);
}

function findFilterCategory(categoryFilter, categories) {
  if (!categoryFilter) return null;
  if (typeof categoryFilter === 'object') {
    if (categoryFilter.id) {
      const byId = categories.find((category) => String(category.id) === String(categoryFilter.id));
      if (byId) return byId;
    }
    if (categoryFilter.name) {
      const target = String(categoryFilter.name).trim().toLowerCase();
      const byName = categories.find((category) => String(category.name).toLowerCase() === target);
      if (byName) return byName;
    }
    return categoryFilter;
  }
  const target = String(categoryFilter).trim().toLowerCase();
  const byName = categories.find((category) => String(category.name).toLowerCase() === target);
  if (byName) return byName;
  return categories.find((category) => String(category.id).toLowerCase() === target) || null;
}

/**
 * Reporte de gastos: top categorias o detalle de una categoria.
 * @param {{monthKey?: string, totals?: object, categories?: Array<object>, users?: Array<object>, currency?: string, locale?: string, limit?: number, categoryFilter?: string|object|null}} input
 */
export function buildExpensesReport({
  monthKey = null,
  totals = {},
  categories = [],
  users = [],
  currency = 'ARS',
  locale = 'es-AR',
  limit = 10,
  categoryFilter = null,
} = {}) {
  const data = readTotals(totals);
  const categoryList = toArray(categories);
  const categoryMap = categoryMapOf(categoryList);
  const userMap = userMapOf(users);
  const month = formatMonthTitle(monthKey);
  const max = Math.max(1, toNumber(limit, 10));
  const lines = [`🛒 <b>Gastos${month ? ` · ${escapeHtml(month)}` : ''}</b>`];

  const filterCategory = findFilterCategory(categoryFilter, categoryList);

  if (categoryFilter) {
    const filterName = filterCategory?.name || (typeof categoryFilter === 'string' ? categoryFilter : 'Categoría');
    const filterId = filterCategory?.id ?? null;
    const matches = expenseTransactionList(data)
      .filter((transaction) => {
        if (filterId !== null) return String(transaction.categoryId) === String(filterId);
        return false;
      })
      .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime());

    lines.push(`Categoría: ${filterCategory ? safeEmoji(filterCategory.emoji) : FALLBACK_EMOJI} <b>${escapeHtml(filterName)}</b>`, '');

    if (matches.length === 0) {
      lines.push('No hay gastos de esa categoría este mes.');
      return finalize(lines);
    }

    const shown = matches.slice(0, max);
    for (const transaction of shown) {
      const userName = transaction.userId ? userMap.get(String(transaction.userId))?.name || 'Familiar' : null;
      const parts = [
        formatShortDate(transaction.occurredAt),
        escapeHtml(truncate(transaction.note || 'Sin detalle', 50)),
      ];
      if (userName) parts.push(escapeHtml(truncate(userName, 24)));
      parts.push(`<b>${money(transaction.amountCents, currency, locale)}</b>`);
      lines.push(`• ${parts.filter(Boolean).join(' · ')}`);
    }
    if (matches.length > shown.length) lines.push(`… y ${matches.length - shown.length} movimientos más.`);

    const total = matches.reduce((sum, transaction) => sum + toNumber(transaction.amountCents), 0);
    lines.push('');
    lines.push(`Total: <b>${money(total, currency, locale)}</b> · ${matches.length} ${matches.length === 1 ? 'movimiento' : 'movimientos'}`);
    return finalize(lines);
  }

  const expenseTotal = data.expenseCents;
  const transactions = expenseTransactionList(data);
  if (expenseTotal === 0 && transactions.length === 0) {
    lines.push('', 'No hay gastos registrados este mes.');
    return finalize(lines);
  }

  lines.push(`Total: <b>${money(expenseTotal, currency, locale)}</b> · ${transactions.length || data.count} movimientos`, '');

  const entries = expenseCategoryEntries(data);
  if (entries.length > 0) {
    lines.push('🏷️ <b>Top categorías</b>');
    for (const entry of entries.slice(0, max)) {
      const category = categoryMap.get(String(entry.categoryId));
      const name = category?.name || 'Sin categoría';
      const emoji = category?.emoji || FALLBACK_EMOJI;
      const total = toNumber(entry.totalCents);
      const percent = expenseTotal > 0 ? Math.round((total / expenseTotal) * 100) : 0;
      lines.push(
        `${safeEmoji(emoji)} <b>${escapeHtml(name)}</b> · ${money(total, currency, locale)} · ${percent}% ${progressBar(percent, 6)}`,
      );
    }
    if (entries.length > max) lines.push(`… y ${entries.length - max} categorías más.`);
    lines.push('');
  }

  const userEntries = data.byUser
    .filter((entry) => entry && toNumber(entry.expenseCents) > 0)
    .sort((a, b) => toNumber(b.expenseCents) - toNumber(a.expenseCents));
  if (userEntries.length > 0) {
    lines.push('👥 <b>Por persona</b>');
    for (const entry of userEntries.slice(0, 8)) {
      const name = entry.userId ? userMap.get(String(entry.userId))?.name : null;
      lines.push(
        `${escapeHtml(truncate(name || 'Familiar', 24))}: <b>${money(entry.expenseCents, currency, locale)}</b> · ${toNumber(entry.count)} mov.`,
      );
    }
    if (userEntries.length > 8) lines.push(`… y ${userEntries.length - 8} personas más.`);
  }

  return finalize(lines);
}

/**
 * Reporte de inversiones y metas de ahorro.
 * @param {{monthKey?: string, totals?: object, goals?: Array<object>, currency?: string, locale?: string}} input
 */
export function buildInvestmentsReport({
  monthKey = null,
  totals = {},
  goals = [],
  currency = 'ARS',
  locale = 'es-AR',
} = {}) {
  const data = readTotals(totals);
  const month = formatMonthTitle(monthKey);
  const investmentTransactions = data.transactions.filter(
    (transaction) => transaction.type === TRANSACTION_TYPES.INVESTMENT && transaction.status !== 'discarded',
  );
  const goalList = toArray(goals).filter((goal) => goal && toNumber(goal.targetCents) > 0 && goal.active !== false);
  const lines = [`📈 <b>Inversiones${month ? ` · ${escapeHtml(month)}` : ''}</b>`, ''];

  if (data.investmentCents === 0 && investmentTransactions.length === 0) {
    lines.push('No hay inversiones registradas este mes.');
  } else {
    lines.push(`Invertido: <b>${money(data.investmentCents, currency, locale)}</b>`);
    if (investmentTransactions.length > 0) {
      lines.push(`Movimientos: ${investmentTransactions.length}`);
    }
  }

  if (goalList.length > 0) {
    lines.push('', '🎯 <b>Metas de ahorro</b>');
    const visible = goalList.slice(0, 10);
    for (const goal of visible) {
      const saved = toNumber(goal.savedCents);
      const target = toNumber(goal.targetCents);
      const percent = target > 0 ? Math.round((saved / target) * 100) : 0;
      lines.push(`<b>${escapeHtml(truncate(goal.name || 'Meta', 40))}</b>`);
      lines.push(`${money(saved, currency, locale)} de ${money(target, currency, locale)} · <b>${percent}%</b>`);
      lines.push(progressBar(percent));
      if (goal.deadline) {
        lines.push(`📅 ${escapeHtml(formatDueDate(goal.deadline))}`);
      }
      lines.push('');
    }
    if (goalList.length > visible.length) lines.push(`… y ${goalList.length - visible.length} metas más.`);
  } else {
    lines.push('', 'Creá una meta de ahorro con /meta.');
  }

  return finalize(lines);
}

/**
 * Resumen generico (diario, semanal o mensual).
 * @param {{title?: string, monthKey?: string|null, rangeLabel?: string|null, totals?: object, budgetSummary?: object|null, categories?: Array<object>, goals?: Array<object>, currency?: string, locale?: string}} input
 */
export function buildSummaryMessage({
  title = 'Resumen',
  monthKey = null,
  rangeLabel = null,
  totals = {},
  budgetSummary = null,
  categories = [],
  goals = [],
  currency = 'ARS',
  locale = 'es-AR',
} = {}) {
  const data = readTotals(totals);
  const month = formatMonthTitle(monthKey);
  const headerParts = [escapeHtml(truncate(title || 'Resumen', 60))];
  if (month) headerParts.push(escapeHtml(month));
  if (rangeLabel) headerParts.push(escapeHtml(truncate(rangeLabel, 50)));
  const lines = [`📊 <b>${headerParts.join(' · ')}</b>`, ''];

  const empty = data.count === 0 && data.incomeCents === 0 && data.expenseCents === 0 && data.investmentCents === 0;
  if (empty) {
    lines.push('No hay movimientos en este período.');
    return finalize(lines);
  }

  lines.push(`💰 Ingresos: <b>${money(data.incomeCents, currency, locale)}</b>`);
  lines.push(`💸 Gastos: <b>${money(data.expenseCents, currency, locale)}</b>`);
  lines.push(`📈 Inversiones: <b>${money(data.investmentCents, currency, locale)}</b>`);
  lines.push(
    `${data.balanceCents >= 0 ? '🏦' : '🔻'} <b>${netLabel(data.balanceCents)}: ${money(Math.abs(data.balanceCents), currency, locale)}</b>`,
  );
  lines.push(`🧾 Movimientos: ${data.count}`, '');

  const categoryMap = categoryMapOf(categories);
  const topCategories = expenseCategoryEntries(data).slice(0, 3);
  if (topCategories.length > 0) {
    lines.push('🏷️ <b>Top categorías</b>');
    for (const entry of topCategories) {
      const category = categoryMap.get(String(entry.categoryId));
      const name = category?.name || 'Sin categoría';
      const percent = data.expenseCents > 0 ? Math.round((toNumber(entry.totalCents) / data.expenseCents) * 100) : 0;
      lines.push(
        `${safeEmoji(category?.emoji)} ${escapeHtml(name)}: ${money(entry.totalCents, currency, locale)} · ${percent}%`,
      );
    }
    lines.push('');
  }

  const overall = budgetSummary?.overall;
  if (overall?.configured) {
    const percent = overall.percent ?? 0;
    lines.push(
      `🧮 Presupuesto: <b>${money(overall.spentCents, currency, locale)}</b> de ${money(overall.budgetCents, currency, locale)} · ${formatPercent(percent)} ${progressBar(percent, 8)}`,
    );
    const warningRows = toArray(budgetSummary.rows)
      .filter((row) => toNumber(row.budgetCents) > 0 && toNumber(row.percent) >= 80)
      .sort((a, b) => toNumber(b.percent) - toNumber(a.percent))
      .slice(0, 4);
    for (const row of warningRows) {
      lines.push(
        `⚠️ ${safeEmoji(row.emoji)} ${escapeHtml(row.name || 'Sin nombre')}: <b>${formatPercent(row.percent)}</b>`,
      );
    }
    lines.push('');
  }

  const goalList = toArray(goals).filter((goal) => goal && toNumber(goal.targetCents) > 0 && goal.active !== false);
  if (goalList.length > 0) {
    lines.push('🎯 <b>Metas</b>');
    for (const goal of goalList.slice(0, 3)) {
      const saved = toNumber(goal.savedCents);
      const target = toNumber(goal.targetCents);
      const percent = target > 0 ? Math.round((saved / target) * 100) : 0;
      lines.push(
        `${escapeHtml(truncate(goal.name || 'Meta', 36))}: ${money(saved, currency, locale)} de ${money(target, currency, locale)} (${percent}%)`,
      );
    }
    if (goalList.length > 3) lines.push(`… y ${goalList.length - 3} metas más.`);
  }

  return finalize(lines);
}

/**
 * Confirmacion de un movimiento registrado.
 * @param {{transaction?: object, category?: object|null, user?: object|null, budgetSummary?: object|null, currency?: string, locale?: string}} input
 */
export function buildTransactionConfirmation({
  transaction = null,
  category = null,
  user = null,
  budgetSummary = null,
  currency = 'ARS',
  locale = 'es-AR',
} = {}) {
  const lines = ['✅ <b>Movimiento registrado</b>', ''];
  if (!transaction || typeof transaction !== 'object') {
    lines.push('No se pudo leer el movimiento.');
    return finalize(lines);
  }

  const type = transaction.type;
  const meta = TYPE_META[type] || {};
  const sign = type === TRANSACTION_TYPES.INCOME ? '+' : '-';
  const emoji = meta.emoji || '🏷️';
  const label = formatTypeLabel(type);
  const amount = `${sign}${money(Math.abs(toNumber(transaction.amountCents)), currency, locale)}`;

  lines.push(`${emoji} <b>${escapeHtml(label)}</b> · <b>${amount}</b>`);

  const categoryName = category?.name || 'Sin categoría';
  const categoryEmoji = category?.emoji || FALLBACK_EMOJI;
  lines.push(`Categoría: ${safeEmoji(categoryEmoji)} ${escapeHtml(truncate(categoryName, 40))}`);

  if (transaction.note) {
    lines.push(`Nota: ${escapeHtml(truncate(transaction.note, 120))}`);
  }
  if (user?.name) {
    lines.push(`Usuario: ${escapeHtml(truncate(user.name, 40))}`);
  }
  const date = formatFullDate(transaction.occurredAt);
  if (date) lines.push(`Fecha: ${date}`);

  const rows = toArray(budgetSummary?.rows);
  const budgetRow = transaction.categoryId !== null && transaction.categoryId !== undefined
    ? rows.find((row) => String(row.categoryId) === String(transaction.categoryId))
    : null;
  if (budgetRow && toNumber(budgetRow.budgetCents) > 0 && budgetRow.percent !== null && budgetRow.percent !== undefined) {
    lines.push(
      '',
      `Presupuesto: <b>${formatPercent(budgetRow.percent)}</b> (${money(budgetRow.spentCents, currency, locale)} de ${money(budgetRow.budgetCents, currency, locale)})`,
    );
  }

  return finalize(lines);
}

/**
 * Mensaje de factura pendiente de confirmacion.
 * @param {{document?: object, extraction?: object|null, category?: object|null, currency?: string, locale?: string}} input
 */
export function buildPendingDocumentMessage({
  document = null,
  extraction = null,
  category = null,
  currency = 'ARS',
  locale = 'es-AR',
} = {}) {
  const doc = document && typeof document === 'object' ? document : {};
  const ext = extraction && typeof extraction === 'object'
    ? extraction
    : (doc.extracted && typeof doc.extracted === 'object' ? doc.extracted : {});

  const lines = ['🧾 <b>Factura detectada</b>', ''];

  const vendor = doc.vendor || ext.vendor || doc.fileName || 'Documento sin nombre';
  lines.push(`<b>${escapeHtml(truncate(vendor, 60))}</b>`);

  const totalCents = ext.totalCents ?? doc.totalCents;
  lines.push(`Total: <b>${totalCents === null || totalCents === undefined ? 'No detectado' : money(totalCents, currency, locale)}</b>`);

  const due = ext.dueDate ?? doc.dueDate;
  if (due) lines.push(`Vencimiento: ${escapeHtml(formatDueDate(due) || '')}`);

  const categoryName = category?.name || ext.categoryName || 'Sin categoría';
  const categoryEmoji = category?.emoji || FALLBACK_EMOJI;
  lines.push(`Categoría: ${safeEmoji(categoryEmoji)} ${escapeHtml(truncate(categoryName, 40))}`);

  const type = ext.type || doc.type || TRANSACTION_TYPES.VARIABLE_EXPENSE;
  lines.push(`Tipo: ${escapeHtml(formatTypeLabel(type))}`);

  const rawConfidence = ext.confidence ?? doc.confidence;
  if (Number.isFinite(Number(rawConfidence))) {
    const numeric = Number(rawConfidence);
    const percent = Math.round(Math.min(100, Math.max(0, numeric <= 1 ? numeric * 100 : numeric)));
    lines.push(`Confianza: ${percent}%`);
  }

  const items = toArray(ext.items || ext.lineItems || ext.products);
  if (items.length > 0) {
    lines.push('', '<b>Detalle</b>');
    for (const item of items.slice(0, 5)) {
      if (typeof item === 'string') {
        lines.push(`• ${escapeHtml(truncate(item, 70))}`);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const description = item.description || item.name || item.detail || item.label || 'Ítem';
      const itemCents = item.totalCents ?? item.amountCents;
      const detail = itemCents === null || itemCents === undefined
        ? escapeHtml(truncate(description, 60))
        : `${escapeHtml(truncate(description, 50))} — ${money(itemCents, currency, locale)}`;
      lines.push(`• ${detail}`);
    }
    if (items.length > 5) lines.push(`… y ${items.length - 5} ítems más.`);
  }

  const warnings = toArray(ext.warnings);
  if (warnings.length > 0) {
    lines.push('');
    for (const warning of warnings.slice(0, 3)) {
      lines.push(`⚠️ ${escapeHtml(truncate(warning, 90))}`);
    }
  }

  lines.push('', 'Revisá los datos y confirmá.');
  return finalize(lines);
}

/**
 * Lista de categorias agrupadas por tipo.
 * @param {{categories?: Array<object>, currency?: string, locale?: string}} input
 */
export function buildCategoryListMessage({
  categories = [],
  currency = 'ARS',
  locale = 'es-AR',
} = {}) {
  const list = toArray(categories);
  const lines = ['🏷️ <b>Categorías</b>', ''];
  if (list.length === 0) {
    lines.push('No hay categorías. Creá una con /categoria_nueva.');
    return finalize(lines);
  }

  let count = 0;
  for (const type of TYPE_LIST) {
    const group = list.filter((category) => category && category.type === type);
    if (group.length === 0) continue;
    lines.push(`<b>${escapeHtml(formatTypeLabel(type))}</b>`);
    for (const category of group) {
      if (count >= 40) break;
      const budget = toNumber(category.monthlyBudgetCents) > 0
        ? ` · ${money(category.monthlyBudgetCents, currency, locale)}`
        : '';
      lines.push(`${safeEmoji(category.emoji)} ${escapeHtml(truncate(category.name || 'Sin nombre', 36))}${budget}`);
      count += 1;
    }
    lines.push('');
  }
  if (count >= 40 && list.length > 40) lines.push(`… y ${list.length - 40} categorías más.`);
  return finalize(lines);
}
