// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CheckAttestationRegistry} from "../CheckAttestationRegistry.sol";

/// @dev The ERC-4626 calls the gate makes. A vault is untrusted: any call to it may revert, lie, burn gas or re-enter.
interface IGateVault {
    function asset() external view returns (address);
    function balanceOf(address account) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
    function maxWithdraw(address owner) external view returns (uint256);
}

interface IGateAsset {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
}

/// @title AllocationGate
/// @notice How an integrator reads CheckAttestationRegistry on chain (docs/adr/0007). The owner moves the gate's idle
///         `asset` into an ERC-4626 vault only while the registry's latest attestation of that vault is compliant
///         (with the gate's suite, when it pins one), fresh, from a current issuer, about the code at the vault's
///         address and about a block that exists. Once that attestation is no longer good, anyone can pull the
///         gate's shares back out of the vault with `exit`: a keeper needs no key. The owner can exit at any time.
/// @dev The rules, in the order verdictOf applies them to the latest attestation of
///      (subjectChainId, vault, standardId):
///      1. none: NoAttestation;
///      2. registry.isCompliant false (Revoked, or not all results passed): NotCompliant;
///      3. the gate pins a suiteHash and the attestation has another one: OtherSuite;
///      4. its issuer is no longer registry.isIssuer: UntrustedIssuer;
///      5. its subjectCodeHash is not vault.codehash: CodeMismatch;
///      6. its blockNumber is above block.number (the vault is on this chain, so that block does not exist): FutureBlock;
///      7. issued more than maxAttestationAge seconds ago: Stale;
///      8. otherwise Compliant.
///      allocate needs Compliant. exit is open to anyone on any verdict but Compliant and Stale: an old attestation that
///      is still good is no reason to pull money out, since the watcher records unchanged re-checks without a
///      transaction. The owner may exit on any verdict, so money is never stuck once the attestations stop.
///      The vaults live on this chain, so subjectChainId must be block.chainid, and the gate can compare the attested
///      code hash and block with the vault's own. What it cannot check is the issuer's honesty (docs/adr/0005): a gate
///      that trusts the registry's issuers trusts each of them.
///      Vault calls are external and untrusted. allocate, exit and withdraw share a reentrancy lock (a storage flag,
///      as in CheckRequestDesk), and exit clears the position before it calls the vault. Each vault call in exit gets
///      a fixed stipend (vaultCallGas for redeem and withdraw, vaultViewGas for reads, set at deployment) and exit
///      reverts with InsufficientGas when less is left, so a gas estimate finds the limit an honest exit needs, and
///      whatever a call does with its stipend (revert, run out, answer without doing anything) is the vault's own
///      behavior. Progress is assets arriving on the gate's asset balance, never a vault's return value or success
///      flag: when redeem brings nothing, exit tries withdraw, and when that brings nothing either it records
///      ExitFailed and keeps the books instead of reverting. After assets arrived the books follow the vault's
///      balanceOf(gate), never above what they were; a vault that no longer answers balanceOf is taken to have taken
///      back what was asked, and the owner's resync sets the books to its balance once it answers. At most 32 bytes of
///      what a vault returns are copied. The asset is trusted (set at deployment). The owner is immutable (no transfer,
///      no renounce).
contract AllocationGate {
    enum Verdict {
        Compliant,
        Stale,
        NoAttestation,
        NotCompliant,
        UntrustedIssuer,
        CodeMismatch,
        FutureBlock,
        OtherSuite
    }

    enum ExitPath {
        Redeem,
        Withdraw
    }

    struct Position {
        uint256 shares; // vault shares the gate holds: what allocations added, then the vault's balanceOf(gate) after an exit or a resync
        uint256 assetsIn; // assets the vault took, summed over every allocation
        uint256 assetsOut; // assets exits brought back, summed
        uint64 lastAllocatedBlock; // 0: never allocated
        uint64 lastExitBlock; // block of the last exit attempt, failed ones included; 0: none
    }

    event Allocated(address indexed vault, uint256 indexed attestationId, uint256 assets, uint256 shares);
    /// @dev `assets` is the rise of the gate's asset balance; `shares` what the books dropped by: to the vault's
    ///      balanceOf(gate), or by all of them when the vault did not answer balanceOf after paying.
    event Exited(
        address indexed vault,
        uint256 indexed attestationId,
        address caller,
        Verdict verdict,
        ExitPath path,
        uint256 shares,
        uint256 assets
    );
    /// @dev No assets arrived; the books are kept. Each error is the first 4 bytes of that call's revert; zero when the
    ///      call did not revert (it answered without paying, or withdraw was not tried because maxWithdraw gave 0).
    event ExitFailed(
        address indexed vault,
        uint256 indexed attestationId,
        address caller,
        Verdict verdict,
        uint256 shares,
        bytes4 redeemError,
        bytes4 withdrawError
    );
    event IdleWithdrawn(address indexed to, uint256 amount);
    event Resynced(address indexed vault, uint256 fromShares, uint256 toShares);

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroMaxAge();
    error BadStipend(uint256 vaultCallGas, uint256 vaultViewGas);
    error EmptyStandardId();
    error WithoutCode(address account);
    error WrongSubjectChain(uint64 subjectChainId, uint256 chainId);
    error NoAttestation(address vault);
    error NotCompliant(address vault, uint256 attestationId);
    error OtherSuite(address vault, uint256 attestationId);
    error UntrustedIssuer(address vault, uint256 attestationId);
    error CodeMismatch(address vault, uint256 attestationId);
    error FutureBlock(address vault, uint256 attestationId);
    error StaleAttestation(address vault, uint256 attestationId);
    error AssetMismatch(address vault, address vaultAsset);
    error InsufficientIdle(uint256 idle, uint256 wanted);
    error NoSharesMinted(address vault);
    error TooFewShares(address vault, uint256 minted, uint256 minShares);
    error NothingToExit(address vault);
    error NotAllocated(address vault);
    error StillCompliant(address vault, uint256 attestationId, Verdict verdict);
    error InsufficientGas(uint256 needed);
    error TokenCallFailed();
    error Reentrancy();

    /// @notice Gas kept on top of a stipend: the call itself and exit's bookkeeping and event after it. Sized for
    ///         Monad, where a cold account costs 10,100 and a cold storage page 8,100 (docs/adr/0007).
    uint256 public constant EXIT_GAS_RESERVE = 100_000;
    /// @notice Most an exit's stipends may add up to (two calls and two reads), so a fallback exit stays below the
    ///         per-transaction gas cap of 2^24 with room for the rest.
    uint256 public constant MAX_EXIT_STIPENDS = 15_000_000;

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    CheckAttestationRegistry public immutable registry;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint64 public immutable subjectChainId;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    bytes32 public immutable standardId;
    /// @notice The suite the gate accepts (Suite hash of the registry); zero accepts any suite.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    bytes32 public immutable suiteHash;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable asset;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;
    /// @notice Seconds after its issuedAt during which a compliant attestation lets the owner allocate.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint64 public immutable maxAttestationAge;
    /// @notice Gas each redeem or withdraw call of exit gets, exactly.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable vaultCallGas;
    /// @notice Gas each maxWithdraw or balanceOf call of exit gets, exactly.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint256 public immutable vaultViewGas;

    mapping(address => Position) private _positions;
    address[] private _vaults;
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

    constructor(
        address registry_,
        uint64 subjectChainId_,
        bytes32 standardId_,
        bytes32 suiteHash_,
        address asset_,
        address owner_,
        uint64 maxAttestationAge_,
        uint256 vaultCallGas_,
        uint256 vaultViewGas_
    ) {
        if (registry_ == address(0) || asset_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (registry_.code.length == 0) revert WithoutCode(registry_);
        if (asset_.code.length == 0) revert WithoutCode(asset_);
        if (subjectChainId_ != block.chainid) revert WrongSubjectChain(subjectChainId_, block.chainid);
        if (standardId_ == bytes32(0)) revert EmptyStandardId();
        if (maxAttestationAge_ == 0) revert ZeroMaxAge();
        if (vaultCallGas_ == 0 || vaultViewGas_ == 0 || 2 * (vaultCallGas_ + vaultViewGas_) > MAX_EXIT_STIPENDS) {
            revert BadStipend(vaultCallGas_, vaultViewGas_);
        }
        registry = CheckAttestationRegistry(registry_);
        subjectChainId = subjectChainId_;
        standardId = standardId_;
        suiteHash = suiteHash_;
        asset = asset_;
        owner = owner_;
        maxAttestationAge = maxAttestationAge_;
        vaultCallGas = vaultCallGas_;
        vaultViewGas = vaultViewGas_;
    }

    /// @notice Deposit `assets` of the gate's idle asset into `vault` and get at least `minShares` (the vault's
    ///         balanceOf(gate) must rise by that much: a floor against a share price moved before the deposit, such
    ///         as a donation into an empty vault). Owner only; the vault must be Compliant (see verdictOf) and hold
    ///         the gate's asset.
    function allocate(address vault, uint256 assets, uint256 minShares)
        external
        onlyOwner
        nonReentrant
        returns (uint256 shares)
    {
        if (assets == 0) revert ZeroAmount();
        uint256 attestationId = _requireCompliant(vault);
        address vaultAsset = IGateVault(vault).asset();
        if (vaultAsset != asset) revert AssetMismatch(vault, vaultAsset);
        uint256 idleBefore = idle();
        if (assets > idleBefore) revert InsufficientIdle(idleBefore, assets);

        Position storage p = _positions[vault];
        if (p.lastAllocatedBlock == 0) _vaults.push(vault);
        p.lastAllocatedBlock = uint64(block.number);

        uint256 heldBefore = IGateVault(vault).balanceOf(address(this));
        _tokenCall(abi.encodeCall(IGateAsset.approve, (vault, assets)));
        IGateVault(vault).deposit(assets, address(this));
        _tokenCall(abi.encodeCall(IGateAsset.approve, (vault, 0)));
        uint256 heldAfter = IGateVault(vault).balanceOf(address(this));
        if (heldAfter <= heldBefore) revert NoSharesMinted(vault);
        shares = heldAfter - heldBefore;
        if (shares < minShares) revert TooFewShares(vault, shares, minShares);
        uint256 spent = idleBefore - idle();
        p.shares += shares;
        p.assetsIn += spent;
        emit Allocated(vault, attestationId, spent, shares);
    }

    /// @notice Pull every share the gate holds in `vault` back into the gate. Anyone may call it once the vault's
    ///         verdict is neither Compliant nor Stale; the owner may call it on any verdict. It tries redeem(shares)
    ///         and, when that moved nothing, withdraw(maxWithdraw); when neither moved anything it emits ExitFailed,
    ///         keeps the position and returns false instead of reverting.
    function exit(address vault) external nonReentrant returns (bool exited) {
        Position storage p = _positions[vault];
        uint256 shares = p.shares;
        if (shares == 0) revert NothingToExit(vault);
        (Verdict verdict, uint256 attestationId) = verdictOf(vault);
        if (msg.sender != owner && !_exitOpen(verdict)) revert StillCompliant(vault, attestationId, verdict);

        p.shares = 0;
        p.lastExitBlock = uint64(block.number);
        uint256 idleBefore = idle();

        ExitPath path = ExitPath.Redeem;
        bytes32 withdrawError;
        bytes32 redeemError =
            _callVault(vault, abi.encodeCall(IGateVault.redeem, (shares, address(this), address(this))));
        if (idle() == idleBefore) {
            // redeem brought nothing back, whatever it answered
            path = ExitPath.Withdraw;
            (bool read, bytes32 max) = _readVault(vault, abi.encodeCall(IGateVault.maxWithdraw, (address(this))));
            if (!read) withdrawError = max;
            if (read && uint256(max) != 0) {
                withdrawError = _callVault(
                    vault, abi.encodeCall(IGateVault.withdraw, (uint256(max), address(this), address(this)))
                );
            }
        }

        uint256 received = idle() - idleBefore;
        if (received == 0) {
            p.shares = shares;
            emit ExitFailed(
                vault,
                attestationId,
                msg.sender,
                verdict,
                shares,
                // The selectors are the first 4 bytes of each 32-byte word on purpose.
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes4(redeemError),
                // forge-lint: disable-next-line(unsafe-typecast)
                bytes4(withdrawError)
            );
            return false;
        }
        uint256 held = _heldAfterPayout(vault, shares);
        p.shares = held;
        p.assetsOut += received;
        emit Exited(vault, attestationId, msg.sender, verdict, path, shares - held, received);
        return true;
    }

    /// @notice Owner only: set the books of `vault` to the vault's balanceOf(gate) now, for a vault whose exit
    ///         misreported what it took (see exit). Reverts when the vault does not answer.
    function resync(address vault) external onlyOwner nonReentrant returns (uint256 shares) {
        Position storage p = _positions[vault];
        if (p.lastAllocatedBlock == 0) revert NotAllocated(vault);
        shares = IGateVault(vault).balanceOf(address(this));
        emit Resynced(vault, p.shares, shares);
        p.shares = shares;
    }

    /// @notice Send `amount` of the gate's idle asset to `to`. Owner only. Shares held in vaults are not idle.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = idle();
        if (amount > available) revert InsufficientIdle(available, amount);
        emit IdleWithdrawn(to, amount);
        _tokenCall(abi.encodeCall(IGateAsset.transfer, (to, amount)));
    }

    /// @notice What the registry says about `vault` for this gate, and the id of its latest attestation (0 when
    ///         there is none). See the contract's dev notes for the rules.
    function verdictOf(address vault) public view returns (Verdict, uint256 attestationId) {
        CheckAttestationRegistry.Attestation memory a;
        try registry.latest(subjectChainId, vault, standardId) returns (
            uint256 id, CheckAttestationRegistry.Attestation memory latest_
        ) {
            (attestationId, a) = (id, latest_);
        } catch (bytes memory reason) {
            // Only the registry's own NoAttestation means "none". Anything else, an out-of-gas caller included,
            // is passed on: a starved read must never make a compliant vault look unattested to exit.
            // forge-lint: disable-next-line(unsafe-typecast)
            if (bytes4(reason) != CheckAttestationRegistry.NoAttestation.selector) _bubble(reason);
            return (Verdict.NoAttestation, 0);
        }
        if (!registry.isCompliant(subjectChainId, vault, standardId)) return (Verdict.NotCompliant, attestationId);
        if (suiteHash != bytes32(0) && a.suiteHash != suiteHash) return (Verdict.OtherSuite, attestationId);
        if (!registry.isIssuer(a.issuer)) return (Verdict.UntrustedIssuer, attestationId);
        if (a.subjectCodeHash != vault.codehash) return (Verdict.CodeMismatch, attestationId);
        if (a.blockNumber > block.number) return (Verdict.FutureBlock, attestationId);
        if (block.timestamp > uint256(a.issuedAt) + maxAttestationAge) return (Verdict.Stale, attestationId);
        return (Verdict.Compliant, attestationId);
    }

    /// @notice True when anyone's exit(vault) would try to pull shares out: the gate holds some, and the verdict
    ///         allows it. The owner's exit needs only the shares.
    function canExit(address vault) external view returns (bool) {
        if (_positions[vault].shares == 0) return false;
        (Verdict v,) = verdictOf(vault);
        return _exitOpen(v);
    }

    /// @notice The gate's asset balance: what the owner can allocate or withdraw.
    function idle() public view returns (uint256) {
        return IGateAsset(asset).balanceOf(address(this));
    }

    function positionOf(address vault) external view returns (Position memory) {
        return _positions[vault];
    }

    /// @notice Every vault the gate ever allocated to, in order of the first allocation.
    function vaults() external view returns (address[] memory) {
        return _vaults;
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function _exitOpen(Verdict v) private pure returns (bool) {
        return v != Verdict.Compliant && v != Verdict.Stale;
    }

    function _requireCompliant(address vault) private view returns (uint256 attestationId) {
        Verdict v;
        (v, attestationId) = verdictOf(vault);
        if (v == Verdict.Compliant) return attestationId;
        if (v == Verdict.NoAttestation) revert NoAttestation(vault);
        if (v == Verdict.NotCompliant) revert NotCompliant(vault, attestationId);
        if (v == Verdict.OtherSuite) revert OtherSuite(vault, attestationId);
        if (v == Verdict.UntrustedIssuer) revert UntrustedIssuer(vault, attestationId);
        if (v == Verdict.CodeMismatch) revert CodeMismatch(vault, attestationId);
        if (v == Verdict.FutureBlock) revert FutureBlock(vault, attestationId);
        revert StaleAttestation(vault, attestationId);
    }

    /// @dev The books after assets arrived: the vault's balanceOf(gate), never above `books`; 0 when it does not answer
    ///      (it is taken to have taken back what was asked; the owner's resync corrects that once it answers).
    function _heldAfterPayout(address vault, uint256 books) private returns (uint256) {
        (bool answered, bytes32 balance) = _readVault(vault, abi.encodeCall(IGateVault.balanceOf, (address(this))));
        if (!answered) return 0;
        return uint256(balance) < books ? uint256(balance) : books;
    }

    /// @dev A view call to `vault` with vaultViewGas: success and the first word it returned (less than a word counts
    ///      as no answer).
    function _readVault(address vault, bytes memory data) private returns (bool ok, bytes32 word) {
        uint256 size;
        (ok, word, size) = _call(vault, data, vaultViewGas, true);
        ok = ok && size >= 0x20;
    }

    /// @dev A state-changing call to `vault` with vaultCallGas: the first word of its revert, zero when it did not
    ///      revert.
    function _callVault(address vault, bytes memory data) private returns (bytes32 revertWord) {
        (bool ok, bytes32 word,) = _call(vault, data, vaultCallGas, false);
        return ok ? bytes32(0) : word;
    }

    /// @dev Calls `vault` with exactly `stipend` gas, or reverts with InsufficientGas when less than that (through the
    ///      63/64 rule) and EXIT_GAS_RESERVE is left. Copies at most the first 32 bytes it returns.
    function _call(address vault, bytes memory data, uint256 stipend, bool readOnly)
        private
        returns (bool ok, bytes32 word, uint256 size)
    {
        uint256 needed = stipend * 64 / 63 + EXIT_GAS_RESERVE;
        if (gasleft() < needed) revert InsufficientGas(needed);
        assembly ("memory-safe") {
            switch readOnly
            case 0 { ok := call(stipend, vault, 0, add(data, 0x20), mload(data), 0, 0) }
            default { ok := staticcall(stipend, vault, add(data, 0x20), mload(data), 0, 0) }
            size := returndatasize()
            let n := size
            if gt(n, 0x20) { n := 0x20 }
            mstore(0, 0)
            returndatacopy(0, 0, n)
            word := mload(0)
        }
    }

    /// @dev The asset is trusted; a token that returns nothing counts as success, one that returns false does not.
    function _tokenCall(bytes memory data) private {
        (bool ok, bytes memory ret) = asset.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TokenCallFailed();
    }

    function _bubble(bytes memory reason) private pure {
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
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
