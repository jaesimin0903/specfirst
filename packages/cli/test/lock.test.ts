import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerLockCommand } from '../src/commands/lock.js';
import { buildProgram } from './helpers/program.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// test/ -> cli/ -> packages/ -> repo root -> examples/staking-vault
const FIXTURE_ROOT = path.resolve(here, '..', '..', '..', 'examples', 'staking-vault');

async function seedFixture(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'spec'), { recursive: true });
  await cp(
    path.join(FIXTURE_ROOT, 'spec', 'staking-vault.spec.yaml'),
    path.join(dir, 'spec', 'staking-vault.spec.yaml'),
  );
  await cp(path.join(FIXTURE_ROOT, 'test', 'specfirst'), path.join(dir, 'test', 'specfirst'), { recursive: true });
}

describe('specfirst lock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-lock-'));
    await seedFixture(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('writes .specfirst/lock.json with specHash, invariantSetHash, and propertyHash', async () => {
    const program = buildProgram(registerLockCommand);
    await program.parseAsync(['node', 'specfirst', '--project', dir, 'lock', 'spec/staking-vault.spec.yaml']);

    expect(process.exitCode ?? 0).toBe(0);
    const lock = JSON.parse(await readFile(path.join(dir, '.specfirst/lock.json'), 'utf8'));
    expect(lock.specHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lock.invariantSetHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lock.propertyHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(lock.properties.length).toBeGreaterThan(0);
  });

  it('prints the three hashes and the mutant-check placeholder', async () => {
    const program = buildProgram(registerLockCommand);
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };
    try {
      await program.parseAsync(['node', 'specfirst', '--project', dir, 'lock', 'spec/staking-vault.spec.yaml']);
    } finally {
      console.log = originalLog;
    }
    expect(logs.some((l) => l.includes('specHash:'))).toBe(true);
    expect(logs.some((l) => l.includes('invariantSetHash:'))).toBe(true);
    expect(logs.some((l) => l.includes('propertyHash:'))).toBe(true);
    expect(logs.some((l) => l.includes('mutant check: not implemented yet'))).toBe(true);
  });

  it('exits with code 2 when the spec file is missing', async () => {
    const program = buildProgram(registerLockCommand);
    await program.parseAsync(['node', 'specfirst', '--project', dir, 'lock', 'spec/does-not-exist.yaml']);
    expect(process.exitCode).toBe(2);
  });
});
