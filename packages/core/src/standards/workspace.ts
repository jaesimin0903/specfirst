import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import type { Hex } from 'viem';
import { sha256Hex } from '../spec/hash.js';
import {
  ERC4626_CONTROL_PATH,
  ERC4626_CONTROL_VAULT_PATH,
  ERC4626_HARNESS_PATH,
  ERC4626_SF_PROPERTIES_PATH,
  ERC4626_UPSTREAM,
  erc4626SourceFile,
  FORGE_STD_PIN,
  type PinnedRepo,
} from './erc4626.js';

export const CACHE_DIR_ENV = 'SPECFIRST_CACHE_DIR';
/** Directory (inside the workspace) the harness may write its event files to; see fs_permissions. */
export const EVENTS_DIR = 'sf-events';

/**
 * Rejected inputs forge tolerates per test before it gives up ("too many rejects"). forge's default, 65536,
 * let a vault whose withdraw always reverts run into the one-hour timeout; at 4096 such a property ends
 * inconclusive within minutes.
 */
export const FUZZ_MAX_TEST_REJECTS = 4096;

/** The Foundry project every ERC-4626 check runs in. Pinned solc keeps compiles reproducible. */
export const ERC4626_FOUNDRY_TOML = `[profile.default]
src = "src"
test = "test"
libs = ["lib"]
solc_version = "0.8.28"
evm_version = "prague"
remappings = ["forge-std/=lib/forge-std/src/", "erc4626-tests/=lib/erc4626-tests/"]
fs_permissions = [{ access = "write", path = "./${EVENTS_DIR}" }]

[profile.default.fuzz]
max_test_rejects = ${FUZZ_MAX_TEST_REJECTS}
`;

/** $SPECFIRST_CACHE_DIR, else $XDG_CACHE_HOME/specfirst, else ~/.cache/specfirst. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env[CACHE_DIR_ENV]) return path.resolve(env[CACHE_DIR_ENV]!);
  if (env.XDG_CACHE_HOME) return path.join(env.XDG_CACHE_HOME, 'specfirst');
  return path.join(homedir(), '.cache', 'specfirst');
}

/** `<cacheDir>/standards/erc4626-<upstream 12>-<forge-std 12>`: one workspace per pin pair. */
export function erc4626WorkspaceDir(cacheDir: string, upstream: PinnedRepo, forgeStd: PinnedRepo): string {
  return path.join(cacheDir, 'standards', `erc4626-${upstream.commit.slice(0, 12)}-${forgeStd.commit.slice(0, 12)}`);
}

export interface StandardWorkspace {
  /** Foundry project root; forge runs here. */
  dir: string;
  /** Harness path relative to dir. */
  harnessPath: string;
  harnessSha256: Hex;
  /** sha256 of SpecfirstMaxHonored.t.sol, Specfirst's own properties. */
  sfPropertiesSha256: Hex;
  foundryTomlSha256: Hex;
  upstream: PinnedRepo;
  forgeStd: PinnedRepo;
  /** Repositories fetched by this call; empty when the cache was reused as is. */
  fetched: string[];
  /** Workspace paths removed because they are not part of it (stray tests, remappings.txt, .env, ...). */
  removed: string[];
}

export interface PrepareWorkspaceInput {
  cacheDir?: string;
  /** Test hooks: other pins or local repositories instead of GitHub. */
  upstream?: PinnedRepo;
  forgeStd?: PinnedRepo;
}

/** The environment without GIT_* variables, so GIT_DIR or GIT_WORK_TREE cannot redirect cache commands. */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execa('git', args, { cwd, env: gitEnv(), extendEnv: false });
  return String(stdout).trim();
}

/** HEAD of a checkout that is exactly the commit with nothing modified or added; null otherwise. */
async function cleanHeadOf(dir: string): Promise<string | null> {
  if (!existsSync(path.join(dir, '.git'))) return null;
  try {
    const head = await git(dir, ['rev-parse', 'HEAD']);
    const status = await git(dir, ['status', '--porcelain', '--untracked-files=all']);
    return status === '' ? head : null;
  } catch {
    return null;
  }
}

/**
 * Checks out `pin.commit` of `pin.repo` at `dest` with a depth-1 fetch of that exact commit, so no branch
 * or tag can move under us. A checkout is reused only when it is at the commit and `git status` is empty
 * (no edited or added file); anything else is fetched again. Clones go to a temp directory first and are
 * renamed into place, so an interrupted fetch never leaves a half-filled checkout behind.
 */
async function ensureCheckout(dest: string, pin: PinnedRepo, tmpRoot: string): Promise<boolean> {
  if ((await cleanHeadOf(dest)) === pin.commit) return false;
  const tmp = path.join(tmpRoot, `${path.basename(dest)}-${process.pid}-${randomBytes(4).toString('hex')}`);
  await mkdir(tmp, { recursive: true });
  try {
    await git(tmp, ['init', '-q']);
    await git(tmp, ['remote', 'add', 'origin', pin.repo]);
    await git(tmp, ['fetch', '-q', '--depth', '1', 'origin', pin.commit]);
    await git(tmp, ['-c', 'advice.detachedHead=false', 'checkout', '-q', 'FETCH_HEAD']);
    const head = await git(tmp, ['rev-parse', 'HEAD']);
    if (head !== pin.commit) throw new Error(`${pin.repo}: fetched ${head}, expected ${pin.commit}`);
    if ((await cleanHeadOf(dest)) === pin.commit) {
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

/**
 * Writes `content` only when the file differs, so forge's compile cache stays valid across runs. The new
 * content goes to a temp file outside the workspace and is renamed into place, so a concurrent check never
 * reads half a file.
 */
async function writeIfChanged(file: string, content: string, tmpRoot: string): Promise<void> {
  if (existsSync(file) && (await readFile(file, 'utf8')) === content) return;
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(tmpRoot, `${path.basename(file)}-${process.pid}-${randomBytes(4).toString('hex')}`);
  await writeFile(tmp, content);
  await rename(tmp, file);
}

/** Top-level entries a workspace may hold. forge reads remappings.txt and .env from here, so nothing else. */
const TOP_LEVEL = new Set(['lib', 'src', 'test', 'foundry.toml', 'out', 'cache', EVENTS_DIR]);
const LIB = new Set(['erc4626-tests', 'forge-std']);
const STALE_EVENTS_MS = 24 * 60 * 60 * 1000;

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(path.join(dir, e.name), r)));
    else out.push(r);
  }
  return out;
}

/** Removes everything in the workspace that this module did not put there. Returns the removed paths. */
async function prune(dir: string, expected: ReadonlySet<string>): Promise<string[]> {
  const removed: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (!TOP_LEVEL.has(e.name)) {
      await rm(path.join(dir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
  }
  for (const e of existsSync(path.join(dir, 'lib')) ? await readdir(path.join(dir, 'lib')) : []) {
    if (!LIB.has(e)) {
      await rm(path.join(dir, 'lib', e), { recursive: true, force: true });
      removed.push(`lib/${e}`);
    }
  }
  for (const sub of ['src', 'test']) {
    for (const f of await listFiles(path.join(dir, sub))) {
      const rel = `${sub}/${f}`;
      if (!expected.has(rel)) {
        await rm(path.join(dir, rel), { force: true });
        removed.push(rel);
      }
    }
  }
  return removed;
}

/**
 * Prepares (or reuses) `<cacheDir>/standards/erc4626-<pins>`: the pinned upstream suite and forge-std under
 * lib/, foundry.toml, the harness, Specfirst's own properties and the positive control under test/, the
 * control vault under src/, and nothing else. The cache lives outside any project because the upstream
 * code is AGPL-3.0 and must not end up committed in a user's repository.
 */
export async function prepareErc4626Workspace(input: PrepareWorkspaceInput = {}): Promise<StandardWorkspace> {
  const upstream = input.upstream ?? ERC4626_UPSTREAM;
  const forgeStd = input.forgeStd ?? { repo: FORGE_STD_PIN.repo, commit: FORGE_STD_PIN.commit };
  const cacheDir = input.cacheDir ?? defaultCacheDir();
  const dir = erc4626WorkspaceDir(cacheDir, upstream, forgeStd);
  const tmpRoot = path.join(cacheDir, 'standards', '.tmp');
  await mkdir(tmpRoot, { recursive: true });
  await mkdir(path.join(dir, 'src'), { recursive: true });

  const fetched: string[] = [];
  if (await ensureCheckout(path.join(dir, 'lib', 'erc4626-tests'), upstream, tmpRoot)) fetched.push(upstream.repo);
  if (await ensureCheckout(path.join(dir, 'lib', 'forge-std'), forgeStd, tmpRoot)) fetched.push(forgeStd.repo);

  const files: Record<string, string> = {
    [ERC4626_HARNESS_PATH]: await readFile(erc4626SourceFile('SpecfirstERC4626.t.sol'), 'utf8'),
    [ERC4626_SF_PROPERTIES_PATH]: await readFile(erc4626SourceFile('SpecfirstMaxHonored.t.sol'), 'utf8'),
    // The positive control compiles with the harness but only runs under its own --match-path.
    [ERC4626_CONTROL_PATH]: await readFile(erc4626SourceFile('control/SpecfirstERC4626Control.t.sol'), 'utf8'),
    [ERC4626_CONTROL_VAULT_PATH]: await readFile(erc4626SourceFile('control/BrokenVault.sol'), 'utf8'),
    'foundry.toml': ERC4626_FOUNDRY_TOML,
  };
  const removed = await prune(dir, new Set(Object.keys(files)));
  for (const [rel, content] of Object.entries(files)) await writeIfChanged(path.join(dir, rel), content, tmpRoot);
  await mkdir(path.join(dir, EVENTS_DIR), { recursive: true });
  // Event files are removed by the run that wrote them; one left by a crashed run goes after a day.
  for (const f of await readdir(path.join(dir, EVENTS_DIR))) {
    const file = path.join(dir, EVENTS_DIR, f);
    if (Date.now() - (await stat(file)).mtimeMs > STALE_EVENTS_MS) await rm(file, { force: true });
  }

  return {
    dir,
    harnessPath: ERC4626_HARNESS_PATH,
    harnessSha256: sha256Hex(files[ERC4626_HARNESS_PATH]!),
    sfPropertiesSha256: sha256Hex(files[ERC4626_SF_PROPERTIES_PATH]!),
    foundryTomlSha256: sha256Hex(ERC4626_FOUNDRY_TOML),
    upstream,
    forgeStd,
    fetched,
    removed,
  };
}
