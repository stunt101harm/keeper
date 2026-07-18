/**
 * verify-anchors — the tamper-evidence audit.
 *
 * Reads data/events.jsonl (the blotter) + data/anchors.jsonl (confirmed
 * batches), recomputes each batch's merkle root from the blotter, fetches the
 * corresponding devnet transaction, and compares roots. Any mismatch
 * (including a single flipped byte in events.jsonl) exits 1.
 *
 * Three record shapes, detected PER RECORD from the blotter line:
 *  - memo records WITHOUT a fixtureId: legacy contiguous global window — the
 *    root covers EVERY blotter seq in seqStart..seqEnd and lives in the Memo
 *    instruction's JSON payload. Verified as before.
 *  - `target: "program"` records: one PER-FIXTURE group — the root covers the
 *    blotter events with that fixtureId inside seqStart..seqEnd (global seqs;
 *    other fixtures' events interleave and are NOT included). The on-chain
 *    root lives in the keeper_book EpochRecorded event (Anchor `Program
 *    data:` log) alongside CHAIN-LOCAL bounds, which must equal the record's
 *    chainStart..chainStart+count.
 *  - memo records WITH a fixtureId (`target: "memo-fixture"`): a per-fixture
 *    group demoted by the continuity fallback — same fixture-filtered root
 *    recompute, compared against the memo payload's root.
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
  event: { fixtureId?: string };
}

interface AnchorRecord {
  seqStart: number;
  seqEnd: number;
  root: string;
  status: string;
  sig?: string;
  /** 'program' | 'memo-fixture' for per-fixture groups; absent for legacy memo. */
  target?: string;
  fixtureId?: string;
  /** Program groups: chain-local start accepted by the continuity gate. */
  chainStart?: number;
  /** Per-fixture groups: number of events the root covers. */
  count?: number;
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

/** On-chain root for a memo anchor (legacy or memo-fixture): the memo's JSON payload. */
async function onChainRootFromMemo(connection: Connection, anchor: AnchorRecord): Promise<string> {
  if (!anchor.sig) return '(no sig)';
  const payload = await fetchMemoPayload(connection, anchor.sig);
  if (!payload) return '(tx not found)';
  try {
    const memo = JSON.parse(payload) as {
      root?: string;
      seqStart?: number;
      seqEnd?: number;
      fixtureId?: string;
    };
    let root = memo.root ?? '(no root in memo)';
    if (memo.seqStart !== anchor.seqStart || memo.seqEnd !== anchor.seqEnd) {
      root += ` (range mismatch: memo says ${memo.seqStart}..${memo.seqEnd})`;
    }
    if (anchor.fixtureId !== undefined && memo.fixtureId !== anchor.fixtureId) {
      root += ` (fixture mismatch: memo says ${memo.fixtureId ?? '(none)'})`;
    }
    return root;
  } catch {
    return '(memo not JSON)';
  }
}

/**
 * On-chain root for a program anchor: the EpochRecorded event emitted by the
 * keeper_book record_epoch transaction. The event carries CHAIN-LOCAL bounds
 * (exclusive end) which must equal chainStart..chainStart+count. Legacy
 * records without chainStart fall back to the old global-range check
 * (chain seq_end is exclusive → blotter seqEnd + 1).
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
  const expectedStart = anchor.chainStart ?? anchor.seqStart;
  const expectedEndExclusive =
    anchor.chainStart !== undefined && anchor.count !== undefined
      ? anchor.chainStart + anchor.count
      : anchor.seqEnd + 1;
  if (event.seqStart !== expectedStart || event.seqEnd !== expectedEndExclusive) {
    root += ` (chain-bounds mismatch: event says ${event.seqStart}..${event.seqEnd} excl, expected ${expectedStart}..${expectedEndExclusive} excl)`;
  }
  if (anchor.fixtureId !== undefined && event.fixtureId !== anchor.fixtureId) {
    root += ` (fixture mismatch: event says ${event.fixtureId})`;
  }
  return root;
}

async function main(): Promise<void> {
  const blotter = readJsonl<BlotterRecord>(eventsPath);
  const events = new Map<number, BlotterRecord>();
  for (const rec of blotter) events.set(rec.seq, rec);
  const ordered = [...blotter].sort((a, b) => a.seq - b.seq);

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
      pad('TARGET', 14) +
      pad('FIXTURE', 10) +
      pad('RECOMPUTED ROOT', 66) +
      pad('ON-CHAIN ROOT', 66) +
      'VERDICT',
  );

  for (const anchor of anchors) {
    const range = `${anchor.seqStart}..${anchor.seqEnd}`;
    const target =
      anchor.target === 'program'
        ? 'program'
        : anchor.fixtureId !== undefined
          ? 'memo-fixture'
          : 'memo';
    const fixture = anchor.fixtureId ?? '-';
    const leaves: Buffer[] = [];
    let problem: string | null = null;

    if (anchor.fixtureId !== undefined) {
      // Per-fixture group: the root covers this fixture's events inside the
      // global range — other fixtures' events interleave and are excluded.
      for (const rec of ordered) {
        if (rec.seq < anchor.seqStart || rec.seq > anchor.seqEnd) continue;
        if (rec.event?.fixtureId !== anchor.fixtureId) continue;
        leaves.push(leafHash({ seq: rec.seq, event: rec.event }));
      }
      if (leaves.length === 0) problem = `no blotter events for fixture ${anchor.fixtureId} in range`;
      else if (anchor.count !== undefined && leaves.length !== anchor.count) {
        problem = `blotter has ${leaves.length} events for fixture ${anchor.fixtureId} in range, record says ${anchor.count}`;
      }
    } else {
      // Legacy contiguous global window: every seq must be present.
      for (let seq = anchor.seqStart; seq <= anchor.seqEnd; seq++) {
        const rec = events.get(seq);
        if (!rec) {
          problem = `MISSING seq ${seq} in blotter`;
          break;
        }
        // Recompute the leaf from the parsed record via canonicalJson — catches
        // any value tampering regardless of on-disk formatting.
        leaves.push(leafHash({ seq: rec.seq, event: rec.event }));
      }
    }
    if (problem !== null) {
      console.log(pad(range, 14) + pad(target, 14) + pad(fixture, 10) + `${problem} — MISMATCH`);
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
        pad(target, 14) +
        pad(fixture, 10) +
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
