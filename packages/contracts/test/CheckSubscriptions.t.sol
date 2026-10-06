// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckSubscriptions} from "../src/CheckSubscriptions.sol";

/// A subscriber (or owner) contract without a payable receive: refunds and payouts to it fail.
contract RefusesCoins {
    function subscribe(CheckSubscriptions subs, uint32 days_) external payable returns (uint256) {
        return subs.subscribe{value: msg.value}(143, address(0xBEEF), keccak256("erc4626"), days_);
    }

    function cancel(CheckSubscriptions subs, uint256 id) external {
        subs.cancel(id);
    }
}

/// Subscriber that tries to re-enter from the refund of a cancel and records what happened.
contract ReentrantSubscriber {
    enum Mode {
        CancelOther,
        SubscribeAgain,
        ExtendOther,
        SettleOther
    }

    CheckSubscriptions internal immutable subs;
    Mode public mode;
    uint256 public otherId;
    uint256 public received;
    bytes public reentryError;
    bool public reentered;

    constructor(CheckSubscriptions s) {
        subs = s;
    }

    function subscribe(uint32 days_) external payable returns (uint256) {
        return subs.subscribe{value: msg.value}(143, address(0xBEEF), keccak256("erc4626"), days_);
    }

    function cancel(uint256 id) external {
        subs.cancel(id);
    }

    function arm(Mode m, uint256 other) external {
        mode = m;
        otherId = other;
        reentered = false;
        delete reentryError;
    }

    receive() external payable {
        received += msg.value;
        if (reentered) return;
        reentered = true;
        uint256[] memory ids = new uint256[](1);
        ids[0] = otherId;
        if (mode == Mode.CancelOther) {
            try subs.cancel(otherId) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        } else if (mode == Mode.SubscribeAgain) {
            try subs.subscribe{value: 0}(143, address(0xBEEF), keccak256("erc4626"), 1) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        } else if (mode == Mode.ExtendOther) {
            try subs.extend{value: 0}(otherId, 1) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        } else {
            try subs.settle(ids) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        }
    }
}

/// Owner contract whose receive tries to withdraw a second time.
contract ReentrantOwner {
    CheckSubscriptions public subs;
    bytes public reentryError;
    uint256 public received;
    bool internal reentered;

    function setSubs(CheckSubscriptions s) external {
        subs = s;
    }

    function withdraw() external {
        subs.withdraw(payable(address(this)));
    }

    receive() external payable {
        received += msg.value;
        if (reentered) return;
        reentered = true;
        try subs.withdraw(payable(address(this))) {}
        catch (bytes memory err) {
            reentryError = err;
        }
    }
}

contract CheckSubscriptionsTest is Test {
    CheckSubscriptions internal subs;

    address internal owner = makeAddr("owner");
    address internal subscriber = makeAddr("subscriber");
    address internal stranger = makeAddr("stranger");

    uint96 internal constant FEE = 0.05 ether;
    uint64 internal constant DAY = 1 days;
    uint64 internal constant MAINNET = 143;
    uint64 internal constant T0 = 1_700_000_000;
    address internal constant VAULT = 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E;
    address internal constant OTHER = 0x802c91d807A8DaCA257c4708ab264B6520964e44;
    /// keccak256("erc4626"), the registry's standardId for ERC-4626.
    bytes32 internal constant ERC4626 = 0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab;

    event Subscribed(
        uint256 indexed id,
        address indexed subscriber,
        uint64 subjectChainId,
        address indexed subject,
        bytes32 standardId,
        uint32 days_,
        uint96 paid,
        uint64 endsAt
    );
    event Extended(uint256 indexed id, uint32 days_, uint96 paid, uint64 endsAt);
    event Cancelled(uint256 indexed id, uint96 refund);
    event Settled(uint256 indexed id, uint96 amount);
    event FeesWithdrawn(address indexed to, uint96 amount);
    event FeePerDaySet(uint96 feePerDay);

    function setUp() public {
        vm.warp(T0);
        subs = new CheckSubscriptions(owner, FEE);
        vm.deal(subscriber, 1000 ether);
        vm.deal(stranger, 1000 ether);
    }

    function _subscribe(uint32 days_) internal returns (uint256) {
        uint256 cost = uint256(subs.feePerDay()) * days_;
        vm.prank(subscriber);
        return subs.subscribe{value: cost}(MAINNET, VAULT, ERC4626, days_);
    }

    function _extend(address payer, uint256 id, uint32 days_) internal {
        uint256 cost = uint256(subs.subscriptionOf(id).feePerDay) * days_;
        vm.prank(payer);
        subs.extend{value: cost}(id, days_);
    }

    function _settle(uint256 id) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        subs.settle(ids);
    }

    function _cancel(uint256 id) internal {
        vm.prank(subscriber);
        subs.cancel(id);
    }

    function _sub(uint256 id) internal view returns (CheckSubscriptions.Subscription memory) {
        return subs.subscriptionOf(id);
    }

    function _assertBooks() internal view {
        assertEq(address(subs).balance, subs.escrowed() + subs.earned() - subs.withdrawn(), "balance");
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_setsOwnerAndFeeAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit FeePerDaySet(FEE);
        CheckSubscriptions s = new CheckSubscriptions(owner, FEE);
        assertEq(s.owner(), owner);
        assertEq(s.feePerDay(), FEE);
        assertEq(s.subscriptionCount(), 0);
        assertEq(s.earned(), 0);
        assertEq(s.withdrawn(), 0);
        assertEq(s.escrowed(), 0);
    }

    function test_constructor_rejectsAZeroOwner() public {
        vm.expectRevert(CheckSubscriptions.ZeroAddress.selector);
        new CheckSubscriptions(address(0), FEE);
    }

    // ---------------------------------------------------------------- subscribe

    function test_subscribe_storesTheSubscriptionAndEscrowsThePayment() public {
        vm.expectEmit(true, true, true, true);
        emit Subscribed(0, subscriber, MAINNET, VAULT, ERC4626, 30, 30 * FEE, T0 + 30 * DAY);
        uint256 id = _subscribe(30);
        assertEq(id, 0);
        CheckSubscriptions.Subscription memory s = _sub(0);
        assertEq(s.subscriber, subscriber);
        assertEq(s.subjectChainId, MAINNET);
        assertEq(s.subject, VAULT);
        assertEq(s.standardId, ERC4626);
        assertEq(s.feePerDay, FEE);
        assertEq(s.startsAt, T0);
        assertEq(s.endsAt, T0 + 30 * DAY);
        assertEq(s.paid, 30 * FEE);
        assertEq(s.settled, 0);
        assertFalse(s.cancelled);
        assertTrue(subs.isActive(0));
        assertEq(subs.escrowed(), 30 * FEE);
        assertEq(subs.earned(), 0);
        assertEq(address(subs).balance, 30 * FEE);
        vm.prank(stranger);
        assertEq(subs.subscribe{value: FEE}(10143, OTHER, keccak256("erc20"), 1), 1);
        assertEq(_sub(1).subscriber, stranger);
        assertEq(subs.subscriptionCount(), 2);
        assertEq(subs.escrowed(), 31 * FEE);
        _assertBooks();
    }

    function test_subscribe_requiresExactlyFeeTimesDays() public {
        vm.startPrank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, 3 * FEE - 1, 3 * FEE));
        subs.subscribe{value: 3 * FEE - 1}(MAINNET, VAULT, ERC4626, 3);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, 3 * FEE + 1, 3 * FEE));
        subs.subscribe{value: 3 * FEE + 1}(MAINNET, VAULT, ERC4626, 3);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, 0, 3 * FEE));
        subs.subscribe(MAINNET, VAULT, ERC4626, 3);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, FEE, 3 * FEE));
        subs.subscribe{value: FEE}(MAINNET, VAULT, ERC4626, 3);
        vm.stopPrank();
        assertEq(subs.subscriptionCount(), 0);
    }

    function test_subscribe_takesOneTo365Days() public {
        vm.startPrank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.BadDays.selector, 0));
        subs.subscribe(MAINNET, VAULT, ERC4626, 0);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.BadDays.selector, 366));
        subs.subscribe{value: 366 * FEE}(MAINNET, VAULT, ERC4626, 366);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.BadDays.selector, type(uint32).max));
        subs.subscribe(MAINNET, VAULT, ERC4626, type(uint32).max);
        uint256 one = subs.subscribe{value: FEE}(MAINNET, VAULT, ERC4626, 1);
        uint256 year = subs.subscribe{value: 365 * FEE}(MAINNET, VAULT, ERC4626, 365);
        vm.stopPrank();
        assertEq(_sub(one).endsAt, T0 + DAY);
        assertEq(_sub(year).endsAt, T0 + 365 * DAY);
        assertEq(_sub(year).paid, 365 * FEE);
    }

    function test_subscribe_rejectsBadInputs() public {
        vm.startPrank(subscriber);
        vm.expectRevert(CheckSubscriptions.ZeroAddress.selector);
        subs.subscribe{value: FEE}(MAINNET, address(0), ERC4626, 1);
        vm.expectRevert(CheckSubscriptions.ZeroChainId.selector);
        subs.subscribe{value: FEE}(0, VAULT, ERC4626, 1);
        vm.expectRevert(CheckSubscriptions.EmptyStandardId.selector);
        subs.subscribe{value: FEE}(MAINNET, VAULT, bytes32(0), 1);
        vm.stopPrank();
    }

    function test_subscribe_isFreeWhenTheFeeIsZero() public {
        vm.prank(owner);
        subs.setFeePerDay(0);
        vm.prank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, 1, 0));
        subs.subscribe{value: 1}(MAINNET, VAULT, ERC4626, 5);
        uint256 id = _subscribe(5);
        assertEq(_sub(id).paid, 0);
        assertTrue(subs.isActive(id));
        _extend(stranger, id, 2);
        assertEq(_sub(id).endsAt, T0 + 7 * DAY);
        // Settling and cancelling a free subscription move nothing and send nothing.
        vm.recordLogs();
        _settle(id);
        assertEq(vm.getRecordedLogs().length, 0);
        _cancel(id);
        assertFalse(subs.isActive(id));
        assertEq(subs.escrowed(), 0);
        assertEq(subs.earned(), 0);
    }

    function test_subscribe_paidMustFitUint96() public {
        vm.prank(owner);
        subs.setFeePerDay(type(uint96).max);
        uint256 two = 2 * uint256(type(uint96).max);
        vm.deal(subscriber, two);
        vm.prank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.PaidOverflow.selector, 0, two));
        subs.subscribe{value: two}(MAINNET, VAULT, ERC4626, 2);
        vm.prank(subscriber);
        uint256 id = subs.subscribe{value: type(uint96).max}(MAINNET, VAULT, ERC4626, 1);
        assertEq(_sub(id).paid, type(uint96).max);
    }

    function testFuzz_subscribe_acceptsOnlyFeeTimesDays(uint96 fee, uint32 days_, uint256 sent) public {
        days_ = uint32(bound(days_, 1, 365));
        fee = uint96(bound(fee, 0, type(uint96).max / 365));
        uint256 cost = uint256(fee) * days_;
        sent = bound(sent, 0, 2 * cost + 1);
        vm.prank(owner);
        subs.setFeePerDay(fee);
        vm.deal(subscriber, sent);
        vm.prank(subscriber);
        if (sent != cost) vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, sent, cost));
        subs.subscribe{value: sent}(MAINNET, VAULT, ERC4626, days_);
        assertEq(subs.escrowed(), sent == cost ? cost : 0);
        _assertBooks();
    }

    // ---------------------------------------------------------------- ids, subscriptionOf, isActive

    function test_ids_startAtZero_unknownIdsAreRefusedEverywhere() public {
        uint256[] memory zero = new uint256[](1);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 0));
        subs.subscriptionOf(0);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 0));
        subs.isActive(0);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 0));
        subs.settle(zero);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 0));
        subs.cancel(0);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 0));
        subs.extend{value: FEE}(0, 1);
        assertEq(_subscribe(1), 0);
        assertEq(subs.subscriptionCount(), 1);
        // subscriptionCount() is the first id that does not exist yet.
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 1));
        subs.subscriptionOf(1);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, type(uint256).max));
        subs.isActive(type(uint256).max);
    }

    function test_isActive_untilEndsAtExclusive_andNeverAfterCancel() public {
        uint256 a = _subscribe(2);
        uint256 b = _subscribe(2);
        vm.warp(T0 + 2 * DAY - 1);
        assertTrue(subs.isActive(a));
        vm.warp(T0 + 2 * DAY);
        assertFalse(subs.isActive(a));
        vm.warp(T0 + DAY);
        _cancel(b);
        assertFalse(subs.isActive(b));
    }

    // ---------------------------------------------------------------- settle

    function test_settle_aStartedDayCounts_exactlyAtTheBoundaryTheNextDayHasStarted() public {
        uint256 id = _subscribe(3);
        // The first day starts with the subscription.
        vm.expectEmit(true, false, false, true);
        emit Settled(id, FEE);
        _settle(id);
        assertEq(subs.earned(), FEE);
        assertEq(_sub(id).settled, FEE);
        vm.warp(T0 + DAY - 1);
        vm.recordLogs();
        _settle(id);
        assertEq(vm.getRecordedLogs().length, 0, "nothing due, no event");
        assertEq(subs.earned(), FEE);
        vm.warp(T0 + DAY);
        _settle(id);
        assertEq(subs.earned(), 2 * FEE);
        vm.warp(T0 + 2 * DAY);
        _settle(id);
        assertEq(subs.earned(), 3 * FEE);
        vm.warp(T0 + 30 * DAY);
        _settle(id);
        assertEq(subs.earned(), 3 * FEE, "never more than paid");
        assertEq(_sub(id).settled, _sub(id).paid);
        assertEq(subs.escrowed(), 0);
        _assertBooks();
    }

    function test_settle_isOpenToAnyone_takesManyIds_skipsCancelledOnes() public {
        uint256 a = _subscribe(10);
        uint256 b = _subscribe(10);
        uint256 c = _subscribe(10);
        vm.warp(T0 + 3 * DAY + 5);
        _cancel(b);
        uint256[] memory ids = new uint256[](5);
        (ids[0], ids[1], ids[2], ids[3], ids[4]) = (a, b, c, a, c);
        vm.prank(stranger);
        subs.settle(ids);
        assertEq(_sub(a).settled, 4 * FEE);
        assertEq(_sub(b).settled, 4 * FEE, "settled by cancel, not touched again");
        assertEq(_sub(c).settled, 4 * FEE);
        assertEq(subs.earned(), 12 * FEE);
        assertEq(subs.escrowed(), 12 * FEE);
        // An unknown id makes the whole call revert.
        ids[4] = 3;
        vm.warp(T0 + 4 * DAY);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.UnknownSubscription.selector, 3));
        subs.settle(ids);
        assertEq(subs.earned(), 12 * FEE);
        subs.settle(new uint256[](0));
        _assertBooks();
    }

    function testFuzz_settle_dueIsTheStartedDays(uint32 days_, uint64 elapsed) public {
        days_ = uint32(bound(days_, 1, 365));
        elapsed = uint64(bound(elapsed, 0, 400 days));
        uint256 id = _subscribe(days_);
        vm.warp(T0 + elapsed);
        _settle(id);
        uint256 started = elapsed / DAY + 1;
        if (started > days_) started = days_;
        assertEq(_sub(id).settled, started * FEE);
        assertEq(subs.escrowed(), (days_ - started) * FEE);
        uint256 before = subscriber.balance;
        _cancel(id);
        assertEq(subscriber.balance, before + (days_ - started) * FEE);
        assertEq(subs.escrowed(), 0);
        assertEq(subs.earned(), started * FEE);
        _assertBooks();
    }

    // ---------------------------------------------------------------- extend

    function test_extend_anActiveSubscriptionAppendsAtEndsAt_atItsOwnFee() public {
        uint256 id = _subscribe(3);
        vm.prank(owner);
        subs.setFeePerDay(1 ether);
        vm.warp(T0 + DAY + 7);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, 2 ether, 2 * FEE));
        subs.extend{value: 2 ether}(id, 2);
        vm.expectEmit(true, false, false, true);
        emit Extended(id, 2, 2 * FEE, T0 + 5 * DAY);
        _extend(stranger, id, 2);
        CheckSubscriptions.Subscription memory s = _sub(id);
        assertEq(s.startsAt, T0);
        assertEq(s.endsAt, T0 + 5 * DAY);
        assertEq(s.paid, 5 * FEE);
        assertEq(s.subscriber, subscriber, "the payer does not become the subscriber");
        _settle(id);
        assertEq(subs.earned(), 2 * FEE);
        vm.warp(T0 + 4 * DAY);
        _settle(id);
        assertEq(subs.earned(), 5 * FEE);
        _assertBooks();
    }

    function test_extend_anExpiredSubscriptionRestartsNow_theGapIsNotCharged() public {
        uint256 id = _subscribe(2);
        vm.warp(T0 + 5 * DAY + 100);
        assertFalse(subs.isActive(id));
        uint64 now_ = uint64(block.timestamp);
        vm.expectEmit(true, false, false, true);
        emit Extended(id, 3, 3 * FEE, now_ + 3 * DAY);
        _extend(subscriber, id, 3);
        CheckSubscriptions.Subscription memory s = _sub(id);
        assertEq(s.startsAt, now_);
        assertEq(s.endsAt, now_ + 3 * DAY);
        assertEq(s.paid, 5 * FEE);
        assertTrue(subs.isActive(id));
        // Both old days and the first new day have started; the three gap days were never bought.
        _settle(id);
        assertEq(_sub(id).settled, 3 * FEE);
        uint256 before = subscriber.balance;
        _cancel(id);
        assertEq(subscriber.balance, before + 2 * FEE);
        assertEq(subs.earned(), 3 * FEE);
        _assertBooks();
    }

    function test_extend_exactlyAtEndsAt_isARestartThatChangesNothing() public {
        uint256 id = _subscribe(2);
        vm.warp(T0 + 2 * DAY);
        _extend(subscriber, id, 1);
        assertEq(_sub(id).startsAt, T0 + 2 * DAY);
        assertEq(_sub(id).endsAt, T0 + 3 * DAY);
        _settle(id);
        assertEq(subs.earned(), 3 * FEE);
        assertEq(subs.escrowed(), 0);
    }

    function test_extend_isRefusedOnceCancelled_andChecksDaysAndValue() public {
        uint256 id = _subscribe(3);
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.BadDays.selector, 0));
        subs.extend(id, 0);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.BadDays.selector, 366));
        subs.extend{value: 366 * FEE}(id, 366);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.WrongValue.selector, 0, FEE));
        subs.extend(id, 1);
        vm.stopPrank();
        _extend(stranger, id, 365);
        assertEq(_sub(id).endsAt, T0 + 368 * DAY);
        _cancel(id);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.AlreadyCancelled.selector, id));
        subs.extend{value: FEE}(id, 1);
    }

    function test_extend_paidMustFitUint96() public {
        vm.prank(owner);
        subs.setFeePerDay(type(uint96).max / 2);
        uint96 fee = type(uint96).max / 2;
        vm.deal(subscriber, 10 * uint256(fee));
        vm.prank(subscriber);
        uint256 id = subs.subscribe{value: 2 * uint256(fee)}(MAINNET, VAULT, ERC4626, 2);
        vm.prank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.PaidOverflow.selector, id, 3 * uint256(fee)));
        subs.extend{value: fee}(id, 1);
    }

    // ---------------------------------------------------------------- cancel

    function test_cancel_onlyTheSubscriber() public {
        uint256 id = _subscribe(3);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.NotSubscriber.selector, id));
        subs.cancel(id);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.NotSubscriber.selector, id));
        subs.cancel(id);
    }

    function test_cancel_settlesThenRefundsTheDaysNotStarted() public {
        uint256 id = _subscribe(10);
        vm.warp(T0 + 2 * DAY + DAY / 2);
        uint256 before = subscriber.balance;
        vm.expectEmit(true, false, false, true);
        emit Settled(id, 3 * FEE);
        vm.expectEmit(true, false, false, true);
        emit Cancelled(id, 7 * FEE);
        _cancel(id);
        assertEq(subscriber.balance, before + 7 * FEE);
        CheckSubscriptions.Subscription memory s = _sub(id);
        assertTrue(s.cancelled);
        assertEq(s.settled, 3 * FEE);
        assertEq(s.paid, 10 * FEE);
        assertFalse(subs.isActive(id));
        assertEq(subs.earned(), 3 * FEE);
        assertEq(subs.escrowed(), 0);
        assertEq(address(subs).balance, 3 * FEE);
        vm.prank(subscriber);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.AlreadyCancelled.selector, id));
        subs.cancel(id);
        vm.warp(T0 + 20 * DAY);
        _settle(id);
        assertEq(subs.earned(), 3 * FEE, "a cancelled subscription earns nothing more");
        _assertBooks();
    }

    function test_cancel_atADayBoundaryTheNewDayIsUsed() public {
        uint256 id = _subscribe(5);
        vm.warp(T0 + DAY);
        uint256 before = subscriber.balance;
        _cancel(id);
        assertEq(subscriber.balance, before + 3 * FEE);
        assertEq(subs.earned(), 2 * FEE);
    }

    function test_cancel_rightAfterSubscribingKeepsTheFirstDay() public {
        uint256 id = _subscribe(1);
        uint256 before = subscriber.balance;
        vm.recordLogs();
        _cancel(id);
        assertEq(subscriber.balance, before);
        assertEq(subs.earned(), FEE);
        // Settled and Cancelled(id, 0): no refund call.
        assertEq(vm.getRecordedLogs().length, 2);
        _assertBooks();
    }

    function test_cancel_afterTheEndRefundsNothing_evenToAContractThatRefusesCoins() public {
        RefusesCoins c = new RefusesCoins();
        uint256 id = c.subscribe{value: 2 * FEE}(subs, 2);
        vm.warp(T0 + 3 * DAY);
        c.cancel(subs, id);
        assertTrue(_sub(id).cancelled);
        assertEq(subs.earned(), 2 * FEE);
        assertEq(subs.escrowed(), 0);
        _assertBooks();
    }

    function test_cancel_refundGoesToTheSubscriberNotToWhoeverExtended() public {
        uint256 id = _subscribe(1);
        _extend(stranger, id, 4);
        uint256 strangerBefore = stranger.balance;
        uint256 before = subscriber.balance;
        _cancel(id);
        assertEq(subscriber.balance, before + 4 * FEE);
        assertEq(stranger.balance, strangerBefore);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CheckSubscriptions.NotOwner.selector);
        subs.withdraw(payable(stranger));
        vm.prank(subscriber);
        vm.expectRevert(CheckSubscriptions.NotOwner.selector);
        subs.withdraw(payable(subscriber));
    }

    function test_withdraw_paysOnlyEarnedFeesNeverEscrowedOnes() public {
        vm.prank(owner);
        vm.expectRevert(CheckSubscriptions.NothingToWithdraw.selector);
        subs.withdraw(payable(owner));
        uint256 id = _subscribe(10);
        vm.warp(T0 + DAY);
        vm.prank(owner);
        vm.expectRevert(CheckSubscriptions.NothingToWithdraw.selector);
        subs.withdraw(payable(owner));
        _settle(id);
        address payable to = payable(makeAddr("treasury"));
        vm.expectEmit(true, false, false, true);
        emit FeesWithdrawn(to, 2 * FEE);
        vm.prank(owner);
        subs.withdraw(to);
        assertEq(to.balance, 2 * FEE);
        assertEq(subs.withdrawn(), 2 * FEE);
        assertEq(address(subs).balance, subs.escrowed());
        assertEq(subs.escrowed(), 8 * FEE);
        vm.startPrank(owner);
        vm.expectRevert(CheckSubscriptions.NothingToWithdraw.selector);
        subs.withdraw(to);
        vm.expectRevert(CheckSubscriptions.ZeroAddress.selector);
        subs.withdraw(payable(address(0)));
        vm.stopPrank();
        vm.warp(T0 + 10 * DAY);
        _settle(id);
        vm.prank(owner);
        subs.withdraw(to);
        assertEq(to.balance, 10 * FEE);
        assertEq(address(subs).balance, 0);
        _assertBooks();
    }

    function test_withdraw_paysAtMostUint96PerCall() public {
        vm.prank(owner);
        subs.setFeePerDay(type(uint96).max);
        vm.deal(subscriber, 2 * uint256(type(uint96).max));
        vm.startPrank(subscriber);
        uint256 a = subs.subscribe{value: type(uint96).max}(MAINNET, VAULT, ERC4626, 1);
        uint256 b = subs.subscribe{value: type(uint96).max}(MAINNET, OTHER, ERC4626, 1);
        vm.stopPrank();
        uint256[] memory ids = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        subs.settle(ids);
        assertEq(subs.earned(), 2 * uint256(type(uint96).max));
        address payable to = payable(makeAddr("treasury"));
        vm.expectEmit(true, false, false, true);
        emit FeesWithdrawn(to, type(uint96).max);
        vm.prank(owner);
        subs.withdraw(to);
        assertEq(to.balance, type(uint96).max);
        vm.prank(owner);
        subs.withdraw(to);
        assertEq(to.balance, 2 * uint256(type(uint96).max));
        assertEq(subs.withdrawn(), subs.earned());
        _assertBooks();
    }

    // ---------------------------------------------------------------- setFeePerDay

    function test_setFeePerDay_onlyOwner_onlyNewSubscriptionsPayIt() public {
        uint256 old = _subscribe(2);
        vm.prank(stranger);
        vm.expectRevert(CheckSubscriptions.NotOwner.selector);
        subs.setFeePerDay(1);
        vm.expectEmit(false, false, false, true);
        emit FeePerDaySet(1 ether);
        vm.prank(owner);
        subs.setFeePerDay(1 ether);
        assertEq(subs.feePerDay(), 1 ether);
        uint256 id = _subscribe(2);
        assertEq(_sub(id).feePerDay, 1 ether);
        assertEq(_sub(id).paid, 2 ether);
        assertEq(_sub(old).feePerDay, FEE);
        uint256 before = subscriber.balance;
        _cancel(old);
        assertEq(subscriber.balance, before + FEE, "refunded at the fee it paid");
    }

    // ---------------------------------------------------------------- failed transfers

    function test_refusedRefund_cancelRevertsAndTheSubscriptionRunsToItsEnd() public {
        RefusesCoins c = new RefusesCoins();
        uint256 id = c.subscribe{value: 3 * FEE}(subs, 3);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.TransferFailed.selector, address(c), 2 * FEE));
        c.cancel(subs, id);
        assertFalse(_sub(id).cancelled);
        assertEq(_sub(id).settled, 0, "the settle of the reverted cancel is undone");
        assertTrue(subs.isActive(id));
        vm.warp(T0 + 3 * DAY);
        _settle(id);
        assertEq(subs.earned(), 3 * FEE);
        _assertBooks();
    }

    function test_refusedPayout_revertsAndNothingIsWithdrawn() public {
        RefusesCoins c = new RefusesCoins();
        _settle(_subscribe(1));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CheckSubscriptions.TransferFailed.selector, address(c), FEE));
        subs.withdraw(payable(address(c)));
        assertEq(subs.withdrawn(), 0);
        assertEq(address(subs).balance, FEE);
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrancy_aRefundCannotReenterAnything() public {
        ReentrantSubscriber r = new ReentrantSubscriber(subs);
        uint256[4] memory ids;
        for (uint256 i; i < 4; ++i) {
            ids[i] = r.subscribe{value: 5 * FEE}(5);
        }
        uint256 other = r.subscribe{value: 5 * FEE}(5);
        // A free subscription, so the nested subscribe and extend would pass their value checks.
        vm.prank(owner);
        subs.setFeePerDay(0);
        uint256 free = r.subscribe(1);
        ReentrantSubscriber.Mode[4] memory modes = [
            ReentrantSubscriber.Mode.CancelOther,
            ReentrantSubscriber.Mode.SubscribeAgain,
            ReentrantSubscriber.Mode.SettleOther,
            ReentrantSubscriber.Mode.ExtendOther
        ];
        uint256[4] memory targets = [other, 0, other, free];
        for (uint256 i; i < 4; ++i) {
            r.arm(modes[i], targets[i]);
            r.cancel(ids[i]);
            assertEq(r.reentryError(), abi.encodeWithSelector(CheckSubscriptions.Reentrancy.selector));
            assertTrue(_sub(ids[i]).cancelled);
            _assertBooks();
        }
        assertEq(r.received(), 4 * 4 * FEE);
        // None of the nested calls changed anything, though each succeeds on its own.
        assertFalse(_sub(other).cancelled);
        assertEq(_sub(other).settled, 0);
        assertEq(_sub(free).endsAt, T0 + DAY);
        assertEq(subs.subscriptionCount(), 6);
        vm.prank(address(r));
        subs.extend(free, 1);
        assertEq(_sub(free).endsAt, T0 + 2 * DAY);
        _settle(other);
        assertEq(_sub(other).settled, FEE);
        assertEq(subs.escrowed(), 4 * FEE);
        _assertBooks();
    }

    function test_reentrancy_aPayoutCannotWithdrawAgain() public {
        ReentrantOwner o = new ReentrantOwner();
        CheckSubscriptions s = new CheckSubscriptions(address(o), FEE);
        o.setSubs(s);
        vm.prank(subscriber);
        uint256 id = s.subscribe{value: 2 * FEE}(MAINNET, VAULT, ERC4626, 2);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        s.settle(ids);
        o.withdraw();
        assertEq(o.reentryError(), abi.encodeWithSelector(CheckSubscriptions.Reentrancy.selector));
        assertEq(o.received(), FEE);
        assertEq(address(s).balance, FEE);
        assertEq(s.escrowed(), FEE);
        assertEq(s.withdrawn(), FEE);
    }
}
