import { parseAbi } from 'viem';
import { describeReadError, toRecord, type RawAttestation } from '../board/attestations';
import type { AttestationRecord } from '../board/types';
import type { ContractReader } from './read';
import { STANDARD_ID } from './config';

/*
 * Request-time reads of CheckAttestationRegistry: the latest attestation of one vault, or one attestation by id.
 * The board reads the registry at build time; these keep a vault that was just re-checked, the badge and the API
 * current. The fragment below is the part of core's checkAttestationRegistryAbi these calls use (core's root
 * cannot be bundled into Next); test/desk-registry.test.ts checks it against core so they cannot drift.
 */

export const registryReadAbi = parseAbi([
  'struct Attestation { uint64 subjectChainId; address subject; bytes32 standardId; uint64 blockNumber; bytes32 implementationKey; bytes32 subjectCodeHash; bytes32 suiteHash; bytes32 reportHash; uint16 passCount; uint16 failCount; uint16 inconclusiveCount; uint16 notApplicableCount; uint256 passedBitmap; uint256 failedBitmap; uint64 issuedAt; address issuer; uint8 status; uint256 supersededBy; bytes32 revokeReasonHash; string reportURI; }',
  'function latest(uint64 subjectChainId, address subject, bytes32 standardId) view returns (uint256 id, Attestation a)',
  'function isCompliant(uint64 subjectChainId, address subject, bytes32 standardId) view returns (bool)',
  'function attestationOf(uint256 id) view returns (Attestation)',
  'error NoAttestation(uint64 subjectChainId, address subject, bytes32 standardId)',
  'error UnknownAttestation(uint256 id)',
]);

export type LiveAttestation = { kind: 'attested'; record: AttestationRecord } | { kind: 'none' } | { kind: 'unread'; reason: string };

function revertedWith(err: unknown, name: string): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const x = e as { data?: { errorName?: string }; errorName?: string; shortMessage?: string; cause?: unknown };
    if (x.data?.errorName === name || x.errorName === name) return true;
    if (typeof x.shortMessage === 'string' && x.shortMessage.includes(name)) return true;
    e = x.cause;
  }
  return false;
}

/** latest() and isCompliant() for one subject; NoAttestation is "none", anything else "unread". */
export async function readLatestAttestation(
  reader: ContractReader,
  registry: `0x${string}`,
  subjectChainId: number,
  subject: `0x${string}`,
  txHashes: Readonly<Record<string, string>> = {},
): Promise<LiveAttestation> {
  const args = [BigInt(subjectChainId), subject, STANDARD_ID] as const;
  const [latest, compliant] = await Promise.allSettled([
    reader.readContract({ address: registry, abi: registryReadAbi, functionName: 'latest', args }),
    reader.readContract({ address: registry, abi: registryReadAbi, functionName: 'isCompliant', args }),
  ]);
  if (latest.status === 'rejected') {
    if (revertedWith(latest.reason, 'NoAttestation')) return { kind: 'none' };
    return { kind: 'unread', reason: describeReadError(latest.reason) };
  }
  const [id, a] = latest.value as readonly [bigint, RawAttestation];
  const ok = compliant.status === 'fulfilled' ? (compliant.value as boolean) : null;
  return { kind: 'attested', record: toRecord(id, a, ok, txHashes) };
}

/** attestationOf(id); null for UnknownAttestation. */
export async function readAttestationById(
  reader: ContractReader,
  registry: `0x${string}`,
  id: bigint,
  txHashes: Readonly<Record<string, string>> = {},
): Promise<AttestationRecord | null> {
  try {
    const a = (await reader.readContract({ address: registry, abi: registryReadAbi, functionName: 'attestationOf', args: [id] })) as RawAttestation;
    return toRecord(id, a, null, txHashes);
  } catch (err) {
    if (revertedWith(err, 'UnknownAttestation')) return null;
    throw err;
  }
}
