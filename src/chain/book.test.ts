import fs from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  BOOK_STATE_SIZE,
  KEEPER_BOOK_PROGRAM_ID,
  accountDiscriminator,
  bookPda,
  decodeBookState,
  decodeEpochRecordedFromLogs,
  encodeInitBookData,
  encodeRecordEpochData,
  encodeSettleBookData,
  encodeStatValidationInput,
  eventDiscriminator,
  ixDiscriminator,
} from './book.js';
import type { StatValidationProof } from './txproof.js';

/**
 * The generated Anchor IDL (committed at program/idl/keeper_book.json) is the
 * source of truth for every discriminator and layout this client hand-rolls.
 * These tests pin the two sides together: if the program changes shape, the
 * IDL changes, and this suite fails before any devnet transaction can.
 */
const idl = JSON.parse(fs.readFileSync('program/idl/keeper_book.json', 'utf8')) as {
  address: string;
  instructions: { name: string; discriminator: number[]; args: unknown[] }[];
  accounts: { name: string; discriminator: number[] }[];
  events: { name: string; discriminator: number[] }[];
  types: { name: string; type: { kind: string; fields: { name: string; type: unknown }[] } }[];
};

const realProof = JSON.parse(
  fs.readFileSync('fixtures/proof_18241006_seq962_k1-2.json', 'utf8'),
) as StatValidationProof;

describe('discriminators vs generated IDL', () => {
  it('derives every instruction discriminator', () => {
    for (const ix of idl.instructions) {
      expect([...ixDiscriminator(ix.name)], ix.name).toEqual(ix.discriminator);
    }
    expect(idl.instructions.map((i) => i.name).sort()).toEqual([
      'init_book',
      'record_epoch',
      'settle_book',
    ]);
  });

  it('derives the BookState account discriminator', () => {
    const acc = idl.accounts.find((a) => a.name === 'BookState')!;
    expect([...accountDiscriminator('BookState')]).toEqual(acc.discriminator);
  });

  it('derives both event discriminators', () => {
    for (const ev of idl.events) {
      expect([...eventDiscriminator(ev.name)], ev.name).toEqual(ev.discriminator);
    }
    expect(idl.events.map((e) => e.name).sort()).toEqual(['BookSettled', 'EpochRecorded']);
  });

  it('deployed program id matches the client constant', () => {
    expect(idl.address).toBe(KEEPER_BOOK_PROGRAM_ID);
  });
});

describe('BookState layout', () => {
  it('BOOK_STATE_SIZE matches the IDL field-by-field', () => {
    const sizeOf = (t: unknown): number => {
      if (t === 'pubkey') return 32;
      if (t === 'i64' || t === 'u64') return 8;
      if (t === 'u32' || t === 'i32') return 4;
      if (t === 'u16') return 2;
      if (t === 'u8' || t === 'bool') return 1;
      const arr = (t as { array?: [string, number] }).array;
      if (arr) return sizeOf(arr[0]) * arr[1];
      throw new Error(`unknown IDL type ${JSON.stringify(t)}`);
    };
    const book = idl.types.find((t) => t.name === 'BookState')!;
    const size = 8 + book.type.fields.reduce((acc, f) => acc + sizeOf(f.type), 0);
    expect(size).toBe(BOOK_STATE_SIZE);
  });
});

describe('instruction encoding', () => {
  it('init_book encodes disc + i64 + u16 + bool', () => {
    const data = encodeInitBookData(18241006n, 20649, true);
    expect(data.length).toBe(8 + 8 + 2 + 1);
    expect([...data.subarray(0, 8)]).toEqual(
      idl.instructions.find((i) => i.name === 'init_book')!.discriminator,
    );
    expect(data.readBigInt64LE(8)).toBe(18241006n);
    expect(data.readUInt16LE(16)).toBe(20649);
    expect(data.readUInt8(18)).toBe(1);
  });

  it('record_epoch encodes the epoch args and rounds micros', () => {
    const root = Buffer.alloc(32, 7);
    const data = encodeRecordEpochData({
      root,
      seqStart: 5,
      seqEndExclusive: 42,
      inventoryMicro: [1_000_000.4, -2_500_000, 0],
      mtmPnlMicro: 123_456,
    });
    expect(data.length).toBe(8 + 32 + 8 + 8 + 24 + 8);
    let o = 8;
    expect(data.subarray(o, o + 32).equals(root)).toBe(true);
    o += 32;
    expect(data.readBigUInt64LE(o)).toBe(5n);
    o += 8;
    expect(data.readBigUInt64LE(o)).toBe(42n);
    o += 8;
    expect(data.readBigInt64LE(o)).toBe(1_000_000n); // rounded
    expect(data.readBigInt64LE(o + 8)).toBe(-2_500_000n);
    expect(data.readBigInt64LE(o + 16)).toBe(0n);
    expect(data.readBigInt64LE(o + 24)).toBe(123_456n);
  });

  it('rejects a root that is not 32 bytes', () => {
    expect(() =>
      encodeRecordEpochData({
        root: Buffer.alloc(31),
        seqStart: 0,
        seqEndExclusive: 1,
        inventoryMicro: [0, 0, 0],
        mtmPnlMicro: 0,
      }),
    ).toThrow(/32 bytes/);
  });
});

describe('StatValidationInput encoding (real devnet proof)', () => {
  /** Minimal borsh reader used to round-trip what the encoder wrote. */
  class Reader {
    o = 0;
    constructor(readonly buf: Buffer) {}
    u8(): number {
      return this.buf.readUInt8(this.o++);
    }
    u32(): number {
      const v = this.buf.readUInt32LE(this.o);
      this.o += 4;
      return v;
    }
    i32(): number {
      const v = this.buf.readInt32LE(this.o);
      this.o += 4;
      return v;
    }
    i64(): bigint {
      const v = this.buf.readBigInt64LE(this.o);
      this.o += 8;
      return v;
    }
    bytes(n: number): number[] {
      const v = [...this.buf.subarray(this.o, this.o + n)];
      this.o += n;
      return v;
    }
    proofVec(): { hash: number[]; isRightSibling: boolean }[] {
      const n = this.u32();
      return Array.from({ length: n }, () => ({
        hash: this.bytes(32),
        isRightSibling: this.u8() === 1,
      }));
    }
  }

  it('round-trips the retained 18241006 seq-962 proof byte-exactly', () => {
    const buf = encodeStatValidationInput(realProof);
    const r = new Reader(buf);

    expect(r.i64()).toBe(BigInt(realProof.summary.updateStats.minTimestamp)); // ts
    expect(r.i64()).toBe(BigInt(realProof.summary.fixtureId));
    expect(r.i32()).toBe(realProof.summary.updateStats.updateCount);
    expect(r.i64()).toBe(BigInt(realProof.summary.updateStats.minTimestamp));
    expect(r.i64()).toBe(BigInt(realProof.summary.updateStats.maxTimestamp));
    expect(r.bytes(32)).toEqual(realProof.summary.eventStatsSubTreeRoot);
    expect(r.proofVec()).toEqual(realProof.subTreeProof); // fixture_proof
    expect(r.proofVec()).toEqual(realProof.mainTreeProof);
    expect(r.bytes(32)).toEqual(realProof.eventStatRoot);
    const statCount = r.u32();
    expect(statCount).toBe(realProof.statsToProve.length);
    for (let i = 0; i < statCount; i++) {
      const stat = realProof.statsToProve[i]!;
      expect(r.u32()).toBe(stat.key);
      expect(r.i32()).toBe(stat.value);
      expect(r.i32()).toBe(stat.period);
      expect(r.proofVec()).toEqual(realProof.statProofs[i]);
    }
    expect(r.o).toBe(buf.length); // nothing left over
  });

  it('the retained proof is the final England–Argentina score', () => {
    expect(realProof.summary.fixtureId).toBe(18241006);
    expect(realProof.statsToProve.map((s) => s.key)).toEqual([1, 2]);
    expect(realProof.statsToProve.map((s) => s.value)).toEqual([1, 2]);
    expect(realProof.statsToProve.every((s) => s.period === 100)).toBe(true);
  });

  it('settle_book data = disc + epoch_day + payload', () => {
    const payload = encodeStatValidationInput(realProof);
    const data = encodeSettleBookData(20649, realProof);
    expect(data.length).toBe(8 + 2 + payload.length);
    expect([...data.subarray(0, 8)]).toEqual(
      idl.instructions.find((i) => i.name === 'settle_book')!.discriminator,
    );
    expect(data.readUInt16LE(8)).toBe(20649);
    expect(data.subarray(10).equals(payload)).toBe(true);
  });
});

describe('EpochRecorded event decoding', () => {
  // Captured verbatim from a devnet simulation of the deployed program
  // (record_epoch with root=0x07*32, range [0,5), inventory
  // [1_000_000, -2_500_000, 0] micro, mtm 123_456 micro).
  const CAPTURED_LOG =
    'Program data: NHieXA7BpVcqAAAAAAAAAAEAAAAHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwAAAAAAAAAABQAAAAAAAABAQg8AAAAAAGDa2f//////AAAAAAAAAABA4gEAAAAAAA==';

  it('decodes the captured devnet event', () => {
    const events = decodeEpochRecordedFromLogs([
      'Program log: Instruction: RecordEpoch',
      CAPTURED_LOG,
      'Program X consumed 4301 of 392390 compute units',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      fixtureId: '42',
      epochCount: 1,
      rootHex: '07'.repeat(32),
      seqStart: 0,
      seqEnd: 5,
      inventoryMicro: [1_000_000, -2_500_000, 0],
      mtmPnlMicro: 123_456,
    });
  });

  it('ignores non-event and foreign Program data lines', () => {
    const bookSettled = Buffer.concat([
      eventDiscriminator('BookSettled'),
      Buffer.alloc(80),
    ]).toString('base64');
    expect(
      decodeEpochRecordedFromLogs([
        'Program log: hello',
        `Program data: ${bookSettled}`,
        'Program data: AAAA',
      ]),
    ).toHaveLength(0);
  });
});

describe('book account (captured from devnet after the E2E settle)', () => {
  const fixture = JSON.parse(fs.readFileSync('fixtures/book-18241006-devnet.json', 'utf8')) as {
    address: string;
    programId: string;
    dataBase64: string;
  };

  it('PDA derivation reproduces the on-chain address', () => {
    const [pda] = bookPda(new PublicKey(fixture.programId), 18241006n);
    expect(pda.toBase58()).toBe(fixture.address);
  });

  it('decodes the settled England–Argentina book', () => {
    const book = decodeBookState(Buffer.from(fixture.dataBase64, 'base64'));
    expect(book.fixtureId).toBe('18241006');
    expect(book.epochDay).toBe(20649);
    expect(book.p1IsHome).toBe(true);
    expect(book.status).toBe('settled');
    expect(book.provenGoals).toEqual([1, 2]); // England 1 — 2 Argentina
    expect(book.winner).toBe('p2');
    expect(book.epochCount).toBeGreaterThan(0);
    expect(book.seqEnd).toBeGreaterThan(0);
    expect(book.latestRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(book.latestRoot).not.toBe('00'.repeat(32));
  });

  it('rejects a buffer with the wrong discriminator', () => {
    const data = Buffer.from(fixture.dataBase64, 'base64');
    const tampered = Buffer.from(data);
    tampered[0] = tampered[0]! ^ 0xff;
    expect(() => decodeBookState(tampered)).toThrow(/discriminator/);
  });
});
