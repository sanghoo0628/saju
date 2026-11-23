# A → B 사주 입력 계약

계약 버전: `matching_fortune_v1`. 구현은 `src/features/fortune/matching-input.ts`이며 서버에서만 사용한다. 이 계약의 `ready`는 B가 읽을 구조화된 사주 입력이 준비됐다는 뜻이다. 궁합 점수, 추천 순위 또는 `saju_hybrid_v0_1` 완료를 뜻하지 않는다. 승인된 조합별 규칙이 없으면 B의 hybrid 전략은 계속 `not_ready`여야 한다. `legacy_demo_v1`이나 임의 점수로 대신하지 않는다.

2026-11-18 실제 B v2 검토: 현재 B의 fortune_results와 프로필 자격 판정은 legacy HMAC 점수를 필수로 요구한다. 이 A DTO를 기존 테이블/서비스에 그대로 넘기는 저장 어댑터는 아직 없다. HRUM 강약 점수를 legacy score로 넣지 않으며, 분석 저장·legacy 점수·등록 자격을 분리하는 B 확장이 필요하다. 정확한 코드 차이는 [A_BC_INTEGRATION_DESIGN.md](A_BC_INTEGRATION_DESIGN.md)에 기록했다.

## 호출과 사용자 경계

| 진입점 | 용도 |
| --- | --- |
| `POST /api/fortune` | 사용자가 입력한 생시를 유지한 상세 결과. 생시를 알면 4주, 미상이면 3주 |
| `POST /api/fortune/matching-basis` | 동일 입력을 검증한 뒤 생시를 제외하고 다시 계산한 공통 3주 매칭 입력 |
| `calculateFortuneForMatching(request, options)` | 서버 내부에서 계산과 B DTO 변환을 한 번에 실행 |
| `toMatchingFortuneInput(result, userId)` | 이미 계산·검증된 3주 결과를 B DTO로 변환. 4주 결과는 거절 |

Route Handler는 검증된 로그인·학교 인증 컨텍스트에서 사용자 ID를 구한다. 공통 사용자 ID 함수는 `src/lib/auth/get-current-user-id.ts`의 `getCurrentUserId()`이며 반환하는 Supabase `auth.users.id`를 사용한다. helper는 UUID 형식까지 검사하지만, UUID 형식 검사는 로그인 검증을 대신하지 않는다. 요청 본문에 `userId`, `buyer_id` 등을 넣으면 strict 입력 검증에서 거절된다. B는 타인의 DTO를 요청자가 제출하게 하지 않고 서버가 저장하거나 계산한 본인 결과만 읽는다.

```ts
import { calculateFortuneForMatching } from '@/features/fortune/matching-input';
import { getFortuneServiceOptions } from '@/features/fortune/configured';

// user.id는 서버에서 검증한 로그인 사용자. requestBody에서는 받지 않는다.
const matchingInput = await calculateFortuneForMatching(
  requestBody,
  getFortuneServiceOptions(user.id),
);

if (matchingInput.status === 'ready') {
  // B의 비공개 저장소에 저장하거나 승인된 전략의 입력으로 전달한다.
  // 이 지점에서 점수·추천 성공을 선언하지 않는다.
}
```

입력 필드는 상세 사주 API와 같다. `externalProviderConsent: 'hrum_birth_data_v1'`가 있어야 HRUM에 출생정보를 전송한다. 공개 API에서는 서버 인증과 별도 동의를 함께 확인한다. 자세한 외부 전송 필드와 설정은 `FORTUNE_PROVIDER.md`를 따른다.

## 3주 기준을 만드는 방법

`calculateFortuneForMatching()`은 원래 요청 전체를 먼저 검증한다. 올바르지 않은 생시를 조용히 없애서 성공시키지 않는다. 검증한 입력을 복사하고 `birthTime: null`로 설정한 다음 `calculateFortune()`을 한 번 호출한다. HRUM에는 시·분을 보내지 않고 생시 미상 계산을 요청한다. 원래 입력은 바꾸지 않는다.

생시를 아는 사용자의 4주 원국에서 시주만 삭제하지 않는다. 오행·용신·강약도 3주 기준으로 공급자가 다시 계산해야 한다. 따라서 상세 4주 결과가 있어도 매칭 입력에는 별도 공급자 호출이 필요할 수 있고, 상세와 매칭을 모두 계산하면 공급자 호출 2건이 과금될 수 있다. 상세 결과가 이미 3주이고 사용자·입력·옵션·공급자·동의·버전이 같으면 동일 캐시 결과를 재사용할 수 있다. helper 자체에는 자동 재시도나 중복 공급자 호출이 없다.

공통 서비스는 프로세스별 128건·5분 메모리 캐시와 동일 provider 인스턴스·fingerprint의 진행 중 요청 병합(singleflight)을 제공한다. 실패한 결과는 정상 결과로 캐시하지 않는다. 여러 서버 인스턴스 사이의 중복 과금 방지나 재시작 이후의 재사용은 보장하지 않는다. B는 운영용 영속 저장소와 분산 동시 요청 제어를 통합해야 한다.

## 반환 타입

`MatchingFortuneInput`은 깊은 `readonly` TypeScript 타입의 `ready | not_ready` 판별 유니온이다. 타입은 소유권 검증이나 DB RLS를 대신하지 않는다. 함수는 선택한 정규화 값을 복사하며 원본 raw 응답·생년월일·생시·이름·API 키를 DTO에 넣지 않는다.

| 필드 | 계약 |
| --- | --- |
| `schemaVersion` | `matching_fortune_v1` |
| `purpose` | `matching_input_not_score` |
| `status` | `ready` 또는 `not_ready` |
| `userId` | 서버 로그인 컨텍스트의 UUID. `ready`에만 포함 |
| `source` | `ready`는 항상 `provider`; mock은 거절 |
| `provider`, `adapterVersion` | 공급자 ID와 우리 어댑터 계약 버전. 현재 HRUM |
| `engineVersion` | `null`. 공급자가 실제 만세력 엔진 버전을 공개하지 않음 |
| `fortuneSchemaVersion` | 내부 원국 스키마 `fortune_v2` |
| `inputFingerprint` | 사용자·입력·옵션·버전을 포함하는 서버 HMAC. 권한 토큰이 아님 |
| `calculatedAt` | 계산 결과 생성 시각. 캐시 반환 때 새 시각으로 바꾸지 않음 |
| `chartBasis`, `chart` | `three_pillars`; `year`, `month`, `day`만 존재. `hour` 필드 없음 |
| `calculation` | `profileId`, `timezone`, `dayBoundary`, `timeCorrection` |
| `analysis` | 아래 세 지표가 모두 존재하며 모두 3주 기준 |
| `comparisonKey` | 비교 그룹 구분용 메타데이터 SHA-256. 개인 입력이나 ID를 포함하지 않음 |
| `cached`, `persistence` | 캐시 재사용 여부와 현재 고정값 `not_persisted` |

`not_ready`에는 공통 버전·목적, `reasonCode`, `retryable`만 담는다. 예: `MISSING_YONGSHIN`, `MISSING_STRENGTH`, `UNMAPPED_YONGSHIN_METHOD`, `UNMAPPED_STRENGTH_RESULT`, `MOCK_RESULT`, `THREE_PILLAR_BASIS_REQUIRED`. 공급자 오류도 `not_ready`로 변환하되 `PROVIDER_TIMEOUT` 등 안전한 코드와 재시도 가능 여부는 보존한다. 공급자의 오류 원문을 전달하지 않는다. 잘못된 사용자 입력은 기존 입력 검증 예외로 처리하며 Route Handler가 400 응답으로 변환한다.

## 구조화된 분석

| 지표 | B가 사용할 필드와 의미 |
| --- | --- |
| `elementBalance` | `values.{wood,fire,earth,metal,water}`. 단위는 `surface_character_count`이며 합계는 6. 강도·비율·점수가 아님 |
| `yongshin` | `primary`, `secondary`, `selectionMethod`, 원문 방법명 `providerMethod`, `roles.{yongshin,huishin,gishin,gushin,hanshin}`, `balancingPrimary`, `climatePrimary`, `reasoning`, `elementStates` |
| `strength` | `dayMaster`, `result`, 원문 분류 `providerResult`, 공급자 `score`, `level`, `breakdown`, `root` |

모든 지표에 `basis: 'three_pillars'`와 `method`가 있다. 현재 허용한 method는 `hrum_surface_counts_v1`, `hrum_five_methods_v1`, `hrum_strength_v1`이다. 새로운 공급자·분석 방법은 문서와 fixture를 검증한 뒤 allowlist를 확장한다.

용신 선정 방법은 전왕→`dominance`, 조후→`climate`, 억부→`balancing`, 통관→`mediation`, 병약→`remedy`로 매핑한다. 사전에 모르는 방법은 `unmapped`로 보존하되 매칭 입력은 `not_ready`다. 강약은 신강→`strong`, 신약→`weak`, 중화→`balanced`이며 모르는 분류 역시 매칭에 사용하지 않는다. 공급자가 준 `strength.score`는 강약 원점수일 뿐 두 사용자의 궁합·호감도·매칭 점수가 아니다.

원국과 지표의 기준 불일치, 잘못된 오행 합계, 일간 불일치 등은 거절한다. 지표가 빠지면 다른 필드나 LLM으로 보충하지 않는다. 부족 오행을 용신으로 간주하지 않는다. 부가 역할·근거·세부 분해값의 `null`은 공급자가 제공하지 않았다는 뜻이며 0이나 부정으로 해석하지 않는다.

## 비교 가능성과 저장

`comparisonKey`에는 공급자, 어댑터 버전, 두 스키마 버전, 엔진 버전(`null`), 3주 기준, 계산 프로필·시간대·날짜 경계·보정, 세 분석 method가 들어간다. B는 키가 다른 결과를 같은 규칙으로 바로 비교하지 않는다. 키가 같아도 공급자의 비공개 엔진 변경까지 같다는 보장은 없다. 응답 변화가 발견되면 어댑터 버전·fixture 검토와 기존 결과 재계산 정책이 필요하다.

현재 DB 영구 저장은 연결하지 않았다. B는 소유자 RLS를 적용한 private 저장소, 입력 fingerprint별 동시 요청 제어, 삭제·보관 정책을 통합한다. `inputFingerprint`나 `comparisonKey`를 접근권한으로 쓰지 않는다. 출생 입력이나 상세 분석을 공개 프로필 DTO에 그대로 넣지 않는다. HRUM은 계산 결과 DB 재사용을 [공식 문서](https://hrum.ai/docs.html)에 안내하며 자체 서비스 내 가공·표시를 [약관 제11조](https://hrum.ai/terms.html)에서 허용한다. 우리 서비스의 보관 기간·삭제·외부 전송 동의는 별도로 확정해야 한다.

## 검증 상태

`tests/matching-fortune.test.ts`는 기록된 HRUM guest 응답 fixture를 로컬 provider로 주입한다. 원본 입력 보존, 한 번의 3주 계산, 상세/매칭 캐시 분리, 생시 미상 캐시 재사용, 사용자별 캐시 격리, 사용자 ID 주입 거부, mock·누락·미매핑·혼합 기준 거부, 비교키 분리와 오류 비노출을 검사한다. 실패 조건을 만드는 fixture 변형은 명시된 합성 데이터다. 테스트는 외부 API를 호출하지 않으며 유료 partner API 성공, 사주 해석의 타당성, 매칭 정확도 또는 운영 DB/RLS 검증을 뜻하지 않는다.
