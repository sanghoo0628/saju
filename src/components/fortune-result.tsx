import Link from 'next/link';
import type { FortuneResult } from '@/features/fortune/types';
import type { ElementCode, NormalizedChart } from '@/features/fortune/normalization';
import type { ReadyMatchingFortuneInput } from '@/features/fortune/matching-input';

const pillarNames = { year: '년주', month: '월주', day: '일주', hour: '시주' } as const;
const stemLabels = { gap: '甲', eul: '乙', byeong: '丙', jeong: '丁', mu: '戊', gi: '己', gyeong: '庚', sin: '辛', im: '壬', gye: '癸' } as const;
const branchLabels = { ja: '子', chuk: '丑', in: '寅', myo: '卯', jin: '辰', sa: '巳', o: '午', mi: '未', sin: '申', yu: '酉', sul: '戌', hae: '亥' } as const;
const elementLabels: Record<ElementCode, string> = { wood: '목 木', fire: '화 火', earth: '토 土', metal: '금 金', water: '수 水' };
const selectionLabels = { dominance: '전왕', climate: '조후', balancing: '억부', mediation: '통관', remedy: '병약', unmapped: '공급자 기준 확인 필요' } as const;
const roleLabels = { yongshin: '용신', huishin: '희신', gishin: '기신', gushin: '구신', hanshin: '한신' } as const;

export function FortuneAnalysisView({ analysis, basis }: { analysis: NormalizedChart['analysis'] | ReadyMatchingFortuneInput['analysis']; basis: 'three_pillars' | 'four_pillars' }) {
  const { elementBalance, yongshin, strength } = analysis;
  if (!elementBalance && !yongshin && !strength) return null;
  return <div className="fortune-analysis">
    <p className="analysis-basis">{basis === 'three_pillars' ? '년·월·일 3주 기준 분석' : '년·월·일·시 4주 기준 분석'}</p>
    {elementBalance ? <section className="analysis-card" aria-label="오행 분포"><h3>원국의 오행</h3><p className="analysis-description">표면 천간·지지 {basis === 'three_pillars' ? '6' : '8'}글자의 오행 수예요. 궁합 점수나 부족한 오행의 처방을 뜻하지 않아요.</p><dl className="element-counts">{(Object.keys(elementLabels) as ElementCode[]).map((element) => <div className={`element-count element-${element}`} key={element}><dt>{elementLabels[element]}</dt><dd>{elementBalance.values[element]}<span>개</span></dd></div>)}</dl></section> : null}
    {yongshin ? <section className="analysis-card" aria-label="용신 분석"><div className="analysis-title"><h3>용신 분석</h3><span className="pill">{selectionLabels[yongshin.selectionMethod]}</span></div><dl className="analysis-facts"><div><dt>주요 용신</dt><dd>{elementLabels[yongshin.primary]}</dd></div><div><dt>보조 용신</dt><dd>{yongshin.secondary.length ? yongshin.secondary.map((element) => elementLabels[element]).join(' · ') : '공급자 응답 없음'}</dd></div><div><dt>공급자 선정 방식</dt><dd>{yongshin.providerMethod}</dd></div></dl>{yongshin.roles ? <dl className="role-grid">{(Object.keys(roleLabels) as (keyof typeof roleLabels)[]).map((role) => <div key={role}><dt>{roleLabels[role]}</dt><dd>{yongshin.roles?.[role] ? elementLabels[yongshin.roles[role]] : '미제공'}</dd></div>)}</dl> : null}{yongshin.reasoning.length ? <details className="analysis-reasoning"><summary>공급자의 선정 근거 보기</summary><ul>{yongshin.reasoning.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details> : null}</section> : null}
    {strength ? <section className="analysis-card" aria-label="신강약 분석"><h3>신강약 분석</h3><dl className="analysis-facts"><div><dt>공급자 판정</dt><dd>{strength.providerResult}</dd></div><div><dt>세부 수준</dt><dd>{strength.level}</dd></div><div><dt>공급자 원점수</dt><dd>{strength.score}</dd></div></dl><p className="analysis-description">−100~100 범위의 공급자 원점수입니다. 궁합 점수나 연애 성공률이 아니에요.</p></section> : null}
  </div>;
}

export function FortuneResultView({ result }: { result: FortuneResult }) {
  if (result.status !== 'ready') return <section className="feedback error" role="alert"><h2>아직 결과를 준비하지 못했어요</h2><p>{result.message}</p></section>;
  return <section className="result-panel" aria-labelledby="result-heading">
    <div className="result-heading"><span className="pill">{result.source === 'mock' ? '개발용 고정 샘플 · 실제 계산 아님' : `${result.provider === 'hrum' ? 'HRUM' : '외부 공급자'} 사주 결과`}</span><span className="result-basis">{result.data.chartBasis === 'three_pillars' ? '3주 · 생시 미상' : '4주 · 생시 포함'}</span></div>
    <h2 id="result-heading">{result.data.interpretation.title}</h2>
    {result.source === 'mock' ? <p className="sample-disclaimer">이 결과는 화면과 데이터 연결을 확인하기 위한 고정 예시예요. 입력한 생년월일에 따른 실제 사주나 궁합 분석이 아니에요.</p> : null}
    <div className="pillars-grid">{(['year', 'month', 'day', 'hour'] as const).map((key) => { const pillar = result.data.chart[key]; return <div className={`pillar pillar-${key}`} key={key}><span>{pillarNames[key]}</span><strong>{pillar ? stemLabels[pillar.stem] : '—'}</strong><strong>{pillar ? branchLabels[pillar.branch] : '—'}</strong><small>{pillar ? '천간 / 지지' : '생시 미상'}</small></div>; })}</div>
    <div className="result-prose">{result.data.interpretation.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    <FortuneAnalysisView analysis={result.data.analysis} basis={result.data.chartBasis} />
    <details className="result-details"><summary>결과를 읽기 전에 알아두세요</summary><ul>{result.data.limitations.map((item, index) => <li key={index}>{item}</li>)}</ul><p>사주 정보는 연애 성공률이나 상대의 성격·안전성을 판정하지 않아요. 사주 풀이 결과는 DB에 저장하지 않고 서버 메모리에 최대 5분 임시 보관해요. 매칭용 저장에 동의한 경우에만 생년월일·달력·시간대를 저장해요.</p>{result.source === 'provider' ? <p>계산 기준: {result.data.calculation.dayBoundary === 'zi_hour_start' ? '23시부터 다음 날로 구분' : '자정부터 다음 날로 구분'} · 출생지 위치 보정 없음 · {result.data.calculation.timezone}</p> : null}</details>
    <div className="result-next"><div><h3>이제, 나의 이야기를 소개해 볼까요?</h3><p>프로필 등록 기능은 준비 중이에요.</p></div><Link className="text-link" href="/profile">프로필 준비 상태 보기 →</Link></div>
  </section>;
}
