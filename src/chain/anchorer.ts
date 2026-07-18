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
 *  - ANCHOR_TARGET=program (+ KEEPER_PROGRAM_ID): the root goes into the
 *    keeper_book program as a `record_epoch` — a typed on-chain account per
 *    fixture with an ON-CHAIN continuity gate (each epoch's seqStart must
 *    equal the stored seq_end), plus the book's live inventory and
 *    mark-to-market P&L in micro units. The book is lazily `init_book`ed
 *    once per fixture on the first batch.
 *
 * Terminal batch records (confirmed/failed) go to data/anchors.jsonl —
 * program-target records additionally carry `target: 'program'` and the
 * fixture id so scripts/verify-anchors.ts knows to verify the EpochRecorded
 * event instead of a memo. Every batch state change is published on the bus
 * as an AnchorBatch event.
 *
 * Resilience contract: an RPC failure never crashes or blocks anything —
 * the failed range stays queued and is retried on the next interval.
 */

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const MAX_BATCH_EVENTS = 2000;
/** Error marker: program anchoring is structurally impossible → use memo. */
export const CONTINUITY_FALLBACK = 'KEEPER_BOOK_CONTINUITY_FALLBACK';

/** One blotter batch routed to the keeper_book program. */
export interface EpochCommit {
  fixtureId: string;
  /** Hex merkle root over the batch's canonical-JSON event leaves. */
  rootHex: string;
  /** Inclusive blotter range (converted to the chain's exclusive bound by the sender). */
  seqStart: number;
  seqEnd: number;
  /** Signed inventory [home, draw, away], stake units ×1e6 (rounded). */
  inventoryMicro: [number, number, number];
  /** Mark-to-market P&L, stake units ×1e6 (rounded). */
  mtmPnlMicro: number;
  /** Feed timestamp (ms) of the newest event in the batch — epoch-day fallback. */
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
 * record_epoch per batch. The chain stores the EXCLUSIVE seq bound, so the
 * blotter's inclusive seqEnd converts with +1 here (and only here).
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
        // Existing book: our blotter seqs restart at 0 every process boot,
        // but the on-chain continuity gate remembers where the last run
        // stopped. A mismatch here is STRUCTURAL (rerunning an
        // already-anchored fixture), not transient — surface it as the
        // fallback marker so the anchorer degrades to memo instead of
        // retrying a range the chain will reject forever.
        const book = await client.fetchBook(commit.fixtureId);
        if (book && book.seqEnd !== commit.seqStart) {
          throw new Error(
            `${CONTINUITY_FALLBACK}: on-chain book for fixture ${commit.fixtureId} expects ` +
              `seqStart ${book.seqEnd}, this run's blotter is at ${commit.seqStart} ` +
              `(book already anchored by a previous run)`,
          );
        }
      }
      ensured.add(commit.fixtureId);
    }
    return client.recordEpoch(commit.fixtureId, {
      root: Buffer.from(commit.rootHex, 'hex'),
      seqStart: commit.seqStart,
      seqEndExclusive: commit.seqEnd + 1,
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
  // Mutable: flips to false (memo fallback) when the on-chain continuity gate
  // rejects this run structurally — see CONTINUITY_FALLBACK below.
  let programActive = useProgram && sendEpoch !== null;

  // Program target: the book's inventory/mtm ride along with each epoch.
  // Track the newest BookSnapshot seen ACROSS batches, so a batch without one
  // (e.g. pure quote traffic) still commits the current book state.
  let latestBookSnapshot: BookSnapshot | null = null;

  const buildEpochCommit = (
    pending: ReadonlyArray<{ seq: number; event: EngineEvent }>,
    rootHex: string,
  ): EpochCommit => {
    for (const rec of pending) {
      if (rec.event.kind === 'book') latestBookSnapshot = rec.event;
    }
    const lastEvent = pending[pending.length - 1]!.event;
    const snap = latestBookSnapshot;
    return {
      fixtureId: snap?.fixtureId ?? lastEvent.fixtureId,
      rootHex,
      seqStart: pending[0]!.seq,
      seqEnd: pending[pending.length - 1]!.seq,
      inventoryMicro: snap
        ? [toMicro(snap.inventory.home), toMicro(snap.inventory.draw), toMicro(snap.inventory.away)]
        : [0, 0, 0],
      mtmPnlMicro: snap ? toMicro(snap.mtmPnl) : 0,
      tsMs: lastEvent.ts,
    };
  };

  const anchorOneBatch = async (): Promise<boolean> => {
    const pending = bus.engineLog.slice(anchorCursor, anchorCursor + MAX_BATCH_EVENTS);
    if (pending.length === 0) return false;

    const seqStart = pending[0]!.seq;
    const seqEnd = pending[pending.length - 1]!.seq;
    const root = merkleRoot(pending.map((rec) => leafHash(rec))).toString('hex');

    bus.publishAnchor({ kind: 'anchor', ts: Date.now(), seqStart, seqEnd, root, status: 'pending' });

    // Extra blotter fields for program-target records, so verify-anchors can
    // pick the right verification per record (memo payload vs EpochRecorded
    // event) without guessing.
    let blotterExtra: { target: 'program'; fixtureId: string } | null = null;

    const memoPayload = (): string => {
      const payload: MemoPayload = {
        app: 'keeper',
        v: 1,
        seqStart,
        seqEnd,
        count: pending.length,
        root,
      };
      return JSON.stringify(payload);
    };

    let terminal: AnchorBatch;
    try {
      let sig: string;
      if (programActive) {
        const commit = buildEpochCommit(pending, root);
        blotterExtra = { target: 'program', fixtureId: commit.fixtureId };
        try {
          sig = await sendEpoch!(commit);
        } catch (err) {
          // Structural continuity rejection (0x1771 = ContinuityBroken): the
          // on-chain book was anchored by a previous run and can never accept
          // this run's seq 0 restart. Not retryable — degrade the whole run
          // to memo anchoring so tamper evidence continues uninterrupted.
          const msg = err instanceof Error ? err.message : String(err);
          const memo =
            msg.includes(CONTINUITY_FALLBACK) || msg.includes('0x1771') ? getMemoSend() : null;
          if (!memo) throw err;
          log.warn(
            { fixtureId: commit.fixtureId, reason: msg },
            'chain: continuity fallback — this run anchors via memo',
          );
          programActive = false;
          blotterExtra = null;
          sig = await memo(memoPayload());
        }
      } else {
        const memo = getMemoSend();
        if (!memo) throw new Error('anchorer: no memo sender available');
        sig = await memo(memoPayload());
      }
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
      log.info(
        { seqStart, seqEnd, root, sig, target: programActive ? 'program' : 'memo' },
        'chain: anchor confirmed',
      );
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
    try {
      const record = blotterExtra ? { ...terminal, ...blotterExtra } : terminal;
      fs.appendFileSync(anchorsPath, JSON.stringify(record) + '\n');
    } catch (err) {
      log.error({ err }, 'chain: failed to append to anchors.jsonl');
    }
    return terminal.status === 'confirmed';
  };

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
      target: programActive ? 'program' : 'memo',
      ...(programActive && config.solana.programId ? { programId: config.solana.programId } : {}),
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
