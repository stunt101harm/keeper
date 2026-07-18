import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRecording } from '../replay/recording.js';
import { OUTCOMES } from '../types.js';
import { createEngine } from './index.js';
import { ceilOdds2, floorOdds2 } from './math.js';
import { baseParams, quoteSets } from './testutil.js';

describe('no-arb property (sample match, every emitted QuoteSet)', () => {
  const params = baseParams();
  const url = new URL('../../data/sample-match.jsonl', import.meta.url);
  const { ticks } = parseRecording(readFileSync(url, 'utf8'));
  const qs = quoteSets(
    (() => {
      const engine = createEngine(params);
      return ticks.flatMap((t) => engine.onTick(t));
    })(),
  );

  it('probability-space sums respect the structural overround', () => {
    let checkedAsks = 0;
    let checkedBids = 0;
    for (const q of qs) {
      const asks = OUTCOMES.map((o) => q.quotes[o].ask);
      const bids = OUTCOMES.map((o) => q.quotes[o].bid);
      if (asks.every((a): a is number => a !== null)) {
        checkedAsks++;
        const sum = asks[0]! + asks[1]! + asks[2]!;
        expect(sum).toBeGreaterThanOrEqual(1 + 3 * params.deltaMin - 1e-9);
      }
      if (bids.every((b): b is number => b !== null)) {
        checkedBids++;
        const sum = bids[0]! + bids[1]! + bids[2]!;
        expect(sum).toBeLessThanOrEqual(1 - 3 * params.deltaMin + 1e-9);
      }
    }
    expect(checkedAsks).toBeGreaterThan(100);
    expect(checkedBids).toBeGreaterThan(100);
  });

  it('published decimal odds (ask rounded down, bid rounded up, 2dp) respect arbMargin', () => {
    let checked = 0;
    for (const q of qs) {
      const asks = OUTCOMES.map((o) => q.quotes[o].ask);
      const bids = OUTCOMES.map((o) => q.quotes[o].bid);
      if (asks.every((a): a is number => a !== null)) {
        checked++;
        const implied = asks.reduce((s, a) => s + 1 / floorOdds2(1 / (a as number)), 0);
        expect(implied).toBeGreaterThanOrEqual(1 + params.arbMargin - 1e-9);
      }
      if (bids.every((b): b is number => b !== null)) {
        const implied = bids.reduce((s, b) => s + 1 / ceilOdds2(1 / (b as number)), 0);
        expect(implied).toBeLessThanOrEqual(1 - params.arbMargin + 1e-9);
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});
