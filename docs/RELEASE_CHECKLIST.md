# 운영 준비 체크리스트

운영 Supabase 프로젝트와 운영 Vercel 배포를 만들 때 이 순서대로 확인합니다.
개발 검증 환경은 saju-dev + https://saju-ebon-psi.vercel.app 입니다. 아래 항목 전체가 완료됐다는 뜻은 아니며, 실제 준비 여부를 확인해 체크합니다.
실제 키·비밀번호는 이 문서, PR, 단체방에 적지 않습니다.

담당: A = 우민, B = 상후, C = 정우

## 1. Supabase 프로젝트 (B)

- [ ] 새 프로젝트 생성. 지역은 Vercel 함수 지역(`vercel.json` 의 `sin1`, 싱가포르)과 가까운 곳
- [ ] 마이그레이션 9개 적용. 기존 파일은 고치지 않고 새 파일만 추가합니다.
  ```bash
  npx supabase link --project-ref <운영 프로젝트 ref>
  npx supabase db push --dry-run   # 9개가 나오는지 확인
  npx supabase db push
  npx supabase migration list      # local·remote 9개 일치 확인
  ```
  | 파일 | 내용 |
  |---|---|
  | `20261116000100_profiles_and_private_data` | 프로필, 생년월일(비공개), 점수 |
  | `20261116000200_orders_and_matches` | 무료 추천, 상대별 주문 |
  | `20261116000300_chat` | 대화 요청, 채팅방, 메시지 |
  | `20261116000400_access_rls` | RLS·권한, `messages` Realtime 등록 |
  | `20261116000500_matching_functions` | 추천 계산 함수 |
  | `20261116000600_storage_profile_photos` | `profile-photos` 버킷과 정책 |
  | `20261123000100_birth_input_and_analysis` | 음력 입력·저장 동의·3주 분석, 사진 5MB·이미지 3종 제한 |
  | `20261125000100_groble_event_inbox` | 비공개 결제 이벤트·전송·환불 원장 |
  | `20261125000200_groble_events_updated_at` | 이벤트 상태/연결 주문 변경 시각 |
- [ ] 이 브랜치의 파일은 9개입니다. 다른 팀의 후속 파일이 추가되면 개수와 순서를 다시 확인합니다. saju-dev는 최근 읽기 전용 검사에서 `001`까지 적용, `002` 미적용으로 확인됐습니다. 기존 적용 파일을 수정하지 않고 후속 파일로 적용합니다.
- [ ] **Database → Publications** 에서 `supabase_realtime` 에 `messages` 가 들어 있는지 확인 (채팅 실시간 수신)
- [ ] **Storage** 에 `profile-photos` 버킷이 비공개로 있는지 확인
- [ ] **Database → Settings → SSL Configuration** 에서 CA 인증서 다운로드 → Vercel `DATABASE_SSL_CA_PEM` 에 사용
- [ ] 연결 문자열은 **Connect → Transaction pooler**(포트 6543) 값을 `DATABASE_URL` 에 사용

## 2. 로그인 메일 (A, B)

- [ ] **Authentication → Emails → SMTP Settings**: 발송 전용 서비스(Resend, Brevo 등) 연결. 개발용 개인 Gmail은 운영에 쓰지 않습니다.
- [ ] **Templates**: `Magic link or OTP`, `Confirm sign up` 두 양식 모두 본문에 `{{ .Token }}` 이 있어야 합니다. 앱은 링크가 아니라 숫자 코드로 로그인합니다.
- [ ] **Sign In / Providers → Email**: OTP 유효 시간 `600`초(메일 문구의 "10분"과 일치). 코드 길이는 6~10자리면 앱이 받습니다.
- [ ] **Rate Limits**: 메일 발송 한도를 예상 가입자 수에 맞게 설정(개발은 시간당 30통). 같은 사용자 재발송 간격 60초
- [ ] **URL Configuration**: Site URL = 운영 주소, Redirect URLs 에 운영 주소 추가
- [ ] 실제 학교 메일로 코드 수신(스팸함 포함)과 로그인 확인

## 3. Vercel 프로젝트 (B)

- [ ] 저장소 `sanghoo0628/saju` 를 가져와 `app`(Next.js, 루트 `./`)만 배포. `packages/payment-chat-ui`(Vite 데모)는 가져오지 않습니다.
- [ ] 빌드·설치 명령은 `vercel.json` 이 정합니다. 화면의 "Overridden" 표시는 정상입니다.
- [ ] Supabase 통합(Add) 버튼은 누르지 않습니다. 환경 변수를 덮어쓸 수 있습니다.
- [ ] 첫 배포 후 대표 주소를 `NEXT_PUBLIC_APP_URL` 에 넣고 **Build Cache 없이** Redeploy
- [ ] 접속은 대표 주소로만 합니다. 배포별 주소(`saju-xxxx-….vercel.app`)는 Origin 검사에 막힙니다.

### 환경 변수 (Production)

| 이름 | 값 | 종류 | 담당 |
|---|---|---|---|
| `APP_ENV` | `production` (Vercel Production 에서는 다른 값이면 설정 오류) | Config | B |
| `NEXT_PUBLIC_APP_URL` | 운영 대표 주소, 끝에 `/` 없음 | Config | B |
| `NEXT_PUBLIC_SUPABASE_URL` | 운영 Supabase URL | Config | B |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_` 로 시작 | Config | B |
| `SUPABASE_SECRET_KEY` | 서버 비밀 키 | Secret | B |
| `DATABASE_URL` | Transaction pooler 연결 문자열 | Secret | C |
| `DATABASE_SSL_CA_PEM` | 1단계에서 받은 CA 인증서 전체 | 둘 다 가능 | C |
| `ALLOWED_EMAIL_DOMAINS` | `korea.ac.kr` | Config | A |
| `MATCHING_STRATEGY` | `legacy_demo_v1` | Config | B |
| `SCORE_HMAC_SECRET` | 32자 이상. **한 번 정하면 바꾸지 않습니다.** 바꾸면 새로 만드는 점수만 기준이 달라집니다. | Secret | B |
| `SAJU_PROVIDER` | `hrum` (운영에서 `mock` 금지) | Config | A |
| `SAJU_API_KEY`, `SAJU_FINGERPRINT_SECRET` | HRUM 운영 키, 지문 비밀값 32자 이상 | Secret | A |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` (pnpm 11.25.0 사용) | Config | B |
| `PAYMENTS_ENABLED` | `false` (Groble 연동·검증 완료 전까지) | Config | C |
| `GROBLE_PAYMENT_URL`, `GROBLE_PRODUCT_ID`, `GROBLE_WEBHOOK_SECRET` | Groble 판매자 준비 후 | Secret | C |

`NEXT_PUBLIC_` 으로 시작하는 값은 브라우저에 노출되므로 Secret 으로 저장할 수 없습니다(Config 로 저장).

## 4. 배포 규칙 (전원)

- Vercel 무료(Hobby) 플랜은 비공개 저장소에서 **Vercel 프로젝트 주인의 커밋만 배포**합니다.
  - main 머지는 주인(B)이 **Create a merge commit** 으로 합니다. Squash 머지는 커밋 작성자가 PR 작성자로 남아 배포가 막힙니다.
  - 다른 팀원 PR 의 미리보기 배포는 막힙니다. 필요하면 Pro 팀 또는 저장소 공개를 검토합니다.
- 환경 변수를 바꾼 뒤에는 Redeploy 해야 적용됩니다. `NEXT_PUBLIC_` 값은 빌드에 들어가므로 Build Cache 를 끄고 Redeploy 합니다.

## 5. 공개 전 확인 (전원)

- [ ] 실제 학교 계정: 로그인 → 사주(HRUM) → 매칭용 저장 동의 → `/profile` 저장 → `/matches` 무료 추천
- [ ] 두 계정: 대화 요청 → 수락 → `/chat` 실시간 송수신, 차단
- [ ] C 준비 코드 병합만으로 결제가 켜지지는 않습니다. 현재 런타임·공통 환경 검증의 비활성 가드는 유지됩니다. `C_GROBLE_MODULE_2026-11-25.txt`에 따라 정책 합의·키/DB 준비·런타임 연결·테스트 발송을 별도로 확인합니다.
- [ ] `C_GROBLE_READONLY_PROJECT_REF=<운영 ref> pnpm verify:groble:readonly`로 DB 준비 상태와 `attentionRequired`를 확인합니다. 이 결과가 결제 활성화/E2E 완료를 뜻하지는 않습니다.
- [ ] Groble 500원 테스트 결제 → 주문 확정 → 요청 → 수락 → 채팅, 실패·환불 흐름 (C)
- [ ] 계약서 8장 팀 결정 반영 (`docs/CONTRACT_profile_matching.md`)
- [ ] 개발 DB 테스트 계정·데이터가 운영 DB 에 없는지 확인
