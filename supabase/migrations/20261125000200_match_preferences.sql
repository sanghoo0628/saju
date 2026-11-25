-- =====================================================================
-- B 후속 마이그레이션: 추천받을 상대 성별 (계약서 8장 2번, 2026-11-24)
--
-- 기존 7개 마이그레이션은 수정하지 않는다. C 가 쓰는 orders, chat_requests,
-- conversations, messages, match_results, 권한 함수는 건드리지 않는다.
--
-- 1. match_preferences : 추천받을 상대 성별. 서버 전용 표.
--    profiles 는 추천받은 사람·대화 상대가 모든 칸을 읽을 수 있어서 넣지 않는다.
--    행이 없으면 'any'(상관없음)와 같다 → 기존 사용자의 추천은 그대로다.
-- 2. private.match_candidates : 서로의 조건을 모두 만족하는 사람만 후보로 남긴다.
--    순위 규칙(거리 오름차순 → id 오름차순)은 그대로다 (src/lib/matching.ts 와 동일).
--    이미 저장된 추천(match_results)은 다시 계산하지 않는다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. match_preferences
-- ---------------------------------------------------------------------
create table public.match_preferences (
  user_id          uuid primary key references public.profiles (id) on delete cascade,
  preferred_gender text not null default 'any' check (preferred_gender in ('any', 'male', 'female')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create trigger match_preferences_set_updated_at
  before update on public.match_preferences
  for each row execute function private.set_updated_at();

alter table public.match_preferences enable row level security;

-- Supabase 기본 권한 회수. 브라우저(anon/authenticated)는 접근하지 않고 서버만 읽고 쓴다.
revoke all on public.match_preferences from anon, authenticated;
grant all on public.match_preferences to service_role;

-- ---------------------------------------------------------------------
-- 2. 후보 목록 (정렬됨) — 0500 의 정의를 성별 조건만 더해 교체
-- 요청자 조건: 활성 + 공개 동의 + 점수 있음 (아니면 0명)
-- 후보 조건: 본인 제외, 활성, 공개 동의, 점수 있음, 양방향 차단 아님, 이미 추천된 상대 제외,
--            + 성별 조건 (서로):
--              내 조건이 'any' 가 아니면 상대 성별이 그 값이어야 한다 (상대 성별 미입력이면 제외)
--              상대 조건이 'any' 가 아니면 내 성별이 그 값이어야 한다 (내 성별 미입력이면 제외)
-- ---------------------------------------------------------------------
create or replace function private.match_candidates(p_user uuid)
returns table (user_id uuid, score integer, distance integer)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select f.score, p.gender, coalesce(mp.preferred_gender, 'any') as preferred_gender
    from public.fortune_results f
    join public.profiles p on p.id = f.user_id
    left join public.match_preferences mp on mp.user_id = p.id
    where f.user_id = p_user and p.status = 'active' and p.is_public
  )
  select p.id, f.score, abs(me.score + f.score) as distance
  from me
  cross join public.fortune_results f
  join public.profiles p on p.id = f.user_id
  left join public.match_preferences op on op.user_id = p.id
  where p.id <> p_user
    and p.status = 'active'
    and p.is_public
    and (me.preferred_gender = 'any' or p.gender = me.preferred_gender)
    and (coalesce(op.preferred_gender, 'any') = 'any' or me.gender = op.preferred_gender)
    and not private.is_blocked_between(p_user, p.id)
    and not exists (
      select 1 from public.match_results m
      where m.user_id = p_user and m.target_id = p.id
    )
  order by distance asc, p.id asc;
$$;

grant execute on function private.match_candidates(uuid) to service_role;
