import { describe, expect, it } from 'vitest';
import { createEngine } from './index.js';
import { allNull, baseParams, odds, quoteSets, transitions, twoSided } from './testutil.js';

describe('warmup', () => {
  it('emits no quotes during the first warmupTicks odds ticks, then starts quoting', () => {
    const engine = createEngine(baseParams({ warmupTicks: 5, staleFeedSec: 9999 }));
    const probs: [number, number, number] = [0.5, 0.3, 0.2];
    const warm = Array.from({ length: 5 }, (_, i) => engine.onTick(odds(i * 5, probs)));
    for (const ev of warm) {
      const q = quoteSets(ev)[0]!;
      expect(allNull(q)).toBe(true);
      expect(q.riskState).toBe('idle');
    }
    const sixth = engine.onTick(odds(25, probs));
    const tr = transitions(sixth);
    expect(tr).toHaveLength(1);
    expect(tr[0]!).toMatchObject({ from: 'idle', to: 'quoting', reason: 'warmup_complete' });
    expect(twoSided(quoteSets(sixth)[0]!)).toBe(true);
  });
});
