import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  ANVIL_CHAIN_ID,
  ATTESTATION_STATUS,
  AttestationError,
  AttestationRegistryClient,
  attestationParamsFromReport,
  attestationReportPath,
  badChecksum,
  CERT_FAILED_EXIT_CODE,
  checkAttestationRegistryCreationCodeHash,
  checkReportHash,
  DEPLOY_FAILED_EXIT_CODE,
  deployAttestationRegistry,
  evidenceHash,
  NETWORKS,
  parseCheckReport,
  RegistryError,
  rpcTransport,
  STANDARDS,
  standardIdOf,
  verifySubjectCode,
  type Attestation,
  type StandardName,
  type SubjectClient,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { createPublicClient, getAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contextFrom, emitEvent, printLine, type CliContext } from '../lib/context.js';
import {
  attestRegistryEnvVar,
  ConfigError,
  DEPLOYER_KEY_ENV,
  ISSUER_KEY_ENV,
  optionalKey,
  resolveAttestRegistry,
  resolveKey,
  resolveNetwork,
  subjectRpcFor,
} from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

/** Where our own report copies are published; the README names it as the --report-base-url to use. */
export const EXAMPLE_REPORT_BASE_URL = 'https://raw.githubusercontent.com/jaesimin0903/specfirst/main/certs/checks';

interface WriteOptions {
  network: string;
  rpc?: string;
  registryAttest?: string;
}

interface AttestOptions extends WriteOptions {
  subjectRpc?: string;
  reportBaseUrl?: string;
  allowUnknownProxy?: boolean;
}

interface ReadAttestationOptions extends WriteOptions {
  standard: string;
}

interface RevokeAttestationOptions extends WriteOptions {
  evidence: string;
  expectSubject?: string;
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

function errorLine(err: unknown): string {
  return (err as { shortMessage?: string }).shortMessage ?? ((err as Error).message ?? String(err)).split('\n')[0]!;
}

/** Prints a warning on stderr (both output modes) and keeps it for the command's event. */
function warn(name: string, warnings: string[], message: string): void {
  warnings.push(message);
  console.error(pc.yellow(`specfirst ${name}: warning: ${message}`));
}

/** The standard's name for a standardId the CLI knows, else the id itself. */
function standardName(standardId: Hex): string {
  return STANDARDS.find((s) => standardIdOf(s) === standardId.toLowerCase()) ?? standardId;
}

/** --report-base-url without trailing slashes; only http(s) URLs. */
function reportBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`--report-base-url must be an http(s) URL, got "${raw}"`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ConfigError(`--report-base-url must be an http(s) URL, got "${raw}"`);
  return raw.replace(/\/+$/, '');
}

/** `<chainId>:<address>` of --expect-subject. */
function expectedSubject(raw: string): { chainId: bigint; address: Address } {
  const m = /^([1-9]\d*):(0x[0-9a-fA-F]{40})$/.exec(raw);
  if (!m) throw new ConfigError(`--expect-subject must be <chainId>:<address>, e.g. 143:0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E, got "${raw}"`);
  return { chainId: BigInt(m[1]!), address: address(m[2]!, '--expect-subject address') };
}

/** Subject chain reads use their own client on one URL; no wallet exists for it. */
function subjectClient(chainId: number, url: string): SubjectClient {
  const chain = Object.values(NETWORKS).find((c) => c.id === chainId);
  return createPublicClient({ ...(chain ? { chain } : {}), transport: rpcTransport([url]) }) as unknown as SubjectClient;
}

/**
 * `cert attest`, `cert attestation`, `cert revoke-attestation` on CheckAttestationRegistry (ADR 0004).
 * Writes go through resolveNetwork without readOnly, so monad-mainnet is refused and every send is
 * preceded by the transport's eth_chainId check. Exit 0, or 14 on any attestation failure. Once a
 * transaction is mined, later failures (reading isCompliant) are warnings and the exit stays 0, so a
 * retry does not record the same report twice.
 */
export function registerAttestCommands(cert: Command): void {
  writeNetworkOptions(
    cert
      .command('attest <report>')
      .description('Record a `specfirst check` report in CheckAttestationRegistry after checking the subject identity on its own chain.')
      .option('--subject-rpc <url>', "read-only RPC of the report chain (default: that chain's env variable or public RPC)")
      .option(
        '--report-base-url <url>',
        `public URL of the certs/checks directory; reportURI = <url>/<chainId>/<address>/<block>-<hash8>.json. Required off anvil, e.g. ${EXAMPLE_REPORT_BASE_URL}`,
      )
      .option('--allow-unknown-proxy', 'attest a proxy-shaped subject whose implementation could not be resolved (identity.proxy.kind unknown)'),
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
      const onAnvil = net.clients.chain.id === ANVIL_CHAIN_ID;
      if (!onAnvil && report.chainId === ANVIL_CHAIN_ID) {
        throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to attest: the report is for chain ${ANVIL_CHAIN_ID}, a local anvil; its contracts mean nothing to readers of ${net.name}`);
      }
      if (!onAnvil && opts.reportBaseUrl === undefined) {
        throw new ConfigError(`--report-base-url is required on ${net.name}: reportURI must resolve for anyone, e.g. --report-base-url ${EXAMPLE_REPORT_BASE_URL}`);
      }
      const base = opts.reportBaseUrl !== undefined ? reportBase(opts.reportBaseUrl) : undefined;
      const issuerKey = resolveKey(net, ISSUER_KEY_ENV);
      const registryAddress = resolveAttestRegistry(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);

      const file = attestationReportPath(report, checkReportHash(report));
      const rel = `certs/checks/${file}`;
      const reportURI = base ? `${base}/${file}` : rel;
      let params;
      try {
        params = attestationParamsFromReport(report, { reportURI });
      } catch (err) {
        if (err instanceof AttestationError) throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to attest: ${err.message}`);
        throw err;
      }

      const subjectUrl = subjectRpcFor(report.chainId, opts.subjectRpc);
      let subject;
      try {
        subject = await verifySubjectCode(subjectClient(report.chainId, subjectUrl), report, { allowUnknownProxy: opts.allowUnknownProxy });
      } catch (err) {
        if (err instanceof AttestationError) throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to attest: ${err.message}`);
        throw err;
      }
      const proxyKind = subject.identity.proxy?.kind ?? null;
      printLine(
        ctx,
        stage(
          'subject',
          `${report.address}  chain ${report.chainId}  block ${report.blockNumber}  ${pc.dim(`identity matches the report (codeHash ${subject.codeHash.slice(0, 18)}, implementationKey ${params.implementationKey.slice(0, 18)}, proxy ${proxyKind ?? 'none'})`)}`,
        ),
      );
      if (subject.unknownProxy) {
        printLine(ctx, cont(pc.yellow('! proxy implementation not resolved (kind unknown): implementationKey is the proxy code; attested with --allow-unknown-proxy')));
      }

      // The copy is written before the transaction: if it cannot be, nothing is sent and a retry is safe.
      const copy = path.join(ctx.projectDir, rel);
      if (path.resolve(copy) !== reportPath) {
        try {
          await mkdir(path.dirname(copy), { recursive: true });
          await copyFile(reportPath, copy);
        } catch (err) {
          throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to attest: cannot copy the report to ${rel} (${errorLine(err)}); nothing was sent`);
        }
      }

      const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient, net.clients.wallet(issuerKey));
      let out;
      try {
        out = await registry.attest(params);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(CERT_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
        throw err;
      }

      // Mined: from here on nothing may turn into a failure exit.
      const warnings: string[] = [];
      let compliant: boolean | null = null;
      try {
        compliant = await registry.isCompliant(params.subjectChainId, params.subject, params.standardId);
      } catch (err) {
        warn('cert attest', warnings, `attestation ${out.id} is recorded (tx ${out.hash}), but reading isCompliant failed: ${errorLine(err)}`);
      }
      const verdict = compliant === null ? pc.dim('compliance not read') : compliant ? pc.green('compliant') : pc.yellow('not compliant');
      printLine(ctx, stage('attest', `id ${out.id}  ${report.standard}  ${counts(params)}  ${verdict}  ${pc.dim(`${net.name} ${net.clients.chain.id} registry ${registryAddress}`)}`));
      printLine(ctx, cont(pc.dim(`tx ${out.hash}  block ${out.blockNumber}  suiteHash ${params.suiteHash.slice(0, 18)}  reportHash ${params.reportHash.slice(0, 18)}`)));
      printLine(ctx, cont(pc.dim(`copy ${rel}  reportURI ${reportURI}`)));
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
        standard: report.standard,
        standardId: params.standardId,
        implementationKey: params.implementationKey,
        subjectCodeHash: params.subjectCodeHash,
        proxyKind,
        unknownProxyAllowed: subject.unknownProxy,
        suiteHash: params.suiteHash,
        reportHash: params.reportHash,
        passCount: params.passCount,
        failCount: params.failCount,
        inconclusiveCount: params.inconclusiveCount,
        notApplicableCount: params.notApplicableCount,
        passedBitmap: params.passedBitmap.toString(),
        failedBitmap: params.failedBitmap.toString(),
        reportURI,
        reportCopy: rel,
        compliant,
        warnings,
      });
    });
  });

  cert
    .command('attestation <subjectChainId> <address>')
    .description('Read the latest attestation of a subject for one standard and whether it is compliant. Read only.')
    .option('--standard <name>', `standard of the attestation (${STANDARDS.join(', ')})`, 'erc4626')
    .option('--network <name>', 'network of the attestation registry', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL of that network')
    .option('--registry-attest <address>', 'CheckAttestationRegistry address (default: $SPECFIRST_ATTEST_REGISTRY_<chainId>)')
    .action(async (chainArg: string, subjectArg: string, opts: ReadAttestationOptions, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'cert attestation', 1, async () => {
        if (!/^[1-9]\d*$/.test(chainArg)) throw new ConfigError(`<subjectChainId> must be a positive integer, got "${chainArg}"`);
        if (!(STANDARDS as readonly string[]).includes(opts.standard)) throw new ConfigError(`--standard must be one of ${STANDARDS.join(', ')}, got "${opts.standard}"`);
        const standard = opts.standard as StandardName;
        const standardId = standardIdOf(standard);
        const subjectChainId = BigInt(chainArg);
        const subject = address(subjectArg, '<address>');
        const net = resolveNetwork(opts, process.env, { readOnly: true });
        const registryAddress = resolveAttestRegistry(net, opts);
        const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient);
        const latest = await registry.latest(subjectChainId, subject, standardId);
        if (!latest) {
          printLine(ctx, stage('attest', `no ${standard} attestation for ${subject} on chain ${subjectChainId}  ${pc.dim(`registry ${registryAddress}`)}`));
          emitEvent(ctx, { type: 'attestation', found: false, subjectChainId: chainArg, subject, standard, standardId, registry: registryAddress, compliant: false });
          return;
        }
        const a: Attestation = latest.attestation;
        const compliant = await registry.isCompliant(subjectChainId, subject, standardId);
        const status = ATTESTATION_STATUS[a.status] ?? String(a.status);
        printLine(ctx, stage('attest', `id ${latest.id}  ${standard}  ${status}  ${counts(a)}  ${compliant ? pc.green('compliant') : pc.yellow('not compliant')}`));
        printLine(ctx, cont(pc.dim(`subject ${subject} chain ${subjectChainId} block ${a.blockNumber}  codeHash ${a.subjectCodeHash.slice(0, 18)}  implementationKey ${a.implementationKey.slice(0, 18)}`)));
        printLine(ctx, cont(pc.dim(`suiteHash ${a.suiteHash}  reportHash ${a.reportHash}  issuer ${a.issuer}  ${a.reportURI}`)));
        emitEvent(ctx, {
          type: 'attestation',
          found: true,
          id: latest.id.toString(),
          ...Object.fromEntries(Object.entries(a).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])),
          standard,
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
      .description('Revoke an attestation; reasonHash = keccak256 of the evidence file. Shows the subject before sending.')
      .requiredOption('--evidence <file>', 'evidence of why the attestation is wrong (e.g. a newer report)')
      .option('--expect-subject <chainId:address>', 'refuse unless attestation <id> is about this subject, e.g. 143:0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E; required off anvil'),
  ).action(async (idArg: string, opts: RevokeAttestationOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'cert revoke-attestation', CERT_FAILED_EXIT_CODE, async () => {
      if (!/^\d+$/.test(idArg)) throw new ConfigError(`<id> must be a non-negative integer, got "${idArg}"`);
      const id = BigInt(idArg);
      const evidencePath = path.resolve(ctx.projectDir, opts.evidence);
      if (!existsSync(evidencePath)) throw new ConfigError(`evidence file not found: ${opts.evidence}`);
      const evidence = await readFile(evidencePath);
      if (evidence.length === 0) throw new ConfigError('evidence file is empty');
      const net = resolveNetwork(opts);
      const expected = opts.expectSubject !== undefined ? expectedSubject(opts.expectSubject) : undefined;
      if (!expected && net.clients.chain.id !== ANVIL_CHAIN_ID) {
        throw new ConfigError(`--expect-subject <chainId>:<address> is required on ${net.name}, so a mistyped id cannot revoke another subject's attestation`);
      }
      const issuerKey = resolveKey(net, ISSUER_KEY_ENV);
      const registryAddress = resolveAttestRegistry(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient, net.clients.wallet(issuerKey));

      let a: Attestation;
      try {
        a = await registry.attestationOf(id);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(CERT_FAILED_EXIT_CODE, `refusing to revoke: ${err.message.split('\n')[0]}`);
        throw err;
      }
      const status = ATTESTATION_STATUS[a.status] ?? String(a.status);
      printLine(
        ctx,
        stage('revoke', `attestation ${idArg}  subject ${a.subjectChainId}:${a.subject}  ${standardName(a.standardId)}  block ${a.blockNumber}  ${status}  ${pc.dim(`issuer ${a.issuer}`)}`),
      );
      if (expected && (a.subjectChainId !== expected.chainId || a.subject.toLowerCase() !== expected.address.toLowerCase())) {
        throw new StageError(
          CERT_FAILED_EXIT_CODE,
          `refusing to revoke: attestation ${idArg} is about ${a.subjectChainId}:${a.subject}, --expect-subject says ${expected.chainId}:${expected.address}; nothing was sent`,
        );
      }
      const reasonHash = evidenceHash(evidence);
      let tx;
      try {
        tx = await registry.revoke(id, reasonHash);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(CERT_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
        throw err;
      }
      printLine(ctx, cont(`${pc.red('Revoked')}  ${pc.dim(`reasonHash ${reasonHash.slice(0, 18)}  tx ${tx.hash}`)}`));
      emitEvent(ctx, {
        type: 'attestation-revoked',
        id: idArg,
        registry: registryAddress,
        subjectChainId: a.subjectChainId.toString(),
        subject: a.subject,
        standardId: a.standardId,
        previousStatus: status,
        reasonHash,
        txHash: tx.hash,
        blockNumber: tx.blockNumber.toString(),
      });
    });
  });
}

interface DeployRegistryOptions {
  network: string;
  rpc?: string;
  issuer?: string;
}

interface SetIssuerOptions extends WriteOptions {
  remove?: boolean;
}

function emitIssuerSet(ctx: CliContext, registry: Address, issuer: Address, allowed: boolean, tx: { hash: Hex; blockNumber: bigint }): void {
  printLine(ctx, stage('issuer', `${issuer}  ${allowed ? pc.green('allowed') : pc.yellow('removed')}  ${pc.dim(`registry ${registry}  tx ${tx.hash}`)}`));
  emitEvent(ctx, { type: 'attest-registry-issuer-set', registry, issuer, allowed, txHash: tx.hash, blockNumber: tx.blockNumber.toString() });
}

/**
 * `specfirst attest-registry deploy`: deploys CheckAttestationRegistry from the bundled creation code with
 * DEPLOYER_PRIVATE_KEY through the guarded wallet (no forge --broadcast), then allows the issuer: --issuer,
 * else the address of ISSUER_PRIVATE_KEY, else the deployer. The address is printed and emitted as soon as
 * the deploy is mined, before setIssuer. `attest-registry set-issuer` adds or removes issuers later.
 */
export function registerAttestRegistryCommand(program: Command): void {
  const group = program.command('attest-registry').description('CheckAttestationRegistry, where check reports are attested (ADR 0004).');
  group
    .command('deploy')
    .description('Deploy CheckAttestationRegistry and allow an issuer (default: the address of ISSUER_PRIVATE_KEY, else the deployer).')
    .option('--network <name>', 'monad-testnet or anvil (monad-mainnet is refused)', 'monad-testnet')
    .option('--rpc <url>', 'RPC URL (default: $MONAD_TESTNET_RPC or $ANVIL_RPC)')
    .option('--issuer <address>', 'address allowed to attest (default: the address of ISSUER_PRIVATE_KEY, which cert attest signs with, else the deployer)')
    .action(async (opts: DeployRegistryOptions, command: Command) => {
      const ctx = contextFrom(command);
      const name = 'attest-registry deploy';
      await runStage(ctx, name, DEPLOY_FAILED_EXIT_CODE, async () => {
        const explicit = opts.issuer !== undefined ? address(opts.issuer, '--issuer') : undefined;
        const net = resolveNetwork(opts);
        const deployerKey = resolveKey(net, DEPLOYER_KEY_ENV);
        const issuerKey = optionalKey(ISSUER_KEY_ENV);
        const issuerKeyAddress = issuerKey ? privateKeyToAccount(issuerKey).address : undefined;
        const warnings: string[] = [];
        if (explicit && issuerKeyAddress && explicit !== issuerKeyAddress) {
          warn(name, warnings, `--issuer ${explicit} is not the address of ${ISSUER_KEY_ENV} (${issuerKeyAddress}); cert attest signs with ${ISSUER_KEY_ENV} and gets NotIssuer until that address is allowed`);
        }
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const wallet = net.clients.wallet(deployerKey);
        const issuer = explicit ?? issuerKeyAddress ?? wallet.account.address;
        const envName = attestRegistryEnvVar(net.clients.chain.id);
        let deployed: { address: Address; deployTx: { hash: Hex } } | undefined;
        let out;
        try {
          out = await deployAttestationRegistry({
            client: net.clients.publicClient,
            wallet,
            issuer,
            onDeployed: (d) => {
              deployed = d;
              printLine(ctx, stage('deploy', `CheckAttestationRegistry ${pc.bold(d.address)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
              printLine(ctx, cont(pc.dim(`owner ${wallet.account.address}  tx ${d.deployTx.hash}  block ${d.deployTx.blockNumber}  creation code keccak ${checkAttestationRegistryCreationCodeHash}`)));
              printLine(ctx, cont(`export ${envName}=${d.address}`));
              emitEvent(ctx, {
                type: 'attest-registry-deployed',
                address: d.address,
                chainId: net.clients.chain.id,
                owner: wallet.account.address,
                txHash: d.deployTx.hash,
                blockNumber: d.deployTx.blockNumber.toString(),
                creationCodeKeccak: checkAttestationRegistryCreationCodeHash,
                envName,
                warnings,
              });
            },
          });
        } catch (err) {
          if (deployed) {
            throw new StageError(
              DEPLOY_FAILED_EXIT_CODE,
              `${name}: CheckAttestationRegistry is deployed at ${deployed.address} (tx ${deployed.deployTx.hash}), but setIssuer(${issuer}) failed: ${errorLine(err)}; retry with \`specfirst attest-registry set-issuer ${issuer} --registry-attest ${deployed.address}\``,
            );
          }
          throw new StageError(DEPLOY_FAILED_EXIT_CODE, `${name}: ${errorLine(err)}`);
        }
        emitIssuerSet(ctx, out.address, out.issuer, true, out.issuerTx);
      });
    });

  writeNetworkOptions(
    group
      .command('set-issuer <address>')
      .description('Allow an issuer, or remove it with --remove. Signs with DEPLOYER_PRIVATE_KEY (the owner). Past attestations stay as they are.')
      .option('--remove', 'disallow the issuer instead of allowing it'),
  ).action(async (issuerArg: string, opts: SetIssuerOptions, command: Command) => {
    const ctx = contextFrom(command);
    await runStage(ctx, 'attest-registry set-issuer', DEPLOY_FAILED_EXIT_CODE, async () => {
      const issuer = address(issuerArg, '<address>');
      const net = resolveNetwork(opts);
      const ownerKey = resolveKey(net, DEPLOYER_KEY_ENV);
      const registryAddress = resolveAttestRegistry(net, opts);
      for (const n of net.notices) printLine(ctx, `         ! ${n}`);
      const registry = new AttestationRegistryClient(registryAddress, net.clients.publicClient, net.clients.wallet(ownerKey));
      const allowed = !opts.remove;
      let tx;
      try {
        tx = await registry.setIssuer(issuer, allowed);
      } catch (err) {
        if (err instanceof RegistryError) throw new StageError(DEPLOY_FAILED_EXIT_CODE, err.message.split('\n')[0]!);
        throw err;
      }
      emitIssuerSet(ctx, registryAddress, issuer, allowed, tx);
    });
  });
}
