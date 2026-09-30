import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  AttestationError,
  attestationParamsFromReport,
  canonicalJson,
  checkAttestationRegistryAbi,
  checkAttestationRegistryBytecode,
  checkReportHash,
  parseCheckReport,
  statusBitmap,
  suiteHash,
  suiteOf,
  verifySubjectCode,
  type StandardCheckReport,
  type SubjectClient,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const text = (name: string) => readFileSync(path.join(here, 'fixtures/attest', name), 'utf8');
const UPSHIFT = 'upshift-143-109061472.json';
const MORPHO = 'morpho-143-109061472.json';
/** Computed with viem here and with abi.encode in CheckAttestationRegistry.t.sol; both must agree. */
const MORPHO_SUITE_HASH = '0x583b17e2ce455495cbdf0c337c1c9235b81aedaef8373e57521e36311cd11d50';

describe('attestation parameters from real check reports (Monad block 109061472)', () => {
  it('Upshift earnAUSD: 16 pass, 2 fail, 12 inconclusive; bitmaps follow the result order', () => {
    const report = parseCheckReport(text(UPSHIFT));
    const p = attestationParamsFromReport(report, { reportURI: 'certs/checks/143/x/109061472.json' });
    expect(p).toMatchObject({
      subjectChainId: 143n,
      subject: '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E',
      blockNumber: 109061472n,
      implementationKey: report.identity.implementationKey,
      subjectCodeHash: '0xa60c40de9979a21d4ec81b613b9da678727c39ef441c3227d78330cf649233b0',
      passCount: 16,
      failCount: 2,
      inconclusiveCount: 12,
      notApplicableCount: 0,
      reportURI: 'certs/checks/143/x/109061472.json',
    });
    // Bit i is result i. The two fails are sf-maxWithdraw-honored and sf-maxRedeem-honored.
    const ids = report.results.map((r) => r.id);
    const failed = ids.filter((_, i) => (p.failedBitmap >> BigInt(i)) & 1n);
    expect(failed).toEqual(['sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    expect(p.passedBitmap & p.failedBitmap).toBe(0n);
    const popcount = (x: bigint) => x.toString(2).split('').filter((c) => c === '1').length;
    expect(popcount(p.passedBitmap)).toBe(16);
    expect(p.passedBitmap >> BigInt(report.results.length)).toBe(0n);
  });

  it('Morpho: 30 of 30 pass, passedBitmap is the low 30 bits, suiteHash matches the Solidity vector', () => {
    const report = parseCheckReport(text(MORPHO));
    const p = attestationParamsFromReport(report, { reportURI: 'u' });
    expect(p).toMatchObject({ passCount: 30, failCount: 0, inconclusiveCount: 0, notApplicableCount: 0, passedBitmap: 2n ** 30n - 1n, failedBitmap: 0n });
    expect(p.suiteHash).toBe(MORPHO_SUITE_HASH);
    expect(suiteOf(report)).toEqual({
      standard: 'erc4626',
      upstreamRepo: 'https://github.com/a16z/erc4626-tests',
      upstreamCommit: '0xac485460e014f22807c1ff687e0b4dc3af96ee40',
      forgeStdCommit: '0xbf647bd6046f2f7da30d0c2bf435e5c76a780c1b',
      harnessSha256: report.harnessSha256,
      sfPropertiesSha256: report.sfPropertiesSha256,
      foundryTomlSha256: report.toolchain.foundryTomlSha256,
      runs: 16n,
      maxTestRejects: 4096n,
      delta: 0n,
    });
  });

  it('both reports ran the same suite, so they share suiteHash; any suite input changes it', () => {
    const u = parseCheckReport(text(UPSHIFT));
    const m = parseCheckReport(text(MORPHO));
    expect(suiteHash(suiteOf(u))).toBe(suiteHash(suiteOf(m)));
    const base = suiteOf(m);
    for (const change of [{ runs: 32n }, { delta: 1n }, { maxTestRejects: 65536n }, { standard: 'erc20' }, { harnessSha256: `0x${'00'.repeat(32)}` as Hex }]) {
      expect(suiteHash({ ...base, ...change })).not.toBe(MORPHO_SUITE_HASH);
    }
  });

  it('reportHash is keccak256 of the canonical JSON: formatting and key order do not matter, values do', () => {
    const raw = text(MORPHO);
    const report = parseCheckReport(raw);
    const hash = checkReportHash(report);
    expect(hash).toBe(keccak256(toHex(canonicalJson(JSON.parse(raw)))));
    const reformatted = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(raw)).reverse()), null, 4);
    expect(checkReportHash(parseCheckReport(reformatted))).toBe(hash);
    const edited = JSON.parse(raw) as StandardCheckReport;
    edited.durationMs += 1;
    expect(checkReportHash(parseCheckReport(JSON.stringify(edited)))).not.toBe(hash);
  });

  it('rejects invalid reports and more than 256 results', () => {
    expect(() => parseCheckReport('{')).toThrow(AttestationError);
    expect(() => parseCheckReport(JSON.stringify({ ...JSON.parse(text(MORPHO)), summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 } }))).toThrow(
      /not a valid StandardCheckReport: summary.pass/,
    );
    const report = parseCheckReport(text(MORPHO));
    const big = { ...report, results: Array.from({ length: 257 }, (_, i) => ({ ...report.results[0]!, id: `p${i}` })) };
    expect(() => statusBitmap(big, 'pass')).toThrow(/257 results; an attestation holds at most 256/);
    const exact = { ...report, results: big.results.slice(0, 256) };
    expect(statusBitmap(exact, 'pass')).toBe(2n ** 256n - 1n);
  });
});

describe('verifySubjectCode (mock subject client, no RPC)', () => {
  const report = parseCheckReport(text(MORPHO));
  // The vault's real code is not bundled; the report's identity.codeHash is set to the hash of a known code.
  const CODE: Hex = '0x6080604052348015600e575f80fd5b50';
  const withHash = { ...report, identity: { ...report.identity, codeHash: keccak256(CODE) } } as StandardCheckReport;
  const client = (o: { chainId?: number; code?: Hex }): SubjectClient =>
    ({
      getChainId: vi.fn(async () => o.chainId ?? 143),
      getCode: vi.fn(async () => o.code),
    }) as unknown as SubjectClient;

  it('accepts code whose keccak256 at the report block equals identity.codeHash', async () => {
    const c = client({ code: CODE });
    await expect(verifySubjectCode(c, withHash)).resolves.toEqual({ chainId: 143, blockNumber: 109061472n, codeHash: keccak256(CODE) });
    expect(c.getCode).toHaveBeenCalledWith({ address: report.address as Address, blockNumber: 109061472n });
  });

  it('rejects different code, no code, and an RPC on another chain', async () => {
    await expect(verifySubjectCode(client({ code: '0x6001' }), withHash)).rejects.toThrow(/hashes to 0x[0-9a-f]{64}, the report says/);
    await expect(verifySubjectCode(client({ code: '0x' }), withHash)).rejects.toThrow(/no code at 0x802c/);
    await expect(verifySubjectCode(client({ code: undefined }), withHash)).rejects.toThrow(/no code/);
    await expect(verifySubjectCode(client({ chainId: 10143, code: CODE }), withHash)).rejects.toThrow(/subject RPC serves chain 10143, the report is for chain 143/);
  });
});

describe('bundled CheckAttestationRegistry artifact', () => {
  const built = path.resolve(here, '../../contracts/out/CheckAttestationRegistry.sol/CheckAttestationRegistry.json');
  it.skipIf(!existsSync(built))('matches the forge build (regenerate with scripts/gen-attest-artifact.mjs)', () => {
    const art = JSON.parse(readFileSync(built, 'utf8')) as { abi: unknown; bytecode: { object: string } };
    expect(checkAttestationRegistryAbi).toEqual(art.abi);
    expect(checkAttestationRegistryBytecode).toBe(art.bytecode.object);
  });
});
