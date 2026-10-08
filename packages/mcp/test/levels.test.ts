import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { classifyFailure, idsOfBitmap, PROPERTY_IDS, propertyLevel, vaultLevelOf } from '../src/levels.js';
import { FIX, fixture, NAMES, REPORT_FILE, type Name } from './helpers.js';

/*
 * src/levels.ts reads failures the way the board does. The web keeps packages/web/lib/board/levels.ts free of imports
 * and does not export it as a package, so this test loads that file directly and runs both on the same inputs.
 */

interface WebLevels {
  PROPERTY_IDS: readonly string[];
  propertyLevel(id: string): string;
  classifyFailure(f: Failure): { level: string; topic: string; delta?: string; amount?: string };
  failureLevelOf(f: ReadonlyArray<Failure>): string | null;
  idsOfBitmap(b: bigint): string[] | null;
}

let web: WebLevels;
beforeAll(async () => {
  web = (await import(pathToFileURL(join(FIX, '..', '..', '..', 'web', 'lib', 'board', 'levels.ts')).href)) as WebLevels;
});

type Failure = { id: string; counterexample?: { logs: string[] } };

const ASSERT = 'Error: a <=~ b not satisfied [uint]';
const pair = (a: bigint, b: bigint) => [`      Value a: ${a}`, `      Value b: ${b}`];
const SYNTHETIC: Failure[] = [
  { id: 'RT-deposit-redeem', counterexample: { logs: [ASSERT, ...pair(1_000_000n, 999_999n)] } },
  { id: 'RT-mint-redeem', counterexample: { logs: [ASSERT, ...pair(10_000_000n, 9_998_000n)] } },
  // One injected pair beyond the bound makes the whole round trip more than rounding.
  { id: 'RT-withdraw-mint', counterexample: { logs: [ASSERT, ...pair(5n, 4n), ...pair(1_000n, 1n)] } },
  { id: 'RT-redeem-mint', counterexample: { logs: [...pair(5n, 4n)] } },
  { id: 'RT-mint-withdraw' },
  { id: 'withdraw-zero-allowance' },
  { id: 'redeem-zero-allowance' },
  { id: 'withdraw', counterexample: { logs: [ASSERT, ...pair(5n, 4n)] } },
  { id: 'previewDeposit' },
  { id: 'sf-maxWithdraw-honored' },
  { id: 'not-in-the-table' },
];

function failuresOf(name: Name): Failure[] {
  const r = fixture(REPORT_FILE[name]) as { results: Array<{ id: string; status: string; counterexample?: { logs?: string[] } }> };
  return r.results.filter((x) => x.status === 'fail').map((x) => ({ id: x.id, counterexample: { logs: x.counterexample?.logs ?? [] } }));
}

describe('levels agree with the board (packages/web/lib/board/levels.ts)', () => {
  it('the same property ids in the same bit order', () => {
    expect(PROPERTY_IDS).toEqual(web.PROPERTY_IDS);
    expect(PROPERTY_IDS).toHaveLength(30);
  });

  it('the same level for every property, and MUST for an id outside the table', () => {
    for (const id of [...PROPERTY_IDS, 'not-in-the-table']) expect(propertyLevel(id)).toBe(web.propertyLevel(id));
  });

  it('the same class for every failure in the fixture reports and for the synthetic ones', () => {
    const all = [...NAMES.flatMap(failuresOf), ...SYNTHETIC];
    expect(all.length).toBe(SYNTHETIC.length + 4);
    for (const f of all) expect(classifyFailure(f)).toEqual(web.classifyFailure(f));
  });

  it('the same vault level for each fixture report and for mixes of the synthetic failures', () => {
    const sets: Failure[][] = [[], ...NAMES.map(failuresOf), SYNTHETIC.slice(0, 2), SYNTHETIC.slice(0, 3), SYNTHETIC.slice(5, 7), SYNTHETIC];
    for (const s of sets) {
      const ours = vaultLevelOf(s.map((f) => classifyFailure(f)));
      expect(ours === 'none' ? null : ours).toBe(web.failureLevelOf(s));
    }
  });

  it('the same ids for a bitmap, and a visible marker where the board gives up', () => {
    for (const b of [0n, 1n << 28n, (1n << 28n) | (1n << 29n), (1n << 20n) | (1n << 25n), (1n << 30n) - 1n]) expect(idsOfBitmap(b)).toEqual(web.idsOfBitmap(b));
    expect(web.idsOfBitmap(1n << 31n)).toBeNull();
    expect(idsOfBitmap(1n << 31n)).toEqual(['bit 31']);
    expect(propertyLevel('bit 31')).toBe('must');
  });
});

describe('the three fixture vaults', () => {
  it('Upshift is must, tyYIELD is rounding, Morpho is none', () => {
    const level = (n: Name) => vaultLevelOf(failuresOf(n).map((f) => classifyFailure(f)));
    expect(level('upshift')).toBe('must');
    expect(level('tyyield')).toBe('rounding');
    expect(level('morpho')).toBe('none');
  });
});
