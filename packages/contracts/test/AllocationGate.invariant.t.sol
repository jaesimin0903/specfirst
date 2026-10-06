// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CheckAttestationRegistry} from "../src/CheckAttestationRegistry.sol";
import {AllocationGate} from "../src/demo/AllocationGate.sol";
import {DemoToken} from "../src/demo/DemoToken.sol";
import {DemoVault, DemoVaultFactory} from "../src/demo/DemoVaultFactory.sol";

/// @notice Drives a gate over three DemoVaults with random allocations, bugs switched on and off and attested,
///         revocations, keeper exits, yield, other depositors, idle withdrawals and time jumps. Every action is
///         guarded so it never reverts (fail_on_revert = true); a refused allocation is asserted to be refused.
contract GateHandler is Test {
    bytes32 internal constant ERC4626 = 0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab;

    AllocationGate public gate;
    CheckAttestationRegistry public reg;
    DemoToken public token;
    DemoVault[] public vaults;
    address public owner;
    address internal issuer = makeAddr("issuer");
    address internal operator = makeAddr("operator");
    address internal keeper = makeAddr("keeper");
    address internal other = makeAddr("other depositor");

    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public ghostWithdrawn;
    uint256 public allocations;
    uint256 public refusals;
    uint256 public exits;

    constructor(AllocationGate gate_, CheckAttestationRegistry reg_, DemoToken token_, address owner_) {
        gate = gate_;
        reg = reg_;
        token = token_;
        owner = owner_;
        DemoVaultFactory factory = new DemoVaultFactory();
        for (uint256 i; i < 3; ++i) {
            vm.prank(operator);
            DemoVault v = DemoVault(factory.deploy(address(token), false));
            vaults.push(v);
            _attest(v, false);
        }
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function _attest(DemoVault v, bool failing) internal {
        vm.roll(block.number + 1);
        CheckAttestationRegistry.AttestParams memory p = CheckAttestationRegistry.AttestParams({
            subjectChainId: uint64(block.chainid),
            subject: address(v),
            standardId: ERC4626,
            blockNumber: uint64(block.number),
            implementationKey: keccak256("impl"),
            subjectCodeHash: address(v).codehash,
            suiteHash: keccak256("suite"),
            reportHash: keccak256(abi.encode(v, block.number)),
            passCount: failing ? 29 : 30,
            failCount: failing ? 1 : 0,
            inconclusiveCount: 0,
            notApplicableCount: 0,
            passedBitmap: failing ? (uint256(1) << 29) - 1 : (uint256(1) << 30) - 1,
            failedBitmap: failing ? uint256(1) << 29 : 0,
            reportURI: "certs/checks/31337/demo.json"
        });
        vm.prank(issuer);
        reg.attest(p);
    }

    function allocate(uint256 seed, uint256 amount) external {
        DemoVault v = vaults[seed % vaults.length];
        uint256 idle = gate.idle();
        if (idle == 0) return;
        amount = bound(amount, 1, idle);
        (AllocationGate.Verdict verdict,) = gate.verdictOf(address(v));
        if (verdict != AllocationGate.Verdict.Compliant) {
            vm.prank(owner);
            try gate.allocate(address(v), amount) {
                fail("allocated into a vault that is not compliant");
            } catch {
                ++refusals;
            }
            return;
        }
        if (v.convertToShares(amount) == 0) return; // NoSharesMinted
        AllocationGate.Position memory before = gate.positionOf(address(v));
        vm.prank(owner);
        uint256 shares = gate.allocate(address(v), amount);
        assertEq(gate.positionOf(address(v)).shares, before.shares + shares);
        ghostIn += amount;
        ++allocations;
    }

    function setBroken(uint256 seed, bool broken) external {
        DemoVault v = vaults[seed % vaults.length];
        vm.prank(operator);
        v.setBroken(broken);
        _attest(v, broken);
    }

    function revokeLatest(uint256 seed) external {
        DemoVault v = vaults[seed % vaults.length];
        (uint256 id, CheckAttestationRegistry.Attestation memory a) =
            reg.latest(uint64(block.chainid), address(v), ERC4626);
        if (a.status != CheckAttestationRegistry.Status.Valid) return;
        vm.prank(issuer);
        reg.revoke(id, keccak256("evidence"));
    }

    function exit(uint256 seed) external {
        DemoVault v = vaults[seed % vaults.length];
        if (!gate.canExit(address(v))) return;
        uint256 shares = gate.positionOf(address(v)).shares;
        uint256 expected = v.previewRedeem(shares);
        uint256 idle = gate.idle();
        vm.prank(keeper);
        assertTrue(gate.exit(address(v)));
        assertEq(gate.idle() - idle, expected);
        ghostOut += expected;
        ++exits;
    }

    function yieldTo(uint256 seed, uint256 amount) external {
        token.mint(address(vaults[seed % vaults.length]), bound(amount, 0, 1e24));
    }

    function otherDeposit(uint256 seed, uint256 amount) external {
        DemoVault v = vaults[seed % vaults.length];
        amount = bound(amount, 1, 1e24);
        if (v.convertToShares(amount) == 0) return;
        token.mint(other, amount);
        vm.startPrank(other);
        token.approve(address(v), amount);
        v.deposit(amount, other);
        vm.stopPrank();
    }

    function otherRedeem(uint256 seed, uint256 shares) external {
        DemoVault v = vaults[seed % vaults.length];
        uint256 held = v.balanceOf(other);
        if (held == 0) return;
        vm.prank(other);
        v.redeem(bound(shares, 1, held), other, other);
    }

    function withdrawIdle(uint256 amount) external {
        uint256 idle = gate.idle();
        if (idle == 0) return;
        amount = bound(amount, 1, idle);
        vm.prank(owner);
        gate.withdraw(owner, amount);
        ghostWithdrawn += amount;
    }

    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }
}

contract AllocationGateInvariantTest is Test {
    uint256 internal constant FUND = 1_000_000e18;

    GateHandler internal handler;
    AllocationGate internal gate;
    DemoToken internal token;

    function setUp() public {
        vm.warp(1_760_000_000);
        vm.roll(1000);
        CheckAttestationRegistry reg = new CheckAttestationRegistry();
        token = new DemoToken();
        address owner = makeAddr("owner");
        gate = new AllocationGate(
            address(reg),
            uint64(block.chainid),
            0x45f39c8c7e3105201fd8b1288ac068347728af9cfd16f3f08e97171ef955c9ab,
            address(token),
            owner,
            1 days
        );
        token.mint(address(gate), FUND);
        // The registry's owner is this test; the handler's issuer is the same labelled address.
        reg.setIssuer(makeAddr("issuer"), true);
        handler = new GateHandler(gate, reg, token, owner);
        targetContract(address(handler));
    }

    /// The gate's balance is exactly what was funded, minus allocations, plus exits, minus idle withdrawals.
    function invariant_idleMatchesTheBooks() public view {
        assertEq(gate.idle(), FUND + handler.ghostOut() - handler.ghostIn() - handler.ghostWithdrawn());
    }

    /// Per vault: the gate's count of shares is the vault's, its sums are the handler's, and no approval is left.
    function invariant_positionsMatchTheVaults() public view {
        uint256 inSum;
        uint256 outSum;
        for (uint256 i; i < handler.vaultCount(); ++i) {
            DemoVault v = handler.vaults(i);
            AllocationGate.Position memory p = gate.positionOf(address(v));
            assertEq(p.shares, v.balanceOf(address(gate)));
            assertEq(token.allowance(address(gate), address(v)), 0);
            inSum += p.assetsIn;
            outSum += p.assetsOut;
        }
        assertEq(inSum, handler.ghostIn());
        assertEq(outSum, handler.ghostOut());
    }

    /// Each vault is listed once, and only after an allocation.
    function invariant_vaultListHasNoDuplicates() public view {
        address[] memory list = gate.vaults();
        assertLe(list.length, handler.vaultCount());
        for (uint256 i; i < list.length; ++i) {
            assertGt(gate.positionOf(list[i]).lastAllocatedBlock, 0);
            for (uint256 j = i + 1; j < list.length; ++j) {
                assertTrue(list[i] != list[j]);
            }
        }
    }
}
