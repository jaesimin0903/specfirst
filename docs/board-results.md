# Monad ERC-4626 전수 검사 결과

작성 2026-09-30. 방법과 결정은 `docs/adr/0003-third-party-standard-properties.md`, 증명은 `docs/adr/0004-check-attestation-registry.md`. 처음 6개 구현으로 한 스파이크는 `docs/spike-standard-properties.md`.

## 범위와 방법

- Monad 메인넷(143)에서 체인 호출로 확인한 ERC-4626 볼트 285개. 출처는 Morpho API, Euler EVK 팩토리 목록, Curvance 문서, Neverland 저장소, monad-crypto/protocols, DefiLlama.
- 고정 블록 109195820, 볼트마다 속성 30개(a16z/erc4626-tests 26개와 Specfirst 고유 `sf-max*-honored` 4개), 속성당 16회, 하네스 버전 하나.
- 결과 파일 285개는 `certs/checks/143/<주소>/109195820-<reportHash 앞 8바이트>.json`. 각 파일에 시드와 발신 주소가 있어 `specfirst check <주소> --standard erc4626 --block 109195820 --runs 16 --seed <시드>`로 재현된다.

## 결과

| 분류 | 볼트 |
|---|---|
| 30개 전부 통과 | 174 |
| EIP-4626 불일치 | 3 |
| 일부 확인. 적용 가능한 속성은 통과했지만 적용 불가나 판정 불가가 섞임 | 100 |
| 적용 불가. 스위트를 적용할 수 없는 볼트 | 8 |

구현 키 기준으로는 17개 구현이다. 볼트 수가 많은 구현은 Euler EVK 134, Morpho Vault V2 64, Morpho MetaMorpho V1.1 27, Curvance 24, Neverland 13이다.

"일부 확인" 100개의 대부분은 두 부류다.
- **Morpho Vault V2**: 64개 중 58개가 a16z 26개를 모두 통과했다. V2는 max 함수 네 개가 모든 사용자에게 0을 돌려주므로 "max만큼은 실행돼야 한다"는 고유 속성이 확인할 대상이 없다. 그래서 52개는 고유 속성 4개가 모두 적용 불가이고, 6개는 2개가 적용 불가, 2개가 판정 불가다. EIP-4626은 과소평가를 허용하므로 위반이 아니다. 나머지 6개는 모든 입력이 거부돼 통과한 속성이 하나도 없다.
- **검사할 수 없는 상태의 볼트**: 예치가 막혀 있어 모든 입력이 거부된 볼트, 기초자산이 비표준이라 테스트 잔액을 쓸 수 없는 볼트(shMON, sMON, 래핑된 LST 등).

"적용 불가" 8개: ERC-7575처럼 지분이 별도 토큰인 Centrifuge V3 3개, 네이티브 자산 볼트 FastLane shMONAD 1개, 기초자산 송금이 허가제인 볼트 4개(Valos vUSD, K3 x Galaxy Lending 등).

## EIP-4626 불일치 3건

취약점이 아니라 명세 문장과의 불일치다. 자금 손실로 이어진다는 주장은 하지 않는다.

1. **Upshift earnAUSD 0xD793c04B87386A6bb84ee61D98e0065FdE7fdA5E**: withdraw와 redeem이 항상 `WithdrawalRequestRequired()`(0x75ed2e3e)로 revert하는데 maxWithdraw와 maxRedeem은 보유 잔액 전체를 돌려준다. EIP-4626은 출금이 막혀 있으면 0을 돌려주라고 정한다.
2. **Aarna atvYieldMax 0x4C09558A0d000240726679fC3805c3918922d6C6**: 이 블록에서 `withdrawalsPaused()`가 true이고 출금이 `WithdrawalsArePaused()`(0xe14e66da)로 revert하는데 maxWithdraw와 maxRedeem은 0이 아니다. 볼트 총자산은 0.001 USDC로 사실상 비어 있다.
3. **Euler EVK eeUSD-4 0xf26dC2F1FE883b11Dd56700db594DfC32Eee95Bf**: 볼트 훅(0xF5b821Efb4F6e13DE7521A3E4fc07fd2a153e280)이 허가되지 않은 사용자의 예치를 `NotAuthorized()`(0xea8e4eb5)로 막는데 maxDeposit과 maxMint는 거의 무한대를 돌려준다. EVK의 max 함수가 훅의 동작을 알 수 없는 구조에서 오는 불일치다. 기초자산 Euler USD는 사용자 사이에서 자유롭게 송금됨을 따로 확인했다.

Neverland wnCBBTC(0x98a297e6424787E57Af119949d7E00b721F832BB)는 이전 블록 109061472에서 maxDeposit이 공급 한도를 99 단위 과대평가했지만, 이 블록에서는 30개 모두 통과했다. 한도가 거의 찼을 때만 드러나는 경계 문제라서 블록에 따라 결과가 달라진다.

## 온체인 증명

Monad 테스트넷(10143) `CheckAttestationRegistry` 0x3754918bBB8481D046D80718a9efe434e353daF7에 18건을 기록했다. 증명 1건 비용은 약 0.052 MON이라 285개 전부 대신 다음을 골랐다.
- 불일치 볼트 3개 전부
- 30개 전부 통과한 구현마다 대표 볼트 하나
- Morpho Vault V2 대표 볼트 하나
- 시험 발급했던 Morpho 볼트 0x802c..4e44를 최종 결과로 다시 발급(id 17이 id 0을 대체)

17개 볼트 모두 온체인 reportHash와 suiteHash가 `certs/checks`의 결과 파일과 일치한다. `isCompliant`는 13개가 참, 4개가 거짓이다(불일치 3개와, 적용 불가가 있는 Morpho V2 대표). 트랜잭션 목록은 `packages/web/data/attestation-txs.json`.

## 실행 중 드러난 운영 문제

- 네트워크 단절이 두 번 있었다. 첫 번째는 82개, 두 번째는 70개가 첫 RPC 요청에서 "fetch failed"로 끝났다. 연결을 확인하고 최대 세 번 재시도하는 스크립트로 다시 돌려 모두 결과를 얻었다.
- RPC 오류로 판정 불가가 된 볼트 2개는 다른 RPC로 다시 돌려 30개 모두 통과했다. 최종 결과에 RPC 오류로 인한 판정 불가는 없다.
- 테스트넷 공개 RPC는 초당 15건으로 요청을 제한한다. 현황판 빌드의 레지스트리 읽기를 동시 2개, 재시도 6회로 바꿨다.

## 한계

- 한 블록, 한 시점의 결과다. 한도나 일시정지 상태가 바뀌면 결과도 바뀐다(Neverland 사례).
- pass는 "이 30개 속성을 이 블록에서 속성마다 16회 동안 반례 없이 통과했다"는 뜻이고 안전 보증이 아니다.
- 금액은 1e6 토큰까지, 사용자는 실행마다 시드에서 만든 16개 주소다.
- 증명은 테스트넷에 있고, 메인넷 코드 해시와 구현은 발급자가 발급 직전에 다시 읽어 대조한 값이다. 누구나 기록된 블록과 시드로 재현해 검증할 수 있다.
