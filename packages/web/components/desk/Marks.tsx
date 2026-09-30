import type { Step, StepKey } from '../../lib/desk/stages';

/** Steps that end with something recorded onchain take the seal mark once done. */
const ONCHAIN: ReadonlySet<StepKey> = new Set(['paid', 'attesting', 'outcome']);

export type DotState = 'done' | 'sealed' | 'active' | 'waiting' | 'failed' | 'skipped';

export function Dot({ s, label }: { s: DotState; label?: string }) {
  return <span className="sb-dot" data-s={s} aria-hidden={label ? undefined : true} role={label ? 'img' : undefined} aria-label={label} />;
}

export function dotOf(step: Pick<Step, 'key' | 'state'>): DotState {
  if (step.state === 'done') return ONCHAIN.has(step.key) ? 'sealed' : 'done';
  return step.state;
}

/** A stage word with its mark, for lists: "Running", "Fulfilled", "Refunded". */
export function StageTag({ label, tone }: { label: string; tone: 'active' | 'done' | 'ended' }) {
  const s: DotState = tone === 'active' ? 'active' : tone === 'done' ? 'sealed' : label === 'Rejected' || label === 'Expired' ? 'failed' : 'skipped';
  return (
    <span className="sb-stage" data-tone={tone}>
      <Dot s={s} />
      {label}
    </span>
  );
}

/**
 * The 30 properties as cells, the same order and gap as the vault page's strip. Before there is a report every
 * cell is an empty frame; `running` makes them breathe while forge works.
 */
export function PropertyCells({ cells, count = 30, split = 26, running = false, width = 340 }: { cells: string | null; count?: number; split?: number; running?: boolean; width?: number }) {
  const n = cells ? cells.length : count;
  const P = 11;
  const W = 9;
  const H = 18;
  const GAP = 8;
  const x = (i: number) => i * P + (i >= split ? GAP : 0);
  const vw = n ? x(n - 1) + W : 0;
  const words: Record<string, string> = { p: 'pass', f: 'fail', i: 'inconclusive', n: 'not applicable' };
  const label = cells
    ? `${n} property results: ${['p', 'f', 'i', 'n']
        .map((c) => [c, [...cells].filter((x) => x === c).length] as const)
        .filter(([, k]) => k > 0)
        .map(([c, k]) => `${k} ${words[c]}`)
        .join(', ')}`
    : `${n} properties, no results yet`;
  return (
    <svg className="sb-cells" data-running={running && !cells ? 'true' : undefined} width={Math.min(width, vw)} viewBox={`0 0 ${vw} ${H}`} role="img" aria-label={label}>
      {Array.from({ length: n }, (_, i) => {
        const c = cells?.[i];
        if (!c) return <rect key={i} className="w" x={x(i) + 0.5} y={0.5} width={W - 1} height={H - 1} style={running ? { animationDelay: `${(i % 30) * 60}ms` } : undefined} />;
        if (c === 'i') return <rect key={i} className="i" x={x(i) + 0.6} y={0.6} width={W - 1.2} height={H - 1.2} />;
        if (c === 'n') return <rect key={i} className="n" x={x(i)} y={H / 2 - 1.5} width={W} height={3} />;
        return <rect key={i} className={c === 'f' ? 'f' : 'p'} x={x(i)} y={0} width={W} height={H} />;
      })}
    </svg>
  );
}
