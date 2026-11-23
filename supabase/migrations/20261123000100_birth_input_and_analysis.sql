-- =====================================================================
-- B 후속 마이그레이션: A 사주 입력 저장 계약 (2026-11-23)
--
-- 기존 6개 마이그레이션은 수정하지 않는다. C 가 사용하는 orders, chat_requests,
-- conversations, messages, match_results, 권한 함수 이름은 건드리지 않는다.
--
-- 1. private_birth_data : 음력 원본 일자(양력 date 로 넣지 않음), 시간대, 저장 동의 기록
-- 2. fortune_results    : 고정 점수(legacy HMAC)만으로 행을 만들 수 있게 사주 원문 컬럼을 선택으로
--                         + 어떤 입력으로 해시했는지(score_input) 기록
-- 3. fortune_analyses   : A 의 matching_fortune_v1 (HRUM 3주 분석) 저장소. 서버 전용.
--                         점수와 분리한다. 이 표가 없어도 legacy 추천은 동작한다.
-- 4. storage            : profile-photos 버킷 5MB, jpeg/png/webp 제한
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. private_birth_data
--    birth_date  = 양력 입력일 (음력이면 null)
--    lunar_date  = 음력 입력일 원문 'YYYY-MM-DD' (양력이면 null). 음력 2월 30일처럼
--                  양력에 없는 날짜가 있으므로 date 타입을 쓰지 않는다.
--    birth_time  = 점수에 쓰지 않으므로 서버가 저장하지 않는다 (기존 컬럼, 항상 null 로 둠).
-- ---------------------------------------------------------------------
alter table public.private_birth_data
  alter column birth_date drop not null,
  add column lunar_date      text,
  add column timezone        text not null default 'Asia/Seoul'
    check (char_length(timezone) between 1 and 80),
  add column consent_version text check (char_length(consent_version) between 1 and 80),
  add column consented_at    timestamptz;

alter table public.private_birth_data
  add constraint birth_date_by_calendar check (
    (calendar_type = 'solar' and birth_date is not null and lunar_date is null)
    or (calendar_type = 'lunar' and lunar_date is not null and birth_date is null)
  ),
  add constraint lunar_date_format check (
    lunar_date is null
    or lunar_date ~ '^(19[0-9]{2}|2[0-9]{3})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|30)$'
  ),
  add constraint consent_recorded_together check ((consent_version is null) = (consented_at is null));

-- ---------------------------------------------------------------------
-- 2. fortune_results
-- ---------------------------------------------------------------------
alter table public.fortune_results
  alter column fortune drop not null,
  alter column program_version drop not null,
  add column score_input text not null default 'solar'
    check (score_input in ('solar', 'lunar', 'lunar_leap'));

alter table public.fortune_results
  add constraint fortune_with_program_version check ((fortune is null) = (program_version is null));

-- ---------------------------------------------------------------------
-- 3. fortune_analyses (A 의 MatchingFortuneInput status = 'ready' 만 저장)
--    출생 입력·원본 응답·사용자 이름은 넣지 않는다.
--    input_fingerprint / comparison_key 는 접근 권한으로 쓰지 않는다.
-- ---------------------------------------------------------------------
create table public.fortune_analyses (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  schema_version         text not null check (schema_version = 'matching_fortune_v1'),
  chart_basis            text not null check (chart_basis = 'three_pillars'),
  provider               text not null check (char_length(provider) between 1 and 80),
  adapter_version        text not null check (char_length(adapter_version) between 1 and 80),
  fortune_schema_version text not null check (char_length(fortune_schema_version) between 1 and 40),
  input_fingerprint      text not null check (char_length(input_fingerprint) between 1 and 200),
  comparison_key         text not null check (comparison_key ~ '^[0-9a-f]{64}$'),
  calculated_at          timestamptz not null,
  chart                  jsonb not null,
  calculation            jsonb not null,
  analysis               jsonb not null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index fortune_analyses_comparison_key_idx on public.fortune_analyses (comparison_key);

create trigger fortune_analyses_set_updated_at
  before update on public.fortune_analyses
  for each row execute function private.set_updated_at();

alter table public.fortune_analyses enable row level security;

-- Supabase 기본 권한 회수. 브라우저(anon/authenticated)는 접근하지 않고 서버만 읽고 쓴다.
revoke all on public.fortune_analyses from anon, authenticated;
grant all on public.fortune_analyses to service_role;

-- ---------------------------------------------------------------------
-- 4. 프로필 사진 버킷 제한: 5MB, 이미지 3종 (/profile 화면 업로드)
-- ---------------------------------------------------------------------
update storage.buckets
   set file_size_limit = 5242880,
       allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
 where id = 'profile-photos';
