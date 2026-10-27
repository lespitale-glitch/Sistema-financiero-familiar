/**
 * Pruebas del parser de lenguaje natural.
 * Ejecutar: node --test tests/parser.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CATEGORIES,
  NOW,
  categoryByName,
} from './helpers/finance-fixtures.js';
import {
  detectTransactionType,
  extractTags,
  hasMoneySignal,
  matchCategory,
  normalizeText,
  parseBudgetUpdate,
  parseCategoryCreation,
  parseContribution,
  parseGoalCreation,
  parseTransactionArgs,
  parseTransactionMessage,
  stripAccents,
  stripHashtags,
} from '../src/services/parser.js';

const NOW_OPTS = { categories: CATEGORIES, now: NOW, currency: 'ARS' };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

test('normalizeText y stripAccents limpian la entrada', () => {
  const original = normalizeText('  Gastó\tMUCHO \u00a0 ayer ');
  assert.equal(original, 'gastó mucho ayer');
  assert.equal(stripAccents('Categoría íñ'), 'Categoria in');
});

test('extractTags devuelve hashtags únicos en minúsculas', () => {
  assert.deepEqual(extractTags('compré algo #Comida #comida #Cine-1'), ['comida', 'cine-1']);
  assert.deepEqual(extractTags('sin tags'), []);
});

test('stripHashtags mantiene el resto del texto', () => {
  assert.equal(normalizeText(stripHashtags('gasté 100 en super #comida #cine')), 'gasté 100 en super');
});

test('hasMoneySignal detecta dígitos y símbolos monetarios', () => {
  assert.equal(hasMoneySignal('hola'), false);
  assert.equal(hasMoneySignal('gasté 100'), true);
  assert.equal(hasMoneySignal('el super'), false);
});

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

test('detectTransactionType reconoce ingresos, inversiones y gastos', () => {
  assert.equal(detectTransactionType('cobré el sueldo del mes'), 'income');
  assert.equal(detectTransactionType('ingresé 20 mil del cliente'), 'income');
  assert.equal(detectTransactionType('invertí en plazo fijo'), 'investment');
  assert.equal(detectTransactionType('aporte al ahorro'), 'investment');
  assert.equal(detectTransactionType('pagué la prepaga y la luz'), 'fixed_expense');
  assert.equal(detectTransactionType('gasté en el super'), 'variable_expense');
  assert.equal(detectTransactionType('algo cualquiera'), 'variable_expense');
  assert.equal(detectTransactionType('texto inventado', { defaultType: 'income' }), 'income');
});

// ---------------------------------------------------------------------------
// Categorias
// ---------------------------------------------------------------------------

test('matchCategory encuentra por nombre y keywords sin falsos positivos', () => {
  assert.equal(matchCategory('pagué el supermercado', CATEGORIES)?.name, 'Supermercado');
  assert.equal(matchCategory('pizza para la familia', CATEGORIES)?.name, 'Comida');
  assert.equal(matchCategory('diagnóstico del médico', CATEGORIES)?.name, 'Salud');
  assert.equal(matchCategory('corriendo diamantes', CATEGORIES), null);
  assert.equal(matchCategory('   ', CATEGORIES), null);
  assert.equal(matchCategory('pagué la luz y el internet', CATEGORIES)?.name, 'Servicios');
});

test('matchCategory desempata por posición (descripción al final gana)', () => {
  // "salida" (Entretenimiento) aparece antes; "pizza" (Comida) es la descripción final.
  assert.equal(matchCategory('salida del mes, pizza para la cena', CATEGORIES)?.name, 'Comida');
});

// ---------------------------------------------------------------------------
// Montos
// ---------------------------------------------------------------------------

function amountOf(text, options = {}) {
  return parseTransactionMessage(text, { ...NOW_OPTS, ...options }).amountCents;
}

test('interpreta montos con separadores, símbolos y multiplicadores', () => {
  assert.equal(amountOf('gasté 15.000 en el super'), 1_500_000);
  assert.equal(amountOf('15,000.50 del super'), 1_500_050);
  assert.equal(amountOf('$ 1.234,56 de nafta'), 123_456);
  assert.equal(amountOf('compré 1.5k de muebles'), 150_000);
  assert.equal(amountOf('cobre 15 mil del cliente'), 1_500_000);
  assert.equal(amountOf('invertí 2 millones en plazo fijo'), 200_000_000);
  assert.equal(amountOf('gasté 0,5 en caramelos'), 50);
  assert.equal(amountOf('50% del monto gasté 10.000'), 1_000_000);
  assert.equal(amountOf('gasté 10.000 el 24/10'), 1_000_000);
});

test('ignora fechas, años, horarios y unidades cuando hay un monto real', () => {
  assert.equal(amountOf('gasté 2000 el 24/10/2026 en la farmacia'), 200_000);
  assert.equal(amountOf('gas y agua 3000 05:30'), 300_000);
  assert.equal(amountOf('compré 2 kg de carne por 9000'), 900_000);
});

test('sin monto devuelve error y sin señales', () => {
  const parsed = parseTransactionMessage('compré caramelos', NOW_OPTS);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'missing-amount');
  assert.equal(parsed.amountCents, null);
  const empty = parseTransactionMessage('   ', NOW_OPTS);
  assert.equal(empty.reason, 'empty');
});

test('se queda con el monto asociado al verbo y no con números pequeños', () => {
  // El "50" está suelto y sin contexto; el monto con forma de dinero gana.
  assert.equal(amountOf('50 cosas de la casa, pagué el super 30000'), 3_000_000);
});

test('montos negativos o inválidos se rechazan', () => {
  const parsed = parseTransactionMessage('gasté 0', NOW_OPTS);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, 'invalid-amount');
  assert.match(parsed.warnings.join(' '), /cero/i);
});

// ---------------------------------------------------------------------------
//ificacion completa de movimientos
// ---------------------------------------------------------------------------

test('clasifica gasto con categoria por texto, nota limpia y fecha', () => {
  const parsed = parseTransactionMessage('Gasté 15.000 en el super #comida', NOW_OPTS);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, 'variable_expense');
  assert.equal(parsed.amountCents, 1_500_000);
  assert.equal(parsed.category?.name, 'Supermercado');
  assert.equal(parsed.categoryName, 'Supermercado');
  assert.match(parsed.note.toLowerCase(), /super/);
  assert.deepEqual(parsed.tags, ['comida']);
  assert.equal(new Date(parsed.occurredAt).toISOString(), NOW.toISOString());
  assert.ok(parsed.confidence > 0.6);
});

test('fecha explicita y relativa cambian occurredAt', () => {
  const yesterday = parseTransactionMessage('pagué 5000 ayer', NOW_OPTS);
  assert.equal(yesterday.ok, true);
  expectDayDiff(new Date(NOW.toISOString()), new Date(yesterday.occurredAt), -1);

  const explicit = parseTransactionMessage('gasté 3000 el 12/10', NOW_OPTS);
  assert.equal(explicit.ok, true);
  const dateParsed = new Date(explicit.occurredAt);
  assert.equal(dateParsed.getUTCFullYear(), 2026);
  assert.equal(dateParsed.getUTCMonth(), 9);
  assert.equal(dateParsed.getUTCDate(), 12);
});

function expectDayDiff(expected, actual, days) {
  const diff = Math.round((actual - expected) / 86_400_000);
  assert.equal(diff, days);
}

test('hashtags con fecha futura generan advertencia', () => {
  const parsed = parseTransactionMessage('pagué 5000 el 30/12/2027', NOW_OPTS);
  assert.equal(parsed.ok, true);
  assert.match(parsed.warnings.join(' '), /futuro|advertencia|fecha/i);
});

test('los hashtags deciden como respaldo del texto libre', () => {
  const parsed = parseTransactionMessage('gasté 500 en pizza #entretenimiento', NOW_OPTS);
  assert.equal(parsed.category?.name, 'Comida');
  const byTag = parseTransactionMessage('gasté 500 en la verdulería #inversiones', NOW_OPTS);
  // El texto no matchea ninguna categoría conocida; el #tag manda.
  assert.equal(byTag.category?.name, 'Inversiones');
});

test('ingresos rolean a Otros ingresos cuando no hay categoria', () => {
  const parsed = parseTransactionMessage('ingresé 350000 de freelance', NOW_OPTS);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, 'income');
  assert.equal(parsed.category?.name, 'Freelance');
});

// ---------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------

test('parseTransactionArgs fuerza el tipo del comando', () => {
  const parsed = parseTransactionArgs('15000 super #comida', {
    ...NOW_OPTS,
    defaultType: 'variable_expense',
    forceType: true,
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.type, 'variable_expense');

  const income = parseTransactionArgs(' 250000 sueldo', { ...NOW_OPTS, defaultType: 'income', forceType: true });
  assert.equal(income.type, 'income');
});

test('parseCategoryCreation entiende los formatos y errores', () => {
  assert.deepEqual(
    { ...parseCategoryCreation('Mascotas | variable_expense | 20000'), ok: true },
    { ok: true, name: 'Mascotas', type: 'variable_expense', emoji: '🏷️', monthlyBudgetCents: 2_000_000, budgetCents: 2_000_000, error: null },
  );
  const comma = parseCategoryCreation('Vet, inversion, 5000');
  assert.equal(comma.type, 'investment');
  assert.equal(comma.budgetCents, 500_000);

  const alias = parseCategoryCreation('Cine 🎬 | fijo | 80');
  assert.equal(alias.type, 'fixed_expense');
  assert.equal(alias.emoji, '🎬');
  assert.equal(alias.budgetCents, 8000);

  const noBudget = parseCategoryCreation('Viajes');
  assert.equal(noBudget.ok, true);
  assert.equal(noBudget.budgetCents, null);

  assert.equal(parseCategoryCreation('').ok, false);
  assert.equal(parseCategoryCreation('a 5000').ok, false);
  assert.equal(parseCategoryCreation('Nombre 0').ok, false);
  assert.match(parseCategoryCreation('Nombre | nada').error, /No entend/i);
});

test('parseBudgetUpdate fija presupuesto de categoria o general', () => {
  assert.deepEqual(
    parseBudgetUpdate('Comida 120000'),
    { ok: true, categoryName: 'Comida', isOverall: false, amountCents: 12_000_000, error: null },
  );
  assert.deepEqual(
    parseBudgetUpdate('Comida = 120.000'),
    { ok: true, categoryName: 'Comida', isOverall: false, amountCents: 12_000_000, error: null },
  );
  assert.deepEqual(
    parseBudgetUpdate('general 800000'),
    { ok: true, categoryName: null, isOverall: true, amountCents: 80_000_000, error: null },
  );
  const noAmount = parseBudgetUpdate('Comida');
  assert.equal(noAmount.ok, false);
  assert.match(noAmount.error, /monto/i);
  const zero = parseBudgetUpdate('Comida 0');
  assert.equal(zero.ok, false);
});

test('parseGoalCreation y parseContribution.', () => {
  const goal = parseGoalCreation('Vacaciones 500000 2027-01-01');
  assert.equal(goal.ok, true);
  assert.equal(goal.targetCents, 50_000_000);
  assert.equal(goal.deadline, '2027-01-01');

  const withComma = parseGoalCreation('Bici, 100000, 01/03/2027');
  assert.equal(withComma.ok, true);
  assert.equal(withComma.deadline, '2027-03-01');

  assert.equal(parseGoalCreation('Vacaciones').ok, false);
  const badName = parseGoalCreation('V 5000');
  assert.match(badName.error, /nombre/i);

  const contrib = parseContribution('Vacaciones 50000');
  assert.equal(contrib.ok, true);
  assert.equal(contrib.goalName, 'Vacaciones');
  assert.equal(contrib.amountCents, 5_000_000);

  const reversed = parseContribution('50000 Vacaciones');
  assert.equal(reversed.ok, true);
  assert.equal(reversed.goalName, 'Vacaciones');

  assert.equal(parseContribution('Vacaciones').ok, false);
  assert.equal(parseContribution('Vacaciones -1').ok, false);
});
