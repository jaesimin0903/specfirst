import { formatBlock } from '../board/reasons';
import { shortAddress } from '../format';
import type { StatusCounts } from '../board/types';
import { dropPercentText, type ChangeKind, type FeedKind, type WatchStage } from './core';

/* Words the watch pages use for the feed. Client-safe. */

export const KIND_LABEL: Readonly<Record<FeedKind, string>> = {
  detected: 'Found',
  'probe-rejected': 'Not a vault',
  queued: 'Queued',
  checked: 'Checked',
  attested: 'Attested',
  changed: 'Result changed',
  alerted: 'Alert',
  error: 'Error',
};

export const CHANGE_LABEL: Readonly<Record<ChangeKind, string>> = {
  new: 'First result',
  regressed: 'Regressed',
  recovered: 'Recovered',
  changed: 'Result changed',
  implementation: 'New implementation',
  'price-drop': 'Share value fell',
};

export const STAGE_LABEL: Readonly<Record<WatchStage, string>> = {
  probing: 'Probing',
  checking: 'Checking',
  attesting: 'Attesting',
};

/** "Share value fell 0.42% between block 110,977,300 and block 110,977,400." A fact about two blocks, not a verdict. */
export function priceDropSentence(c: { dropBps: number; fromBlock: string; toBlock: string }): string {
  return `Share value fell ${dropPercentText(c.dropBps)} between block ${blockText(c.fromBlock)} and block ${blockText(c.toBlock)}.`;
}

/**
 * One line on a body the demo receiver got, or null when it does not name a subject: "Subscription #0: regressed on
 * 0x1234..abcd, chain 143", or for a price-drop alert "Subscription #0: share value fell 0.42% between block 10 and
 * block 12 on ...". The body is untrusted: only numbers and strings of the right type are shown.
 */
export function alertSummary(body: unknown): string | null {
  const b = body as { subscriptionId?: string; subject?: string; chainId?: number; kind?: string; change?: { kind?: string; dropBps?: unknown; fromBlock?: unknown; toBlock?: unknown } } | null;
  if (!b || typeof b !== 'object' || typeof b.subject !== 'string') return null;
  const c = b.change;
  const drop = b.kind === 'price-drop' && c && typeof c.dropBps === 'number' && typeof c.fromBlock === 'string' && typeof c.toBlock === 'string';
  const what = drop
    ? `share value fell ${dropPercentText(c.dropBps as number)} between block ${c.fromBlock as string} and block ${c.toBlock as string}`
    : typeof c?.kind === 'string'
      ? c.kind
      : typeof b.kind === 'string'
        ? b.kind
        : 'change';
  return `Subscription #${b.subscriptionId ?? '?'}: ${what} on ${shortAddress(b.subject)}${b.chainId ? `, chain ${b.chainId}` : ''}`;
}

/** "26 pass, 0 fail, 0 inconclusive, 4 not applicable" */
export function countsText(s: StatusCounts): string {
  return `${s.pass} pass, ${s.fail} fail, ${s.inconclusive} inconclusive, ${s.notApplicable} not applicable`;
}

/** "09:25:04" from an ISO time, UTC. */
export function clock(iso: string): string {
  return iso.slice(11, 19);
}

/** "2026-10-06 09:25 UTC" */
export function stamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function blockText(b: string | null): string {
  return b ? formatBlock(b) : 'unknown';
}

/** Failed property ids that appear in `to` and not in `from`, and the other way round. */
export function failedDiff(from: readonly string[], to: readonly string[]): { added: string[]; removed: string[] } {
  const f = new Set(from);
  const t = new Set(to);
  return { added: to.filter((x) => !f.has(x)), removed: from.filter((x) => !t.has(x)) };
}

/** Whole seconds between two ISO times, or null. */
export function secondsBetween(a: string, b: string): number | null {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.round((y - x) / 1000);
}

/** One sentence on how the watcher came to a vault, for the vault page. */
export function foundSentence(f: {
  source: string;
  block: string | null;
  at: string;
  deployBlock: string | null;
  factory: { name: string } | null;
  firstDepositBlock: string | null;
}): string {
  const when = stamp(f.at);
  const at = f.block ? ` in block ${blockText(f.block)}` : '';
  let s: string;
  switch (f.source) {
    case 'factory':
      s = `Created by ${f.factory?.name ?? 'a factory the watcher follows'}${f.deployBlock ? ` in block ${blockText(f.deployBlock)}` : at}; the watcher found it ${when}.`;
      break;
    case 'deposit':
      s = `Found by the watcher at its first Deposit event${at}, ${when}. No factory the watcher follows announced it.`;
      break;
    case 'upgrade':
    case 'beacon-upgrade':
    case 'implementation':
      s = `Found by the watcher through a proxy or implementation upgrade${at}, ${when}.`;
      break;
    case 'backfill':
      s = `Known to the watcher from a backfill scan${at}, ${when}.`;
      break;
    default:
      s = `Known to the watcher since ${when}.`;
  }
  if (f.firstDepositBlock && f.source !== 'deposit') s += ` First deposit seen in block ${blockText(f.firstDepositBlock)}.`;
  return s;
}

/**
 * The title of an inbox item: "First result" for a vault's first outcome (change kind new), "Share value fell" for a
 * confirmed fall of the share value, "Result changed" only for a real change, then the first check since the
 * subscription started and deliveries.
 */
export function inboxNote(kind: 'change' | 'first-check' | 'delivery', changeKind: ChangeKind | null | undefined): string {
  if (kind === 'change') return changeKind === 'new' ? 'First result' : changeKind === 'price-drop' ? 'Share value fell' : 'Result changed';
  return kind === 'first-check' ? 'First check since you subscribed' : 'Delivery';
}
