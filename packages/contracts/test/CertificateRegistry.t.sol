// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CertificateRegistry} from "../src/CertificateRegistry.sol";

contract DummyVault {
    uint256 public x;

    function set(uint256 v) external {
        x = v;
    }
}

contract CertificateRegistryTest is Test {
    CertificateRegistry internal reg;

    address internal owner = address(this);
    address internal issuer = makeAddr("issuer");
    address internal stranger = makeAddr("stranger");

    address internal v1;
    address internal v2;
    address internal v3;

    bytes32 internal constant PROJECT_A = keccak256("staking-vault");
    bytes32 internal constant PROJECT_B = keccak256("other-project");
    bytes32 internal constant INV_SET = keccak256("inv-set-v1");
    bytes32 internal constant INV_SET_OTHER = keccak256("inv-set-v2");

    event CertificateIssued(
        address indexed target,
        bytes32 indexed projectId,
        uint256 certId,
        bytes32 invariantSetHash,
        bytes32 propertyHash,
        bytes32 codeHash,
        bytes32 reportHash,
        uint16 passedCount,
        uint16 totalCount
    );
    event CertificateSuperseded(address indexed oldTarget, address indexed newTarget, bytes32 indexed projectId);
    event CertificateRevoked(address indexed target, uint256 indexed certId, bytes32 reasonHash, string evidenceURI);
    event IssuerSet(address indexed issuer, bool allowed);

    function setUp() public {
        reg = new CertificateRegistry();
        reg.setIssuer(issuer, true);
        v1 = address(new DummyVault());
        v2 = address(new DummyVault());
        v3 = address(new DummyVault());
    }

    function _params(address target, bytes32 projectId, uint16 passed, uint16 total)
        internal
        pure
        returns (CertificateRegistry.IssueParams memory p)
    {
        p = CertificateRegistry.IssueParams({
            target: target,
            projectId: projectId,
            specHash: keccak256("spec"),
            invariantSetHash: INV_SET,
            propertyHash: keccak256("props"),
            reportHash: keccak256("report"),
            passedCount: passed,
            totalCount: total,
            passedBitmap: (uint256(1) << passed) - 1,
            rehearsalTxCount: 30,
            reportURI: "https://raw.example/report.json"
        });
    }

    function _issue(address target, bytes32 projectId) internal returns (uint256) {
        vm.prank(issuer);
        return reg.issue(_params(target, projectId, 5, 5));
    }

    function _issuePartial(address target, bytes32 projectId) internal returns (uint256) {
        vm.prank(issuer);
        return reg.issue(_params(target, projectId, 4, 5));
    }

    function _status(address target, uint256 certId) internal view returns (CertificateRegistry.Status) {
        return reg.certificateOf(target, certId).status;
    }

    // ---------------------------------------------------------------- owner, issuer

    function test_constructor_setsOwner() public view {
        assertEq(reg.owner(), owner);
        assertTrue(reg.isIssuer(issuer));
    }

    function test_setIssuer_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CertificateRegistry.NotOwner.selector);
        reg.setIssuer(stranger, true);
    }

    function test_setIssuer_emitsAndToggles() public {
        vm.expectEmit(true, false, false, true);
        emit IssuerSet(stranger, true);
        reg.setIssuer(stranger, true);
        assertTrue(reg.isIssuer(stranger));

        reg.setIssuer(stranger, false);
        assertFalse(reg.isIssuer(stranger));
    }

    function test_setIssuer_rejectsZero() public {
        vm.expectRevert(CertificateRegistry.ZeroAddress.selector);
        reg.setIssuer(address(0), true);
    }

    // ---------------------------------------------------------------- issue

    function test_issue_onlyIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(CertificateRegistry.NotIssuer.selector);
        reg.issue(_params(v1, PROJECT_A, 5, 5));
    }

    function test_issue_revokedIssuerCannotIssue() public {
        reg.setIssuer(issuer, false);
        vm.prank(issuer);
        vm.expectRevert(CertificateRegistry.NotIssuer.selector);
        reg.issue(_params(v1, PROJECT_A, 5, 5));
    }

    function test_issue_rejectsEOA() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.TargetHasNoCode.selector, stranger));
        reg.issue(_params(stranger, PROJECT_A, 5, 5));
    }

    function test_issue_rejectsInvalidCounts() public {
        vm.startPrank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.InvalidCounts.selector, uint16(0), uint16(0)));
        reg.issue(_params(v1, PROJECT_A, 0, 0));
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.InvalidCounts.selector, uint16(6), uint16(5)));
        reg.issue(_params(v1, PROJECT_A, 6, 5));
        vm.stopPrank();
    }

    function test_issue_storesFieldsAndReadsCodehashOnchain() public {
        vm.warp(1_760_000_000);
        uint256 id = _issue(v1, PROJECT_A);
        assertEq(id, 0);
        assertEq(reg.certificateCount(v1), 1);

        CertificateRegistry.Certificate memory c = reg.certificateOf(v1, id);
        assertEq(c.projectId, PROJECT_A);
        assertEq(c.specHash, keccak256("spec"));
        assertEq(c.invariantSetHash, INV_SET);
        assertEq(c.propertyHash, keccak256("props"));
        assertEq(c.codeHash, v1.codehash);
        assertEq(c.codeHash, keccak256(v1.code));
        assertEq(c.reportHash, keccak256("report"));
        assertEq(c.issuedAt, 1_760_000_000);
        assertEq(c.passedCount, 5);
        assertEq(c.totalCount, 5);
        assertEq(c.passedBitmap, 31);
        assertEq(c.rehearsalTxCount, 30);
        assertEq(uint8(c.status), uint8(CertificateRegistry.Status.Valid));
        assertEq(c.supersededBy, address(0));
        assertEq(c.revokeReasonHash, bytes32(0));
        assertEq(c.reportURI, "https://raw.example/report.json");
        assertEq(reg.currentTargetOf(PROJECT_A), v1);
    }

    function test_issue_emitsIssuedEvent() public {
        vm.expectEmit(true, true, false, true, address(reg));
        emit CertificateIssued(v1, PROJECT_A, 0, INV_SET, keccak256("props"), v1.codehash, keccak256("report"), 5, 5);
        _issue(v1, PROJECT_A);
    }

    // ---------------------------------------------------------------- lineage

    function test_lineage_newTargetSupersedesPrevious() public {
        _issue(v1, PROJECT_A);

        vm.expectEmit(true, true, true, true, address(reg));
        emit CertificateSuperseded(v1, v2, PROJECT_A);
        _issue(v2, PROJECT_A);

        CertificateRegistry.Certificate memory old = reg.certificateOf(v1, 0);
        assertEq(uint8(old.status), uint8(CertificateRegistry.Status.Superseded));
        assertEq(old.supersededBy, v2);
        assertEq(uint8(_status(v2, 0)), uint8(CertificateRegistry.Status.Valid));
        assertEq(reg.currentTargetOf(PROJECT_A), v2);

        _issue(v3, PROJECT_A);
        assertEq(reg.certificateOf(v2, 0).supersededBy, v3);
        assertEq(reg.currentTargetOf(PROJECT_A), v3);
        // v1 keeps pointing to v2, the version that replaced it.
        assertEq(reg.certificateOf(v1, 0).supersededBy, v2);
    }

    function test_lineage_sameTargetReissueSupersedesPreviousCert() public {
        _issue(v1, PROJECT_A);
        vm.recordLogs();
        uint256 id = _issue(v1, PROJECT_A);
        assertEq(id, 1);
        // No lineage move, so no CertificateSuperseded event; only CertificateIssued.
        assertEq(vm.getRecordedLogs().length, 1);

        CertificateRegistry.Certificate memory old = reg.certificateOf(v1, 0);
        assertEq(uint8(old.status), uint8(CertificateRegistry.Status.Superseded));
        assertEq(old.supersededBy, v1);
        assertEq(uint8(_status(v1, 1)), uint8(CertificateRegistry.Status.Valid));
        assertEq(reg.currentTargetOf(PROJECT_A), v1);
        assertTrue(reg.isCertified(v1));
        assertTrue(reg.isLatest(v1));
    }

    function test_lineage_sameTargetDifferentProjectId() public {
        _issue(v1, PROJECT_A);
        _issue(v1, PROJECT_B);

        // Second issuance becomes the latest lineage of the target.
        (, CertificateRegistry.Certificate memory c,) = reg.latest(v1);
        assertEq(c.projectId, PROJECT_B);
        assertEq(reg.currentTargetOf(PROJECT_B), v1);
        // First projectId keeps its current target.
        assertEq(reg.currentTargetOf(PROJECT_A), v1);
        assertTrue(reg.isLatest(v1));
        assertTrue(reg.isCertified(v1));
        // Target's own previous certificate is superseded by the reissue.
        assertEq(uint8(_status(v1, 0)), uint8(CertificateRegistry.Status.Superseded));

        // Moving PROJECT_A to v2 does not affect v1 being latest for PROJECT_B.
        _issue(v2, PROJECT_A);
        assertEq(reg.currentTargetOf(PROJECT_A), v2);
        assertEq(reg.currentTargetOf(PROJECT_B), v1);
        assertTrue(reg.isLatest(v1));
        assertEq(uint8(_status(v1, 1)), uint8(CertificateRegistry.Status.Valid));
    }

    function test_partial_cannotSupersedeValidCompleteOnOtherTarget() public {
        _issue(v1, PROJECT_A);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.PartialCannotSupersede.selector, v1, uint256(0)));
        reg.issue(_params(v2, PROJECT_A, 4, 5));
    }

    function test_partial_cannotSupersedeValidCompleteOnSameTarget() public {
        _issue(v1, PROJECT_A);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.PartialCannotSupersede.selector, v1, uint256(0)));
        reg.issue(_params(v1, PROJECT_A, 4, 5));
    }

    function test_partial_cannotShadowOwnValidCompleteUnderOtherProject() public {
        _issue(v1, PROJECT_A);
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.PartialCannotSupersede.selector, v1, uint256(0)));
        reg.issue(_params(v1, PROJECT_B, 4, 5));
    }

    function test_partial_doesNotTouchLineage() public {
        uint256 id = _issuePartial(v1, PROJECT_A);
        assertEq(id, 0);
        assertEq(reg.currentTargetOf(PROJECT_A), address(0));
        assertFalse(reg.isLatest(v1));

        // Once the current certificate is revoked, a partial may be issued elsewhere,
        // still without moving the lineage or superseding anything.
        _issue(v2, PROJECT_A);
        vm.prank(issuer);
        reg.revoke(v2, 0, keccak256("bug"), "ipfs://evidence");
        _issuePartial(v3, PROJECT_A);
        assertEq(reg.currentTargetOf(PROJECT_A), v2);
        assertEq(uint8(_status(v2, 0)), uint8(CertificateRegistry.Status.Revoked));
        assertEq(uint8(_status(v3, 0)), uint8(CertificateRegistry.Status.Valid));
        assertFalse(reg.isCertified(v3));
    }

    function test_partial_afterSupersededCurrentIsAllowed() public {
        _issue(v1, PROJECT_A);
        _issue(v1, PROJECT_B); // PROJECT_A current cert (v1, 0) is now Superseded
        _issuePartial(v2, PROJECT_A);
        assertEq(reg.currentTargetOf(PROJECT_A), v1);
        assertEq(uint8(_status(v1, 0)), uint8(CertificateRegistry.Status.Superseded));
    }

    function test_complete_supersedesEarlierPartial() public {
        _issuePartial(v1, PROJECT_A);
        _issue(v1, PROJECT_A);
        assertEq(uint8(_status(v1, 0)), uint8(CertificateRegistry.Status.Superseded));
        assertEq(reg.currentTargetOf(PROJECT_A), v1);
        assertTrue(reg.isCertified(v1));
    }

    function test_lineage_revokedCurrentIsNotResurrected() public {
        _issue(v1, PROJECT_A);
        vm.prank(issuer);
        reg.revoke(v1, 0, keccak256("bug"), "ipfs://evidence");
        _issue(v2, PROJECT_A);
        CertificateRegistry.Certificate memory old = reg.certificateOf(v1, 0);
        assertEq(uint8(old.status), uint8(CertificateRegistry.Status.Revoked));
        assertEq(old.supersededBy, address(0));
        assertEq(reg.currentTargetOf(PROJECT_A), v2);
    }

    // ---------------------------------------------------------------- revoke

    function test_revoke_onlyIssuer() public {
        _issue(v1, PROJECT_A);
        vm.prank(stranger);
        vm.expectRevert(CertificateRegistry.NotIssuer.selector);
        reg.revoke(v1, 0, keccak256("bug"), "ipfs://evidence");
    }

    function test_revoke_valid() public {
        _issue(v1, PROJECT_A);
        vm.expectEmit(true, true, false, true, address(reg));
        emit CertificateRevoked(v1, 0, keccak256("bug"), "ipfs://evidence");
        vm.prank(issuer);
        reg.revoke(v1, 0, keccak256("bug"), "ipfs://evidence");

        CertificateRegistry.Certificate memory c = reg.certificateOf(v1, 0);
        assertEq(uint8(c.status), uint8(CertificateRegistry.Status.Revoked));
        assertEq(c.revokeReasonHash, keccak256("bug"));
        assertFalse(reg.isCertified(v1));
        assertFalse(reg.isCertifiedWith(v1, INV_SET));
    }

    function test_revoke_supersededOldVersion() public {
        _issue(v1, PROJECT_A);
        _issue(v2, PROJECT_A);
        assertTrue(reg.isCertified(v1));

        vm.prank(issuer);
        reg.revoke(v1, 0, keccak256("old-bug"), "ipfs://evidence");
        assertEq(uint8(_status(v1, 0)), uint8(CertificateRegistry.Status.Revoked));
        assertFalse(reg.isCertified(v1));
        assertTrue(reg.isCertified(v2));
    }

    function test_revoke_rejectsAlreadyRevoked() public {
        _issue(v1, PROJECT_A);
        vm.startPrank(issuer);
        reg.revoke(v1, 0, keccak256("bug"), "ipfs://evidence");
        vm.expectRevert(
            abi.encodeWithSelector(
                CertificateRegistry.NotRevocable.selector, v1, uint256(0), CertificateRegistry.Status.Revoked
            )
        );
        reg.revoke(v1, 0, keccak256("bug"), "ipfs://evidence");
        vm.stopPrank();
    }

    function test_revoke_rejectsEmptyEvidence() public {
        _issue(v1, PROJECT_A);
        vm.prank(issuer);
        vm.expectRevert(CertificateRegistry.EmptyEvidence.selector);
        reg.revoke(v1, 0, keccak256("bug"), "");
    }

    function test_revoke_rejectsUnknownCert() public {
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.UnknownCertificate.selector, v1, uint256(0)));
        reg.revoke(v1, 0, keccak256("bug"), "ipfs://evidence");
    }

    // ---------------------------------------------------------------- isCertified, isLatest

    function test_isCertified_noCertificate() public view {
        assertFalse(reg.isCertified(v1));
        assertFalse(reg.isCertifiedWith(v1, INV_SET));
        assertFalse(reg.isLatest(v1));
    }

    function test_isCertified_true() public {
        _issue(v1, PROJECT_A);
        assertTrue(reg.isCertified(v1));
    }

    function test_isCertified_partialFalse() public {
        _issuePartial(v1, PROJECT_A);
        assertFalse(reg.isCertified(v1));
        assertFalse(reg.isCertifiedWith(v1, INV_SET));
    }

    function test_isCertified_falseAfterEtch() public {
        _issue(v1, PROJECT_A);
        vm.etch(v1, hex"6000");
        assertFalse(reg.isCertified(v1));
        assertFalse(reg.isCertifiedWith(v1, INV_SET));
        (,, bool codeMatches) = reg.latest(v1);
        assertFalse(codeMatches);
    }

    function test_isCertified_supersededStillTrue() public {
        _issue(v1, PROJECT_A);
        _issue(v2, PROJECT_A);
        assertEq(uint8(_status(v1, 0)), uint8(CertificateRegistry.Status.Superseded));
        assertTrue(reg.isCertified(v1));
        assertTrue(reg.isCertifiedWith(v1, INV_SET));
    }

    function test_isLatest_beforeAndAfterSupersede() public {
        _issue(v1, PROJECT_A);
        assertTrue(reg.isLatest(v1));
        _issue(v2, PROJECT_A);
        assertFalse(reg.isLatest(v1));
        assertTrue(reg.isLatest(v2));
    }

    // ---------------------------------------------------------------- isCertifiedWith

    function test_isCertifiedWith_match() public {
        _issue(v1, PROJECT_A);
        assertTrue(reg.isCertifiedWith(v1, INV_SET));
    }

    function test_isCertifiedWith_mismatch() public {
        _issue(v1, PROJECT_A);
        assertFalse(reg.isCertifiedWith(v1, INV_SET_OTHER));
    }

    function test_isCertifiedWith_specHashDiffersSameInvariantSet() public {
        CertificateRegistry.IssueParams memory p = _params(v1, PROJECT_A, 5, 5);
        p.specHash = keccak256("spec with renamed project and 50 rehearsals");
        p.rehearsalTxCount = 50;
        vm.prank(issuer);
        reg.issue(p);
        assertTrue(reg.isCertifiedWith(v1, INV_SET));
    }

    // ---------------------------------------------------------------- views

    function test_latest_returnsLastCert() public {
        _issue(v1, PROJECT_A);
        _issue(v1, PROJECT_A);
        (uint256 id, CertificateRegistry.Certificate memory c, bool codeMatches) = reg.latest(v1);
        assertEq(id, 1);
        assertEq(uint8(c.status), uint8(CertificateRegistry.Status.Valid));
        assertTrue(codeMatches);
    }

    function test_latest_revertsWithoutCert() public {
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.NoCertificate.selector, v1));
        reg.latest(v1);
    }

    function test_certificateOf_revertsOutOfRange() public {
        vm.expectRevert(abi.encodeWithSelector(CertificateRegistry.UnknownCertificate.selector, v1, uint256(3)));
        reg.certificateOf(v1, 3);
    }
}
