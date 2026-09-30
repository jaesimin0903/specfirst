import { encodeDeployData, getAddress, keccak256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import type { TxOutcome } from '../cert/registry.js';
import { gasLimitFor } from '../deploy/deploy.js';
import { checkRequestDeskAbi, checkRequestDeskBytecode, reasonCodeOf } from './index.js';

/** Exit code of the desk and worker commands when a desk action fails or is refused. */
export const DESK_FAILED_EXIT_CODE = 18;

/** keccak256 of the bundled creation code; `desk deploy` prints it so a deploy can be matched to a build. */
export const checkRequestDeskCreationCodeHash: Hex = keccak256(checkRequestDeskBytecode);

/** CheckRequestDesk.Request as viem decodes it. status is the RequestStatus value (REQUEST_STATUS[status]). */
export interface DeskRequest {
  requester: Address;
  subjectChainId: bigint;
  subject: Address;
  standardId: Hex;
  fee: bigint;
  requestedAt: bigint;
  status: number;
  attestationId: bigint;
  rejectReason: Hex;
}

export interface DeskSummary {
  address: Address;
  owner: Address;
  worker: Address;
  registry: Address;
  fee: bigint;
  timeout: bigint;
  requestCount: bigint;
  earned: bigint;
  withdrawn: bigint;
  escrowed: bigint;
  balance: bigint;
}

/** A mined desk transaction with what it cost: gasUsed x effectiveGasPrice. */
export interface DeskTx extends TxOutcome {
  effectiveGasPrice: bigint;
  gasCostWei: bigint;
}

export class DeskError extends Error {
  constructor(message: string, readonly errorName?: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DeskError';
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

function txOf(hash: Hex, receipt: Pick<TransactionReceipt, 'blockNumber' | 'gasUsed' | 'effectiveGasPrice'>): DeskTx {
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  return { hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, effectiveGasPrice, gasCostWei: receipt.gasUsed * effectiveGasPrice };
}

export interface DeployRequestDeskInput {
  client: SpecfirstPublicClient;
  wallet: SpecfirstWalletClient;
  owner: Address;
  worker: Address;
  registry: Address;
  /** Fee in wei; must fit uint96. */
  fee: bigint;
  /** Seconds; 1 to 2^64 - 1. */
  timeout: bigint;
}

const MAX_UINT96 = 2n ** 96n - 1n;
const MAX_UINT64 = 2n ** 64n - 1n;

/**
 * Deploys CheckRequestDesk from the bundled creation code with the guarded wallet (the chain checks of
 * createChainClients apply; no forge --broadcast). One transaction: the constructor sets owner, worker,
 * registry, fee and timeout.
 */
export async function deployRequestDesk(i: DeployRequestDeskInput): Promise<{ address: Address; tx: DeskTx }> {
  if (i.fee < 0n || i.fee > MAX_UINT96) throw new DeskError(`fee ${i.fee} wei does not fit uint96`);
  if (i.timeout <= 0n || i.timeout > MAX_UINT64) throw new DeskError(`timeout ${i.timeout} s must be 1 to 2^64 - 1`);
  const data = encodeDeployData({
    abi: checkRequestDeskAbi,
    bytecode: checkRequestDeskBytecode,
    args: [i.owner, i.worker, i.registry, i.fee, i.timeout],
  });
  const from = i.wallet.account.address;
  let gas: bigint;
  try {
    gas = gasLimitFor(await i.client.estimateGas({ account: from, data }));
  } catch (err) {
    const name = decodedName(err);
    const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
    throw new DeskError(`CheckRequestDesk deploy would fail${name ? ` (${name})` : ''}: ${msg}`, name, err);
  }
  const hash = await i.wallet.sendTransaction({ data, gas });
  const receipt = await i.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) {
    throw new DeskError(`CheckRequestDesk deploy tx ${hash} failed (status ${receipt.status})`);
  }
  return { address: getAddress(receipt.contractAddress), tx: txOf(hash, receipt) };
}

type WriteName = 'requestCheck' | 'fulfill' | 'reject' | 'refundExpired' | 'withdraw' | 'setFee' | 'setWorker';

/** Thin client over CheckRequestDesk. Writes are simulated first so custom errors surface by name. */
export class RequestDeskClient {
  constructor(
    readonly address: Address,
    readonly client: SpecfirstPublicClient,
    readonly wallet?: SpecfirstWalletClient,
  ) {}

  private read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address: this.address, abi: checkRequestDeskAbi, functionName, args } as never) as Promise<T>;
  }

  private async write(functionName: WriteName, args: readonly unknown[], value?: bigint): Promise<DeskTx & { receipt: TransactionReceipt }> {
    if (!this.wallet) throw new DeskError(`${functionName} needs a wallet client`);
    const call = {
      address: this.address,
      abi: checkRequestDeskAbi,
      functionName,
      args,
      account: this.wallet.account,
      ...(value !== undefined ? { value } : {}),
    } as never;
    try {
      const sim = await this.client.simulateContract(call);
      const gas = gasLimitFor(await this.client.estimateContractGas(call));
      const hash = await this.wallet.writeContract({ ...(sim as { request: object }).request, gas } as never);
      const receipt = await this.client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new DeskError(`${functionName} tx ${hash} reverted`);
      return { ...txOf(hash, receipt), receipt };
    } catch (err) {
      if (err instanceof DeskError) throw err;
      const name = decodedName(err);
      const msg = (err as { shortMessage?: string }).shortMessage ?? (err as Error).message;
      throw new DeskError(`${functionName} failed${name ? ` (${name})` : ''}: ${msg}`, name, err);
    }
  }

  private strip(out: DeskTx & { receipt: TransactionReceipt }): DeskTx {
    const { receipt: _receipt, ...tx } = out;
    return tx;
  }

  /**
   * Pays `value` (default: the current fee, read first) and returns the request id from the mined receipt:
   * the one CheckRequested event this desk emitted, not the simulation's return value.
   */
  async requestCheck(r: { subjectChainId: bigint; subject: Address; standardId: Hex }, value?: bigint): Promise<DeskTx & { id: bigint; fee: bigint }> {
    const fee = value ?? (await this.fee());
    const out = await this.write('requestCheck', [r.subjectChainId, r.subject, r.standardId], fee);
    const self = this.address.toLowerCase();
    const events = parseEventLogs({ abi: checkRequestDeskAbi, eventName: 'CheckRequested', logs: out.receipt.logs }).filter(
      (l) => l.address.toLowerCase() === self,
    );
    if (events.length !== 1) {
      throw new DeskError(`requestCheck tx ${out.hash}: expected one CheckRequested event from ${this.address} in the receipt, found ${events.length}`);
    }
    return { ...this.strip(out), id: events[0]!.args.id, fee };
  }

  async fulfill(id: bigint, attestationId: bigint): Promise<DeskTx> {
    return this.strip(await this.write('fulfill', [id, attestationId]));
  }

  /** `reason` is a short ASCII code (REJECT_REASONS) or an already encoded bytes32. */
  async reject(id: bigint, reason: string): Promise<DeskTx> {
    const code = /^0x[0-9a-fA-F]{64}$/.test(reason) ? (reason as Hex) : reasonCodeOf(reason);
    return this.strip(await this.write('reject', [id, code]));
  }

  async refundExpired(id: bigint): Promise<DeskTx> {
    return this.strip(await this.write('refundExpired', [id]));
  }

  async withdraw(to: Address): Promise<DeskTx & { amount: bigint }> {
    const amount = (await this.earned()) - (await this.withdrawn());
    const out = await this.write('withdraw', [to]);
    const self = this.address.toLowerCase();
    const ev = parseEventLogs({ abi: checkRequestDeskAbi, eventName: 'FeesWithdrawn', logs: out.receipt.logs }).find((l) => l.address.toLowerCase() === self);
    return { ...this.strip(out), amount: ev?.args.amount ?? amount };
  }

  async setFee(fee: bigint): Promise<DeskTx> {
    return this.strip(await this.write('setFee', [fee]));
  }

  async setWorker(worker: Address): Promise<DeskTx> {
    return this.strip(await this.write('setWorker', [worker]));
  }

  /** Reads one request; throws DeskError (UnknownRequest) for an id at or above requestCount(). */
  async requestOf(id: bigint): Promise<DeskRequest> {
    try {
      return await this.read<DeskRequest>('requestOf', [id]);
    } catch (err) {
      const name = decodedName(err);
      if (name === 'UnknownRequest') throw new DeskError(`no request with id ${id} (UnknownRequest)`, name, err);
      throw err;
    }
  }
  requestCount(): Promise<bigint> {
    return this.read('requestCount');
  }
  fee(): Promise<bigint> {
    return this.read('fee');
  }
  worker(): Promise<Address> {
    return this.read('worker');
  }
  owner(): Promise<Address> {
    return this.read('owner');
  }
  registry(): Promise<Address> {
    return this.read('registry');
  }
  timeout(): Promise<bigint> {
    return this.read('timeout');
  }
  earned(): Promise<bigint> {
    return this.read('earned');
  }
  withdrawn(): Promise<bigint> {
    return this.read('withdrawn');
  }
  escrowed(): Promise<bigint> {
    return this.read('escrowed');
  }

  /** Every setting and counter of the desk plus its balance. Eleven reads, one at a time. */
  async summary(): Promise<DeskSummary> {
    return {
      address: this.address,
      owner: await this.owner(),
      worker: await this.worker(),
      registry: await this.registry(),
      fee: await this.fee(),
      timeout: await this.timeout(),
      requestCount: await this.requestCount(),
      earned: await this.earned(),
      withdrawn: await this.withdrawn(),
      escrowed: await this.escrowed(),
      balance: await this.client.getBalance({ address: this.address }),
    };
  }
}
