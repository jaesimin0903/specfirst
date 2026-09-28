// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IVault} from "./IVault.sol";
import {SpecfirstProps} from "./SpecfirstProps.sol";

/// @title SpecfirstProbe
/// @notice Never deployed. Run as a create call without `to` (eth_call over creation code) at the
///         latest block. The constructor evaluates the state properties against a live vault and
///         returns abi.encode(bool inv1, bool inv2, bool inv6) as the call output.
/// @dev Fallback path 2 of plan section 3.6-6. INV-6 has no handler ghost here, so it is judged by
///      attempting a zero value deposit when the vault is paused.
contract SpecfirstProbe {
    constructor(address vault, address[] memory depositors) {
        IVault v = IVault(vault);
        bytes memory out = abi.encode(
            SpecfirstProps.inv1(v, depositors), SpecfirstProps.inv2(v, depositors), SpecfirstProps.inv6(v, false)
        );
        assembly {
            return(add(out, 0x20), mload(out))
        }
    }
}
