// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVault} from "./IVault.sol";

/// @title SpecfirstProps
/// @notice The only place where property expressions live. Invariants.t.sol, Handler.sol and
///         SpecfirstProbe.sol call into this library and never restate a formula. `specfirst lock`
///         hashes this file and mutant checks target it.
/// @dev State properties (INV-1, INV-2, INV-6) read the vault directly. Postcondition and access
///      properties (INV-3, INV-4, INV-5, INV-7) are judged from before and after snapshots that
///      the handler captures around a single call.
library SpecfirstProps {
    /// @dev Sum of recorded balances over a depositor set. Duplicates must be filtered by the caller.
    function sumBalances(IVault v, address[] memory depositors) internal view returns (uint256 sum) {
        for (uint256 i = 0; i < depositors.length; i++) {
            sum += v.balances(depositors[i]);
        }
    }

    /// INV-1: total staked equals the sum of all depositor balances.
    function inv1(IVault v, address[] memory depositors) internal view returns (bool) {
        return v.totalStaked() == sumBalances(v, depositors);
    }

    /// INV-2: MON held by the vault is at least the sum of all depositor balances.
    function inv2(IVault v, address[] memory depositors) internal view returns (bool) {
        return address(v).balance >= sumBalances(v, depositors);
    }

    /// INV-3: a withdrawal lowers the caller balance by exactly the withdrawn amount and the caller
    ///        receives exactly that amount of MON. `withdrawn` is the sum of amounts of every
    ///        withdraw call that succeeded inside the observed transaction, reentrant ones included.
    function inv3(uint256 withdrawn, uint256 balBefore, uint256 balAfter, uint256 received)
        internal
        pure
        returns (bool)
    {
        if (balAfter > balBefore) return false;
        return balBefore - balAfter == withdrawn && received == withdrawn;
    }

    /// INV-4: nobody can take out more than their own balance. Holds when an over-balance request
    ///        did not succeed and the MON received in one transaction does not exceed the balance
    ///        the caller had before it.
    function inv4(uint256 requested, bool succeeded, uint256 balBefore, uint256 received)
        internal
        pure
        returns (bool)
    {
        if (requested > balBefore && succeeded) return false;
        return received <= balBefore;
    }

    /// INV-5: only the owner can change the reward rate. A non-owner call must fail and leave the
    ///        rate untouched; an owner call must set the requested rate.
    function inv5(bool callerIsOwner, bool succeeded, uint256 rateBefore, uint256 rateAfter, uint256 requested)
        internal
        pure
        returns (bool)
    {
        if (!callerIsOwner) return !succeeded && rateAfter == rateBefore;
        return succeeded && rateAfter == requested;
    }

    /// INV-6: while paused, a deposit does not succeed. `depositSucceededWhilePaused` is the
    ///        handler ghost flag (pass false when there is no handler, e.g. the probe). If the vault
    ///        is paused right now, a zero value deposit is attempted and must revert. The attempt
    ///        cannot move funds, and in a revert it leaves no state behind.
    function inv6(IVault v, bool depositSucceededWhilePaused) internal returns (bool) {
        if (depositSucceededWhilePaused) return false;
        if (!v.paused()) return true;
        (bool ok,) = address(v).call(abi.encodeCall(IVault.deposit, ()));
        return !ok;
    }

    /// INV-7: only the owner can pause or unpause. A non-owner call must fail and leave the flag
    ///        untouched; an owner call must set the flag to `target`.
    function inv7(bool callerIsOwner, bool succeeded, bool pausedBefore, bool pausedAfter, bool target)
        internal
        pure
        returns (bool)
    {
        if (!callerIsOwner) return !succeeded && pausedAfter == pausedBefore;
        return succeeded && pausedAfter == target;
    }
}
