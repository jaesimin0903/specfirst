import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Mock staking route picker',
};

/**
 * Mock staking route selection screen (docs/plan.md 3.8: "샘플과 라우팅의 결 맞추기... 어그리게이터
 * 시나리오를 스테이킹 경로 선택 화면에서 볼트 노출로 설명한다"). Required fallback deliverable for
 * 10/8 if no real aggregator integration lands (L2+). Explicitly labeled a mock screen per
 * docs/plan.md 3.8's rule that "통합 1곳" can only be claimed at L2 or above.
 *
 * Uses the real public/widget.js badge (docs/plan.md point 6), not a re-implementation, so this
 * page also doubles as a live example snippet for the "통합 두 줄" pitch.
 */
export default function AggregatorDemoPage() {
  const certified = process.env.NEXT_PUBLIC_DEMO_VAULT_CERTIFIED;
  const uncertified = process.env.NEXT_PUBLIC_DEMO_VAULT_UNCERTIFIED;

  return (
    <main className="page">
      <div className="demo-banner">Mock screen: not a real aggregator. No swap here executes anything.</div>

      <h1 className="h">Choose a staking vault</h1>
      <p className="muted">Sending 1,200 MON. Two routes are available for this pair.</p>

      <div className="vault-card">
        <div>
          <div className="vault-name">StakingVault v2</div>
          <div className="vault-address">{certified ?? 'NEXT_PUBLIC_DEMO_VAULT_CERTIFIED not set'}</div>
        </div>
        {certified ? (
          <script src="/widget.js" data-address={certified} />
        ) : (
          <span className="muted small">not configured</span>
        )}
      </div>

      <div className="vault-card dashed">
        <div>
          <div className="vault-name">OtherVault v0</div>
          <div className="vault-address">{uncertified ?? 'NEXT_PUBLIC_DEMO_VAULT_UNCERTIFIED not set'}</div>
          <p className="muted small" style={{ marginTop: 4 }}>
            No certificate on file. Route at your own risk.
          </p>
        </div>
        {uncertified ? (
          <script src="/widget.js" data-address={uncertified} />
        ) : (
          <span className="muted small">not configured</span>
        )}
      </div>

      <p className="muted small" style={{ marginTop: 24 }}>
        Integration snippet used on this page:
      </p>
      <pre className="box small">
        <code>{'<script src=".../widget.js" data-address="0x..."></script>'}</code>
      </pre>
    </main>
  );
}
