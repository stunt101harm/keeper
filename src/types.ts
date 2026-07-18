/**
 * Core domain types shared by every module.
 *
 * Contract rules:
 * - All prices inside the engine are PROBABILITIES in (0,1). Decimal odds (1/p)
 *   exist only at the presentation edge (dashboard, logs).
 * - The engine is a pure reducer over Ticks: it never reads the wall clock.
 *   Every timestamp it sees comes from a tick (`ts`, ms epoch).
 * - `side` is from Keeper's perspective: 'buy' = our bid was hit (inventory up),
 *   'sell' = our ask was lifted (inventory down).
 */

export type Outcome = 'home' | 'draw' | 'away';
export const OUTCOMES: readonly Outcome[] = ['home', 'draw', 'away'] as const;

// ---------------------------------------------------------------------------
// Normalized input ticks (produced by ingest/replay, consumed by engine)
// ---------------------------------------------------------------------------

export interface OddsTick {
  kind: 'odds';
  fixtureId: string;
  /** Source timestamp, ms epoch. */
  ts: number;
  /** Consensus decimal odds per outcome. */
  odds: Record<Outcome, number>;
  /** True when the source marks the market suspended (odds may be stale). */
  suspended?: boolean;
}

export type MatchEventType =
  | 'kickoff'
  | 'goal'
  | 'red_card'
  | 'var'
  | 'halftime'
  | 'second_half'
  | 'fulltime'
  | 'other';

export interface ScoreTick {
  kind: 'score';
  fixtureId: string;
  ts: number;
  score: { home: number; away: number };
  /** Match minute if known. */
  minute?: number;
  event: MatchEventType;
}

export type Tick = OddsTick | ScoreTick;

export interface FixtureInfo {
  id: string;
  home: string;
  away: string;
  kickoffTs: number;
  competition: string;
}

// ---------------------------------------------------------------------------
// Engine outputs (events emitted by the reducer)
// ---------------------------------------------------------------------------

/** One side of a quote in probability space; null = side pulled. */
export interface Quote {
  bid: number | null;
  ask: number | null;
}

export type RiskStateName =
  | 'idle' // before first usable odds tick
  | 'quoting' // normal operation
  | 'frozen' // goal/VAR/red-card freeze window
  | 'reduce_only' // inventory cap or drawdown breach: only risk-reducing side quoted
  | 'halted' // stale feed or manual halt: all quotes pulled
  | 'settled'; // full time reached, book settled

export interface QuoteSet {
  kind: 'quotes';
  fixtureId: string;
  ts: number;
  /** De-vigged fair probability per outcome. */
  fair: Record<Outcome, number>;
  /** EWMA volatility of logit(p) per outcome. */
  sigma: Record<Outcome, number>;
  quotes: Record<Outcome, Quote>;
  riskState: RiskStateName;
}

export interface Trade {
  kind: 'trade';
  tradeId: string;
  fixtureId: string;
  ts: number;
  outcome: Outcome;
  side: 'buy' | 'sell';
  /** Execution price (probability space) = our resting quote. */
  priceProb: number;
  size: number;
  /** Consensus fair prob at fill time (for slippage/adverse-selection analysis). */
  midAtFill: number;
}

export interface RiskTransition {
  kind: 'risk';
  fixtureId: string;
  ts: number;
  from: RiskStateName;
  to: RiskStateName;
  reason: string;
}

export interface SettlementEvent {
  kind: 'settlement';
  fixtureId: string;
  ts: number;
  winner: Outcome;
  finalScore: { home: number; away: number };
  realizedPnl: number;
}

export interface BookSnapshot {
  kind: 'book';
  fixtureId: string;
  ts: number;
  /** Signed inventory per outcome (stake units). */
  inventory: Record<Outcome, number>;
  realizedPnl: number;
  /** Mark-to-market P&L of open inventory vs current fair. */
  mtmPnl: number;
  tradeCount: number;
}

export type EngineEvent = QuoteSet | Trade | RiskTransition | SettlementEvent | BookSnapshot;

// ---------------------------------------------------------------------------
// Side-effect world events (anchoring, status) — these MAY use wall clock
// ---------------------------------------------------------------------------

export interface AnchorBatch {
  kind: 'anchor';
  ts: number;
  /** Inclusive sequence range of engine events covered by this batch. */
  seqStart: number;
  seqEnd: number;
  /** Hex merkle root over canonical-JSON event leaves. */
  root: string;
  status: 'pending' | 'confirmed' | 'failed';
  sig?: string;
  explorerUrl?: string;
  error?: string;
}

export interface StatusEvent {
  kind: 'status';
  ts: number;
  mode: 'live' | 'replay';
  feed: 'ok' | 'stale' | 'disconnected';
  lastTickTs: number | null;
  fixtures: FixtureInfo[];
  /** TxLINE on-chain proof verification status per fixture, if checked. */
  proofStatus?: Record<string, 'verified' | 'unverified' | 'failed'>;
}

/** Everything that flows over the event bus. */
export type BusEvent = Tick | EngineEvent | AnchorBatch | StatusEvent;
