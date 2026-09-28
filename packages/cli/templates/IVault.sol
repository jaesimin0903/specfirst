// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Surface of the vault under test. Properties only talk to the vault through this.
interface IVault {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function setRewardRate(uint256 rate) external;
    function pause() external;
    function unpause() external;

    function balances(address user) external view returns (uint256);
    function totalStaked() external view returns (uint256);
    function rewardRate() external view returns (uint256);
    function paused() external view returns (bool);
    function owner() external view returns (address);
}
