import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRunId, parseAgentChoice, registerRunCommand } from '../src/commands/run.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';
import { sampleRepo } from './helpers/sampleRepo.js';

describe('parseAgentChoice', () => {
  it('accepts claude, none, false (--no-agent) and replay lists', () => {
    expect(parseAgentChoice('claude')).toEqual({ kind: 'claude' });
    expect(parseAgentChoice('none')).toEqual({ kind: 'none' });
    expect(parseAgentChoice(false)).toEqual({ kind: 'none' });
    expect(parseAgentChoice('replay:a.patch')).toEqual({ kind: 'replay', patches: ['a.patch'] });
    expect(parseAgentChoice('replay:a.patch, b.patch')).toEqual({ kind: 'replay', patches: ['a.patch', 'b.patch'] });
  });
  it('rejects unknown agents and an empty replay list', () => {
    expect(() => parseAgentChoice('gpt')).toThrow(/unknown --agent/);
    expect(() => parseAgentChoice('replay:')).toThrow(/at least one patch/);
  });
});

describe('makeRunId', () => {
  it('is a UTC timestamp plus 6 hex chars and differs between calls', () => {
    const now = new Date('2026-09-29T10:45:12.345Z');
    const a = makeRunId('0xabc', now);
    expect(a).toMatch(/^20260929-104512-[0-9a-f]{6}$/);
    expect(makeRunId('0xabc', now)).not.toBe(a);
  });
});

describe('specfirst run (no forge needed)', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
    process.exitCode = undefined;
  });

  const run = (d: string, ...args: string[]) =>
    capture(() => buildProgram(registerRunCommand).parseAsync(['node', 'specfirst', '--project', d, 'run', ...args]));

  it('exits 2 when the spec file is missing', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-run-'));
    const { err } = await run(dir, 'spec/nope.yaml', '--no-deploy');
    expect(process.exitCode).toBe(2);
    expect(err.join('\n')).toContain('spec file not found');
  });

  it('exits 11 when there is no lock', async () => {
    dir = await sampleRepo();
    const { err } = await run(dir, 'spec/staking-vault.spec.yaml', '--no-deploy', '--agent', 'none');
    expect(process.exitCode).toBe(11);
    expect(err.join('\n')).toContain('lock-missing');
  });

  it('exits 1 on an unknown agent before touching the lock', async () => {
    dir = await sampleRepo();
    const { err } = await run(dir, 'spec/staking-vault.spec.yaml', '--no-deploy', '--agent', 'gpt');
    expect(process.exitCode).toBe(1);
    expect(err.join('\n')).toContain('unknown --agent');
  });

  it('reports the lock error as an NDJSON run-error event with --json', async () => {
    dir = await sampleRepo();
    const { stdout } = await capture(() =>
      buildProgram(registerRunCommand).parseAsync(['node', 'specfirst', '--json', '--project', dir!, 'run', 'spec/staking-vault.spec.yaml', '--no-deploy']),
    );
    expect(JSON.parse(stdout.trim())).toMatchObject({ type: 'run-error', exitCode: 11 });
  });
});
