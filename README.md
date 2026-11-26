# 고려대학교 사주 매칭 웹

무료 추천 프로필 최대 3명 → 상대 선택 → 상대당 500원 → 대화 요청 → 상대 수락(무료) → 채팅.
사주와 매칭은 오락용이며, 결제가 상대의 수락이나 답장을 보장하지 않습니다.

## 👥 팀원 & 역할

| 역할 | 이름 | GitHub | 담당 |
|---|---|---|---|
| A | 우민 | @lgmsdgc | 공통 앱·학교 이메일 인증·사주 입력과 결과·HRUM 어댑터·배포 설정 |
| B | 김상후 | @sanghoo0628 | 프로필·사진 정책·고정 점수·무료 추천·DB 스키마와 마이그레이션·RLS |
| C | 정우 | @jwmoon799 | 상대당 500원 주문·Groble 웹훅·결제 확인·대화 요청과 수락·Realtime 채팅·차단 |

## 현재 상태 (2026-11-26)

배포: https://saju-ebon-psi.vercel.app (main 자동 배포, 개발 DB saju-dev 사용)

- 학교 이메일 인증번호 로그인 → 사주 입력(매칭용 저장 동의 시 양력 생년월일 저장) → `/profile` 등록(첫 저장 때 고정 점수 생성) → `/matches` 무료 추천 → 대화 요청·수락 → `/chat`
- 사주 계산과 매칭 정보 저장을 분리했습니다(#14). HRUM 키가 없거나 장애여도 양력 생년월일을 저장하고 프로필·추천까지 갈 수 있습니다. 음력·윤달은 아직 매칭용으로 저장하지 않습니다.
- 점수가 생긴 뒤에는 매칭용 생년월일을 바꿀 수 없습니다. 같은 값 재저장은 허용하며, 점수 생성과 날짜 변경이 동시에 와도 DB가 막습니다(#14).
- HRUM 호출은 한국 시간 기준 사용자당 하루 5회, 전체 하루 15회(초기 테스트값)로 제한합니다(#15). 운영 상한은 비용 합의 후 정합니다.
- 추천받을 상대 성별을 고를 수 있습니다. 서로의 조건을 모두 만족할 때만 추천합니다(#17).
- Groble 이벤트 원장·환불 대조를 준비했습니다(#16). 실제 결제는 Groble 키 설정 전까지 503으로 거부합니다.
- saju-dev 마이그레이션 12개 적용 완료(`20261125000500`까지). 목록은 [운영 체크리스트](docs/RELEASE_CHECKLIST.md)에 있습니다.
- saju-dev 로그인 메일은 개발용 Gmail SMTP입니다. 출시 전 발송 전용 서비스로 바꿔야 합니다.

남은 일: HRUM 키 등록과 실제 호출 확인, 비용·전체 상한·환불 정책 합의, 음력 지원 시점, 운영 Supabase·SMTP·Groble 설정.

## 🤝 협업 규칙

> 팀이 처음 정한 규칙입니다(`31d1941`). C 브랜치 통합 때 README가 바뀌면서 빠졌던 내용을 그대로 되살렸습니다.

### 🌿 브랜치 규칙

- `main` : 항상 실행되는 코드. **직접 push 금지**
- `feature/기능이름` : 기능 개발 (예: `feature/saju-calc`, `feature/tarot-ui`)
- `fix/버그이름` : 버그 수정

**작업 순서**
1. `main` 최신화: `git checkout main && git pull`
2. 브랜치 생성: `git checkout -b feature/기능이름`
3. 작업 후 커밋 & push: `git push origin feature/기능이름`
4. GitHub에서 Pull Request 생성 → 팀원 1명 이상 확인 → merge

### ✍️ 커밋 메시지 규칙

| 태그 | 의미 | 예시 |
|---|---|---|
| `feat:` | 새 기능 | `feat: 사주 입력 화면 추가` |
| `fix:` | 버그 수정 | `fix: 윤달 계산 오류 수정` |
| `docs:` | 문서 수정 | `docs: README 실행 방법 추가` |
| `style:` | 코드 포맷, 세미콜론 등 (동작 변화 없음) | `style: 들여쓰기 정리` |
| `refactor:` | 리팩토링 | `refactor: 오행 계산 함수 분리` |
| `chore:` | 설정, 패키지 등 | `chore: eslint 설정 추가` |

### 🔒 PR·DB·비밀 값

- PR은 CI(`C integration checks`) 통과를 확인하고 머지합니다. 문서만 바꾼 PR은 CI가 돌지 않습니다.
- 기존 마이그레이션 파일은 수정하지 않고 새 마이그레이션을 추가합니다. 공용 saju-dev에 적용하기 전에는 팀에 알립니다.
- ⚠️ `.env.local`, API 키, DB 비밀번호는 레포와 단체방에 올리지 않고 필요한 사람에게 개인 메시지로만 전달합니다.

## 설치와 실행

Node **24.22.1 이상 25 미만**, pnpm **11.25.0**을 사용합니다. `.nvmrc`와 `.node-version`도 같습니다.

```bash
nvm use # nvm을 사용하는 경우
pnpm install --frozen-lockfile
cp .env.example .env.local # 파일이 없을 때만 복사; 기존 비밀 값 보존
pnpm dev
```

개발 주소: http://localhost:3000
잠금 파일은 루트 `pnpm-lock.yaml` 하나만 관리합니다. React/React DOM 버전도 공통 앱과 독립 C 데모가 같습니다.

`.env.local`과 실제 키는 Git에 올리지 않습니다.

- 공통/Auth: `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `ALLOWED_EMAIL_DOMAINS`
- B 관리자 저장소: `SUPABASE_SECRET_KEY`, `MATCHING_STRATEGY=legacy_demo_v1`, `SCORE_HMAC_SECRET`
- C DB: 서버 전용 `DATABASE_URL`, `DATABASE_SSL_CA_PATH` (Supabase CA 인증서 파일 경로)
- 사주 공급자: `.env.example`의 `SAJU_PROVIDER`, HRUM 관련 설정. 기존 `SAJU_USE_MOCK`은 A에서 사용하지 않습니다.
- Groble: 변수 이름만 예약되어 있습니다. URL/키를 넣거나 flag를 바꾸는 것으로 실제 결제를 활성화할 수 없습니다.

Supabase DB 연결에는 `DATABASE_SSL_CA_PATH`가 필수입니다. CA는 Supabase 대시보드 Database Settings에서 다운로드합니다. TLS 인증서 검증을 유지하며, CA 파일은 배포 환경에도 별도로 준비해야 합니다.
인증된 사용자 UUID는 A 서버 인증으로 확인하며, 브라우저 본문의 구매자·작성자 ID를 신뢰하지 않습니다.

## 검사

```bash
pnpm test        # B/DB, C, A, UI, 통합 도구 검사
pnpm lint
pnpm typecheck
pnpm build
pnpm demo:build
pnpm test:http:local # 미설정 테스트 환경에서 빌드한 앱을 시작·검사·종료
pnpm test:postgres # 별도 네이티브 PostgreSQL 다중 연결 검사 13개
```

기본 검사와 빌드는 실제 Supabase 계정이나 결제 없이 실행합니다.
미설정 상태로 HTTP 검사를 할 때는 서버 실행 프로세스의 Supabase URL/공개 키를 함께 비워서 실행하세요.
실제 `.env.local`의 기존 비밀 값을 지우거나 교체하지 마세요.
네이티브 PostgreSQL 검사는 결제·요청 동시성과 환불 후 재구매를 확인합니다. 최신 결과는 C 재개 기록과 CI를 참고하세요.
로컬 Codex 환경의 공유 메모리 제한은 남아 있으므로 해당 검사는 CI에서 실행합니다. 기본 검사에 포함되지 않습니다.

C·feature/**·fix/** 브랜치 push와 main·C 대상 PR에는 `.github/workflows/c-validation.yml`이 앱/HTTP 검사와 네이티브 DB 검사를 자동 실행합니다.
문서만 바뀐 커밋은 제외합니다. 실제 Supabase/사주/결제 키는 CI에 필요하지 않습니다.
[자동 검증 결과와 재실행 방법](docs/C_CI_VALIDATION_2026-11-23.txt)을 참고하세요.

[실제 Supabase 임시 계정 검증 및 수동 재실행](docs/C_SUPABASE_LIVE_QA_2026-11-23.txt)도 완료했습니다.
이 명령은 명시적 opt-in이 필요하며 공유 개발 프로젝트의 테스트 데이터만 생성·정리합니다. CI에서는 실행하지 않습니다.

[메시지 응답 유실·재전송 처리](docs/C_MESSAGE_IDEMPOTENCY_2026-11-23.txt)에 최신 변경과 검증 범위를 정리했습니다.

[요청 지연 시 대기 해제와 재확인](docs/C_REQUEST_TIMEOUT_2026-11-23.txt)에 최신 변경을 정리했습니다.

[채팅 읽기 위치 유지와 최신 메시지 이동](docs/C_CHAT_READING_POSITION_2026-11-23.txt)에 최신 화면 변경을 정리했습니다.

[이전 대화 요청 조회](docs/C_REQUEST_HISTORY_2026-11-23.txt)에 최신 화면 변경을 정리했습니다.

[메시지 시각 정밀도와 순서 보정](docs/C_TIMESTAMP_PRECISION_2026-11-23.txt)에 최신 변경을 정리했습니다.

[B 프로필 통합 및 개발 DB 읽기 전용 확인](docs/C_B_PROFILE_INTEGRATION_2026-11-23.txt)에 최신 검증과 재실행 명령을 정리했습니다.

[B CLI·테스트 후속 변경](docs/C_B_FOLLOWUPS_2026-11-23.txt)과 [Supabase 로컬 설정 안내](supabase/README.md)도 반영했습니다.

## A 합류 후 통합 검사 준비

```bash
pnpm verify:integration          # 계획·수동 체크리스트 생성
pnpm verify:integration --run    # 외부 서비스 키를 비운 자동 검사 실행
pnpm verify:integration --run --postgres # native PostgreSQL도 포함
```

결과·단계별 로그는 Git에서 제외되는 `test-results/integration/<실행 폴더>/`에 남습니다.
자동 검사 통과와 실제 학교 메일·사주 저장·PG 검증 결과는 별도로 기록합니다.
[실행 안내](docs/INTEGRATION_VERIFICATION_GUIDE_2026-11-23.txt), [수동 체크리스트](docs/INTEGRATION_ACCEPTANCE_CHECKLIST_2026-11-23.txt), [팀 정책 결정표](docs/INTEGRATION_POLICY_DECISIONS_2026-11-23.txt)를 참고하세요.

## 독립 C 화면 데모

```bash
pnpm demo:dev
# http://127.0.0.1:4173/
```

가상 인물과 메모리 데이터만 사용합니다. 데모 결제·가상 수락·가상 답장은 Next.js 앱에 포함하지 않습니다.
C의 공통 스타일은 `.payment-chat-experience` 안에 적용되어 A 화면과 충돌하지 않습니다.

## 연결 문서

- [이번 A/C 통합 결과·남은 작업](docs/C_A_INTEGRATION_2026-11-23.txt)
- [B 프로필·매칭·DB 계약](docs/CONTRACT_profile_matching.md)
- [A 인증·사주 안내](docs/A_README.md)
- [C PostgreSQL 어댑터](docs/C_POSTGRES_ADAPTER_2026-11-17.txt)
- [C 실시간 수신·재연결](docs/C_REALTIME_PREPARATION_2026-11-18.txt)
- [C 결제 복귀 상태 모듈](docs/C_CHECKOUT_RETURN_2026-11-17.txt)

세부 설계 문서의 이전 시점 설명보다 최신 통합 결과를 먼저 확인하세요.

## C 검토 후속 변경

추천 카드의 프로필 사진·오류 시 기본 아바타를 연결했습니다. 환불 후 재구매의 대기 요청은 새 결제 완료 주문에 연결하고, 거절된 요청에는 새 청구를 유도하지 않습니다.
[A 리뷰 반영 및 검증 범위](docs/C_A_REVIEW_FIXES_2026-11-23.txt)와 [C 재개 기록](docs/C_RESUME_2026-11-23.txt)을 참고하세요.
