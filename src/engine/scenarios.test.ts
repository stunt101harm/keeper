import { describe, expect, it } from 'vitest';
import type { QuoteSet } from '../types.js';
import { createEngine } from './index.js';
import {
  allNull,
  baseParams,
  books,
  FX,
  homeSpread,
  odds,
  quoteSets,
  rawOdds,
  run,
  score,
  trades,
  transitions,
  twoSided,
} from './testutil.js';

/** Scenario params: quick warmup, stale/drawdown breakers parked unless under test. */
const P = (over = {}) =>
  baseParams({ warmupTicks: 2, staleFeedSec: 9999, maxDrawdown: 9999, ...over });

const CONST_PROBS: [number, number, number] = [0.5, 0.3, 0.2];

describe('goal freeze', () => {
  it('pulls quotes for exactly freezeSec of feed time, then re-enters widened', () => {
    const engine = createEngine(P());
    // warm up + quote at constant fair
    const pre = run(engine, [0, 5, 10, 15].map((t) => odds(t, CONST_PROBS)));
    const preQuote = quoteSets(pre).at(-1)!;
    expect(twoSided(preQuote)).toBe(true);
    const preSpread = homeSpread(preQuote);

    // goal at t=20 → freeze until t=50 (freezeSec.goal = 30)
    const goalEv = engine.onTick(score(20, 'goal', 1, 0));
    const tr = transitions(goalEv);
    expect(tr).toHaveLength(1);
    expect(tr[0]!.to).toBe('frozen');
    expect(tr[0]!.reason).toBe('goal_freeze');

    // during the freeze window: all quotes pulled, no fills
    const frozen = run(engine, [25, 35, 45, 49].map((t) => odds(t, CONST_PROBS)));
    expect(trades(frozen)).toHaveLength(0);
    for (const q of quoteSets(frozen)) {
      expect(allNull(q)).toBe(true);
      expect(q.riskState).toBe('frozen');
    }

    // t=50 is exactly goalTs + freezeSec: reopen, widened by reentryWidenMult
    const reopen = engine.onTick(odds(50, CONST_PROBS));
    const reTr = transitions(reopen);
    expect(reTr).toHaveLength(1);
    expect(reTr[0]!).toMatchObject({ from: 'frozen', to: 'quoting', reason: 'freeze_reentry' });
    const reQuote = quoteSets(reopen)[0]!;
    expect(twoSided(reQuote)).toBe(true);
    // fair and σ unchanged through the freeze ⇒ ratio is exactly the widener
    expect(homeSpread(reQuote) / preSpread).toBeCloseTo(2, 9);

    // widener decays monotonically back to 1 over reentryDecayTicks
    let last = homeSpread(reQuote);
    let t = 55;
    const spreads: number[] = [];
    for (let i = 0; i < 26; i++, t += 5) {
      const q = quoteSets(engine.onTick(odds(t, CONST_PROBS)))[0]!;
      spreads.push(homeSpread(q));
    }
    for (const s of spreads) {
      expect(s).toBeLessThanOrEqual(last + 1e-12);
      last = s;
    }
    expect(spreads.at(-1)! / preSpread).toBeCloseTo(1, 9);
  });
});

describe('price circuit breaker', () => {
  it('fires on a 0.6 logit jump with no score event: no fills, goal-length freeze', () => {
    const engine = createEngine(P());
    run(engine, [0, 5, 10, 15].map((t) => odds(t, CONST_PROBS)));
    // home logit jumps 0 → 0.6 (> max(5σ, 0.5)); other legs stay below 0.5
    const jump: [number, number, number] = [0.6457, 0.2126, 0.1417];
    const ev = engine.onTick(odds(20, jump));
    expect(trades(ev)).toHaveLength(0); // fill check skipped on the breaker tick
    const tr = transitions(ev);
    expect(tr).toHaveLength(1);
    expect(tr[0]!).toMatchObject({ to: 'frozen', reason: 'circuit_breaker' });
    expect(allNull(quoteSets(ev)[0]!)).toBe(true);

    // frozen for a goal-length window (30s): still dark at t=49, back at t=50
    const still = engine.onTick(odds(49, jump));
    expect(quoteSets(still)[0]!.riskState).toBe('frozen');
    const back = engine.onTick(odds(50, jump));
    expect(quoteSets(back)[0]!.riskState).toBe('quoting');
    expect(twoSided(quoteSets(back)[0]!)).toBe(true);
  });
});

describe('stale feed', () => {
  it('a gap ≥ staleFeedSec halts (cancelling resting quotes) then resumes on the same tick', () => {
    const engine = createEngine(P({ staleFeedSec: 10 }));
    run(engine, [0, 5, 10, 15].map((t) => odds(t, CONST_PROBS)));
    // 12.5s gap; mid drops through where our bid was resting — must NOT fill
    const ev = engine.onTick(odds(27.5, [0.44, 0.336, 0.224]));
    expect(trades(ev)).toHaveLength(0);
    const tr = transitions(ev);
    expect(tr).toHaveLength(2);
    expect(tr[0]!).toMatchObject({ from: 'quoting', to: 'halted', reason: 'stale_feed' });
    expect(tr[1]!).toMatchObject({ from: 'halted', to: 'quoting', reason: 'feed_resumed' });
    const q = quoteSets(ev)[0]!;
    expect(q.riskState).toBe('quoting');
    expect(twoSided(q)).toBe(true); // fresh quotes resume immediately
  });
});

describe('inventory cap → reduce_only', () => {
  // home falls 0.05/tick (crossing our bid → informed buys), draw rises
  // (crossing our ask → informed sells): u drifts to (+2, −2, 0).
  const path = (h: number): [number, number, number] => [h, 0.8 - h, 0.2];

  it('breaches the net-exposure cap, pulls risk-increasing sides, recovers', () => {
    const engine = createEngine(P({ warmupTicks: 1, inventoryCap: 2 }));
    run(engine, [odds(0, path(0.6)), odds(5, path(0.55))]);
    const t10 = run(engine, [odds(10, path(0.5))]);
    expect(trades(t10).map((t) => [t.outcome, t.side, t.fillType])).toEqual([
      ['home', 'buy', 'informed'],
      ['draw', 'sell', 'informed'],
    ]);
    const t15 = run(engine, [odds(15, path(0.45))]);
    expect(trades(t15)).toHaveLength(2); // q = (+2, −2, 0) ⇒ u = (+2, −2, 0)
    const tr15 = transitions(t15);
    expect(tr15).toHaveLength(1);
    expect(tr15[0]!).toMatchObject({ to: 'reduce_only', reason: 'inventory_cap' });
    const q15 = quoteSets(t15)[0]!;
    // risk-increasing sides pulled: long home ⇒ ask only; short draw ⇒ bid only
    expect(q15.quotes.home.bid).toBeNull();
    expect(q15.quotes.home.ask).not.toBeNull();
    expect(q15.quotes.draw.ask).toBeNull();
    expect(q15.quotes.draw.bid).not.toBeNull();
    expect(q15.quotes.away.bid).toBeNull(); // u=0: nothing to reduce
    expect(q15.quotes.away.ask).toBeNull();

    // still reduce-only while nothing reduces
    const t20 = run(engine, [odds(20, path(0.4))]);
    expect(quoteSets(t20)[0]!.riskState).toBe('reduce_only');

    // mean reversion crosses the reducing quotes → exposure normalizes
    const t25 = run(engine, [odds(25, path(0.5))]);
    expect(trades(t25).length).toBeGreaterThan(0);
    const back = transitions(t25);
    expect(back).toHaveLength(1);
    expect(back[0]!).toMatchObject({ from: 'reduce_only', to: 'quoting', reason: 'risk_normalized' });
  });
});

describe('drawdown → flatten', () => {
  const path = (h: number): [number, number, number] => [h, 0.8 - h, 0.2];

  it('equity drawdown ≥ maxDrawdown flips to reduce_only and stays sticky', () => {
    const engine = createEngine(P({ warmupTicks: 1, maxDrawdown: 0.05, inventoryCap: 999 }));
    run(engine, [odds(0, path(0.6)), odds(5, path(0.55))]);
    // adverse fills + continued drift: equity sinks past the 0.05 drawdown
    const evs = run(engine, [odds(10, path(0.5)), odds(15, path(0.45)), odds(20, path(0.4))]);
    const dd = transitions(evs).filter((t) => t.to === 'reduce_only');
    expect(dd.length).toBeGreaterThanOrEqual(1);
    expect(dd[0]!.reason).toBe('drawdown_flatten');

    // recovery does NOT clear the flatten flag (sticky until settlement)
    const rec = run(engine, [odds(25, path(0.5)), odds(30, path(0.55)), odds(35, path(0.55))]);
    for (const q of quoteSets(rec)) expect(q.riskState).toBe('reduce_only');
    expect(transitions(rec).filter((t) => t.to === 'quoting')).toHaveLength(0);
  });
});

describe('settlement', () => {
  it('fulltime 2-1 resolves home at 1, pays home inventory, zeroes the book', () => {
    const engine = createEngine(P({ warmupTicks: 1 }));
    run(engine, [odds(0, CONST_PROBS), odds(5, CONST_PROBS)]);
    // small dip fills only our home bid (bought 1 @ 0.493125)
    const fill = run(engine, [odds(10, [0.49, 0.306, 0.204])]);
    expect(trades(fill).map((t) => [t.outcome, t.side])).toEqual([['home', 'buy']]);
    const price = trades(fill)[0]!.priceProb;
    expect(price).toBeCloseTo(0.493125, 9);

    const ft = engine.onTick(score(15, 'fulltime', 2, 1));
    const settle = ft.find((e) => e.kind === 'settlement');
    expect(settle).toMatchObject({ winner: 'home', finalScore: { home: 2, away: 1 } });
    expect(settle!.kind === 'settlement' && settle!.realizedPnl).toBeCloseTo(1 - price, 9);
    const tr = transitions(ft);
    expect(tr).toHaveLength(1);
    expect(tr[0]!.to).toBe('settled');
    const book = books(ft)[0]!;
    expect(book.inventory).toEqual({ home: 0, draw: 0, away: 0 });
    expect(book.mtmPnl).toBe(0);
    expect(book.pnl.settlementResidual).toBeCloseTo(1 - 0.49, 9);
    // decomposition still balances after settlement
    const lhs = book.pnl.spreadCapture + book.pnl.inventoryDrift + book.pnl.settlementResidual;
    expect(Math.abs(lhs - (book.realizedPnl + book.mtmPnl))).toBeLessThanOrEqual(1e-9);

    // post-settlement ticks are not processed
    expect(engine.onTick(odds(20, CONST_PROBS))).toEqual([]);
    expect(engine.book(FX)!.realizedPnl).toBeCloseTo(1 - price, 9);
  });

  it('a level score settles as a draw', () => {
    const engine = createEngine(P());
    run(engine, [odds(0, CONST_PROBS)]);
    const ev = engine.onTick(score(5, 'fulltime', 1, 1));
    const settle = ev.find((e) => e.kind === 'settlement');
    expect(settle).toMatchObject({ winner: 'draw' });
  });
});

describe('suspension and malformed odds', () => {
  it('suspended ticks pull quotes without a state change; quoting resumes next tick', () => {
    const engine = createEngine(P({ warmupTicks: 1 }));
    run(engine, [odds(0, CONST_PROBS), odds(5, CONST_PROBS)]);
    const susp = run(engine, [odds(10, CONST_PROBS, { suspended: true })]);
    expect(trades(susp)).toHaveLength(0);
    expect(transitions(susp)).toHaveLength(0);
    const q = quoteSets(susp)[0]!;
    expect(allNull(q)).toBe(true);
    expect(q.riskState).toBe('quoting');
    const resume = run(engine, [odds(15, CONST_PROBS)]);
    expect(twoSided(quoteSets(resume)[0]!)).toBe(true);
  });

  it('malformed odds (leg ≤ 1.0, non-finite) are treated as suspended', () => {
    const engine = createEngine(P({ warmupTicks: 1 }));
    run(engine, [odds(0, CONST_PROBS), odds(5, CONST_PROBS)]);
    const bad = run(engine, [
      rawOdds(10, [1.0, 3.33, 5.0]), // leg ≤ 1.0 is an impossible price
      rawOdds(15, [2.0, Infinity, 5.0]),
      rawOdds(20, [2.0, 3.33, NaN]),
    ]);
    expect(trades(bad)).toHaveLength(0);
    for (const q of quoteSets(bad)) expect(allNull(q)).toBe(true);
    const resume = run(engine, [odds(25, CONST_PROBS)]);
    expect(twoSided(quoteSets(resume)[0]!)).toBe(true);
  });
});

describe('benign flow leg', () => {
  it('the intensity accumulator fills AT the quote once I crosses 1', () => {
    // benignA pinned (defaults are tunable) — benignK=0 ⇒ I += 0.12 per
    // resting tick per side ⇒ fill on the 9th accrual
    const engine = createEngine(P({ warmupTicks: 1, benignK: 0, benignA: 0.12 }));
    const all = run(
      engine,
      Array.from({ length: 12 }, (_, i) => odds(i * 5, CONST_PROBS)),
    );
    const ts = trades(all);
    expect(ts.length).toBe(6); // all three outcomes, both sides, once each
    for (const t of ts) {
      expect(t.fillType).toBe('benign');
      expect(t.ts).toBe(50_000); // first quotes at t=5s, 9th accrual at t=50s
      // buys at our bid (below fair), sells at our ask (above fair)
      if (t.side === 'buy') expect(t.priceProb).toBeLessThan(t.midAtFill);
      else expect(t.priceProb).toBeGreaterThan(t.midAtFill);
    }
    // net inventory unchanged; the round trips banked the spread
    const last = books(all).at(-1)!;
    expect(last.inventory).toEqual({ home: 0, draw: 0, away: 0 });
    expect(last.pnl.spreadCapture).toBeGreaterThan(0);
  });
});

describe('manual halt', () => {
  it('setHalted pulls quotes and blocks fills until resumed', () => {
    const engine = createEngine(P());
    run(engine, [0, 5, 10, 15].map((t) => odds(t, CONST_PROBS)));
    engine.setHalted(true, 'ops_halt');
    const halted = run(engine, [odds(20, [0.44, 0.336, 0.224])]); // would have crossed our bid
    expect(trades(halted)).toHaveLength(0);
    const tr = transitions(halted);
    expect(tr).toHaveLength(1);
    expect(tr[0]!).toMatchObject({ to: 'halted', reason: 'ops_halt' });
    expect(allNull(quoteSets(halted)[0]!)).toBe(true);
    engine.setHalted(false);
    const resumed = run(engine, [odds(25, CONST_PROBS)]);
    expect(quoteSets(resumed)[0]!.riskState).toBe('quoting');
    expect(twoSided(quoteSets(resumed)[0]!)).toBe(true);
  });
});

describe('multi-fixture isolation', () => {
  it('keeps independent state per fixtureId', () => {
    const engine = createEngine(P({ warmupTicks: 1 }));
    const other = 'other-fx';
    for (let i = 0; i < 3; i++) {
      engine.onTick(odds(i * 5, CONST_PROBS));
      engine.onTick({ ...odds(i * 5, [0.4, 0.35, 0.25]), fixtureId: other });
    }
    engine.onTick({ ...score(20, 'goal', 1, 0), fixtureId: other });
    const a = engine.onTick(odds(21, CONST_PROBS));
    const b = engine.onTick({ ...odds(21, [0.4, 0.35, 0.25]), fixtureId: other });
    expect((quoteSets(a)[0] as QuoteSet).riskState).toBe('quoting');
    expect((quoteSets(b)[0] as QuoteSet).riskState).toBe('frozen');
    expect(engine.book(FX)).not.toBeNull();
    expect(engine.book('missing')).toBeNull();
  });
});
