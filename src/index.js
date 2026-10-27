/**
 * Entrypoint de la app: node src/index.js
 * Crea la aplicacion, arranca todo y gestiona el apagado limpio.
 */

import { createApp } from './app.js';
import { createLogger } from './logger.js';

const logger = createLogger({ name: 'finanzas' });

let app = null;
let shuttingDown = false;

process.on('unhandledRejection', (reason) => {
  logger.error('promesa rechazada sin manejar', { error: reason });
});
process.on('uncaughtException', (error) => {
  logger.error('excepcion no atrapada', { error });
});

async function main() {
  try {
    app = await createApp({ loadEnvFile: true });
    await app.start();
  } catch (error) {
    logger.error('fallo el arranque', { error });
    process.exit(1);
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('apagando', { signal });
  if (app) {
    try {
      await app.stop();
    } catch (error) {
      logger.error('fallo el apagado limpio', { error });
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

void main();
