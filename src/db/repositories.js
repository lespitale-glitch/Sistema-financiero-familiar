import { randomUUID } from 'node:crypto';
import {
  FALLBACK_CATEGORY_NAME,
  ROLES,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUS,
  TYPE_LIST,
} from '../domain.js';
import { toCents } from '../utils/money.js';
import { toIso } from '../utils/dates.js';
import { StoreError, isUniqueViolation } from './rows.js';

const DEFAULT_CURRENCY = 'ARS';
const MAX_NOTE_LENGTH = 1000;

function nowIso(clock) {
  return clock().toISOString();
}

function text(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const normalized = String(value).trim();
  return normalized || fallback;
}

function requiredText(value, field) {
  const normalized = text(value);
  if (!normalized) throw new StoreError(`${field} es obligatorio`);
  return normalized;
}

function normalizeEmail(value) {
  const email = text(value);
  return email ? email.toLowerCase() : null;
}

function normalizeTelegramId(value) {
  const id = text(value);
  if (!id) return null;
  const digits = id.replace(/[^\d-]/g, '');
  return digits || null;
}

function normalizeRole(value) {
  return Object.values(ROLES).includes(value) ? value : ROLES.OTHER;
}

function clampLimit(value, fallback = 50, max = 500) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function mapUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    telegramId: row.telegram_id,
    email: row.email,
    active: row.active === undefined ? true : Boolean(Number(row.active)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    emoji: row.emoji || '🏷️',
    monthlyBudgetCents: row.monthly_budget_cents === null || row.monthly_budget_cents === undefined
      ? null
      : Number(row.monthly_budget_cents),
    keywords: Array.isArray(row.keywords) ? row.keywords : [],
    active: row.active === undefined ? true : Boolean(Number(row.active)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    categoryId: row.category_id,
    type: row.type,
    amountCents: Number(row.amount_cents),
    currency: row.currency || DEFAULT_CURRENCY,
    note: row.note || '',
    source: row.source,
    status: row.status,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    documentId: row.document_id,
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  };
}

function mapDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    telegramFileId: row.telegram_file_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    vendor: row.vendor,
    totalCents: row.total_cents === null || row.total_cents === undefined ? null : Number(row.total_cents),
    currency: row.currency || DEFAULT_CURRENCY,
    dueDate: row.due_date,
    categoryId: row.category_id,
    extracted: row.extracted && typeof row.extracted === 'object' ? row.extracted : {},
    status: row.status,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGoal(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    targetCents: Number(row.target_cents),
    savedCents: Number(row.saved_cents || 0),
    deadline: row.deadline,
    userId: row.user_id,
    categoryId: row.category_id,
    active: row.active === undefined ? true : Boolean(Number(row.active)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Repositorios de alto nivel. Toda la app usa camelCase y centavos; la
 * persistencia (SQLite o Supabase) queda detras de Store.
 */
export function createRepositories(store, { clock = () => new Date(), idFactory = () => randomUUID(), logger } = {}) {
  const newId = () => idFactory();

  const users = {
    async create(data) {
      const row = {
        id: data.id || newId(),
        name: requiredText(data.name, 'name'),
        role: normalizeRole(data.role),
        telegram_id: normalizeTelegramId(data.telegramId),
        email: normalizeEmail(data.email),
        active: data.active === undefined ? true : Boolean(data.active),
        created_at: nowIso(clock),
        updated_at: null,
      };
      return mapUser(await store.insert('users', row));
    },

    async update(id, patch) {
      const row = {};
      if (patch.name !== undefined) row.name = requiredText(patch.name, 'name');
      if (patch.role !== undefined) row.role = normalizeRole(patch.role);
      if (patch.telegramId !== undefined) row.telegram_id = normalizeTelegramId(patch.telegramId);
      if (patch.email !== undefined) row.email = normalizeEmail(patch.email);
      if (patch.active !== undefined) row.active = Boolean(patch.active);
      row.updated_at = nowIso(clock);
      return mapUser(await store.update('users', id, row));
    },

    async get(id) {
      return mapUser(await store.findOne('users', { id }));
    },

    async getByTelegramId(telegramId) {
      const normalized = normalizeTelegramId(telegramId);
      if (!normalized) return null;
      return mapUser(await store.findOne('users', { telegram_id: normalized }));
    },

    async getByEmail(email) {
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      return mapUser(await store.findOne('users', { email: normalized }));
    },

    async list({ includeInactive = false } = {}) {
      const rows = await store.findMany('users', includeInactive ? {} : { active: true }, { orderBy: 'created_at', ascending: true });
      return rows.map(mapUser);
    },

    /**
     * Crea o actualiza un miembro a partir de la config FAMILY_MEMBERS.
     * Si el telegram_id ya existe, actualiza nombre/rol/email.
     * Si el email ya existe sin telegram_id, lo vincula.
     */
    async upsertFromConfig(member) {
      const telegramId = normalizeTelegramId(member.telegramId);
      const email = normalizeEmail(member.email);
      let existing = telegramId ? await users.getByTelegramId(telegramId) : null;
      if (!existing && email) existing = await users.getByEmail(email);
      if (existing) {
        const patch = {};
        if (member.name && member.name !== existing.name) patch.name = member.name;
        if (member.role && member.role !== existing.role) patch.role = member.role;
        if (email && email !== existing.email) patch.email = email;
        if (telegramId && telegramId !== existing.telegramId) patch.telegramId = telegramId;
        if (!existing.active) patch.active = true;
        if (Object.keys(patch).length === 0) return existing;
        return users.update(existing.id, patch);
      }
      return users.create({
        name: member.name,
        role: member.role,
        telegramId,
        email,
      });
    },

    async deactivate(id) {
      return users.update(id, { active: false });
    },
  };

  const categories = {
    async create(data) {
      const name = requiredText(data.name, 'name');
      const type = TYPE_LIST.includes(data.type) ? data.type : null;
      if (!type) throw new StoreError(`Tipo de categoria invalido: ${data.type}`);
      const budget = data.monthlyBudgetCents === null || data.monthlyBudgetCents === undefined
        ? null
        : Math.max(0, Number(data.monthlyBudgetCents));
      const keywords = Array.isArray(data.keywords)
        ? data.keywords.map((keyword) => String(keyword).trim().toLowerCase()).filter(Boolean)
        : [];
      const row = {
        id: data.id || newId(),
        name,
        type,
        emoji: text(data.emoji, '🏷️'),
        monthly_budget_cents: budget,
        keywords,
        active: data.active === undefined ? true : Boolean(data.active),
        created_at: nowIso(clock),
        updated_at: null,
      };
      try {
        return mapCategory(await store.insert('categories', row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreError(`Ya existe una categoria llamada "${name}".`, { cause: error, code: 'DUPLICATE_CATEGORY' });
        }
        throw error;
      }
    },

    async update(id, patch) {
      const row = {};
      if (patch.name !== undefined) row.name = requiredText(patch.name, 'name');
      if (patch.type !== undefined) {
        if (!TYPE_LIST.includes(patch.type)) throw new StoreError(`Tipo invalido: ${patch.type}`);
        row.type = patch.type;
      }
      if (patch.emoji !== undefined) row.emoji = text(patch.emoji, '🏷️');
      if (patch.monthlyBudgetCents !== undefined) {
        row.monthly_budget_cents = patch.monthlyBudgetCents === null
          ? null
          : Math.max(0, Number(patch.monthlyBudgetCents));
      }
      if (patch.keywords !== undefined) {
        row.keywords = Array.isArray(patch.keywords)
          ? patch.keywords.map((keyword) => String(keyword).trim().toLowerCase()).filter(Boolean)
          : [];
      }
      if (patch.active !== undefined) row.active = Boolean(patch.active);
      row.updated_at = nowIso(clock);
      try {
        return mapCategory(await store.update('categories', id, row));
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new StoreError(`Ya existe una categoria llamada "${row.name}".`, { cause: error, code: 'DUPLICATE_CATEGORY' });
        }
        throw error;
      }
    },

    async get(id) {
      return mapCategory(await store.findOne('categories', { id }));
    },

    async getByName(name) {
      const target = text(name);
      if (!target) return null;
      const rows = await store.findMany('categories', { active: true }, { orderBy: 'name', ascending: true });
      return mapCategory(rows.find((row) => String(row.name).toLowerCase() === target.toLowerCase()) || null);
    },

    async getOrFallback(name) {
      return (await categories.getByName(name)) || categories.getByName(FALLBACK_CATEGORY_NAME);
    },

    async list({ type = null, includeInactive = false } = {}) {
      const where = {};
      if (!includeInactive) where.active = true;
      if (type) where.type = type;
      const rows = await store.findMany('categories', where, { orderBy: 'name', ascending: true });
      return rows.map(mapCategory);
    },

    async ensureDefaults(defaults) {
      const existing = await categories.list({ includeInactive: true });
      const byName = new Map(existing.map((category) => [category.name.toLowerCase(), category]));
      for (const definition of defaults) {
        const key = definition.name.toLowerCase();
        const found = byName.get(key);
        if (found) {
          if ((!found.keywords || found.keywords.length === 0) && definition.keywords?.length) {
            const updated = await categories.update(found.id, { keywords: definition.keywords });
            byName.set(key, updated);
          }
          continue;
        }
        const created = await categories.create({
          name: definition.name,
          type: definition.type,
          emoji: definition.emoji,
          monthlyBudgetCents: definition.budget === null || definition.budget === undefined ? null : toCents(definition.budget),
          keywords: definition.keywords || [],
        });
        byName.set(key, created);
        logger?.debug?.('categoria creada', { category: created.name });
      }
      return [...byName.values()];
    },

    async deactivate(id) {
      return categories.update(id, { active: false });
    },
  };

  const transactions = {
    async create(data) {
      const type = TYPE_LIST.includes(data.type) ? data.type : null;
      if (!type) throw new StoreError(`Tipo de movimiento invalido: ${data.type}`);
      const amountCents = Number(data.amountCents);
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        throw new StoreError('amountCents debe ser un entero positivo (en centavos)');
      }
      const occurredAt = toIso(data.occurredAt || clock());
      if (!occurredAt) throw new StoreError('occurredAt invalido');
      const source = Object.values(TRANSACTION_SOURCES).includes(data.source) ? data.source : TRANSACTION_SOURCES.TEXT;
      const status = Object.values(TRANSACTION_STATUS).includes(data.status) ? data.status : TRANSACTION_STATUS.CONFIRMED;
      const note = text(data.note, '');
      const row = {
        id: data.id || newId(),
        user_id: text(data.userId),
        category_id: text(data.categoryId),
        type,
        amount_cents: amountCents,
        currency: text(data.currency, DEFAULT_CURRENCY).toUpperCase(),
        note: note ? note.slice(0, MAX_NOTE_LENGTH) : null,
        source,
        status,
        occurred_at: occurredAt,
        created_at: nowIso(clock),
        updated_at: null,
        document_id: text(data.documentId),
        metadata: data.metadata && typeof data.metadata === 'object' ? data.metadata : {},
      };
      return mapTransaction(await store.insert('transactions', row));
    },

    async update(id, patch) {
      const row = {};
      if (patch.type !== undefined) {
        if (!TYPE_LIST.includes(patch.type)) throw new StoreError(`Tipo invalido: ${patch.type}`);
        row.type = patch.type;
      }
      if (patch.amountCents !== undefined) {
        const amount = Number(patch.amountCents);
        if (!Number.isSafeInteger(amount) || amount <= 0) throw new StoreError('amountCents invalido');
        row.amount_cents = amount;
      }
      if (patch.note !== undefined) row.note = text(patch.note, null);
      if (patch.categoryId !== undefined) row.category_id = text(patch.categoryId);
      if (patch.userId !== undefined) row.user_id = text(patch.userId);
      if (patch.occurredAt !== undefined) {
        const iso = toIso(patch.occurredAt);
        if (!iso) throw new StoreError('occurredAt invalido');
        row.occurred_at = iso;
      }
      if (patch.status !== undefined) {
        if (!Object.values(TRANSACTION_STATUS).includes(patch.status)) throw new StoreError(`Status invalido: ${patch.status}`);
        row.status = patch.status;
      }
      if (patch.metadata !== undefined) row.metadata = patch.metadata;
      row.updated_at = nowIso(clock);
      return mapTransaction(await store.update('transactions', id, row));
    },

    async get(id) {
      return mapTransaction(await store.findOne('transactions', { id }));
    },

    async getByDocument(documentId) {
      return mapTransaction(await store.findOne('transactions', { document_id: documentId }));
    },

    async remove(id) {
      return store.remove('transactions', id);
    },

    async list({
      from = null,
      to = null,
      userId = null,
      categoryId = null,
      type = null,
      status = null,
      source = null,
      limit = 50,
      offset = 0,
      order = 'desc',
    } = {}) {
      const where = {};
      if (from || to) {
        where.occurred_at = {};
        if (from) where.occurred_at.gte = toIso(from);
        if (to) where.occurred_at.lt = toIso(to);
      }
      if (userId) where.user_id = userId;
      if (categoryId) where.category_id = categoryId;
      if (type) where.type = type;
      if (status) where.status = status;
      if (source) where.source = source;
      const rows = await store.findMany('transactions', where, {
        orderBy: 'occurred_at',
        ascending: order === 'asc',
        limit: clampLimit(limit, 50, 5000),
        offset: Number.isInteger(offset) ? offset : 0,
      });
      return rows.map(mapTransaction);
    },

    /**
     * Agregados de un periodo. `from` inclusivo, `to` exclusivo.
     */
    async totals({ from = null, to = null, status = TRANSACTION_STATUS.CONFIRMED, includeDiscarded = false } = {}) {
      const where = {};
      if (from || to) {
        where.occurred_at = {};
        if (from) where.occurred_at.gte = toIso(from);
        if (to) where.occurred_at.lt = toIso(to);
      }
      if (status && !includeDiscarded) where.status = status;
      const rows = await store.findMany('transactions', where, { orderBy: 'occurred_at', ascending: true });
      const mapped = rows.map(mapTransaction);
      const byType = Object.fromEntries(TYPE_LIST.map((type) => [type, 0]));
      const byCategoryMap = new Map();
      const byUserMap = new Map();
      let incomeCents = 0;
      let expenseCents = 0;
      let investmentCents = 0;

      for (const transaction of mapped) {
        byType[transaction.type] = (byType[transaction.type] || 0) + transaction.amountCents;
        if (transaction.type === 'income') incomeCents += transaction.amountCents;
        else if (transaction.type === 'investment') investmentCents += transaction.amountCents;
        else expenseCents += transaction.amountCents;

        const categoryKey = transaction.categoryId || 'uncategorized';
        const categoryEntry = byCategoryMap.get(categoryKey) || {
          categoryId: transaction.categoryId,
          type: transaction.type,
          totalCents: 0,
          count: 0,
        };
        categoryEntry.totalCents += transaction.amountCents;
        categoryEntry.count += 1;
        byCategoryMap.set(categoryKey, categoryEntry);

        const userKey = transaction.userId || 'anonymous';
        const userEntry = byUserMap.get(userKey) || {
          userId: transaction.userId,
          totalCents: 0,
          count: 0,
          incomeCents: 0,
          expenseCents: 0,
          investmentCents: 0,
        };
        userEntry.totalCents += transaction.amountCents;
        userEntry.count += 1;
        if (transaction.type === 'income') userEntry.incomeCents += transaction.amountCents;
        else if (transaction.type === 'investment') userEntry.investmentCents += transaction.amountCents;
        else userEntry.expenseCents += transaction.amountCents;
        byUserMap.set(userKey, userEntry);
      }

      return {
        count: mapped.length,
        byType,
        byCategory: [...byCategoryMap.values()].sort((a, b) => b.totalCents - a.totalCents),
        byUser: [...byUserMap.values()].sort((a, b) => b.totalCents - a.totalCents),
        incomeCents,
        expenseCents,
        investmentCents,
        balanceCents: incomeCents - expenseCents - investmentCents,
        transactions: mapped,
      };
    },
  };

  const documents = {
    async create(data) {
      const row = {
        id: data.id || newId(),
        user_id: text(data.userId),
        telegram_file_id: text(data.telegramFileId),
        file_name: text(data.fileName),
        mime_type: text(data.mimeType),
        vendor: text(data.vendor),
        total_cents: data.totalCents === null || data.totalCents === undefined ? null : Number(data.totalCents),
        currency: text(data.currency, DEFAULT_CURRENCY).toUpperCase(),
        due_date: text(data.dueDate),
        category_id: text(data.categoryId),
        extracted: data.extracted && typeof data.extracted === 'object' ? data.extracted : {},
        status: ['pending', 'confirmed', 'discarded', 'failed'].includes(data.status) ? data.status : 'pending',
        source: text(data.source, 'telegram'),
        created_at: nowIso(clock),
        updated_at: null,
      };
      return mapDocument(await store.insert('documents', row));
    },

    async update(id, patch) {
      const row = {};
      const mapping = {
        userId: 'user_id',
        telegramFileId: 'telegram_file_id',
        fileName: 'file_name',
        mimeType: 'mime_type',
        vendor: 'vendor',
        currency: 'currency',
        dueDate: 'due_date',
        categoryId: 'category_id',
        status: 'status',
        source: 'source',
      };
      for (const [key, column] of Object.entries(mapping)) {
        if (patch[key] !== undefined) row[column] = text(patch[key]);
      }
      if (patch.totalCents !== undefined) {
        row.total_cents = patch.totalCents === null ? null : Number(patch.totalCents);
      }
      if (patch.extracted !== undefined) row.extracted = patch.extracted;
      if (patch.status !== undefined && !['pending', 'confirmed', 'discarded', 'failed'].includes(patch.status)) {
        throw new StoreError(`Status de documento invalido: ${patch.status}`);
      }
      row.updated_at = nowIso(clock);
      return mapDocument(await store.update('documents', id, row));
    },

    async get(id) {
      return mapDocument(await store.findOne('documents', { id }));
    },

    async list({ status = null, userId = null, limit = 50 } = {}) {
      const where = {};
      if (status) where.status = status;
      if (userId) where.user_id = userId;
      const rows = await store.findMany('documents', where, {
        orderBy: 'created_at',
        ascending: false,
        limit: clampLimit(limit, 50, 500),
      });
      return rows.map(mapDocument);
    },
  };

  const goals = {
    async create(data) {
      const target = Number(data.targetCents);
      if (!Number.isSafeInteger(target) || target <= 0) throw new StoreError('targetCents invalido');
      const saved = Number(data.savedCents || 0);
      const row = {
        id: data.id || newId(),
        name: requiredText(data.name, 'name'),
        target_cents: target,
        saved_cents: Number.isSafeInteger(saved) && saved >= 0 ? saved : 0,
        deadline: text(data.deadline),
        user_id: text(data.userId),
        category_id: text(data.categoryId),
        active: true,
        created_at: nowIso(clock),
        updated_at: null,
      };
      return mapGoal(await store.insert('goals', row));
    },

    async update(id, patch) {
      const row = {};
      if (patch.name !== undefined) row.name = requiredText(patch.name, 'name');
      if (patch.targetCents !== undefined) row.target_cents = Number(patch.targetCents);
      if (patch.savedCents !== undefined) row.saved_cents = Math.max(0, Number(patch.savedCents));
      if (patch.deadline !== undefined) row.deadline = text(patch.deadline);
      if (patch.active !== undefined) row.active = Boolean(patch.active);
      row.updated_at = nowIso(clock);
      return mapGoal(await store.update('goals', id, row));
    },

    async get(id) {
      return mapGoal(await store.findOne('goals', { id }));
    },

    async getByName(name) {
      const target = text(name);
      if (!target) return null;
      const rows = await store.findMany('goals', { active: true }, { orderBy: 'created_at', ascending: true });
      return mapGoal(rows.find((row) => String(row.name).toLowerCase() === target.toLowerCase()) || null);
    },

    async list({ includeInactive = false } = {}) {
      const rows = await store.findMany('goals', includeInactive ? {} : { active: true }, {
        orderBy: 'created_at',
        ascending: true,
      });
      return rows.map(mapGoal);
    },

    async contribute(id, amountCents) {
      const goal = await goals.get(id);
      if (!goal) throw new StoreError('Meta no encontrada');
      const amount = Number(amountCents);
      if (!Number.isSafeInteger(amount) || amount === 0) throw new StoreError('Monto de aporte invalido');
      const saved = Math.max(0, goal.savedCents + amount);
      return goals.update(id, { savedCents: saved });
    },
  };

  const settings = {
    async get(key, fallback = null) {
      const row = await store.findOne('settings', { key });
      if (!row) return fallback;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },

    async set(key, value) {
      const encoded = typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value ?? null);
      await store.upsert('settings', { key, value: encoded, updated_at: nowIso(clock) }, ['key']);
      return value;
    },

    async all() {
      const rows = await store.findMany('settings', {}, { orderBy: 'key', ascending: true });
      const output = {};
      for (const row of rows) {
        try {
          output[row.key] = JSON.parse(row.value);
        } catch {
          output[row.key] = row.value;
        }
      }
      return output;
    },
  };

  const alerts = {
    async claim(key, data = {}) {
      const row = {
        id: newId(),
        key,
        category_id: text(data.categoryId),
        threshold: data.threshold === undefined ? null : Number(data.threshold),
        period: text(data.period),
        sent_at: nowIso(clock),
        payload: data.payload || {},
      };
      try {
        await store.insert('alert_events', row);
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },

    async has(key) {
      return Boolean(await store.findOne('alert_events', { key }));
    },

    async list({ period = null, limit = 100 } = {}) {
      const where = period ? { period } : {};
      const rows = await store.findMany('alert_events', where, {
        orderBy: 'sent_at',
        ascending: false,
        limit: clampLimit(limit, 100, 500),
      });
      return rows.map((row) => ({
        id: row.id,
        key: row.key,
        categoryId: row.category_id,
        threshold: row.threshold,
        period: row.period,
        sentAt: row.sent_at,
        payload: row.payload || {},
      }));
    },
  };

  const emailLog = {
    async get(messageId) {
      if (!messageId) return null;
      const row = await store.findOne('email_log', { message_id: messageId });
      return row ? { ...row } : null;
    },

    async seen(messageId) {
      return Boolean(await emailLog.get(messageId));
    },

    async mark(record) {
      const row = {
        message_id: requiredText(record.messageId, 'messageId'),
        from_address: text(record.fromAddress),
        subject: text(record.subject),
        status: requiredText(record.status, 'status'),
        processed_at: nowIso(clock),
        transaction_id: text(record.transactionId),
        document_id: text(record.documentId),
        error: text(record.error),
      };
      await store.upsert('email_log', row, ['message_id']);
      return row;
    },
  };

  return {
    store,
    users,
    categories,
    transactions,
    documents,
    goals,
    settings,
    alerts,
    emailLog,

    async init() {
      return store.init?.();
    },

    async ping() {
      return store.ping();
    },

    async close() {
      return store.close?.();
    },
  };
}
