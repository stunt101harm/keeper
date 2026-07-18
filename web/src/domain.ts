/**
 * Presentation-edge domain glue.
 *
 * All wire types are imported (type-only, erased at build time) from the root
 * contract file src/types.ts via the `@keeper/types` alias — never duplicated.
 * Values that the root exports (OUTCOMES) are re-declared here because the web
 * bundle must not pull runtime code from the node tree.
 */
export type {
  AnchorBatch,
  BookSnapshot,
  BusEvent,
  EngineEvent,
  FixtureInfo,
  MatchEventType,
  OddsTick,
  Outcome,
  Quote,
  QuoteSet,
  RiskStateName,
  RiskTransition,
  ScoreTick,
  SettlementEvent,
  StatusEvent,
  Tick,
  Trade,
} from '@keeper/types';

import type {
  AnchorBatch,
  BookSnapshot,
  FixtureInfo,
  Outcome,
  QuoteSet,
  RiskStateName,
  RiskTransition,
  ScoreTick,
  SettlementEvent,
  StatusEvent,
  Trade,
} from '@keeper/types';

export const OUTCOMES: readonly Outcome[] = ['home', 'draw', 'away'] as const;

/** Validated dark-surface categorical palette (CVD-checked as a set). */
export const OUTCOME_COLOR: Record<Outcome, string> = {
  home: '#3987e5',
  draw: '#c98500',
  away: '#e66767',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  home: 'HOME',
  draw: 'DRAW',
  away: 'AWAY',
};

/** P&L decomposition series colors — distinct entities, distinct hues. */
export const PNL_COLOR = {
  spreadCapture: '#199e70',
  inventoryDrift: '#9085e9',
  settlementResidual: '#d55181',
} as const;

export const RISK_BADGE: Record<RiskStateName, { label: string; color: string; bg: string }> = {
  idle: { label: 'IDLE', color: '#9aa4b2', bg: 'rgba(154,164,178,0.12)' },
  quoting: { label: 'QUOTING', color: '#0ca30c', bg: 'rgba(12,163,12,0.14)' },
  frozen: { label: 'FROZEN', color: '#fab219', bg: 'rgba(250,178,25,0.14)' },
  reduce_only: { label: 'REDUCE-ONLY', color: '#ec835a', bg: 'rgba(236,131,90,0.14)' },
  halted: { label: 'HALTED', color: '#d03b3b', bg: 'rgba(208,59,59,0.16)' },
  settled: { label: 'SETTLED', color: '#9aa4b2', bg: 'rgba(154,164,178,0.12)' },
};

/** Engine params as served by /api/state (EngineParams lives in root config.ts — node-only). */
export interface ParamsView {
  inventoryCap?: number;
  maxDrawdown?: number;
  clipSize?: number;
  deltaMin?: number;
  deltaMax?: number;
  [k: string]: unknown;
}

export interface Metrics {
  ticksIn: number;
  quotesOut: number;
  trades: number;
  anchorsConfirmed: number;
  anchorsFailed: number;
}

/** Shape of one fixture's slice of GET /api/state. */
export interface FixtureSnapshot {
  fixture: FixtureInfo | null;
  latestQuotes: QuoteSet | null;
  latestScore: ScoreTick | null;
  book: BookSnapshot | null;
  chart: QuoteSet[];
  trades: Trade[];
  riskLog: RiskTransition[];
  /** Wave-2 (optional until the server ships it): last settlement, if any. */
  settlement?: SettlementEvent | null;
}

/** One keeper_book PDA's projected state (wave-2 contract, docs/CONTRACTS-WAVE2.md). */
export interface OnchainBook {
  address: string;
  latestRoot: string;
  seqEnd: number;
  epochCount: number;
  status: 'open' | 'settled';
  provenGoals?: [number, number];
  winner?: 'p1' | 'draw' | 'p2';
  settleSig?: string;
  explorerUrl: string;
}

export interface OnchainState {
  programId: string;
  network: 'devnet';
  books: Record<string, OnchainBook>;
}

/** One entry of GET /api/recordings (wave-2 contract). */
export interface RecordingInfo {
  file: string;
  fixture: FixtureInfo | null;
  ticks: number;
  bytes: number;
}

/** Shape of GET /api/state. */
export interface ServerSnapshot {
  mode: 'live' | 'replay';
  replay?: { file: string; speed: number; loop: boolean };
  params: ParamsView;
  halted: boolean;
  status: StatusEvent | null;
  metrics: Metrics;
  anchors: AnchorBatch[];
  fixtures: Record<string, FixtureSnapshot>;
  /** Wave-2: what the orchestrator is actually running right now. */
  activeSource?: 'live' | 'replay';
  /** Wave-2: keeper_book program projection, when the chain module is wired. */
  onchain?: OnchainState;
}
