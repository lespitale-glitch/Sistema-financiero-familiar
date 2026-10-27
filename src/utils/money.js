/**
 * Dinero en centavos (enteros). Todas las capas usan centavos para evitar
 * errores de coma flotante; solo se formatea al mostrar.
 */

const MAX_SAFE_CENTS = Number.MAX_SAFE_INTEGER;

/** Redondea unidades de moneda a centavos enteros. */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
  if (!Number.isFinite(numeric)) return null;
  const cents = Math.round(numeric * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

/**
 * Convierte un monto escrito por una persona a centavos.
 * Soporta: "15000", "15.000", "15,000.50", "1.500,25", "$ 15.000",
 * "1.5k", "15 mil", "2 millones", "ARS 1.234,56", "0,5".
 * Devuelve null si no hay un numero interpretable.
 */
export function parseAmountToCents(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return toCents(input);
  if (typeof input !== 'string') return null;

  let text = input
    .toLowerCase()
    .replace(/\u00a0|\u202f/g, ' ')
    .replace(/[uú]s\$|ars|usd|eur|brl|clp|mxn|uyu|pyg|bol|pen|soles|d[oó]lares?|pesos?|euros?/gi, ' ')
    .replace(/[$€£¥]/g, ' ')
    .trim();

  if (!/\d/.test(text)) return null;

  // Multiplicadores escritos: "mil", "millon", "millones"
  let multiplier = 1;
  if (/\b(millon(es)?|mill[oó]n(es)?)\b/.test(text)) {
    multiplier = 1_000_000;
    text = text.replace(/\b(millon(es)?|mill[oó]n(es)?)\b/g, ' ');
  } else if (/\b(mil|k)\b/.test(text)) {
    multiplier = 1_000;
    text = text.replace(/\b(mil|k)\b/g, ' ');
  } else if (/(\d)\s*k\b/.test(text)) {
    multiplier = 1_000;
    text = text.replace(/(\d)\s*k\b/g, '$1 ');
  }

  // Recorta a la primera secuencia numerica con separadores
  const match = text.match(/-?\d[\d.,]*/);
  if (!match) return null;
  let numericText = match[0].replace(/[.,]+$/, '');
  if (!/\d/.test(numericText)) return null;

  const negative = numericText.startsWith('-');
  numericText = numericText.replace(/-/g, '');

  const dots = (numericText.match(/\./g) || []).length;
  const commas = (numericText.match(/,/g) || []).length;

  let normalized;
  if (dots > 0 && commas > 0) {
    // El ultimo separador es el decimal
    const lastDot = numericText.lastIndexOf('.');
    const lastComma = numericText.lastIndexOf(',');
    const decimalSep = lastDot > lastComma ? '.' : ',';
    const thousandSep = decimalSep === '.' ? ',' : '.';
    normalized = numericText.split(thousandSep).join('');
    const parts = normalized.split(decimalSep);
    const decimals = parts.pop();
    normalized = `${parts.join('')}.${decimals}`;
  } else if (dots > 0 || commas > 0) {
    const sep = dots > 0 ? '.' : ',';
    const count = dots > 0 ? dots : commas;
    const parts = numericText.split(sep);
    const decimals = parts[parts.length - 1];
    if (count > 1) {
      // Multiples separadores: son de miles, salvo el ultimo grupo decimal de 1-2 digitos
      if (decimals.length > 0 && decimals.length <= 2 && parts.length >= 2) {
        normalized = `${parts.slice(0, -1).join('')}.${decimals}`;
      } else {
        normalized = parts.join('');
      }
    } else if (decimals.length === 3 && parts[0].length >= 1 && parts[0].length <= 3) {
      // "15.000" / "1,500" => separador de miles
      normalized = parts.join('');
    } else if (decimals.length === 3 && parts[0].length === 0) {
      normalized = `0.${decimals}`;
    } else if (decimals.length === 0) {
      normalized = parts.join('');
    } else {
      normalized = `${parts[0] || '0'}.${decimals}`;
    }
  } else {
    normalized = numericText;
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  const cents = Math.round(value * multiplier * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_SAFE_CENTS) return null;
  return negative ? -cents : cents;
}

/** Formatea centavos como moneda. Ej: 1500050 -> "$ 15.000,50". */
export function formatCents(cents, currency = 'ARS', locale = 'es-AR') {
  const value = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat(locale || 'es-AR', {
      style: 'currency',
      currency: currency || 'ARS',
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    })
      .format(value)
      .replace(/\u00a0|\u202f/g, ' ');
  } catch {
    return `${currency || ''} ${formatCentsPlain(cents, locale)}`.trim();
  }
}

/** Formatea centavos sin simbolo de moneda. Ej: 1500050 -> "15.000,50". */
export function formatCentsPlain(cents, locale = 'es-AR') {
  const value = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat(locale || 'es-AR', {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    })
      .format(value)
      .replace(/\u00a0|\u202f/g, ' ');
  } catch {
    return String(value);
  }
}

/** Formatea con signo explicito: "+$ 1.000" / "-$ 1.000". */
export function formatSignedCents(cents, currency, locale) {
  const amount = Number(cents || 0);
  const prefix = amount > 0 ? '+' : amount < 0 ? '-' : '';
  return `${prefix}${formatCents(Math.abs(amount), currency, locale)}`;
}

/** Suma segura de centavos. */
export function sumCents(values) {
  return values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);
}

/** Porcentaje entero (0..N) de gasto sobre presupuesto. */
export function percentOf(spentCents, budgetCents) {
  if (!budgetCents || budgetCents <= 0) return null;
  return Math.round((spentCents / budgetCents) * 100);
}

/** Convierte un porcentaje (string/number) a entero 0..100. */
export function parsePercent(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number.parseFloat(String(value).replace('%', '').replace(',', '.'));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

/** Indica si un valor es un monto positivo valido en centavos. */
export function isPositiveCents(value) {
  return Number.isSafeInteger(value) && value > 0;
}
