/**
 * Avisos de movimientos por email de los bancos (hoy: Banco Macro).
 *
 * Lee el texto del aviso y devuelve el movimiento. No se conecta al banco ni
 * usa claves: solo interpreta los emails que el banco ya manda.
 *
 * Formatos soportados (Macro):
 *  - "Aviso de compra con Tarjeta de Débito/Crédito ...": "ingresó una
 *    autorización de compra de $ 29.500,00 en el establecimiento
 *    MERPAGO*COMERCIO el día 13/10/2026 a las 19:42hs, con la Tarjeta de
 *    Débito VISA ... finalizada en 1234."
 *  - "¡Tu transferencia fue exitosa!": "Enviamos tu transferencia de
 *    $100.000,00 a tu cuenta de Bco. Nacion Argentina a través de App Macro."
 *    "a tu cuenta de ..." = transferencia entre cuentas propias (no es gasto).
 *  - "E-Resumen de Tarjeta" (Visa / Mastercard): "Vencimiento: 11-Nov-26 Saldo en
 *    Pesos: $320473,00 Saldo en Dólares: $15,94 Pago mínimo en pesos: $46.830,00".
 *    Es un vencimiento a pagar, NO un gasto (las compras ya se cargaron una por una).
 */

import { parseAmountToCents } from '../utils/money.js';
import { zonedTimeToUtc } from '../utils/dates.js';

/** Prefijos de procesadores de pago que no son el comercio real. */
const PROCESSOR_PREFIXES = /^(?:MERPAGO|MERCADOPAGO|MP|PAYU|DLO|DLOCAL|SP|PAYPAL|GOOGLE|APPLE\.COM\/BILL)\s*\*\s*/i;

function normalizeSpaces(text) {
  return String(text || '')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function currencyFrom(symbol) {
  return /u\$s|usd|us\$/i.test(String(symbol || '')) ? 'USD' : 'ARS';
}

/** "MERPAGO*PANADERIA" -> "Panaderia" ; "COTO SUC 45" -> "Coto Suc 45". */
export function cleanMerchant(raw) {
  const withoutProcessor = String(raw || '').trim().replace(PROCESSOR_PREFIXES, '');
  const viaMercadoPago = withoutProcessor !== String(raw || '').trim() && /^(?:MERPAGO|MERCADOPAGO|MP)\b/i.test(String(raw || '').trim());
  const name = withoutProcessor
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
  return { name: name || 'Comercio', viaMercadoPago };
}

/** ¿El remitente es uno de los bancos permitidos? (dominio o direccion exacta) */
export function isBankSender(from, allowed = []) {
  const address = String(from || '').trim().toLowerCase();
  if (!address) return false;
  const domain = address.split('@')[1] || '';
  return allowed.some((entry) => {
    const rule = String(entry || '').trim().toLowerCase();
    if (!rule) return false;
    if (rule.includes('@')) return address === rule;
    return domain === rule || domain.endsWith(`.${rule}`);
  });
}

const MONTH_ABBR = {
  ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, apr: 4, may: 5, jun: 6, jul: 7,
  ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12,
};

/** "11-Nov-26", "11/11/2026", "11 nov 2026" -> "2026-11-11". */
export function parseStatementDate(raw) {
  const value = String(raw || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  let day; let month; let year;
  const named = /^(\d{1,2})[\s/.-]*([a-z]{3})[a-z]*\.?[\s/.-]*(\d{2,4})$/.exec(value);
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(value);
  if (named) {
    [day, month, year] = [Number(named[1]), MONTH_ABBR[named[2]], Number(named[3])];
  } else if (numeric) {
    [day, month, year] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
  } else {
    return null;
  }
  if (!month || month > 12 || day < 1 || day > 31) return null;
  if (year < 100) year += 2000;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function cardBrand(text) {
  if (/american express|\bamex\b/i.test(text)) return 'Amex';
  if (/master\s*card|\bmaster\b/i.test(text)) return 'Mastercard';
  if (/\bvisa\b/i.test(text)) return 'Visa';
  return null;
}

/** Monto opcional despues de una etiqueta: "Saldo en Pesos: $320473,00". */
function labeledAmount(body, label) {
  const match = new RegExp(`${label}\\s*:?\\s*(?:U\\$S|USD|US\\$|\\$)?\\s*(-?[\\d.]+(?:,\\d{1,2})?)`, 'i').exec(body);
  if (!match) return null;
  const cents = parseAmountToCents(match[1].replace(/^-/, ''));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Resumen de tarjeta (e-resumen): vencimiento y saldos. */
export function parseCardStatement({ subject = '', text = '' } = {}) {
  const body = normalizeSpaces(`${subject}\n${text}`);
  if (!/e-?resumen|resumen de (?:tu )?tarjeta/i.test(body)) return null;
  const due = /vencimiento\s*:?\s*(\d{1,2}[\s/.-]*(?:[a-záéíóú]{3,10}\.?|\d{1,2})[\s/.-]*\d{2,4})/i.exec(body);
  const dueDate = due ? parseStatementDate(due[1]) : null;
  const pesosCents = labeledAmount(body, 'saldo (?:actual )?en pesos');
  const dollarsCents = labeledAmount(body, 'saldo (?:actual )?en d[oó]lares');
  const minimumCents = labeledAmount(body, 'pago m[ií]nimo(?: en pesos)?');
  if (!dueDate || (pesosCents === null && dollarsCents === null)) return null;
  const brand = cardBrand(body);
  return {
    bank: 'macro',
    kind: 'statement',
    brand,
    name: `Tarjeta ${brand ? `${brand} ` : ''}Macro`,
    dueDate,
    pesosCents,
    dollarsCents,
    minimumCents,
  };
}

/**
 * @param {{subject?: string, text?: string, timezone?: string, now?: Date}} input
 * @returns {null | {bank: string, kind: 'card'|'transfer', cardType?: string, amountCents: number,
 *   currency: string, merchant: string, viaMercadoPago?: boolean, occurredAt: string,
 *   ownTransfer: boolean, destination?: string}}
 */
export function parseBankAlert({ subject = '', text = '', timezone = 'UTC', now = new Date() } = {}) {
  const body = normalizeSpaces(`${subject}\n${text}`);

  // Compra con tarjeta (debito o credito).
  const card = /autorizaci[oó]n de compra de\s*(U\$S|USD|US\$|\$)\s*([\d.]+(?:,\d{1,2})?)\s*en el establecimiento\s+(.+?)\s+el d[ií]a\s+(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+a las\s+(\d{1,2}):(\d{2}))?/i.exec(body);
  if (card) {
    const amountCents = parseAmountToCents(card[2]);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
    const [day, month, year] = [Number(card[4]), Number(card[5]), Number(card[6])];
    const hour = card[7] ? Number(card[7]) : 12;
    const minute = card[8] ? Number(card[8]) : 0;
    const occurred = zonedTimeToUtc(year, month, day, hour, minute, 0, timezone);
    const typeMatch = /Tarjeta de (D[eé]bito|Cr[eé]dito)/i.exec(body);
    const merchant = cleanMerchant(card[3]);
    return {
      bank: 'macro',
      kind: 'card',
      cardType: typeMatch && /cr/i.test(typeMatch[1]) ? 'credito' : 'debito',
      amountCents,
      currency: currencyFrom(card[1]),
      merchant: merchant.name,
      viaMercadoPago: merchant.viaMercadoPago,
      occurredAt: (Number.isNaN(occurred?.getTime?.()) ? now : occurred).toISOString(),
      ownTransfer: false,
    };
  }

  // Transferencia enviada.
  // El destino termina en "a través de ..." o en el fin de la oración ("Bco." no corta).
  const transfer = /Enviamos tu transferencia de\s*(U\$S|USD|US\$|\$)\s*([\d.]+(?:,\d{1,2})?)\s*a\s+(tu cuenta de\s+)?(.+?)(?:\s+a trav[eé]s de\b|\.\s+(?=Si\b|Ante\b|Por\b|Gracias\b)|$)/i.exec(body);
  if (transfer) {
    const amountCents = parseAmountToCents(transfer[2]);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return null;
    const destination = transfer[4].replace(/\.$/, '').trim();
    return {
      bank: 'macro',
      kind: 'transfer',
      amountCents,
      currency: currencyFrom(transfer[1]),
      merchant: `Transferencia a ${destination}`,
      destination,
      occurredAt: now.toISOString(),
      ownTransfer: Boolean(transfer[3]),
    };
  }

  return null;
}
