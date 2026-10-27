/**
 * Verificacion rapida de sintaxis ESM de todos los .js del proyecto.
 * Uso: node scripts/check.js [--syntax-only]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'coverage']);

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) files.push(full);
  }
  return files;
}

const hasFlag = (flag) => process.argv.includes(flag);
let failures = 0;
const files = walk(root);

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    failures += 1;
    const message = String(error.stderr || error.message).split('\n')[0];
    console.error(`✗ ${path.relative(root, file)} :: ${message}`);
  }
}

if (failures > 0) {
  console.error(`Sintaxis: ${failures} archivo(s) con errores de ${files.length}`);
  process.exit(1);
}
console.log(`✓ Sintaxis OK (${files.length} archivos)`);

if (!hasFlag('--syntax-only')) {
  const missing = ['AGENTS.md', 'README.md', 'Dockerfile', 'docker-compose.yml', 'render.yaml', '.env.example', 'scripts/seed.js', 'scripts/smoke.js', 'src/index.js']
    .filter((rel) => !fs.existsSync(path.join(root, rel)));
  if (missing.length) {
    console.error(`✗ Falta(n): ${missing.join(', ')}`);
    process.exit(1);
  }
  console.log('✓ Estructura completa');
}
