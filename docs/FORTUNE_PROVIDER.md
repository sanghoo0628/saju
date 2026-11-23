# A: HRUM 사주 공급자 연결 계약

기준일 2026-11-16. **실제 HRUM partner API 어댑터 구현 완료, partner 키 연결 검증 대기**다. 공식 무료 guest API에 가상 입력 두 건(3주/4주)을 보내 성공을 확인했다. 이 결과를 partner 인증·과금·전체 명리 정확도 검증으로 간주하지 않는다. 저장은 최대 5분의 메모리 캐시뿐이며 B의 DB/RLS는 연결하지 않았다.

## 선정과 외부 계약

HRUM은 시간 생략 시 3주와 해당 파생 분석을 명시하고, 용신 선정 방법·주/보조 오행·오신 역할 및 강약 원점수·분류·근거를 구조화한다. [API 비교](SAJU_PROVIDER_COMPARISON.md), [공식 개발 문서](https://hrum.ai/docs.html), [만세력 API 안내](https://hrum.ai/manseryeok-api.html)를 기준으로 구현했다.

고정 `POST https://api.hrum.ai/api/v1/partners/v1/manseryeok`와 `X-Partner-Api-Key`를 사용한다. 실제 partner 요청은 공급자 요금 정책을 적용받으므로 계정 콘솔에서 최신 가격·잔액·제한을 확인한다. 자동 재시도와 무료 guest fallback은 없다. [이용약관](https://hrum.ai/terms.html)의 자체 서비스 이용 범위와 [개인정보처리방침](https://hrum.ai/privacy.html)의 수탁 처리·보관 항목을 운영자가 확인해야 한다. 화면 전송 동의만으로 운영 계약·고지·동의 기록 보관이 모두 완료되는 것은 아니다.

## 실제 연결·재현

1. HRUM partner API 키를 로컬 `.env.local`의 `SAJU_API_KEY`에만 넣는다. 이번 작업에서 계정을 만들거나 유료 호출을 실행하지 않았다.
2. `SAJU_PROVIDER=hrum`, 32자 이상의 무작위 서버 비밀값 `SAJU_FINGERPRINT_SECRET`을 설정한다. `SAJU_API_BASE_URL`은 비우거나 위 endpoint에서 `/manseryeok`을 제외한 고정 base만 지정한다. 다른 호스트로 키를 보내지 않는다.
3. README의 개발 Supabase·허용 학교 도메인 설정을 완료하고 서버를 재시작한다. 학교 인증 사용자로 `/fortune`에 접근한다.
4. 입력과 계산용 성별·시간대를 확인하고 HRUM 전송 동의 후 계산한다. `source: provider`, `provider: hrum`, `schemaVersion: fortune_v2`인지 확인한다. 미상 생시는 3주, 입력한 생시는 4주다.
5. ‘추천에 사용할 3주 분석 준비’는 B 입력을 별도로 계산한다. 4주 상세와 3주 계산은 최대 두 번의 공급자 호출이다. 같은 3주 입력이 5분 캐시에 있으면 재사용한다. 추천·DB 저장은 실행하지 않는다.
6. 로그에 키·출생정보·raw body를 출력하지 않는다. 키를 비우면 `not_ready`, 실제 장애는 `error`이며 mock으로 전환하지 않는다.

키 없이 재현할 검증은 `pnpm test`다. `tests/fixtures/hrum/`에는 guest 실측 응답 중 사용하는 필드만 남겼고, 테스트는 이를 주입한 fetch로 검증하여 외부 호출·과금을 발생시키지 않는다. UI 기본값 `SAJU_PROVIDER=mock`은 입력과 무관한 개발 샘플이며 실제 분석이 아니다.

## 입력과 계산 기준

`FortuneInput`에는 birthDate, birthTime(미상 null), calendar, isLeapMonth, timezone, providerSex, calculationOptions, consent:true가 있다. HRUM 전송에는 `externalProviderConsent: 'hrum_birth_data_v1'`도 필요하다. 사용자 ID는 검증된 로그인 컨텍스트에서 서버 인자로만 전달한다.

| 내부 입력 | HRUM 전송·처리 |
|---|---|
| 출생일·양음력·윤달 | year/month/day/calendar/isLeapMonth. 음력·윤달 실재 검증은 공급자가 수행 |
| 생시 입력 | hour/minute, birthTimePrecision:exact |
| 생시 미상 | hour/minute 생략, birthTimePrecision:unknown. 임의 시주 생성 금지 |
| 계산용 성별 | male/female 필수. unspecified는 네트워크 호출 전 not_ready; 만남 선호와 별개 |
| 날짜 경계 provider_default | zaSiRule:traditional, 23시부터 다음 날 기준. 응답 dayBoundary:zi_hour_start |
| 날짜 경계 civil_midnight | zaSiRule:yajaSi, 23시에도 같은 날. 응답 dayBoundary:civil_midnight |
| 날짜 경계 late_zi | 명칭 의미가 모호하여 지원하지 않으며 not_ready |
| 시각 보정 provider_default/none | 위치·국가 미전송, 진태양시 보정 없음. 공급자 표준 시간대/DST 규칙까지 끈다는 뜻은 아님 |
| 시간대 | IANA 시간대 전송. 공급자의 fallback 경고가 있으면 결과 거부 |

외부로 UUID·이메일·이름·동의 토큰·지문 키를 보내지 않는다. 출생정보는 URL 대신 POST body에 포함한다. 양력 날짜는 실재 여부를 검증하며 1900년 이후 입력 범위는 성인 자격 확인을 대신하지 않는다. 언어는 ko로 고정한다.

## 반환과 정규화

`FortuneResult`는 ready/not_ready/error다. ready에는 source, provider, **adapter 버전**인 providerVersion, providerEngineVersion:null, schemaVersion:fortune_v2, inputFingerprint, calculatedAt, cached, persistence:not_persisted를 포함한다. HRUM이 엔진 버전을 반환하지 않으므로 adapter 버전을 엔진 버전이라고 부르지 않는다.

- 원국: 천간·지지를 고정 내부 코드로 변환. 없는/알 수 없는 코드는 거부.
- 오행: 표면 6/8글자 개수, 단위 surface_character_count. 가중 세력 백분율이 아님. 합과 용신 elementStates count를 교차 검증.
- 용신: primary, secondary, 선정 method와 원문 providerMethod, 오신 roles, 억부·조후 용신, reasoning, 오행 상태. 누락 분석은 null; 미등록 선정 방법은 unmapped.
- 강약: score(-100~100)의 공급자 원점수, strong/weak/balanced와 원문 분류·level, season/support/control/hidden/root 근거, 통근 여부·점수. 임계값으로 분류를 재생성하지 않으며 근거 합계를 총점으로 간주하지 않는다.
- 파생값의 chartBasis를 명시한다. 일간·시주 유무·3주 표식·오행 합·주용신 일치를 검사한다. 뜻밖의 진태양시 보정이나 경고가 있으면 거부한다.

응답은 필요한 필드만 투영하고 원본 출생일·키·raw response를 반환하지 않는다. 부가 운세·성격 내용은 수집하지 않는다. 정규화 원국 자체도 비공개 개인 데이터이므로 공개 프로필에 복사하지 않는다. 응답 상한은 2MiB, 기본 timeout은 8초이며 오류 본문은 노출하지 않는다.

## 서버 사용과 B 경계

```ts
import { getCurrentUserId } from '@/lib/auth/get-current-user-id';
import { getFortuneServiceOptions } from '@/features/fortune/configured';
import { calculateFortuneForMatching } from '@/features/fortune/matching-input';

const userId = await getCurrentUserId();
if (!userId) throw new Error('Authentication required');
// 호출 기능의 학교/프로필/성인/동의 자격도 별도 검사한다.
const input = await calculateFortuneForMatching(requestBody, getFortuneServiceOptions(userId));
// ready도 궁합 점수/매칭 완료는 아니다.
```

`calculateFortuneForMatching`은 생시를 null로 하여 전체 3주 분석을 재계산하고 mock·4주·누락·미등록 분석을 거부한다. [B 연결 계약](FORTUNE_MATCHING_CONTRACT.md)에 타입·비교키·저장 경계를 정의했다. 승인 규칙 없는 hybrid는 계속 not_ready이며 legacy 문이과 데모와 혼합하지 않는다.

실제와 mock의 메모리 캐시는 최대 128건/5분, 동시 동일 요청은 같은 프로세스·provider 인스턴스 안에서 합친다. 키는 사용자 UUID·입력·동의 버전·옵션·공급자/스키마 버전에 대한 HMAC-SHA256이며 권한 증명이 아니다. 외부 전송 동의는 캐시 조회 전에도 검사한다. 실패는 정상 결과로 캐시하지 않는다.

재시작·다중 인스턴스·만료 이후는 중복 과금 방지 범위 밖이다. 128개 진행 중 요청 제한은 사용자별 시간당 호출 쿼터가 아니므로 서로 다른 입력을 연속 호출하는 비용 제한은 운영 연결 전 별도로 추가해야 한다. B는 비공개 소유자 저장/RLS, 동의 버전·시각 기록, 분산 요청 중복 방지, 만료/삭제·계산 버전 갱신 정책을 연결해야 한다. 임의 idempotency header만으로 HRUM 과금 중복을 막았다고 주장하지 않는다. 이 A 작업에서는 운영 DB를 변경하지 않았다.
