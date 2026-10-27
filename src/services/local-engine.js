/**
 * Motor local para macOS: reemplaza a Gemini sin mandar nada a la nube.
 *
 * - Imagenes y PDF: binario `finanzas-ocr` (Swift + Vision/PDFKit), compilado
 *   por `npm run setup:mac` a partir de bin/macos/finanzas-ocr.swift.
 * - Audios: ffmpeg (convierte el .ogg de Telegram a WAV 16 kHz) + whisper.cpp
 *   (`whisper-cli` de Homebrew) con un modelo ggml en models/.
 *
 * Los procesos corren solo mientras se procesa un archivo: no hay nada
 * residente en memoria. Whisper "small" usa ~500 MB de RAM durante unos
 * segundos por audio.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const HOMEBREW_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

const EXTENSION_BY_MIME = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/webm': 'webm',
  'video/ogg': 'ogg',
  'video/mp4': 'mp4',
});

/** execFile como promesa, con stdout/stderr y codigo de salida. */
function defaultRunner(file, args, { timeout }) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (error.code ?? 1) : 0,
        killed: Boolean(error?.killed),
        stdout: String(stdout || ''),
        stderr: String(stderr || error?.message || ''),
      });
    });
  });
}

function isExecutable(file, fsImpl) {
  try {
    fsImpl.accessSync(file, fs.constants.X_OK);
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Busca un ejecutable en PATH + carpetas de Homebrew (launchd no las incluye). */
export function findExecutable(names, { explicit = null, envPath = process.env.PATH, fsImpl = fs } = {}) {
  if (explicit) return isExecutable(explicit, fsImpl) ? explicit : null;
  const dirs = [...String(envPath || '').split(path.delimiter).filter(Boolean), ...HOMEBREW_DIRS];
  for (const name of names) {
    for (const dir of [...new Set(dirs)]) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate, fsImpl)) return candidate;
    }
  }
  return null;
}

function tail(text, max = 400) {
  const clean = String(text || '').trim();
  return clean.length > max ? `…${clean.slice(-max)}` : clean;
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {object} [options.logger]
 * @param {Function} [options.runner] (file, args, {timeout}) => Promise<{ok, code, stdout, stderr}>
 * @param {string} [options.platform]
 * @param {object} [options.fsImpl]
 */
export function createLocalEngine({
  config,
  logger,
  runner = defaultRunner,
  platform = process.platform,
  fsImpl = fs,
  envPath = process.env.PATH,
} = {}) {
  const settings = config?.ai?.local || {};
  const timeout = Number(settings.timeoutMs) || 120000;
  const languages = Array.isArray(settings.ocrLanguages) && settings.ocrLanguages.length
    ? settings.ocrLanguages
    : ['es-ES', 'en-US'];
  const problems = [];

  const isMac = platform === 'darwin';
  if (!isMac) problems.push('el motor local solo funciona en macOS');

  const ocrBin = isMac && settings.ocrBin && isExecutable(settings.ocrBin, fsImpl) ? settings.ocrBin : null;
  if (isMac && !ocrBin) problems.push(`falta el binario de OCR (${settings.ocrBin || 'bin/macos/finanzas-ocr'}): correr npm run setup:mac`);

  const whisperBin = isMac
    ? findExecutable(['whisper-cli', 'whisper-cpp'], { explicit: settings.whisperBin, envPath, fsImpl })
    : null;
  if (isMac && !whisperBin) problems.push('falta whisper.cpp: brew install whisper-cpp');

  const ffmpegBin = isMac ? findExecutable(['ffmpeg'], { explicit: settings.ffmpegBin, envPath, fsImpl }) : null;
  if (isMac && !ffmpegBin) problems.push('falta ffmpeg: brew install ffmpeg');

  let whisperModel = null;
  try {
    if (settings.whisperModel && fsImpl.statSync(settings.whisperModel).isFile()) whisperModel = settings.whisperModel;
  } catch {
    // se informa abajo
  }
  if (isMac && !whisperModel) problems.push(`falta el modelo de whisper (${settings.whisperModel || 'models/ggml-small.bin'}): correr npm run setup:mac`);

  const documentsEnabled = Boolean(ocrBin);
  const audioEnabled = Boolean(whisperBin && ffmpegBin && whisperModel);

  if (problems.length) logger?.warn?.('motor local incompleto', { problems });

  /** Escribe el buffer en una carpeta temporal y la borra al terminar. */
  async function withTempFile(buffer, extension, fn) {
    const dir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'finanzas-'));
    const input = path.join(dir, `entrada.${extension}`);
    try {
      fsImpl.writeFileSync(input, buffer);
      return await fn(input, dir);
    } finally {
      try {
        fsImpl.rmSync(dir, { recursive: true, force: true });
      } catch {
        // limpieza best-effort
      }
    }
  }

  /**
   * Texto de una imagen o PDF con Vision.
   * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
   */
  async function recognizeText({ buffer, mime }) {
    if (!documentsEnabled) return { ok: false, error: 'ocr-local-no-disponible' };
    const extension = EXTENSION_BY_MIME[mime] || 'jpg';
    const started = Date.now();
    return withTempFile(buffer, extension, async (input) => {
      const result = await runner(ocrBin, [input, '--langs', languages.join(',')], { timeout });
      if (!result.ok) {
        logger?.warn?.('ocr local: fallo Vision', {
          code: result.code,
          killed: result.killed,
          stderr: tail(result.stderr),
        });
        return { ok: false, error: result.killed ? 'ocr-local-timeout' : 'ocr-local-fallo' };
      }
      const text = result.stdout.replace(/\r/g, '').trim();
      logger?.debug?.('ocr local: texto reconocido', { chars: text.length, ms: Date.now() - started });
      if (!text) return { ok: false, error: 'ocr-sin-texto' };
      return { ok: true, text };
    });
  }

  /**
   * Transcripcion en espanol con whisper.cpp.
   * @returns {Promise<{ok: true, text: string} | {ok: false, error: string}>}
   */
  async function transcribe({ buffer, mime }) {
    if (!audioEnabled) return { ok: false, error: 'voz-local-no-disponible' };
    const extension = EXTENSION_BY_MIME[mime] || 'ogg';
    const started = Date.now();
    return withTempFile(buffer, extension, async (input, dir) => {
      const wav = path.join(dir, 'audio.wav');
      const converted = await runner(ffmpegBin, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
      ], { timeout });
      if (!converted.ok) {
        logger?.warn?.('voz local: fallo ffmpeg', { code: converted.code, stderr: tail(converted.stderr) });
        return { ok: false, error: 'audio-no-convertible' };
      }
      const result = await runner(whisperBin, [
        '-m', whisperModel,
        '-f', wav,
        '-l', 'es',
        '-t', String(settings.whisperThreads || 4),
        '-nt',
        '-np',
      ], { timeout });
      if (!result.ok) {
        logger?.warn?.('voz local: fallo whisper', {
          code: result.code,
          killed: result.killed,
          stderr: tail(result.stderr),
        });
        return { ok: false, error: result.killed ? 'transcripcion-timeout' : 'transcripcion-fallida' };
      }
      const text = result.stdout
        .replace(/\[[^\]]*\]/g, ' ') // marcas como [BLANK_AUDIO] o [Música]
        .replace(/\s+/g, ' ')
        .trim();
      logger?.debug?.('voz local: transcripcion lista', { chars: text.length, ms: Date.now() - started });
      if (!text) return { ok: false, error: 'transcripcion-vacia' };
      return { ok: true, text };
    });
  }

  return {
    documentsEnabled,
    audioEnabled,
    problems,
    binaries: { ocrBin, whisperBin, ffmpegBin, whisperModel },
    recognizeText,
    transcribe,
  };
}
