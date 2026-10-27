import {
  StoreError,
  TABLES,
  assertColumn,
  assertTable,
  decodeRow,
  encodeRow,
} from './rows.js';

const PAGE_SIZE = 1000;

function encodeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value;
  return value;
}

function buildQuery(table, where = {}, { orderBy, ascending, limit, offset } = {}, { count = false } = {}) {
  assertTable(table);
  const params = new URLSearchParams();
  params.set('select', '*');
  if (orderBy) {
    assertColumn(table, orderBy);
    params.set('order', `${orderBy}.${ascending ? 'asc' : 'desc'}`);
  }
  for (const [column, spec] of Object.entries(where || {})) {
    if (spec === undefined) continue;
    assertColumn(table, column);
    if (spec === null) {
      params.append(column, 'is.null');
      continue;
    }
    if (Array.isArray(spec)) {
      params.append(column, `in.(${spec.map(formatInValue).join(',')})`);
      continue;
    }
    if (typeof spec === 'object' && !(spec instanceof Date)) {
      for (const [operator, value] of Object.entries(spec)) {
        const op = String(operator).toLowerCase();
        if (op === 'isnull') {
          params.append(column, `is.${value ? 'null' : 'not.null'}`);
        } else if (op === 'in') {
          const values = Array.isArray(value) ? value : [value];
          params.append(column, `in.(${values.map(formatInValue).join(',')})`);
        } else if (op === 'like') {
          params.append(column, `like.${String(value).replace(/%/g, '*')}`);
        } else if (['gte', 'lte', 'gt', 'lt', 'ne'].includes(op)) {
          params.append(column, `${op}.${formatInValue(value)}`);
        } else {
          throw new StoreError(`Operador no soportado: ${op}`);
        }
      }
      continue;
    }
    params.append(column, `eq.${formatInValue(spec)}`);
  }
  if (Number.isInteger(limit)) params.set('limit', String(limit));
  if (Number.isInteger(offset) && offset > 0) params.set('offset', String(offset));
  if (count) params.set('limit', params.get('limit') || '1');
  return params.toString();
}

function formatInValue(value) {
  const normalized = encodeValue(value);
  if (normalized === null || normalized === undefined) return 'null';
  if (typeof normalized === 'number') return String(normalized);
  if (typeof normalized === 'boolean') return String(normalized);
  return `"${String(normalized).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Almacen sobre Supabase/PostgREST usando la service_role key.
 * Misma interfaz que SqliteStore. Pagina automaticamente las lecturas.
 */
export class SupabaseStore {
  constructor({ url, key, schema = 'public', logger, fetchImpl = globalThis.fetch } = {}) {
    if (!url) throw new StoreError('SUPABASE_URL es obligatorio');
    if (!key) throw new StoreError('SUPABASE_SERVICE_ROLE_KEY es obligatorio');
    this.driver = 'supabase';
    this.url = String(url).replace(/\/+$/, '');
    this.key = key;
    this.schema = schema || 'public';
    this.logger = logger;
    this.fetch = fetchImpl;
  }

  async init() {
    await this.ping();
    this.logger?.info('supabase listo', { schema: this.schema });
    return this;
  }

  #headers(prefer) {
    const headers = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Accept-Profile': this.schema,
      'Content-Profile': this.schema,
    };
    if (prefer) headers.Prefer = prefer;
    return headers;
  }

  async #request(method, path, { body, prefer, extraHeaders, raw = false } = {}) {
    const url = `${this.url}/rest/v1/${path}`;
    let response;
    try {
      response = await this.fetch(url, {
        method,
        headers: { ...this.#headers(prefer), ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });
    } catch (error) {
      throw new StoreError(`No se pudo conectar con Supabase: ${error.message}`, { cause: error });
    }
    if (!response.ok) {
      let details = null;
      let message = `Supabase respondio ${response.status}`;
      try {
        details = await response.json();
        message = details.message || details.hint || message;
      } catch {
        // respuesta sin JSON
      }
      throw new StoreError(`Error de Supabase: ${message}`, {
        status: response.status,
        code: details?.code,
        details,
      });
    }
    if (raw) return response;
    if (response.status === 204) return null;
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new StoreError('Respuesta invalida de Supabase (no es JSON)');
    }
  }

  async insert(table, row) {
    const encoded = encodeRow(table, row, { jsonAsString: false });
    const data = await this.#request('POST', `${table}?select=*`, {
      body: encoded,
      prefer: 'return=representation',
    });
    return decodeRow(table, Array.isArray(data) ? data[0] : data, { jsonAsString: false });
  }

  async upsert(table, row, conflictColumns = ['id']) {
    const encoded = encodeRow(table, row, { jsonAsString: false });
    for (const column of conflictColumns) assertColumn(table, column);
    const onConflict = conflictColumns.join(',');
    const data = await this.#request(
      'POST',
      `${table}?on_conflict=${encodeURIComponent(onConflict)}&select=*`,
      { body: encoded, prefer: 'resolution=merge-duplicates,return=representation' },
    );
    return decodeRow(table, Array.isArray(data) ? data[0] : data, { jsonAsString: false });
  }

  async findOne(table, where = {}) {
    const rows = await this.findMany(table, where, { limit: 1, orderBy: TABLES[table][0] });
    return rows[0] || null;
  }

  async findMany(table, where = {}, { orderBy = 'created_at', ascending = false, limit = null, offset = 0 } = {}) {
    assertTable(table);
    const rows = [];
    let currentOffset = Number.isInteger(offset) ? offset : 0;
    const pageSize = Number.isInteger(limit) && limit > 0 ? Math.min(limit, PAGE_SIZE) : PAGE_SIZE;
    const hardLimit = Number.isInteger(limit) && limit >= 0 ? limit : null;

    while (true) {
      const remaining = hardLimit === null ? PAGE_SIZE : Math.min(pageSize, hardLimit - rows.length);
      if (remaining <= 0) break;
      const query = buildQuery(table, where, {
        orderBy, ascending, limit: remaining, offset: currentOffset,
      });
      const page = await this.#request('GET', `${table}?${query}`);
      const batch = Array.isArray(page) ? page : [];
      rows.push(...batch.map((row) => decodeRow(table, row, { jsonAsString: false })));
      if (hardLimit !== null) break;
      if (batch.length === 0) break;
      currentOffset += batch.length;
      if (rows.length > 50000) {
        this.logger?.warn('limite de paginacion alcanzado en Supabase', { table, rows: rows.length });
        break;
      }
    }
    return hardLimit === null ? rows : rows.slice(0, hardLimit);
  }

  async update(table, id, patch) {
    assertTable(table);
    const encoded = encodeRow(table, patch, { jsonAsString: false });
    delete encoded.id;
    const data = await this.#request(`PATCH`, `${table}?id=eq.${encodeURIComponent(id)}&select=*`, {
      body: encoded,
      prefer: 'return=representation',
    });
    return decodeRow(table, Array.isArray(data) ? data[0] : data, { jsonAsString: false });
  }

  async remove(table, id) {
    assertTable(table);
    const data = await this.#request('DELETE', `${table}?id=eq.${encodeURIComponent(id)}&select=id`, {
      prefer: 'return=representation',
    });
    return Array.isArray(data) ? data.length > 0 : Boolean(data);
  }

  async count(table, where = {}) {
    assertTable(table);
    const query = buildQuery(table, where, { limit: 1 }, { count: true });
    const response = await this.#request('GET', `${table}?${query}`, {
      prefer: 'count=exact',
      raw: true,
    });
    const range = response.headers.get('content-range');
    if (range) {
      const total = Number(range.split('/')[1]);
      if (Number.isFinite(total)) return total;
    }
    const data = await response.json().catch(() => []);
    return Array.isArray(data) ? data.length : 0;
  }

  async ping() {
    await this.#request('GET', 'users?select=id&limit=1');
    return true;
  }

  async close() {
    // Sin conexiones persistentes
  }
}

export function createSupabaseStore(options) {
  return new SupabaseStore(options);
}
