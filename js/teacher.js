import { CONFIG } from "../config.js";
import { supabase, isConfigured, ensureAnonymousAuth, getAccessToken } from "./supabase-client.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let currentUser = null;
let currentSession = null;
let channel = null;
let latestClusters = null;

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 2300);
}

function setConnection(text, type = "neutral") {
  const el = $("#connectionBadge");
  el.textContent = text;
  el.className = `badge ${type}`;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function phaseLabel(phase) {
  return {
    explore: "① 조작·관찰",
    hypothesis: "② 가설 제출",
    verify: "③ 가설 검증",
    prove: "④ 증명·형성평가"
  }[phase] || phase;
}

async function boot() {
  if (!isConfigured()) {
    $("#setupWarning").classList.remove("hidden");
    setConnection("설정 필요", "warn");
    $("#createSessionBtn").disabled = true;
    return;
  }

  try {
    currentUser = await ensureAnonymousAuth();
    setConnection("실시간 연결됨", "success");
    await loadRecentSessions();

    const saved = localStorage.getItem("circleTeacherSessionId");
    if (saved) {
      const { data } = await supabase
        .from("class_sessions")
        .select("*")
        .eq("id", saved)
        .maybeSingle();

      if (data) await openSession(data);
    }
  } catch (error) {
    console.error(error);
    setConnection("연결 오류", "warn");
    toast("Supabase 연결을 확인해 주세요.");
  }
}

async function loadRecentSessions() {
  const { data, error } = await supabase
    .from("class_sessions")
    .select("id,code,title,phase,is_active,created_at")
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;

  const select = $("#recentSessions");
  select.innerHTML = '<option value="">선택</option>' +
    (data || []).map((s) =>
      `<option value="${s.id}">${escapeHtml(s.title)} · ${s.code}${s.is_active ? "" : " · 종료"}</option>`
    ).join("");
}

$("#createSessionBtn").addEventListener("click", async () => {
  const title = $("#sessionTitle").value.trim() || "원과 현 탐구";

  try {
    $("#createSessionBtn").disabled = true;

    const { data, error } = await supabase.rpc("create_class_session", {
      p_title: title
    });
    if (error) throw error;

    const session = Array.isArray(data) ? data[0] : data;
    await loadRecentSessions();
    await openSession(session);
    toast("새 수업방을 만들었습니다.");
  } catch (error) {
    console.error(error);
    toast("수업방 생성에 실패했습니다.");
  } finally {
    $("#createSessionBtn").disabled = false;
  }
});

$("#openRecentBtn").addEventListener("click", async () => {
  const id = $("#recentSessions").value;
  if (!id) return;

  const { data, error } = await supabase
    .from("class_sessions")
    .select("*")
    .eq("id", id)
    .single();

  if (error) {
    console.error(error);
    toast("수업방을 열 수 없습니다.");
    return;
  }

  await openSession(data);
});

async function openSession(session) {
  currentSession = session;
  latestClusters = session.published_clusters || null;
  localStorage.setItem("circleTeacherSessionId", session.id);

  $("#roomCard").classList.remove("hidden");
  $("#sessionDashboard").classList.remove("hidden");
  $("#hypothesisDashboard").classList.remove("hidden");
  $("#aiDashboard").classList.remove("hidden");

  $("#roomCode").textContent = session.code;
  $("#currentSessionTitle").textContent = session.title;

  const base = new URL("./student.html", window.location.href);
  base.searchParams.set("code", session.code);
  $("#joinUrl").value = base.href;

  renderQr(base.href);
  renderPhase(session.phase);
  await refreshClassData();
  subscribeRealtime();
}

function renderQr(url) {
  const box = $("#qrCode");
  box.innerHTML = "";

  if (window.QRCode) {
    new window.QRCode(box, {
      text: url,
      width: 166,
      height: 166,
      correctLevel: window.QRCode.CorrectLevel.M
    });
  } else {
    box.textContent = "QR 라이브러리를 불러오지 못했습니다.";
  }
}

function renderPhase(phase) {
  $$(".phase-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.phase === phase);
  });
}

$$(".phase-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!currentSession) return;
    const phase = btn.dataset.phase;

    const { error } = await supabase
      .from("class_sessions")
      .update({ phase })
      .eq("id", currentSession.id);

    if (error) {
      console.error(error);
      toast("단계 변경에 실패했습니다.");
      return;
    }

    currentSession.phase = phase;
    renderPhase(phase);
    toast(`${phaseLabel(phase)} 단계로 전환했습니다.`);
  });
});

$("#copyLinkBtn").addEventListener("click", async () => {
  const value = $("#joinUrl").value;
  try {
    await navigator.clipboard.writeText(value);
    toast("학생 접속 주소를 복사했습니다.");
  } catch {
    $("#joinUrl").select();
    document.execCommand("copy");
    toast("학생 접속 주소를 복사했습니다.");
  }
});

$("#endSessionBtn").addEventListener("click", async () => {
  if (!currentSession) return;
  if (!confirm("이 수업방을 종료할까요? 학생은 더 이상 새 가설을 제출할 수 없습니다.")) return;

  const { error } = await supabase
    .from("class_sessions")
    .update({ is_active: false })
    .eq("id", currentSession.id);

  if (error) {
    console.error(error);
    toast("수업방 종료에 실패했습니다.");
    return;
  }

  currentSession.is_active = false;
  toast("수업방을 종료했습니다.");
  await loadRecentSessions();
});

$("#refreshBtn").addEventListener("click", refreshClassData);

$("#clearHypothesesBtn").addEventListener("click", async () => {
  if (!currentSession) return;
  if (!confirm("현재 수업방의 가설 제출을 모두 지울까요?")) return;

  const { error } = await supabase
    .from("hypotheses")
    .delete()
    .eq("session_id", currentSession.id);

  if (error) {
    console.error(error);
    toast("가설 초기화에 실패했습니다.");
    return;
  }

  latestClusters = null;
  await supabase
    .from("class_sessions")
    .update({ published_clusters: null })
    .eq("id", currentSession.id);

  $("#clusterResult").classList.add("hidden");
  $("#publishArea").classList.add("hidden");
  await refreshClassData();
  toast("가설을 초기화했습니다.");
});

async function refreshClassData() {
  if (!currentSession) return;
  await Promise.all([loadParticipants(), loadHypotheses(), refreshSession()]);
}

async function loadParticipants() {
  const { count, error } = await supabase
    .from("participants")
    .select("*", { count: "exact", head: true })
    .eq("session_id", currentSession.id);

  if (!error) $("#participantCount").textContent = count ?? 0;
}

async function loadHypotheses() {
  const { data, error } = await supabase
    .from("hypotheses")
    .select("id,alias,text,created_at,updated_at")
    .eq("session_id", currentSession.id)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  $("#hypothesisCount").textContent = data.length;
  const board = $("#liveHypotheses");

  if (!data.length) {
    board.innerHTML = '<div class="empty-state">아직 제출된 가설이 없습니다.</div>';
    return;
  }

  board.innerHTML = data.map((item) => `
    <article class="hyp-card">
      <div class="meta">${escapeHtml(item.alias)}</div>
      <p>${escapeHtml(item.text)}</p>
    </article>
  `).join("");
}

async function refreshSession() {
  const { data, error } = await supabase
    .from("class_sessions")
    .select("*")
    .eq("id", currentSession.id)
    .single();

  if (error) return;

  currentSession = data;
  renderPhase(data.phase);

  if (data.published_clusters) {
    latestClusters = data.published_clusters;
    renderClusters(latestClusters);
    $("#publishArea").classList.remove("hidden");
  }
}

function subscribeRealtime() {
  if (channel) supabase.removeChannel(channel);

  channel = supabase
    .channel(`teacher-class-${currentSession.id}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "hypotheses",
        filter: `session_id=eq.${currentSession.id}`
      },
      () => loadHypotheses()
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "participants",
        filter: `session_id=eq.${currentSession.id}`
      },
      () => loadParticipants()
    )
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "class_sessions",
        filter: `id=eq.${currentSession.id}`
      },
      (payload) => {
        currentSession = payload.new;
        renderPhase(payload.new.phase);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setConnection("실시간 연결됨", "success");
    });
}

function localFallbackCluster(items) {
  const groups = {
    same: [],
    trend: [],
    linear: [],
    other: []
  };

  for (const item of items) {
    const t = item.text.replace(/\s/g, "");
    if (
      (t.includes("같은거리") && t.includes("길이")) ||
      (t.includes("같은길이") && t.includes("거리")) ||
      (t.includes("길이가같") && t.includes("거리"))
    ) groups.same.push(item.text);
    else if (
      t.includes("일정") || t.includes("비례") ||
      t.includes("1씩") || t.includes("같은크기만큼")
    ) groups.linear.push(item.text);
    else if (
      t.includes("가까") || t.includes("멀") ||
      t.includes("증가") || t.includes("감소") ||
      t.includes("길어진") || t.includes("짧아")
    ) groups.trend.push(item.text);
    else groups.other.push(item.text);
  }

  return {
    source: "fallback",
    groups: [
      { label: "거리와 길이의 방향 관계", hypotheses: groups.trend },
      { label: "같은 거리와 같은 길이의 관계", hypotheses: groups.same },
      { label: "일정한 변화·비례에 대한 추측", hypotheses: groups.linear },
      { label: "그 밖의 가설", hypotheses: groups.other }
    ].filter((g) => g.hypotheses.length)
  };
}

async function fetchCurrentHypotheses() {
  const { data, error } = await supabase
    .from("hypotheses")
    .select("id,text")
    .eq("session_id", currentSession.id)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data;
}

$("#classifyBtn").addEventListener("click", async () => {
  if (!currentSession) return;

  let items;
  try {
    items = await fetchCurrentHypotheses();
  } catch (error) {
    console.error(error);
    toast("가설을 불러오지 못했습니다.");
    return;
  }

  if (!items.length) {
    toast("먼저 학생 가설을 받아 주세요.");
    return;
  }

  $("#classifyBtn").disabled = true;
  const status = $("#aiStatus");
  status.className = "status";
  status.textContent = "가설을 정리하고 있습니다...";
  status.classList.remove("hidden");

  try {
    if (!CONFIG.AI_ENDPOINT) {
      latestClusters = localFallbackCluster(items);
      renderClusters(latestClusters);
      status.textContent = "AI_ENDPOINT가 비어 있어 안전한 로컬 분류 모드로 실행했습니다.";
      $("#publishArea").classList.remove("hidden");
      return;
    }

    const token = await getAccessToken();
    const response = await fetch(CONFIG.AI_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({
        sessionId: currentSession.id
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `HTTP ${response.status}`);
    }

    latestClusters = await response.json();
    renderClusters(latestClusters);
    status.className = "status success";
    status.textContent = "AI 분류가 완료되었습니다. 분류 기준도 수학적으로 검토해 보세요.";
    $("#publishArea").classList.remove("hidden");
  } catch (error) {
    console.error(error);
    latestClusters = localFallbackCluster(items);
    renderClusters(latestClusters);
    status.className = "status warn";
    status.textContent = "AI 연결에 실패하여 로컬 분류로 전환했습니다. 수업은 계속 진행할 수 있습니다.";
    $("#publishArea").classList.remove("hidden");
  } finally {
    $("#classifyBtn").disabled = false;
  }
});

function renderClusters(result) {
  const output = $("#clusterResult");
  const groups = Array.isArray(result?.groups) ? result.groups : [];

  output.innerHTML = groups.map((group) => {
    const hypotheses = (group.hypotheses || []).map((h) =>
      typeof h === "string" ? h : h.text
    ).filter(Boolean);

    return `
      <section class="cluster-group">
        <h4>${escapeHtml(group.label || "가설 묶음")}
          <span class="cluster-count">${hypotheses.length}개</span>
        </h4>
        <ul>${hypotheses.map((h) => `<li>${escapeHtml(h)}</li>`).join("")}</ul>
      </section>
    `;
  }).join("");

  output.classList.remove("hidden");
}

$("#publishClustersBtn").addEventListener("click", async () => {
  if (!currentSession || !latestClusters) return;

  // 학생에게는 별칭/ID 없이 문장과 그룹 이름만 공개
  const safe = {
    groups: (latestClusters.groups || []).map((g) => ({
      label: g.label,
      hypotheses: (g.hypotheses || []).map((h) =>
        typeof h === "string" ? h : h.text
      ).filter(Boolean)
    }))
  };

  const { error } = await supabase
    .from("class_sessions")
    .update({ published_clusters: safe })
    .eq("id", currentSession.id);

  if (error) {
    console.error(error);
    toast("분류 결과 공개에 실패했습니다.");
    return;
  }

  currentSession.published_clusters = safe;
  toast("AI 분류 결과를 학생 화면에 공개했습니다.");
});

$("#hideClustersBtn").addEventListener("click", async () => {
  if (!currentSession) return;

  const { error } = await supabase
    .from("class_sessions")
    .update({ published_clusters: null })
    .eq("id", currentSession.id);

  if (error) {
    console.error(error);
    toast("숨기기에 실패했습니다.");
    return;
  }

  currentSession.published_clusters = null;
  toast("학생 화면에서 분류 결과를 숨겼습니다.");
});

boot();
