import {
  concat,
  encodeDeployData,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseEther,
  toFunctionSelector,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainClients, SpecfirstPublicClient, SpecfirstWalletClient } from '../chain/client.js';
import { gasLimitFor, writeJson } from '../deploy/deploy.js';
import type { ContractArtifact } from '../deploy/artifacts.js';
import type { Spec } from '../spec/schema.js';
import { planRehearsal, type ActorRef, type NormalAction, type PlanStep, type RevertKind } from './plan.js';

export const REHEARSAL_JSON = 'rehearsal.json';
/** Gas limit for revert-expected txs. estimateGas fails on them and Monad charges the whole limit (plan 3.6). */
export const REVERT_GAS_LIMIT = 80_000n;

/** The vault surface (test/specfirst/IVault.sol). */
export const vaultAbi = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 amount)',
  'function setRewardRate(uint256 rate)',
  'function pause()',
  'function unpause()',
  'function balances(address user) view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function rewardRate() view returns (uint256)',
  'function paused() view returns (bool)',
  'function owner() view returns (address)',
  'event Deposit(address indexed user, uint256 amount)',
  'event Withdraw(address indexed user, uint256 amount)',
  'event RewardRateChanged(uint256 rate)',
  'event Paused(bool paused)',
]);

export const attackerAbi = parseAbi([
  'function execute(address target, bytes data, uint256 value) returns (bool ok, bytes ret)',
  'function lastReentryAttempted() view returns (bool)',
  'function lastReentrySucceeded() view returns (bool)',
]);

/** Custom error each revert kind is expected to hit, looked up by name in the deployed contract's ABI. */
export const DEFAULT_EXPECTED_ERRORS: Record<RevertKind, string> = {
  'unauthorized-set-reward-rate': 'Unauthorized',
  'unauthorized-pause': 'Unauthorized',
  'overdraw-withdraw': 'InsufficientBalance',
  'deposit-while-paused': 'PausedError',
  reentry: 'InsufficientBalance',
};

/** Which spec invariant each revert kind is evidence for (sample vault ids, plan 3.1). */
export const DEFAULT_REVERT_INVARIANTS: Record<RevertKind, string> = {
  'unauthorized-set-reward-rate': 'INV-5',
  'unauthorized-pause': 'INV-7',
  'overdraw-withdraw': 'INV-4',
  'deposit-while-paused': 'INV-6',
  reentry: 'INV-4',
};

export interface RehearsalActor {
  name: string;
  role: 'user' | 'owner' | 'attacker' | 'attacker-contract';
  address: Address;
}

/**
 * - reverted: status 0 and gasUsed < gasLimit (or, for reentry, the attacker's replay reverted).
 * - out-of-gas: status 0 with gasUsed == gasLimit. Not evidence of access control (plan 3.6).
 * - unexpected-success: the call went through.
 * - ok: a normal tx that succeeded. failed: a normal tx that did not.
 */
export type Verdict = 'ok' | 'failed' | 'reverted' | 'out-of-gas' | 'unexpected-success' | 'not-attempted';

export interface SelectorCheck {
  expectedError: string;
  expected: Hex | null;
  actual: Hex | null;
  match: boolean;
  /** "selector 미확인" when the revert data could not be obtained or the error is not in the ABI. */
  note?: string;
}

export interface RehearsalTx {
  n: number;
  label: string;
  from: Address;
  to: Address;
  hash: Hex;
  block: string;
  status: 'success' | 'reverted';
  gasUsed: string;
  gasLimit: string;
  expectRevert: false | 'status' | 'inner';
  revertKind?: RevertKind;
  invariantId?: string;
  verdict: Verdict;
  selector?: SelectorCheck | 'selector 미확인';
}

export interface RehearsalRecord {
  version: 1;
  chainId: number;
  target: Address;
  owner: Address;
  attackerContract: Address | null;
  actors: RehearsalActor[];
  /** How actor keys are derived, so leftover funds can be recovered from the deployer key alone. */
  keyDerivation: string;
  setupTxs: Array<{ label: string; hash: Hex; block: string }>;
  txs: RehearsalTx[];
  fromBlock: string;
  toBlock: string;
  summary: {
    normal: number;
    normalOk: number;
    expectRevert: number;
    reverted: number;
    outOfGas: number;
    unexpectedSuccess: number;
    selectorConfirmed: number;
    selectorUnconfirmed: number;
  };
  startedAt: string;
  finishedAt: string;
}

export interface RehearseInput {
  spec: Spec;
  clients: ChainClients;
  /** Deployer key: owner actor and funding source. */
  deployerKey: Hex;
  target: Address;
  /** ABI of the deployed contract, for expected error selectors. */
  targetAbi: Abi;
  /** Attacker artifact from test/specfirst/Attacker.sol. Required when spec.actors.attacker. */
  attacker?: ContractArtifact;
  runId: string;
  /** MON (wei) sent to each user and the attacker EOA for gas and deposits. Default 0.1. */
  fundWei?: bigint;
  /** Deposit unit in wei. Default 0.0001 MON. */
  unitWei?: bigint;
  /** Default 80,000. Tests lower it to force the out-of-gas classification. */
  revertGasLimit?: bigint;
  expectedErrors?: Partial<Record<RevertKind, string>>;
  revertInvariants?: Partial<Record<RevertKind, string>>;
  recordPath?: string;
  onTx?: (tx: RehearsalTx) => void;
}

/** keccak256(deployerKey || "specfirst-rehearsal:<runId>:<name>"). Deterministic per run and actor. */
export function deriveActorKey(deployerKey: Hex, runId: string, name: string): Hex {
  return keccak256(concat([deployerKey, toHex(`specfirst-rehearsal:${runId}:${name}`)]));
}

export function judgeRevertReceipt(r: Pick<TransactionReceipt, 'status' | 'gasUsed'>, gasLimit: bigint): Verdict {
  if (r.status === 'success') return 'unexpected-success';
  return r.gasUsed < gasLimit ? 'reverted' : 'out-of-gas';
}

interface ErrorWithData {
  data?: unknown;
  cause?: unknown;
  walk?: () => unknown;
}

/** First hex `data` found on the error or its causes: the raw revert data of an eth_call. */
export function revertDataOf(err: unknown): Hex | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const d = (cur as ErrorWithData).data;
    if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d as Hex;
    if (d && typeof d === 'object' && typeof (d as { data?: unknown }).data === 'string') return (d as { data: Hex }).data;
    cur = (cur as ErrorWithData).cause;
  }
  return null;
}

function errorSelector(abi: Abi, name: string): Hex | null {
  const e = abi.find((x) => x.type === 'error' && x.name === name) as
    | { name: string; inputs: ReadonlyArray<{ type: string }> }
    | undefined;
  if (!e) return null;
  return toFunctionSelector(`${e.name}(${e.inputs.map((i) => i.type).join(',')})`);
}

/**
 * Re-runs a call with eth_call and compares the revert selector with the expected custom error.
 * Returns "selector 미확인" when no revert data comes back (RPC strips it, or the call succeeded).
 */
export async function checkRevertSelector(
  client: SpecfirstPublicClient,
  call: { from: Address; to: Address; data: Hex; value?: bigint },
  abi: Abi,
  expectedError: string,
): Promise<SelectorCheck | 'selector 미확인'> {
  const expected = errorSelector(abi, expectedError);
  let data: Hex | null = null;
  try {
    await client.request({
      method: 'eth_call',
      params: [{ from: call.from, to: call.to, data: call.data, ...(call.value ? { value: toHex(call.value) } : {}) }, 'latest'],
    });
    return 'selector 미확인';
  } catch (err) {
    data = revertDataOf(err);
  }
  if (!data || data.length < 10) return 'selector 미확인';
  const actual = data.slice(0, 10) as Hex;
  if (!expected) return { expectedError, expected: null, actual, match: false, note: 'selector 미확인' };
  return { expectedError, expected, actual, match: actual.toLowerCase() === expected.toLowerCase() };
}

interface Actor {
  name: string;
  role: RehearsalActor['role'];
  wallet: SpecfirstWalletClient;
}

/**
 * Rehearsal (plan 3.6 item 2): actor keys from the deployer key, funding, the Attacker contract, then
 * spec.rehearsal.normalTx normal txs (gas = estimateGas x 1.2) and expectRevertTx revert-expected txs
 * (fixed gas 80,000, no estimateGas). Each revert-expected tx is re-run with eth_call for its selector.
 *
 * The reentry attempt goes through Attacker.execute, which swallows the vault's revert by design, so its
 * outer status is 1. It is judged by the attacker's own record of the replay (lastReentryAttempted and
 * not lastReentrySucceeded) and marked expectRevert "inner".
 */
export async function rehearse(input: RehearseInput): Promise<RehearsalRecord> {
  const { spec, clients, deployerKey, target, runId } = input;
  const client = clients.publicClient;
  const fundWei = input.fundWei ?? parseEther('0.1');
  const unit = input.unitWei ?? parseEther('0.0001');
  const revertGas = input.revertGasLimit ?? REVERT_GAS_LIMIT;
  const expectedErrors = { ...DEFAULT_EXPECTED_ERRORS, ...input.expectedErrors };
  const revertInvariants = { ...DEFAULT_REVERT_INVARIANTS, ...input.revertInvariants };
  const specIds = new Set(spec.invariants.map((i) => i.id));
  const startedAt = new Date().toISOString();

  const owner: Actor = { name: 'owner', role: 'owner', wallet: clients.wallet(deployerKey) };
  const onchainOwner = (await client.readContract({ address: target, abi: vaultAbi, functionName: 'owner' })) as Address;
  if (onchainOwner.toLowerCase() !== owner.wallet.account.address.toLowerCase()) {
    throw new Error(`vault owner ${onchainOwner} is not the deployer ${owner.wallet.account.address}; rehearsal needs the owner key`);
  }
  const users: Actor[] = Array.from({ length: spec.actors.users }, (_, i) => ({
    name: `user${i}`,
    role: 'user' as const,
    wallet: clients.wallet(deriveActorKey(deployerKey, runId, `user${i}`)),
  }));
  const attackerEoa: Actor | null = spec.actors.attacker
    ? { name: 'attacker', role: 'attacker', wallet: clients.wallet(deriveActorKey(deployerKey, runId, 'attacker')) }
    : null;
  if (spec.actors.attacker && !input.attacker) throw new Error('spec.actors.attacker is true but no Attacker artifact was given');

  const setupTxs: RehearsalRecord['setupTxs'] = [];
  const txs: RehearsalTx[] = [];
  let firstBlock: bigint | null = null;
  let lastBlock = 0n;

  const send = async (
    wallet: SpecfirstWalletClient,
    req: { to?: Address; data?: Hex; value?: bigint; gas?: bigint },
  ): Promise<{ hash: Hex; receipt: TransactionReceipt; gas: bigint }> => {
    let gas = req.gas;
    if (gas === undefined) {
      const est = await client.estimateGas({ account: wallet.account.address, to: req.to, data: req.data, value: req.value });
      gas = gasLimitFor(est);
    }
    const hash = await wallet.sendTransaction({ to: req.to ?? null, data: req.data, value: req.value, gas });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (firstBlock === null) firstBlock = receipt.blockNumber;
    if (receipt.blockNumber > lastBlock) lastBlock = receipt.blockNumber;
    return { hash, receipt, gas };
  };

  // Setup: fund actors, deploy and fund the Attacker contract. Not counted as rehearsal txs.
  for (const a of [...users, ...(attackerEoa ? [attackerEoa] : [])]) {
    const r = await send(owner.wallet, { to: a.wallet.account.address, value: fundWei });
    setupTxs.push({ label: `fund ${a.name}`, hash: r.hash, block: r.receipt.blockNumber.toString() });
  }
  let attackerContract: Address | null = null;
  if (attackerEoa && input.attacker) {
    const data = encodeDeployData({ abi: input.attacker.abi, bytecode: input.attacker.bytecode });
    const r = await send(attackerEoa.wallet, { data });
    if (r.receipt.status !== 'success' || !r.receipt.contractAddress) throw new Error(`Attacker deploy failed: ${r.hash}`);
    attackerContract = r.receipt.contractAddress;
    setupTxs.push({ label: 'deploy Attacker', hash: r.hash, block: r.receipt.blockNumber.toString() });
    const f = await send(owner.wallet, { to: attackerContract, value: unit * 32n });
    setupTxs.push({ label: 'fund Attacker', hash: f.hash, block: f.receipt.blockNumber.toString() });
  }

  const actorOf = (ref: ActorRef): Actor => (ref.role === 'owner' ? owner : ref.role === 'attacker' ? attackerEoa! : users[ref.index]!);
  const balanceOf = async (addr: Address) =>
    (await client.readContract({ address: target, abi: vaultAbi, functionName: 'balances', args: [addr] })) as bigint;
  const execute = (data: Hex, value = 0n) =>
    encodeFunctionData({ abi: attackerAbi, functionName: 'execute', args: [target, data, value] });

  const record = (tx: Omit<RehearsalTx, 'n'>) => {
    const full = { n: txs.length + 1, ...tx };
    txs.push(full);
    input.onTx?.(full);
  };

  const runNormal = async (a: NormalAction) => {
    let actor: Actor;
    let to: Address = target;
    let data: Hex;
    let value: bigint | undefined;
    let label: string;
    switch (a.kind) {
      case 'deposit':
        actor = actorOf(a.actor);
        value = unit * BigInt(a.units);
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'deposit' });
        label = `${actor.name} deposit ${value}`;
        break;
      case 'withdraw': {
        actor = actorOf(a.actor);
        const amount = ((await balanceOf(actor.wallet.account.address)) * BigInt(a.quarters)) / 4n;
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [amount] });
        label = `${actor.name} withdraw ${amount}`;
        break;
      }
      case 'set-reward-rate':
        actor = owner;
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'setRewardRate', args: [BigInt(a.rate)] });
        label = `owner setRewardRate ${a.rate}`;
        break;
      case 'pause':
      case 'unpause':
        actor = owner;
        data = encodeFunctionData({ abi: vaultAbi, functionName: a.kind });
        label = `owner ${a.kind}`;
        break;
      case 'attacker-deposit': {
        actor = attackerEoa!;
        to = attackerContract!;
        const v = unit * BigInt(a.units);
        data = execute(encodeFunctionData({ abi: vaultAbi, functionName: 'deposit' }), v);
        label = `attacker contract deposit ${v}`;
        break;
      }
      case 'attacker-withdraw': {
        actor = attackerEoa!;
        to = attackerContract!;
        const amount = (await balanceOf(attackerContract!)) / 4n;
        data = execute(encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [amount] }));
        label = `attacker contract withdraw ${amount} (replay within balance)`;
        break;
      }
    }
    const r = await send(actor.wallet, { to, data, value });
    record({
      label,
      from: actor.wallet.account.address,
      to,
      hash: r.hash,
      block: r.receipt.blockNumber.toString(),
      status: r.receipt.status,
      gasUsed: r.receipt.gasUsed.toString(),
      gasLimit: r.gas.toString(),
      expectRevert: false,
      verdict: r.receipt.status === 'success' ? 'ok' : 'failed',
    });
  };

  const runRevert = async (kind: RevertKind) => {
    const invariantId = specIds.has(revertInvariants[kind]) ? revertInvariants[kind] : undefined;
    const expectedError = expectedErrors[kind];
    if (kind === 'reentry') {
      // Withdraw a bit more than half the attacker's balance: the outer call is legitimate, the replay
      // from the receive hook would overdraw. Correct code rejects the replay; the planted bug pays it.
      const actor = attackerEoa!;
      const bal = await balanceOf(attackerContract!);
      const amount = bal / 2n + 1n;
      const inner = encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [amount] });
      const r = await send(actor.wallet, { to: attackerContract!, data: execute(inner) });
      const [attempted, succeeded] = await Promise.all([
        client.readContract({ address: attackerContract!, abi: attackerAbi, functionName: 'lastReentryAttempted' }),
        client.readContract({ address: attackerContract!, abi: attackerAbi, functionName: 'lastReentrySucceeded' }),
      ]);
      let verdict: Verdict;
      if (r.receipt.status !== 'success') verdict = r.receipt.gasUsed < r.gas ? 'failed' : 'out-of-gas';
      else if (!attempted) verdict = 'not-attempted';
      else verdict = succeeded ? 'unexpected-success' : 'reverted';
      // The replay is the same withdraw from the attacker contract against the post-state.
      const selector = await checkRevertSelector(client, { from: attackerContract!, to: target, data: inner }, input.targetAbi, expectedError);
      record({
        label: `attacker contract reentry attempt, withdraw ${amount} of ${bal} replayed once`,
        from: actor.wallet.account.address,
        to: attackerContract!,
        hash: r.hash,
        block: r.receipt.blockNumber.toString(),
        status: r.receipt.status,
        gasUsed: r.receipt.gasUsed.toString(),
        gasLimit: r.gas.toString(),
        expectRevert: 'inner',
        revertKind: kind,
        ...(invariantId ? { invariantId } : {}),
        verdict,
        selector,
      });
      return;
    }

    let actor: Actor;
    let data: Hex;
    let value: bigint | undefined;
    let label: string;
    switch (kind) {
      case 'unauthorized-set-reward-rate':
        actor = users[1 % users.length]!;
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'setRewardRate', args: [1n] });
        label = `${actor.name} setRewardRate 1 (not owner)`;
        break;
      case 'unauthorized-pause':
        actor = attackerEoa ?? users[0]!;
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'pause' });
        label = `${actor.name} pause (not owner)`;
        break;
      case 'overdraw-withdraw': {
        actor = users[0]!;
        const amount = (await balanceOf(actor.wallet.account.address)) + 1n;
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'withdraw', args: [amount] });
        label = `${actor.name} withdraw ${amount} (balance + 1)`;
        break;
      }
      case 'deposit-while-paused':
        actor = users[2 % users.length]!;
        value = unit;
        data = encodeFunctionData({ abi: vaultAbi, functionName: 'deposit' });
        label = `${actor.name} deposit ${value} while paused`;
        break;
    }
    const r = await send(actor.wallet, { to: target, data, value, gas: revertGas });
    const selector = await checkRevertSelector(
      client,
      { from: actor.wallet.account.address, to: target, data, value },
      input.targetAbi,
      expectedError,
    );
    record({
      label,
      from: actor.wallet.account.address,
      to: target,
      hash: r.hash,
      block: r.receipt.blockNumber.toString(),
      status: r.receipt.status,
      gasUsed: r.receipt.gasUsed.toString(),
      gasLimit: r.gas.toString(),
      expectRevert: 'status',
      revertKind: kind,
      ...(invariantId ? { invariantId } : {}),
      verdict: judgeRevertReceipt(r.receipt, r.gas),
      selector,
    });
  };

  const steps: PlanStep[] = planRehearsal({
    users: spec.actors.users,
    normal: spec.rehearsal.normalTx,
    revert: spec.rehearsal.expectRevertTx,
    attacker: spec.actors.attacker,
  });
  for (const s of steps) {
    if (s.expectRevert) await runRevert(s.kind);
    else await runNormal(s.action);
  }

  const reverts = txs.filter((t) => t.expectRevert);
  const selectorConfirmed = reverts.filter((t) => typeof t.selector === 'object' && t.selector.match).length;
  const actors: RehearsalActor[] = [
    { name: 'owner', role: 'owner', address: owner.wallet.account.address },
    ...users.map((u) => ({ name: u.name, role: 'user' as const, address: u.wallet.account.address })),
    ...(attackerEoa ? [{ name: 'attacker', role: 'attacker' as const, address: attackerEoa.wallet.account.address }] : []),
    ...(attackerContract ? [{ name: 'attacker-contract', role: 'attacker-contract' as const, address: attackerContract }] : []),
  ];
  const result: RehearsalRecord = {
    version: 1,
    chainId: clients.chain.id,
    target,
    owner: owner.wallet.account.address,
    attackerContract,
    actors,
    keyDerivation: 'keccak256(deployerKey || utf8("specfirst-rehearsal:<runId>:<actor name>"))',
    setupTxs,
    txs,
    fromBlock: (firstBlock ?? 0n).toString(),
    toBlock: lastBlock.toString(),
    summary: {
      normal: txs.length - reverts.length,
      normalOk: txs.filter((t) => !t.expectRevert && t.verdict === 'ok').length,
      expectRevert: reverts.length,
      reverted: reverts.filter((t) => t.verdict === 'reverted').length,
      outOfGas: reverts.filter((t) => t.verdict === 'out-of-gas').length,
      unexpectedSuccess: reverts.filter((t) => t.verdict === 'unexpected-success').length,
      selectorConfirmed,
      selectorUnconfirmed: reverts.length - selectorConfirmed,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  if (input.recordPath) await writeJson(input.recordPath, result);
  return result;
}

/** Address of an actor key, for callers that only kept the derivation inputs. */
export function actorAddress(deployerKey: Hex, runId: string, name: string): Address {
  return privateKeyToAccount(deriveActorKey(deployerKey, runId, name)).address;
}
