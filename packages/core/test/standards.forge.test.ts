import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  defaultCacheDir,
  depositRevertCounts,
  ERC4626_PROPERTIES,
  ERC4626_UPSTREAM,
  EVENTS_DIR,
  FORGE_STD_PIN,
  forgeEnv,
  parseStandardForgeJson,
  prepareErc4626Workspace,
  runStandardCheck,
  standardCheckExitCode,
  summarize,
  type StandardWorkspace,
} from '../src/index.js';
import { SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** A clean checkout of `commit` under <cache>/standards/<any>/lib/<name>, or null. Read only. */
function cachedCheckout(cacheDir: string, name: string, commit: string): string | null {
  const standards = path.join(cacheDir, 'standards');
  if (!existsSync(standards)) return null;
  for (const d of readdirSync(standards)) {
    const dir = path.join(standards, d, 'lib', name);
    if (!existsSync(path.join(dir, '.git'))) continue;
    try {
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
      const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: dir }).toString().trim();
      if (head === commit && dirty === '') return dir;
    } catch {
      /* not a usable checkout */
    }
  }
  return null;
}

const CACHE = defaultCacheDir();
const UPSTREAM = cachedCheckout(CACHE, 'erc4626-tests', ERC4626_UPSTREAM.commit);
const FORGE_STD = cachedCheckout(CACHE, 'forge-std', FORGE_STD_PIN.commit);
const SKIP = !UPSTREAM || !FORGE_STD || process.env.SPECFIRST_SKIP_FORGE === '1';

/**
 * Offline: compiles the shipped harness against the pinned upstream and forge-std, and runs it against
 * local mock vaults (fixtures/standards/review). Runs only when a pinned checkout is already in the cache
 * ($SPECFIRST_CACHE_DIR or the default); the cache is only read, the workspace is a fresh temp directory.
 */
describe.skipIf(SKIP)('ERC-4626 harness with forge, offline (pinned cache present)', { timeout: 300_000 }, () => {
  let root: string;
  let ws: StandardWorkspace;
  const forge = (args: string[]) =>
    execa('forge', args, { cwd: ws.dir, env: forgeEnv({ SF_RUN_ID: 'offline-test' }), extendEnv: false, reject: false, maxBuffer: 256 * 1024 * 1024 });

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-harness-'));
    ws = await prepareErc4626Workspace({
      cacheDir: root,
      upstream: { repo: `file://${UPSTREAM}`, commit: ERC4626_UPSTREAM.commit },
      forgeStd: { repo: `file://${FORGE_STD}`, commit: FORGE_STD_PIN.commit },
    });
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('the harness, the positive control and the control vault compile', async () => {
    const p = await forge(['build', '--offline']);
    expect(p.exitCode, String(p.stderr)).toBe(0);
    for (const f of ['SpecfirstERC4626.t.sol/SpecfirstERC4626Test.json', 'SpecfirstERC4626Control.t.sol/SpecfirstERC4626Control.json', 'BrokenVault.sol/BrokenVault.json']) {
      expect(existsSync(path.join(ws.dir, 'out', f)), f).toBe(true);
    }
  });

  it('mock vaults: maxDeposit revert fails maxDeposit only, packed balances are funded, decimals falls back, deposit reverts are recorded', async () => {
    await copyFile(path.join(here, 'fixtures/standards/review/M.sol'), path.join(ws.dir, 'src/M.sol'));
    await copyFile(path.join(here, 'fixtures/standards/review/Exp.t.sol'), path.join(ws.dir, 'test/Exp.t.sol'));
    const paused = await forge(['test', '--offline', '--match-contract', '^ModePaused$', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    const results = parseStandardForgeJson(String(paused.stdout), ERC4626_PROPERTIES)!;
    expect(results.filter((r) => r.status !== 'pass').map((r) => [r.id, r.status, r.reason])).toEqual([['maxDeposit', 'fail', 'paused']]);

    const packed = await forge(['test', '--offline', '--match-contract', '^ModePackedAsset$', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    expect(summarize(parseStandardForgeJson(String(packed.stdout), ERC4626_PROPERTIES)!)).toEqual({ pass: 26, fail: 0, inconclusive: 0, notApplicable: 0 });

    const decimals = await forge(['test', '--offline', '--match-contract', '^DecimalsFallback$', '--match-test', 'test_decimalsFallback', '--json']);
    expect(decimals.exitCode, String(decimals.stdout)).toBe(0);

    const closed = await forge(['test', '--offline', '--match-contract', '^ModeDepositRevertsBelowMax$', '--match-test', 'test_deposit\\(', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    const events = await readFile(path.join(ws.dir, EVENTS_DIR, 'offline-test.deposit-below-max.log'), 'utf8');
    const keys = Object.keys((Object.values(JSON.parse(String(closed.stdout))) as Array<{ test_results: object }>)[0]!.test_results);
    expect(depositRevertCounts(events, keys).get('test_deposit')).toBeGreaterThan(1000);
  });
});

/**
 * Offline end to end: runStandardCheck with the real forge and harness against contracts placed on a local
 * anvil with anvil_setCode (no transaction, no key), forked at block 1. Same cache gate as above.
 */
describe.skipIf(SKIP || SKIP_ANVIL)('runStandardCheck on a local anvil fork (pinned cache present)', { timeout: 300_000 }, () => {
  let root: string;
  let anvil: Anvil;
  const code: Record<string, string> = {};
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(anvil.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-e2e-'));
    // Compile the fixture contracts in their own Foundry project to get runtime code.
    const mocks = path.join(root, 'mocks');
    await mkdir(path.join(mocks, 'src'), { recursive: true });
    await copyFile(path.join(here, 'fixtures/standards/mock-vaults.sol'), path.join(mocks, 'src/MockVaults.sol'));
    await writeFile(path.join(mocks, 'foundry.toml'), '[profile.default]\nsrc = "src"\nsolc_version = "0.8.28"\nevm_version = "prague"\n');
    const built = await execa('forge', ['build', '--offline'], { cwd: mocks, env: forgeEnv({}), extendEnv: false, reject: false });
    if (built.exitCode !== 0) throw new Error(String(built.stderr));
    for (const name of ['PackedToken', 'PackedAssetVault', 'ComputedToken', 'ComputedAssetVault']) {
      const art = JSON.parse(await readFile(path.join(mocks, 'out/MockVaults.sol', `${name}.json`), 'utf8')) as { deployedBytecode: { object: string } };
      code[name] = art.deployedBytecode.object;
    }
    anvil = await startAnvil();
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000003', code.PackedToken]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000021', code.PackedAssetVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000002', code.ComputedToken]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000013', code.ComputedAssetVault]);
    await rpc('anvil_mine', ['0x1']);
  });
  afterAll(async () => {
    await anvil?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const check = (address: `0x${string}`) =>
    runStandardCheck({
      standard: 'erc4626',
      address,
      rpcUrl: anvil.url,
      blockNumber: 1n,
      runs: 4,
      cacheDir: path.join(root, 'cache'),
      pins: {
        upstream: { repo: `file://${UPSTREAM}`, commit: ERC4626_UPSTREAM.commit },
        forgeStd: { repo: `file://${FORGE_STD}`, commit: FORGE_STD_PIN.commit },
      },
      recordPath: path.join(root, 'reports', `${address}.json`),
      rawPath: path.join(root, 'reports', `${address}.forge.json`),
    });

  it('a vault over a packed-balance token (AUSD shape) passes all 26 through the packed fallback, exit 0', async () => {
    const report = await check('0x5F00000000000000000000000000000000000021');
    expect(report.summary).toEqual({ pass: 26, fail: 0, inconclusive: 0, notApplicable: 0 });
    expect(standardCheckExitCode(report.summary)).toBe(0);
    expect(report.toolchain.forgeVersion).toMatch(/^forge Version: /);
    expect(report.seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(path.join(root, 'reports', '0x5F00000000000000000000000000000000000021.forge.json'))).toBe(true);
  });

  it('a vault over a token without storage balances is inconclusive, exit 17', async () => {
    const report = await check('0x5f00000000000000000000000000000000000013');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 26, notApplicable: 0 });
    expect(report.results[0]!.reason).toMatch(/^the asset's balance slot cannot be written, test users cannot be funded \(non-standard token\): stdStorage /);
    expect(standardCheckExitCode(report.summary)).toBe(17);
  });
});
