// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;
import {SpecfirstERC4626Test} from "./SpecfirstERC4626.t.sol";
import {MockToken, Vault, PackedToken, NoDecimalsToken, LockedToken, FalseToken, CallThenRevert} from "../src/M.sol";
import {SpecfirstMaxHonored, SfEvents, SfForkGaps} from "./SpecfirstMaxHonored.t.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";

abstract contract Base is SpecfirstERC4626Test {
    function _mode() internal pure virtual returns (uint256);
    function setUp() public override {
        MockToken t = new MockToken();
        _underlying_ = address(t);
        _vault_ = address(new Vault(t, _mode()));
        _delta_ = 0; _vaultMayBeEmpty = false; _unlimitedAmount = false;
        _cap = 1_000_000 * 1e6;
    }
}
contract ModeRateLimit is Base { function _mode() internal pure override returns (uint256) { return 1; } }
contract ModePaused is Base { function _mode() internal pure override returns (uint256) { return 2; } }
contract ModeMaxRedeemHttp is Base { function _mode() internal pure override returns (uint256) { return 3; } }
contract ModeDepositRevertsBelowMax is Base { function _mode() internal pure override returns (uint256) { return 4; } }
contract SetupRevertsRateLimit is SpecfirstERC4626Test {
    function setUp() public override { revert("rate limit exceeded"); }
}
contract ModePackedAsset is SpecfirstERC4626Test {
    function setUp() public override {
        PackedToken t = new PackedToken();
        _underlying_ = address(t);
        _vault_ = address(new Vault(MockToken(address(t)), 0));
        _delta_ = 0; _vaultMayBeEmpty = false; _unlimitedAmount = false;
        _cap = 1_000_000 * 1e6;
    }
}
contract DecimalsFallback is SpecfirstERC4626Test {
    function setUp() public override {}
    function test_decimalsFallback() public {
        assertEq(_decimalsOr18(address(new NoDecimalsToken())), 18);
        assertEq(_decimalsOr18(address(new MockToken())), 6);
    }
}
contract ProbeState is SpecfirstERC4626Test {
    MockToken internal token;
    function setUp() public override {
        token = new MockToken();
        _underlying_ = address(token);
        _vault_ = address(new Vault(token, 0));
        _cap = 1_000_000 * 1e6;
        _poolSalt = 7;
    }
    function probe() external { _probeAssetTransfers(); }
    function test_probeLeavesNoState() public {
        uint256 supply = token.totalSupply();
        this.probe();
        assertEq(token.balanceOf(_poolMember(0)), 0);
        assertEq(token.balanceOf(_poolMember(1)), 0);
        assertEq(token.totalSupply(), supply);
    }
    function test_probeRejectsLockedToken() public {
        _underlying_ = address(new LockedToken());
        vm.expectRevert(bytes("specfirst: asset transfers are restricted for test users (selector 0x82b42900)"));
        this.probe();
    }
    function test_probeRejectsFalseTransfer() public {
        _underlying_ = address(new FalseToken());
        vm.expectRevert(bytes("specfirst: asset transfers are restricted for test users (transfer returned false)"));
        this.probe();
    }
}
contract SfProbeState is SpecfirstMaxHonored {
    MockToken internal token;
    function setUp() public override {
        token = new MockToken();
        asset = address(token);
        vault = address(new Vault(token, 0));
        cap = 1_000_000 * 1e6;
        poolSalt = 7;
    }
    function probe() external { _probeAssetTransfers(); }
    function test_sfProbeLeavesNoState() public {
        this.probe();
        assertEq(token.balanceOf(_poolMember(0)), 0);
        assertEq(token.balanceOf(_poolMember(1)), 0);
    }
    function test_sfProbeRejectsLockedToken() public {
        asset = address(new LockedToken());
        vm.expectRevert(bytes("specfirst: asset transfers are restricted for test users (selector 0x82b42900)"));
        this.probe();
    }
}

/// SfForkGaps.precompileCause and missingPrecompiles on Monad's chain ids, and the SfEvents re-entry guard.
contract ForkGaps is Test {
    CallThenRevert internal c;
    MockToken internal token;
    function setUp() public {
        c = new CallThenRevert();
        token = new MockToken();
        vm.chainId(143);
    }
    function _depositReverting(Vault v, address user, uint256 a) internal returns (bytes memory data) {
        deal(address(token), user, a);
        vm.prank(user);
        token.approve(address(v), a);
        data = abi.encodeCall(Vault.deposit, (a, user));
        vm.prank(user);
        (bool ok,) = address(v).call(data);
        assertFalse(ok);
    }
    function _reverting(bytes memory data) internal returns (bytes memory ret) {
        bool ok;
        (ok, ret) = address(c).call(data);
        assertFalse(ok);
    }
    function test_gapsListedOnMonadChainsOnly() public {
        address[] memory gaps = SfForkGaps.missingPrecompiles();
        assertEq(gaps.length, 3);
        assertEq(gaps[0], address(0x0100));
        assertEq(gaps[1], address(0x1000));
        assertEq(gaps[2], address(0x1001));
        vm.chainId(10143);
        assertEq(SfForkGaps.missingPrecompiles().length, 3);
        vm.chainId(31337);
        assertEq(SfForkGaps.missingPrecompiles().length, 0);
    }
    function test_gapsLeaveOutAPrecompileThisEvmHas() public {
        // A forge build with Monad precompiles: 0x1000 answers getEpoch(). Code stands in for it here.
        vm.etch(address(0x1000), hex"60206000f3");
        address[] memory gaps = SfForkGaps.missingPrecompiles();
        assertEq(gaps.length, 2);
        assertEq(gaps[0], address(0x0100));
        assertEq(gaps[1], address(0x1001));
    }
    function test_causeIsTheStakingPrecompileForAStakingDeposit() public {
        Vault v = new Vault(token, 5);
        address user = address(0xA11CE);
        bytes memory data = _depositReverting(v, user, 1e6);
        assertEq(SfForkGaps.precompileCause(address(v), user, data), address(0x1000));
        // The rerun ran inside a snapshot: no deposit and no code left behind.
        assertEq(v.totalSupply(), 0);
        assertEq(token.balanceOf(user), 1e6);
        assertEq(address(0x1000).code.length, 0);
        (bool ok,) = address(v).call(data);
        assertFalse(ok);
    }
    function test_causeIsNoneOffMonad() public {
        vm.chainId(31337);
        Vault v = new Vault(token, 5);
        bytes memory data = _depositReverting(v, address(0xA11CE), 1e6);
        assertEq(SfForkGaps.precompileCause(address(v), address(0xA11CE), data), address(0));
    }
    function test_causeIsThePrecompileWhateverTheRevert() public {
        // A revert with data after a precompile call (FeeTouchVault's shape: an ignored call, then a real bug) is
        // not judged either: nothing on the fork shows that the revert did not need the real answer.
        bytes memory data = abi.encodeCall(CallThenRevert.callThenRevertWithData, (address(0x1001), hex"3a61584e"));
        assertEq(bytes4(_reverting(data)), CallThenRevert.Nope.selector);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0x1001));
        data = abi.encodeCall(CallThenRevert.callThenRevertWithData, (address(0x1000), abi.encodeWithSignature("getDelegations(address,uint64)", address(1), uint64(0))));
        _reverting(data);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0x1000));
    }
    function test_causeIsThePrecompileForAnEmptyRevert() public {
        // An honest vault that decodes the precompile's answer reverts with no data on the fork.
        bytes memory data = abi.encodeCall(CallThenRevert.callThenRevert, (address(0x1001), hex"3a61584e"));
        assertEq(_reverting(data).length, 0);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0x1001));
        data = abi.encodeCall(CallThenRevert.staticThenRevert, (address(0x1000), hex"757991a8"));
        _reverting(data);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0x1000));
        // HonestDynVault's shape: getDelegations (bool, uint64, uint64[]) then delegate.
        data = abi.encodeCall(CallThenRevert.stakeHonestly, ());
        _reverting(data);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0x1000));
    }
    function test_causeIsTheStakingPrecompileForAnEpochGuard() public {
        // EpochGuardVault's shape: its own Nope() for a malformed or stale epoch. Honest on Monad, not judged here.
        bytes memory data = abi.encodeCall(CallThenRevert.epochOrNope, ());
        assertEq(bytes4(_reverting(data)), CallThenRevert.Nope.selector);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0x1000));
    }
    function test_causeIsNoneWithoutAPrecompile() public {
        bytes memory data = abi.encodeCall(CallThenRevert.callThenRevert, (address(0xdead), hex""));
        _reverting(data);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0));
        data = abi.encodeCall(CallThenRevert.balanceThenRevert, (address(0x1000)));
        _reverting(data);
        assertEq(SfForkGaps.precompileCause(address(c), address(this), data), address(0));
    }
    function test_missingCalledSeesCallsInRevertedFrames() public {
        address[] memory gaps = SfForkGaps.missingPrecompiles();
        vm.startStateDiffRecording();
        (bool ok,) = address(c).call(abi.encodeCall(CallThenRevert.callThenRevert, (address(0x1000), abi.encodeWithSelector(0x84994fec, uint64(78)))));
        Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertFalse(ok);
        assertEq(SfForkGaps.missingCalled(acc, gaps), address(0x1000));
    }
    function writeEvent() external { SfEvents.write("guard", ""); }
    function test_eventsRefuseACallFromInsideAVault() public {
        vm.expectRevert(bytes("specfirst: re-entered from inside a vault call"));
        this.writeEvent();
    }
}

/// The harness's setUp refuses to run when called back (msg.sender is not the run's sender).
contract GuardedSetUp is SpecfirstERC4626Test {
    function setUp() public override {}
    function harnessSetUp() external { SpecfirstERC4626Test.setUp(); }
    function test_setUpRefusesReentry() public {
        vm.expectRevert(bytes("specfirst: re-entered from inside a vault call"));
        this.harnessSetUp();
    }
}
