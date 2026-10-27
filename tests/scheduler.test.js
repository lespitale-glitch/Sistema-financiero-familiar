import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/index.js';
import { DEFAULT_CATEGORIES } from '../src/domain.js';
import { createLogger } from '../src/logger.js';
import { createAlertsService } from '../src/services/alerts.js';
import { createScheduler } from '../src/services/scheduler.js';

const silentLogger = createLogger({ level: 'silent' });

function tempDbPath() {
  return path.join(os.tmpdir(), `finanzas-scheduler-${process.pid}-${randomUUID()}.sqlite`);
}

function removeDb(filePath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${filePath}${suffix}`, { force: true });
    } catch {
      // limpieza best-effort
    }
  }
}

function makeConfig(overrides = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    SQLITE_PATH: tempDbPath(),
    API_TOKEN: 'api-test',
    FAMILY_MEMBERS: 'Ana|wife|111|ana@example.com',
    FAMILY_CHAT_ID: '777',
    TZ: 'UTC',
    CURRENCY: 'ARS',
    LOCALE: 'es-AR',
    ALERTS_ENABLED: 'false',
    DAILY_SUMMARY_AT: '21:00',
    WEEKLY_SUMMARY_DAY: '1',
    WEEKLY_SUMMARY_AT: '09:00',
    MONTHLY_SUMMARY_AT: '08:00',
    ...overrides,
  });
}

function createRecordingNotifier(options = {}) {
  const messages = [];
  return {
    available: true,
    messages,
    async sendMessage(chatId, html, extra = {}) {
      if (options.fail) throw new Error('telegram caído');
      messages.push({ chatId, html, extra });
      return { ok: true, messageId: messages.length };
    },
  };
}

async function setup({ notifier, env = {} } = {}) {
  const config = makeConfig(env);
  const repos = await createDatabase(config, { logger: silentLogger });
  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
  const alertClock = () => new Date('2026-10-15T15:00:00.000Z');
  const alerts = createAlertsService({ repos, config, notifier, logger: silentLogger, clock: alertClock });
  const fakeNotifier = notifier || createRecordingNotifier();
  const scheduler = createScheduler({
    config,
    repos,
    services: { alerts },
    notifier: fakeNotifier,
    logger: silentLogger,
    clock: () => new Date('2026-10-15T12:00:00.000Z'),
  });
  return { config, repos, alerts, notifier: fakeNotifier, scheduler };
}

function cleanup(t, ctx) {
  t.after(async () => {
    const filePath = ctx.repos.store.filePath;
    ctx.scheduler.stop();
    await ctx.repos.close();
    removeDb(filePath);
  });
}

test('el resumen diario corre una sola vez por dia', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const first = await ctx.scheduler.tick(new Date('2026-10-15T21:00:00.000Z'));
  assert.equal(first.ran.length, 1);
  assert.equal(first.ran[0].job, 'daily');
  assert.equal(first.ran[0].ok, true);
  assert.equal(first.ran[0].sent, true);
  assert.equal(ctx.notifier.messages.length, 1);
  assert.match(ctx.notifier.messages[0].html, /Resumen diario/i);
  assert.equal(ctx.notifier.messages[0].chatId, '777');

  const marked = await ctx.repos.settings.get('scheduler.lastRun.daily', null);
  assert.equal(marked, '2026-10-15');

  const second = await ctx.scheduler.tick(new Date('2026-10-15T23:30:00.000Z'));
  assert.equal(second.ran.length, 0);
  assert.equal(second.due.length, 0);
  assert.ok(second.skipped.some((item) => item.job === 'daily' && item.reason === 'ya-ejecutado'));
  assert.equal(ctx.notifier.messages.length, 1);
});

test('antes de la hora configurada no se envia nada', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.scheduler.tick(new Date('2026-10-15T20:59:00.000Z'));
  assert.equal(result.ran.length, 0);
  assert.equal(result.due.length, 0);
  assert.ok(result.skipped.some((item) => item.job === 'daily' && item.reason === 'fuera-de-hora'));
  assert.equal(ctx.notifier.messages.length, 0);
  assert.equal(await ctx.repos.settings.get('scheduler.lastRun.daily', null), null);
});

test('el resumen semanal solo corre en el dia configurado', async (t) => {
  const wrongDay = await setup();
  cleanup(t, wrongDay);

  // 14/10/2026 es miercoles; el semanal esta configurado para lunes.
  const wednesday = await wrongDay.scheduler.tick(new Date('2026-10-14T09:10:00.000Z'));
  assert.equal(wednesday.ran.length, 0);
  assert.ok(wednesday.skipped.some((item) => item.job === 'weekly' && item.reason === 'dia-no-corresponde'));
  assert.equal(wrongDay.notifier.messages.length, 0);

  const rightDay = await setup();
  cleanup(t, rightDay);

  // 12/10/2026 es lunes.
  const monday = await rightDay.scheduler.tick(new Date('2026-10-12T09:10:00.000Z'));
  assert.equal(monday.ran.length, 1);
  assert.equal(monday.ran[0].job, 'weekly');
  assert.equal(rightDay.notifier.messages.length, 1);
  assert.match(rightDay.notifier.messages[0].html, /Resumen semanal/i);
  assert.equal(await rightDay.repos.settings.get('scheduler.lastRun.weekly', null), '2026-10-12');
});

test('el cierre mensual del dia 1 usa el mes anterior', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.scheduler.tick(new Date('2026-11-01T08:10:00.000Z'));
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].job, 'monthly');
  assert.equal(ctx.notifier.messages.length, 1);
  assert.match(ctx.notifier.messages[0].html, /octubre/i);
  assert.doesNotMatch(ctx.notifier.messages[0].html, /noviembre/i);
  assert.equal(await ctx.repos.settings.get('scheduler.lastRun.monthly', null), '2026-11-01');
});

test('el cierre mensual no se ejecuta fuera del dia 1', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  const result = await ctx.scheduler.tick(new Date('2026-11-02T08:10:00.000Z'));
  assert.equal(result.ran.length, 0);
  assert.ok(result.skipped.some((item) => item.job === 'monthly' && item.reason === 'dia-no-corresponde'));
  assert.equal(ctx.notifier.messages.length, 0);
  assert.equal(await ctx.repos.settings.get('scheduler.lastRun.monthly', null), null);
});

test('un fallo del notificador no propaga el error y no reintenta en el dia', async (t) => {
  const notifier = createRecordingNotifier({ fail: true });
  const ctx = await setup({ notifier });
  cleanup(t, ctx);

  const result = await ctx.scheduler.tick(new Date('2026-10-15T21:00:00.000Z'));
  assert.equal(result.ran.length, 1);
  assert.equal(result.ran[0].ok, true);
  assert.equal(result.ran[0].sent, false);
  assert.equal(result.ran[0].reason, 'error');
  assert.equal(await ctx.repos.settings.get('scheduler.lastRun.daily', null), '2026-10-15');

  const second = await ctx.scheduler.tick(new Date('2026-10-15T22:00:00.000Z'));
  assert.equal(second.ran.length, 0);
});

test('start y stop controlan el interval sin dejarlo activo', async (t) => {
  const ctx = await setup();
  cleanup(t, ctx);

  await ctx.scheduler.start();
  assert.equal(ctx.scheduler.status().running, true);
  assert.ok(ctx.scheduler.status().lastTickAt);
  assert.equal(ctx.notifier.messages.length, 0);

  ctx.scheduler.stop();
  assert.equal(ctx.scheduler.status().running, false);
});
