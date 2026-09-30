import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  AttestationRegistryClient,
  createChainClients,
  parseCheckReport,
  suiteHash,
  suiteOf,
  type ChainClients,
  type StandardCheckReport,
} from '@specfirst/core';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerCertCommand } from '../src/commands/cert.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../../core/test/fixtures/attest');
const KEY = ANVIL_KEYS[0] as Hex;
const SUBJECT = getAddress('0x5f00000000000000000000000000000000000077');
const SUBJECT_CODE: Hex = '0x6080604052348015600e575f80fd5b50600436106026575f3560e01c80630c55699c14602a575b5f80fd5b5f5460405190815260200160405180910390f3';

function register(p: import('commander').Command) {
  registerCertCommand(p);
  registerAttestRegistryCommand(p);
}

/**
 * CheckAttestationRegistry through the CLI on a local anvil (ADR 0004): deploy, attest a check report,
 * read it back, supersede it, revoke, and the refusals (code mismatch, monad-mainnet). No public RPC; the
 * subject is a contract placed with anvil_setCode and the reports are the Monad fixtures re-pointed at it.
 */
describe.skipIf(SKIP_ANVIL)('specfirst cert attest on anvil', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let registry: Address;
  let block: bigint;
  const savedEnv = { ...process.env };

  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;

  /** A fixture report re-pointed at SUBJECT on anvil, written under .specfirst/checks like `specfirst check`. */
  async function reportFor(fixture: string, over: { codeHash?: Hex; block?: bigint } = {}): Promise<{ rel: string; report: StandardCheckReport }> {
    const base = JSON.parse(await readFile(path.join(FIXTURES, fixture), 'utf8')) as StandardCheckReport;
    const b = over.block ?? block;
    const report: StandardCheckReport = {
      ...base,
      chainId: 31337,
      address: SUBJECT,
      blockNumber: b.toString(),
      identity: { ...base.identity, codeHash: over.codeHash ?? keccak256(SUBJECT_CODE) },
    };
    const rel = `.specfirst/checks/31337/${SUBJECT.toLowerCase()}/${b}${over.codeHash ? '-wrong' : ''}.json`;
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), `${JSON.stringify(report, null, 2)}\n`);
    parseCheckReport(JSON.stringify(report));
    return { rel, report };
  }

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    await clients.publicClient.request({ method: 'anvil_setCode' as never, params: [SUBJECT, SUBJECT_CODE] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    block = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-attest-'));
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: KEY, ISSUER_PRIVATE_KEY: KEY });
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses monad-mainnet for deploy and attest before touching any RPC', async () => {
    const dep = await cli('attest-registry', 'deploy', '--network', 'monad-mainnet', '--rpc', 'http://127.0.0.1:1');
    expect(dep.code).toBe(12);
    expect(dep.err).toMatch(/--network monad-mainnet is read-only/);
    const { rel } = await reportFor('morpho-143-109061472.json');
    const att = await cli('cert', 'attest', rel, '--network', 'monad-mainnet', '--rpc', 'http://127.0.0.1:1', '--registry-attest', SUBJECT);
    expect(att.code).toBe(14);
    expect(att.err).toMatch(/--network monad-mainnet is read-only/);
  });

  it('deploys the registry from the bundled bytecode and allows the deployer as issuer', async () => {
    const r = await cli('attest-registry', 'deploy', '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const e = event(r, 'attest-registry-deployed');
    expect(e).toMatchObject({ chainId: 31337, envName: 'SPECFIRST_ATTEST_REGISTRY_31337' });
    registry = e.address as Address;
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    expect(await reg.owner()).toBe(e.owner);
    expect(await reg.isIssuer(e.issuer as Address)).toBe(true);
  });

  it('asks for a registry address when none is configured', async () => {
    const { rel } = await reportFor('morpho-143-109061472.json');
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.code).toBe(14);
    expect(r.err).toMatch(/set SPECFIRST_ATTEST_REGISTRY_31337 or pass --registry-attest/);
  });

  it('attests an all-pass report: compliant, suiteHash equals the onchain suiteHashOf, report copied to certs/', async () => {
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = registry;
    const { rel, report } = await reportFor('morpho-143-109061472.json');
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const e = event(r, 'check-attested');
    expect(e).toMatchObject({ id: '0', subjectChainId: 31337, subject: SUBJECT, passCount: 30, failCount: 0, compliant: true, passedBitmap: (2n ** 30n - 1n).toString() });
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    expect(await reg.suiteHashOf(suiteOf(report))).toBe(suiteHash(suiteOf(report)));
    expect(e.suiteHash).toBe(suiteHash(suiteOf(report)));
    const latest = (await reg.latest(31337n, SUBJECT))!;
    expect(latest.id).toBe(0n);
    expect(latest.attestation).toMatchObject({ status: 1, subjectCodeHash: keccak256(SUBJECT_CODE), blockNumber: block, reportURI: `certs/checks/31337/${SUBJECT.toLowerCase()}/${block}.json` });
    expect(existsSync(path.join(dir, `certs/checks/31337/${SUBJECT.toLowerCase()}/${block}.json`))).toBe(true);

    const read = await cli('cert', 'attestation', '31337', SUBJECT, '--network', 'anvil');
    expect(read.code).toBe(0);
    expect(event(read, 'attestation')).toMatchObject({ found: true, id: '0', status: 'Valid', compliant: true, passCount: 30 });
  });

  it('refuses a report whose codeHash is not the subject code at that block; nothing is sent', async () => {
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const before = await reg.attestationCount();
    const { rel } = await reportFor('morpho-143-109061472.json', { codeHash: `0x${'12'.repeat(32)}` });
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.code).toBe(14);
    expect(r.err).toMatch(/refusing to attest: code at 0x5[fF]0+77 on chain 31337 block \d+ hashes to 0x[0-9a-f]{64}, the report says 0x1212/);
    expect(await reg.attestationCount()).toBe(before);
  });

  it('a newer report with failures supersedes the first; isCompliant turns false; revoke with evidence', async () => {
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x2'] as never });
    const later = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    const { rel } = await reportFor('upshift-143-109061472.json', { block: later });
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.code).toBe(0);
    expect(event(r, 'check-attested')).toMatchObject({ id: '1', passCount: 16, failCount: 2, inconclusiveCount: 12, compliant: false });
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const first = await reg.attestationOf(0n);
    expect(first.status).toBe(2);
    expect(first.supersededBy).toBe(1n);

    const older = await reportFor('morpho-143-109061472.json', { block });
    const stale = await cli('cert', 'attest', older.rel, '--network', 'anvil');
    expect(stale.code).toBe(14);
    expect(stale.err).toMatch(/OlderThanLatest/);

    await writeFile(path.join(dir, 'why.txt'), 'the upstream suite was misconfigured for this run\n');
    const rv = await cli('cert', 'revoke-attestation', '1', '--evidence', 'why.txt', '--network', 'anvil');
    expect(rv.code).toBe(0);
    expect(event(rv, 'attestation-revoked')).toMatchObject({ id: '1', reasonHash: keccak256(Buffer.from('the upstream suite was misconfigured for this run\n')) });
    const read = await cli('cert', 'attestation', '31337', SUBJECT, '--network', 'anvil');
    expect(event(read, 'attestation')).toMatchObject({ id: '1', status: 'Revoked', compliant: false });
    const again = await cli('cert', 'revoke-attestation', '1', '--evidence', 'why.txt', '--network', 'anvil');
    expect(again.code).toBe(14);
    expect(again.err).toMatch(/NotRevocable/);
  });

  it('a subject without attestations reads as not found, exit 0', async () => {
    const r = await cli('cert', 'attestation', '143', '0x802c91d807A8DaCA257c4708ab264B6520964e44', '--network', 'anvil');
    expect(r.code).toBe(0);
    expect(event(r, 'attestation')).toMatchObject({ found: false, compliant: false });
  });
});
