// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CheckAttestationRegistry
/// @notice Onchain record of `specfirst check` results: a third-party property suite run against a
///         contract on some chain (the subject chain, possibly another chain than this one) at one block.
/// @dev What an attestation claims, and what it does not:
///      - The issuer reports `subjectCodeHash`. This registry cannot read another chain, so the value is
///        the issuer's word; anyone can check it against the subject chain at `blockNumber` and rerun the
///        suite from the report behind `reportHash`.
///      - When the subject is a proxy, `subjectCodeHash` is the proxy's own runtime code and says nothing
///        about the logic behind it. The implementation is identified by `implementationKey` (the report's
///        identity.implementationKey, derived from the implementation's code when it was resolved).
///      - Attestations are kept per (subjectChainId, subject, standardId), standardId =
///        keccak256(bytes(standard)), e.g. keccak256("erc4626"). A check of one standard never supersedes
///        a check of another.
///      - `isCompliant` and `isCompliantWith` only mean "this suite passed at this block for the code the
///        issuer reported". They are not an audit, say nothing about other properties, other blocks or
///        later upgrades, and a proxy's implementation can change after `blockNumber`.
///      - `suiteHash` names what ran: keccak256(abi.encode(Suite)), the Suite struct encoded as one ABI
///        tuple; see suiteHashOf. Suite.propertiesHash fixes what bit i of the bitmaps means.
///      - `reportHash` is keccak256 of the report's canonical JSON (RFC 8785, JCS), UTF-8.
///      - Bit i of passedBitmap / failedBitmap is result i of the report, in the report's order.
///      Roles: the owner is the deployer and is immutable (no transfer, no renounce); it only adds and
///      removes issuers. If its key is lost, the issuer set is frozen and a new registry has to be deployed.
///      Any issuer can supersede or revoke any attestation, including another issuer's. Removing an issuer
///      does not touch what it attested: its attestations stay Valid until superseded or revoked.
///      The contract makes no external calls, so there is nothing to re-enter.
contract CheckAttestationRegistry {
    enum Status {
        None,
        Valid,
        Superseded,
        Revoked
    }

    struct Attestation {
        uint64 subjectChainId;
        address subject;
        bytes32 standardId; // keccak256(bytes(standard)), e.g. keccak256("erc4626")
        uint64 blockNumber; // subject chain block the suite ran at
        bytes32 implementationKey; // report identity.implementationKey: the implementation's code when resolved
        bytes32 subjectCodeHash; // keccak256 of the subject's own runtime code at blockNumber (a proxy's code for a proxy)
        bytes32 suiteHash;
        bytes32 reportHash;
        uint16 passCount;
        uint16 failCount;
        uint16 inconclusiveCount;
        uint16 notApplicableCount;
        uint256 passedBitmap;
        uint256 failedBitmap;
        uint64 issuedAt;
        address issuer;
        Status status;
        uint256 supersededBy; // id of the attestation that replaced this one, when Superseded
        bytes32 revokeReasonHash;
        string reportURI;
    }

    struct AttestParams {
        uint64 subjectChainId;
        address subject;
        bytes32 standardId;
        uint64 blockNumber;
        bytes32 implementationKey;
        bytes32 subjectCodeHash;
        bytes32 suiteHash;
        bytes32 reportHash;
        uint16 passCount;
        uint16 failCount;
        uint16 inconclusiveCount;
        uint16 notApplicableCount;
        uint256 passedBitmap;
        uint256 failedBitmap;
        string reportURI;
    }

    /// @notice The inputs of suiteHash, as recorded in a Specfirst check report. The seed and the sender
    ///         are not part of it: they change per run while the suite stays the same.
    struct Suite {
        string standard;
        string upstreamRepo;
        bytes20 upstreamCommit;
        bytes20 forgeStdCommit;
        string forgeVersion; // report toolchain.forgeVersion, the first line of `forge --version` ("" when null)
        bytes32 harnessSha256;
        bytes32 sfPropertiesSha256;
        bytes32 propertiesHash; // keccak256 of the canonical JSON of the property table: what bit i means
        bytes32 foundryTomlSha256;
        uint256 runs;
        uint256 maxTestRejects;
        uint256 delta;
    }

    /// @dev Carries the submitted AttestParams as one tuple plus the issuer, so an indexer can rebuild the
    ///      whole attestation from the log (issuedAt is the block timestamp, status starts Valid). The params
    ///      are a struct rather than 17 flat event arguments because the flat form does not compile without
    ///      via-IR (stack too deep when every field is pushed for the emit).
    event Attested(
        uint256 indexed id, uint64 indexed subjectChainId, address indexed subject, address issuer, AttestParams params
    );
    event Superseded(uint256 indexed id, uint256 indexed byId);
    event Revoked(uint256 indexed id, bytes32 reasonHash);
    event IssuerSet(address indexed issuer, bool allowed);

    error NotOwner();
    error NotIssuer();
    error ZeroAddress();
    error ZeroChainId();
    error EmptyStandardId();
    error EmptyImplementationKey();
    error EmptyCodeHash();
    error EmptySuiteHash();
    error EmptyReportHash();
    error ReportURITooLong(uint256 length);
    error InvalidCounts(uint256 total);
    error InvalidBitmaps();
    error OlderThanLatest(uint64 blockNumber, uint64 latestBlockNumber);
    error UnknownAttestation(uint256 id);
    error NotRevocable(uint256 id, Status status);
    error EmptyReason();
    error NoAttestation(uint64 subjectChainId, address subject, bytes32 standardId);

    /// @notice Longest reportURI accepted, in bytes.
    uint256 public constant MAX_REPORT_URI_LENGTH = 512;

    /// @dev keccak256 of empty code: an account without code.
    bytes32 private constant EMPTY_CODE_HASH = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;
    mapping(address => bool) public isIssuer;

    Attestation[] private _attestations;
    /// @dev keccak256(abi.encode(subjectChainId, subject, standardId)) => latest id + 1 (0: none).
    mapping(bytes32 => uint256) private _latestPlusOne;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyIssuer() {
        _onlyIssuer();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    /// @notice Allow or disallow an issuer. Disallowing does not change the issuer's past attestations.
    function setIssuer(address issuer, bool allowed) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        isIssuer[issuer] = allowed;
        emit IssuerSet(issuer, allowed);
    }

    /// @notice Record a check result for `p.subject` on chain `p.subjectChainId` under standard
    ///         `p.standardId`. The previous latest attestation of the same (chain, subject, standard) becomes
    ///         Superseded when it is Valid.
    /// @dev Counts must add up to 1..256 results, the bitmaps must have exactly passCount and failCount
    ///      bits, no bit at or above the result count, and no bit in both. standardId, implementationKey,
    ///      suiteHash and reportHash must not be zero, the code hash neither zero nor the empty-code hash,
    ///      and reportURI at most MAX_REPORT_URI_LENGTH bytes. While the latest attestation is Valid, a new
    ///      one cannot be for an earlier block; after it is Revoked any block is accepted, so an attestation
    ///      recorded with a wrong (too high) block number can be revoked and replaced.
    function attest(AttestParams calldata p) external onlyIssuer returns (uint256 id) {
        if (p.subject == address(0)) revert ZeroAddress();
        if (p.subjectChainId == 0) revert ZeroChainId();
        if (p.standardId == bytes32(0)) revert EmptyStandardId();
        if (p.implementationKey == bytes32(0)) revert EmptyImplementationKey();
        if (p.subjectCodeHash == bytes32(0) || p.subjectCodeHash == EMPTY_CODE_HASH) revert EmptyCodeHash();
        if (p.suiteHash == bytes32(0)) revert EmptySuiteHash();
        if (p.reportHash == bytes32(0)) revert EmptyReportHash();
        if (bytes(p.reportURI).length > MAX_REPORT_URI_LENGTH) revert ReportURITooLong(bytes(p.reportURI).length);
        uint256 total = uint256(p.passCount) + p.failCount + p.inconclusiveCount + p.notApplicableCount;
        if (total == 0 || total > 256) revert InvalidCounts(total);
        _checkBitmaps(p.passedBitmap, p.failedBitmap, p.passCount, p.failCount, total);

        bytes32 key = _key(p.subjectChainId, p.subject, p.standardId);
        id = _attestations.length;
        uint256 prevPlusOne = _latestPlusOne[key];
        if (prevPlusOne != 0) {
            Attestation storage prev = _attestations[prevPlusOne - 1];
            // The latest is Valid or Revoked, never Superseded. Only a Valid latest pins the block order.
            if (prev.status == Status.Valid) {
                if (p.blockNumber < prev.blockNumber) revert OlderThanLatest(p.blockNumber, prev.blockNumber);
                prev.status = Status.Superseded;
                prev.supersededBy = id;
                emit Superseded(prevPlusOne - 1, id);
            }
        }
        _latestPlusOne[key] = id + 1;

        Attestation storage a = _attestations.push();
        a.subjectChainId = p.subjectChainId;
        a.subject = p.subject;
        a.standardId = p.standardId;
        a.blockNumber = p.blockNumber;
        a.implementationKey = p.implementationKey;
        a.subjectCodeHash = p.subjectCodeHash;
        a.suiteHash = p.suiteHash;
        a.reportHash = p.reportHash;
        a.passCount = p.passCount;
        a.failCount = p.failCount;
        a.inconclusiveCount = p.inconclusiveCount;
        a.notApplicableCount = p.notApplicableCount;
        a.passedBitmap = p.passedBitmap;
        a.failedBitmap = p.failedBitmap;
        a.issuedAt = uint64(block.timestamp);
        a.issuer = msg.sender;
        a.status = Status.Valid;
        a.reportURI = p.reportURI;

        emit Attested(id, p.subjectChainId, p.subject, msg.sender, p);
    }

    /// @notice Revoke a Valid or Superseded attestation. `reasonHash` commits to the evidence, e.g. the
    ///         keccak256 of a newer report or of a written explanation.
    function revoke(uint256 id, bytes32 reasonHash) external onlyIssuer {
        if (reasonHash == bytes32(0)) revert EmptyReason();
        if (id >= _attestations.length) revert UnknownAttestation(id);
        Attestation storage a = _attestations[id];
        if (a.status != Status.Valid && a.status != Status.Superseded) revert NotRevocable(id, a.status);
        a.status = Status.Revoked;
        a.revokeReasonHash = reasonHash;
        emit Revoked(id, reasonHash);
    }

    /// @notice True when the latest attestation of (subjectChainId, subject, standardId) is Valid, has at
    ///         least one pass and no fail, inconclusive or not-applicable result. It means only "this suite
    ///         passed at this block for the code the issuer reported", nothing more; it does not say which
    ///         suite. Integrators that rely on a specific suite should call isCompliantWith.
    function isCompliant(uint64 subjectChainId, address subject, bytes32 standardId) external view returns (bool) {
        uint256 plusOne = _latestPlusOne[_key(subjectChainId, subject, standardId)];
        return plusOne != 0 && _passed(_attestations[plusOne - 1]);
    }

    /// @notice isCompliant, and the latest attestation was made with the suite `suiteHash`. It means only
    ///         that this suite passed at this block for the code the issuer reported. A latest attestation
    ///         with another suiteHash gives false; there is no fallback to an older attestation.
    function isCompliantWith(uint64 subjectChainId, address subject, bytes32 standardId, bytes32 suiteHash)
        external
        view
        returns (bool)
    {
        uint256 plusOne = _latestPlusOne[_key(subjectChainId, subject, standardId)];
        if (plusOne == 0) return false;
        Attestation storage a = _attestations[plusOne - 1];
        return a.suiteHash == suiteHash && _passed(a);
    }

    /// @notice Latest attestation of (subjectChainId, subject, standardId). Reverts with NoAttestation when
    ///         there is none.
    function latest(uint64 subjectChainId, address subject, bytes32 standardId)
        external
        view
        returns (uint256 id, Attestation memory a)
    {
        uint256 plusOne = _latestPlusOne[_key(subjectChainId, subject, standardId)];
        if (plusOne == 0) revert NoAttestation(subjectChainId, subject, standardId);
        id = plusOne - 1;
        a = _attestations[id];
    }

    function attestationOf(uint256 id) external view returns (Attestation memory) {
        if (id >= _attestations.length) revert UnknownAttestation(id);
        return _attestations[id];
    }

    function attestationCount() external view returns (uint256) {
        return _attestations.length;
    }

    /// @notice suiteHash of a Suite: keccak256(abi.encode(s)), the struct encoded as one ABI tuple. Specfirst's
    ///         core computes the same value (suiteHash in packages/core/src/attest).
    function suiteHashOf(Suite calldata s) external pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(s));
    }

    function _passed(Attestation storage a) private view returns (bool) {
        return a.status == Status.Valid && a.passCount > 0 && a.failCount == 0 && a.inconclusiveCount == 0
            && a.notApplicableCount == 0;
    }

    function _key(uint64 subjectChainId, address subject, bytes32 standardId) private pure returns (bytes32) {
        // forge-lint: disable-next-line(asm-keccak256)
        return keccak256(abi.encode(subjectChainId, subject, standardId));
    }

    function _checkBitmaps(uint256 passed, uint256 failed, uint16 passCount, uint16 failCount, uint256 total)
        private
        pure
    {
        if (passed & failed != 0) revert InvalidBitmaps();
        if (total < 256 && (passed | failed) >> total != 0) revert InvalidBitmaps();
        if (_popcount(passed) != passCount || _popcount(failed) != failCount) revert InvalidBitmaps();
    }

    function _popcount(uint256 x) private pure returns (uint256 n) {
        while (x != 0) {
            x &= x - 1;
            ++n;
        }
    }

    function _onlyOwner() private view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyIssuer() private view {
        if (!isIssuer[msg.sender]) revert NotIssuer();
    }
}
