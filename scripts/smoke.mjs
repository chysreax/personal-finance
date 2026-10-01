// Post-deploy smoke test: fetch the live page, then every stylesheet, script,
// module preload, icon and manifest it references, plus each precached SW asset.
// Fails on any non-200 response or wrong content type. Usage: node scripts/smoke.mjs <url>
const base = process.argv[2] || 'https://chysreax.github.io/personal-finance/';
const tries = Number(process.env.SMOKE_TRIES || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
      if (res.ok) return res;
      if (i === tries - 1) return res;
    } catch (err) {
      if (i === tries - 1) throw err;
    }
    await sleep(5000); // Pages CDN may need a moment after deploy
  }
}

const failures = [];
const page = await get(base);
if (!page.ok) {
  process.stderr.write(`✗ ${base} → HTTP ${page.status}\n`);
  process.exit(1);
}
const html = await page.text();
if (!html.includes('Content-Security-Policy')) failures.push('index.html is missing its CSP meta tag');
const build = /build (\d{8}-[0-9a-f]{7})/.exec(html)?.[1];

const refs = new Set([...html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)].map((m) => m[1]).filter((u) => !/^https?:/.test(u)));
const sw = await get(new URL('sw.js', base));
if (!sw.ok) failures.push(`sw.js → HTTP ${sw.status}`);
else for (const m of (await sw.text()).matchAll(/'\.\/([^']+)'/g)) refs.add(m[1]);

const EXPECT = { '.js': /javascript/, '.css': /css/, '.svg': /svg/, '.webmanifest': /manifest|json/, '.html': /html/ };
let ok = 0;
await Promise.all(
  [...refs].map(async (ref) => {
    const url = new URL(ref, base).href;
    const res = await get(url).catch(() => null);
    if (!res || !res.ok) return failures.push(`${ref} → ${res ? `HTTP ${res.status}` : 'network error'}`);
    const ext = (ref.split('?')[0].match(/\.[a-z]+$/) || [''])[0];
    const type = res.headers.get('content-type') || '';
    if (EXPECT[ext] && !EXPECT[ext].test(type)) failures.push(`${ref} → unexpected content-type ${type}`);
    else ok++;
  }),
);

if (failures.length) {
  process.stderr.write(`✗ smoke test failed (${failures.length}):\n  ${failures.join('\n  ')}\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${base} healthy — ${ok} assets OK${build ? `, build ${build}` : ''}\n`);
