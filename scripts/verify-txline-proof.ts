/**
 * verify-txline-proof — fetch a live TxLINE stat-validation proof and verify
 * it client-side, including the on-chain daily_scores_roots PDA check.
 *
 * Usage: npx tsx scripts/verify-txline-proof.ts <fixtureId> <seq> <statKeys csv>
 * e.g.:  npx tsx scripts/verify-txline-proof.ts 18241006 962 1,2
 *
 * Requires TXLINE_API_TOKEN in the environment (.env).
 */
import 'dotenv/config';
import {
  makePdaRootFetcher,
  verifyStatProof,
  type StatValidationProof,
} from '../src/chain/txproof.js';

const [fixtureId, seq, statKeys] = process.argv.slice(2);
if (!fixtureId || !seq || !statKeys) {
  console.error('usage: npx tsx scripts/verify-txline-proof.ts <fixtureId> <seq> <statKeys csv>');
  process.exit(2);
}

const base = process.env.TXLINE_BASE_URL ?? 'https://txline-dev.txodds.com';
const rpcUrl = process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com';
const apiToken = process.env.TXLINE_API_TOKEN;
if (!apiToken) {
  console.error('TXLINE_API_TOKEN not set');
  process.exit(2);
}

async function fetchProof(): Promise<StatValidationProof> {
  const jwtRes = await fetch(`${base}/auth/guest/start`, { method: 'POST' });
  if (!jwtRes.ok) throw new Error(`guest auth failed: ${jwtRes.status}`);
  const { token } = (await jwtRes.json()) as { token: string };
  const url = `${base}/api/scores/stat-validation?fixtureId=${fixtureId}&seq=${seq}&statKeys=${statKeys}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-Api-Token': apiToken as string },
  });
  if (!res.ok) throw new Error(`stat-validation ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as StatValidationProof;
}

async function main(): Promise<void> {
  console.log(`fetching proof: fixture ${fixtureId} seq ${seq} statKeys ${statKeys}`);
  const proof = await fetchProof();
  console.log(
    `stats: ${proof.statsToProve.map((s) => `${s.key}=${s.value} (period ${s.period})`).join(', ')}`,
  );

  const result = await verifyStatProof(proof, { fetchOnChainRoot: makePdaRootFetcher(rpcUrl) });

  for (const leg of result.statLegs) {
    const label = `stat ${leg.stat.key}=${leg.stat.value} -> eventStatRoot`;
    console.log(
      leg.aggregated
        ? `  ${label}: aggregation proof (on-chain-only leg)`
        : `  ${label}: ${leg.ok ? 'OK' : 'FAIL'} (${leg.computedHex})`,
    );
  }
  console.log(`  eventStatRoot -> subTreeRoot: ${result.subTreeOk ? 'OK' : 'FAIL'}`);
  console.log(`  computed 5-min batch root:    ${result.computedBatchRoot}`);
  console.log(`  on-chain PDA root:            ${result.onChainRoot ?? '(not found)'}`);
  console.log(`  epochDay ${result.epochDay}, batch slot ${result.slot}`);
  console.log(`  on-chain match: ${result.onChainMatch ? 'YES' : 'NO'}`);
  console.log(
    result.ok
      ? '\nVERDICT: PROOF VERIFIED — stats are committed to the on-chain TxLINE root.'
      : '\nVERDICT: PROOF INVALID',
  );
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
