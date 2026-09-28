// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IVault} from "./IVault.sol";
import {Handler} from "./Handler.sol";
import {SpecfirstProps} from "./SpecfirstProps.sol";

/// @title SpecfirstInvariants
/// @notice One invariant_INV_N function per spec invariant. The name carries the spec id, which the
///         specfirst forge parser extracts. Every check is a call into SpecfirstProps.
/// @dev Local mode deploys a fresh vault. Fork mode (SPECFIRST_TARGET set) attaches to the deployed
///      vault and seeds the depositor set from SPECFIRST_DEPOSITORS (comma separated addresses).
contract SpecfirstInvariants is Test {
    IVault internal vault;
    Handler internal handler;

    function setUp() public {
        address target = vm.envOr("SPECFIRST_TARGET", address(0));
        address[] memory initialDepositors = vm.envOr("SPECFIRST_DEPOSITORS", ",", new address[](0));

        if (target == address(0)) {
            address owner = makeAddr("owner");
            vault = IVault(deployCode("StakingVault.sol:StakingVault", abi.encode(owner)));
        } else {
            vault = IVault(target);
        }

        handler = new Handler(vault, initialDepositors);

        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = Handler.deposit.selector;
        selectors[1] = Handler.withdraw.selector;
        selectors[2] = Handler.setRewardRate.selector;
        selectors[3] = Handler.pause.selector;
        selectors[4] = Handler.unpause.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// INV-1: total staked equals the sum of all depositor balances.
    function invariant_INV_1() public view {
        assertTrue(SpecfirstProps.inv1(vault, handler.depositors()), "INV-1 totalStaked != sum(balances)");
    }

    /// INV-2: vault MON is at least the sum of all depositor balances.
    function invariant_INV_2() public view {
        assertTrue(SpecfirstProps.inv2(vault, handler.depositors()), "INV-2 vault MON < sum(balances)");
    }

    /// INV-3: a withdrawal debits and pays exactly the withdrawn amount.
    function invariant_INV_3() public view {
        assertFalse(handler.ghost_inv3Broken(), "INV-3 withdraw debit or payout != withdrawn amount");
    }

    /// INV-4: nobody withdraws more than their own balance.
    function invariant_INV_4() public view {
        assertFalse(handler.ghost_inv4Broken(), "INV-4 withdrew more than own balance");
    }

    /// INV-5: only the owner can change the reward rate.
    function invariant_INV_5() public view {
        assertFalse(handler.ghost_inv5Broken(), "INV-5 reward rate access violated");
    }

    /// INV-6: no deposit succeeds while paused.
    function invariant_INV_6() public {
        assertTrue(
            SpecfirstProps.inv6(vault, handler.ghost_depositSucceededWhilePaused()), "INV-6 deposit succeeded while paused"
        );
    }

    /// INV-7: only the owner can pause and unpause.
    function invariant_INV_7() public view {
        assertFalse(handler.ghost_inv7Broken(), "INV-7 pause access violated");
    }
}
