/* 3D 空间预览 + 工具坐标系编辑 — three.js + urdf-loader(ES module, 自包含)
 * 数据源: /api/arm/joints(双臂关节, 500ms) · /api/{side}/pbvs/cart/fk(TCP 位姿)
 *         /api/{side}/pbvs/cart/tool(工具坐标系 GET/POST, 全链路热生效)
 * 与 app.js 的耦合仅两个事件: pbvs-side(活动臂变化) / pbvs-view(相机|3d 切换)
 */
import * as THREE from './vendor/arm-viewer/three.module.js';
import { OrbitControls } from './vendor/arm-viewer/three-addons/controls/OrbitControls.js';
import URDFLoader from './vendor/arm-viewer/urdf-loader/URDFLoader.js';

const $ = id => document.getElementById(id);

// URDF 命名: 关节 {side}_tl_robot_joint1..7, 法兰 link7, 基座 link0
const SIDES = {
  left: { prefix: 'left_tl_robot' },
  right: { prefix: 'right_tl_robot' },
};
const ARM_KEY = { left: 'armleft', right: 'armright' };

/* ---------------- 工具偏移本地状态(m / rad) ---------------- */
const tool = {
  left: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
  right: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
};
let activeSide = 'right';
let viewActive = false;          // 3D 视图打开且页面可见
let dirty = true;                // 关节/工具有变化, 需要重渲染

/* ---------------- three.js 场景(URDF 为 z 朝上) ---------------- */
const container = $('v3dCanvas');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 60);
camera.up.set(0, 0, 1);
// WebGL 上下文可能创建失败(浏览器禁用硬件加速/远程桌面/无头环境)。
// 此时降级为"仅工具编辑面板": 不能让异常杀死整个模块 — 否则面板事件全部不挂,
// 加载文案永远停在"正在加载"。scene/camera 等纯对象不需要 GL 上下文。
let renderer = null;
let controls = null;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  container.appendChild(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 0, 0.85);
} catch (e) {
  $('v3dLoading').textContent =
    '⚠ 此浏览器无法创建 WebGL 上下文, 3D 模型不可显示。' +
    '右侧工具坐标系的读取/保存仍可用; 建议改用 Chrome/Edge 或在浏览器设置中开启硬件加速。';
  console.warn('WebGL 初始化失败:', e);
}

scene.add(new THREE.HemisphereLight(0xffffff, 0x1e293b, 2.1));
const key = new THREE.DirectionalLight(0xffffff, 2.4);
key.position.set(2.5, -3, 4);
scene.add(key);

const grid = new THREE.GridHelper(3, 12, 0x6b83aa, 0x2c2c2a);
grid.rotation.x = Math.PI / 2;   // XY 平面(z 朝上)
scene.add(grid);

function resetCamera() {
  camera.position.set(1.9, -1.9, 1.5);
  if (controls) {
    controls.target.set(0, 0, 0.85);
    controls.update();
  }
}
resetCamera();

/* ---------------- 坐标轴 triad(ROS 惯例: X红 Y绿 Z蓝) ---------------- */
function makeTriad(len, thick) {
  const g = new THREE.Group();
  const axes = [
    [0xe05252, new THREE.Vector3(1, 0, 0)],
    [0x47b04b, new THREE.Vector3(0, 1, 0)],
    [0x3f7fd9, new THREE.Vector3(0, 0, 1)],
  ];
  for (const [color, dir] of axes) {
    const mat = new THREE.MeshBasicMaterial({ color });
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(thick, thick, len * 0.78, 8), mat);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(thick * 2.4, len * 0.22, 10), mat);
    const holder = new THREE.Group();
    shaft.position.y = len * 0.39;
    tip.position.y = len * 0.88;
    holder.add(shaft, tip);
    // 圆柱默认沿 +Y, 把它旋到目标轴
    holder.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    g.add(holder);
  }
  const org = new THREE.Mesh(
    new THREE.SphereGeometry(thick * 2.6, 10, 10),
    new THREE.MeshBasicMaterial({ color: 0xdddddd }));
  g.add(org);
  return g;
}

const triads = {
  base: {},   // 每臂 link0(基座系, fk 的参考系)
  flange: {}, // 每臂 link7(法兰系)
  tool: {},   // 每臂 TCP(工具系, 场景级, 每帧更新)
};
const tcpLines = {};   // 法兰原点 → TCP 连线

function toolMat4(side) {
  // ROS rpy = Rz@Ry@Rx ⇔ three Euler 顺序 'ZYX'
  const t = tool[side];
  const m = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(t.rx, t.ry, t.rz, 'ZYX'));
  m.setPosition(t.x, t.y, t.z);
  return m;
}

/* ---------------- 加载机器人 ---------------- */
const flangeLink = {};
let robotRoot = null;

async function loadRobot() {
  const loader = new URDFLoader();
  loader.packages = { tl_robot_description: '/static/robot/' };
  robotRoot = await loader.loadAsync('/static/robot/urdf/y4_ft_705vh_description.urdf');
  scene.add(robotRoot);

  for (const [side, cfg] of Object.entries(SIDES)) {
    const base = robotRoot.links[`${cfg.prefix}_link0`];
    const flange = robotRoot.links[`${cfg.prefix}_link7`];
    if (base) {
      triads.base[side] = makeTriad(0.10, 0.0035);
      base.add(triads.base[side]);
    }
    if (flange) {
      flangeLink[side] = flange;
      triads.flange[side] = makeTriad(0.06, 0.0025);
      flange.add(triads.flange[side]);
      // TCP triad 与连线放场景级, 每帧按 法兰世界阵 × 工具偏移 更新
      triads.tool[side] = makeTriad(0.08, 0.003);
      scene.add(triads.tool[side]);
      const geo = new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(), new THREE.Vector3()]);
      tcpLines[side] = new THREE.Line(geo,
        new THREE.LineBasicMaterial({ color: 0xfab219 }));
      tcpLines[side].frustumCulled = false;
      scene.add(tcpLines[side]);
    }
  }
  applyShowToggles();
  $('v3dLoading').textContent = '';
  dirty = true;
}

/* TCP = 法兰世界矩阵 · 工具偏移 */
const _m = new THREE.Matrix4();
function updateTcp() {
  if (!robotRoot) return;
  robotRoot.updateMatrixWorld(true);
  for (const side of Object.keys(SIDES)) {
    const fl = flangeLink[side];
    if (!fl || !triads.tool[side]) continue;
    _m.copy(fl.matrixWorld).multiply(toolMat4(side));
    triads.tool[side].position.setFromMatrixPosition(_m);
    triads.tool[side].quaternion.setFromRotationMatrix(_m);
    const p0 = new THREE.Vector3().setFromMatrixPosition(fl.matrixWorld);
    const p1 = new THREE.Vector3().setFromMatrixPosition(_m);
    const pos = tcpLines[side].geometry.attributes.position;
    pos.setXYZ(0, p0.x, p0.y, p0.z);
    pos.setXYZ(1, p1.x, p1.y, p1.z);
    pos.needsUpdate = true;
    const identity = isIdentity(tool[side]);
    tcpLines[side].visible = $('v3dShowTool').checked && !identity;
  }
}

/* ---------------- 关节轮询(仅 3D 视图激活时拉取) ---------------- */
async function pollJoints() {
  if (!viewActive || !robotRoot || !renderer) return;   // 无渲染器时不必拉关节
  try {
    const r = await fetch('/api/arm/joints', { cache: 'no-store' });
    const j = await r.json();
    if (!j.ok || !j.data) return;
    for (const side of Object.keys(SIDES)) {
      const degs = j.data[`${ARM_KEY[side]}_joint_angle_deg`];
      if (!Array.isArray(degs)) continue;
      for (let i = 0; i < 7; i++) {
        const joint = robotRoot.joints[`${SIDES[side].prefix}_joint${i + 1}`];
        if (joint) joint.setJointValue(degToRad(degs[i]));
      }
    }
    dirty = true;
  } catch { /* 轮询失败静默, 下轮再试 */ }
}
const degToRad = v => (Number.isFinite(v) ? v * Math.PI / 180 : 0);
const radToDeg = v => v * 180 / Math.PI;

/* ---------------- TCP 位姿读数 ---------------- */
async function pollFk() {
  if (!viewActive) return;
  const el = $('toolTcpPose');
  try {
    const r = await fetch(`/api/${activeSide}/pbvs/cart/fk`, { cache: 'no-store' });
    const d = await r.json();
    if (!d.ok || !d.pose) { el.textContent = 'TCP: —(PBVS 实例离线?)'; return; }
    const p = d.pose_tcp || d.pose;
    el.textContent = `TCP x/y/z = ${[p.x, p.y, p.z].map(v => (v * 1000).toFixed(1)).join(', ')} mm  |  ` +
      `rpy = ${[p.rx, p.ry, p.rz].map(radToDeg).map(v => v.toFixed(1)).join(', ')} °` +
      (d.tool && d.tool.identity === false ? '  (工具偏移已生效)' : '');
  } catch { el.textContent = 'TCP: —'; }
}

/* ---------------- 工具坐标系 API ---------------- */
async function getJSON(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    return await r.json();
  } catch { return { ok: false, error: '请求失败' }; }
  finally { clearTimeout(timer); }
}

async function loadTool(side) {
  const r = await getJSON(`/api/${side}/pbvs/cart/tool`, 6000);
  if (r.ok) {
    tool[side] = { x: r.x || 0, y: r.y || 0, z: r.z || 0,
                   rx: r.rx || 0, ry: r.ry || 0, rz: r.rz || 0 };
    if (side === activeSide) fillInputs();
    dirty = true;
  }
  return r;
}

async function saveTool(identity) {
  const body = identity ? { identity: true }
    : { x: tool[activeSide].x, y: tool[activeSide].y, z: tool[activeSide].z,
        rx: tool[activeSide].rx, ry: tool[activeSide].ry, rz: tool[activeSide].rz };
  try {
    const r = await fetch(`/api/${activeSide}/pbvs/cart/tool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (d.ok) {
      tool[activeSide] = { x: d.x || 0, y: d.y || 0, z: d.z || 0,
                           rx: d.rx || 0, ry: d.ry || 0, rz: d.rz || 0 };
      fillInputs();
      $('toolResult').textContent =
        `✓ 已保存并生效(${activeSide === 'left' ? '左' : '右'}臂, 持久化到 tool_frame_${activeSide === 'left' ? 'Left' : 'Right'}_Arm.json)` +
        (d.fk && d.fk.pose_tcp ?
          `\nTCP: x/y/z=${[d.fk.pose_tcp.x, d.fk.pose_tcp.y, d.fk.pose_tcp.z].map(v => (v * 1000).toFixed(1)).join(', ')} mm` : '');
      dirty = true;
    } else {
      $('toolResult').textContent = '✗ ' + (d.error || '保存失败');
    }
    pollFk();
  } catch (e) {
    $('toolResult').textContent = '✗ 请求失败: ' + e;
  }
}

/* ---------------- 编辑面板 ---------------- */
const TOOL_INPUTS = ['toolX', 'toolY', 'toolZ', 'toolRx', 'toolRy', 'toolRz'];
// 输入框单位 mm/°, 存储 m/rad
const IN_KEY = { toolX: 'x', toolY: 'y', toolZ: 'z', toolRx: 'rx', toolRy: 'ry', toolRz: 'rz' };
const IN_ANG = { rx: 1, ry: 1, rz: 1 };

function fillInputs() {
  const t = tool[activeSide];
  for (const id of TOOL_INPUTS) {
    const k = IN_KEY[id];
    $(id).value = IN_ANG[k] ? radToDeg(t[k]).toFixed(2) : (t[k] * 1000).toFixed(2);
  }
  $('toolSide').textContent = activeSide;
}

for (const id of TOOL_INPUTS) {
  $(id).addEventListener('input', () => {
    const k = IN_KEY[id];
    const v = parseFloat($(id).value);
    if (!Number.isFinite(v)) return;
    tool[activeSide][k] = IN_ANG[k] ? degToRad(v) : v / 1000;   // 即时预览
    dirty = true;
  });
}
$('btnToolRead').addEventListener('click', async () => {
  const r = await loadTool(activeSide);
  $('toolResult').textContent = r.ok ? '✓ 已读取当前值' : '✗ ' + (r.error || '读取失败');
});
$('btnToolSave').addEventListener('click', () => saveTool(false));
$('btnToolReset').addEventListener('click', () => {
  if (!confirm(`重置${activeSide === 'left' ? '左' : '右'}臂工具偏移为零(=法兰)?保存后立即生效。`)) return;
  saveTool(true);
});

/* 显示开关 */
function applyShowToggles() {
  for (const side of Object.keys(SIDES)) {
    if (triads.base[side]) triads.base[side].visible = $('v3dShowBase').checked;
    if (triads.flange[side]) triads.flange[side].visible = $('v3dShowFlange').checked;
    if (triads.tool[side]) {
      triads.tool[side].visible = $('v3dShowTool').checked;
      if (tcpLines[side]) tcpLines[side].visible =
        $('v3dShowTool').checked && !isIdentity(tool[side]);
    }
  }
  dirty = true;
}
const isIdentity = t => t.x === 0 && t.y === 0 && t.z === 0 &&
                        t.rx === 0 && t.ry === 0 && t.rz === 0;
for (const id of ['v3dShowBase', 'v3dShowFlange', 'v3dShowTool'])
  $(id).addEventListener('change', applyShowToggles);

/* 复位视角按钮(画布右上角) */
const camBtn = document.createElement('button');
camBtn.textContent = '⌂ 复位视角';
camBtn.style.cssText =
  'position:absolute;top:8px;right:8px;z-index:2;padding:4px 10px;font-size:12px;' +
  'background:rgba(26,26,25,.8);color:#c3c2b7;border:1px solid rgba(255,255,255,.15);border-radius:6px';
camBtn.addEventListener('click', resetCamera);
if (renderer) container.appendChild(camBtn);   // 无 WebGL 时画布不可用, 不放复位按钮

/* ---------------- 渲染循环(视图激活才跑) ---------------- */
function ensureSize() {
  if (!renderer) return;
  const w = container.clientWidth, h = container.clientHeight;
  if (w < 2 || h < 2) return;
  const need = camera.aspect !== w / h || renderer.domElement.width !== Math.floor(w * renderer.getPixelRatio());
  if (need) {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
}

function loop() {
  if (!viewActive || !renderer) return;
  requestAnimationFrame(loop);
  ensureSize();
  if (controls) controls.update();
  updateTcp();          // 工具 triad 跟随法兰 + 编辑即时预览
  if (dirty || (controls && controls.enabled)) {
    renderer.render(scene, camera);
    dirty = false;
  }
}

function setViewActive(v) {
  const pageVisible = document.visibilityState === 'visible';
  const next = v && pageVisible;
  if (next === viewActive) return;
  viewActive = next;
  if (viewActive) { ensureSize(); loop(); pollJoints(); pollFk(); }
}

document.addEventListener('pbvs-view', e => setViewActive(e.detail === '3d'));
document.addEventListener('visibilitychange', () => setViewActive($('view3d') && !$('view3d').hidden));
document.addEventListener('pbvs-side', e => {
  activeSide = e.detail || 'right';
  fillInputs();
  pollFk();
});

/* ---------------- 启动 ---------------- */
if (renderer) {
  loadRobot().catch(e => {
    $('v3dLoading').textContent = '模型加载失败: ' + e +
      '(检查 /static/robot/ 下的 urdf 与 meshes)';
  });
}
loadTool('left');
loadTool('right');
setInterval(pollJoints, 500);
setInterval(pollFk, 1000);
fillInputs();
