/**
 * Motor local (macOS): reglas de facturas sobre texto, invocacion de Vision y
 * whisper.cpp (con un runner falso) e integracion con el servicio de OCR.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractInvoiceFields, findAmounts, findDates } from '../src/services/invoice-text.js';
import { createLocalEngine, findExecutable } from '../src/services/local-engine.js';
import { createOcrService } from '../src/services/ocr.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_CATEGORIES } from '../src/domain.js';

const CATEGORIES = DEFAULT_CATEGORIES.map((category) => ({ ...category, id: category.name }));
const NOW = new Date('2026-10-28T12:00:00Z');

const EDESUR = `EDESUR S.A.
CUIT 30-71079642-7
Factura B  0012-00345678
Fecha de emisión: 28/10/2026
Nro. de cliente 12345678
Subtotal  $ 38.000,00
IVA 21%  $ 7.320,50
TOTAL A PAGAR  $ 45.320,50
1er Vencimiento 10/11/2026  $ 45.320,50
2do Vencimiento 20/11/2026  $ 46.100,00
Próximo vencimiento 10/12/2026`;

const TICKET = `SUPERMERCADOS COTO CICSA
CUIT 30-54808315-6
Fecha 25/10/2026 18:32
LECHE 1L  1.250,00
SUBTOTAL  3.350,00
DESCUENTO  -350,00
TOTAL
$ 3.000,00
EFECTIVO  5.000,00
VUELTO 2.000,00`;

test('findDates y findAmounts entienden formatos argentinos', () => {
  assert.deepEqual(findDates('Vence el 05 de noviembre de 2026', { defaultYear: 2026 }), ['2026-11-05']);
  assert.deepEqual(findDates('1er Vto 10/11/26', { defaultYear: 2026 }), ['2026-11-10']);
  assert.deepEqual(findAmounts('TOTAL A PAGAR $ 45.320,50').map((a) => a.cents), [4_532_050]);
  // Fechas, CUIT y numeros de cliente no son montos.
  assert.deepEqual(findAmounts('Vto 10/11/2026 CUIT 30-71079642-7 cliente 12345678'), []);
});

test('factura de servicio: total a pagar, primer vencimiento, emisor y categoria', () => {
  const raw = extractInvoiceFields(EDESUR, { categories: CATEGORIES, now: NOW });
  assert.equal(raw.vendor, 'Edesur');
  assert.equal(raw.total, '45.320,50');
  assert.equal(raw.due_date, '2026-11-10'); // primer vencimiento, no el proximo
  assert.equal(raw.issued_date, '2026-10-28');
  assert.equal(raw.category, 'Servicios');
  assert.equal(raw.type, 'fixed_expense');
  assert.ok(raw.confidence >= 0.8);
});

test('ticket de super: TOTAL con el monto en la linea siguiente, ignora subtotal y vuelto', () => {
  const raw = extractInvoiceFields(TICKET, { categories: CATEGORIES, now: NOW });
  assert.equal(raw.vendor, 'Coto');
  assert.equal(raw.total, '3.000,00');
  assert.equal(raw.due_date, null);
  assert.equal(raw.category, 'Supermercado');
  assert.equal(raw.type, 'variable_expense');
});

test('comprobante en dolares y texto sin total explicito', () => {
  const usd = extractInvoiceFields('Netflix\nRecibo\nTotal US$ 15,49\nFecha 01/11/2026', { categories: CATEGORIES, now: NOW });
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.total, '15,49');
  assert.equal(usd.category, 'Entretenimiento');

  const weak = extractInvoiceFields('Kiosco Pepe\nAlfajor $ 900,00\nGaseosa $ 1.800,00', { categories: CATEGORIES, now: NOW });
  assert.equal(weak.total, '1.800,00');
  assert.ok(weak.confidence < 0.5);
});

/** Carpeta con ejecutables y modelo falsos para simular una Mac preparada. */
function fakeMacInstall(t, { withWhisper = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'finanzas-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const executable = (name) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o755);
    return file;
  };
  const ocrBin = executable('finanzas-ocr');
  if (withWhisper) executable('whisper-cli');
  executable('ffmpeg');
  const model = path.join(dir, 'ggml-small.bin');
  fs.writeFileSync(model, 'modelo');
  const config = loadConfig({
    AI_PROVIDER: 'local',
    LOCAL_OCR_BIN: ocrBin,
    LOCAL_WHISPER_MODEL: model,
    CURRENCY: 'ARS',
    TZ: 'America/Argentina/Buenos_Aires',
  }, { loadEnvFile: false });
  return { dir, config, ocrBin };
}

test('findExecutable busca en PATH y respeta la ruta explicita', (t) => {
  const { dir, ocrBin } = fakeMacInstall(t);
  assert.equal(findExecutable(['whisper-cli', 'whisper-cpp'], { envPath: dir }), path.join(dir, 'whisper-cli'));
  assert.equal(findExecutable(['ffmpeg'], { explicit: ocrBin }), ocrBin);
  assert.equal(findExecutable(['no-existe'], { envPath: dir }), null);
});

test('motor local: fuera de macOS queda deshabilitado con el motivo', () => {
  const engine = createLocalEngine({ config: loadConfig({ AI_PROVIDER: 'local' }, { loadEnvFile: false }), platform: 'win32' });
  assert.equal(engine.documentsEnabled, false);
  assert.equal(engine.audioEnabled, false);
  assert.match(engine.problems.join(' '), /solo funciona en macOS/);
});

test('motor local: OCR llama a Vision y transcribe con ffmpeg + whisper', async (t) => {
  const { dir, config, ocrBin } = fakeMacInstall(t);
  const calls = [];
  const runner = async (file, args) => {
    calls.push({ file: path.basename(file), args });
    if (file === ocrBin) return { ok: true, code: 0, stdout: `${EDESUR}\n`, stderr: '' };
    if (file.endsWith('ffmpeg')) return { ok: true, code: 0, stdout: '', stderr: '' };
    return { ok: true, code: 0, stdout: ' Gasté 15.000 en el super [BLANK_AUDIO]\n', stderr: '' };
  };
  const engine = createLocalEngine({ config, runner, platform: 'darwin', envPath: dir });
  assert.equal(engine.documentsEnabled, true);
  assert.equal(engine.audioEnabled, true);
  assert.deepEqual(engine.problems, []);

  const ocr = await engine.recognizeText({ buffer: Buffer.from('jpg'), mime: 'image/jpeg' });
  assert.equal(ocr.ok, true);
  assert.match(ocr.text, /TOTAL A PAGAR/);
  assert.deepEqual(calls[0].args.slice(1), ['--langs', 'es-ES,en-US']);
  assert.match(calls[0].args[0], /entrada\.jpg$/);

  const audio = await engine.transcribe({ buffer: Buffer.from('ogg'), mime: 'audio/ogg' });
  assert.deepEqual(audio, { ok: true, text: 'Gasté 15.000 en el super' });
  assert.equal(calls[1].file, 'ffmpeg');
  assert.ok(calls[1].args.includes('16000'));
  assert.equal(calls[2].file, 'whisper-cli');
  assert.deepEqual(calls[2].args.slice(4, 6), ['-l', 'es']);

  // Los archivos temporales se borran.
  assert.equal(fs.existsSync(path.dirname(calls[0].args[0])), false);
});

test('motor local: errores de los binarios se informan sin lanzar', async (t) => {
  const { dir, config } = fakeMacInstall(t);
  const runner = async () => ({ ok: false, code: 4, killed: false, stdout: '', stderr: 'Error de Vision' });
  const engine = createLocalEngine({ config, runner, platform: 'darwin', envPath: dir });
  assert.deepEqual(await engine.recognizeText({ buffer: Buffer.from('x'), mime: 'image/png' }), { ok: false, error: 'ocr-local-fallo' });
  assert.deepEqual(await engine.transcribe({ buffer: Buffer.from('x'), mime: 'audio/ogg' }), { ok: false, error: 'audio-no-convertible' });
});

test('motor local sin whisper: lee facturas pero la voz queda apagada', (t) => {
  const { dir, config } = fakeMacInstall(t, { withWhisper: false });
  const engine = createLocalEngine({ config, platform: 'darwin', envPath: dir });
  assert.equal(engine.documentsEnabled, true);
  assert.equal(engine.audioEnabled, false);
  assert.match(engine.problems.join(' '), /brew install whisper-cpp/);
});

test('OCR con AI_PROVIDER=local devuelve el mismo contrato que Gemini', async () => {
  const config = loadConfig({ AI_PROVIDER: 'local', CURRENCY: 'ARS', TZ: 'America/Argentina/Buenos_Aires' }, { loadEnvFile: false });
  const local = {
    documentsEnabled: true,
    audioEnabled: true,
    async recognizeText() {
      return { ok: true, text: EDESUR };
    },
    async transcribe() {
      return { ok: true, text: '  gasté   2000 en nafta ' };
    },
  };
  const ocr = createOcrService({ local, config, clock: () => NOW });
  assert.equal(ocr.provider, 'local');
  assert.equal(ocr.documentsEnabled, true);

  const extraction = await ocr.extractDocument({
    buffer: Buffer.from('foto'),
    mimeType: 'image/jpeg',
    categories: CATEGORIES,
  });
  assert.equal(extraction.ok, true);
  assert.equal(extraction.model, 'macos-vision');
  assert.equal(extraction.vendor, 'Edesur');
  assert.equal(extraction.amountCents, 4_532_050);
  assert.equal(extraction.dueDate, '2026-11-10');
  assert.equal(extraction.categoryName, 'Servicios');
  assert.match(extraction.rawText, /TOTAL A PAGAR/);

  const voice = await ocr.transcribeAudio({ buffer: Buffer.from('ogg'), mimeType: 'audio/ogg' });
  assert.deepEqual(voice, { ok: true, text: 'gasté 2000 en nafta', language: 'es', error: null, model: 'whisper.cpp' });
});

test('OCR local sin instalar responde con un error claro', async () => {
  const config = loadConfig({ AI_PROVIDER: 'local' }, { loadEnvFile: false });
  const ocr = createOcrService({ local: { documentsEnabled: false, audioEnabled: false }, config });
  assert.equal(ocr.enabled, false);
  const extraction = await ocr.extractDocument({ buffer: Buffer.from('x'), mimeType: 'image/png' });
  assert.equal(extraction.error, 'ocr-local-no-disponible');
  assert.match(extraction.warnings[0], /npm run setup:mac/);
});
