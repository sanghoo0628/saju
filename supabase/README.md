# B 통합 전 데이터 경계

A는 Supabase Auth 클라이언트만 연결했습니다. 현재 `supabase/migrations`에 실행할 SQL은 없고 DB/RLS 완료를 주장하지 않습니다. DB 담당 B와 C의 기존 migration을 받아 통합하기 전 빈 테이블이나 가짜 성공 RPC를 만들지 않습니다. 운영 DB에 실행한 명령은 없습니다.

2026-11-18: 팀 저장소 sanghoo0628/saju의 기존 6개 migration과 C pg 어댑터를 원격에서 확인했습니다. 기존 SQL은 보존하며 HRUM 저장·legacy 점수 분리는 B의 추가 migration 대상입니다. 상세는 [A·B·C 통합 설계](../docs/A_BC_INTEGRATION_DESIGN.md)를 따릅니다. DATABASE_URL을 템플릿에 추가했지만 A 앱이 DB 연결이나 migration을 자동 실행하지는 않습니다.

## B가 제공해야 할 연결

- `profiles`와 `private_birth_data`/`fortune_results` 분리. 비공개 원본·이메일·생일은 공개 DTO 제외.
- 현재 사용자 자격(활성, 성인 확인, 학교 확인, 소개 동의, 프로필 완성)을 확인하는 서버 조회. A의 `/api/me`는 아직 `profileStatus=not_connected`, `eligibilityStatus=not_ready`.
- 추천 배치는 무료 열람 3명으로 주문과 독립. 기존 `paid+fulfilled -> profile reveal` 정책은 폐기.
- C의 주문/대상별 권한/요청/채팅 migration 통합. auth.users.id UUID FK, 정렬된 참여자쌍 고유 제약, 이벤트/메시지 멱등성.
- 노출 schema에 RLS, 필요한 최소 GRANT. 프로필/사진/메시지의 본인·후보·수신자·참여자 권한을 별도로 검증. 관리자 클라이언트로 RLS 검증 금지.
- 사주 저장 adapter는 검증된 userId를 별도로 받고 소유자 조건/RLS로 저장·조회. fingerprint/공급자/옵션 버전 보존. 영구 보관/삭제 기간을 먼저 확정.

## 재현 가능한 통합 테스트 계정 절차

1. 팀이 지정한 개발 Supabase 프로젝트와 B의 migration 버전을 기록합니다. 로컬 CLI는 `supabase --help` 및 해당 명령 도움말로 버전을 확인하고 migration을 적용합니다. 운영 프로젝트를 기본 대상으로 삼지 않습니다.
2. 실제로 수신 가능한 승인 도메인의 테스트 메일 3개(Alice, Bob, Eve)를 준비합니다. A의 `/login`에서 OTP로 로그인해 각각 `GET /api/me`의 UUID를 기록합니다. 임의 UUID를 세션으로 주입하지 않습니다.
3. B가 제공하는 seed를 **기록한 UUID**에 적용해 동의/활성/성인/선호가 준비된 테스트 프로필과 후보 3명 이상을 만듭니다. 추천 3명 검증에는 추가 후보 계정도 필요합니다. 계정·출생정보는 실제 이용자 데이터를 복사하지 않습니다.
4. 서로 다른 브라우저 프로필로 본인/타인 정보, 무료 추천과 private 사진, 미인증 조회를 검사합니다. 사용자 토큰으로 직접 REST/Storage 접근도 확인합니다.
5. C 연결 후 대상별 권한·중복 주문/웹훅·무료 수락·방 중복 방지·제3자 메시지 접근·환불 역순·재접속을 [TEAM_CONTRACT.md](../docs/TEAM_CONTRACT.md)의 기준대로 실행합니다.
6. 실제 사주 원문·토큰·비밀키를 로그나 테스트 산출물에 남기지 않습니다. 테스트 계정 정리 시 채팅/결제 보존 정책을 B/C와 먼저 확인합니다.

이 절차는 외부 설정 이후 실행해야 하며 이번 A 로컬 검증에서는 수행하지 않았습니다.
