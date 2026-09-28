export { SpecError, SPEC_ERROR_EXIT_CODE, type SpecIssue } from './spec/errors.js';
export {
  specSchema,
  invariantSchema,
  invariantKindSchema,
  type Spec,
  type Invariant,
  type InvariantKind,
} from './spec/schema.js';
export { parseSpec } from './spec/parse.js';
export {
  canonicalJson,
  sha256Hex,
  specHash,
  invariantSetHash,
  projectIdHash,
  propertyHash,
  type Bytes32,
} from './spec/hash.js';
export {
  createLock,
  verifyLock,
  readLock,
  computeLockState,
  hashPropertyFiles,
  readSubmodules,
  lockPath,
  LockError,
  LOCK_DIR,
  LOCK_FILE,
  PROPERTIES_DIR,
  LOCK_MISMATCH_EXIT_CODE,
  MUTANT_CHECK_EXIT_CODE,
  type LockFile,
  type LockedFile,
  type LockedSubmodule,
  type LockMismatch,
  type LockMismatchKind,
  type LockState,
  type MutantCheckResult,
  type CreateLockInput,
  type VerifyLockInput,
} from './lock/lock.js';
export type {
  FuzzParams,
  Counterexample,
  InvariantStatus,
  InvariantResult,
  AuxFinding,
  FuzzResult,
  FuzzRunInput,
  FuzzBackend,
} from './fuzz/types.js';
export {
  ForgeBackend,
  ForgeOutputError,
  parseForgeJson,
  invariantIdFromTestName,
  formatForgeCall,
  INVARIANTS_TEST_PATH,
  type ForgeBackendOptions,
} from './fuzz/forge.js';
export { MockBackend, type MockScenario } from './fuzz/mock.js';
export type { ImplAgent, AgentResult, IterationRecord, ImplementInput, FixInput } from './agent/types.js';
export { ReplayAgent, type ReplayAgentOptions } from './agent/replay.js';
export { ClaudeCodeAgent, NotImplementedError, type ClaudeCodeAgentOptions } from './agent/claude.js';
export {
  createWorktree,
  collectChanges,
  commitAll,
  removeWorktree,
  WORKTREES_DIR,
  type Worktree,
  type Changes,
} from './loop/worktree.js';
export {
  checkEditable,
  checkLockedTouched,
  detectEnvBranches,
  lockedPaths,
  type EnvBranchKind,
  type EnvBranchWarning,
} from './loop/guard.js';
export {
  runFixLoop,
  counterexampleSignature,
  counterexamplesOf,
  LOOP_EXHAUSTED_EXIT_CODE,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_AGENT_TIMEOUT_MS,
  RUNS_DIR,
  type FixLoopInput,
  type FixLoopResult,
  type LoopStatus,
  type LoopExitCode,
  type LoopEvent,
  type LoopEnvWarning,
  type StopReason,
} from './loop/machine.js';
export {
  BudgetTracker,
  BUDGET_EXCEEDED_EXIT_CODE,
  DEFAULT_RUN_CAP_USD,
  DEFAULT_TOTAL_CAP_USD,
  BUDGET_FILE,
  type BudgetFile,
  type BudgetOptions,
  type BudgetExceeded,
} from './budget/budget.js';
