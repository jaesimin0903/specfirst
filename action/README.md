# Specfirst GitHub Action

`action/action.yml`의 컴포짓 액션이다. specfirst CLI로 Foundry 컨트랙트를 스펙에 대해
판정한다. 검증과 발급 전용이고, 수정 루프(Claude 에이전트)는 절대 켜지 않는다
(`--agent none` 고정). 계획서 `docs/plan.md` 3.9절, 4절 참고.

CLI 옵션은 3.10 기준이다. `deploy`, `verify`, `cert`는 exec-deploy가 구현 중이라 바뀔 수
있다.

## 두 모드

- **pr**: `specfirst run <spec> --no-deploy --agent none --runs <runs> --json`만 실행한다.
  lock 검사와 forge 판정만 하고 배포하지 않는다. 반례가 있으면 워크플로가 실패하고,
  풀 리퀘스트 이벤트일 때 결과 요약을 PR 코멘트로 남긴다.
- **release**: 위 판정에 이어 `specfirst run <spec> --agent none --network <network>`로
  배포, 리허설, 대조, 발급까지 진행한다. `DEPLOYER_PRIVATE_KEY`, `ISSUER_PRIVATE_KEY`는
  입력값이 아니라 **환경변수로만** 받는다. 액션을 호출하는 워크플로의 job 레벨 `env:`에
  `secrets.*`로 넣어야 컴포짓 내부 스텝까지 전달된다. 스텝 레벨 `env:`가 아니라 job
  레벨이어야 한다.

## 입력

| 이름 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `spec` | 예 | - | 스펙 파일 경로. 호출한 워크플로가 체크아웃한 저장소 루트 기준 |
| `mode` | 아니오 | `pr` | `pr` 또는 `release` |
| `network` | 아니오 | `monad-testnet` | `--network`로 넘길 값. `anvil` 또는 `monad-testnet` |
| `registry` | 아니오 | 빈 값 | CertificateRegistry 주소. 비우면 `SPECFIRST_REGISTRY_<chainId>` |
| `rpc` | 아니오 | 빈 값 | RPC URL. 비우면 `MONAD_TESTNET_RPC` 또는 `ANVIL_RPC` |
| `runs` | 아니오 | `64` | 캠페인당 불변식 실행 횟수 |
| `tool-ref` | 아니오 | 빈 값 | specfirst 소스를 가져올 ref. 비우면 액션 자신의 ref |

액션은 `jaesimin/specfirst` 저장소에서 CLI 소스를 따로 체크아웃해 빌드한 뒤, 호출한
워크플로가 체크아웃해 둔 대상 프로젝트(스펙과 컨트랙트가 있는 저장소) 위에서 실행한다.
그래서 다른 저장소에서도 `uses: jaesimin/specfirst/action@main`으로 참조할 수 있다.
이 체크아웃은 기본 `GITHUB_TOKEN`으로 하므로 `jaesimin/specfirst`가 공개 저장소여야
한다(계획서 머리말대로 저장소는 공개가 기본값이다). `tool-ref`를 비워 두면 이 액션
자신이 호출된 ref를 그대로 쓴다.

## 예시 워크플로

### (a) PR마다 pr 모드

```yaml
name: specfirst
on:
  pull_request:
    paths: ['spec/**', 'src/**', 'test/specfirst/**']

jobs:
  verify:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: jaesimin/specfirst/action@main
        with:
          spec: spec/staking-vault.spec.yaml
          mode: pr
```

### (b) main 머지 시 release 모드, environment 보호 규칙으로 수동 승인

```yaml
name: specfirst-release
on:
  push:
    branches: [main]
    paths: ['spec/**', 'src/**', 'test/specfirst/**']

jobs:
  release:
    runs-on: ubuntu-latest
    environment: testnet-issuer
    env:
      DEPLOYER_PRIVATE_KEY: ${{ secrets.DEPLOYER_PRIVATE_KEY }}
      ISSUER_PRIVATE_KEY: ${{ secrets.ISSUER_PRIVATE_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: jaesimin/specfirst/action@main
        with:
          spec: spec/staking-vault.spec.yaml
          mode: release
          network: monad-testnet
```

`environment: testnet-issuer`를 저장소 설정에서 만들고 필수 리뷰어를 지정하면, 이
job은 리뷰어가 승인해야만 시작한다. `DEPLOYER_PRIVATE_KEY`, `ISSUER_PRIVATE_KEY`는
저장소 secret이 아니라 이 environment의 secret으로 등록한다. 그러면 승인 없이는
키가 러너에 노출되지 않는다. `examples/staking-vault/.github/workflows/specfirst.yml`이
이 두 예시를 볼트 스펙에 맞춰 구체화한 버전이다.

## 범위 한정과 발급 키

해커톤 범위에서는 자기 샘플 저장소 `specfirst-example-vault`에서 쓰는 데모로
한정한다. 발급 키는 Specfirst 운영 키 하나뿐이고, 이 키를 외부 저장소의 워크플로에
넘겨줄 수 없다. 넘기면 그 저장소를 관리하는 누구든 임의의 컨트랙트에 대해 인증서를
발급할 수 있게 되어 "Specfirst가 이 리포트를 검토하고 발급했다"는 신뢰 모델이
깨진다.

외부 저장소 지원 로드맵은 다음과 같다. Action은 배포와 대조까지만 하고, 그 결과인
report를 Specfirst가 운영하는 발급 서비스에 제출한다. 서비스가 같은 seed와 스펙으로
재현해 검증한 뒤 자기 키로 발급한다. 발급 주체는 여전히 Specfirst 키 하나이고,
외부 저장소는 키를 쥐지 않는다. 3.4절 신뢰 모델과 정합한다.

## 로컬 검증

이 환경에는 `act`가 없어서(`act --version` 확인, 미설치) `act`로 pr 모드를 직접
실행하는 대신 다음 세 가지로 검증했다.

1. `pip3 install --user pyyaml`로 파서를 설치한 뒤(`node`에는 내장 YAML 파서가
   없다), `python3 -c "import yaml; yaml.safe_load(open(f))"`로 `action.yml`과
   `examples/staking-vault/.github/workflows/specfirst.yml`을 실제로 파싱했다. 둘 다
   문법 오류 없이 파싱됐고, 최상위 키도 의도한 대로 나왔다
   (`action.yml`: name, description, author, inputs, runs).
   워크플로 파일 쪽은 최상위 키가 `on`이 아니라 파이썬 `True`로 나오는데, 이는
   PyYAML이 YAML 1.1 규칙으로 맨 키 `on`/`off`/`yes`/`no`를 불리언으로 해석하는
   알려진 동작이고 파일 문법 오류가 아니다. GitHub의 실제 워크플로 파서는 `on`을
   트리거 키로 특별 취급하므로 영향 없다.
2. `action.yml`의 각 `run:` 블록을 정규식으로 추출해 `bash -n`으로 셸 문법을 검사하는
   Node 스크립트를 짜서 돌렸다. 5개 블록(`mode 값 검사`, `자격증명 확인`, `툴 의존성
   설치`, `PR 모드, 검증만 실행`, `release 모드, 배포부터 발급까지`; `uses:`만 있는
   스텝은 `run:` 블록이 없어 집계에서 빠진다) 모두 `bash -n` 통과.
   `examples/staking-vault/.github/workflows/specfirst.yml`은 `run:` 블록이 없어
   (전부 `uses:` 스텝) 0개 검사, 정상이다.
3. `bash -n`만으로는 못 잡는 문제를 실제로 하나 찾아 고쳤다. GitHub은 `shell: bash`
   스텝을 기본으로 `bash --noprofile --norc -eo pipefail {0}`로 실행해서 `-e`가
   이미 켜져 있다. "PR 모드, 검증만 실행" 스텝은 `specfirst run`이 반례로 실패해도
   `${PIPESTATUS[0]}`로 종료 코드를 잡아 계속 진행해야 하는데, 처음 짠 버전은
   `set -uo pipefail`만 써서 `-e`를 끄지 않았다. 이러면 파이프가 실패하는 순간
   스크립트가 그 줄에서 바로 죽어 `$GITHUB_OUTPUT`을 못 쓰고, PR 코멘트 스텝도
   실행 못 한다. `bash -eo pipefail`로 같은 상황을 로컬에서 재현해 확인한 뒤,
   그 구간만 `set +e` / `set -e`로 감싸 고쳤다. 고친 뒤 같은 재현 스크립트로
   `PIPESTATUS`가 제대로 잡히고 스크립트가 끝까지 도는 것을 확인했다.

세 검증 모두 통과했다. 실제 GitHub Actions 러너에서의 종단 실행(pnpm/Foundry 설치,
`specfirst run` 실제 호출, PR 코멘트 작성)은 이 로컬 환경에서 재현하지 않았다.
`jaesimin/specfirst` 저장소가 GitHub에 푸시된 뒤 실제 PR에서 한 번 더 확인이
필요하다.
