import { formatDate, lastDaysRange, localParts, monthKey, monthLabel, monthRange, pad2, parseTimeOfDay, previousMonthKey, weekRange } from '../utils/dates.js';
import { buildSummaryMessage } from './reports.js';

const TICK_INTERVAL_MS = 30_000;

/**
 * Programador de resumenes diarios, semanales y mensuales.
 *
 * Cada job corre como maximo una vez por dia local. La marca se guarda en
 * settings (`scheduler.lastRun.<job>`) con la fecha local YYYY-MM-DD, por lo
 * que reiniciar el proceso no duplica envios y no se rellenan dias perdidos.
 *
 * @param {{config: object, repos: object, services: object, notifier: object, logger?: object, clock?: () => Date}} deps
 */
export function createScheduler({ config, repos, services, notifier, logger, clock = () => new Date() }) {
  const timezone = config.reports?.timezone || config.app.timezone;
  const currency = config.app.currency;
  const locale = config.app.locale;

  let tickTimer = null;
  let ticking = false;
  let lastTickAt = null;
  let lastRuns = [];

  /** Envia un resumen; nunca propaga errores del notificador. */
  async function sendSummary(jobName, html, extra = {}) {
    const chatId = config.telegram?.familyChatId;
    if (!chatId) {
      logger?.warn?.('scheduler: resumen sin chat familiar configurado', { job: jobName });
      return { sent: false, reason: 'sin-destino' };
    }
    try {
      const result = await notifier.sendMessage(String(chatId), html, extra);
      if (result?.ok === false) {
        logger?.warn?.('scheduler: el resumen no se pudo enviar', {
          job: jobName,
          reason: result?.reason || 'envio-fallido',
        });
        return { sent: false, reason: result?.reason || 'envio-fallido' };
      }
      return { sent: true };
    } catch (error) {
      logger?.warn?.('scheduler: fallo el envio del resumen', {
        job: jobName,
        error: error?.message || String(error),
      });
      return { sent: false, reason: 'error', error: error?.message || String(error) };
    }
  }

  async function loadContext(at) {
    const [categories, goals] = await Promise.all([
      repos.categories.list(),
      repos.goals.list(),
    ]);
    return { categories, goals, at };
  }

  /** Resumen del dia en curso + evaluacion de umbrales del mes. */
  async function runDaily(at) {
    const range = lastDaysRange(1, at, timezone);
    const currentKey = monthKey(at, timezone);
    const context = await loadContext(at);
    const [totals, monthSnapshot] = await Promise.all([
      repos.transactions.totals({ from: range.startIso, to: range.endIso }),
      services.alerts.getSummary(currentKey),
    ]);

    try {
      await services.alerts.evaluateMonth(currentKey, { notify: true });
    } catch (error) {
      logger?.warn?.('scheduler: fallo la evaluacion de alertas del dia', {
        monthKey: currentKey,
        error: error?.message || String(error),
      });
    }

    const html = buildSummaryMessage({
      title: 'Resumen diario',
      monthKey: currentKey,
      rangeLabel: `Hoy · ${formatDate(at, timezone)}`,
      totals,
      budgetSummary: monthSnapshot.summary,
      categories: context.categories,
      goals: context.goals,
      currency,
      locale,
    });
    return sendSummary('daily', html);
  }

  /** Resumen de la semana actual (lunes a domingo). */
  async function runWeekly(at) {
    const range = weekRange(at, timezone);
    const currentKey = monthKey(at, timezone);
    const context = await loadContext(at);
    const [totals, monthSnapshot] = await Promise.all([
      repos.transactions.totals({ from: range.startIso, to: range.endIso }),
      services.alerts.getSummary(currentKey),
    ]);
    const lastDay = new Date(range.end.getTime() - 1);
    const html = buildSummaryMessage({
      title: 'Resumen semanal',
      monthKey: currentKey,
      rangeLabel: `Semana del ${formatDate(range.start, timezone)} al ${formatDate(lastDay, timezone)}`,
      totals,
      budgetSummary: monthSnapshot.summary,
      categories: context.categories,
      goals: context.goals,
      currency,
      locale,
    });
    return sendSummary('weekly', html);
  }

  /** Cierre del mes anterior; corre el dia 1. */
  async function runMonthly(at) {
    const currentKey = monthKey(at, timezone);
    const previousKey = previousMonthKey(currentKey);
    const range = monthRange(previousKey, timezone);
    const context = await loadContext(at);
    const [totals, previousSnapshot] = await Promise.all([
      repos.transactions.totals({ from: range.startIso, to: range.endIso }),
      services.alerts.getSummary(previousKey),
    ]);
    const lastDay = new Date(range.end.getTime() - 1);
    const html = buildSummaryMessage({
      title: `Cierre de mes · ${monthLabel(previousKey)}`,
      monthKey: previousKey,
      rangeLabel: `Del ${formatDate(range.start, timezone)} al ${formatDate(lastDay, timezone)}`,
      totals,
      budgetSummary: previousSnapshot.summary,
      categories: context.categories,
      goals: context.goals,
      currency,
      locale,
    });
    return sendSummary('monthly', html);
  }

  /** Recordatorio de vencimientos (vencidos + proximos segun DUE_REMINDER_DAYS). */
  async function runDueReminders(at) {
    const reminder = await services.bills.buildReminder({ at });
    if (!reminder.count) return { sent: false, reason: 'sin-vencimientos' };
    const extra = reminder.keyboard ? { reply_markup: reminder.keyboard } : {};
    const outcome = await sendSummary('dueReminders', reminder.html, extra);
    return { ...outcome, bills: reminder.count };
  }

  const jobs = [
    {
      name: 'daily',
      at: config.reports?.dailyAt,
      matches: () => true,
      run: runDaily,
    },
    {
      name: 'weekly',
      at: config.reports?.weeklyAt,
      matches: (parts) => parts.weekday === Number(config.reports?.weeklyDay),
      run: runWeekly,
    },
    {
      name: 'monthly',
      at: config.reports?.monthlyAt,
      matches: (parts) => parts.day === 1,
      run: runMonthly,
    },
  ];
  if (services.bills && config.reminders?.enabled !== false) {
    jobs.push({
      name: 'dueReminders',
      at: config.reminders?.at || '09:00',
      matches: () => true,
      run: runDueReminders,
    });
  }

  /**
   * Evalua que jobs estan vencidos y los ejecuta.
   * @param {Date|string|number} [now]
   * @returns {Promise<{ran: Array<object>, due: string[], skipped: Array<{job: string, reason: string}>}>}
   */
  async function tick(now = clock()) {
    const at = now instanceof Date ? now : new Date(now);
    const parts = localParts(at, timezone);
    const todayKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
    const minutes = parts.hour * 60 + parts.minute;
    const due = [];
    const ran = [];
    const skipped = [];

    for (const job of jobs) {
      const scheduledMinutes = parseTimeOfDay(job.at);
      if (scheduledMinutes === null) {
        skipped.push({ job: job.name, reason: 'hora-invalida' });
        continue;
      }
      if (!job.matches(parts)) {
        skipped.push({ job: job.name, reason: 'dia-no-corresponde' });
        continue;
      }
      if (minutes < scheduledMinutes) {
        skipped.push({ job: job.name, reason: 'fuera-de-hora' });
        continue;
      }

      const settingsKey = `scheduler.lastRun.${job.name}`;
      const lastRun = await repos.settings.get(settingsKey, null);
      if (lastRun === todayKey) {
        skipped.push({ job: job.name, reason: 'ya-ejecutado' });
        continue;
      }

      due.push(job.name);
      try {
        const outcome = await job.run(at);
        ran.push({ job: job.name, date: todayKey, ok: true, ...(outcome || {}) });
      } catch (error) {
        logger?.error?.('scheduler: fallo el job', {
          job: job.name,
          date: todayKey,
          error,
        });
        ran.push({
          job: job.name,
          date: todayKey,
          ok: false,
          error: error?.message || String(error),
        });
      }

      try {
        await repos.settings.set(settingsKey, todayKey);
      } catch (error) {
        logger?.error?.('scheduler: no pude marcar el job como ejecutado', {
          job: job.name,
          error,
        });
      }
    }

    lastRuns = ran;
    return { ran, due, skipped };
  }

  /** Ejecuta un tick sin solaparse con otro y sin lanzar. */
  async function safeTick(now) {
    if (ticking) return null;
    ticking = true;
    try {
      return await tick(now === undefined ? clock() : now);
    } catch (error) {
      logger?.error?.('scheduler: fallo inesperado del tick', { error });
      return null;
    } finally {
      ticking = false;
      lastTickAt = new Date().toISOString();
    }
  }

  /**
   * Arranca el scheduler: tick inmediato + chequeo cada 30 segundos.
   * @returns {Promise<{running: boolean, lastTickAt: string|null, lastRuns: Array<object>}>}
   */
  async function start() {
    if (tickTimer) return status();
    tickTimer = setInterval(() => {
      void safeTick();
    }, TICK_INTERVAL_MS);
    tickTimer.unref?.();
    await safeTick();
    return status();
  }

  /** Detiene el scheduler y libera el interval. */
  function stop() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  /** Estado observable para healthchecks y tests. */
  function status() {
    return {
      running: Boolean(tickTimer),
      lastTickAt,
      lastRuns,
    };
  }

  return {
    start,
    stop,
    tick,
    status,
  };
}
