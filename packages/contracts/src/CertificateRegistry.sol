// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title CertificateRegistry
/// @notice Onchain registry of Specfirst certificates. A certificate states that the issuer
///         produced a report for the exact bytecode at `target`. Certificates are append-only per
///         target and are linked into a version lineage per projectId.
/// @dev certId is the zero-based index into the target's certificate list.
contract CertificateRegistry {
    enum Status {
        None,
        Valid,
        Superseded,
        Revoked
    }

    struct Certificate {
        bytes32 projectId; // keccak256 of the spec projectId string
        bytes32 specHash; // whole spec file
        bytes32 invariantSetHash; // invariant ids, kinds, texts and the unverified list only
        bytes32 propertyHash; // locked test/specfirst tree, SpecfirstProps included
        bytes32 codeHash; // target.codehash read onchain at issue time
        bytes32 reportHash;
        uint64 issuedAt;
        uint16 passedCount;
        uint16 totalCount;
        uint256 passedBitmap; // forge verdicts only, Ultrafuzz results are not included
        uint32 rehearsalTxCount;
        Status status;
        address supersededBy; // target of the newer version that replaced this one
        bytes32 revokeReasonHash;
        string reportURI;
    }

    struct IssueParams {
        address target;
        bytes32 projectId;
        bytes32 specHash;
        bytes32 invariantSetHash;
        bytes32 propertyHash;
        bytes32 reportHash;
        uint16 passedCount;
        uint16 totalCount;
        uint256 passedBitmap;
        uint32 rehearsalTxCount;
        string reportURI;
    }

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

    error NotOwner();
    error NotIssuer();
    error ZeroAddress();
    error TargetHasNoCode(address target);
    error InvalidCounts(uint16 passedCount, uint16 totalCount);
    error PartialCannotSupersede(address currentTarget, uint256 currentCertId);
    error UnknownCertificate(address target, uint256 certId);
    error NotRevocable(address target, uint256 certId, Status status);
    error EmptyEvidence();
    error NoCertificate(address target);

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;
    mapping(address => bool) public isIssuer;

    mapping(address => Certificate[]) private _certs;
    mapping(bytes32 => address) private _currentTarget;
    /// @dev certId (on _currentTarget[projectId]) that anchors the lineage of each projectId.
    mapping(bytes32 => uint256) private _currentCertId;

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

    function setIssuer(address issuer, bool allowed) external onlyOwner {
        if (issuer == address(0)) revert ZeroAddress();
        isIssuer[issuer] = allowed;
        emit IssuerSet(issuer, allowed);
    }

    /// @notice Issue a certificate for `p.target`.
    /// @dev Complete certificates (passedCount == totalCount) move the projectId lineage to
    ///      `p.target`, supersede the previous current certificate of that projectId when it is
    ///      Valid, and supersede the target's own previous certificate when it is Valid.
    ///      Partial certificates never touch the lineage or earlier certificates, and revert when
    ///      they would shadow a Valid complete certificate, either the current one of the
    ///      projectId or the target's own latest one.
    function issue(IssueParams calldata p) external onlyIssuer returns (uint256 certId) {
        address target = p.target;
        if (target.code.length == 0) revert TargetHasNoCode(target);
        if (p.totalCount == 0 || p.passedCount > p.totalCount) revert InvalidCounts(p.passedCount, p.totalCount);

        Certificate[] storage list = _certs[target];
        certId = list.length;
        bool complete = p.passedCount == p.totalCount;
        address prevTarget = _currentTarget[p.projectId];

        if (!complete) {
            if (prevTarget != address(0)) {
                uint256 prevId = _currentCertId[p.projectId];
                if (_isValidComplete(_certs[prevTarget][prevId])) revert PartialCannotSupersede(prevTarget, prevId);
            }
            if (certId > 0 && _isValidComplete(list[certId - 1])) revert PartialCannotSupersede(target, certId - 1);
        } else {
            // Target's own previous certificate, e.g. same code with a revised spec.
            if (certId > 0) _supersede(list[certId - 1], target);
            // Lineage move to a new address within the projectId.
            if (prevTarget != address(0) && prevTarget != target) {
                _supersede(_certs[prevTarget][_currentCertId[p.projectId]], target);
                emit CertificateSuperseded(prevTarget, target, p.projectId);
            }
            _currentTarget[p.projectId] = target;
            _currentCertId[p.projectId] = certId;
        }

        Certificate storage c = list.push();
        c.projectId = p.projectId;
        c.specHash = p.specHash;
        c.invariantSetHash = p.invariantSetHash;
        c.propertyHash = p.propertyHash;
        c.codeHash = target.codehash;
        c.reportHash = p.reportHash;
        c.issuedAt = uint64(block.timestamp);
        c.passedCount = p.passedCount;
        c.totalCount = p.totalCount;
        c.passedBitmap = p.passedBitmap;
        c.rehearsalTxCount = p.rehearsalTxCount;
        c.status = Status.Valid;
        c.reportURI = p.reportURI;

        _emitIssued(target, certId, c);
    }

    /// @notice Revoke a Valid or Superseded certificate. Evidence of the violation is mandatory.
    function revoke(address target, uint256 certId, bytes32 reasonHash, string calldata evidenceURI)
        external
        onlyIssuer
    {
        if (bytes(evidenceURI).length == 0) revert EmptyEvidence();
        Certificate[] storage list = _certs[target];
        if (certId >= list.length) revert UnknownCertificate(target, certId);
        Certificate storage c = list[certId];
        if (c.status != Status.Valid && c.status != Status.Superseded) revert NotRevocable(target, certId, c.status);
        c.status = Status.Revoked;
        c.revokeReasonHash = reasonHash;
        emit CertificateRevoked(target, certId, reasonHash, evidenceURI);
    }

    /// @notice Code truth only: the latest certificate of `target` is not Revoked, all
    ///         invariants passed, and the deployed code still matches. Superseded counts as true.
    function isCertified(address target) public view returns (bool) {
        uint256 n = _certs[target].length;
        if (n == 0) return false;
        return _certifies(_certs[target][n - 1], target);
    }

    /// @notice isCertified plus a pinned invariant set, so integrators can reject weak specs.
    function isCertifiedWith(address target, bytes32 invariantSetHash) external view returns (bool) {
        uint256 n = _certs[target].length;
        if (n == 0) return false;
        Certificate storage c = _certs[target][n - 1];
        return _certifies(c, target) && c.invariantSetHash == invariantSetHash;
    }

    /// @notice True when `target` is the current version of the projectId of its latest certificate.
    function isLatest(address target) external view returns (bool) {
        uint256 n = _certs[target].length;
        if (n == 0) return false;
        return _currentTarget[_certs[target][n - 1].projectId] == target;
    }

    /// @notice Latest certificate of `target`. Reverts with NoCertificate when there is none.
    function latest(address target) external view returns (uint256 certId, Certificate memory c, bool codeMatches) {
        uint256 n = _certs[target].length;
        if (n == 0) revert NoCertificate(target);
        certId = n - 1;
        c = _certs[target][certId];
        codeMatches = c.codeHash == target.codehash;
    }

    function currentTargetOf(bytes32 projectId) external view returns (address) {
        return _currentTarget[projectId];
    }

    function certificateOf(address target, uint256 certId) external view returns (Certificate memory) {
        if (certId >= _certs[target].length) revert UnknownCertificate(target, certId);
        return _certs[target][certId];
    }

    function certificateCount(address target) external view returns (uint256) {
        return _certs[target].length;
    }

    function _onlyOwner() private view {
        if (msg.sender != owner) revert NotOwner();
    }

    function _onlyIssuer() private view {
        if (!isIssuer[msg.sender]) revert NotIssuer();
    }

    function _certifies(Certificate storage c, address target) private view returns (bool) {
        return c.status != Status.Revoked && c.codeHash == target.codehash && c.passedCount == c.totalCount;
    }

    function _isValidComplete(Certificate storage c) private view returns (bool) {
        return c.status == Status.Valid && c.passedCount == c.totalCount;
    }

    function _supersede(Certificate storage c, address newTarget) private {
        if (c.status == Status.Valid) {
            c.status = Status.Superseded;
            c.supersededBy = newTarget;
        }
    }

    function _emitIssued(address target, uint256 certId, Certificate storage c) private {
        emit CertificateIssued(
            target,
            c.projectId,
            certId,
            c.invariantSetHash,
            c.propertyHash,
            c.codeHash,
            c.reportHash,
            c.passedCount,
            c.totalCount
        );
    }
}
