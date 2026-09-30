import { getAddress, isAddress } from 'viem';
import { DEFAULT_ATTESTATION_REGISTRY, ERC4626_STANDARD_ID } from '../board/attestations';

/*
 * Chains, addresses and links of the request flow. Client-safe: no Node imports. Server code reads the env at
 * request time; client components get the desk address as a prop from the page, so a redeploy of the desk only
 * needs a restart, not a rebuild.
 */

/** Where CheckRequestDesk and CheckAttestationRegistry live. */
export const DESK_CHAIN_ID = 10143;
/** The chain whose vaults the desk checks. */
export const SUBJECT_CHAIN_ID = 143;
export const SUBJECT_CHAIN_NAME = 'Monad mainnet';
export const DESK_CHAIN_NAME = 'Monad testnet';
export const STANDARD = 'erc4626';
/** keccak256("erc4626"), the standardId requestCheck takes and the registry keys attestations by. */
export const STANDARD_ID = ERC4626_STANDARD_ID as `0x${string}`;
/** Properties in one erc4626 check: 26 from a16z/erc4626-tests and 4 of Specfirst's own. */
export const PROPERTY_COUNT = 30;
export const UPSTREAM_PROPERTY_COUNT = 26;

export const DEFAULT_TESTNET_RPC = 'https://testnet-rpc.monad.xyz';
export const DEFAULT_MAINNET_RPC = 'https://rpc.monad.xyz';
export const TESTNET_EXPLORER = 'https://testnet.monadscan.com';
export const DEFAULT_FAUCET_URL = 'https://faucet.monad.xyz';

/** NEXT_PUBLIC_SPECFIRST_DESK_10143, checksummed; null when unset or not an address ("desk not deployed"). */
export function deskAddress(env: Record<string, string | undefined> = process.env): `0x${string}` | null {
  const v = env.NEXT_PUBLIC_SPECFIRST_DESK_10143?.trim();
  return v && isAddress(v) ? getAddress(v) : null;
}

/** RPC for Monad testnet, used by the server and by the browser (burner wallet, receipts). */
export function testnetRpc(env: Record<string, string | undefined> = process.env): string {
  return env.NEXT_PUBLIC_MONAD_RPC?.trim() || DEFAULT_TESTNET_RPC;
}

/** RPC for the subject chain, server only (pre-checks). */
export function mainnetRpc(env: Record<string, string | undefined> = process.env): string {
  return env.SPECFIRST_MAINNET_RPC?.trim() || DEFAULT_MAINNET_RPC;
}

export function faucetUrl(env: Record<string, string | undefined> = process.env): string {
  return env.NEXT_PUBLIC_MONAD_FAUCET_URL?.trim() || DEFAULT_FAUCET_URL;
}

export function testnetTxUrl(hash: string): string {
  return `${TESTNET_EXPLORER}/tx/${hash}`;
}

export function testnetAddressUrl(address: string): string {
  return `${TESTNET_EXPLORER}/address/${address}`;
}

/** Parameters for wallet_addEthereumChain (EIP-3085). */
export function addChainParams(rpc: string) {
  return {
    chainId: `0x${DESK_CHAIN_ID.toString(16)}`,
    chainName: 'Monad Testnet',
    nativeCurrency: { name: 'Monad', symbol: 'MON', decimals: 18 },
    rpcUrls: [rpc],
    blockExplorerUrls: [TESTNET_EXPLORER],
  };
}

/** CheckAttestationRegistry on Monad testnet, the same one the board reads. */
export function registryAddress(env: Record<string, string | undefined> = process.env): `0x${string}` {
  const v = env.SPECFIRST_BOARD_REGISTRY?.trim();
  return (v && isAddress(v) ? getAddress(v) : getAddress(DEFAULT_ATTESTATION_REGISTRY)) as `0x${string}`;
}
