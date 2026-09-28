import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildReport,
  CERT_FAILED_EXIT_CODE,
  createWorktree,
  DEPLOY_FAILED_EXIT_CODE,
  DEPLOY_JSON,
  deployContract,
  DeployError,
  parseSpec,
  projectIdHash,
  readArtifact,
  readJson,
  RegistryClient,
  RegistryError,
  rehearse,
  REHEARSAL_JSON,
  REPORT_JSON,
  reportHash,
  RUNS_DIR,
  VERIFY_FAILED_EXIT_CODE,
  VERIFY_JSON,
  verifyDeployment,
  WORKTREES_DIR,
  writeJson,
  type DeployRecord,
  type RehearsalRecord,
  type RehearsalTx,
  type RunSummaryLike,
  type Spec,
  type VerifyRecord,
} from '@specfirst/core';
import pc from 'picocolors';
import type { Address, Hex } from 'viem';
import { cont, stage } from './runLog.js';
import type { ResolvedNetwork } from './network.js';

export const CERT_JSON = 'cert.json';

/** A stage outcome: exit code 0 on success, otherwise 12, 13 or 14 with a message. */
export class StageError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'StageError';
  }
}

export interface RunSummaryFile extends RunSummaryLike {
  spec: RunSummaryLike['spec'];
  exitCode: number;
  [k: string]: unknown;
}

export interface LoadedRun {
  runId: string;
  runDir: string;
  summary: RunSummaryFile;
  spec: Spec;
}

export type Log = (line: string) => void;

export async function loadRun(projectDir: string, runId: string): Promise<LoadedRun> {
  const runDir = path.join(projectDir, RUNS_DIR, runId);
  const runJson = path.join(runDir, 'run.json');
  if (!existsSync(runJson)) throw new Error(`no run ${runId} (missing ${path.relative(projectDir, runJson)})`);
  const summary = await readJson<RunSummaryFile>(runJson);
  // Parse the spec as locked for this run: read it from the run's final commit when possible.
  const specText = await readFile(path.join(projectDir, summary.spec.path), 'utf8');
  return { runId, runDir, summary, spec: parseSpec(specText) };
}

/** Detached worktree at the run's final commit, shared by deploy and verify. Reused when present. */
export async function ensureRunWorktree(projectDir: string, run: LoadedRun): Promise<string> {
  const wt = path.join(projectDir, WORKTREES_DIR, `${run.runId}-deploy`, 'iter-0');
  if (existsSync(path.join(wt, '.git'))) return wt;
  return (await createWorktree(projectDir, `${run.runId}-deploy`, 0, run.summary.finalCommit)).path;
}

export function buildOutDir(run: LoadedRun): string {
  return path.join(run.runDir, 'build', 'out');
}

// ---------------------------------------------------------------- deploy

export interface DeployStageInput {
  projectDir: string;
  run: LoadedRun;
  net: ResolvedNetwork;
  deployerKey: Hex;
  /** Deploy even when the run did not pass (e.g. the uncertified v0 demo vault). */
  force?: boolean;
  log: Log;
}

export async function deployStage(i: DeployStageInput): Promise<DeployRecord> {
  const { run, net } = i;
  if (run.summary.status !== 'passed' && !i.force) {
    throw new StageError(DEPLOY_FAILED_EXIT_CODE, `run ${run.runId} did not pass (${run.summary.status}); refusing to deploy (use --force for an uncertified demo deploy)`);
  }
  try {
    const wt = await ensureRunWorktree(i.projectDir, run);
    const { record } = await deployContract({
      spec: run.spec,
      worktreeOrProjectDir: wt,
      client: net.clients.publicClient,
      walletClient: net.clients.wallet(i.deployerKey),
      outDir: buildOutDir(run),
      commit: run.summary.finalCommit,
      recordPath: path.join(run.runDir, DEPLOY_JSON),
    });
    i.log(stage('deploy', `${record.contract.name} ${pc.bold(record.address)}  ${pc.dim(`${net.name} ${record.chainId}`)}`));
    i.log(cont(pc.dim(`tx ${record.txHash}  block ${record.blockNumber}  gas ${record.gasUsed}/${record.gasLimit}  codeHash ${record.codeHash.slice(0, 10)}`)));
    return record;
  } catch (err) {
    if (err instanceof StageError) throw err;
    const msg = err instanceof DeployError ? err.message : `deploy failed: ${(err as Error).message}`;
    throw new StageError(DEPLOY_FAILED_EXIT_CODE, msg);
  }
}

// ---------------------------------------------------------------- rehearse + verify

function txLine(t: RehearsalTx): string {
  const sel = typeof t.selector === 'object' ? (t.selector.match ? t.selector.expectedError : `selector ${t.selector.actual} != ${t.selector.expectedError}`) : (t.selector ?? '');
  const mark = t.verdict === 'reverted' ? pc.green('✓') : pc.red('✗');
  return `  ${mark} #${String(t.n).padStart(2)} ${t.label}  ${pc.dim(`${t.verdict}${t.expectRevert === 'inner' ? ' (inner)' : ''} gas ${t.gasUsed}/${t.gasLimit}`)}  ${pc.dim(sel)}`;
}

export interface RehearseStageInput {
  run: LoadedRun;
  net: ResolvedNetwork;
  deployerKey: Hex;
  deploy: DeployRecord;
  log: Log;
}

export async function rehearseStage(i: RehearseStageInput): Promise<RehearsalRecord> {
  const outDir = buildOutDir(i.run);
  const target = await readArtifact(outDir, i.deploy.contract.sourceFile, i.deploy.contract.name);
  const attacker = i.run.spec.actors.attacker ? await readArtifact(outDir, 'Attacker.sol', 'Attacker') : undefined;
  const r = await rehearse({
    spec: i.run.spec,
    clients: i.net.clients,
    deployerKey: i.deployerKey,
    target: i.deploy.address,
    targetAbi: target.abi,
    attacker,
    runId: i.run.runId,
    recordPath: path.join(i.run.runDir, REHEARSAL_JSON),
  });
  const s = r.summary;
  i.log(stage('rehearse', `${r.txs.length} tx  ${s.normalOk}/${s.normal} normal ok  ${s.reverted}/${s.expectRevert} revert-expected reverted  selectors ${s.selectorConfirmed}/${s.expectRevert}  ${pc.dim(`blocks ${r.fromBlock}~${r.toBlock}`)}`));
  for (const t of r.txs.filter((x) => x.expectRevert)) i.log(txLine(t));
  return r;
}

export interface VerifyStageInput {
  projectDir: string;
  run: LoadedRun;
  net: ResolvedNetwork;
  deploy: DeployRecord;
  rehearsal: RehearsalRecord | null;
  runs?: number;
  seed?: string;
  forceProbe?: boolean;
  log: Log;
}

export async function verifyStage(i: VerifyStageInput): Promise<VerifyRecord> {
  const wt = await ensureRunWorktree(i.projectDir, i.run);
  const v = await verifyDeployment({
    spec: i.run.spec,
    projectDir: wt,
    client: i.net.clients.publicClient,
    forkUrl: i.net.forkUrl,
    target: i.deploy.address,
    deployBlock: BigInt(i.deploy.blockNumber),
    rehearsal: i.rehearsal,
    runs: i.runs,
    seed: i.seed,
    forceProbe: i.forceProbe,
    artifactDir: path.join(i.run.runDir, 'verify'),
    outDir: buildOutDir(i.run),
    recordPath: path.join(i.run.runDir, VERIFY_JSON),
  });
  const where = v.path === 'fork' ? `fork block ${v.fork!.block}  runs ${v.fork!.runs}` : `probe block ${v.probe!.block}  ${pc.yellow(v.note ?? '')}`;
  i.log(stage('verify', `${where}  depositors ${v.depositors.count} (${v.depositors.chunks} getLogs chunk${v.depositors.chunks === 1 ? '' : 's'})`));
  for (const inv of v.invariants) {
    const mark = inv.ok === true ? pc.green('✓') : inv.ok === false ? pc.red('✗') : pc.yellow('?');
    const first = inv.evidence.find((e) => /fork block|probe/.test(e)) ?? inv.evidence[0] ?? '';
    const extra = inv.evidence.length > 1 ? pc.dim(`  +${inv.evidence.length - 1} evidence`) : '';
    i.log(`  ${mark} ${inv.id}  ${pc.dim(first.length > 110 ? `${first.slice(0, 107)}...` : first)}${extra}`);
  }
  const verdict = v.violated > 0 ? pc.red(`${v.violated} violated`) : v.unjudged > 0 ? pc.yellow(`${v.unjudged} unjudged`) : pc.green(`${v.passed}/${v.invariants.length} ok`);
  i.log(cont(`${verdict}  ${pc.dim(path.relative(i.projectDir, path.join(i.run.runDir, VERIFY_JSON)))}`));
  if (v.violated > 0) {
    throw new StageError(VERIFY_FAILED_EXIT_CODE, `verify: ${v.invariants.filter((x) => x.ok === false).map((x) => x.id).join(', ')} violated on ${v.target}`);
  }
  return v;
}

// ---------------------------------------------------------------- cert issue

export interface IssueStageInput {
  projectDir: string;
  run: LoadedRun;
  net: ResolvedNetwork;
  issuerKey: Hex;
  registry: Address;
  allowPartial?: boolean;
  ackEnvWarnings?: boolean;
  /** reportURI = <base>/<chainId>/<address>/<certId>.json. Default: the repo-relative certs/ path. */
  reportBaseUrl?: string;
  log: Log;
}

export interface IssueOutcome {
  certId: string;
  txHash: Hex;
  blockNumber: string;
  reportHash: Hex;
  reportURI: string;
  reportPath: string;
  passedCount: number;
  totalCount: number;
  passedBitmap: string;
  registry: Address;
  chainId: number;
  target: Address;
}

export async function issueStage(i: IssueStageInput): Promise<IssueOutcome> {
  const { run, net } = i;
  const need = async <T>(file: string, what: string): Promise<T> => {
    const p = path.join(run.runDir, file);
    if (!existsSync(p)) throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: ${what} missing (${path.relative(i.projectDir, p)})`);
    return readJson<T>(p);
  };
  if (run.summary.status !== 'passed') {
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: run ${run.runId} did not pass (${run.summary.status})`);
  }
  if (run.summary.envWarnings.length > 0 && !i.ackEnvWarnings) {
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: ${run.summary.envWarnings.length} environment-branch warning(s) need human review first (--ack-env-warnings)`);
  }
  const deploy = await need<DeployRecord>(DEPLOY_JSON, 'deploy.json');
  const rehearsal = existsSync(path.join(run.runDir, REHEARSAL_JSON)) ? await readJson<RehearsalRecord>(path.join(run.runDir, REHEARSAL_JSON)) : null;
  const verify = await need<VerifyRecord>(VERIFY_JSON, 'verify.json');
  if (deploy.chainId !== net.clients.chain.id) {
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: run deployed on chain ${deploy.chainId}, network is ${net.clients.chain.id}`);
  }
  if (verify.target.toLowerCase() !== deploy.address.toLowerCase()) {
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: verify.json is for ${verify.target}, deploy.json for ${deploy.address}`);
  }
  if (verify.violated > 0) throw new StageError(CERT_FAILED_EXIT_CODE, 'cert issue: verify.json records violations');

  const failing = new Set(run.summary.result?.failing ?? []);
  const fuzzStatus = Object.fromEntries(run.spec.invariants.map((inv) => [inv.id, failing.has(inv.id) ? 'fail' : 'pass'])) as Record<string, 'pass' | 'fail'>;
  const report = buildReport({ spec: run.spec, run: run.summary, fuzzStatus, deploy, rehearsal, verify });
  if (report.passedCount < report.totalCount && !(i.allowPartial || run.summary.allowPartial)) {
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: ${report.passedCount}/${report.totalCount} passed; a partial certificate needs --allow-partial`);
  }
  const hash = reportHash(report);
  const wallet = net.clients.wallet(i.issuerKey);
  const registry = new RegistryClient(i.registry, net.clients.publicClient, wallet);

  let certIdGuess: bigint;
  try {
    certIdGuess = await registry.certificateCount(deploy.address);
  } catch (err) {
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: cannot read registry ${i.registry}: ${(err as Error).message.split('\n')[0]}`);
  }
  const rel = `certs/${deploy.chainId}/${deploy.address}/${certIdGuess}.json`;
  const reportURI = i.reportBaseUrl ? `${i.reportBaseUrl.replace(/\/$/, '')}/${deploy.chainId}/${deploy.address}/${certIdGuess}.json` : rel;
  const reportPath = path.join(run.runDir, REPORT_JSON);
  await writeJson(reportPath, report);

  let out: Awaited<ReturnType<RegistryClient['issue']>>;
  try {
    out = await registry.issue({
      target: deploy.address,
      projectId: projectIdHash(run.spec.projectId),
      specHash: report.hashes.specHash,
      invariantSetHash: report.hashes.invariantSetHash,
      propertyHash: report.hashes.propertyHash,
      reportHash: hash,
      passedCount: report.passedCount,
      totalCount: report.totalCount,
      passedBitmap: BigInt(report.passedBitmap),
      rehearsalTxCount: rehearsal?.txs.length ?? 0,
      reportURI,
    });
  } catch (err) {
    const msg = err instanceof RegistryError ? err.message : (err as Error).message;
    throw new StageError(CERT_FAILED_EXIT_CODE, `cert issue: ${msg.split('\n')[0]}`);
  }
  const certsCopy = path.join(i.projectDir, rel);
  await mkdir(path.dirname(certsCopy), { recursive: true });
  await copyFile(reportPath, certsCopy);

  const outcome: IssueOutcome = {
    certId: out.certId.toString(),
    txHash: out.hash,
    blockNumber: out.blockNumber.toString(),
    reportHash: hash,
    reportURI,
    reportPath: rel,
    passedCount: report.passedCount,
    totalCount: report.totalCount,
    passedBitmap: report.passedBitmap,
    registry: i.registry,
    chainId: deploy.chainId,
    target: deploy.address,
  };
  await writeFile(path.join(run.runDir, CERT_JSON), `${JSON.stringify(outcome, null, 2)}\n`);
  i.log(stage('issue', `certId ${outcome.certId}  ${pc.green(`${report.passedCount}/${report.totalCount}`)}  bitmap ${report.passedBitmap}  ${pc.dim(`registry ${i.registry}`)}`));
  i.log(cont(pc.dim(`tx ${out.hash}  block ${outcome.blockNumber}  reportHash ${hash.slice(0, 10)}  ${rel}`)));
  return outcome;
}
