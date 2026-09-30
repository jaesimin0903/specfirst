import { z } from 'zod';

/*
 * The one place the web app describes CheckRequestDesk and the worker's status.json.
 *
 * The ABI is re-exported from @specfirst/core/desk. The status.json schemas below are deliberately more lenient
 * readers than core's writers (numbers or strings, ISO or unix time), so an older or newer worker never blanks a
 * page. Every other module imports from here, never from the subpath directly. test/desk-contract.test.ts pins the
 * shapes against core.
 */

// The ABI comes from the contract build in @specfirst/core, so the web cannot drift from the deployed desk.
export { checkRequestDeskAbi } from '@specfirst/core/desk';

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
  'unknown-proxy': 'The address looks like a proxy but its implementation could not be resolved, so the check cannot say what code it ran.',
  'fulfill-failed': 'The check was attested but the fulfill transaction did not go through; the fee stays in escrow until it is fulfilled or refunded.',
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
