import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  AttestationRegistryClient,
  attestationReportPath,
  checkAttestationRegistryBytecode,
  checkReportHash,
  createChainClients,
  identifyImplementation,
  parseCheckReport,
  standardIdOf,
  suiteHash,
  suiteOf,
  type ChainClients,
  type StandardCheckReport,
} from '@specfirst/core';
import { getAddress, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerCertCommand } from '../src/commands/cert.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, '../../core/test/fixtures/attest');
/** Deployer (registry owner) and issuer are different accounts: anvil 0 and anvil 1. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const ISSUER_KEY = ANVIL_KEYS[1] as Hex;
const DEPLOYER = privateKeyToAccount(DEPLOYER_KEY).address;
const ISSUER = privateKeyToAccount(ISSUER_KEY).address;
const SUBJECT = getAddress('0x5f00000000000000000000000000000000000077');
const SUBJECT_CODE: Hex = '0x6080604052348015600e575f80fd5b50600436106026575f3560e01c80630c55699c14602a575b5f80fd5b5f5460405190815260200160405180910390f3';
/** Proxy-shaped code (PUSH32 EIP-1967 slot, SLOAD, DELEGATECALL) with nothing in the slot: proxy kind unknown. */
const UNKNOWN_PROXY = getAddress('0x5f00000000000000000000000000000000000078');
const UNKNOWN_PROXY_CODE: Hex = '0x365f5f375f5f365f7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d5f5f3e3d5ff3';
const ERC4626 = standardIdOf('erc4626');
const NOWHERE = 'http://127.0.0.1:1';

function register(p: import('commander').Command) {
  registerCertCommand(p);
  registerAttestRegistryCommand(p);
}

/**
 * Forwards JSON-RPC to anvil; once it has seen eth_sendRawTransaction it answers every eth_call with a
 * JSON-RPC error, so reads after the transaction fail while the transaction itself goes through.
 */
async function readsFailAfterSend(target: string): Promise<{ url: string; close: () => Promise<void> }> {
  let sent = false;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', async () => {
      const msg = JSON.parse(body) as { id: number; method: string };
      if (msg.method === 'eth_sendRawTransaction') sent = true;
      if (sent && msg.method === 'eth_call') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'eth_call blocked by the test after the send' } }));
        return;
      }
      const upstream = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(await upstream.text());
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/**
 * CheckAttestationRegistry through the CLI on a local anvil (ADR 0004): deploy with a deployer that is not
 * the issuer, attest a check report, read it back, supersede it, revoke, set-issuer, and the refusals
 * (identity mismatch, unknown proxy, wrong subject on revoke, monad-mainnet, anvil reports off anvil). No
 * public RPC; the subjects are contracts placed with anvil_setCode and the reports are the Monad fixtures
 * re-pointed at them with the identity identifyImplementation reads on anvil.
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
  const reg = () => new AttestationRegistryClient(registry, clients.publicClient);

  /** A fixture report re-pointed at `subject` on anvil, written under .specfirst/checks like `specfirst check`. */
  async function reportFor(
    fixture: string,
    over: { block?: bigint; subject?: Address; identity?: Partial<StandardCheckReport['identity']>; tag?: string } = {},
  ): Promise<{ rel: string; report: StandardCheckReport }> {
    const base = JSON.parse(await readFile(path.join(FIXTURES, fixture), 'utf8')) as StandardCheckReport;
    const b = over.block ?? block;
    const subject = over.subject ?? SUBJECT;
    const identity = await identifyImplementation(clients.publicClient, subject, b);
    const report: StandardCheckReport = {
      ...base,
      chainId: 31337,
      address: subject,
      blockNumber: b.toString(),
      identity: { ...identity, ...over.identity },
    };
    const rel = `.specfirst/checks/31337/${subject.toLowerCase()}/${b}${over.tag ? `-${over.tag}` : ''}.json`;
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), `${JSON.stringify(report, null, 2)}\n`);
    return { rel, report: parseCheckReport(JSON.stringify(report)) };
  }
  const copyOf = (report: StandardCheckReport) => `certs/checks/${attestationReportPath(report, checkReportHash(report))}`;

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    await clients.publicClient.request({ method: 'anvil_setCode' as never, params: [SUBJECT, SUBJECT_CODE] as never });
    await clients.publicClient.request({ method: 'anvil_setCode' as never, params: [UNKNOWN_PROXY, UNKNOWN_PROXY_CODE] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    block = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-attest-'));
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY, ISSUER_PRIVATE_KEY: ISSUER_KEY });
    delete process.env.SPECFIRST_ATTEST_REGISTRY_31337;
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses monad-mainnet for deploy, set-issuer and attest before touching any RPC', async () => {
    const dep = await cli('attest-registry', 'deploy', '--network', 'monad-mainnet', '--rpc', NOWHERE);
    expect(dep.code).toBe(12);
    expect(dep.err).toMatch(/--network monad-mainnet is read-only/);
    const set = await cli('attest-registry', 'set-issuer', ISSUER, '--network', 'monad-mainnet', '--rpc', NOWHERE, '--registry-attest', SUBJECT);
    expect(set.code).toBe(12);
    expect(set.err).toMatch(/--network monad-mainnet is read-only/);
    const { rel } = await reportFor('morpho-143-109061472.json');
    const att = await cli('cert', 'attest', rel, '--network', 'monad-mainnet', '--rpc', NOWHERE, '--registry-attest', SUBJECT);
    expect(att.code).toBe(14);
    expect(att.err).toMatch(/--network monad-mainnet is read-only/);
  });

  it('off anvil: refuses an anvil (31337) report and asks for --report-base-url, before any key or RPC', async () => {
    const { rel } = await reportFor('morpho-143-109061472.json');
    const anvilReport = await cli('cert', 'attest', rel, '--network', 'monad-testnet', '--rpc', NOWHERE, '--registry-attest', SUBJECT, '--report-base-url', 'https://example.org/checks');
    expect(anvilReport.code).toBe(14);
    expect(anvilReport.err).toMatch(/refusing to attest: the report is for chain 31337, a local anvil/);
    const mainnetReport = path.join(FIXTURES, 'morpho-143-109061472.json');
    const noBase = await cli('cert', 'attest', mainnetReport, '--network', 'monad-testnet', '--rpc', NOWHERE, '--registry-attest', SUBJECT);
    expect(noBase.code).toBe(14);
    expect(noBase.err).toMatch(/--report-base-url is required on monad-testnet.*https:\/\/raw\.githubusercontent\.com\/jaesimin0903\/specfirst\/main\/certs\/checks/);
    const badBase = await cli('cert', 'attest', mainnetReport, '--network', 'monad-testnet', '--rpc', NOWHERE, '--registry-attest', SUBJECT, '--report-base-url', 'ipfs://x');
    expect(badBase.code).toBe(14);
    expect(badBase.err).toMatch(/--report-base-url must be an http\(s\) URL/);
    const rev = await cli('cert', 'revoke-attestation', '0', '--evidence', rel, '--network', 'monad-testnet', '--rpc', NOWHERE, '--registry-attest', SUBJECT);
    expect(rev.code).toBe(14);
    expect(rev.err).toMatch(/--expect-subject <chainId>:<address> is required on monad-testnet/);
  });

  it('deploys with the deployer as owner and the ISSUER_PRIVATE_KEY address as issuer; the address is emitted before setIssuer', async () => {
    const r = await cli('attest-registry', 'deploy', '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.events.map((e) => e.type)).toEqual(['attest-registry-deployed', 'attest-registry-issuer-set']);
    const d = event(r, 'attest-registry-deployed');
    expect(d).toMatchObject({ chainId: 31337, owner: DEPLOYER, envName: 'SPECFIRST_ATTEST_REGISTRY_31337', creationCodeKeccak: keccak256(checkAttestationRegistryBytecode), warnings: [] });
    expect(event(r, 'attest-registry-issuer-set')).toMatchObject({ registry: d.address, issuer: ISSUER, allowed: true });
    registry = d.address as Address;
    expect(await reg().owner()).toBe(DEPLOYER);
    expect(await reg().isIssuer(ISSUER)).toBe(true);
    expect(await reg().isIssuer(DEPLOYER)).toBe(false);
  });

  it('warns when --issuer is not the ISSUER_PRIVATE_KEY address, and allows --issuer', async () => {
    const other = privateKeyToAccount(ANVIL_KEYS[2] as Hex).address;
    const r = await cli('attest-registry', 'deploy', '--network', 'anvil', '--issuer', other);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(new RegExp(`warning: --issuer ${other} is not the address of ISSUER_PRIVATE_KEY \\(${ISSUER}\\)`));
    expect((event(r, 'attest-registry-deployed').warnings as string[])[0]).toMatch(/is not the address of ISSUER_PRIVATE_KEY/);
    const second = new AttestationRegistryClient(event(r, 'attest-registry-deployed').address as Address, clients.publicClient);
    expect(await second.isIssuer(other)).toBe(true);
    expect(await second.isIssuer(ISSUER)).toBe(false);
  });

  it('when setIssuer fails after the deploy, the address is already out and the error says how to finish', async () => {
    const proxy = await readsFailAfterSend(anvil.url);
    try {
      const r = await cli('attest-registry', 'deploy', '--network', 'anvil', '--rpc', proxy.url);
      expect(r.code).toBe(12);
      const d = event(r, 'attest-registry-deployed');
      expect(d.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(r.err).toMatch(new RegExp(`CheckAttestationRegistry is deployed at ${d.address} \\(tx 0x[0-9a-f]{64}\\), but setIssuer\\(${ISSUER}\\) failed`));
      expect(r.err).toMatch(new RegExp(`specfirst attest-registry set-issuer ${ISSUER} --registry-attest ${d.address}`));
      expect(await clients.publicClient.getCode({ address: d.address as Address })).toMatch(/^0x60/);
      expect(await new AttestationRegistryClient(d.address as Address, clients.publicClient).isIssuer(ISSUER)).toBe(false);
    } finally {
      await proxy.close();
    }
  });

  it('asks for a registry address when none is configured', async () => {
    const { rel } = await reportFor('morpho-143-109061472.json');
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.code).toBe(14);
    expect(r.err).toMatch(/set SPECFIRST_ATTEST_REGISTRY_31337 or pass --registry-attest/);
  });

  it('attests an all-pass report: id from the receipt, compliant, suiteHash equals the onchain suiteHashOf, report copied first', async () => {
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = registry;
    const { rel, report } = await reportFor('morpho-143-109061472.json');
    const copy = copyOf(report);
    expect(copy).toMatch(new RegExp(`^certs/checks/31337/${SUBJECT.toLowerCase()}/${block}-[0-9a-f]{16}\\.json$`));
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const e = event(r, 'check-attested');
    expect(e).toMatchObject({
      id: '0',
      subjectChainId: 31337,
      subject: SUBJECT,
      standard: 'erc4626',
      standardId: ERC4626,
      passCount: 30,
      failCount: 0,
      compliant: true,
      proxyKind: null,
      unknownProxyAllowed: false,
      passedBitmap: (2n ** 30n - 1n).toString(),
      reportURI: copy,
      reportCopy: copy,
      warnings: [],
    });
    expect(await reg().suiteHashOf(suiteOf(report))).toBe(suiteHash(suiteOf(report)));
    expect(e.suiteHash).toBe(suiteHash(suiteOf(report)));
    const latest = (await reg().latest(31337n, SUBJECT, ERC4626))!;
    expect(latest.id).toBe(0n);
    expect(latest.attestation).toMatchObject({ status: 1, issuer: ISSUER, standardId: ERC4626, subjectCodeHash: keccak256(SUBJECT_CODE), blockNumber: block, reportURI: copy });
    expect(await reg().isCompliantWith(31337n, SUBJECT, ERC4626, e.suiteHash as Hex)).toBe(true);
    expect(await reg().isCompliantWith(31337n, SUBJECT, ERC4626, `0x${'00'.repeat(32)}`)).toBe(false);
    expect(await readFile(path.join(dir, copy), 'utf8')).toBe(await readFile(path.join(dir, rel), 'utf8'));

    const read = await cli('cert', 'attestation', '31337', SUBJECT, '--network', 'anvil');
    expect(read.code).toBe(0);
    expect(event(read, 'attestation')).toMatchObject({ found: true, id: '0', standard: 'erc4626', status: 'Valid', compliant: true, passCount: 30 });
  });

  it('refuses a report whose identity is not the subject at that block; nothing is sent and nothing copied', async () => {
    const before = await reg().attestationCount();
    const wrongCode = await reportFor('morpho-143-109061472.json', { identity: { codeHash: `0x${'12'.repeat(32)}` }, tag: 'wrong-code' });
    const r = await cli('cert', 'attest', wrongCode.rel, '--network', 'anvil');
    expect(r.code).toBe(14);
    expect(r.err).toMatch(/refusing to attest: code at 0x5[fF]0+77 on chain 31337 block \d+ hashes to 0x[0-9a-f]{64}, the report says 0x1212/);
    expect(existsSync(path.join(dir, copyOf(wrongCode.report)))).toBe(false);

    const wrongKey = await reportFor('morpho-143-109061472.json', { identity: { implementationKey: `0x${'34'.repeat(32)}` }, tag: 'wrong-key' });
    const k = await cli('cert', 'attest', wrongKey.rel, '--network', 'anvil');
    expect(k.code).toBe(14);
    expect(k.err).toMatch(/refusing to attest: identity of 0x5[fF]0+77 on chain 31337 block \d+ differs from the report: implementationKey: report "0x3434/);
    expect(await reg().attestationCount()).toBe(before);
  });

  it('refuses a subject whose proxy implementation is unknown unless --allow-unknown-proxy, and records that it was allowed', async () => {
    const { rel } = await reportFor('morpho-143-109061472.json', { subject: UNKNOWN_PROXY });
    const refused = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(refused.code).toBe(14);
    expect(refused.err).toMatch(/implementation could not be resolved \(proxy kind unknown\).*--allow-unknown-proxy/);
    const allowed = await cli('cert', 'attest', rel, '--network', 'anvil', '--allow-unknown-proxy');
    expect(allowed.err).toBe('');
    expect(allowed.code).toBe(0);
    expect(event(allowed, 'check-attested')).toMatchObject({ subject: UNKNOWN_PROXY, proxyKind: 'unknown', unknownProxyAllowed: true });
    process.exitCode = undefined;
    const human = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--project', dir, 'cert', 'attest', rel, '--network', 'anvil', '--allow-unknown-proxy']));
    expect(human.out.join('\n')).toMatch(/proxy implementation not resolved \(kind unknown\).*attested with --allow-unknown-proxy/);
  });

  it('a newer report with failures supersedes the first; revoke checks the subject first; a revoked latest lets an earlier block in', async () => {
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x2'] as never });
    const later = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
    const { rel } = await reportFor('upshift-143-109061472.json', { block: later });
    const r = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(r.code).toBe(0);
    const e = event(r, 'check-attested');
    expect(e).toMatchObject({ passCount: 16, failCount: 2, inconclusiveCount: 12, compliant: false });
    const id = e.id as string;
    const first = await reg().attestationOf(0n);
    expect(first.status).toBe(2);
    expect(first.supersededBy).toBe(BigInt(id));

    const older = await reportFor('morpho-143-109061472.json', { block });
    const stale = await cli('cert', 'attest', older.rel, '--network', 'anvil');
    expect(stale.code).toBe(14);
    expect(stale.err).toMatch(/OlderThanLatest/);

    await writeFile(path.join(dir, 'why.txt'), 'the report was recorded with the wrong block\n');
    const wrong = await cli('cert', 'revoke-attestation', id, '--evidence', 'why.txt', '--network', 'anvil', '--expect-subject', `143:${SUBJECT}`);
    expect(wrong.code).toBe(14);
    expect(wrong.err).toMatch(new RegExp(`refusing to revoke: attestation ${id} is about 31337:${SUBJECT}, --expect-subject says 143:${SUBJECT}; nothing was sent`));
    expect((await reg().attestationOf(BigInt(id))).status).toBe(1);
    const unknown = await cli('cert', 'revoke-attestation', '999', '--evidence', 'why.txt', '--network', 'anvil');
    expect(unknown.code).toBe(14);
    expect(unknown.err).toMatch(/refusing to revoke: no attestation with id 999 \(UnknownAttestation\)/);

    const rv = await cli('cert', 'revoke-attestation', id, '--evidence', 'why.txt', '--network', 'anvil', '--expect-subject', `31337:${SUBJECT}`);
    expect(rv.err).toBe('');
    expect(rv.code).toBe(0);
    expect(event(rv, 'attestation-revoked')).toMatchObject({
      id,
      subjectChainId: '31337',
      subject: SUBJECT,
      standardId: ERC4626,
      previousStatus: 'Valid',
      reasonHash: keccak256(Buffer.from('the report was recorded with the wrong block\n')),
    });
    const read = await cli('cert', 'attestation', '31337', SUBJECT, '--network', 'anvil');
    expect(event(read, 'attestation')).toMatchObject({ id, status: 'Revoked', compliant: false });
    const again = await cli('cert', 'revoke-attestation', id, '--evidence', 'why.txt', '--network', 'anvil');
    expect(again.code).toBe(14);
    expect(again.err).toMatch(/NotRevocable/);

    // The latest is Revoked, so the report for the earlier block is accepted now and becomes the latest.
    const recovered = await cli('cert', 'attest', older.rel, '--network', 'anvil');
    expect(recovered.code).toBe(0);
    expect(event(recovered, 'check-attested')).toMatchObject({ compliant: true, subjectBlockNumber: block.toString() });
  });

  it('after the transaction, a failed isCompliant read is a warning: exit 0, the event carries it', async () => {
    const proxy = await readsFailAfterSend(anvil.url);
    try {
      await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
      const now = await clients.publicClient.getBlockNumber({ cacheTime: 0 });
      // A schemaVersion 2 report (with vaultKind) goes through like a version 1 report.
      const { rel, report } = await reportFor('morpho-v2-143-109061472.json', { block: now });
      expect(report).toMatchObject({ schemaVersion: 2, vaultKind: 'erc4626' });
      const before = await reg().attestationCount();
      const r = await cli('cert', 'attest', rel, '--network', 'anvil', '--rpc', proxy.url);
      expect(r.code).toBe(0);
      expect(r.err).toMatch(/specfirst cert attest: warning: attestation \d+ is recorded \(tx 0x[0-9a-f]{64}\), but reading isCompliant failed/);
      const e = event(r, 'check-attested');
      expect(e).toMatchObject({ id: before.toString(), compliant: null });
      expect((e.warnings as string[])[0]).toMatch(/reading isCompliant failed/);
      expect(await reg().attestationCount()).toBe(before + 1n);
      expect(existsSync(path.join(dir, copyOf(report)))).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('set-issuer: only the owner; a removed issuer cannot attest, its attestations stay Valid and compliant', async () => {
    const latest = (await reg().latest(31337n, SUBJECT, ERC4626))!;
    expect(await reg().isCompliant(31337n, SUBJECT, ERC4626)).toBe(true);

    process.env.DEPLOYER_PRIVATE_KEY = ISSUER_KEY; // not the owner
    const notOwner = await cli('attest-registry', 'set-issuer', ISSUER, '--remove', '--network', 'anvil');
    expect(notOwner.code).toBe(12);
    expect(notOwner.err).toMatch(/setIssuer failed \(NotOwner\)/);
    process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;

    const removed = await cli('attest-registry', 'set-issuer', ISSUER, '--remove', '--network', 'anvil');
    expect(removed.err).toBe('');
    expect(removed.code).toBe(0);
    expect(event(removed, 'attest-registry-issuer-set')).toMatchObject({ registry, issuer: ISSUER, allowed: false });
    expect(await reg().isIssuer(ISSUER)).toBe(false);
    expect((await reg().attestationOf(latest.id)).status).toBe(1);
    expect(await reg().isCompliant(31337n, SUBJECT, ERC4626)).toBe(true);

    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    const { rel } = await reportFor('morpho-143-109061472.json', { block: await clients.publicClient.getBlockNumber({ cacheTime: 0 }) });
    const refused = await cli('cert', 'attest', rel, '--network', 'anvil');
    expect(refused.code).toBe(14);
    expect(refused.err).toMatch(/NotIssuer/);

    const back = await cli('attest-registry', 'set-issuer', ISSUER, '--network', 'anvil');
    expect(back.code).toBe(0);
    expect(await reg().isIssuer(ISSUER)).toBe(true);
  });

  it('a subject without attestations reads as not found, exit 0', async () => {
    const r = await cli('cert', 'attestation', '143', '0x802c91d807A8DaCA257c4708ab264B6520964e44', '--network', 'anvil');
    expect(r.code).toBe(0);
    expect(event(r, 'attestation')).toMatchObject({ found: false, compliant: false, standard: 'erc4626' });
  });
});
