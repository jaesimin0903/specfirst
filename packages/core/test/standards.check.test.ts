import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Address, Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ERC4626_PROPERTIES,
  ERC4626_UPSTREAM,
  ERC7535_NATIVE_ASSET,
  erc4626SourceFile,
  NATIVE_ASSET_REASON,
  runStandardCheck,
  sha256Hex,
  standardCheckPath,
  standardCheckReportSchema,
  StandardCheckError,
  type StandardCheckClient,
  type StandardCheckReport,
} from '../src/index.js';

const VAULT = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c' as Address;
const CODE: Hex = `0x6080604052a2646970667358221220${'11'.repeat(32)}64736f6c63430008180033`;

function client(o: { chainId?: number; code?: Hex; asset?: Address | Error }): StandardCheckClient {
  return {
    getChainId: vi.fn(async () => o.chainId ?? 143),
    getBlockNumber: vi.fn(async () => 5n),
    getCode: vi.fn(async () => o.code),
    getStorageAt: vi.fn(async () => `0x${'0'.repeat(64)}`),
    readContract: vi.fn(async () => {
      if (o.asset instanceof Error) throw o.asset;
      return o.asset;
    }),
  } as unknown as StandardCheckClient;
}

describe('standardCheckPath', () => {
  it('is .specfirst/checks/<chainId>/<lowercase address>/<block>.json', () => {
    expect(standardCheckPath('/p', 143, VAULT, 109061472n)).toBe(`/p/.specfirst/checks/143/${VAULT.toLowerCase()}/109061472.json`);
  });
});

describe('runStandardCheck without forge', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('ERC-7535 native-asset vault: every property not_applicable with the reason, forge never runs', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-'));
    const recordPath = path.join(dir, 'r.json');
    const events: string[] = [];
    const report = await runStandardCheck({
      standard: 'erc4626',
      address: VAULT,
      rpcUrl: 'http://127.0.0.1:1',
      runs: 8,
      client: client({ code: CODE, asset: ERC7535_NATIVE_ASSET }),
      cacheDir: path.join(dir, 'cache'),
      forgeBin: '/nonexistent/forge',
      recordPath,
      onEvent: (e) => void events.push(e.type),
    });
    expect(events).toEqual(['check-start', 'check-identity', 'check-skip']);
    expect(report.blockNumber).toBe('5');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 26 });
    expect(report.results.every((r) => r.status === 'not_applicable' && r.reason === NATIVE_ASSET_REASON)).toBe(true);
    expect(report.upstream).toEqual(ERC4626_UPSTREAM);
    expect(report.harnessSha256).toBe(sha256Hex(await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8')));
    const written = JSON.parse(await readFile(recordPath, 'utf8')) as StandardCheckReport;
    expect(standardCheckReportSchema.parse(written)).toEqual(report);
  });

  it('refuses an address without code before preparing anything', async () => {
    await expect(
      runStandardCheck({ standard: 'erc4626', address: VAULT, rpcUrl: 'http://127.0.0.1:1', blockNumber: 7n, client: client({}) }),
    ).rejects.toThrow(/no contract code at 0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c on chain 143 block 7/);
  });

  it('refuses an RPC on another chain than expected', async () => {
    await expect(
      runStandardCheck({ standard: 'erc4626', address: VAULT, rpcUrl: 'http://127.0.0.1:1', client: client({ chainId: 10143, code: CODE }), expectedChainId: 143 }),
    ).rejects.toThrow(StandardCheckError);
  });

  it('rejects bad runs, negative delta and unknown standards', async () => {
    const base = { address: VAULT, rpcUrl: 'http://127.0.0.1:1', client: client({ code: CODE }) };
    await expect(runStandardCheck({ ...base, standard: 'erc4626', runs: 0 })).rejects.toThrow(/runs must be a positive integer/);
    await expect(runStandardCheck({ ...base, standard: 'erc4626', delta: -1n })).rejects.toThrow(/delta must not be negative/);
    await expect(runStandardCheck({ ...base, standard: 'erc20' as 'erc4626' })).rejects.toThrow(/unknown standard/);
  });
});

describe('standardCheckReportSchema', () => {
  const valid = (): StandardCheckReport => ({
    schemaVersion: 1,
    chainId: 143,
    address: VAULT,
    blockNumber: '109061472',
    standard: 'erc4626',
    upstream: { ...ERC4626_UPSTREAM },
    harnessSha256: `0x${'ab'.repeat(32)}`,
    runs: 8,
    delta: '0',
    identity: {
      codeHash: `0x${'01'.repeat(32)}`,
      metadataHash: null,
      maskedCodeHash: `0x${'02'.repeat(32)}`,
      codeSize: 19689,
      proxy: null,
      implementation: null,
      implementationKey: `0x${'02'.repeat(32)}`,
      implementationKeyKind: { of: 'self', hash: 'maskedCodeHash' },
    },
    results: [
      { id: 'asset', test: 'test_asset', description: 'asset() does not revert', status: 'pass', runs: 8 },
      {
        id: 'previewDeposit',
        test: 'test_previewDeposit',
        description: ERC4626_PROPERTIES[5]!.description,
        status: 'fail',
        runs: 0,
        reason: 'Error: a >=~ b not satisfied [uint]',
        counterexample: { calls: ['test_previewDeposit((...), 1)'], calldata: '0x12', logs: ['   Value a: 1'] },
      },
      { id: 'maxDeposit', test: 'test_maxDeposit', description: 'd', status: 'inconclusive', reason: 'rejected too many inputs' },
      { id: 'mint', test: 'test_mint', description: 'd', status: 'not_applicable', reason: 'setUp failed' },
    ],
    summary: { pass: 1, fail: 1, inconclusive: 1, notApplicable: 1 },
    startedAt: '2026-09-29T14:00:00.000Z',
    durationMs: 1234,
  });

  it('accepts a complete report', () => {
    expect(standardCheckReportSchema.parse(valid())).toEqual(valid());
  });

  it('rejects a summary that does not match the results', () => {
    const r = valid();
    r.summary.pass = 2;
    expect(() => standardCheckReportSchema.parse(r)).toThrow(/summary.pass is 2, results say 1/);
  });

  it('rejects unknown statuses, extra keys, bad hashes and a wrong schema version', () => {
    expect(() => standardCheckReportSchema.parse({ ...valid(), results: [{ ...valid().results[0], status: 'error' }] })).toThrow();
    expect(() => standardCheckReportSchema.parse({ ...valid(), extra: 1 })).toThrow();
    expect(() => standardCheckReportSchema.parse({ ...valid(), harnessSha256: '0x12' })).toThrow();
    expect(() => standardCheckReportSchema.parse({ ...valid(), schemaVersion: 2 })).toThrow();
    expect(() => standardCheckReportSchema.parse({ ...valid(), blockNumber: 'latest' })).toThrow();
  });

  it('accepts proxies of every kind, including unknown', () => {
    const r = valid();
    r.identity.proxy = { kind: 'unknown' };
    expect(standardCheckReportSchema.parse(r).identity.proxy).toEqual({ kind: 'unknown' });
    r.identity.proxy = { kind: 'eip1967-beacon', implementation: VAULT, beacon: VAULT };
    r.identity.implementation = { address: VAULT, codeHash: `0x${'03'.repeat(32)}`, metadataHash: `0x1220${'04'.repeat(32)}`, maskedCodeHash: `0x${'05'.repeat(32)}` };
    r.identity.implementationKey = `0x${'06'.repeat(32)}`;
    r.identity.implementationKeyKind = { of: 'implementation', hash: 'metadataHash+maskedCodeHash' };
    expect(standardCheckReportSchema.parse(r)).toEqual(r);
  });
});
