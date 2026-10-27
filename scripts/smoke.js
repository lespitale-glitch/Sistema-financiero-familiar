/**
 * Smoke test end-to-end sin servicios externos: levanta la app completa
 * (SQLite en memoria, sin bot, sin Gemini, sin IMAP) en un puerto efimero y
 * ejercita los endpoints principales de la API.
 * Uso: node scripts/smoke.js
 * Sale con codigo 0 si todo pasa.
 */

import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/logger.js';

const SMOKE_ENV = {
  NODE_ENV: 'test',
  TZ: 'America/Argentina/Buenos_Aires',
  CURRENCY: 'ARS',
  SQLITE_PATH: ':memory:',
  FAMILY_MEMBERS: 'Ana|wife|111111111|ana@familia.test;Leo|husband|222222222',
  FAMILY_CHAT_ID: '-100123',
  API_TOKEN: 'smoke-token',
  TELEGRAM_BOT_TOKEN: '',
  GEMINI_API_KEY: '',
  IMAP_HOST: '',
  PORT: '0',
};

const logger = createLogger({ level: 'warn', name: 'smoke' });

async function call(url, path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, json };
}

async function main() {
  const steps = [];

  async function step(name, fn) {
    const at = Date.now();
    await fn();
    steps.push(`✓ ${name} (${Date.now() - at}ms)`);
  }

  const config = loadConfig({ ...SMOKE_ENV }, { loadEnvFile: false });
  const app = await createApp({ env: { ...SMOKE_ENV }, loadEnvFile: false, logger });
  let server = null;
  try {
    // 1. La app arranca con servicios deshabilitados y no lanza.
    await step('arranque de la app en puerto efimero', async () => {
      const started = await app.start({ port: 0 });
      assert.ok(started.port > 0);
      server = started;
    });

    const url = server.url;
    const token = config.api.token;

    // 2. Health.
    await step('GET /healthz responde ok', async () => {
      const response = await call(url, '/healthz');
      assert.equal(response.status, 200);
      assert.equal(response.json.status, 'ok');
      assert.equal(response.json.db, 'ok');
    });

    // 3. La API exige token.
    await step('la API rechaza peticiones sin token', async () => {
      const response = await call(url, '/api/summary');
      assert.ok(response.status >= 400 && response.status < 500);
    });

    // 4. Resumen del mes vacio (el mes actual se deduce del reloj real).
    await step('GET /api/summary con base nueva', async () => {
      const today = new Date();
      const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
      const response = await call(url, `/api/summary?month=${month}`, { token });
      assert.equal(response.status, 200);
      assert.equal(response.json.monthKey, month);
      assert.equal(response.json.totals.incomeCents, 0);
      assert.equal(response.json.totals.expenseCents, 0);
    });

    // 5. Registro de un gasto por API.
    let transaction = null;
    await step('POST /api/transactions registra un gasto', async () => {
      const response = await call(url, '/api/transactions', {
        token,
        method: 'POST',
        body: {
          type: 'variable_expense',
          amountCents: 1_500_000,
          category: 'Supermercado',
          note: 'compra de humo',
          telegramId: '111111111',
        },
      });
      assert.equal(response.status, 201);
      transaction = response.json.transaction;
      assert.ok(transaction.id);
      assert.equal(response.json.category?.name, 'Supermercado');
    });

    // 6. El movimiento aparece en la lista.
    await step('GET /api/transactions lista el movimiento', async () => {
      const today = new Date();
      const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
      const response = await call(url, `/api/transactions?month=${month}`, { token });
      assert.equal(response.status, 200);
      const items = response.json.transactions || response.json.items || [];
      assert.ok(items.some((item) => item.id === transaction.id));
    });

    // 7. Categorias con las semillas + agregados por categoria.
    await step('GET /api/categories sembradas', async () => {
      const response = await call(url, '/api/categories', { token });
      assert.equal(response.status, 200);
      const items = response.json.categories || response.json.items || [];
      assert.ok(items.some((category) => category.name === 'Supermercado'));
      assert.ok(items.some((category) => category.name === 'Comida'));
    });

    // 8. Objeto de ahorro.
    await step('POST /api/goals crea una meta', async () => {
      const response = await call(url, '/api/goals', {
        token,
        method: 'POST',
        body: { name: 'Vacaciones', targetCents: 100_000_000 },
      });
      assert.equal(response.status >= 200 && response.status < 300, true);
      const goal = response.json.goal || response.json;
      assert.ok(goal.id || goal.name === 'Vacaciones');
    });

    // 9. Alertas del mes.
    await step('GET /api/alerts sin alertas disparadas', async () => {
      const today = new Date();
      const month = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}`;
      const response = await call(url, `/api/alerts?month=${month}`, { token });
      assert.equal(response.status, 200);
      assert.ok(response.json);
    });
  } finally {
    await app.stop();
  }

  console.log('\n=== SMOKE OK ===');
  for (const line of steps) console.log(line);
}

main().catch((error) => {
  console.error('\n=== SMOKE FALLO ===');
  console.error(error);
  process.exit(1);
});
