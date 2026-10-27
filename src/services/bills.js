/**
 * Vencimientos: facturas y pagos con fecha limite.
 *
 * - Se crean solos cuando una factura (foto, PDF o email) trae vencimiento.
 * - Se cargan a mano con /vence (con #mensual para alquiler, expensas, etc.).
 * - El scheduler manda un recordatorio diario con lo que vence en los dias
 *   configurados (DUE_REMINDER_DAYS, default 3,1,0) y todo lo vencido.
 * - /pagado o el boton "Pagué" los cierra; los mensuales generan el proximo.
 */

import { localParts, pad2, parseHumanDate } from '../utils/dates.js';
import { formatCents, parseAmountToCents } from '../utils/money.js';
import { escapeHtml } from '../utils/telegram-html.js';
import { StoreError } from '../db/rows.js';

export const BILL_CALLBACK_PREFIX = 'bill';
const DAY_MS = 86_400_000;
const LIST_HORIZON_DAYS = 45;
const MAX_BUTTONS = 8;

/** 'YYYY-MM-DD' -> dias UTC desde epoch (para restar fechas sin husos). */
function dayNumber(ymd) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

function ymdFromDayNumber(days) {
  const date = new Date(days * DAY_MS);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Suma dias a una fecha YYYY-MM-DD. */
export function addDays(ymd, delta) {
  return ymdFromDayNumber(dayNumber(ymd) + delta);
}

/** Mismo dia del mes siguiente (ajusta 31 -> ultimo dia del mes). */
export function nextMonthlyDate(ymd, preferredDay = null) {
  const [year, month, day] = String(ymd).split('-').map(Number);
  const targetDay = preferredDay || day;
  const nextMonthIndex = month; // 0-based del mes siguiente
  const nextYear = year + Math.floor(nextMonthIndex / 12);
  const nextMonth = (nextMonthIndex % 12) + 1;
  const lastDay = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
  return `${nextYear}-${pad2(nextMonth)}-${pad2(Math.min(targetDay, lastDay))}`;
}

/** Dias entre hoy y el vencimiento (negativo = vencido). */
export function daysUntil(dueDate, todayKey) {
  return dayNumber(dueDate) - dayNumber(todayKey);
}

function shortDate(ymd) {
  const [, month, day] = String(ymd).split('-');
  return `${day}/${month}`;
}

function whenLabel(days) {
  if (days === 0) return 'hoy';
  if (days === 1) return 'mañana';
  if (days > 1) return `en ${days} días`;
  if (days === -1) return 'venció ayer';
  return `venció hace ${Math.abs(days)} días`;
}

/**
 * Interpreta "/vence <fecha> <monto> <descripcion> [#mensual]".
 * Fecha: 15/11, 15/11/2026, 2026-11-15 o solo el dia ("10" = proximo dia 10).
 * El monto es opcional.
 */
export function parseBillCommand(args, { todayKey }) {
  const raw = String(args || '').trim();
  if (!raw) return { ok: false, reason: 'vacio' };

  const monthly = /(^|\s)#mensual\b/i.test(raw);
  const tokens = raw.replace(/(^|\s)#mensual\b/gi, ' ').trim().split(/\s+/);
  const dateToken = tokens.shift() || '';

  let dueDate = null;
  let preferredDay = null;
  const [todayYear, todayMonth, todayDay] = todayKey.split('-').map(Number);
  if (/^\d{1,2}$/.test(dateToken)) {
    const day = Number(dateToken);
    if (day < 1 || day > 31) return { ok: false, reason: 'fecha-invalida' };
    preferredDay = day;
    const lastDay = new Date(Date.UTC(todayYear, todayMonth, 0)).getUTCDate();
    dueDate = `${todayYear}-${pad2(todayMonth)}-${pad2(Math.min(day, lastDay))}`;
    if (day < todayDay) dueDate = nextMonthlyDate(dueDate, day);
  } else {
    dueDate = parseHumanDate(dateToken, { defaultYear: todayYear });
    if (!dueDate) return { ok: false, reason: 'fecha-invalida' };
    const hasYear = /\d{4}/.test(dateToken) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2}$/.test(dateToken);
    if (!hasYear && dueDate < todayKey) dueDate = `${todayYear + 1}${dueDate.slice(4)}`;
  }

  let amountCents = null;
  const amountIndex = tokens.findIndex((token) => /\d/.test(token) && parseAmountToCents(token) > 0);
  if (amountIndex >= 0) {
    amountCents = parseAmountToCents(tokens[amountIndex]);
    tokens.splice(amountIndex, 1);
  }

  const name = tokens.join(' ').replace(/\s+/g, ' ').trim();
  if (!name) return { ok: false, reason: 'sin-nombre' };

  return {
    ok: true,
    name,
    amountCents,
    dueDate,
    recurrence: monthly ? 'monthly' : null,
    preferredDay,
  };
}

/** Teclado con un boton "Pagué" por vencimiento (max 8). */
export function billsKeyboard(bills) {
  const rows = (bills || []).slice(0, MAX_BUTTONS).map((bill) => [{
    text: `✅ Pagué: ${String(bill.name).slice(0, 40)}`,
    callback_data: `${BILL_CALLBACK_PREFIX}:paid:${bill.id}`,
  }]);
  return rows.length ? { inline_keyboard: rows } : null;
}

/** Parsea callback_data "bill:paid:<id>". */
export function parseBillCallback(data) {
  const parts = String(data || '').split(':');
  if (parts[0] !== BILL_CALLBACK_PREFIX || parts[1] !== 'paid' || !parts[2]) return null;
  return { action: 'paid', billId: parts[2] };
}

export function createBillsService({ repos, config, logger, clock = () => new Date() }) {
  const timezone = config.reports?.timezone || config.app.timezone;
  const currency = config.app.currency;
  const locale = config.app.locale;
  const reminderDays = Array.isArray(config.reminders?.days) && config.reminders.days.length
    ? config.reminders.days
    : [3, 1, 0];

  function todayKey(at = clock()) {
    const parts = localParts(at, timezone);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }

  function amountLabel(bill) {
    if (!Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0) return 'monto a confirmar';
    return formatCents(bill.amountCents, bill.currency || currency, locale);
  }

  function billLine(bill, today, index = null) {
    const days = daysUntil(bill.dueDate, today);
    const prefix = index === null ? '•' : `<b>${index}.</b>`;
    const recurring = bill.recurrence === 'monthly' ? ' 🔁' : '';
    return `${prefix} ${escapeHtml(bill.name)}${recurring} — <b>${escapeHtml(amountLabel(bill))}</b> · ${shortDate(bill.dueDate)} (${whenLabel(days)})`;
  }

  /** Crea un vencimiento (a mano o desde una factura). */
  async function add({
    name, amountCents = null, dueDate, recurrence = null, userId = null, categoryId = null,
    currency: billCurrency = currency, documentId = null,
  }) {
    const bill = await repos.bills.create({
      name, amountCents, dueDate, recurrence, userId, categoryId, currency: billCurrency, documentId,
    });
    logger?.info?.('vencimiento creado', { billId: bill.id, dueDate: bill.dueDate, recurrence: bill.recurrence });
    return bill;
  }

  /** Crea (una sola vez) el vencimiento de una factura con fecha limite. */
  async function trackDocument(document) {
    if (!document?.id || !document.dueDate) return null;
    const existing = await repos.bills.getByDocument(document.id);
    if (existing) return existing;
    return add({
      name: document.vendor || document.extracted?.description || document.fileName || 'Factura',
      amountCents: Number.isSafeInteger(document.totalCents) && document.totalCents > 0 ? document.totalCents : null,
      dueDate: document.dueDate,
      userId: document.userId || null,
      categoryId: document.categoryId || null,
      currency: document.currency || currency,
      documentId: document.id,
    });
  }

  /** Actualiza monto/categoria del vencimiento cuando se corrige la factura. */
  async function syncDocument(document) {
    if (!document?.id) return null;
    const bill = await repos.bills.getByDocument(document.id);
    if (!bill || bill.status !== 'pending') return bill;
    const patch = {};
    if (Number.isSafeInteger(document.totalCents) && document.totalCents > 0) patch.amountCents = document.totalCents;
    if (document.categoryId) patch.categoryId = document.categoryId;
    if (!Object.keys(patch).length) return bill;
    return repos.bills.update(bill.id, patch);
  }

  /** Si se descarta la factura, su vencimiento deja de recordarse. */
  async function cancelForDocument(documentId) {
    const bill = await repos.bills.getByDocument(documentId);
    if (!bill || bill.status !== 'pending') return null;
    return repos.bills.update(bill.id, { status: 'cancelled' });
  }

  /** Pendientes: vencidos + los proximos `horizonDays` dias, por fecha. */
  async function listPending({ horizonDays = LIST_HORIZON_DAYS, at = clock() } = {}) {
    const today = todayKey(at);
    const bills = await repos.bills.list({ status: 'pending', to: addDays(today, horizonDays) });
    return { today, bills };
  }

  /**
   * Marca un vencimiento como pagado. Si es mensual, crea el del mes que viene.
   * @returns {Promise<{ok: boolean, bill?: object, next?: object|null, reason?: string}>}
   */
  async function markPaid(billId, { at = clock() } = {}) {
    const bill = await repos.bills.get(billId);
    if (!bill) return { ok: false, reason: 'not-found' };
    if (bill.status !== 'pending') return { ok: false, reason: 'already-closed', bill };
    const paid = await repos.bills.update(bill.id, { status: 'paid', paidAt: at.toISOString() });
    let next = null;
    if (bill.recurrence === 'monthly') {
      next = await repos.bills.create({
        name: bill.name,
        amountCents: bill.amountCents,
        currency: bill.currency,
        dueDate: nextMonthlyDate(bill.dueDate),
        recurrence: 'monthly',
        userId: bill.userId,
        categoryId: bill.categoryId,
      });
    }
    logger?.info?.('vencimiento pagado', { billId: bill.id, nextBillId: next?.id || null });
    return { ok: true, bill: paid, next };
  }

  /** Lista numerada para /vencimientos (el numero sirve para /pagado). */
  async function buildListMessage({ at = clock() } = {}) {
    const { today, bills } = await listPending({ at });
    if (!bills.length) {
      return {
        html: [
          '📅 <b>Vencimientos</b>',
          '',
          'No hay vencimientos pendientes en los próximos 45 días. 🎉',
          '',
          'Cargá uno con <code>/vence 10/11 45000 Luz</code>',
          'o uno mensual con <code>/vence 10 350000 Alquiler #mensual</code>.',
        ].join('\n'),
        bills,
        keyboard: null,
      };
    }
    const lines = ['📅 <b>Vencimientos pendientes</b>', ''];
    bills.forEach((bill, index) => lines.push(billLine(bill, today, index + 1)));
    lines.push('', 'Marcá uno como pagado con <code>/pagado 1</code> o con los botones.');
    return { html: lines.join('\n'), bills, keyboard: billsKeyboard(bills) };
  }

  /**
   * Recordatorio del dia: vencidos + los que vencen en los dias configurados.
   * @returns {Promise<{count: number, html: string|null, keyboard: object|null, bills: object[]}>}
   */
  async function buildReminder({ at = clock() } = {}) {
    const today = todayKey(at);
    const maxDays = Math.max(...reminderDays, 0);
    const pending = await repos.bills.list({ status: 'pending', to: addDays(today, maxDays) });
    const overdue = [];
    const upcoming = [];
    for (const bill of pending) {
      const days = daysUntil(bill.dueDate, today);
      if (days < 0) overdue.push(bill);
      else if (reminderDays.includes(days)) upcoming.push(bill);
    }
    const bills = [...overdue, ...upcoming];
    if (!bills.length) return { count: 0, html: null, keyboard: null, bills };

    const lines = ['⏰ <b>Recordatorio de vencimientos</b>'];
    if (overdue.length) {
      lines.push('', '🔴 <b>Vencidos</b>');
      overdue.forEach((bill) => lines.push(billLine(bill, today)));
    }
    const dueToday = upcoming.filter((bill) => bill.dueDate === today);
    const soon = upcoming.filter((bill) => bill.dueDate !== today);
    if (dueToday.length) {
      lines.push('', '🟠 <b>Vencen hoy</b>');
      dueToday.forEach((bill) => lines.push(billLine(bill, today)));
    }
    if (soon.length) {
      lines.push('', '🟡 <b>Próximos</b>');
      soon.forEach((bill) => lines.push(billLine(bill, today)));
    }
    lines.push('', 'Cuando lo pagues, tocá el botón o usá /pagado.');
    return { count: bills.length, html: lines.join('\n'), keyboard: billsKeyboard(bills), bills };
  }

  /** Resuelve "/pagado 2" (numero de /vencimientos) o un id. */
  async function resolveReference(reference, { at = clock() } = {}) {
    const raw = String(reference || '').trim();
    if (!raw) throw new StoreError('Indicá el número del vencimiento.', { code: 'BILL_REFERENCE' });
    if (/^\d{1,3}$/.test(raw)) {
      const { bills } = await listPending({ at });
      return bills[Number(raw) - 1] || null;
    }
    return repos.bills.get(raw);
  }

  return {
    todayKey,
    add,
    trackDocument,
    syncDocument,
    cancelForDocument,
    listPending,
    markPaid,
    buildListMessage,
    buildReminder,
    resolveReference,
    amountLabel,
  };
}
