# 📄 프로필 · 매칭 계약서 (B ↔ C)

> 구현 전에 **테이블 구조와 함수 입출력**을 먼저 맞추기 위한 문서입니다.
> SQL 초안: [`supabase/migrations/0002_profiles_matching.sql`](../supabase/migrations/0002_profiles_matching.sql)
> (로컬 PostgreSQL 16에서 Supabase Auth를 흉내 낸 스텁으로 적용·테스트 완료)

## 0. 공통 원칙

| 항목 | 결정 |
|---|---|
| Supabase 프로젝트 | A·B·C 공통 1개 사용 |
| 사용자 ID | **`auth.users.id` (uuid)로 통일**. `profiles.id`, `orders.buyer_id`, `blocks.*_id`, `chat_*.user_id`가 전부 이 값 |
| 내부 함수 | `private` 스키마 (API로 노출 안 됨). 클라이언트는 `public`의 RPC만 호출 |
| 탈퇴 | `profiles.status = 'deleted'`로 처리하는 soft delete |
| 에러 코드 | `MT4xx` 형식의 커스텀 SQLSTATE (아래 표) |

**마이그레이션 순서**: `0001_orders_blocks.sql` (C) → `0002_profiles_matching.sql` (B) → `0003_chat.sql` (C)

---

## 1. 테이블 소유권

| 테이블 | 담당 | 비고 |
|---|---|---|
| `profiles` | B | 공개 카드용 기본 정보 |
| `profile_saju` | B | 출생정보와 사주 계산 결과. **본인만 조회 가능** |
| `match_results` | B | 주문별 추천 3명. 함수로만 쓸 수 있음 |
| `orders` | C | 아래 **최소 컬럼**이 꼭 있어야 함 |
| `blocks` | C | 아래 **최소 컬럼**이 꼭 있어야 함 |
| `chat_requests`, `chat_rooms`, `chat_participants`, `chat_messages` | C | 이름과 최소 컬럼은 아래 6번 참고 |

### C 테이블에서 B 함수가 참조하는 최소 컬럼
```sql
orders (
  id                 uuid primary key,
  buyer_id           uuid not null references auth.users(id),
  status             text not null,   -- 'pending' | 'paid' | 'refund_required' | 'refunded' | 'failed' | 'cancelled'
  amount             int,
  groble_payment_id  text unique,
  paid_at            timestamptz
)
blocks (
  blocker_id uuid, blocked_id uuid, created_at timestamptz,
  primary key (blocker_id, blocked_id)
)
```

---

## 2. 프로필 스키마 (B)

### `profiles`: 공개 가능한 정보
| 컬럼 | 타입 | 설명 |
|---|---|---|
| `id` | uuid PK | = `auth.users.id` |
| `nickname` | text (2~20자) | |
| `gender` | `'male' \| 'female'` | 대운 계산에도 사용 |
| `avatar_url` | text | |
| `university`, `major` | text | |
| `bio` | text (≤300자) | |
| `interests` | text[] | |
| `is_public` | bool | false면 추천 후보에서 제외 |
| `status` | `'active' \| 'deleted'` | |
| `deleted_at`, `created_at`, `updated_at` | timestamptz | |

### `profile_saju`: 비공개 (본인만 조회)
| 컬럼 | 타입 | 설명 |
|---|---|---|
| `user_id` | uuid PK | |
| `birth_date`, `birth_time`(null=모름), `calendar_type`(`solar`/`lunar`), `is_leap_month`, `birth_place` | | 입력값 |
| `pillars` | jsonb | `{"year":"丙戌","month":"戊戌","day":"甲子","hour":"辛未"\|null}` |
| `day_stem`, `day_branch`, `year_branch` | text (한자 1글자) | 궁합 계산용 |
| `elements` | jsonb | `{"wood":2,"fire":1,"earth":3,"metal":1,"water":1}` |
| `yongsin` | `wood\|fire\|earth\|metal\|water` | |
| `calc_version`, `computed_at` | | 계산 로직 버전 관리용 |

### RLS
- `profiles`, `profile_saju`: **본인 행만** select/insert/update 가능. 다른 사람 프로필은 아래 RPC로만 볼 수 있음.
- `match_results`: 구매자 본인만 select 가능. 쓰기 정책은 없음(함수에서만 씀).

---

## 3. 후보 조건 (eligibility와 매칭이 같은 기준을 씀)

`private.eligible_candidates(buyer_id)` **하나로만** 판단합니다. 결제 전 확인과 결제 후 매칭이 이 함수 하나를 함께 쓰기 때문에 두 결과가 어긋나지 않습니다.

제외 대상:
1. 본인
2. `is_public = false` (비공개)
3. `status = 'deleted'` (탈퇴)
4. 사주 미입력 (`profile_saju` 없음)
5. **양방향 차단**: 내가 차단했거나 상대가 나를 차단한 경우
6. 이 구매자에게 **이전 주문에서 이미 추천된 사람** (재구매할 때 같은 사람이 또 나오는 것 방지 · ❓결정 필요)

---

## 4. 함수 계약

### ① 결제 전 확인: `get_match_eligibility()` · 클라이언트용
```ts
const { data } = await supabase.rpc('get_match_eligibility')
// data: { eligible: boolean, reason: null | 'PROFILE_INCOMPLETE' | 'NOT_ENOUGH_CANDIDATES', candidate_count: number }
```
- 입력: 없음 (`auth.uid()`를 사용하므로 다른 사람 기준으로 조회할 수 없음)
- C가 주문을 생성하는 RPC 안에서도 **`private.check_match_eligibility(auth.uid())`로 한 번 더 확인**해 주세요. 클라이언트의 확인 결과만 믿으면 안 되기 때문이에요.

### ② 결제 후 매칭: `private.create_match_for_order(p_order_id, p_buyer_id)` · DB 내부 전용
| | |
|---|---|
| 입력 | `p_order_id uuid`, `p_buyer_id uuid` |
| 출력 | `table(rank smallint, candidate_id uuid, score numeric)` 3행 |
| 멱등성 | 이미 그 주문의 결과가 있으면 **재계산하지 않고 저장된 결과를 그대로 반환** |
| 결정성 | 점수 내림차순으로 정렬하고, 동점이면 `md5(order_id‖candidate_id)` 순서. 같은 입력이면 항상 같은 결과 |
| 동시성 | `orders` 행을 `FOR UPDATE`로 잠가서 웹훅이 동시에 두 번 와도 순서대로 처리 |
| 권한 | anon/authenticated는 실행 불가. C의 security definer 함수 안에서만 호출 |

| 에러 | SQLSTATE | 의미 |
|---|---|---|
| `ORDER_NOT_FOUND` | MT404 | 주문 없음 |
| `BUYER_MISMATCH` | MT403 | 주문의 buyer_id ≠ p_buyer_id |
| `ORDER_NOT_PAID` | MT402 | 결제 전 주문 |
| `INSUFFICIENT_CANDIDATES` | MT409 | 결제 시점에 후보가 3명 미만. **이 함수가 저장한 내용은 롤백됨** |

### ③ 결제 기록 + 매칭 = 한 트랜잭션 · C 구현, 연결 예시
Groble 웹훅 서버가 `service_role`로 **RPC 한 번**만 호출합니다. Postgres 함수 하나는 그 자체로 하나의 트랜잭션입니다.

```sql
-- [C 담당] public.confirm_payment_and_match(p_order_id, p_groble_payment_id, p_amount) → jsonb
select * into v_order from orders where id = p_order_id for update;
if v_order.status = 'pending' then
  -- 금액 검증 후
  update orders set status='paid', groble_payment_id=..., paid_at=now() where id = p_order_id;
end if;
if v_order.status = 'paid' then
  begin
    select jsonb_agg(...) into v_matches from private.create_match_for_order(p_order_id, v_order.buyer_id) r;
  exception when sqlstate 'MT409' then           -- 후보 부족
    update orders set status = 'refund_required' where id = p_order_id;
    return '{"status":"refund_required"}';
  end;
  return jsonb_build_object('status','paid','matches', v_matches);
end if;
```
테스트로 확인한 동작:
- 웹훅 1회 → `paid` + 추천 3명 저장
- **웹훅 재전송 → 같은 결과를 반환하고 중복 저장 없음**
- 결제는 됐는데 그 사이 후보가 줄어든 경우 → `paid` 기록은 남고, 상태가 `refund_required`로 바뀌며 추천은 0건 → C가 환불 처리
- 일반 사용자는 이 함수를 호출할 수 없음

### ④ 추천 결과 조회: `get_match_results(p_order_id)` · 클라이언트용
```ts
const { data } = await supabase.rpc('get_match_results', { p_order_id })
```
- **본인이 결제한(`paid`) 주문만** 조회 가능. 남의 주문이나 없는 주문이면 둘 다 `ORDER_NOT_FOUND`를 돌려줘서 주문이 있는지조차 알 수 없게 함
- 그 사이 탈퇴, 비공개 전환, 차단이 생긴 후보는 `available=false`로 내려가고 프로필 필드는 가려짐

| 반환 필드 | 예시 |
|---|---|
| `rank` | 1 |
| `candidate_id` | uuid (대화 요청 보낼 때 사용) |
| `available` | true |
| `nickname`, `avatar_url`, `gender`, `university`, `major`, `bio`, `interests` | |
| `day_stem` | `己` (일간) |
| `dominant_element` | `fire` (가장 많은 오행) |
| `score` | 88.00 |
| `score_detail` | `{"day_stem":"천간합","day_branch":"육합","year_branch":"보통","elements":32}` |

### ⑤ 프로필 열람: `get_public_profile(p_user_id)` · 채팅·요청 화면용
열람 가능한 경우 (차단이 있으면 무조건 불가):
1. 본인
2. 내가 결제한 주문의 추천 결과에 상대가 있음
3. 상대가 나에게 대화 요청을 보냄 (`chat_requests.status in ('pending','accepted')`)
4. 같은 채팅방 참여자

반환 필드는 ④에서 `rank`, `score`, `available`을 뺀 것과 같습니다.

---

## 5. 🔒 공개하지 않는 정보
| 비공개 | 이유 |
|---|---|
| 생년월일, 태어난 시간, 출생지, 양/음력 | 개인 식별 가능 |
| 이메일 | `auth.users`에만 있고 어떤 RPC에서도 반환하지 않음 |
| 사주 원문 (`pillars` 8글자, `elements` 전체 수치, `yongsin`) | 생년월일을 역추적할 수 있음 |
| 띠(`year_branch`) | 나이(출생 연도)를 추정할 수 있음 |

`score_detail`의 관계 라벨(예: "일지 육합")은 상대 사주의 일부를 암시하지만, 원문을 복원할 수는 없어서 공개 범위로 판단했어요.

---

## 6. 채팅 연동 (C 초안을 기다리는 중)

B가 맞춰 둔 테이블 이름과 최소 컬럼입니다. 다르게 만들면 알려 주세요.
```sql
chat_requests     (id, requester_id, recipient_id, status 'pending'|'accepted'|'rejected'|'cancelled', ...)
chat_participants (room_id, user_id, primary key (room_id, user_id))
```
채팅 RLS 헬퍼 (B 제공):
```sql
private.is_room_member(p_room_id uuid) returns boolean   -- auth.uid() 기준, security definer라 RLS 재귀 없음
-- 예: create policy msg_select on chat_messages for select to authenticated
--       using (private.is_room_member(room_id));
```
`chat_requests`를 만들 때 **차단 관계면 요청 불가** 조건을 `private.is_blocked_between(a, b)`로 체크하면 돼요.

---

## 7. ❓ 함께 정할 것
1. 재구매할 때 **이전에 추천된 사람을 제외**할지 (현재 초안은 제외)
2. 성별이나 선호 조건으로 후보를 거를지 (연애 매칭인지 친구 매칭인지에 따라 결정)
3. 주문이 `refunded`가 되면 추천 결과 열람을 막을지 (현재 초안은 `paid`만 열람 가능)
4. 추천받은 사람에게 "누군가 나를 추천받았다"는 사실을 알릴지
5. `profile_saju` 계산값을 클라이언트가 직접 쓰게 할지, Edge Function에서만 쓰게 할지 (조작 방지 차원)
6. 궁합 배점 (현재: 오행 40 / 일지 30 / 일간 20 / 띠 10)
