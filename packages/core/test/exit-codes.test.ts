import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';

describe('CLI exit codes', () => {
  it('every *_EXIT_CODE the package exports is its own number; new commands take the next free one', () => {
    const codes = Object.fromEntries(Object.entries(core).filter(([name]) => name.endsWith('_EXIT_CODE')));
    expect(codes).toEqual({
      SPEC_ERROR_EXIT_CODE: 2,
      MUTANT_CHECK_EXIT_CODE: 3,
      LOOP_EXHAUSTED_EXIT_CODE: 10,
      LOCK_MISMATCH_EXIT_CODE: 11,
      DEPLOY_FAILED_EXIT_CODE: 12,
      VERIFY_FAILED_EXIT_CODE: 13,
      CERT_FAILED_EXIT_CODE: 14,
      BUDGET_EXCEEDED_EXIT_CODE: 15,
      STANDARD_CHECK_FAILED_EXIT_CODE: 16,
      STANDARD_CHECK_INCOMPLETE_EXIT_CODE: 17,
      DESK_FAILED_EXIT_CODE: 18,
      WATCH_FAILED_EXIT_CODE: 19,
      SUBS_FAILED_EXIT_CODE: 20,
    });
    expect(new Set(Object.values(codes)).size).toBe(Object.keys(codes).length);
  });
});
