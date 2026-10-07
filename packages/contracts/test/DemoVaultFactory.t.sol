// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {DemoVault, DemoVaultFactory} from "../src/demo/DemoVaultFactory.sol";

contract DemoVaultFactoryTest is Test {
    event VaultDeployed(address indexed vault, address indexed asset);
    event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares
    );
    event BrokenSet(bool broken);
    event LossSet(uint256 bps, uint256 assets);

    DemoToken internal token;
    DemoVaultFactory internal factory;
    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        token = new DemoToken();
        factory = new DemoVaultFactory();
    }

    function _vault(bool broken) internal returns (DemoVault) {
        vm.prank(alice);
        return DemoVault(factory.deploy(address(token), broken));
    }

    function _fund(address who, DemoVault vault, uint256 amount) internal {
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(vault), type(uint256).max);
    }

    function test_deploy_emitsVaultDeployed_callerIsOperator() public {
        vm.recordLogs();
        vm.prank(alice);
        address vault = factory.deploy(address(token), false);
        assertEq(vm.getRecordedLogs().length, 1, "only VaultDeployed");
        DemoVault v = DemoVault(vault);
        assertEq(v.asset(), address(token));
        assertEq(v.operator(), alice);
        assertEq(v.decimals(), 18);
        assertFalse(v.broken());
        assertEq(v.totalAssets(), 0);

        vm.expectEmit(false, true, false, false, address(factory));
        emit VaultDeployed(address(0), address(token));
        factory.deploy(address(token), false);
    }

    function test_deploy_broken_emitsBrokenSet() public {
        vm.expectEmit(false, false, false, true);
        emit BrokenSet(true);
        DemoVault v = _vault(true);
        assertTrue(v.broken());
    }

    function test_depositRedeem_roundTrip_withEvents() public {
        DemoVault v = _vault(false);
        _fund(bob, v, 1000e18);
        vm.expectEmit(true, true, false, true, address(v));
        emit Deposit(bob, bob, 100e18, 100e18);
        vm.prank(bob);
        uint256 shares = v.deposit(100e18, bob);
        assertEq(shares, 100e18);
        assertEq(v.balanceOf(bob), 100e18);
        assertEq(v.totalAssets(), 100e18);

        // yield: assets per share double
        token.mint(address(v), 100e18);
        assertEq(v.previewRedeem(50e18), 100e18);
        vm.expectEmit(true, true, true, true, address(v));
        emit Withdraw(bob, bob, bob, 100e18, 50e18);
        vm.prank(bob);
        assertEq(v.redeem(50e18, bob, bob), 100e18);
        assertEq(token.balanceOf(bob), 1000e18);
        assertEq(v.maxRedeem(bob), 50e18);
    }

    function test_previewDeposit_matchesDeposit_unlessBroken() public {
        DemoVault v = _vault(false);
        _fund(bob, v, 1000e18);
        vm.prank(bob);
        v.deposit(300e18, bob);
        token.mint(address(v), 7e18);
        uint256 preview = v.previewDeposit(10e18);
        vm.prank(bob);
        assertEq(v.deposit(10e18, bob), preview);

        vm.prank(alice);
        v.setBroken(true);
        uint256 promised = v.previewDeposit(10e18);
        vm.prank(bob);
        uint256 minted = v.deposit(10e18, bob);
        assertEq(promised, minted * 101 / 100);
        assertGt(promised, minted, "the bug: previewDeposit promises more than deposit mints");
    }

    function testFuzz_previewDeposit_equalsDeposit(uint96 seed, uint96 assets) public {
        DemoVault v = _vault(false);
        _fund(bob, v, uint256(seed) + uint256(assets) + 1);
        vm.prank(bob);
        v.deposit(uint256(seed) + 1, bob);
        uint256 preview = v.previewDeposit(assets);
        vm.prank(bob);
        assertEq(v.deposit(assets, bob), preview);
    }

    function test_setBroken_onlyOperator() public {
        DemoVault v = _vault(false);
        vm.prank(bob);
        vm.expectRevert(DemoVault.NotOperator.selector);
        v.setBroken(true);
        vm.expectEmit(false, false, false, true, address(v));
        emit BrokenSet(true);
        vm.prank(alice);
        v.setBroken(true);
        assertTrue(v.broken());
        vm.prank(alice);
        v.setBroken(false);
        assertFalse(v.broken());
    }

    function test_setLoss_onlyOperator_boundsChecked() public {
        DemoVault v = _vault(false);
        _fund(bob, v, 100e18);
        vm.prank(bob);
        v.deposit(100e18, bob);
        vm.prank(bob);
        vm.expectRevert(DemoVault.NotOperator.selector);
        v.setLoss(42);
        vm.startPrank(alice);
        vm.expectRevert(abi.encodeWithSelector(DemoVault.BadLoss.selector, 0));
        v.setLoss(0);
        vm.expectRevert(abi.encodeWithSelector(DemoVault.BadLoss.selector, 10_000));
        v.setLoss(10_000);
        vm.stopPrank();
    }

    function test_setLoss_sendsAssetsAway_shareValueFalls() public {
        DemoVault v = _vault(false);
        _fund(bob, v, 1e18);
        vm.prank(bob);
        v.deposit(1e18, bob);
        assertEq(v.convertToAssets(1e18), 1e18);

        vm.expectEmit(false, false, false, true, address(v));
        emit LossSet(42, 42e14);
        vm.prank(alice);
        v.setLoss(42);
        assertEq(token.balanceOf(v.LOSS_SINK()), 42e14);
        assertEq(v.totalAssets(), 1e18 - 42e14);
        assertEq(v.totalSupply(), 1e18, "no share is burned");
        assertEq(v.convertToAssets(1e18), 9958e14, "one share is worth 0.42% less");

        // Still a working vault: the holder redeems what is left.
        vm.prank(bob);
        assertEq(v.redeem(1e18, bob, bob), 9958e14);
    }

    function testFuzz_setLoss_shareValueFallsByTheBps(uint96 deposit, uint16 rawBps) public {
        uint256 bps = bound(rawBps, 1, 9_999);
        uint256 amount = bound(deposit, 1e6, type(uint96).max);
        DemoVault v = _vault(false);
        _fund(bob, v, amount);
        vm.prank(bob);
        v.deposit(amount, bob);
        uint256 before = v.convertToAssets(1e18);
        vm.prank(alice);
        v.setLoss(bps);
        uint256 afterLoss = v.convertToAssets(1e18);
        assertLt(afterLoss, before);
        // The fall in bps of the share value, rounded either way by the integer divisions, is the bps asked for.
        assertApproxEqAbs((before - afterLoss) * 10_000 / before, bps, 1);
    }

    function test_allowance_spentByThirdParty() public {
        DemoVault v = _vault(false);
        _fund(bob, v, 100e18);
        vm.prank(bob);
        v.deposit(100e18, bob);
        vm.prank(bob);
        v.approve(alice, 40e18);
        vm.prank(alice);
        v.withdraw(30e18, alice, bob);
        assertEq(v.allowance(bob, alice), 10e18);
        vm.prank(alice);
        vm.expectRevert();
        v.withdraw(20e18, alice, bob);
    }

    function test_token_transferFrom_spendsAllowance() public {
        token.mint(bob, 5);
        vm.prank(bob);
        token.approve(alice, 3);
        vm.prank(alice);
        token.transferFrom(bob, alice, 2);
        assertEq(token.allowance(bob, alice), 1);
        assertEq(token.balanceOf(alice), 2);
        vm.prank(alice);
        vm.expectRevert();
        token.transferFrom(bob, alice, 2);
    }
}
