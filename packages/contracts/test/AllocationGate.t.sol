// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckAttestationRegistry} from "../src/CheckAttestationRegistry.sol";
import {AllocationGate} from "../src/demo/AllocationGate.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {DemoVault, DemoVaultFactory} from "../src/demo/DemoVaultFactory.sol";

/// @notice An ERC-4626-shaped vault (one share per asset) whose calls misbehave on demand, to show what the gate
///         does with a vault that reverts, re-enters, burns gas, returns a huge error or pays out only part.
contract HostileVault {
    enum Mode {
        Honest,
        RevertRedeem, // redeem reverts, withdraw works
        HalfWithdraw, // redeem reverts, maxWithdraw says half the balance
        RevertAll, // redeem and withdraw revert
        ReenterExit, // redeem and withdraw call gate.exit again
        ReenterOnDeposit, // deposit calls gate.exit of another vault
        BurnGas, // redeem and maxWithdraw spin until out of gas
        HugeRevert, // redeem and withdraw revert with 600 KB of zeros
        NoOp, // redeem and withdraw answer as if they paid, and move nothing (a fallback that accepts any call)
        SilentBalance // pays out like Honest, but balanceOf reverts
    }

    error Nope();

    DemoToken internal immutable _token;
    AllocationGate public gate;
    address public other;
    Mode public mode;
    uint256 public totalSupply;
    mapping(address => uint256) internal _shares;

    constructor(DemoToken token_) {
        _token = token_;
    }

    function arm(Mode m, AllocationGate g, address other_) external {
        mode = m;
        gate = g;
        other = other_;
    }

    function balanceOf(address account) external view returns (uint256) {
        if (mode == Mode.SilentBalance) revert Nope();
        return _shares[account];
    }

    function asset() external view returns (address) {
        return address(_token);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256) {
        if (mode == Mode.ReenterOnDeposit) gate.exit(other);
        _token.transferFrom(msg.sender, address(this), assets);
        _shares[receiver] += assets;
        totalSupply += assets;
        return assets;
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        if (mode == Mode.NoOp) return shares;
        if (mode != Mode.Honest && mode != Mode.SilentBalance) _misbehave();
        return _out(shares, receiver, owner);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256) {
        if (mode == Mode.NoOp) return assets;
        if (mode != Mode.Honest && mode != Mode.RevertRedeem && mode != Mode.HalfWithdraw) _misbehave();
        return _out(assets, receiver, owner);
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        if (mode == Mode.BurnGas) _spin();
        return mode == Mode.HalfWithdraw ? _shares[owner] / 2 : _shares[owner];
    }

    function _out(uint256 amount, address receiver, address owner) internal returns (uint256) {
        _shares[owner] -= amount;
        totalSupply -= amount;
        _token.transfer(receiver, amount);
        return amount;
    }

    function _misbehave() internal {
        if (mode == Mode.ReenterExit) gate.exit(address(this));
        if (mode == Mode.BurnGas) _spin();
        if (mode == Mode.HugeRevert) {
            assembly {
                revert(0, 600000)
            }
        }
        revert Nope();
    }

    function _spin() internal pure {
        uint256 i;
        while (true) {
            ++i;
        }
    }
}

/// @notice An ERC-20 that answers transfer and approve with false, or with nothing at all (as USDT does).
contract OddToken {
    bool public returnsNothing;
    mapping(address => uint256) public balanceOf;

    constructor(bool returnsNothing_) {
        returnsNothing = returnsNothing_;
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address, uint256) external view returns (bool) {
        _answer(true);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        if (!returnsNothing) return false;
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        _answer(true);
        return true;
    }

    function _answer(bool) internal view {
        if (returnsNothing) {
            assembly {
                return(0, 0)
            }
        }
    }
}

/// Holds a NestedVault's assets and pays out on the vault's order: vault -> strategy -> pool -> token.
contract Pool {
    DemoToken internal immutable _token;
    uint256[64] internal _work;

    constructor(DemoToken token_) {
        _token = token_;
    }

    function release(address to, uint256 amount, uint256 rounds) external {
        for (uint256 i; i < rounds; ++i) {
            _work[i] = amount + i + 1; // a market's bookkeeping (cold SSTOREs)
        }
        require(_token.transfer(to, amount), "release");
    }
}

contract Strategy {
    Pool public immutable pool;

    constructor(DemoToken token_) {
        pool = new Pool(token_);
    }

    function pay(address to, uint256 amount, uint256 rounds) external {
        pool.release(to, amount, rounds);
    }
}

/// @notice The review's probe: an honest 1:1 vault whose assets sit two calls deeper than DemoVault's, with
///         switches for a redeem that spins, a paused redeem whose withdraw claims to burn twice what it did, and
///         a maxWithdraw that reverts.
contract NestedVault {
    DemoToken internal immutable _token;
    Strategy public immutable strategy;
    uint256 public immutable rounds;
    mapping(address => uint256) public balanceOf;
    bool public redeemSpins;
    bool public withdrawLies;
    bool public noMaxWithdraw;

    constructor(DemoToken token_, uint256 rounds_) {
        _token = token_;
        strategy = new Strategy(token_);
        rounds = rounds_;
    }

    function set(bool spins, bool lies, bool noMax) external {
        (redeemSpins, withdrawLies, noMaxWithdraw) = (spins, lies, noMax);
    }

    function asset() external view returns (address) {
        return address(_token);
    }

    function deposit(uint256 a, address r) external returns (uint256) {
        _token.transferFrom(msg.sender, address(strategy.pool()), a);
        balanceOf[r] += a;
        return a;
    }

    function redeem(uint256 sh, address r, address o) external returns (uint256) {
        if (redeemSpins) {
            while (true) {}
        }
        if (withdrawLies) revert("redeem paused");
        balanceOf[o] -= sh;
        strategy.pay(r, sh, rounds);
        return sh;
    }

    function maxWithdraw(address o) external view returns (uint256) {
        if (noMaxWithdraw) revert(); // a redeem-only vault, or maxWithdraw paused: a cheap refusal
        return withdrawLies ? balanceOf[o] / 2 : balanceOf[o];
    }

    function withdraw(uint256 a, address r, address o) external returns (uint256) {
        balanceOf[o] -= a;
        strategy.pay(r, a, rounds);
        return withdrawLies ? a * 2 : a; // claims it burned twice what it did
    }
}

contract AllocationGateTest is Test {
    event Allocated(address indexed vault, uint256 indexed attestationId, uint256 assets, uint256 shares);
    event Exited(
        address indexed vault,
        uint256 indexed attestationId,
        address caller,
        AllocationGate.Verdict verdict,
        AllocationGate.ExitPath path,
        uint256 shares,
        uint256 assets
    );
    event ExitFailed(
        address indexed vault,
        uint256 indexed attestationId,
        address caller,
        AllocationGate.Verdict verdict,
        uint256 shares,
        bytes4 redeemError,
        bytes4 withdrawError
    );
    event IdleWithdrawn(address indexed to, uint256 amount);

    bytes32 internal constant ERC4626 = 0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab;
    uint64 internal constant MAX_AGE = 1 days;
    uint256 internal constant FUND = 1000e18;

    CheckAttestationRegistry internal reg;
    DemoToken internal token;
    DemoVaultFactory internal factory;
    DemoVault internal vault;
    AllocationGate internal gate;
    uint64 internal chain;

    address internal owner = makeAddr("owner");
    address internal issuer = makeAddr("issuer");
    address internal operator = makeAddr("operator");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(1000);
        chain = uint64(block.chainid);
        reg = new CheckAttestationRegistry();
        reg.setIssuer(issuer, true);
        token = new DemoToken();
        factory = new DemoVaultFactory();
        vault = _demoVault();
        gate = new AllocationGate(address(reg), chain, ERC4626, bytes32(0), address(token), owner, MAX_AGE);
        token.mint(address(gate), FUND);
    }

    // ---------------------------------------------------------------- helpers

    function _demoVault() internal returns (DemoVault v) {
        vm.prank(operator);
        v = DemoVault(factory.deploy(address(token), false));
    }

    /// Params for `subject` on this chain at a new block: `pass` passes, then `fail` fails, `inc` inconclusive,
    /// `na` not applicable. The code hash is the subject's own unless `codeHash` is given.
    function _params(address subject, uint16 pass, uint16 fail, uint16 inc, uint16 na, bytes32 codeHash)
        internal
        returns (CheckAttestationRegistry.AttestParams memory p)
    {
        vm.roll(block.number + 1);
        uint256 passed = (uint256(1) << pass) - 1;
        uint256 failed = fail == 0 ? 0 : ((uint256(1) << fail) - 1) << pass;
        p = CheckAttestationRegistry.AttestParams({
            subjectChainId: chain,
            subject: subject,
            standardId: ERC4626,
            blockNumber: uint64(block.number),
            implementationKey: keccak256("impl"),
            subjectCodeHash: codeHash == bytes32(0) ? subject.codehash : codeHash,
            suiteHash: keccak256("suite"),
            reportHash: keccak256(abi.encode(subject, block.number)),
            passCount: pass,
            failCount: fail,
            inconclusiveCount: inc,
            notApplicableCount: na,
            passedBitmap: passed,
            failedBitmap: failed,
            reportURI: "certs/checks/31337/demo.json"
        });
    }

    function _attest(address subject, uint16 pass, uint16 fail, uint16 inc, uint16 na, bytes32 codeHash)
        internal
        returns (uint256)
    {
        CheckAttestationRegistry.AttestParams memory p = _params(subject, pass, fail, inc, na, codeHash);
        vm.prank(issuer);
        return reg.attest(p);
    }

    function _pass(address subject) internal returns (uint256) {
        return _attest(subject, 30, 0, 0, 0, bytes32(0));
    }

    /// The watcher's report once the DemoVault bug is on: previewDeposit fails.
    function _fail(address subject) internal returns (uint256) {
        return _attest(subject, 29, 1, 0, 0, bytes32(0));
    }

    function _allocate(address v, uint256 assets) internal returns (uint256) {
        vm.prank(owner);
        return gate.allocate(v, assets, 0);
    }

    function _verdict(address v) internal view returns (AllocationGate.Verdict verdict, uint256 id) {
        return gate.verdictOf(v);
    }

    function _hostile(HostileVault.Mode m) internal returns (HostileVault h) {
        h = new HostileVault(token);
        _pass(address(h));
        _allocate(address(h), 100e18);
        h.arm(m, gate, address(0));
        _fail(address(h));
    }

    // ---------------------------------------------------------------- constructor

    function test_constructor_setsEverything() public view {
        assertEq(address(gate.registry()), address(reg));
        assertEq(gate.subjectChainId(), chain);
        assertEq(gate.standardId(), ERC4626);
        assertEq(gate.asset(), address(token));
        assertEq(gate.owner(), owner);
        assertEq(gate.maxAttestationAge(), MAX_AGE);
        assertEq(gate.idle(), FUND);
        assertEq(gate.vaultCount(), 0);
        assertEq(gate.suiteHash(), bytes32(0));
        assertEq(gate.VAULT_CALL_GAS(), 1_500_000);
        assertEq(gate.VAULT_VIEW_GAS(), 100_000);
        assertEq(gate.EXIT_GAS_RESERVE(), 60_000);
    }

    function test_constructor_refusesBadParams() public {
        vm.expectRevert(AllocationGate.ZeroAddress.selector);
        new AllocationGate(address(0), chain, ERC4626, bytes32(0), address(token), owner, MAX_AGE);
        vm.expectRevert(AllocationGate.ZeroAddress.selector);
        new AllocationGate(address(reg), chain, ERC4626, bytes32(0), address(0), owner, MAX_AGE);
        vm.expectRevert(AllocationGate.ZeroAddress.selector);
        new AllocationGate(address(reg), chain, ERC4626, bytes32(0), address(token), address(0), MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.WithoutCode.selector, keeper));
        new AllocationGate(keeper, chain, ERC4626, bytes32(0), address(token), owner, MAX_AGE);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.WithoutCode.selector, keeper));
        new AllocationGate(address(reg), chain, ERC4626, bytes32(0), keeper, owner, MAX_AGE);
        // The vaults live on this chain: an attestation about the same address on another chain is not about them.
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.WrongSubjectChain.selector, uint64(143), block.chainid));
        new AllocationGate(address(reg), 143, ERC4626, bytes32(0), address(token), owner, MAX_AGE);
        vm.expectRevert(AllocationGate.EmptyStandardId.selector);
        new AllocationGate(address(reg), chain, bytes32(0), bytes32(0), address(token), owner, MAX_AGE);
        vm.expectRevert(AllocationGate.ZeroMaxAge.selector);
        new AllocationGate(address(reg), chain, ERC4626, bytes32(0), address(token), owner, 0);
    }

    // ---------------------------------------------------------------- allocate

    function test_allocate_compliantVault_depositsAndTracks() public {
        uint256 id = _pass(address(vault));
        vm.roll(block.number + 5);
        vm.expectEmit(true, true, false, true, address(gate));
        emit Allocated(address(vault), id, 100e18, 100e18);
        assertEq(_allocate(address(vault), 100e18), 100e18);

        AllocationGate.Position memory p = gate.positionOf(address(vault));
        assertEq(p.shares, 100e18);
        assertEq(p.assetsIn, 100e18);
        assertEq(p.assetsOut, 0);
        assertEq(p.lastAllocatedBlock, block.number);
        assertEq(p.lastExitBlock, 0);
        assertEq(vault.balanceOf(address(gate)), 100e18);
        assertEq(gate.idle(), FUND - 100e18);
        assertEq(token.allowance(address(gate), address(vault)), 0, "approval reset");
        assertEq(gate.vaults().length, 1);
        assertEq(gate.vaults()[0], address(vault));
        assertFalse(gate.canExit(address(vault)));
    }

    function test_allocate_twice_accumulates_listsVaultOnce() public {
        _pass(address(vault));
        _allocate(address(vault), 100e18);
        token.mint(address(vault), 100e18); // yield: a share is now worth 2 assets
        assertEq(_allocate(address(vault), 50e18), 25e18);
        AllocationGate.Position memory p = gate.positionOf(address(vault));
        assertEq(p.shares, 125e18);
        assertEq(p.assetsIn, 150e18);
        assertEq(gate.vaultCount(), 1);
    }

    function test_allocate_refusesWithoutAttestation() public {
        (AllocationGate.Verdict v, uint256 id) = _verdict(address(vault));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.NoAttestation));
        assertEq(id, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NoAttestation.selector, address(vault)));
        gate.allocate(address(vault), 1e18, 0);
        // An account without code has no attestation either; asset() is never called on it.
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NoAttestation.selector, keeper));
        gate.allocate(keeper, 1e18, 0);
    }

    function test_allocate_refusesFailingVault() public {
        _pass(address(vault));
        uint256 id = _fail(address(vault));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NotCompliant.selector, address(vault), id));
        gate.allocate(address(vault), 1e18, 0);
    }

    function test_allocate_refusesInconclusiveOrNotApplicable() public {
        uint256 inc = _attest(address(vault), 29, 0, 1, 0, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NotCompliant.selector, address(vault), inc));
        gate.allocate(address(vault), 1e18, 0);
        uint256 na = _attest(address(vault), 29, 0, 0, 1, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NotCompliant.selector, address(vault), na));
        gate.allocate(address(vault), 1e18, 0);
    }

    function test_allocate_refusesRevokedLatest() public {
        uint256 id = _pass(address(vault));
        vm.prank(issuer);
        reg.revoke(id, keccak256("wrong block"));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NotCompliant.selector, address(vault), id));
        gate.allocate(address(vault), 1e18, 0);
    }

    function test_allocate_refusesStaleAttestation() public {
        uint256 id = _pass(address(vault));
        vm.warp(block.timestamp + MAX_AGE);
        _allocate(address(vault), 1e18); // exactly maxAttestationAge old: still fresh
        vm.warp(block.timestamp + 1);
        (AllocationGate.Verdict v,) = _verdict(address(vault));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.Stale));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.StaleAttestation.selector, address(vault), id));
        gate.allocate(address(vault), 1e18, 0);
        // A new compliant attestation makes it fresh again.
        _pass(address(vault));
        _allocate(address(vault), 1e18);
    }

    function test_allocate_refusesRemovedIssuer() public {
        uint256 id = _pass(address(vault));
        reg.setIssuer(issuer, false);
        // The registry keeps calling it compliant (ADR 0004: removal does not touch past attestations); the gate does not.
        assertTrue(reg.isCompliant(chain, address(vault), ERC4626));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.UntrustedIssuer.selector, address(vault), id));
        gate.allocate(address(vault), 1e18, 0);
    }

    function test_allocate_refusesCodeMismatch() public {
        uint256 id = _attest(address(vault), 30, 0, 0, 0, keccak256("other code"));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.CodeMismatch.selector, address(vault), id));
        gate.allocate(address(vault), 1e18, 0);
    }

    function test_allocate_refusesAssetMismatch() public {
        DemoToken other = new DemoToken();
        vm.prank(operator);
        address v = factory.deploy(address(other), false);
        _pass(v);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.AssetMismatch.selector, v, address(other)));
        gate.allocate(v, 1e18, 0);
    }

    function test_allocate_ownerOnly_positiveAmount_withinIdle() public {
        _pass(address(vault));
        vm.prank(keeper);
        vm.expectRevert(AllocationGate.NotOwner.selector);
        gate.allocate(address(vault), 1e18, 0);
        vm.prank(owner);
        vm.expectRevert(AllocationGate.ZeroAmount.selector);
        gate.allocate(address(vault), 0, 0);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.InsufficientIdle.selector, FUND, FUND + 1));
        gate.allocate(address(vault), FUND + 1, 0);
    }

    /// A deposit worth less than one share mints nothing: the allocation is refused rather than recorded empty.
    function test_allocate_refusesADepositThatMintsNoShares() public {
        _pass(address(vault));
        token.mint(keeper, 1);
        vm.startPrank(keeper);
        token.approve(address(vault), 1);
        vault.deposit(1, keeper);
        vm.stopPrank();
        token.mint(address(vault), 10e18); // one share is now worth 10e18 + 1 assets
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NoSharesMinted.selector, address(vault)));
        gate.allocate(address(vault), 1e18, 0);
    }

    function test_tokenCalls_acceptNoReturnValue_refuseFalse() public {
        OddToken quiet = new OddToken(true);
        AllocationGate g = new AllocationGate(address(reg), chain, ERC4626, bytes32(0), address(quiet), owner, MAX_AGE);
        quiet.mint(address(g), 10);
        vm.prank(owner);
        g.withdraw(owner, 4);
        assertEq(quiet.balanceOf(owner), 4);

        OddToken liar = new OddToken(false);
        g = new AllocationGate(address(reg), chain, ERC4626, bytes32(0), address(liar), owner, MAX_AGE);
        liar.mint(address(g), 10);
        vm.prank(owner);
        vm.expectRevert(AllocationGate.TokenCallFailed.selector);
        g.withdraw(owner, 4);
    }

    function test_allocate_aVaultReenteringDuringDepositIsRefusedByTheLock() public {
        HostileVault h = new HostileVault(token);
        HostileVault target = new HostileVault(token);
        _pass(address(target));
        _allocate(address(target), 10e18);
        _fail(address(target)); // exit(target) would succeed on its own
        _pass(address(h));
        h.arm(HostileVault.Mode.ReenterOnDeposit, gate, address(target));
        vm.prank(owner);
        vm.expectRevert(AllocationGate.Reentrancy.selector);
        gate.allocate(address(h), 10e18, 0);
        assertEq(gate.positionOf(address(target)).shares, 10e18);
        assertEq(gate.positionOf(address(h)).shares, 0);
    }

    // ---------------------------------------------------------------- exit

    /// The demo: the operator switches the DemoVault bug on, the watcher attests the failing report, new money is
    /// refused and a keeper (not the owner) pulls the gate's shares out.
    function test_exit_afterTheBugIsSwitchedOnAndAttested() public {
        _pass(address(vault));
        _allocate(address(vault), 100e18);
        // Another depositor and some yield, so the exit is not just a round trip of the same number.
        token.mint(keeper, 50e18);
        vm.startPrank(keeper);
        token.approve(address(vault), 50e18);
        vault.deposit(50e18, keeper);
        vm.stopPrank();
        token.mint(address(vault), 30e18);
        uint256 expected = vault.previewRedeem(100e18);
        assertEq(expected, 120e18);

        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                AllocationGate.StillCompliant.selector, address(vault), 0, AllocationGate.Verdict.Compliant
            )
        );
        gate.exit(address(vault));

        vm.prank(operator);
        vault.setBroken(true);
        uint256 failing = _fail(address(vault));
        assertTrue(gate.canExit(address(vault)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NotCompliant.selector, address(vault), failing));
        gate.allocate(address(vault), 1e18, 0);

        vm.expectEmit(true, true, false, true, address(gate));
        emit Exited(
            address(vault),
            failing,
            keeper,
            AllocationGate.Verdict.NotCompliant,
            AllocationGate.ExitPath.Redeem,
            100e18,
            expected
        );
        vm.prank(keeper);
        assertTrue(gate.exit(address(vault)));

        AllocationGate.Position memory p = gate.positionOf(address(vault));
        assertEq(p.shares, 0);
        assertEq(p.assetsIn, 100e18);
        assertEq(p.assetsOut, expected);
        assertEq(p.lastExitBlock, block.number);
        assertEq(vault.balanceOf(address(gate)), 0);
        assertEq(gate.idle(), FUND - 100e18 + expected);
        assertFalse(gate.canExit(address(vault)));
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NothingToExit.selector, address(vault)));
        gate.exit(address(vault));

        // Fixed and re-attested, the vault takes money again.
        vm.prank(operator);
        vault.setBroken(false);
        _pass(address(vault));
        _allocate(address(vault), 10e18);
    }

    function test_exit_refusedWhileCompliantOrStale() public {
        uint256 id = _pass(address(vault));
        _allocate(address(vault), 100e18);
        vm.expectRevert(
            abi.encodeWithSelector(
                AllocationGate.StillCompliant.selector, address(vault), id, AllocationGate.Verdict.Compliant
            )
        );
        gate.exit(address(vault));
        // Old is not wrong: the watcher records unchanged re-checks without a transaction.
        vm.warp(block.timestamp + MAX_AGE + 1);
        assertFalse(gate.canExit(address(vault)));
        vm.expectRevert(
            abi.encodeWithSelector(
                AllocationGate.StillCompliant.selector, address(vault), id, AllocationGate.Verdict.Stale
            )
        );
        gate.exit(address(vault));
    }

    function test_exit_nothingToExit() public {
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.NothingToExit.selector, address(vault)));
        gate.exit(address(vault));
    }

    function test_exit_afterRevoke_removedIssuer_orWrongCode() public {
        DemoVault a = _demoVault();
        DemoVault b = _demoVault();
        uint256 idA = _pass(address(vault));
        uint256 idB = _pass(address(a));
        _pass(address(b));
        _allocate(address(vault), 10e18);
        _allocate(address(a), 10e18);
        _allocate(address(b), 10e18);

        vm.prank(issuer);
        reg.revoke(idA, keccak256("evidence"));
        vm.prank(keeper);
        assertTrue(gate.exit(address(vault)));

        // A second issuer re-checks b and gets a code hash that is not b's: the gate takes that as not about b.
        address second = makeAddr("second issuer");
        reg.setIssuer(second, true);
        reg.setIssuer(issuer, false); // a's attestation is now from an issuer the registry no longer lists
        (AllocationGate.Verdict v, uint256 id) = _verdict(address(a));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.UntrustedIssuer));
        assertEq(id, idB);
        vm.prank(keeper);
        assertTrue(gate.exit(address(a)));

        reg.setIssuer(issuer, true);
        uint256 wrong = _attest(address(b), 30, 0, 0, 0, keccak256("other code"));
        (v, id) = _verdict(address(b));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.CodeMismatch));
        assertEq(id, wrong);
        vm.prank(keeper);
        assertTrue(gate.exit(address(b)));
        assertEq(gate.idle(), FUND);
    }

    function test_exit_redeemReverts_withdrawFallbackPullsEverything() public {
        HostileVault h = _hostile(HostileVault.Mode.RevertRedeem);
        vm.expectEmit(true, false, false, true, address(gate));
        emit Exited(
            address(h), 0, keeper, AllocationGate.Verdict.NotCompliant, AllocationGate.ExitPath.Withdraw, 100e18, 100e18
        );
        vm.prank(keeper);
        assertTrue(gate.exit(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 0);
        assertEq(gate.positionOf(address(h)).assetsOut, 100e18);
    }

    function test_exit_partialWithdraw_keepsTheRest_aSecondExitTakesMore() public {
        HostileVault h = _hostile(HostileVault.Mode.HalfWithdraw);
        vm.prank(keeper);
        assertTrue(gate.exit(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 50e18);
        assertEq(h.balanceOf(address(gate)), 50e18);
        vm.prank(keeper);
        assertTrue(gate.exit(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 25e18);
        assertEq(gate.positionOf(address(h)).assetsOut, 75e18);
        assertEq(gate.idle(), FUND - 25e18);
    }

    function test_exit_aVaultRefusingBoth_endsInExitFailed_positionKept_retryLater() public {
        HostileVault h = _hostile(HostileVault.Mode.RevertAll);
        (, uint256 id) = _verdict(address(h));
        vm.roll(block.number + 1);
        vm.expectEmit(true, true, false, true, address(gate));
        emit ExitFailed(
            address(h),
            id,
            keeper,
            AllocationGate.Verdict.NotCompliant,
            100e18,
            HostileVault.Nope.selector,
            HostileVault.Nope.selector
        );
        vm.prank(keeper);
        assertFalse(gate.exit(address(h)));
        AllocationGate.Position memory p = gate.positionOf(address(h));
        assertEq(p.shares, 100e18);
        assertEq(p.assetsOut, 0);
        assertEq(p.lastExitBlock, block.number, "the attempt is recorded");
        // The vault starts paying again: the same keeper call now exits.
        h.arm(HostileVault.Mode.Honest, gate, address(0));
        vm.prank(keeper);
        assertTrue(gate.exit(address(h)));
        assertEq(gate.idle(), FUND);
    }

    function test_exit_aVaultReenteringExitGetsReentrancy() public {
        HostileVault h = _hostile(HostileVault.Mode.ReenterExit);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ExitFailed(
            address(h),
            0,
            keeper,
            AllocationGate.Verdict.NotCompliant,
            100e18,
            AllocationGate.Reentrancy.selector,
            AllocationGate.Reentrancy.selector
        );
        vm.prank(keeper);
        assertFalse(gate.exit(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 100e18);
    }

    /// A vault that burns its whole stipend in redeem and in maxWithdraw: the burn is the vault's own (it got
    /// exactly VAULT_CALL_GAS), so exit records ExitFailed and keeps the position instead of reverting.
    function test_exit_aGasBurningVaultEndsInExitFailed() public {
        HostileVault h = _hostile(HostileVault.Mode.BurnGas);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ExitFailed(address(h), 0, keeper, AllocationGate.Verdict.NotCompliant, 100e18, bytes4(0), bytes4(0));
        vm.prank(keeper);
        assertFalse(gate.exit{gas: 4_000_000}(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 100e18);
    }

    /// Less gas than a stipend needs is the caller's fault: InsufficientGas, nothing changes.
    function test_exit_lessGasThanAStipendRevertsWithInsufficientGas() public {
        HostileVault h = _hostile(HostileVault.Mode.BurnGas);
        uint256 needed = gate.VAULT_CALL_GAS() * 64 / 63 + gate.EXIT_GAS_RESERVE();
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.InsufficientGas.selector, needed));
        gate.exit{gas: 1_000_000}(address(h));
        // Enough for redeem, not for the reads after the vault burned its stipend.
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                AllocationGate.InsufficientGas.selector, gate.VAULT_VIEW_GAS() * 64 / 63 + gate.EXIT_GAS_RESERVE()
            )
        );
        gate.exit{gas: needed + 60_000}(address(h));
        assertEq(gate.positionOf(address(h)).lastExitBlock, 0);
    }

    /// What eth_estimateGas does: try lower and lower gas. With too little, an honest exit must revert, never
    /// succeed as an ExitFailed that leaves the shares in the vault.
    function test_exit_tooLittleGasRevertsInsteadOfRecordingAFailure() public {
        _pass(address(vault));
        _allocate(address(vault), 100e18);
        vm.prank(operator);
        vault.setBroken(true);
        _fail(address(vault));
        assertEq(_neverExitFailed(address(vault), new address[](0)), 0);
    }

    /// Every gas limit from 40,000 to 1,800,000 in steps of 10,000, with cold storage: how many end in ExitFailed
    /// (must stay 0 for an honest vault); at least one must exit.
    function _neverExitFailed(address v, address[] memory alsoCool) internal returns (uint256 failed) {
        uint256 exited;
        for (uint256 g = 40_000; g <= 1_800_000; g += 10_000) {
            uint256 snap = vm.snapshotState();
            vm.cool(address(gate));
            vm.cool(v);
            vm.cool(address(token));
            vm.cool(address(reg));
            for (uint256 i; i < alsoCool.length; ++i) {
                vm.cool(alsoCool[i]);
            }
            vm.prank(keeper);
            (bool ok, bytes memory ret) = address(gate).call{gas: g}(abi.encodeCall(AllocationGate.exit, (v)));
            if (ok && abi.decode(ret, (bool))) ++exited;
            if (ok && !abi.decode(ret, (bool))) ++failed;
            vm.revertToState(snap);
        }
        assertGt(exited, 0, "enough gas exits");
    }

    /// The vault pays about 742,000 gas to revert with 600 KB, twice. A gate that copied what it returns would pay
    /// as much again for each copy and run out of the 2.7M given; this one copies 32 bytes and records the failure.
    function test_exit_aHugeRevertIsCutTo32Bytes() public {
        HostileVault h = _hostile(HostileVault.Mode.HugeRevert);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ExitFailed(address(h), 0, keeper, AllocationGate.Verdict.NotCompliant, 100e18, bytes4(0), bytes4(0));
        vm.prank(keeper);
        assertFalse(gate.exit{gas: 2_700_000}(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 100e18);
    }

    /// A vault that answers redeem and withdraw as if it paid (a fallback that accepts any call) moved nothing: the
    /// success flags are not taken for an exit.
    function test_exit_aVaultThatAnswersWithoutPayingIsNotAnExit() public {
        HostileVault h = _hostile(HostileVault.Mode.NoOp);
        vm.expectEmit(true, false, false, true, address(gate));
        emit ExitFailed(address(h), 0, keeper, AllocationGate.Verdict.NotCompliant, 100e18, bytes4(0), bytes4(0));
        vm.prank(keeper);
        assertFalse(gate.exit(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 100e18);
        assertEq(gate.positionOf(address(h)).assetsOut, 0);
    }

    /// A caller that starves the registry read must not make a compliant vault look unattested: the read's
    /// out-of-gas is passed on, never taken for NoAttestation. Exit is covered twice: the 63/64 rule leaves too
    /// little gas after a starved read for it to finish anyway.
    function test_verdictOf_starvedRegistryReadIsNeverNoAttestation() public {
        _pass(address(vault));
        _allocate(address(vault), 100e18);
        uint256 answered;
        for (uint256 g = 2_000; g < 120_000; g += 500) {
            // Cold storage, as in a transaction of its own.
            vm.cool(address(reg));
            vm.cool(address(gate));
            (bool ok, bytes memory ret) =
                address(gate).staticcall{gas: g}(abi.encodeCall(AllocationGate.verdictOf, (address(vault))));
            if (!ok) continue;
            (AllocationGate.Verdict v,) = abi.decode(ret, (AllocationGate.Verdict, uint256));
            assertEq(uint8(v), uint8(AllocationGate.Verdict.Compliant));
            ++answered;
        }
        assertGt(answered, 0, "enough gas gives an answer");
        for (uint256 g = 25_000; g < 200_000; g += 2_500) {
            vm.cool(address(reg));
            vm.cool(address(gate));
            (bool ok,) = address(gate).call{gas: g}(abi.encodeCall(AllocationGate.exit, (address(vault))));
            assertFalse(ok);
        }
        assertEq(gate.positionOf(address(vault)).shares, 100e18);
        assertEq(gate.positionOf(address(vault)).lastExitBlock, 0);
    }

    /// A vault that pays but will not say what the gate still holds: the assets are counted, the shares are not
    /// forgotten on the vault's silence (the books keep them, a later exit can try again).
    function test_exit_aVaultThatDoesNotAnswerBalanceOfKeepsTheBooks() public {
        HostileVault h = _hostile(HostileVault.Mode.SilentBalance);
        vm.expectEmit(true, false, false, true, address(gate));
        emit Exited(
            address(h), 0, keeper, AllocationGate.Verdict.NotCompliant, AllocationGate.ExitPath.Redeem, 0, 100e18
        );
        vm.prank(keeper);
        assertTrue(gate.exit(address(h)));
        assertEq(gate.positionOf(address(h)).shares, 100e18);
        assertEq(gate.positionOf(address(h)).assetsOut, 100e18);
    }

    // ---------------------------------------------------------------- owner exit

    /// After the hackathon the watcher stops and every vault turns Stale: the owner can still pull its money out,
    /// a stranger still cannot.
    function test_exit_theOwnerMayExitOnAnyVerdict() public {
        DemoVault other = _demoVault();
        uint256 id = _pass(address(vault));
        _pass(address(other));
        _allocate(address(vault), 100e18);
        _allocate(address(other), 50e18);
        vm.warp(block.timestamp + 365 days);
        vm.prank(keeper);
        vm.expectRevert(
            abi.encodeWithSelector(
                AllocationGate.StillCompliant.selector, address(vault), id, AllocationGate.Verdict.Stale
            )
        );
        gate.exit(address(vault));

        vm.expectEmit(true, true, false, true, address(gate));
        emit Exited(
            address(vault), id, owner, AllocationGate.Verdict.Stale, AllocationGate.ExitPath.Redeem, 100e18, 100e18
        );
        vm.prank(owner);
        assertTrue(gate.exit(address(vault)));

        // A fresh compliant attestation: the owner can still leave, nobody else.
        _pass(address(other));
        vm.prank(owner);
        assertTrue(gate.exit(address(other)));
        assertEq(gate.idle(), FUND);
    }

    // ---------------------------------------------------------------- future block, pinned suite, slippage

    /// The vault is on this chain, so an attestation of a block that does not exist yet is not about it. It would
    /// also hold back every honest attestation (OlderThanLatest) until revoked.
    function test_futureBlockAttestation_refusesAllocateAndOpensExit() public {
        _pass(address(vault));
        _allocate(address(vault), 100e18);
        CheckAttestationRegistry.AttestParams memory p = _params(address(vault), 30, 0, 0, 0, bytes32(0));
        p.blockNumber = uint64(block.number + 100);
        vm.prank(issuer);
        uint256 id = reg.attest(p);
        (AllocationGate.Verdict v,) = _verdict(address(vault));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.FutureBlock));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.FutureBlock.selector, address(vault), id));
        gate.allocate(address(vault), 1e18, 0);
        vm.prank(keeper);
        assertTrue(gate.exit(address(vault)));
        // Once the chain reaches that block, it is an ordinary attestation again.
        vm.roll(block.number + 100);
        (v,) = _verdict(address(vault));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.Compliant));
    }

    /// A gate that pins a suite takes a pass of another suite for no verdict at all, like isCompliantWith.
    function test_pinnedSuite_anotherSuiteRefusesAllocateAndOpensExit() public {
        AllocationGate pinned =
            new AllocationGate(address(reg), chain, ERC4626, keccak256("suite"), address(token), owner, MAX_AGE);
        token.mint(address(pinned), 100e18);
        _pass(address(vault));
        vm.prank(owner);
        pinned.allocate(address(vault), 100e18, 0);
        CheckAttestationRegistry.AttestParams memory p = _params(address(vault), 30, 0, 0, 0, bytes32(0));
        p.suiteHash = keccak256("suite v2");
        vm.prank(issuer);
        uint256 id = reg.attest(p);
        assertTrue(reg.isCompliant(chain, address(vault), ERC4626));
        (AllocationGate.Verdict v,) = pinned.verdictOf(address(vault));
        assertEq(uint8(v), uint8(AllocationGate.Verdict.OtherSuite));
        (v,) = gate.verdictOf(address(vault)); // the unpinned gate accepts any suite
        assertEq(uint8(v), uint8(AllocationGate.Verdict.Compliant));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.OtherSuite.selector, address(vault), id));
        pinned.allocate(address(vault), 1e18, 0);
        vm.prank(keeper);
        assertTrue(pinned.exit(address(vault)));
    }

    /// First-depositor inflation: someone deposits 1 wei into an empty vault and donates 50 tokens, so 100 tokens
    /// buy 1 share. minShares refuses that deposit.
    function test_allocate_minSharesRefusesAnInflatedSharePrice() public {
        _pass(address(vault));
        token.mint(keeper, 50e18 + 1);
        vm.startPrank(keeper);
        token.approve(address(vault), 1);
        vault.deposit(1, keeper);
        token.transfer(address(vault), 50e18);
        vm.stopPrank();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.TooFewShares.selector, address(vault), 1, 99e18));
        gate.allocate(address(vault), 100e18, 99e18);
        // Without the inflation the same floor passes.
        DemoVault fresh = _demoVault();
        _pass(address(fresh));
        vm.prank(owner);
        assertEq(gate.allocate(address(fresh), 100e18, 99e18), 100e18);
    }

    // ---------------------------------------------------------------- the review's probes

    function _nested(uint256 rounds, bool noMax) internal returns (NestedVault v) {
        v = new NestedVault(token, rounds);
        v.set(false, false, noMax);
        _pass(address(v));
        _allocate(address(v), 100e18);
        _fail(address(v));
    }

    /// An honest vault two calls deeper than DemoVault, with or without maxWithdraw: no gas limit ends in ExitFailed.
    function test_probe_nestedHonestVault_neverEndsInExitFailed() public {
        uint256[3] memory cfg = [uint256(0), 4, 8];
        for (uint256 k; k < 3; ++k) {
            for (uint256 m; m < 2; ++m) {
                NestedVault v = _nested(cfg[k], m == 1);
                address[] memory deeper = new address[](2);
                deeper[0] = address(v.strategy());
                deeper[1] = address(v.strategy().pool());
                assertEq(_neverExitFailed(address(v), deeper), 0);
            }
        }
    }

    /// redeem spins through its stipend; withdraw works: the fallback is reached and pulls everything.
    function test_probe_redeemOutOfGas_fallsBackToWithdraw() public {
        NestedVault v = _nested(0, false);
        v.set(true, false, false);
        vm.expectEmit(true, false, false, true, address(gate));
        emit Exited(
            address(v), 0, keeper, AllocationGate.Verdict.NotCompliant, AllocationGate.ExitPath.Withdraw, 100e18, 100e18
        );
        vm.prank(keeper);
        assertTrue(gate.exit{gas: 5_000_000}(address(v)));
        assertEq(gate.positionOf(address(v)).shares, 0);
    }

    /// withdraw claims to burn twice what it did: the books follow the vault's balance, and the next exit takes more.
    function test_probe_withdrawOverstatingItsBurnStrandsNothing() public {
        NestedVault v = _nested(0, false);
        v.set(false, true, false);
        vm.prank(keeper);
        assertTrue(gate.exit(address(v)));
        assertEq(gate.positionOf(address(v)).shares, 50e18);
        assertEq(gate.positionOf(address(v)).shares, v.balanceOf(address(gate)));
        vm.prank(keeper);
        assertTrue(gate.exit(address(v)));
        assertEq(gate.positionOf(address(v)).shares, 25e18);
        assertEq(gate.positionOf(address(v)).assetsOut, 75e18);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_idleOnly_ownerOnly() public {
        _pass(address(vault));
        _allocate(address(vault), 600e18);
        vm.prank(keeper);
        vm.expectRevert(AllocationGate.NotOwner.selector);
        gate.withdraw(keeper, 1);
        vm.startPrank(owner);
        vm.expectRevert(AllocationGate.ZeroAddress.selector);
        gate.withdraw(address(0), 1);
        vm.expectRevert(AllocationGate.ZeroAmount.selector);
        gate.withdraw(owner, 0);
        vm.expectRevert(abi.encodeWithSelector(AllocationGate.InsufficientIdle.selector, 400e18, 400e18 + 1));
        gate.withdraw(owner, 400e18 + 1);
        vm.expectEmit(true, false, false, true, address(gate));
        emit IdleWithdrawn(owner, 400e18);
        gate.withdraw(owner, 400e18);
        vm.stopPrank();
        assertEq(token.balanceOf(owner), 400e18);
        assertEq(gate.idle(), 0);
        assertEq(gate.positionOf(address(vault)).shares, 600e18);
    }

    // ---------------------------------------------------------------- fuzz

    /// Two DemoVaults, another depositor, yield, any of them broken and exited, an idle withdrawal: the gate's
    /// books always match the token and the vaults.
    function testFuzz_accounting(
        uint96 a,
        uint96 b,
        uint96 otherDeposit,
        uint96 yieldA,
        bool breakA,
        bool breakB,
        uint96 out
    ) public {
        DemoVault va = vault;
        DemoVault vb = _demoVault();
        _pass(address(va));
        _pass(address(vb));
        uint256 amountA = bound(a, 1, FUND / 2);
        uint256 amountB = bound(b, 1, FUND / 2);
        uint256 other = bound(otherDeposit, 0, 1e30);
        if (other > 0) {
            token.mint(keeper, other);
            vm.startPrank(keeper);
            token.approve(address(va), other);
            va.deposit(other, keeper);
            vm.stopPrank();
        }
        uint256 sharesA = _allocate(address(va), amountA);
        if (sharesA == 0) return; // rounded to nothing: NoSharesMinted would have reverted
        uint256 sharesB = _allocate(address(vb), amountB);
        token.mint(address(va), bound(yieldA, 0, 1e30));

        uint256 expectedOut;
        if (breakA) {
            vm.prank(operator);
            va.setBroken(true);
            _fail(address(va));
            uint256 e = va.previewRedeem(sharesA);
            vm.prank(keeper);
            assertTrue(gate.exit(address(va)));
            expectedOut += e;
            assertEq(gate.positionOf(address(va)).assetsOut, e);
        }
        if (breakB) {
            _fail(address(vb));
            vm.prank(keeper);
            assertTrue(gate.exit(address(vb)));
            expectedOut += amountB; // the only depositor, no yield
        }
        uint256 withdrawn = bound(out, 0, gate.idle());
        if (withdrawn > 0) {
            vm.prank(owner);
            gate.withdraw(owner, withdrawn);
        }

        AllocationGate.Position memory pa = gate.positionOf(address(va));
        AllocationGate.Position memory pb = gate.positionOf(address(vb));
        assertEq(pa.shares, va.balanceOf(address(gate)));
        assertEq(pb.shares, vb.balanceOf(address(gate)));
        assertEq(pa.shares, breakA ? 0 : sharesA);
        assertEq(pb.shares, breakB ? 0 : sharesB);
        assertEq(pa.assetsIn, amountA);
        assertEq(pb.assetsIn, amountB);
        assertEq(pa.assetsOut + pb.assetsOut, expectedOut);
        assertEq(gate.idle(), FUND - amountA - amountB + expectedOut - withdrawn);
        assertEq(token.allowance(address(gate), address(va)), 0);
        assertEq(token.allowance(address(gate), address(vb)), 0);
        assertEq(gate.vaultCount(), 2);
    }
}
