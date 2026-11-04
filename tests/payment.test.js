import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPaymentInMessage, paymentLabel, resolvePayment } from '../src/services/payment.js';

function fakeRepos() {
  const store = new Map();
  return { settings: { async get(key, fallback) { return store.has(key) ? store.get(key) : fallback; }, async set(key, value) { store.set(key, value); } } };
}

test('mensajes: tarjeta, débito, efectivo y nada', () => {
  assert.deepEqual(detectPaymentInMessage('gasté 5000 super con visa'), { method: 'credit', brand: 'Visa', last4: null });
  assert.deepEqual(detectPaymentInMessage('pagué 1000 luz con débito'), { method: 'debit', brand: null, last4: null });
  assert.deepEqual(detectPaymentInMessage('gasté 300 en efectivo'), { method: 'cash', brand: null, last4: null });
  assert.equal(detectPaymentInMessage('gasté 200 en la verdu'), null);
});

test('las tarjetas se aprenden de los avisos del banco', async () => {
  const repos = fakeRepos();
  // Sin datos previos, una tarjeta sin tipo se toma como crédito.
  assert.equal((await resolvePayment(repos, { brand: 'Visa', last4: '1111' })).method, 'credit');
  // El banco avisa que la 9876 es de débito...
  await resolvePayment(repos, { method: 'debit', brand: 'Visa', last4: '9876' }, { learn: true });
  // ...y un comprobante que solo dice "terminada en 9876" queda como débito.
  const resolved = await resolvePayment(repos, { method: null, brand: null, last4: '9876' });
  assert.deepEqual(resolved, { method: 'debit', brand: 'Visa', last4: '9876' });
  assert.equal(paymentLabel(resolved), '💳 Visa débito ····9876');
});
