import { encodeDeployData, getAddress, type Address, type Hex } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { RegistryError, type TxOutcome } from '../cert/registry.js';
import { gasLimitFor } from '../deploy/deploy.js';
import { checkAttestationRegistryAbi, checkAttestationRegistryBytecode } from './artifact.js';
import type { AttestationSuite, AttestParams } from './params.js';

export { checkAttestationRegistryAbi, checkAttestationRegistryBytecode };

export const ATTESTATION_STATUS = ['None', 'Valid', 'Superseded', 'Revoked'] as const;
export type AttestationStatusName = (typeof ATTESTATION_STATUS)[number];

export interface Attestation {
  subjectChainId: bigint;
  subject: Address;
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
 */
export async function deployAttestationRegistry(i: {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  issuer?: Address;
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
  const registry = new AttestationRegistryClient(address, i.client, i.wallet);
  const issuer = getAddress(i.issuer ?? from);
  const issuerTx = await registry.setIssuer(issuer, true);
  return { address, deployTx: { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed }, issuer, issuerTx };
}

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

  private async write(functionName: 'attest' | 'revoke' | 'setIssuer', args: readonly unknown[]): Promise<TxOutcome & { result: unknown }> {
    if (!this.wallet) throw new RegistryError(`${functionName} needs a wallet client`);
    const call = { address: this.address, abi: checkAttestationRegistryAbi, functionName, args, account: this.wallet.account } as never;
    try {
      const sim = await this.client.simulateContract(call);
      const gas = gasLimitFor(await this.client.estimateContractGas(call));
      const hash = await this.wallet.writeContract({ ...(sim as { request: object }).request, gas } as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new RegistryError(`${functionName} tx ${hash} reverted`);
      return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, result: (sim as { result: unknown }).result };
    } catch (err) {
      if (err instanceof RegistryError) throw err;
      const name = decodedName(err);
      const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
      throw new RegistryError(`${functionName} failed${name ? ` (${name})` : ''}: ${msg}`, name, err);
    }
  }

  async attest(p: AttestParams): Promise<TxOutcome & { id: bigint }> {
    const out = await this.write('attest', [p]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed, id: out.result as bigint };
  }

  async revoke(id: bigint, reasonHash: Hex): Promise<TxOutcome> {
    const out = await this.write('revoke', [id, reasonHash]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed };
  }

  async setIssuer(issuer: Address, allowed: boolean): Promise<TxOutcome> {
    const out = await this.write('setIssuer', [issuer, allowed]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed };
  }

  /** Latest attestation of a subject, or null when there is none. */
  async latest(subjectChainId: bigint, subject: Address): Promise<{ id: bigint; attestation: Attestation } | null> {
    try {
      const [id, attestation] = await this.read<readonly [bigint, Attestation]>('latest', [subjectChainId, subject]);
      return { id, attestation };
    } catch (err) {
      if (decodedName(err) === 'NoAttestation') return null;
      throw err;
    }
  }
  isCompliant(subjectChainId: bigint, subject: Address): Promise<boolean> {
    return this.read('isCompliant', [subjectChainId, subject]);
  }
  attestationOf(id: bigint): Promise<Attestation> {
    return this.read('attestationOf', [id]);
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
