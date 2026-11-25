'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { fortuneInputSchema, MATCHING_STORAGE_CONSENT_VERSION, type FortuneInput } from '@/features/fortune/schema';
import type { MatchingStorageStatus } from '@/features/fortune/storage';
import type { FortuneResult } from '@/features/fortune/types';
import type { MatchingFortuneInput } from '@/features/fortune/matching-input';
import { FortuneAnalysisView, FortuneResultView } from './fortune-result';

type Configuration = { provider: 'hrum' | 'mock' | 'unconfigured'; configured: boolean };
function readStorageStatus(value: unknown): MatchingStorageStatus | null {
  const status = (value as { status?: unknown } | null | undefined)?.status;
  return status === 'stored' || status === 'not_consented' || status === 'skipped' || status === 'calendar_unsupported' || status === 'unavailable' || status === 'failed' ? status : null;
}
function BirthStorageNotice({ status, onConsentAndRetry, busy, canRetry }: { status: MatchingStorageStatus | null; onConsentAndRetry: () => void; busy: boolean; canRetry: boolean }) {
  if (status === 'stored') return <div className="feedback success" role="status"><h2>매칭 정보 저장 완료</h2><p>추천에 사용할 생년월일 정보를 저장했어요. 사주 분석과 관계없이 이제 프로필을 만들 수 있어요.</p><Link className="text-link" href="/profile">프로필 만들기 →</Link></div>;
  if (status === 'calendar_unsupported') return <div className="feedback notice" role="status"><p>매칭용 생년월일은 지금 양력 날짜만 저장할 수 있어요. 추천을 받으려면 양력 날짜로 다시 입력해 주세요.</p></div>;
  if (status === 'not_consented') return <div className="feedback notice" role="status"><p>매칭용 저장에 동의하지 않아 생년월일을 저장하지 않았어요. 추천을 받으려면 {canRetry ? '저장에 동의해 주세요.' : '양력 날짜로 입력하고 저장에 동의해 주세요.'}</p>{canRetry ? <><button className="button secondary storage-retry" type="button" onClick={onConsentAndRetry} disabled={busy}>{busy ? '저장하고 있어요…' : '저장에 동의하고 추천 준비하기'}</button><p className="field-hint">같은 입력으로 다시 보내요. 5분 안이면 사주 계산은 다시 요청하지 않아요.</p></> : null}</div>;
  if (status === 'unavailable') return <div className="feedback error" role="status"><p>추천 연결을 준비하고 있어 생년월일을 아직 저장하지 못했어요.</p></div>;
  if (status === 'failed') return <div className="feedback error" role="alert"><p>생년월일을 저장하지 못했어요. 잠시 후 같은 입력으로 다시 계산해 주세요. 5분 안이면 사주 계산은 다시 요청하지 않아요.</p></div>;
  return null;
}
function matchingNotReadyMessage(result: Extract<MatchingFortuneInput, { status: 'not_ready' }>) {
  if (result.reasonCode === 'EXTERNAL_CONSENT_REQUIRED') return 'HRUM에 출생 정보를 전송하는 동의를 확인해 주세요.';
  if (result.reasonCode === 'PROVIDER_RATE_LIMITED') return '요청이 많아 잠시 후 다시 준비할 수 있어요.';
  if (result.retryable) return '사주 서비스 응답이 지연되었어요. 잠시 후 다시 시도해 주세요.';
  return '3주 분석의 필수 정보나 계산 기준이 준비되지 않았어요.';
}

export function FortuneForm({ configuration }: { configuration: Configuration }) {
  const isHrum = configuration.provider === 'hrum';
  // HRUM-only requirements (sex option, transfer consent) apply only when HRUM can actually be called.
  const hrumActive = isHrum && configuration.configured;
  const [unknownTime, setUnknownTime] = useState(true);
  const [calendar, setCalendar] = useState('solar');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [result, setResult] = useState<FortuneResult | null>(null);
  const [submittedInput, setSubmittedInput] = useState<FortuneInput | null>(null);
  const [matchingBusy, setMatchingBusy] = useState(false);
  const [matchingResult, setMatchingResult] = useState<MatchingFortuneInput | null>(null);
  const [matchingError, setMatchingError] = useState('');
  const [birthStorage, setBirthStorage] = useState<MatchingStorageStatus | null>(null);
  const [analysisStorage, setAnalysisStorage] = useState<MatchingStorageStatus | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // One click from the "not consented" notice: tick the optional storage consent and resubmit the same input.
  function consentAndRetry() {
    const form = formRef.current;
    const box = form?.elements.namedItem('matchingStorageConsent');
    if (!form || !(box instanceof HTMLInputElement) || busy) return;
    box.checked = true;
    form.requestSubmit();
  }

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || matchingBusy) return;
    const values = new FormData(event.currentTarget);
    setError(''); setAuthRequired(false); setResult(null); setSubmittedInput(null); setMatchingResult(null); setMatchingError(''); setBirthStorage(null); setAnalysisStorage(null);
    // Without a configured provider the only useful action is saving the matching birth date.
    if (!configuration.configured && values.get('matchingStorageConsent') !== 'on') {
      setError(calendar === 'solar' ? '사주 분석은 준비 중이에요. 추천을 받으려면 매칭용 저장에 동의해 주세요.' : '사주 분석은 준비 중이에요. 추천을 받으려면 양력 날짜로 입력하고 매칭용 저장에 동의해 주세요.'); return;
    }
    if (hrumActive && values.get('providerSex') === 'unspecified') {
      setError('HRUM 계산에는 성별 옵션이 필요해요. 계산용 성별을 선택해 주세요.'); return;
    }
    if (hrumActive && values.get('externalProviderConsent') !== 'on') {
      setError('HRUM에 출생 정보를 전송하는 데 별도로 동의해 주세요.'); return;
    }
    const parsed = fortuneInputSchema.safeParse({
      birthDate: values.get('birthDate'), birthTime: unknownTime ? null : values.get('birthTime'),
      calendar, isLeapMonth: calendar === 'lunar' && values.get('isLeapMonth') === 'on',
      timezone: values.get('timezone'), providerSex: values.get('providerSex'), consent: values.get('consent') === 'on',
      ...(hrumActive && values.get('externalProviderConsent') === 'on' ? { externalProviderConsent: 'hrum_birth_data_v1' } : {}),
      ...(values.get('matchingStorageConsent') === 'on' ? { matchingStorageConsent: MATCHING_STORAGE_CONSENT_VERSION } : {}),
    });
    if (!parsed.success) { setError(parsed.error.issues[0]?.message ?? '입력 내용을 다시 확인해 주세요.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/fortune', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(parsed.data) });
      const data = await response.json();
      if (data.status === 'ready' || data.status === 'not_ready' || data.status === 'error') {
        setResult(data as FortuneResult);
        setBirthStorage(readStorageStatus(data.matchingStorage));
        if (response.ok && data.status === 'ready') setSubmittedInput(parsed.data);
      } else { setAuthRequired(response.status === 401); setError(data.error?.message ?? '결과를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    } catch { setError('서버에 연결할 수 없어요. 입력 내용을 확인한 뒤 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }

  async function prepareMatchingBasis() {
    if (!submittedInput || matchingBusy || busy) return;
    setMatchingBusy(true); setMatchingResult(null); setMatchingError(''); setAnalysisStorage(null);
    try {
      const response = await fetch('/api/fortune/matching-basis', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submittedInput) });
      const data = await response.json();
      if (data.status === 'ready' || data.status === 'not_ready') { setMatchingResult(data as MatchingFortuneInput); setAnalysisStorage(readStorageStatus(data.analysisStorage)); }
      else setMatchingError(data.error?.message ?? '3주 분석을 준비하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } catch { setMatchingError('서버에 연결할 수 없어요. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.'); }
    finally { setMatchingBusy(false); }
  }

  return <><form ref={formRef} className="form-panel fortune-form" onSubmit={submit}>
    <div className="form-topline"><span className="pill">{isHrum ? 'HRUM 사주 계산' : '나의 사주'}</span><Link className="text-link" href="/fortune/result">고정 샘플 먼저 보기 →</Link></div>
    {!configuration.configured ? <div className="feedback notice" role="status"><h2>사주 분석 준비 중</h2><p>사주 계산 연결을 준비하고 있어요. 매칭 정보(양력 생년월일) 저장은 지금도 할 수 있어서, 프로필과 무료 추천까지 먼저 진행할 수 있어요.</p></div> : null}
    {hrumActive ? <p className="provider-intro">HRUM의 실제 사주 계산을 사용해요. 기본 계산은 23시를 날짜 경계로 삼으며, 출생지 위치에 따른 시간 보정은 하지 않아요.</p> : null}
    <div className="field"><label htmlFor="birthDate">태어난 날짜</label><input id="birthDate" name="birthDate" type={calendar === 'lunar' ? 'text' : 'date'} placeholder="YYYY-MM-DD" pattern={calendar === 'lunar' ? '[0-9]{4}-[0-9]{2}-[0-9]{2}' : undefined} maxLength={10} required /><span className="field-hint">음력을 선택했다면 음력 날짜를 YYYY-MM-DD 형식으로 그대로 입력해 주세요.</span></div>
    <div className="field-row"><div className="field"><label htmlFor="calendar">달력 기준</label><select id="calendar" name="calendar" value={calendar} onChange={(event) => setCalendar(event.target.value)}><option value="solar">양력</option><option value="lunar">음력</option></select></div><div className="field"><label htmlFor="birthTime">태어난 시간</label><input id="birthTime" name="birthTime" type="time" required={!unknownTime} disabled={unknownTime} /></div></div>
    <div className="checkbox-row">{calendar === 'lunar' ? <label className="check-label"><input type="checkbox" name="isLeapMonth" />윤달이에요</label> : <span />}<label className="check-label"><input type="checkbox" checked={unknownTime} onChange={(event) => setUnknownTime(event.target.checked)} />태어난 시간을 몰라요</label></div>
    <p className="field-hint time-note">시간을 몰라도 괜찮아요. 임의의 시간을 넣지 않고 년·월·일 3주로 구분해요.</p>
    <div className="field-row"><div className="field"><label htmlFor="timezone">출생지 시간대</label><input id="timezone" name="timezone" defaultValue="Asia/Seoul" required maxLength={64} /><span className="field-hint">한국은 Asia/Seoul이에요.</span></div><div className="field"><label htmlFor="providerSex">사주 계산용 성별 옵션{hrumActive ? ' (필수)' : ''}</label><select id="providerSex" name="providerSex" defaultValue="unspecified"><option value="unspecified">선택하지 않음</option><option value="female">여성</option><option value="male">남성</option></select><span className="field-hint">{hrumActive ? 'HRUM 계산에 필요하며, ' : ''}만나고 싶은 상대 조건과는 별개예요.</span></div></div>
    <div className="consent-box"><label className="check-label"><input type="checkbox" name="consent" required /><span>입력한 정보를 이번 사주 결과 요청에 사용하는 데 동의해요.</span></label><p>{isHrum ? '사주 풀이 결과는 DB에 저장하지 않고 서버 메모리에 최대 5분 임시 보관해요. 이 화면의 입력은 브라우저 저장소에 저장하지 않아요.' : '개발용 고정 샘플을 사용해요. 사주 풀이 결과는 DB에 저장하지 않고 서버 메모리에 최대 5분 임시 보관해요.'}</p></div>
    <div className="consent-box matching-storage-consent"><span className="pill consent-tag">추천을 받으려면 체크해 주세요</span><label className="check-label"><input type="checkbox" name="matchingStorageConsent" disabled={calendar !== 'solar'} /><span><strong>(선택) 매칭용 저장 동의</strong> · 추천을 받기 위해 양력 생년월일과 출생지 시간대를 우리 서비스 DB에 저장하는 데 동의해요.</span></label>{calendar !== 'solar' ? <p className="storage-calendar-note">매칭용 저장은 지금 양력 날짜만 가능해요. 음력은 양력 변환을 검증한 뒤 지원할 예정이에요.</p> : null}<p>출생 시간과 계산용 성별은 저장하지 않아요. 저장한 생년월일은 프로필의 문과·이과와 함께 고정 추천 숫자를 만드는 데만 쓰여요.{hrumActive ? ' 아래 3주 분석을 준비하면 그 분석 결과도 함께 저장해요.' : ''} 동의하지 않으면 사주 결과만 볼 수 있고 추천은 받을 수 없어요.</p></div>
    {hrumActive ? <div className="consent-box external-consent"><label className="check-label"><input type="checkbox" name="externalProviderConsent" required /><span>HRUM에 생년월일·출생시간(알고 있는 경우)·양음력 및 윤달·시간대·계산용 성별을 전송하는 데 동의해요.</span></label><p>사주 계산을 위해 외부 공급자 HRUM으로 전송돼요. 아래의 3주 분석 준비를 선택하면 같은 출생 정보에서 시간을 제외해 한 번 더 전송할 수 있어요. 동의하지 않으면 실제 계산을 이용할 수 없고, 고정 샘플은 볼 수 있어요.</p><a className="text-link privacy-link" href="https://hrum.ai/privacy.html" target="_blank" rel="noreferrer">HRUM 개인정보 처리방침 확인 ↗</a></div> : null}
    {error ? <div className="feedback error" role="alert"><p>{error}</p>{authRequired ? <Link className="text-link" href="/login">학교 이메일로 로그인하기 →</Link> : null}</div> : null}
    <button className="button primary full-width" type="submit" disabled={busy || matchingBusy}>{busy ? (configuration.configured ? '결과를 준비하고 있어요…' : '저장하고 있어요…') : configuration.configured ? '나의 사주 결과 보기' : '매칭 정보 저장하기'}<span aria-hidden="true">↗</span></button>
    <p className="microcopy">{isHrum ? '로그인 후 이용할 수 있어요. 사주 결과는 궁합 점수나 실제 추천 결과가 아니에요.' : '개발용 mock 결과는 샘플로 표시돼요. 실제 사주 분석이 아니에요.'}</p>
  </form>{result ? <div className="fortune-result-space" aria-live="polite"><FortuneResultView result={result} /><BirthStorageNotice status={birthStorage} onConsentAndRetry={consentAndRetry} busy={busy} canRetry={calendar === 'solar'} /></div> : null}
  {isHrum && result?.status === 'ready' && result.source === 'provider' && submittedInput ? <section className="matching-basis-panel">
    <span className="pill">추천 입력 준비 · 궁합 계산 아님</span><h2>모두 같은 3주 기준으로 준비해요</h2><p>추천 비교에는 생시를 제외한 년·월·일 분석이 필요해요. 위의 개인 사주 결과와 별도로 준비하며, 버튼을 누를 때만 HRUM에 요청해요.</p><p className="field-hint">이 버튼은 직전에 계산한 입력을 사용해요. 입력을 바꿨다면 먼저 사주 결과를 다시 계산해 주세요.</p>
    <button className="button secondary" type="button" onClick={prepareMatchingBasis} disabled={matchingBusy || busy || matchingResult?.status === 'ready'}>{matchingBusy ? '3주 분석을 준비하고 있어요…' : matchingResult?.status === 'ready' ? '3주 입력 준비됨' : '추천에 사용할 3주 분석 준비'}</button>
    {matchingError ? <p className="feedback error" role="alert">{matchingError}</p> : null}
    <div aria-live="polite">{matchingResult?.status === 'not_ready' ? <div className="feedback error"><p>{matchingNotReadyMessage(matchingResult)}</p><p>추천 입력이 준비되지 않았어요. 궁합 점수를 임의로 만들지 않아요.</p></div> : null}{matchingResult?.status === 'ready' ? <><div className="feedback success"><p>3주 기준 입력이 준비됐어요. 실제 추천이나 궁합 계산이 완료된 것은 아니에요.</p>{analysisStorage === 'stored' ? <p>3주 분석 결과도 저장했어요.</p> : analysisStorage === 'failed' || analysisStorage === 'unavailable' ? <p>3주 분석 결과는 저장하지 못했어요. 추천 이용에는 영향이 없어요.</p> : null}</div><FortuneAnalysisView analysis={matchingResult.analysis} basis="three_pillars" /></> : null}</div>
  </section> : null}</>;
}
