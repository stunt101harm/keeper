import type { EngineParams } from '../config.js';
import { OUTCOMES, type Outcome, type Quote } from '../types.js';
import { mapProbs, meanProbs, type Probs } from './fairvalue.js';
import { clamp, impliedAskProb, impliedBidProb } from './math.js';

export interface QuoteInputs {
  fair: Probs;
  /** Clamped σ_logit per outcome. */
  sigmaLogit: Probs;
  /** Net exposure u_i = q_i − mean(q). */
  netExposure: Probs;
  /** Re-entry widener w(t) ≥ 1. */
  widen: number;
  /** Reduce-only overlay: quote only risk-reducing sides. */
  reduceOnly: boolean;
  params: EngineParams;
}

export interface ComputedQuotes {
  quotes: Record<Outcome, Quote>;
  /** Distance of each live side from the reservation price (for benign-flow accrual). */
  delta: Record<Outcome, { bid: number; ask: number }>;
  reservation: Probs;
}

const EPS = 1e-9;
/** Sides quoted below/above these bounds are meaningless odds — pull them. */
const MIN_SIDE_PROB = 0.001;
const MAX_SIDE_PROB = 0.999;

/**
 * docs/MODEL.md §3–§4: sum-neutral inventory skew, vol-scaled spread with the
 * re-entry widener, quoting cutoffs with the risk-reducing side retained,
 * reduce-only side filtering, then two no-arb safety nets — one in prob space
 * (Σask ≥ 1 + 3δ_min, Σbid ≤ 1 − 3δ_min) and one on the published 2dp decimal
 * odds against `arbMargin`. Violations shift all three quotes uniformly.
 */
export function computeQuotes(inp: QuoteInputs): ComputedQuotes {
  const { fair, sigmaLogit, netExposure: u, widen, reduceOnly, params: p } = inp;

  const sigmaProb = mapProbs((o) => sigmaLogit[o] * fair[o] * (1 - fair[o]));
  const skew = mapProbs((o) => p.gamma * sigmaProb[o] * sigmaProb[o] * u[o]);
  const skewMean = meanProbs(skew);
  const reservation = mapProbs((o) => clamp(fair[o] - (skew[o] - skewMean), 0.01, 0.99));
  const halfSpread = mapProbs(
    (o) => clamp(p.deltaMin + p.kVol * sigmaProb[o], p.deltaMin, p.deltaMax) * widen,
  );

  const bid: Record<Outcome, number | null> = mapProbs((o) => reservation[o] - halfSpread[o]);
  const ask: Record<Outcome, number | null> = mapProbs((o) => reservation[o] + halfSpread[o]);

  for (const o of OUTCOMES) {
    // Quoting cutoffs: no NEW quotes outside [minQuoteProb, maxQuoteProb], but
    // the risk-reducing side stays if net exposure is held on the outcome.
    if (fair[o] < p.minQuoteProb || fair[o] > p.maxQuoteProb) {
      bid[o] = null;
      ask[o] = null;
      if (u[o] > EPS) ask[o] = reservation[o] + halfSpread[o];
      else if (u[o] < -EPS) bid[o] = reservation[o] - halfSpread[o];
    }
    // Reduce-only overlay: pull every risk-increasing side.
    if (reduceOnly) {
      if (u[o] > EPS) bid[o] = null;
      else if (u[o] < -EPS) ask[o] = null;
      else {
        bid[o] = null;
        ask[o] = null;
      }
    }
  }
  pullOutOfBounds(bid, ask);

  // Prob-space no-arb net: with clamped reservations Σr can drift off 1.
  const allAsks = () => OUTCOMES.every((o) => ask[o] !== null);
  const allBids = () => OUTCOMES.every((o) => bid[o] !== null);
  if (allAsks()) {
    const sum = (ask.home as number) + (ask.draw as number) + (ask.away as number);
    const need = 1 + 3 * p.deltaMin;
    if (sum < need) {
      const shift = (need - sum) / 3;
      for (const o of OUTCOMES) ask[o] = (ask[o] as number) + shift;
    }
  }
  if (allBids()) {
    const sum = (bid.home as number) + (bid.draw as number) + (bid.away as number);
    const cap = 1 - 3 * p.deltaMin;
    if (sum > cap) {
      const shift = (sum - cap) / 3;
      for (const o of OUTCOMES) bid[o] = (bid[o] as number) - shift;
    }
  }
  pullOutOfBounds(bid, ask);

  // Published decimal-odds no-arb check (post-rounding), margin = arbMargin.
  if (allAsks()) {
    for (let iter = 0; iter < 20; iter++) {
      const implied =
        impliedAskProb(ask.home as number) +
        impliedAskProb(ask.draw as number) +
        impliedAskProb(ask.away as number);
      if (implied >= 1 + p.arbMargin - 1e-9) break;
      const shift = (1 + p.arbMargin - implied) / 3 + 1e-4;
      for (const o of OUTCOMES) ask[o] = (ask[o] as number) + shift;
    }
  }
  if (allBids()) {
    for (let iter = 0; iter < 20; iter++) {
      const implied =
        impliedBidProb(bid.home as number) +
        impliedBidProb(bid.draw as number) +
        impliedBidProb(bid.away as number);
      if (implied <= 1 - p.arbMargin + 1e-9) break;
      const shift = (implied - (1 - p.arbMargin)) / 3 + 1e-4;
      for (const o of OUTCOMES) bid[o] = (bid[o] as number) - shift;
    }
  }
  pullOutOfBounds(bid, ask);

  return {
    quotes: {
      home: { bid: bid.home, ask: ask.home },
      draw: { bid: bid.draw, ask: ask.draw },
      away: { bid: bid.away, ask: ask.away },
    },
    delta: mapProbsPair(
      (o) => (bid[o] !== null ? reservation[o] - (bid[o] as number) : 0),
      (o) => (ask[o] !== null ? (ask[o] as number) - reservation[o] : 0),
    ),
    reservation,
  };
}

function pullOutOfBounds(
  bid: Record<Outcome, number | null>,
  ask: Record<Outcome, number | null>,
): void {
  for (const o of OUTCOMES) {
    const b = bid[o];
    const a = ask[o];
    if (b !== null && b <= MIN_SIDE_PROB) bid[o] = null;
    if (a !== null && a >= MAX_SIDE_PROB) ask[o] = null;
  }
}

function mapProbsPair(
  fBid: (o: Outcome) => number,
  fAsk: (o: Outcome) => number,
): Record<Outcome, { bid: number; ask: number }> {
  return {
    home: { bid: fBid('home'), ask: fAsk('home') },
    draw: { bid: fBid('draw'), ask: fAsk('draw') },
    away: { bid: fBid('away'), ask: fAsk('away') },
  };
}
