# 🔮 (앱 이름) — 대학생을 위한 사주·타로 앱

> 한 줄 소개: 학기 일정에 맞춘 운세, 친구·조원 궁합, 타로를 한 곳에서.

## 👥 팀원 & 역할

| 이름 | GitHub | 담당 |
|---|---|---|
| 김상후 | @(아이디) | (예: 사주·만세력 계산 로직) |
| (팀원2) | @(아이디) | (예: 프론트엔드 - 입력/결과 화면) |
| (팀원3) | @(아이디) | (예: 해석 생성(LLM), 궁합) |

## 🛠 기술 스택

- 프론트엔드: (예: React Native / Flutter / Next.js)
- 백엔드: (예: Node.js / FastAPI / Firebase)
- DB: (예: Supabase / Firestore)
- 기타: (예: LLM API, 만세력 라이브러리)

## 🚀 실행 방법

```bash
# 1. 레포 클론
git clone <레포 주소>
cd <레포 이름>

# 2. 환경변수 설정 (.env.example 복사 후 값 채우기)
cp .env.example .env

# 3. 패키지 설치
(예: npm install)

# 4. 실행
(예: npm run dev)
```

> ⚠️ API 키 값은 레포에 올리지 말고 팀 채팅으로 따로 공유합니다.

## 📁 폴더 구조

```
├── README.md
├── .gitignore
├── .env.example        # 환경변수 이름 목록 (값은 비움)
├── .github/
│   └── pull_request_template.md
├── docs/               # 기획서, 명세 문서
└── src/                # 소스 코드 (프레임워크 정해지면 수정)
```

## 🌿 브랜치 규칙

- `main` : 항상 실행되는 코드. **직접 push 금지**
- `feature/기능이름` : 기능 개발 (예: `feature/saju-calc`, `feature/tarot-ui`)
- `fix/버그이름` : 버그 수정

**작업 순서**
1. `main` 최신화: `git checkout main && git pull`
2. 브랜치 생성: `git checkout -b feature/기능이름`
3. 작업 후 커밋 & push: `git push origin feature/기능이름`
4. GitHub에서 Pull Request 생성 → 팀원 1명 이상 확인 → merge

## ✍️ 커밋 메시지 규칙

| 태그 | 의미 | 예시 |
|---|---|---|
| `feat:` | 새 기능 | `feat: 사주 입력 화면 추가` |
| `fix:` | 버그 수정 | `fix: 윤달 계산 오류 수정` |
| `docs:` | 문서 수정 | `docs: README 실행 방법 추가` |
| `style:` | 코드 포맷, 세미콜론 등 (동작 변화 없음) | `style: 들여쓰기 정리` |
| `refactor:` | 리팩토링 | `refactor: 오행 계산 함수 분리` |
| `chore:` | 설정, 패키지 등 | `chore: eslint 설정 추가` |

## 📌 주요 기능 (MVP)

- [ ] 사주 입력 (생년월일, 양/음력, 윤달, 시간, 성별)
- [ ] 만세력 변환 → 사주팔자 명식표
- [ ] 오행 분포 / 풀이 카드
- [ ] 궁합 (연인·친구·조원)
- [ ] 타로 (원카드 / 쓰리카드)
- [ ] 결과 공유 카드

## 📄 문서

- 기획서: [`docs/`](./docs)
