import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { canonicalJson } from '@specfirst/core/hash';
import { computeReportHash } from '../lib/report';

describe('computeReportHash', () => {
  it('matches keccak256(toHex(canonicalJson(report))), independently recomputed', () => {
    const report = { specfirst: 1, name: 'StakingVault', unverified: ['oracle manipulation'], invariants: [] };
    const expected = keccak256(toHex(canonicalJson(report)));
    expect(computeReportHash(report)).toBe(expected);
  });

  it('is insensitive to key order (canonical JSON sorts keys)', () => {
    const a = { b: 2, a: 1 };
    const b = { a: 1, b: 2 };
    expect(computeReportHash(a)).toBe(computeReportHash(b));
  });

  it('changes when report content changes', () => {
    const a = computeReportHash({ invariants: [{ id: 'INV-1' }] });
    const b = computeReportHash({ invariants: [{ id: 'INV-2' }] });
    expect(a).not.toBe(b);
  });
});
