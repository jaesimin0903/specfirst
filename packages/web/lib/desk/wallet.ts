import { createPublicClient, createWalletClient, custom, decodeEventLog, http, type EIP1193Provider, type Log, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnetChain } from './chains';
import { checkRequestDeskAbi } from './contract';
import { addChainParams, DESK_CHAIN_ID, STANDARD_ID, SUBJECT_CHAIN_ID } from './config';

/*
 * Browser side of paying the desk, with viem only: an injected EIP-1193 wallet (found through EIP-6963 when the
 * extension announces itself, window.ethereum otherwise) or the testnet burner key. No wallet library.
 */

export interface InjectedWallet {
  id: string;
  name: string;
  icon: string | null;
  provider: EIP1193Provider;
}

export type DeskSigner =
  | { kind: 'injected'; address: `0x${string}`; provider: EIP1193Provider; name: string }
  | { kind: 'burner'; address: `0x${string}`; privateKey: `0x${string}` };

function chainFor(rpc: string) {
  return monadTestnetChain(rpc);
}

export function browserPublicClient(rpc: string): PublicClient {
  return createPublicClient({ chain: chainFor(rpc), transport: http(rpc, { retryCount: 3, retryDelay: 800 }) }) as PublicClient;
}

interface Eip6963Detail {
  info: { uuid: string; name: string; icon?: string; rdns?: string };
  provider: EIP1193Provider;
}

/** Collects wallets that announce themselves (EIP-6963), plus window.ethereum as a fallback. Returns a stop function. */
export function discoverInjected(onChange: (wallets: InjectedWallet[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const found = new Map<string, InjectedWallet>();
  const emit = () => {
    const list = [...found.values()];
    const legacy = (window as unknown as { ethereum?: EIP1193Provider & { isMetaMask?: boolean; isRabby?: boolean } }).ethereum;
    if (list.length === 0 && legacy) list.push({ id: 'window.ethereum', name: legacy.isRabby ? 'Rabby' : legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', icon: null, provider: legacy });
    onChange(list);
  };
  const onAnnounce = (e: Event) => {
    const d = (e as CustomEvent<Eip6963Detail>).detail;
    if (!d?.info?.uuid || !d.provider) return;
    found.set(d.info.rdns ?? d.info.uuid, { id: d.info.rdns ?? d.info.uuid, name: d.info.name, icon: d.info.icon ?? null, provider: d.provider });
    emit();
  };
  window.addEventListener('eip6963:announceProvider', onAnnounce);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  emit();
  return () => window.removeEventListener('eip6963:announceProvider', onAnnounce);
}

export async function connectInjected(provider: EIP1193Provider): Promise<`0x${string}`> {
  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.[0]) throw new Error('The wallet returned no account.');
  return accounts[0] as `0x${string}`;
}

/** Switches the wallet to Monad testnet, adding the chain first when the wallet does not know it (error 4902). */
export async function ensureTestnet(provider: EIP1193Provider, rpc: string): Promise<void> {
  const hex = `0x${DESK_CHAIN_ID.toString(16)}` as `0x${string}`;
  const current = (await provider.request({ method: 'eth_chainId' })) as string;
  if (current?.toLowerCase() === hex) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] });
  } catch (err) {
    const code = (err as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (err as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902 && !/unrecognized|not added|unknown chain/i.test(String((err as Error).message))) throw err;
    await provider.request({ method: 'wallet_addEthereumChain', params: [addChainParams(rpc)] });
  }
}

function walletClientFor(signer: DeskSigner, rpc: string) {
  return signer.kind === 'injected'
    ? createWalletClient({ account: signer.address, chain: chainFor(rpc), transport: custom(signer.provider) })
    : createWalletClient({ account: privateKeyToAccount(signer.privateKey), chain: chainFor(rpc), transport: http(rpc) });
}

/** Simulates, then sends requestCheck(143, subject, erc4626) with the fee as value. Returns the tx hash. */
export async function sendRequestCheck(o: { signer: DeskSigner; desk: `0x${string}`; subject: `0x${string}`; feeWei: bigint; rpc: string }): Promise<`0x${string}`> {
  if (o.signer.kind === 'injected') await ensureTestnet(o.signer.provider, o.rpc);
  const pub = browserPublicClient(o.rpc);
  const wallet = walletClientFor(o.signer, o.rpc);
  const { request } = await pub.simulateContract({
    account: wallet.account!,
    address: o.desk,
    abi: checkRequestDeskAbi,
    functionName: 'requestCheck',
    args: [BigInt(SUBJECT_CHAIN_ID), o.subject, STANDARD_ID],
    value: o.feeWei,
  });
  return wallet.writeContract(request);
}

export async function sendRefund(o: { signer: DeskSigner; desk: `0x${string}`; id: bigint; rpc: string }): Promise<`0x${string}`> {
  if (o.signer.kind === 'injected') await ensureTestnet(o.signer.provider, o.rpc);
  const pub = browserPublicClient(o.rpc);
  const wallet = walletClientFor(o.signer, o.rpc);
  const { request } = await pub.simulateContract({ account: wallet.account!, address: o.desk, abi: checkRequestDeskAbi, functionName: 'refundExpired', args: [o.id] });
  return wallet.writeContract(request);
}

/** The id in the desk's CheckRequested log of a receipt; null when the receipt has none. */
export function requestIdFromLogs(logs: ReadonlyArray<Pick<Log, 'address' | 'data' | 'topics'>>, desk: string): bigint | null {
  for (const log of logs) {
    if (log.address.toLowerCase() !== desk.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: checkRequestDeskAbi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName === 'CheckRequested') return ev.args.id;
    } catch {
      // Another event of the desk.
    }
  }
  return null;
}

export async function waitForRequestId(rpc: string, hash: `0x${string}`, desk: `0x${string}`): Promise<bigint> {
  const receipt = await browserPublicClient(rpc).waitForTransactionReceipt({ hash, pollingInterval: 1_500, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error('The transaction reverted onchain; no fee was taken.');
  const id = requestIdFromLogs(receipt.logs, desk);
  if (id === null) throw new Error('The transaction went through but carried no CheckRequested event.');
  return id;
}

/** A sentence for a wallet or RPC error, without the stack viem attaches. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string; code?: number; name?: string; cause?: unknown };
  if (e?.code === 4001 || e?.name === 'UserRejectedRequestError' || /user rejected|denied/i.test(String(e?.message))) return 'You declined in the wallet. Nothing was sent.';
  if (/insufficient funds/i.test(String(e?.message ?? e?.shortMessage))) return 'Not enough testnet MON for the fee and gas. Top the address up from the faucet.';
  const text = String(e?.shortMessage ?? e?.message ?? err ?? 'unknown error');
  return text.split('\n')[0]!.replace(/https?:\/\/\S+/g, '<rpc>').slice(0, 240);
}
