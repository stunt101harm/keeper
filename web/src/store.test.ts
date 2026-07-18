import { describe, expect, it } from 'vitest';
import { devig, thin } from './store';

describe('devig', () => {
  it('renormalizes implied probabilities to sum 1', () => {
    const p = devig({ home: 2.0, draw: 4.0, away: 4.0 });
    expect(p).not.toBeNull();
    const sum = p!.home + p!.draw + p!.away;
    expect(sum).toBeCloseTo(1, 12);
    expect(p!.home).toBeCloseTo(0.5, 12);
    expect(p!.draw).toBeCloseTo(0.25, 12);
  });

  it('removes the vig proportionally', () => {
    // 1/2.24 + 1/3.35 + 1/3.17 > 1 (overround) — devig must normalize it away
    const p = devig({ home: 2.24, draw: 3.35, away: 3.17 });
    expect(p!.home + p!.draw + p!.away).toBeCloseTo(1, 12);
    expect(p!.home).toBeGreaterThan(p!.away);
  });

  it('returns null on non-finite input', () => {
    expect(devig({ home: 0, draw: 3, away: 3 })).toBeNull();
    expect(devig({ home: Infinity, draw: 3, away: 3 })).toBeNull();
  });
});

describe('thin', () => {
  it('leaves arrays under the cap untouched', () => {
    const a = [1, 2, 3];
    expect(thin(a, 5)).toBe(a);
  });

  it('halves the older half once the cap is exceeded', () => {
    const a = Array.from({ length: 100 }, (_, i) => i);
    const out = thin(a, 99);
    // newest half fully retained
    expect(out.slice(-50)).toEqual(a.slice(-50));
    // older half thinned 2:1
    expect(out.length).toBe(75);
    // order preserved
    expect([...out].sort((x, y) => x - y)).toEqual(out);
  });
});
