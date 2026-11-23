> 2026-11-23 실제 Supabase 연결 검증 후 OTP 입력을 숫자 6~10자리로 맞췄습니다.
> 아래의 고정 6자리 안내는 이전 계약입니다. 실제 코드 유효성은 Supabase가 계속 검증합니다.
> 최신 검증·남은 작업: [Supabase 검증 기록](C_SUPABASE_LIVE_QA_2026-11-23.txt).

> 2026-11-23 C 브랜치 통합 갱신: Next.js 라우트와 C 화면을 실제 코드로 연결했습니다.
> 아래의 "C 런타임 없음" 등의 설명은 A 단독 브랜치 작성 당시 기록입니다.
> 현재 조립부와 미완료 범위는 [C 통합 결과](C_A_INTEGRATION_2026-11-23.txt)를 확인하세요.

# 사이 — 대학생 사주 소개 서비스, A 공통 프로젝트

2026-11-16. **A 담당 범위인 공통 화면·인증·사주 연결 기반**입니다. B의 DB/프로필/매칭과 C의 주문/채팅 모듈은 아직 통합하지 않았습니다.

2026-11-18 업데이트: 팀 저장소 `sanghoo0628/saju`의 `c098404`와 후속 브랜치 끝 `b4cdf40`을 읽고 [A·B·C 통합 설계](A_BC_INTEGRATION_DESIGN.md)를 정리했습니다. C 공유 타입을 원문 그대로 추가하고 A 제안을 재수출로 교체했으며, 엄격 인덱스 검사와 `test:a` 경계를 준비했습니다. 전체 B/C 런타임을 가져오거나 main에 반영한 상태는 아닙니다.

현재 상품: **추천 프로필 3명 무료 열람 → 상대 선택 → 상대당 500원 대화 권한 결제 → 요청 → 상대 수락 → 채팅**. 같은 상대의 기존 대화, 수신자의 수락·답장은 무료입니다. 이전 문서의 결제 후 3명 공개 규칙은 적용하지 않습니다.

## 빠른 실행

Node **24.22.1**과 pnpm **11.25.0**을 사용합니다. `.nvmrc`, `.node-version`, `packageManager`와 lockfile을 고정했습니다. C의 Node 24 이상 요구에 맞춥니다.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
pnpm dev
```

http://localhost:3000 에 접속합니다. `.env.local`이 이미 있으면 복사로 덮어쓰지 마세요. 키를 넣지 않아도 홈·입력·고정 샘플 화면이 실행됩니다. **로그인은 503으로 연결 대기를 표시하고, 가짜 사용자/결제/추천 성공은 만들지 않습니다.** 샘플은 `/fortune/result`, 익명 고정 fixture는 `GET /api/fortune/demo`입니다. 생년월일을 입력해도 mock은 실제 사주를 계산하지 않습니다.

pnpm이 없다면 Node 설치 후 `npm install --global pnpm@11.25.0`으로 팀 버전을 설치합니다. 환경에 이미 pnpm이 있으면 전역 교체할 필요가 없습니다.

## 검사와 production 형태 로컬 실행

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm start
# 다른 터미널에서, 키 없는 로컬 설정 기준 HTTP 검증
pnpm test:http
```

`pnpm check`는 lint → typecheck → test → build를 실행합니다. `APP_ENV=development`는 로컬 주소만 허용하므로 `next build/start`로도 내부 샘플 확인이 가능합니다. 운영 설정과 구분하세요. 포트를 바꾸면 `NEXT_PUBLIC_APP_URL`도 실제 브라우저 origin과 일치시켜야 합니다.

## 실제 개발 Supabase 연결

기존 팀의 **개발 프로젝트**를 사용하세요. 이 작업에서 프로젝트 생성, 운영 DB 변경, 이메일 발송을 하지 않았습니다.

1. `.env.local`에 `NEXT_PUBLIC_SUPABASE_URL`, 새 형식의 `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`를 설정합니다. legacy anon 키는 현재 클라이언트에서 허용하지 않습니다. `SUPABASE_SECRET_KEY`는 A 로그인에 필요하지 않습니다.
2. 팀이 승인한 학교 도메인을 `ALLOWED_EMAIL_DOMAINS`에 쉼표로 입력합니다. 실제 학교를 임의로 기본값에 넣지 않았습니다. 빈 목록은 모두 거부하며 하위 도메인도 자동 허용하지 않습니다.
3. Supabase Auth에서 Email 로그인과 email confirmation을 설정합니다. Email Templates의 Magic Link 템플릿에 `{{ .Token }}`을 표시해 **6자리 OTP**를 보내도록 설정하고 만료 시간·길이를 맞춥니다. 개발 메일 발송 제한/SMTP 설정은 프로젝트에서 확인합니다.
4. Site URL/Redirect URLs를 개발 주소로 설정합니다. 이 구현은 메일 링크 callback 대신 입력한 이메일+OTP로 `verifyOtp`를 호출합니다. anonymous sign-in은 사용하지 않습니다.
5. `/login`에서 실제 접근 가능한 테스트 학교 메일로 가입·인증합니다. `GET /api/me`가 본인 UUID와 `schoolVerification.status=verified`를 반환하는지 확인합니다. 만료/틀린 코드, 로그아웃, 다른 도메인도 검사합니다.

인증은 재학 여부나 소개 자격 전체를 보증하지 않습니다. B가 활성 상태·성인 확인·프로필·동의·차단을 별도로 구현해야 합니다. 직접 Supabase Auth 호출로 가입한 계정도 보호 API에서 도메인과 확인 상태를 재검사합니다. 가입 자체를 제한할 Auth Hook 및 남용 방지/CAPTCHA 정책은 운영 연결 전 팀과 확정합니다.

## C 담당자 연결

아래는 C 모듈 통합 후 `src/server/payment-chat-runtime.ts`에서 사용할 조립 예시입니다. 현재 A 폴더에는 C 런타임이 없으므로 이 예시 자체가 실행 중인 라우트는 아닙니다.

```ts
import 'server-only';
import { getCurrentUserId } from '@/lib/auth/get-current-user-id';
import { ConfigurationError } from '@/lib/env/schema';
import { createHttpApi } from '../../packages/payment-chat/src/http.ts';
import { ServiceError } from '../../packages/payment-chat/src/service.ts';

// service는 재사용 pool/repository와 실제 검증 gateway로 만든 C 서비스.
const handle = createHttpApi({
  service,
  appOrigin,
  getCurrentUserId: async () => {
    try { return await getCurrentUserId(); }
    catch (error) {
      if (error instanceof ConfigurationError) {
        throw new ServiceError('PROVIDER_UNAVAILABLE', '인증 연결 설정이 필요합니다.');
      }
      throw error;
    }
  },
});
// Next Node Route는 handle(request)에 원문 Request를 그대로 전달.
// buyer_id/sender_id는 요청 JSON에서 받지 않음. null은 C가 UNAUTHENTICATED 401 처리.
```

함수는 요청 쿠키의 `auth.getUser()`를 검증하며 유효 신원이 없으면 null을 반환합니다. C 오류는 최상위 `{code,message}`를 유지하며 A의 `apiHandler`로 감싸지 않습니다. 설정 누락은 위 콜백에서 C의 503 오류로 변환합니다. 학교까지 필요한 작업에는 `requireVerifiedSchoolUser()`를 사용할 수 있으나 B의 소개 자격 검사를 대신하지 않습니다.

- 브라우저: `src/lib/supabase/browser.ts`
- 요청별 서버: `src/lib/supabase/server.ts`
- 관리자: `src/lib/supabase/admin.ts` (`server-only`, 세션 저장 안 함)
- C 주문·채팅 원본 계약: `contracts/payment-chat.ts`; A 호환 import: `src/contracts/collaboration.ts`. 주문은 `{matchResultId}`, 요청은 `{orderId}`, 주문 조회의 `targetId`는 null일 수 있습니다.
- Groble `/api/webhooks/*`는 쿠키 갱신 proxy 대상에서 제외했습니다. C가 raw body 서명으로 인증해야 합니다. 일반 사용자용 Origin 검사를 webhook에 붙이지 마세요.
- C 실제 소스와 pg 트랜잭션 어댑터를 원격에서 확인했습니다. c098404의 165개 및 최신 후속 변경의 251개 통과는 상위 보고이며 이 A 작업공간에서 재실행한 결과가 아닙니다. 기존 서비스·HTTP·UI를 재사용하는 설계를 남겼습니다.

정확한 통합 API·풀 수명·pnpm 전환·B 사주 저장의 차이는 [A_BC_INTEGRATION_DESIGN.md](A_BC_INTEGRATION_DESIGN.md), 과금과 권한 원칙은 [TEAM_CONTRACT.md](TEAM_CONTRACT.md)에 있습니다. 현재 `pnpm test`/`pnpm test:a`는 A의 88개 검사만 실행합니다. C 기본·UI·네이티브 DB 검사를 연결한 것으로 표시하지 않습니다.

## 사주와 데이터 경계

`src/features/fortune/`에 **HRUM 만세력 API의 실제 서버 어댑터**를 구현했습니다. 원국·오행·용신(주/보조, 희신/기신 등, 선정 방법)·강약(공급자 원점수/분류/근거/통근)을 `fortune_v2`로 정규화합니다. 가상 입력으로 공식 guest API의 3주·4주 호출 두 건을 확인했고, 인증된 partner API 호출은 키 설정 후 검증해야 합니다. [API 비교와 선정 이유](SAJU_PROVIDER_COMPARISON.md)를 참고하세요.

실제 연결은 `.env.local`에 `SAJU_PROVIDER=hrum`, 서버 전용 `SAJU_API_KEY`, 32자 이상의 무작위 `SAJU_FINGERPRINT_SECRET`을 설정하고 개발 서버를 재시작합니다. `SAJU_API_BASE_URL`은 비워두면 고정 공식 endpoint를 사용합니다. 이 URL을 다른 호스트로 바꿔 호출할 수 없습니다. 실제 로그인에는 위 Supabase 설정이 필요합니다. 학교 인증 후 `/fortune`에서 계산용 성별·시간대를 확인하고 HRUM 전송에 동의해 계산합니다. 성공한 partner 호출은 공급자 과금 대상이므로 개발 콘솔의 잔액·호출 제한을 먼저 확인하세요. 키 값은 채팅이나 git으로 공유하지 않습니다.

`POST /api/fortune`는 본인 상세 결과이고, `POST /api/fortune/matching-basis`는 **별도 3주 재계산**으로 B의 매칭 입력을 준비합니다. 두 경로 모두 인증·학교 확인·Origin·입력·별도 외부 전송 동의를 검사합니다. 4주 결과에서 시주만 지워 용신·강약을 재사용하지 않습니다. 화면의 3주 준비는 명시적 추가 버튼이며 자동 추가 호출하지 않습니다. B는 서버에서 `calculateFortuneForMatching()`을 사용하고, 브라우저가 제출한 분석 결과를 신뢰하지 않습니다. [B 연결 계약](FORTUNE_MATCHING_CONTRACT.md)에 타입·예시·검증 경계를 정리했습니다.

실제와 mock 모두 사용자별 HMAC 키의 최대 128건/5분 메모리 캐시와 동일 프로세스의 동시 중복 호출 병합을 사용합니다. 분산 환경·재시작·만료 이후의 재과금 방지는 보장하지 않습니다. 영구 저장은 아직 없으며 B가 비공개 저장/RLS·동의 기록·분산 중복 방지를 연결해야 합니다. 공급자 오류나 설정 누락을 guest/mock 성공으로 바꾸지 않습니다. 외부 전송 필드·날짜 경계·오류 계약·연결 절차는 [공급자 문서](FORTUNE_PROVIDER.md)에 있습니다.

PDF의 `legacy_demo_v1` 점수와 사주60/선호25/만남15는 별도 B 전략입니다. A는 궁합 점수나 승인 규칙을 생성하지 않습니다. 미완성 hybrid는 B 통합 시 반드시 `not_ready`로 유지해야 합니다.

## 운영 설정과 역할 경계

운영은 `APP_ENV=production`, HTTPS 앱/Supabase URL, 허용 학교 목록, 명시적 전략이 필요합니다. mock 사주는 차단됩니다. 이 A 프로젝트에서는 `PAYMENTS_ENABLED`와 `MOCK_PAYMENTS_ENABLED`를 true로 켜면 시작을 거부합니다. B/C 연결과 운영 정책 확인 후 해당 모듈에서 활성화를 구현하세요. `NEXT_PUBLIC_*`에는 관리자/사주/Groble 키를 절대 넣지 마세요. `.env.local`은 git 제외입니다.

DB 마이그레이션·RLS·테스트 계정 절차는 [supabase/README.md](../supabase/README.md), 구현/목업/설정 대기 및 검증 결과는 [STATUS.md](STATUS.md)에 구분했습니다. 활동 추천/예약은 타입 경계만 있으며 외부 링크를 예약·수익 확정으로 기록하지 않습니다.

착수 시 이 폴더는 Git 저장소가 아니었고 remote가 없었습니다. 로컬 `main`을 초기화했지만 커밋하지 않았습니다. 현재 팀 저장소는 [sanghoo0628/saju](https://github.com/sanghoo0628/saju)로 확인했습니다. 이번 재설계에서는 remote 설정·브랜치 생성·원격 main 반영·배포를 하지 않았습니다. 실제 통합은 최신 C 브랜치의 이력을 보존하는 별도 checkout/worktree에서 진행하도록 정리했습니다.

## 문서와 버전 근거

[결정 기록](DECISIONS.md)이 최신 사용자 지시를 반영합니다. 원래 [통합 명세](CODEX_HANDOFF.md), [작업 기준](TASKS_AND_ACCEPTANCE.md), [활동 계획](ACTIVITY_BOOKING_PLAN.md), `references/`는 배경 자료로 보존합니다.

공식 문서와 npm registry를 2026-11-16 확인했습니다: [Next.js 설치](https://nextjs.org/docs/app/getting-started/installation), [Node 24.22.1](https://nodejs.org/en/blog/release/v24.22.1), [pnpm 설치](https://pnpm.io/installation), [Supabase SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client), [이메일 OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless).

Next 16.4.6/React 19.3.1/Supabase SSR 0.12.7을 고정했습니다. Next의 린트 플러그인이 ESLint 10/TypeScript 7을 지원하지 않아 호환되는 ESLint 9.39.5/TypeScript 6.0.3을 사용합니다. ESLint 9의 지원 종료 경고는 알려진 개발 도구 제한이며, 플러그인 지원 시 함께 갱신해야 합니다. 설치된 팀 도구 pnpm 11.25.0을 유지했고 pnpm 12로 전역 변경하지 않았습니다.
