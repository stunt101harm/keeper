/**
 * verify-anchors — the tamper-evidence audit.
 *
 * Reads data/events.jsonl (the blotter) + data/anchors.jsonl (confirmed
 * batches), recomputes each batch's merkle root from the blotter, fetches the
 * corresponding devnet transaction, and compares roots. Any mismatch
 * (including a single flipped byte in events.jsonl) exits 1.
 *
 * Two anchor targets, detected PER RECORD from the blotter line:
 *  - memo records (no `target` field): the root lives in the Memo
 *    instruction's JSON payload — verified as before.
 *  - `target: "program"` records: the root lives in the keeper_book
 *    program's EpochRecorded event (Anchor `Program data:` log), alongside
 *    the seq range the CHAIN accepted under its continuity gate. The event's
 *    seq_end is exclusive; the blotter's is inclusive (+1 conversion here).
 *
 * Usage: npx tsx scripts/verify-anchors.ts [dataDir]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { leafHash, merkleRoot } from '../src/chain/merkle.js';
import { MEMO_PROGRAM_ID } from '../src/chain/anchorer.js';
import { decodeEpochRecordedFromLogs } from '../src/chain/book.js';

const dataDir = process.argv[2] ?? 'data';
const eventsPath = path.join(dataDir, 'events.jsonl');
const anchorsPath = path.join(dataDir, 'anchors.jsonl');
const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';

interface BlotterRecord {
  seq: number;
  event: unknown;
}

interface AnchorRecord {
  seqStart: number;
  seqEnd: number;
  root: string;
  status: string;
  sig?: string;
  /** 'program' for record_epoch anchors; absent/'memo' for memo anchors. */
  target?: string;
  fixtureId?: string;
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) {
    console.error(`missing ${file}`);
    process.exit(1);
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as T);
}

async function fetchMemoPayload(connection: Connection, sig: string): Promise<string | null> {
  const tx = await connection.getParsedTransaction(sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return null;
  for (const ix of tx.transaction.message.instructions) {
    if (!('programId' in ix)) continue;
    if (!new PublicKey(ix.programId).equals(MEMO_PROGRAM_ID)) continue;
    if ('parsed' in ix && typeof ix.parsed === 'string') return ix.parsed;
  }
  return null;
}

/** On-chain root for a memo anchor: the memo's JSON payload. */
async function onChainRootFromMemo(connection: Connection, anchor: AnchorRecord): Promise<string> {
  if (!anchor.sig) return '(no sig)';
  const payload = await fetchMemoPayload(connection, anchor.sig);
  if (!payload) return '(tx not found)';
  try {
    const memo = JSON.parse(payload) as { root?: string; seqStart?: number; seqEnd?: number };
    let root = memo.root ?? '(no root in memo)';
    if (memo.seqStart !== anchor.seqStart || memo.seqEnd !== anchor.seqEnd) {
      root += ` (range mismatch: memo says ${memo.seqStart}..${memo.seqEnd})`;
    }
    return root;
  } catch {
    return '(memo not JSON)';
  }
}

/**
 * On-chain root for a program anchor: the EpochRecorded event emitted by the
 * keeper_book record_epoch transaction. The event's seq range must cover the
 * blotter record exactly (chain seq_end is exclusive → blotter seqEnd + 1).
 */
async function onChainRootFromEvent(connection: Connection, anchor: AnchorRecord): Promise<string> {
  if (!anchor.sig) return '(no sig)';
  const tx = await connection.getTransaction(anchor.sig, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return '(tx not found)';
  const events = decodeEpochRecordedFromLogs(tx.meta?.logMessages ?? []);
  const event = events[0];
  if (!event) return '(no EpochRecorded event in tx)';
  let root = event.rootHex;
  if (event.seqStart !== anchor.seqStart || event.seqEnd !== anchor.seqEnd + 1) {
    root += ` (range mismatch: event says ${event.seqStart}..${event.seqEnd} excl)`;
  }
  return root;
}

async function main(): Promise<void> {
  const events = new Map<number, BlotterRecord>();
  for (const rec of readJsonl<BlotterRecord>(eventsPath)) events.set(rec.seq, rec);

  const anchors = readJsonl<AnchorRecord>(anchorsPath).filter((a) => a.status === 'confirmed');
  if (anchors.length === 0) {
    console.error('no confirmed anchors in anchors.jsonl');
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, 'confirmed');
  let failed = false;
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    pad('RANGE', 14) +
      pad('TARGET', 9) +
      pad('RECOMPUTED ROOT', 66) +
      pad('ON-CHAIN ROOT', 66) +
      'VERDICT',
  );

  for (const anchor of anchors) {
    const range = `${anchor.seqStart}..${anchor.seqEnd}`;
    const target = anchor.target === 'program' ? 'program' : 'memo';
    const leaves: Buffer[] = [];
    let missing: number | null = null;
    for (let seq = anchor.seqStart; seq <= anchor.seqEnd; seq++) {
      const rec = events.get(seq);
      if (!rec) {
        missing = seq;
        break;
      }
      // Recompute the leaf from the parsed record via canonicalJson — catches
      // any value tampering regardless of on-disk formatting.
      leaves.push(leafHash({ seq: rec.seq, event: rec.event }));
    }
    if (missing !== null) {
      console.log(pad(range, 14) + pad(target, 9) + `MISSING seq ${missing} in blotter — MISMATCH`);
      failed = true;
      continue;
    }

    const recomputed = merkleRoot(leaves).toString('hex');
    const onChainRoot =
      target === 'program'
        ? await onChainRootFromEvent(connection, anchor)
        : await onChainRootFromMemo(connection, anchor);

    const match = recomputed === onChainRoot && recomputed === anchor.root;
    if (!match) failed = true;
    console.log(
      pad(range, 14) +
        pad(target, 9) +
        pad(recomputed, 66) +
        pad(onChainRoot, 66) +
        (match ? 'MATCH' : 'MISMATCH'),
    );
  }

  if (failed) {
    console.error('\nVERIFICATION FAILED — blotter does not match on-chain anchors');
    process.exit(1);
  }
  console.log('\nAll anchors verified — blotter is consistent with on-chain roots.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
