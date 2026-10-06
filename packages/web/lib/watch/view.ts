import { getAddress } from 'viem';
import { vaultStatusOf, type VaultMeta } from '../board/aggregate';
import { txUrl as testnetTxUrl } from '../board/attestations';
import { chainName } from '../board/reproduce';
import type { StatusCounts } from '../board/types';
import type { FeedEvent, FeedSource, WatchStatus, WatchVault } from './core';
import type { FeedEventJson, FoundJson, OutcomeJson, VaultLabelJson, WatchStatusJson } from './types';

/*
 * Pure functions from the watcher's files to the JSON the pages show. No I/O: service.ts reads the files, the
 * board and the reports, then calls these.
 */

/** Monad blocks are about 0.4 s (ADR 0006, "RPC facts"). */
export const SECONDS_PER_BLOCK = 0.4;
/** status.json is rewritten after every step; this long without a rewrite and the page says the watcher may be stopped. */
export const STALE_AFTER_SEC = 180;

/** The board's protocol labels for the factories of ADR 0006, keyed by lowercase factory address. */
export const FACTORY_PROTOCOL: Readonly<Record<string, string>> = {
  '0xba4dd672062de8feedb665dd4410658864483f1e': 'Euler EVK (eVault)',
  '0x8b2f922162fbb60a6a072cc784a2e4168fb0bb0c': 'Morpho Vault V2',
  '0x33f20973275b2f574488b18929cd7dcbf1abf275': 'Morpho MetaMorpho V1.1',
  '0xf463d4acb650cc6c4e1d6cd4d0d1b0cb224094cf': 'Euler Earn',
  '0x81148e8e1d9910080317e11c9f178559ba23bc80': 'Neverland (ERC-4626 static wrapper)',
};

const SUBJECT_TX_BASE: Readonly<Record<number, string>> = { 143: 'https://monadscan.com/tx/', 10143: 'https://testnet.monadscan.com/tx/' };

export function subjectTxUrl(chainId: number, hash: string): string | null {
  const base = SUBJECT_TX_BASE[chainId];
  return base ? `${base}${hash}` : null;
}

export function vaultPathOf(chainId: number, address: string): string {
  return `/v/${chainId}/${address.toLowerCase()}`;
}

export function checksum(address: string): string {
  try {
    return getAddress(address);
  } catch {
    return address;
  }
}

/** What the pages need to name a subject. Built once per request from the board and the metadata file. */
export interface LabelContext {
  meta: VaultMeta | null;
  /** Board vault ids, `<chainId>/<address lowercase>`. */
  boardIds: ReadonlySet<string>;
  /** Lowercase subject -> the factory that announced it, from the feed. */
  factories: ReadonlyMap<string, { address: string; name: string }>;
}

export function labelFor(chainId: number, address: string, ctx: LabelContext): VaultLabelJson {
  const a = address.toLowerCase();
  const m = ctx.meta?.[String(chainId)]?.[a] ?? null;
  const factory = ctx.factories.get(a);
  return {
    name: m?.name ?? null,
    protocol: m?.protocol ?? (factory ? (FACTORY_PROTOCOL[factory.address.toLowerCase()] ?? null) : null),
    assetSymbol: m?.assetSymbol ?? null,
    onList: Boolean(m),
    onBoard: ctx.boardIds.has(`${chainId}/${a}`),
  };
}

const SOURCE_TEXT: Readonly<Record<FeedSource, string>> = {
  factory: 'factory event',
  deposit: 'first Deposit event from an unknown address',
  upgrade: 'proxy upgrade',
  'beacon-upgrade': 'beacon upgrade',
  implementation: 'implementation change at its factory',
  'first-deposit': 'first deposit after its last check',
  sweep: 'scheduled re-check',
  subscribed: 'subscriber re-check',
  backfill: 'backfill scan',
};

export function sourceText(source: FeedSource | undefined | null, factory?: { name: string } | null): string | null {
  if (!source) return null;
  if (source === 'factory' && factory?.name) return `from ${factory.name}`;
  return SOURCE_TEXT[source] ?? source;
}

export function outcomeOf(o: { summary: StatusCounts; failed: string[] }): OutcomeJson {
  return { summary: { ...o.summary }, failed: [...o.failed], status: vaultStatusOf(o.summary) };
}

/** Lowercase subject -> its first detected event, and the factories that announced subjects. */
export function indexFeed(events: readonly FeedEvent[]): { firstDetected: Map<string, FeedEvent>; factories: Map<string, { address: string; name: string }> } {
  const firstDetected = new Map<string, FeedEvent>();
  const factories = new Map<string, { address: string; name: string }>();
  for (const e of events) {
    if (e.kind !== 'detected') continue;
    const a = e.subject.toLowerCase();
    if (!firstDetected.has(a)) firstDetected.set(a, e);
    if (e.factory && !factories.has(a)) factories.set(a, e.factory);
  }
  return { firstDetected, factories };
}

export function foundOf(entry: WatchVault | null | undefined, firstDetected: FeedEvent | undefined): FoundJson | null {
  if (entry) {
    return {
      source: entry.firstSeen.source,
      block: entry.firstSeen.block,
      at: entry.firstSeen.at,
      deployBlock: entry.deployBlock,
      factory: firstDetected?.factory ?? null,
      firstDepositBlock: entry.firstDepositBlock,
    };
  }
  if (!firstDetected?.source) return null;
  return {
    source: firstDetected.source,
    block: firstDetected.block ?? null,
    at: firstDetected.at,
    deployBlock: firstDetected.source === 'factory' ? (firstDetected.block ?? null) : null,
    factory: firstDetected.factory ?? null,
    firstDepositBlock: null,
  };
}

export interface ReportInfo {
  cells: string | null;
  reportUrl: string | null;
  reportMatches: boolean | null;
}

export const NO_REPORT: ReportInfo = { cells: null, reportUrl: null, reportMatches: null };

export function eventJson(e: FeedEvent, ctx: LabelContext, report: ReportInfo = NO_REPORT, found: FoundJson | null = null): FeedEventJson {
  const subject = checksum(e.subject);
  return {
    seq: e.seq,
    at: e.at,
    kind: e.kind,
    chainId: e.chainId,
    subject,
    vaultPath: vaultPathOf(e.chainId, subject),
    label: labelFor(e.chainId, subject, ctx),
    source: e.source ?? null,
    sourceText: sourceText(e.source, e.factory),
    block: e.block ?? null,
    txHash: e.txHash ?? null,
    txUrl: e.txHash ? subjectTxUrl(e.chainId, e.txHash) : null,
    factory: e.factory ? { address: checksum(e.factory.address), name: e.factory.name } : null,
    check: e.check
      ? {
          block: e.check.block,
          summary: { ...e.check.summary },
          failed: [...e.check.failed],
          status: vaultStatusOf(e.check.summary),
          implementationKey: e.check.implementationKey,
          reportHash: e.check.reportHash,
          durationMs: e.check.durationMs,
          ...report,
        }
      : null,
    attestation: e.attestation
      ? { id: e.attestation.id, txHash: e.attestation.txHash, txUrl: testnetTxUrl(e.attestation.txHash), supersedes: e.attestation.supersedes }
      : null,
    change: e.change ? { kind: e.change.kind, from: e.change.from ? outcomeOf(e.change.from) : null, to: outcomeOf(e.change.to) } : null,
    alert: e.alert
      ? {
          subscriptionId: e.alert.subscriptionId,
          subscriber: checksum(e.alert.subscriber),
          channel: e.alert.channel,
          ok: e.alert.ok,
          status: e.alert.status ?? null,
        }
      : null,
    reason: e.reason ?? null,
    found: e.kind === 'checked' || e.kind === 'attested' || e.kind === 'changed' ? found : null,
  };
}

/** Newest first by seq; `before` and `after` are exclusive seq bounds. */
export function pageOf(
  events: readonly FeedEvent[],
  o: { after?: number | null; before?: number | null; limit: number; filter?: (e: FeedEvent) => boolean },
): { page: FeedEvent[]; hasOlder: boolean; gap: boolean; latestSeq: number | null } {
  let latestSeq: number | null = null;
  for (const e of events) if (latestSeq === null || e.seq > latestSeq) latestSeq = e.seq;
  const sorted = events.filter((e) => (o.filter ? o.filter(e) : true)).sort((a, b) => b.seq - a.seq);
  let pool = sorted;
  if (o.before !== null && o.before !== undefined) pool = pool.filter((e) => e.seq < o.before!);
  if (o.after !== null && o.after !== undefined) pool = pool.filter((e) => e.seq > o.after!);
  const page = pool.slice(0, o.limit);
  const oldest = page[page.length - 1];
  const hasOlder = oldest ? sorted.some((e) => e.seq < oldest.seq) : false;
  const gap = o.after !== null && o.after !== undefined && pool.length > o.limit;
  return { page, hasOlder, gap, latestSeq };
}

export interface FoundCounts {
  watched: number;
  notOnList: number;
  notOnBoard: number;
  listSize: number;
}

/** The headline: vaults the watcher knows that the hand-made list (vault-meta.json) does not. */
export function countFound(chainId: number, vaults: Readonly<Record<string, WatchVault>>, meta: VaultMeta | null, boardIds: ReadonlySet<string>): FoundCounts {
  const list = meta?.[String(chainId)] ?? {};
  const keys = Object.keys(vaults);
  return {
    watched: keys.length,
    notOnList: keys.filter((a) => !list[a.toLowerCase()]).length,
    notOnBoard: keys.filter((a) => !boardIds.has(`${chainId}/${a.toLowerCase()}`)).length,
    listSize: Object.keys(list).length,
  };
}

export interface StatusInput {
  chainId: number;
  chains: number[];
  dir: string;
  status: WatchStatus | null;
  problem: string | null;
  gasCostWei: bigint | null;
  ctx: LabelContext;
  found: FoundCounts;
  feed: WatchStatusJson['feed'];
  vaultsFile: WatchStatusJson['vaultsFile'];
  now: Date;
  queueShown?: number;
}

function secondsBetween(fromIso: string, now: Date): number {
  const t = Date.parse(fromIso);
  return Number.isNaN(t) ? 0 : Math.max(0, Math.round((now.getTime() - t) / 1000));
}

export function statusJson(i: StatusInput): WatchStatusJson {
  const s = i.status;
  const behind = s ? Math.max(0, Number(BigInt(s.head) - BigInt(s.cursor))) : null;
  const updatedAgo = s ? secondsBetween(s.updatedAt, i.now) : null;
  return {
    chainId: i.chainId,
    chainName: chainName(i.chainId),
    chains: i.chains,
    dir: i.dir,
    running: Boolean(s),
    problem: i.problem,
    head: s?.head ?? null,
    cursor: s?.cursor ?? null,
    lagBlocks: s?.lagBlocks ?? null,
    behindBlocks: behind,
    behindSeconds: behind === null ? null : Math.round(behind * SECONDS_PER_BLOCK),
    startedAt: s?.startedAt ?? null,
    updatedAt: s?.updatedAt ?? null,
    updatedAgoSec: updatedAgo,
    stale: updatedAgo !== null && updatedAgo > STALE_AFTER_SEC,
    now: s?.running
      ? {
          subject: checksum(s.running.subject),
          vaultPath: vaultPathOf(i.chainId, s.running.subject),
          label: labelFor(i.chainId, s.running.subject, i.ctx),
          source: s.running.source,
          stage: s.running.stage,
          startedAt: s.running.startedAt,
          forSec: secondsBetween(s.running.startedAt, i.now),
        }
      : null,
    queue: (s?.queue ?? []).slice(0, i.queueShown ?? 8).map((q) => ({
      subject: checksum(q.subject),
      vaultPath: vaultPathOf(i.chainId, q.subject),
      label: labelFor(i.chainId, q.subject, i.ctx),
      source: q.source,
      enqueuedAt: q.enqueuedAt,
    })),
    queueLength: s?.queue.length ?? 0,
    counts: s ? { ...s.counts } : null,
    sources: (s?.sources ?? []).map((x) => ({ name: x.name, address: x.address ? checksum(x.address) : null, topic0: x.topic0, seen: x.seen })),
    attestBudget: s ? { ...s.attestBudget } : null,
    gasCostWei: i.gasCostWei === null ? null : i.gasCostWei.toString(),
    found: i.found,
    feed: i.feed,
    vaultsFile: i.vaultsFile,
    readAt: i.now.toISOString(),
  };
}
