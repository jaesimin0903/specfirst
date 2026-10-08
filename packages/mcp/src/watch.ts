import { DEFAULT_WEBHOOK_ATTEMPTS, DEFAULT_WEBHOOK_DEADLINE_MS, DEFAULT_WEBHOOK_MAX_TARGETS, MAX_SUBSCRIPTION_DAYS, WEBHOOK_MAX_AGE_SEC } from '@specfirst/core/subs';
import { formatEther, type Address } from 'viem';
import type { SpecfirstApi, WatchVault } from './api.js';
import { ERC4626_STANDARD_ID, type ChainReader } from './chain.js';
import { ATTEST_CHAIN_ID, TESTNET_EXPLORER } from './config.js';

/*
 * how_to_watch: how a person or an agent subscribes to alerts about one vault (CheckSubscriptions, ADR 0006).
 * Informational only: the fee per day is read on chain, nothing is signed or sent.
 */

export interface WatchGuide {
  vault: { address: Address; chainId: number };
  subscriptions: {
    contract: string;
    chainId: number;
    explorer: string;
    feePerDayWei: string | null;
    feePerDayMon: string | null;
    /** chain: read now from the contract; unread: the read failed (reason says why). */
    fee: 'chain' | 'unread';
    reason: string | null;
    call: string;
    args: { subjectChainId: number; subject: Address; standardId: string; days: string };
    value: string;
    accounting: string;
    cadence: string;
  };
  web: { vaultPage: string; inbox: string; feed: string };
  webhook: {
    register: string;
    message: string;
    rules: string;
    payloadFields: string[];
    kinds: { kind: string; when: string }[];
    idempotencyKey: string;
    delivery: string;
  };
  watcher: { knows: boolean; foundBy: string | null; lastCheckBlock: string | null; lastCheckAt: string | null; lastAttestationId: string | null } | null;
  notes: string[];
  readAt: string;
}

export interface WatchDeps {
  api: SpecfirstApi;
  chain: ChainReader;
  subscriptions: Address;
  now?: () => Date;
}

export async function howToWatch(deps: WatchDeps, address: Address, chainId: number): Promise<WatchGuide> {
  const base = deps.api.base;
  const lower = address.toLowerCase();
  const [fee, watch] = await Promise.all([deps.chain.feePerDay(), deps.api.watchVault(chainId, address).catch((): WatchVault | null => null)]);
  return {
    vault: { address, chainId },
    subscriptions: {
      contract: deps.subscriptions,
      chainId: ATTEST_CHAIN_ID,
      explorer: `${TESTNET_EXPLORER}/address/${deps.subscriptions}`,
      feePerDayWei: fee.read === 'ok' ? fee.feePerDayWei.toString() : null,
      feePerDayMon: fee.read === 'ok' ? formatEther(fee.feePerDayWei) : null,
      fee: fee.read === 'ok' ? 'chain' : 'unread',
      reason: fee.read === 'unread' ? fee.reason : null,
      call: 'subscribe(uint64 subjectChainId, address subject, bytes32 standardId, uint32 days_) payable returns (uint256 id)',
      args: { subjectChainId: chainId, subject: address, standardId: ERC4626_STANDARD_ID, days: `1 to ${MAX_SUBSCRIPTION_DAYS}` },
      value: 'feePerDay x days, in testnet MON (wei), sent with the call',
      accounting:
        'A day that has started counts as used. settle moves the fee of started days to earned; cancel(id) refunds the days not started; extend(id, days) adds days, and extending an expired subscription starts it again from now, so days without service are never charged.',
      cadence: 'The watcher reads active subscriptions each minute, checks a subscribed vault first and then every hour, and reads its share value every 30 seconds.',
    },
    web: { vaultPage: `${base}/v/${chainId}/${lower}`, inbox: `${base}/watch/inbox`, feed: `${base}/watch` },
    webhook: {
      register: `On ${base}/watch/inbox the subscriber signs the message below with the subscribing address; the URL is stored only while that address holds an active subscription, and only its origin is ever shown.`,
      message: 'Specfirst alerts webhook\nsubscriber: <checksummed address>\nurl: <https url, exactly as new URL(url).href writes it>\nissued: <unix seconds>',
      rules: `https only, no credentials in the URL, never a host that resolves to an internal address; the signature is accepted for ${WEBHOOK_MAX_AGE_SEC / 60} minutes after "issued".`,
      payloadFields: ['v', 'kind', 'key', 'subscriptionId', 'subscriptionIds', 'subject', 'chainId', 'change', 'check', 'attestation', 'reportURL'],
      kinds: [
        { kind: 'first-check', when: 'the first check of the vault after the subscription started' },
        { kind: 'change', when: 'a re-check changed the result (confirmed by a second check at a later block), or an upgrade changed the implementation' },
        { kind: 'price-drop', when: 'the value of a share fell, seen again at a later block; check, attestation and reportURL are null, the numbers are in change' },
      ],
      idempotencyKey: '<kind>:<chainId>:<subject>:<block>; drop repeats by key',
      delivery: `POST with JSON; v stays 1 and grows by adding fields, so ignore kinds and fields you do not know. Up to ${DEFAULT_WEBHOOK_ATTEMPTS} attempts, at most ${DEFAULT_WEBHOOK_MAX_TARGETS} subscribers and ${DEFAULT_WEBHOOK_DEADLINE_MS / 1000} seconds per event. Every alert also lands in the inbox at ${base}/watch/inbox.`,
    },
    watcher: watch
      ? { knows: watch.watched, foundBy: watch.found?.source ?? null, lastCheckBlock: watch.lastCheck?.block ?? null, lastCheckAt: watch.lastCheck?.at ?? null, lastAttestationId: watch.lastAttestationId }
      : null,
    notes: [
      'Informational only: this server never signs or sends a transaction. Subscribe from the vault page ("Watch this vault") with a browser wallet, or send the call above from your own wallet.',
      'A subscription buys delivery and freshness, not results: every result stays free and public.',
      'CheckSubscriptions lives on Monad testnet and is paid in testnet MON.',
    ],
    readAt: (deps.now ?? (() => new Date()))().toISOString(),
  };
}
