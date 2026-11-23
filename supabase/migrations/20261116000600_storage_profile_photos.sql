-- =====================================================================
-- 0600 프로필 사진 Storage 정책
-- 작성: B (김상후)
--
-- 비공개 버킷 profile-photos, 경로 "{user_id}/{파일명}".
-- 업로드·수정·삭제: 본인 폴더만. 조회: can_view_profile 이 허용한 사람만.
-- 화면에는 서버가 권한 확인 후 만든 만료 서명 URL 만 내려준다.
-- =====================================================================

insert into storage.buckets (id, name, public)
values ('profile-photos', 'profile-photos', false)
on conflict (id) do update set public = false;

-- 경로 첫 폴더를 uuid 로 (형식이 아니면 null → 접근 거부)
create or replace function private.photo_owner(object_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(object_name, '/', 1) ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then split_part(object_name, '/', 1)::uuid
  end;
$$;

grant execute on function private.photo_owner(text) to authenticated, service_role;

create policy profile_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'profile-photos'
    and private.can_view_profile((select auth.uid()), private.photo_owner(name))
  );

create policy profile_photos_insert_own on storage.objects
  for insert to authenticated
  with check (bucket_id = 'profile-photos' and private.photo_owner(name) = (select auth.uid()));

create policy profile_photos_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'profile-photos' and private.photo_owner(name) = (select auth.uid()))
  with check (bucket_id = 'profile-photos' and private.photo_owner(name) = (select auth.uid()));

create policy profile_photos_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'profile-photos' and private.photo_owner(name) = (select auth.uid()));
