import {
  badChecksum,
  checkSubscriptionsCreationCodeHash,
  deploySubscriptions,
  isActiveAt,
  MAX_SUBSCRIPTION_DAYS,
  MONAD_MAINNET_CHAIN_ID,
  refundAt,
  settleableAt,
  STANDARDS,
  standardIdOf,
  SUBS_FAILED_EXIT_CODE,
  SubscriptionsClient,
  SubscriptionsError,
  type StandardName,
  type Subscription,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { formatEther, getAddress, parseEther, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import { ConfigError, DEPLOYER_KEY_ENV, optionalKey, REQUESTER_KEY_ENV, resolveKey, resolveNetwork, resolveSubs, subsEnvVar } from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

export const DEFAULT_FEE_PER_DAY_MON = '0.05';
/** Subscriptions settled per transaction by `subs settle` without ids. */
export const SETTLE_CHUNK = 100;
const MAX_UINT96 = 2n ** 96n - 1n;
const MAX_UINT64 = 2n ** 64n - 1n;

interface NetOptions {
  network: string;
  rpc?: string;
  subs?: string;
}

function address(raw: string, what: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || badChecksum(raw)) throw new ConfigError(`${what} must be a 0x address with a valid checksum, got "${raw}"`);
  return getAddress(raw);
}

function positiveInt(raw: string, what: string, max = BigInt(Number.MAX_SAFE_INTEGER)): bigint {
  if (!/^[1-9]\d*$/.test(raw) || BigInt(raw) > max) throw new ConfigError(`${what} must be a positive integer up to ${max}, got "${raw}"`);
  return BigInt(raw);
}

function subscriptionId(raw: string, what: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(raw)) throw new ConfigError(`${what} must be a non-negative integer, got "${raw}"`);
  return BigInt(raw);
}

function mon(wei: bigint): string {
  return `${formatEther(wei)} MON`;
}

function iso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

function subsFailure(err: unknown): never {
  if (err instanceof SubscriptionsError) throw new StageError(SUBS_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
  throw err;
}

const subsOptions = (c: Command, readOnly = false) =>
  c
    .option(
      '--network <name>',
      readOnly ? 'network of the contract (monad-testnet, anvil; read only, so monad-mainnet is allowed)' : 'network of the contract: monad-testnet or anvil (monad-mainnet is refused)',
      'monad-testnet',
    )
    .option('--rpc <url>', 'RPC URL of that network (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--subs <address>', 'CheckSubscriptions address (default: $SPECFIRST_SUBS_<chainId>)');

function subscriptionJson(id: bigint, s: Subscription, now: bigint): Record<string, unknown> {
  return {
    id: id.toString(),
    subscriber: s.subscriber,
    subjectChainId: s.subjectChainId.toString(),
    subject: s.subject,
    standardId: s.standardId,
    standard: STANDARDS.find((n) => standardIdOf(n) === s.standardId.toLowerCase()) ?? null,
    feePerDay: s.feePerDay.toString(),
    startsAt: s.startsAt.toString(),
    endsAt: s.endsAt.toString(),
    paid: s.paid.toString(),
    settled: s.settled.toString(),
    cancelled: s.cancelled,
    active: isActiveAt(s, now),
    settleable: settleableAt(s, now).toString(),
    refundable: refundAt(s, now).toString(),
  };
}

function subscriptionLine(id: bigint, s: Subscription, now: bigint): string {
  const state = s.cancelled ? 'cancelled' : isActiveAt(s, now) ? 'active' : 'expired';
  const color = state === 'active' ? pc.green : state === 'cancelled' ? pc.red : pc.dim;
  const when = state === 'active' ? `until ${iso(s.endsAt)}` : `ended ${iso(s.endsAt)}`;
  const settleable = settleableAt(s, now);
  return `  #${String(id).padEnd(4)} ${color(state.padEnd(9))} ${s.subject}  chain ${s.subjectChainId}  ${when}  paid ${mon(s.paid)}  settled ${mon(s.settled)}${settleable > 0n ? `  ${pc.yellow(`settleable ${mon(settleable)}`)}` : ''}  ${pc.dim(`by ${s.subscriber}`)}`;
}

/** Every subscription with something to settle at `now`, read one at a time from id 0. */
async function settleableIds(subs: SubscriptionsClient, now: bigint): Promise<bigint[]> {
  const count = await subs.subscriptionCount();
  const ids: bigint[] = [];
  for (let id = 0n; id < count; id++) {
    if (settleableAt(await subs.subscriptionOf(id), now) > 0n) ids.push(id);
  }
  return ids;
}

/**
 * `specfirst subs deploy|subscribe|extend|status|settle|cancel|withdraw` (docs/adr/0006). Writes go through
 * resolveNetwork without readOnly, so monad-mainnet is refused before a key is read, and through the guarded wallet
 * whose transport checks eth_chainId before the first send. DEPLOYER_PRIVATE_KEY is the owner (deploy, settle,
 * withdraw); REQUESTER_PRIVATE_KEY is the test subscriber (subscribe, extend, cancel) and never falls back to an
 * anvil key. Exit 0, or 20 on any subscriptions failure.
 */
export function registerSubsCommand(program: Command): void {
  const group = program.command('subs').description('CheckSubscriptions: prepaid per-day alert subscriptions (ADR 0006).');

  group
    .command('deploy')
    .description('Deploy CheckSubscriptions with DEPLOYER_PRIVATE_KEY as owner. The fee per day must be above 0.')
    .option('--network <name>', 'monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--fee-per-day <MON>', 'fee per day of new subscriptions in MON, decimal', DEFAULT_FEE_PER_DAY_MON)
    .action(async (opts: { network: string; rpc?: string; feePerDay: string }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'subs deploy', SUBS_FAILED_EXIT_CODE, async () => {
        if (!/^\d+(\.\d{1,18})?$/.test(opts.feePerDay)) throw new ConfigError(`--fee-per-day must be a decimal amount of MON with at most 18 decimals, got "${opts.feePerDay}"`);
        const feePerDay = parseEther(opts.feePerDay);
        // The contract refuses 0: a subscription made at a fee of 0 could be extended by anyone for free, forever.
        if (feePerDay === 0n) throw new ConfigError('--fee-per-day must be above 0 (the contract refuses a fee of 0)');
        if (feePerDay * BigInt(MAX_SUBSCRIPTION_DAYS) > MAX_UINT96) throw new ConfigError(`--fee-per-day ${opts.feePerDay} MON for ${MAX_SUBSCRIPTION_DAYS} days does not fit uint96`);
        const net = resolveNetwork(opts);
        const ownerKey = resolveKey(net, DEPLOYER_KEY_ENV);
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const wallet = net.clients.wallet(ownerKey);
        const envName = subsEnvVar(net.clients.chain.id);
        let out;
        try {
          out = await deploySubscriptions({ client: net.clients.publicClient, wallet, owner: wallet.account.address, feePerDay });
        } catch (err) {
          subsFailure(err);
        }
        printLine(ctx, stage('subs', `CheckSubscriptions ${pc.bold(out.address)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
        printLine(ctx, cont(`fee per day ${mon(feePerDay)}  owner ${wallet.account.address}`));
        printLine(ctx, cont(pc.dim(`tx ${out.tx.hash}  block ${out.tx.blockNumber}  creation code keccak ${checkSubscriptionsCreationCodeHash}`)));
        printLine(ctx, cont(`export ${envName}=${out.address}`));
        emitEvent(ctx, {
          type: 'subs-deployed',
          address: out.address,
          chainId: net.clients.chain.id,
          owner: wallet.account.address,
          feePerDay: feePerDay.toString(),
          txHash: out.tx.hash,
          blockNumber: out.tx.blockNumber.toString(),
          creationCodeKeccak: checkSubscriptionsCreationCodeHash,
          envName,
        });
      });
    });

  subsOptions(
    group
      .command('subscribe <address>')
      .description('Pay feePerDay x --days from REQUESTER_PRIVATE_KEY for alerts about <address>. For testing; users subscribe from the web.')
      .requiredOption('--days <n>', `days to pay for, 1 to ${MAX_SUBSCRIPTION_DAYS}`)
      .option('--subject-chain <id>', 'chain the subject lives on', String(MONAD_MAINNET_CHAIN_ID))
      .option('--standard <name>', `standard of the alerts (${STANDARDS.join(', ')})`, 'erc4626'),
  ).action(async (subjectArg: string, opts: NetOptions & { days: string; subjectChain: string; standard: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'subs subscribe', SUBS_FAILED_EXIT_CODE, async () => {
      const subject = address(subjectArg, '<address>');
      const days = Number(positiveInt(opts.days, '--days', BigInt(MAX_SUBSCRIPTION_DAYS)));
      const subjectChainId = positiveInt(opts.subjectChain, '--subject-chain', MAX_UINT64);
      if (!(STANDARDS as readonly string[]).includes(opts.standard)) throw new ConfigError(`--standard must be one of ${STANDARDS.join(', ')}, got "${opts.standard}"`);
      const standardId = standardIdOf(opts.standard as StandardName);
      const net = resolveNetwork(opts);
      const key = optionalKey(REQUESTER_KEY_ENV);
      if (!key) throw new ConfigError(`${REQUESTER_KEY_ENV} is not set; subs subscribe pays from that key (never the deployer's or the worker's)`);
      const subsAddress = resolveSubs(net, opts);
      const subs = new SubscriptionsClient(subsAddress, net.clients.publicClient, net.clients.wallet(key));
      let out;
      try {
        out = await subs.subscribe({ subjectChainId, subject, standardId, days });
      } catch (err) {
        subsFailure(err);
      }
      const subscriber = privateKeyToAccount(key).address;
      printLine(ctx, stage('subscribe', `#${out.id}  ${subject}  chain ${subjectChainId}  ${opts.standard}  ${days} day${days === 1 ? '' : 's'}  paid ${mon(out.paid)}  until ${iso(out.endsAt)}`));
      printLine(ctx, cont(pc.dim(`subscriber ${subscriber}  tx ${out.hash}  block ${out.blockNumber}  contract ${subsAddress}`)));
      emitEvent(ctx, {
        type: 'subs-subscribed',
        id: out.id.toString(),
        subs: subsAddress,
        chainId: net.clients.chain.id,
        subscriber,
        subjectChainId: subjectChainId.toString(),
        subject,
        standard: opts.standard,
        standardId,
        days,
        paid: out.paid.toString(),
        endsAt: out.endsAt.toString(),
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
      });
    });
  });

  subsOptions(
    group
      .command('extend <id>')
      .description("Pay the subscription's own feePerDay x --days from REQUESTER_PRIVATE_KEY. An expired subscription starts again now.")
      .requiredOption('--days <n>', `days to add, 1 to ${MAX_SUBSCRIPTION_DAYS}`),
  ).action(async (idArg: string, opts: NetOptions & { days: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'subs extend', SUBS_FAILED_EXIT_CODE, async () => {
      const id = subscriptionId(idArg, '<id>');
      const days = Number(positiveInt(opts.days, '--days', BigInt(MAX_SUBSCRIPTION_DAYS)));
      const net = resolveNetwork(opts);
      const key = optionalKey(REQUESTER_KEY_ENV);
      if (!key) throw new ConfigError(`${REQUESTER_KEY_ENV} is not set; subs extend pays from that key`);
      const subsAddress = resolveSubs(net, opts);
      const subs = new SubscriptionsClient(subsAddress, net.clients.publicClient, net.clients.wallet(key));
      let out;
      try {
        out = await subs.extend(id, days);
      } catch (err) {
        subsFailure(err);
      }
      printLine(ctx, stage('extend', `#${id}  +${days} day${days === 1 ? '' : 's'}  paid ${mon(out.paid)}  until ${iso(out.endsAt)}  ${pc.dim(`tx ${out.hash}`)}`));
      emitEvent(ctx, {
        type: 'subs-extended',
        id: id.toString(),
        subs: subsAddress,
        chainId: net.clients.chain.id,
        payer: privateKeyToAccount(key).address,
        days,
        paid: out.paid.toString(),
        endsAt: out.endsAt.toString(),
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
      });
    });
  });

  subsOptions(
    group
      .command('status [id]')
      .description('Read the contract: fee, earned, withdrawn, escrowed and settleable fees, and the latest subscriptions (or one). Read only.')
      .option('--limit <n>', 'how many of the latest subscriptions to list', '20'),
    true,
  ).action(async (idArg: string | undefined, opts: NetOptions & { limit: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'subs status', SUBS_FAILED_EXIT_CODE, async () => {
      const one = idArg !== undefined ? subscriptionId(idArg, '[id]') : undefined;
      const limit = positiveInt(opts.limit, '--limit', 1000n);
      const net = resolveNetwork(opts, process.env, { readOnly: true });
      const subsAddress = resolveSubs(net, opts);
      const subs = new SubscriptionsClient(subsAddress, net.clients.publicClient);
      const s = await subs.summary();
      const now = await subs.now();
      const ids: bigint[] = [];
      if (one !== undefined) ids.push(one);
      else for (let id = s.subscriptionCount > limit ? s.subscriptionCount - limit : 0n; id < s.subscriptionCount; id++) ids.push(id);
      const rows: Array<{ id: bigint; s: Subscription }> = [];
      for (const id of ids) {
        try {
          rows.push({ id, s: await subs.subscriptionOf(id) });
        } catch (err) {
          subsFailure(err);
        }
      }
      // Settleable over every subscription, not only the listed ones, so `subs settle` can be planned from it.
      let settleable = 0n;
      for (let id = 0n; id < s.subscriptionCount; id++) {
        const row = rows.find((r) => r.id === id)?.s ?? (await subs.subscriptionOf(id));
        settleable += settleableAt(row, now);
      }
      const available = s.earned - s.withdrawn;
      printLine(ctx, stage('subs', `${pc.bold(subsAddress)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}  fee ${mon(s.feePerDay)} per day  ${s.subscriptionCount} subscription${s.subscriptionCount === 1n ? '' : 's'}`));
      printLine(ctx, cont(`earned ${pc.green(mon(s.earned))}  withdrawn ${mon(s.withdrawn)}  withdrawable ${mon(available)}  escrowed ${pc.yellow(mon(s.escrowed))}  settleable now ${mon(settleable)}  balance ${mon(s.balance)}`));
      printLine(ctx, cont(pc.dim(`owner ${s.owner}  block time ${iso(now)}`)));
      for (const r of rows) printLine(ctx, subscriptionLine(r.id, r.s, now));
      emitEvent(ctx, {
        type: 'subs-status',
        subs: subsAddress,
        chainId: net.clients.chain.id,
        owner: s.owner,
        feePerDay: s.feePerDay.toString(),
        subscriptionCount: s.subscriptionCount.toString(),
        earned: s.earned.toString(),
        withdrawn: s.withdrawn.toString(),
        withdrawable: available.toString(),
        escrowed: s.escrowed.toString(),
        settleable: settleable.toString(),
        balance: s.balance.toString(),
        blockTimestamp: now.toString(),
        subscriptions: rows.map((r) => subscriptionJson(r.id, r.s, now)),
      });
    });
  });

  subsOptions(
    group
      .command('settle [ids...]')
      .description(`Move the fee of every started day to earned. Without ids: every subscription with something due, ${SETTLE_CHUNK} per transaction. Signs with DEPLOYER_PRIVATE_KEY (anyone may settle).`),
  ).action(async (idArgs: string[], opts: NetOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'subs settle', SUBS_FAILED_EXIT_CODE, async () => {
      const given = idArgs.map((a) => subscriptionId(a, '[ids...]'));
      const net = resolveNetwork(opts);
      const key = resolveKey(net, DEPLOYER_KEY_ENV);
      const subsAddress = resolveSubs(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const subs = new SubscriptionsClient(subsAddress, net.clients.publicClient, net.clients.wallet(key));
      let ids = given;
      if (ids.length === 0) {
        try {
          ids = await settleableIds(subs, await subs.now());
        } catch (err) {
          subsFailure(err);
        }
      }
      const settled: Array<{ id: bigint; amount: bigint }> = [];
      const txs: string[] = [];
      for (let i = 0; i < ids.length; i += SETTLE_CHUNK) {
        let out;
        try {
          out = await subs.settle(ids.slice(i, i + SETTLE_CHUNK));
        } catch (err) {
          subsFailure(err);
        }
        settled.push(...out.settled);
        txs.push(out.hash);
      }
      const total = settled.reduce((n, s) => n + s.amount, 0n);
      if (ids.length === 0) printLine(ctx, stage('settle', pc.dim('nothing due')));
      else printLine(ctx, stage('settle', `${pc.green(mon(total))} from ${settled.length} subscription${settled.length === 1 ? '' : 's'}  ${pc.dim(txs.map((t) => `tx ${t}`).join('  '))}`));
      for (const s of settled) printLine(ctx, cont(`#${s.id}  ${mon(s.amount)}`));
      emitEvent(ctx, {
        type: 'subs-settled',
        subs: subsAddress,
        chainId: net.clients.chain.id,
        ids: ids.map(String),
        settled: settled.map((s) => ({ id: s.id.toString(), amount: s.amount.toString() })),
        total: total.toString(),
        txHashes: txs,
      });
    });
  });

  subsOptions(
    group.command('cancel <id>').description('Cancel a subscription of REQUESTER_PRIVATE_KEY: settle, refund the days not started, end it now.'),
  ).action(async (idArg: string, opts: NetOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'subs cancel', SUBS_FAILED_EXIT_CODE, async () => {
      const id = subscriptionId(idArg, '<id>');
      const net = resolveNetwork(opts);
      const key = optionalKey(REQUESTER_KEY_ENV);
      if (!key) throw new ConfigError(`${REQUESTER_KEY_ENV} is not set; subs cancel signs as the subscriber with that key`);
      const subsAddress = resolveSubs(net, opts);
      const wallet = net.clients.wallet(key);
      const subs = new SubscriptionsClient(subsAddress, net.clients.publicClient, wallet);
      let sub: Subscription;
      try {
        sub = await subs.subscriptionOf(id);
      } catch (err) {
        subsFailure(err);
      }
      if (sub.subscriber !== wallet.account.address) throw new ConfigError(`${REQUESTER_KEY_ENV} is ${wallet.account.address}, subscription #${id} belongs to ${sub.subscriber}`);
      let out;
      try {
        out = await subs.cancel(id);
      } catch (err) {
        subsFailure(err);
      }
      printLine(ctx, stage('cancel', `#${id}  refunded ${pc.green(mon(out.refund))}  settled ${mon(out.settled)}  ${pc.dim(`tx ${out.hash}`)}`));
      emitEvent(ctx, {
        type: 'subs-cancelled',
        id: id.toString(),
        subs: subsAddress,
        chainId: net.clients.chain.id,
        subscriber: wallet.account.address,
        refund: out.refund.toString(),
        settled: out.settled.toString(),
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
      });
    });
  });

  subsOptions(
    group
      .command('withdraw')
      .description('Pay the earned fees not withdrawn yet to --to (default: the owner). Signs with DEPLOYER_PRIVATE_KEY (the owner). Escrowed fees stay.')
      .option('--to <address>', 'recipient of the earned fees (default: the owner)'),
  ).action(async (opts: NetOptions & { to?: string }, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'subs withdraw', SUBS_FAILED_EXIT_CODE, async () => {
      const explicit = opts.to !== undefined ? address(opts.to, '--to') : undefined;
      const net = resolveNetwork(opts);
      const ownerKey = resolveKey(net, DEPLOYER_KEY_ENV);
      const subsAddress = resolveSubs(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const wallet = net.clients.wallet(ownerKey);
      const subs = new SubscriptionsClient(subsAddress, net.clients.publicClient, wallet);
      const owner = await subs.owner();
      if (owner !== wallet.account.address) throw new ConfigError(`${DEPLOYER_KEY_ENV} is ${wallet.account.address}, the owner is ${owner}`);
      const to = explicit ?? owner;
      const [earned, withdrawn, escrowed] = [await subs.earned(), await subs.withdrawn(), await subs.escrowed()];
      if (earned === withdrawn) {
        throw new StageError(
          SUBS_FAILED_EXIT_CODE,
          `nothing to withdraw: earned ${mon(earned)}, withdrawn ${mon(withdrawn)}; ${mon(escrowed)} escrowed for days not settled yet (run \`specfirst subs settle\` first)`,
        );
      }
      let out;
      try {
        out = await subs.withdraw(to);
      } catch (err) {
        subsFailure(err);
      }
      printLine(ctx, stage('withdraw', `${pc.green(mon(out.amount))} to ${to}  ${pc.dim(`contract ${subsAddress}  tx ${out.hash}`)}`));
      printLine(ctx, cont(pc.dim(`escrowed ${mon(escrowed)} stays for days not settled yet`)));
      emitEvent(ctx, {
        type: 'subs-withdrawn',
        subs: subsAddress,
        chainId: net.clients.chain.id,
        to,
        amount: out.amount.toString(),
        earned: earned.toString(),
        withdrawn: (withdrawn + out.amount).toString(),
        escrowed: escrowed.toString(),
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
      });
    });
  });
}
