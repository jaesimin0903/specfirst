import { checkRequestDeskAbi, FIRST_REQUEST_ID, REQUEST_STATUS, type RequestStatusName } from './contract';
import { describeReadError } from '../board/attestations';

/*
 * View calls against CheckRequestDesk. Takes any reader with viem's readContract, so tests pass a mock. With the
 * server client (clients.ts) calls made together are folded into one multicall by viem.
 */

export interface ContractReader {
  readContract(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface DeskRequest {
  id: bigint;
  requester: `0x${string}`;
  subjectChainId: number;
  subject: `0x${string}`;
  standardId: `0x${string}`;
  feeWei: bigint;
  /** unix seconds */
  requestedAt: bigint;
  status: RequestStatusName;
  attestationId: bigint;
  rejectReason: `0x${string}`;
}

export interface DeskSummary {
  address: `0x${string}`;
  feeWei: bigint | null;
  timeoutSec: bigint | null;
  requestCount: bigint | null;
  earnedWei: bigint | null;
  withdrawnWei: bigint | null;
  escrowedWei: bigint | null;
  owner: `0x${string}` | null;
  worker: `0x${string}` | null;
  registry: `0x${string}` | null;
  /** Calls that failed, "fee: <error>". Empty when everything was read. */
  errors: string[];
}

interface RawRequest {
  requester: `0x${string}`;
  subjectChainId: bigint | number;
  subject: `0x${string}`;
  standardId: `0x${string}`;
  fee: bigint | number;
  requestedAt: bigint | number;
  status: number | bigint;
  attestationId: bigint | number;
  rejectReason: `0x${string}`;
}

/** requestOf's struct as viem decodes it, named fields or a positional tuple. */
export function normalizeRequest(id: bigint, raw: unknown): DeskRequest {
  const r = (Array.isArray(raw)
    ? {
        requester: raw[0],
        subjectChainId: raw[1],
        subject: raw[2],
        standardId: raw[3],
        fee: raw[4],
        requestedAt: raw[5],
        status: raw[6],
        attestationId: raw[7],
        rejectReason: raw[8],
      }
    : raw) as RawRequest;
  return {
    id,
    requester: r.requester,
    subjectChainId: Number(r.subjectChainId),
    subject: r.subject,
    standardId: r.standardId,
    feeWei: BigInt(r.fee),
    requestedAt: BigInt(r.requestedAt),
    status: REQUEST_STATUS[Number(r.status)] ?? 'None',
    attestationId: BigInt(r.attestationId),
    rejectReason: r.rejectReason,
  };
}

/** True for the desk's UnknownRequest(uint256) revert, however deep viem wraps it. */
export function isUnknownRequest(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; e && depth < 8; depth++) {
    const x = e as { data?: { errorName?: string }; errorName?: string; shortMessage?: string; message?: string; cause?: unknown };
    if (x.data?.errorName === 'UnknownRequest' || x.errorName === 'UnknownRequest') return true;
    if (typeof x.shortMessage === 'string' && x.shortMessage.includes('UnknownRequest')) return true;
    e = x.cause;
  }
  return false;
}

const SUMMARY_FIELDS = ['fee', 'timeout', 'requestCount', 'earned', 'withdrawn', 'escrowed', 'owner', 'worker', 'registry'] as const;

export async function readDeskSummary(reader: ContractReader, address: `0x${string}`): Promise<DeskSummary> {
  const settled = await Promise.allSettled(SUMMARY_FIELDS.map((functionName) => reader.readContract({ address, abi: checkRequestDeskAbi, functionName })));
  const errors: string[] = [];
  const value = <T>(i: number, map: (v: unknown) => T): T | null => {
    const s = settled[i]!;
    if (s.status === 'fulfilled') return map(s.value);
    errors.push(`${SUMMARY_FIELDS[i]}: ${describeReadError(s.reason)}`);
    return null;
  };
  const big = (v: unknown) => BigInt(v as bigint);
  const addr = (v: unknown) => v as `0x${string}`;
  const summary: DeskSummary = {
    address,
    feeWei: value(0, big),
    timeoutSec: value(1, big),
    requestCount: value(2, big),
    earnedWei: value(3, big),
    withdrawnWei: value(4, big),
    escrowedWei: value(5, big),
    owner: value(6, addr),
    worker: value(7, addr),
    registry: value(8, addr),
    errors,
  };
  if (errors.length === SUMMARY_FIELDS.length) throw new Error(`desk not reachable: ${errors[0]}`);
  return summary;
}

/** null when the desk has no such request (UnknownRequest or a zeroed struct). Other errors propagate. */
export async function readRequest(reader: ContractReader, address: `0x${string}`, id: bigint): Promise<DeskRequest | null> {
  try {
    const raw = await reader.readContract({ address, abi: checkRequestDeskAbi, functionName: 'requestOf', args: [id] });
    const r = normalizeRequest(id, raw);
    return r.status === 'None' ? null : r;
  } catch (err) {
    if (isUnknownRequest(err)) return null;
    throw err;
  }
}

/** The newest `limit` request ids, newest first: requestCount-1 down to FIRST_REQUEST_ID. */
export function latestIds(requestCount: bigint, limit: number): bigint[] {
  const ids: bigint[] = [];
  for (let id = requestCount - 1n + FIRST_REQUEST_ID; id >= FIRST_REQUEST_ID && ids.length < limit; id--) ids.push(id);
  return ids;
}

/** Reads the given ids together; ones that fail or do not exist are left out. */
export async function readRequests(reader: ContractReader, address: `0x${string}`, ids: readonly bigint[]): Promise<DeskRequest[]> {
  const settled = await Promise.allSettled(ids.map((id) => readRequest(reader, address, id)));
  return settled.flatMap((s) => (s.status === 'fulfilled' && s.value ? [s.value] : []));
}
