import type { ReportAuxiliary } from '../lib/report';

/** Auxiliary fuzzing campaign summary, kept visually separate with a "not human-reviewed" tag
 * (docs/plan.md 3.5: results here never block certification, forge results do). */
export function AuxiliaryBox({ auxiliary }: { auxiliary: ReportAuxiliary | undefined }) {
  if (!auxiliary) return null;
  return (
    <div className="box aux-box">
      <div className="box-label">
        Auxiliary campaign <span className="tag">not human-reviewed</span>
      </div>
      <div className="aux-meta">
        <span>{auxiliary.backend}</span>
        {auxiliary.profile && <span>{auxiliary.profile}</span>}
        <span>{Math.round(auxiliary.wallclockSec / 60)} min</span>
        <span>${auxiliary.costUsd.toFixed(2)}</span>
      </div>
      <ul className="plain-list">
        {auxiliary.findings.map((f) => (
          <li key={f.status}>
            {f.count} {f.status}
            {f.mapped ? '' : ', unmapped'}
          </li>
        ))}
      </ul>
      <p className="muted">{auxiliary.note}</p>
    </div>
  );
}
