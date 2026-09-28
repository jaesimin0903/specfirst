import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { encodeDeployData, getAddress, keccak256, type Abi, type AbiParameter, type Address, type Hex } from 'viem';
import type { SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import type { Spec } from '../spec/schema.js';
import { forgeBuild, readArtifact, type ContractArtifact } from './artifacts.js';

/** CLI exit code for any deploy failure (plan 3.10). */
export const DEPLOY_FAILED_EXIT_CODE = 12;
/** EIP-7825 per-transaction gas cap. Deploys at or above it are refused (plan 3.6 item 1). */
export const TX_GAS_CAP = 16_777_216n;
export const DEPLOY_JSON = 'deploy.json';

export class DeployError extends Error {
  readonly exitCode = DEPLOY_FAILED_EXIT_CODE;
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'DeployError';
  }
}

export interface DeployRecord {
  version: 1;
  chainId: number;
  contract: { name: string; sourceFile: string };
  address: Address;
  deployer: Address;
  constructorArgs: unknown[];
  txHash: Hex;
  blockNumber: string;
  /** keccak256 of eth_getCode at the deploy address. Same value the registry reads as target.codehash. */
  codeHash: Hex;
  gasUsed: string;
  gasLimit: string;
  gasEstimate: string;
  /** Directory whose sources were built (a run worktree or the project). */
  sourceDir: string;
  /** Commit the sources were checked out from, when known. */
  commit?: string;
  deployedAt: string;
}

/** 1.2x, rounded up. */
export function withMargin(gas: bigint): bigint {
  return (gas * 12n + 9n) / 10n;
}

/** Gas limit policy for normal transactions: estimate x 1.2, strictly below the per-tx cap. */
export function gasLimitFor(estimate: bigint): bigint {
  const limit = withMargin(estimate);
  if (limit >= TX_GAS_CAP) {
    throw new DeployError(`gas limit ${limit} (estimate ${estimate} x 1.2) is not below the per-tx cap ${TX_GAS_CAP}`);
  }
  return limit;
}

/**
 * Replaces "$DEPLOYER" with the deployer address and turns numbers into bigint where the constructor
 * input is an integer type, so viem can ABI-encode spec values as written in YAML.
 */
export function resolveConstructorArgs(abi: Abi, raw: ReadonlyArray<string | number | boolean>, deployer: Address): unknown[] {
  const ctor = abi.find((x) => x.type === 'constructor') as { inputs: readonly AbiParameter[] } | undefined;
  const inputs = ctor?.inputs ?? [];
  if (inputs.length !== raw.length) {
    throw new DeployError(`constructor takes ${inputs.length} argument(s), spec contract.constructorArgs has ${raw.length}`);
  }
  return raw.map((v, i) => {
    const value = v === '$DEPLOYER' ? deployer : v;
    const type = inputs[i]!.type;
    if (/^u?int\d*$/.test(type) && (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)))) {
      return BigInt(value);
    }
    return value;
  });
}

export interface DeployContractInput {
  spec: Spec;
  /** Worktree (or project dir) holding the sources to build. */
  worktreeOrProjectDir: string;
  client: SpecfirstPublicClient;
  walletClient: SpecfirstWalletClient;
  /** forge out dir. Default <worktreeOrProjectDir>/out. Built unless `build` is false. */
  outDir?: string;
  build?: boolean;
  forgeBin?: string;
  commit?: string;
  /** Writes deploy.json here when given. */
  recordPath?: string;
}

export interface DeployResult {
  record: DeployRecord;
  artifact: ContractArtifact;
  outDir: string;
}

/**
 * Builds with forge, deploys spec.contract from the forge artifact with gas = estimateGas x 1.2
 * (< 16,777,216), waits for the receipt and records deploy.json. Every failure is a DeployError (exit 12).
 */
export async function deployContract(input: DeployContractInput): Promise<DeployResult> {
  const { spec, worktreeOrProjectDir: dir, client, walletClient } = input;
  const outDir = input.outDir ?? path.join(dir, 'out');
  const sourceFile = spec.contract.path ?? `${spec.contract.name}.sol`;
  try {
    if (input.build !== false) await forgeBuild(dir, outDir, input.forgeBin);
  } catch (err) {
    const out = (err as { output?: string }).output ?? '';
    throw new DeployError(`${(err as Error).message}${out ? `\n${out.slice(-2000)}` : ''}`, err);
  }

  let artifact: ContractArtifact;
  try {
    artifact = await readArtifact(outDir, sourceFile, spec.contract.name);
  } catch (err) {
    throw new DeployError((err as Error).message, err);
  }
  const deployer = walletClient.account.address;
  const args = resolveConstructorArgs(artifact.abi, spec.contract.constructorArgs, deployer);

  try {
    const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
    const gasEstimate = await client.estimateGas({ account: deployer, data });
    const gas = gasLimitFor(gasEstimate);
    const txHash = await walletClient.sendTransaction({ data, gas });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success' || !receipt.contractAddress) {
      throw new DeployError(`deploy tx ${txHash} failed (status ${receipt.status}, gasUsed ${receipt.gasUsed} of ${gas})`);
    }
    const code = await client.getCode({ address: receipt.contractAddress });
    if (!code || code === '0x') throw new DeployError(`no code at ${receipt.contractAddress} after deploy tx ${txHash}`);
    const record: DeployRecord = {
      version: 1,
      chainId: client.chain.id,
      contract: { name: spec.contract.name, sourceFile },
      address: getAddress(receipt.contractAddress),
      deployer,
      constructorArgs: args.map((a) => (typeof a === 'bigint' ? a.toString() : a)),
      txHash,
      blockNumber: receipt.blockNumber.toString(),
      codeHash: keccak256(code),
      gasUsed: receipt.gasUsed.toString(),
      gasLimit: gas.toString(),
      gasEstimate: gasEstimate.toString(),
      sourceDir: dir,
      ...(input.commit ? { commit: input.commit } : {}),
      deployedAt: new Date().toISOString(),
    };
    if (input.recordPath) await writeJson(input.recordPath, record);
    return { record, artifact, outDir };
  } catch (err) {
    if (err instanceof DeployError) throw err;
    throw new DeployError(`deploy failed: ${(err as { shortMessage?: string }).shortMessage ?? (err as Error).message}`, err);
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}
