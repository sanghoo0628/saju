-- =====================================================================
-- 0500 무료 추천 생성·조회
-- 작성: B (김상후)
--
-- 매칭 규칙 (원래 기획 유지, 사주 풀이와 별개):
--   기본 숫자 1~10,000 (생년월일 HMAC) / 문과 + / 이과 −
--   거리 = abs(내 점수 + 상대 점수), 거리 오름차순 → id 오름차순, 상위 3명
-- 순위 규칙은 src/lib/matching.ts 와 반드시 같아야 한다 (tests/db 에서 교차 검증).
-- 추천은 결제와 무관하다. 서버(service_role) 전용.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 후보 목록 (정렬됨)
-- 요청자 조건: 활성 + 공개 동의 + 점수 있음 (아니면 0명)
--   → 남의 프로필을 보려면 나도 공개해야 한다 (대화 요청을 받은 상대가 내 프로필을 봐야 하므로).
-- 후보 조건: 본인 제외, 활성, 공개 동의, 점수 있음, 양방향 차단 아님, 이미 추천된 상대 제외
-- ---------------------------------------------------------------------
create or replace function private.match_candidates(p_user uuid)
returns table (user_id uuid, score integer, distance integer)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select f.score
    from public.fortune_results f
    join public.profiles p on p.id = f.user_id
    where f.user_id = p_user and p.status = 'active' and p.is_public
  )
  select p.id, f.score, abs(me.score + f.score) as distance
  from me
  cross join public.fortune_results f
  join public.profiles p on p.id = f.user_id
  where p.id <> p_user
    and p.status = 'active'
    and p.is_public
    and not private.is_blocked_between(p_user, p.id)
    and not exists (
      select 1 from public.match_results m
      where m.user_id = p_user and m.target_id = p.id
    )
  order by distance asc, p.id asc;
$$;

grant execute on function private.match_candidates(uuid) to service_role;

-- ---------------------------------------------------------------------
-- 무료 추천 저장 + 조회 (B 의 GET /api/match-results 가 service_role 로 호출)
--
-- - 저장된 추천이 3개 미만이면 부족한 만큼 새 후보로 채운다
--   (가입 초기 후보가 적을 때 나중에 다시 열면 채워짐).
-- - 이미 저장된 추천은 바꾸지 않는다 → 새로고침해도 같은 결과·같은 id.
-- - 저장된 상대가 나중에 비공개·탈퇴·차단되면 결과에서 숨기지만 다른 사람으로 다시 채우지 않는다
--   (차단을 반복해 무료로 계속 새 프로필을 여는 것을 막기 위함. 재추천 정책은 팀 합의).
-- - 같은 사용자의 동시 호출은 profiles 행 잠금으로 직렬화한다.
-- ---------------------------------------------------------------------
create or replace function public.get_or_create_match_results(p_user uuid)
returns table (id uuid, target_id uuid, rank smallint, distance integer, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_have integer;
begin
  perform 1 from public.profiles p where p.id = p_user for update;

  select count(*) into v_have from public.match_results m where m.user_id = p_user;

  if v_have < 3 then
    insert into public.match_results (user_id, target_id, rank, distance, target_score)
    select p_user, c.user_id, (v_have + c.rn)::smallint, c.distance, c.score
    from (
      select mc.user_id, mc.score, mc.distance,
             row_number() over (order by mc.distance asc, mc.user_id asc) as rn
      from private.match_candidates(p_user) mc
    ) c
    where c.rn <= 3 - v_have;
  end if;

  return query
    select m.id, m.target_id, m.rank, m.distance, m.created_at
    from public.match_results m
    where m.user_id = p_user
      and private.profile_available(m.target_id)
      and not private.is_blocked_between(p_user, m.target_id)
    order by m.rank;
end;
$$;

revoke all on function public.get_or_create_match_results(uuid) from public, anon, authenticated;
grant execute on function public.get_or_create_match_results(uuid) to service_role;
