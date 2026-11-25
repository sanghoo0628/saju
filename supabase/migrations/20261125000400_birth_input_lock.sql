-- =====================================================================
-- A 후속 마이그레이션: 점수 생성 후 매칭용 생년월일 고정 (2026-11-25)
-- 작성: A (B 검토·통합)
--
-- 기존 마이그레이션은 수정하지 않는다. 컬럼 1개, 함수 3개, 트리거 2개만 추가한다.
--
-- 팀 합의:
--   - 매칭용 생년월일은 고정 점수(fortune_results) 생성 후 변경 금지
--   - 같은 입력 재저장은 허용 (동의 시각·시간대 갱신 등)
--   - 점수 생성과 날짜 저장이 동시에 와도 어긋나지 않게 DB에서 처리
--
-- 동시 요청 처리:
--   - 점수 INSERT 는 private_birth_data 행을 FOR UPDATE 로 잠근 뒤, 점수를 만든 날짜 키
--     (scored_birth_key)가 현재 저장된 날짜와 같은지 확인한다. 다르면 거부(BIRTH_INPUT_CHANGED).
--   - 생년월일 UPDATE 는 같은 행을 잠그므로 둘은 직렬화된다. 점수가 먼저 커밋되면
--     날짜 변경 트리거가 점수를 보고 거부(BIRTH_INPUT_LOCKED)하고, 날짜 변경이 먼저
--     커밋되면 점수 INSERT 가 바뀐 날짜를 보고 거부한다.
--   - scored_birth_key 가 null 인 INSERT(이전 코드·테스트 시드)는 날짜 대조를 건너뛴다.
-- =====================================================================

alter table public.fortune_results
  add column scored_birth_key text
    check (scored_birth_key is null or char_length(scored_birth_key) between 10 and 40);

-- src/lib/score.ts scoreKey() 와 같은 형식: 'YYYY-MM-DD' | 'lunar:YYYY-MM-DD' | 'lunar-leap:YYYY-MM-DD'
create or replace function private.birth_score_key(
  p_calendar text, p_birth_date date, p_lunar_date text, p_is_leap boolean
)
returns text
language sql
immutable
set search_path = ''
as $$
  select case
    when p_calendar = 'solar' then to_char(p_birth_date, 'YYYY-MM-DD')
    when p_is_leap then 'lunar-leap:' || p_lunar_date
    else 'lunar:' || p_lunar_date
  end;
$$;

-- 1) 점수가 있으면 점수에 쓰인 날짜 필드를 바꾸지 못한다. 같은 값 재저장은 통과.
create or replace function private.guard_birth_input_after_score()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.calendar_type, new.birth_date, new.lunar_date, new.is_leap_month)
       is distinct from (old.calendar_type, old.birth_date, old.lunar_date, old.is_leap_month)
     and exists (select 1 from public.fortune_results f where f.user_id = old.user_id) then
    raise exception 'BIRTH_INPUT_LOCKED'
      using errcode = 'P0001', hint = 'matching birth input is fixed once a score exists';
  end if;
  return new;
end;
$$;

create trigger private_birth_data_lock_after_score
  before update on public.private_birth_data
  for each row execute function private.guard_birth_input_after_score();

-- 2) 점수는 지금 저장된 날짜로 만든 것만 넣는다 (생년월일 행을 잠가 날짜 변경과 직렬화).
create or replace function private.guard_score_matches_birth_input()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key text;
begin
  if new.scored_birth_key is null then
    return new;
  end if;
  select private.birth_score_key(b.calendar_type, b.birth_date, b.lunar_date, b.is_leap_month)
    into v_key
    from public.private_birth_data b
    where b.user_id = new.user_id
    for update;
  if v_key is distinct from new.scored_birth_key then
    raise exception 'BIRTH_INPUT_CHANGED'
      using errcode = 'P0001', hint = 'birth input changed while the score was being created';
  end if;
  return new;
end;
$$;

create trigger fortune_results_score_matches_birth_input
  before insert on public.fortune_results
  for each row execute function private.guard_score_matches_birth_input();

revoke all on function private.birth_score_key(text, date, text, boolean) from public;
revoke all on function private.guard_birth_input_after_score() from public;
revoke all on function private.guard_score_matches_birth_input() from public;
