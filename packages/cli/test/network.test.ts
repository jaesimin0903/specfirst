import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerCertCommand } from '../src/commands/cert.js';
import { registerDeployCommand } from '../src/commands/deploy.js';
import { registerRunCommand } from '../src/commands/run.js';
import { registerVerifyCommand } from '../src/commands/verify.js';
import { ConfigError, MONAD_MAINNET_RPC_ENV, resolveAttestRegistry, resolveNetwork, subjectRpcFor } from '../src/lib/network.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';
import { SAMPLE_DIR } from './helpers/sampleRepo.js';

const TARGET = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
const KEY = `0x${'11'.repeat(32)}`;

describe('resolveNetwork', () => {
  it('refuses monad-mainnet unless the caller is read-only', () => {
    expect(() => resolveNetwork({ network: 'monad-mainnet' }, {})).toThrow(ConfigError);
    expect(() => resolveNetwork({ network: 'monad-mainnet' }, {})).toThrow(/--network monad-mainnet is read-only/);
    expect(() => resolveNetwork({ network: 'monad-mainnet' }, {}, { readOnly: false })).toThrow(ConfigError);
  });

  it('read-only callers get chain 143 with the public RPC, $MONAD_MAINNET_RPC or --rpc', () => {
    const def = resolveNetwork({ network: 'monad-mainnet' }, {}, { readOnly: true });
    expect(def.clients.chain.id).toBe(143);
    expect(def.forkUrl).toBe('https://rpc.monad.xyz');
    expect(() => def.clients.wallet(KEY as `0x${string}`)).toThrow(/refusing to create a wallet client/);
    expect(resolveNetwork({ network: 'monad-mainnet' }, { [MONAD_MAINNET_RPC_ENV]: 'https://m.example' }, { readOnly: true }).forkUrl).toBe('https://m.example');
    expect(resolveNetwork({ network: 'monad-mainnet', rpc: 'https://flag.example' }, { [MONAD_MAINNET_RPC_ENV]: 'https://m.example' }, { readOnly: true }).forkUrl).toBe('https://flag.example');
    // The testnet env var never leaks into mainnet.
    expect(resolveNetwork({ network: 'monad-mainnet' }, { MONAD_TESTNET_RPC: 'https://t.example' }, { readOnly: true }).forkUrl).toBe('https://rpc.monad.xyz');
  });

  it('subject chain RPC for attestations: --subject-rpc, then the chain env variable, then the public default', () => {
    expect(subjectRpcFor(143, undefined, {})).toBe('https://rpc.monad.xyz');
    expect(subjectRpcFor(143, undefined, { [MONAD_MAINNET_RPC_ENV]: 'https://m.example' })).toBe('https://m.example');
    expect(subjectRpcFor(10143, undefined, {})).toBe('https://testnet-rpc.monad.xyz');
    expect(subjectRpcFor(31337, undefined, { ANVIL_RPC: 'http://127.0.0.1:9' })).toBe('http://127.0.0.1:9');
    expect(subjectRpcFor(1, 'https://eth.example', {})).toBe('https://eth.example');
    expect(() => subjectRpcFor(1, undefined, {})).toThrow(/no default RPC for chain 1; pass --subject-rpc/);
  });

  it('attestation registry address: --registry-attest, then SPECFIRST_ATTEST_REGISTRY_<chainId>', () => {
    const net = resolveNetwork({ network: 'anvil' }, {});
    const a = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
    expect(resolveAttestRegistry(net, { registryAttest: a }, {})).toBe(a);
    expect(resolveAttestRegistry(net, {}, { SPECFIRST_ATTEST_REGISTRY_31337: a })).toBe(a);
    expect(() => resolveAttestRegistry(net, {}, { SPECFIRST_REGISTRY_31337: a })).toThrow(/set SPECFIRST_ATTEST_REGISTRY_31337 or pass --registry-attest/);
  });

  it('testnet and anvil are unchanged', () => {
    expect(resolveNetwork({}, {}).clients.chain.id).toBe(10143);
    expect(resolveNetwork({ network: 'anvil' }, {}).clients.chain.id).toBe(31337);
  });
});

/**
 * Every command that sends transactions must refuse monad-mainnet before it reads a key or touches the RPC.
 * The RPC is unroutable and keys are set, so only the network check can produce these exits.
 */
describe('transaction-sending commands refuse monad-mainnet', () => {
  let dir: string;
  const runId = '20260929-000000-abcdef';
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-mainnet-'));
    await mkdir(path.join(dir, 'spec'), { recursive: true });
    await copyFile(path.join(SAMPLE_DIR, 'spec/staking-vault.spec.yaml'), path.join(dir, 'spec/staking-vault.spec.yaml'));
    const runDir = path.join(dir, '.specfirst/runs', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      path.join(runDir, 'run.json'),
      JSON.stringify({ runId, spec: { path: 'spec/staking-vault.spec.yaml' }, status: 'passed', envWarnings: [], allowPartial: false, finalCommit: 'HEAD' }),
    );
    await writeFile(path.join(runDir, 'deploy.json'), JSON.stringify({ version: 1, chainId: 143, address: TARGET, blockNumber: '1' }));
    await writeFile(path.join(dir, 'evidence.json'), JSON.stringify({ version: 1, chainId: 143, target: TARGET, invariants: [{ id: 'INV-1', ok: false }] }));
    Object.assign(process.env, {
      DEPLOYER_PRIVATE_KEY: KEY,
      ISSUER_PRIVATE_KEY: KEY,
      SPECFIRST_REGISTRY_143: '0x1111111111111111111111111111111111111111',
      MONAD_MAINNET_RPC: 'http://127.0.0.1:1',
    });
  });

  afterEach(async () => {
    process.env = { ...saved };
    process.exitCode = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  const cli = async (register: (p: import('commander').Command) => void, ...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--project', dir, ...args]));
    return { code: process.exitCode ?? 0, err: r.err.join('\n') };
  };
  const refused = /--network monad-mainnet is read-only: this command sends transactions/;

  it('deploy exits 12', async () => {
    const r = await cli(registerDeployCommand, 'deploy', 'spec/staking-vault.spec.yaml', '--run', runId, '--network', 'monad-mainnet');
    expect(r).toMatchObject({ code: 12 });
    expect(r.err).toMatch(refused);
  });

  it('verify (which rehearses) exits 13, with or without --no-rehearse', async () => {
    for (const extra of [[], ['--no-rehearse']]) {
      const r = await cli(registerVerifyCommand, 'verify', TARGET, '--run', runId, '--network', 'monad-mainnet', ...extra);
      expect(r).toMatchObject({ code: 13 });
      expect(r.err).toMatch(refused);
    }
  });

  it('cert issue and cert revoke exit 14', async () => {
    const issue = await cli(registerCertCommand, 'cert', 'issue', '--run', runId, '--network', 'monad-mainnet');
    expect(issue).toMatchObject({ code: 14 });
    expect(issue.err).toMatch(refused);
    const revoke = await cli(registerCertCommand, 'cert', 'revoke', TARGET, '--evidence', 'evidence.json', '--network', 'monad-mainnet');
    expect(revoke).toMatchObject({ code: 14 });
    expect(revoke.err).toMatch(refused);
  });

  it('attest-registry deploy exits 12; cert attest and cert revoke-attestation exit 14', async () => {
    const dep = await cli(registerAttestRegistryCommand, 'attest-registry', 'deploy', '--network', 'monad-mainnet');
    expect(dep).toMatchObject({ code: 12 });
    expect(dep.err).toMatch(refused);
    await copyFile(path.join(SAMPLE_DIR, '..', '..', 'packages/core/test/fixtures/attest/morpho-143-109061472.json'), path.join(dir, 'report.json'));
    const att = await cli(registerCertCommand, 'cert', 'attest', 'report.json', '--network', 'monad-mainnet', '--registry-attest', TARGET);
    expect(att).toMatchObject({ code: 14 });
    expect(att.err).toMatch(refused);
    const rev = await cli(registerCertCommand, 'cert', 'revoke-attestation', '0', '--evidence', 'evidence.json', '--network', 'monad-mainnet', '--registry-attest', TARGET);
    expect(rev).toMatchObject({ code: 14 });
    expect(rev.err).toMatch(refused);
  });

  it('run with its deploy pipeline exits 12 before the loop starts', async () => {
    const r = await cli(registerRunCommand, 'run', 'spec/staking-vault.spec.yaml', '--agent', 'none', '--network', 'monad-mainnet');
    expect(r).toMatchObject({ code: 12 });
    expect(r.err).toMatch(refused);
  });
});
