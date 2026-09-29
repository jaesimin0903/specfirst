// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// Specfirst's own ERC-4626 properties. Not derived from a16z/erc4626-tests and not inheriting it, so MIT.
// They compile and run in the same cached workspace as the upstream harness. See docs/adr/0003.
import {Test} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";

interface ISfDecimals {
    function decimals() external view returns (uint8);
}

interface ISfVault {
    function asset() external view returns (address);
    function convertToShares(uint256 assets) external view returns (uint256);
    function maxDeposit(address receiver) external view returns (uint256);
    function maxMint(address receiver) external view returns (uint256);
    function maxWithdraw(address owner) external view returns (uint256);
    function maxRedeem(address owner) external view returns (uint256);
    function previewDeposit(uint256 assets) external view returns (uint256);
    function previewMint(uint256 shares) external view returns (uint256);
    function previewRedeem(uint256 shares) external view returns (uint256);
    function deposit(uint256 assets, address receiver) external returns (uint256);
    function mint(uint256 shares, address receiver) external returns (uint256);
    function withdraw(uint256 assets, address receiver, address owner) external returns (uint256);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256);
}

/// EIP-4626 says maxDeposit, maxMint, maxWithdraw and maxRedeem return the most the matching call accepts
/// "and not cause a revert", and that they MUST return 0 when the action is disabled. The a16z suite calls
/// the vault through a helper that discards reverting inputs with vm.assume(false), so a vault whose
/// withdraw always reverts while maxWithdraw reports a balance never fails there; it only runs out of
/// inputs. These properties call the action directly and fail when it reverts within the advertised max.
/// To avoid false alarms: amounts that preview to zero shares or assets are discarded (reverting on a
/// zero-share deposit is common and not what these check), a max of 0 discards the input (0 is the honest
/// answer for a disabled action), and a failed setup step (funding, approve, the deposit that gives the
/// user shares) discards the input too. Users come from the same salted 16-address pool as the harness.
contract SpecfirstMaxHonored is Test {
    using stdStorage for StdStorage;

    uint256 internal constant USER_POOL = 16;
    address internal vault;
    address internal asset;
    uint256 internal cap;
    uint256 internal poolSalt;

    function setUp() public virtual {
        vault = vm.envAddress("SF_VAULT");
        asset = ISfVault(vault).asset();
        cap = 1_000_000 * 10 ** uint256(_decimalsOr18(asset));
        poolSalt = vm.envOr("SF_POOL_SALT", uint256(keccak256("specfirst.erc4626.pool")));
    }

    /// deposit(a) for 0 < a <= min(maxDeposit, cap) with previewDeposit(a) > 0 must not revert.
    function test_sf_maxDeposit_honored(uint256 who, uint256 amount) public {
        address u = _user(who);
        uint256 max = _read(abi.encodeCall(ISfVault.maxDeposit, (u)));
        uint256 hi = max < cap ? max : cap;
        vm.assume(hi > 0);
        uint256 a = bound(amount, 1, hi);
        vm.assume(_read(abi.encodeCall(ISfVault.previewDeposit, (a))) > 0);
        _fund(u, a);
        _mustNotRevert(u, abi.encodeCall(ISfVault.deposit, (a, u)), "deposit", a, "maxDeposit", max);
    }

    /// mint(s) for 0 < s <= min(maxMint, shares of cap) with previewMint(s) > 0 must not revert.
    function test_sf_maxMint_honored(uint256 who, uint256 shares) public {
        address u = _user(who);
        uint256 max = _read(abi.encodeCall(ISfVault.maxMint, (u)));
        uint256 capShares = _read(abi.encodeCall(ISfVault.convertToShares, (cap)));
        uint256 hi = max < capShares ? max : capShares;
        vm.assume(hi > 0);
        uint256 s = bound(shares, 1, hi);
        uint256 need = _read(abi.encodeCall(ISfVault.previewMint, (s)));
        vm.assume(need > 0 && need <= 2 * cap);
        // A little more than previewMint quotes, so a rounding difference is not blamed on maxMint.
        _fund(u, need + need / 100 + 1);
        _mustNotRevert(u, abi.encodeCall(ISfVault.mint, (s, u)), "mint", s, "maxMint", max);
    }

    /// After a deposit, withdraw(a, u, u) for 0 < a <= maxWithdraw(u) must not revert.
    function test_sf_maxWithdraw_honored(uint256 who, uint256 deposited, uint256 amount) public {
        address u = _user(who);
        _holdShares(u, deposited);
        uint256 max = _read(abi.encodeCall(ISfVault.maxWithdraw, (u)));
        vm.assume(max > 0);
        uint256 a = bound(amount, 1, max);
        _mustNotRevert(u, abi.encodeCall(ISfVault.withdraw, (a, u, u)), "withdraw", a, "maxWithdraw", max);
    }

    /// After a deposit, redeem(s, u, u) for 0 < s <= maxRedeem(u) with previewRedeem(s) > 0 must not revert.
    function test_sf_maxRedeem_honored(uint256 who, uint256 deposited, uint256 shares) public {
        address u = _user(who);
        _holdShares(u, deposited);
        uint256 max = _read(abi.encodeCall(ISfVault.maxRedeem, (u)));
        vm.assume(max > 0);
        uint256 s = bound(shares, 1, max);
        vm.assume(_read(abi.encodeCall(ISfVault.previewRedeem, (s))) > 0);
        _mustNotRevert(u, abi.encodeCall(ISfVault.redeem, (s, u, u)), "redeem", s, "maxRedeem", max);
    }

    /// Calls the vault as `u`; a revert fails the test with the action, the amount, the raw revert selector
    /// and the advertised max. The reason never carries revert text, so a vault cannot shape it.
    function _mustNotRevert(address u, bytes memory data, string memory action, uint256 amount, string memory maxName, uint256 max) internal {
        vm.prank(u);
        (bool ok, bytes memory ret) = vault.call(data);
        if (!ok) {
            revert(
                string.concat(action, "(", vm.toString(amount), ") reverted with ", _selectorOf(ret), " while ", maxName, " is ", vm.toString(max))
            );
        }
    }

    function _selectorOf(bytes memory ret) internal pure returns (string memory) {
        if (ret.length == 0) return "no revert data";
        if (ret.length < 4) return "short revert data";
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 32))
        }
        return string.concat("selector ", vm.toString(abi.encodePacked(sel)));
    }

    /// Deposits a bounded amount for `u` so it holds shares; any failure here discards the input.
    function _holdShares(address u, uint256 amount) internal {
        uint256 maxDep = _read(abi.encodeCall(ISfVault.maxDeposit, (u)));
        uint256 hi = maxDep < cap ? maxDep : cap;
        vm.assume(hi > 0);
        uint256 a = bound(amount, 1, hi);
        vm.assume(_read(abi.encodeCall(ISfVault.previewDeposit, (a))) > 0);
        _fund(u, a);
        vm.prank(u);
        (bool ok,) = vault.call(abi.encodeCall(ISfVault.deposit, (a, u)));
        vm.assume(ok);
    }

    /// A view call on the vault; a revert or a short answer discards the input.
    function _read(bytes memory data) internal view returns (uint256) {
        (bool ok, bytes memory ret) = vault.staticcall(data);
        vm.assume(ok && ret.length >= 32);
        return abi.decode(ret, (uint256));
    }

    function _user(uint256 who) internal view returns (address u) {
        u = address(uint160(uint256(keccak256(abi.encode(poolSalt, who % USER_POOL)))));
        vm.assume(u.code.length == 0 && uint160(u) > 0xffff && u != vault && u != asset);
    }

    /// Gives `u` the asset and approves the vault. A token whose balance cannot be written ends the test
    /// with forge-std's stdStorage error, which the runner reports as inconclusive.
    function _fund(address u, uint256 amount) internal {
        try this.__sfGiveDeal(u, amount) {} catch {
            this.__sfGivePacked(u, amount);
        }
        vm.prank(u);
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0x095ea7b3, vault, amount));
        vm.assume(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))));
    }

    function __sfGiveDeal(address to, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        deal(asset, to, amount);
    }

    function __sfGivePacked(address to, uint256 amount) external {
        require(msg.sender == address(this), "self only");
        stdstore.enable_packed_slots().target(asset).sig("balanceOf(address)").with_key(to).checked_write(amount);
    }

    function _decimalsOr18(address token) internal view returns (uint8) {
        try ISfDecimals(token).decimals() returns (uint8 d) {
            return d;
        } catch {
            return 18;
        }
    }
}
