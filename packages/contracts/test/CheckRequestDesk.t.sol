// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckAttestationRegistry} from "../src/CheckAttestationRegistry.sol";
import {CheckRequestDesk} from "../src/CheckRequestDesk.sol";

/// A requester (or owner) contract without a payable receive: refunds and payouts to it fail.
contract RefusesCoins {
    function request(CheckRequestDesk desk, bytes32 standardId) external payable returns (uint256) {
        return desk.requestCheck{value: msg.value}(143, address(0xBEEF), standardId);
    }
}

/// Requester that tries to re-enter the desk from its receive function and records what happened.
contract ReentrantRequester {
    enum Mode {
        RefundOther,
        RequestAgain
    }

    CheckRequestDesk internal immutable desk;
    Mode public mode;
    uint256 public otherId;
    uint256 public received;
    bytes public reentryError;
    bool public reentered;

    constructor(CheckRequestDesk d) {
        desk = d;
    }

    function request(bytes32 standardId) external payable returns (uint256) {
        return desk.requestCheck{value: msg.value}(143, address(0xBEEF), standardId);
    }

    function arm(Mode m, uint256 other) external {
        mode = m;
        otherId = other;
    }

    receive() external payable {
        received += msg.value;
        if (reentered) return;
        reentered = true;
        if (mode == Mode.RefundOther) {
            try desk.refundExpired(otherId) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        } else {
            try desk.requestCheck{value: msg.value}(143, address(0xBEEF), keccak256("erc4626")) {}
            catch (bytes memory err) {
                reentryError = err;
            }
        }
    }
}

/// Owner contract whose receive tries to withdraw a second time.
contract ReentrantOwner {
    CheckRequestDesk public desk;
    bytes public reentryError;
    uint256 public received;
    bool internal reentered;

    function setDesk(CheckRequestDesk d) external {
        desk = d;
    }

    function withdraw() external {
        desk.withdraw(payable(address(this)));
    }

    receive() external payable {
        received += msg.value;
        if (reentered) return;
        reentered = true;
        try desk.withdraw(payable(address(this))) {}
        catch (bytes memory err) {
            reentryError = err;
        }
    }
}

contract CheckRequestDeskTest is Test {
    CheckAttestationRegistry internal reg;
    CheckRequestDesk internal desk;

    address internal owner = makeAddr("owner");
    address internal worker = makeAddr("worker");
    address internal requester = makeAddr("requester");
    address internal stranger = makeAddr("stranger");

    uint96 internal constant FEE = 0.5 ether;
    uint64 internal constant TIMEOUT = 6 hours;
    uint64 internal constant MAINNET = 143;
    address internal constant VAULT = 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E;
    address internal constant OTHER = 0x802c91d807A8DaCA257c4708ab264B6520964e44;
    /// keccak256("erc4626"), the registry's standardId for ERC-4626.
    bytes32 internal constant ERC4626 = 0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab;
    bytes32 internal constant ERC20 = keccak256("erc20");
    bytes32 internal constant NOT_ERC4626 = "not-erc4626";

    uint64 internal nextBlock = 100;

    event CheckRequested(
        uint256 indexed id,
        address indexed requester,
        uint64 subjectChainId,
        address indexed subject,
        bytes32 standardId,
        uint96 fee
    );
    event CheckFulfilled(uint256 indexed id, uint256 attestationId);
    event CheckRejected(uint256 indexed id, bytes32 reasonCode);
    event CheckRefunded(uint256 indexed id);
    event FeesWithdrawn(address to, uint256 amount);
    event FeeSet(uint96 fee);
    event WorkerSet(address worker);

    function setUp() public {
        vm.warp(1_700_000_000);
        reg = new CheckAttestationRegistry();
        reg.setIssuer(worker, true);
        desk = new CheckRequestDesk(owner, worker, address(reg), FEE, TIMEOUT);
        vm.deal(requester, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function _request() internal returns (uint256) {
        return _requestFor(MAINNET, VAULT, ERC4626);
    }

    function _requestFor(uint64 chainId, address subject, bytes32 standardId) internal returns (uint256) {
        uint96 f = desk.fee();
        vm.prank(requester);
        return desk.requestCheck{value: f}(chainId, subject, standardId);
    }

    /// An all-pass attestation by the worker (a registry issuer); blocks increase so none is OlderThanLatest.
    function _attest(uint64 chainId, address subject, bytes32 standardId) internal returns (uint256) {
        CheckAttestationRegistry.AttestParams memory p = CheckAttestationRegistry.AttestParams({
            subjectChainId: chainId,
            subject: subject,
            standardId: standardId,
            blockNumber: nextBlock++,
            implementationKey: keccak256("impl"),
            subjectCodeHash: keccak256("code"),
            suiteHash: keccak256("suite"),
            reportHash: keccak256("report"),
            passCount: 30,
            failCount: 0,
            inconclusiveCount: 0,
            notApplicableCount: 0,
            passedBitmap: (uint256(1) << 30) - 1,
            failedBitmap: 0,
            reportURI: "https://example.org/checks/143/vault/100-0011223344556677.json"
        });
        vm.prank(worker);
        return reg.attest(p);
    }

    function _attestVault() internal returns (uint256) {
        return _attest(MAINNET, VAULT, ERC4626);
    }

    function _fulfill(uint256 id, uint256 attestationId) internal {
        vm.prank(worker);
        desk.fulfill(id, attestationId);
    }

    function _status(uint256 id) internal view returns (CheckRequestDesk.RequestStatus) {
        return desk.requestOf(id).status;
    }

    function _notPending(uint256 id, CheckRequestDesk.RequestStatus s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(CheckRequestDesk.NotPending.selector, id, s);
    }

    function _assertBooks() internal view {
        assertEq(address(desk).balance, desk.escrowed() + desk.earned() - desk.withdrawn(), "balance");
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_setsEverythingAndEmits() public {
        vm.expectEmit(false, false, false, true);
        emit WorkerSet(worker);
        vm.expectEmit(false, false, false, true);
        emit FeeSet(FEE);
        CheckRequestDesk d = new CheckRequestDesk(owner, worker, address(reg), FEE, TIMEOUT);
        assertEq(d.owner(), owner);
        assertEq(d.worker(), worker);
        assertEq(address(d.registry()), address(reg));
        assertEq(d.fee(), FEE);
        assertEq(d.timeout(), TIMEOUT);
        assertEq(d.requestCount(), 0);
        assertEq(d.earned(), 0);
        assertEq(d.withdrawn(), 0);
        assertEq(d.escrowed(), 0);
    }

    function test_constructor_rejectsBadArguments() public {
        vm.expectRevert(CheckRequestDesk.ZeroAddress.selector);
        new CheckRequestDesk(address(0), worker, address(reg), FEE, TIMEOUT);
        vm.expectRevert(CheckRequestDesk.ZeroAddress.selector);
        new CheckRequestDesk(owner, address(0), address(reg), FEE, TIMEOUT);
        vm.expectRevert(CheckRequestDesk.ZeroAddress.selector);
        new CheckRequestDesk(owner, worker, address(0), FEE, TIMEOUT);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.RegistryWithoutCode.selector, stranger));
        new CheckRequestDesk(owner, worker, stranger, FEE, TIMEOUT);
        vm.expectRevert(CheckRequestDesk.ZeroTimeout.selector);
        new CheckRequestDesk(owner, worker, address(reg), FEE, 0);
    }

    // ---------------------------------------------------------------- requestCheck

    function test_requestCheck_storesTheRequestAndEscrowsTheFee() public {
        vm.expectEmit(true, true, true, true);
        emit CheckRequested(0, requester, MAINNET, VAULT, ERC4626, FEE);
        uint256 id = _request();
        assertEq(id, 0);
        CheckRequestDesk.Request memory r = desk.requestOf(0);
        assertEq(r.requester, requester);
        assertEq(r.subjectChainId, MAINNET);
        assertEq(r.subject, VAULT);
        assertEq(r.standardId, ERC4626);
        assertEq(r.fee, FEE);
        assertEq(r.requestedAt, block.timestamp);
        assertEq(uint8(r.status), uint8(CheckRequestDesk.RequestStatus.Pending));
        assertEq(r.attestationId, 0);
        assertEq(r.rejectReason, bytes32(0));
        assertEq(desk.escrowed(), FEE);
        assertEq(desk.earned(), 0);
        assertEq(address(desk).balance, FEE);
        assertEq(_requestFor(10143, OTHER, ERC20), 1);
        assertEq(desk.requestCount(), 2);
        assertEq(desk.escrowed(), 2 * uint256(FEE));
        _assertBooks();
    }

    function test_requestCheck_requiresTheExactFee() public {
        vm.startPrank(requester);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.WrongFee.selector, uint256(FEE) - 1, FEE));
        desk.requestCheck{value: FEE - 1}(MAINNET, VAULT, ERC4626);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.WrongFee.selector, uint256(FEE) + 1, FEE));
        desk.requestCheck{value: FEE + 1}(MAINNET, VAULT, ERC4626);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.WrongFee.selector, 0, FEE));
        desk.requestCheck(MAINNET, VAULT, ERC4626);
        vm.stopPrank();
        assertEq(desk.requestCount(), 0);
    }

    function test_requestCheck_rejectsBadInputs() public {
        vm.startPrank(requester);
        vm.expectRevert(CheckRequestDesk.ZeroAddress.selector);
        desk.requestCheck{value: FEE}(MAINNET, address(0), ERC4626);
        vm.expectRevert(CheckRequestDesk.ZeroChainId.selector);
        desk.requestCheck{value: FEE}(0, VAULT, ERC4626);
        vm.expectRevert(CheckRequestDesk.EmptyStandardId.selector);
        desk.requestCheck{value: FEE}(MAINNET, VAULT, bytes32(0));
        vm.stopPrank();
    }

    function test_requestCheck_isFreeWhenTheFeeIsZero() public {
        vm.prank(owner);
        desk.setFee(0);
        vm.prank(requester);
        uint256 id = desk.requestCheck(MAINNET, VAULT, ERC4626);
        assertEq(desk.requestOf(id).fee, 0);
        vm.prank(requester);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.WrongFee.selector, 1, uint96(0)));
        desk.requestCheck{value: 1}(MAINNET, VAULT, ERC4626);
        // A free request can still be rejected (a zero-value refund) and refunded.
        vm.prank(worker);
        desk.reject(id, NOT_ERC4626);
        assertEq(desk.escrowed(), 0);
    }

    function testFuzz_requestCheck_acceptsOnlyTheFee(uint96 f, uint96 sent) public {
        vm.prank(owner);
        desk.setFee(f);
        vm.deal(requester, sent);
        vm.prank(requester);
        if (sent != f) vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.WrongFee.selector, uint256(sent), f));
        desk.requestCheck{value: sent}(MAINNET, VAULT, ERC4626);
        assertEq(desk.escrowed(), sent == f ? f : 0);
        _assertBooks();
    }

    // ---------------------------------------------------------------- ids and requestOf

    function test_ids_startAtZero_requestOfUnknownReverts() public {
        assertEq(desk.requestCount(), 0);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownRequest.selector, 0));
        desk.requestOf(0);
        assertEq(_request(), 0);
        assertEq(desk.requestCount(), 1);
        assertEq(desk.requestOf(0).subject, VAULT);
        // requestCount() is the first id that does not exist yet.
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownRequest.selector, 1));
        desk.requestOf(1);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownRequest.selector, type(uint256).max));
        desk.requestOf(type(uint256).max);
    }

    function test_unknownRequest_isRefusedByEveryAction() public {
        uint256 att = _attestVault();
        vm.startPrank(worker);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownRequest.selector, 0));
        desk.fulfill(0, att);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownRequest.selector, 0));
        desk.reject(0, NOT_ERC4626);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownRequest.selector, 0));
        desk.refundExpired(0);
    }

    // ---------------------------------------------------------------- fulfill

    function test_fulfill_onlyWorker() public {
        uint256 id = _request();
        uint256 att = _attestVault();
        vm.prank(stranger);
        vm.expectRevert(CheckRequestDesk.NotWorker.selector);
        desk.fulfill(id, att);
        vm.prank(owner);
        vm.expectRevert(CheckRequestDesk.NotWorker.selector);
        desk.fulfill(id, att);
    }

    function test_fulfill_withAMatchingAttestationEarnsTheFee() public {
        uint256 id = _request();
        vm.warp(block.timestamp + 600);
        uint256 att = _attestVault();
        vm.expectEmit(true, false, false, true);
        emit CheckFulfilled(id, att);
        _fulfill(id, att);
        CheckRequestDesk.Request memory r = desk.requestOf(id);
        assertEq(uint8(r.status), uint8(CheckRequestDesk.RequestStatus.Fulfilled));
        assertEq(r.attestationId, att);
        assertEq(desk.escrowed(), 0);
        assertEq(desk.earned(), FEE);
        assertEq(address(desk).balance, FEE);
        _assertBooks();
    }

    function test_fulfill_rejectsAnAttestationThatDoesNotExist() public {
        uint256 id = _request();
        vm.startPrank(worker);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownAttestation.selector, 0));
        desk.fulfill(id, 0);
        vm.stopPrank();
        uint256 att = _attestVault();
        vm.startPrank(worker);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownAttestation.selector, att + 1));
        desk.fulfill(id, att + 1);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.UnknownAttestation.selector, type(uint256).max));
        desk.fulfill(id, type(uint256).max);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(CheckRequestDesk.RequestStatus.Pending));
    }

    function test_fulfill_rejectsAnAttestationAboutSomethingElse() public {
        uint256 id = _request();
        uint256 otherSubject = _attest(MAINNET, OTHER, ERC4626);
        uint256 otherChain = _attest(10143, VAULT, ERC4626);
        uint256 otherStandard = _attest(MAINNET, VAULT, ERC20);
        vm.startPrank(worker);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.AttestationMismatch.selector, id, otherSubject));
        desk.fulfill(id, otherSubject);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.AttestationMismatch.selector, id, otherChain));
        desk.fulfill(id, otherChain);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.AttestationMismatch.selector, id, otherStandard));
        desk.fulfill(id, otherStandard);
        vm.stopPrank();
        assertEq(desk.earned(), 0);
        assertEq(desk.escrowed(), FEE);
    }

    function test_fulfill_rejectsAnAttestationIssuedBeforeTheRequest() public {
        uint256 old = _attestVault();
        uint64 issuedAt = uint64(block.timestamp);
        vm.warp(block.timestamp + 1);
        uint256 id = _request();
        vm.prank(worker);
        vm.expectRevert(
            abi.encodeWithSelector(
                CheckRequestDesk.AttestationBeforeRequest.selector, id, old, issuedAt, uint64(block.timestamp)
            )
        );
        desk.fulfill(id, old);
        // An attestation in the same second as the request counts as issued at or after it.
        uint256 fresh = _attestVault();
        _fulfill(id, fresh);
        assertEq(desk.requestOf(id).attestationId, fresh);
    }

    function test_fulfill_rejectsARevokedAttestation_acceptsASupersededOne() public {
        uint256 first = _request();
        uint256 second = _request();
        uint256 a = _attestVault();
        uint256 b = _attestVault(); // supersedes a
        assertEq(uint8(reg.attestationOf(a).status), uint8(CheckAttestationRegistry.Status.Superseded));
        vm.prank(worker);
        reg.revoke(b, keccak256("wrong"));
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.AttestationRevoked.selector, b));
        desk.fulfill(first, b);
        _fulfill(first, a);
        // One attestation issued after both requests can close both.
        _fulfill(second, a);
        assertEq(desk.earned(), 2 * uint256(FEE));
        _assertBooks();
    }

    function test_fulfill_onlyOncePerRequest() public {
        uint256 id = _request();
        uint256 att = _attestVault();
        _fulfill(id, att);
        vm.startPrank(worker);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Fulfilled));
        desk.fulfill(id, att);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Fulfilled));
        desk.reject(id, NOT_ERC4626);
        vm.stopPrank();
        vm.warp(block.timestamp + TIMEOUT);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Fulfilled));
        desk.refundExpired(id);
        assertEq(desk.earned(), FEE);
    }

    // ---------------------------------------------------------------- reject

    function test_reject_onlyWorkerAndNeedsAReason() public {
        uint256 id = _request();
        vm.prank(stranger);
        vm.expectRevert(CheckRequestDesk.NotWorker.selector);
        desk.reject(id, NOT_ERC4626);
        vm.prank(worker);
        vm.expectRevert(CheckRequestDesk.EmptyReason.selector);
        desk.reject(id, bytes32(0));
    }

    function test_reject_refundsTheWholeFeeInTheSameTransaction() public {
        uint256 id = _request();
        uint256 before = requester.balance;
        vm.expectEmit(true, false, false, true);
        emit CheckRejected(id, NOT_ERC4626);
        vm.prank(worker);
        desk.reject(id, NOT_ERC4626);
        assertEq(requester.balance, before + FEE);
        CheckRequestDesk.Request memory r = desk.requestOf(id);
        assertEq(uint8(r.status), uint8(CheckRequestDesk.RequestStatus.Rejected));
        assertEq(r.rejectReason, bytes32("not-erc4626"));
        assertEq(desk.escrowed(), 0);
        assertEq(desk.earned(), 0);
        assertEq(address(desk).balance, 0);
        uint256 att = _attestVault();
        vm.startPrank(worker);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Rejected));
        desk.reject(id, NOT_ERC4626);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Rejected));
        desk.fulfill(id, att);
        vm.stopPrank();
    }

    function test_reject_refundsWhatWasPaidAfterAFeeChange() public {
        uint256 id = _request();
        vm.prank(owner);
        desk.setFee(2 ether);
        uint256 before = requester.balance;
        vm.prank(worker);
        desk.reject(id, "check-failed");
        assertEq(requester.balance, before + FEE);
        _assertBooks();
    }

    // ---------------------------------------------------------------- refundExpired

    function test_refundExpired_opensExactlyAtRequestedAtPlusTimeout() public {
        uint256 id = _request();
        uint256 expiresAt = desk.requestOf(id).requestedAt + uint256(TIMEOUT);
        vm.warp(expiresAt - 1);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.NotExpired.selector, id, expiresAt));
        desk.refundExpired(id);
        vm.warp(expiresAt);
        uint256 requesterBefore = requester.balance;
        uint256 strangerBefore = stranger.balance;
        vm.expectEmit(true, false, false, true);
        emit CheckRefunded(id);
        vm.prank(stranger);
        desk.refundExpired(id);
        assertEq(requester.balance, requesterBefore + FEE, "the requester gets the fee");
        assertEq(stranger.balance, strangerBefore, "not the caller");
        assertEq(uint8(_status(id)), uint8(CheckRequestDesk.RequestStatus.Refunded));
        assertEq(desk.escrowed(), 0);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Refunded));
        desk.refundExpired(id);
        uint256 att = _attestVault();
        vm.prank(worker);
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Refunded));
        desk.fulfill(id, att);
    }

    function test_refundExpired_theWorkerCanStillFulfillUntilSomeoneRefunds() public {
        uint256 id = _request();
        vm.warp(block.timestamp + TIMEOUT + 1 days);
        _fulfill(id, _attestVault());
        vm.expectRevert(_notPending(id, CheckRequestDesk.RequestStatus.Fulfilled));
        desk.refundExpired(id);
    }

    function testFuzz_refundExpired_boundary(uint64 timeout_, uint64 elapsed) public {
        timeout_ = uint64(bound(timeout_, 1, 365 days));
        elapsed = uint64(bound(elapsed, 0, 2 * 365 days));
        CheckRequestDesk d = new CheckRequestDesk(owner, worker, address(reg), FEE, timeout_);
        vm.prank(requester);
        uint256 id = d.requestCheck{value: FEE}(MAINNET, VAULT, ERC4626);
        vm.warp(block.timestamp + elapsed);
        if (elapsed < timeout_) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    CheckRequestDesk.NotExpired.selector, id, d.requestOf(id).requestedAt + uint256(timeout_)
                )
            );
        }
        d.refundExpired(id);
        assertEq(d.escrowed(), elapsed < timeout_ ? FEE : 0);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CheckRequestDesk.NotOwner.selector);
        desk.withdraw(payable(stranger));
        vm.prank(worker);
        vm.expectRevert(CheckRequestDesk.NotOwner.selector);
        desk.withdraw(payable(worker));
    }

    function test_withdraw_paysOnlyEarnedFeesNeverEscrowedOnes() public {
        vm.startPrank(owner);
        vm.expectRevert(CheckRequestDesk.NothingToWithdraw.selector);
        desk.withdraw(payable(owner));
        vm.stopPrank();
        uint256 done = _request();
        _request(); // stays Pending
        _request(); // stays Pending
        vm.prank(owner);
        vm.expectRevert(CheckRequestDesk.NothingToWithdraw.selector);
        desk.withdraw(payable(owner));
        _fulfill(done, _attestVault());
        assertEq(address(desk).balance, 3 * uint256(FEE));

        address payable to = payable(makeAddr("treasury"));
        vm.expectEmit(false, false, false, true);
        emit FeesWithdrawn(to, FEE);
        vm.prank(owner);
        desk.withdraw(to);
        assertEq(to.balance, FEE);
        assertEq(desk.withdrawn(), FEE);
        assertEq(address(desk).balance, desk.escrowed());
        assertEq(desk.escrowed(), 2 * uint256(FEE));
        vm.startPrank(owner);
        vm.expectRevert(CheckRequestDesk.NothingToWithdraw.selector);
        desk.withdraw(to);
        vm.expectRevert(CheckRequestDesk.ZeroAddress.selector);
        desk.withdraw(payable(address(0)));
        vm.stopPrank();
        _assertBooks();
    }

    function test_withdraw_accumulatesAcrossFulfills() public {
        uint256 a = _request();
        _fulfill(a, _attestVault());
        vm.prank(owner);
        desk.withdraw(payable(owner));
        uint256 b = _request();
        uint256 c = _request();
        uint256 att = _attestVault();
        _fulfill(b, att);
        _fulfill(c, att);
        vm.prank(owner);
        desk.withdraw(payable(owner));
        assertEq(owner.balance, 3 * uint256(FEE));
        assertEq(desk.earned(), desk.withdrawn());
        _assertBooks();
    }

    // ---------------------------------------------------------------- setFee, setWorker

    function test_setFee_onlyOwner_emits_newRequestsPayIt() public {
        vm.prank(stranger);
        vm.expectRevert(CheckRequestDesk.NotOwner.selector);
        desk.setFee(1);
        vm.expectEmit(false, false, false, true);
        emit FeeSet(1 ether);
        vm.prank(owner);
        desk.setFee(1 ether);
        assertEq(desk.fee(), 1 ether);
        uint256 id = _request();
        assertEq(desk.requestOf(id).fee, 1 ether);
    }

    function test_setWorker_onlyOwner_movesTheRole() public {
        uint256 id = _request();
        address next = makeAddr("next worker");
        vm.prank(stranger);
        vm.expectRevert(CheckRequestDesk.NotOwner.selector);
        desk.setWorker(next);
        vm.prank(owner);
        vm.expectRevert(CheckRequestDesk.ZeroAddress.selector);
        desk.setWorker(address(0));
        vm.expectEmit(false, false, false, true);
        emit WorkerSet(next);
        vm.prank(owner);
        desk.setWorker(next);
        assertEq(desk.worker(), next);
        uint256 att = _attestVault();
        vm.prank(worker);
        vm.expectRevert(CheckRequestDesk.NotWorker.selector);
        desk.fulfill(id, att);
        // The desk does not ask who issued the attestation: the old worker's attestation still fulfills.
        vm.prank(next);
        desk.fulfill(id, att);
        assertEq(desk.earned(), FEE);
    }

    // ---------------------------------------------------------------- failed transfers

    function test_refusedRefund_revertsAndTheFeeStaysEscrowed() public {
        RefusesCoins c = new RefusesCoins();
        vm.deal(address(c), 0);
        uint256 id = c.request{value: FEE}(desk, ERC4626);
        vm.prank(worker);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.TransferFailed.selector, address(c), uint256(FEE)));
        desk.reject(id, NOT_ERC4626);
        vm.warp(block.timestamp + TIMEOUT);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.TransferFailed.selector, address(c), uint256(FEE)));
        desk.refundExpired(id);
        assertEq(uint8(_status(id)), uint8(CheckRequestDesk.RequestStatus.Pending));
        assertEq(desk.escrowed(), FEE);
        // It can still be fulfilled.
        _fulfill(id, _attest(MAINNET, address(0xBEEF), ERC4626));
        _assertBooks();
    }

    function test_refusedPayout_revertsAndNothingIsWithdrawn() public {
        RefusesCoins c = new RefusesCoins();
        _fulfill(_request(), _attestVault());
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(CheckRequestDesk.TransferFailed.selector, address(c), uint256(FEE)));
        desk.withdraw(payable(address(c)));
        assertEq(desk.withdrawn(), 0);
        assertEq(address(desk).balance, FEE);
    }

    // ---------------------------------------------------------------- reentrancy

    function test_reentrancy_aRefundCannotReenterForAnotherRefund() public {
        ReentrantRequester r = new ReentrantRequester(desk);
        uint256 a = r.request{value: FEE}(ERC4626);
        uint256 b = r.request{value: FEE}(ERC4626);
        vm.warp(block.timestamp + TIMEOUT);
        r.arm(ReentrantRequester.Mode.RefundOther, b);
        desk.refundExpired(a);
        // The nested refundExpired(b) would have succeeded on its own; the lock refused it.
        assertEq(r.reentryError(), abi.encodeWithSelector(CheckRequestDesk.Reentrancy.selector));
        assertEq(r.received(), FEE);
        assertEq(uint8(_status(a)), uint8(CheckRequestDesk.RequestStatus.Refunded));
        assertEq(uint8(_status(b)), uint8(CheckRequestDesk.RequestStatus.Pending));
        assertEq(desk.escrowed(), FEE);
        _assertBooks();
        desk.refundExpired(b);
        assertEq(r.received(), 2 * uint256(FEE));
        _assertBooks();
    }

    function test_reentrancy_aRejectRefundCannotReenterToRequest() public {
        ReentrantRequester r = new ReentrantRequester(desk);
        uint256 a = r.request{value: FEE}(ERC4626);
        r.arm(ReentrantRequester.Mode.RequestAgain, 0);
        vm.prank(worker);
        desk.reject(a, NOT_ERC4626);
        assertEq(r.reentryError(), abi.encodeWithSelector(CheckRequestDesk.Reentrancy.selector));
        assertEq(desk.requestCount(), 1);
        assertEq(address(r).balance, FEE);
        _assertBooks();
    }

    function test_reentrancy_aPayoutCannotReenterToWithdrawAgain() public {
        ReentrantOwner o = new ReentrantOwner();
        CheckRequestDesk d = new CheckRequestDesk(address(o), worker, address(reg), FEE, TIMEOUT);
        o.setDesk(d);
        vm.prank(requester);
        uint256 id = d.requestCheck{value: FEE}(MAINNET, VAULT, ERC4626);
        vm.prank(requester);
        d.requestCheck{value: FEE}(MAINNET, VAULT, ERC4626); // escrowed, a second withdraw must not reach it
        uint256 att = _attestVault();
        vm.prank(worker);
        d.fulfill(id, att);
        o.withdraw();
        assertEq(o.reentryError(), abi.encodeWithSelector(CheckRequestDesk.Reentrancy.selector));
        assertEq(o.received(), FEE);
        assertEq(address(d).balance, FEE);
        assertEq(d.escrowed(), FEE);
        assertEq(d.withdrawn(), FEE);
    }
}
