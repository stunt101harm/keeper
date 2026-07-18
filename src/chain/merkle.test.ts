import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, leafHash, merkleRoot, sha256 } from './merkle.js';

const h = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

describe('canonicalJson', () => {
  it('is invariant to object key order (recursively)', () => {
    const a = { b: 1, a: { z: [1, { y: 2, x: 3 }], w: 'v' }, c: null };
    const b = { c: null, a: { w: 'v', z: [1, { x: 3, y: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"w":"v","z":[1,{"x":3,"y":2}]},"b":1,"c":null}');
  });

  it('preserves array order and drops undefined-valued keys', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('distinguishes different values', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('merkleRoot', () => {
  const leaves = ['a', 'b', 'c'].map((s) => h(s));

  it('matches a hand-computed known answer (odd count duplicates last)', () => {
    // level 1: h(h(a)||h(b)), h(h(c)||h(c)) ; root = h(l0||l1)
    const l0 = h(Buffer.concat([leaves[0]!, leaves[1]!]));
    const l1 = h(Buffer.concat([leaves[2]!, leaves[2]!]));
    const expected = h(Buffer.concat([l0, l1])).toString('hex');
    expect(merkleRoot(leaves).toString('hex')).toBe(expected);
    // pinned value so the algorithm can never silently change
    expect(merkleRoot(leaves).toString('hex')).toBe(
      'd31a37ef6ac14a2db1470c4316beb5592e6afd4465022339adafda76a18ffabe',
    );
  });

  it('single leaf is its own root', () => {
    expect(merkleRoot([leaves[0]!]).equals(leaves[0]!)).toBe(true);
  });

  it('root changes when any leaf changes', () => {
    const tampered = [...leaves];
    tampered[1] = h('B');
    expect(merkleRoot(tampered).equals(merkleRoot(leaves))).toBe(false);
  });

  it('throws on zero leaves', () => {
    expect(() => merkleRoot([])).toThrow();
  });
});

describe('leafHash', () => {
  it('hashes the canonical form of {seq, event}', () => {
    const rec = { seq: 3, event: { kind: 'trade', b: 1, a: 2 } };
    const expected = sha256(canonicalJson({ seq: 3, event: { a: 2, b: 1, kind: 'trade' } }));
    expect(leafHash(rec).equals(expected)).toBe(true);
  });
});
