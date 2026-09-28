/** Exit code the CLI uses for an invalid spec file. */
export const SPEC_ERROR_EXIT_CODE = 2;

export interface SpecIssue {
  path: string;
  message: string;
}

/** Raised when a spec file cannot be parsed or fails validation. Maps to CLI exit code 2. */
export class SpecError extends Error {
  readonly exitCode = SPEC_ERROR_EXIT_CODE;
  readonly issues: SpecIssue[];

  constructor(message: string, issues: SpecIssue[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((i) => `  ${i.path || '<root>'}: ${i.message}`).join('\n')}` : message);
    this.name = 'SpecError';
    this.issues = issues;
  }
}
