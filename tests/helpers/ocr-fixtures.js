/**
 * Fixtures compartidos por los tests de OCR/Gemini.
 * Sin dependencias externas: solo objetos planos y Buffers.
 */

import { TRANSACTION_TYPES } from '../../src/domain.js';

/** Instante fijo para que las fechas sean deterministas (12:00 en Buenos Aires). */
export const FIXED_NOW = new Date('2026-10-24T15:00:00.000Z');

export function fixedClock() {
  return new Date(FIXED_NOW);
}

/** Configuracion minima con la forma real de src/config.js. */
export function makeConfig({ maxUploadBytes = 5 * 1024 * 1024 } = {}) {
  return {
    app: {
      currency: 'ARS',
      timezone: 'America/Argentina/Buenos_Aires',
      locale: 'es-AR',
    },
    gemini: {
      maxUploadBytes,
      visionModel: 'gemini-test',
      audioModel: 'gemini-audio',
    },
  };
}

/** Categorias de ejemplo, con acentos y distintos tipos. */
export function makeCategories() {
  return [
    {
      name: 'Servicios',
      type: TRANSACTION_TYPES.FIXED_EXPENSE,
      keywords: ['luz', 'gas', 'agua', 'internet', 'edenor', 'edesur', 'metrogas', 'aysa', 'cable', 'wifi'],
    },
    {
      name: 'Educación',
      type: TRANSACTION_TYPES.FIXED_EXPENSE,
      keywords: ['colegio', 'escuela', 'cuota', 'utiles'],
    },
    {
      name: 'Supermercado',
      type: TRANSACTION_TYPES.VARIABLE_EXPENSE,
      keywords: ['super', 'mercado', 'coto'],
    },
    {
      name: 'Inversiones',
      type: TRANSACTION_TYPES.INVESTMENT,
      keywords: ['plazo fijo', 'fci', 'acciones'],
    },
  ];
}

/** Respuesta realista de Gemini con un unico candidato de texto. */
export function geminiPayload(text, {
  usage = { promptTokenCount: 12, candidatesTokenCount: 34, totalTokenCount: 46 },
  finishReason = 'STOP',
} = {}) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }],
        },
        finishReason,
      },
    ],
    usageMetadata: usage,
  };
}

/** Respuesta tipo fetch con `json()` y `text()`. */
export function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/**
 * Stub de fetch que registra URL y body de cada llamada.
 * `handler` puede ser una respuesta fija o una funcion (call, index) => respuesta.
 */
export function createFetchStub(handler) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const call = {
      url: String(url),
      init,
      body: init.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    return typeof handler === 'function' ? handler(call, calls.length - 1) : handler;
  }
  return { fetchImpl, calls };
}

/** Documento extraido por defecto para los tests de OCR. */
export function extraction(overrides = {}) {
  return {
    vendor: 'Edenor',
    description: 'Factura de luz',
    total: '15.000,50',
    currency: 'ARS',
    due_date: '2026-11-15',
    issued_date: '2026-10-01',
    category: 'Servicios',
    type: null,
    confidence: 0.92,
    line_items: [
      { description: 'Consumo de energia', amount: '12.000,00' },
      { description: 'Impuestos y tasas', amount: '3.000,50' },
    ],
    ...overrides,
  };
}

export function imageBuffer() {
  return Buffer.from('fake-jpeg-image-bytes');
}

export function pdfBuffer() {
  return Buffer.from('%PDF-1.4 contenido de prueba');
}

export function audioBuffer() {
  return Buffer.from('fake-ogg-audio-bytes');
}
