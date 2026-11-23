-- =====================================================================
-- 0400 접근 권한 (RLS + 테이블/컬럼 권한)
-- 작성: B (김상후)
--
-- 원칙
--  - 프로필 저장과 프로필 공개 권한은 별개. 전체 프로필 조회를 허용하지 않는다.
--  - 프로필 열람에는 결제를 요구하지 않는다. 무료 추천으로 받은 상대는 볼 수 있다.
--  - 생년월일·사주·점수·주문은 본인만 조회. 기록은 서버(service_role)만.
--  - 대화 요청·채팅방·메시지는 당사자만, 그리고 양방향 차단이면 조회 불가.
--  - 채팅 쓰기는 C 의 서버 API 만 (브라우저 직접 쓰기 없음).
--  - 판단 함수는 private 스키마에 둔다 → 브라우저가 RPC 로 남의 차단 관계 등을 조회할 수 없다.
--  - service_role 은 RLS 를 우회하므로 서버에만 둔다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 판단 함수 (security definer: RLS 안에서 다른 테이블을 RLS 없이 확인)
-- C 의 Transaction.blocked / profileAvailable 도 이 함수를 쓴다.
-- ---------------------------------------------------------------------

-- 어느 방향이든 차단이 있는가
create or replace function private.is_blocked_between(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.blocks
    where (blocker_id = a and blocked_id = b)
       or (blocker_id = b and blocked_id = a)
  );
$$;

-- 매칭 후보·대화 상대가 될 수 있는 상태인가 (공개 동의 + 활성)
create or replace function private.profile_available(target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = target and p.is_public and p.status = 'active'
  );
$$;

-- viewer 가 target 의 프로필 카드(와 사진)를 볼 수 있는가
create or replace function private.can_view_profile(viewer uuid, target uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    viewer is not null and target is not null and (
      viewer = target
      or (
        not private.is_blocked_between(viewer, target)
        and exists (select 1 from public.profiles t where t.id = target and t.status = 'active')
        and (
          -- 1) 무료 추천으로 받은 상대 (상대가 공개 동의를 철회하면 숨김)
          (
            private.profile_available(target)
            and exists (
              select 1 from public.match_results m
              where m.user_id = viewer and m.target_id = target
            )
          )
          -- 2) 나에게 대화를 요청한 사람 (수락 여부 판단에 필요)
          or exists (
            select 1 from public.chat_requests r
            where r.recipient_id = viewer and r.requester_id = target
              and r.status in ('pending', 'accepted')
          )
          -- 3) 채팅 상대
          or exists (
            select 1 from public.conversations c
            where (c.user_a = viewer and c.user_b = target)
               or (c.user_b = viewer and c.user_a = target)
          )
        )
      )
    );
$$;

-- uid 가 conv 의 참여자이고 두 사람이 서로 차단하지 않았는가 (조회·Realtime 구독 공통)
create or replace function private.can_access_conversation(conv uuid, uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = conv
      and uid is not null
      and (c.user_a = uid or c.user_b = uid)
      and not private.is_blocked_between(c.user_a, c.user_b)
  );
$$;

grant execute on function private.is_blocked_between(uuid, uuid) to authenticated, service_role;
grant execute on function private.profile_available(uuid) to authenticated, service_role;
grant execute on function private.can_view_profile(uuid, uuid) to authenticated, service_role;
grant execute on function private.can_access_conversation(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- RLS 활성화
-- ---------------------------------------------------------------------
alter table public.profiles           enable row level security;
alter table public.private_birth_data enable row level security;
alter table public.fortune_results    enable row level security;
alter table public.blocks             enable row level security;
alter table public.reports            enable row level security;
alter table public.match_results      enable row level security;
alter table public.orders             enable row level security;
alter table public.payments           enable row level security;
alter table public.chat_requests      enable row level security;
alter table public.conversations      enable row level security;
alter table public.messages           enable row level security;

-- ---------------------------------------------------------------------
-- 테이블·컬럼 권한: 모두 회수 후 필요한 것만 허용
-- (Supabase 는 public 스키마 테이블에 anon/authenticated 전체 권한을 기본 부여함)
-- ---------------------------------------------------------------------
revoke all on public.profiles, public.private_birth_data, public.fortune_results,
              public.blocks, public.reports, public.match_results, public.orders,
              public.payments, public.chat_requests, public.conversations, public.messages
  from anon, authenticated;

grant all on public.profiles, public.private_birth_data, public.fortune_results,
             public.blocks, public.reports, public.match_results, public.orders,
             public.payments, public.chat_requests, public.conversations, public.messages
  to service_role;

-- profiles: 생성은 서버(PUT /api/profile)만 — 계열을 저장된 점수 부호에서 정하기 위해.
-- 계열(track)·탈퇴 상태는 사용자가 직접 바꾸지 못한다.
grant select on public.profiles to authenticated;
grant update (nickname, gender, university, major, bio, interests, photo_path, is_public)
  on public.profiles to authenticated;

-- 조회만 (payments 는 브라우저에 노출하지 않음)
grant select on public.private_birth_data, public.fortune_results,
                public.orders, public.chat_requests, public.conversations, public.messages
  to authenticated;

-- 추천 관계는 본인이 조회하되, 상대 점수 및 점수를 역산할 수 있는 거리는 서버만 조회한다.
grant select (id, user_id, target_id, rank, created_at) on public.match_results to authenticated;

grant select, delete on public.blocks to authenticated;
grant insert (blocker_id, blocked_id) on public.blocks to authenticated;

grant select on public.reports to authenticated;
grant insert (reporter_id, target_id, reason) on public.reports to authenticated;

-- ---------------------------------------------------------------------
-- 정책
-- ---------------------------------------------------------------------

-- profiles
create policy profiles_select on public.profiles
  for select to authenticated
  using (private.can_view_profile((select auth.uid()), id));

create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- 본인 것만 조회
create policy private_birth_data_select_own on public.private_birth_data
  for select to authenticated using (user_id = (select auth.uid()));

create policy fortune_results_select_own on public.fortune_results
  for select to authenticated using (user_id = (select auth.uid()));

create policy match_results_select_own on public.match_results
  for select to authenticated using (user_id = (select auth.uid()));

create policy orders_select_own on public.orders
  for select to authenticated using (buyer_id = (select auth.uid()));

-- chat_requests: 보낸 사람·받은 사람, 차단 시 숨김
create policy chat_requests_select_party on public.chat_requests
  for select to authenticated
  using (
    (select auth.uid()) in (requester_id, recipient_id)
    and not private.is_blocked_between(requester_id, recipient_id)
  );

-- conversations / messages: 참여자, 차단 시 숨김 (Realtime 구독에도 적용)
create policy conversations_select_participant on public.conversations
  for select to authenticated
  using (private.can_access_conversation(id, (select auth.uid())));

create policy messages_select_participant on public.messages
  for select to authenticated
  using (private.can_access_conversation(conversation_id, (select auth.uid())));

-- blocks: 내가 한 차단만 조회·추가·해제
create policy blocks_select_own on public.blocks
  for select to authenticated using (blocker_id = (select auth.uid()));
create policy blocks_insert_own on public.blocks
  for insert to authenticated with check (blocker_id = (select auth.uid()));
create policy blocks_delete_own on public.blocks
  for delete to authenticated using (blocker_id = (select auth.uid()));

-- reports: 내가 한 신고만 추가·조회
create policy reports_insert_own on public.reports
  for insert to authenticated with check (reporter_id = (select auth.uid()));
create policy reports_select_own on public.reports
  for select to authenticated using (reporter_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Realtime: messages 변경을 Postgres Changes 로 전달 (구독에도 위 RLS 적용)
-- ---------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;
