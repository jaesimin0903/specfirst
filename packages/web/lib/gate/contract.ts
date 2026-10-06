import { getAddress, isAddress } from 'viem';

/*
 * The one place the web names AllocationGate (ADR 0007). The ABI and the enum names come from @specfirst/core/gate,
 * the contract build, so the page cannot drift from the deployed gate. Client-safe.
 */

export {
  allocationGateAbi,
  allocationAllowed,
  exitAllowed,
  gateExitPathOf,
  gateVerdictOf,
  GATE_VERDICT_TEXT,
  GATE_VERDICTS,
  type GateExitPath,
  type GateVerdict,
} from '@specfirst/core/gate';

/** Where the demo gate lives; its vaults are on the same chain. */
export const GATE_CHAIN_ID = 10143;

/** NEXT_PUBLIC_SPECFIRST_GATE_10143, checksummed; null when unset or not an address ("not deployed"). */
export function gateAddress(env: Record<string, string | undefined> = process.env): `0x${string}` | null {
  const v = env.NEXT_PUBLIC_SPECFIRST_GATE_10143?.trim();
  return v && isAddress(v) ? getAddress(v) : null;
}
