// Share value drops (docs/adr/0006, "Share value"): the watcher reads convertToAssets of one whole share of a
// subject at the block it reads, keeps a reference per subject, and turns a fall larger than a threshold, seen
// again at a later block, into a price-drop change. The decision is pure and only imports types, so the web can
// use it through `@specfirst/core/watch`.
import type { PriceDropChange } from './schema.js';

/** One read of a subject's share value: convertToAssets(10 ** shareDecimals) at `block`, in the asset's base units. */
export interface SharePrice {
  assetsPerShare: bigint;
  shareDecimals: number;
  block: bigint;
}

/**
 * What a share value read found. ok false: the contract answered, but not with a value worth keeping (a revert,
 * no data, a totalSupply of 0); nothing is recorded. An RPC failure is not a SharePriceRead: it is thrown.
 */
export type SharePriceRead = { ok: true; assetsPerShare: bigint; shareDecimals: number } | { ok: false; reason: string };

/**
 * What the watcher keeps per subject. The reference (assetsPerShare at block, for shares of `decimals`) is the
 * value drops are measured from: a rise or an unchanged value moves it, a fall within the threshold does not, so
 * small falls add up. readBlock is the block of the last read. drop: a fall over the threshold seen once and
 * waiting for a read at a later block.
 */
export interface PriceTrack {
  decimals: number;
  assetsPerShare: bigint;
  block: bigint;
  readBlock: bigint;
  drop?: { assetsPerShare: bigint; block: bigint };
}

export const BPS = 10_000n;

/** The fall from `from` to `to` in basis points of `from`, rounded down; 0 when it did not fall or `from` is 0. */
export function dropBpsOf(from: bigint, to: bigint): number {
  if (from <= 0n || to >= from) return 0;
  return Number(((from - to) * BPS) / from);
}

/** True when `to` is more than `thresholdBps` basis points below `from`, exactly (no rounding). */
export function exceedsDrop(from: bigint, to: bigint, thresholdBps: number): boolean {
  return to < from && (from - to) * BPS > BigInt(thresholdBps) * from;
}

/**
 * One read applied to a subject's track. first: no track yet, the read is the reference. stale: a read at a
 * block not after the last one says nothing new; the track is unchanged. decimals: decimals() moved, so one share
 * is another amount; the read becomes the reference and a pending drop is forgotten. pending: a fall over the
 * threshold, kept until a read at a later block. confirmed: a pending fall still over the threshold at a later
 * block; the read becomes the reference and `change` is the price-drop. A pending fall that a later read does not
 * bear out (a one-block glitch) is `cleared` and the rules below apply to that read: rise and same move the
 * reference to the read, small-drop (a fall within the threshold) keeps it.
 */
export type PriceStep =
  | { kind: 'first' | 'stale' | 'decimals' | 'pending' | 'rise' | 'same' | 'small-drop'; next: PriceTrack; cleared?: { assetsPerShare: bigint; block: bigint } }
  | { kind: 'confirmed'; next: PriceTrack; change: PriceDropChange; pendingBlock: bigint };

export function priceStep(track: PriceTrack | null, read: SharePrice, thresholdBps: number): PriceStep {
  const reference = (r: SharePrice): PriceTrack => ({ decimals: r.shareDecimals, assetsPerShare: r.assetsPerShare, block: r.block, readBlock: r.block });
  if (!track) return { kind: 'first', next: reference(read) };
  if (read.block <= track.readBlock) return { kind: 'stale', next: track };
  if (read.shareDecimals !== track.decimals) return { kind: 'decimals', next: reference(read) };
  const over = exceedsDrop(track.assetsPerShare, read.assetsPerShare, thresholdBps);
  if (track.drop && over) {
    const change: PriceDropChange = {
      kind: 'price-drop',
      fromAssetsPerShare: track.assetsPerShare.toString(),
      toAssetsPerShare: read.assetsPerShare.toString(),
      dropBps: dropBpsOf(track.assetsPerShare, read.assetsPerShare),
      fromBlock: track.block.toString(),
      toBlock: read.block.toString(),
    };
    return { kind: 'confirmed', next: reference(read), change, pendingBlock: track.drop.block };
  }
  const cleared = track.drop ? { cleared: track.drop } : {};
  const base: PriceTrack = { decimals: track.decimals, assetsPerShare: track.assetsPerShare, block: track.block, readBlock: read.block };
  if (over) return { kind: 'pending', next: { ...base, drop: { assetsPerShare: read.assetsPerShare, block: read.block } } };
  if (read.assetsPerShare > track.assetsPerShare) return { kind: 'rise', next: reference(read), ...cleared };
  if (read.assetsPerShare === track.assetsPerShare) return { kind: 'same', next: { ...base, block: read.block }, ...cleared };
  return { kind: 'small-drop', next: base, ...cleared };
}

/** "0.42%" for 42 basis points. */
export function dropPercentText(dropBps: number): string {
  return `${(dropBps / 100).toFixed(2)}%`;
}
