'use client';

import { useCallback, useEffect, useState } from 'react';
import type { InboxJson, SubscriptionJson } from '../../lib/subs/types';
import { sendCancel, signText, waitForCancelled } from '../../lib/subs/wallet';
import { webhookMessage } from '../../lib/subs/core';
import { formatMon, toWei } from '../../lib/desk/format';
import { testnetTxUrl } from '../../lib/desk/config';
import { walletErrorMessage } from '../../lib/desk/wallet';
import { shortAddress, shortHash } from '../../lib/format';
import { useDeskWallet } from '../desk/useDeskWallet';
import { WalletPanel } from '../desk/WalletPanel';
import { FeedItem } from './FeedItem';

const POLL_MS = 10_000;

const ITEM_NOTE: Record<InboxJson['items'][number]['kind'], string> = {
  change: 'Alert',
  'first-check': 'First check since you subscribed',
  delivery: 'Delivery',
};

function until(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

type CancelState = { id: string; phase: 'confirm' | 'signing' | 'pending' | 'done' | 'error'; hash?: `0x${string}`; refund?: bigint; message?: string };

/** /watch/inbox: the paying address's subscriptions, the alerts the feed holds for them, and the webhook. */
export function InboxView({ contract, rpc, faucet }: { contract: string | null; rpc: string; faucet: string }) {
  const wallet = useDeskWallet(rpc);
  const who = wallet.signer?.address ?? null;
  const [data, setData] = useState<InboxJson | null>(null);
  const [loading, setLoading] = useState(false);
  const [cancel, setCancel] = useState<CancelState | null>(null);

  const load = useCallback(async () => {
    if (!who) {
      setData(null);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/v1/watch/inbox?subscriber=${who}`, { cache: 'no-store' });
      if (r.ok) setData((await r.json()) as InboxJson);
    } catch {
      // Keep what is shown; the next poll tries again.
    } finally {
      setLoading(false);
    }
  }, [who]);

  useEffect(() => {
    load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  async function doCancel(s: SubscriptionJson) {
    if (!wallet.signer || !contract) return;
    setCancel({ id: s.id, phase: 'signing' });
    let hash: `0x${string}` | undefined;
    try {
      hash = await sendCancel({ signer: wallet.signer, contract: contract as `0x${string}`, id: BigInt(s.id), rpc });
      setCancel({ id: s.id, phase: 'pending', hash });
      const c = await waitForCancelled(rpc, hash, contract as `0x${string}`);
      setCancel({ id: s.id, phase: 'done', hash, refund: c.refund });
      wallet.refreshBalance();
      load();
    } catch (err) {
      setCancel({ id: s.id, phase: 'error', hash, message: walletErrorMessage(err) });
    }
  }

  return (
    <>
      <section className="sw-section" aria-labelledby="who-h" style={{ borderTop: 0, paddingTop: 8 }}>
        <h2 className="sb-h3" id="who-h">
          Whose inbox
        </h2>
        <p className="soft" style={{ fontSize: 13.5, margin: '0 0 10px' }}>
          The address that paid for the subscriptions. Everything shown here is public (chain state and the watcher&apos;s feed); the wallet is only needed to
          cancel and to sign a webhook.
        </p>
        <WalletPanel wallet={wallet} faucet={faucet} needWei={null} />
      </section>

      {!contract ? (
        <section className="sw-section">
          <div className="sb-notice">
            <h2>Subscriptions not deployed yet</h2>
            <p>
              CheckSubscriptions has no address on Monad testnet here, so there is nothing to subscribe to or cancel yet. The watcher&apos;s results stay public
              on <a href="/watch">/watch</a> and on every vault page.
            </p>
          </div>
        </section>
      ) : !who ? (
        <section className="sw-section">
          <p className="sb-empty">Choose the paying wallet above to see its subscriptions and alerts.</p>
        </section>
      ) : (
        <>
          <section className="sw-section" aria-labelledby="subs-h">
            <h2 className="sb-h2" id="subs-h">
              My subscriptions
            </h2>
            {data?.error && <p className="sb-blocker">{data.error}</p>}
            {!data ? (
              <p className="sb-empty">{loading ? 'Reading CheckSubscriptions.' : 'Not read yet.'}</p>
            ) : data.active.length === 0 ? (
              <p className="sb-empty">
                No active subscription for {shortAddress(who)}
                {data.ended ? ` (${data.ended} ended or cancelled)` : ''}. Open a vault page and use <strong>Watch this vault</strong>.
              </p>
            ) : (
              <div className="sb-table-scroll">
                <table className="sb-table sw-subs">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Vault</th>
                      <th scope="col">Until</th>
                      <th scope="col" className="r">
                        Paid
                      </th>
                      <th scope="col">Cancel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.active.map((s) => {
                      const refund = toWei(s.refundEstimateWei) ?? 0n;
                      const c = cancel?.id === s.id ? cancel : null;
                      return (
                        <tr key={s.id}>
                          <td className="nowrap">{s.id}</td>
                          <td className="sb-vault-cell">
                            <a href={s.vaultPath} className={s.label.name ? undefined : 'mono'}>
                              {s.label.name ?? shortAddress(s.subject)}
                            </a>
                            <span className="sb-vault-sub">{s.label.protocol ?? <span className="mono">{shortAddress(s.subject)}</span>}</span>
                          </td>
                          <td className="nowrap">
                            {until(s.endsAt)}
                            <span className="sb-vault-sub">
                              {s.days} {s.days === 1 ? 'day' : 'days'} bought
                            </span>
                          </td>
                          <td className="r nowrap">{formatMon(toWei(s.paidWei))}</td>
                          <td>
                            {!c || c.phase === 'error' ? (
                              <>
                                <button
                                  type="button"
                                  className="sb-linkbtn"
                                  onClick={() => setCancel({ id: s.id, phase: 'confirm' })}
                                  disabled={!wallet.signer}
                                >
                                  Cancel
                                </button>
                                {c?.phase === 'error' && (
                                  <span className="sb-status-line" data-tone="error" role="alert" style={{ display: 'block' }}>
                                    {c.message}
                                  </span>
                                )}
                              </>
                            ) : c.phase === 'confirm' ? (
                              <span className="sw-confirm">
                                <span>
                                  About <strong>{formatMon(refund)}</strong> comes back: the days not started. The current day is kept.
                                </span>
                                <button type="button" className="sb-linkbtn" data-tone="danger" onClick={() => doCancel(s)}>
                                  Cancel and refund
                                </button>
                                <button type="button" className="sb-linkbtn" onClick={() => setCancel(null)}>
                                  Keep it
                                </button>
                              </span>
                            ) : (
                              <span className="sw-confirm">
                                {c.phase === 'signing'
                                  ? 'Confirm in the wallet'
                                  : c.phase === 'pending'
                                    ? 'Waiting for Monad testnet'
                                    : `Cancelled, ${formatMon(c.refund ?? 0n)} refunded`}
                                {c.hash && (
                                  <a href={testnetTxUrl(c.hash)} className="mono">
                                    tx {shortHash(c.hash)}
                                  </a>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {cancel?.phase === 'done' && !data?.active.some((s) => s.id === cancel.id) && (
              <p className="sb-status-line">
                Subscription #{cancel.id} cancelled; the Cancelled event refunded {formatMon(cancel.refund ?? 0n)}.{' '}
                {cancel.hash && (
                  <a href={testnetTxUrl(cancel.hash)} className="mono">
                    tx {shortHash(cancel.hash)}
                  </a>
                )}
              </p>
            )}
          </section>

          <section className="sw-section" aria-labelledby="alerts-h">
            <h2 className="sb-h2" id="alerts-h">
              Alerts
            </h2>
            <p className="sb-lede">
              For each active subscription: every change in its vault&apos;s result since it started, the first check after it started, and what was delivered.
              Newest first.
            </p>
            {!data || data.items.length === 0 ? (
              <p className="sb-empty">
                {data?.active.length ? 'Nothing yet. The first check after you subscribed shows up here.' : 'No alerts without an active subscription.'}
              </p>
            ) : (
              <ol className="sw-feed">
                {data.items.map((it) => (
                  <FeedItem
                    key={`${it.subscriptionId}:${it.event.chainId}:${it.event.seq}`}
                    e={it.event}
                    note={`${ITEM_NOTE[it.kind]}, subscription #${it.subscriptionId}`}
                  />
                ))}
              </ol>
            )}
          </section>

          <WebhookForm subscriber={who} current={data?.webhook ?? null} wallet={wallet} rpc={rpc} onSaved={load} />
        </>
      )}
    </>
  );
}

function WebhookForm({
  subscriber,
  current,
  wallet,
  rpc,
  onSaved,
}: {
  subscriber: string;
  current: { origin: string; issued: number } | null;
  wallet: ReturnType<typeof useDeskWallet>;
  rpc: string;
  onSaved: () => void;
}) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<{ phase: 'idle' | 'signing' | 'sending' | 'done' | 'error'; message?: string; signed?: string }>({ phase: 'idle' });
  const demoUrl = typeof window === 'undefined' ? '' : `${window.location.origin}/api/v1/watch/demo-hook`;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!wallet.signer || !url.trim()) return;
    const issued = Math.floor(Date.now() / 1000);
    const target = url.trim();
    let message: string;
    try {
      message = webhookMessage({ subscriber, url: target, issued });
    } catch {
      setState({ phase: 'error', message: 'The subscriber address is not valid.' });
      return;
    }
    setState({ phase: 'signing', signed: message });
    try {
      const signature = await signText(wallet.signer, message, rpc);
      setState({ phase: 'sending', signed: message });
      const r = await fetch('/api/v1/watch/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriber, url: target, issued, signature }),
      });
      const body = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!r.ok || !body.ok) {
        setState({ phase: 'error', message: body.error ?? `The server answered ${r.status}.`, signed: message });
        return;
      }
      setState({ phase: 'done', signed: message });
      onSaved();
    } catch (err) {
      setState({ phase: 'error', message: walletErrorMessage(err), signed: message });
    }
  }

  return (
    <section className="sw-section" aria-labelledby="hook-h">
      <h2 className="sb-h2" id="hook-h">
        Webhook
      </h2>
      <p className="sb-lede">
        The watcher POSTs a JSON alert to this URL for every change on a vault you watch, up to 3 attempts. Registering it is a signature, not a transaction:
        the text below is signed by {shortAddress(subscriber)} and checked by this server, which keeps the latest URL per address and never shows it in full,
        since a webhook URL can be a secret.
      </p>
      <p style={{ fontSize: 14 }}>
        {current ? (
          <>
            Registered: a URL at <span className="mono break">{current.origin}</span>{' '}
            <span className="soft">signed {new Date(current.issued * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC</span>
          </>
        ) : (
          <span className="soft">No webhook registered for this address.</span>
        )}
      </p>
      <form className="sw-form" onSubmit={onSubmit}>
        <label className="vh" htmlFor="hook-url">
          Webhook URL
        </label>
        <input
          id="hook-url"
          type="url"
          inputMode="url"
          placeholder="https://your-server.example/specfirst"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          autoComplete="off"
        />
        <button type="submit" className="sb-action" disabled={!wallet.signer || !url.trim() || state.phase === 'signing' || state.phase === 'sending'}>
          {state.phase === 'signing' ? 'Sign in the wallet' : state.phase === 'sending' ? 'Registering' : 'Sign and register'}
        </button>
      </form>
      <p className="sb-status-line">
        <button type="button" className="sb-linkbtn" onClick={() => setUrl(demoUrl)}>
          Use this site&apos;s demo receiver
        </button>{' '}
        to see a delivery without a server of your own, then watch it arrive on <a href="/watch/demo-hook">the demo receiver page</a>. The URL must be https;
        this server may allow http for localhost only.
      </p>
      {state.signed && <pre className="sw-signed">{state.signed}</pre>}
      <p className="sb-status-line" data-tone={state.phase === 'error' ? 'error' : undefined} role={state.phase === 'error' ? 'alert' : undefined}>
        {state.phase === 'error' ? state.message : state.phase === 'done' ? 'Registered. The watcher uses it from its next alert.' : ''}
      </p>
    </section>
  );
}
