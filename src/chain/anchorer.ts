import fs from 'node:fs';
import path from 'node:path';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { Bus } from '../bus.js';
import type { Config } from '../config.js';
import type { AnchorBatch, BookSnapshot, EngineEvent } from '../types.js';
import { log } from '../log.js';
import { BookClient } from './book.js';
import { canonicalJson, leafHash, merkleRoot } from './merkle.js';

/**
 * Anchorer — the tamper-evidence layer.
 *
 * Every engine event (already seq-stamped by the Bus) is appended to
 * data/events.jsonl (the auditable blotter). Every anchorIntervalSec of wall
 * clock, the un-anchored seq range is hashed into a binary merkle root and
 * the root is published to Solana devnet — via one of two targets:
 *
 *  - ANCHOR_TARGET=memo (default): the root goes out as a JSON Memo, exactly
 *    as before. This path is unchanged.
 *  - ANCHOR_TARGET=program (+ KEEPER_PROGRAM_ID): the pending global window
 *    is GROUPED BY FIXTURE and each fixture group goes into the keeper_book
 *    program as one `record_epoch` — a typed on-chain account per fixture
 *    with an ON-CHAIN continuity gate (each epoch's seq_start must equal the
 *    stored seq_end), plus that fixture's live inventory and mark-to-market
 *    P&L in micro units. Fixture events interleave in the GLOBAL seq space,
 *    so the chain bounds are CHAIN-LOCAL per fixture: chainStart = events
 *    already anchored for that fixture this run (0-based, exclusive end),
 *    while the blotter/bus records keep the group's GLOBAL seq bounds. The
 *    book is lazily `init_book`ed once per fixture on the first group.
 *
 *    Continuity fallback is PER FIXTURE: when a fixture's on-chain book
 *    rejects this run structurally (already anchored by a previous run —
 *    CONTINUITY_FALLBACK / 0x1771), only THAT fixture demotes to memo
 *    anchoring (payload extended with its fixtureId); every other fixture
 *    keeps program anchoring. No run-wide flag ever flips.
 *
 * Terminal group records (confirmed/failed) go to data/anchors.jsonl —
 * program-target records carry `target: 'program'`, the fixture id, and the
 * chain-local bounds; demoted groups carry `target: 'memo-fixture'` + the
 * fixture id — so scripts/verify-anchors.ts knows which verification to run
 * per record. Every state change is published on the bus as an AnchorBatch
 * event (global seq bounds, one per group).
 *
 * Resilience contract: an RPC failure never crashes or blocks anything —
 * the failed range stays queued and is retried on the next interval.
 */

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const MAX_BATCH_EVENTS = 2000;
/** Error marker: program anchoring is structurally impossible → use memo. */
export const CONTINUITY_FALLBACK = 'KEEPER_BOOK_CONTINUITY_FALLBACK';

/** One per-fixture blotter group routed to the keeper_book program. */
export interface EpochCommit {
  fixtureId: string;
  /** Hex merkle root over the group's canonical-JSON event leaves (global seqs). */
  rootHex: string;
  /**
   * CHAIN-LOCAL bounds: chainStart = events already anchored for this fixture
   * this run, chainEndExclusive = chainStart + group size. These satisfy the
   * on-chain continuity gate directly (no conversion) — the chain stores the
   * exclusive bound.
   */
  chainStart: number;
  chainEndExclusive: number;
  /** GLOBAL blotter seq bounds of the group (inclusive) — for the blotter record. */
  globalStart: number;
  globalEnd: number;
  /** Signed inventory [home, draw, away], stake units ×1e6 (rounded). */
  inventoryMicro: [number, number, number];
  /** Mark-to-market P&L, stake units ×1e6 (rounded). */
  mtmPnlMicro: number;
  /** Feed timestamp (ms) of the newest event in the group — epoch-day fallback. */
  tsMs: number;
}

export interface AnchorerDeps {
  bus: Bus;
  config: Config;
  /**
   * Injectable transaction sender (tests / dry runs): receives the UTF-8 memo
   * payload, returns the confirmed signature. Defaults to a real devnet Memo
   * transaction signed with config.solana.secretKey.
   */
  send?: (memoPayload: string) => Promise<string>;
  /**
   * Injectable program-target sender (tests / dry runs): receives one
   * EpochCommit, returns the confirmed record_epoch signature. Defaults to a
   * real keeper_book client that lazily init_books each fixture.
   */
  sendEpoch?: (commit: EpochCommit) => Promise<string>;
  /**
   * Fixture metadata for lazy init_book (program target only): kickoff
   * epoch-day (UTC days since epoch) and TxLINE Participant1IsHome. When
   * absent (or returning null) the anchorer falls back to the epoch-day of
   * the batch's feed timestamp and p1IsHome=true — correct for replayed
   * recordings, and settle_book tolerates epoch_day or epoch_day+1 anyway.
   */
  fixtureInfo?: (fixtureId: string) => { epochDay: number; p1IsHome: boolean } | null;
  /** Directory for events.jsonl / anchors.jsonl (default: data/). */
  dataDir?: string;
}

export interface AnchorerHandle {
  /** Run one anchor cycle now (awaitable; used by tests and the smoke script). */
  runCycle(): Promise<void>;
  /** Stop the interval timer and the bus subscription. */
  stop(): void;
}

interface MemoPayload {
  app: 'keeper';
  v: 1;
  seqStart: number;
  seqEnd: number;
  count: number;
  root: string;
  /** Present only on per-fixture continuity-fallback groups (program mode). */
  fixtureId?: string;
}

function makeDefaultSender(config: Config): (memoPayload: string) => Promise<string> {
  const secretKey = config.solana.secretKey;
  if (!secretKey) throw new Error('anchorer: no secret key for default sender');
  const keypair = Keypair.fromSecretKey(bs58.decode(secretKey));
  const connection = new Connection(config.solana.rpcUrl, 'confirmed');
  return async (memoPayload: string) => {
    const ix = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [],
      data: Buffer.from(memoPayload, 'utf8'),
    });
    const tx = new Transaction().add(ix);
    return sendAndConfirmTransaction(connection, tx, [keypair], { commitment: 'confirmed' });
  };
}

/**
 * Default program-target sender: lazy init_book once per fixture, then
 * record_epoch per group. The commit's chain-local bounds are ALREADY in the
 * chain's convention (exclusive end) — no conversion here.
 */
function makeDefaultEpochSender(
  config: Config,
  fixtureInfo: AnchorerDeps['fixtureInfo'],
): (commit: EpochCommit) => Promise<string> {
  const client = BookClient.fromConfig(config);
  if (!client) throw new Error('anchorer: program target without KEEPER_PROGRAM_ID');
  const ensured = new Set<string>();
  return async (commit: EpochCommit) => {
    if (!ensured.has(commit.fixtureId)) {
      const info = fixtureInfo?.(commit.fixtureId) ?? null;
      const epochDay = info?.epochDay ?? Math.floor(commit.tsMs / 86_400_000);
      const p1IsHome = info?.p1IsHome ?? true;
      const ensure = await client.ensureBook(commit.fixtureId, epochDay, p1IsHome);
      if (ensure.created) {
        log.info(
          { fixtureId: commit.fixtureId, address: ensure.address, epochDay, p1IsHome },
          'chain: init_book — on-chain book opened',
        );
      } else {
        // Existing book: our chain-local counters restart at 0 every process
        // boot, but the on-chain continuity gate remembers where the last run
        // stopped. A mismatch here is STRUCTURAL (rerunning an
        // already-anchored fixture), not transient — surface it as the
        // fallback marker so the anchorer demotes THIS FIXTURE to memo
        // instead of retrying a range the chain will reject forever.
        const book = await client.fetchBook(commit.fixtureId);
        if (book && book.seqEnd !== commit.chainStart) {
          throw new Error(
            `${CONTINUITY_FALLBACK}: on-chain book for fixture ${commit.fixtureId} expects ` +
              `seq_start ${book.seqEnd}, this run's chain-local cursor is at ${commit.chainStart} ` +
              `(book already anchored by a previous run)`,
          );
        }
      }
      ensured.add(commit.fixtureId);
    }
    return client.recordEpoch(commit.fixtureId, {
      root: Buffer.from(commit.rootHex, 'hex'),
      seqStart: commit.chainStart,
      seqEndExclusive: commit.chainEndExclusive,
      inventoryMicro: commit.inventoryMicro,
      mtmPnlMicro: commit.mtmPnlMicro,
    });
  };
}

/** Stake units → integer micro units (×1e6) for on-chain i64 fields. */
export const toMicro = (v: number): number => Math.round(v * 1_000_000);

export function startAnchorer(deps: AnchorerDeps): AnchorerHandle {
  const { bus, config } = deps;
  const noop: AnchorerHandle = { runCycle: async () => {}, stop: () => {} };

  if (!config.solana.anchorEnabled) {
    log.info('chain: anchoring disabled (ANCHOR_ENABLED=false) — skipping');
    return noop;
  }
  if (!deps.send && !deps.sendEpoch && !config.solana.secretKey) {
    log.warn('chain: no SOLANA_SECRET_KEY — anchoring skipped');
    return noop;
  }

  // Target selection. `program` needs a program id (or an injected sender);
  // without one we degrade to memo instead of silently anchoring nothing.
  const wantProgram = config.solana.anchorTarget === 'program';
  const canProgram = deps.sendEpoch !== undefined || config.solana.programId !== undefined;
  if (wantProgram && !canProgram) {
    log.warn('chain: ANCHOR_TARGET=program but KEEPER_PROGRAM_ID unset — falling back to memo');
  }
  const useProgram = wantProgram && canProgram;

  let memoSend =
    deps.send ?? (config.solana.secretKey && !useProgram ? makeDefaultSender(config) : null);
  /** Memo sender on demand — also the continuity-fallback escape hatch. */
  const getMemoSend = (): ((memoPayload: string) => Promise<string>) | null => {
    if (!memoSend && config.solana.secretKey) memoSend = makeDefaultSender(config);
    return memoSend;
  };
  const sendEpoch =
    deps.sendEpoch ??
    (useProgram && config.solana.secretKey
      ? makeDefaultEpochSender(config, deps.fixtureInfo)
      : null);
  const dataDir = deps.dataDir ?? 'data';
  fs.mkdirSync(dataDir, { recursive: true });
  const eventsPath = path.join(dataDir, 'events.jsonl');
  const anchorsPath = path.join(dataDir, 'anchors.jsonl');

  // Seq numbers restart at 0 every process boot, so a blotter appended across
  // runs would collide with itself and fail verification. Rotate any existing
  // pair aside so events.jsonl/anchors.jsonl always describe THIS run only
  // (verify-anchors can be pointed at rotated pairs via its dataDir argument).
  if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > 0) {
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(eventsPath, path.join(dataDir, `events-${suffix}.jsonl`));
    if (fs.existsSync(anchorsPath)) {
      fs.renameSync(anchorsPath, path.join(dataDir, `anchors-${suffix}.jsonl`));
    }
    log.info({ suffix }, 'chain: rotated previous run blotter');
  }

  // --- blotter: persist every seq-stamped engine event as canonical JSONL ---
  let writeCursor = 0; // index into bus.engineLog of the next record to persist
  const persistNewEvents = (): void => {
    while (writeCursor < bus.engineLog.length) {
      const rec = bus.engineLog[writeCursor]!;
      fs.appendFileSync(eventsPath, canonicalJson({ seq: rec.seq, event: rec.event }) + '\n');
      writeCursor++;
    }
  };
  const onEngine = (): void => {
    try {
      persistNewEvents();
    } catch (err) {
      log.error({ err }, 'chain: failed to append to events blotter');
    }
  };
  bus.on('engine', onEngine);

  // --- anchoring: hash the un-anchored range, publish the root to devnet ---
  let anchorCursor = 0; // index into bus.engineLog of the first un-anchored record
  let cycleRunning = false;
  const programMode = useProgram && sendEpoch !== null;

  // --- per-fixture program-mode state (never a run-wide flag) ---
  /** Anchor route per fixture; a CONTINUITY_FALLBACK demotes ONLY that fixture. */
  const fixtureTarget = new Map<string, 'program' | 'memo'>();
  /** Events anchored per fixture THIS RUN — the chain-local bound base. */
  const localCount = new Map<string, number>();
  /** Newest BookSnapshot seen per fixture (carried across cycles). */
  const latestBook = new Map<string, BookSnapshot>();
  /**
   * Highest GLOBAL seq already anchored per fixture. Makes window retries
   * idempotent: groups (or group prefixes) at or below this mark were sent in
   * a previous attempt of the same window and are skipped, never re-sent.
   */
  const anchoredThroughGlobal = new Map<string, number>();

  const microFromBook = (
    snap: BookSnapshot | undefined,
  ): { inventoryMicro: [number, number, number]; mtmPnlMicro: number } => ({
    inventoryMicro: snap
      ? [toMicro(snap.inventory.home), toMicro(snap.inventory.draw), toMicro(snap.inventory.away)]
      : [0, 0, 0],
    mtmPnlMicro: snap ? toMicro(snap.mtmPnl) : 0,
  });

  const memoPayloadJson = (
    seqStart: number,
    seqEnd: number,
    count: number,
    root: string,
    fixtureId?: string,
  ): string => {
    const payload: MemoPayload = {
      app: 'keeper',
      v: 1,
      seqStart,
      seqEnd,
      count,
      root,
      ...(fixtureId !== undefined ? { fixtureId } : {}),
    };
    return JSON.stringify(payload);
  };

  const appendAnchorRecord = (terminal: AnchorBatch, extra?: Record<string, unknown>): void => {
    try {
      const record = extra ? { ...terminal, ...extra } : terminal;
      fs.appendFileSync(anchorsPath, JSON.stringify(record) + '\n');
    } catch (err) {
      log.error({ err }, 'chain: failed to append to anchors.jsonl');
    }
  };

  /** Legacy memo path (ANCHOR_TARGET=memo, or program config without an id): unchanged. */
  const anchorOneMemoBatch = async (): Promise<boolean> => {
    const pending = bus.engineLog.slice(anchorCursor, anchorCursor + MAX_BATCH_EVENTS);
    if (pending.length === 0) return false;

    const seqStart = pending[0]!.seq;
    const seqEnd = pending[pending.length - 1]!.seq;
    const root = merkleRoot(pending.map((rec) => leafHash(rec))).toString('hex');

    bus.publishAnchor({ kind: 'anchor', ts: Date.now(), seqStart, seqEnd, root, status: 'pending' });

    let terminal: AnchorBatch;
    try {
      const memo = getMemoSend();
      if (!memo) throw new Error('anchorer: no memo sender available');
      const sig = await memo(memoPayloadJson(seqStart, seqEnd, pending.length, root));
      terminal = {
        kind: 'anchor',
        ts: Date.now(),
        seqStart,
        seqEnd,
        root,
        status: 'confirmed',
        sig,
        explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      };
      anchorCursor += pending.length;
      log.info({ seqStart, seqEnd, root, sig, target: 'memo' }, 'chain: anchor confirmed');
    } catch (err) {
      terminal = {
        kind: 'anchor',
        ts: Date.now(),
        seqStart,
        seqEnd,
        root,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
      log.warn({ seqStart, seqEnd, err }, 'chain: anchor failed — range stays queued for retry');
    }
    bus.publishAnchor(terminal);
    appendAnchorRecord(terminal);
    return terminal.status === 'confirmed';
  };

  /** One per-fixture group of the pending window (records share event.fixtureId). */
  interface FixtureGroup {
    fixtureId: string;
    records: Array<{ seq: number; event: EngineEvent }>;
  }

  /**
   * Program mode, one window: group the pending global window by fixture and
   * resolve every group (record_epoch, per-fixture memo fallback, or skip when
   * a retry already anchored it). The global cursor advances ONLY when every
   * group resolved, so a transient failure keeps the whole window queued —
   * and anchoredThroughGlobal keeps the retry idempotent.
   */
  const anchorProgramWindow = async (): Promise<boolean> => {
    const pending = bus.engineLog.slice(anchorCursor, anchorCursor + MAX_BATCH_EVENTS);
    if (pending.length === 0) return false;

    // Book snapshots ride along with each fixture's epoch — track the newest
    // per fixture (a later group without one reuses the carried snapshot).
    for (const rec of pending) {
      if (rec.event.kind === 'book') latestBook.set(rec.event.fixtureId, rec.event);
    }

    // Group by fixture, in order of first appearance, dropping records a
    // previous attempt of this window already anchored (retry idempotence —
    // the window can also have GROWN since that attempt).
    const groups = new Map<string, FixtureGroup>();
    for (const rec of pending) {
      const fixtureId = rec.event.fixtureId;
      if (rec.seq <= (anchoredThroughGlobal.get(fixtureId) ?? -1)) continue;
      let group = groups.get(fixtureId);
      if (!group) {
        group = { fixtureId, records: [] };
        groups.set(fixtureId, group);
      }
      group.records.push(rec);
    }

    let allResolved = true;
    for (const group of groups.values()) {
      const { fixtureId, records } = group;
      const globalStart = records[0]!.seq;
      const globalEnd = records[records.length - 1]!.seq;
      const root = merkleRoot(records.map((rec) => leafHash(rec))).toString('hex');
      const chainStart = localCount.get(fixtureId) ?? 0;

      bus.publishAnchor({
        kind: 'anchor',
        ts: Date.now(),
        seqStart: globalStart,
        seqEnd: globalEnd,
        root,
        status: 'pending',
      });

      // Extra blotter fields so verify-anchors picks the right verification
      // per record (EpochRecorded event vs fixture-scoped memo payload).
      let blotterExtra: Record<string, unknown>;
      let terminal: AnchorBatch;
      try {
        let sig: string;
        if (fixtureTarget.get(fixtureId) === 'memo') {
          const memo = getMemoSend();
          if (!memo) throw new Error('anchorer: no memo sender available');
          sig = await memo(memoPayloadJson(globalStart, globalEnd, records.length, root, fixtureId));
          blotterExtra = { target: 'memo-fixture', fixtureId, count: records.length };
        } else {
          const commit: EpochCommit = {
            fixtureId,
            rootHex: root,
            chainStart,
            chainEndExclusive: chainStart + records.length,
            globalStart,
            globalEnd,
            ...microFromBook(latestBook.get(fixtureId)),
            tsMs: records[records.length - 1]!.event.ts,
          };
          blotterExtra = { target: 'program', fixtureId, chainStart, count: records.length };
          try {
            sig = await sendEpoch!(commit);
            localCount.set(fixtureId, chainStart + records.length);
          } catch (err) {
            // Structural continuity rejection (0x1771 = ContinuityBroken):
            // this fixture's on-chain book was anchored by a previous run and
            // can never accept this run's chain-local 0 restart. Not
            // retryable — demote ONLY this fixture to memo anchoring so its
            // tamper evidence continues while other fixtures stay on-program.
            const msg = err instanceof Error ? err.message : String(err);
            const memo =
              msg.includes(CONTINUITY_FALLBACK) || msg.includes('0x1771') ? getMemoSend() : null;
            if (!memo) throw err;
            log.warn(
              { fixtureId, reason: msg },
              'chain: continuity fallback — this fixture anchors via memo for the rest of the run',
            );
            fixtureTarget.set(fixtureId, 'memo');
            sig = await memo(memoPayloadJson(globalStart, globalEnd, records.length, root, fixtureId));
            blotterExtra = { target: 'memo-fixture', fixtureId, count: records.length };
          }
        }
        anchoredThroughGlobal.set(fixtureId, globalEnd);
        terminal = {
          kind: 'anchor',
          ts: Date.now(),
          seqStart: globalStart,
          seqEnd: globalEnd,
          root,
          status: 'confirmed',
          sig,
          explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
        };
        log.info(
          {
            fixtureId,
            seqStart: globalStart,
            seqEnd: globalEnd,
            root,
            sig,
            target: fixtureTarget.get(fixtureId) === 'memo' ? 'memo-fixture' : 'program',
          },
          'chain: anchor confirmed',
        );
      } catch (err) {
        allResolved = false;
        terminal = {
          kind: 'anchor',
          ts: Date.now(),
          seqStart: globalStart,
          seqEnd: globalEnd,
          root,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
        blotterExtra = { fixtureId };
        log.warn(
          { fixtureId, seqStart: globalStart, seqEnd: globalEnd, err },
          'chain: anchor failed — window stays queued for retry',
        );
      }
      bus.publishAnchor(terminal);
      appendAnchorRecord(terminal, blotterExtra);
    }

    if (!allResolved) return false;
    anchorCursor += pending.length;
    return true;
  };

  const anchorOneBatch = programMode ? anchorProgramWindow : anchorOneMemoBatch;

  const runCycle = async (): Promise<void> => {
    if (cycleRunning) return; // never overlap slow RPC cycles
    cycleRunning = true;
    try {
      persistNewEvents(); // catch anything the listener missed (e.g. pre-start events)
      // Anchor successive capped batches until caught up; stop on first failure
      // (the failed range retries next interval).
      while (anchorCursor < bus.engineLog.length) {
        const ok = await anchorOneBatch();
        if (!ok) break;
      }
    } catch (err) {
      log.error({ err }, 'chain: anchor cycle error (swallowed — will retry)');
    } finally {
      cycleRunning = false;
    }
  };

  const timer = setInterval(() => void runCycle(), config.solana.anchorIntervalSec * 1000);
  timer.unref?.();
  log.info(
    {
      intervalSec: config.solana.anchorIntervalSec,
      dataDir,
      target: programMode ? 'program' : 'memo',
      ...(programMode && config.solana.programId ? { programId: config.solana.programId } : {}),
    },
    'chain: anchorer started (devnet anchoring)',
  );

  return {
    runCycle,
    stop: () => {
      clearInterval(timer);
      bus.off('engine', onEngine);
    },
  };
}
