import { getAddress, isAddress, parseAbi } from 'viem';

/*
 * CheckSubscriptions on Monad testnet (ADR 0006, "Interfaces"), written from the ADR until the contract build is
 * exported from @specfirst/core. test/subs-contract.test.ts pins every function and event signature, so the swap
 * shows up there if the two disagree. Return types of the money views do not change their selectors or how a
 * 32-byte word decodes. Client-safe.
 */

export const checkSubscriptionsAbi = parseAbi([
  'struct Subscription { address subscriber; uint64 subjectChainId; address subject; bytes32 standardId; uint96 feePerDay; uint64 startsAt; uint64 endsAt; uint96 paid; uint96 settled; bool cancelled; }',
  'constructor(address owner, uint96 feePerDay)',
  'function subscribe(uint64 subjectChainId, address subject, bytes32 standardId, uint32 days_) payable returns (uint256 id)',
  'function extend(uint256 id, uint32 days_) payable',
  'function cancel(uint256 id)',
  'function settle(uint256[] ids)',
  'function withdraw(address to)',
  'function setFeePerDay(uint96 feePerDay)',
  'function subscriptionOf(uint256 id) view returns (Subscription)',
  'function subscriptionCount() view returns (uint256)',
  'function isActive(uint256 id) view returns (bool)',
  'function feePerDay() view returns (uint96)',
  'function owner() view returns (address)',
  'function earned() view returns (uint256)',
  'function withdrawn() view returns (uint256)',
  'function escrowed() view returns (uint256)',
  'event Subscribed(uint256 indexed id, address indexed subscriber, uint64 subjectChainId, address indexed subject, bytes32 standardId, uint32 days_, uint96 paid, uint64 endsAt)',
  'event Extended(uint256 indexed id, uint32 days_, uint96 paid, uint64 endsAt)',
  'event Cancelled(uint256 indexed id, uint96 refund)',
  'event Settled(uint256 indexed id, uint96 amount)',
  'event FeesWithdrawn(address indexed to, uint96 amount)',
  'event FeePerDaySet(uint96 feePerDay)',
  // Custom errors as CheckSubscriptions.sol declares them, so a simulated revert reads as its name.
  'error NotOwner()',
  'error NotSubscriber(uint256 id)',
  'error ZeroAddress()',
  'error ZeroChainId()',
  'error EmptyStandardId()',
  'error BadDays(uint32 days_)',
  'error WrongValue(uint256 sent, uint256 expected)',
  'error PaidOverflow(uint256 id, uint256 paid)',
  'error UnknownSubscription(uint256 id)',
  'error AlreadyCancelled(uint256 id)',
  'error NothingToWithdraw()',
  'error TransferFailed(address to, uint256 amount)',
  'error Reentrancy()',
]);

/** Subscription ids are a zero based index, as in the registry and the desk. */
export const FIRST_SUBSCRIPTION_ID = 0n;
export const SECONDS_PER_DAY = 86_400n;
export const MIN_DAYS = 1;
export const MAX_DAYS = 365;
/** The lengths the subscribe box offers. */
export const DAY_CHOICES = [1, 7, 30] as const;

/** NEXT_PUBLIC_SPECFIRST_SUBS_10143, checksummed; null when unset or not an address ("not deployed yet"). */
export function subsAddress(env: Record<string, string | undefined> = process.env): `0x${string}` | null {
  const v = env.NEXT_PUBLIC_SPECFIRST_SUBS_10143?.trim();
  return v && isAddress(v) ? getAddress(v) : null;
}
