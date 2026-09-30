import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, encodeEventTopics, getAddress, type Address, type Hex } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireWorkerLock,
  advanceCursor,
  AttestationError,
  canDeliver,
  countsAsFailure,
  isContractAnswer,
  checkBlockOf,
  checkRequestDeskAbi,
  checkRequestDeskBytecode,
  DeskError,
  parseCheckReport,
  precheckErc4626,
  reasonCodeOf,
  reasonOf,
  REJECT_REASONS,
  REQUEST_STATUS,
  RequestDeskClient,
  runWorkerPass,
  screenRequest,
  standardIdOf,
  withStage,
  WORKER_DIR,
  WorkerError,
  workerStatusEntries,
  workerStatusSchema,
  workerStateSchema,
  WorkerStore,
  type DeskRequest,
  type DeskTx,
  type StandardCheckReport,
  type WorkerConfig,
  type WorkerEffects,
  type WorkerEvent,
  type WorkerRequestStatus,
  type WorkerStatus,
} from '../src/index.js';
import * as browserDesk from '../src/desk/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MORPHO = readFileSync(path.join(here, 'fixtures/attest/morpho-143-109061472.json'), 'utf8');
const ERC4626 = standardIdOf('erc4626');
const DESK = getAddress('0x5FbDB2315678afecb367f032d93F642f64180aa3');
const VAULT = getAddress('0x802c91d807A8DaCA257c4708ab264B6520964e44');
const TOKEN = getAddress('0x00000000000000000000000000000000000000aa');
const REQUESTER = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const hash = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const NOW = new Date('2026-09-30T12:00:00Z');

describe('browser-safe @specfirst/core/desk', () => {
  it('imports only viem, zod and the generated artifact', () => {
    const src = readFileSync(path.join(here, '../src/desk/index.ts'), 'utf8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(imports)).toEqual(new Set(['viem', 'zod', './artifact.js']));
    expect(readFileSync(path.join(here, '../src/desk/artifact.ts'), 'utf8')).not.toMatch(/^import /m);
    const pkg = JSON.parse(readFileSync(path.join(here, '../package.json'), 'utf8')) as { exports: Record<string, { import: string }> };
    expect(pkg.exports['./desk']!.import).toBe('./dist/desk/index.js');
  });

  it('exports the names the web imports, the same objects as the package root', () => {
    expect(browserDesk.checkRequestDeskAbi).toBe(checkRequestDeskAbi);
    expect(browserDesk.REQUEST_STATUS).toEqual(['None', 'Pending', 'Fulfilled', 'Rejected', 'Refunded']);
    for (const name of ['checkRequestDeskBytecode', 'workerStatusSchema', 'workerRequestStatusSchema', 'workerStageSchema', 'REJECT_REASONS']) {
      expect(browserDesk).toHaveProperty(name);
    }
  });

  it('the ABI keeps the agreed interface', () => {
    const fns = Object.fromEntries(
      checkRequestDeskAbi.filter((x) => x.type === 'function').map((f) => [f.name, `${f.inputs.map((i) => i.type).join(',')}>${f.outputs.map((o) => o.type).join(',')}`]),
    );
    expect(fns).toEqual({
      requestCheck: 'uint64,address,bytes32>uint256',
      fulfill: 'uint256,uint256>',
      reject: 'uint256,bytes32>',
      refundExpired: 'uint256>',
      withdraw: 'address>',
      setFee: 'uint96>',
      setWorker: 'address>',
      requestOf: 'uint256>tuple',
      requestCount: '>uint256',
      fee: '>uint96',
      worker: '>address',
      owner: '>address',
      registry: '>address',
      timeout: '>uint64',
      earned: '>uint256',
      withdrawn: '>uint256',
      escrowed: '>uint256',
    });
    const request = checkRequestDeskAbi.find((x) => x.type === 'function' && x.name === 'requestOf')!;
    const tuple = (request as { outputs: readonly { components: readonly { name: string; type: string }[] }[] }).outputs[0]!.components;
    expect(tuple.map((c) => `${c.name}:${c.type}`)).toEqual([
      'requester:address',
      'subjectChainId:uint64',
      'subject:address',
      'standardId:bytes32',
      'fee:uint96',
      'requestedAt:uint64',
      'status:uint8',
      'attestationId:uint256',
      'rejectReason:bytes32',
    ]);
    const events = checkRequestDeskAbi.filter((x) => x.type === 'event').map((e) => `${e.name}(${e.inputs.map((i) => `${i.type}${i.indexed ? ' indexed' : ''}`).join(',')})`);
    expect(events.sort()).toEqual(
      [
        'CheckRequested(uint256 indexed,address indexed,uint64,address indexed,bytes32,uint96)',
        'CheckFulfilled(uint256 indexed,uint256)',
        'CheckRejected(uint256 indexed,bytes32)',
        'CheckRefunded(uint256 indexed)',
        'FeesWithdrawn(address,uint256)',
        'FeeSet(uint96)',
        'WorkerSet(address)',
      ].sort(),
    );
    const ctor = checkRequestDeskAbi.find((x) => x.type === 'constructor')!;
    expect((ctor as { inputs: readonly { type: string }[] }).inputs.map((i) => i.type)).toEqual(['address', 'address', 'address', 'uint96', 'uint64']);
  });
});

describe('reject reason codes', () => {
  it('are short ASCII right padded with zeros, not hashes, and read back', () => {
    expect(reasonCodeOf('not-erc4626')).toBe(`0x6e6f742d65726334363236${'00'.repeat(21)}`);
    for (const r of REJECT_REASONS) expect(reasonOf(reasonCodeOf(r))).toBe(r);
    expect(reasonOf(reasonCodeOf('x'.repeat(32)))).toBe('x'.repeat(32));
    expect(() => reasonCodeOf('x'.repeat(33))).toThrow(/1 to 32 printable ASCII/);
    expect(() => reasonCodeOf('')).toThrow();
    expect(() => reasonCodeOf('not a code')).toThrow();
    expect(() => reasonCodeOf('café')).toThrow();
  });

  it('reasonOf gives the hex back for a zero or non-ASCII bytes32', () => {
    expect(reasonOf(`0x${'00'.repeat(32)}`)).toBe(`0x${'00'.repeat(32)}`);
    const hashLike = `0x${'ff'.repeat(32)}` as Hex;
    expect(reasonOf(hashLike)).toBe(hashLike);
  });
});

describe('status.json schema (flat: request ids next to totals)', () => {
  const entry = { stage: 'fulfilled', updatedAt: '2026-09-30T12:00:00.000Z', block: '109061472', attestationId: '3', txs: { attest: hash(1), fulfill: hash(2) }, gasCostWei: '12345' };
  const valid = { totals: { gasCostWei: '12345', fulfilled: 1, rejected: 0 }, '0': entry, '10': { stage: 'queued', updatedAt: '2026-09-30T12:00:01.000Z', txs: {} } };

  it('accepts decimal ids and totals, and lists entries by numeric id', () => {
    const s = workerStatusSchema.parse(valid);
    expect(s.totals).toEqual({ gasCostWei: '12345', fulfilled: 1, rejected: 0 });
    expect(workerStatusEntries(s).map(([id]) => id)).toEqual(['0', '10']);
    const many = workerStatusSchema.parse({ ...valid, '2': valid['10'] });
    expect(workerStatusEntries(many).map(([id]) => id)).toEqual(['0', '2', '10']);
  });

  it('refuses keys that are not decimal ids, a missing totals, unknown stages and unknown fields', () => {
    for (const key of ['01', 'abc', '-1', '1.0', 'requests']) {
      const r = workerStatusSchema.safeParse({ ...valid, [key]: entry });
      expect(r.success, key).toBe(false);
    }
    expect(workerStatusSchema.safeParse({ '0': entry }).success).toBe(false);
    expect(workerStatusSchema.safeParse({ ...valid, '0': { ...entry, stage: 'refunded' } }).success).toBe(false);
    expect(workerStatusSchema.safeParse({ ...valid, '0': { ...entry, extra: 1 } }).success).toBe(false);
    expect(workerStatusSchema.safeParse({ ...valid, '0': { ...entry, gasCostWei: 12345 } }).success).toBe(false);
    expect(workerStatusSchema.safeParse({ ...valid, totals: { ...valid.totals, fulfilled: -1 } }).success).toBe(false);
  });
});

describe('worker decisions (pure)', () => {
  it('checkBlockOf stays at or above 0', () => {
    expect(checkBlockOf(100n, 10n)).toBe(90n);
    expect(checkBlockOf(10n, 10n)).toBe(0n);
    expect(checkBlockOf(3n, 10n)).toBe(0n);
    expect(checkBlockOf(5n, 0n)).toBe(5n);
  });

  it('screenRequest refuses other standards and other subject chains', () => {
    expect(screenRequest({ subjectChainId: 143n, standardId: ERC4626 }, 143)).toEqual({ ok: true });
    expect(screenRequest({ subjectChainId: 143n, standardId: standardIdOf('erc20') }, 143)).toMatchObject({ ok: false, reason: 'unsupported-standard' });
    expect(screenRequest({ subjectChainId: 1n, standardId: ERC4626 }, 143)).toMatchObject({ ok: false, reason: 'unsupported-chain', detail: 'subject chain 1; this worker reads chain 143' });
  });

  it('advanceCursor stops at the first request that is not closed', () => {
    expect(advanceCursor(0n, 5n, new Set([0n, 1n, 3n]))).toBe(2n);
    expect(advanceCursor(2n, 5n, new Set([2n, 3n, 4n]))).toBe(5n);
    expect(advanceCursor(5n, 5n, new Set())).toBe(5n);
  });

  it('withStage merges txs, adds gas and clears an error given as undefined', () => {
    const status: WorkerStatus = { totals: { gasCostWei: '0', fulfilled: 0, rejected: 0 } };
    const t0 = new Date('2026-09-30T00:00:00Z');
    withStage(status, '4', { stage: 'attesting', error: 'boom' }, t0);
    withStage(status, '4', { stage: 'fulfilling', txs: { attest: hash(1) }, addGasWei: 7n, error: undefined }, t0);
    const e = withStage(status, '4', { stage: 'fulfilled', txs: { fulfill: hash(2) }, addGasWei: 5n }, new Date('2026-09-30T00:01:00Z'));
    expect(e).toEqual({ stage: 'fulfilled', updatedAt: '2026-09-30T00:01:00.000Z', txs: { attest: hash(1), fulfill: hash(2) }, gasCostWei: '12' });
  });
});

describe('precheckErc4626 (mock client)', () => {
  const reverted = () => Object.assign(new Error('The contract function "asset" reverted.'), { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionRevertedError', message: 'reverted' } });
  const zeroData = () => Object.assign(new Error('returned no data ("0x")'), { name: 'ContractFunctionExecutionError', cause: { name: 'ContractFunctionZeroDataError' } });
  const client = (o: { code?: Hex; asset?: Address | Error; total?: bigint | Error }) => ({
    getCode: vi.fn(async () => o.code),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      const v = functionName === 'asset' ? o.asset : o.total;
      if (v instanceof Error) throw v;
      return v;
    }),
  });

  it('passes a contract whose asset() and totalAssets() answer at the block', async () => {
    const c = client({ code: '0x6001', asset: TOKEN, total: 5n });
    expect(await precheckErc4626(c as never, VAULT, 7n)).toEqual({ ok: true, asset: TOKEN });
    expect(c.getCode).toHaveBeenCalledWith({ address: VAULT, blockNumber: 7n });
    expect(c.readContract.mock.calls.map((x) => (x[0] as unknown as { blockNumber: bigint }).blockNumber)).toEqual([7n, 7n]);
  });

  it('refuses no code, a reverting or zero asset(), and a reverting totalAssets()', async () => {
    expect(await precheckErc4626(client({ code: undefined }) as never, VAULT, 7n)).toMatchObject({ ok: false, reason: /no contract code/ });
    expect(await precheckErc4626(client({ code: '0x' }) as never, VAULT, 7n)).toMatchObject({ ok: false });
    expect(await precheckErc4626(client({ code: '0x60', asset: reverted() }) as never, VAULT, 7n)).toMatchObject({ ok: false, reason: /asset\(\) failed/ });
    expect(await precheckErc4626(client({ code: '0x60', asset: `0x${'00'.repeat(20)}` }) as never, VAULT, 7n)).toMatchObject({ ok: false, reason: /zero address/ });
    expect(await precheckErc4626(client({ code: '0x60', asset: TOKEN, total: reverted() }) as never, VAULT, 7n)).toMatchObject({ ok: false, reason: /totalAssets\(\) failed/ });
  });

  it('a call that returns no data is not a vault; a node error is thrown, not taken for "not a vault"', async () => {
    expect(await precheckErc4626(client({ code: '0x60', asset: zeroData() }) as never, VAULT, 7n)).toMatchObject({ ok: false, reason: /asset\(\) failed/ });
    const node = Object.assign(new Error('missing trie node'), { name: 'ContractFunctionExecutionError', cause: { name: 'RpcRequestError', message: 'missing trie node abc' } });
    await expect(precheckErc4626(client({ code: '0x60', asset: node }) as never, VAULT, 7n)).rejects.toThrow(/missing trie node/);
    expect(isContractAnswer(node)).toBe(false);
    expect(isContractAnswer(reverted())).toBe(true);
  });

  it('throws transport failures and rate limits so the worker retries', async () => {
    const down = Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
    await expect(precheckErc4626(client({ code: '0x60', asset: down }) as never, VAULT, 7n)).rejects.toThrow(/fetch failed/);
    const limited = Object.assign(new Error('429 Too Many Requests'), { status: 429 });
    await expect(precheckErc4626(client({ code: '0x60', asset: TOKEN, total: limited }) as never, VAULT, 7n)).rejects.toThrow(/429/);
  });
});

// ---------------------------------------------------------------- the loop with stub effects

interface StubRequest extends DeskRequest {}

class StubDesk {
  requests: StubRequest[] = [];
  txn = 0;
  failFulfill = 0;
  failReject = 0;
  calls: string[] = [];
  add(over: Partial<StubRequest> = {}): bigint {
    this.requests.push({
      requester: REQUESTER,
      subjectChainId: 143n,
      subject: VAULT,
      standardId: ERC4626,
      fee: 10n ** 17n,
      requestedAt: 1_700_000_000n,
      status: 1,
      attestationId: 0n,
      rejectReason: `0x${'00'.repeat(32)}`,
      ...over,
    });
    return BigInt(this.requests.length - 1);
  }
  private tx(): DeskTx {
    this.txn++;
    return { hash: hash(1000 + this.txn), blockNumber: BigInt(this.txn), gasUsed: 100n, effectiveGasPrice: 3n, gasCostWei: 300n };
  }
  requestCount = async () => BigInt(this.requests.length);
  requestOf = async (id: bigint) => {
    this.calls.push(`requestOf ${id}`);
    const r = this.requests[Number(id)];
    if (!r) throw new DeskError(`no request with id ${id} (UnknownRequest)`, 'UnknownRequest');
    return { ...r };
  };
  fulfill = async (id: bigint, attestationId: bigint) => {
    this.calls.push(`fulfill ${id} ${attestationId}`);
    if (this.failFulfill > 0) {
      this.failFulfill--;
      throw new DeskError('fulfill failed (AttestationMismatch): boom', 'AttestationMismatch');
    }
    const r = this.requests[Number(id)]!;
    if (r.status !== 1) throw new DeskError('fulfill failed (NotPending)', 'NotPending');
    r.status = 2;
    r.attestationId = attestationId;
    return this.tx();
  };
  rejectGas = 50_000n;
  reject = async (id: bigint, reason: string, opts: { maxGas?: bigint } = {}) => {
    this.calls.push(`reject ${id} ${reason}`);
    if (opts.maxGas !== undefined && this.rejectGas > opts.maxGas) {
      throw new DeskError(`reject needs ${this.rejectGas} gas, above the cap of ${opts.maxGas}; not sent`, 'GasCapExceeded');
    }
    if (this.failReject > 0) {
      this.failReject--;
      throw new DeskError('reject failed (TransferFailed)', 'TransferFailed');
    }
    const r = this.requests[Number(id)]!;
    r.status = 3;
    r.rejectReason = reasonCodeOf(reason);
    return this.tx();
  };
}

function reportFor(subject: Address, block: bigint): StandardCheckReport {
  const base = parseCheckReport(MORPHO);
  return parseCheckReport(JSON.stringify({ ...base, address: subject, blockNumber: block.toString() }));
}

describe('runWorkerPass with stub effects', () => {
  let dir: string;
  let desk: StubDesk;
  let events: WorkerEvent[];
  let checks: Array<{ subject: Address; block: bigint }>;
  let attests: number;
  let registry: Array<{ id: bigint; subject: Address; issuedAt: bigint }>;
  let attestMinedThenLost: number;
  let onCheck: (() => void) | undefined;
  let sleeps: number[];
  let vaults: Set<string>;
  let failCheck: number;
  let failAttest: number;
  let unknownProxy: boolean;
  let saveFails: number;
  let identityMismatch: boolean;
  let identityChecks: number;

  const config: Partial<WorkerConfig> = { blockLag: 10n, maxAttempts: 3, retryDelaysMs: [5, 20], maxTxFailures: 3 };

  const effects = (): WorkerEffects => ({
    desk: desk as never,
    subjectChainId: 143,
    latestSubjectBlock: async () => 1_000n,
    precheck: async (subject) => (vaults.has(subject) ? { ok: true, asset: TOKEN } : { ok: false, reason: `asset() failed at block 990: execution reverted` }),
    runCheck: async (subject, block) => {
      checks.push({ subject, block });
      onCheck?.();
      if (failCheck > 0) {
        failCheck--;
        throw new Error('forge exited with 1: fork RPC 429');
      }
      return reportFor(subject, block);
    },
    saveReport: async (report) => {
      if (saveFails > 0) {
        saveFails--;
        throw new Error('EACCES: permission denied');
      }
      const reportPath = `certs/checks/143/${report.address.toLowerCase()}/${report.blockNumber}-0011223344556677.json`;
      await mkdir(path.dirname(path.join(dir, reportPath)), { recursive: true });
      await writeFile(path.join(dir, reportPath), JSON.stringify(report));
      return { reportPath, reportURI: `https://example.org/checks/${reportPath.slice('certs/checks/'.length)}` };
    },
    loadReport: async (reportPath) => parseCheckReport(await readFile(path.join(dir, reportPath), 'utf8')),
    verifySubject: async (report) => {
      identityChecks++;
      if (identityMismatch) throw new AttestationError(`identity of ${report.address} differs from the report: implementationKey`);
      return { chainId: 143, blockNumber: BigInt(report.blockNumber), codeHash: report.identity.codeHash as Hex, identity: report.identity as never, unknownProxy };
    },
    attest: async (params) => {
      if (failAttest > 0) {
        failAttest--;
        throw Object.assign(new Error('attest failed (NotIssuer): reverted'), { errorName: 'NotIssuer' });
      }
      attests++;
      const id = BigInt(40 + attests);
      registry.push({ id, subject: params.subject, issuedAt: BigInt(Math.floor(NOW.getTime() / 1000)) });
      if (attestMinedThenLost > 0) {
        attestMinedThenLost--;
        throw Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' });
      }
      return { id, hash: hash(500 + attests), gasCostWei: 1000n };
    },
    latestOwnAttestation: async (_chain, subject) => {
      const own = registry.filter((a) => a.subject === subject).at(-1);
      return own ? { id: own.id, issuedAt: own.issuedAt } : null;
    },
    sleep: async (ms) => void sleeps.push(ms),
    now: () => NOW,
  });

  const pass = async (over: Partial<WorkerConfig> = {}) => {
    const store = await WorkerStore.load(dir, { address: DESK, chainId: 10143 });
    return { result: await runWorkerPass({ effects: effects(), store, config: { ...config, ...over }, onEvent: (e) => events.push(e) }), store };
  };
  const statusFile = async () => workerStatusSchema.parse(JSON.parse(await readFile(path.join(dir, WORKER_DIR, 'status.json'), 'utf8')));
  const stateFile = async () => workerStateSchema.parse(JSON.parse(await readFile(path.join(dir, WORKER_DIR, 'state.json'), 'utf8')));

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-worker-'));
    desk = new StubDesk();
    events = [];
    checks = [];
    attests = 0;
    registry = [];
    attestMinedThenLost = 0;
    onCheck = undefined;
    sleeps = [];
    vaults = new Set([VAULT]);
    failCheck = 0;
    failAttest = 0;
    unknownProxy = false;
    saveFails = 0;
    identityMismatch = false;
    identityChecks = 0;
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('fulfills a vault, rejects a non-vault and unsupported requests, writes status.json and moves the cursor', async () => {
    desk.add(); // 0 vault
    desk.add({ subject: TOKEN }); // 1 not a vault
    desk.add({ subjectChainId: 1n }); // 2 another chain
    desk.add({ standardId: standardIdOf('erc20') }); // 3 another standard
    const { result } = await pass();
    expect(result).toEqual({ cursor: 4n, fulfilled: [0n], rejected: [1n, 2n, 3n], open: [] });
    expect(checks).toEqual([{ subject: VAULT, block: 990n }]);
    expect(desk.calls.filter((c) => !c.startsWith('requestOf'))).toEqual(['fulfill 0 41', 'reject 1 not-erc4626', 'reject 2 unsupported-chain', 'reject 3 unsupported-standard']);

    const s = await statusFile();
    expect(s['0']).toEqual({
      stage: 'fulfilled',
      updatedAt: '2026-09-30T12:00:00.000Z',
      block: '990',
      reportPath: `certs/checks/143/${VAULT.toLowerCase()}/990-0011223344556677.json`,
      attestationId: '41',
      txs: { attest: hash(501), fulfill: hash(1001) },
      gasCostWei: '1300',
    });
    expect(s['1']).toMatchObject({ stage: 'rejected', txs: { reject: hash(1002) }, gasCostWei: '300', error: 'not-erc4626: asset() failed at block 990: execution reverted' });
    expect(s['2']).toMatchObject({ stage: 'rejected', error: 'unsupported-chain: subject chain 1; this worker reads chain 143' });
    expect(s.totals).toEqual({ gasCostWei: '2200', fulfilled: 1, rejected: 3 });
    expect(await stateFile()).toEqual({ version: 1, desk: DESK.toLowerCase(), chainId: 10143, cursor: '4', requests: {} });

    const stages = events.filter((e) => e.type === 'worker-stage' && e.id === '0').map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(['queued', 'prechecking', 'running', 'attesting', 'fulfilling']);
    expect(events.at(-1)).toEqual({ type: 'worker-pass-done', cursor: '4', fulfilled: ['0'], rejected: ['1', '2', '3'], open: [] });

    // The next pass reads from the cursor only and does nothing.
    desk.calls = [];
    events = [];
    expect((await pass()).result).toEqual({ cursor: 4n, fulfilled: [], rejected: [], open: [] });
    expect(desk.calls).toEqual([]);
  });

  it('retries a failing check, then rejects with check-failed and refunds', async () => {
    desk.add();
    failCheck = 5;
    const { result } = await pass();
    expect(result.rejected).toEqual([0n]);
    expect(checks.length).toBe(3);
    expect(sleeps).toEqual([5, 20]);
    expect(events.filter((e) => e.type === 'worker-retry').map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2]);
    expect(desk.calls.at(-1)).toBe('reject 0 check-failed');
    expect((await statusFile())['0']).toMatchObject({ stage: 'rejected', block: '990', error: 'check-failed: check: forge exited with 1: fork RPC 429' });
  });

  it('a check that recovers within the attempts is fulfilled', async () => {
    desk.add();
    failCheck = 2;
    expect((await pass()).result.fulfilled).toEqual([0n]);
    expect(checks.length).toBe(3);
  });

  it('a failed attest keeps the saved report: the next pass attests without checking again', async () => {
    desk.add();
    failAttest = 1;
    const first = await pass();
    expect(first.result).toEqual({ cursor: 0n, fulfilled: [], rejected: [], open: [0n] });
    const st = await stateFile();
    expect(st.requests['0']).toMatchObject({ failures: 1, block: '990', reportPath: expect.stringMatching(/^certs\/checks\/143\//), reportURI: expect.stringMatching(/^https:\/\/example\.org\/checks\/143\//) });
    expect((await statusFile())['0']).toMatchObject({ stage: 'attesting', error: 'attest failed (1 of 3): attest failed (NotIssuer): reverted' });

    const second = await pass();
    expect(second.result).toEqual({ cursor: 1n, fulfilled: [0n], rejected: [], open: [] });
    expect(checks.length).toBe(1);
    expect((await statusFile())['0']).toMatchObject({ stage: 'fulfilled' });
    expect((await statusFile())['0']!).not.toHaveProperty('error');
  });

  it('an attest that keeps failing is rejected with attest-failed after maxTxFailures passes', async () => {
    desk.add();
    failAttest = 99;
    for (let i = 0; i < 2; i++) expect((await pass()).result.open).toEqual([0n]);
    expect((await pass()).result.rejected).toEqual([0n]);
    expect(checks.length).toBe(1);
    expect(desk.calls.at(-1)).toBe('reject 0 attest-failed');
  });

  it('a fulfill that keeps failing is rejected with fulfill-failed; the attestation is kept across passes', async () => {
    desk.add();
    desk.failFulfill = 3;
    await pass();
    expect((await stateFile()).requests['0']).toMatchObject({ attestationId: '41', failures: 1 });
    expect((await statusFile())['0']).toMatchObject({ stage: 'fulfilling', attestationId: '41', txs: { attest: hash(501) } });
    await pass();
    const last = await pass();
    expect(last.result.rejected).toEqual([0n]);
    expect(attests).toBe(1);
    expect(desk.calls.filter((c) => c.startsWith('fulfill'))).toEqual(['fulfill 0 41', 'fulfill 0 41', 'fulfill 0 41']);
    expect((await statusFile())['0']).toMatchObject({ stage: 'rejected', attestationId: '41', txs: { attest: hash(501), reject: expect.any(String) } });
  });

  it('a reject that keeps failing is given up: the cursor passes it and later passes leave it alone', async () => {
    desk.add({ subject: TOKEN });
    desk.add();
    desk.failReject = 99;
    const r1 = await pass();
    expect(r1.result).toMatchObject({ cursor: 0n, fulfilled: [1n], open: [0n] });
    await pass();
    const r3 = await pass();
    expect(r3.result).toMatchObject({ cursor: 2n, open: [] });
    expect(events.some((e) => e.type === 'worker-gave-up' && e.id === '0')).toBe(true);
    expect((await stateFile()).requests['0']).toMatchObject({ gaveUp: true, reject: 'not-erc4626' });
    expect(((await statusFile())['0'] as WorkerRequestStatus).error).toMatch(/gave up after 3 failed rejects .*refundExpired/);
    // Later passes only read it (to notice a refund); no check, no transaction.
    desk.calls = [];
    await pass();
    expect(desk.calls).toEqual(['requestOf 0']);
  });

  it('an unknown proxy is rejected unless allowUnknownProxy', async () => {
    desk.add();
    unknownProxy = true;
    expect((await pass()).result.rejected).toEqual([0n]);
    expect(desk.calls.at(-1)).toBe('reject 0 unknown-proxy');
    desk.add();
    expect((await pass({ allowUnknownProxy: true })).result.fulfilled).toEqual([1n]);
  });

  it('an identity mismatch is not retried and is rejected with check-failed; nothing is attested', async () => {
    desk.add();
    identityMismatch = true;
    expect((await pass()).result.rejected).toEqual([0n]);
    expect(identityChecks).toBe(1);
    expect(attests).toBe(0);
    expect((await statusFile())['0']).toMatchObject({ stage: 'rejected', error: expect.stringMatching(/^check-failed: identity: identity of 0x802c.* differs from the report/) });
  });

  it('two requests for one vault: one check and one attestation deliver both', async () => {
    desk.add();
    desk.add();
    const { result } = await pass();
    expect(result).toEqual({ cursor: 2n, fulfilled: [0n, 1n], rejected: [], open: [] });
    expect(checks.length).toBe(1);
    expect(attests).toBe(1);
    expect(desk.calls.filter((c) => c.startsWith('fulfill'))).toEqual(['fulfill 0 41', 'fulfill 1 41']);
    expect(events).toContainEqual({ type: 'worker-reused', id: '1', attestationId: '41' });
    const s = await statusFile();
    expect(s['1']).toMatchObject({ stage: 'fulfilled', attestationId: '41', txs: { fulfill: expect.any(String) } });
    expect((s['1'] as WorkerRequestStatus).txs.attest).toBeUndefined();
  });

  it('an attestation older than the request is not reused', async () => {
    registry.push({ id: 7n, subject: VAULT, issuedAt: 1_699_999_999n });
    desk.add();
    await pass();
    expect(attests).toBe(1);
    expect(desk.calls.at(-1)).toBe('fulfill 0 41');
    expect(canDeliver({ issuedAt: 1_699_999_999n }, { requestedAt: 1_700_000_000n })).toBe(false);
    expect(canDeliver({ issuedAt: 1_700_000_000n }, { requestedAt: 1_700_000_000n })).toBe(true);
    expect(canDeliver(null, { requestedAt: 0n })).toBe(false);
  });

  it('an attest that was mined but whose receipt was lost is not sent again: the next pass reuses it', async () => {
    desk.add();
    attestMinedThenLost = 1;
    const first = await pass();
    expect(first.result.open).toEqual([0n]);
    expect((await stateFile()).requests['0']).toMatchObject({ failures: 0 });
    expect((await statusFile())['0']).toMatchObject({ stage: 'attesting', error: 'attest failed (not counted, RPC): fetch failed' });
    const second = await pass();
    expect(second.result.fulfilled).toEqual([0n]);
    expect(attests).toBe(1);
    expect(checks.length).toBe(1);
    expect(desk.calls.at(-1)).toBe('fulfill 0 41');
  });

  it('RPC outages on fulfill never count toward a refund', async () => {
    desk.add();
    const orig = desk.fulfill;
    let down = 5;
    desk.fulfill = async (id, att) => {
      if (down-- > 0) throw Object.assign(new Error('HTTP request failed. Status: 503'), { name: 'HttpRequestError', status: 503 });
      return orig(id, att);
    };
    for (let i = 0; i < 5; i++) expect((await pass()).result.open).toEqual([0n]);
    expect((await stateFile()).requests['0']).toMatchObject({ failures: 0, attestationId: '41' });
    expect((await pass()).result.fulfilled).toEqual([0n]);
    expect(desk.calls.some((c) => c.startsWith('reject'))).toBe(false);
  });

  it('countsAsFailure: reverts count, outages and rate limits do not', () => {
    expect(countsAsFailure(new DeskError('fulfill failed (NotPending)', 'NotPending'))).toBe(true);
    expect(countsAsFailure(new DeskError('fulfill tx 0x1 reverted'))).toBe(true);
    expect(countsAsFailure(Object.assign(new Error('x'), { cause: { name: 'ContractFunctionRevertedError' } }))).toBe(true);
    expect(countsAsFailure(Object.assign(new Error('fetch failed'), { name: 'HttpRequestError' }))).toBe(false);
    expect(countsAsFailure(Object.assign(new Error('Too Many Requests'), { status: 429 }))).toBe(false);
    expect(countsAsFailure(new Error('Timed out while waiting for transaction'))).toBe(false);
  });

  it('a request refunded while it is being checked is not attested', async () => {
    desk.add();
    onCheck = () => {
      desk.requests[0]!.status = 4;
    };
    const { result } = await pass();
    expect(result).toEqual({ cursor: 1n, fulfilled: [], rejected: [], open: [] });
    expect(attests).toBe(0);
    expect(events).toContainEqual({ type: 'worker-closed', id: '0', status: 'Refunded' });
  });

  it('an error outside the transaction steps is rejected with check-failed after maxTxFailures passes', async () => {
    desk.add();
    saveFails = 99;
    for (let i = 0; i < 3; i++) expect((await pass()).result.open).toEqual([0n]);
    expect((await stateFile()).requests['0']).toMatchObject({ reject: 'check-failed', detail: 'worker error 3 passes in a row: EACCES: permission denied' });
    expect((await pass()).result.rejected).toEqual([0n]);
    expect(checks.length).toBe(3);
    expect((await statusFile())['0']).toMatchObject({ stage: 'rejected', error: 'check-failed: worker error 3 passes in a row: EACCES: permission denied' });
  });

  it('a reject above the gas cap is not sent: the worker gives up at once, and notices the refund later', async () => {
    desk.add({ subject: TOKEN });
    desk.rejectGas = 1_000_000n;
    const { result } = await pass({ maxRejectGas: 300_000n });
    expect(result).toEqual({ cursor: 1n, fulfilled: [], rejected: [], open: [] });
    expect(desk.txn).toBe(0);
    expect((await stateFile()).requests['0']).toMatchObject({ gaveUp: true });
    expect((await statusFile())['0']!).toMatchObject({ error: expect.stringMatching(/^gave up: reject needs 1000000 gas, above the cap of 300000; not sent; the requester can call refundExpired/) });
    // The requester refunds itself; the next pass notices it although the request is below the cursor.
    desk.requests[0]!.status = 4;
    await pass();
    expect((await stateFile()).requests).toEqual({});
    expect((await statusFile())['0']).toMatchObject({ error: 'request is Refunded onchain; the worker did not close it' });
  });

  it('a request refunded before its turn is not checked and is recorded as closed', async () => {
    desk.add();
    desk.add();
    // Request 1 is refunded by someone while request 0 is being worked on.
    const origFulfill = desk.fulfill;
    desk.fulfill = async (id, att) => {
      const tx = await origFulfill(id, att);
      desk.requests[1]!.status = 4;
      return tx;
    };
    const { result } = await pass();
    expect(result).toEqual({ cursor: 2n, fulfilled: [0n], rejected: [], open: [] });
    expect(checks.length).toBe(1);
    expect(events).toContainEqual({ type: 'worker-closed', id: '1', status: 'Refunded' });
    expect((await statusFile())['1']).toMatchObject({ stage: 'queued', error: 'request is Refunded onchain; the worker did not close it' });
  });

  it('an unexpected error leaves the request open with its error; the next pass checks it again', async () => {
    desk.add();
    saveFails = 1;
    const first = await pass();
    expect(first.result.open).toEqual([0n]);
    expect(events).toContainEqual({ type: 'worker-error', id: '0', error: 'EACCES: permission denied' });
    expect((await statusFile())['0']).toMatchObject({ stage: 'running', error: 'EACCES: permission denied' });
    expect((await pass()).result.fulfilled).toEqual([0n]);
    expect(checks.length).toBe(2);
  });

  it('a request closed onchain by a transaction the worker did not record is marked from the chain', async () => {
    desk.add();
    desk.failFulfill = 0;
    await (await WorkerStore.load(dir, { address: DESK, chainId: 10143 })).save();
    const store = await WorkerStore.load(dir, { address: DESK, chainId: 10143 });
    withStage(store.status, '0', { stage: 'fulfilling', attestationId: '7' }, new Date());
    store.state.requests['0'] = { failures: 0, attestationId: '7' };
    await store.save();
    desk.requests[0]!.status = 2;
    desk.requests[0]!.attestationId = 7n;
    const { result } = await pass();
    expect(result.cursor).toBe(1n);
    expect((await statusFile())['0']).toMatchObject({ stage: 'fulfilled', attestationId: '7' });
    expect((await stateFile()).requests).toEqual({});
  });
});

describe('WorkerStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'specfirst-store-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('starts fresh, saves both files, and refuses a state of another desk or chain', async () => {
    const s = await WorkerStore.load(dir, { address: DESK, chainId: 10143 });
    expect(s.state).toEqual({ version: 1, desk: DESK.toLowerCase(), chainId: 10143, cursor: '0', requests: {} });
    await s.save();
    expect(existsSync(path.join(dir, WORKER_DIR, 'status.json'))).toBe(true);
    await expect(WorkerStore.load(dir, { address: VAULT, chainId: 10143 })).rejects.toThrow(WorkerError);
    await expect(WorkerStore.load(dir, { address: DESK, chainId: 31337 })).rejects.toThrow(/belongs to desk 0x5fbdb.* on chain 10143.*move \.specfirst\/worker away/);
  });

  it('the worker lock refuses a second live worker and takes over a stale lock', async () => {
    const release = await acquireWorkerLock(dir, { pid: 111, isAlive: () => true });
    expect((await readFile(path.join(dir, WORKER_DIR, 'worker.lock'), 'utf8')).trim()).toBe('111');
    await expect(acquireWorkerLock(dir, { pid: 222, isAlive: (p) => p === 111 })).rejects.toThrow(/another worker \(pid 111\) is running/);
    const next = await acquireWorkerLock(dir, { pid: 222, isAlive: () => false });
    expect((await readFile(path.join(dir, WORKER_DIR, 'worker.lock'), 'utf8')).trim()).toBe('222');
    await release(); // 111 no longer holds it: its release leaves 222's lock alone
    expect(existsSync(path.join(dir, WORKER_DIR, 'worker.lock'))).toBe(true);
    await next();
    expect(existsSync(path.join(dir, WORKER_DIR, 'worker.lock'))).toBe(false);
  });

  it('refuses a broken state.json or status.json', async () => {
    await mkdir(path.join(dir, WORKER_DIR), { recursive: true });
    await writeFile(path.join(dir, WORKER_DIR, 'state.json'), '{"version":1}');
    await expect(WorkerStore.load(dir, { address: DESK, chainId: 10143 })).rejects.toThrow(/worker state .* is invalid/);
    await writeFile(path.join(dir, WORKER_DIR, 'state.json'), 'not json');
    await expect(WorkerStore.load(dir, { address: DESK, chainId: 10143 })).rejects.toThrow(/not readable JSON/);
    await writeFile(path.join(dir, WORKER_DIR, 'state.json'), JSON.stringify({ version: 1, desk: DESK.toLowerCase(), chainId: 10143, cursor: '0', requests: {} }));
    await writeFile(path.join(dir, WORKER_DIR, 'status.json'), JSON.stringify({ totals: { gasCostWei: '0', fulfilled: 0, rejected: 0 }, x: {} }));
    await expect(WorkerStore.load(dir, { address: DESK, chainId: 10143 })).rejects.toThrow(/worker status .* is invalid/);
  });
});

describe('RequestDeskClient (mocks, no RPC)', () => {
  const DECOY = getAddress('0x00000000000000000000000000000000000000d1');
  const requested = checkRequestDeskAbi.find((x) => x.type === 'event' && x.name === 'CheckRequested')!;
  const requestedLog = (address: Address, id: bigint) => ({
    address: address.toLowerCase(),
    topics: encodeEventTopics({ abi: checkRequestDeskAbi, eventName: 'CheckRequested', args: { id, requester: REQUESTER, subject: VAULT } }),
    data: encodeAbiParameters((requested as { inputs: readonly { indexed?: boolean }[] }).inputs.filter((i) => !i.indexed) as never, [143n, ERC4626, 5n] as never),
    blockNumber: 5n,
    logIndex: 0,
    transactionHash: hash(9),
  });
  const make = (logs: unknown[], read?: (fn: string) => unknown) => {
    const simulate = vi.fn(async (_call: unknown) => ({ request: {}, result: 999n }));
    const write = vi.fn(async () => hash(9));
    const c = new RequestDeskClient(
      DESK,
      {
        readContract: vi.fn(async ({ functionName }: { functionName: string }) => (read ? read(functionName) : 5n)),
        simulateContract: simulate,
        estimateContractGas: vi.fn(async () => 100_000n),
        waitForTransactionReceipt: vi.fn(async () => ({ status: 'success', blockNumber: 5n, gasUsed: 21_000n, effectiveGasPrice: 2n, logs })),
      } as never,
      { account: { address: REQUESTER }, writeContract: write } as never,
    );
    return { c, simulate, write };
  };

  it('requestCheck pays the fee read first and takes the id from its own CheckRequested log', async () => {
    const { c, simulate } = make([requestedLog(DECOY, 7n), requestedLog(DESK, 3n)]);
    const out = await c.requestCheck({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626 });
    expect(out).toMatchObject({ id: 3n, fee: 5n, gasCostWei: 42_000n, effectiveGasPrice: 2n });
    expect((simulate.mock.calls[0]![0] as { value: bigint }).value).toBe(5n);
    await expect(make([requestedLog(DECOY, 7n)]).c.requestCheck({ subjectChainId: 143n, subject: VAULT, standardId: ERC4626 }, 5n)).rejects.toThrow(/expected one CheckRequested event .* found 0/);
  });

  it('reject encodes a reason code; custom errors come back by name', async () => {
    const { c, simulate } = make([]);
    await c.reject(1n, 'not-erc4626');
    expect((simulate.mock.calls[0]![0] as { args: unknown[] }).args).toEqual([1n, reasonCodeOf('not-erc4626')]);
    const failing = new RequestDeskClient(
      DESK,
      { simulateContract: vi.fn(async () => { throw Object.assign(new Error('reverted'), { shortMessage: 'reverted', cause: { data: { errorName: 'NotPending' } } }); }) } as never,
      { account: { address: REQUESTER } } as never,
    );
    await expect(failing.fulfill(1n, 2n)).rejects.toMatchObject({ name: 'DeskError', errorName: 'NotPending', message: 'fulfill failed (NotPending): reverted' });
  });

  it('reject with maxGas refuses to send above the cap', async () => {
    const { c, write } = make([]);
    await expect(c.reject(1n, 'not-erc4626', { maxGas: 50_000n })).rejects.toMatchObject({ errorName: 'GasCapExceeded', message: 'reject needs 100000 gas, above the cap of 50000; not sent' });
    expect(write).not.toHaveBeenCalled();
    await c.reject(1n, 'not-erc4626', { maxGas: 100_000n });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('requestOf maps UnknownRequest to a DeskError', async () => {
    const c = new RequestDeskClient(DESK, { readContract: vi.fn(async () => { throw { data: { errorName: 'UnknownRequest' } }; }) } as never);
    await expect(c.requestOf(9n)).rejects.toThrow(/no request with id 9 \(UnknownRequest\)/);
    expect(REQUEST_STATUS[1]).toBe('Pending');
  });

});

describe('bundled CheckRequestDesk artifact', () => {
  const contracts = path.resolve(here, '../../contracts');
  const built = path.join(contracts, 'out/CheckRequestDesk.sol/CheckRequestDesk.json');
  // Skipped only when forge is not installed; with forge the build runs here, so a stale artifact fails.
  const hasForge = spawnSync('forge', ['--version'], { stdio: 'ignore' }).status === 0;
  it.skipIf(!hasForge)('matches a fresh forge build (regenerate with scripts/gen-desk-artifact.mjs)', () => {
    const build = spawnSync('forge', ['build'], { cwd: contracts, encoding: 'utf8', timeout: 240_000 });
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);
    const art = JSON.parse(readFileSync(built, 'utf8')) as { abi: unknown; bytecode: { object: string } };
    expect(checkRequestDeskAbi).toEqual(art.abi);
    expect(checkRequestDeskBytecode).toBe(art.bytecode.object);
  }, 300_000);
});
