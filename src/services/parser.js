/**
 * Parser de lenguaje natural para el bot. Funciones puras, sin I/O.
 * Interpreta movimientos ("gasté 15.000 en super #comida"), presupuestos,
 * metas y aportes a metas.
 */

import {
  MONTH_NAMES_ES,
  TRANSACTION_TYPES,
  TYPE_KEYWORDS,
  TYPE_LIST,
} from '../domain.js';
import { parseAmountToCents } from '../utils/money.js';
import { parseHumanDate } from '../utils/dates.js';

const DEFAULT_TYPE = TRANSACTION_TYPES.VARIABLE_EXPENSE;

const TYPE_LABELS = Object.freeze({
  [TRANSACTION_TYPES.INCOME]: 'Ingreso',
  [TRANSACTION_TYPES.FIXED_EXPENSE]: 'Gasto fijo',
  [TRANSACTION_TYPES.VARIABLE_EXPENSE]: 'Gasto variable',
  [TRANSACTION_TYPES.INVESTMENT]: 'Inversión',
});

const FALLBACK_CATEGORY_BY_TYPE = Object.freeze({
  [TRANSACTION_TYPES.INCOME]: 'Otros ingresos',
  [TRANSACTION_TYPES.INVESTMENT]: 'Inversiones',
  [TRANSACTION_TYPES.FIXED_EXPENSE]: 'Otros',
  [TRANSACTION_TYPES.VARIABLE_EXPENSE]: 'Otros',
});

const CURRENCY_WORDS = Object.freeze(['ars', 'usd', 'eur', 'brl', 'clp', 'mxn', 'uyu', 'pyg', 'pen']);

const INCOME_WORDS = Object.freeze([
  ...TYPE_KEYWORDS.income,
  'cobre', 'cobro', 'me pagaron', 'sueldo', 'salario', 'ingreso', 'ingrese', 'honorarios',
]);

const INVESTMENT_WORDS = Object.freeze([
  ...TYPE_KEYWORDS.investment,
  'inverti', 'plazo fijo', 'fci', 'acciones', 'cedears', 'cripto', 'ahorro', 'aporte',
  'dolares', 'bonos', 'fondo', 'criptomoneda',
]);

const EXPENSE_VERBS = Object.freeze([
  'gaste', 'pague', 'compre', 'gastamos', 'pago', 'compra', 'gasto', 'abone', 'abono',
]);

const FIXED_WORDS = Object.freeze([
  ...TYPE_KEYWORDS.fixed_expense,
  'alquiler', 'expensas', 'servicio', 'luz', 'gas', 'agua', 'internet', 'colegio',
  'cuota', 'prepaga', 'suscripcion', 'seguro', 'impuesto', 'monotributo', 'tarjeta',
]);

const NOTE_VERBS = Object.freeze([
  'gast[eé]', 'gastamos', 'gast[oó]', 'pagu[eé]', 'pag[oó]', 'compr[eé]', 'compr[aá]',
  'ingres[eé]', 'ingres[oó]', 'invert[ií]', 'cobr[eé]', 'cobr[oó]',
]);

const NOTE_FILLERS = Object.freeze([
  'en', 'de', 'del', 'por', 'el', 'la', 'los', 'las', 'un', 'una',
]);

const NOTE_DATE_WORDS = Object.freeze(['hoy', 'ayer', 'anteayer']);

const AMOUNT_VERBS = Object.freeze([
  'gaste', 'pague', 'compre', 'cuesta', 'total', 'monto', 'ingrese', 'inverti',
  'cobre', 'cobro', 'transferi', 'deposite', 'gastamos', 'pago', 'compra',
]);

const THOUSANDS_AMOUNT = String.raw`-?[\d.,]+(?:\s*(?:k|mil|millones?|mill[oó]n(?:es)?))?`;
const MONEY_TOKEN_REGEX = new RegExp(`^${THOUSANDS_AMOUNT}$`, 'i');

function moneyCents(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text || !MONEY_TOKEN_REGEX.test(text)) return null;
  return parseAmountToCents(text);
}

const MONTH_PATTERN = MONTH_NAMES_ES.join('|');
const LONG_DATE_SOURCE = String.raw`\b(\d{1,2})\s+de\s+(${MONTH_PATTERN})(?:\s+(?:de\s+)?(\d{4}))?\b`;
const YMD_SOURCE = String.raw`\b(\d{4})-(\d{1,2})-(\d{1,2})\b`;
const DMY_SOURCE = String.raw`\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b`;
const TIME_SOURCE = String.raw`\b\d{1,2}:\d{2}(?::\d{2})?\b`;
const PERCENT_SOURCE = String.raw`\d+(?:[.,]\d+)?\s*%`;
const HASHTAG_SOURCE = String.raw`#[\p{L}\p{N}_-]+`;

const AMOUNT_REGEX = /(?<![\d.,])(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?)(?![\d])/g;

const BOUNDARY_LEFT = '(^|[^a-z0-9])';
const BOUNDARY_RIGHT = '(?=$|[^a-z0-9])';

/** Convierte cualquier entrada en texto normalizado (minusculas, sin NBSP). */
export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/\u00a0|\u202f/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Quita diacriticos conservando el resto del texto. */
export function stripAccents(input) {
  if (input === null || input === undefined) return '';
  return String(input).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Extrae hashtags normalizados, sin '#' y sin duplicados. */
export function extractTags(text) {
  const raw = String(text ?? '');
  const tags = [];
  const seen = new Set();
  for (const match of raw.matchAll(/#([\p{L}\p{N}_-]+)/gu)) {
    const tag = normalizeText(match[1]);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** Quita hashtags del texto sin alterar el resto. */
export function stripHashtags(text) {
  return String(text ?? '').replace(/#([\p{L}\p{N}_-]+)/gu, ' ');
}

function normalizePhrase(value) {
  return stripAccents(normalizeText(value));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasWord(haystack, needle) {
  if (!haystack || !needle) return false;
  return new RegExp(`${BOUNDARY_LEFT}${escapeRegExp(needle)}${BOUNDARY_RIGHT}`, 'i').test(haystack);
}

function unicodeWordRegex(source, flags = 'giu') {
  return new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${source})(?![\p{L}\p{N}])`, flags);
}

function hasAnyWord(haystack, words) {
  return words.some((word) => hasWord(haystack, normalizePhrase(word)));
}

function countWord(haystack, needle) {
  if (!haystack || !needle) return 0;
  const pattern = new RegExp(`${BOUNDARY_LEFT}${escapeRegExp(needle)}${BOUNDARY_RIGHT}`, 'gi');
  const found = haystack.match(pattern);
  return found ? found.length : 0;
}

function keywordVariants(keyword) {
  const base = normalizePhrase(keyword);
  if (!base) return [];
  const variants = new Set([base]);
  if (base.endsWith('es') && base.length > 4) variants.add(base.slice(0, -2));
  if (base.endsWith('s') && base.length > 3) variants.add(base.slice(0, -1));
  if (!base.endsWith('s')) variants.add(`${base}s`);
  return [...variants].filter(Boolean);
}

function normalizeType(value) {
  return TYPE_LIST.includes(value) ? value : DEFAULT_TYPE;
}

function detectType(text, defaultType) {
  const haystack = normalizePhrase(text);
  if (!haystack) return { type: defaultType, explicit: false };

  if (hasAnyWord(haystack, INCOME_WORDS)) {
    return { type: TRANSACTION_TYPES.INCOME, explicit: true };
  }
  if (hasAnyWord(haystack, INVESTMENT_WORDS)) {
    return { type: TRANSACTION_TYPES.INVESTMENT, explicit: true };
  }
  if (hasWord(haystack, 'gasto fijo')) {
    return { type: TRANSACTION_TYPES.FIXED_EXPENSE, explicit: true };
  }

  const hasExpenseVerb = hasAnyWord(haystack, EXPENSE_VERBS);
  const hasFixedWord = hasAnyWord(haystack, FIXED_WORDS);
  if (hasExpenseVerb && hasFixedWord) {
    return { type: TRANSACTION_TYPES.FIXED_EXPENSE, explicit: true };
  }
  if (hasExpenseVerb) {
    return { type: TRANSACTION_TYPES.VARIABLE_EXPENSE, explicit: true };
  }
  if (hasFixedWord) {
    return { type: TRANSACTION_TYPES.FIXED_EXPENSE, explicit: true };
  }
  return { type: defaultType, explicit: false };
}

/**
 * Detecta el tipo de movimiento segun palabras clave fuertes.
 * @param {string} text
 * @param {{defaultType?: string}} [options]
 * @returns {'income'|'fixed_expense'|'variable_expense'|'investment'}
 */
export function detectTransactionType(text, { defaultType = DEFAULT_TYPE } = {}) {
  return detectType(text, normalizeType(defaultType)).type;
}

/**
 * Devuelve la categoria con mejor puntaje para el texto.
 * @param {string} text
 * @param {Array<object>} categories
 * @returns {object|null}
 */
export function matchCategory(text, categories) {
  const list = Array.isArray(categories) ? categories : [];
  const haystack = normalizePhrase(text);
  if (!haystack) return null;

  let best = null;
  let bestScore = 0;
  let bestPosition = -1;

  for (const category of list) {
    if (!category || typeof category !== 'object' || !category.name) continue;
    const name = normalizePhrase(category.name);
    if (!name) continue;

    let score = 0;
    let position = -1;

    const nameIndex = haystack.indexOf(name);
    // El nombre completo solo puntua como palabra entera (evita falsos
    // positivos por substring, ej. "dia" dentro de "diagnostico").
    if (nameIndex >= 0 && hasWord(haystack, name)) {
      score += 100 + name.length;
      position = Math.max(position, nameIndex);
    }

    const keywords = Array.isArray(category.keywords) ? category.keywords : [];
    for (const keyword of keywords) {
      const variants = keywordVariants(keyword);
      let occurrences = 0;
      let keywordPosition = -1;
      for (const variant of variants) {
        const count = countWord(haystack, variant);
        if (count > 0 && keywordPosition < 0) {
          keywordPosition = haystack.indexOf(variant);
        }
        occurrences += count;
      }
      if (occurrences > 0) {
        score += occurrences * 20;
        position = Math.max(position, keywordPosition);
      }
    }

    // Empate: gana la coincidencia que aparece mas tarde en el texto, porque
    // suele ser la descripcion del comercio y no el contexto previo.
    if (score > bestScore || (score === bestScore && score > 0 && position > bestPosition)) {
      bestScore = score;
      bestPosition = position;
      best = category;
    }
  }

  return best;
}

function findCategoryByName(categories, name) {
  const target = normalizePhrase(name);
  if (!target) return null;
  return categories.find((category) => category && normalizePhrase(category.name) === target) || null;
}

function categoryMatchesTag(category, tag) {
  if (!category || !category.name) return false;
  const name = normalizePhrase(category.name);
  if (!name) return false;
  if (name === tag || name.replace(/\s+/g, '') === tag) return true;
  if (keywordVariants(category.name).includes(tag)) return true;
  const keywords = Array.isArray(category.keywords) ? category.keywords : [];
  return keywords.some((keyword) => keywordVariants(keyword).includes(tag));
}

function categoryFromTags(tags, categories) {
  for (const rawTag of tags) {
    const tag = normalizePhrase(rawTag);
    if (!tag) continue;
    const found = categories.find((category) => categoryMatchesTag(category, tag));
    if (found) return found;
  }
  return null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function utcDayKey(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function safeNow(now) {
  return now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
}

function findExplicitDate(text, now) {
  const raw = String(text ?? '');

  const ymd = new RegExp(YMD_SOURCE).exec(raw);
  if (ymd) {
    const normalized = parseHumanDate(ymd[0], { now });
    if (normalized) return { ymd: normalized, raw: ymd[0] };
  }

  const dmy = new RegExp(DMY_SOURCE).exec(raw);
  if (dmy) {
    const normalized = parseHumanDate(dmy[0], { now });
    if (normalized) return { ymd: normalized, raw: dmy[0] };
  }

  const long = new RegExp(LONG_DATE_SOURCE, 'i').exec(stripAccents(raw));
  if (long) {
    const normalized = parseHumanDate(long[0], { now });
    if (normalized) return { ymd: normalized, raw: long[0] };
  }

  return null;
}

function applyMask(text, source, flags = 'gi') {
  return text.replace(new RegExp(source, flags), (match) => ' '.repeat(match.length));
}

function buildScanText(raw) {
  let scan = applyMask(raw, HASHTAG_SOURCE, 'gu');
  scan = applyMask(scan, YMD_SOURCE);
  scan = applyMask(scan, DMY_SOURCE);
  scan = applyMask(scan, TIME_SOURCE);
  scan = applyMask(scan, PERCENT_SOURCE);
  scan = applyMask(scan, LONG_DATE_SOURCE, 'gi');
  return scan;
}

function digitsOnly(value) {
  return String(value).replace(/\D/g, '');
}

function isLookLikeDateToken(value) {
  const text = normalizeText(value);
  if (!text) return false;
  if (/^\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?$/.test(text)) return true;
  return MONTH_NAMES_ES.some((month) => text.includes(month));
}

function extractAmountCandidates(raw, scan) {
  const candidates = [];
  const matches = [...scan.matchAll(AMOUNT_REGEX)];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index;
    let end = start + match[0].length;
    const token = match[1];

    let multiplier = false;
    const suffix = /^\s*(k|mil|millones?|mill[oó]n(?:es)?)(?![a-z0-9])/i.exec(scan.slice(end));
    if (suffix) {
      multiplier = true;
      end += suffix[0].length;
    }

    let hasCurrencySuffix = false;
    const currencySuffix = new RegExp(String.raw`^\s*(${CURRENCY_WORDS.join('|')})\b`, 'i').exec(scan.slice(end));
    if (currencySuffix) {
      hasCurrencySuffix = true;
      end += currencySuffix[0].length;
    }

    const before = scan.slice(Math.max(0, start - 12), start);
    const hasCurrencyPrefix = /(?:\$|us\$|\b(?:ars|usd|eur|brl|clp|mxn|uyu|pyg|pen))\s*$/i.test(before);
    const hasCurrency = hasCurrencyPrefix || hasCurrencySuffix;

    const rawToken = scan.slice(start, end).trim();
    const fullToken = multiplier || hasCurrencySuffix ? rawToken : token;
    const cents = parseAmountToCents(fullToken);

    const after = scan.slice(end);
    const unit = /^\s*(kg|kgs|g|gr|gramos?|l|lt|lts|litros?|ml|cc|cm|m2|m²|x)(?![a-z0-9])/i.test(after);

    const rawDigits = digitsOnly(token);
    const hasSeparators = /[.,]/.test(token);
    const isYear = !hasSeparators && !multiplier && /^(19|20)\d{2}$/.test(rawDigits);
    const isPhone = !hasSeparators && rawDigits.length > 8;
    const hasDecimals = /[.,]\d{1,2}$/.test(token) && !/^\d{1,3}(?:[.,]\d{3})+$/.test(token);

    const previousEnd = index > 0 ? matches[index - 1].index + matches[index - 1][0].length : 0;
    const windowStart = Math.max(0, start - 32, previousEnd);
    const beforeWindow = normalizePhrase(scan.slice(windowStart, start));
    const afterWindow = normalizePhrase(scan.slice(end, Math.min(scan.length, end + 16)));
    const hasVerb = hasAnyWord(beforeWindow, AMOUNT_VERBS) || hasAnyWord(afterWindow, AMOUNT_VERBS);

    let score = 0;
    if (hasCurrency) score += 4;
    if (hasVerb) score += 3;
    if (hasDecimals) score += 2;
    const units = cents === null ? 0 : Math.abs(cents) / 100;
    if (units > 0) score += Math.min(2, Math.log10(units + 1) * 0.35);

    const isSmallNoContext = rawDigits.length <= 2 && !hasCurrency && !hasVerb;
    if (isSmallNoContext && matches.length > 1) score -= 5;

    candidates.push({
      start,
      end,
      text: scan.slice(start, end).trim(),
      token,
      cents,
      score,
      multiplier,
      hasCurrency,
      hasVerb,
      hasDecimals,
      unit,
      isYear,
      isPhone,
      isSmallNoContext,
    });
  }

  return candidates;
}

const USD_BEFORE = /(?:u\$s|u\$d|us\$|usd|u\.s\.d\.?|dolares|d[oó]lares)\s*$/i;
const USD_AFTER = /^\s*(?:usd|u\$s|us\$|d[oó]lar(?:es)?|verdes)(?![a-z0-9])/i;

/**
 * Moneda explicita pegada al monto elegido ("u$s 100", "100 dolares",
 * "USD 15"). Solo mira alrededor del monto: "compre dolares por 150000"
 * sigue siendo un monto en pesos.
 */
function detectAmountCurrency(raw, candidate) {
  if (!candidate) return null;
  const before = String(raw).slice(Math.max(0, candidate.start - 10), candidate.start);
  const after = String(raw).slice(candidate.end, candidate.end + 12);
  if (USD_BEFORE.test(before) || USD_AFTER.test(after)) return 'USD';
  if (/(?:usd|u\$s|us\$)$/i.test(String(candidate.text || '').trim())) return 'USD';
  return null;
}

function withoutCurrencyMarker(raw, candidate) {
  const before = String(raw).slice(0, candidate.start).replace(USD_BEFORE, ' ');
  const after = String(raw).slice(candidate.end).replace(USD_AFTER, ' ');
  return `${before} ${String(raw).slice(candidate.start, candidate.end)} ${after}`;
}

function cleanNote(raw, candidate, explicitDateRaw, categoryName, type) {
  let note = String(raw ?? '');
  if (candidate) {
    note = `${note.slice(0, candidate.start)} ${note.slice(candidate.end)}`;
  }
  note = note.replace(new RegExp(HASHTAG_SOURCE, 'gu'), ' ');
  if (explicitDateRaw) note = note.replace(new RegExp(escapeRegExp(explicitDateRaw), 'gi'), ' ');
  note = note.replace(unicodeWordRegex('hoy|ayer|anteayer'), ' ');
  note = note.replace(unicodeWordRegex(NOTE_VERBS.join('|')), ' ');
  note = note.replace(unicodeWordRegex(NOTE_FILLERS.join('|')), ' ');
  note = note.replace(/\bu\$[sd]\b|\bus\$|\bverdes\b/gi, ' ');
  note = note.replace(unicodeWordRegex('ars|usd|eur|brl|clp|mxn|uyu|pyg|pen|pesos?|d[oó]lares?|euros?'), ' ');
  note = note.replace(/[$€£¥]/g, ' ');
  note = note.replace(/\s+/g, ' ').trim();
  note = note.replace(/^[\s.,;:¡!¿?"'()\-–—]+/, '').replace(/[\s.,;:¡!¿?"'()\-–—]+$/, '');
  if (note.length > 180) note = `${note.slice(0, 179).trimEnd()}…`;
  if (!note) note = categoryName || TYPE_LABELS[type] || 'Movimiento';
  return note.charAt(0).toUpperCase() + note.slice(1);
}

function buildResult(base) {
  return {
    ok: Boolean(base.ok),
    ...(base.reason ? { reason: base.reason } : {}),
    amountCents: base.amountCents ?? null,
    amountText: base.amountText ?? null,
    type: base.type || DEFAULT_TYPE,
    typeWasExplicit: Boolean(base.typeWasExplicit),
    currency: base.currency || 'ARS',
    category: base.category ?? null,
    categoryName: base.categoryName ?? null,
    note: base.note || '',
    tags: Array.isArray(base.tags) ? base.tags : [],
    occurredAt: base.occurredAt,
    confidence: base.confidence ?? 0,
    raw: base.raw ?? '',
    warnings: Array.isArray(base.warnings) ? base.warnings : [],
  };
}

/**
 * Interpreta un mensaje libre y devuelve el movimiento detectado.
 * @param {string} message
 * @param {{categories?: Array<object>, defaultType?: string, now?: Date, currency?: string, forceType?: boolean}} [options]
 */
export function parseTransactionMessage(message, options = {}) {
  const {
    categories = [],
    defaultType = DEFAULT_TYPE,
    now = new Date(),
    currency = 'ARS',
    forceType = false,
  } = options || {};

  const raw = message === null || message === undefined ? '' : String(message);
  const effectiveNow = safeNow(now);
  const normalizedDefault = normalizeType(defaultType);
  const categoryList = Array.isArray(categories) ? categories : [];

  const base = {
    ok: false,
    amountCents: null,
    amountText: null,
    type: normalizedDefault,
    typeWasExplicit: false,
    currency,
    category: null,
    categoryName: null,
    note: '',
    tags: extractTags(raw),
    occurredAt: effectiveNow.toISOString(),
    confidence: 0,
    raw,
    warnings: [],
  };

  if (!normalizeText(raw)) {
    return buildResult({ ...base, reason: 'empty', occurredAt: effectiveNow.toISOString() });
  }

  let typeInfo = forceType
    ? { type: normalizedDefault, explicit: true }
    : detectType(raw, normalizedDefault);

  const scan = buildScanText(raw);
  const candidates = extractAmountCandidates(raw, scan);
  const usable = candidates.filter((candidate) => {
    if (candidate.cents === null) return false;
    if (candidate.isPhone && !candidate.hasCurrency) return false;
    if (candidate.isYear && !candidate.hasCurrency && !candidate.hasVerb) return false;
    return true;
  });

  let pool = usable;
  if (pool.length > 1) {
    const withoutUnits = pool.filter((candidate) => !candidate.unit);
    if (withoutUnits.length > 0) pool = withoutUnits;
  }

  let best = null;
  for (const candidate of pool) {
    if (!best) {
      best = candidate;
      continue;
    }
    if (candidate.score > best.score) best = candidate;
    else if (candidate.score === best.score && Math.abs(candidate.cents) > Math.abs(best.cents)) best = candidate;
  }

  if (!best) {
    return buildResult({
      ...base,
      reason: 'missing-amount',
      type: typeInfo.type,
      typeWasExplicit: typeInfo.explicit,
    });
  }

  const detectedCurrency = detectAmountCurrency(raw, best) || currency;
  // "100 dolares": la palabra es la moneda del monto, no una compra de dolares
  // (inversion). Tipo y categoria se deciden sin ese marcador.
  const contextText = detectedCurrency === 'USD' ? withoutCurrencyMarker(raw, best) : raw;
  if (contextText !== raw && !forceType) typeInfo = detectType(contextText, normalizedDefault);

  if (best.multiplier && pool.length > 1) {
    base.warnings.push('Se aplicó un multiplicador sobre un monto ambiguo.');
  }

  if (!Number.isFinite(best.cents) || best.cents <= 0) {
    base.warnings.push(best.cents === 0 ? 'El monto es cero.' : 'El monto debe ser mayor a cero.');
    return buildResult({
      ...base,
      reason: 'invalid-amount',
      amountCents: null,
      amountText: best.text,
      type: typeInfo.type,
      typeWasExplicit: typeInfo.explicit,
      confidence: 0.05,
    });
  }

  const tags = base.tags;
  const dateInfo = findExplicitDate(raw, effectiveNow);
  let occurredAt = effectiveNow;
  let explicitDate = false;

  if (dateInfo) {
    explicitDate = true;
    occurredAt = new Date(`${dateInfo.ymd}T12:00:00.000Z`);
    if (dateInfo.ymd > utcDayKey(effectiveNow)) {
      base.warnings.push('La fecha indicada está en el futuro.');
    }
  } else {
    const haystack = normalizePhrase(raw);
    if (hasWord(haystack, 'anteayer')) {
      occurredAt = new Date(effectiveNow.getTime() - 2 * 86_400_000);
    } else if (hasWord(haystack, 'ayer')) {
      occurredAt = new Date(effectiveNow.getTime() - 86_400_000);
    }
  }

  // La categoria se deduce primero del texto libre (comercio/contexto; los
  // hashtags no cuentan como texto) y, si no hay coincidencia, de los tags.
  let category = matchCategory(stripHashtags(contextText), categoryList);
  if (!category) category = categoryFromTags(tags, categoryList);
  if (!category) {
    const fallbackName = FALLBACK_CATEGORY_BY_TYPE[typeInfo.type] || null;
    if (fallbackName) category = findCategoryByName(categoryList, fallbackName);
  }

  const categoryName = category?.name || null;
  const note = cleanNote(raw, best, dateInfo?.raw || null, categoryName, typeInfo.type);

  let confidence = 0.4;
  confidence += 0.25;
  if (category) confidence += 0.2;
  if (typeInfo.explicit) confidence += 0.1;
  if (explicitDate || tags.length > 0) confidence += 0.05;
  confidence = Math.max(0.05, Math.min(0.99, confidence));

  return buildResult({
    ...base,
    ok: true,
    currency: detectedCurrency,
    amountCents: best.cents,
    amountText: best.text,
    type: typeInfo.type,
    typeWasExplicit: typeInfo.explicit,
    category,
    categoryName,
    note,
    tags,
    occurredAt: occurredAt.toISOString(),
    confidence,
  });
}

/**
 * Wrapper para comandos: fuerza el tipo del comando salvo forceType:false.
 * @param {string} args
 * @param {{defaultType?: string, forceType?: boolean, categories?: Array<object>, now?: Date, currency?: string}} [options]
 */
export function parseTransactionArgs(args, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const forceType = Boolean(opts.defaultType) && opts.forceType !== false;
  return parseTransactionMessage(String(args ?? ''), { ...opts, forceType });
}

function parseEmoji(raw) {
  const emoji = /\p{Extended_Pictographic}\uFE0F?/u.exec(raw);
  if (!emoji) return { emoji: '🏷️', rest: raw };
  return { emoji: emoji[0], rest: raw.replace(emoji[0], ' ') };
}

function typeAlias(raw) {
  const value = normalizePhrase(raw);
  const aliases = {
    'gasto fijo': TRANSACTION_TYPES.FIXED_EXPENSE,
    'gasto_fijo': TRANSACTION_TYPES.FIXED_EXPENSE,
    fijo: TRANSACTION_TYPES.FIXED_EXPENSE,
    fixed: TRANSACTION_TYPES.FIXED_EXPENSE,
    fixed_expense: TRANSACTION_TYPES.FIXED_EXPENSE,
    variable: TRANSACTION_TYPES.VARIABLE_EXPENSE,
    'gasto variable': TRANSACTION_TYPES.VARIABLE_EXPENSE,
    'gasto': TRANSACTION_TYPES.VARIABLE_EXPENSE,
    variable_expense: TRANSACTION_TYPES.VARIABLE_EXPENSE,
    ingreso: TRANSACTION_TYPES.INCOME,
    income: TRANSACTION_TYPES.INCOME,
    sueldo: TRANSACTION_TYPES.INCOME,
    inversion: TRANSACTION_TYPES.INVESTMENT,
    investment: TRANSACTION_TYPES.INVESTMENT,
    ahorro: TRANSACTION_TYPES.INVESTMENT,
    invertir: TRANSACTION_TYPES.INVESTMENT,
  };
  return aliases[value] || null;
}

function splitArgs(raw) {
  if (raw.includes('|')) {
    return raw.split('|').map((part) => part.trim()).filter(Boolean);
  }
  if (raw.includes(',')) {
    return raw.split(',').map((part) => part.trim()).filter(Boolean);
  }
  return null;
}

function cleanName(raw) {
  return String(raw ?? '').replace(/\s+/g, ' ').trim();
}

function trailingAmount(text) {
  const match = new RegExp(String.raw`^(.*?)\s+(${THOUSANDS_AMOUNT})$`, 'i').exec(String(text ?? '').trim());
  if (!match) return null;
  const cents = parseAmountToCents(match[2]);
  return { prefix: cleanName(match[1]), amountText: match[2].trim(), cents };
}

/**
 * Interpreta la creacion de una categoria.
 * Formatos: "Nombre | tipo | 50000", "Nombre, tipo, 50000", "Nombre 50000".
 */
export function parseCategoryCreation(args) {
  const raw = cleanName(args);
  const empty = {
    ok: false,
    name: '',
    type: TRANSACTION_TYPES.VARIABLE_EXPENSE,
    emoji: '🏷️',
    monthlyBudgetCents: null,
    budgetCents: null,
    error: null,
  };

  if (!raw) return { ...empty, error: 'Indicá el nombre de la categoría.' };

  const { emoji, rest } = parseEmoji(raw);
  const parts = splitArgs(rest);

  let name = '';
  let type = TRANSACTION_TYPES.VARIABLE_EXPENSE;
  let budgetCents = null;

  if (parts && parts.length > 0) {
    const [first, ...others] = parts;
    name = cleanName(first);
    for (const part of others) {
      const alias = typeAlias(part);
      if (alias) {
        type = alias;
        continue;
      }
      const cents = moneyCents(part);
      if (cents !== null) {
        budgetCents = cents;
        continue;
      }
      return { ...empty, name, type, emoji, error: `No entendí "${part}".` };
    }
  } else {
    const tail = trailingAmount(rest);
    if (tail) {
      name = tail.prefix;
      budgetCents = tail.cents;
    } else {
      name = cleanName(rest);
    }
  }

  name = cleanName(name);
  if (name.length < 2 || name.length > 40) {
    return { ...empty, name, type, emoji, error: 'El nombre debe tener entre 2 y 40 caracteres.' };
  }

  if (budgetCents !== null && (!Number.isSafeInteger(budgetCents) || budgetCents <= 0)) {
    return { ...empty, name, type, emoji, error: 'El presupuesto debe ser mayor a cero.' };
  }

  return {
    ok: true,
    name,
    type,
    emoji,
    monthlyBudgetCents: budgetCents,
    budgetCents,
    error: null,
  };
}

/**
 * Interpreta una actualizacion de presupuesto.
 * Formatos: "Comida 120000", "Comida = 120.000", "general 800000".
 */
export function parseBudgetUpdate(args) {
  const empty = {
    ok: false,
    categoryName: null,
    isOverall: false,
    amountCents: null,
    error: null,
  };

  let raw = cleanName(args);
  if (!raw) return { ...empty, error: 'Indicá la categoría y el monto.' };

  raw = raw.replace(/^presupuesto\s+/i, '').trim();

  const overallAliases = new Set(['general', 'total', 'global']);
  let left = '';
  let amountText = '';

  if (raw.includes('=')) {
    const [rawLeft, rawRight] = raw.split('=');
    left = cleanName(rawLeft);
    amountText = cleanName(rawRight);
  } else {
    const match = new RegExp(String.raw`^(.*?)\s+(${THOUSANDS_AMOUNT})$`, 'i').exec(raw);
    if (!match) {
      if (new RegExp(String.raw`^${THOUSANDS_AMOUNT}$`, 'i').test(raw)) {
        return { ...empty, error: 'Indicá una categoría o "general".' };
      }
      return { ...empty, error: 'No encontré el monto. Ejemplo: /presupuesto_set Comida 120000.' };
    }
    left = cleanName(match[1]);
    amountText = match[2].trim();
  }

  if (!amountText) return { ...empty, error: 'No encontré el monto.' };

  const amountCents = parseAmountToCents(amountText);
  if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ...empty, amountCents: null, error: 'El monto debe ser mayor a cero.' };
  }

  const normalizedLeft = normalizePhrase(left);
  const isOverall = overallAliases.has(normalizedLeft);
  if (!isOverall && !left) {
    return { ...empty, amountCents, error: 'Indicá una categoría o "general".' };
  }

  return {
    ok: true,
    categoryName: isOverall ? null : left,
    isOverall,
    amountCents,
    error: null,
  };
}

/**
 * Interpreta la creacion de una meta de ahorro.
 * Formatos: "Vacaciones 500000 2027-01-01", "Vacaciones | 500000 | 2027-01-01".
 */
export function parseGoalCreation(args) {
  const empty = {
    ok: false,
    name: '',
    targetCents: null,
    deadline: null,
    error: null,
  };

  const raw = cleanName(args);
  if (!raw) return { ...empty, error: 'Indicá el nombre de la meta y el objetivo.' };

  let name = '';
  let amountText = '';
  let deadlineRaw = null;

  const parts = splitArgs(raw);
  if (parts) {
    if (parts.length < 2) return { ...empty, error: 'Faltan datos. Ejemplo: /meta Vacaciones 500000 2027-01-01.' };
    if (parts.length > 3) return { ...empty, error: 'Usá como máximo nombre, monto y fecha.' };
    [name, amountText] = parts;
    deadlineRaw = parts[2] || null;
  } else {
    const withDate = new RegExp(
      String.raw`^(.*?)\s+(${THOUSANDS_AMOUNT})(?:\s+(\S+))?$`,
      'i',
    ).exec(raw);
    if (withDate && withDate[3] && isLookLikeDateToken(withDate[3])) {
      name = withDate[1];
      amountText = withDate[2];
      deadlineRaw = withDate[3];
    } else {
      const withoutDate = new RegExp(String.raw`^(.*?)\s+(${THOUSANDS_AMOUNT})$`, 'i').exec(raw);
      if (!withoutDate) return { ...empty, error: 'No encontré el objetivo. Ejemplo: /meta Vacaciones 500000.' };
      name = withoutDate[1];
      amountText = withoutDate[2];
    }
  }

  name = cleanName(name);
  if (name.length < 2 || name.length > 60) {
    return { ...empty, name, error: 'El nombre debe tener entre 2 y 60 caracteres.' };
  }

  const targetCents = parseAmountToCents(amountText);
  if (targetCents === null || !Number.isSafeInteger(targetCents) || targetCents <= 0) {
    return { ...empty, name, error: 'El objetivo debe ser mayor a cero.' };
  }

  let deadline = null;
  if (deadlineRaw) {
    deadline = parseHumanDate(deadlineRaw);
    if (!deadline) {
      return { ...empty, name, targetCents, error: 'La fecha no es válida. Usá AAAA-MM-DD o DD/MM/AAAA.' };
    }
  }

  return { ok: true, name, targetCents, deadline, error: null };
}

/**
 * Interpreta un aporte a una meta: "Vacaciones 50000" o "50000 Vacaciones".
 */
export function parseContribution(args) {
  const empty = { ok: false, goalName: '', amountCents: null, error: null };
  const raw = cleanName(args);
  if (!raw) return { ...empty, error: 'Indicá la meta y el monto del aporte.' };

  let match = new RegExp(String.raw`^(.*?)\s+(${THOUSANDS_AMOUNT})$`, 'i').exec(raw);
  let name = '';
  let amountText = '';
  if (match) {
    name = match[1];
    amountText = match[2];
  } else {
    match = new RegExp(String.raw`^(${THOUSANDS_AMOUNT})\s+(.+)$`, 'i').exec(raw);
    if (!match) return { ...empty, error: 'No encontré el monto. Ejemplo: /aporte Vacaciones 50000.' };
    amountText = match[1];
    name = match[2];
  }

  name = cleanName(name);
  if (name.length < 2 || name.length > 60) {
    return { ...empty, goalName: name, error: 'El nombre de la meta debe tener entre 2 y 60 caracteres.' };
  }

  const amountCents = parseAmountToCents(amountText);
  if (amountCents === null || !Number.isSafeInteger(amountCents) || amountCents <= 0) {
    return { ...empty, goalName: name, error: 'El monto debe ser mayor a cero.' };
  }

  return { ok: true, goalName: name, amountCents, error: null };
}

/** true si el parser considera que hay un movimiento valido. */
export function isLikelyTransaction(parsed) {
  return Boolean(parsed && parsed.ok === true);
}

/** true si el texto contiene algun indicio monetario. */
export function hasMoneySignal(text) {
  return /[\d$€£¥]/.test(String(text ?? ''));
}
