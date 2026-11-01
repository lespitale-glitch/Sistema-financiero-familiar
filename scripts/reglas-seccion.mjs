#!/usr/bin/env node
/**
 * Mantiene la sección FINANZAS FAMILIARES de ~/Mac-reglas/REGLAS_MAC.md.
 * - Si la sección está repetida, deja una sola (solo borra copias de ESTA sección).
 * - Reemplaza esa sección por deploy/macos/REGLAS_MAC-seccion.md.
 * - No toca ninguna otra sección. Sin --aplicar solo muestra lo que haría.
 * Uso: node scripts/reglas-seccion.mjs [--aplicar] [ruta-reglas]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const apply = args.includes('--aplicar');
const rulesPath = args.find((arg) => !arg.startsWith('--')) || path.join(os.homedir(), 'Mac-reglas', 'REGLAS_MAC.md');
const here = path.dirname(fileURLToPath(import.meta.url));
const sectionPath = path.join(here, '..', 'deploy', 'macos', 'REGLAS_MAC-seccion.md');

const HEADER = /^## FINANZAS FAMILIARES\b/;
const isRule = (line) => /^={10,}\s*$/.test(line || '');

/** Bloques [inicio, fin) de la sección: desde la línea ==== previa hasta el próximo "## " de otra sección. */
export function findBlocks(lines) {
  const blocks = [];
  for (let h = 0; h < lines.length; h += 1) {
    if (!HEADER.test(lines[h])) continue;
    const start = isRule(lines[h - 1]) ? h - 1 : h;
    let end = lines.length;
    for (let j = h + 1; j < lines.length; j += 1) {
      if (/^#{1,2} /.test(lines[j])) { end = isRule(lines[j - 1]) ? j - 1 : j; break; }
    }
    while (end > start + 1 && lines[end - 1].trim() === '') end -= 1;
    blocks.push([start, end]);
    h = end - 1;
  }
  return blocks;
}

function main() {
  const original = fs.readFileSync(rulesPath, 'utf8');
  const section = fs.readFileSync(sectionPath, 'utf8').replace(/\s+$/, '').split('\n');
  const lines = original.split('\n');
  const blocks = findBlocks(lines);
  if (blocks.length === 0) {
    console.log('No encontré la sección FINANZAS FAMILIARES. No cambio nada.');
    process.exit(1);
  }
  blocks.forEach(([start, end], index) => {
    console.log(`Copia ${index + 1}: líneas ${start + 1}-${end} | empieza: "${lines[start]}" | termina: "${lines[end - 1]}" | sigue: "${lines[end] ?? '(fin del archivo)'}"`);
  });
  const result = [...lines];
  for (const [start, end] of [...blocks].reverse().slice(0, -1)) {
    let cut = end;
    while (cut < result.length && result[cut].trim() === '') cut += 1;
    result.splice(start, cut - start);
  }
  const [firstStart, firstEnd] = blocks[0];
  result.splice(firstStart, firstEnd - firstStart, ...section);
  const updated = result.join('\n');
  console.log(`Copias que se borran: ${blocks.length - 1}. Líneas: ${lines.length} -> ${result.length}.`);
  if (!apply) {
    console.log('Modo prueba: no cambié nada. Para aplicar, agregá --aplicar.');
    return;
  }
  const backup = `${rulesPath}.bak-finanzas-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(rulesPath, backup);
  fs.writeFileSync(rulesPath, updated);
  console.log(`Listo. Respaldo en ${backup}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
