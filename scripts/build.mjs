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

// Cache-busting: GitHub Pages serves assets with max-age=600, so without
// versioned URLs a fresh index.html could run stale modules for ~10 minutes.
// Every relative import, stylesheet, script and precache entry gets ?v=<build>.
const v = `?v=${build}`;
const edit = (path, fn) => writeFileSync(path, fn(readFileSync(path, 'utf8')));

for (const f of walk(join(out, 'js')).filter((p) => p.endsWith('.js'))) {
  edit(f, (src) => src.replace(/((?:import|export)\s[^'"]*?from\s+['"])(\.{1,2}\/[^'"?]+\.js)(['"])/g, `$1$2${v}$3`).replace("'__BUILD__'", `'${build}'`));
}
edit(join(out, 'sw.js'), (src) =>
  src.replace("'__BUILD__'", `'${build}'`).replace(/'(\.\/(?:js|css)\/[^']+\.(?:js|css))'/g, `'$1${v}'`),
);

const modules = walk(join(out, 'js'))
  .filter((f) => f.endsWith('.js') && !f.endsWith('theme-init.js'))
  .map((f) => relative(out, f).split(sep).join('/'))
  .sort();
const preload = modules.map((m) => `<link rel="modulepreload" href="${m}${v}">`).join('\n  ');
edit(join(out, 'index.html'), (html) =>
  html
    .replace(/((?:href|src)=")((?:js|css)\/[^"?]+\.(?:js|css))"/g, `$1$2${v}"`)
    .replace('<!--modulepreload-->', preload),
);

const bytes = files.reduce((s, f) => s + statSync(f).size, 0);
process.stdout.write(`✓ built dist/ — build ${build}, ${files.length} files, ${(bytes / 1024).toFixed(1)} KB, ${modules.length} modules preloaded\n`);
