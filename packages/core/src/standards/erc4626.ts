import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** A property of a third-party standard suite: the upstream test that checks it and what it asserts. */
export interface StandardProperty {
  /** Upstream forge test function, without parentheses. */
  test: string;
  /** Stable id used in reports. */
  id: string;
  /** One line, English. */
  description: string;
}

export interface PinnedRepo {
  repo: string;
  commit: string;
}

/**
 * a16z/erc4626-tests at a fixed commit (AGPL-3.0). Fetched into the cache at run time and never
 * vendored into this repository (docs/adr/0003).
 */
export const ERC4626_UPSTREAM: PinnedRepo = {
  repo: 'https://github.com/a16z/erc4626-tests',
  commit: 'ac485460e014f22807c1ff687e0b4dc3af96ee40',
};

/** forge-std v1.16.2, the same version packages/contracts builds with. */
export const FORGE_STD_PIN: PinnedRepo & { tag: string } = {
  repo: 'https://github.com/foundry-rs/forge-std',
  tag: 'v1.16.2',
  commit: 'bf647bd6046f2f7da30d0c2bf435e5c76a780c1b',
};

/** Path of the harness inside the cached Foundry workspace, also forge's --match-path. */
export const ERC4626_HARNESS_PATH = 'test/SpecfirstERC4626.t.sol';
/** Specfirst's own properties (MIT, not derived from upstream) inside the workspace. */
export const ERC4626_SF_PROPERTIES_PATH = 'test/SpecfirstMaxHonored.t.sol';
/** Test contracts a check runs: the upstream suite through the harness, and Specfirst's own properties. */
export const ERC4626_CHECK_CONTRACTS = ['SpecfirstERC4626Test', 'SpecfirstMaxHonored'] as const;
/** Positive control (BrokenVault under the same harness) inside the workspace. */
export const ERC4626_CONTROL_PATH = 'test/SpecfirstERC4626Control.t.sol';
export const ERC4626_CONTROL_VAULT_PATH = 'src/BrokenVault.sol';

/**
 * Solidity sources shipped with this package under src/standards/erc4626. Resolved from the package
 * root so it works from src (vitest) and from dist (built CLI): both sit two levels below it.
 */
export function erc4626SourceFile(
  name: 'SpecfirstERC4626.t.sol' | 'SpecfirstMaxHonored.t.sol' | 'control/SpecfirstERC4626Control.t.sol' | 'control/BrokenVault.sol',
): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, '..', '..', 'src', 'standards', 'erc4626', name);
}

/** The 26 tests of ERC4626.test.sol at ERC4626_UPSTREAM.commit, in upstream order. */
export const ERC4626_PROPERTIES: readonly StandardProperty[] = [
  { test: 'test_asset', id: 'asset', description: 'asset() does not revert' },
  { test: 'test_totalAssets', id: 'totalAssets', description: 'totalAssets() does not revert' },
  { test: 'test_convertToShares', id: 'convertToShares', description: 'convertToShares gives the same result for any caller' },
  { test: 'test_convertToAssets', id: 'convertToAssets', description: 'convertToAssets gives the same result for any caller' },
  { test: 'test_maxDeposit', id: 'maxDeposit', description: 'maxDeposit does not revert' },
  { test: 'test_previewDeposit', id: 'previewDeposit', description: 'deposit mints at least the shares previewDeposit quoted' },
  { test: 'test_deposit', id: 'deposit', description: 'deposit moves assets from the caller, credits shares to the receiver and spends allowance' },
  { test: 'test_maxMint', id: 'maxMint', description: 'maxMint does not revert' },
  { test: 'test_previewMint', id: 'previewMint', description: 'mint pulls at most the assets previewMint quoted' },
  { test: 'test_mint', id: 'mint', description: 'mint moves assets from the caller, credits shares to the receiver and spends allowance' },
  { test: 'test_maxWithdraw', id: 'maxWithdraw', description: 'maxWithdraw does not revert' },
  { test: 'test_previewWithdraw', id: 'previewWithdraw', description: 'withdraw burns at most the shares previewWithdraw quoted' },
  { test: 'test_withdraw', id: 'withdraw', description: 'withdraw burns owner shares, pays the receiver and spends share allowance' },
  { test: 'test_withdraw_zero_allowance', id: 'withdraw-zero-allowance', description: 'withdraw on behalf of an owner without allowance reverts' },
  { test: 'test_maxRedeem', id: 'maxRedeem', description: 'maxRedeem does not revert' },
  { test: 'test_previewRedeem', id: 'previewRedeem', description: 'redeem pays at least the assets previewRedeem quoted' },
  { test: 'test_redeem', id: 'redeem', description: 'redeem burns owner shares, pays the receiver and spends share allowance' },
  { test: 'test_redeem_zero_allowance', id: 'redeem-zero-allowance', description: 'redeem on behalf of an owner without allowance reverts' },
  { test: 'test_RT_deposit_redeem', id: 'RT-deposit-redeem', description: 'redeem(deposit(a)) returns no more than a' },
  { test: 'test_RT_deposit_withdraw', id: 'RT-deposit-withdraw', description: 'withdraw(a) burns at least the shares deposit(a) minted' },
  { test: 'test_RT_redeem_deposit', id: 'RT-redeem-deposit', description: 'deposit(redeem(s)) mints no more than s' },
  { test: 'test_RT_redeem_mint', id: 'RT-redeem-mint', description: 'mint(s) costs at least the assets redeem(s) paid' },
  { test: 'test_RT_mint_withdraw', id: 'RT-mint-withdraw', description: 'withdraw(mint(s)) burns at least s shares' },
  { test: 'test_RT_mint_redeem', id: 'RT-mint-redeem', description: 'redeem(s) pays no more than mint(s) cost' },
  { test: 'test_RT_withdraw_mint', id: 'RT-withdraw-mint', description: 'mint(withdraw(a)) costs at least a' },
  { test: 'test_RT_withdraw_deposit', id: 'RT-withdraw-deposit', description: 'deposit(a) mints no more than the shares withdraw(a) burned' },
];

/**
 * Specfirst's own properties (SpecfirstMaxHonored.t.sol, MIT). Ids start with "sf-" so reports keep them apart
 * from the upstream suite. Each checks one EIP-4626 MUST that the upstream suite cannot fail on, because it
 * discards inputs whose vault call reverts.
 */
export const SPECFIRST_ERC4626_PROPERTIES: readonly StandardProperty[] = [
  {
    test: 'test_sf_maxDeposit_honored',
    id: 'sf-maxDeposit-honored',
    description: 'deposit does not revert for amounts up to maxDeposit (EIP-4626: maxDeposit is the most deposit accepts without reverting)',
  },
  {
    test: 'test_sf_maxMint_honored',
    id: 'sf-maxMint-honored',
    description: 'mint does not revert for shares up to maxMint (EIP-4626: maxMint is the most mint accepts without reverting)',
  },
  {
    test: 'test_sf_maxWithdraw_honored',
    id: 'sf-maxWithdraw-honored',
    description: 'withdraw does not revert for assets up to maxWithdraw (EIP-4626: maxWithdraw MUST return 0 when withdrawals are disabled)',
  },
  {
    test: 'test_sf_maxRedeem_honored',
    id: 'sf-maxRedeem-honored',
    description: 'redeem does not revert for shares up to maxRedeem (EIP-4626: maxRedeem MUST return 0 when redemptions are disabled)',
  },
];

/** Everything a check reports: the 26 upstream properties, then Specfirst's own. */
export const ERC4626_CHECK_PROPERTIES: readonly StandardProperty[] = [...ERC4626_PROPERTIES, ...SPECFIRST_ERC4626_PROPERTIES];
