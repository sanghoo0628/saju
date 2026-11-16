# 🔮 고려대학교 사주 매칭 웹

> 무료로 사주 풀이와 본인 점수를 확인하고, 점수 합이 0에 가까운 상대 3명의 프로필을 무료로 봅니다. 마음에 드는 상대를 골라 500원을 결제하면 대화를 요청할 수 있고, 상대가 수락하면 웹에서 일대일 채팅을 진행합니다.

```
무료 추천 3명 공개 → 상대 1명 선택 → 그 상대에 대해 500원 결제 → 대화 요청 → 상대 수락(무료) → 채팅
```

- 매칭 규칙: 생년월일에 대응하는 고정 숫자(1~10,000), 문과는 양수·이과는 음수, `abs(내 점수 + 상대 점수)`가 작은 순으로 상위 3명.
- 점수는 실제 사주 풀이와 별개인 **오락용 매칭 규칙**이며 같은 입력의 점수는 유지됩니다.
- 결제는 상대당 500원입니다. 상대의 수락·답장은 무료이며 대화 성사를 보장하지 않습니다.
- 개발 계획 PDF(v1.0)의 "500원 결제 후 프로필 3명 공개"는 2026-11-16에 위 흐름으로 바뀌었습니다.

## 👥 팀원 & 역할

| 역할 | 이름 | GitHub | 담당 |
|---|---|---|---|
| A | (팀원) | @(아이디) | 가입과 사주 결과 — 공통 UI, 학교 이메일 인증, 입력 폼, 사주 API 어댑터·캐시, 무료 결과 화면, 배포 설정 |
| B | 김상후 | @sanghoo0628 | 프로필과 매칭 — DB 스키마·마이그레이션 통합, 프로필·사진 정책, 고정 점수, 후보 필터·무료 추천, RLS |
| C | (팀원) | @(아이디) | 결제와 채팅 — 상대별 500원 주문·Groble 웹훅, 결제 확인 화면, 취소·환불, 대화 요청·수락, Realtime 채팅, 차단·신고 UI |

## 🛠 기술 스택

- 웹/서버: Next.js (화면 + 서버 API)
- 인증·DB·사진·실시간: Supabase (Auth, Postgres + RLS, Storage, Realtime)
- 결제: Groble (결제 링크 + 웹훅)
- 사주: 기존 사주 프로그램 (HTTP API로 서버에서 호출)

사주 호출·점수 계산·매칭·주문 검증은 **서버에서만** 수행합니다. 브라우저의 Supabase 접근은 RLS가 허용한 본인 정보와 채팅 데이터로 제한합니다.

## 🚀 실행 방법

```bash
# 1. 레포 클론
git clone https://github.com/sanghoo0628/saju.git
cd saju

# 2. 환경변수 설정 (.env.example 복사 후 값 채우기)
cp .env.example .env

# 3. 패키지 설치
npm install

# 4. 테스트 (점수·매칭 로직 + DB 마이그레이션/RLS)
npm test
```

> Windows에서 테스트가 `Cannot read properties of undefined (reading 'config')`로 실패하면 터미널 경로의 드라이브 문자가 소문자(`c:\`)인 경우입니다. `C:\`로 연 터미널에서 실행하세요.
>
> Next.js 앱 골격은 A가 추가합니다. 추가되면 `npm run dev` 실행 방법을 여기에 적습니다.
>
> ⚠️ API 키 값은 레포에 올리지 말고 팀 채팅으로 따로 공유합니다. 특히 `SUPABASE_SERVICE_ROLE_KEY`, `SCORE_HMAC_SECRET`, `GROBLE_WEBHOOK_SECRET`은 서버 전용이며 `NEXT_PUBLIC_` 접두사를 붙이면 안 됩니다.

## 📁 폴더 구조

```
├── README.md
├── .env.example          # 환경변수 이름 목록 (값은 비움)
├── .github/
│   └── pull_request_template.md
├── docs/                 # 기획서, API 계약, DB 설계 문서
├── supabase/
│   └── migrations/       # DB 변경 파일 (각자 작성 → B가 통합)
├── src/
│   ├── contracts/        # 팀 공유 API 요청/응답 타입
│   ├── lib/              # 서버 공통 로직 (점수, 매칭)
│   └── server/           # 서버 업무 로직 (프로필, 무료 추천 조회)
└── tests/                # 단위 테스트, DB(RLS) 테스트 (tests/db 는 PGlite 사용)
```

## 🌿 브랜치 규칙

- `main` : 항상 실행되는 코드. **직접 push 금지**
- `feature/기능이름` : 기능 개발 (예: `feature/b-db-matching`, `feature/groble-webhook`)
- `fix/버그이름` : 버그 수정

**작업 순서**
1. `main` 최신화: `git checkout main && git pull`
2. 브랜치 생성: `git checkout -b feature/기능이름`
3. 작업 후 커밋 & push: `git push origin feature/기능이름`
4. GitHub에서 Pull Request 생성 → 팀원 1명 이상 확인 → merge

DB 변경은 각자 담당 영역의 마이그레이션 파일을 작성하고 B가 통합합니다. 공통 스키마 변경은 팀에 공유합니다.

## ✍️ 커밋 메시지 규칙

| 태그 | 의미 | 예시 |
|---|---|---|
| `feat:` | 새 기능 | `feat: 거리순 추천 함수 추가` |
| `fix:` | 버그 수정 | `fix: 차단 계정 후보 제외 누락 수정` |
| `docs:` | 문서 수정 | `docs: API 계약 갱신` |
| `style:` | 코드 포맷 등 (동작 변화 없음) | `style: 들여쓰기 정리` |
| `refactor:` | 리팩토링 | `refactor: 점수 계산 함수 분리` |
| `chore:` | 설정, 패키지 등 | `chore: vitest 설정 추가` |

## 📌 첫 버전 기능 (MVP)

- [ ] 가입 및 학교 이메일 인증 (A)
- [ ] 생년월일·문이과 입력 → 사주 풀이와 고정 점수 (A + B)
- [ ] 프로필 등록 및 공개 동의, 사진 (B)
- [ ] 무료 추천 3명 열람 (B)
- [ ] 상대 선택 → 상대당 500원 결제 및 서버 확인 (C + B)
- [ ] 대화 요청 및 수락 → 일대일 텍스트 채팅 (C)
- [ ] 차단·신고 (C + B)

후순위: 사진 전송, 읽음 표시, 입력 중 표시, 푸시 알림.

## 📄 문서

- 개발 계획: [`docs/`](./docs)
- 프로필·매칭 계약 (B ↔ C, DB 설계 포함): [`docs/CONTRACT_profile_matching.md`](./docs/CONTRACT_profile_matching.md)
