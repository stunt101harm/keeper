import { OUTCOMES, type OddsTick, type Outcome } from '../types.js';

/** A per-outcome record of numbers (probabilities, sigmas, exposures, ...). */
export type Probs = Record<Outcome, number>;

export const probRec = (v: number): Probs => ({ home: v, draw: v, away: v });

export const mapProbs = (f: (o: Outcome) => number): Probs => ({
  home: f('home'),
  draw: f('draw'),
  away: f('away'),
});

export const meanProbs = (r: Probs): number => (r.home + r.draw + r.away) / 3;

/**
 * Fair value from a consensus odds tick: implied pcts renormalized to sum 1
 * (defensive de-vig — the source is already demargined).
 *
 * Guards (docs/MODEL.md §1): all three legs present, finite, odds > 1.0
 * (⇒ pct ∈ (0,1)); anything else — including an explicit `suspended` flag —
 * makes the tick unusable and the caller treats it as a suspension marker.
 * Returns null for unusable ticks.
 */
export function fairFromOdds(tick: OddsTick): Probs | null {
  if (tick.suspended) return null;
  let sum = 0;
  const pct: Partial<Probs> = {};
  for (const o of OUTCOMES) {
    const odds = tick.odds?.[o];
    if (typeof odds !== 'number' || !Number.isFinite(odds) || odds <= 1.0) return null;
    const p = 1 / odds;
    pct[o] = p;
    sum += p;
  }
  if (!(sum > 0) || !Number.isFinite(sum)) return null;
  return {
    home: (pct.home as number) / sum,
    draw: (pct.draw as number) / sum,
    away: (pct.away as number) / sum,
  };
}

/** EWMA decay factor for a half-life expressed in ticks: λ = 2^(−1/H). */
export const ewmaLambda = (halfLifeTicks: number): number => Math.pow(2, -1 / halfLifeTicks);
