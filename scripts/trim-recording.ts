/**
 * Trim a recording to a window around the match so replay loops start near
 * kickoff instead of crawling through days of sparse pre-match records.
 *
 *   tsx scripts/trim-recording.ts <file> [preMinutes=30] [postMinutes=20]
 *
 * Window: [kickoffTs − preMinutes, fulltimeTs + postMinutes] (falls back to
 * the last tick when no fulltime event exists). Rewrites the file in place.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseRecording } from '../src/replay/recording.js';
import type { Tick } from '../src/types.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx scripts/trim-recording.ts <file> [preMin] [postMin]');
  process.exit(1);
}
const preMin = Number(process.argv[3] ?? 30);
const postMin = Number(process.argv[4] ?? 20);

const { fixture, ticks } = parseRecording(readFileSync(file, 'utf8'));
if (!fixture) {
  console.error('recording has no meta line');
  process.exit(1);
}
const fulltime = ticks.find((t): t is Tick & { kind: 'score' } => t.kind === 'score' && t.event === 'fulltime');
const from = fixture.kickoffTs - preMin * 60_000;
const to = (fulltime?.ts ?? ticks[ticks.length - 1]!.ts) + postMin * 60_000;
const kept = ticks.filter((t) => t.ts >= from && t.ts <= to);

const lines = [JSON.stringify({ kind: 'meta', fixture }), ...kept.map((t) => JSON.stringify(t))];
writeFileSync(file, lines.join('\n') + '\n');
console.log(
  `trimmed ${file}: ${ticks.length} -> ${kept.length} ticks, ` +
    `${new Date(from).toISOString()} .. ${new Date(to).toISOString()}`,
);
