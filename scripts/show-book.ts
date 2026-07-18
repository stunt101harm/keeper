/**
 * show-book — display the on-chain keeper_book state for a fixture.
 *
 *   npx tsx scripts/show-book.ts [fixtureId]
 *
 * Without an argument, lists every book under the program. Read-only: needs
 * KEEPER_PROGRAM_ID but no signer.
 */
import 'dotenv/config';
import { loadConfig } from '../src/config.js';
import {
  BookClient,
  explorerAddress,
  type OnchainBook,
} from '../src/chain/book.js';

const config = loadConfig();
const client = BookClient.fromConfig(config);
if (!client) {
  console.error('KEEPER_PROGRAM_ID is not set');
  process.exit(1);
}

const fmtMicro = (v: number): string => (v / 1_000_000).toFixed(3);

function printBook(book: OnchainBook, address: string): void {
  const [home, draw, away] = book.inventoryMicro;
  console.log(`fixture ${book.fixtureId} — ${book.status.toUpperCase()}`);
  console.log(`  book:        ${address}`);
  console.log(`               ${explorerAddress(address)}`);
  console.log(`  authority:   ${book.authority}`);
  console.log(`  epoch day:   ${book.epochDay}  (p1IsHome=${book.p1IsHome})`);
  console.log(`  epochs:      ${book.epochCount}  (events anchored: ${book.seqEnd}, next seqStart: ${book.seqEnd})`);
  console.log(`  latest root: ${book.latestRoot}`);
  console.log(`  inventory:   home=${fmtMicro(home)} draw=${fmtMicro(draw)} away=${fmtMicro(away)} (stake units)`);
  console.log(`  mtm pnl:     ${fmtMicro(book.mtmPnlMicro)}`);
  if (book.status === 'settled') {
    console.log(`  PROVEN FINAL SCORE: P1 ${book.provenGoals[0]} — ${book.provenGoals[1]} P2`);
    console.log(`  winner:      ${book.winner ?? '(unset)'}`);
  }
}

const fixtureId = process.argv[2];
if (fixtureId) {
  const book = await client.fetchBook(fixtureId);
  if (!book) {
    console.error(`no on-chain book for fixture ${fixtureId} under program ${client.programId.toBase58()}`);
    process.exit(1);
  }
  printBook(book, client.bookAddress(fixtureId).toBase58());
} else {
  const books = await client.fetchAllBooks();
  console.log(`program ${client.programId.toBase58()} — ${books.length} book(s)`);
  console.log(`  ${explorerAddress(client.programId.toBase58())}`);
  for (const book of books) {
    console.log('');
    printBook(book, book.address);
  }
}
