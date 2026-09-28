import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';

export const WORKTREES_DIR = '.specfirst/worktrees';

export interface Worktree {
  path: string;
  /** Commit the worktree was created from. */
  base: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd, stripFinalNewline: false });
  return String(stdout);
}

/**
 * Creates `<projectDir>/.specfirst/worktrees/<runId>/iter-<iter>` as a detached worktree at `baseRef`.
 * Only committed state is checked out; uncommitted edits in projectDir are not visible to the agent.
 * Submodules (lib/) are initialised from projectDir's own checkouts so no network is needed.
 */
export async function createWorktree(
  projectDir: string,
  runId: string,
  iter: number,
  baseRef = 'HEAD',
): Promise<Worktree> {
  const base = (await git(projectDir, ['rev-parse', '--verify', `${baseRef}^{commit}`])).trim();
  const wt = path.join(projectDir, WORKTREES_DIR, runId, `iter-${iter}`);
  await mkdir(path.dirname(wt), { recursive: true });
  await git(projectDir, ['worktree', 'add', '--detach', wt, base]);
  await initSubmodules(projectDir, wt);
  return { path: wt, base };
}

async function initSubmodules(projectDir: string, wt: string): Promise<void> {
  if (!existsSync(path.join(wt, '.gitmodules'))) return;
  let listing: string;
  try {
    listing = await git(wt, ['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$']);
  } catch {
    return;
  }
  for (const line of listing.split('\n')) {
    const m = /^submodule\.(.+)\.path (.+)$/.exec(line.trim());
    if (!m) continue;
    const [, name, rel] = m as unknown as [string, string, string];
    const local = path.join(projectDir, rel);
    const target = path.join(wt, rel);
    if (!existsSync(path.join(local, '.git'))) continue;
    if (existsSync(target) && (await readdir(target)).length > 0) continue;
    await execa(
      'git',
      ['-c', 'protocol.file.allow=always', '-c', `submodule.${name}.url=${local}`, 'submodule', 'update', '--init', '--', rel],
      { cwd: wt },
    );
  }
}

export interface Changes {
  /** Every changed path relative to the worktree root, untracked files included, sorted. Renames list both sides. */
  changedPaths: string[];
  /** `git diff HEAD` with untracked files marked intent-to-add, so new files show up in full. */
  diff: string;
}

/**
 * Collects everything the agent touched: `git status --porcelain --untracked-files=all` for paths,
 * `git diff` for content. Files matched by .gitignore are not reported.
 */
export async function collectChanges(worktree: string): Promise<Changes> {
  const status = await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const paths = new Set<string>();
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    paths.add(entry.slice(3));
    // In -z mode a rename or copy is followed by its source path as a separate entry.
    if (xy.includes('R') || xy.includes('C')) {
      const from = entries[++i];
      if (from) paths.add(from);
    }
  }
  if (paths.size === 0) return { changedPaths: [], diff: '' };
  await git(worktree, ['add', '--intent-to-add', '--all']);
  const diff = await git(worktree, ['diff', '--binary', 'HEAD']);
  return { changedPaths: [...paths].sort(), diff };
}

/** Commits every change in the worktree and returns the new commit. Used for accepted iterations. */
export async function commitAll(worktree: string, message: string): Promise<string> {
  await git(worktree, ['add', '--all']);
  await git(worktree, [
    '-c',
    'user.name=specfirst',
    '-c',
    'user.email=specfirst@localhost',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '--allow-empty',
    '-q',
    '-m',
    message,
  ]);
  return (await git(worktree, ['rev-parse', 'HEAD'])).trim();
}

export async function removeWorktree(projectDir: string, worktree: string): Promise<void> {
  await execa('git', ['worktree', 'remove', '--force', '--force', worktree], { cwd: projectDir, reject: false });
  await execa('git', ['worktree', 'prune'], { cwd: projectDir, reject: false });
}
