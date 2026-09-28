import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Spec } from '../spec/schema.js';
import { invariantSetHash, propertyHash, specHash, type Bytes32 } from '../spec/hash.js';

const execFileAsync = promisify(execFile);

/** CLI exit code when the current project no longer matches .specfirst/lock.json. */
export const LOCK_MISMATCH_EXIT_CODE = 11;
/** CLI exit code when a mutant fails to break the property it targets. */
export const MUTANT_CHECK_EXIT_CODE = 3;

export const LOCK_DIR = '.specfirst';
export const LOCK_FILE = 'lock.json';
export const PROPERTIES_DIR = 'test/specfirst';

export interface LockedFile {
  /** Path relative to the project root, forward slashes. */
  path: string;
  /** 0x-prefixed sha256 of the file bytes. */
  sha256: Bytes32;
}

export interface LockedSubmodule {
  /** Path relative to the project root, e.g. lib/forge-std. */
  path: string;
  /** Checked-out commit, or null when it cannot be determined. */
  commit: string | null;
}

export interface LockFile {
  version: 1;
  createdAt: string;
  specPath: string;
  solc: string;
  specHash: Bytes32;
  invariantSetHash: Bytes32;
  propertyHash: Bytes32;
  properties: LockedFile[];
  foundryToml: Bytes32 | null;
  remappings: Bytes32 | null;
  submodules: LockedSubmodule[];
}

export type LockMismatchKind =
  | 'lock-missing'
  | 'lock-invalid'
  | 'spec'
  | 'invariant-set'
  | 'solc'
  | 'property-changed'
  | 'property-added'
  | 'property-removed'
  | 'property-hash'
  | 'foundry-toml'
  | 'remappings'
  | 'submodule-changed'
  | 'submodule-added'
  | 'submodule-removed';

export interface LockMismatch {
  kind: LockMismatchKind;
  path?: string;
  expected: string | null;
  actual: string | null;
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

export function lockPath(projectDir: string): string {
  return path.join(projectDir, LOCK_DIR, LOCK_FILE);
}

function sha256Bytes(data: Uint8Array): Bytes32 {
  return `0x${createHash('sha256').update(data).digest('hex')}`;
}

function byPath<T extends { path: string }>(a: T, b: T): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function hashFileOrNull(file: string): Promise<Bytes32 | null> {
  try {
    return sha256Bytes(await readFile(file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function walkFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkFiles(root, full, out);
    } else if (entry.isFile() || (entry.isSymbolicLink() && (await stat(full)).isFile())) {
      out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }
}

/** sha256 of every file under test/specfirst, sorted by path. */
export async function hashPropertyFiles(projectDir: string): Promise<LockedFile[]> {
  const dir = path.join(projectDir, PROPERTIES_DIR);
  if (!existsSync(dir)) return [];
  const rel: string[] = [];
  await walkFiles(projectDir, dir, rel);
  const files = await Promise.all(
    rel.map(async (p) => ({ path: p, sha256: sha256Bytes(await readFile(path.join(projectDir, p))) })),
  );
  return files.sort(byPath);
}

/** Commits from `git submodule status`, only when projectDir is itself the repository root. */
async function gitSubmoduleCommits(projectDir: string): Promise<Map<string, string> | null> {
  try {
    const top = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: projectDir });
    const [a, b] = await Promise.all([realpath(top.stdout.trim()), realpath(projectDir)]);
    if (a !== b) return null;
    const { stdout } = await execFileAsync('git', ['submodule', 'status'], { cwd: projectDir });
    const map = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      // Format: "<flag><sha> <path>[ (<describe>)]", flag is one of ' ', '-', '+', 'U'.
      const m = /^[ \-+U]?([0-9a-f]{40,64}) (\S+)/.exec(line);
      if (m) map.set(m[2]!, m[1]!);
    }
    return map;
  } catch {
    return null;
  }
}

async function readTrim(file: string): Promise<string | null> {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

/** Fallback when git is unavailable: resolve HEAD from the submodule's .git directory or gitdir file. */
async function headFromDotGit(moduleDir: string): Promise<string | null> {
  const dotGit = path.join(moduleDir, '.git');
  let gitDir = dotGit;
  try {
    const st = await stat(dotGit);
    if (st.isFile()) {
      const content = await readTrim(dotGit);
      const m = content ? /^gitdir:\s*(.+)$/m.exec(content) : null;
      if (!m) return null;
      gitDir = path.resolve(moduleDir, m[1]!.trim());
    }
  } catch {
    return null;
  }
  const head = await readTrim(path.join(gitDir, 'HEAD'));
  if (!head) return null;
  if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  const loose = await readTrim(path.join(gitDir, ref));
  if (loose && /^[0-9a-f]{40,64}$/.test(loose)) return loose;
  const packed = await readTrim(path.join(gitDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split('\n')) {
      const [sha, name] = line.split(' ');
      if (name === ref && sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
    }
  }
  return null;
}

/** One entry per directory under lib/, commit from git when possible, else from .git HEAD, else null. */
export async function readSubmodules(projectDir: string): Promise<LockedSubmodule[]> {
  const libDir = path.join(projectDir, 'lib');
  if (!existsSync(libDir)) return [];
  const gitMap = await gitSubmoduleCommits(projectDir);
  const entries = await readdir(libDir, { withFileTypes: true });
  const out: LockedSubmodule[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const rel = `lib/${entry.name}`;
    const commit = gitMap?.get(rel) ?? (await headFromDotGit(path.join(libDir, entry.name)));
    out.push({ path: rel, commit });
  }
  return out.sort(byPath);
}

export type LockState = Omit<LockFile, 'version' | 'createdAt' | 'specPath'>;

/** Recompute every locked value from the current project tree and spec. */
export async function computeLockState(projectDir: string, spec: Spec): Promise<LockState> {
  const [properties, foundryToml, remappings, submodules] = await Promise.all([
    hashPropertyFiles(projectDir),
    hashFileOrNull(path.join(projectDir, 'foundry.toml')),
    hashFileOrNull(path.join(projectDir, 'remappings.txt')),
    readSubmodules(projectDir),
  ]);
  return {
    solc: spec.solc,
    specHash: specHash(spec),
    invariantSetHash: invariantSetHash(spec),
    propertyHash: propertyHash(properties),
    properties,
    foundryToml,
    remappings,
    submodules,
  };
}

export interface CreateLockInput {
  projectDir: string;
  spec: Spec;
  /** Spec file path, stored relative to projectDir. */
  specPath: string;
}

/** Compute the lock and write it to <projectDir>/.specfirst/lock.json. */
export async function createLock({ projectDir, spec, specPath }: CreateLockInput): Promise<LockFile> {
  const state = await computeLockState(projectDir, spec);
  if (state.properties.length === 0) {
    throw new LockError(`no property files under ${PROPERTIES_DIR}; nothing to lock`);
  }
  const relSpec = path.isAbsolute(specPath) ? path.relative(projectDir, specPath) : specPath;
  const lock: LockFile = {
    version: 1,
    createdAt: new Date().toISOString(),
    specPath: relSpec.split(path.sep).join('/'),
    ...state,
  };
  await mkdir(path.join(projectDir, LOCK_DIR), { recursive: true });
  await writeFile(lockPath(projectDir), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

export async function readLock(projectDir: string): Promise<LockFile | null> {
  let text: string;
  try {
    text = await readFile(lockPath(projectDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed = JSON.parse(text) as LockFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.properties) || !Array.isArray(parsed.submodules)) {
    throw new LockError(`unsupported or malformed ${LOCK_DIR}/${LOCK_FILE}`);
  }
  return parsed;
}

function diffByPath<T extends { path: string }>(
  expected: T[],
  actual: T[],
  value: (t: T) => string | null,
  kinds: { changed: LockMismatchKind; added: LockMismatchKind; removed: LockMismatchKind },
): LockMismatch[] {
  const out: LockMismatch[] = [];
  const act = new Map(actual.map((a) => [a.path, a]));
  const exp = new Map(expected.map((e) => [e.path, e]));
  for (const e of expected) {
    const a = act.get(e.path);
    if (!a) out.push({ kind: kinds.removed, path: e.path, expected: value(e), actual: null });
    else if (value(a) !== value(e)) out.push({ kind: kinds.changed, path: e.path, expected: value(e), actual: value(a) });
  }
  for (const a of actual) {
    if (!exp.has(a.path)) out.push({ kind: kinds.added, path: a.path, expected: null, actual: value(a) });
  }
  return out;
}

export interface VerifyLockInput {
  projectDir: string;
  spec: Spec;
}

/** Compare the current project against the stored lock. An empty array means the lock holds. */
export async function verifyLock({ projectDir, spec }: VerifyLockInput): Promise<LockMismatch[]> {
  let lock: LockFile | null;
  try {
    lock = await readLock(projectDir);
  } catch (err) {
    return [{ kind: 'lock-invalid', expected: null, actual: (err as Error).message }];
  }
  if (!lock) return [{ kind: 'lock-missing', path: `${LOCK_DIR}/${LOCK_FILE}`, expected: null, actual: null }];

  const cur = await computeLockState(projectDir, spec);
  const out: LockMismatch[] = [];
  const scalar = (kind: LockMismatchKind, expected: string | null, actual: string | null, p?: string) => {
    if (expected !== actual) out.push({ kind, ...(p ? { path: p } : {}), expected, actual });
  };
  scalar('spec', lock.specHash, cur.specHash, lock.specPath);
  scalar('invariant-set', lock.invariantSetHash, cur.invariantSetHash);
  scalar('solc', lock.solc, cur.solc);
  out.push(
    ...diffByPath(lock.properties, cur.properties, (f) => f.sha256, {
      changed: 'property-changed',
      added: 'property-added',
      removed: 'property-removed',
    }),
  );
  scalar('property-hash', lock.propertyHash, cur.propertyHash);
  scalar('foundry-toml', lock.foundryToml, cur.foundryToml, 'foundry.toml');
  scalar('remappings', lock.remappings, cur.remappings, 'remappings.txt');
  out.push(
    ...diffByPath(lock.submodules, cur.submodules, (s) => s.commit, {
      changed: 'submodule-changed',
      added: 'submodule-added',
      removed: 'submodule-removed',
    }),
  );
  return out;
}
