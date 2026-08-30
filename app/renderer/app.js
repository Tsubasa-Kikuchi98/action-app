// renderer: DOM の組み立てと window.trailer（preload）の呼び出しだけ。
// Node にも fs にも触らない。
"use strict";

const $ = (id) => document.getElementById(id);
const el = {
  episode: $("episode"), style: $("style"), job: $("job"), force: $("force"), stills: $("stills"),
  go: $("go"), stop: $("stop"), status: $("status"),
  steps: $("steps"), log: $("log"), logCount: $("logCount"),
  totalSec: $("totalSec"), totalCost: $("totalCost"),
  resultCard: $("resultCard"), resultMeta: $("resultMeta"), player: $("player"),
  openFolder: $("openFolder"), showScript: $("showScript"),
  scriptBox: $("scriptBox"), scriptJson: $("scriptJson"),
  jobs: $("jobs"), reloadJobs: $("reloadJobs"), mockCostNote: $("mockCostNote"),
  mockBadge: $("mockBadge"), rootPath: $("rootPath"),
};

const STATE_LABEL = {
  wait: "待機", running: "実行中", done: "完了",
  skipped: "スキップ", failed: "失敗", cancelled: "中止",
};

let STEPS = [];
let running = false;
let currentJob = "";
let logLines = 0;
let ticker = null;
let startedAt = 0;
const startedStep = new Map(); // 工程ごとの開始時刻（実行中の経過秒を毎秒更新するため）

const usd = (v) => `$${Number(v || 0).toFixed(4)}`;

// ------------------------------------------------------------------ 進捗表
function renderSteps() {
  el.steps.innerHTML = "";
  for (const s of STEPS) {
    const tr = document.createElement("tr");
    tr.id = `row-${s.id}`;
    tr.innerHTML =
      `<td>${s.label}</td>` +
      `<td><span class="state wait">待機</span></td>` +
      `<td class="num sec">–</td>` +
      `<td class="num cost">–</td>` +
      `<td class="detail"></td>`;
    el.steps.appendChild(tr);
  }
}

function setStep(id, status, { sec, cost, detail } = {}) {
  const tr = $(`row-${id}`);
  if (!tr) return;
  const st = tr.querySelector(".state");
  st.className = `state ${status}`;
  st.textContent = STATE_LABEL[status] ?? status;
  tr.classList.toggle("running", status === "running");
  if (status === "running") startedStep.set(id, Date.now());
  else startedStep.delete(id);
  if (sec != null) tr.querySelector(".sec").textContent = `${sec.toFixed(1)}s`;
  if (cost != null) tr.querySelector(".cost").textContent = usd(cost);
  if (detail != null) {
    const d = tr.querySelector(".detail");
    d.textContent = detail;
    d.classList.toggle("err", status === "failed");
  }
}

function setCost(id, cost, total) {
  const tr = $(`row-${id}`);
  if (tr) tr.querySelector(".cost").textContent = usd(cost);
  el.totalCost.textContent = usd(total);
}

function tick() {
  el.totalSec.textContent = ((Date.now() - startedAt) / 1000).toFixed(1);
  for (const [id, t] of startedStep) {
    const tr = $(`row-${id}`);
    if (tr) tr.querySelector(".sec").textContent = `${((Date.now() - t) / 1000).toFixed(1)}s`;
  }
}

// ------------------------------------------------------------------ ログ
function addLog(level, text) {
  const span = document.createElement("span");
  if (level !== "info") span.className = level;
  span.textContent = text + "\n";
  el.log.appendChild(span);
  el.logCount.textContent = ++logLines;
  // 行が増えすぎたら古いものを捨てる
  while (el.log.childNodes.length > 4000) el.log.removeChild(el.log.firstChild);
  el.log.scrollTop = el.log.scrollHeight;
}

// ------------------------------------------------------------------ 履歴
async function loadJobs() {
  const rows = await window.trailer.jobs();
  el.jobs.innerHTML = "";
  if (!rows.length) {
    el.jobs.innerHTML = '<li class="empty">まだ完成した予告編はありません。</li>';
    return;
  }
  for (const r of rows) {
    const li = document.createElement("li");
    const d = new Date(r.mtime);
    const p = (n) => String(n).padStart(2, "0");
    li.innerHTML =
      `<span class="name"></span><span class="title"></span>` +
      `<span class="meta">${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())} / ${r.sizeMb}MB</span>`;
    li.querySelector(".name").textContent = r.job;
    li.querySelector(".title").textContent = r.title ? `「${r.title}」` : "";
    li.addEventListener("click", () => showResult(r.job, r.url, ""));
    el.jobs.appendChild(li);
  }
}

// ------------------------------------------------------------------ 完成
function showResult(job, url, meta) {
  currentJob = job;
  el.resultCard.classList.remove("hidden");
  el.resultMeta.textContent = meta ? `${job} — ${meta}` : job;
  el.player.src = url;
  el.player.load();
  el.scriptBox.classList.add("hidden");
  el.resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ------------------------------------------------------------------ 生成
function setRunning(v) {
  running = v;
  el.go.disabled = v;
  el.stop.disabled = !v;
  for (const c of [el.episode, el.style, el.job, el.force, el.stills]) c.disabled = v;
}

async function generate() {
  if (running) return;
  const episode = el.episode.value.trim();
  if (!episode) {
    el.status.textContent = "エピソード文を入力してください。";
    el.status.className = "status err";
    el.episode.focus();
    return;
  }

  el.log.innerHTML = "";
  logLines = 0;
  el.logCount.textContent = "0";
  el.totalCost.textContent = "$0.0000";
  el.resultCard.classList.add("hidden");
  renderSteps();

  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(tick, 200);
  setRunning(true);
  el.status.className = "status";
  el.status.textContent = "生成中…";

  const r = await window.trailer.generate({
    episode,
    job: el.job.value,
    style: el.style.value,
    force: el.force.checked,
    stills: el.stills.checked,
  });
  if (!r.ok) {
    el.status.textContent = r.error;
    el.status.className = "status err";
    setRunning(false);
    clearInterval(ticker);
  }
}

// ------------------------------------------------------------------ イベント
window.trailer.onEvent((ev) => {
  switch (ev.type) {
    case "start":
      currentJob = ev.job;
      el.job.value = ev.job;
      addLog("info", `=== ${ev.job} / style=${ev.style}${ev.mock ? " / MOCK" : ""} ===`);
      break;
    case "step":
      setStep(ev.id, ev.status, ev);
      break;
    case "cost":
      setCost(ev.id, ev.cost, ev.total);
      break;
    case "progress": {
      const tr = $(`row-${ev.id}`);
      if (tr && ev.total) tr.querySelector(".detail").textContent = `${ev.done}/${ev.total} 本完了`;
      break;
    }
    case "log":
      addLog(ev.level, ev.text);
      break;
    case "script":
      el.status.textContent = `台本: 「${ev.title}」 / ${ev.scenes} シーン`;
      break;
    case "done":
      el.status.textContent =
        `完成 — ${ev.wall.toFixed(1)} 秒 / 概算 ${usd(ev.totalCost)}${ev.mock ? "（MOCK: 実課金なし）" : ""}`;
      el.totalCost.textContent = usd(ev.totalCost);
      showResult(ev.job, `media://local/out/${encodeURIComponent(ev.job)}/trailer.mp4?t=${Date.now()}`, ev.summary);
      break;
    case "cancelled":
      el.status.textContent = `中止しました（途中までの生成物は out/${ev.job}/ に残っています）`;
      el.status.className = "status err";
      break;
    case "error":
      el.status.textContent = `失敗: ${ev.message}（途中までの生成物は out/${ev.job}/ に残っています）`;
      el.status.className = "status err";
      break;
    case "finished":
      setRunning(false);
      clearInterval(ticker);
      tick();
      for (const [id] of startedStep) setStep(id, "cancelled");
      // 「実行中」で止まっている行を「中止」に落とす
      for (const s of STEPS) {
        const st = $(`row-${s.id}`)?.querySelector(".state");
        if (st && st.classList.contains("wait") && el.status.className.includes("err")) {
          st.className = "state cancelled";
          st.textContent = "中止";
        }
      }
      loadJobs();
      break;
  }
});

// ------------------------------------------------------------------ 初期化
el.go.addEventListener("click", generate);
el.stop.addEventListener("click", () => {
  window.trailer.cancel();
  el.status.textContent = "中止を要求しました（実行中の工程が終わり次第止まります）…";
});
el.reloadJobs.addEventListener("click", loadJobs);
el.openFolder.addEventListener("click", async () => {
  const r = await window.trailer.openFolder(currentJob);
  if (!r.ok) el.status.textContent = r.error;
});
el.showScript.addEventListener("click", async () => {
  const r = await window.trailer.script(currentJob);
  el.scriptBox.classList.remove("hidden");
  el.scriptBox.open = true;
  el.scriptJson.textContent = r.ok ? JSON.stringify(r.json, null, 2) : r.error;
});
el.episode.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") generate();
});

window.addEventListener("error", (e) => {
  el.status.textContent = `画面エラー: ${e.message}`;
  el.status.className = "status err";
});

(async () => {
  if (!window.trailer) {
    el.status.textContent = "preload の読み込みに失敗しました（app/preload.cjs）。";
    el.status.className = "status err";
    return;
  }
  const d = await window.trailer.defaults();
  STEPS = d.steps;
  el.job.value = d.job;
  el.rootPath.textContent = d.root;
  el.mockBadge.classList.toggle("hidden", !d.mock);
  el.mockCostNote.classList.toggle("hidden", !d.mock);
  el.style.innerHTML = "";
  renderSteps();
  el.style.innerHTML =
    '<option value="nolan">nolan（20 秒 / 3 カット / ナレなし）</option>' +
    '<option value="narration">narration（35 秒前後 / 5 シーン / ナレ主導）</option>';
  await loadJobs();
})();
