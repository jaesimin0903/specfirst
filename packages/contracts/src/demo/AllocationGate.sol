// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CheckAttestationRegistry} from "../CheckAttestationRegistry.sol";

/// @dev The ERC-4626 calls the gate makes. A vault is untrusted: any call to it may revert, lie, burn gas or re-enter.
interface IGateVault {
    function asset() external view returns (address);
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
///         `asset` into an ERC-4626 vault only while the registry's latest attestation of that vault is compliant,
///         fresh, from a current issuer and about the code at the vault's address. Once that attestation is no longer
///         good (Revoked, a failed, inconclusive or not-applicable result, its issuer removed, or a code hash that is
///         not the vault's), anyone can pull the gate's shares back out of the vault with `exit`: a keeper needs no key.
/// @dev The rules, in the order verdictOf applies them to the latest attestation of
///      (subjectChainId, vault, standardId):
///      1. none: NoAttestation;
///      2. registry.isCompliant false (Revoked, or not all results passed): NotCompliant;
///      3. its issuer is no longer registry.isIssuer: UntrustedIssuer;
///      4. its subjectCodeHash is not vault.codehash: CodeMismatch;
///      5. issued more than maxAttestationAge seconds ago: Stale;
///      6. otherwise Compliant.
///      allocate needs Compliant. exit needs any verdict but Compliant and Stale: an old attestation that is still
///      good is no reason to pull money out, since the watcher records unchanged re-checks without a transaction.
///      The vaults live on this chain, so subjectChainId must be block.chainid, and the gate can compare the attested
///      code hash with the vault's own. What it cannot check is the issuer's honesty (docs/adr/0005): a gate that
///      trusts the registry's issuers trusts each of them.
///      Vault calls are external and untrusted. allocate, exit and withdraw share a reentrancy lock (a storage flag,
///      as in CheckRequestDesk). exit clears the position before it calls the vault, copies at most 32 bytes of
///      what the vault returns, and a vault that refuses (reverts, with any amount of data) ends in ExitFailed, not
///      in a revert of the whole call. A vault call that fails after using up its gas cannot be told from a caller
///      that sent too little gas, so that one reverts the whole exit (VaultOutOfGas): a keeper's gas estimate then
///      finds the gas an honest exit needs instead of settling on a cheap ExitFailed. Assets received are measured
///      on the asset's balance, never taken from the vault's return value. The asset is trusted (set at deployment).
///      The owner is immutable (no transfer, no renounce), like the registry's.
contract AllocationGate {
    enum Verdict {
        Compliant,
        Stale,
        NoAttestation,
        NotCompliant,
        UntrustedIssuer,
        CodeMismatch
    }

    enum ExitPath {
        Redeem,
        Withdraw
    }

    struct Position {
        uint256 shares; // vault shares the gate holds by its own count
        uint256 assetsIn; // assets the vault took, summed over every allocation
        uint256 assetsOut; // assets exits brought back, summed
        uint64 lastAllocatedBlock; // 0: never allocated
        uint64 lastExitBlock; // block of the last exit attempt, failed ones included; 0: none
    }

    event Allocated(address indexed vault, uint256 indexed attestationId, uint256 assets, uint256 shares);
    /// @dev `shares` is what the vault burned by its own word (all of them for Redeem); `assets` is measured.
    event Exited(
        address indexed vault,
        uint256 indexed attestationId,
        address caller,
        Verdict verdict,
        ExitPath path,
        uint256 shares,
        uint256 assets
    );
    /// @dev The first 4 bytes of each revert; withdrawError is zero when withdraw was not tried (maxWithdraw gave 0).
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

    error NotOwner();
    error ZeroAddress();
    error ZeroAmount();
    error ZeroMaxAge();
    error EmptyStandardId();
    error WithoutCode(address account);
    error WrongSubjectChain(uint64 subjectChainId, uint256 chainId);
    error NoAttestation(address vault);
    error NotCompliant(address vault, uint256 attestationId);
    error UntrustedIssuer(address vault, uint256 attestationId);
    error CodeMismatch(address vault, uint256 attestationId);
    error StaleAttestation(address vault, uint256 attestationId);
    error AssetMismatch(address vault, address vaultAsset);
    error InsufficientIdle(uint256 idle, uint256 wanted);
    error NoSharesMinted(address vault);
    error NothingToExit(address vault);
    error StillCompliant(address vault, uint256 attestationId, Verdict verdict);
    error VaultOutOfGas(address vault);
    error TokenCallFailed();
    error Reentrancy();

    /// @notice Gas exit keeps back from every vault call: what its bookkeeping and event need after the call.
    uint256 public constant EXIT_GAS_RESERVE = 60_000;

    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    CheckAttestationRegistry public immutable registry;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint64 public immutable subjectChainId;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    bytes32 public immutable standardId;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable asset;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable owner;
    /// @notice Seconds after its issuedAt during which a compliant attestation lets the owner allocate.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint64 public immutable maxAttestationAge;

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
        address asset_,
        address owner_,
        uint64 maxAttestationAge_
    ) {
        if (registry_ == address(0) || asset_ == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        if (registry_.code.length == 0) revert WithoutCode(registry_);
        if (asset_.code.length == 0) revert WithoutCode(asset_);
        if (subjectChainId_ != block.chainid) revert WrongSubjectChain(subjectChainId_, block.chainid);
        if (standardId_ == bytes32(0)) revert EmptyStandardId();
        if (maxAttestationAge_ == 0) revert ZeroMaxAge();
        registry = CheckAttestationRegistry(registry_);
        subjectChainId = subjectChainId_;
        standardId = standardId_;
        asset = asset_;
        owner = owner_;
        maxAttestationAge = maxAttestationAge_;
    }

    /// @notice Deposit `assets` of the gate's idle asset into `vault`. Owner only; the vault must be Compliant
    ///         (see verdictOf) and hold the gate's asset.
    function allocate(address vault, uint256 assets) external onlyOwner nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        uint256 attestationId = _requireCompliant(vault);
        address vaultAsset = IGateVault(vault).asset();
        if (vaultAsset != asset) revert AssetMismatch(vault, vaultAsset);
        uint256 idleBefore = idle();
        if (assets > idleBefore) revert InsufficientIdle(idleBefore, assets);

        Position storage p = _positions[vault];
        if (p.lastAllocatedBlock == 0) _vaults.push(vault);
        p.lastAllocatedBlock = uint64(block.number);

        _tokenCall(abi.encodeCall(IGateAsset.approve, (vault, assets)));
        shares = IGateVault(vault).deposit(assets, address(this));
        _tokenCall(abi.encodeCall(IGateAsset.approve, (vault, 0)));
        if (shares == 0) revert NoSharesMinted(vault);
        uint256 spent = idleBefore - idle();
        p.shares += shares;
        p.assetsIn += spent;
        emit Allocated(vault, attestationId, spent, shares);
    }

    /// @notice Pull every share the gate holds in `vault` back into the gate. Anyone may call it, once the vault's
    ///         verdict is neither Compliant nor Stale. It tries redeem(shares), then withdraw(maxWithdraw); when the
    ///         vault refuses both, it emits ExitFailed, keeps the position and returns false instead of reverting.
    function exit(address vault) external nonReentrant returns (bool exited) {
        Position storage p = _positions[vault];
        uint256 shares = p.shares;
        if (shares == 0) revert NothingToExit(vault);
        (Verdict verdict, uint256 attestationId) = verdictOf(vault);
        if (verdict == Verdict.Compliant || verdict == Verdict.Stale) {
            revert StillCompliant(vault, attestationId, verdict);
        }

        p.shares = 0;
        p.lastExitBlock = uint64(block.number);
        uint256 idleBefore = idle();

        (bool ok, bytes32 redeemOut) =
            _callVault(vault, abi.encodeCall(IGateVault.redeem, (shares, address(this), address(this))), false);
        if (ok) {
            _exited(p, vault, attestationId, verdict, ExitPath.Redeem, shares, idleBefore);
            return true;
        }

        (bool read, bytes32 max) = _callVault(vault, abi.encodeCall(IGateVault.maxWithdraw, (address(this))), true);
        bytes32 withdrawOut = read ? bytes32(0) : max;
        if (read && uint256(max) != 0) {
            (ok, withdrawOut) = _callVault(
                vault, abi.encodeCall(IGateVault.withdraw, (uint256(max), address(this), address(this))), false
            );
            if (ok) {
                uint256 burned = uint256(withdrawOut) < shares ? uint256(withdrawOut) : shares;
                p.shares = shares - burned;
                _exited(p, vault, attestationId, verdict, ExitPath.Withdraw, burned, idleBefore);
                return true;
            }
        }

        p.shares = shares;
        // The selectors are the first 4 bytes of each 32-byte word on purpose.
        // forge-lint: disable-next-line(unsafe-typecast)
        emit ExitFailed(vault, attestationId, msg.sender, verdict, shares, bytes4(redeemOut), bytes4(withdrawOut));
        return false;
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
        if (!registry.isIssuer(a.issuer)) return (Verdict.UntrustedIssuer, attestationId);
        if (a.subjectCodeHash != vault.codehash) return (Verdict.CodeMismatch, attestationId);
        if (block.timestamp > uint256(a.issuedAt) + maxAttestationAge) return (Verdict.Stale, attestationId);
        return (Verdict.Compliant, attestationId);
    }

    /// @notice True when exit(vault) would try to pull shares out: the gate holds some, and the verdict allows it.
    function canExit(address vault) external view returns (bool) {
        if (_positions[vault].shares == 0) return false;
        (Verdict v,) = verdictOf(vault);
        return v != Verdict.Compliant && v != Verdict.Stale;
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

    function _requireCompliant(address vault) private view returns (uint256 attestationId) {
        Verdict v;
        (v, attestationId) = verdictOf(vault);
        if (v == Verdict.Compliant) return attestationId;
        if (v == Verdict.NoAttestation) revert NoAttestation(vault);
        if (v == Verdict.NotCompliant) revert NotCompliant(vault, attestationId);
        if (v == Verdict.UntrustedIssuer) revert UntrustedIssuer(vault, attestationId);
        if (v == Verdict.CodeMismatch) revert CodeMismatch(vault, attestationId);
        revert StaleAttestation(vault, attestationId);
    }

    function _exited(
        Position storage p,
        address vault,
        uint256 attestationId,
        Verdict verdict,
        ExitPath path,
        uint256 shares,
        uint256 idleBefore
    ) private {
        uint256 received = idle() - idleBefore;
        p.assetsOut += received;
        emit Exited(vault, attestationId, msg.sender, verdict, path, shares, received);
    }

    /// @dev Calls `vault` with all but EXIT_GAS_RESERVE of the gas left and copies at most the first 32 bytes it
    ///      returns (the first return value, or a revert's selector and more). A failed call that left no more than
    ///      the reserve and a 63rd of the gas there was ran out of gas: VaultOutOfGas.
    function _callVault(address vault, bytes memory data, bool readOnly) private returns (bool ok, bytes32 word) {
        uint256 before = gasleft();
        uint256 g = before > EXIT_GAS_RESERVE ? before - EXIT_GAS_RESERVE : 0;
        assembly ("memory-safe") {
            switch readOnly
            case 0 { ok := call(g, vault, 0, add(data, 0x20), mload(data), 0, 0) }
            default { ok := staticcall(g, vault, add(data, 0x20), mload(data), 0, 0) }
            let n := returndatasize()
            if gt(n, 0x20) { n := 0x20 }
            mstore(0, 0)
            returndatacopy(0, 0, n)
            word := mload(0)
        }
        if (!ok && gasleft() <= before / 63 + EXIT_GAS_RESERVE) revert VaultOutOfGas(vault);
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
