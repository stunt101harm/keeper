import type { FixtureInfo, Tick } from '../types.js';

/**
 * A recording is a JSONL file: first line is a meta record describing the
 * fixture, every following line is a normalized Tick in ts order.
 */
export type RecordingLine = { kind: 'meta'; fixture: FixtureInfo } | Tick;

export function parseRecording(text: string): { fixture: FixtureInfo | null; ticks: Tick[] } {
  let fixture: FixtureInfo | null = null;
  const ticks: Tick[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = JSON.parse(line) as RecordingLine;
    if (parsed.kind === 'meta') {
      fixture = parsed.fixture;
    } else {
      ticks.push(parsed);
    }
  }
  ticks.sort((a, b) => a.ts - b.ts);
  return { fixture, ticks };
}
