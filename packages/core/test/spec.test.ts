import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  SpecError,
  canonicalJson,
  invariantSetHash,
  parseSpec,
  projectIdHash,
  specHash,
  type Spec,
} from '../src/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(path.join(here, 'fixtures/specs', name), 'utf8');
const sample = () =>
  readFileSync(path.join(here, '../../../examples/staking-vault/spec/staking-vault.spec.yaml'), 'utf8');
const BYTES32 = /^0x[0-9a-f]{64}$/;

function expectSpecError(fn: () => unknown, pathFragment: string): SpecError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SpecError);
    const e = err as SpecError;
    expect(e.exitCode).toBe(2);
    expect(e.issues.some((i) => i.path.includes(pathFragment))).toBe(true);
    return e;
  }
  throw new Error('expected SpecError');
}

describe('parseSpec', () => {
  it('parses the committed sample spec', () => {
    const spec = parseSpec(sample());
    expect(spec.name).toBe('StakingVault');
    expect(spec.invariants.map((i) => i.id)).toEqual(['INV-1', 'INV-2', 'INV-3', 'INV-4', 'INV-5', 'INV-6', 'INV-7']);
    expect(spec.contract.constructorArgs).toEqual(['$DEPLOYER']);
    expect(spec.actors).toEqual({ users: 3, owner: '$DEPLOYER', attacker: true });
  });

  it('rejects a missing required field', () => {
    expectSpecError(() => parseSpec(fixture('missing-solc.spec.yaml')), 'solc');
  });

  it('rejects missing nested fields', () => {
    const spec = parseSpec(fixture('valid.spec.yaml')) as Record<string, any>;
    delete spec.contract.name;
    expectSpecError(() => parseSpec(JSON.stringify(spec)), 'contract.name');
  });

  it('rejects duplicate invariant ids', () => {
    const e = expectSpecError(() => parseSpec(fixture('duplicate-id.spec.yaml')), 'invariants.4.id');
    expect(e.message).toContain('duplicate invariant id "INV-2"');
  });

  it('rejects an unknown invariant kind and unknown keys', () => {
    expectSpecError(() => parseSpec(fixture('valid.spec.yaml').replace('kind: access,', 'kind: liveness,')), 'kind');
    expectSpecError(() => parseSpec(`${fixture('valid.spec.yaml')}\nfuzzRuns: 100\n`), '');
  });

  it('rejects invalid YAML', () => {
    expect(() => parseSpec('specfirst: [1')).toThrow(SpecError);
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively without whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[{"y":2,"z":1}]},"b":1}');
  });
});

describe('specHash', () => {
  it('is a bytes32 hex string', () => {
    expect(specHash(parseSpec(sample()))).toMatch(BYTES32);
  });

  it('is invariant to comments, whitespace, key order and flow style', () => {
    const a = parseSpec(fixture('valid.spec.yaml'));
    const b = parseSpec(fixture('reformatted.spec.yaml'));
    const c = parseSpec(fixture('valid.spec.yaml').replace(/\s+#[^\n"]*$/gm, '').replace(/\n/g, '\n\n'));
    expect(specHash(b)).toBe(specHash(a));
    expect(specHash(c)).toBe(specHash(a));
  });

  it('changes when any value changes', () => {
    const a = parseSpec(fixture('valid.spec.yaml'));
    const b = parseSpec(fixture('valid.spec.yaml').replace('normalTx: 25', 'normalTx: 26'));
    expect(specHash(b)).not.toBe(specHash(a));
  });
});

describe('invariantSetHash', () => {
  const base = parseSpec(fixture('valid.spec.yaml'));
  const with_ = (patch: Partial<Spec>): Spec => ({ ...base, ...patch });

  it('is a bytes32 hex string', () => {
    expect(invariantSetHash(base)).toMatch(BYTES32);
  });

  it('ignores name, projectId, rehearsal, actors and contract', () => {
    const h = invariantSetHash(base);
    expect(invariantSetHash(with_({ name: 'Other' }))).toBe(h);
    expect(invariantSetHash(with_({ projectId: 'github.com/x/y#Other' }))).toBe(h);
    expect(invariantSetHash(with_({ rehearsal: { normalTx: 1, expectRevertTx: 0 } }))).toBe(h);
    expect(invariantSetHash(with_({ actors: { ...base.actors, users: 9 } }))).toBe(h);
    expect(invariantSetHash(with_({ contract: { ...base.contract, name: 'X' } }))).toBe(h);
  });

  it('changes when an invariant text, kind or unverified entry changes', () => {
    const h = invariantSetHash(base);
    const inv = base.invariants.map((i) => ({ ...i }));
    inv[0]!.text = `${inv[0]!.text}.`;
    expect(invariantSetHash(with_({ invariants: inv }))).not.toBe(h);
    const kind = base.invariants.map((i, n) => (n === 4 ? { ...i, kind: 'invariant' as const } : i));
    expect(invariantSetHash(with_({ invariants: kind }))).not.toBe(h);
    expect(invariantSetHash(with_({ unverified: base.unverified.slice(1) }))).not.toBe(h);
  });
});

describe('projectIdHash', () => {
  it('is keccak256 of the utf8 projectId', () => {
    // keccak256("") and keccak256("abc") reference values.
    expect(projectIdHash('')).toBe('0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
    expect(projectIdHash('abc')).toBe('0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
    expect(projectIdHash(parseSpec(sample()).projectId)).toMatch(BYTES32);
  });
});
