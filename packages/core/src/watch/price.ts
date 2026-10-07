// Share value drops (docs/adr/0006, "Share value"): the watcher reads convertToAssets of one whole share of a
// subject at the block it reads, keeps a reference per subject, and turns a fall larger than a threshold, seen
// again at a later block and some time later, into a price-drop change. The decision is pure and only imports
// types, so the web can use it through `@specfirst/core/watch`.
import type { PriceDropChange } from './schema.js';

/**
 * One read of a subject's share value: convertToAssets(10 ** (shareDecimals + scale)) at `block`, in the asset's
 * base units, read at `at` (ms). scale is above 0 only for a vault whose one share is worth fewer than
 * MIN_PRICE_UNITS base units (L3 of the review): then 10 ** scale shares are valued, so one unit of rounding is
 * not a drop.
 */
export interface SharePrice {
  assetsPerShare: bigint;
  shareDecimals: number;
  scale: number;
  block: bigint;
  at: number;
}

/**
 * What a share value read found. ok false: the contract answered, but not with a value worth keeping (a revert,
 * no data, a totalSupply of 0, a value too small to measure a drop in: lowResolution); nothing is recorded. An RPC
 * failure is not a SharePriceRead: it is thrown.
 */
export type SharePriceRead = { ok: true; assetsPerShare: bigint; shareDecimals: number; scale: number } | { ok: false; reason: string; lowResolution?: boolean };

/**
 * What the watcher keeps per subject. The reference (assetsPerShare at block, for 10 ** (decimals + scale) shares)
 * is the value drops are measured from. It moves up only to a value seen at two different blocks (the lower of the
 * last two reads), down only with a confirmed drop; a fall within the threshold keeps it, so small falls add up.
 * readAssetsPerShare and readBlock are the last read. drop: a fall over the threshold, first seen at `block` and
 * `at` (ms), waiting for a read at least confirmBlocks and confirmMs later; misses counts the reads since that gave
 * no value.
 */
export interface PriceTrack {
  decimals: number;
  scale: number;
  assetsPerShare: bigint;
  block: bigint;
  readAssetsPerShare: bigint;
  readBlock: bigint;
  drop?: { assetsPerShare: bigint; block: bigint; at: number; misses: number };
}

/** When a fall is a drop and when it is confirmed. */
export interface PriceRules {
  /** A fall of more than this many basis points of the reference. */
  thresholdBps: number;
  /** The confirming read comes at least this long after the first sighting... */
  confirmMs: number;
  /** ...and at least this many blocks after it. */
  confirmBlocks: number;
  /** A fall not confirmed within this long is forgotten. */
  dropTtlMs: number;
  /** A fall is forgotten after this many reads in a row that gave no value. */
  dropMaxMisses: number;
}

export const BPS = 10_000n;
/** A share value below this many base units is read for 10 ** scale shares (scale up to MAX_PRICE_SCALE). */
export const MIN_PRICE_UNITS = 10_000n;
export const MAX_PRICE_SCALE = 6;

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
 * The scale at which `value` (base units for 10 ** decimals shares) reaches MIN_PRICE_UNITS: 0 when it does,
 * else the smallest k up to MAX_PRICE_SCALE with value * 10 ** k >= MIN_PRICE_UNITS, null when none does (a value
 * of 0).
 */
export function priceScaleFor(value: bigint): number | null {
  for (let k = 0; k <= MAX_PRICE_SCALE; k++) if (value * 10n ** BigInt(k) >= MIN_PRICE_UNITS) return k;
  return null;
}

/**
 * One read applied to a subject's track.
 * - first: no track yet, the read is the reference. reset: decimals() or the scale moved, so the value is of another
 *   amount; the read is the new reference and a pending fall is forgotten. stale: a read at a block not after the
 *   last one says nothing new; the track is unchanged.
 * - pending: a fall over the threshold, first seen. waiting: still over the threshold, but not yet confirmBlocks and
 *   confirmMs after the first sighting. confirmed: still over the threshold that much later; the read becomes the
 *   reference and `change` is the price-drop, measured from the reference to this read. A pending fall that a later
 *   read does not bear out (a one-block glitch), or that is older than dropTtlMs, is `cleared` and the rules below
 *   apply to the read.
 * - rise: the reference moves to the lower of this read and the one before when that is higher than the reference,
 *   so a one-read spike never becomes a reference that a return to normal would fall from. same: an unchanged value
 *   moves the reference's block. small-drop: a fall within the threshold keeps the reference.
 */
export type PriceStep =
  | {
      kind: 'first' | 'reset' | 'stale' | 'pending' | 'waiting' | 'rise' | 'same' | 'small-drop';
      next: PriceTrack;
      cleared?: { assetsPerShare: bigint; block: bigint; expired: boolean };
    }
  | { kind: 'confirmed'; next: PriceTrack; change: PriceDropChange; pendingBlock: bigint };

export function priceStep(track: PriceTrack | null, read: SharePrice, rules: PriceRules): PriceStep {
  const reference = (r: SharePrice): PriceTrack => ({
    decimals: r.shareDecimals,
    scale: r.scale,
    assetsPerShare: r.assetsPerShare,
    block: r.block,
    readAssetsPerShare: r.assetsPerShare,
    readBlock: r.block,
  });
  if (!track) return { kind: 'first', next: reference(read) };
  if (read.block <= track.readBlock) return { kind: 'stale', next: track };
  if (read.shareDecimals !== track.decimals || read.scale !== track.scale) return { kind: 'reset', next: reference(read) };
  const over = exceedsDrop(track.assetsPerShare, read.assetsPerShare, rules.thresholdBps);
  const base: PriceTrack = { ...track, readAssetsPerShare: read.assetsPerShare, readBlock: read.block };
  delete base.drop;
  const drop = track.drop;
  const expired = !!drop && read.at - drop.at > rules.dropTtlMs;
  if (drop && !expired && over) {
    if (read.block - drop.block >= BigInt(rules.confirmBlocks) && read.at - drop.at >= rules.confirmMs) {
      const change: PriceDropChange = {
        kind: 'price-drop',
        fromAssetsPerShare: track.assetsPerShare.toString(),
        toAssetsPerShare: read.assetsPerShare.toString(),
        dropBps: dropBpsOf(track.assetsPerShare, read.assetsPerShare),
        fromBlock: track.block.toString(),
        toBlock: read.block.toString(),
        ...(read.scale ? { scale: read.scale } : {}),
      };
      return { kind: 'confirmed', next: reference(read), change, pendingBlock: drop.block };
    }
    return { kind: 'waiting', next: { ...base, drop: { ...drop, misses: 0 } } };
  }
  const cleared = drop ? { cleared: { assetsPerShare: drop.assetsPerShare, block: drop.block, expired } } : {};
  if (over) return { kind: 'pending', next: { ...base, drop: { assetsPerShare: read.assetsPerShare, block: read.block, at: read.at, misses: 0 } }, ...cleared };
  if (read.assetsPerShare > track.assetsPerShare) {
    // The lower of the last two reads, at its own block: a value the vault held at both blocks.
    const prev = { assetsPerShare: track.readAssetsPerShare, block: track.readBlock };
    const seen = prev.assetsPerShare < read.assetsPerShare ? prev : { assetsPerShare: read.assetsPerShare, block: read.block };
    const next = seen.assetsPerShare > track.assetsPerShare ? { ...base, assetsPerShare: seen.assetsPerShare, block: seen.block } : base;
    return { kind: 'rise', next, ...cleared };
  }
  if (read.assetsPerShare === track.assetsPerShare) return { kind: 'same', next: { ...base, block: read.block }, ...cleared };
  return { kind: 'small-drop', next: base, ...cleared };
}

/**
 * A read that gave no value (an RPC failure, a revert, an empty vault) while a fall waits: it counts as a miss, and
 * the fall is forgotten after dropMaxMisses of them or once older than dropTtlMs, so a vault that stops answering
 * cannot keep a pending fall at the head of the read round. `forgotten` says it was.
 */
export function priceMiss(track: PriceTrack, now: number, rules: PriceRules): { next: PriceTrack; forgotten: boolean } {
  if (!track.drop) return { next: track, forgotten: false };
  const misses = track.drop.misses + 1;
  if (misses >= rules.dropMaxMisses || now - track.drop.at > rules.dropTtlMs) {
    const next = { ...track };
    delete next.drop;
    return { next, forgotten: true };
  }
  return { next: { ...track, drop: { ...track.drop, misses } }, forgotten: false };
}

/** "0.42%" for 42 basis points. */
export function dropPercentText(dropBps: number): string {
  return `${(dropBps / 100).toFixed(2)}%`;
}
