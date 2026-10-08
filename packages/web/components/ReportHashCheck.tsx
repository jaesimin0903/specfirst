'use client';

import { useEffect, useState } from 'react';
import { computeReportHash, reportLinkOf } from '../lib/report';

type CheckState = { kind: 'loading' } | { kind: 'match'; computed: string } | { kind: 'mismatch'; computed: string } | { kind: 'error'; message: string };

/**
 * Re-fetches report.json in the browser, re-serializes it with @specfirst/core's canonicalJson,
 * hashes it with keccak256, and compares against the on-chain reportHash. Runs client-side (not
 * folded into the server-rendered page) because the whole point is that anyone reading this page
 * can redo the computation themselves without trusting this server -- see docs/plan.md 3.8.
 */
export function ReportHashCheck({ reportUrl, onChainHash }: { reportUrl: string | null; onChainHash: string }) {
  const [state, setState] = useState<CheckState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!reportUrl) {
      setState({ kind: 'error', message: 'no report URL on this certificate' });
      return;
    }
    (async () => {
      try {
        const res = await fetch(reportLinkOf(reportUrl));
        if (!res.ok) throw new Error(`report fetch failed: ${res.status}`);
        const json: unknown = await res.json();
        const computed = computeReportHash(json);
        if (cancelled) return;
        setState(computed.toLowerCase() === onChainHash.toLowerCase() ? { kind: 'match', computed } : { kind: 'mismatch', computed });
      } catch (err) {
        if (!cancelled) setState({ kind: 'error', message: err instanceof Error ? err.message : 'could not verify report hash' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reportUrl, onChainHash]);

  if (state.kind === 'loading') return <span className="hash-check muted">verifying report hash...</span>;
  if (state.kind === 'error') return <span className="hash-check muted">report hash not verified ({state.message})</span>;
  if (state.kind === 'match') return <span className="hash-check ok">report hash matches on-chain reportHash</span>;
  return <span className="hash-check bad">report hash does NOT match on-chain reportHash</span>;
}
