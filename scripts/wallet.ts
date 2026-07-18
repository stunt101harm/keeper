/**
 * Devnet wallet bootstrap: prints the public key + balance for the configured
 * SOLANA_SECRET_KEY and requests an airdrop when the balance is low.
 *
 *   npm run -s wallet   (or: tsx scripts/wallet.ts)
 */
import 'dotenv/config';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

const secret = process.env.SOLANA_SECRET_KEY;
if (!secret) {
  console.error('SOLANA_SECRET_KEY not set');
  process.exit(1);
}

const keypair = Keypair.fromSecretKey(bs58.decode(secret));
const rpc = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const conn = new Connection(rpc, 'confirmed');

const pubkey = keypair.publicKey.toBase58();
const balance = await conn.getBalance(keypair.publicKey);
console.log(`pubkey:  ${pubkey}`);
console.log(`rpc:     ${rpc}`);
console.log(`balance: ${balance / LAMPORTS_PER_SOL} SOL`);

if (balance < 0.5 * LAMPORTS_PER_SOL) {
  console.log('balance low — requesting 1 SOL airdrop...');
  try {
    const sig = await conn.requestAirdrop(keypair.publicKey, 1 * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, 'confirmed');
    const after = await conn.getBalance(keypair.publicKey);
    console.log(`airdrop confirmed: ${sig}`);
    console.log(`balance: ${after / LAMPORTS_PER_SOL} SOL`);
  } catch (err) {
    console.error('airdrop failed (devnet faucet is often rate-limited):', (err as Error).message);
    process.exit(2);
  }
}
