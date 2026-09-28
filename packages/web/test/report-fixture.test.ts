import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Report as CoreReport } from '@specfirst/core';
import { computeReportHash, isReport, type Report } from '../lib/report';

// Type-level sync with packages/core/src/cert/report.ts (checked by `pnpm lint`, type-only import):
// every report core writes is a valid web Report, and the web type declares no key core does not write.
export const coreFitsWeb = (r: CoreReport): Report => r;
type WebOnlyKeys = Exclude<keyof Report, keyof CoreReport>;
export const noWebOnlyKeys: [WebOnlyKeys] extends [never] ? true : WebOnlyKeys = true;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_FILE = path.join(here, 'fixtures/report-anvil-31337-0x9fE4-0.json');
const ONCHAIN = JSON.parse(readFileSync(path.join(here, 'fixtures/report-anvil-31337-0x9fE4-0.onchain.json'), 'utf8')) as Record<string, string | number>;

/**
 * A real report.json written by `specfirst cert issue` (packages/core buildReport) during an anvil
 * run, next to the certificate the registry stored for it. The web recomputation must equal the
 * on-chain reportHash byte for byte, or every certificate page would show a mismatch.
 */
describe('report.json produced by core', () => {
  const raw = readFileSync(REPORT_FILE, 'utf8');
  const report = JSON.parse(raw) as Report;

  it('recomputes to the reportHash stored on-chain', () => {
    expect(computeReportHash(report)).toBe(ONCHAIN.reportHash);
  });

  it('passes isReport and carries the hashes and counts the registry stored', () => {
    expect(isReport(report)).toBe(true);
    expect(report).toMatchObject({
      specfirst: 1,
      chainId: ONCHAIN.chainId,
      target: ONCHAIN.target,
      codeHash: ONCHAIN.codeHash,
      specHash: ONCHAIN.specHash,
      invariantSetHash: ONCHAIN.invariantSetHash,
      propertyHash: ONCHAIN.propertyHash,
      passedCount: ONCHAIN.passedCount,
      totalCount: ONCHAIN.totalCount,
      verifyMethod: 'fork',
    });
    expect(BigInt(report.passedBitmap!)).toBe(BigInt(ONCHAIN.passedBitmap));
    expect(report.rehearsal!.normalTx + report.rehearsal!.expectRevertTx).toBe(ONCHAIN.rehearsalTxCount);
    expect(report.invariants.map((i) => i.status)).toEqual(Array(7).fill('pass'));
  });

  it('any edit to the file changes the hash', () => {
    const tampered = JSON.parse(raw) as Report;
    tampered.unverified = tampered.unverified.slice(1);
    expect(computeReportHash(tampered)).not.toBe(ONCHAIN.reportHash);
  });
});
