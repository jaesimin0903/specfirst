import type { RevenueJson } from '../../lib/subs/revenue';
import { formatMonAmount, toWei } from '../../lib/desk/format';
import { testnetAddressUrl } from '../../lib/desk/config';
import { shortAddress } from '../../lib/format';

function signed(wei: string | null): bigint | null {
  return wei !== null && /^-?\d+$/.test(wei) ? BigInt(wei) : null;
}

function Money({ wei, unit = false }: { wei: string | null; unit?: boolean }) {
  const v = signed(wei);
  return v === null ? <span className="soft">n/a</span> : <>{`${formatMonAmount(v)}${unit ? ' MON' : ''}`}</>;
}

/** /desk: desk fees and alert subscriptions together, against what the desk worker and the watcher spent on gas. */
export function RevenueView({ r }: { r: RevenueJson }) {
  const net = signed(r.netWei);
  return (
    <section className="sb-section" aria-labelledby="both-h">
      <h2 className="sb-h2" id="both-h">
        Desk and subscriptions together
      </h2>
      <p className="sb-lede">
        Free checks earn nothing; the money is in the two contracts. Fees count as earned only when they are: desk fees once the attestation lands, subscription
        fees day by day as days start. Gas comes from the status files the desk worker and the watcher write.
      </p>
      <div className="sb-split">
        <div className="sb-table-scroll">
          <table className="sb-table">
            <thead>
              <tr>
                <th scope="col">MON</th>
                <th scope="col" className="r">
                  Earned
                </th>
                <th scope="col" className="r">
                  In escrow
                </th>
                <th scope="col" className="r">
                  Withdrawn
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  Request desk
                  {!r.desk.deployed && <span className="sb-vault-sub">not deployed</span>}
                </td>
                <td className="r">
                  <Money wei={r.desk.earnedWei} />
                </td>
                <td className="r">
                  <Money wei={r.desk.escrowedWei} />
                </td>
                <td className="r">
                  <Money wei={r.desk.withdrawnWei} />
                </td>
              </tr>
              <tr>
                <td>
                  Alert subscriptions
                  <span className="sb-vault-sub">
                    {r.subs.deployed && r.subs.address ? (
                      <>
                        <a href={testnetAddressUrl(r.subs.address)} className="mono">
                          {shortAddress(r.subs.address)}
                        </a>
                        {r.subs.count !== null ? `, ${r.subs.count} sold` : ''}
                        {r.subs.feePerDayWei !== null ? `, ${formatMonAmount(toWei(r.subs.feePerDayWei)!)} MON a day` : ''}
                      </>
                    ) : (
                      'not deployed yet'
                    )}
                  </span>
                </td>
                <td className="r">
                  <Money wei={r.subs.earnedWei} />
                </td>
                <td className="r">
                  <Money wei={r.subs.escrowedWei} />
                </td>
                <td className="r">
                  <Money wei={r.subs.withdrawnWei} />
                </td>
              </tr>
              <tr>
                <td>
                  <strong>Together</strong>
                </td>
                <td className="r">
                  <strong>
                    <Money wei={r.earnedWei} />
                  </strong>
                </td>
                <td className="r">
                  <Money wei={r.escrowedWei} />
                </td>
                <td className="r">
                  <Money wei={r.withdrawnWei} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div>
          <dl className="sb-facts">
            <dt>Earned</dt>
            <dd>
              <Money wei={r.earnedWei} unit />
            </dd>
            <dt>Desk worker gas</dt>
            <dd>{r.deskGasWei !== null ? <Money wei={r.deskGasWei} unit /> : <span className="soft">not reported</span>}</dd>
            <dt>Watcher gas</dt>
            <dd>
              {r.watcherGasWei !== null ? (
                <>
                  <Money wei={r.watcherGasWei} unit /> <span className="soft">({r.watcherGasChains.map((c) => `chain ${c}`).join(', ')})</span>
                </>
              ) : (
                <span className="soft">not reported by the watcher&apos;s status.json</span>
              )}
            </dd>
            <dt>Net</dt>
            <dd style={net !== null && net < 0n ? { color: 'var(--fail)', fontWeight: 600 } : { fontWeight: 600 }}>
              <Money wei={r.netWei} unit />
            </dd>
          </dl>
          {r.missing.length > 0 && (
            <p className="soft" style={{ fontSize: 13, marginTop: 12 }}>
              Not counted, because it could not be read or is not reported: {r.missing.join(', ')}.
            </p>
          )}
          {r.subs.errors.length > 0 && (
            <p className="sb-status-line" data-tone="error">
              Subscription reads failed: {r.subs.errors.slice(0, 2).join('; ')}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
