// Every number the site pages show, worked out at build time. Savings and comparisons of routing come from the routing
// simulator (snapshot/routing-sim.json, see sim.js). The other mechanisms' worked examples are list-price arithmetic on
// the main repo's price list (public/data/pricing.json, written by scripts/sync-docs.mjs).
import data from '../../public/data/pricing.json';
import sim from '../../snapshot/routing-sim.json';
import { parts, priceAt } from './estimate.js';
import { NAMES, NOTES, perFinished, scaled, finishedOf } from './sim.js';

export { data };
const model = (n) => data.models.find((m) => m.name === n);
const route = (n, b) => model(n).routes.find((r) => r.backend === b);
const R = { pause: data.routing.pause_prior, turns: 3, newTokens: data.routing.est_new_tokens_per_turn, outputTokens: data.routing.est_output_tokens };

export const pricesDate = new Date(data.prices_updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

// ---- Prompt caching, list-price arithmetic on Claude Sonnet (docs/feature-sheet.md).
const son = model('claude-sonnet').routes.find((r) => r.backend === 'anthropic').price;
const w1h = son.cache_write_1h ?? son.input * 2;
export const caching = {
  hourPremiumPerTurn: (2000 * (w1h - son.cache_write)) / 1e6, // 2,000 new tokens a turn at the 1-hour write premium
  readAfterPause: (100000 * son.cache_read) / 1e6,
  writeAgain: (100000 * son.cache_write) / 1e6,
  sonnet: son,
};

// ---- Sticky sessions: an 80,000-token Claude Opus session past its first turn.
const opusP = parts(route('claude-opus', 'anthropic'), 80000, { ...R, warm: 0, laterSession: true });
export const sticky = { rebuild: opusP.rebuild, perTurn: opusP.later };

// ---- Compression: a 100,000-character log becomes about 24,000 characters (max_chars), ~3 characters a token.
export const compression = { tokens: 25000, arrive: (25000 * w1h) / 1e6, later: (25000 * son.cache_read) / 1e6 };

// ---- Batch: 10,000 summaries, 5,000 tokens in and 500 out, on Claude Sonnet, live and at half price.
export const batch = { live: (10000 * (5000 * son.input + 500 * son.output)) / 1e6 };
batch.half = batch.live / 2;

// ---- GPUs at break-even.
export const gpu = { ...data.gpu, startsAbove: data.gpu.hourly * (1 + data.gpu.margin) };

// ---- Response cache (illustration): the same $0.02 request 5,000 times a day, one-hour TTL.
export const responseCache = { without: 5000 * 0.02, with: 24 * 0.02 };

// ---- Budgets: a worst case on Claude Fable, 128,000 tokens out and 500,000 in.
const fable = priceAt(route('claude-fable', 'anthropic').price, 500000);
export const budget = { worst: (128000 * fable.output + 500000 * fable.input) / 1e6, ceiling: data.max_request_usd };

// ---- Routing: the simulator's results (snapshot/routing-sim.json). Nothing here is the router's estimate.
export const std = sim.scenarios.standard;
export const dev = sim.scenarios['coding-only'];
export const ov = (sc, k) => sc.strategies[k].overall;
export const HUMAN = std.settings.human_cost;
export const simDate = new Date(sim.generated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export const simCommit = sim.commit.slice(0, 7);
export const month = dev.month;
/** Model spend in the 10-developer month for one strategy, plus h dollars of someone's time per failed attempt. */
export const devMonth = (k, h = 0) => scaled(ov(dev, k), month.tasks, h);
export { sim, NAMES, NOTES, perFinished, scaled, finishedOf };

export const fmt = {
  usd(v, d) {
    const digits = d ?? (v >= 100 ? 0 : v >= 10 ? 2 : v >= 1 ? 2 : v >= 0.1 ? 3 : v >= 0.01 ? 3 : 4);
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  sig(v) { // the way the docs write amounts: $0.0060, $0.051, $0.115, $9.12
    if (v >= 100) return '$' + Math.round(v).toLocaleString('en-US');
    if (v >= 1) return '$' + v.toFixed(2);
    if (v >= 0.1) return '$' + v.toFixed(3).replace(/(\.\d\d)0$/, '$1');
    return '$' + v.toPrecision(2);
  },
  pct(v) { return Math.round(v * 100) + '%'; },
  pct1(v) { return (v * 100).toFixed(1) + '%'; },
  usd0(v) { return '$' + Math.round(v).toLocaleString('en-US'); },
  round(v, to = 10) { return '$' + (Math.round(v / to) * to).toLocaleString('en-US'); },
};
