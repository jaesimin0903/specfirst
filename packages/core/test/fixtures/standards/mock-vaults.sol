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

address constant SHARE_TOKEN = 0x5f00000000000000000000000000000000000041;
address constant SPLIT_VAULT = 0x5F00000000000000000000000000000000000042;

/// ERC-7575 share token of SplitShareVault: an ERC-20 whose supply only the vault changes.
contract SplitShareToken {
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

    function mint(address to, uint256 a) external { require(msg.sender == SPLIT_VAULT); balanceOf[to] += a; totalSupply += a; }

    function burnFrom(address spender, address from, uint256 a) external {
        require(msg.sender == SPLIT_VAULT);
        if (spender != from && allowance[from][spender] != type(uint256).max) allowance[from][spender] -= a;
        balanceOf[from] -= a; totalSupply -= a;
    }
}

/// ERC-7575 vault (the shape of Centrifuge V3 vaults): the ERC-4626 entry points without the ERC-20 part.
/// Shares live in SplitShareToken, returned by share(); balanceOf, allowance, approve and totalSupply do
/// not exist on the vault, so calls to them revert without data.
contract SplitShareVault {
    function share() external pure returns (address) { return SHARE_TOKEN; }
    function asset() external pure returns (address) { return TOKEN; }
    function totalAssets() public view returns (uint256) { return IERC20Min(TOKEN).balanceOf(address(this)); }
    function convertToShares(uint256 a) public pure returns (uint256) { return a; }
    function convertToAssets(uint256 s) public pure returns (uint256) { return s; }
    function maxDeposit(address) external pure returns (uint256) { return type(uint256).max; }
    function maxMint(address) external pure returns (uint256) { return type(uint256).max; }
    function maxWithdraw(address o) external view returns (uint256) { return SplitShareToken(SHARE_TOKEN).balanceOf(o); }
    function maxRedeem(address o) external view returns (uint256) { return SplitShareToken(SHARE_TOKEN).balanceOf(o); }
    function previewDeposit(uint256 a) external pure returns (uint256) { return a; }
    function previewMint(uint256 s) external pure returns (uint256) { return s; }
    function previewWithdraw(uint256 a) external pure returns (uint256) { return a; }
    function previewRedeem(uint256 s) external pure returns (uint256) { return s; }

    function deposit(uint256 a, address r) external returns (uint256) {
        IERC20Min(TOKEN).transferFrom(msg.sender, address(this), a);
        SplitShareToken(SHARE_TOKEN).mint(r, a);
        return a;
    }

    function mint(uint256 s, address r) external returns (uint256) {
        IERC20Min(TOKEN).transferFrom(msg.sender, address(this), s);
        SplitShareToken(SHARE_TOKEN).mint(r, s);
        return s;
    }

    function withdraw(uint256 a, address r, address o) external returns (uint256) {
        SplitShareToken(SHARE_TOKEN).burnFrom(msg.sender, o, a);
        IERC20Min(TOKEN).transfer(r, a);
        return a;
    }

    function redeem(uint256 s, address r, address o) external returns (uint256) {
        SplitShareToken(SHARE_TOKEN).burnFrom(msg.sender, o, s);
        IERC20Min(TOKEN).transfer(r, s);
        return s;
    }
}

/// A plain ERC-4626 vault that also answers share() with its own address, as EIP-7575 allows.
contract SelfShareVault is VaultBase {
    function share() external view returns (address) { return address(this); }
}

/// Reports 0 from all four max functions for everyone (a conservative underestimate EIP-4626 allows, as
/// Morpho Vault V2 does), while deposit, mint, withdraw and redeem work normally.
contract ZeroMaxVault is VaultBase {
    function maxDeposit(address) public pure override returns (uint256) { return 0; }
    function maxMint(address) public pure override returns (uint256) { return 0; }
    function maxWithdraw(address) public pure override returns (uint256) { return 0; }
    function maxRedeem(address) public pure override returns (uint256) { return 0; }
}

address constant ALLOWLIST_TOKEN = 0x5F00000000000000000000000000000000000004;

error Unauthorized();

/// Storage balances like any ERC-20, but only allowlisted senders may transfer (the shape of Valos vUSD on
/// Monad). Placed with anvil_setCode, so the allowlist is empty: deal can set a balance, nobody can move it.
contract AllowlistToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public allowed;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) { return 6; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transfer(address to, uint256 a) external returns (bool) {
        if (!allowed[msg.sender]) revert Unauthorized();
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (!allowed[msg.sender] || !allowed[f]) revert Unauthorized();
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// Correct 1:1 vault over AllowlistToken.
contract RestrictedAssetVault is VaultBase {
    function asset() public pure override returns (address) { return ALLOWLIST_TOKEN; }
}

address constant RECIPIENT_ALLOWLIST_TOKEN = 0x5F00000000000000000000000000000000000005;
address constant PARTIAL_RESTRICTED_VAULT = 0x5F00000000000000000000000000000000000062;

/// Only transfers to an allowlisted recipient go through; here the allowlist is PartialRestrictedVault. Users
/// can deposit (the vault receives) but cannot withdraw (a user receives) or pay each other, the pattern seen
/// on the Euler vault 0xD8ec5b4917FeF9058545e7D1dc2aC17F1D26305D over Valos vUSD.
contract RecipientAllowlistToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    function decimals() external pure returns (uint8) { return 6; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transfer(address to, uint256 a) external returns (bool) {
        if (to != PARTIAL_RESTRICTED_VAULT) revert Unauthorized();
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        if (to != PARTIAL_RESTRICTED_VAULT) revert Unauthorized();
        if (allowance[f][msg.sender] != type(uint256).max) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// Correct 1:1 vault over RecipientAllowlistToken: deposits work, withdrawals fail in the token.
contract PartialRestrictedVault is VaultBase {
    function asset() public pure override returns (address) { return RECIPIENT_ALLOWLIST_TOKEN; }
}

error NotAuthorized();

/// A freely transferable asset (MockToken) behind a vault whose own hook refuses deposits and mints while
/// maxDeposit and maxMint stay unlimited, like the Euler vault 0xf26dC2F1FE883b11Dd56700db594DfC32Eee95Bf.
/// That is the vault's restriction, not the asset's, so the probe must not skip it.
contract HookBlockedVault is VaultBase {
    function deposit(uint256, address) public pure override returns (uint256) { revert NotAuthorized(); }
    function mint(uint256, address) public pure override returns (uint256) { revert NotAuthorized(); }
}

address constant MONAD_STAKING = 0x0000000000000000000000000000000000001000;

interface IMonadStaking {
    function delegate(uint64 validatorId) external payable returns (bool);
}

/// Stakes what it receives through Monad's staking precompile, like Magma gMON (0x8498..5081), which deposits
/// through 0x1000. forge's EVM has no Monad precompiles: on a fork the call reaches an empty account, returns
/// nothing, and the vault reverts with no data. On Monad the same deposit goes through.
contract PrecompileVault is VaultBase {
    function deposit(uint256 a, address r) public override returns (uint256 s) {
        s = super.deposit(a, r);
        require(IMonadStaking(MONAD_STAKING).delegate(78));
    }

    function mint(uint256 s, address r) public override returns (uint256 a) {
        a = super.mint(s, r);
        require(IMonadStaking(MONAD_STAKING).delegate(78));
    }
}

/// Stakes only deposits and mints above 10 whole tokens. The one-token deposit of the setUp probe goes
/// through, so the precompile is met inside the sf- properties (and the deposit that gives shares before a
/// withdraw or redeem check).
contract ThresholdPrecompileVault is VaultBase {
    function deposit(uint256 a, address r) public override returns (uint256 s) {
        s = super.deposit(a, r);
        if (a > 10e6) require(IMonadStaking(MONAD_STAKING).delegate(78));
    }

    function mint(uint256 s, address r) public override returns (uint256 a) {
        a = super.mint(s, r);
        if (s > 10e6) require(IMonadStaking(MONAD_STAKING).delegate(78));
    }
}

/// Imitates the harness: maxMint and every withdraw revert with the harness's missing-precompile text, and no
/// precompile is ever called. Its failures must stay failures.
contract FakePrecompileTextVault is VaultBase {
    string internal constant TEXT = "specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)";

    function maxMint(address) public pure override returns (uint256) { revert(TEXT); }
    function withdraw(uint256, address, address) public pure override returns (uint256) { revert(TEXT); }
}

/// Imitates the harness in setUp: asset() reverts with the missing-precompile text, so both setUps stop with it.
contract FakePrecompileSetupVault is VaultBase {
    function asset() public pure override returns (address) {
        if (TOKEN != address(0)) revert("specfirst: fork lacks a Monad precompile the vault calls (0x0000000000000000000000000000000000001000)");
        return TOKEN;
    }
}

/// mint pulls 2% more assets than previewMint quotes, plus 2 (Curvance's hyAUSD LendingOptimizer pulled 61 for a
/// previewMint of 59). That breaks previewMint's sentence, not maxMint's.
contract MintSurchargeVault is VaultBase {
    function mint(uint256 s, address r) public override returns (uint256 a) {
        a = s + s / 50 + 2;
        IERC20Min(asset()).transferFrom(msg.sender, address(this), a);
        balanceOf[r] += s; totalSupply += s;
    }
}

error BelowMinimum();

/// Refuses deposits and mints below 500,000 whole tokens while maxDeposit and maxMint are unlimited. A minimum
/// amount is not what a max sentence covers: the amounts at the max go through.
contract MinDepositVault is VaultBase {
    uint256 internal constant MIN = 500_000e6;

    function deposit(uint256 a, address r) public override returns (uint256) {
        if (a < MIN) revert BelowMinimum();
        return super.deposit(a, r);
    }

    function mint(uint256 s, address r) public override returns (uint256) {
        if (s < MIN) revert BelowMinimum();
        return super.mint(s, r);
    }
}

/// Asynchronous exits, the Upshift earnAUSD shape: withdraw and redeem always revert, requestRedeem (ERC-7540's
/// signature) takes the shares, and maxWithdraw and maxRedeem still report the balance. It gets the async-redeem
/// trait and keeps its sf- exit fails: ERC-7540 still wants those max values to be what can be claimed now.
contract AsyncRedeemVault is VaultBase {
    mapping(address => uint256) public pendingShares;

    function requestRedeem(uint256 shares, address controller, address owner) external returns (uint256 requestId) {
        balanceOf[owner] -= shares;
        pendingShares[controller] += shares;
        return 0;
    }

    function withdraw(uint256, address, address) public pure override returns (uint256) { revert WithdrawalRequestRequired(); }
    function redeem(uint256, address, address) public pure override returns (uint256) { revert WithdrawalRequestRequired(); }
}

/// Exposes requestRedeem but lets withdraw and redeem go through: the selector alone is not the trait.
contract SelectorOnlyVault is VaultBase {
    function requestRedeem(uint256, address, address) external pure returns (uint256) { return 0; }
}

/// The Magma gMON shape: deposits stake through Monad's staking precompile (so the fork cannot run them),
/// exits go through requestRedeem, and ERC-165 declares ERC-7540 asynchronous redemption (0x620ee8e4).
contract PrecompileAsyncVault is VaultBase {
    function deposit(uint256 a, address r) public override returns (uint256 s) {
        s = super.deposit(a, r);
        require(IMonadStaking(MONAD_STAKING).delegate(78));
    }

    function mint(uint256 s, address r) public override returns (uint256 a) {
        a = super.mint(s, r);
        require(IMonadStaking(MONAD_STAKING).delegate(78));
    }

    function requestRedeem(uint256, address, address) external pure returns (uint256) { return 0; }
    function supportsInterface(bytes4 id) external pure returns (bool) { return id == 0x01ffc9a7 || id == 0x620ee8e4; }
    function withdraw(uint256, address, address) public pure override returns (uint256) { revert(); }
    function redeem(uint256, address, address) public pure override returns (uint256) { revert(); }
}
