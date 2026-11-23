# 📄 프로필 · 매칭 계약서 (B ↔ C, A 저장 계약 포함) — v3

> 2026-11-16 기획 변경과 C 리뷰를 반영한 버전이다. v1(주문별 추천, 오행 배점, `create_match_for_order`)은 폐기했다.
> SQL: [`supabase/migrations/`](../supabase/migrations) · 검증: `npm test`
> (PGlite(WASM Postgres)에 Supabase auth/storage 스텁을 만들고 모든 마이그레이션을 적용한 뒤 RLS와 제약을 테스트한다)
> 2026-11-23 v3: A 사주 입력 저장 계약(9장)과 후속 마이그레이션 `20261123000100` 추가. 기존 6개는 수정하지 않았다.
> 기존 6개는 개발 DB(saju-dev)에 적용됐고 C 가 실제 연동을 검증했다. `20261123000100` 은 팀 확인 후 적용한다.

## 0. 과금 흐름과 v1 대비 변경

```
무료 추천 3명 공개 → 상대 1명 선택(matchResultId) → 그 상대에 대해 500원 결제
→ 대화 요청 → 상대 수락(무료) → 채팅
```

| 항목 | v1 (폐기) | v2 |
|---|---|---|
| 추천 3명 | 500원 결제 후 주문별 생성 | **무료**, 결제와 무관하게 저장·조회 |
| 결제 단위 | 주문당 추천 3명 | **구매자 → 선택한 상대 1명**, 상대당 500원 |
| 결제 전 확인 | 후보 3명 이상 | 선택한 상대의 공개·활성 상태 + 양방향 차단 |
| 매칭 점수 | 오행 40 / 일지 30 / 일간 20 / 띠 10 | **원래 기획**: 생년월일 HMAC → 1~10,000, 문과 + / 이과 −, `abs(내 점수 + 상대 점수)` 작은 순 상위 3명 |
| 사주 풀이 | `profile_saju` 에서 궁합 계산에 사용 | 매칭과 별개. A 의 사주 프로그램 응답을 `fortune_results.fortune` 에 저장 |
| 주문 상태 | paid / refund_required / … | **pending / fulfilled / cancelled / refund_pending / refunded** (C 와 통일) |
| 제거된 함수 | `get_match_eligibility`, `create_match_for_order`, `get_match_results(order_id)`, `saju_compat` 등 | `get_or_create_match_results` (서버 전용) |

v1 에서 유지한 것: `profiles.id = auth.users.id`, 공개/비공개 테이블 분리, `status` 기반 soft delete, 프로필 필드(닉네임·성별·학교·전공·소개·관심사), 내부 함수는 `private` 스키마(API 로 노출되지 않음).

## 1. 사용자 ID

모든 사용자 ID 는 `auth.users.id`(uuid) 다. `profiles.id`, `match_results.user_id/target_id`, `orders.buyer_id/target_id`, `blocks.*_id`, `chat_requests.requester_id/recipient_id`, `conversations.user_a/user_b`, `messages.sender_id` 가 모두 이 값이다.

## 2. 테이블

| 테이블 | 담당 | 키·주요 컬럼 | 브라우저(authenticated) 권한 |
|---|---|---|---|
| profiles | B | `id`, nickname(2~20), gender, university, major, bio, interests, photo_path, track, is_public, status(active/deleted) | 조회: `can_view_profile`. 수정: 본인 nickname·gender·university·major·bio·interests·photo_path·is_public 만 |
| private_birth_data | B·A | `user_id`, calendar_type, birth_date(양력만), lunar_date(음력 원문), is_leap_month, timezone, consent_version, consented_at. birth_time 은 저장하지 않음 | 본인 조회 |
| fortune_results | B | `user_id`, base_number, score, score_version, score_input(solar/lunar/lunar_leap), fortune·program_version(선택) | 본인 조회 |
| fortune_analyses | B·A | `user_id`, A 의 matching_fortune_v1 (3주 원국·분석·비교 키·버전) | 없음 (서버 전용) |
| match_results | B | `id`, user_id(추천받은 사람), target_id, rank, distance, target_score | 본인 조회 |
| orders | C | `id`, buyer_id, target_id, match_result_id, amount(=500), status, reference | 본인 조회 |
| payments | C | `transaction_id`, order_id(unique), amount | 없음 |
| chat_requests | C | `id`, requester_id, recipient_id, order_id, status(pending/accepted/rejected), created_at | 당사자 조회, 차단 시 숨김 |
| conversations | C | `id`, user_a < user_b, created_at | 참여자 조회, 차단 시 숨김 |
| messages | C | `id`(uuid), conversation_id, sender_id, body(1~2000), created_at | 참여자 조회, 차단 시 숨김 |
| blocks | C·B | (blocker_id, blocked_id) | 본인 차단 조회·추가·해제 |
| reports | C·B | `id`, reporter_id, target_id, reason, status | 본인 신고 추가·조회 |

- 프로필 생성과 점수·추천·주문·결제·채팅 쓰기는 **서버(service_role)만** 한다. 브라우저에는 채팅 쓰기 권한이 없다.
- 프로필의 계열(track)은 저장된 점수 부호로 서버가 정한다. 점수와 계열이 어긋날 수 없다.
- Realtime(Postgres Changes)은 `messages` 를 publish 하고, 구독에도 위 조회 RLS 가 적용된다.
- `match_results`의 브라우저 조회는 `id, user_id, target_id, rank, created_at` 컬럼만 허용한다. 상대 점수와 이를 역산할 수 있는 거리는 서버만 조회한다.

| 마이그레이션 | 내용 |
|---|---|
| `20261116000100_profiles_and_private_data.sql` | private 스키마, profiles, private_birth_data, fortune_results, blocks, reports |
| `20261116000200_orders_and_matches.sql` | match_results, orders, payments |
| `20261116000300_chat.sql` | chat_requests, conversations, messages |
| `20261116000400_access_rls.sql` | 판단 함수, RLS, 테이블·컬럼 권한, Realtime |
| `20261116000500_matching_functions.sql` | 후보 선정, 무료 추천 저장·조회 |
| `20261116000600_storage_profile_photos.sql` | 비공개 사진 버킷과 정책 |
| `20261123000100_birth_input_and_analysis.sql` | (후속) 음력 원문·시간대·동의 기록, 점수만 저장 허용, fortune_analyses, 사진 5MB·이미지 3종 제한 |

## 3. 무료 추천 (B)

### 후보 조건 — `private.match_candidates(user)`
- 요청자: 활성 + 공개 동의 + 점수 있음. 아니면 0명이다. 내가 공개해야 남을 볼 수 있다. 대화 요청을 받은 상대가 내 프로필을 봐야 하기 때문이다.
- 제외: 본인, 비공개, 탈퇴, 점수 없음, **양방향 차단**, 이미 추천된 상대.
- 정렬: `abs(내 점수 + 상대 점수)` 오름차순, 동점이면 `id` 오름차순. `src/lib/matching.ts` 와 같은 규칙이며 테스트가 두 구현의 결과를 비교한다.

### 저장·조회 — `public.get_or_create_match_results(p_user)` (service_role 전용)
- 저장된 추천이 3개 미만이면 부족한 만큼만 채운다. 이미 저장된 추천은 바꾸지 않으므로 새로고침해도 같은 결과, 같은 `id` 가 나온다.
- 저장된 상대가 나중에 비공개·탈퇴·차단되면 결과에서 숨기기만 하고 다른 사람으로 다시 채우지 않는다.
- 같은 사용자의 동시 호출은 profiles 행 잠금으로 직렬화한다.
- 반환: `id, target_id, rank, distance, created_at`

### B 의 HTTP API ([`src/contracts/matching.ts`](../src/contracts/matching.ts))

| 경로 | 설명 |
|---|---|
| `GET /api/match-results` | `{ status: 'ready'｜'fortune_required'｜'profile_required'｜'no_candidates', results: [{ id, rank, profile }] }` — **`id` 가 C 의 `matchResultId`**. 결과는 1~3명이며 실제 인원만 내려간다. `fortune_required` = 생년월일 미저장 → `/fortune`, `profile_required` = 프로필 미등록·비공개 → `/profile` |
| `GET /api/profile` | `{ profile: 내 프로필｜null, birthInputSaved, lockedTrack: 'humanities'｜'science'｜null }` (v3에서 변경) |
| `PUT /api/profile` | 프로필 생성·수정. 점수가 없으면 `track` 필수 → 서버가 저장된 생년월일 + 계열로 고정 점수 생성. 이후 계열 변경은 `TRACK_LOCKED`(409). 생년월일 미저장 `FORTUNE_REQUIRED`(409), 계열 누락 `TRACK_REQUIRED`(400), 비밀 키 미설정 `NOT_CONFIGURED`(503) |

프로필 카드 필드: `userId, nickname, gender, university, major, bio, interests, track, photoUrl`(만료 서명 URL).

## 4. 상대별 주문 (C) — DB 가 보장하는 것

| 규칙 | 제약 |
|---|---|
| 주문은 본인이 추천받은 상대에게만 | `orders(match_result_id, buyer_id, target_id)` → `match_results(id, user_id, target_id)` 복합 FK. 남의 추천 ID 나 다른 상대로는 insert 가 실패한다 |
| 같은 구매자-상대의 활성 주문은 하나 | `orders_active_pair_uniq` (buyer_id, target_id) where status in (pending, fulfilled) |
| 금액 500원 | `orders.amount = 500` |
| 참조값·거래 ID 고유, 주문당 결제 하나 | `orders.reference` unique, `payments` PK(transaction_id), `payments.order_id` unique |
| 같은 상대에게 중복 요청 금지 | `chat_requests (requester_id, recipient_id)` unique |
| 두 사람의 채팅방은 하나 | `conversations` user_a < user_b + unique(user_a, user_b) |

결제 확정에는 추천 생성이 없다. C 의 웹훅은 결제 기록 후 `private.profile_available(target)` 과 `private.is_blocked_between(buyer, target)` 을 확인한다. 통과하면 `fulfilled`, 아니면 `refund_pending` 이다.

## 5. C 의 `ports.ts` ↔ DB

| C | DB |
|---|---|
| `Actor.userId` / `Order.userId` | `orders.buyer_id` |
| `Order.reference / targetId / matchResultId / amountKrw / status` | `orders.reference / target_id / match_result_id / amount / status` |
| `MatchResult { id, userId, targetId }` | `match_results.id / user_id / target_id` |
| `result(id)` | `select id, user_id, target_id from match_results where id = $1` |
| `profileAvailable(userId)` | `select private.profile_available($1)` (공개 동의 + 활성) |
| `blocked(a, b)` | `select private.is_blocked_between($1, $2)` (양방향) |
| `activeOrderForPair(u, t)` | `orders where buyer_id=$1 and target_id=$2 and status in ('pending','fulfilled')` |
| `orderByReference(ref)` | `orders where reference = $1 for update` |
| `paymentOrder(tx)` / `savePayment(tx, orderId)` | `payments` select / insert |
| `ChatRequest { from, to }` | `chat_requests.requester_id / recipient_id` |
| `requestForPair(from, to)` | `chat_requests where requester_id=$1 and recipient_id=$2` |
| `Conversation.members` | `[user_a, user_b]` (저장 시 정렬) |
| `conversationForPair(a, b)` | `conversations where user_a = least($1,$2) and user_b = greatest($1,$2)` |
| `ChatMessage { id, senderId, createdAt }` | `messages.id(uuid) / sender_id / created_at` |
| `messages(conv, afterId)` | `order by created_at, id` 최대 100개. afterId 는 같은 conversation 소속인지 확인 |
| `requestsForUser / conversationsForUser` | 본인 관계, `not private.is_blocked_between(...)`, `order by created_at desc, id desc` |

### 트랜잭션 구현 제안
C 의 `Repository.transaction()` 을 Supabase REST 호출로 이어 붙이면 원자성이 없다.
- **1안 (권장)**: C 의 Repository 를 Postgres 직접 연결(`DATABASE_URL`, Supabase 풀러)로 구현한다. `begin … commit` 안에서 위 SQL 을 실행한다. 비즈니스 규칙은 C 의 `service.ts` 한 곳에만 둔다. 직접 연결은 `private` 스키마 함수를 호출할 수 있다.
- 2안: B 가 각 쓰기 작업을 RPC(DB 함수)로 제공한다. 이 경우 규칙이 TS 와 SQL 두 곳에 생긴다.

어느 쪽이든 동시 요청은 4장의 고유 제약이 최종적으로 막는다.

## 6. 프로필 열람 권한 — `private.can_view_profile(viewer, target)`

차단이 있으면 무조건 불가. 상대가 탈퇴했으면 불가. 그 외에는 다음 중 하나면 가능하다.
1. 본인
2. 무료 추천으로 받은 상대 (상대가 공개 동의 중일 때). **결제가 필요 없다.**
3. 나에게 대화를 요청한 사람 (pending/accepted)
4. 채팅 상대

`profiles` 의 select RLS 와 `profile-photos` 버킷 조회 정책이 이 함수를 쓴다. 사진은 서버가 만든 만료 서명 URL 로만 내려간다.

## 7. 🔒 공개하지 않는 정보
| 비공개 | 위치 |
|---|---|
| 생년월일, 양/음력, 윤달, 시간대 | `private_birth_data` (본인만). 태어난 시간은 저장하지 않는다 |
| 3주 원국·용신·강약 분석 | `fortune_analyses` (서버만) |
| 매칭 점수, 기본 숫자, 사주 풀이 원문 | `fortune_results` (본인만). 프로필 카드·추천 응답에 포함하지 않는다 |
| 이메일 | `auth.users` 에만 있다 |
| 결제 거래 | `payments` (브라우저 접근 없음) |

## 8. ❓ 함께 정할 것
1. **추천 재생성**: 지금은 한 번 저장한 추천을 유지한다. 주기적 갱신이나 추가 추천을 둘지 정해야 한다.
2. **성별·희망 조건 필터**: `profiles.gender` 는 저장만 하고 매칭에는 쓰지 않는다. 연애 매칭이면 필터를 추가해야 한다.
3. **거절 후 정책**: 자동 환불 여부. 거절된 상대에게는 재요청을 막는다(unique).
4. **환불 후 채팅방**: 처리 방침을 정해야 한다.
5. **차단 후 기록**: 지금은 차단하면 양쪽 모두 요청·방·기록이 보이지 않고, 해제하면 다시 보인다. C 서비스 동작과 같다.
6. **생년월일·계열 수정**: v3 기본값은 "첫 프로필 저장 때 점수 고정, 이후 계열 변경 불가, 생년월일을 다시 저장해도 점수 유지". 정정 요청 처리(관리자 재생성 등)는 정해야 한다.
7. **음력 점수 키**: 음력은 양력으로 바꾸지 않고 `lunar:YYYY-MM-DD`(윤달은 `lunar-leap:`)로 해시한다. 같은 사람이 양력·음력으로 각각 입력하면 점수가 다를 수 있다. 오락용 고정 숫자라 허용했지만, 양력 변환으로 통일하려면 변환 라이브러리 도입을 A 와 정해야 한다.

## 9. A 사주 입력 → B 저장 계약 (2026-11-23, A 확인 필요)

### 시점과 입력
| 단계 | 누가 | 무엇을 |
|---|---|---|
| 1. 사주 결과 확인 | A `POST /api/fortune` 성공 후 | 사용자가 **매칭용 저장 동의**를 했으면 `getMatchingService().recordBirthInput(user.id, input)` 호출. `input` 은 A 의 `fortuneInputSchema` 로 검증된 값에서 `birthDate, calendar, isLeapMonth, timezone` 만 |
| 2. (선택) 3주 분석 | A `POST /api/fortune/matching-basis` 가 `ready` 일 때 | `recordMatchingAnalysis(user.id, matchingInput)` → `fortune_analyses`. 추천 자격·점수와 무관 |
| 3. 프로필 첫 저장 | B `PUT /api/profile` `{..., track}` | 저장된 생년월일 + 계열 + `SCORE_HMAC_SECRET` → `fortune_results` (없을 때만 insert, 동시 요청에도 먼저 저장된 값 유지) |
| 4. 무료 추천 | B `GET /api/match-results` | 기존 그대로 |

- 점수는 HRUM 결과와 관계없다. HRUM 강약 점수·mock 결과를 점수로 쓰지 않는다. HRUM 이 실패해도 생년월일 저장과 점수 생성은 가능하다.
- 계열(문과·이과)은 A 폼이 아니라 B 프로필 화면에서 받는다. `providerSex` 를 성별·계열로 복사하지 않는다.
- 출생 시간·성별 옵션·계산 옵션은 저장하지 않는다 (점수에 필요 없음).
- 동의 버전: `matching_birth_storage_v1` (`BIRTH_STORAGE_CONSENT_VERSION`). A 화면의 "DB에 저장하지 않아요" 문구를 매칭용 저장 동의로 바꿔야 한다. 동의하지 않으면 1단계를 호출하지 않고, 사용자는 추천을 받을 수 없다(`fortune_required`).

### 음력·윤달·출생 시간
| 입력 | 저장 | 점수 키 |
|---|---|---|
| 양력 | `birth_date`(date) | `YYYY-MM-DD` (v1 과 동일) |
| 음력 | `lunar_date`(원문 text, 1~12월·1~30일) | `lunar:YYYY-MM-DD` |
| 음력 윤달 | `lunar_date` + `is_leap_month = true` | `lunar-leap:YYYY-MM-DD` |
| 출생 시간 | 저장 안 함 | 사용 안 함 |

음력 날짜는 양력 date 로 넣지 않는다 (음력 2월 30일 등). 실제 윤달 존재 여부·양력 변환 검증은 B 가 하지 않는다 (A 문서와 같은 원칙).

### A 쪽 연결 예시 (A 담당 파일, 우민님 확인 후 반영)
```ts
// src/app/api/fortune/route.ts — 결과가 ready 이고 저장 동의가 있을 때만
const input = fortuneInputSchema.parse(body);           // 이미 하는 검증
const result = await calculateFortune(input, getFortuneServiceOptions(user.id));
if (result.status === 'ready' && body.matchingStorageConsent === 'matching_birth_storage_v1') {
  await getMatchingService().recordBirthInput(user.id, input);
}
```
`matchingStorageConsent` 필드 이름과 strict 스키마 반영 방법은 A 가 정한다.
