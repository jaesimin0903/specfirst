import type { Metadata } from 'next';
import { loadBoard } from '../../lib/board/load';
import { toExplorerRow } from '../../lib/board/view';
import { PropertyMatrix } from '../../components/board/PropertyMatrix';
import { RecentRequests } from '../../components/desk/RecentRequests';
import { WatchBoardExplorer } from '../../components/watch/WatchBoardExplorer';
import { WatchBand } from '../../components/watch/WatchBand';
import { Figures, Findings, Hero, MatrixLegend, MethodSummary, ProtocolTable, ReasonBars } from '../../components/board/BoardSections';

export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Monad ERC-4626 board | Specfirst',
  description: 'Every ERC-4626 vault on Monad, checked against public third-party properties, with results attested on Monad testnet.',
};

export default function BoardPage() {
  const board = loadBoard();
  const split = board.properties.filter((p) => p.origin === 'upstream').length || 26;

  if (board.vaults.length === 0) {
    return (
      <main className="sb-wrap">
        <Hero board={board} />
        <section className="sb-section">
          <h2 className="sb-h2">No check reports yet</h2>
          <p className="sb-lede">
            Build the board data from a directory of <code>specfirst check</code> reports, then reload:{' '}
            <code>pnpm --filter @specfirst/web board:build</code>. It reads <code>certs/checks/&lt;chainId&gt;/&lt;address&gt;/*.json</code> unless{' '}
            <code>SPECFIRST_BOARD_SOURCE</code> points elsewhere.
          </p>
        </section>
      </main>
    );
  }

  return (
    <>
      <RecentRequests />
      <WatchBand />
      <main className="sb-wrap">
        <Hero board={board} />
        <PropertyMatrix board={board} />
        <MatrixLegend />
        <Figures board={board} />
        <Findings board={board} />
        <section className="sb-section sb-split" aria-label="Unchecked properties and protocols">
          <ReasonBars board={board} />
          <ProtocolTable board={board} />
        </section>
        <section className="sb-section" id="vaults" aria-labelledby="vaults-h" style={{ scrollMarginTop: 16 }}>
          <h2 className="sb-h2" id="vaults-h">
            All vaults
          </h2>
          <p className="sb-lede">
            Mismatches first. Each row links to the vault&apos;s page with every property, the reasons behind each result and the command that replays
            the check. Vaults the watcher found after this board was built are added when the page opens, marked as found by the watcher.
          </p>
          <WatchBoardExplorer rows={board.vaults.map(toExplorerRow)} protocols={board.protocols.map((p) => p.protocol).sort()} split={split} />
        </section>
        <MethodSummary board={board} />
      </main>
    </>
  );
}
