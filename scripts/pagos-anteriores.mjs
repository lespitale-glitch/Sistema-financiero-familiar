#!/usr/bin/env node
/**
 * Completa el medio de pago (metadata.payment) de movimientos viejos que no lo
 * tienen: comprobantes con "Visa terminada en 1234" y avisos del banco
 * "(crédito ...)" / "(débito ...)". Sin --aplicar solo muestra lo que haría.
 * Uso: node scripts/pagos-anteriores.mjs [--aplicar] [--desde 2026-10-01]
 */
import { loadConfig } from '../src/config.js';
import { createDatabase } from '../src/db/index.js';
import { createLogger } from '../src/logger.js';
import { detectPaymentInDocument, paymentLabel, resolvePayment } from '../src/services/payment.js';

const args = process.argv.slice(2);
const apply = args.includes('--aplicar');
const sinceArg = args[args.indexOf('--desde') + 1];
const since = args.includes('--desde') && sinceArg ? new Date(`${sinceArg}T00:00:00-03:00`) : new Date(Date.now() - 62 * 86_400_000);

const logger = createLogger({ level: 'warn', name: 'pagos' });
const config = loadConfig(process.env, { loadEnvFile: true });
const repos = await createDatabase(config, { logger });

function guess(transaction) {
  const metadata = transaction.metadata || {};
  const fromDocument = detectPaymentInDocument(metadata.extraction?.rawText || '');
  if (fromDocument) return fromDocument;
  // Avisos del banco: el asunto dice "Tarjeta de Crédito VISA".
  const fromSubject = detectPaymentInDocument(metadata.email?.subject || '');
  if (fromSubject?.method) return fromSubject;
  const fromNote = /\((cr[eé]dito|d[eé]bito)/i.exec(transaction.note || '');
  if (fromNote) return { method: /cr/i.test(fromNote[1]) ? 'credit' : 'debit', brand: null, last4: null };
  return null;
}

try {
  const list = await repos.transactions.list({ from: since, limit: 5000, order: 'asc' });
  let changed = 0;
  for (const transaction of list) {
    if (transaction.metadata?.payment) continue;
    const found = guess(transaction);
    if (!found) continue;
    const payment = await resolvePayment(repos, found);
    changed += 1;
    console.log(`${transaction.occurredAt.slice(0, 10)} · ${transaction.note || ''} · ${transaction.amountCents / 100} -> ${paymentLabel(payment)}`);
    if (apply) await repos.transactions.update(transaction.id, { metadata: { ...(transaction.metadata || {}), payment } });
  }
  console.log(apply ? `Listo: ${changed} movimientos actualizados.` : `Modo prueba: ${changed} movimientos para actualizar. Agregá --aplicar para guardar.`);
} finally {
  await repos.close();
}
