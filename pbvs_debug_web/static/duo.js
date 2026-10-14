/* /duo 双臂并行运行页 — 整流程循环 · 左右拆道真并行 · 中间区互斥(原生 JS 自包含)
   数据: config/duo_page.json {saved_at, loops, steps:[{side,kind,label,params,mid?}]}
   mid 覆盖三态: 缺省=自动判定; true=强制中; false=强制非中(段在该步前收, 锁放行后才跑)。
   启动 = /api/duopage/start 按 side 拆两道, 两臂各自自由循环, 中区互斥排队。 */
"use strict";

const ARM_CN = { left: "左臂", right: "右臂" };
const KIND_CN = {
  align_step: "④对准·单步", align_wait: "④对准·到收敛",
  teach_goto: "⑦前往", teach_play: "⑦回放",
  gripper: "🤏夹爪", grasp_seq: "⑧抓取序列",
  dwell: "⏱等待", suction: "⑭吸取",
};

const state = {
  doc: { saved_at: 0, loops: 1, steps: [] },   // duo_page.json 文档(编辑中工作副本)
  dirty: false,                                 // 有未保存修改
  openIdx: -1,                                  // 当前展开编辑的步骤下标
  stepDur: [],                                  // 每步最近耗时(按步骤下标)
  preview: { mids: [], autos: [], sections: { left: [], right: [] } },
  lastQ: null,                                  // 最近一次 /duo/state(重渲染后补视图)
  wasRunning: false,                            // 上一拍是否在执行(新一轮清旧计时)
};

const $ = id => document.getElementById(id);
const nz = (v, d) => v != null ? v : d;
const esc = s => String(s == null ? "" : s)
  .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- 基础工具(复制自 run.js) ---------------- */

function toast(msg, kind) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (kind ? " " + kind : "");
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = ""; }, 3500);
}

async function getJSON(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 500) }; }
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "请求超时" : String(e) };
  } finally { clearTimeout(timer); }
}

async function hub(path, body, timeoutMs) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const r = await fetch(`/api/${path}`, { ...opt, signal: ctrl.signal, cache: "no-store" });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 300) }; }
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "请求超时" : String(e) };
  } finally { clearTimeout(timer); }
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const sideTag = s => s === "left"
  ? '<span class="qside l" title="左臂">左</span>'
  : '<span class="qside r" title="右臂">右</span>';
const sideCN = s => ARM_CN[s] || s || "?";
const stepTimeTag = d => (d.dur_s != null || d.t)
  ? ` <span class="tag" style="color:var(--muted)">⏱${d.dur_s != null ? d.dur_s + "s" : "?"}${d.t ? " " + new Date(d.t * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : ""}</span>`
  : "";

function setChip(id, ok, text, warn) {
  const el = $(id);
  if (!el) return;
  el.className = "chip " + (ok ? "up" : warn ? "warn" : "down");
  el.querySelector(".txt").textContent = text;
}

async function pollHealth() {
  const h = await getJSON("/api/health", 6000);
  if (!h.ok) { setChip("hL", false, "调试服务"); return; }
  for (const [side, id] of [["left", "hL"], ["right", "hR"]]) {
    const s = h.sides[side];
    setChip(id, s.up, `PBVS-${side === "left" ? "L" : "R"} ${s.up ? "在线" : "离线"}`);
  }
  setChip("hArm", h.arm_http.up, `臂控:8000 ${h.arm_http.up ? "在线" : "离线"}`);
}

/* ---------------- 中区判定(与服务端 duo_hub._compute_mid 同规则, 本地实时预览) ---------------- */

function stepText(it) {
  const p = it.params || {};
  const parts = [String(it.label || "")];
  if (typeof p.name === "string") parts.push(p.name);
  if (Array.isArray(p.names)) parts.push(...p.names.map(String));
  return parts.join(" ");
}

function _laneMids(lane) {                 // 单道状态机(与服务端同规则)
  const ms = []; let inMid = false;
  for (const it of lane) {
    const txt = stepText(it), ov = it.mid;
    let mid;
    if (ov === true) { mid = true; inMid = true; }
    else if (ov === false) { mid = false; inMid = false; }
    else if (!inMid) { mid = txt.includes("中"); if (mid) inMid = true; }
    else { mid = true; if (it.kind === "teach_goto" && !txt.includes("中")) inMid = false; }
    ms.push(mid);
  }
  return ms;
}

function computePreview(steps) {           // → {mids, autos(交错), sections{side:[(i0,i1)...]}}
  const out = { mids: [], autos: [], sections: { left: [], right: [] } };
  const laneM = {}, laneA = {};
  for (const s of ["left", "right"]) {
    const lane = steps.filter(it => it.side === s);
    laneM[s] = _laneMids(lane);
    laneA[s] = _laneMids(lane.map(it => { const c = { ...it }; delete c.mid; return c; }));
    let i = 0;
    while (i < laneM[s].length) {
      if (laneM[s][i]) {
        let j = i; while (j + 1 < laneM[s].length && laneM[s][j + 1]) j++;
        out.sections[s].push([i, j]); i = j + 1;
      } else i++;
    }
  }
  const idx = { left: 0, right: 0 };
  for (const it of steps) {
    const s = it.side, ok = (s === "left" || s === "right") && idx[s] < laneM[s].length;
    out.mids.push(ok ? !!laneM[s][idx[s]] : false);
    out.autos.push(ok ? !!laneA[s][idx[s]] : false);
    if (s === "left" || s === "right") idx[s]++;
  }
  return out;
}

/* 中徽章: auto(自动判定值) + st.mid 覆盖 → 四显示态; 点击循环
   undefined → 反(强制) → 锁(与自动同值显式) → undefined(还原自动) */
function midBadge(st, i) {
  const auto = !!state.preview.autos[i], eff = !!state.preview.mids[i];
  let cls, txt, tip;
  if (st.mid === true) {
    cls = "fon"; txt = "中·手";
    tip = `手动强制开(两臂互斥) — 点击: 锁定为「非中」→ 再点还原自动`;
  } else if (st.mid === false) {
    cls = "foff"; txt = "非中·手";
    tip = `手动强制关 — 点击: 锁定为「${auto ? "中" : "非中"}」(自动判定)→ 再点还原自动`;
  } else if (eff) {
    cls = "on"; txt = "中";
    tip = `自动判定: 中区(两臂互斥) — 点击: 强制关掉(段在此步前收)→ 再点锁定 → 再点还原`;
  } else {
    cls = "off"; txt = "中";
    tip = `自动判定: 非中区 — 点击: 强制开启(段从这步开始)→ 再点锁定 → 再点还原`;
  }
  return `<button data-act="mid" class="midb ${cls}" title="${esc(tip)}">${txt}</button>`;
}

function cycleMid(i) {
  const st = state.doc.steps[i];
  if (!st) return;
  const auto = !!state.preview.autos[i];
  if (st.mid === undefined) st.mid = !auto;       // 自动 → 反着强制
  else if (st.mid !== auto) st.mid = auto;        // 反着 → 锁定(显式同自动)
  else delete st.mid;                             // 锁定 → 还原自动
  markDirty();
  renderSteps();
}

/* ---------------- 步骤渲染 ---------------- */

function normPoseAlign(mv) {
  const pa = mv.pose_align = mv.pose_align || {};
  for (const k of ["angle_pos", "angle_neg", "sign", "angle", "pa_angle_pos", "pa_angle_neg"])
    delete pa[k];
  return pa;
}

function psum(st) {
  const p = st.params || {};
  switch (st.kind) {
    case "dwell": return `等${nz(p.s, "?")}s`;
    case "suction": return `第${nz(p.index, "?")}袋·${p.run || "direct"}`;
    case "teach_goto": return p.name || "?";
    case "teach_play": return `${(p.names || []).length}点·停${nz(p.dwell_s, 0.5)}s`;
    case "gripper": return `开度${nz(p.position, "?")}`;
    case "align_wait": return `≤${nz(p.timeout_s, 120)}s`;
    case "grasp_seq": return `${(p.moves || []).length}步序列`;
    default: return "";
  }
}

/* ⑧ moves 单行编辑器(同 run.js) */
const AX_INPUT = (k, v) =>
  `<label class="axlab">${k.toUpperCase()}<input type="number" data-k="${k}" value="${v}" step="1"></label>`;

function moveRowHTML(mv, j) {
  let body;
  if ("gripper" in mv) {
    body = `<span class="axlab">🤏 夹爪开度<input type="number" data-k="gripper" value="${mv.gripper}" step="50" min="0" max="1000"></span><span class="unit">(0闭-1000开)</span>`;
  } else if ("pose_align" in mv) {
    const pa = normPoseAlign(mv);
    body = `<span class="axlab">🧭 ⑩转正 袋#</span>` +
           `<input type="number" data-k="pa_index" value="${pa.index || 1}" step="1" min="1" style="width:4em">` +
           `<span class="unit">检测调转多少转多少(✓≤30°跳过)</span>`;
  } else if ("dwell" in mv) {
    body = `<span class="axlab">⏱ 等待<input type="number" data-k="dwell" value="${mv.dwell}" step="0.1" min="0" max="5"></span><span class="unit">秒</span>`;
  } else if ("rx" in mv) {
    body = `<span class="axlab">🔄 绕轴</span>` +
           AX_INPUT("rx", mv.rx) + AX_INPUT("ry", mv.ry) + AX_INPUT("rz", mv.rz) +
           `<select data-k="frame"><option value="tool"${mv.frame === "tool" ? " selected" : ""}>工具系</option>` +
           `<option value="base"${mv.frame === "base" ? " selected" : ""}>基座系</option></select>` +
           `<span class="unit">°</span>`;
  } else {
    body = AX_INPUT("x", (mv.x * 1000).toFixed(0)) + AX_INPUT("y", (mv.y * 1000).toFixed(0)) +
           AX_INPUT("z", (mv.z * 1000).toFixed(0)) +
           `<select data-k="frame"><option value="tool"${mv.frame === "tool" ? " selected" : ""}>工具系</option>` +
           `<option value="base"${mv.frame === "base" ? " selected" : ""}>基座系</option></select>` +
           `<span class="unit">mm</span>`;
  }
  return `<li data-mi="${j}"><span class="ord">${j + 1}.</span><span class="move-edit">${body}</span>` +
         `<button data-act="mup" title="上移">↑</button>` +
         `<button data-act="mdown" title="下移">↓</button>` +
         `<button data-act="mdel" title="删除">✕</button></li>`;
}

function stepEditHTML(st) {
  const p = st.params || {};
  const rows = [];
  rows.push(`<div class="row"><label>名称</label><input type="text" data-k="label" value="${esc(st.label)}" maxlength="80" style="width:260px"></div>`);
  const lockSide = st.kind === "suction";
  rows.push(`<div class="row"><label>臂</label><select data-k="side"${lockSide ? " disabled" : ""}>` +
    `<option value="left"${st.side === "left" ? " selected" : ""}>左臂</option>` +
    `<option value="right"${st.side === "right" ? " selected" : ""}>右臂</option></select>` +
    (lockSide ? '<span class="unit">⑭ 仅左臂</span>' : "") + `</div>`);
  switch (st.kind) {
    case "align_step":
      rows.push('<div class="row"><label>参数</label><span class="unit">无参数 — 单步=一次 测量→运动 迭代</span></div>');
      break;
    case "align_wait":
      rows.push(`<div class="row"><label>超时</label><input type="number" data-p="timeout_s" value="${nz(p.timeout_s, 120)}" min="10" max="600" step="1"><span class="unit">秒(10-600)</span></div>`);
      break;
    case "teach_goto":
      rows.push(`<div class="row"><label>示教点</label><input type="text" data-p="name" value="${esc(p.name)}" style="width:200px"><span class="unit">须是⑦已保存点名(名带「中」自动判中区)</span></div>`);
      break;
    case "teach_play": {
      const names = p.names || [];
      rows.push(`<div class="row"><label>回放点</label><ul class="namelist">` +
        names.map((n, j) => `<li><span class="ord">${j + 1}.</span><input type="text" data-p="tp_name" data-ni="${j}" value="${esc(n)}" style="width:180px"><button data-act="ndel" data-ni="${j}" title="删除">✕</button></li>`).join("") +
        `</ul><button data-act="nadd">＋加点</button></div>`);
      rows.push(`<div class="row"><label>点间停留</label><input type="number" data-p="dwell_s" value="${nz(p.dwell_s, 0.5)}" min="0" step="0.1"><span class="unit">秒</span></div>`);
      break;
    }
    case "gripper":
      rows.push(`<div class="row"><label>开度</label><input type="number" data-p="position" value="${nz(p.position, 0)}" min="0" max="1000" step="10"><span class="unit">0闭-1000开</span></div>`);
      break;
    case "dwell":
      rows.push(`<div class="row"><label>等待</label><input type="number" data-p="s" value="${nz(p.s, 1)}" min="0" max="120" step="0.1"><span class="unit">秒(0-120)</span></div>`);
      break;
    case "suction":
      rows.push(`<div class="row"><label>方式</label><select data-p="run">` +
        ["direct", "go", "press"].map(v => `<option value="${v}"${(p.run || "direct") === v ? " selected" : ""}>${{ direct: "直达吸取(--direct)", go: "分段 go", press: "压取 press" }[v]}</option>`).join("") +
        `</select></div>`);
      rows.push(`<div class="row"><label>袋#</label><input type="number" data-p="index" value="${nz(p.index, 1)}" min="1" step="1"><span class="unit">层序编号(⑭同款)</span></div>`);
      break;
    case "grasp_seq": {
      const moves = p.moves || [];
      rows.push(`<div class="row"><label>选项</label>` +
        `<label class="chk"><input type="checkbox" data-p="require_aligned"${p.require_aligned !== false ? " checked" : ""}> 要求已对准</label>` +
        `<label class="chk"><input type="checkbox" data-p="smooth"${p.smooth !== false ? " checked" : ""}> 平滑(一次到位)</label></div>`);
      rows.push(`<ul class="movelist">` +
        (moves.length ? moves.map(moveRowHTML).join("") : "<li><span class='unit'>暂无步骤 — 下方添加</span></li>") +
        `</ul>`);
      rows.push(`<div class="row"><label>＋添加</label><select data-p="madd_type">` +
        `<option value="trans">平移 XYZ</option><option value="rot">旋转 RX/RY/RZ</option>` +
        `<option value="posealign">🧭 按检测转正</option><option value="grip">夹爪开度</option>` +
        `<option value="dwell">等待</option></select>` +
        `<button data-act="madd">＋ 添加到序列尾</button></div>`);
      break;
    }
  }
  return `<div class="step-edit">${rows.join("")}</div>`;
}

function renderSteps() {
  const ul = $("duoStepList");
  const steps = state.doc.steps;
  $("duoStepCount").textContent = steps.length;
  state.preview = computePreview(steps);
  ul.innerHTML = "";
  if (!steps.length) {
    ul.innerHTML = "<li><span class='unit'>流程为空 — 点「⤵ 从运行页导入」拷 /run 页流程, 或用下方「＋步骤」手动加</span></li>";
    return;
  }
  steps.forEach((st, i) => {
    st.params = st.params || {};
    const li = document.createElement("li");
    li.className = "run-step" + (i === state.openIdx ? " open" : "");
    li.dataset.i = i;
    li.innerHTML =
      `<div class="run-head">${sideTag(st.side)}` +
      midBadge(st, i) +
      `<span class="ord">${i + 1}.</span>` +
      `<span class="name" title="${esc(st.label)}">${esc(st.label)}</span>` +
      `<span class="kbadge">${KIND_CN[st.kind] || st.kind}</span>` +
      `<span class="psum">${esc(psum(st))}</span>` +
      `<span class="rtime"></span>` +
      `<button data-act="edit" title="展开/收起编辑">${state.openIdx === i ? "▲" : "✎"}</button>` +
      `<button data-act="up" title="上移">↑</button>` +
      `<button data-act="down" title="下移">↓</button>` +
      `<button data-act="del" title="删除">✕</button></div>` +
      (i === state.openIdx ? stepEditHTML(st) : "");
    ul.appendChild(li);
  });
  renderMidSections();
  if (state.lastQ) refreshLanes(state.lastQ);      // 重渲染后补双道视图计时
}

/* 步骤列表下方小字: 两道各自的中区段预览 */
function renderMidSections() {
  const el = $("duoStepCount");
  if (!el) return;
  const secs = state.preview.sections;
  const fmt = side => (secs[side] || []).map(([a, b]) =>
    `第${a + 1}${b > a ? "-" + (b + 1) : ""}步`).join(", ") || "无";
  el.title = `中区段预览(道内步序): 左 [${fmt("left")}] · 右 [${fmt("right")}]`;
}

/* ---------------- 编辑: 事件委托 ---------------- */

function applyMoveEdit(mv, t) {
  const k = t.dataset.k;
  if (k === "frame") mv.frame = t.value;
  else if (k === "pa_index") {
    mv.pose_align = mv.pose_align || {};
    mv.pose_align.index = Math.max(1, parseInt(t.value, 10) || 1);
  } else if (k === "gripper") mv.gripper = Math.max(0, Math.min(1000, parseFloat(t.value) || 0));
  else if (k === "dwell") mv.dwell = Math.max(0, Math.min(5, parseFloat(t.value) || 0));
  else if (k === "rx" || k === "ry" || k === "rz")
    mv[k] = Math.max(-180, Math.min(180, parseFloat(t.value) || 0));
  else mv[k] = (parseFloat(t.value) || 0) / 1000;
}

function applyParamEdit(st, key, t) {
  const p = st.params || (st.params = {});
  const num = def => { const f = parseFloat(t.value); return isNaN(f) ? def : f; };
  switch (key) {
    case "timeout_s": p.timeout_s = Math.max(10, Math.min(600, num(120))); break;
    case "name": p.name = String(t.value || "").trim(); break;
    case "dwell_s": p.dwell_s = Math.max(0, num(0.5)); break;
    case "position": p.position = Math.max(0, Math.min(1000, num(0))); break;
    case "s": p.s = Math.max(0, Math.min(120, num(1))); break;
    case "run": p.run = t.value; break;
    case "index": p.index = Math.max(1, parseInt(t.value, 10) || 1); break;
    case "require_aligned": p.require_aligned = t.checked; break;
    case "smooth": p.smooth = t.checked; break;
  }
}

function touchStep(liStep, st) {
  markDirty();
  const ps = liStep.querySelector(".run-head .psum");
  if (ps) ps.textContent = psum(st);
}

$("duoStepList").addEventListener("change", e => {
  const t = e.target;
  const liStep = t.closest("li.run-step");
  if (!liStep) return;
  const i = +liStep.dataset.i;
  const st = state.doc.steps[i];
  if (!st) return;
  const mrow = t.closest("li[data-mi]");
  if (mrow && st.kind === "grasp_seq") {
    const mv = (st.params.moves || [])[+mrow.dataset.mi];
    if (mv) { applyMoveEdit(mv, t); touchStep(liStep, st); }
    return;
  }
  if (t.dataset.p === "tp_name") {
    const names = st.params.names || (st.params.names = []);
    names[+t.dataset.ni] = String(t.value || "");
    touchStep(liStep, st); renderMidSections();
    return;
  }
  const k = t.dataset.k;
  if (k === "label") {
    st.label = String(t.value || "").slice(0, 80) || st.kind;
    const nm = liStep.querySelector(".run-head .name");
    if (nm) { nm.textContent = st.label; nm.title = st.label; }
    markDirty(); renderSteps();               // 名字可能带动中区判定 → 重渲染徽章
    return;
  }
  if (k === "side") {
    if (st.kind !== "suction") st.side = t.value;
    touchStep(liStep, st); renderSteps();
    return;
  }
  if (t.dataset.p != null) {
    applyParamEdit(st, t.dataset.p, t);
    touchStep(liStep, st); renderSteps();     // 示教点名可能带动中区判定
  }
});

$("duoStepList").addEventListener("click", e => {
  const liStep = e.target.closest("li.run-step");
  if (liStep && !e.target.closest("button")) {
    if (e.target.closest(".run-head")) {
      const i = +liStep.dataset.i;
      state.openIdx = state.openIdx === i ? -1 : i;
      renderSteps();
      return;
    }
    return;
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn || !liStep) return;
  const i = +liStep.dataset.i;
  const a = state.doc.steps;
  const st = a[i];
  if (!st) return;
  const act = btn.dataset.act;
  if (act === "mid") { cycleMid(i); return; }
  if (act === "edit") { state.openIdx = state.openIdx === i ? -1 : i; renderSteps(); return; }
  if (act === "del") {
    if (!confirm(`删除第 ${i + 1} 步「${st.label}」?`)) return;
    a.splice(i, 1);
    if (state.openIdx === i) state.openIdx = -1;
    else if (state.openIdx > i) state.openIdx--;
    renderSteps(); markDirty(); return;
  }
  if (act === "up" && i > 0) {
    [a[i - 1], a[i]] = [a[i], a[i - 1]];
    if (state.openIdx === i) state.openIdx = i - 1;
    else if (state.openIdx === i - 1) state.openIdx = i;
    renderSteps(); markDirty(); return;
  }
  if (act === "down" && i < a.length - 1) {
    [a[i + 1], a[i]] = [a[i], a[i + 1]];
    if (state.openIdx === i) state.openIdx = i + 1;
    else if (state.openIdx === i + 1) state.openIdx = i;
    renderSteps(); markDirty(); return;
  }
  const p = st.params || (st.params = {});
  if (act === "nadd") { (p.names = p.names || []).push(""); renderSteps(); markDirty(); return; }
  if (act === "ndel") { (p.names || []).splice(+btn.dataset.ni, 1); renderSteps(); markDirty(); return; }
  if (act === "madd") {
    const sel = liStep.querySelector('select[data-p="madd_type"]');
    const tp = sel ? sel.value : "trans";
    const mv = tp === "grip" ? { gripper: 0 }
      : tp === "dwell" ? { dwell: 0.8 }
      : tp === "posealign" ? { pose_align: { index: 1 } }
      : tp === "rot" ? { rx: 0, ry: 0, rz: 90, frame: "tool" }
      : { x: 0, y: 0, z: -0.08, frame: "tool" };
    (p.moves = p.moves || []).push(mv);
    renderSteps(); markDirty(); return;
  }
  if (act === "mdel") { (p.moves || []).splice(+btn.dataset.mi, 1); renderSteps(); markDirty(); return; }
  if ((act === "mup" || act === "mdown")) {
    const mv = p.moves || [];
    const j = +btn.dataset.mi;
    if (act === "mup" && j > 0) [mv[j - 1], mv[j]] = [mv[j], mv[j - 1]];
    if (act === "mdown" && j < mv.length - 1) [mv[j + 1], mv[j]] = [mv[j], mv[j + 1]];
    renderSteps(); markDirty(); return;
  }
});

/* ---------------- ＋步骤(模板) / 从运行页导入 ---------------- */

function buildStep(kind) {
  const base = { side: "left", kind, label: "", params: {} };
  switch (kind) {
    case "teach_goto": base.params = { name: "" }; base.label = "⑦前往"; break;
    case "teach_play": base.params = { names: [""], dwell_s: 0.5 }; base.label = "⑦回放"; break;
    case "align_step": base.label = "④对准·单步"; break;
    case "align_wait": base.params = { timeout_s: 120 }; base.label = "④对准·到收敛"; break;
    case "grasp_seq": base.params = { moves: [{ x: 0, y: 0, z: -0.08, frame: "tool" }], require_aligned: false, smooth: true }; base.label = "⑧抓取序列"; break;
    case "gripper": base.params = { position: 1000 }; base.label = "🤏夹爪"; break;
    case "dwell": base.params = { s: 1 }; base.label = "⏱等待"; break;
    case "suction": base.params = { index: 1, run: "direct" }; base.label = "⑭直线吸取"; base.side = "left"; break;
  }
  return base;
}

$("btnDuoAddStep").addEventListener("click", () => {
  const kind = $("duoAddKind").value;
  state.doc.steps.push(buildStep(kind));
  state.openIdx = state.doc.steps.length - 1;    // 新步直接展开编辑
  renderSteps(); markDirty();
  $("duoStepList").lastElementChild?.scrollIntoView({ block: "nearest" });
});

$("btnDuoImport").addEventListener("click", () => withBusy($("btnDuoImport"), "导入…", async () => {
  if (state.dirty && !confirm("本页有未保存修改, 导入会整条替换 — 继续?")) { return; }
  const r = await hub("duopage/import_run", {}, 10000);
  if (!r.ok) { toast("导入失败: " + (r.error || ""), "err"); return; }
  await loadDoc();
  toast(`已导入 ${r.count} 步(左${r.lanes.left}/右${r.lanes.right}), 中区按新流程自动判定`, "ok");
}));

/* ---------------- 脏标记 / 载入 / 保存 ---------------- */

function markDirty() { state.dirty = true; $("duoDirty").textContent = "● 未保存"; }
function clearDirty() { state.dirty = false; $("duoDirty").textContent = ""; }
function renderSavedAt() {
  $("duoSavedAt").textContent = state.doc.saved_at ? "已存 " + fmtTime(state.doc.saved_at) : "—";
}
function setLoopsUI(loops) {
  if (!loops) { $("duoLoopInf").checked = true; }
  else { $("duoLoopInf").checked = false; $("duoLoops").value = Math.max(1, Math.min(999, loops)); }
}
function readLoops() {
  if ($("duoLoopInf").checked) return 0;
  const v = Math.max(1, Math.min(999, parseInt($("duoLoops").value, 10) || 1));
  $("duoLoops").value = v;
  return v;
}

async function loadDoc() {
  const r = await hub("duopage/state", null, 8000);
  if (!r.ok) { toast("读取双臂页数据失败: " + (r.error || ""), "err"); return; }
  state.doc = { saved_at: r.saved_at || 0, loops: nz(r.loops, 1), steps: r.steps || [] };
  setLoopsUI(state.doc.loops);
  state.openIdx = -1;
  state.stepDur = [];
  clearDirty(); renderSavedAt(); renderSteps();
}

function validateSteps() {
  for (let i = 0; i < state.doc.steps.length; i++) {
    const st = state.doc.steps[i], p = st.params || {};
    if (st.kind === "teach_goto" && !(p.name || "").trim()) {
      toast(`第 ${i + 1} 步示教点名为空`, "err"); return false;
    }
    if (st.kind === "teach_play" && !(p.names || []).filter(n => n && n.trim()).length) {
      toast(`第 ${i + 1} 步回放点列表为空`, "err"); return false;
    }
    if (st.kind === "grasp_seq" && !(p.moves || []).length) {
      toast(`第 ${i + 1} 步⑧序列为空(至少 1 步)`, "err"); return false;
    }
    if (st.kind === "suction" && st.side !== "left") {
      toast(`第 ${i + 1} 步⑭吸取仅左臂`, "err"); return false;
    }
  }
  const L = state.doc.steps.filter(s => s.side === "left").length;
  const R = state.doc.steps.filter(s => s.side === "right").length;
  if (!L || !R) {
    toast(`左右两臂都要有步骤(现左${L}/右${R}) — 并行页两道都不能为空`, "err");
    return false;
  }
  return true;
}

async function saveDoc(silent) {
  if (!validateSteps()) return false;
  const loops = readLoops();
  const r = await hub("duopage/save", { loops, steps: state.doc.steps }, 10000);
  if (!r.ok) { toast("保存失败: " + (r.error || ""), "err"); return false; }
  state.doc.loops = loops;
  state.doc.saved_at = r.saved_at || Date.now() / 1000;
  clearDirty(); renderSavedAt();
  if (!silent) toast(`已保存 ${r.count} 步到双臂页文件`, "ok");
  return true;
}

$("btnDuoSave").addEventListener("click", () => withBusy($("btnDuoSave"), "保存…", () => saveDoc(false)));

$("btnDuoRevert").addEventListener("click", async () => {
  if (state.dirty && !confirm("放弃本页所有未保存的修改, 从文件重新载入?")) return;
  await loadDoc();
  toast("已从文件重新载入", "ok");
});

async function pollDoc() {
  if (state.dirty) return;
  const r = await hub("duopage/state", null, 6000);
  if (!r.ok) return;
  if ((r.saved_at || 0) > (state.doc.saved_at || 0) + 0.5) {
    state.doc = { saved_at: r.saved_at || 0, loops: nz(r.loops, 1), steps: r.steps || [] };
    setLoopsUI(state.doc.loops);
    state.openIdx = -1;
    state.stepDur = [];
    renderSavedAt(); renderSteps();
  }
}

/* ---------------- 开始 / 停止 ---------------- */

function fmtSections(side) {
  const lane = state.doc.steps.filter(s => s.side === side);
  const secs = state.preview.sections[side] || [];
  if (!secs.length) return "无中区段(全程并行)";
  return secs.map(([a, b]) =>
    `第${a + 1}${b > a ? "-" + (b + 1) : ""}步（${lane[a]?.label || "?"}${b > a ? " … " + (lane[b]?.label || "?") : ""}）`
  ).join("; ");
}

$("btnDuoStart").addEventListener("click", () => withBusy($("btnDuoStart"), "启动…", async () => {
  if (!state.doc.steps.length) { toast("流程为空 — 先导入或用＋步骤添加", "err"); return; }
  if (state.dirty) {
    if (!confirm("有未保存的修改 — 开始前先保存?\n(取消 = 中止开始)")) return;
    if (!await saveDoc(true)) return;
  }
  const st = await hub("queue/state", null, 5000);
  if (!st.ok) { toast("调试台离线", "err"); return; }
  if (st.running) { toast("队列已在执行中(⑨/串行运行页) — 先停止", "err"); return; }
  const d = await hub("duo/state", null, 5000);
  if (d.ok && d.running) { toast("双臂并行已在执行 — 先停止", "err"); return; }
  const h = await getJSON("/api/health", 6000);
  if (h.ok) {
    for (const side of new Set(state.doc.steps.map(s => s.side))) {
      if (!h.sides[side].up) { toast(`${sideCN(side)} PBVS 离线 — 先在调试台⭕恢复`, "err"); return; }
    }
  }
  const L = state.doc.steps.filter(s => s.side === "left").length;
  const R = state.doc.steps.filter(s => s.side === "right").length;
  const loops = readLoops();
  const loopTxt = loops === 0 ? "∞ 无限循环(直到停止)" : `循环 ${loops} 轮`;
  if (!confirm(
      `双臂并行 一键开始: 流程 ${state.doc.steps.length} 步(左${L}/右${R}) × ${loopTxt}\n` +
      `— 两臂【同时工作】: 只保各道内部顺序, 跨臂先后不保留 —\n` +
      `— 中区互斥: 「中」步骤两臂绝不同时执行, 先到先进, 另一臂⏳等 —\n` +
      `· 左道中区: ${fmtSections("left")}\n` +
      `· 右道中区: ${fmtSections("right")}\n` +
      (loops === 0 ? "自由循环: 两臂各自循环不互相等轮。\n" : "") +
      `任一步失败双臂同停。确认两臂路径无障碍!`)) return;
  const r = await hub("duopage/start", { loops }, 10000);
  toast(r.ok ? `双臂并行开始(${loopTxt}, 左${r.lanes.left}/右${r.lanes.right}步)` : "启动失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  pollDuo();
}));

$("btnDuoStop").addEventListener("click", async () => {
  const r = await hub("duo/stop", {}, 10000);
  toast(r.ok ? "停止信号已发, 双臂将在最近检查点停下" : "停止失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  pollDuo();
});

/* ---------------- 双道实时面板 ---------------- */

function lanePanelHTML(side, ln, d) {
  const parts = [];
  const total = ln.cycle_total;
  parts.push(`<div class="lane-head">${sideTag(side)} ${esc(sideCN(side))}` +
    (d.running ? ` <span class="tag">第<b>${ln.cycle}</b>/${total || "∞"}轮</span>` : "") +
    (ln.steps ? ` <span class="tag" style="color:var(--muted)">${ln.steps}步</span>` : "") +
    (ln.holding_mid ? ` <span class="midb on" style="cursor:default">🔒持中</span>` : "") +
    (ln.waiting_mid ? ` <span class="midb wait" style="cursor:default">⏳等中</span>` : "") +
    `</div>`);
  if (ln.current) {
    const el = d.running && ln.cur_t0 ? Math.max(0, d.now - ln.cur_t0).toFixed(0) : "?";
    parts.push(`<div class="lane-now">▶ <b>${ln.cur_idx + 1}.</b> ${esc(ln.current.label)}` +
      (ln.current.mid ? ' <span class="midb on" style="cursor:default">中</span>' : "") +
      ` <span class="tag" style="color:var(--warn)">${el}s</span></div>`);
  } else if (d.running) {
    parts.push(`<div class="lane-now" style="color:var(--muted)">(本道本步之间/收尾中)</div>`);
  }
  const done = (ln.done || []).slice(-8).reverse();
  parts.push(`<ul>` + (done.length ? done.map(x =>
    `<li>${x.ok ? "✓" : "✗"} <span class="tag" style="color:var(--muted)">轮${x.cycle}</span>` +
    `<span class="name">${esc(x.label)}</span>` +
    (x.mid ? '<span class="midb on" style="cursor:default">中</span>' : "") +
    (x.detail ? `<span class="tag" style="color:var(--muted)">${esc(String(x.detail).slice(0, 40))}</span>` : "") +
    `<span class="tag" style="color:var(--muted)">⏱${x.dur_s}s</span></li>`).join("")
    : "<li style='color:var(--muted)'>尚无执行记录</li>") + `</ul>`);
  if (d.running && ln.last_s > 0)
    parts.push(`<div class="tag" style="color:var(--muted)">上轮 ${ln.last_s}s</div>`);
  return parts.join("");
}

async function pollDuo() {
  const r = await hub("duo/state", null, 5000);
  const chip = $("duoChip");
  if (!r.ok) {
    chip.className = "chip";
    chip.querySelector(".txt").textContent = "并行 —(调试台离线)";
    $("laneL").innerHTML = $("laneR").innerHTML = "";
    return;
  }
  chip.className = "chip " + (r.running ? "up" : "down");
  chip.querySelector(".txt").textContent = r.running
    ? `并行执行中${r.mid_holder ? " · " + sideCN(r.mid_holder) + "持中" : ""}` : "并行空闲";
  $("duoMid").textContent = r.running
    ? `中区: ${r.mid_holder ? sideCN(r.mid_holder) + "持锁中" :
       (r.lanes.left.waiting_mid || r.lanes.right.waiting_mid ? "一臂⏳等中" : "空闲(两臂均不在中区)")}`
    : "中区: —";
  $("laneL").innerHTML = lanePanelHTML("left", r.lanes.left, r);
  $("laneR").innerHTML = lanePanelHTML("right", r.lanes.right, r);
  if (r.running && !state.wasRunning) state.stepDur = [];   // 新一轮运行: 清旧计时
  state.wasRunning = !!r.running;
  state.lastQ = r;
  if (r.running) { $("duoRunHint").textContent = "并行执行中 — 保存的修改从下一次启动才生效"; }
  else $("duoRunHint").textContent = "";
  refreshLanes(r);
}

/* 步骤列表内联计时(按各道完成历史匹配 label; 并行无全局序号, 用最近同 label) */
function refreshLanes(r) {
  const steps = state.doc.steps;
  const lis = $("duoStepList").children;
  if (!steps.length) return;
  for (let i = 0; i < steps.length; i++) {
    const ln = r.lanes[steps[i].side];
    if (!ln) continue;
    let dur = null;
    for (let k = (ln.done || []).length - 1; k >= 0; k--) {
      if (ln.done[k].label === steps[i].label) { dur = ln.done[k].dur_s; break; }
    }
    const el = lis[i]?.querySelector(".rtime");
    if (!el) continue;
    const isCur = r.running && ln.current && ln.current.label === steps[i].label;
    if (isCur && ln.cur_t0 && r.now)
      el.textContent = "⏱" + Math.max(0, r.now - ln.cur_t0).toFixed(0) + "s…";
    else el.textContent = dur != null ? "⏱" + dur + "s" : "";
  }
}

/* ---------------- 📋 运行日志(复用 queue/log 同一份) ---------------- */

const RUN_END_TXT = { completed: "正常跑完", failed: "中断", stopped: "用户停止" };

function fmtLogEvents(evs) {
  const out = [];
  for (const e of evs) {
    const ts = e.t ? "[" + fmtTime(e.t) + "] " : "";
    switch (e.event) {
      case "run_start":
        out.push(`${ts}▶ 开始 · ${e.source} ${e.steps}步 × ${e.loops ? e.loops + "轮" : "∞无限"}` +
                 (e.lanes ? ` (左${e.lanes.left}/右${e.lanes.right})` : "")); break;
      case "cycle_start":
        out.push(`${ts}—— ${e.side ? "[" + sideCN(e.side) + "]" : ""}第${e.cycle}轮(${e.items}项) ——`); break;
      case "step_done":
        out.push(`${ts}${e.ok ? "✓" : "✗"} 轮${e.cycle} [${sideCN(e.side)}] ${e.label} ⏱${e.dur_s}s` +
                 (e.detail ? ` | ${e.detail}` : ""));
        break;
      case "stop_req":
        out.push(`${ts}■ 停止请求(当时: ${e.at ? `[${sideCN(e.at.side)}] ${e.at.label}` : "空闲无执行项"})`); break;
      case "run_end": {
        const f = e.failed || {};
        const cyc = typeof e.cycle === "object" && e.cycle
          ? `左${e.cycle.left}/右${e.cycle.right}轮` : `${e.cycle}轮`;
        out.push(e.reason === "failed"
          ? `${ts}■ 中断: [${sideCN(f.side)}] ${f.label || "?"} 失败 — ${f.detail || ""}(${cyc})`
          : `${ts}■ ${RUN_END_TXT[e.reason] || e.reason}(${cyc})`);
        break;
      }
      case "abandoned":
        out.push(`${ts}⚠ 中断: 服务重启/进程退出 — ${e.note || ""}`); break;
      default:
        out.push(ts + e.event);
    }
  }
  return out;
}

async function pollLog() {
  const r = await getJSON("/api/queue/log?limit=120", 6000);
  const pre = $("duoLog");
  if (!pre) return;
  if (!r.ok) { pre.textContent = "日志读取失败: " + (r.error || ""); return; }
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  const lines = fmtLogEvents(r.events || []);
  pre.innerHTML = lines.length ? lines.map(l => {
    const col = (l.includes("✗") || l.includes("■ 中断")) ? "var(--crit)"
      : l.includes("✓") ? "var(--good)"
      : (l.includes("■") || l.includes("⚠") || l.includes("▶")) ? "var(--warn)" : "";
    return col ? `<span style="color:${col}">${esc(l)}</span>` : esc(l);
  }).join("\n") : "(暂无记录 — 开始一次运行后这里会有全程留痕)";
  if (stick) pre.scrollTop = pre.scrollHeight;
}

/* ---------------- 启动 ---------------- */

window.addEventListener("beforeunload", e => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

loadDoc();
pollDuo(); setInterval(pollDuo, 1000);
pollDoc(); setInterval(pollDoc, 6000);
pollLog(); setInterval(pollLog, 2500);
pollHealth(); setInterval(pollHealth, 2000);
