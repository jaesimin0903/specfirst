import type { Address, Hex, PublicClient } from 'viem';
import { canonicalJson } from '../spec/hash.js';
import { identifyImplementation, type ImplementationIdentity } from '../standards/identity.js';
import type { StandardCheckReport } from '../standards/report.js';
import { AttestationError } from './params.js';

/** The slice of a read-only client on the subject chain that verification needs (identifyImplementation included). */
export type SubjectClient = Pick<PublicClient, 'getChainId' | 'getCode' | 'getStorageAt' | 'readContract'>;

/** Identity fields that must be the same on the subject chain as in the report before anything is attested. */
export const ATTESTED_IDENTITY_FIELDS = ['codeHash', 'proxy', 'implementation', 'implementationKey', 'implementationKeyKind'] as const;

export interface SubjectCodeCheck {
  chainId: number;
  blockNumber: bigint;
  codeHash: Hex;
  /** identifyImplementation on the subject chain at the report's block; equal to the report's identity in ATTESTED_IDENTITY_FIELDS. */
  identity: ImplementationIdentity;
  /** The subject is proxy-shaped but its implementation could not be resolved (proxy.kind 'unknown'); only with allowUnknownProxy. */
  unknownProxy: boolean;
}

export interface VerifySubjectOptions {
  /** Accept a subject whose identity.proxy.kind is 'unknown'. Off by default: its key comes from the proxy code, not the logic. */
  allowUnknownProxy?: boolean;
}

/** Lowercases every 0x hex string so a checksummed address and its lowercase form compare equal. */
function lowerHex(v: unknown): unknown {
  if (typeof v === 'string') return /^0x[0-9a-fA-F]*$/.test(v) ? v.toLowerCase() : v;
  if (Array.isArray(v)) return v.map(lowerHex);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, lowerHex(x)]));
  return v;
}

function pick(identity: object): Record<string, unknown> {
  return Object.fromEntries(ATTESTED_IDENTITY_FIELDS.map((f) => [f, lowerHex((identity as Record<string, unknown>)[f] ?? null)]));
}

/**
 * Before an attestation is issued: the subject RPC serves the report's chain, and identifyImplementation run
 * on that chain at the report's block gives the report's identity: the same codeHash, proxy, implementation,
 * implementationKey and implementationKeyKind, compared as canonical JSON (hex case ignored). The registry
 * cannot read another chain, so this is the issuer's own check of the values it will report. A subject whose
 * proxy implementation could not be resolved (proxy.kind 'unknown') is refused unless allowUnknownProxy.
 * Read only.
 */
export async function verifySubjectCode(client: SubjectClient, report: StandardCheckReport, opts: VerifySubjectOptions = {}): Promise<SubjectCodeCheck> {
  const chainId = await client.getChainId();
  if (chainId !== report.chainId) {
    throw new AttestationError(`subject RPC serves chain ${chainId}, the report is for chain ${report.chainId}`);
  }
  const blockNumber = BigInt(report.blockNumber);
  const where = `${report.address} on chain ${chainId} block ${blockNumber}`;
  const identity = await identifyImplementation(client, report.address as Address, blockNumber);
  if (identity.codeSize === 0) throw new AttestationError(`no code at ${where}`);
  if (identity.codeHash !== report.identity.codeHash.toLowerCase()) {
    throw new AttestationError(`code at ${where} hashes to ${identity.codeHash}, the report says ${report.identity.codeHash}`);
  }
  const onChain = pick(identity);
  const reported = pick(report.identity);
  if (canonicalJson(onChain) !== canonicalJson(reported)) {
    const diffs = ATTESTED_IDENTITY_FIELDS.filter((f) => canonicalJson(onChain[f]) !== canonicalJson(reported[f])).map(
      (f) => `${f}: report ${canonicalJson(reported[f])}, chain ${canonicalJson(onChain[f])}`,
    );
    throw new AttestationError(`identity of ${where} differs from the report: ${diffs.join('; ')}`);
  }
  const unknownProxy = identity.proxy?.kind === 'unknown';
  if (unknownProxy && !opts.allowUnknownProxy) {
    throw new AttestationError(
      `${where} is proxy-shaped but its implementation could not be resolved (proxy kind unknown), so implementationKey is the proxy's own code; pass --allow-unknown-proxy to attest it anyway`,
    );
  }
  return { chainId, blockNumber, codeHash: identity.codeHash, identity, unknownProxy };
}
