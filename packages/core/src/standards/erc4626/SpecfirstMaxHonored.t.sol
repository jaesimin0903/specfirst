// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0 <0.9.0;

// Specfirst's own ERC-4626 properties. Not derived from a16z/erc4626-tests and not inheriting it, so MIT.
// They compile and run in the same cached workspace as the upstream harness. See docs/adr/0003.
import {Test} from "forge-std/Test.sol";
import {StdStorage, stdStorage} from "forge-std/StdStorage.sol";
import {Vm, VmSafe} from "forge-std/Vm.sol";

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

/// Precompiles Monad has and forge's EVM lacks (docs.monad.xyz, "Precompiles"): P256 signature verification at
/// 0x0100 (EIP-7951, not in forge's prague), staking at 0x1000 and the reserve balance check at 0x1001. On a
/// fork of Monad a call to one of them reaches an empty account, succeeds and returns nothing, so the calling
/// vault can revert for a reason the real chain does not have (Magma gMON deposits through the staking
/// precompile). Used by both suites; MIT, so the AGPL harness may import it.
library SfForkGaps {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// The listed precompiles this EVM lacks, on a fork of Monad mainnet (143) or testnet (10143) only: on any
    /// other chain these addresses mean nothing, and a vault calling them is judged like any other call.
    function missingPrecompiles() internal view returns (address[] memory gaps) {
        if (block.chainid != 143 && block.chainid != 10143) return new address[](0);
        address[3] memory listed = [address(0x0100), address(0x1000), address(0x1001)];
        uint256 n;
        gaps = new address[](listed.length);
        for (uint256 i = 0; i < listed.length; i++) {
            if (_missing(listed[i])) gaps[n++] = listed[i];
        }
        assembly {
            mstore(gaps, n)
        }
    }

    /// The first of `gaps` the recorded calls reached; 0 when none. Only call accesses count (call,
    /// delegatecall, callcode, staticcall), including those in frames that reverted.
    function missingCalled(Vm.AccountAccess[] memory acc, address[] memory gaps) internal pure returns (address) {
        for (uint256 i = 0; i < acc.length; i++) {
            if (uint256(acc[i].kind) > uint256(VmSafe.AccountAccessKind.StaticCall)) continue;
            for (uint256 j = 0; j < gaps.length; j++) {
                if (acc[i].account == gaps[j]) return gaps[j];
            }
        }
        return address(0);
    }

    /**
     * A call of `caller` to `target` reverted with `ret`. Returns the missing precompile it reached when the input
     * cannot be judged on that revert, or 0 when the revert is the vault's own. Inside a state snapshot that is
     * always restored, the call runs again:
     * 1. with state diffs recorded, to see whether it reaches a missing precompile at all; when it does not, the
     *    revert is the vault's own;
     * 2. when it does, it is judged only if the revert carries data and stays exactly the same while every
     *    missing precompile answers, first with typical values and then with empty or false ones (vm.mockCall
     *    with ABI-shaped answers per function, over a byte of code). An empty revert, a call that then goes
     *    through or a revert that changes leaves the input unjudged: an honest vault that decodes a precompile's
     *    answer reverts with no data on the fork, and a vault can stage a difference (it sees the byte of code),
     *    which is why the runner never passes a property with an unjudged input.
     * Runs only after a revert. forge 1.5.1 keeps state diff recording on after stopAndReturnStateDiff for the
     * rest of the fuzz run, and every caller here either discards the input or ends the run soon after, so the
     * properties do not pay for it.
     */
    function precompileCause(address target, address caller, bytes memory data, bytes memory ret) internal returns (address p) {
        address[] memory gaps = missingPrecompiles();
        if (gaps.length == 0) return address(0);
        uint256 snap = VM.snapshotState();
        VM.startStateDiffRecording();
        VM.prank(caller);
        (bool okAgain,) = target.call(data);
        Vm.AccountAccess[] memory acc = VM.stopAndReturnStateDiff();
        address reached = okAgain ? address(0) : missingCalled(acc, gaps);
        if (reached != address(0)) {
            for (uint256 i = 0; i < gaps.length; i++) {
                VM.etch(gaps[i], hex"00");
            }
            if (ret.length == 0 || !_sameRevert(target, caller, data, ret, gaps, true) || !_sameRevert(target, caller, data, ret, gaps, false)) {
                p = reached;
            }
        }
        VM.revertToStateAndDelete(snap);
    }

    /// The call again with every missing precompile answering (`typical` or empty and false values); true when it
    /// reverts with exactly `ret`.
    function _sameRevert(address target, address caller, bytes memory data, bytes memory ret, address[] memory gaps, bool typical) private returns (bool) {
        for (uint256 i = 0; i < gaps.length; i++) {
            _mockAnswers(gaps[i], typical);
        }
        VM.prank(caller);
        (bool ok, bytes memory again) = target.call(data);
        VM.clearMockedCalls();
        return !ok && keccak256(again) == keccak256(ret);
    }

    /// ABI-shaped answers per function. P256: a valid signature (1), or the empty answer of an invalid one. The
    /// reserve balance check: false or true. The staking precompile (docs.monad.xyz, "Staking API"): every
    /// function with its return types, `typical` giving success, one id or delegator and non-zero amounts, the
    /// other failure, empty lists and zeros; list functions answer isDone true either way.
    function _mockAnswers(address p, bool typical) private {
        if (p == address(0x0100)) {
            VM.mockCall(p, bytes(""), typical ? abi.encode(uint256(1)) : bytes(""));
            return;
        }
        if (p == address(0x1001)) {
            VM.mockCall(p, abi.encodeWithSignature("dippedIntoReserve()"), abi.encode(!typical));
            return;
        }
        uint256 amount = typical ? 1e24 : 0;
        uint64 id = typical ? 1 : 0;
        uint64[] memory ids = new uint64[](typical ? 1 : 0);
        address[] memory delegators = new address[](typical ? 1 : 0);
        if (typical) {
            ids[0] = 1;
            delegators[0] = address(1);
        }
        _mock(p, "addValidator(bytes,bytes,bytes)", abi.encode(id));
        _mock(p, "delegate(uint64)", abi.encode(typical));
        _mock(p, "undelegate(uint64,uint256,uint8)", abi.encode(typical));
        _mock(p, "withdraw(uint64,uint8)", abi.encode(typical));
        _mock(p, "compound(uint64)", abi.encode(typical));
        _mock(p, "claimRewards(uint64)", abi.encode(typical));
        _mock(p, "changeCommission(uint64,uint256)", abi.encode(typical));
        _mock(p, "externalReward(uint64)", abi.encode(typical));
        // getValidator: address, uint64, eight uint256, then two empty bytes (offsets 0x180 and 0x1a0, length 0).
        _mock(
            p,
            "getValidator(uint64)",
            bytes.concat(
                abi.encode(address(uint160(id)), uint64(0), amount, amount / 1e6, uint256(0), uint256(0)),
                abi.encode(amount, uint256(0), amount, uint256(0), uint256(0x180), uint256(0x1a0), uint256(0), uint256(0))
            )
        );
        _mock(p, "getDelegator(uint64,address)", abi.encode(amount, amount / 1e6, uint256(0), uint256(0), uint256(0), uint64(0), uint64(0)));
        _mock(p, "getWithdrawalRequest(uint64,address,uint8)", abi.encode(amount, amount / 1e6, uint64(0)));
        _mock(p, "getConsensusValidatorSet(uint32)", abi.encode(true, uint32(0), ids));
        _mock(p, "getSnapshotValidatorSet(uint32)", abi.encode(true, uint32(0), ids));
        _mock(p, "getExecutionValidatorSet(uint32)", abi.encode(true, uint32(0), ids));
        _mock(p, "getDelegations(address,uint64)", abi.encode(true, uint64(0), ids));
        _mock(p, "getDelegators(uint64,address)", abi.encode(true, address(0), delegators));
        _mock(p, "getEpoch()", abi.encode(uint64(typical ? 100 : 0), false));
        _mock(p, "getProposerValId()", abi.encode(id));
    }

    function _mock(address p, string memory signature, bytes memory answer) private {
        VM.mockCall(p, abi.encodeWithSignature(signature), answer);
    }

    /// No code, and an input the real precompile answers with data (or refuses) succeeds with no data: the
    /// account is empty here. An EVM that has the precompile (a Monad build of forge, say) is not flagged.
    function _missing(address p) private view returns (bool) {
        if (p.code.length != 0) return false;
        (bool ok, bytes memory ret) = p.staticcall(_knownAnswer(p));
        return ok && ret.length == 0;
    }

    /// Inputs the Monad precompiles answer with 32 bytes or more (checked by eth_call on Monad mainnet): a valid
    /// P256 signature (verifies to 1), getEpoch() and dippedIntoReserve(). Empty for an address not listed.
    function _knownAnswer(address p) private pure returns (bytes memory) {
        if (p == address(0x0100)) {
            return hex"bb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca6050232ba3a8be6b94d5ec80a6d9d1190a436effe50d85a1eee859b8cc6af9bd5c2e184cd60b855d442f5b3c7b11eb6c4e0ae7525fe710fab9aa7c77a67f79e6fadd762927b10512bae3eddcfe467828128bad2903269919f7086069c8c4df6c732838c7787964eaac00e5921fb1498a60f4606766b3d9685001558d1a974e7341513e";
        }
        if (p == address(0x1000)) return hex"757991a8";
        if (p == address(0x1001)) return hex"3a61584e";
        return "";
    }
}

/// Event files under sf-events/ (the only path fs_permissions lets forge write): one line per discarded input,
/// the running test's selector first. Shared by both suites; the runner counts them per property.
library SfEvents {
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// forge calls setUp and every test from the run's sender, so there msg.sender is tx.origin. A vault that
    /// calls back into the test contract makes itself msg.sender, never an EOA. Entry points and event writers
    /// refuse such a call, so a vault cannot plant events or run part of a property inside its own call.
    function notReentered() internal view {
        if (msg.sender != tx.origin) revert("specfirst: re-entered from inside a vault call");
    }

    /// Appends "<selector of the running test><extra>" to sf-events/<SF_RUN_ID>.<kind>.log. No-op when SF_RUN_ID
    /// is unset.
    function write(string memory kind, string memory extra) internal {
        notReentered();
        string memory runId = VM.envOr("SF_RUN_ID", string(""));
        if (bytes(runId).length == 0) return;
        VM.writeLine(string.concat("sf-events/", runId, ".", kind, ".log"), string.concat(VM.toString(abi.encodePacked(msg.sig)), extra));
    }

    /// An input of the property not judged because its vault call reached a Monad precompile this fork lacks
    /// and could not be judged on its revert (SfForkGaps.precompileCause).
    function missingPrecompile(address p) internal {
        write("missing-precompile", string.concat(" ", VM.toString(p)));
    }

    /// The same in a setup deposit (setUpVault, or the deposit that gives shares): the property never ran on
    /// that input, so the runner counts it as a rejected input, not as an unjudged one.
    function setupPrecompile(address p) internal {
        write("setup-precompile", string.concat(" ", VM.toString(p)));
    }
}

/// EIP-4626 says maxDeposit, maxMint, maxWithdraw and maxRedeem return the most the matching call accepts
/// "and not cause a revert", and that they MUST return 0 when the action is disabled. The a16z suite calls
/// the vault through a helper that discards reverting inputs with vm.assume(false), so a vault whose
/// withdraw always reverts while maxWithdraw reports a balance never fails there; it only runs out of
/// inputs. These properties call the action directly and fail when it reverts within the advertised max.
/// To avoid false alarms: amounts that preview to zero shares or assets are discarded (reverting on a
/// zero-share deposit is common and not what these check), a max of 0 discards the input (0 is the honest
/// answer for a disabled action; each such discard is recorded so the runner can report a property whose
/// max was always 0 as not applicable), and a failed setup step (funding, approve, the deposit that gives
/// the user shares) discards the input too. Users come from the same salted 16-address pool as the harness.
/// Two more rules keep other causes off the max properties. An amount below the bound min(max, cap) that
/// reverts is tried again at the bound: EIP-4626 constrains max as an upper bound of what is accepted, so when
/// the bound goes through the input is discarded and counted, and when it reverts too the property fails. And
/// a revert that needed a precompile Monad has and this fork lacks (SfForkGaps.precompileCause) leaves that input
/// unjudged with an event; other inputs keep being judged, and the runner never reports a property with an
/// unjudged input as a pass (a fail elsewhere stays a fail, otherwise it is inconclusive).
contract SpecfirstMaxHonored is Test {
    using stdStorage for StdStorage;

    uint256 internal constant USER_POOL = 16;
    address internal vault;
    address internal asset;
    uint256 internal cap;
    uint256 internal poolSalt;

    function setUp() public virtual {
        SfEvents.notReentered();
        vault = vm.envAddress("SF_VAULT");
        asset = ISfVault(vault).asset();
        cap = 1_000_000 * 10 ** uint256(_decimalsOr18(asset));
        poolSalt = vm.envOr("SF_POOL_SALT", uint256(keccak256("specfirst.erc4626.pool")));
        _probeAssetTransfers();
    }

    /// Same probe as the upstream harness: pool members 0 and 1 try to move one whole token of the asset,
    /// the state is restored, and a refusal ends setUp with the fixed prefix the runner reports as not
    /// applicable. When no balance can be given at all, the probe steps aside.
    function _probeAssetTransfers() internal {
        address from = _poolMember(0);
        address to = _poolMember(1);
        uint256 amount = cap / 1_000_000;
        uint256 snap = vm.snapshotState();
        bool given = _tryGive(from, amount);
        bool ok;
        bytes memory ret;
        if (given) {
            vm.prank(from);
            (ok, ret) = asset.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        }
        vm.revertToStateAndDelete(snap);
        if (given && !(ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool)))))) {
            revert(string.concat("specfirst: asset transfers are restricted for test users (", _refusal(ok, ret), ")"));
        }
    }

    function _tryGive(address to, uint256 amount) internal returns (bool) {
        try this.__sfGiveDeal(to, amount) {
            return true;
        } catch {}
        try this.__sfGivePacked(to, amount) {
            return true;
        } catch {
            return false;
        }
    }

    function _refusal(bool ok, bytes memory ret) internal pure returns (string memory) {
        if (ok) return "transfer returned false";
        return _selectorOf(ret);
    }

    function _poolMember(uint256 index) internal view returns (address) {
        return address(uint160(uint256(keccak256(abi.encode(poolSalt, index)))));
    }

    /// deposit(a) for 0 < a <= min(maxDeposit, cap) with previewDeposit(a) > 0 must not revert.
    function test_sf_maxDeposit_honored(uint256 who, uint256 amount) public {
        address u = _user(who);
        uint256 max = _read(abi.encodeCall(ISfVault.maxDeposit, (u)));
        _discardIfZero(max);
        uint256 hi = max < cap ? max : cap;
        uint256 a = bound(amount, 1, hi);
        vm.assume(_read(abi.encodeCall(ISfVault.previewDeposit, (a))) > 0);
        _fund(u, a);
        (bool ok, bytes memory ret) = _callVault(u, abi.encodeCall(ISfVault.deposit, (a, u)));
        if (ok) return;
        if (a < hi) _discardIfAcceptedAt(u, abi.encodeCall(ISfVault.deposit, (hi, u)), hi);
        _failMax(ret, "deposit", a, "maxDeposit", max);
    }

    /// mint(s) for 0 < s <= min(maxMint, shares of cap) with previewMint(s) > 0 must not revert.
    function test_sf_maxMint_honored(uint256 who, uint256 shares) public {
        address u = _user(who);
        uint256 max = _read(abi.encodeCall(ISfVault.maxMint, (u)));
        _discardIfZero(max);
        uint256 capShares = _read(abi.encodeCall(ISfVault.convertToShares, (cap)));
        uint256 hi = max < capShares ? max : capShares;
        vm.assume(hi > 0);
        uint256 s = bound(shares, 1, hi);
        uint256 need = _read(abi.encodeCall(ISfVault.previewMint, (s)));
        vm.assume(need > 0 && need <= 2 * cap);
        // Twice what previewMint quotes plus one whole token: a mint that pulls more than its quote is
        // test_previewMint's finding, and must not fail here for lack of funds.
        _fund(u, _mintFunding(need));
        (bool ok, bytes memory ret) = _callVault(u, abi.encodeCall(ISfVault.mint, (s, u)));
        if (ok) return;
        if (s < hi) {
            (bool quoted, uint256 needHi) = _tryRead(abi.encodeCall(ISfVault.previewMint, (hi)));
            if (quoted && needHi <= 2 * cap) _discardIfAcceptedAt(u, abi.encodeCall(ISfVault.mint, (hi, u)), _mintFunding(needHi));
        }
        _failMax(ret, "mint", s, "maxMint", max);
    }

    /// After a deposit, withdraw(a, u, u) for 0 < a <= maxWithdraw(u) must not revert.
    function test_sf_maxWithdraw_honored(uint256 who, uint256 deposited, uint256 amount) public {
        address u = _user(who);
        _holdShares(u, deposited);
        uint256 max = _read(abi.encodeCall(ISfVault.maxWithdraw, (u)));
        _discardIfZero(max);
        uint256 a = bound(amount, 1, max);
        (bool ok, bytes memory ret) = _callVault(u, abi.encodeCall(ISfVault.withdraw, (a, u, u)));
        if (ok) return;
        if (a < max) _discardIfAcceptedAt(u, abi.encodeCall(ISfVault.withdraw, (max, u, u)), 0);
        _failMax(ret, "withdraw", a, "maxWithdraw", max);
    }

    /// After a deposit, redeem(s, u, u) for 0 < s <= maxRedeem(u) with previewRedeem(s) > 0 must not revert.
    function test_sf_maxRedeem_honored(uint256 who, uint256 deposited, uint256 shares) public {
        address u = _user(who);
        _holdShares(u, deposited);
        uint256 max = _read(abi.encodeCall(ISfVault.maxRedeem, (u)));
        _discardIfZero(max);
        uint256 s = bound(shares, 1, max);
        vm.assume(_read(abi.encodeCall(ISfVault.previewRedeem, (s))) > 0);
        (bool ok, bytes memory ret) = _callVault(u, abi.encodeCall(ISfVault.redeem, (s, u, u)));
        if (ok) return;
        if (s < max) _discardIfAcceptedAt(u, abi.encodeCall(ISfVault.redeem, (max, u, u)), 0);
        _failMax(ret, "redeem", s, "maxRedeem", max);
    }

    /// Calls the vault as `u`. A revert that needed a precompile Monad has and this fork lacks
    /// (SfForkGaps.precompileCause) says nothing about the vault: that input is recorded and discarded, and the
    /// property goes on with others. Any other revert is returned for the caller to judge.
    function _callVault(address u, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(u);
        (ok, ret) = vault.call(data);
        if (!ok) _discardIfPrecompile(u, data, ret, false);
    }

    /// Discards the input when the revert cannot be judged (SfForkGaps.precompileCause), recording it as an
    /// unjudged input of the property, or as a rejected one when it happened in a setup deposit.
    function _discardIfPrecompile(address u, bytes memory data, bytes memory ret, bool setup) internal {
        address p = SfForkGaps.precompileCause(vault, u, data, ret);
        if (p == address(0)) return;
        if (setup) SfEvents.setupPrecompile(p);
        else SfEvents.missingPrecompile(p);
        vm.assume(false);
    }

    /// An amount below the bound reverted. The same action at the bound is tried with the state restored
    /// afterwards (deposit and mint are funded for it first, withdraw and redeem use the shares already
    /// held). When the bound goes through, the max held as an upper bound: the input is discarded and counted
    /// (below-bound). When the bound reverts too, or the retry cannot be set up, this returns and the caller
    /// fails: nothing here discards on its own, so a vault cannot turn a fail into a discard by making the
    /// retry's setup revert. A bound that needs a missing precompile is not judged (_callVault).
    function _discardIfAcceptedAt(address u, bytes memory atBound, uint256 funding) internal {
        uint256 snap = vm.snapshotState();
        bool ok;
        if (funding == 0 || _tryFund(u, funding)) (ok,) = _callVault(u, atBound);
        vm.revertToStateAndDelete(snap);
        if (!ok) return;
        _recordEvent("below-bound");
        vm.assume(false);
    }

    /// _fund without discarding: false when the balance or the approval cannot be set.
    function _tryFund(address u, uint256 amount) internal returns (bool) {
        if (!_tryGive(u, amount)) return false;
        vm.prank(u);
        (bool ok, bytes memory ret) = asset.call(abi.encodeWithSelector(0x095ea7b3, vault, amount));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    /// _read without discarding: false when the view call reverts or answers short.
    function _tryRead(bytes memory data) internal view returns (bool, uint256) {
        (bool ok, bytes memory ret) = vault.staticcall(data);
        if (!ok || ret.length < 32) return (false, 0);
        return (true, abi.decode(ret, (uint256)));
    }

    /// The property failed: the action reverted within the advertised max. The reason names the action, the
    /// amount, the raw revert selector and the max. It never carries revert text, so a vault cannot shape it.
    function _failMax(bytes memory ret, string memory action, uint256 amount, string memory maxName, uint256 max) internal pure {
        revert(string.concat(action, "(", vm.toString(amount), ") reverted with ", _selectorOf(ret), " while ", maxName, " is ", vm.toString(max)));
    }

    function _mintFunding(uint256 need) internal view returns (uint256) {
        return 2 * need + cap / 1_000_000;
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

    /// A max of 0 is the honest answer for a disabled action (and an underestimate EIP-4626 allows), so the
    /// input is discarded. The discard is recorded per property: when every discard of a property was a max
    /// of 0, the runner reports it as not applicable rather than inconclusive.
    function _discardIfZero(uint256 max) internal {
        if (max != 0) return;
        _recordEvent("max-zero");
        vm.assume(false);
    }

    function _recordEvent(string memory kind) internal {
        SfEvents.write(kind, "");
    }

    /// Deposits a bounded amount for `u` so it holds shares. Setup only: a maxDeposit of 0 does not stop it (the
    /// cap is tried, as in the upstream harness), so a vault that reports 0 everywhere still gets its
    /// maxWithdraw and maxRedeem looked at. When that amount is refused, one whole token (or the max when it is
    /// smaller) is tried, so a vault that only refuses large deposits (one that stakes them through a
    /// precompile the fork lacks, say) still has its withdraw and redeem judged. When neither goes through the
    /// input is discarded, and recorded as a setup reject when the refusal reached a missing precompile.
    function _holdShares(address u, uint256 amount) internal {
        uint256 maxDep = _read(abi.encodeCall(ISfVault.maxDeposit, (u)));
        uint256 hi = maxDep > 0 && maxDep < cap ? maxDep : cap;
        uint256 a = bound(amount, 1, hi);
        (bool ran, bool ok, bytes memory ret) = _tryDeposit(u, a);
        if (ok) return;
        uint256 unit = cap / 1_000_000 < hi ? cap / 1_000_000 : hi;
        if (a > unit) {
            a = unit;
            (ran, ok, ret) = _tryDeposit(u, a);
            if (ok) return;
        }
        if (ran) _discardIfPrecompile(u, abi.encodeCall(ISfVault.deposit, (a, u)), ret, true);
        vm.assume(false);
    }

    /// Funds `u` with `a` and deposits it as `u`. ran is false when previewDeposit(a) is 0 or reverts, and then
    /// nothing is called.
    function _tryDeposit(address u, uint256 a) internal returns (bool ran, bool ok, bytes memory ret) {
        (bool quoted, uint256 shares) = _tryRead(abi.encodeCall(ISfVault.previewDeposit, (a)));
        if (!quoted || shares == 0) return (false, false, ret);
        _fund(u, a);
        vm.prank(u);
        (ok, ret) = vault.call(abi.encodeCall(ISfVault.deposit, (a, u)));
        ran = true;
    }

    /// A view call on the vault; a revert or a short answer discards the input.
    function _read(bytes memory data) internal view returns (uint256) {
        (bool ok, bytes memory ret) = vault.staticcall(data);
        vm.assume(ok && ret.length >= 32);
        return abi.decode(ret, (uint256));
    }

    /// First call of every property: also refuses to run when called back from inside a vault call.
    function _user(uint256 who) internal view returns (address u) {
        SfEvents.notReentered();
        u = _poolMember(who % USER_POOL);
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
