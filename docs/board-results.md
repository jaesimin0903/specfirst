# Monad ERC-4626 전수 검사 결과

작성 2026-09-30, 갱신 2026-10-07. 방법과 결정은 `docs/adr/0003-third-party-standard-properties.md`, 증명은 `docs/adr/0004-check-attestation-registry.md`, 자동 감지와 재검사는 `docs/adr/0006-chain-as-entry-point.md`, 할당 게이트는 `docs/adr/0007-allocation-gate.md`. 처음 6개 구현으로 한 스파이크는 `docs/spike-standard-properties.md`.

바로 아래가 2026-10-07 현황이다. 그 아래 "첫 전수 검사 (2026-09-30)"는 9/30 기록을 그대로 둔 것이다.

## 2026-10-07 현황

기준은 현황판 빌드 `packages/web/data/board.json`(2026-10-07 08:42 UTC)과 `certs/checks/143/`의 결과 파일이다. 시각은 모두 UTC.

### 범위

- Monad 메인넷(143)의 ERC-4626 볼트 402개, 구현 키 기준 34개 구현. 볼트마다 가장 나중 블록의 결과 파일 하나를 쓴다. 모든 결과가 속성 30개, 속성당 16회다.
- 285개는 9/30 첫 전수 검사의 수작업 목록이다. 이 중 199개는 아직 블록 109195820 결과가 최신이고, 86개는 그 뒤 watcher 재검사나 데스크 요청으로 더 나중 블록의 결과가 있다.
- 117개는 watcher(`specfirst watch`, ADR 0006)가 메인넷 로그에서 스스로 찾은 볼트다. 수작업 목록에는 없었다. watcher는 팩토리의 볼트 생성 이벤트, 모르는 주소의 첫 `Deposit`, 아는 볼트의 `Upgraded`와 `BeaconUpgraded`를 읽는다. 117개 중 116개는 첫 `Deposit` 신호로, 1개는 Morpho VaultV2Factory 이벤트로 찾았다.
- 현황판의 프로토콜, 이름, 기초자산 메타데이터(`vault-meta.json`)는 첫 285개만 담고 있어서 117개는 "Unknown protocol"로 나온다. 아래에 적은 프로토콜 이름은 소스와 기초자산으로 따로 확인한 것이다.

### 결과

| 분류 | 볼트 | 9/30 목록 285개 | watcher 117개 |
|---|---|---|---|
| 30개 전부 통과 | 191 | 174 | 17 |
| EIP-4626 불일치 | 7 | 3 | 4 |
| 일부 확인. 9/30의 "일부 확인"과 "검사 불가"를 합친 값 | 194 | 100 | 94 |
| 적용 불가 | 10 | 8 | 2 |

- 285개의 분류는 9/30과 같다. 86개가 다시 검사됐지만 분류가 바뀐 볼트는 없다.
- 속성 단위 합계는 pass 7,802, fail 16, inconclusive 3,456, not applicable 786이다(402 x 30 = 12,060).
- 새 적용 불가 2개: aprMON 0x0c65A0BC65a5D819235B71F554D210D3F80E0852(ERC-7535 네이티브 자산 볼트, 아래 locked.aprMON의 기초자산)과 0xB483252De6c4CD540Bb964b6D5Ec9aE61F033a8d(ERC-7575, 지분이 별도 토큰).
- 판정 불가와 적용 불가의 사유별 볼트 수(`board.json`의 `reasons`, 한 볼트에 여럿일 수 있음): max가 0이라 확인할 대상이 없음 185, 모든 입력 거부 129, 테스트 잔액을 만들 수 없는 기초자산 11, 기초자산 송금이 허가제 4, 지분이 별도 토큰 4, 네이티브 자산 2, fork에 없는 Monad precompile 1.

### MUST와 SHOULD

2026-10-07부터 현황판은 실패마다 그 속성이 옮긴 EIP-4626 문장의 수준을 붙인다. 근거는 `@specfirst/core`의 `ERC4626_PROPERTY_LEVELS`이고, 속성마다 EIP 문장을 인용한다.

- SHOULD는 10개다. 왕복 속성 `RT-*` 8개(보안 고려사항의 "볼트에 유리하게" 반올림 권고)와 `withdraw-zero-allowance`, `redeem-zero-allowance`(withdraw와 redeem은 호출자가 소유자의 지분을 쓸 수 있는지 "SHOULD check")다. 나머지 20개는 MUST다.
- withdraw와 redeem의 실패는 사유가 무엇이든 MUST로 센다. 사유 문자열은 볼트가 revert 데이터로 직접 쓸 수 있으므로, 사유를 보고 수준을 낮추면 볼트가 자기 판정을 고를 수 있다. allowance를 확인하지 않는 볼트는 zero-allowance 속성 두 개에서 따로 잡힌다.
- "Rounding favors caller" 라벨은 실패가 모두 왕복 속성이고, 로그에 남은 값 쌍마다 차이가 max(2 기초 단위, 금액의 1bp) 이내일 때만 붙는다. 그보다 크면 SHOULD 실패로 크기를 적고, MUST가 하나라도 있으면 MUST 불일치로 적는다.
- 수준은 결과 파일에 없다. EIP를 읽은 해석이지 실행한 내용이 아니므로 reportHash와 suiteHash는 그대로다. API의 `badge.state`는 계속 `mismatch`이고 `badge.level`이 `must` 또는 `should`를 준다.
- 불일치 7건 중 6건이 MUST, 1건(tyYIELD)이 SHOULD다.

### EIP-4626 불일치 7건

취약점이 아니라 명세 문장과의 불일치다. 자금 손실로 이어진다는 주장은 하지 않는다. 블록, 개수, 금액은 각 볼트의 최신 결과 파일 `certs/checks/143/<소문자 주소>/<블록>-<해시 앞 8바이트>.json`에서 가져왔다.

| 볼트 | 최신 결과 (블록, pass, fail, inconclusive) | 실패한 속성 | 수준 | 찾은 경로 | 증명 |
|---|---|---|---|---|---|
| Upshift earnAUSD 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E | 111224893, 16, 2, 12 | sf-maxWithdraw-honored, sf-maxRedeem-honored | MUST | 첫 전수 검사 | 15 (블록 109195820) |
| Aarna atvYieldMax 0x4C09558A0d000240726679fC3805c3918922d6C6 | 111224650, 16, 2, 12 | sf-maxWithdraw-honored, sf-maxRedeem-honored | MUST | 첫 전수 검사 | 12 (블록 109195820) |
| Euler EVK eeUSD-4 0xf26dC2F1FE883b11Dd56700db594DfC32Eee95Bf | 109195820, 0, 2, 28 | sf-maxDeposit-honored, sf-maxMint-honored | MUST | 첫 전수 검사 | 3 (블록 109195820) |
| Curvance hyAUSD 0xaD663aC84052b52BE4ed1b27BA416505e84a00Bf | 111264228, 25, 5, 0 | previewDeposit, previewMint, previewWithdraw, previewRedeem, sf-maxRedeem-honored | MUST | watcher, 첫 Deposit 신호 | 25 (블록 111264228) |
| LeverUp sLVMON 0x61b29EfEf2E6f866bA4AaeFDb87d2837C6a22b9c | 111261045, 29, 1, 0 | sf-maxWithdraw-honored | MUST | watcher, 첫 Deposit 신호 | 23 (블록 111261045) |
| locked.aprMON 0x79b0D94d84D1EE1021E0077E6cD36091e28276c5 | 111193713, 16, 2, 12 | sf-maxWithdraw-honored, sf-maxRedeem-honored | MUST | watcher, 첫 Deposit 신호 | 없음 |
| tyYIELD 0xB4641064f64E2F3aAffc1b4b4A66BE75c1C81408 | 111263642, 28, 2, 0 | RT-redeem-deposit, RT-withdraw-deposit | SHOULD | watcher, 첫 Deposit 신호 | 24 (블록 111263642) |

watcher가 찾은 4건은 사람이 요청하거나 목록에 넣지 않았다. watcher가 감지하고 검사했고, 나중 블록의 두 번째 검사로 확인했다. 증명은 4건 중 3건만 썼다(아래 locked.aprMON).

1. **Upshift earnAUSD**: 최신 결과는 10/7 개정 하네스로 블록 111224893에서 다시 돌린 것이다. withdraw(609877786695)가 `WithdrawalRequestRequired()`(0x75ed2e3e)로 revert하는데 maxWithdraw는 609877786697이고, redeem(606678772776)도 같은 선택자로 revert하는데 maxRedeem은 606678772778이다. 결과 파일의 `traits`에 `async-redeem`이 있고, 근거는 구현 0xFd2F793C248Dd673C830DF610a95a045054de267 코드의 `requestRedeem(uint256,address,address)`와, 이 검사에서 출금과 상환이 모두 거부됐다는 사실이다. ERC-165는 없다. 라벨은 맥락일 뿐 판정을 바꾸지 않는다. ERC-7540도 요청이 이행되기 전에는 maxWithdraw와 maxRedeem이 0이어야 한다. 증명 15는 9/30의 109195820 결과이고 상태는 같다(16, 2, 12, 같은 두 속성).
2. **Aarna atvYieldMax**: 111224650에서 withdraw(1)이 `WithdrawalsArePaused()`(0xe14e66da)로 revert하는데 maxWithdraw는 1이고, redeem(570423147573313396473286882)도 같은 선택자로 revert하는데 maxRedeem은 1369348649911548012000000000이다. 9/30과 같은 모양이다. 증명 12는 109195820 결과다.
3. **Euler EVK eeUSD-4**: 최신 결과가 9/30의 109195820이다. deposit(10)과 mint(10)이 볼트 훅의 `NotAuthorized()`(0xea8e4eb5)로 revert하는데 maxDeposit과 maxMint는 5192296858534827628530496329220095다. 증명 3.
4. **Curvance hyAUSD**: 프록시가 아닌 `LendingOptimizer`(Sourcify exact match, 이름 "High Yield AUSD Vault"), 기초자산 AUSD(소수 6자리)이고, 예치를 Curvance cToken 시장 두 곳에 나눠 넣는다. preview 함수 네 개는 캐시된 `_totalAssets`로 계산하고, deposit, mint, withdraw, redeem은 먼저 accrual로 그 값을 시장 잔액에 다시 맞춘 뒤 cToken 반올림 손실을 더해 계산한다.
   - 111264228의 로그: deposit이 지분 13을 발행했는데 previewDeposit은 15, mint가 자산 19를 가져갔는데 previewMint는 17, withdraw가 지분 4035를 태웠는데 previewWithdraw는 4034, redeem이 자산 20255를 줬는데 previewRedeem은 20257이다. redeem(1)은 `LendingOptimizer__ZeroAmount()`(0x03f7f64c)로 revert하는데 maxRedeem은 1이다. 시장별 왕복 보정이 두 시장 몫을 모두 0으로 만드는 지분 1개 경계다.
   - sf-maxWithdraw-honored는 상태에 따라 달라진다. 111049828, 111104901, 111262603 결과에서는 withdraw(maxWithdraw)가 `InsufficientBalance()`(0xf4d678b8)로 revert해 fail이었고(111262603: withdraw(510956818428), maxWithdraw 510956818428), 다른 블록에서는 통과했다. 소스 주석이 "not a guarantee that `withdraw(maxWithdraw(owner))` will succeed after cToken rounding loss"라고 적는다.
   - 10/6 결과의 sf-maxDeposit-honored, sf-maxMint-honored fail은 하네스가 preview의 불일치를 max 속성에 돌린 것이었다(deposit(3)은 지분 0개라 최소 금액 거부, mint(58)은 previewMint 59보다 많은 61을 가져가려다 자금 부족). 10/7 하네스 수정(mint 자금을 previewMint의 두 배로, 상한 아래 거부는 상한으로 다시 시도)으로 사라졌다.
   - watcher는 10/6 블록 110398359의 첫 Deposit으로 찾았다. 네 번의 검사가 실패 속성 목록에서 일치하지 않아 "unstable"로 기록됐고, 10/7 111263418과 111264228 두 검사가 일치해 증명 25(07:29:18)를 썼다.
5. **LeverUp sLVMON**: EIP-1967 프록시, 구현 0x74420EF0Df3996d1DFcC1DD697c573aD655156A5(Monadscan Exact Match `SLVMON`, OpenZeppelin ERC4626Upgradeable v4 기반), 기초자산 LVMON 0x91b81bfbe3A747230F0529Aa28d8b2Bc898E6D56. `withdrawalFeeRate`가 5(0.05%)다. previewWithdraw는 수수료를 더한 총액으로 지분을 계산하는데 maxWithdraw는 OZ 기본값 `convertToAssets(balanceOf(owner))`로 수수료를 빼지 않는다. 그래서 maxWithdraw 근처의 withdraw는 보유 지분보다 많이 태우려다 "ERC20: burn amount exceeds balance"로 revert한다.
   - 111261045: withdraw(64811891803559577220801)가 `Error(string)`(0x08c379a0)로 revert하는데 maxWithdraw는 64811891803559577220802다. 증명 23(07:13:09).
   - forge를 거치지 않은 확인: 블록 111069625에서 새 주소에 지분 296766653024899270194를 state override로 주고 eth_call하면 maxWithdraw는 999999999999999999998인데 withdraw(999499999999999999999)가 지분 전부를 태우며 성공하고 withdraw(999500000000000000000)부터 revert한다. redeem(maxRedeem)은 성공한다.
   - 블록 111224893의 30 pass 결과(`111224893-a7f37f3bdddf13ec.json`)는 고쳐진 것이 아니었다. 그 시드의 퍼즈 입력은 maxWithdraw의 87.7%까지만 갔고, revert하는 구간은 maxWithdraw 바로 아래 0.05%다. 같은 블록에서도 실체인 eth_call로 withdraw(maxWithdraw)가 revert했다. 이후 sf 속성은 매 실행마다 상한 자체를 시도하고(sfPropertiesSha256 0xd84a0879에서 0x1d721e8b로), 같은 시드로 돌린 111261045가 fail이다. watcher는 111224893 결과를 확인 대기로 두었다가 다음 검사가 그것을 확인하지 않자 실패를 증명했다(피드: "the change pending since block 111224893 was not confirmed; attesting [fail]").
6. **locked.aprMON**: EIP-1967 프록시, 구현 0x803190A1ea9606C9E49bF889Cc4745Cb38524a83(검증된 소스 없음), 이름 "Locked aPriori Monad LST", 기초자산 aprMON 0x0c65A0BC65a5D819235B71F554D210D3F80E0852. `LOCK_PERIOD()`가 1296000초(15일)이고, 예치할 때마다 잔액 전체의 잠금이 새로 시작한다. 요청형 출금 함수가 없어 `async-redeem` 라벨은 붙지 않는다.
   - 111193713: withdraw(1719)와 redeem(1719)이 0x23c85ecd로 revert하는데 maxWithdraw와 maxRedeem은 948377805652677803591669다. 선택자는 `LockNotExpired(address,uint256)`과 일치한다.
   - 실제 보유자 확인: 블록 111228336에서 EOA 0x682c98f9ecc13075cb460b6069db63e7cf9684ec는 잔액, maxRedeem, maxWithdraw가 모두 6667180431498758144이고, redeem(maxRedeem)과 withdraw(maxWithdraw)가 `LockNotExpired`로 revert한다. 잠금이 풀린 시각부터는 max 값대로 출금된다(fork에서 확인).
   - 최신 결과는 10/7 개정 전 하네스(harnessSha256 0x5b48d421)로 만든 것이다. 개정 하네스로 111228336에서 CLI로 다시 돌린 결과(저장소에 넣지 않음)도 16 pass, 2 fail, 12 inconclusive로 같은 두 속성이 fail이었다.
   - 증명하지 않았다. 확인된 실패는 10/7 01:36에 기록됐는데 그때 watcher는 증명 없이 돌고 있었고(피드 사유 `not attested [no-attest]`), 증명을 켠 뒤에는 팩토리가 알리지 않은 후보의 실패에 쓰는 하루 3건 예산을 23, 24, 25가 다 썼다(`status.json`의 `candidateFailsUsedToday` 3/3).
7. **tyYIELD**: 프록시가 아닌 12,041바이트 계약, 검증된 소스 없음. 이름 "Ticker Yield", 소수 12자리, 기초자산 USDC 0x754704Bc059F8C67012fEd69BC8A327a5aafb603. 예치금을 전략 래퍼 0xC554aFfE2f581F5E0811e0D42D484ECaC5c6B8e2("Wrapped Aave Monad USDC")에 넣는데, 이 래퍼의 withdraw가 전략 지분을 올림으로 태워 생기는 1 단위 손실을 tyYIELD가 나가는 사람이 아니라 남은 보유자에게 남긴다. 볼트가 거의 비어 있어(111224893에서 totalAssets 469) 그 손실이 지분 가격을 움직이고, 그래서 왕복이 호출자에게 유리하게 끝난다.
   - 111263642: RT-redeem-deposit은 지분 144907523788424795와 144907523788410169(차이 14626), RT-withdraw-deposit은 56500900과 56495691(차이 5209)이다. 둘 다 금액의 1bp 안이라 현황판 라벨은 "Rounding favors caller", 수준은 SHOULD다. preview 네 개와 max 네 개는 통과한다. 증명 24(07:26:28).
   - 111224893에서는 같은 흐름을 Monad eth_call(state override)로 돌려 fork와 같은 값을 얻었다. 111232861에서는 같은 단일 사용자 흐름이 볼트에 유리하게 끝났다. Aave 인덱스가 블록마다 바뀌어 반올림이 떨어지는 자리가 달라진다.
   - 10/6 결과(111041054)의 sf-maxDeposit-honored, sf-maxMint-honored fail은 deposit(1)과 mint(44)의 `ZeroShares()`(0x9811e0c7), 즉 최소 금액 거부였다. 상한 아래 거부를 상한으로 다시 시도하는 10/7 규칙 뒤로는 나오지 않는다.

### 하네스 메모

10/7 하네스 개정은 ADR 0003에 있다. fork에 없는 Monad precompile에 닿은 호출의 revert는 판정하지 않고, 판정하지 않은 입력이 하나라도 있는 속성은 pass가 될 수 없다. mint 자금은 previewMint의 두 배와 토큰 한 개, 상한 아래 금액의 revert는 상한으로 다시 시도, sf 속성은 매 실행마다 상한 자체도 시도한다. 결과 파일은 schemaVersion 4이고 `traits`를 담는다. 각 결과 파일에 harnessSha256과 sfPropertiesSha256이 있어 어느 판으로 만든 결과인지 알 수 있다.

- **gMON 0x8498312A6B3CbD158bf0c93AbdCF29E6e4F55081 (Magma)**: 최신 111261261은 30개 모두 inconclusive, `skipReason: "missing-precompile"`. 예치가 CoreVault 0xB1d57De83D80a2AbAc91714744DFE97e71B73dC0을 거쳐 Monad 스테이킹 precompile 0x1000의 `delegate(78)`을 부른다. forge의 EVM에는 Monad precompile(P256 0x0100, 스테이킹 0x1000, 예비 잔액 확인 0x1001)이 없어서, fork에서는 그 주소가 빈 계정이고 호출이 데이터 없이 성공한 뒤 볼트가 데이터 없이 revert한다. Monad에서 같은 예치를 state override eth_call로 보내면 previewDeposit만큼 지분을 돌려준다. 10/6 결과는 2 fail(sf-maxDeposit-honored, sf-maxMint-honored, "no revert data"), 28 inconclusive였고, 개정 뒤에는 그 입력들이 판정되지 않아 0 fail이 됐다. watcher는 이를 "recovered"로 기록했고 증명은 쓰지 않았다. 구현 0xA1f511E1442c61931ca5ace7616d2cC78497aFd2에 `requestRedeem`이 있고 ERC-165로 asyncRedeem을 알려 `async-redeem` 라벨이 붙지만, fork에서 예치가 막혀 출금 쪽은 실행되지 않았다.
- **gcvAUSD 0xab3CB7b3b28366eD7f6C59DbD2D708890919B289**: 10/7 01:25와 01:49에 시작한 검사(블록 111192258, 111196887, 개정 전 하네스)는 14 pass, 2 fail, 14 inconclusive였다. deposit(10)과 mint(10)이 0x96ec8e54로 revert하는데 maxDeposit과 maxMint가 2^256-1이라는 fail이었다. 개정 하네스는 상한 아래 금액이 revert하면 상한으로 다시 시도하는데 상한은 받아들여졌다("10 amounts below the bound were refused; the bound itself was accepted"). 작은 금액의 거부는 max 문장과 무관하므로 하네스의 거짓 양성이었다. 최신 111262020은 16 pass, 0 fail, 14 inconclusive이고, 그동안 증명은 쓰지 않았다.
- 9/30 결과 199개는 개정 전 하네스로 만든 것이다. 다시 돌리면 sf 속성 결과가 달라질 수 있다.

### 온체인 증명

Monad 테스트넷(10143) `CheckAttestationRegistry` 0x3754918bBB8481D046D80718a9efe434e353daF7에 증명 28건(id 0~27)이 있다(현황판 빌드가 08:42 UTC에 읽은 값).

| id | 내용 |
|---|---|
| 0~17 | 9/30 첫 전수 검사의 17개 볼트. 17이 0을 대체 |
| 18, 19 | 9/30 데스크 요청 2건, Node Ag USDC 0xf5BC68C6e5825FEAe99B8018F62a595Cf745e297와 EVK eUSDC-7 0x5792753b66Eb5213E416755546abBcC1AEF1008A |
| 20 | 10/6 watcher, Morpho VaultV2Factory가 알린 볼트 0xdE16452C1f8CC209D8E9b104b7F240D9A251768B (26 pass, 4 not applicable) |
| 21, 22 | 10/6 테스트넷 데모 볼트 0x1c2e1FEC75375Aaa7e39C85A6d599AB913C38029, 22가 21을 대체 |
| 23, 24, 25 | 10/7 watcher, 메인넷 불일치 sLVMON, tyYIELD, hyAUSD |
| 26, 27 | 10/7 테스트넷 데모 볼트 0xC6dd99dC547a1dA35Bd777eA5CEe5c080667db47, 27이 26을 대체 (아래 테스트넷 실행) |

- 메인넷 현황판 볼트에 관한 증명은 24건이고, 볼트 23개가 최신 증명을 갖고 있다(id 0은 같은 볼트의 17로 대체됨). `isCompliant`는 15개가 참, 8개가 거짓이다. 거짓 8개는 불일치 볼트 6개와 적용 불가가 섞인 Morpho Vault V2 2개(id 1, 20)다. 나머지 4건은 테스트넷 데모 볼트에 관한 것이다.
- 불일치 7건 중 locked.aprMON만 증명이 없다.
- Upshift(15)와 Aarna(12)의 증명은 109195820 결과다. 현황판의 최신 결과는 더 나중 블록 파일이라 현황판은 증명된 보고서와 다른 파일이라고 표시한다(`matchesReport` false). 두 결과의 개수와 실패 속성은 같다.
- 발급자는 9/30 검사와 데스크가 0x1d93fFd65BD3C522766f1f5301660eec559D4D39, 메인넷 watcher가 0x02Bc7af72404C3FDEd57ceCF2b1d2255697d5488이다.

### 테스트넷 끝에서 끝까지 (2026-10-07)

Monad 테스트넷에서 실제 트랜잭션으로 감지, 검사, 증명, 알림, 할당, 출금을 한 번에 돌렸다. 사람이 보낸 트랜잭션은 구독, 볼트 배포, 게이트 할당, 손실 보내기, 버그 켜기이고, 감지, 검사, 증명, 알림, 출금은 watcher와 키퍼가 했다.

| 시각 | 블록 | 일 |
|---|---|---|
| 08:26:54 | 68922607 | `DemoVaultFactory`로 DemoVault 0xC6dd99dC547a1dA35Bd777eA5CEe5c080667db47 배포 |
| 08:27:03 | | watcher가 팩토리 이벤트로 감지 |
| 08:27:12 | | 30 pass, 증명 26 (`factory` 클래스). 배포 18초 뒤 |
| 08:27:33 | 68922734 | AllocationGate 0xEE966282544FF5e0429e754856197A13b8340C8A가 60 토큰 할당. 증명 26이 준수라서 허용 |
| 08:29:12 | 68923057 | 운영자가 `setLoss` 300 bps로 볼트 자산의 3%를 밖으로 보냄 |
| 08:32:14 | 68923056~68923631 | 지분 가치 하락 3.00%를 두 번째 읽기로 확인, 구독자 webhook |
| 08:32:26 | 68923688 | 운영자가 `setBroken` on (previewDeposit이 실제 발행보다 1% 많은 지분을 약속) |
| 08:33:23 | 68923838 검사 | 구독 재검사에서 previewDeposit fail, 확인 대기 |
| 08:35:40 | 68924274 검사 | 두 번째 검사가 확인. 증명 27(26을 대체, 비준수)과 webhook |
| 08:35:50 | 68924353 | 키퍼 0x9ea88E8BB5916BdEA67a4cA43d4f9d5ecC30E86B(소유자 아님)가 exit. 지분 60을 redeem해 58.2 토큰 회수 |

- 버그를 켠 뒤 돈이 나올 때까지 3분 24초. 회수액 58.2는 60에서 3% 손실을 뺀 값이다.
- exit 가스 2,702,630, 102 gwei, 0.2757 MON. 키퍼 판정은 NotCompliant(증명 27), 경로는 redeem이다. 키퍼 로그의 서명 키 변수는 `REQUESTER_PRIVATE_KEY`다.
- 구독 2: 0.05 MON, 구독자 0x4E9EFE792438559b27a47E01b682026c71b3852b. 첫 검사(08:28:53), 가치 하락(08:32:14), 변경(08:35:40) webhook 세 번이 모두 HTTP 200으로 전달됐다.
- 구독 1은 실수로 만든 체인 143 구독이라 취소했다(정산 0.05, 환불 0). `subs subscribe`의 `--subject-chain` 기본값이 143이라서 생긴 일이고, 테스트넷 데모 볼트에는 `--subject-chain 10143`이 필요하다.

### 한계

- 결과는 볼트마다 한 블록, 한 시점이고 블록과 하네스 판이 볼트마다 다르다. 한도, 잠금, 일시정지, 캐시된 값이 바뀌면 결과도 바뀐다(hyAUSD의 sf-maxWithdraw, tyYIELD의 왕복).
- pass는 "이 30개 속성을 이 블록에서 속성마다 16회 동안 반례 없이 통과했다"는 뜻이고 안전 보증이 아니다. sLVMON처럼 퍼즈 입력이 실패 구간을 놓칠 수 있어서, sf 속성은 이제 상한 자체를 매번 시도한다.
- tyYIELD와 locked.aprMON은 검증된 소스가 없다. 구조는 선택자, 이벤트, trace, 호출 결과로만 확인했다. `LockNotExpired(address,uint256)`은 선택자가 일치하는 이름이다.
- fork에 없는 precompile을 쓰는 볼트(gMON)는 판정하지 못한다. 그런 입력은 inconclusive로 남고 pass로 바뀌지 않는다.
- 증명은 테스트넷에 있다. 메인넷 코드 해시와 구현은 발급자가 발급 직전에 다시 읽어 대조한 값이고, 누구나 기록된 블록과 시드로 재현해 확인할 수 있다.

## 첫 전수 검사 (2026-09-30)

작성 2026-09-30. 아래 숫자와 문장은 그날 기준이다. Upshift 항목의 `async-redeem` 라벨 설명만 2026-10-07에 덧붙였다.

### 범위와 방법

- Monad 메인넷(143)에서 체인 호출로 확인한 ERC-4626 볼트 285개. 출처는 Morpho API, Euler EVK 팩토리 목록, Curvance 문서, Neverland 저장소, monad-crypto/protocols, DefiLlama.
- 고정 블록 109195820, 볼트마다 속성 30개(a16z/erc4626-tests 26개와 Specfirst 고유 `sf-max*-honored` 4개), 속성당 16회, 하네스 버전 하나.
- 결과 파일 285개는 `certs/checks/143/<주소>/109195820-<reportHash 앞 8바이트>.json`. 각 파일에 시드와 발신 주소가 있어 `specfirst check <주소> --standard erc4626 --block 109195820 --runs 16 --seed <시드>`로 재현된다.

### 결과

| 분류 | 볼트 |
|---|---|
| 30개 전부 통과 | 174 |
| EIP-4626 불일치 | 3 |
| 일부 확인. 통과한 속성이 있지만 적용 불가나 판정 불가가 섞임 | 57 |
| 검사 불가. 모든 입력이 거부되거나 테스트 잔액을 만들 수 없어 통과한 속성이 없음 | 43 |
| 적용 불가. 스위트를 적용할 수 없는 볼트 | 8 |

현황판은 "일부 확인"과 "검사 불가"를 합쳐 100개로 보여준다.

구현 키 기준으로는 17개 구현이다. 볼트 수가 많은 구현은 Euler EVK 134, Morpho Vault V2 64, Morpho MetaMorpho V1.1 27, Curvance 24, Neverland 13이다.

"일부 확인"과 "검사 불가" 100개의 대부분은 두 부류다.
- **Morpho Vault V2**: 64개 중 58개가 a16z 26개를 모두 통과했다. V2는 max 함수 네 개가 모든 사용자에게 0을 돌려주므로 "max만큼은 실행돼야 한다"는 고유 속성이 확인할 대상이 없다. 그래서 52개는 고유 속성 4개가 모두 적용 불가이고, 6개는 2개가 적용 불가, 2개가 판정 불가다. EIP-4626은 과소평가를 허용하므로 위반이 아니다. 나머지 6개는 모든 입력이 거부돼 통과한 속성이 하나도 없다.
- **검사할 수 없는 상태의 볼트**: 예치가 막혀 있어 모든 입력이 거부된 볼트, 기초자산이 비표준이라 테스트 잔액을 쓸 수 없는 볼트(shMON, sMON, 래핑된 LST 등).

"적용 불가" 8개: ERC-7575처럼 지분이 별도 토큰인 Centrifuge V3 3개, 네이티브 자산 볼트 FastLane shMONAD 1개, 기초자산 송금이 허가제인 볼트 4개(Valos vUSD, K3 x Galaxy Lending 등).

### EIP-4626 불일치 3건

취약점이 아니라 명세 문장과의 불일치다. 자금 손실로 이어진다는 주장은 하지 않는다.

1. **Upshift earnAUSD 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E**: withdraw와 redeem이 항상 `WithdrawalRequestRequired()`(0x75ed2e3e)로 revert하는데 maxWithdraw와 maxRedeem은 보유 잔액 전체를 돌려준다. EIP-4626은 출금이 막혀 있으면 0을 돌려주라고 정한다. 설계상 비동기 출금 볼트다. 구현 0xFd2F793C248Dd673C830DF610a95a045054de267의 코드에 ERC-7540 `requestRedeem(uint256,address,address)`(0x7d41c86e)가 있고, 출금은 요청을 거친다. 2026-10-07부터 결과 파일(schemaVersion 4)은 이를 `traits`의 `async-redeem`으로 기록하고, 현황판은 판정 옆에 "Asynchronous withdrawals: exits go through requestRedeem"을 붙인다. 근거는 코드의 선택자와, 같은 검사에서 예치는 통과하고 출금과 상환은 모든 입력에서 revert했다는 사실이다. Upshift는 ERC-165를 구현하지 않는다. 라벨은 맥락일 뿐 판정을 바꾸지 않는다. ERC-7540도 maxWithdraw와 maxRedeem은 지금 청구할 수 있는 양, 즉 요청이 이행되기 전에는 0을 돌려주라고 정하므로 불일치는 그대로다. 같은 블록 109195820과 같은 시드로 다시 돌린 결과도 16 pass, 2 fail, 12 inconclusive로 상태가 30개 모두 같았고, 두 fail은 같은 0x75ed2e3e였다. 반례 금액만 fuzz 입력이 달라져 바뀌었다.
2. **Aarna atvYieldMax 0x4C09558A0d000240726679fC3805c3918922d6C6**: 이 블록에서 `withdrawalsPaused()`가 true이고 출금이 `WithdrawalsArePaused()`(0xe14e66da)로 revert하는데 maxWithdraw와 maxRedeem은 0이 아니다. 볼트 총자산은 0.001 USDC로 사실상 비어 있다.
3. **Euler EVK eeUSD-4 0xf26dC2F1FE883b11Dd56700db594DfC32Eee95Bf**: 볼트 훅(0xF5b821Efb4F6e13DE7521A3E4fc07fd2a153e280)이 허가되지 않은 사용자의 예치를 `NotAuthorized()`(0xea8e4eb5)로 막는데 maxDeposit과 maxMint는 거의 무한대를 돌려준다. EVK의 max 함수가 훅의 동작을 알 수 없는 구조에서 오는 불일치다. 기초자산 Euler USD는 사용자 사이에서 자유롭게 송금됨을 따로 확인했다.

Neverland wnCBBTC(0x98a297e6424787E57Af119949d7E00b721F832BB)는 이전 블록 109061472에서 maxDeposit이 공급 한도를 99 단위 과대평가했지만, 이 블록에서는 30개 모두 통과했다. 한도가 거의 찼을 때만 드러나는 경계 문제라서 블록에 따라 결과가 달라진다.

### 온체인 증명

Monad 테스트넷(10143) `CheckAttestationRegistry` 0x3754918bBB8481D046D80718a9efe434e353daF7에 18건을 기록했다. 증명 1건 비용은 약 0.052 MON이라 285개 전부 대신 다음을 골랐다.
- 불일치 볼트 3개 전부
- 30개 전부 통과한 구현마다 대표 볼트 하나
- Morpho Vault V2 대표 볼트 하나
- 시험 발급했던 Morpho 볼트 0x802c..4e44를 최종 결과로 다시 발급(id 17이 id 0을 대체)

17개 볼트 모두 온체인 reportHash와 suiteHash가 `certs/checks`의 결과 파일과 일치한다. `isCompliant`는 13개가 참, 4개가 거짓이다(불일치 3개와, 적용 불가가 있는 Morpho V2 대표). 트랜잭션 목록은 `packages/web/data/attestation-txs.json`.

### 실행 중 드러난 운영 문제

- 네트워크 단절이 두 번 있었다. 첫 번째는 82개, 두 번째는 70개가 첫 RPC 요청에서 "fetch failed"로 끝났다. 연결을 확인하고 최대 세 번 재시도하는 스크립트로 다시 돌려 모두 결과를 얻었다.
- RPC 오류로 판정 불가가 된 볼트 2개는 다른 RPC로 다시 돌려 30개 모두 통과했다. 최종 결과에 RPC 오류로 인한 판정 불가는 없다.
- 테스트넷 공개 RPC는 초당 15건으로 요청을 제한한다. 현황판 빌드의 레지스트리 읽기를 동시 2개, 재시도 6회로 바꿨다.

### 한계

- 한 블록, 한 시점의 결과다. 한도나 일시정지 상태가 바뀌면 결과도 바뀐다(Neverland 사례).
- pass는 "이 30개 속성을 이 블록에서 속성마다 16회 동안 반례 없이 통과했다"는 뜻이고 안전 보증이 아니다.
- 금액은 1e6 토큰까지, 사용자는 실행마다 시드에서 만든 16개 주소다.
- 증명은 테스트넷에 있고, 메인넷 코드 해시와 구현은 발급자가 발급 직전에 다시 읽어 대조한 값이다. 누구나 기록된 블록과 시드로 재현해 검증할 수 있다.
