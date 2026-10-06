import type { ExplorerRow } from '../board/view';

/*
 * The board overlay (ADR 0006): vaults in the watcher's vaults.json that the board build does not have join the
 * vault table, marked as found by the watcher. Pure; service.ts builds the overlay rows from reports.
 */

/**
 * Board rows first, unchanged apart from groupSize; then overlay rows whose id the board does not have, once
 * each. Group sizes are recounted over the merged list, so a found vault that shares an implementation with
 * board vaults says so, and those board vaults count it.
 */
export function mergeOverlay(board: readonly ExplorerRow[], overlay: readonly ExplorerRow[]): ExplorerRow[] {
  const ids = new Set(board.map((r) => r.id));
  const extra: ExplorerRow[] = [];
  for (const r of overlay) {
    if (ids.has(r.id)) continue;
    ids.add(r.id);
    extra.push(r);
  }
  if (extra.length === 0) return [...board];
  const added = new Map<string, number>();
  for (const r of extra) added.set(r.implementationKey, (added.get(r.implementationKey) ?? 0) + 1);
  const boardByKey = new Map<string, number>();
  for (const r of board) boardByKey.set(r.implementationKey, Math.max(boardByKey.get(r.implementationKey) ?? 0, r.groupSize));
  return [
    ...board.map((r) => (added.has(r.implementationKey) ? { ...r, groupSize: r.groupSize + added.get(r.implementationKey)! } : r)),
    ...extra.map((r) => ({ ...r, groupSize: (boardByKey.get(r.implementationKey) ?? 0) + added.get(r.implementationKey)! })),
  ];
}

/** Protocol names for the filter, with the overlay's added. */
export function mergedProtocols(protocols: readonly string[], overlay: readonly ExplorerRow[]): string[] {
  return [...new Set([...protocols, ...overlay.map((r) => r.protocol).filter((p): p is string => Boolean(p))])].sort();
}
