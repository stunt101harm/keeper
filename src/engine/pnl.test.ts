import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRecording } from '../replay/recording.js';
import { createEngine } from './index.js';
import { baseParams, books } from './testutil.js';

describe('P&L decomposition invariant', () => {
  it('spreadCapture + inventoryDrift + settlementResidual = realized + mtm at every BookSnapshot', () => {
    const engine = createEngine(baseParams());
    const url = new URL('../../data/sample-match.jsonl', import.meta.url);
    const { ticks } = parseRecording(readFileSync(url, 'utf8'));
    const snaps = books(ticks.flatMap((t) => engine.onTick(t)));
    expect(snaps.length).toBeGreaterThan(500);
    for (const b of snaps) {
      const lhs = b.pnl.spreadCapture + b.pnl.inventoryDrift + b.pnl.settlementResidual;
      const rhs = b.realizedPnl + b.mtmPnl;
      expect(Math.abs(lhs - rhs)).toBeLessThanOrEqual(1e-6);
    }
  });
});
