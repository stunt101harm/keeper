import { Connection, PublicKey } from '@solana/web3.js';
import { sha256, toHex } from './merkle.js';

/**
 * Client-side verification of TxLINE stat-validation proofs.
 *
 * Proof chain (verified against real devnet proofs — see
 * corner-case/spike NOTES + web/lib/merkle.ts, ported here):
 *
 *   1. leaf = sha256(borsh(ScoreStat{key u32 LE, value i32 LE, period i32 LE}))
 *      folded through statProofs[i] (isRightSibling picks concat order,
 *      step = sha256(left || right)) → eventStatRoot
 *   2. eventStatRoot folded through subTreeProof → summary.eventStatsSubTreeRoot
 *   3. mainLeaf = sha256(0x01 || borsh(ScoresBatchSummary{fixture_id i64 LE,
 *      update_count i32 LE, min_timestamp i64 LE, max_timestamp i64 LE,
 *      events_sub_tree_root [u8;32]})) folded through mainTreeProof → the
 *      5-minute batch root that must equal the root stored in the TxLINE devnet
 *      program's daily_scores_roots PDA. The 0x01 is a leaf-domain tag (the
 *      main tree tags leaves 0x01; internal folds carry no tag) — recovered by
 *      reversing the deployed program against real devnet roots and confirmed
 *      byte-exact for both the semifinal proof and two fixtures sharing a batch.
 *
 * PDA: seeds ['daily_scores_roots', epochDay u16 LE] on program
 * 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J; account layout = 10-byte header
 * (8-byte Anchor discriminator + u16 LE epochDay) then 288 × 32-byte roots;
 * slot = floor((minTimestamp % 86400000) / 300000).
 */

export const TXLINE_PROGRAM_ID = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
/** daily_scores_roots layout: 10-byte header, then one 32-byte root per 5-min slot. */
export const DAILY_SCORES_HEADER_LEN = 10;
/** Leaf-domain tag prepended before hashing a ScoresBatchSummary in the main tree. */
export const MAIN_TREE_LEAF_TAG = 0x01;

export interface ProofNode {
  hash: number[];
  isRightSibling: boolean;
}

export interface ScoreStat {
  key: number;
  value: number;
  period: number;
}

export interface StatValidationProof {
  ts: number;
  statsToProve: ScoreStat[];
  eventStatRoot: number[];
  summary: {
    fixtureId: number;
    updateStats: { updateCount: number; minTimestamp: number; maxTimestamp: number };
    eventStatsSubTreeRoot: number[];
  };
  statProofs: ProofNode[][];
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
}

export interface StatLegResult {
  stat: ScoreStat;
  /** Period-scoped aggregation proofs are not client-recomputable; see below. */
  aggregated: boolean;
  computedHex: string;
  ok: boolean;
}

export interface VerifyStatProofResult {
  /** All client-recomputable legs check out. */
  ok: boolean;
  computedEventStatRoot: string;
  computedSubTreeRoot: string;
  computedBatchRoot: string;
  statLegs: StatLegResult[];
  subTreeOk: boolean;
  /** Set only when an on-chain root fetcher was provided. */
  onChainMatch?: boolean;
  onChainRoot?: string;
  epochDay: number;
  slot: number;
}

/** borsh(ScoreStat) = key u32 LE | value i32 LE | period i32 LE (12 bytes). */
export function scoreStatLeafBytes(stat: ScoreStat): Buffer {
  const b = Buffer.alloc(12);
  b.writeUInt32LE(stat.key >>> 0, 0);
  b.writeInt32LE(stat.value, 4);
  b.writeInt32LE(stat.period, 8);
  return b;
}

/** borsh(ScoresBatchSummary) = i64 | i32 | i64 | i64 | [u8;32] (60 bytes). */
export function summaryBytes(summary: StatValidationProof['summary']): Buffer {
  const b = Buffer.alloc(60);
  b.writeBigInt64LE(BigInt(summary.fixtureId), 0);
  b.writeInt32LE(summary.updateStats.updateCount, 8);
  b.writeBigInt64LE(BigInt(summary.updateStats.minTimestamp), 12);
  b.writeBigInt64LE(BigInt(summary.updateStats.maxTimestamp), 20);
  Buffer.from(summary.eventStatsSubTreeRoot).copy(b, 28);
  return b;
}

/** Main-tree leaf hash for a ScoresBatchSummary: sha256(0x01 || borsh(summary)). */
export function mainTreeLeaf(summary: StatValidationProof['summary']): Buffer {
  return sha256(Buffer.concat([Buffer.from([MAIN_TREE_LEAF_TAG]), summaryBytes(summary)]));
}

/** Fold a merkle path: current goes LEFT when the sibling is the right child. */
export function foldProof(start: Buffer, proof: ProofNode[]): Buffer {
  let current = start;
  for (const node of proof) {
    const sibling = Buffer.from(node.hash);
    current = node.isRightSibling
      ? sha256(Buffer.concat([current, sibling]))
      : sha256(Buffer.concat([sibling, current]));
  }
  return current;
}

/**
 * Period-scoped stats (keys 1001+, 3001+, …) are proven via TxLINE's
 * aggregation scheme: their proof entries are structured parameter nodes
 * (heavy 0x00/0xff padding), not sha256 siblings — no client recompute is
 * possible; the guarantee for those is the on-chain validateStatV2 run.
 * A real sha256 output never has 16+ bytes of 0x00/0xff.
 */
export function isAggregationProof(proof: ProofNode[]): boolean {
  return proof.some((node) => {
    let padding = 0;
    for (const b of node.hash) if (b === 0x00 || b === 0xff) padding++;
    return padding >= 16;
  });
}

export function epochDayOf(proof: StatValidationProof): number {
  return Math.floor(proof.summary.updateStats.minTimestamp / 86400000);
}

export function batchSlotOf(proof: StatValidationProof): number {
  return Math.floor((proof.summary.updateStats.minTimestamp % 86400000) / 300000);
}

export type OnChainRootFetcher = (epochDay: number, slot: number) => Promise<Buffer | null>;

/** Default fetcher: read the daily_scores_roots PDA on devnet. */
export function makePdaRootFetcher(rpcUrl: string): OnChainRootFetcher {
  const connection = new Connection(rpcUrl, 'confirmed');
  return async (epochDay, slot) => {
    const seed = Buffer.alloc(2);
    seed.writeUInt16LE(epochDay);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('daily_scores_roots'), seed],
      TXLINE_PROGRAM_ID,
    );
    const info = await connection.getAccountInfo(pda);
    if (!info) return null;
    const offset = DAILY_SCORES_HEADER_LEN + slot * 32;
    if (info.data.length < offset + 32) return null;
    return Buffer.from(info.data.subarray(offset, offset + 32));
  };
}

export async function verifyStatProof(
  proof: StatValidationProof,
  opts: { fetchOnChainRoot?: OnChainRootFetcher } = {},
): Promise<VerifyStatProofResult> {
  const expectedEventStatRoot = Buffer.from(proof.eventStatRoot);

  // Leg 1: each stat leaf → eventStatRoot
  const statLegs: StatLegResult[] = proof.statsToProve.map((stat, i) => {
    const statProof = proof.statProofs[i] ?? [];
    if (isAggregationProof(statProof)) {
      return { stat, aggregated: true, computedHex: '', ok: true };
    }
    const computed = foldProof(sha256(scoreStatLeafBytes(stat)), statProof);
    return {
      stat,
      aggregated: false,
      computedHex: computed.toString('hex'),
      ok: computed.equals(expectedEventStatRoot),
    };
  });

  // Leg 2: eventStatRoot → summary.eventStatsSubTreeRoot
  const computedSubTree = foldProof(expectedEventStatRoot, proof.subTreeProof);
  const subTreeOk = computedSubTree.equals(Buffer.from(proof.summary.eventStatsSubTreeRoot));

  // Leg 3: sha256(0x01 || borsh(summary)) → 5-minute batch root
  const computedBatchRoot = foldProof(mainTreeLeaf(proof.summary), proof.mainTreeProof);

  const epochDay = epochDayOf(proof);
  const slot = batchSlotOf(proof);

  const firstComputedLeg = statLegs.find((l) => !l.aggregated);
  const result: VerifyStatProofResult = {
    ok: statLegs.every((l) => l.ok) && subTreeOk,
    computedEventStatRoot: firstComputedLeg?.computedHex ?? toHex(proof.eventStatRoot),
    computedSubTreeRoot: computedSubTree.toString('hex'),
    computedBatchRoot: computedBatchRoot.toString('hex'),
    statLegs,
    subTreeOk,
    epochDay,
    slot,
  };

  if (opts.fetchOnChainRoot) {
    const onChain = await opts.fetchOnChainRoot(epochDay, slot);
    result.onChainMatch = onChain !== null && onChain.equals(computedBatchRoot);
    if (onChain) result.onChainRoot = onChain.toString('hex');
    result.ok = result.ok && result.onChainMatch;
  }

  return result;
}
