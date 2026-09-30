import type { BoardData } from '../../lib/board/types';
import { addressUrl } from '../../lib/board/attestations';
import { shortAddress } from '../../lib/format';

export function BoardFooter({ board }: { board: BoardData }) {
  const r = board.registry;
  const built = board.generatedAt && Date.parse(board.generatedAt) > 0 ? board.generatedAt.slice(0, 16).replace('T', ' ') + ' UTC' : 'not built yet';
  return (
    <footer className="sb-foot">
      <div className="sb-wrap">
        <div>
          <p>
            <strong>Specfirst</strong> checks deployed contracts against third-party properties and records the results onchain. Built for Monad
            Metropolis, track 4.
          </p>
          <p>
            Also here: spec certificates at <code>/c/&lt;address&gt;</code>, the <a href="/demo/aggregator">aggregator demo</a>.
          </p>
        </div>
        <div>
          <p>
            Attestations: CheckAttestationRegistry{' '}
            <a href={addressUrl(r.address)} className="mono">
              {shortAddress(r.address)}
            </a>{' '}
            on Monad testnet ({r.chainId}).
          </p>
          <p>
            Data built {built} from <span className="mono">{board.source}</span>
            {board.skipped.length ? `, ${board.skipped.length} files skipped` : ''}.
          </p>
        </div>
      </div>
    </footer>
  );
}
