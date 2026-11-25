-- =====================================================================
-- A 후속 마이그레이션: 사주 공급자(HRUM) 일일 호출 한도 (2026-11-25)
-- 작성: A (B 검토·통합)
--
-- 기존 마이그레이션은 수정하지 않는다. 새 테이블 2개와 서버 전용 함수 1개만 추가한다.
--
-- 팀 합의:
--   - 한국 시간(Asia/Seoul) 날짜 기준
--   - 실제 HRUM 호출 직전에 DB에서 원자적으로 1회를 확보한다 (캐시 재사용은 세지 않음)
--   - 실패·타임아웃도 시도로 계산한다 (확보 후 되돌리지 않음)
--   - 사주 관련 API 경로(/api/fortune, /api/fortune/matching-basis)가 같은 한도를 공유한다
--   - 사용자별 한도 + 프로젝트 전체 일일 상한
-- 한도 값은 서버 환경변수(FORTUNE_DAILY_USER_LIMIT, FORTUNE_DAILY_TOTAL_LIMIT)로 넘긴다.
-- =====================================================================

create table public.fortune_provider_usage (
  user_id    uuid not null references auth.users (id) on delete cascade,
  usage_date date not null,
  calls      integer not null default 0 check (calls >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, usage_date)
);

create table public.fortune_provider_daily_total (
  usage_date date primary key,
  calls      integer not null default 0 check (calls >= 0),
  updated_at timestamptz not null default now()
);

-- 서버(service_role) 전용. 브라우저에는 노출하지 않는다.
alter table public.fortune_provider_usage       enable row level security;
alter table public.fortune_provider_daily_total enable row level security;
revoke all on public.fortune_provider_usage, public.fortune_provider_daily_total from anon, authenticated;
grant all on public.fortune_provider_usage, public.fortune_provider_daily_total to service_role;

-- ---------------------------------------------------------------------
-- 1회 확보. 반환값: 'ok' | 'user_limit' | 'total_limit'
-- 전체 → 사용자 순서로 조건부 증가한다. 사용자 한도에 걸리면 같은 트랜잭션에서 전체 증가를 되돌린다.
-- 동시 요청은 각 행의 upsert 잠금으로 직렬화되어 한도를 넘지 않는다.
-- ---------------------------------------------------------------------
create or replace function public.claim_fortune_provider_call(
  p_user uuid,
  p_user_limit integer,
  p_total_limit integer
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Seoul')::date;
  v_total integer;
  v_user integer;
begin
  if p_user is null or p_user_limit is null or p_total_limit is null
     or p_user_limit < 1 or p_total_limit < 1 then
    raise exception 'invalid fortune quota arguments' using errcode = '22023';
  end if;

  insert into public.fortune_provider_daily_total as t (usage_date, calls)
  values (v_day, 1)
  on conflict (usage_date) do update
    set calls = t.calls + 1, updated_at = now()
    where t.calls < p_total_limit
  returning t.calls into v_total;
  if v_total is null then
    return 'total_limit';
  end if;

  insert into public.fortune_provider_usage as u (user_id, usage_date, calls)
  values (p_user, v_day, 1)
  on conflict (user_id, usage_date) do update
    set calls = u.calls + 1, updated_at = now()
    where u.calls < p_user_limit
  returning u.calls into v_user;
  if v_user is null then
    update public.fortune_provider_daily_total
      set calls = calls - 1, updated_at = now()
      where usage_date = v_day;
    return 'user_limit';
  end if;

  return 'ok';
end;
$$;

revoke all on function public.claim_fortune_provider_call(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_fortune_provider_call(uuid, integer, integer) to service_role;
