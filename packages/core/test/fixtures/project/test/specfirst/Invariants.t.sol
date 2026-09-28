// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SpecfirstProps, IVault} from "./SpecfirstProps.sol";

contract Invariants {
    IVault internal vault;
    address[] internal depositors;

    function invariant_INV1() public view {
        require(SpecfirstProps.inv1(vault, depositors), "INV-1");
    }
}
