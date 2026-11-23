'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/browser';
import {
  PROFILE_LIMITS,
  PROFILE_PHOTO_LIMITS,
  type Gender,
  type MyProfileResponse,
  type ProfileStateResponse,
  type UpdateProfileRequest,
} from '@/contracts/matching';
import type { Track } from '@/lib/score';
import './profile-form.css';

const PHOTO_BUCKET = 'profile-photos';
const PHOTO_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const TRACK_LABEL: Record<Track, string> = { humanities: '문과', science: '이과' };

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; state: ProfileStateResponse };

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: { message?: string } };
    if (body.error?.message) return body.error.message;
  } catch { /* JSON 아님 */ }
  return '요청을 처리하지 못했어요. 잠시 후 다시 시도해주세요.';
}

function splitInterests(value: string): string[] {
  const list: string[] = [];
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (item && !list.includes(item)) list.push(item);
  }
  return list;
}

export function ProfileForm({ userId }: { userId: string }) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/profile', { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) { setLoad({ kind: 'error', message: await readError(response) }); return; }
        setLoad({ kind: 'ready', state: await response.json() as ProfileStateResponse });
      } catch {
        if (!controller.signal.aborted) setLoad({ kind: 'error', message: '서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.' });
      }
    })();
    return () => controller.abort();
  }, []);

  if (load.kind === 'loading') return <div className="loading-state" role="status"><span className="loading-dot" />프로필을 불러오고 있어요</div>;
  if (load.kind === 'error') return <div className="feedback error" role="alert"><p>{load.message}</p></div>;

  const { state } = load;
  if (!state.birthInputSaved && !state.lockedTrack) {
    return <section className="empty-panel">
      <span className="pill">1단계 · 사주 입력</span>
      <h2>사주 화면에서 생년월일을 먼저 저장해주세요</h2>
      <p>추천에 쓰는 고정 점수는 저장된 생년월일과 문과·이과로 만들어요. 사주 결과를 확인하면서 매칭용 저장에 동의하면 이 화면에서 프로필을 등록할 수 있어요.</p>
      <div className="button-row"><Link className="button primary" href="/fortune">나의 사주 확인 <span aria-hidden="true">→</span></Link></div>
    </section>;
  }
  return <ProfileEditor userId={userId} initial={state.profile} lockedTrack={state.lockedTrack} />;
}

function ProfileEditor({ userId, initial, lockedTrack }: { userId: string; initial: MyProfileResponse | null; lockedTrack: Track | null }) {
  const [saved, setSaved] = useState<MyProfileResponse | null>(initial);
  const [track, setTrack] = useState<Track | null>(lockedTrack);
  const [trackLocked, setTrackLocked] = useState(lockedTrack !== null);
  const [photoPath, setPhotoPath] = useState<string | null | undefined>(undefined); // undefined = 변경 없음
  const [photoPreview, setPhotoPreview] = useState<string | null>(initial?.photoUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function uploadPhoto(file: File) {
    setError(''); setNotice('');
    if (!(PROFILE_PHOTO_LIMITS.mimeTypes as readonly string[]).includes(file.type)) { setError('JPG, PNG, WEBP 사진만 올릴 수 있어요.'); return; }
    if (file.size > PROFILE_PHOTO_LIMITS.maxBytes) { setError('사진은 5MB 이하만 올릴 수 있어요.'); return; }
    setUploading(true);
    try {
      const path = `${userId}/${Date.now()}.${PHOTO_EXT[file.type]}`;
      const { error: uploadError } = await createClient().storage.from(PHOTO_BUCKET).upload(path, file, { contentType: file.type, upsert: false });
      if (uploadError) { setError('사진을 올리지 못했어요. 잠시 후 다시 시도해주세요.'); return; }
      setPhotoPath(path);
      setPhotoPreview(URL.createObjectURL(file));
      setNotice('사진을 올렸어요. 저장을 눌러야 프로필에 반영돼요.');
    } catch { setError('사진을 올리지 못했어요. 잠시 후 다시 시도해주세요.'); }
    finally { setUploading(false); }
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uploading) return;
    setError(''); setNotice('');
    const values = new FormData(event.currentTarget);
    if (!track) { setError('문과·이과를 선택해주세요.'); return; }
    const interests = splitInterests(String(values.get('interests') ?? ''));
    if (interests.length > PROFILE_LIMITS.interestsMax) { setError(`관심사는 최대 ${PROFILE_LIMITS.interestsMax}개예요.`); return; }
    if (interests.some(item => item.length > PROFILE_LIMITS.interestMax)) { setError(`관심사 하나는 ${PROFILE_LIMITS.interestMax}자 이하예요.`); return; }
    const gender = String(values.get('gender') ?? '');
    const body: UpdateProfileRequest = {
      nickname: String(values.get('nickname') ?? ''),
      isPublic: values.get('isPublic') === 'on',
      bio: String(values.get('bio') ?? ''),
      gender: gender === 'male' || gender === 'female' ? gender as Gender : null,
      university: String(values.get('university') ?? ''),
      major: String(values.get('major') ?? ''),
      interests,
      ...(trackLocked ? {} : { track }),
      ...(photoPath !== undefined ? { photoPath } : {}),
    };
    setBusy(true);
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) { setError(await readError(response)); return; }
      const next = await response.json() as MyProfileResponse;
      setSaved(next); setTrack(next.track); setTrackLocked(true);
      setPhotoPath(undefined); setPhotoPreview(next.photoUrl);
      setNotice(next.isPublic ? '저장했어요. 이제 무료 추천을 확인할 수 있어요.' : '저장했어요. 추천을 보려면 공개에 동의해주세요.');
    } catch { setError('서버에 연결할 수 없어요. 잠시 후 다시 시도해주세요.'); }
    finally { setBusy(false); }
  }

  const p = saved;
  return <form className="form-panel profile-form" onSubmit={submit}>
    <div className="form-topline"><span className="pill">{p ? '프로필 수정' : '프로필 등록'}</span>{p?.isPublic ? <Link className="text-link" href="/matches">무료 추천 보기 →</Link> : null}</div>

    <div className="profile-photo-row">
      {/* eslint-disable-next-line @next/next/no-img-element -- 만료 서명 URL·로컬 미리보기라 next/image 최적화 대상이 아님 */}
      <div className="profile-photo">{photoPreview ? <img src={photoPreview} alt="내 프로필 사진" /> : <span aria-hidden="true">✳</span>}</div>
      <div className="field">
        <label htmlFor="photo">사진 (선택)</label>
        <input id="photo" type="file" accept={PROFILE_PHOTO_LIMITS.mimeTypes.join(',')} disabled={uploading || busy}
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadPhoto(file); event.target.value = ''; }} />
        <span className="field-hint">JPG·PNG·WEBP, 5MB 이하. 추천받은 상대와 대화 상대에게만 보여요.</span>
        {photoPreview ? <button type="button" className="plain-button profile-photo-remove" disabled={uploading || busy} onClick={() => { setPhotoPath(null); setPhotoPreview(null); }}>사진 빼기</button> : null}
      </div>
    </div>

    <div className="field">
      <label htmlFor="nickname">닉네임</label>
      <input id="nickname" name="nickname" required minLength={PROFILE_LIMITS.nicknameMin} maxLength={PROFILE_LIMITS.nicknameMax} defaultValue={p?.nickname ?? ''} autoComplete="nickname" />
    </div>

    <fieldset className="field profile-track">
      <legend>계열</legend>
      <div className="profile-choice-row">
        {(['humanities', 'science'] as const).map(value => <label key={value} className={`profile-choice${track === value ? ' selected' : ''}`}>
          <input type="radio" name="track" value={value} checked={track === value} disabled={trackLocked} onChange={() => setTrack(value)} />{TRACK_LABEL[value]}
        </label>)}
      </div>
      <span className="field-hint">{trackLocked ? '계열은 처음 저장한 뒤에는 바꿀 수 없어요.' : '처음 저장할 때 고정 점수가 만들어지고, 이후에는 바꿀 수 없어요.'}</span>
    </fieldset>

    <div className="field-row">
      <div className="field"><label htmlFor="gender">성별 (선택)</label>
        <select id="gender" name="gender" defaultValue={p?.gender ?? ''}><option value="">선택하지 않음</option><option value="female">여성</option><option value="male">남성</option></select>
      </div>
      <div className="field"><label htmlFor="university">학교 (선택)</label>
        <input id="university" name="university" maxLength={PROFILE_LIMITS.schoolFieldMax} defaultValue={p?.university ?? ''} placeholder="고려대학교" />
      </div>
    </div>
    <div className="field"><label htmlFor="major">전공 (선택)</label>
      <input id="major" name="major" maxLength={PROFILE_LIMITS.schoolFieldMax} defaultValue={p?.major ?? ''} />
    </div>
    <div className="field"><label htmlFor="bio">소개 (선택)</label>
      <textarea id="bio" name="bio" rows={4} maxLength={PROFILE_LIMITS.bioMax} defaultValue={p?.bio ?? ''} placeholder="나를 한두 문장으로 소개해주세요." />
      <span className="field-hint">{PROFILE_LIMITS.bioMax}자 이하</span>
    </div>
    <div className="field"><label htmlFor="interests">관심사 (선택)</label>
      <input id="interests" name="interests" defaultValue={p?.interests.join(', ') ?? ''} placeholder="등산, 영화, 보드게임" />
      <span className="field-hint">쉼표로 구분, 최대 {PROFILE_LIMITS.interestsMax}개</span>
    </div>

    <div className="consent-box"><label className="check-label"><input type="checkbox" name="isPublic" defaultChecked={p?.isPublic ?? false} />
      <span>매칭 후보로 내 프로필 카드를 공개하는 데 동의해요.</span></label>
      <p>공개하면 나를 추천받은 사람이 닉네임·계열·소개·관심사·학교·전공·사진을 볼 수 있어요. 공개해야 나도 무료 추천을 받을 수 있고, 언제든 끌 수 있어요.</p>
    </div>

    {error ? <div className="feedback error" role="alert"><p>{error}</p></div> : null}
    {notice ? <div className="feedback success" role="status"><p>{notice}</p></div> : null}
    <button className="button primary full-width" type="submit" disabled={busy || uploading}>{busy ? '저장하고 있어요…' : uploading ? '사진을 올리고 있어요…' : '프로필 저장'}</button>
  </form>;
}
