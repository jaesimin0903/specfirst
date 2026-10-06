import { decodeErrorResult, encodeDeployData, getAddress, keccak256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { TX_GAS_CAP, withMargin } from '../chain/gas.js';
import type { TxOutcome } from '../cert/registry.js';
import { demoTokenAbi } from '../watch/demoArtifact.js';
import { allocationGateAbi, allocationGateBytecode, exitAllowed, gateExitPathOf, gateVerdictOf, type GateExitPath, type GateVerdict } from './index.js';

/** keccak256 of the bundled creation code; `watch demo gate deploy` prints it so a deploy can be matched to a build. */
export const allocationGateCreationCodeHash: Hex = keccak256(allocationGateBytecode);

/** Default maxAttestationAge of `watch demo gate deploy`: a day, the watcher's default sweep period. */
export const DEFAULT_GATE_MAX_AGE_SEC = 86_400n;

/** AllocationGate.Position as viem decodes it. */
export interface GatePosition {
  shares: bigint;
  assetsIn: bigint;
  assetsOut: bigint;
  lastAllocatedBlock: bigint;
  lastExitBlock: bigint;
}

export interface GateSummary {
  address: Address;
  registry: Address;
  subjectChainId: bigint;
  standardId: Hex;
  asset: Address;
  owner: Address;
  maxAttestationAge: bigint;
  idle: bigint;
  vaults: Address[];
}

export interface GateVaultState {
  vault: Address;
  position: GatePosition;
  verdict: GateVerdict;
  /** The latest attestation's id; null when there is none (NoAttestation). */
  attestationId: bigint | null;
  /** exit(vault) would try: the gate holds shares and the verdict allows it. */
  canExit: boolean;
}

/** A mined gate transaction with what it cost: gasUsed x effectiveGasPrice. */
export interface GateTx extends TxOutcome {
  effectiveGasPrice: bigint;
  gasCostWei: bigint;
}

export type GateExitOutcome = GateTx & { vault: Address; verdict: GateVerdict; attestationId: bigint } & (
    | { exited: true; path: GateExitPath; shares: bigint; assets: bigint }
    | { exited: false; shares: bigint; redeemError: Hex; withdrawError: Hex }
  );

export class GateError extends Error {
  constructor(message: string, readonly errorName?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'GateError';
  }
}

/**
 * The gate's custom error in an error chain: viem's decoded name when the call had the ABI, else raw revert data
 * decoded against the gate's ABI (a deploy's gas estimate has no ABI to decode with).
 */
function decodedName(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as { data?: unknown }).data;
    if (d && typeof d === 'object' && typeof (d as { errorName?: unknown }).errorName === 'string') return (d as { errorName: string }).errorName;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]{8}/.test(d)) {
      try {
        return decodeErrorResult({ abi: allocationGateAbi, data: d as Hex }).errorName;
      } catch {
        /* not one of the gate's errors */
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function failure(what: string, err: unknown): GateError {
  const name = decodedName(err);
  const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
  return new GateError(`${what}${name ? ` (${name})` : ''}: ${msg}`, name, err);
}

/** The gasLimitFor policy of deploy/deploy.ts: estimate x 1.2, strictly below the per-transaction cap. */
function gasLimit(estimate: bigint): bigint {
  const limit = withMargin(estimate);
  if (limit >= TX_GAS_CAP) throw new GateError(`gas limit ${limit} (estimate ${estimate} x 1.2) is not below the per-tx cap ${TX_GAS_CAP}`);
  return limit;
}

function txOf(hash: Hex, receipt: Pick<TransactionReceipt, 'blockNumber' | 'gasUsed' | 'effectiveGasPrice'>): GateTx {
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice, gasCostWei: receipt.gasUsed * effectiveGasPrice };
}

export interface DeployGateInput {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  registry: Address;
  /** Must be the chain the gate is deployed on (WrongSubjectChain otherwise): the vaults live next to it. */
  subjectChainId: bigint;
  standardId: Hex;
  asset: Address;
  owner: Address;
  /** Seconds; 1 to 2^64 - 1. */
  maxAttestationAge: bigint;
}

/**
 * Deploys AllocationGate from the bundled creation code with the guarded wallet (the chain checks of
 * createChainClients apply; no forge --broadcast). The constructor's checks surface by name from the estimate.
 */
export async function deployAllocationGate(i: DeployGateInput): Promise<{ address: Address; tx: GateTx }> {
  if (i.maxAttestationAge <= 0n || i.maxAttestationAge >= 2n ** 64n) throw new GateError(`maxAttestationAge ${i.maxAttestationAge} must be 1 to 2^64 - 1 seconds`, 'ZeroMaxAge');
  const data = encodeDeployData({
    abi: allocationGateAbi,
    bytecode: allocationGateBytecode,
    args: [i.registry, i.subjectChainId, i.standardId, i.asset, i.owner, i.maxAttestationAge],
  });
  let gas: bigint;
  try {
    gas = gasLimit(await i.client.estimateGas({ account: i.wallet.account.address, data }));
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw failure('AllocationGate deploy would fail', err);
  }
  const hash = await i.wallet.sendTransaction({ data, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new GateError(`AllocationGate deploy tx ${hash} failed (status ${receipt.status})`);
  return { address: getAddress(receipt.contractAddress), tx: txOf(hash, receipt) };
}

/** DemoToken.mint(to, amount): the demo's way to give a gate idle assets (anyone may mint a DemoToken). */
export async function mintDemoToken(i: { client: SpecfirstPublicClient; wallet: SpecfirstWalletClient; token: Address; to: Address; amount: bigint }): Promise<GateTx> {
  const call = { address: i.token, abi: demoTokenAbi, functionName: 'mint', args: [i.to, i.amount], account: i.wallet.account } as const;
  try {
    const gas = gasLimit(await i.client.estimateContractGas(call));
    const hash = await i.wallet.writeContract({ ...call, gas });
    const receipt = await i.client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new GateError(`DemoToken.mint tx ${hash} reverted`);
    return txOf(hash, receipt);
  } catch (err) {
    if (err instanceof GateError) throw err;
    throw failure(`DemoToken.mint at ${i.token} failed`, err);
  }
}

type Mined = GateTx & { receipt: TransactionReceipt };

/**
 * Thin client over AllocationGate. Writes are simulated first so custom errors surface by name; amounts come from the
 * gate's own events in the mined receipt.
 */
export class AllocationGateClient {
  constructor(
    readonly address: Address,
    readonly client: SpecfirstPublicClient,
    readonly wallet?: SpecfirstWalletClient,
  ) {}

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: this.address, abi: allocationGateAbi, functionName, args } as never) as Promise<T>;
  }

  private async write(functionName: 'allocate' | 'exit' | 'withdraw', args: readonly unknown[]): Promise<Mined> {
    if (!this.wallet) throw new GateError(`${functionName} needs a wallet client`);
    const call = { address: this.address, abi: allocationGateAbi, functionName, args, account: this.wallet.account } as never;
    try {
      const sim = await this.client.simulateContract(call);
      const gas = gasLimit(await this.client.estimateContractGas(call));
      const hash = await this.wallet.writeContract({ ...(sim as { request: object }).request, gas } as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new GateError(`${functionName} tx ${hash} reverted`);
      return { ...txOf(hash, receipt), receipt };
    } catch (err) {
      if (err instanceof GateError) throw err;
      throw failure(`${functionName} failed`, err);
    }
  }

  private events<N extends 'Allocated' | 'Exited' | 'ExitFailed' | 'IdleWithdrawn'>(out: Mined, eventName: N) {
    const self = this.address.toLowerCase();
    return parseEventLogs({ abi: allocationGateAbi, eventName, logs: out.receipt.logs }).filter((l) => l.address.toLowerCase() === self);
  }

  private static strip(out: Mined): GateTx {
    const { receipt: _receipt, ...tx } = out;
    return tx;
  }

  async summary(): Promise<GateSummary> {
    const [registry, subjectChainId, standardId, asset, owner, maxAttestationAge, idle, vaults] = await Promise.all([
      this.read<Address>('registry'),
      this.read<bigint>('subjectChainId'),
      this.read<Hex>('standardId'),
      this.read<Address>('asset'),
      this.read<Address>('owner'),
      this.read<bigint>('maxAttestationAge'),
      this.read<bigint>('idle'),
      this.read<readonly Address[]>('vaults'),
    ]);
    return { address: this.address, registry, subjectChainId, standardId, asset, owner, maxAttestationAge, idle, vaults: [...vaults] };
  }

  position(vault: Address): Promise<GatePosition> {
    return this.read<GatePosition>('positionOf', [vault]);
  }

  async verdict(vault: Address): Promise<{ verdict: GateVerdict; attestationId: bigint | null }> {
    const [v, id] = await this.read<readonly [number, bigint]>('verdictOf', [vault]);
    const verdict = gateVerdictOf(v);
    return { verdict, attestationId: verdict === 'NoAttestation' ? null : id };
  }

  async vaultState(vault: Address): Promise<GateVaultState> {
    const [position, { verdict, attestationId }] = await Promise.all([this.position(vault), this.verdict(vault)]);
    return { vault, position, verdict, attestationId, canExit: position.shares > 0n && exitAllowed(verdict) };
  }

  /** Owner only. The vault must be Compliant and hold the gate's asset; assets and shares come from Allocated. */
  async allocate(vault: Address, assets: bigint): Promise<GateTx & { vault: Address; attestationId: bigint; assets: bigint; shares: bigint }> {
    const out = await this.write('allocate', [vault, assets]);
    const ev = this.events(out, 'Allocated');
    if (ev.length !== 1) throw new GateError(`allocate tx ${out.hash}: expected one Allocated event from ${this.address}, found ${ev.length}`);
    const e = ev[0]!.args;
    return { ...AllocationGateClient.strip(out), vault: getAddress(e.vault), attestationId: e.attestationId, assets: e.assets, shares: e.shares };
  }

  /** Anyone. Refused (StillCompliant) while the vault is Compliant or Stale; a vault that refuses gives exited false. */
  async exit(vault: Address): Promise<GateExitOutcome> {
    const out = await this.write('exit', [vault]);
    const tx = AllocationGateClient.strip(out);
    const done = this.events(out, 'Exited');
    if (done.length === 1) {
      const e = done[0]!.args;
      return { ...tx, vault: getAddress(e.vault), verdict: gateVerdictOf(e.verdict), attestationId: e.attestationId, exited: true, path: gateExitPathOf(e.path), shares: e.shares, assets: e.assets };
    }
    const failed = this.events(out, 'ExitFailed');
    if (failed.length === 1) {
      const e = failed[0]!.args;
      return { ...tx, vault: getAddress(e.vault), verdict: gateVerdictOf(e.verdict), attestationId: e.attestationId, exited: false, shares: e.shares, redeemError: e.redeemError, withdrawError: e.withdrawError };
    }
    throw new GateError(`exit tx ${out.hash}: expected one Exited or ExitFailed event from ${this.address}, found none`);
  }

  /** Owner only: idle assets out of the gate. */
  async withdraw(to: Address, amount: bigint): Promise<GateTx> {
    return AllocationGateClient.strip(await this.write('withdraw', [to, amount]));
  }
}

/**
 * One keeper pass: every vault of the gate whose exit is open (shares held, verdict neither Compliant nor Stale) is
 * exited, one transaction each, in the gate's order. A vault whose exit fails to send is reported and the pass goes
 * on, so one broken vault never holds up the others.
 */
export async function exitDueVaults(gate: AllocationGateClient): Promise<Array<{ state: GateVaultState; outcome?: GateExitOutcome; error?: GateError }>> {
  const { vaults } = await gate.summary();
  const results: Array<{ state: GateVaultState; outcome?: GateExitOutcome; error?: GateError }> = [];
  for (const vault of vaults) {
    const state = await gate.vaultState(vault);
    if (!state.canExit) {
      results.push({ state });
      continue;
    }
    try {
      results.push({ state, outcome: await gate.exit(vault) });
    } catch (err) {
      results.push({ state, error: err instanceof GateError ? err : failure(`exit ${vault} failed`, err) });
    }
  }
  return results;
}
