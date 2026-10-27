/**
 * Definicion de tablas, columnas y conversion de filas entre la app
 * (camelCase, booleanos, objetos) y la base (snake_case, 0/1, JSON).
 */

export const TABLES = Object.freeze({
  users: [
    'id', 'name', 'role', 'telegram_id', 'email', 'active', 'created_at', 'updated_at',
  ],
  categories: [
    'id', 'name', 'type', 'emoji', 'monthly_budget_cents', 'keywords', 'active', 'created_at', 'updated_at',
  ],
  transactions: [
    'id', 'user_id', 'category_id', 'type', 'amount_cents', 'currency', 'note', 'source',
    'status', 'occurred_at', 'created_at', 'updated_at', 'document_id', 'metadata',
  ],
  documents: [
    'id', 'user_id', 'telegram_file_id', 'file_name', 'mime_type', 'vendor', 'total_cents',
    'currency', 'due_date', 'category_id', 'extracted', 'status', 'source', 'created_at', 'updated_at',
  ],
  goals: [
    'id', 'name', 'target_cents', 'saved_cents', 'deadline', 'user_id', 'category_id',
    'active', 'created_at', 'updated_at',
  ],
  settings: ['key', 'value', 'updated_at'],
  alert_events: ['id', 'key', 'category_id', 'threshold', 'period', 'sent_at', 'payload'],
  email_log: [
    'message_id', 'from_address', 'subject', 'status', 'processed_at', 'transaction_id',
    'document_id', 'error',
  ],
});

export const JSON_FIELDS = Object.freeze({
  categories: ['keywords'],
  transactions: ['metadata'],
  documents: ['extracted'],
  alert_events: ['payload'],
});

export const BOOLEAN_FIELDS = Object.freeze({
  users: ['active'],
  categories: ['active'],
  goals: ['active'],
});

export const INTEGER_FIELDS = Object.freeze({
  categories: ['monthly_budget_cents'],
  transactions: ['amount_cents'],
  documents: ['total_cents'],
  goals: ['target_cents', 'saved_cents'],
  alert_events: ['threshold'],
});

export class StoreError extends Error {
  constructor(message, { cause, code, status, table, details } = {}) {
    super(message);
    this.name = 'StoreError';
    this.cause = cause;
    this.code = code;
    this.status = status;
    this.table = table;
    this.details = details;
  }
}

export function isUniqueViolation(error) {
  if (!error) return false;
  const code = String(error.code || error.cause?.code || '');
  const message = String(error.message || error.cause?.message || '');
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    /unique constraint|duplicate key|UNIQUE constraint failed/i.test(message)
  );
}

export function assertTable(table) {
  if (!TABLES[table]) throw new StoreError(`Tabla desconocida: ${table}`, { table });
  return TABLES[table];
}

/** Normaliza una fila para escritura. */
export function encodeRow(table, row, { jsonAsString = true } = {}) {
  const columns = assertTable(table);
  const jsonFields = JSON_FIELDS[table] || [];
  const output = {};
  for (const [key, rawValue] of Object.entries(row)) {
    if (!columns.includes(key)) continue;
    let value = rawValue;
    if (value === undefined) value = null;
    if (value instanceof Date) value = value.toISOString();
    if (typeof value === 'boolean') value = value ? 1 : 0;
    if (jsonFields.includes(key) && value !== null && typeof value === 'object') {
      value = jsonAsString ? JSON.stringify(value) : value;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) value = null;
    output[key] = value;
  }
  return output;
}

/** Normaliza una fila leida de la base. */
export function decodeRow(table, row, { jsonAsString = true, booleans = true } = {}) {
  if (!row) return null;
  const jsonFields = JSON_FIELDS[table] || [];
  const boolFields = BOOLEAN_FIELDS[table] || [];
  const intFields = INTEGER_FIELDS[table] || [];
  const output = { ...row };
  for (const field of jsonFields) {
    const value = output[field];
    if (typeof value === 'string' && value.trim()) {
      try {
        output[field] = JSON.parse(value);
      } catch {
        output[field] = null;
      }
    } else if (!jsonAsString && value === undefined) {
      output[field] = null;
    }
  }
  if (booleans) {
    for (const field of boolFields) {
      if (output[field] === undefined || output[field] === null) continue;
      output[field] = Boolean(output[field]);
    }
  }
  for (const field of intFields) {
    if (output[field] === undefined || output[field] === null) continue;
    output[field] = Number(output[field]);
  }
  return output;
}

/** Valida columnas solicitadas para evitar inyeccion en orderBy. */
export function assertColumn(table, column) {
  const columns = assertTable(table);
  if (!columns.includes(column)) {
    throw new StoreError(`Columna desconocida ${table}.${column}`, { table });
  }
  return column;
}
