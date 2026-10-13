# 원의 현 탐구 — 실시간 학급 버전

중학교 3학년 `Ⅳ-2.(1) 원과 현` 공개수업용 실시간 웹앱입니다.

## 핵심 기능

### 교사
- 익명 인증으로 수업방 생성
- 6자리 입장 코드와 QR 제공
- 학생 입장 수 실시간 확인
- 학생 가설 실시간 집계
- AI로 가설 의미 분류
- AI 분류 결과를 학생 화면에 공개/숨기기
- 수업 단계 원격 제어
  - ① 조작·관찰
  - ② 가설 제출
  - ③ 가설 검증
  - ④ 증명·형성평가
- AI 장애 시 로컬 분류 자동 대체

### 학생
- 방 코드 + 번호/별칭으로 입장
- 현을 직접 드래그하여 거리·방향 변화
- 관찰 기록
- 학생당 가설 1개 제출/수정
- 교사가 공개한 AI 분류 결과 확인
- 두 현을 독립적으로 움직여 가설 검증
- 증명 흐름 완성
- 지니아튜터 형성평가 링크 이동

---

# 1. Supabase 만들기

Supabase에서 새 프로젝트를 생성합니다.

## Anonymous Sign-In 켜기

Dashboard에서 Anonymous Sign-In을 활성화합니다.

이 앱은 이메일이나 이름을 수집하지 않고, 각 기기를 익명 인증 사용자로 사용합니다.

## SQL 실행

Supabase `SQL Editor`에서 아래 파일 전체를 실행합니다.

`supabase/schema.sql`

이 SQL은 다음을 만듭니다.

- `class_sessions`
- `participants`
- `hypotheses`
- RLS 정책
- 수업방 생성 RPC
- 수업방 입장 RPC
- Realtime publication 설정

---

# 2. GitHub Pages 설정

`config.js`를 수정합니다.

```js
export const CONFIG = {
  SUPABASE_URL: "https://xxxx.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_xxxx",
  AI_ENDPOINT: "",
  GENIA_TUTOR_URL: ""
};
```

Supabase의 **Publishable Key**만 사용합니다.

절대로 다음 값은 GitHub에 넣지 마세요.

- Supabase `service_role` key
- OpenAI API key

## GitHub에 업로드

저장소 루트에 프로젝트 파일을 그대로 업로드하고:

`Settings → Pages → Deploy from a branch → main / root`

로 설정합니다.

---

# 3. AI 없이 먼저 테스트

`AI_ENDPOINT`를 빈 문자열로 둔 채 먼저 테스트하세요.

이 상태에서도:
- 실시간 학생 입장
- 실시간 가설 제출
- 단계 전환
- 수학 탐구
- 증명 활동

은 모두 작동합니다.

교사가 `AI로 가설 묶기`를 누르면 간단한 로컬 분류가 작동합니다.

공개수업 당일에도 AI 연결이 실패하면 자동으로 이 모드로 전환됩니다.

---

# 4. 실제 AI 분류 연결

AI 분류는 브라우저에서 OpenAI API를 직접 호출하지 않습니다.

`cloudflare-worker/` 폴더의 Worker가 중간 서버 역할을 합니다.

장점:
- OpenAI API 키가 학생 브라우저나 GitHub에 노출되지 않음
- 교사 Supabase JWT를 확인
- 교사가 소유한 수업방의 가설만 읽음
- 학생 별칭은 OpenAI에 보내지 않고 가설 문장만 전송

## Worker 설정

`cloudflare-worker/wrangler.toml`에서 다음을 바꿉니다.

```toml
SUPABASE_URL = "https://xxxx.supabase.co"
SUPABASE_PUBLISHABLE_KEY = "sb_publishable_xxxx"
ALLOWED_ORIGIN = "https://YOUR_GITHUB_ID.github.io"
```

OpenAI API 키는 Secret으로 등록합니다.

```bash
npx wrangler secret put OPENAI_API_KEY
```

배포:

```bash
npx wrangler deploy
```

예를 들어 Worker 주소가

```text
https://circle-hypothesis-ai.example.workers.dev
```

라면 `config.js`에:

```js
AI_ENDPOINT: "https://circle-hypothesis-ai.example.workers.dev/cluster"
```

를 입력합니다.

---

# 5. 지니아튜터 형성평가 연결

형성평가 URL이 준비되면 `config.js`에 입력합니다.

```js
GENIA_TUTOR_URL: "https://..."
```

그러면 학생의 ④ 증명·형성평가 화면에서
`지니아튜터 형성평가 시작` 버튼이 활성화됩니다.

---

# 6. 수업 당일 운영 순서

1. 교사 `teacher.html` 접속
2. `새 수업방 만들기`
3. QR/방 코드 제시
4. 학생 `student.html` 입장
5. 교사 ① 조작·관찰 단계
6. 교사 ② 가설 제출 단계로 변경
7. 학생 각자 가설 제출
8. 교사 화면에서 실시간 가설 확인
9. `AI로 가설 묶기`
10. 분류 기준을 학급과 검토
11. 필요하면 `분류 결과 학생에게 공개`
12. ③ 가설 검증 단계
13. ④ 증명·형성평가 단계
14. 지니아튜터 형성평가

---

# 개인정보 / 운영 권장

- 학생 실명 대신 번호 또는 별칭 사용 권장
- AI에는 학생 별칭을 전송하지 않음
- 수업 종료 후 가설 초기화 또는 수업방 종료
- Anonymous Auth 사용 시 브라우저 저장공간을 지우면 해당 기기의 익명 계정이 달라질 수 있음
- 공개수업 전날 교사용 기기에서 수업방 생성/복구 테스트 권장
- 학생이 많은 환경에서 Supabase Realtime 설정과 RLS를 미리 테스트

---

# 파일 구조

```text
circle-chord-classroom-live/
├─ index.html
├─ teacher.html
├─ student.html
├─ style.css
├─ config.js
├─ js/
│  ├─ supabase-client.js
│  ├─ geometry.js
│  ├─ teacher.js
│  └─ student.js
├─ supabase/
│  └─ schema.sql
└─ cloudflare-worker/
   ├─ worker.js
   └─ wrangler.toml
```
