'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { VaultStatus } from '../../lib/board/types';
import { describeKeyKind, VAULT_STATUS_LABEL } from '../../lib/board/reasons';
import {
  ALL,
  filterRows,
  filtersFromSearch,
  searchFromFilters,
  sortRows,
  viewFromSearch,
  type ExplorerRow,
  type ExplorerView,
  type Filters,
  type SortDir,
  type SortKey,
} from '../../lib/board/view';
import { shortAddress, shortHash } from '../../lib/format';
import { AttestationMark, VaultChip } from './StatusChip';
import { CellStrip } from './CellStrip';
import { Glyph } from './Glyph';
import { FILTER_EVENT, type FilterEventDetail } from './FilterLink';

const STATUSES: VaultStatus[] = ['mismatch', 'complete', 'partial', 'not_applicable'];
const NUMERIC: SortKey[] = ['pass', 'fail', 'inconclusive', 'notApplicable', 'implementation'];

function SortIcon({ dir }: { dir: SortDir | null }) {
  return (
    <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden="true">
      {dir !== 'desc' && <path d="M4 0 8 4H0z" fill="currentColor" />}
      {dir !== 'asc' && <path d="M4 10 0 6h8z" fill="currentColor" />}
    </svg>
  );
}

interface GroupView {
  key: string;
  keyKind: ExplorerRow['implementationKeyKind'];
  implementationAddress: string | null;
  rows: ExplorerRow[];
  protocols: string[];
  counts: Record<VaultStatus, number>;
}

function groupsOf(rows: readonly ExplorerRow[]): GroupView[] {
  const by = new Map<string, ExplorerRow[]>();
  for (const r of rows) {
    const list = by.get(r.implementationKey);
    if (list) list.push(r);
    else by.set(r.implementationKey, [r]);
  }
  return [...by.entries()]
    .map(([key, list]) => {
      const counts: Record<VaultStatus, number> = { mismatch: 0, complete: 0, partial: 0, not_applicable: 0 };
      for (const r of list) counts[r.status]++;
      return {
        key,
        keyKind: list[0]!.implementationKeyKind,
        implementationAddress: list.find((r) => r.implementationAddress)?.implementationAddress ?? null,
        rows: sortRows(list, 'status', 'asc'),
        protocols: [...new Set(list.map((r) => r.protocol ?? 'Unknown protocol'))].sort(),
        counts,
      };
    })
    .sort((a, b) => b.counts.mismatch - a.counts.mismatch || b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}

export interface BoardExplorerProps {
  rows: ExplorerRow[];
  protocols: string[];
  /** Upstream property count: where the cell strip leaves a gap before Specfirst's own properties. */
  split: number;
}

/**
 * The full vault list: filter by protocol, status and text, sort any column, or fold the list into
 * implementations. Filters live in the query string (?status=&protocol=&q=&view=) so a filtered view can be
 * linked, and the figures and protocol names above set them through FilterLink.
 */
export function BoardExplorer({ rows, protocols, split }: BoardExplorerProps) {
  const [filters, setFilters] = useState<Filters>({ protocol: ALL, status: ALL, query: '' });
  const [view, setView] = useState<ExplorerView>('vaults');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'status', dir: 'asc' });
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    const fromUrl = () => {
      setFilters(filtersFromSearch(window.location.search, protocols));
      setView(viewFromSearch(window.location.search));
    };
    fromUrl();
    const onFilter = (e: Event) => {
      const d = (e as CustomEvent<FilterEventDetail>).detail;
      setFilters(d.filters);
      setView(d.view);
    };
    window.addEventListener(FILTER_EVENT, onFilter);
    window.addEventListener('popstate', fromUrl);
    return () => {
      window.removeEventListener(FILTER_EVENT, onFilter);
      window.removeEventListener('popstate', fromUrl);
    };
  }, [protocols]);

  useEffect(() => {
    const next = `${window.location.pathname}${searchFromFilters(filters, view)}${window.location.hash}`;
    if (next !== `${window.location.pathname}${window.location.search}${window.location.hash}`) window.history.replaceState(null, '', next);
  }, [filters, view]);

  const statusCounts = useMemo(() => {
    const c: Record<VaultStatus, number> = { mismatch: 0, complete: 0, partial: 0, not_applicable: 0 };
    for (const r of filterRows(rows, { ...filters, status: ALL })) c[r.status]++;
    return c;
  }, [rows, filters]);
  const filtered = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const sorted = useMemo(() => sortRows(filtered, sort.key, sort.dir), [filtered, sort]);
  const groups = useMemo(() => (view === 'implementations' ? groupsOf(filtered) : []), [filtered, view]);

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: NUMERIC.includes(key) ? 'desc' : 'asc' }));

  const th = (key: SortKey, label: string, className?: string) => (
    <th scope="col" className={className} aria-sort={sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <button type="button" className="sb-sort" onClick={() => setSortKey(key)}>
        {label}
        <SortIcon dir={sort.key === key ? sort.dir : null} />
      </button>
    </th>
  );

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div>
      <div className="sb-controls" role="group" aria-label="Filter vaults">
        <div className="sb-field">
          <span id="sb-view-l">Show</span>
          <div className="sb-seg" role="group" aria-labelledby="sb-view-l">
            <button type="button" aria-pressed={view === 'vaults'} onClick={() => setView('vaults')}>
              Vaults
            </button>
            <button type="button" aria-pressed={view === 'implementations'} onClick={() => setView('implementations')}>
              Implementations
            </button>
          </div>
        </div>
        <div className="sb-field">
          <span id="sb-status-l">Status</span>
          <div className="sb-seg" role="group" aria-labelledby="sb-status-l">
            <button type="button" aria-pressed={filters.status === ALL} onClick={() => setFilters((f) => ({ ...f, status: ALL }))}>
              All
            </button>
            {STATUSES.map((s) => (
              <button key={s} type="button" aria-pressed={filters.status === s} onClick={() => setFilters((f) => ({ ...f, status: s }))}>
                <Glyph kind={s} />
                {VAULT_STATUS_LABEL[s]} <span className="soft num">{statusCounts[s]}</span>
              </button>
            ))}
          </div>
        </div>
        <label className="sb-field">
          Protocol
          <select value={filters.protocol} onChange={(e) => setFilters((f) => ({ ...f, protocol: e.target.value }))}>
            <option value={ALL}>All protocols</option>
            {protocols.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="sb-field">
          Search
          <input
            type="search"
            value={filters.query}
            placeholder="Name, address, asset, property"
            onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          />
        </label>
      </div>

      <p className="sb-count" aria-live="polite">
        {view === 'vaults'
          ? `Showing ${filtered.length} of ${rows.length} vaults`
          : `${groups.length} implementations for ${filtered.length} of ${rows.length} vaults`}
      </p>

      {view === 'vaults' ? (
        <div className="sb-table-scroll">
          <table className="sb-table">
            <thead>
              <tr>
                {th('status', 'Status')}
                {th('vault', 'Vault')}
                {th('protocol', 'Protocol')}
                <th scope="col">Properties</th>
                {th('pass', 'Pass', 'r')}
                {th('fail', 'Fail', 'r')}
                {th('inconclusive', 'Incon.', 'r')}
                {th('notApplicable', 'N/A', 'r')}
                {th('implementation', 'Implementation')}
                {th('attestation', 'Onchain')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td className="nowrap">
                    <VaultChip status={r.status} />
                  </td>
                  <td className="sb-vault-cell">
                    <a href={`/v/${r.id}`} className={r.name ? undefined : 'mono'}>
                      {r.name ?? shortAddress(r.address)}
                    </a>
                    <span className="sb-vault-sub">
                      {r.assetSymbol ? `${r.assetSymbol}, ` : ''}
                      {r.name ? <span className="mono">{shortAddress(r.address)}</span> : 'no name in metadata'}
                    </span>
                  </td>
                  <td style={{ minWidth: 120 }}>{r.protocol ?? <span className="soft">Unknown</span>}</td>
                  <td className="nowrap">
                    <CellStrip cells={r.cells} split={split} />
                  </td>
                  <td className={`r ${r.summary.pass ? '' : 'zero'}`}>{r.summary.pass}</td>
                  <td className={`r ${r.summary.fail ? 'hot' : 'zero'}`}>{r.summary.fail}</td>
                  <td className={`r ${r.summary.inconclusive ? '' : 'zero'}`}>{r.summary.inconclusive}</td>
                  <td className={`r ${r.summary.notApplicable ? '' : 'zero'}`}>{r.summary.notApplicable}</td>
                  <td className="nowrap">
                    {r.groupSize > 1 ? `Shared by ${r.groupSize}` : 'Unique'}
                    <span className="sb-vault-sub mono" title={r.implementationKey}>
                      {shortHash(r.implementationKey)}
                    </span>
                  </td>
                  <td className="nowrap">
                    <AttestationMark attestation={r.attestation} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {sorted.length === 0 && <p className="sb-empty">No vault matches these filters. Clear the search or pick another status.</p>}
        </div>
      ) : (
        <div className="sb-table-scroll">
          <table className="sb-table">
            <thead>
              <tr>
                <th scope="col">Implementation</th>
                <th scope="col">Protocols</th>
                <th scope="col" className="r">
                  Vaults
                </th>
                <th scope="col">Results</th>
                <th scope="col" className="r">
                  Mismatch
                </th>
                <th scope="col" className="r">
                  All passed
                </th>
                <th scope="col" className="r">
                  Partly
                </th>
                <th scope="col" className="r">
                  N/A
                </th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const isOpen = open.has(g.key);
                const total = g.rows.length;
                return (
                  <Fragment key={g.key}>
                    <tr>
                      <td>
                        <button type="button" className="sb-sort" aria-expanded={isOpen} onClick={() => toggle(g.key)}>
                          <span className="mono" aria-hidden="true" style={{ width: 12 }}>
                            {isOpen ? '-' : '+'}
                          </span>
                          <span className="mono" title={g.key}>
                            {shortHash(g.key)}
                          </span>
                        </button>
                        <span className="soft" style={{ display: 'block', fontSize: 12.5, marginTop: 2, maxWidth: '44ch' }}>
                          {describeKeyKind(g.keyKind)}
                          {g.implementationAddress ? `, at ${shortAddress(g.implementationAddress)}` : ''}
                        </span>
                      </td>
                      <td>{g.protocols.join(', ')}</td>
                      <td className="r">{total}</td>
                      <td style={{ minWidth: 140 }}>
                        <span className="sb-dist" role="img" aria-label={STATUSES.filter((s) => g.counts[s]).map((s) => `${g.counts[s]} ${VAULT_STATUS_LABEL[s].toLowerCase()}`).join(', ')}>
                          {STATUSES.map((s) => (g.counts[s] ? <span key={s} className={`d-${s}`} style={{ width: `${(g.counts[s] / total) * 100}%` }} /> : null))}
                        </span>
                      </td>
                      <td className={`r ${g.counts.mismatch ? 'hot' : 'zero'}`}>{g.counts.mismatch}</td>
                      <td className={`r ${g.counts.complete ? '' : 'zero'}`}>{g.counts.complete}</td>
                      <td className={`r ${g.counts.partial ? '' : 'zero'}`}>{g.counts.partial}</td>
                      <td className={`r ${g.counts.not_applicable ? '' : 'zero'}`}>{g.counts.not_applicable}</td>
                    </tr>
                    {isOpen && (
                      <tr>
                        <td colSpan={8}>
                          <ul className="sb-group-list">
                            {g.rows.map((r) => (
                              <li key={r.id}>
                                <Glyph kind={r.status} />
                                <a href={`/v/${r.id}`}>{r.name ?? shortAddress(r.address)}</a>
                                <span className="soft">{r.assetSymbol ?? ''}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {groups.length === 0 && <p className="sb-empty">No vault matches these filters. Clear the search or pick another status.</p>}
        </div>
      )}
    </div>
  );
}
