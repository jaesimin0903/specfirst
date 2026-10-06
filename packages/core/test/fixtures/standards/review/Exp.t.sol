// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;
import {SpecfirstERC4626Test} from "./SpecfirstERC4626.t.sol";
import {MockToken, Vault, PackedToken, NoDecimalsToken, LockedToken, FalseToken, CallThenRevert} from "../src/M.sol";
import {SpecfirstMaxHonored, SfForkGaps} from "./SpecfirstMaxHonored.t.sol";
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
    function depositProbe() external { _probeDepositPrecompiles(); }
    function test_depositProbeStopsAtMissingPrecompile() public {
        _vault_ = address(new Vault(token, 5));
        vm.expectRevert(bytes("specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)"));
        this.depositProbe();
    }
    function test_depositProbeLeavesOtherRevertsAndNoState() public {
        _vault_ = address(new Vault(token, 4));
        this.depositProbe();
        _vault_ = address(new Vault(token, 0));
        uint256 supply = token.totalSupply();
        this.depositProbe();
        assertEq(Vault(_vault_).totalSupply(), 0);
        assertEq(token.balanceOf(_poolMember(0)), 0);
        assertEq(token.totalSupply(), supply);
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
    function depositProbe() external { _probeDepositPrecompiles(); }
    function test_sfDepositProbeStopsAtMissingPrecompile() public {
        vault = address(new Vault(token, 5));
        vm.expectRevert(bytes("specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)"));
        this.depositProbe();
        vault = address(new Vault(token, 4));
        this.depositProbe();
    }
}

/// SfForkGaps on recorded state diffs: which accesses count as a missing precompile.
contract ForkGaps is Test {
    CallThenRevert internal c;
    function setUp() public { c = new CallThenRevert(); }
    function _record(address target, bytes memory data) internal returns (Vm.AccountAccess[] memory acc) {
        vm.startStateDiffRecording();
        (bool ok,) = address(c).call(abi.encodeCall(CallThenRevert.callThenRevert, (target, data)));
        acc = vm.stopAndReturnStateDiff();
        assertFalse(ok);
    }
    function test_gapsFlagStakingCallInRevertedFrame() public {
        assertEq(SfForkGaps.missingCalled(_record(address(0x1000), abi.encodeWithSelector(0x84994fec, uint64(78)))), address(0x1000));
    }
    function test_gapsFlagReserveBalanceAndP256() public {
        assertEq(SfForkGaps.missingCalled(_record(address(0x1001), hex"3a61584e")), address(0x1001));
        assertEq(SfForkGaps.missingCalled(_record(address(0x0100), hex"00")), address(0x0100));
    }
    function test_gapsIgnoreUnlistedEmptyAccountAndEthereumPrecompiles() public {
        assertEq(SfForkGaps.missingCalled(_record(address(0xdead), hex"")), address(0));
        assertEq(SfForkGaps.missingCalled(_record(address(0x0002), hex"00")), address(0));
    }
    function test_gapsIgnorePrecompileThisEvmHas() public {
        // A forge build with Monad precompiles: 0x1000 answers getEpoch(). Code stands in for it here.
        vm.etch(address(0x1000), hex"60206000f3");
        assertEq(SfForkGaps.missingCalled(_record(address(0x1000), hex"757991a8")), address(0));
    }
    function test_gapsIgnoreBalanceRead() public {
        vm.startStateDiffRecording();
        (bool ok,) = address(c).call(abi.encodeCall(CallThenRevert.balanceThenRevert, (address(0x1000))));
        Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        assertFalse(ok);
        assertEq(SfForkGaps.missingCalled(acc), address(0));
    }
    function test_gapsReason() public pure {
        assertEq(SfForkGaps.reason(address(0x1000)), "specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)");
    }
}
