import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseRecording } from '../replay/recording.js';
import type { EngineEvent, Tick } from '../types.js';
import { createEngine, type Engine } from './index.js';
import { baseParams } from './testutil.js';

const sampleTicks = (): Tick[] => {
  const url = new URL('../../data/sample-match.jsonl', import.meta.url);
  return parseRecording(readFileSync(url, 'utf8')).ticks;
};

const runAll = (engine: Engine, ticks: Tick[]): EngineEvent[] =>
  ticks.flatMap((t) => engine.onTick(t));

describe('determinism', () => {
  it('two fresh engines produce byte-identical event streams on the sample match', () => {
    const ticks = sampleTicks();
    const a = runAll(createEngine(baseParams()), ticks);
    const b = runAll(createEngine(baseParams()), ticks);
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('one engine replaying twice with reset() in between is identical', () => {
    const ticks = sampleTicks();
    const engine = createEngine(baseParams());
    const first = runAll(engine, ticks);
    engine.reset();
    const second = runAll(engine, ticks);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
