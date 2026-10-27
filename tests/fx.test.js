/**
 * Dolares: deteccion en el parser, cotizacion y conversion al registrar.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createFxService } from '../src/services/fx.js';
import { parseTransactionMessage } from '../src/services/parser.js';
import { allReplyText, createFakeCtx, createHarness } from './helpers/bot-harness.js';
import { handleText } from '../src/bot/handlers.js';

const baseConfig = (fx = {}) => ({ app: { currency: 'ARS' }, fx: { usdSource: 'oficial', apiUrl: 'https://fx.test/v1/dolares', ...fx } });

test('parser: detecta USD solo pegado al monto', () => {
  const cases = [
    ['gasté 100 dólares en netflix', 10_000, 'USD'],
    ['pagué u$s 15 spotify', 1_500, 'USD'],
    ['USD 20 de hosting', 2_000, 'USD'],
    ['15 usd en amazon', 1_500, 'USD'],
    ['gasté 1500 en el super', 150_000, 'ARS'],
    ['compré dólares por 150000', 15_000_000, 'ARS'],
  ];
  // Comprar dolares sigue siendo inversion; gastar en dolares es gasto.
  assert.equal(parseTransactionMessage('compré dólares por 150000').type, 'investment');
  assert.equal(parseTransactionMessage('gasté 100 dólares en netflix').type, 'variable_expense');
  for (const [text, cents, currency] of cases) {
    const parsed = parseTransactionMessage(text, { currency: 'ARS' });
    assert.equal(parsed.amountCents, cents, text);
    assert.equal(parsed.currency, currency, text);
  }
  assert.equal(parseTransactionMessage('pagué u$s 15 spotify').note, 'Spotify');
});

test('fx: cotizacion fija no usa la red', async () => {
  let calls = 0;
  const fx = createFxService({ config: baseConfig({ usdRate: 1450 }), fetchImpl: async () => { calls += 1; } });
  const result = await fx.convert(1_000, 'USD');
  assert.deepEqual(
    { ok: result.ok, amountCents: result.amountCents, rate: result.rate, source: result.source },
    { ok: true, amountCents: 1_450_000, rate: 1450, source: 'manual' },
  );
  assert.equal(calls, 0);
  assert.deepEqual(await fx.getRate('ARS'), { ok: true, rate: 1, source: 'identity' });
  assert.equal((await fx.getRate('EUR')).ok, false);
});

test('fx: consulta la API, cachea 1 hora y usa respaldo si la API cae', async () => {
  let now = new Date('2026-10-15T12:00:00Z');
  const urls = [];
  let fail = false;
  const fetchImpl = async (url) => {
    urls.push(url);
    if (fail) throw new Error('sin red');
    return { ok: true, json: async () => ({ compra: 1510, venta: 1560 }) };
  };
  const fx = createFxService({ config: baseConfig({ usdSource: 'blue' }), fetchImpl, clock: () => now });

  assert.equal((await fx.getRate('USD')).rate, 1560);
  assert.equal(urls[0], 'https://fx.test/v1/dolares/blue');
  await fx.getRate('USD');
  assert.equal(urls.length, 1, 'segunda consulta sale de cache');

  now = new Date('2026-10-15T14:00:00Z');
  fail = true;
  const stale = await fx.getRate('USD');
  assert.deepEqual({ ok: stale.ok, rate: stale.rate, stale: stale.stale }, { ok: true, rate: 1560, stale: true });

  now = new Date('2026-10-17T14:00:00Z');
  assert.deepEqual(await fx.getRate('USD'), { ok: false, error: 'cotizacion-no-disponible' });
});

test('registrar "100 dolares" convierte a pesos y guarda el original', async (t) => {
  const harness = await createHarness({ env: { USD_ARS_RATE: '1.450' } });
  t.after(() => harness.close());
  const ctx = createFakeCtx({ user: harness.user, text: 'gasté 100 dólares en netflix' });

  await handleText(ctx, harness.deps);

  const [transaction] = await harness.repos.transactions.list({ limit: 1 });
  assert.equal(transaction.amountCents, 14_500_000);
  assert.equal(transaction.currency, 'ARS');
  assert.equal(transaction.metadata.fx.originalAmountCents, 10_000);
  assert.equal(transaction.metadata.fx.originalCurrency, 'USD');
  assert.equal(transaction.metadata.fx.rate, 1450);
  assert.match(allReplyText(ctx), /💱 US\$\s?100 × \$\s?1\.450 \(cotización fija\)/);
  assert.equal(transaction.type, 'variable_expense');
  const category = await harness.repos.categories.get(transaction.categoryId);
  assert.equal(category.name, 'Entretenimiento');
});

test('sin cotizacion no registra el gasto en dolares como si fueran pesos', async (t) => {
  const harness = await createHarness();
  t.after(() => harness.close());
  const ctx = createFakeCtx({ user: harness.user, text: 'pagué u$s 15 de spotify' });

  await handleText(ctx, harness.deps);

  const transactions = await harness.repos.transactions.list({ limit: 5 });
  assert.equal(transactions.length, 0);
  assert.match(allReplyText(ctx), /No pude obtener la cotización/);
  assert.match(allReplyText(ctx), /USD_ARS_RATE/);
});
