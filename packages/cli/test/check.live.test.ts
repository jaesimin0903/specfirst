import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { standardCheckReportSchema } from '@specfirst/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerCheckCommand } from '../src/commands/check.js';
import { capture } from './helpers/capture.js';
import { buildProgram } from './helpers/program.js';

/**
 * `specfirst check` against Monad mainnet (read-only fork). Needs the network and takes minutes, so it
 * runs only with SPECFIRST_LIVE=1. RPC: $MONAD_MAINNET_RPC or the public default.
 */
const LIVE = process.env.SPECFIRST_LIVE === '1';
const BLOCK = '109061472';
const MORPHO = '0x802c91d807A8DaCA257c4708ab264B6520964e44';
const SHMONAD = '0x1B68626dCa36c7fE922fD2d55E4f631d962dE19c';

describe.skipIf(!LIVE)('specfirst check on Monad mainnet (SPECFIRST_LIVE=1)', { timeout: 900_000 }, () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-check-live-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    process.exitCode = undefined;
  });
  const cli = async (...args: string[]) => {
    process.exitCode = undefined;
    const r = await capture(() => buildProgram(registerCheckCommand).parseAsync(['node', 'specfirst', '--json', '--project', dir, 'check', ...args]));
    const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    return { code: process.exitCode ?? 0, events, err: r.err };
  };

  it('Morpho vault at a pinned block: no property fails, report and raw forge output are saved', async () => {
    const r = await cli(MORPHO, '--standard', 'erc4626', '--block', BLOCK, '--runs', '8');
    // 0 when all 26 pass; 17 if the public RPC rate-limited a property into inconclusive. Never 16.
    expect([0, 17]).toContain(r.code);
    const summary = r.events.find((e) => e.type === 'check-summary')!;
    expect(summary).toMatchObject({ chainId: 143, blockNumber: BLOCK, exitCode: r.code, reportPath: `.specfirst/checks/143/${MORPHO.toLowerCase()}/${BLOCK}.json` });
    expect(r.events.filter((e) => e.type === 'check-property')).toHaveLength(26);
    const report = standardCheckReportSchema.parse(JSON.parse(await readFile(path.join(dir, summary.reportPath as string), 'utf8')));
    expect(report.summary.fail).toBe(0);
    expect(report.identity.implementationKeyKind).toEqual({ of: 'self', hash: 'maskedCodeHash' });
    expect(existsSync(path.join(dir, summary.rawPath as string))).toBe(true);
  });

  it('ERC-7535 native-asset vault (FastLane shMONAD): all not_applicable, forge skipped, exit 17 (not verified)', async () => {
    const r = await cli(SHMONAD, '--standard', 'erc4626', '--block', BLOCK, '--runs', '8');
    expect(r.code).toBe(17);
    expect(r.events.some((e) => e.type === 'check-skip')).toBe(true);
    expect(r.events.find((e) => e.type === 'check-summary')!.summary).toEqual({ pass: 0, fail: 0, inconclusive: 0, notApplicable: 26 });
  });
});
