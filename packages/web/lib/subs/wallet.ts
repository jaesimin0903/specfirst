import { decodeEventLog, type Log } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { STANDARD_ID } from '../desk/config';
import { browserPublicClient, ensureTestnet, walletClientFor, type DeskSigner } from '../desk/wallet';
import { checkSubscriptionsAbi } from './contract';

/*
 * Browser side of subscriptions: pay subscribe, cancel, and sign the webhook registration, with the desk's
 * signer (an injected wallet or the testnet burner). Every write is simulated first, so a revert shows before
 * the wallet asks for anything.
 */

export async function sendSubscribe(o: {
  signer: DeskSigner;
  contract: `0x${string}`;
  subjectChainId: number;
  subject: `0x${string}`;
  days: number;
  valueWei: bigint;
  rpc: string;
}): Promise<`0x${string}`> {
  if (o.signer.kind === 'injected') await ensureTestnet(o.signer.provider, o.rpc);
  const pub = browserPublicClient(o.rpc);
  const wallet = walletClientFor(o.signer, o.rpc);
  const { request } = await pub.simulateContract({
    account: wallet.account!,
    address: o.contract,
    abi: checkSubscriptionsAbi,
    functionName: 'subscribe',
    args: [BigInt(o.subjectChainId), o.subject, STANDARD_ID, o.days],
    value: o.valueWei,
  });
  return wallet.writeContract(request);
}

export async function sendCancel(o: { signer: DeskSigner; contract: `0x${string}`; id: bigint; rpc: string }): Promise<`0x${string}`> {
  if (o.signer.kind === 'injected') await ensureTestnet(o.signer.provider, o.rpc);
  const pub = browserPublicClient(o.rpc);
  const wallet = walletClientFor(o.signer, o.rpc);
  const { request } = await pub.simulateContract({ account: wallet.account!, address: o.contract, abi: checkSubscriptionsAbi, functionName: 'cancel', args: [o.id] });
  return wallet.writeContract(request);
}

type LogLike = Pick<Log, 'address' | 'data' | 'topics'>;

function decoded(logs: ReadonlyArray<LogLike>, contract: string) {
  return logs.flatMap((log) => {
    if (log.address.toLowerCase() !== contract.toLowerCase()) return [];
    try {
      return [decodeEventLog({ abi: checkSubscriptionsAbi, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] })];
    } catch {
      return [];
    }
  });
}

/** The Subscribed event of a receipt: id, end and amount paid; null when the receipt has none. */
export function subscribedFromLogs(logs: ReadonlyArray<LogLike>, contract: string): { id: bigint; endsAt: bigint; paid: bigint; days: number } | null {
  for (const ev of decoded(logs, contract)) {
    if (ev.eventName === 'Subscribed') return { id: ev.args.id, endsAt: ev.args.endsAt, paid: ev.args.paid, days: ev.args.days_ };
  }
  return null;
}

/** The Cancelled event's refund; null when the receipt has none. */
export function cancelledFromLogs(logs: ReadonlyArray<LogLike>, contract: string): { id: bigint; refund: bigint } | null {
  for (const ev of decoded(logs, contract)) {
    if (ev.eventName === 'Cancelled') return { id: ev.args.id, refund: ev.args.refund };
  }
  return null;
}

async function receiptLogs(rpc: string, hash: `0x${string}`) {
  const receipt = await browserPublicClient(rpc).waitForTransactionReceipt({ hash, pollingInterval: 1_500, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error('The transaction reverted onchain; nothing was charged but gas.');
  return receipt.logs;
}

export async function waitForSubscribed(rpc: string, hash: `0x${string}`, contract: `0x${string}`) {
  const s = subscribedFromLogs(await receiptLogs(rpc, hash), contract);
  if (!s) throw new Error('The transaction went through but carried no Subscribed event.');
  return s;
}

export async function waitForCancelled(rpc: string, hash: `0x${string}`, contract: `0x${string}`) {
  const c = cancelledFromLogs(await receiptLogs(rpc, hash), contract);
  if (!c) throw new Error('The transaction went through but carried no Cancelled event.');
  return c;
}

/** EIP-191 personal_sign of `message` by the signer. */
export async function signText(signer: DeskSigner, message: string, rpc: string): Promise<`0x${string}`> {
  if (signer.kind === 'burner') return privateKeyToAccount(signer.privateKey).signMessage({ message });
  const wallet = walletClientFor(signer, rpc);
  return wallet.signMessage({ account: signer.address, message });
}
