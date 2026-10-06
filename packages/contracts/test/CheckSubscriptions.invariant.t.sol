// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckSubscriptions} from "../src/CheckSubscriptions.sol";

/// A subscriber contract without a payable receive: its cancel reverts whenever there is something to refund.
contract RefusingSubscriber {
    function subscribe(CheckSubscriptions subs, address subject, uint32 days_) external payable returns (uint256) {
        return subs.subscribe{value: msg.value}(143, subject, keccak256("erc4626"), days_);
    }

    function cancel(CheckSubscriptions subs, uint256 id) external {
        subs.cancel(id);
    }
}

/// @notice Drives the subscriptions with random subscribes, extends (by the subscriber or anyone, before and after
///         expiry), cancels, settles, withdrawals, fee changes and time jumps, plus adversarial calls that must
///         fail: a coin-refusing subscriber cancelling, a stranger cancelling, wrong values, a fee of 0. Expected
///         reverts go through try/catch, so fail_on_revert stays on and an unexpected outcome is recorded instead.
///         The handler keeps its own model of every subscription (its run, the days of earlier runs, the fee),
///         updated from the rules of ADR 0006 and never read back from the contract, so the invariants compare
///         the contract against an independent oracle.
contract SubsHandler is Test {
    struct Ghost {
        uint64 start;
        uint64 end;
        uint256 earlierDays; // days of earlier runs; all of them have started
        uint256 fee;
        uint256 daysBought;
        bool cancelled;
        uint256 startedAtCancel;
        uint256 refund;
    }

    CheckSubscriptions public subs;
    RefusingSubscriber public refuser;
    address public owner;
    address public stranger;
    address[] internal actors;
    address[] internal subjects;
    bytes32 internal constant ERC4626 = keccak256("erc4626");
    uint64 internal constant DAY = 1 days;

    /// Every coin paid in (subscribe and extend values).
    uint256 public paidIn;
    /// Coins that went back to subscribers through cancel.
    uint256 public refundedValue;
    uint256 public paidOut;
    uint256 public cancels;
    uint256 public restarts;
    mapping(uint256 => Ghost) internal ghosts;
    bool public wentDown;
    /// Set when a call that must fail succeeded, or failed with the wrong error.
    string public unexpected;
    uint256 internal lastEarned;
    uint256 internal lastWithdrawn;
    mapping(uint256 => uint256) internal lastSettled;

    constructor(CheckSubscriptions subs_, address owner_) {
        subs = subs_;
        owner = owner_;
        refuser = new RefusingSubscriber();
        stranger = makeAddr("stranger");
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

    // ------------------------------------------------------------ the model

    /// Started days of `id` at the current time by the model: earlier runs in full, the current run up to now.
    function ghostStarted(uint256 id) public view returns (uint256) {
        Ghost storage g = ghosts[id];
        if (g.cancelled) return g.startedAtCancel;
        uint256 runDays = (g.end - g.start) / DAY;
        uint256 inRun = block.timestamp >= g.end ? runDays : (block.timestamp - g.start) / DAY + 1;
        return g.earlierDays + inRun;
    }

    function ghostOf(uint256 id) external view returns (Ghost memory) {
        return ghosts[id];
    }

    function _flag(string memory what) internal {
        if (bytes(unexpected).length == 0) unexpected = what;
    }

    function _days(uint32 d) internal pure returns (uint32) {
        // Mostly short runs, so expiry and restarts happen often; now and then the 365 day maximum.
        return d % 16 == 0 ? 365 : uint32(bound(d, 1, 12));
    }

    function _id(uint256 seed) internal view returns (bool found, uint256 id) {
        uint256 n = subs.subscriptionCount();
        if (n == 0) return (false, 0);
        return (true, seed % n);
    }

    function _recordSubscribe(uint256 id, uint32 days_, uint256 fee) internal {
        ghosts[id] = Ghost({
            start: uint64(block.timestamp),
            end: uint64(block.timestamp) + uint64(days_) * DAY,
            earlierDays: 0,
            fee: fee,
            daysBought: days_,
            cancelled: false,
            startedAtCancel: 0,
            refund: 0
        });
        paidIn += fee * days_;
    }

    function _recordExtend(uint256 id, uint32 days_) internal {
        Ghost storage g = ghosts[id];
        if (block.timestamp >= g.end) {
            // A new run from now: the expired run's days are all started, the gap was never bought.
            g.earlierDays += (g.end - g.start) / DAY;
            g.start = uint64(block.timestamp);
            g.end = uint64(block.timestamp) + uint64(days_) * DAY;
            ++restarts;
        } else {
            g.end += uint64(days_) * DAY;
        }
        g.daysBought += days_;
        paidIn += g.fee * days_;
    }

    /// Cancels as the subscriber. The refusing contract must fail exactly when there is something to refund.
    function _cancel(uint256 id) internal {
        Ghost storage g = ghosts[id];
        address who = subs.subscriptionOf(id).subscriber;
        uint256 started = ghostStarted(id);
        uint256 expected = g.fee * (g.daysBought - started);
        uint256 before = who.balance;
        if (who == address(refuser)) {
            try refuser.cancel(subs, id) {
                if (expected > 0) return _flag("a refusing subscriber cancelled with a refund due");
            } catch (bytes memory err) {
                bytes memory want =
                    abi.encodeWithSelector(CheckSubscriptions.TransferFailed.selector, address(refuser), expected);
                if (expected == 0 || keccak256(err) != keccak256(want)) _flag("refusing cancel failed unexpectedly");
                return;
            }
        } else {
            vm.prank(who);
            subs.cancel(id);
        }
        g.cancelled = true;
        g.startedAtCancel = started;
        g.refund = who.balance - before;
        refundedValue += g.refund;
        ++cancels;
    }

    // ------------------------------------------------------------ actions

    function subscribe(uint256 actorSeed, uint256 subjectSeed, uint32 days_) external checked {
        days_ = _days(days_);
        address a = actors[actorSeed % actors.length];
        uint256 fee = subs.feePerDay();
        uint256 cost = fee * days_;
        vm.deal(a, a.balance + cost);
        vm.prank(a);
        uint256 id = subs.subscribe{value: cost}(143, subjects[subjectSeed % subjects.length], ERC4626, days_);
        _recordSubscribe(id, days_, fee);
    }

    function refuserSubscribe(uint256 subjectSeed, uint32 days_) external checked {
        days_ = _days(days_);
        uint256 fee = subs.feePerDay();
        uint256 cost = fee * days_;
        vm.deal(address(this), address(this).balance + cost);
        uint256 id = refuser.subscribe{value: cost}(subs, subjects[subjectSeed % subjects.length], days_);
        _recordSubscribe(id, days_, fee);
    }

    function extend(uint256 seed, uint256 payerSeed, uint32 days_) external checked {
        (bool found, uint256 id) = _id(seed);
        if (!found || ghosts[id].cancelled) return;
        days_ = _days(days_);
        uint256 cost = ghosts[id].fee * days_;
        address payer = payerSeed % 5 == 4 ? stranger : actors[payerSeed % actors.length];
        vm.deal(payer, payer.balance + cost);
        vm.prank(payer);
        subs.extend{value: cost}(id, days_);
        _recordExtend(id, days_);
    }

    /// A stranger extends a subscription after it has expired, then the subscriber cancels.
    function extendExpiredThenCancel(uint256 seed, uint256 gap, uint32 days_) external checked {
        (bool found, uint256 id) = _id(seed);
        if (!found || ghosts[id].cancelled) return;
        uint256 end = ghosts[id].end;
        if (block.timestamp < end) vm.warp(end + bound(gap, 0, 3 days));
        days_ = _days(days_);
        uint256 cost = ghosts[id].fee * days_;
        vm.deal(stranger, stranger.balance + cost);
        vm.prank(stranger);
        subs.extend{value: cost}(id, days_);
        _recordExtend(id, days_);
        _cancel(id);
    }

    function cancel(uint256 seed) external checked {
        (bool found, uint256 id) = _id(seed);
        if (!found || ghosts[id].cancelled) return;
        _cancel(id);
    }

    function strangerCancel(uint256 seed) external checked {
        (bool found, uint256 id) = _id(seed);
        if (!found) return;
        vm.prank(stranger);
        try subs.cancel(id) {
            _flag("a stranger cancelled");
        } catch (bytes memory err) {
            if (keccak256(err) != keccak256(abi.encodeWithSelector(CheckSubscriptions.NotSubscriber.selector, id))) {
                _flag("a stranger's cancel failed with the wrong error");
            }
        }
    }

    function wrongValue(uint256 seed, uint256 delta, bool onExtend) external checked {
        delta = bound(delta, 1, 1 ether);
        address a = actors[seed % actors.length];
        vm.deal(a, a.balance + 400 ether);
        if (onExtend) {
            (bool found, uint256 id) = _id(seed);
            if (!found || ghosts[id].cancelled) return;
            uint256 cost = ghosts[id].fee * 2;
            uint256 sent = seed % 2 == 0 ? cost + delta : cost - (delta > cost ? cost : delta);
            vm.prank(a);
            try subs.extend{value: sent}(id, 2) {
                _flag("extend took a wrong value");
            } catch (bytes memory err) {
                if (
                    keccak256(err)
                        != keccak256(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, sent, cost))
                ) {
                    _flag("a wrong extend value failed with the wrong error");
                }
            }
        } else {
            uint256 cost = uint256(subs.feePerDay()) * 3;
            uint256 sent = seed % 2 == 0 ? cost + delta : cost - (delta > cost ? cost : delta);
            vm.prank(a);
            try subs.subscribe{value: sent}(143, subjects[0], ERC4626, 3) {
                _flag("subscribe took a wrong value");
            } catch (bytes memory err) {
                if (
                    keccak256(err)
                        != keccak256(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, sent, cost))
                ) {
                    _flag("a wrong subscribe value failed with the wrong error");
                }
            }
        }
    }

    function settle(uint256 seedA, uint256 seedB) external checked {
        (bool found, uint256 a) = _id(seedA);
        if (!found) return;
        (, uint256 b) = _id(seedB);
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        subs.settle(ids);
        // Right after a settle, a live subscription has settled exactly the fee of its started days.
        for (uint256 i; i < 2; ++i) {
            Ghost storage g = ghosts[ids[i]];
            if (!g.cancelled && subs.subscriptionOf(ids[i]).settled != g.fee * ghostStarted(ids[i])) {
                _flag("settle did not move exactly the fee of the started days");
            }
        }
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
        subs.setFeePerDay(uint96(bound(f, 1, 2 ether)));
    }

    function zeroFee() external checked {
        vm.prank(owner);
        try subs.setFeePerDay(0) {
            _flag("the fee was set to 0");
        } catch (bytes memory err) {
            if (keccak256(err) != keccak256(abi.encodeWithSelector(CheckSubscriptions.ZeroFee.selector))) {
                _flag("setFeePerDay(0) failed with the wrong error");
            }
        }
    }

    function warp(uint256 dt) external checked {
        vm.warp(block.timestamp + bound(dt, 0, 4 days));
    }

    receive() external payable {}
}

contract CheckSubscriptionsInvariantTest is Test {
    CheckSubscriptions internal subs;
    SubsHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        subs = new CheckSubscriptions(owner, 0.05 ether);
        handler = new SubsHandler(subs, owner);
        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](13);
        selectors[0] = SubsHandler.subscribe.selector;
        selectors[1] = SubsHandler.refuserSubscribe.selector;
        selectors[2] = SubsHandler.extend.selector;
        selectors[3] = SubsHandler.extendExpiredThenCancel.selector;
        selectors[4] = SubsHandler.cancel.selector;
        selectors[5] = SubsHandler.strangerCancel.selector;
        selectors[6] = SubsHandler.wrongValue.selector;
        selectors[7] = SubsHandler.settle.selector;
        selectors[8] = SubsHandler.withdraw.selector;
        selectors[9] = SubsHandler.setFeePerDay.selector;
        selectors[10] = SubsHandler.zeroFee.selector;
        selectors[11] = SubsHandler.warp.selector;
        selectors[12] = SubsHandler.subscribe.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// The contract holds exactly the escrowed fees plus the earned fees not withdrawn yet.
    function invariant_balanceIsEscrowedPlusEarnedMinusWithdrawn() public view {
        assertEq(address(subs).balance, subs.escrowed() + subs.earned() - subs.withdrawn());
        assertLe(subs.withdrawn(), subs.earned());
        assertEq(subs.withdrawn(), handler.paidOut());
        assertEq(handler.paidIn(), handler.refundedValue() + address(subs).balance + subs.withdrawn());
    }

    /// escrowed is paid - settled over the live subscriptions and earned the sum of settled. Against the model:
    /// paid is the fee times the days bought, the run is the model's run, a live subscription never settled more
    /// than the fee of the days the model has started, and a cancel settled exactly those and refunded the rest.
    function invariant_booksMatchTheModel() public view {
        uint256 n = subs.subscriptionCount();
        uint256 open;
        uint256 settled;
        uint256 paid;
        uint256 cancelled;
        for (uint256 i; i < n; ++i) {
            CheckSubscriptions.Subscription memory s = subs.subscriptionOf(i);
            SubsHandler.Ghost memory g = handler.ghostOf(i);
            uint256 started = handler.ghostStarted(i);
            assertLe(s.settled, s.paid);
            assertEq(s.paid, g.fee * g.daysBought, "paid");
            assertEq(s.feePerDay, g.fee, "fee");
            assertEq(s.startsAt, g.start, "startsAt");
            assertEq(s.endsAt, g.end, "endsAt");
            assertLe(s.settled, g.fee * started, "settled beyond the started days");
            settled += s.settled;
            paid += s.paid;
            if (s.cancelled) {
                ++cancelled;
                assertTrue(g.cancelled);
                assertEq(s.settled, g.fee * started, "cancel settles the started days");
                assertEq(g.refund, s.paid - g.fee * started, "cancel refunds the rest");
                assertFalse(subs.isActive(i));
            } else {
                assertFalse(g.cancelled);
                open += s.paid - s.settled;
                assertEq(subs.isActive(i), block.timestamp < g.end);
            }
        }
        assertEq(subs.escrowed(), open);
        assertEq(subs.earned(), settled);
        assertEq(paid, handler.paidIn());
        assertEq(cancelled, handler.cancels());
    }

    /// earned, withdrawn and every settled only ever grow, and every call that must fail failed as it should.
    function invariant_monotonicAndNoUnexpectedOutcome() public view {
        assertFalse(handler.wentDown());
        assertEq(handler.unexpected(), "");
    }
}
