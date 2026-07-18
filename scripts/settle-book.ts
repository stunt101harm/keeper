/**
 * settle-book — proof-gated on-chain settlement of a keeper_book.
 *
 *   npx tsx scripts/settle-book.ts <fixtureId> [--seq N] [--proof-file path]
 *
 * Default flow: scan /scores/snapshot for the game_finalised Seq, fetch the
 * Merkle proof for stat keys 1,2 (final goals) at that Seq, and fire
 * settle_book. `--seq` pins the finalised Seq explicitly; `--proof-file`
 * settles from a saved stat-validation JSON (e.g.
 * fixtures/proof_18241006_seq962_k1-2.json) without touching the TxLINE API.
 *
 * Settlement is PERMISSIONLESS on-chain — this script is just one possible
 * caller; the paid fee is its only stake in the outcome.
 */
import 'dotenv/config';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { settleBookOnChain } from '../src/chain/settle.js';
import { BookClient } from '../src/chain/book.js';
import type { StatValidationProof } from '../src/chain/txproof.js';

const args = process.argv.slice(2);
const fixtureId = args[0];
if (!fixtureId || fixtureId.startsWith('--')) {
  console.error('usage: npx tsx scripts/settle-book.ts <fixtureId> [--seq N] [--proof-file path]');
  process.exit(1);
}
const seqIdx = args.indexOf('--seq');
const proofIdx = args.indexOf('--proof-file');

const config = loadConfig();
const opts: { seq?: number; proof?: StatValidationProof } = {};
if (seqIdx >= 0) opts.seq = Number(args[seqIdx + 1]);
if (proofIdx >= 0) {
  opts.proof = JSON.parse(fs.readFileSync(args[proofIdx + 1]!, 'utf8')) as StatValidationProof;
}

const result = await settleBookOnChain(config, fixtureId, opts);
console.log(`settle tx:    ${result.sig}`);
console.log(`              ${result.explorerUrl}`);
console.log(`epoch day:    ${result.epochDay}`);
console.log(`proven goals: P1=${result.provenGoals[0]} P2=${result.provenGoals[1]}`);
console.log(`winner:       ${result.winner}`);

const client = BookClient.fromConfig(config);
const book = await client?.fetchBook(fixtureId);
console.log('on-chain book after settlement:');
console.log(JSON.stringify(book, null, 2));
