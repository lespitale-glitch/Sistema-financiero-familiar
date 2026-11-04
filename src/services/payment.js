/**
 * Medio de pago de un movimiento: crédito, débito, Mercado Pago, efectivo o
 * transferencia, con marca (Visa, Mastercard...) y últimos 4 dígitos.
 *
 * Se guarda en transaction.metadata.payment = { method, brand, last4 }.
 * Los avisos del banco "enseñan" qué tarjeta es cada terminación (settings
 * `cards.<last4>`), así un comprobante de Mercado Pago que solo dice
 * "Visa terminada en 1234" queda como crédito o débito según corresponda.
 */

const BRANDS = [
  { name: 'Visa', pattern: /\bvisa\b/i },
  { name: 'Mastercard', pattern: /\bmaster\s*card\b|\bmaster\b/i },
  { name: 'Amex', pattern: /\bamerican express\b|\bamex\b/i },
  { name: 'Cabal', pattern: /\bcabal\b/i },
  { name: 'Naranja', pattern: /\bnaranja\b/i },
];

export const PAYMENT_METHODS = Object.freeze({
  CREDIT: 'credit',
  DEBIT: 'debit',
  MERCADOPAGO: 'mercadopago',
  CASH: 'cash',
  TRANSFER: 'transfer',
});

const METHOD_LABELS = {
  credit: 'crédito',
  debit: 'débito',
  mercadopago: 'dinero en Mercado Pago',
  cash: 'efectivo',
  transfer: 'transferencia',
};

function plain(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function brandFrom(text) {
  return BRANDS.find((brand) => brand.pattern.test(String(text || '')))?.name || null;
}

/**
 * Comprobantes y avisos: "Visa terminada en 1234", "Tarjeta de Crédito VISA ...
 * finalizada en 1234", "Débito Mastercard", "Dinero disponible".
 */
export function detectPaymentInDocument(text) {
  const raw = String(text || '');
  const value = plain(raw);
  const card = /(visa|master\s*card|mastercard|master|amex|american express|cabal|naranja)?\s*(debito|credito)?\s*(?:terminada|finalizada|termina|terminado)\s+en\s*[:\s]*(\d{4})\b/.exec(value);
  const typed = /tarjeta\s+(?:de\s+)?(debito|credito)/.exec(value) || /\b(debito|credito)\b/.exec(value);
  if (card || /tarjeta\s+(?:de\s+)?(?:debito|credito)/.test(value)) {
    const kind = card?.[2] || typed?.[1] || null;
    return {
      method: kind === 'debito' ? PAYMENT_METHODS.DEBIT : (kind === 'credito' ? PAYMENT_METHODS.CREDIT : null),
      brand: brandFrom(card?.[1] || raw),
      last4: card?.[3] || null,
    };
  }
  if (/dinero (?:disponible|en cuenta)/.test(value)) {
    return { method: PAYMENT_METHODS.MERCADOPAGO, brand: null, last4: null };
  }
  return null;
}

/** Mensajes de texto: "gasté 5000 super con visa", "#master", "en efectivo", "con débito". */
export function detectPaymentInMessage(text) {
  const value = plain(text);
  const brandMatch = /(?:\bcon (?:la )?|#)(visa|master(?:card)?|amex|cabal|naranja)\b/.exec(value);
  const debit = /(?:\bcon (?:la )?|#|\b)debito\b/.test(value);
  const credit = /(?:\bcon (?:la )?|#|\b)credito\b/.test(value);
  if (brandMatch || debit || credit) {
    return {
      method: debit ? PAYMENT_METHODS.DEBIT : PAYMENT_METHODS.CREDIT,
      brand: brandMatch ? brandFrom(brandMatch[1]) : null,
      last4: null,
    };
  }
  if (/\b(?:en |con |#)?efectivo\b/.test(value)) return { method: PAYMENT_METHODS.CASH, brand: null, last4: null };
  if (/(?:\bcon |#)(?:mp|mercado ?pago)\b/.test(value)) return { method: PAYMENT_METHODS.MERCADOPAGO, brand: null, last4: null };
  return null;
}

/** "💳 Visa crédito ····1234" */
export function paymentLabel(payment) {
  if (!payment || (!payment.method && !payment.brand)) return '';
  const isCard = payment.method === 'credit' || payment.method === 'debit' || payment.brand;
  const icon = isCard ? '💳' : (payment.method === 'cash' ? '💵' : (payment.method === 'transfer' ? '🔁' : '📱'));
  const parts = [payment.brand, METHOD_LABELS[payment.method] || (isCard ? 'tarjeta' : null)].filter(Boolean);
  return `${icon} ${parts.join(' ')}${payment.last4 ? ` ····${payment.last4}` : ''}`;
}

/** Grupo para el resumen de tarjetas: "Visa ····1234". */
export function cardKey(payment) {
  return [payment?.brand || 'Tarjeta', payment?.last4 ? `····${payment.last4}` : null].filter(Boolean).join(' ');
}

/**
 * Completa con lo aprendido de los avisos del banco y, si el dato es seguro
 * (aviso del banco), lo guarda para la próxima.
 */
export async function resolvePayment(repos, payment, { learn = false } = {}) {
  if (!payment) return null;
  const result = { method: payment.method || null, brand: payment.brand || null, last4: payment.last4 || null };
  // Una tarjeta sin tipo (ej. "Visa terminada en 1234" en Mercado Pago) se toma
  // como crédito, salvo que un aviso del banco haya enseñado otra cosa.
  const withDefault = () => {
    if (!result.method && (result.brand || result.last4)) result.method = PAYMENT_METHODS.CREDIT;
    return result;
  };
  if (!result.last4 || !repos?.settings) return withDefault();
  const key = `cards.${result.last4}`;
  try {
    const known = await repos.settings.get(key, null);
    if (known) {
      result.method = result.method || known.method || null;
      result.brand = result.brand || known.brand || null;
    }
    if (learn && result.method && (!known || known.method !== result.method || known.brand !== result.brand)) {
      await repos.settings.set(key, { method: result.method, brand: result.brand });
    }
  } catch {
    // aprender tarjetas es un extra: nunca rompe el registro
  }
  return withDefault();
}
