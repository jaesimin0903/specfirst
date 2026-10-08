import { getAddress, isAddress, type Address } from 'viem';

export class InputError extends Error {}

/**
 * A vault address as an agent may type it: 0x and 40 hex digits, all lower case, all upper case, or mixed case with a
 * valid EIP-55 checksum. Mixed case with a wrong checksum is refused, since it usually means a mistyped digit. Returns
 * the checksummed form.
 */
export function parseVaultAddress(input: string): Address {
  const a = input.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new InputError(`"${input}" is not an address: expected 0x followed by 40 hex digits`);
  const body = a.slice(2);
  const oneCase = body === body.toLowerCase() || body === body.toUpperCase();
  if (!oneCase && !isAddress(a, { strict: true })) {
    throw new InputError(`${a} has mixed case but its EIP-55 checksum does not match (expected ${getAddress(a)}); check the address for a mistyped digit`);
  }
  return getAddress(a.toLowerCase());
}

/** "0xD793..dA5E" */
export function shortAddress(a: string): string {
  return `${a.slice(0, 6)}..${a.slice(-4)}`;
}
