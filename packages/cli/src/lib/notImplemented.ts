/** Shared stub behaviour for run/deploy/verify/cert: print to stderr and exit 1. */
export function reportNotImplemented(name: string): void {
  console.error(`not implemented: ${name}`);
  process.exitCode = 1;
}
