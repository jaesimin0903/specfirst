// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckAttestationRegistry} from "../src/CheckAttestationRegistry.sol";
import {CheckRequestDesk} from "../src/CheckRequestDesk.sol";

/// @notice Drives the desk with random requests, fulfills, rejects, expiry refunds, withdrawals, fee changes
///         and time jumps. Every action is guarded so it never reverts (fail_on_revert = true).
contract DeskHandler is Test {
    CheckRequestDesk public desk;
    CheckAttestationRegistry public reg;
    address public owner;
    address public worker;
    address[] internal actors;
    address[] internal subjects;
    bytes32 internal constant ERC4626 = keccak256("erc4626");
    uint64 internal nextBlock = 1;

    uint256 public requested;
    uint256 public fulfilled;
    uint256 public rejected;
    uint256 public refunded;
    uint256 public paidOut;
    /// Coins that left the desk towards requesters (reject and expiry refunds).
    uint256 public refundedValue;

    constructor(CheckRequestDesk desk_, CheckAttestationRegistry reg_, address owner_, address worker_) {
        desk = desk_;
        reg = reg_;
        owner = owner_;
        worker = worker_;
        for (uint256 i; i < 4; ++i) {
            actors.push(makeAddr(string(abi.encode("actor", i))));
        }
        subjects.push(0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E);
        subjects.push(0x802c91d807A8DaCA257c4708ab264B6520964e44);
        subjects.push(address(0xBEEF));
    }

    function _pendingId(uint256 seed) internal view returns (bool found, uint256 id) {
        uint256 n = desk.requestCount();
        for (uint256 k; k < n; ++k) {
            id = (seed % n + k) % n;
            if (desk.requestOf(id).status == CheckRequestDesk.RequestStatus.Pending) return (true, id);
        }
        return (false, 0);
    }

    function request(uint256 actorSeed, uint256 subjectSeed) external {
        address a = actors[actorSeed % actors.length];
        uint96 f = desk.fee();
        vm.deal(a, a.balance + f);
        vm.prank(a);
        desk.requestCheck{value: f}(143, subjects[subjectSeed % subjects.length], ERC4626);
        ++requested;
    }

    function fulfill(uint256 seed) external {
        (bool found, uint256 id) = _pendingId(seed);
        if (!found) return;
        CheckRequestDesk.Request memory r = desk.requestOf(id);
        CheckAttestationRegistry.AttestParams memory p = CheckAttestationRegistry.AttestParams({
            subjectChainId: r.subjectChainId,
            subject: r.subject,
            standardId: r.standardId,
            blockNumber: nextBlock++,
            implementationKey: keccak256("impl"),
            subjectCodeHash: keccak256("code"),
            suiteHash: keccak256("suite"),
            reportHash: keccak256(abi.encode("report", nextBlock)),
            passCount: 29,
            failCount: 1,
            inconclusiveCount: 0,
            notApplicableCount: 0,
            passedBitmap: (uint256(1) << 29) - 1,
            failedBitmap: uint256(1) << 29,
            reportURI: "u"
        });
        vm.prank(worker);
        uint256 att = reg.attest(p);
        vm.prank(worker);
        desk.fulfill(id, att);
        ++fulfilled;
    }

    function reject(uint256 seed) external {
        (bool found, uint256 id) = _pendingId(seed);
        if (!found) return;
        uint96 f = desk.requestOf(id).fee;
        vm.prank(worker);
        desk.reject(id, "check-failed");
        ++rejected;
        refundedValue += f;
    }

    function refundExpired(uint256 seed, uint256 callerSeed) external {
        (bool found, uint256 id) = _pendingId(seed);
        if (!found) return;
        CheckRequestDesk.Request memory r = desk.requestOf(id);
        uint256 expiresAt = uint256(r.requestedAt) + desk.timeout();
        if (block.timestamp < expiresAt) vm.warp(expiresAt);
        vm.prank(actors[callerSeed % actors.length]);
        desk.refundExpired(id);
        ++refunded;
        refundedValue += r.fee;
    }

    function withdraw() external {
        if (desk.earned() == desk.withdrawn()) return;
        uint256 amount = desk.earned() - desk.withdrawn();
        vm.prank(owner);
        desk.withdraw(payable(makeAddr("treasury")));
        paidOut += amount;
    }

    function setFee(uint96 f) external {
        vm.prank(owner);
        desk.setFee(uint96(bound(f, 0, 5 ether)));
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
    }
}

contract CheckRequestDeskInvariantTest is Test {
    CheckRequestDesk internal desk;
    CheckAttestationRegistry internal reg;
    DeskHandler internal handler;

    function setUp() public {
        vm.warp(1_700_000_000);
        address owner = makeAddr("owner");
        address worker = makeAddr("worker");
        reg = new CheckAttestationRegistry();
        reg.setIssuer(worker, true);
        desk = new CheckRequestDesk(owner, worker, address(reg), 0.5 ether, 1 days);
        handler = new DeskHandler(desk, reg, owner, worker);
        targetContract(address(handler));
    }

    /// The desk holds exactly the escrowed fees plus the earned fees not withdrawn yet.
    function invariant_balanceIsEscrowedPlusEarnedMinusWithdrawn() public view {
        assertEq(address(desk).balance, desk.escrowed() + desk.earned() - desk.withdrawn());
        assertLe(desk.withdrawn(), desk.earned());
        assertEq(desk.withdrawn(), handler.paidOut());
    }

    /// escrowed is the sum of the Pending fees, earned the sum of the Fulfilled ones, and every coin paid
    /// in went back to a requester, is still held, or was withdrawn.
    function invariant_escrowedAndEarnedMatchTheRequests() public view {
        uint256 n = desk.requestCount();
        uint256 pending;
        uint256 done;
        uint256 paidIn;
        uint256 closed;
        for (uint256 i; i < n; ++i) {
            CheckRequestDesk.Request memory r = desk.requestOf(i);
            paidIn += r.fee;
            if (r.status == CheckRequestDesk.RequestStatus.Pending) pending += r.fee;
            else if (r.status == CheckRequestDesk.RequestStatus.Fulfilled) done += r.fee;
            else ++closed;
            assertTrue(r.status != CheckRequestDesk.RequestStatus.None);
        }
        assertEq(desk.escrowed(), pending);
        assertEq(desk.earned(), done);
        assertEq(paidIn, handler.refundedValue() + address(desk).balance + desk.withdrawn());
        assertEq(n, handler.requested());
        assertEq(closed, handler.rejected() + handler.refunded());
    }
}
