'use client';

import { useCallback, useEffect, useState } from 'react';
import { getAddress } from 'viem';
import type { SubscriberJson, SubsSummaryJson } from '../../lib/subs/types';
import { DAY_CHOICES } from '../../lib/subs/contract';
import { priceOf } from '../../lib/subs/economics';
import { sendSubscribe, waitForSubscribed } from '../../lib/subs/wallet';
import { formatMon, formatMonAmount, toWei } from '../../lib/desk/format';
import { testnetTxUrl } from '../../lib/desk/config';
import { walletErrorMessage } from '../../lib/desk/wallet';
import { shortHash } from '../../lib/format';
import { useDeskWallet } from '../desk/useDeskWallet';
import { WalletPanel } from '../desk/WalletPanel';

type PayState =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'pending'; hash: `0x${string}` }
  | { phase: 'done'; hash: `0x${string}`; id: string; endsAt: string; days: number }
  | { phase: 'error'; message: string; hash?: `0x${string}` };

/** Gas headroom for subscribe on Monad testnet, only to warn before the wallet does. */
const GAS_HEADROOM_WEI = 10n ** 16n;

export interface WatchBoxProps {
  chainId: number;
  address: string;
  /** NEXT_PUBLIC_SPECFIRST_SUBS_10143; null: not deployed yet. */
  contract: string | null;
  rpc: string;
  faucet: string;
}

function untilText(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * "Watch this vault" on a vault page: pay CheckSubscriptions per day, with the desk's wallet choice (the testnet
 * burner or an extension), for alerts when this vault's result changes and a faster re-check cadence.
 */
export function WatchBox({ chainId, address, contract, rpc, faucet }: WatchBoxProps) {
  const wallet = useDeskWallet(rpc);
  const [summary, setSummary] = useState<SubsSummaryJson | null>(null);
  const [days, setDays] = useState<number>(7);
  const [mine, setMine] = useState<SubscriberJson | null>(null);
  const [pay, setPay] = useState<PayState>({ phase: 'idle' });
  const signer = wallet.signer?.address ?? null;

  useEffect(() => {
    if (!contract) return;
    let stop = false;
    fetch('/api/v1/watch/subs', { cache: 'no-store' })
      .then((r) => r.json() as Promise<SubsSummaryJson>)
      .then((s) => !stop && setSummary(s))
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [contract]);

  const loadMine = useCallback(() => {
    if (!contract || !signer) {
      setMine(null);
      return;
    }
    fetch(`/api/v1/watch/subs/${signer}`, { cache: 'no-store' })
      .then((r) => r.json() as Promise<SubscriberJson>)
      .then(setMine)
      .catch(() => {});
  }, [contract, signer]);
  useEffect(loadMine, [loadMine]);

  const here = (mine?.subscriptions ?? []).filter((x) => x.active && x.subjectChainId === chainId && x.subject.toLowerCase() === address.toLowerCase());
  const fee = toWei(summary?.feePerDayWei);
  const total = fee !== null ? priceOf(fee, days) : null;
  const funded = wallet.balanceWei === null || total === null || wallet.balanceWei >= total;
  const busy = pay.phase === 'signing' || pay.phase === 'pending';
  const canPay = Boolean(contract) && total !== null && wallet.signer !== null && funded && !busy;

  async function onPay() {
    if (!canPay || !contract || total === null || !wallet.signer) return;
    setPay({ phase: 'signing' });
    let hash: `0x${string}` | undefined;
    try {
      hash = await sendSubscribe({
        signer: wallet.signer,
        contract: contract as `0x${string}`,
        subjectChainId: chainId,
        subject: getAddress(address),
        days,
        valueWei: total,
        rpc,
      });
      setPay({ phase: 'pending', hash });
      const s = await waitForSubscribed(rpc, hash, contract as `0x${string}`);
      setPay({ phase: 'done', hash, id: s.id.toString(), endsAt: new Date(Number(s.endsAt) * 1000).toISOString(), days: s.days });
      wallet.refreshBalance();
      loadMine();
    } catch (err) {
      setPay({ phase: 'error', message: walletErrorMessage(err), hash });
    }
  }

  return (
    <section className="sw-box" aria-labelledby="watchbox-h">
      <h2 className="sb-h3" id="watchbox-h">
        Watch this vault
      </h2>
      <p className="soft" style={{ fontSize: 13.5, margin: 0 }}>
        Pay per day for an alert when this vault&apos;s result changes, in your inbox and at your webhook if you register one, and for a shorter re-check
        cadence (the watcher&apos;s default is every 60 minutes for subscribed vaults, at most once a day for the rest). Every result stays public either way; a
        subscription buys delivery and freshness.
      </p>
      {!contract ? (
        <div className="sb-notice" style={{ marginTop: 12 }}>
          <p style={{ margin: 0 }}>
            <strong>Not deployed yet.</strong> CheckSubscriptions has no address on Monad testnet here, so nothing can be paid. The watcher still checks this
            vault on its own schedule.
          </p>
        </div>
      ) : (
        <>
          <p style={{ margin: '12px 0 0', fontSize: 14 }}>
            {fee !== null ? (
              <>
                <strong>{formatMon(fee)}</strong> a day on Monad testnet, paid upfront. Cancel any time: the days not started yet come back.
              </>
            ) : summary ? (
              'Could not read the fee from the contract. Reload in a moment.'
            ) : (
              'Reading the fee.'
            )}
          </p>
          {here.length > 0 && (
            <p className="sw-have">
              You watch this vault until {untilText(here[0]!.endsAt)} (subscription #{here[0]!.id}). <a href="/watch/inbox">Inbox</a>
            </p>
          )}
          <div className="sb-seg" role="group" aria-label="How long">
            {DAY_CHOICES.map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} disabled={busy}>
                {d} {d === 1 ? 'day' : 'days'}
                {fee !== null && <span className="soft num">{formatMonAmount(priceOf(fee, d))}</span>}
              </button>
            ))}
          </div>
          <WalletPanel wallet={wallet} faucet={faucet} needWei={total !== null ? total + GAS_HEADROOM_WEI : null} />
          <p style={{ marginTop: 12 }}>
            <button type="button" className="sb-action" data-size="big" disabled={!canPay} onClick={onPay} aria-describedby="watch-pay-hint">
              {pay.phase === 'signing'
                ? 'Confirm in the wallet'
                : pay.phase === 'pending'
                  ? 'Waiting for Monad testnet'
                  : total !== null
                    ? `Pay ${formatMon(total)} for ${days} ${days === 1 ? 'day' : 'days'}`
                    : 'Pay and watch'}
            </button>
          </p>
          <p
            id="watch-pay-hint"
            className="sb-status-line"
            data-tone={pay.phase === 'error' ? 'error' : undefined}
            role={pay.phase === 'error' ? 'alert' : undefined}
          >
            {pay.phase === 'error'
              ? pay.message
              : pay.phase === 'done'
                ? `Subscription #${pay.id} runs ${pay.days} ${pay.days === 1 ? 'day' : 'days'}, until ${untilText(pay.endsAt)}.`
                : pay.phase === 'pending'
                  ? 'Sent. The subscription id comes from the Subscribed event once the block lands.'
                  : !wallet.signer
                    ? wallet.kind === 'burner'
                      ? 'Create the burner and fund it first.'
                      : 'Connect a wallet first.'
                    : !funded
                      ? 'The paying address holds less than the price.'
                      : `subscribe(${chainId}, ${address.slice(0, 8)}..., erc4626, ${days}) with ${total !== null ? formatMonAmount(total) : 'the'} MON attached.`}
          </p>
          {pay.phase === 'done' && (
            <p className="sb-status-line">
              <a href="/watch/inbox">Open your inbox</a> to see alerts and add a webhook.
            </p>
          )}
          {'hash' in pay && pay.hash && (
            <p className="sb-status-line">
              <a href={testnetTxUrl(pay.hash)} className="mono">
                tx {shortHash(pay.hash)}
              </a>
            </p>
          )}
        </>
      )}
    </section>
  );
}
