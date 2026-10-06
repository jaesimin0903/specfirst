import { encodeDeployData, getAddress, keccak256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { TX_GAS_CAP, withMargin } from '../chain/gas.js';
import { TokenBucket } from '../chain/transport.js';
import type { TxOutcome } from '../cert/registry.js';
import { checkSubscriptionsAbi, checkSubscriptionsBytecode } from './artifact.js';
import type { ActiveSubscription, SubscriptionSource } from '../watch/hooks.js';
import { isActiveAt, MAX_SUBSCRIPTION_DAYS, type Subscription } from './subscription.js';

/** Exit code of the subs commands when a subscriptions action fails or is refused. */
export const SUBS_FAILED_EXIT_CODE = 20;

/** keccak256 of the bundled creation code; `subs deploy` prints it so a deploy can be matched to a build. */
export const checkSubscriptionsCreationCodeHash: Hex = keccak256(checkSubscriptionsBytecode);

/**
 * Reads per second of listActive: below the 15 requests per second the Monad testnet public RPC allows, so the
 * watcher's other calls on that RPC still fit.
 */
export const DEFAULT_LIST_RPS = 10;
/** Subscriptions read concurrently by listActive before it waits for the batch. */
export const DEFAULT_LIST_BATCH = 10;

export interface SubscriptionsSummary {
  address: Address;
  owner: Address;
  feePerDay: bigint;
  subscriptionCount: bigint;
  earned: bigint;
  withdrawn: bigint;
  escrowed: bigint;
  balance: bigint;
}

/** A mined transaction with what it cost: gasUsed x effectiveGasPrice. */
export interface SubsTx extends TxOutcome {
  effectiveGasPrice: bigint;
  gasCostWei: bigint;
}

export class SubscriptionsError extends Error {
  constructor(message: string, readonly errorName?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'SubscriptionsError';
  }
}

function decodedName(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as { data?: { errorName?: string } }).data;
    if (d && typeof d === 'object' && typeof d.errorName === 'string') return d.errorName;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function failure(what: string, err: unknown): SubscriptionsError {
  const name = decodedName(err);
  const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
  return new SubscriptionsError(`${what}${name ? ` (${name})` : ''}: ${msg}`, name, err);
}

/** The gasLimitFor policy of deploy/deploy.ts: estimate x 1.2, strictly below the per-transaction cap. */
function gasLimit(estimate: bigint): bigint {
  const limit = withMargin(estimate);
  if (limit >= TX_GAS_CAP) throw new SubscriptionsError(`gas limit ${limit} (estimate ${estimate} x 1.2) is not below the per-tx cap ${TX_GAS_CAP}`);
  return limit;
}

function txOf(hash: Hex, receipt: Pick<TransactionReceipt, 'blockNumber' | 'gasUsed' | 'effectiveGasPrice'>): SubsTx {
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice, gasCostWei: receipt.gasUsed * effectiveGasPrice };
}

function checkDays(days: number): void {
  if (!Number.isInteger(days) || days < 1 || days > MAX_SUBSCRIPTION_DAYS) {
    throw new SubscriptionsError(`days must be an integer from 1 to ${MAX_SUBSCRIPTION_DAYS}, got ${days}`, 'BadDays');
  }
}

export interface DeploySubscriptionsInput {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  owner: Address;
  /** Fee per day in wei: above 0 (the contract refuses 0 with ZeroFee) and within uint96. */
  feePerDay: bigint;
}

const MAX_UINT96 = 2n ** 96n - 1n;

/**
 * Deploys CheckSubscriptions from the bundled creation code with the guarded wallet (the chain checks of
 * createChainClients apply; no forge --broadcast). One transaction: the constructor sets owner and feePerDay.
 */
export async function deploySubscriptions(i: DeploySubscriptionsInput): Promise<{ address: Address; tx: SubsTx }> {
  if (i.feePerDay <= 0n || i.feePerDay > MAX_UINT96) throw new SubscriptionsError(`feePerDay ${i.feePerDay} wei must be above 0 and fit uint96`, i.feePerDay === 0n ? 'ZeroFee' : undefined);
  const data = encodeDeployData({ abi: checkSubscriptionsAbi, bytecode: checkSubscriptionsBytecode, args: [i.owner, i.feePerDay] });
  let gas: bigint;
  try {
    gas = gasLimit(await i.client.estimateGas({ account: i.wallet.account.address, data }));
  } catch (err) {
    if (err instanceof SubscriptionsError) throw err;
    throw failure('CheckSubscriptions deploy would fail', err);
  }
  const hash = await i.wallet.sendTransaction({ data, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new SubscriptionsError(`CheckSubscriptions deploy tx ${hash} failed (status ${receipt.status})`);
  }
  return { address: getAddress(receipt.contractAddress), tx: txOf(hash, receipt) };
}

export interface ListActiveOptions {
  /** Reads per second, the count and the block included (default DEFAULT_LIST_RPS). */
  rps?: number;
  /** Subscriptions read concurrently (default DEFAULT_LIST_BATCH). */
  batchSize?: number;
  /** Ids not to read, e.g. ones already seen cancelled (a cancelled subscription never becomes active again). */
  skip?: ReadonlySet<bigint>;
  /** Called with every subscription read. */
  onRead?: (id: bigint, s: Subscription) => void;
}

type WriteName = 'subscribe' | 'extend' | 'cancel' | 'settle' | 'withdraw' | 'setFeePerDay';
type Mined = SubsTx & { receipt: TransactionReceipt };

/**
 * Thin client over CheckSubscriptions. Writes are simulated first so custom errors surface by name; amounts and
 * ids come from the contract's own events in the mined receipt. Imports only viem and pure modules, so it is part
 * of the browser-safe `@specfirst/core/subs`.
 */
export class SubscriptionsClient {
  constructor(
    readonly address: Address,
    readonly client: SpecfirstPublicClient,
    readonly wallet?: SpecfirstWalletClient,
  ) {}

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: this.address, abi: checkSubscriptionsAbi, functionName, args } as never) as Promise<T>;
  }

  private async write(functionName: WriteName, args: readonly unknown[], value?: bigint): Promise<Mined> {
    if (!this.wallet) throw new SubscriptionsError(`${functionName} needs a wallet client`);
    const call = {
      address: this.address,
      abi: checkSubscriptionsAbi,
      functionName,
      args,
      account: this.wallet.account,
      ...(value !== undefined ? { value } : {}),
    } as never;
    try {
      const sim = await this.client.simulateContract(call);
      const gas = gasLimit(await this.client.estimateContractGas(call));
      const hash = await this.wallet.writeContract({ ...(sim as { request: object }).request, gas } as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new SubscriptionsError(`${functionName} tx ${hash} reverted`);
      return { ...txOf(hash, receipt), receipt };
    } catch (err) {
      if (err instanceof SubscriptionsError) throw err;
      throw failure(`${functionName} failed`, err);
    }
  }

  private strip(out: Mined): SubsTx {
    const { receipt: _receipt, ...tx } = out;
    return tx;
  }

  private events<N extends 'Subscribed' | 'Extended' | 'Cancelled' | 'Settled' | 'FeesWithdrawn'>(out: Mined, eventName: N) {
    const self = this.address.toLowerCase();
    return parseEventLogs({ abi: checkSubscriptionsAbi, eventName, logs: out.receipt.logs }).filter((l) => l.address.toLowerCase() === self);
  }

  /**
   * Pays `value` (default: the current feePerDay x days, read first) for `days` days from now and returns the id
   * from the one Subscribed event this contract emitted in the mined receipt.
   */
  async subscribe(
    s: { subjectChainId: bigint; subject: Address; standardId: Hex; days: number },
    value?: bigint,
  ): Promise<SubsTx & { id: bigint; paid: bigint; endsAt: bigint }> {
    checkDays(s.days);
    const paid = value ?? (await this.feePerDay()) * BigInt(s.days);
    const out = await this.write('subscribe', [s.subjectChainId, s.subject, s.standardId, s.days], paid);
    const events = this.events(out, 'Subscribed');
    if (events.length !== 1) {
      throw new SubscriptionsError(`subscribe tx ${out.hash}: expected one Subscribed event from ${this.address} in the receipt, found ${events.length}`);
    }
    const e = events[0]!.args;
    return { ...this.strip(out), id: e.id, paid: e.paid, endsAt: e.endsAt };
  }

  /** Pays `value` (default: the subscription's own feePerDay x days) to add `days` days. Anyone may pay. */
  async extend(id: bigint, days: number, value?: bigint): Promise<SubsTx & { paid: bigint; endsAt: bigint }> {
    checkDays(days);
    const paid = value ?? (await this.subscriptionOf(id)).feePerDay * BigInt(days);
    const out = await this.write('extend', [id, days], paid);
    const e = this.events(out, 'Extended').find((l) => l.args.id === id);
    if (!e) throw new SubscriptionsError(`extend tx ${out.hash}: no Extended event for subscription ${id} in the receipt`);
    return { ...this.strip(out), paid: e.args.paid, endsAt: e.args.endsAt };
  }

  /** Subscriber only: settles, refunds the days not started and ends the subscription. */
  async cancel(id: bigint): Promise<SubsTx & { refund: bigint; settled: bigint }> {
    const out = await this.write('cancel', [id]);
    const e = this.events(out, 'Cancelled').find((l) => l.args.id === id);
    if (!e) throw new SubscriptionsError(`cancel tx ${out.hash}: no Cancelled event for subscription ${id} in the receipt`);
    const settled = this.events(out, 'Settled').find((l) => l.args.id === id)?.args.amount ?? 0n;
    return { ...this.strip(out), refund: e.args.refund, settled };
  }

  /** Moves the fee of the started days of `ids` to earned; returns what each id moved (ids that moved nothing are absent). */
  async settle(ids: readonly bigint[]): Promise<SubsTx & { settled: Array<{ id: bigint; amount: bigint }> }> {
    const out = await this.write('settle', [ids]);
    return { ...this.strip(out), settled: this.events(out, 'Settled').map((l) => ({ id: l.args.id, amount: l.args.amount })) };
  }

  /** Owner only: pays the earned fees not withdrawn yet (at most 2^96 - 1 wei per call) to `to`. */
  async withdraw(to: Address): Promise<SubsTx & { amount: bigint }> {
    const out = await this.write('withdraw', [to]);
    const e = this.events(out, 'FeesWithdrawn')[0];
    if (!e) throw new SubscriptionsError(`withdraw tx ${out.hash}: no FeesWithdrawn event in the receipt`);
    return { ...this.strip(out), amount: e.args.amount };
  }

  async setFeePerDay(feePerDay: bigint): Promise<SubsTx> {
    return this.strip(await this.write('setFeePerDay', [feePerDay]));
  }

  /** Reads one subscription; throws SubscriptionsError (UnknownSubscription) for an id at or above subscriptionCount(). */
  async subscriptionOf(id: bigint): Promise<Subscription> {
    try {
      return await this.read<Subscription>('subscriptionOf', [id]);
    } catch (err) {
      if (decodedName(err) === 'UnknownSubscription') throw new SubscriptionsError(`no subscription with id ${id} (UnknownSubscription)`, 'UnknownSubscription', err);
      throw err;
    }
  }
  subscriptionCount(): Promise<bigint> {
    return this.read('subscriptionCount');
  }
  isActive(id: bigint): Promise<boolean> {
    return this.read('isActive', [id]);
  }
  feePerDay(): Promise<bigint> {
    return this.read('feePerDay');
  }
  owner(): Promise<Address> {
    return this.read('owner');
  }
  earned(): Promise<bigint> {
    return this.read('earned');
  }
  withdrawn(): Promise<bigint> {
    return this.read('withdrawn');
  }
  escrowed(): Promise<bigint> {
    return this.read('escrowed');
  }

  /** block.timestamp of the latest block: the clock isActive and settle use. */
  async now(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: 'latest' })).timestamp;
  }

  /** Every setting and counter plus the balance. Seven reads, one at a time. */
  async summary(): Promise<SubscriptionsSummary> {
    return {
      address: this.address,
      owner: await this.owner(),
      feePerDay: await this.feePerDay(),
      subscriptionCount: await this.subscriptionCount(),
      earned: await this.earned(),
      withdrawn: await this.withdrawn(),
      escrowed: await this.escrowed(),
      balance: await this.client.getBalance({ address: this.address }),
    };
  }

  /**
   * The subscriptions on `subjectChainId` that are active at the latest block (not cancelled, block.timestamp <
   * endsAt), in id order. Walks subscriptionCount() and subscriptionOf(id), never getLogs (the testnet caps
   * eth_getLogs at 100 blocks): `batchSize` reads at a time through a token bucket of `rps` reads per second, so
   * n subscriptions cost n + 2 requests and about n / rps seconds.
   */
  async listActive(subjectChainId: bigint | number, opts: ListActiveOptions = {}): Promise<ActiveSubscription[]> {
    const chainId = BigInt(subjectChainId);
    const batchSize = opts.batchSize ?? DEFAULT_LIST_BATCH;
    if (!Number.isInteger(batchSize) || batchSize < 1) throw new SubscriptionsError(`batchSize must be a positive integer, got ${batchSize}`);
    const bucket = new TokenBucket(opts.rps ?? DEFAULT_LIST_RPS);
    await bucket.acquire();
    const count = await this.subscriptionCount();
    await bucket.acquire();
    const now = await this.now();
    const ids: bigint[] = [];
    for (let id = 0n; id < count; id++) if (!opts.skip?.has(id)) ids.push(id);
    const active: ActiveSubscription[] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const rows = await Promise.all(
        batch.map(async (id) => {
          await bucket.acquire();
          return [id, await this.subscriptionOf(id)] as const;
        }),
      );
      for (const [id, s] of rows) {
        opts.onRead?.(id, s);
        if (s.subjectChainId !== chainId || !isActiveAt(s, now)) continue;
        active.push({ id, subscriber: s.subscriber, subjectChainId: s.subjectChainId, subject: s.subject, standardId: s.standardId, startsAt: s.startsAt, endsAt: s.endsAt });
      }
    }
    return active;
  }
}

/** listActive as a function, for callers that hold a client. */
export function listActive(client: SubscriptionsClient, subjectChainId: bigint | number, opts: ListActiveOptions = {}): Promise<ActiveSubscription[]> {
  return client.listActive(subjectChainId, opts);
}

/** How often (in reads) an expired subscription is read again: only an extend, which costs a fee, restarts it. */
export const EXPIRED_REREAD_EVERY = 10;

/**
 * The watcher's SubscriptionSource over a CheckSubscriptions client, incremental: each read asks for
 * subscriptionCount() and reads the ids it has not seen yet, then again the ones that are active (one may be
 * cancelled or extended), and the expired ones every EXPIRED_REREAD_EVERY reads (an extend can start them
 * again). Cancelled ones and ones of another subject chain are never read again: neither can become active for
 * this chain. A read costs about the new and active subscriptions, not all of them.
 */
export function createSubscriptionSource(client: SubscriptionsClient, opts: Omit<ListActiveOptions, 'skip' | 'onRead'> = {}): SubscriptionSource {
  const known = new Map<bigint, Subscription>();
  const never = new Set<bigint>();
  let reads = 0;
  return {
    active: async (subjectChainId: number) => {
      const chainId = BigInt(subjectChainId);
      const now = await client.now();
      const rereadExpired = reads % EXPIRED_REREAD_EVERY === 0;
      reads++;
      // Ids known and not worth a read this time: inactive and not due for the expired re-read.
      const skip = new Set<bigint>(never);
      for (const [id, s] of known) if (!isActiveAt(s, now) && !rereadExpired) skip.add(id);
      await client.listActive(subjectChainId, {
        ...opts,
        skip,
        onRead: (id, s) => {
          known.set(id, s);
          if (s.cancelled || s.subjectChainId !== chainId) never.add(id);
        },
      });
      const active: ActiveSubscription[] = [];
      for (const [id, s] of [...known].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (never.has(id) || !isActiveAt(s, now)) continue;
        active.push({ id, subscriber: s.subscriber, subjectChainId: s.subjectChainId, subject: s.subject, standardId: s.standardId, startsAt: s.startsAt, endsAt: s.endsAt });
      }
      return active;
    },
  };
}
