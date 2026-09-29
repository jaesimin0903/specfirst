// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;

// This harness inherits a16z/erc4626-tests (AGPL-3.0), fetched at a pinned commit into a cache
// directory at run time and never copied into this repository. See docs/adr/0003.
import {ERC4626Test, IERC4626} from "erc4626-tests/ERC4626.test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

/// Runs the a16z ERC-4626 property suite against a vault already deployed on a forked chain.
/// SF_VAULT is the vault address, SF_DELTA the tolerated absolute error in base units (default 0).
/// Differences from the upstream harness:
///   1. balances come from forge-std `deal` (or a packed-slot write) instead of the mock token's `mint`,
///   2. amounts are bounded to min(maxDeposit, 1e6 whole tokens),
///   3. no synthetic yield is injected (setUpYield is never called).
/// Users are EOAs above the precompile range and never the vault or its asset.
/// A reverting maxDeposit or decimals is not held against every property: setUpVault falls back to the
/// cap and decimals to 18, so a reverting maxDeposit fails test_maxDeposit ("MUST NOT revert") only.
contract SpecfirstERC4626Test is ERC4626Test {
    using stdStorage for StdStorage;

    uint256 internal _cap;

    function setUp() public virtual override {
        _vault_ = vm.envAddress("SF_VAULT");
        _underlying_ = IERC4626(_vault_).asset();
        _delta_ = vm.envOr("SF_DELTA", uint256(0));
        _vaultMayBeEmpty = false;
        _unlimitedAmount = false;
        _cap = 1_000_000 * 10 ** uint256(_decimalsOr18(_underlying_));
    }

    function _decimalsOr18(address token) internal view returns (uint8) {
        try IDecimals(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }

    function setUpVault(Init memory init) public override {
        for (uint256 i = 0; i < N; i++) {
            address user = init.user[i];
            vm.assume(_isEOA(user) && uint160(user) > 0xffff);
            vm.assume(user != _vault_ && user != _underlying_);
            uint256 maxDep = _cap;
            bool maxKnown = false;
            try IERC4626(_vault_).maxDeposit(user) returns (uint256 m) {
                maxKnown = true;
                if (m < maxDep) maxDep = m;
            } catch {}
            uint256 shares = bound(init.share[i], 0, maxDep);
            _give(_underlying_, user, shares);
            _approve(_underlying_, user, _vault_, shares);
            vm.prank(user);
            try IERC4626(_vault_).deposit(shares, user) {} catch {
                // EIP-4626: a deposit up to maxDeposit must not revert. Upstream discards the input; so do we,
                // but the discard is recorded so a vault cannot hide the violation behind rejected inputs.
                if (maxKnown && shares > 0) _recordDepositRevert();
                vm.assume(false);
            }
            _give(_underlying_, user, bound(init.asset[i], 0, _cap));
        }
    }

    /// Sets `to`'s balance of `token`. Plain deal first; tokens that pack the balance with other fields in
    /// one slot (AUSD on Monad) make it fail with "checked_write ... Failed to write value.", so the packed
    /// slot search is tried next. Only when both fail does the stdStorage error end the test.
    function _give(address token, address to, uint256 amount) internal {
        try this.__giveDeal(token, to, amount) {
            return;
        } catch {}
        this.__givePacked(token, to, amount);
    }

    /// External so a failing deal reverts only its own frame. Callable by this contract only.
    function __giveDeal(address token, address to, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        deal(token, to, amount);
    }

    function __givePacked(address token, address to, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        stdstore.enable_packed_slots().target(token).sig("balanceOf(address)").with_key(to).checked_write(amount);
    }

    /// Appends the running test's selector (msg.sig, since setUpVault is called internally by the test) to
    /// sf-events/<SF_RUN_ID>.deposit-below-max.log. Files survive the per-run state reset, so the runner can
    /// count discards per property. No-op when SF_RUN_ID is unset.
    function _recordDepositRevert() internal {
        string memory runId = vm.envOr("SF_RUN_ID", string(""));
        if (bytes(runId).length == 0) return;
        vm.writeLine(string.concat("sf-events/", runId, ".deposit-below-max.log"), vm.toString(abi.encodePacked(msg.sig)));
    }
}
