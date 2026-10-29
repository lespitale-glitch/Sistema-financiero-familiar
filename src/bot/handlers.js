/**
 * Manejadores del bot de Telegram.
 *
 * Todos los handlers exportados tienen la firma `(ctx, deps)` y estan
 * envueltos con `safe()`: cualquier excepcion se registra en el logger y se
 * responde un mensaje generico, sin filtrar detalles internos.
 *
 * deps = { config, repos, services, logger, notifier, clock? }
 * services = { users, transactions, alerts, ocr }
 */

import {
  TELEGRAM_SAFE_MESSAGE,
  TRANSACTION_TYPES,
  TYPE_META,
} from '../domain.js';
import { familyTitle } from '../config.js';
import {
  formatCents,
  parseAmountToCents,
  percentOf,
} from '../utils/money.js';
import {
  formatDate,
  monthKey,
  monthLabel,
  monthRange,
  resolveMonthKey,
} from '../utils/dates.js';
import {
  clampMessage,
  escapeHtml,
  progressBar,
} from '../utils/telegram-html.js';
import {
  documentKeyboard,
  parseDocumentCallback,
  parseTransactionCallback,
  restoreKeyboard,
  transactionKeyboard,
} from './keyboards.js';
import { parseBillCallback, parseBillCommand } from '../services/bills.js';
import {
  hasMoneySignal,
  matchCategory,
  parseBudgetUpdate,
  parseCategoryCreation,
  parseContribution,
  parseGoalCreation,
  parseTransactionArgs,
  parseTransactionMessage,
} from '../services/parser.js';
import {
  buildBalanceReport,
  buildBudgetReport,
  buildExpensesReport,
  buildInvestmentsReport,
  buildPendingDocumentMessage,
  buildSummaryMessage,
  buildTransactionConfirmation,
} from '../services/reports.js';

const HTML_OPTS = Object.freeze({ parse_mode: 'HTML', disable_web_page_preview: true });
const MAX_RECENT = 30;
const MAX_INCOME_LINES = 10;
const TYPE_ORDER = ['income', 'fixed_expense', 'variable_expense', 'investment'];

/** Fecha "ahora" segun el reloj inyectado. */
function now(deps) {
  return typeof deps?.clock === 'function' ? deps.clock() : new Date();
}

function tzOf(deps) {
  return deps.config.app.timezone;
}

function currencyOf(deps) {
  return deps.config.app.currency;
}

function localeOf(deps) {
  return deps.config.app.locale;
}

/** Normaliza texto para comparar nombres sin acentos ni mayusculas. */
function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function categoryEmoji(category) {
  return category?.emoji || '🏷️';
}

function categoryNameOf(category) {
  return category?.name || 'Sin categoría';
}

/** Busca una categoria por nombre exacto y luego por coincidencia parcial. */
function findCategoryByName(categories, name) {
  const target = normalize(name).replace(/^#/, '');
  if (!target) return null;
  const list = Array.isArray(categories) ? categories : [];
  return (
    list.find((category) => normalize(category.name) === target)
    || list.find((category) => normalize(category.name).includes(target))
    || list.find((category) => target.includes(normalize(category.name)))
    || null
  );
}

/** Responde en HTML, recortando el texto al limite seguro de Telegram. */
async function replyHtml(ctx, html, extra = {}) {
  const text = clampMessage(html, TELEGRAM_SAFE_MESSAGE);
  return ctx.reply(text, { ...HTML_OPTS, ...extra });
}

/** Edita el mensaje actual (callback) con fallback a reply. */
async function editHtml(ctx, deps, html, extra = {}) {
  const text = clampMessage(html, TELEGRAM_SAFE_MESSAGE);
  if (typeof ctx.editMessageText === 'function') {
    try {
      return await ctx.editMessageText(text, { ...HTML_OPTS, ...extra });
    } catch (error) {
      deps?.logger?.warn?.('no se pudo editar el mensaje, se envia uno nuevo', { error: error?.message });
    }
  }
  return replyHtml(ctx, text, extra);
}

/** Contesta un callback sin romper si Telegram ya expiro la query. */
async function answerCallback(ctx, text, extra = {}) {
  if (typeof ctx.answerCbQuery !== 'function') return undefined;
  try {
    return await ctx.answerCbQuery(text, extra);
  } catch {
    return undefined;
  }
}

/**
 * Envuelve un handler con manejo de errores. Nunca deja escapar excepciones.
 */
function safe(name, fn) {
  return async function safeHandler(ctx, deps) {
    try {
      return await fn(ctx, deps);
    } catch (error) {
      deps?.logger?.error?.(`error en el handler ${name}`, {
        error,
        updateType: ctx?.updateType,
        chatId: ctx?.chat?.id,
      });
      try {
        await replyHtml(ctx, '❌ Ocurrió un error inesperado. Probá de nuevo en unos segundos.');
      } catch {
        // si ni siquiera se puede responder, no hay nada mas que hacer
      }
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Presupuestos: helpers tolerantes al formato de budgets.js
// ---------------------------------------------------------------------------

/** Extrae la lista de filas de presupuesto desde el summary del servicio. */
function summaryRows(summary) {
  if (!summary || typeof summary !== 'object') return [];
  for (const key of ['rows', 'categories', 'byCategory', 'items', 'budgetRows', 'details']) {
    if (Array.isArray(summary[key])) return summary[key];
  }
  return [];
}

function firstNumber(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Normaliza una fila de presupuesto a un shape estable. */
function normalizeBudgetRow(row) {
  if (!row || typeof row !== 'object') return null;
  const budgetCents = firstNumber(row, ['budgetCents', 'budget_cents', 'limitCents', 'budget']);
  const spentCents = firstNumber(row, ['spentCents', 'spent_cents', 'spent', 'totalCents', 'total']) ?? 0;
  const categoryName = row.categoryName ?? row.name ?? row.category ?? row.label ?? null;
  if (budgetCents === null && categoryName === null) return null;
  const percent = firstNumber(row, ['percent', 'percentage', 'usagePercent'])
    ?? percentOf(spentCents, budgetCents)
    ?? 0;
  return {
    categoryId: row.categoryId ?? row.category_id ?? row.id ?? null,
    categoryName,
    emoji: row.emoji || '🏷️',
    budgetCents,
    spentCents,
    remainingCents: firstNumber(row, ['remainingCents', 'remaining_cents', 'remaining'])
      ?? (budgetCents === null ? null : budgetCents - spentCents),
    percent,
  };
}

/** Busca la fila de presupuesto de una categoria dentro del summary. */
function findBudgetRow(summary, { categoryId = null, categoryName = null } = {}) {
  const rows = summaryRows(summary).map(normalizeBudgetRow).filter(Boolean);
  if (categoryId) {
    const byId = rows.find((row) => row.categoryId === categoryId);
    if (byId) return byId;
  }
  if (categoryName) {
    const target = normalize(categoryName);
    const byName = rows.find((row) => row.categoryName && normalize(row.categoryName) === target);
    if (byName) return byName;
  }
  return null;
}

/** Linea de progreso de presupuesto para una fila del summary. */
function budgetLine(row, deps) {
  if (!row || !row.budgetCents || row.budgetCents <= 0) return '';
  const percent = row.percent ?? percentOf(row.spentCents, row.budgetCents) ?? 0;
  return [
    `<b>📊 Presupuesto ${categoryEmoji(row)} ${escapeHtml(row.categoryName || 'General')}</b>`,
    `${progressBar(percent)} <b>${percent}%</b> · ${formatCents(row.spentCents, currencyOf(deps), localeOf(deps))} de ${formatCents(row.budgetCents, currencyOf(deps), localeOf(deps))}`,
  ].join('\n');
}

/** Bloque extra (presupuesto + alerta) para confirmaciones de movimientos. */
function budgetBlock(summary, result, deps) {
  const lines = [];
  const row = findBudgetRow(summary, {
    categoryId: result?.category?.id || result?.transaction?.categoryId,
    categoryName: result?.category?.name,
  });
  const line = budgetLine(row, deps);
  if (line) lines.push('', line);

  const categoryId = result?.category?.id || result?.transaction?.categoryId;
  const exceeded = (result?.alerts || []).find((alert) =>
    alert && (alert.scope === 'overall' || (categoryId && alert.categoryId === categoryId) || !alert.categoryId));
  if (exceeded) {
    const name = exceeded.categoryName || result?.category?.name;
    lines.push(`⚠️ Superaste el presupuesto de ${escapeHtml(name || 'la categoría')}`);
  }
  return lines.join('\n');
}

/** Carga el summary de presupuesto del mes del movimiento. */
async function loadSummaryFor(deps, transaction) {
  const reference = transaction?.occurredAt ? new Date(transaction.occurredAt) : now(deps);
  const key = monthKey(reference, tzOf(deps));
  try {
    const snapshot = await deps.services.alerts.getSummary(key);
    return snapshot?.summary || null;
  } catch (error) {
    deps.logger?.warn?.('no se pudo cargar el resumen de presupuesto', { error: error?.message });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Creacion de movimientos
// ---------------------------------------------------------------------------

/**
 * Crea un movimiento desde un resultado del parser y devuelve el texto de
 * confirmacion con la linea de presupuesto y la alerta (si corresponde).
 */
async function createFromParsed(ctx, deps, parsed, { source = 'text', metadata = {} } = {}) {
  const user = ctx.state?.user || null;
  let result;
  try {
    result = await createParsedTransaction(deps, user, parsed, { source, metadata });
  } catch (error) {
    if (error?.code !== 'FX_UNAVAILABLE') throw error;
    return {
      result: null,
      summary: null,
      keyboard: null,
      text: [
        `💱 ${escapeHtml(error.message)}`,
        '',
        'Ejemplo en pesos: <code>Gasté 15.000 en Netflix</code>',
      ].join('\n'),
    };
  }
  return confirmationFor(deps, user, result);
}

async function createParsedTransaction(deps, user, parsed, { source, metadata }) {
  return deps.services.transactions.create({
    user,
    type: parsed.type,
    amountCents: parsed.amountCents,
    currency: parsed.currency || currencyOf(deps),
    category: parsed.category?.name || parsed.categoryName || (typeof parsed.category === 'string' ? parsed.category : null),
    note: parsed.note || '',
    source,
    occurredAt: parsed.occurredAt || now(deps),
    metadata: {
      ...metadata,
      raw: metadata.raw ?? parsed.raw,
      ...(parsed.tags?.length ? { tags: parsed.tags } : {}),
    },
  });
}

async function confirmationFor(deps, user, result) {
  const summary = result.alertResult?.summary || await loadSummaryFor(deps, result.transaction);
  let text = buildTransactionConfirmation({
    transaction: result.transaction,
    category: result.category,
    user,
    budgetSummary: summary,
    currency: currencyOf(deps),
    locale: localeOf(deps),
  });
  if (!/registrad/i.test(String(text))) {
    text += '\n\n✅ <b>Movimiento registrado</b>';
  }
  text += budgetBlock(summary, result, deps);
  const keyboard = result?.transaction?.id ? transactionKeyboard(result.transaction.id) : null;
  return { result, text, summary, keyboard };
}

/** Mensaje de ayuda cuando el parser no pudo interpretar el texto. */
function parseHint(parsed, example) {
  if (parsed?.reason === 'negative-amount') {
    return [
      '⚠️ No registro montos negativos.',
      'Para anular un movimiento que quedó mal usá /borrar.',
    ].join('\n');
  }
  const reason = parsed?.reason ? ` (${parsed.reason})` : '';
  return [
    `🤔 No pude interpretar el movimiento${escapeHtml(reason)}.`,
    'Probá con un monto claro, por ejemplo:',
    `<code>${escapeHtml(example)}</code>`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// /start, /ayuda, /id
// ---------------------------------------------------------------------------

export const handleStart = safe('start', async (ctx, deps) => {
  const user = ctx.state?.user;
  const name = user?.name || ctx.from?.first_name || 'familia';
  const role = deps.services.users.userLabel(user);
  const ocrStatus = deps.services.ocr?.enabled
    ? '✅ OCR de facturas y transcripción de voz activos (Gemini).'
    : '⚠️ OCR y voz desactivados: configurá <code>GEMINI_API_KEY</code> para usarlos.';
  const lines = [
    `👋 ¡Hola, <b>${escapeHtml(name)}</b>!`,
    '',
    `Soy el bot de <b>${escapeHtml(familyTitle(deps.config))}</b>.`,
    `Te tengo registrado como <b>${escapeHtml(role)}</b>.`,
    '',
    '💰 <b>Registrá un movimiento escribiendo o con comandos</b>',
    '• <code>Gasté 15.000 en el super #comida</code>',
    '• <code>/gasto 15000 super #comida</code>',
    '• <code>/ingreso 250000 sueldo</code>',
    '• <code>/inversion 50000 plazo fijo</code>',
    '',
    '📊 <b>Consultas rápidas</b>',
    '• /balance · /presupuesto · /gastos · /reporte',
    '• /metas · /inversiones · /movimientos',
    '',
    '📸 También podés enviar una foto de una factura o un audio con el gasto.',
    '',
    ocrStatus,
    '',
    'Escribí /ayuda para ver todos los comandos.',
  ];
  await replyHtml(ctx, lines.join('\n'));
});

export const handleHelp = safe('help', async (ctx, deps) => {
  const lines = [
    '🤖 <b>Comandos disponibles</b>',
    '',
    '<b>Movimientos</b>',
    '• /gasto <code>&lt;monto&gt; &lt;categoría|#tag&gt; [nota]</code>',
    '• /ingreso <code>&lt;monto&gt; [categoría] [nota]</code>',
    '• /inversion <code>&lt;monto&gt; [categoría] [nota]</code>',
    '• /movimientos <code>[n]</code> — últimos movimientos (numerados)',
    '• /borrar <code>[número]</code> — borrar un movimiento cargado por error',
    '• Enviá texto libre: <code>Gasté 15.000 en el super #comida</code>',
    '• Enviá una foto de factura o un audio con el gasto',
    '',
    '<b>Consultas</b>',
    '• /balance <code>[mes]</code> — ingresos, gastos y balance',
    '• /presupuesto <code>[mes]</code> — estado de presupuestos',
    '• /gastos <code>[mes] [categoría|#tag]</code> — detalle de gastos',
    '• /ingresos <code>[mes]</code> — detalle de ingresos',
    '• /inversiones <code>[mes]</code> — inversiones y ahorro',
    '• /reporte <code>[mes]</code> — resumen completo del mes',
    '• /alertas — evaluar umbrales del mes actual',
    '',
    '<b>Categorías y presupuestos</b>',
    '• /categorias — listar categorías activas',
    '• /nueva_categoria <code>Nombre | tipo | presupuesto</code>',
    '• /presupuesto_set <code>&lt;categoría|general&gt; &lt;monto&gt;</code>',
    '',
    '<b>Vencimientos</b>',
    '• /vencimientos — lo que hay que pagar (con botones de pagado)',
    '• /vence <code>&lt;fecha&gt; [monto] &lt;nombre&gt; [#mensual]</code>',
    '• /pagado <code>&lt;número&gt;</code> — marcar como pagado',
    '• Las fotos/PDF de facturas con vencimiento se agendan solas',
    '',
    '<b>Metas</b>',
    '• /metas — listar metas y progreso',
    '• /meta <code>&lt;nombre&gt; &lt;objetivo&gt; [fecha]</code>',
    '• /aportar <code>&lt;meta&gt; &lt;monto&gt;</code>',
    '',
    '<b>Documentos y utilidades</b>',
    '• /corregir <code>&lt;monto&gt; [categoría] [nota]</code> — corregir factura pendiente',
    '• /exportar <code>[mes]</code> — CSV de movimientos',
    '• /id — tus datos de Telegram',
    '• /ayuda — esta ayuda',
    '',
    '💡 Los meses se pueden escribir como <code>2026-03</code>, <code>marzo</code>, <code>marzo 2026</code>, <code>mes pasado</code> o <code>actual</code>.',
  ];
  await replyHtml(ctx, lines.join('\n'));
});

export const handleId = safe('id', async (ctx, deps) => {
  const user = ctx.state?.user || null;
  const lines = [
    '🪪 <b>Tus datos</b>',
    '',
    `Telegram ID: <code>${escapeHtml(ctx.from?.id ?? '-')}</code>`,
    `Chat ID: <code>${escapeHtml(ctx.chat?.id ?? '-')}</code>`,
    `Usuario guardado: <code>${escapeHtml(user?.id || 'sin registrar')}</code>`,
    `Nombre: <b>${escapeHtml(user?.name || ctx.from?.first_name || 'Familiar')}</b>`,
    `Rol: <b>${escapeHtml(user ? deps.services.users.userLabel(user) : 'sin rol')}</b>`,
    '',
    'Para habilitar a alguien, agregá su Telegram ID en <code>FAMILY_MEMBERS</code>:',
    '<code>Nombre|rol|' + escapeHtml(ctx.from?.id ?? '123456789') + '|email</code>',
  ];
  await replyHtml(ctx, lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Consultas por mes
// ---------------------------------------------------------------------------

/** Resuelve el mes del payload. Devuelve null si el texto es invalido. */
function monthKeyFromPayload(ctx, deps) {
  const raw = String(ctx.payload || '').trim();
  return resolveMonthKey(raw, now(deps), tzOf(deps));
}

async function replyInvalidMonth(ctx, deps, raw) {
  await replyHtml(ctx, [
    `📅 No entendí el mes <b>${escapeHtml(raw)}</b>.`,
    '',
    'Probá con <code>2026-03</code>, <code>marzo</code>, <code>marzo 2026</code>, <code>mes pasado</code> o <code>actual</code>.',
  ].join('\n'));
}

export const handleBalance = safe('balance', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const key = monthKeyFromPayload(ctx, deps);
  if (!key) {
    await replyInvalidMonth(ctx, deps, raw);
    return;
  }
  const range = monthRange(key, tzOf(deps));
  const totals = await deps.repos.transactions.totals({ from: range.start, to: range.end });
  const snapshot = await deps.services.alerts.getSummary(key);
  const text = buildBalanceReport({
    monthKey: key,
    totals,
    budgetSummary: snapshot?.summary || null,
    currency: currencyOf(deps),
    locale: localeOf(deps),
    userName: ctx.state?.user?.name || null,
  });
  await replyHtml(ctx, text);
});

export const handleBudget = safe('presupuesto', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const key = monthKeyFromPayload(ctx, deps);
  if (!key) {
    await replyInvalidMonth(ctx, deps, raw);
    return;
  }
  const snapshot = await deps.services.alerts.getSummary(key);
  let text = buildBudgetReport({
    monthKey: key,
    budgetSummary: snapshot?.summary || null,
    currency: currencyOf(deps),
    locale: localeOf(deps),
  });
  if (!deps.config.alerts.enabled) {
    text += '\n\n🔕 Las alertas automáticas están desactivadas (<code>ALERTS_ENABLED=false</code>).';
  }
  await replyHtml(ctx, text);
});

export const handleExpenses = safe('gastos', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const categories = await deps.repos.categories.list();
  const tokens = raw.split(/\s+/).filter(Boolean);

  let key = monthKey(now(deps), tzOf(deps));
  if (tokens.length) {
    const candidate = tokens[0];
    const asMonth = resolveMonthKey(candidate, now(deps), tzOf(deps));
    const isCategory = candidate.startsWith('#') || Boolean(findCategoryByName(categories, candidate));
    if (asMonth && !isCategory) {
      key = asMonth;
      tokens.shift();
    }
  }

  const filterText = tokens.join(' ').replace(/^#/, '').trim();
  let categoryFilter = null;
  if (filterText) {
    categoryFilter = findCategoryByName(categories, filterText);
    if (!categoryFilter) {
      const names = categories.map((category) => `${categoryEmoji(category)} ${category.name}`).join(', ');
      await replyHtml(ctx, [
        `🔎 No encontré la categoría <b>${escapeHtml(filterText)}</b>.`,
        '',
        `Categorías disponibles: ${escapeHtml(names)}`,
      ].join('\n'));
      return;
    }
  }

  const range = monthRange(key, tzOf(deps));
  const [totals, users] = await Promise.all([
    deps.repos.transactions.totals({ from: range.start, to: range.end }),
    deps.repos.users.list(),
  ]);

  const text = buildExpensesReport({
    monthKey: key,
    totals,
    categories,
    users,
    currency: currencyOf(deps),
    locale: localeOf(deps),
    limit: 10,
    categoryFilter: categoryFilter?.id ? categoryFilter : null,
  });
  await replyHtml(ctx, text);
});

export const handleIncome = safe('ingresos', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const key = monthKeyFromPayload(ctx, deps);
  if (!key) {
    await replyInvalidMonth(ctx, deps, raw);
    return;
  }
  const range = monthRange(key, tzOf(deps));
  const [totals, categories, users] = await Promise.all([
    deps.repos.transactions.totals({ from: range.start, to: range.end }),
    deps.repos.categories.list({ includeInactive: true }),
    deps.repos.users.list({ includeInactive: true }),
  ]);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const userMap = new Map(users.map((user) => [user.id, user.name]));
  const incomes = totals.transactions
    .filter((transaction) => transaction.type === TRANSACTION_TYPES.INCOME)
    .sort((a, b) => String(b.occurredAt).localeCompare(String(a.occurredAt)))
    .slice(0, MAX_INCOME_LINES);

  const incomeCount = totals.transactions.filter((transaction) => transaction.type === TRANSACTION_TYPES.INCOME).length;
  const lines = [
    `💰 <b>Ingresos · ${escapeHtml(monthLabel(key))}</b>`,
    '',
    `Total: <b>${formatCents(totals.incomeCents, currencyOf(deps), localeOf(deps))}</b>`,
    `Movimientos: <b>${incomeCount}</b>`,
  ];

  if (incomes.length) {
    lines.push('', '<b>Últimos ingresos</b>');
    for (const transaction of incomes) {
      const category = categoryMap.get(transaction.categoryId);
      const label = transaction.note || category?.name || 'Ingreso';
      const date = formatDate(transaction.occurredAt, tzOf(deps)).slice(0, 5);
      const userName = userMap.get(transaction.userId) || 'Familiar';
      lines.push(
        `• ${date} · ${escapeHtml(label)} · ${escapeHtml(userName)} · <b>${formatCents(transaction.amountCents, currencyOf(deps), localeOf(deps))}</b>`,
      );
    }
  } else {
    lines.push('', 'Sin ingresos registrados este mes.');
  }

  const byUser = totals.byUser.filter((entry) => entry.incomeCents > 0);
  if (byUser.length) {
    lines.push('', '<b>Por integrante</b>');
    for (const entry of byUser) {
      const userName = userMap.get(entry.userId) || 'Familiar';
      lines.push(`• ${escapeHtml(userName)}: ${formatCents(entry.incomeCents, currencyOf(deps), localeOf(deps))}`);
    }
  }

  await replyHtml(ctx, lines.join('\n'));
});

export const handleInvestments = safe('inversiones', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const key = monthKeyFromPayload(ctx, deps);
  if (!key) {
    await replyInvalidMonth(ctx, deps, raw);
    return;
  }
  const range = monthRange(key, tzOf(deps));
  const [totals, goals] = await Promise.all([
    deps.repos.transactions.totals({ from: range.start, to: range.end }),
    deps.repos.goals.list(),
  ]);
  const text = buildInvestmentsReport({
    monthKey: key,
    totals,
    goals,
    currency: currencyOf(deps),
    locale: localeOf(deps),
  });
  await replyHtml(ctx, text);
});

export const handleReport = safe('reporte', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const key = monthKeyFromPayload(ctx, deps);
  if (!key) {
    await replyInvalidMonth(ctx, deps, raw);
    return;
  }
  const range = monthRange(key, tzOf(deps));
  const [totals, categories, goals, snapshot] = await Promise.all([
    deps.repos.transactions.totals({ from: range.start, to: range.end }),
    deps.repos.categories.list(),
    deps.repos.goals.list(),
    deps.services.alerts.getSummary(key),
  ]);
  const text = buildSummaryMessage({
    title: 'Reporte mensual',
    monthKey: key,
    rangeLabel: monthLabel(key),
    totals,
    budgetSummary: snapshot?.summary || null,
    categories,
    goals,
    currency: currencyOf(deps),
    locale: localeOf(deps),
  });
  await replyHtml(ctx, text);
});

// ---------------------------------------------------------------------------
// Categorias, presupuestos y metas
// ---------------------------------------------------------------------------

export const handleNewCategory = safe('nueva_categoria', async (ctx, deps) => {
  const payload = String(ctx.payload || '').trim();
  if (!payload) {
    await replyHtml(ctx, [
      '🏷️ <b>Nueva categoría</b>',
      '',
      'Usá: <code>/nueva_categoria Nombre | tipo | presupuesto</code>',
      '',
      'Tipos: <code>income</code>, <code>fixed_expense</code>, <code>variable_expense</code>, <code>investment</code>.',
      'Ejemplo: <code>/nueva_categoria Mascotas | variable_expense | 20000</code>',
      'El presupuesto es opcional.',
    ].join('\n'));
    return;
  }

  const parsed = parseCategoryCreation(payload);
  if (!parsed?.ok) {
    await replyHtml(ctx, [
      '🤔 No pude interpretar la categoría.',
      'Ejemplo: <code>/nueva_categoria Mascotas | variable_expense | 20000</code>',
    ].join('\n'));
    return;
  }

  const budgetCents = parsed.budgetCents ?? parsed.monthlyBudgetCents ?? parsed.amountCents ?? null;
  try {
    const category = await deps.repos.categories.create({
      name: parsed.name,
      type: parsed.type,
      emoji: parsed.emoji,
      monthlyBudgetCents: budgetCents,
    });
    const lines = [
      `✅ Categoría <b>${categoryEmoji(category)} ${escapeHtml(category.name)}</b> creada.`,
      '',
      `Tipo: <b>${escapeHtml(category.type)}</b>`,
    ];
    if (category.monthlyBudgetCents) {
      lines.push(`Presupuesto mensual: <b>${formatCents(category.monthlyBudgetCents, currencyOf(deps), localeOf(deps))}</b>`);
    }
    lines.push('', 'Usala con <code>#tag</code> o por nombre en tus gastos.');
    await replyHtml(ctx, lines.join('\n'));
  } catch (error) {
    const friendly = /ya existe/i.test(String(error?.message || ''))
      ? `⚠️ ${escapeHtml(error.message)}`
      : '❌ No pude crear la categoría. Revisá el nombre y el tipo.';
    if (!/ya existe/i.test(String(error?.message || ''))) {
      deps.logger?.warn?.('fallo creando categoria', { error: error?.message });
    }
    await replyHtml(ctx, friendly);
  }
});

export const handleSetBudget = safe('presupuesto_set', async (ctx, deps) => {
  const payload = String(ctx.payload || '').trim();
  if (!payload) {
    await replyHtml(ctx, [
      '💸 <b>Ajustar presupuesto</b>',
      '',
      'Usá: <code>/presupuesto_set &lt;categoría|general&gt; &lt;monto&gt;</code>',
      'Ejemplo: <code>/presupuesto_set Supermercado 400000</code>',
      'Ejemplo: <code>/presupuesto_set general 1500000</code>',
    ].join('\n'));
    return;
  }

  const parsed = parseBudgetUpdate(payload);
  if (!parsed?.ok || !Number.isSafeInteger(parsed.amountCents) || parsed.amountCents <= 0) {
    await replyHtml(ctx, [
      '🤔 No pude interpretar el presupuesto.',
      'Ejemplo: <code>/presupuesto_set Supermercado 400000</code>',
    ].join('\n'));
    return;
  }

  if (parsed.isOverall) {
    const previous = await deps.repos.settings.get('budget.overall_cents', null);
    await deps.repos.settings.set('budget.overall_cents', parsed.amountCents);
    await replyHtml(ctx, [
      '✅ <b>Presupuesto general actualizado</b>',
      '',
      `Anterior: ${previous ? formatCents(previous, currencyOf(deps), localeOf(deps)) : 'sin definir'}`,
      `Nuevo: <b>${formatCents(parsed.amountCents, currencyOf(deps), localeOf(deps))}</b>`,
    ].join('\n'));
    return;
  }

  const categories = await deps.repos.categories.list({ includeInactive: true });
  const target = findCategoryByName(categories, parsed.categoryName || parsed.name);
  if (!target) {
    const names = categories.map((category) => `${categoryEmoji(category)} ${category.name}`).join(', ');
    await replyHtml(ctx, [
      `🔎 No encontré la categoría <b>${escapeHtml(parsed.categoryName || '')}</b>.`,
      '',
      `Disponibles: ${escapeHtml(names)}`,
    ].join('\n'));
    return;
  }

  const previous = target.monthlyBudgetCents;
  const updated = await deps.repos.categories.update(target.id, { monthlyBudgetCents: parsed.amountCents });
  await replyHtml(ctx, [
    `✅ <b>Presupuesto actualizado</b> · ${categoryEmoji(updated)} ${escapeHtml(updated.name)}`,
    '',
    `Anterior: ${previous ? formatCents(previous, currencyOf(deps), localeOf(deps)) : 'sin definir'}`,
    `Nuevo: <b>${formatCents(updated.monthlyBudgetCents, currencyOf(deps), localeOf(deps))}</b>`,
  ].join('\n'));
});

export const handleNewGoal = safe('meta', async (ctx, deps) => {
  const payload = String(ctx.payload || '').trim();
  if (!payload) {
    await replyHtml(ctx, [
      '🎯 <b>Nueva meta de ahorro</b>',
      '',
      'Usá: <code>/meta &lt;nombre&gt; &lt;objetivo&gt; [fecha]</code>',
      'Ejemplo: <code>/meta Viaje 500000 2027-01-15</code>',
    ].join('\n'));
    return;
  }

  const parsed = parseGoalCreation(payload);
  if (!parsed?.ok || !Number.isSafeInteger(parsed.targetCents) || parsed.targetCents <= 0) {
    await replyHtml(ctx, [
      '🤔 No pude interpretar la meta.',
      'Ejemplo: <code>/meta Viaje 500000 2027-01-15</code>',
    ].join('\n'));
    return;
  }

  const goal = await deps.repos.goals.create({
    name: parsed.name || parsed.goalName,
    targetCents: parsed.targetCents,
    deadline: parsed.deadline || null,
    userId: ctx.state?.user?.id || null,
  });
  const percent = percentOf(goal.savedCents, goal.targetCents) ?? 0;
  const lines = [
    `🎯 Meta <b>${escapeHtml(goal.name)}</b> creada`,
    '',
    `Objetivo: <b>${formatCents(goal.targetCents, currencyOf(deps), localeOf(deps))}</b>`,
    `Ahorrado: ${formatCents(goal.savedCents, currencyOf(deps), localeOf(deps))}`,
    `${progressBar(percent)} ${percent}%`,
  ];
  if (goal.deadline) lines.push(`Fecha límite: <b>${escapeHtml(goal.deadline)}</b>`);
  lines.push('', `Sumá aportes con <code>/aportar ${escapeHtml(goal.name)} 10000</code>.`);
  await replyHtml(ctx, lines.join('\n'));
});

export const handleGoals = safe('metas', async (ctx, deps) => {
  const goals = await deps.repos.goals.list();
  if (!goals.length) {
    await replyHtml(ctx, [
      '🎯 Todavía no hay metas de ahorro.',
      '',
      'Creá una con <code>/meta Viaje 500000 2027-01-15</code>.',
    ].join('\n'));
    return;
  }

  const lines = ['🎯 <b>Metas de ahorro</b>', ''];
  for (const goal of goals) {
    const percent = percentOf(goal.savedCents, goal.targetCents) ?? 0;
    lines.push(`<b>${escapeHtml(goal.name)}</b> · <code>${escapeHtml(String(goal.id).slice(0, 8))}</code>`);
    lines.push(`${progressBar(percent)} <b>${percent}%</b>`);
    lines.push(`${formatCents(goal.savedCents, currencyOf(deps), localeOf(deps))} de ${formatCents(goal.targetCents, currencyOf(deps), localeOf(deps))}`);
    if (goal.deadline) lines.push(`📅 Límite: ${escapeHtml(goal.deadline)}`);
    lines.push('');
  }
  lines.push('Sumá aportes con <code>/aportar &lt;meta&gt; &lt;monto&gt;</code>.');
  await replyHtml(ctx, lines.join('\n'));
});

export const handleContribute = safe('aportar', async (ctx, deps) => {
  const payload = String(ctx.payload || '').trim();
  if (!payload) {
    await replyHtml(ctx, [
      '🏦 <b>Aportar a una meta</b>',
      '',
      'Usá: <code>/aportar &lt;meta&gt; &lt;monto&gt;</code>',
      'Ejemplo: <code>/aportar Viaje 50000</code>',
    ].join('\n'));
    return;
  }

  const parsed = parseContribution(payload);
  if (!parsed?.ok || !Number.isSafeInteger(parsed.amountCents) || parsed.amountCents <= 0) {
    await replyHtml(ctx, [
      '🤔 No pude interpretar el aporte.',
      'Ejemplo: <code>/aportar Viaje 50000</code>',
    ].join('\n'));
    return;
  }

  const goalName = parsed.goalName || parsed.name || parsed.goal || '';
  const goals = await deps.repos.goals.list();
  const target = normalize(goalName);
  const goal = goals.find((item) => normalize(item.name) === target)
    || goals.find((item) => normalize(item.name).includes(target) || target.includes(normalize(item.name)));

  if (!goal) {
    const names = goals.length
      ? goals.map((item) => `• ${escapeHtml(item.name)}`).join('\n')
      : 'Todavía no hay metas. Creá una con <code>/meta</code>.';
    await replyHtml(ctx, [
      `🔎 No encontré la meta <b>${escapeHtml(goalName)}</b>.`,
      '',
      names,
    ].join('\n'));
    return;
  }

  const savingCategory = await deps.repos.categories.getByName('Ahorro');
  const investCategory = await deps.repos.categories.getByName('Inversiones');
  const categoryName = savingCategory?.name || investCategory?.name || 'Inversiones';

  const { text } = await createFromParsed(ctx, deps, {
    ok: true,
    type: TRANSACTION_TYPES.INVESTMENT,
    amountCents: parsed.amountCents,
    categoryName,
    note: `Aporte a meta ${goal.name}`,
    tags: [],
    occurredAt: now(deps),
    raw: payload,
  }, { source: 'text', metadata: { goalId: goal.id } });

  const updated = await deps.repos.goals.contribute(goal.id, parsed.amountCents);
  const percent = percentOf(updated.savedCents, updated.targetCents) ?? 0;
  const lines = [
    text,
    '',
    `🎯 <b>${escapeHtml(updated.name)}</b>`,
    `${progressBar(percent)} <b>${percent}%</b> · ${formatCents(updated.savedCents, currencyOf(deps), localeOf(deps))} de ${formatCents(updated.targetCents, currencyOf(deps), localeOf(deps))}`,
  ];
  await replyHtml(ctx, lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Movimientos
// ---------------------------------------------------------------------------

async function handleQuickTransaction(ctx, deps, { defaultType, label, source = 'text' }) {
  const payload = String(ctx.payload || '').trim();
  if (!payload) {
    await replyHtml(ctx, [
      `Usá: <code>${label} &lt;monto&gt; &lt;categoría|#tag&gt; [nota]</code>`,
      '',
      label === '/gasto'
        ? 'Ejemplo: <code>/gasto 15000 super #comida</code>'
        : label === '/ingreso'
          ? 'Ejemplo: <code>/ingreso 250000 sueldo</code>'
          : 'Ejemplo: <code>/inversion 50000 plazo fijo</code>',
    ].join('\n'));
    return;
  }

  const categories = await deps.repos.categories.list();
  const parsed = parseTransactionArgs(payload, {
    categories,
    defaultType,
    now: now(deps),
    currency: currencyOf(deps),
    forceType: true,
  });

  if (!parsed?.ok || !Number.isSafeInteger(parsed.amountCents) || parsed.amountCents <= 0) {
    await replyHtml(ctx, parseHint(parsed, `${label} 15000 super #comida`));
    return;
  }

  const { text, keyboard } = await createFromParsed(ctx, deps, parsed, {
    source,
    metadata: { raw: payload },
  });
  await replyHtml(ctx, text, keyboard ? { reply_markup: keyboard } : {});
}

export const handleExpenseCommand = safe('gasto', async (ctx, deps) =>
  handleQuickTransaction(ctx, deps, { defaultType: TRANSACTION_TYPES.VARIABLE_EXPENSE, label: '/gasto' }));

export const handleIncomeCommand = safe('ingreso', async (ctx, deps) =>
  handleQuickTransaction(ctx, deps, { defaultType: TRANSACTION_TYPES.INCOME, label: '/ingreso' }));

export const handleInvestmentCommand = safe('inversion', async (ctx, deps) =>
  handleQuickTransaction(ctx, deps, { defaultType: TRANSACTION_TYPES.INVESTMENT, label: '/inversion' }));

export const handleRecent = safe('movimientos', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const requested = Number.parseInt(raw, 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_RECENT) : 10;

  const [transactions, categories, users] = await Promise.all([
    deps.repos.transactions.list({ limit, status: 'confirmed', order: 'desc' }),
    deps.repos.categories.list({ includeInactive: true }),
    deps.repos.users.list({ includeInactive: true }),
  ]);

  if (!transactions.length) {
    await replyHtml(ctx, '📭 Todavía no hay movimientos registrados.');
    return;
  }

  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const userMap = new Map(users.map((user) => [user.id, user.name]));
  const lines = [`🧾 <b>Últimos ${transactions.length} movimientos</b>`, ''];
  transactions.forEach((transaction, index) => {
    const meta = TYPE_META[transaction.type] || TYPE_META.variable_expense;
    const category = categoryMap.get(transaction.categoryId);
    const date = formatDate(transaction.occurredAt, tzOf(deps)).slice(0, 5);
    const note = transaction.note || category?.name || meta.label;
    const userName = userMap.get(transaction.userId) || 'Familiar';
    lines.push(
      `<b>${index + 1}.</b> ${meta.emoji} ${date} · ${escapeHtml(note)} · ${escapeHtml(userName)} · <b>${meta.sign}${formatCents(transaction.amountCents, currencyOf(deps), localeOf(deps))}</b>`,
    );
  });
  lines.push('', 'Borrá uno con <code>/borrar &lt;número&gt;</code> · Exportá todo con /exportar.');
  await replyHtml(ctx, lines.join('\n'));
});

export const handleCategories = safe('categorias', async (ctx, deps) => {
  const categories = await deps.repos.categories.list();
  if (!categories.length) {
    await replyHtml(ctx, '🏷️ No hay categorías activas. Creá una con /nueva_categoria.');
    return;
  }

  const lines = ['🏷️ <b>Categorías activas</b>'];
  for (const type of TYPE_ORDER) {
    const group = categories.filter((category) => category.type === type);
    if (!group.length) continue;
    const meta = TYPE_META[type] || { label: type };
    lines.push('', `<b>${escapeHtml(meta.label)}</b>`);
    for (const category of group) {
      const budget = category.monthlyBudgetCents
        ? ` · ${formatCents(category.monthlyBudgetCents, currencyOf(deps), localeOf(deps))}/mes`
        : '';
      lines.push(`• ${categoryEmoji(category)} ${escapeHtml(category.name)}${escapeHtml(budget)}`);
    }
  }
  lines.push('', 'Ajustá límites con /presupuesto_set y creá nuevas con /nueva_categoria.');
  await replyHtml(ctx, lines.join('\n'));
});

export const handleExport = safe('exportar', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const key = resolveMonthKey(raw, now(deps), tzOf(deps));
  if (!key) {
    await replyInvalidMonth(ctx, deps, raw);
    return;
  }

  const csv = await deps.services.transactions.exportCsv({ monthKeyValue: key });
  const buffer = Buffer.from(csv, 'utf8');
  const filename = `movimientos-${key}.csv`;
  const caption = `📄 Movimientos de ${monthLabel(key)}`;

  if (typeof ctx.replyWithDocument !== 'function') {
    await replyHtml(ctx, `✅ Exportación lista (${Math.round(buffer.length / 1024)} KB), pero este chat no admite documentos.`);
    return;
  }
  await ctx.replyWithDocument(
    { source: buffer, filename },
    { caption, parse_mode: 'HTML' },
  );
});

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------

export const handleAlertsCheck = safe('alertas', async (ctx, deps) => {
  const key = monthKey(now(deps), tzOf(deps));
  const result = await deps.services.alerts.evaluateMonth(key, { notify: true });
  const active = deps.config.alerts.enabled;

  if (result?.skipped) {
    await replyHtml(ctx, [
      '🔕 <b>Alertas desactivadas</b>',
      '',
      'Activálas con <code>ALERTS_ENABLED=true</code> en el archivo <code>.env</code>.',
    ].join('\n'));
    return;
  }

  const rows = summaryRows(result?.summary).map(normalizeBudgetRow).filter(Boolean);
  const withBudget = rows.filter((row) => row.budgetCents && row.budgetCents > 0);
  const alerts = result?.alerts || [];
  const sent = (result?.deliveries || []).filter((delivery) => delivery?.sent).length;

  const lines = [
    `🔔 <b>Alertas · ${escapeHtml(monthLabel(key))}</b>`,
    '',
    active ? 'Estado: <b>activas</b>' : 'Estado: <b>desactivadas</b> (no se envían notificaciones)',
  ];
  if (alerts.length) {
    lines.push(`Umbrales alcanzados: <b>${alerts.length}</b> · Notificaciones enviadas: <b>${sent}</b>`);
    for (const alert of alerts) {
      const label = alert.scope === 'overall' ? 'General' : (alert.categoryName || 'Categoría');
      lines.push(`• ${escapeHtml(label)} · ${alert.percent}% (umbral ${alert.threshold}%)`);
    }
  } else {
    lines.push('Sin umbrales alcanzados en este momento. 👍');
  }

  if (withBudget.length) {
    lines.push('', '<b>Estado de presupuestos</b>');
    for (const row of withBudget.slice(0, 12)) {
      lines.push(`${progressBar(row.percent)} ${row.percent}% · ${escapeHtml(row.categoryName || 'General')}`);
    }
  }

  lines.push('', 'Ajustá un límite con /presupuesto_set.');
  await replyHtml(ctx, lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Texto libre, voz y documentos
// ---------------------------------------------------------------------------

/** Saludo corto cuando el usuario escribe "hola" en privado. */
function greetingText(deps) {
  return [
    '👋 ¡Hola! Contame un movimiento y lo registro.',
    '',
    'Ejemplos:',
    '• <code>Gasté 15.000 en el super #comida</code>',
    '• <code>Cobré 250000 de sueldo</code>',
    '• <code>Invertí 50000 en plazo fijo</code>',
    '',
    'Consultas: /balance · /presupuesto · /ayuda',
  ].join('\n');
}

/** Procesa texto (libre o transcripto) y registra el movimiento si aplica. */
async function processIncomingText(ctx, deps, text, { source = 'text', metadata = {}, fromVoice = false } = {}) {
  const isPrivate = (ctx.chat?.type || 'private') === 'private';
  const categories = await deps.repos.categories.list();
  const parsed = parseTransactionMessage(text, {
    categories,
    defaultType: TRANSACTION_TYPES.VARIABLE_EXPENSE,
    now: now(deps),
    currency: currencyOf(deps),
  });

  if (parsed?.ok && Number.isSafeInteger(parsed.amountCents) && parsed.amountCents > 0) {
    const { text: confirmation, keyboard } = await createFromParsed(ctx, deps, parsed, {
      source,
      metadata: { ...metadata, transcript: metadata.transcript ?? text, raw: text },
    });
    await replyHtml(ctx, confirmation, keyboard ? { reply_markup: keyboard } : {});
    return true;
  }

  if (parsed?.reason === 'negative-amount') {
    await replyHtml(ctx, parseHint(parsed, ''));
    return false;
  }

  if (fromVoice) {
    await replyHtml(ctx, [
      '🤔 No pude detectar un monto en el audio.',
      'Repetí el mensaje incluyendo el monto, por ejemplo:',
      '<code>Gasté 15.000 en el super</code>',
      'O cargalo con <code>/gasto 15000 super</code>.',
    ].join('\n'));
    return false;
  }

  const money = typeof hasMoneySignal === 'function' ? hasMoneySignal(text) : false;
  if (isPrivate || money) {
    await replyHtml(ctx, [
      '🤔 No pude interpretar el movimiento.',
      '',
      'Probá con un monto claro:',
      '• <code>Gasté 15.000 en el super #comida</code>',
      '• <code>/gasto 15000 super #comida</code>',
    ].join('\n'));
  }
  return false;
}

export const handleText = safe('text', async (ctx, deps) => {
  const text = String(ctx.message?.text || '').trim();
  if (!text) return;

  if (text.startsWith('/')) {
    await handleUnknownCommand(ctx, deps);
    return;
  }

  const isPrivate = (ctx.chat?.type || 'private') === 'private';
  if (/^(hola|buenas|buen d[ií]a|buenas tardes|buenas noches|hey)[!.\s]*$/i.test(text)) {
    await replyHtml(ctx, greetingText(deps));
    return;
  }

  await processIncomingText(ctx, deps, text, { source: 'text', metadata: {} });
});

/** Error de descarga con codigo para mensajes amigables. */
class DownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

/** Descarga un archivo de Telegram validando el tamano maximo. */
async function downloadTelegramFile(ctx, fileId, deps) {
  const max = deps.config.gemini.maxUploadBytes;
  let link;
  try {
    link = await ctx.telegram.getFileLink(fileId);
  } catch (error) {
    throw new DownloadError('No pude obtener el archivo desde Telegram.', 'file-link');
  }
  const url = typeof link === 'string' ? link : link?.href || String(link);
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  } catch (error) {
    throw new DownloadError('No pude descargar el archivo (tiempo de espera agotado).', 'download');
  }
  if (!response?.ok) {
    throw new DownloadError(`Telegram respondió ${response?.status ?? 'error'} al descargar el archivo.`, 'download-status');
  }
  let buffer;
  try {
    const arrayBuffer = await response.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);
  } catch (error) {
    throw new DownloadError('No pude leer el contenido del archivo.', 'download-body');
  }
  if (!buffer.length) throw new DownloadError('El archivo llegó vacío.', 'empty');
  if (buffer.length > max) throw new DownloadError('El archivo supera el tamaño máximo permitido.', 'too-large');
  return buffer;
}

export const handleVoice = safe('voice', async (ctx, deps) => {
  const voice = ctx.message?.voice || ctx.message?.audio || null;
  if (!voice) return;

  const ocr = deps.services.ocr;
  if (!(ocr?.audioEnabled ?? ocr?.enabled)) {
    await replyHtml(ctx, [
      '🎙️ La transcripción de voz está desactivada.',
      '',
      'Activala con <code>AI_PROVIDER=local</code> (Mac, whisper.cpp) o <code>GEMINI_API_KEY</code>, o escribí el movimiento:',
      '<code>Gasté 15.000 en el super</code>',
    ].join('\n'));
    return;
  }

  const max = deps.config.gemini.maxUploadBytes;
  if (Number(voice.file_size) > max) {
    await replyHtml(ctx, `❌ El audio supera el máximo permitido (${Math.round(max / (1024 * 1024))} MB).`);
    return;
  }

  let buffer;
  try {
    buffer = await downloadTelegramFile(ctx, voice.file_id, deps);
  } catch (error) {
    await replyHtml(ctx, `❌ ${escapeHtml(error.message || 'No pude descargar el audio.')}`);
    return;
  }

  const input = {
    buffer,
    mimeType: voice.mime_type || 'audio/ogg',
    fileName: voice.file_name || `audio-${voice.file_id}.ogg`,
  };

  // Motor local: si Canal7 o los subtitulos estan usando Whisper, el audio
  // espera en segundo plano para no trabar el resto de los mensajes del bot.
  const busy = typeof ocr.audioBusy === 'function' ? await ocr.audioBusy() : { busy: false };
  if (busy.busy) {
    await replyHtml(ctx, [
      '⏳ Recibí el audio.',
      'Ahora la Mac está usando Whisper para otra tarea (Canal7 o subtítulos).',
      'Lo transcribo apenas se libere y te respondo acá.',
    ].join('\n'));
    void transcribeAndRegister(ctx, deps, input).catch((error) => {
      deps.logger?.error?.('fallo la transcripcion en espera', { error });
    });
    return;
  }

  await transcribeAndRegister(ctx, deps, input);
});

async function transcribeAndRegister(ctx, deps, input) {
  const ocr = deps.services.ocr;
  let transcript;
  try {
    transcript = await ocr.transcribeAudio(input);
  } catch (error) {
    deps.logger?.error?.('fallo la transcripcion de audio', { error });
    await replyHtml(ctx, '❌ No pude transcribir el audio. Probá de nuevo o escribí el movimiento.');
    return;
  }

  if (transcript?.error === 'whisper-ocupado') {
    await replyHtml(ctx, [
      '⌛ Pasó demasiado tiempo y Whisper sigue ocupado con otra tarea, así que descarté el audio.',
      'Escribí el movimiento (<code>Gasté 15.000 en el super</code>) o reenviá el audio más tarde.',
    ].join('\n'));
    return;
  }

  if (!transcript?.ok || !String(transcript.text || '').trim()) {
    await replyHtml(ctx, '❌ No pude transcribir el audio. Probá de nuevo o escribí el movimiento.');
    return;
  }

  await replyHtml(ctx, `📝 <i>${escapeHtml(transcript.text)}</i>`);
  await processIncomingText(ctx, deps, transcript.text, {
    source: 'voice',
    metadata: { transcript: transcript.text },
    fromVoice: true,
  });
}

export const handleDocument = safe('document', async (ctx, deps) => {
  const message = ctx.message || {};
  const photo = Array.isArray(message.photo) && message.photo.length
    ? message.photo[message.photo.length - 1]
    : null;
  const document = message.document || null;
  if (!photo && !document) return;

  const ocr = deps.services.ocr;
  if (!(ocr?.documentsEnabled ?? ocr?.enabled)) {
    await replyHtml(ctx, [
      '📄 El OCR de facturas está desactivado.',
      '',
      'Activalo con <code>AI_PROVIDER=local</code> (Mac) o <code>GEMINI_API_KEY</code>, o cargá el gasto a mano:',
      '<code>/gasto 15000 servicios factura de luz</code>',
    ].join('\n'));
    return;
  }

  const max = deps.config.gemini.maxUploadBytes;
  const fileSize = Number(photo?.file_size || document?.file_size || 0);
  if (fileSize > max) {
    await replyHtml(ctx, `❌ El archivo supera el máximo permitido (${Math.round(max / (1024 * 1024))} MB).`);
    return;
  }

  const fileId = photo?.file_id || document?.file_id;
  const mimeType = document?.mime_type || 'image/jpeg';
  const fileName = document?.file_name || `foto-${Date.now()}.jpg`;

  let buffer;
  try {
    buffer = await downloadTelegramFile(ctx, fileId, deps);
  } catch (error) {
    await replyHtml(ctx, `❌ ${escapeHtml(error.message || 'No pude descargar el archivo.')}`);
    return;
  }

  const categories = await deps.repos.categories.list();
  let extraction;
  try {
    extraction = await ocr.extractDocument({
      buffer,
      mimeType,
      fileName,
      categories,
      currency: currencyOf(deps),
    });
  } catch (error) {
    deps.logger?.error?.('fallo el OCR del documento', { error });
    extraction = { ok: false, error: 'No pude leer el documento.' };
  }
  extraction = extraction || { ok: false, error: 'No pude leer el documento.' };

  const category = extraction.categoryName
    ? findCategoryByName(categories, extraction.categoryName)
    : null;

  const created = await deps.repos.documents.create({
    userId: ctx.state?.user?.id || null,
    telegramFileId: fileId,
    fileName,
    mimeType,
    vendor: extraction.vendor || null,
    totalCents: Number.isSafeInteger(extraction.amountCents) && extraction.amountCents > 0
      ? extraction.amountCents
      : null,
    currency: extraction.currency || currencyOf(deps),
    dueDate: extraction.dueDate || null,
    categoryId: category?.id || null,
    extracted: extraction,
    status: 'pending',
    source: 'telegram',
  });

  if (!extraction.ok) {
    await replyHtml(ctx, [
      '❌ No pude leer el documento.',
      extraction.error ? `<i>${escapeHtml(extraction.error)}</i>` : '',
      '',
      'Guardé el archivo como pendiente. Podés corregirlo a mano:',
      `<code>/corregir 15000 ${escapeHtml(category?.name || 'Servicios')} factura</code>`,
    ].filter(Boolean).join('\n'));
    return;
  }

  let text = buildPendingDocumentMessage({
    document: created,
    extraction,
    category,
    currency: currencyOf(deps),
    locale: localeOf(deps),
  });
  const bill = await trackBill(deps, created);
  if (bill) {
    text += `\n\n⏰ Te recuerdo el vencimiento del <b>${escapeHtml(formatYmd(bill.dueDate))}</b> hasta que lo marques como pagado.`;
  }
  if (!created.totalCents) {
    text += '\n\n⚠️ No detecté el monto. Usá <code>/corregir &lt;monto&gt;</code> antes de confirmar.';
  } else {
    text += '\n\nRevisá los datos y confirmá con los botones.';
  }

  await replyHtml(ctx, text, { reply_markup: documentKeyboard(created.id) });
});

// ---------------------------------------------------------------------------
// Callbacks de documentos
// ---------------------------------------------------------------------------

export const handleCallbackQuery = safe('callback', async (ctx, deps) => {
  const data = ctx.callbackQuery?.data ?? (Array.isArray(ctx.match) ? ctx.match[0] : '');
  const txAction = parseTransactionCallback(data);
  if (txAction) {
    await handleTransactionCallback(ctx, deps, txAction);
    return;
  }
  const billAction = parseBillCallback(data);
  if (billAction) {
    await handleBillPaidCallback(ctx, deps, billAction.billId);
    return;
  }
  const parsed = parseDocumentCallback(data);
  if (!parsed) {
    await answerCallback(ctx, 'Acción no reconocida');
    return;
  }

  const document = await deps.repos.documents.get(parsed.documentId);
  if (!document) {
    await answerCallback(ctx, 'No encontré el documento.');
    return;
  }

  const currency = currencyOf(deps);
  const locale = localeOf(deps);
  const user = ctx.state?.user || null;

  if (parsed.action === 'confirm') {
    let result;
    try {
      result = await deps.services.transactions.confirmDocument({ documentId: document.id, user });
    } catch (error) {
      if (error?.code !== 'FX_UNAVAILABLE') throw error;
      await answerCallback(ctx, error.message.slice(0, 190), { show_alert: true });
      return;
    }
    if (!result?.ok) {
      await answerCallback(ctx, result?.message || 'No pude confirmar el documento.', { show_alert: true });
      return;
    }
    const summary = result.alertResult?.summary || await loadSummaryFor(deps, result.transaction);
    let text = buildTransactionConfirmation({
      transaction: result.transaction,
      category: result.category,
      user,
      budgetSummary: summary,
      currency,
      locale,
    });
    text += '\n\n✅ <b>Documento confirmado</b>';
    text += budgetBlock(summary, result, deps);
    await editHtml(ctx, deps, text);
    await answerCallback(ctx, '✅ Confirmado');
    return;
  }

  if (parsed.action === 'cancel') {
    const result = await deps.services.transactions.discardDocument(document.id);
    if (!result?.ok) {
      await answerCallback(ctx, 'No pude descartar el documento.', { show_alert: true });
      return;
    }
    try {
      await deps.services.bills?.cancelForDocument?.(document.id);
    } catch (error) {
      deps.logger?.warn?.('no pude cancelar el vencimiento del documento', { documentId: document.id, error });
    }
    await editHtml(ctx, deps, '🗑️ <b>Documento descartado</b>\n\nNo se registró ningún movimiento.');
    await answerCallback(ctx, 'Descartado');
    return;
  }

  if (parsed.action === 'edit') {
    await answerCallback(ctx, 'Enviá /corregir con el monto.');
    const current = document.totalCents
      ? formatCents(document.totalCents, currency, locale)
      : 'sin monto';
    await replyHtml(ctx, [
      '✏️ <b>Corregir documento</b>',
      '',
      `Monto detectado: <b>${escapeHtml(current)}</b>`,
      `Comercio: ${escapeHtml(document.vendor || 'sin datos')}`,
      '',
      'Enviá: <code>/corregir &lt;monto&gt; [categoría] [nota]</code>',
      'Ejemplo: <code>/corregir 15000 Servicios factura de luz</code>',
    ].join('\n'));
    return;
  }

  if (parsed.action === 'cat') {
    const category = await deps.repos.categories.get(parsed.categoryId);
    if (!category) {
      await answerCallback(ctx, 'Categoría no encontrada.');
      return;
    }
    const extraction = { ...(document.extracted || {}), categoryName: category.name };
    const updated = await deps.repos.documents.update(document.id, {
      categoryId: category.id,
      extracted: extraction,
    });
    const text = buildPendingDocumentMessage({
      document: updated,
      extraction,
      category,
      currency,
      locale,
    });
    await editHtml(ctx, deps, text, { reply_markup: documentKeyboard(updated.id) });
    await answerCallback(ctx, `Categoría: ${category.name}`);
  }
});

// ---------------------------------------------------------------------------
// /corregir
// ---------------------------------------------------------------------------

export const handleCorrect = safe('corregir', async (ctx, deps) => {
  const user = ctx.state?.user;
  if (!user) {
    await replyHtml(ctx, '🪪 No pude identificarte. Escribí /id y avisale al administrador.');
    return;
  }

  const pending = await deps.repos.documents.list({ status: 'pending', userId: user.id, limit: 5 });
  if (!pending.length) {
    await replyHtml(ctx, [
      '📭 No tenés documentos pendientes de confirmar.',
      '',
      'Enviá una foto de una factura o cargá el gasto con <code>/gasto</code>.',
    ].join('\n'));
    return;
  }

  const document = pending[0];
  const payload = String(ctx.payload || '').trim();
  if (!payload) {
    const current = document.totalCents
      ? formatCents(document.totalCents, currencyOf(deps), localeOf(deps))
      : 'sin monto';
    await replyHtml(ctx, [
      '✏️ <b>Corregir documento pendiente</b>',
      '',
      `Monto actual: <b>${escapeHtml(current)}</b>`,
      `Comercio: ${escapeHtml(document.vendor || 'sin datos')}`,
      '',
      'Enviá: <code>/corregir &lt;monto&gt; [categoría] [nota]</code>',
      'Ejemplo: <code>/corregir 15000 Servicios factura de luz</code>',
    ].join('\n'));
    return;
  }

  const categories = await deps.repos.categories.list();
  const parsed = parseTransactionArgs(payload, {
    categories,
    defaultType: TRANSACTION_TYPES.VARIABLE_EXPENSE,
    now: now(deps),
    currency: currencyOf(deps),
    forceType: false,
  });

  let amountCents = parsed?.amountCents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    const direct = parseAmountToCents(payload.split(/\s+/)[0]);
    if (Number.isSafeInteger(direct) && direct > 0) amountCents = direct;
  }

  let category = null;
  if (parsed?.category && typeof parsed.category === 'object' && parsed.category.id) {
    category = parsed.category;
  } else if (parsed?.categoryName) {
    category = findCategoryByName(categories, parsed.categoryName);
  }

  const patch = {};
  if (Number.isSafeInteger(amountCents) && amountCents > 0) {
    patch.totalCents = amountCents;
    // El monto corregido esta en la moneda que escribio el usuario (pesos salvo "usd 15").
    patch.currency = parsed?.ok && parsed.currency ? parsed.currency : currencyOf(deps);
  }
  if (category) patch.categoryId = category.id;

  const extracted = {
    ...(document.extracted || {}),
    ...(category ? { categoryName: category.name } : {}),
    ...(parsed?.note ? { description: parsed.note } : {}),
  };
  patch.extracted = extracted;

  const updated = await deps.repos.documents.update(document.id, patch);
  await syncBill(deps, updated);
  const effectiveCategory = category
    || (updated.categoryId ? await deps.repos.categories.get(updated.categoryId) : null);

  const text = buildPendingDocumentMessage({
    document: updated,
    extraction: extracted,
    category: effectiveCategory,
    currency: currencyOf(deps),
    locale: localeOf(deps),
  });

  await replyHtml(ctx, `${text}\n\n✅ <b>Datos actualizados</b>. Confirmá o descartá con los botones.`, {
    reply_markup: documentKeyboard(updated.id),
  });
});

// ---------------------------------------------------------------------------
// Borrar movimientos: /borrar y botones Borrar / Restaurar
// ---------------------------------------------------------------------------

const DELETE_LIST_SIZE = 10;

function transactionLine(deps, transaction, categoryMap) {
  const meta = TYPE_META[transaction.type] || TYPE_META.variable_expense;
  const date = formatDate(transaction.occurredAt, tzOf(deps)).slice(0, 5);
  const note = transaction.note || categoryMap?.get(transaction.categoryId)?.name || meta.label;
  return `${meta.emoji} ${date} · ${escapeHtml(note)} · <b>${meta.sign}${formatCents(transaction.amountCents, currencyOf(deps), localeOf(deps))}</b>`;
}

/** Borra (status "discarded") o restaura un movimiento. No elimina la fila: se puede deshacer. */
async function setTransactionDiscarded(deps, transactionId, discarded) {
  const transaction = await deps.repos.transactions.get(transactionId);
  if (!transaction) return { ok: false, reason: 'not-found' };
  const target = discarded ? 'discarded' : 'confirmed';
  if (transaction.status === target) return { ok: false, reason: 'unchanged', transaction };
  const updated = await deps.repos.transactions.update(transaction.id, { status: target });
  deps.logger?.info?.(discarded ? 'movimiento borrado' : 'movimiento restaurado', {
    transactionId: transaction.id,
    amountCents: transaction.amountCents,
  });
  return { ok: true, transaction: updated };
}

export const handleDelete = safe('borrar', async (ctx, deps) => {
  const raw = String(ctx.payload || '').trim();
  const [transactions, categories] = await Promise.all([
    deps.repos.transactions.list({ limit: DELETE_LIST_SIZE, status: 'confirmed', order: 'desc' }),
    deps.repos.categories.list({ includeInactive: true }),
  ]);
  const categoryMap = new Map(categories.map((category) => [category.id, category]));

  if (!transactions.length) {
    await replyHtml(ctx, '📭 No hay movimientos para borrar.');
    return;
  }

  if (!raw) {
    const lines = ['🗑️ <b>¿Cuál querés borrar?</b>', ''];
    transactions.forEach((transaction, index) => lines.push(`<b>${index + 1}.</b> ${transactionLine(deps, transaction, categoryMap)}`));
    lines.push('', 'Tocá el botón o escribí <code>/borrar 2</code>. Se puede restaurar después.');
    const keyboard = {
      inline_keyboard: transactions.map((transaction, index) => [{
        text: `🗑️ ${index + 1}. ${formatCents(transaction.amountCents, currencyOf(deps), localeOf(deps))} ${String(transaction.note || '').slice(0, 24)}`.trim(),
        callback_data: `tx:del:${transaction.id}`,
      }]),
    };
    await replyHtml(ctx, lines.join('\n'), { reply_markup: keyboard });
    return;
  }

  const index = Number.parseInt(raw, 10);
  if (!Number.isInteger(index) || index < 1 || index > transactions.length) {
    await replyHtml(ctx, `❌ Indicá un número del 1 al ${transactions.length}. Mirá la lista con /borrar.`);
    return;
  }
  const transaction = transactions[index - 1];
  const result = await setTransactionDiscarded(deps, transaction.id, true);
  if (!result.ok) {
    await replyHtml(ctx, 'ℹ️ Ese movimiento ya estaba borrado.');
    return;
  }
  await replyHtml(ctx, `🗑️ <b>Borrado:</b> ${transactionLine(deps, transaction, categoryMap)}`, {
    reply_markup: restoreKeyboard(transaction.id),
  });
});

async function handleTransactionCallback(ctx, deps, action) {
  const discard = action.action === 'delete';
  const result = await setTransactionDiscarded(deps, action.transactionId, discard);
  if (!result.ok) {
    await answerCallback(ctx, result.reason === 'not-found'
      ? 'No encontré el movimiento.'
      : (discard ? 'Ya estaba borrado.' : 'Ya estaba registrado.'));
    return;
  }
  const categories = await deps.repos.categories.list({ includeInactive: true });
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const line = transactionLine(deps, result.transaction, categoryMap);
  if (discard) {
    await answerCallback(ctx, '🗑️ Borrado');
    await replyHtml(ctx, `🗑️ <b>Borrado:</b> ${line}`, { reply_markup: restoreKeyboard(result.transaction.id) });
  } else {
    await answerCallback(ctx, '↩️ Restaurado');
    await replyHtml(ctx, `↩️ <b>Restaurado:</b> ${line}`, { reply_markup: transactionKeyboard(result.transaction.id) });
  }
}

// ---------------------------------------------------------------------------
// Vencimientos: /vencimientos, /vence, /pagado y boton "Pagué"
// ---------------------------------------------------------------------------

/** 2026-11-15 -> 15/11/2026 */
function formatYmd(ymd) {
  const [year, month, day] = String(ymd || '').split('-');
  return year && month && day ? `${day}/${month}/${year}` : String(ymd || '');
}

/** Agenda el vencimiento de una factura sin cortar el flujo si falla. */
async function trackBill(deps, document) {
  if (!document?.dueDate || typeof deps.services.bills?.trackDocument !== 'function') return null;
  try {
    return await deps.services.bills.trackDocument(document);
  } catch (error) {
    deps.logger?.warn?.('no pude agendar el vencimiento de la factura', { documentId: document.id, error });
    return null;
  }
}

async function syncBill(deps, document) {
  if (typeof deps.services.bills?.syncDocument !== 'function') return;
  try {
    await deps.services.bills.syncDocument(document);
  } catch (error) {
    deps.logger?.warn?.('no pude actualizar el vencimiento de la factura', { documentId: document?.id, error });
  }
}

function billsDisabled(deps) {
  return typeof deps.services.bills?.buildListMessage !== 'function';
}

function paidMessage(deps, result) {
  const bills = deps.services.bills;
  const lines = [`✅ <b>Pagado:</b> ${escapeHtml(result.bill.name)} — ${escapeHtml(bills.amountLabel(result.bill))}`];
  if (result.next) {
    lines.push(`🔁 Próximo vencimiento agendado: <b>${escapeHtml(formatYmd(result.next.dueDate))}</b>`);
  }
  return lines.join('\n');
}

export const handleBills = safe('vencimientos', async (ctx, deps) => {
  if (billsDisabled(deps)) {
    await replyHtml(ctx, '📅 Los vencimientos no están disponibles.');
    return;
  }
  const { html, keyboard } = await deps.services.bills.buildListMessage({ at: now(deps) });
  await replyHtml(ctx, html, keyboard ? { reply_markup: keyboard } : {});
});

export const handleNewBill = safe('vence', async (ctx, deps) => {
  if (billsDisabled(deps)) {
    await replyHtml(ctx, '📅 Los vencimientos no están disponibles.');
    return;
  }
  const bills = deps.services.bills;
  const parsed = parseBillCommand(ctx.payload, { todayKey: bills.todayKey(now(deps)) });
  if (!parsed.ok) {
    await replyHtml(ctx, [
      '📅 <b>Cargar un vencimiento</b>',
      '',
      'Formato: <code>/vence &lt;fecha&gt; [monto] &lt;nombre&gt; [#mensual]</code>',
      '',
      'Ejemplos:',
      '• <code>/vence 15/11 45000 Luz Edesur</code>',
      '• <code>/vence 10 350000 Alquiler #mensual</code> (todos los días 10)',
      '• <code>/vence 2026-12-01 Patente</code> (sin monto)',
    ].join('\n'));
    return;
  }
  const categories = await deps.repos.categories.list();
  const category = matchCategory(parsed.name, categories);
  const bill = await bills.add({
    name: parsed.name,
    amountCents: parsed.amountCents,
    dueDate: parsed.dueDate,
    recurrence: parsed.recurrence,
    userId: ctx.state?.user?.id || null,
    categoryId: category?.id || null,
  });
  await replyHtml(ctx, [
    '📅 <b>Vencimiento agendado</b>',
    '',
    `${escapeHtml(bill.name)}${bill.recurrence ? ' 🔁 mensual' : ''}`,
    `Vence: <b>${escapeHtml(formatYmd(bill.dueDate))}</b>`,
    `Monto: <b>${escapeHtml(bills.amountLabel(bill))}</b>`,
    '',
    'Te aviso antes y el mismo día. Ver todos: /vencimientos',
  ].join('\n'));
});

export const handlePaid = safe('pagado', async (ctx, deps) => {
  if (billsDisabled(deps)) {
    await replyHtml(ctx, '📅 Los vencimientos no están disponibles.');
    return;
  }
  const reference = String(ctx.payload || '').trim();
  if (!reference) {
    const { html, keyboard } = await deps.services.bills.buildListMessage({ at: now(deps) });
    await replyHtml(ctx, `${html}\n\nUsá <code>/pagado &lt;número&gt;</code>.`, keyboard ? { reply_markup: keyboard } : {});
    return;
  }
  const bill = await deps.services.bills.resolveReference(reference, { at: now(deps) });
  if (!bill) {
    await replyHtml(ctx, `❌ No encontré el vencimiento <b>${escapeHtml(reference)}</b>. Mirá la lista con /vencimientos.`);
    return;
  }
  const result = await deps.services.bills.markPaid(bill.id, { at: now(deps) });
  if (!result.ok) {
    await replyHtml(ctx, `ℹ️ <b>${escapeHtml(bill.name)}</b> ya estaba marcado como ${bill.status === 'paid' ? 'pagado' : 'cancelado'}.`);
    return;
  }
  await replyHtml(ctx, paidMessage(deps, result));
});

async function handleBillPaidCallback(ctx, deps, billId) {
  if (billsDisabled(deps)) {
    await answerCallback(ctx, 'Vencimientos no disponibles.');
    return;
  }
  const result = await deps.services.bills.markPaid(billId, { at: now(deps) });
  if (!result.ok) {
    await answerCallback(ctx, result.reason === 'not-found' ? 'No encontré el vencimiento.' : 'Ya estaba marcado.');
    return;
  }
  await answerCallback(ctx, '✅ Marcado como pagado');
  await replyHtml(ctx, paidMessage(deps, result));
}

// ---------------------------------------------------------------------------
// Comando desconocido
// ---------------------------------------------------------------------------

export const handleUnknownCommand = safe('unknown-command', async (ctx, deps) => {
  await replyHtml(ctx, [
    '🤖 No conozco ese comando.',
    '',
    'Probá con /ayuda para ver la lista completa, o registrá un movimiento:',
    '<code>Gasté 15.000 en el super #comida</code>',
  ].join('\n'));
});
