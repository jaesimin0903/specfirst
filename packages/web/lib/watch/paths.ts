import path from 'node:path';
import { checksDir, isInside, repoRoot } from '../desk/paths';

/*
 * Server-only locations of the watcher's files (ADR 0006): <watch dir>/<subjectChainId>/{feed.ndjson,status.json,
 * vaults.json}, and the web's own <watch dir>/webhooks.json and demo-hook.json. Read at request time.
 */

/** SPECFIRST_WATCH_DIR, relative paths against the repository root; default <repo>/.specfirst/watch. */
export function watchDir(env: Record<string, string | undefined> = process.env): string {
  const v = env.SPECFIRST_WATCH_DIR?.trim();
  return v ? path.resolve(repoRoot(env), v) : path.join(repoRoot(env), '.specfirst', 'watch');
}

const CHAIN_RE = /^\d{1,12}$/;

export function isChainId(v: string): boolean {
  return CHAIN_RE.test(v) && Number(v) > 0;
}

export function chainDir(chainId: number | string, env: Record<string, string | undefined> = process.env): string {
  const c = String(chainId);
  if (!isChainId(c)) throw new Error(`not a chain id: ${c}`);
  return path.join(watchDir(env), c);
}

export const watchFile = {
  feed: (chainId: number | string, env?: Record<string, string | undefined>) => path.join(chainDir(chainId, env), 'feed.ndjson'),
  status: (chainId: number | string, env?: Record<string, string | undefined>) => path.join(chainDir(chainId, env), 'status.json'),
  vaults: (chainId: number | string, env?: Record<string, string | undefined>) => path.join(chainDir(chainId, env), 'vaults.json'),
  webhooks: (env?: Record<string, string | undefined>) => path.join(watchDir(env), 'webhooks.json'),
  demoHook: (env?: Record<string, string | undefined>) => path.join(watchDir(env), 'demo-hook.json'),
};

/** The watch directory as the page may show it: relative to the repository when inside it, else its last two parts. */
export function displayWatchDir(env: Record<string, string | undefined> = process.env): string {
  const dir = watchDir(env);
  const root = repoRoot(env);
  if (isInside(root, dir)) return path.relative(root, dir).split(path.sep).join('/');
  return `.../${dir.split(path.sep).slice(-2).join('/')}`;
}

/**
 * A feed reportPath ("certs/checks/143/0xabc.../110977310-1a2b.json") as a file inside the checks directory, and
 * its path relative to that directory ("143/0xabc.../110977310-1a2b.json"). The certs/checks prefix maps onto
 * SPECFIRST_CHECKS_DIR, so fixtures can live elsewhere; anything that leaves the checks directory is refused.
 */
export function resolveReportPath(reportPath: string, env: Record<string, string | undefined> = process.env): { abs: string; rel: string } | null {
  if (typeof reportPath !== 'string' || !reportPath.endsWith('.json') || reportPath.endsWith('.forge.json') || reportPath.includes('\0')) return null;
  const dir = checksDir(env);
  const normalized = reportPath.replace(/\\/g, '/');
  const abs = normalized.startsWith('certs/checks/') ? path.resolve(dir, normalized.slice('certs/checks/'.length)) : path.resolve(repoRoot(env), normalized);
  if (!isInside(dir, abs)) return null;
  const rel = path.relative(dir, abs).split(path.sep).join('/');
  if (!/^\d{1,12}\/0x[0-9a-fA-F]{40}\/[\w.-]{1,120}\.json$/.test(rel)) return null;
  return { abs, rel };
}
