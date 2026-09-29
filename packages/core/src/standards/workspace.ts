import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Hex } from 'viem';
import { sha256Hex } from '../spec/hash.js';
import {
  ERC4626_CONTROL_PATH,
  ERC4626_CONTROL_VAULT_PATH,
  ERC4626_HARNESS_PATH,
  ERC4626_UPSTREAM,
  erc4626SourceFile,
  FORGE_STD_PIN,
  type PinnedRepo,
} from './erc4626.js';

export const CACHE_DIR_ENV = 'SPECFIRST_CACHE_DIR';

/** The Foundry project every ERC-4626 check runs in. Pinned solc keeps compiles reproducible. */
export const ERC4626_FOUNDRY_TOML = `[profile.default]
src = "src"
test = "test"
libs = ["lib"]
solc_version = "0.8.28"
evm_version = "prague"
remappings = ["forge-std/=lib/forge-std/src/", "erc4626-tests/=lib/erc4626-tests/"]
`;

/** $SPECFIRST_CACHE_DIR, else $XDG_CACHE_HOME/specfirst, else ~/.cache/specfirst. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env[CACHE_DIR_ENV]) return path.resolve(env[CACHE_DIR_ENV]!);
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'specfirst');
  return path.join(homedir(), '.cache', 'specfirst');
}

export interface StandardWorkspace {
  /** Foundry project root; forge runs here. */
  dir: string;
  /** Harness path relative to dir. */
  harnessPath: string;
  harnessSha256: Hex;
  upstream: PinnedRepo;
  forgeStd: PinnedRepo;
  /** Repositories fetched by this call; empty when the cache was reused as is. */
  fetched: string[];
}

export interface PrepareWorkspaceInput {
  cacheDir?: string;
  /** Test hooks: other pins or local repositories instead of GitHub. */
  upstream?: PinnedRepo;
  forgeStd?: PinnedRepo;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd });
  return String(stdout).trim();
}

async function headOf(dir: string): Promise<string | null> {
  if (!existsSync(path.join(dir, '.git'))) return null;
  try {
    return await git(dir, ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

/**
 * Checks out `pin.commit` of `pin.repo` at `dest` with a depth-1 fetch of that exact commit, so no branch
 * or tag can move under us. A checkout already at the commit is reused. Clones go to a temp directory
 * first and are renamed into place, so an interrupted fetch never leaves a half-filled checkout behind.
 */
async function ensureCheckout(dest: string, pin: PinnedRepo): Promise<boolean> {
  if ((await headOf(dest)) === pin.commit) return false;
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    await git(tmp, ['init', '-q']);
    await git(tmp, ['remote', 'add', 'origin', pin.repo]);
    await git(tmp, ['fetch', '-q', '--depth', '1', 'origin', pin.commit]);
    await git(tmp, ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
    const head = await git(tmp, ['rev-parse', 'HEAD']);
    if (head !== pin.commit) throw new Error(`${pin.repo}: fetched ${head}, expected ${pin.commit}`);
    if ((await headOf(dest)) === pin.commit) {
      // A concurrent check finished the same checkout first; keep theirs.
      await rm(tmp, { recursive: true, force: true });
      return false;
    }
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  return true;
}

/** Writes `content` only when the file differs, so forge's compile cache stays valid across runs. */
async function writeIfChanged(file: string, content: string): Promise<void> {
  if (existsSync(file) && (await readFile(file, 'utf8')) === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/**
 * Prepares (or reuses) `<cacheDir>/standards/erc4626`: the pinned upstream suite and forge-std under lib/,
 * foundry.toml, the harness and its positive control under test/, the control vault under src/. The cache lives outside any project because the upstream
 * code is AGPL-3.0 and must not end up committed in a user's repository.
 */
export async function prepareErc4626Workspace(input: PrepareWorkspaceInput = {}): Promise<StandardWorkspace> {
  const upstream = input.upstream ?? ERC4626_UPSTREAM;
  const forgeStd = input.forgeStd ?? { repo: FORGE_STD_PIN.repo, commit: FORGE_STD_PIN.commit };
  const dir = path.join(input.cacheDir ?? defaultCacheDir(), 'standards', 'erc4626');
  await mkdir(path.join(dir, 'src'), { recursive: true });

  const fetched: string[] = [];
  if (await ensureCheckout(path.join(dir, 'lib', 'erc4626-tests'), upstream)) fetched.push(upstream.repo);
  if (await ensureCheckout(path.join(dir, 'lib', 'forge-std'), forgeStd)) fetched.push(forgeStd.repo);

  const harness = await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8');
  await writeIfChanged(path.join(dir, ERC4626_HARNESS_PATH), harness);
  // The positive control compiles with the harness but only runs under its own --match-path.
  await writeIfChanged(path.join(dir, ERC4626_CONTROL_PATH), await readFile(erc4626SourceFile('control/SpecfirstERC4626Control.t.sol'), 'utf8'));
  await writeIfChanged(path.join(dir, ERC4626_CONTROL_VAULT_PATH), await readFile(erc4626SourceFile('control/BrokenVault.sol'), 'utf8'));
  await writeIfChanged(path.join(dir, 'foundry.toml'), ERC4626_FOUNDRY_TOML);

  return {
    dir,
    harnessPath: ERC4626_HARNESS_PATH,
    harnessSha256: sha256Hex(harness),
    upstream,
    forgeStd,
    fetched,
  };
}
