import type { Address, Hex, PublicClient } from 'viem';
import certificateRegistryAbi from './abi/CertificateRegistry.json' with { type: 'json' };

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Mirrors the on-chain `enum Status { None, Valid, Superseded, Revoked }` (docs/plan.md 3.4). */
export const ON_CHAIN_STATUS = ['None', 'Valid', 'Superseded', 'Revoked'] as const;

/**
 * App-level display status, derived from the on-chain Certificate plus codeMatches/isLatest.
 * Not an on-chain enum value: `partial` and `none` are computed here, matching the four states
 * (plus "no certificate") shown on the certificate page and described in docs/plan.md 3.10's
 * REST response ("valid|superseded|revoked|partial|none").
 */
export type CertStatus = 'valid' | 'superseded' | 'revoked' | 'partial' | 'none';

export interface CertificateStruct {
  projectId: Hex;
  specHash: Hex;
  invariantSetHash: Hex;
  propertyHash: Hex;
  codeHash: Hex;
  reportHash: Hex;
  issuedAt: bigint;
  passedCount: number;
  totalCount: number;
  passedBitmap: bigint;
  rehearsalTxCount: number;
  status: number;
  supersededBy: Address;
  revokeReasonHash: Hex;
  reportURI: string;
}

export interface CertLookup {
  address: Address;
  hasCertificate: boolean;
  certified: boolean;
  certifiedWith: boolean | null;
  isLatest: boolean | null;
  certId: bigint | null;
  certificate: CertificateStruct | null;
  codeMatches: boolean | null;
  status: CertStatus;
}

/** The slice of viem's PublicClient the lookups need; lets tests pass a mock. */
export interface MinimalPublicClient {
  readContract: PublicClient['readContract'];
  getLogs?: PublicClient['getLogs'];
}

export interface FetchCertLookupInput {
  client: MinimalPublicClient;
  registry: Address;
  address: Address;
  invariantSetHash?: Hex;
}

/**
 * True when `err` is (or wraps, via .cause or viem's BaseError#walk) a revert whose decoded
 * custom error is NoCertificate. Duplicated in packages/cli/src/commands/status.ts on purpose:
 * this package does not depend on @specfirst/cli, only on @specfirst/core (for canonicalJson).
 */
export function isNoCertificateRevert(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const c = current as { data?: { errorName?: string }; cause?: unknown; walk?: (fn: (e: unknown) => boolean) => unknown };
    if (c.data?.errorName === 'NoCertificate') return true;
    if (typeof c.walk === 'function') {
      const found = c.walk((e) => (e as { data?: { errorName?: string } })?.data?.errorName === 'NoCertificate');
      if (found) return true;
    }
    current = c.cause;
  }
  return false;
}

/**
 * Derives the five-way display status. Order matters: a revoked or code-mismatched certificate
 * is shown as revoked even if it happens to also be partial or non-latest; a partial certificate
 * is shown as partial even if, by the contract's own supersede rules, it could never be latest.
 */
export function computeDisplayStatus(cert: CertificateStruct, codeMatches: boolean, isLatestFlag: boolean): CertStatus {
  if (ON_CHAIN_STATUS[cert.status] === 'Revoked') return 'revoked';
  if (!codeMatches) return 'revoked';
  if (cert.passedCount < cert.totalCount) return 'partial';
  if (!isLatestFlag) return 'superseded';
  return 'valid';
}

/**
 * Reads isCertified, isCertifiedWith (when invariantSetHash given), latest, and isLatest from
 * CertificateRegistry for one target, and derives the display status. When latest() reverts with
 * NoCertificate, hasCertificate is false and status is 'none' (per plan.md 3.10, "no certificate"
 * is not an error).
 */
export async function fetchCertLookup({ client, registry, address, invariantSetHash }: FetchCertLookupInput): Promise<CertLookup> {
  const certified = (await client.readContract({
    address: registry,
    abi: certificateRegistryAbi,
    functionName: 'isCertified',
    args: [address],
  })) as boolean;

  const certifiedWith = invariantSetHash
    ? ((await client.readContract({
        address: registry,
        abi: certificateRegistryAbi,
        functionName: 'isCertifiedWith',
        args: [address, invariantSetHash],
      })) as boolean)
    : null;

  let latestResult: readonly [bigint, CertificateStruct, boolean] | null = null;
  try {
    latestResult = (await client.readContract({
      address: registry,
      abi: certificateRegistryAbi,
      functionName: 'latest',
      args: [address],
    })) as readonly [bigint, CertificateStruct, boolean];
  } catch (err) {
    if (!isNoCertificateRevert(err)) throw err;
  }

  if (!latestResult) {
    return {
      address,
      hasCertificate: false,
      certified,
      certifiedWith,
      isLatest: null,
      certId: null,
      certificate: null,
      codeMatches: null,
      status: 'none',
    };
  }

  const [certId, certificate, codeMatches] = latestResult;
  const isLatest = (await client.readContract({
    address: registry,
    abi: certificateRegistryAbi,
    functionName: 'isLatest',
    args: [address],
  })) as boolean;

  return {
    address,
    hasCertificate: true,
    certified,
    certifiedWith,
    isLatest,
    certId,
    certificate,
    codeMatches,
    status: computeDisplayStatus(certificate, codeMatches, isLatest),
  };
}

export interface LineageHop {
  address: Address;
  certId: bigint;
  status: CertStatus;
  issuedAt: bigint;
}

/**
 * Walks the forward supersession chain (this target's own `supersededBy` pointer, then that
 * target's, ...) up to `maxHops`. Bounded because a malicious or buggy issuer could in principle
 * create a long chain; five hops covers every path in the plan's own version-replacement demo.
 * Does not resolve older (predecessor) versions: the contract has no reverse pointer, and
 * reconstructing one needs `CertificateSuperseded` event logs, which is left to
 * `fetchBackwardLineage` below rather than folded in here, so a slow or block-range-limited RPC
 * only affects the lineage list, never the certificate's own status.
 */
export async function fetchForwardLineage(
  client: MinimalPublicClient,
  registry: Address,
  start: CertLookup,
  maxHops = 5,
): Promise<LineageHop[]> {
  const hops: LineageHop[] = [];
  let current = start;
  let hop = 0;
  while (current.certificate && current.certificate.supersededBy !== ZERO_ADDRESS && hop < maxHops) {
    const next = await fetchCertLookup({ client, registry, address: current.certificate.supersededBy });
    if (!next.certificate) break;
    hops.push({ address: next.address, certId: next.certId!, status: next.status, issuedAt: next.certificate.issuedAt });
    current = next;
    hop += 1;
  }
  return hops;
}

/**
 * Best-effort predecessor lookup via `CertificateSuperseded(oldTarget indexed, newTarget indexed,
 * projectId indexed)` logs filtered on newTarget == address. Some RPCs cap eth_getLogs block
 * ranges; on any error this returns an empty array rather than failing the whole page, since
 * predecessor lineage is a nice-to-have, not part of the certificate's own verification result.
 */
export async function fetchBackwardLineage(client: MinimalPublicClient, registry: Address, address: Address): Promise<Address[]> {
  if (!client.getLogs) return [];
  try {
    const logs = await client.getLogs({
      address: registry,
      event: {
        type: 'event',
        name: 'CertificateSuperseded',
        inputs: [
          { name: 'oldTarget', type: 'address', indexed: true },
          { name: 'newTarget', type: 'address', indexed: true },
          { name: 'projectId', type: 'bytes32', indexed: true },
        ],
      },
      args: { newTarget: address },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    return logs.map((l) => (l.args as { oldTarget?: Address }).oldTarget).filter((a): a is Address => Boolean(a));
  } catch {
    return [];
  }
}

/**
 * Best-effort issuance transaction hash via `CertificateIssued(target indexed, projectId indexed,
 * certId, ...)` logs. Same block-range caveat as fetchBackwardLineage: returns null on any error
 * so the page falls back to an explorer address link instead of a tx link.
 */
export async function fetchIssuanceTx(client: MinimalPublicClient, registry: Address, address: Address, certId: bigint): Promise<Hex | null> {
  if (!client.getLogs) return null;
  try {
    const logs = await client.getLogs({
      address: registry,
      event: {
        type: 'event',
        name: 'CertificateIssued',
        inputs: [
          { name: 'target', type: 'address', indexed: true },
          { name: 'projectId', type: 'bytes32', indexed: true },
          { name: 'certId', type: 'uint256', indexed: false },
          { name: 'invariantSetHash', type: 'bytes32', indexed: false },
          { name: 'propertyHash', type: 'bytes32', indexed: false },
          { name: 'codeHash', type: 'bytes32', indexed: false },
          { name: 'reportHash', type: 'bytes32', indexed: false },
          { name: 'passedCount', type: 'uint16', indexed: false },
          { name: 'totalCount', type: 'uint16', indexed: false },
        ],
      },
      args: { target: address },
      fromBlock: 0n,
      toBlock: 'latest',
    });
    const match = logs.find((l) => (l.args as { certId?: bigint }).certId === certId);
    return match?.transactionHash ?? null;
  } catch {
    return null;
  }
}
