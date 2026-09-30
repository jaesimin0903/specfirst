// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckAttestationRegistry} from "../src/CheckAttestationRegistry.sol";

contract CheckAttestationRegistryTest is Test {
    CheckAttestationRegistry internal reg;

    address internal owner = address(this);
    address internal issuer = makeAddr("issuer");
    address internal stranger = makeAddr("stranger");

    uint64 internal constant MAINNET = 143;
    uint64 internal constant TESTNET = 10143;
    address internal constant VAULT = 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E;
    address internal constant OTHER = 0x802c91d807A8DaCA257c4708ab264B6520964e44;
    bytes32 internal constant EMPTY_CODE_HASH = keccak256("");
    /// standardId = keccak256(bytes(standard)); the value packages/core computes for "erc4626".
    bytes32 internal constant ERC4626 = 0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab;
    bytes32 internal constant ERC20 = keccak256("erc20");

    event Attested(
        uint256 indexed id,
        uint64 indexed subjectChainId,
        address indexed subject,
        address issuer,
        CheckAttestationRegistry.AttestParams params
    );
    event Superseded(uint256 indexed id, uint256 indexed byId);
    event Revoked(uint256 indexed id, bytes32 reasonHash);
    event IssuerSet(address indexed issuer, bool allowed);

    function setUp() public {
        reg = new CheckAttestationRegistry();
        reg.setIssuer(issuer, true);
    }

    /// Params with `pass` passes first, then `fail` fails, `inc` inconclusive and `na` not applicable.
    function _params(
        uint64 chainId,
        address subject,
        uint64 blockNumber,
        uint16 pass,
        uint16 fail,
        uint16 inc,
        uint16 na
    ) internal pure returns (CheckAttestationRegistry.AttestParams memory p) {
        uint256 passed = pass == 256 ? type(uint256).max : (uint256(1) << pass) - 1;
        uint256 failed = fail == 0 ? 0 : ((uint256(1) << fail) - 1) << pass;
        p = CheckAttestationRegistry.AttestParams({
            subjectChainId: chainId,
            subject: subject,
            standardId: ERC4626,
            blockNumber: blockNumber,
            implementationKey: keccak256("impl"),
            subjectCodeHash: keccak256("code"),
            suiteHash: keccak256("suite"),
            reportHash: keccak256("report"),
            passCount: pass,
            failCount: fail,
            inconclusiveCount: inc,
            notApplicableCount: na,
            passedBitmap: passed,
            failedBitmap: failed,
            reportURI: "certs/checks/143/0xd793/109061472.json"
        });
    }

    function _attest(CheckAttestationRegistry.AttestParams memory p) internal returns (uint256) {
        vm.prank(issuer);
        return reg.attest(p);
    }

    function _allPass(uint64 blockNumber) internal returns (uint256) {
        return _attest(_params(MAINNET, VAULT, blockNumber, 30, 0, 0, 0));
    }

    // ---------------------------------------------------------------- owner, issuer

    function test_constructor_setsOwner() public view {
        assertEq(reg.owner(), owner);
        assertTrue(reg.isIssuer(issuer));
        assertEq(reg.attestationCount(), 0);
    }

    function test_setIssuer_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(CheckAttestationRegistry.NotOwner.selector);
        reg.setIssuer(stranger, true);
    }

    function test_setIssuer_emitsTogglesAndRejectsZero() public {
        vm.expectEmit(true, false, false, true);
        emit IssuerSet(stranger, true);
        reg.setIssuer(stranger, true);
        assertTrue(reg.isIssuer(stranger));
        reg.setIssuer(stranger, false);
        assertFalse(reg.isIssuer(stranger));
        vm.expectRevert(CheckAttestationRegistry.ZeroAddress.selector);
        reg.setIssuer(address(0), true);
    }

    function test_attest_onlyIssuer() public {
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(CheckAttestationRegistry.NotIssuer.selector);
        reg.attest(p);
        reg.setIssuer(issuer, false);
        vm.prank(issuer);
        vm.expectRevert(CheckAttestationRegistry.NotIssuer.selector);
        reg.attest(p);
    }

    function test_revoke_onlyIssuer() public {
        uint256 id = _allPass(1);
        vm.prank(stranger);
        vm.expectRevert(CheckAttestationRegistry.NotIssuer.selector);
        reg.revoke(id, keccak256("why"));
    }

    // ---------------------------------------------------------------- attest

    function test_attest_storesEveryField() public {
        vm.warp(1_790_000_000);
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 109061472, 16, 2, 12, 0);
        // The event carries every submitted field and the issuer, so an indexer needs no storage read.
        vm.expectEmit(true, true, true, true);
        emit Attested(0, MAINNET, VAULT, issuer, p);
        uint256 id = _attest(p);
        assertEq(id, 0);
        assertEq(reg.attestationCount(), 1);

        CheckAttestationRegistry.Attestation memory a = reg.attestationOf(id);
        assertEq(a.subjectChainId, MAINNET);
        assertEq(a.subject, VAULT);
        assertEq(a.standardId, ERC4626);
        assertEq(a.blockNumber, 109061472);
        assertEq(a.implementationKey, keccak256("impl"));
        assertEq(a.subjectCodeHash, keccak256("code"));
        assertEq(a.suiteHash, keccak256("suite"));
        assertEq(a.reportHash, keccak256("report"));
        assertEq(a.passCount, 16);
        assertEq(a.failCount, 2);
        assertEq(a.inconclusiveCount, 12);
        assertEq(a.notApplicableCount, 0);
        assertEq(a.passedBitmap, (uint256(1) << 16) - 1);
        assertEq(a.failedBitmap, uint256(3) << 16);
        assertEq(a.issuedAt, 1_790_000_000);
        assertEq(a.issuer, issuer);
        assertEq(uint8(a.status), uint8(CheckAttestationRegistry.Status.Valid));
        assertEq(a.reportURI, "certs/checks/143/0xd793/109061472.json");
    }

    function test_attest_subjectNeedsNoCodeOnThisChain() public {
        // The subject lives on another chain; this chain has no code there and that is fine.
        assertEq(VAULT.code.length, 0);
        _allPass(1);
    }

    function test_attest_rejectsBadInputs() public {
        vm.startPrank(issuer);
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, address(0), 1, 30, 0, 0, 0);
        vm.expectRevert(CheckAttestationRegistry.ZeroAddress.selector);
        reg.attest(p);

        p = _params(0, VAULT, 1, 30, 0, 0, 0);
        vm.expectRevert(CheckAttestationRegistry.ZeroChainId.selector);
        reg.attest(p);

        p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        p.standardId = bytes32(0);
        vm.expectRevert(CheckAttestationRegistry.EmptyStandardId.selector);
        reg.attest(p);

        p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        p.implementationKey = bytes32(0);
        vm.expectRevert(CheckAttestationRegistry.EmptyImplementationKey.selector);
        reg.attest(p);

        p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        p.suiteHash = bytes32(0);
        vm.expectRevert(CheckAttestationRegistry.EmptySuiteHash.selector);
        reg.attest(p);

        p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        p.subjectCodeHash = bytes32(0);
        vm.expectRevert(CheckAttestationRegistry.EmptyCodeHash.selector);
        reg.attest(p);
        p.subjectCodeHash = EMPTY_CODE_HASH;
        vm.expectRevert(CheckAttestationRegistry.EmptyCodeHash.selector);
        reg.attest(p);

        p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        p.reportHash = bytes32(0);
        vm.expectRevert(CheckAttestationRegistry.EmptyReportHash.selector);
        reg.attest(p);
        vm.stopPrank();
    }

    function test_attest_reportURIAtMost512Bytes() public {
        assertEq(reg.MAX_REPORT_URI_LENGTH(), 512);
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 1, 30, 0, 0, 0);
        p.reportURI = string(new bytes(513));
        vm.prank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CheckAttestationRegistry.ReportURITooLong.selector, uint256(513)));
        reg.attest(p);
        p.reportURI = string(new bytes(512));
        uint256 id = _attest(p);
        assertEq(bytes(reg.attestationOf(id).reportURI).length, 512);
    }

    function test_attest_countsMustBeOneTo256() public {
        vm.startPrank(issuer);
        vm.expectRevert(abi.encodeWithSelector(CheckAttestationRegistry.InvalidCounts.selector, uint256(0)));
        reg.attest(_params(MAINNET, VAULT, 1, 0, 0, 0, 0));
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 1, 256, 0, 0, 0);
        p.notApplicableCount = 1;
        vm.expectRevert(abi.encodeWithSelector(CheckAttestationRegistry.InvalidCounts.selector, uint256(257)));
        reg.attest(p);
        vm.stopPrank();
        // Exactly 256 results, every bit set, is the upper bound and accepted.
        uint256 id = _attest(_params(MAINNET, VAULT, 1, 256, 0, 0, 0));
        assertEq(reg.attestationOf(id).passedBitmap, type(uint256).max);
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
    }

    function test_attest_bitmapsMustMatchCounts() public {
        vm.startPrank(issuer);
        // A pass bit and a fail bit on the same result.
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 1, 2, 1, 0, 0);
        p.failedBitmap = 1;
        vm.expectRevert(CheckAttestationRegistry.InvalidBitmaps.selector);
        reg.attest(p);
        // A bit at or above the number of results.
        p = _params(MAINNET, VAULT, 1, 3, 0, 0, 0);
        p.passedBitmap = 0x0b; // bits 0, 1, 3 with 3 results
        vm.expectRevert(CheckAttestationRegistry.InvalidBitmaps.selector);
        reg.attest(p);
        // Popcount differs from the count.
        p = _params(MAINNET, VAULT, 1, 3, 1, 0, 0);
        p.passedBitmap = 0x03;
        vm.expectRevert(CheckAttestationRegistry.InvalidBitmaps.selector);
        reg.attest(p);
        p = _params(MAINNET, VAULT, 1, 3, 1, 0, 0);
        p.failedBitmap = 0;
        vm.expectRevert(CheckAttestationRegistry.InvalidBitmaps.selector);
        reg.attest(p);
        vm.stopPrank();
    }

    function test_attest_rejectsFailedBitsOnlyOutsideTheResults() public {
        vm.startPrank(issuer);
        // 2 pass, 1 fail: 3 results. The one fail bit sits at index 3, past the last result, so the
        // popcount matches failCount and only the range check can catch it.
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 1, 2, 1, 0, 0);
        p.failedBitmap = uint256(1) << 3;
        vm.expectRevert(CheckAttestationRegistry.InvalidBitmaps.selector);
        reg.attest(p);
        // 255 results, the fail bit on bit 255.
        p = _params(MAINNET, VAULT, 1, 254, 1, 0, 0);
        p.failedBitmap = uint256(1) << 255;
        vm.expectRevert(CheckAttestationRegistry.InvalidBitmaps.selector);
        reg.attest(p);
        vm.stopPrank();
        // The same counts with the fail bit inside the results are accepted.
        p = _params(MAINNET, VAULT, 1, 254, 1, 0, 0);
        assertEq(p.failedBitmap, uint256(1) << 254);
        _attest(p);
    }

    // ---------------------------------------------------------------- supersede

    function test_attest_supersedesPreviousOfSameSubject() public {
        uint256 first = _allPass(10);
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 10, 28, 2, 0, 0);
        vm.expectEmit(true, true, false, false);
        emit Superseded(first, first + 1);
        uint256 second = _attest(p);

        CheckAttestationRegistry.Attestation memory a = reg.attestationOf(first);
        assertEq(uint8(a.status), uint8(CheckAttestationRegistry.Status.Superseded));
        assertEq(a.supersededBy, second);
        (uint256 id, CheckAttestationRegistry.Attestation memory l) = reg.latest(MAINNET, VAULT, ERC4626);
        assertEq(id, second);
        assertEq(l.failCount, 2);
    }

    function test_attest_subjectsAreKeyedByChainAndAddress() public {
        _allPass(10);
        _attest(_params(TESTNET, VAULT, 5, 30, 0, 0, 0)); // same address, other chain
        _attest(_params(MAINNET, OTHER, 5, 30, 0, 0, 0)); // other address
        assertEq(uint8(reg.attestationOf(0).status), uint8(CheckAttestationRegistry.Status.Valid));
        (uint256 idT,) = reg.latest(TESTNET, VAULT, ERC4626);
        (uint256 idO,) = reg.latest(MAINNET, OTHER, ERC4626);
        assertEq(idT, 1);
        assertEq(idO, 2);
    }

    function test_attest_standardsAreKeptApart() public {
        uint256 first = _allPass(100);
        // Another standard on the same subject, at an earlier block: its own key, no supersede, no block order.
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 50, 1, 1, 0, 0);
        p.standardId = ERC20;
        uint256 second = _attest(p);
        assertEq(uint8(reg.attestationOf(first).status), uint8(CheckAttestationRegistry.Status.Valid));
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC20));
        (uint256 id4626,) = reg.latest(MAINNET, VAULT, ERC4626);
        (uint256 id20, CheckAttestationRegistry.Attestation memory a20) = reg.latest(MAINNET, VAULT, ERC20);
        assertEq(id4626, first);
        assertEq(id20, second);
        assertEq(a20.standardId, ERC20);
        vm.expectRevert(
            abi.encodeWithSelector(CheckAttestationRegistry.NoAttestation.selector, MAINNET, VAULT, keccak256("erc721"))
        );
        reg.latest(MAINNET, VAULT, keccak256("erc721"));
    }

    function test_attest_rejectsEarlierBlockThanLatest() public {
        _allPass(100);
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(CheckAttestationRegistry.OlderThanLatest.selector, uint64(99), uint64(100))
        );
        reg.attest(_params(MAINNET, VAULT, 99, 30, 0, 0, 0));
        _allPass(100); // same block is a rerun, accepted
    }

    function test_attest_acceptsEarlierBlockAfterRevokedLatest() public {
        // An attestation recorded with a wrong, too high block number is revoked and replaced.
        uint256 wrong = _allPass(1_000_000);
        vm.prank(issuer);
        reg.revoke(wrong, keccak256("block number was wrong"));
        uint256 fixedId = _allPass(100);
        (uint256 id, CheckAttestationRegistry.Attestation memory l) = reg.latest(MAINNET, VAULT, ERC4626);
        assertEq(id, fixedId);
        assertEq(l.blockNumber, 100);
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
        CheckAttestationRegistry.Attestation memory w = reg.attestationOf(wrong);
        assertEq(uint8(w.status), uint8(CheckAttestationRegistry.Status.Revoked));
        assertEq(w.supersededBy, 0);
        // The replacement is Valid, so the block order applies again.
        vm.prank(issuer);
        vm.expectRevert(
            abi.encodeWithSelector(CheckAttestationRegistry.OlderThanLatest.selector, uint64(99), uint64(100))
        );
        reg.attest(_params(MAINNET, VAULT, 99, 30, 0, 0, 0));
    }

    function test_attest_leavesRevokedPreviousRevoked() public {
        uint256 first = _allPass(1);
        vm.prank(issuer);
        reg.revoke(first, keccak256("wrong code hash"));
        _allPass(2);
        CheckAttestationRegistry.Attestation memory a = reg.attestationOf(first);
        assertEq(uint8(a.status), uint8(CheckAttestationRegistry.Status.Revoked));
        assertEq(a.supersededBy, 0);
    }

    // ---------------------------------------------------------------- revoke

    function test_revoke_validAndSuperseded() public {
        uint256 first = _allPass(1);
        uint256 second = _allPass(2);
        vm.startPrank(issuer);
        vm.expectEmit(true, false, false, true);
        emit Revoked(first, keccak256("a"));
        reg.revoke(first, keccak256("a")); // Superseded -> Revoked
        reg.revoke(second, keccak256("b")); // Valid -> Revoked
        vm.stopPrank();
        assertEq(uint8(reg.attestationOf(first).status), uint8(CheckAttestationRegistry.Status.Revoked));
        assertEq(reg.attestationOf(second).revokeReasonHash, keccak256("b"));
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626));
    }

    function test_revoke_rejects() public {
        uint256 id = _allPass(1);
        vm.startPrank(issuer);
        vm.expectRevert(CheckAttestationRegistry.EmptyReason.selector);
        reg.revoke(id, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(CheckAttestationRegistry.UnknownAttestation.selector, uint256(7)));
        reg.revoke(7, keccak256("x"));
        reg.revoke(id, keccak256("x"));
        vm.expectRevert(
            abi.encodeWithSelector(
                CheckAttestationRegistry.NotRevocable.selector, id, CheckAttestationRegistry.Status.Revoked
            )
        );
        reg.revoke(id, keccak256("again"));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- isCompliant, latest

    function test_isCompliant_boundaries() public {
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626)); // nothing yet
        _allPass(1);
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
        _attest(_params(MAINNET, VAULT, 2, 29, 0, 1, 0)); // one inconclusive
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626));
        _attest(_params(MAINNET, VAULT, 3, 29, 0, 0, 1)); // one not applicable
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626));
        _attest(_params(MAINNET, VAULT, 4, 29, 1, 0, 0)); // one fail
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626));
        _attest(_params(MAINNET, VAULT, 5, 0, 0, 30, 0)); // nothing passed
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626));
        uint256 id = _allPass(6);
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
        assertFalse(reg.isCompliant(TESTNET, VAULT, ERC4626)); // other chain
        vm.prank(issuer);
        reg.revoke(id, keccak256("x"));
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626)); // a revoked latest does not fall back to older ones
    }

    function testFuzz_isCompliant_matchesDefinition(uint16 pass, uint16 fail, uint16 inc, uint16 na) public {
        pass = uint16(bound(pass, 0, 64));
        fail = uint16(bound(fail, 0, 64));
        inc = uint16(bound(inc, 0, 64));
        na = uint16(bound(na, 0, 64));
        vm.assume(uint256(pass) + fail + inc + na > 0);
        _attest(_params(MAINNET, VAULT, 1, pass, fail, inc, na));
        bool expected = pass > 0 && fail == 0 && inc == 0 && na == 0;
        assertEq(reg.isCompliant(MAINNET, VAULT, ERC4626), expected);
        assertEq(reg.isCompliantWith(MAINNET, VAULT, ERC4626, keccak256("suite")), expected);
        assertFalse(reg.isCompliantWith(MAINNET, VAULT, ERC4626, keccak256("other suite")));
    }

    function test_isCompliantWith_pinsTheSuite() public {
        bytes32 suite = keccak256("suite");
        assertFalse(reg.isCompliantWith(MAINNET, VAULT, ERC4626, suite)); // nothing yet
        _allPass(1);
        assertTrue(reg.isCompliantWith(MAINNET, VAULT, ERC4626, suite));
        assertFalse(reg.isCompliantWith(MAINNET, VAULT, ERC4626, keccak256("other suite")));
        assertFalse(reg.isCompliantWith(MAINNET, VAULT, ERC20, suite)); // other standard
        // A newer all-pass attestation with another suite: isCompliant stays true, isCompliantWith the old
        // suite turns false and does not fall back to the older attestation.
        CheckAttestationRegistry.AttestParams memory p = _params(MAINNET, VAULT, 2, 30, 0, 0, 0);
        p.suiteHash = keccak256("other suite");
        uint256 id = _attest(p);
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
        assertFalse(reg.isCompliantWith(MAINNET, VAULT, ERC4626, suite));
        assertTrue(reg.isCompliantWith(MAINNET, VAULT, ERC4626, keccak256("other suite")));
        vm.prank(issuer);
        reg.revoke(id, keccak256("x"));
        assertFalse(reg.isCompliantWith(MAINNET, VAULT, ERC4626, keccak256("other suite")));
    }

    function test_isCompliant_staysTrueAfterIssuerRemoved() public {
        // Removing an issuer does not touch what it attested (ADR 0004): the attestation stays Valid.
        uint256 id = _allPass(1);
        reg.setIssuer(issuer, false);
        assertTrue(reg.isCompliant(MAINNET, VAULT, ERC4626));
        assertEq(uint8(reg.attestationOf(id).status), uint8(CheckAttestationRegistry.Status.Valid));
        // The removed issuer can no longer revoke it; any remaining issuer can, and can supersede it.
        vm.prank(issuer);
        vm.expectRevert(CheckAttestationRegistry.NotIssuer.selector);
        reg.revoke(id, keccak256("x"));
        address other = makeAddr("other issuer");
        reg.setIssuer(other, true);
        vm.prank(other);
        uint256 next = reg.attest(_params(MAINNET, VAULT, 2, 29, 1, 0, 0));
        assertEq(reg.attestationOf(id).supersededBy, next);
        assertEq(reg.attestationOf(next).issuer, other);
        assertFalse(reg.isCompliant(MAINNET, VAULT, ERC4626));
    }

    function test_latest_revertsWhenNone() public {
        vm.expectRevert(
            abi.encodeWithSelector(CheckAttestationRegistry.NoAttestation.selector, MAINNET, VAULT, ERC4626)
        );
        reg.latest(MAINNET, VAULT, ERC4626);
        vm.expectRevert(abi.encodeWithSelector(CheckAttestationRegistry.UnknownAttestation.selector, uint256(0)));
        reg.attestationOf(0);
    }

    // ---------------------------------------------------------------- suiteHash

    function _suite() internal pure returns (CheckAttestationRegistry.Suite memory) {
        return CheckAttestationRegistry.Suite({
            standard: "erc4626",
            upstreamRepo: "https://github.com/a16z/erc4626-tests",
            upstreamCommit: bytes20(hex"ac485460e014f22807c1ff687e0b4dc3af96ee40"),
            forgeStdCommit: bytes20(hex"bf647bd6046f2f7da30d0c2bf435e5c76a780c1b"),
            forgeVersion: "forge Version: 1.5.1-Homebrew",
            harnessSha256: 0xbba3289225c7d99cf1a395446c110c21356a8b48b6f9743c82b3886d2e741582,
            sfPropertiesSha256: 0xfc1755ebeef03b7fb6d77baf80cf6fbb4dde35b8f54cfa3d49cfbbc10c723198,
            propertiesHash: PROPERTIES_HASH,
            foundryTomlSha256: 0x9a6d9659052d552b6b19810de600561dc6d9bbb1a7aa45d6f04669ff4603e77e,
            runs: 16,
            maxTestRejects: 4096,
            delta: 0
        });
    }

    function test_suiteHashOf_isKeccakOfTheEncodedTuple() public view {
        CheckAttestationRegistry.Suite memory s = _suite();
        assertEq(reg.suiteHashOf(s), keccak256(abi.encode(s)));
        // The same value packages/core computes for the Morpho report at block 109061472 (attest.test.ts).
        assertEq(reg.suiteHashOf(s), SUITE_HASH_VECTOR);
        s.runs = 32;
        assertTrue(reg.suiteHashOf(s) != SUITE_HASH_VECTOR);
        s = _suite();
        s.delta = 1;
        assertTrue(reg.suiteHashOf(s) != SUITE_HASH_VECTOR);
        s = _suite();
        s.forgeVersion = "forge Version: 1.5.2";
        assertTrue(reg.suiteHashOf(s) != SUITE_HASH_VECTOR);
        s = _suite();
        s.propertiesHash = keccak256("a property table in another order");
        assertTrue(reg.suiteHashOf(s) != SUITE_HASH_VECTOR);
    }

    /// keccak256 of the canonical JSON of ERC4626_CHECK_PROPERTIES (packages/core), the 30 properties in bit order.
    bytes32 internal constant PROPERTIES_HASH = 0x33117c4fed6c8e64829e6397d577a69153a43774fddd609e952264514e270204;
    bytes32 internal constant SUITE_HASH_VECTOR = 0x49a246fc992c88a122f878579e0ee415f79ff4cf8c5f021b21a12d703e83023e;

    // ---------------------------------------------------------------- no external calls

    /// The registry makes no external call (CALL, CALLCODE, DELEGATECALL, STATICCALL), so no reentrancy
    /// guard is needed. Walks the runtime code, skipping PUSH data and the CBOR metadata tail.
    function test_runtimeCode_hasNoExternalCall() public view {
        bytes memory code = address(reg).code;
        uint256 metaLen = (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        uint256 end = code.length - 2 - metaLen;
        for (uint256 i = 0; i < end; ++i) {
            uint8 op = uint8(code[i]);
            assertTrue(op != 0xf1 && op != 0xf2 && op != 0xf4 && op != 0xfa, "external call opcode");
            if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
        }
    }
}
