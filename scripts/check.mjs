// Static integrity & security lint (runs in CI before deploy):
//  • every relative ES-module import resolves to a real file
//  • every service-worker precache entry exists, and every app JS file is precached
//  • no HTML sinks (innerHTML/outerHTML/insertAdjacentHTML/document.write/eval/new Function)
//  • no console.* calls (zero-trace: nothing — especially tokens — is ever logged)
//  • index.html carries a CSP meta tag with the required directives
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const jsFiles = walk(join(root, 'js')).filter((f) => f.endsWith('.js'));
const SINKS = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\(/;
const CONSOLE = /\bconsole\.(log|info|warn|error|debug|trace|table)\s*\(/;

for (const file of jsFiles) {
  const src = readFileSync(file, 'utf8');
  const rel = relative(root, file);
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"](\.[^'"]+)['"]/g)) {
    const target = resolve(dirname(file), m[1]);
    if (!existsSync(target)) problems.push(`${rel}: unresolved import ${m[1]}`);
  }
  src.split('\n').forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '');
    if (SINKS.test(code)) problems.push(`${rel}:${i + 1}: forbidden HTML/eval sink`);
    if (CONSOLE.test(code)) problems.push(`${rel}:${i + 1}: console call (zero-trace policy)`);
  });
}

const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
for (const p of shell) if (!existsSync(join(root, p))) problems.push(`sw.js: precache entry missing on disk: ${p}`);
for (const f of jsFiles) {
  const rel = relative(root, f).split(sep).join('/');
  if (!shell.includes(rel)) problems.push(`sw.js: ${rel} is not precached`);
}

const html = readFileSync(join(root, 'index.html'), 'utf8');
const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
for (const d of ["default-src 'none'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "require-trusted-types-for 'script'", 'connect-src']) {
  if (!csp.includes(d)) problems.push(`index.html: CSP missing "${d}"`);
}
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) problems.push('index.html: inline <script> found');
if (/\sstyle="/.test(html)) problems.push('index.html: inline style attribute found');

if (problems.length) {
  process.stderr.write(`✗ ${problems.length} problem(s):\n  ${problems.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write(`✓ check passed — ${jsFiles.length} modules, ${shell.length} precached assets, CSP ok, no sinks, no console calls\n`);
