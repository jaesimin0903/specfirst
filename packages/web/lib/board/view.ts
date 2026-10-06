import type { AttestationLite, VaultRow, VaultStatus, VaultTraitView } from './types';

/* Filtering and sorting for the vault table. Client-safe: no Node imports. */

/** A vault the watcher found that the board build does not have (ADR 0006): how it was found. */
export interface WatchFoundMark {
  /** "from Morpho VaultV2Factory", "first Deposit event from an unknown address" */
  sourceText: string;
  /** Block of the signal that found it. */
  block: string | null;
  at: string;
}

/** The part of a board row the vault table ships to the browser. */
export type ExplorerRow = Pick<
  VaultRow,
  'id' | 'address' | 'name' | 'protocol' | 'assetSymbol' | 'status' | 'summary' | 'cells' | 'implementationKey' | 'implementationKeyKind' | 'implementationAddress' | 'groupSize'
> & { failed: { id: string }[]; attestation: AttestationLite; found?: WatchFoundMark; traits?: VaultTraitView[] };

export type ExplorerView = 'vaults' | 'implementations';

export function toExplorerRow(r: VaultRow): ExplorerRow {
  const a = r.attestation;
  return {
    id: r.id,
    address: r.address,
    name: r.name,
    protocol: r.protocol,
    assetSymbol: r.assetSymbol,
    status: r.status,
    summary: r.summary,
    cells: r.cells,
    implementationKey: r.implementationKey,
    implementationKeyKind: r.implementationKeyKind,
    implementationAddress: r.implementationAddress,
    groupSize: r.groupSize,
    failed: r.failed.map((f) => ({ id: f.id })),
    ...(r.traits.length > 0 ? { traits: r.traits } : {}),
    attestation: a.kind === 'attested' ? { kind: 'attested', id: a.id, status: a.status, matchesReport: a.matchesReport, blockNumber: a.blockNumber } : a,
  };
}

export type SortKey = 'status' | 'vault' | 'protocol' | 'asset' | 'pass' | 'fail' | 'inconclusive' | 'notApplicable' | 'implementation' | 'attestation';
export type SortDir = 'asc' | 'desc';
export type StatusFilter = VaultStatus | 'all';

export interface Filters {
  protocol: string;
  status: StatusFilter;
  query: string;
}

export const ALL = 'all';
const STATUS_RANK: Record<VaultStatus, number> = { mismatch: 0, complete: 1, partial: 2, not_applicable: 3 };

/** Case-insensitive match on name, address, protocol, asset, implementation key and failed property ids. */
export function matchesQuery(row: ExplorerRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const found = row.found ? `watcher ${row.found.sourceText}` : null;
  const hay = [row.name, row.address, row.protocol, row.assetSymbol, row.implementationKey, row.implementationAddress, found, ...row.failed.map((f) => f.id)]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

export function filterRows<R extends ExplorerRow>(rows: readonly R[], f: Filters): R[] {
  return rows.filter(
    (r) => (f.protocol === ALL || (r.protocol ?? 'Unknown protocol') === f.protocol) && (f.status === ALL || r.status === f.status) && matchesQuery(r, f.query),
  );
}

function attestationRank(r: ExplorerRow): number {
  if (r.attestation.kind === 'attested') return r.attestation.status === 'Valid' ? 0 : 1;
  return r.attestation.kind === 'none' ? 2 : 3;
}

function text(v: string | null): string {
  return v ?? '￿';
}

export function sortRows<R extends ExplorerRow>(rows: readonly R[], key: SortKey, dir: SortDir): R[] {
  const sign = dir === 'asc' ? 1 : -1;
  const tie = (a: R, b: R) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] || text(a.protocol).localeCompare(text(b.protocol)) || text(a.name).localeCompare(text(b.name)) || a.id.localeCompare(b.id);
  const cmp: Record<SortKey, (a: R, b: R) => number> = {
    status: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status],
    vault: (a, b) => text(a.name).localeCompare(text(b.name)),
    protocol: (a, b) => text(a.protocol).localeCompare(text(b.protocol)),
    asset: (a, b) => text(a.assetSymbol).localeCompare(text(b.assetSymbol)),
    pass: (a, b) => a.summary.pass - b.summary.pass,
    fail: (a, b) => a.summary.fail - b.summary.fail,
    inconclusive: (a, b) => a.summary.inconclusive - b.summary.inconclusive,
    notApplicable: (a, b) => a.summary.notApplicable - b.summary.notApplicable,
    implementation: (a, b) => b.groupSize - a.groupSize || a.implementationKey.localeCompare(b.implementationKey),
    attestation: (a, b) => attestationRank(a) - attestationRank(b),
  };
  return [...rows].sort((a, b) => sign * cmp[key](a, b) || tie(a, b));
}

/** Reads ?protocol=&status=&q= from a query string, ignoring values the board does not know. */
export function filtersFromSearch(search: string, protocols: readonly string[]): Filters {
  const p = new URLSearchParams(search);
  const status = p.get('status');
  const protocol = p.get('protocol');
  return {
    status: status && status in STATUS_RANK ? (status as VaultStatus) : ALL,
    protocol: protocol && protocols.includes(protocol) ? protocol : ALL,
    query: (p.get('q') ?? '').slice(0, 120),
  };
}

export function viewFromSearch(search: string): ExplorerView {
  return new URLSearchParams(search).get('view') === 'implementations' ? 'implementations' : 'vaults';
}

export function searchFromFilters(f: Filters, view: ExplorerView = 'vaults'): string {
  const p = new URLSearchParams();
  if (view === 'implementations') p.set('view', view);
  if (f.status !== ALL) p.set('status', f.status);
  if (f.protocol !== ALL) p.set('protocol', f.protocol);
  if (f.query.trim()) p.set('q', f.query.trim());
  const s = p.toString();
  return s ? `?${s}` : '';
}
