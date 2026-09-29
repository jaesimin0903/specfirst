// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;
import {SpecfirstERC4626Test} from "./SpecfirstERC4626.t.sol";
import {MockToken, Vault, PackedToken, NoDecimalsToken} from "../src/M.sol";

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
