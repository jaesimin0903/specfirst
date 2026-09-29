import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CACHE_DIR_ENV,
  defaultCacheDir,
  ERC4626_CONTROL_PATH,
  ERC4626_CONTROL_VAULT_PATH,
  ERC4626_FOUNDRY_TOML,
  ERC4626_HARNESS_PATH,
  erc4626SourceFile,
  prepareErc4626Workspace,
  sha256Hex,
} from '../src/index.js';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();

/** A local repository with one commit per `files` entry; returns file:// URL and commit shas. */
async function repo(root: string, name: string, commits: Array<Record<string, string>>): Promise<{ url: string; shas: string[] }> {
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

describe('defaultCacheDir', () => {
  it('prefers SPECFIRST_CACHE_DIR, then XDG_CACHE_HOME, then ~/.cache', () => {
    expect(defaultCacheDir({ [CACHE_DIR_ENV]: '/x/c', XDG_CACHE_HOME: '/y' })).toBe('/x/c');
    expect(defaultCacheDir({ XDG_CACHE_HOME: '/y' })).toBe('/y/specfirst');
    expect(defaultCacheDir({})).toMatch(/\.cache\/specfirst$/);
  });
});

describe('prepareErc4626Workspace (local repositories, no network)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  it('checks out the pinned commits, writes the harness, control and foundry.toml, then reuses the cache', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-ws-'));
    const up = await repo(root, 'erc4626-tests', [{ 'ERC4626.test.sol': 'v1' }, { 'ERC4626.test.sol': 'v2' }]);
    const std = await repo(root, 'forge-std', [{ 'Test.sol': 'std' }]);
    const cacheDir = path.join(root, 'cache');

    const first = await prepareErc4626Workspace({ cacheDir, upstream: { repo: up.url, commit: up.shas[1]! }, forgeStd: { repo: std.url, commit: std.shas[0]! } });
    expect(first.dir).toBe(path.join(cacheDir, 'standards', 'erc4626'));
    expect(first.fetched).toEqual([up.url, std.url]);
    expect(await git(path.join(first.dir, 'lib/erc4626-tests'), 'rev-parse', 'HEAD')).toBe(up.shas[1]);
    expect(await readFile(path.join(first.dir, 'lib/erc4626-tests/ERC4626.test.sol'), 'utf8')).toBe('v2');
    const harness = await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8');
    expect(await readFile(path.join(first.dir, ERC4626_HARNESS_PATH), 'utf8')).toBe(harness);
    expect(first.harnessSha256).toBe(sha256Hex(harness));
    expect(harness.startsWith('// SPDX-License-Identifier: AGPL-3.0')).toBe(true);
    expect(await readFile(path.join(first.dir, ERC4626_CONTROL_VAULT_PATH), 'utf8')).toMatch(/^\/\/ SPDX-License-Identifier: MIT/);
    expect(existsSync(path.join(first.dir, ERC4626_CONTROL_PATH))).toBe(true);
    expect(await readFile(path.join(first.dir, 'foundry.toml'), 'utf8')).toBe(ERC4626_FOUNDRY_TOML);

    const mtime = (await stat(path.join(first.dir, ERC4626_HARNESS_PATH))).mtimeMs;
    const again = await prepareErc4626Workspace({ cacheDir, upstream: { repo: up.url, commit: up.shas[1]! }, forgeStd: { repo: std.url, commit: std.shas[0]! } });
    expect(again.fetched).toEqual([]);
    expect((await stat(path.join(first.dir, ERC4626_HARNESS_PATH))).mtimeMs).toBe(mtime);

    // A different pin replaces the checkout.
    const older = await prepareErc4626Workspace({ cacheDir, upstream: { repo: up.url, commit: up.shas[0]! }, forgeStd: { repo: std.url, commit: std.shas[0]! } });
    expect(older.fetched).toEqual([up.url]);
    expect(await readFile(path.join(first.dir, 'lib/erc4626-tests/ERC4626.test.sol'), 'utf8')).toBe('v1');
  });

  it('fails on a commit the repository does not have and leaves no partial checkout', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-ws-'));
    const up = await repo(root, 'erc4626-tests', [{ a: '1' }]);
    const cacheDir = path.join(root, 'cache');
    await expect(
      prepareErc4626Workspace({ cacheDir, upstream: { repo: up.url, commit: 'f'.repeat(40) }, forgeStd: { repo: up.url, commit: up.shas[0]! } }),
    ).rejects.toThrow();
    const lib = path.join(cacheDir, 'standards', 'erc4626', 'lib');
    expect(existsSync(path.join(lib, 'erc4626-tests'))).toBe(false);
    const leftovers = existsSync(lib) ? (await run('ls', ['-a', lib])).stdout.split('\n').filter((l) => l.includes('.tmp-')) : [];
    expect(leftovers).toEqual([]);
  });
});
