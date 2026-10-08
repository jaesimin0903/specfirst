import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  AttestationRegistryClient,
  createChainClients,
  defaultCacheDir,
  ERC4626_UPSTREAM,
  FORGE_STD_PIN,
  forgeEnv,
  REQUEST_STATUS,
  RequestDeskClient,
  runStandardCheck,
  workerStatusSchema,
  type ChainClients,
  type RunStandardCheckInput,
} from '@specfirst/core';
import { getAddress, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerDeskCommand, registerWorkerCommand } from '../src/commands/desk.js';
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
const SKIP = !UPSTREAM || !FORGE_STD || process.env.SPECFIRST_SKIP_FORGE === '1' || SKIP_ANVIL;

const PACKED_TOKEN = getAddress('0x5F00000000000000000000000000000000000003');
const PACKED_VAULT = getAddress('0x5F00000000000000000000000000000000000021');

/**
 * `specfirst worker` with the real suite: the pinned a16z harness and forge run against a vault compiled
 * from the core fixtures and placed on a local anvil, which is both the desk chain and the subject chain.
 * Runs only when a pinned checkout is already in the cache ($SPECFIRST_CACHE_DIR or the default); the
 * cache is only read (file:// pins), the workspace is a temp directory. No public RPC.
 */
describe.skipIf(SKIP)('specfirst worker with forge (pinned cache present)', { timeout: 600_000 }, () => {
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
    registerDeskCommand(p);
    registerWorkerCommand(p, { runCheck });
  };
  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-desk-forge-'));
    dir = path.join(root, 'project');
    await mkdir(dir, { recursive: true });
    const mocks = path.join(root, 'mocks');
    await mkdir(path.join(mocks, 'src'), { recursive: true });
    await copyFile(path.resolve(here, '../../core/test/fixtures/standards/mock-vaults.sol'), path.join(mocks, 'src/MockVaults.sol'));
    await writeFile(path.join(mocks, 'foundry.toml'), '[profile.default]\nsrc = "src"\nsolc_version = "0.8.28"\nevm_version = "prague"\n');
    const built = spawnSync('forge', ['build', '--offline'], { cwd: mocks, env: forgeEnv({}), encoding: 'utf8', timeout: 240_000 });
    if (built.status !== 0) throw new Error(`${built.stdout}\n${built.stderr}`);
    const code = async (name: string) =>
      (JSON.parse(await readFile(path.join(mocks, 'out/MockVaults.sol', `${name}.json`), 'utf8')) as { deployedBytecode: { object: Hex } }).deployedBytecode.object;
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    await clients.publicClient.request({ method: 'anvil_setCode' as never, params: [PACKED_TOKEN, await code('PackedToken')] as never });
    await clients.publicClient.request({ method: 'anvil_setCode' as never, params: [PACKED_VAULT, await code('PackedAssetVault')] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: ANVIL_KEYS[0], ISSUER_PRIVATE_KEY: ANVIL_KEYS[1], REQUESTER_PRIVATE_KEY: ANVIL_KEYS[2] });
    for (const k of ['SPECFIRST_ATTEST_REGISTRY_31337', 'SPECFIRST_DESK_31337', 'SPECFIRST_REPORT_BASE_URL']) delete process.env[k];
  }, 300_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a paid request for a vault is checked by forge, attested with all 30 passing, and fulfilled', async () => {
    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil');
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = event(reg, 'attest-registry-deployed').address as string;
    const d = await cli('desk', 'deploy', '--network', 'anvil', '--fee', '0.01');
    const desk = event(d, 'desk-deployed').address as Address;
    process.env.SPECFIRST_DESK_31337 = desk;
    expect((await cli('desk', 'request', PACKED_VAULT, '--subject-chain', '31337', '--network', 'anvil')).code).toBe(0);

    const r = await cli('worker', '--network', 'anvil', '--subject-rpc', anvil.url, '--once', '--block-lag', '0', '--runs', '4');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.type)).toEqual(expect.arrayContaining(['check-start', 'check-identity', 'check-workspace', 'check-forge', 'worker-fulfilled']));
    const request = await new RequestDeskClient(desk, clients.publicClient).requestOf(0n);
    expect(REQUEST_STATUS[request.status]).toBe('Fulfilled');
    const registry = new AttestationRegistryClient(getAddress(process.env.SPECFIRST_ATTEST_REGISTRY_31337!), clients.publicClient);
    const a = await registry.attestationOf(request.attestationId);
    expect(a).toMatchObject({ subject: PACKED_VAULT, subjectChainId: 31337n, passCount: 30, failCount: 0 });
    expect(a.reportURI).toMatch(/^https:\/\/raw\.githubusercontent\.com\/jaesimin0903\/specfirst\/main\/certs\/checks\/31337\/0x5f0+21\/\d+-[0-9a-f]{16}\.json$/);
    expect(await registry.isCompliant(31337n, PACKED_VAULT, a.standardId)).toBe(true);
    const status = workerStatusSchema.parse(JSON.parse(await readFile(path.join(dir, '.specfirst/worker/status.json'), 'utf8')));
    expect(status['0']).toMatchObject({ stage: 'fulfilled', attestationId: request.attestationId.toString() });
    // Like `specfirst check`, the report and forge's JSON are also kept under .specfirst/checks.
    const block = (status['0'] as { block: string }).block;
    expect(existsSync(path.join(dir, `.specfirst/checks/31337/${PACKED_VAULT.toLowerCase()}/${block}.json`))).toBe(true);
    expect(existsSync(path.join(dir, `.specfirst/checks/31337/${PACKED_VAULT.toLowerCase()}/${block}.forge.json`))).toBe(true);
  });
});
