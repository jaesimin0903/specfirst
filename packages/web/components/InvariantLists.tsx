import type { ReportInvariantResult } from '../lib/report';

/**
 * Verified and unverified lists render in the same two-column grid at the same box size on
 * purpose (docs/plan.md 3.8 / the wireframe's annotation 3: "미검증 항목이 통과 목록과 같은
 * 크기로 보인다. 숨기면 신뢰가 깨진다" -- hiding it breaks trust).
 */
export function InvariantLists({ invariants, unverified }: { invariants: ReportInvariantResult[]; unverified: string[] }) {
  return (
    <div className="grid-2">
      <div className="box">
        <div className="box-label">Verified invariants ({invariants.length})</div>
        <ul className="check-list">
          {invariants.map((inv) => (
            <li key={inv.id} className={inv.status === 'pass' ? 'ok' : inv.status === 'error' ? 'warn' : 'bad'}>
              <span className="mark">{inv.status === 'pass' ? '✓' : inv.status === 'error' ? '!' : '✗'}</span>
              <span>{inv.text}</span>
            </li>
          ))}
          {invariants.length === 0 && <li className="muted">No invariant results in the report.</li>}
        </ul>
      </div>
      <div className="box box-dashed">
        <div className="box-label">Not verified ({unverified.length})</div>
        <ul className="plain-list">
          {unverified.map((item) => (
            <li key={item}>{item}</li>
          ))}
          {unverified.length === 0 && <li className="muted">None listed.</li>}
        </ul>
      </div>
    </div>
  );
}
