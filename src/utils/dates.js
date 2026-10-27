/**
 * Utilidades de fecha/hora con soporte de zona horaria IANA sin dependencias.
 * Las fechas se persisten como ISO-8601 UTC (lexicograficamente ordenables).
 */

import { MONTH_NAMES_ES, WEEKDAY_NAMES_ES } from '../domain.js';

const MONTH_REGEX = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function pad2(value) {
  return String(value).padStart(2, '0');
}

export function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string' && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function toIso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function timeZoneFormatter(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
  } catch {
    return timeZoneFormatter('UTC');
  }
}

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Partes de fecha/hora en la zona indicada. */
export function localParts(value, timeZone = 'UTC') {
  const date = toDate(value) || new Date();
  const parts = Object.fromEntries(
    timeZoneFormatter(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
  };
}

/** Desfase de la zona respecto de UTC en milisegundos para un instante dado. */
export function timeZoneOffsetMs(value, timeZone = 'UTC') {
  const date = toDate(value) || new Date();
  const parts = localParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const instant = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - instant;
}

/** Convierte una fecha/hora local de la zona indicada al instante UTC. */
export function zonedTimeToUtc(year, month, day, hour = 0, minute = 0, second = 0, timeZone = 'UTC') {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = guess - timeZoneOffsetMs(new Date(guess), timeZone);
  // Segunda pasada para resolver cambios de horario de verano
  timestamp = guess - timeZoneOffsetMs(new Date(timestamp), timeZone);
  return new Date(timestamp);
}

/** Clave de mes 'YYYY-MM' para un instante en una zona. */
export function monthKey(value = new Date(), timeZone = 'UTC') {
  const parts = localParts(value, timeZone);
  return `${parts.year}-${pad2(parts.month)}`;
}

export function currentMonthKey(now = new Date(), timeZone = 'UTC') {
  return monthKey(now, timeZone);
}

export function isValidMonthKey(value) {
  return typeof value === 'string' && MONTH_REGEX.test(value);
}

export function addMonths(key, delta) {
  const [year, month] = key.split('-').map(Number);
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = ((total % 12) + 12) % 12;
  return `${nextYear}-${pad2(nextMonth + 1)}`;
}

export function previousMonthKey(key) {
  return addMonths(key, -1);
}

export function nextMonthKey(key) {
  return addMonths(key, 1);
}

export function monthLabel(key) {
  if (!isValidMonthKey(key)) return key || '';
  const [year, month] = key.split('-').map(Number);
  const name = MONTH_NAMES_ES[month - 1] || '';
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${year}`;
}

export function monthShortLabel(key) {
  if (!isValidMonthKey(key)) return key || '';
  const [year, month] = key.split('-').map(Number);
  return `${MONTH_NAMES_ES[month - 1]?.slice(0, 3) || ''} ${year}`;
}

export function daysInMonth(key) {
  const [year, month] = key.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Rango [inicio, fin) de un mes en UTC para consultar la base.
 */
export function monthRange(key, timeZone = 'UTC') {
  if (!isValidMonthKey(key)) throw new Error(`Mes invalido: ${key}`);
  const [year, month] = key.split('-').map(Number);
  const start = zonedTimeToUtc(year, month, 1, 0, 0, 0, timeZone);
  const nextKey = addMonths(key, 1);
  const [nextYear, nextMonth] = nextKey.split('-').map(Number);
  const end = zonedTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, timeZone);
  return {
    key,
    start,
    end,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    days: daysInMonth(key),
    label: monthLabel(key),
  };
}

/**
 * Rango de los ultimos N dias incluyendo hoy (en la zona), como instantes UTC.
 */
export function lastDaysRange(days = 7, now = new Date(), timeZone = 'UTC') {
  const parts = localParts(now, timeZone);
  const end = zonedTimeToUtc(parts.year, parts.month, parts.day + 1, 0, 0, 0, timeZone);
  const start = zonedTimeToUtc(parts.year, parts.month, parts.day - (days - 1), 0, 0, 0, timeZone);
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString(), days };
}

/**
 * Semana actual (lunes a domingo) en la zona indicada.
 */
export function weekRange(now = new Date(), timeZone = 'UTC') {
  const parts = localParts(now, timeZone);
  const daysSinceMonday = (parts.weekday + 6) % 7;
  const start = zonedTimeToUtc(parts.year, parts.month, parts.day - daysSinceMonday, 0, 0, 0, timeZone);
  const end = zonedTimeToUtc(parts.year, parts.month, parts.day - daysSinceMonday + 7, 0, 0, 0, timeZone);
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Formatea una fecha como DD/MM/YYYY en la zona indicada. */
export function formatDate(value, timeZone = 'UTC', { withTime = false } = {}) {
  const date = toDate(value);
  if (!date) return '';
  const parts = localParts(date, timeZone);
  const base = `${pad2(parts.day)}/${pad2(parts.month)}/${parts.year}`;
  return withTime ? `${base} ${pad2(parts.hour)}:${pad2(parts.minute)}` : base;
}

/** Formatea una fecha larga: "sabado 24 de octubre de 2026". */
export function formatDateLong(value, timeZone = 'UTC') {
  const date = toDate(value);
  if (!date) return '';
  const parts = localParts(date, timeZone);
  return `${WEEKDAY_NAMES_ES[parts.weekday]} ${parts.day} de ${MONTH_NAMES_ES[parts.month - 1]} de ${parts.year}`;
}

/** Hora local HH:MM. */
export function formatTime(value, timeZone = 'UTC') {
  const date = toDate(value);
  if (!date) return '';
  const parts = localParts(date, timeZone);
  return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

/** Minutos desde medianoche en la zona. */
export function minutesSinceMidnight(value, timeZone = 'UTC') {
  const parts = localParts(value, timeZone);
  return parts.hour * 60 + parts.minute;
}

export function parseTimeOfDay(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Resuelve un mes a partir de lenguaje natural o 'YYYY-MM'.
 * Acepta: "actual", "este mes", "mes pasado", "anterior", "octubre",
 * "octubre 2025", "2026-03", "03/2026". Devuelve 'YYYY-MM' o null.
 */
export function resolveMonthKey(input, now = new Date(), timeZone = 'UTC') {
  const current = monthKey(now, timeZone);
  if (input === null || input === undefined || input === '') return current;
  if (input instanceof Date) return monthKey(input, timeZone);
  const raw = String(input).trim().toLowerCase();
  if (!raw) return current;
  if (isValidMonthKey(raw)) return raw;
  if (['actual', 'este mes', 'mes actual', 'hoy', 'current'].includes(raw)) return current;
  if (['pasado', 'mes pasado', 'anterior', 'ultimo mes', 'último mes', 'last'].includes(raw)) {
    return previousMonthKey(current);
  }
  if (raw === 'proximo' || raw === 'próximo' || raw === 'mes proximo' || raw === 'mes próximo') {
    return nextMonthKey(current);
  }
  const slash = /^(\d{1,2})\/(\d{4})$/.exec(raw);
  if (slash) return `${slash[2]}-${pad2(Number(slash[1]))}`;
  const yearOnly = /^(\d{4})$/.exec(raw);
  if (yearOnly) return `${yearOnly[1]}-${pad2(localParts(now, timeZone).month)}`;

  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const monthIndex = MONTH_NAMES_ES.findIndex((name) => normalized.includes(name));
  if (monthIndex >= 0) {
    const yearMatch = /(\d{4})/.exec(raw);
    const [currentYear] = current.split('-').map(Number);
    return `${yearMatch ? Number(yearMatch[1]) : currentYear}-${pad2(monthIndex + 1)}`;
  }
  return null;
}

/**
 * Interpreta fechas de vencimiento de documentos: 2026-10-24, 24/10/2026,
 * 24-10-26, 24 de octubre de 2026, "octubre 2026". Devuelve 'YYYY-MM-DD'.
 */
export function parseHumanDate(input, { defaultYear, timeZone = 'UTC', now = new Date() } = {}) {
  if (!input) return null;
  if (input instanceof Date) {
    const parts = localParts(input, timeZone);
    return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  }
  const raw = String(input).trim();
  if (!raw) return null;

  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw);
  if (match) {
    const [, y, m, d] = match;
    return validYmd(Number(y), Number(m), Number(d));
  }

  match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(raw);
  if (match) {
    const [, d, m, rawYear] = match;
    const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return validYmd(year, Number(m), Number(d));
  }

  match = /^(\d{1,2})[/.-](\d{1,2})$/.exec(raw);
  if (match) {
    const year = defaultYear || localParts(now, timeZone).year;
    return validYmd(year, Number(match[2]), Number(match[1]));
  }

  const normalized = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  match = /(\d{1,2})\s*(?:de\s*)?([a-z]+)(?:\s*(?:de\s*)?(\d{4}))?/.exec(normalized);
  if (match) {
    const day = Number(match[1]);
    const monthIndex = MONTH_NAMES_ES.findIndex((name) => name.startsWith(match[2].slice(0, 3)));
    if (monthIndex >= 0) {
      const year = match[3] ? Number(match[3]) : (defaultYear || localParts(now, timeZone).year);
      return validYmd(year, monthIndex + 1, day);
    }
  }

  const isoLike = /^(\d{4})[/](\d{1,2})[/](\d{1,2})$/.exec(raw);
  if (isoLike) {
    return validYmd(Number(isoLike[1]), Number(isoLike[2]), Number(isoLike[3]));
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const parts = localParts(parsed, timeZone);
    return validYmd(parts.year, parts.month, parts.day);
  }
  return null;
}

function validYmd(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1970 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Rango UTC de un dia local 'YYYY-MM-DD'. */
export function dayRange(dateKey, timeZone = 'UTC') {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const start = zonedTimeToUtc(y, m, d, 0, 0, 0, timeZone);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end, startIso: start.toISOString(), endIso: end.toISOString() };
}

/** true si el instante cae en el mes local indicado. */
export function isInMonth(value, key, timeZone = 'UTC') {
  return monthKey(value, timeZone) === key;
}

export function weekdayName(index) {
  return WEEKDAY_NAMES_ES[index] || '';
}
