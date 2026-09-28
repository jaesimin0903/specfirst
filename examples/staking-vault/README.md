# StakingVault 샘플

specfirst 데모용 Foundry 프로젝트다. 네이티브 MON 스테이킹 볼트에 재진입 버그를 심어 두었고, 스펙의 불변식 7개를 forge invariant 캠페인으로 판정한다. 계획서 `docs/plan.md` 3.1절이 원본이다.

## 구조

```
spec/staking-vault.spec.yaml     스펙. 불변식 7개와 액터 구성
src/StakingVault.sol             버그 심은 초기 구현. 에이전트가 고치는 대상 (editable: src/)
fixed/StakingVault.sol           고친 구현. checks-effects-interactions 순서
fixtures/fix-reentrancy.patch    src 버그판에서 고친 판으로 가는 diff. ReplayAgent 재생용
fixtures/forge-buggy.txt         버그 구현 캠페인 출력 원문
fixtures/forge-fixed.txt         고친 구현 캠페인 출력 원문
test/specfirst/                  속성 코드. lock 대상 (propertyHash)
  IVault.sol                     볼트 인터페이스
  SpecfirstProps.sol             속성 식 inv1..inv7. 식은 이 라이브러리에만 있다
  Handler.sol                    퍼징 진입점, 액터, ghost 변수, 사후조건과 권한 판정
  Attacker.sol                   기본 공격자 액터. receive, fallback 훅이 직전 호출을 1회 재호출
  Invariants.t.sol               invariant_INV_1 .. invariant_INV_7
  SpecfirstProbe.sol             배포하지 않는 헬퍼. to 없는 eth_call로 inv1, inv2, inv6 판정
  regressions/                   수정 루프가 반례를 회귀 테스트로 남기는 자리
test/ProbeSmoke.t.sol            Probe 반환 형식 스모크 테스트 (lock 대상 밖)
lib/forge-std                    packages/contracts/lib/forge-std 복사본. 이 폴더만으로 독립 실행
```

solc 0.8.28, evm cancun. 외부 의존은 forge-std뿐이다.

## 실행

```bash
cd examples/staking-vault
forge test --match-path test/specfirst/Invariants.t.sol      # 버그 구현: INV-1..4 실패
forge test --match-path test/ProbeSmoke.t.sol                 # Probe 스모크

# 고친 구현 확인
git apply --directory=examples/staking-vault fixtures/fix-reentrancy.patch   # 저장소 루트에서
# 또는 이 폴더에서: patch -p1 < fixtures/fix-reentrancy.patch
```

캠페인 기본값은 `foundry.toml`의 runs 256, depth 64, fail_on_revert false다. specfirst CLI는 `FOUNDRY_INVARIANT_RUNS`, `FOUNDRY_INVARIANT_DEPTH` 환경변수로 덮어쓴다. forge는 찾은 반례를 `cache/invariant/failures`에 저장했다가 다음 실행에서 먼저 재생한다. 깨끗한 캠페인이 필요하면 `FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR`를 새 디렉터리로 지정한다.

### fork 모드 (배포 후 대조)

```bash
SPECFIRST_TARGET=<볼트 주소> \
SPECFIRST_DEPOSITORS=<예치자1>,<예치자2> \
FOUNDRY_INVARIANT_RUNS=32 \
forge test --fork-url <rpc> --match-path test/specfirst/Invariants.t.sol
```

`SPECFIRST_TARGET`이 있으면 `setUp`은 새로 배포하지 않고 그 주소에 붙는다. 소유자 액터는 `vault.owner()`에서 읽는다. `SPECFIRST_DEPOSITORS`는 Deposit 로그로 모은 전체 예치자 집합이며 INV-1, INV-2 합산의 초기 대상이 된다. 로컬 anvil에 버그판을 배포하고 이 경로로 돌려 네 반례가 같은 형태로 나오는 것을 확인했다.

### Probe (fork 대체 2차 경로)

```bash
INIT=$(forge inspect SpecfirstProbe bytecode)$(cast abi-encode "f(address,address[])" <볼트> "[<예치자>,...]" | cut -c3-)
cast call --rpc-url <rpc> --create $INIT | xargs cast decode-abi --input "f(bool,bool,bool)"
```

반환은 `abi.encode(inv1, inv2, inv6)`다. 일시정지 중이면 inv6은 value 0 예치를 시도해 revert되는지 본다. anvil에서 정상 상태와 일시정지 상태 모두 `true true true`를 확인했다.

## 심은 버그

```solidity
function withdraw(uint256 amount) external {
    uint256 bal = balances[msg.sender];
    if (amount > bal) revert InsufficientBalance();
    (bool ok,) = msg.sender.call{value: amount}("");   // 상태 갱신 전에 전송
    if (!ok) revert TransferFailed();
    balances[msg.sender] = bal - amount;               // 캐시한 bal 기준으로 덮어씀
    totalStaked -= amount;                             // 호출마다 차감
    emit Withdraw(msg.sender, amount);
}
```

잔고 B인 공격자가 `withdraw(a)`를 부르면 receive 훅이 `withdraw(a)`를 한 번 더 부른다. 두 호출 모두 같은 `bal = B`를 읽으므로 MON은 2a 나가고, 잔고는 `B - a`로 한 번만 줄고, `totalStaked`는 2a 줄어든다. 2회 지급, 1회 차감이다. 수정은 잔고와 총량 갱신을 전송 앞으로 옮기는 것뿐이며 nonReentrant는 쓰지 않는다.

## 액터와 핸들러

| 인덱스 | 액터 | 호출 방식 |
|---|---|---|
| 0, 1, 2 | user0, user1, user2 | `vm.prank` |
| 3 | owner | `vm.prank`. 로컬은 `makeAddr("owner")`, fork는 `vault.owner()` |
| 4 | attacker | `Attacker.execute` 경유. 훅이 켜진 상태로 호출 |

핸들러 함수의 첫 인자 `actorSeed`를 5로 나눈 나머지가 액터 인덱스다. withdraw 요청의 4분의 1은 잔고보다 큰 금액이고 나머지는 잔고 안에서 고른다.

| 불변식 | 종류 | 판정 위치 |
|---|---|---|
| INV-1 | 상태 | `invariant_INV_1`이 `inv1(vault, depositors)` 호출 |
| INV-2 | 상태 | `invariant_INV_2`가 `inv2(vault, depositors)` 호출 |
| INV-3 | 사후조건 | 핸들러가 withdraw 직후 `inv3` 판정, 위반 시 ghost 플래그, `invariant_INV_3`이 플래그 확인 |
| INV-4 | 권한 | 핸들러가 withdraw 직후 `inv4` 판정, 같은 방식 |
| INV-5 | 권한 | 핸들러가 setRewardRate 직후 `inv5` 판정, 같은 방식 |
| INV-6 | 상태 | 핸들러가 일시정지 중 예치 성공을 ghost로 기록, `invariant_INV_6`이 `inv6(vault, ghost)` 호출 |
| INV-7 | 권한 | 핸들러가 pause, unpause 직후 `inv7` 판정, 같은 방식 |

INV-3의 출금액은 한 트랜잭션 안에서 성공한 withdraw 호출 금액의 합이다. 공격자의 재호출이 성공했으면 2a로 센다. 고친 구현에서 잔고 안의 정당한 재호출은 잔고도 2a 줄므로 통과한다.

## 기대 반례와 실제 결과

버그 구현, runs 256, depth 64 기준. 출력 원문은 `fixtures/forge-buggy.txt`.

| 불변식 | 결과 | 축소된 반례 | 깨지는 이유 |
|---|---|---|---|
| INV-1 | 실패 | 2호출. 누군가 예치, 공격자 withdraw | totalStaked가 2a 줄고 잔고 합은 a만 줄어 totalStaked < 잔고 합 |
| INV-2 | 실패 | 3호출. 예치 2회, 공격자 withdraw | 볼트 MON이 2a 나가 잔고 합보다 작아짐 |
| INV-3 | 실패 | 2호출. 공격자 예치, 공격자 withdraw | 성공한 출금 합 2a, 잔고 감소 a |
| INV-4 | 실패 | 4호출. 예치 3회, 공격자 withdraw | a가 B/2보다 크면 받은 MON 2a가 출금 전 잔고 B 초과 |
| INV-5 | 통과 | | |
| INV-6 | 통과 | | |
| INV-7 | 통과 | | |

네 반례 모두 마지막 호출이 공격자 액터(`actorSeed % 5 == 4`)의 withdraw다. 시드 1부터 8까지 따로 돌려도 매번 같은 네 개가 실패했다. 한 불변식당 수백 호출 안에 잡히므로 depth를 올릴 필요가 없었다.

고친 구현은 7/7 통과다. 출력 원문은 `fixtures/forge-fixed.txt`이고 시드 1부터 5까지도 모두 통과했다.

INV-5, INV-6, INV-7이 공허하게 통과하지 않는지 임시 뮤턴트로 확인했다. 예치의 일시정지 검사를 지우면 INV-6만, setRewardRate의 onlyOwner를 지우면 INV-5만, unpause의 onlyOwner를 지우면 INV-7만 실패했다. 정식 뮤턴트 검사는 `specfirst lock`의 몫이다.
