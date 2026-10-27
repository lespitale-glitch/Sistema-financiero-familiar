/**
 * Definicion y registro de comandos del bot.
 *
 * Los comandos se registran antes que los handlers de texto libre para que
 * Telegraf resuelva primero los comandos conocidos y el handler de texto solo
 * reciba lo que no matchea (incluidos comandos desconocidos).
 */

import {
  handleAlertsCheck,
  handleBalance,
  handleBills,
  handleNewBill,
  handlePaid,
  handleBudget,
  handleCategories,
  handleContribute,
  handleCorrect,
  handleDelete,
  handleExpenseCommand,
  handleExpenses,
  handleExport,
  handleGoals,
  handleHelp,
  handleId,
  handleIncome,
  handleIncomeCommand,
  handleInvestments,
  handleInvestmentCommand,
  handleNewCategory,
  handleNewGoal,
  handleRecent,
  handleReport,
  handleSetBudget,
  handleStart,
} from './handlers.js';

/** Lista usada por setMyCommands (Telegram limita a 100 comandos). */
export const COMMANDS = Object.freeze([
  { command: 'start', description: 'Iniciar y ver ejemplos' },
  { command: 'ayuda', description: 'Ayuda y lista de comandos' },
  { command: 'balance', description: 'Balance del mes' },
  { command: 'presupuesto', description: 'Estado de presupuestos' },
  { command: 'gastos', description: 'Detalle de gastos del mes' },
  { command: 'ingresos', description: 'Detalle de ingresos del mes' },
  { command: 'inversiones', description: 'Inversiones y ahorro' },
  { command: 'gasto', description: 'Registrar un gasto' },
  { command: 'ingreso', description: 'Registrar un ingreso' },
  { command: 'inversion', description: 'Registrar una inversion' },
  { command: 'movimientos', description: 'Ultimos movimientos' },
  { command: 'borrar', description: 'Borrar un movimiento cargado por error' },
  { command: 'categorias', description: 'Listar categorias' },
  { command: 'nueva_categoria', description: 'Crear una categoria' },
  { command: 'presupuesto_set', description: 'Ajustar un presupuesto' },
  { command: 'metas', description: 'Metas de ahorro' },
  { command: 'meta', description: 'Crear una meta de ahorro' },
  { command: 'aportar', description: 'Aportar a una meta' },
  { command: 'vencimientos', description: 'Vencimientos a pagar' },
  { command: 'vence', description: 'Agendar un vencimiento' },
  { command: 'pagado', description: 'Marcar un vencimiento como pagado' },
  { command: 'corregir', description: 'Corregir factura pendiente' },
  { command: 'reporte', description: 'Reporte mensual completo' },
  { command: 'exportar', description: 'Exportar movimientos a CSV' },
  { command: 'alertas', description: 'Evaluar alertas del mes' },
  { command: 'id', description: 'Ver tus datos de Telegram' },
]);

/**
 * Registra todos los comandos en la instancia de Telegraf.
 * @param {import('telegraf').Telegraf} bot
 * @param {object} deps
 */
export function registerCommands(bot, deps) {
  const bind = (handler) => (ctx) => handler(ctx, deps);

  bot.start(bind(handleStart));
  bot.help(bind(handleHelp));

  const handlers = {
    ayuda: handleHelp,
    id: handleId,
    balance: handleBalance,
    presupuesto: handleBudget,
    gastos: handleExpenses,
    ingresos: handleIncome,
    inversiones: handleInvestments,
    metas: handleGoals,
    nueva_categoria: handleNewCategory,
    presupuesto_set: handleSetBudget,
    meta: handleNewGoal,
    aportar: handleContribute,
    gasto: handleExpenseCommand,
    ingreso: handleIncomeCommand,
    inversion: handleInvestmentCommand,
    movimientos: handleRecent,
    borrar: handleDelete,
    categorias: handleCategories,
    corregir: handleCorrect,
    vencimientos: handleBills,
    vence: handleNewBill,
    pagado: handlePaid,
    reporte: handleReport,
    exportar: handleExport,
    alertas: handleAlertsCheck,
  };

  for (const [command, handler] of Object.entries(handlers)) {
    bot.command(command, bind(handler));
  }

  return bot;
}
