import { createRepositories } from './repositories.js';
import { createSqliteStore } from './sqlite-store.js';
import { createSupabaseStore } from './supabase-store.js';

/**
 * Crea el Store segun config.db.driver y lo inicializa.
 * @param {object} config
 * @param {{logger?: object, fetchImpl?: Function, clock?: Function, idFactory?: Function}} options
 */
export async function createStore(config, { logger, fetchImpl } = {}) {
  let store;
  if (config.db.driver === 'supabase') {
    store = createSupabaseStore({
      url: config.db.supabase.url,
      key: config.db.supabase.key,
      schema: config.db.supabase.schema,
      logger,
      fetchImpl,
    });
  } else {
    store = createSqliteStore({ path: config.db.sqlitePath, logger });
  }
  await store.init();
  return store;
}

/**
 * Crea Store + Repositorios.
 */
export async function createDatabase(config, { logger, fetchImpl, clock, idFactory } = {}) {
  const store = await createStore(config, { logger, fetchImpl });
  const repos = createRepositories(store, { logger, clock, idFactory });
  return repos;
}

export { createRepositories } from './repositories.js';
export { createSqliteStore } from './sqlite-store.js';
export { createSupabaseStore } from './supabase-store.js';
export { StoreError, TABLES, isUniqueViolation } from './rows.js';
