# A → B/C 연결 계약

기준일: 2026-11-18. 상품 변경은 [DECISIONS.md](DECISIONS.md)가 기준이다. C 실제 소스 `c098404`와 후속 `b4cdf40`을 원격에서 확인했다. 로컬에는 C 공유 타입만 가져왔고 B/C 런타임은 미통합이다. **실제 API·상태·B 사주 저장의 차이와 통합 기준은 [A_BC_INTEGRATION_DESIGN.md](A_BC_INTEGRATION_DESIGN.md)를 따른다.**

## 서버 사용자 ID

```ts
import { getCurrentUserId } from "@/lib/auth/get-current-user-id";

// C 런타임 통합 후 createHttpApi에 요청별 인증 콜백을 주입한다.
const handle = createHttpApi({
  service,
  appOrigin,
  getCurrentUserId: () => getCurrentUserId(),
});
// 원래 Request를 handle(request)에 전달한다.
// null은 C가 최상위 {code:'UNAUTHENTICATED',message}와 401로 처리한다.
// 요청 JSON의 buyer_id, sender_id를 신원으로 사용하지 않는다.
```

- 반환형: `Promise<string | null>`. 문자열은 Supabase Auth의 UUID다.
- `server-only` 경계다. Route Handler, Server Action, Server Component에서 사용하고 Client Component로 가져오지 않는다.
- 각 요청의 쿠키에 연결된 Supabase 서버 클라이언트가 `auth.getUser()`로 신원을 검증한다. 전역 사용자 클라이언트나 `getSession()` 결과만으로 신원을 결정하지 않는다.
- `null`은 로그인 신원을 확인할 수 없음을 뜻한다. 설정 오류·공급자 장애는 유효 로그인으로 우회하지 않는다.
- 이 함수는 **로그인 신원만** 제공한다. 학교 이메일 확인, 프로필 완성, 활성 상태, 소개 동의, 성인·차단 조건, 주문/방 소유권은 해당 기능에서 별도 검사한다.
- 브라우저 `@/lib/supabase/browser`, 요청 서버 `@/lib/supabase/server`, 서버 관리자 `@/lib/supabase/admin` 경계를 지킨다. 관리자 키를 이용한 테스트로 사용자 RLS 검증을 대체하지 않는다.

설정 누락은 `ConfigurationError`다. A API는 자체 `apiHandler()`를 사용한다. C 연결에서는 README의 전체 예시처럼 인증 콜백에서 C `ServiceError('PROVIDER_UNAVAILABLE', 안전한 메시지)`로 변환하여 503을 반환한다. C 응답을 A의 중첩 error 형식으로 감싸지 않는다. 검증 실패는 null/401이다. 학교까지 필요한 작업의 `requireVerifiedSchoolUser()`도 B의 프로필/성인/활성/차단 판정을 대신하지 않는다.

### 구현된 A API

| 메서드·경로 | 입력 / 응답 |
|---|---|
| `POST /api/auth/login` | `{email}` → `{ok:true}`. 승인 도메인의 OTP 요청 |
| `POST /api/auth/verify` | `{email,token}` → `{ok:true}`. 6자리 OTP 검증 후 쿠키 세션 |
| `POST /api/auth/logout` | 현재 브라우저 세션 로그아웃 → `{ok:true}` |
| `GET /api/me` | `{userId,authenticated:true,schoolVerification:{status},profileStatus:'not_connected',eligibilityStatus:'not_ready'}` |
| `POST /api/fortune` | `FortuneInputRequest` → `FortuneResult(fortune_v2)`, 검증된 학교 사용자 필요. ready 200/설정 대기 503/동의·지원 입력 문제 422/rate limit 429/공급자 오류 502 |
| `POST /api/fortune/matching-basis` | 같은 입력 → `MatchingFortuneInput(matching_fortune_v1)`. 생시를 null로 별도 재계산, ready는 B 입력 준비만 의미. mock/필수 분석 누락 등 422, 설정 503, 공급자 오류 502, timeout 504, rate limit 429 |
| `GET /api/fortune/demo` | development의 고정 mock, 개인정보·로그인·결제 권한 없음. production 404 |

모든 응답은 private/no-store다. 일반 오류는 `{error:{code,message,fields?}}`이며 설정 누락 503, 미로그인 401, 미자격 403, 잘못된 입력 400이다. 일반 변경 요청은 `Origin=NEXT_PUBLIC_APP_URL`과 JSON body가 필요하다(로그아웃은 body 없음). 웹훅은 이 규칙을 적용하지 않는다. 실제 OTP 성공 경로는 공동 개발 Supabase 설정 후 통합 검증해야 한다.

### B용 사주 계약

`@/features/fortune/matching-input`의 서버 전용 `calculateFortuneForMatching(request, getFortuneServiceOptions(userId))`을 사용한다. `userId`는 위 인증 함수에서 결정한다. HRUM의 주용신·보조용신·오신 역할·선정 방법, 강약 원점수/분류/근거, 오행 개수를 공통 3주 기준으로 전달한다. 4주 개인 상세와 혼용하지 않는다. 준비 안 된 경우 데이터나 임의 점수가 없는 `not_ready`다.

분석 타입·비교키·미제공/null·공급자 엔진 버전 미공개와 저장/RLS 책임은 [FORTUNE_MATCHING_CONTRACT.md](FORTUNE_MATCHING_CONTRACT.md)에 정의했다. 이 입력이 ready여도 승인된 사주 조합 규칙이 없으면 **hybrid 매칭은 여전히 not_ready**다. HMAC은 여기서 비공개 캐시 식별에만 쓰며 legacy 문이과 점수가 아니다.

## 변경된 상품과 권한

`src/contracts/product.ts`가 현재 상품 상수를 제공한다.

| 행동 | 결제 필요 | 추가 조건 |
|---|---|---|
| 추천 프로필 3명 열람 | 없음 | 로그인/소개 자격·현재 공개 동의·차단 정책은 B 검사 |
| 선택한 새로운 상대에게 요청 | 상대당 500원 권한 | 서버 구매자와 수신자 조합에 대한 유효 권한 |
| 요청 수락/거절 | 없음 | 해당 요청의 수신자만 가능 |
| 수락한 대화에 메시지 전송 | 없음 | 참여자·차단·활성 방 조건 |
| 동일 상대와 기존 대화 계속 | 재결제 없음 | 유효한 기존 대화와 현재 접근 조건 |

무료 프로필 열람은 모든 DB row나 사진을 익명 공개한다는 뜻이 아니다. B의 실제 `ProfileCard`만 반환하며 원본 생년월일시, 학교 이메일, 공급자 원문, 비공개 Storage 경로는 포함하지 않는다. A의 `PublicProfileDto`는 이전 화면 투영 제안이며 B와 필드가 다르다. 어떤 투영 함수도 RLS·현재 접근권한 검사를 대신하지 않는다.

## 실제 B/C API 연결 기준

`contracts/payment-chat.ts`는 실제 C 원본 타입이며 `src/contracts/collaboration.ts`는 이를 재수출한다. 타입 제공이 로컬 C 라우트 구현 완료를 뜻하지 않는다. B는 `src/contracts/matching.ts`의 실제 계약을 사용한다.

| 경로 | 담당 | 계약 방향 |
|---|---|---|
| `GET /api/me` | A | 검증된 사용자와 이메일/학교 확인 상태. B 프로필 상태를 조회하기 전에는 완료로 추정하지 않음 |
| `POST /api/fortune` | A | 서버 입력 검증, 본인용 사주 결과. mock/실제/준비 안 됨 구분 |
| `PUT /api/profile` | B | 공개 동의·자격·희망 조건을 본인 ID로 저장 |
| `GET /api/match-results` | B | 무료 추천 results[].id를 C matchResultId로 사용. 현재 B는 1~3명을 허용하므로 3명 상품 설명과 부족 상태 정책 조정 필요 |
| `POST /api/orders` | C | `{matchResultId}`를 검증해 500원 주문 생성 또는 기존 권한/대화 반환 |
| `GET /api/orders/:id` | C | 로그인한 소유자의 결제와 권한 제공 상태 |
| `POST /api/webhooks/groble` | C | 사용자 로그인 없이 원문 서명 검증으로 인증 |
| `POST /api/chat-requests` | C | `{orderId}`와 로그인한 요청자·주문 대상에 대한 권한 검증 |
| `POST /api/chat-requests/:id/accept` | C | 수신자만 수락, 정렬된 사용자 쌍의 기존 방 재사용 |
| `POST /api/chat-requests/:id/reject` | C | 수신자만 거절, 재요청/환불 정책은 별도 |
| 메시지 조회·전송·Realtime | C+B | 참여자/차단/RLS 검증, 서버 또는 `auth.uid()`로 작성자 결정 |

상대 ID를 요청에 받는 것은 상대를 선택하는 행위다. 이것만으로 상대 조회·구매·메시지 권한을 인정하지 않는다. 서버는 실제 추천/공개/차단/기존 대화 상태를 검사하고 클라이언트 금액·점수·구매자·결제 완료 주장을 무시하거나 거부한다.

## 원래 요구와 통합 시 확인할 규약

- 원래 요구는 `payment_status`와 `fulfillment_status` 분리다. 현재 C API는 단일 OrderStatus를 쓰므로 두 상태 분리 완료로 간주하지 않는다. A는 C 상태를 그대로 표시하며 B/C 확장 과제로 남긴다. `fulfilled`는 **특정 상대에 대한 권한 제공**을 뜻한다.
- 주문의 `sellerReference`와 Groble `merchantUid`를 연결하고 원문 body·서명·시간·금액·상품을 검증한다. 실제 Groble 필드/서명 명세는 C가 공급자 문서와 샘플로 확정한다.
- 같은 멱등 키의 주문 재시도는 같은 결과를 반환하고, 같은 키의 다른 수신자 요청은 충돌이다. 이미 있는 권한/방에 불필요한 신규 결제를 만들지 않는다.
- 웹훅은 로그인 proxy/학교 확인 리다이렉트에서 제외한다. 사용자 세션이 없다는 이유로 거부하거나 세션이 있다는 이유로 허용하지 않는다.
- 이벤트 기록·주문 상태·상대별 권한 제공은 DB 트랜잭션 또는 내구성 있는 복구 상태로 연결한다. REST 호출 여러 번을 원자적이라고 부르지 않는다.
- 환불 후 늦은 완료 이벤트가 새 권한을 만들면 안 된다. 이미 수락한 채팅 처리의 세부 환불 정책은 운영 전 확정한다.
- 두 참여자의 정렬된 UUID 쌍에는 DB 고유 제약을 둔다. 양방향 요청 동시 수락도 방은 하나다.
- 메시지의 서버 멱등 키는 원래 요구이나 현재 C POST에는 없다. 응답 유실 시 자동 POST 재시도를 하지 않는다. 재접속 조회와 동일 메시지 ID 병합을 서버 전송 멱등성으로 간주하지 않는다.
- mock 결제 응답은 `providerMode: "mock"` 등으로 명시하고 실결제 완료로 표시하지 않는다. A에서는 결제 성공 mock을 만들지 않는다.

## 통합 시 검증할 변경 수용 기준

아래는 B/C가 연결된 후 실제 사용자 토큰과 DB로 실행할 검증이다. A의 로컬 테스트 통과만으로 완료 표시하지 않는다.

| ID | 기대 결과 |
|---|---|
| FREE-01 | 유효한 미결제 사용자가 자신의 추천 카드 3명을 무료 열람 |
| FREE-02 | 차단/비공개/탈퇴 및 사진 접근 제한은 무료 열람에도 유지 |
| TARGET-01 | X에게 산 권한으로 Y에게 대화 요청 불가 |
| TARGET-02 | 클라이언트 구매자·금액·결제 완료 위조 거부 |
| TARGET-03 | 동일 대상/멱등 키의 동시 주문·웹훅에도 권한 중복 제공 없음 |
| TARGET-04 | 동일 상대의 기존 대화 또는 권한이 있으면 불필요한 재결제 없음 |
| TARGET-05 | 환불→완료 역순 이벤트에도 회수된 요청 권한 복원 없음 |
| CHAT-01 | 미결제 수신자가 무료 수락/답장 가능, 요청자가 자기 요청 수락 불가 |
| CHAT-02 | 양방향 동시 수락에도 방 하나, 제3자의 조회/구독/전송 거부 |
| CHAT-03 | 차단 이후 새 요청/메시지 거부, 재접속 재전송 시 중복 없음 |
| MATCH-01 | 승인 규칙 없는 hybrid는 `not_ready`, 임의 궁합/LLM 점수 없음 |
| MOCK-01 | mock 사주/결제/예약 상태를 실제 성공으로 표시하지 않음 |

## 각 담당자에게 필요한 다음 입력

- **B → A:** 프로필/활성/소개 동의 상태 조회 함수, 사주 저장소 인터페이스 구현, 비공개 원본과 정규화 결과 저장/RLS.
- **C → A:** 실제 Groble gateway 계약·테스트 환경, 상태 분리와 메시지 멱등 키의 후속 계약. 이미 확인한 최신 소스는 재사용하고 이중 구현하지 않는다.
- **공동:** 같은 개발 Supabase, 허용 학교 도메인, 실제 테스트 계정, 최신 브랜치 반영 기준. 저장소는 sanghoo0628/saju로 확인했으며 키 값은 환경 변수로만 설정한다.

P1 활동의 입력은 두 사람의 시간·예산·이동 제약이며 수수료율은 추천 입력에 넣지 않는다. `src/contracts/activities.ts`는 확장 경계만 제공한다. 외부 링크 클릭만으로 예약 확정이나 수익을 기록하지 않는다.
