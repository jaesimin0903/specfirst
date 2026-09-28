// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title StakingVault
/// @notice Native MON staking vault used as the specfirst sample.
contract StakingVault {
    error Unauthorized();
    error InsufficientBalance();
    error PausedError();
    error TransferFailed();

    event Deposit(address indexed user, uint256 amount);
    event Withdraw(address indexed user, uint256 amount);
    event RewardRateChanged(uint256 rate);
    event Paused(bool paused);

    address public owner;
    uint256 public totalStaked;
    uint256 public rewardRate;
    bool public paused;
    mapping(address => uint256) public balances;

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    function deposit() external payable {
        if (paused) revert PausedError();
        balances[msg.sender] += msg.value;
        totalStaked += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external {
        uint256 bal = balances[msg.sender];
        if (amount > bal) revert InsufficientBalance();
        balances[msg.sender] = bal - amount;
        totalStaked -= amount;
        emit Withdraw(msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function setRewardRate(uint256 rate) external onlyOwner {
        rewardRate = rate;
        emit RewardRateChanged(rate);
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused(true);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Paused(false);
    }
}
