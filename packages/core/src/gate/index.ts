// Browser-safe part of the allocation gate demo (docs/adr/0007): the bundled ABI and bytecode and the names of the
// contract's enums. Nothing but the generated artifact is imported, so a web page can use `@specfirst/core/gate`
// without pulling Node-only modules.
import { allocationGateAbi, allocationGateBytecode } from './artifact.js';

export { allocationGateAbi, allocationGateBytecode };

/** AllocationGate.Verdict by its uint8 value. */
export const GATE_VERDICTS = ['Compliant', 'Stale', 'NoAttestation', 'NotCompliant', 'UntrustedIssuer', 'CodeMismatch'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];

/** AllocationGate.ExitPath by its uint8 value: which vault call brought the assets back. */
export const GATE_EXIT_PATHS = ['Redeem', 'Withdraw'] as const;
export type GateExitPath = (typeof GATE_EXIT_PATHS)[number];

/** One line per verdict, for people reading a gate's state. */
export const GATE_VERDICT_TEXT: Readonly<Record<GateVerdict, string>> = {
  Compliant: 'the latest attestation passed every property, is fresh, comes from a current issuer and is about the code at this address',
  Stale: 'the latest attestation passed, but it is older than the gate accepts for new money',
  NoAttestation: 'the registry has no attestation of this vault',
  NotCompliant: 'the latest attestation is revoked, or has a failed, inconclusive or not-applicable result',
  UntrustedIssuer: 'the latest attestation passed, but its issuer is no longer an issuer of the registry',
  CodeMismatch: 'the latest attestation passed for other code than the code at this address',
};

/** The verdict named by its uint8 value; throws on a value the contract does not have. */
export function gateVerdictOf(value: number | bigint): GateVerdict {
  const name = GATE_VERDICTS[Number(value)];
  if (!name) throw new Error(`unknown AllocationGate verdict ${value}`);
  return name;
}

export function gateExitPathOf(value: number | bigint): GateExitPath {
  const name = GATE_EXIT_PATHS[Number(value)];
  if (!name) throw new Error(`unknown AllocationGate exit path ${value}`);
  return name;
}

/** allocate needs Compliant. */
export function allocationAllowed(v: GateVerdict): boolean {
  return v === 'Compliant';
}

/** exit is open on every verdict but Compliant and Stale (a position is needed too). */
export function exitAllowed(v: GateVerdict): boolean {
  return v !== 'Compliant' && v !== 'Stale';
}
