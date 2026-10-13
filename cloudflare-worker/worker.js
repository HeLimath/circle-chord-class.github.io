/**
 * 교사용 AI 가설 분류 프록시
 *
 * 브라우저는 Supabase JWT만 전송합니다.
 * Worker는 그 JWT로 Supabase RLS를 통과해 "교사 소유 수업방"인지 확인한 뒤,
 * 학생 별칭 없이 가설 문장만 OpenAI API에 보냅니다.
 *
 * Secrets / Vars:
 * - OPENAI_API_KEY (secret)
 * - SUPABASE_URL
 * - SUPABASE_PUBLISHABLE_KEY
 * - ALLOWED_ORIGIN
 * - OPENAI_MODEL (optional, default gpt-5.6-luna)
 */

function cors(origin, allowedOrigin) {
  const approved = allowedOrigin && allowedOrigin !== "*"
    ? allowedOrigin
    : (origin || "*");

  return {
    "Access-Control-Allow-Origin": approved,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin"
  };
}

function json(data, status, request, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...cors(request.headers.get("Origin"), env.ALLOWED_ORIGIN),
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function extractOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function supabaseGet(path, jwt, env) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": env.SUPABASE_PUBLISHABLE_KEY,
      "Authorization": `Bearer ${jwt}`,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: cors(origin, env.ALLOWED_ORIGIN)
      });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/cluster") {
      return json({ error: "Not found" }, 404, request, env);
    }

    if (!env.OPENAI_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
      return json({ error: "Worker environment is incomplete." }, 500, request, env);
    }

    const auth = request.headers.get("Authorization") || "";
    const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!jwt) {
      return json({ error: "Authentication required." }, 401, request, env);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON." }, 400, request, env);
    }

    const sessionId = String(body?.sessionId || "");
    if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
      return json({ error: "Invalid sessionId." }, 400, request, env);
    }

    try {
      // RLS 때문에 "본인이 소유한 수업방"만 교사 JWT로 조회됩니다.
      const sessions = await supabaseGet(
        `class_sessions?select=id&id=eq.${encodeURIComponent(sessionId)}`,
        jwt,
        env
      );

      if (!Array.isArray(sessions) || sessions.length !== 1) {
        return json({ error: "You do not have access to this session." }, 403, request, env);
      }

      const hypotheses = await supabaseGet(
        `hypotheses?select=id,text&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc`,
        jwt,
        env
      );

      if (!hypotheses.length) {
        return json({ error: "No hypotheses." }, 400, request, env);
      }

      const idMap = new Map(
        hypotheses.map((h, index) => [`H${index + 1}`, { id: h.id, text: h.text }])
      );

      const prompt = [
        "당신은 중학교 수학 수업에서 학생 가설을 정리하는 보조자이다.",
        "",
        "규칙:",
        "1. 수학적 옳고 그름을 절대 판정하지 않는다.",
        "2. 의미가 비슷한 가설끼리만 묶는다.",
        "3. 서로 다른 관점은 억지로 합치지 않는다.",
        "4. 그룹 이름은 중립적인 한국어 표현으로 25자 이내로 작성한다.",
        "5. 각 H번호는 정확히 한 그룹에 한 번만 포함한다.",
        "6. 정답, 교정된 문장, 해설을 제시하지 않는다.",
        "",
        "가설:",
        ...[...idMap.entries()].map(([key, value]) => `${key}: ${value.text}`)
      ].join("\n");

      const schema = {
        type: "object",
        additionalProperties: false,
        properties: {
          groups: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                ids: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string" }
                }
              },
              required: ["label", "ids"]
            }
          }
        },
        required: ["groups"]
      };

      const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: env.OPENAI_MODEL || "gpt-5.6-luna",
          reasoning: { effort: "none" },
          input: prompt,
          text: {
            format: {
              type: "json_schema",
              name: "hypothesis_clusters",
              strict: true,
              schema
            }
          }
        })
      });

      if (!openaiResponse.ok) {
        return json(
          {
            error: "OpenAI API request failed.",
            detail: (await openaiResponse.text()).slice(0, 700)
          },
          502,
          request,
          env
        );
      }

      const responseData = await openaiResponse.json();
      const outputText = extractOutputText(responseData);
      const parsed = JSON.parse(outputText);

      const used = new Set();
      const groups = [];

      for (const group of parsed.groups || []) {
        const mapped = [];

        for (const key of group.ids || []) {
          if (used.has(key) || !idMap.has(key)) continue;
          used.add(key);
          mapped.push(idMap.get(key));
        }

        if (mapped.length) {
          groups.push({
            label: String(group.label || "가설 묶음").slice(0, 60),
            hypotheses: mapped
          });
        }
      }

      const missing = [...idMap.entries()]
        .filter(([key]) => !used.has(key))
        .map(([, value]) => value);

      if (missing.length) {
        groups.push({
          label: "분류를 더 검토할 가설",
          hypotheses: missing
        });
      }

      return json(
        {
          source: "openai",
          groups,
          note: "AI는 가설의 옳고 그름을 판정하지 않고 의미가 비슷한 표현만 묶었습니다."
        },
        200,
        request,
        env
      );
    } catch (error) {
      return json(
        { error: "Server error", detail: String(error?.message || error).slice(0, 700) },
        500,
        request,
        env
      );
    }
  }
};
