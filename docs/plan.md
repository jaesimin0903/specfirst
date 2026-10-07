# Specfirst 구현 계획

## 개정 4판 변경 요약 (2026-10-07)

이 판은 계획을 다시 쓰지 않고 바뀐 것만 적는다. 아래 상태 줄과 0~9절은 개정 3판(2026-09-29) 당시의 계획이다. 이 요약이나 ADR과 어긋나면 이 요약과 ADR을 따른다. 제출물은 이제 `docs/submission.md`에 적힌 것이고, 결과 숫자는 `docs/board-results.md`에 있다.

| 날짜 | 변경 | 근거 |
|---|---|---|
| 9/29 | 사용자가 쓴 스펙 대신, 이미 배포된 컨트랙트를 제3자 표준 속성으로 검사하는 쪽으로 전환. a16z/erc4626-tests 26개와 Specfirst 고유 `sf-max*-honored` 4개를 고정 블록 forge fork에서 실행(`specfirst check`). 검사받는 쪽이 자기 시험을 쓰지 않는다 | ADR 0003, `docs/spike-standard-properties.md` |
| 9/30 | 메인넷 결과를 테스트넷에 기록하는 `CheckAttestationRegistry`(reportHash, suiteHash, 대상 코드 해시, 블록, `isCompliant`와 `isCompliantWith`). 같은 날 메인넷 ERC-4626 볼트 285개 첫 전수 검사, 증명 18건 | ADR 0004, `docs/board-results.md` |
| 9/30~10/1 | 유료 검사 요청 `CheckRequestDesk`와 무인 worker. 수수료는 이행된 뒤에만 수익이 되고, 처리하지 못한 요청은 전액 환불. 10/1 테스트넷 배포, 실제 요청 2건 이행 | ADR 0005 |
| 10/6 | "체인이 입구" 전환. watcher(`specfirst watch`)가 팩토리 이벤트, 모르는 주소의 첫 `Deposit`, 업그레이드로 새 볼트를 스스로 찾아 검사하고, 바뀐 결과는 나중 블록의 두 번째 검사로 확인한 뒤 예산 안에서 증명. 하루 단위 선불 알림 구독 `CheckSubscriptions`와 webhook | ADR 0006 |
| 10/7 | 비동기 출금 볼트 라벨(`async-redeem` trait, 판정은 바꾸지 않음), 지분 가치 하락 알림, 등록부를 읽어 돈을 움직이는 데모 통합자 `AllocationGate`(테스트넷 배포), 현황판의 EIP-4626 MUST와 SHOULD 수준, sf 속성이 매 실행마다 상한 자체를 시도, fork에 없는 Monad precompile에 닿은 입력은 판정하지 않음 | ADR 0003, 0006, 0007 |

### 대체된 절

- **3.1 스펙 파일 포맷, 3.3 수정 루프와 lock, 결정 B(수정 에이전트)**: 사용자가 YAML 스펙을 쓰고 에이전트가 반례를 고치는 흐름은 제출물에서 빠졌다. 검사 대상은 남이 배포한 볼트이고 속성은 제3자 스위트다. `init`, `lock`, `run` 코드는 저장소에 남아 있다.
- **3.4 `CertificateRegistry` 증명서, 3.7 버전 계보와 실효 시연**: `CheckAttestationRegistry`의 검사 증명으로 바뀌었다(ADR 0004). 통합자는 `isCertifiedWith` 대신 `isCompliant`나 `isCompliantWith`를 읽는다. `CertificateRegistry.sol`, 증명서 페이지 `/c/<address>`, `/api/cert`는 저장소에 남아 있지만 제출물이 아니다.
- **3.6 배포, 리허설, 배포 후 대조**: 자기 컨트랙트를 배포하고 대조하는 경로는 데모에서 빠졌다. 고정 블록 forge fork에서 속성을 돌리는 방식(ADR 0001)은 `check`가 이어받았다.
- **3.8 어그리게이터 통합과 L0~L3 접촉 판정**: 접촉 판정 대신, 등록부를 직접 읽는 `AllocationGate`가 "누가 이 증명을 읽는가"에 답한다. `docs/bd-log.md`에는 9/29 초안 두 건만 있다. 9/29에 만든 모의 카드 페이지 `/demo/aggregator`는 저장소에 남아 있지만 제출물이 아니고, `CertifiedVaultRouter`는 만들지 않았다.
- **3.9 GitHub Action**: 제출물에서 빠졌다. `action/`의 composite action은 저장소에 남아 있다.
- **4 마일스톤, 7 스코프 컷 규칙의 제출물 번호 D1~D8, 데모 대본**: `docs/submission.md`의 제출물과 `docs/demo-script.md`의 대본으로 바뀌었다.

### 지금의 제출물

`docs/submission.md`가 기준이다. `specfirst check`, `specfirst watch`, `specfirst worker`, 컨트랙트 넷(CheckAttestationRegistry, CheckRequestDesk, CheckSubscriptions, AllocationGate)과 데모 볼트 팩토리와 토큰, 웹(현황판, 볼트 페이지, watcher 피드, 알림 수신함, 데스크, 게이트), 볼트별 JSON API와 SVG 배지.

### 남은 일정 (마감 2026-10-13)

- 웹 배포: 사용자가 맡는다. 배포 주소가 나오면 제출 문서의 자리표시자를 채운다.
- GitHub 공개 push `jaesimin/specfirst`: 증명의 reportURI가 `https://raw.githubusercontent.com/jaesimin/specfirst/main/certs/checks/...`를 가리키므로, push 전에는 등록부의 보고서 링크가 열리지 않는다. `certs/checks/` 사본을 함께 push한다.
- 최종 녹화(`docs/demo-script.md`)와 제출: 2026-10-13까지.

---

- 상태: **approved 2026-09-29, week 1 code complete on anvil** (ADR 0001 fork 주 경로, ADR 0002 블록 번호 캐시. 키 필요 작업만 남음: 테스트넷 배포, 키 필요 실측, Ultrafuzz VM, 어그리게이터 발송) (사용자 승인: A3, B2, C1, D2, 예산 기본값, 데모 (a) 버전 대체, ultrawork 착수) (개정 3판, Architect와 Critic 2회차 검토 반영. 저장소는 공개가 기본값)
- 작성일: 2026-09-28 (월)
- 대회: Monad Metropolis 트랙 4, 제출 마감 2026-10-13 (화), 1인 팀, 남은 기간 15일
- 저장소: `~/Developer/Personal/specfirst` (신규. portfolio-slides에는 만들지 않는다)
- 원천 기획: scratchpad `specfirst.html`
- 이 문서는 계획만 담는다. 승인 전 코드 작성 없음.

## 개정 2판 변경 요약

| 피드백 | 반영 위치 |
|---|---|
| 1. 코드 해시 "자동 실효"를 "무결성 고정"으로 격하, projectId와 supersededBy 계보, revoke는 위반 근거 있을 때만, EIP-6780 스파이크 | 1 결정 C, 3.4, 3.7, 4 (9/28, 10/6), 4 데모 대본 |
| 2. 어그리게이터 통합 마일스톤, REST, 발급 목표, 모의 카드 | 3.8, 4 (9/29, 10/2, 10/8), 7 |
| 3. 온체인 대조를 잠긴 Solidity 속성의 fork 실행으로 단순화 | 1 결정 D, 3.6 |
| 4. Ultrafuzz를 "사람 미검수 보조 캠페인"으로 분리, campaignSeconds 온체인 제거 | 1 결정 A, 3.5 |
| 5. isCertifiedWith, 뮤턴트 검사 필수 | 3.1, 3.4 |
| 6. lock 범위 확대, worktree, untracked 포함 허용목록, 환경 분기 경고 | 3.3 |
| 7. Action은 검증과 발급만, 자격증명 정리 | 3.9 |
| 8. revert 기대 tx 고정 gas limit | 3.6, 6.2 |
| 9. 일정 과밀 해소, 동결 10/10, 버퍼일, 가치 순 컷 | 4, 7 |
| 10. 수용 기준, 예산 숫자, MON 추정, 제출물 번호 | 0.4, 3.1, 4, 7 |
| 11. 기본 공격자 액터 | 3.1 |
| 권장 항목 | 1 결정 C (C3 사유), 5, 6 |

## 개정 3판 변경 요약

| 2회차 피드백 | 반영 위치 |
|---|---|
| 1. isCertifiedWith 기준을 invariantSetHash로, propertyHash 필드 | 3.1, 3.4, 3.8, 4 (9/29) |
| 2. Superseded여도 isCertified true, isLatest 분리, partial은 Valid 대체 불가, Superseded도 근거 있으면 revoke | 1 결정 C, 3.4, 3.7, 6.1 |
| 3. 발급 목표 3건과 외부 요청 기록, 도그푸딩 삭제, 접촉 성공 정의, Router 컷 | 3.8, 4, 5, 7 |
| 4. fork 블록 고정 문제에 latest 치환 RPC 프록시 1차 대체, SpecfirstProps 공유 라이브러리, Probe는 원칙 4 예외 | 1 원칙 4, 2, 3.1, 3.3, 3.6 |
| 5. INV-1 ghost를 Deposit 이벤트 전체 예치자 집합으로 | 3.6, 6.2 |
| 6. revert 기대 tx는 gasUsed < gasLimit, fork에서 selector 재현 | 3.6, 6.2 |
| 7. Ultrafuzz 재현 PoC 회귀 규칙, materialize 스파이크 | 3.5, 4 (9/29), 6.2 |
| 8. 샘플 반례 기대 INV-1~4 통일 | 3.1, 4 (10/1) |
| 9. 뮤턴트 문구 | 3.1 |
| 10. 예산 강제 방법 정정 | 0.4 |
| 11. 승인 요청 정리, 10/6 컷 조건문 삭제, 저장소 공개 기본 | 7, 9 |
| 권장 | 6.1 레지스트리 테스트 2건, 6.2 배지와 위젯 스냅샷, 9/28 일부를 9/29로 |

---

## 0. 전제

### 0.1 Ultrafuzz (monad-developers/ultrafuzz, MIT, TypeScript, 2026-09-25 갱신)
- 에이전트 오케스트레이터다. Smithers 워크플로 엔진 위에서 Codex, Claude Code(`claude --print`), OpenRouter 등 에이전트가 전략별 퍼즈 테스트를 작성하고 Foundry로 실행한 뒤 `findings.json`(`ultrafuzz/findings@2`)과 최종 리포트를 남긴다.
- 요구 환경: Node 22.19+, pnpm 11.1.1, Bun 1.3+, Foundry, 에이전트 CLI와 자격증명.
- 공식 보안 권고: 에이전트가 skip-permissions로 돌기 때문에 **일회용 격리 VM에서만** 실행.
- 프로파일별 상한: smoke 14,400초, low-cost 43,200초, default 최종 캠페인 1시간, invariant-only 스모크 600초와 퍼저 3,600초, exhaustive 최종 캠페인 4시간.
- 설정 우선순위: `기본값 < 감사 프로파일 < 프로젝트 설정 < CLI 오버라이드`. 퍼저 타임아웃은 600초로 낮출 수 있으나 에이전트 노드 시간은 별도.
- 자동화: `run --json`, `status <run-id> --json --watch`, `report`, `stats --json`, `resume`, `cancel <run-id>`(문서상 run을 영구 중단), `materialize`. 스키마 목록에 `invariant-suite-handoff`가 있어 외부 invariant 스위트 주입 경로가 있을 가능성이 있다(1일차 확인 대상).
- 발견물 status: candidate, needs-review, duplicate, false-positive, confirmed, fixed, wont-fix. 이 판정은 Ultrafuzz 내부 에이전트 트리아지 결과이지 사람 검수가 아니다.

### 0.2 Monad 테스트넷
- chain id `10143`. RPC 한도: QuickNode `testnet-rpc.monad.xyz` 50 rps(eth_call, estimateGas 25 rps), Ankr 300 req/10s, Foundation `rpc-testnet.monadinfra.com` 20 rps.
- 가스는 **gas limit 기준 차감**. revert되어도 limit 전액이 나간다.
- 코드 크기 128KB, initcode 256KB. 블롭 tx 불가. 전역 멤풀 없음.
- Reserve balance 10 MON은 EIP-7702 위임 EOA 규칙. 배포, 발급 키는 위임하지 않은 순수 EOA.
- 풀노드는 **임의 과거 상태를 제공하지 않는다**. 최근 몇 블록까지 상태 조회가 되는지는 문서에 없다(1일차 실측).
- eth_getLogs: QuickNode와 Foundation 100블록, Ankr와 Alchemy 1,000블록.
- `debug_traceTransaction`은 trace options 명시 필수(생략 시 `-32602`), 기본 tracer는 callTracer.
- eth_estimateGas provider 한도 기본 30M, 8.1M 이하는 고처리량 풀.
- EIP-7825(트랜잭션당 16,777,216 가스)와 EIP-6780(SELFDESTRUCT 제한) 적용 여부는 문서에서 확인하지 못했다. 둘 다 1일차 실측.
- MIP-16은 PR 리뷰 단계라 사용하지 않는다.

### 0.3 ERC-8004, EAS
- ERC-8004 검증 레지스트리는 agentId 키. 컨트랙트 주소 조회와 코드 해시 고정을 표현하지 못한다.
- EAS: Monad 테스트넷 배포 미확인. 대체, 실효 규칙이 스키마 밖이라 어그리게이터 쪽 "통합 두 줄"이 성립하지 않는다.

### 0.4 예산 기본값 (사용자 확정 필요)

| 항목 | 기본 상한 | 강제 방법 |
|---|---|---|
| Ultrafuzz 격리 VM 합계 | 30 USD | 클라우드 예산 **알림 후 수동 폐기**. 자동 중단 아님 |
| Ultrafuzz 에이전트 비용 합계 | 120 USD (캠페인당 40 USD) | 어댑터가 `stats --json`을 폴링하다 한도 도달 시 `cancel <run-id>` 호출. `cancel`이 진행 중 에이전트 과금을 실제로 멈추는지는 9/29 스파이크에서 확인하고, 안 멈추면 알림 후 수동 VM 폐기로 격하 |
| Specfirst 수정 루프 run당 | 5 USD | Claude CLI JSON 봉투의 `total_cost_usd` 누적, 다음 호출 전 검사해 자동 중단 |
| Specfirst 에이전트 전체 기간 합계 | 60 USD | `.specfirst/budget.json` 누적, 초과 시 자동 중단 exit 15 |

### 0.5 테스트넷 MON 필요량 추정
가스 가격 P는 9/28 실측으로 교체한다. 아래는 P = 100 gwei 가정.

| 항목 | gas limit 합 | 횟수 | 소계 |
|---|---|---|---|
| 레지스트리 배포(재배포 1회 포함) | 2.0M | 2 | 4.0M |
| 샘플 볼트 배포 | 1.5M | 8 | 12.0M |
| 리허설 30건(정상 25건 x 200k, revert 기대 5건 x 80k 고정) | 5.4M | 8 | 43.2M |
| 발급, 대체, revoke | 0.5M | 8 | 4.0M |
| 스파이크, 디버깅 여유 | | | 20.0M |
| 합계 | | | 약 83M gas = **약 8.3 MON** |

8회 = E2E 3회 + 버전 교체 발급 3회 + 데모 녹화 2회. 예치 원금은 리허설 뒤 회수. P가 200 gwei면 약 17 MON. **10/2까지 25 MON 확보**를 목표로 9/28부터 파우셋을 매일 받는다.

---

## 1. RALPLAN-DR 요약

### 원칙
1. **정직한 증명서.** 통과한 것만 통과, 못 한 것은 미검증. 숫자는 실제 산출물에서만. 사람이 검수하지 않은 결과는 검수한 결과와 섞지 않는다.
2. **에이전트는 구현만 바꾼다.** 속성, 빌드 설정, 의존성은 사람이 승인하고 해시로 잠근다.
3. **끝까지 이어진 얇은 한 줄 먼저.** 1주차에 스펙에서 온체인 증명서까지 관통.
4. **번역은 한 번.** 자연어 불변식은 Solidity 속성 식 라이브러리 `SpecfirstProps.sol`로 한 번만 번역하고, 퍼징과 배포 후 대조가 같은 식을 쓴다. **명시 예외**: fork가 불가능할 때 쓰는 `SpecfirstProbe`는 별도 파일이지만 식은 `SpecfirstProps`를 호출만 하고 새로 번역하지 않으며, lock 대상에 포함한다.
5. **체인이 근거.** 웹과 REST는 레지스트리와 해시 고정 리포트를 보여주는 창일 뿐 판정 로직이 없다.

### 결정 동인 top 3
1. **15일, 1인, 버퍼 부족.** 같은 기간에 면접과 지원이 진행 중이다. 첫 주에 E2E가 안 돌면 제출작이 없다.
2. **데모 가능 시간.** 3분 안에 반례, 수정, 재퍼징, 배포, 발급, 어그리게이터 노출이 보여야 한다.
3. **신뢰 서사의 성립.** 미검증 명시, 버전 계보, 누군가 증명서를 읽는 장면이 실제로 동작해야 한다.

### 결정 A: 퍼징 백엔드

| 옵션 | 장점 | 단점 |
|---|---|---|
| A1. Ultrafuzz를 수정 루프 전체에 사용 | 트랙 서사와 일치 | 반복 1회가 수십 분 이상. 격리 VM 필수. 5회 루프 부적합 |
| A2. 잠긴 Foundry invariant 속성만 `forge test` | 반복 수 분, seed 재현, 반례 시퀀스가 forge 출력에 그대로 | Ultrafuzz 연결이 약함, 전략 다양성 없음 |
| **A3. 혼합 (선택)** 판정은 A2, Ultrafuzz는 **사람 미검수 보조 캠페인** | 판정 근거가 결정론적이고 사람 승인 속성에 묶임. Ultrafuzz는 추가 탐색으로 서사 유지 | 어댑터 두 개, 발견물 처리 규칙 필요 |

**선택 근거.** 동인 1, 2 때문에 판정은 forge. 동인 3 때문에 Ultrafuzz를 유지하되 **passedBitmap과 isCertified 판정에는 넣지 않는다**. 1일차 스파이크의 판정 질문은 하나로 좁힌다: **"기존 invariant 테스트 파일을 캠페인 대상으로 지정할 수 있는가"**.
- 가능하면: 잠긴 속성을 Ultrafuzz에 그대로 먹인다. 매핑 문제가 사라지고, 결과는 같은 불변식 ID로 report의 "보조 캠페인" 칸에 기록.
- 불가능하면: Ultrafuzz는 자유 탐색으로 돌리고 report의 "추가 탐색" 칸에만 기록. 불변식 ID 매핑을 시도하지 않는다.
- 처리 규칙은 3.5.

### 결정 B: 구현, 수정 에이전트

| 옵션 | 장점 | 단점 |
|---|---|---|
| B1. Claude API 직접 호출 | 입출력 통제, 계측 쉬움, CI 설치 불필요 | 편집, 빌드 도구 루프를 직접 구현해야 함 |
| **B2. Claude Code CLI 헤드리스 (선택)** `claude -p --output-format json`, 별도 git worktree, `--allowedTools` 제한 | 편집과 빌드 루프 기성품. 기존 하네스 경험 재사용. Ultrafuzz ClaudeAgent와 인증 공유 | 비결정적. CLI 버전 의존 |
| B3. Ultrafuzz 에이전트에 구현 위임 | 도구 하나 | 5회 상한, 파일 제한 강제 불가 |

**선택 근거.** 동인 1. 결과는 항상 우리 코드가 worktree에서 수거해 검사한다(3.3). report에 CLI 버전과 모델, 비용을 기록한다. 모델 기본 `claude-sonnet-5`, 3회차부터 `claude-opus-5-5`.

### 결정 C: 증명서 저장소

| 옵션 | 장점 | 단점 |
|---|---|---|
| **C1. 자체 레지스트리 (선택)** | `isCertified`, `isCertifiedWith(address, invariantSetHash)`를 view 한 번으로. 발급 시 `target.codehash`를 온체인에서 읽어 **무결성 고정**(증명서가 가리키는 바이트코드가 발급 대상과 같음을 누구나 확인). `projectId`, `supersededBy`, `isLatest`로 버전 계보를 온체인 표현 | 비표준. 발급자 신뢰는 Specfirst 키 하나 |
| C2. ERC-8004 Validation Registry | 표준 서사 | agentId 키라 주소 조회와 코드 해시 고정 불가. Monad 테스트넷 배포본 미확인 |
| C3. EAS | 스키마 유연 | Monad 테스트넷 배포 미확인. 대체, 실효 규칙이 스키마 밖이라 통합 두 줄이 안 됨 |

**선택 근거.** 동인 1, 3.

**서사 정정.** 비업그레이드형 컨트랙트는 EIP-6780 이후 같은 주소의 코드가 사실상 바뀌지 않는다. 따라서 "코드가 바뀌면 자동 실효"는 과장이다. 실제 구조는 셋이다.
1. **무결성 고정**: codehash는 증명서와 바이트코드를 묶는다. 조회 시 불일치면 false(6780 미적용 체인이나 SELFDESTRUCT 재배포 방어).
2. **버전 대체**: 코드를 고치면 새 주소가 생기고, 같은 projectId로 새 발급하면 이전 증명서는 온체인에서 `Superseded`가 되고 `supersededBy`가 새 주소를 가리킨다. **Superseded는 실효가 아니다.** `isCertified`는 코드에 대한 진실만 판정하므로 이전 주소도 여전히 true이고, 최신 여부는 `isLatest`와 `currentTargetOf`로 따로 묻는다.
3. **명시 revoke**: 배포 후 대조가 실제 위반을 잡았을 때만. 최신이든 Superseded든 근거가 있으면 가능. 사유 해시와 위반 근거 리포트를 함께 남긴다.
- 로드맵 한 줄: projectId 소유 바인딩(첫 발급 요청자 서명으로 projectId 선점, 타인의 같은 projectId 발급 거부)은 해커톤 범위 밖.

### 결정 D: 배포 후 대조 방법

| 옵션 | 장점 | 단점 |
|---|---|---|
| D1. 불변식별 TS 체커 생성 (1판) | 체인 데이터 직접 해석 | 자연어 번역 두 번, 잠글 대상 두 배, 체커 자체 검증 필요 |
| **D2. 잠긴 Solidity 속성을 latest 블록 fork에서 배포 주소 대상으로 실행 (선택)** | 번역 한 번. 퍼징과 같은 속성. 실제 배포 상태에서 짧은 fork 퍼징까지 가능 | fork가 RPC를 많이 부른다. 과거 상태 미제공이라 fork 블록이 금방 낡을 수 있음 |

**선택 근거.** 원칙 4, Architect S1. 권한 불변식은 리허설 receipt의 revert 여부(가스 부족과 구분)와 이벤트 부재로 확인. trace는 선택 기능이다. forge fork는 시작 블록을 고정하는데 Monad는 블록이 빨라 그 블록이 곧 과거 상태가 되므로, 1차 대체로 **블록 파라미터를 latest로 치환하는 로컬 JSON-RPC 프록시**, 2차 대체로 `SpecfirstProbe`를 둔다(3.6).

### 확정 사항
- **비업그레이드형만 지원.** 증명서 미검증 목록에 "업그레이드 가능 프록시", "배포 후 상태 변경"을 기본 포함.
- 스택: pnpm 워크스페이스 TypeScript, commander + zod + viem + execa, Foundry, Next.js App Router, Vercel 기본 도메인.
- 리포트 JSON: `certs/10143/<address>/<certId>.json` 커밋, 커밋 SHA 고정 raw URL이 `reportURI`, keccak이 `reportHash`.

---

## 2. 저장소 구조

```
specfirst/
  package.json               scripts: build, test, lint, check:chars, e2e:testnet
  packages/
    core/
      src/spec/              스펙 파서(zod), specHash
      src/lock/              lock 생성과 검사 (속성, foundry.toml, remappings, lib 커밋, solc)
      src/agent/             ImplAgent, ClaudeCodeAgent(worktree), ReplayAgent
      src/fuzz/              FuzzBackend, ForgeBackend, UltrafuzzBackend, MockBackend
      src/mutants/           불변식별 뮤턴트 검사
      src/loop/              수정 루프 상태기계
      src/deploy/            forge create 래퍼, 가스 정책
      src/rehearse/          리허설 실행기 (정상 tx, revert 기대 tx 고정 gas)
      src/verify/            fork 속성 실행, latest 치환 RPC 프록시(약 50줄), 예치자 집합 수집, receipt와 이벤트 검사, trace(선택)
      src/cert/              report 빌더, 레지스트리 클라이언트
      src/budget/            비용 누적과 상한
    cli/                     init, lock, run, deploy, verify, cert, status
    contracts/               CertificateRegistry.sol, 테스트, 스크립트
    web/                     /c/[address], /api/cert/[address], /badge/[address].svg, /demo/aggregator, widget.js
  action/                    composite GitHub Action (검증과 발급 전용)
  examples/staking-vault/    샘플. 별도 공개 저장소 specfirst-example-vault로도 미러 (Action 대상)
  certs/10143/
  scripts/check-chars.sh
  docs/                      ADR, spike-monad.md, spike-ultrafuzz.md, e2e-log.md, bd-log.md, demo-script.md
```

사용자 프로젝트에 생기는 것:
```
spec/*.spec.yaml
test/specfirst/{SpecfirstProps.sol, Handler.sol, Invariants.t.sol, Attacker.sol, SpecfirstProbe.sol, regressions/}   전부 잠김
.specfirst/lock.json | .specfirst/budget.json
.specfirst/runs/<runId>/{run.json, iter-N/, mutants.json, deploy.json, rehearsal.json, verify.json, report.json}
```

---

## 3. 인터페이스

### 3.1 스펙 파일 포맷과 샘플 확정본

```yaml
specfirst: 1
name: StakingVault
projectId: "github.com/jaesimin/specfirst-example-vault#StakingVault"   # keccak256 해서 온체인 projectId
contract:
  path: src/StakingVault.sol       # 있으면 구현 단계 건너뜀
  name: StakingVault
  constructorArgs: ["$DEPLOYER"]
  editable: ["src/"]               # 에이전트가 만들거나 고칠 수 있는 디렉터리. 이 밖은 전부 거부
solc: "0.8.28"
actors:                            # 퍼징 핸들러와 리허설이 공유
  users: 3
  owner: "$DEPLOYER"
  attacker: true                   # 기본 공격자 액터 생성 (receive 훅에서 대상 함수 재호출)
invariants:
  - { id: INV-1, kind: invariant,     text: "총 예치량은 모든 사용자 예치 잔고의 합과 같다" }
  - { id: INV-2, kind: invariant,     text: "금고가 가진 MON은 모든 사용자 예치 잔고의 합 이상이다" }
  - { id: INV-3, kind: postcondition, text: "출금하면 사용자 예치 잔고는 정확히 출금액만큼 줄고, 받은 MON도 출금액과 같다" }
  - { id: INV-4, kind: access,        text: "누구도 자기 예치 잔고보다 많이 출금할 수 없다" }
  - { id: INV-5, kind: access,        text: "소유자만 보상률을 바꿀 수 있다" }
  - { id: INV-6, kind: invariant,     text: "일시정지 중에는 예치가 성공하지 않는다" }
  - { id: INV-7, kind: access,        text: "소유자만 일시정지와 해제를 할 수 있다" }
unverified:
  - "오라클 가격 조작"
  - "외부 토큰 컨트랙트 결함"
  - "경제적 공격"
  - "배포 후 소유자 권한에 의한 상태 변경"
  - "업그레이드 가능 프록시"
rehearsal:
  normalTx: 25
  expectRevertTx: 5
```

- 퍼징 파라미터(runs, depth, 타임아웃)는 **스펙에 두지 않는다.** CLI 플래그로만 받고 기본값이 있으며, CLI가 `FOUNDRY_INVARIANT_RUNS` 등 환경변수로 주입한다. 실제 값은 report에 기록.
- `specHash = sha256(canonical JSON)`. 스펙 파일 전체. 주석, 공백 무관.
- `invariantSetHash = keccak256(canonical JSON)`. **불변식의 id, kind, text와 unverified 목록만** 포함. 이름, projectId, 액터 수, 리허설 건수가 바뀌어도 변하지 않는다. 어그리게이터가 "이 불변식 집합으로 검증된 볼트"를 고정하는 기준 해시다.
- `propertyHash = keccak256(lock된 test/specfirst/** 파일들의 경로 정렬 sha256 목록)`. `SpecfirstProps.sol` 포함. 어그리게이터가 속성 코드까지 고정하려면 이 값을 대조한다.
- **속성 구조**: 식은 `SpecfirstProps.sol`의 순수 함수 라이브러리(`function inv1(IVault v, address[] memory depositors) internal view returns (bool)` 형태)에만 둔다. `Invariants.t.sol`과 `SpecfirstProbe.sol`은 이 라이브러리를 호출만 한다. lock과 뮤턴트 검사는 라이브러리에 건다.
- **심는 버그(샘플 초기 구현)**: `withdraw(amount)`가 `uint256 bal = balances[msg.sender]`를 지역 변수로 읽고, MON을 먼저 전송한 뒤 `balances[msg.sender] = bal - amount`로 기록하며 `totalStaked -= amount`는 호출마다 수행한다. 공격자 receive 훅이 재호출하면 두 호출 모두 같은 `bal`을 읽어 **2회 지급, 1회 차감**이 된다(기획서 화면의 반례와 동일). 기대 반례는 **INV-1**(총 예치량이 잔고 합보다 작아짐), **INV-2**(MON이 잔고 합보다 작아짐), **INV-3**(받은 MON이 차감액의 2배), **INV-4**(자기 잔고보다 많이 출금) 네 개다. 10/1에 forge로 넷 모두 실제 실패를 확인해 기록한다.
- **기본 공격자 액터**: 속성 템플릿 `Attacker.sol`은 핸들러가 호출하는 모든 외부 호출 경로에서 receive와 fallback 훅으로 직전 대상 함수를 1회 재호출한다. 재진입 탐지가 스펙 작성자의 사전 지식에 의존하지 않게 하려는 장치다. 템플릿은 모든 프로젝트에 기본 포함.
- **뮤턴트 검사(필수, 강등 없음)**: `specfirst lock`은 불변식마다 "이 속성을 깨는 최소 뮤턴트 패치"를 요구하고(에이전트 생성 또는 사람 작성), 뮤턴트에서 해당 속성이 실제로 실패하는지 확인한다. 하나라도 실패하지 않으면 lock 거부, exit 3. 샘플 7개 전부 통과가 10/2 완료 기준이다.

### 3.2 핵심 TS 인터페이스

```ts
interface ImplAgent {
  implement(i: { spec: Spec; worktree: string }): Promise<AgentResult>;
  fix(i: { spec: Spec; worktree: string; counterexamples: Counterexample[]; history: IterationRecord[] }): Promise<AgentResult>;
}
type AgentResult = { diff: string; changedPaths: string[]; costUsd: number; model: string; cliVersion: string; transcriptPath: string };

interface FuzzBackend {
  readonly name: 'forge' | 'ultrafuzz' | 'mock';
  readonly role: 'judge' | 'auxiliary';          // forge와 mock만 judge
  run(i: { worktree: string; spec: Spec; params: FuzzParams; target?: Address; forkUrl?: string }): Promise<FuzzResult>;
}
type FuzzResult = {
  backend: string; wallclockSec: number; executions?: number;
  results: Array<{ invariantId: string; status: 'pass' | 'fail' | 'error'; counterexample?: Counterexample }>;
  extraFindings?: AuxFinding[];                  // auxiliary 전용
  rawArtifactPath: string;
};
type Counterexample = { invariantId: string; callSequence: string[]; reason: string; seed?: string; source: 'forge' | 'ultrafuzz-reproduced' };
```

### 3.3 수정 루프와 lock
- **lock 범위** (`.specfirst/lock.json`): `test/specfirst/**`(`SpecfirstProps.sol`, `SpecfirstProbe.sol`, `regressions/` 포함), `foundry.toml`, `remappings.txt`, `lib/` 서브모듈 커밋 해시(`git submodule status`), solc 버전, 스펙 파일, specHash. `run` 시작 시 불일치면 exit 11. **specHash가 lock과 다르면 run 거부.** lock에는 invariantSetHash와 propertyHash도 기록해 발급 시 그대로 온체인에 올린다.
- **에이전트 격리**: 매 반복을 별도 `git worktree`에서 수행. 반복 종료 후 `git status --porcelain --untracked-files=all`과 `git diff`로 변경 전체를 수거한다. untracked 포함 모든 변경 경로가 `contract.editable` 안에 있어야 하고, 아니면 그 반복을 폐기하고 실패로 센다.
- **환경 분기 경고**: diff 추가 줄에 `block.chainid`, `block.number`, `block.timestamp` 비교, `tx.origin`, `extcodesize`, `address(this).code` 분기가 **새로 생기면** 경고를 run 기록과 report에 남기고, 사람 확인 전 발급 보류.
- **종료 규칙**: 상한 5회. 같은 불변식의 같은 반례 시그니처 2회 연속, 빈 diff, 호출당 10분 타임아웃, run당 5 USD 초과 시 중단. 미통과 불변식은 기본 멈춤, `--allow-partial`이면 부분 증명서 발급(`isCertified` false).
- 반복마다 `iter-N/{counterexamples.json, diff.patch, fuzz.json, agent.json}` 기록.

### 3.4 증명서 레지스트리 `CertificateRegistry.sol`

```solidity
enum Status { None, Valid, Superseded, Revoked }

struct Certificate {
    bytes32 projectId;         // keccak256(스펙의 projectId 문자열)
    bytes32 specHash;          // 스펙 파일 전체
    bytes32 invariantSetHash;  // 불변식 id, kind, text와 unverified 목록만
    bytes32 propertyHash;      // lock된 test/specfirst 전체 (SpecfirstProps 포함)
    bytes32 codeHash;          // 발급 시 target.codehash를 온체인에서 읽음 (무결성 고정)
    bytes32 reportHash;
    uint64  issuedAt;
    uint16  passedCount;
    uint16  totalCount;
    uint256 passedBitmap;      // forge 판정만. Ultrafuzz 결과는 포함하지 않음
    uint32  rehearsalTxCount;
    Status  status;
    address supersededBy;      // 대체한 새 버전의 target
    bytes32 revokeReasonHash;
    string  reportURI;
}

event CertificateIssued(address indexed target, bytes32 indexed projectId, uint256 certId, bytes32 invariantSetHash, bytes32 propertyHash, bytes32 codeHash, bytes32 reportHash, uint16 passedCount, uint16 totalCount);
event CertificateSuperseded(address indexed oldTarget, address indexed newTarget, bytes32 indexed projectId);
event CertificateRevoked(address indexed target, uint256 indexed certId, bytes32 reasonHash, string evidenceURI);
event IssuerSet(address indexed issuer, bool allowed);

struct IssueParams {
    address target; bytes32 projectId; bytes32 specHash; bytes32 invariantSetHash; bytes32 propertyHash; bytes32 reportHash;
    uint16 passedCount; uint16 totalCount; uint256 passedBitmap; uint32 rehearsalTxCount; string reportURI;
}

function issue(IssueParams calldata p) external returns (uint256 certId);
// onlyIssuer. target.code.length > 0.
// 같은 projectId의 현재 target이 다른 주소면 그 증명서를 Superseded로, supersededBy = p.target, currentTargetOf 갱신.
// 같은 target 재발급(예: 같은 코드, 스펙 개정)도 허용하고 그 target의 이전 certId는 Superseded.
// 부분 증명서(passedCount < totalCount)는 Valid이면서 완전한 이전 버전을 대체하지 못한다: 그 경우 revert.
//   즉 --allow-partial 발급은 currentTargetOf를 바꾸지 않고, 이전 증명서도 Superseded로 만들지 않는다.
function revoke(address target, uint256 certId, bytes32 reasonHash, string calldata evidenceURI) external;
// onlyIssuer. 대상 certId가 Valid 또는 Superseded일 때 가능(Revoked 재실효 불가). 위반 근거 URI 필수(빈 문자열 거부).
function isCertified(address target) external view returns (bool);
// 코드 진실만 판정: 그 target의 가장 최근 증명서가 Revoked가 아니고(Valid 또는 Superseded),
// codeHash == target.codehash && passedCount == totalCount. Superseded여도 true.
function isCertifiedWith(address target, bytes32 invariantSetHash) external view returns (bool);
// isCertified 조건 + 그 증명서의 invariantSetHash 일치. 어그리게이터가 기대 불변식 집합을 고정해
// "약한 스펙으로 받은 증명서"를 거른다. 속성 코드까지 고정하려면 latest()의 propertyHash를 추가 대조.
function isLatest(address target) external view returns (bool);
// 그 target의 projectId에서 currentTargetOf(projectId) == target
function latest(address target) external view returns (uint256 certId, Certificate memory c, bool codeMatches);
function currentTargetOf(bytes32 projectId) external view returns (address);
function certificateOf(address target, uint256 certId) external view returns (Certificate memory);
function certificateCount(address target) external view returns (uint256);
function setIssuer(address issuer, bool allowed) external;       // onlyOwner
```

- campaignSeconds는 온체인에서 제거. 백엔드별 시간, 실행 수, 비용은 report JSON에만.
- **조작 방지 한계와 대응**: 개발자가 사소한 스펙으로 증명서를 받는 문제는 `isCertifiedWith(address, invariantSetHash)`, `propertyHash` 대조, 증명서 페이지의 불변식 원문 공개로 대응한다. specHash가 아니라 invariantSetHash를 기준으로 삼는 이유는, 이름이나 리허설 건수 같은 무관한 변경으로 어그리게이터 필터가 깨지지 않게 하려는 것이다. 어그리게이터가 카테고리별 기준 불변식 집합(예: "기본 볼트 불변식 v1")을 정하는 운영 모델은 제출 페이지 로드맵에 적는다.
- **어그리게이터 권장 조회 조합**: 노출 여부는 `isCertifiedWith`, 최신 버전 안내는 `isLatest`. Superseded 볼트도 코드가 검증된 사실은 변하지 않으므로 차단하지 않고 "새 버전 있음"만 표시한다.
- **신뢰 모델**: 발급자는 Specfirst 운영 키. 증명서는 "Specfirst가 이 리포트를 이 바이트코드에 대해 발급했다"는 주장이고, 리포트의 속성과 seed로 누구나 재현할 수 있다. 해커톤 범위에서 발급 키는 로컬 CLI와 샘플 저장소 Action(3.9)에서만 쓴다.

### 3.5 Ultrafuzz 보조 캠페인 처리 규칙
- 역할은 `auxiliary`. report의 "보조 캠페인, 사람 미검수" 칸에 백엔드, 프로파일, 실측 시간, 비용, 발견물 수를 status별로 적는다.
- 발견물 처리:

| Ultrafuzz status | 불변식 매핑(스파이크 가능 판정 시) | 처리 |
|---|---|---|
| confirmed, needs-review | 매핑됨 | 생성 PoC 테스트를 `materialize --dry-run` 경로로 격리 worktree에 복사해 forge로 **로컬 재현**. 재현되면 `ultrafuzz-reproduced` 반례로 수정 루프에 투입(발급 차단). 재현 안 되면 "미재현" 표기, 비차단 |
| confirmed | 매핑 안 됨 | 로컬 재현 시 발급 보류, 사람이 스펙에 불변식 추가할지 결정. 미재현이면 "추가 탐색" 표기 |
| needs-review | 매핑 안 됨 | "추가 탐색, 미검수" 표기, 비차단 |
| candidate | 무관 | 개수만 표기, 비차단 |
| duplicate, false-positive, wont-fix, fixed | 무관 | 개수만 |

- 판정 원칙: **forge로 재현되는 것만 차단한다.** Ultrafuzz 자체 트리아지 결과는 참고 정보다.
- **재현 PoC 회귀 규칙**: 로컬 재현된 PoC는 사람이 검토해 승인하면 `test/specfirst/regressions/UF-<finding-id>.t.sol`로 추가하고 `specfirst lock`을 다시 실행한다(재lock하면 propertyHash가 바뀐다). 이후 모든 run에서 회귀 테스트로 함께 돈다. 승인 전에는 수정 루프 반례로만 쓰고 lock에 넣지 않는다.
- **스파이크 확인 항목 (9/29)**: `materialize --dry-run`이 PoC 파일 내용을 실제로 산출하는지, 아니면 복사 계획만 보여주는지. 후자면 `.ultrafuzz/runs/<run-id>/artifacts/<node-id>/generated-tests/`에서 직접 읽어 격리 worktree에 복사한다.
- 600초 캠페인에서는 발견물 대부분이 candidate로 끝날 가능성이 높다. 그 경우 "보조 캠페인 실행됨, 재현된 문제 0건, 미검수 후보 n건"으로 정직하게 적는다.

### 3.6 배포, 리허설, 배포 후 대조
1. **배포**: `forge create`, gas limit = `estimateGas x 1.2`, 16,777,216 미만.
2. **리허설**: 스펙 `actors`와 같은 액터 구성(사용자 3, 소유자, 공격자 컨트랙트)으로 실제 tx 전송.
   - 정상 tx 25건: `estimateGas x 1.2`.
   - **revert 기대 tx 5건**(권한 없는 보상률 변경, 권한 없는 일시정지, 잔고 초과 출금, 일시정지 중 예치, 공격자 재진입 시도): estimateGas가 실패하므로 **고정 gas limit 80,000**으로 전송. 전액 과금 전제로 작게 잡는다.
   - 통과 조건은 셋 모두: receipt `status == 0`, **`gasUsed < gasLimit`**(가스 부족으로 인한 실패를 접근 제어 통과로 오판하지 않기 위함), 가능하면 **fork에서 같은 호출을 `eth_call`로 재실행해 기대 revert selector**(예: `OwnableUnauthorizedAccount`) 확인. selector 확인이 안 되면 report에 "selector 미확인"으로 표기.
   - 액터 주소 목록과 각 tx 해시, 블록 번호, gasUsed, gasLimit을 `rehearsal.json`에 기록.
3. **대조 1, fork 속성 실행 (주 경로)**: `forge test --fork-url <rpc> --match-path test/specfirst/Invariants.t.sol`을 환경변수 `SPECFIRST_TARGET=<배포 주소>`, `SPECFIRST_ACTORS=<액터 목록>`으로 실행. 속성 `setUp()`은 fork 모드에서 새로 배포하지 않고 배포 주소에 붙는다. 합산형 속성의 대상 집합은 리허설 액터 목록이 아니라 **배포 블록부터 `Deposit` 이벤트를 getLogs로 모은 전체 예치자 집합**(`SPECFIRST_DEPOSITORS`)으로 초기화한다. 제3자가 테스트넷 볼트에 예치해도 INV-1, INV-2 합계가 틀리지 않게 하려는 것이다. 잔고는 실제 상태에서 읽는다.
   - 상태형 불변식(INV-1, INV-2, INV-6)은 fork 시점 실제 상태에서 판정.
   - 사후조건형(INV-3, INV-4)은 fork 위에서 짧은 퍼징(기본 runs 32)을 돌려 실제 배포 상태에서 출발한 시퀀스로 판정.
   - RPC 절약: `--compute-units-per-second` 제한, Foundry RPC 캐시.
   - **블록 고정 문제**: forge fork는 시작 시 블록 번호를 고정하고 이후 그 번호로 상태를 요청한다. Monad는 블록이 빨라 그 블록이 곧 과거 상태가 되고 풀노드가 응답을 거부할 수 있다. 9/28 스파이크에서 "고정 블록으로 몇 초까지 조회되는가"를 잰다.
4. **대조 2, receipt와 이벤트**: 권한형(INV-4, INV-5, INV-7)은 revert 기대 tx의 receipt 실패와, 해당 블록 범위의 `RewardRateChanged`, `Paused` 등 이벤트 **부재**로 확인. `eth_getLogs`는 100블록 청크, 토큰 버킷 10 rps, 429 지수 백오프, RPC 폴백 목록.
5. **trace (선택, 2주차 여유 시)**: `debug_traceTransaction(tx, {tracer:"callTracer"})`로 재진입 프레임 부재를 보조 근거로 기록. 판정에는 쓰지 않는다.
6. **fork 대체 경로 (순서대로)**
   - **1차: latest 치환 RPC 프록시.** 로컬 JSON-RPC 프록시(약 50줄)가 `eth_getStorageAt`, `eth_getBalance`, `eth_getCode`, `eth_call`, `eth_getTransactionCount`의 블록 파라미터를 `latest`로 바꿔 Monad RPC에 전달하고, `eth_blockNumber`, `eth_getBlockByNumber`는 그대로 통과시킨다. forge는 프록시를 `--fork-url`로 쓴다. 대가로 fork 실행 중 블록 간 상태가 조금씩 섞일 수 있으므로, 대조 동안 리허설 tx를 보내지 않고 report에 "latest 치환 프록시 사용"을 표기한다. anvil을 원천으로 한 테스트에서 먼저 검증.
   - **2차: `SpecfirstProbe`.** 프록시로도 안 되면, 배포하지 않는 헬퍼의 생성자가 대상 주소와 예치자 집합을 받아 `SpecfirstProps` 식을 호출하고 결과를 반환하며, 이를 `to` 없는 `eth_call`(생성 코드 실행)로 latest 블록에서 돌린다. Probe는 원칙 4의 명시 예외이며 lock 대상이다. Monad에서의 동작 여부는 9/29 스파이크에서 확인. 이 경우 사후조건형은 리허설 receipt와 이벤트 금액 대조로 판정하고 report에 "fork 대조 미사용"을 표기한다.
7. 결과는 불변식별 `verify.json`에 근거(tx 해시, 로그 인덱스, fork 블록 번호)와 함께 기록.

### 3.7 버전 계보와 실효 시연
- **데모 주 경로 (a) 버전 대체**: 보상 로직 한 줄 수정 → `specfirst run` → 새 주소 배포 → 같은 projectId로 발급 → 이전 증명서 `Superseded`, `supersededBy`가 새 주소. 이전 주소의 `isCertified`는 여전히 true(그 코드는 검증됐다), `isLatest`는 false. 증명서 페이지는 이전 주소에서 "새 버전 있음" 배너와 링크를 보여주되 "실효"라고 쓰지 않는다.
- **보조 경로 (b) 위반 revoke (P2)**: 해커톤에서는 시연하지 않는 것이 기본. 시간이 남으면 스펙에 "보상률은 1,000bps 이하" 불변식을 두고 소유자 파라미터 변경을 퍼징 액터에서 제외한 뒤, 배포 후 소유자가 상한 초과 값으로 바꾸면 `specfirst verify` 재실행이 위반을 잡아 `revoke`하는 경로. 이것이 "배포 후 상태 변경"이 미검증 목록에 있는 이유를 보여준다.
- revoke는 위반 근거 없이는 CLI가 거부한다(`--evidence <verify.json>` 필수). Superseded된 옛 버전도 옛 주소에서 위반이 확인되면 revoke할 수 있다.

### 3.8 어그리게이터 통합
- **REST**: `GET /api/cert/[address]` 응답
  ```json
  { "address": "0x...", "chainId": 10143, "certified": true, "isLatest": true,
    "status": "valid|superseded|revoked|partial|none",
    "projectId": "0x...", "specHash": "0x...", "invariantSetHash": "0x...", "propertyHash": "0x...",
    "codeMatches": true, "passed": 7, "total": 7,
    "issuedAt": "2026-10-04T12:00:00Z", "supersededBy": null, "certificateUrl": "https://.../c/0x...", "reportUrl": "..." }
  ```
  체인에서 읽기만 한다. 60초 캐시.
- **위젯**: `<script src=".../widget.js" data-address="0x..."></script>` 한 줄. 상태, 불변식 개수, 발급 시점 세 가지만 표시하고, 최신이 아니면 "새 버전 있음" 표시. 클릭 시 새 탭으로 증명서 페이지.
- **통합 두 줄 예시** (README와 영상):
  ```solidity
  require(registry.isCertifiedWith(vault, BASIC_VAULT_INVARIANTS_V1), "uncertified");
  ```
  ```ts
  const ok = await registry.read.isCertified([vault]);
  ```
- **샘플과 라우팅의 결 맞추기**: 샘플은 풀이 아니라 볼트다. 따라서 어그리게이터 시나리오를 **"스테이킹 경로 선택 화면에서 볼트 노출"**로 설명한다. 모의 화면은 볼트 카드 두 장: 검증된 StakingVault v2, 버그 심은 v0을 그대로 배포한 "증명서 없음" 볼트. 풀 형태 두 번째 샘플은 **만들지 않는다**.
- **실제 접촉**: 9/29 Moose와 Kuru에 해커톤 멘토 채널과 Monad 디스코드로 제안 메시지(통합 두 줄, REST, 위젯). 10/2 후속. 10/8 판정. 모든 접촉과 응답을 `docs/bd-log.md`에 날짜별 기록.
- **10/8 판정의 성공 정의** (세 단계, 달성한 최고 단계를 제출 페이지에 그대로 적는다):
  - L1 답신: 담당자가 관심 또는 피드백을 회신. 인용은 허락받은 경우만.
  - L2 스테이징 적용: 상대 측 테스트넷이나 스테이징 화면에 위젯 또는 `isCertified` 조회가 실제로 붙음. **"통합 1곳" 주장은 L2 이상일 때만.**
  - L3 머지: 상대 저장소 또는 운영 화면에 반영.
  - L0(무응답)이나 L1이면 아래 모의 카드로 시연하고, 영상과 제출 페이지에 "모의 화면"이라고 명시한다.
- **실패 시 대체 경로**: `/demo/aggregator` 모의 스테이킹 경로 선택 카드 페이지에 위젯 적용 (10/8 필수 산출물).
- **`CertifiedVaultRouter`는 컷.** 이유 둘. 발급 키 하나가 revoke로 라우터 전체 예치를 멈출 수 있는 단일 스위치가 되는 한계가 있고, 10/10 동결일 이후에 배치돼 일정과 모순된다. 로드맵에 한계와 함께 한 줄로만 적는다.
- **발급 목표 (10/13 기준)**: **발급 3건**(샘플 v1 10/4, 샘플 v2 10/6, Action 경유 v3 10/9). 외부 발급 요청은 목표치 대신 **건수를 기록**한다(10/5부터 참가팀 5곳에 무료 발급 제안, 요청과 처리 결과를 `bd-log.md`에). 기획서 진입 순서 1단계 기준(통합 1곳, 발급 10건)과 실제 달성치를 제출 페이지에 나란히 적는다.

### 3.9 GitHub Action 범위와 자격증명
- **검증과 발급 전용. 수정 루프 비활성.** 따라서 Claude 자격증명이 필요 없다.
- PR: `specfirst run --no-deploy --no-agent`(lock 검사, 뮤턴트 검사 생략, forge 판정)만 실행, 결과를 PR 코멘트로.
- main 머지: 배포, 리허설, 대조, 발급. 배포 키와 발급 키는 저장소 secret이며 **GitHub environment 보호 규칙(수동 승인)** 아래서만 노출.
- **범위 한정**: 해커톤에서는 자기 샘플 저장소 `specfirst-example-vault` 한정 데모다. 발급 키를 외부 저장소에 줄 수 없으므로, 외부 저장소 지원은 "Action이 report를 발급 서비스에 제출하고 서비스가 재현 후 발급"하는 구조로 로드맵에만 적는다. 3.4 신뢰 모델과 정합: 발급 주체는 여전히 Specfirst 키 하나.

### 3.10 CLI 명령별 입출력

| 명령 | 입력 | 출력 | 종료 코드 |
|---|---|---|---|
| `specfirst init` | 대상 디렉터리, 스펙 | 속성 초안(Handler, Invariants, Attacker 템플릿) | 0, 스펙 오류 2 |
| `specfirst lock` | 속성, 뮤턴트 | `.specfirst/lock.json`, `mutants.json` | 0, 뮤턴트 검사 실패 3 |
| `specfirst run <spec> [--no-deploy] [--no-agent] [--allow-partial] [--aux ultrafuzz] [--runs N --depth N --timeout S] [--json]` | 스펙, lock | 진행 로그, run 디렉터리, `--json`이면 NDJSON 이벤트 | 0, 10 루프 소진, 11 lock 또는 specHash 불일치, 12 배포 실패, 13 대조 실패, 14 발급 실패, 15 예산 초과 |
| `specfirst deploy <spec> --run <id>` | 통과 run | `deploy.json` | 0, 12 |
| `specfirst verify <address> --run <id>` | 배포 주소, 리허설 기록 | `verify.json` | 0, 13 |
| `specfirst cert issue --run <id>` | run 산출물 | `report.json`, 발급 tx, 페이지 URL | 0, 14 |
| `specfirst cert revoke <address> --evidence <verify.json>` | 위반 근거 | revoke tx | 0, 14 |
| `specfirst status <address> [--invariant-set-hash H]` | 주소 | isCertified, isCertifiedWith, isLatest, latest 요약(invariantSetHash, propertyHash 포함), 계보 | 0 |

report JSON에는 CLI 버전, Foundry 버전, 모델명, Claude CLI 버전, 퍼징 파라미터, 반복 이력, 비용, 보조 캠페인 요약, 환경 분기 경고가 들어간다.

---

## 4. 마일스톤

오늘 9/28은 월요일. 동기간 면접과 지원 일정이 있으므로 **10/4 오후 반나절과 10/11 하루를 명시 버퍼**로 둔다. 기능 동결은 **10/10**.

### 1주차 (9/28 월 ~ 10/4 일)

| 날짜 | 작업 | 검증 가능한 완료 기준 |
|---|---|---|
| 9/28 | 저장소(공개), 워크스페이스, `check:chars`. 파우셋 시작. **Ultrafuzz 스파이크**: 격리 VM 생성, 설치 스크립트, 토이 컨트랙트에 기존 invariant 테스트 파일 두고 `invariant-only` + 퍼저 600초로 run 시작. **Monad 스파이크 전반**: 더미 배포, codehash, 100블록 getLogs, **forge fork 실행과 고정 블록 조회 가능 시간 측정**, 가스 가격 실측 | `docs/spike-monad.md`에 항목별 결과와 tx 링크. **`ultrafuzz status <id> --json` 출력 원문을 `docs/spike-ultrafuzz.md`에 저장**. 0.5 표의 P 값 교체 |
| 9/29 | **Monad 스파이크 후반**(9/28에서 이월): EIP-6780 실측(생성 tx 밖 SELFDESTRUCT 후 코드 잔존), 16.7M 초과 gas tx, callTracer trace, `to` 없는 eth_call(Probe 방식). Ultrafuzz 결과 수거와 판정 질문 답("기존 invariant 파일 지정 가능?"), `materialize --dry-run` PoC 산출 여부, `cancel` 과금 중단 여부. 레지스트리 작성(invariantSetHash, propertyHash, isLatest, 계보, partial 대체 금지)과 forge 테스트. 어그리게이터 2곳 제안 발송 | spike 두 문서에 판정과 근거, 벽시계 시간, `stats --json` 비용. `forge test` 통과, 커버리지 90%+. `bd-log.md` 발송 기록 2건 |
| 9/30 | 레지스트리 테스트넷 배포. 스펙 파서, specHash, lock(확대 범위) | 레지스트리 주소와 tx가 README에. vitest 파서와 lock 테스트 통과 |
| 10/1 | 샘플 StakingVault: `SpecfirstProps` 7개 식, Handler, Attacker 템플릿, 버그 심은 구현. 이것만 한다 | 버그 구현에서 forge가 **INV-1, INV-2, INV-3, INV-4** 반례 출력. 고친 구현에서 7/7 통과 |
| 10/2 | 뮤턴트 검사, ForgeBackend 파서, ClaudeCodeAgent(worktree), 루프 상태기계. 어그리게이터 후속 연락 | 샘플 7개 뮤턴트 전부 해당 속성 실패 확인(`mutants.json`). MockBackend 루프 테스트 통과. 25 MON 확보 |
| 10/3 | 로컬 수정 루프 관통(`--no-deploy`), 배포, 리허설(고정 gas revert 경로 포함) | 버그 구현에서 `specfirst run --no-deploy`가 반례, 수정, 7/7. 테스트넷 리허설 30건, revert 기대 5건 전부 status 0 |
| 10/4 오전 | fork 대조(필요 시 latest 치환 프록시, 그다음 Probe), 예치자 집합 수집, cert issue | `verify.json` 7/7, revert 기대 5건 모두 gasUsed < gasLimit, 발급 tx(발급 1건째) |
| 10/4 오후 | **버퍼** | **1주차 게이트**: `specfirst run spec/staking-vault.spec.yaml` 한 명령으로 발급까지, `specfirst status` true. `docs/e2e-log.md` 1회차 기록 |

### 2주차 (10/5 월 ~ 10/11 일)

| 날짜 | 작업 | 완료 기준 |
|---|---|---|
| 10/5 | UltrafuzzBackend(보조) 어댑터: VM 원격 실행, status 폴링, 3.5 처리 규칙. 참가팀 5곳에 발급 제안 | 통과 코드로 보조 캠페인 1회, report "보조 캠페인" 칸 채움. `bd-log.md` 5건 |
| 10/6 | 버전 대체 경로(3.7 a), `/api/cert/[address]` | v2 발급 tx(발급 2건째). v1은 Superseded, supersededBy = v2, `isCertified` true, `isLatest` false. curl로 REST 두 주소 응답 확인 |
| 10/7 | 증명서 페이지 `/c/[address]`: 상태 넷(검증됨, 검증됨이나 새 버전 있음, 실효, 부분 검증), invariantSetHash와 propertyHash 표시, 불변식 원문, 미검증 목록 동급 크기, 보조 캠페인 칸 별도, 계보 링크, 브라우저 reportHash 재계산 | Vercel URL에서 v1, v2 페이지 렌더, reportHash 일치 표시 |
| 10/8 | 위젯 스크립트, 배지 SVG, `/demo/aggregator` 모의 스테이킹 경로 카드(v2 검증됨, v0 증명서 없음). 어그리게이터 접촉 판정 | 모의 카드 페이지 URL, 배지가 README에서 실제 상태로 렌더. `bd-log.md`에 L0~L3 판정 |
| 10/9 | GitHub Action(검증과 발급 전용) on `specfirst-example-vault` 공개 저장소(샘플 미러, 3.9). 2차 E2E | 해당 저장소 PR에서 Action 녹색 코멘트, main 머지 후 수동 승인으로 v3 발급 tx(발급 3건째) |
| 10/10 | **기능 동결.** 버그 수정, 데모 실제 실행 녹화 1차 | 태그 `v0.1.0`, 녹화 원본 |
| 10/11 | **버퍼일.** 재녹화, 문서 | 신규 기능 없음 |

대시보드 `/app`은 **컷**. 그 자리는 모의 어그리게이터 카드가 차지한다.

### 마지막 이틀 (10/12 월 ~ 10/13 화)

| 날짜 | 작업 | 완료 기준 |
|---|---|---|
| 10/12 | 영상 편집(대기 구간 "배속" 자막), 제출 페이지, README, 3차 E2E로 링크 신선도 확인 | 영상 3:00 이하. 제출 페이지에 저장소, 레지스트리, 발급 tx, 증명서 페이지, 모의 카드, 영상, bd-log 요약, 발급 건수 |
| 10/13 | 오전 링크 전수 점검, `check:chars`, 제출 | 제출 완료 스크린샷 |

### 데모 대본 (3분)
- 0:00 문제: 감사 받기엔 작고 무검증 배포엔 돈이 걸린 팀.
- 0:15 스펙 7줄과 미검증 목록.
- 0:35 `specfirst run`: 기본 공격자 액터가 재진입 반례 발견, 수정 diff, 재퍼징 7/7. 버그를 심은 기존 코드로 시작했다고 내레이션에서 밝힘.
- 1:30 테스트넷 배포, 리허설 30건, fork 대조 7/7, 발급 tx.
- 1:55 증명서 페이지: 통과 목록과 미검증 목록 같은 크기, 보조 캠페인은 "사람 미검수"로 분리.
- 2:15 모의 스테이킹 경로 카드(모의 화면이라고 자막): 검증된 볼트 기본 노출, 증명서 없는 볼트는 경고. `isCertifiedWith(vault, 불변식 집합 해시)` 두 줄. 실제 어그리게이터 접촉 결과는 L0~L3 중 달성 단계 그대로.
- 2:35 코드 수정 후 v2 발급, v1은 "검증됨, 새 버전 있음". 증명서는 바이트코드에 고정되고, 배포 후 상태 변경은 미검증이라고 명시. "자동 실효"라는 표현은 쓰지 않는다.
- 2:50 진입 순서 한 문장.

---

## 5. 기술 리스크와 완화책

| # | 리스크 | 가능성/영향 | 완화책 |
|---|---|---|---|
| R1 | Ultrafuzz 설치 요소 과다, 격리 VM 필수 | 중/중 | 9/28 스파이크, 설치 스크립트 고정, 노트북 실행 금지. 보조 역할이라 실패해도 판정 경로 무관 |
| R2 | Ultrafuzz 실행 시간 | 상/중 | 루프 밖 1회, 퍼저 600초, 캠페인당 40 USD 상한 |
| R3 | 600초 캠페인 발견물이 candidate로만 남음 | 상/저 | 3.5 규칙대로 정직 표기. 서사는 "보조 캠페인 재현 0건" |
| R4 | 수정 에이전트 헛돌기 | 중/상 | 5회 상한, 동일 반례 2회, 빈 diff, 10분 타임아웃, 비용 상한 |
| R5 | 에이전트가 속성, 빌드 설정, 의존성을 바꿔 통과 | 중/치명 | 확대 lock, worktree, untracked 포함 허용목록, 환경 분기 경고 |
| R6 | 공허한 속성 | 상/상 | 뮤턴트 검사 필수, 강등 없음 |
| R7 | 사소한 스펙으로 증명서 획득 | 중/상 | `isCertifiedWith(invariantSetHash)`, `propertyHash`, 불변식 원문 공개, 기준 불변식 집합 운영 모델 로드맵 |
| R8 | "자동 실효" 과장으로 심사 신뢰 하락 | 확정/상 | 서사 정정(무결성 고정, 버전 대체, 근거 있는 revoke) |
| R9 | forge fork의 블록 고정이 Monad 과거 상태 미제공, RPC 한도와 충돌 | 상/상 | 9/28 실측. compute units 제한, 캐시. 1차 latest 치환 프록시, 2차 Probe(3.6-6) |
| R10 | limit 기준 과금, 파우셋 한도 | 중/중 | 0.5 추정, 9/28부터 매일 파우셋, revert 기대 tx 고정 80k |
| R11 | EIP-7825, EIP-6780 적용 여부 불명 | 저/중 | 9/28 실측. 6780 미적용이면 codehash 고정이 실질 방어가 되므로 서사에 반영 |
| R12 | trace 미제공 | 중/저 | 판정에서 제외, 선택 기능 |
| R13 | 어그리게이터 통합 실패 | 상/중 | 모의 카드(필수, "모의" 명시), L0~L3 성공 정의로 과장 방지, bd-log로 시도 자체를 증거화 |
| R14 | Action 자격증명 노출 | 중/상 | 에이전트 비활성으로 Claude 키 불필요. 배포, 발급 키는 environment 수동 승인, 테스트넷 전용 새 키, 샘플 저장소 한정 |
| R15 | 버퍼 0일, 동기간 면접과 지원 | 상/상 | 버퍼 1.5일 명시, 동결 10/10, 가치 순 컷 규칙 |
| R16 | Foundry invariant 숙련도 | 중/중 | 10/1을 샘플 속성에 통째로 배정, Handler와 Attacker 템플릿 고정 |
| R17 | 테스트넷 리셋, 장애 | 저/상 | 3차 E2E, 한 명령 재발급 |
| R18 | 가스 부족 실패를 접근 제어 통과로 오판 | 중/상 | gasUsed < gasLimit 조건, fork selector 재현, anvil 픽스처 |
| R19 | 제3자 예치로 합산형 불변식 오판 | 중/중 | Deposit 이벤트 기반 전체 예치자 집합 |

---

## 6. 테스트 계획

### 6.1 컨트랙트 단위 테스트 (forge)
- `issue`: 발급자만, EOA 대상 거부, codeHash가 `target.codehash`, 이벤트 필드.
- 계보: 같은 projectId 다른 target 발급 시 이전 Superseded, supersededBy, `currentTargetOf` 갱신, `CertificateSuperseded` 이벤트. 같은 target 재발급 시 이전 certId Superseded. **같은 target이 다른 projectId로 발급되는 경우**의 동작(두 번째 발급의 projectId가 그 target의 최신 계보가 되고, 첫 projectId의 currentTargetOf는 바뀌지 않음). 부분 증명서가 Valid 완전 증명서를 대체하려 하면 revert.
- `revoke`: 발급자만, Valid와 **Superseded 옛 버전** 모두 revoke 가능, Revoked 재실효 거부, evidenceURI 빈 문자열 거부, 이후 isCertified false.
- `isCertified`: 정상 true, 부분 증명서 false, `vm.etch`로 코드 교체 후 false, **Superseded true**, Revoked false. `isLatest`: 대체 전 true, 대체 후 옛 주소 false.
- `isCertifiedWith`: invariantSetHash 일치 true, 불일치 false, specHash만 다르고 invariantSetHash 같으면 true.
- 레지스트리 자체 invariant: "Revoked이거나 codehash 불일치면 isCertified는 false", "projectId당 currentTargetOf는 최대 하나".
- 커버리지 90%+.

### 6.2 CLI, core 통합 테스트 (vitest, anvil)
- 스펙: 필수 필드, ID 중복, specHash 안정성, **invariantSetHash가 이름, 리허설 건수 변경에 불변이고 불변식 text 변경에는 변함**, **lock과 specHash 불일치 시 run 거부(exit 11)**.
- lock: foundry.toml, remappings, 서브모듈 커밋, `SpecfirstProps.sol`, `SpecfirstProbe.sol` 변경 각각 exit 11. 회귀 PoC 추가 후 재lock 시 propertyHash 변경.
- 뮤턴트: 속성이 뮤턴트에서 통과하는 픽스처로 **exit 3**.
- 수정 루프(MockBackend + ReplayAgent): 1회 후 통과, 5회 소진 exit 10, 동일 반례 조기 종료, 잠긴 파일 수정 폐기, **editable 밖 untracked 파일 생성 폐기**, 환경 분기 경고 발생, 비용 상한 exit 15.
- ForgeBackend 파서: 실제 forge 출력 스냅샷 3종.
- UltrafuzzBackend: 스파이크 산출 `findings.json`과 status 스냅샷으로 3.5 표 각 행. 재현 PoC가 승인 전에는 lock에 안 들어가고 승인 후 `regressions/`에 들어가 다음 run에서 실행되는 경로.
- anvil: 배포, 리허설, **revert 기대 tx 고정 gas 경로**(estimateGas 미호출, status 0 기록), **가스 부족 픽스처**(gas limit을 일부러 너무 작게 줘서 status 0이지만 gasUsed == gasLimit인 경우 접근 제어 통과로 세지 않음), revert selector 재현, getLogs 청크 경계(청크 3 강제), 429 백오프, **fork 속성 실행**(anvil을 fork 원천으로), **latest 치환 프록시 경유 fork**, **제3자 예치 픽스처**(리허설 액터가 아닌 주소가 예치해도 INV-1, INV-2 판정이 맞음), 발급 후 `status`.
- 종료 코드: 배포 실패 모의 **exit 12**, 대조 위반 픽스처 **exit 13**, 발급자 아닌 키 **exit 14**.
- 웹: `/api/cert` 응답 스키마(isLatest, invariantSetHash, propertyHash 포함), 증명서 페이지 상태 넷 렌더 스냅샷, **reportHash 재계산 일치와 불일치 표시**, **배지 SVG 렌더 스냅샷 1건**, **widget.js DOM 렌더 스냅샷 1건**.
- **실제 ClaudeCodeAgent 수동 스모크 1건**: 10/2에 버그 샘플로 실제 CLI 호출, 비용과 버전 기록.

### 6.3 샘플 E2E (Monad 테스트넷, 수동)
- `pnpm e2e:testnet`: 버그 구현에서 run → 반례와 수정 → 배포 → 리허설 30건 → 대조 → 발급 → `status` true → 코드 한 줄 수정 후 run → v2 발급 → v1 Superseded, v1 `isCertified` true, v1 `isLatest` false 확인 → REST 두 주소 확인.
- 10/4, 10/9, 10/12. tx 링크를 `docs/e2e-log.md`에.

### 6.4 문자 규칙
- `scripts/check-chars.sh`: 저장소 전체(node_modules 제외)에서 U+2014, U+00B7, U+318D 검색, 하나라도 있으면 실패. CI와 pre-commit.

---

## 7. 스코프 컷 규칙

### 제출물 번호
| 번호 | 제출물 | 최소 제출선 |
|---|---|---|
| D1 | CLI `init`, `lock`, `run`, `deploy`, `verify`, `cert`, `status` | 필수 |
| D2 | CertificateRegistry (`isCertified`, `isCertifiedWith`, `isLatest`, 계보) | 필수 |
| D3 | 웹: 증명서 페이지, REST (대시보드는 컷) | 선택, 1순위 |
| D4 | GitHub Action, 배지 위젯 | 선택, 3과 4순위 |
| D5 | 데모 영상 3분 | 필수 |
| D6 | 제출 페이지 | 필수 |
| D7 | 샘플 StakingVault 스펙, 발급 tx 링크 | 필수 |
| D8 | 어그리게이터 통합 데모 (L2 이상 실제 통합 또는 "모의" 명시 카드) | 선택, 2순위 |

최소 제출선 D1, D2, D5, D6, D7은 어떤 컷에서도 보존한다.

### 보존 우선순위 (높은 것부터 마지막에 버린다)
증명서 페이지와 REST(D3) > 어그리게이터 통합 데모(D8) > 배지(D4 일부) > Action(D4 일부) > trace. 대시보드와 CertifiedVaultRouter는 이미 컷. **컷은 이 순서의 역순으로 한다.**

### 날짜별 판정

| 판정 시점 | 조건 | 조치 |
|---|---|---|
| 9/29 저녁 | Ultrafuzz 설치 실패 또는 2시간 내 run 미완 | 보조 캠페인을 주말 수동 1회 실행 후 `--attach-ultrafuzz <dir>` 첨부로만 |
| 9/29 저녁 | 고정 블록 fork 불가 판정 | latest 치환 프록시를 10/3 작업에 추가. 프록시도 anvil 테스트에서 막히면 Probe 경로 확정, 10/4 오전 계획 교체 |
| 9/30 저녁 | 레지스트리 배포 실패 | RPC 교체, 그래도 안 되면 `reportURI`를 이벤트로만 남기는 축소판 |
| 10/2 저녁 | 수정 에이전트가 샘플 반례를 못 고침 | 반례 시퀀스와 forge 트레이스를 프롬프트에 추가, opus 고정. 그래도 실패면 에이전트 제안 diff를 사람이 승인하는 흐름으로 데모 |
| **10/4 저녁 (1주차 게이트)** | 한 명령 E2E 미완 | 버퍼 10/5 오전 투입. 그래도 미완이면 Action, 배지, trace 컷. Ultrafuzz 어댑터는 첨부 방식으로 격하. 10/5~10/6을 E2E에, 10/7 증명서 페이지, 10/8 모의 카드는 유지 |
| 10/6 저녁 | Ultrafuzz 어댑터 미완 | 수동 실행 결과 첨부 경로만. 그것도 안 되면 증명서에서 보조 칸을 비우고 제출 페이지에 "계획된 통합"으로만 서술(확정: 공개된 심사 기준에 Ultrafuzz 의무 규정 없음) |
| 10/7 저녁 | 증명서 페이지 미완 | 10/8 오전까지 연장, 대신 배지 컷 |
| 10/8 저녁 | 모의 카드 미완 | Action 컷하고 10/9를 모의 카드에 |
| 10/9 저녁 | Action 미완 | Action 컷. README에 로드맵으로만 |
| 10/10 | 기능 동결 | 이후 신규 기능 금지 |
| 10/12 정오 | 영상 미완 | 편집 효과 없이 화면 녹화와 자막만 |

---

## 8. 절대 규칙
- 문서, 코드 주석, 커밋 메시지, 웹 문구에 em-dash(U+2014), 가운뎃점(U+00B7), 아래아(U+318D) 금지. 나열은 콤마, 구분은 "|", 범위는 물결. `check:chars`가 강제.
- 증명서, 영상, 제출 페이지의 숫자는 실제 산출물에서만.
- Ultrafuzz는 개발 노트북에서 실행하지 않는다.
- 배포, 발급 키는 테스트넷 전용 새 키, 커밋 금지.
- revoke는 위반 근거 없이 하지 않는다.

---

## 9. 승인 요청 사항

### 확인 요청 (사용자 결정 필요)
1. 결정 A3(forge 판정, Ultrafuzz 사람 미검수 보조), B2(Claude Code CLI, worktree), C1(자체 레지스트리, 무결성 고정, invariantSetHash 필터, 계보), D2(fork 속성 대조, 프록시와 Probe 대체) 승인.
4. 0.4 예산 기본값(VM 30 USD, Ultrafuzz 에이전트 120 USD, Specfirst 에이전트 60 USD) 확정 또는 수정.
5. 데모 실효 장면은 (a) 버전 대체로 하고, (b) 위반 revoke는 P2로 두는 것 승인.

### 기본값 (이견 시 변경)
2. 비업그레이드형 한정, 미검증 목록 기본값 5개.
3. `--allow-partial`은 발급하되 `isCertified` false, Valid 완전 증명서를 대체하지 못함.
6. 풀 형태 두 번째 샘플은 만들지 않고 볼트 노출 시나리오.
- 저장소 `specfirst`와 `specfirst-example-vault`는 **공개**가 기본값. 심사위원이 6주 안에 만든 것을 검증할 수 있어야 한다는 공개 요건에 맞춘다(오픈소스는 권장이며 필수 아님).

### 닫힘
7. 트랙 4 심사 기준: 팀 리드 확인 결과 공개 페이지에 공식 심사 기준과 Ultrafuzz 의무 규정이 없고, "심사위원이 6주 안에 만든 것을 검증 가능해야 함, 오픈소스 권장 필수 아님"만 확인됨. 10/6 컷 마지막 단계("계획된 통합"으로 서술) 허용으로 확정.

## 참고 출처
- https://github.com/monad-developers/ultrafuzz (README, docs/cli.md, docs/config.md, docs/reference/audit-profiles.md, docs/tutorials/first-campaign.md, docs/how-to/materialize-tests.md, docs/SPECS.md)
- https://docs.monad.xyz/developer-essentials/testnet
- https://docs.monad.xyz/developer-essentials/differences
- https://docs.monad.xyz/reference/rpc-differences
- https://docs.monad.xyz/reference/rpc-limits
- https://eips.ethereum.org/EIPS/eip-7825
- https://eips.ethereum.org/EIPS/eip-8004
- https://github.com/monad-crypto/MIPs/pull/88 (MIP-16)
