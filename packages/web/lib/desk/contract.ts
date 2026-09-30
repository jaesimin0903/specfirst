import { parseAbi } from 'viem';
import { z } from 'zod';

/*
 * The one place the web app describes CheckRequestDesk and the worker's status.json.
 *
 * Until @specfirst/core ships the browser-safe subpath "@specfirst/core/desk", these are local copies written from
 * the agreed interface. When it lands, replace this file's body with
 *
 *   export { checkRequestDeskAbi, REQUEST_STATUS, REJECT_REASONS, workerStatusSchema, workerRequestStatusSchema,
 *            workerStageSchema, type WorkerStatus, type WorkerRequestStatus, type WorkerStage } from '@specfirst/core/desk';
 *
 * and keep the few web-only helpers at the bottom (rejectReasonText, FIRST_REQUEST_ID). Every other module imports
 * from here, never from the subpath directly, so the swap is one file. test/desk-contract.test.ts pins the shapes.
 */

export const checkRequestDeskAbi = parseAbi([
  'struct Request { address requester; uint64 subjectChainId; address subject; bytes32 standardId; uint96 fee; uint64 requestedAt; uint8 status; uint256 attestationId; bytes32 rejectReason; }',
  'function requestCheck(uint64 subjectChainId, address subject, bytes32 standardId) payable returns (uint256 id)',
  'function refundExpired(uint256 id)',
  'function requestOf(uint256 id) view returns (Request)',
  'function requestCount() view returns (uint256)',
  'function fee() view returns (uint96)',
  'function timeout() view returns (uint64)',
  'function earned() view returns (uint256)',
  'function withdrawn() view returns (uint256)',
  'function escrowed() view returns (uint256)',
  'function owner() view returns (address)',
  'function worker() view returns (address)',
  'function registry() view returns (address)',
  'event CheckRequested(uint256 indexed id, address indexed requester, uint64 subjectChainId, address indexed subject, bytes32 standardId, uint96 fee)',
  'event CheckFulfilled(uint256 indexed id, uint256 attestationId)',
  'event CheckRejected(uint256 indexed id, bytes32 reasonCode)',
  'event CheckRefunded(uint256 indexed id)',
  'error UnknownRequest(uint256 id)',
]);

/** Solidity enum RequestStatus, by index. */
export const REQUEST_STATUS = ['None', 'Pending', 'Fulfilled', 'Rejected', 'Refunded'] as const;
export type RequestStatusName = (typeof REQUEST_STATUS)[number];

/**
 * Reject codes the worker writes into rejectReason (right-padded ASCII bytes32). core will export the list as
 * REJECT_REASONS; until then these are the codes agreed so far. Unknown codes are shown as decoded ASCII.
 */
export const REJECT_REASONS: Readonly<Record<string, string>> = {
  'not-erc4626': 'The address is not an ERC-4626 vault on the subject chain: asset() or the share token did not answer as the standard requires.',
  'not-a-contract': 'There is no contract at this address on the subject chain.',
  'unsupported-chain': 'The desk does not check contracts on this chain.',
  'unsupported-standard': 'The desk does not check this standard.',
  'check-failed': 'The check could not run to the end, so there is no report to attest.',
  'attest-failed': 'The report was produced but the attestation transaction did not go through.',
};

/** Worker stages, in the order a request moves through them. */
export const workerStageSchema = z.enum(['queued', 'prechecking', 'running', 'attesting', 'fulfilling', 'fulfilled', 'rejected']);
export type WorkerStage = z.infer<typeof workerStageSchema>;

const decimalish = z.union([z.string().regex(/^\d+$/), z.number().int().nonnegative()]).transform((v) => String(v));
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

/** One request's entry in status.json. updatedAt is ISO 8601 or unix seconds; both are accepted. */
export const workerRequestStatusSchema = z
  .object({
    stage: workerStageSchema,
    updatedAt: z.union([z.string(), z.number()]),
    block: decimalish.optional(),
    reportPath: z.string().optional(),
    attestationId: decimalish.optional(),
    txs: z.object({ attest: hash.optional(), fulfill: hash.optional(), reject: hash.optional() }).partial().default({}),
    gasCostWei: decimalish.optional(),
    error: z.string().optional(),
  })
  .passthrough();
export type WorkerRequestStatus = z.infer<typeof workerRequestStatusSchema>;

export const workerTotalsSchema = z.object({
  gasCostWei: decimalish,
  fulfilled: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
});

/** status.json: request ids (decimal strings) and "totals" side by side at the top level. */
export const workerStatusSchema = z.object({ totals: workerTotalsSchema.optional() }).catchall(workerRequestStatusSchema);
export type WorkerStatus = z.infer<typeof workerStatusSchema>;

/* Web-only helpers below: keep these when the exports above move to @specfirst/core/desk. */

/** Request ids start at 0, like the attestation registry's: valid ids are 0..requestCount()-1. */
export const FIRST_REQUEST_ID = 0n;

/** "0x6e6f742d65726334363236000..." -> "not-erc4626"; null for zero bytes, the raw hex when it is not printable ASCII. */
export function decodeRejectCode(reason: string | null | undefined): string | null {
  if (!reason || !/^0x[0-9a-fA-F]{64}$/.test(reason) || /^0x0{64}$/.test(reason)) return null;
  const bytes = reason
    .slice(2)
    .match(/../g)!
    .map((h) => parseInt(h, 16));
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const body = bytes.slice(0, end);
  if (body.some((b) => b < 0x20 || b > 0x7e)) return reason.toLowerCase();
  return String.fromCharCode(...body);
}

/** A sentence for a reject code, or the code itself when it is not one the web knows. */
export function rejectReasonText(code: string | null): string | null {
  if (!code) return null;
  return REJECT_REASONS[code] ?? `The worker rejected the request with code "${code}".`;
}
