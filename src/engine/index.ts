import type { EngineParams } from '../config.js';
import {
  OUTCOMES,
  type BookSnapshot,
  type EngineEvent,
  type OddsTick,
  type Outcome,
  type Quote,
  type QuoteSet,
  type RiskStateName,
  type RiskTransition,
  type ScoreTick,
  type Tick,
  type Trade,
} from '../types.js';
import {
  applyFill,
  emptyBook,
  inventoryOf,
  mtmPnl,
  netExposureOf,
  settleBook,
  type PositionBook,
} from './book.js';
import { ewmaLambda, fairFromOdds, mapProbs, probRec, type Probs } from './fairvalue.js';
import { clamp, logit } from './math.js';
import { computeQuotes } from './quoting.js';

/**
 * The trading core. Implemented as a deterministic reducer: `onTick` is the
 * ONLY way state advances, and it never reads the wall clock — identical tick
 * streams produce identical event streams, byte for byte.
 *
 * `setHalted` is the one operational control (ops kill-switch). It is an
 * explicit external input; using it during a replay breaks determinism by
 * design, and that is documented behavior.
 */
export interface Engine {
  onTick(tick: Tick): EngineEvent[];
  /** Full reset (used on replay loop restart). */
  reset(): void;
  /** Current book for a fixture, for server hydration. */
  book(fixtureId: string): BookSnapshot | null;
  setHalted(halted: boolean, reason?: string): void;
}

interface RestingSide {
  price: number;
  /** Distance from the reservation price at publish time (benign-flow δ). */
  delta: number;
}
type RestingQuotes = Record<Outcome, { bid: RestingSide | null; ask: RestingSide | null }>;

interface FixtureState {
  id: string;
  /** Last emitted risk state (RiskTransitions diff against this). */
  state: RiskStateName;
  /** Usable (valid, non-suspended) odds ticks processed — warmup counter. */
  oddsCount: number;
  fair: Probs | null;
  prevLogit: Probs | null;
  /** Raw EWMA of squared winsorized d-logit; clamp on read. */
  sigma2: Probs;
  /** Skip the next σ update (first tick after a reopen / suspension gap). */
  skipSigma: boolean;
  frozenUntil: number;
  freezeReason: string;
  /** True while the current tick stream is inside a freeze window. */
  freezeActive: boolean;
  varActive: boolean;
  /** Re-entry widener ticks remaining. */
  reentryLeft: number;
  lastOddsTs: number | null;
  resting: RestingQuotes;
  benignAcc: Record<Outcome, { bid: number; ask: number }>;
  book: PositionBook;
  /** Equity high-water mark for the drawdown breaker. */
  hwm: number;
  /** Sticky drawdown flatten flag (reduce-only until settlement). */
  drawdownHit: boolean;
  settled: boolean;
  tradeSeq: number;
  lastBook: BookSnapshot | null;
}

const emptyResting = (): RestingQuotes => ({
  home: { bid: null, ask: null },
  draw: { bid: null, ask: null },
  away: { bid: null, ask: null },
});

const newFixtureState = (id: string, params: EngineParams): FixtureState => ({
  id,
  state: 'idle',
  oddsCount: 0,
  fair: null,
  prevLogit: null,
  sigma2: probRec(params.sigmaMin * params.sigmaMin),
  skipSigma: false,
  frozenUntil: -Infinity,
  freezeReason: '',
  freezeActive: false,
  varActive: false,
  reentryLeft: 0,
  lastOddsTs: null,
  resting: emptyResting(),
  benignAcc: {
    home: { bid: 0, ask: 0 },
    draw: { bid: 0, ask: 0 },
    away: { bid: 0, ask: 0 },
  },
  book: emptyBook(),
  hwm: 0,
  drawdownHit: false,
  settled: false,
  tradeSeq: 0,
  lastBook: null,
});

const NULL_QUOTES: Record<Outcome, Quote> = {
  home: { bid: null, ask: null },
  draw: { bid: null, ask: null },
  away: { bid: null, ask: null },
};

export function createEngine(params: EngineParams): Engine {
  const fixtures = new Map<string, FixtureState>();
  const lambda = ewmaLambda(params.ewmaHalfLifeTicks);
  let halted = false;
  let haltReason = 'manual_halt';

  const fx = (id: string): FixtureState => {
    let fs = fixtures.get(id);
    if (!fs) {
      fs = newFixtureState(id, params);
      fixtures.set(id, fs);
    }
    return fs;
  };

  const sigmaClamped = (fs: FixtureState): Probs =>
    mapProbs((o) => clamp(Math.sqrt(fs.sigma2[o]), params.sigmaMin, params.sigmaMax));

  const clearResting = (fs: FixtureState): void => {
    fs.resting = emptyResting();
  };

  const capBreached = (fs: FixtureState): boolean => {
    const u = netExposureOf(fs.book);
    return OUTCOMES.some((o) => Math.abs(u[o]) >= params.inventoryCap - 1e-9);
  };

  /** Effective risk state from the current flags (priority order matters). */
  const computeState = (fs: FixtureState, ts: number): RiskStateName => {
    if (fs.settled) return 'settled';
    if (halted) return 'halted';
    if (fs.oddsCount <= params.warmupTicks || fs.fair === null) return 'idle';
    if (ts < fs.frozenUntil) return 'frozen';
    if (fs.drawdownHit || capBreached(fs)) return 'reduce_only';
    return 'quoting';
  };

  const transitionReason = (fs: FixtureState, from: RiskStateName, to: RiskStateName): string => {
    switch (to) {
      case 'settled':
        return 'fulltime';
      case 'halted':
        return haltReason;
      case 'frozen':
        return fs.freezeReason;
      case 'reduce_only':
        return fs.drawdownHit ? 'drawdown_flatten' : 'inventory_cap';
      case 'quoting':
        if (from === 'idle') return 'warmup_complete';
        if (from === 'frozen') return 'freeze_reentry';
        if (from === 'halted') return 'feed_resumed';
        if (from === 'reduce_only') return 'risk_normalized';
        return 'resume';
      case 'idle':
        return 'warmup';
    }
  };

  /** Emit a transition to `to` (with an optional explicit reason) and record it. */
  const transition = (
    fs: FixtureState,
    ts: number,
    to: RiskStateName,
    reason?: string,
  ): RiskTransition => {
    const ev: RiskTransition = {
      kind: 'risk',
      fixtureId: fs.id,
      ts,
      from: fs.state,
      to,
      reason: reason ?? transitionReason(fs, fs.state, to),
    };
    fs.state = to;
    return ev;
  };

  const snapshot = (fs: FixtureState, ts: number): BookSnapshot => {
    const fair = fs.fair ?? probRec(0);
    const snap: BookSnapshot = {
      kind: 'book',
      fixtureId: fs.id,
      ts,
      inventory: inventoryOf(fs.book),
      netExposure: netExposureOf(fs.book),
      realizedPnl: fs.book.realized,
      mtmPnl: mtmPnl(fs.book, fair),
      pnl: {
        spreadCapture: fs.book.spreadCapture,
        inventoryDrift: fs.book.inventoryDrift,
        settlementResidual: fs.book.settlementResidual,
      },
      tradeCount: fs.book.tradeCount,
    };
    fs.lastBook = snap;
    return snap;
  };

  const quoteSet = (
    fs: FixtureState,
    ts: number,
    quotes: Record<Outcome, Quote>,
  ): QuoteSet => ({
    kind: 'quotes',
    fixtureId: fs.id,
    ts,
    fair: { ...(fs.fair ?? probRec(0)) },
    sigma: sigmaClamped(fs),
    quotes,
    riskState: fs.state,
  });

  const mkTrade = (
    fs: FixtureState,
    ts: number,
    outcome: Outcome,
    side: 'buy' | 'sell',
    price: number,
    mid: number,
    fillType: 'informed' | 'benign',
  ): Trade => {
    applyFill(fs.book, outcome, side, price, params.clipSize, mid);
    fs.tradeSeq += 1;
    return {
      kind: 'trade',
      tradeId: `${fs.id}:${fs.tradeSeq}`,
      fixtureId: fs.id,
      ts,
      outcome,
      side,
      priceProb: price,
      size: params.clipSize,
      midAtFill: mid,
      fillType,
    };
  };

  function onOdds(fs: FixtureState, tick: OddsTick): EngineEvent[] {
    const events: EngineEvent[] = [];
    const ts = tick.ts;

    // Stale-feed detection in FEED time: a gap ≥ staleFeedSec means our
    // resting quotes would have been pulled during the gap — halt, cancel,
    // skip this tick's fills, then resume with fresh quotes below.
    let staleResume = false;
    if (fs.lastOddsTs !== null && ts - fs.lastOddsTs >= params.staleFeedSec * 1000) {
      staleResume = true;
      if (fs.state === 'quoting' || fs.state === 'reduce_only') {
        events.push(transition(fs, ts, 'halted', 'stale_feed'));
      }
      clearResting(fs);
    }
    fs.lastOddsTs = ts;

    const fair = fairFromOdds(tick);
    if (fair === null) {
      // Suspension marker (explicit flag, malformed or missing legs): pull
      // quotes, keep fair/σ untouched, and skip the next σ update — the gap
      // is one repricing, not variance.
      clearResting(fs);
      fs.skipSigma = true;
      const st = computeState(fs, ts);
      if (st !== fs.state) events.push(transition(fs, ts, st));
      events.push(quoteSet(fs, ts, NULL_QUOTES));
      events.push(snapshot(fs, ts));
      return events;
    }

    let frozenNow = ts < fs.frozenUntil;
    const x = mapProbs((o) => logit(clamp(fair[o], 0.01, 0.99)));

    // Price circuit breaker: a |Δlogit| jump beyond max(mult·σ, abs) on any
    // leg starts a goal-length freeze; this tick's fill check is skipped.
    let breaker = false;
    if (!frozenNow && fs.prevLogit !== null) {
      const sig = sigmaClamped(fs);
      for (const o of OUTCOMES) {
        const d = Math.abs(x[o] - fs.prevLogit[o]);
        if (d > Math.max(params.jumpSigmaMult * sig[o], params.jumpLogitAbs)) {
          breaker = true;
          break;
        }
      }
      if (breaker) {
        fs.frozenUntil = Math.max(fs.frozenUntil, ts + params.freezeSec.goal * 1000);
        fs.freezeReason = 'circuit_breaker';
        clearResting(fs);
        frozenNow = true;
      }
    }

    // Freeze reopen: arm the widener and skip this tick's σ update.
    if (fs.freezeActive && !frozenNow) {
      fs.reentryLeft = params.reentryDecayTicks;
      fs.skipSigma = true;
    }
    fs.freezeActive = frozenNow;

    // Inventory drift: pre-fill inventory over the mid move.
    if (fs.fair !== null) {
      for (const o of OUTCOMES) {
        fs.book.inventoryDrift += fs.book.pos[o].q * (fair[o] - fs.fair[o]);
      }
    }
    fs.fair = fair;

    // Hardened EWMA on winsorized d-logit; frozen ticks and the first tick
    // after a reopen are one repricing, not variance.
    if (fs.prevLogit !== null && !frozenNow) {
      if (fs.skipSigma) {
        fs.skipSigma = false;
      } else {
        for (const o of OUTCOMES) {
          const d = clamp(x[o] - fs.prevLogit[o], -0.5, 0.5);
          fs.sigma2[o] = lambda * fs.sigma2[o] + (1 - lambda) * d * d;
        }
      }
    }
    fs.prevLogit = x;
    fs.oddsCount += 1;

    // Fills against RESTING quotes (posted on a previous tick).
    const trades: Trade[] = [];
    if (!frozenNow && !staleResume && !halted && !fs.settled) {
      for (const o of OUTCOMES) {
        const rest = fs.resting[o];
        // Informed leg: consensus mid crossing a resting quote fills it at our
        // price — max one per outcome-side per tick, re-quote next tick.
        if (rest.bid !== null && fair[o] <= rest.bid.price) {
          trades.push(mkTrade(fs, ts, o, 'buy', rest.bid.price, fair[o], 'informed'));
          rest.bid = null;
        } else if (rest.ask !== null && fair[o] >= rest.ask.price) {
          trades.push(mkTrade(fs, ts, o, 'sell', rest.ask.price, fair[o], 'informed'));
          rest.ask = null;
        }
        // Benign leg: deterministic intensity accumulator I += A·exp(−k_f·δ),
        // one clip AT our quote when I crosses 1.
        for (const sideKey of ['bid', 'ask'] as const) {
          const side = rest[sideKey];
          if (side === null) continue;
          const acc = fs.benignAcc[o];
          acc[sideKey] += params.benignA * Math.exp(-params.benignK * side.delta);
          if (acc[sideKey] >= 1) {
            acc[sideKey] -= 1;
            trades.push(
              mkTrade(fs, ts, o, sideKey === 'bid' ? 'buy' : 'sell', side.price, fair[o], 'benign'),
            );
          }
        }
      }
    }

    // Risk overlays: drawdown high-water mark is tracked on every tick.
    const equity = fs.book.realized + mtmPnl(fs.book, fair);
    if (equity > fs.hwm) fs.hwm = equity;
    if (fs.hwm - equity >= params.maxDrawdown - 1e-12) fs.drawdownHit = true;

    const st = computeState(fs, ts);

    // Quote computation (also posts the resting quotes for the next tick).
    let quotes: Record<Outcome, Quote> = NULL_QUOTES;
    clearResting(fs);
    if (st === 'quoting' || st === 'reduce_only') {
      const widen =
        fs.reentryLeft > 0
          ? 1 + (params.reentryWidenMult - 1) * (fs.reentryLeft / params.reentryDecayTicks)
          : 1;
      if (fs.reentryLeft > 0) fs.reentryLeft -= 1;
      const cq = computeQuotes({
        fair,
        sigmaLogit: sigmaClamped(fs),
        netExposure: netExposureOf(fs.book),
        widen,
        reduceOnly: st === 'reduce_only',
        params,
      });
      quotes = cq.quotes;
      for (const o of OUTCOMES) {
        const q = cq.quotes[o];
        fs.resting[o] = {
          bid: q.bid !== null ? { price: q.bid, delta: cq.delta[o].bid } : null,
          ask: q.ask !== null ? { price: q.ask, delta: cq.delta[o].ask } : null,
        };
      }
    }

    events.push(...trades);
    if (st !== fs.state) events.push(transition(fs, ts, st));
    events.push(quoteSet(fs, ts, quotes));
    events.push(snapshot(fs, ts));
    return events;
  }

  function onScore(fs: FixtureState, tick: ScoreTick): EngineEvent[] {
    const events: EngineEvent[] = [];
    const ts = tick.ts;
    const ev = tick.event;

    if (ev === 'fulltime') {
      const winner: Outcome =
        tick.score.home > tick.score.away
          ? 'home'
          : tick.score.away > tick.score.home
            ? 'away'
            : 'draw';
      settleBook(fs.book, winner, fs.fair ?? probRec(0));
      fs.settled = true;
      clearResting(fs);
      events.push(transition(fs, ts, 'settled', 'fulltime'));
      events.push({
        kind: 'settlement',
        fixtureId: fs.id,
        ts,
        winner,
        finalScore: { home: tick.score.home, away: tick.score.away },
        realizedPnl: fs.book.realized,
      });
      events.push(snapshot(fs, ts));
      return events;
    }

    if (ev === 'goal' || ev === 'red_card' || ev === 'var') {
      // Freeze window in FEED time. A goal/red card arriving during an active
      // VAR review is its resolution.
      fs.frozenUntil = Math.max(fs.frozenUntil, ts + params.freezeSec[ev] * 1000);
      fs.freezeReason = `${ev}_freeze`;
      fs.varActive = ev === 'var';
      fs.freezeActive = true;
      clearResting(fs);
      const st = computeState(fs, ts);
      if (st !== fs.state) {
        events.push(transition(fs, ts, st));
        events.push(snapshot(fs, ts));
      }
      return events;
    }

    // Any other score event while a VAR review is pending resolves it:
    // freeze runs to resolution + 10 s (never beyond the configured cap).
    if (fs.varActive) {
      fs.varActive = false;
      fs.frozenUntil = Math.min(fs.frozenUntil, ts + 10_000);
    }
    return events;
  }

  return {
    onTick(tick: Tick): EngineEvent[] {
      const fs = fx(tick.fixtureId);
      if (fs.settled) return [];
      return tick.kind === 'odds' ? onOdds(fs, tick) : onScore(fs, tick);
    },

    reset(): void {
      fixtures.clear();
    },

    book(fixtureId: string): BookSnapshot | null {
      return fixtures.get(fixtureId)?.lastBook ?? null;
    },

    setHalted(h: boolean, reason?: string): void {
      halted = h;
      haltReason = reason ?? (h ? 'manual_halt' : 'manual_resume');
      if (h) {
        // Cancel every resting quote immediately: no fills while halted.
        for (const fs of fixtures.values()) clearResting(fs);
      }
    },
  };
}
