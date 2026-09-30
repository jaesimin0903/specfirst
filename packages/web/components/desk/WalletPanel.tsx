'use client';

import { useState } from 'react';
import { formatMon } from '../../lib/desk/format';
import { shortAddress } from '../../lib/format';
import { testnetAddressUrl } from '../../lib/desk/config';
import { CopyButton } from '../board/CopyButton';
import type { DeskWallet } from './useDeskWallet';

/** Wallet choice: a browser extension, or the testnet burner. Shows who pays and what they hold. */
export function WalletPanel({ wallet, faucet, needWei }: { wallet: DeskWallet; faucet: string; needWei: bigint | null }) {
  const [confirmForget, setConfirmForget] = useState(false);
  const short = wallet.signer && wallet.balanceWei !== null && needWei !== null && wallet.balanceWei < needWei;
  return (
    <div className="sb-wallet">
      <div className="sb-seg" role="group" aria-label="Pay with">
        <button type="button" aria-pressed={wallet.kind === 'injected'} onClick={() => wallet.setKind('injected')}>
          Browser wallet
        </button>
        <button type="button" aria-pressed={wallet.kind === 'burner'} onClick={() => wallet.setKind('burner')}>
          Testnet burner
        </button>
      </div>

      {wallet.kind === 'injected' ? (
        <div className="sb-wallet-card" data-kind="injected">
          {wallet.signer?.kind === 'injected' ? (
            <>
              <p style={{ margin: 0 }}>
                Connected with <strong>{wallet.signer.name}</strong>. The wallet is switched to Monad testnet (10143) when you pay, and asked to add it
                if it does not know it.
              </p>
              <Holder wallet={wallet} short={short} faucet={faucet} />
              <p className="sb-wallet-row">
                <button type="button" className="sb-linkbtn" onClick={wallet.disconnect}>
                  Use another account
                </button>
              </p>
            </>
          ) : wallet.injected.length === 0 ? (
            <p style={{ margin: 0 }}>
              No wallet extension found in this browser. Install MetaMask or Rabby, or switch to the testnet burner above.
            </p>
          ) : (
            <>
              <p style={{ margin: '0 0 10px' }}>Connect the account that pays. Nothing is sent until you press Pay.</p>
              <div className="sb-wallet-list">
                {wallet.injected.map((w) => (
                  <button key={w.id} type="button" className="sb-action" data-kind="quiet" disabled={wallet.busy} onClick={() => wallet.connect(w)}>
                    {/* The icon is a data: URI the wallet itself announced (EIP-6963). */}
                    {w.icon && <img src={w.icon} alt="" />}
                    Connect {w.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="sb-wallet-card" data-kind="burner">
          <p style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="sb-testnet-tag">Testnet only</span>
            <span className="soft" style={{ fontSize: 13.5 }}>
              A key made in this browser and kept in its localStorage. Fine for faucet MON; never send it anything real.
            </span>
          </p>
          {wallet.burner ? (
            <>
              <Holder wallet={wallet} short={short} faucet={faucet} />
              <details className="sb-secret">
                <summary>Show the private key (to move leftover testnet MON into a wallet)</summary>
                <code>{wallet.burner.privateKey}</code>
                <CopyButton text={wallet.burner.privateKey} label="Copy key" />
              </details>
              <p className="sb-wallet-row">
                {confirmForget ? (
                  <>
                    <span style={{ fontSize: 13 }}>Forget this key? Any MON on it is gone unless you copied the key.</span>
                    <button
                      type="button"
                      className="sb-linkbtn"
                      data-tone="danger"
                      onClick={() => {
                        wallet.forgetBurner();
                        setConfirmForget(false);
                      }}
                    >
                      Forget it
                    </button>
                    <button type="button" className="sb-linkbtn" onClick={() => setConfirmForget(false)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button type="button" className="sb-linkbtn" onClick={() => setConfirmForget(true)}>
                    Forget this key
                  </button>
                )}
              </p>
            </>
          ) : (
            <p className="sb-wallet-row">
              <button type="button" className="sb-action" data-kind="quiet" onClick={wallet.createBurner}>
                Create a testnet burner
              </button>
              <span className="soft" style={{ fontSize: 13 }}>
                Then send it MON from the faucet.
              </span>
            </p>
          )}
        </div>
      )}
      {wallet.error && (
        <p className="sb-status-line" data-tone="error" role="alert">
          {wallet.error}
        </p>
      )}
    </div>
  );
}

function Holder({ wallet, short, faucet }: { wallet: DeskWallet; short: boolean | null; faucet: string }) {
  const s = wallet.signer!;
  return (
    <>
      <p className="sb-wallet-row">
        <a className="sb-wallet-addr" href={testnetAddressUrl(s.address)} title={s.address}>
          {shortAddress(s.address)}
        </a>
        <CopyButton text={s.address} label="Copy address" />
        <span>
          <span className="sb-wallet-bal">{wallet.balanceWei === null ? 'Reading balance' : formatMon(wallet.balanceWei)}</span>
          <span className="soft"> on Monad testnet</span>
        </span>
        <button type="button" className="sb-linkbtn" onClick={wallet.refreshBalance}>
          Refresh
        </button>
      </p>
      {short && (
        <p className="sb-status-line" data-tone="error">
          Not enough for the fee and gas.{' '}
          <a href={faucet} target="_blank" rel="noreferrer">
            Get testnet MON from the faucet
          </a>{' '}
          for {shortAddress(s.address)}, then refresh.
        </p>
      )}
      {!short && wallet.signer?.kind === 'burner' && (
        <p className="soft" style={{ fontSize: 13, margin: '8px 0 0' }}>
          <a href={faucet} target="_blank" rel="noreferrer">
            Testnet faucet
          </a>{' '}
          for more MON.
        </p>
      )}
    </>
  );
}
