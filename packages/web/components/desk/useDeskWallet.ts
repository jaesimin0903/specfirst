'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EIP1193Provider } from 'viem';
import { browserStorage, ensureBurner, forgetBurner, readBurner, type StoredBurner } from '../../lib/desk/burner';
import { browserPublicClient, connectInjected, discoverInjected, walletErrorMessage, type DeskSigner, type InjectedWallet } from '../../lib/desk/wallet';

export type WalletKind = 'injected' | 'burner';
const KIND_KEY = 'specfirst:wallet-kind';

export interface DeskWallet {
  kind: WalletKind;
  setKind(k: WalletKind): void;
  injected: InjectedWallet[];
  signer: DeskSigner | null;
  busy: boolean;
  error: string | null;
  connect(w: InjectedWallet): Promise<void>;
  disconnect(): void;
  burner: StoredBurner | null;
  storageAvailable: boolean;
  createBurner(): void;
  forgetBurner(): void;
  balanceWei: bigint | null;
  refreshBalance(): void;
}

/**
 * The payer for the desk pages: an injected wallet or the testnet burner. The choice and the burner key live in
 * localStorage; an injected wallet is remembered by the wallet itself (eth_accounts on load).
 */
export function useDeskWallet(rpc: string): DeskWallet {
  const [kind, setKindState] = useState<WalletKind>('injected');
  const [injected, setInjected] = useState<InjectedWallet[]>([]);
  const [account, setAccount] = useState<{ address: `0x${string}`; wallet: InjectedWallet } | null>(null);
  const [burner, setBurner] = useState<StoredBurner | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balanceWei, setBalance] = useState<bigint | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const storage = browserStorage();
    setStorageAvailable(storage !== null);
    const b = readBurner(storage);
    setBurner(b);
    let saved: string | null = null;
    try {
      saved = storage?.getItem(KIND_KEY) ?? null;
    } catch {
      saved = null;
    }
    if (saved === 'burner' || saved === 'injected') setKindState(saved);
    return discoverInjected(setInjected);
  }, []);

  // A wallet the user connected before answers eth_accounts without a prompt.
  useEffect(() => {
    if (account || injected.length === 0) return;
    let stop = false;
    (async () => {
      for (const w of injected) {
        try {
          const accounts = (await w.provider.request({ method: 'eth_accounts' })) as string[];
          if (!stop && accounts?.[0]) {
            setAccount({ address: accounts[0] as `0x${string}`, wallet: w });
            return;
          }
        } catch {
          // Locked or refused: wait for a click.
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [injected, account]);

  useEffect(() => {
    const p = account?.wallet.provider as (EIP1193Provider & { removeListener?: (e: string, f: (...a: unknown[]) => void) => void }) | undefined;
    if (!p?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const list = args[0] as string[] | undefined;
      setAccount((cur) => (list?.[0] && cur ? { ...cur, address: list[0] as `0x${string}` } : null));
    };
    p.on('accountsChanged', onAccounts as never);
    return () => p.removeListener?.('accountsChanged', onAccounts);
  }, [account?.wallet]);

  const setKind = useCallback((k: WalletKind) => {
    setKindState(k);
    setError(null);
    try {
      browserStorage()?.setItem(KIND_KEY, k);
    } catch {
      // The choice lasts for this page only.
    }
  }, []);

  const signer: DeskSigner | null = useMemo(() => {
    if (kind === 'burner') return burner ? { kind: 'burner', address: burner.address, privateKey: burner.privateKey } : null;
    return account ? { kind: 'injected', address: account.address, provider: account.wallet.provider, name: account.wallet.name } : null;
  }, [kind, burner, account]);

  useEffect(() => {
    setBalance(null);
    if (!signer) return;
    let stop = false;
    const client = browserPublicClient(rpc);
    const load = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const b = await client.getBalance({ address: signer.address });
        if (!stop) setBalance(b);
      } catch {
        // Keep the last value; the RPC may be rate limiting.
      }
    };
    load();
    const t = window.setInterval(load, 10_000);
    return () => {
      stop = true;
      window.clearInterval(t);
    };
  }, [signer?.address, rpc, tick]);

  return {
    kind,
    setKind,
    injected,
    signer,
    busy,
    error,
    async connect(w) {
      setBusy(true);
      setError(null);
      try {
        setAccount({ address: await connectInjected(w.provider), wallet: w });
      } catch (err) {
        setError(walletErrorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    disconnect() {
      setAccount(null);
    },
    burner,
    storageAvailable,
    createBurner() {
      setError(null);
      const storage = browserStorage();
      if (!storage) {
        setError('This browser blocks localStorage, so a burner key would be lost on reload. Use a wallet extension.');
        return;
      }
      try {
        setBurner(ensureBurner(storage));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    forgetBurner() {
      forgetBurner(browserStorage());
      setBurner(null);
    },
    balanceWei,
    refreshBalance() {
      setTick((n) => n + 1);
    },
  };
}
