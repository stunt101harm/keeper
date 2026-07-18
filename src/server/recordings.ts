/**
 * recordings.ts — safe enumeration/resolution of data/*.jsonl recordings for
 * the recordings API (docs/CONTRACTS-WAVE2.md).
 *
 * A "recording" is any *.jsonl in the data dir EXCEPT the blotters the
 * anchorer/ops write there (events*.jsonl, anchors*.jsonl). Filenames are
 * basename-validated before touching the filesystem — the download and select
 * endpoints must never traverse out of the data dir.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FixtureInfo } from '../types.js';

export interface RecordingSummary {
  file: string;
  fixture: FixtureInfo | null;
  ticks: number;
  bytes: number;
}

const BLOTTER_RE = /^(events|anchors)([.\-_]|$)/;

/** Basename-only, *.jsonl, not a blotter, no hidden files. */
export function isRecordingFilename(file: string): boolean {
  return (
    file.length > 0 &&
    file === path.basename(file) &&
    !file.startsWith('.') &&
    file.endsWith('.jsonl') &&
    !BLOTTER_RE.test(file)
  );
}

/** Resolve a client-supplied name to a real file inside dir, or null. */
export function resolveRecording(dir: string, file: string): string | null {
  if (!isRecordingFilename(file)) return null;
  const full = path.join(dir, file);
  return existsSync(full) ? full : null;
}

export function listRecordings(dir: string): RecordingSummary[] {
  if (!existsSync(dir)) return [];
  const out: RecordingSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!isRecordingFilename(file)) continue;
    try {
      const full = path.join(dir, file);
      const bytes = statSync(full).size;
      let fixture: FixtureInfo | null = null;
      let ticks = 0;
      for (const raw of readFileSync(full, 'utf8').split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { kind?: string; fixture?: FixtureInfo };
          if (parsed.kind === 'meta') fixture = parsed.fixture ?? null;
          else ticks++;
        } catch {
          // junk line — not counted
        }
      }
      out.push({ file, fixture, ticks, bytes });
    } catch {
      // unreadable file — skip rather than fail the listing
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file));
  return out;
}
