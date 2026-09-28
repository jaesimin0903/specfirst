// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CertificateRegistry} from "../src/CertificateRegistry.sol";

/// @notice Deploys CertificateRegistry and allows the deployer to issue.
/// Usage: forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PK --broadcast
contract Deploy is Script {
    function run() external returns (CertificateRegistry reg) {
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        reg = new CertificateRegistry();
        reg.setIssuer(deployer, true);
        vm.stopBroadcast();
        console2.log("CertificateRegistry", address(reg));
        console2.log("owner and issuer", deployer);
    }
}
