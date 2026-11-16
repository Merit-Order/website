// Screenshots of every built page, light and dark, desktop and 375px, from a running `npm run preview`.
// Also reports any page that scrolls sideways at 375px. Usage: node scripts/screenshots.mjs [baseURL] [outDir] [/page/,...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const base = process.argv[2] || 'http://localhost:4321';
const out = process.argv[3] || 'shots';
fs.mkdirSync(out, { recursive: true });

// Every page in the build.
const pages = [];
(function walk(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory() && !['_astro', 'pagefind', 'data'].includes(f.name)) walk(p);
    else if (f.name === 'index.html') pages.push('/' + path.relative('dist', path.dirname(p)).replace(/\\/g, '/') + (dir === 'dist' ? '' : '/'));
  }
})('dist');
pages.sort();
// Optional: only these pages, e.g. "/,/savings/".
if (process.argv[4]) { const only = process.argv[4].split(','); pages.splice(0, pages.length, ...pages.filter((p) => only.includes(p))); }

const browser = await chromium.launch();
const problems = [];
for (const theme of ['light', 'dark']) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['375', { width: 375, height: 812 }]]) {
    const ctx = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
    await ctx.addInitScript((t) => { try { localStorage.setItem('starlight-theme', t); } catch {} }, theme);
    const page = await ctx.newPage();
    for (const p of pages) {
      await page.goto(base + p.replace(/\/\/$/, '/'), { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const name = (p === '/' ? 'home' : p.replace(/^\/|\/$/g, '').replace(/\//g, '_')) + `-${theme}-${label}.png`;
      // Very long docs pages (09 Decisions) are cut at 12,000px: past that, full-page capture gets very slow.
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const opts = height > 12000 ? { clip: { x: 0, y: 0, width: viewport.width, height: 12000 }, fullPage: true } : { fullPage: true };
      try { await page.screenshot({ path: path.join(out, name), ...opts, timeout: 120000 }); } catch (e) { problems.push(`${p} ${theme} ${label}: screenshot failed (${e.message.split('\n')[0]})`); }
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const set = await page.evaluate(() => document.documentElement.dataset.theme);
      if (over > 0) problems.push(`${p} ${theme} ${label}: scrolls sideways by ${over}px`);
      if (set !== theme) problems.push(`${p}: theme is ${set}, expected ${theme}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`${pages.length} pages x 4 = ${pages.length * 4} screenshots in ${out}/`);
console.log(problems.length ? problems.join('\n') : 'No page scrolls sideways at 375px; themes applied.');
