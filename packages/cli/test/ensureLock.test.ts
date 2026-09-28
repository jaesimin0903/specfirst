import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLock, parseSpec } from '@specfirst/core';
import { LockMismatchError, ensureLock } from '../src/lib/ensureLock.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(here, '..', '..', '..', 'examples', 'staking-vault');
const SPEC_REL = 'spec/staking-vault.spec.yaml';

describe('ensureLock', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-ensurelock-'));
    await mkdir(path.join(dir, 'spec'), { recursive: true });
    await cp(path.join(FIXTURE_ROOT, 'spec', 'staking-vault.spec.yaml'), path.join(dir, SPEC_REL));
    await cp(path.join(FIXTURE_ROOT, 'test', 'specfirst'), path.join(dir, 'test', 'specfirst'), { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves when the project still matches the lock', async () => {
    const spec = parseSpec(await readFile(path.join(dir, SPEC_REL), 'utf8'));
    await createLock({ projectDir: dir, spec, specPath: SPEC_REL });

    await expect(ensureLock({ projectDir: dir, spec })).resolves.toBeUndefined();
  });

  it('rejects with LockMismatchError (exitCode 11) when a locked property file changes after lock', async () => {
    const spec = parseSpec(await readFile(path.join(dir, SPEC_REL), 'utf8'));
    await createLock({ projectDir: dir, spec, specPath: SPEC_REL });

    await writeFile(path.join(dir, 'test/specfirst/IVault.sol'), '// tampered after lock\n');

    const err = await ensureLock({ projectDir: dir, spec }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockMismatchError);
    expect((err as LockMismatchError).exitCode).toBe(11);
    expect((err as LockMismatchError).mismatches.some((m) => m.kind === 'property-changed')).toBe(true);
  });

  it('rejects with LockMismatchError (exitCode 11) when there is no lock file at all', async () => {
    const spec = parseSpec(await readFile(path.join(dir, SPEC_REL), 'utf8'));

    const err = await ensureLock({ projectDir: dir, spec }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockMismatchError);
    expect((err as LockMismatchError).exitCode).toBe(11);
    expect((err as LockMismatchError).mismatches.some((m) => m.kind === 'lock-missing')).toBe(true);
  });
});
