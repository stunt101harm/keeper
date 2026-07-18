/**
 * init-book — open the on-chain keeper_book account for a fixture.
 *
 *   npx tsx scripts/init-book.ts <fixtureId> <epochDay> <p1IsHome: true|false>
 *
 * Example (England v Argentina semifinal):
 *   npx tsx scripts/init-book.ts 18241006 20649 true
 *
 * Requires .env: SOLANA_SECRET_KEY (payer/authority), KEEPER_PROGRAM_ID.
 * Idempotent: an existing book is reported, not an error.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import { BookClient, explorerAddress, explorerTx } from '../src/chain/book.js';

const [fixtureId, epochDayArg, p1IsHomeArg] = process.argv.slice(2);
if (!fixtureId || !epochDayArg || !p1IsHomeArg) {
  console.error('usage: npx tsx scripts/init-book.ts <fixtureId> <epochDay> <p1IsHome>');
  process.exit(1);
}
const epochDay = Number(epochDayArg);
const p1IsHome = p1IsHomeArg === 'true' || p1IsHomeArg === '1';

const config = loadConfig();
const client = BookClient.fromConfig(config);
if (!client) {
  console.error('KEEPER_PROGRAM_ID is not set');
  process.exit(1);
}

const result = await client.ensureBook(fixtureId, epochDay, p1IsHome);
console.log(`book:     ${result.address}`);
console.log(`          ${explorerAddress(result.address)}`);
if (result.created && result.sig) {
  console.log(`init tx:  ${result.sig}`);
  console.log(`          ${explorerTx(result.sig)}`);
} else {
  console.log('already initialised — nothing to do');
}
const book = await client.fetchBook(fixtureId);
console.log(JSON.stringify(book, null, 2));
