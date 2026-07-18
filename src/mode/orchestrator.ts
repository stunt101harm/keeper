/**
 * orchestrator.ts — KEEPER_MODE=auto: the agent decides for itself whether to
 * run live or replay, with zero human input.
 *
 * Decision rule (pure, unit-tested): a fixture is "in its live window" when
 *   kickoffTs − 30min ≤ now ≤ kickoffTs + 3h30m
 * If ANY tracked fixture is in its live window the effective source is 'live';
 * otherwise 'replay'. The check runs at boot and then every 5 minutes.
 *
 * Transitions (side effects are injected by the composition root):
 *   replay → live : stopReplay(), startLive()   (live ingest owns discovery,
 *                                                seeding, and both SSE streams)
 *   live → replay : stopLive(), startReplay()   (engine/state resets for the
 *                                                replay fixture happen inside
 *                                                startReplay — engine, bus and
 *                                                anchorer persist throughout)
 *
 * If startLive() throws (e.g. missing TxLINE credentials), the orchestrator
 * falls back to replay so the agent is never sourceless. If discovery fails,
 * the last known fixture set keeps deciding — a mid-match API outage must not
 * flip a live agent back to replay.
 */

import { log } from '../log.js';
import type { FixtureInfo } from '../types.js';

export type SourceName = 'live' | 'replay';

export const LIVE_WINDOW_PRE_MS = 30 * 60_000; // 30 min before kickoff
export const LIVE_WINDOW_POST_MS = 3 * 3_600_000 + 30 * 60_000; // 3h30m after
export const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000;

export function isInLiveWindow(fixture: FixtureInfo, nowMs: number): boolean {
  return (
    nowMs >= fixture.kickoffTs - LIVE_WINDOW_PRE_MS &&
    nowMs <= fixture.kickoffTs + LIVE_WINDOW_POST_MS
  );
}

export function liveFixtures(fixtures: Iterable<FixtureInfo>, nowMs: number): FixtureInfo[] {
  return [...fixtures].filter((f) => isInLiveWindow(f, nowMs));
}

/** The pure decision: live iff any fixture is inside its live window. */
export function decideSource(fixtures: Iterable<FixtureInfo>, nowMs: number): SourceName {
  return liveFixtures(fixtures, nowMs).length > 0 ? 'live' : 'replay';
}

/**
 * Clock factory. Without an override this is Date.now. With KEEPER_FAKE_NOW
 * (ms epoch, test/demo only) the clock is pinned to that instant at process
 * start and advances in real time from there — lets us rehearse tonight's
 * kickoff window without waiting for it.
 */
export function makeClock(fakeNowMs?: string): () => number {
  const base = fakeNowMs === undefined ? NaN : Number(fakeNowMs);
  if (!Number.isFinite(base)) return () => Date.now();
  const offset = base - Date.now();
  log.warn({ fakeNow: new Date(base).toISOString() }, 'orchestrator: KEEPER_FAKE_NOW active — simulated clock');
  return () => Date.now() + offset;
}

export interface OrchestratorDeps {
  /** Fetch the current tracked fixture set (TxLINE snapshot; may throw). */
  discover(): Promise<FixtureInfo[]>;
  startLive(): Promise<void> | void;
  stopLive(): Promise<void> | void;
  startReplay(): void;
  stopReplay(): void;
  now?: () => number;
  checkIntervalMs?: number;
}

export interface OrchestratorHandle {
  /** Effective source right now ('replay' until the first check completes). */
  source(): SourceName;
  /** Run one decision cycle immediately (used by tests; interval calls this). */
  check(): Promise<void>;
  stop(): void;
}

export async function startOrchestrator(deps: OrchestratorDeps): Promise<OrchestratorHandle> {
  const now = deps.now ?? (() => Date.now());
  const intervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;

  let current: SourceName | null = null; // null = nothing started yet (boot)
  let known: FixtureInfo[] = [];
  let checking = false;

  const check = async (): Promise<void> => {
    if (checking) return; // never overlap transitions
    checking = true;
    try {
      try {
        known = await deps.discover();
      } catch (err) {
        log.warn(
          { err: String(err), lastKnown: known.length },
          'orchestrator: fixture discovery failed — deciding on last known set',
        );
      }
      const nowMs = now();
      const live = liveFixtures(known, nowMs);
      const desired: SourceName = live.length > 0 ? 'live' : 'replay';
      if (desired === current) return;

      log.info(
        {
          from: current ?? 'boot',
          to: desired,
          tracked: known.length,
          liveFixtures: live.map((f) => `${f.id} ${f.home} v ${f.away}`),
        },
        'orchestrator: source transition',
      );

      if (desired === 'live') {
        if (current === 'replay') deps.stopReplay();
        try {
          await deps.startLive();
          current = 'live';
        } catch (err) {
          log.error(
            { err: String(err) },
            'orchestrator: startLive failed — falling back to replay',
          );
          deps.startReplay();
          current = 'replay';
        }
      } else {
        if (current === 'live') await deps.stopLive();
        deps.startReplay();
        current = 'replay';
      }
    } finally {
      checking = false;
    }
  };

  await check(); // boot straight into the correct source

  const timer = setInterval(() => {
    check().catch((err) => log.error({ err: String(err) }, 'orchestrator: check failed'));
  }, intervalMs);
  timer.unref?.();

  return {
    source: () => current ?? 'replay',
    check,
    stop: () => clearInterval(timer),
  };
}
