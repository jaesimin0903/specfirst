import { describe, expect, it } from 'vitest';
import { checkBadgeOf, renderCheckBadgeSvg } from '../lib/desk/checkBadge';
import type { AttestationRecord } from '../lib/board/types';

function record(over: Partial<AttestationRecord> = {}): AttestationRecord {
  return {
    id: '7',
    status: 'Valid',
    compliant: true,
    blockNumber: '109300000',
    reportHash: `0x${'ab'.repeat(32)}`,
    suiteHash: `0x${'cd'.repeat(32)}`,
    implementationKey: `0x${'ef'.repeat(32)}`,
    subjectCodeHash: `0x${'12'.repeat(32)}`,
    counts: { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 },
    issuedAt: '2026-10-01T00:00:00.000Z',
    issuer: '0x1d93fFd65BD3C522766f1f5301660eec559D4D39',
    reportURI: 'https://example.test/r.json',
    txHash: null,
    ...over,
  };
}

describe('check badge state', () => {
  it('Compliant when the registry says so', () => {
    expect(checkBadgeOf({ kind: 'attested', record: record() })).toEqual({ state: 'compliant', text: 'compliant, 30/30 pass', attestationId: '7' });
  });

  it('Mismatch as soon as one property failed, whatever else', () => {
    const b = checkBadgeOf({ kind: 'attested', record: record({ compliant: false, counts: { pass: 16, fail: 2, inconclusive: 12, notApplicable: 0 } }) });
    expect(b).toEqual({ state: 'mismatch', text: 'mismatch, 2 of 30 fail', attestationId: '7', level: 'must' });
  });

  it('Partly checked when nothing failed but not everything ran', () => {
    const b = checkBadgeOf({ kind: 'attested', record: record({ compliant: false, counts: { pass: 24, fail: 0, inconclusive: 4, notApplicable: 2 } }) });
    expect(b.state).toBe('partial');
    expect(b.text).toBe('partly checked, 24/30 pass');
  });

  it('isCompliant unread falls back to the counts', () => {
    expect(checkBadgeOf({ kind: 'attested', record: record({ compliant: null }) }).state).toBe('compliant');
    expect(checkBadgeOf({ kind: 'attested', record: record({ compliant: null, counts: { pass: 29, fail: 0, inconclusive: 1, notApplicable: 0 } }) }).state).toBe('partial');
  });

  it('Not attested for no attestation or a revoked one; unreadable registry says so instead of guessing', () => {
    expect(checkBadgeOf({ kind: 'none' })).toEqual({ state: 'not-attested', text: 'not attested', attestationId: null });
    expect(checkBadgeOf({ kind: 'attested', record: record({ status: 'Revoked' }) }).state).toBe('not-attested');
    expect(checkBadgeOf({ kind: 'unread', reason: 'HTTP request failed.' })).toEqual({ state: 'unavailable', text: 'status unavailable', attestationId: null });
  });
});

describe('renderCheckBadgeSvg', () => {
  it('stable output for each state', () => {
    expect(renderCheckBadgeSvg(checkBadgeOf({ kind: 'attested', record: record() }))).toMatchSnapshot('compliant');
    expect(renderCheckBadgeSvg(checkBadgeOf({ kind: 'none' }))).toMatchSnapshot('not-attested');
  });

  it('carries the text in its accessible name and colors by state', () => {
    const svg = renderCheckBadgeSvg(checkBadgeOf({ kind: 'attested', record: record({ compliant: false, counts: { pass: 28, fail: 2, inconclusive: 0, notApplicable: 0 } }) }));
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="specfirst erc-4626: mismatch, 2 of 30 fail"');
    expect(svg).toContain('#cf3a1d');
  });

  it('escapes text', () => {
    expect(renderCheckBadgeSvg({ state: 'unavailable', text: '<b>&"', attestationId: null })).toContain('&lt;b&gt;&amp;&quot;');
  });
});
