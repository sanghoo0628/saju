# 고려대학교 사주 매칭 웹

무료 추천 프로필 최대 3명 → 상대 선택 → 상대당 500원 → 대화 요청 → 상대 수락(무료) → 채팅.
사주와 매칭은 오락용이며, 결제가 상대의 수락이나 답장을 보장하지 않습니다.

## 현재 C 브랜치 상태 (2026-11-23)

A의 Next.js·인증·사주 코드(dd336a2)를 기존 B/C 코드에 통합했습니다.
인증된 학교 계정으로 `/matches`, `/requests`, `/chat`, `/orders/return`을 사용하도록 화면과 API를 연결했습니다.
기존 결제 권한·채팅방은 추가 결제 없이 사용하며, 새로운 결제와 웹훅 확정은 Groble 공식 연동 전까지 503으로 거부합니다.
실제 Supabase 로그인 및 두 계정 간 송수신 검증은 API 키 설정 후 수행해야 합니다.
A 사주 결과를 B의 fortune_results/private_birth_data에 저장하는 연결도 아직 필요합니다.
프로필 화면(`/profile`)은 B의 화면 연결을 기다리는 안내 화면이고, GET/PUT API는 연결했습니다.

팀 담당은 A(공통 앱·학교 인증·사주), B(프로필·매칭·DB·RLS), C(결제·요청·채팅)입니다.
main과 팀원 브랜치를 수정하지 않고 `codex/c-payment-chat`에서 작업합니다.

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

CA는 Supabase 대시보드 Database Settings에서 다운로드합니다. TLS 인증서 검증을 유지하며, CA 파일은 배포 환경에도 별도로 준비해야 합니다.
인증된 사용자 UUID는 A 서버 인증으로 확인하며, 브라우저 본문의 구매자·작성자 ID를 신뢰하지 않습니다.

## 검사

```bash
pnpm test        # B/DB+연동 111, C 129, A 89, UI 18 = 347
pnpm lint
pnpm typecheck
pnpm build
pnpm demo:build
pnpm test:http:local # 미설정 테스트 환경에서 빌드한 앱을 시작·검사·종료
pnpm test:postgres # 별도 네이티브 PostgreSQL 다중 연결 검사 10개
```

기본 검사와 빌드는 실제 Supabase 계정이나 결제 없이 실행합니다.
미설정 상태로 HTTP 검사를 할 때는 서버 실행 프로세스의 Supabase URL/공개 키를 함께 비워서 실행하세요.
실제 `.env.local`의 기존 비밀 값을 지우거나 교체하지 마세요.
네이티브 PostgreSQL 검사 10개는 [GitHub Actions 실행](https://github.com/sanghoo0628/saju/actions/runs/45118851935)에서 모두 통과했습니다.
로컬 Codex 환경의 공유 메모리 제한은 남아 있으므로 해당 검사는 CI에서 실행합니다. 기본 347개에 포함되지 않습니다.

C 브랜치 push와 main 대상 PR에는 `.github/workflows/c-validation.yml`이 앱/HTTP 검사와 네이티브 DB 검사를 자동 실행합니다.
문서만 바뀐 커밋은 제외합니다. 실제 Supabase/사주/결제 키는 CI에 필요하지 않습니다.
[자동 검증 결과와 재실행 방법](docs/C_CI_VALIDATION_2026-11-23.txt)을 참고하세요.

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
