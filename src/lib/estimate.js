// List-price arithmetic for the worked examples of caching and sticky sessions: the cache-rebuild and per-turn parts of
// Router.estimate (src/meritorder/router.py). Savings from routing are not computed here: they come from the routing
// simulator (sim.js).
//
// Prices are dollars per million tokens, from public/data/pricing.json (exported from config/prices.json).

const HOUR = 3600;

/** Price.at: long-prompt tiers replace the base prices above their threshold. */
export function priceAt(p, promptTokens) {
  const tier = (p.tiers || []).filter((t) => promptTokens > t.above).sort((a, b) => b.above - a.above)[0];
  if (!tier) return p;
  const scale = (v) => (v == null ? null : p.input ? (v * tier.input) / p.input : null);
  return {
    ...p, tiers: [], input: tier.input, output: tier.output,
    cache_read: tier.cache_read ?? scale(p.cache_read),
    cache_write: tier.cache_write ?? scale(p.cache_write),
    cache_write_1h: tier.cache_write_1h ?? scale(p.cache_write_1h),
  };
}
const read = (p) => (p.cache_read != null ? p.cache_read : p.input * 0.1);
const write5m = (p) => (p.cache_write != null ? p.cache_write : p.input);
const write1h = (p) => (p.cache_write_1h != null ? p.cache_write_1h : p.input * 2);

/** The parts of Router.estimate for one route at one prompt size: rebuild, the first turn, a later turn. */
export function parts(route, promptTokens, { warm = 0, newTokens = 2000, outputTokens = 600, pause = 0, laterSession = false, clientMarkers = false } = {}) {
  const price = priceAt(route.price, promptTokens);
  // A client's own markers (Claude Code: 5 minutes on the conversation) go as they are: no gateway 1-hour cache.
  const ttl = clientMarkers ? 300 : route.ttl;
  const cached = Math.max(promptTokens - newTokens, 0);
  let first, later;
  if (!route.explicit) first = later = price.input; // automatic caching: new tokens at the input price
  else if (ttl >= HOUR) { later = write1h(price); first = laterSession ? later : write5m(price); }
  else first = later = write5m(price);
  const perTurn = (w) => (cached * read(price) + newTokens * w + outputTokens * price.output) / 1e6;
  const rebuild = (1 - Math.min(Math.max(warm, 0), 1)) * cached * Math.max(first - read(price), 0) / 1e6;
  // A later turn after a 5-60 minute pause writes the prefix again where the cache lasts under an hour.
  const lost = ttl < HOUR ? (pause * cached * Math.max(later - read(price), 0)) / 1e6 : 0;
  return { rebuild, first: perTurn(first), later: perTurn(later) + lost };
}
