import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../bus.js';
import { loadConfig, type Config } from '../config.js';
import type { AnchorBatch, BookSnapshot, EngineEvent, RiskTransition } from '../types.js';
import {
  MAX_BATCH_EVENTS,
  startAnchorer,
  toMicro,
  type AnchorerHandle,
  type EpochCommit,
} from './anchorer.js';
import { leafHash, merkleRoot } from './merkle.js';

const makeEvent = (i: number, fixtureId = 'fx1'): EngineEvent =>
  ({
    kind: 'risk',
    fixtureId,
    ts: 1000 + i,
    from: 'idle',
    to: 'quoting',
    reason: `e${i}`,
  }) satisfies RiskTransition;

const makeBookEvent = (
  inv: [number, number, number],
  mtmPnl: number,
  ts = 2000,
  fixtureId = 'fx1',
): BookSnapshot => ({
  kind: 'book',
  fixtureId,
  ts,
  inventory: { home: inv[0], draw: inv[1], away: inv[2] },
  netExposure: { home: 0, draw: 0, away: 0 },
  realizedPnl: 0,
  mtmPnl,
  pnl: { spreadCapture: 0, inventoryDrift: 0, settlementResidual: 0 },
  tradeCount: 0,
});

/** Root over the engineLog records for one fixture within a global seq range. */
const fixtureRoot = (
  bus: Bus,
  fixtureId: string,
  seqStart: number,
  seqEnd: number,
): string =>
  merkleRoot(
    bus.engineLog
      .filter((r) => r.event.fixtureId === fixtureId && r.seq >= seqStart && r.seq <= seqEnd)
      .map((r) => leafHash(r)),
  ).toString('hex');

const makeConfig = (): Config => {
  const config = loadConfig({
    KEEPER_MODE: 'replay',
    ANCHOR_ENABLED: 'true',
    ANCHOR_INTERVAL_SEC: '3600', // effectively never fires; tests drive runCycle()
  } as NodeJS.ProcessEnv);
  return config;
};

describe('startAnchorer', () => {
  let dataDir: string;
  let handle: AnchorerHandle | undefined;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeper-anchor-'));
  });
  afterEach(() => {
    handle?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists events, batches exact seq ranges, retries after a failing send', async () => {
    const bus = new Bus();
    const sent: string[] = [];
    const anchors: AnchorBatch[] = [];
    bus.on('anchor', (b) => anchors.push(b));

    let failNext = false;
    const send = async (payload: string): Promise<string> => {
      if (failNext) throw new Error('rpc down');
      sent.push(payload);
      return `sig${sent.length}`;
    };

    handle = startAnchorer({ bus, config: makeConfig(), send, dataDir });

    for (let i = 0; i < 5; i++) bus.publishEngine(makeEvent(i));
    await handle.runCycle();

    // blotter has all 5 events as JSONL
    const lines = fs
      .readFileSync(path.join(dataDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(5);
    expect(JSON.parse(lines[3]!).seq).toBe(3);

    // one confirmed batch covering exactly 0..4, root matches independent recompute
    expect(sent).toHaveLength(1);
    const memo = JSON.parse(sent[0]!);
    expect(memo).toMatchObject({ app: 'keeper', v: 1, seqStart: 0, seqEnd: 4, count: 5 });
    const expectedRoot = merkleRoot(bus.engineLog.slice(0, 5).map((r) => leafHash(r))).toString('hex');
    expect(memo.root).toBe(expectedRoot);
    expect(anchors.map((a) => a.status)).toEqual(['pending', 'confirmed']);
    expect(anchors[1]!.sig).toBe('sig1');
    expect(anchors[1]!.explorerUrl).toContain('sig1');

    // next: two more events, RPC fails -> failed batch, cursor NOT advanced
    for (let i = 5; i < 7; i++) bus.publishEngine(makeEvent(i));
    failNext = true;
    await handle.runCycle();
    const failedBatch = anchors[anchors.length - 1]!;
    expect(failedBatch.status).toBe('failed');
    expect(failedBatch.seqStart).toBe(5);
    expect(failedBatch.seqEnd).toBe(6);
    expect(failedBatch.error).toContain('rpc down');

    // RPC recovers -> same range anchored on the next cycle
    failNext = false;
    await handle.runCycle();
    const memo2 = JSON.parse(sent[1]!);
    expect(memo2).toMatchObject({ seqStart: 5, seqEnd: 6, count: 2 });

    // nothing pending -> no send
    await handle.runCycle();
    expect(sent).toHaveLength(2);

    // anchors.jsonl has the three terminal records (confirmed, failed, confirmed)
    const anchorLines = fs
      .readFileSync(path.join(dataDir, 'anchors.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as AnchorBatch);
    expect(anchorLines.map((a) => a.status)).toEqual(['confirmed', 'failed', 'confirmed']);
  });

  it('caps batches at MAX_BATCH_EVENTS and drains in successive batches', async () => {
    const bus = new Bus();
    const sent: string[] = [];
    handle = startAnchorer({
      bus,
      config: makeConfig(),
      send: async (p) => {
        sent.push(p);
        return `sig${sent.length}`;
      },
      dataDir,
    });

    const n = MAX_BATCH_EVENTS + 3;
    for (let i = 0; i < n; i++) bus.publishEngine(makeEvent(i));
    await handle.runCycle();

    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!)).toMatchObject({
      seqStart: 0,
      seqEnd: MAX_BATCH_EVENTS - 1,
      count: MAX_BATCH_EVENTS,
    });
    expect(JSON.parse(sent[1]!)).toMatchObject({
      seqStart: MAX_BATCH_EVENTS,
      seqEnd: n - 1,
      count: 3,
    });
  });

  it('is a no-op without a secret key or injected sender', async () => {
    const bus = new Bus();
    const config = makeConfig();
    delete config.solana.secretKey;
    const h = startAnchorer({ bus, config, dataDir });
    bus.publishEngine(makeEvent(0));
    await h.runCycle();
    expect(fs.existsSync(path.join(dataDir, 'events.jsonl'))).toBe(false);
    h.stop();
  });

  it('is a no-op when anchoring is disabled', async () => {
    const bus = new Bus();
    const config = makeConfig();
    config.solana.anchorEnabled = false;
    const h = startAnchorer({ bus, config, send: async () => 'sig', dataDir });
    bus.publishEngine(makeEvent(0));
    await h.runCycle();
    expect(fs.existsSync(path.join(dataDir, 'events.jsonl'))).toBe(false);
    h.stop();
  });

  describe('ANCHOR_TARGET=program', () => {
    const makeProgramConfig = (): Config => {
      const config = makeConfig();
      config.solana.anchorTarget = 'program';
      config.solana.programId = 'BhstTkGhG1LLPYBt3E3n4PTZ3v1V6ukNHYvQ88rgvTHS';
      return config;
    };

    it('routes batches to record_epoch with book state in micro units', async () => {
      const bus = new Bus();
      const commits: EpochCommit[] = [];
      const sendEpoch = async (c: EpochCommit): Promise<string> => {
        commits.push(c);
        return `epoch-sig-${commits.length}`;
      };
      handle = startAnchorer({ bus, config: makeProgramConfig(), sendEpoch, dataDir });

      bus.publishEngine(makeEvent(0));
      bus.publishEngine(makeEvent(1));
      bus.publishEngine(makeBookEvent([1.5, -0.25, 0], 0.123456, 2001));
      await handle.runCycle();

      expect(commits).toHaveLength(1);
      const commit = commits[0]!;
      expect(commit.fixtureId).toBe('fx1');
      expect(commit.chainStart).toBe(0);
      expect(commit.chainEndExclusive).toBe(3); // chain-local exclusive bound
      expect(commit.globalStart).toBe(0);
      expect(commit.globalEnd).toBe(2); // inclusive global blotter bound
      expect(commit.inventoryMicro).toEqual([1_500_000, -250_000, 0]);
      expect(commit.mtmPnlMicro).toBe(123_456);
      expect(commit.tsMs).toBe(2001);
      const expectedRoot = merkleRoot(bus.engineLog.slice(0, 3).map((r) => leafHash(r))).toString(
        'hex',
      );
      expect(commit.rootHex).toBe(expectedRoot);

      // continuity across cycles: next epoch starts exactly where this ended,
      // and a group WITHOUT a book snapshot reuses the latest known one.
      bus.publishEngine(makeEvent(3));
      await handle.runCycle();
      expect(commits).toHaveLength(2);
      expect(commits[1]!.chainStart).toBe(3);
      expect(commits[1]!.chainEndExclusive).toBe(4);
      expect(commits[1]!.globalStart).toBe(3);
      expect(commits[1]!.globalEnd).toBe(3);
      expect(commits[1]!.inventoryMicro).toEqual([1_500_000, -250_000, 0]);

      // anchors.jsonl records are tagged for verify-anchors target detection
      const anchorLines = fs
        .readFileSync(path.join(dataDir, 'anchors.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(
          (l) =>
            JSON.parse(l) as AnchorBatch & {
              target?: string;
              fixtureId?: string;
              chainStart?: number;
              count?: number;
            },
        );
      expect(anchorLines).toHaveLength(2);
      for (const rec of anchorLines) {
        expect(rec.target).toBe('program');
        expect(rec.fixtureId).toBe('fx1');
        expect(rec.status).toBe('confirmed');
        expect(rec.sig).toMatch(/^epoch-sig-/);
      }
      expect(anchorLines[0]).toMatchObject({ chainStart: 0, count: 3, seqStart: 0, seqEnd: 2 });
      expect(anchorLines[1]).toMatchObject({ chainStart: 3, count: 1, seqStart: 3, seqEnd: 3 });
    });

    it('splits a multi-fixture window into per-fixture commits with per-fixture book state', async () => {
      const bus = new Bus();
      const commits: EpochCommit[] = [];
      handle = startAnchorer({
        bus,
        config: makeProgramConfig(),
        sendEpoch: async (c) => {
          commits.push(c);
          return `epoch-sig-${commits.length}`;
        },
        dataDir,
      });

      // Interleave two fixtures in the GLOBAL seq space (the live-bug shape):
      // seq: 0=A 1=B 2=A(book) 3=A 4=B(book) 5=B
      bus.publishEngine(makeEvent(0, 'fxA'));
      bus.publishEngine(makeEvent(1, 'fxB'));
      bus.publishEngine(makeBookEvent([2, 0, -1], 0.5, 3001, 'fxA'));
      bus.publishEngine(makeEvent(3, 'fxA'));
      bus.publishEngine(makeBookEvent([0, 7, 0], -0.25, 3002, 'fxB'));
      bus.publishEngine(makeEvent(5, 'fxB'));
      await handle.runCycle();

      expect(commits).toHaveLength(2);
      const byFixture = new Map(commits.map((c) => [c.fixtureId, c]));
      const a = byFixture.get('fxA')!;
      const b = byFixture.get('fxB')!;

      // chain-local bounds are PER FIXTURE (each starts at 0), global bounds
      // are the group's first/last GLOBAL seq.
      expect(a).toMatchObject({ chainStart: 0, chainEndExclusive: 3, globalStart: 0, globalEnd: 3 });
      expect(b).toMatchObject({ chainStart: 0, chainEndExclusive: 3, globalStart: 1, globalEnd: 5 });

      // roots cover ONLY that fixture's events (global seqs in the leaves)
      expect(a.rootHex).toBe(fixtureRoot(bus, 'fxA', 0, 3));
      expect(b.rootHex).toBe(fixtureRoot(bus, 'fxB', 1, 5));

      // REGRESSION (bug b): each fixture commits ITS OWN inventory/mtm — the
      // old single latestBookSnapshot bled fxB's book into fxA's epoch.
      expect(a.inventoryMicro).toEqual([2_000_000, 0, -1_000_000]);
      expect(a.mtmPnlMicro).toBe(500_000);
      expect(b.inventoryMicro).toEqual([0, 7_000_000, 0]);
      expect(b.mtmPnlMicro).toBe(-250_000);

      // next cycle: chain-local continuity per fixture, book state carried
      bus.publishEngine(makeEvent(6, 'fxA'));
      await handle.runCycle();
      expect(commits).toHaveLength(3);
      expect(commits[2]).toMatchObject({
        fixtureId: 'fxA',
        chainStart: 3,
        chainEndExclusive: 4,
        globalStart: 6,
        globalEnd: 6,
        inventoryMicro: [2_000_000, 0, -1_000_000],
      });

      // one anchors.jsonl record per group, each with chain-local extras
      const anchorLines = fs
        .readFileSync(path.join(dataDir, 'anchors.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(anchorLines).toHaveLength(3);
      expect(anchorLines[0]).toMatchObject({
        target: 'program',
        fixtureId: 'fxA',
        chainStart: 0,
        count: 3,
        seqStart: 0,
        seqEnd: 3,
        status: 'confirmed',
      });
      expect(anchorLines[1]).toMatchObject({
        target: 'program',
        fixtureId: 'fxB',
        chainStart: 0,
        count: 3,
        seqStart: 1,
        seqEnd: 5,
        status: 'confirmed',
      });
    });

    it('continuity fallback demotes ONLY the tripping fixture to memo', async () => {
      const bus = new Bus();
      const commits: EpochCommit[] = [];
      const epochAttempts: string[] = [];
      const memos: string[] = [];
      const anchors: AnchorBatch[] = [];
      bus.on('anchor', (b) => anchors.push(b));
      handle = startAnchorer({
        bus,
        config: makeProgramConfig(),
        sendEpoch: async (c) => {
          epochAttempts.push(c.fixtureId);
          if (c.fixtureId === 'old') {
            throw new Error('KEEPER_BOOK_CONTINUITY_FALLBACK: book already anchored');
          }
          commits.push(c);
          return `epoch-sig-${commits.length}`;
        },
        send: async (p) => {
          memos.push(p);
          return `memo-sig-${memos.length}`;
        },
        dataDir,
      });

      // seq: 0=old 1=new 2=old 3=new — 'old' replays a previously-anchored book
      bus.publishEngine(makeEvent(0, 'old'));
      bus.publishEngine(makeEvent(1, 'new'));
      bus.publishEngine(makeEvent(2, 'old'));
      bus.publishEngine(makeEvent(3, 'new'));
      await handle.runCycle();

      // REGRESSION (bug a): 'new' STILL anchors via the program — no run-wide flag
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({
        fixtureId: 'new',
        chainStart: 0,
        chainEndExclusive: 2,
        globalStart: 1,
        globalEnd: 3,
      });

      // 'old' went out as ONE memo for its group, payload extended with fixtureId
      expect(memos).toHaveLength(1);
      const memo = JSON.parse(memos[0]!);
      expect(memo).toMatchObject({
        app: 'keeper',
        v: 1,
        seqStart: 0,
        seqEnd: 2,
        count: 2,
        fixtureId: 'old',
      });
      expect(memo.root).toBe(fixtureRoot(bus, 'old', 0, 2));

      // next cycle: 'old' goes STRAIGHT to memo (no repeat record_epoch attempt)
      bus.publishEngine(makeEvent(4, 'old'));
      bus.publishEngine(makeEvent(5, 'new'));
      await handle.runCycle();
      expect(epochAttempts.filter((f) => f === 'old')).toHaveLength(1);
      expect(memos).toHaveLength(2);
      expect(JSON.parse(memos[1]!)).toMatchObject({ seqStart: 4, seqEnd: 4, count: 1, fixtureId: 'old' });
      expect(commits).toHaveLength(2);
      expect(commits[1]).toMatchObject({ fixtureId: 'new', chainStart: 2, chainEndExclusive: 3 });

      // every group confirmed on the bus; anchors.jsonl tags the demoted groups
      expect(anchors.filter((a) => a.status === 'failed')).toHaveLength(0);
      const anchorLines = fs
        .readFileSync(path.join(dataDir, 'anchors.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const oldRecs = anchorLines.filter((r) => r.fixtureId === 'old');
      const newRecs = anchorLines.filter((r) => r.fixtureId === 'new');
      expect(oldRecs).toHaveLength(2);
      for (const rec of oldRecs) {
        expect(rec.target).toBe('memo-fixture');
        expect(rec.count).toBeDefined();
        expect(rec.sig).toMatch(/^memo-sig-/);
      }
      expect(newRecs).toHaveLength(2);
      for (const rec of newRecs) expect(rec.target).toBe('program');
    });

    it('retries a transiently failed group without re-sending the groups that succeeded', async () => {
      const bus = new Bus();
      const commits: EpochCommit[] = [];
      let failF2 = true;
      handle = startAnchorer({
        bus,
        config: makeProgramConfig(),
        sendEpoch: async (c) => {
          if (c.fixtureId === 'f2' && failF2) throw new Error('rpc down');
          commits.push(c);
          return `epoch-sig-${commits.length}`;
        },
        dataDir,
      });

      bus.publishEngine(makeEvent(0, 'f1'));
      bus.publishEngine(makeEvent(1, 'f2'));
      await handle.runCycle();

      // f1 sent, f2 failed → the WINDOW stays queued (cursor did not advance)
      expect(commits).toHaveLength(1);
      expect(commits[0]).toMatchObject({ fixtureId: 'f1', chainStart: 0, globalStart: 0, globalEnd: 0 });

      // the window even GROWS before the retry; f1's already-sent seq 0 must
      // NOT be re-sent — only its new event goes out, chain-locally contiguous
      failF2 = false;
      bus.publishEngine(makeEvent(2, 'f1'));
      await handle.runCycle();

      expect(commits).toHaveLength(3);
      const f2 = commits.find((c) => c.fixtureId === 'f2')!;
      expect(f2).toMatchObject({ chainStart: 0, chainEndExclusive: 1, globalStart: 1, globalEnd: 1 });
      const f1Second = commits[commits.length - 1]!;
      expect(f1Second).toMatchObject({
        fixtureId: 'f1',
        chainStart: 1,
        chainEndExclusive: 2,
        globalStart: 2,
        globalEnd: 2,
      });

      // cursor advanced past the whole window: an idle cycle sends nothing
      await handle.runCycle();
      expect(commits).toHaveLength(3);

      // exactly one duplicate-free record_epoch per resolved group
      expect(commits.filter((c) => c.fixtureId === 'f1')).toHaveLength(2);
      expect(commits.filter((c) => c.fixtureId === 'f2')).toHaveLength(1);
    });

    it('keeps the failed range queued when record_epoch fails', async () => {
      const bus = new Bus();
      let fail = true;
      const commits: EpochCommit[] = [];
      handle = startAnchorer({
        bus,
        config: makeProgramConfig(),
        sendEpoch: async (c) => {
          if (fail) throw new Error('rpc down');
          commits.push(c);
          return 'sig';
        },
        dataDir,
      });
      bus.publishEngine(makeEvent(0));
      await handle.runCycle();
      expect(commits).toHaveLength(0);
      fail = false;
      await handle.runCycle();
      expect(commits).toHaveLength(1);
      expect(commits[0]!.chainStart).toBe(0);
      expect(commits[0]!.globalStart).toBe(0);
    });

    it('falls back to memo when program target lacks a program id', async () => {
      const bus = new Bus();
      const config = makeConfig();
      config.solana.anchorTarget = 'program'; // …but no programId configured
      const sent: string[] = [];
      handle = startAnchorer({
        bus,
        config,
        send: async (p) => {
          sent.push(p);
          return 'memo-sig';
        },
        dataDir,
      });
      bus.publishEngine(makeEvent(0));
      await handle.runCycle();
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0]!)).toMatchObject({ app: 'keeper', seqStart: 0, seqEnd: 0 });
    });

    it('toMicro rounds to integer micro units', () => {
      expect(toMicro(1.2345678)).toBe(1_234_568);
      expect(toMicro(-0.25)).toBe(-250_000);
      expect(toMicro(0)).toBe(0);
    });
  });
});
