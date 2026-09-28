import { execFile } from 'node:child_process';
import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
// test/helpers -> test -> cli -> packages -> repo root
export const SAMPLE_DIR = path.resolve(here, '..', '..', '..', '..', 'examples', 'staking-vault');
const SKIP = new Set(['out', 'cache', '.specfirst']);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync('git', args, { cwd })).stdout;
}

/**
 * Copies examples/staking-vault into a fresh temporary git repository with one commit,
 * since the fix loop checks worktrees out of committed state.
 */
export async function sampleRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'specfirst-run-'));
  await cp(SAMPLE_DIR, dir, {
    recursive: true,
    filter: (src) => !SKIP.has(path.relative(SAMPLE_DIR, src).split(path.sep)[0] ?? ''),
  });
  await writeFile(path.join(dir, '.gitignore'), '.specfirst/\nout/\ncache/\n');
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  return dir;
}
