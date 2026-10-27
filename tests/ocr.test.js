import test from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiClient } from '../src/services/gemini.js';
import { createOcrService } from '../src/services/ocr.js';
import {
  audioBuffer,
  createFetchStub,
  extraction,
  fixedClock,
  geminiPayload,
  imageBuffer,
  jsonResponse,
  makeCategories,
  makeConfig,
  pdfBuffer,
} from './helpers/ocr-fixtures.js';

/** Cliente Gemini con un stub de fetch que devuelve un texto fijo. */
function makeClient(modelText, {
  usage,
  finishReason = 'STOP',
  apiKey = 'test-key',
  fetchImpl = null,
} = {}) {
  const stub = fetchImpl ? { fetchImpl, calls: [] } : createFetchStub(jsonResponse(geminiPayload(modelText, { usage, finishReason })));
  const client = createGeminiClient({
    apiKey,
    fetchImpl: stub.fetchImpl,
    timeoutMs: 1000,
  });
  return { client, stub };
}

/** Servicio OCR con un stub que devuelve `modelText` como respuesta del modelo. */
function makeOcr(modelText, { config = makeConfig(), usage, finishReason = 'STOP' } = {}) {
  const stub = createFetchStub(jsonResponse(geminiPayload(modelText, { usage, finishReason })));
  const gemini = createGeminiClient({
    apiKey: 'test-key',
    fetchImpl: stub.fetchImpl,
    timeoutMs: 1000,
  });
  const ocr = createOcrService({ gemini, config, clock: fixedClock });
  return { ocr, gemini, stub };
}

test('gemini deshabilitado no llama a fetch y responde ok:false', async () => {
  let fetchCount = 0;
  const client = createGeminiClient({
    apiKey: '',
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse(geminiPayload('{}'));
    },
  });

  assert.equal(client.enabled, false);

  const json = await client.generateJson({ prompt: 'extrae algo' });
  assert.equal(json.ok, false);
  assert.equal(json.error, 'gemini-deshabilitado');
  assert.equal(json.data, null);

  const text = await client.generateText({ prompt: 'hola' });
  assert.equal(text.ok, false);
  assert.equal(text.error, 'gemini-deshabilitado');

  const ocr = createOcrService({ gemini: client, config: makeConfig(), clock: fixedClock });
  const document = await ocr.extractDocument({ buffer: imageBuffer(), mimeType: 'image/jpeg' });
  assert.equal(document.ok, false);
  assert.equal(document.error, 'gemini-deshabilitado');

  assert.equal(fetchCount, 0);
});

test('generateJson parsea JSON con cercos markdown y devuelve usage', async () => {
  const usage = { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 };
  const { client, stub } = makeClient('```json\n{"vendor":"Edenor","total":"1500.50"}\n```', { usage });

  const result = await client.generateJson({ prompt: 'extrae' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { vendor: 'Edenor', total: '1500.50' });
  assert.deepEqual(result.usage, usage);
  assert.equal(result.error, null);
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(stub.calls.length, 1);
});

test('generateJson devuelve json-invalido e incluye el texto crudo', async () => {
  const { client } = makeClient('esto no es JSON');

  const result = await client.generateJson({ prompt: 'extrae' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'json-invalido');
  assert.equal(result.data, null);
  assert.match(result.text, /esto no es JSON/);
});

test('HTTP 500 devuelve ok:false con status y mensaje del cuerpo', async () => {
  const stub = createFetchStub(jsonResponse({ error: { message: 'fallo interno del modelo' } }, { status: 500 }));
  const client = createGeminiClient({
    apiKey: 'test-key',
    fetchImpl: stub.fetchImpl,
    timeoutMs: 1000,
  });

  const result = await client.generateText({ prompt: 'hola' });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /fallo interno del modelo/);
});

test('extractDocument extrae una imagen y normaliza monto, tipo y items', async () => {
  const payload = extraction();
  const { ocr, stub } = makeOcr(JSON.stringify(payload));

  const result = await ocr.extractDocument({
    buffer: imageBuffer(),
    mimeType: 'image/jpeg',
    fileName: 'factura-luz.jpg',
    categories: makeCategories(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.vendor, 'Edenor');
  assert.equal(result.description, 'Factura de luz');
  assert.equal(result.amountCents, 1500050);
  assert.equal(result.currency, 'ARS');
  assert.equal(result.dueDate, '2026-11-15');
  assert.equal(result.issuedDate, '2026-10-01');
  assert.equal(result.categoryName, 'Servicios');
  // type era null, se infiere del tipo de la categoria.
  assert.equal(result.type, 'fixed_expense');
  assert.equal(result.confidence, 0.92);
  assert.equal(result.lineItems.length, 2);
  assert.deepEqual(result.lineItems[0], { description: 'Consumo de energia', amountCents: 1200000 });
  assert.deepEqual(result.lineItems[1], { description: 'Impuestos y tasas', amountCents: 300050 });
  assert.deepEqual(result.warnings, []);
  assert.equal(result.model, 'gemini-test');
  assert.equal(result.fileName, 'factura-luz.jpg');
  assert.equal(result.rawText, JSON.stringify(payload));

  assert.equal(stub.calls.length, 1);
  const { url, body } = stub.calls[0];
  assert.match(url, /\/models\/gemini-test:generateContent\?key=test-key$/);
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[0].parts.length, 2);
  assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(body.contents[0].parts[1].inline_data.data, imageBuffer().toString('base64'));
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema.required, [
    'vendor',
    'total',
    'currency',
    'due_date',
    'category',
    'type',
    'confidence',
  ]);
  assert.match(body.contents[0].parts[0].text, /Servicios/);
});

test('extractDocument acepta PDF e infiere el mime desde el nombre', async () => {
  const payload = extraction({
    total: '25000,00',
    due_date: '15/11/2026',
    category: 'EDUCACIÓN',
    type: null,
    confidence: 0.8,
  });
  const { ocr, stub } = makeOcr(JSON.stringify(payload));

  const result = await ocr.extractDocument({
    buffer: pdfBuffer(),
    fileName: 'cuota-colegio.pdf',
    categories: makeCategories(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.categoryName, 'Educación');
  assert.equal(result.type, 'fixed_expense');
  assert.equal(result.amountCents, 2500000);
  assert.equal(result.dueDate, '2026-11-15');
  assert.equal(result.fileName, 'cuota-colegio.pdf');
  assert.equal(stub.calls[0].body.contents[0].parts[1].inline_data.mime_type, 'application/pdf');
});

test('extractDocument acepta un total numerico', async () => {
  const { ocr } = makeOcr(JSON.stringify(extraction({ total: 1234.56 })));

  const result = await ocr.extractDocument({
    buffer: imageBuffer(),
    mimeType: 'image/png',
    categories: makeCategories(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.amountCents, 123456);
});

test('extractDocument acepta un total con coma decimal', async () => {
  const { ocr } = makeOcr(JSON.stringify(extraction({ total: '1234,56' })));

  const result = await ocr.extractDocument({
    buffer: imageBuffer(),
    mimeType: 'image/png',
    categories: makeCategories(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.amountCents, 123456);
});

test('extractDocument marca monto invalido y moneda distinta como advertencias', async () => {
  const { ocr } = makeOcr(JSON.stringify(extraction({ total: 'sin monto', currency: 'USD' })));

  const result = await ocr.extractDocument({
    buffer: imageBuffer(),
    mimeType: 'image/png',
    categories: makeCategories(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.amountCents, null);
  assert.equal(result.currency, 'USD');
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.some((warning) => /monto/i.test(warning)));
  assert.ok(result.warnings.some((warning) => /moneda/i.test(warning)));
});

test('extractDocument rechaza mime no soportado sin llamar a la red', async () => {
  const { ocr, stub } = makeOcr(JSON.stringify(extraction()));

  const result = await ocr.extractDocument({
    buffer: Buffer.from('texto plano'),
    mimeType: 'text/plain',
    fileName: 'nota.txt',
    categories: makeCategories(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'tipo-no-soportado');
  assert.equal(stub.calls.length, 0);
});

test('extractDocument rechaza archivos demasiado grandes sin llamar a la red', async () => {
  const { ocr, stub } = makeOcr(JSON.stringify(extraction()), {
    config: makeConfig({ maxUploadBytes: 1000 }),
  });

  const result = await ocr.extractDocument({
    buffer: Buffer.alloc(1001, 1),
    mimeType: 'image/png',
    categories: makeCategories(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'archivo-demasiado-grande');
  assert.equal(stub.calls.length, 0);
});

test('transcribeAudio normaliza el texto y usa el modelo de audio', async () => {
  const { ocr, stub } = makeOcr('  Gaste   15.000 en\nel supermercado #comida  ');

  const result = await ocr.transcribeAudio({
    buffer: audioBuffer(),
    mimeType: 'audio/ogg',
    fileName: 'nota.ogg',
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Gaste 15.000 en el supermercado #comida');
  assert.equal(result.language, 'es');
  assert.equal(result.model, 'gemini-audio');

  const { url, body } = stub.calls[0];
  assert.match(url, /\/models\/gemini-audio:generateContent\?key=test-key$/);
  assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'audio/ogg');
  assert.equal(body.contents[0].parts[1].inline_data.data, audioBuffer().toString('base64'));
  assert.match(body.contents[0].parts[0].text, /Transcribe/);
});

test('transcribeAudio devuelve transcripcion-vacia si el modelo no devuelve texto', async () => {
  const { ocr } = makeOcr('   \n  ');

  const result = await ocr.transcribeAudio({
    buffer: audioBuffer(),
    mimeType: 'audio/ogg',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'transcripcion-vacia');
  assert.equal(result.text, '');
});

test('transcribeAudio rechaza un mime no soportado sin llamar a la red', async () => {
  const { ocr, stub } = makeOcr('texto');

  const result = await ocr.transcribeAudio({
    buffer: audioBuffer(),
    mimeType: 'text/plain',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'tipo-no-soportado');
  assert.equal(stub.calls.length, 0);
});

test('generateJson envia modelo, esquema y partes inline correctas', async () => {
  const schema = {
    type: 'object',
    properties: { total: { type: 'string' } },
    required: ['total'],
  };
  const { client, stub } = makeClient('{"total":"100"}');
  const buffer = Buffer.from('bytes-de-prueba');

  const result = await client.generateJson({
    prompt: 'EXTRAE EL TOTAL',
    parts: [{ inline_data: { mime_type: 'image/png', data: buffer.toString('base64') } }],
    schema,
    model: 'gemini-vision-custom',
    temperature: 0.3,
    maxOutputTokens: 1234,
  });

  assert.equal(result.ok, true);

  const { url, body } = stub.calls[0];
  assert.match(url, /\/models\/gemini-vision-custom:generateContent\?key=test-key$/);
  assert.equal(body.contents[0].role, 'user');
  assert.equal(body.contents[0].parts[0].text, 'EXTRAE EL TOTAL');
  assert.deepEqual(body.contents[0].parts[1], {
    inline_data: { mime_type: 'image/png', data: buffer.toString('base64') },
  });
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.deepEqual(body.generationConfig.responseSchema, schema);
  assert.equal(body.generationConfig.temperature, 0.3);
  assert.equal(body.generationConfig.maxOutputTokens, 1234);

  // generateText no debe pedir JSON.
  await client.generateText({ prompt: 'Hola' });
  assert.equal(stub.calls[1].body.generationConfig.responseMimeType, undefined);
});

test('generateJson codifica la apiKey en la URL', async () => {
  const { client, stub } = makeClient('{}', { apiKey: 'clave de prueba+1' });

  await client.generateJson({ prompt: 'x' });

  assert.match(stub.calls[0].url, /key=clave%20de%20prueba%2B1$/);
});

test('un JSON vacio se informa como json-invalido', async () => {
  const { client } = makeClient('   ');

  const result = await client.generateJson({ prompt: 'x' });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'json-invalido');
});
