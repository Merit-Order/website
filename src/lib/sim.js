// The routing simulator's results (snapshot/routing-sim.json, written by scripts/refresh.mjs from the main repo's
// scripts/routing_sim.py). Every savings and comparison number on the site comes from here. Plain JS, so the build and
// the calculator in the browser share it.

/** Strategies in the order the site shows them, with plain names. */
export const NAMES = {
  'always-opus': 'Claude Opus 5.5 for everything',
  'always-sonnet': 'Claude Sonnet 5.5 for everything',
  'always-cheapest': 'The cheapest model for everything',
  'auto-threshold': 'auto, threshold (the default until decision 62)',
  'auto-cost-per-success': 'auto, cost per success',
  'auto-expected-cost': 'auto, expected total cost (the default)',
  'auto-threshold-escalate': 'auto, threshold, escalating on evidence',
  'auto-expected-cost-cascade': 'auto, expected total cost, with one escalation',
  oracle: 'Oracle: the cheapest model that would have succeeded',
};
export const NOTES = {
  'always-sonnet': 'also a fixed-model proxy set to Sonnet: the same tokens',
  'always-cheapest': 'DeepSeek V4.1 Flash',
  'auto-cost-per-success': 'opt-in',
  'auto-threshold-escalate': 'an example strategy, not shipped',
  'auto-expected-cost-cascade': 'opt-in (routing.cascade)',
  oracle: 'a lower bound: no router knows in advance',
};

/** Cost per finished task in total, counting failed attempts at `h` dollars each, from the run's own counts. */
export const perFinished = (s, h = 0) => (s.cost + h * s.failed_attempts) / s.finished;
/** Spend for `tasks` tasks, scaled from the run's average per task. */
export const scaled = (s, tasks, h = 0) => ((s.cost + h * s.failed_attempts) / s.tasks) * tasks;
export const finishedOf = (s, tasks) => (s.finished / s.tasks) * tasks;

// ---- Counting the cost of failed attempts (the Savings page's chart and the calculator).
// A failed attempt costs someone time; the site prices it at `h` dollars per failed attempt. The simulator's
// human_sensitivity gives only totals, so the split comes from the run's own counts: spend per finished task, plus
// h × failed attempts per finished task.

/** Strategies in the order the chart shows them. */
export const FAIL_ORDER = ['always-opus', 'always-sonnet', 'always-cheapest', 'auto-threshold', 'auto-cost-per-success', 'auto-expected-cost', 'auto-expected-cost-cascade', 'oracle'];
/** Failed attempts per finished task. */
export const failsPerFinished = (s) => s.failed_attempts / s.finished;
/** Per finished task at h dollars per failed attempt: model spend, time lost to failures, the total, and the share finished. */
export const failSplit = (s, h) => {
  const spend = s.cost / s.finished, lost = h * failsPerFinished(s);
  return { spend, lost, total: spend + lost, finished: s.finished / s.tasks };
};
/** Round axis ticks from 0 to at least `max`. */
export function niceTicks(max, count = 5) {
  if (!(max > 0)) return [0];
  const raw = max / count, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw);
  const ticks = [];
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const PROSE = {
  'always-opus': 'Opus for everything', 'always-sonnet': 'Sonnet for everything', 'always-cheapest': 'the cheapest model for everything',
  'auto-threshold': 'the old threshold', 'auto-cost-per-success': 'cost per success', 'auto-expected-cost': 'the default',
  'auto-expected-cost-cascade': 'the default with one escalation (opt-in)', oracle: 'the oracle',
};
const usd2 = (v) => '$' + v.toFixed(2);
const cap = (t) => t[0].toUpperCase() + t.slice(1);

/**
 * The note under the chart, as sentences, from `by` (strategy -> failSplit) at h dollars per failed attempt. Throws
 * when the data no longer supports a claim the note makes, so a refresh that changes the story fails the build.
 */
export function failNote(by, h) {
  const real = FAIL_ORDER.filter((k) => k !== 'oracle');
  const O = by['always-opus'], S = by['always-sonnet'], E = by['auto-expected-cost'], X = by.oracle;
  const minBy = (f) => real.reduce((a, k) => (f(by[k]) < f(by[a]) ? k : a), real[0]);
  const maxBy = (f) => real.reduce((a, k) => (f(by[k]) > f(by[a]) ? k : a), real[0]);
  if (maxBy((r) => r.spend) !== 'always-opus') throw new Error('failNote: Opus is no longer the dearest to run');
  if (h === 0) {
    const c = minBy((r) => r.spend);
    return [
      `At $0 a failed attempt counts for nothing, so each bar is model spend alone.`,
      `${cap(PROSE[c])} looks best, but finishes only ${(by[c].finished * 100).toFixed(1)}% of tasks.`,
      `The default spends ${usd2(E.spend)} per finished task, against ${usd2(S.spend)} for Sonnet and ${usd2(O.spend)} for Opus.`,
    ];
  }
  if (minBy((r) => r.lost) !== 'always-opus') throw new Error('failNote: Opus no longer loses the least time to failures');
  if (Math.abs(E.lost / S.lost - 1) > 0.05) throw new Error('failNote: the default no longer loses about as much time as Sonnet');
  const floor = Math.min(...real.map((k) => by[k].lost));
  const best = minBy((r) => r.total);
  const out = [
    `Every router and fixed model here loses at least ${usd2(floor)} per finished task to failed attempts, and even the oracle loses ${usd2(X.lost)}. Most of it comes from vague first prompts that no model can fix, which is why the bars look alike.`,
    `Opus loses the least time to failures (${usd2(O.lost)}) but costs the most to run (${usd2(O.spend)}, ${(O.spend / S.spend).toFixed(1)} times Sonnet's ${usd2(S.spend)}).`,
  ];
  const close = Math.abs(by[best].total - E.total) < 0.005;
  if (best === 'auto-expected-cost' || close) {
    out.push(`The default has the lowest total short of the oracle${best === 'auto-expected-cost' ? '' : `, level with ${PROSE[best]}`}: it spends ${usd2(E.spend)} on the model, far less than Sonnet, and loses about as little time (${usd2(E.lost)} against ${usd2(S.lost)}). It cuts model spend without wasting people's time.`);
  } else {
    out.push(`The default spends ${usd2(E.spend)} on the model, far less than Sonnet, and loses about as little time (${usd2(E.lost)} against ${usd2(S.lost)}). At this price ${PROSE[best]} comes out ${usd2(E.total - by[best].total)} lower in total, by losing less time to failures.`);
  }
  return out;
}
