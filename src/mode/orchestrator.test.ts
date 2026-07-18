import { describe, expect, it } from 'vitest';
import type { FixtureInfo } from '../types.js';
import {
  LIVE_WINDOW_POST_MS,
  LIVE_WINDOW_PRE_MS,
  decideSource,
  isInLiveWindow,
  makeClock,
  startOrchestrator,
  type OrchestratorDeps,
} from './orchestrator.js';

const KICKOFF = 1_800_000_000_000;

const fx = (id: string, kickoffTs: number = KICKOFF): FixtureInfo => ({
  id,
  home: 'France',
  away: 'England',
  kickoffTs,
  competition: 'World Cup',
});

describe('live window decision (pure)', () => {
  it('is replay before the pre-window opens', () => {
    expect(isInLiveWindow(fx('1'), KICKOFF - LIVE_WINDOW_PRE_MS - 1)).toBe(false);
    expect(decideSource([fx('1')], KICKOFF - LIVE_WINDOW_PRE_MS - 1)).toBe('replay');
  });

  it('goes live exactly at kickoff − 30min', () => {
    expect(isInLiveWindow(fx('1'), KICKOFF - LIVE_WINDOW_PRE_MS)).toBe(true);
    expect(decideSource([fx('1')], KICKOFF - LIVE_WINDOW_PRE_MS)).toBe('live');
  });

  it('stays live through the match and until kickoff + 3h30m', () => {
    expect(decideSource([fx('1')], KICKOFF + 60 * 60_000)).toBe('live');
    expect(decideSource([fx('1')], KICKOFF + LIVE_WINDOW_POST_MS)).toBe('live');
  });

  it('falls back to replay after the window closes', () => {
    expect(decideSource([fx('1')], KICKOFF + LIVE_WINDOW_POST_MS + 1)).toBe('replay');
  });

  it('is replay with no fixtures at all', () => {
    expect(decideSource([], KICKOFF)).toBe('replay');
  });

  it('goes live when ANY of several fixtures is in-window', () => {
    const list = [fx('early', KICKOFF - 24 * 3_600_000), fx('now'), fx('late', KICKOFF + 24 * 3_600_000)];
    expect(decideSource(list, KICKOFF + 1000)).toBe('live');
    expect(decideSource(list, KICKOFF + 12 * 3_600_000)).toBe('replay');
  });
});

describe('makeClock', () => {
  it('defaults to the real clock', () => {
    const now = makeClock(undefined);
    expect(Math.abs(now() - Date.now())).toBeLessThan(100);
  });

  it('pins a fake base that still advances', async () => {
    const now = makeClock(String(KICKOFF));
    const first = now();
    expect(Math.abs(first - KICKOFF)).toBeLessThan(1000);
    await new Promise((r) => setTimeout(r, 15));
    expect(now()).toBeGreaterThan(first);
  });

  it('ignores garbage overrides', () => {
    const now = makeClock('not-a-number');
    expect(Math.abs(now() - Date.now())).toBeLessThan(100);
  });
});

interface Harness {
  calls: string[];
  setNow(ms: number): void;
  setFixtures(list: FixtureInfo[]): void;
  failDiscovery(fail: boolean): void;
  deps: OrchestratorDeps;
}

function harness(opts: { startLiveThrows?: boolean } = {}): Harness {
  const calls: string[] = [];
  let nowMs = 0;
  let list: FixtureInfo[] = [];
  let discoveryFails = false;
  return {
    calls,
    setNow: (ms) => (nowMs = ms),
    setFixtures: (l) => (list = l),
    failDiscovery: (f) => (discoveryFails = f),
    deps: {
      discover: async () => {
        if (discoveryFails) throw new Error('api down');
        return list;
      },
      startLive: async () => {
        calls.push('startLive');
        if (opts.startLiveThrows) throw new Error('no token');
      },
      stopLive: () => {
        calls.push('stopLive');
      },
      startReplay: () => {
        calls.push('startReplay');
      },
      stopReplay: () => {
        calls.push('stopReplay');
      },
      now: () => nowMs,
      checkIntervalMs: 60 * 60_000, // interval effectively disabled; tests drive check()
    },
  };
}

describe('orchestrator transitions', () => {
  it('boots into replay, flips to live inside the window, and back after it closes', async () => {
    const h = harness();
    h.setFixtures([fx('18257865')]);
    h.setNow(KICKOFF - 2 * 3_600_000);

    const orch = await startOrchestrator(h.deps);
    expect(orch.source()).toBe('replay');
    expect(h.calls).toEqual(['startReplay']);

    // Still before the window: no-op.
    h.setNow(KICKOFF - LIVE_WINDOW_PRE_MS - 60_000);
    await orch.check();
    expect(h.calls).toEqual(['startReplay']);

    // Inside the window: replay → live.
    h.setNow(KICKOFF - 10 * 60_000);
    await orch.check();
    expect(orch.source()).toBe('live');
    expect(h.calls).toEqual(['startReplay', 'stopReplay', 'startLive']);

    // Still live mid-match: no repeated transitions.
    h.setNow(KICKOFF + 50 * 60_000);
    await orch.check();
    expect(h.calls).toEqual(['startReplay', 'stopReplay', 'startLive']);

    // Window closed: live → replay.
    h.setNow(KICKOFF + LIVE_WINDOW_POST_MS + 60_000);
    await orch.check();
    expect(orch.source()).toBe('replay');
    expect(h.calls).toEqual(['startReplay', 'stopReplay', 'startLive', 'stopLive', 'startReplay']);

    orch.stop();
  });

  it('boots straight into live when already inside the window (no replay start first)', async () => {
    const h = harness();
    h.setFixtures([fx('18257865')]);
    h.setNow(KICKOFF + 5 * 60_000);

    const orch = await startOrchestrator(h.deps);
    expect(orch.source()).toBe('live');
    expect(h.calls).toEqual(['startLive']);
    orch.stop();
  });

  it('keeps deciding on the last known fixture set when discovery fails', async () => {
    const h = harness();
    h.setFixtures([fx('18257865')]);
    h.setNow(KICKOFF + 5 * 60_000);
    const orch = await startOrchestrator(h.deps);
    expect(orch.source()).toBe('live');

    // Mid-match API outage: stays live on the cached fixture list.
    h.failDiscovery(true);
    h.setNow(KICKOFF + 30 * 60_000);
    await orch.check();
    expect(orch.source()).toBe('live');
    expect(h.calls).toEqual(['startLive']);

    // Outage persists past the window: cached kickoff has aged out → replay.
    h.setNow(KICKOFF + LIVE_WINDOW_POST_MS + 60_000);
    await orch.check();
    expect(orch.source()).toBe('replay');
    orch.stop();
  });

  it('falls back to replay when startLive throws', async () => {
    const h = harness({ startLiveThrows: true });
    h.setFixtures([fx('18257865')]);
    h.setNow(KICKOFF);
    const orch = await startOrchestrator(h.deps);
    expect(orch.source()).toBe('replay');
    expect(h.calls).toEqual(['startLive', 'startReplay']);
    orch.stop();
  });
});
