import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHex } from './merkle.js';
import {
  batchSlotOf,
  epochDayOf,
  verifyStatProof,
  type StatValidationProof,
} from './txproof.js';

const loadFixture = (name: string): StatValidationProof =>
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'fixtures', name), 'utf8'),
  ) as StatValidationProof;

// Real proof captured from TxLINE devnet: England v Argentina semifinal
// (fixture 18241006), seq 962 = game_finalised, statKeys 1,2 (goals 1-2).
const FIXTURE = 'proof_18241006_seq962_k1-2.json';

describe('verifyStatProof (offline legs, real devnet proof)', () => {
  it('verifies the committed real proof', async () => {
    const proof = loadFixture(FIXTURE);
    const result = await verifyStatProof(proof);
    expect(result.ok).toBe(true);
    expect(result.statLegs).toHaveLength(2);
    expect(result.statLegs.every((l) => l.ok && !l.aggregated)).toBe(true);
    expect(result.computedEventStatRoot).toBe(toHex(proof.eventStatRoot));
    expect(result.subTreeOk).toBe(true);
    expect(result.computedSubTreeRoot).toBe(toHex(proof.summary.eventStatsSubTreeRoot));
    // Pinned: the batch root recomputed offline equals the real devnet
    // daily_scores_roots PDA slot-254 root for epochDay 20649 (verified live).
    expect(result.computedBatchRoot).toBe(
      '3b2f1bda10d00b28ca1df2083bc9abc05d4e9f9b74d1911924c2d011605d83c9',
    );
    expect(result.epochDay).toBe(20649);
    expect(result.slot).toBe(254);
    // no fetcher supplied -> no on-chain claim
    expect(result.onChainMatch).toBeUndefined();
  });

  it('matches the pinned on-chain batch root via an injected fetcher', async () => {
    const proof = loadFixture(FIXTURE);
    const onChainRoot = Buffer.from(
      '3b2f1bda10d00b28ca1df2083bc9abc05d4e9f9b74d1911924c2d011605d83c9',
      'hex',
    );
    const result = await verifyStatProof(proof, {
      fetchOnChainRoot: async () => onChainRoot,
    });
    expect(result.onChainMatch).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('also verifies the mid-match (halftime, period 3) proof', async () => {
    const proof = loadFixture('proof_18241006_seq425_halftime_k1-2.json');
    const result = await verifyStatProof(proof);
    expect(result.ok).toBe(true);
  });

  it('fails when a stat proof hash byte is flipped', async () => {
    const proof = loadFixture(FIXTURE);
    proof.statProofs[0]![0]!.hash[0]! ^= 0xff;
    const result = await verifyStatProof(proof);
    expect(result.ok).toBe(false);
    expect(result.statLegs[0]!.ok).toBe(false);
    expect(result.statLegs[1]!.ok).toBe(true); // the other leg is untouched
  });

  it('fails when a stat value is tampered', async () => {
    const proof = loadFixture(FIXTURE);
    proof.statsToProve[0]!.value += 1; // England did not score 2
    const result = await verifyStatProof(proof);
    expect(result.ok).toBe(false);
  });

  it('propagates tampering of the summary into the batch root', async () => {
    const good = await verifyStatProof(loadFixture(FIXTURE));
    const proof = loadFixture(FIXTURE);
    proof.summary.updateStats.maxTimestamp += 1;
    const bad = await verifyStatProof(proof);
    expect(bad.computedBatchRoot).not.toBe(good.computedBatchRoot);
  });

  it('reports on-chain match via the injected fetcher', async () => {
    const proof = loadFixture(FIXTURE);
    const offline = await verifyStatProof(proof);
    const result = await verifyStatProof(proof, {
      fetchOnChainRoot: async (epochDay, slot) => {
        expect(epochDay).toBe(epochDayOf(proof));
        expect(slot).toBe(batchSlotOf(proof));
        return Buffer.from(offline.computedBatchRoot, 'hex');
      },
    });
    expect(result.onChainMatch).toBe(true);
    expect(result.ok).toBe(true);

    const mismatch = await verifyStatProof(proof, {
      fetchOnChainRoot: async () => Buffer.alloc(32),
    });
    expect(mismatch.onChainMatch).toBe(false);
    expect(mismatch.ok).toBe(false);
  });

  it('derives epochDay and slot from minTimestamp', () => {
    const proof = loadFixture(FIXTURE);
    const ts = proof.summary.updateStats.minTimestamp;
    expect(epochDayOf(proof)).toBe(Math.floor(ts / 86400000));
    expect(batchSlotOf(proof)).toBe(Math.floor((ts % 86400000) / 300000));
  });
});
