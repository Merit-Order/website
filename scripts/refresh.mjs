// Refresh snapshot/ from a checkout of the main Merit Order repository: the files the site is built from, and the
// routing simulator's results.
//
//   MERITORDER_REPO=../meritorder npm run refresh          # a local checkout, with uv (https://docs.astral.sh/uv/)
//   MERITORDER_REPO=../meritorder npm run refresh -- --no-sim   # the docs only, keep the simulator's results
//
// snapshot/meritorder/ gets exactly the files scripts/sync-docs.mjs reads (docs, the README and the other top-level
// pages, the price list and configuration), so a build needs no access to the main repo. snapshot/routing-sim.json gets
// two runs of scripts/routing_sim.py on the main repo's current code (no model calls, no spend):
//
//   standard     2,000 tasks of the simulator's standard mix (70% coding, 30% chat), as docs/routing-eval/ reports it
//   coding-only  2,000 coding tasks from Claude Code (75%), a small agent such as Codex (15%) and chat with code (10%),
//                scaled to 10 developers x 8 tasks a day x 21 working days = 1,680 tasks a month
//
// Every number on the site's Savings and home pages comes from that file. CI runs this before building whenever it
// can read the main repo; otherwise it builds from what is committed here.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP = path.join(ROOT, 'snapshot');
const OUT = path.join(SNAP, 'meritorder');
const REPO = path.resolve(ROOT, process.env.MERITORDER_REPO || '../meritorder');
const noSim = process.argv.includes('--no-sim');

if (!fs.existsSync(path.join(REPO, 'docs/README.md')) || !fs.existsSync(path.join(REPO, 'scripts/routing_sim.py'))) {
  console.error(`refresh: no Merit Order checkout at ${REPO}. Set MERITORDER_REPO to one.`);
  process.exit(1);
}
const git = (...a) => { try { return execFileSync('git', ['-C', REPO, ...a]).toString().trim(); } catch { return ''; } };
const commit = git('rev-parse', 'HEAD');

// ---------------------------------------------------------------- the files the site is built from
const FILES = ['README.md', 'ROADMAP.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'LICENSE',
  'config/prices.json', 'config/meritorder.yaml', 'config/models-open.yaml', 'src/meritorder/pauses.py'];
fs.rmSync(OUT, { recursive: true, force: true });
const copy = (rel) => {
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(path.join(REPO, rel), to, { recursive: true });
};
for (const f of FILES) copy(f);
for (const f of fs.readdirSync(path.join(REPO, 'docs'))) if (f.endsWith('.md')) copy(`docs/${f}`);
if (fs.existsSync(path.join(REPO, 'docs/img'))) copy('docs/img');
// The repo's directories, so links into them still become GitHub tree links (sync-docs.mjs).
const tracked = git('ls-files').split('\n').filter(Boolean);
const dirs = [...new Set(tracked.flatMap((f) => f.split('/').slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join('/'))))].sort();
fs.writeFileSync(path.join(OUT, '.repo.json'), JSON.stringify({ commit, dirs }, null, 1) + '\n');
console.log(`refresh: ${FILES.length} files, docs and images from ${REPO} @ ${commit.slice(0, 7)}`);

if (noSim) process.exit(0);

// ---------------------------------------------------------------- the routing simulator
const MONTH = { developers: 10, tasksPerDay: 8, workdays: 21 };
MONTH.tasks = MONTH.developers * MONTH.tasksPerDay * MONTH.workdays;
const RUNS = {
  standard: { mix: 'standard', tasks: 2000 },
  'coding-only': { mix: 'coding-only', tasks: 2000 },
};

function simulate(name, { mix, tasks }) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), `routing-sim-${name}-`));
  const args = ['run', 'python', 'scripts/routing_sim.py', 'run', '--tasks', String(tasks), '--mix', mix, '--out', out];
  console.log(`refresh: uv ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const p = spawn('uv', args, { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', reject);
    p.on('exit', (code) => code === 0 ? resolve(JSON.parse(fs.readFileSync(path.join(out, 'scorecard.json'), 'utf8')))
      : reject(new Error(`routing_sim.py exited with ${code}`)));
  });
}

const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const FIELDS = ['tasks', 'cost', 'success_rate', 'first_try_success', 'finished', 'failed_attempts', 'cost_per_task',
  'cost_per_finished', 'human_cost', 'total_with_human', 'total_per_finished_with_human', 'escalation_rate',
  'escalations_helped', 'too_high', 'too_low', 'savings_vs_sonnet', 'savings_vs_opus', 'savings_vs_sonnet_with_human'];
const pick = (o) => Object.fromEntries(FIELDS.filter((k) => k in o).map((k) => [k, r4(o[k])]));

function compact(card) {
  const strategies = {};
  for (const name of card.order) {
    const s = card.strategies[name];
    if (!s) continue;
    strategies[name] = {
      label: s.label,
      overall: { ...pick(s.overall), levels: s.overall.levels, spend_by_model: Object.fromEntries(
        Object.entries(s.overall.spend_by_model || {}).map(([m, v]) => [m, r4(v)])) },
      by_class: Object.fromEntries(Object.entries(s.by_class || {}).map(([c, v]) => [c, pick(v)])),
    };
  }
  return {
    settings: card.settings, population: card.population, classes: card.classes, config: card.config,
    order: card.order.filter((n) => strategies[n]), strategies, intervals: card.intervals,
    human_sensitivity: card.human_sensitivity, sensitivity: card.sensitivity,
  };
}

const results = {};
const cards = await Promise.all(Object.entries(RUNS).map(([n, r]) => simulate(n, r)));
Object.keys(RUNS).forEach((n, i) => { results[n] = compact(cards[i]); });
results['coding-only'].month = { ...MONTH, scale: MONTH.tasks / RUNS['coding-only'].tasks };

const uvLock = fs.existsSync(path.join(REPO, 'uv.lock'));
fs.writeFileSync(path.join(SNAP, 'routing-sim.json'), JSON.stringify({
  generated: new Date().toISOString(),
  commit,
  source: 'scripts/routing_sim.py (src/meritorder/routing_eval.py) in the main repository',
  commands: Object.fromEntries(Object.entries(RUNS).map(([n, r]) => [n, `uv run python scripts/routing_sim.py run --tasks ${r.tasks} --mix ${r.mix}`])),
  locked: uvLock,
  scenarios: results,
}, null, 1) + '\n');
for (const [n, c] of Object.entries(results)) {
  const o = (k) => c.strategies[k]?.overall;
  console.log(`refresh: ${n}: ${['always-opus', 'always-sonnet', 'auto-expected-cost'].map((k) =>
    `${k} $${o(k).cost_per_finished.toFixed(3)}/finished at ${(o(k).success_rate * 100).toFixed(1)}%`).join(', ')}`);
}
console.log('refresh: wrote snapshot/routing-sim.json');
