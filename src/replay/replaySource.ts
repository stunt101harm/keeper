import { readFileSync } from 'node:fs';
import { log } from '../log.js';
import type { FixtureInfo, Tick } from '../types.js';
import { parseRecording } from './recording.js';

export interface ReplayHandlers {
  onTick(tick: Tick): void;
  /** Called before each restart when looping — reset engine/book state here. */
  onLoopRestart?(): void;
  onEnd?(): void;
}

/**
 * Replays a recorded match through the identical pipeline the live feed uses,
 * honoring inter-tick gaps divided by `speed`. Deterministic in CONTENT
 * (same file ⇒ same tick sequence); wall-clock pacing is presentation only.
 */
export class ReplaySource {
  readonly fixture: FixtureInfo | null;
  private readonly ticks: Tick[];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly startIndex: number;

  constructor(
    file: string,
    private readonly speed: number,
    private readonly loop: boolean,
    start: 'begin' | 'kickoff' = 'begin',
  ) {
    const { fixture, ticks } = parseRecording(readFileSync(file, 'utf8'));
    if (ticks.length === 0) throw new Error(`replay: no ticks in ${file}`);
    this.fixture = fixture;
    this.ticks = ticks;
    // 'kickoff' drops a cold-started viewer near the action instead of the
    // pre-match lull (judge-friendly for the deployed instance).
    this.startIndex =
      start === 'kickoff' && fixture
        ? Math.max(
            0,
            ticks.findIndex((t) => t.ts >= fixture.kickoffTs - 2 * 60_000),
          )
        : 0;
    log.info(
      { file, ticks: ticks.length, speed, loop, start, startIndex: this.startIndex, fixture: fixture?.id },
      'replay: loaded recording',
    );
  }

  start(handlers: ReplayHandlers): void {
    this.stopped = false;
    this.run(handlers, this.startIndex);
  }

  private run(handlers: ReplayHandlers, index: number): void {
    if (this.stopped) return;
    const tick = this.ticks[index];
    if (!tick) {
      if (this.loop) {
        log.info('replay: recording finished — looping');
        handlers.onLoopRestart?.();
        this.timer = setTimeout(() => this.run(handlers, this.startIndex), 2000);
      } else {
        handlers.onEnd?.();
      }
      return;
    }
    handlers.onTick(tick);
    const next = this.ticks[index + 1];
    const gapMs = next ? Math.max(0, next.ts - tick.ts) / this.speed : 0;
    // Cap pathological gaps (pre-match lulls) so replay stays watchable.
    this.timer = setTimeout(() => this.run(handlers, index + 1), Math.min(gapMs, 5000));
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
