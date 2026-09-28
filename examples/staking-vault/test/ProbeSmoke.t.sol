// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";

import {IVault} from "./specfirst/IVault.sol";
import {SpecfirstProbe} from "./specfirst/SpecfirstProbe.sol";

/// @notice Checks that SpecfirstProbe's creation code returns abi.encode(inv1, inv2, inv6).
///         CREATE stores the constructor output as code, so the returned bytes are read back from
///         the created address. Off chain the same bytes come from an eth_call without `to`.
contract ProbeSmokeTest is Test {
    IVault internal vault;
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");

    function setUp() public {
        vault = IVault(deployCode("StakingVault.sol:StakingVault", abi.encode(owner)));
        vm.deal(alice, 10 ether);
        vm.prank(alice);
        vault.deposit{value: 3 ether}();
    }

    function _probe(address[] memory depositors) internal returns (bool, bool, bool) {
        bytes memory init = abi.encodePacked(type(SpecfirstProbe).creationCode, abi.encode(address(vault), depositors));
        address p;
        assembly {
            p := create(0, add(init, 0x20), mload(init))
        }
        require(p != address(0), "probe create failed");
        return abi.decode(p.code, (bool, bool, bool));
    }

    function test_probeHealthyState() public {
        address[] memory deps = new address[](1);
        deps[0] = alice;
        (bool i1, bool i2, bool i6) = _probe(deps);
        assertTrue(i1 && i2 && i6);
    }

    function test_probeWhilePaused() public {
        vm.prank(owner);
        vault.pause();
        address[] memory deps = new address[](1);
        deps[0] = alice;
        (,, bool i6) = _probe(deps);
        assertTrue(i6);
    }

    function test_probeDetectsDoubleCountedDepositor() public {
        // A depositor set that double counts alice makes the sum exceed totalStaked and vault MON.
        address[] memory deps = new address[](2);
        deps[0] = alice;
        deps[1] = alice;
        (bool i1, bool i2,) = _probe(deps);
        assertFalse(i1);
        assertFalse(i2);
    }
}
