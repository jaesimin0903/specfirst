import type { BoardData, VaultRow } from '../../lib/board/types';
import { vaultLabel } from '../../lib/board/reasons';
import { failureLevelOf } from '../../lib/board/levels';

const PX = 6; // column pitch
const CW = 5; // cell width
const PY = 8; // row pitch
const CH = 6; // cell height
const SF_GAP = 10; // space before Specfirst's own properties
const GROUP_GAP = 7; // space between implementations
const LABEL_MIN_VAULTS = 10;

interface Column {
  x: number;
  row: VaultRow;
}

/**
 * Every vault on the board as one column of 30 cells, grouped by implementation, largest group first. The
 * cells are the report's results in order, which is also the order of the registry's bitmaps. Rendered as a
 * handful of SVG paths (one per status) so 6,000 cells stay light; columns link to the vault pages.
 */
export function PropertyMatrix({ board }: { board: BoardData }) {
  const rowsById = new Map(board.vaults.map((r) => [r.id, r]));
  const upstream = board.properties.filter((p) => p.origin === 'upstream').length || 26;
  const n = board.properties.length || 30;
  const y = (i: number) => i * PY + (i >= upstream ? SF_GAP : 0);
  const H = y(n - 1) + CH;

  const columns: Column[] = [];
  const groupSpans: { x0: number; x1: number; label: string; vaults: number; protocols: string[] }[] = [];
  let x = 0;
  board.groups.forEach((g, gi) => {
    if (gi > 0) x += GROUP_GAP;
    const x0 = x;
    for (const id of g.vaultIds) {
      const row = rowsById.get(id);
      if (!row) continue;
      columns.push({ x, row });
      x += PX;
    }
    groupSpans.push({ x0, x1: x - (PX - CW), label: g.protocols.join(', '), vaults: g.vaultIds.length, protocols: g.protocols });
  });
  const W = Math.max(x - (PX - CW), 1);

  const d: Record<'p' | 'f' | 'i' | 'n', string[]> = { p: [], f: [], i: [], n: [] };
  for (const { x: cx, row } of columns) {
    for (let i = 0; i < row.cells.length; i++) {
      const c = row.cells[i] as 'p' | 'f' | 'i' | 'n';
      const cy = y(i);
      if (c === 'i') d.i.push(`M${cx + 0.5} ${cy + 0.5}h${CW - 1}v${CH - 1}h${-(CW - 1)}z`);
      else if (c === 'n') d.n.push(`M${cx} ${cy + CH / 2 - 0.75}h${CW}v1.5h${-CW}z`);
      else if (c === 'p' || c === 'f') d[c].push(`M${cx} ${cy}h${CW}v${CH}h${-CW}z`);
    }
  }

  const pct = (v: number, of: number) => `${((v / of) * 100).toFixed(3)}%`;
  const labelled = groupSpans.filter((g) => g.vaults >= LABEL_MIN_VAULTS);
  const others = groupSpans.length - labelled.length;
  const summary = `${board.totals.vaults} vaults by ${n} properties. ${board.totals.complete} vaults passed all, ${board.totals.mismatch} have failing properties, ${board.totals.partial} were partly checked, ${board.totals.notApplicable} are not applicable. The vault table below lists the same data.`;

  return (
    <figure className="sb-matrix-scroll" style={{ margin: '40px 0 0' }}>
      <div className="sb-matrix">
        <div className="sb-matrix-axis" aria-hidden="true">
          <span style={{ top: 0, height: pct(y(upstream - 1) + CH, H) }}>a16z/erc4626-tests, {upstream}</span>
          <span style={{ top: pct(y(upstream), H), height: pct(H - y(upstream), H) }}>Specfirst, {n - upstream}</span>
        </div>
        <div className="sb-matrix-plot">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMinYMin meet" role="img" aria-label={summary}>
            <path className="p" d={d.p.join('')} />
            <path className="n" d={d.n.join('')} />
            <path className="i" d={d.i.join('')} />
            <path className="f" d={d.f.join('')} />
            {columns.map(({ x: cx, row }) => (
              <a key={row.id} href={`/v/${row.id}`} className="col" tabIndex={-1}>
                <rect x={cx - 0.5} y={0} width={PX} height={H} />
                <title>{`${row.name ?? row.address}${row.protocol ? `, ${row.protocol}` : ''}: ${vaultLabel(row.status, failureLevelOf(row.failed))}`}</title>
              </a>
            ))}
          </svg>
        </div>
        <div className="sb-matrix-groups" aria-hidden="true">
          {labelled.map((g) => (
            <span key={`${g.x0}`} style={{ left: pct(g.x0, W), maxWidth: pct(Math.max(g.x1 - g.x0, 1), W), overflow: 'hidden', textOverflow: 'ellipsis' }} title={`${g.label}, ${g.vaults} vaults`}>
              <b>{g.vaults}</b> {g.label}
            </span>
          ))}
          {others > 0 && labelled.length > 0 && (
            <span style={{ right: 0, borderLeft: 0, borderRight: '1px solid var(--rule-strong)', paddingLeft: 0, paddingRight: 6 }}>
              <b>{others}</b> more implementations
            </span>
          )}
        </div>
      </div>
      <figcaption className="vh">{summary}</figcaption>
    </figure>
  );
}
