/**
 * Constantes de dominio compartidas por bot, servicios y API.
 * No importar nada de la capa de persistencia aca.
 */

export const TRANSACTION_TYPES = Object.freeze({
  INCOME: 'income',
  FIXED_EXPENSE: 'fixed_expense',
  VARIABLE_EXPENSE: 'variable_expense',
  INVESTMENT: 'investment',
});

export const TYPE_LIST = Object.freeze(Object.values(TRANSACTION_TYPES));

export const TYPE_META = Object.freeze({
  income: { label: 'Ingreso', emoji: '💰', sign: '+' },
  fixed_expense: { label: 'Gasto fijo', emoji: '📌', sign: '-' },
  variable_expense: { label: 'Gasto variable', emoji: '🛒', sign: '-' },
  investment: { label: 'Inversion', emoji: '📈', sign: '-' },
});

export const EXPENSE_TYPES = Object.freeze([
  TRANSACTION_TYPES.FIXED_EXPENSE,
  TRANSACTION_TYPES.VARIABLE_EXPENSE,
]);

export const TRANSACTION_SOURCES = Object.freeze({
  TEXT: 'text',
  VOICE: 'voice',
  DOCUMENT: 'document',
  EMAIL: 'email',
  API: 'api',
  IMPORT: 'import',
});

export const TRANSACTION_STATUS = Object.freeze({
  CONFIRMED: 'confirmed',
  PENDING: 'pending',
  DISCARDED: 'discarded',
});

export const ROLES = Object.freeze({
  HUSBAND: 'husband',
  WIFE: 'wife',
  DAUGHTER: 'daughter',
  SON: 'son',
  OTHER: 'other',
});

export const ROLE_LABELS = Object.freeze({
  husband: 'Esposo',
  wife: 'Esposa',
  daughter: 'Hija',
  son: 'Hijo',
  other: 'Familiar',
});

/**
 * Categorias iniciales. `budget` es el limite mensual por defecto en unidades
 * de moneda (se convierte a centavos al sembrar). Se pueden editar o agregar
 * libremente desde el bot.
 */
export const DEFAULT_CATEGORIES = Object.freeze([
  { name: 'Supermercado', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '🛒', budget: 350000, keywords: ['super', 'supermercado', 'almacen', 'compras', 'mercado', 'dia', 'carrefour', 'coto', 'jumbo'] },
  { name: 'Comida', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '🍔', budget: 120000, keywords: ['comida', 'restaurante', 'delivery', 'pedidos', 'rappi', 'mcdonald', 'pizza', 'cafe', 'bar', 'almuerzo', 'cena'] },
  { name: 'Transporte', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '🚗', budget: 100000, keywords: ['nafta', 'combustible', 'transporte', 'uber', 'cabify', 'taxi', 'sube', 'colectivo', 'tren', 'peaje', 'estacionamiento'] },
  { name: 'Servicios', type: TRANSACTION_TYPES.FIXED_EXPENSE, emoji: '💡', budget: 90000, keywords: ['luz', 'gas', 'agua', 'internet', 'telefonia', 'celular', 'edenor', 'edesur', 'metrogas', 'aysa', 'cable', 'wifi'] },
  { name: 'Alquiler', type: TRANSACTION_TYPES.FIXED_EXPENSE, emoji: '🏠', budget: 500000, keywords: ['alquiler', 'expensas', 'hipoteca', 'renta', 'inmobiliaria'] },
  { name: 'Salud', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '💊', budget: 80000, keywords: ['salud', 'medico', 'farmacia', 'obra social', 'prepaga', 'remedio', 'dentista', 'consultorio'] },
  { name: 'Educacion', type: TRANSACTION_TYPES.FIXED_EXPENSE, emoji: '🎓', budget: 150000, keywords: ['educacion', 'colegio', 'escuela', 'universidad', 'curso', 'matricula', 'cuota', 'utiles', 'libros'] },
  { name: 'Entretenimiento', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '🎬', budget: 70000, keywords: ['entretenimiento', 'cine', 'netflix', 'spotify', 'disney', 'juego', 'salida', 'teatro', 'viaje', 'vacaciones'] },
  { name: 'Hogar', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '🪑', budget: 60000, keywords: ['hogar', 'mueble', 'ferreteria', 'limpieza', 'decoracion', 'electrodomestico', 'sodimac', 'easy'] },
  { name: 'Sueldo', type: TRANSACTION_TYPES.INCOME, emoji: '💼', budget: null, keywords: ['sueldo', 'salario', 'nomina', 'haberes', 'jornal'] },
  { name: 'Freelance', type: TRANSACTION_TYPES.INCOME, emoji: '💻', budget: null, keywords: ['freelance', 'honorarios', 'cliente', 'proyecto', 'consultoria'] },
  { name: 'Otros ingresos', type: TRANSACTION_TYPES.INCOME, emoji: '🎁', budget: null, keywords: ['ingreso', 'venta', 'regalo', 'devolucion', 'reintegro', 'extra'] },
  { name: 'Ahorro', type: TRANSACTION_TYPES.INVESTMENT, emoji: '🏦', budget: null, keywords: ['ahorro', 'caja', 'reserva', 'emergencia'] },
  { name: 'Inversiones', type: TRANSACTION_TYPES.INVESTMENT, emoji: '📈', budget: null, keywords: ['inversion', 'invertir', 'plazo fijo', 'fci', 'acciones', 'cedears', 'cripto', 'bitcoin', 'dolar', 'bono'] },
  { name: 'Otros', type: TRANSACTION_TYPES.VARIABLE_EXPENSE, emoji: '📦', budget: null, keywords: ['otro', 'otros', 'varios', 'misc'] },
]);

/** Categoria de fallback cuando el texto no permite inferir una. */
export const FALLBACK_CATEGORY_NAME = 'Otros';

/** Palabras que indican tipo de movimiento (se evaluan con prioridad). */
export const TYPE_KEYWORDS = Object.freeze({
  investment: ['inverti', 'inversion', 'invertir', 'plazo fijo', 'fci', 'acciones', 'cedears', 'cripto', 'bitcoin', 'ahorro', 'reserve', 'aporte'],
  income: ['cobre', 'cobro', 'ingreso', 'ingrese', 'sueldo', 'salario', 'me pagaron', 'entraron', 'venta', 'devolucion', 'reintegro', 'honorarios'],
  fixed_expense: ['alquiler', 'expensas', 'servicio', 'luz', 'gas', 'agua', 'internet', 'colegio', 'cuota', 'prepaga', 'suscripcion'],
  variable_expense: ['gaste', 'gasto', 'pague', 'compre', 'compra', 'salio', 'gastamos'],
});

export const TELEGRAM_MAX_MESSAGE = 4096;
export const TELEGRAM_SAFE_MESSAGE = 3900;

export const MONTH_NAMES_ES = Object.freeze([
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
]);

export const WEEKDAY_NAMES_ES = Object.freeze([
  'domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado',
]);
