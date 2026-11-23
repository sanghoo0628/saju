# Supabase 설정과 마이그레이션

현재 SQL은 총 7개입니다. 기존 6개와 `20261123000100_birth_input_and_analysis.sql`을 함께 사용합니다. B가 공유 개발 DB에 적용한 이력과 C 호환성은 [통합 검증 기록](../docs/C_B_PROFILE_INTEGRATION_2026-11-23.txt)에서 확인할 수 있습니다.

## CLI 로컬 설정

`config.toml`은 로컬 Supabase용 설정입니다. 이 파일을 커밋했다고 공유 개발 DB나 앱의 환경 변수가 자동으로 바뀌지는 않습니다.

- 프로젝트 식별자: `saju`
- API 포트: `54321`, DB 포트: `54322`, shadow DB: `54320`
- Studio: `54323`, 테스트 메일 서비스: `54324`
- PostgreSQL 메이저 버전: `17` (공유 개발 DB를 읽기 전용으로 조회해 일치 확인)
- Auth 기본 사이트: `http://localhost:3000` (`.env.example`의 앱 주소와 동일)
- 추가 허용 주소: `http://127.0.0.1:3000`
- seed 실행: 비활성. 현재 `seed.sql`이 없으므로 seed 경로도 비워 두었습니다.

사이트 URL은 Auth의 링크와 리다이렉트 기준이고 seed 설정은 DB 시작/초기화 시 데이터 주입을 제어합니다. 키의 의미는 [공식 CLI 설정 문서](https://supabase.com/docs/guides/local-development/cli/config)를 참고하세요.

이번에는 TOML 구문·주소·seed·포트를 확인했습니다. CLI 로컬 서비스의 실제 시작, 로컬 Auth/Storage/Realtime 전체 흐름은 검증하지 않았습니다. 앱은 기존 공유 Supabase 개발 프로젝트 연결을 유지하며, 로컬 Supabase로 전환하려면 별도 환경 변수와 키 형식·DB TLS 설정을 함께 맞춰야 합니다.

`.temp`, `.branches`, 로컬 환경 파일은 Git에서 제외합니다. 실제 비밀 키나 테스트 사용자 정보는 이 설정 파일에 넣지 않습니다.

## 테스트와 연결 상태

`pnpm test`는 임시 PGlite와 모의 인증 구조로 7개 SQL 및 앱/모듈을 검증합니다. `pnpm test:postgres`는 별도 native PostgreSQL 다중 연결 검사이며 GitHub CI에서 실행합니다. 이 두 명령은 CLI 로컬 스택을 시작하지 않습니다.

공유 개발 DB 메타데이터·C 읽기 쿼리만 점검하려면 실제 환경 파일이 준비된 작업 폴더에서 다음을 실행합니다.

```bash
C_READONLY_QA_PROJECT_REF=acghfykdtorpxkbmknja pnpm verify:supabase:readonly
```

사주 입력 저장 동의와 A의 `recordBirthInput`/`recordMatchingAnalysis` 연결은 남아 있습니다. [B 계약서 9장](../docs/CONTRACT_profile_matching.md)을 기준으로 연결합니다. 기존 C의 대상별 500원 주문, 무료 수락, 수락 후 채팅 규칙은 유지합니다.
