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

/** "MERPAGO*DONADOCARAPA" -> "Donadocarapa" ; "COTO SUC 45" -> "Coto Suc 45". */
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
