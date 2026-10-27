/**
 * Pruebas de las utilidades base: dinero, fechas, HTML de Telegram,
 * configuracion y dominio.
 * Ejecutar: node --test tests/foundation.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatCents,
  formatCentsPlain,
  formatSignedCents,
  isPositiveCents,
  parsePercent,
  percentOf,
  sumCents,
  toCents,
} from '../src/utils/money.js';
import {
  addMonths,
  dayRange,
  formatTime,
  isValidMonthKey,
  localParts,
  monthKey,
  monthLabel,
  monthRange,
  nextMonthKey,
  pad2,
  parseTimeOfDay,
  previousMonthKey,
  resolveMonthKey,
  weekRange,
} from '../src/utils/dates.js';
import {
  bold,
  clampMessage,
  escapeHtml,
  italic,
  progressBar,
  splitMessage,
} from '../src/utils/telegram-html.js';
import { loadConfig } from '../src/config.js';
import {
  DEFAULT_CATEGORIES,
  EXPENSE_TYPES,
  FALLBACK_CATEGORY_NAME,
  TRANSACTION_TYPES,
  TYPE_LIST,
} from '../src/domain.js';
import { TEST_ENV } from './helpers/bot-harness.js';

const TZ = 'America/Argentina/Buenos_Aires';

// ---------------------------------------------------------------------------
// Dinero
// ---------------------------------------------------------------------------

test('toCents convierte montos a centavos con redondeo', () => {
  assert.equal(toCents(15.5), 1550);
  assert.equal(toCents('2.5'), 250);
  assert.equal(toCents(-3), -300);
});

test('formatCents usa el formato regional ARS', () => {
  assert.equal(formatCents(700_000, 'ARS', 'es-AR'), '$ 7.000');
  assert.equal(formatCents(150_0050, 'ARS', 'es-AR'), '$ 15.000,50');
  assert.equal(formatCents(-5_000_000, 'ARS', 'es-AR'), '-$ 50.000');
  assert.match(formatCentsPlain(12_3456, 'es-AR'), /1\.234,56/);
  assert.equal(formatSignedCents(50_000, 'ARS', 'es-AR'), '+$ 500');
});

test('sumCents y percentOf', () => {
  assert.equal(sumCents([100, 250, 50]), 400);
  assert.equal(sumCents([]), 0);
  assert.equal(percentOf(7_000_000, 35_000_000), 20);
  assert.equal(percentOf(0, 35_000_000), 0);
  assert.equal(percentOf(40_000_000, 35_000_000), 114);
  assert.equal(percentOf(1_000, null), null);
  assert.equal(parsePercent('125'), 125);
  assert.equal(isPositiveCents(1), true);
  assert.equal(isPositiveCents(0), false);
  assert.equal(isPositiveCents(-10), false);
});

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

test('pad2 y claves de mes', () => {
  assert.equal(pad2(3), '03');
  assert.equal(isValidMonthKey('2026-10'), true);
  assert.equal(isValidMonthKey('2026-13'), false);
  assert.equal(isValidMonthKey('hola'), false);
  assert.equal(addMonths('2026-10', -2), '2026-08');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(previousMonthKey('2026-10'), '2026-09');
  assert.equal(nextMonthKey('2026-10'), '2026-11');
  assert.equal(monthLabel('2026-10'), 'Octubre 2026');
});

test('monthKey respeta la zona horaria', () => {
  // 2026-11-01 01:30 UTC son 22:30 del 31/10 en Argentina.
  assert.equal(monthKey(new Date('2026-11-01T01:30:00Z'), TZ), '2026-10');
  assert.equal(monthKey(new Date('2026-10-15T12:00:00Z'), TZ), '2026-10');
  assert.equal(monthKey(new Date('2026-12-01T01:30:00Z'), TZ), '2026-11');
});

test('monthRange cubre el mes local de punta a punta', () => {
  const range = monthRange('2026-10', TZ);
  const startParts = localParts(range.start, TZ);
  const endParts = localParts(range.end, TZ);
  assert.equal(startParts.year, 2026);
  assert.equal(startParts.month, 10);
  assert.equal(startParts.day, 1);
  assert.equal(endParts.year, 2026);
  assert.equal(endParts.month, 11);
  assert.equal(endParts.day, 1);
});

test('localParts y formateo en la zona horaria', () => {
  const parts = localParts(new Date('2026-10-15T12:00:00Z'), TZ);
  assert.equal(parts.hour, 9);
  assert.equal(parts.day, 15);
  assert.equal(formatTime(new Date('2026-10-15T12:00:00Z'), TZ), '09:00');
});

test('resolveMonthKey entiende nombres y claves', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  assert.equal(resolveMonthKey('2026-10', now, TZ), '2026-10');
  assert.equal(resolveMonthKey('octubre', now, TZ), '2026-10');
  assert.equal(resolveMonthKey('octubre 2027', now, TZ), '2027-10');
});

test('dayRange y weekRange devuelven rangos validos', () => {
  const day = dayRange('2026-10-15', TZ);
  const startParts = localParts(day.start, TZ);
  assert.equal(`${startParts.year}-${pad2(startParts.month)}-${pad2(startParts.day)}`, '2026-10-15');

  const week = weekRange(new Date('2026-10-15T15:00:00Z'), TZ);
  assert.ok(new Date(week.start) <= new Date(week.end));
});

// ---------------------------------------------------------------------------
// HTML de Telegram
// ---------------------------------------------------------------------------

test('escapeHtml y marcado basico', () => {
  assert.equal(escapeHtml('<a & "b">'), '&lt;a &amp; &quot;b&quot;&gt;');
  assert.equal(bold('hola'), '<b>hola</b>');
  assert.equal(italic('ciao'), '<i>ciao</i>');
});

test('progressBar dibuja proporciones con 10 bloques', () => {
  assert.equal(progressBar(0), '░░░░░░░░░░');
  assert.equal(progressBar(100), '██████████');
  assert.equal(progressBar(50), '█████░░░░░');
  assert.equal(progressBar(108), '██████████');
  assert.equal(progressBar(20, 5), '█░░░░');
});

test('clampMessage y splitMessage respetan el limite', () => {
  const long = 'x'.repeat(5000);
  const clamped = clampMessage(long, 100);
  assert.ok(clamped.length <= 100);

  const chunks = splitMessage(`${'ab\n'.repeat(2000)}`, 500);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 500);
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('loadConfig parsea la familia y los ajustes principales', () => {
  const config = loadConfig({ ...TEST_ENV }, { loadEnvFile: false });
  assert.equal(config.app.timezone, TZ);
  assert.equal(config.app.currency, 'ARS');
  assert.equal(config.db.driver, 'sqlite');
  assert.equal(config.db.sqlitePath, ':memory:');
  assert.equal(config.telegram.familyChatId, '-100');
  assert.equal(config.telegram.enabled, false);
  assert.deepEqual(config.alerts.thresholds, [80, 100]);
});

test('loadConfig resuelve rutas relativas de SQLite contra el proyecto', () => {
  const config = loadConfig({ SQLITE_PATH: 'data/test.sqlite' }, { loadEnvFile: false });
  assert.ok(config.db.sqlitePath.indexOf('data/test.sqlite') > 0 || config.db.sqlitePath.endsWith('data\\test.sqlite'));
  const absolute = loadConfig({ SQLITE_PATH: ':memory:' }, { loadEnvFile: false });
  assert.equal(absolute.db.sqlitePath, ':memory:');
});

// ---------------------------------------------------------------------------
// Dominio
// ---------------------------------------------------------------------------

test('domino: tipos, gastos y categorias default', () => {
  assert.equal(TYPE_LIST.length, 4);
  assert.equal(EXPENSE_TYPES.includes(TRANSACTION_TYPES.INCOME), false);
  assert.equal(EXPENSE_TYPES.includes(TRANSACTION_TYPES.VARIABLE_EXPENSE), true);
  assert.equal(EXPENSE_TYPES.includes(TRANSACTION_TYPES.FIXED_EXPENSE), true);
  assert.equal(FALLBACK_CATEGORY_NAME, 'Otros');

  assert.equal(DEFAULT_CATEGORIES.some((category) => category.name === 'Supermercado'), true);
  assert.equal(DEFAULT_CATEGORIES.some((category) => category.name === 'Otros'), true);
  const income = DEFAULT_CATEGORIES.find((category) => category.type === 'income');
  assert.ok(income);
});
