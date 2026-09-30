'use client';

import { useEffect, useState } from 'react';
import type { RequestViewJson } from '../../lib/desk/types';
import { formatDuration, formatMon, formatMonAmount, toWei } from '../../lib/desk/format';
import { SUBJECT_CHAIN_NAME, testnetAddressUrl, testnetTxUrl, PROPERTY_COUNT, UPSTREAM_PROPERTY_COUNT } from '../../lib/desk/config';
import { recallRequestTx, rememberRequestTx } from '../../lib/desk/txMemory';
import { sendRefund, walletErrorMessage } from '../../lib/desk/wallet';
import { shortAddress, shortHash, timeAgo } from '../../lib/format';
import { formatBlock } from '../../lib/board/reasons';
import { Timeline } from './Timeline';
import { PropertyCells } from './Marks';
import { ResultCard } from './ResultCard';
import { WalletPanel } from './WalletPanel';
import { useDeskWallet } from './useDeskWallet';

export type RequestLoad = { kind: 'ok'; view: RequestViewJson } | { kind: 'not-found' } | { kind: 'not-deployed' } | { kind: 'error'; reason: string };

const FAST_MS = 4_000;
const SLOW_MS = 12_000;

function nowLabel(v: RequestViewJson): string {
  const p = v.progress;
  if (p.outcome === 'fulfilled') return 'Fulfilled';
  if (p.outcome === 'rejected') return 'Rejected';
  if (p.outcome === 'refunded') return 'Refunded';
  if (p.outcome === 'expired') return 'Expired';
  return p.steps.find((s) => s.state === 'active')?.label ?? 'Queued';
}

function Deliverable({ ready, label, href, note }: { ready: boolean; label: string; href?: string | null; note: string }) {
  return (
    <li>
      <span className="sb-dot" data-s={ready ? 'sealed' : 'waiting'} aria-hidden="true" />
      <span>
        {ready && href ? <a href={href}>{label}</a> : label}
        <span className="soft">{note}</span>
      </span>
    </li>
  );
}

/** /check/<id>: polls the request and shows what was paid, what is coming, and where it stands. */
export function RequestProgress({ id, initial, rpc, faucet, txParam }: { id: string; initial: RequestLoad; rpc: string; faucet: string; txParam: string | null }) {
  const [load, setLoad] = useState<RequestLoad>(initial);
  const [origin, setOrigin] = useState('');
  const [requestTx, setRequestTx] = useState<string | null>(txParam);
  const [misses, setMisses] = useState(0);
  const [refund, setRefund] = useState<{ phase: 'idle' | 'signing' | 'pending' | 'error'; message?: string; hash?: string }>({ phase: 'idle' });
  const wallet = useDeskWallet(rpc);

  const view = load.kind === 'ok' ? load.view : null;
  const terminal = view?.progress.terminal ?? false;

  useEffect(() => setOrigin(window.location.origin), []);

  useEffect(() => {
    const desk = view?.desk.address;
    if (!desk) return;
    if (txParam) rememberRequestTx(desk, id, txParam);
    else setRequestTx(recallRequestTx(desk, id));
  }, [view?.desk.address, id, txParam]);

  const [nonce, setNonce] = useState(0);
  const stopped = terminal || load.kind === 'not-deployed' || (load.kind === 'not-found' && misses > 15);
  const delay = view?.progress.expired || load.kind === 'error' ? SLOW_MS : FAST_MS;
  useEffect(() => {
    // A just-mined request can be missing from a lagging RPC node for a few seconds; keep asking for a minute.
    if (stopped) return;
    const t = window.setTimeout(async () => {
      try {
        if (document.visibilityState === 'hidden') return;
        const res = await fetch(`/api/desk/requests/${id}`, { cache: 'no-store' });
        const body = await res.json();
        if (res.ok) {
          setLoad({ kind: 'ok', view: body as RequestViewJson });
          setMisses(0);
        } else if (res.status === 404) {
          setLoad((cur) => (cur.kind === 'ok' ? cur : { kind: 'not-found' }));
          setMisses((m) => m + 1);
        } else if (res.status === 503) setLoad({ kind: 'not-deployed' });
        else setLoad((cur) => (cur.kind === 'ok' ? cur : { kind: 'error', reason: body.reason ?? 'unreadable' }));
      } catch {
        // Offline for a moment; the next round tries again.
      } finally {
        setNonce((n) => n + 1);
      }
    }, delay);
    return () => window.clearTimeout(t);
  }, [id, nonce, stopped, delay]);

  if (load.kind === 'not-deployed') {
    return (
      <div className="sb-notice" style={{ marginBlock: 32 }}>
        <h2>Desk not deployed</h2>
        <p>
          CheckRequestDesk has no address on Monad testnet here yet (NEXT_PUBLIC_SPECFIRST_DESK_10143), so there is no request #{id} to follow.
        </p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="sb-notice" style={{ marginBlock: 32 }} aria-live="polite">
        <h2>{load.kind === 'error' ? 'Could not read the desk' : `Looking for request #${id}`}</h2>
        <p>
          {load.kind === 'error'
            ? `Monad testnet did not answer (${load.reason}). This page keeps trying.`
            : misses > 15
              ? 'The desk has no request with this id. Check the link, or start a new request.'
              : 'A request that was just paid for can take a few seconds to show up on the public RPC. This page keeps asking.'}
        </p>
        <p>
          <a href="/check">Request a check</a>
        </p>
      </div>
    );
  }

  const r = view.request;
  const p = view.progress;
  const fee = toWei(r.feeWei)!;
  const vaultName = view.vault.name ?? shortAddress(r.subject);
  const running = p.activeKey === 'running';
  const fulfilled = p.outcome === 'fulfilled';
  const result = view.result;
  const heldWord = fulfilled ? 'Earned by the desk' : p.outcome === 'rejected' || p.outcome === 'refunded' ? 'Returned to you' : 'In escrow';

  async function onRefund() {
    if (!wallet.signer) return;
    setRefund({ phase: 'signing' });
    try {
      const hash = await sendRefund({ signer: wallet.signer, desk: view!.desk.address as `0x${string}`, id: BigInt(id), rpc });
      setRefund({ phase: 'pending', hash });
    } catch (err) {
      setRefund({ phase: 'error', message: walletErrorMessage(err) });
    }
  }

  return (
    <>
      <header className="sb-vault-head" style={{ paddingBottom: 24 }}>
        <p className="sb-eyebrow">Request #{r.id}</p>
        <h1 className="sb-vault-name" style={{ marginTop: 0 }}>
          {vaultName}
        </h1>
        <p className="sb-vault-meta">
          {view.vault.protocol && <span>{view.vault.protocol}</span>}
          {view.vault.assetSymbol && <span>Asset {view.vault.assetSymbol}</span>}
          <span className="mono break">{r.subject}</span>
          <span>{SUBJECT_CHAIN_NAME}</span>
        </p>
      </header>

      <div className="sb-ledger">
        <section aria-labelledby="paid-h">
          <h2 id="paid-h">You paid</h2>
          <span className="sb-money num">
            {formatMonAmount(fee)}
            <small>MON</small>
          </span>
          <dl>
            <dt>Now</dt>
            <dd>
              <strong>{heldWord}</strong>
            </dd>
            <dt>From</dt>
            <dd>
              <a href={testnetAddressUrl(r.requester)} className="mono" title={r.requester}>
                {shortAddress(r.requester)}
              </a>
            </dd>
            <dt>Paid</dt>
            <dd>
              <time dateTime={r.requestedAt}>{timeAgo(r.requestedAt)}</time>
              {requestTx && (
                <>
                  {', '}
                  <a href={testnetTxUrl(requestTx)} className="mono" title={requestTx}>
                    tx {shortHash(requestTx)}
                  </a>
                </>
              )}
            </dd>
          </dl>
        </section>

        <section aria-labelledby="now-h" aria-live="polite">
          <h2 id="now-h">Where it is</h2>
          <p className="sb-now" data-outcome={p.outcome ?? undefined}>
            {nowLabel(view)}
          </p>
          <PropertyCells cells={result?.cells ?? null} split={result?.split ?? UPSTREAM_PROPERTY_COUNT} count={PROPERTY_COUNT} running={running} width={360} />
          <dl>
            {result && (
              <>
                <dt>Result</dt>
                <dd>
                  {result.summary.pass} pass, {result.summary.fail} fail, {result.summary.inconclusive} inconclusive
                  {result.summary.notApplicable ? `, ${result.summary.notApplicable} n/a` : ''}
                </dd>
                <dt>Block</dt>
                <dd>{formatBlock(result.blockNumber)}, Monad mainnet</dd>
              </>
            )}
            {view.worker.updatedAt && !p.terminal && (
              <>
                <dt>Worker</dt>
                <dd>updated {timeAgo(view.worker.updatedAt)}</dd>
              </>
            )}
            {!p.terminal && p.secondsToExpiry !== null && (
              <>
                <dt>Refund</dt>
                <dd>{p.expired ? 'open now' : `opens in ${formatDuration(p.secondsToExpiry)} if not fulfilled`}</dd>
              </>
            )}
            {p.rejectCode && (
              <>
                <dt>Code</dt>
                <dd className="mono">{p.rejectCode}</dd>
              </>
            )}
          </dl>
        </section>

        <section aria-labelledby="get-h">
          <h2 id="get-h">You get</h2>
          <ul className="sb-gets">
            <Deliverable ready={fulfilled && Boolean(result)} label={`${PROPERTY_COUNT} property results`} href={result?.vaultPath} note="on the vault page" />
            <Deliverable
              ready={fulfilled && Boolean(result?.attestation)}
              label={result?.attestation ? `Attestation #${result.attestation.id}` : 'Onchain attestation'}
              href={result?.attestation?.txHash ? testnetTxUrl(result.attestation.txHash) : result?.vaultPath}
              note="CheckAttestationRegistry, Monad testnet"
            />
            <Deliverable ready={fulfilled && Boolean(result)} label="Badge" href={result?.badgePath} note="SVG, read live from the registry" />
            <Deliverable ready={fulfilled && Boolean(result)} label="JSON API" href={result?.apiPath} note="for routers and curators" />
          </ul>
          {(p.outcome === 'rejected' || p.outcome === 'refunded') && (
            <p className="soft" style={{ fontSize: 13, margin: '10px 0 0' }}>
              Nothing to deliver: the request ended without a check, and the fee went back to {shortAddress(r.requester)}.
            </p>
          )}
        </section>
      </div>

      <div className="sb-progress">
        <section aria-labelledby="steps-h">
          <h2 className="sb-h3" id="steps-h">
            Steps
          </h2>
          <Timeline progress={p} txs={{ request: requestTx, attest: view.worker.txs.attest, fulfill: view.worker.txs.fulfill, reject: view.worker.txs.reject }} />
          {p.note && <p className="sb-note">{p.note}</p>}
          {!p.terminal && (
            <p className="sb-note">
              This page asks the desk every few seconds. It reads requestOf on Monad testnet and the worker&apos;s status file; you can close it and come
              back.
            </p>
          )}
        </section>

        <section aria-label="Result and escrow">
          {fulfilled && result ? (
            <ResultCard result={result} origin={origin} />
          ) : fulfilled ? (
            <div className="sb-notice">
              <h2>Fulfilled</h2>
              <p>The attestation is onchain. Its report is not readable from this server yet; the vault page will show it once it is.</p>
              <p>
                <a href={`/v/${r.subjectChainId}/${r.subject.toLowerCase()}`}>Open the vault page</a>
              </p>
            </div>
          ) : p.outcome === 'rejected' || p.outcome === 'refunded' ? (
            <>
              <h2 className="sb-h3">Your fee</h2>
              <div className="sb-escrow">
                <p>
                  {formatMon(fee)} went back to {shortAddress(r.requester)}
                  {p.outcome === 'rejected' ? ' in the same transaction that rejected the request.' : ' when refundExpired was called.'} The desk kept nothing.
                </p>
                {p.rejectText && <p className="soft">{p.rejectText}</p>}
              </div>
              <p style={{ marginTop: 20 }}>
                <a className="sb-action" data-kind="quiet" href={`/check?vault=${r.subject}`}>
                  Try this vault again
                </a>
              </p>
            </>
          ) : (
            <>
              <h2 className="sb-h3">Your fee, until then</h2>
              <div className="sb-escrow">
                <p>
                  {formatMon(fee)} sits in CheckRequestDesk. It becomes the desk&apos;s only when the worker fulfils this request, which it can do only after
                  the attestation is recorded.
                </p>
                <p className="soft">
                  A reject returns the whole fee in the same transaction. If the request is still pending{' '}
                  {view.timeoutSec ? `${formatDuration(Number(view.timeoutSec))} after it was paid` : 'after the timeout'}, anyone can call refundExpired
                  and the fee goes back to {shortAddress(r.requester)}.
                </p>
              </div>
              {p.refundable && (
                <div className="sb-panel" style={{ marginTop: 22 }}>
                  <h3>Refund</h3>
                  <p className="soft" style={{ fontSize: 13.5, margin: '0 0 12px' }}>
                    The timeout has passed. Anyone may send refundExpired({r.id}); the fee goes to the requester, not to whoever sends it.
                  </p>
                  <WalletPanel wallet={wallet} faucet={faucet} needWei={null} />
                  <p style={{ marginTop: 14 }}>
                    <button type="button" className="sb-action" disabled={!wallet.signer || refund.phase === 'signing' || refund.phase === 'pending'} onClick={onRefund}>
                      {refund.phase === 'signing' ? 'Confirm in the wallet' : refund.phase === 'pending' ? 'Refund sent' : `Refund ${formatMon(fee)}`}
                    </button>
                  </p>
                  {refund.phase === 'error' && (
                    <p className="sb-status-line" data-tone="error" role="alert">
                      {refund.message}
                    </p>
                  )}
                  {refund.hash && (
                    <p className="sb-status-line">
                      <a href={testnetTxUrl(refund.hash)} className="mono">
                        tx {shortHash(refund.hash)}
                      </a>
                      . The steps update when the desk records it.
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </>
  );
}
