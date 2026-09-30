// Browser-safe part of the request desk (docs/adr/0005): the bundled ABI and bytecode, the request status
// names, the reject reason codes and the zod schema of the worker's status.json. Only viem and zod are
// imported here, so a web page can use `@specfirst/core/desk` without pulling Node-only modules.
import { bytesToString, hexToBytes, stringToHex, type Hex } from 'viem';
import { z } from 'zod';
import { checkRequestDeskAbi, checkRequestDeskBytecode } from './artifact.js';

export { checkRequestDeskAbi, checkRequestDeskBytecode };

/** CheckRequestDesk.RequestStatus by its uint8 value. */
export const REQUEST_STATUS = ['None', 'Pending', 'Fulfilled', 'Rejected', 'Refunded'] as const;
export type RequestStatusName = (typeof REQUEST_STATUS)[number];

/**
 * Reason codes the worker passes to reject(id, reasonCode), as short ASCII strings. Onchain they are the
 * string right padded with zeros into a bytes32 (reasonCodeOf), not a hash.
 */
export const REJECT_REASONS = [
  'not-erc4626',
  'check-failed',
  'unsupported-chain',
  'unsupported-standard',
  'unknown-proxy',
  'attest-failed',
  'fulfill-failed',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

/** One line per reject reason, for people reading a rejected request. */
export const REJECT_REASON_TEXT: Readonly<Record<RejectReason, string>> = {
  'not-erc4626': 'the subject has no code, or asset() or totalAssets() does not answer at the check block',
  'check-failed': 'the check could not run (RPC or forge failure) after retries, or its report did not match the subject',
  'unsupported-chain': 'the worker does not read the subject chain of the request',
  'unsupported-standard': 'the standardId is not a standard the worker checks (only erc4626)',
  'unknown-proxy': 'the subject is proxy-shaped but its implementation could not be resolved',
  'attest-failed': 'the attestation transaction failed after retries',
  'fulfill-failed': 'the fulfill transaction failed after retries',
};

/** bytes32 of a short ASCII reason: the string's bytes right padded with zeros. 1 to 32 printable ASCII characters. */
export function reasonCodeOf(reason: string): Hex {
  if (!/^[\x21-\x7e]{1,32}$/.test(reason)) throw new Error(`a reason code is 1 to 32 printable ASCII characters without spaces, got "${reason}"`);
  return stringToHex(reason, { size: 32 });
}

/** The ASCII text of a bytes32 reason code (trailing zero bytes dropped); the hex itself when it is not such text. */
export function reasonOf(code: Hex): string {
  const bytes = hexToBytes(code);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const body = bytes.subarray(0, end);
  if (body.length === 0 || body.some((b) => b < 0x21 || b > 0x7e)) return code;
  return bytesToString(body);
}

/**
 * Stages of one request in the worker's status.json, in order. queued: seen Pending, not started.
 * prechecking: reading the subject chain and the ERC-4626 pre-check. running: the property suite is running
 * (block set). attesting: the report is saved (reportPath) and is being attested. fulfilling: attested
 * (attestationId, txs.attest), fulfill not mined yet. fulfilled and rejected are final.
 */
export const WORKER_STAGES = ['queued', 'prechecking', 'running', 'attesting', 'fulfilling', 'fulfilled', 'rejected'] as const;
export const workerStageSchema = z.enum(WORKER_STAGES);
export type WorkerStage = z.infer<typeof workerStageSchema>;

const decimal = z.string().regex(/^(0|[1-9]\d*)$/, 'a non-negative decimal integer string');
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a 0x transaction hash');

/**
 * One request in status.json. Big numbers are decimal strings: block (subject chain block of the check),
 * attestationId (CheckAttestationRegistry id), gasCostWei (gasUsed x effectiveGasPrice summed over this
 * request's transactions). reportPath is repository relative (certs/checks/...). updatedAt is ISO 8601 UTC.
 */
export const workerRequestStatusSchema = z
  .object({
    stage: workerStageSchema,
    updatedAt: z.string().datetime(),
    block: decimal.optional(),
    reportPath: z.string().min(1).optional(),
    attestationId: decimal.optional(),
    txs: z.object({ attest: txHash.optional(), fulfill: txHash.optional(), reject: txHash.optional() }).strict(),
    gasCostWei: decimal.optional(),
    error: z.string().optional(),
  })
  .strict();
export type WorkerRequestStatus = z.infer<typeof workerRequestStatusSchema>;

/** Sums over every request in status.json: gas the worker paid, and how many requests it closed each way. */
export const workerTotalsSchema = z
  .object({ gasCostWei: decimal, fulfilled: z.number().int().nonnegative(), rejected: z.number().int().nonnegative() })
  .strict();
export type WorkerTotals = z.infer<typeof workerTotalsSchema>;

/**
 * status.json: a flat object whose keys are the request ids (decimal strings, "0", "1", ...) next to one
 * `totals` key. Iterate the requests with workerStatusEntries.
 */
export interface WorkerStatus {
  totals: WorkerTotals;
  [id: string]: WorkerRequestStatus | WorkerTotals;
}

const REQUEST_ID = /^(0|[1-9]\d*)$/;

export const workerStatusSchema = z
  .object({ totals: workerTotalsSchema })
  .catchall(workerRequestStatusSchema)
  .superRefine((v, ctx) => {
    for (const key of Object.keys(v)) {
      if (key !== 'totals' && !REQUEST_ID.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `status.json keys are "totals" and decimal request ids, got "${key}"` });
      }
    }
  }) as unknown as z.ZodType<WorkerStatus, z.ZodTypeDef, unknown>;

/** The request entries of a status.json, sorted by id. */
export function workerStatusEntries(status: WorkerStatus): Array<[string, WorkerRequestStatus]> {
  return Object.keys(status)
    .filter((k) => k !== 'totals' && REQUEST_ID.test(k))
    .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
    .map((k) => [k, status[k] as WorkerRequestStatus]);
}

/** Totals recomputed from the entries: fulfilled and rejected counts and the sum of gasCostWei. */
export function workerTotalsOf(status: WorkerStatus): WorkerTotals {
  let gas = 0n;
  let fulfilled = 0;
  let rejected = 0;
  for (const [, e] of workerStatusEntries(status)) {
    gas += BigInt(e.gasCostWei ?? '0');
    if (e.stage === 'fulfilled') fulfilled++;
    if (e.stage === 'rejected') rejected++;
  }
  return { gasCostWei: gas.toString(), fulfilled, rejected };
}
