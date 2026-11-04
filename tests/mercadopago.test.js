/**
 * Comprobantes de Mercado Pago leidos por OCR (datos inventados, mismo formato): tolerancia a orden, recortes
 * y bloques unidos en un mismo renglon.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractInvoiceFields, findDates } from '../src/services/invoice-text.js';
import { DEFAULT_CATEGORIES } from '../src/domain.js';

const categories = DEFAULT_CATEGORIES.map((category) => ({ ...category, id: category.name }));
const now = new Date('2026-10-29T12:00:00Z');
const read = (text) => extractInvoiceFields(text, { categories, now });

const TRANSFERENCIA = `mercado pago
Comprobante de transferencia
28/octubre/2026 a las 12:04.
$ 5.000
Motivo: Varios
Origen y destino
Laura Beatriz Gomez
Mercado Pago
CVU: 0000003100000000000001
CUIT/CUIL: 27-11111111-1
Martin Sosa
Mercado Pago
CVU: 0000003100000000000002
CUIT/CUIL: 20-22222222-2
N.º de operación de Mercado Pago
100000000001
Mago, tu asistente
Transferí $ 3.00 para Alejandra`;

const PAGO_TIENDA = `11:55
60
$ 10.900
Burger King
Pago en tienda física
28/oct - 11:27
Aprobado
Medio de pago
Dinero disponible
N.º de operación
100000000002
Categoría
Comidas y bebidas
Ubicación
AV. SIEMPRE VIVA 742, CABA,`;

const RECARGA_PDF = `Comprobante de pago
#100000000003
Recarga de celular
Claro
Total pagado
$ 8.000,00
Detalles
Claro
$ 8.000,00
Número de celular
1100000000
N.º de autorización
10000000000001
Fecha
28/10/2026
Hora
08:57:57
Medios de pago
Dinero disponible en Mercado Pago`;

test('fechas tolerantes: 28/octubre/2026, 28/oct - 11:27 (sin confundir la hora con el año)', () => {
  assert.deepEqual(findDates('28/octubre/2026 a las 12:04.', { defaultYear: 2026 }), ['2026-10-28']);
  assert.deepEqual(findDates('28/oct - 11:27', { defaultYear: 2026 }), ['2026-10-28']);
  assert.deepEqual(findDates('Vence el 05 de noviembre de 2026', { defaultYear: 2026 }), ['2026-11-05']);
});

test('transferencia: monto destacado, destinatario (no el origen) y motivo; ignora CVU, CUIT y la publicidad', () => {
  const raw = read(TRANSFERENCIA);
  assert.equal(raw.total, '5.000');
  assert.equal(raw.vendor, 'Transferencia a Martin Sosa');
  assert.equal(raw.description, 'Motivo: Varios');
  assert.equal(raw.issued_date, '2026-10-28');
  assert.equal(raw.due_date, null);
  assert.ok(raw.confidence >= 0.8);
});

test('transferencia recortada y con bloques en el mismo renglón', () => {
  const raw = read(`Comprobante de transferencia  28/octubre/2026 a las 12:04.
$5.000  Motivo: Varios
Origen y destino
Laura Beatriz Gomez  Mercado Pago
Martin Sosa`);
  assert.equal(raw.total, '5.000');
  assert.equal(raw.vendor, 'Transferencia a Martin Sosa');
  assert.equal(raw.description, 'Motivo: Varios');
});

test('pago en tienda: comercio junto al monto, categoría de Mercado Pago mapeada', () => {
  const raw = read(PAGO_TIENDA);
  assert.equal(raw.total, '10.900');
  assert.equal(raw.vendor, 'Burger King');
  assert.equal(raw.category, 'Comida');
  assert.equal(raw.issued_date, '2026-10-28');
  assert.equal(raw.type, 'variable_expense');
});

test('pago en tienda con otro orden y el comercio en el mismo bloque que el monto', () => {
  const raw = read(`Burger King  $10.900
Pago en tienda física  28/oct - 11:27  Aprobado
Medio de pago  Dinero disponible
Categoría Comidas y bebidas`);
  assert.equal(raw.vendor, 'Burger King');
  assert.equal(raw.total, '10.900');
  assert.equal(raw.category, 'Comida');
});

test('comprobante PDF de recarga: Claro, total pagado, Servicios', () => {
  const raw = read(RECARGA_PDF);
  assert.equal(raw.vendor, 'Claro');
  assert.equal(raw.total, '8.000,00');
  assert.equal(raw.category, 'Servicios');
  assert.equal(raw.description, 'Recarga de celular Claro');
  assert.equal(raw.issued_date, '2026-10-28');
});

test('las facturas que no son de Mercado Pago siguen por las reglas generales', () => {
  const raw = read(`EDESUR S.A.
TOTAL A PAGAR  $ 45.320,50
1er Vencimiento 10/11/2026`);
  assert.equal(raw.vendor, 'Edesur');
  assert.equal(raw.due_date, '2026-11-10');
});

const SUSCRIPCION = `< Pagaste la suscri...
Suscripción PLANSALUD100 Cuota mensual familiar
Pagaste tu suscripción.
Juan, acá están los detalles del pago:
Visa terminada en 1111
Pagaste $ 50000.00
Operación:  Vendedor:
100000000009  OBRA SOCIAL
DE EJEMPLO
En tu resumen, verás el cargo a
nombre de
MERPAGO*PLANSALUD`;

test('suscripción de Mercado Pago: vendedor, concepto, gasto fijo y tarjeta', async () => {
  const raw = read(SUSCRIPCION);
  assert.equal(raw.vendor, 'Obra Social de Ejemplo');
  assert.equal(raw.description, 'Suscripción PLANSALUD100 Cuota mensual familiar');
  assert.equal(raw.total, '50000.00');
  assert.equal(raw.category, 'Salud');
  assert.equal(raw.type, 'fixed_expense');
  const { detectPaymentInDocument } = await import('../src/services/payment.js');
  assert.deepEqual(detectPaymentInDocument(SUSCRIPCION), { method: null, brand: 'Visa', last4: '1111' });
});

test('el encabezado de la captura ("< Pagaste la suscri...") nunca es el comercio', () => {
  const raw = read(`< Volver...
FARMACIA EJEMPLO
TOTAL $ 1.500,00`);
  assert.equal(raw.vendor, 'FARMACIA EJEMPLO');
});
