import {
  AllocationGateClient,
  allocationGateCreationCodeHash,
  ATTESTATION_STATUS,
  AttestationRegistryClient,
  badChecksum,
  DEFAULT_GATE_MAX_AGE_SEC,
  DEFAULT_GATE_SLIPPAGE_BPS,
  DEFAULT_GATE_VAULT_CALL_GAS,
  DEFAULT_GATE_VAULT_VIEW_GAS,
  deployAllocationGate,
  errorText,
  GateKeeper,
  GATE_FRESH_ATTESTATION_HINT,
  GATE_VERDICT_TEXT,
  exitAllowed,
  GateError,
  mintDemoToken,
  standardIdOf,
  WATCH_FAILED_EXIT_CODE,
  type GateExitOutcome,
  type GateVaultState,
  type GateVerdict,
} from '@specfirst/core';
import type { Command } from 'commander';
import pc from 'picocolors';
import { formatEther, getAddress, parseEther, type Address, type Hex } from 'viem';
import { contextFrom, emitEvent, printLine, type CliContext } from '../lib/context.js';
import { ConfigError, DEPLOYER_KEY_ENV, REQUESTER_KEY_ENV, resolveAttestRegistry, resolveKey, resolveNetwork, type ResolvedNetwork } from '../lib/network.js';
import { StageError } from '../lib/pipeline.js';
import { cont, stage } from '../lib/runLog.js';
import { runStage } from '../lib/stageRunner.js';

/** AllocationGate address for the chain the gate lives on (docs/adr/0007). */
export function gateEnvVar(chainId: number): string {
  return `SPECFIRST_GATE_${chainId}`;
}

/** The keeper's own key: exit is open to anyone, so `keep` needs no owner key (default REQUESTER_PRIVATE_KEY when unset). */
export const KEEPER_KEY_ENV = 'KEEPER_PRIVATE_KEY';

/** The web reads the testnet gate from this variable. */
export const WEB_GATE_ENV = 'NEXT_PUBLIC_SPECFIRST_GATE_10143';

const STANDARD = 'erc4626';
const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;

/** allocate's refusals, by error name, as the verdict they stand for. */
const REFUSALS: Readonly<Record<string, GateVerdict>> = {
  NoAttestation: 'NoAttestation',
  NotCompliant: 'NotCompliant',
  UntrustedIssuer: 'UntrustedIssuer',
  CodeMismatch: 'CodeMismatch',
  FutureBlock: 'FutureBlock',
  OtherSuite: 'OtherSuite',
  StaleAttestation: 'Stale',
};

function refusalText(v: GateVerdict): string {
  return `allocation refused (${v}): ${GATE_VERDICT_TEXT[v]}${v === 'Stale' ? `; ${GATE_FRESH_ATTESTATION_HINT}` : ''}`;
}

interface GateGlobals {
  network: string;
  rpc?: string;
  registryAttest?: string;
  gate?: string;
}

function address(raw: string, what: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw) || badChecksum(raw)) throw new ConfigError(`${what} must be a 0x address with a valid checksum, got "${raw}"`);
  return getAddress(raw);
}

function tokens(raw: string, what: string): bigint {
  if (!/^\d+(\.\d{1,18})?$/.test(raw)) throw new ConfigError(`${what} must be a decimal number of tokens (18 decimals), got "${raw}"`);
  return parseEther(raw);
}

function globals(command: Command): GateGlobals {
  return command.optsWithGlobals() as GateGlobals;
}

function network(command: Command): ResolvedNetwork {
  const all = globals(command);
  return resolveNetwork({ network: all.network, ...(all.rpc ? { rpc: all.rpc } : {}) });
}

function gateAddress(net: ResolvedNetwork, command: Command, env: NodeJS.ProcessEnv = process.env): Address {
  const envName = gateEnvVar(net.clients.chain.id);
  const v = globals(command).gate ?? env[envName];
  if (!v) throw new ConfigError(`no AllocationGate address: set ${envName} or pass --gate <address>`);
  return address(v, '--gate');
}

function failed(err: unknown): never {
  if (err instanceof ConfigError || err instanceof StageError) throw err;
  throw new StageError(WATCH_FAILED_EXIT_CODE, errorText(err));
}

function ago(issuedAt: bigint, now: bigint): string {
  const s = Number(now - issuedAt);
  if (s < 120) return `${s} s ago`;
  if (s < 7200) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

function verdictText(v: GateVerdict): string {
  return v === 'Compliant' ? pc.green(v) : v === 'Stale' ? pc.yellow(v) : pc.red(v);
}

function outcomeEvent(chainId: number, gate: Address, o: GateExitOutcome): Record<string, unknown> {
  const base = { type: 'watch-demo-gate-exit', chainId, gate, vault: o.vault, exited: o.exited, verdict: o.verdict, attestationId: o.attestationId, shares: o.shares, txHash: o.hash, blockNumber: o.blockNumber, gasCostWei: o.gasCostWei };
  return o.exited ? { ...base, path: o.path, assets: o.assets } : { ...base, redeemError: o.redeemError, withdrawError: o.withdrawError };
}

function printOutcome(ctx: CliContext, o: GateExitOutcome): void {
  if (o.exited) {
    printLine(ctx, stage('gate', `exited ${pc.bold(o.vault)} by ${o.path.toLowerCase()}: ${formatEther(o.assets)} back for ${formatEther(o.shares)} shares  ${pc.dim(`${o.verdict}, attestation ${o.attestationId}, block ${o.blockNumber}, tx ${o.hash}`)}`));
  } else {
    printLine(ctx, stage('gate', `${pc.red('vault moved nothing')} ${pc.bold(o.vault)}: redeem ${o.redeemError}, withdraw ${o.withdrawError}; ExitFailed recorded, the position stays  ${pc.dim(`tx ${o.hash}`)}`));
  }
}

/**
 * `specfirst watch demo gate deploy|allocate|exit|keep|resync|status`: the allocation gate of docs/adr/0007 on
 * monad-testnet or anvil. Writes are signed with DEPLOYER_PRIVATE_KEY through the guarded wallet (monad-mainnet is
 * refused before a key is read); the deployer is the gate's owner. --network, --rpc and --registry-attest are the
 * ones of `watch`.
 */
export function registerWatchDemoGate(demo: Command): void {
  const gate = demo
    .command('gate')
    .description(`Allocation gate (ADR 0007): moves money only into vaults the attestation registry calls compliant, and lets anyone pull it out once they are not. Signed with ${DEPLOYER_KEY_ENV}.`)
    .option('--gate <address>', 'AllocationGate (default: $SPECFIRST_GATE_<chainId>)');

  gate
    .command('deploy')
    .description('Deploy an AllocationGate over --asset that reads the attestation registry of --network; the signer becomes its owner. --fund mints DemoToken to it.')
    .requiredOption('--asset <address>', 'the DemoToken the gate holds (from `watch demo deploy --token`)')
    .option('--max-age <sec>', 'seconds after it was issued that a compliant attestation still lets the owner allocate', DEFAULT_GATE_MAX_AGE_SEC.toString())
    .option('--fund <tokens>', 'DemoToken to mint to the gate after the deploy (0: none)', '100')
    .option('--suite-hash <bytes32>', "accept only attestations of this suite (the registry's suiteHash); default: any suite")
    .option('--vault-call-gas <gas>', 'gas each redeem or withdraw of an exit gets (Monad prices cold accounts at 10,100)', DEFAULT_GATE_VAULT_CALL_GAS.toString())
    .option('--vault-view-gas <gas>', 'gas each maxWithdraw or balanceOf of an exit gets', DEFAULT_GATE_VAULT_VIEW_GAS.toString())
    .action(async (opts: { asset: string; maxAge: string; fund: string; suiteHash?: string; vaultCallGas: string; vaultViewGas: string }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo gate deploy', WATCH_FAILED_EXIT_CODE, async () => {
        const asset = address(opts.asset, '--asset');
        if (!/^[1-9]\d*$/.test(opts.maxAge) || BigInt(opts.maxAge) >= 2n ** 64n) throw new ConfigError(`--max-age must be a positive number of seconds below 2^64, got "${opts.maxAge}"`);
        const fund = tokens(opts.fund, '--fund');
        if (opts.suiteHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(opts.suiteHash)) throw new ConfigError(`--suite-hash must be a 0x bytes32, got "${opts.suiteHash}"`);
        const suiteHash = (opts.suiteHash?.toLowerCase() ?? ZERO_HASH) as Hex;
        for (const [flag, v] of [['--vault-call-gas', opts.vaultCallGas], ['--vault-view-gas', opts.vaultViewGas]] as const) {
          if (!/^[1-9]\d{0,8}$/.test(v)) throw new ConfigError(`${flag} must be a positive amount of gas, got "${v}"`);
        }
        const net = network(command);
        const registry = resolveAttestRegistry(net, { ...(globals(command).registryAttest ? { registryAttest: globals(command).registryAttest! } : {}) });
        const wallet = net.clients.wallet(resolveKey(net, DEPLOYER_KEY_ENV));
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const client = net.clients.publicClient;
        const chainId = net.clients.chain.id;
        try {
          const out = await deployAllocationGate({
            client,
            wallet,
            registry,
            subjectChainId: BigInt(chainId),
            standardId: standardIdOf(STANDARD),
            suiteHash,
            asset,
            owner: wallet.account.address,
            maxAttestationAge: BigInt(opts.maxAge),
            vaultCallGas: BigInt(opts.vaultCallGas),
            vaultViewGas: BigInt(opts.vaultViewGas),
          });
          printLine(ctx, stage('gate', `AllocationGate ${pc.bold(out.address)}  ${pc.dim(`${net.name} ${chainId}, tx ${out.tx.hash}`)}`));
          printLine(ctx, cont(`registry ${registry}, asset ${asset}, owner ${wallet.account.address}, ${STANDARD}, ${suiteHash === ZERO_HASH ? 'any suite' : `suite ${suiteHash}`}, attestations fresh for ${opts.maxAge} s`));
          printLine(ctx, cont(pc.dim(`fresh means issued in the last ${opts.maxAge} s: ${GATE_FRESH_ATTESTATION_HINT}`)));
          printLine(ctx, cont(pc.dim(`exit gives each vault call ${opts.vaultCallGas} gas and each read ${opts.vaultViewGas}`)));
          printLine(ctx, cont(`export ${gateEnvVar(chainId)}=${out.address}${chainId === 10143 ? `  (the web reads ${WEB_GATE_ENV})` : ''}`));
          emitEvent(ctx, {
            type: 'watch-demo-gate-deployed',
            chainId,
            gate: out.address,
            registry,
            asset,
            owner: wallet.account.address,
            standard: STANDARD,
            standardId: standardIdOf(STANDARD),
            suiteHash,
            maxAttestationAge: opts.maxAge,
            vaultCallGas: opts.vaultCallGas,
            vaultViewGas: opts.vaultViewGas,
            creationCodeKeccak: allocationGateCreationCodeHash,
            txHash: out.tx.hash,
            blockNumber: out.tx.blockNumber,
            envName: gateEnvVar(chainId),
          });
          if (fund > 0n) {
            const tx = await mintDemoToken({ client, wallet, token: asset, to: out.address, amount: fund });
            printLine(ctx, cont(`funded with ${opts.fund} DemoToken  ${pc.dim(`tx ${tx.hash}`)}`));
            emitEvent(ctx, { type: 'watch-demo-gate-funded', chainId, gate: out.address, asset, amount: fund, txHash: tx.hash });
          }
        } catch (err) {
          failed(err);
        }
      });
    });

  gate
    .command('allocate <vault> <amount>')
    .description("Owner: deposit <amount> tokens of the gate's idle asset into <vault>. Refused unless the vault's latest attestation is compliant, fresh, from a current issuer, about its code and of a block that exists.")
    .option('--min-shares <shares>', `fewest vault shares (18 decimals) the deposit must mint; default: the vault's previewDeposit less ${DEFAULT_GATE_SLIPPAGE_BPS} bps`)
    .action(async (vaultArg: string, amountArg: string, opts: { minShares?: string }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo gate allocate', WATCH_FAILED_EXIT_CODE, async () => {
        const vault = address(vaultArg, '<vault>');
        const amount = tokens(amountArg, '<amount>');
        if (amount === 0n) throw new ConfigError('<amount> must be above 0');
        const explicitMin = opts.minShares !== undefined ? tokens(opts.minShares, '--min-shares') : null;
        const net = network(command);
        const at = gateAddress(net, command);
        const wallet = net.clients.wallet(resolveKey(net, DEPLOYER_KEY_ENV));
        const g = new AllocationGateClient(at, net.clients.publicClient, wallet);
        try {
          const minShares = explicitMin ?? (await g.minSharesFor(vault, amount));
          const out = await g.allocate(vault, amount, minShares);
          printLine(ctx, stage('gate', `allocated ${formatEther(out.assets)} into ${pc.bold(vault)} for ${formatEther(out.shares)} shares  ${pc.dim(`attestation ${out.attestationId}, block ${out.blockNumber}, tx ${out.hash}`)}`));
          emitEvent(ctx, { type: 'watch-demo-gate-allocated', chainId: net.clients.chain.id, gate: at, vault, attestationId: out.attestationId, assets: out.assets, shares: out.shares, minShares, txHash: out.hash, blockNumber: out.blockNumber, gasCostWei: out.gasCostWei });
        } catch (err) {
          const verdict = err instanceof GateError && err.errorName ? REFUSALS[err.errorName] : undefined;
          if (verdict) {
            emitEvent(ctx, { type: 'watch-demo-gate-refused', chainId: net.clients.chain.id, gate: at, vault, verdict, error: err instanceof GateError ? err.errorName : undefined });
            throw new StageError(WATCH_FAILED_EXIT_CODE, refusalText(verdict));
          }
          if (err instanceof GateError && err.errorName === 'TooFewShares') {
            emitEvent(ctx, { type: 'watch-demo-gate-refused', chainId: net.clients.chain.id, gate: at, vault, verdict: null, error: 'TooFewShares' });
            throw new StageError(WATCH_FAILED_EXIT_CODE, 'allocation refused (TooFewShares): the deposit would mint fewer shares than --min-shares; the share price moved, or the vault quotes more than it mints');
          }
          failed(err);
        }
      });
    });

  gate
    .command('exit <vault>')
    .description("Pull the gate's shares out of <vault>: anyone once its verdict is neither Compliant nor Stale, the owner on any verdict with --as-owner. Signs with the deployer key.")
    .option('--as-owner', "as the gate's owner, exit even a Compliant or Stale vault")
    .action(async (vaultArg: string, opts: { asOwner?: boolean }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo gate exit', WATCH_FAILED_EXIT_CODE, async () => {
        const vault = address(vaultArg, '<vault>');
        const net = network(command);
        const at = gateAddress(net, command);
        const wallet = net.clients.wallet(resolveKey(net, DEPLOYER_KEY_ENV));
        const g = new AllocationGateClient(at, net.clients.publicClient, wallet);
        // The owner's exit is open on any verdict; ask for that on purpose rather than drain a healthy vault by habit.
        // When the verdict or the owner cannot be read, refuse rather than guess.
        if (!opts.asOwner) {
          const [now, owner] = await Promise.all([g.verdict(vault).then((v) => v.verdict, () => null), g.summary().then((x) => x.owner, () => null)]);
          if (owner === null) throw new StageError(WATCH_FAILED_EXIT_CODE, `exit refused: could not read the gate's owner at ${at}; try again, or pass --as-owner`);
          const signerIsOwner = owner.toLowerCase() === wallet.account.address.toLowerCase();
          if (signerIsOwner && now === null) throw new StageError(WATCH_FAILED_EXIT_CODE, `exit refused: could not read the vault's verdict; you are the gate's owner and may exit it anyway with --as-owner`);
          if (signerIsOwner && now !== null && !exitAllowed(now)) {
            throw new StageError(WATCH_FAILED_EXIT_CODE, `exit refused: the vault is ${now}; you are the gate's owner and may exit it anyway with --as-owner`);
          }
        }
        let out: GateExitOutcome;
        try {
          out = await g.exit(vault);
        } catch (err) {
          if (err instanceof GateError && err.errorName === 'StillCompliant') {
            const { verdict } = await g.verdict(vault);
            throw new StageError(WATCH_FAILED_EXIT_CODE, `exit refused: the vault is ${verdict}, ${GATE_VERDICT_TEXT[verdict]}; only the gate's owner may exit it now`);
          }
          if (err instanceof GateError && err.errorName === 'NothingToExit') throw new StageError(WATCH_FAILED_EXIT_CODE, `exit refused: the gate holds no shares of ${vault}`);
          failed(err);
        }
        printOutcome(ctx, out);
        emitEvent(ctx, outcomeEvent(net.clients.chain.id, at, out));
        if (!out.exited) throw new StageError(WATCH_FAILED_EXIT_CODE, `the vault moved nothing on redeem or withdraw (ExitFailed in tx ${out.hash}); the shares stay in the gate's books`);
      });
    });

  gate
    .command('keep')
    .description(`Keeper: every pass, exit each vault of the gate whose exit is open to anyone. Signs with its own key (--key-env, default ${KEEPER_KEY_ENV}, else ${REQUESTER_KEY_ENV}), never needs the owner's. Runs until stopped, a pass every --poll seconds; --once runs one pass (both are options of \`watch\`).`)
    .option('--key-env <NAME>', `environment variable holding the keeper's key (default ${KEEPER_KEY_ENV} when set, else ${REQUESTER_KEY_ENV})`)
    .action(async (keepOpts: { keyEnv?: string }, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo gate keep', WATCH_FAILED_EXIT_CODE, async () => {
        // `watch` defines --once and --poll, and commander gives a parent's option to the parent wherever it appears.
        const opts = command.optsWithGlobals() as { once?: boolean; poll: string };
        if (!/^[1-9]\d*$/.test(opts.poll)) throw new ConfigError(`--poll must be a positive number of seconds, got "${opts.poll}"`);
        const net = network(command);
        const at = gateAddress(net, command);
        const keyEnv = keepOpts.keyEnv ?? (process.env[KEEPER_KEY_ENV] ? KEEPER_KEY_ENV : REQUESTER_KEY_ENV);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(keyEnv)) throw new ConfigError(`--key-env must name an environment variable (A-Z, 0-9, _), got "${keyEnv}"`);
        const wallet = net.clients.wallet(resolveKey(net, keyEnv));
        for (const n of net.notices) printLine(ctx, `         ! ${n}`);
        const g = new AllocationGateClient(at, net.clients.publicClient, wallet);
        const chainId = net.clients.chain.id;
        printLine(ctx, stage('gate', `keeping ${pc.bold(at)} on ${net.name} ${chainId} as ${wallet.account.address} (${keyEnv})${opts.once ? '' : `, every ${opts.poll} s`}`));
        emitEvent(ctx, { type: 'watch-demo-gate-keep-start', chainId, gate: at, keeper: wallet.account.address, keyEnv });
        const keeper = new GateKeeper(g);
        for (;;) {
          let sendFailures = 0;
          try {
            const results = await keeper.pass();
            for (const r of results) {
              if (r.kind === 'exited') {
                printOutcome(ctx, r.outcome);
                emitEvent(ctx, outcomeEvent(chainId, at, r.outcome));
              } else if (r.kind === 'backoff') {
                // Logged once per step: the vault is left alone until `until`.
                if (r.outcome) emitEvent(ctx, outcomeEvent(chainId, at, r.outcome));
                const why = r.error
                  ? `exit tx ${r.error.txHash} failed on chain (${r.error.errorName ?? r.error.message})`
                  : !r.outcome
                    ? 'its exit would move nothing, not sent'
                    : r.outcome.exited
                      ? `its exit took back only dust (${formatEther(r.outcome.shares)} shares)`
                      : 'its exit moved nothing (ExitFailed)';
                printLine(ctx, stage('gate', `${pc.yellow('backing off')} ${pc.bold(r.vault)}: ${why}; next try in ${Math.round(r.delayMs / 60_000)} min`));
                emitEvent(ctx, { type: 'watch-demo-gate-backoff', chainId, gate: at, vault: r.vault, verdict: r.verdict, delaySec: r.delayMs / 1000, until: new Date(r.until).toISOString(), mined: Boolean(r.outcome || r.error), reason: why });
              } else if (r.kind === 'error') {
                sendFailures++;
                printLine(ctx, stage('gate', `${pc.red('exit not sent')} ${pc.bold(r.vault)}: ${r.error.message}`));
                emitEvent(ctx, { type: 'watch-demo-gate-exit-error', chainId, gate: at, vault: r.vault, error: r.error.errorName ?? null, message: r.error.message });
              }
            }
            const count = (k: string) => results.filter((r) => r.kind === k).length;
            const due = count('exited') + count('backoff') + count('error');
            emitEvent(ctx, { type: 'watch-demo-gate-pass', chainId, gate: at, vaults: results.length, due, exited: count('exited'), waiting: count('waiting') });
            if (!ctx.json && due === 0) printLine(ctx, cont(pc.dim(`${new Date().toISOString()}  ${results.length} vaults, none to exit${count('waiting') ? `, ${count('waiting')} backing off` : ''}`)));
          } catch (err) {
            if (opts.once) failed(err);
            printLine(ctx, stage('gate', `${pc.red('pass failed')}: ${errorText(err)}`));
            emitEvent(ctx, { type: 'watch-demo-gate-pass-error', chainId, gate: at, message: errorText(err) });
          }
          if (opts.once) {
            if (sendFailures > 0) throw new StageError(WATCH_FAILED_EXIT_CODE, `${sendFailures} exit${sendFailures === 1 ? '' : 's'} could not be sent`);
            return;
          }
          await new Promise((r) => setTimeout(r, Number(opts.poll) * 1000));
        }
      });
    });

  gate
    .command('resync <vault>')
    .description("Owner: set the gate's books of <vault> to the vault's balanceOf(gate) now, after an exit the vault misreported.")
    .action(async (vaultArg: string, _opts: unknown, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo gate resync', WATCH_FAILED_EXIT_CODE, async () => {
        const vault = address(vaultArg, '<vault>');
        const net = network(command);
        const at = gateAddress(net, command);
        const wallet = net.clients.wallet(resolveKey(net, DEPLOYER_KEY_ENV));
        const g = new AllocationGateClient(at, net.clients.publicClient, wallet);
        try {
          const out = await g.resync(vault);
          printLine(ctx, stage('gate', `books of ${pc.bold(vault)}: ${formatEther(out.fromShares)} to ${formatEther(out.toShares)} shares  ${pc.dim(`tx ${out.hash}`)}`));
          emitEvent(ctx, { type: 'watch-demo-gate-resynced', chainId: net.clients.chain.id, gate: at, vault, fromShares: out.fromShares, toShares: out.toShares, txHash: out.hash });
        } catch (err) {
          failed(err);
        }
      });
    });

  gate
    .command('status')
    .description("Read the gate: idle assets and, per vault, its position, its verdict and the registry's latest attestation. No key needed.")
    .action(async (_opts: unknown, command: Command) => {
      const ctx = contextFrom(command);
      await runStage(ctx, 'watch demo gate status', WATCH_FAILED_EXIT_CODE, async () => {
        const net = network(command);
        const at = gateAddress(net, command);
        const client = net.clients.publicClient;
        const g = new AllocationGateClient(at, client);
        try {
          const s = await g.summary();
          const registry = new AttestationRegistryClient(s.registry, client);
          const now = (await client.getBlock({ blockTag: 'latest' })).timestamp;
          printLine(ctx, stage('gate', `AllocationGate ${pc.bold(at)}  ${pc.dim(`${net.name} ${net.clients.chain.id}`)}`));
          printLine(ctx, cont(`registry ${s.registry}, asset ${s.asset}, owner ${s.owner}, ${s.suiteHash === ZERO_HASH ? 'any suite' : `suite ${s.suiteHash}`}, attestations fresh for ${s.maxAttestationAge} s`));
          printLine(ctx, cont(`exit stipends ${s.vaultCallGas} gas per vault call, ${s.vaultViewGas} per read`));
          printLine(ctx, cont(`idle ${formatEther(s.idle)}, ${s.vaults.length} vault${s.vaults.length === 1 ? '' : 's'}`));
          const vaults: Array<Record<string, unknown>> = [];
          for (const vault of s.vaults) {
            const st: GateVaultState = await g.vaultState(vault);
            const latest = await registry.latest(s.subjectChainId, vault, s.standardId);
            const a = latest?.attestation;
            const isIssuer = a ? await registry.isIssuer(a.issuer) : null;
            const p = st.position;
            printLine(ctx, cont(`${pc.bold(vault)}  ${verdictText(st.verdict)}${st.canExit ? pc.red('  exit open') : ''}`));
            printLine(ctx, cont(`  ${formatEther(p.shares)} shares, ${formatEther(p.assetsIn)} in, ${formatEther(p.assetsOut)} out${p.lastExitBlock > 0n ? `, last exit attempt block ${p.lastExitBlock}` : ''}`));
            printLine(ctx, cont(pc.dim(a ? `  attestation ${latest!.id}: ${ATTESTATION_STATUS[a.status] ?? a.status}, ${a.passCount} pass ${a.failCount} fail ${a.inconclusiveCount} inconclusive ${a.notApplicableCount} n/a, issuer ${a.issuer}${isIssuer ? '' : ' (removed)'}, ${ago(a.issuedAt, now)}` : '  no attestation')));
            vaults.push({
              vault,
              verdict: st.verdict,
              canExit: st.canExit,
              position: p,
              attestation: a ? { id: latest!.id, status: ATTESTATION_STATUS[a.status] ?? a.status, passCount: a.passCount, failCount: a.failCount, inconclusiveCount: a.inconclusiveCount, notApplicableCount: a.notApplicableCount, issuer: a.issuer, issuerAllowed: isIssuer, issuedAt: a.issuedAt, blockNumber: a.blockNumber } : null,
            });
          }
          emitEvent(ctx, { type: 'watch-demo-gate-status', chainId: net.clients.chain.id, gate: at, registry: s.registry, asset: s.asset, owner: s.owner, suiteHash: s.suiteHash, vaultCallGas: s.vaultCallGas, vaultViewGas: s.vaultViewGas, maxAttestationAge: s.maxAttestationAge, idle: s.idle, now, vaults });
        } catch (err) {
          failed(err);
        }
      });
    });
}
