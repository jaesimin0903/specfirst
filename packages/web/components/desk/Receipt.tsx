import { formatDuration, formatMonAmount, toWei } from '../../lib/desk/format';
import { DESK_CHAIN_NAME, PROPERTY_COUNT, testnetAddressUrl, UPSTREAM_PROPERTY_COUNT } from '../../lib/desk/config';
import type { DeskSummaryJson } from '../../lib/desk/types';
import { shortAddress } from '../../lib/format';
import { Dot } from './Marks';

/** The right-hand panel of /check: what the requester pays, what they get, and the escrow rule between the two. */
export function Receipt({ summary, loading, example }: { summary: DeskSummaryJson | null; loading: boolean; example: string | null }) {
  const fee = toWei(summary?.feeWei);
  const timeout = summary?.timeoutSec ? Number(summary.timeoutSec) : null;
  const deployed = summary?.deployed ?? false;
  return (
    <aside className="sb-receipt" aria-label="What you pay and what you get">
      <section>
        <h2>You pay</h2>
        {fee !== null ? (
          <span className="sb-money num">
            {formatMonAmount(fee)}
            <small>MON</small>
          </span>
        ) : (
          <span className="sb-money" data-muted="true">
            {loading ? '...' : deployed ? 'fee unread' : 'not open'}
          </span>
        )}
        <p>
          Testnet MON, once, into CheckRequestDesk
          {summary?.address ? (
            <>
              {' '}
              <a href={testnetAddressUrl(summary.address)} className="mono">
                {shortAddress(summary.address)}
              </a>
            </>
          ) : null}{' '}
          on {DESK_CHAIN_NAME}. Plus gas.
        </p>
      </section>

      <section>
        <h2>Held in escrow</h2>
        <p style={{ marginTop: 0, color: 'var(--ink)' }}>The fee becomes ours only when your attestation lands onchain.</p>
        <p>
          If the worker rejects the request, the whole fee comes back in the same transaction.
          {timeout !== null ? ` If nothing is fulfilled within ${formatDuration(timeout)}, anyone can refund it to you.` : ' If it is never fulfilled, anyone can refund it to you after the timeout.'}
        </p>
      </section>

      <section>
        <h2>You get</h2>
        <ul className="sb-gets">
          <li>
            <Dot s="done" />
            <span>
              {PROPERTY_COUNT} property results at the latest Monad block
              <span className="soft">
                {UPSTREAM_PROPERTY_COUNT} from a16z/erc4626-tests and {PROPERTY_COUNT - UPSTREAM_PROPERTY_COUNT} max-honored checks, on a vault page
                {example ? (
                  <>
                    {' '}
                    (<a href={example}>see one</a>)
                  </>
                ) : null}
                .
              </span>
            </span>
          </li>
          <li>
            <Dot s="sealed" />
            <span>
              An onchain attestation
              <span className="soft">CheckAttestationRegistry on {DESK_CHAIN_NAME} stores the report hash and the counts.</span>
            </span>
          </li>
          <li>
            <Dot s="done" />
            <span>
              A badge for your README or docs
              <span className="soft">Compliant, Mismatch, Partly checked or Not attested, read from the registry.</span>
            </span>
          </li>
          <li>
            <Dot s="done" />
            <span>
              A JSON API for routers and curators
              <span className="soft">The four max-honored flags, isCompliant and the command that replays the check.</span>
            </span>
          </li>
        </ul>
      </section>
    </aside>
  );
}
