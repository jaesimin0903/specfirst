// Gas limit policy shared by every transaction specfirst sends. Kept apart from deploy/deploy.ts (which reads and
// writes files) so browser-safe modules such as subs/client.ts can use it.

/** EIP-7825 per-transaction gas cap. Deploys at or above it are refused (plan 3.6 item 1). */
export const TX_GAS_CAP = 16_777_216n;

/** 1.2x, rounded up. */
export function withMargin(gas: bigint): bigint {
  return (gas * 12n + 9n) / 10n;
}
