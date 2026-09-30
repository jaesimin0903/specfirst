const WORD: Record<string, string> = { p: 'pass', f: 'fail', i: 'inconclusive', n: 'not applicable' };

/** "26 pass, 2 fail, 2 inconclusive" from a cells string. */
export function describeCells(cells: string): string {
  const counts = new Map<string, number>();
  for (const c of cells) counts.set(c, (counts.get(c) ?? 0) + 1);
  return ['p', 'f', 'i', 'n']
    .filter((c) => counts.get(c))
    .map((c) => `${counts.get(c)} ${WORD[c]}`)
    .join(', ');
}

/**
 * A vault's results in report order, one cell per property, with a gap before Specfirst's own properties.
 * The same order as the attestation's passedBitmap and failedBitmap, bit i being cell i.
 */
export function CellStrip({ cells, split = 26 }: { cells: string; split?: number }) {
  const W = 4;
  const P = 5;
  const H = 12;
  const GAP = 4;
  const x = (i: number) => i * P + (i >= split ? GAP : 0);
  const width = cells.length ? x(cells.length - 1) + W : 0;
  // One path per status keeps 200 table rows light: four elements per row instead of thirty.
  const d: Record<string, string> = { p: '', f: '', i: '', n: '' };
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    if (c === 'i') d.i += `M${x(i) + 0.75} 0.75h${W - 1.5}v${H - 1.5}h${-(W - 1.5)}z`;
    else if (c === 'n') d.n += `M${x(i)} ${H / 2 - 1}h${W}v2h${-W}z`;
    else if (c === 'p' || c === 'f') d[c] += `M${x(i)} 0h${W}v${H}h${-W}z`;
  }
  return (
    <svg className="sb-glyph" width={width} height={H} viewBox={`0 0 ${width} ${H}`} role="img" aria-label={describeCells(cells)}>
      {(['p', 'n', 'i', 'f'] as const).map((k) => (d[k] ? <path key={k} className={k} d={d[k]} /> : null))}
    </svg>
  );
}
