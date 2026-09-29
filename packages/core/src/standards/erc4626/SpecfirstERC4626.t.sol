// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;

// This harness inherits a16z/erc4626-tests (AGPL-3.0), fetched at a pinned commit into a cache
// directory at run time and never copied into this repository. See docs/adr/0003.
import {ERC4626Test, IERC4626} from "erc4626-tests/ERC4626.test.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// Runs the a16z ERC-4626 property suite against a vault already deployed on a forked chain.
/// SF_VAULT is the vault address, SF_DELTA the tolerated absolute error in base units (default 0).
/// Differences from the upstream harness:
///   1. balances come from forge-std `deal` instead of the mock token's `mint`,
///   2. amounts are bounded to min(maxDeposit, 1e6 whole tokens),
///   3. no synthetic yield is injected (setUpYield is never called).
/// Users are EOAs above the precompile range and never the vault or its asset.
contract SpecfirstERC4626Test is ERC4626Test {
    uint256 internal _cap;

    function setUp() public virtual override {
        _vault_ = vm.envAddress("SF_VAULT");
        _underlying_ = IERC4626(_vault_).asset();
        _delta_ = vm.envOr("SF_DELTA", uint256(0));
        _vaultMayBeEmpty = false;
        _unlimitedAmount = false;
        _cap = 1_000_000 * 10 ** uint256(IDecimals(_underlying_).decimals());
    }

    function setUpVault(Init memory init) public override {
        for (uint256 i = 0; i < N; i++) {
            address user = init.user[i];
            vm.assume(_isEOA(user) && uint160(user) > 0xffff);
            vm.assume(user != _vault_ && user != _underlying_);
            uint256 maxDep = IERC4626(_vault_).maxDeposit(user);
            uint256 shares = bound(init.share[i], 0, maxDep < _cap ? maxDep : _cap);
            deal(_underlying_, user, shares);
            _approve(_underlying_, user, _vault_, shares);
            vm.prank(user);
            try IERC4626(_vault_).deposit(shares, user) {} catch { vm.assume(false); }
            deal(_underlying_, user, bound(init.asset[i], 0, _cap));
        }
    }
}
