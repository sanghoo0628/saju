-- =====================================================================
-- 0002_profiles_matching.sql
-- 담당: B (프로필 · 매칭 계산/저장 · 주문별 프로필 열람 권한 · 채팅 RLS 헬퍼)
-- 의존: C의 0001 마이그레이션 (public.orders, public.blocks) 이 먼저 적용돼야 함
--       채팅 관련 헬퍼는 C의 public.chat_requests, public.chat_participants 를 참조
--       (plpgsql 이라 생성 시점엔 없어도 되고, 호출 시점에만 필요)
-- 계약 문서: docs/CONTRACT_profile_matching.md
-- =====================================================================

-- 내부 함수용 스키마 (PostgREST API 로 노출되지 않음)
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public;


-- ---------------------------------------------------------------------
-- 1. profiles : 공개 카드용 기본 정보 (id = auth.users.id)
-- ---------------------------------------------------------------------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text not null check (char_length(nickname) between 2 and 20),
  gender      text not null check (gender in ('male', 'female')),
  avatar_url  text,
  university  text,
  major       text,
  bio         text check (char_length(bio) <= 300),
  interests   text[] not null default '{}',
  is_public   boolean not null default true,      -- false 면 추천 후보에서 제외
  status      text not null default 'active'
              check (status in ('active', 'deleted')),  -- 탈퇴는 soft delete
  deleted_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 2. profile_saju : 비공개 출생정보 + 만세력 계산 결과 (본인만 조회)
-- ---------------------------------------------------------------------
create table public.profile_saju (
  user_id        uuid primary key references public.profiles(id) on delete cascade,
  -- 입력값 (절대 타인에게 노출 X)
  birth_date     date not null,
  birth_time     time,                            -- null = 태어난 시간 모름
  calendar_type  text not null check (calendar_type in ('solar', 'lunar')),
  is_leap_month  boolean not null default false,
  birth_place    text,
  -- 계산 결과
  pillars        jsonb not null,                  -- {"year":"丙戌","month":"戊戌","day":"甲子","hour":"辛未"|null}
  day_stem       text not null check (day_stem in ('甲','乙','丙','丁','戊','己','庚','辛','壬','癸')),
  day_branch     text not null check (day_branch in ('子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥')),
  year_branch    text not null check (year_branch in ('子','丑','寅','卯','辰','巳','午','未','申','酉','戌','亥')),
  elements       jsonb not null
                 check (elements ?& array['wood','fire','earth','metal','water']),  -- {"wood":2,"fire":1,...}
  yongsin        text check (yongsin in ('wood','fire','earth','metal','water')),
  calc_version   int not null default 1,
  computed_at    timestamptz not null default now()
);


-- ---------------------------------------------------------------------
-- 3. match_results : 주문별 추천 3명 (함수로만 저장, 클라이언트 쓰기 불가)
-- ---------------------------------------------------------------------
create table public.match_results (
  order_id      uuid not null references public.orders(id) on delete cascade,
  buyer_id      uuid not null references public.profiles(id) on delete cascade,
  rank          smallint not null check (rank between 1 and 3),
  candidate_id  uuid not null references public.profiles(id) on delete cascade,
  score         numeric(5,2) not null,
  score_detail  jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  primary key (order_id, rank),
  unique (order_id, candidate_id),
  check (candidate_id <> buyer_id)
);
create index match_results_buyer_idx     on public.match_results (buyer_id);
create index match_results_candidate_idx on public.match_results (candidate_id);


-- ---------------------------------------------------------------------
-- 4. updated_at 자동 갱신
-- ---------------------------------------------------------------------
create or replace function private.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function private.touch_updated_at();


-- ---------------------------------------------------------------------
-- 5. RLS
--    - profiles / profile_saju : 본인 행만 직접 접근. 타인 프로필은 함수로만 조회.
--    - match_results : 구매자 본인만 select. insert/update/delete 정책 없음(함수 전용).
-- ---------------------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.profile_saju  enable row level security;
alter table public.match_results enable row level security;

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = (select auth.uid()));
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy profile_saju_select_own on public.profile_saju
  for select to authenticated using (user_id = (select auth.uid()));
create policy profile_saju_insert_own on public.profile_saju
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy profile_saju_update_own on public.profile_saju
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy match_results_select_buyer on public.match_results
  for select to authenticated using (buyer_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 6. 내부 헬퍼
-- ---------------------------------------------------------------------

-- 두 사람 사이에 어느 방향이든 차단이 있는지
create or replace function private.is_blocked_between(p_a uuid, p_b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b)
       or (b.blocker_id = p_b and b.blocked_id = p_a)
  );
$$;

-- 오행 분포에서 가장 많은 오행 (동률이면 이름순)
create or replace function private.dominant_element(p_elements jsonb)
returns text language sql immutable as $$
  select t.k from jsonb_each_text(p_elements) as t(k, v)
  order by t.v::int desc, t.k
  limit 1;
$$;

-- 두 지지의 관계: '육합' | '삼합' | '충' | '원진' | '보통'
create or replace function private.branch_relation(x text, y text)
returns text language plpgsql immutable as $$
declare
  br constant text := '子丑寅卯辰巳午未申酉戌亥';
  i int := strpos(br, x) - 1;
  j int := strpos(br, y) - 1;
  lo int; hi int;
begin
  if i < 0 or j < 0 or i = j then return '보통'; end if;
  if (i + j) % 12 = 1 then return '육합'; end if;        -- 子丑 寅亥 卯戌 辰酉 巳申 午未
  if abs(i - j) = 6 then return '충'; end if;             -- 子午 丑未 寅申 卯酉 辰戌 巳亥
  if i % 4 = j % 4 then return '삼합'; end if;           -- 申子辰 亥卯未 寅午戌 巳酉丑 (반합 포함)
  lo := least(i, j); hi := greatest(i, j);
  if (lo % 2 = 0 and hi = lo + 7) or (lo % 2 = 1 and hi = lo + 5) then
    return '원진';                                         -- 子未 丑午 寅酉 卯申 辰亥 巳戌
  end if;
  return '보통';
end $$;

-- 궁합 점수 (0~100). 반환: {"score": 87, "detail": {...}}  / 사주 정보 없으면 null
-- 배점(초안): 오행 보완 40 + 일지 30 + 일간 20 + 띠 10
create or replace function private.saju_compat(p_a uuid, p_b uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  a public.profile_saju;
  b public.profile_saju;
  stems constant text := '甲乙丙丁戊己庚辛壬癸';
  s_stem int; s_day int; s_year int; s_elem int := 0; s_comp int := 0;
  l_stem text; l_day text; l_year text;
  e text; ca int; cb int;
begin
  select * into a from public.profile_saju where user_id = p_a;
  select * into b from public.profile_saju where user_id = p_b;
  if a.user_id is null or b.user_id is null then return null; end if;

  -- 일간 (20): 천간합(甲己 乙庚 丙辛 丁壬 戊癸)
  if abs(strpos(stems, a.day_stem) - strpos(stems, b.day_stem)) = 5 then
    s_stem := 20; l_stem := '천간합';
  else
    s_stem := 10; l_stem := '보통';
  end if;

  -- 일지 (30)
  l_day := private.branch_relation(a.day_branch, b.day_branch);
  s_day := case l_day when '육합' then 30 when '삼합' then 24 when '보통' then 15
                      when '원진' then 6 else 0 end;

  -- 띠 (10)
  l_year := private.branch_relation(a.year_branch, b.year_branch);
  s_year := case when l_year in ('육합', '삼합') then 10 when l_year = '보통' then 6 else 2 end;

  -- 오행 (40): 서로의 용신을 채워주면 각 12점 + 결핍 보완 원소당 4점(최대 16)
  if a.yongsin is not null and coalesce((b.elements ->> a.yongsin)::int, 0) >= 2 then s_elem := s_elem + 12; end if;
  if b.yongsin is not null and coalesce((a.elements ->> b.yongsin)::int, 0) >= 2 then s_elem := s_elem + 12; end if;
  foreach e in array array['wood','fire','earth','metal','water'] loop
    ca := coalesce((a.elements ->> e)::int, 0);
    cb := coalesce((b.elements ->> e)::int, 0);
    if (ca = 0 and cb >= 2) or (cb = 0 and ca >= 2) then s_comp := s_comp + 4; end if;
  end loop;
  s_elem := s_elem + least(s_comp, 16);

  return jsonb_build_object(
    'score',  s_stem + s_day + s_year + s_elem,
    'detail', jsonb_build_object(
      'day_stem',    l_stem,   -- 일간 관계
      'day_branch',  l_day,    -- 일지(배우자 자리) 관계
      'year_branch', l_year,   -- 띠 관계
      'elements',    s_elem    -- 오행 보완 점수 (0~40)
    )
  );
end $$;

-- 추천 가능한 후보 목록 (eligibility 확인과 매칭이 반드시 같은 기준을 쓰도록 단일 함수로 관리)
-- 제외: 본인, 비공개, 탈퇴, 사주 미입력, 양방향 차단, 이 구매자에게 이미 추천된 사람
create or replace function private.eligible_candidates(p_buyer_id uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id
  from public.profiles p
  join public.profile_saju s on s.user_id = p.id
  where p.id <> p_buyer_id
    and p.status = 'active'
    and p.is_public
    and not private.is_blocked_between(p_buyer_id, p.id)
    and not exists (
      select 1 from public.match_results m
      where m.buyer_id = p_buyer_id and m.candidate_id = p.id
    );
$$;


-- ---------------------------------------------------------------------
-- 7. [계약] 결제 전 확인 : 후보 3명 이상인지
-- ---------------------------------------------------------------------
-- 서버/다른 함수용 (C의 create_order RPC 안에서 재확인할 때 사용)
create or replace function private.check_match_eligibility(p_buyer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_count int;
begin
  if not exists (
    select 1 from public.profiles p
    join public.profile_saju s on s.user_id = p.id
    where p.id = p_buyer_id and p.status = 'active'
  ) then
    return jsonb_build_object('eligible', false, 'reason', 'PROFILE_INCOMPLETE', 'candidate_count', 0);
  end if;

  select count(*) into v_count from private.eligible_candidates(p_buyer_id);

  return jsonb_build_object(
    'eligible',        v_count >= 3,
    'reason',          case when v_count >= 3 then null else 'NOT_ENOUGH_CANDIDATES' end,
    'candidate_count', v_count
  );
end $$;

-- 클라이언트용 RPC: supabase.rpc('get_match_eligibility')
create or replace function public.get_match_eligibility()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = 'MT401';
  end if;
  return private.check_match_eligibility(auth.uid());
end $$;


-- ---------------------------------------------------------------------
-- 8. [계약] 결제 완료 후 매칭 : 멱등
--    - C의 confirm_payment_and_match() 안에서 호출 → 결제 기록과 같은 트랜잭션
--    - 같은 주문으로 다시 호출하면 저장된 결과를 그대로 반환 (재계산 X)
--    - 후보 < 3 이면 MT409 예외 → 이 함수 안의 insert 는 롤백됨
-- ---------------------------------------------------------------------
create or replace function private.create_match_for_order(p_order_id uuid, p_buyer_id uuid)
returns table (rank smallint, candidate_id uuid, score numeric)
language plpgsql volatile security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_buyer  uuid;
  v_status text;
  v_n      int;
begin
  -- 동시에 웹훅이 두 번 와도 순서대로 처리되도록 주문 행 잠금
  select o.buyer_id, o.status into v_buyer, v_status
  from public.orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'MT404';
  end if;
  if v_buyer <> p_buyer_id then
    raise exception 'BUYER_MISMATCH' using errcode = 'MT403';
  end if;

  -- 멱등: 이미 결과가 있으면 그대로 반환
  if exists (select 1 from public.match_results m where m.order_id = p_order_id) then
    return query
      select m.rank, m.candidate_id, m.score::numeric
      from public.match_results m
      where m.order_id = p_order_id
      order by m.rank;
    return;
  end if;

  if v_status <> 'paid' then
    raise exception 'ORDER_NOT_PAID' using errcode = 'MT402';
  end if;

  -- 점수 내림차순, 동점은 md5(주문ID||후보ID) 로 결정적 정렬 (같은 입력 → 같은 결과)
  insert into public.match_results (order_id, buyer_id, rank, candidate_id, score, score_detail)
  select p_order_id, p_buyer_id, r.rn, r.cid, r.sc, r.detail
  from (
    select c.cid,
           (x.j ->> 'score')::numeric as sc,
           x.j -> 'detail'            as detail,
           (row_number() over (
              order by (x.j ->> 'score')::numeric desc, md5(p_order_id::text || c.cid::text)
           ))::smallint as rn
    from private.eligible_candidates(p_buyer_id) as c(cid)
    cross join lateral (select private.saju_compat(p_buyer_id, c.cid) as j) x
    where x.j is not null
  ) r
  where r.rn <= 3;

  get diagnostics v_n = row_count;
  if v_n < 3 then
    raise exception 'INSUFFICIENT_CANDIDATES' using errcode = 'MT409', detail = v_n::text;
  end if;

  return query
    select m.rank, m.candidate_id, m.score::numeric
    from public.match_results m
    where m.order_id = p_order_id
    order by m.rank;
end $$;


-- ---------------------------------------------------------------------
-- 9. [계약] 추천 결과 조회 : 결제한 주문 소유자만
--    supabase.rpc('get_match_results', { p_order_id })
--    탈퇴/비공개 전환/차단된 후보는 available=false 로 마스킹
-- ---------------------------------------------------------------------
create or replace function public.get_match_results(p_order_id uuid)
returns table (
  rank             smallint,
  candidate_id     uuid,
  available        boolean,
  nickname         text,
  avatar_url       text,
  gender           text,
  university       text,
  major            text,
  bio              text,
  interests        text[],
  day_stem         text,
  dominant_element text,
  score            numeric,
  score_detail     jsonb
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  -- 주문이 없거나 남의 주문이면 똑같이 NOT_FOUND (주문 존재 여부 노출 방지)
  if not exists (
    select 1 from public.orders o
    where o.id = p_order_id and o.buyer_id = auth.uid() and o.status = 'paid'
  ) then
    raise exception 'ORDER_NOT_FOUND' using errcode = 'MT404';
  end if;

  return query
    select m.rank,
           m.candidate_id,
           v.ok,
           case when v.ok then p.nickname else '알 수 없는 사용자' end,
           case when v.ok then p.avatar_url end,
           case when v.ok then p.gender end,
           case when v.ok then p.university end,
           case when v.ok then p.major end,
           case when v.ok then p.bio end,
           case when v.ok then p.interests else '{}'::text[] end,
           case when v.ok then s.day_stem end,
           case when v.ok then private.dominant_element(s.elements) end,
           m.score::numeric,
           m.score_detail
    from public.match_results m
    join public.profiles p on p.id = m.candidate_id
    left join public.profile_saju s on s.user_id = m.candidate_id
    cross join lateral (
      select (p.status = 'active' and p.is_public
              and not private.is_blocked_between(m.buyer_id, m.candidate_id)) as ok
    ) v
    where m.order_id = p_order_id
    order by m.rank;
end $$;


-- ---------------------------------------------------------------------
-- 10. [계약] 프로필 열람 권한 (주문 · 대화 요청 · 채팅방 기준)
-- ---------------------------------------------------------------------
create or replace function private.can_view_profile(p_viewer uuid, p_target uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  if p_viewer is null or p_target is null then return false; end if;
  if p_viewer = p_target then return true; end if;
  if private.is_blocked_between(p_viewer, p_target) then return false; end if;

  -- (1) 내가 결제한 주문의 추천 결과에 상대가 있음
  if exists (
    select 1 from public.match_results m
    join public.orders o on o.id = m.order_id
    where m.buyer_id = p_viewer and m.candidate_id = p_target and o.status = 'paid'
  ) then return true; end if;

  -- (2) 상대가 나에게 대화 요청을 보냄  [C 테이블: chat_requests]
  if exists (
    select 1 from public.chat_requests r
    where r.requester_id = p_target and r.recipient_id = p_viewer
      and r.status in ('pending', 'accepted')
  ) then return true; end if;

  -- (3) 같은 채팅방 참여자  [C 테이블: chat_participants]
  if exists (
    select 1 from public.chat_participants a
    join public.chat_participants b on b.room_id = a.room_id
    where a.user_id = p_viewer and b.user_id = p_target
  ) then return true; end if;

  return false;
end $$;

-- 클라이언트용 RPC: supabase.rpc('get_public_profile', { p_user_id })
create or replace function public.get_public_profile(p_user_id uuid)
returns table (
  user_id          uuid,
  nickname         text,
  avatar_url       text,
  gender           text,
  university       text,
  major            text,
  bio              text,
  interests        text[],
  day_stem         text,
  dominant_element text
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not private.can_view_profile(auth.uid(), p_user_id) then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'MT404';
  end if;

  return query
    select p.id, p.nickname, p.avatar_url, p.gender, p.university, p.major,
           p.bio, p.interests, s.day_stem, private.dominant_element(s.elements)
    from public.profiles p
    left join public.profile_saju s on s.user_id = p.id
    where p.id = p_user_id and p.status = 'active';
end $$;


-- ---------------------------------------------------------------------
-- 11. [계약] 채팅 RLS 헬퍼 (C의 채팅 테이블 정책에서 사용)
--     security definer 라 chat_participants 의 RLS 재귀 문제를 피함
--     예) create policy ... on chat_messages for select
--           using (private.is_room_member(room_id));
-- ---------------------------------------------------------------------
create or replace function private.is_room_member(p_room_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
begin
  return exists (
    select 1 from public.chat_participants cp
    where cp.room_id = p_room_id and cp.user_id = auth.uid()
  );
end $$;


-- ---------------------------------------------------------------------
-- 12. 실행 권한
-- ---------------------------------------------------------------------
revoke execute on all functions in schema private from public, anon, authenticated;
grant  execute on function private.is_room_member(uuid) to authenticated;

revoke execute on function public.get_match_eligibility()  from public, anon;
revoke execute on function public.get_match_results(uuid)  from public, anon;
revoke execute on function public.get_public_profile(uuid) from public, anon;
grant  execute on function public.get_match_eligibility()  to authenticated;
grant  execute on function public.get_match_results(uuid)  to authenticated;
grant  execute on function public.get_public_profile(uuid) to authenticated;
