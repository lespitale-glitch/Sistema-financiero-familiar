/**
 * Cliente REST minimo para Gemini (v1beta) sin dependencias externas.
 *
 * Objetivo: centralizar las llamadas a `generateContent` y devolver siempre
 * un resultado predecible (`{ ok, ... }`) en lugar de lanzar excepciones por
 * errores esperables de la API (HTTP, bloqueos, JSON invalido, timeouts).
 */

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_TEXT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 60000;
const RAW_TEXT_LIMIT = 1000;
const BLOCKED_FINISH_REASONS = new Set(['SAFETY', 'RECITATION']);

/** Recorta un texto para logs o mensajes de debug. */
function truncate(value, limit = RAW_TEXT_LIMIT) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Quita los cercos de markdown que a veces agrega el modelo:
 * ```json ... ``` o ``` ... ```. Devuelve el contenido limpio.
 */
function stripCodeFence(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';

  const fenced = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fenced) return fenced[1].trim();

  const embedded = /```(?:json|[a-zA-Z0-9_-]*)?\s*([\s\S]*?)```/i.exec(text);
  if (embedded) return embedded[1].trim();

  return text;
}

/** Intenta leer el cuerpo JSON de una respuesta sin lanzar. */
async function readJsonBody(response) {
  if (!response || typeof response.json !== 'function') return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Extrae el mensaje de error que devuelve la API, si existe. */
async function readErrorDetail(response) {
  if (!response) return null;
  try {
    if (typeof response.text === 'function') {
      const raw = await response.text();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          return parsed?.error?.message || parsed?.error?.status || truncate(raw, 300);
        } catch {
          return truncate(raw, 300);
        }
      }
    }
    const parsed = await readJsonBody(response);
    return parsed?.error?.message || parsed?.error?.status || null;
  } catch {
    return null;
  }
}

/**
 * Crea un cliente de Gemini.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey] Clave de API. Vacia deshabilita el cliente.
 * @param {string} [options.baseUrl]
 * @param {string} [options.textModel]
 * @param {string} [options.visionModel]
 * @param {string} [options.audioModel]
 * @param {Function} [options.fetchImpl] Inyectable para tests.
 * @param {object} [options.logger] Logger con debug/warn.
 * @param {number} [options.timeoutMs]
 */
export function createGeminiClient({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  textModel = DEFAULT_TEXT_MODEL,
  visionModel = textModel,
  audioModel = textModel,
  fetchImpl = globalThis.fetch,
  logger,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const enabled = key.length > 0;
  const resolvedTextModel = textModel || DEFAULT_TEXT_MODEL;
  const resolvedVisionModel = visionModel || resolvedTextModel;
  const resolvedAudioModel = audioModel || resolvedTextModel;
  const endpointBase = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  /** Resultado uniforme para fallos antes de tener texto. */
  function failure(error, model, { status = undefined, usage = null, text = '', data = null } = {}) {
    return { ok: false, data, text, error, usage, model, ...(status === undefined ? {} : { status }) };
  }

  /**
   * Ejecuta una llamada a `generateContent`.
   * No lanza por errores de red/API: siempre devuelve un objeto resultado.
   */
  async function call({ prompt, parts = [], model, temperature, maxOutputTokens, json = false, schema = null }) {
    const resolvedModel = model || resolvedTextModel;

    if (!enabled) return failure('gemini-deshabilitado', resolvedModel);

    const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
    if (typeof fetchFn !== 'function') return failure('fetch-no-disponible', resolvedModel);

    const generationConfig = { temperature, maxOutputTokens };
    if (json) {
      generationConfig.responseMimeType = 'application/json';
      if (schema) generationConfig.responseSchema = schema;
    }

    const body = {
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt ?? '' }, ...(Array.isArray(parts) ? parts : [])],
        },
      ],
      generationConfig,
    };

    const url = `${endpointBase}/models/${resolvedModel}:generateContent?key=${encodeURIComponent(key)}`;
    const init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      init.signal = AbortSignal.timeout(requestTimeout);
    }

    logger?.debug?.('gemini: enviando solicitud', { model: resolvedModel, json, timeoutMs: requestTimeout });

    let response;
    try {
      response = await fetchFn(url, init);
    } catch (error) {
      const aborted = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      logger?.warn?.('gemini: fallo la llamada', {
        model: resolvedModel,
        reason: aborted ? 'timeout' : error?.message || String(error),
      });
      return failure(aborted ? 'timeout' : 'error-de-red', resolvedModel);
    }

    const status = Number.isFinite(Number(response?.status)) ? Number(response.status) : undefined;
    const isOk = response?.ok === true
      || (response?.ok === undefined && status !== undefined && status >= 200 && status < 300);
    if (!isOk) {
      const detail = await readErrorDetail(response);
      logger?.warn?.('gemini: respuesta HTTP no exitosa', { model: resolvedModel, status, detail });
      return failure(detail || `http-${status ?? 'desconocido'}`, resolvedModel, {
        status,
      });
    }

    const payload = await readJsonBody(response);
    if (!payload || typeof payload !== 'object') {
      logger?.warn?.('gemini: respuesta sin cuerpo JSON', { model: resolvedModel, status });
      return failure('respuesta-invalida', resolvedModel, { status });
    }

    const usage = payload.usageMetadata || null;
    const blockReason = payload.promptFeedback?.blockReason;
    if (blockReason) {
      logger?.warn?.('gemini: solicitud bloqueada', { model: resolvedModel, blockReason });
      return failure('respuesta-bloqueada', resolvedModel, { status, usage });
    }

    const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
    if (candidates.length === 0) {
      return failure('sin-candidatos', resolvedModel, { status, usage });
    }

    const candidate = candidates[0] || {};
    const finishReason = candidate.finishReason || null;
    if (BLOCKED_FINISH_REASONS.has(finishReason)) {
      logger?.warn?.('gemini: respuesta bloqueada', { model: resolvedModel, finishReason });
      return failure('respuesta-bloqueada', resolvedModel, { status, usage });
    }

    const rawParts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    const text = rawParts
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .filter((part) => part.length > 0)
      .join('\n');

    logger?.debug?.('gemini: respuesta recibida', {
      model: resolvedModel,
      status,
      finishReason,
      tokens: usage?.totalTokenCount ?? null,
    });

    return { ok: true, data: null, text, error: null, usage, model: resolvedModel, status };
  }

  /**
   * Pide al modelo un JSON estructurado.
   * @returns {Promise<{ok:boolean, data:object|null, text:string, error:string|null, usage:object|null, model:string, status?:number}>}
   */
  async function generateJson({
    prompt,
    parts = [],
    schema = null,
    model = resolvedTextModel,
    temperature = 0.1,
    maxOutputTokens = 2048,
  } = {}) {
    const result = await call({
      prompt,
      parts,
      model,
      temperature,
      maxOutputTokens,
      json: true,
      schema,
    });

    if (!result.ok) {
      return {
        ok: false,
        data: null,
        text: result.text || '',
        error: result.error,
        usage: result.usage || null,
        model: result.model,
        ...(result.status === undefined ? {} : { status: result.status }),
      };
    }

    const rawText = result.text || '';
    const cleaned = stripCodeFence(rawText);
    if (!cleaned) {
      logger?.warn?.('gemini: respuesta JSON vacia', { model: result.model });
      return {
        ok: false,
        data: null,
        text: '',
        error: 'json-invalido',
        usage: result.usage || null,
        model: result.model,
        ...(result.status === undefined ? {} : { status: result.status }),
      };
    }

    let data;
    try {
      data = JSON.parse(cleaned);
    } catch {
      logger?.warn?.('gemini: JSON invalido', { model: result.model, chars: rawText.length });
      return {
        ok: false,
        data: null,
        text: truncate(rawText, RAW_TEXT_LIMIT),
        error: 'json-invalido',
        usage: result.usage || null,
        model: result.model,
        ...(result.status === undefined ? {} : { status: result.status }),
      };
    }

    if (data === null || typeof data !== 'object') {
      logger?.warn?.('gemini: JSON con formato inesperado', { model: result.model });
      return {
        ok: false,
        data: null,
        text: truncate(rawText, RAW_TEXT_LIMIT),
        error: 'json-invalido',
        usage: result.usage || null,
        model: result.model,
        ...(result.status === undefined ? {} : { status: result.status }),
      };
    }

    return {
      ok: true,
      data,
      text: rawText,
      error: null,
      usage: result.usage || null,
      model: result.model,
      ...(result.status === undefined ? {} : { status: result.status }),
    };
  }

  /**
   * Pide al modelo texto libre.
   * @returns {Promise<{ok:boolean, text:string, error:string|null, usage:object|null, model:string, status?:number}>}
   */
  async function generateText({
    prompt,
    parts = [],
    model = resolvedTextModel,
    temperature = 0.2,
    maxOutputTokens = 1024,
  } = {}) {
    const result = await call({
      prompt,
      parts,
      model,
      temperature,
      maxOutputTokens,
      json: false,
    });

    return {
      ok: result.ok,
      text: result.text || '',
      error: result.ok ? null : result.error,
      usage: result.usage || null,
      model: result.model,
      ...(result.status === undefined ? {} : { status: result.status }),
    };
  }

  return {
    enabled,
    textModel: resolvedTextModel,
    visionModel: resolvedVisionModel,
    audioModel: resolvedAudioModel,
    generateJson,
    generateText,
  };
}
