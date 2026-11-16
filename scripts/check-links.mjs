// Link check over the built site (dist/): every internal link must reach a page or file, and every #anchor must
// exist on its page. With --external, external links are fetched too (GitHub links into the private main repo
// answer 404 until it is public, so those are reported separately).
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const external = process.argv.includes('--external');
const files = [];
(function walk(d) { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else if (p.endsWith('.html')) files.push(p); } })(DIST);

const ids = new Map();
const pageOf = (url) => {
  let p = decodeURIComponent(url.split('#')[0].split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(DIST, p);
  if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  if (fs.existsSync(f + '/index.html')) return f + '/index.html';
  if (fs.existsSync(f + '.html')) return f + '.html';
  return null;
};
const idsOf = (f) => {
  if (!ids.has(f)) ids.set(f, new Set([...fs.readFileSync(f, 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  return ids.get(f);
};

const broken = [], ext = new Map();
let count = 0;
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const rel = path.relative(DIST, f).replace(/\\/g, '/');
  const here = '/' + (rel.endsWith('index.html') ? rel.replace(/index\.html$/, '') : path.posix.dirname(rel).replace(/^\.$/, '') );
  const is404 = rel === '404.html';
  for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const raw = m[1].replace(/&amp;/g, '&');
    if (/^(mailto:|data:|javascript:)/.test(raw)) continue;
    count++;
    if (/^https?:\/\//.test(raw)) {
      if (raw.startsWith('https://meritorder.dev/')) { /* canonical, sitemap: checked as internal below */ } else { ext.set(raw, [...(ext.get(raw) || []), here]); continue; }
    }
    if (is404 && raw === 'https://meritorder.dev/404/') continue; // its canonical URL; GitHub Pages serves 404.html
    const url = raw.startsWith('https://meritorder.dev/') ? raw.slice('https://meritorder.dev'.length) : raw.startsWith('/') ? raw : path.posix.join(here, raw);
    const [p, hash] = url.split('#');
    const target = (p && !(is404 && !raw.startsWith('/') && raw.startsWith('#'))) ? pageOf(p) : f;
    if (!target) { broken.push(`${here}: ${raw} (no such page)`); continue; }
    if (hash && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(hash))) broken.push(`${here}: ${raw} (no #${hash} there)`);
  }
}

let extBroken = [], privateRepo = [];
if (external) {
  const urls = [...ext.keys()];
  await Promise.all(Array.from({ length: 8 }, async (_, w) => {
    for (let i = w; i < urls.length; i += 8) {
      const u = urls[i];
      try {
        let r = await fetch(u, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (r.status === 405 || r.status === 403) r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
        if (r.status >= 400) (u.includes('github.com/Merit-Order/meritorder') ? privateRepo : extBroken).push(`${r.status} ${u} (from ${ext.get(u)[0]})`);
      } catch (e) { (u.includes('dev.meritorder.dev') ? privateRepo : extBroken).push(`ERR ${u}: ${e.cause?.code || e.message} (from ${ext.get(u)[0]})`); }
    }
  }));
}

console.log(`${files.length} pages, ${count} links, ${ext.size} distinct external.`);
if (broken.length) console.log(`\nBroken internal links (${broken.length}):\n` + broken.join('\n'));
if (external) {
  if (extBroken.length) console.log(`\nBroken external links (${extBroken.length}):\n` + extBroken.join('\n'));
  if (privateRepo.length) console.log(`\nNot reachable until go-live (private main repo, demo not yet deployed) (${privateRepo.length}):\n` + privateRepo.slice(0, 5).join('\n') + (privateRepo.length > 5 ? '\n...' : ''));
}
if (!broken.length && !extBroken.length) console.log('No broken links.');
process.exit(broken.length || extBroken.length ? 1 : 0);
