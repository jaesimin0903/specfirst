'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAddress } from 'viem';
import type { PrecheckResult } from '../../lib/desk/precheck';
import type { DeskSummaryJson } from '../../lib/desk/types';
import { formatMon, formatMonAmount, toWei } from '../../lib/desk/format';
import { testnetTxUrl } from '../../lib/desk/config';
import { sendRequestCheck, waitForRequestId, walletErrorMessage } from '../../lib/desk/wallet';
import { rememberRequestTx } from '../../lib/desk/txMemory';
import { shortHash } from '../../lib/format';
import { useDeskWallet } from './useDeskWallet';
import { WalletPanel } from './WalletPanel';
import { PrecheckCard } from './PrecheckCard';
import { Receipt } from './Receipt';

type PayState =
  | { phase: 'idle' }
  | { phase: 'signing' }
  | { phase: 'pending'; hash: `0x${string}` }
  | { phase: 'done'; hash: `0x${string}`; id: string }
  | { phase: 'error'; message: string; hash?: `0x${string}` };

/** Rough gas headroom for requestCheck on Monad testnet, only to warn before the wallet does. */
const GAS_HEADROOM_WEI = 10n ** 16n;

export interface CheckFlowProps {
  deskAddress: string | null;
  rpc: string;
  faucet: string;
  initialVault: string;
  exampleVault: string | null;
}

export function CheckFlow({ deskAddress, rpc, faucet, initialVault, exampleVault }: CheckFlowProps) {
  const router = useRouter();
  const wallet = useDeskWallet(rpc);
  const [summary, setSummary] = useState<DeskSummaryJson | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [input, setInput] = useState(initialVault);
  const [pre, setPre] = useState<PrecheckResult | null>(null);
  const [preLoading, setPreLoading] = useState(false);
  const [preError, setPreError] = useState<string | null>(null);
  const [pay, setPay] = useState<PayState>({ phase: 'idle' });
  const lastLooked = useRef<string>('');

  useEffect(() => {
    let stop = false;
    fetch('/api/desk', { cache: 'no-store' })
      .then((r) => r.json())
      .then((s: DeskSummaryJson) => !stop && setSummary(s))
      .catch(() => !stop && setSummary(null))
      .finally(() => !stop && setSummaryLoading(false));
    return () => {
      stop = true;
    };
  }, []);

  const lookUp = useCallback(async (value: string) => {
    const v = value.trim();
    if (!v) return;
    lastLooked.current = v.toLowerCase();
    setPreLoading(true);
    setPreError(null);
    try {
      const res = await fetch(`/api/check/precheck?chainId=143&address=${encodeURIComponent(v)}`, { cache: 'no-store' });
      const body = (await res.json()) as PrecheckResult;
      if (lastLooked.current === v.toLowerCase()) setPre(body);
    } catch {
      setPreError('The pre-check did not answer. Try again in a moment.');
    } finally {
      setPreLoading(false);
    }
  }, []);

  // A pasted or linked address is looked up without a click.
  useEffect(() => {
    const v = input.trim();
    if (!isAddress(v, { strict: false }) || v.toLowerCase() === lastLooked.current) return;
    const t = window.setTimeout(() => lookUp(v), 300);
    return () => window.clearTimeout(t);
  }, [input, lookUp]);

  const fee = toWei(summary?.feeWei);
  const desk = (summary?.address ?? deskAddress) as `0x${string}` | null;
  const deployed = Boolean(desk) && (summary?.deployed ?? Boolean(deskAddress));
  const vaultReady = Boolean(pre?.ok && pre.address && pre.input.toLowerCase() === input.trim().toLowerCase());
  const need = fee !== null ? fee + GAS_HEADROOM_WEI : null;
  const funded = wallet.balanceWei === null || need === null || wallet.balanceWei >= fee!;
  const busy = pay.phase === 'signing' || pay.phase === 'pending' || pay.phase === 'done';
  const canPay = deployed && fee !== null && vaultReady && wallet.signer !== null && funded && !busy;

  async function onPay() {
    if (!canPay || !desk || fee === null || !pre?.address || !wallet.signer) return;
    setPay({ phase: 'signing' });
    let hash: `0x${string}` | undefined;
    try {
      hash = await sendRequestCheck({ signer: wallet.signer, desk, subject: pre.address, feeWei: fee, rpc });
      setPay({ phase: 'pending', hash });
      const id = await waitForRequestId(rpc, hash, desk);
      rememberRequestTx(desk, id.toString(), hash);
      setPay({ phase: 'done', hash, id: id.toString() });
      router.push(`/check/${id}?tx=${hash}`);
    } catch (err) {
      setPay({ phase: 'error', message: walletErrorMessage(err), hash });
    }
  }

  const payLabel =
    pay.phase === 'signing'
      ? 'Confirm in the wallet'
      : pay.phase === 'pending'
        ? 'Waiting for Monad testnet'
        : pay.phase === 'done'
          ? `Request #${pay.id} made, opening it`
          : fee !== null
            ? `Pay ${formatMon(fee)} and request the check`
            : 'Pay and request the check';

  const payHint = !deployed
    ? 'The desk is not deployed on Monad testnet yet, so paying is closed. Look-ups still work.'
    : fee === null
      ? summaryLoading
        ? 'Reading the fee from the desk.'
        : 'Could not read the fee from the desk. Reload in a moment.'
      : !vaultReady
        ? 'Look a vault up first.'
        : !wallet.signer
          ? wallet.kind === 'burner'
            ? 'Create the burner and fund it first.'
            : 'Connect a wallet first.'
          : !funded
            ? `The paying address holds less than the ${formatMon(fee)} fee.`
            : `requestCheck(143, ${pre!.address!.slice(0, 8)}..., erc4626) with ${formatMonAmount(fee)} MON attached.`;

  return (
    <div className="sb-check">
      <ol className="sb-steps">
        <li data-state="open">
          <div>
            <h2>
              The vault <small>ERC-4626 on Monad mainnet</small>
            </h2>
            <form
              className="sb-addr-form"
              onSubmit={(e) => {
                e.preventDefault();
                lookUp(input);
              }}
            >
              <label className="vh" htmlFor="vault-address">
                Vault address on Monad mainnet
              </label>
              <input
                id="vault-address"
                name="vault"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="0x... vault address"
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                aria-invalid={pre && !pre.address && pre.input === input.trim() ? true : undefined}
              />
              <button type="submit" className="sb-action" data-kind="quiet" disabled={preLoading || !input.trim()}>
                {preLoading ? 'Looking up' : 'Look up'}
              </button>
            </form>
            {preError && (
              <p className="sb-status-line" data-tone="error">
                {preError}
              </p>
            )}
            {pre && pre.input.toLowerCase() === input.trim().toLowerCase() && <PrecheckCard p={pre} />}
            {!pre && !preLoading && (
              <p className="sb-status-line">Reads only: code, asset(), name and symbol on Monad mainnet, and what this site already has on the vault.</p>
            )}
          </div>
        </li>
        <li data-state="open">
          <div>
            <h2>
              Who pays <small>Monad testnet, chain 10143</small>
            </h2>
            <WalletPanel wallet={wallet} faucet={faucet} needWei={need} />
          </div>
        </li>
        <li data-state={canPay || busy ? 'open' : 'locked'}>
          <div>
            <h2>Pay and request</h2>
            <button type="button" className="sb-action" data-size="big" disabled={!canPay} onClick={onPay} aria-describedby="pay-hint">
              {payLabel}
            </button>
            <p id="pay-hint" className="sb-status-line" data-tone={pay.phase === 'error' ? 'error' : undefined} role={pay.phase === 'error' ? 'alert' : undefined}>
              {pay.phase === 'error' ? pay.message : pay.phase === 'pending' ? 'Sent. The request id comes from the CheckRequested event once the block lands.' : payHint}
            </p>
            {'hash' in pay && pay.hash && (
              <p className="sb-status-line">
                <a href={testnetTxUrl(pay.hash)} className="mono">
                  tx {shortHash(pay.hash)}
                </a>
              </p>
            )}
          </div>
        </li>
      </ol>
      <Receipt summary={summary} loading={summaryLoading} example={exampleVault} />
    </div>
  );
}
