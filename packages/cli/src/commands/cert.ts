import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CERT_FAILED_EXIT_CODE, CERT_STATUS, evidenceHash, RegistryClient, RegistryError, type VerifyRecord } from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import type { Address } from 'viem';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import { ConfigError, ISSUER_KEY_ENV, resolveKey, resolveNetwork, resolveRegistry, type NetworkOptions } from '../lib/network.js';
import { issueStage, loadRun, StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';
import { registerAttestCommands } from './attest.js';

interface IssueOptions extends NetworkOptions {
  run: string;
  allowPartial?: boolean;
  ackEnvWarnings?: boolean;
  reportBaseUrl?: string;
}

interface RevokeOptions extends NetworkOptions {
  evidence: string;
  evidenceUri?: string;
  certId?: string;
}

const networkOptions = (c: Command) =>
  c
    .option('--network <name>', 'anvil or monad-testnet', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--registry <address>', 'CertificateRegistry address (default: $SPECFIRST_REGISTRY_<chainId>)');

/**
 * Evidence for a revoke must be a verify.json for the same chain and target that records at least one
 * violated invariant (plan 3.7: revoke only with evidence of a violation).
 */
export function checkEvidence(v: Partial<VerifyRecord>, chainId: number, target: Address): string | null {
  if (v.version !== 1 || !Array.isArray(v.invariants)) return 'evidence is not a verify.json';
  if (v.chainId !== chainId) return `evidence is for chain ${v.chainId}, network is ${chainId}`;
  if (!v.target || v.target.toLowerCase() !== target.toLowerCase()) return `evidence is for ${v.target}, not ${target}`;
  if (!v.invariants.some((i) => i.ok === false)) return 'evidence records no violated invariant';
  return null;
}

/** `specfirst cert issue --run <id>` and `specfirst cert revoke <address> --evidence <verify.json>`. Exit 0 or 14. */
export function registerCertCommand(program: Command): void {
  const cert = program.command('cert').description('Issue or revoke on-chain certificates, and attest check reports.');
  registerAttestCommands(cert);

  networkOptions(
    cert
      .command('issue')
      .description("Build report.json from a run's deploy, rehearsal and verify records and issue a certificate.")
      .requiredOption('--run <id>', 'run id whose report to submit')
      .option('--allow-partial', 'issue even when not every invariant passed (isCertified stays false)')
      .option('--ack-env-warnings', 'a human reviewed the environment-branch warnings of this run')
      .option('--report-base-url <url>', 'reportURI prefix; <url>/<chainId>/<address>/<certId>.json (default: repo-relative certs/ path)'),
  ).action(async (opts: IssueOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'cert issue', CERT_FAILED_EXIT_CODE, async () => {
      const run = await loadRun(ctx.projectDir, opts.run);
      const net = resolveNetwork(opts);
      const issuerKey = resolveKey(net, ISSUER_KEY_ENV);
      const registry = resolveRegistry(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const out = await issueStage({
        projectDir: ctx.projectDir,
        run,
        net,
        issuerKey,
        registry,
        allowPartial: opts.allowPartial,
        ackEnvWarnings: opts.ackEnvWarnings,
        reportBaseUrl: opts.reportBaseUrl ?? process.env.SPECFIRST_REPORT_BASE_URL,
        log: (l) => printLine(ctx, l),
      });
      emitEvent(ctx, { type: 'cert-issued', runId: run.runId, ...out });
    });
  });

  networkOptions(
    cert
      .command('revoke <address>')
      .description('Revoke a certificate with evidence of a violation.')
      .requiredOption('--evidence <file>', 'verify.json recording the violation')
      .option('--evidence-uri <uri>', 'public URI of the evidence stored on-chain (default: the evidence path)')
      .option('--cert-id <n>', 'certificate id (default: the latest one of the address)'),
  ).action(async (address: string, opts: RevokeOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'cert revoke', CERT_FAILED_EXIT_CODE, async () => {
      const net = resolveNetwork(opts);
      const issuerKey = resolveKey(net, ISSUER_KEY_ENV);
      const registryAddr = resolveRegistry(net, opts);
      const target = address as Address;
      const evidencePath = path.resolve(ctx.projectDir, opts.evidence);
      if (!existsSync(evidencePath)) throw new StageError(CERT_FAILED_EXIT_CODE, `evidence file not found: ${opts.evidence}`);
      const raw = await readFile(evidencePath);
      let parsed: Partial<VerifyRecord>;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new StageError(CERT_FAILED_EXIT_CODE, 'evidence is not JSON');
      }
      const problem = checkEvidence(parsed, net.clients.chain.id, target);
      if (problem) throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to revoke: ${problem}`);

      const registry = new RegistryClient(registryAddr, net.clients.publicClient, net.clients.wallet(issuerKey));
      let certId: bigint;
      if (opts.certId !== undefined) {
        certId = BigInt(opts.certId);
      } else {
        const latest = await registry.latest(target);
        if (!latest) throw new StageError(CERT_FAILED_EXIT_CODE, `no certificate for ${target}`);
        certId = latest.certId;
      }
      const reasonHash = evidenceHash(raw);
      const evidenceURI = opts.evidenceUri ?? path.relative(ctx.projectDir, evidencePath);
      let tx;
      try {
        tx = await registry.revoke(target, certId, reasonHash, evidenceURI);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(CERT_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
        throw err;
      }
      const after = await registry.certificateOf(target, certId);
      const violated = (parsed.invariants ?? []).filter((i) => i.ok === false).map((i) => i.id);
      printLine(ctx, stage('revoke', `${target} certId ${certId}  ${pc.red(CERT_STATUS[after.status] ?? String(after.status))}  violated ${violated.join(', ')}`));
      printLine(ctx, cont(pc.dim(`tx ${tx.hash}  block ${tx.blockNumber}  reasonHash ${reasonHash.slice(0, 10)}  evidence ${evidenceURI}`)));
      emitEvent(ctx, { type: 'cert-revoked', target, certId: certId.toString(), txHash: tx.hash, reasonHash, evidenceURI, violated });
    });
  });
}

