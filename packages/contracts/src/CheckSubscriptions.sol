// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CheckSubscriptions
/// @notice Prepaid alert subscriptions: a subscriber pays `feePerDay` per day in the native coin for one
///         subject (a contract on some chain) and standard, and gets push alerts when its check result
///         changes, plus a faster re-check cadence (docs/adr/0006). Every check result stays public; a
///         subscription buys delivery and freshness. The contract only keeps the money and the dates; the
///         watcher reads active subscriptions and does the work offchain.
/// @dev Day accounting. A subscription is a run of whole days [startsAt, endsAt), endsAt - startsAt being a
///      multiple of DAY. Day k of the run starts at startsAt + k * DAY, and a day that has started counts as
///      used: at time t the run has min(runDays, (t - startsAt) / DAY + 1) started days, so a new
///      subscription uses its first day at once. Days of earlier runs (see extend) have all started.
///      `paid` is the sum of the fees paid for the subscription (days bought times its own feePerDay), and
///      the fee of the days not started yet is
///          unstarted(t) = (runDays - startedDays(t)) * feePerDay      (0 once the run has ended).
///      settle moves due(t) - settled into earned, with due(t) = paid - unstarted(t), which is
///      min(paid, startedDays * feePerDay) when startedDays counts the days of earlier runs too. So
///      settled <= paid always, and settled only grows.
///      extend(id, days) of a subscription that is still active appends the days at endsAt. Extending one
///      that has expired (block.timestamp >= endsAt) starts a new run now: startsAt = now and endsAt = now +
///      days * DAY, so the days between the old endsAt and now, when the subscription was not active, are
///      never charged. cancel settles, refunds the fee of the days not started (paid - settled after the
///      settle) to the subscriber, and makes the subscription inactive for good, including the rest of the
///      day it has paid for.
///      Books: `escrowed` is the sum of paid - settled over subscriptions that are not cancelled, `earned`
///      the sum of settled over all of them, and withdraw pays out at most earned - withdrawn, so escrowed
///      fees can never be withdrawn. Without forced transfers (selfdestruct, coinbase), the balance is
///      exactly escrowed + earned - withdrawn; the contract has no receive or fallback function, and coins
///      forced in anyway stay locked.
///      Subscription ids are the zero based index of a global list: valid ids are 0..subscriptionCount()-1.
///      A subscriber that refuses the native coin (a contract without a payable receive) cannot cancel with
///      a refund: cancel reverts with TransferFailed and the subscription runs to its end.
///      Roles: the owner is set at deployment and is immutable (no transfer, no renounce), as in
///      CheckRequestDesk; it sets the fee for new subscriptions and withdraws earned fees. If its key is
///      lost, the fee is frozen and earned fees stay locked; subscribers can still cancel.
///      Coins leave only through a call made after every state change, under a reentrancy lock.
contract CheckSubscriptions {
    struct Subscription {
        address subscriber;
        uint64 subjectChainId;
        address subject;
        bytes32 standardId; // keccak256(bytes(standard)), e.g. keccak256("erc4626"), as in the registry
        uint96 feePerDay; // fee per day when the subscription was made; later fee changes do not touch it
        uint64 startsAt; // start of the current run (block.timestamp of subscribe, or of an extend after expiry)
        uint64 endsAt; // end of the current run, exclusive; startsAt + whole days
        uint96 paid; // sum of the fees paid: subscribe and every extend
        uint96 settled; // part of paid moved to earned; never more than paid
        bool cancelled;
    }

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

    error NotOwner();
    error NotSubscriber(uint256 id);
    error ZeroAddress();
    error ZeroChainId();
    error EmptyStandardId();
    error BadDays(uint32 days_);
    error WrongValue(uint256 sent, uint256 expected);
    error PaidOverflow(uint256 id, uint256 paid);
    error UnknownSubscription(uint256 id);
    error AlreadyCancelled(uint256 id);
    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount);
    error Reentrancy();

    /// @notice Length of one paid day, in seconds of block.timestamp.
    uint64 internal constant DAY = 1 days;
    /// @notice Most days one subscribe or extend can pay for.
    uint32 internal constant MAX_DAYS = 365;

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;

    uint96 public feePerDay;
    uint256 public earned;
    uint256 public withdrawn;
    /// @notice Sum of paid - settled over the subscriptions that are not cancelled.
    uint256 public escrowed;

    Subscription[] private _subs;
    uint256 private _lock = 1;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier nonReentrant() {
        _enter();
        _;
        _leave();
    }

    constructor(address owner_, uint96 feePerDay_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        feePerDay = feePerDay_;
        emit FeePerDaySet(feePerDay_);
    }

    /// @notice Pay exactly feePerDay * days_ for `days_` days (1 to MAX_DAYS) of alerts about `subject` on
    ///         chain `subjectChainId` and `standardId`, starting now. The first day counts as used at once.
    function subscribe(uint64 subjectChainId, address subject, bytes32 standardId, uint32 days_)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (subject == address(0)) revert ZeroAddress();
        if (subjectChainId == 0) revert ZeroChainId();
        if (standardId == bytes32(0)) revert EmptyStandardId();
        uint96 fee = feePerDay;
        id = _subs.length;
        uint96 cost = _cost(id, fee, days_, 0);
        uint64 endsAt = uint64(block.timestamp) + uint64(days_) * DAY;
        _subs.push(
            Subscription({
                subscriber: msg.sender,
                subjectChainId: subjectChainId,
                subject: subject,
                standardId: standardId,
                feePerDay: fee,
                startsAt: uint64(block.timestamp),
                endsAt: endsAt,
                paid: cost,
                settled: 0,
                cancelled: false
            })
        );
        escrowed += cost;
        emit Subscribed(id, msg.sender, subjectChainId, subject, standardId, days_, cost, endsAt);
    }

    /// @notice Pay exactly the subscription's own feePerDay * days_ to add `days_` days (1 to MAX_DAYS).
    ///         Anyone may pay; refunds still go to the subscriber. An active subscription gets the days
    ///         appended at endsAt; an expired one starts a new run now, so the days it was not active are
    ///         never charged. Refused once cancelled.
    function extend(uint256 id, uint32 days_) external payable nonReentrant {
        Subscription storage s = _get(id);
        if (s.cancelled) revert AlreadyCancelled(id);
        uint96 cost = _cost(id, s.feePerDay, days_, s.paid);
        uint64 add = uint64(days_) * DAY;
        if (block.timestamp >= s.endsAt) {
            s.startsAt = uint64(block.timestamp);
            s.endsAt = uint64(block.timestamp) + add;
        } else {
            s.endsAt += add;
        }
        s.paid += cost;
        escrowed += cost;
        emit Extended(id, days_, cost, s.endsAt);
    }

    /// @notice Subscriber only: settle, refund the fee of the days not started to the subscriber, and end
    ///         the subscription now (the day in progress is paid and not refunded).
    function cancel(uint256 id) external nonReentrant {
        Subscription storage s = _get(id);
        if (msg.sender != s.subscriber) revert NotSubscriber(id);
        if (s.cancelled) revert AlreadyCancelled(id);
        _settle(id, s);
        uint96 refund = s.paid - s.settled;
        s.cancelled = true;
        escrowed -= refund;
        emit Cancelled(id, refund);
        if (refund > 0) _send(s.subscriber, refund);
    }

    /// @notice Anyone: move the fee of every started day of each subscription in `ids` to earned. Cancelled
    ///         subscriptions and subscriptions with nothing due are skipped; an unknown id reverts.
    function settle(uint256[] calldata ids) external nonReentrant {
        for (uint256 i; i < ids.length; ++i) {
            Subscription storage s = _get(ids[i]);
            if (!s.cancelled) _settle(ids[i], s);
        }
    }

    /// @notice Pay out the earned fees not withdrawn yet, at most 2^96 - 1 wei per call. Escrowed fees stay.
    function withdraw(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = earned - withdrawn;
        if (amount == 0) revert NothingToWithdraw();
        if (amount > type(uint96).max) amount = type(uint96).max;
        withdrawn += amount;
        // casting to 'uint96' is safe because amount was capped at type(uint96).max above
        // forge-lint: disable-next-line(unsafe-typecast)
        emit FeesWithdrawn(to, uint96(amount));
        _send(to, amount);
    }

    /// @notice Fee per day for new subscriptions. Existing subscriptions keep theirs, extensions included.
    function setFeePerDay(uint96 feePerDay_) external onlyOwner {
        feePerDay = feePerDay_;
        emit FeePerDaySet(feePerDay_);
    }

    /// @notice Subscription `id`. Reverts with UnknownSubscription when id >= subscriptionCount().
    function subscriptionOf(uint256 id) external view returns (Subscription memory) {
        return _get(id);
    }

    function subscriptionCount() external view returns (uint256) {
        return _subs.length;
    }

    /// @notice Not cancelled and block.timestamp < endsAt. Reverts with UnknownSubscription for an unknown id.
    function isActive(uint256 id) external view returns (bool) {
        Subscription storage s = _get(id);
        return !s.cancelled && block.timestamp < s.endsAt;
    }

    function _get(uint256 id) private view returns (Subscription storage) {
        if (id >= _subs.length) revert UnknownSubscription(id);
        return _subs[id];
    }

    /// Checks days_ and msg.value and returns fee * days_, which must keep paid within uint96.
    function _cost(uint256 id, uint96 fee, uint32 days_, uint96 paid) private view returns (uint96) {
        if (days_ == 0 || days_ > MAX_DAYS) revert BadDays(days_);
        uint256 cost = uint256(fee) * days_;
        if (msg.value != cost) revert WrongValue(msg.value, cost);
        if (cost > type(uint96).max - paid) revert PaidOverflow(id, uint256(paid) + cost);
        // casting to 'uint96' is safe because cost <= type(uint96).max - paid was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint96(cost);
    }

    /// Moves due - settled to earned, due = paid minus the fee of the days of the run not started yet.
    function _settle(uint256 id, Subscription storage s) private {
        uint256 unstarted;
        if (block.timestamp < s.endsAt) {
            uint256 started = (block.timestamp - s.startsAt) / DAY + 1;
            unstarted = (s.endsAt - s.startsAt) / DAY - started;
        }
        // casting to 'uint96' is safe because unstarted <= runDays, and paid is feePerDay times every day bought
        // forge-lint: disable-next-line(unsafe-typecast)
        uint96 due = s.paid - uint96(unstarted * s.feePerDay);
        uint96 amount = due - s.settled;
        if (amount == 0) return;
        s.settled = due;
        escrowed -= amount;
        earned += amount;
        emit Settled(id, amount);
    }

    function _send(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed(to, amount);
    }

    function _enter() private {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
    }

    function _leave() private {
        _lock = 1;
    }

    function _onlyOwner() private view {
        if (msg.sender != owner) revert NotOwner();
    }
}
