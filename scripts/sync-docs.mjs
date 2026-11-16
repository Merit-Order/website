// Pull the docs from the main Merit Order repository into this site, at build time.
//
// The main repo stays the source: nothing this script writes is committed (see .gitignore).
//
//   MERITORDER_REPO   a local checkout (path) or a git URL. Default: snapshot/meritorder, the copy committed here
//                     (scripts/refresh.mjs writes it from a checkout).
//   MERITORDER_REF    with a git URL: the branch or tag to clone (default: the repo's default branch).
//
// It copies docs/*.md, docs/img/*, README, ROADMAP, CHANGELOG, CONTRIBUTING and SECURITY, rewrites links between
// them to site routes (anything else in the repo becomes a GitHub link), renders mermaid diagrams to inline SVG
// with Playwright (themed with CSS variables, so they follow light and dark), and exports the price list and model
// scores the savings calculator uses (public/data/pricing.json).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import YAML from 'yaml';
import GithubSlugger from 'github-slugger';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GITHUB = 'https://github.com/Merit-Order/meritorder';
const BLOB = `${GITHUB}/blob/main/`;
const TREE = `${GITHUB}/tree/main/`;
const CONTENT = path.join(ROOT, 'src/content/docs');
const GENERATED = path.join(ROOT, 'src/generated');
const CACHE = path.join(ROOT, '.cache');

// ---------------------------------------------------------------- where the main repo is
function resolveRepo() {
  const spec = process.env.MERITORDER_REPO || path.join(ROOT, 'snapshot/meritorder');
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(spec) || spec.endsWith('.git')) {
    const dir = path.join(CACHE, 'meritorder');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(CACHE, { recursive: true });
    const args = ['clone', '--depth', '1'];
    if (process.env.MERITORDER_REF) args.push('--branch', process.env.MERITORDER_REF);
    execFileSync('git', [...args, spec, dir], { stdio: 'inherit' });
    return dir;
  }
  const dir = path.resolve(ROOT, spec);
  if (!fs.existsSync(path.join(dir, 'docs/README.md'))) {
    console.error(`sync-docs: no Merit Order checkout at ${dir}.\n` +
      'Set MERITORDER_REPO to a checkout of Merit-Order/meritorder (a path or a git URL), or run npm run refresh.');
    process.exit(1);
  }
  return dir;
}

const REPO = resolveRepo();
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
// A snapshot (scripts/refresh.mjs) says which commit it is and which paths are directories; a checkout says itself.
const snapshot = fs.existsSync(path.join(REPO, '.repo.json')) ? JSON.parse(read('.repo.json')) : null;
const repoDirs = new Set(snapshot?.dirs || []);
let commit = snapshot ? snapshot.commit.slice(0, 7) : '';
if (!snapshot) try { commit = execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD']).toString().trim(); } catch { /* not a git checkout */ }

// ---------------------------------------------------------------- which file goes where
// Site route (under src/content/docs) for each source file. Docs are named as in docs/html/.
const slugOf = (file) => path.basename(file, '.md').replace(/^\d+-/, '');
const ROUTES = {
  'docs/README.md': 'docs/index',
  'README.md': 'docs/quickstart',
  'CONTRIBUTING.md': 'docs/contributing',
  'SECURITY.md': 'docs/security',
  'ROADMAP.md': 'roadmap',
  'CHANGELOG.md': 'changelog',
};
const docFiles = fs.readdirSync(path.join(REPO, 'docs')).filter((f) => f.endsWith('.md') && f !== 'README.md');
for (const f of docFiles) ROUTES[`docs/${f}`] = `docs/${slugOf(f)}`;

const urlOf = (route) => '/' + route.replace(/(^|\/)index$/, '') + (route.endsWith('index') ? '' : '/');

// ---------------------------------------------------------------- reading order, from docs/README.md
const overview = read('docs/README.md');
const order = [];
const orderTable = overview.split(/^## Read in this order\s*$/m)[1]?.split(/^## /m)[0] ?? '';
for (const m of orderTable.matchAll(/^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|\s*(.*?)\s*\|\s*$/gm)) {
  const label = m[1].trim();
  const file = `docs/${m[2].trim()}`;
  const num = (label.match(/^(\d+)\s+/) || [])[1] || '';
  order.push({ file, num, label: label.replace(/^\d+\s+/, '') });
}
for (const f of docFiles) if (!order.some((o) => o.file === `docs/${f}`)) order.push({ file: `docs/${f}`, num: '', label: null });

const GROUPS = [
  { label: 'Start here', files: ['docs/README.md', 'docs/00-how-it-all-works.md', 'docs/feature-sheet.md', 'README.md', 'glossary'] },
  { label: 'How it works', files: ['docs/01-architecture.md', 'docs/02-request-flow.md', 'docs/03-routing.md', 'docs/04-caching-and-sessions.md'] },
  { label: 'Running it', files: ['docs/05-gpu-autoscaling.md', 'docs/06-auth-and-spend.md', 'docs/07-deployment.md', 'docs/08-reporting.md'] },
  { label: 'Reference', files: ['docs/09-decisions.md', 'docs/10-how-it-decides.md', 'docs/11-evals.md'] },
  { label: 'Project', files: ['ROADMAP.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md'] },
];
// A doc added to the main repo later lands in Reference, in reading order.
const grouped = new Set(GROUPS.flatMap((g) => g.files));
for (const o of order) if (!grouped.has(o.file)) GROUPS[3].files.push(o.file);

// ---------------------------------------------------------------- link rewriting
function rewriteLink(target, fromFile) {
  if (/^(https?:|mailto:|#)/.test(target)) return target;
  const [rawPath, hash] = target.split('#');
  if (!rawPath) return target;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), rawPath)).replace(/^\.\//, '');
  const anchor = hash ? `#${hash}` : '';
  if (ROUTES[resolved]) return urlOf(ROUTES[resolved]) + anchor;
  if (resolved.startsWith('docs/img/')) return target; // copied next to the docs
  const isDir = resolved.endsWith('/') || repoDirs.has(resolved) ||
    (fs.existsSync(path.join(REPO, resolved)) && fs.statSync(path.join(REPO, resolved)).isDirectory());
  if (isDir) return TREE + resolved.replace(/\/$/, '') + anchor;
  return BLOB + resolved + anchor;
}

function rewriteLinks(md, fromFile) {
  // Outside fenced code only: [text](target) and ![alt](target).
  return splitFences(md).map((part) => part.code ? part.text : part.text.replace(/(!?\[[^\]]*\])\(([^)\s]+)(\s+"[^"]*")?\)/g,
    (all, label, target, title = '') => {
      const isImage = label.startsWith('!');
      const t = isImage && target.startsWith('img/') && fromFile.startsWith('docs/') ? target : rewriteLink(target, fromFile);
      return `${label}(${t}${title})`;
    })).join('');
}

function splitFences(md) {
  const parts = [];
  const re = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm;
  let last = 0;
  for (const m of md.matchAll(re)) {
    if (m.index > last) parts.push({ code: false, text: md.slice(last, m.index) });
    parts.push({ code: true, text: m[0] });
    last = m.index + m[0].length;
  }
  parts.push({ code: false, text: md.slice(last) });
  return parts;
}

// ---------------------------------------------------------------- mermaid, rendered once at build time
// Unique placeholder colours go in; CSS variables come out, so one inline SVG follows the site's light and dark themes.
const PLACEHOLDERS = {
  '#a00001': 'var(--mm-node)', '#a00002': 'var(--mm-node-line)', '#a00003': 'var(--mm-text)', '#a00004': 'var(--mm-edge)',
  '#a00005': 'var(--mm-alt)', '#a00006': 'var(--mm-alt-2)', '#a00007': 'var(--mm-bg)', '#a00008': 'var(--mm-cluster)',
  '#a00009': 'var(--mm-cluster-line)', '#a0000a': 'var(--mm-label-bg)', '#a0000b': 'var(--mm-note)',
};
const THEME_VARIABLES = {
  primaryColor: '#a00001', mainBkg: '#a00001', primaryBorderColor: '#a00002', nodeBorder: '#a00002',
  secondaryBorderColor: '#a00002', tertiaryBorderColor: '#a00002', primaryTextColor: '#a00003', textColor: '#a00003',
  titleColor: '#a00003', secondaryTextColor: '#a00003', tertiaryTextColor: '#a00003', noteTextColor: '#a00003',
  lineColor: '#a00004', secondaryColor: '#a00005', tertiaryColor: '#a00006', background: '#a00007',
  clusterBkg: '#a00008', clusterBorder: '#a00009', noteBorderColor: '#a00009', edgeLabelBackground: '#a0000a',
  labelBackground: '#a0000a', noteBkgColor: '#a0000b',
  fontFamily: 'Geist, system-ui, sans-serif', fontSize: '15px',
};

function themeSvg(svg) {
  let out = svg;
  for (const [hex, v] of Object.entries(PLACEHOLDERS)) out = out.replaceAll(hex, v).replaceAll(hex.toUpperCase(), v);
  // Colours mermaid derives from the placeholders (edge label backgrounds, state markers).
  out = out.replace(/rgba\(160, 0, 10, 0\.5\)/g, 'var(--mm-label-bg)')
    .replace(/rgb\(160, 0, 2\)/g, 'var(--mm-node-line)')
    .replace(/hsl\(358\.125, 100%, [\d.]+%\)/g, 'var(--mm-node-line)')
    .replace(/fill:#000000;/g, 'fill:var(--mm-text);').replace(/fill:#000;/g, 'fill:var(--mm-text);')
    .replace(/stroke:#000;/g, 'stroke:var(--mm-text);');
  return out;
}

async function renderMermaid(sources) {
  if (!sources.length) return [];
  const cacheFile = path.join(CACHE, 'mermaid.json');
  const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
  const key = (s) => createHash('sha256').update(JSON.stringify([s, THEME_VARIABLES, 3])).digest('hex').slice(0, 24);
  const todo = [...new Set(sources.filter((s) => !cache[key(s)]))];
  if (todo.length) {
    const { createMermaidRenderer } = await import('mermaid-isomorphic');
    // The fonts the site serves, so labels are measured in Geist and fit their boxes.
    const fontDir = path.join(ROOT, 'node_modules/@fontsource-variable/geist/files');
    const css = path.join(CACHE, 'mermaid-fonts.css');
    fs.mkdirSync(CACHE, { recursive: true });
    fs.writeFileSync(css, `@font-face{font-family:Geist;font-weight:100 900;src:url(${pathToFileURL(path.join(fontDir, 'geist-latin-wght-normal.woff2'))}) format('woff2')}`);
    const render = createMermaidRenderer();
    const results = await render(todo, {
      css: pathToFileURL(css),
      mermaidConfig: {
        theme: 'base', themeVariables: THEME_VARIABLES, fontFamily: THEME_VARIABLES.fontFamily,
        flowchart: { htmlLabels: true, curve: 'basis', padding: 12 }, state: { padding: 8 },
      },
      prefix: 'mmd',
    });
    results.forEach((r, i) => {
      if (r.status !== 'fulfilled') throw new Error(`mermaid failed on:\n${todo[i]}\n${r.reason}`);
      cache[key(todo[i])] = { svg: r.value.svg, width: r.value.width, height: r.value.height };
    });
    fs.writeFileSync(cacheFile, JSON.stringify(cache));
  }
  return sources.map((s) => cache[key(s)]);
}

// Each SVG gets ids unique on its page (mermaid numbers them from 0 per render call).
let diagramCount = 0;
function figureFor(source, out, title) {
  const n = ++diagramCount;
  const id = `mmd-${n}`;
  let svg = themeSvg(out.svg).replace(/mmd-\d+/g, id);
  const natural = Math.round(out.width);
  const minWidth = Math.min(natural, Math.round(natural * 0.8));
  svg = svg.replace(/<svg([^>]*?)style="[^"]*"/, `<svg$1style="max-width:${natural}px;min-width:${minWidth}px"`);
  // An accessible name: the node labels, in order, for screen readers.
  const labels = [...source.matchAll(/\["([^"]+)"\]|\{"([^"]+)"\}|\("([^"]+)"\)|state "([^"]+)"/g)]
    .map((m) => (m[1] || m[2] || m[3] || m[4]).replace(/<br\s*\/?>/g, ' ')).slice(0, 14);
  const label = `Diagram${title ? ` for ${title}` : ''}: ${labels.join('; ')}`.replace(/"/g, '&quot;');
  svg = svg.replace(/<svg /, `<svg aria-label="${label}" `).replace(/role="graphics-document document"/, 'role="img"');
  return `<figure class="mermaid-figure" data-wide="${natural > 760}"><div class="mermaid-scroll" tabindex="0" role="region" aria-label="Diagram, scrolls sideways on small screens">${svg}</div></figure>`;
}

// ---------------------------------------------------------------- one markdown file to one page
function firstParagraph(md) {
  for (const block of md.split(/\n{2,}/)) {
    const b = block.trim();
    if (!b || /^(#|>|\||```|!|<|-|\*|\d+\.)/.test(b)) continue;
    const text = b.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ');
    return text.length > 200 ? text.slice(0, 197).replace(/\s+\S*$/, '') + '...' : text;
  }
  return '';
}

const yamlString = (s) => JSON.stringify(s);

async function convert(file, { title, sidebarLabel, body: givenBody } = {}) {
  let md = givenBody ?? read(file);
  const h1 = md.match(/^#\s+(.+)$/m);
  let pageTitle = title || (h1 ? h1[1].trim() : file);
  pageTitle = pageTitle.replace(/^\d+\s*[—–-]\s*/, '').replace(/\s*&\s*/g, ' and ');
  if (h1 && !givenBody) md = md.replace(h1[0], '').replace(/^\s+/, '');
  md = rewriteLinks(md, file);
  // The repository is moving to Merit-Order/meritorder: links and clone commands point there. A quoted setting's
  // value in backticks (what the code ships today) is left as it is.
  md = md.replace(/(?<!`)https:\/\/github\.com\/therick\/meritorder/g, GITHUB);

  const parts = splitFences(md);
  const sources = parts.filter((p) => p.code && /^(```|~~~)mermaid/.test(p.text)).map((p) => p.text.replace(/^[^\n]*\n/, '').replace(/\n(```|~~~)[ \t]*$/, '\n'));
  const rendered = await renderMermaid(sources);
  let i = 0;
  md = parts.map((p) => {
    if (!(p.code && /^(```|~~~)mermaid/.test(p.text))) return p.text;
    const src = sources[i];
    return `\n${figureFor(src, rendered[i++], pageTitle)}\n`;
  }).join('');

  const fm = ['---', `title: ${yamlString(pageTitle)}`];
  const description = firstParagraph(md);
  if (description) fm.push(`description: ${yamlString(description)}`);
  if (sidebarLabel) fm.push(`sidebar:\n  label: ${yamlString(sidebarLabel)}`);
  fm.push(`editUrl: ${yamlString(BLOB + file)}`);
  fm.push('---', '');
  return fm.join('\n') + md;
}

function write(route, text) {
  const out = path.join(CONTENT, `${route}.md`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
}

// ---------------------------------------------------------------- run
fs.rmSync(path.join(CONTENT, 'docs'), { recursive: true, force: true });
for (const f of ['roadmap.md', 'changelog.md']) fs.rmSync(path.join(CONTENT, f), { force: true });
fs.mkdirSync(GENERATED, { recursive: true });

const labels = Object.fromEntries(order.map((o) => [o.file, o]));
const LABELS = { 'docs/README.md': 'Overview', 'README.md': 'Quickstart', 'ROADMAP.md': 'Roadmap', 'CHANGELOG.md': 'Changelog',
  'CONTRIBUTING.md': 'Contributing', 'SECURITY.md': 'Security', 'docs/feature-sheet.md': 'Feature sheet' };

for (const [file, route] of Object.entries(ROUTES)) {
  const o = labels[file];
  const sidebarLabel = LABELS[file] || o?.label || null;
  const title = file === 'README.md' ? 'Quickstart' : file === 'docs/README.md' ? 'Merit Order docs' : undefined;
  write(route, await convert(file, { title, sidebarLabel }));
}

// The glossary, as its own page: the table from docs/README.md.
const glossary = overview.split(/^## Glossary\s*$/m)[1]?.split(/^## /m)[0]?.trim();
if (glossary) {
  write('docs/glossary', await convert('docs/README.md', {
    title: 'Glossary',
    body: `The words the docs use, as defined in the [docs overview](README.md#glossary).\n\n${glossary}\n`,
  }));
}

// Anchors into the docs that name no heading: where the heading has grown ("#the-requests-view" for "The Requests view
// (Reports → Requests)") and exactly one heading starts with the anchor, link there, and say so; the source needs fixing.
{
  const pages = new Map(); // url -> file
  for (const route of new Set([...Object.values(ROUTES), 'docs/glossary'])) pages.set(urlOf(route), path.join(CONTENT, `${route}.md`));
  const slugsOf = new Map();
  const slugs = (file) => {
    if (!slugsOf.has(file)) {
      const sl = new GithubSlugger();
      const md = splitFences(fs.readFileSync(file, 'utf8')).filter((p) => !p.code).map((p) => p.text).join('');
      slugsOf.set(file, new Set([...md.matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)].map((m) => sl.slug(m[1].replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')))));
    }
    return slugsOf.get(file);
  };
  for (const [url, file] of pages) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const out = text.replace(/\]\((\/[^)#\s]*)?#([^)\s]+)\)/g, (all, target, anchor) => {
      const to = pages.get(target || url);
      if (!to || !fs.existsSync(to)) return all;
      const known = slugs(to);
      if (known.has(anchor)) return all;
      const near = [...known].filter((k) => k.startsWith(anchor + '-'));
      if (near.length !== 1) return all;
      console.warn(`sync-docs: ${url}: #${anchor} names no heading on ${target || url}; linking #${near[0]}`);
      return `](${target || ''}#${near[0]})`;
    });
    if (out !== text) fs.writeFileSync(file, out);
  }
}

// Images used by the docs, next to them so relative links work.
const imgSrc = path.join(REPO, 'docs/img');
if (fs.existsSync(imgSrc)) fs.cpSync(imgSrc, path.join(CONTENT, 'docs/img'), { recursive: true });

// The sidebar, in the reading order of docs/README.md.
const sidebar = GROUPS.map((g) => ({
  label: g.label,
  items: g.files.filter((f) => f === 'glossary' || ROUTES[f]).map((f) => {
    if (f === 'glossary') return { label: 'Glossary', link: '/docs/glossary/' };
    const o = labels[f];
    const item = { label: LABELS[f] || o?.label || slugOf(f), link: urlOf(ROUTES[f]) };
    if (o?.num) item.attrs = { 'data-num': o.num };
    return item;
  }),
}));
fs.writeFileSync(path.join(GENERATED, 'sidebar.json'), JSON.stringify(sidebar, null, 2));

// ---------------------------------------------------------------- prices and scores for the savings calculator
const prices = JSON.parse(read('config/prices.json'));
const cfg = YAML.parse(read('config/meritorder.yaml'));
const open = YAML.parse(read('config/models-open.yaml'));
const backends = { ...(open.backends || {}), ...(cfg.backends || {}) };
const models = { ...(cfg.models || {}), ...(open.models || {}) };
const anchor = cfg.quality?.anchor || { coding: 0.6994, general: 0.7685 };
const measures = prices.quality?.measures || {};
const HOUR = 3600;
const exported = [];
for (const [name, m] of Object.entries(models)) {
  if (m.kind && m.kind !== 'chat') continue;
  const meas = measures[name];
  const score = {};
  for (const task of ['coding', 'general']) {
    const chance = meas?.[task]?.chance;
    if (chance != null) score[task] = Math.round(Math.min(5, Math.max(1, (5 * chance) / anchor[task])) * 10) / 10;
  }
  for (const [task, v] of Object.entries(m.quality_override || {})) score[task] = v;
  if (!Object.keys(score).length) continue; // the quality source doesn't cover it: auto never picks it
  const routes = [];
  for (const r of m.routes || []) {
    const b = backends[r.backend];
    if (!b || b.kind === 'mock' || b.kind === 'self_hosted') continue;
    if (typeof b.enabled === 'string' && /:-false\}$/.test(b.enabled)) continue; // off by default (free tier)
    const p = prices.prices[`${r.backend}:${r.model}`] || r.price;
    if (!p || p.input == null) continue; // unpriced routes never win
    const explicit = b.format === 'anthropic' || (/openrouter\.ai/.test(b.base_url || '') && r.model.startsWith('anthropic/'));
    const ttl = b.cache_ttl_seconds ?? 300;
    routes.push({
      backend: r.backend, explicit, ttl, hour: ttl >= HOUR,
      price: { input: p.input, output: p.output, cache_read: p.cache_read ?? null, cache_write: p.cache_write ?? null,
        cache_write_1h: p.cache_write_1h ?? null, tiers: p.tiers || [] },
    });
  }
  if (!routes.length) continue;
  exported.push({ name, label: displayName(name, m), score, context: prices.context?.[name] ?? null, routes });
}

function displayName(name, m) {
  const r = (m.routes || []).find((x) => x.backend === 'anthropic' || x.backend === 'openai') || (m.routes || [])[0];
  const id = (r?.model || name).replace(/^.*\//, '');
  const pretty = id.replace(/^anthropic\./, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ')
    .replace(/\b(gpt|glm|oss)\b/gi, (s) => s.toUpperCase()).replace(/\b([a-z])/g, (s) => s.toUpperCase())
    .replace(/^GPT /, 'GPT-').replace(/^GLM /, 'GLM-').replace(/ (\d+(?:\.\d+)?)/, ' $1').replace(/^Deepseek/, 'DeepSeek').replace(/^Minimax/, 'MiniMax').replace(/ It$/, '');
  return pretty;
}

const routing = cfg.routing || {};
fs.mkdirSync(path.join(ROOT, 'public/data'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public/data/pricing.json'), JSON.stringify({
  generated_from: `${GITHUB}${commit ? `/tree/${commit}` : ''}`,
  prices_updated: prices.updated,
  scores: { source: prices.quality?.source, attribution: prices.quality?.attribution, anchor, scale: 'absolute' },
  baseline_model: cfg.baseline_model,
  routing: {
    est_new_tokens_per_turn: routing.est_new_tokens_per_turn ?? 2000,
    est_output_tokens: routing.est_output_tokens ?? 600,
    min_expected_turns: routing.min_expected_turns ?? 3,
    max_expected_turns: routing.max_expected_turns ?? 30,
    // The router's share of later turns that come after a 5-60 minute pause, before a team has data (pauses.py).
    pause_prior: Number((read('src/meritorder/pauses.py').match(/^PRIOR = ([\d.]+)/m) || [])[1] ?? 0.1),
  },
  gpu: (() => {
    const g = backends['gpu-qwen-coder'] || {};
    return { deployment: 'gpu-qwen-coder', model: g.serve?.model ?? 'qwen3-coder-next', accelerators: g.serve?.accelerators ?? 'H100:4',
      hourly: g.gpu_cost_per_hour ?? 16, margin: g.serve?.margin ?? 0.2, shadow_floor: routing.shadow_floor ?? 0.02, shadow_knee: routing.shadow_knee ?? 0.6 };
  })(),
  max_request_usd: Number(String(cfg.safeguards?.max_request_usd ?? '').match(/(\d+(?:\.\d+)?)\}?$/)?.[1] ?? 25),
  models: exported,
}, null, 1));
fs.writeFileSync(path.join(GENERATED, 'source.json'), JSON.stringify({ commit, prices_updated: prices.updated }));

console.log(`sync-docs: ${Object.keys(ROUTES).length + 1} pages, ${diagramCount} diagrams, ${exported.length} priced models, from ${REPO}${commit ? ` @ ${commit}` : ''}`);
