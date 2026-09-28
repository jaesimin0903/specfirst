import { createHash } from 'node:crypto';
import { keccak256, toHex, type Hex } from 'viem';
import type { Spec } from './schema.js';

export type Bytes32 = Hex;

/**
 * Deterministic JSON: object keys sorted recursively, no whitespace.
 * Keys whose value is undefined are omitted, matching JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : sortKeys(v)));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Uint8Array): Bytes32 {
  return `0x${createHash('sha256').update(data).digest('hex')}`;
}

/** sha256 over the canonical JSON of the whole parsed spec. Comments and whitespace do not matter. */
export function specHash(spec: Spec): Bytes32 {
  return sha256Hex(canonicalJson(spec));
}

/** keccak256 over invariants (id, kind, text) and unverified only. */
export function invariantSetHash(spec: Pick<Spec, 'invariants' | 'unverified'>): Bytes32 {
  return keccak256(
    toHex(
      canonicalJson({
        invariants: spec.invariants.map(({ id, kind, text }) => ({ id, kind, text })),
        unverified: spec.unverified,
      }),
    ),
  );
}

/** keccak256 over the UTF-8 bytes of the projectId string. Used as the on-chain projectId. */
export function projectIdHash(projectId: string): Bytes32 {
  return keccak256(toHex(projectId));
}

/** keccak256 over the sorted "path:sha256" lines joined with \n. */
export function propertyHash(files: ReadonlyArray<{ path: string; sha256: string }>): Bytes32 {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}:${f.sha256}`);
  return keccak256(toHex(lines.join('\n')));
}
