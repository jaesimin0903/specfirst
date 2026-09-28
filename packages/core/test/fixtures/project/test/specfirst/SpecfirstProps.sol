// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IVault {
    function totalStaked() external view returns (uint256);
    function balances(address user) external view returns (uint256);
}

library SpecfirstProps {
    function inv1(IVault v, address[] memory depositors) internal view returns (bool) {
        uint256 sum;
        for (uint256 i = 0; i < depositors.length; i++) {
            sum += v.balances(depositors[i]);
        }
        return v.totalStaked() == sum;
    }
}
