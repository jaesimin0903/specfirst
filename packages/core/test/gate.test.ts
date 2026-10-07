import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { GATE_BACKOFF_MAX_MS, GATE_BACKOFF_MIN_MS, GATE_DUST_BPS, GateError, GateKeeper, type GateExitOutcome, type GateKeeperTarget, type GatePosition } from '../src/gate/client.js';
import {
  type GateVerdict,
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
    expect(gateVerdictOf(7)).toBe('OtherSuite');
    expect(() => gateVerdictOf(8)).toThrow(/unknown AllocationGate verdict 8/);
    expect(() => gateExitPathOf(2)).toThrow(/unknown AllocationGate exit path 2/);
  });

  it('allocate needs Compliant; exit is open to anyone on everything but Compliant and Stale', () => {
    expect(GATE_VERDICTS.filter(allocationAllowed)).toEqual(['Compliant']);
    expect(GATE_VERDICTS.filter(exitAllowed)).toEqual(['NoAttestation', 'NotCompliant', 'UntrustedIssuer', 'CodeMismatch', 'FutureBlock', 'OtherSuite']);
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

describe('GateKeeper', () => {
  const STUCK = '0x00000000000000000000000000000000000000a1' as Address;
  const PAYS = '0x00000000000000000000000000000000000000a2' as Address;
  const EMPTY = '0x00000000000000000000000000000000000000a3' as Address;
  const HEALTHY = '0x00000000000000000000000000000000000000a4' as Address;

  function fake() {
    let clock = 1_000_000;
    const calls: string[] = [];
    const shares = new Map<string, bigint>([[STUCK, 10n], [PAYS, 10n], [EMPTY, 0n], [HEALTHY, 10n]]);
    const verdicts = new Map<string, GateVerdict>([[STUCK, 'NotCompliant'], [PAYS, 'NotCompliant'], [EMPTY, 'NotCompliant'], [HEALTHY, 'Compliant']]);
    let stuckPays = false;
    let rpcDown = false;
    const tx = { hash: `0x${'11'.repeat(32)}`, blockNumber: 1n, gasUsed: 1n, effectiveGasPrice: 1n, gasCostWei: 1n } as const;
    const target: GateKeeperTarget = {
      summary: async () => ({ vaults: [STUCK, PAYS, EMPTY, HEALTHY] }),
      position: async (v) => {
        calls.push(`position ${v}`);
        return { shares: shares.get(v)!, assetsIn: 0n, assetsOut: 0n, lastAllocatedBlock: 1n, lastExitBlock: 0n } satisfies GatePosition;
      },
      verdict: async (v) => {
        calls.push(`verdict ${v}`);
        if (rpcDown) throw new GateError('HTTP request failed');
        return { verdict: verdicts.get(v)!, attestationId: 1n };
      },
      simulateExit: async (v) => {
        calls.push(`simulate ${v}`);
        return v === PAYS || (v === STUCK && stuckPays);
      },
      exit: async (v) => {
        calls.push(`exit ${v}`);
        shares.set(v, 0n);
        return { ...tx, vault: v, verdict: 'NotCompliant', attestationId: 1n, exited: true, path: 'Redeem', shares: 10n, assets: 10n } satisfies GateExitOutcome;
      },
    };
    return {
      target,
      calls,
      now: () => clock,
      advance: (ms: number) => (clock += ms),
      payStuck: () => (stuckPays = true),
      setRpcDown: (down: boolean) => (rpcDown = down),
    };
  }

  it('exits what pays, never reads past an empty position, leaves closed vaults alone and does not send an exit that would move nothing', async () => {
    const f = fake();
    const k = new GateKeeper(f.target, f.now);
    const r = await k.pass();
    expect(r.map((x) => [x.vault, x.kind])).toEqual([
      [STUCK, 'backoff'],
      [PAYS, 'exited'],
      [EMPTY, 'empty'],
      [HEALTHY, 'closed'],
    ]);
    expect(r[0]).toMatchObject({ delayMs: GATE_BACKOFF_MIN_MS, until: f.now() + GATE_BACKOFF_MIN_MS, verdict: 'NotCompliant' });
    expect(f.calls).not.toContain(`verdict ${EMPTY}`);
    expect(f.calls).not.toContain(`exit ${STUCK}`);
    expect(f.calls.filter((c) => c.startsWith('exit '))).toEqual([`exit ${PAYS}`]);
  });

  it('backs off a vault that moves nothing from a minute, doubling to an hour, reporting each step once, until it pays', async () => {
    const f = fake();
    const k = new GateKeeper(f.target, f.now);
    const steps: number[] = [];
    let waited = 0;
    for (let i = 0; i < 600; i++) {
      for (const x of await k.pass()) {
        if (x.vault !== STUCK) continue;
        if (x.kind === 'backoff') steps.push(x.delayMs);
        if (x.kind === 'waiting') waited++;
      }
      f.advance(15_000); // the keeper's poll
    }
    expect(steps.slice(0, 7)).toEqual([60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000]);
    expect(steps.every((d) => d <= GATE_BACKOFF_MAX_MS)).toBe(true);
    expect(steps).toHaveLength(8); // 600 passes of 15 s, 2.5 h: 1 + 2 + 4 + 8 + 16 + 32 min, then 60 min twice
    expect(waited).toBe(600 - steps.length);
    expect(f.calls.filter((c) => c === `simulate ${STUCK}`)).toHaveLength(steps.length);

    f.payStuck();
    f.advance(GATE_BACKOFF_MAX_MS);
    const r = await k.pass();
    expect(r[0]).toMatchObject({ vault: STUCK, kind: 'exited' });
    expect((await k.pass())[0]).toMatchObject({ vault: STUCK, kind: 'empty' });
  });

  it('backs off an exit that took back only dust, and a sent exit that failed on chain; an error before sending waits for nothing', async () => {
    const DUST = '0x00000000000000000000000000000000000000b1' as Address;
    const REVERTS = '0x00000000000000000000000000000000000000b2' as Address;
    const NEVER_SENT = '0x00000000000000000000000000000000000000b3' as Address;
    let clock = 5_000_000;
    const books = 10_000n;
    const exits: string[] = [];
    const tx = { hash: `0x${'22'.repeat(32)}`, blockNumber: 1n, gasUsed: 1n, effectiveGasPrice: 1n, gasCostWei: 1n } as const;
    const target: GateKeeperTarget = {
      summary: async () => ({ vaults: [DUST, REVERTS, NEVER_SENT] }),
      position: async () => ({ shares: books, assetsIn: 0n, assetsOut: 0n, lastAllocatedBlock: 1n, lastExitBlock: 0n }),
      verdict: async () => ({ verdict: 'NotCompliant', attestationId: 1n }),
      simulateExit: async () => true,
      exit: async (v) => {
        exits.push(v);
        if (v === REVERTS) throw new GateError(`exit tx ${tx.hash} reverted`, 'TxReverted', undefined, tx.hash);
        if (v === NEVER_SENT) throw new GateError('exit failed: HTTP request failed');
        // A wei of assets for books x GATE_DUST_BPS / 10000 shares: exactly the dust line.
        return { ...tx, vault: v, verdict: 'NotCompliant', attestationId: 1n, exited: true, path: 'Redeem', shares: (books * GATE_DUST_BPS) / 10_000n, assets: 1n } satisfies GateExitOutcome;
      },
    };
    const k = new GateKeeper(target, () => clock);
    const r = await k.pass();
    expect(r.map((x) => [x.vault, x.kind])).toEqual([
      [DUST, 'backoff'],
      [REVERTS, 'backoff'],
      [NEVER_SENT, 'error'],
    ]);
    expect(r[0]).toMatchObject({ outcome: { exited: true, assets: 1n } });
    expect(r[1]).toMatchObject({ error: { errorName: 'TxReverted', txHash: tx.hash } });
    clock += 15_000;
    expect((await k.pass()).map((x) => x.kind)).toEqual(['waiting', 'waiting', 'error']);
    expect(exits).toEqual([DUST, REVERTS, NEVER_SENT, NEVER_SENT]);
  });

  it('an RPC failure is reported and starts no wait', async () => {
    const f = fake();
    const k = new GateKeeper(f.target, f.now);
    f.setRpcDown(true);
    const r = await k.pass();
    expect(r.find((x) => x.vault === PAYS)).toMatchObject({ kind: 'error' });
    f.setRpcDown(false);
    expect((await k.pass()).find((x) => x.vault === PAYS)).toMatchObject({ kind: 'exited' });
  });
});
