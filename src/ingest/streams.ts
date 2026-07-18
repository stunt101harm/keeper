/**
 * streams.ts — resilient SSE stream consumer, shared by /scores/stream and
 * /odds/stream (both serve records for ALL fixtures; callers filter).
 *
 * Reliability model (proven in the corner-case spike):
 *  - reconnect forever with jittered exponential backoff (cap 60s);
 *  - the backoff ladder resets only after a connection that survived 60s —
 *    resetting on mere "open" would let a connect-then-immediately-die server
 *    hammer us at full speed;
 *  - 120s idle watchdog: laptop sleep/wake and silently-dead TCP connections
 *    produce no error and no bytes — the stream just goes quiet forever; the
 *    watchdog aborts and reconnects. Heartbeats (~15s) keep it fed normally;
 *  - Last-Event-ID resume hint on reconnect when the stream carries ids;
 *  - a consumer exception on one record never tears down the loop.
 */

import { sleep, type TxlineAuth } from './auth.js';
import { SseParser, type SseEvent } from './sse.js';

export interface StreamStatus {
  type: 'connecting' | 'open' | 'closed' | 'retry' | 'error' | 'stopped';
  attempt?: number;
  waitMs?: number;
  detail?: string;
}

export interface StreamHandlers<T> {
  /** Called once per parsed record (heartbeats and junk already filtered). */
  onRecord: (record: T, ev: SseEvent) => void;
  onStatus?: (status: StreamStatus) => void;
}

export interface StreamHandle {
  stop(): void;
  /** Resolves when the loop has fully wound down after stop(). */
  done: Promise<void>;
}

export interface StreamOptions {
  /** Abort + reconnect if the socket goes silent this long (default 120s). */
  idleTimeoutMs?: number;
  /** Resume hint for the first connection (Last-Event-ID header). */
  lastEventId?: string;
}

const MAX_BACKOFF_MS = 60_000;
const STABLE_CONNECTION_MS = 60_000;

/** Exponential backoff with jitter in [0.5x, 1x] so several loops in one
 *  process (odds + scores) never synchronize into reconnect bursts. */
function jitteredBackoff(attempt: number): number {
  const base = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** attempt);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * Classify one SSE event into a usable record or null (heartbeat / junk).
 * Exported separately so the filtering rules are unit-testable without a
 * network. Rules:
 *  - named `event: heartbeat` blocks are liveness only (their Ts is SECONDS,
 *    not ms — they must never reach normalization as records);
 *  - unparseable JSON → dropped (surfaced via onJunk);
 *  - payloads without a numeric FixtureId (e.g. an UNNAMED heartbeat variant
 *    `{"Ts": 1752786000}`) → dropped.
 */
export function classifyEvent<T extends { FixtureId: number }>(
  ev: SseEvent,
  onJunk?: (detail: string) => void,
): T | null {
  if (!ev.data) return null;
  if (ev.event === 'heartbeat') return null;
  let record: unknown;
  try {
    record = JSON.parse(ev.data);
  } catch {
    onJunk?.(`unparseable data block: ${ev.data.slice(0, 120)}`);
    return null;
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    typeof (record as { FixtureId?: unknown }).FixtureId !== 'number'
  ) {
    onJunk?.(`data block without FixtureId: ${ev.data.slice(0, 120)}`);
    return null;
  }
  return record as T;
}

/**
 * Consume one SSE endpoint forever (until stop()). One instance per stream —
 * odds and scores each get their own loop, so one dying cannot affect the
 * other.
 */
export function streamRecords<T extends { FixtureId: number }>(
  auth: TxlineAuth,
  path: string,
  handlers: StreamHandlers<T>,
  opts: StreamOptions = {},
): StreamHandle {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
  let stopped = false;
  let controller: AbortController | null = null;
  let lastEventId = opts.lastEventId;

  const emitStatus = (status: StreamStatus): void => {
    try {
      handlers.onStatus?.(status);
    } catch {
      // A logging callback must never be able to kill the stream loop.
    }
  };

  const deliver = (ev: SseEvent): void => {
    if (ev.id !== undefined) lastEventId = ev.id;
    const record = classifyEvent<T>(ev, (detail) => emitStatus({ type: 'error', detail }));
    if (!record) return;
    try {
      handlers.onRecord(record, ev);
    } catch (err) {
      // A consumer bug on one record must not tear down the whole stream.
      emitStatus({ type: 'error', detail: `onRecord threw: ${String(err)}` });
    }
  };

  const done = (async () => {
    let attempt = 0;
    while (!stopped) {
      controller = new AbortController();
      const connectedAt = Date.now();
      try {
        emitStatus({ type: 'connecting', attempt });
        const headers: Record<string, string> = { Accept: 'text/event-stream' };
        if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;
        const res = await auth.authedFetch(path, {
          headers,
          signal: controller.signal,
          noTimeout: true,
        });
        if (!res.ok || !res.body) {
          throw new Error(`stream connect ${path} → HTTP ${res.status}`);
        }
        emitStatus({ type: 'open' });

        let lastActivity = Date.now();
        const ctl = controller;
        const watchdog = setInterval(() => {
          if (Date.now() - lastActivity > idleTimeoutMs) {
            ctl.abort(new Error(`idle ${idleTimeoutMs}ms — reconnecting`));
          }
        }, 5_000);
        watchdog.unref?.();

        const parser = new SseParser();
        const decoder = new TextDecoder();
        try {
          for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
            lastActivity = Date.now(); // any bytes (incl. heartbeats) count as life
            for (const ev of parser.push(decoder.decode(chunk, { stream: true }))) {
              deliver(ev);
            }
          }
          for (const ev of parser.end()) deliver(ev);
        } finally {
          clearInterval(watchdog);
        }
        emitStatus({ type: 'closed', detail: 'server ended stream' });
      } catch (err) {
        if (!stopped) emitStatus({ type: 'closed', detail: String(err) });
      }
      if (stopped) break;
      if (Date.now() - connectedAt > STABLE_CONNECTION_MS) attempt = 0;
      const waitMs = jitteredBackoff(attempt++);
      emitStatus({ type: 'retry', attempt, waitMs });
      await sleepUnlessStopped(waitMs, () => stopped);
    }
    emitStatus({ type: 'stopped' });
  })();

  return {
    stop(): void {
      stopped = true;
      controller?.abort(new Error('stopped by caller'));
    },
    done,
  };
}

/** Sleep in small slices so stop() takes effect promptly mid-backoff. */
async function sleepUnlessStopped(ms: number, isStopped: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !isStopped()) {
    await sleep(Math.min(500, deadline - Date.now()));
  }
}
