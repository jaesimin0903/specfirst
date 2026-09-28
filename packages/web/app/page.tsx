import { getRegistryAddress } from '../lib/chain';

/**
 * Not a dashboard (docs/plan.md's 4절: "대시보드 `/app`은 컷"). This is a minimal landing note
 * pointing at the two pages that matter: a certificate page and the mock aggregator demo.
 */
export default function HomePage() {
  const registry = getRegistryAddress();
  return (
    <main className="page">
      <h1 className="h">Specfirst</h1>
      <p>On-chain certificates for spec-verified contracts on Monad testnet.</p>
      {!registry && <p className="notice">registry not configured</p>}
      <ul className="plain-list">
        <li>
          Certificate page: <code>/c/&lt;address&gt;</code>
        </li>
        <li>
          Badge: <code>/badge/&lt;address&gt;</code>
        </li>
        <li>
          REST: <code>/api/cert/&lt;address&gt;</code>
        </li>
        <li>
          <a href="/demo/aggregator">Mock aggregator demo</a>
        </li>
      </ul>
    </main>
  );
}
