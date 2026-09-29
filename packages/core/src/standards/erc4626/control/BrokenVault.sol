// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// Positive control for the ERC-4626 harness (docs/adr/0003). Correct share accounting except one
/// deliberate bug: previewDeposit promises 1% more shares than deposit mints, which EIP-4626 forbids.
/// The harness must report previewDeposit as failed on this vault. Never deployed to a real chain:
/// the control test creates it inside forge's fork.
contract BrokenVault {
    IERC20Min internal immutable _asset;
    string public name = "Broken Control Vault";
    string public symbol = "BRKN";
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address asset_) {
        _asset = IERC20Min(asset_);
        decimals = IERC20Min(asset_).decimals();
    }

    function asset() external view returns (address) { return address(_asset); }
    function totalAssets() public view returns (uint256) { return _asset.balanceOf(address(this)); }

    function convertToShares(uint256 a) public view returns (uint256) {
        uint256 s = totalSupply;
        return s == 0 ? a : a * s / totalAssets();
    }

    function convertToAssets(uint256 sh) public view returns (uint256) {
        uint256 s = totalSupply;
        return s == 0 ? sh : sh * totalAssets() / s;
    }

    function _up(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) { return (x * y + d - 1) / d; }

    function maxDeposit(address) external pure returns (uint256) { return type(uint256).max; }
    function maxMint(address) external pure returns (uint256) { return type(uint256).max; }
    function maxWithdraw(address o) external view returns (uint256) { return convertToAssets(balanceOf[o]); }
    function maxRedeem(address o) external view returns (uint256) { return balanceOf[o]; }

    // The deliberate bug.
    function previewDeposit(uint256 a) public view returns (uint256) { return convertToShares(a) * 101 / 100; }

    function previewMint(uint256 sh) public view returns (uint256) {
        uint256 s = totalSupply;
        return s == 0 ? sh : _up(sh, totalAssets(), s);
    }

    function previewWithdraw(uint256 a) public view returns (uint256) {
        uint256 s = totalSupply;
        return s == 0 ? a : _up(a, s, totalAssets());
    }

    function previewRedeem(uint256 sh) public view returns (uint256) { return convertToAssets(sh); }

    function deposit(uint256 a, address r) external returns (uint256 sh) {
        sh = convertToShares(a);
        require(_asset.transferFrom(msg.sender, address(this), a));
        _mint(r, sh);
    }

    function mint(uint256 sh, address r) external returns (uint256 a) {
        a = previewMint(sh);
        require(_asset.transferFrom(msg.sender, address(this), a));
        _mint(r, sh);
    }

    function withdraw(uint256 a, address r, address o) external returns (uint256 sh) {
        sh = previewWithdraw(a);
        _spend(o, sh);
        _burn(o, sh);
        require(_asset.transfer(r, a));
    }

    function redeem(uint256 sh, address r, address o) external returns (uint256 a) {
        a = previewRedeem(sh);
        _spend(o, sh);
        _burn(o, sh);
        require(_asset.transfer(r, a));
    }

    function approve(address sp, uint256 v) external returns (bool) {
        allowance[msg.sender][sp] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        _spend(f, v);
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }

    function _spend(address o, uint256 v) internal {
        if (msg.sender != o) {
            uint256 al = allowance[o][msg.sender];
            if (al != type(uint256).max) allowance[o][msg.sender] = al - v;
        }
    }

    function _mint(address to, uint256 v) internal {
        totalSupply += v;
        balanceOf[to] += v;
    }

    function _burn(address f, uint256 v) internal {
        balanceOf[f] -= v;
        totalSupply -= v;
    }
}
