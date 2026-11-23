# A 구현 상태와 검증 기록

기준일: 2026-11-16. 이 표는 A 범위의 결과다. 전체 P0 결제·채팅·DB 통합 완료 보고서가 아니다. 상품 기준은 [DECISIONS.md](DECISIONS.md), 팀 연결 계약은 [TEAM_CONTRACT.md](TEAM_CONTRACT.md)를 따른다.

2026-11-18 재설계 업데이트: 실제 팀 저장소 `c098404`와 후속 `b4cdf40`의 B/C 코드·계약을 확인했다. C 원본 공유 타입/재수출, DATABASE_URL·SCORE_HMAC_SECRET 템플릿, A test:a 경계, noUncheckedIndexedAccess·allowImportingTsExtensions를 반영했다. [통합 설계](A_BC_INTEGRATION_DESIGN.md)에 구체적 조립·충돌·남은 작업을 기록했다. B/C 런타임 전체, pg 설치, migration 적용, 원격 반영은 수행하지 않았다.

재설계 후 `pnpm check`를 다시 실행해 lint·엄격 타입 검사·A 88개 테스트·Next 빌드가 모두 통과했다. 가져온 `contracts/payment-chat.ts`의 Git blob hash도 원격 원본 `e73c1fa282a4ab8137fd9828574ddae9a35a06b3`와 일치했다. 아래 HTTP·브라우저 검사는 이전 2026-11-16 검증 기록이며 이번 타입/설계 변경으로 재실행하지 않았다.

2026-11-22 리뷰 반영: 사주 계산 동시 요청을 사용자당 2건으로 제한(전체 128건 상한은 유지)하고 회귀 테스트를 추가했다. `/api/fortune`의 공급자 시간 초과는 504로 매칭 입력 API와 통일했다. lint·typecheck·A 89개 테스트·Next 빌드 통과. 시간당 호출 쿼터는 여전히 DB 연결 후 과제다. 팀 저장소 규칙에 맞춰 A README와 계획 문서는 `docs/`로 옮겼다.

## 상태표

| 영역 | 상태 | 범위와 남은 작업 |
|---|---|---|
| 공통 상품 상수/DTO | 구현 완료 | 무료 3명·상대당 500원, 공개 필드 투영, C 연결 제안 타입 |
| 기존 문서 충돌 기록 | 구현 완료 | 이전 과금 규칙의 교체 내역과 원문 안내 |
| Next.js/TypeScript/pnpm/Node 24 | 구현 완료 | 화면/스크립트/정확 버전/lockfile, 타입 검사·빌드 통과 |
| Supabase browser/server/admin 경계 | 구현 완료 | 요청별 쿠키, 갱신 proxy, server-only 관리자, 웹훅 제외 |
| 서버 `getCurrentUserId()` | 구현 완료 | 검증된 getUser UUID 또는 null; 실제 개발 프로젝트 검증은 외부 설정 필요 |
| 로그인/학교 이메일 확인 | 코드 완료·외부 설정 대기 | OTP 요청/검증/로그아웃, exact domain+confirmed 검사. 실제 메일 미발송 |
| 사주 입력/정규화/어댑터 | 구현 완료 | fortune_v2, 용신/강약/오행, 3주·4주 분리, timeout/실패, 사용자별 임시 캐시·동시 요청 병합 |
| 사주 mock | 목업 | 개발 전용 예시, 실제 명리 계산·궁합 아님 |
| HRUM 실제 API 어댑터 | 코드 완료·partner 설정 대기 | 공식 guest 3주/4주 응답 각 1건 확인. partner 키 인증·과금·로그인 후 전체 흐름 미검증 |
| A→B 매칭 입력 | 구현 완료 | calculateFortuneForMatching·별도 API·readonly DTO·비교키. 공통 3주 재계산, mock/누락/미등록 분석은 not_ready |
| 사주 데이터 영속 저장·운영 호출 한도 | 미연결·A/B 후속 | DB/RLS·동의 기록·삭제·분산 중복 방지·사용자별 시간당 호출 쿼터 필요. 현재 128건 제한은 동시 요청 상한 |
| DB 마이그레이션/RLS/사진 정책 | 미구현·B 담당 | A가 임의 스키마나 운영 DB를 만들지 않음 |
| 프로필 등록/추천/legacy 점수 | 미구현·B 담당 | 실제 후보/점수는 A가 생성하지 않음 |
| hybrid 사주 매칭 | 미구현·B 담당 | 승인 규칙과 입력 없으면 `not_ready` |
| 결제/권한/웹훅/채팅 | 미통합·C 담당 | 실제 원격 소스 확인. c098404 기본165개, b4cdf40 기본233+UI18개는 상위 보고이며 여기서 재실행하지 않음 |
| 활동/예약 P1/P2 | 미구현 | 최소 타입 경계, 파트너/API 없음 |
| 로컬 Git | 초기화 완료 | main 브랜치만 생성. 작성자 name/email 미설정으로 커밋하지 않음 |
| 원격 main 반영/배포 | 미실행 | 팀 저장소 URL 확인, 로컬 remote 설정·push·배포 안 함 |

## 실행한 검사

| 검사 | 결과 |
|---|---|
| 착수 전 코드·package.json·Git/remote 조사 | 문서만 있음, Git 저장소 아님 |
| 상위 AGENTS.md 확인 | 없음 |
| 런타임 확인 | Node 24.22.1, pnpm 11.25.0 |
| `pnpm install` / `pnpm peers check` | 성공 / peer 불일치 없음. lint 플러그인 호환을 위해 TS6·ESLint9 고정 |
| `pnpm lint` | 통과, warning 0 |
| `pnpm typecheck` | 통과, Next route typegen + tsc |
| `pnpm test` | 88/88 통과: 인증/학교/env 24, 사주 22, HRUM 18, HTTP 보안 10, B 매칭 입력 14 |
| `pnpm build` | 통과, 9개 화면과 7개 API 및 proxy 컴파일. /fortune은 서버 설정에 따라 동적 렌더링 |
| `pnpm check` | 최종 변경 후 lint·typecheck·88 테스트·build 모두 통과 |
| `pnpm test:http` | 15/15 통과: 화면, 명시적 mock, no-store, 기존·신규 사주 API 미설정503, 잘못된 Origin403, 미구현 webhook404 |
| 브라우저 | HRUM 키 없는 연결 대기·계산 버튼 비활성·성별 미선택·별도 전송 동의 확인. console warning/error 없음. 이전 기본 UI의 390px 검증은 완료했으나 이번 실제 결과 UI의 로그인 경로는 미검증 |
| 실제 Supabase 로그인/메일/RLS | 미실행: 개발 프로젝트/계정 미설정 |
| HRUM 공식 guest API | 가상 출생 입력의 3주·4주 총 2건 HTTP200/success. 같은 날짜라도 강약 원점수 -53/-66으로 달라 3주 재계산 필요 확인. 필요한 필드만 fixture 보관 |
| HRUM partner API·실제 로그인 후 계산 | 미실행: partner 키·개발 Auth 설정 없음. guest 검증과 구분 |
| Groble·예약 | 미실행, A 범위 밖 |

## 재현과 차단 요인

설치·실행·검사는 루트 [README.md](A_README.md)의 명령을 따른다. 키가 없는 로컬 실행과 실제 인증은 구분한다. B/C 통합 수용 테스트는 [TEAM_CONTRACT.md](TEAM_CONTRACT.md)에 있으며 실제 테스트 계정과 사용자 토큰이 필요하다.

원격 저장소 URL은 확인했으며 실제 통합 작업과 반영 커밋은 아직 없다. 실제 로그인에는 개발 Supabase 및 허용 학교 도메인이 필요하다. 사주 partner 연결에는 HRUM 키·fingerprint 비밀값과 호출 한도·운영 정책 설정이 필요하다. [FORTUNE_PROVIDER.md](FORTUNE_PROVIDER.md)에 연결 절차, [FORTUNE_MATCHING_CONTRACT.md](FORTUNE_MATCHING_CONTRACT.md)에 A 입력 계약을 정리했다. B의 legacy 점수 필수 저장 구조와의 차이는 새 통합 설계에 명시했다.

## 발견 후 수정한 항목과 검증 한계

- 최신 ESLint10/TS7 조합은 Next lint plugin의 peer 범위 밖이라 설치된 호환 범위 ESLint9.39.5/TS6.0.3으로 고정했다. ESLint9 지원 종료 경고는 남은 개발 도구 제약이다.
- OTP email schema의 Zod pipe 타입 오류 수정 후 typecheck 통과.
- 공개 앱 URL에서 개발 mock이 허용되던 설정을 로컬 주소 전용으로 제한하고 회귀 테스트 추가.
- 사주 메모리 캐시를 실제 인증 POST에 연결. 사용자 ID·입력·옵션·버전별 HMAC 키, 128건/5분, 영구 저장 아님.
- 비동기 캐시 조회의 늦은 miss가 같은 입력의 추가 호출을 발생시킬 수 있어 캐시 조회까지 진행 중 요청 병합에 포함하고 회귀 테스트를 추가했다.
- HRUM actual response를 정규화하되 공급자 엔진 버전 미공개·추가 입력의 연속 호출 비용·분산 중복 방지는 운영 한계로 남겼다. 4주 상세와 3주 준비는 별도 과금 요청일 수 있다.
- HTTP smoke의 CJS top-level await 실행 오류를 async main으로 수정 후 14개 통과.
- 실제 사용자 권한/RLS·동시 주문·환불·채팅 재접속은 B/C 미통합으로 미실행. A 단위 테스트를 이 검증의 대체로 주장하지 않는다.
