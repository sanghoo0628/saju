# 🔮 고려대학교 사주 매칭 웹

> 무료로 사주 풀이와 본인 점수를 확인하고, 점수 합이 0에 가까운 상대 3명의 프로필을 무료로 봅니다. 마음에 드는 상대를 골라 500원을 결제하면 대화를 요청할 수 있고, 상대가 수락하면 웹에서 일대일 채팅을 진행합니다.

```
무료 추천 3명 공개 → 상대 1명 선택 → 그 상대에 대해 500원 결제 → 대화 요청 → 상대 수락(무료) → 채팅
```

- 매칭 규칙: 생년월일에 대응하는 고정 숫자(1~10,000), 문과는 양수·이과는 음수, `abs(내 점수 + 상대 점수)`가 작은 순으로 상위 3명.
- 점수는 실제 사주 풀이와 별개인 **오락용 매칭 규칙**이며 같은 입력의 점수는 유지됩니다.
- 결제는 상대당 500원입니다. 상대의 수락·답장은 무료이며 대화 성사를 보장하지 않습니다.
- 개발 계획 PDF(v1.0)의 "500원 결제 후 프로필 3명 공개"는 2026-11-16에 위 흐름으로 바뀌었습니다.

## 👥 팀원 & 역할

| 역할 | 이름 | GitHub | 담당 |
|---|---|---|---|
| A | (팀원) | @(아이디) | 가입과 사주 결과 — 공통 UI, 학교 이메일 인증, 입력 폼, 사주 API 어댑터·캐시, 무료 결과 화면, 배포 설정 |
| B | 김상후 | @sanghoo0628 | 프로필과 매칭 — DB 스키마·마이그레이션 통합, 프로필·사진 정책, 고정 점수, 후보 필터·무료 추천, RLS |
| C | (팀원) | @(아이디) | 결제와 채팅 — 상대별 500원 주문·Groble 웹훅, 결제 확인 화면, 취소·환불, 대화 요청·수락, Realtime 채팅, 차단·신고 UI |

## 🛠 기술 스택

- 웹/서버: Next.js (화면 + 서버 API)
- 인증·DB·사진·실시간: Supabase (Auth, Postgres + RLS, Storage, Realtime)
- 결제: Groble (결제 링크 + 웹훅)
- 사주: 기존 사주 프로그램 (HTTP API로 서버에서 호출)

사주 호출·점수 계산·매칭·주문 검증은 **서버에서만** 수행합니다. 브라우저의 Supabase 접근은 RLS가 허용한 본인 정보와 채팅 데이터로 제한합니다.

## 🚀 실행 방법

```bash
# 1. 레포 클론
git clone https://github.com/sanghoo0628/saju.git
cd saju

# 2. 환경변수 설정 (.env.example 복사 후 값 채우기)
cp .env.example .env

# 3. 패키지 설치
npm install

# 4. B 매칭·DB와 C 결제·채팅 전체 테스트
npm run test:all

# 5. 공통 엄격 타입 검사
npm run typecheck
```

> Windows에서 테스트가 `Cannot read properties of undefined (reading 'config')`로 실패하면 터미널 경로의 드라이브 문자가 소문자(`c:\`)인 경우입니다. `C:\`로 연 터미널에서 실행하세요.
>
> Next.js 앱 골격은 A가 추가합니다. 추가되면 `npm run dev` 실행 방법을 여기에 적습니다.

### 결제와 채팅 화면 데모

Node 24 이상이 필요합니다. `packages/payment-chat-ui`에서 `pnpm install`로 화면 의존성을 설치한 뒤, 저장소 루트에서 `npm run demo:dev`를 실행합니다. 주소는 `http://127.0.0.1:4173/`입니다. 화면 빌드는 `npm run demo:build`입니다.

이 화면은 가상 인물과 로컬 메모리 저장소를 사용하는 데모입니다. 실제 결제·Supabase 인증·실시간 구독은 연결하지 않았습니다. 공통 Next.js 앱에 탑재하기 위한 설명은 [`INTEGRATION_UI.txt`](./packages/payment-chat-ui/INTEGRATION_UI.txt)를 참고하세요.

### C PostgreSQL 어댑터

`src/server/postgres-repository.ts`의 `createPaymentChatDatabase(DATABASE_URL)`로 실제 `pg.Pool` 저장소를 만들 수 있습니다. 같은 연결에서 결제 기록과 권한을 확정하며 직렬화 충돌만 제한적으로 재시도합니다. 서버 연결 예시는 [`C_POSTGRES_ADAPTER_2026-11-17.txt`](./docs/C_POSTGRES_ADAPTER_2026-11-17.txt)를 참고하세요.

`npm run test:all`은 결제 복귀 검사를 포함해 233개 검사를 실행합니다. 실제 `pg.Pool`의 TCP 왕복 검사는 PGlite를 사용합니다. 네이티브 PostgreSQL의 다중 연결 검사는 별도 `npm run test:postgres`로 실행합니다. 현재 Codex 환경에서는 공유 메모리 제한으로 이 별도 검사 10개를 실행하지 못했습니다. 실제 Supabase/Groble 연결 검증도 남아 있습니다.

### 결제 이동·복귀 준비

`checkout-return-store.ts`와 `checkout-return.ts`는 결제 이동 전 사용자별 주문 ID를 보존하고 복귀 후 같은 주문을 서버에서 조회합니다. 연결 예시와 같은 탭·마지막 주문 한 개라는 복구 범위는 [`C_CHECKOUT_RETURN_2026-11-17.txt`](./docs/C_CHECKOUT_RETURN_2026-11-17.txt)에 정리했습니다. 실제 Groble 이동·복귀 라우트는 아직 연결하지 않았습니다.

현재 `npm run test:all`은 신규 복귀 검사 22개를 포함한 233개를, `npm run test:ui`는 별도 18개를 실행합니다.

### 실제 데이터용 결제·채팅 UI

재사용 컴포넌트는 로그인 사용자 ID와 B의 공개 프로필을 props로 받습니다. 체험 기능은 명시적으로 켰을 때만 표시합니다. 호출 방법은 [`C_UI_LIVE_PROPS_2026-11-17.txt`](./docs/C_UI_LIVE_PROPS_2026-11-17.txt)에 있습니다.

화면 의존성을 설치한 뒤 `npm run test:ui`로 컴포넌트 렌더링 검사 18개를 실행할 수 있습니다. 기본 `test:all`의 233개와 별도이며, 실제 인증·결제 연결을 검증하는 테스트는 아닙니다.

### 실시간 채팅 연결 준비

`createSupabaseMessageSource`에 로그인된 Supabase 브라우저 클라이언트를 주고 `ChatPanel.messageSource`로 전달할 수 있습니다. 메시지는 기존 서버 기록·전송 응답과 합치고, 재연결 시 누락을 조회합니다. HTTP 권한 확인은 실시간 연결 중에도 유지합니다.

연결 예시와 실제 Supabase에서 추가로 확인할 항목은 [`C_REALTIME_PREPARATION_2026-11-18.txt`](./docs/C_REALTIME_PREPARATION_2026-11-18.txt)에 있습니다. 현재 검증은 어댑터 대역·로컬 데모까지이며 실제 Supabase WebSocket 연결은 아직 검증하지 않았습니다.

### 요청·수락 결과 자동 반영

`createInboxSession`이 인증된 요청/대화방 목록을 기본 5초 주기로 확인합니다. 선택한 요청이 수락되고 실제 방이 조회되면 그 방으로 이어집니다. 수락·거절 안내도 대기 상태와 구분합니다. 연결 방법과 검사 결과는 [`C_INBOX_SYNC_2026-11-18.txt`](./docs/C_INBOX_SYNC_2026-11-18.txt)에 있습니다.

### B와 C 통합 검증

`npm test`는 B의 Vitest 및 DB 통합 검사를, `npm run test:payments`는 C의 Node 테스트를 실행합니다. 두 테스트 러너의 검색 범위는 분리했습니다. `npm run test:all`로 모두 실행할 수 있습니다.

통합 테스트는 B 마이그레이션을 적용한 PGlite에서 C의 실제 결제·채팅 로직을 실행합니다. 결제 기록과 권한 확정의 원자성, 오류 시 롤백, 중복 처리, 참여자 권한과 차단을 검사합니다. 이 검증은 실제 Supabase나 Groble의 운영 연결 검증을 대신하지 않습니다.
>
> ⚠️ API 키 값은 레포에 올리지 말고 팀 채팅으로 따로 공유합니다. 특히 `SUPABASE_SERVICE_ROLE_KEY`, `SCORE_HMAC_SECRET`, `GROBLE_WEBHOOK_SECRET`은 서버 전용이며 `NEXT_PUBLIC_` 접두사를 붙이면 안 됩니다.

## 📁 폴더 구조

```
├── README.md
├── .env.example          # 환경변수 이름 목록 (값은 비움)
├── .github/
│   └── pull_request_template.md
├── docs/                 # 기획서, API 계약, DB 설계 문서
├── supabase/
│   └── migrations/       # DB 변경 파일 (각자 작성 → B가 통합)
├── src/
│   ├── contracts/        # 팀 공유 API 요청/응답 타입
│   ├── lib/              # 서버 공통 로직 (점수, 매칭)
│   └── server/           # 서버 업무 로직 (프로필, 무료 추천 조회)
└── tests/                # 단위 테스트, DB(RLS) 테스트 (tests/db 는 PGlite 사용)
```

## 🌿 브랜치 규칙

- `main` : 항상 실행되는 코드. **직접 push 금지**
- `feature/기능이름` : 기능 개발 (예: `feature/b-db-matching`, `feature/groble-webhook`)
- `fix/버그이름` : 버그 수정

**작업 순서**
1. `main` 최신화: `git checkout main && git pull`
2. 브랜치 생성: `git checkout -b feature/기능이름`
3. 작업 후 커밋 & push: `git push origin feature/기능이름`
4. GitHub에서 Pull Request 생성 → 팀원 1명 이상 확인 → merge

DB 변경은 각자 담당 영역의 마이그레이션 파일을 작성하고 B가 통합합니다. 공통 스키마 변경은 팀에 공유합니다.

## ✍️ 커밋 메시지 규칙

| 태그 | 의미 | 예시 |
|---|---|---|
| `feat:` | 새 기능 | `feat: 거리순 추천 함수 추가` |
| `fix:` | 버그 수정 | `fix: 차단 계정 후보 제외 누락 수정` |
| `docs:` | 문서 수정 | `docs: API 계약 갱신` |
| `style:` | 코드 포맷 등 (동작 변화 없음) | `style: 들여쓰기 정리` |
| `refactor:` | 리팩토링 | `refactor: 점수 계산 함수 분리` |
| `chore:` | 설정, 패키지 등 | `chore: vitest 설정 추가` |

## 📌 첫 버전 기능 (MVP)

- [ ] 가입 및 학교 이메일 인증 (A)
- [ ] 생년월일·문이과 입력 → 사주 풀이와 고정 점수 (A + B)
- [ ] 프로필 등록 및 공개 동의, 사진 (B)
- [ ] 무료 추천 3명 열람 (B)
- [ ] 상대 선택 → 상대당 500원 결제 및 서버 확인 (C + B)
- [ ] 대화 요청 및 수락 → 일대일 텍스트 채팅 (C)
- [ ] 차단·신고 (C + B)

후순위: 사진 전송, 읽음 표시, 입력 중 표시, 푸시 알림.

## 📄 문서

- 개발 계획: [`docs/`](./docs)
- 프로필·매칭 계약 (B ↔ C, DB 설계 포함): [`docs/CONTRACT_profile_matching.md`](./docs/CONTRACT_profile_matching.md)

개발 재개 시 최신 인수인계: [C_RESUME_2026-11-18.txt](./docs/C_RESUME_2026-11-18.txt).
