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
  SPECFIRST_ERC4626_PROPERTIES,
  standardCheckExitCode,
  RESTRICTED_ASSET_NOTE,
  MISSING_PRECOMPILE_NOTE,
  missingPrecompileNote,
  maxZeroNote,
  belowBoundNote,
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
    for (const f of [
      'SpecfirstERC4626.t.sol/SpecfirstERC4626Test.json',
      'SpecfirstMaxHonored.t.sol/SpecfirstMaxHonored.json',
      'SpecfirstERC4626Control.t.sol/SpecfirstERC4626Control.json',
      'BrokenVault.sol/BrokenVault.json',
    ]) {
      expect(existsSync(path.join(ws.dir, 'out', f)), f).toBe(true);
    }
  });

  it('mock vaults: maxDeposit revert fails maxDeposit only, packed balances are funded, decimals falls back, the transfer probe restores state, the precompile analysis and re-entry guard hold, deposit reverts are recorded', async () => {
    await copyFile(path.join(here, 'fixtures/standards/review/M.sol'), path.join(ws.dir, 'src/M.sol'));
    await copyFile(path.join(here, 'fixtures/standards/review/Exp.t.sol'), path.join(ws.dir, 'test/Exp.t.sol'));
    const paused = await forge(['test', '--offline', '--match-contract', '^ModePaused$', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    const results = parseStandardForgeJson(String(paused.stdout), ERC4626_PROPERTIES)!;
    expect(results.filter((r) => r.status !== 'pass').map((r) => [r.id, r.status, r.reason])).toEqual([['maxDeposit', 'fail', 'paused']]);

    const packed = await forge(['test', '--offline', '--match-contract', '^ModePackedAsset$', '--fuzz-runs', '8', '--fuzz-seed', '0x1', '--json', '-vv']);
    expect(summarize(parseStandardForgeJson(String(packed.stdout), ERC4626_PROPERTIES)!)).toEqual({ pass: 26, fail: 0, inconclusive: 0, notApplicable: 0 });

    const decimals = await forge(['test', '--offline', '--match-contract', '^DecimalsFallback$', '--match-test', 'test_decimalsFallback', '--json']);
    expect(decimals.exitCode, String(decimals.stdout)).toBe(0);

    // The transfer probe of both setUps (the only probe): leaves no state behind, refuses a token nobody may move.
    const probes = await forge(['test', '--offline', '--match-contract', '^(ProbeState|SfProbeState)$', '--match-test', '[pP]robe', '--json']);
    const probeResults = Object.values(JSON.parse(String(probes.stdout)) as Record<string, { test_results: Record<string, { status: string }> }>).flatMap((x) =>
      Object.entries(x.test_results).map(([k, v]) => [k.split('(')[0], v.status]),
    );
    expect(probeResults.sort()).toEqual([
      ['test_probeLeavesNoState', 'Success'],
      ['test_probeRejectsFalseTransfer', 'Success'],
      ['test_probeRejectsLockedToken', 'Success'],
      ['test_sfProbeLeavesNoState', 'Success'],
      ['test_sfProbeRejectsLockedToken', 'Success'],
    ]);

    // SfForkGaps.precompileCause on Monad's chain ids, and the re-entry guard of SfEvents and setUp.
    const gaps = await forge(['test', '--offline', '--match-contract', '^(ForkGaps|GuardedSetUp)$', '--match-test', '^test_(gaps|cause|missingCalled|events|setUpRefuses)', '--json']);
    const gapResults = Object.values(JSON.parse(String(gaps.stdout)) as Record<string, { test_results: Record<string, { status: string }> }>).flatMap((x) =>
      Object.entries(x.test_results).map(([k, v]) => [k.split('(')[0], v.status]),
    );
    expect(gapResults.sort()).toEqual([
      ['test_causeIsNoneOffMonad', 'Success'],
      ['test_causeIsNoneWithoutAPrecompile', 'Success'],
      ['test_causeIsThePrecompileForAnEmptyRevert', 'Success'],
      ['test_causeIsThePrecompileWhateverTheRevert', 'Success'],
      ['test_causeIsTheStakingPrecompileForAStakingDeposit', 'Success'],
      ['test_causeIsTheStakingPrecompileForAnEpochGuard', 'Success'],
      ['test_eventsRefuseACallFromInsideAVault', 'Success'],
      ['test_gapsLeaveOutAPrecompileThisEvmHas', 'Success'],
      ['test_gapsListedOnMonadChainsOnly', 'Success'],
      ['test_missingCalledSeesCallsInRevertedFrames', 'Success'],
      ['test_setUpRefusesReentry', 'Success'],
    ]);

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
    for (const name of [
      'MockToken',
      'PackedToken',
      'PackedAssetVault',
      'ComputedToken',
      'ComputedAssetVault',
      'HonouringVault',
      'AsyncExitVault',
      'HonestClosedExitVault',
      'SplitShareToken',
      'SplitShareVault',
      'SelfShareVault',
      'ZeroMaxVault',
      'AllowlistToken',
      'RecipientAllowlistToken',
      'RestrictedAssetVault',
      'PartialRestrictedVault',
      'PrecompileVault',
      'FakePrecompileTextVault',
      'FakePrecompileSetupVault',
      'MintSurchargeVault',
      'AsyncRedeemVault',
      'SelectorOnlyVault',
      'PrecompileAsyncVault',
      'FeeVault',
      'FeeTouchVault',
      'ProbeKillVault',
      'ProbeKillControl',
      'WindowVault',
      'ReenterVault',
      'LyingMintVault',
      'FeeLaunderVault',
      'HonestDynVault',
      'EpochGuardVault',
      'ThresholdPrecompileVault',
    ]) {
      const art = JSON.parse(await readFile(path.join(mocks, 'out/MockVaults.sol', `${name}.json`), 'utf8')) as { deployedBytecode: { object: string } };
      code[name] = art.deployedBytecode.object;
    }
    // Monad's chain id: SfForkGaps only treats 0x0100, 0x1000 and 0x1001 as missing precompiles on 143 and 10143.
    anvil = await startAnvil(['--chain-id', '143']);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000003', code.PackedToken]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000021', code.PackedAssetVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000002', code.ComputedToken]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000013', code.ComputedAssetVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000001', code.MockToken]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000031', code.HonouringVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000032', code.AsyncExitVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000033', code.HonestClosedExitVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000041', code.SplitShareToken]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000042', code.SplitShareVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000043', code.SelfShareVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000051', code.ZeroMaxVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000004', code.AllowlistToken]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000005', code.RecipientAllowlistToken]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000061', code.RestrictedAssetVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000062', code.PartialRestrictedVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000071', code.PrecompileVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000073', code.FakePrecompileTextVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000074', code.FakePrecompileSetupVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000075', code.MintSurchargeVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000081', code.AsyncRedeemVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000082', code.SelectorOnlyVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000083', code.PrecompileAsyncVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000091', code.FeeVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000092', code.FeeTouchVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000093', code.ProbeKillVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000094', code.ProbeKillControl]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000095', code.WindowVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000096', code.ReenterVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000097', code.LyingMintVault]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000098', code.FeeLaunderVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000099', code.HonestDynVault]);
    await rpc('anvil_setCode', ['0x5F0000000000000000000000000000000000009a', code.EpochGuardVault]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000072', code.ThresholdPrecompileVault]);
    await rpc('anvil_mine', ['0x1']);
  });
  afterAll(async () => {
    await anvil?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const check = (address: `0x${string}`, runs = 4) =>
    runStandardCheck({
      standard: 'erc4626',
      address,
      rpcUrl: anvil.url,
      blockNumber: 1n,
      runs,
      seed: 1n,
      cacheDir: path.join(root, 'cache'),
      pins: {
        upstream: { repo: `file://${UPSTREAM}`, commit: ERC4626_UPSTREAM.commit },
        forgeStd: { repo: `file://${FORGE_STD}`, commit: FORGE_STD_PIN.commit },
      },
      recordPath: path.join(root, 'reports', `${address}.json`),
      rawPath: path.join(root, 'reports', `${address}.forge.json`),
    });

  it('a vault over a packed-balance token (AUSD shape) passes all 30 through the packed fallback, exit 0', async () => {
    const report = await check('0x5F00000000000000000000000000000000000021');
    expect(report.summary).toEqual({ pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 });
    expect(report.toolchain.maxTestRejects).toBe(4096);
    expect(standardCheckExitCode(report.summary)).toBe(0);
    expect(report.toolchain.forgeVersion).toMatch(/^forge Version: /);
    expect(report.seed).toMatch(/^0x[0-9a-f]{64}$/);
    expect(existsSync(path.join(root, 'reports', '0x5F00000000000000000000000000000000000021.forge.json'))).toBe(true);
  });

  it('a vault over a token without storage balances is inconclusive, exit 17', async () => {
    const report = await check('0x5f00000000000000000000000000000000000013');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 30, notApplicable: 0 });
    expect(report.results[0]!.reason).toMatch(/^the asset's balance slot cannot be written, test users cannot be funded \(non-standard token\): stdStorage /);
    expect(standardCheckExitCode(report.summary)).toBe(17);
  });

  it('ERC-7575 vault (shares in a separate token): forge is skipped, 30 not_applicable, exit 17', async () => {
    const events: string[] = [];
    const report = await runStandardCheck({
      standard: 'erc4626',
      address: '0x5F00000000000000000000000000000000000042',
      rpcUrl: anvil.url,
      blockNumber: 1n,
      runs: 4,
      cacheDir: path.join(root, 'cache-7575'),
      rawPath: path.join(root, 'reports', '7575.forge.json'),
      onEvent: (e) => void events.push(e.type),
    });
    expect(report.vaultKind).toBe('erc7575');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(report.results[0]!.reason).toMatch(/^ERC-7575 vault: shares are a separate token \(share\(\) = 0x5f0+41\)/);
    expect(standardCheckExitCode(report.summary)).toBe(17);
    expect(events).not.toContain('check-workspace');
    expect(existsSync(path.join(root, 'reports', '7575.forge.json'))).toBe(false);
  });

  it('share() that returns the vault itself is a plain ERC-4626 vault: forge runs, all 30 pass', async () => {
    const report = await check('0x5f00000000000000000000000000000000000043');
    expect(report.vaultKind).toBe('erc4626');
    expect(report.summary).toEqual({ pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 });
  });

  it('max values of 0 for everyone (Morpho Vault V2 shape): the 26 upstream properties pass, the sf- ones are not_applicable, exit 17', async () => {
    const report = await check('0x5F00000000000000000000000000000000000051');
    expect(report.summary).toEqual({ pass: 26, fail: 0, inconclusive: 0, notApplicable: 4 });
    expect(report.results.slice(0, 26).every((r) => r.status === 'pass')).toBe(true);
    expect(report.results.slice(26).map((r) => r.reason)).toEqual(['maxDeposit', 'maxMint', 'maxWithdraw', 'maxRedeem'].map(maxZeroNote));
    expect(report.skipReason).toBeNull();
    expect(standardCheckExitCode(report.summary)).toBe(17);
  });

  it('an asset nobody may transfer (Valos vUSD shape): both setUps stop, 30 not_applicable, exit 17', async () => {
    const report = await check('0x5F00000000000000000000000000000000000061');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(report.skipReason).toBe('asset-transfer-restricted');
    expect(report.results[0]!.reason).toBe(`${RESTRICTED_ASSET_NOTE} (selector 0x82b42900)`);
    expect(standardCheckExitCode(report.summary)).toBe(17);
  });

  it('an asset only the vault may receive (deposits work, withdrawals fail in the token): 30 not_applicable, exit 17', async () => {
    const report = await check('0x5F00000000000000000000000000000000000062');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(report.skipReason).toBe('asset-transfer-restricted');
  });

  it('a vault that deposits through Monad staking (gMON shape): every input needed the precompile, 30 inconclusive, skipReason missing-precompile, exit 17', async () => {
    const report = await check('0x5f00000000000000000000000000000000000071');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 30, notApplicable: 0 });
    expect(new Set(report.results.map((r) => r.reason))).toEqual(new Set([missingPrecompileNote('0x0000000000000000000000000000000000001000')]));
    expect(report.skipReason).toBe('missing-precompile');
    expect(standardCheckExitCode(report.summary)).toBe(17);
    // No request function in its code and no ERC-165: no async-redeem trait.
    expect(report.traits).toEqual([]);
  });

  it('a vault that reverts with precompile-sounding text but calls no precompile keeps its fails', async () => {
    const report = await check('0x5f00000000000000000000000000000000000073');
    const r = new Map(report.results.map((x) => [x.id, x]));
    // test_maxMint calls maxMint directly, so the vault's own text is forge's reason; text never classifies.
    expect(r.get('maxMint')).toMatchObject({ status: 'fail', reason: 'specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)' });
    // The sf- reason never carries revert text: the selector of Error(string) and the max, so it stays fail too.
    expect(r.get('sf-maxWithdraw-honored')!.status).toBe('fail');
    expect(r.get('sf-maxWithdraw-honored')!.reason).toMatch(/^withdraw\(\d+\) reverted with selector 0x08c379a0 while maxWithdraw is \d+$/);
    expect(report.results.some((x) => x.reason?.startsWith(MISSING_PRECOMPILE_NOTE))).toBe(false);
    expect(report.skipReason).toBeNull();
    expect(standardCheckExitCode(report.summary)).toBe(16);
  });

  it('a setUp revert with precompile-sounding text is setup-reverted, not inconclusive', async () => {
    const report = await check('0x5F00000000000000000000000000000000000074');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 30 });
    expect(report.results[0]!.reason).toBe('setUp failed: specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)');
    expect(report.skipReason).toBe('setup-reverted');
  });

  // Review PoCs (mock-vaults.sol, "Review PoCs").
  it('ProbeKillVault (reverts only for the old probe amount after touching 0x1001): it fails like its control, nothing stops the suites', async () => {
    // 16 runs, as in the review: enough for the fuzzer to reach the fee bug in both.
    const pk = await check('0x5f00000000000000000000000000000000000093', 16);
    const control = await check('0x5F00000000000000000000000000000000000094', 16);
    const failed = (rep: typeof pk) => rep.results.filter((x) => x.status === 'fail').map((x) => x.id);
    for (const rep of [pk, control]) expect(failed(rep)).toEqual(expect.arrayContaining(['previewWithdraw', 'sf-maxWithdraw-honored']));
    expect(pk.summary.inconclusive).toBe(0);
    expect(pk.skipReason).toBeNull();
    expect(pk.results.some((x) => (x.reason ?? '').includes(MISSING_PRECOMPILE_NOTE))).toBe(false);
  });

  it('FeeTouchVault (a fee bug plus an ignored staticcall to 0x1001): its reverting withdraws are not judged, so sf-maxWithdraw is inconclusive, never a pass', async () => {
    const touch = await check('0x5F00000000000000000000000000000000000092', 16);
    const plain = await check('0x5F00000000000000000000000000000000000091', 16);
    const sf = (rep: typeof touch) => rep.results.find((x) => x.id === 'sf-maxWithdraw-honored')!;
    expect(sf(plain).status).toBe('fail');
    expect(sf(plain).reason).toMatch(/^withdraw\(\d+\) reverted with selector 0x4e487b71 while maxWithdraw is \d+$/);
    expect(sf(plain).counterexample?.calls.length).toBe(1);
    // Every withdraw touches 0x1001, so a reverting one cannot be judged; the withdraws that went through passed.
    expect(sf(touch).status).toBe('inconclusive');
    expect(sf(touch).reason).toMatch(/^a vault call reached Monad precompile 0x0000000000000000000000000000000000001001, which forge lacks(, in \d+ inputs)?; these inputs were not judged$/);
    // A call that touched 0x1001 and went through is judged on its result: previewWithdraw still fails.
    expect(touch.results.find((x) => x.id === 'previewWithdraw')!.status).toBe('fail');
    expect(standardCheckExitCode(touch.summary)).toBe(16);
  });

  it('FeeLaunderVault (withdraw does nothing when 0x1001 has code): sf-maxWithdraw is never a pass', async () => {
    const report = await check('0x5F00000000000000000000000000000000000098', 16);
    const x = report.results.find((r) => r.id === 'sf-maxWithdraw-honored')!;
    expect(x.status).not.toBe('pass');
    // Every withdraw at the bound reaches 0x1001 and reverts, so the inputs are not judged (with or without a count).
    expect(x.reason).toMatch(/a vault call reached Monad precompile 0x0000000000000000000000000000000000001001, which forge lacks(, in \d+ inputs)?; these inputs were not judged/);
    expect(standardCheckExitCode(report.summary)).not.toBe(0);
    // FeeVault, the same bug without the trick, fails it outright.
    const plain = await check('0x5F00000000000000000000000000000000000091', 16);
    expect(plain.results.find((r) => r.id === 'sf-maxWithdraw-honored')!.status).toBe('fail');
  });

  it('HonestDynVault (reads a dynamic answer from the staking precompile, works on Monad): no fail, the deposit inputs are not judged', async () => {
    const report = await check('0x5f00000000000000000000000000000000000099');
    expect(report.summary.fail).toBe(0);
    const x = report.results.find((r) => r.id === 'sf-maxDeposit-honored')!;
    expect(x.status).toBe('inconclusive');
    expect(x.reason).toMatch(/^a vault call reached Monad precompile 0x0000000000000000000000000000000000001000, which forge lacks/);
    expect(standardCheckExitCode(report.summary)).toBe(17);
  });

  it('EpochGuardVault (InvalidEpoch() for a malformed or stale getEpoch answer, works on Monad): no fail, the deposit inputs are not judged', async () => {
    const report = await check('0x5F0000000000000000000000000000000000009a');
    expect(report.summary.fail).toBe(0);
    const x = report.results.find((r) => r.id === 'sf-maxDeposit-honored')!;
    expect(x.status).toBe('inconclusive');
    expect(x.reason).toMatch(/^a vault call reached Monad precompile 0x0000000000000000000000000000000000001000, which forge lacks/);
    expect(standardCheckExitCode(report.summary)).toBe(17);
  });

  it('ThresholdPrecompileVault, full check: inputs rejected in the setup deposit do not touch the upstream properties, which pass', async () => {
    const report = await check('0x5f00000000000000000000000000000000000072');
    expect(report.summary.fail).toBe(0);
    expect(report.results.slice(0, 26).filter((r) => r.status !== 'pass').map((r) => r.id)).toEqual([]);
    expect(report.results.slice(0, 26).some((r) => r.reason !== undefined)).toBe(false);
  });

  it('WindowVault (refuses 500,000 to 1,000,000 tokens, accepts the bound): sf-maxDeposit passes and counts the refusals below the bound', async () => {
    const report = await check('0x5F00000000000000000000000000000000000095');
    const x = report.results.find((r) => r.id === 'sf-maxDeposit-honored')!;
    expect(x.status).toBe('pass');
    const n = Number(/^(\d+) amounts below the bound were refused/.exec(x.reason ?? '')?.[1]);
    expect(n).toBeGreaterThan(0);
    expect(x.reason).toBe(belowBoundNote(n));
    expect(x.reason).not.toMatch(/minimum/);
  });

  it('LyingMintVault (mint pulls more than it returns): test_mint fails; twice the quote in funding hides nothing', async () => {
    const report = await check('0x5F00000000000000000000000000000000000097');
    const r = new Map(report.results.map((x) => [x.id, x]));
    expect(r.get('mint')!.status).toBe('fail');
    expect(r.get('sf-maxMint-honored')!.status).toBe('pass');
  });

  it('ReenterVault (calls setUp and an sf- property back from its deposit): the guard refuses, no event is planted, 30 pass', async () => {
    const report = await check('0x5f00000000000000000000000000000000000096');
    expect(report.summary).toEqual({ pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 });
    expect(report.results.every((x) => x.reason === undefined)).toBe(true);
  });

  it('mint pulls more than previewMint quotes: previewMint fails, sf-maxMint-honored passes (funded at twice the quote)', async () => {
    const report = await check('0x5f00000000000000000000000000000000000075');
    const r = new Map(report.results.map((x) => [x.id, x]));
    expect(r.get('previewMint')!.status).toBe('fail');
    expect(r.get('sf-maxMint-honored')!.status).toBe('pass');
  });

  it('a vault without share() is a plain ERC-4626 vault: forge runs', async () => {
    const report = await check('0x5F00000000000000000000000000000000000031');
    expect(report.vaultKind).toBe('erc4626');
    expect(report.summary.pass).toBe(30);
    expect(report.schemaVersion).toBe(4);
    expect(report.traits).toEqual([]);
  });

  it('asynchronous exits (Upshift shape, requestRedeem in the code): async-redeem trait, and the same fails as without it', async () => {
    const asyncVault = await check('0x5f00000000000000000000000000000000000081');
    expect(asyncVault.traits).toEqual([
      {
        id: 'async-redeem',
        evidence: { codeAddress: '0x5f00000000000000000000000000000000000081', requestFunctions: ['requestRedeem(uint256,address,address)'], erc165: null, run: 'exits-rejected' },
      },
    ]);
    const r = new Map(asyncVault.results.map((x) => [x.id, x]));
    expect(r.get('sf-maxWithdraw-honored')!.reason).toMatch(/^withdraw\(\d+\) reverted with selector 0x75ed2e3e while maxWithdraw is [1-9]\d*$/);
    expect(r.get('sf-maxRedeem-honored')!.reason).toMatch(/^redeem\(\d+\) reverted with selector 0x75ed2e3e while maxRedeem is [1-9]\d*$/);
    expect(standardCheckExitCode(asyncVault.summary)).toBe(16);
    // AsyncExitVault behaves the same but has no request function: no trait, and the very same statuses.
    const plain = await check('0x5f00000000000000000000000000000000000032');
    expect(plain.traits).toEqual([]);
    expect(asyncVault.results.map((x) => [x.id, x.status])).toEqual(plain.results.map((x) => [x.id, x.status]));
    expect(asyncVault.summary).toEqual(plain.summary);
  });

  it('requestRedeem in the code while withdraw and redeem go through: no trait', async () => {
    const report = await check('0x5f00000000000000000000000000000000000082');
    expect(report.summary).toEqual({ pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 });
    expect(report.traits).toEqual([]);
  });

  it('gMON shape (deposits stop at the staking precompile, ERC-165 declares async redemption): trait from code and ERC-165, run not-exercised', async () => {
    const report = await check('0x5f00000000000000000000000000000000000083');
    expect(report.summary).toEqual({ pass: 0, fail: 0, inconclusive: 30, notApplicable: 0 });
    expect(report.skipReason).toBe('missing-precompile');
    expect(report.traits).toEqual([
      {
        id: 'async-redeem',
        evidence: {
          codeAddress: '0x5f00000000000000000000000000000000000083',
          requestFunctions: ['requestRedeem(uint256,address,address)'],
          erc165: { asyncRedeem: true, asyncDeposit: false, operator: false },
          run: 'not-exercised',
        },
      },
    ]);
  });
});

describe.skipIf(SKIP || SKIP_ANVIL)('Specfirst sf- properties on a local anvil fork (pinned cache present)', { timeout: 300_000 }, () => {
  // Its own anvil and contracts, forked at block 1; the same cache gate as above. forge runs the sf- suite
  // only, on two threads, so this stays light next to the other packages' tests under `pnpm -r test`.
  let root: string;
  let anvil: Anvil;
  let ws: StandardWorkspace;
  const rpc = async (method: string, params: unknown[]) => {
    const res = await fetch(anvil.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return ((await res.json()) as { result?: unknown }).result;
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-sf-'));
    const mocks = path.join(root, 'mocks');
    await mkdir(path.join(mocks, 'src'), { recursive: true });
    await copyFile(path.join(here, 'fixtures/standards/mock-vaults.sol'), path.join(mocks, 'src/MockVaults.sol'));
    await writeFile(path.join(mocks, 'foundry.toml'), '[profile.default]\nsrc = "src"\nsolc_version = "0.8.28"\nevm_version = "prague"\n');
    const built = await execa('forge', ['build', '--offline'], { cwd: mocks, env: forgeEnv({}), extendEnv: false, reject: false });
    if (built.exitCode !== 0) throw new Error(String(built.stderr));
    const code = async (n: string) => (JSON.parse(await readFile(path.join(mocks, 'out/MockVaults.sol', `${n}.json`), 'utf8')) as { deployedBytecode: { object: string } }).deployedBytecode.object;
    // Monad's chain id: SfForkGaps only treats 0x0100, 0x1000 and 0x1001 as missing precompiles on 143 and 10143.
    anvil = await startAnvil(['--chain-id', '143']);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000001', await code('MockToken')]);
    await rpc('anvil_setCode', ['0x5F00000000000000000000000000000000000031', await code('HonouringVault')]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000032', await code('AsyncExitVault')]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000033', await code('HonestClosedExitVault')]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000063', await code('HookBlockedVault')]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000072', await code('ThresholdPrecompileVault')]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000075', await code('MintSurchargeVault')]);
    await rpc('anvil_setCode', ['0x5f00000000000000000000000000000000000076', await code('MinDepositVault')]);
    await rpc('anvil_setCode', ['0x5f0000000000000000000000000000000000009b', await code('WithdrawFeeVault')]);
    await rpc('anvil_mine', ['0x1']);
    ws = await prepareErc4626Workspace({
      cacheDir: path.join(root, 'cache'),
      upstream: { repo: `file://${UPSTREAM}`, commit: ERC4626_UPSTREAM.commit },
      forgeStd: { repo: `file://${FORGE_STD}`, commit: FORGE_STD_PIN.commit },
    });
  });
  afterAll(async () => {
    await anvil?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const sf = async (vault: string, opts: { seed?: string; runs?: number } = {}) => {
    const runId = `sf-${vault.slice(-4)}-${opts.seed ?? '0x1'}`;
    // A fresh failure directory per call, as runStandardCheck uses: forge replays persisted failures first, so a
    // counterexample from one seed would otherwise decide the next seed's run.
    const persist = await mkdtemp(path.join(root, 'failures-'));
    const p = await execa(
      'forge',
      ['test', '--match-contract', '^SpecfirstMaxHonored$', '--fork-url', anvil.url, '--fork-block-number', '1', '--fuzz-runs', String(opts.runs ?? 8), '--fuzz-seed', opts.seed ?? '0x1', '-j', '2', '--json', '-vv'],
      { cwd: ws.dir, env: forgeEnv({ SF_VAULT: vault, SF_RUN_ID: runId, FOUNDRY_FUZZ_FAILURE_PERSIST_DIR: persist }), extendEnv: false, reject: false, maxBuffer: 256 * 1024 * 1024 },
    );
    const events = (kind: string) => readFile(path.join(ws.dir, EVENTS_DIR, `${runId}.${kind}.log`), 'utf8').catch(() => '');
    const results = parseStandardForgeJson(String(p.stdout), SPECFIRST_ERC4626_PROPERTIES, {
      maxZeroEvents: await events('max-zero'),
      belowBoundEvents: await events('below-bound'),
      missingPrecompileEvents: await events('missing-precompile'),
      setupPrecompileEvents: await events('setup-precompile'),
    });
    if (!results) throw new Error(String(p.stderr));
    return new Map(results.map((x) => [x.id, x]));
  };

  it('a 5 bps withdrawal fee that maxWithdraw ignores (sLVMON shape): sf-maxWithdraw fails at the bound itself with every seed', async () => {
    // Drawn amounts reach the last 0.05% below maxWithdraw by luck; the harness before the bound rule passed all
    // of these seeds at 4 runs. The bound is now tried in every run, so the first judged run fails.
    for (const seed of ['0x1', '0x2', '0x3', '0xdead', '0xbeef']) {
      const r = await sf('0x5f0000000000000000000000000000000000009b', { seed, runs: 4 });
      const x = r.get('sf-maxWithdraw-honored')!;
      expect(x.status, seed).toBe('fail');
      const m = /^withdraw\((\d+)\) reverted with selector 0x4e487b71 while maxWithdraw is (\d+)$/.exec(x.reason ?? '');
      expect(m, seed).not.toBeNull();
      expect(m![1], seed).toBe(m![2]);
      for (const id of ['sf-maxDeposit-honored', 'sf-maxMint-honored', 'sf-maxRedeem-honored']) expect(r.get(id)!.status, `${seed} ${id}`).toBe('pass');
    }
  });

  it('(b) a vault that honours its max values: all four sf- properties pass', async () => {
    const r = await sf('0x5F00000000000000000000000000000000000031');
    expect([...r.values()].map((x) => [x.id, x.status])).toEqual([
      ['sf-maxDeposit-honored', 'pass'],
      ['sf-maxMint-honored', 'pass'],
      ['sf-maxWithdraw-honored', 'pass'],
      ['sf-maxRedeem-honored', 'pass'],
    ]);
  });

  it('(a) Upshift shape: sf-maxWithdraw-honored and sf-maxRedeem-honored fail with selector 0x75ed2e3e', async () => {
    const r = await sf('0x5f00000000000000000000000000000000000032');
    expect(r.get('sf-maxWithdraw-honored')!.status).toBe('fail');
    expect(r.get('sf-maxWithdraw-honored')!.reason).toMatch(/reverted with selector 0x75ed2e3e while maxWithdraw is [1-9]\d*$/);
    expect(r.get('sf-maxRedeem-honored')!.status).toBe('fail');
    expect(r.get('sf-maxRedeem-honored')!.reason).toMatch(/reverted with selector 0x75ed2e3e while maxRedeem is [1-9]\d*$/);
    expect(r.get('sf-maxDeposit-honored')!.status).toBe('pass');
  });

  it('(c) exits disabled and max values of 0: the exit properties are not_applicable, nothing fails', async () => {
    const r = await sf('0x5f00000000000000000000000000000000000033');
    expect([...r.values()].filter((x) => x.status === 'fail')).toEqual([]);
    expect(r.get('sf-maxWithdraw-honored')).toMatchObject({ status: 'not_applicable', reason: maxZeroNote('maxWithdraw') });
    expect(r.get('sf-maxRedeem-honored')).toMatchObject({ status: 'not_applicable', reason: maxZeroNote('maxRedeem') });
    expect(r.get('sf-maxDeposit-honored')!.status).toBe('pass');
  });


  it('ThresholdPrecompileVault (deposits above 10 tokens are staked): the staked inputs are not judged, so deposit and mint are inconclusive, never pass or fail; withdraw and redeem are judged with a smaller deposit', async () => {
    const r = await sf('0x5f00000000000000000000000000000000000072');
    expect([...r.values()].filter((x) => x.status === 'fail')).toEqual([]);
    for (const id of ['sf-maxDeposit-honored', 'sf-maxMint-honored']) {
      expect(r.get(id)!.status).toBe('inconclusive');
      expect(r.get(id)!.reason ?? '').toMatch(/a vault call reached Monad precompile 0x0000000000000000000000000000000000001000, which forge lacks(, in \d+ inputs)?; these inputs were not judged/);
    }
    expect(r.get('sf-maxWithdraw-honored')!.status).toBe('pass');
    expect(r.get('sf-maxRedeem-honored')!.status).toBe('pass');
  });

  it('mint pulls more than previewMint quotes: sf-maxMint-honored passes, the extra is previewMint\'s finding', async () => {
    const r = await sf('0x5f00000000000000000000000000000000000075');
    expect(r.get('sf-maxMint-honored')!.status).toBe('pass');
  });

  it('refusals below an unlimited max (MinDepositVault): the bound goes through, so sf-maxDeposit and sf-maxMint pass with the refusals counted', async () => {
    const r = await sf('0x5f00000000000000000000000000000000000076');
    for (const id of ['sf-maxDeposit-honored', 'sf-maxMint-honored']) {
      const x = r.get(id)!;
      expect(x.status).toBe('pass');
      const n = Number(/^(\d+) amounts below the bound were refused/.exec(x.reason ?? '')?.[1]);
      expect(n).toBeGreaterThan(0);
      expect(x.reason).toBe(belowBoundNote(n));
    }
  });

  it('a freely transferable asset behind a vault hook that refuses deposits: the probe passes, sf-maxDeposit fails', async () => {
    const r = await sf('0x5f00000000000000000000000000000000000063');
    expect(r.get('sf-maxDeposit-honored')!.status).toBe('fail');
    expect(r.get('sf-maxDeposit-honored')!.reason).toMatch(/reverted with selector 0xea8e4eb5 while maxDeposit is \d+$/);
    expect([...r.values()].some((x) => x.status === 'not_applicable')).toBe(false);
  });
});
