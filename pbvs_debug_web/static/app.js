/* PBVS 调试台前端逻辑 — 原生 JS,无构建、无外部依赖 */
"use strict";

const SERIAL = { left: "262322071271", right: "262022070108" };
const ARM_NAME = { left: "Left_Arm", right: "Right_Arm" };
const REF_PATH = s =>
  `/home/tianlian/PBVS代码包/PBVS/reference_${ARM_NAME[s]}.json`;

const state = { side: "right", view: "cam", videoPaused: false, hist: null };

const $ = id => document.getElementById(id);

/* ---------------- 基础工具 ---------------- */

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

async function pbvs(path, body, timeoutMs) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const r = await fetch(`/api/${state.side}/pbvs/${path}`, { ...opt, signal: ctrl.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 500) }; }
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "请求超时" : String(e) };
  } finally { clearTimeout(timer); }
}

function pretty(obj) {
  try { return JSON.stringify(obj, null, 1); } catch { return String(obj); }
}

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function withBusy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}

const ARM_CN = { left: "左臂", right: "右臂" };

/* ---------------- 视频流(左右双路) ---------------- */

const VIDEO_EL = { left: "videoLeft", right: "videoRight" };

function videoSrc(side) {
  return `/api/${side}/video?fps=${$("fps").value}`;
}
function restartVideo() {
  for (const side of ["left", "right"]) {
    const img = $(VIDEO_EL[side]);
    if (state.view !== "cam") img.removeAttribute("src");   // 3D 视图掐断 MJPEG 省带宽
    else if (state.videoPaused) img.src = "/static/placeholder.jpg";
    else img.src = videoSrc(side);
  }
}
$("fps").addEventListener("input", () => { $("fpsVal").textContent = $("fps").value; });
$("fps").addEventListener("change", restartVideo);
$("btnPause").addEventListener("click", () => {
  state.videoPaused = !state.videoPaused;
  $("btnPause").textContent = state.videoPaused ? "恢复" : "暂停";
  restartVideo();
});

/* ---------------- ⑪ 整箱检测卡片(weilong11n_box 箱内多捆, GPU 旁路 :7020) ---------------- */

const OV_EL = { left: "ovLeft", right: "ovRight" };
const box = { timer: null, busy: false, live: false, last: {} };

function drawBoxOverlay(ctx, r) {
  /* 纯绘制: 每捆绿框 + #抓取序 + conf + 质心黄点 */
  for (const d of r.dets) {
    const [x1, y1, x2, y2] = d.box;
    ctx.strokeStyle = "#37c871"; ctx.lineWidth = 2;
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.fillStyle = "#37c871"; ctx.font = "bold 15px sans-serif";
    ctx.fillText(`#${d.order}`, x1 + 3, y1 + 15);
    ctx.font = "11px sans-serif"; ctx.fillStyle = "#9f9";
    ctx.fillText(d.conf.toFixed(2), x1 + 3, y1 + 28);
    /* 深度感知(pick/scan 结果): 框右上橙字 z=深度mm·L层号; 无深度 z?; 旧接口无此字段不画 */
    if (d.z_mm != null || d.depth_ok === false) {
      ctx.font = "bold 11px sans-serif"; ctx.fillStyle = "#fb923c";
      ctx.textAlign = "right";
      ctx.fillText(d.z_mm != null ? `z${Math.round(d.z_mm)}·L${d.layer + 1}` : "z?",
                   x2 - 3, y1 + 13);
      ctx.textAlign = "left";
    }
    if (d.centroid) {
      ctx.fillStyle = "#ff0"; ctx.beginPath();
      ctx.arc(d.centroid[0], d.centroid[1], 3, 0, 7); ctx.fill();
    }
  }
}

function drawBoxDet(side, r) {
  /* 相机小图叠加层 */
  const cv = $(OV_EL[side]), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!$("boxOv").checked) return;
  if (r.ok && r.w && cv.width !== r.w) { cv.width = r.w; cv.height = r.h; }
  if (!r.ok || !r.count) return;
  drawBoxOverlay(ctx, r);
}

function boxSides() {
  const v = $("boxSide").value;
  return v === "both" ? ["left", "right"] : [v];
}

function buildBoxSnaps() {
  const sides = boxSides();
  $("boxSnaps").className = "pose-snaps" + (sides.length > 1 ? " two" : "");
  $("boxSnaps").innerHTML = sides.map(s => `
    <figure class="pose-snap" data-side="${s}">
      <figcaption><b>${s === "left" ? "左臂相机" : "右臂相机"}</b>
        <span class="cap" id="boxCap_${s}">未检测</span></figcaption>
      <div class="video-wrap"><canvas id="boxSnap_${s}"></canvas></div>
    </figure>`).join("");
}

function drawBoxSnap(side, im, r) {
  /* 卡片快照: 检测同刻画面 + 标注 */
  const cv = $("boxSnap_" + side);
  if (!cv) return;
  const cap = $("boxCap_" + side);
  const w = im ? im.naturalWidth : (r && r.w) || 640;
  const h = im ? im.naturalHeight : (r && r.h) || 480;
  if (cv.width !== w) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (im) ctx.drawImage(im, 0, 0, w, h);
  if (r && r.ok) {
    if (r.count) drawBoxOverlay(ctx, r);
    cap.textContent = `${fmtTime(Date.now() / 1000)} · ${r.count}捆 · ${Math.round(r.infer_ms)}ms`;
    return;
  }
  ctx.fillStyle = "#aaa"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(im ? "未检出(空箱?)" : "相机不可用", w / 2, h / 2);
  ctx.textAlign = "left";
  cap.textContent = r && r.error ? "错误: " + String(r.error).slice(0, 90) : "未检出(空箱?)";
}

function renderBoxSummary() {
  /* KPI + 明细表 + 原始 JSON(所选相机聚合) */
  const sides = boxSides();
  const n = { left: null, right: null };
  let msSum = 0, msN = 0;
  const rows = [];
  for (const s of sides) {
    const r = box.last[s];
    if (!r || !r.ok) continue;
    n[s] = r.count; msSum += r.infer_ms; msN++;
    for (const d of r.dets) rows.push({ s, d });
  }
  $("boxCount").textContent = (n.left || 0) + (n.right || 0);
  $("boxL").textContent = n.left == null ? "—" : n.left;
  $("boxR").textContent = n.right == null ? "—" : n.right;
  $("boxMs").textContent = msN ? Math.round(msSum / msN) : "—";
  const t = $("boxTable");
  t.querySelector("thead").innerHTML = rows.length
    ? "<tr><th>#抓取序</th><th>相机</th><th>conf</th><th>深度 mm</th><th>层</th><th>质心 px</th><th>主轴°</th><th>框 px</th></tr>"
    : "";
  t.querySelector("tbody").innerHTML = rows.map(({ s, d }) =>
    `<tr><td>${d.order}</td><td>${s === "left" ? "左" : "右"}</td>` +
    `<td>${d.conf.toFixed(2)}</td>` +
    `<td>${d.z_mm == null ? "—" : Math.round(d.z_mm)}</td>` +
    `<td>${d.layer == null || d.layer < 0 ? "—" : d.layer + 1}</td>` +
    `<td>${d.centroid ? d.centroid.map(v => Math.round(v)).join(", ") : "—"}</td>` +
    `<td>${d.angle == null ? "—" : d.angle.toFixed(0)}</td>` +
    `<td>${d.box.map(v => Math.round(v)).join(",")}</td></tr>`).join("");
  const shown = sides.filter(s => box.last[s]);
  $("boxResult").textContent = shown.length
    ? pretty(shown.reduce((o, s) => (o[s] = box.last[s], o), {})) : "—";
}

async function boxRun() {
  if (box.busy) return;
  box.busy = true;
  const conf = Math.min(0.9, Math.max(0.05, parseFloat($("boxConf").value) || 0.3));
  for (const side of boxSides()) {
    /* 先深度感知扫描(排序+z 标签), 失败回退旧纯 2D 检测(PBVS 掉线/相机未连仍可用) */
    let r = await getJSON(`/api/${side}/pbvs/pick/scan?conf=${conf}`, 25000);
    if (!r.ok) {
      const r2 = await getJSON(`/api/${side}/boxdetect?conf=${conf}`, 20000);
      if (r2.ok) { r2.fallback = true; r = r2; }
    }
    box.last[side] = r;
    drawBoxDet(side, r);                    /* 相机小图叠加(勾选时) */
    drawBoxSnap(side, await snapImg(side), r);
  }
  renderBoxSummary();
  $("boxState").textContent = (box.live ? "连续检测中(1.5s) · " : "") +
    boxSides().map(s => {
      const r = box.last[s];
      if (!r || !r.ok) return `${s === "left" ? "左" : "右"} ✗`;
      return `${s === "left" ? "左" : "右"} ${r.count}捆` +
        (r.layers ? `·${r.layers.length}层` : "") +
        (r.fallback ? "·2D回退" : "");
    }).join(" · ");
  box.busy = false;
}

function setBoxLive(on) {
  clearInterval(box.timer);
  box.live = on;
  $("btnBoxLive").disabled = on;
  $("btnBoxOnce").disabled = on;
  $("btnBoxStop").disabled = !on;
  if (on) { boxRun(); box.timer = setInterval(boxRun, 1500); }
}

$("btnBoxOnce").addEventListener("click", () => withBusy($("btnBoxOnce"), "检测中…", boxRun));
$("btnBoxLive").addEventListener("click", () => setBoxLive(true));
$("btnBoxStop").addEventListener("click", () => setBoxLive(false));
$("boxSide").addEventListener("change", () => {
  box.last = {};
  buildBoxSnaps();
  renderBoxSummary();
});
$("boxOv").addEventListener("change", () => {
  if ($("boxOv").checked) {
    for (const s of boxSides()) if (box.last[s]) drawBoxDet(s, box.last[s]);
  } else {
    for (const s of ["left", "right"]) {
      const cv = $(OV_EL[s]);
      cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    }
  }
});
buildBoxSnaps();

/* ---------------- ⑫ 整箱抓取(深度排序 + 一键伺服, PBVS /pick/*) ---------------- */

function renderPickRun(r) {
  /* 伺服响应: 逐轮 log 在上, 完整 JSON 在下 */
  $("pickResult").textContent =
    (r.log && r.log.length ? r.log.join("\n") + "\n" + "—".repeat(24) + "\n" : "") + pretty(r);
}

function pickIdx() {
  const v = parseInt($("pickIndex").value, 10);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

function pickMaxStep() {
  const v = parseFloat($("pickStep").value);
  return Number.isFinite(v) ? v : 0.008;
}

async function refreshPickState() {
  const r = await pbvs("pick/state", null, 6000);
  if (!r.ok) {
    setChip("pickRefChip", false, r.error ? String(r.error).slice(0, 40) : "pick 不可用");
    $("pickJSrc").textContent = "J: —";
    return;
  }
  setChip("pickRefChip", !!r.has_ref,
    r.has_ref ? `参考 ✓ z≈${Math.round((r.ref_mm || [0, 0, 0])[2])}mm` : "参考 未示教",
    !r.has_ref);
  setChip("pickRunChip", !r.is_running, r.is_running ? "● 伺服中" : "空闲");
  $("btnPickStop").disabled = !r.is_running;
  $("pickJSrc").textContent =
    { box: "J: 箱口标定", aligner: "J: 复用QR标定" }[r.J_source] || "J: 无(先标定)";
}

$("btnPickGoto").addEventListener("click", () => withBusy($("btnPickGoto"), "伺服中…", async () => {
  const idx = pickIdx();
  if (!confirm(`🎯 ${ARM_CN[state.side]}闭环伺服到第 ${idx} 捆(⑪ 的深度排序)。\n` +
    `臂会逐步移动到示教参考点直至误差 <3mm(每步 ≤8mm, 发散/超时/丢检自动停)。\n确认臂周无障碍物?`)) return;
  $("btnPickStop").disabled = false;
  const r = await pbvs("pick/goto",
    { index: idx, timeout_s: 150, max_step_m: pickMaxStep() }, 300000);
  renderPickRun(r);
  if (r.status === "converged") {
    let msg = `✓ 已对准 #${idx} (XY ${r.error_xy_mm} / Z ${r.error_z_mm} mm), 可执行 ⑧ 抓取序列`;
    if ($("graspRequireAligned").checked) {
      /* ⑧ 的收敛门限认的是 QR 对准字段; 整箱伺服收敛同样可信 → 自动放开并说明 */
      $("graspRequireAligned").checked = false;
      msg += "; ⑧「需对准收敛」已自动放开";
    }
    toast(msg, "ok");
  } else if (r.ok) {
    toast(`伺服结束: ${r.status}(XY ${r.error_xy_mm ?? "—"} / Z ${r.error_z_mm ?? "—"} mm)`, "warn");
  } else {
    toast("伺服失败: " + (r.error || r.status || ""), "err");
  }
  refreshPickState();
}));

$("btnPickStep").addEventListener("click", () => withBusy($("btnPickStep"), "单步中…", async () => {
  const r = await pbvs("pick/step",
    { index: pickIdx(), max_step_m: pickMaxStep() }, 60000);
  renderPickRun(r);
  toast(r.ok ? `单步完成 — 观察移动方向, 正确再「🎯 瞄准并伺服」(XY ${r.error_xy_mm}/Z ${r.error_z_mm} mm)`
             : "单步失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshPickState();
}));

$("btnPickStop").addEventListener("click", async () => {
  const r = await pbvs("pick/stop", {}, 8000);
  $("pickResult").textContent = pretty(r);
  toast(r.ok ? "停止信号已发, 最近检查点停下" : "停止失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  refreshPickState();
});

$("btnPickTeach").addEventListener("click", () => withBusy($("btnPickTeach"), "示教中…", async () => {
  const idx = pickIdx();
  if (!confirm(`把${ARM_CN[state.side]}当前位姿录为「#${idx} 捆」的抓取参考点?\n` +
    `前提: 此刻臂正悬停在该捆正上方的正确抓取高度(先手动微调到位再示教)。`)) return;
  const r = await pbvs("pick/teach", { index: idx }, 30000);
  $("pickResult").textContent = pretty(r);
  toast(r.ok ? `参考已示教(#${idx}, z=${Math.round(r.z_mm)}mm) — 之后任意捆一键伺服到它`
             : "示教失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshPickState();
}));

$("btnPickCalib").addEventListener("click", () => withBusy($("btnPickCalib"), "J 标定中(臂在移动)…", async () => {
  const idx = pickIdx();
  if (!confirm(`以箱内第 ${idx} 捆为标记做 J 箱口重标定:\n${ARM_CN[state.side]}沿基座 X/Y/Z 各 ±8mm 微动, 约 2–3 分钟(每点连测 3 次取中值)。\n建议序号选一个与邻捆间隔明显的大捆(检测最稳)。确认臂周无障碍物?`)) return;
  const r = await pbvs("pick/calibrate", { index: idx }, 300000);
  $("pickResult").textContent = pretty(r);
  renderQcPills("pickQc", r.col_norms, r.cond);
  toast(r.ok ? "J 箱口标定完成, 质检见绿标" : "J 标定失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  refreshPickState();
}));

$("btnPickScan").addEventListener("click", () => withBusy($("btnPickScan"), "扫描中…", async () => {
  await boxRun();
  const s = box.last[state.side];
  $("pickScanInfo").textContent =
    s && s.ok ? `${s.count}捆${s.layers ? `·${s.layers.length}层` : ""}${s.fallback ? "·2D回退" : ""}` +
                ` · 最上层=#1${s.J_source ? ` · J=${s.J_source}` : ""}`
              : "扫描失败: " + String((s && s.error) || "").slice(0, 60);
  refreshPickState();
}));

refreshPickState();
setInterval(refreshPickState, 3000);   /* 伺服期间 run 状态/停止按钮实时跟随 */

/* ---------------- ⑩ 单袋抓取联动 (位置伺服 + 腕角对齐, PBVS /bag/*) ---------------- */

function bagIdx() {
  /* 输入框的袋#=⑩表序(=⑭深度层序: 最近层左→右); PBVS bag/* 内部还是旧画面序
     → 用最近一次⑩检测结果把显示序换算成 PBVS 内部序(bag_order)。无检测数据则原样传。 */
  let v = parseInt($("bagIndex").value, 10);
  if (!Number.isFinite(v) || v < 1) v = 1;
  const r = pose.last[state.side];
  const d = r && r.ok && r.dets && r.dets[v - 1];
  return (d && d.bag_order) || v;
}

function renderBagRun(r) {
  $("bagResult").textContent =
    (r.log && r.log.length ? r.log.join("\n") + "\n" + "—".repeat(24) + "\n" : "") + pretty(r);
}

async function refreshBagState() {
  const r = await pbvs("bag/state", null, 6000);
  if (!r.ok) {
    setChip("bagRefChip", false, r.error ? String(r.error).slice(0, 40) : "bag 不可用");
    setChip("bagRunChip", true, "空闲");
    $("bagAngInfo").textContent = "角: —";
    return;
  }
  setChip("bagRefChip", !!r.has_ref,
    r.has_ref ? `参考 ✓ α${r.head_deg_ref}°@z${Math.round((r.ref_mm || [0, 0, 0])[2])}mm`
              : "参考 未示教",
    !r.has_ref);
  setChip("bagRunChip", !r.is_running, r.is_running ? "● 伺服中" : "空闲");
  $("btnBagStop").disabled = !r.is_running;
  $("bagAngInfo").textContent = r.has_ref
    ? `α_ref ${Math.round(r.head_deg_ref)}° · rz ${Math.round(r.rz_deg_ref)}° · 转向 ${r.rz_sign == null ? "未定" : (r.rz_sign > 0 ? "+" : "−")}`
    : "角: —";
}

$("btnBagGoto").addEventListener("click", () => withBusy($("btnBagGoto"), "伺服中…", async () => {
  const idx = bagIdx();
  const align = $("bagAlignAngle").checked;
  if (!confirm(`🎯 ${ARM_CN[state.side]}对第 ${idx} 袋闭环伺服(${align ? "位置 + 腕角对齐" : "仅位置"})。\n` +
    `位置每步随 ⑫ 步长下拉(≤8mm 默认), 腕角单次 ≤50°; 发散/超时/丢检自动停。\n确认臂周无障碍物?`)) return;
  $("btnBagStop").disabled = false;
  const r = await pbvs("bag/goto",
    { index: idx, timeout_s: 150, align_angle: align, max_step_m: pickMaxStep() }, 300000);
  renderBagRun(r);
  if (r.status === "converged") {
    let msg = `✓ 已对齐 #${idx} (XY ${r.error_xy_mm} / Z ${r.error_z_mm} mm / 角 ${r.error_ang_deg ?? "—"}°), 可执行 ⑧ 抓取序列`;
    if ($("graspRequireAligned").checked) {
      $("graspRequireAligned").checked = false;   /* 同 ⑫: ⑧ 门限只认 QR 对准字段 */
      msg += "; ⑧「需对准收敛」已自动放开";
    }
    toast(msg, "ok");
  } else if (r.ok) {
    toast(`伺服结束: ${r.status}(XY ${r.error_xy_mm ?? "—"} / Z ${r.error_z_mm ?? "—"} / 角 ${r.error_ang_deg ?? "—"}°)`, "warn");
  } else {
    toast("伺服失败: " + (r.error || r.status || ""), "err");
  }
  refreshBagState();
}));

$("btnBagStep").addEventListener("click", () => withBusy($("btnBagStep"), "单步中…", async () => {
  const r = await pbvs("bag/step",
    { index: bagIdx(), align_angle: $("bagAlignAngle").checked, max_step_m: pickMaxStep() }, 60000);
  renderBagRun(r);
  toast(r.ok ? `单步完成 — 观察移动方向(XY ${r.error_xy_mm}/Z ${r.error_z_mm}/角 ${r.error_ang_deg ?? "—"}°)`
             : "单步失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshBagState();
}));

$("btnBagStop").addEventListener("click", async () => {
  const r = await pbvs("bag/stop", {}, 8000);
  $("bagResult").textContent = pretty(r);
  toast(r.ok ? "停止信号已发, 最近检查点停下" : "停止失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  refreshBagState();
});

$("btnBagTeach").addEventListener("click", () => withBusy($("btnBagTeach"), "示教中…", async () => {
  const idx = bagIdx();
  if (!confirm(`把${ARM_CN[state.side]}当前位姿录为「#${idx} 袋」的抓取参考点?\n` +
    `前提: 此刻爪正悬停在该袋上方的正确抓取高度, 且腕角已对齐袋主轴(爪指垂直于头→尾方向)。\n` +
    `会同时记录 袋3D位置 + 袋头方向角 + 法兰rz, 之后任意袋一键伺服复现。`)) return;
  const r = await pbvs("bag/teach", { index: idx }, 30000);
  $("bagResult").textContent = pretty(r);
  toast(r.ok ? `参考已示教(#${idx}, z=${Math.round(r.z_mm)}mm, α=${r.head_deg_ref}°) — 之后任意袋一键伺服`
             : "示教失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshBagState();
}));

refreshBagState();
setInterval(refreshBagState, 3000);

/* ---------------- ⑬ 工具标定 (TCP 多点法: 法兰多点 → 最小二乘解工具尖平移) ---------------- */

const tc = { solved: null };

async function tcPost(op) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`/api/${state.side}/toolcal`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op }), signal: ctrl.signal });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { ok: false, error: text.slice(0, 300) }; }
  } catch (e) {
    return { ok: false, error: e.name === "AbortError" ? "请求超时" : String(e) };
  } finally { clearTimeout(timer); }
}

function renderToolcal(r) {
  /* 点表 + 已记录数(r = toolcal list 响应) */
  $("tcCount").textContent = r.count;
  const t = $("tcTable");
  t.querySelector("thead").innerHTML = r.count
    ? "<tr><th>#</th><th>时间</th><th>法兰 x/y/z mm</th><th>rpy °</th></tr>" : "";
  t.querySelector("tbody").innerHTML = (r.points || []).map((p, i) =>
    `<tr><td>${i + 1}</td><td>${fmtTime(p.t)}</td>` +
    `<td>${p.pos_mm.join(", ")}</td><td>${p.rpy_deg.join(", ")}</td></tr>`).join("");
}

function tcShowSolve(s) {
  /* KPI + 质检 pills + 「应用」按钮使能; s = solve 响应(或 {ok:false} 清空) */
  $("tcT").textContent = s.ok ? s.t_mm.join(", ") : "—";
  $("tcRms").textContent = s.ok ? s.rms_mm : "—";
  $("tcSpread").textContent = s.ok ? s.orient_spread_deg : "—";
  const pill = (pass, text) =>
    `<span class="pill ${pass ? "pass" : "fail"}">${pass ? "✓" : "✗"} ${text}</span>`;
  $("tcQc").innerHTML = s.ok ? [
    pill(s.n >= 3, `点数 ${s.n} ≥3(建议4)`),
    pill(s.rms_mm < 2.5, `残差RMS ${s.rms_mm}mm <2.5(优<1)`),
    pill(s.orient_spread_deg >= 10, `姿态差 ${s.orient_spread_deg}° ≥10°(建议≥15°)`),
  ].join("") : "";
  $("btnTcApply").disabled = !s.ok;
}

async function tcRefresh() {
  const r = await tcPost("list");
  if (r.ok) renderToolcal(r);
  else $("tcCount").textContent = "—";
}

function tcResetSide() {
  /* 切臂: 标定点按臂存在后端, 求解结果只属本臂 → 清空本地解 */
  tc.solved = null;
  tcShowSolve({ ok: false });
  $("tcResult").textContent = "—";
  tcRefresh();
}

$("btnTcRec").addEventListener("click", () => withBusy($("btnTcRec"), "记录中…", async () => {
  const r = await tcPost("record");
  if (!r.ok) { toast("记录失败: " + (r.error || ""), "err"); return; }
  renderToolcal(r);
  toast(`✓ 第 ${r.count} 点已记录(当前法兰位姿)`, "ok");
}));

$("btnTcUndo").addEventListener("click", async () => {
  const r = await tcPost("undo");
  if (!r.ok) return;
  renderToolcal(r);
  tc.solved = null;
  tcShowSolve({ ok: false });
});

$("btnTcClear").addEventListener("click", async () => {
  if (!confirm(`清空${ARM_CN[state.side]}全部标定点?`)) return;
  const r = await tcPost("clear");
  if (!r.ok) return;
  renderToolcal(r);
  tc.solved = null;
  tcShowSolve({ ok: false });
  $("tcResult").textContent = "—";
  toast("已清空", "ok");
});

$("btnTcSolve").addEventListener("click", () => withBusy($("btnTcSolve"), "求解中…", async () => {
  const r = await tcPost("solve");
  $("tcResult").textContent = pretty(r);
  if (!r.ok) { toast("求解失败: " + (r.error || ""), "err"); return; }
  tc.solved = r;
  tcShowSolve(r);
  toast(r.qc_pass
    ? `✓ TCP 平移 = ${r.t_mm.join(", ")} mm(RMS ${r.rms_mm}mm)`
    : `⚠ 解出 ${r.t_mm.join(", ")} mm 但质检有红标 — 建议补姿态差异大的点重解`,
    r.qc_pass ? "ok" : "warn");
}));

$("btnTcApply").addEventListener("click", () => withBusy($("btnTcApply"), "应用中…", async () => {
  const s = tc.solved;
  if (!s || !s.ok) { toast("先「求解 TCP」", "err"); return; }
  if (!$("tcConfirm").checked) { toast("先勾选「确认覆盖」", "err"); return; }
  const cur = await pbvs("cart/tool", null, 8000);
  if (!cur.ok) { toast("读当前工具系失败: " + (cur.error || ""), "err"); return; }
  const deg = v => ((v || 0) * 180 / Math.PI).toFixed(0);
  const body = {
    x: s.t_mm[0] / 1000, y: s.t_mm[1] / 1000, z: s.t_mm[2] / 1000,
    rx: cur.rx || 0, ry: cur.ry || 0, rz: cur.rz || 0,   /* 旋转分量沿用当前值 */
  };
  if (!confirm(`把${ARM_CN[state.side]}工具坐标系平移覆盖为\n  X ${s.t_mm[0]}  Y ${s.t_mm[1]}  Z ${s.t_mm[2]} mm ?\n` +
    `旋转分量保持当前值(${deg(cur.rx)}, ${deg(cur.ry)}, ${deg(cur.rz)}°)。\n` +
    `保存后立即生效并持久化; ⑦点动/示教回放的控制点变为工具尖。`)) return;
  const r = await pbvs("cart/tool", body, 15000);
  $("tcResult").textContent = pretty(r);
  toast(r.ok ? `✓ 工具坐标系已生效: 平移 ${s.t_mm.join(", ")} mm — ⑦/goto 控制点 = 工具尖`
             : "应用失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollCartFk();
}));

tcRefresh();

/* ---------------- ⑭ 单袋吸取 (suction_bag.py 一键复现, 仅左臂) ---------------- */

async function suctRun() {
  if (state.side !== "left") { toast("单袋吸取目前仅左臂(示教点/偏移都在左臂)", "err"); return; }
  const body = { run: "direct",
                 index: parseInt($("suctIndex").value, 10) || 1 };   /* 多袋选第几袋 */
  const msg = "直线直达: 原地测袋心→一条合成直线到袋心上方(XYZ 同动不分段; 本按钮不带压紧, 到位即停)";
  const idxTxt = `第 ${body.index} 袋(深度序, #1=离相机最近=最上层)`;
  if (!confirm(`⑭ 左臂${idxTxt}${msg}。\n⚠ 不先回放扫描位 — 请确认臂当前停在看得到全部袋的机位。\n机械臂会移动, 确认臂周无人无障碍物?`)) return;
  setChip("suctChip", false, "● 运行中", true);
  $("btnSuctDirect").disabled = true;
  $("suctResult").textContent = "运行中…(原地扫描+直线直达, 约10-30s)";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 200000);
  try {
    const r = await fetch(`/api/${state.side}/suctionbag`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: ctrl.signal });
    const d = await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
    $("suctResult").textContent = d.log || d.error || "—";
    setChip("suctChip", true, "空闲");
    toast(d.ok ? "⑭ 完成 — 嘴已对准袋心(看日志残差)" : "⑭ 中止/失败, 日志已显示",
          d.ok ? "ok" : "err");
  } catch (e) {
    $("suctResult").textContent = "请求失败: " + (e.name === "AbortError" ? "超时(200s)" : e);
    setChip("suctChip", true, "空闲");
    toast("⑭ 请求失败", "err");
  } finally {
    clearTimeout(timer);
    $("btnSuctDirect").disabled = false;
  }
}

/* 🎯 直线直达吸取位: 原地测袋心→一条合成直线到袋心上方(不回放扫描位, server 传 --no-scan-move;
   臂须已停在能看全袋群的机位)。队列版(btnQSuct)行为一致(queue_hub 同传该参数) */
$("btnSuctDirect").addEventListener("click", () => suctRun());

/* ＋队列·直线吸取: ⑭ 直线直达(同样不回放扫描位, 在轮到它时的当前臂位扫; 到位即停, 不压紧 —
   压紧/开真空在⑧序列)入 ⑨/⑮ 队列, 轮到才动臂; ⚠循环里⑧结束后臂在袋上, 下轮⑭扫不到袋会拦下整队 */
$("btnQSuct").addEventListener("click", () => {
  if (state.side !== "left") { toast("单袋吸取目前仅左臂(示教点/偏移都在左臂)", "err"); return; }
  const idx = parseInt($("suctIndex").value, 10) || 1;
  qAdd([{ kind: "suction",
          label: `⑭直线吸取: 第${idx}袋`,
          params: { run: "direct", index: idx } }]);
});

/* 📌 存对准位: 手摆到正确吸取悬停位后, 当前位姿(含 pose_tcp)覆盖存「对准中心位置」
   — 直线直达的终点腕姿态(rpy)与袋高护栏基准取自它; 换台面(袋高差>250mm被拦)/⑬重标TCP后重录一次 */
$("btnSuctTeach").addEventListener("click", () => withBusy($("btnSuctTeach"), "存中…", async () => {
  if (state.side !== "left") { toast("单袋吸取目前仅左臂(示教点/偏移都在左臂)", "err"); return; }
  if (!confirm("把左臂当前位姿覆盖存为「对准中心位置」?\n" +
      "前提: 臂已手动摆到正确吸取悬停位(吸盘嘴轻贴袋面), 腕姿态=想要的吸取姿态。\n" +
      "直线直达的终点腕姿态与袋高护栏基准(±250mm 内自动跟袋面)都取自它 — 换台面/⑬重标TCP后重录一次即可。")) return;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  let d;
  try {
    const r = await fetch(`/api/${state.side}/suctionbag`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run: "teach" }), signal: ctrl.signal });
    d = await r.json().catch(() => ({ ok: false, error: "响应解析失败" }));
  } catch (e) {
    d = { ok: false, error: e.name === "AbortError" ? "超时(30s)" : String(e) };
  } finally { clearTimeout(timer); }
  $("suctResult").textContent = d.log || d.error || "—";
  toast(d.ok ? "✓ 对准位已存 — 直线姿态/护栏基准已更新" : "存对准位失败: " + (d.error || ""),
        d.ok ? "ok" : "err");
}));

/* ---------------- ⑩ 姿态检测卡片(weilong11n_pose 正/反+4脚点, GPU 旁路 :7020) ---------------- */

const OV_POSE_EL = { left: "ovPoseLeft", right: "ovPoseRight" };
const pose = { timer: null, busy: false, live: false, last: {} };
const ACT_TXT = { ok: "✓可抓", rotate: "⟳调转", flip: "⇄翻面", none: "?" };
const CLS_COL = { front: "#37c871", back: "#ff9f2e" };   // 正面绿 / 反面橙

function quadHull(pts) {
  /* 4 脚点绕质心按极角排序 → 四边形轮廓(不依赖标注角点顺序) */
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return [...pts].sort((a, b) =>
    Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
}

function drawPoseOverlay(ctx, r) {
  /* 纯绘制(相机叠加层与卡片快照共用); 调用方负责 canvas 尺寸与清屏
     #N = ⑭同款深度层序(离相机最近=最上层先, 同层左→右) — 只在 det 带 p_base_mm(=代理已按层重排, 左臂)时标;
     右臂无手眼无层序 → 不标#, 防旧画面序冒充层序误导(10-08) */
  r.dets.forEach((d, di) => {
    const col = CLS_COL[d.cls] || "#fff";
    const k = d.kpts || [];
    if (k.length === 4) {
      /* 四边形轮廓 + 半透明填充 */
      const quad = quadHull(k);
      ctx.beginPath();
      quad.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.globalAlpha = 0.15; ctx.fillStyle = col; ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
      /* 头部方向箭头: 尾(3,4)中点 → 头(1,2)中点 */
      const hx = (k[0][0] + k[1][0]) / 2, hy = (k[0][1] + k[1][1]) / 2;
      const tx = (k[2][0] + k[3][0]) / 2, ty = (k[2][1] + k[3][1]) / 2;
      const ang = Math.atan2(hy - ty, hx - tx);
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
      ctx.beginPath();
      for (const s of [-1, 1]) {          /* 箭头两翼(±150°) */
        const a2 = ang + s * 2.618;
        ctx.moveTo(hx, hy);
        ctx.lineTo(hx + 11 * Math.cos(a2), hy + 11 * Math.sin(a2));
      }
      ctx.stroke();
      /* 头部两脚点(1、2)白点 */
      ctx.fillStyle = "#fff";
      for (const p of [k[0], k[1]]) { ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7); ctx.fill(); }
    } else {
      const [x1, y1, x2, y2] = d.box;    /* 脚点缺失退化为画框 */
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    }
    /* 标签: 正/反 + conf + 整姿决策, 放头部中点上方 */
    const o = d.orient || {};
    const num = d.p_base_mm != null ? `#${d.order} ` : "";   // 无基座3D=未重排(右臂), 不标#
    let label = `${num}${d.cls === "front" ? "正" : "反"} ${d.conf.toFixed(2)} ${ACT_TXT[o.action] || ""}`;
    if (o.action === "rotate" && o.rotate_deg != null)
      label += Math.abs(o.rotate_deg).toFixed(0) + "°";
    const lx = k.length === 4 ? (k[0][0] + k[1][0]) / 2 - 24 : d.box[0] + 3;
    const ly = (k.length === 4 ? (k[0][1] + k[1][1]) / 2 : d.box[1] + 15) - 8;
    ctx.font = "bold 14px sans-serif";
    ctx.fillStyle = col;
    ctx.fillText(label, lx, ly);
    if (d.centroid) {
      ctx.fillStyle = "#ff0"; ctx.beginPath();
      ctx.arc(d.centroid[0], d.centroid[1], 3, 0, 7); ctx.fill();
    }
  });
}

function drawPoseDet(side, r) {
  /* 相机小图叠加层 */
  const cv = $(OV_POSE_EL[side]), ctx = cv.getContext("2d");
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!$("poseOv").checked) return;
  if (r.ok && r.w && cv.width !== r.w) { cv.width = r.w; cv.height = r.h; }
  if (!r.ok || !r.count) return;
  drawPoseOverlay(ctx, r);
}

function poseSides() {
  const v = $("poseSide").value;
  return v === "both" ? ["left", "right"] : [v];
}

function buildPoseSnaps() {
  const sides = poseSides();
  $("poseSnaps").className = "pose-snaps" + (sides.length > 1 ? " two" : "");
  $("poseSnaps").innerHTML = sides.map(s => `
    <figure class="pose-snap" data-side="${s}">
      <figcaption><b>${s === "left" ? "左臂相机" : "右臂相机"}</b>
        <span class="cap" id="poseCap_${s}">未检测</span></figcaption>
      <div class="video-wrap"><canvas id="poseSnap_${s}"></canvas></div>
    </figure>`).join("");
}

function snapImg(side) {
  /* 拉一帧 preview JPEG(带时间戳防缓存) */
  return new Promise(res => {
    const im = new Image();
    im.onload = () => res(im);
    im.onerror = () => res(null);
    im.src = `/api/${side}/snapshot?t=${Date.now()}`;
  });
}

function drawPoseSnap(side, im, r) {
  /* 卡片快照: 检测同刻画面 + 标注 */
  const cv = $("poseSnap_" + side);
  if (!cv) return;
  const cap = $("poseCap_" + side);
  const w = im ? im.naturalWidth : (r && r.w) || 640;
  const h = im ? im.naturalHeight : (r && r.h) || 480;
  if (cv.width !== w) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext("2d");
  ctx.fillStyle = "#000"; ctx.fillRect(0, 0, w, h);
  if (im) ctx.drawImage(im, 0, 0, w, h);
  if (r && r.ok) {
    if (r.count) drawPoseOverlay(ctx, r);
    cap.textContent = `${fmtTime(Date.now() / 1000)} · ${r.count}袋 · ${Math.round(r.infer_ms)}ms`;
    return;
  }
  ctx.fillStyle = "#aaa"; ctx.font = "14px sans-serif"; ctx.textAlign = "center";
  ctx.fillText(im ? "未检出" : "相机不可用", w / 2, h / 2);
  ctx.textAlign = "left";
  cap.textContent = r && r.error ? "错误: " + String(r.error).slice(0, 90) : "未检出";
}

function renderPoseSummary() {
  /* KPI + 明细表 + 原始 JSON(所选相机聚合) */
  const sides = poseSides();
  let count = 0, back = 0, msSum = 0, msN = 0;
  const acts = { ok: 0, rotate: 0, flip: 0, none: 0 };
  const rows = [];
  for (const s of sides) {
    const r = pose.last[s];
    if (!r || !r.ok) continue;
    count += r.count; msSum += r.infer_ms; msN++;
    for (const d of r.dets) {
      if (d.cls !== "front") back++;
      const o = d.orient || {};
      if (o.action in acts) acts[o.action]++;
      rows.push({ s, d, o });
    }
  }
  $("poseCount").textContent = count;
  $("poseFR").textContent = `${count - back} / ${back}`;
  $("poseActs").textContent = `${acts.ok} ${acts.rotate} ${acts.flip}`;
  $("poseMs").textContent = msN ? Math.round(msSum / msN) : "—";
  const t = $("poseTable");
  t.querySelector("thead").innerHTML = rows.length
    ? "<tr><th>#</th><th>相机</th><th>类别</th><th>conf</th><th>整姿动作</th><th>头部偏角</th><th>质心 px</th><th>主轴°</th><th>相机3D mm</th><th>基座3D mm</th></tr>"
    : "";
  t.querySelector("tbody").innerHTML = rows.map(({ s, d, o }) => {
    const act = o.action === "ok" ? "✓ 可抓"
      : o.action === "rotate" ? `⟳ 调转 ${(o.rotate_deg || 0).toFixed(0)}°`
      : o.action === "flip" ? "⇄ 翻面" : "?";
    const ord = d.p_base_mm != null ? d.order : "—";   // 无层序(右臂)不显#, 与画面一致
    return `<tr><td>${ord}</td><td>${s === "left" ? "左" : "右"}</td>` +
      `<td style="color:${d.cls === "front" ? "var(--good)" : "var(--warn)"};font-weight:600">` +
      `${d.cls === "front" ? "正面" : "反面"}</td>` +
      `<td>${d.conf.toFixed(2)}</td><td style="text-align:left">${act}</td>` +
      `<td>${o.head_dev_deg == null ? "—" : o.head_dev_deg.toFixed(0) + "°"}</td>` +
      `<td>${d.centroid ? d.centroid.map(v => Math.round(v)).join(", ") : "—"}</td>` +
      `<td>${d.angle == null ? "—" : d.angle.toFixed(0)}</td>` +
      `<td>${d.p3d_mm ? d.p3d_mm.map(v => Math.round(v)).join(", ") : "—"}</td>` +
      `<td>${d.p_base_mm ? d.p_base_mm.map(v => Math.round(v)).join(", ") : "—"}</td></tr>`;
  }).join("");
  const shown = sides.filter(s => pose.last[s]);
  $("poseResult").textContent = shown.length
    ? pretty(shown.reduce((o, s) => (o[s] = pose.last[s], o), {})) : "—";
}

async function poseRun() {
  if (pose.busy) return;
  pose.busy = true;
  const conf = Math.min(0.9, Math.max(0.05, parseFloat($("poseConf").value) || 0.25));
  for (const side of poseSides()) {
    let r = null;
    try { r = await getJSON(`/api/${side}/posedetect?conf=${conf}`, 25000); } catch (_) {}
    r = r || { ok: false, error: "请求失败" };
    pose.last[side] = r;
    drawPoseDet(side, r);                    /* 相机小图叠加(勾选时) */
    drawPoseSnap(side, await snapImg(side), r);
  }
  renderPoseSummary();
  $("poseState").textContent = (pose.live ? "连续检测中(1.5s) · " : "") +
    poseSides().map(s => `${s === "left" ? "左" : "右"} ` +
      (pose.last[s] && pose.last[s].ok ? pose.last[s].count + "袋" : "✗")).join(" · ");
  pose.busy = false;
}

function setPoseLive(on) {
  clearInterval(pose.timer);
  pose.live = on;
  $("btnPoseLive").disabled = on;
  $("btnPoseOnce").disabled = on;
  $("btnPoseStop").disabled = !on;
  if (on) { poseRun(); pose.timer = setInterval(poseRun, 1500); }
}

$("btnPoseOnce").addEventListener("click", () => withBusy($("btnPoseOnce"), "检测中…", poseRun));
$("btnPoseLive").addEventListener("click", () => setPoseLive(true));
$("btnPoseStop").addEventListener("click", () => setPoseLive(false));
$("poseSide").addEventListener("change", () => {
  pose.last = {};
  buildPoseSnaps();
  renderPoseSummary();
});
$("poseOv").addEventListener("change", () => {
  if ($("poseOv").checked) {
    for (const s of poseSides()) if (pose.last[s]) drawPoseDet(s, pose.last[s]);
  } else {
    for (const s of ["left", "right"]) {
      const cv = $(OV_POSE_EL[s]);
      cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    }
  }
});
buildPoseSnaps();

/* ---------------- ⑩ 采集集存帧 (TinyCNN 重训数据, 袋怎么摆就点什么) ---------------- */

async function refreshColCount() {
  const r = await getJSON(`/api/${state.side}/collect`, 6000);
  $("colCount").textContent = r.ok ? `正 ${r.front} / 反 ${r.back} 张` : "采集集 —";
}

async function colSave(label) {
  const r = await fetch(`/api/${state.side}/collect`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  const d = await r.json().catch(() => ({}));
  toast(d.ok ? `📥 已存 ${label === "front" ? "正面" : "反面"}帧(共 ${d.count} 张) — 挪动一下袋子再存下一张`
             : "存帧失败: " + (d.error || ""), d.ok ? "ok" : "err");
  refreshColCount();
}

$("btnColFront").addEventListener("click", () => colSave("front"));
$("btnColBack").addEventListener("click", () => colSave("back"));
refreshColCount();

/* ---------------- 视图切换(相机 / 3D)与左右臂切换 ---------------- */

function setView(v) {
  if (v === state.view) return;
  state.view = v;
  document.querySelectorAll("#viewTabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === v));
  $("viewCam").hidden = v !== "cam";
  $("view3d").hidden = v !== "3d";
  $("viewbarHint").textContent = v === "cam" ? "点击相机画面选用左/右臂" : "拖拽旋转 · 滚轮缩放 · 右键平移";
  restartVideo();
  document.dispatchEvent(new CustomEvent("pbvs-view", { detail: v }));
}
$("viewTabs").addEventListener("click", e => {
  const btn = e.target.closest("button[data-view]");
  if (btn) setView(btn.dataset.view);
});

function switchSide(side) {
  if (side === state.side) return;
  state.side = side;
  document.querySelectorAll("#tabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.side === side));
  $("camCardLeft").classList.toggle("active", side === "left");
  $("camCardRight").classList.toggle("active", side === "right");
  $("statusSide").textContent = side;
  $("logSide").textContent = side;
  $("camSerial").value = SERIAL[side];
  restartVideo();
  refreshTargets(); refreshParams(); refreshReference(); pollTail(); pollHistory();
  refreshTp(); pollCartFk(); refreshGraspPresets(); pollQueue(); refreshSpeed(); refreshOffset();
  refreshQPresets();
  refreshPickState();
  refreshBagState();
  tcResetSide();
  document.dispatchEvent(new CustomEvent("pbvs-side", { detail: side }));
}
$("tabs").addEventListener("click", e => {
  const btn = e.target.closest("button[data-side]");
  if (btn) switchSide(btn.dataset.side);
});
$("camCardLeft").addEventListener("click", () => switchSide("left"));
$("camCardRight").addEventListener("click", () => switchSide("right"));

/* ---------------- 健康与状态轮询 ---------------- */

function chipHTML(id) { return `<span class="chip" id="${id}"><span class="dot"></span><span class="txt"></span></span>`; }
$("health").innerHTML =
  chipHTML("hL") + chipHTML("hR") + chipHTML("hArm") + chipHTML("hCamL") + chipHTML("hCamR");

function setChip(id, ok, text, warn) {
  const el = $(id);
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
  for (const [side, id] of [["left", "hCamL"], ["right", "hCamR"]]) {
    const s = h.sides[side];
    setChip(id, !!s.camera_running, `相机${side === "left" ? "L" : "R"} ${s.camera_running ? "取流" : s.camera_attached ? "挂载" : "未连"}`, !s.camera_running && s.camera_attached);
  }
}

const STAGE = { 0: "已达标", 1: "Stage1 XY", 2: "Stage2 Z", "—": "—" };

async function pollStatus() {
  const st = await pbvs("status", null, 5000);
  const al = st.aligner || {};
  $("errXY").textContent = al.current_error_xy_m != null ? (al.current_error_xy_m * 1000).toFixed(1) : "—";
  $("errZ").textContent = al.current_error_z_m != null ? (al.current_error_z_m * 1000).toFixed(1) : "—";
  $("iter").textContent = al.iteration_count != null ? al.iteration_count : "—";
  const s = al.current_stage;
  $("stage").textContent = s == null ? "—" : (STAGE[s] || "S" + s);
  $("alignState").textContent = al.is_running ? "● 对准运行中" : (al.has_target ? "有目标" : "无目标");
  $("alignState").style.color = al.is_running ? "var(--good)" : "var(--muted)";
  const log = (al.log || []).join("\n");
  const pre = $("alignLog");
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = log || "暂无日志";
  if (stick) pre.scrollTop = pre.scrollHeight;
}

async function pollJoints() {
  const j = await getJSON("/api/arm/joints", 5000);
  const tb = $("joints").querySelector("tbody");
  const th = $("joints").querySelector("thead");
  if (!j.ok || !j.data) { tb.innerHTML = `<tr><td colspan="8">:8000 不可达(${j.error || "等待缓存"})</td></tr>`; return; }
  const d = j.data;
  th.innerHTML = "<tr><th>关节(deg)</th>" + [1, 2, 3, 4, 5, 6, 7].map(i => `<th>J${i}</th>`).join("") + "</tr>";
  const row = (name, arr) => `<tr><td>${name}</td>` + arr.map(v => `<td>${v.toFixed(1)}</td>`).join("") + "</tr>";
  tb.innerHTML =
    row("左臂", d.armleft_joint_angle_deg || []) +
    row("右臂", d.armright_joint_angle_deg || []);
}

async function pollTail() {
  const r = await getJSON(`/api/${state.side}/tail?lines=120`, 6000);
  const pre = $("procLog");
  if (!r.ok) { pre.textContent = r.error || "读取失败"; return; }
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = r.lines.join("\n");
  if (stick) pre.scrollTop = pre.scrollHeight;
}

/* ---------------- 误差曲线(canvas) ---------------- */

const chart = {
  cv: $("chart"), tip: null, hover: null,
  pad: { l: 42, r: 46, t: 10, b: 20 },
};

function niceStep(range) {
  const raw = range / 4;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * pow) return m * pow;
  return 10 * pow;
}

function drawChart() {
  const cv = chart.cv, ctx = cv.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const css = getComputedStyle(document.documentElement);
  const C = {
    grid: css.getPropertyValue("--grid"), axis: css.getPropertyValue("--axis"),
    muted: css.getPropertyValue("--muted"), ink2: css.getPropertyValue("--ink-2"),
    s1: css.getPropertyValue("--s1"), s2: css.getPropertyValue("--s2"),
  };
  const H = state.hist;
  const p = chart.pad;
  const iw = w - p.l - p.r, ih = h - p.t - p.b;

  ctx.font = "11px system-ui";
  if (!H || H.t.length < 2) {
    ctx.fillStyle = C.muted; ctx.textAlign = "center";
    ctx.fillText("暂无误差历史 — 对准运行后开始记录(每秒采样)", w / 2, h / 2);
    return;
  }
  const t0 = H.t[0], t1 = H.t[H.t.length - 1];
  const tSpan = Math.max(2, t1 - t0);
  const yMax = Math.max(5, Math.max(...H.xy, ...H.z) * 1.15);
  const X = t => p.l + ((t - t0) / tSpan) * iw;
  const Y = v => p.t + ih - (v / yMax) * ih;

  // 横向网格 + 刻度
  ctx.strokeStyle = C.grid; ctx.fillStyle = C.muted;
  ctx.textAlign = "right"; ctx.lineWidth = 1;
  const step = niceStep(yMax);
  for (let v = 0; v <= yMax; v += step) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath(); ctx.moveTo(p.l, y); ctx.lineTo(w - p.r, y); ctx.stroke();
    ctx.fillText(v, p.l - 6, y + 3.5);
  }
  // 时间刻度(两端)
  ctx.textAlign = "center";
  ctx.fillText(fmtTime(t0), p.l, h - 6);
  ctx.fillText(fmtTime(t1), w - p.r, h - 6);

  // 收敛门限 3mm(虚线,弱化)
  ctx.strokeStyle = C.muted; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(p.l, Y(3)); ctx.lineTo(w - p.r, Y(3)); ctx.stroke();
  ctx.setLineDash([]);

  // 系列
  const series = [["XY", H.xy, C.s1], ["Z", H.z, C.s2]];
  for (const [, arr, color] of series) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    arr.forEach((v, i) => { const x = X(H.t[i]), y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
  // 直接标签(右端短线 + 文本,文本用次级墨色)
  for (const [name, arr, color] of series) {
    const y = Y(arr[arr.length - 1]);
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w - p.r + 4, y); ctx.lineTo(w - p.r + 12, y); ctx.stroke();
    ctx.fillStyle = C.ink2; ctx.textAlign = "left"; ctx.fillText(name, w - p.r + 15, y + 3.5);
  }

  // 悬停十字线
  if (chart.hover != null) {
    const hx = X(chart.hover);
    ctx.strokeStyle = C.axis; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(hx, p.t); ctx.lineTo(hx, p.t + ih); ctx.stroke();
  }
  chart._geom = { t0, t1, tSpan, p, w, h, iw };
}

function chartTooltip(e) {
  const g = chart._geom;
  if (!g || !state.hist || state.hist.t.length < 2) return;
  const rect = chart.cv.getBoundingClientRect();
  const x = e.clientX - rect.left;
  if (x < g.p.l || x > g.w - g.p.r) { chart.tip.style.display = "none"; chart.hover = null; return; }
  const t = g.t0 + ((x - g.p.l) / g.iw) * g.tSpan;
  const H = state.hist;
  let idx = 0, best = Infinity;
  for (let i = 0; i < H.t.length; i++) {
    const d = Math.abs(H.t[i] - t);
    if (d < best) { best = d; idx = i; }
  }
  chart.hover = H.t[idx];
  if (!chart.tip) {
    chart.tip = document.createElement("div");
    chart.tip.style.cssText =
      "position:absolute;pointer-events:none;background:var(--surface);border:1px solid var(--border);" +
      "border-radius:6px;padding:4px 8px;font-size:11px;color:var(--ink-2);white-space:nowrap;display:none;z-index:5";
    chart.cv.parentElement.appendChild(chart.tip);
  }
  const tip = chart.tip;
  tip.innerHTML =
    `<span class="mono">${fmtTime(H.t[idx])}</span><br>` +
    `<span style="color:var(--s1)">■</span> XY ${(H.xy[idx] || 0).toFixed(1)} mm<br>` +
    `<span style="color:var(--s2)">■</span> Z&nbsp; ${(H.z[idx] || 0).toFixed(1)} mm`;
  tip.style.display = "block";
  const px = Math.min(Math.max(x + 10, 0), g.w - 120);
  tip.style.left = px + "px";
  tip.style.top = Math.max(0, e.clientY - rect.top - 50) + "px";
  drawChart();
}
chart.cv.addEventListener("mousemove", chartTooltip);
chart.cv.addEventListener("mouseleave", () => {
  chart.hover = null;
  if (chart.tip) chart.tip.style.display = "none";
  drawChart();
});

async function pollHistory() {
  const r = await getJSON(`/api/${state.side}/history`, 6000);
  if (r.ok) { state.hist = r; drawChart(); }
}

/* ---------------- 相机 ---------------- */

$("camSerial").value = SERIAL.right;

$("btnCamConnect").addEventListener("click", () => withBusy($("btnCamConnect"), "连接中…", async () => {
  const r = await pbvs("camera/connect", { serial: $("camSerial").value.trim() }, 30000);
  $("camResult").textContent = pretty(r);
  toast(r.ok ? "相机已连接" : "相机连接失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollHealth();
}));

$("btnCamDisconnect").addEventListener("click", () => withBusy($("btnCamDisconnect"), "断开中…", async () => {
  const r = await pbvs("camera/disconnect", {}, 15000);
  $("camResult").textContent = pretty(r);
  pollHealth();
}));

/* ---------------- 标定 ---------------- */

$("btnCalibrate").addEventListener("click", () => withBusy($("btnCalibrate"), "标定中(臂在移动)…", async () => {
  const stepM = parseFloat($("calibStep").value) || 0.005;
  if (!confirm(`即将执行在线手眼标定:${ARM_CN[state.side]}会沿基座 X/Y/Z 各 ±${(stepM * 1000).toFixed(0)}mm 自动移动,约 1–2 分钟。\n确认臂周无障碍物?`)) return;
  const r = await pbvs("calibrate", { step_m: stepM }, 300000);
  $("calibResult").textContent = pretty(r);
  renderQcPills("calibQc", r.col_norms, r.cond);
  toast(r.ok ? "标定完成,详见质检结果" : "标定失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshReference();
}));

function renderQcPills(elId, norms, cond) {
  const el = $(elId);
  if (!norms || !norms.length) { el.innerHTML = ""; return; }
  const pill = (pass, text) => `<span class="pill ${pass ? "pass" : "fail"}">${pass ? "✓" : "✗"} ${text}</span>`;
  el.innerHTML =
    norms.map((n, i) => pill(n >= 0.8 && n <= 1.2, `|J${i + 1}| = ${n.toFixed(3)}`)).join("") +
    (cond != null ? pill(cond < 50, `cond = ${cond}`) : "");
}

/* ---------------- 示教 / 目标 ---------------- */

$("btnRecord").addEventListener("click", () => withBusy($("btnRecord"), "录入…", async () => {
  const name = $("tgtName").value.trim();
  if (!name) { toast("请先填写目标名", "err"); return; }
  if (!confirm(`以当前位姿 + 当前 QR 位置录入目标「${name}」?`)) return;
  const r = await pbvs("record", {
    name,
    marker_size_m: parseFloat($("tgtSize").value) || 0.06,
  }, 20000);
  toast(r.ok ? `目标「${name}」已录入并自动保存` : "录入失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshTargets(); refreshReference();
}));

async function refreshTargets() {
  const r = await pbvs("targets", null, 8000);
  const ul = $("targetList");
  if (!r.ok) { ul.innerHTML = `<li>${r.error || "获取失败"}</li>`; return; }
  // PBVS 返回 {ok, current, targets:{名字:{created_at}}}
  const names = r.targets ? Object.keys(r.targets) : [];
  if (!names.length) { ul.innerHTML = "<li>暂无目标 — 示教录入后显示</li>"; return; }
  ul.innerHTML = "";
  for (const t of names) {
    const li = document.createElement("li");
    if (t === r.current) li.classList.add("current");
    li.innerHTML = `<span class="name">${t}</span>` +
      (t === r.current ? '<span class="tag">当前</span>' : "") +
      `<button data-act="sel">选中</button><button data-act="del">删除</button>`;
    li.addEventListener("click", async e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "sel") {
        const rr = await pbvs("targets/select", { name: t });
        toast(rr.ok ? `已选中「${t}」` : "选中失败: " + (rr.error || ""), rr.ok ? "ok" : "err");
        refreshTargets();
        refreshOffset();
      } else if (act === "del" && confirm(`删除目标「${t}」?`)) {
        const rr = await pbvs("targets/delete", { name: t });
        toast(rr.ok ? `已删除「${t}」` : "删除失败: " + (rr.error || ""), rr.ok ? "ok" : "err");
        refreshTargets(); refreshReference();
      }
    });
    ul.appendChild(li);
  }
}

/* ---------------- 对准 ---------------- */

$("btnStep").addEventListener("click", () => withBusy($("btnStep"), "单步中…", async () => {
  if (!confirm(`执行一次对准迭代?${ARM_CN[state.side]}将按当前误差移动(≤8mm)。`)) return;
  const r = await pbvs("align/step", {}, 60000);
  $("alignResult").textContent = pretty(r);
  const errTxt = r.ok ? `XY ${(r.error_xy_mm ?? "?")} / Z ${(r.error_z_mm ?? "?")} mm${r.converged ? " · 已收敛" : ""}` : (r.error || "");
  toast(r.ok ? "单步完成: " + errTxt : "单步失败: " + errTxt, r.ok ? "ok" : "err");
  pollStatus(); pollHistory();
}));

$("btnStart").addEventListener("click", () => withBusy($("btnStart"), "启动…", async () => {
  if (!confirm(`启动连续对准闭环?${ARM_CN[state.side]}将自动迭代移动,误差发散会自动停。`)) return;
  const r = await pbvs("align/start", {}, 15000);
  $("alignResult").textContent = pretty(r);
  toast(r.ok ? "连续对准已启动" : "启动失败: " + (r.error || ""), r.ok ? "ok" : "err");
}));

async function stopAlign() {
  const r = await pbvs("align/stop", {}, 10000);
  toast(r.ok ? "已发送停止信号" : "停止失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollStatus();
}
$("btnStop").addEventListener("click", stopAlign);
$("btnStopAlign").addEventListener("click", stopAlign);

/* ---------------- 参数 ---------------- */

async function refreshParams() {
  const r = await pbvs("params", null, 8000);
  if (!r.ok || !r.params) return;
  $("pKp").value = r.params.Kp;
  $("pMaxStep").value = r.params.max_step_m;
  $("pThresh").value = r.params.threshold_m;
  $("pMarkerId").value = r.params.marker_id;
}

$("btnParamsSave").addEventListener("click", () => withBusy($("btnParamsSave"), "保存中…", async () => {
  const body = {
    Kp: parseFloat($("pKp").value),
    max_step_m: parseFloat($("pMaxStep").value),
    converge_threshold_m: parseFloat($("pThresh").value),
    marker_id: parseInt($("pMarkerId").value, 10),
  };
  for (const k of Object.keys(body)) if (isNaN(body[k])) delete body[k];
  const r = await pbvs("params", body, 10000);
  toast(r.ok ? "参数已保存(仅内存,重启 PBVS 后失效)" : "保存失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshParams();
}));
$("btnParamsReload").addEventListener("click", refreshParams);

/* ---------------- 参考数据 ---------------- */

async function refreshReference() {
  const r = await getJSON(`/api/${state.side}/reference`, 8000);
  const qc = $("refQc"), jt = $("refJ"), meta = $("refMeta");
  if (!r.ok) {
    qc.innerHTML = ""; jt.innerHTML = "";
    meta.textContent = r.error || "读取失败";
    return;
  }
  renderQcPills("refQc", r.col_norms, r.cond);
  jt.innerHTML = (r.J || []).map(row =>
    `<tr>${row.map(v => `<td>${v.toFixed(4)}</td>`).join("")}</tr>`).join("");
  const tNames = Object.keys(r.targets || {});
  const when = new Date(r.mtime * 1000).toLocaleString("zh-CN");
  meta.textContent =
    `${r.file} · 修改于 ${when} · 目标 ${tNames.length} 个${tNames.length ? "(" + tNames.join("、") + ")" : ""} · 当前: ${r.current_target_name || "—"}`;
}

$("btnRefReload").addEventListener("click", refreshReference);

$("btnRefSave").addEventListener("click", () => withBusy($("btnRefSave"), "保存中…", async () => {
  const r = await pbvs("save_reference", { filepath: REF_PATH(state.side) }, 15000);
  toast(r.ok ? "已保存到 " + REF_PATH(state.side) : "保存失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshReference();
}));

$("btnRefLoad").addEventListener("click", () => withBusy($("btnRefLoad"), "加载中…", async () => {
  if (!confirm(`从臂文件重新加载示教/标定数据?当前内存中的目标将被覆盖。`)) return;
  const r = await pbvs("load_reference", { filepath: REF_PATH(state.side) }, 15000);
  toast(r.ok ? "已加载" : "加载失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshReference(); refreshTargets();
}));

/* ---------------- 笛卡尔示教 (TCP 6D) ---------------- */

const AXES = [
  { key: "x", label: "X" }, { key: "y", label: "Y" }, { key: "z", label: "Z" },
  { key: "rx", label: "RX" }, { key: "ry", label: "RY" }, { key: "rz", label: "RZ" },
];

for (const ax of AXES) {
  const cell = document.createElement("div");
  cell.className = "ax";
  cell.innerHTML = `<div class="lab">${ax.label}</div>` +
    `<div class="btns"><button data-dir="-1" title="${ax.label} −">−</button><button data-dir="1" title="${ax.label} ＋">＋</button></div>`;
  cell.addEventListener("click", async e => {
    const btn = e.target.closest("button[data-dir]");
    if (!btn) return;
    cartJog(ax, parseFloat(btn.dataset.dir));
  });
  $("jogpad").appendChild(cell);
}

function fmtPose(p) {
  if (!p) return null;
  const deg = v => (v * 180 / Math.PI).toFixed(1);
  return { mm: [p.x, p.y, p.z].map(v => (v * 1000).toFixed(1)).join(", "),
           rpy_deg: [p.rx, p.ry, p.rz].map(deg).join(", ") };
}

function showCartResult(action, r) {
  const line = { action, ok: r.ok };
  if (r.error) line.error = r.error;
  if (r.clamped) line.clamped = "步长已截断";
  if (r.pose_to_tcp) { line.tcp_to = fmtPose(r.pose_to_tcp); if (r.pose_from_tcp) line.tcp_from = fmtPose(r.pose_from_tcp); }
  else if (r.pose_to) line.pose_to = fmtPose(r.pose_to);
  $("cartResult").textContent = pretty(line);
  if (!r.ok && r.error) toast(`${action}: ${r.error}`, "err");
}

async function cartJog(ax, dir) {
  if (!$("cartArm").checked) { toast("请先勾选「解锁点动」(确认臂周无人无障碍)", "err"); return; }
  const isLin = "xyz".includes(ax.key);
  const step = parseFloat(isLin ? $("cartLin").value : $("cartAng").value);
  const body = { frame: $("cartFrame").value, dry_run: $("cartDry").checked };
  body[ax.key] = dir * step;   // 平移 m / 旋转 deg(后端单位)
  const r = await pbvs("cart/jog", body, 30000);
  showCartResult(`jog ${ax.label} ${dir > 0 ? "+" : "−"}${step}${isLin ? "mm" : "°"}`, r);
  if (r.ok) pollCartFk();
}

async function pollCartFk() {
  const r = await pbvs("cart/fk", null, 4000);
  const el = $("tcpPose");
  if (!r.ok || !r.pose) {
    el.textContent = "TCP 位姿: —(PBVS 实例离线?)";
    el.classList.add("warn");
    return;
  }
  el.classList.remove("warn");
  const identity = !r.tool || r.tool.identity;
  const f = fmtPose(r.pose_tcp || r.pose);
  let s = `TCP${identity ? "(零偏移=法兰)" : "(工具)"} ${state.side === "left" ? "左" : "右"}臂  x/y/z = ${f.mm} mm  |  rpy = ${f.rpy_deg} °`;
  if (!identity && r.pose) {
    const fl = fmtPose(r.pose);
    s += `  ‖ 法兰 ${fl.mm} mm`;
  }
  el.textContent = s;
}

async function refreshTp() {
  const r = await pbvs("teach/points", null, 8000);
  const ul = $("tpList");
  if (!r.ok) { ul.innerHTML = `<li>${r.error || "获取失败(PBVS 实例离线?)"}</li>`; return; }
  const pts = r.points || [];
  state.tpNames = pts.map(p => p.name);
  if (!pts.length) { ul.innerHTML = "<li>暂无示教点 — 点动到位后保存</li>"; return; }
  ul.innerHTML = "";
  for (const p of pts) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="name">${p.name}</span>` +
      `<button data-act="go">前往</button><button data-act="q" title="追加到 ⑨ 动作队列">入队</button><button data-act="del">删除</button>`;
    li.addEventListener("click", async e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "go") {
        if (!confirm(`回放到示教点「${p.name}」?${ARM_CN[state.side]}将移动到录入时的关节角。`)) return;
        const rr = await pbvs("teach/goto", { name: p.name }, 60000);
        toast(rr.ok ? `已回放「${p.name}」` : "回放失败: " + (rr.error || ""), rr.ok ? "ok" : "err");
        pollCartFk();
      } else if (act === "q") {
        qAdd([{ kind: "teach_goto", label: `⑦前往·${p.name}`, params: { name: p.name } }]);
      } else if (act === "del" && confirm(`删除示教点「${p.name}」?`)) {
        const rr = await pbvs("teach/delete", { name: p.name });
        toast(rr.ok ? `已删除「${p.name}」` : "删除失败: " + (rr.error || ""), rr.ok ? "ok" : "err");
        refreshTp();
      }
    });
    ul.appendChild(li);
  }
}

$("btnTpSave").addEventListener("click", () => withBusy($("btnTpSave"), "保存…", async () => {
  const name = $("tpName").value.trim();
  if (!name) { toast("请先填写点位名", "err"); return; }
  const r = await pbvs("teach/save", { name }, 15000);
  toast(r.ok ? `示教点「${name}」已保存` : "保存失败: " + (r.error || ""), r.ok ? "ok" : "err");
  if (r.ok) $("tpName").value = "";
  refreshTp();
}));

$("btnTpPlayAll").addEventListener("click", () => withBusy($("btnTpPlayAll"), "回放中…", async () => {
  const r = await pbvs("teach/points", null, 8000);
  const names = (r.points || []).map(p => p.name);
  if (!names.length) { toast("暂无示教点", "err"); return; }
  if (!confirm(`按顺序回放全部 ${names.length} 个示教点(${names.join(" → ")})?确认路径无障碍。`)) return;
  const rr = await pbvs("teach/play", { names, dwell_s: 0.5 }, 300000);
  toast(rr.ok ? `序列回放完成(${rr.done.length} 点)` : "回放中断: " + pretty(rr.failed || []), rr.ok ? "ok" : "err");
  pollCartFk();
}));

/* ---------------- ⑧ 抓取序列(自定义步骤) ---------------- */

async function pollGraspState() {
  const r = await pbvs("grasp/state", null, 5000);
  const chip = $("graspAligned");
  if (!r.ok) {
    chip.className = "chip";
    chip.querySelector(".txt").textContent = "对准 —(实例离线)";
    $("gripperPos").textContent = "夹爪 —";
    return;
  }
  chip.className = "chip " + (r.aligned ? "up" : "down");
  chip.querySelector(".txt").textContent = r.aligned
    ? `对准就绪(XY ${r.error_xy_mm}/Z ${r.error_z_mm}mm)`
    : `未收敛(XY ${r.error_xy_mm ?? "—"}/Z ${r.error_z_mm ?? "—"}mm${r.has_target ? "" : ",无目标"})`;
  $("gripperPos").textContent =
    `夹爪 ${r.gripper_position != null ? r.gripper_position : "—"}${r.align_running ? " · 对准运行中" : ""}`;
  getJSON(`/api/${state.side}/poselast`, 6000).then(p => {
    $("graspPoseInfo").textContent = p && p.ok
      ? `⑩: ${p.count}袋 ${p.summary || ""} · ${Math.round(p.now - p.t)}s前(序=⑭袋#: 近层左→右)`
      : "⑩: 无缓存";
  });
}

/* 步骤数据模型(与后端 moves 同构, 平移单位 m):
   {x,y,z,frame:"tool|base"} | {gripper:0-1000} | {dwell:s}
   10-08 定版: 页面初始步骤=空(旧默认[Z-80,闭爪,等,Z+50]反复被当遗留步误执行, 删) */
const GRIP_DEFAULTS = [];
state.graspMoves = JSON.parse(JSON.stringify(GRIP_DEFAULTS));

const AX_INPUT = (k, v) =>
  `<label class="axlab">${k.toUpperCase()}<input type="number" data-k="${k}" value="${v}" step="1"></label>`;

/* 🧭步格式归一(10-08 定版): 无角度参数 — 检测调转角说多少转多少(✓≤30°跳过),
   步骤位置=用户自己把控的旋转时机。旧式 sign/angle/两栏/带pa_前缀坏键 一律剥掉只留袋#。 */
function normPoseAlign(mv) {
  const pa = mv.pose_align = mv.pose_align || {};
  for (const k of ["angle_pos", "angle_neg", "sign", "angle", "pa_angle_pos", "pa_angle_neg"])
    delete pa[k];
  return pa;
}

function renderGraspMoves() {
  const ul = $("graspStepList");
  ul.innerHTML = "";
  if (!state.graspMoves.length) {
    ul.innerHTML = "<li>暂无步骤 — 上方添加或载入模板</li>";
    return;
  }
  state.graspMoves.forEach((mv, i) => {
    const li = document.createElement("li");
    let body;
    if ("gripper" in mv) {
      body = `<span class="axlab">🤏 夹爪开度<input type="number" data-k="gripper" value="${mv.gripper}" step="50" min="0" max="1000"></span><span class="unit">(0闭-1000开)</span>`;
    } else if ("pose_align" in mv) {
      const pa = normPoseAlign(mv);                 // 旧式角度参数当场剥掉, 所见即所跑
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
    li.innerHTML =
      `<span class="ord">${i + 1}.</span><span class="move-edit">${body}</span>` +
      `<button data-act="up" title="上移">↑</button>` +
      `<button data-act="down" title="下移">↓</button>` +
      `<button data-act="del" title="删除">✕</button>`;
    ul.appendChild(li);
  });
}

/* 行内编辑: 事件委托(输入直接写回 state, 不重渲染避免打断输入) */
$("graspStepList").addEventListener("change", e => {
  const t = e.target, k = t.dataset && t.dataset.k;
  if (!k) return;
  const li = t.closest("li");
  const i = Array.prototype.indexOf.call($("graspStepList").children, li);
  const mv = state.graspMoves[i];
  if (!mv) return;
  if (k === "frame") mv.frame = t.value;
  else if (k === "pa_index") {
    mv.pose_align = mv.pose_align || {};
    mv.pose_align.index = Math.max(1, parseInt(t.value, 10) || 1);
  } else if (k === "gripper") mv.gripper = Math.max(0, Math.min(1000, parseFloat(t.value) || 0));
  else if (k === "dwell") mv.dwell = Math.max(0, Math.min(5, parseFloat(t.value) || 0));
  else if (k === "rx" || k === "ry" || k === "rz")
    mv[k] = Math.max(-180, Math.min(180, parseFloat(t.value) || 0));   // 旋转: deg
  else mv[k] = (parseFloat(t.value) || 0) / 1000;   // x/y/z: mm → m
});

/* 排序/删除: 按钮点击委托 */
$("graspStepList").addEventListener("click", e => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act) return;
  const li = e.target.closest("li");
  const i = Array.prototype.indexOf.call($("graspStepList").children, li);
  const a = state.graspMoves;
  if (act === "del") a.splice(i, 1);
  else if (act === "up" && i > 0) [a[i - 1], a[i]] = [a[i], a[i - 1]];
  else if (act === "down" && i < a.length - 1) [a[i + 1], a[i]] = [a[i], a[i + 1]];
  renderGraspMoves();
});

$("btnGraspAdd").addEventListener("click", () => {
  const t = $("graspAddType").value;
  if (t === "grip") state.graspMoves.push({ gripper: 0 });
  else if (t === "dwell") state.graspMoves.push({ dwell: 0.8 });
  else if (t === "posealign") state.graspMoves.push({ pose_align: { index: 1 } });
  else if (t === "rot") state.graspMoves.push({ rx: 0, ry: 0, rz: 90, frame: "tool" });
  else state.graspMoves.push({ x: 0, y: 0, z: -0.08, frame: "tool" });
  renderGraspMoves();
});

function movesSummary() {
  return state.graspMoves.map(mv => {
    if ("gripper" in mv) return `夹爪→${mv.gripper}`;
    if ("pose_align" in mv) {
      const pa = mv.pose_align || {};
      return `🧭⑩转正#${pa.index || 1}按检测`;
    }
    if ("dwell" in mv) return `等${mv.dwell}s`;
    const fr = mv.frame === "tool" ? "工具" : "基座";
    if ("rx" in mv) {
      const v = ["rx", "ry", "rz"].filter(k => Math.abs(mv[k]) > 1e-9)
        .map(k => `${k.toUpperCase()}${mv[k]}°`).join(" ");
      return `[${fr}] ${v || "0°"}`;
    }
    const v = ["x", "y", "z"].filter(k => Math.abs(mv[k]) > 1e-9)
      .map(k => `${k.toUpperCase()}${(mv[k] * 1000).toFixed(0)}`).join(" ");
    return `[${fr}] ${v || "0"}`;
  }).join(" → ");
}

$("graspTemplate").addEventListener("change", () => {
  const t = $("graspTemplate").value;
  $("graspTemplate").value = "";
  /* 10-08 定版: 夹爪类内置模板(俯视/竖直抓取, 含Z-80+闭爪)已删 — 左臂现装吸盘,
     闭爪步必失败; Z-80 遗留步反复被误当"莫名动作"。只留清空。 */
  if (t === "clear") state.graspMoves = [];
  else return;
  state.graspFrom = "";                        // 清空 = 脱离预设来源
  renderGraspMoves();
  toast("步骤已清空", "ok");
});

/* ---------------- 抓取预设: 存/载/删 (按臂存 PBVS 侧文件) ---------------- */

state.graspPresets = [];
state.graspFrom = "";                           // 当前 moves 载入自哪个预设(入队用它当名字; 手改不自动脱离)

async function refreshGraspPresets() {
  const sel = $("graspPresetSel");
  const r = await pbvs("grasp/presets", null, 8000);
  if (!r.ok) {
    sel.innerHTML = '<option value="">— 预设(实例离线) —</option>';
    state.graspPresets = [];
    return;
  }
  state.graspPresets = r.presets || [];
  if (!state.graspPresets.length) {
    sel.innerHTML = '<option value="">— 无已存预设 —</option>';
    return;
  }
  const names = state.graspPresets.map(p =>
    `<option value="${p.name}">${p.name}(${p.moves.length}步)</option>`).join("");
  sel.innerHTML = '<option value="">— 载入预设 —</option>' + names;
}

$("graspPresetSel").addEventListener("change", () => {
  const name = $("graspPresetSel").value;
  if (!name) return;
  const p = state.graspPresets.find(q => q.name === name);
  if (!p) return;
  state.graspMoves = JSON.parse(JSON.stringify(p.moves));
  state.graspFrom = name;                      // 入队时 label 用预设名(运行页显示的就是它)
  renderGraspMoves();
  toast(`预设「${name}」已载入(${p.moves.length} 步)`, "ok");
});

$("btnGraspPresetSave").addEventListener("click", () => withBusy($("btnGraspPresetSave"), "保存…", async () => {
  const name = $("graspPresetName").value.trim();
  if (!name) { toast("请先填写预设名", "err"); return; }
  if (!state.graspMoves.length) { toast("步骤列表为空", "err"); return; }
  const r = await pbvs("grasp/presets/save", { name, moves: state.graspMoves }, 10000);
  if (r.ok) { $("graspPresetName").value = ""; toast(`预设「${name}」已保存`, "ok"); }
  else toast("保存失败: " + (r.error || ""), "err");
  refreshGraspPresets();
}));

$("btnGraspPresetDel").addEventListener("click", () => withBusy($("btnGraspPresetDel"), "…", async () => {
  const name = $("graspPresetSel").value;
  if (!name) { toast("先在下拉里选中要删的预设", "err"); return; }
  if (!confirm(`删除预设「${name}」?`)) return;
  const r = await pbvs("grasp/presets/delete", { name }, 8000);
  toast(r.ok ? `已删除「${name}」` : "删除失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshGraspPresets();
}));

function renderGraspSteps(r) {
  const lines = [];
  if (r.pose_resolved && r.pose_resolved.length)
    lines.push(`🧭 ${r.pose_resolved.join(" | ")}`);
  if (r.aborted_at) lines.push(`✗ 中止于: ${r.aborted_at}`);
  if (r.error) lines.push(`错误: ${r.error}`);
  for (const s of r.steps || []) lines.push(`${s.ok ? "✓" : "✗"} ${s.name}${s.detail ? " — " + s.detail : ""}`);
  if (r.plan && r.plan.joints_deg) lines.push(`试算终态关节: ` + r.plan.joints_deg.map(v => v.toFixed(1)).join(", "));
  $("graspResult").textContent = lines.join("\n") || pretty(r);
}

$("btnGripOpen").addEventListener("click", () => withBusy($("btnGripOpen"), "张爪…", async () => {
  const r = await pbvs("grasp/gripper", { action: "open", effort: 500, velocity: 500 }, 15000);
  toast(r.ok ? "夹爪已张开" : "张爪失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollGraspState();
}));

$("btnGripClose").addEventListener("click", () => withBusy($("btnGripClose"), "闭爪…", async () => {
  if (!confirm(`闭合${ARM_CN[state.side]}夹爪?确认爪间无手指/线缆。`)) return;
  const r = await pbvs("grasp/gripper", { action: "close", effort: 500, velocity: 500 }, 15000);
  toast(r.ok ? "夹爪已闭合(力500)" : "闭爪失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollGraspState();
}));

$("btnGripMax").addEventListener("click", () => withBusy($("btnGripMax"), "满力闭合…", async () => {
  if (!confirm(`满力闭合${ARM_CN[state.side]}夹爪(力/速度=1000)?确认爪间无手指/线缆。\n点确定后本臂夹持力=满值, 后续队列/序列的闭合也沿用满力, 直到再点普通「闭合夹爪」。`)) return;
  const r = await pbvs("grasp/gripper", { action: "close", effort: 1000, velocity: 1000 }, 15000);
  toast(r.ok ? "已满力闭合(1000)" : "满力闭合失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollGraspState();
}));

async function graspRun(smooth, btn) {
  if (!state.graspMoves.length) { toast("步骤列表为空", "err"); return; }
  const body = {
    moves: state.graspMoves,
    require_aligned: $("graspRequireAligned").checked,
    dry_run: $("graspDry").checked,
    smooth,
  };
  if (!body.dry_run) {
    const mode = smooth ? "(一次到位: 每步一口气移动到目标, 不分块点动; 步内不可停)" : "";
    /* 🧭 预判: 按当前⑩缓存逐个🧭步列出 将跳过/将转多少 — 跳过会让后续步提前执行, 先看清楚 */
    let poseNote = "";
    const aligns = state.graspMoves.filter(mv => "pose_align" in mv);
    if (aligns.length) {
      const p = await getJSON(`/api/${state.side}/poselast`, 6000);
      if (p && p.ok) {
        const pred = aligns.map(mv => {
          const pa = mv.pose_align || {};
          const idx = pa.index || 1;
          const d = (p.dets || [])[idx - 1];
          if (!d) return `🧭 袋#${idx}: 缓存只有 ${p.count} 袋 → 执行会拦下报错`;
          const dev = Math.round(d.head_dev_deg || 0);
          if (d.action === "ok") return `🧭 袋#${idx}: ✓姿态正确(α${dev}°≤30) → 该步跳过`;
          const rot0 = d.rotate_deg != null ? d.rotate_deg : -(d.head_dev_deg || 0);
          return `🧭 袋#${idx}: ${d.action === "flip" ? "⇄反面" : "⟳"} 调转角${Math.round(rot0)}° → 将转腕${Math.round(rot0)}°(检测值)`;
        }).join("\n  ");
        poseNote = `\n按 ${Math.round(p.now - p.t)}s 前的⑩缓存(${p.source === "suction" ? "⑭扫描序=袋#" : "⑩表序"})预判:\n  ${pred}\n  (✓跳过的步不会动臂; 其余步骤照常执行)`;
      } else {
        poseNote = `\n🧭 ⚠ 无可用⑩缓存(${p && p.error ? p.error : "调试台离线"}) — 执行会在动臂前整序列拦下报错`;
      }
    }
    if (!confirm(`按以下顺序执行 ${state.graspMoves.length} 步${mode}?\n  ${movesSummary()}${poseNote}\n\n${ARM_CN[state.side]}将依次动作, 确认路径无障碍物!`)) return;
  }
  const r = await pbvs("grasp/sequence", body, 300000);
  renderGraspSteps(r);
  toast(r.ok ? (body.dry_run ? "试算通过" : `序列完成(${(r.steps || []).length} 步)`)
             : "序列中止: " + (r.aborted_at || r.error || ""), r.ok ? "ok" : "err");
  pollGraspState(); pollCartFk();
}

$("btnGraspRun").addEventListener("click", () => withBusy($("btnGraspRun"), "序列执行中(一次到位)…", () => graspRun(true)));

/* ---------------- ⑨ 动作队列 (左右共用, ④⑦⑧ 入队 → 顺序执行, 可停) ---------------- */

/* 调试台本地 API(/api/queue/*): 协调器在 :7010, 左右臂共用一条队列, 逐项派给对应 PBVS 实例 */
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

/* 左/右 臂标记徽章(队列项按入队时的活动臂自动打标) */
const sideTag = s => s === "left"
  ? '<span class="qside l" title="左臂">左</span>'
  : '<span class="qside r" title="右臂">右</span>';
const sideCN = s => ARM_CN[s] || s || "?";
/* 队列历史项计时标签: ⏱耗时 + 完成时刻(服务器 epoch → 本地 HH:MM:SS) */
const stepTimeTag = d => (d.dur_s != null || d.t)
  ? ` <span class="tag" style="color:var(--muted)">⏱${d.dur_s != null ? d.dur_s + "s" : "?"}${d.t ? " " + new Date(d.t * 1000).toLocaleTimeString("zh-CN", { hour12: false }) : ""}</span>`
  : "";

/* 入队: 自动给每项带上当前活动臂(左/右)标记 */
async function qAdd(items) {
  const tagged = items.map(it => ({ ...it, side: state.side }));
  const r = await hub("queue/add", { items: tagged }, 10000);
  toast(r.ok
    ? `[${sideCN(state.side)}] 已入队: ${items.map(i => i.label).join(" / ")}`
    : "入队失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
}

$("btnQAlignStep").addEventListener("click", () =>
  qAdd([{ kind: "align_step", label: "④对准·单步", params: {} }]));

$("btnQAlignWait").addEventListener("click", () =>
  qAdd([{ kind: "align_wait", label: "④对准·到收敛", params: { timeout_s: 120 } }]));

$("btnQTpPlayAll").addEventListener("click", () => {
  const names = state.tpNames || [];
  if (!names.length) { toast("暂无示教点", "err"); return; }
  qAdd([{ kind: "teach_play", label: `⑦回放全部(${names.length}点)`,
          params: { names: names.slice(), dwell_s: 0.5 } }]);
});

$("btnQGraspSeq").addEventListener("click", () => {
  if (!state.graspMoves.length) { toast("步骤列表为空", "err"); return; }
  qAdd([{ kind: "grasp_seq",
          label: state.graspFrom
            ? `⑧抓取·${state.graspFrom}`               /* 从预设载入 → 用预设名 */
            : "⑧抓取(一次到位): " + movesSummary().slice(0, 40),
          params: { moves: JSON.parse(JSON.stringify(state.graspMoves)),
                    require_aligned: $("graspRequireAligned").checked,
                    smooth: true } }]);   /* 与 ▶执行序列(一次到位) 同走法 */
});

async function pollQueue() {
  const r = await hub("queue/state", null, 5000);
  const chip = $("qRunning");
  if (!r.ok) {
    chip.className = "chip";
    chip.querySelector(".txt").textContent = "队列 —(调试台离线)";
    $("qCurrent").textContent = "当前: —";
    renderLoopCard(r);
    return;
  }
  chip.className = "chip " + (r.running ? "up" : "down");
  let chipTxt = r.running ? "执行中" : "空闲";
  if (r.running && r.loop && r.loop.cycle > 0 && r.loop.total !== 1) {
    chipTxt += ` 第${r.loop.cycle}/${r.loop.total || "∞"}轮`;   // 多轮时才显示(⑮ 循环用)
  }
  chip.querySelector(".txt").textContent = chipTxt;
  $("qCurrent").textContent = "当前: " +
    (r.current ? `[${sideCN(r.current.side)}] ${r.current.label}` : "—");

  const ul = $("queueList");
  const done = r.done || [], pend = r.pending || [];
  if (!done.length && !pend.length && !r.current) {
    ul.innerHTML = "<li>队列为空 — 切到对应臂的 tab 后在 ④⑦⑧ 点「＋队列」, 或从上方预设「载入 / ＋追加」(自动带 左/右 标记, 左右共用此队列)</li>";
    renderLoopCard(r);
    return;
  }
  ul.innerHTML = "";
  for (const d of done.slice(-8)) {                    // 最近 8 条历史(↻复活 ✕移除)
    const li = document.createElement("li");
    li.className = "q-done";
    li.innerHTML = sideTag(d.side) +
      `<span class="name">${d.ok ? "✓" : "✗"}${d.cycle > 1 ? `(第${d.cycle}轮)` : " "}${d.label}</span>` +
      (d.detail ? `<span class="tag">${String(d.detail).slice(0, 60)}</span>` : "") +
      stepTimeTag(d) +
      `<button data-act="redo" data-uid="${d.uid}" title="重新入队(原样追加到队尾)">↻</button>` +
      `<button data-act="drop" data-uid="${d.uid}" title="从历史移除">✕</button>`;
    li.addEventListener("click", async e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "redo") {
        const rr = await hub("queue/requeue", { uids: [d.uid] }, 8000);
        toast(rr.ok ? `已重新入队: ${d.label}` : "重新入队失败: " + (rr.error || ""),
              rr.ok ? "ok" : "err");
      } else if (act === "drop") {
        const rr = await hub("queue/dismiss", { uid: d.uid }, 8000);
        toast(rr.ok ? `已从历史移除` : "移除失败: " + (rr.error || ""), rr.ok ? "ok" : "err");
      }
      pollQueue();
    });
    ul.appendChild(li);
  }
  if (r.current) {
    const el = (r.now && r.current_t0) ? Math.max(0, r.now - r.current_t0).toFixed(0) : null;
    const li = document.createElement("li");
    li.className = "q-cur";
    li.innerHTML = sideTag(r.current.side) +
      `<span class="name">▶ ${r.current.label}</span><span class="tag">执行中${el != null ? " " + el + "s" : ""}</span>`;
    ul.appendChild(li);
  }
  pend.forEach((p, i) => {                             // 未执行(↑↓调序 ✕移除)
    const li = document.createElement("li");
    li.innerHTML = sideTag(p.side) + `<span class="name">· ${p.label}</span>` +
      `<button data-act="up" data-uid="${p.uid}"${i === 0 ? " disabled" : ""} title="上移">↑</button>` +
      `<button data-act="down" data-uid="${p.uid}"${i === pend.length - 1 ? " disabled" : ""} title="下移">↓</button>` +
      `<button data-act="del" data-uid="${p.uid}" title="移除该项">✕</button>`;
    li.addEventListener("click", async e => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act) return;
      if (act === "up" || act === "down") {
        const rr = await hub("queue/move", { uid: p.uid, dir: act }, 8000);
        if (!rr.ok) toast("调序失败: " + (rr.error || ""), "err");
      } else {
        const rr = await hub("queue/remove", { uid: p.uid }, 8000);
        toast(rr.ok ? `已移除「${p.label}」` : "移除失败: " + (rr.error || ""), rr.ok ? "ok" : "err");
      }
      pollQueue();
    });
    ul.appendChild(li);
  });
  renderLoopCard(r);                                     // ⑮ 卡与⑨同一条队列, 一份数据两处渲染
}

$("btnQueueRun").addEventListener("click", () => withBusy($("btnQueueRun"), "启动…", async () => {
  const st = await hub("queue/state", null, 5000);
  const pend = st.pending || [];
  if (!pend.length) { toast("队列为空, 先切到对应臂 tab 在 ④⑦⑧ 入队, 或载入预设", "err"); return; }
  if (!confirm(`开始执行队列 ${pend.length} 项(左右臂按顺序动作, 不会并行)?\n` +
      pend.map(p => `· [${sideCN(p.side)}] ${p.label}`).join("\n") +
      "\n\n确认两臂路径无障碍!")) return;
  const r = await hub("queue/run", {}, 10000);
  toast(r.ok ? "队列开始执行" : "启动失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
}));

$("btnQueueStop").addEventListener("click", async () => {
  const r = await hub("queue/stop", {}, 10000);
  toast(r.ok ? "停止信号已发, 当前臂动作将在最近检查点(≤18mm)停下" : "停止失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
});

$("btnQueueRequeue").addEventListener("click", async () => {
  const r = await hub("queue/requeue", { all: true }, 8000);
  toast(r.ok ? `已把 ${r.requeued} 条历史项重新入队(队尾)` : "重新入队失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  pollQueue();
});

$("btnQueueClear").addEventListener("click", async () => {
  const r = await hub("queue/clear", {}, 8000);
  toast(r.ok ? "队列已清空" : "清空失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
});

/* ---------------- ⑨ 队列预设 (存共用队列到调试台, 含左/右标记) ---------------- */

async function refreshQPresets() {
  const sel = $("qPresetSel"), dsel = $("qDuoPresetSel");
  const r = await hub("queue/presets", null, 8000);
  if (!r.ok) {
    sel.innerHTML = '<option value="">— 预设(调试台离线) —</option>';
    if (dsel) dsel.innerHTML = '<option value="">— 预设(调试台离线) —</option>';
    return;
  }
  const ps = r.presets || [];
  const opts = p => `<option value="${p.name}">${p.name}(${p.count}项·${(p.sides || []).map(s => s === "left" ? "左" : "右").join("")})</option>`;
  sel.innerHTML = ps.length
    ? '<option value="">— 载入队列 —</option>' + ps.map(opts).join("")
    : '<option value="">— 无已存队列 —</option>';
  if (dsel) dsel.innerHTML = ps.length
    ? '<option value="">— 选预设追加 —</option>' + ps.map(opts).join("")
    : '<option value="">— 无已存队列 —</option>';
}

$("btnQSave").addEventListener("click", () => withBusy($("btnQSave"), "保存…", async () => {
  const name = $("qPresetName").value.trim();
  if (!name) { toast("请先填写队列预设名", "err"); return; }
  const r = await hub("queue/presets/save", { name }, 10000);
  if (r.ok) {
    $("qPresetName").value = "";
    toast(`队列预设「${name}」已保存(${r.count} 项, 含左右标记)`, "ok");
  } else {
    toast("保存失败: " + (r.error || ""), "err");
  }
  refreshQPresets();
}));

$("btnQLoad").addEventListener("click", () => withBusy($("btnQLoad"), "载入…", async () => {
  const name = $("qPresetSel").value;
  if (!name) { toast("先在下拉里选中要载入的队列", "err"); return; }
  if (!confirm(`载入队列预设「${name}」?\n当前未执行的队列项会被替换(已执行历史保留)。`)) return;
  const r = await hub("queue/presets/load", { name }, 10000);
  toast(r.ok ? `已载入「${name}」(现 ${r.pending} 项待执行)` : "载入失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  pollQueue();
}));

$("btnQDel").addEventListener("click", async () => {
  const name = $("qPresetSel").value;
  if (!name) { toast("先在下拉里选中要删的队列", "err"); return; }
  if (!confirm(`删除队列预设「${name}」?`)) return;
  const r = await hub("queue/presets/delete", { name }, 8000);
  toast(r.ok ? `已删除「${name}」` : "删除失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshQPresets();
});
refreshQPresets();

/* ---------------- ⑮ 循环执行 (串行 · 按⑨队列实际顺序; 与⑨同一条队列, 只加 loops) ---------------- */

/* ⑮ 卡列表只读, 复用 pollQueue 拉到的同一份 queue/state 渲染(增删/调序在 ⑨ 卡操作) */
function renderLoopCard(r) {
  const chip = $("duoChip"), cur = $("duoCurrent"), ul = $("duoList");
  if (!chip) return;
  const done = (r && r.done) || [], pend = (r && r.pending) || [];
  if (!r || !r.ok) {
    chip.className = "chip";
    chip.querySelector(".txt").textContent = "队列 —(调试台离线)";
    cur.textContent = "当前: —";
    ul.innerHTML = "";
    return;
  }
  chip.className = "chip " + (r.running ? "up" : "down");
  let txt = r.running ? "循环执行中" : "空闲";
  if (r.running && r.loop && r.loop.cycle > 0 && r.loop.total !== 1)
    txt += ` 第${r.loop.cycle}/${r.loop.total || "∞"}轮`;
  chip.querySelector(".txt").textContent = txt;
  cur.textContent = "当前: " +
    (r.current ? `[${sideCN(r.current.side)}] ${r.current.label}` : "—");
  if (!done.length && !pend.length && !r.current) {
    ul.innerHTML = "<li>队列为空 — 上方选预设「＋加入」追加, 或到 ④⑦⑧⑭ 点「＋队列」(实际顺序在此循环)</li>";
    return;
  }
  ul.innerHTML = "";
  for (const d of done.slice(-4)) {                     // 最近 4 条历史(只读, 复活在⑨)
    const li = document.createElement("li");
    li.className = "q-done";
    li.innerHTML = sideTag(d.side) +
      `<span class="name">${d.ok ? "✓" : "✗"}${d.cycle > 1 ? `(第${d.cycle}轮)` : " "}${d.label}</span>` +
      (d.detail ? `<span class="tag">${String(d.detail).slice(0, 40)}</span>` : "") + stepTimeTag(d);
    ul.appendChild(li);
  }
  if (r.current) {
    const li = document.createElement("li");
    li.className = "q-cur";
    li.innerHTML = sideTag(r.current.side) +
      `<span class="name">▶ ${r.current.label}</span><span class="tag">执行中</span>`;
    ul.appendChild(li);
  }
  for (const p of pend) {                                // 待执行(只读 — 调序/移除在 ⑨)
    const li = document.createElement("li");
    li.innerHTML = sideTag(p.side) + `<span class="name">· ${p.label}</span>`;
    ul.appendChild(li);
  }
}

$("btnDuoAdd").addEventListener("click", () => withBusy($("btnDuoAdd"), "追加…", async () => {
  const name = $("qDuoPresetSel").value;
  if (!name) { toast("先在下拉里选中要加入的预设", "err"); return; }
  const r = await hub("queue/presets/load", { name, append: true }, 10000);
  toast(r.ok ? `已按实际顺序追加「${name}」+${r.appended} 项(现 ${r.pending} 项待执行)`
             : "追加失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
}));

$("btnDuoRun").addEventListener("click", () => withBusy($("btnDuoRun"), "启动…", async () => {
  const st = await hub("queue/state", null, 5000);
  if (!st.ok) { toast("调试台离线", "err"); return; }
  if (st.running) { toast("队列已在执行中 — 如需改轮数先停止再重新开始", "err"); return; }
  const pend = st.pending || [];
  if (!pend.length) { toast("队列为空, 先「＋加入」预设或到 ④⑦⑧⑭ 入队", "err"); return; }
  const inf = $("qDuoLoopInf").checked;
  let loops = 1;
  if (!inf) {
    loops = Math.max(1, Math.min(999, parseInt($("qDuoLoops").value, 10) || 1));
    $("qDuoLoops").value = loops;
  }
  const loopTxt = inf ? "∞ 无限循环(直到停止)" : `循环 ${loops} 轮`;
  if (!confirm(`⑮ 循环执行(串行): 队列 ${pend.length} 项 × ${loopTxt}\n` +
      "— 按下面实际顺序逐项执行(两臂绝不并行), 跑完一轮自动重灌下一轮 —\n" +
      pend.map(p => `· [${sideCN(p.side)}] ${p.label}`).join("\n") +
      "\n\n任一项失败整队自动停; 执行中仍可热追加(只进当前轮)。确认两臂路径无障碍!")) return;
  const r = await hub("queue/run", { loops: inf ? 0 : loops }, 10000);
  toast(r.ok ? `循环开始(${loopTxt})` : "启动失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
}));

$("btnDuoStop").addEventListener("click", async () => {
  const r = await hub("queue/stop", {}, 10000);
  toast(r.ok ? "停止信号已发, 当前臂动作将在最近检查点停下" : "停止失败: " + (r.error || ""),
        r.ok ? "ok" : "err");
  pollQueue();
});

$("btnDuoClear").addEventListener("click", async () => {
  const r = await hub("queue/clear", {}, 8000);
  toast(r.ok ? "队列已清空" : "清空失败: " + (r.error || ""), r.ok ? "ok" : "err");
  pollQueue();
});

/* ⑮ → /run 运行页: 把当前组好的队列快照成运行页的最终流程(config/run_page.json, 独立文件) */
$("btnDuoSaveRun").addEventListener("click", () => withBusy($("btnDuoSaveRun"), "保存…", async () => {
  const st = await hub("queue/state", null, 5000);
  if (!st.ok) { toast("调试台离线", "err"); return; }
  if (st.running) { toast("执行中不能保存 — 先停止(跑中的待执行项只是本轮剩余)", "err"); return; }
  const pend = st.pending || [];
  if (!pend.length) { toast("队列为空 — 先「＋加入」预设或到 ④⑦⑧⑭ 入队", "err"); return; }
  if (!confirm(`把当前队列 ${pend.length} 项(按此实际顺序)保存为 /run 运行页的最终流程?\n` +
      pend.map(p => `· [${sideCN(p.side)}] ${p.label}`).join("\n") +
      "\n(写入运行页自己的文件, 不影响队列预设; 之后在运行页里改名称/参数/轮数)")) return;
  const r = await hub("runpage/fromqueue", {}, 10000);
  toast(r.ok ? `已保存 ${r.count} 项到运行页${r.named ? `(⑧×${r.named} 已标预设名)` : ""} — 点「打开运行页」查看/编辑/启动`
             : "保存失败: " + (r.error || ""), r.ok ? "ok" : "err");
}));

$("btnOpenRun").addEventListener("click", () => window.open("/run", "_blank", "noopener"));

/* ---------------- 启动 ---------------- */

function startPolling() {
  pollHealth(); setInterval(pollHealth, 2000);
  pollStatus(); setInterval(pollStatus, 1000);
  pollJoints(); setInterval(pollJoints, 1000);
  pollHistory(); setInterval(pollHistory, 1000);
  pollTail(); setInterval(pollTail, 2000);
  refreshTargets(); setInterval(refreshTargets, 6000);
  pollCartFk(); setInterval(pollCartFk, 1000);
  pollGraspState(); setInterval(pollGraspState, 2000);
  pollQueue(); setInterval(pollQueue, 1500);
  setInterval(drawChart, 2000); // 窗口变化时兜底重绘
}

restartVideo();
$("camCardRight").classList.add("active");
refreshParams();
refreshReference();
refreshTp();
renderGraspMoves();
refreshGraspPresets();
startPolling();

/* ---------------- ⭕ 一键恢复 (总电源重启后) ---------------- */

let recTimer = null;

function renderRecover(st) {
  const lines = (st.steps || []).slice();
  if (st.final) {
    const f = st.final;
    const al = f.align ? Object.entries(f.align).map(([s, v]) =>
      v ? `${ARM_CN[s]} XY=${v.xy}mm Z=${v.z}mm` : `${ARM_CN[s]}未完成`).join(" · ") : "";
    lines.push(`===== ${f.ok ? "✅ 恢复成功" : "❌ 有失败步骤"} (${f.elapsed_s || "?"}s) ${al} =====`);
    if (f.gripper_fault) lines.push("⚠ 夹爪内部通讯故障未消除: 等臂停稳 → 再断一次总电源 → 再点本按钮");
  }
  $("recLog").textContent = lines.length ? lines.join("\n") : "—";
}

async function pollRecover() {
  const st = await getJSON("/api/recover/progress", 5000);
  renderRecover(st);
  if (st.running) {
    recTimer = setTimeout(pollRecover, 1000);
  } else {
    $("btnRecover").disabled = false;
    if (st.final && st.steps.length) toast(st.final.ok ? "恢复完成 ✅" : "恢复有失败步骤,看日志", st.final.ok ? "" : "err");
  }
}

$("btnRecover").addEventListener("click", async () => {
  const move = $("recMove").checked;
  if (move && !confirm("恢复会回放取料位并做 PBVS 对准,机械臂将运动。\n确认臂周围无人、无障碍物?")) return;
  $("btnRecover").disabled = true;
  $("recLog").textContent = "启动恢复…";
  const r = await fetch("/api/recover", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ move })
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) { toast(d.error || "启动失败", "err"); $("btnRecover").disabled = false; return; }
  clearTimeout(recTimer);
  pollRecover();
});

// 页面打开时若恢复正在跑,接上进度
getJSON("/api/recover/progress", 5000).then(st => {
  if (st && (st.running || (st.steps || []).length)) {
    $("btnRecover").disabled = !!st.running;
    if (st.running) pollRecover();
  }
});

/* ---------------- 全局运动速度 (当前臂, 持久化在 PBVS 侧) ---------------- */

async function refreshSpeed() {
  const r = await pbvs("speed", null, 5000);
  if (r.ok) {
    $("armSpeed").value = r.speed;
    $("armSpeedVal").textContent = r.speed + "%";
  }
}
$("armSpeed").addEventListener("input", () => {
  $("armSpeedVal").textContent = $("armSpeed").value + "%";
});
$("armSpeed").addEventListener("change", async () => {
  const v = parseInt($("armSpeed").value, 10);
  const r = await pbvs("speed", { speed: v }, 8000);
  if (r.ok) {
    $("armSpeed").value = r.speed;
    $("armSpeedVal").textContent = r.speed + "%";
    toast(`${ARM_CN[state.side]}全局速度 → ${r.speed}%`, "ok");
  } else {
    toast("设速失败: " + (r.error || ""), "err");
    refreshSpeed();
  }
});
refreshSpeed();

/* ---------------- ⚙ 模块显示/隐藏 (localStorage 持久化) ---------------- */

const MODULES = [
  ["cardRecover", "⭕ 一键恢复"],
  ["cardCamera", "① 相机"],
  ["cardCalib", "② 标定"],
  ["cardTeach", "③ 示教 / 目标"],
  ["cardAlign", "④ 对准"],
  ["cardParams", "⑤ 参数"],
  ["cardRef", "⑥ 参考数据"],
  ["cardCart", "⑦ 笛卡尔示教"],
  ["cardGrasp", "⑧ 抓取序列"],
  ["cardQueue", "⑨ 动作队列"],
  ["cardPose", "⑩ 姿态检测"],
  ["cardBox", "⑪ 整箱检测"],
  ["cardPick", "⑫ 整箱抓取"],
  ["cardSuction", "⑭ 单袋吸取"],
  ["cardDuo", "⑮ 循环执行(串行)"],
  ["cardToolcal", "⑬ 工具标定"],
  ["cardJoints", "关节角表"],
  ["cardLog", "实例日志"],
];
const MOD_KEY = "pbvs_hidden_modules";

function hiddenMods() {
  try { return new Set(JSON.parse(localStorage.getItem(MOD_KEY)) || []); }
  catch { return new Set(); }
}

function applyModules() {
  const h = hiddenMods();
  for (const [id] of MODULES) {
    const el = $(id);
    if (el) el.style.display = h.has(id) ? "none" : "";
  }
}

function renderModuleList() {
  const h = hiddenMods();
  $("moduleList").innerHTML = MODULES.map(([id, name]) =>
    `<label class="chk"><input type="checkbox" data-mod="${id}"${h.has(id) ? "" : " checked"}> ${name}</label>`
  ).join("");
}

$("settingsPanel").addEventListener("change", e => {
  const id = e.target.dataset && e.target.dataset.mod;
  if (!id) return;
  const h = hiddenMods();
  e.target.checked ? h.delete(id) : h.add(id);
  localStorage.setItem(MOD_KEY, JSON.stringify([...h]));
  applyModules();
});

$("btnSettings").addEventListener("click", e => {
  e.stopPropagation();
  const p = $("settingsPanel");
  p.hidden = !p.hidden;
  if (!p.hidden) renderModuleList();
});
document.addEventListener("click", e => {
  const p = $("settingsPanel");
  if (!p.hidden && !p.contains(e.target) && e.target !== $("btnSettings")) p.hidden = true;
});
$("btnModulesAll").addEventListener("click", () => {
  localStorage.setItem(MOD_KEY, "[]");
  applyModules();
  renderModuleList();
  toast("已显示全部模块", "ok");
});
applyModules();

/* ---------------- ④ 对准位置微调 (平移收敛点, 不动臂不动爪) ---------------- */
/* 相机系: dx<0=画面左, dy<0=画面上, dz>0=更远; 预览里红框(目标)即时移动, QR 会追到新位置 */
const OFF_VEC = { u: [0, -1, 0], d: [0, 1, 0], l: [-1, 0, 0], r: [1, 0, 0], far: [0, 0, 1], near: [0, 0, -1] };
const OFF_CN = { u: "上移", d: "下移", l: "左移", r: "右移", far: "变远", near: "变近" };

function fmtOff(o) {
  const f = v => (v > 0 ? "+" : "") + v;
  return `偏移 X${f(o[0])} Y${f(o[1])} Z${f(o[2])} mm`;
}

async function refreshOffset() {
  const r = await pbvs("targets/offset", null, 6000);
  $("offNow").textContent = r.ok ? fmtOff(r.offset_applied_mm) : (r.error || "偏移 —");
}

$("offPad").addEventListener("click", async e => {
  const b = e.target.closest("button[data-d]");
  if (!b) return;
  const d = b.dataset.d, s = parseFloat($("offStep").value);
  const [x, y, z] = OFF_VEC[d];
  const r = await pbvs("targets/offset", { dx_mm: x * s, dy_mm: y * s, dz_mm: z * s }, 8000);
  toast(r.ok ? `收敛点${OFF_CN[d]} ${s}mm(${fmtOff(r.offset_applied_mm)})`
             : "平移失败: " + (r.error || ""), r.ok ? "ok" : "err");
  refreshOffset();
});

/* 分块平移(单次上限 150mm), 返回是否全部成功 */
async function applyOffset(dx, dy, dz) {
  const cl = v => Math.max(-100, Math.min(100, v));
  let n = 0;
  while ((Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05 || Math.abs(dz) > 0.05) && n++ < 10) {
    const cx = cl(dx), cy = cl(dy), cz = cl(dz);
    const r = await pbvs("targets/offset", { dx_mm: cx, dy_mm: cy, dz_mm: cz }, 8000);
    if (!r.ok) { toast("平移失败: " + (r.error || ""), "err"); return false; }
    dx -= cx; dy -= cy; dz -= cz;
  }
  return true;
}

$("btnOffCenter").addEventListener("click", async () => {
  const g = await pbvs("targets/offset", null, 6000);
  if (!g.ok || !g.marker_3d_mm) { toast(g.error || "读取目标失败", "err"); return; }
  const [x, y, z] = g.marker_3d_mm;
  if (Math.abs(x) < 0.05 && Math.abs(y) < 0.05) { toast("目标已在画面中心"); return; }
  if (await applyOffset(0 - x, 0 - y, 0))
    toast(`收敛点已回中: X ${x}→0, Y ${y}→0 mm(工作距 ${z}mm 不变)`, "ok");
  refreshOffset();
});

$("btnOffReset").addEventListener("click", async () => {
  const g = await pbvs("targets/offset", null, 6000);
  if (!g.ok) { toast(g.error || "读取偏移失败", "err"); return; }
  const o = g.offset_applied_mm;
  if (!o || o.every(v => Math.abs(v) < 0.05)) { toast("本来就没有偏移"); return; }
  if (await applyOffset(-o[0], -o[1], -o[2]))
    toast("收敛点已复位到录入原位", "ok");
  refreshOffset();
});
refreshOffset();
