import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anvilChain,
  collectDepositors,
  createChainClients,
  deployContract,
  parseSpec,
  readArtifact,
  rehearse,
  vaultAbi,
  verifyDeployment,
  type ChainClients,
  type DeployResult,
  type RehearsalRecord,
  type Spec,
} from '../src/index.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.resolve(here, '../../../examples/staking-vault');
const DEPLOYER = ANVIL_KEYS[0] as Hex;
const THIRD_PARTY = ANVIL_KEYS[5] as Hex;

/**
 * Deploy, rehearsal and post-deploy verification against a local anvil (plan 6.2).
 * Needs anvil and forge on PATH. SPECFIRST_SKIP_ANVIL=1 skips.
 */
describe.skipIf(SKIP_ANVIL)('deploy, rehearse, verify on anvil', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let dir: string;
  let spec: Spec;
  let clients: ChainClients;
  let outDir: string;
  let fixed: DeployResult;
  let rehearsal: RehearsalRecord;

  const deploy = () =>
    deployContract({ spec, worktreeOrProjectDir: dir, client: clients.publicClient, walletClient: clients.wallet(DEPLOYER), outDir, build: false });

  beforeAll(async () => {
    anvil = await startAnvil();
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-core-anvil-'));
    await cp(SAMPLE, dir, { recursive: true, filter: (s) => !/\/(out|cache)(\/|$)/.test(s.slice(SAMPLE.length)) });
    await cp(path.join(SAMPLE, 'fixed/StakingVault.sol'), path.join(dir, 'src/StakingVault.sol'));
    spec = parseSpec(await readFile(path.join(dir, 'spec/staking-vault.spec.yaml'), 'utf8'));
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    outDir = path.join(dir, '.specfirst-test/out');
    fixed = await deployContract({ spec, worktreeOrProjectDir: dir, client: clients.publicClient, walletClient: clients.wallet(DEPLOYER), outDir });
  }, 180_000);

  afterAll(async () => {
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('deploys with gas = estimate x 1.2 and records the code hash', async () => {
    const r = fixed.record;
    expect(r.chainId).toBe(31337);
    expect(BigInt(r.gasLimit)).toBe((BigInt(r.gasEstimate) * 12n + 9n) / 10n);
    expect(BigInt(r.gasLimit)).toBeLessThan(16_777_216n);
    expect(BigInt(r.gasUsed)).toBeLessThanOrEqual(BigInt(r.gasLimit));
    const owner = await clients.publicClient.readContract({ address: r.address, abi: vaultAbi, functionName: 'owner' });
    expect(owner).toBe(r.deployer);
    expect(r.constructorArgs).toEqual([r.deployer]);
    expect(r.codeHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rehearses 30 txs: 25 normal ok, 5 revert-expected reverted below the gas limit with matching selectors', async () => {
    const attacker = await readArtifact(outDir, 'Attacker.sol', 'Attacker');
    rehearsal = await rehearse({
      spec,
      clients,
      deployerKey: DEPLOYER,
      target: fixed.record.address,
      targetAbi: fixed.artifact.abi,
      attacker,
      runId: 'test-run',
    });
    expect(rehearsal.txs).toHaveLength(30);
    expect(rehearsal.summary).toMatchObject({ normal: 25, normalOk: 25, expectRevert: 5, reverted: 5, outOfGas: 0, unexpectedSuccess: 0, selectorConfirmed: 5 });
    const reverts = rehearsal.txs.filter((t) => t.expectRevert);
    for (const t of reverts.filter((t) => t.expectRevert === 'status')) {
      expect(t.status).toBe('reverted');
      expect(t.gasLimit).toBe('80000');
      expect(BigInt(t.gasUsed)).toBeLessThan(BigInt(t.gasLimit));
    }
    expect(reverts.filter((t) => t.expectRevert === 'status')).toHaveLength(4);
    const reentry = reverts.find((t) => t.revertKind === 'reentry')!;
    expect(reentry).toMatchObject({ expectRevert: 'inner', status: 'success', verdict: 'reverted', invariantId: 'INV-4' });
    expect(Object.fromEntries(reverts.map((t) => [t.revertKind, typeof t.selector === 'object' ? t.selector.expectedError : t.selector]))).toEqual({
      'unauthorized-set-reward-rate': 'Unauthorized',
      'unauthorized-pause': 'Unauthorized',
      'overdraw-withdraw': 'InsufficientBalance',
      'deposit-while-paused': 'PausedError',
      reentry: 'InsufficientBalance',
    });
    expect(rehearsal.actors.map((a) => a.role)).toEqual(['owner', 'user', 'user', 'user', 'attacker', 'attacker-contract']);
  });

  it('third-party depositor: verify on a fork counts a non-actor deposit, 7/7 ok', async () => {
    const outsider = clients.wallet(THIRD_PARTY);
    const hash = await outsider.sendTransaction({
      to: fixed.record.address,
      data: encodeFunctionData({ abi: vaultAbi, functionName: 'deposit' }),
      value: parseEther('0.37'),
    });
    await clients.publicClient.waitForTransactionReceipt({ hash });

    const v = await verifyDeployment({
      spec,
      projectDir: dir,
      client: clients.publicClient,
      forkUrl: anvil.url,
      target: fixed.record.address,
      deployBlock: BigInt(fixed.record.blockNumber),
      rehearsal,
      artifactDir: path.join(dir, '.specfirst-test/verify'),
      outDir,
      seed: '1',
    });
    expect(v.path).toBe('fork');
    expect(v.depositors.addresses.map((a) => a.toLowerCase())).toContain(outsider.account.address.toLowerCase());
    expect(v.invariants.map((i) => [i.id, i.ok])).toEqual([
      ['INV-1', true], ['INV-2', true], ['INV-3', true], ['INV-4', true], ['INV-5', true], ['INV-6', true], ['INV-7', true],
    ]);
    expect(v.ok).toBe(true);
    expect(v.invariants.find((i) => i.id === 'INV-5')!.evidence.join('\n')).toMatch(/RewardRateChanged: \d+ log\(s\).*all from owner txs/);
  });

  it('without the third party in the depositor set INV-1 fails, so the set matters', async () => {
    const actorsOnly = rehearsal.actors.filter((a) => a.role !== 'owner').map((a) => a.address as Address);
    const v = await verifyDeployment({
      spec,
      projectDir: dir,
      client: clients.publicClient,
      forkUrl: anvil.url,
      target: fixed.record.address,
      deployBlock: BigInt(fixed.record.blockNumber),
      rehearsal,
      artifactDir: path.join(dir, '.specfirst-test/verify-actors-only'),
      outDir,
      seed: '1',
      depositorsOverride: actorsOnly,
    });
    expect(v.invariants.find((i) => i.id === 'INV-1')!.ok).toBe(false);
    expect(v.ok).toBe(false);
  });

  it('getLogs with chunk 3 finds the same depositors as chunk 100, over contiguous ranges', async () => {
    const from = BigInt(fixed.record.blockNumber);
    const latest = await clients.publicClient.getBlockNumber();
    const wide = await collectDepositors({ client: clients.publicClient, target: fixed.record.address, fromBlock: from, toBlock: latest });
    const ranges: Array<[bigint, bigint]> = [];
    const spy = {
      ...clients.publicClient,
      getLogs: (args: Parameters<typeof clients.publicClient.getLogs>[0]) => {
        ranges.push([args!.fromBlock as bigint, args!.toBlock as bigint]);
        return clients.publicClient.getLogs(args);
      },
    } as unknown as typeof clients.publicClient;
    const narrow = await collectDepositors({ client: spy, target: fixed.record.address, fromBlock: from, toBlock: latest, chunkSize: 3n });
    expect(narrow.addresses).toEqual(wide.addresses);
    expect(narrow.chunks).toBe(Number((latest - from) / 3n + 1n));
    expect(ranges[0]![0]).toBe(from);
    expect(ranges.at(-1)![1]).toBe(latest);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i]![0]).toBe(ranges[i - 1]![1] + 1n);
    for (const [a, b] of ranges) expect(b - a).toBeLessThanOrEqual(2n);
    // Deposits land in blocks on both sides of chunk boundaries (one tx per block on anvil).
    expect(wide.addresses.length).toBeGreaterThanOrEqual(5);
  });

  it('fork failure falls back to SpecfirstProbe: INV-1, 2, 6 from the probe, access from the rehearsal, INV-3 unjudged', async () => {
    const v = await verifyDeployment({
      spec,
      projectDir: dir,
      client: clients.publicClient,
      forkUrl: 'http://127.0.0.1:1',
      target: fixed.record.address,
      deployBlock: BigInt(fixed.record.blockNumber),
      rehearsal,
      artifactDir: path.join(dir, '.specfirst-test/verify-probe'),
      outDir,
      timeoutSec: 120,
    });
    expect(v.path).toBe('probe');
    expect(v.note).toBe('fork 대조 미사용');
    expect(v.fork?.error).toBeTruthy();
    expect(v.probe).toMatchObject({ inv1: true, inv2: true, inv6: true });
    expect(Object.fromEntries(v.invariants.map((i) => [i.id, i.ok]))).toEqual({
      'INV-1': true, 'INV-2': true, 'INV-3': null, 'INV-4': true, 'INV-5': true, 'INV-6': true, 'INV-7': true,
    });
    expect(v.ok).toBe(false);
    expect(v.unjudged).toBe(1);
  });

  it('gas-shortage fixture: revert-expected txs that run out of gas are not counted as access control', async () => {
    const fresh = await deploy();
    const attacker = await readArtifact(outDir, 'Attacker.sol', 'Attacker');
    const r = await rehearse({
      spec,
      clients,
      deployerKey: DEPLOYER,
      target: fresh.record.address,
      targetAbi: fresh.artifact.abi,
      attacker,
      runId: 'test-oog',
      // 21,000 is below the intrinsic gas of any call with calldata: anvil leaves such a tx pending forever;
      // 22,000 clears intrinsic gas and the calldata floor but not the cold SLOAD of owner.
      revertGasLimit: 22_000n,
    });
    const oog = r.txs.filter((t) => t.expectRevert === 'status');
    expect(oog).toHaveLength(4);
    for (const t of oog) {
      expect(t.status).toBe('reverted');
      expect(t.gasUsed).toBe(t.gasLimit);
      expect(t.verdict).toBe('out-of-gas');
    }
    expect(r.summary.reverted).toBe(1);
    expect(r.summary.outOfGas).toBe(4);

    const v = await verifyDeployment({
      spec,
      projectDir: dir,
      client: clients.publicClient,
      forkUrl: anvil.url,
      target: fresh.record.address,
      deployBlock: BigInt(fresh.record.blockNumber),
      rehearsal: r,
      artifactDir: path.join(dir, '.specfirst-test/verify-oog'),
      outDir,
      forceProbe: true,
    });
    for (const id of ['INV-5', 'INV-6', 'INV-7']) expect(v.invariants.find((i) => i.id === id)!.ok).toBe(false);
    expect(v.invariants.find((i) => i.id === 'INV-5')!.evidence.join('\n')).toMatch(/out-of-gas, status reverted, gasUsed 22000 of 22000/);
  });

  it('planted bug: the reentry replay succeeds on chain and the fork finds INV-1..4 violations', async () => {
    const buggyDir = await mkdtemp(path.join(tmpdir(), 'specfirst-core-buggy-'));
    try {
      await cp(dir, buggyDir, { recursive: true, filter: (s) => !s.includes('.specfirst-test') });
      await cp(path.join(SAMPLE, 'src/StakingVault.sol'), path.join(buggyDir, 'src/StakingVault.sol'));
      const buggyOut = path.join(buggyDir, 'out-test');
      const buggy = await deployContract({ spec, worktreeOrProjectDir: buggyDir, client: clients.publicClient, walletClient: clients.wallet(DEPLOYER), outDir: buggyOut });
      const r = await rehearse({
        spec,
        clients,
        deployerKey: DEPLOYER,
        target: buggy.record.address,
        targetAbi: buggy.artifact.abi,
        attacker: await readArtifact(buggyOut, 'Attacker.sol', 'Attacker'),
        runId: 'test-buggy',
      });
      expect(r.txs.find((t) => t.revertKind === 'reentry')!.verdict).toBe('unexpected-success');
      const v = await verifyDeployment({
        spec,
        projectDir: buggyDir,
        client: clients.publicClient,
        forkUrl: anvil.url,
        target: buggy.record.address,
        deployBlock: BigInt(buggy.record.blockNumber),
        rehearsal: r,
        artifactDir: path.join(buggyDir, 'verify'),
        outDir: buggyOut,
        seed: '1',
      });
      expect(v.path).toBe('fork');
      const bad = v.invariants.filter((i) => i.ok === false).map((i) => i.id);
      expect(bad).toEqual(expect.arrayContaining(['INV-1', 'INV-2', 'INV-4']));
      expect(v.ok).toBe(false);
    } finally {
      await rm(buggyDir, { recursive: true, force: true });
    }
  });
});
