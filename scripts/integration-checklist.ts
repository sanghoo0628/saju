/** Manual acceptance evidence remains separate from isolated automated checks. */
export const integrationCases = [
  { id: 'A01', area: '학교 로그인', action: '학교 메일로 OTP를 받아 로그인한다.', expected: '인증한 계정으로 /api/me가 응답하고 다른 학교 도메인은 거절된다.' },
  { id: 'A02', area: '사주 저장 미동의', action: '신규 테스트 계정에서 매칭용 저장에 동의하지 않고 사주만 확인한다.', expected: '생년월일·점수를 새로 저장하지 않고 추천은 fortune_required로 안내한다. 기존 계정의 저장값 삭제와는 별도다.' },
  { id: 'A03', area: '사주 저장 동의', action: 'A가 확정한 저장 동의 필드로 사주 입력을 저장한다.', expected: 'birthInputSaved=true, 점수 미생성이면 profile_required이며 /profile로 연결된다.' },
  { id: 'A04', area: '사주 공급자 오류', action: '공급자 미설정·시간 초과 상태에서 저장 동의 유무를 확인한다.', expected: '사주 처리와 매칭용 저장의 성공·실패를 구분해 안내하고 준비 중인 결과나 mock을 실제 분석으로 저장하지 않는다.' },
  { id: 'B01', area: '첫 프로필', action: '계열과 공개 동의를 선택해 프로필을 저장한다.', expected: '고정 점수가 한 번 생성되고 생년월일·점수·이메일은 추천 카드에 노출되지 않는다.' },
  { id: 'B02', area: '고정 점수', action: '저장 버튼을 연속 클릭하고 다시 프로필을 수정한다.', expected: '점수·계열이 유지된다. 반대 계열 요청은 TRACK_LOCKED이며 기존 값은 바뀌지 않는다.' },
  { id: 'B03', area: '프로필 비공개', action: '프로필 공개를 끄고 추천을 다시 조회한다.', expected: 'profile_required로 안내하고 상대의 새 추천 후보에서도 제외된다.' },
  { id: 'B04', area: '후보 부족', action: '격리된 테스트 데이터에서 후보 0명·1~2명·3명 이상을 확인한다.', expected: '0명은 no_candidates, 있으면 실제 후보 최대 3명만 표시하며 가상 인물을 보충하지 않는다.' },
  { id: 'B05', area: '잘못된 입력', action: '잘못된 날짜·누락된 계열·제한을 넘긴 소개·사진을 제출한다.', expected: '검증 오류를 안내하고 저장 성공으로 표시하지 않는다.' },
  { id: 'C01', area: '선택 상대', action: '무료 추천에서 상대 한 명을 선택한다.', expected: '구매자와 해당 상대의 권한을 확인한다. Groble 미연결 상태는 503이며 청구 성공으로 표시하지 않는다.' },
  { id: 'C02', area: '기존 채팅', action: '기존 방이 있는 상대의 추천·수락 이력을 연다.', expected: '추가 결제 없이 동일 채팅방으로 연결된다.' },
  { id: 'C03', area: '요청·수락', action: '테스트 권한으로 대화를 요청하고 수신자가 수락한다.', expected: '수신자 수락은 무료이며 중복 클릭에도 방 하나를 재사용한다.' },
  { id: 'C04', area: '송수신·접속 복구', action: '두 테스트 계정으로 송수신하고 접속을 끊었다 복구한다.', expected: '저장 기록을 복구하고 같은 메시지를 한 번만 시간순으로 표시한다.' },
  { id: 'C05', area: '응답 지연', action: '격리 데모에서 저장 뒤 전송 응답을 지연시킨다.', expected: '대기가 끝나고 초안이 유지된다. 명시적 재전송은 같은 ID로 한 행만 저장한다.' },
  { id: 'C06', area: '권한·차단', action: '제3자 접근과 양방향 차단을 확인한다.', expected: '요청·방·기록·Realtime 접근이 차단되며 직접 API 호출도 거절된다.' },
  { id: 'C07', area: '로그인 만료', action: '입력 중 로그아웃하거나 다른 테스트 계정으로 전환한다.', expected: '이전 계정의 대화·요청을 지우고 만료된 세션의 쓰기를 거절한다.' },
  { id: 'P01', area: 'PG 실제 검증', action: 'Groble 공식 테스트 환경으로 결제·지연·웹훅 중복·환불을 확인한다.', expected: '공식 검증 전에는 미검증으로 남긴다. 데모 성공을 실제 결제 증거로 쓰지 않는다.' },
] as const;

export const signoffGates = [
  { id: 'school_mail', status: 'not_run', title: '실제 학교 메일 수신·학교 계정 전체 흐름' },
  { id: 'storage_consent', status: 'not_run', title: 'A 저장 동의·서버 저장·프로필·추천 전체 흐름' },
  { id: 'real_payment', status: 'not_run', title: 'Groble 공식 테스트 결제·서명·웹훅·환불' },
  { id: 'rejection_refund', status: 'decision_required', title: '대화 요청 거절 시 환불 여부와 처리 기준' },
  { id: 'refunded_room', status: 'decision_required', title: '환불 후 기존 채팅방·기록 접근 범위' },
] as const;

export function renderIntegrationChecklist(): string {
  return [
    '전체 흐름 수동 검증표',
    '모든 항목은 아직 미실행이다. 자동 검사 통과와 별도로 실제 확인 후 결과를 기록한다.',
    'A 브랜치/커밋: __________  C 커밋: __________  확인자/시각: __________',
    '실제 이메일·OTP·쿠키·키·생년월일·사주 원문은 결과 파일에 적지 않는다.',
    '',
    ...integrationCases.flatMap(c => [`[ ] ${c.id} ${c.area}`, `  실행: ${c.action}`, `  기대: ${c.expected}`, '  결과/비식별 증거 위치: __________', '']),
    '팀 확인·결정 항목',
    ...signoffGates.map(g => `[ ] ${g.id}: ${g.title} (${g.status})`),
    '',
    '자동 검사 exit 0은 선택한 자동 검사 통과만 뜻한다. 전체 서비스 검증 완료를 뜻하지 않는다.',
  ].join('\n') + '\n';
}
