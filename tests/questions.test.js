import test from 'node:test';
import assert from 'node:assert/strict';
import { detectQuestion } from '../src/bot/questions.js';

test('preguntas en lenguaje natural van al comando correcto con el mes', () => {
  assert.deepEqual(detectQuestion('bot, que gastos tuve en octubre?'), { command: 'gastos', payload: 'octubre' });
  assert.deepEqual(detectQuestion('¿Cuánto gastamos el mes pasado?'), { command: 'gastos', payload: 'mes pasado' });
  assert.deepEqual(detectQuestion('cuanto cobramos en septiembre 2026?'), { command: 'ingresos', payload: 'septiembre 2026' });
  assert.deepEqual(detectQuestion('como venimos este mes?'), { command: 'balance', payload: '' });
  assert.deepEqual(detectQuestion('qué vencimientos hay?'), { command: 'vencimientos', payload: '' });
  assert.deepEqual(detectQuestion('mostrame los últimos movimientos'), { command: 'movimientos', payload: '' });
  assert.deepEqual(detectQuestion('cuánto ahorramos?'), { command: 'inversiones', payload: '' });
});

test('los movimientos con monto no se toman como pregunta', () => {
  assert.equal(detectQuestion('gasté 15000 en el super'), null);
  assert.equal(detectQuestion('cuanto gaste? 1500 en la verdu'), null);
  assert.equal(detectQuestion('super 2500'), null);
  assert.equal(detectQuestion('hola'), null);
});
