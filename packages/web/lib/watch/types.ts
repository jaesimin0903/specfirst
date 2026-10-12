import type { FailureLevel } from '../board/levels';
import type { StatusCounts, VaultStatus } from '../board/types';
import type { CheckChangeKind, FeedKind, FeedSource, WatchStage } from './core';

/*
 * JSON the watch API routes return and the watch components read. Block numbers and wei are decimal strings,
 * times ISO 8601. Client-safe: types only.
 */

export interface VaultLabelJson {
  name: string | null;
  protocol: string | null;
  assetSymbol: string | null;
  /** On the hand-made list (data/vault-meta.json) the board started from. */
  onList: boolean;
  /** In the board build. */
  onBoard: boolean;
}

export interface OutcomeJson {
  summary: StatusCounts;
  failed: string[];
  status: VaultStatus;
  /**
   * lib/board/levels FailureLevel of the failures, read from the check's report when it is on this server and hashes
   * to the feed's reportHash; null otherwise, and when nothing failed. Without it the failed ids give a level.
   */
  failureLevel: FailureLevel | null;
}

/** How the watcher first came to a subject: from vaults.json, else from its first detected event. */
export interface FoundJson {
  source: FeedSource;
  /** Block of the signal (the factory event, the deposit, the upgrade). */
  block: string | null;
  /** When the watcher saw it. */
  at: string;
  deployBlock: string | null;
  factory: { address: string; name: string } | null;
  firstDepositBlock: string | null;
}

/**
 * A change of a check's result, or a confirmed fall of the share value: convertToAssets of one share read at
 * fromBlock and at toBlock (asset base units), the fall in basis points rounded down.
 */
export type ChangeJson =
  | { kind: CheckChangeKind; from: OutcomeJson | null; to: OutcomeJson }
  | { kind: 'price-drop'; fromAssetsPerShare: string; toAssetsPerShare: string; dropBps: number; fromBlock: string; toBlock: string; scale?: number };

export interface FeedEventJson {
  seq: number;
  at: string;
  kind: FeedKind;
  chainId: number;
  /** Checksummed, as the feed writes it. */
  subject: string;
  vaultPath: string;
  label: VaultLabelJson;
  source: FeedSource | null;
  /** "from Morpho VaultV2Factory", "first deposit", "proxy upgrade". */
  sourceText: string | null;
  block: string | null;
  txHash: string | null;
  /** The signal's transaction on the subject chain's explorer. */
  txUrl: string | null;
  factory: { address: string; name: string } | null;
  check: {
    block: string;
    summary: StatusCounts;
    failed: string[];
    status: VaultStatus;
    implementationKey: string | null;
    reportHash: string;
    durationMs: number;
    /** One character per property in report order (p, f, i, n); null when the report file is not here. */
    cells: string | null;
    reportUrl: string | null;
    /** The report file's keccak256 equals the feed's reportHash; null when the file was not read. */
    reportMatches: boolean | null;
    /**
     * lib/board/levels FailureLevel of the failures, read from their reasons and forge's logs as the board does
     * ('rounding' when only round trips failed, each by a rounding-sized difference). Null unless reportMatches is
     * true, and when nothing failed; then the failed ids alone give a level.
     */
    failureLevel: FailureLevel | null;
  } | null;
  attestation: { id: string; txHash: string; txUrl: string; supersedes: string | null } | null;
  change: ChangeJson | null;
  alert: { subscriptionId: string; subscriber: string; channel: 'webhook' | 'inbox'; ok: boolean; status: number | null } | null;
  reason: string | null;
  /** For checks and attestations: how the subject was found, so a factory find can show deploy block against check time. */
  found: FoundJson | null;
}

export interface QueueItemJson {
  subject: string;
  vaultPath: string;
  label: VaultLabelJson;
  source: string;
  enqueuedAt: string;
}

export interface WatchStatusJson {
  chainId: number;
  chainName: string;
  /** Chains with a directory under the watch dir. */
  chains: number[];
  /** Watch directory as shown on the page (relative to the repository). */
  dir: string;
  /** status.json was read and matched the schema. */
  running: boolean;
  problem: string | null;
  head: string | null;
  cursor: string | null;
  lagBlocks: number | null;
  /** head - cursor */
  behindBlocks: number | null;
  /** behindBlocks at about 0.4 s a block */
  behindSeconds: number | null;
  startedAt: string | null;
  updatedAt: string | null;
  updatedAgoSec: number | null;
  /**
   * No status update for more than STALE_AFTER_SEC, and no step (now) that started less than STEP_STALE_AFTER_SEC
   * ago: the watcher may have stopped. A long check writes nothing until it ends, so it is not stale by itself.
   */
  stale: boolean;
  now: { subject: string; vaultPath: string; label: VaultLabelJson; source: string; stage: WatchStage; startedAt: string; forSec: number } | null;
  queue: QueueItemJson[];
  queueLength: number;
  /** changed24h counts changes of a result; priceDrops24h (absent from older watchers) confirmed falls of a share value. */
  counts: { known: number; detected24h: number; checked24h: number; attested24h: number; changed24h: number; priceDrops24h?: number } | null;
  sources: { name: string; address: string | null; topic0: string; seen: number }[];
  attestBudget: { perDay: number; usedToday: number } | null;
  gasCostWei: string | null;
  found: {
    /** Vaults in vaults.json. */
    watched: number;
    /** Of those, not on the hand-made list. */
    notOnList: number;
    /** Of those, not in the board build (they reach the board through the overlay). */
    notOnBoard: number;
    /** Size of the hand-made list for this chain. */
    listSize: number;
  };
  feed: { available: boolean; problem: string | null; events: number; latestSeq: number | null; skipped: number };
  vaultsFile: { available: boolean; problem: string | null; skipped: number };
  readAt: string;
}

export interface FeedPageJson {
  chainId: number;
  available: boolean;
  problem: string | null;
  /** Newest first. */
  events: FeedEventJson[];
  latestSeq: number | null;
  /** More events exist before the oldest one returned. */
  hasOlder: boolean;
  /** With ?after=: more new events exist than were returned (the client should reset to this page). */
  gap: boolean;
  skipped: number;
  readAt: string;
}

export interface VaultWatchJson {
  chainId: number;
  address: string;
  watched: boolean;
  found: FoundJson | null;
  lastCheck: { block: string; at: string; summary: StatusCounts; status: VaultStatus } | null;
  lastAttestationId: string | null;
  label: VaultLabelJson;
  /** Newest first. */
  history: FeedEventJson[];
  readAt: string;
}
