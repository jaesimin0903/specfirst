import { formatBlock } from '../board/reasons';
import type { StatusCounts } from '../board/types';
import type { ChangeKind, FeedKind, WatchStage } from './core';

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
};

export const STAGE_LABEL: Readonly<Record<WatchStage, string>> = {
  probing: 'Probing',
  checking: 'Checking',
  attesting: 'Attesting',
};

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
 * The title of an inbox item: "First result" for a vault's first outcome (change kind new), "Result changed" only
 * for a real change, then the first check since the subscription started and deliveries.
 */
export function inboxNote(kind: 'change' | 'first-check' | 'delivery', changeKind: ChangeKind | null | undefined): string {
  if (kind === 'change') return changeKind === 'new' ? 'First result' : 'Result changed';
  return kind === 'first-check' ? 'First check since you subscribed' : 'Delivery';
}
