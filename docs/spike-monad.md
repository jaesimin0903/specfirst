# Monad 테스트넷 스파이크

작성일 2026-09-29. 배포 키 없이 수행 가능한 읽기 전용 실측만 담는다. 참조는 `docs/plan.md` 0.2절과 4절 9/28, 9/29 행. 도구는 `cast`(foundry 1.5.1)와 `curl`. chain id 10143.

RPC 3곳
- quicknode: `https://testnet-rpc.monad.xyz`
- ankr: `https://rpc.ankr.com/monad_testnet`
- foundation: `https://rpc-testnet.monadinfra.com`

배포, SELFDESTRUCT, 16.7M 초과 gas tx는 배포 키가 없어 미실측이다. 절차만 8절 끝에 적는다.

## 1. 기본 응답과 소요 시간

| RPC | 요청 | 결과 | 소요 시간 |
|---|---|---|---|
| quicknode | eth_chainId | `0x279f`(10143) | 0.511s |
| quicknode | eth_blockNumber | `0x3f5c91c` | 0.132s |
| quicknode | eth_gasPrice | `0x17bfac7c00` | 0.134s |
| ankr | eth_chainId | `0x279f` | 0.550s |
| ankr | eth_blockNumber | `0x3f5c91f` | 0.536s |
| ankr | eth_gasPrice | `0x17bfac7c00` | 0.552s |
| foundation | eth_chainId | `0x279f` | 1.042s |
| foundation | eth_blockNumber | `0x3f5c929` | 1.208s |
| foundation | eth_gasPrice | `0x17bfac7c00` | 0.982s |

가스 가격은 3곳 모두 `0x17bfac7c00` = 102,000,000,000 wei = **102 gwei**로 일치했다. 0.5절 P 값 후보를 100 gwei에서 **102 gwei**로 교체한다. 응답 시간은 quicknode가 가장 빠르고(0.13~0.51s), foundation이 가장 느리다(0.98~1.21s). 세 값 모두 단발 측정이라 네트워크 변동을 포함한다.

## 2. 블록 시간

quicknode에서 10초 간격으로 eth_blockNumber를 두 번 측정.

| 측정 | 블록 번호 | 타임스탬프(unix) |
|---|---|---|
| t0 | 66439500 | 1790608388.653 |
| t1 | 66439534 | 1790608399.148 |

34블록 / 10.494초 = 초당 약 3.24블록, 블록당 약 **0.309초**. plan.md 0.5절 리허설 30건, 스파이크 여유 등 벽시계 시간 추정에 이 값을 쓸 수 있다.

## 3. eth_getLogs 블록 범위 한도

각 RPC에서 latest 기준 span 99, 999, 9999(각각 100, 1000, 10000블록 범위)로 요청.

| RPC | span(블록 수) | 결과 | 오류 원문 |
|---|---|---|---|
| quicknode | 99(100) | OK, count=3772 | - |
| quicknode | 999(1000) | 실패 | `{"code": -32614, "message": "eth_getLogs is limited to a 100 range"}` |
| quicknode | 9999(10000) | 실패 | 위와 동일 |
| ankr | 99(100) | OK, count=3797 | - |
| ankr | 999(1000) | 실패 | `{"code": -32062, "message": "Block range is too large"}` |
| ankr | 9999(10000) | 실패 | 위와 동일 |
| foundation | 99(100) | OK, count=4065 | - |
| foundation | 999(1000) | 실패 | `{"code": -32602, "message": "block range too large"}` |
| foundation | 9999(10000) | 실패 | 위와 동일 |

경계를 더 좁혀 확인했다.

| RPC | 블록 수 | 결과 |
|---|---|---|
| quicknode | 101 | OK |
| foundation | 101 | OK |
| ankr | 101 | OK |
| ankr | 107 | 실패, `Block range is too large` |
| ankr | 113 | 실패 |
| ankr | 125 | 실패 |
| ankr | 150 | 실패 |
| ankr | 200 | 실패 |

quicknode와 foundation은 문서(0.2절, docs.monad.xyz `reference/rpc-limits`)가 말하는 100블록과 실측이 일치한다. **ankr은 문서상 1,000블록이지만 실측으로는 약 101블록에서 이미 막힌다.** docs.monad.xyz의 rpc-limits 표가 가리키는 ankr 엔드포인트는 `rpc3.monad.xyz`(메인넷용으로 보이는 전용 엔드포인트)이고, 이번에 쓴 공개 게이트웨이 `rpc.ankr.com/monad_testnet`은 별도 제한을 두는 것으로 보인다. plan.md 0.2절의 "Ankr와 Alchemy 1,000블록"은 지금 쓰는 테스트넷 공개 엔드포인트 기준으로는 틀렸다. 세 RPC 모두 100블록 한도로 취급해야 한다.

## 4. 과거 상태 조회 가능 시간

컨트랙트 주소는 최근 블록의 트랜잭션에서 `to`로 반복 등장한 `0x1964c32f0be608e7d29302aff5e61268e72080cc`를 썼다. eth_getCode 결과 코드가 있음을 확인했다.

eth_getCode, eth_getBalance를 latest, latest-10, latest-100, latest-1000으로 3개 RPC 전부에서 요청. 전부 OK(코드 반환, 잔액 `0x0`). latest-10000, latest-100000, latest-1000000도 3개 RPC 전부에서 OK. 원문 오류 없음, 표는 모두 `OK`.

quicknode에서만 더 깊게 이진탐색.

| RPC | depth(블록) | 결과 | 비고 |
|---|---|---|---|
| quicknode | 2,000,000 | OK | |
| quicknode | 5,000,000 | OK | |
| quicknode | 10,000,000 | OK | |
| quicknode | 12,500,000 | OK | |
| quicknode | 13,750,000 | OK | |
| quicknode | 13,906,250 | OK | 마지막으로 성공한 지점 |
| quicknode | 14,062,500 | 실패 | `{"code": -32602, "message": "Block requested not found. Request might be querying historical state that is not available. If possible, reformulate query to point to more recent blocks"}` |
| quicknode | 14,375,000 | 실패 | 위와 동일 |
| quicknode | 15,000,000 | 실패 | 위와 동일 |
| quicknode | 20,000,000 | 실패 | 위와 동일 |
| quicknode | 40,000,000 | 실패 | 위와 동일 |
| quicknode | 66,439,600(블록 1 부근) | 실패 | 위와 동일, 제네시스 근처도 동일 오류 |

2절의 블록당 0.309초로 환산하면 경계는 약 429만 초, **약 49.7~50.2일**이다. ankr와 foundation은 depth 1,000,000(약 3.6일)까지만 개별 확인했고 그 이상은 quicknode만 이진탐색했다. 세 RPC가 동일한 언더레이 노드 데이터를 공유할 가능성이 높지만, 각 RPC 사업자가 자체적으로 pruning 정책을 둘 수 있어 ankr, foundation의 정확한 상한은 이 스파이크에서 확정하지 못했다.

**이것이 plan.md 0.2절 "임의 과거 상태를 제공하지 않는다"는 우려와 forge fork 고정 블록 문제의 핵심 수치다.** 실측 결과 quicknode는 최소 49일 이상 과거 상태를 서빙한다. 1주차, 2주차 스케줄(9/28~10/13, 약 15일) 전체가 이 윈도우 안에 들어간다.

## 5. debug_traceTransaction

tx `0x3b842b03ae6b09c4356e517d1e5344bc968e694695237998fbb9383f084527f5`(최근 블록)로 옵션 포함, 옵션 생략 각각 호출.

| RPC | 옵션 | 결과 |
|---|---|---|
| quicknode | `{tracer: callTracer}` | OK, calls 배열 반환 |
| quicknode | 옵션 생략 | OK, `{type: CALL, from, to, gas, gasUsed, input, ...}` 반환. 기본 tracer가 적용된 것으로 보임 |
| foundation | `{tracer: callTracer}` | OK |
| foundation | 옵션 생략 | OK, quicknode 생략 결과와 동일 형태 |
| ankr | `{tracer: callTracer}` | 실패, `{"code": -32053, "message": "API key is not allowed to access method"}` |
| ankr | 옵션 생략 | 실패, 위와 동일 |

**debug 네임스페이스 판정**: quicknode와 foundation은 제공한다. ankr(공개 테스트넷 게이트웨이)은 API 키 제한으로 아예 막혀 있다. plan.md 0.2절 "옵션 생략 시 -32602"는 이번 실측 3곳 어디에서도 재현되지 않았다. quicknode, foundation은 옵션 없이도 정상 응답했다. 이 항목은 문서와 실측이 어긋난다.

## 6. `to` 없는 eth_call, Probe 방식

initcode `0x602a60005260206000f3`(PUSH1 0x2a, PUSH1 0x00, MSTORE, PUSH1 0x20, PUSH1 0x00, RETURN, 즉 32바이트 워드로 0x2a를 리턴)를 `to` 없이 eth_call.

| RPC | 결과 |
|---|---|
| quicknode | OK, `0x000...02a` |
| ankr | OK, `0x000...02a` |
| foundation | OK, `0x000...02a` |

세 곳 모두 정상 작동한다. Probe 방식은 배포 키 없이도 생성 코드 실행 결과를 확인하는 대체 경로로 쓸 수 있음을 확인했다.

## 7. forge fork 시도

`/tmp/monad-fork-test`에 임시 foundry 프로젝트를 만들고(저장소에는 넣지 않음) `block.chainid`, `block.number`만 확인하는 빈 테스트로 quicknode를 fork.

```
forge test --fork-url https://testnet-rpc.monad.xyz --match-test test_forkWorks -vvvv
```

결과: PASS. `block.number 66440334`, `block.chainid 10143`. 컴파일과 fork 자체는 정상 동작한다.

이어서 같은 블록 번호(66440334)를 `--fork-block-number`로 고정하고 60초 대기 후 재조회.

```
forge test --fork-url https://testnet-rpc.monad.xyz --fork-block-number 66440334 --match-test test_forkWorks -vv
```

결과: PASS, 동일 블록 번호와 chain id 재확인. 60초 뒤에도 고정 블록 조회가 문제없이 된다. 이는 4절의 quicknode 약 49.7일 보존 윈도우 측정과 일치한다.

## 8. EIP-7825, EIP-6780 문서 확인

docs.monad.xyz `developer-essentials/gas-pricing`, `reference/rpc-limits`, `developer-essentials/testnet` 3개 페이지를 재확인.

- **EIP-7825, EIP-6780, SELFDESTRUCT**: 세 페이지 어디에도 언급 없음. plan.md와 동일하게 **문서 미확인, 키 확보 후 실측**으로 남긴다.
- **주목할 점**: gas-pricing 페이지는 자체적으로 "트랜잭션당 최대 가스 한도 30M gas"를 명시한다. 이는 EIP-7825가 정의하는 16,777,216(2^24, 약 16.7M) 가스 한도와 다른 숫자다. Monad가 EIP-7825를 그대로 채택했다면 두 숫자가 같아야 하는데 문서상 일치하지 않는다. 이것만으로 EIP-7825 미적용을 단정할 수는 없지만, plan.md가 4절 9/29 항목에서 "16.7M 초과 gas tx" 실측을 요구한 이유가 실측으로 뒷받침된다. 배포 키를 확보하면 gas limit 17,000,000 안팎의 트랜잭션을 보내 실제로 16,777,216에서 막히는지, 30M에서 막히는지, 150M 블록 가스 한도(gas-pricing 페이지에 명시)에서만 막히는지 확인해야 한다.
- testnet 페이지는 RPC 3곳의 URL과 rps 한도(quicknode 50rps, ankr 300req/10s와 12000req/10min, foundation 20rps)를 plan.md 0.2절과 동일하게 재확인했다. chain id 10143도 일치.
- rpc-limits 페이지의 eth_call/eth_estimateGas 가스 한도표는 메인넷 엔드포인트(`rpc.monad.xyz`, `rpc-mainnet.monadinfra.com` 등) 기준으로 quicknode 200M, ankr(`rpc3.monad.xyz`) 1B, foundation 200M을 적었다. 테스트넷 공개 엔드포인트의 실제 한도는 이번 스파이크에서 estimateGas 초과 요청을 보내지 않아 확인하지 못했다. 3절의 getLogs 사례처럼 테스트넷 공개 게이트웨이가 문서상 메인넷 수치와 다를 가능성을 염두에 둬야 한다.

### 미실측 항목(배포 키 필요)

| 항목 | 절차 |
|---|---|
| 배포 자체, codehash | 키 확보 후 순수 EOA로 샘플 컨트랙트 배포, tx receipt의 contractAddress와 `eth_getCode` 결과 해시 비교 |
| SELFDESTRUCT, EIP-6780 실측 | 생성 tx 안에서 SELFDESTRUCT 호출과, 생성 tx 밖 별도 tx에서 SELFDESTRUCT 호출 두 경로를 배포해 코드와 잔액이 각각 어떻게 남는지 `eth_getCode`, `eth_getBalance`로 대조 |
| 16.7M 초과 gas tx, EIP-7825 실측 | gas limit을 16,777,216 부근과 30,000,000 부근으로 나눠 보낸 뒤 어느 지점에서 거절되는지, 거절 시 pool 진입 전 reject인지 revert인지 확인 |

## 계획에 미치는 영향

- **0.5절 가스 가격 P**: 100 gwei 가정을 **102 gwei**로 교체. 8.3 MON 추정치는 8.3 * 1.02 = 약 8.47 MON으로 소폭 상향. 10/2까지 25 MON 확보 목표는 그대로 유지해도 된다.
- **eth_getLogs 한도**: ankr을 1,000블록으로 믿고 짠 로직이 있다면 전부 **100블록 기준**으로 낮춰야 한다. 세 RPC 모두 100블록으로 통일해서 페이지네이션을 짜는 게 안전하다.
- **debug_traceTransaction**: ankr(공개 게이트웨이)은 배제하고 quicknode, foundation 중 하나를 기본으로 쓴다. 옵션 생략도 되지만 tracer를 명시하는 습관은 유지해도 손해가 없다.
- **fork 고정 블록 문제, 계획 3.6 판정**: **주 경로(고정 블록 fork)가 현실적이다.** quicknode 기준 약 49.7일 보존 윈도우가 실측됐고, 이는 specfirst 1주차부터 2주차 전체(9/28~10/13, 약 15일)를 넉넉히 덮는다. 60초 뒤 재조회도 성공해 고정 블록이 짧은 시간 내에 사라지는 문제는 없다. `latest 치환 프록시`는 불필요하다고 판단한다. 다만 quicknode 한 곳만 깊게 검증했으므로, 실제 CI나 반복 실행 환경에서 quicknode가 아닌 RPC로 fork를 고정해야 한다면 그 RPC에서 별도로 보존 윈도우를 재확인해야 한다. **Probe 방식(`to` 없는 eth_call)은 항목 6에서 3곳 모두 정상 동작을 확인했으므로, fork가 막히는 예외 상황의 보조 경로로 계속 남겨둘 가치는 있다.** 즉 우선순위는 주 경로(고정 블록 fork) > Probe(보조, 생성 코드 단위 검증) > latest 치환 프록시(불필요, 폐기 검토).
- **EIP-7825 관련**: gas-pricing 문서의 "30M gas" 자체 표기가 EIP-7825의 16.7M과 다르다. 0.5절 리허설 gas limit 설계, 4절 9/29 "16.7M 초과 gas tx" 실측 항목은 계획대로 유지해야 하고, 오히려 이 불일치 때문에 실측 우선순위를 낮추면 안 된다.
- **가스 산정 방식**: gas-pricing 문서가 명시한 블록 가스 한도 150M, 자체 트랜잭션 한도 30M은 0.5절 배포, 리허설 gas limit 합계가 이 상한 안에 있는지 재검토할 근거가 된다. 현재 표의 개별 항목(레지스트리 배포 2.0M, 샘플 볼트 배포 1.5M 등)은 30M 한도에 전혀 걸리지 않으므로 문제 없다.
