import { checkAttestationRegistryAbi, standardIdOf } from '@specfirst/core';
import { checkSubscriptionsAbi } from '@specfirst/core/subs';
import { createPublicClient, defineChain, http, type Address, type Hex } from 'viem';
import { within } from './api.js';
import { ATTEST_CHAIN_ID } from './config.js';

/*
 * Read-only views of Monad testnet: CheckAttestationRegistry (ADR 0004) and CheckSubscriptions (ADR 0006), with the
 * ABIs bundled in @specfirst/core. Only eth_chainId and eth_call go out; there is no wallet and no key.
 */

export const ERC4626_STANDARD_ID: Hex = standardIdOf('erc4626');
export const ATTESTATION_STATUS = ['None', 'Valid', 'Superseded', 'Revoked'] as const;
export type AttestationStatusName = (typeof ATTESTATION_STATUS)[number];

/** The registry's latest attestation of one subject, as read on chain. */
export interface ChainAttestation {
  id: bigint;
  subjectChainId: bigint;
  subject: Address;
  blockNumber: bigint;
  implementationKey: Hex;
  subjectCodeHash: Hex;
  suiteHash: Hex;
  reportHash: Hex;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  notApplicableCount: number;
  passedBitmap: bigint;
  failedBitmap: bigint;
  issuedAt: bigint;
  issuer: Address;
  status: AttestationStatusName;
  reportURI: string;
}

export type LatestRead =
  | { read: 'ok'; attestation: ChainAttestation; isCompliant: boolean; issuerCurrent: boolean | null }
  | { read: 'none' }
  | { read: 'unread'; reason: string };

export type FeeRead = { read: 'ok'; feePerDayWei: bigint } | { read: 'unread'; reason: string };

export interface ChainReader {
  latest(subjectChainId: number, subject: Address): Promise<LatestRead>;
  feePerDay(): Promise<FeeRead>;
}

/** True when the error (or one it wraps) is the custom error `name`. */
export function revertedWith(err: unknown, name: string): boolean {
  let e: unknown = err;
  for (let depth = 0; e && typeof e === 'object' && depth < 8; depth++) {
    const x = e as { data?: { errorName?: string }; errorName?: string; cause?: unknown };
    if (x.data?.errorName === name || x.errorName === name) return true;
    e = x.cause;
  }
  return false;
}

export function readError(err: unknown): string {
  const e = err as { shortMessage?: string; message?: string };
  const msg = (e?.shortMessage ?? e?.message ?? String(err)).split('\n')[0]!;
  return msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;
}

type RawAttestation = Omit<ChainAttestation, 'id' | 'status'> & { status: number };

const monadTestnet = defineChain({
  id: ATTEST_CHAIN_ID,
  name: 'Monad Testnet',
  nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

export function createChainReader(o: { rpcUrl: string; registry: Address; subscriptions: Address; timeoutMs: number }): ChainReader {
  // ccipRead off: an OffchainLookup revert must not make this process fetch a URL the RPC chose (EIP-3668).
  const client = createPublicClient({ chain: monadTestnet, transport: http(o.rpcUrl, { timeout: o.timeoutMs, retryCount: 1 }), ccipRead: false });
  // All reads of one answer share a deadline, so a slow RPC ends in "unread" rather than in a host's tool timeout.
  const deadline = 2 * o.timeoutMs;
  let chainChecked: Promise<void> | null = null;

  // A misconfigured RPC (mainnet, say) would answer "no attestation" for everything; refuse it instead.
  function checkChain(): Promise<void> {
    chainChecked ??= client.getChainId().then((id) => {
      if (id !== ATTEST_CHAIN_ID) throw new Error(`the RPC serves chain ${id}, not Monad testnet ${ATTEST_CHAIN_ID}`);
    });
    return chainChecked.catch((err) => {
      chainChecked = null;
      throw err;
    });
  }

  async function latest(subjectChainId: number, subject: Address): Promise<LatestRead> {
    await checkChain();
    const args = [BigInt(subjectChainId), subject, ERC4626_STANDARD_ID] as const;
    let id: bigint;
    let raw: RawAttestation;
    try {
      [id, raw] = (await client.readContract({ address: o.registry, abi: checkAttestationRegistryAbi, functionName: 'latest', args } as never)) as unknown as [bigint, RawAttestation];
    } catch (err) {
      if (revertedWith(err, 'NoAttestation')) return { read: 'none' };
      throw err;
    }
    const [compliant, issuer] = await Promise.allSettled([
      client.readContract({ address: o.registry, abi: checkAttestationRegistryAbi, functionName: 'isCompliant', args } as never) as Promise<boolean>,
      client.readContract({ address: o.registry, abi: checkAttestationRegistryAbi, functionName: 'isIssuer', args: [raw.issuer] } as never) as Promise<boolean>,
    ]);
    // isCompliant is the one answer a contract would act on; without it the read is not complete.
    if (compliant.status === 'rejected') return { read: 'unread', reason: `isCompliant: ${readError(compliant.reason)}` };
    const attestation: ChainAttestation = {
      ...raw,
      id,
      passCount: Number(raw.passCount),
      failCount: Number(raw.failCount),
      inconclusiveCount: Number(raw.inconclusiveCount),
      notApplicableCount: Number(raw.notApplicableCount),
      status: ATTESTATION_STATUS[raw.status] ?? 'None',
    };
    return { read: 'ok', attestation, isCompliant: compliant.value, issuerCurrent: issuer.status === 'fulfilled' ? issuer.value : null };
  }

  return {
    async latest(subjectChainId, subject) {
      try {
        return await within(latest(subjectChainId, subject), deadline);
      } catch (err) {
        return { read: 'unread', reason: readError(err) };
      }
    },
    async feePerDay() {
      const read = async () => {
        await checkChain();
        return (await client.readContract({ address: o.subscriptions, abi: checkSubscriptionsAbi, functionName: 'feePerDay', args: [] } as never)) as bigint;
      };
      try {
        return { read: 'ok', feePerDayWei: await within(read(), deadline) };
      } catch (err) {
        return { read: 'unread', reason: readError(err) };
      }
    },
  };
}
