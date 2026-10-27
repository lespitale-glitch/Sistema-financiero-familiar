/**
 * Bootstrap de la aplicacion: carga la configuracion, arma la base, los
 * servicios, el bot de Telegram y el servidor web.
 *
 * createApp() no arranca nada por su cuenta: devuelve referencias con sus
 * metodos start()/stop() para que el entrypoint (src/index.js), los tests y el
 * script de smoke los controlen.
 */

import { loadConfig, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { createDatabase } from './db/index.js';
import { DEFAULT_CATEGORIES } from './domain.js';

import { createNotifier } from './services/notifier.js';
import { createGeminiClient } from './services/gemini.js';
import { createOcrService } from './services/ocr.js';
import { createAlertsService } from './services/alerts.js';
import { createTransactionsService } from './services/transactions.js';
import { createUsersService } from './services/users.js';
import { createEmailService } from './services/email.js';
import { createScheduler } from './services/scheduler.js';

import { createBot } from './bot/index.js';
import { createWebServer } from './web/server.js';

export const WEBHOOK_PATH = '/api/telegram/webhook';

/**
 * @param {{env?: object, loadEnvFile?: boolean, logger?: object}} [options]
 * @returns {Promise<{config: object, logger: object, repos: object, services: object,
 *   notifier: object, bot: object|null, web: object, scheduler: object,
 *   start: (options?: {port?: number}) => Promise<{port: number, url: string}>,
 *   stop: () => Promise<void>}>}
 */
export async function createApp({ env = process.env, loadEnvFile = true, logger } = {}) {
  const config = loadConfig(env, { loadEnvFile });
  const validation = validateConfig(config);
  const log = logger || createLogger({ level: config.app.logLevel, name: 'finanzas' });

  for (const warning of validation.warnings) {
    log.warn(`configuracion: ${warning}`);
  }
  if (!validation.ok) {
    for (const error of validation.errors) log.error(`configuracion: ${error}`);
    throw new Error(`Configuracion invalida: ${validation.errors.join(' ')}`);
  }

  // --- Persistencia ---
  const repos = await createDatabase(config, { logger: log });
  await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);

  // --- Servicios base ---
  const users = createUsersService({ repos, config, logger: log });
  const synced = await users.syncFamilyMembers();

  const notifier = createNotifier({ logger: log });

  const gemini = createGeminiClient({
    apiKey: config.gemini.apiKey,
    baseUrl: config.gemini.baseUrl,
    textModel: config.gemini.textModel,
    visionModel: config.gemini.visionModel,
    audioModel: config.gemini.audioModel,
    logger: log,
  });
  const ocr = createOcrService({ gemini, config, logger: log });

  const alerts = createAlertsService({ repos, config, notifier, logger: log });
  const transactions = createTransactionsService({ repos, config, alerts, logger: log });

  const services = {
    users,
    transactions,
    alerts,
    ocr,
  };

  // El servicio de email usa services.* en runtime (transactions/alerts/ocr).
  services.email = createEmailService({ config, repos, services, logger: log, notifier });

  // --- Scheduler de resumenes ---
  const scheduler = createScheduler({ config, repos, services, notifier, logger: log });

  // --- Bot de Telegram (opcional) ---
  const bot = createBot({ config, repos, services, logger: log, notifier });
  if (bot) {
    notifier.attachBot(bot);
    log.info('bot de Telegram armado', {
      mode: config.telegram.mode,
      members: synced.length,
    });
  } else {
    log.warn('bot de Telegram deshabilitado: falta TELEGRAM_BOT_TOKEN');
  }

  // --- Servidor web ---
  const web = createWebServer({ config, repos, services, logger: log, bot });

  async function start({ port } = {}) {
    let webhookUrl = null;
    if (config.telegram.mode === 'webhook' && bot) {
      webhookUrl = `${config.telegram.publicUrl}${WEBHOOK_PATH}`;
      try {
        await bot.telegram.setWebhook(webhookUrl, {
          secret_token: config.telegram.webhookSecret || undefined,
          drop_pending_updates: true,
        });
        log.info('webhook de Telegram configurado', { url: webhookUrl });
      } catch (error) {
        log.error('fallo configurando el webhook de Telegram', { error });
      }
    } else if (bot) {
      try {
        await bot.telegram.setWebhook('', { drop_pending_updates: true });
      } catch {
        // sin red al arrancar no debe tumbar la app: launch lo reintenta
      }
    }

    // El polling de updates es el modo por defecto; en webhook Telegram nos
    // llama por HTTP. `bot.launch` no lanza si Telegram falla: lo dejamos en
    // estado degrado y la app sigue con la API web.
    if (bot && config.telegram.mode === 'polling') {
      bot.launch(() => {}).catch?.(() => {});
    }

    await scheduler.start();
    if (config.email.imap.enabled) {
      await email.startImapPoller();
    }

    const listening = await web.start(port ?? config.app.port);
    log.info('app lista', {
      port: listening.port,
      driver: config.db.driver,
      timezone: config.app.timezone,
      currency: config.app.currency,
      gemini: config.gemini.enabled,
    });
    return { ...listening, webhookUrl };
  }

  async function stop() {
    try { scheduler.stop(); } catch { /* noop */ }
    try { await email.stopImapPoller(); } catch { /* noop */ }
    if (bot) {
      try { bot.stop && bot.stop(); } catch { /* noop */ }
    }
    try { await web.stop(); } catch { /* noop */ }
    try { await repos.close(); } catch { /* noop */ }
  }

  return {
    config,
    logger: log,
    repos,
    services,
    notifier,
    bot,
    web,
    scheduler,
    start,
    stop,
  };
}

/** Configura el webhook de Telegram para un entorno ya corriendo. */
export async function setBotWebhook(bot, config, logger) {
  const url = `${config.telegram.publicUrl}${WEBHOOK_PATH}`;
  await bot.telegram.setWebhook(url, {
    secret_token: config.telegram.webhookSecret || undefined,
  });
  logger?.info?.('webhook de Telegram actualizado', { url });
  return url;
}
