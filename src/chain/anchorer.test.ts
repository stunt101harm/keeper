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

const makeEvent = (i: number): EngineEvent =>
  ({
    kind: 'risk',
    fixtureId: 'fx1',
    ts: 1000 + i,
    from: 'idle',
    to: 'quoting',
    reason: `e${i}`,
  }) satisfies RiskTransition;

const makeBookEvent = (inv: [number, number, number], mtmPnl: number, ts = 2000): BookSnapshot => ({
  kind: 'book',
  fixtureId: 'fx1',
  ts,
  inventory: { home: inv[0], draw: inv[1], away: inv[2] },
  netExposure: { home: 0, draw: 0, away: 0 },
  realizedPnl: 0,
  mtmPnl,
  pnl: { spreadCapture: 0, inventoryDrift: 0, settlementResidual: 0 },
  tradeCount: 0,
});

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
      expect(commit.seqStart).toBe(0);
      expect(commit.seqEnd).toBe(2); // inclusive blotter bound
      expect(commit.inventoryMicro).toEqual([1_500_000, -250_000, 0]);
      expect(commit.mtmPnlMicro).toBe(123_456);
      expect(commit.tsMs).toBe(2001);
      const expectedRoot = merkleRoot(bus.engineLog.slice(0, 3).map((r) => leafHash(r))).toString(
        'hex',
      );
      expect(commit.rootHex).toBe(expectedRoot);

      // continuity across cycles: next batch starts exactly where this ended,
      // and a batch WITHOUT a book snapshot reuses the latest known one.
      bus.publishEngine(makeEvent(3));
      await handle.runCycle();
      expect(commits).toHaveLength(2);
      expect(commits[1]!.seqStart).toBe(3);
      expect(commits[1]!.seqEnd).toBe(3);
      expect(commits[1]!.inventoryMicro).toEqual([1_500_000, -250_000, 0]);

      // anchors.jsonl records are tagged for verify-anchors target detection
      const anchorLines = fs
        .readFileSync(path.join(dataDir, 'anchors.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as AnchorBatch & { target?: string; fixtureId?: string });
      expect(anchorLines).toHaveLength(2);
      for (const rec of anchorLines) {
        expect(rec.target).toBe('program');
        expect(rec.fixtureId).toBe('fx1');
        expect(rec.status).toBe('confirmed');
        expect(rec.sig).toMatch(/^epoch-sig-/);
      }
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
      expect(commits[0]!.seqStart).toBe(0);
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
