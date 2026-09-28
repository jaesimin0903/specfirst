import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { certificateRegistryAbi } from './abi.js';

export { certificateRegistryAbi };

export const CERT_STATUS = ['None', 'Valid', 'Superseded', 'Revoked'] as const;
export type CertStatusName = (typeof CERT_STATUS)[number];

export interface IssueParams {
  target: Address;
  projectId: Hex;
  specHash: Hex;
  invariantSetHash: Hex;
  propertyHash: Hex;
  reportHash: Hex;
  passedCount: number;
  totalCount: number;
  passedBitmap: bigint;
  rehearsalTxCount: number;
  reportURI: string;
}

export interface Certificate {
  projectId: Hex;
  specHash: Hex;
  invariantSetHash: Hex;
  propertyHash: Hex;
  codeHash: Hex;
  reportHash: Hex;
  issuedAt: bigint;
  passedCount: number;
  totalCount: number;
  passedBitmap: bigint;
  rehearsalTxCount: number;
  status: number;
  supersededBy: Address;
  revokeReasonHash: Hex;
  reportURI: string;
}

export interface TxOutcome {
  hash: Hex;
  blockNumber: bigint;
  gasUsed: bigint;
}

export class RegistryError extends Error {
  constructor(message: string, readonly errorName?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'RegistryError';
  }
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

/** Thin client over CertificateRegistry. Writes are simulated first so custom errors surface by name. */
export class RegistryClient {
  constructor(
    readonly address: Address,
    readonly client: SpecfirstPublicClient,
    readonly wallet?: SpecfirstWalletClient,
  ) {}

  private read<T>(functionName: string, args: readonly unknown[]): Promise<T> {
    return this.client.readContract({ address: this.address, abi: certificateRegistryAbi, functionName, args } as never) as Promise<T>;
  }

  private async write(functionName: 'issue' | 'revoke' | 'setIssuer', args: readonly unknown[]): Promise<TxOutcome & { result: unknown }> {
    if (!this.wallet) throw new RegistryError(`${functionName} needs a wallet client`);
    try {
      const sim = await this.client.simulateContract({
        address: this.address,
        abi: certificateRegistryAbi,
        functionName,
        args,
        account: this.wallet.account,
      } as never);
      const est = await this.client.estimateContractGas({
        address: this.address,
        abi: certificateRegistryAbi,
        functionName,
        args,
        account: this.wallet.account,
      } as never);
      const gas = (est * 12n + 9n) / 10n;
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

  async issue(p: IssueParams): Promise<TxOutcome & { certId: bigint }> {
    const out = await this.write('issue', [p]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed, certId: out.result as bigint };
  }

  /** evidenceURI must be non-empty; the contract rejects it otherwise. */
  async revoke(target: Address, certId: bigint, reasonHash: Hex, evidenceURI: string): Promise<TxOutcome> {
    const out = await this.write('revoke', [target, certId, reasonHash, evidenceURI]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed };
  }

  async setIssuer(issuer: Address, allowed: boolean): Promise<TxOutcome> {
    const out = await this.write('setIssuer', [issuer, allowed]);
    return { hash: out.hash, blockNumber: out.blockNumber, gasUsed: out.gasUsed };
  }

  isCertified(target: Address): Promise<boolean> {
    return this.read('isCertified', [target]);
  }
  isCertifiedWith(target: Address, invariantSetHash: Hex): Promise<boolean> {
    return this.read('isCertifiedWith', [target, invariantSetHash]);
  }
  isLatest(target: Address): Promise<boolean> {
    return this.read('isLatest', [target]);
  }
  isIssuer(who: Address): Promise<boolean> {
    return this.read('isIssuer', [who]);
  }
  async latest(target: Address): Promise<{ certId: bigint; certificate: Certificate; codeMatches: boolean } | null> {
    try {
      const [certId, certificate, codeMatches] = await this.read<readonly [bigint, Certificate, boolean]>('latest', [target]);
      return { certId, certificate, codeMatches };
    } catch (err) {
      if (decodedName(err) === 'NoCertificate') return null;
      throw err;
    }
  }
  currentTargetOf(projectId: Hex): Promise<Address> {
    return this.read('currentTargetOf', [projectId]);
  }
  certificateOf(target: Address, certId: bigint): Promise<Certificate> {
    return this.read('certificateOf', [target, certId]);
  }
  certificateCount(target: Address): Promise<bigint> {
    return this.read('certificateCount', [target]);
  }
}

/** keccak256 of the evidence bytes, used as revokeReasonHash. */
export function evidenceHash(evidence: string | Uint8Array): Hex {
  return keccak256(typeof evidence === 'string' ? toHex(evidence) : evidence);
}
