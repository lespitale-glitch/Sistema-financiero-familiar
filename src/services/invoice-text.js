/**
 * Extraccion de datos de una factura a partir de texto plano (salida del OCR
 * de macOS o texto de un PDF digital), sin IA: reglas pensadas para facturas
 * y tickets argentinos (Edesur, Metrogas, AySA, Personal, supermercados...).
 *
 * Devuelve el mismo "raw" que Gemini (vendor, total, due_date, ...) para que
 * ocr.js lo normalice igual en los dos motores.
 */

import { matchCategory } from './parser.js';
import { parseAmountToCents } from '../utils/money.js';
import { pad2 } from '../utils/dates.js';
import { TRANSACTION_TYPES } from '../domain.js';

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

/** Comercios/servicios frecuentes -> nombre visible + palabra para categorizar. */
const KNOWN_VENDORS = Object.freeze([
  { pattern: /\bedesur\b/, name: 'Edesur', hint: 'luz', fixed: true },
  { pattern: /\bedenor\b/, name: 'Edenor', hint: 'luz', fixed: true },
  { pattern: /\bmetrogas\b/, name: 'Metrogas', hint: 'gas', fixed: true },
  { pattern: /\bnaturgy\b/, name: 'Naturgy', hint: 'gas', fixed: true },
  { pattern: /\bcamuzzi\b/, name: 'Camuzzi', hint: 'gas', fixed: true },
  { pattern: /\baysa\b|agua y saneamientos/, name: 'AySA', hint: 'agua', fixed: true },
  { pattern: /\btelecom\b|\bpersonal\b.*\bflow\b|\bflow\b/, name: 'Telecom / Personal', hint: 'internet', fixed: true },
  { pattern: /\bfibertel\b/, name: 'Fibertel', hint: 'internet', fixed: true },
  { pattern: /\btelecentro\b/, name: 'Telecentro', hint: 'internet', fixed: true },
  { pattern: /\bmovistar\b/, name: 'Movistar', hint: 'celular', fixed: true },
  { pattern: /\bclaro\b/, name: 'Claro', hint: 'celular', fixed: true },
  { pattern: /\bdirectv\b/, name: 'DirecTV', hint: 'cable', fixed: true },
  { pattern: /\bnetflix\b/, name: 'Netflix', hint: 'netflix', fixed: true },
  { pattern: /\bspotify\b/, name: 'Spotify', hint: 'spotify', fixed: true },
  { pattern: /\bdisney\b/, name: 'Disney+', hint: 'disney', fixed: true },
  { pattern: /\bosde\b/, name: 'OSDE', hint: 'prepaga', fixed: true },
  { pattern: /swiss medical/, name: 'Swiss Medical', hint: 'prepaga', fixed: true },
  { pattern: /\bgaleno\b/, name: 'Galeno', hint: 'prepaga', fixed: true },
  { pattern: /\bmedife\b/, name: 'Medifé', hint: 'prepaga', fixed: true },
  { pattern: /\bexpensas\b|\badministracion de consorcio|\bconsorcio\b/, name: 'Expensas', hint: 'expensas', fixed: true },
  { pattern: /\babl\b|\bagip\b|alumbrado,? barrido/, name: 'ABL (AGIP)', hint: 'servicio', fixed: true },
  { pattern: /\barba\b/, name: 'ARBA', hint: 'servicio', fixed: true },
  { pattern: /\bcoto\b/, name: 'Coto', hint: 'supermercado', fixed: false },
  { pattern: /\bcarrefour\b/, name: 'Carrefour', hint: 'supermercado', fixed: false },
  { pattern: /\bjumbo\b/, name: 'Jumbo', hint: 'supermercado', fixed: false },
  { pattern: /\bdisco\b/, name: 'Disco', hint: 'supermercado', fixed: false },
  { pattern: /\bvea\b/, name: 'Vea', hint: 'supermercado', fixed: false },
  { pattern: /\bchango ?mas\b/, name: 'ChangoMás', hint: 'supermercado', fixed: false },
  { pattern: /\bsupermercados? dia\b|\bdia argentina\b/, name: 'Día', hint: 'supermercado', fixed: false },
  { pattern: /\bfarmacity\b/, name: 'Farmacity', hint: 'farmacia', fixed: false },
  { pattern: /\bypf\b/, name: 'YPF', hint: 'nafta', fixed: false },
  { pattern: /\bshell\b/, name: 'Shell', hint: 'nafta', fixed: false },
  { pattern: /\baxion\b/, name: 'Axion', hint: 'nafta', fixed: false },
  { pattern: /mercado ?libre/, name: 'Mercado Libre', hint: null, fixed: false },
]);

// Palabras clave de total, de mas a menos especificas.
const TOTAL_RULES = Object.freeze([
  { pattern: /total a pagar|importe a pagar|monto a pagar|saldo a pagar|total a abonar|importe a abonar|total adeudado|total pagado|monto pagado|su pago|pagar hasta/, weight: 4 },
  { pattern: /importe total|total factura|total general|total final|total con iva|total \$|\btotal\b/, weight: 2 },
]);
const TOTAL_EXCLUDE = /sub ?total|total (?:iva|neto|gravado|no gravado|exento|impuestos?|percepciones?|bonificaci|descuentos?|de items|items|articulos|unidades)|cantidad|ahorro|vuelto|cambio|recibido|efectivo|tarjeta/;

const DUE_PATTERN = /venc(?:imiento|e|io|\.)?|\bvto\b|pagar hasta|pague hasta|abonar hasta|fecha limite|fecha de pago/;
const DUE_EXCLUDE = /proximo|siguiente|prox\./;
const ISSUED_PATTERN = /fecha de emision|emision|fecha de factura|fecha factura|^fecha\b|\bfecha:/;

const NUMERIC_DATE = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})\b/g;
// Acepta "05 de noviembre de 2026", "28/octubre/2026", "28-oct-26" y "28/oct - 11:27" (sin año).
const TEXT_DATE = /\b(\d{1,2})\s*(?:de\s+|[/.-]\s*)?(ene|feb|mar|abr|may|jun|jul|ago|sep|set|oct|nov|dic)[a-z]*\.?\s*(?:de\s+|del\s+|[/.-]\s*)?(\d{4}|\d{2}(?![:\d]))?\b/g;
const AMOUNT_TOKEN = /(?:\$|ars|u\$s|us\$|usd)?\s*(\d{1,3}(?:[.\s]\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?![\d/])/gi;

function normalizeLine(line) {
  return String(line || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function validYmd(year, month, day) {
  if (!Number.isInteger(year) || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function normalizeYear(raw, defaultYear) {
  if (!raw) return defaultYear;
  const year = Number(raw);
  return raw.length === 2 ? 2000 + year : year;
}

/** Todas las fechas (YYYY-MM-DD) que aparecen en una linea. */
export function findDates(line, { defaultYear }) {
  const text = normalizeLine(line);
  const dates = [];
  for (const match of text.matchAll(NUMERIC_DATE)) {
    const ymd = validYmd(normalizeYear(match[3], defaultYear), Number(match[2]), Number(match[1]));
    if (ymd) dates.push(ymd);
  }
  for (const match of text.matchAll(TEXT_DATE)) {
    const monthKey = match[2] === 'set' ? 'sep' : match[2];
    const month = MONTHS.indexOf(monthKey) + 1;
    const ymd = validYmd(normalizeYear(match[3], defaultYear), month, Number(match[1]));
    if (ymd) dates.push(ymd);
  }
  return dates;
}

/** Montos de una linea (sin fechas, CUIT ni numeros de cliente). */
export function findAmounts(line) {
  const text = normalizeLine(line)
    .replace(NUMERIC_DATE, ' ')
    .replace(/\b\d{2}-\d{8}-\d\b/g, ' ') // CUIT
    .replace(/\b\d{4,5}-\d{6,8}\b/g, ' '); // punto de venta - numero de factura
  const amounts = [];
  for (const match of text.matchAll(AMOUNT_TOKEN)) {
    const token = match[1].replace(/\s/g, '.');
    const digits = token.replace(/\D/g, '');
    const hasSymbol = /\$|ars|usd|u\$s|us\$/.test(match[0]);
    const hasDecimals = /,\d{1,2}$/.test(token) || /\.\d{2}$/.test(token);
    // Numeros largos sin formato de dinero suelen ser codigos (cliente, medidor).
    if (!hasSymbol && !hasDecimals && !/[.,]/.test(token) && digits.length > 7) continue;
    const cents = parseAmountToCents(token);
    if (Number.isSafeInteger(cents) && cents > 0) {
      amounts.push({ cents, text: token, hasSymbol, hasDecimals });
    }
  }
  return amounts;
}

function pickAmountNear(lines, index) {
  const own = findAmounts(lines[index]);
  if (own.length) return own[own.length - 1];
  for (let offset = 1; offset <= 2 && index + offset < lines.length; offset += 1) {
    const next = lines[index + offset];
    if (/[a-z]{4,}/i.test(normalizeLine(next).replace(/\$|ars|usd/g, ''))) continue; // linea con texto: no es el monto suelto
    const amounts = findAmounts(next);
    if (amounts.length) return amounts[amounts.length - 1];
  }
  return null;
}

function findTotal(lines) {
  let best = null;
  lines.forEach((line, index) => {
    const normalized = normalizeLine(line);
    if (TOTAL_EXCLUDE.test(normalized) && !/total a pagar|importe a pagar/.test(normalized)) return;
    const rule = TOTAL_RULES.find((candidate) => candidate.pattern.test(normalized));
    if (!rule) return;
    const amount = pickAmountNear(lines, index);
    if (!amount) return;
    if (!best || rule.weight > best.weight) best = { ...amount, weight: rule.weight, line: index };
  });
  if (best) return best;

  // Sin palabra clave: el mayor monto con $ o con decimales (confianza baja).
  let fallback = null;
  for (const line of lines) {
    for (const amount of findAmounts(line)) {
      if (!amount.hasSymbol && !amount.hasDecimals) continue;
      if (!fallback || amount.cents > fallback.cents) fallback = { ...amount, weight: 0 };
    }
  }
  return fallback;
}

function findDateNear(lines, index, defaultYear) {
  for (let offset = 0; offset <= 1 && index + offset < lines.length; offset += 1) {
    const dates = findDates(lines[index + offset], { defaultYear });
    if (dates.length) return dates;
  }
  return [];
}

function findDueDate(lines, defaultYear) {
  const candidates = [];
  lines.forEach((line, index) => {
    const normalized = normalizeLine(line);
    if (!DUE_PATTERN.test(normalized) || DUE_EXCLUDE.test(normalized)) return;
    candidates.push(...findDateNear(lines, index, defaultYear));
  });
  // Primer vencimiento = la fecha mas temprana.
  return candidates.sort()[0] || null;
}

function findIssuedDate(lines, defaultYear) {
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeLine(lines[index]);
    if (!ISSUED_PATTERN.test(normalized) || DUE_PATTERN.test(normalized)) continue;
    const dates = findDateNear(lines, index, defaultYear);
    if (dates.length) return dates[0];
  }
  return null;
}

function findVendor(lines, fullText) {
  for (const vendor of KNOWN_VENDORS) {
    if (vendor.pattern.test(fullText)) return vendor;
  }
  // Primera linea con letras que no sea un rotulo fiscal.
  const skip = /^(factura|original|duplicado|ticket|comprobante|recibo|cuit|iva|responsable|ingresos brutos|inicio de|fecha|nro|n°|cod|codigo|tipo|pagina|hoja|[a-c]$)/;
  for (const line of lines.slice(0, 8)) {
    const normalized = normalizeLine(line);
    if (normalized.length < 3 || !/[a-z]{3,}/.test(normalized) || skip.test(normalized)) continue;
    return { name: line.trim().replace(/\s{2,}/g, ' ').slice(0, 60), hint: null, fixed: false, guessed: true };
  }
  return null;
}

function detectCurrency(fullText) {
  if (/\bu\$s\b|\bus\$|\busd\b|\bdolares estadounidenses\b/.test(fullText)) return 'USD';
  return null;
}

// ---------------------------------------------------------------------------
// Comprobantes de Mercado Pago (transferencias, pagos en comercios, recargas)
// ---------------------------------------------------------------------------

const MP_MARKERS = /mercado ?pago|dinero disponible|n\.?\s*º?\s*de operaci[oó]n|origen y destino|pago en tienda/;
const MP_NOT_A_NAME = /mercado ?pago|cvu|cbu|cuit|cuil|alias|banco|bco\b|operaci|motivo|comprobante|origen|destino|aprobad|rechazad|pendiente|medio de pago|dinero disponible|tienda|online|categor|ubicaci|acciones|agregar|denunciar|detalle|total|fecha|hora|usuario|asistente|transfer|enviad|recibid|compart|descarg|ayuda|^de$|^para$/;
const MP_CATEGORY_MAP = Object.freeze({
  'comidas y bebidas': 'Comida',
  restaurantes: 'Comida',
  'delivery': 'Comida',
  supermercado: 'Supermercado',
  supermercados: 'Supermercado',
  transporte: 'Transporte',
  combustible: 'Transporte',
  servicios: 'Servicios',
  recargas: 'Servicios',
  'recarga de celular': 'Servicios',
  salud: 'Salud',
  farmacia: 'Salud',
  entretenimiento: 'Entretenimiento',
  hogar: 'Hogar',
  educacion: 'Educacion',
});

/** Renglon que parece un nombre (persona o comercio), tolerante a mayusculas y acentos. */
function looksLikeName(line) {
  const raw = String(line || '').trim();
  const normalized = normalizeLine(raw);
  if (normalized.length < 3 || normalized.length > 60) return false;
  if (!/[a-z]{2,}/.test(normalized) || /\d{3,}/.test(normalized) || /\$/.test(raw)) return false;
  if (MP_NOT_A_NAME.test(normalized)) return false;
  if (findDates(raw, { defaultYear: 2000 }).length) return false;
  return true;
}

function firstHeadlineAmount(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    const amount = findAmounts(lines[index]).find((candidate) => candidate.hasSymbol);
    if (amount) return { ...amount, line: index };
  }
  return null;
}

function mercadoPagoCategory(lines, categories) {
  for (let index = 0; index < lines.length; index += 1) {
    const normalized = normalizeLine(lines[index]);
    const inline = /^categor[ií]a[:\s]+(.+)$/.exec(normalized);
    const value = inline ? inline[1] : (/^categor[ií]a$/.test(normalized) ? normalizeLine(lines[index + 1] || '') : null);
    if (!value) continue;
    const mapped = MP_CATEGORY_MAP[value] || Object.entries(MP_CATEGORY_MAP).find(([key]) => value.includes(key))?.[1];
    const found = mapped && categories.find((category) => normalizeLine(category.name) === normalizeLine(mapped));
    if (found) return found;
  }
  return null;
}

/**
 * Datos de un comprobante de Mercado Pago o null si no lo es. Busca por
 * palabras clave (no por posicion), asi tolera capturas con otro tamaño,
 * orden o recorte.
 */
export function extractMercadoPago(lines, { categories = [], defaultYear } = {}) {
  const fullText = normalizeLine(lines.join(' \n '));
  if (!MP_MARKERS.test(fullText)) return null;

  // Vision une en un renglon los bloques a la misma altura ("Burger King  $10.900"):
  // se trabaja por bloques para que el orden o la posicion no importen.
  const segments = lines.flatMap((line) => line.split(/\s{2,}/)).map((segment) => segment.trim()).filter(Boolean);
  const headline = firstHeadlineAmount(segments);
  const motivoMatch = lines.map((line) => /motivo[:\s]+(.+?)(?:\s{2,}|$)/i.exec(line)).find(Boolean);
  const motivo = motivoMatch ? motivoMatch[1].trim() : null;
  let issuedDate = null;
  for (const line of lines) {
    const dates = findDates(line, { defaultYear });
    if (dates.length) { issuedDate = dates[0]; break; }
  }

  const isTransfer = /comprobante de transferencia|origen y destino|transferiste|transferencia (?:enviada|realizada|exitosa)/.test(fullText);
  if (isTransfer) {
    const start = segments.findIndex((segment) => /origen y destino|^de$|^para$/.test(normalizeLine(segment)));
    const names = segments.slice(start >= 0 ? start + 1 : 0).filter(looksLikeName);
    const destination = names.length >= 2 ? names[1] : (names[0] || null);
    return {
      kind: 'transfer',
      vendor: destination ? `Transferencia a ${destination.replace(/\s+/g, ' ').trim()}` : 'Transferencia (Mercado Pago)',
      description: motivo ? `Motivo: ${motivo}` : 'Transferencia por Mercado Pago',
      total: headline?.text || null,
      issued_date: issuedDate,
      category: null,
      type: TRANSACTION_TYPES.VARIABLE_EXPENSE,
      found: { amount: Boolean(headline), party: Boolean(destination) },
    };
  }

  // Pago en comercio / recarga: comercio conocido, o el nombre cerca del monto destacado.
  const known = KNOWN_VENDORS.find((vendor) => vendor.pattern.test(fullText));
  let merchant = known?.name || null;
  if (!merchant && headline) {
    const sameBlock = segments[headline.line].replace(/(?:\$|ars|u\$s|us\$|usd)\s*[\d.,\s]+/i, ' ').trim();
    const around = [
      sameBlock,
      ...segments.slice(headline.line + 1, headline.line + 4),
      ...segments.slice(Math.max(0, headline.line - 2), headline.line).reverse(),
    ];
    merchant = around.find(looksLikeName)?.trim() || null;
  }
  const recarga = /recarga de celular|recarga/.test(fullText);
  const mpCategory = mercadoPagoCategory(lines, categories)
    || (recarga ? categories.find((category) => category.name === 'Servicios') : null)
    || (known?.hint ? matchCategory(known.hint, categories) : null)
    || (merchant ? matchCategory(merchant, categories) : null);
  return {
    kind: 'payment',
    vendor: merchant,
    description: recarga ? `Recarga de celular${merchant ? ` ${merchant}` : ''}` : (merchant ? `Pago en ${merchant}` : 'Pago con Mercado Pago'),
    total: headline?.text || null,
    issued_date: issuedDate,
    category: mpCategory?.name || null,
    type: mpCategory?.type === TRANSACTION_TYPES.FIXED_EXPENSE ? TRANSACTION_TYPES.FIXED_EXPENSE : TRANSACTION_TYPES.VARIABLE_EXPENSE,
    found: { amount: Boolean(headline), party: Boolean(merchant) },
  };
}

/**
 * @param {string} text Texto del OCR (una linea por renglon).
 * @param {{categories?: object[], now?: Date, defaultYear?: number}} [options]
 * @returns {object} raw compatible con el esquema de Gemini.
 */
export function extractInvoiceFields(text, { categories = [], now = new Date(), defaultYear } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const fullText = normalizeLine(lines.join(' \n '));
  const year = defaultYear || now.getUTCFullYear();

  const mp = extractMercadoPago(lines, { categories, defaultYear: year });
  if (mp && mp.total) {
    let confidence = 0.5;
    if (mp.found.amount) confidence += 0.25;
    if (mp.found.party) confidence += 0.15;
    if (mp.issued_date) confidence += 0.05;
    return {
      vendor: mp.vendor,
      description: mp.description,
      total: mp.total,
      currency: detectCurrency(fullText),
      due_date: null,
      issued_date: mp.issued_date,
      category: mp.category,
      type: mp.type,
      confidence: Number(confidence.toFixed(2)),
      line_items: [],
    };
  }

  const total = findTotal(lines);
  const dueDate = findDueDate(lines, year);
  const issuedDate = findIssuedDate(lines, year);
  const vendor = findVendor(lines, fullText);
  const currency = detectCurrency(fullText);

  const categoryText = [vendor?.hint, vendor?.name, lines.slice(0, 15).join(' ')].filter(Boolean).join(' ');
  const category = (vendor?.hint && matchCategory(vendor.hint, categories)) || matchCategory(categoryText, categories);

  let type = TRANSACTION_TYPES.VARIABLE_EXPENSE;
  if (category?.type === TRANSACTION_TYPES.FIXED_EXPENSE || vendor?.fixed || dueDate) type = TRANSACTION_TYPES.FIXED_EXPENSE;
  if (category?.type === TRANSACTION_TYPES.INVESTMENT) type = TRANSACTION_TYPES.INVESTMENT;

  // Confianza: cuanto de lo importante se encontro por regla explicita.
  let confidence = 0.2;
  if (total?.weight >= 4) confidence += 0.4;
  else if (total?.weight >= 2) confidence += 0.3;
  else if (total) confidence += 0.1;
  if (vendor && !vendor.guessed) confidence += 0.15;
  if (category) confidence += 0.1;
  if (dueDate || issuedDate) confidence += 0.1;

  return {
    vendor: vendor?.name || null,
    description: vendor?.name ? `Factura ${vendor.name}` : null,
    total: total ? total.text : null,
    currency,
    due_date: dueDate,
    issued_date: issuedDate,
    category: category?.name || null,
    type,
    confidence: Math.min(0.95, Number(confidence.toFixed(2))),
    line_items: [],
  };
}
