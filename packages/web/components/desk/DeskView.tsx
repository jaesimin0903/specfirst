import type { DeskViewJson } from '../../lib/desk/types';
import { formatDuration, formatMonAmount, toWei } from '../../lib/desk/format';
import { testnetAddressUrl } from '../../lib/desk/config';
import { shortAddress, timeAgo } from '../../lib/format';
import { StageTag } from './Marks';

function Money({ wei, digits = 4 }: { wei: string | null; digits?: number }) {
  const v = toWei(wei);
  return v === null ? <span className="soft">n/a</span> : <>{formatMonAmount(v, digits)}</>;
}

function Fig({ n, label, note, tone }: { n: React.ReactNode; label: string; note: string; tone?: string }) {
  return (
    <div className="sb-figure" data-tone={tone}>
      <span className="sb-figure-n">{n}</span>
      <span className="sb-figure-label">{label}</span>
      <span className="sb-figure-note">{note}</span>
    </div>
  );
}

function share(part: bigint, total: bigint): string {
  return total > 0n ? `${Number((part * 10000n) / total) / 100}%` : '0%';
}

/** /desk: what the desk has earned, against what the worker spent, for someone deciding if this is a business. */
export function DeskView({ data }: { data: DeskViewJson }) {
  const { summary: s, economics: e, recent } = data;
  const c = e.counts;
  const earned = toWei(e.earnedWei) ?? 0n;
  const escrow = toWei(e.escrowedWei) ?? 0n;
  const returned = toWei(c?.returnedWei ?? null) ?? 0n;
  const totalFlow = earned + escrow + returned;
  const net = toWei(e.netWei);
  const timeout = s.timeoutSec ? Number(s.timeoutSec) : null;

  if (!s.deployed) {
    return (
      <section className="sb-section">
        <div className="sb-notice">
          <h2>Desk not deployed</h2>
          <p>
            CheckRequestDesk has no address on Monad testnet here yet. Set <code>NEXT_PUBLIC_SPECFIRST_DESK_10143</code> to the deployed desk and restart
            the server; this page reads fee, earned, withdrawn and escrowed from it, and the worker&apos;s gas from <code>.specfirst/worker/status.json</code>.
          </p>
        </div>
      </section>
    );
  }

  return (
    <>
      {s.errors.length > 0 && (
        <p className="sb-blocker" role="status" style={{ marginBottom: 20 }}>
          Some reads failed, so those figures show n/a: {s.errors.slice(0, 2).join('; ')}
        </p>
      )}
      <div className="sb-figures" data-count="4" style={{ marginTop: 8 }} aria-label="Requests">
        <Fig
          n={
            <>
              <Money wei={e.feeWei} />
              <small>MON</small>
            </>
          }
          label="Fee per check"
          note={timeout !== null ? `refundable after ${formatDuration(timeout)}` : 'set by the owner'}
        />
        <Fig n={c ? c.total : 'n/a'} label="Requests" note={c?.truncated ? 'counts cover the latest 300' : 'paid onchain'} />
        <Fig n={c ? c.fulfilled : 'n/a'} label="Fulfilled" note="attested, fee earned" tone="seal" />
        <Fig n={c ? c.rejected + c.refunded : 'n/a'} label="Rejected or refunded" note={c ? `${c.rejected} rejected, ${c.refunded} refunded, fee returned` : 'fee returned'} />
      </div>
      <div className="sb-figures" data-count="3" style={{ marginTop: 0, borderTop: 0 }} aria-label="Money">
        <Fig
          n={
            <>
              <Money wei={e.earnedWei} />
              <small>MON</small>
            </>
          }
          label="Earned"
          note={`fees of fulfilled requests; ${e.withdrawnWei ? formatMonAmount(toWei(e.withdrawnWei)!) : 'n/a'} MON withdrawn`}
        />
        <Fig
          n={
            <>
              <Money wei={e.gasCostWei} />
              <small>MON</small>
            </>
          }
          label="Worker gas"
          note={data.worker.available ? 'every attest, fulfil and reject transaction' : 'status.json not found, so not counted'}
        />
        <Fig
          n={
            <>
              <Money wei={e.netWei} />
              <small>MON</small>
            </>
          }
          label="Net"
          note={e.marginPct !== null ? `earned minus gas, ${e.marginPct}% of earned` : 'earned minus worker gas'}
          tone={net !== null && net < 0n ? 'fail' : undefined}
        />
      </div>

      <section className="sb-section" aria-labelledby="flow-h" style={{ borderTop: 0, paddingTop: 36 }}>
        <h2 className="sb-h2" id="flow-h">
          Where every paid fee is
        </h2>
        <p className="sb-lede">Fees sit in escrow until the attestation lands. Only fulfilled requests count as earned; rejects and expiries go back to the payer.</p>
        <div className="sb-flowbar" role="img" aria-label={`Earned ${share(earned, totalFlow)}, in escrow ${share(escrow, totalFlow)}, returned ${share(returned, totalFlow)}`}>
          {totalFlow > 0n && (
            <>
              <span className="earned" style={{ width: share(earned, totalFlow) }} />
              <span className="escrow" style={{ width: share(escrow, totalFlow) }} />
              <span className="returned" style={{ width: share(returned, totalFlow) }} />
            </>
          )}
        </div>
        <ul className="sb-flowkey">
          <li>
            <i className="earned" /> Earned <b>{formatMonAmount(earned)} MON</b>
          </li>
          <li>
            <i className="escrow" /> In escrow <b>{formatMonAmount(escrow)} MON</b>
            {c && c.pending > 0 ? ` for ${c.pending} pending` : ''}
            {c && c.expired > 0 ? `, ${c.expired} refundable now` : ''}
          </li>
          <li>
            <i className="returned" /> Returned <b>{formatMonAmount(returned)} MON</b>
          </li>
        </ul>
      </section>

      <section className="sb-section sb-split" aria-label="Requests and unit economics">
        <div>
          <h2 className="sb-h2">Latest requests</h2>
          {recent.length === 0 ? (
            <p className="sb-empty">
              No request yet. <a href="/check">Make the first one</a>.
            </p>
          ) : (
            <div className="sb-table-scroll">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Vault</th>
                    <th scope="col">Stage</th>
                    <th scope="col" className="r">
                      Fee
                    </th>
                    <th scope="col">Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((it) => (
                    <tr key={it.request.id}>
                      <td className="nowrap">
                        <a href={`/check/${it.request.id}`}>{it.request.id}</a>
                      </td>
                      <td className="sb-vault-cell">
                        <a href={`/v/${it.request.subjectChainId}/${it.request.subject.toLowerCase()}`}>{it.vault.name ?? shortAddress(it.request.subject)}</a>
                        <span className="sb-vault-sub">{it.vault.protocol ?? <span className="mono">{shortAddress(it.request.subject)}</span>}</span>
                      </td>
                      <td className="nowrap">
                        <StageTag label={it.label} tone={it.tone} />
                      </td>
                      <td className="r nowrap">{formatMonAmount(toWei(it.request.feeWei)!)}</td>
                      <td className="nowrap soft">{timeAgo(it.request.requestedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h2 className="sb-h2">One more check</h2>
          <p className="sb-lede">What the next fulfilled request adds, if the worker&apos;s gas per check stays where it has been.</p>
          <dl className="sb-facts">
            <dt>Fee</dt>
            <dd>
              <Money wei={e.feeWei} /> MON
            </dd>
            <dt>Gas per check</dt>
            <dd>{e.gasPerCheckWei ? <><Money wei={e.gasPerCheckWei} digits={6} /> MON</> : <span className="soft">no finished request yet</span>}</dd>
            <dt>Adds</dt>
            <dd>{e.unitProfitWei ? <><Money wei={e.unitProfitWei} digits={6} /> MON</> : <span className="soft">n/a</span>}</dd>
            <dt>Withdrawable</dt>
            <dd>
              <Money wei={e.withdrawableWei} /> MON
            </dd>
          </dl>
          <h3 className="sb-h3" style={{ marginTop: 28 }}>
            Contract
          </h3>
          <dl className="sb-facts">
            <dt>Desk</dt>
            <dd>
              <a href={testnetAddressUrl(s.address!)} className="mono">
                {shortAddress(s.address!)}
              </a>
            </dd>
            <dt>Worker</dt>
            <dd>{s.worker ? <a href={testnetAddressUrl(s.worker)} className="mono">{shortAddress(s.worker)}</a> : 'n/a'}</dd>
            <dt>Owner</dt>
            <dd>{s.owner ? <a href={testnetAddressUrl(s.owner)} className="mono">{shortAddress(s.owner)}</a> : 'n/a'}</dd>
            <dt>Registry</dt>
            <dd>{s.registry ? <a href={testnetAddressUrl(s.registry)} className="mono">{shortAddress(s.registry)}</a> : 'n/a'}</dd>
            <dt>Timeout</dt>
            <dd>{timeout !== null ? formatDuration(timeout) : 'n/a'}</dd>
            <dt>Read</dt>
            <dd>{s.readAt.slice(11, 19)} UTC</dd>
          </dl>
        </div>
      </section>
    </>
  );
}
