-- =====================================================================
-- 0100 프로필, 비공개 입력, 사주 결과·점수, 차단·신고
-- 작성: B (김상후)
-- 계약: docs/CONTRACT_profile_matching.md
-- =====================================================================

-- 내부 함수용 스키마. PostgREST API 로 노출되지 않는다 (RPC 로 직접 호출 불가).
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;
alter default privileges in schema private revoke execute on functions from public;

-- 문과 / 이과. src/lib/score.ts 의 TRACKS 와 같은 값.
create type public.track as enum ('humanities', 'science');

create or replace function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- profiles: 상대에게 보여줄 수 있는 프로필 카드 정보 (id = auth.users.id)
-- ---------------------------------------------------------------------
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  nickname            text not null check (char_length(btrim(nickname)) between 2 and 20),
  gender              text check (gender in ('male', 'female')),   -- 매칭 필터 사용 여부는 팀 합의
  university          text check (char_length(university) <= 50),
  major               text check (char_length(major) <= 50),
  bio                 text not null default '' check (char_length(bio) <= 300),
  interests           text[] not null default '{}' check (cardinality(interests) <= 10),
  -- Storage profile-photos 버킷 경로. 반드시 본인 폴더("{id}/...") 아래.
  photo_path          text check (photo_path is null or photo_path like id::text || '/%'),
  -- 계열은 저장된 점수 부호로 서버가 정한다 (문과 +, 이과 −)
  track               public.track not null,
  is_public           boolean not null default false,   -- 매칭 후보 공개 동의
  public_consented_at timestamptz,                       -- 마지막 공개 동의 시각
  status              text not null default 'active' check (status in ('active', 'deleted')),  -- 탈퇴는 soft delete
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint profiles_public_requires_consent check (not is_public or public_consented_at is not null),
  constraint profiles_deleted_at check ((status = 'deleted') = (deleted_at is not null))
);

create or replace function private.profiles_track_consent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_public and (tg_op = 'INSERT' or not old.is_public) then
    new.public_consented_at := now();
  end if;
  return new;
end;
$$;

create trigger profiles_track_consent
  before insert or update of is_public on public.profiles
  for each row execute function private.profiles_track_consent();

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function private.set_updated_at();

create index profiles_matchable_idx on public.profiles (id) where is_public and status = 'active';

-- ---------------------------------------------------------------------
-- private_birth_data: 생년월일 등 사주에 필요한 비공개 입력 (본인만 조회, 서버만 기록)
-- ---------------------------------------------------------------------
create table public.private_birth_data (
  user_id        uuid primary key references auth.users (id) on delete cascade,
  birth_date     date not null check (birth_date >= date '1900-01-01'),
  birth_time     time,                                             -- null = 모름
  calendar_type  text not null default 'solar' check (calendar_type in ('solar', 'lunar')),
  is_leap_month  boolean not null default false,
  birth_place    text,
  updated_at     timestamptz not null default now(),
  constraint leap_month_only_lunar check (calendar_type = 'lunar' or not is_leap_month)
);

create trigger private_birth_data_set_updated_at
  before update on public.private_birth_data
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- fortune_results: 매칭 점수 + 사주 풀이 (본인만 조회, 서버만 기록)
-- 매칭 점수와 사주 풀이는 별개다. 점수는 생년월일 HMAC 고정 숫자(src/lib/score.ts).
-- 저장된 점수를 우선 사용한다 → 비밀 키가 바뀌어도 기존 점수 유지.
-- ---------------------------------------------------------------------
create table public.fortune_results (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  base_number      integer not null check (base_number between 1 and 10000),
  score            integer not null,
  score_version    integer not null,
  fortune          jsonb not null,           -- 사주 프로그램 응답 (정상 결과만 저장, 타인 비공개)
  program_version  text not null,            -- 사주 프로그램 버전
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint fortune_score_matches_base check (score = base_number or score = -base_number)
);

create trigger fortune_results_set_updated_at
  before update on public.fortune_results
  for each row execute function private.set_updated_at();

create index fortune_results_score_idx on public.fortune_results (score);

-- ---------------------------------------------------------------------
-- blocks / reports
-- ---------------------------------------------------------------------
create table public.blocks (
  blocker_id  uuid not null references auth.users (id) on delete cascade,
  blocked_id  uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

create index blocks_blocked_idx on public.blocks (blocked_id, blocker_id);

create table public.reports (
  id           uuid primary key default gen_random_uuid(),
  reporter_id  uuid references auth.users (id) on delete set null,
  target_id    uuid references auth.users (id) on delete set null,
  reason       text not null check (char_length(btrim(reason)) between 1 and 1000),
  status       text not null default 'open' check (status in ('open', 'reviewing', 'resolved', 'dismissed')),
  created_at   timestamptz not null default now(),
  check (reporter_id is distinct from target_id)
);
