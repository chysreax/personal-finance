// Produces dist/ for GitHub Pages: copies the static app, stamps the build id
// into the service worker cache name and the app, and injects <link rel="modulepreload">
// for every module so the browser fetches the whole graph in parallel (no waterfall).
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist');
const COPY = ['index.html', '404.html', 'sw.js', 'manifest.webmanifest', 'assets', 'css', 'js', '.nojekyll'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const p of COPY) cpSync(join(root, p), join(out, p), { recursive: true });

const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk(out).filter((f) => !f.endsWith('.nojekyll'));
const hash = createHash('sha256');
for (const f of files.sort()) hash.update(relative(out, f)).update(readFileSync(f));
const sha = (process.env.GITHUB_SHA || '').slice(0, 7);
const build = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${sha || hash.digest('hex').slice(0, 7)}`;

const swPath = join(out, 'sw.js');
writeFileSync(swPath, readFileSync(swPath, 'utf8').replace("'__BUILD__'", `'${build}'`));
const mainPath = join(out, 'js', 'main.js');
writeFileSync(mainPath, readFileSync(mainPath, 'utf8').replace("'__BUILD__'", `'${build}'`));

const modules = walk(join(out, 'js'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('theme-init.js'))
  .map((f) => relative(out, f).split(sep).join('/'))
  .sort();
const preload = modules.map((m) => `<link rel="modulepreload" href="${m}">`).join('\n  ');
const htmlPath = join(out, 'index.html');
writeFileSync(htmlPath, readFileSync(htmlPath, 'utf8').replace('<!--modulepreload-->', preload));

const bytes = files.reduce((s, f) => s + statSync(f).size, 0);
process.stdout.write(`✓ built dist/ — build ${build}, ${files.length} files, ${(bytes / 1024).toFixed(1)} KB, ${modules.length} modules preloaded\n`);
