import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import type { SettlementEvent } from '../types.js';
import { findFinalisedSeq, makeAutoSettler, winnerFromGoals, type SettleResult } from './settle.js';

const makeSettlement = (fixtureId = '18241006'): SettlementEvent => ({
  kind: 'settlement',
  fixtureId,
  ts: 1784150592580,
  winner: 'away',
  finalScore: { home: 1, away: 2 },
  realizedPnl: 1.5,
});

const okResult = (fixtureId: string): SettleResult => ({
  sig: `sig-${fixtureId}`,
  explorerUrl: 'https://explorer.solana.com/tx/x?cluster=devnet',
  epochDay: 20649,
  finalisedSeq: 962,
  provenGoals: [1, 2],
  winner: 'p2',
});

describe('winnerFromGoals', () => {
  it('maps proven goals to p1/draw/p2', () => {
    expect(winnerFromGoals(2, 0)).toBe('p1');
    expect(winnerFromGoals(1, 1)).toBe('draw');
    expect(winnerFromGoals(1, 2)).toBe('p2');
  });
});

describe('findFinalisedSeq', () => {
  it('returns null when nothing is finalised', () => {
    expect(findFinalisedSeq([])).toBeNull();
    expect(findFinalisedSeq([{ Seq: 10, Action: 'goal' }, { Seq: 11, StatusId: 3 }])).toBeNull();
  });

  it('finds StatusId 100 even when the max-Seq record is a bare disconnected', () => {
    // Verified live on 18241006: game_finalised at Seq 962, then a
    // StatusId-less "disconnected" trailer at Seq 963.
    expect(
      findFinalisedSeq([
        { Seq: 950, Action: 'goal' },
        { Seq: 962, Action: 'game_finalised', StatusId: 100 },
        { Seq: 963, Action: 'disconnected' },
      ]),
    ).toBe(962);
  });

  it('keeps the LOWEST finalised seq when several records carry it', () => {
    expect(
      findFinalisedSeq([
        { Seq: 970, StatusId: 100 },
        { Seq: 962, Action: 'game_finalised', StatusId: 100 },
      ]),
    ).toBe(962);
  });
});

describe('makeAutoSettler', () => {
  const config = loadConfig({ KEEPER_MODE: 'replay' } as NodeJS.ProcessEnv);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

  it('settles once per fixture, ignoring duplicate settlement events', async () => {
    const settleFn = vi.fn(async (fixtureId: string) => okResult(fixtureId));
    const settler = makeAutoSettler(config, { settleFn });
    settler.onSettlement(makeSettlement());
    settler.onSettlement(makeSettlement()); // duplicate (replay loop, restart…)
    settler.onSettlement(makeSettlement('99'));
    await flush();
    expect(settleFn).toHaveBeenCalledTimes(2);
    expect(settleFn).toHaveBeenCalledWith('18241006');
    expect(settleFn).toHaveBeenCalledWith('99');
    settler.stop();
  });

  it('retries while the root lags, then succeeds', async () => {
    let calls = 0;
    const settleFn = vi.fn(async (fixtureId: string) => {
      calls++;
      if (calls < 3) throw new Error('settle_book simulation failed: RootNotAvailable');
      return okResult(fixtureId);
    });
    const settler = makeAutoSettler(config, { settleFn, retryIntervalSec: 0.01, maxAttempts: 10 });
    settler.onSettlement(makeSettlement());
    await vi.waitFor(() => expect(calls).toBe(3));
    await flush();
    expect(settleFn).toHaveBeenCalledTimes(3);
    settler.stop();
  });

  it('stops retrying on AlreadySettled', async () => {
    const settleFn = vi.fn(async () => {
      throw new Error('custom program error: AlreadySettled');
    });
    const settler = makeAutoSettler(config, { settleFn, retryIntervalSec: 0.01, maxAttempts: 10 });
    settler.onSettlement(makeSettlement());
    await flush();
    await flush();
    expect(settleFn).toHaveBeenCalledTimes(1);
    settler.stop();
  });

  it('gives up after maxAttempts', async () => {
    const settleFn = vi.fn(async (): Promise<SettleResult> => {
      throw new Error('fixture not finalised yet');
    });
    const settler = makeAutoSettler(config, { settleFn, retryIntervalSec: 0.005, maxAttempts: 3 });
    settler.onSettlement(makeSettlement());
    await vi.waitFor(() => expect(settleFn).toHaveBeenCalledTimes(3));
    await new Promise((r) => setTimeout(r, 30)); // no further attempts scheduled
    expect(settleFn).toHaveBeenCalledTimes(3);
    settler.stop();
  });

  it('is a no-op when the program target is not configured (memo mode)', async () => {
    // No settleFn injected AND no program config → disabled; must not attempt
    // any network call.
    const settler = makeAutoSettler(config);
    settler.onSettlement(makeSettlement());
    await flush();
    settler.stop(); // reaching here without throwing/hanging is the assertion
  });
});
