import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { anvilChain, checkSubscriptionsBytecode, createChainClients, standardIdOf, SubscriptionsClient, type ChainClients } from '@specfirst/core';
import { getAddress, keccak256, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSubsCommand } from '../src/commands/subs.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

/** Owner, test subscriber and a stranger are three different anvil accounts. */
const DEPLOYER_KEY = ANVIL_KEYS[0] as Hex;
const REQUESTER_KEY = ANVIL_KEYS[2] as Hex;
const STRANGER_KEY = ANVIL_KEYS[3] as Hex;
const DEPLOYER = privateKeyToAccount(DEPLOYER_KEY).address;
const REQUESTER = privateKeyToAccount(REQUESTER_KEY).address;
const VAULT = getAddress('0x802c91d807A8DaCA257c4708ab264B6520964e44');
const OTHER = getAddress('0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E');
const TREASURY = getAddress('0x5f000000000000000000000000000000000000ee');
const FEE = parseEther('0.05');
const DAY = 86_400n;
const NOWHERE = 'http://127.0.0.1:1';

/**
 * CheckSubscriptions through the CLI on a local anvil (ADR 0006): deploy with the default fee, subscribe and extend
 * from REQUESTER_PRIVATE_KEY, time travel, status with the settleable amounts, settle without ids, cancel with a
 * refund of the days not started, an extend after expiry that starts a new run, withdraw of earned fees only, and
 * the refusals (monad-mainnet, missing keys, a key that is not the subscriber or the owner, bad days).
 */
describe.skipIf(SKIP_ANVIL)('specfirst subs on anvil', { timeout: 300_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let dir: string;
  let subs: Address;
  const savedEnv = { ...process.env };

  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(registerSubsCommand).parseAsync(['node', 'specfirst', '--json', '--project', dir, ...args]));
    const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err.join('\n') };
  };
  const event = (r: { events: Array<Record<string, unknown>> }, type: string) => r.events.find((e) => e.type === type)!;
  const client = () => new SubscriptionsClient(subs, clients.publicClient);
  const balance = (a: Address) => clients.publicClient.getBalance({ address: a });
  const travel = async (seconds: bigint) => {
    await clients.publicClient.request({ method: 'evm_increaseTime' as never, params: [Number(seconds)] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
  };

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-subs-'));
    Object.assign(process.env, { ANVIL_RPC: anvil.url, DEPLOYER_PRIVATE_KEY: DEPLOYER_KEY });
    for (const k of ['REQUESTER_PRIVATE_KEY', 'SPECFIRST_SUBS_31337']) delete process.env[k];
  }, 60_000);

  afterAll(async () => {
    process.env = savedEnv;
    process.exitCode = undefined;
    await anvil?.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('refuses monad-mainnet for every command that sends, before any key or RPC', async () => {
    for (const args of [
      ['subs', 'deploy'],
      ['subs', 'subscribe', VAULT, '--days', '1'],
      ['subs', 'extend', '0', '--days', '1'],
      ['subs', 'settle'],
      ['subs', 'cancel', '0'],
      ['subs', 'withdraw'],
    ]) {
      const r = await cli(...args, '--network', 'monad-mainnet', '--rpc', NOWHERE);
      expect(r.code, args.join(' ')).toBe(19);
      expect(r.err).toMatch(/--network monad-mainnet is read-only/);
    }
  });

  it('deploys with DEPLOYER_PRIVATE_KEY as owner and 0.05 MON per day by default', async () => {
    expect((await cli('subs', 'deploy', '--network', 'anvil', '--fee-per-day', 'x')).err).toMatch(/--fee-per-day must be a decimal amount of MON/);
    const r = await cli('subs', 'deploy', '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const d = event(r, 'subs-deployed');
    expect(d).toMatchObject({ chainId: 31337, owner: DEPLOYER, feePerDay: FEE.toString(), envName: 'SPECFIRST_SUBS_31337', creationCodeKeccak: keccak256(checkSubscriptionsBytecode), warnings: [] });
    subs = d.address as Address;
    expect(await client().summary()).toMatchObject({ owner: DEPLOYER, feePerDay: FEE, subscriptionCount: 0n });
    const free = await cli('subs', 'deploy', '--network', 'anvil', '--fee-per-day', '0');
    expect(free.code).toBe(0);
    expect(free.err).toMatch(/warning: the fee per day is 0/);
  });

  it('subscribe and extend pay from REQUESTER_PRIVATE_KEY and refuse to run without it', async () => {
    const none = await cli('subs', 'subscribe', VAULT, '--days', '5', '--network', 'anvil', '--subs', subs);
    expect(none.code).toBe(19);
    expect(none.err).toMatch(/REQUESTER_PRIVATE_KEY is not set/);
    process.env.REQUESTER_PRIVATE_KEY = REQUESTER_KEY;
    const missing = await cli('subs', 'subscribe', VAULT, '--days', '5', '--network', 'anvil');
    expect(missing.err).toMatch(/set SPECFIRST_SUBS_31337 or pass --subs/);
    process.env.SPECFIRST_SUBS_31337 = subs;
    for (const days of ['0', '366', '1.5']) {
      expect((await cli('subs', 'subscribe', VAULT, '--days', days, '--network', 'anvil')).err).toMatch(/--days must be a positive integer up to 365/);
    }

    const r = await cli('subs', 'subscribe', VAULT, '--days', '5', '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const s = event(r, 'subs-subscribed');
    expect(s).toMatchObject({ id: '0', subs, subscriber: REQUESTER, subjectChainId: '143', subject: VAULT, standard: 'erc4626', standardId: standardIdOf('erc4626'), days: 5, paid: (5n * FEE).toString() });
    const startsAt = (await client().subscriptionOf(0n)).startsAt;
    expect(s.endsAt).toBe((startsAt + 5n * DAY).toString());

    const e = await cli('subs', 'extend', '0', '--days', '2', '--network', 'anvil');
    expect(e.code).toBe(0);
    expect(event(e, 'subs-extended')).toMatchObject({ id: '0', payer: REQUESTER, days: 2, paid: (2n * FEE).toString(), endsAt: (startsAt + 7n * DAY).toString() });
    expect(await client().escrowed()).toBe(7n * FEE);
    expect((await cli('subs', 'extend', '9', '--days', '1', '--network', 'anvil')).err).toMatch(/no subscription with id 9 \(UnknownSubscription\)/);
  });

  it('status shows what is settleable after time passes; settle without ids moves it to earned', async () => {
    await travel(2n * DAY + 60n);
    const st = await cli('subs', 'status', '--network', 'anvil');
    expect(st.code).toBe(0);
    const s = event(st, 'subs-status');
    expect(s).toMatchObject({ subs, owner: DEPLOYER, feePerDay: FEE.toString(), subscriptionCount: '1', earned: '0', escrowed: (7n * FEE).toString(), settleable: (3n * FEE).toString() });
    expect(s.subscriptions).toEqual([
      expect.objectContaining({ id: '0', subscriber: REQUESTER, active: true, cancelled: false, paid: (7n * FEE).toString(), settled: '0', settleable: (3n * FEE).toString(), refundable: (4n * FEE).toString() }),
    ]);

    const r = await cli('subs', 'settle', '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'subs-settled')).toMatchObject({ ids: ['0'], settled: [{ id: '0', amount: (3n * FEE).toString() }], total: (3n * FEE).toString() });
    expect(await client().earned()).toBe(3n * FEE);
    const again = await cli('subs', 'settle', '--network', 'anvil');
    expect(event(again, 'subs-settled')).toMatchObject({ ids: [], settled: [], total: '0', txHashes: [] });
    const explicit = await cli('subs', 'settle', '0', '--network', 'anvil');
    expect(event(explicit, 'subs-settled')).toMatchObject({ ids: ['0'], settled: [], total: '0' });
    expect((event(explicit, 'subs-settled').txHashes as string[]).length).toBe(1);
  });

  it('cancel: only the subscriber; refunds the days not started and ends the subscription', async () => {
    process.env.REQUESTER_PRIVATE_KEY = STRANGER_KEY;
    const notMine = await cli('subs', 'cancel', '0', '--network', 'anvil');
    expect(notMine.code).toBe(19);
    expect(notMine.err).toMatch(new RegExp(`REQUESTER_PRIVATE_KEY is ${privateKeyToAccount(STRANGER_KEY).address}, subscription #0 belongs to ${REQUESTER}`));
    process.env.REQUESTER_PRIVATE_KEY = REQUESTER_KEY;

    const before = await balance(REQUESTER);
    const r = await cli('subs', 'cancel', '0', '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'subs-cancelled')).toMatchObject({ id: '0', subscriber: REQUESTER, refund: (4n * FEE).toString(), settled: '0' });
    expect(await balance(REQUESTER)).toBeGreaterThan(before + 4n * FEE - parseEther('0.01'));
    expect(await client().isActive(0n)).toBe(false);
    expect(await client().escrowed()).toBe(0n);
    const twice = await cli('subs', 'cancel', '0', '--network', 'anvil');
    expect(twice.code).toBe(19);
    expect(twice.err).toMatch(/cancel failed \(AlreadyCancelled\)/);
  });

  it('extend after expiry starts a new run now: the days in between are not charged', async () => {
    const r = await cli('subs', 'subscribe', OTHER, '--days', '1', '--network', 'anvil');
    const id = event(r, 'subs-subscribed').id as string;
    await travel(3n * DAY);
    await cli('subs', 'extend', id, '--days', '2', '--network', 'anvil');
    const now = (await clients.publicClient.getBlock()).timestamp;
    const sub = await client().subscriptionOf(BigInt(id));
    expect([sub.startsAt, sub.endsAt, sub.paid]).toEqual([now, now + 2n * DAY, 3n * FEE]);
    const st = await cli('subs', 'status', id, '--network', 'anvil');
    expect(event(st, 'subs-status').subscriptions).toEqual([expect.objectContaining({ id, active: true, settleable: (2n * FEE).toString(), refundable: FEE.toString() })]);
  });

  it('withdraw pays only earned fees, to the owner by default; escrowed fees stay', async () => {
    process.env.DEPLOYER_PRIVATE_KEY = STRANGER_KEY;
    const notOwner = await cli('subs', 'withdraw', '--network', 'anvil');
    expect(notOwner.code).toBe(19);
    expect(notOwner.err).toMatch(new RegExp(`DEPLOYER_PRIVATE_KEY is ${privateKeyToAccount(STRANGER_KEY).address}, the owner is ${DEPLOYER}`));
    process.env.DEPLOYER_PRIVATE_KEY = DEPLOYER_KEY;

    const r = await cli('subs', 'withdraw', '--to', TREASURY, '--network', 'anvil');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(event(r, 'subs-withdrawn')).toMatchObject({ to: TREASURY, amount: (3n * FEE).toString(), earned: (3n * FEE).toString(), escrowed: (3n * FEE).toString() });
    expect(await balance(TREASURY)).toBe(3n * FEE);
    expect(await balance(subs)).toBe(3n * FEE);

    const nothing = await cli('subs', 'withdraw', '--network', 'anvil');
    expect(nothing.code).toBe(19);
    expect(nothing.err).toMatch(/nothing to withdraw: earned 0\.15 MON, withdrawn 0\.15 MON; 0\.15 MON escrowed for days not settled yet/);
    await cli('subs', 'settle', '--network', 'anvil');
    const owner = await cli('subs', 'withdraw', '--network', 'anvil');
    expect(event(owner, 'subs-withdrawn')).toMatchObject({ to: DEPLOYER, amount: (2n * FEE).toString() });
  });

  it('status of one id, an unknown id, and the human output', async () => {
    const unknown = await cli('subs', 'status', '99', '--network', 'anvil');
    expect(unknown.code).toBe(19);
    expect(unknown.err).toMatch(/no subscription with id 99 \(UnknownSubscription\)/);
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(registerSubsCommand).parseAsync(['node', 'specfirst', '--project', dir, 'subs', 'status', '--network', 'anvil']));
    expect(process.exitCode ?? 0).toBe(0);
    const out = r.out.join('\n');
    expect(out).toMatch(new RegExp(`subs\\s+${subs}`));
    expect(out).toMatch(/fee 0\.05 MON per day {2}2 subscriptions/);
    expect(out).toMatch(new RegExp(`#0 +cancelled +${VAULT}`));
    expect(out).toMatch(new RegExp(`#1 +active +${OTHER} +chain 143 +until `));
  });
});
