import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Bus } from '../bus.js';
import { log } from '../log.js';
import type { FixtureInfo, Tick } from '../types.js';

/**
 * Appends every tick to a per-fixture JSONL recording. Runs whenever live
 * ingestion is active: in live mode via attach(bus); in auto mode the
 * composition root calls record() directly from the live onTick path so
 * replay-phase ticks (which also cross the bus) are never recorded.
 * Recordings are the substrate for replay demos, judge testing, and golden
 * tests.
 */
export class Recorder {
  private streams = new Map<string, WriteStream>();
  private metaWritten = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly fixtures: Map<string, FixtureInfo>,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  attach(bus: Bus): void {
    bus.on('tick', (tick) => this.record(tick));
  }

  /** Append one tick (meta line written lazily per fixture). */
  record(tick: Tick): void {
    this.write(tick);
  }

  private streamFor(fixtureId: string): WriteStream {
    let stream = this.streams.get(fixtureId);
    if (!stream) {
      const file = path.join(this.dir, `${sanitize(fixtureId)}.jsonl`);
      stream = createWriteStream(file, { flags: 'a' });
      this.streams.set(fixtureId, stream);
      log.info({ file }, 'recorder: opened recording');
    }
    return stream;
  }

  private write(tick: Tick): void {
    const stream = this.streamFor(tick.fixtureId);
    if (!this.metaWritten.has(tick.fixtureId)) {
      this.metaWritten.add(tick.fixtureId);
      const fixture = this.fixtures.get(tick.fixtureId);
      if (fixture) stream.write(JSON.stringify({ kind: 'meta', fixture }) + '\n');
    }
    stream.write(JSON.stringify(tick) + '\n');
  }

  close(): void {
    for (const stream of this.streams.values()) stream.end();
    this.streams.clear();
  }
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
