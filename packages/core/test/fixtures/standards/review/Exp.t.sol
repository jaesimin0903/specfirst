// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;
import {SpecfirstERC4626Test} from "./SpecfirstERC4626.t.sol";
import {MockToken, Vault, PackedToken, NoDecimalsToken, LockedToken, FalseToken} from "../src/M.sol";
import {SpecfirstMaxHonored} from "./SpecfirstMaxHonored.t.sol";

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
