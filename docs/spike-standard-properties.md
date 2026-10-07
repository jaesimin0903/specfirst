# 스파이크: 배포된 ERC-4626 볼트에 제3자 표준 속성 검사

작성 2026-09-30. 결정 기록은 `docs/adr/0003-third-party-standard-properties.md`.

## 질문과 판정

배포자가 직접 쓴 스펙 대신, 배포자와 무관한 공개 표준 속성을 이미 배포된 Monad 메인넷 볼트에 돌려서 의미 있는 결과를 얻을 수 있는가.

판정 기준은 "10월 1일까지 서로 다른 구현 5개 이상에서 결과가 나온다"였다. **충족했다.** 서로 다른 구현 6개에서 결과가 나왔고, 그중 2개에서 EIP-4626의 MUST 문장과 어긋나는 동작을 확인했다. 심어 둔 버그가 아니라 메인넷에 실제로 배포된 볼트의 동작이다.

## 방법

```
specfirst check <address> --standard erc4626 --block 109061472 --runs 16
```

- 체인 143, 고정 블록 109061472. RPC 5곳에 나눠 병렬로 돌렸고, 5곳 모두 이 블록에서 같은 상태를 돌려주는 것을 먼저 확인했다.
- 속성 30개. a16z/erc4626-tests 26개(커밋 ac485460e0)와 Specfirst 고유 속성 4개(`sf-maxDeposit-honored`, `sf-maxMint-honored`, `sf-maxWithdraw-honored`, `sf-maxRedeem-honored`).
- 모든 결과 파일의 하네스 sha256은 0xbba32892로, sf 속성 sha256은 0xfc1755eb로 같다. forge 1.5.1, max_test_rejects 4096.
- 실행마다 퍼즈 시드와 발신 주소를 무작위로 정하고 결과 파일에 기록한다. 사용자 주소는 그 시드에서 만든 16개 풀에서 고른다.
- 대조군: previewDeposit이 실제보다 1% 많은 지분을 약속하는 고의 버그 볼트를 같은 fork에 배포하면 previewDeposit만 fail이 된다. live 테스트로 고정되어 있다.

## 결과

같은 구현 키로 묶인 볼트는 한 구현으로 센다.

| 구현 | 볼트 | 구현 키 | 결과 | 시간 |
|---|---|---|---|---|
| Morpho MetaMorpho | 0x802c..4e44 USDC, 0xBC03..6D29 AUSD | 0x5932735a3a, 두 볼트 동일 | 30 pass | 12.9초, 69.4초 |
| Euler EVK | 0x9eA1..a42B WMON | 0xdd21af250f | 30 pass | 28.6초 |
| Euler Earn | 0x9D42..828c WMON | 0x85a2cb83bb | 30 pass | 20.7초 |
| Curvance cToken | 0x8EE9..1774 USDC | 0x66f5f1f156 | 30 pass | 26.7초 |
| Neverland 래퍼 | 0x98a2..32BB cbBTC | 0x30044ce190 | 28 pass, 2 fail | 14.2초 |
| Upshift | 0xD793..fda5E AUSD | 0x96bc3ebfda | 16 pass, 2 fail, 12 inconclusive | 169.8초 |

검사할 수 없어서 그렇게 분류된 것:
- **Euler EVK 0x4735..cfB7**: 고정 블록에서 maxDeposit 0, totalAssets 0, 훅 설정으로 모든 작업이 막혀 있다. 30개 모두 inconclusive. 활성 볼트 0x9eA1..a42B와 구현 키가 같아서, 이 구현은 활성 볼트로 검사한 것으로 본다.
- **FastLane shMONAD 0x1B68..E19c**: `asset()`이 네이티브 자산 표지를 돌려주는 ERC-7535 볼트다. 30개 모두 not_applicable이고 forge를 돌리지 않는다.

## 발견 1: Upshift earnAUSD 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E

- **구현**: 0xFd2F793C248Dd673C830DF610a95a045054de267. Sourcify match, `TokenizedAccount.flattened.sol`.
- **코드**: `withdraw`와 `redeem`이 pure 함수로 항상 `WithdrawalRequestRequired()`(선택자 0x75ed2e3e)를 던진다. 출금은 `requestRedeem`으로 요청한 뒤 받는 비동기 흐름이다. 반면 `maxWithdraw`는 보유 잔액의 자산 환산값을, `maxRedeem`은 보유 잔액을 그대로 돌려준다.
- **측정**:
  - withdraw(796956944122)가 revert했다. 이때 maxWithdraw는 801365610429였다.
  - redeem(222775094036)이 revert했다. 이때 maxRedeem은 797162179826이었다.
- **어긋나는 문장**: EIP-4626은 maxWithdraw가 "withdraw로 revert 없이 꺼낼 수 있는 최대치"여야 하고, "출금이 완전히 막혀 있으면 일시적이라도 0"이어야 한다고 MUST로 정한다. maxRedeem도 같다.
- **영향**: 자금을 빼앗는 버그는 아니다. 다만 maxWithdraw나 maxRedeem으로 꺼낼 수 있는 유동성을 계산하는 통합, 예를 들어 할당 볼트나 어그리게이터는 출금 시도에서 막힌다.
- **a16z만으로는 드러나지 않았다**: 업스트림 테스트는 볼트 호출이 revert하면 그 입력을 버린다. 그래서 출금 경로 속성 12개가 inconclusive로만 남았다. sf 속성은 revert를 버리지 않으므로 이 차이를 fail로 잡는다.

## 발견 2: Neverland wnCBBTC 0x98a297e6424787E57Af119949d7E00b721F832BB

- **구현**: 0xD75D6Bf28519aCD719ae59Cbc47D9af0a0792af1 (EIP-1967). Aave V3 포크 위의 래퍼다.
- **측정**: maxDeposit은 1555961301, 즉 15.56 cbBTC다. deposit(maxDeposit)은 "51"로 revert한다. Aave V3에서 "51"은 공급 한도 초과(SUPPLY_CAP_EXCEEDED)다.
  - 이분 탐색 결과 maxDeposit에서 99를 뺀 금액까지는 받아들이고, 98을 뺀 금액부터 revert한다. 과대평가 폭은 99 단위, 즉 0.00000099 cbBTC다.
  - mint도 같은 경계에서 막힌다. maxMint는 1551400084이고, previewMint(maxMint)가 maxDeposit과 같다.
- **어긋나는 문장**: EIP-4626은 maxDeposit이 실제로 받아들여지는 최대치보다 크면 안 되고, 필요하면 과소평가하라고 정한다.
- **영향**: 낮다. 금액은 무시할 수준이다. 다만 공급 한도를 maxDeposit 값 그대로 채우려는 통합은 이 경계에서 revert한다.
- **원인 추정, 소스로 확인하지 않음**: 래퍼가 남은 한도를 계산할 때와 풀이 한도를 검사할 때, 이자 인덱스나 적립 금액을 반영하는 방식이 다를 가능성이 있다.

## 공개 방식

2026-09-30에 해당 팀에 사전 연락은 하지 않기로 했다. 대신 제출물과 데모에서는 두 발견을 취약점이 아니라 EIP-4626 문장과의 불일치로 쓰고, 위의 주소, 선택자, 측정값처럼 누구나 fork로 재현할 수 있는 사실만 적는다. 자금 손실로 이어진다는 표현은 쓰지 않는다.

## 스파이크 중 드러나 고친 도구 결함

| 결함 | 증상 | 처리 |
|---|---|---|
| 공개 RPC의 HTTP 429 | 컨트랙트 버그가 아닌데 fail로 기록 | inconclusive로 분류, 요청 속도 제한 (17d47f5) |
| setUp 중 RPC 오류 | 26개 전부 not_applicable, exit 0 | inconclusive로 분류 (667f269) |
| revert 문자열 흉내 | 진짜 fail이 inconclusive로 숨음 | forge가 만드는 접두어에만 고정 (667f269) |
| AUSD 묶음 잔액 슬롯 | deal 실패가 26 fail로 기록 | 묶음 슬롯 쓰기로 폴백, 둘 다 실패하면 inconclusive (37f0561) |
| 매 입력마다 새 사용자 주소 | 한 볼트 40분 이상, 13개 inconclusive | 시드에서 만든 16개 사용자 풀, 이후 볼트당 수십 초 (8684e78) |
| 출금 경로가 막힌 볼트 | 기본 거부 한도 65536 때문에 1시간 타임아웃 | 거부 한도 4096 (53672f1) |
| 2KB OpenZeppelin 프록시 | 프록시로 식별 못 해 다른 구현과 합쳐질 위험 | 4KB까지 프록시로 인정 (da049ab) |
| a16z의 revert 입력 폐기 | max 값 위반이 inconclusive로만 보임 | sf 속성 4개 추가 (53672f1) |
| forge EVM에 없는 Monad precompile | gMON 예치가 fork에서만 revert해 sf-maxDeposit, sf-maxMint가 fail | revert한 호출을 상태 차이 기록과 precompile 모의 응답으로 다시 실행해, 같은 revert면 볼트 자신의 revert로 판정하고, 달라지면 그 입력은 판정하지 않고 기록. 모의 응답은 볼트가 알아챌 수 있으므로, 판정하지 않은 입력이 하나라도 있는 속성은 pass가 될 수 없음(다른 입력이 fail이면 fail, 아니면 inconclusive). setUp 탐침으로 스위트 전체를 멈추던 첫 판(f3f28c9)은 리뷰에서 볼트가 진짜 fail을 숨길 수 있는 스위치로 드러나 고침 |
| mint 자금 여유 1% | previewMint보다 많이 가져가는 hyAUSD가 sf-maxMint fail | previewMint의 2배와 1토큰 지급, 초과분은 previewMint 속성의 몫 (f3f28c9) |
| 상한보다 작은 금액의 거부 | hyAUSD deposit(3)의 거부가 sf-maxDeposit fail로 기록 | 상한에서 다시 시도해 통과하면 입력 폐기와 개수 기록, 상한도 revert하면 fail 유지 (f3f28c9). 최솟값이라고 단정하지 않고 "상한은 받아들여졌다"로만 씀 |
| 빌드가 다른 프로세스의 캐시 공유 | 실행 중인 forge 아래에서 하네스 파일이 다른 버전으로 바뀔 수 있음 | 작업공간 디렉터리 이름을 작업공간 파일 전체의 해시로 (8bf1d17) |

## 한계

- 한 블록, 한 시점의 검사다. 수익이나 손실이 난 뒤의 상태는 보지 않는다.
- 금액은 1e6 토큰까지, 사용자는 실행마다 16개 주소다.
- pass는 "이 30개 속성에서 이 블록 기준으로 속성마다 16회 동안 반례를 찾지 못했다"는 뜻이다. 안전을 보증하지 않는다.
- 결과 파일은 `.specfirst/checks/143/<주소>/109061472.json`에 있고 저장소에는 커밋하지 않는다. 결과 파일에 기록된 시드를 `--seed`로 넘기면 같은 실행을 재현할 수 있다.

## 다음

1. 증명서를 표준 속성 기반으로 발급한다. 구현 키, 속성 목록, 하네스 해시, 블록, 결과 요약을 증명서에 기록한다.
2. 웹에 공개 결과 탐색기를 만든다. 주소를 넣으면 pass, fail, 판정 불가, 적용 불가 항목과 사유를 보여준다.
