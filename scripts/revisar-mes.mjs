#!/usr/bin/env node
/**
 * Revisión de un mes (solo lectura): lista los movimientos de la base y marca
 * inconsistencias (duplicados probables, avisos del banco sin movimiento,
 * comprobantes sin confirmar, totales que no cierran).
 * Uso: node scripts/revisar-mes.mjs [2026-11]
 */
import 'dotenv/config';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { monthKey, monthRange } from '../src/utils/dates.js';

const tz = process.env.TZ || 'America/Argentina/Buenos_Aires';
const key = process.argv[2] || monthKey(new Date(), tz);
const { start, end } = monthRange(key, tz);
const from = new Date(start).toISOString();
const to = new Date(end).toISOString();
const dbPath = path.resolve(process.env.SQLITE_PATH || './data/finanzas.sqlite');
const db = new DatabaseSync(dbPath);

const money = (cents) => `$ ${(Number(cents || 0) / 100).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const local = (iso) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month} ${p.hour}:${p.minute}`;
};
const json = (text) => { try { return JSON.parse(text || '{}') || {}; } catch { return {}; } };
const payLabel = (p) => (p ? [p.brand, { credit: 'crédito', debit: 'débito', mercadopago: 'MP', cash: 'efectivo', transfer: 'transf.' }[p.method], p.last4 ? `····${p.last4}` : null].filter(Boolean).join(' ') : '');

const rows = db.prepare(`
  SELECT t.id, t.type, t.amount_cents, t.note, t.source, t.status, t.occurred_at, t.created_at, t.metadata, t.document_id,
         c.name AS category, u.name AS user
  FROM transactions t
  LEFT JOIN categories c ON c.id = t.category_id
  LEFT JOIN users u ON u.id = t.user_id
  WHERE t.occurred_at >= ? AND t.occurred_at < ?
  ORDER BY t.occurred_at`).all(from, to);

const confirmed = rows.filter((r) => r.status === 'confirmed');
const discarded = rows.filter((r) => r.status === 'discarded');
const issues = [];

console.log(`\n=== ${key} · base ${dbPath} ===\n`);
console.log('MOVIMIENTOS CONFIRMADOS');
console.log('fecha       | id       | tipo      | monto            | categoría       | quién  | origen   | pago             | nota');
for (const r of confirmed) {
  const meta = json(r.metadata);
  console.log([
    local(r.occurred_at).padEnd(11), r.id.slice(0, 8), ({ income: 'ingreso', fixed_expense: 'fijo', variable_expense: 'variable', investment: 'inversión' }[r.type] || r.type).padEnd(9),
    money(r.amount_cents).padStart(16), String(r.category || '(sin)').padEnd(15).slice(0, 15),
    String(r.user || '-').padEnd(6).slice(0, 6), r.source.padEnd(8), payLabel(meta.payment).padEnd(16).slice(0, 16),
    String(r.note || '').slice(0, 50),
  ].join(' | '));
  if (!r.category) issues.push(`${r.id.slice(0, 8)} sin categoría (${money(r.amount_cents)} ${r.note || ''})`);
}

const sum = (type) => confirmed.filter((r) => (Array.isArray(type) ? type.includes(r.type) : r.type === type)).reduce((acc, r) => acc + r.amount_cents, 0);
const income = sum('income');
const expense = sum(['fixed_expense', 'variable_expense']);
const investment = sum('investment');
console.log(`\nTOTALES: ingresos ${money(income)} · gastos ${money(expense)} (fijos ${money(sum('fixed_expense'))}, variables ${money(sum('variable_expense'))}) · inversiones ${money(investment)} · saldo ${money(income - expense - investment)}`);
console.log(`Movimientos: ${confirmed.length} confirmados · ${discarded.length} borrados`);

if (discarded.length) {
  console.log('\nBORRADOS (no cuentan en los totales)');
  for (const r of discarded) console.log(`  ${local(r.occurred_at)} · ${r.id.slice(0, 8)} · ${money(r.amount_cents)} · ${r.note || ''}`);
}

// Duplicados probables: mismo monto el mismo día.
const byKey = new Map();
for (const r of confirmed) {
  const k = `${r.amount_cents}|${new Date(r.occurred_at).toLocaleDateString('es-AR', { timeZone: tz })}`;
  byKey.set(k, [...(byKey.get(k) || []), r]);
}
for (const group of byKey.values()) {
  if (group.length > 1) issues.push(`posible duplicado: ${group.map((r) => `${r.id.slice(0, 8)} (${r.source}, ${r.note || ''})`).join(' y ')} · ${money(group[0].amount_cents)}`);
}

// Avisos/emails procesados en el mes.
const emails = db.prepare('SELECT * FROM email_log WHERE processed_at >= ? AND processed_at < ? ORDER BY processed_at').all(from, to);
for (const e of emails) {
  if (e.status === 'logged' && e.transaction_id) {
    const t = db.prepare('SELECT status FROM transactions WHERE id = ?').get(e.transaction_id);
    if (!t) issues.push(`email "${e.subject}" figura registrado pero el movimiento no existe`);
    else if (t.status !== 'confirmed') issues.push(`email "${e.subject}" registrado, pero el movimiento está ${t.status}`);
  }
  if (['unparsed', 'error'].includes(e.status) && /macro/i.test(e.from_address || '')) {
    issues.push(`aviso del banco sin leer (${e.status}): "${e.subject}" del ${local(e.processed_at)}`);
  }
}
const bankLogged = emails.filter((e) => /macro/i.test(e.from_address || '') && e.status === 'logged').length;
console.log(`\nEmails del mes: ${emails.length} (avisos del banco registrados: ${bankLogged})`);

// Comprobantes (fotos/PDF) del mes.
const docs = db.prepare('SELECT id, vendor, total_cents, status, created_at FROM documents WHERE created_at >= ? AND created_at < ?').all(from, to);
for (const d of docs) {
  if (d.status === 'pending') issues.push(`comprobante sin confirmar: ${d.vendor || '(sin comercio)'} ${money(d.total_cents)} del ${local(d.created_at)} (no cuenta hasta tocar Confirmar)`);
  if (d.status === 'confirmed' && !db.prepare('SELECT 1 FROM transactions WHERE document_id = ?').get(d.id)) {
    issues.push(`comprobante confirmado sin movimiento: ${d.vendor || ''} ${money(d.total_cents)}`);
  }
}
console.log(`Comprobantes del mes: ${docs.length} (${docs.filter((d) => d.status === 'confirmed').length} confirmados, ${docs.filter((d) => d.status === 'pending').length} pendientes, ${docs.filter((d) => d.status === 'discarded').length} descartados)`);

// Movimientos cargados con fecha de otro mes (aparecen en otro mes).
const otherMonth = db.prepare('SELECT id, amount_cents, note, occurred_at FROM transactions WHERE created_at >= ? AND created_at < ? AND (occurred_at < ? OR occurred_at >= ?) AND status = ?').all(from, to, from, to, 'confirmed');
for (const r of otherMonth) issues.push(`cargado este mes pero con fecha ${local(r.occurred_at)} (cuenta en ese mes): ${money(r.amount_cents)} ${r.note || ''}`);

console.log(`\nREVISIÓN: ${issues.length ? `${issues.length} cosas para mirar` : 'todo cierra, sin observaciones'}`);
for (const issue of issues) console.log(`  ⚠️  ${issue}`);
console.log('');
