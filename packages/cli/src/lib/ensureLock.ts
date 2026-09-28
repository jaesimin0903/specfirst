import { LOCK_MISMATCH_EXIT_CODE, verifyLock, type LockMismatch, type Spec } from '@specfirst/core';

/**
 * Raised by ensureLock when the project tree no longer matches .specfirst/lock.json.
 * Per plan.md 3.3/3.10: "specHash가 lock과 다르면 run 거부" -> CLI exit code 11.
 */
export class LockMismatchError extends Error {
  readonly exitCode = LOCK_MISMATCH_EXIT_CODE;
  readonly mismatches: LockMismatch[];

  constructor(mismatches: LockMismatch[]) {
    super(
      `project does not match .specfirst/lock.json (${mismatches.length} mismatch${mismatches.length === 1 ? '' : 'es'}): ` +
        mismatches.map((m) => `${m.kind}${m.path ? ` (${m.path})` : ''}`).join(', '),
    );
    this.name = 'LockMismatchError';
    this.mismatches = mismatches;
  }
}

export interface EnsureLockInput {
  projectDir: string;
  spec: Spec;
}

/**
 * Verifies the current project against .specfirst/lock.json and throws LockMismatchError
 * (exit code 11) on any mismatch, including a missing lock file. Resolves with no value
 * when the lock holds. Intended for `specfirst run` and any other command that must refuse
 * to proceed on a stale or absent lock.
 */
export async function ensureLock({ projectDir, spec }: EnsureLockInput): Promise<void> {
  const mismatches = await verifyLock({ projectDir, spec });
  if (mismatches.length > 0) {
    throw new LockMismatchError(mismatches);
  }
}
