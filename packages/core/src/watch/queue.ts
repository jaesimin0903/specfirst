import type { Address, Hex } from 'viem';
import type { FeedSource } from './schema.js';

/**
 * One queued check. One entry per subject (checksummed); the lowest priority value runs first, then the
 * earliest enqueuedAt. attempts counts failed checks of this entry; notBefore holds it back after one.
 */
export interface QueueEntry {
  subject: Address;
  source: FeedSource;
  priority: number;
  enqueuedAt: string;
  /** Block and transaction of the signal that queued it, when there is one. */
  block?: string;
  txHash?: Hex;
  attempts: number;
  notBefore?: string;
}

/**
 * Queue priorities (docs/adr/0006, "Pipeline"), highest first: a subscribed subject, a new candidate, an
 * upgrade or implementation change of a known vault, a first deposit, the sweep (and the re-check after a confirmed
 * fall of the share value of a subject nobody subscribed to: a vault can make its value saw up and down for free).
 */
export const QUEUE_PRIORITY = { subscribed: 0, candidate: 1, upgrade: 2, firstDeposit: 3, sweep: 4 } as const;

/** Priority of a check queued for `source`; `candidate` is true for a subject the watcher has never checked. */
export function priorityOf(source: FeedSource, candidate: boolean): number {
  if (source === 'subscribed') return QUEUE_PRIORITY.subscribed;
  if (candidate) return QUEUE_PRIORITY.candidate;
  if (source === 'upgrade' || source === 'beacon-upgrade' || source === 'implementation') return QUEUE_PRIORITY.upgrade;
  if (source === 'first-deposit') return QUEUE_PRIORITY.firstDeposit;
  return QUEUE_PRIORITY.sweep;
}

/**
 * Adds `entry`, or raises the subject's existing entry when `entry` has the higher priority (its source,
 * signal and enqueuedAt replace the old ones; attempts start over). A lower or equal priority keeps the
 * existing entry. Mutates `queue`.
 */
export function enqueue(queue: QueueEntry[], entry: QueueEntry): 'added' | 'raised' | 'kept' {
  const key = entry.subject.toLowerCase();
  const i = queue.findIndex((q) => q.subject.toLowerCase() === key);
  if (i < 0) {
    queue.push(entry);
    return 'added';
  }
  if (entry.priority < queue[i]!.priority) {
    queue[i] = entry;
    return 'raised';
  }
  return 'kept';
}

function order(a: QueueEntry, b: QueueEntry): number {
  return a.priority - b.priority || a.enqueuedAt.localeCompare(b.enqueuedAt);
}

/** The queue in running order. */
export function queueOrder(queue: readonly QueueEntry[]): QueueEntry[] {
  return [...queue].sort(order);
}

/** The entry to run next at `now`: the first in running order whose notBefore has passed. */
export function nextEntry(queue: readonly QueueEntry[], now: Date): QueueEntry | undefined {
  const t = now.toISOString();
  return queueOrder(queue).find((q) => !q.notBefore || q.notBefore <= t);
}

export function removeEntry(queue: QueueEntry[], subject: Address): void {
  const key = subject.toLowerCase();
  const i = queue.findIndex((q) => q.subject.toLowerCase() === key);
  if (i >= 0) queue.splice(i, 1);
}
