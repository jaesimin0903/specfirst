// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CheckAttestationRegistry} from "./CheckAttestationRegistry.sol";

/// @title CheckRequestDesk
/// @notice Paid requests for a `specfirst check`: anyone pays `fee` in the native coin to have the subject
///         (a contract on some chain) checked against a standard. The fee is held in escrow until the worker
///         fulfills the request with a matching attestation in `registry`, rejects it (full refund), or the
///         request times out and anyone refunds it to the requester.
/// @dev Accounting: `escrowed` is the sum of the fees of Pending requests, `earned` grows only on fulfill,
///      and `withdraw` pays out at most `earned - withdrawn`, so escrowed fees can never be withdrawn. Without
///      forced transfers (selfdestruct, coinbase), the balance is exactly escrowed + earned - withdrawn; the
///      contract has no receive or fallback function, and coins forced in anyway stay locked.
///      Fulfill conditions: the attestation exists in `registry`, is about the request's subjectChainId,
///      subject and standardId, was issued at or after the request (issuedAt >= requestedAt, both block
///      timestamps in seconds), and is not Revoked. The desk cannot tell a true attestation from a false
///      one: the worker is expected to be an issuer of `registry`, and an issuer can attest anything
///      (docs/adr/0005).
///      Request ids are the zero based index of a global list: valid ids are 0..requestCount()-1.
///      Reject codes are short ASCII strings right padded with zeros into a bytes32 ("not-erc4626").
///      A requester that refuses the native coin (a contract without a payable receive) cannot be
///      refunded: reject and refundExpired revert with TransferFailed and its fee stays escrowed.
///      Roles: the owner is set at deployment and is immutable (no transfer, no renounce), as in
///      CheckAttestationRegistry; it sets the fee and the worker and withdraws earned fees. If its key is
///      lost, the fee and the worker are frozen and a new desk has to be deployed. The registry and the
///      timeout are immutable too.
///      Coins leave only through a call made after every state change, under a reentrancy lock.
contract CheckRequestDesk {
    enum RequestStatus {
        None,
        Pending,
        Fulfilled,
        Rejected,
        Refunded
    }

    struct Request {
        address requester;
        uint64 subjectChainId;
        address subject;
        bytes32 standardId; // keccak256(bytes(standard)), e.g. keccak256("erc4626"), as in the registry
        uint96 fee; // what the requester paid; later fee changes do not touch it
        uint64 requestedAt; // block.timestamp of requestCheck
        RequestStatus status;
        uint256 attestationId; // registry attestation the request was fulfilled with (Fulfilled only)
        bytes32 rejectReason; // short ASCII code, right padded with zeros (Rejected only)
    }

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

    error NotOwner();
    error NotWorker();
    error ZeroAddress();
    error ZeroChainId();
    error EmptyStandardId();
    error ZeroTimeout();
    error RegistryWithoutCode(address registry);
    error WrongFee(uint256 sent, uint96 fee);
    error UnknownRequest(uint256 id);
    error NotPending(uint256 id, RequestStatus status);
    error UnknownAttestation(uint256 attestationId);
    error AttestationMismatch(uint256 id, uint256 attestationId);
    error AttestationBeforeRequest(uint256 id, uint256 attestationId, uint64 issuedAt, uint64 requestedAt);
    error AttestationRevoked(uint256 attestationId);
    error EmptyReason();
    error NotExpired(uint256 id, uint256 expiresAt);
    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount);
    error Reentrancy();

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    CheckAttestationRegistry public immutable registry;
    /// @notice Seconds after requestedAt from which anyone can refund a Pending request.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint64 public immutable timeout;

    address public worker;
    uint96 public fee;
    uint256 public earned;
    uint256 public withdrawn;
    /// @notice Sum of the fees of Pending requests.
    uint256 public escrowed;

    Request[] private _requests;
    uint256 private _lock = 1;

    modifier onlyOwner() {
        _onlyOwner();
        _;
    }

    modifier onlyWorker() {
        _onlyWorker();
        _;
    }

    modifier nonReentrant() {
        _enter();
        _;
        _leave();
    }

    constructor(address owner_, address worker_, address registry_, uint96 fee_, uint64 timeout_) {
        if (owner_ == address(0) || worker_ == address(0) || registry_ == address(0)) revert ZeroAddress();
        if (registry_.code.length == 0) revert RegistryWithoutCode(registry_);
        if (timeout_ == 0) revert ZeroTimeout();
        owner = owner_;
        registry = CheckAttestationRegistry(registry_);
        timeout = timeout_;
        worker = worker_;
        fee = fee_;
        emit WorkerSet(worker_);
        emit FeeSet(fee_);
    }

    /// @notice Pay exactly `fee` to have `subject` on chain `subjectChainId` checked against `standardId`.
    function requestCheck(uint64 subjectChainId, address subject, bytes32 standardId)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (subject == address(0)) revert ZeroAddress();
        if (subjectChainId == 0) revert ZeroChainId();
        if (standardId == bytes32(0)) revert EmptyStandardId();
        uint96 f = fee;
        if (msg.value != f) revert WrongFee(msg.value, f);
        id = _requests.length;
        _requests.push(
            Request({
                requester: msg.sender,
                subjectChainId: subjectChainId,
                subject: subject,
                standardId: standardId,
                fee: f,
                requestedAt: uint64(block.timestamp),
                status: RequestStatus.Pending,
                attestationId: 0,
                rejectReason: bytes32(0)
            })
        );
        escrowed += f;
        emit CheckRequested(id, msg.sender, subjectChainId, subject, standardId, f);
    }

    /// @notice Close a Pending request with attestation `attestationId` of `registry`; its fee is earned.
    ///         The attestation must be about the request's subject, chain and standard, issued at or after
    ///         the request, and not Revoked.
    function fulfill(uint256 id, uint256 attestationId) external onlyWorker nonReentrant {
        Request storage r = _pending(id);
        if (attestationId >= registry.attestationCount()) revert UnknownAttestation(attestationId);
        CheckAttestationRegistry.Attestation memory a = registry.attestationOf(attestationId);
        if (a.subjectChainId != r.subjectChainId || a.subject != r.subject || a.standardId != r.standardId) {
            revert AttestationMismatch(id, attestationId);
        }
        if (a.issuedAt < r.requestedAt) revert AttestationBeforeRequest(id, attestationId, a.issuedAt, r.requestedAt);
        if (a.status == CheckAttestationRegistry.Status.Revoked) revert AttestationRevoked(attestationId);
        r.status = RequestStatus.Fulfilled;
        r.attestationId = attestationId;
        uint96 f = r.fee;
        escrowed -= f;
        earned += f;
        emit CheckFulfilled(id, attestationId);
    }

    /// @notice Close a Pending request without a check and refund its whole fee to the requester in the
    ///         same transaction. `reasonCode` is a short ASCII code right padded with zeros ("not-erc4626").
    function reject(uint256 id, bytes32 reasonCode) external onlyWorker nonReentrant {
        if (reasonCode == bytes32(0)) revert EmptyReason();
        Request storage r = _pending(id);
        r.status = RequestStatus.Rejected;
        r.rejectReason = reasonCode;
        uint96 f = r.fee;
        escrowed -= f;
        emit CheckRejected(id, reasonCode);
        _send(r.requester, f);
    }

    /// @notice Anyone can refund a request that is still Pending once block.timestamp >= requestedAt +
    ///         timeout. The fee goes to the requester, not to the caller.
    function refundExpired(uint256 id) external nonReentrant {
        Request storage r = _pending(id);
        uint256 expiresAt = uint256(r.requestedAt) + timeout;
        if (block.timestamp < expiresAt) revert NotExpired(id, expiresAt);
        r.status = RequestStatus.Refunded;
        uint96 f = r.fee;
        escrowed -= f;
        emit CheckRefunded(id);
        _send(r.requester, f);
    }

    /// @notice Pay out every earned fee not withdrawn yet. Escrowed fees of Pending requests stay.
    function withdraw(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = earned - withdrawn;
        if (amount == 0) revert NothingToWithdraw();
        withdrawn += amount;
        emit FeesWithdrawn(to, amount);
        _send(to, amount);
    }

    /// @notice Fee for new requests. Pending requests keep the fee they paid.
    function setFee(uint96 fee_) external onlyOwner {
        fee = fee_;
        emit FeeSet(fee_);
    }

    /// @notice The only address that can fulfill and reject. Pending requests stay Pending.
    function setWorker(address worker_) external onlyOwner {
        if (worker_ == address(0)) revert ZeroAddress();
        worker = worker_;
        emit WorkerSet(worker_);
    }

    /// @notice Request `id`. Reverts with UnknownRequest when id >= requestCount().
    function requestOf(uint256 id) external view returns (Request memory) {
        if (id >= _requests.length) revert UnknownRequest(id);
        return _requests[id];
    }

    function requestCount() external view returns (uint256) {
        return _requests.length;
    }

    function _pending(uint256 id) private view returns (Request storage r) {
        if (id >= _requests.length) revert UnknownRequest(id);
        r = _requests[id];
        if (r.status != RequestStatus.Pending) revert NotPending(id, r.status);
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

    function _onlyWorker() private view {
        if (msg.sender != worker) revert NotWorker();
    }
}
