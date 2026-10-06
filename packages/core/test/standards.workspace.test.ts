import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
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
  FORGE_GAS_LIMIT,
  ERC4626_HARNESS_PATH,
  ERC4626_SF_PROPERTIES_PATH,
  erc4626SourceFile,
  erc4626WorkspaceDir,
  erc4626WorkspaceFiles,
  EVENTS_DIR,
  prepareErc4626Workspace,
  sha256Hex,
  type PinnedRepo,
} from '../src/index.js';
import { git, localRepo } from './helpers/gitRepo.js';

const run = promisify(execFile);

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

  async function setup() {
    root = await mkdtemp(path.join(tmpdir(), 'specfirst-ws-'));
    const up = await localRepo(root, 'erc4626-tests', [{ 'ERC4626.test.sol': 'v1' }, { 'ERC4626.test.sol': 'v2' }]);
    const std = await localRepo(root, 'forge-std', [{ 'Test.sol': 'std' }]);
    const cacheDir = path.join(root, 'cache');
    const pins = (upCommit = up.shas[1]!): { upstream: PinnedRepo; forgeStd: PinnedRepo } => ({
      upstream: { repo: up.url, commit: upCommit },
      forgeStd: { repo: std.url, commit: std.shas[0]! },
    });
    return { up, std, cacheDir, pins };
  }

  it('checks out the pinned commits into a pin-named directory, writes the harness, control and foundry.toml, then reuses it', async () => {
    const { up, std, cacheDir, pins } = await setup();
    const first = await prepareErc4626Workspace({ cacheDir, ...pins() });
    expect(first.dir).toBe(erc4626WorkspaceDir(cacheDir, pins().upstream, pins().forgeStd));
    expect(path.basename(first.dir)).toMatch(new RegExp(`^erc4626-${up.shas[1]!.slice(0, 12)}-${std.shas[0]!.slice(0, 12)}-[0-9a-f]{8}$`));
    // The last part follows every file the workspace writes, so two builds sharing a cache never rewrite each
    // other's harness or foundry.toml under a running forge.
    const files = erc4626WorkspaceFiles();
    expect(Object.keys(files).sort()).toEqual([ERC4626_CONTROL_VAULT_PATH, 'foundry.toml', ERC4626_CONTROL_PATH, ERC4626_HARNESS_PATH, ERC4626_SF_PROPERTIES_PATH].sort());
    for (const k of Object.keys(files)) {
      expect(erc4626WorkspaceDir(cacheDir, pins().upstream, pins().forgeStd, { ...files, [k]: `${files[k]}\n` })).not.toBe(first.dir);
    }
    expect(first.fetched).toEqual([up.url, std.url]);
    expect(await git(path.join(first.dir, 'lib/erc4626-tests'), 'rev-parse', 'HEAD')).toBe(up.shas[1]);
    const harness = await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8');
    expect(await readFile(path.join(first.dir, ERC4626_HARNESS_PATH), 'utf8')).toBe(harness);
    expect(first.harnessSha256).toBe(sha256Hex(harness));
    expect(first.foundryTomlSha256).toBe(sha256Hex(ERC4626_FOUNDRY_TOML));
    expect(ERC4626_FOUNDRY_TOML).toContain(`fs_permissions = [{ access = "write", path = "./${EVENTS_DIR}" }]`);
    expect(ERC4626_FOUNDRY_TOML).toContain('[profile.default.fuzz]\nmax_test_rejects = 4096\n');
    // A vault burning gas in its view functions gets 100 million per test call, not foundry's 2^30.
    expect(ERC4626_FOUNDRY_TOML).toContain(`\ngas_limit = ${FORGE_GAS_LIMIT}\n`);
    expect(FORGE_GAS_LIMIT).toBe(100_000_000);
    const sf = await readFile(erc4626SourceFile('SpecfirstMaxHonored.t.sol'), 'utf8');
    expect(sf.startsWith('// SPDX-License-Identifier: MIT')).toBe(true);
    // It imports forge-std only, never the upstream suite.
    expect(sf.match(/^import .*$/gm)).toEqual([
      'import {Test} from "forge-std/Test.sol";',
      'import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";',
      'import {Vm, VmSafe} from "forge-std/Vm.sol";',
    ]);
    expect(await readFile(path.join(first.dir, ERC4626_SF_PROPERTIES_PATH), 'utf8')).toBe(sf);
    expect(first.sfPropertiesSha256).toBe(sha256Hex(sf));
    expect(harness.startsWith('// SPDX-License-Identifier: AGPL-3.0')).toBe(true);
    expect(await readFile(path.join(first.dir, ERC4626_CONTROL_VAULT_PATH), 'utf8')).toMatch(/^\/\/ SPDX-License-Identifier: MIT/);
    expect(existsSync(path.join(first.dir, ERC4626_CONTROL_PATH))).toBe(true);
    expect(existsSync(path.join(first.dir, EVENTS_DIR))).toBe(true);

    const mtime = (await stat(path.join(first.dir, ERC4626_HARNESS_PATH))).mtimeMs;
    const again = await prepareErc4626Workspace({ cacheDir, ...pins() });
    expect(again.fetched).toEqual([]);
    expect(again.removed).toEqual([]);
    expect((await stat(path.join(first.dir, ERC4626_HARNESS_PATH))).mtimeMs).toBe(mtime);

    // Another pin is another directory; the first one stays as it was.
    const older = await prepareErc4626Workspace({ cacheDir, ...pins(up.shas[0]!) });
    expect(older.dir).not.toBe(first.dir);
    expect(await readFile(path.join(older.dir, 'lib/erc4626-tests/ERC4626.test.sol'), 'utf8')).toBe('v1');
    expect(await readFile(path.join(first.dir, 'lib/erc4626-tests/ERC4626.test.sol'), 'utf8')).toBe('v2');
    // No temp files are left behind.
    expect(await readdir(path.join(cacheDir, 'standards', '.tmp'))).toEqual([]);
  });

  it('M5: a checkout with an edited or an added file is not reused but fetched again', async () => {
    const { cacheDir, pins } = await setup();
    const ws = await prepareErc4626Workspace({ cacheDir, ...pins() });
    const lib = path.join(ws.dir, 'lib/erc4626-tests');
    await writeFile(path.join(lib, 'ERC4626.test.sol'), 'tampered');
    const edited = await prepareErc4626Workspace({ cacheDir, ...pins() });
    expect(edited.fetched).toEqual([pins().upstream.repo]);
    expect(await readFile(path.join(lib, 'ERC4626.test.sol'), 'utf8')).toBe('v2');

    await writeFile(path.join(ws.dir, 'lib/forge-std/Extra.sol'), 'added');
    const added = await prepareErc4626Workspace({ cacheDir, ...pins() });
    expect(added.fetched).toEqual([pins().forgeStd.repo]);
    expect(existsSync(path.join(ws.dir, 'lib/forge-std/Extra.sol'))).toBe(false);
  });

  it('M5: removes files the workspace does not own (stray tests, remappings.txt, .env, extra libs)', async () => {
    const { cacheDir, pins } = await setup();
    const ws = await prepareErc4626Workspace({ cacheDir, ...pins() });
    await mkdir(path.join(ws.dir, 'test/sub'), { recursive: true });
    await mkdir(path.join(ws.dir, 'lib/evil'), { recursive: true });
    await mkdir(path.join(ws.dir, 'script'), { recursive: true });
    for (const f of ['test/Evil.t.sol', 'test/sub/X.sol', 'src/Other.sol', 'remappings.txt', '.env', 'script/S.s.sol', 'lib/evil/a.sol']) {
      await writeFile(path.join(ws.dir, f), 'x');
    }
    await writeFile(path.join(ws.dir, ERC4626_HARNESS_PATH), 'modified harness');
    const again = await prepareErc4626Workspace({ cacheDir, ...pins() });
    expect(again.removed.sort()).toEqual(['.env', 'lib/evil', 'remappings.txt', 'script', 'src/Other.sol', 'test/Evil.t.sol', 'test/sub/X.sol']);
    expect(await readFile(path.join(ws.dir, ERC4626_HARNESS_PATH), 'utf8')).toBe(await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8'));
    const left = (await run('find', ['.', '-path', './lib', '-prune', '-o', '-type', 'f', '-print'], { cwd: ws.dir })).stdout.trim().split('\n').sort();
    expect(left).toEqual(['./foundry.toml', `./${ERC4626_CONTROL_VAULT_PATH}`, `./${ERC4626_CONTROL_PATH}`, `./${ERC4626_HARNESS_PATH}`, `./${ERC4626_SF_PROPERTIES_PATH}`].sort());
  });

  it('removes event files left by crashed runs after a day, keeps fresh ones', async () => {
    const { cacheDir, pins } = await setup();
    const ws = await prepareErc4626Workspace({ cacheDir, ...pins() });
    const events = path.join(ws.dir, EVENTS_DIR);
    await writeFile(path.join(events, 'old.deposit-below-max.log'), 'x');
    await writeFile(path.join(events, 'fresh.deposit-below-max.log'), 'x');
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(path.join(events, 'old.deposit-below-max.log'), twoDaysAgo, twoDaysAgo);
    await prepareErc4626Workspace({ cacheDir, ...pins() });
    expect(await readdir(events)).toEqual(['fresh.deposit-below-max.log']);
  });

  it('fails on a commit the repository does not have and leaves no partial checkout', async () => {
    const { cacheDir, up } = await setup();
    await expect(
      prepareErc4626Workspace({ cacheDir, upstream: { repo: up.url, commit: 'f'.repeat(40) }, forgeStd: { repo: up.url, commit: up.shas[0]! } }),
    ).rejects.toThrow();
    const dir = erc4626WorkspaceDir(cacheDir, { repo: up.url, commit: 'f'.repeat(40) }, { repo: up.url, commit: up.shas[0]! });
    expect(existsSync(path.join(dir, 'lib', 'erc4626-tests'))).toBe(false);
    expect(await readdir(path.join(cacheDir, 'standards', '.tmp'))).toEqual([]);
  });

  it('ignores GIT_DIR and GIT_WORK_TREE from the environment', async () => {
    const { cacheDir, pins } = await setup();
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
    process.env.GIT_DIR = path.join(root!, 'nowhere/.git');
    process.env.GIT_WORK_TREE = path.join(root!, 'nowhere');
    try {
      const ws = await prepareErc4626Workspace({ cacheDir, ...pins() });
      expect(ws.fetched).toHaveLength(2);
      expect(existsSync(path.join(root!, 'nowhere'))).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
