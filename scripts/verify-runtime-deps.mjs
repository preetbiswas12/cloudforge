#!/usr/bin/env node
/**
 * Fails if the built server imports a package that is not in "dependencies".
 *
 * This catches the bug that breaks production deploys but never local dev:
 * putting a runtime import (pino, express, ...) in devDependencies. Everything
 * works on a laptop — devDeps are installed — and then the container runs
 * `npm ci --omit=dev`, strips it, and the server dies at startup with
 * ERR_MODULE_NOT_FOUND.
 *
 *   node scripts/verify-runtime-deps.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const serverDir = join(root, 'server');
const distDir = join(serverDir, 'dist');

const pkg = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));
const devDeclared = new Set(Object.keys(pkg.devDependencies ?? {}));
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Bare specifier -> package name (handles @scope/name/sub/path). */
function packageNameOf(specifier) {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function* walkFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkFiles(full);
    else if (full.endsWith('.js')) yield full;
  }
}

if (!existsSync(distDir)) {
  console.error(`✗ ${distDir} not found. Run \`npm run build\` first.`);
  process.exit(1);
}

const IMPORT_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // import ... from 'x'
  /\bimport\s+['"]([^'"]+)['"]/g, // import 'x'
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // require('x')
];

const found = new Map(); // package name -> example file

for (const file of walkFiles(distDir)) {
  // Compiled test files are typechecked but never loaded at runtime, so their
  // imports (vitest) correctly live in devDependencies.
  if (/\.test\.js$/.test(file)) continue;

  const source = readFileSync(file, 'utf8');
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (!specifier) continue;
      // Relative paths, absolute URLs and Node builtins are not packages.
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes('://')) continue;
      if (specifiedIsBuiltin(specifier)) continue;

      const name = packageNameOf(specifier);
      if (!found.has(name)) found.set(name, file.replace(root + '\\', ''));
    }
  }
}

function specifiedIsBuiltin(specifier) {
  if (builtins.has(specifier)) return true;
  return builtins.has(specifier.replace(/^node:/, ''));
}

const missing = [...found.keys()].filter((name) => !declared.has(name)).sort();

if (missing.length === 0) {
  console.log(`✓ All ${found.size} runtime imports are declared in server/package.json dependencies.`);
  process.exit(0);
}

console.error(`✗ ${missing.length} runtime import(s) missing from "dependencies":\n`);
for (const name of missing) {
  const file = found.get(name);
  const where = devDeclared.has(name) ? 'it is in devDependencies — move it' : 'not declared at all';
  console.error(`  ${name.padEnd(20)} imported by ${file}`);
  console.error(`  ${''.padEnd(20)} → ${where}\n`);
}
console.error('A package listed in devDependencies is NOT installed by `npm ci --omit=dev`,');
console.error('which is what the production Docker image runs.');
process.exit(1);