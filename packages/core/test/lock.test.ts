import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { createLock, parseSpec, propertyHash, readLock, verifyLock, type Spec } from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PROJECT = path.join(here, 'fixtures/project');
const specText = readFileSync(path.join(here, 'fixtures/specs/valid.spec.yaml'), 'utf8');
const SUBMODULE_COMMIT = 'a'.repeat(40);

let dir: string;
let spec: Spec;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'specfirst-lock-'));
  await cp(FIXTURE_PROJECT, dir, { recursive: true });
  await mkdir(path.join(dir, 'spec'), { recursive: true });
  await writeFile(path.join(dir, 'spec/vault.spec.yaml'), specText);
  // Fake submodule checkout without git metadata beyond HEAD (git cannot commit a nested .git).
  await mkdir(path.join(dir, 'lib/forge-std/.git'), { recursive: true });
  await writeFile(path.join(dir, 'lib/forge-std/.git/HEAD'), `${SUBMODULE_COMMIT}\n`);
  spec = parseSpec(specText);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const lockNow = () => createLock({ projectDir: dir, spec, specPath: 'spec/vault.spec.yaml' });

async function editFile(rel: string, fn: (s: string) => string): Promise<void> {
  const p = path.join(dir, rel);
  await writeFile(p, fn(await readFile(p, 'utf8')));
}

describe('createLock', () => {
  it('records property files, config hashes, submodules, solc and the three hashes', async () => {
    const lock = await lockNow();
    expect(lock.properties.map((f) => f.path)).toEqual([
      'test/specfirst/Invariants.t.sol',
      'test/specfirst/SpecfirstProps.sol',
      'test/specfirst/regressions/.gitkeep',
    ]);
    expect(lock.foundryToml).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lock.remappings).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lock.submodules).toEqual([{ path: 'lib/forge-std', commit: SUBMODULE_COMMIT }]);
    expect(lock.solc).toBe('0.8.28');
    expect(lock.specPath).toBe('spec/vault.spec.yaml');
    const expectedProp = keccak256(toHex(lock.properties.map((f) => `${f.path}:${f.sha256}`).join('\n')));
    expect(lock.propertyHash).toBe(expectedProp);
    expect(propertyHash([...lock.properties].reverse())).toBe(expectedProp);
    expect(await readLock(dir)).toEqual(lock);
  });

  it('stores null for missing foundry.toml and remappings.txt', async () => {
    await rm(path.join(dir, 'foundry.toml'));
    await rm(path.join(dir, 'remappings.txt'));
    const lock = await lockNow();
    expect(lock.foundryToml).toBeNull();
    expect(lock.remappings).toBeNull();
  });

  it('resolves a symbolic HEAD through refs and packed-refs', async () => {
    const gitDir = path.join(dir, 'lib/forge-std/.git');
    await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(gitDir, 'packed-refs'), `# pack-refs\n${'b'.repeat(40)} refs/heads/main\n`);
    expect((await lockNow()).submodules[0]!.commit).toBe('b'.repeat(40));
  });

  it('uses git submodule status when the project is a git repository', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'protocol.file.allow=always', ...args], {
        cwd: dir,
        stdio: 'pipe',
      });
    const sub = await mkdtemp(path.join(tmpdir(), 'specfirst-sub-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: sub });
      await writeFile(path.join(sub, 'README'), 'x');
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'], { cwd: sub });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: sub });
      const subHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sub }).toString().trim();
      await rm(path.join(dir, 'lib'), { recursive: true });
      git('init', '-q');
      git('submodule', 'add', '-q', sub, 'lib/dep');
      const lock = await lockNow();
      expect(lock.submodules).toEqual([{ path: 'lib/dep', commit: subHead }]);
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });
});

describe('verifyLock', () => {
  it('passes right after createLock', async () => {
    await lockNow();
    expect(await verifyLock({ projectDir: dir, spec })).toEqual([]);
  });

  it('reports a missing lock', async () => {
    const m = await verifyLock({ projectDir: dir, spec });
    expect(m.map((x) => x.kind)).toEqual(['lock-missing']);
  });

  it('detects a one character change in SpecfirstProps.sol', async () => {
    await lockNow();
    await editFile('test/specfirst/SpecfirstProps.sol', (s) => s.replace('== sum', '>= sum'));
    const m = await verifyLock({ projectDir: dir, spec });
    expect(m.map((x) => x.kind).sort()).toEqual(['property-changed', 'property-hash']);
    expect(m.find((x) => x.kind === 'property-changed')!.path).toBe('test/specfirst/SpecfirstProps.sol');
  });

  it('detects a foundry.toml change', async () => {
    await lockNow();
    await editFile('foundry.toml', (s) => `${s}optimizer = true\n`);
    const m = await verifyLock({ projectDir: dir, spec });
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ kind: 'foundry-toml', path: 'foundry.toml' });
  });

  it('detects remappings, submodule, solc and spec changes', async () => {
    await lockNow();
    await editFile('remappings.txt', (s) => `${s}ds-test/=lib/ds-test/src/\n`);
    await writeFile(path.join(dir, 'lib/forge-std/.git/HEAD'), `${'c'.repeat(40)}\n`);
    const changed = parseSpec(specText.replace('"0.8.28"', '"0.8.29"'));
    const kinds = (await verifyLock({ projectDir: dir, spec: changed })).map((x) => x.kind).sort();
    expect(kinds).toEqual(['remappings', 'solc', 'spec', 'submodule-changed']);
  });

  it('detects an added regression file and a changed propertyHash on re-lock', async () => {
    const before = await lockNow();
    await writeFile(path.join(dir, 'test/specfirst/regressions/Reentrancy_INV1.t.sol'), '// regression PoC\n');
    const m = await verifyLock({ projectDir: dir, spec });
    expect(m.map((x) => x.kind).sort()).toEqual(['property-added', 'property-hash']);
    const after = await lockNow();
    expect(after.propertyHash).not.toBe(before.propertyHash);
    expect(after.specHash).toBe(before.specHash);
    expect(after.invariantSetHash).toBe(before.invariantSetHash);
    expect(await verifyLock({ projectDir: dir, spec })).toEqual([]);
  });

  it('detects a removed property file', async () => {
    await lockNow();
    await rm(path.join(dir, 'test/specfirst/Invariants.t.sol'));
    const kinds = (await verifyLock({ projectDir: dir, spec })).map((x) => x.kind).sort();
    expect(kinds).toEqual(['property-hash', 'property-removed']);
  });
});
