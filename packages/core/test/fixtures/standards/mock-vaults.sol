// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Fixture-only contracts for packages/core/test/fixtures/standards. They have no constructor so their
// runtime code can be placed with anvil_setCode (no transaction, no key). Addresses are constants.

address constant TOKEN = 0x5F00000000000000000000000000000000000001;
address constant COMPUTED_TOKEN = 0x5F00000000000000000000000000000000000002;
address constant PACKED_TOKEN = 0x5F00000000000000000000000000000000000003;

/// Plain ERC-20 with storage balances, 6 decimals.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) { return 6; }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// Token whose balances are not in storage: forge-std `deal` cannot find a slot to write.
contract ComputedToken {
    function decimals() external pure returns (uint8) { return 6; }
    function balanceOf(address a) external pure returns (uint256) { return uint160(a) % 1000; }
    function allowance(address, address) external pure returns (uint256) { return 0; }
    function totalSupply() external pure returns (uint256) { return 0; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address, uint256) external pure returns (bool) { return true; }
    function transferFrom(address, address, uint256) external pure returns (bool) { return true; }
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
}

/// 1:1 vault. `bonus` extra shares per deposit make it mint more than the assets it received.
abstract contract VaultBase {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function asset() public pure virtual returns (address) { return TOKEN; }
    function bonus(uint256 assets) internal pure virtual returns (uint256) { assets; return 0; }
    function decimals() external pure returns (uint8) { return 6; }

    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }

    function totalAssets() public view returns (uint256) { return IERC20Min(asset()).balanceOf(address(this)); }
    function convertToShares(uint256 a) public pure returns (uint256) { return a; }
    function convertToAssets(uint256 s) public pure returns (uint256) { return s; }
    function maxDeposit(address) public view virtual returns (uint256) { return type(uint256).max; }
    function maxMint(address) public view virtual returns (uint256) { return type(uint256).max; }
    function maxWithdraw(address o) public view virtual returns (uint256) { return balanceOf[o]; }
    function maxRedeem(address o) public view virtual returns (uint256) { return balanceOf[o]; }
    function previewDeposit(uint256 a) public pure returns (uint256) { return a; }
    function previewMint(uint256 s) public pure returns (uint256) { return s; }
    function previewWithdraw(uint256 a) public pure returns (uint256) { return a; }
    function previewRedeem(uint256 s) public pure returns (uint256) { return s; }

    function deposit(uint256 a, address r) public virtual returns (uint256 s) {
        IERC20Min(asset()).transferFrom(msg.sender, address(this), a);
        s = a + bonus(a);
        balanceOf[r] += s; totalSupply += s;
    }
    function mint(uint256 s, address r) public virtual returns (uint256 a) {
        a = s;
        IERC20Min(asset()).transferFrom(msg.sender, address(this), a);
        balanceOf[r] += s; totalSupply += s;
    }
    function withdraw(uint256 a, address r, address o) public virtual returns (uint256 s) {
        s = a;
        _spend(o, s);
        IERC20Min(asset()).transfer(r, a);
    }
    function redeem(uint256 s, address r, address o) public virtual returns (uint256 a) {
        a = s;
        _spend(o, s);
        IERC20Min(asset()).transfer(r, a);
    }
    function _spend(address o, uint256 s) internal {
        if (msg.sender != o) {
            uint256 al = allowance[o][msg.sender];
            if (al != type(uint256).max) allowance[o][msg.sender] = al - s;
        }
        balanceOf[o] -= s; totalSupply -= s;
    }
}

/// Mints one extra share on every non-zero deposit: deposit then redeem returns more than went in.
contract BuggyVault is VaultBase {
    function bonus(uint256 assets) internal pure override returns (uint256) { return assets > 0 ? 1 : 0; }
}

/// Closed vault: maxDeposit is 0 and every deposit reverts, so the harness rejects every input.
contract ClosedVault is VaultBase {
    function maxDeposit(address) public pure override returns (uint256) { return 0; }
    function maxMint(address) public pure override returns (uint256) { return 0; }
    function deposit(uint256, address) public pure override returns (uint256) { revert("closed"); }
    function mint(uint256, address) public pure override returns (uint256) { revert("closed"); }
}

/// Vault over a token whose balances `deal` cannot write.
contract ComputedAssetVault is VaultBase {
    function asset() public pure override returns (address) { return COMPUTED_TOKEN; }
}

/// Balance packed above a 64-bit field in one slot, like AUSD on Monad: plain deal fails, the packed write works.
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
        _move(f, to, a);
        return true;
    }

    function _move(address f, address t, uint256 a) internal {
        acct[f].bal -= uint128(a);
        acct[t].bal += uint128(a);
        acct[t].flags = 1;
    }
}

/// Correct 1:1 vault over the packed-balance token.
contract PackedAssetVault is VaultBase {
    function asset() public pure override returns (address) { return PACKED_TOKEN; }
}

/// Correct 1:1 vault over MockToken: every max is honoured.
contract HonouringVault is VaultBase {}

error WithdrawalRequestRequired();

/// Shaped like Upshift earnAUSD on Monad: withdraw and redeem always revert (exits go through an async
/// request flow), yet maxWithdraw and maxRedeem report the holder's balance. EIP-4626 says they MUST be 0.
contract AsyncExitVault is VaultBase {
    function withdraw(uint256, address, address) public pure override returns (uint256) { revert WithdrawalRequestRequired(); }
    function redeem(uint256, address, address) public pure override returns (uint256) { revert WithdrawalRequestRequired(); }
}

/// Same exits, but honest about it: maxWithdraw and maxRedeem are 0.
contract HonestClosedExitVault is VaultBase {
    function maxWithdraw(address) public pure override returns (uint256) { return 0; }
    function maxRedeem(address) public pure override returns (uint256) { return 0; }
    function withdraw(uint256, address, address) public pure override returns (uint256) { revert WithdrawalRequestRequired(); }
    function redeem(uint256, address, address) public pure override returns (uint256) { revert WithdrawalRequestRequired(); }
}
