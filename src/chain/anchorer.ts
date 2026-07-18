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
import type { AnchorBatch } from '../types.js';
import { log } from '../log.js';
import { canonicalJson, leafHash, merkleRoot } from './merkle.js';

/**
 * Anchorer — the tamper-evidence layer.
 *
 * Every engine event (already seq-stamped by the Bus) is appended to
 * data/events.jsonl (the auditable blotter). Every anchorIntervalSec of wall
 * clock, the un-anchored seq range is hashed into a binary merkle root and the
 * root is published to Solana devnet via the Memo program. Terminal batch
 * records (confirmed/failed) go to data/anchors.jsonl, and every batch state
 * change is published on the bus as an AnchorBatch event.
 *
 * Resilience contract: an RPC failure never crashes or blocks anything —
 * the failed range stays queued and is retried on the next interval.
 */

export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const MAX_BATCH_EVENTS = 2000;

export interface AnchorerDeps {
  bus: Bus;
  config: Config;
  /**
   * Injectable transaction sender (tests / dry runs): receives the UTF-8 memo
   * payload, returns the confirmed signature. Defaults to a real devnet Memo
   * transaction signed with config.solana.secretKey.
   */
  send?: (memoPayload: string) => Promise<string>;
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

export function startAnchorer(deps: AnchorerDeps): AnchorerHandle {
  const { bus, config } = deps;
  const noop: AnchorerHandle = { runCycle: async () => {}, stop: () => {} };

  if (!config.solana.anchorEnabled) {
    log.info('chain: anchoring disabled (ANCHOR_ENABLED=false) — skipping');
    return noop;
  }
  if (!deps.send && !config.solana.secretKey) {
    log.warn('chain: no SOLANA_SECRET_KEY — anchoring skipped');
    return noop;
  }

  const send = deps.send ?? makeDefaultSender(config);
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

  // --- anchoring: hash the un-anchored range, memo the root to devnet ---
  let anchorCursor = 0; // index into bus.engineLog of the first un-anchored record
  let cycleRunning = false;

  const anchorOneBatch = async (): Promise<boolean> => {
    const pending = bus.engineLog.slice(anchorCursor, anchorCursor + MAX_BATCH_EVENTS);
    if (pending.length === 0) return false;

    const seqStart = pending[0]!.seq;
    const seqEnd = pending[pending.length - 1]!.seq;
    const root = merkleRoot(pending.map((rec) => leafHash(rec))).toString('hex');
    const payload: MemoPayload = {
      app: 'keeper',
      v: 1,
      seqStart,
      seqEnd,
      count: pending.length,
      root,
    };

    bus.publishAnchor({ kind: 'anchor', ts: Date.now(), seqStart, seqEnd, root, status: 'pending' });

    let terminal: AnchorBatch;
    try {
      const sig = await send(JSON.stringify(payload));
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
      log.info({ seqStart, seqEnd, root, sig }, 'chain: anchor confirmed');
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
      fs.appendFileSync(anchorsPath, JSON.stringify(terminal) + '\n');
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
    { intervalSec: config.solana.anchorIntervalSec, dataDir },
    'chain: anchorer started (devnet memo anchoring)',
  );

  return {
    runCycle,
    stop: () => {
      clearInterval(timer);
      bus.off('engine', onEngine);
    },
  };
}
