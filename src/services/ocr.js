/**
 * Servicio de OCR y transcripcion de audio sobre Gemini.
 *
 * Recibe archivos (Buffer), valida formato/tamano, arma el prompt en espanol,
 * llama al cliente de Gemini y normaliza la respuesta a un contrato estable
 * que el bot y la API pueden consumir sin conocer detalles del modelo.
 */

import { parseAmountToCents, toCents } from '../utils/money.js';
import { localParts, pad2, parseHumanDate } from '../utils/dates.js';
import { TRANSACTION_TYPES, TYPE_LIST } from '../domain.js';
import { extractInvoiceFields } from './invoice-text.js';

const LOCAL_OCR_MODEL = 'macos-vision';
const LOCAL_AUDIO_MODEL = 'whisper.cpp';

const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_LINE_ITEMS = 30;
const MAX_RAW_TEXT = 2000;
const MAX_TRANSCRIPTION = 2000;

const DOCUMENT_TYPES = Object.freeze([
  TRANSACTION_TYPES.FIXED_EXPENSE,
  TRANSACTION_TYPES.VARIABLE_EXPENSE,
  TRANSACTION_TYPES.INVESTMENT,
]);

const DOCUMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

const AUDIO_MIME_TYPES = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/wav',
  'audio/webm',
  'video/ogg',
  'video/mp4',
]);

const DOCUMENT_EXTENSION_MIME = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
});

const AUDIO_EXTENSION_MIME = Object.freeze({
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  mp3: 'audio/mpeg',
  m4a: 'audio/m4a',
  wav: 'audio/wav',
  webm: 'audio/webm',
});

/** Esquema que se envia a Gemini para la extraccion de comprobantes. */
const EXTRACTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    vendor: { type: 'string', nullable: true },
    description: { type: 'string', nullable: true },
    total: { type: 'string', nullable: true },
    currency: { type: 'string', nullable: true },
    due_date: { type: 'string', nullable: true },
    issued_date: { type: 'string', nullable: true },
    category: { type: 'string', nullable: true },
    type: { type: 'string', nullable: true, enum: [...TYPE_LIST] },
    confidence: { type: 'number' },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { type: 'string' },
        },
        required: ['description'],
      },
    },
  },
  required: ['vendor', 'total', 'currency', 'due_date', 'category', 'type', 'confidence'],
});

/** Convierte Buffer/Uint8Array/ArrayBuffer a Buffer sin lanzar. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

/** Mime base en minusculas, sin parametros como `; charset=...`. */
function baseMime(mimeType) {
  return String(mimeType || '').split(';')[0].trim().toLowerCase();
}

/** Extension en minusculas de un nombre de archivo. */
function extensionOf(fileName) {
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || '').trim());
  return match ? match[1].toLowerCase() : '';
}

/** Resuelve y valida el mime de un documento (infiere por extension si falta). */
function resolveDocumentMime(mimeType, fileName) {
  let mime = baseMime(mimeType);
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    const inferred = DOCUMENT_EXTENSION_MIME[extensionOf(fileName)];
    if (inferred) mime = inferred;
  }
  if (mime === 'image/jpg') mime = 'image/jpeg';
  return DOCUMENT_MIME_TYPES.has(mime) ? mime : null;
}

/** Resuelve y valida el mime de un audio (infiere por extension si falta). */
function resolveAudioMime(mimeType, fileName) {
  let mime = baseMime(mimeType);
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    const inferred = AUDIO_EXTENSION_MIME[extensionOf(fileName)];
    if (inferred) mime = inferred;
  }
  return AUDIO_MIME_TYPES.has(mime) ? mime : null;
}

/** Limite de carga configurado, con fallback seguro. */
function maxUploadBytes(config) {
  const configured = Number(config?.gemini?.maxUploadBytes);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MAX_UPLOAD_BYTES;
}

/** Normaliza un nombre para comparar sin mayusculas ni acentos. */
function normalizeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
}

/** Texto limpio o null. */
function stringOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** Indica si el valor tiene contenido utilizable. */
function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * Arma el contexto de categorias para el prompt.
 * Solo envia nombre, tipo y las primeras 8 palabras clave.
 */
function buildCategoryContext(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .slice(0, 80)
    .map((category) => {
      if (typeof category === 'string') {
        const name = category.trim();
        return name ? { name, type: null, keywords: [] } : null;
      }
      const name = typeof category?.name === 'string' ? category.name.trim() : '';
      if (!name) return null;
      const keywords = Array.isArray(category.keywords)
        ? category.keywords.filter((keyword) => typeof keyword === 'string' && keyword.trim()).slice(0, 8)
        : [];
      return {
        name,
        type: typeof category.type === 'string' ? category.type : null,
        keywords,
      };
    })
    .filter(Boolean);
}

/** Prompt de extraccion de comprobantes. */
function buildDocumentPrompt({ categories, currency }) {
  const context = buildCategoryContext(categories);
  return [
    'Sos un asistente experto en leer facturas, comprobantes y recibos de una familia.',
    'Analiza el archivo adjunto y extrae los datos del comprobante.',
    '',
    'Reglas obligatorias:',
    '- El total debe ser el monto final a pagar e incluir impuestos, tasas y descuentos.',
    '- Copia los montos tal como estan impresos: respeta el punto o la coma decimal y no los conviertas.',
    '- Si el documento indica una moneda distinta, informala en formato ISO 4217 (3 letras).',
    '- Si un dato no aparece en el documento, usa null. Nunca inventes valores.',
    '- La categoria debe coincidir exactamente con uno de los nombres de la lista; si ninguno aplica de forma razonable, usa null.',
    `- El tipo debe ser uno de: ${DOCUMENT_TYPES.join(', ')}.`,
    '- La descripcion debe ser breve (maximo 80 caracteres).',
    '- confidence debe ser un numero entre 0 y 1 segun tu certeza.',
    '- Responde unicamente con el objeto JSON del esquema, sin explicaciones ni texto adicional.',
    '',
    `Moneda configurada: ${currency}.`,
    `Categorias disponibles (nombre, tipo y palabras clave): ${JSON.stringify(context)}`,
  ].join('\n');
}

/** Prompt de transcripcion de audio. */
const AUDIO_PROMPT = [
  'Transcribe literalmente el audio adjunto en espanol.',
  'Conserva los montos, nombres, categorias y hashtags tal como se dicen.',
  'No agregues comillas, comentarios, marcas de tiempo ni explicaciones.',
  'Devuelve unicamente el texto de la transcripcion.',
].join('\n');

/** Busca una categoria por nombre exacto (sin distinguir mayusculas/acentos). */
function findCategory(rawName, categories) {
  if (typeof rawName !== 'string' || !rawName.trim() || !Array.isArray(categories)) return null;
  const target = normalizeName(rawName);
  for (const category of categories) {
    const name = typeof category === 'string' ? category : category?.name;
    if (typeof name !== 'string' || !name.trim()) continue;
    if (normalizeName(name) === target) {
      return typeof category === 'string' ? { name: category, type: null } : category;
    }
  }
  return null;
}

/** Ajusta un numero a un rango [min, max]. */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Crea el servicio de OCR/transcripcion.
 *
 * @param {object} [options]
 * @param {object} [options.gemini] Cliente creado con createGeminiClient.
 * @param {object} [options.config] Configuracion de la app.
 * @param {object} [options.logger] Logger con debug/warn.
 * @param {() => Date} [options.clock] Reloj inyectable para tests.
 */
export function createOcrService({ gemini, local = null, config, logger, clock = () => new Date() } = {}) {
  const provider = config?.ai?.provider === 'local' ? 'local' : 'gemini';
  const documentsEnabled = provider === 'local' ? Boolean(local?.documentsEnabled) : Boolean(gemini?.enabled);
  const audioEnabled = provider === 'local' ? Boolean(local?.audioEnabled) : Boolean(gemini?.enabled);
  const enabled = documentsEnabled || audioEnabled;
  const configuredCurrency = String(config?.app?.currency || 'ARS').toUpperCase();
  const timezone = config?.app?.timezone || 'UTC';

  /**
   * Extrae los datos de una factura, comprobante, recibo o PDF.
   *
   * @param {object} input
   * @param {Buffer|Uint8Array} input.buffer
   * @param {string} [input.mimeType]
   * @param {string} [input.fileName]
   * @param {Array<{name:string,type?:string,keywords?:string[]}>} [input.categories]
   * @param {string} [input.currency]
   * @returns {Promise<object>}
   */
  async function extractDocument({
    buffer,
    mimeType = null,
    fileName = null,
    categories = [],
    currency: inputCurrency = config?.app?.currency || 'ARS',
  } = {}) {
    const visionModel = provider === 'local'
      ? LOCAL_OCR_MODEL
      : config?.gemini?.visionModel || gemini?.visionModel || null;
    const bytes = toBuffer(buffer);
    if (!bytes || bytes.length === 0) {
      return {
        ok: false,
        error: 'archivo-vacio',
        warnings: ['El archivo esta vacio o no es valido.'],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    const mime = resolveDocumentMime(mimeType, fileName);
    if (!mime) {
      return {
        ok: false,
        error: 'tipo-no-soportado',
        warnings: ['Formato no soportado. Envia JPG, PNG, WEBP, HEIC o PDF.'],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    const limit = maxUploadBytes(config);
    if (bytes.length > limit) {
      return {
        ok: false,
        error: 'archivo-demasiado-grande',
        warnings: [`El archivo supera el limite permitido (${limit} bytes).`],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    const documentCurrency = String(inputCurrency || configuredCurrency).trim().toUpperCase() || configuredCurrency;

    if (provider === 'local') {
      return extractWithLocal({ bytes, mime, fileName, categories, documentCurrency });
    }

    if (!documentsEnabled) {
      return {
        ok: false,
        error: 'gemini-deshabilitado',
        warnings: ['El OCR no esta configurado.'],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    if (typeof gemini.generateJson !== 'function') {
      return {
        ok: false,
        error: 'gemini-deshabilitado',
        warnings: ['El OCR no esta configurado.'],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    const prompt = buildDocumentPrompt({ categories, currency: documentCurrency });

    let result;
    try {
      result = await gemini.generateJson({
        prompt,
        parts: [{ inline_data: { mime_type: mime, data: bytes.toString('base64') } }],
        schema: EXTRACTION_SCHEMA,
        model: visionModel || undefined,
        temperature: 0.1,
        maxOutputTokens: 2048,
      });
    } catch (error) {
      logger?.warn?.('ocr: fallo inesperado en la extraccion', {
        error: error?.message || String(error),
        fileName,
      });
      return {
        ok: false,
        error: 'extraccion-fallida',
        warnings: ['No se pudo interpretar el comprobante automaticamente.'],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    if (!result?.ok) {
      logger?.warn?.('ocr: gemini no devolvio datos', {
        error: result?.error || 'extraccion-fallida',
        fileName,
      });
      return {
        ok: false,
        error: result?.error || 'extraccion-fallida',
        warnings: ['No se pudo interpretar el comprobante automaticamente.'],
        model: visionModel,
        fileName: fileName || null,
      };
    }

    const raw = result.data && typeof result.data === 'object' && !Array.isArray(result.data) ? result.data : {};
    return normalizeExtraction(raw, {
      categories,
      documentCurrency,
      model: visionModel,
      fileName,
      rawText: typeof result.text === 'string' ? result.text : '',
    });
  }

  /** OCR con Vision (macOS) + reglas de invoice-text.js. */
  async function extractWithLocal({ bytes, mime, fileName, categories, documentCurrency }) {
    const failure = (error, warning) => ({
      ok: false,
      error,
      warnings: [warning],
      model: LOCAL_OCR_MODEL,
      fileName: fileName || null,
    });
    if (!local?.documentsEnabled) {
      return failure('ocr-local-no-disponible', 'El OCR local no esta instalado. Corre npm run setup:mac en la Mac.');
    }
    let recognized;
    try {
      recognized = await local.recognizeText({ buffer: bytes, mime, fileName });
    } catch (error) {
      logger?.warn?.('ocr local: fallo inesperado', { error: error?.message || String(error), fileName });
      return failure('extraccion-fallida', 'No se pudo leer el comprobante.');
    }
    if (!recognized?.ok) {
      return failure(recognized?.error || 'extraccion-fallida', 'No se pudo leer texto en el comprobante. Proba con una foto mas nitida.');
    }
    const now = typeof clock === 'function' ? clock() : new Date();
    const raw = extractInvoiceFields(recognized.text, {
      categories,
      now,
      defaultYear: localParts(now, timezone).year,
    });
    logger?.debug?.('ocr local: datos extraidos', {
      vendor: raw.vendor,
      hasTotal: Boolean(raw.total),
      dueDate: raw.due_date,
      confidence: raw.confidence,
    });
    return normalizeExtraction(raw, {
      categories,
      documentCurrency,
      model: LOCAL_OCR_MODEL,
      fileName,
      rawText: recognized.text,
    });
  }

  /** Normaliza el "raw" (de Gemini o de las reglas locales) al contrato del bot. */
  function normalizeExtraction(raw, { categories, documentCurrency, model, fileName, rawText }) {
    const visionModel = model;

    // Monto total: string tal como se imprime, o numero como fallback.
    const rawTotal = raw.total;
    let amountCents = parseAmountToCents(rawTotal);
    if ((amountCents === null || !Number.isSafeInteger(amountCents)) && typeof rawTotal === 'number') {
      amountCents = toCents(rawTotal);
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) amountCents = null;

    // Moneda: ISO 4217 del documento o la configurada.
    const rawCurrency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : '';
    const extractedCurrency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : null;
    const currency = extractedCurrency || documentCurrency;

    // Fechas: se usa el ano local actual para formatos sin ano.
    const now = typeof clock === 'function' ? clock() : new Date();
    const local = localParts(now, timezone);
    const dueDate = parseHumanDate(raw.due_date, { defaultYear: local.year, timeZone: timezone });
    const issuedDate = parseHumanDate(raw.issued_date, { defaultYear: local.year, timeZone: timezone });

    // Categoria: coincidencia exacta sin distinguir mayusculas ni acentos.
    const matchedCategory = findCategory(raw.category, categories);
    const categoryName = typeof matchedCategory?.name === 'string' ? matchedCategory.name.trim() : null;

    // Tipo: solo gastos fijos/variables o inversion para documentos.
    const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
    const categoryType = typeof matchedCategory?.type === 'string' ? matchedCategory.type.trim().toLowerCase() : '';
    let type = DOCUMENT_TYPES.includes(rawType) ? rawType : null;
    if (!type && DOCUMENT_TYPES.includes(categoryType)) type = categoryType;
    if (!type) type = TRANSACTION_TYPES.VARIABLE_EXPENSE;

    // Items de detalle (maximo 30, sin descripciones vacias).
    const lineItems = Array.isArray(raw.line_items)
      ? raw.line_items
        .slice(0, MAX_LINE_ITEMS)
        .map((item) => {
          const description = typeof item?.description === 'string' ? item.description.trim() : '';
          if (!description) return null;
          return { description, amountCents: parseAmountToCents(item?.amount) };
        })
        .filter(Boolean)
      : [];

    // Confianza acotada a 0..1.
    const numericConfidence = typeof raw.confidence === 'number'
      ? raw.confidence
      : Number.parseFloat(String(raw.confidence ?? '').replace(',', '.'));
    const confidence = Number.isFinite(numericConfidence) ? clamp(numericConfidence, 0, 1) : 0.5;

    // Advertencias para que el usuario revise antes de confirmar.
    const warnings = [];
    if (amountCents === null) {
      warnings.push('No se pudo interpretar el monto total del comprobante.');
    }
    if (hasValue(raw.due_date) && !dueDate) {
      warnings.push('No se pudo interpretar la fecha de vencimiento.');
    }
    if (dueDate) {
      const todayKey = `${local.year}-${pad2(local.month)}-${pad2(local.day)}`;
      if (dueDate < todayKey) warnings.push('La fecha de vencimiento ya paso.');
    }
    if (confidence < 0.5) {
      warnings.push('La confianza de la extraccion es baja; conviene revisar los datos.');
    }
    if (extractedCurrency && extractedCurrency !== documentCurrency) {
      warnings.push(`La moneda del comprobante (${extractedCurrency}) no coincide con la moneda configurada (${documentCurrency}).`);
    }

    return {
      ok: true,
      vendor: stringOrNull(raw.vendor),
      description: stringOrNull(raw.description),
      amountCents,
      currency,
      dueDate,
      issuedDate,
      categoryName,
      type,
      confidence,
      lineItems,
      rawText: String(rawText || '').slice(0, MAX_RAW_TEXT),
      warnings,
      model: visionModel,
      fileName: fileName || null,
    };
  }

  /**
   * Transcribe un audio (o video corto) a texto plano.
   *
   * @param {object} input
   * @param {Buffer|Uint8Array} input.buffer
   * @param {string} [input.mimeType]
   * @param {string} [input.fileName]
   * @returns {Promise<{ok:boolean, text:string, language:string, error:string|null, model:string}>}
   */
  async function transcribeAudio({ buffer, mimeType = null, fileName = null, onQueued = null } = {}) {
    const audioModel = provider === 'local'
      ? LOCAL_AUDIO_MODEL
      : config?.gemini?.audioModel || gemini?.audioModel || null;
    const bytes = toBuffer(buffer);
    if (!bytes || bytes.length === 0) {
      return { ok: false, text: '', language: 'es', error: 'archivo-vacio', model: audioModel };
    }

    const mime = resolveAudioMime(mimeType, fileName);
    if (!mime) {
      return { ok: false, text: '', language: 'es', error: 'tipo-no-soportado', model: audioModel };
    }

    const limit = maxUploadBytes(config);
    if (bytes.length > limit) {
      return { ok: false, text: '', language: 'es', error: 'archivo-demasiado-grande', model: audioModel };
    }

    if (provider === 'local') {
      if (!local?.audioEnabled) {
        return { ok: false, text: '', language: 'es', error: 'voz-local-no-disponible', model: audioModel };
      }
      let localResult;
      try {
        localResult = await local.transcribe({ buffer: bytes, mime, fileName, onQueued });
      } catch (error) {
        logger?.warn?.('voz local: fallo inesperado', { error: error?.message || String(error), fileName });
        return { ok: false, text: '', language: 'es', error: 'transcripcion-fallida', model: audioModel };
      }
      if (!localResult?.ok) {
        return { ok: false, text: '', language: 'es', error: localResult?.error || 'transcripcion-fallida', model: audioModel };
      }
      const localText = String(localResult.text).replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSCRIPTION).trim();
      if (!localText) return { ok: false, text: '', language: 'es', error: 'transcripcion-vacia', model: audioModel };
      return { ok: true, text: localText, language: 'es', error: null, model: audioModel };
    }

    if (!audioEnabled || typeof gemini?.generateText !== 'function') {
      return { ok: false, text: '', language: 'es', error: 'gemini-deshabilitado', model: audioModel };
    }

    let result;
    try {
      result = await gemini.generateText({
        prompt: AUDIO_PROMPT,
        parts: [{ inline_data: { mime_type: mime, data: bytes.toString('base64') } }],
        model: audioModel || undefined,
      });
    } catch (error) {
      logger?.warn?.('ocr: fallo inesperado en la transcripcion', {
        error: error?.message || String(error),
        fileName,
      });
      return { ok: false, text: '', language: 'es', error: 'transcripcion-fallida', model: audioModel };
    }

    if (!result?.ok) {
      return {
        ok: false,
        text: '',
        language: 'es',
        error: result?.error || 'transcripcion-fallida',
        model: audioModel,
      };
    }

    const text = String(result.text ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_TRANSCRIPTION)
      .trim();

    if (!text) {
      return { ok: false, text: '', language: 'es', error: 'transcripcion-vacia', model: audioModel };
    }

    return { ok: true, text, language: 'es', error: null, model: audioModel };
  }

  /** ¿Whisper esta ocupado por otro programa? Solo aplica al motor local. */
  async function audioBusy() {
    if (provider !== 'local' || typeof local?.whisperBusy !== 'function') return { busy: false, processes: [] };
    try {
      return await local.whisperBusy();
    } catch (error) {
      logger?.warn?.('voz local: no pude revisar si whisper esta ocupado', { error: error?.message || String(error) });
      return { busy: true, processes: [] };
    }
  }

  return {
    provider,
    audioBusy,
    enabled,
    documentsEnabled,
    audioEnabled,
    extractDocument,
    transcribeAudio,
  };
}
