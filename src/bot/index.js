/**
 * Punto de entrada del bot de Telegram.
 *
 * `createBot` arma la instancia de Telegraf, registra la autenticacion de la
 * familia y conecta comandos, texto libre, voz, documentos y callbacks.
 * Si no hay token configurado devuelve null (la app sigue sin bot).
 */

import { Telegraf } from 'telegraf';
import { COMMANDS, registerCommands } from './commands.js';
import {
  handleCallbackQuery,
  handleDocument,
  handleText,
  handleVoice,
} from './handlers.js';

const HTML_OPTS = Object.freeze({ parse_mode: 'HTML', disable_web_page_preview: true });

/**
 * Middleware de identidad. Resuelve `ctx.from` contra FAMILY_MEMBERS y deja el
 * usuario en `ctx.state.user`. Si no esta autorizado responde (en HTML) y no
 * llama a next(); nunca lanza.
 *
 * @param {object} deps
 * @returns {(ctx: object, next: Function) => Promise<unknown>}
 */
/** Tipo de mensaje recibido, para el log. */
function describeUpdate(ctx) {
  const message = ctx?.message || ctx?.editedMessage || null;
  if (ctx?.callbackQuery) return { kind: 'boton' };
  if (!message) return { kind: ctx?.updateType || 'otro' };
  if (typeof message.text === 'string') {
    const command = /^\/([a-z_]+)/i.exec(message.text);
    return command ? { kind: 'comando', command: command[1].toLowerCase() } : { kind: 'texto' };
  }
  if (message.photo) return { kind: 'foto' };
  if (message.voice || message.audio) return { kind: 'audio' };
  if (message.document) return { kind: 'archivo', mime: message.document.mime_type || null };
  return { kind: ctx?.updateType || 'otro' };
}

/**
 * Deja una linea en el log por cada update de Telegram (tipo, chat, usuario,
 * duracion). No guarda el texto del mensaje.
 */
export function createUpdateLogger(logger) {
  return async function updateLogger(ctx, next) {
    const started = Date.now();
    const info = {
      ...describeUpdate(ctx),
      chatType: ctx?.chat?.type || null,
      chatId: ctx?.chat?.id ?? null,
      fromId: ctx?.from?.id ?? null,
    };
    logger?.info?.('telegram: recibido', info);
    try {
      return await next();
    } finally {
      logger?.debug?.('telegram: procesado', { ...info, ms: Date.now() - started });
    }
  };
}

export function createAuthMiddleware(deps) {
  return async function authMiddleware(ctx, next) {
    if (!ctx?.from?.id) return next();
    let resolved;
    try {
      resolved = await deps.services.users.resolveTelegramUser({
        telegramId: ctx.from.id,
        firstName: ctx.from.first_name,
        username: ctx.from.username,
        chatId: ctx.chat?.id,
      });
    } catch (error) {
      deps.logger?.error?.('fallo la resolucion del usuario de Telegram', { error });
      resolved = {
        ok: false,
        reason: 'resolve-error',
        message: '❌ No pude verificar tu usuario. Probá de nuevo en unos segundos.',
      };
    }

    ctx.state = ctx.state || {};
    ctx.state.resolved = resolved;

    if (!resolved?.ok) {
      deps.logger?.warn?.('telegram: usuario no autorizado', {
        reason: resolved?.reason || null,
        fromId: ctx.from.id,
        chatId: ctx.chat?.id ?? null,
      });
      ctx.state.user = undefined;
      // En grupos no se contesta a cada mensaje de alguien no autorizado (seria
      // molesto en el chat familiar): queda en el log con su ID. Solo se
      // responde si uso un comando, para que sepa por que no anda.
      const isGroup = ['group', 'supergroup'].includes(ctx.chat?.type);
      const isCommand = /^\//.test(String(ctx.message?.text || ''));
      if (isGroup && !isCommand) return undefined;
      try {
        if (typeof ctx.reply === 'function') {
          await ctx.reply(
            resolved?.message || '🚫 No tengo permiso para operar con este usuario.',
            HTML_OPTS,
          );
        }
      } catch (error) {
        deps.logger?.warn?.('no se pudo responder al usuario no autorizado', { error: error?.message });
      }
      return undefined;
    }

    ctx.state.user = resolved.user;
    return next();
  };
}

/**
 * Conecta los handlers de mensajes y callbacks. Los comandos se registran
 * primero para que el handler de texto libre no los consuma.
 *
 * @param {import('telegraf').Telegraf} bot
 * @param {object} deps
 */
export function registerHandlers(bot, deps) {
  registerCommands(bot, deps);

  bot.on('text', (ctx) => handleText(ctx, deps));
  bot.on('voice', (ctx) => handleVoice(ctx, deps));
  bot.on('audio', (ctx) => handleVoice(ctx, deps));
  bot.on('photo', (ctx) => handleDocument(ctx, deps));
  bot.on('document', (ctx) => handleDocument(ctx, deps));
  bot.on('callback_query', (ctx) => handleCallbackQuery(ctx, deps));

  return bot;
}

/**
 * Publica la lista de comandos en el menu de Telegram. Best-effort.
 * @param {import('telegraf').Telegraf} bot
 * @param {object} [logger]
 */
export async function setBotCommands(bot, logger) {
  try {
    await bot.telegram.setMyCommands(COMMANDS.map(({ command, description }) => ({ command, description })));
    return true;
  } catch (error) {
    logger?.warn?.('no se pudieron publicar los comandos del bot', { error: error?.message });
    return false;
  }
}

/**
 * Crea el bot. Devuelve null cuando no hay TELEGRAM_BOT_TOKEN.
 *
 * @param {{config: object, repos: object, services: object, logger?: object, notifier?: object, botOptions?: object}} options
 * @returns {import('telegraf').Telegraf|null}
 */
export function createBot({ config, repos, services, logger, notifier, botOptions = {} }) {
  if (!config?.telegram?.token) return null;

  const bot = new Telegraf(config.telegram.token, botOptions);
  const deps = { config, repos, services, logger, notifier };

  // Primero se registra cada update en el log (sin el contenido del mensaje),
  // despues la autenticacion: ningun handler corre sin ctx.state.user.
  bot.use(createUpdateLogger(logger));
  bot.use(createAuthMiddleware(deps));
  registerHandlers(bot, deps);

  bot.catch(async (error, ctx) => {
    logger?.error?.('error no controlado del bot', {
      error,
      updateType: ctx?.updateType,
      chatId: ctx?.chat?.id,
    });
    try {
      if (typeof ctx?.reply === 'function') {
        await ctx.reply('❌ Ocurrió un error inesperado. Probá de nuevo en unos segundos.', HTML_OPTS);
      }
    } catch {
      // el chat puede estar inaccesible: no hay nada mas que hacer
    }
  });

  // Fire-and-forget: no bloquea el arranque si Telegram esta lento.
  setBotCommands(bot, logger).catch(() => {});

  return bot;
}
