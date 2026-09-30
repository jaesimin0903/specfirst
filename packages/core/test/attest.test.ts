import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import {
  AttestationError,
  attestationParamsFromReport,
  attestationReportPath,
  AttestationRegistryClient,
  canonicalJson,
  checkAttestationRegistryAbi,
  checkAttestationRegistryBytecode,
  checkReportHash,
  ERC4626_CHECK_PROPERTIES,
  identifyImplementation,
  parseCheckReport,
  propertiesHash,
  standardIdOf,
  statusBitmap,
  suiteHash,
  suiteOf,
  verifySubjectCode,
  type AttestParams,
  type StandardCheckReport,
  type SubjectClient,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const text = (name: string) => readFileSync(path.join(here, 'fixtures/attest', name), 'utf8');
const UPSHIFT = 'upshift-143-109061472.json';
const MORPHO = 'morpho-143-109061472.json';
/** The Morpho report as schemaVersion 2 (`vaultKind: "erc4626"` after `standard`), otherwise unchanged. */
const MORPHO_V2 = 'morpho-v2-143-109061472.json';
/** Morpho report with a non-ASCII revert string, a U+2028 and a control character in one fail reason. */
const NON_ASCII = 'nonascii-revert-143-109061472.json';
/** Computed with viem here, with abi.encode in CheckAttestationRegistry.t.sol and with `cast abi-encode`; all must agree. */
const MORPHO_SUITE_HASH = '0x49a246fc992c88a122f878579e0ee415f79ff4cf8c5f021b21a12d703e83023e';
/** keccak256 of the canonical JSON of ERC4626_CHECK_PROPERTIES; pinned in CheckAttestationRegistry.t.sol too. */
const ERC4626_PROPERTIES_HASH = '0x33117c4fed6c8e64829e6397d577a69153a43774fddd609e952264514e270204';
/** keccak256("erc4626"), the registry's standardId; pinned in CheckAttestationRegistry.t.sol too. */
const ERC4626_STANDARD_ID = '0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab';

describe('attestation parameters from real check reports (Monad block 109061472)', () => {
  it('Upshift earnAUSD: 16 pass, 2 fail, 12 inconclusive; bitmaps follow the result order', () => {
    const report = parseCheckReport(text(UPSHIFT));
    const p = attestationParamsFromReport(report, { reportURI: 'certs/checks/143/x/109061472.json' });
    expect(p).toMatchObject({
      subjectChainId: 143n,
      subject: '0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E',
      standardId: ERC4626_STANDARD_ID,
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
      forgeVersion: 'forge Version: 1.5.1-Homebrew',
      harnessSha256: report.harnessSha256,
      sfPropertiesSha256: report.sfPropertiesSha256,
      propertiesHash: ERC4626_PROPERTIES_HASH,
      foundryTomlSha256: report.toolchain.foundryTomlSha256,
      runs: 16n,
      maxTestRejects: 4096n,
      delta: 0n,
    });
  });

  it('accepts schemaVersion 2 reports with vaultKind: same suite, own reportHash; version 2 without vaultKind is refused', () => {
    const v1 = parseCheckReport(text(MORPHO));
    const v2 = parseCheckReport(text(MORPHO_V2));
    expect(v2).toMatchObject({ schemaVersion: 2, vaultKind: 'erc4626' });
    const p1 = attestationParamsFromReport(v1, { reportURI: 'u' });
    const p2 = attestationParamsFromReport(v2, { reportURI: 'u' });
    // vaultKind is a report value, not a suite input: suiteHash stays, reportHash changes.
    expect(p2.suiteHash).toBe(MORPHO_SUITE_HASH);
    expect(p2.reportHash).toBe(keccak256(toHex(canonicalJson(JSON.parse(text(MORPHO_V2))))));
    expect(p2.reportHash).not.toBe(p1.reportHash);
    expect({ ...p2, reportHash: p1.reportHash }).toEqual(p1);
    // An ERC-7575 vault: forge does not run, all 30 properties not_applicable, forgeVersion null.
    const raw = JSON.parse(text(MORPHO_V2)) as StandardCheckReport;
    const skipped = parseCheckReport(
      JSON.stringify({
        ...raw,
        vaultKind: 'erc7575',
        seed: null,
        sender: null,
        toolchain: { ...raw.toolchain, forgeVersion: null },
        results: raw.results.map(({ id, test, description }) => ({ id, test, description, status: 'not_applicable', reason: 'share() is a separate token' })),
        summary: { pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 },
      }),
    );
    expect(attestationParamsFromReport(skipped, { reportURI: 'u' })).toMatchObject({ passCount: 0, notApplicableCount: 30, passedBitmap: 0n, failedBitmap: 0n });
    expect(suiteOf(skipped).forgeVersion).toBe('');
    expect(() => parseCheckReport(JSON.stringify({ ...raw, vaultKind: undefined }))).toThrow(/vaultKind: vaultKind is required from schemaVersion 2 on/);
    expect(() => parseCheckReport(JSON.stringify({ ...raw, schemaVersion: 1 }))).toThrow(/vaultKind does not exist in schemaVersion 1/);
  });

  it('standardId is keccak256 of the standard name; propertiesHash is the canonical JSON of the property table', () => {
    expect(standardIdOf('erc4626')).toBe(ERC4626_STANDARD_ID);
    expect(propertiesHash(ERC4626_CHECK_PROPERTIES)).toBe(ERC4626_PROPERTIES_HASH);
    expect(ERC4626_PROPERTIES_HASH).toBe(keccak256(toHex(canonicalJson(ERC4626_CHECK_PROPERTIES))));
  });

  it('both reports ran the same suite, so they share suiteHash; any suite input changes it', () => {
    const u = parseCheckReport(text(UPSHIFT));
    const m = parseCheckReport(text(MORPHO));
    expect(suiteHash(suiteOf(u))).toBe(suiteHash(suiteOf(m)));
    const base = suiteOf(m);
    const zero = `0x${'00'.repeat(32)}` as Hex;
    for (const change of [
      { runs: 32n },
      { delta: 1n },
      { maxTestRejects: 65536n },
      { standard: 'erc20' },
      { harnessSha256: zero },
      { forgeVersion: 'forge Version: 1.5.2' },
      { forgeVersion: '' },
      { propertiesHash: zero },
    ]) {
      expect(suiteHash({ ...base, ...change })).not.toBe(MORPHO_SUITE_HASH);
    }
    // A report where forge did not run records forgeVersion null; the suite carries "".
    const noForge = { ...m, toolchain: { ...m.toolchain, forgeVersion: null } } as StandardCheckReport;
    expect(suiteOf(noForge).forgeVersion).toBe('');
  });

  it('refuses a report whose results are not the property table in order: bit i must mean property i', () => {
    const report = parseCheckReport(text(MORPHO));
    const swapped = { ...report, results: [report.results[1]!, report.results[0]!, ...report.results.slice(2)] };
    expect(() => attestationParamsFromReport(swapped, { reportURI: 'u' })).toThrow(/not the erc4626 property table .* bit i of an attestation would not mean property i/);
    const renamed = { ...report, results: report.results.map((r, i) => (i === 3 ? { ...r, description: 'something else' } : r)) };
    expect(() => attestationParamsFromReport(renamed, { reportURI: 'u' })).toThrow(AttestationError);
    const short = { ...report, results: report.results.slice(0, 29), summary: { ...report.summary, pass: 29 } };
    expect(() => attestationParamsFromReport(short, { reportURI: 'u' })).toThrow(/29 results are not the erc4626 property table \(30 properties/);
  });

  it('refuses a reportURI over 512 UTF-8 bytes, the registry limit', () => {
    const report = parseCheckReport(text(MORPHO));
    expect(attestationParamsFromReport(report, { reportURI: 'a'.repeat(512) }).reportURI).toHaveLength(512);
    expect(() => attestationParamsFromReport(report, { reportURI: 'a'.repeat(513) })).toThrow(/reportURI is 513 bytes; the registry accepts at most 512/);
    // 171 three-byte characters are 513 bytes.
    expect(() => attestationParamsFromReport(report, { reportURI: '가'.repeat(171) })).toThrow(/513 bytes/);
  });

  it('report copies are named <chainId>/<address>/<block>-<first 8 bytes of reportHash>.json', () => {
    const report = parseCheckReport(text(MORPHO));
    const hash = checkReportHash(report);
    expect(attestationReportPath(report)).toBe(`143/0x802c91d807a8daca257c4708ab264b6520964e44/109061472-${hash.slice(2, 18)}.json`);
    expect(attestationReportPath(parseCheckReport(text(UPSHIFT)))).not.toBe(attestationReportPath(report).replace('0x802c91d807a8daca257c4708ab264b6520964e44', '0xd793c04b87386a6bb84ee61d98e0065fde7fda5e'));
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

  it('reportHash of a report with non-ASCII revert text matches an independent RFC 8785 serialization', () => {
    const report = parseCheckReport(text(NON_ASCII));
    expect(report.results.find((r) => r.id === 'deposit')!.reason).toBe(`예치 한도 초과: dépôt refusé, 預金上限${String.fromCharCode(0x2028, 0x07)}`);
    // Python json.dumps(r, sort_keys=True, separators=(',', ':'), ensure_ascii=False), UTF-8, then `cast keccak`.
    expect(checkReportHash(report)).toBe('0xb449b8b8131bcf40394c07c44d7c5e44c0eee4eb05d47494a2731f023169b031');
    // Python's default ensure_ascii=True writes \uXXXX escapes instead of UTF-8 and gives another hash (ADR 0004).
    expect(checkReportHash(report)).not.toBe('0x98be96f142b8a852caa3eae2417a7a1fe9f62e1a14b122e9c18be89d0ca55e33');
    expect(canonicalJson(report)).toContain('"reason":"예치 한도 초과: dépôt refusé, 預金上限 \\u0007"');
  });

  it('rejects invalid reports, a block number with leading zeros, and more than 256 results', () => {
    expect(() => parseCheckReport('{')).toThrow(AttestationError);
    expect(() => parseCheckReport(JSON.stringify({ ...JSON.parse(text(MORPHO)), summary: { pass: 1, fail: 0, inconclusive: 0, notApplicable: 0 } }))).toThrow(
      /not a valid StandardCheckReport: summary.pass/,
    );
    expect(() => parseCheckReport(JSON.stringify({ ...JSON.parse(text(MORPHO)), blockNumber: '0109061472' }))).toThrow(/blockNumber: expected a decimal integer string without leading zeros/);
    expect(parseCheckReport(JSON.stringify({ ...JSON.parse(text(MORPHO)), blockNumber: '0' })).blockNumber).toBe('0');
    const report = parseCheckReport(text(MORPHO));
    const big = { ...report, results: Array.from({ length: 257 }, (_, i) => ({ ...report.results[0]!, id: `p${i}` })) };
    expect(() => statusBitmap(big, 'pass')).toThrow(/257 results; an attestation holds at most 256/);
    const exact = { ...report, results: big.results.slice(0, 256) };
    expect(statusBitmap(exact, 'pass')).toBe(2n ** 256n - 1n);
  });
});

describe('verifySubjectCode: identity on the subject chain (mock subject client, no RPC)', () => {
  const base = parseCheckReport(text(MORPHO));
  const SUBJECT = getAddress(base.address);
  const BLOCK = BigInt(base.blockNumber);
  const PLAIN: Hex = '0x6080604052348015600e575f80fd5b50';
  // EIP-1967 shaped proxy: PUSH32 <implementation slot>, SLOAD, GAS, DELEGATECALL. No CBOR tail.
  const PROXY: Hex = '0x365f5f375f5f365f7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d5f5f3e3d5ff3';
  const IMPL_A = getAddress('0x00000000000000000000000000000000000a0001');
  const IMPL_B = getAddress('0x00000000000000000000000000000000000b0001');
  const IMPL_CODE: Record<string, Hex> = { [IMPL_A.toLowerCase()]: '0x6080604052348015600e575f80fd5b50', [IMPL_B.toLowerCase()]: '0x6080604052348015600f575f80fd5b5000' };
  const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
  const word = (a: Address): Hex => `0x${'00'.repeat(12)}${a.slice(2).toLowerCase()}`;

  /** A subject chain holding `code` at SUBJECT and, for a proxy, `impl` in the EIP-1967 implementation slot. */
  const chain = (o: { chainId?: number; code: Hex | undefined; impl?: Address }): SubjectClient =>
    ({
      getChainId: vi.fn(async () => o.chainId ?? 143),
      getCode: vi.fn(async ({ address }: { address: Address }) => (address.toLowerCase() === SUBJECT.toLowerCase() ? o.code : IMPL_CODE[address.toLowerCase()])),
      getStorageAt: vi.fn(async ({ slot }: { slot: Hex }) => (slot === IMPL_SLOT && o.impl ? word(o.impl) : `0x${'00'.repeat(32)}`)),
      readContract: vi.fn(async () => {
        throw new Error('no beacon');
      }),
    }) as unknown as SubjectClient;
  /** The Morpho report re-pointed at what identifyImplementation sees on `c`, as `specfirst check` would record it. */
  const reportOn = async (c: SubjectClient): Promise<StandardCheckReport> =>
    ({ ...base, identity: await identifyImplementation(c, SUBJECT, BLOCK) }) as StandardCheckReport;

  it('accepts a plain contract whose identity at the report block equals the report', async () => {
    const c = chain({ code: PLAIN });
    const report = await reportOn(c);
    const out = await verifySubjectCode(c, report);
    expect(out).toMatchObject({ chainId: 143, blockNumber: BLOCK, codeHash: keccak256(PLAIN), unknownProxy: false });
    expect(out.identity.implementationKey).toBe(report.identity.implementationKey);
    expect(c.getCode).toHaveBeenCalledWith({ address: SUBJECT, blockNumber: BLOCK });
  });

  it('accepts a resolved EIP-1967 proxy, addresses compared without regard to case', async () => {
    const c = chain({ code: PROXY, impl: IMPL_A });
    const report = await reportOn(c);
    expect(report.identity).toMatchObject({ proxy: { kind: 'eip1967', implementation: IMPL_A }, implementationKeyKind: { of: 'implementation' } });
    const lower = JSON.parse(JSON.stringify(report).replaceAll(IMPL_A, IMPL_A.toLowerCase())) as StandardCheckReport;
    await expect(verifySubjectCode(c, lower)).resolves.toMatchObject({ unknownProxy: false });
  });

  it('refuses when the implementation behind the same proxy code differs from the report (e.g. upgraded)', async () => {
    const report = await reportOn(chain({ code: PROXY, impl: IMPL_A }));
    const upgraded = chain({ code: PROXY, impl: IMPL_B });
    await expect(verifySubjectCode(upgraded, report)).rejects.toThrow(
      /identity of 0x802c.* on chain 143 block 109061472 differs from the report: proxy: report .*0x00000000000000000000000000000000000a0001.*, chain .*0x00000000000000000000000000000000000b0001.*; implementation: .*; implementationKey: report "0x[0-9a-f]{64}", chain "0x[0-9a-f]{64}"/,
    );
    // Only the key forged: codeHash and proxy agree, implementationKey does not.
    const forged = { ...report, identity: { ...report.identity, implementationKey: `0x${'ab'.repeat(32)}` } } as StandardCheckReport;
    await expect(verifySubjectCode(chain({ code: PROXY, impl: IMPL_A }), forged)).rejects.toThrow(/differs from the report: implementationKey: report "0xabab/);
    // A report that claims a proxy is not one.
    const kind = { ...report, identity: { ...report.identity, implementationKeyKind: { of: 'self', hash: 'maskedCodeHash' } } } as StandardCheckReport;
    await expect(verifySubjectCode(chain({ code: PROXY, impl: IMPL_A }), kind)).rejects.toThrow(/implementationKeyKind: report \{"hash":"maskedCodeHash","of":"self"\}/);
  });

  it('refuses a proxy whose implementation could not be resolved unless allowUnknownProxy', async () => {
    const c = chain({ code: PROXY });
    const report = await reportOn(c);
    expect(report.identity.proxy).toEqual({ kind: 'unknown' });
    await expect(verifySubjectCode(c, report)).rejects.toThrow(/proxy-shaped but its implementation could not be resolved \(proxy kind unknown\).*--allow-unknown-proxy/);
    await expect(verifySubjectCode(c, report, { allowUnknownProxy: true })).resolves.toMatchObject({ unknownProxy: true, identity: { proxy: { kind: 'unknown' } } });
  });

  it('rejects different code, no code, and an RPC on another chain', async () => {
    const report = await reportOn(chain({ code: PLAIN }));
    await expect(verifySubjectCode(chain({ code: '0x6001' }), report)).rejects.toThrow(/hashes to 0x[0-9a-f]{64}, the report says/);
    await expect(verifySubjectCode(chain({ code: '0x' }), report)).rejects.toThrow(/no code at 0x802c/);
    await expect(verifySubjectCode(chain({ code: undefined }), report)).rejects.toThrow(/no code/);
    await expect(verifySubjectCode(chain({ chainId: 10143, code: PLAIN }), report)).rejects.toThrow(/subject RPC serves chain 10143, the report is for chain 143/);
  });
});

describe('AttestationRegistryClient.attest reads the id from the receipt (mocks, no RPC)', () => {
  const REGISTRY = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  const DECOY = getAddress('0x00000000000000000000000000000000000000d1');
  const ISSUER = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  const params: AttestParams = attestationParamsFromReport(parseCheckReport(text(MORPHO)), { reportURI: 'u' });
  const attestedEvent = checkAttestationRegistryAbi.find((x) => x.type === 'event' && x.name === 'Attested')!;
  const attestedLog = (address: Address, id: bigint) => ({
    address: address.toLowerCase(),
    topics: encodeEventTopics({ abi: checkAttestationRegistryAbi, eventName: 'Attested', args: { id, subjectChainId: params.subjectChainId, subject: params.subject } }),
    data: encodeAbiParameters(
      (attestedEvent as { inputs: readonly { indexed?: boolean }[] }).inputs.filter((i) => !i.indexed) as never,
      [ISSUER, params] as never,
    ),
    blockNumber: 5n,
    logIndex: 0,
    transactionHash: `0x${'ab'.repeat(32)}`,
  });
  const registry = (logs: unknown[]) =>
    new AttestationRegistryClient(
      REGISTRY,
      {
        simulateContract: vi.fn(async () => ({ request: {}, result: 999n })),
        estimateContractGas: vi.fn(async () => 100_000n),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 5n, gasUsed: 21_000n, logs })),
      } as never,
      { account: { address: ISSUER }, writeContract: vi.fn(async () => `0x${'ab'.repeat(32)}`) } as never,
    );

  it("uses the registry's own Attested event, not the simulation's return value or another contract's event", async () => {
    const out = await registry([attestedLog(DECOY, 7n), attestedLog(REGISTRY, 3n)]).attest(params);
    expect(out.id).toBe(3n);
  });

  it('refuses a receipt without exactly one Attested event from the registry', async () => {
    await expect(registry([attestedLog(DECOY, 7n)]).attest(params)).rejects.toThrow(/expected one Attested event from 0x5FbDB.* found 0/);
    await expect(registry([attestedLog(REGISTRY, 1n), attestedLog(REGISTRY, 2n)]).attest(params)).rejects.toThrow(/found 2/);
  });
});

describe('bundled CheckAttestationRegistry artifact', () => {
  const contracts = path.resolve(here, '../../contracts');
  const built = path.join(contracts, 'out/CheckAttestationRegistry.sol/CheckAttestationRegistry.json');
  // Skipped only when forge is not installed; with forge the build runs here, so a stale artifact fails.
  const hasForge = spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasForge)('matches a fresh forge build (regenerate with scripts/gen-attest-artifact.mjs)', () => {
    const build = spawnSync('forge', ['build'], { cwd: contracts, encoding: 'utf8', timeout: 240_000 });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const art = JSON.parse(readFileSync(built, 'utf8')) as { abi: unknown; bytecode: { object: string } };
    expect(checkAttestationRegistryAbi).toEqual(art.abi);
    expect(checkAttestationRegistryBytecode).toBe(art.bytecode.object);
  }, 300_000);
});
