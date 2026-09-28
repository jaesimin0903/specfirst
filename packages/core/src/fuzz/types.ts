import type { Address } from 'viem';
import type { Spec } from '../spec/schema.js';

/** Fuzzing parameters. Never stored in the spec; the CLI passes them in (plan 3.1). */
export interface FuzzParams {
  runs: number;
  depth: number;
  /** Wall-clock limit for one backend call, in seconds. */
  timeoutSec: number;
  /** Decimal or 0x-hex uint256 seed, passed to forge as FOUNDRY_FUZZ_SEED. */
  seed?: string;
}

export interface Counterexample {
  invariantId: string;
  /** One human-readable line per call, in execution order. Empty when the property failed without calls. */
  callSequence: string[];
  reason: string;
  seed?: string;
  source: 'forge' | 'ultrafuzz-reproduced';
}

export type InvariantStatus = 'pass' | 'fail' | 'error';

export interface InvariantResult {
  invariantId: string;
  status: InvariantStatus;
  counterexample?: Counterexample;
  /** Why the property could not be judged. Set for status 'error'. */
  error?: string;
}

/** Finding from an auxiliary campaign (Ultrafuzz). Never used for judging (plan 3.5). */
export interface AuxFinding {
  id: string;
  status: 'confirmed' | 'needs-review' | 'candidate' | 'duplicate' | 'false-positive' | 'wont-fix' | 'fixed';
  /** Set only when the finding could be mapped onto a locked invariant. */
  invariantId?: string;
  title?: string;
  /** True once a forge run inside an isolated worktree reproduced it. */
  reproduced?: boolean;
  pocPath?: string;
}

export interface FuzzResult {
  backend: string;
  wallclockSec: number;
  executions?: number;
  results: InvariantResult[];
  /** auxiliary backends only */
  extraFindings?: AuxFinding[];
  rawArtifactPath: string;
}

export interface FuzzRunInput {
  worktree: string;
  spec: Spec;
  params: FuzzParams;
  target?: Address;
  forkUrl?: string;
  /**
   * Fresh directory for this call's failure corpus. forge replays persisted counterexamples before
   * fuzzing, so sharing one across iterations would let an old counterexample shape a new result.
   * The fix loop passes .specfirst/runs/<runId>/iter-N/forge-persist/.
   */
  persistDir?: string;
}

export interface FuzzBackend {
  readonly name: 'forge' | 'ultrafuzz' | 'mock';
  /** Only forge and mock may judge. */
  readonly role: 'judge' | 'auxiliary';
  run(i: FuzzRunInput): Promise<FuzzResult>;
}
