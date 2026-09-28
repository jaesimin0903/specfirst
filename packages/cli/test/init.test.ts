import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerInitCommand } from '../src/commands/init.js';
import { TEMPLATE_FILES } from '../src/lib/templates.js';
import { buildProgram } from './helpers/program.js';

const SPEC_YAML = `
specfirst: 1
name: TestVault
projectId: "github.com/example/test#TestVault"
contract:
  path: src/TestVault.sol
  name: TestVault
  constructorArgs: []
  editable: ["src/"]
solc: "0.8.28"
actors:
  users: 3
  owner: "$DEPLOYER"
  attacker: true
invariants:
  - { id: INV-1, kind: invariant, text: "placeholder invariant" }
unverified: []
rehearsal:
  normalTx: 1
  expectRevertTx: 1
`;

describe('specfirst init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-init-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });

  it('scaffolds every property template under test/specfirst and creates regressions/.gitkeep', async () => {
    const specPath = path.join(dir, 'spec.yaml');
    await writeFile(specPath, SPEC_YAML);

    const program = buildProgram(registerInitCommand);
    await program.parseAsync(['node', 'specfirst', '--project', dir, 'init', '--from-spec', specPath]);

    expect(process.exitCode ?? 0).toBe(0);
    for (const file of TEMPLATE_FILES) {
      const content = await readFile(path.join(dir, 'test/specfirst', file), 'utf8');
      expect(content.length).toBeGreaterThan(0);
    }
    // regressions/.gitkeep exists and is empty.
    const gitkeep = await readFile(path.join(dir, 'test/specfirst/regressions/.gitkeep'), 'utf8');
    expect(gitkeep).toBe('');
  });

  it('does not overwrite a property file that already exists', async () => {
    const specPath = path.join(dir, 'spec.yaml');
    await writeFile(specPath, SPEC_YAML);
    await mkdir(path.join(dir, 'test/specfirst'), { recursive: true });
    await writeFile(path.join(dir, 'test/specfirst/IVault.sol'), '// hand-edited, must survive init\n');

    const program = buildProgram(registerInitCommand);
    await program.parseAsync(['node', 'specfirst', '--project', dir, 'init', '--from-spec', specPath]);

    const content = await readFile(path.join(dir, 'test/specfirst/IVault.sol'), 'utf8');
    expect(content).toBe('// hand-edited, must survive init\n');
    // The other templates that did not already exist are still created.
    const handler = await readFile(path.join(dir, 'test/specfirst/Handler.sol'), 'utf8');
    expect(handler.length).toBeGreaterThan(0);
  });

  it('exits with code 2 and writes nothing when the spec fails validation', async () => {
    const specPath = path.join(dir, 'bad.yaml');
    await writeFile(specPath, 'specfirst: 1\nname: X\n'); // missing required fields

    const program = buildProgram(registerInitCommand);
    await program.parseAsync(['node', 'specfirst', '--project', dir, 'init', '--from-spec', specPath]);

    expect(process.exitCode).toBe(2);
    await expect(readFile(path.join(dir, 'test/specfirst/IVault.sol'), 'utf8')).rejects.toThrow();
  });

  it('exits with code 2 when the spec file does not exist', async () => {
    const program = buildProgram(registerInitCommand);
    await program.parseAsync([
      'node',
      'specfirst',
      '--project',
      dir,
      'init',
      '--from-spec',
      path.join(dir, 'missing.yaml'),
    ]);
    expect(process.exitCode).toBe(2);
  });
});
