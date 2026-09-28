import { createHash } from 'node:crypto';
import { keccak256, toHex } from 'viem';
import { describe, expect, it } from 'vitest';
import { canonicalJson as canonicalFromSubpath, sha256Hex } from '../src/spec/hash.js';
import { buildReport, canonicalJson, reportHash, type DeployRecord, type RunSummaryLike, type Spec, type VerifyRecord } from '../src/index.js';

describe('sha256Hex without node:crypto', () => {
  it('matches node:crypto for strings (UTF-8) and bytes', () => {
    for (const s of ['', 'abc', '총 예치량은 모든 사용자 예치 잔고의 합과 같다', '{"a":1}']) {
      expect(sha256Hex(s)).toBe(`0x${createHash('sha256').update(s).digest('hex')}`);
    }
    const bytes = new Uint8Array([0, 1, 2, 255]);
    expect(sha256Hex(bytes)).toBe(`0x${createHash('sha256').update(bytes).digest('hex')}`);
  });
});

const spec: Spec = {
  specfirst: 1,
  name: 'StakingVault',
  projectId: 'github.com/x/y#StakingVault',
  contract: { path: 'src/StakingVault.sol', name: 'StakingVault', constructorArgs: ['$DEPLOYER'], editable: ['src/'] },
  solc: '0.8.28',
  actors: { users: 3, owner: '$DEPLOYER', attacker: true },
  invariants: [
    { id: 'INV-1', kind: 'invariant', text: 'a' },
    { id: 'INV-3', kind: 'postcondition', text: 'b' },
    { id: 'INV-5', kind: 'access', text: 'c' },
  ],
  unverified: ['oracle'],
  rehearsal: { normalTx: 25, expectRevertTx: 5 },
};
const h = `0x${'11'.repeat(32)}` as const;
const run: RunSummaryLike = {
  runId: 'r1',
  spec: { path: 'spec/s.yaml', name: 'StakingVault', specHash: h, invariantSetHash: h, propertyHash: h },
  baseCommit: 'a',
  finalCommit: 'b',
  status: 'passed',
  stopReason: 'all-pass',
  iterations: 2,
  result: { pass: 3, fail: 0, error: 0, failing: [] },
  params: { runs: 64, depth: 64, timeoutSec: 300, seed: '1', maxIterations: 5 },
  agent: { kind: 'replay', model: null, cliVersion: null, calls: 1 },
  cost: { runUsd: 0, totalUsd: 0 },
  envWarnings: [],
  allowPartial: false,
  versions: { specfirst: '0.0.1', forge: 'forge 1.5.1' },
  history: [],
  startedAt: 't0',
  finishedAt: 't1',
};
const deploy: DeployRecord = {
  version: 1,
  chainId: 31337,
  contract: { name: 'StakingVault', sourceFile: 'src/StakingVault.sol' },
  address: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  constructorArgs: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'],
  txHash: h,
  blockNumber: '3',
  codeHash: h,
  gasUsed: '1',
  gasLimit: '2',
  gasEstimate: '1',
  sourceDir: '/tmp/specfirst-fixture',
  deployedAt: 't0',
};
const verify: VerifyRecord = {
  version: 1,
  chainId: 31337,
  target: deploy.address,
  path: 'probe',
  note: 'fork 대조 미사용',
  fork: { url: 'http://127.0.0.1:1', block: '9', runs: 32, wallclockSec: 0.1, rawArtifactPath: '/tmp/forge-1.json', error: 'fork failed' },
  probe: { block: '9', inv1: true, inv2: true, inv6: true },
  depositors: { fromBlock: '3', toBlock: '9', chunks: 1, count: 4, addresses: [] },
  invariants: [
    { id: 'INV-1', kind: 'invariant', ok: true, evidence: [] },
    { id: 'INV-3', kind: 'postcondition', ok: null, evidence: [] },
    { id: 'INV-5', kind: 'access', ok: true, evidence: [] },
  ],
  passed: 2,
  violated: 0,
  unjudged: 1,
  ok: false,
  verifiedAt: 't1',
};

describe('report.json schema shared with packages/web/lib/report.ts', () => {
  const report = buildReport({ spec, run, fuzzStatus: { 'INV-1': 'pass', 'INV-3': 'pass', 'INV-5': 'pass' }, deploy, rehearsal: null, verify });

  it('carries the fields the certificate page reads and passes its isReport guard', () => {
    expect(report.specfirst).toBe(1);
    expect(Array.isArray(report.invariants) && Array.isArray(report.unverified)).toBe(true);
    expect(report).toMatchObject({
      name: 'StakingVault',
      projectId: 'github.com/x/y#StakingVault',
      target: deploy.address,
      chainId: 31337,
      cliVersion: '0.0.1',
      foundryVersion: 'forge 1.5.1',
      fuzz: { backend: 'forge', runs: 64, depth: 64, timeoutSec: 300, seed: '1' },
      iterations: 2,
      verifyMethod: 'probe',
      verifyNotes: ['fork 대조 미사용'],
    });
    expect(report).not.toHaveProperty('auxiliary');
  });

  it('status is pass only when fuzz passed and verify confirmed; unjudged is error and not counted', () => {
    expect(report.invariants.map((i) => [i.id, i.status, i.fuzz, i.verify])).toEqual([
      ['INV-1', 'pass', 'pass', true],
      ['INV-3', 'error', 'pass', null],
      ['INV-5', 'pass', 'pass', true],
    ]);
    expect(report).toMatchObject({ passedCount: 2, totalCount: 3, passedBitmap: '0x5' });
  });

  it('reportHash is keccak256(toHex(canonicalJson(report))), the formula the web recomputes via @specfirst/core/hash', () => {
    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(reportHash(report)).toBe(keccak256(toHex(canonicalFromSubpath(roundTripped))));
    expect(canonicalFromSubpath).toBe(canonicalJson);
  });
});
