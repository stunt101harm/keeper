import { loadConfig, type EngineParams } from '../config.js';
import type {
  BookSnapshot,
  EngineEvent,
  MatchEventType,
  OddsTick,
  QuoteSet,
  RiskTransition,
  ScoreTick,
  Trade,
} from '../types.js';
import type { Engine } from './index.js';

export const FX = 'test-fx';

/** Reviewed defaults (env-independent: parsed from an empty env). */
export function baseParams(overrides: Partial<EngineParams> = {}): EngineParams {
  return { ...loadConfig({}).engine, ...overrides };
}

/** Odds tick from exact probabilities (odds = 1/p, so renormalization is identity). */
export function odds(
  tsSec: number,
  [h, d, a]: [number, number, number],
  extra: Partial<OddsTick> = {},
): OddsTick {
  return {
    kind: 'odds',
    fixtureId: FX,
    ts: tsSec * 1000,
    odds: { home: 1 / h, draw: 1 / d, away: 1 / a },
    ...extra,
  };
}

/** Odds tick with raw decimal odds (for malformed-leg scenarios). */
export function rawOdds(
  tsSec: number,
  [h, d, a]: [number, number, number],
  extra: Partial<OddsTick> = {},
): OddsTick {
  return {
    kind: 'odds',
    fixtureId: FX,
    ts: tsSec * 1000,
    odds: { home: h, draw: d, away: a },
    ...extra,
  };
}

export function score(
  tsSec: number,
  event: MatchEventType,
  home: number,
  away: number,
): ScoreTick {
  return { kind: 'score', fixtureId: FX, ts: tsSec * 1000, score: { home, away }, event };
}

export function run(engine: Engine, ticks: Array<OddsTick | ScoreTick>): EngineEvent[] {
  return ticks.flatMap((t) => engine.onTick(t));
}

export const quoteSets = (ev: EngineEvent[]): QuoteSet[] =>
  ev.filter((e): e is QuoteSet => e.kind === 'quotes');
export const trades = (ev: EngineEvent[]): Trade[] =>
  ev.filter((e): e is Trade => e.kind === 'trade');
export const transitions = (ev: EngineEvent[]): RiskTransition[] =>
  ev.filter((e): e is RiskTransition => e.kind === 'risk');
export const books = (ev: EngineEvent[]): BookSnapshot[] =>
  ev.filter((e): e is BookSnapshot => e.kind === 'book');

export const twoSided = (q: QuoteSet): boolean =>
  (['home', 'draw', 'away'] as const).some(
    (o) => q.quotes[o].bid !== null && q.quotes[o].ask !== null,
  );

export const allNull = (q: QuoteSet): boolean =>
  (['home', 'draw', 'away'] as const).every(
    (o) => q.quotes[o].bid === null && q.quotes[o].ask === null,
  );

/** Home bid/ask spread of a quote set (throws if a side is pulled). */
export function homeSpread(q: QuoteSet): number {
  const { bid, ask } = q.quotes.home;
  if (bid === null || ask === null) throw new Error(`home side pulled at ts=${q.ts}`);
  return ask - bid;
}
