import { getAddress, parseEther, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anvilChain,
  createChainClients,
  createSubscriptionSource,
  deploySubscriptions,
  refundAt,
  settleableAt,
  standardIdOf,
  SubscriptionsClient,
  SUBSCRIPTION_DAY_SECONDS,
  type ChainClients,
} from '../src/index.js';
import { ANVIL_KEYS, SKIP_ANVIL, startAnvil, type Anvil } from './helpers/anvil.js';

const OWNER_KEY = ANVIL_KEYS[0] as Hex;
const SUBSCRIBER_KEY = ANVIL_KEYS[2] as Hex;
const PAYER_KEY = ANVIL_KEYS[3] as Hex;
const SUBSCRIBER = privateKeyToAccount(SUBSCRIBER_KEY).address;
const ERC4626 = standardIdOf('erc4626');
const VAULT = getAddress('0x802c91d807A8DaCA257c4708ab264B6520964e44');
const OTHER = getAddress('0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E');
const TREASURY = getAddress('0x5f000000000000000000000000000000000000ee');
const FEE = parseEther('0.05');
const DAY = SUBSCRIPTION_DAY_SECONDS;

/**
 * CheckSubscriptions through SubscriptionsClient on a local anvil: deploy from the bundled bytecode, subscribe,
 * extend by someone else, time travel, settle (the offchain settleableAt and refundAt agree with the contract),
 * an extend after expiry that restarts the run, cancel with refund, withdraw, and listActive against the chain.
 * SPECFIRST_SKIP_ANVIL=1 skips.
 */
describe.skipIf(SKIP_ANVIL)('CheckSubscriptions on anvil', { timeout: 120_000 }, () => {
  let anvil: Anvil;
  let clients: ChainClients;
  let address: Address;
  let owner: SubscriptionsClient;
  let alice: SubscriptionsClient;
  let payer: SubscriptionsClient;

  const travel = async (seconds: bigint) => {
    await clients.publicClient.request({ method: 'evm_increaseTime' as never, params: [Number(seconds)] as never });
    await clients.publicClient.request({ method: 'anvil_mine' as never, params: ['0x1'] as never });
  };
  const balance = (a: Address) => clients.publicClient.getBalance({ address: a });

  beforeAll(async () => {
    anvil = await startAnvil();
    clients = createChainClients({ chain: anvilChain, rpcUrls: [anvil.url], rps: 1000 });
    const wallet = clients.wallet(OWNER_KEY);
    const out = await deploySubscriptions({ client: clients.publicClient, wallet, owner: wallet.account.address, feePerDay: FEE });
    address = out.address;
    expect(out.tx.gasCostWei).toBeGreaterThan(0n);
    owner = new SubscriptionsClient(address, clients.publicClient, wallet);
    alice = new SubscriptionsClient(address, clients.publicClient, clients.wallet(SUBSCRIBER_KEY));
    payer = new SubscriptionsClient(address, clients.publicClient, clients.wallet(PAYER_KEY));
  }, 60_000);

  afterAll(async () => {
    await anvil?.stop();
  });

  it('deploy, subscribe, extend, travel, settle, cancel with refund, withdraw', async () => {
    expect(await owner.summary()).toMatchObject({ address, feePerDay: FEE, subscriptionCount: 0n, earned: 0n, escrowed: 0n, balance: 0n });
    const s = await alice.subscribe({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626, days: 5 });
    expect(s).toMatchObject({ id: 0n, paid: 5n * FEE });
    const start = (await alice.subscriptionOf(0n)).startsAt;
    expect(s.endsAt).toBe(start + 5n * DAY);

    // Someone else pays 2 more days; they are appended at endsAt.
    const e = await payer.extend(0n, 2);
    expect(e).toMatchObject({ paid: 2n * FEE, endsAt: start + 7n * DAY });

    await travel(2n * DAY + 60n);
    const now = await owner.now();
    const before = await alice.subscriptionOf(0n);
    const expected = settleableAt(before, now + 1n);
    const settled = await payer.settle([0n]);
    expect(settled.settled).toEqual([{ id: 0n, amount: expected }]);
    expect(expected).toBe(3n * FEE);
    expect(await owner.earned()).toBe(3n * FEE);
    expect(await owner.escrowed()).toBe(4n * FEE);

    await expect(payer.cancel(0n)).rejects.toMatchObject({ errorName: 'NotSubscriber' });
    const sub = await alice.subscriptionOf(0n);
    const refund = refundAt(sub, (await owner.now()) + 1n);
    const aliceBefore = await balance(SUBSCRIBER);
    const c = await alice.cancel(0n);
    expect(c).toMatchObject({ refund, settled: 0n });
    expect(refund).toBe(4n * FEE);
    expect(await balance(SUBSCRIBER)).toBe(aliceBefore + refund - c.gasCostWei);
    expect(await alice.isActive(0n)).toBe(false);
    await expect(payer.extend(0n, 1)).rejects.toMatchObject({ errorName: 'AlreadyCancelled' });

    await expect(alice.withdraw(TREASURY)).rejects.toMatchObject({ errorName: 'NotOwner' });
    const w = await owner.withdraw(TREASURY);
    expect(w.amount).toBe(3n * FEE);
    expect(await balance(TREASURY)).toBe(3n * FEE);
    expect(await balance(address)).toBe(0n);
    await expect(owner.withdraw(TREASURY)).rejects.toMatchObject({ errorName: 'NothingToWithdraw' });
    await expect(owner.setFeePerDay(0n)).rejects.toMatchObject({ errorName: 'ZeroFee' });
    await expect(alice.setFeePerDay(1n)).rejects.toMatchObject({ errorName: 'NotOwner' });
  });

  it('an extend after expiry starts a new run now; the gap is never charged', async () => {
    const { id } = await alice.subscribe({ subjectChainId: 143n, subject: OTHER, standardId: ERC4626, days: 1 });
    await travel(3n * DAY);
    expect(await alice.isActive(id)).toBe(false);
    await alice.extend(id, 2);
    const s = await alice.subscriptionOf(id);
    const now = await owner.now();
    expect(s.startsAt).toBe(now);
    expect(s.endsAt).toBe(now + 2n * DAY);
    expect(s.paid).toBe(3n * FEE);
    expect(settleableAt(s, now + 1n)).toBe(2n * FEE);
    expect((await owner.settle([id])).settled).toEqual([{ id, amount: 2n * FEE }]);
    expect(refundAt(await alice.subscriptionOf(id), now + 2n)).toBe(FEE);
  });

  it('listActive and the source read the chain: active, on the subject chain, in id order', async () => {
    await alice.subscribe({ subjectChainId: 10143n, subject: VAULT, standardId: ERC4626, days: 3 });
    const short = await payer.subscribe({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626, days: 1 });
    const count = await owner.subscriptionCount();
    expect(count).toBe(4n);
    const active = await owner.listActive(143, { rps: 1000 });
    expect(active.map((a) => a.id)).toEqual([1n, short.id]);
    expect(active[1]).toMatchObject({ subscriber: privateKeyToAccount(PAYER_KEY).address, subject: VAULT, subjectChainId: 143n, standardId: ERC4626 });
    expect((await owner.listActive(10143, { rps: 1000 })).map((a) => a.id)).toEqual([2n]);
    const source = createSubscriptionSource(owner, { rps: 1000 });
    await travel(DAY);
    expect((await source.active(143)).map((a) => a.id)).toEqual([1n]);
  });
});
