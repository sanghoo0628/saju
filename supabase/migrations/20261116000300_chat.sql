-- =====================================================================
-- 0003 대화 요청, 채팅방, 메시지
-- 작성: B 초안 + C 계약 (ChatRequestResponse, ConversationResponse, ChatMessage)
-- 쓰기(요청 생성·수락·거절, 채팅방 생성, 메시지 저장)는 C 의 서버 API 가 수행한다.
-- 브라우저는 RLS 로 본인 관련 행만 조회한다 (Realtime 구독 포함).
-- =====================================================================

create type public.chat_request_status as enum ('pending', 'accepted', 'rejected');

create table public.chat_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references auth.users (id) on delete cascade,   -- C: from
  recipient_id  uuid not null references auth.users (id) on delete cascade,   -- C: to
  order_id      uuid not null references public.orders (id) on delete restrict,
  status        public.chat_request_status not null default 'pending',
  created_at    timestamptz not null default now(),
  responded_at  timestamptz,
  check (requester_id <> recipient_id),
  -- 같은 상대에게 반복·중복 요청 금지 (거절 후 재요청도 생성하지 않음)
  unique (requester_id, recipient_id)
);

create index chat_requests_recipient_idx on public.chat_requests (recipient_id, created_at desc, id desc);
create index chat_requests_requester_idx on public.chat_requests (requester_id, created_at desc, id desc);

-- 두 참여자를 (작은 id, 큰 id) 로 정렬해 저장 → 순서와 무관하게 같은 두 사람의 방은 하나뿐.
-- C 의 members: [string, string] 는 어댑터에서 [user_a, user_b] 로 매핑한다.
create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_a      uuid not null references auth.users (id) on delete cascade,
  user_b      uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  check (user_a < user_b),
  unique (user_a, user_b)
);

create index conversations_user_a_idx on public.conversations (user_a, created_at desc, id desc);
create index conversations_user_b_idx on public.conversations (user_b, created_at desc, id desc);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),   -- C 가 생성한 id 를 그대로 저장 가능
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  sender_id        uuid not null references auth.users (id) on delete cascade,
  body             text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at       timestamptz not null default now()
);

-- 재접속 시 "afterId 이후" 조회와 정렬: (created_at, id)
create index messages_conversation_idx on public.messages (conversation_id, created_at, id);
