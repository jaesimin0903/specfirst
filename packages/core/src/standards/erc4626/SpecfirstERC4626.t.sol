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
///   2. amounts are bounded to min(maxDeposit, 1e6 whole tokens), or to 1e6 whole tokens when maxDeposit is 0,
///   3. no synthetic yield is injected (setUpYield is never called),
///   4. fuzzed users are mapped onto a pool of USER_POOL addresses derived from SF_POOL_SALT (the run's
///      recorded fuzz seed). A fresh address costs uncached fork reads for every balance and allowance slot
///      it touches, which on a rate-limited public RPC turned whole runs inconclusive; a pool is read once.
///      The salt changes per run, so a vault cannot predict the addresses.
/// Users are EOAs above the precompile range and never the vault or its asset.
/// A reverting maxDeposit or decimals is not held against every property: setUpVault falls back to the
/// cap and decimals to 18, so a reverting maxDeposit fails test_maxDeposit ("MUST NOT revert") only.
contract SpecfirstERC4626Test is ERC4626Test {
    using stdStorage for StdStorage;

    uint256 internal _cap;
    uint256 internal _poolSalt;
    uint256 internal constant USER_POOL = 16;

    function setUp() public virtual override {
        _vault_ = vm.envAddress("SF_VAULT");
        _underlying_ = IERC4626(_vault_).asset();
        _delta_ = vm.envOr("SF_DELTA", uint256(0));
        _vaultMayBeEmpty = false;
        _unlimitedAmount = false;
        _cap = 1_000_000 * 10 ** uint256(_decimalsOr18(_underlying_));
        _poolSalt = vm.envOr("SF_POOL_SALT", uint256(keccak256("specfirst.erc4626.pool")));
    }

    /// Pool member for a fuzzed address. The test body reads init.user after setUpVault returns; the struct
    /// is passed by reference (internal call to a public function), so rewriting it here reaches the test.
    function _poolUser(address fuzzed) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(_poolSalt, uint256(uint160(fuzzed)) % USER_POOL)))));
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
            init.user[i] = _poolUser(init.user[i]);
            address user = init.user[i];
            vm.assume(_isEOA(user) && uint160(user) > 0xffff);
            vm.assume(user != _vault_ && user != _underlying_);
            // The amount is bounded by maxDeposit when the vault reports a positive one. A maxDeposit of 0 is an
            // underestimate EIP-4626 allows (Morpho Vault V2 reports 0 for everyone), so the cap is tried instead
            // and a revert only discards the input.
            uint256 maxDep = _cap;
            uint256 advertised = 0;
            try IERC4626(_vault_).maxDeposit(user) returns (uint256 m) {
                advertised = m;
                if (m > 0 && m < maxDep) maxDep = m;
            } catch {}
            uint256 shares = bound(init.share[i], 0, maxDep);
            _give(_underlying_, user, shares);
            _approve(_underlying_, user, _vault_, shares);
            vm.prank(user);
            try IERC4626(_vault_).deposit(shares, user) {} catch {
                // EIP-4626: a deposit up to a positive maxDeposit must not revert. Upstream discards the input; so
                // do we, but the discard is recorded so a vault cannot hide the violation behind rejected inputs.
                // A revert under a maxDeposit of 0 is not recorded: 0 honestly says "not allowed".
                if (advertised > 0 && shares > 0 && shares <= advertised) _recordDepositRevert();
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
