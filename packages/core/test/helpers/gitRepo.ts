import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

/** A local repository with one commit per `commits` entry; returns its file:// URL and the commit shas. */
export async function localRepo(root: string, name: string, commits: Array<Record<string, string>>): Promise<{ url: string; shas: string[] }> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await git(dir, 'init', '-q', '-b', 'main');
  const shas: string[] = [];
  for (const files of commits) {
    for (const [f, c] of Object.entries(files)) await writeFile(path.join(dir, f), c);
    await git(dir, 'add', '-A');
    await git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'c');
    shas.push(await git(dir, 'rev-parse', 'HEAD'));
  }
  return { url: `file://${dir}`, shas };
}
