/**
 * Preguntas en lenguaje natural ("¿qué gastos tuve en octubre?") que se
 * responden con un comando existente en vez de registrarse como movimiento.
 */

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
  'septiembre', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

function normalize(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Señales de pregunta: signo "?" o un arranque tipico de consulta. */
const QUESTION_START = /^(?:bot[,:]?\s+)?(?:que|cuanto|cuanta|cuantos|cuantas|cuales|cual|como|donde|en que|mostrame|mostra|decime|dame|pasame|quiero ver|ver|listame|resumen)\b/;

/** Orden importa: lo mas especifico primero. */
const TOPICS = [
  { command: 'vencimientos', pattern: /\bvenc|\bque (?:tengo|hay) que pagar|\bpor pagar\b|\bfacturas? pendientes?\b/ },
  { command: 'presupuesto', pattern: /\bpresupuesto/ },
  { command: 'movimientos', pattern: /\bmovimientos?\b|\bultimos?\b|\bultimas?\b/ },
  { command: 'inversiones', pattern: /\binver|\bahorr/ },
  { command: 'ingresos', pattern: /\bingres|\bcobr|\bgane\b|\bganamos\b|\bentr(?:o|aron)\b/ },
  { command: 'gastos', pattern: /\bgast|\bcompr|\bpague\b|\bpagamos\b|\bse fue\b/ },
  { command: 'balance', pattern: /\bbalance\b|\bresumen\b|\bsaldo\b|\bcomo (?:vamos|venimos|estamos)\b|\bcuanto (?:queda|nos queda|me queda)\b/ },
];

/** "octubre", "octubre 2026", "mes pasado", "este mes" -> texto para resolveMonthKey. */
export function extractMonthText(text) {
  const raw = normalize(text);
  if (/\bmes pasado\b|\bmes anterior\b|\bultimo mes\b/.test(raw)) return 'mes pasado';
  if (/\beste mes\b|\bmes actual\b/.test(raw)) return '';
  const month = MONTHS.find((name) => new RegExp(`\\b${name}\\b`).test(raw));
  if (!month) return '';
  const year = /\b(20\d{2})\b/.exec(raw);
  const name = month === 'setiembre' ? 'septiembre' : month;
  return year ? `${name} ${year[1]}` : name;
}

/**
 * @returns {null | {command: string, payload: string}}
 * Solo devuelve algo si el texto es una pregunta y no trae un monto (salvo el año).
 */
export function detectQuestion(text) {
  const raw = normalize(text).trim();
  if (!raw) return null;
  const isQuestion = raw.includes('?') || raw.includes('¿') || QUESTION_START.test(raw);
  if (!isQuestion) return null;
  const withoutYears = raw.replace(/\b20\d{2}\b/g, '');
  if (/\d/.test(withoutYears)) return null;
  const topic = TOPICS.find((entry) => entry.pattern.test(raw));
  if (!topic) return null;
  const monthText = ['gastos', 'ingresos', 'balance', 'presupuesto'].includes(topic.command)
    ? extractMonthText(raw)
    : '';
  return { command: topic.command, payload: monthText };
}
