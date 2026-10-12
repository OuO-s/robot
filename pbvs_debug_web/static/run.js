/* /run 运行页 — 实机整流程循环执行(原生 JS, 自包含; helper 从 app.js 复制, 不依赖主页)
   数据: config/run_page.json {saved_at, loops, steps:[{side,kind,label,params}]}
   编辑只写该文件; 「一键开始」= /api/runpage/start 换入共用队列+循环(复用⑨引擎)。 */
"use strict";

const ARM_CN = { left: "左臂", right: "右臂" };
const KIND_CN = {
  align_step: "④对准·单步", align_wait: "④对准·到收敛",
  teach_goto: "⑦前往", teach_play: "⑦回放",
  gripper: "🤏夹爪", grasp_seq: "⑧抓取序列",
  dwell: "⏱等待", suction: "⑭吸取",
};

const state = {
  doc: { saved_at: 0, loops: 1, steps: [] },   // run_page.json 文档(编辑中的工作副本)
  dirty: false,                                 // 有未保存修改
  openIdx: -1,                                  // 当前展开编辑的步骤下标
  cursor: 0, lastCycle: 0, wasRunning: false,   // 当前步高亮游标(轮内 done 计数兜底)
  stepDur: [],                                  // 每步最近一次耗时(dur_s, 按步骤下标)
  lastQ: null,                                  // 最近一次 /queue/state(重渲染后补计时)
};

const $ = id => document.getElementById(id);
const nz = (v, d) => v != null ? v : d;
const esc = s => String(s == null ? "" : s)
  .replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------------- 基础工具(复制自 app.js) ---------------- */

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

/* ---------------- 步骤渲染 ---------------- */

/* 🧭步格式归一(同 app.js): 无角度参数, 旧键当场剥掉, 所见即所跑 */
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

/* ⑧ moves 单行编辑器(改编自 app.js renderGraspMoves, 行带 data-mi) */
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

/* 单步展开编辑器(名称/臂 + 按类型的全部参数) */
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
      rows.push(`<div class="row"><label>示教点</label><input type="text" data-p="name" value="${esc(p.name)}" style="width:200px"><span class="unit">须是⑦已保存点名</span></div>`);
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
      rows.push('<div class="row"><label>压紧</label><span class="unit">已定案取消(⑭不压, 压紧+真空交⑧) — 文件里的 press_mm/hold_s 键仅保留不生效</span></div>');
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
  const ul = $("runStepList");
  const steps = state.doc.steps;
  $("runStepCount").textContent = steps.length;
  ul.innerHTML = "";
  if (!steps.length) {
    ul.innerHTML = "<li><span class='unit'>流程为空 — 到调试台 ⑮ 用「＋加入」组好队列后点「💾 保存到运行页」, 这里就会显示整条流程</span></li>";
    return;
  }
  steps.forEach((st, i) => {
    st.params = st.params || {};
    const li = document.createElement("li");
    li.className = "run-step" + (i === state.openIdx ? " open" : "");
    li.dataset.i = i;
    li.innerHTML =
      `<div class="run-head">${sideTag(st.side)}` +
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
  if (state.lastQ) refreshRunViews(state.lastQ);   // 重渲染后补高亮+计时
}

/* ---------------- 编辑: 事件委托(输入直接写回 state, 不重渲染避免打断输入) ---------------- */

function applyMoveEdit(mv, t) {
  const k = t.dataset.k;
  if (k === "frame") mv.frame = t.value;
  else if (k === "pa_index") {
    mv.pose_align = mv.pose_align || {};
    mv.pose_align.index = Math.max(1, parseInt(t.value, 10) || 1);
  } else if (k === "gripper") mv.gripper = Math.max(0, Math.min(1000, parseFloat(t.value) || 0));
  else if (k === "dwell") mv.dwell = Math.max(0, Math.min(5, parseFloat(t.value) || 0));
  else if (k === "rx" || k === "ry" || k === "rz")
    mv[k] = Math.max(-180, Math.min(180, parseFloat(t.value) || 0));   // 旋转: deg
  else mv[k] = (parseFloat(t.value) || 0) / 1000;                       // x/y/z: mm → m
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

function touchStep(liStep, st) {          // 改动后: 置脏 + 同步头部摘要(不重渲染)
  markDirty();
  const ps = liStep.querySelector(".run-head .psum");
  if (ps) ps.textContent = psum(st);
}

$("runStepList").addEventListener("change", e => {
  const t = e.target;
  const liStep = t.closest("li.run-step");
  if (!liStep) return;
  const i = +liStep.dataset.i;
  const st = state.doc.steps[i];
  if (!st) return;
  const mrow = t.closest("li[data-mi]");           // ⑧ moves 子编辑器的行
  if (mrow && st.kind === "grasp_seq") {
    const mv = (st.params.moves || [])[+mrow.dataset.mi];
    if (mv) { applyMoveEdit(mv, t); touchStep(liStep, st); }
    return;
  }
  if (t.dataset.p === "tp_name") {                  // ⑦回放点名行
    const names = st.params.names || (st.params.names = []);
    names[+t.dataset.ni] = String(t.value || "");
    touchStep(liStep, st);
    return;
  }
  const k = t.dataset.k;
  if (k === "label") {
    st.label = String(t.value || "").slice(0, 80) || st.kind;
    const nm = liStep.querySelector(".run-head .name");
    if (nm) { nm.textContent = st.label; nm.title = st.label; }
    markDirty();
    return;
  }
  if (k === "side") {
    if (st.kind !== "suction") st.side = t.value;
    touchStep(liStep, st);
    return;
  }
  if (t.dataset.p != null) { applyParamEdit(st, t.dataset.p, t); touchStep(liStep, st); }
});

/* 结构操作(步骤/点名/moves 的 增删调序): 点击委托 → 重渲染 */
$("runStepList").addEventListener("click", e => {
  const liStep = e.target.closest("li.run-step");
  if (liStep && !e.target.closest("button")) {     // 点行头 = 展开/收起
    if (e.target.closest(".run-head")) {
      const i = +liStep.dataset.i;
      state.openIdx = state.openIdx === i ? -1 : i;
      renderSteps();
      return;
    }
    return;                                          // 编辑区内的普通点击不动
  }
  const btn = e.target.closest("button[data-act]");
  if (!btn || !liStep) return;
  const i = +liStep.dataset.i;
  const a = state.doc.steps;
  const st = a[i];
  if (!st) return;
  const act = btn.dataset.act;
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

/* ---------------- 脏标记 / 载入 / 保存 ---------------- */

function markDirty() { state.dirty = true; $("runDirty").textContent = "● 未保存"; }
function clearDirty() { state.dirty = false; $("runDirty").textContent = ""; }
function renderSavedAt() {
  $("runSavedAt").textContent = state.doc.saved_at ? "已存 " + fmtTime(state.doc.saved_at) : "—";
}
function setLoopsUI(loops) {
  if (!loops) { $("runLoopInf").checked = true; }
  else { $("runLoopInf").checked = false; $("runLoops").value = Math.max(1, Math.min(999, loops)); }
}
function readLoops() {
  if ($("runLoopInf").checked) return 0;
  const v = Math.max(1, Math.min(999, parseInt($("runLoops").value, 10) || 1));
  $("runLoops").value = v;
  return v;
}

async function loadDoc() {
  const r = await hub("runpage/state", null, 8000);
  if (!r.ok) { toast("读取运行页数据失败: " + (r.error || ""), "err"); return; }
  state.doc = { saved_at: r.saved_at || 0, loops: nz(r.loops, 1), steps: r.steps || [] };
  setLoopsUI(state.doc.loops);
  state.openIdx = -1;
  state.stepDur = [];                                  // 流程换了, 计时重新累计
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
  }
  return true;
}

async function saveDoc(silent) {
  if (!validateSteps()) return false;
  const loops = readLoops();
  const r = await hub("runpage/save", { loops, steps: state.doc.steps }, 10000);
  if (!r.ok) { toast("保存失败: " + (r.error || ""), "err"); return false; }
  state.doc.loops = loops;
  state.doc.saved_at = r.saved_at || Date.now() / 1000;
  clearDirty(); renderSavedAt();
  if (!silent) toast(`已保存 ${r.count} 步到本页文件`, "ok");
  return true;
}

$("btnRunSave").addEventListener("click", () => withBusy($("btnRunSave"), "保存…", () => saveDoc(false)));

$("btnRunRevert").addEventListener("click", async () => {
  if (state.dirty && !confirm("放弃本页所有未保存的修改, 从文件重新载入?")) return;
  await loadDoc();
  toast("已从文件重新载入", "ok");
});

/* 文件被⑮保存/他页更新且本页无未保存修改 → 自动拉取 */
async function pollDoc() {
  if (state.dirty) return;
  const r = await hub("runpage/state", null, 6000);
  if (!r.ok) return;
  if ((r.saved_at || 0) > (state.doc.saved_at || 0) + 0.5) {
    state.doc = { saved_at: r.saved_at || 0, loops: nz(r.loops, 1), steps: r.steps || [] };
    setLoopsUI(state.doc.loops);
    state.openIdx = -1;
    state.stepDur = [];                                // ⑮刚存的新流程, 计时重新累计
    renderSavedAt(); renderSteps();
  }
}

/* ---------------- 开始 / 停止 / 进度 ---------------- */

$("btnRunStart").addEventListener("click", () => withBusy($("btnRunStart"), "启动…", async () => {
  if (!state.doc.steps.length) { toast("流程为空 — 先在⑮组成队列并「保存到运行页」", "err"); return; }
  if (state.dirty) {
    if (!confirm("有未保存的修改 — 开始前先保存?\n(取消 = 中止开始)")) return;
    if (!await saveDoc(true)) return;
  }
  const st = await hub("queue/state", null, 5000);
  if (!st.ok) { toast("调试台离线", "err"); return; }
  if (st.running) { toast("队列已在执行中 — 如需重开先停止", "err"); return; }
  const h = await getJSON("/api/health", 6000);           // 步骤涉及的臂必须在线
  if (h.ok) {
    for (const side of new Set(state.doc.steps.map(s => s.side))) {
      if (!h.sides[side].up) { toast(`${sideCN(side)} PBVS 离线 — 先在调试台⭕恢复`, "err"); return; }
    }
  }
  const loops = readLoops();
  const loopTxt = loops === 0 ? "∞ 无限循环(直到停止)" : `循环 ${loops} 轮`;
  if (!confirm(`运行页 一键开始: 流程 ${state.doc.steps.length} 步 × ${loopTxt}\n` +
      "— 按下面实际顺序逐项执行(两臂绝不并行), 跑完一轮自动重灌下一轮 —\n" +
      state.doc.steps.map(s => `· [${sideCN(s.side)}] ${s.label}`).join("\n") +
      "\n\n开始会把本页流程整体换入共用队列(替换其待执行项); 任一步失败整队自动停。确认两臂路径无障碍!")) return;
  const r = await hub("runpage/start", { loops }, 10000);
  toast(r.ok ? `循环开始(${loopTxt})` : "启动失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollRun();
}));

$("btnRunStop").addEventListener("click", async () => {
  const r = await hub("queue/stop", {}, 10000);
  toast(r.ok ? "停止信号已发, 当前臂动作将在最近检查点停下" : "停止失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  pollRun();
});

function renderProgress(r) {
  const ul = $("runProgress");
  ul.innerHTML = "";
  const done = (r.done || []).slice(-10);
  if (!done.length && !r.current) {
    ul.innerHTML = "<li><span class='unit'>尚无执行记录</span></li>";
    return;
  }
  for (const d of done) {
    const li = document.createElement("li");
    li.className = "q-done";
    li.innerHTML = sideTag(d.side) +
      `<span class="tag" style="color:${d.ok ? "var(--good)" : "var(--crit)"}">${d.ok ? "✓" : "✗"}</span>` +
      `<span class="name">${esc(d.label)}</span>` +
      (d.cycle ? `<span class="tag">(第${d.cycle}轮)</span>` : "") +
      (d.detail ? `<span class="tag" style="color:var(--muted)">${esc(String(d.detail).slice(0, 60))}</span>` : "") +
      stepTimeTag(d);
    ul.appendChild(li);
  }
  if (r.current && r.running) {
    const li = document.createElement("li");
    li.className = "q-cur";
    const el = r.current_t0 ? Math.max(0, r.now - r.current_t0).toFixed(0) : "?";
    li.innerHTML = sideTag(r.current.side) +
      `<span class="tag" style="color:var(--warn)">▶</span>` +
      `<span class="name">${esc(r.current.label)}</span>` +
      `<span class="tag" style="color:var(--warn)">${el}s</span>`;
    ul.appendChild(li);
  }
}

/* 步骤列表当前项高亮(装饰性; 进度面板才是权威显示) → 返回当前步下标:
   优先按「本轮已完成数」定位(从本页启动时一一对应), 不匹配再游标顺序找
   (⑨热加项/>30步 done 截断时兜底)。 */
function highlightCurrent(r) {
  const steps = state.doc.steps;
  const lis = $("runStepList").children;
  let idx = -1;
  if (r.running && r.current && steps.length) {
    if (!state.wasRunning || (r.loop && r.loop.cycle !== state.lastCycle)) {
      state.cursor = 0;
      state.lastCycle = r.loop ? r.loop.cycle : 0;
    }
    const cyc = r.loop ? r.loop.cycle : 0;
    const doneThisCycle = (r.done || []).filter(d => d.cycle === cyc).length;
    if (steps[doneThisCycle] && steps[doneThisCycle].side === r.current.side &&
        steps[doneThisCycle].label === r.current.label) idx = doneThisCycle;
    else for (let k = 0; k < steps.length; k++) {
      const j = (state.cursor + k) % steps.length;
      if (steps[j].side === r.current.side && steps[j].label === r.current.label) {
        idx = j; state.cursor = j; break;
      }
    }
  } else {
    state.cursor = 0; state.lastCycle = 0;
  }
  for (let i = 0; i < lis.length; i++)
    lis[i].classList.toggle("q-cur", i === idx);
  return idx;
}

/* 每步计时: 已完成的显示最近一次 ⏱dur_s, 正在执行的实时累计。
   对应关系同高亮(轮内序号优先, 兜底最新同 side+label 历史)。 */
function updateStepTimes(r, curIdx) {
  const steps = state.doc.steps;
  const lis = $("runStepList").children;
  if (!steps.length) return;
  const done = r.done || [];
  const cyc = r.loop ? r.loop.cycle : 0;
  const cur = done.filter(d => d.cycle === cyc);        // 本轮已完成(时间序)
  for (let j = 0; j < cur.length && j < steps.length; j++) {
    if (steps[j].side === cur[j].side && steps[j].label === cur[j].label)
      state.stepDur[j] = cur[j].dur_s;
  }
  for (let i = 0; i < steps.length; i++) {              // 兜底: 未填的从最新历史找同名
    if (state.stepDur[i] != null) continue;
    for (let k = done.length - 1; k >= 0; k--) {
      if (done[k].side === steps[i].side && done[k].label === steps[i].label) {
        state.stepDur[i] = done[k].dur_s;
        break;
      }
    }
  }
  for (let i = 0; i < lis.length && i < steps.length; i++) {
    const el = lis[i].querySelector(".rtime");
    if (!el) continue;
    if (i === curIdx && r.running && r.current_t0)
      el.textContent = "⏱" + Math.max(0, r.now - r.current_t0).toFixed(0) + "s…";
    else el.textContent = state.stepDur[i] != null ? "⏱" + state.stepDur[i] + "s" : "";
  }
}

/* 每轮耗时: 完成轮 = 该轮第一步开始→最后一步完成的墙钟; 当前轮实时累计。 */
function updateCycles(r) {
  const el = $("runCycles");
  const done = r.done || [];
  const curCyc = r.loop ? r.loop.cycle : 0;
  const rounds = [];                                    // done 时间序 → 按 cycle 分段
  for (const d of done) {
    const last = rounds[rounds.length - 1];
    if (!last || last.cycle !== d.cycle)
      rounds.push({ cycle: d.cycle, start: d.t - (d.dur_s || 0), end: d.t });
    else last.end = d.t;
  }
  const parts = [];
  for (const rd of rounds) {
    if (r.running && rd.cycle >= curCyc) continue;      // 当前轮走实时, 不列完成项
    parts.push(`轮${rd.cycle} ${Math.max(0, rd.end - rd.start).toFixed(1)}s`);
  }
  if (r.running) {
    const cur = rounds[rounds.length - 1];
    const start = (cur && cur.cycle === curCyc) ? cur.start : (r.current_t0 || r.now);
    parts.push(`轮${curCyc || 1} ${Math.max(0, r.now - start).toFixed(0)}s…`);
  }
  el.textContent = parts.length ? "轮耗时: " + parts.slice(-8).join(" · ") : "";
}

function refreshRunViews(r) {
  const idx = highlightCurrent(r);
  updateStepTimes(r, idx);
  state.wasRunning = !!r.running;
}

/* ---------------- 📋 运行日志(持久化, 排查中断) ---------------- */

const RUN_END_TXT = { completed: "正常跑完", failed: "中断", stopped: "用户停止" };

function fmtLogEvents(evs) {
  const out = [];
  for (const e of evs) {
    const ts = e.t ? "[" + fmtTime(e.t) + "] " : "";
    switch (e.event) {
      case "run_start":
        out.push(`${ts}▶ 开始 · ${e.source} ${e.steps}步 × ${e.loops ? e.loops + "轮" : "∞无限"}`); break;
      case "cycle_start":
        out.push(`${ts}—— 第${e.cycle}轮(${e.items}项) ——`); break;
      case "step_done":
        out.push(`${ts}${e.ok ? "✓" : "✗"} 轮${e.cycle} [${sideCN(e.side)}] ${e.label} ⏱${e.dur_s}s` +
                 (e.detail ? ` | ${e.detail}` : ""));
        break;
      case "stop_req":
        out.push(`${ts}■ 停止请求(当时: ${e.at ? `[${sideCN(e.at.side)}] ${e.at.label}` : "空闲无执行项"})`); break;
      case "run_end": {
        const f = e.failed || {};
        out.push(e.reason === "failed"
          ? `${ts}■ 中断: 第${e.cycle}轮失败于 [${sideCN(f.side)}] ${f.label || "?"} — ${f.detail || ""}`
          : `${ts}■ ${RUN_END_TXT[e.reason] || e.reason}(${e.cycle}轮)`);
        break;
      }
      case "abandoned":
        out.push(`${ts}⚠ 中断: 服务重启/进程退出(进行到第${e.cycle ?? "?"}轮) — ${e.note || ""}`); break;
      default:
        out.push(ts + e.event);
    }
  }
  return out;
}

async function pollLog() {
  const r = await getJSON("/api/queue/log?limit=120", 6000);
  const pre = $("runLog");
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

async function pollRun() {
  const r = await hub("queue/state", null, 5000);
  const chip = $("runChip");
  if (!r.ok) {
    chip.className = "chip";
    chip.querySelector(".txt").textContent = "队列 —(调试台离线)";
    $("runCurrent").textContent = "当前: —";
    return;
  }
  chip.className = "chip " + (r.running ? "up" : "down");
  let t = r.running ? "执行中" : "空闲";
  if (r.running && r.loop && r.loop.cycle > 0 && r.loop.total !== 1)
    t += ` 第${r.loop.cycle}/${r.loop.total || "∞"}轮`;
  chip.querySelector(".txt").textContent = t;
  $("runCurrent").textContent = "当前: " + (r.current
    ? `[${sideCN(r.current.side)}] ${r.current.label}` +
      (r.running && r.current_t0 ? ` (${Math.max(0, r.now - r.current_t0).toFixed(0)}s)` : "")
    : "—");
  renderProgress(r);
  if (r.running && !state.wasRunning) state.stepDur = [];   // 新一轮运行: 清掉旧计时
  state.lastQ = r;
  refreshRunViews(r);
  updateCycles(r);
  $("runRunHint").textContent = r.running ? "执行中 — 此处保存的修改从下一次启动才生效" : "";
}

/* ---------------- 启动 ---------------- */

window.addEventListener("beforeunload", e => {
  if (state.dirty) { e.preventDefault(); e.returnValue = ""; }
});

loadDoc();
pollRun(); setInterval(pollRun, 1500);
pollDoc(); setInterval(pollDoc, 6000);
pollLog(); setInterval(pollLog, 2500);
pollHealth(); setInterval(pollHealth, 2000);
