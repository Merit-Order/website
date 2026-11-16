// After the build: give every page a Content-Security-Policy meta tag that allows exactly the inline scripts on that
// page, by their sha256, and scripts from the site itself.
//
// CloudFront sends the site-wide policy as a header (deploy/aws/website.yaml): self-hosted everything, frame-ancestors,
// and script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval', because a fixed header can't know the hashes of the
// inline scripts a build makes (Starlight's theme and UI scripts, a few of Astro's). A browser enforces both
// policies, so this tag narrows scripts to those hashes; everything else comes from the header. 'wasm-unsafe-eval' is
// for Pagefind's search, which runs WebAssembly.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIST = 'dist';
const pages = [];
(function walk(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    if (f.isDirectory()) walk(p); else if (p.endsWith('.html')) pages.push(p);
  }
})(DIST);

let inline = 0;
const all = new Set();
for (const file of pages) {
  let html = fs.readFileSync(file, 'utf8');
  if (html.includes('http-equiv="content-security-policy"')) continue;
  const handlers = html.match(/<[^>]+\son[a-z]+="[^"]*"/i);
  if (handlers) throw new Error(`csp: an inline event handler in ${file}: ${handlers[0].slice(0, 120)}`);
  const hashes = new Set();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const attrs = m[1];
    if (/\ssrc=/.test(attrs) || !m[2]) continue;
    const type = (attrs.match(/\stype="([^"]+)"/) || [])[1];
    if (type && !/^(module|text\/javascript)$/.test(type)) continue; // data blocks (JSON) never run
    const h = `'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`;
    hashes.add(h);
    all.add(h);
    inline++;
  }
  const policy = ["script-src 'self' 'wasm-unsafe-eval'", ...hashes].join(' ');
  const meta = `<meta http-equiv="content-security-policy" content="${policy}">`;
  // Before any script: right after the charset, which must stay in the first 1,024 bytes.
  html = /<meta charset="[^"]*"\s*\/?>/i.test(html)
    ? html.replace(/<meta charset="[^"]*"\s*\/?>/i, (c) => c + meta)
    : html.replace(/<head>/i, (h) => h + meta);
  fs.writeFileSync(file, html);
}
console.log(`csp: ${pages.length} pages, ${inline} inline scripts, ${all.size} distinct hashes`);
