import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  StoreError,
  TABLES,
  assertColumn,
  assertTable,
  decodeRow,
  encodeRow,
} from './rows.js';

const SCHEMA_PATH = new URL('./schema.sql', import.meta.url);

function normalizeBind(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

/**
 * Almacen SQLite basado en node:sqlite (incluido en Node >= 22.13).
 * Sin modulos nativos ni compilacion.
 */
export class SqliteStore {
  constructor({ path: filePath = './data/finanzas.sqlite', logger } = {}) {
    this.driver = 'sqlite';
    this.filePath = filePath;
    this.logger = logger;
    this.db = null;
    this.statements = new Map();
  }

  async init() {
    if (this.db) return this;
    if (this.filePath !== ':memory:') {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    }
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
    this.db.exec(schema);
    this.logger?.info('sqlite listo', { path: this.filePath });
    return this;
  }

  #statement(sql) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  #ensureReady() {
    if (!this.db) throw new StoreError('La base de datos no fue inicializada. Llama a init().');
  }

  async insert(table, row) {
    this.#ensureReady();
    const columns = assertTable(table);
    const encoded = encodeRow(table, row);
    const keys = Object.keys(encoded).filter((key) => columns.includes(key));
    if (keys.length === 0) throw new StoreError(`Insert sin columnas en ${table}`, { table });
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) RETURNING *`;
    try {
      const result = this.#statement(sql).get(...keys.map((key) => normalizeBind(encoded[key])));
      return decodeRow(table, result);
    } catch (error) {
      throw new StoreError(`Error insertando en ${table}: ${error.message}`, {
        cause: error, code: error.code, table,
      });
    }
  }

  async upsert(table, row, conflictColumns = ['id']) {
    this.#ensureReady();
    const columns = assertTable(table);
    const encoded = encodeRow(table, row);
    const keys = Object.keys(encoded).filter((key) => columns.includes(key));
    if (keys.length === 0) throw new StoreError(`Upsert sin columnas en ${table}`, { table });
    for (const column of conflictColumns) assertColumn(table, column);
    const updates = keys.filter((key) => !conflictColumns.includes(key));
    const updateClause = updates.length
      ? `DO UPDATE SET ${updates.map((key) => `${key} = excluded.${key}`).join(', ')}`
      : 'DO NOTHING';
    const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})
      ON CONFLICT (${conflictColumns.join(', ')}) ${updateClause}
      RETURNING *`;
    try {
      const result = this.#statement(sql).get(...keys.map((key) => normalizeBind(encoded[key])));
      if (result) return decodeRow(table, result);
      return this.findOne(table, Object.fromEntries(conflictColumns.map((column) => [column, encoded[column]])));
    } catch (error) {
      throw new StoreError(`Error en upsert de ${table}: ${error.message}`, {
        cause: error, code: error.code, table,
      });
    }
  }

  async findOne(table, where = {}) {
    const rows = await this.findMany(table, where, { limit: 1, orderBy: TABLES[table][0] });
    return rows[0] || null;
  }

  async findMany(table, where = {}, { orderBy = 'created_at', ascending = false, limit = null, offset = 0 } = {}) {
    this.#ensureReady();
    assertTable(table);
    assertColumn(table, orderBy);
    const { clause, params } = buildWhere(table, where);
    let sql = `SELECT * FROM ${table}${clause ? ` WHERE ${clause}` : ''} ORDER BY ${orderBy} ${ascending ? 'ASC' : 'DESC'}`;
    if (Number.isInteger(limit) && limit >= 0) sql += ` LIMIT ${limit}`;
    if (Number.isInteger(offset) && offset > 0) sql += ` OFFSET ${offset}`;
    try {
      return this.#statement(sql).all(...params).map((row) => decodeRow(table, row));
    } catch (error) {
      throw new StoreError(`Error leyendo ${table}: ${error.message}`, {
        cause: error, code: error.code, table,
      });
    }
  }

  async update(table, id, patch) {
    this.#ensureReady();
    const columns = assertTable(table);
    const encoded = encodeRow(table, patch);
    const keys = Object.keys(encoded).filter((key) => columns.includes(key) && key !== 'id');
    if (keys.length === 0) return this.findOne(table, { id });
    const sql = `UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ? RETURNING *`;
    try {
      const result = this.#statement(sql).get(...keys.map((key) => normalizeBind(encoded[key])), id);
      return result ? decodeRow(table, result) : null;
    } catch (error) {
      throw new StoreError(`Error actualizando ${table}: ${error.message}`, {
        cause: error, code: error.code, table,
      });
    }
  }

  async remove(table, id) {
    this.#ensureReady();
    assertTable(table);
    try {
      const result = this.#statement(`DELETE FROM ${table} WHERE id = ?`).run(id);
      return Number(result.changes) > 0;
    } catch (error) {
      throw new StoreError(`Error borrando de ${table}: ${error.message}`, {
        cause: error, code: error.code, table,
      });
    }
  }

  async count(table, where = {}) {
    this.#ensureReady();
    assertTable(table);
    const { clause, params } = buildWhere(table, where);
    const sql = `SELECT COUNT(*) AS total FROM ${table}${clause ? ` WHERE ${clause}` : ''}`;
    try {
      const row = this.#statement(sql).get(...params);
      return Number(row?.total || 0);
    } catch (error) {
      throw new StoreError(`Error contando ${table}: ${error.message}`, {
        cause: error, code: error.code, table,
      });
    }
  }

  async ping() {
    this.#ensureReady();
    const row = this.#statement('SELECT 1 AS ok').get();
    return Number(row?.ok) === 1;
  }

  async close() {
    if (!this.db) return;
    this.statements.clear();
    this.db.close();
    this.db = null;
  }
}

function buildWhere(table, where = {}) {
  const clauses = [];
  const params = [];
  const entries = Object.entries(where || {}).filter(([, value]) => value !== undefined);
  for (const [column, spec] of entries) {
    assertColumn(table, column);
    if (spec === null) {
      clauses.push(`${column} IS NULL`);
      continue;
    }
    if (Array.isArray(spec)) {
      if (spec.length === 0) {
        clauses.push('1 = 0');
      } else {
        clauses.push(`${column} IN (${spec.map(() => '?').join(', ')})`);
        params.push(...spec.map(normalizeBind));
      }
      continue;
    }
    if (typeof spec === 'object' && !(spec instanceof Date)) {
      for (const [operator, value] of Object.entries(spec)) {
        const op = String(operator).toLowerCase();
        if (op === 'isnull') {
          clauses.push(`${column} IS ${value ? 'NULL' : 'NOT NULL'}`);
        } else if (op === 'in') {
          const values = Array.isArray(value) ? value : [value];
          if (values.length === 0) {
            clauses.push('1 = 0');
          } else {
            clauses.push(`${column} IN (${values.map(() => '?').join(', ')})`);
            params.push(...values.map(normalizeBind));
          }
        } else if (op === 'like') {
          clauses.push(`${column} LIKE ?`);
          params.push(String(value));
        } else {
          const sqlOp = { gte: '>=', lte: '<=', gt: '>', lt: '<', ne: '!=' }[op];
          if (!sqlOp) throw new StoreError(`Operador no soportado: ${op}`);
          clauses.push(`${column} ${sqlOp} ?`);
          params.push(normalizeBind(value));
        }
      }
      continue;
    }
    clauses.push(`${column} = ?`);
    params.push(normalizeBind(spec));
  }
  return { clause: clauses.join(' AND '), params };
}

export function createSqliteStore(options) {
  return new SqliteStore(options);
}

export { TABLES };
