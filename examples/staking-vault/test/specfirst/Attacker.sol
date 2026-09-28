// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Attacker
/// @notice Default attacker actor included in every specfirst project. The handler routes the
///         attacker's calls through `execute`, which remembers the target and calldata. When the
///         target sends MON back (receive) or calls back with data (fallback), the hook replays
///         the last call exactly once. The spec author does not need to know about reentrancy for
///         it to be exercised.
contract Attacker {
    address public lastTarget;
    bytes public lastData;

    /// @dev True while an `execute` is in flight. Hooks do nothing outside of it.
    bool internal armed;
    /// @dev Set on the first hook entry of an `execute`, which caps replays at one.
    bool internal reentered;

    /// @notice Whether the replay in the last `execute` was attempted and whether it succeeded.
    bool public lastReentryAttempted;
    bool public lastReentrySucceeded;

    function execute(address target, bytes calldata data, uint256 value)
        external
        returns (bool ok, bytes memory ret)
    {
        lastTarget = target;
        lastData = data;
        lastReentryAttempted = false;
        lastReentrySucceeded = false;
        reentered = false;
        armed = true;
        (ok, ret) = target.call{value: value}(data);
        armed = false;
    }

    receive() external payable {
        _hook();
    }

    fallback() external payable {
        _hook();
    }

    function _hook() internal {
        if (!armed || reentered) return;
        reentered = true;
        lastReentryAttempted = true;
        // The replay result is ignored on purpose: a failing replay must not break the outer call.
        (bool ok,) = lastTarget.call(lastData);
        lastReentrySucceeded = ok;
    }
}
