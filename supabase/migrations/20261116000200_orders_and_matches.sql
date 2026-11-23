-- =====================================================================
-- 0002 무료 추천 결과, 상대별 주문, 결제 기록
-- 작성: B (match_results), B 초안 + C 계약 (orders, payments)
--
-- 과금 흐름 (2026-11-16 기획 변경):
--   무료 추천 3명 공개 → 상대 1명 선택 → 그 상대에 대해 500원 결제
--   → 대화 요청 → 상대 수락 → 채팅
-- 추천 결과는 결제 주문에 의존하지 않는다. 주문은 "구매자 → 추천받은 상대 1명"에 연결된다.
-- C 계약(packages/payment-chat/src/ports.ts)과의 대응은 docs/DB.md 참고.
-- =====================================================================

-- ---------------------------------------------------------------------
-- match_results: 무료 추천 결과 (C 의 MatchResult { id, userId, targetId })
--   user_id   = 추천받은 사용자
--   target_id = 추천된 상대
-- 한 번 저장된 추천은 유지된다 (새로고침해도 같은 결과).
-- ---------------------------------------------------------------------
create table public.match_results (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  target_id     uuid not null references auth.users (id) on delete cascade,
  rank          smallint not null check (rank between 1 and 3),
  distance      integer not null check (distance >= 0),   -- 계산 당시 거리
  target_score  integer not null,                         -- 계산 당시 상대 점수
  created_at    timestamptz not null default now(),
  check (user_id <> target_id),
  unique (user_id, rank),
  unique (user_id, target_id),
  unique (id, user_id, target_id)                         -- orders 복합 FK 용
);

create index match_results_target_idx on public.match_results (target_id);

-- ---------------------------------------------------------------------
-- orders: 구매자 → 선택한 상대 1명에 대한 대화 권한 (C 의 Order)
-- ---------------------------------------------------------------------
create type public.order_status as enum (
  'pending',         -- 주문 생성, 결제 대기
  'fulfilled',       -- 결제 확인 완료 → 이 상대에게 대화 요청 가능
  'cancelled',       -- 결제 전 취소
  'refund_pending',  -- 결제됐지만 상대 비공개·비활성·차단 → 환불 처리 대기
  'refunded'         -- 환불 완료
);

create table public.orders (
  id               uuid primary key default gen_random_uuid(),
  buyer_id         uuid references auth.users (id) on delete set null,   -- 탈퇴 후에도 결제 기록 보존
  target_id        uuid references auth.users (id) on delete set null,
  match_result_id  uuid,
  amount           integer not null default 500 check (amount = 500),
  status           public.order_status not null default 'pending',
  -- Groble 결제 링크의 ?ref= 값 (추측하기 어려운 난수, 서버가 생성해도 됨)
  reference        text not null unique
                     default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (buyer_id is distinct from target_id),
  -- 주문은 본인이 받은 추천의 상대에게만 만들 수 있다 (추천 소유권을 DB 가 보장)
  constraint orders_match_result_fk
    foreign key (match_result_id, buyer_id, target_id)
    references public.match_results (id, user_id, target_id)
    on delete set null (match_result_id)
);

-- 같은 구매자-상대 쌍의 활성 주문(pending/fulfilled)은 하나뿐 → 미결제 주문 재사용, 재결제 방지
create unique index orders_active_pair_uniq on public.orders (buyer_id, target_id)
  where status in ('pending', 'fulfilled');

create index orders_buyer_idx on public.orders (buyer_id, created_at desc);

create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- payments: 검증된 결제 거래 (C 의 savePayment / paymentOrder)
-- 거래 ID 고유 → 같은 웹훅 여러 번 도착해도 한 번만 반영
-- ---------------------------------------------------------------------
create table public.payments (
  transaction_id  text primary key check (btrim(transaction_id) <> ''),
  order_id        uuid not null unique references public.orders (id) on delete restrict,
  amount          integer not null,
  created_at      timestamptz not null default now()
);
