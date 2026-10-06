// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IDemoAsset {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title DemoVault
/// @notice Minimal ERC-4626 vault for the `specfirst watch` demo (docs/adr/0006). Its share accounting is the
///         one of the harness's positive control (BrokenVault in packages/core/src/standards/erc4626/control),
///         with the standard's events added, and the control's deliberate bug sits behind a switch: while
///         `broken` is true, previewDeposit promises 1% more shares than deposit mints, which EIP-4626
///         forbids, and the check reports previewDeposit as failed. The account that deployed the vault
///         through the factory (`operator`) can flip the switch, so a re-check sees the result change, and can
///         make the vault lose a share of its assets (`setLoss`), so the value of a share falls.
/// @dev Testnet and local demo only: no fees, no limits, no access control beyond setBroken and setLoss.
contract DemoVault {
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event BrokenSet(bool broken);
    event LossSet(uint256 bps, uint256 assets);

    error NotOperator();
    error TransferFailed();
    error BadLoss(uint256 bps);

    /// @notice Where setLoss sends the assets it takes away; nobody holds its key.
    address public constant LOSS_SINK = 0x000000000000000000000000000000000000dEaD;

    // The ERC-20 and ERC-4626 getters keep their standard names, so the lint's naming rule is off for them.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    IDemoAsset internal immutable _asset;
    /// @notice The account that deployed the vault through the factory; only it may call setBroken.
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    address public immutable operator;
    // forge-lint: disable-next-line(screaming-snake-case-immutable)
    uint8 public immutable decimals;
    // forge-lint: disable-next-line(screaming-snake-case-const)
    string public constant name = "Specfirst Demo Vault";
    // forge-lint: disable-next-line(screaming-snake-case-const)
    string public constant symbol = "sfDEMO";
    bool public broken;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(address asset_, address operator_, bool broken_) {
        _asset = IDemoAsset(asset_);
        operator = operator_;
        decimals = IDemoAsset(asset_).decimals();
        broken = broken_;
        if (broken_) emit BrokenSet(true);
    }

    /// @notice Turns the deliberate previewDeposit bug on or off.
    function setBroken(bool broken_) external {
        if (msg.sender != operator) revert NotOperator();
        broken = broken_;
        emit BrokenSet(broken_);
    }

    /// @notice Sends `bps` basis points (1 to 9,999) of the vault's assets to LOSS_SINK: a loss every holder shares,
    ///         so convertToAssets of a share falls by that fraction. The demo of the watcher's share value alerts.
    function setLoss(uint256 bps) external {
        if (msg.sender != operator) revert NotOperator();
        if (bps == 0 || bps >= 10_000) revert BadLoss(bps);
        uint256 assets = totalAssets() * bps / 10_000;
        _push(LOSS_SINK, assets);
        emit LossSet(bps, assets);
    }

    function asset() external view returns (address) {
        return address(_asset);
    }

    function totalAssets() public view returns (uint256) {
        return _asset.balanceOf(address(this));
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? assets : assets * supply / totalAssets();
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? shares : shares * totalAssets() / supply;
    }

    function maxDeposit(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxMint(address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function maxWithdraw(address owner) external view returns (uint256) {
        return convertToAssets(balanceOf[owner]);
    }

    function maxRedeem(address owner) external view returns (uint256) {
        return balanceOf[owner];
    }

    /// @dev The deliberate bug of the positive control, active only while `broken` is true.
    function previewDeposit(uint256 assets) public view returns (uint256) {
        uint256 shares = convertToShares(assets);
        return broken ? shares * 101 / 100 : shares;
    }

    function previewMint(uint256 shares) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? shares : _divUp(shares * totalAssets(), supply);
    }

    function previewWithdraw(uint256 assets) public view returns (uint256) {
        uint256 supply = totalSupply;
        return supply == 0 ? assets : _divUp(assets * supply, totalAssets());
    }

    function previewRedeem(uint256 shares) public view returns (uint256) {
        return convertToAssets(shares);
    }

    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        shares = convertToShares(assets);
        _pull(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function mint(uint256 shares, address receiver) external returns (uint256 assets) {
        assets = previewMint(shares);
        _pull(assets);
        _mint(receiver, shares);
        emit Deposit(msg.sender, receiver, assets, shares);
    }

    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares) {
        shares = previewWithdraw(assets);
        _spend(owner, shares);
        _burn(owner, shares);
        _push(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets) {
        assets = previewRedeem(shares);
        _spend(owner, shares);
        _burn(owner, shares);
        _push(receiver, assets);
        emit Withdraw(msg.sender, receiver, owner, assets, shares);
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
        _spend(from, value);
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }

    function _divUp(uint256 x, uint256 d) internal pure returns (uint256) {
        return (x + d - 1) / d;
    }

    function _pull(uint256 assets) internal {
        if (!_asset.transferFrom(msg.sender, address(this), assets)) revert TransferFailed();
    }

    function _push(address to, uint256 assets) internal {
        if (!_asset.transfer(to, assets)) revert TransferFailed();
    }

    function _spend(address owner, uint256 value) internal {
        if (msg.sender != owner) {
            uint256 allowed = allowance[owner][msg.sender];
            if (allowed != type(uint256).max) allowance[owner][msg.sender] = allowed - value;
        }
    }

    function _mint(address to, uint256 value) internal {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }
}

/// @title DemoVaultFactory
/// @notice Deploys DemoVaults and announces each one with VaultDeployed, the event the watcher's demo
///         source (examples/watch/sources-demo.json) listens for. Anyone may deploy; the caller becomes the
///         vault's operator. Deployed at a fixed address through the deterministic CREATE2 deployer, so the
///         sources file can name it before the deployment.
contract DemoVaultFactory {
    event VaultDeployed(address indexed vault, address indexed asset);

    /// @notice Deploys a DemoVault over `asset` (an ERC-20 with decimals()); `broken` starts it with the
    ///         previewDeposit bug on.
    function deploy(address asset, bool broken) external returns (address vault) {
        vault = address(new DemoVault(asset, msg.sender, broken));
        emit VaultDeployed(vault, asset);
    }
}
