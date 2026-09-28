import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  CERT_STATUS,
  createChainClients,
  RegistryClient,
  vaultAbi,
  type ChainClients,
  type DeployRecord,
  type RehearsalRecord,
  type VerifyRecord,
} from '@specfirst/core';
import { encodeFunctionData, parseEther, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerCertCommand } from '../src/commands/cert.js';
import { registerDeployCommand } from '../src/commands/deploy.js';
import { registerLockCommand } from '../src/commands/lock.js';
import { registerRunCommand } from '../src/commands/run.js';
import { registerStatusCommand } from '../src/commands/status.js';
import { registerVerifyCommand } from '../src/commands/verify.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';
import { git, sampleRepo } from './helpers/sampleRepo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_ARTIFACT = path.resolve(here, '../../contracts/out/CertificateRegistry.sol/CertificateRegistry.json');
const SPEC = 'spec/staking-vault.spec.yaml';
const FUZZ = ['--runs', '64', '--seed', '1'];
const NET = ['--network', 'anvil'];
const OWNER_KEY = ANVIL_KEYS[0] as Hex;

function register(p: import('commander').Command) {
  registerLockCommand(p);
  registerRunCommand(p);
  registerDeployCommand(p);
  registerVerifyCommand(p);
  registerCertCommand(p);
  registerStatusCommand(p);
}

/**
 * Plan 6.2 anvil path through the CLI: registry deploy, fixed sample run and deploy, a third-party
 * deposit, rehearsal of 30 txs, fork verify 7/7, cert issue, a one-line v2 through the full `run`
 * pipeline, lineage checks, revoke with evidence, and exit codes 12, 13, 14.
 * Needs anvil and forge on PATH. SPECFIRST_SKIP_ANVIL=1 skips.
 */
describe.skipIf(SKIP_ANVIL)('specfirst on anvil: deploy, rehearse, verify, cert', { timeout: 600_000 }, () => {
  let anvil: Anvil;
  let dir: string;
  let clients: ChainClients;
  let registry: RegistryClient;
  const savedEnv = { ...process.env };
  let v1: { runId: string; address: Address };
  let v2: { runId: string; address: Address };

  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--project', dir, ...args]));
    return { ...r, code: process.exitCode ?? 0 };
  };
  const runDirOf = (id: string) => path.join(dir, '.specfirst/runs', id);
  const json = async <T>(id: string, file: string) => JSON.parse(await readFile(path.join(runDirOf(id), file), 'utf8')) as T;
  const newestRun = async () => (await readdir(path.join(dir, '.specfirst/runs'))).sort().at(-1)!;

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    const artifact = JSON.parse(await readFile(REGISTRY_ARTIFACT, 'utf8')) as { bytecode: { object: Hex } };
    const owner = clients.wallet(OWNER_KEY);
    const hash = await owner.sendTransaction({ data: artifact.bytecode.object, gas: 3_000_000n });
    const receipt = await clients.publicClient.waitForTransactionReceipt({ hash });
    registry = new RegistryClient(receipt.contractAddress!, clients.publicClient, owner);
    await registry.setIssuer(owner.account.address, true);

    Object.assign(process.env, {
      ANVIL_RPC: anvil.url,
      DEPLOYER_PRIVATE_KEY: OWNER_KEY,
      ISSUER_PRIVATE_KEY: OWNER_KEY,
      SPECFIRST_REGISTRY_31337: registry.address,
    });
    dir = await sampleRepo();
    expect((await cli('lock', SPEC, '--skip-mutants')).code).toBe(0);
  }, 180_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
  });

  it('v1: fixed run, deploy, third-party deposit, rehearsal 30 tx, fork verify 7/7', async () => {
    expect((await cli('run', SPEC, '--no-deploy', ...FUZZ, '--agent', 'replay:fixtures/fix-reentrancy.patch')).code).toBe(0);
    const runId = await newestRun();

    const dep = await cli('deploy', SPEC, '--run', runId, ...NET);
    expect(dep.code).toBe(0);
    const deploy = await json<DeployRecord>(runId, 'deploy.json');
    expect(deploy).toMatchObject({ chainId: 31337, contract: { name: 'StakingVault' } });
    expect(BigInt(deploy.gasLimit)).toBeLessThan(16_777_216n);
    v1 = { runId, address: deploy.address };

    // A depositor the rehearsal knows nothing about.
    const outsider = clients.wallet(ANVIL_KEYS[5] as Hex);
    const h = await outsider.sendTransaction({
      to: deploy.address,
      data: encodeFunctionData({ abi: vaultAbi, functionName: 'deposit' }),
      value: parseEther('1.5'),
    });
    await clients.publicClient.waitForTransactionReceipt({ hash: h });

    const ver = await cli('verify', deploy.address, '--run', runId, ...NET, '--seed', '1');
    expect(ver.err).toEqual([]);
    expect(ver.code).toBe(0);
    const rehearsal = await json<RehearsalRecord>(runId, 'rehearsal.json');
    expect(rehearsal.txs).toHaveLength(30);
    const reverts = rehearsal.txs.filter((t) => t.expectRevert);
    expect(reverts).toHaveLength(5);
    expect(reverts.every((t) => t.verdict === 'reverted')).toBe(true);
    const statusReverts = reverts.filter((t) => t.expectRevert === 'status');
    expect(statusReverts).toHaveLength(4);
    for (const t of statusReverts) {
      expect(t.status).toBe('reverted');
      expect(BigInt(t.gasUsed)).toBeLessThan(BigInt(t.gasLimit));
      expect(t.gasLimit).toBe('80000');
    }
    expect(rehearsal.summary.selectorConfirmed).toBe(5);

    const verify = await json<VerifyRecord>(runId, 'verify.json');
    expect(verify.path).toBe('fork');
    expect(verify.depositors.addresses.map((a) => a.toLowerCase())).toContain(outsider.account.address.toLowerCase());
    expect(verify.invariants.map((i) => i.ok)).toEqual(Array(7).fill(true));
    expect(ver.out.join('\n')).toContain('7/7 ok');
  });

  it('v1: cert issue, then status certified and latest', async () => {
    const r = await cli('cert', 'issue', '--run', v1.runId, ...NET);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const cert = await json<{ certId: string; reportHash: Hex; passedBitmap: string }>(v1.runId, 'cert.json');
    expect(cert).toMatchObject({ certId: '0', passedBitmap: '0x7f' });
    expect(await registry.isCertified(v1.address)).toBe(true);
    expect(await registry.isLatest(v1.address)).toBe(true);
    const latest = (await registry.latest(v1.address))!;
    expect(latest.certificate.reportHash).toBe(cert.reportHash);
    expect(latest.certificate.rehearsalTxCount).toBe(30);
    expect(latest.codeMatches).toBe(true);

    const report = JSON.parse(await readFile(path.join(dir, `certs/31337/${v1.address}/0.json`), 'utf8'));
    expect(report).toMatchObject({ passedCount: 7, totalCount: 7, specfirst: 1, verifyMethod: 'fork' });
    expect(report).not.toHaveProperty('auxiliary');

    const st = await cli('status', v1.address, '--rpc', anvil.url, '--registry', registry.address);
    expect(st.out.join('\n')).toMatch(/certified:\s+true/);
    expect(st.out.join('\n')).toMatch(/isLatest:\s+true/);
  });

  it('v2: a one-line change goes through the whole run pipeline; v1 is Superseded but still certified', async () => {
    // v2 = v1's fixed source plus one added line, committed on main (HEAD still has the planted bug).
    const v1Source = await git(dir, 'show', `refs/specfirst/runs/${v1.runId}:src/StakingVault.sol`);
    const v2Source = v1Source.replace(
      '    function setRewardRate(',
      '    function version() external pure returns (uint256) { return 2; }\n\n    function setRewardRate(',
    );
    await writeFile(path.join(dir, 'src/StakingVault.sol'), v2Source);
    await git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'v2: version()');

    const r = await cli('run', SPEC, ...FUZZ, '--agent', 'none', ...NET);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    const text = r.out.join('\n');
    for (const s of ['deploy ', 'rehearse', 'verify ', 'issue ']) expect(text).toContain(s);
    const runId = await newestRun();
    const deploy = await json<DeployRecord>(runId, 'deploy.json');
    v2 = { runId, address: deploy.address };
    const summary = await json<{ deploy: string; pipeline: { exitCode: number } }>(runId, 'run.json');
    expect(summary).toMatchObject({ deploy: 'done', pipeline: { exitCode: 0 } });

    expect(await registry.isCertified(v2.address)).toBe(true);
    expect(await registry.isLatest(v2.address)).toBe(true);
    expect(await registry.isCertified(v1.address)).toBe(true);
    expect(await registry.isLatest(v1.address)).toBe(false);
    const old = await registry.certificateOf(v1.address, 0n);
    expect(CERT_STATUS[old.status]).toBe('Superseded');
    expect(old.supersededBy.toLowerCase()).toBe(v2.address.toLowerCase());
  });

  it('revoke refuses evidence without a violation, then revokes v1 with evidence and isCertified turns false', async () => {
    const clean = path.join(runDirOf(v1.runId), 'verify.json');
    const refused = await cli('cert', 'revoke', v1.address, '--evidence', clean, ...NET);
    expect(refused.code).toBe(14);
    expect(refused.err.join('\n')).toMatch(/no violated invariant/);

    const wrongTarget = await cli('cert', 'revoke', v2.address, '--evidence', clean, ...NET);
    expect(wrongTarget.code).toBe(14);

    // Test fixture: the fixed v1 cannot be broken on chain, so the evidence file is v1's verify.json with
    // INV-5 marked violated, standing in for a later verify run that caught one (plan 3.7 path b).
    const v = JSON.parse(await readFile(clean, 'utf8')) as VerifyRecord;
    v.invariants = v.invariants.map((i) => (i.id === 'INV-5' ? { ...i, ok: false, evidence: ['fixture: owner-only check violated'] } : i));
    const evidence = path.join(dir, 'evidence-v1.json');
    await writeFile(evidence, JSON.stringify(v, null, 2));

    const r = await cli('cert', 'revoke', v1.address, '--evidence', evidence, ...NET);
    expect(r.err).toEqual([]);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('Revoked');
    expect(await registry.isCertified(v1.address)).toBe(false);
    expect(CERT_STATUS[(await registry.certificateOf(v1.address, 0n)).status]).toBe('Revoked');
    expect(await registry.isCertified(v2.address)).toBe(true);
  });

  it('exit 14: an issuer key the registry does not allow', async () => {
    process.env.ISSUER_PRIVATE_KEY = ANVIL_KEYS[3];
    try {
      const r = await cli('cert', 'issue', '--run', v2.runId, ...NET);
      expect(r.code).toBe(14);
      expect(r.err.join('\n')).toMatch(/NotIssuer/);
    } finally {
      process.env.ISSUER_PRIVATE_KEY = OWNER_KEY;
    }
  });

  it('exit 12: deploy with an unfunded deployer key', async () => {
    process.env.DEPLOYER_PRIVATE_KEY = `0x${'42'.repeat(32)}`;
    try {
      const r = await cli('deploy', SPEC, '--run', v2.runId, ...NET);
      expect(r.code).toBe(12);
      expect(r.err.join('\n')).toMatch(/deploy failed/);
    } finally {
      process.env.DEPLOYER_PRIVATE_KEY = OWNER_KEY;
    }
  });

  it('exit 13: the planted-bug vault deployed with --force fails verify', async () => {
    await git(dir, 'checkout', '-q', 'HEAD~1', '--', 'src/StakingVault.sol');
    const buggySrc = await readFile(path.join(dir, 'src/StakingVault.sol'), 'utf8');
    expect(buggySrc).toContain('uint256 bal = balances[msg.sender];');
    await git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-qam', 'v0: planted bug again');

    expect((await cli('run', SPEC, ...FUZZ, '--agent', 'none', '--no-deploy')).code).toBe(10);
    const runId = await newestRun();
    const refused = await cli('deploy', SPEC, '--run', runId, ...NET);
    expect(refused.code).toBe(12);
    expect((await cli('deploy', SPEC, '--run', runId, ...NET, '--force')).code).toBe(0);
    const deploy = await json<DeployRecord>(runId, 'deploy.json');
    const r = await cli('verify', deploy.address, '--run', runId, ...NET, '--seed', '1');
    expect(r.code).toBe(13);
    const verify = await json<VerifyRecord>(runId, 'verify.json');
    expect(verify.invariants.filter((i) => i.ok === false).map((i) => i.id)).toEqual(expect.arrayContaining(['INV-1', 'INV-2', 'INV-4']));
    const rehearsal = await json<RehearsalRecord>(runId, 'rehearsal.json');
    expect(rehearsal.txs.find((t) => t.revertKind === 'reentry')!.verdict).toBe('unexpected-success');
    expect(await registry.certificateCount(deploy.address)).toBe(0n);
  });
});
