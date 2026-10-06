// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DemoToken
/// @notice ERC-20 for the `specfirst watch` demo: the asset of DemoVaults on a local chain or testnet.
/// @dev Anyone may mint any amount. Never use it for anything of value.
contract DemoToken {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // The ERC-20 getters keep their standard names, so the lint's naming rule is off for them.
    // forge-lint: disable-next-line(screaming-snake-case-const)
    string public constant name = "Specfirst Demo Token";
    // forge-lint: disable-next-line(screaming-snake-case-const)
    string public constant symbol = "sfTKN";
    // forge-lint: disable-next-line(screaming-snake-case-const)
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}
