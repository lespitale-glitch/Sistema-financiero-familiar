/**
 * Avisos de movimientos con el saldo del mes actualizado.
 *
 * - balanceLine(): "💰 Noviembre 2026 · Ingresos $X · Gastos $Y · Saldo $Z"
 *   (se agrega a cada confirmacion).
 * - announce(): manda un aviso privado a MOVEMENT_NOTIFY_IDS por cada
 *   movimiento nuevo, borrado o restaurado. No lo manda si la confirmacion ya
 *   le llego a esa persona (su chat privado o el grupo familiar).
 */

import { TYPE_META } from '../domain.js';
import { formatCents } from '../utils/money.js';
import { monthKey, monthLabel, monthRange } from '../utils/dates.js';
import { escapeHtml } from '../utils/telegram-html.js';

const SOURCE_LABELS = {
  text: 'texto',
  voice: 'audio',
  document: 'foto o PDF',
  email: 'banco / email',
  api: 'API',
  import: 'importación',
};

const ACTION_TITLES = {
  created: '🔔 <b>Nuevo movimiento</b>',
  deleted: '🗑️ <b>Movimiento borrado</b>',
  restored: '↩️ <b>Movimiento restaurado</b>',
};

export function createMovementsService({ config, repos, notifier, logger, clock = () => new Date() }) {
  const timezone = config.reports?.timezone || config.app.timezone;
  const currency = config.app.currency;
  const locale = config.app.locale;
  const recipients = (config.telegram?.movementNotifyIds || []).map(String);
  const familyChatId = config.telegram?.familyChatId ? String(config.telegram.familyChatId) : null;

  const money = (cents) => formatCents(cents, currency, locale);

  /** Totales del mes del movimiento (o del mes actual). */
  async function monthTotals(at = clock()) {
    const key = monthKey(at instanceof Date ? at : new Date(at), timezone);
    const range = monthRange(key, timezone);
    const totals = await repos.transactions.totals({ from: range.start, to: range.end });
    const income = totals.incomeCents || 0;
    const expense = totals.expenseCents || 0;
    const investment = totals.investmentCents || 0;
    return { key, income, expense, investment, balance: income - expense - investment };
  }

  async function balanceLine(at = clock()) {
    try {
      const t = await monthTotals(at);
      const parts = [`Ingresos ${money(t.income)}`, `Gastos ${money(t.expense)}`];
      if (t.investment) parts.push(`Inversiones ${money(t.investment)}`);
      const sign = t.balance < 0 ? '-' : '';
      return `💰 <b>${escapeHtml(monthLabel(t.key))}</b> · ${parts.join(' · ')} · Saldo <b>${sign}${money(Math.abs(t.balance))}</b>`;
    } catch (error) {
      logger?.warn?.('no pude calcular el saldo del mes', { error: error?.message || String(error) });
      return '';
    }
  }

  function alreadySeen(recipient, chatId) {
    if (!chatId) return false;
    const chat = String(chatId);
    return chat === recipient || (familyChatId !== null && chat === familyChatId);
  }

  /**
   * @param {{transaction: object, category?: object|null, action?: 'created'|'deleted'|'restored',
   *   userName?: string|null, chatId?: string|number|null}} input
   */
  async function announce({ transaction, category = null, action = 'created', userName = null, chatId = null }) {
    if (!transaction || !recipients.length || !notifier?.sendMessage) return { sent: 0 };
    const targets = recipients.filter((recipient) => !alreadySeen(recipient, chatId));
    if (!targets.length) return { sent: 0 };

    const meta = TYPE_META[transaction.type] || { label: 'Movimiento', emoji: '•', sign: '' };
    let who = userName;
    if (!who && transaction.userId) {
      try { who = (await repos.users.get(transaction.userId))?.name || null; } catch { who = null; }
    }
    const detail = [category?.name, transaction.note].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(' · ');
    const lines = [
      ACTION_TITLES[action] || ACTION_TITLES.created,
      `${meta.emoji} ${escapeHtml(meta.label)}: <b>${meta.sign}${money(transaction.amountCents)}</b>${detail ? ` · ${escapeHtml(detail)}` : ''}`,
      [who ? `Por ${escapeHtml(who)}` : '', SOURCE_LABELS[transaction.source] ? `desde ${SOURCE_LABELS[transaction.source]}` : '']
        .filter(Boolean).join(' '),
      '',
      await balanceLine(transaction.occurredAt || clock()),
    ].filter((line, index) => line !== '' || index === 3);

    let sent = 0;
    for (const target of targets) {
      try {
        const result = await notifier.sendMessage(target, lines.join('\n'));
        if (result?.ok !== false) sent += 1;
      } catch (error) {
        logger?.warn?.('no pude avisar el movimiento', { target, error: error?.message || String(error) });
      }
    }
    logger?.info?.('aviso de movimiento enviado', { transactionId: transaction.id, action, sent });
    return { sent };
  }

  return { balanceLine, announce, monthTotals };
}
