import { EXPENSE_TYPES, TYPE_META } from '../domain.js';
import { formatCents } from '../utils/money.js';
import { monthKey, monthLabel, monthRange } from '../utils/dates.js';
import { escapeHtml, progressBar } from '../utils/telegram-html.js';
import { buildBudgetSummary, evaluateBudgetAlerts } from './budgets.js';

/**
 * Servicio de presupuestos y alertas. Calcula el estado del mes, decide que
 * umbrales se cruzaron y notifica al chat familiar y/o al autor.
 */
export function createAlertsService({
  repos,
  config,
  notifier,
  logger,
  clock = () => new Date(),
}) {
  const timezone = config.app.timezone;
  const currency = config.app.currency;
  const locale = config.app.locale;

  async function overallBudget() {
    const stored = await repos.settings.get('budget.overall_cents', null);
    return Number.isSafeInteger(stored) && stored > 0 ? stored : null;
  }

  async function getSummary(monthKeyValue) {
    const key = monthKeyValue || monthKey(clock(), timezone);
    const range = monthRange(key, timezone);
    const [categories, totals, overallBudgetCents] = await Promise.all([
      repos.categories.list({ includeInactive: false }),
      repos.transactions.totals({ from: range.start, to: range.end }),
      overallBudget(),
    ]);
    const summary = buildBudgetSummary({
      categories,
      transactions: totals.transactions,
      overallBudgetCents,
      thresholds: config.alerts.thresholds,
    });
    return {
      monthKey: key,
      range,
      categories,
      transactions: totals.transactions,
      totals,
      summary,
      overallBudgetCents,
    };
  }

  function buildAlertMessage(alert) {
    const meta = TYPE_META.variable_expense;
    const title = alert.scope === 'overall' ? 'Presupuesto general' : `${alert.emoji || '🏷️'} ${alert.categoryName}`;
    const isExceeded = alert.percent >= 100;
    const header = isExceeded
      ? `🚨 <b>Presupuesto superado</b> · ${escapeHtml(monthLabel(alert.periodKey))}`
      : `⚠️ <b>Umbral de presupuesto ${alert.threshold}%</b> · ${escapeHtml(monthLabel(alert.periodKey))}`;
    const difference = Math.abs(alert.remainingCents);
    const detail = isExceeded
      ? `Excedido por <b>${formatCents(difference, currency, locale)}</b>`
      : `Te quedan <b>${formatCents(alert.remainingCents, currency, locale)}</b>`;
    const lines = [
      header,
      '',
      `<b>${escapeHtml(title)}</b>`,
      `${progressBar(alert.percent)} <b>${alert.percent}%</b>`,
      `Gastado: <b>${formatCents(alert.spentCents, currency, locale)}</b> de ${formatCents(alert.budgetCents, currency, locale)}`,
      detail,
    ];
    if (alert.lastTransactionCents) {
      lines.push(`Ultimo movimiento: ${formatCents(alert.lastTransactionCents, currency, locale)}${alert.lastUserName ? ` (${escapeHtml(alert.lastUserName)})` : ''}`);
    }
    if (isExceeded) {
      lines.push('', `💡 Revisa los gastos de la categoria o ajusta el limite con /presupuesto_set.`);
    }
    return lines.join('\n');
  }

  async function notifyAlert(alert) {
    if (!notifier?.available) return { sent: false, reason: 'notifier-unavailable' };
    const claimed = await repos.alerts.claim(alert.key, {
      categoryId: alert.categoryId,
      threshold: alert.threshold,
      period: alert.periodKey,
      payload: {
        scope: alert.scope,
        percent: alert.percent,
        spentCents: alert.spentCents,
        budgetCents: alert.budgetCents,
      },
    });
    if (!claimed) return { sent: false, reason: 'duplicate' };

    const text = buildAlertMessage(alert);
    const targets = [];
    if (config.telegram.familyChatId) targets.push(String(config.telegram.familyChatId));
    if (config.telegram.alertAuthorDm && alert.authorTelegramId) {
      const author = String(alert.authorTelegramId);
      if (!targets.includes(author)) targets.push(author);
    }
    if (targets.length === 0) {
      logger?.warn?.('alerta sin destino de Telegram', { key: alert.key });
      return { sent: false, reason: 'no-target' };
    }

    const results = [];
    for (const chatId of targets) {
      results.push(await notifier.sendMessage(chatId, text));
    }
    return { sent: results.some((result) => result.ok), results };
  }

  /**
   * Evalua umbrales disparados por un movimiento. Solo revisa la categoria
   * afectada y el presupuesto general para evitar spam historico.
   */
  async function evaluateForTransaction(transaction, { notify = true, userName = null } = {}) {
    if (!config.alerts.enabled) return { skipped: true, reason: 'alerts-disabled', alerts: [] };
    if (!transaction || !EXPENSE_TYPES.includes(transaction.type)) {
      return { skipped: true, reason: 'not-an-expense', alerts: [] };
    }
    const key = monthKey(transaction.occurredAt, timezone);
    const snapshot = await getSummary(key);
    const alerts = evaluateBudgetAlerts({
      summary: snapshot.summary,
      thresholds: config.alerts.thresholds,
      periodKey: key,
      onlyCategoryId: transaction.categoryId,
      includeOverall: true,
    }).map((alert) => ({
      ...alert,
      periodKey: key,
      lastTransactionCents: transaction.amountCents,
      lastUserName: userName,
      authorTelegramId: null,
    }));

    const author = transaction.userId ? await repos.users.get(transaction.userId) : null;
    for (const alert of alerts) alert.authorTelegramId = author?.telegramId || null;

    const deliveries = [];
    if (notify) {
      for (const alert of alerts) deliveries.push(await notifyAlert(alert));
    }
    return { skipped: false, monthKey: key, summary: snapshot.summary, alerts, deliveries };
  }

  /**
   * Evalua todos los umbrales del mes (usado por el scheduler o /alertas_test).
   */
  async function evaluateMonth(monthKeyValue = null, { notify = true } = {}) {
    if (!config.alerts.enabled && notify) {
      return { skipped: true, reason: 'alerts-disabled', alerts: [] };
    }
    const snapshot = await getSummary(monthKeyValue);
    const alerts = evaluateBudgetAlerts({
      summary: snapshot.summary,
      thresholds: config.alerts.thresholds,
      periodKey: snapshot.monthKey,
      includeOverall: true,
    }).map((alert) => ({ ...alert, periodKey: snapshot.monthKey, authorTelegramId: null }));

    const deliveries = [];
    if (notify) {
      for (const alert of alerts) deliveries.push(await notifyAlert(alert));
    }
    return {
      skipped: false,
      monthKey: snapshot.monthKey,
      summary: snapshot.summary,
      alerts,
      deliveries,
    };
  }

  return {
    getSummary,
    evaluateForTransaction,
    evaluateMonth,
    buildAlertMessage,
  };
}
