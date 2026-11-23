import Link from 'next/link';

const steps = [
  { n: '01', title: '나를 알아가는 작은 힌트', text: '생년월일시로 사주를 살펴봐요. 나에 대한 이야기가 첫 대화의 시작이 될 수 있어요.' },
  { n: '02', title: '세 명의 새로운 가능성', text: '추천 프로필 3명은 무료로 확인해요. 마음이 가는 상대를 천천히 골라보세요.' },
  { n: '03', title: '서로의 마음이 만날 때', text: '선택한 상대에게 500원으로 대화를 요청해요. 상대가 수락하면 둘만의 대화가 시작돼요.' },
];

export default function HomePage() {
  return (
    <>
      <section className="hero page-width">
        <div className="hero-copy">
          <p className="eyebrow"><span /> CAMPUS, COINCIDENCE & CONNECTION</p>
          <h1>우리 사이,<br />어떤 이야기가<br /><em>시작될까요?</em></h1>
          <p className="hero-description">사주로 발견하는 작은 공통점.<br />익숙한 캠퍼스에서 만나는 새로운 인연.</p>
          <div className="button-row"><Link className="button primary" href="/fortune">나의 사주 알아보기 <span aria-hidden="true">↗</span></Link><Link className="text-link" href="/fortune/result">샘플 먼저 둘러보기 <span aria-hidden="true">→</span></Link></div>
          <p className="microcopy">개발 미리보기 · 샘플 결과로 먼저 둘러볼 수 있어요</p>
        </div>
        <div className="hero-art" aria-label="서로 가까워지는 두 원의 일러스트" role="img">
          <span className="art-caption">A LITTLE CHANCE,<br />A NEW CHAPTER.</span>
          <div className="orbit orbit-one" /><div className="orbit orbit-two" />
          <div className="art-sun"><span>너</span></div><div className="art-moon"><span>나</span></div>
          <span className="art-star star-one">✦</span><span className="art-star star-two">✧</span>
          <div className="art-note"><span className="note-spark">✳</span><p>어쩌면, 오늘이<br /><strong>우리의 첫 페이지.</strong></p></div>
          <span className="art-number">사람과 사람, 그 사이</span>
        </div>
      </section>
      <section className="intro-strip"><div className="page-width"><p>끌림은 가볍게.<br className="mobile-break" /> 선택은 서로의 마음으로.</p><span>사주가 정답을 정하지 않아요.<br />우리는 대화를 시작할 작은 계기를 만들어요.</span></div></section>
      <section className="how-section page-width" aria-labelledby="how-title">
        <div className="section-heading"><div><p className="eyebrow">HOW WE MEET</p><h2 id="how-title">새로운 사이가 되는 순서</h2></div><span className="section-kicker">조금씩, 서로에게.</span></div>
        <div className="steps-grid">{steps.map((step) => <article className="step-card" key={step.n}><span className="step-number">{step.n}</span><h3>{step.title}</h3><p>{step.text}</p></article>)}</div>
        <div className="price-note"><span aria-hidden="true">↳</span><p>프로필 열람은 무료 · 대화 요청은 상대당 500원<br /><span>기존 대화는 재결제 없이 이어가고, 수신자의 수락과 답장은 무료예요. 결제가 상대의 수락을 보장하지는 않아요.</span></p></div>
      </section>
    </>
  );
}
