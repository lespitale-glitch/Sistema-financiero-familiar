/**
 * Siembra la base: categorias default, miembros de la familia y presupuestos
 * de ejemplo si se pasa --demo.
 * Uso: node scripts/seed.js [--demo] [--env key=value ...]
 */

import { DEFAULT_CATEGORIES } from '../src/domain.js';
import { createLogger } from '../src/logger.js';
import { createApp } from '../src/app.js';

const args = process.argv.slice(2);

function envFromArgs() {
  const env = { ...process.env, GEMINI_API_KEY: process.env.GEMINI_API_KEY || '' };
  for (const arg of args) {
    const match = arg.match(/^--env ([^= ]+)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  return env;
}

const logger = createLogger({ name: 'seed' });

async function main() {
  const app = await createApp({ env: envFromArgs(), loadEnvFile: true, logger });
  const { repos } = app;

  try {
    const categories = await repos.categories.ensureDefaults(DEFAULT_CATEGORIES);
    logger.info('categorias sembradas', { count: categories.length });

    const synced = await app.services.users.syncFamilyMembers();
    logger.info('miembros sincronizados', { count: synced.length });

    logger.info('seed completo', {
      driver: app.config.db.driver,
      sqlitePath: app.config.db.sqlitePath,
    });
  } finally {
    await app.stop();
  }
}

main().catch((error) => {
  logger.error('seed falló', { error });
  process.exit(1);
});
