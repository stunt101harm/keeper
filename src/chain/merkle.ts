import { createHash } from 'node:crypto';

/**
 * Canonical JSON + binary sha256 merkle tree used by the anchorer and the
 * verify-anchors script. Determinism is the whole point: the same
 * {seq, event} record must hash identically at anchor time and at audit time.
 */

/** JSON.stringify with recursively sorted object keys. Arrays keep order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

export function sha256(data: Uint8Array | string): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Leaf hash for one blotter record. */
export function leafHash(record: { seq: number; event: unknown }): Buffer {
  return sha256(canonicalJson({ seq: record.seq, event: record.event }));
}

/**
 * Binary merkle root: pair-wise sha256(left || right); when a level has an odd
 * node count, the last node is duplicated. Throws on zero leaves.
 */
export function merkleRoot(leaves: Buffer[]): Buffer {
  if (leaves.length === 0) throw new Error('merkleRoot: no leaves');
  let level = leaves;
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = level[i + 1] ?? left; // duplicate last node when odd
      next.push(sha256(Buffer.concat([left, right])));
    }
    level = next;
  }
  return level[0]!;
}

export function toHex(bytes: ArrayLike<number>): string {
  return Buffer.from(Array.from(bytes)).toString('hex');
}
