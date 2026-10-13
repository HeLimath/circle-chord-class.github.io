import { CONFIG } from "../config.js";
import { supabase, isConfigured, ensureAnonymousAuth } from "./supabase-client.js";
import {
  getChordGeometry, setLine, bindDraggableChord
} from "./geometry.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let user = null;
let session = null;
let roomChannel = null;

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), 2200);
}

function setConnection(text, type = "neutral") {
  const el = $("#studentConnectionBadge");
  el.textContent = text;
  el.className = `badge ${type}`;
}

function showStatus(selector, message, type = "") {
  const el = $(selector);
  el.textContent = message;
  el.className = `status ${type}`.trim();
  el.classList.remove("hidden");
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
  const url = new URL(window.location.href);
  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (code) $("#joinCode").value = code;

  const savedAlias = localStorage.getItem("circleStudentAlias");
  if (savedAlias) $("#studentAlias").value = savedAlias;

  if (!isConfigured()) {
    $("#setupWarning").classList.remove("hidden");
    $("#joinBtn").disabled = true;
    setConnection("설정 필요", "warn");
    return;
  }

  try {
    user = await ensureAnonymousAuth();
    setConnection("연결됨", "success");

    const savedSessionId = localStorage.getItem("circleStudentSessionId");
    if (savedSessionId && savedAlias) {
      const { data } = await supabase
        .from("class_sessions")
        .select("*")
        .eq("id", savedSessionId)
        .maybeSingle();

      if (data) {
        session = data;
        enterClassUI();
        await loadMyHypothesis();
        subscribeRoom();
      }
    }
  } catch (error) {
    console.error(error);
    setConnection("연결 오류", "warn");
  }

  setupGeniaTutor();
}

$("#joinBtn").addEventListener("click", async () => {
  const code = $("#joinCode").value.trim().toUpperCase();
  const alias = $("#studentAlias").value.trim();

  if (!/^[A-F0-9]{6}$/.test(code)) {
    showStatus("#joinStatus", "6자리 수업방 코드를 확인해 주세요.", "warn");
    return;
  }

  if (!alias) {
    showStatus("#joinStatus", "번호 또는 별칭을 입력해 주세요.", "warn");
    return;
  }

  try {
    $("#joinBtn").disabled = true;

    const { data, error } = await supabase.rpc("join_class_session", {
      p_code: code,
      p_alias: alias
    });

    if (error) throw error;
    const joined = Array.isArray(data) ? data[0] : data;

    if (!joined) {
      showStatus("#joinStatus", "활성화된 수업방을 찾지 못했습니다.", "warn");
      return;
    }

    session = joined;
    localStorage.setItem("circleStudentSessionId", session.id);
    localStorage.setItem("circleStudentAlias", alias);

    enterClassUI();
    await loadMyHypothesis();
    subscribeRoom();
    toast("수업방에 입장했습니다.");
  } catch (error) {
    console.error(error);
    showStatus("#joinStatus", "수업방 입장에 실패했습니다. 코드와 네트워크를 확인해 주세요.", "warn");
  } finally {
    $("#joinBtn").disabled = false;
  }
});

function enterClassUI() {
  $("#joinSection").classList.add("hidden");
  $("#classSection").classList.remove("hidden");
  $("#classTitle").textContent = session.title;
  $("#classCodeBadge").textContent = session.code;
  renderPhase(session.phase);
  renderPublishedClusters(session.published_clusters);
}

function renderPhase(phase) {
  $("#phaseLabel").textContent = phaseLabel(phase);
  $$(".student-phase").forEach((panel) => panel.classList.add("hidden"));
  const target = $(`[data-student-phase="${phase}"]`);
  if (target) target.classList.remove("hidden");
}

function subscribeRoom() {
  if (roomChannel) supabase.removeChannel(roomChannel);

  roomChannel = supabase
    .channel(`student-room-${session.id}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "class_sessions",
        filter: `id=eq.${session.id}`
      },
      (payload) => {
        session = payload.new;

        if (!session.is_active) {
          toast("교사가 수업방을 종료했습니다.");
        }

        renderPhase(session.phase);
        renderPublishedClusters(session.published_clusters);
      }
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") setConnection("실시간 연결됨", "success");
    });
}

async function loadMyHypothesis() {
  const { data, error } = await supabase
    .from("hypotheses")
    .select("text")
    .eq("session_id", session.id)
    .eq("participant_id", user.id)
    .maybeSingle();

  if (!error && data?.text) {
    $("#studentHypothesis").value = data.text;
    showStatus("#hypothesisStatus", "이전에 제출한 가설을 불러왔습니다.", "success");
  }
}

$("#submitHypothesisBtn").addEventListener("click", async () => {
  if (!session?.is_active) {
    showStatus("#hypothesisStatus", "현재 수업방은 종료되었습니다.", "warn");
    return;
  }

  const text = $("#studentHypothesis").value.replace(/\s+/g, " ").trim();
  const alias = localStorage.getItem("circleStudentAlias") || "학생";

  if (text.length < 5) {
    showStatus("#hypothesisStatus", "가설을 조금 더 구체적으로 적어 주세요.", "warn");
    return;
  }

  if (text.length > 300) {
    showStatus("#hypothesisStatus", "가설은 300자 이내로 적어 주세요.", "warn");
    return;
  }

  try {
    $("#submitHypothesisBtn").disabled = true;

    const { error } = await supabase
      .from("hypotheses")
      .upsert(
        {
          session_id: session.id,
          participant_id: user.id,
          alias,
          text
        },
        { onConflict: "session_id,participant_id" }
      );

    if (error) throw error;
    showStatus("#hypothesisStatus", "가설을 제출했습니다. 다시 제출하면 수정됩니다.", "success");
  } catch (error) {
    console.error(error);
    showStatus("#hypothesisStatus", "제출에 실패했습니다. 네트워크를 확인해 주세요.", "warn");
  } finally {
    $("#submitHypothesisBtn").disabled = false;
  }
});

function renderPublishedClusters(result) {
  const waiting = $("#clusterWaiting");
  const output = $("#studentClusters");

  if (!result?.groups?.length) {
    waiting.classList.remove("hidden");
    output.classList.add("hidden");
    output.innerHTML = "";
    return;
  }

  waiting.classList.add("hidden");
  output.innerHTML = result.groups.map((group) => `
    <section class="cluster-group">
      <h4>${escapeHtml(group.label)}</h4>
      <ul>
        ${(group.hypotheses || []).map((h) => `<li>${escapeHtml(h)}</li>`).join("")}
      </ul>
    </section>
  `).join("");
  output.classList.remove("hidden");
}

function setupGeniaTutor() {
  const link = $("#geniaTutorBtn");
  const help = $("#geniaTutorHelp");

  if (CONFIG.GENIA_TUTOR_URL) {
    link.href = CONFIG.GENIA_TUTOR_URL;
    link.classList.remove("disabled-link");
    help.textContent = "형성평가 결과는 지니아튜터에서 확인합니다.";
  }
}

// -----------------------------
// Explore geometry
// -----------------------------
const explore = {
  svg: $("#exploreSvg"),
  chord: $("#exploreChord"),
  perp: $("#explorePerp"),
  mid: $("#exploreMid"),
  distanceInput: $("#exploreDistance"),
  angleInput: $("#exploreAngle"),
  center: { x: 260, y: 205 },
  radius: 150
};

function renderExplore() {
  const d = Number(explore.distanceInput.value);
  const a = Number(explore.angleInput.value);
  const g = getChordGeometry(explore.center.x, explore.center.y, explore.radius, d, a);

  setLine(explore.chord, g.p1, g.p2);
  setLine(explore.perp, explore.center, g.midpoint);
  explore.mid.setAttribute("cx", g.midpoint.x);
  explore.mid.setAttribute("cy", g.midpoint.y);

  $("#exploreDistanceLabel").setAttribute("x", (explore.center.x + g.midpoint.x) / 2 + 8);
  $("#exploreDistanceLabel").setAttribute("y", (explore.center.y + g.midpoint.y) / 2 - 8);
  $("#exploreDistanceLabel").textContent = `거리 ${d.toFixed(0)}`;

  $("#exploreLengthLabel").setAttribute("x", g.midpoint.x + 9);
  $("#exploreLengthLabel").setAttribute("y", g.midpoint.y - 13);
  $("#exploreLengthLabel").textContent = `현 ${g.length.toFixed(1)}`;

  $("#exploreDistanceValue").textContent = d.toFixed(0);
  $("#exploreLengthValue").textContent = g.length.toFixed(1);
  $("#exploreAngleValue").textContent = `${a.toFixed(0)}°`;
}

explore.distanceInput.addEventListener("input", renderExplore);
explore.angleInput.addEventListener("input", renderExplore);

bindDraggableChord({
  svg: explore.svg,
  chord: explore.chord,
  midpoint: explore.mid,
  center: explore.center,
  radius: explore.radius,
  distanceInput: explore.distanceInput,
  angleInput: explore.angleInput,
  onRender: renderExplore
});

renderExplore();

const records = [];
$("#recordCurrent").addEventListener("click", () => {
  const d = Number(explore.distanceInput.value);
  const a = Number(explore.angleInput.value);
  const g = getChordGeometry(explore.center.x, explore.center.y, explore.radius, d, a);

  if (records.length >= 6) records.shift();
  records.push({ distance: d, angle: a, length: g.length });

  $("#recordBody").innerHTML = records.map((r) => `
    <tr>
      <td>${r.distance.toFixed(0)}</td>
      <td>${r.angle.toFixed(0)}°</td>
      <td><b>${r.length.toFixed(1)}</b></td>
    </tr>
  `).join("");
});

// -----------------------------
// Verify geometry
// -----------------------------
const verify = {
  svg: $("#verifySvg"),
  center: { x: 260, y: 215 },
  radius: 155,
  a: {
    chord: $("#verifyChordA"),
    perp: $("#verifyPerpA"),
    mid: $("#verifyMidA"),
    distanceInput: $("#distanceA"),
    angleInput: $("#angleA")
  },
  b: {
    chord: $("#verifyChordB"),
    perp: $("#verifyPerpB"),
    mid: $("#verifyMidB"),
    distanceInput: $("#distanceB"),
    angleInput: $("#angleB")
  }
};

function getVerifyGeometry(which) {
  const x = verify[which];
  return getChordGeometry(
    verify.center.x, verify.center.y, verify.radius,
    Number(x.distanceInput.value), Number(x.angleInput.value)
  );
}

function drawVerify(which) {
  const item = verify[which];
  const g = getVerifyGeometry(which);
  setLine(item.chord, g.p1, g.p2);
  setLine(item.perp, verify.center, g.midpoint);
  item.mid.setAttribute("cx", g.midpoint.x);
  item.mid.setAttribute("cy", g.midpoint.y);
  return g;
}

function renderVerify() {
  const a = drawVerify("a");
  const b = drawVerify("b");

  $("#dataA").innerHTML = `거리 ${a.distance.toFixed(0)}<br>길이 ${a.length.toFixed(1)}<br>방향 ${a.angle.toFixed(0)}°`;
  $("#dataB").innerHTML = `거리 ${b.distance.toFixed(0)}<br>길이 ${b.length.toFixed(1)}<br>방향 ${b.angle.toFixed(0)}°`;

  const sameD = Math.abs(a.distance - b.distance) <= 1;
  const sameL = Math.abs(a.length - b.length) <= 1;

  let msg = "거리와 방향을 자유롭게 바꾸어 두 현을 비교해 보세요.";
  if (sameD && sameL) {
    msg = "중심에서의 거리가 같습니다. 방향이 달라도 두 현의 길이가 같습니다.";
  } else if (sameL) {
    msg = "두 현의 길이가 거의 같습니다. 중심에서의 거리도 비교해 보세요.";
  } else if (sameD) {
    msg = "중심에서의 거리가 거의 같습니다. 두 현의 길이를 비교해 보세요.";
  }
  $("#relationshipMessage").textContent = msg;
}

["#distanceA", "#angleA", "#distanceB", "#angleB"].forEach((id) => {
  $(id).addEventListener("input", renderVerify);
});

for (const which of ["a", "b"]) {
  const item = verify[which];
  bindDraggableChord({
    svg: verify.svg,
    chord: item.chord,
    midpoint: item.mid,
    center: verify.center,
    radius: verify.radius,
    distanceInput: item.distanceInput,
    angleInput: item.angleInput,
    onRender: renderVerify
  });
}

$("#missionSameDistance").addEventListener("click", () => {
  const target = Math.floor(20 + Math.random() * 105);
  verify.a.distanceInput.value = String(target);
  verify.b.distanceInput.value = String(Math.min(150, target + 30));
  verify.a.angleInput.value = String(Math.floor(Math.random() * 360));
  verify.b.angleInput.value = String(Math.floor(Math.random() * 360));
  renderVerify();
  $("#missionMessage").textContent =
    `현 A의 중심 거리 ${target}에 현 B의 거리를 맞추세요. 두 현의 방향은 달라도 됩니다.`;
});

$("#missionSameLength").addEventListener("click", () => {
  const target = Math.floor(25 + Math.random() * 95);
  verify.a.distanceInput.value = String(target);
  verify.b.distanceInput.value = String(Math.min(150, target + 36));
  verify.a.angleInput.value = String(Math.floor(Math.random() * 360));
  verify.b.angleInput.value = String(Math.floor(Math.random() * 360));
  renderVerify();
  const targetLength = getVerifyGeometry("a").length;
  $("#missionMessage").textContent =
    `현 B의 길이를 현 A(${targetLength.toFixed(1)})와 같게 만든 뒤 중심 거리를 비교하세요.`;
});

renderVerify();

// -----------------------------
// Proof
// -----------------------------
$("#checkProof").addEventListener("click", () => {
  const values = [$("#proof1").value, $("#proof2").value, $("#proof3").value];
  const message = $("#proofMessage");

  if (values.some((v) => !v)) {
    showStatus("#proofMessage", "아직 선택하지 않은 근거가 있습니다.", "warn");
    return;
  }

  const correct =
    values[0] === "radius" &&
    values[1] === "congruence" &&
    values[2] === "bisect";

  showStatus(
    "#proofMessage",
    correct
      ? "증명 흐름이 연결되었습니다. 이제 각 단계의 ‘왜?’를 자신의 문장으로 설명해 보세요."
      : "논리 연결 중 하나가 맞지 않습니다. 각 문장 앞에 ‘왜?’를 붙여 다시 생각해 보세요.",
    correct ? "success" : "warn"
  );
});

boot();
