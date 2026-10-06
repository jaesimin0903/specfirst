import { encodeDeployData, getAddress, keccak256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { RegistryError, type TxOutcome } from '../cert/registry.js';
import { gasLimitFor } from '../deploy/deploy.js';
import { checkAttestationRegistryAbi, checkAttestationRegistryBytecode } from './artifact.js';
import type { AttestationSuite, AttestParams } from './params.js';

export { checkAttestationRegistryAbi, checkAttestationRegistryBytecode };

/** keccak256 of the bundled creation code; `attest-registry deploy` prints it so a deploy can be matched to a build. */
export const checkAttestationRegistryCreationCodeHash: Hex = keccak256(checkAttestationRegistryBytecode);

export const ATTESTATION_STATUS = ['None', 'Valid', 'Superseded', 'Revoked'] as const;
export type AttestationStatusName = (typeof ATTESTATION_STATUS)[number];

export interface Attestation {
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
  blockNumber: bigint;
  implementationKey: Hex;
  subjectCodeHash: Hex;
  suiteHash: Hex;
  reportHash: Hex;
  passCount: number;
  failCount: number;
  inconclusiveCount: number;
  notApplicableCount: number;
  passedBitmap: bigint;
  failedBitmap: bigint;
  issuedAt: bigint;
  issuer: Address;
  status: number;
  supersededBy: bigint;
  revokeReasonHash: Hex;
  reportURI: string;
}

function decodedName(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as { data?: { errorName?: string } }).data;
    if (d && typeof d === 'object' && typeof d.errorName === 'string') return d.errorName;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Deploys CheckAttestationRegistry from the bundled creation code with the guarded wallet (so the chain
 * checks of createChainClients apply; no forge --broadcast), then allows `issuer` (default: the deployer).
 * `onDeployed` runs as soon as the deploy receipt is in, before setIssuer, so the caller can record the
 * address even when the second transaction fails.
 */
export async function deployAttestationRegistry(i: {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  issuer?: Address;
  onDeployed?: (d: { address: Address; deployTx: TxOutcome }) => void;
}): Promise<{ address: Address; deployTx: TxOutcome; issuer: Address; issuerTx: TxOutcome }> {
  const data = encodeDeployData({ abi: checkAttestationRegistryAbi, bytecode: checkAttestationRegistryBytecode });
  const from = i.wallet.account.address;
  const gas = gasLimitFor(await i.client.estimateGas({ account: from, data }));
  const hash = await i.wallet.sendTransaction({ data, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new RegistryError(`CheckAttestationRegistry deploy tx ${hash} failed (status ${receipt.status})`);
  }
  const address = getAddress(receipt.contractAddress);
  const deployTx = { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
  i.onDeployed?.({ address, deployTx });
  const registry = new AttestationRegistryClient(address, i.client, i.wallet);
  const issuer = getAddress(i.issuer ?? from);
  const issuerTx = await registry.setIssuer(issuer, true);
  return { address, deployTx, issuer, issuerTx };
}

/**
 * How attest sends: `nonce` reuses a nonce recorded earlier (a resend that can only replace the first
 * transaction, never add a second attestation); `onSent` runs once the transaction is accepted, before its
 * receipt is awaited, so the caller can record the hash and nonce first.
 */
export interface AttestSendOptions {
  nonce?: number;
  onSent?: (sent: { hash: Hex; nonce: number }) => void | Promise<void>;
}

export type AttestTxState =
  | { state: 'mined'; id: bigint; gasCostWei: bigint }
  | { state: 'reverted'; gasCostWei: bigint }
  | { state: 'pending' }
  | { state: 'unknown' };

type WriteName = 'attest' | 'revoke' | 'setIssuer';

/** Thin client over CheckAttestationRegistry. Writes are simulated first so custom errors surface by name. */
export class AttestationRegistryClient {
  constructor(
    readonly address: Address,
    readonly client: SpecfirstPublicClient,
    readonly wallet?: SpecfirstWalletClient,
  ) {}

  private read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.client.readContract({ address: this.address, abi: checkAttestationRegistryAbi, functionName, args } as never) as Promise<T>;
  }

  private failure(functionName: WriteName, err: unknown): RegistryError {
    if (err instanceof RegistryError) return err;
    const name = decodedName(err);
    const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
    return new RegistryError(`${functionName} failed${name ? ` (${name})` : ''}: ${msg}`, name, err);
  }

  /**
   * Simulates, estimates and sends, without waiting. `nonce`: a number is used as is, 'pending' fixes the
   * signer's pending count (what viem would pick) so the caller learns it, undefined leaves it to viem.
   */
  private async send(functionName: WriteName, args: readonly unknown[], nonce?: number | 'pending'): Promise<{ hash: Hex; nonce: number | undefined }> {
    if (!this.wallet) throw new RegistryError(`${functionName} needs a wallet client`);
    const call = { address: this.address, abi: checkAttestationRegistryAbi, functionName, args, account: this.wallet.account } as never;
    try {
      const sim = await this.client.simulateContract(call);
      const gas = gasLimitFor(await this.client.estimateContractGas(call));
      const fixed = nonce === 'pending' ? await this.client.getTransactionCount({ address: this.wallet.account.address, blockTag: 'pending' }) : nonce;
      const hash = await this.wallet.writeContract({ ...(sim as { request: object }).request, gas, ...(fixed !== undefined ? { nonce: fixed } : {}) } as never);
      return { hash, nonce: fixed };
    } catch (err) {
      throw this.failure(functionName, err);
    }
  }

  /** Waits for the receipt of a transaction sent earlier; a reverted one is a RegistryError. */
  private async wait(functionName: WriteName, hash: Hex): Promise<TxOutcome & { receipt: TransactionReceipt }> {
    try {
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new RegistryError(`${functionName} tx ${hash} reverted`);
      return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, receipt };
    } catch (err) {
      throw this.failure(functionName, err);
    }
  }

  private async write(functionName: WriteName, args: readonly unknown[]): Promise<TxOutcome & { receipt: TransactionReceipt }> {
    const { hash } = await this.send(functionName, args);
    return this.wait(functionName, hash);
  }

  /**
   * Sends attest and returns the id from the mined receipt: the one Attested event this registry address
   * emitted. The simulation's return value is not used, since another attestation can land between the
   * simulation and the transaction.
   */
  async attest(p: AttestParams, send: AttestSendOptions = {}): Promise<TxOutcome & { id: bigint; effectiveGasPrice: bigint }> {
    const sent = await this.send('attest', [p], send.nonce ?? (send.onSent ? 'pending' : undefined));
    if (send.onSent) await send.onSent({ hash: sent.hash, nonce: sent.nonce! });
    return this.waitAttest(sent.hash);
  }

  /**
   * attest in two steps, for callers that journal the transaction themselves: sendAttest simulates and sends
   * and returns the hash and the nonce it used (`nonce` given: that one, a resend that can only replace the
   * first transaction), without waiting; waitAttest waits for that hash and reads the id from the receipt;
   * attestTx looks a hash up without waiting.
   */
  async sendAttest(p: AttestParams, opts: { nonce?: number } = {}): Promise<{ hash: Hex; nonce: number }> {
    const sent = await this.send('attest', [p], opts.nonce ?? 'pending');
    return { hash: sent.hash, nonce: sent.nonce! };
  }

  async waitAttest(hash: Hex): Promise<TxOutcome & { id: bigint; effectiveGasPrice: bigint }> {
    const out = await this.wait('attest', hash);
    return { hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed, id: this.attestedIdOf(hash, out.receipt), effectiveGasPrice: out.receipt.effectiveGasPrice ?? 0n };
  }

  /**
   * Whether `who` (default: the wallet's address) has transactions the node holds but has not mined: its
   * pending transaction count is above its latest. A journaling caller checks it before sending anew.
   */
  async hasPendingTransactions(who?: Address): Promise<boolean> {
    const address = who ?? this.wallet?.account.address;
    if (!address) throw new RegistryError('hasPendingTransactions needs an address or a wallet client');
    const pending = await this.client.getTransactionCount({ address, blockTag: 'pending' });
    const latest = await this.client.getTransactionCount({ address, blockTag: 'latest' });
    return pending > latest;
  }

  private attestedIdOf(hash: Hex, receipt: Pick<TransactionReceipt, 'logs'>): bigint {
    const self = this.address.toLowerCase();
    const events = parseEventLogs({ abi: checkAttestationRegistryAbi, eventName: 'Attested', logs: receipt.logs }).filter((l) => l.address.toLowerCase() === self);
    if (events.length !== 1) {
      throw new RegistryError(`attest tx ${hash}: expected one Attested event from ${this.address} in the receipt, found ${events.length}`);
    }
    return events[0]!.args.id;
  }

  /**
   * Where an attest transaction sent earlier stands: mined (with the attestation id from its receipt), reverted,
   * pending (the node knows it, no receipt yet) or unknown to the node (dropped, or replaced by another
   * transaction with its nonce). RPC failures are thrown.
   */
  async attestTx(hash: Hex): Promise<AttestTxState> {
    let receipt: TransactionReceipt | null = null;
    try {
      receipt = await this.client.getTransactionReceipt({ hash });
    } catch (err) {
      if ((err as { name?: string }).name !== 'TransactionReceiptNotFoundError') throw err;
    }
    if (receipt) {
      const gasCostWei = receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
      if (receipt.status !== 'success') return { state: 'reverted', gasCostWei };
      return { state: 'mined', id: this.attestedIdOf(hash, receipt), gasCostWei };
    }
    try {
      await this.client.getTransaction({ hash });
      return { state: 'pending' };
    } catch (err) {
      if ((err as { name?: string }).name !== 'TransactionNotFoundError') throw err;
    }
    return { state: 'unknown' };
  }

  async revoke(id: bigint, reasonHash: Hex): Promise<TxOutcome> {
    const out = await this.write('revoke', [id, reasonHash]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed };
  }

  async setIssuer(issuer: Address, allowed: boolean): Promise<TxOutcome> {
    const out = await this.write('setIssuer', [issuer, allowed]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed };
  }

  /** Latest attestation of (subjectChainId, subject, standardId), or null when there is none. */
  async latest(subjectChainId: bigint, subject: Address, standardId: Hex): Promise<{ id: bigint; attestation: Attestation } | null> {
    try {
      const [id, attestation] = await this.read<readonly [bigint, Attestation]>('latest', [subjectChainId, subject, standardId]);
      return { id, attestation };
    } catch (err) {
      if (decodedName(err) === 'NoAttestation') return null;
      throw err;
    }
  }
  isCompliant(subjectChainId: bigint, subject: Address, standardId: Hex): Promise<boolean> {
    return this.read('isCompliant', [subjectChainId, subject, standardId]);
  }
  isCompliantWith(subjectChainId: bigint, subject: Address, standardId: Hex, suiteHash: Hex): Promise<boolean> {
    return this.read('isCompliantWith', [subjectChainId, subject, standardId, suiteHash]);
  }
  /** Reads one attestation; throws RegistryError (UnknownAttestation) for an id that does not exist. */
  async attestationOf(id: bigint): Promise<Attestation> {
    try {
      return await this.read<Attestation>('attestationOf', [id]);
    } catch (err) {
      const name = decodedName(err);
      if (name === 'UnknownAttestation') throw new RegistryError(`no attestation with id ${id} (UnknownAttestation)`, name, err);
      throw err;
    }
  }
  attestationCount(): Promise<bigint> {
    return this.read('attestationCount', []);
  }
  isIssuer(who: Address): Promise<boolean> {
    return this.read('isIssuer', [who]);
  }
  owner(): Promise<Address> {
    return this.read('owner', []);
  }
  suiteHashOf(suite: AttestationSuite): Promise<Hex> {
    return this.read('suiteHashOf', [suite]);
  }
}
