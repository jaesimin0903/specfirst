import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  anvilChain,
  AttestationRegistryClient,
  checkReportHash,
  checkRequestDeskBytecode,
  createChainClients,
  identifyImplementation,
  parseCheckReport,
  reasonOf,
  REQUEST_STATUS,
  RequestDeskClient,
  standardIdOf,
  workerStateSchema,
  workerStatusSchema,
  type ChainClients,
  type RunStandardCheckInput,
  type StandardCheckReport,
  type WorkerRequestStatus,
} from '@specfirst/core';
import { getAddress, keccak256, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerAttestRegistryCommand } from '../src/commands/attest.js';
import { registerDeskCommand, registerWorkerCommand } from '../src/commands/desk.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MORPHO = path.resolve(here, '../../core/test/fixtures/attest/morpho-143-109061472.json');
/** Owner, worker (registry issuer), requester and a stranger are four different anvil accounts. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const ISSUER_KEY = ANVIL_KEYS[1] as Hex;
const REQUESTER_KEY = ANVIL_KEYS[2] as Hex;
const STRANGER_KEY = ANVIL_KEYS[3] as Hex;
const DEPLOYER = privateKeyToAccount(DEPLOYER_KEY).address;
const ISSUER = privateKeyToAccount(ISSUER_KEY).address;
const REQUESTER = privateKeyToAccount(REQUESTER_KEY).address;
const TOKEN = getAddress('0x5f000000000000000000000000000000000000aa');
/** Answers every call with TOKEN as one word: asset() is TOKEN, totalAssets() a number. PUSH20 TOKEN, MSTORE at 0, RETURN 32 bytes. */
const VAULT_CODE: Hex = `0x73${TOKEN.slice(2).toLowerCase()}5f5260205ff3`;
const VAULT = getAddress('0x5f00000000000000000000000000000000000101');
const FAILING_VAULT = getAddress('0x5f00000000000000000000000000000000000102');
/** One function x(); asset() reverts. */
const NOT_VAULT = getAddress('0x5f00000000000000000000000000000000000103');
const NOT_VAULT_CODE: Hex = '0x6080604052348015600e575f80fd5b50600436106026575f3560e01c80630c55699c14602a575b5f80fd5b5f5460405190815260200160405180910390f3';
const TREASURY = getAddress('0x5f000000000000000000000000000000000000ee');
const FEE = parseEther('0.5');
const TIMEOUT = 3600;
const NOWHERE = 'http://127.0.0.1:1';
const BASE = 'https://example.org/checks';

/**
 * The request desk through the CLI on a local anvil (ADR 0005): registry and desk deployed, requests paid
 * from REQUESTER_PRIVATE_KEY, one `worker --once` pass that fulfills a vault (attestation included), rejects
 * a contract without asset() and a vault whose check keeps failing (both refunded), an expiry refund,
 * withdraw of earned fees only, status, and the refusals. The subject chain is the same anvil; the property
 * suite is replaced by a function that returns the Morpho fixture re-pointed at the subject with the identity
 * read on anvil, so no forge and no public RPC run here.
 */
describe.skipIf(SKIP_ANVIL)('specfirst desk and worker on anvil', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let registry: Address;
  let desk: Address;
  const checks: Array<{ address: Address; block: bigint }> = [];
  const savedEnv = { ...process.env };

  const runCheck = async (input: RunStandardCheckInput): Promise<StandardCheckReport> => {
    checks.push({ address: input.address, block: input.blockNumber! });
    if (input.address === FAILING_VAULT) throw new Error('forge exited with code 1: could not fork');
    const base = JSON.parse(await readFile(MORPHO, 'utf8')) as StandardCheckReport;
    const identity = await identifyImplementation(clients.publicClient, input.address, input.blockNumber!);
    return parseCheckReport(JSON.stringify({ ...base, chainId: 31337, address: input.address, blockNumber: input.blockNumber!.toString(), identity }));
  };
  const register = (p: import('commander').Command) => {
    registerAttestRegistryCommand(p);
    registerDeskCommand(p);
    registerWorkerCommand(p, { runCheck, config: { maxAttempts: 2, retryDelaysMs: [0] }, sleep: async () => {} });
  };
  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(register).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;
  const deskClient = () => new RequestDeskClient(desk, clients.publicClient);
  const balance = (a: Address) => clients.publicClient.getBalance({ address: a });
  const status = async () => workerStatusSchema.parse(JSON.parse(await readFile(path.join(dir, '.specfirst/worker/status.json'), 'utf8')));
  const worker = (...extra: string[]) => cli('worker', '--network', 'anvil', '--subject-rpc', anvil.url, '--once', '--block-lag', '0', '--report-base-url', BASE, ...extra);

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    for (const [a, code] of [
      [VAULT, VAULT_CODE],
      [FAILING_VAULT, VAULT_CODE],
      [NOT_VAULT, NOT_VAULT_CODE],
    ] as const) {
      await clients.publicClient.request({ method: 'anvil_setCode' as never, params: [a, code] as never });
    }
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-desk-'));
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY, ISSUER_PRIVATE_KEY: ISSUER_KEY });
    for (const k of ['REQUESTER_PRIVATE_KEY', 'SPECFIRST_ATTEST_REGISTRY_31337', 'SPECFIRST_DESK_31337', 'SPECFIRST_REPORT_BASE_URL']) delete process.env[k];
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses monad-mainnet for every command that sends, before any key or RPC', async () => {
    for (const args of [
      ['desk', 'deploy'],
      ['desk', 'request', VAULT],
      ['desk', 'withdraw', '--to', TREASURY],
      ['worker', '--once'],
    ]) {
      const r = await cli(...args, '--network', 'monad-mainnet', '--rpc', NOWHERE);
      expect(r.code, args.join(' ')).toBe(18);
      expect(r.err).toMatch(/--network monad-mainnet is read-only/);
    }
  });

  it('deploys the desk: owner is the deployer, worker the ISSUER_PRIVATE_KEY address, registry from the env', async () => {
    const reg = await cli('attest-registry', 'deploy', '--network', 'anvil');
    expect(reg.code).toBe(0);
    registry = event(reg, 'attest-registry-deployed').address as Address;

    const missing = await cli('desk', 'deploy', '--network', 'anvil');
    expect(missing.code).toBe(18);
    expect(missing.err).toMatch(/set SPECFIRST_ATTEST_REGISTRY_31337 or pass --registry-attest/);
    process.env.SPECFIRST_ATTEST_REGISTRY_31337 = registry;
    expect((await cli('desk', 'deploy', '--network', 'anvil', '--fee', '0.1234567890123456789')).err).toMatch(/--fee must be a decimal amount of MON/);
    expect((await cli('desk', 'deploy', '--network', 'anvil', '--timeout', '0')).err).toMatch(/--timeout must be a positive integer/);

    const r = await cli('desk', 'deploy', '--network', 'anvil', '--fee', '0.5', '--timeout', String(TIMEOUT));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const d = event(r, 'desk-deployed');
    expect(d).toMatchObject({
      chainId: 31337,
      owner: DEPLOYER,
      worker: ISSUER,
      registry,
      fee: FEE.toString(),
      timeout: String(TIMEOUT),
      envName: 'SPECFIRST_DESK_31337',
      creationCodeKeccak: keccak256(checkRequestDeskBytecode),
      warnings: [],
    });
    desk = d.address as Address;
    const s = await deskClient().summary();
    expect(s).toMatchObject({ owner: DEPLOYER, worker: ISSUER, registry, fee: FEE, timeout: BigInt(TIMEOUT), requestCount: 0n });
    process.env.SPECFIRST_DESK_31337 = desk;

    const other = privateKeyToAccount(STRANGER_KEY).address;
    const warned = await cli('desk', 'deploy', '--network', 'anvil', '--worker', other, '--fee', '0');
    expect(warned.code).toBe(0);
    expect(warned.err).toMatch(/warning: the fee is 0: anyone can queue checks for free/);
    expect(warned.err).toMatch(new RegExp(`warning: worker ${other} is not an issuer of ${registry}`));
    expect(warned.err).toMatch(/--worker .* is not the address of ISSUER_PRIVATE_KEY/);
  });

  it('desk request pays exactly the fee from REQUESTER_PRIVATE_KEY and refuses to run without it', async () => {
    const none = await cli('desk', 'request', VAULT, '--subject-chain', '31337', '--network', 'anvil');
    expect(none.code).toBe(18);
    expect(none.err).toMatch(/REQUESTER_PRIVATE_KEY is not set/);
    process.env.REQUESTER_PRIVATE_KEY = REQUESTER_KEY;
    const ids: string[] = [];
    for (const subject of [VAULT, NOT_VAULT, FAILING_VAULT]) {
      const r = await cli('desk', 'request', subject, '--subject-chain', '31337', '--network', 'anvil');
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      const e = event(r, 'desk-requested');
      expect(e).toMatchObject({ desk, requester: REQUESTER, subjectChainId: '31337', subject, standard: 'erc4626', standardId: standardIdOf('erc4626'), fee: FEE.toString() });
      ids.push(e.id as string);
    }
    expect(ids).toEqual(['0', '1', '2']);
    expect(await deskClient().escrowed()).toBe(3n * FEE);
    expect(await balance(desk)).toBe(3n * FEE);
  });

  it('worker --once: fulfills the vault with an attestation, rejects and refunds the others, writes status.json', async () => {
    const before = await balance(REQUESTER);
    const r = await worker();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.events[0]).toMatchObject({ type: 'worker-start', worker: ISSUER, desk, chainId: 31337, registry, subjectChainId: 31337, runs: 16, reportBaseUrl: BASE, statusPath: '.specfirst/worker/status.json' });
    expect(event(r, 'worker-pass')).toMatchObject({ requestCount: '3', cursor: '0', open: ['0', '1', '2'] });
    expect(event(r, 'worker-pass-done')).toEqual({ type: 'worker-pass-done', cursor: '3', fulfilled: ['0'], rejected: ['1', '2'], open: [] });
    expect(checks.map((c) => c.address)).toEqual([VAULT, FAILING_VAULT, FAILING_VAULT]);

    const dc = deskClient();
    const r0 = await dc.requestOf(0n);
    expect(REQUEST_STATUS[r0.status]).toBe('Fulfilled');
    const reg = new AttestationRegistryClient(registry, clients.publicClient);
    const a = await reg.attestationOf(r0.attestationId);
    expect(a).toMatchObject({ subjectChainId: 31337n, subject: VAULT, standardId: standardIdOf('erc4626'), issuer: ISSUER, blockNumber: checks[0]!.block, passCount: 30 });
    expect(a.issuedAt >= r0.requestedAt).toBe(true);
    expect(a.reportURI).toMatch(new RegExp(`^${BASE}/31337/${VAULT.toLowerCase()}/${checks[0]!.block}-[0-9a-f]{16}\\.json$`));
    const copy = path.join(dir, 'certs/checks', a.reportURI.slice(BASE.length + 1));
    expect(existsSync(copy)).toBe(true);
    expect(checkReportHash(parseCheckReport(await readFile(copy, 'utf8')))).toBe(a.reportHash);

    const r1 = await dc.requestOf(1n);
    const r2 = await dc.requestOf(2n);
    expect([REQUEST_STATUS[r1.status], reasonOf(r1.rejectReason)]).toEqual(['Rejected', 'not-erc4626']);
    expect([REQUEST_STATUS[r2.status], reasonOf(r2.rejectReason)]).toEqual(['Rejected', 'check-failed']);
    // Both rejects refunded the whole fee in their own transaction; the requester paid no gas for them.
    expect(await balance(REQUESTER)).toBe(before + 2n * FEE);
    expect(await dc.earned()).toBe(FEE);
    expect(await dc.escrowed()).toBe(0n);

    const s = await status();
    const e0 = s['0'] as WorkerRequestStatus;
    expect(e0).toMatchObject({ stage: 'fulfilled', block: checks[0]!.block.toString(), attestationId: r0.attestationId.toString(), reportPath: path.relative(dir, copy) });
    expect(e0.txs.attest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(e0.txs.fulfill).toMatch(/^0x[0-9a-f]{64}$/);
    expect(BigInt(e0.gasCostWei!)).toBeGreaterThan(0n);
    expect(s['1']).toMatchObject({ stage: 'rejected', error: expect.stringMatching(/^not-erc4626: asset\(\) failed at block \d+/) });
    expect(s['2']).toMatchObject({ stage: 'rejected', error: 'check-failed: check: forge exited with code 1: could not fork' });
    const gas = [s['0'], s['1'], s['2']].reduce((n, e) => n + BigInt((e as WorkerRequestStatus).gasCostWei!), 0n);
    expect(s.totals).toEqual({ gasCostWei: gas.toString(), fulfilled: 1, rejected: 2 });
    const state = workerStateSchema.parse(JSON.parse(await readFile(path.join(dir, '.specfirst/worker/state.json'), 'utf8')));
    expect(state).toEqual({ version: 1, desk: desk.toLowerCase(), chainId: 31337, cursor: '3', requests: {} });
  });

  it('refundExpired: anyone, once requestedAt + timeout has passed; the worker then skips the request', async () => {
    const r = await cli('desk', 'request', VAULT, '--subject-chain', '31337', '--network', 'anvil');
    const id = BigInt(event(r, 'desk-requested').id as string);
    const stranger = new RequestDeskClient(desk, clients.publicClient, clients.wallet(STRANGER_KEY));
    await expect(stranger.refundExpired(id)).rejects.toThrow(/refundExpired failed \(NotExpired\)/);
    await clients.publicClient.request({ method: 'evm_increaseTime' as never, params: [TIMEOUT] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
    const before = await balance(REQUESTER);
    await stranger.refundExpired(id);
    expect(await balance(REQUESTER)).toBe(before + FEE);
    expect(REQUEST_STATUS[(await deskClient().requestOf(id)).status]).toBe('Refunded');

    const checksBefore = checks.length;
    const w = await worker();
    expect(w.code).toBe(0);
    expect(event(w, 'worker-pass-done')).toMatchObject({ cursor: '4', open: [] });
    expect(checks.length).toBe(checksBefore);
    expect((await status())[id.toString()]).toBeUndefined();
  });

  it('withdraw pays only the earned fees to --to; escrowed fees of Pending requests stay', async () => {
    await cli('desk', 'request', VAULT, '--subject-chain', '31337', '--network', 'anvil'); // #4 stays Pending
    const dc = deskClient();
    expect(await dc.escrowed()).toBe(FEE);

    process.env.DEPLOYER_PRIVATE_KEY = ISSUER_KEY;
    const notOwner = await cli('desk', 'withdraw', '--to', TREASURY, '--network', 'anvil');
    expect(notOwner.code).toBe(18);
    expect(notOwner.err).toMatch(new RegExp(`DEPLOYER_PRIVATE_KEY is ${ISSUER}, the desk owner is ${DEPLOYER}`));
    process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;

    const r = await cli('desk', 'withdraw', '--to', TREASURY, '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'desk-withdrawn')).toMatchObject({ desk, to: TREASURY, amount: FEE.toString(), earned: FEE.toString(), withdrawn: FEE.toString(), escrowed: FEE.toString() });
    expect(await balance(TREASURY)).toBe(FEE);
    expect(await balance(desk)).toBe(FEE);
    expect(await dc.escrowed()).toBe(FEE);

    const again = await cli('desk', 'withdraw', '--to', TREASURY, '--network', 'anvil');
    expect(again.code).toBe(18);
    expect(again.err).toMatch(/nothing to withdraw: earned 0\.5 MON, withdrawn 0\.5 MON; 0\.5 MON escrowed for Pending requests is not the owner's/);
  });

  it('status lists the requests and the books; one id; an unknown id fails', async () => {
    const r = await cli('desk', 'status', '--network', 'anvil');
    expect(r.code).toBe(0);
    const s = event(r, 'desk-status');
    expect(s).toMatchObject({ desk, owner: DEPLOYER, worker: ISSUER, registry, requestCount: '5', earned: FEE.toString(), withdrawn: FEE.toString(), withdrawable: '0', escrowed: FEE.toString(), balance: FEE.toString() });
    const reqs = s.requests as Array<Record<string, unknown>>;
    expect(reqs.map((x) => x.status)).toEqual(['Fulfilled', 'Rejected', 'Rejected', 'Refunded', 'Pending']);
    expect(reqs[1]).toMatchObject({ id: '1', subject: NOT_VAULT, rejectReason: 'not-erc4626', standard: 'erc4626' });
    expect(reqs[0]).toHaveProperty('attestationId');
    const last2 = await cli('desk', 'status', '--network', 'anvil', '--limit', '2');
    expect((event(last2, 'desk-status').requests as Array<{ id: string }>).map((x) => x.id)).toEqual(['3', '4']);
    const one = await cli('desk', 'status', '2', '--network', 'anvil');
    expect(event(one, 'desk-status').requests).toEqual([expect.objectContaining({ id: '2', rejectReason: 'check-failed' })]);
    const unknown = await cli('desk', 'status', '99', '--network', 'anvil');
    expect(unknown.code).toBe(18);
    expect(unknown.err).toMatch(/no request with id 99 \(UnknownRequest\)/);
  });

  it('the worker refuses a key that is not the desk worker, and a state.json of another desk', async () => {
    process.env.ISSUER_PRIVATE_KEY = STRANGER_KEY;
    const wrongKey = await worker();
    expect(wrongKey.code).toBe(18);
    expect(wrongKey.err).toMatch(new RegExp(`the desk's worker is ${ISSUER}, ISSUER_PRIVATE_KEY is ${privateKeyToAccount(STRANGER_KEY).address}`));
    process.env.ISSUER_PRIVATE_KEY = ISSUER_KEY;

    const second = await cli('desk', 'deploy', '--network', 'anvil');
    const otherDesk = event(second, 'desk-deployed').address as string;
    const mismatch = await worker('--desk', otherDesk);
    expect(mismatch.code).toBe(18);
    expect(mismatch.err).toMatch(new RegExp(`state.json belongs to desk ${desk.toLowerCase()} on chain 31337, not ${otherDesk.toLowerCase()}`));
  });

  it('a second worker on the same project directory is refused while the first is alive', async () => {
    const lock = path.join(dir, '.specfirst/worker/worker.lock');
    await writeFile(lock, `${process.ppid}\n`);
    const r = await worker();
    expect(r.code).toBe(18);
    expect(r.err).toMatch(new RegExp(`another worker \\(pid ${process.ppid}\\) is running`));
    await rm(lock);
  });

  it('human output: a pending request is worked through to fulfilled', async () => {
    process.exitCode = undefined;
    const r = await capture(() =>
      buildProgram(register).parseAsync(['node', 'specfirst', '--project', dir, 'worker', '--network', 'anvil', '--subject-rpc', anvil.url, '--once', '--block-lag', '0', '--report-base-url', BASE]),
    );
    expect(process.exitCode ?? 0).toBe(0);
    const out = r.out.join('\n');
    expect(out).toMatch(new RegExp(`worker\\s+${ISSUER}  desk ${desk}`));
    expect(out).toMatch(/#4 prechecking/);
    expect(out).toMatch(/#4 running {2}block \d+/);
    expect(out).toMatch(/#4 fulfilled {2}attestation \d+/);
    expect(REQUEST_STATUS[(await deskClient().requestOf(4n)).status]).toBe('Fulfilled');
    expect((await status()).totals).toMatchObject({ fulfilled: 2, rejected: 2 });
    expect(existsSync(path.join(dir, '.specfirst/worker/worker.lock'))).toBe(false);
  });
});
