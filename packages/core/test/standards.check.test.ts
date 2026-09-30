import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toFunctionSelector, type Address, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  badChecksum,
  ERC4626_FOUNDRY_TOML,
  ERC4626_PROPERTIES,
  ERC4626_UPSTREAM,
  ERC7535_NATIVE_ASSET,
  erc7575Reason,
  erc4626SourceFile,
  FORGE_STD_PIN,
  forgeEnv,
  maskRpcUrl,
  MAX_UINT256,
  NATIVE_ASSET_REASON,
  runStandardCheck,
  sha256Hex,
  standardCheckPath,
  standardCheckReportSchema,
  standardCheckExitCode,
  StandardCheckError,
  type StandardCheckClient,
  type StandardCheckReport,
} from '../src/index.js';
import { localRepo } from './helpers/gitRepo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VAULT = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c' as Address;
const CODE: Hex = `0x6080604052a2646970667358221220${'11'.repeat(32)}64736f6c63430008180033`;

/** Answers asset() with `asset` and share() with `share`; an Error answer reverts, undefined means no share(). */
function client(o: { chainId?: number; code?: Hex; asset?: Address | Error; share?: Address | Error }): StandardCheckClient {
  return {
    getChainId: vi.fn(async () => o.chainId ?? 143),
    getBlockNumber: vi.fn(async () => 5n),
    getCode: vi.fn(async () => o.code),
    getStorageAt: vi.fn(async () => `0x${'0'.repeat(64)}`),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      const answer = functionName === 'share' ? (o.share ?? new Error('execution reverted')) : o.asset;
      if (answer instanceof Error) throw answer;
      return answer;
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
    const rawPath = path.join(dir, 'r.forge.json');
    await writeFile(rawPath, '{"stale":true}');
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
      rawPath,
      onEvent: (e) => void events.push(e.type),
    });
    // L7: forge did not run, so no raw file, and a stale one from an earlier run is gone.
    expect(existsSync(rawPath)).toBe(false);
    expect(report).toMatchObject({ seed: null, sender: null, toolchain: { forgeVersion: null, forgeStd: { repo: FORGE_STD_PIN.repo, commit: FORGE_STD_PIN.commit } } });
    expect(events).toEqual(['check-start', 'check-identity', 'check-skip']);
    expect(report.blockNumber).toBe('5');
    expect(report).toMatchObject({ schemaVersion: 3, vaultKind: 'erc7535', skipReason: 'native-asset' });
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(report.results.every((r) => r.status === 'not_applicable' && r.reason === NATIVE_ASSET_REASON)).toBe(true);
    expect(report.upstream).toEqual(ERC4626_UPSTREAM);
    expect(report.harnessSha256).toBe(sha256Hex(await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8')));
    expect(report.sfPropertiesSha256).toBe(sha256Hex(await readFile(erc4626SourceFile('SpecfirstMaxHonored.t.sol'), 'utf8')));
    expect(report.results.slice(26).map((r) => r.id)).toEqual(['sf-maxDeposit-honored', 'sf-maxMint-honored', 'sf-maxWithdraw-honored', 'sf-maxRedeem-honored']);
    const written = JSON.parse(await readFile(recordPath, 'utf8')) as StandardCheckReport;
    expect(standardCheckReportSchema.parse(written)).toEqual(report);
  });

  it('ERC-7575 vault (share() names another token): every property not_applicable, forge never runs, exit 17', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-'));
    const shareToken = '0x5f00000000000000000000000000000000000041' as Address;
    const events: Array<{ type: string; vaultKind?: string; reason?: string }> = [];
    const c = client({ code: CODE, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', share: shareToken });
    const report = await runStandardCheck({
      standard: 'erc4626',
      address: VAULT,
      rpcUrl: 'http://127.0.0.1:1',
      client: c,
      cacheDir: path.join(dir, 'cache'),
      forgeBin: '/nonexistent/forge',
      recordPath: path.join(dir, 'r.json'),
      onEvent: (e) => void events.push(e),
    });
    const reason = erc7575Reason(shareToken);
    expect(reason).toBe(
      'ERC-7575 vault: shares are a separate token (share() = 0x5f00000000000000000000000000000000000041); both suites assume the vault is its own share token and call balanceOf, allowance and approve on it',
    );
    expect(events.map((e) => e.type)).toEqual(['check-start', 'check-identity', 'check-skip']);
    expect(events[2]).toMatchObject({ vaultKind: 'erc7575', reason });
    expect(report).toMatchObject({ schemaVersion: 3, vaultKind: 'erc7575', skipReason: 'separate-share-token', seed: null, sender: null });
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(report.results.every((r) => r.status === 'not_applicable' && r.reason === reason)).toBe(true);
    expect(standardCheckExitCode(report.summary)).toBe(17);
    expect(c.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'share', blockNumber: 5n }));
    expect(existsSync(path.join(dir, 'cache'))).toBe(false);
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
    await expect(runStandardCheck({ ...base, standard: 'erc4626', delta: -1n })).rejects.toThrow(/delta must be a uint256/);
    await expect(runStandardCheck({ ...base, standard: 'erc4626', delta: MAX_UINT256 + 1n })).rejects.toThrow(/delta must be a uint256/);
    await expect(runStandardCheck({ ...base, standard: 'erc4626', seed: MAX_UINT256 + 1n })).rejects.toThrow(/seed must be a uint256/);
    await expect(runStandardCheck({ ...base, standard: 'erc20' as 'erc4626' })).rejects.toThrow(/unknown standard/);
  });

  it('L5: rejects a mixed-case address with a wrong checksum; lowercase and correct checksums pass validation', async () => {
    expect(badChecksum(VAULT)).toBe(false);
    expect(badChecksum(VAULT.toLowerCase())).toBe(false);
    expect(badChecksum(`0x${VAULT.slice(2).toUpperCase()}`)).toBe(false);
    expect(badChecksum('0x1B68626dCa36c7fE922fD2d55E4f631d962dE19C')).toBe(true);
    await expect(
      runStandardCheck({ standard: 'erc4626', address: '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19C', rpcUrl: 'http://127.0.0.1:1', client: client({ code: CODE }) }),
    ).rejects.toThrow(/wrong EIP-55 checksum/);
  });
});

describe('maskRpcUrl and forgeEnv', () => {
  it('L6: masks the URL, its host and key-like parts in any letter case', () => {
    const url = 'https://Monad.Example.org:8443/v2/SecretKey123?apikey=Abcdef9876&x=1';
    const text = [
      'error sending request for url (https://monad.example.org:8443/v2/secretkey123?apikey=abcdef9876&x=1)',
      'could not instantiate forked environment with provider MONAD.EXAMPLE.ORG',
      'token SECRETKEY123 and ABCDEF9876 alone',
    ].join('\n');
    const out = maskRpcUrl(text, url);
    expect(out).not.toMatch(/example\.org|secretkey123|abcdef9876/i);
    expect(out.split('\n')[1]).toBe('could not instantiate forked environment with provider <rpc>');
    expect(maskRpcUrl('0x5F00000000000000000000000000000000000011 reverted', 'http://127.0.0.1:8545')).toBe('0x5F00000000000000000000000000000000000011 reverted');
  });

  it('M6: forge gets PATH and HOME but no FOUNDRY_* or ETH_RPC_URL from the caller', () => {
    const env = forgeEnv({ SF_VAULT: '0x1' }, { PATH: '/bin', HOME: '/h', FOUNDRY_FUZZ_RUNS: '1', FOUNDRY_ETH_RPC_URL: 'x', ETH_RPC_URL: 'y', DAPP_X: 'z' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', SF_VAULT: '0x1' });
  });
});

/**
 * A stand-in forge: records argv and environment, writes a deposit-below-max event file like the harness,
 * prints a log line with the RPC URL and then a forge JSON document built from a real fixture.
 */
async function fakeForge(dir: string, doc: object, opts: { noJson?: boolean } = {}): Promise<{ bin: string; record: string }> {
  const bin = path.join(dir, 'forge');
  const record = path.join(dir, 'record.json');
  const depositSel = toFunctionSelector(Object.keys((Object.values(doc)[0] as { test_results: object }).test_results).find((k) => k.startsWith('test_deposit('))!);
  const script = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('forge Version: 1.5.1-fake'); console.log('Commit SHA: 0'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, env: process.env, cwd: process.cwd() }));
if (${JSON.stringify(!!opts.noJson)}) { console.error('Error: could not instantiate forked environment with provider RPC.EXAMPLE.ORG'); process.exit(1); }
if (process.env.SF_RUN_ID) fs.appendFileSync(path.join('sf-events', process.env.SF_RUN_ID + '.deposit-below-max.log'), ${JSON.stringify(`${depositSel}\n${depositSel}\n`)});
console.log('2026-09-30T00:00:00Z ERROR sharedbackend: failed for url HTTPS://RPC.EXAMPLE.ORG/SECRETKEY123/');
console.log(${JSON.stringify(JSON.stringify(doc))});
`;
  await writeFile(bin, script.replace('#!/usr/bin/env node', '#!/usr/bin/env node\n'));
  await chmod(bin, 0o755);
  return { bin, record };
}

describe('runStandardCheck with a stand-in forge (M6, M7, L3, L6, L7)', () => {
  const RPC = 'https://rpc.example.org/secretKey123/';
  let root: string | undefined;
  const saved = { ...process.env };
  afterEach(async () => {
    process.env = { ...saved };
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function setup(opts: { noJson?: boolean } = {}) {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-fake-forge-'));
    const up = await localRepo(root, 'up', [{ 'ERC4626.test.sol': 'x' }]);
    const std = await localRepo(root, 'std', [{ 'Test.sol': 'y' }]);
    const doc = JSON.parse(await readFile(path.join(here, 'fixtures/standards/morpho-143-109061472-runs32.json'), 'utf8')) as Record<string, { test_results: Record<string, { status: string; reason: string | null }> }>;
    const tests = Object.values(doc)[0]!.test_results;
    const key = Object.keys(tests).find((k) => k.startsWith('test_withdraw('))!;
    tests[key] = { ...tests[key]!, status: 'Failure', reason: 'EVM error; database error: failed to get account: error sending request for url (https://RPC.example.org/SecretKey123/)' };
    const forge = await fakeForge(root, doc, opts);
    const reportDir = path.join(root, 'out');
    const input = {
      standard: 'erc4626' as const,
      address: VAULT,
      rpcUrl: RPC,
      blockNumber: 42n,
      runs: 3,
      client: client({ code: CODE, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603' }),
      cacheDir: path.join(root, 'cache'),
      forgeBin: forge.bin,
      recordPath: path.join(reportDir, '42.json'),
      rawPath: path.join(reportDir, '42.forge.json'),
      pins: { upstream: { repo: up.url, commit: up.shas[0]! }, forgeStd: { repo: std.url, commit: std.shas[0]! } },
    };
    return { forge, input, reportDir };
  }
  const recorded = async (f: string) => JSON.parse(await readFile(f, 'utf8')) as { args: string[]; env: Record<string, string>; cwd: string };
  const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

  it('passes and records a random seed and sender, the forge version, forge-std and foundry.toml hashes', async () => {
    const { forge, input } = await setup();
    const forgeEvents: Array<{ seed: string; sender: string; args: string[] }> = [];
    const report = await runStandardCheck({ ...input, onEvent: (e) => void (e.type === 'check-forge' && forgeEvents.push(e)) });
    const { args } = await recorded(forge.record);
    expect(argAfter(args, '--fuzz-seed')).toMatch(/^0x[0-9a-f]{64}$/);
    expect(report.seed).toBe(argAfter(args, '--fuzz-seed'));
    expect(report.sender).toBe(argAfter(args, '--sender'));
    expect(BigInt(report.sender!)).toBeGreaterThan(0xffffn);
    expect(argAfter(args, '--fork-url')).toBe(RPC);
    expect(argAfter(args, '--fork-block-number')).toBe('42');
    expect(report.toolchain).toEqual({
      forgeVersion: 'forge Version: 1.5.1-fake',
      forgeStd: input.pins.forgeStd,
      foundryTomlSha256: sha256Hex(ERC4626_FOUNDRY_TOML),
      maxTestRejects: 4096,
    });
    // Both the upstream suite (through the harness) and Specfirst's own properties run; the control does not.
    expect(argAfter(args, '--match-contract')).toBe('^(SpecfirstERC4626Test|SpecfirstMaxHonored)$');
    expect(forgeEvents[0]!.args).toContain('<rpc>');
    expect(forgeEvents[0]!.args.join(' ')).not.toMatch(/secretkey123/i);

    const second = await runStandardCheck(input);
    expect(second.seed).not.toBe(report.seed);
    expect(second.sender).not.toBe(report.sender);
    const fixed = await runStandardCheck({ ...input, seed: 7n, sender: '0x00000000000000000000000000000000000abcde' });
    expect(fixed.seed).toBe(`0x${'0'.repeat(63)}7`);
    expect(argAfter((await recorded(forge.record)).args, '--sender')).toBe('0x00000000000000000000000000000000000abcde');
  });

  it('share() that names the vault itself, or answers zero, is a plain ERC-4626 vault: forge runs', async () => {
    const { forge, input } = await setup();
    for (const share of [VAULT, '0x0000000000000000000000000000000000000000' as Address]) {
      await rm(forge.record, { force: true });
      const report = await runStandardCheck({ ...input, client: client({ code: CODE, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', share }) });
      expect(existsSync(forge.record)).toBe(true);
      expect(report).toMatchObject({ schemaVersion: 3, vaultKind: 'erc4626', skipReason: null });
      expect(report.results.find((r) => r.id === 'asset')!.status).toBe('pass');
    }
  });

  it('share() that reverts (no such function) is a plain ERC-4626 vault: forge runs', async () => {
    const { forge, input } = await setup();
    const report = await runStandardCheck({ ...input, client: client({ code: CODE, asset: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603', share: new Error('execution reverted') }) });
    expect(existsSync(forge.record)).toBe(true);
    expect(report.vaultKind).toBe('erc4626');
  });

  it('M6: forge sees a minimal environment without the caller FOUNDRY_* or ETH_RPC_URL', async () => {
    const { forge, input } = await setup();
    Object.assign(process.env, { FOUNDRY_FUZZ_RUNS: '1', FOUNDRY_PROFILE: 'evil', ETH_RPC_URL: 'http://evil', UNRELATED_SECRET: 's' });
    await runStandardCheck(input);
    const { env, cwd } = await recorded(forge.record);
    const keys = Object.keys(env);
    expect(keys.filter((k) => k.startsWith('FOUNDRY_'))).toEqual(['FOUNDRY_FUZZ_FAILURE_PERSIST_DIR']);
    expect(keys).not.toContain('ETH_RPC_URL');
    expect(keys).not.toContain('UNRELATED_SECRET');
    expect(env).toMatchObject({ SF_VAULT: VAULT, SF_DELTA: '0' });
    expect(env.SF_RUN_ID).toMatch(/^\d+-\d+-[0-9a-f]{8}$/);
    expect(path.basename(cwd)).toMatch(/^erc4626-[0-9a-f]{12}-[0-9a-f]{12}$/);
  });

  it('L3 + L6 + L7: counts deposit reverts, masks the RPC everywhere, stores only the JSON document next to the report', async () => {
    const { input, reportDir } = await setup();
    const report = await runStandardCheck(input);
    const byId = new Map(report.results.map((r) => [r.id, r]));
    expect(byId.get('deposit')!.reason).toBe('deposit reverted below maxDeposit 2 times (inputs discarded, EIP-4626 says it must not revert)');
    expect(byId.get('deposit')!.status).toBe('pass');
    expect(byId.get('withdraw')!.status).toBe('inconclusive');
    expect(byId.get('withdraw')!.reason).toContain('(<rpc>)');
    const raw = await readFile(input.rawPath, 'utf8');
    expect(raw.startsWith('{')).toBe(true);
    expect(Object.keys(JSON.parse(raw))).toEqual(['test/LiveVault.t.sol:LiveVaultTest']);
    expect(raw).not.toMatch(/secretkey123|rpc\.example\.org|sharedbackend/i);
    expect(await readFile(input.recordPath, 'utf8')).not.toMatch(/secretkey123|rpc\.example\.org/i);
    expect((await readdir(reportDir)).sort()).toEqual(['42.forge.json', '42.json']);
    const { cwd } = await recorded(path.join(root!, 'record.json'));
    expect(await readdir(path.join(cwd, 'sf-events'))).toEqual([]);
    expect(standardCheckReportSchema.parse(JSON.parse(await readFile(input.recordPath, 'utf8')))).toEqual(report);
  });

  it('forge output without JSON: the error carries the masked stderr and nothing is written', async () => {
    const { input } = await setup({ noJson: true });
    const err = (await runStandardCheck(input).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(StandardCheckError);
    expect(err.message).toMatch(/forge produced no test results \(exit 1\): Error: could not instantiate forked environment with provider <rpc>/);
    expect(existsSync(input.recordPath)).toBe(false);
    expect(existsSync(input.rawPath)).toBe(false);
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
    sfPropertiesSha256: `0x${'ac'.repeat(32)}`,
    runs: 8,
    delta: '0',
    seed: `0x${'0a'.repeat(32)}`,
    sender: '0x00000000000000000000000000000000000abcde',
    toolchain: { forgeVersion: 'forge Version: 1.5.1-Homebrew', forgeStd: { repo: FORGE_STD_PIN.repo, commit: FORGE_STD_PIN.commit }, foundryTomlSha256: `0x${'0b'.repeat(32)}`, maxTestRejects: 4096 },
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

  it('schema version 1 reports without vaultKind still validate; version 2 needs it', () => {
    expect(standardCheckReportSchema.parse(valid()).schemaVersion).toBe(1);
    expect(() => standardCheckReportSchema.parse({ ...valid(), vaultKind: 'erc4626' })).toThrow(/vaultKind does not exist in schemaVersion 1/);
    expect(() => standardCheckReportSchema.parse({ ...valid(), schemaVersion: 2 })).toThrow(/vaultKind is required from schemaVersion 2 on/);
    expect(standardCheckReportSchema.parse({ ...valid(), schemaVersion: 2, vaultKind: 'erc7575' }).vaultKind).toBe('erc7575');
    expect(() => standardCheckReportSchema.parse({ ...valid(), schemaVersion: 2, vaultKind: 'erc20' })).toThrow();
  });

  it('schema version 3 needs skipReason (null when properties ran); earlier versions must not carry it', () => {
    const v3 = { ...valid(), schemaVersion: 3, vaultKind: 'erc4626' };
    expect(() => standardCheckReportSchema.parse(v3)).toThrow(/skipReason \(null when properties ran\) is required from schemaVersion 3 on/);
    expect(standardCheckReportSchema.parse({ ...v3, skipReason: null }).skipReason).toBeNull();
    expect(standardCheckReportSchema.parse({ ...v3, skipReason: 'asset-transfer-restricted' }).skipReason).toBe('asset-transfer-restricted');
    expect(() => standardCheckReportSchema.parse({ ...v3, skipReason: 'other' })).toThrow();
    expect(() => standardCheckReportSchema.parse({ ...valid(), schemaVersion: 2, vaultKind: 'erc4626', skipReason: null })).toThrow(/skipReason does not exist in schemaVersion 2/);
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
    expect(() => standardCheckReportSchema.parse({ ...valid(), schemaVersion: 4 })).toThrow();
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
