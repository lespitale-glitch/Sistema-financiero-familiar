/**
 * Utilidades de formato para mensajes de Telegram con parse_mode HTML.
 * Telegram solo admite un subconjunto de HTML: <b>, <i>, <u>, <s>, <code>,
 * <pre>, <a href>. Todo texto dinamico debe pasar por escapeHtml.
 */

export function escapeHtml(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function bold(input) {
  return `<b>${escapeHtml(input)}</b>`;
}

export function italic(input) {
  return `<i>${escapeHtml(input)}</i>`;
}

export function code(input) {
  return `<code>${escapeHtml(input)}</code>`;
}

export function pre(input) {
  return `<pre>${escapeHtml(input)}</pre>`;
}

export function link(label, url) {
  const safeUrl = String(url || '').replace(/"/g, '%22');
  return `<a href="${safeUrl}">${escapeHtml(label)}</a>`;
}

/** Limita la longitud por seguridad (Telegram: 4096 caracteres). */
export function clampMessage(text, max = 3900) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Divide un mensaje respetando saltos de linea. Pensado para reportes con
 * lineas HTML balanceadas; no corta etiquetas a la mitad.
 */
export function splitMessage(text, max = 3900) {
  const value = String(text ?? '');
  if (value.length <= max) return [value];
  const chunks = [];
  let current = '';
  for (const line of value.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      if (line.length <= max) {
        current = line;
      } else {
        chunks.push(line.slice(0, max));
        current = line.slice(max);
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Barra de progreso textual: [██████░░░░] 60% */
export function progressBar(percent, size = 10) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  const filled = Math.round((clamped / 100) * size);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, size - filled))}`;
}

/** Formatea una lista con vinetas seguras. */
export function bulletList(lines) {
  return lines.filter(Boolean).map((line) => `• ${line}`).join('\n');
}
