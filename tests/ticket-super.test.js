/**
 * Tickets de supermercado (datos inventados): el producto no es el comercio y
 * "AHORRO $" (descuentos) nunca convierte el ticket en inversión.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoiceFields } from '../src/services/invoice-text.js';
import { DEFAULT_CATEGORIES } from '../src/domain.js';

const categories = DEFAULT_CATEGORIES.map((category) => ({ ...category, id: category.name }));
const now = new Date('2026-10-29T12:00:00Z');
const read = (text) => extractInvoiceFields(text, { categories, now });

const TICKET = `INC S.A.-CARR
CUIT 30-00000000-0
ANANA SELECCION X KG
1,250 x 1.999,00 x
2.498,75
7790000000001 LECHE ENTERA 1 LT
1 x 1.500,00
1.500,00
SUBTOTAL SIN DESCUENTOS 4.200,00
DESCUENTOS
PROMO 2DA UNIDAD -201,25
AHORRO $ 201,25
TOTAL $ 3.998,75
27/10/2026 18:40`;

test('ticket de super: Carrefour por "-CARR", Supermercado y gasto variable (no inversión por "AHORRO")', () => {
  const raw = read(TICKET);
  assert.equal(raw.vendor, 'Carrefour');
  assert.equal(raw.category, 'Supermercado');
  assert.notEqual(raw.type, 'investment');
  assert.equal(raw.total, '3.998,75');
});

test('ticket de super sin cadena conocida: no usa un producto como comercio', () => {
  const raw = read(TICKET.replace('INC S.A.-CARR', 'AUTOSERVICIO'));
  assert.ok(!/selecci|kg|leche/i.test(String(raw.vendor || '')), `vendor=${raw.vendor}`);
  assert.equal(raw.category, 'Supermercado');
  assert.notEqual(raw.type, 'investment');
});
