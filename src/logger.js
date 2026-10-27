/**
 * Logger estructurado sin dependencias. Salida JSON por linea para que
 * Render/Docker/systemd puedan indexarla. Nunca imprime secretos.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const SECRET_KEYS = /(token|secret|password|apikey|api_key|authorization|service_role)/i;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redact(item, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.test(key)) {
        output[key] = item ? '[redacted]' : item;
      } else if (key === 'buffer') {
        output[key] = '[binary]';
      } else {
        output[key] = redact(item, depth + 1);
      }
    }
    return output;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…`;
  return value;
}

function normalizeLevel(level) {
  return LEVELS[level] !== undefined ? level : 'info';
}

/**
 * @param {{level?: string, name?: string, bindings?: object, sink?: (line: string, level: string, data: object) => void}} options
 */
export function createLogger({ level = 'info', name = 'app', bindings = {}, sink } = {}) {
  let currentLevel = normalizeLevel(level);
  const base = { service: name, ...bindings };

  function emit(levelName, message, meta = {}) {
    if (LEVELS[levelName] < LEVELS[currentLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level: levelName,
      msg: typeof message === 'string' ? message : undefined,
      ...redact(base),
      ...redact(meta),
    };
    if (typeof message !== 'string') entry.detail = redact(message);
    const line = JSON.stringify(entry);
    if (sink) {
      try {
        sink(line, levelName, entry);
      } catch {
        // un sink roto nunca debe tumbar la app
      }
      return;
    }
    const stream = levelName === 'error' || levelName === 'warn' ? process.stderr : process.stdout;
    stream.write(`${line}\n`);
  }

  return {
    get level() {
      return currentLevel;
    },
    setLevel(next) {
      currentLevel = normalizeLevel(next);
    },
    debug: (message, meta) => emit('debug', message, meta),
    info: (message, meta) => emit('info', message, meta),
    warn: (message, meta) => emit('warn', message, meta),
    error: (message, meta) => emit('error', message, meta),
    child(extra = {}) {
      return createLogger({ level: currentLevel, name, bindings: { ...bindings, ...extra }, sink });
    },
  };
}

export const logger = createLogger({ level: process.env.LOG_LEVEL || 'info', name: 'finanzas' });
