import type { Progress } from '../../lib/desk/stages';
import { testnetTxUrl } from '../../lib/desk/config';
import { shortHash } from '../../lib/format';
import { Dot, dotOf } from './Marks';

export interface TimelineTxs {
  request?: string | null;
  attest?: string | null;
  fulfill?: string | null;
  reject?: string | null;
}

function clock(iso: string | null): string | null {
  if (!iso) return null;
  return iso.slice(11, 19) + ' UTC';
}

const STATE_WORD: Record<string, string> = { done: 'done', active: 'in progress', waiting: 'not yet', failed: 'stopped', skipped: 'not reached' };

/** The request's steps, top to bottom. Presentational: the page decides when to re-render. */
export function Timeline({ progress, txs = {} }: { progress: Progress; txs?: TimelineTxs }) {
  const txOf = (key: string): string | null | undefined =>
    key === 'paid' ? txs.request : key === 'attesting' ? txs.attest : key === 'outcome' ? (progress.outcome === 'rejected' ? txs.reject : txs.fulfill) : null;
  return (
    <ol className="sb-timeline" aria-label="Request progress">
      {progress.steps.map((s) => {
        const tx = txOf(s.key);
        return (
          <li key={s.key} className="sb-step" data-s={s.state} aria-current={s.state === 'active' ? 'step' : undefined}>
            <Dot s={dotOf(s)} />
            <div>
              <div className="sb-step-label">
                <span>{s.label}</span>
                <span className="vh">, {STATE_WORD[s.state]}</span>
                {s.at && <time dateTime={s.at}>{clock(s.at)}</time>}
              </div>
              {s.detail && <p className="sb-step-detail">{s.detail}</p>}
              {tx && (
                <p className="sb-step-tx">
                  <a href={testnetTxUrl(tx)} className="mono" title={tx}>
                    tx {shortHash(tx)}
                  </a>
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
