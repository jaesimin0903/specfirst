import { getAddress, isAddress } from 'viem';

/*
 * The one place the web names CheckSubscriptions (ADR 0006). The ABI is re-exported from @specfirst/core/subs;
 * every other module imports it from here. Below it, web-only helpers. Client-safe.
 */

// The ABI comes from the contract build in @specfirst/core, so the web cannot drift from the deployed contract.
export { checkSubscriptionsAbi } from '@specfirst/core/subs';

/** Subscription ids are a zero based index, as in the registry and the desk. */
export const FIRST_SUBSCRIPTION_ID = 0n;
/** The lengths the subscribe box offers. */
export const DAY_CHOICES = [1, 7, 30] as const;

/** NEXT_PUBLIC_SPECFIRST_SUBS_10143, checksummed; null when unset or not an address ("not deployed yet"). */
export function subsAddress(env: Record<string, string | undefined> = process.env): `0x${string}` | null {
  const v = env.NEXT_PUBLIC_SPECFIRST_SUBS_10143?.trim();
  return v && isAddress(v) ? getAddress(v) : null;
}
