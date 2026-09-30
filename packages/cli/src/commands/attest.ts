import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ATTESTATION_STATUS,
  AttestationError,
  AttestationRegistryClient,
  attestationParamsFromReport,
  badChecksum,
  CERT_FAILED_EXIT_CODE,
  DEPLOY_FAILED_EXIT_CODE,
  deployAttestationRegistry,
  evidenceHash,
  NETWORKS,
  parseCheckReport,
  RegistryError,
  rpcTransport,
  verifySubjectCode,
  type Attestation,
  type SubjectClient,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createPublicClient, getAddress, type Address } from 'viem';
import { contextFrom, emitEvent, printLine } from '../lib/context.js';
import {
  attestRegistryEnvVar,
  ConfigError,
  DEPLOYER_KEY_ENV,
  ISSUER_KEY_ENV,
  resolveAttestRegistry,
  resolveKey,
  resolveNetwork,
  subjectRpcFor,
} from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

interface WriteOptions {
  network: string;
  rpc?: string;
  registryAttest?: string;
}

interface AttestOptions extends WriteOptions {
  subjectRpc?: string;
  reportBaseUrl?: string;
}

interface RevokeAttestationOptions extends WriteOptions {
  evidence: string;
}

const writeNetworkOptions = (c: Command) =>
  c
    .option('--network <name>', 'network of the attestation registry: monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL of that network (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--registry-attest <address>', 'CheckAttestationRegistry address (default: $SPECFIRST_ATTEST_REGISTRY_<chainId>)');

function counts(a: { passCount: number; failCount: number; inconclusiveCount: number; notApplicableCount: number }): string {
  return `${pc.green(`${a.passCount} pass`)}, ${a.failCount ? pc.red(`${a.failCount} fail`) : '0 fail'}, ${a.inconclusiveCount} inconclusive, ${a.notApplicableCount} not applicable`;
}

function address(raw: string, what: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || badChecksum(raw)) throw new ConfigError(`${what} must be a 0x address with a valid checksum, got "${raw}"`);
  return getAddress(raw);
}

/** Subject chain reads use their own client on one URL; no wallet exists for it. */
function subjectClient(chainId: number, url: string): SubjectClient {
  const chain = Object.values(NETWORKS).find((c) => c.id === chainId);
  return createPublicClient({ ...(chain ? { chain } : {}), transport: rpcTransport([url]) }) as unknown as SubjectClient;
}

/**
 * `cert attest`, `cert attestation`, `cert revoke-attestation` on CheckAttestationRegistry (ADR 0004).
 * Writes go through resolveNetwork without readOnly, so monad-mainnet is refused and every send is
 * preceded by the transport's eth_chainId check. Exit 0, or 14 on any attestation failure.
 */
export function registerAttestCommands(cert: Command): void {
  writeNetworkOptions(
    cert
      .command('attest <report>')
      .description('Record a `specfirst check` report in CheckAttestationRegistry after checking the subject code on its own chain.')
      .option('--subject-rpc <url>', 'read-only RPC of the report chain (default: that chain\'s env variable or public RPC)')
      .option('--report-base-url <url>', 'reportURI prefix; <url>/checks/<chainId>/<address>/<block>.json (default: repo-relative certs/checks path)'),
  ).action(async (reportArg: string, opts: AttestOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'cert attest', CERT_FAILED_EXIT_CODE, async () => {
      const reportPath = path.resolve(ctx.projectDir, reportArg);
      if (!existsSync(reportPath)) throw new ConfigError(`report not found: ${reportArg}`);
      const raw = await readFile(reportPath, 'utf8');
      let report;
      try {
        report = parseCheckReport(raw);
      } catch (err) {
        throw new StageError(CERT_FAILED_EXIT_CODE, (err as Error).message);
      }
      const net = resolveNetwork(opts);
      const issuerKey = resolveKey(net, ISSUER_KEY_ENV);
      const registryAddress = resolveAttestRegistry(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);

      const subjectUrl = subjectRpcFor(report.chainId, opts.subjectRpc);
      let code;
      try {
        code = await verifySubjectCode(subjectClient(report.chainId, subjectUrl), report);
      } catch (err) {
        if (err instanceof AttestationError) throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to attest: ${err.message}`);
        throw err;
      }
      printLine(ctx, stage('subject', `${report.address}  chain ${report.chainId}  block ${report.blockNumber}  ${pc.dim(`codeHash ${code.codeHash.slice(0, 18)} matches the report`)}`));

      const addr = report.address.toLowerCase();
      const rel = `certs/checks/${report.chainId}/${addr}/${report.blockNumber}.json`;
      const reportURI = opts.reportBaseUrl ? `${opts.reportBaseUrl.replace(/\/$/, '')}/checks/${report.chainId}/${addr}/${report.blockNumber}.json` : rel;
      const params = attestationParamsFromReport(report, { reportURI });
      const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient, net.clients.wallet(issuerKey));
      let out;
      try {
        out = await registry.attest(params);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(CERT_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
        throw err;
      }
      const copy = path.join(ctx.projectDir, rel);
      if (path.resolve(copy) !== reportPath) {
        await mkdir(path.dirname(copy), { recursive: true });
        await copyFile(reportPath, copy);
      }
      const compliant = await registry.isCompliant(params.subjectChainId, params.subject);
      printLine(ctx, stage('attest', `id ${out.id}  ${counts(params)}  ${compliant ? pc.green('compliant') : pc.yellow('not compliant')}  ${pc.dim(`${net.name} ${net.clients.chain.id} registry ${registryAddress}`)}`));
      printLine(ctx, cont(pc.dim(`tx ${out.hash}  block ${out.blockNumber}  suiteHash ${params.suiteHash.slice(0, 18)}  reportHash ${params.reportHash.slice(0, 18)}  ${reportURI}`)));
      emitEvent(ctx, {
        type: 'check-attested',
        id: out.id.toString(),
        registry: registryAddress,
        chainId: net.clients.chain.id,
        txHash: out.hash,
        blockNumber: out.blockNumber.toString(),
        subjectChainId: report.chainId,
        subject: params.subject,
        subjectBlockNumber: report.blockNumber,
        implementationKey: params.implementationKey,
        subjectCodeHash: params.subjectCodeHash,
        suiteHash: params.suiteHash,
        reportHash: params.reportHash,
        passCount: params.passCount,
        failCount: params.failCount,
        inconclusiveCount: params.inconclusiveCount,
        notApplicableCount: params.notApplicableCount,
        passedBitmap: params.passedBitmap.toString(),
        failedBitmap: params.failedBitmap.toString(),
        reportURI,
        compliant,
      });
    });
  });

  cert
    .command('attestation <subjectChainId> <address>')
    .description('Read the latest attestation of a subject and whether it is compliant. Read only.')
    .option('--network <name>', 'network of the attestation registry', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL of that network')
    .option('--registry-attest <address>', 'CheckAttestationRegistry address (default: $SPECFIRST_ATTEST_REGISTRY_<chainId>)')
    .action(async (chainArg: string, subjectArg: string, opts: WriteOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'cert attestation', 1, async () => {
        if (!/^[1-9]\d*$/.test(chainArg)) throw new ConfigError(`<subjectChainId> must be a positive integer, got "${chainArg}"`);
        const subjectChainId = BigInt(chainArg);
        const subject = address(subjectArg, '<address>');
        const net = resolveNetwork(opts, process.env, { readOnly: true });
        const registryAddress = resolveAttestRegistry(net, opts);
        const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient);
        const latest = await registry.latest(subjectChainId, subject);
        if (!latest) {
          printLine(ctx, stage('attest', `no attestation for ${subject} on chain ${subjectChainId}  ${pc.dim(`registry ${registryAddress}`)}`));
          emitEvent(ctx, { type: 'attestation', found: false, subjectChainId: chainArg, subject, registry: registryAddress, compliant: false });
          return;
        }
        const a: Attestation = latest.attestation;
        const compliant = await registry.isCompliant(subjectChainId, subject);
        const status = ATTESTATION_STATUS[a.status] ?? String(a.status);
        printLine(ctx, stage('attest', `id ${latest.id}  ${status}  ${counts(a)}  ${compliant ? pc.green('compliant') : pc.yellow('not compliant')}`));
        printLine(ctx, cont(pc.dim(`subject ${subject} chain ${subjectChainId} block ${a.blockNumber}  codeHash ${a.subjectCodeHash.slice(0, 18)}  implementationKey ${a.implementationKey.slice(0, 18)}`)));
        printLine(ctx, cont(pc.dim(`suiteHash ${a.suiteHash}  reportHash ${a.reportHash}  issuer ${a.issuer}  ${a.reportURI}`)));
        emitEvent(ctx, {
          type: 'attestation',
          found: true,
          id: latest.id.toString(),
          ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
          status,
          statusCode: a.status,
          compliant,
          registry: registryAddress,
        });
      });
    });

  writeNetworkOptions(
    cert
      .command('revoke-attestation <id>')
      .description('Revoke an attestation; reasonHash = keccak256 of the evidence file.')
      .requiredOption('--evidence <file>', 'evidence of why the attestation is wrong (e.g. a newer report)'),
  ).action(async (idArg: string, opts: RevokeAttestationOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'cert revoke-attestation', CERT_FAILED_EXIT_CODE, async () => {
      if (!/^\d+$/.test(idArg)) throw new ConfigError(`<id> must be a non-negative integer, got "${idArg}"`);
      const evidencePath = path.resolve(ctx.projectDir, opts.evidence);
      if (!existsSync(evidencePath)) throw new ConfigError(`evidence file not found: ${opts.evidence}`);
      const evidence = await readFile(evidencePath);
      if (evidence.length === 0) throw new ConfigError('evidence file is empty');
      const net = resolveNetwork(opts);
      const issuerKey = resolveKey(net, ISSUER_KEY_ENV);
      const registryAddress = resolveAttestRegistry(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient, net.clients.wallet(issuerKey));
      const reasonHash = evidenceHash(evidence);
      let tx;
      try {
        tx = await registry.revoke(BigInt(idArg), reasonHash);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(CERT_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
        throw err;
      }
      printLine(ctx, stage('revoke', `attestation ${idArg}  ${pc.red('Revoked')}  ${pc.dim(`reasonHash ${reasonHash.slice(0, 18)}  tx ${tx.hash}`)}`));
      emitEvent(ctx, { type: 'attestation-revoked', id: idArg, registry: registryAddress, reasonHash, txHash: tx.hash, blockNumber: tx.blockNumber.toString() });
    });
  });
}

interface DeployRegistryOptions {
  network: string;
  rpc?: string;
  issuer?: string;
}

/**
 * `specfirst attest-registry deploy`: deploys CheckAttestationRegistry from the bundled creation code with
 * DEPLOYER_PRIVATE_KEY through the guarded wallet (no forge --broadcast), then allows the issuer.
 */
export function registerAttestRegistryCommand(program: Command): void {
  const group = program.command('attest-registry').description('CheckAttestationRegistry, where check reports are attested (ADR 0004).');
  group
    .command('deploy')
    .description('Deploy CheckAttestationRegistry and allow an issuer (default: the deployer).')
    .option('--network <name>', 'monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--issuer <address>', 'address allowed to attest (default: the deployer); cert attest signs with ISSUER_PRIVATE_KEY')
    .action(async (opts: DeployRegistryOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'attest-registry deploy', DEPLOY_FAILED_EXIT_CODE, async () => {
        const issuer = opts.issuer !== undefined ? address(opts.issuer, '--issuer') : undefined;
        const net = resolveNetwork(opts);
        const deployerKey = resolveKey(net, DEPLOYER_KEY_ENV);
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const wallet = net.clients.wallet(deployerKey);
        let out;
        try {
          out = await deployAttestationRegistry({ client: net.clients.publicClient, wallet, issuer });
        } catch (err) {
          throw new StageError(DEPLOY_FAILED_EXIT_CODE, `attest-registry deploy: ${(err as { shortMessage?: string }).shortMessage ?? (err as Error).message.split('\n')[0]}`);
        }
        const envName = attestRegistryEnvVar(net.clients.chain.id);
        printLine(ctx, stage('deploy', `CheckAttestationRegistry ${pc.bold(out.address)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
        printLine(ctx, cont(pc.dim(`owner ${wallet.account.address}  issuer ${out.issuer}  tx ${out.deployTx.hash}  block ${out.deployTx.blockNumber}`)));
        printLine(ctx, cont(`export ${envName}=${out.address}`));
        emitEvent(ctx, {
          type: 'attest-registry-deployed',
          address: out.address,
          chainId: net.clients.chain.id,
          owner: wallet.account.address,
          issuer: out.issuer,
          txHash: out.deployTx.hash,
          blockNumber: out.deployTx.blockNumber.toString(),
          issuerTxHash: out.issuerTx.hash,
          envName,
        });
      });
    });
}
