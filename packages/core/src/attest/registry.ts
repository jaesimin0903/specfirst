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

  private async write(
    functionName: 'attest' | 'revoke' | 'setIssuer',
    args: readonly unknown[],
    send: AttestSendOptions = {},
  ): Promise<TxOutcome & { receipt: TransactionReceipt }> {
    if (!this.wallet) throw new RegistryError(`${functionName} needs a wallet client`);
    const call = { address: this.address, abi: checkAttestationRegistryAbi, functionName, args, account: this.wallet.account } as never;
    try {
      const sim = await this.client.simulateContract(call);
      const gas = gasLimitFor(await this.client.estimateContractGas(call));
      // The nonce is fixed here (viem would read the same pending count) so a caller can record it with the hash.
      const nonce = send.nonce ?? (send.onSent ? await this.client.getTransactionCount({ address: this.wallet.account.address, blockTag: 'pending' }) : undefined);
      const hash = await this.wallet.writeContract({ ...(sim as { request: object }).request, gas, ...(nonce !== undefined ? { nonce } : {}) } as never);
      if (send.onSent) await send.onSent({ hash, nonce: nonce! });
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new RegistryError(`${functionName} tx ${hash} reverted`);
      return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, receipt };
    } catch (err) {
      if (err instanceof RegistryError) throw err;
      const name = decodedName(err);
      const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
      throw new RegistryError(`${functionName} failed${name ? ` (${name})` : ''}: ${msg}`, name, err);
    }
  }

  /**
   * Sends attest and returns the id from the mined receipt: the one Attested event this registry address
   * emitted. The simulation's return value is not used, since another attestation can land between the
   * simulation and the transaction.
   */
  async attest(p: AttestParams, send: AttestSendOptions = {}): Promise<TxOutcome & { id: bigint; effectiveGasPrice: bigint }> {
    const out = await this.write('attest', [p], send);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed, id: this.attestedIdOf(out.hash, out.receipt), effectiveGasPrice: out.receipt.effectiveGasPrice ?? 0n };
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
