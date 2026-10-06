import { toFunctionSelector, type Address, type Hex } from 'viem';
import { isNodeError, isRateLimited, isTransportFailure } from '../chain/transport.js';
import { pushedSelectors, type IdentityClient, type ImplementationIdentity } from './identity.js';
import {
  ASYNC_REDEEM_REQUEST_FUNCTIONS,
  ERC7540_INTERFACE_IDS,
  MISSING_PRECOMPILE_NOTE,
  maxZeroNote,
  type AsyncRedeemEvidence,
  type StandardPropertyResult,
  type VaultTrait,
} from './report.js';

/*
 * Vault traits (docs/adr/0003, "Vault traits"): capabilities a curator recognises, recorded with their evidence.
 * They add context to a report and never change a property's status.
 */

const supportsInterfaceAbi = [
  { type: 'function', name: 'supportsInterface', stateMutability: 'view', inputs: [{ type: 'bytes4' }], outputs: [{ type: 'bool' }] },
] as const;

const TOO_MANY_REJECTS = /^`vm\.assume` rejected too many inputs \(\d+ allowed\)/;

type ResultLite = Pick<StandardPropertyResult, 'id' | 'status' | 'reason'>;

/**
 * What the run showed about exits. exits-rejected: deposit worked (upstream deposit or sf-maxDeposit-honored
 * passed) while withdraw and redeem rejected every input: the upstream withdraw and redeem properties ran out of
 * inputs, and the sf- calls reverted within the advertised max or the max was 0 for every test user.
 * not-exercised: withdraw, redeem and both sf- exit properties stopped at a Monad precompile the fork lacks, so
 * the run says nothing either way. null otherwise, including whenever a withdraw or redeem went through.
 */
export function exitEvidenceOf(results: readonly ResultLite[]): AsyncRedeemEvidence['run'] | null {
  const byId = new Map(results.map((r) => [r.id, r]));
  const status = (id: string) => byId.get(id)?.status;
  const reason = (id: string) => byId.get(id)?.reason ?? '';
  const exits = ['withdraw', 'redeem', 'sf-maxWithdraw-honored', 'sf-maxRedeem-honored'];
  if (exits.every((id) => status(id) === 'inconclusive' && reason(id).startsWith(MISSING_PRECOMPILE_NOTE))) return 'not-exercised';
  const depositWorked = status('deposit') === 'pass' || status('sf-maxDeposit-honored') === 'pass';
  const rejected = (id: string) => status(id) === 'inconclusive' && TOO_MANY_REJECTS.test(reason(id));
  const blocked = (id: string, action: string, maxName: string) =>
    (status(id) === 'fail' && reason(id).startsWith(`${action}(`) && reason(id).includes(') reverted with ')) ||
    (status(id) === 'not_applicable' && reason(id) === maxZeroNote(maxName));
  const withdrawBlocked = rejected('withdraw') && blocked('sf-maxWithdraw-honored', 'withdraw', 'maxWithdraw');
  const redeemBlocked = rejected('redeem') && blocked('sf-maxRedeem-honored', 'redeem', 'maxRedeem');
  return depositWorked && withdrawBlocked && redeemBlocked ? 'exits-rejected' : null;
}

/** The request functions whose selector the code pushes, in ASYNC_REDEEM_REQUEST_FUNCTIONS order. */
export function requestFunctionsIn(code: Hex): AsyncRedeemEvidence['requestFunctions'] {
  const pushed = pushedSelectors(code);
  return ASYNC_REDEEM_REQUEST_FUNCTIONS.filter((sig) => pushed.has(toFunctionSelector(sig)));
}

/** A failure of the RPC rather than an answer of the contract: thrown, never read as "no ERC-165". */
function rpcFailure(err: unknown): boolean {
  return isTransportFailure(err) || isRateLimited(err) || isNodeError(err);
}

/**
 * supportsInterface for the ERC-7540 ids, or null when the contract does not implement ERC-165: it must answer
 * true for 0x01ffc9a7 and false for 0xffffffff (the EIP-165 detection steps). A revert or a malformed answer is
 * the contract's answer; an RPC failure is thrown.
 */
export async function erc7540InterfacesOf(client: IdentityClient, address: Address, blockNumber: bigint): Promise<AsyncRedeemEvidence['erc165']> {
  const supports = async (id: Hex): Promise<boolean | null> => {
    try {
      return (await client.readContract({ address, abi: supportsInterfaceAbi, functionName: 'supportsInterface', args: [id], blockNumber })) === true;
    } catch (err) {
      if (rpcFailure(err)) throw err;
      return null;
    }
  };
  if ((await supports('0x01ffc9a7')) !== true || (await supports('0xffffffff')) !== false) return null;
  return {
    asyncRedeem: (await supports(ERC7540_INTERFACE_IDS.asyncRedeem)) === true,
    asyncDeposit: (await supports(ERC7540_INTERFACE_IDS.asyncDeposit)) === true,
    operator: (await supports(ERC7540_INTERFACE_IDS.operator)) === true,
  };
}

/**
 * Traits of a checked vault. async-redeem needs a request function in the code (the implementation behind a
 * proxy, else the vault) and either a run that saw deposits work while every withdraw and redeem was refused,
 * or a run that could not exercise exits at all together with an ERC-165 answer of true for asynchronous
 * redemption. A run in which a withdraw or redeem went through rules it out whatever the code holds. Chain
 * reads happen only when the run already points that way, so most checks add none.
 */
export async function detectTraits(
  client: IdentityClient,
  address: Address,
  identity: Pick<ImplementationIdentity, 'implementation'>,
  results: readonly ResultLite[],
  blockNumber: bigint,
): Promise<VaultTrait[]> {
  const run = exitEvidenceOf(results);
  if (!run) return [];
  const codeAddress = identity.implementation?.address ?? address;
  const code = (await client.getCode({ address: codeAddress, blockNumber })) ?? '0x';
  const requestFunctions = requestFunctionsIn(code);
  if (requestFunctions.length === 0) return [];
  const erc165 = await erc7540InterfacesOf(client, address, blockNumber);
  if (run === 'not-exercised' && !erc165?.asyncRedeem) return [];
  return [{ id: 'async-redeem', evidence: { codeAddress, requestFunctions, erc165, run } }];
}
