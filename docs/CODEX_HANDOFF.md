# Codex 개발 인수인계 명세 — 대학생 사주 매칭·활동 예약 서비스

> **2026-11-16 사용자 변경사항:** 이번 구현은 **A(공통·인증·사주)만** 진행한다. **추천 프로필 3명 무료 확인 → 선택한 상대당 500원 결제 → 대화 요청 → 수락 → 채팅**이 최신 계약이다. 같은 상대와 기존 대화는 재결제 없이 유지하고 수신자 수락·답장은 무료다. 아래 원문의 ‘결제 후 3명 공개’, ‘paid+fulfilled 프로필 열람’, 주문에 묶인 추천 제공 규칙은 폐기된 이전 기준이다. [최신 결정/차이](DECISIONS.md)와 [A→B/C 연결 계약](TEAM_CONTRACT.md)을 먼저 읽는다. 아래는 변경 추적을 위해 보존한 v1.0 원문이다.

작성일: 2026-11-16 / 버전: 1.0<br />
문서 목적: 기존 아이디어, 알고리즘 초안, 고려대학교 사주매칭 개발계획 PDF, C 담당자의 연동 요구를 한 개발 기준으로 정리한다. 이 문서는 구현 완료 보고서가 아니다.

## 0. 먼저 읽을 내용과 현재 상태

이 문서와 `ACTIVITY_BOOKING_PLAN.md`, `TASKS_AND_ACCEPTANCE.md`를 읽고 개발한다. 원문 근거는 `references/`에 보존했다.

- 사용자 목표: 외부 API로 상세 사주를 계산하고, 자체 기준으로 사람을 추천하며, 두 사람이 함께할 활동과 예약까지 연결하는 대학생 대상 서비스.
- 현재 상품 흐름: 사주 결과 → 프로필 등록 → 500원 결제 → 추천 3명 확인 → 대화 요청 → 상대 수락 → 1:1 채팅.
- 초기 대상: PDF의 고려대학교 대상 파일럿을 보존한다. 확장은 대학생 전체로 고려한다. 허용 학교 도메인은 아직 확정되지 않았으며 개발자가 임의로 넣지 않는다.
- 미확인: 개발 저장소, 기존 코드 상태, 실제 Supabase 프로젝트, 외부 사주 API 계약·키, Groble 판매자·상품·500원 결제 조건, 예약 제휴처·API.
- 이 인계 작업에서 프로젝트 생성, main 업로드, 실결제, 실제 API 호출, 실제 이용자 효과 검증을 수행한 것으로 간주하지 않는다.
- 모든 가중치와 매출 예시는 실험용 가정이다. 사주 점수를 연애 성공확률이나 인성 측정값으로 표현하지 않는다.

### 문서 우선순위

1. 이후 사용자가 명시하는 변경 지시.
2. 본 문서의 현재 상품 범위와 개발 규약. 실제 외부 계약은 해당 연동의 제약으로 적용.
3. 첨부 원문은 설계 배경으로 활용.

기존 코드는 현재 구현 상태이며 제품 요구보다 우선하는 확정 요구사항이 아니다. 외부 계약과 제품 요구가 충돌하면 충돌을 기록하고 관련 기능만 보류하며, 계약에 어긋나는 동작을 구현하지 않는다.

기존 구현이 있으면 덮어쓰지 말고 차이를 기록하고 통합한다. 아래 '제안'은 개발을 진행하기 위한 기본안이며, 사용자 또는 외부 업체의 확정 사실로 표현하지 않는다.

## 1. 제품 의도와 수익화 가설

사주로 관심과 대화의 계기를 만들고, 상호 조건을 만족하는 상대를 소개한 다음 실제 만남의 시간·장소·활동 결정까지 돕는다.

| 수익원 | 현재 범위 | 주의점 |
|---|---|---|
| 프로필 열람·대화 요청권 | MVP: 500원, 해당 주문의 추천 3명 | 수락이나 만남 성사를 보장하지 않음 |
| 매칭 확정 수수료 | 과거 확장 아이디어로 보존 | 현재 500원 상품에 별도로 추가하지 않음 |
| 제휴 활동 예약 성사 수수료 | 확장 단계 | 실제 제휴 계약과 이용·정산 확인 필요 |
| 사용자 예약 대행 수수료 | 선택적 확장 가설 | 별도 가치와 사전 가격 고지 필요, 기본 활성화하지 않음 |
| 협찬·광고 노출 | 후순위 | 일반 적합도 순위와 구분하여 표시 |

활동 중개 수수료와 예약 수수료가 같은 거래의 동일 대가라면 매출을 두 번 더하지 않는다. 외부 예약 링크를 제공하거나 클릭했다고 수익이 발생한 것으로 기록하지 않는다.

차별성 가설은 '사주 + 예약'이라는 기능 묶음 자체가 아니라, 학교·생활권의 높은 후보 밀도, 양방향 조건, 학생 예산·일정, 설명 가능한 추천, 실제 만남으로의 전환이다. 경쟁 우위가 검증됐다고 주장하지 않는다.

### 수익 검증에 필요한 계측

현재 500원 상품은 무료 사주 사용자 전체의 비용도 부담한다. 결제 1건의 API 비용만 보는 방식은 사용하지 않는다.

```text
기간 공헌이익 =
  실제 프로필 상품 결제액 - 환불액 - 결제 처리 비용
  + 확정된 제휴 수수료 + 별도로 합의된 대행료
  - 전체 사주/API/설명 생성 비용
  - 할인·지원금 - 변동 운영·CS 비용

기간 손익 = 기간 공헌이익 - 고정 운영비 - 획득 비용
```

예약 거래액 전체와 플랫폼 수수료 매출을 구분한다. 세금·정산 기준은 계약 확인 후 별도로 확정한다. 2인 활동비 40,000원 × 수수료율 15% = 6,000원은 과거의 단순 가정 예시이며 실제 계약·순이익이 아니다.

## 2. 기존 자료의 충돌과 이번 인계에서의 처리

| 항목 | PDF | 이전 알고리즘 초안 | 개발 기준 |
|---|---|---|---|
| 사람 추천 | 생일 HMAC + 문이과 부호, 점수 합 거리 | 사주 S·선호 P·실행 가능성 M | 교체 가능한 별도 전략으로 구현 |
| 공개 인원 | 결제 1건당 3명 | 하루 5명 테스트안 | 현재 상품은 주문당 정확히 3명 |
| 매칭 의미 | 오락용 고정 숫자 | 외부 원국 기반 자체 해석 | 두 방식을 같은 '사주 궁합'으로 표시하지 않음 |
| 일정·활동 | 채팅 이후 미구체화 | 약속 제안 모드 우선 | MVP 채팅 완성 후 일정·활동 확장 |
| 사주 공급자 | 기존 프로그램 실행 방식 확인 | HRUM 예시 필드 | 공급자 어댑터로 분리, HRUM 확정 아님 |
| 결제 시점 | 프로필 공개 전 500원 | 매칭 확정비 아이디어 | PDF의 공개 전 결제 우선 |
| 예약 중개 | 기본 MVP에 없음 | 활동 연결 포함 | P1 수동·링크형, P2 계약 API형 |

이번 인계의 기본안:
- `legacy_demo_v1`: PDF 방식. 개발용 기본 전략으로 전체 흐름을 검증한다. 실제 사주 호환성 모델이라고 부르지 않는다.
- `saju_hybrid_v0_1`: 실제 사주·선호·일정 기반 전략. 규칙표 승인 및 입력 준비가 필요하다.
- 운영 결제를 켤 때는 적용 전략을 명시적으로 선택한다. 환경 변수가 없다고 legacy로 조용히 대체하지 않는다.
- 운영에서 hybrid 계산이 불가능하면 `not_ready`를 반환하고 해당 조건의 결제를 막는다. 난수나 LLM 점수로 채우지 않는다.
- M이 없는 사주·선호 전용 탐색 모델은 아직 합의된 산식이 없다. 별도 모델 설계 없이 0점·50점을 대입하거나 가중치를 바꾸지 않는다.
- 이미 구매한 주문의 3명은 전략 변경이나 새로고침으로 바뀌지 않는다. 단, 공개 철회·차단 등 현재 권한 검사는 계속 적용한다. 제공 완료 후 접근이 철회된 슬롯은 접근 불가로 표시하고 임의의 다른 사람으로 교체하지 않는다. 전체·부분 보상은 별도 상품 정책으로 처리한다.

## 3. 단계별 범위

### P0 — 실제 연결 가능한 MVP

- Next.js 공통 프로젝트, 인증, 학교 이메일 검증 구조.
- 사주 입력·무료 결과, mock/실제 공급자 어댑터.
- 프로필 등록·공개 동의·희망 조건.
- 전략 인터페이스와 legacy 데모, hybrid 계산 인터페이스·준비 상태.
- 서버 주문, Groble 결제 링크·웹훅, 동일한 3명 저장·공개.
- 대화 요청·수락·거절, 1:1 텍스트 채팅, 대기 요청·대화 목록.
- 차단·신고, 사진·프로필·채팅 접근 제어.
- 취소·환불 상태 반영, 실패 복구, 통합 테스트.

### P1 — 사주 매칭과 함께할 활동 고도화

- 승인된 사주 규칙표, 공통 3주 파생지표, S/P/M 계산 검증.
- 연락·만남·활동 선호와 가능한 일정·이동 범위·예산.
- 둘 다 실행 가능한 활동 계획, 추천 근거, 사용자 테마 확인.
- 대학가 직접 제휴 3~5곳을 검증 후보로 삼는 수동 운영.
- 외부 예약 링크 또는 예약 요청·수동 확인. 예약 확정 여부를 구분.
- 추천·수락·일정·참석·예약·수익 지표 계측.

### P2 — 제휴 예약 자동화

- 계약과 접근 권한을 확보한 공급자 API만 연결.
- 재고·견적·예약 생성·취소·환불·정산·웹훅.
- 예약 권한·중복 방지·재고 소진·부분 실패 복구.
- 수수료 정산과 파트너 운영 화면.

사진 메시지, 읽음·입력 중 표시, 푸시 알림, 대규모 소셜 피드, 외모 평가, 별도 채팅 서버는 초기 범위에서 제외한다. P1/P2 때문에 P0 완성을 지연하지 않는다.

## 4. 팀 역할과 공통 저장소

| 담당 | 소유 범위 | 협업 책임 |
|---|---|---|
| A | 공통 Next.js·UI·로그인·학교 인증·사주 입력/결과·배포/env | 공급자 어댑터와 C가 쓸 서버 인증 함수 제공 |
| B | 공통 DB·마이그레이션 통합·프로필·추천 전략·추천 결과·RLS | C의 주문 트랜잭션·채팅 권한 지원 |
| C | Groble 주문·웹훅·취소/환불·대화 요청·채팅·차단/신고 | 주문/채팅 마이그레이션 작성, B와 통합 |
| 공동 | API 규약·상품 범위·통합 테스트·운영 정책 | 변경 시 문서와 타입 동시 수정 |

C는 공통 사용자 ID와 함수 계약을 먼저 받아 UI와 단위 기능을 개발할 수 있다. 통합 테스트에서는 동일 개발 Supabase 프로젝트에 실제 테스트 계정을 만들어 로그인한다. 임의 UUID로 인증을 대체하지 않는다.

새 저장소 기준 제안: Next.js App Router + TypeScript + pnpm + Supabase Auth/Postgres/Storage/Realtime. 기존 저장소의 패키지 매니저나 버전이 정해져 있으면 불필요하게 교체하지 않는다.

- `package.json`에 패키지 매니저 버전, Node 버전 조건을 명시하고 lockfile을 커밋한다.
- 구현 시 현재 공식 문서를 확인해 호환 버전을 고정한다. 이 문서는 검증하지 않은 최신 버전 번호를 지정하지 않는다.
- 실행: `pnpm install` → `.env.example`을 `.env.local`로 복사·설정 → `pnpm dev`.
- 검사 스크립트: lint, typecheck, test, build. 실제 명령은 package.json에 등록하고 README와 맞춘다.
- 저장소가 제공되지 않았다면 새 GitHub 저장소나 원격 main을 임의로 지정하지 않는다. 로컬 개발은 진행 가능하다.
- 원격 main 반영 여부와 권한이 확인되면 그 지시에 따른다. 문서만 보고 이미 push됐다고 말하지 않는다.

권장 코드 경계:

```text
src/app/                       화면과 Route Handlers
src/lib/supabase/              browser, server, admin 클라이언트
src/lib/auth/                  getCurrentUserId, 학교/활성 상태 확인
src/features/fortune/          입력, 공급자 어댑터, 정규화
src/features/profiles/         공개/비공개 프로필
src/features/matching/         전략, 필터, 규칙표, 설명
src/features/payments/         주문, Groble, 이벤트 처리
src/features/chat/             요청, 방, 메시지
src/features/activities/       P1 활동 계획
src/features/bookings/         P1/P2 예약 제공자
supabase/migrations/           B가 통합하는 마이그레이션
tests/                        계산, 권한, 결제, 통합 테스트
docs/                         개발 결정, 실행법, 상태
```

폴더명은 제안이며 기존 구조가 합리적이면 유지한다.

## 5. 사용자 ID·인증·환경 변수 계약

### 공통 식별자

- 기준은 Supabase Auth의 `auth.users.id`.
- TypeScript는 string, Postgres는 uuid.
- profiles.user_id, orders.buyer_id, chat_requests.requester_id/recipient_id, messages.sender_id는 이 ID를 참조한다.
- 이메일·닉네임·프로필 별도 PK·Groble 구매자 번호를 회원 ID 대신 사용하지 않는다.
- 구매자·메시지 작성자는 검증된 로그인 컨텍스트에서 정한다. 클라이언트가 보낸 ID만으로 소유권을 결정하지 않는다.

### A가 제공할 공통 함수

```ts
// 제안 경로: src/lib/auth/get-current-user-id.ts
import 'server-only';
import { createClient } from '@/lib/supabase/server';

export async function getCurrentUserId(): Promise<string | null> {
  const supabase = await createClient();
  const { data: { user }, error } = await supabase.auth.getUser();
  return error || !user ? null : user.id;
}
```

서버 클라이언트는 해당 요청 쿠키에 연결한다. 서버 전역 변수에 사용자 세션 클라이언트를 공유하지 않는다. 인증 쿠키 갱신과 캐시 제어는 채택한 Next.js/Supabase 버전의 공식 SSR 지침대로 구현한다.

Route Handler는 미인증 시 401 JSON, 인증됐지만 자격·소유권이 없으면 정책에 맞는 403/404를 반환한다. getSession 결과만으로 사용자 신원을 신뢰하지 않는다. 로그인 여부와 학교 인증·활성 상태·소개 동의는 별도 확인한다.

Groble 웹훅은 로그인 세션이 없다. 로그인 리다이렉트와 사용자 쿠키 검사 대상에서 제외하고 Groble 서명으로 인증한다. webhook → sellerReference → 내부 order → buyer_id 순으로 연결한다.

### 환경 변수

동봉한 `.env.example`은 빈 템플릿이다. 실제 키는 넣지 않았다.

- 브라우저: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, NEXT_PUBLIC_APP_URL.
- 서버 전용: SUPABASE_SECRET_KEY, SAJU_API_KEY, GROBLE_WEBHOOK_SECRET, LEGACY_SCORE_SECRET 등.
- 기존 Supabase가 legacy anon/service_role 키를 쓰면 실제 설정을 확인해 명칭과 클라이언트를 맞춘다. secret/service_role을 NEXT_PUBLIC 변수로 만들지 않는다.
- 사주·Groble·학교·매칭 전략·활동 공급자 설정은 시작 시 스키마 검증한다.
- 공개 키도 사용자의 저장소 정책에 맞춰 값 없이 공유한다. .env.local은 제외하고 .env.example은 추적한다.
- 개발 mock, 실제 API, 실결제 활성화는 각각 구분한다. 운영에서 mock 결제 성공·고정 테스트 계정 우회가 활성화되지 않게 한다.
- 여러 개발자는 같은 개발 프로젝트를 사용하고, 운영 데이터와 테스트는 분리한다.

## 6. 최소 데이터 모델

아래 컬럼명은 협업 계약 제안이다. B가 실제 스키마를 확정하고 C와 공유한다. 암묵적 전체 공개 SELECT 정책을 만들지 않는다.

| 테이블 | 핵심 필드·역할 |
|---|---|
| profiles | user_id, nickname, bio, photo_path, academic_track, public_consent_at, profile_completed_at, active |
| private_birth_data | user_id, 생년월일시, calendar, leap_month, timezone, 계산 옵션; 비공개 |
| user_preferences | user_id, 만남 대상·연령 범위·목적·필수 조건·선택 선호 |
| fortune_results | id, user_id, status, provider, basis, normalized_chart, 해석, source/version, input_fingerprint |
| legacy_matching_scores | user_id, legacy_score, score_version, calculated_at; PDF 오락용 점수를 실제 사주 결과와 구분 저장 |
| matching_rule_sets | id, version, status=draft/approved, 방법·근거·규칙 데이터 |
| orders | id, buyer_id, product_code, expected_amount_krw=500, seller_reference, merchant_uid, payment_status, fulfillment_status, strategy/version |
| payment_events | provider_event_id, idempotency_key, merchant_uid, type, occurred_at, processing_status, 제한된 감사 데이터 |
| match_results | id, order_id, candidate_id, rank, model_id, score_components, reasons, versions, created_at |
| chat_requests | id, requester_id, recipient_id, match_result_id, status, responded_at |
| conversations | id, participant_low_id, participant_high_id, status, created_at |
| messages | id, conversation_id, sender_id, client_message_id, body, created_at |
| blocks | blocker_id, blocked_id, created_at |
| reports | reporter_id, target_type/id, reason, status, created_at |

P1/P2 테이블은 활동 문서에 정의한다. 현재 필요하지 않은 테이블을 무조건 먼저 구현하지 않는다.

필수 제약:
- orders.seller_reference 고유, merchant_uid는 값이 있을 때 고유.
- 결제 이벤트 고유 키, 동일 거래의 중복 제공 방지.
- match_results: unique(order_id, candidate_id), unique(order_id, rank), rank 1~3.
- '정확히 3개'는 개별 row CHECK만으로 보장되지 않는다. 제공 완료 트랜잭션에서 검사한다.
- conversations: 정렬된 사용자 쌍 unique; 두 참여자는 달라야 한다.
- messages: unique(conversation_id, sender_id, client_message_id)로 재전송 중복 방지.
- sender/participant/accepted/paid 상태는 임의 클라이언트 변경 불가.
- 탈퇴 시 모든 결제 관련 FK에 무조건 ON DELETE CASCADE를 붙이지 않는다. 프로필 비활성·민감정보 삭제와 주문·환불 추적을 구분한다.

사주 입력 원본과 공급자 raw 응답은 필요 범위만 제한 저장하고 로그에서 제거한다. 보관 기간·외부 전송·삭제 정책은 운영 전 확정한다.

## 7. API 계약

모든 입력은 서버에서 검증한다. 아래는 초기 계약이며 응답 필드는 타입으로 공유한다.

| 메서드·경로 | 담당 | 핵심 동작 |
|---|---|---|
| GET /api/me | A | 검증된 사용자 ID·인증/프로필 상태 |
| POST /api/fortune | A+B | 사주 입력 검증, 계산/캐시, 상태와 본인 결과 |
| PUT /api/profile | B | 본인 프로필·공개 동의·필수 조건 저장 |
| POST /api/orders | C+B | 자격·후보 3명 확인, 500원 pending 주문과 결제 URL |
| GET /api/orders/:id | C | 소유자의 결제/제공 상태; 복귀 화면 조회용 추가 제안 |
| POST /api/webhooks/groble | C | 서명 검증·이벤트 기록·멱등 처리 |
| GET /api/orders/:id/matches | B | 소유권·결제·제공·현재 공개 권한 확인 후 저장된 결과 |
| POST /api/chat-requests | C | match_result_id를 받아 요청 권한 검증 |
| POST /api/chat-requests/:id/accept | C | 수신자 확인, 원자적으로 수락·방 생성/재사용 |
| POST /api/chat-requests/:id/reject | C | 수신자 확인 후 거절 |
| POST /api/blocks | C+B | 본인 차단 관계 저장·새 메시지 차단 |
| POST /api/reports | C+B | 신고 저장, 중복·남용 제한 |

채팅 기록/전송은 Supabase 클라이언트 + RLS로 구현 가능하다. 서버 API를 택해도 같은 권한 검사를 수행한다.

주문 생성 요청에는 buyer_id, amount, paid, score, arbitrary candidate_ids를 받지 않는다. 서버가 고정 상품 설정과 로그인 사용자, 전략 결과로 결정한다. 동일 Idempotency-Key의 재시도는 같은 주문을 반환한다. 키 재사용 시 다른 요청 내용이면 충돌 처리한다.

주문 응답 예시는 계약용이며 현재 구현 결과가 아니다.

```json
{
  "orderId": "내부 UUID",
  "amountKrw": 500,
  "paymentStatus": "pending",
  "fulfillmentStatus": "pending",
  "checkoutUrl": "검증된 Groble 결제 링크와 ref"
}
```

표준 오류 예: UNAUTHORIZED, PROFILE_REQUIRED, VERIFICATION_REQUIRED, INSUFFICIENT_CANDIDATES, MATCHING_NOT_READY, PAYMENT_PENDING, FULFILLMENT_PENDING, ENTITLEMENT_REVOKED, BLOCKED, PROVIDER_UNAVAILABLE. 응답에 다른 사용자의 개인정보나 후보 미공개 프로필을 넣지 않는다.

## 8. 사주 공급자와 계산 계약

### 공급자 선택

개인별 사주 계산은 외부 엔진에 맡기고 매칭 정책·순위·설명·활동 연결은 자체 소유한다.

- HTTP API: Next.js 서버 어댑터에서 호출.
- 기존 Python 함수: 얇은 HTTP 서비스로 감싼 뒤 접근 가능한 환경에 배포.
- 화면 전용 프로그램: API/라이브러리 제공 여부 확인 전 자동 연동 가능하다고 가정하지 않는다.
- 배포 서버가 개발자 노트북 localhost에 접근할 수 있다고 가정하지 않는다.
- 공급자 미정이어도 mock 응답과 어댑터 계약으로 개발한다. mock 화면에 샘플 표시를 하고 운영 응답과 섞지 않는다.

HRUM은 후보 예시다. 공식 문서에는 wonkuk, ohaengBalance, yongshinDetail, strength 등의 구조화 응답과 생시 생략 시 3주 계산이 안내돼 있다. 실제 응답·옵션·요금·가공/캐시 조건을 계약과 테스트로 확인한 뒤 채택한다. 이 문서만으로 키나 이용 권한이 확보된 것이 아니다.

### 내부 정규화

최소 필드: provider, provider_version/schema_version, input_fingerprint, chart_basis(three/four_pillars), year/month/day/hour(nullable), 오행 계산 기준, 용신/강약 분석 기준, calculated_at, limitations, status.

- stem/branch는 안정적인 내부 코드로 정규화하고 unknown 코드는 오류로 처리.
- birthHour, 3주/4주 파생지표 여부를 검증.
- 공급자의 성별 입력 옵션과 사용자의 매칭 희망 대상은 별개의 데이터. 생년월일이나 사주로 만남 대상을 추론하지 않음.
- 전체 입력·옵션·공급자 버전을 포함한 비공개 캐시 키 사용. 생년월일을 평문 URL/로그에 넣지 않음.
- 실패, rate limit, timeout은 오류/재처리 상태로 유지. 가짜 정상 결과 저장 금지.
- 원국 내부 branchRelations를 두 사람 간 관계로 그대로 사용하지 않음.
- LLM은 선택적 설명 도구이며 점수 결정 권한이 없음. 우선 근거 템플릿으로 구현 가능.

## 9. 사람 추천 알고리즘

### 9.1 공통 후보 필터

본인, 미성년·성인 여부 미확인, 비활성·탈퇴, 공개 미동의, 필요한 인증 미충족, 양방향 필수 조건 불일치, 상호 차단, 운영상 제외 계정은 제외한다. 단순 신고 접수만으로 자동 유죄 판정하지 말고 처리 상태를 구분한다.

연령·소개 참여·희망 대상·관계 목적·생활권은 직접 입력/확인한 조건으로 평가한다. 학과 계열로 성별이나 취향을 추정하지 않는다. 학과가 어느 계열에 속하는지 불명확하면 임의로 이과/문과에 넣지 않는다.

재구매·기존 노출 제외는 원문에서 미확정이다. 초기 개발 기본안은 동일 상품 반복 구매를 비활성화하고, 기능 활성화 전 이전 노출·거절·차단·수락 관계 정책을 정한다. 주문 재시도는 재구매가 아니다.

### 9.2 legacy_demo_v1 — PDF 기준

```text
base = 1 + (integer(HMAC(secret, canonical_birth_date)) mod 10000)
score = academic_track == humanities ? +base : -base
distance(A,B) = abs(score_A + score_B)
정렬: distance 오름차순, 이후 고정 동점 기준
```

- HMAC은 SHA-256, 입력은 YYYY-MM-DD, 정수 해석은 unsigned big-endian으로 명세하고 테스트 벡터를 고정하는 것을 이번 인계의 구현 제안으로 둔다.
- 정수 변환은 BigInt 등 손실 없는 연산을 사용한다. JavaScript Number로 전체 해시를 변환해 정밀도를 잃지 않는다.
- 같은 생년월일은 같은 base를 갖고 충돌은 허용한다.
- secret은 서버에만 저장. 기존 score와 version을 보존하여 secret 교체로 기존 점수를 자동 변경하지 않는다.
- birthday/academic_track 변경 후 재계산 정책은 운영 전 확정; 기존 주문 결과는 유지.
- 기본 동점은 candidate UUID 정렬처럼 재현 가능한 기준으로 고정한다. 인기도로 임의 조정하지 않는다.
- 반대 계열만 허용하려면 별도 필터를 명시해야 한다. 수식만으로 보장되지 않는다.
- 표시는 '오락용 매칭 점수'. 사주 API 분석으로 나온 궁합 수치라고 설명하지 않는다.

### 9.3 saju_hybrid_v0_1 — 기존 사주 기반 초안

```text
R = 0.60*S + 0.25*P + 0.15*M

S = 0.30*C_stem + 0.40*C_branch + 0.30*C_element
C_branch = 0.60*일지관계 + 0.25*월지관계 + 0.15*년지관계
C_element = (E_A(B) + E_B(A)) / 2

P = min(P_A(B), P_B(A))
M = 0.50*시간점수 + 0.30*이동점수 + 0.20*활동선택점수
```

모두 0~100 초기 정책이며 검증된 연애 성공확률이 아니다. UI에는 항목별 근거와 제한을 설명하고 내부 소수점 점수를 과도한 정밀도로 표시하지 않는다.

S의 구성:
- 천간: 초기에는 일간 관계만. 여기서 파생되는 십성을 다시 가산하지 않는다.
- 지지: 일/월/년의 같은 위치 비교. 모든 교차 3×3 관계를 더하지 않는다.
- 오행·용신: 같은 공급자 해석·계산 기준으로 양방향 비교. '없는 오행=용신' 가정 금지.
- 십성, 신강약, 격국은 해석 문맥. 별도 중복 점수 없음.
- 대운·세운·신살·삼합 등 복잡 관계는 초기 순위 가산에서 제외.
- 공급자의 종합 궁합 점수는 별도 비교 모델로만 사용. 자체 S와 중첩 금지.

규칙표:
- rule_id, version, input_conditions, score, evidence, source, component, directionality, status.
- draft와 approved를 구분한다.
- 규칙표는 현재 미완성이다. Codex가 조합별 점수를 즉흥적으로 만들어 approved로 저장하지 않는다.
- 테스트 fixture는 synthetic임을 표시하고 운영 규칙 로더에 들어가지 않도록 분리한다.
- 동일 evidence_id는 한 점수군에만 귀속한다.
- 누락 규칙은 not_ready. 0점이나 중립 점수로 조용히 채우지 않는다.

생시·결측:
- 순위는 전원 공통 년·월·일 3주 기준, 생시를 아는 이용자의 4주는 상세 해석용으로 별도 저장.
- 3주 순위에 4주 기반 오행/용신 값을 섞지 않는다.
- 생시 미상을 정오/자정으로 대체하거나 감점하지 않는다.
- 원천 원국 누락은 재처리 대상.
- 선택 필드가 없으면 목록 전체에 공통 core 모델을 사용하거나 보완 후 계산:
  S_core = (0.30*C_stem + 0.40*C_branch) / 0.70.
- S와 S_core를 같은 목록에서 혼합하지 않는다. core 사용 사실과 별도 model_id를 기록한다.

P의 최소 질문:
연락 빈도, 만나고 싶은 빈도, 계획성, 활동 분위기를 각각 1~5 자기 보고 + 상대 허용 범위 [l,u]로 받는다.

```text
distance(x,[l,u]) = max(l-x, 0, x-u)
item_fit = 100 * max(0, 1 - distance/4)
P_A(B) = 네 항목 평균
P = min(P_A(B), P_B(A))
```

누락 응답은 보완 요청한다. 사주에서 추정한 성격을 자기 보고 답변으로 저장하지 않는다.

M:
앞으로 14일 내 시간·이동·예산·활동 조건을 동시에 만족하는 계획 집합에서 계산한다. 시간 따로, 장소 따로 만족하는 것을 실제 가능한 약속으로 오인하지 않는다.
- 서로 다른 날짜에 60분 이상 가능한 계획: 3일 이상 100, 2일 75, 1일 50.
- 각자의 허용 이동시간 대비 부담이 모두 50% 이하 100, 75% 이하 70, 100% 이하 40.
- 조건을 만족하는 서로 다른 활동: 3개 이상 100, 2개 75, 1개 50.
- 가능한 계획이 없으면 현재 약속 제안 불가. 후보의 낮은 인성·궁합 점수로 기록하지 않는다.
- 장소/활동은 예약 가능 미확인 상태일 수 있다. M은 일정·조건 적합도이며 재고 확정 보장이 아니다.

### 9.4 전략 인터페이스

```ts
type MatchingStrategyId = 'legacy_demo_v1' | 'saju_hybrid_v0_1';
type RecommendationResult =
  | { status: 'ready'; modelId: string; ruleVersion: string;
      candidates: RankedCandidate[]; computedAt: string }
  | { status: 'not_ready'; reasonCode: string };

interface MatchingStrategy {
  id: MatchingStrategyId;
  rank(input: MatchingInput): Promise<RecommendationResult>;
}
```

RankedCandidate에는 candidateId, scoreComponents, reasons, limitations, version 정보와 필요한 경우 suggestedPlans를 저장한다. 후보 목록의 정책·모델을 먼저 하나로 선택하고 평가한다. 점수는 서버 내부 정보이고 결제 전 상대 프로필을 브라우저에 미리 전달하지 않는다.

LLM 설명은 계산 결과의 verified evidence만 사용한다. 상대의 정직함·안전성·성적 행동·질병·결혼 성공 등을 사주로 단정하지 않는다. 없는 근거를 생성하거나 점수를 수정하지 않는다.

## 10. Groble 결제와 제공 상태

### 상품

500원 = 해당 주문의 3명 열람 + 해당 상대에게 대화 요청. 수신자의 수락·거절·답장은 무료. 대화 성사 보장은 없다. 가격은 서버 상품 설정이며 클라이언트 입력으로 변경할 수 없다.

실결제 활성화 전: 판매자/상품 상태, 500원 지원, 수수료·협찬 범위, 취소/환불 처리, 테스트 방법을 확인한다. 미확인이어도 개발용 mock과 실제 웹훅 수신 코드 작성은 진행한다.

### 흐름

1. 서버가 로그인·프로필·필수 조건·전략 준비·후보 수를 확인한다.
2. 서버가 pending 주문, 무작위 seller_reference, buyer_id, 금액/상품/정책 버전을 저장한다.
3. GROBLE_PAYMENT_URL에 URL API를 이용해 ref를 추가한다. 임의 외부 URL을 받지 않는다.
4. 검증된 결제 웹훅을 기록하고 주문/거래를 잠근다.
5. 현재 유효한 후보 3명을 확정하고 match_results에 저장한다.
6. 결제 기록과 제공 상태를 일관되게 커밋한다.
7. 복귀 화면은 소유자 주문 상태를 조회한 뒤 결과를 공개한다.

결제 중 후보 소실은 현실적인 실패다. 재선정해 정확히 3명을 제공하거나 payment=paid, fulfillment=refund_required로 기록한다. 결제가 성공했는데 '미결제'로 되돌리지 않는다.

### 상태 모델

```text
payment_status:
pending → paid → refunded
pending → failed / cancelled
이벤트 역전은 거래 이력으로 조정하며 refunded에서 paid로 권한 복원 금지

fulfillment_status:
pending → processing → fulfilled
pending/processing → refund_required
fulfilled → revoked   (정책상 환불 등)
```

취소 요청 이벤트와 환불 완료를 구분한다. 환불 요청만으로 이미 돈이 돌아간 것으로 표시하지 않는다.

### 웹훅 구현 규약

2026-11-16 확인한 Groble 가이드 기준:
- 헤더: X-Groble-Signature, X-Groble-Timestamp, X-Groble-Idempotency-Key.
- 서명: HEX(HMAC-SHA256(secret, timestamp + "." + raw_body)).
- JSON 파싱 전 원본 bytes를 보존하고 constant-time 비교, timestamp 허용 범위 ±5분 적용.
- 키 회전 시 이전 시크릿/서명 처리 지침을 따른다.
- 금액·상품·통화 또는 통화 계약·결제 이벤트·주문 참조값·거래 ID를 검증한다.
- ref 값은 URL에 보이며 사용자가 바꿀 수 있다. buyer_id나 이메일 대신 추측하기 어려운 주문별 토큰 사용.
- 완료 이벤트의 data.object.sellerReference를 사용한다.
- 일반결제 취소/환불 이벤트에는 sellerReference가 없을 수 있으므로 merchantUid ↔ 내부 주문 매핑을 저장한다.
- 이벤트 도착 순서를 믿지 않는다. 환불 먼저 도착하면 미연결 이벤트를 보존하고 완료 이벤트 도착 시 조정한다.
- 상태 변경은 검증된 이벤트를 내구성 있게 저장한 뒤 수행. DB 커밋 또는 내구성 큐 저장 전에 성공 응답을 반환하지 않는다.
- 로그인 proxy가 웹훅을 /login으로 리다이렉트하지 않도록 한다.
- 운영 HTTPS 수신 주소와 외부 접근 가능한 테스트 주소를 준비한다.

금액/상품의 실제 필드 경로는 현재 이벤트 스키마에서 확인하고 fixture로 검증한다. 위 명칭 외 미확인 필드를 공식 API인 것처럼 만들어 쓰지 않는다.

### 원자성과 고유 제약

같은 완료 이벤트 동시 처리에도 한 주문의 제공은 한 번이다. DB 트랜잭션/RPC 안에서 주문 잠금, 중복 확인, 3개 삽입, 제공 상태 변경을 처리한다. 별도 REST insert/update 여러 번을 호출해 원자적이라고 주장하지 않는다.

검증된 paid 이벤트가 있으나 fulfillment가 실패하면 복구 가능한 상태로 남긴다. 이벤트별 unique만으로 동일 거래가 다른 이벤트 키로 두 번 제공되지 않게 거래·주문 제약도 둔다.

### 복귀와 권한

Groble 이동 페이지에는 주문 정보가 자동 첨부되지 않는다. 결제 전 주문 식별자를 보관하고, 복귀 시 반드시 로그인 소유권을 확인한다. 정보가 없으면 본인 주문 목록에서 확인한다. '가장 최근 주문 하나'를 무조건 성공으로 간주하지 않는다.

공개 조건: buyer_id 일치 + paid + fulfilled + 해당 match_result + 현재 대상의 공개/차단 조건. 성공 URL 직접 방문으로 권한이 생기지 않는다.

환불 후 새 열람/요청 권한은 회수하는 것을 개발 기본안으로 둔다. 이미 수락된 채팅은 결제 권한과 분리해 유지하되 차단/탈퇴 정책을 적용하는 것을 제안한다. 이 정책은 운영 전 상품 설명과 함께 팀이 최종 확정한다.

## 11. 대화 요청·채팅·사진 접근

- 구매자는 실제 공개된 match_result에만 대화 요청 가능.
- 수신자는 별도 결제 없이 요청자 프로필의 최소 공개 필드를 보고 수락/거절 가능.
- 요청 수락은 수신자만, 대기 상태에서만 처리. 재시도는 같은 방을 반환.
- A→B와 B→A가 동시에 수락돼도 정렬된 사용자 쌍 고유 제약으로 방 하나만 생성.
- 거절 시 자동으로 4번째 상대를 추가 공개하지 않는 PDF 기본안을 적용.
- 메시지는 DB에 저장 후 Supabase Realtime Postgres Changes로 수신.
- 참여자만 메시지 조회/추가. sender_id=auth.uid(), 활성 방, 차단 상태를 모두 확인.
- 초기에는 메시지 본문 수정·삭제 권한을 기본 제공하지 않는다. 필요하면 별도 정책으로 추가.
- Realtime 구독에도 실제 행 접근 제어를 검증. 채널 이름을 추측하기 어렵게 만드는 것만으로 보호하지 않는다.
- 재접속은 서버 생성 created_at + id 커서로 기록을 조회하고 id로 중복 제거. 생성 시각과 커밋 순서는 다를 수 있으므로 최근 구간을 겹쳐 조회하고 늦은 커밋도 조정한다. 임의 길이의 겹침만으로 완전성을 보장한다고 가정하지 말고, 재접속 시 페이지 단위 재동기화 또는 커밋 순서를 고려한 재개 전략을 검증한다.
- 메시지 길이·요청 빈도 제한, 본문 안전 렌더링, 대화/대기 요청 목록 구현.
- 차단 이후 새 메시지/요청은 즉시 거부. 기록 열람·구독 정책은 일관되게 정하고 테스트.
- 사진은 private bucket과 짧은 만료 URL 등 해당 열람 권한에 맞는 방식. 프로필 전체 공개 버킷으로 유료 접근 우회 금지.
- 이미 발급한 signed URL은 만료 전 접근이 남을 수 있다. 철회 즉시 차단이 필요하면 인증 프록시 등 별도 방식을 선택.

## 12. 권한과 운영의 기본 원칙

본인 사주·출생 입력·학교 이메일은 상대에게 공개하지 않는다. 공개 카드 DTO를 별도로 만든다. 요청 수신자의 판단에 필요한 프로필 공개는 '받은 대화 요청' 권한으로 제한한다.

RLS와 서버 검사 양쪽을 구현한다. 브라우저가 orders.paid, match_results, conversations 참여자, chat_requests.accepted를 직접 설정할 수 없어야 한다. 관리자용 키는 좁은 서버 모듈에만 두고 사용하는 이유를 문서화한다.

학교 이메일은 허용 도메인과 실제 이메일 확인을 함께 검사한다. '학교 이메일 인증'을 '현재 재학생 신원 완전 보증'이라고 표시하지 않는다. 개발 기본안은 성인만 가입·소개 대상으로 한다. 성인 여부 확인 방식과 학교 가입 기준은 운영 전 팀이 확정한다.

동의 항목은 사주 외부 API 전송, 프로필 소개 참여, 활동 예약 시 파트너 제공을 목적별로 정리한다. 예약에 필요한 정보는 실제 예약 동의 후 최소한만 전달한다. 사용자 행동·메시지를 임의 학습 데이터로 쓰지 않는다.

로그는 ID·상태·오류 코드 위주로 남기고 API 키·세션·출생 원본·메시지 전문을 기본 기록하지 않는다. 운영 점검과 신고 처리에 필요한 접근은 별도 권한을 부여한다.

## 13. 실험과 제품 지표

유입 → 사주 완료 → 프로필 완료 → 결제 시도 → 결제 완료 → 3명 제공 → 요청 → 수락 → 일정 확정 → 참석 → 예약 이용의 이벤트를 분리한다.

- MVP: 결제 전환율, 제공 성공률, 요청률, 수락률, 대화 시작률, 환불률.
- 확장: 일정 확정률, 참석률, 양쪽이 다시 만나고 싶은 비율, 예약 이용률.
- 품질: 차단·신고율, API 오류율, 후보 부족률, 노출 편중, 재시도/중복 발생.
- 경제성: 전체 무료 API 비용, 구매자당 변동 비용, 실제 제휴 정산 수수료, 환불·CS 비용.

분모·관찰 기간을 사전에 정하고 미열람·미응답·거절을 구분한다. 응답자 후기만으로 전체 만족도를 단정하지 않는다.

사주 가중치 효과 비교는 이후:
A = S60/P25/M15, B = S0/P62.5/M37.5.
가격·공개 수·설명량·혜택을 동일하게 둔다. 작은 후보 풀의 상호 영향 때문에 초기 결과는 탐색적이며, 독립된 모집 회차/생활권 비교를 검토한다.

## 14. 미정 사항과 진행 방식

P1 운영 정책 백로그에는 동시 진행 소개 수 상한, 거절 후 재노출 유예, 후보별 노출 편중 완화를 포함한다. 구체 임계값은 사용자 데이터 없이 확정하지 않으며, 구매한 3명을 사후 재정렬·교체하는 수단으로 사용하지 않는다.

| 미정 항목 | 개발 중 기본 처리 | 운영 전 필요한 것 |
|---|---|---|
| 저장소·기존 코드 | 현재 작업공간 조사 후 로컬 구현 | 원격 대상·반영 규칙 |
| 학교 도메인·가입 기준 | 설정화, 테스트 계정 | 팀의 허용 목록·정책 |
| Supabase 프로젝트 | 설정 인터페이스·마이그레이션 | 같은 개발 프로젝트와 키 |
| 사주 공급자 | mock + adapter | 계약·응답·옵션·가공/저장 조건 |
| 사주 규칙표 | draft + synthetic 테스트 | 승인 규칙과 버전 |
| 운영 매칭 전략 | 개발 legacy_demo, 운영 선택 필수 | 명시적 전략 결정 |
| Groble 500원·수수료 | 실결제 비활성 | 실제 상품·조건·테스트 |
| 후보 소실·환불 정책 | paid와 제공 실패 분리 | 처리 기한·보상·공개 문구 |
| 생일/계열 수정·재구매 | 제한된 기본안 | 기존 결과·중복 추천 정책 |
| 예약 파트너/API | 비활성 adapter·수동 요청 | 계약·재고/취소/정산 규약 |

모르는 값이 있어도 독립적인 코딩과 테스트는 진행한다. 실제 비밀키·외부 승인·사용자 결정이 꼭 필요한 단계만 항목을 모아 요청한다. mock 연결을 운영 연동 완료로 보고하지 않는다.

## 15. 근거 자료

### 사용자와 내부 자료

- `references/PDF_PLAN_EXTRACT.md`: 고려대학교_사주매칭_개발계획.pdf, 2026-11-16 v1.0, 9쪽.
- `references/MATCHING_ALGORITHM_ORIGINAL.md`: 기존 알고리즘 초안 v0.1 보존본.
- C 담당자 요구: 공통 Next.js, 서버 사용자 ID, 동일 Supabase, env 예시, 500원→3명→수락→채팅.
- 이전 수익화 논의: 직접 제휴 3~5곳, 예약 성사 수수료, 중복 과금 구분, 40,000원×15%는 가정.

### 공식 기술 자료

확인 기준일 2026-11-16. 실제 구현 시 다시 확인한다. 아래 자료는 기술 기능의 근거이며 자체 사주 가중치의 효과를 입증하지 않는다.

- Supabase SSR: https://supabase.com/docs/guides/auth/server-side/creating-a-client
- Supabase getUser: https://supabase.com/docs/reference/javascript/auth-getuser
- 사용자 데이터: https://supabase.com/docs/guides/auth/managing-user-data
- RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
- Realtime: https://supabase.com/docs/guides/realtime/subscribing-to-database-changes
- Realtime 권한: https://supabase.com/docs/guides/realtime/authorization
- Groble 결제창: https://www.groble.im/help/guides/payment-window
- Groble 웹훅: https://www.groble.im/help/guides/webhook
- Groble 이벤트 상세: 위 웹훅 가이드의 현재 링크를 따라 최신 스키마 확인.
- HRUM 만세력: https://hrum.ai/manseryeok-api.html
- HRUM 레퍼런스: https://hrum.ai/docs.html
- HRUM 약관: https://hrum.ai/terms.html

원문 PDF의 일부 '외부 확인 필요' 항목 중 웹훅 ref·서명 방식 등은 공개 문서로 보완했다. 계정별 활성화·500원 상품·수수료·협찬·예약 계약은 여전히 미확인이다.
