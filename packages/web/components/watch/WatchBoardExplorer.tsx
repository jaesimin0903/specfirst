'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ExplorerRow } from '../../lib/board/view';
import { mergeOverlay, mergedProtocols } from '../../lib/watch/overlay';
import { BoardExplorer, type BoardExplorerProps } from '../board/BoardExplorer';

/**
 * The board's vault table plus the vaults the watcher found that the build does not have. The board itself is
 * prerendered; the overlay is read when the page opens, so a vault found a minute ago is already listed.
 */
export function WatchBoardExplorer({ rows, protocols, split }: BoardExplorerProps) {
  const [overlay, setOverlay] = useState<ExplorerRow[]>([]);
  useEffect(() => {
    let stop = false;
    fetch('/api/v1/watch/overlay')
      .then((r) => (r.ok ? (r.json() as Promise<{ rows: ExplorerRow[] }>) : null))
      .then((d) => !stop && d && Array.isArray(d.rows) && setOverlay(d.rows))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, []);
  const merged = useMemo(() => mergeOverlay(rows, overlay), [rows, overlay]);
  const allProtocols = useMemo(() => mergedProtocols(protocols, overlay), [protocols, overlay]);
  return <BoardExplorer rows={merged} protocols={allProtocols} split={split} />;
}
