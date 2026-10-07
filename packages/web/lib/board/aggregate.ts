import type {
  AttestationView,
  BoardData,
  BoardTotals,
  FailedProperty,
  ImplementationGroup,
  PropertyInfo,
  ProtocolSummary,
  ReasonCategory,
  ReasonTally,
  RegistryRead,
  ReportResultView,
  ReportView,
  StatusCounts,
  VaultRow,
  VaultStatus,
  VaultStatusCounts,
} from './types';
import { classifyReason, effectiveSkipReason } from './reasons.ts';
import { classifyFailure } from './levels.ts';

/*
 * Pure functions that turn validated check reports into board rows, groups and totals. No I/O: the build
 * script (lib/board/pipeline.ts) reads files and the registry, then calls these.
 */

/** Order the board uses by default: what a reader should see first. */
export const VAULT_STATUS_ORDER: readonly VaultStatus[] = ['mismatch', 'complete', 'partial', 'not_applicable'];

export function statusRank(status: VaultStatus): number {
  return VAULT_STATUS_ORDER.indexOf(status);
}

export function emptyStatusCounts(): VaultStatusCounts {
  return { mismatch: 0, complete: 0, partial: 0, not_applicable: 0 };
}

export function vaultStatusOf(summary: StatusCounts): VaultStatus {
  if (summary.fail > 0) return 'mismatch';
  const total = summary.pass + summary.inconclusive + summary.notApplicable;
  if (total > 0 && summary.pass === total) return 'complete';
  if (summary.pass === 0 && summary.inconclusive === 0) return 'not_applicable';
  return 'partial';
}

const CELL: Record<ReportResultView['status'], string> = { pass: 'p', fail: 'f', inconclusive: 'i', not_applicable: 'n' };

export function cellsOf(results: ReadonlyArray<Pick<ReportResultView, 'status'>>): string {
  return results.map((r) => CELL[r.status]).join('');
}

/**
 * The failed properties of a report, each with its class (lib/board/levels) from its reason and forge's logs. Only
 * those are read: a report is kept as written, so a class key in it (topic, delta, amount) is never taken as given.
 */
export function failedPropertiesOf(results: ReadonlyArray<ReportResultView>): FailedProperty[] {
  return results
    .filter((x) => x.status === 'fail')
    .map((x) => {
      const c = classifyFailure({ id: x.id, reason: x.reason, counterexample: x.counterexample });
      return { id: x.id, reason: x.reason ?? '', topic: c.topic, ...(c.delta ? { delta: c.delta, amount: c.amount } : {}) };
    });
}

export function vaultId(chainId: number, address: string): string {
  return `${chainId}/${address.toLowerCase()}`;
}

/** A report found under the source directory, already validated against StandardCheckReport. */
export interface CheckCandidate {
  report: ReportView;
  /** Path relative to the source directory, e.g. 143/0xabc.../109195820.json. */
  file: string;
  reportHash: string;
  suiteHash: string;
}

/**
 * Newer first: higher fork block, then later startedAt, then the file name, so the choice never depends on
 * directory listing order.
 */
export function compareCandidates(a: CheckCandidate, b: CheckCandidate): number {
  const ba = BigInt(a.report.blockNumber);
  const bb = BigInt(b.report.blockNumber);
  if (ba !== bb) return ba > bb ? -1 : 1;
  const ta = Date.parse(a.report.startedAt);
  const tb = Date.parse(b.report.startedAt);
  if (ta !== tb) return tb - ta;
  return a.file < b.file ? 1 : a.file > b.file ? -1 : 0;
}

/** The latest report of each (chainId, address), in first-seen order of the vaults. */
export function pickLatest(candidates: readonly CheckCandidate[]): CheckCandidate[] {
  const best = new Map<string, CheckCandidate>();
  for (const c of candidates) {
    const id = vaultId(c.report.chainId, c.report.address);
    const cur = best.get(id);
    if (!cur || compareCandidates(c, cur) < 0) best.set(id, c);
  }
  return [...best.values()];
}

export interface VaultMetaEntry {
  protocol: string | null;
  assetSymbol: string | null;
  name: string | null;
}

/** data/vault-meta.json: chainId -> address (lowercase) -> metadata. */
export type VaultMeta = Record<string, Record<string, VaultMetaEntry>>;

export function metaFor(meta: VaultMeta | null, chainId: number, address: string): VaultMetaEntry | null {
  return meta?.[String(chainId)]?.[address.toLowerCase()] ?? null;
}

export function reasonCountsOf(results: ReadonlyArray<Pick<ReportResultView, 'status' | 'reason'>>): Map<ReasonCategory, number> {
  const counts = new Map<ReasonCategory, number>();
  for (const r of results) {
    const c = classifyReason(r.status, r.reason);
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

export interface BuildRowInput {
  candidate: CheckCandidate;
  meta: VaultMetaEntry | null;
  attestation: AttestationView;
  reportPath: string;
}

/** One board row; groupSize is filled in by withGroupSizes once every row is known. */
export function buildRow({ candidate, meta, attestation, reportPath }: BuildRowInput): VaultRow {
  const r = candidate.report;
  const identity = r.identity;
  return {
    id: vaultId(r.chainId, r.address),
    chainId: r.chainId,
    address: r.address,
    name: meta?.name ?? null,
    protocol: meta?.protocol ?? null,
    assetSymbol: meta?.assetSymbol ?? null,
    status: vaultStatusOf(r.summary),
    vaultKind: r.vaultKind ?? null,
    skipReason: effectiveSkipReason(r),
    blockNumber: r.blockNumber,
    summary: { ...r.summary },
    cells: cellsOf(r.results),
    implementationKey: identity.implementationKey,
    implementationKeyKind: { ...identity.implementationKeyKind },
    proxyKind: identity.proxy?.kind ?? null,
    implementationAddress: identity.implementation?.address ?? null,
    groupSize: 1,
    failed: failedPropertiesOf(r.results),
    reasonCategories: [...reasonCountsOf(r.results).keys()],
    traits: r.traits ? r.traits.map((t) => ({ id: t.id, evidence: { ...t.evidence, requestFunctions: [...t.evidence.requestFunctions] } })) : [],
    attestation,
    reportPath,
  };
}

function compareRowsDefault(a: VaultRow, b: VaultRow): number {
  const s = statusRank(a.status) - statusRank(b.status);
  if (s !== 0) return s;
  const p = (a.protocol ?? '￿').localeCompare(b.protocol ?? '￿');
  if (p !== 0) return p;
  const n = (a.name ?? '￿').localeCompare(b.name ?? '￿');
  if (n !== 0) return n;
  return a.id.localeCompare(b.id);
}

/** Mismatches first, then all passed, partly checked and not applicable; by protocol and name within each. */
export function sortRowsDefault(rows: readonly VaultRow[]): VaultRow[] {
  return [...rows].sort(compareRowsDefault);
}

/**
 * Vaults that share an implementationKey ran the same code (ADR 0003, "Implementation identity"). Largest
 * group first, so the matrix and the grouped table open with the implementations that carry the most vaults.
 */
export function groupRows(rows: readonly VaultRow[]): ImplementationGroup[] {
  const byKey = new Map<string, VaultRow[]>();
  for (const row of rows) {
    const list = byKey.get(row.implementationKey);
    if (list) list.push(row);
    else byKey.set(row.implementationKey, [row]);
  }
  const groups: ImplementationGroup[] = [];
  for (const [key, list] of byKey) {
    const sorted = sortRowsDefault(list);
    const statusCounts = emptyStatusCounts();
    for (const r of sorted) statusCounts[r.status]++;
    groups.push({
      key,
      keyKind: { ...sorted[0]!.implementationKeyKind },
      implementationAddresses: [...new Set(sorted.map((r) => r.implementationAddress).filter((a): a is string => Boolean(a)))],
      vaultIds: sorted.map((r) => r.id),
      protocols: [...new Set(sorted.map((r) => r.protocol ?? 'Unknown protocol'))].sort(),
      statusCounts,
    });
  }
  return groups.sort((a, b) => b.vaultIds.length - a.vaultIds.length || statusRank(firstStatus(a)) - statusRank(firstStatus(b)) || a.key.localeCompare(b.key));
}

function firstStatus(g: ImplementationGroup): VaultStatus {
  return VAULT_STATUS_ORDER.find((s) => g.statusCounts[s] > 0) ?? 'not_applicable';
}

export function withGroupSizes(rows: readonly VaultRow[], groups: readonly ImplementationGroup[]): VaultRow[] {
  const size = new Map<string, number>();
  for (const g of groups) size.set(g.key, g.vaultIds.length);
  return rows.map((r) => ({ ...r, groupSize: size.get(r.implementationKey) ?? 1 }));
}

export function summarizeProtocols(rows: readonly VaultRow[]): ProtocolSummary[] {
  const by = new Map<string, { rows: VaultRow[] }>();
  for (const r of rows) {
    const p = r.protocol ?? 'Unknown protocol';
    const e = by.get(p);
    if (e) e.rows.push(r);
    else by.set(p, { rows: [r] });
  }
  const out: ProtocolSummary[] = [];
  for (const [protocol, { rows: list }] of by) {
    const statusCounts = emptyStatusCounts();
    for (const r of list) statusCounts[r.status]++;
    out.push({ protocol, vaults: list.length, implementations: new Set(list.map((r) => r.implementationKey)).size, statusCounts });
  }
  return out.sort((a, b) => b.statusCounts.mismatch - a.statusCounts.mismatch || b.vaults - a.vaults || a.protocol.localeCompare(b.protocol));
}

/** Per category: how many vaults have at least one property in it, and how many properties in total. */
export function tallyReasons(perVault: ReadonlyArray<Map<ReasonCategory, number>>): ReasonTally[] {
  const vaults = new Map<ReasonCategory, number>();
  const props = new Map<ReasonCategory, number>();
  for (const m of perVault) {
    for (const [c, n] of m) {
      vaults.set(c, (vaults.get(c) ?? 0) + 1);
      props.set(c, (props.get(c) ?? 0) + n);
    }
  }
  return [...vaults.keys()]
    .map((category) => ({ category, vaults: vaults.get(category)!, properties: props.get(category)! }))
    .sort((a, b) => b.vaults - a.vaults || b.properties - a.properties || a.category.localeCompare(b.category));
}

export function propertyTotalsOf(rows: readonly VaultRow[]): StatusCounts {
  const t: StatusCounts = { pass: 0, fail: 0, inconclusive: 0, notApplicable: 0 };
  for (const r of rows) {
    t.pass += r.summary.pass;
    t.fail += r.summary.fail;
    t.inconclusive += r.summary.inconclusive;
    t.notApplicable += r.summary.notApplicable;
  }
  return t;
}

export function boardTotals(rows: readonly VaultRow[], unchecked: number): BoardTotals {
  const counts = emptyStatusCounts();
  for (const r of rows) counts[r.status]++;
  return {
    vaults: rows.length,
    implementations: new Set(rows.map((r) => r.implementationKey)).size,
    complete: counts.complete,
    mismatch: counts.mismatch,
    mismatchImplementations: new Set(rows.filter((r) => r.status === 'mismatch').map((r) => r.implementationKey)).size,
    partial: counts.partial,
    notApplicable: counts.not_applicable,
    attested: rows.filter((r) => r.attestation.kind === 'attested').length,
    unchecked,
  };
}

/** Vaults in the metadata file for which no report was found. */
export function countUnchecked(meta: VaultMeta | null, rows: readonly VaultRow[]): number {
  if (!meta) return 0;
  const seen = new Set(rows.map((r) => r.id));
  let n = 0;
  for (const [chainId, byAddress] of Object.entries(meta)) {
    for (const address of Object.keys(byAddress)) if (!seen.has(`${chainId}/${address.toLowerCase()}`)) n++;
  }
  return n;
}

export function blocksOf(rows: readonly VaultRow[]): BoardData['blocks'] {
  const m = new Map<string, { chainId: number; blockNumber: string; vaults: number }>();
  for (const r of rows) {
    const k = `${r.chainId}/${r.blockNumber}`;
    const e = m.get(k);
    if (e) e.vaults++;
    else m.set(k, { chainId: r.chainId, blockNumber: r.blockNumber, vaults: 1 });
  }
  return [...m.values()].sort((a, b) => b.vaults - a.vaults || a.chainId - b.chainId);
}

/**
 * The property table in report order, from the first report that has it. Every accepted erc4626 report lists
 * the same 30 (cert attest refuses any other list), so any report gives the same table.
 */
export function propertiesOf(reports: readonly ReportView[]): PropertyInfo[] {
  const first = reports.find((r) => r.results.length > 0);
  if (!first) return [];
  return first.results.map((r) => ({ id: r.id, test: r.test, description: r.description, origin: r.id.startsWith('sf-') ? 'specfirst' : 'upstream' }));
}

export function emptyBoard(registry: RegistryRead, generatedAt: string, source: string): BoardData {
  return {
    version: 1,
    generatedAt,
    source,
    standard: 'erc4626',
    blocks: [],
    runs: [],
    properties: [],
    totals: boardTotals([], 0),
    propertyTotals: { pass: 0, fail: 0, inconclusive: 0, notApplicable: 0 },
    reasons: [],
    protocols: [],
    groups: [],
    vaults: [],
    registry,
    skipped: [],
  };
}
