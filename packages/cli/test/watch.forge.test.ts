import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  AttestationRegistryClient,
  createChainClients,
  defaultCacheDir,
  deployDemoFactory,
  deployDemoToken,
  deployDemoVault,
  ERC4626_UPSTREAM,
  FORGE_STD_PIN,
  forgeEnv,
  runStandardCheck,
  standardIdOf,
  type ChainClients,
  type FeedEvent,
  type RunStandardCheckInput,
} from '@specfirst/core';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeDeployData, getAddress, type Abi, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerWatchCommand } from '../src/commands/watch.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

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
const SKIP = !UPSTREAM || !FORGE_STD || process.env.SPECFIRST_SKIP_FORGE === '1' || SKIP_ANVIL || spawnSync('forge', ['--version'], { stdio: 'ignore' }).status !== 0;
const DEMO_SOURCES = path.resolve(here, '../../../examples/watch/sources-demo.json');
const WATCH_KEY = ANVIL_KEYS[4] as Hex;

/**
 * `specfirst watch` with the real suite: the pinned a16z harness and forge fork a local anvil that is both the
 * subject chain and the attest chain, the way the demo forks Monad testnet. Two DemoVaults come from the
 * factory, one with the deliberate bug on: the watcher detects both, forge passes all 30 properties on the
 * sound one and fails previewDeposit (and only that) on the broken one, and both are attested. Runs only
 * when a pinned checkout is already in the cache ($SPECFIRST_CACHE_DIR or the default); the cache is only
 * read (file:// pins), the workspace is a temp directory. No public RPC.
 */
describe.skipIf(SKIP)('specfirst watch with forge (pinned cache present)', { timeout: 900_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let root: string;
  let dir: string;
  const savedEnv = { ...process.env };

  const runCheck = (input: RunStandardCheckInput) =>
    runStandardCheck({
      ...input,
      cacheDir: path.join(root, 'cache'),
      pins: {
        upstream: { repo: `file://${UPSTREAM}`, commit: ERC4626_UPSTREAM.commit },
        forgeStd: { repo: `file://${FORGE_STD}`, commit: FORGE_STD_PIN.commit },
      },
    });
  const register = (p: import('commander').Command) => {
    registerAttestRegistryCommand(p);
    registerWatchCommand(p, { runCheck });
  };
  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-watch-forge-'));
    dir = path.join(root, 'project');
    await mkdir(dir, { recursive: true });
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: ANVIL_KEYS[0], ISSUER_PRIVATE_KEY: ANVIL_KEYS[1], WATCH_ISSUER_PRIVATE_KEY: WATCH_KEY });
    for (const k of ['SPECFIRST_ATTEST_REGISTRY_31337', 'SPECFIRST_REPORT_BASE_URL']) delete process.env[k];
  }, 300_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a vault that burns gas in its view functions passes the probe, then runs out of --check-timeout: recorded, not attested, not retried', async () => {
    // DemoVault whose totalAssets() spins until 10 million gas are left: an eth_call under the node's gas cap
    // returns at once, under forge every call burns most of the test's gas limit.
    const demo = await readFile(path.resolve(here, '../../contracts/src/demo/DemoVaultFactory.sol'), 'utf8');
    const vaultOnly = demo.slice(0, demo.indexOf('/// @title DemoVaultFactory'));
    const burner = vaultOnly
      .replace('contract DemoVault {', 'contract GasBurnerVault {')
      .replace('    function totalAssets() public view returns (uint256) {\n', '    function totalAssets() public view returns (uint256) {\n        while (gasleft() > 10_000_000) {}\n');
    expect(burner).toContain('while (gasleft() > 10_000_000) {}');
    const project = path.join(root, 'burner');
    await mkdir(path.join(project, 'src'), { recursive: true });
    await writeFile(path.join(project, 'src/GasBurnerVault.sol'), burner);
    await writeFile(path.join(project, 'foundry.toml'), '[profile.default]\nsrc = "src"\nsolc_version = "0.8.28"\nevm_version = "prague"\n');
    const built = spawnSync('forge', ['build', '--offline'], { cwd: project, env: forgeEnv({}), encoding: 'utf8', timeout: 240_000 });
    expect(built.status, `${built.stdout}\n${built.stderr}`).toBe(0);
    const art = JSON.parse(await readFile(path.join(project, 'out/GasBurnerVault.sol/GasBurnerVault.json'), 'utf8')) as { abi: Abi; bytecode: { object: Hex } };

    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil', '--issuer', privateKeyToAccount(WATCH_KEY).address);
    const registryAddress = event(reg, 'attest-registry-deployed').address as Address;
    const wallet = clients.wallet(ANVIL_KEYS[2] as Hex);
    const token = (await deployDemoToken({ client: clients.publicClient, wallet })).address;
    const from = await clients.publicClient.getBlockNumber();
    // Deployed broken, so its constructor emits BrokenSet: the signal of the sources file below.
    const hash = await wallet.sendTransaction({ data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode.object, args: [token, wallet.account.address, true] }), gas: 5_000_000n });
    const vault = getAddress((await clients.publicClient.waitForTransactionReceipt({ hash })).contractAddress!);
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    const sources = path.join(root, 'sources-burner.json');
    await writeFile(
      sources,
      JSON.stringify({ v: 1, chainId: 31337, sources: [{ name: 'BrokenSet of any emitter', signal: 'upgrade', address: null, event: 'event BrokenSet(bool broken)', vault: null }] }),
    );

    const started = Date.now();
    const watch = () =>
      cli('watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', anvil.url, '--sources', sources, '--registry-attest', registryAddress, '--from-block', from.toString(), '--once', '--block-lag', '0', '--sweep-per-hour', '0', '--check-timeout', '15');
    const r = await watch();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const feed = r.events.filter((e) => e.type === 'watch-feed').map((e) => e.event as FeedEvent);
    expect(feed.map((e) => `${e.kind}:${e.subject === vault ? 'burner' : e.subject}`)).toEqual(['detected:burner', 'queued:burner', 'error:burner']);
    expect(feed[2]!.reason).toBe('check stopped, not attested and not retried until the next signal or sweep: forge timed out after 15s');
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(await new AttestationRegistryClient(registryAddress, clients.publicClient).attestationCount()).toBe(0n);
    // forge ran with the capped gas limit in the workspace's foundry.toml.
    const standards = path.join(root, 'cache/standards');
    const ws = readdirSync(standards).find((d) => d.startsWith('erc4626-'))!;
    expect(await readFile(path.join(standards, ws, 'foundry.toml'), 'utf8')).toContain('\ngas_limit = 100000000\n');
    // Not retried: the next pass has nothing to do.
    const again = await cli('watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', anvil.url, '--sources', sources, '--registry-attest', registryAddress, '--once', '--block-lag', '0', '--sweep-per-hour', '0');
    expect(again.events.filter((e) => e.type === 'watch-feed')).toEqual([]);
    await rm(path.join(dir, '.specfirst/watch'), { recursive: true, force: true });
  });

  it('detects two DemoVaults from the factory; forge passes the sound one and fails previewDeposit on the broken one; both are attested', async () => {
    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil', '--issuer', privateKeyToAccount(WATCH_KEY).address);
    const registryAddress = event(reg, 'attest-registry-deployed').address as Address;
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = registryAddress;
    const wallet = clients.wallet(ANVIL_KEYS[2] as Hex);
    await deployDemoFactory({ client: clients.publicClient, wallet });
    const token = (await deployDemoToken({ client: clients.publicClient, wallet })).address;
    const sources = path.join(root, 'sources.json');
    await writeFile(sources, JSON.stringify({ ...(JSON.parse(await readFile(DEMO_SOURCES, 'utf8')) as object), chainId: 31337 }));
    const from = await clients.publicClient.getBlockNumber();
    const sound = (await deployDemoVault({ client: clients.publicClient, wallet, asset: token, broken: false })).vault;
    const broken = (await deployDemoVault({ client: clients.publicClient, wallet, asset: token, broken: true })).vault;
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });

    const r = await cli('watch', '--network', 'anvil', '--subject-chain', '31337', '--subject-rpc', anvil.url, '--sources', sources, '--from-block', from.toString(), '--once', '--block-lag', '0', '--sweep-per-hour', '0', '--runs', '8');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['check-start', 'check-identity', 'check-workspace', 'check-forge']));
    const feed = r.events.filter((e) => e.type === 'watch-feed').map((e) => e.event as FeedEvent);
    const checked = feed.filter((e) => e.kind === 'checked');
    expect(checked.map((e) => [e.subject, e.check!.summary, e.check!.failed])).toEqual([
      [sound, { pass: 30, fail: 0, inconclusive: 0, notApplicable: 0 }, []],
      [broken, { pass: 29, fail: 1, inconclusive: 0, notApplicable: 0 }, ['previewDeposit']],
    ]);
    const registry = new AttestationRegistryClient(registryAddress, clients.publicClient);
    const erc4626 = standardIdOf('erc4626');
    expect(await registry.isCompliant(31337n, sound, erc4626)).toBe(true);
    expect(await registry.isCompliant(31337n, broken, erc4626)).toBe(false);
    expect((await registry.latest(31337n, broken, erc4626))!.attestation).toMatchObject({ failCount: 1, passCount: 29 });
    // Like `specfirst check`, the report and forge's JSON are also kept under .specfirst/checks.
    const block = checked[0]!.check!.block;
    expect(existsSync(path.join(dir, `.specfirst/checks/31337/${sound.toLowerCase()}/${block}.forge.json`))).toBe(true);
  });
});
