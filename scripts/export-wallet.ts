/**
 * Writes SOLANA_SECRET_KEY as a JSON keypair array (solana-cli / Anchor format)
 * for interop with tooling that wants ANCHOR_WALLET files.
 *
 *   tsx scripts/export-wallet.ts /path/to/out.json
 */
import 'dotenv/config';
import bs58 from 'bs58';
import { writeFileSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: tsx scripts/export-wallet.ts <outfile.json>');
  process.exit(1);
}
const secret = process.env.SOLANA_SECRET_KEY;
if (!secret) {
  console.error('SOLANA_SECRET_KEY not set');
  process.exit(1);
}
writeFileSync(out, JSON.stringify(Array.from(bs58.decode(secret))), { mode: 0o600 });
console.log(`wrote keypair to ${out}`);
