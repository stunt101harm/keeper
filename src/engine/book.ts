import { OUTCOMES, type Outcome } from '../types.js';
import { mapProbs, meanProbs, type Probs } from './fairvalue.js';

/**
 * Position + P&L ledger for one fixture. Average-cost accounting:
 * `cost` is the signed cost basis of the open position (avgPrice · q), so
 * MTM of the position is q·p − cost for longs and shorts alike.
 *
 * Decomposition ledgers (cumulative, docs/MODEL.md §8):
 *   spreadCapture      Σ_fills side·(mid_at_fill − fill_price)·size
 *   inventoryDrift     Σ_ticks q·Δmid (pre-fill inventory over each mid move)
 *   settlementResidual Σ q·(settled_value − last_mark) at full time
 * Invariant: spreadCapture + inventoryDrift + settlementResidual
 *          = realized + mtm at every tick (unit-tested).
 */
export interface Position {
  q: number;
  cost: number;
}

export interface PositionBook {
  pos: Record<Outcome, Position>;
  realized: number;
  spreadCapture: number;
  inventoryDrift: number;
  settlementResidual: number;
  tradeCount: number;
}

export function emptyBook(): PositionBook {
  return {
    pos: {
      home: { q: 0, cost: 0 },
      draw: { q: 0, cost: 0 },
      away: { q: 0, cost: 0 },
    },
    realized: 0,
    spreadCapture: 0,
    inventoryDrift: 0,
    settlementResidual: 0,
    tradeCount: 0,
  };
}

/**
 * Apply one fill at `price` (prob space) with consensus mid `mid` at fill time.
 * Closing legs realize (price − avgCost) P&L; opening legs extend the basis.
 * A fill crossing through zero is split into a close + an open.
 */
export function applyFill(
  book: PositionBook,
  outcome: Outcome,
  side: 'buy' | 'sell',
  price: number,
  size: number,
  mid: number,
): void {
  book.spreadCapture += (side === 'buy' ? mid - price : price - mid) * size;
  const dir = side === 'buy' ? 1 : -1;
  const p = book.pos[outcome];
  let remaining = size;
  if (p.q !== 0 && Math.sign(p.q) !== dir) {
    const closeQty = Math.min(remaining, Math.abs(p.q));
    const avg = p.cost / p.q;
    book.realized += (p.q > 0 ? price - avg : avg - price) * closeQty;
    p.q += dir * closeQty;
    p.cost = avg * p.q;
    remaining -= closeQty;
  }
  if (remaining > 0) {
    p.q += dir * remaining;
    p.cost += dir * remaining * price;
  }
  book.tradeCount += 1;
}

/** Mark-to-market P&L of the open book against the given fair marks. */
export function mtmPnl(book: PositionBook, fair: Probs): number {
  let mtm = 0;
  for (const o of OUTCOMES) {
    const p = book.pos[o];
    mtm += p.q * fair[o] - p.cost;
  }
  return mtm;
}

/** Signed inventory per outcome. */
export function inventoryOf(book: PositionBook): Probs {
  return mapProbs((o) => book.pos[o].q);
}

/** Net exposure u_i = q_i − mean(q): the risk-bearing, sum-zero component. */
export function netExposureOf(book: PositionBook): Probs {
  const inv = inventoryOf(book);
  const m = meanProbs(inv);
  return mapProbs((o) => inv[o] - m);
}

/**
 * Settle at full time: outcomes resolve 0/1 from the winner, every position
 * realizes against its settled value, and the residual vs the final marks is
 * recorded so the P&L identity keeps holding after mtm collapses to zero.
 */
export function settleBook(book: PositionBook, winner: Outcome, lastMarks: Probs): void {
  for (const o of OUTCOMES) {
    const v = o === winner ? 1 : 0;
    const p = book.pos[o];
    book.realized += p.q * v - p.cost;
    book.settlementResidual += p.q * (v - lastMarks[o]);
    p.q = 0;
    p.cost = 0;
  }
}
