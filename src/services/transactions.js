import {
  EXPENSE_TYPES,
  FALLBACK_CATEGORY_NAME,
  TRANSACTION_SOURCES,
  TRANSACTION_STATUS,
  TRANSACTION_TYPES,
  TYPE_LIST,
} from '../domain.js';
import { isPositiveCents } from '../utils/money.js';
import { monthRange } from '../utils/dates.js';
import { StoreError } from '../db/rows.js';

const FALLBACK_BY_TYPE = Object.freeze({
  [TRANSACTION_TYPES.INCOME]: 'Otros ingresos',
  [TRANSACTION_TYPES.INVESTMENT]: 'Inversiones',
  [TRANSACTION_TYPES.FIXED_EXPENSE]: FALLBACK_CATEGORY_NAME,
  [TRANSACTION_TYPES.VARIABLE_EXPENSE]: FALLBACK_CATEGORY_NAME,
});

/**
 * Caso de uso central: registrar un movimiento, resolver su categoria y
 * disparar (sin bloquear) las alertas de presupuesto.
 */
export function createTransactionsService({ repos, config, alerts, logger, clock = () => new Date() }) {
  async function resolveCategory({ type, category = null, categoryId = null }) {
    if (categoryId) {
      const found = await repos.categories.get(categoryId);
      if (found) return found;
    }
    if (category && typeof category === 'object' && category.id) {
      const found = await repos.categories.get(category.id);
      if (found) return found;
    }
    if (typeof category === 'string' && category.trim()) {
      const found = await repos.categories.getByName(category.trim());
      if (found) return found;
    }
    const fallbackName = FALLBACK_BY_TYPE[type] || FALLBACK_CATEGORY_NAME;
    return repos.categories.getByName(fallbackName);
  }

  async function create({
    user = null,
    userId = null,
    type,
    amountCents,
    category = null,
    categoryId = null,
    note = '',
    source = TRANSACTION_SOURCES.TEXT,
    occurredAt = clock(),
    metadata = {},
    documentId = null,
    status = TRANSACTION_STATUS.CONFIRMED,
    currency = config.app.currency,
    skipAlerts = false,
    alertUserName = null,
  }) {
    if (!TYPE_LIST.includes(type)) {
      throw new StoreError(`Tipo de movimiento invalido: ${type}`, { code: 'INVALID_TYPE' });
    }
    if (!isPositiveCents(amountCents)) {
      throw new StoreError('El monto debe ser mayor a cero.', { code: 'INVALID_AMOUNT' });
    }
    const resolvedCategory = await resolveCategory({ type, category, categoryId });

    const transaction = await repos.transactions.create({
      userId: user?.id || userId || null,
      categoryId: resolvedCategory?.id || null,
      type,
      amountCents,
      currency,
      note,
      source,
      status,
      occurredAt,
      metadata,
      documentId,
    });

    let alertResult = { skipped: true, alerts: [] };
    if (!skipAlerts && status === TRANSACTION_STATUS.CONFIRMED) {
      try {
        alertResult = await alerts.evaluateForTransaction(transaction, {
          userName: alertUserName || user?.name || null,
        });
      } catch (error) {
        logger?.error?.('fallo la evaluacion de alertas', { transactionId: transaction.id, error });
      }
    }

    return {
      transaction,
      category: resolvedCategory,
      alerts: alertResult.alerts || [],
      alertResult,
    };
  }

  async function confirmDocument({ documentId, user, overrides = {} }) {
    const document = await repos.documents.get(documentId);
    if (!document) return { ok: false, reason: 'not-found', message: 'No encontre el documento.' };
    if (document.status !== 'pending') {
      return { ok: false, reason: 'already-processed', document, message: `El documento ya fue ${document.status === 'confirmed' ? 'confirmado' : 'descartado'}.` };
    }
    const amountCents = overrides.amountCents ?? document.totalCents;
    if (!isPositiveCents(amountCents)) {
      return { ok: false, reason: 'missing-amount', document, message: 'El documento no tiene un monto valido. Envia el monto con /corregir.' };
    }
    const categoryName = overrides.categoryName || document.extracted?.categoryName || null;
    const categoryId = overrides.categoryId || document.categoryId || null;
    const type = overrides.type || document.extracted?.type || TRANSACTION_TYPES.VARIABLE_EXPENSE;
    if (!EXPENSE_TYPES.includes(type) && type !== TRANSACTION_TYPES.INVESTMENT) {
      // Un documento de factura solo puede ser gasto o inversion
      overrides.type = TRANSACTION_TYPES.VARIABLE_EXPENSE;
    }
    const result = await create({
      user,
      type: TYPE_LIST.includes(type) ? type : TRANSACTION_TYPES.VARIABLE_EXPENSE,
      amountCents,
      category: categoryName,
      categoryId,
      note: overrides.note || [document.vendor, document.extracted?.description].filter(Boolean).join(' · '),
      source: document.source === 'email' ? TRANSACTION_SOURCES.EMAIL : TRANSACTION_SOURCES.DOCUMENT,
      occurredAt: overrides.occurredAt || document.extracted?.issuedDate || clock(),
      metadata: {
        vendor: document.vendor,
        dueDate: document.dueDate,
        documentId: document.id,
        extraction: document.extracted,
        ...(overrides.metadata || {}),
      },
      documentId: document.id,
      alertUserName: user?.name || null,
    });

    await repos.documents.update(document.id, {
      status: 'confirmed',
      categoryId: result.category?.id || null,
      totalCents: amountCents,
      userId: user?.id || document.userId,
    });

    return { ok: true, ...result, document };
  }

  async function discardDocument(documentId) {
    const document = await repos.documents.get(documentId);
    if (!document) return { ok: false, reason: 'not-found' };
    if (document.status !== 'pending') return { ok: false, reason: 'already-processed', document };
    const updated = await repos.documents.update(documentId, { status: 'discarded' });
    return { ok: true, document: updated };
  }

  /**
   * Exporta movimientos a CSV (compatible con Excel).
   */
  async function exportCsv({ monthKeyValue = null, from = null, to = null, userId = null } = {}) {
    let range = { start: from, end: to };
    if (monthKeyValue) {
      const month = monthRange(monthKeyValue, config.app.timezone);
      range = { start: month.start, end: month.end };
    }
    const [transactions, categories, users] = await Promise.all([
      repos.transactions.list({
        from: range.start ? new Date(range.start).toISOString() : null,
        to: range.end ? new Date(range.end).toISOString() : null,
        userId,
        limit: 5000,
        order: 'asc',
      }),
      repos.categories.list({ includeInactive: true }),
      repos.users.list({ includeInactive: true }),
    ]);
    const categoryMap = new Map(categories.map((category) => [category.id, category.name]));
    const userMap = new Map(users.map((user) => [user.id, user.name]));
    const header = ['fecha', 'tipo', 'categoria', 'monto', 'moneda', 'usuario', 'nota', 'fuente', 'estado'];
    const lines = [header.join(',')];
    for (const transaction of transactions) {
      const row = [
        transaction.occurredAt,
        transaction.type,
        categoryMap.get(transaction.categoryId) || FALLBACK_CATEGORY_NAME,
        (transaction.amountCents / 100).toFixed(2),
        transaction.currency,
        userMap.get(transaction.userId) || '',
        transaction.note || '',
        transaction.source,
        transaction.status,
      ];
      lines.push(row.map(csvCell).join(','));
    }
    return `\uFEFF${lines.join('\r\n')}`;
  }

  return {
    create,
    confirmDocument,
    discardDocument,
    exportCsv,
    resolveCategory,
  };
}

export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}
