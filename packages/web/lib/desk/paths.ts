import path from 'node:path';

/*
 * Server-only file locations. `next dev` and `next start` run in packages/web, so the repository root is two up.
 */

export function repoRoot(env: Record<string, string | undefined> = process.env): string {
  return env.SPECFIRST_REPO_ROOT ? path.resolve(env.SPECFIRST_REPO_ROOT) : path.resolve(process.cwd(), '..', '..');
}

/** The worker's progress file. SPECFIRST_WORKER_STATUS overrides; relative paths resolve against the repository. */
export function workerStatusPath(env: Record<string, string | undefined> = process.env): string {
  const v = env.SPECFIRST_WORKER_STATUS?.trim();
  return v ? path.resolve(repoRoot(env), v) : path.join(repoRoot(env), '.specfirst', 'worker', 'status.json');
}

/** Where check reports land: <dir>/<chainId>/<address>/*.json. SPECFIRST_CHECKS_DIR overrides. */
export function checksDir(env: Record<string, string | undefined> = process.env): string {
  const v = env.SPECFIRST_CHECKS_DIR?.trim();
  return v ? path.resolve(repoRoot(env), v) : path.join(repoRoot(env), 'certs', 'checks');
}

/** True when `file` is inside `dir` (after resolving), so a path from status.json cannot reach elsewhere. */
export function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}
