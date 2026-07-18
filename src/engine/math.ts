/** Small deterministic numeric helpers shared by the engine modules. */

export const clamp = (x: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, x));

/** logit of a probability already clamped away from {0,1} by the caller. */
export const logit = (p: number): number => Math.log(p / (1 - p));

/**
 * Decimal-odds rounding at the presentation edge, in the spread-WIDENING
 * direction: ask odds round DOWN (implied ask prob up), bid odds round UP
 * (implied bid prob down). The 1e-9 nudge absorbs float noise like
 * 1/0.4 = 2.5000000000000004.
 */
export const floorOdds2 = (odds: number): number => Math.floor(odds * 100 + 1e-9) / 100;
export const ceilOdds2 = (odds: number): number => Math.ceil(odds * 100 - 1e-9) / 100;

/** Published implied probability of an ask quoted at prob `p` (odds floor-rounded). */
export const impliedAskProb = (p: number): number => 1 / floorOdds2(1 / p);
/** Published implied probability of a bid quoted at prob `p` (odds ceil-rounded). */
export const impliedBidProb = (p: number): number => 1 / ceilOdds2(1 / p);
