/**
 * Close an UNSETTLED on-chain book (authority-only operational reset; the
 * program refuses settled books — proven outcomes are permanent).
 *
 *   tsx scripts/close-book.ts <fixtureId>
 */
import { loadConfig } from '../src/config.js';
import { BookClient } from '../src/chain/book.js';

const fixtureId = process.argv[2];
if (!fixtureId) {
  console.error('usage: tsx scripts/close-book.ts <fixtureId>');
  process.exit(1);
}

const client = BookClient.fromConfig(loadConfig());
if (!client) {
  console.error('KEEPER_PROGRAM_ID / SOLANA_SECRET_KEY not configured');
  process.exit(1);
}

const before = await client.fetchBook(fixtureId);
if (!before) {
  console.log(`no on-chain book for fixture ${fixtureId} — nothing to close`);
  process.exit(0);
}
console.log(
  `closing book for fixture ${fixtureId}: status=${before.status} epochs=${before.epochCount} seqEnd=${before.seqEnd}`,
);
const sig = await client.closeBook(fixtureId);
console.log(`closed: ${sig}`);
const after = await client.fetchBook(fixtureId);
console.log(after ? 'WARNING: book still exists' : 'verified: book account closed');
