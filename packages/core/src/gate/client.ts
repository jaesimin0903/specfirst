import { decodeErrorResult, encodeDeployData, getAddress, keccak256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { TX_GAS_CAP, withMargin } from '../chain/gas.js';
import type { TxOutcome } from '../cert/registry.js';
import { demoTokenAbi } from '../watch/demoArtifact.js';
import { allocationGateAbi, allocationGateBytecode, exitAllowed, gateExitPathOf, gateVerdictOf, type GateExitPath, type GateVerdict } from './index.js';

/** keccak256 of the bundled creation code; `watch demo gate deploy` prints it so a deploy can be matched to a build. */
export const allocationGateCreationCodeHash: Hex = keccak256(allocationGateBytecode);

/**
 * Default maxAttestationAge of `watch demo gate deploy`: a day. The age runs from the attestation's issuedAt, and the
 * watcher's unchanged re-checks are not attested, so a day after a vault's last attested change allocate is refused
 * (Stale) until a new check is attested: a desk request, or `specfirst check` and `specfirst cert attest`. Stale
 * never opens exit to anyone but the owner.
 */
export const DEFAULT_GATE_MAX_AGE_SEC = 86_400n;

/** What a stale attestation needs, for people reading a refusal. */
export const GATE_FRESH_ATTESTATION_HINT =
  'unchanged re-checks of the watcher are not attested, so get a new attestation of the vault: a desk request (`specfirst desk request`), or `specfirst check <vault>` and then `specfirst cert attest <report>` with an issuer key';

/** Default slippage of `watch demo gate allocate` when no --min-shares is given: 1%, in basis points. */
export const DEFAULT_GATE_SLIPPAGE_BPS = 100n;

/**
 * Default stipends of `watch demo gate deploy`: gas each redeem or withdraw, and each maxWithdraw or balanceOf, of an
 * exit gets. Sized for Monad, where a cold account costs 10,100 and a cold storage page 8,100 and the gas limit is
 * what a transaction pays (docs/adr/0007).
 */
export const DEFAULT_GATE_VAULT_CALL_GAS = 2_000_000n;
export const DEFAULT_GATE_VAULT_VIEW_GAS = 300_000n;

/** Keeper backoff after an exit that would move nothing (ExitFailed): from a minute, doubling, up to an hour. */
export const GATE_BACKOFF_MIN_MS = 60_000;
export const GATE_BACKOFF_MAX_MS = 3_600_000;

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
  /** The suite the gate pins; zero accepts any. */
  suiteHash: Hex;
  vaultCallGas: bigint;
  vaultViewGas: bigint;
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
  /** The registry's suiteHash the gate accepts; omitted or zero accepts any suite. */
  suiteHash?: Hex;
  asset: Address;
  owner: Address;
  /** Seconds; 1 to 2^64 - 1. */
  maxAttestationAge: bigint;
  /** Exit's stipends (default DEFAULT_GATE_VAULT_CALL_GAS and DEFAULT_GATE_VAULT_VIEW_GAS). */
  vaultCallGas?: bigint;
  vaultViewGas?: bigint;
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
    args: [
      i.registry,
      i.subjectChainId,
      i.standardId,
      i.suiteHash ?? ZERO_HASH,
      i.asset,
      i.owner,
      i.maxAttestationAge,
      i.vaultCallGas ?? DEFAULT_GATE_VAULT_CALL_GAS,
      i.vaultViewGas ?? DEFAULT_GATE_VAULT_VIEW_GAS,
    ],
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

const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`;

const previewAbi = [
  { type: 'function', name: 'previewDeposit', stateMutability: 'view', inputs: [{ name: 'assets', type: 'uint256' }], outputs: [{ name: 'shares', type: 'uint256' }] },
] as const;

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

  private async write(functionName: 'allocate' | 'exit' | 'withdraw' | 'resync', args: readonly unknown[]): Promise<Mined> {
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

  private events<N extends 'Allocated' | 'Exited' | 'ExitFailed' | 'IdleWithdrawn' | 'Resynced'>(out: Mined, eventName: N) {
    const self = this.address.toLowerCase();
    return parseEventLogs({ abi: allocationGateAbi, eventName, logs: out.receipt.logs }).filter((l) => l.address.toLowerCase() === self);
  }

  private static strip(out: Mined): GateTx {
    const { receipt: _receipt, ...tx } = out;
    return tx;
  }

  async summary(): Promise<GateSummary> {
    const [registry, subjectChainId, standardId, suiteHash, vaultCallGas, vaultViewGas, asset, owner, maxAttestationAge, idle, vaults] = await Promise.all([
      this.read<Address>('registry'),
      this.read<bigint>('subjectChainId'),
      this.read<Hex>('standardId'),
      this.read<Hex>('suiteHash'),
      this.read<bigint>('vaultCallGas'),
      this.read<bigint>('vaultViewGas'),
      this.read<Address>('asset'),
      this.read<Address>('owner'),
      this.read<bigint>('maxAttestationAge'),
      this.read<bigint>('idle'),
      this.read<readonly Address[]>('vaults'),
    ]);
    return { address: this.address, registry, subjectChainId, standardId, suiteHash, vaultCallGas, vaultViewGas, asset, owner, maxAttestationAge, idle, vaults: [...vaults] };
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

  /**
   * The vault's own quote for `assets` (previewDeposit) less `slippageBps`: a minShares for allocate. Read from the
   * vault, so it guards against a share price that moves between this read and the deposit, not against a vault
   * that misquotes.
   */
  async minSharesFor(vault: Address, assets: bigint, slippageBps: bigint = DEFAULT_GATE_SLIPPAGE_BPS): Promise<bigint> {
    if (slippageBps < 0n || slippageBps > 10_000n) throw new GateError(`slippage ${slippageBps} bps must be 0 to 10000`);
    const quote = (await this.client.readContract({ address: vault, abi: previewAbi, functionName: 'previewDeposit', args: [assets] })) as bigint;
    return (quote * (10_000n - slippageBps)) / 10_000n;
  }

  /**
   * Owner only. The vault must be Compliant and hold the gate's asset, and its balanceOf(gate) must rise by at least
   * `minShares` (TooFewShares); assets and shares come from Allocated.
   */
  async allocate(vault: Address, assets: bigint, minShares: bigint): Promise<GateTx & { vault: Address; attestationId: bigint; assets: bigint; shares: bigint }> {
    const out = await this.write('allocate', [vault, assets, minShares]);
    const ev = this.events(out, 'Allocated');
    if (ev.length !== 1) throw new GateError(`allocate tx ${out.hash}: expected one Allocated event from ${this.address}, found ${ev.length}`);
    const e = ev[0]!.args;
    return { ...AllocationGateClient.strip(out), vault: getAddress(e.vault), attestationId: e.attestationId, assets: e.assets, shares: e.shares };
  }

  /**
   * Anyone, once the vault is neither Compliant nor Stale (StillCompliant otherwise); the owner on any verdict. A vault
   * that moves nothing gives exited false (ExitFailed).
   */
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

  /**
   * What exit(vault) would return if sent now by this client's account: false means the vault would move nothing
   * (ExitFailed). Reverts surface as GateError (StillCompliant, NothingToExit, ...). Costs no gas.
   */
  async simulateExit(vault: Address): Promise<boolean> {
    try {
      const { result } = await this.client.simulateContract({ address: this.address, abi: allocationGateAbi, functionName: 'exit', args: [vault], ...(this.wallet ? { account: this.wallet.account } : {}) } as never);
      return result as boolean;
    } catch (err) {
      throw failure('exit would fail', err);
    }
  }

  /** Owner only: set the books of `vault` to the vault's balanceOf(gate); from and to come from Resynced. */
  async resync(vault: Address): Promise<GateTx & { vault: Address; fromShares: bigint; toShares: bigint }> {
    const out = await this.write('resync', [vault]);
    const ev = this.events(out, 'Resynced');
    if (ev.length !== 1) throw new GateError(`resync tx ${out.hash}: expected one Resynced event from ${this.address}, found ${ev.length}`);
    const e = ev[0]!.args;
    return { ...AllocationGateClient.strip(out), vault: getAddress(e.vault), fromShares: e.fromShares, toShares: e.toShares };
  }

  /** Owner only: idle assets out of the gate. */
  async withdraw(to: Address, amount: bigint): Promise<GateTx> {
    return AllocationGateClient.strip(await this.write('withdraw', [to, amount]));
  }
}

/** The gate calls a keeper makes; AllocationGateClient has them, a test can fake them. */
export interface GateKeeperTarget {
  summary(): Promise<Pick<GateSummary, 'vaults'>>;
  position(vault: Address): Promise<GatePosition>;
  verdict(vault: Address): Promise<{ verdict: GateVerdict; attestationId: bigint | null }>;
  simulateExit(vault: Address): Promise<boolean>;
  exit(vault: Address): Promise<GateExitOutcome>;
}

/**
 * What one keeper pass did with one vault. empty: no shares, nothing else read. closed: exit is not open to anyone.
 * waiting: backing off, not tried. backoff: the exit would move nothing (simulated, or mined as ExitFailed), so a new,
 * longer wait starts; this is the one to log. exited: assets came back. error: a read, simulation or send failed
 * (no wait: an RPC hiccup should not hold an exit back).
 */
export type GateKeeperResult =
  | { vault: Address; kind: 'empty' }
  | { vault: Address; kind: 'closed'; verdict: GateVerdict }
  | { vault: Address; kind: 'waiting'; until: number }
  | { vault: Address; kind: 'backoff'; verdict: GateVerdict; delayMs: number; until: number; outcome?: GateExitOutcome }
  | { vault: Address; kind: 'exited'; outcome: GateExitOutcome }
  | { vault: Address; kind: 'error'; error: GateError };

/**
 * The keeper behind `watch demo gate keep`: each pass looks at every vault of the gate, in the gate's order, one
 * transaction at most per vault. A vault whose exit would move nothing is simulated, not sent, and then left alone for
 * GATE_BACKOFF_MIN_MS, doubling after each further try that moves nothing up to GATE_BACKOFF_MAX_MS; the wait ends
 * when the vault pays, its exit closes or its position empties.
 */
export class GateKeeper {
  private readonly waits = new Map<string, { delayMs: number; until: number }>();

  constructor(
    readonly gate: GateKeeperTarget,
    private readonly now: () => number = Date.now,
  ) {}

  async pass(): Promise<GateKeeperResult[]> {
    const { vaults } = await this.gate.summary();
    const results: GateKeeperResult[] = [];
    for (const vault of vaults) results.push(await this.one(vault));
    return results;
  }

  private backoff(vault: Address, verdict: GateVerdict, outcome?: GateExitOutcome): GateKeeperResult {
    const key = vault.toLowerCase();
    const prev = this.waits.get(key);
    const delayMs = prev ? Math.min(prev.delayMs * 2, GATE_BACKOFF_MAX_MS) : GATE_BACKOFF_MIN_MS;
    const until = this.now() + delayMs;
    this.waits.set(key, { delayMs, until });
    return { vault, kind: 'backoff', verdict, delayMs, until, ...(outcome ? { outcome } : {}) };
  }

  private async one(vault: Address): Promise<GateKeeperResult> {
    const key = vault.toLowerCase();
    try {
      if ((await this.gate.position(vault)).shares === 0n) {
        this.waits.delete(key);
        return { vault, kind: 'empty' };
      }
      const wait = this.waits.get(key);
      if (wait && this.now() < wait.until) return { vault, kind: 'waiting', until: wait.until };
      const { verdict } = await this.gate.verdict(vault);
      if (!exitAllowed(verdict)) {
        this.waits.delete(key);
        return { vault, kind: 'closed', verdict };
      }
      if (!(await this.gate.simulateExit(vault))) return this.backoff(vault, verdict);
      const outcome = await this.gate.exit(vault);
      if (!outcome.exited) return this.backoff(vault, verdict, outcome);
      this.waits.delete(key);
      return { vault, kind: 'exited', outcome };
    } catch (err) {
      return { vault, kind: 'error', error: err instanceof GateError ? err : failure(`keeping ${vault} failed`, err) };
    }
  }
}
