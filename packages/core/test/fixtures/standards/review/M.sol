// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    function decimals() external pure returns (uint8) { return 6; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

interface IMonadStaking {
    function delegate(uint64 validatorId) external payable returns (bool);
}

contract Vault {
    MockToken public immutable tok;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    uint256 public mode; // 0 ok, 1 maxDeposit reverts "rate limit exceeded", 2 maxDeposit reverts "paused", 3 maxRedeem reverts "HTTP error 503", 4 deposit reverts for any non-zero amount while maxDeposit is unlimited, 5 deposit stakes through Monad's staking precompile 0x1000 (gMON shape)
    constructor(MockToken t, uint256 m) { tok = t; mode = m; }
    function asset() external view returns (address) { return address(tok); }
    function decimals() external pure returns (uint8) { return 6; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
    function totalAssets() public view returns (uint256) { return tok.balanceOf(address(this)); }
    function convertToShares(uint256 a) public pure returns (uint256) { return a; }
    function convertToAssets(uint256 s) public pure returns (uint256) { return s; }
    function maxDeposit(address) public view returns (uint256) {
        if (mode == 1) revert("rate limit exceeded");
        if (mode == 2) revert("paused");
        return type(uint256).max;
    }
    function maxMint(address) public pure returns (uint256) { return type(uint256).max; }
    function maxWithdraw(address o) public view returns (uint256) { return balanceOf[o]; }
    function maxRedeem(address o) public view returns (uint256) {
        if (mode == 3) revert("HTTP error 503");
        return balanceOf[o];
    }
    function previewDeposit(uint256 a) public pure returns (uint256) { return a; }
    function previewMint(uint256 s) public pure returns (uint256) { return s; }
    function previewWithdraw(uint256 a) public pure returns (uint256) { return a; }
    function previewRedeem(uint256 s) public pure returns (uint256) { return s; }
    function deposit(uint256 a, address r) public returns (uint256 s) {
        if (mode == 4 && a > 0) revert("closed");
        tok.transferFrom(msg.sender, address(this), a); s = a; balanceOf[r] += s; totalSupply += s;
        if (mode == 5) require(IMonadStaking(address(0x1000)).delegate(78));
    }
    function mint(uint256 s, address r) public returns (uint256 a) { a = s; tok.transferFrom(msg.sender, address(this), a); balanceOf[r] += s; totalSupply += s; }
    function withdraw(uint256 a, address r, address o) public returns (uint256 s) { s = a; _spend(o, s); tok.transfer(r, a); }
    function redeem(uint256 s, address r, address o) public returns (uint256 a) { a = s; _spend(o, s); tok.transfer(r, a); }
    function _spend(address o, uint256 s) internal {
        if (msg.sender != o) { uint256 al = allowance[o][msg.sender]; if (al != type(uint256).max) allowance[o][msg.sender] = al - s; }
        balanceOf[o] -= s; totalSupply -= s;
    }
}

/// Balance packed above a 64-bit field in one slot, like AUSD on Monad: forge-std deal writes the whole
/// slot and fails with "checked_write ... Failed to write value."; the packed slot search succeeds.
contract PackedToken {
    struct Acct { uint64 flags; uint128 bal; }
    mapping(address => Acct) internal acct;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;
    function decimals() external pure returns (uint8) { return 6; }
    function balanceOf(address a) external view returns (uint256) { return acct[a].bal; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { _move(msg.sender, to, a); return true; }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        _move(f, to, a); return true;
    }
    function _move(address f, address t, uint256 a) internal { acct[f].bal -= uint128(a); acct[t].bal += uint128(a); acct[t].flags = 1; }
}

/// A token without decimals().
contract NoDecimalsToken {
    function balanceOf(address) external pure returns (uint256) { return 0; }
}

/// Storage balances like MockToken, but transfer and transferFrom always revert Unauthorized().
contract LockedToken {
    error Unauthorized();
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    function decimals() external pure returns (uint8) { return 6; }
    function transfer(address, uint256) external pure returns (bool) { revert Unauthorized(); }
    function transferFrom(address, address, uint256) external pure returns (bool) { revert Unauthorized(); }
}

/// transfer answers false instead of reverting.
contract FalseToken {
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;
    function decimals() external pure returns (uint8) { return 6; }
    function transfer(address, uint256) external pure returns (bool) { return false; }
}

/// Calls one address, then always reverts: what SfForkGaps sees in a vault call that met a precompile.
contract CallThenRevert {
    function callThenRevert(address target, bytes calldata data) external {
        (bool ok,) = target.call(data);
        ok;
        revert();
    }

    function staticThenRevert(address target, bytes calldata data) external view {
        (bool ok,) = target.staticcall(data);
        ok;
        revert();
    }

    function balanceThenRevert(address target) external view {
        if (target.balance == type(uint256).max) return;
        revert();
    }
}
