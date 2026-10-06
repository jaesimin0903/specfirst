import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allocationAllowed,
  allocationGateAbi,
  allocationGateBytecode,
  exitAllowed,
  GATE_EXIT_PATHS,
  GATE_VERDICT_TEXT,
  GATE_VERDICTS,
  gateExitPathOf,
  gateVerdictOf,
} from '../src/gate/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const contracts = path.resolve(here, '../../contracts');
const source = readFileSync(path.join(contracts, 'src/demo/AllocationGate.sol'), 'utf8');

/** Member names of `enum <name> { ... }` in the Solidity source, in declaration order. */
function enumMembers(name: string): string[] {
  const m = new RegExp(`enum ${name} \\{([^}]*)\\}`).exec(source);
  if (!m) throw new Error(`enum ${name} not found`);
  return m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
}

describe('AllocationGate enums', () => {
  it('GATE_VERDICTS and GATE_EXIT_PATHS are the Solidity enums in declaration order', () => {
    expect([...GATE_VERDICTS]).toEqual(enumMembers('Verdict'));
    expect([...GATE_EXIT_PATHS]).toEqual(enumMembers('ExitPath'));
    expect(Object.keys(GATE_VERDICT_TEXT).sort()).toEqual([...GATE_VERDICTS].sort());
  });

  it('names a value, and refuses one the contract does not have', () => {
    expect(gateVerdictOf(0)).toBe('Compliant');
    expect(gateVerdictOf(3n)).toBe('NotCompliant');
    expect(gateExitPathOf(1)).toBe('Withdraw');
    expect(() => gateVerdictOf(6)).toThrow(/unknown AllocationGate verdict 6/);
    expect(() => gateExitPathOf(2)).toThrow(/unknown AllocationGate exit path 2/);
  });

  it('allocate needs Compliant; exit is open on everything but Compliant and Stale', () => {
    expect(GATE_VERDICTS.filter(allocationAllowed)).toEqual(['Compliant']);
    expect(GATE_VERDICTS.filter(exitAllowed)).toEqual(['NoAttestation', 'NotCompliant', 'UntrustedIssuer', 'CodeMismatch']);
  });
});

describe('bundled AllocationGate artifact', () => {
  const built = path.join(contracts, 'out/AllocationGate.sol/AllocationGate.json');
  // Skipped only when forge is not installed; with forge the build runs here, so a stale artifact fails.
  const hasForge = spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasForge)('matches a fresh forge build (regenerate with scripts/gen-gate-artifact.mjs)', () => {
    const build = spawnSync('forge', ['build'], { cwd: contracts, encoding: 'utf8', timeout: 240_000 });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const art = JSON.parse(readFileSync(built, 'utf8')) as { abi: unknown; bytecode: { object: string } };
    expect(allocationGateAbi).toEqual(art.abi);
    expect(allocationGateBytecode).toBe(art.bytecode.object);
  }, 300_000);
});
