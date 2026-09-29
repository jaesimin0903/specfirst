// SPDX-License-Identifier: AGPL-3.0
pragma solidity >=0.8.0 <0.9.0;

// Inherits the harness, which inherits a16z/erc4626-tests (AGPL-3.0). See docs/adr/0003.
import {SpecfirstERC4626Test} from "./SpecfirstERC4626.t.sol";
import {BrokenVault} from "../src/BrokenVault.sol";

interface IControlDecimals {
    function decimals() external view returns (uint8);
}

/// Positive control: the same harness against a BrokenVault created inside the fork over the live asset
/// SF_ASSET. previewDeposit must fail; a harness that passes this vault cannot catch the bug.
contract SpecfirstERC4626Control is SpecfirstERC4626Test {
    function setUp() public override {
        _underlying_ = vm.envAddress("SF_ASSET");
        _vault_ = address(new BrokenVault(_underlying_));
        _delta_ = 0;
        _vaultMayBeEmpty = false;
        _unlimitedAmount = false;
        _cap = 1_000_000 * 10 ** uint256(IControlDecimals(_underlying_).decimals());
    }
}
