import crypto from 'node:crypto';
import { TYPE_META, TRANSACTION_SOURCES, TRANSACTION_TYPES } from '../domain.js';
import { documentKeyboard } from '../bot/keyboards.js';
import { formatCents, isPositiveCents } from '../utils/money.js';
import { formatDate } from '../utils/dates.js';
import { escapeHtml } from '../utils/telegram-html.js';
import { parseTransactionMessage } from './parser.js';
import { buildPendingDocumentMessage } from './reports.js';

const SUPPORTED_EXTENSIONS = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
});

/** Texto limpio o null. */
function textOrNull(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed ? trimmed : null;
}

/**
 * Extrae la direccion de un remitente.
 * Acepta "Nombre <mail@dominio>" o { address } / { text }.
 */
function extractAddress(value) {
  if (!value) return null;
  if (typeof value === 'object') {
    const candidate = value.address || value.text || value.value || '';
    return extractAddress(candidate);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const bracketed = /<([^<>@\s]+@[^<>\s]+)>/.exec(raw);
  const candidate = bracketed ? bracketed[1] : raw;
  return candidate.trim().toLowerCase() || null;
}

/** Normaliza una lista de destinatarios a texto plano. */
function normalizeRecipients(value) {
  if (!value) return null;
  if (Array.isArray(value)) {
    return value.map((item) => normalizeRecipients(item)).filter(Boolean).join(', ') || null;
  }
  if (typeof value === 'object') {
    return textOrNull(value.text || value.address || '');
  }
  return textOrNull(value);
}

const HTML_ENTITIES = Object.freeze({
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
});

/**
 * Conversion simple de HTML a texto. No pretende ser un parser completo:
 * alcanza para reenviar el cuerpo textual de un email.
 */
export function htmlToText(html) {
  if (!html) return '';
  let value = String(html);
  value = value.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  value = value.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  value = value.replace(/<br\s*\/?>/gi, '\n');
  value = value.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  value = value.replace(/<[^>]+>/g, ' ');
  value = value.replace(/&#(\d+);/g, (match, code) => {
    const parsed = Number(code);
    return Number.isFinite(parsed) && parsed > 0 && parsed < 0x10ffff
      ? String.fromCodePoint(parsed)
      : ' ';
  });
  for (const [entity, replacement] of Object.entries(HTML_ENTITIES)) {
    value = value.split(entity).join(replacement);
  }
  return value
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Decodifica base64 (acepta data URLs y variantes URL-safe). */
export function decodeAttachmentContent(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.length ? value : null;
  if (value instanceof Uint8Array) return value.length ? Buffer.from(value) : null;
  let raw = String(value).trim();
  if (!raw) return null;
  const dataUrl = /^data:[^;,]*;base64,([\s\S]*)$/i.exec(raw);
  if (dataUrl) raw = dataUrl[1];
  raw = raw.replace(/\s+/g, '');
  if (!raw || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) return null;
  raw = raw.replace(/-/g, '+').replace(/_/g, '/');
  if (raw.length % 4 === 1) return null;
  while (raw.length % 4 !== 0) raw += '=';
  const buffer = Buffer.from(raw, 'base64');
  return buffer.length ? buffer : null;
}

/** Mime base sin parametros. */
function baseMime(value) {
  return String(value || '').split(';')[0].trim().toLowerCase();
}

/** Mime inferido por extension del nombre. */
function mimeForAttachment(item, fileName) {
  const declared = baseMime(item.mimeType || item.contentType);
  if (declared) return declared === 'image/jpg' ? 'image/jpeg' : declared;
  const match = /\.([a-z0-9]+)$/i.exec(String(fileName || ''));
  return match ? SUPPORTED_EXTENSIONS[match[1].toLowerCase()] || '' : '';
}

function isSupportedAttachmentMime(mime) {
  return mime === 'application/pdf' || mime.startsWith('image/');
}

/** id determinista cuando el proveedor no envia Message-ID. */
function deriveMessageId({ from, subject, text, attachments }) {
  const names = (attachments || [])
    .map((item) => item.fileName || item.filename || '')
    .filter(Boolean)
    .join(',');
  const seed = [from || '', subject || '', text || '', names].join('|');
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
}

/**
 * Normaliza el payload que llega por API o por IMAP.
 */
function normalizePayload(payload = {}) {
  const from = extractAddress(payload.from);
  const subject = textOrNull(payload.subject) || '';
  const plainText = textOrNull(payload.text) || '';
  const htmlText = plainText ? '' : htmlToText(payload.html);
  const text = plainText || htmlText;
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments.filter((item) => item && typeof item === 'object')
    : [];
  const messageId = textOrNull(payload.messageId)
    || deriveMessageId({ from, subject, text, attachments });
  return {
    messageId,
    from,
    to: normalizeRecipients(payload.to),
    subject,
    text,
    html: textOrNull(payload.html),
    attachments,
  };
}

/**
 * Elige el primer adjunto soportado (imagen o PDF) dentro del limite.
 * @returns {{buffer: Buffer, mimeType: string, fileName: string, size: number}|null}
 */
function pickAttachment(attachments, maxUploadBytes, logger) {
  for (let index = 0; index < attachments.length; index += 1) {
    const item = attachments[index];
    const fileName = textOrNull(item.fileName || item.filename) || `adjunto-${index + 1}`;
    const mimeType = mimeForAttachment(item, fileName);
    if (!isSupportedAttachmentMime(mimeType)) continue;
    const buffer = decodeAttachmentContent(
      item.contentBase64 ?? item.content ?? item.data ?? item.base64,
    );
    if (!buffer) {
      logger?.warn?.('email: adjunto base64 invalido', { fileName });
      continue;
    }
    const declaredSize = Number(item.size);
    const size = Number.isFinite(declaredSize) && declaredSize > 0 ? declaredSize : buffer.length;
    if (size > maxUploadBytes || buffer.length > maxUploadBytes) {
      logger?.warn?.('email: adjunto supera el limite', { fileName, size, maxUploadBytes });
      continue;
    }
    return { buffer, mimeType, fileName, size: buffer.length };
  }
  return null;
}

/** Destino de notificacion: chat familiar o Telegram del autor. */
function notificationTarget(config, user) {
  return config.telegram?.familyChatId ? String(config.telegram.familyChatId) : (user?.telegramId || null);
}

/**
 * Servicio de ingesta de emails (facturas y movimientos escritos).
 *
 * Flujo: dedupe por Message-ID -> identificar remitente -> intentar OCR del
 * primer adjunto -> fallback a parseo de texto -> registrar movimiento.
 *
 * @param {{config: object, repos: object, services: object, logger?: object, notifier?: object, clock?: () => Date}} deps
 */
export function createEmailService({ config, repos, services, logger, notifier, clock = () => new Date() }) {
  const maxUploadBytes = Number(config?.gemini?.maxUploadBytes) || 10 * 1024 * 1024;
  const currency = config.app.currency;
  const locale = config.app.locale;
  const timezone = config.app.timezone;

  let pollTimer = null;
  let pollInFlight = false;
  let lastPollAt = null;
  let lastError = null;
  let processed = 0;

  async function markLog(record) {
    try {
      await repos.emailLog.mark(record);
    } catch (error) {
      logger?.error?.('email: no pude registrar el procesamiento', {
        messageId: record?.messageId,
        error,
      });
    }
  }

  async function notify(chatId, html, extra = {}) {
    if (!notifier?.sendMessage) return { ok: false, reason: 'notifier-unavailable' };
    try {
      return await notifier.sendMessage(chatId, html, extra);
    } catch (error) {
      logger?.warn?.('email: fallo la notificacion por Telegram', { error: error?.message || String(error) });
      return { ok: false, error: error?.message || String(error) };
    }
  }

  function buildTransactionMessage(transaction, category) {
    const meta = TYPE_META[transaction.type] || TYPE_META.variable_expense;
    const title = category?.name ? `${category.emoji || '🏷️'} ${category.name}` : 'Sin categoría';
    const lines = [
      '✅ <b>Movimiento registrado desde email</b>',
      '',
      `${meta.emoji} <b>${formatCents(transaction.amountCents, currency, locale)}</b> · ${escapeHtml(title)}`,
      `${escapeHtml(meta.label)} · ${formatDate(transaction.occurredAt, timezone)}`,
    ];
    if (transaction.note) lines.push(`📝 ${escapeHtml(transaction.note)}`);
    return lines.join('\n');
  }

  function buildUnparsedMessage(subject) {
    const lines = [
      '📭 <b>Email recibido sin monto</b>',
      '',
      'No pude detectar un monto en el mensaje.',
    ];
    if (subject) lines.push(`Asunto: ${escapeHtml(subject)}`);
    lines.push('', 'Registrá el movimiento desde el bot o reenviá el email con el monto en el texto.');
    return lines.join('\n');
  }

  /**
   * Procesa un email normalizado. Nunca lanza por validaciones esperadas.
   *
   * @param {object} payload
   * @param {{source?: string}} [options]
   * @returns {Promise<object>}
   */
  async function ingestEmail(payload = {}, { source = 'api' } = {}) {
    let normalized;
    try {
      normalized = normalizePayload(payload);
    } catch (error) {
      logger?.error?.('email: payload invalido', { error });
      return {
        ok: false,
        status: 'rejected',
        httpStatus: 400,
        message: 'El email no tiene un formato válido.',
      };
    }

    const { messageId, from, subject, text, attachments } = normalized;

    try {
      if (!from) {
        return {
          ok: false,
          status: 'rejected',
          httpStatus: 400,
          message: 'El email no tiene remitente.',
        };
      }
      if (await repos.emailLog.seen(messageId)) {
        return {
          ok: true,
          duplicate: true,
          status: 'duplicate',
          httpStatus: 200,
          message: 'El email ya fue procesado.',
        };
      }

      const user = await services.users.resolveEmailUser(from);
      if (!user) {
        await markLog({
          messageId,
          fromAddress: from,
          subject,
          status: 'rejected',
          error: 'remitente-no-registrado',
        });
        return {
          ok: false,
          status: 'rejected',
          httpStatus: 403,
          message: 'El remitente no está registrado en la familia.',
        };
      }

      const categories = await repos.categories.list();
      const attachment = pickAttachment(attachments, maxUploadBytes, logger);
      const attachmentName = attachment?.fileName || null;

      if (attachment && services.ocr?.enabled) {
        let extraction = null;
        try {
          extraction = await services.ocr.extractDocument({
            buffer: attachment.buffer,
            mimeType: attachment.mimeType,
            fileName: attachment.fileName,
            categories,
            currency,
          });
        } catch (error) {
          logger?.warn?.('email: el OCR fallo, sigo con el texto', {
            messageId,
            error: error?.message || String(error),
          });
        }

        if (extraction?.ok && isPositiveCents(extraction.amountCents)) {
          const category = extraction.categoryName
            ? await repos.categories.getByName(extraction.categoryName)
            : null;
          const document = await repos.documents.create({
            userId: user.id,
            fileName: attachment.fileName,
            mimeType: attachment.mimeType,
            vendor: extraction.vendor,
            totalCents: extraction.amountCents,
            currency,
            dueDate: extraction.dueDate,
            categoryId: category?.id || null,
            extracted: extraction,
            status: 'pending',
            source: 'email',
          });
          const target = notificationTarget(config, user);
          if (target) {
            const message = buildPendingDocumentMessage({
              document,
              extraction,
              category,
              currency,
              locale,
            });
            await notify(target, message, { reply_markup: documentKeyboard(document.id) });
          } else {
            logger?.warn?.('email: factura sin destino de notificacion', { documentId: document.id });
          }
          await markLog({
            messageId,
            fromAddress: from,
            subject,
            status: 'pending_confirmation',
            documentId: document.id,
          });
          return {
            ok: true,
            status: 'pending_confirmation',
            documentId: document.id,
            message: 'Factura recibida; confirmá en Telegram.',
          };
        }
        if (extraction) {
          logger?.warn?.('email: OCR sin monto utilizable, sigo con el texto', {
            messageId,
            ocrError: extraction.error || null,
          });
        }
      }

      const combined = [subject, text].filter(Boolean).join('\n').trim();
      let parsed = null;
      try {
        parsed = await parseTransactionMessage(combined, {
          categories,
          defaultType: TRANSACTION_TYPES.VARIABLE_EXPENSE,
          now: clock(),
          currency,
        });
      } catch (error) {
        logger?.warn?.('email: fallo el parseo de texto', {
          messageId,
          error: error?.message || String(error),
        });
      }

      if (parsed?.ok && isPositiveCents(parsed.amountCents)) {
        const result = await services.transactions.create({
          user,
          type: parsed.type,
          amountCents: parsed.amountCents,
          category: parsed.category ?? parsed.categoryName ?? null,
          note: parsed.note || subject || 'Movimiento por email',
          source: TRANSACTION_SOURCES.EMAIL,
          occurredAt: parsed.occurredAt || clock(),
          metadata: {
            email: { messageId, from, subject },
            attachment: attachmentName,
          },
          alertUserName: user.name,
        });
        const target = notificationTarget(config, user);
        if (target) {
          await notify(target, buildTransactionMessage(result.transaction, result.category));
        }
        await markLog({
          messageId,
          fromAddress: from,
          subject,
          status: 'logged',
          transactionId: result.transaction.id,
        });
        return {
          ok: true,
          status: 'logged',
          transactionId: result.transaction.id,
          message: 'Movimiento registrado desde email.',
        };
      }

      const target = notificationTarget(config, user);
      if (target) await notify(target, buildUnparsedMessage(subject));
      await markLog({
        messageId,
        fromAddress: from,
        subject,
        status: 'unparsed',
        error: 'sin-monto',
      });
      return {
        ok: false,
        status: 'unparsed',
        httpStatus: 422,
        message: 'No pude detectar un monto en el email. Enviá el gasto como texto o desde el bot.',
      };
    } catch (error) {
      logger?.error?.('email: error inesperado procesando el email', {
        messageId,
        source,
        error,
      });
      await markLog({
        messageId,
        fromAddress: from,
        subject,
        status: 'error',
        error: error?.message ? String(error.message).slice(0, 300) : 'error-desconocido',
      });
      return {
        ok: false,
        status: 'error',
        httpStatus: 500,
        message: 'No pude procesar el email. Revisá los logs del servidor.',
      };
    }
  }

  /**
   * Una pasada de IMAP: toma los no leidos, los convierte a payload y los
   * ingresa. Nunca lanza; los errores quedan en `lastError`.
   */
  async function pollOnce() {
    if (pollInFlight) return;
    pollInFlight = true;
    const imap = config.email?.imap || {};
    let client = null;
    try {
      const { ImapFlow } = await import('imapflow');
      const { simpleParser } = await import('mailparser');
      client = new ImapFlow({
        host: imap.host,
        port: imap.port,
        secure: imap.secure,
        auth: { user: imap.user, pass: imap.password },
        logger: false,
      });
      await client.connect();
      const lock = await client.getMailboxLock(imap.mailbox || 'INBOX');
      try {
        const uids = await client.search({ seen: false }, { uid: true });
        const pending = (Array.isArray(uids) ? uids : []).slice(0, 20);
        for (const uid of pending) {
          const message = await client.fetchOne(uid, { envelope: true, source: true }, { uid: true });
          if (!message?.source) continue;
          const parsed = await simpleParser(message.source);
          const result = await ingestEmail({
            messageId: parsed.messageId || null,
            from: parsed.from?.text || '',
            to: normalizeRecipients(parsed.to),
            subject: parsed.subject || '',
            text: parsed.text || '',
            html: parsed.html || null,
            attachments: (parsed.attachments || [])
              .filter((item) => isSupportedAttachmentMime(baseMime(item.contentType)))
              .map((item) => ({
                filename: item.filename,
                contentType: item.contentType,
                size: item.size,
                contentBase64: item.content ? Buffer.from(item.content).toString('base64') : null,
              })),
          }, { source: 'imap' });
          processed += 1;
          logger?.info?.('email: procesado por IMAP', {
            messageId: parsed.messageId || null,
            status: result?.status || 'desconocido',
          });
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        }
      } finally {
        lock.release();
      }
    } catch (error) {
      lastError = error?.message || String(error);
      logger?.warn?.('email: fallo el poll de IMAP', { error: lastError });
    } finally {
      pollInFlight = false;
      const now = clock();
      lastPollAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
      if (client) {
        try {
          await client.logout();
        } catch {
          try {
            client.close();
          } catch {
            // el cliente ya estaba cerrado
          }
        }
      }
    }
  }

  /**
   * Inicia el poller de IMAP (opt-in). Devuelve false si esta deshabilitado
   * o si faltan las dependencias opcionales.
   */
  async function startImapPoller() {
    if (!config.email?.imap?.enabled) {
      logger?.info?.('email: IMAP deshabilitado por configuracion');
      return false;
    }
    if (pollTimer) return true;
    try {
      await import('imapflow');
      await import('mailparser');
    } catch (error) {
      logger?.warn?.('email: faltan dependencias de IMAP', { error: error?.message || String(error) });
      return false;
    }
    const seconds = Math.max(30, Number(config.email.imap.pollSeconds) || 300);
    pollTimer = setInterval(() => {
      void pollOnce();
    }, seconds * 1000);
    pollTimer.unref?.();
    void pollOnce();
    return true;
  }

  /** Detiene el poller de IMAP. */
  function stopImapPoller() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /**
   * Estado observable del servicio (util para /healthz y tests).
   */
  function status() {
    return {
      enabled: Boolean(config.email?.imap?.enabled),
      running: Boolean(pollTimer),
      lastPollAt,
      lastError,
      processed,
    };
  }

  return {
    ingestEmail,
    startImapPoller,
    stopImapPoller,
    status,
  };
}
