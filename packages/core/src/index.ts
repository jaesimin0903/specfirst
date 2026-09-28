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
