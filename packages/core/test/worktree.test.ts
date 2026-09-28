import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectChanges, commitAll, createWorktree, removeWorktree } from '../src/index.js';
import { GIT_ID, git, initRepo, writeFiles } from './helpers/repo.js';

let repo: string;
beforeEach(async () => {
  repo = await initRepo();
});
afterEach(() => rm(repo, { recursive: true, force: true }));

describe('worktree', () => {
  it('creates a detached worktree per iteration under .specfirst/worktrees and removes it', async () => {
    const head = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const wt = await createWorktree(repo, 'run-1', 2);
    expect(wt.path).toBe(path.join(repo, '.specfirst/worktrees/run-1/iter-2'));
    expect(wt.base).toBe(head);
    expect(existsSync(path.join(wt.path, 'src/StakingVault.sol'))).toBe(true);
    expect(await git(repo, 'worktree', 'list')).toContain('iter-2');
    // The user's checkout is untouched by work inside the worktree.
    await writeFile(path.join(wt.path, 'src/StakingVault.sol'), 'changed');
    expect(await readFile(path.join(repo, 'src/StakingVault.sol'), 'utf8')).not.toBe('changed');
    await removeWorktree(repo, wt.path);
    expect(existsSync(wt.path)).toBe(false);
    expect(await git(repo, 'worktree', 'list')).not.toContain('iter-2');
  });

  it('collectChanges returns modified, untracked, deleted and renamed paths with a diff that includes new files', async () => {
    await writeFiles(repo, { 'src/Old.sol': 'contract Old {}\n' });
    await git(repo, 'add', '-A');
    await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'old');
    const wt = await createWorktree(repo, 'run-1', 1);
    expect(await collectChanges(wt.path)).toEqual({ changedPaths: [], diff: '' });

    await writeFiles(wt.path, {
      'src/StakingVault.sol': '// rewritten\n',
      'scripts/deep/new.sh': 'echo hi\n',
      'foundry.toml': null,
    });
    await git(wt.path, 'mv', 'src/Old.sol', 'src/Renamed.sol');
    const { changedPaths, diff } = await collectChanges(wt.path);
    expect(changedPaths).toEqual(['foundry.toml', 'scripts/deep/new.sh', 'src/Old.sol', 'src/Renamed.sol', 'src/StakingVault.sol']);
    expect(diff).toContain('+++ b/scripts/deep/new.sh');
    expect(diff).toContain('+echo hi');
    expect(diff).toContain('deleted file mode');

    const commit = await commitAll(wt.path, 'accept');
    expect(await git(repo, 'show', `${commit}:scripts/deep/new.sh`)).toBe('echo hi');
    const next = await createWorktree(repo, 'run-1', 2, commit);
    expect(next.base).toBe(commit);
    expect(existsSync(path.join(next.path, 'src/Renamed.sol'))).toBe(true);
    await removeWorktree(repo, wt.path);
    await removeWorktree(repo, next.path);
  });

  it('does not report files matched by .gitignore', async () => {
    const wt = await createWorktree(repo, 'run-1', 1);
    await writeFiles(wt.path, { 'out/StakingVault.json': '{}', 'cache/x': '1' });
    expect((await collectChanges(wt.path)).changedPaths).toEqual([]);
    await removeWorktree(repo, wt.path);
  });

  it('initialises submodules from the local checkout without a network', async () => {
    const lib = await mkdtemp(path.join(tmpdir(), 'specfirst-lib-'));
    try {
      await git(lib, 'init', '-q', '-b', 'main');
      await writeFiles(lib, { 'src/Test.sol': 'contract Test {}\n' });
      await git(lib, 'add', '-A');
      await git(lib, ...GIT_ID, 'commit', '-q', '-m', 'lib');
      await execa('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib/forge-std'], { cwd: repo });
      await git(repo, ...GIT_ID, 'commit', '-q', '-m', 'submodule');
      // Point the recorded URL somewhere unreachable: the worktree must still get the files.
      await git(repo, 'config', '-f', '.gitmodules', 'submodule.lib/forge-std.url', 'https://invalid.example/forge-std.git');
      await git(repo, ...GIT_ID, 'commit', '-q', '-a', '-m', 'url');
    } catch (err) {
      await rm(lib, { recursive: true, force: true });
      throw err;
    }
    const wt = await createWorktree(repo, 'run-1', 1);
    expect(await readFile(path.join(wt.path, 'lib/forge-std/src/Test.sol'), 'utf8')).toBe('contract Test {}\n');
    expect((await collectChanges(wt.path)).changedPaths).toEqual([]);
    await removeWorktree(repo, wt.path);
    await rm(lib, { recursive: true, force: true });
  });
});
