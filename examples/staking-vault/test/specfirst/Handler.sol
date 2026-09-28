// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";

import {IVault} from "./IVault.sol";
import {Attacker} from "./Attacker.sol";
import {SpecfirstProps} from "./SpecfirstProps.sol";

/// @title Handler
/// @notice Fuzz entry points. Each action picks a random actor (3 users, the owner, the attacker
///         contract), performs one vault call, and judges postcondition and access properties
///         right after the call through SpecfirstProps. A violation raises a ghost flag that the
///         matching invariant_INV_N in Invariants.t.sol turns into a failure. The handler does not
///         assert by itself: the campaign runs with fail_on_revert = false, so a revert inside a
///         handler would be discarded instead of reported.
contract Handler is CommonBase, StdCheats, StdUtils {
    struct Snapshot {
        uint8 action; // 1 deposit, 2 withdraw, 3 setRewardRate, 4 pause, 5 unpause
        address actor;
        uint256 arg;
        bool succeeded;
        uint256 balBefore;
        uint256 balAfter;
        uint256 received;
        uint256 withdrawn;
    }

    uint256 internal constant USERS = 3;
    uint256 internal constant MAX_DEPOSIT = 100 ether;

    IVault public immutable vault;
    address public immutable owner;
    Attacker public immutable attacker;

    address[] internal actors;

    // Ghost state.
    address[] internal depositorList;
    mapping(address => bool) internal isDepositor;
    uint256 public ghost_expectedSum;
    Snapshot public lastCall;

    bool public ghost_inv3Broken;
    bool public ghost_inv4Broken;
    bool public ghost_inv5Broken;
    bool public ghost_depositSucceededWhilePaused;
    bool public ghost_inv7Broken;

    mapping(bytes32 => uint256) public calls;

    constructor(IVault vault_, address[] memory initialDepositors) {
        vault = vault_;
        owner = vault_.owner();
        attacker = new Attacker();

        for (uint256 i = 0; i < USERS; i++) {
            actors.push(makeAddr(string.concat("user", vm.toString(i))));
        }
        actors.push(owner);
        actors.push(address(attacker));

        // Fork mode: start from the real depositor set collected from Deposit logs.
        for (uint256 i = 0; i < initialDepositors.length; i++) {
            _addDepositor(initialDepositors[i]);
        }
        ghost_expectedSum = SpecfirstProps.sumBalances(vault_, depositorList);
    }

    // ------------------------------------------------------------------ actions

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        amount = bound(amount, 0, MAX_DEPOSIT);
        bool pausedBefore = vault.paused();
        uint256 balBefore = vault.balances(actor);

        bool ok = _send(actor, abi.encodeCall(IVault.deposit, ()), amount);

        if (ok && pausedBefore) ghost_depositSucceededWhilePaused = true;
        if (ok) {
            _addDepositor(actor);
            ghost_expectedSum += amount;
        }
        lastCall = Snapshot(1, actor, amount, ok, balBefore, vault.balances(actor), 0, 0);
        calls["deposit"]++;
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 balBefore = vault.balances(actor);
        // One in four attempts asks for more than the balance; the rest stay within it.
        if (amount % 4 == 0) {
            amount = balBefore + 1 + (amount % 1 ether);
        } else {
            amount = bound(amount, 0, balBefore);
        }
        uint256 monBefore = actor.balance;

        bool ok = _send(actor, abi.encodeCall(IVault.withdraw, (amount)), 0);

        uint256 balAfter = vault.balances(actor);
        uint256 received = actor.balance - monBefore;
        uint256 withdrawn;
        if (ok) {
            withdrawn = amount;
            if (actor == address(attacker) && attacker.lastReentrySucceeded()) withdrawn += amount;
            ghost_expectedSum -= withdrawn;
        }

        if (!SpecfirstProps.inv3(withdrawn, balBefore, balAfter, received)) ghost_inv3Broken = true;
        if (!SpecfirstProps.inv4(amount, ok, balBefore, received)) ghost_inv4Broken = true;

        lastCall = Snapshot(2, actor, amount, ok, balBefore, balAfter, received, withdrawn);
        calls["withdraw"]++;
    }

    function setRewardRate(uint256 actorSeed, uint256 rate) external {
        address actor = _actor(actorSeed);
        uint256 rateBefore = vault.rewardRate();

        bool ok = _send(actor, abi.encodeCall(IVault.setRewardRate, (rate)), 0);

        uint256 rateAfter = vault.rewardRate();
        if (!SpecfirstProps.inv5(actor == owner, ok, rateBefore, rateAfter, rate)) ghost_inv5Broken = true;
        lastCall = Snapshot(3, actor, rate, ok, rateBefore, rateAfter, 0, 0);
        calls["setRewardRate"]++;
    }

    function pause(uint256 actorSeed) external {
        _togglePause(actorSeed, true);
        calls["pause"]++;
    }

    function unpause(uint256 actorSeed) external {
        _togglePause(actorSeed, false);
        calls["unpause"]++;
    }

    // ------------------------------------------------------------------ views

    function depositors() external view returns (address[] memory) {
        return depositorList;
    }

    function actorList() external view returns (address[] memory) {
        return actors;
    }

    // ------------------------------------------------------------------ internals

    function _togglePause(uint256 actorSeed, bool target) internal {
        address actor = _actor(actorSeed);
        bool pausedBefore = vault.paused();
        bytes memory data = target ? abi.encodeCall(IVault.pause, ()) : abi.encodeCall(IVault.unpause, ());

        bool ok = _send(actor, data, 0);

        bool pausedAfter = vault.paused();
        if (!SpecfirstProps.inv7(actor == owner, ok, pausedBefore, pausedAfter, target)) ghost_inv7Broken = true;
        lastCall = Snapshot(target ? 4 : 5, actor, 0, ok, pausedBefore ? 1 : 0, pausedAfter ? 1 : 0, 0, 0);
    }

    /// @dev Sends one call to the vault as `actor`. The attacker goes through Attacker.execute so
    ///      its receive and fallback hooks are armed; everyone else is pranked.
    function _send(address actor, bytes memory data, uint256 value) internal returns (bool ok) {
        if (value > 0) vm.deal(actor, actor.balance + value);
        if (actor == address(attacker)) {
            (ok,) = attacker.execute(address(vault), data, value);
        } else {
            vm.prank(actor);
            (ok,) = address(vault).call{value: value}(data);
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _addDepositor(address a) internal {
        if (isDepositor[a]) return;
        isDepositor[a] = true;
        depositorList.push(a);
    }
}
