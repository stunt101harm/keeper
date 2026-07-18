/**
 * verify-anchors — the tamper-evidence audit.
 *
 * Reads data/events.jsonl (the blotter) + data/anchors.jsonl (confirmed
 * batches), recomputes each batch's merkle root from the blotter, fetches the
 * corresponding devnet memo transaction, and compares roots. Any mismatch
 * (including a single flipped byte in events.jsonl) exits 1.
 *
 * Usage: npx tsx scripts/verify-anchors.ts [dataDir]
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { leafHash, merkleRoot } from '../src/chain/merkle.js';
import { MEMO_PROGRAM_ID } from '../src/chain/anchorer.js';

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
    pad('RANGE', 14) + pad('RECOMPUTED ROOT', 66) + pad('ON-CHAIN ROOT', 66) + 'VERDICT',
  );

  for (const anchor of anchors) {
    const range = `${anchor.seqStart}..${anchor.seqEnd}`;
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
      console.log(pad(range, 14) + `MISSING seq ${missing} in blotter — MISMATCH`);
      failed = true;
      continue;
    }

    const recomputed = merkleRoot(leaves).toString('hex');

    let onChainRoot = '(tx not found)';
    if (anchor.sig) {
      const payload = await fetchMemoPayload(connection, anchor.sig);
      if (payload) {
        try {
          const memo = JSON.parse(payload) as { root?: string; seqStart?: number; seqEnd?: number };
          onChainRoot = memo.root ?? '(no root in memo)';
          if (memo.seqStart !== anchor.seqStart || memo.seqEnd !== anchor.seqEnd) {
            onChainRoot += ` (range mismatch: memo says ${memo.seqStart}..${memo.seqEnd})`;
          }
        } catch {
          onChainRoot = '(memo not JSON)';
        }
      }
    }

    const match = recomputed === onChainRoot && recomputed === anchor.root;
    if (!match) failed = true;
    console.log(pad(range, 14) + pad(recomputed, 66) + pad(onChainRoot, 66) + (match ? 'MATCH' : 'MISMATCH'));
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
