/**
 * Adaptador de envio de mensajes. Se mantiene independiente de Telegraf para
 * que los servicios (alertas, scheduler, email) sean testeables con un fake.
 * El bot adjunta su instancia al arrancar.
 */
export function createNotifier({ logger, bot = null } = {}) {
  let currentBot = bot;

  async function sendMessage(chatId, html, extra = {}) {
    if (chatId === null || chatId === undefined || chatId === '') {
      return { ok: false, skipped: true, reason: 'chat-id-vacio' };
    }
    if (!currentBot) {
      logger?.warn?.('mensaje no enviado: bot no disponible', { chatId });
      return { ok: false, skipped: true, reason: 'bot-deshabilitado' };
    }
    try {
      const message = await currentBot.telegram.sendMessage(chatId, html, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      });
      return { ok: true, messageId: message?.message_id };
    } catch (error) {
      logger?.error?.('fallo el envio de Telegram', { chatId, error });
      return { ok: false, error: error.message };
    }
  }

  async function sendDocument(chatId, document, extra = {}) {
    if (!currentBot) {
      logger?.warn?.('documento no enviado: bot no disponible', { chatId });
      return { ok: false, skipped: true, reason: 'bot-deshabilitado' };
    }
    try {
      const message = await currentBot.telegram.sendDocument(chatId, document, extra);
      return { ok: true, messageId: message?.message_id };
    } catch (error) {
      logger?.error?.('fallo el envio de documento por Telegram', { chatId, error });
      return { ok: false, error: error.message };
    }
  }

  return {
    attachBot(botInstance) {
      currentBot = botInstance;
    },
    get available() {
      return Boolean(currentBot);
    },
    sendMessage,
    sendDocument,
  };
}
