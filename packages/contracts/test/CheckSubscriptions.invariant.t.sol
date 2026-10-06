// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckSubscriptions} from "../src/CheckSubscriptions.sol";

/// @notice Drives the subscriptions with random subscribes, extends (by the subscriber or anyone, before and
///         after expiry), cancels, settles, withdrawals, fee changes and time jumps. Every action is guarded
///         so it never reverts (fail_on_revert = true). After each action it checks that earned, withdrawn
///         and every subscription's settled never went down.
contract SubsHandler is Test {
    CheckSubscriptions public subs;
    address public owner;
    address[] internal actors;
    address[] internal subjects;
    bytes32 internal constant ERC4626 = keccak256("erc4626");

    /// Every coin paid in (subscribe and extend values).
    uint256 public paidIn;
    /// Coins that went back to subscribers through cancel.
    uint256 public refundedValue;
    uint256 public paidOut;
    uint256 public cancels;
    /// Days bought per subscription, and the refund each cancel sent.
    mapping(uint256 => uint256) public daysBought;
    mapping(uint256 => uint256) public refundOf;
    bool public wentDown;
    uint256 internal lastEarned;
    uint256 internal lastWithdrawn;
    mapping(uint256 => uint256) internal lastSettled;

    constructor(CheckSubscriptions subs_, address owner_) {
        subs = subs_;
        owner = owner_;
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encode("actor", i))));
        }
        subjects.push(0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E);
        subjects.push(0x802c91d807A8DaCA257c4708ab264B6520964e44);
    }

    modifier checked() {
        _;
        if (subs.earned() < lastEarned || subs.withdrawn() < lastWithdrawn) wentDown = true;
        lastEarned = subs.earned();
        lastWithdrawn = subs.withdrawn();
        uint256 n = subs.subscriptionCount();
        for (uint256 i; i < n; ++i) {
            uint96 settled = subs.subscriptionOf(i).settled;
            if (settled < lastSettled[i]) wentDown = true;
            lastSettled[i] = settled;
        }
    }

    function _id(uint256 seed) internal view returns (bool found, uint256 id) {
        uint256 n = subs.subscriptionCount();
        if (n == 0) return (false, 0);
        return (true, seed % n);
    }

    function subscribe(uint256 actorSeed, uint256 subjectSeed, uint32 days_) external checked {
        days_ = uint32(bound(days_, 1, 365));
        address a = actors[actorSeed % actors.length];
        uint256 cost = uint256(subs.feePerDay()) * days_;
        vm.deal(a, a.balance + cost);
        vm.prank(a);
        uint256 id = subs.subscribe{value: cost}(143, subjects[subjectSeed % subjects.length], ERC4626, days_);
        paidIn += cost;
        daysBought[id] = days_;
    }

    function extend(uint256 seed, uint256 payerSeed, uint32 days_) external checked {
        (bool found, uint256 id) = _id(seed);
        if (!found) return;
        CheckSubscriptions.Subscription memory s = subs.subscriptionOf(id);
        if (s.cancelled) return;
        days_ = uint32(bound(days_, 1, 365));
        uint256 cost = uint256(s.feePerDay) * days_;
        address payer = actors[payerSeed % actors.length];
        vm.deal(payer, payer.balance + cost);
        vm.prank(payer);
        subs.extend{value: cost}(id, days_);
        paidIn += cost;
        daysBought[id] += days_;
    }

    function cancel(uint256 seed) external checked {
        (bool found, uint256 id) = _id(seed);
        if (!found) return;
        CheckSubscriptions.Subscription memory s = subs.subscriptionOf(id);
        if (s.cancelled) return;
        uint256 before = s.subscriber.balance;
        vm.prank(s.subscriber);
        subs.cancel(id);
        uint256 refund = s.subscriber.balance - before;
        refundedValue += refund;
        refundOf[id] = refund;
        ++cancels;
    }

    function settle(uint256 seedA, uint256 seedB) external checked {
        (bool found, uint256 a) = _id(seedA);
        if (!found) return;
        (, uint256 b) = _id(seedB);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        subs.settle(ids);
    }

    function withdraw() external checked {
        if (subs.earned() == subs.withdrawn()) return;
        uint256 amount = subs.earned() - subs.withdrawn();
        vm.prank(owner);
        subs.withdraw(payable(makeAddr("treasury")));
        paidOut += amount;
    }

    function setFeePerDay(uint96 f) external checked {
        vm.prank(owner);
        subs.setFeePerDay(uint96(bound(f, 0, 2 ether)));
    }

    function warp(uint256 dt) external checked {
        vm.warp(block.timestamp + bound(dt, 0, 3 days));
    }
}

contract CheckSubscriptionsInvariantTest is Test {
    CheckSubscriptions internal subs;
    SubsHandler internal handler;
    uint64 internal constant DAY = 1 days;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        subs = new CheckSubscriptions(owner, 0.05 ether);
        handler = new SubsHandler(subs, owner);
        targetContract(address(handler));
    }

    /// The contract holds exactly the escrowed fees plus the earned fees not withdrawn yet.
    function invariant_balanceIsEscrowedPlusEarnedMinusWithdrawn() public view {
        assertEq(address(subs).balance, subs.escrowed() + subs.earned() - subs.withdrawn());
        assertLe(subs.withdrawn(), subs.earned());
        assertEq(subs.withdrawn(), handler.paidOut());
        assertEq(handler.paidIn(), handler.refundedValue() + address(subs).balance + subs.withdrawn());
    }

    /// escrowed is paid - settled over the live subscriptions, earned the sum of settled; settled never exceeds
    /// paid nor the fee of the started days; a cancelled subscription refunded exactly paid - settled.
    function invariant_booksMatchTheSubscriptions() public view {
        uint256 n = subs.subscriptionCount();
        uint256 open;
        uint256 settled;
        uint256 paid;
        uint256 cancelled;
        for (uint256 i; i < n; ++i) {
            CheckSubscriptions.Subscription memory s = subs.subscriptionOf(i);
            assertLe(s.settled, s.paid);
            assertEq(uint256(s.paid), uint256(s.feePerDay) * handler.daysBought(i));
            assertEq((s.endsAt - s.startsAt) % DAY, 0);
            assertGe(s.endsAt, s.startsAt + DAY);
            assertLe(s.settled, _due(s));
            settled += s.settled;
            paid += s.paid;
            if (s.cancelled) {
                ++cancelled;
                assertEq(handler.refundOf(i), s.paid - s.settled);
                assertFalse(subs.isActive(i));
            } else {
                open += s.paid - s.settled;
                assertEq(subs.isActive(i), block.timestamp < s.endsAt);
            }
        }
        assertEq(subs.escrowed(), open);
        assertEq(subs.earned(), settled);
        assertEq(paid, handler.paidIn());
        assertEq(cancelled, handler.cancels());
    }

    /// earned, withdrawn and every settled only ever grow.
    function invariant_earnedWithdrawnAndSettledNeverGoDown() public view {
        assertFalse(handler.wentDown());
    }

    /// paid minus the fee of the days of the current run that have not started.
    function _due(CheckSubscriptions.Subscription memory s) internal view returns (uint256) {
        if (block.timestamp >= s.endsAt) return s.paid;
        uint256 started = (block.timestamp - s.startsAt) / DAY + 1;
        uint256 runDays = (s.endsAt - s.startsAt) / DAY;
        return s.paid - (runDays - started) * s.feePerDay;
    }
}
