// 공개 저장소에 올려도 되는 값만 입력하세요.
// Supabase Publishable Key는 브라우저용 공개 키이며, 실제 권한은 RLS 정책이 보호합니다.
// 절대 service_role 키나 OpenAI API 키를 이 파일에 넣지 마세요.

export const CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_PUBLISHABLE_KEY: "",

  // Cloudflare Worker의 /cluster 전체 주소
  // 예: https://circle-hypothesis-ai.example.workers.dev/cluster
  AI_ENDPOINT: "",

  // 지니아튜터 형성평가 링크가 준비되면 입력
  GENIA_TUTOR_URL: ""
};
