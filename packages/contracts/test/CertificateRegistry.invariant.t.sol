// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CertificateRegistry} from "../src/CertificateRegistry.sol";

contract TargetA {
    function a() external pure returns (uint256) {
        return 1;
    }
}

contract TargetB {
    function b() external pure returns (uint256) {
        return 2;
    }
}

/// @notice Drives the registry with random issue, partial issue, revoke and code swaps.
contract RegistryHandler is Test {
    CertificateRegistry public reg;
    address[] public targets;
    bytes32[] public projects;
    bytes internal codeA;
    bytes internal codeB;

    uint256 public issued;
    uint256 public partialIssued;
    uint256 public partialRejected;
    uint256 public revoked;
    uint256 public etched;

    constructor(CertificateRegistry reg_) {
        reg = reg_;
        codeA = address(new TargetA()).code;
        codeB = address(new TargetB()).code;
        for (uint256 i; i < 4; ++i) {
            targets.push(address(new TargetA()));
        }
        projects.push(keccak256("p0"));
        projects.push(keccak256("p1"));
        projects.push(keccak256("p2"));
    }

    function targetCount() external view returns (uint256) {
        return targets.length;
    }

    function projectCount() external view returns (uint256) {
        return projects.length;
    }

    function _params(uint256 t, uint256 pr, uint16 passed, uint16 total, uint256 inv)
        internal
        view
        returns (CertificateRegistry.IssueParams memory)
    {
        return CertificateRegistry.IssueParams({
            target: targets[t % targets.length],
            projectId: projects[pr % projects.length],
            specHash: keccak256(abi.encode("spec", inv)),
            invariantSetHash: keccak256(abi.encode("inv", inv % 2)),
            propertyHash: keccak256("props"),
            reportHash: keccak256(abi.encode("report", issued)),
            passedCount: passed,
            totalCount: total,
            passedBitmap: 0,
            rehearsalTxCount: 1,
            reportURI: "r"
        });
    }

    function issueComplete(uint256 t, uint256 pr, uint256 inv, uint16 total) external {
        total = uint16(bound(total, 1, 64));
        reg.issue(_params(t, pr, total, total, inv));
        ++issued;
    }

    function issuePartial(uint256 t, uint256 pr, uint256 inv, uint16 total, uint16 passed) external {
        total = uint16(bound(total, 2, 64));
        passed = uint16(bound(passed, 0, total - 1));
        try reg.issue(_params(t, pr, passed, total, inv)) {
            ++partialIssued;
        } catch (bytes memory err) {
            // forge-lint: disable-next-line(unsafe-typecast)
            require(bytes4(err) == CertificateRegistry.PartialCannotSupersede.selector, "unexpected revert");
            ++partialRejected;
        }
    }

    function revoke(uint256 t, uint256 idSeed) external {
        address target = targets[t % targets.length];
        uint256 n = reg.certificateCount(target);
        if (n == 0) return;
        uint256 id = idSeed % n;
        if (reg.certificateOf(target, id).status == CertificateRegistry.Status.Revoked) return;
        reg.revoke(target, id, keccak256("reason"), "evidence");
        ++revoked;
    }

    function swapCode(uint256 t, bool toB) external {
        vm.etch(targets[t % targets.length], toB ? codeB : codeA);
        ++etched;
    }
}

contract CertificateRegistryInvariantTest is Test {
    CertificateRegistry internal reg;
    RegistryHandler internal handler;

    function setUp() public {
        reg = new CertificateRegistry();
        handler = new RegistryHandler(reg);
        reg.setIssuer(address(handler), true);
        targetContract(address(handler));
    }

    /// Revoked latest certificate or a codehash mismatch always means isCertified is false.
    function invariant_revokedOrCodeMismatchIsNotCertified() public view {
        uint256 n = handler.targetCount();
        for (uint256 i; i < n; ++i) {
            address t = handler.targets(i);
            if (reg.certificateCount(t) == 0) {
                assertFalse(reg.isCertified(t));
                continue;
            }
            (, CertificateRegistry.Certificate memory c, bool codeMatches) = reg.latest(t);
            assertEq(codeMatches, c.codeHash == t.codehash);
            if (c.status == CertificateRegistry.Status.Revoked || !codeMatches) {
                assertFalse(reg.isCertified(t));
                assertFalse(reg.isCertifiedWith(t, c.invariantSetHash));
            }
            if (reg.isCertified(t)) {
                assertTrue(
                    c.status == CertificateRegistry.Status.Valid || c.status == CertificateRegistry.Status.Superseded
                );
                assertEq(c.passedCount, c.totalCount);
            }
        }
    }

    /// Each projectId has at most one current target, and that target holds a complete
    /// certificate for the projectId.
    function invariant_atMostOneCurrentTargetPerProject() public view {
        uint256 np = handler.projectCount();
        uint256 nt = handler.targetCount();
        for (uint256 j; j < np; ++j) {
            bytes32 pid = handler.projects(j);
            address current = reg.currentTargetOf(pid);
            uint256 latestCount;
            for (uint256 i; i < nt; ++i) {
                address t = handler.targets(i);
                if (reg.certificateCount(t) == 0) continue;
                (, CertificateRegistry.Certificate memory c,) = reg.latest(t);
                if (c.projectId == pid && reg.isLatest(t)) {
                    ++latestCount;
                    assertEq(t, current);
                }
            }
            assertLe(latestCount, 1);
            if (current != address(0)) {
                bool found;
                uint256 m = reg.certificateCount(current);
                for (uint256 k; k < m; ++k) {
                    CertificateRegistry.Certificate memory c = reg.certificateOf(current, k);
                    if (c.projectId == pid && c.passedCount == c.totalCount) found = true;
                }
                assertTrue(found);
            }
        }
    }

    /// A Valid complete certificate is always the latest one of its target. Anything issued
    /// after it on the same target must have superseded it, or it was revoked first.
    function invariant_noValidCompleteBehindLatest() public view {
        uint256 nt = handler.targetCount();
        for (uint256 i; i < nt; ++i) {
            address t = handler.targets(i);
            uint256 m = reg.certificateCount(t);
            for (uint256 k; k + 1 < m; ++k) {
                CertificateRegistry.Certificate memory c = reg.certificateOf(t, k);
                assertFalse(c.status == CertificateRegistry.Status.Valid && c.passedCount == c.totalCount);
            }
        }
    }

    function afterInvariant() external view {
        assertGt(handler.issued() + handler.partialIssued() + handler.partialRejected(), 0);
    }
}
