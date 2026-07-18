import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { Config } from '../config.js';
import { TXLINE_PROGRAM_ID, type StatValidationProof } from './txproof.js';

/**
 * book.ts — hand-rolled TypeScript client for the keeper_book Anchor program
 * (program/programs/keeper_book, deployed on devnet).
 *
 * Deliberately NOT built on @coral-xyz/anchor: the three instruction
 * encodings and one account decode are small, we control both sides, and a
 * dependency-light runtime matters for the container image. Every
 * discriminator is derived with Anchor's exact rule
 * (sha256("global:<name>")[0..8] etc.) and the derivations are pinned against
 * the generated IDL (program/idl/keeper_book.json) in book.test.ts — drift
 * between this file and the on-chain program fails CI, not settlement.
 *
 * Seq-range convention: the BLOTTER uses inclusive ranges (AnchorBatch
 * seqStart..seqEnd), the CHAIN stores the exclusive bound (`seq_end` == next
 * expected seq) so the continuity gate is one equality with no first-epoch
 * special case. `recordEpoch` takes the exclusive bound; callers convert with
 * `batch.seqEnd + 1`.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const KEEPER_BOOK_PROGRAM_ID = 'BhstTkGhG1LLPYBt3E3n4PTZ3v1V6ukNHYvQ88rgvTHS';
export const BOOK_SEED = 'book';
export const BOOK_STATE_SIZE = 138; // 8 disc + 32+8+2+1+4+32+8+24+8+1+8+1+1
/** Spike-verified CPI cost of validate_stat_v2 is ~200k CU; 300k is safe. */
export const SETTLE_COMPUTE_UNITS = 300_000;

const sha256 = (data: string | Uint8Array): Buffer => createHash('sha256').update(data).digest();

/** Anchor discriminator rules. Verified against the generated IDL in tests. */
export const ixDiscriminator = (name: string): Buffer => sha256(`global:${name}`).subarray(0, 8);
export const accountDiscriminator = (name: string): Buffer =>
  sha256(`account:${name}`).subarray(0, 8);
export const eventDiscriminator = (name: string): Buffer => sha256(`event:${name}`).subarray(0, 8);

export const explorerTx = (sig: string): string =>
  `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
export const explorerAddress = (addr: string): string =>
  `https://explorer.solana.com/address/${addr}?cluster=devnet`;

// ---------------------------------------------------------------------------
// Borsh writer (little-endian, Anchor-compatible)
// ---------------------------------------------------------------------------

class BorshWriter {
  private chunks: Buffer[] = [];

  u8(v: number): this {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    return this.push(b);
  }
  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }
  u16(v: number): this {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    return this.push(b);
  }
  u32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v >>> 0);
    return this.push(b);
  }
  i32(v: number): this {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    return this.push(b);
  }
  u64(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(v));
    return this.push(b);
  }
  i64(v: bigint | number): this {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt(v));
    return this.push(b);
  }
  bytes(v: Uint8Array | number[]): this {
    return this.push(Buffer.from(v as Uint8Array));
  }
  push(b: Buffer): this {
    this.chunks.push(b);
    return this;
  }
  build(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

const i64le = (v: bigint | number): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};

// ---------------------------------------------------------------------------
// PDA
// ---------------------------------------------------------------------------

export function bookPda(programId: PublicKey, fixtureId: bigint | number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from(BOOK_SEED), i64le(fixtureId)], programId);
}

// ---------------------------------------------------------------------------
// Instruction encoders (arg order pinned by program/idl/keeper_book.json)
// ---------------------------------------------------------------------------

export function encodeInitBookData(
  fixtureId: bigint | number,
  epochDay: number,
  p1IsHome: boolean,
): Buffer {
  return new BorshWriter()
    .push(ixDiscriminator('init_book'))
    .i64(fixtureId)
    .u16(epochDay)
    .bool(p1IsHome)
    .build();
}

export interface EpochArgs {
  /** 32-byte merkle root. */
  root: Uint8Array;
  /** Inclusive start of the blotter seq range. */
  seqStart: number;
  /** EXCLUSIVE end (= blotter batch seqEnd + 1). */
  seqEndExclusive: number;
  /** Signed inventory [home, draw, away], stake units ×1e6. */
  inventoryMicro: [number, number, number];
  /** Mark-to-market P&L, stake units ×1e6. */
  mtmPnlMicro: number;
}

export function encodeRecordEpochData(args: EpochArgs): Buffer {
  if (args.root.length !== 32) throw new Error('record_epoch root must be 32 bytes');
  const w = new BorshWriter()
    .push(ixDiscriminator('record_epoch'))
    .bytes(args.root)
    .u64(args.seqStart)
    .u64(args.seqEndExclusive);
  for (const inv of args.inventoryMicro) w.i64(Math.round(inv));
  return w.i64(Math.round(args.mtmPnlMicro)).build();
}

/**
 * Borsh-encode a StatValidationInput exactly as the on-chain mirror declares
 * it, from the JSON the TxLINE stat-validation endpoint returns. Field
 * mapping follows the spike-verified reference implementation (corner-case):
 * `ts` = summary.updateStats.minTimestamp, `fixture_proof` = subTreeProof.
 */
export function encodeStatValidationInput(proof: StatValidationProof): Buffer {
  const w = new BorshWriter();
  w.i64(proof.summary.updateStats.minTimestamp);
  // fixture_summary: ScoresBatchSummary
  w.i64(proof.summary.fixtureId);
  w.i32(proof.summary.updateStats.updateCount);
  w.i64(proof.summary.updateStats.minTimestamp);
  w.i64(proof.summary.updateStats.maxTimestamp);
  w.bytes(proof.summary.eventStatsSubTreeRoot);
  // fixture_proof / main_tree_proof: Vec<ProofNode>
  const writeProof = (nodes: { hash: number[]; isRightSibling: boolean }[]): void => {
    w.u32(nodes.length);
    for (const node of nodes) {
      if (node.hash.length !== 32) throw new Error('proof node hash must be 32 bytes');
      w.bytes(node.hash).bool(node.isRightSibling);
    }
  };
  writeProof(proof.subTreeProof);
  writeProof(proof.mainTreeProof);
  w.bytes(proof.eventStatRoot);
  // stats: Vec<StatLeaf>
  w.u32(proof.statsToProve.length);
  proof.statsToProve.forEach((stat, i) => {
    w.u32(stat.key).i32(stat.value).i32(stat.period);
    writeProof(proof.statProofs[i] ?? []);
  });
  return w.build();
}

export function encodeSettleBookData(epochDay: number, proof: StatValidationProof): Buffer {
  return new BorshWriter()
    .push(ixDiscriminator('settle_book'))
    .u16(epochDay)
    .push(encodeStatValidationInput(proof))
    .build();
}

// ---------------------------------------------------------------------------
// Account decoding
// ---------------------------------------------------------------------------

export type BookWinner = 'p1' | 'draw' | 'p2';
export const WINNERS: Record<number, BookWinner> = { 0: 'p1', 1: 'draw', 2: 'p2' };

export interface OnchainBook {
  authority: string;
  fixtureId: string;
  epochDay: number;
  p1IsHome: boolean;
  epochCount: number;
  /** Hex merkle root of the latest anchored batch. */
  latestRoot: string;
  /** EXCLUSIVE end of the anchored seq range == total events anchored. */
  seqEnd: number;
  inventoryMicro: [number, number, number];
  mtmPnlMicro: number;
  status: 'open' | 'settled';
  /** Proven final [P1 goals, P2 goals]; only meaningful once settled. */
  provenGoals: [number, number];
  /** Undefined until settled (on-chain sentinel 255). */
  winner?: BookWinner;
  bump: number;
}

export function decodeBookState(data: Buffer): OnchainBook {
  if (data.length < BOOK_STATE_SIZE) {
    throw new Error(`BookState account too short: ${data.length} < ${BOOK_STATE_SIZE}`);
  }
  const disc = accountDiscriminator('BookState');
  if (!data.subarray(0, 8).equals(disc)) {
    throw new Error('not a BookState account (discriminator mismatch)');
  }
  let o = 8;
  const authority = new PublicKey(data.subarray(o, o + 32)).toBase58();
  o += 32;
  const fixtureId = data.readBigInt64LE(o).toString();
  o += 8;
  const epochDay = data.readUInt16LE(o);
  o += 2;
  const p1IsHome = data.readUInt8(o) === 1;
  o += 1;
  const epochCount = data.readUInt32LE(o);
  o += 4;
  const latestRoot = data.subarray(o, o + 32).toString('hex');
  o += 32;
  const seqEnd = Number(data.readBigUInt64LE(o));
  o += 8;
  const inventoryMicro: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    inventoryMicro[i] = Number(data.readBigInt64LE(o));
    o += 8;
  }
  const mtmPnlMicro = Number(data.readBigInt64LE(o));
  o += 8;
  const status = data.readUInt8(o) === 1 ? 'settled' : 'open';
  o += 1;
  const provenGoals: [number, number] = [data.readInt32LE(o), data.readInt32LE(o + 4)];
  o += 8;
  const winnerByte = data.readUInt8(o);
  o += 1;
  const bump = data.readUInt8(o);
  const winner = WINNERS[winnerByte];
  return {
    authority,
    fixtureId,
    epochDay,
    p1IsHome,
    epochCount,
    latestRoot,
    seqEnd,
    inventoryMicro,
    mtmPnlMicro,
    status,
    provenGoals,
    ...(winner !== undefined ? { winner } : {}),
    bump,
  };
}

// ---------------------------------------------------------------------------
// EpochRecorded event decoding (used by scripts/verify-anchors.ts)
// ---------------------------------------------------------------------------

export interface EpochRecordedEvent {
  fixtureId: string;
  epochCount: number;
  rootHex: string;
  seqStart: number;
  /** Exclusive, as stored on-chain. */
  seqEnd: number;
  inventoryMicro: [number, number, number];
  mtmPnlMicro: number;
}

/**
 * Extract EpochRecorded events from a transaction's log messages. Anchor
 * emits events as `Program data: <base64>` lines whose payload is the 8-byte
 * event discriminator followed by the borsh-encoded fields.
 */
export function decodeEpochRecordedFromLogs(logs: readonly string[]): EpochRecordedEvent[] {
  const disc = eventDiscriminator('EpochRecorded');
  const events: EpochRecordedEvent[] = [];
  for (const line of logs) {
    const m = /^Program data: (.+)$/.exec(line);
    if (!m?.[1]) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(m[1], 'base64');
    } catch {
      continue;
    }
    // fixture_id i64 | epoch_count u32 | root [32] | seq_start u64 |
    // seq_end u64 | inventory_micro [i64;3] | mtm_pnl_micro i64
    if (buf.length < 8 + 8 + 4 + 32 + 8 + 8 + 24 + 8) continue;
    if (!buf.subarray(0, 8).equals(disc)) continue;
    let o = 8;
    const fixtureId = buf.readBigInt64LE(o).toString();
    o += 8;
    const epochCount = buf.readUInt32LE(o);
    o += 4;
    const rootHex = buf.subarray(o, o + 32).toString('hex');
    o += 32;
    const seqStart = Number(buf.readBigUInt64LE(o));
    o += 8;
    const seqEnd = Number(buf.readBigUInt64LE(o));
    o += 8;
    const inventoryMicro: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      inventoryMicro[i] = Number(buf.readBigInt64LE(o));
      o += 8;
    }
    const mtmPnlMicro = Number(buf.readBigInt64LE(o));
    events.push({ fixtureId, epochCount, rootHex, seqStart, seqEnd, inventoryMicro, mtmPnlMicro });
  }
  return events;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface BookClientOpts {
  rpcUrl: string;
  programId: string;
  /** Base58 secret key. Optional: a read-only client can still fetch books. */
  secretKey?: string;
}

export class BookClient {
  readonly connection: Connection;
  readonly programId: PublicKey;
  private readonly keypair?: Keypair;

  constructor(opts: BookClientOpts) {
    this.connection = new Connection(opts.rpcUrl, 'confirmed');
    this.programId = new PublicKey(opts.programId);
    if (opts.secretKey) this.keypair = Keypair.fromSecretKey(bs58.decode(opts.secretKey));
  }

  /** Null when the config has no program id (memo-only deployments). */
  static fromConfig(config: Config): BookClient | null {
    if (!config.solana.programId) return null;
    return new BookClient({
      rpcUrl: config.solana.rpcUrl,
      programId: config.solana.programId,
      ...(config.solana.secretKey ? { secretKey: config.solana.secretKey } : {}),
    });
  }

  private get signer(): Keypair {
    if (!this.keypair) throw new Error('BookClient: no secret key configured for signing');
    return this.keypair;
  }

  bookAddress(fixtureId: bigint | number | string): PublicKey {
    return bookPda(this.programId, BigInt(fixtureId))[0];
  }

  async fetchBook(fixtureId: bigint | number | string): Promise<OnchainBook | null> {
    const info = await this.connection.getAccountInfo(this.bookAddress(fixtureId));
    if (!info) return null;
    return decodeBookState(info.data);
  }

  /** All books owned by this program (discriminator + size filtered). */
  async fetchAllBooks(): Promise<Array<OnchainBook & { address: string }>> {
    const accounts = await this.connection.getProgramAccounts(this.programId, {
      filters: [
        { dataSize: BOOK_STATE_SIZE },
        { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator('BookState')) } },
      ],
    });
    return accounts.map(({ pubkey, account }) => ({
      ...decodeBookState(account.data),
      address: pubkey.toBase58(),
    }));
  }

  /**
   * Send + confirm with a self-owned polling loop instead of
   * sendAndConfirmTransaction: web3.js's confirm machinery spawns detached
   * retry callbacks that can throw OUTSIDE the caller's try/catch when an
   * RPC rate-limits (observed: api.devnet.solana.com 429s killing the whole
   * process). Here every await is inside the caller's catch, so an RPC
   * failure is always a caught, retryable error — the anchorer's resilience
   * contract depends on that.
   */
  private async send(ixs: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = this.signer.publicKey;
    tx.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(this.signer);
    const sig = await this.connection.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const deadline = Date.now() + 60_000;
    for (;;) {
      const status = (await this.connection.getSignatureStatuses([sig])).value[0];
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        if (status.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(status.err)}`);
        return sig;
      }
      if (Date.now() > deadline) throw new Error(`tx ${sig} not confirmed within 60s`);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  }

  async initBook(
    fixtureId: bigint | number | string,
    epochDay: number,
    p1IsHome: boolean,
  ): Promise<string> {
    const fid = BigInt(fixtureId);
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: this.bookAddress(fid), isSigner: false, isWritable: true },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      ],
      data: encodeInitBookData(fid, epochDay, p1IsHome),
    });
    return this.send([ix]);
  }

  /** init_book exactly once per fixture; safe to call repeatedly. */
  async ensureBook(
    fixtureId: bigint | number | string,
    epochDay: number,
    p1IsHome: boolean,
  ): Promise<{ address: string; created: boolean; sig?: string }> {
    const address = this.bookAddress(fixtureId).toBase58();
    const existing = await this.fetchBook(fixtureId);
    if (existing) return { address, created: false };
    try {
      const sig = await this.initBook(fixtureId, epochDay, p1IsHome);
      return { address, created: true, sig };
    } catch (err) {
      // Lost a race with another init (or a previous timed-out send landed):
      // the book existing is the goal, not our tx winning.
      if (await this.fetchBook(fixtureId)) return { address, created: false };
      throw err;
    }
  }

  async recordEpoch(fixtureId: bigint | number | string, args: EpochArgs): Promise<string> {
    const ix = new TransactionInstruction({
      programId: this.programId,
      keys: [
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: false },
        { pubkey: this.bookAddress(fixtureId), isSigner: false, isWritable: true },
      ],
      data: encodeRecordEpochData(args),
    });
    return this.send([ix]);
  }

  /**
   * Build the settle_book instruction list (compute budget + settle).
   * Permissionless: any funded signer works, not just the book authority.
   */
  settleInstructions(
    fixtureId: bigint | number | string,
    epochDay: number,
    proof: StatValidationProof,
    caller: PublicKey,
  ): TransactionInstruction[] {
    const rootsSeed = Buffer.alloc(2);
    rootsSeed.writeUInt16LE(epochDay);
    const [txlineRoots] = PublicKey.findProgramAddressSync(
      [Buffer.from('daily_scores_roots'), rootsSeed],
      TXLINE_PROGRAM_ID,
    );
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: SETTLE_COMPUTE_UNITS }),
      new TransactionInstruction({
        programId: this.programId,
        keys: [
          { pubkey: caller, isSigner: true, isWritable: true },
          { pubkey: this.bookAddress(fixtureId), isSigner: false, isWritable: true },
          { pubkey: txlineRoots, isSigner: false, isWritable: false },
          { pubkey: TXLINE_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: encodeSettleBookData(epochDay, proof),
      }),
    ];
  }

  async settleBook(
    fixtureId: bigint | number | string,
    epochDay: number,
    proof: StatValidationProof,
    opts: { simulateFirst?: boolean } = {},
  ): Promise<string> {
    const ixs = this.settleInstructions(fixtureId, epochDay, proof, this.signer.publicKey);
    if (opts.simulateFirst) {
      // While TxLINE's on-chain root lags the API's proof, simulation fails
      // and nothing is spent — the caller just retries later.
      const tx = new Transaction().add(...ixs);
      tx.feePayer = this.signer.publicKey;
      tx.recentBlockhash = (await this.connection.getLatestBlockhash('confirmed')).blockhash;
      tx.sign(this.signer);
      const sim = await this.connection.simulateTransaction(tx);
      if (sim.value.err) {
        throw new Error(
          `settle_book simulation failed: ${JSON.stringify(sim.value.err)} — logs: ${(sim.value.logs ?? []).slice(-5).join(' | ')}`,
        );
      }
    }
    return this.send(ixs);
  }
}

// ---------------------------------------------------------------------------
// /api/state onchain provider (CONTRACTS-WAVE2 shape)
// ---------------------------------------------------------------------------

export interface OnchainBookView {
  address: string;
  latestRoot: string;
  seqEnd: number;
  epochCount: number;
  status: 'open' | 'settled';
  provenGoals?: [number, number];
  winner?: BookWinner;
  settleSig?: string;
  explorerUrl: string;
}

export interface OnchainState {
  programId: string;
  network: 'devnet';
  books: Record<string, OnchainBookView>;
}

export type OnchainProvider = () => Promise<OnchainState | null>;

/** settle sigs observed this process (chain state has no tx sig to read back). */
const settleSigs = new Map<string, string>();
export function registerSettleSig(fixtureId: string, sig: string): void {
  settleSigs.set(fixtureId, sig);
}

/**
 * Provider for the server's /api/state `onchain` block. Registration is
 * integration's job: `state.setOnchainProvider(makeOnchainProvider(config))`
 * (server/state hook owned by agent M). Results are cached for `ttlMs` so a
 * busy dashboard cannot turn every poll into a getProgramAccounts sweep.
 */
export function makeOnchainProvider(config: Config, ttlMs = 5_000): OnchainProvider {
  const programId = config.solana.programId;
  if (!programId || config.solana.anchorTarget !== 'program') return async () => null;
  const client = new BookClient({ rpcUrl: config.solana.rpcUrl, programId });

  let cache: { at: number; state: OnchainState } | null = null;
  let inFlight: Promise<OnchainState | null> | null = null;

  const refresh = async (): Promise<OnchainState | null> => {
    const books: Record<string, OnchainBookView> = {};
    for (const book of await client.fetchAllBooks()) {
      const settleSig = settleSigs.get(book.fixtureId);
      books[book.fixtureId] = {
        address: book.address,
        latestRoot: book.latestRoot,
        seqEnd: book.seqEnd,
        epochCount: book.epochCount,
        status: book.status,
        ...(book.status === 'settled' ? { provenGoals: book.provenGoals } : {}),
        ...(book.winner !== undefined ? { winner: book.winner } : {}),
        ...(settleSig !== undefined ? { settleSig } : {}),
        explorerUrl: explorerAddress(book.address),
      };
    }
    const state: OnchainState = { programId, network: 'devnet', books };
    cache = { at: Date.now(), state };
    return state;
  };

  return async () => {
    if (cache && Date.now() - cache.at < ttlMs) return cache.state;
    if (!inFlight) {
      inFlight = refresh()
        .catch(() => cache?.state ?? null) // RPC hiccup: serve stale, never throw
        .finally(() => {
          inFlight = null;
        });
    }
    return inFlight;
  };
}
