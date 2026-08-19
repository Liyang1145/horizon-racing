// ============================================================
//  主控制器 — 初始化 / 主循环 / 输入 / 视角 / 赛事
// ============================================================
'use strict';

const Game = {
  state: 'boot', mode: 'free',
  renderer: null, scene: null, camera: null,
  world: null, car: null, traffic: null,
  keys: {}, camMode: 0, headlightMode: 0,
  lookActive: false, lookYaw: 0, lookPitch: 0,
  camPos: new THREE.Vector3(30, 8, 30), camLook: new THREE.Vector3(0, 0, 0),
  camFov: 64, shake: 0, menuT: 0,
  skillScore: 0,
  raceActive: false, raceStarted: false, raceCountdown: 0,
  raceTime: 0, racePar: 0, raceCpIdx: 0, raceCpNext: 0, raceCheckpoints: [],
  opponents: [], oppRoute: null, racePlayerIdx: 0, racePosition: 1, raceFinishPos: 0,
  racePlayerArc: 0,
  nearMissCd: 0, driftMilestone: 500, driftPopupCd: 0, topSpeedCd: 0,
  lastAirborne: false, airStart: 0, landedT: 0,
  speedZone: { inZone: false, best: 0 },
  helpVisible: false,
  trailEnabled: true,
  trailBoxEnabled: true,
  mapOpen: false, pausedByMap: false,
  recoverCd: 0,
  lastT: 0,
  aiActive: false, aiMode: '', aiStage: 0, aiStageTime: 0, aiDone: false,
  ai: new DriftAI(),
  raceTest: false, raceTestAi: null,
  savedTuning: null,
  mapIndex: 0,
  // —— 开发者模式（I 进入 / H 退出）——
  devMode: false, devYaw: 0, devPitch: 0, devPos: null,
  devBrushR: 9, devBrush: 0,
  devRoadMode: false, devRoadPts: [],
  devHud: null, devTmpV: null, devRay: null,
  devMouse: { x: 0, y: 0 },
  devBrushRing: null,
  devUndoStack: [], devSnap: null,
  chaseOff: 0, chasePrevSpeed: 0, chaseAccel: 0,
  chaseHeight: 0, camPosY: null, camTargetY: null, camNoseSmooth: 0,
  camLookY: null, camTuneOpen: false,
  p918TuneOpen: false,
  chaseTune: { dist: 6.2, pull: 1.2, accK: 0.09, accMax: 2.0, brkK: 0.10, brkMax: 1.5, rate: 4.0, hgtK: 0.022, height: 2.30 },
  devRoadMarks: [], devRoadLine: null,
  timeScale: 1, // L 键：游戏加速 4 倍 / 恢复
  slowmo: 1, slowmoActive: false, slowmoT: 0, slowmoStarted: false, landScored: false,
  slowmoJumpX: null, slowmoJumpZ: null,
  wheelDbg: false, _dbgQ: null,
  seasonFadeT: 0,
  jumpTestActive: false, jumpTestT: 0, jumpTestMaxAir: 0, jumpTestYaw: 0,
  jumpColSave: null,

  // ================= 开发者模式（I 进入 / H 退出） =================
  enterDevMode() {
    if (this.devMode || !this.world || !this.world.terrainMesh) return;
    this.devMode = true;
    this.devRoadMode = false;
    this.devRoadPts = [];
    this.devBrush = 0;
    const c = this.camera;
    this.devPos = c.position.clone();
    const dir = this.devTmpV || new THREE.Vector3();
    c.getWorldDirection(dir);
    this.devYaw = Math.atan2(dir.x, dir.z);
    this.devPitch = Math.asin(Math.max(-1, Math.min(1, dir.y)));
    if (!this.devHud) {
      this.devHud = document.createElement('div');
      this.devHud.style.cssText =
        'position:fixed;left:16px;top:16px;z-index:99;background:rgba(8,10,16,.85);' +
        'color:#ffd24a;font:13px/1.6 "Microsoft YaHei",sans-serif;padding:10px 14px;' +
        'border:1px solid rgba(255,210,74,.45);border-radius:8px;pointer-events:none;white-space:pre;';
      document.body.appendChild(this.devHud);
    }
    this.devHud.style.display = 'block';
    if (!this.devBrushRing) {
      const pts = [];
      for (let k = 0; k <= 64; k++) {
        const a = k / 64 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      this.devBrushRing = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({
        color: 0xffd24a, transparent: true, opacity: 0.95, depthTest: false,
      }));
      this.devBrushRing.visible = false;
      this.scene.add(this.devBrushRing);
    }
    this.devBrushRing.visible = true;
    this.devBrushRing.scale.set(this.devBrushR, 1, this.devBrushR);
    this.updateDevHud();
    UI.toast('开发者模式 · H 退出');
  },

  exitDevMode() {
    if (!this.devMode) return;
    this.devMode = false;
    this.devBrush = 0;
    this.devRoadMode = false;
    this.devRoadPts = [];
    this.devBrush = 0;
    this.clearDevRoadMarks();
    if (this.devBrushRing) this.devBrushRing.visible = false;
    if (this.devHud) this.devHud.style.display = 'none';
    UI.toast('已退出开发者模式');
  },

  async undoDevTerrain() {
    const snap = this.devUndoStack.pop();
    if (!snap) return;
    this.world.heightEdit.set(snap);
    this.world.devBusy = true;
    this.updateDevHud();
    UI.toast('正在撤销地形修改…');
    try {
      await this.world.syncTerrainAfterEdit();
      UI.toast('已撤销上一次地形修改');
    } catch (e) {
      console.error('undo terrain failed', e);
      UI.toast('撤销失败');
    }
    this.world.devBusy = false;
    this.updateDevHud();
  },

  toggleDevRoad() {
    if (!this.devMode) return;
    this.devRoadMode = !this.devRoadMode;
    if (!this.devRoadMode) this.devRoadPts = [];
    this.clearDevRoadMarks();
    this.updateDevHud();
  },

  async finishDevRoad() {
    if (!this.devMode || !this.devRoadMode || this.devRoadPts.length < 2 || this.world.devBusy) return;
    const pts = this.devRoadPts.slice();
    this.devRoadPts = [];
    this.devRoadMode = false;
    this.clearDevRoadMarks();
    this.world.devBusy = true;
    this.updateDevHud();
    UI.toast('正在重建道路与地形…');
    try {
      await this.world.addDevRoad(pts);
      UI.toast('道路已生成（' + pts.length + ' 点）');
    } catch (err) {
      console.error('addDevRoad failed', err);
      UI.toast('道路生成失败');
    }
    this.world.devBusy = false;
    this.updateDevHud();
  },

  updateDevHud() {
    if (!this.devHud) return;
    const road = this.devRoadMode
      ? '开启（已放置 ' + this.devRoadPts.length + ' 点，Enter 完成 / Esc 取消）'
      : '关闭（按 R 开启）';
    this.devHud.textContent =
      '开发者模式 · H 退出\n' +
      'WASD 飞行 · Q/E 升降 · Shift 加速 · 方向键视角\n' +
      '左键抬地 / 右键降地 · B 笔刷半径 ' + this.devBrushR + 'm · V 撤销\n' +
      '道路编辑: ' + road;
  },

  // 游戏内追逐视角调参滑条（P 键开关）
  setupCamTuneUI() {
    const btn = document.getElementById('btnJumpTest');
    if (btn) btn.onclick = () => this.startJumpTest();
    const btnP918 = document.getElementById('btnP918Tune');
    if (btnP918) btnP918.onclick = () => this.toggleP918Tune();
    const btnTrail = document.getElementById('btnTrail');
    if (btnTrail) btnTrail.onclick = () => {
      this.trailEnabled = !this.trailEnabled;
      btnTrail.textContent = '尾灯拖尾：' + (this.trailEnabled ? '开' : '关');
      btnTrail.style.borderColor = this.trailEnabled ? '#ff8a2a' : '#666';
      btnTrail.style.background = this.trailEnabled ? 'rgba(255,138,42,.15)' : 'rgba(80,80,80,.2)';
      if (this.world && this.world.tailTrail) this.world.tailTrail.setVisible(this.trailEnabled);
      UI.toast('尾灯拖尾 ' + (this.trailEnabled ? '开' : '关'));
    };
    const btnTrailBox = document.getElementById('btnTrailBox');
    if (btnTrailBox) btnTrailBox.onclick = () => {
      this.trailBoxEnabled = !this.trailBoxEnabled;
      btnTrailBox.textContent = '长方体光管：' + (this.trailBoxEnabled ? '开' : '关');
      btnTrailBox.style.borderColor = this.trailBoxEnabled ? '#ff8a2a' : '#666';
      btnTrailBox.style.background = this.trailBoxEnabled ? 'rgba(255,138,42,.15)' : 'rgba(80,80,80,.2)';
      if (this.world && this.world.tailTrailBox) this.world.tailTrailBox.setVisible(this.trailBoxEnabled);
      UI.toast('长方体光管 ' + (this.trailBoxEnabled ? '开' : '关'));
    };
    // 音量通道
    try {
      const savedVol = JSON.parse(localStorage.getItem('horizonVol') || 'null');
      if (savedVol) AudioSys.volume = savedVol.master || AudioSys.volume;
    } catch (e) { /* ignore */ }
    for (const [id, type, div] of [['auEngine', 'engine', 100], ['auAmbient', 'ambient', 100], ['auSfx', 'sfx', 100]]) {
      const el = document.getElementById(id), lb = document.getElementById(id + 'V');
      if (!el || !lb) continue;
      const cur = type === 'engine' ? 0.9 : type === 'ambient' ? 1.0 : 0.9;
      el.value = Math.round(cur * div);
      lb.textContent = cur.toFixed(2);
      el.oninput = () => {
        const v = el.value / div;
        AudioSys.setVolume(type, v);
        lb.textContent = v.toFixed(2);
        try {
          localStorage.setItem('horizonVol', JSON.stringify({ engine: AudioSys.engineGain ? AudioSys.engineGain.gain.value : 0.9, ambient: AudioSys.ambientGain ? AudioSys.ambientGain.gain.value : 1, sfx: AudioSys.sfxGain ? AudioSys.sfxGain.gain.value : 0.9 }));
        } catch (e2) { /* ignore */ }
      };
    }
    const map = [
      ['ctDist', 'dist', 10, 'm'], ['ctPull', 'pull', 10, 'm'],
      ['ctAccK', 'accK', 100, ''], ['ctAccMax', 'accMax', 10, 'm'],
      ['ctBrkK', 'brkK', 100, ''], ['ctBrkMax', 'brkMax', 10, 'm'],
      ['ctRate', 'rate', 10, ''], ['ctHgtK', 'hgtK', 1000, ''],
      ['ctHeight', 'height', 10, 'm'],
    ];
    try {
      const saved = JSON.parse(localStorage.getItem('horizonCamTune') || 'null');
      if (saved) Object.assign(this.chaseTune, saved);
    } catch (e) { /* ignore */ }
    for (const [id, key, div, unit] of map) {
      const el = document.getElementById(id), lb = document.getElementById(id + 'V');
      if (!el || !lb) continue;
      el.value = Math.round(clamp(this.chaseTune[key] * div, +el.min, +el.max));
      lb.textContent = this.chaseTune[key].toFixed(2) + unit;
      el.oninput = () => {
        this.chaseTune[key] = el.value / div;
        lb.textContent = this.chaseTune[key].toFixed(2) + unit;
        try { localStorage.setItem('horizonCamTune', JSON.stringify(this.chaseTune)); } catch (e2) { /* ignore */ }
      };
    }
  },

  // 918 专属控制面板：游戏中 O 键开关，所有参数滑动条实时生效
  setupP918TuneUI() {
    try {
      const saved = JSON.parse(localStorage.getItem('horizonP918Tune') || '{}');
      for (const k of Object.keys(P918_TUNE)) {
        if (typeof saved[k] === 'number') P918_TUNE[k] = saved[k];
      }
      // 底层修复后轮子默认左右朝向已正确，旧的手动左右偏移清零，避免叠加错位
      P918_TUNE.rimFL = P918_TUNE.rimFR = P918_TUNE.rimRL = P918_TUNE.rimRR = 0;
      P918_TUNE.tireFL = P918_TUNE.tireFR = P918_TUNE.tireRL = P918_TUNE.tireRR = 0;
      P918_TUNE.rimOffsetX = 0;
    } catch (e) { /* ignore */ }
    const map = [
      ['p918Susp', 'suspStiff', 50, 200],
      ['p918DampC', 'dampComp', 50, 200],
      ['p918DampR', 'dampRelax', 50, 200],
      ['p918Grip', 'gripK', 60, 180],
      ['p918Steer', 'steerK', 50, 200],
      ['p918SteerMax', 'steerMax', 50, 180],
      ['p918BrakeF', 'brakeF', 60, 200],
      ['p918BrakeR', 'brakeR', 60, 200],
      ['p918Aero', 'downforceK', 50, 250],
      ['p918Power', 'torqueK', 60, 180],
      ['p918Roll', 'rollK', 50, 200],
      ['p918Shift', 'shiftSpeed', 50, 200],
    ];
    for (const [id, key, min, max] of map) {
      const el = document.getElementById(id), lb = document.getElementById(id + 'V');
      if (!el || !lb) continue;
      el.min = min; el.max = max;
      el.value = Math.round(clamp(P918_TUNE[key], min / 100, max / 100) * 100);
      lb.textContent = Math.round(P918_TUNE[key] * 100) + '%';
      el.oninput = () => {
        P918_TUNE[key] = el.value / 100;
        lb.textContent = Math.round(P918_TUNE[key] * 100) + '%';
        try { localStorage.setItem('horizonP918Tune', JSON.stringify(P918_TUNE)); } catch (e2) { /* ignore */ }
      };
    }
    // 四个轮毂各自的左右偏移（厘米，沿轮轴，±200cm）
    const rimDefs = [
      ['p918RimFL', 'rimFL'], ['p918RimFR', 'rimFR'],
      ['p918RimRL', 'rimRL'], ['p918RimRR', 'rimRR'],
    ];
    for (const [id, key] of rimDefs) {
      const el = document.getElementById(id), lb = document.getElementById(id + 'V');
      if (!el || !lb) continue;
      el.min = -200; el.max = 200;
      el.value = Math.round((P918_TUNE[key] || 0) * 100);
      lb.textContent = Math.round((P918_TUNE[key] || 0) * 100) + 'cm';
      el.oninput = () => {
        P918_TUNE[key] = el.value / 100;
        lb.textContent = Math.round(P918_TUNE[key] * 100) + 'cm';
        try { localStorage.setItem('horizonP918Tune', JSON.stringify(P918_TUNE)); } catch (e2) { /* ignore */ }
      };
    }
    // 四个轮胎各自的左右偏移（厘米，沿轮轴，±200cm）
    const tireDefs = [
      ['p918TireFL', 'tireFL'], ['p918TireFR', 'tireFR'],
      ['p918TireRL', 'tireRL'], ['p918TireRR', 'tireRR'],
    ];
    for (const [id, key] of tireDefs) {
      const el = document.getElementById(id), lb = document.getElementById(id + 'V');
      if (!el || !lb) continue;
      el.min = -200; el.max = 200;
      el.value = Math.round((P918_TUNE[key] || 0) * 100);
      lb.textContent = Math.round((P918_TUNE[key] || 0) * 100) + 'cm';
      el.oninput = () => {
        P918_TUNE[key] = el.value / 100;
        lb.textContent = Math.round(P918_TUNE[key] * 100) + 'cm';
        try { localStorage.setItem('horizonP918Tune', JSON.stringify(P918_TUNE)); } catch (e2) { /* ignore */ }
      };
    }
  },

  toggleP918Tune() {
    this.p918TuneOpen = !this.p918TuneOpen;
    const box = document.getElementById('p918TuneBox');
    if (box) box.classList.toggle('open', this.p918TuneOpen);
  },

  addDevRoadMark(p) {
    const y = this.world.terrainHeight(p.x, p.z) + 0.6;
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xff3344 })
    );
    m.position.set(p.x, y, p.z);
    this.scene.add(m);
    this.devRoadMarks.push(m);
    if (!this.devRoadLine) {
      this.devRoadLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([p, p]),
        new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.85 })
      );
      this.scene.add(this.devRoadLine);
    }
    this.updateDevRoadLine();
  },

  removeLastDevRoadMark() {
    const last = this.devRoadMarks.pop();
    if (last) this.scene.remove(last);
    this.updateDevRoadLine();
  },

  updateDevRoadLine() {
    if (!this.devRoadLine) return;
    const pts = this.devRoadMarks.map(m =>
      new THREE.Vector3(m.position.x, m.position.y - 0.25, m.position.z));
    if (pts.length < 2) pts.push(pts[0] || new THREE.Vector3(), pts[0] || new THREE.Vector3());
    this.devRoadLine.geometry.dispose();
    this.devRoadLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  },

  clearDevRoadMarks() {
    for (const m of this.devRoadMarks) this.scene.remove(m);
    this.devRoadMarks = [];
    if (this.devRoadLine) {
      this.devRoadLine.geometry.dispose();
      this.devRoadLine.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(), new THREE.Vector3(),
      ]);
    }
  },

  // 相机中心射线打在地形上的点（按高度场逐步推进 + 二分，不依赖三角面）
  devGroundPoint() {
    const c = this.camera;
    const o = c.position;
    if (!this.devRay) this.devRay = new THREE.Raycaster();
    this.devRay.setFromCamera(this.devMouse, c);
    const d = this.devRay.ray.direction;
    if (d.y >= -0.001) return null;
    let t = 3;
    for (let i = 0; i < 500 && t < 3200; i++) {
      const x = o.x + d.x * t, z = o.z + d.z * t;
      const h = this.world.terrainHeight(x, z);
      if (o.y + d.y * t <= h) {
        let lo = Math.max(0, t - 6), hi = t;
        for (let k = 0; k < 14; k++) {
          const mid = (lo + hi) / 2;
          const xm = o.x + d.x * mid, zm = o.z + d.z * mid;
          if (o.y + d.y * mid <= this.world.terrainHeight(xm, zm)) hi = mid;
          else lo = mid;
        }
        const xf = o.x + d.x * hi, zf = o.z + d.z * hi;
        return new THREE.Vector3(xf, this.world.terrainHeight(xf, zf), zf);
      }
      t += 6;
    }
    return null;
  },

  updateDevFlight(dt) {
    const k = this.keys;
    const spd = (k.ShiftLeft || k.ShiftRight ? 72 : 24) * dt;
    const sy = Math.sin(this.devYaw), cy = Math.cos(this.devYaw);
    const cp = Math.cos(this.devPitch), sp = Math.sin(this.devPitch);
    const fx = sy * cp, fy = sp, fz = cy * cp;
    if (k.ArrowLeft) this.devYaw -= 1.7 * dt;
    if (k.ArrowRight) this.devYaw += 1.7 * dt;
    if (k.ArrowUp) this.devPitch = Math.min(1.5, this.devPitch + 1.25 * dt);
    if (k.ArrowDown) this.devPitch = Math.max(-1.5, this.devPitch - 1.25 * dt);
    let mx = 0, my = 0, mz = 0;
    if (k.KeyW) { mx += fx; my += fy; mz += fz; }
    if (k.KeyS) { mx -= fx; my -= fy; mz -= fz; }
    // 屏幕方向：相机朝 +z 时屏幕右为 -x，故 D=(-cy, sy)，A=(cy, -sy)
    if (k.KeyA) { mx += cy; mz -= sy; }
    if (k.KeyD) { mx -= cy; mz += sy; }
    if (k.KeyQ || k.Space) my += 1;
    if (k.KeyE) my -= 1;
    const len = Math.hypot(mx, my, mz);
    if (len > 0.001) {
      this.devPos.x += mx / len * spd;
      this.devPos.y += my / len * spd;
      this.devPos.z += mz / len * spd;
    }
    this.camera.position.copy(this.devPos);
    this.camera.lookAt(this.devPos.x + fx, this.devPos.y + fy, this.devPos.z + fz);
    // 笔刷标记环：提前显示将要修改的区域（跟随鼠标落点）
    const p = this.devGroundPoint();
    if (this.devBrushRing) {
      if (p) {
        this.devBrushRing.position.set(p.x, p.y + 0.18, p.z);
        this.devBrushRing.visible = true;
      } else {
        this.devBrushRing.visible = false;
      }
    }
    // 按住鼠标抬/降地形（落点与鼠标点击一致）
    if (this.devBrush && !this.world.devBusy && p) {
      this.world.applyHeightBrush(p.x, p.z, this.devBrushR, this.devBrush * 0.4);
    }
  },

  __hook() {
    addEventListener('unhandledrejection', ev => {
      window.__rej = (ev.reason && ev.reason.stack) || String(ev.reason);
    });
    addEventListener('error', ev => {
      window.__err = ev.message + ' @ ' + (ev.filename || '') + ':' + ev.lineno;
    });
  },

  async init() {
    if (this.state !== 'boot') return;
    this.__hook();
    const canvas = $('game');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(64, innerWidth / innerHeight, 0.1, 7000);
    this.buildSpeedPostFx();
    this.world = new GameWorld(this.scene, this.renderer, MAPS[this.mapIndex]);
    UI.init();
    // 飞跃距离实时显示（慢动作期间，屏幕下方，直到落地）
    const jh = document.createElement('div');
    jh.id = 'jumpDistHud';
    jh.style.cssText = 'position:fixed;left:50%;bottom:15%;transform:translateX(-50%);z-index:80;'
      + 'font:700 24px "Segoe UI",sans-serif;color:#ffd77a;text-shadow:0 2px 8px rgba(0,0,0,.9);'
      + 'background:rgba(10,12,18,.38);padding:6px 20px;border-radius:12px;pointer-events:none;display:none;';
    document.body.appendChild(jh);
    this.jumpHud = jh;
    this.setupCamTuneUI();
    this.setupP918TuneUI();
    await this.buildWorld();
    window.__stage = 'world';
    if (window.PORSCHE918_GLB_B64 && typeof Porsche918Model !== 'undefined') {
      UI.setLoading(0.98, '加载保时捷 918 模型…');
      try {
        await Porsche918Model.load();
      } catch (e) {
        console.error('918 model load fail', e);
        window.__err = window.__err || ('918 model: ' + (e && e.message));
      }
    }
    $('loading').classList.add('hidden');
    // 开局默认车：保时捷 918（UI.carIndex 默认已指向 p918）
    this.spawnCar(UI.carIndex || 0);
    window.__stage = 'car';
    this.bindInput();
    window.__stage = 'input';
    this.state = 'menu';
    this.lastT = performance.now();
    this.nofx = location.search.includes('nofx');
    this.raceTest = location.search.includes('raceai');
    if (this.raceTest) this.raceTestAi = new DriftAI();
    requestAnimationFrame(t => this.loop(t));
    if (new URLSearchParams(location.search).has('speedshot')) {
      setTimeout(() => this.setupSpeedShot(), 500);
    }
    if (new URLSearchParams(location.search).has('scenic')) {
      setTimeout(() => this.setupScenicShot(), 500);
    }
    if (new URLSearchParams(location.search).has('checkroads')) {
      setTimeout(() => this.runRoadAudit(), 2500);
    }
    if (new URLSearchParams(location.search).has('patrol')) {
      setTimeout(() => this.startRoutePatrol(), 2500);
    }
    if (new URLSearchParams(location.search).has('bigmap')) {
      setTimeout(() => {
        this.start('free');
        setTimeout(() => this.toggleMap(), 2000);
      }, 1000);
    }
    if (false && new URLSearchParams(location.search).has('race')) {
      setTimeout(() => this.start('race'), 1000);
    }
    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
      if (this.fxRT) {
        this.fxRT.setSize(innerWidth, innerHeight);
        this.fxMat.uniforms.tDiffuse.value = this.fxRT.texture;
      }
    });
  },

  // ---------------- GPU 径向速度模糊后处理 ----------------
  buildSpeedPostFx() {
    const W = innerWidth, H = innerHeight;
    this.fxRT = new THREE.WebGLRenderTarget(W, H, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat });
    this.fxCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.fxScene = new THREE.Scene();
    this.fxMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.fxRT.texture },
        f: { value: 0 },
        center: { value: new THREE.Vector2(0.5, 0.42) },
        carPos: { value: new THREE.Vector2(0.5, 0.68) },
        shake: { value: new THREE.Vector2(0, 0) },
        fadeAmt: { value: 0 },
        fadeCol: { value: new THREE.Color(0x86c35a) },
      },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
      `,
      fragmentShader: `
        uniform sampler2D tDiffuse;
        uniform float f;
        uniform vec2 center;
        uniform vec2 carPos;
        uniform vec2 shake;
        uniform float fadeAmt;
        uniform vec3 fadeCol;
        varying vec2 vUv;
        void main(){
          vec2 uv = clamp(vUv + shake, 0.001, 0.999);
          vec2 dir = uv - center;
          float d = length(dir);
          // Keep the car readable while the outer world compresses with speed.
          float edgeFade = smoothstep(0.0, 0.06, uv.x) * smoothstep(1.0, 0.94, uv.x)
            * smoothstep(0.0, 0.06, uv.y) * smoothstep(1.0, 0.94, uv.y);
          float carD = length(uv - carPos);
          float carProtect = 1.0 - smoothstep(0.055, 0.22, carD);
          float edgeMask = smoothstep(0.12, 0.68, d) * (1.0 - carProtect);
          float stepSize = f * 0.018 * (0.35 + d * 0.85) * edgeFade;
          vec3 original = texture2D(tDiffuse, uv).rgb;
          vec3 acc = original;
          float wsum = 1.0;
          for (int i = 1; i < 10; i++) {
            float t = float(i) / 10.0;
            float w = 1.0 - t * 0.62;
            vec2 sampleUv = clamp(uv - dir * stepSize * t, 0.001, 0.999);
            acc += texture2D(tDiffuse, sampleUv).rgb * w;
            wsum += w;
          }
          vec3 blur = acc / wsum;
          vec3 col = mix(original, blur, edgeMask * f * 0.82);
          float ca = f * 0.0014 * smoothstep(0.34, 0.76, d) * (1.0 - carProtect);
          col.r = mix(col.r, texture2D(tDiffuse, clamp(uv + dir * ca, 0.001, 0.999)).r, f * 0.32);
          col.b = mix(col.b, texture2D(tDiffuse, clamp(uv - dir * ca, 0.001, 0.999)).b, f * 0.32);
          float vig = smoothstep(0.34, 0.82, d);
          col *= 1.0 - vig * f * 0.20;
          col = mix(col, fadeCol, fadeAmt);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.fxMat);
    quad.frustumCulled = false;
    this.fxScene.add(quad);
  },

  // ---------------- 静态道路审计（?checkroads） ----------------
  runRoadAudit() {
    try {
      const w = this.world;
      const res = { routes: [], problems: [] };
      for (const r of w.trafficRoutes) {
        const arr = r.samples;
        let maxSlope = 0, minH = 1e9, maxH = -1e9, gap = 0, nan = 0, offTerrain = 0;
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i];
          if (!isFinite(s.x) || !isFinite(s.h) || !isFinite(s.z)) nan++;
          if (i > 0) {
            const p = arr[i - 1];
            const d = Math.hypot(s.x - p.x, s.z - p.z);
            if (d > gap) gap = d;
            const slope = Math.abs(s.h - p.h) / Math.max(0.001, d);
            if (slope > maxSlope) maxSlope = slope;
          }
          if (s.h < minH) minH = s.h;
          if (s.h > maxH) maxH = s.h;
          // 路面被地形侵占检查（地形高于路面）
          if (i % 10 === 0 && w.terrainHeight(s.x, s.z) > s.h + 0.6) offTerrain++;
        }
        res.routes.push({
          id: r.id, len: Math.round(r.length), n: arr.length,
          maxSlope: +maxSlope.toFixed(3), minH: +minH.toFixed(1), maxH: +maxH.toFixed(1),
          gap: +gap.toFixed(1), nan, offTerrain,
        });
        if (nan || offTerrain > 0 || maxSlope > 0.55) {
          res.problems.push({ id: r.id, nan, offTerrain, maxSlope: +maxSlope.toFixed(3), gap: +gap.toFixed(1) });
        }
      }
      window.__roadAudit = JSON.stringify(res);
      if (window.GAME && window.GAME.DEBUG) console.log('[道路审计]', JSON.stringify(res));
    } catch (e) {
      window.__roadAudit = 'ERROR ' + ((e && e.message) || e);
    }
  },

  // ---------------- 观景点截图（?scenic，用于地图美术评审） ----------------
  setupScenicShot() {
    try {
      UI.hideMenu();
      this.speedshotClean = true;
      this.scenic = true;
      this.scenicT = 0;
      this.state = 'scenic';
      this.camMode = 0;
      // 黄金时刻 + 夏季，光线最美
      this.world.season = 1;
      this.world.hour = 18.2;
      this.world.updateSky();
      this.world.applySeason();
      // 观景点专用暖色调 + 防过曝
      this.renderer.toneMappingExposure = 1.22;
      const gc = $('game');
      gc.style.filter = 'saturate(1.22) contrast(1.1) brightness(1.02) sepia(0.28) hue-rotate(-8deg)';
      // 隐藏全部 HUD（观景点只需要纯净画面）
      for (const el of $('hud').children) el.style.display = 'none';
      // 隐藏漂移圈 / U 弯等开发标记
      if (this.world.driftVisuals) for (const m of this.world.driftVisuals) m.visible = false;
      // 观景点（?spot=switchbacks 看发夹弯，默认看湖谷）
      const spot = new URLSearchParams(location.search).get('spot');
      this.scenicFixed = false;
      if (spot === 'switchbacks') {
        // 发夹弯专用俯拍：相机在路网正上方直下，看清全部 8 个掉头与连接
        const cx = 2150, cz = -617;
        const hy = this.world.terrainHeight(cx, cz);
        this.scenicPos = { x: cx, y: hy + 820, z: cz };
        this.scenicLook = { x: cx, y: hy - 8, z: cz };
        this.scenicFov = 42;
        this.scenicFixed = true;
        this.camera.position.set(this.scenicPos.x, this.scenicPos.y, this.scenicPos.z);
        this.camera.lookAt(this.scenicLook.x, this.scenicLook.y, this.scenicLook.z);
        this.camera.fov = this.scenicFov;
        this.camera.updateProjectionMatrix();
        // 俯拍时去掉雾障，道路细节才看得清
        if (this.world.scene.fog) this.world.scene.fog.density = 0.00008;
      } else {
        let vx = 520, vz = 60, lx = 950, lz = 860, up = 95;
        const hy = this.world.terrainHeight(vx, vz);
        this.scenicLook = { x: lx, y: hy - 12, z: lz };
        this.scenicBase = { x: vx, z: vz };
        this.camera.position.set(vx, hy + up, vz);
        this.camera.lookAt(this.scenicLook.x, this.scenicLook.y, this.scenicLook.z);
        this.camera.fov = 70;
        this.camera.updateProjectionMatrix();
        this.camPos.copy(this.camera.position);
        this.camLook.set(this.scenicLook.x, this.scenicLook.y, this.scenicLook.z);
      }
    } catch (e) {
      console.error('scenic setup fail', e);
      window.__scenicError = (e && e.stack) || String(e);
    }
  },

  // ---------------- 全速截图调试（?speedshot） ----------------
  setupSpeedShot() {
    try {
      UI.hideMenu();
      this.state = 'driving';
      AudioSys.setPaused(false);
      this.camFov = 62;
      this.camMode = parseInt(new URLSearchParams(location.search).get('cam') || '0', 10) || 0;
      if (new URLSearchParams(location.search).has('night')) {
        this.world.hour = 22;
        this.world.updateSky();
      }
      this.raceActive = false;
      this.speedshot = true;
      this.speedshotClean = new URLSearchParams(location.search).get('clean') === '1';
      this.speedshotT = 0;
      this.shake = 0;
      // 在高速路上找最平直的一段作为起跑点
      this.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false);
      const route = this.world.trafficRoutes.find(r => r.id === 'highway') || this.world.trafficRoutes[0];
      this._shotRoute = route;
      this._shotArr = route.samples;
      const arr = this._shotArr;
      const win = 100;
      let best = { score: -1, idx: Math.max(5, Math.floor(arr.length * 0.25)) };
      const treeD = this.world.treeData || [];
      // 树密度网格（64m 格），查询 O(1)
      const tCell = 64, tGs = Math.ceil(5000 / tCell);
      const tGrid = Array.from({ length: tGs }, () => Array.from({ length: tGs }, () => []));
      for (const t of treeD) {
        const gx = Math.floor((t.x + 2500) / tCell), gz = Math.floor((t.z + 2500) / tCell);
        if (gx >= 0 && gx < tGs && gz >= 0 && gz < tGs) tGrid[gx][gz].push(t);
      }
      for (let i = 5; i + win < arr.length - 5; i++) {
        const a = arr[i], b = arr[i + win];
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        let path = 0, rise = 0;
        for (let k = i; k < i + win; k++) {
          path += Math.hypot(arr[k + 1].x - arr[k].x, arr[k + 1].z - arr[k].z);
          rise += Math.abs(arr[k + 1].h - arr[k].h);
        }
        const straight = d / Math.max(1e-6, path);
        const slopePen = 1 - Math.min(1, rise / 6);
        // 尽量远离路线两端（避免铁轨模式中途绕回起点瞬移）
        const d0 = arr[i].d, totalD = arr[arr.length - 1].d;
        const edgePen = clamp(Math.min(d0, totalD - d0) / 600, 0, 1);
        // 路边参照物密度：树越密，飞掠感越强
        let near = 0, samples = 0;
        for (let k = i; k < i + win; k += 5) {
          const s = arr[k];
          const gx = Math.floor((s.x + 2500) / tCell), gz = Math.floor((s.z + 2500) / tCell);
          // 只统计 25m 内的近树（前景大树让飞掠更有冲击力）
          for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const cx = gx + dx, cz = gz + dz;
            if (cx >= 0 && cx < tGs && cz >= 0 && cz < tGs) {
              for (const t of tGrid[cx][cz]) {
                if (Math.abs(t.x - s.x) < 25 && Math.abs(t.z - s.z) < 25) near++;
              }
            }
          }
          samples++;
        }
        const density = clamp(near / Math.max(1, samples) / 2.0, 0, 1);
        // 偏好路线中段：视野丰富（村庄/田野/风车），不在地图边缘空旷处
        const midPen = 1 - Math.abs(d0 / totalD - 0.62) * 1.4;
        const score = straight * path * slopePen * (0.25 + 0.75 * edgePen) * (0.35 + 0.65 * density) * (0.3 + 0.7 * clamp(midPen, 0, 1));
        if (score > best.score) best = { score, idx: i };
      }
      const a = arr[best.idx], b = arr[Math.min(best.idx + win, arr.length - 1)];
      const yaw = Math.atan2(b.x - a.x, b.z - a.z);
      this.car.reset(new THREE.Vector3(a.x, a.h + 0.05, a.z), yaw);
      this._railStartD = a.d; // 铁轨模式从该点开始沿路线前进
      const v = 72; // 259 km/h
      this.car.vel.set(Math.sin(yaw) * v, 0, Math.cos(yaw) * v);
      this.car.setVelocity({ x: Math.sin(yaw) * v, y: 0, z: Math.cos(yaw) * v });
      this.car.engineRpm = 7200;
      this.camPos.set(a.x - Math.sin(yaw) * 5.8, a.h + 2.8, a.z - Math.cos(yaw) * 5.8);
      this.camLook.set(a.x + Math.sin(yaw) * 12, a.h + 1.0, a.z + Math.cos(yaw) * 12);
      // 只保留 speedFx，隐藏其余 HUD
      for (const el of $('hud').children) {
        if (el.id !== 'speedFx') el.style.display = 'none';
      }
      if (!this.speedshotClean) {
        const dbg = document.createElement('div');
        dbg.id = 'speedshotDbg';
        dbg.style.cssText = 'position:fixed;left:12px;top:10px;z-index:99;font:bold 15px monospace;color:#ffe08a;text-shadow:0 1px 3px #000;background:rgba(0,0,0,.35);padding:4px 8px;border-radius:6px;';
        document.body.appendChild(dbg);
        UI.toast('SPEEDSHOT 起步加速中');
      }
      window.__shotReady = true;
    } catch (e) {
      console.error('speedshot setup fail', e);
      window.__speedshotError = (e && e.stack) || String(e);
    }
  },

  // speedshot 铁轨模式：车沿路线中心线 259 km/h 前进（仅截图调试用）
  speedshotRail(dt) {
    const c = this.car, arr = this._shotArr;
    if (!c || !c.body || !arr || !arr.length) return;
    // 按真实经过时间前进，截图位置可复现
    this._railD = (this._railStartD || 0) + 72 * (this.speedshotT || 0);
    if (this._railD > arr[arr.length - 1].d) {
      // 到路线尽头绕回起点继续（循环巡航）
      this._railD -= arr[arr.length - 1].d;
    }
    let i = 0;
    while (i < arr.length - 1 && arr[i + 1].d < this._railD) i++;
    const a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)];
    const segLen = (b.d - a.d) || 1;
    const t = clamp((this._railD - a.d) / segLen, 0, 1);
    const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
    const h = lerp(a.h, b.h, t);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    c.body.position.set(x, h + c.COM_OFFSET, z);
    c.body.quaternion.setFromEuler(0, yaw, 0);
    c.body.angularVelocity.setZero();
    c.body.velocity.set(Math.sin(yaw) * 72, 0, Math.cos(yaw) * 72);
    c.applyVisual();
    c.pos.set(x, h + c.COM_OFFSET, z);
    c.yaw = yaw;
    c.speed = 72;
  },

  // speedshot 自动驾驶：保持车道中心，全油门跑直道
  speedshotSteer() {
    const w = this.world, c = this.car;
    // 固定沿“高速路”跑，不被其它交叉路抢走最近点
    if (!this._shotRoute) {
      this._shotRoute = w.trafficRoutes.find(r => r.id === 'highway') || w.trafficRoutes[0];
      this._shotArr = this._shotRoute.samples;
    }
    const arr = this._shotArr;
    let bi = 0, bd = 1e18;
    for (let i = 0; i < arr.length; i++) {
      const dx = arr[i].x - c.pos.x, dz = arr[i].z - c.pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; bi = i; }
    }
    // 前视目标点（约 30m 外）
    let ti = bi, accD = 0;
    while (ti < arr.length - 1 && accD < 30) {
      accD += Math.hypot(arr[ti + 1].x - arr[ti].x, arr[ti + 1].z - arr[ti].z);
      ti++;
    }
    const tgt = arr[ti];
    const yawT = Math.atan2(tgt.x - c.pos.x, tgt.z - c.pos.z);
    let yawErr = yawT - c.yaw;
    while (yawErr > Math.PI) yawErr -= TAU;
    while (yawErr < -Math.PI) yawErr += TAU;
    // 横向偏移：车到最近点的有符号距离
    const a0 = arr[bi];
    const tx0 = tgt.x - a0.x, tz0 = tgt.z - a0.z;
    const tl0 = Math.hypot(tx0, tz0) || 1;
    const ox = c.pos.x - a0.x, oz = c.pos.z - a0.z;
    const lat = (ox * tz0 - oz * tx0) / tl0;
    const steer = clamp(-lat * 0.045 - yawErr * 1.7, -0.45, 0.45);
    return steer;
  },

  async buildWorld() {
    const w = this.world;
    const step = async (frac, label, fn) => {
      await new Promise(r => setTimeout(r, 8));
      try {
        await fn();
        UI.setLoading(UI.loadP = (UI.loadP || 0) + frac, label);
      } catch (e) {
        console.error('WORLD STEP FAIL [' + label + ']', e);
        window.__worldError = label + ' :: ' + (e && e.stack ? e.stack : e);
        UI.setLoading(UI.loadP || 0.01, '世界生成失败: ' + label);
        throw e;
      }
      await new Promise(r => setTimeout(r, 8));
    };
    await step(0.08, '规划道路网络…', () => w.buildRoads());
    await step(0.34, '雕刻地形与四季植被…', () => w.buildTerrain());
    await step(0.10, '铺设实体物理地面…', () => w.buildPhysics());
    await step(0.03, '加载真实路面贴图…', () => w.loadRoadTextures());
    await step(0.13, '铺设柏油路面…', () => w.buildRoadMeshes());
    await step(0.18, (w.map.id === 'city' || w.map.id === 'city2') ? '建造海特洛…' : '建造村庄与风车…', () => w.placeProps());
    await step(0.06, '蓄水成湖…', () => w.buildWater());
    await step(0.09, '绘制天空与光照…', () => { w.buildSky(); w.setupLights(); w.updateSky(); });
    await step(0.04, '生成天气粒子…', () => w.buildWeather());
    await step(0.08, '让车流上路…', () => { this.traffic = new TrafficSystem(w, this.scene); });
    UI.setLoading(1, '世界就绪');
    await new Promise(r => setTimeout(r, 250));
  },

  spawnCar(idx, keep) {
    idx = Math.max(0, Math.min(CAR_SPECS.length - 1, idx || 0));
    const spec = CAR_SPECS[idx];
    let pos = null, yaw = 0, vel = null;
    if (this.car) {
      pos = this.car.pos.clone(); yaw = this.car.yaw;
      vel = this.car.vel.clone();
      this.scene.remove(this.car.visual);
      this.car.destroy();
    }
    this.car = new Car(spec, this.scene, this.world);
    if (keep && pos) {
      this.car.reset(pos, yaw);
      this.car.setVelocity(vel);
    } else {
      const sl = this.world.startLine;
      this.car.reset(new THREE.Vector3(sl.x, sl.y, sl.z), sl.yaw);
    }
    if (AudioSys.ctx) AudioSys.replaceVoice(spec);
  },

  bindInput() {
    addEventListener('keydown', e => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
      if (e.code === 'F9') {
        this.wheelDbg = !this.wheelDbg;
        const el = $('wheelDbg');
        if (el) el.classList.toggle('on', this.wheelDbg);
        e.preventDefault();
        return;
      }
      if (e.code === 'F8' && Game.world) {
        const w = Game.world;
        w.lightClassic = !w.lightClassic;
        try { localStorage.setItem('horizonLightMode', w.lightClassic ? 'classic' : 'pbr'); } catch (e2) { /* ignore */ }
        w.scene.environment = w.lightClassic ? null : (w.envDay || null);
        if (w.updateSky) w.updateSky();
        if (UI && UI.toast) UI.toast('光照模式：' + (w.lightClassic ? '原版' : '优化') + ' · F8 切换');
        e.preventDefault();
        return;
      }
      // 大地图打开时（paused）M 键负责关闭
      if (e.code === 'KeyM' && this.mapOpen) {
        this.toggleMap();
        return;
      }
      if (this.state !== 'driving') return;
      const w = this.world, c = this.car;
      // AI 漂移秀中：玩家按行驶键即可接管
      if (this.aiActive && ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        this.aiActive = false;
        this.car.driftAssistOff = false;
        this.car.aiDrift = false;
        if (this.savedTuning) { Object.assign(TUNING, this.savedTuning); this.savedTuning = null; }
        UI.toast('已接管驾驶 · AI 漂移关闭');
        return;
      }
      switch (e.code) {
        case 'KeyI': if (!this.devMode) this.enterDevMode(); break;
        case 'KeyH': if (this.devMode) this.exitDevMode(); break;
        case 'KeyB':
          if (this.devMode) {
            const rs = [6, 12, 20, 35];
            this.devBrushR = rs[(rs.indexOf(this.devBrushR) + 1) % rs.length];
            if (this.devBrushRing) this.devBrushRing.scale.set(this.devBrushR, 1, this.devBrushR);
            this.updateDevHud();
          }
          break;
        case 'KeyV':
          if (this.devMode && this.devUndoStack.length && !this.world.devBusy) this.undoDevTerrain();
          else this.lookActive = true;
          break;
        case 'KeyR':
          if (this.devMode) this.toggleDevRoad();
          else this.respawnCar();
          break;
        case 'Enter':
          if (this.devMode && this.devRoadMode) this.finishDevRoad();
          break;
        case 'Backspace':
          if (this.devMode && this.devRoadMode) {
            this.devRoadPts.pop();
            this.removeLastDevRoadMark();
            this.updateDevHud();
          }
          break;
        case 'KeyC': this.camMode = (this.camMode + 1) % 4;
          UI.toast(['追逐视角', '驾驶舱', '引擎盖', '远距航拍'][this.camMode] + ' · C'); break;
        case 'F7': this.headlightMode = (this.headlightMode + 1) % 3;
          UI.toast(['车灯：自动', '车灯：常亮', '车灯：关闭'][this.headlightMode] + ' · F7 切换'); break;
        case 'F6': this.startVibrationProbe(); break;
        case 'KeyT': {
          const presets = [6.2, 9.5, 13, 18.5, 22.2];
          let i = presets.findIndex(h => h > w.hour + 0.01);
          if (i < 0) i = 0;
          w.hour = presets[i]; w.updateSky();
          UI.toast('时间 → ' + Math.floor(w.hour) + ':' + (w.hour % 1 ? '30' : '00'));
          break;
        }
        case 'KeyY':
          w.season = (w.season + 1) % 4;
          w.applySeason(this.camera.position.x, this.camera.position.z, this.car ? this.car.yaw : 0);
          UI.toast('季节 → ' + SEASONS[w.season].name); break;
        case 'KeyU': {
          const names = ['晴天', '雨天', '雾天', '雪天'];
          let nw = (w.weather + 1) % 4;
          if (nw === 3 && w.season !== 3) { nw = 0; UI.toast('雪天仅冬季可用（按 Y 切到冬季）'); break; }
          w.weather = nw;
          UI.toast('天气 → ' + names[w.weather]);
          break;
        }
        case 'KeyQ': c.doShift(-1); break;
        case 'KeyE': c.doShift(1); break;
        case 'KeyN': {
          UI.toast('车辆已锁定：烈焰 GT');
          break;
        }
        case 'KeyP':
          this.camTuneOpen = !this.camTuneOpen;
          if (this.camTuneOpen) this.p918TuneOpen = false;
          {
            const box = document.getElementById('camTuneBox');
            if (box) box.classList.toggle('open', this.camTuneOpen);
            const p9 = document.getElementById('p918TuneBox');
            if (p9) p9.classList.remove('open');
          }
          break;
        case 'KeyO':
          this.p918TuneOpen = !this.p918TuneOpen;
          if (this.p918TuneOpen) this.camTuneOpen = false;
          {
            const p9 = document.getElementById('p918TuneBox');
            if (p9) p9.classList.toggle('open', this.p918TuneOpen);
            const cb = document.getElementById('camTuneBox');
            if (cb) cb.classList.remove('open');
          }
          break;
        case 'KeyL':
          this.timeScale = this.timeScale === 1 ? 4 : 1;
          UI.toast(this.timeScale === 4 ? '游戏加速 ×4' : '恢复正常速度');
          break;
        case 'KeyM': this.toggleMap(); break;
        case 'F1': this.helpVisible = !this.helpVisible; UI.showHelp(this.helpVisible); break;
        case 'KeyF':
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen().catch(() => {});
          break;
        case 'Escape':
          if (this.devMode && this.devRoadMode) {
            this.devRoadMode = false;
            this.devRoadPts = [];
            this.clearDevRoadMarks();
            this.updateDevHud();
            break;
          }
          if (this.aiActive) { this.stopAIDemo(); break; }
          if (this.mapOpen) this.toggleMap(); else this.togglePause(true); break;
      }
    });
    addEventListener('keyup', e => {
      this.keys[e.code] = false;
      if (e.code === 'KeyV') this.lookActive = false;
    });
    // 开发者模式鼠标：左键抬地/布点，右键降地
    addEventListener('mousedown', e => {
      if (!this.devMode || this.world.devBusy) return;
      if (e.button === 0) {
        if (this.devRoadMode) {
          const p = this.devGroundPoint();
          if (p) {
            this.devRoadPts.push([Math.round(p.x), Math.round(p.z)]);
            this.addDevRoadMark(p);
            this.updateDevHud();
          }
        } else {
          this.devSnap = this.world.heightEdit.slice();
          this.devBrush = 1;
        }
      } else if (e.button === 2 && !this.devRoadMode) {
        if (!this.devSnap) this.devSnap = this.world.heightEdit.slice();
        this.devBrush = -1;
      }
    });
    addEventListener('mouseup', e => {
      if (e.button !== 0 && e.button !== 2) return;
      const was = this.devBrush;
      this.devBrush = 0;
      if (was && this.devSnap) {
        this.devUndoStack.push(this.devSnap);
        if (this.devUndoStack.length > 10) this.devUndoStack.shift();
        this.devSnap = null;
      }
      if (this.devMode && was && !this.devRoadMode && !this.world.devBusy) {
        this.world.devBusy = true;
        this.world.syncTerrainAfterEdit().then(() => { this.world.devBusy = false; });
      }
    });
    addEventListener('contextmenu', e => {
      if (this.devMode) e.preventDefault();
    });
    addEventListener('mousemove', e => {
      if (this.lookActive && this.state === 'driving' && !this.devMode) {
        const dx = e.movementX || 0, dy = e.movementY || 0;
        // 左右方向保持现有；上下反向；解除角度限制可 360° 旋转
        this.lookYaw -= dx * 0.0022;
        this.lookPitch -= dy * 0.0018;
        return;
      }
      if (!this.devMode) return;
      this.devMouse.x = (e.clientX / innerWidth) * 2 - 1;
      this.devMouse.y = -(e.clientY / innerHeight) * 2 + 1;
    });
  },

  // 大地图：按 M 打开整张世界地图（打开时暂停模拟）
  toggleMap() {
    if (this.mapOpen) {
      this.mapOpen = false;
      $('bigmap').classList.add('hidden');
    } else {
      this.mapOpen = true;
      UI.drawBigMap(this.world, this.car, this.traffic, this);
      $('bigmap').classList.remove('hidden');
    }
    this.pausedByMap = false;
  },

  start(mode) {
    try {
      mode = 'free';
      this.mode = 'free';
      try { AudioSys.init(); AudioSys.resume(); } catch (e) { console.error('audio init fail', e); }
      try { AudioSys.replaceVoice(this.car.spec); } catch (e) { console.error('voice fail', e); }
      UI.hideMenu();
      this.state = 'driving';
      this.camFov = 62;
      this.car.driftAssistOff = false;
      if (this.savedTuning) { Object.assign(TUNING, this.savedTuning); this.savedTuning = null; }
      this.raceActive = false;
      this.skillScore = 0;
      if (mode === 'race') this.startRace();
      else {
        const sl = this.world.startLine;
        this.car.reset(new THREE.Vector3(sl.x, sl.y, sl.z), sl.yaw);
        UI.bigMsg('自由漫游', '找到你的节奏 · 高速区间在嘉年华大道', false);
      }
      this.camPos.set(this.car.visual.position.x, this.car.visual.position.y + 4, this.car.visual.position.z + 8);
    } catch (e) {
      window.__startError = (e && e.stack) || String(e);
      console.error('start fail', e);
      throw e;
    }
  },

  startRace() {
    const rt = this.world.trafficRoutes.find(r => r.id === 'coast');
    const arr = rt.samples;
    const start = arr[0], next = arr[1];
    const yaw = Math.atan2(next.x - start.x, next.z - start.z);
    this.car.reset(new THREE.Vector3(start.x, start.h, start.z), yaw);
    this.raceCheckpoints = [];
    const stepN = Math.max(1, Math.floor(arr.length / 30));
    for (let i = stepN; i < arr.length; i += stepN) {
      this.raceCheckpoints.push({ x: arr[i].x, z: arr[i].z });
    }
    this.raceCpIdx = 0; this.raceCpNext = 0;
    this.raceTime = 0;
    this.racePlayerIdx = 0;
    this.racePlayerArc = 0;
    this.racePosition = 1;
    this.raceFinishPos = 0;
    this.oppRoute = rt;
    this.spawnOpponents(start, yaw);
    const avg = 42 + this.car.spec.hp * 0.085;
    this.racePar = rt.length / avg * 3.6;
    this.raceActive = true;
    this.raceStarted = false;
    this.raceCountdown = 3.4;
    // 测试模式：玩家也幽灵化，专注验证 AI 竞速
    if (this.raceTest) {
      this.car.body.collisionFilterGroup = 2;
      this.car.body.collisionFilterMask = 1;
    }
    UI.bigMsg('沿海竞速赛', '4 车同场 · 环线 ' + Math.round(rt.length / 1000) + ' km', true);
  },

  // ---------------- 人机对手 ----------------
  spawnOpponents(start, yaw) {
    this.clearOpponents();
    const base = CAR_SPECS.find(s => s.id === 'gt');
    const oppDefs = [
      { name: '蓝龙 R', color: 0x2f7fe8, boost: 0.97, grip: 1.10, hp: 620, torque: 700, mass: 1350 },
      { name: '黄蜂 H', color: 0xf2c200, boost: 0.90, grip: 1.05, hp: 580, torque: 640, mass: 1220 },
      { name: '棕熊 M', color: 0xb06a28, boost: 0.94, grip: 1.14, hp: 650, torque: 760, mass: 1480 },
    ];
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    for (let i = 0; i < oppDefs.length; i++) {
      const d = oppDefs[i];
      const spec = { ...base, id: 'opp_' + i, name: d.name, color: d.color, hp: d.hp, torque: d.torque, mass: d.mass, grip: d.grip };
      const car = new Car(spec, this.scene, this.world);
      car.driftAssistOff = true; // 竞速对手：抓地跑，不漂移
      car.aiDrift = false;
      // 竞速幽灵车：车与车不碰撞（避免起跑/超车顶撞），只与世界碰撞
      car.body.collisionFilterGroup = 2;
      car.body.collisionFilterMask = 1;
      const lane = i % 2 === 0 ? -1 : 1;
      const back = Math.floor(i / 2) * 4.5;
      const x = start.x - fx * back + rx * lane * 4.2;
      const z = start.z - fz * back + rz * lane * 4.2;
      car.reset(new THREE.Vector3(x, this.world.terrainHeight(x, z), z), yaw);
      const ai = new DriftAI();
      ai.patrolBoost = d.boost;
      ai.raceMode = true;
      this.opponents.push({ car, ai, progress: 0, finished: false, finishTime: 0, name: spec.name, startX: x, startZ: z, arc: 0, stuckT: 0, railD: 0 });
    }
  },

  clearOpponents() {
    for (const op of this.opponents) {
      try { this.scene.remove(op.car.visual); } catch (e) { /* ignore */ }
      try { op.car.destroy(); } catch (e) { /* ignore */ }
    }
    this.opponents = [];
  },

  resetOpponents() {
    const arr = this.oppRoute ? this.oppRoute.samples : null;
    if (!arr) return;
    const s0 = arr[0], s1 = arr[Math.min(1, arr.length - 1)];
    const yaw = Math.atan2(s1.x - s0.x, s1.z - s0.z);
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    this.opponents.forEach((op, i) => {
      const lane = i % 2 === 0 ? -1 : 1;
      const back = Math.floor(i / 2) * 4.5;
      const x = s0.x - fx * back + rx * lane * 4.2;
      const z = s0.z - fz * back + rz * lane * 4.2;
      op.car.reset(new THREE.Vector3(x, this.world.terrainHeight(x, z), z), yaw);
      op.ai.reset();
      op.progress = 0; op.finished = false; op.finishTime = 0;
      op.arc = 0; op.stuckT = 0; op.railD = 0;
    });
  },

  updateOpponents(dt) {
    const arr = this.oppRoute.samples;
    for (const op of this.opponents) {
      const c = op.car;
      const spd = this.raceTargetSpeed(op.ai, arr, c.spec.grip || 1);
      this.raceRail(c, op, spd, dt, arr);
      const totalLen = arr[arr.length - 1].d;
      op.progress = Math.min(1, op.railD / totalLen);
      if (!op.finished && op.railD >= totalLen) {
        op.finished = true;
        op.finishTime = this.raceTime;
      }
    }
  },

  opponentAhead(op) {
    const arr = this.oppRoute.samples;
    const myIdx = op.ai.routeIdx;
    let best = 1e9;
    const all = [{ car: this.car, idx: this.racePlayerIdx }, ...this.opponents.map(o => ({ car: o.car, idx: o.ai.routeIdx }))];
    for (const o of all) {
      if (o.car === op.car) continue;
      // 只看同向前方 260 个采样内的车（避免把身后的车也算成障碍互相刹车）
      let d = o.idx - myIdx;
      if (d < 0) d += arr.length;
      if (d > 0 && d < 260) {
        const a = arr[Math.min(arr.length - 1, myIdx)], b = arr[Math.min(arr.length - 1, o.idx)];
        const dist = Math.max(0, b.d - a.d);
        if (dist < best) best = dist;
      }
    }
    return best;
  },

  opponentFrontSpeed(op) {
    const arr = this.oppRoute.samples;
    const myIdx = op.ai.routeIdx;
    let bestD = 1e9, bestSpd = 0;
    const all = [{ car: this.car, idx: this.racePlayerIdx }, ...this.opponents.map(o => ({ car: o.car, idx: o.ai.routeIdx }))];
    for (const o of all) {
      if (o.car === op.car) continue;
      let d = o.idx - myIdx;
      if (d < 0) d += arr.length;
      if (d > 0 && d < 260) {
        const a = arr[Math.min(arr.length - 1, myIdx)], b = arr[Math.min(arr.length - 1, o.idx)];
        const dist = Math.max(0, b.d - a.d);
        if (dist < bestD) { bestD = dist; bestSpd = o.car.speed; }
      }
    }
    return bestSpd;
  },

  // 竞速目标速度：前方曲率 + 抓地力 → 弯道限速（与 ai.route 同款模型）
  raceTargetSpeed(ai, arr, grip) {
    const n = arr.length;
    const idx = Math.max(0, Math.min(n - 1, ai.routeIdx || 0));
    let curv = 0;
    for (let k = idx + 3; k < Math.min(n - 1, idx + 60); k++) {
      const h1 = Math.atan2(arr[k].x - arr[k - 1].x, arr[k].z - arr[k - 1].z);
      const h2 = Math.atan2(arr[k + 1].x - arr[k].x, arr[k + 1].z - arr[k].z);
      const step = Math.hypot(arr[k + 1].x - arr[k].x, arr[k + 1].z - arr[k].z) || 1;
      const cc = Math.abs(angNormAI(h2 - h1)) / step;
      if (cc > curv) curv = cc;
    }
    const gripF = 0.72 + grip * 0.28;
    const straightV = (56 / (1 + curv * 4.5)) * (ai.patrolBoost || 1) * gripF;
    const vPhys = Math.sqrt(Math.max(18, grip * 9.81 / Math.max(0.0006, curv))) * 0.8;
    return clamp(Math.min(straightV, vPhys), 8, 100);
  },

  // 竞速轨道：把车钉在赛道路线中心线上，按目标速度前进
  raceRail(car, op, spd, dt, arr) {
    op.railD = (op.railD || 0) + spd * dt;
    const totalLen = arr[arr.length - 1].d;
    if (op.railD >= totalLen) op.railD -= totalLen; // 闭环绕圈
    let i = 0;
    while (i < arr.length - 1 && arr[i + 1].d < op.railD) i++;
    const a = arr[i], b = arr[Math.min(i + 1, arr.length - 1)];
    const segLen = (b.d - a.d) || 1;
    const t = clamp((op.railD - a.d) / segLen, 0, 1);
    const x = lerp(a.x, b.x, t), z = lerp(a.z, b.z, t);
    const h = lerp(a.h, b.h, t);
    const yaw = Math.atan2(b.x - a.x, b.z - a.z);
    car.body.position.set(x, h + car.COM_OFFSET, z);
    car.body.quaternion.setFromEuler(0, yaw, 0);
    car.body.angularVelocity.setZero();
    car.body.velocity.set(Math.sin(yaw) * spd, 0, Math.cos(yaw) * spd);
    car.applyVisual();
    car.pos.set(x, h + car.COM_OFFSET, z);
    car.yaw = yaw;
    car.speed = spd;
    if (op && op.ai) {
      op.ai.reset();
      op.ai.routeIdx = i; // 供排名/进度参考
    }
  },

  playerRaceProgress() {
    const arr = this.oppRoute.samples;
    let near = Math.max(0, Math.min(arr.length - 1, this.racePlayerIdx));
    let best = near, bd = 1e9;
    for (let i = Math.max(0, near - 30); i < Math.min(arr.length, near + 30); i++) {
      const s = arr[i];
      const d = (s.x - this.car.pos.x) ** 2 + (s.z - this.car.pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    this.racePlayerIdx = best;
    return best / arr.length;
  },

  respawnCar() {
    const c = this.car, w = this.world;
    if (this.raceActive) this.resetOpponents();
    const nr = w.nearestRoad(c.pos.x, c.pos.z);
    if (!nr) return;
    const s = nr.s;
    const route = w.trafficRoutes.find(r => r.id === s.road);
    const arr = route.samples;
    let i = arr.indexOf(s);
    if (i < 0) i = Math.floor(nr.d / 4);
    const nxt = arr[Math.min(i + 1, arr.length - 1)] || arr[Math.max(0, i - 1)];
    const yaw = Math.atan2(nxt.x - s.x, nxt.z - s.z);
    c.reset(new THREE.Vector3(s.x, s.h, s.z), yaw);
    this.shake = Math.min(1, this.shake + 0.35);
    UI.toast('已复位到道路');
  },

  togglePause(v) {
    if (v && this.state === 'driving') {
      this.state = 'paused';
      $('pause').classList.remove('hidden');
      AudioSys.setPaused(true);
    } else if (!v && this.state === 'paused') {
      this.state = 'driving';
      $('pause').classList.add('hidden');
      AudioSys.setPaused(false);
    }
  },

  toMenu() {
    this.state = 'menu';
    AudioSys.setPaused(true);
    this.raceActive = false;
    this.clearOpponents();
    this.car.setLights(false);
    $('pause').classList.add('hidden');
    UI.showMenu();
    this.setMenuCar(UI.carIndex);
  },

  // 菜单展台：把所选车辆放到发车区，供 3D 展示
  setMenuCar(idx) {
    if (this.state !== 'menu' || !this.world || !this.world.physics) return;
    const sl = this.world.startLine;
    this.spawnCar(idx, false);
    this.menuT = 0;
    this.camera.position.set(sl.x + 5.5, sl.y + 2.2, sl.z + 5.5);
    this.camera.lookAt(sl.x, sl.y + 0.55, sl.z);
    this.camera.fov = 46;
    this.camera.updateProjectionMatrix();
  },

  // 切换地图：重建整个世界（新场景 + 新地形 + 新路网）
  async switchMap(idx) {
    if (idx === this.mapIndex) return;
    this.mapIndex = idx;
    this.aiActive = false;
    this.raceActive = false;
    this.clearOpponents();
    UI.showLoading('正在重建 ' + MAPS[idx].name + '…');
    try { if (this.car) this.car.destroy(); } catch (e) { /* ignore */ }
    this.scene = new THREE.Scene();
    this.world = new GameWorld(this.scene, this.renderer, MAPS[idx]);
    await this.buildWorld();
    $('loading').classList.add('hidden');
    this.spawnCar(UI.carIndex || 0);
    this.state = 'menu';
    this.camPos.set(30, 8, 30);
    this.camLook.set(0, 0, 0);
    const sub = $('menuSub');
    if (sub) sub.textContent = MAPS[idx].name + ' · 自由漫游';
    const eb = $('menuEyebrow');
    if (eb) eb.textContent = 'HORIZON FESTIVAL · ' + (MAPS[idx].id === 'city' ? 'HITERO CITY' : (MAPS[idx].id === 'city2' ? 'HITERO 2' : (MAPS[idx].id === 'city3' ? 'GLB CITY' : 'ALPINE')));
    UI.showMenu();
  },

  // ---------------- AI 漂移秀 ----------------
  startAIDemo() {
    try {
      AudioSys.init(); AudioSys.resume();
      UI.hideMenu();
      // AI 演示强制漂移调参，不受玩家滑条影响
      this.savedTuning = { ...TUNING };
      Object.assign(TUNING, { drift: 1, counter: 1, rearGrip: 1, handbrake: 1, smallAngle: 0 });
      this.state = 'driving';
      this.camFov = 62;
      this.raceActive = false;
      this.skillScore = 0;
      this.aiActive = true;
      this.aiMode = 'circle';
      this.aiStage = 0;
      this.aiStageTime = 0;
      this.aiDone = false;
      this.ai.reset();
      this.spawnCar(0, false); // 红色超跑
      this.placeAICircle(this.world.driftCircles[0]);
      UI.bigMsg('AI 漂移秀', '不同半径圆形漂移 · 按任意键接管', false);
      this.camPos.set(this.car.pos.x + 7, this.car.pos.y + 3.2, this.car.pos.z + 7);
    } catch (e) { console.error('ai demo fail', e); }
  },

  stopAIDemo() {
    this.aiActive = false;
    this.aiMode = '';
    this.aiDone = false;
    if (this.savedTuning) { Object.assign(TUNING, this.savedTuning); this.savedTuning = null; }
    if (this.car) this.car.aiDrift = false;
    this.toMenu();
  },

  // ---------------- AI 巡路验证：把每条路跑一遍 ----------------
  startRoutePatrol() {
    try {
      AudioSys.init(); AudioSys.resume();
      UI.hideMenu();
      this.savedTuning = { ...TUNING };
      Object.assign(TUNING, { drift: 0.6, counter: 1, rearGrip: 1, handbrake: 0.5, smallAngle: 0 });
      this.state = 'driving';
      this.camFov = 66;
      this.raceActive = false;
      this.skillScore = 0;
      this.aiActive = true;
      this.aiMode = 'route';
      this.aiStage = parseInt(new URLSearchParams(location.search).get('start') || '0', 10) || 0;
      this.aiStageTime = 0;
      this.aiDone = false;
      // 模拟加速：物理/AI 每渲染帧跑 N 次（默认 8x，URL speed 可调）
      this.patrolSpeed = Math.max(1, Math.min(24, parseFloat(new URLSearchParams(location.search).get('speed') || '8') || 8));
      // 路序：山路/发夹弯优先，其余按原顺序
      const ids = this.world.trafficRoutes.map(r => r.id);
      const priority = ['switchbacks', 'mountain', 'ring', 'lakeconn', 'cross', 'northsouth', 'lakeloop', 'valley', 'coast', 'coastlink', 'southloop', 'northpass'];
      this.patrolRoutes = priority.filter(id => ids.includes(id)).concat(ids.filter(id => !priority.includes(id)));
    this.ai.reset();
    this.ai.routeStats = [];
      this.ai.patrolBoost = parseFloat(new URLSearchParams(location.search).get('boost') || '1') || 1;
      this.ai.routeTrace = [];
      this.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false); // 跑车 V8
      this.placeAIRoute(this.aiStage);
      const total = this.world.trafficRoutes.length;
      UI.bigMsg('AI 巡路验证', '共 ' + total + ' 条路自动跑完 · 按任意键接管', false);
      this.camPos.set(this.car.pos.x + 8, this.car.pos.y + 3.4, this.car.pos.z + 8);
    } catch (e) { console.error('route patrol fail', e); }
  },

  placeAIRoute(idx) {
    const route = this.patrolRoutes ? this.world.trafficRoutes.find(r => r.id === this.patrolRoutes[idx]) : this.world.trafficRoutes[idx];
    const s = route.samples[0];
    const s2 = route.samples[Math.min(2, route.samples.length - 1)];
    const yaw = Math.atan2(s2.x - s.x, s2.z - s.z);
    this.car.reset(new THREE.Vector3(s.x, this.world.terrainHeight(s.x, s.z), s.z), yaw);
    this.ai.routeIdx = 0;
    this.ai.routePrevYawErr = 0;
    this.ai.routeStuck = 0;
    this.ai.routeMaxSlope = 0;
    this.ai.routeMaxOff = 0;
    this.ai.routeMaxOffX = 0;
    this.ai.routeMaxOffZ = 0;
    this.ai.routeNan = false;
    this.ai.routeMaxBump = 0;
    this.ai.routeMaxVy = 0;
    this.ai.routeJumps = [];
  },

  // 跨路接续：不传送，从当前车位置直接导航到下一条路（真实验证交叉转换）
  switchAIRoute(idx) {
    const routes = this.patrolRoutes || this.world.trafficRoutes;
    const route = this.world.trafficRoutes.find(r => r.id === routes[idx]);
    const arr = route.samples;
    let bi = 0, bd = 1e9;
    for (let i = 0; i < arr.length; i += 2) {
      const d = (arr[i].x - this.car.pos.x) ** 2 + (arr[i].z - this.car.pos.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    const dist = Math.sqrt(bd);
    this.ai.routeIdx = bi;
    this.ai.routePrevYawErr = 0;
    this.ai.routeStuck = 0;
    this.ai.routeMaxSlope = 0;
    this.ai.routeMaxOff = 0;
    this.ai.routeMaxOffX = 0;
    this.ai.routeMaxOffZ = 0;
    this.ai.routeNan = false;
    this.ai.routeMaxBump = 0;
    this.ai.routeMaxVy = 0;
    this.ai.routeJumps = this.ai.routeJumps || [];
    this.ai.routeJumps.push({ from: route.id, dist: Math.round(dist) });
    if (dist > 250) {
      // 相距太远无法自然接续：传送并标记跳转
      const s = arr[bi], s2 = arr[Math.min(bi + 2, arr.length - 1)];
      const yaw = Math.atan2(s2.x - s.x, s2.z - s.z);
      this.car.reset(new THREE.Vector3(s.x, this.world.terrainHeight(s.x, s.z), s.z), yaw);
      this.ai.routeIdx = bi;
      UI.toast(route.id + ' 距离过远，已传送（' + Math.round(dist) + 'm）');
    }
  },

  placeAICircle(s) {
    // 放到圆上角度 0 处，车头沿逆时针切线
    const h = this.world.terrainHeight(s.x, s.z + s.R);
    this.car.reset(new THREE.Vector3(s.x, h, s.z + s.R), Math.PI / 2);
  },

  placeAIUTurn() {
    const pts = this.world.uturnCourse.pts;
    const a = pts[0], b = pts[1];
    this.ai.reset();
    this.ai.wpIndex = 1;
    this.car.reset(
      new THREE.Vector3(a[0], this.world.terrainHeight(a[0], a[1]), a[1]),
      Math.atan2(b[0] - a[0], b[1] - a[1])
    );
  },

  updateAI(dt) {
    const c = this.car;
    if (this.aiMode === 'jump') {
      // AI 飞跃测试：直线全油门冲出起飞点，保持方向，飞到落地
      this.jumpTestT += dt;
      c.input.throttle = 1;
      c.input.brake = 0;
      c.input.handbrake = false;
      c.input.horn = false;
      let yawErr = this.jumpTestYaw - c.yaw;
      while (yawErr > Math.PI) yawErr -= TAU;
      while (yawErr < -Math.PI) yawErr += TAU;
      c.input.steer = clamp(yawErr * 1.4, -0.45, 0.45);
      this.jumpTestMaxAir = Math.max(this.jumpTestMaxAir || 0, c.airTime);
      // 结束：落地（且确实飞过）或超时
      const landed = c.grounded && this.jumpTestMaxAir > 1.2 && c.airTime < 0.05;
      if (landed || this.jumpTestT > 14) {
        this.stopJumpTest();
      }
    } else if (this.aiMode === 'circle') {
      c.aiDrift = true;
      c.driftAssistOff = false;
      const seq = this.world.driftCircles;
      const s = seq[this.aiStage];
      this.aiStageTime += dt;
      if (this.aiStageTime >= s.dur) {
        this.aiStage++;
        if (this.aiStage >= seq.length) {
          // 圆形漂移全部完成 → U 形弯（换拉力漂移车）
          this.aiStage = 0;
          this.aiMode = 'uturn';
          this.ai.reset();
          // 漂移车已删除：U 形弯漂移秀改用 GT（AI 强制漂移特性）
          this.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false);
          this.placeAIUTurn();
          UI.bigMsg('U 形弯 · 拉力漂移', '掉头处手刹漂移', false);
          return;
        }
        this.placeAICircle(seq[this.aiStage]);
        this.aiStageTime = 0;
        UI.toast(seq[this.aiStage].name + ' 圆形漂移');
      }
      this.ai.circle(c, dt, s.x, s.z, s.R, 1);
    } else if (this.aiMode === 'uturn') {
      c.aiDrift = false;
      c.driftAssistOff = true;
      const pts = this.world.uturnCourse.pts;
      this.ai.uturn(c, dt, pts);
      if (this.ai.wpIndex >= pts.length - 1 && !this.aiDone) {
        this.aiDone = true;
        UI.bigMsg('漂移秀完成', '圆形 + U 形弯全部完成', false);
        setTimeout(() => { if (this.aiActive) this.stopAIDemo(); }, 2200);
      }
    } else if (this.aiMode === 'route') {
      c.aiDrift = false;
      c.driftAssistOff = true;
      const routes = this.patrolRoutes || this.world.trafficRoutes;
      const r = this.world.trafficRoutes.find(x => x.id === routes[this.aiStage]);
      this.ai.route(c, dt, r.samples);
      if (this.ai.routeNan) {
        this.ai.routeStats.push({ id: r.id, result: 'NaN/异常', maxOff: '?', slope: '?' });
        UI.toast(r.id + ' 数值异常！');
        this.aiStage++;
        if (this.aiStage >= routes.length) return this.finishRoutePatrol();
        this.switchAIRoute(this.aiStage);
        return;
      }
      if (this.ai.routeIdx >= r.samples.length - 4) {
        // 颠簸/网格-地形不一致检测（接地且有一定速度时统计）
        if (c.grounded && c.speed > 5) {
          for (let i = 0; i < 4; i++) {
            const wt = c.vehicle.wheelInfos[i].worldTransform.position;
            const th = this.world.terrainHeight(wt.x, wt.z);
            const d = Math.abs(wt.y - th - c.wheelR);
            if (d > (this.ai.routeMaxBump || 0)) this.ai.routeMaxBump = d;
          }
          if (Math.abs(c.bodyVy) > (this.ai.routeMaxVy || 0)) this.ai.routeMaxVy = Math.abs(c.bodyVy);
        }
        this.ai.routeStats.push({
          id: r.id,
          result: '完成',
          maxOff: (this.ai.routeMaxOff || 0).toFixed(1) + 'm',
          maxOffXY: Math.round(this.ai.routeMaxOffX || 0) + ',' + Math.round(this.ai.routeMaxOffZ || 0),
          slope: Math.round((this.ai.routeMaxSlope || 0) * 100) + '%',
          bump: (this.ai.routeMaxBump || 0).toFixed(2) + 'm',
          vy: (this.ai.routeMaxVy || 0).toFixed(2) + 'm/s',
          jump: (this.ai.routeJumps && this.ai.routeJumps[this.ai.routeJumps.length - 1]) || null,
        });
        if (window.GAME && window.GAME.DEBUG) {
          console.log('[巡路]', r.id, '完成 · 偏离', this.ai.routeMaxOff.toFixed(1), 'm · 坡度', Math.round(this.ai.routeMaxSlope * 100) + '%', '· bump', (this.ai.routeMaxBump || 0).toFixed(2), 'm');
        }
        UI.toast(r.id + ' 完成 · 偏离 ' + (this.ai.routeMaxOff || 0).toFixed(1) + 'm · bump ' + (this.ai.routeMaxBump || 0).toFixed(2) + 'm');
        this.aiStage++;
        if (this.aiStage >= routes.length) return this.finishRoutePatrol();
        this.switchAIRoute(this.aiStage);
        UI.toast('接续：' + routes[this.aiStage].id + '（' + (this.aiStage + 1) + '/' + routes.length + '）');
      }
    }
  },

  // 巡路纯模拟步（加速验证用）：只跑 AI + 物理推进，跳过渲染/UI/相机
  patrolStep(dt) {
    if (this.aiActive) this.updateAI(dt);
    if (this.car) this.car.update(dt, this.world);
  },

  // AI 飞跃测试：传送到天梯末端起飞点，朝东冲下 300m 落差
  startJumpTest() {
    if (!this.car || !this.world) return;
    this.aiActive = true;
    this.aiMode = 'jump';
    this.jumpTestActive = true;
    this.jumpTestT = 0;
    this.jumpTestMaxAir = 0;
    this.jumpTestYaw = Math.PI / 2; // 朝东
    this.slowmoActive = false; this.slowmoT = 0; this.slowmo = 1;
    this.keys = {};
    const x = 2250, z = -425;
    this.car.reset(new THREE.Vector3(x, this.world.terrainHeight(x, z), z), this.jumpTestYaw);
    // 临时禁用起飞走廊内的树碰撞（视觉树保留）
    this.jumpColSave = [];
    for (const col of this.world.colliders) {
      if (col.type === 'tree' && col.x > 2200 && col.x < 2600 && col.z > -500 && col.z < -350) {
        this.jumpColSave.push({ col, r: col.r });
        col.r = 0;
      }
    }
    UI.toast('AI 飞跃测试 · 全油门冲出天梯东端');
  },

  stopJumpTest() {
    if (this.jumpColSave) {
      for (const s of this.jumpColSave) s.col.r = s.r;
      this.jumpColSave = null;
    }
    this.aiActive = false;
    this.aiMode = '';
    this.jumpTestActive = false;
    this.keys = {};
    UI.toast('飞跃测试结束 · 最长滞空 ' + (this.jumpTestMaxAir || 0).toFixed(1) + 's');
  },

  finishRoutePatrol() {
    if (this.aiDone) return;
    this.aiDone = true;
    const stats = this.ai.routeStats || [];
    const bad = stats.filter(s => s.result !== '完成' || parseFloat(s.maxOff) > 4
      || (s.bump && parseFloat(s.bump) > 0.25) || (s.vy && parseFloat(s.vy) > 3.2));
    window.__patrolResult = JSON.stringify(stats);
    if (window.GAME && window.GAME.DEBUG) {
      console.log('[巡路验证完成] 共', stats.length, '条路 · 加速', this.patrolSpeed + 'x', stats);
    }
    if (bad.length) {
      UI.bigMsg('巡路完成 · ' + bad.length + ' 条异常', bad.map(s => s.id).join(' / '), true);
    } else {
      UI.bigMsg('巡路验证完成', stats.length + ' 条路全部跑通 · 无异常', true);
    }
    setTimeout(() => { if (this.aiActive) this.stopAIDemo(); }, 2600);
  },

  // ---------------- 振动探针（按 M） ----------------
  startVibrationProbe() {
    this._vibSamples = [];
    this._vibSampling = true;
    this._vibEnd = performance.now() + 2000;
    UI.toast('振动采样中… 请保持行驶状态 2 秒', true);
  },
  reportVibration() {
    this._vibSampling = false;
    const s = this._vibSamples;
    if (s.length < 8) { UI.toast('采样失败（帧数太少）'); return; }
    const stat = (arr) => {
      const m = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
      const mx = Math.max(...arr.map(Math.abs));
      return { sd, mx, m };
    };
    // 去趋势（减去 5 点滑动平均）后统计高频残余 + 过零次数估频率
    const detrend = (arr) => arr.map((v, i) => {
      let ss = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(arr.length - 1, i + 2); j++) { ss += arr[j]; n++; }
      return v - ss / n;
    });
    const zc = (arr) => { let c = 0; for (let i = 1; i < arr.length; i++) if (Math.sign(arr[i]) !== Math.sign(arr[i - 1]) && arr[i] !== 0) c++; return c; };
    const sec = (s[s.length - 1].t - s[0].t) / 1000;
    const yD = detrend(s.map(x => x.y));
    const vyD = detrend(s.map(x => x.vy));
    const wxD = detrend(s.map(x => x.wx));
    const wyD = detrend(s.map(x => x.wy));
    const wzD = detrend(s.map(x => x.wz));
    const out = {
      frames: s.length, sec: Math.round(sec * 100) / 100,
      y_sd_cm: Math.round(stat(yD).sd * 100), y_max_cm: Math.round(stat(yD).mx * 100),
      vy_sd: Math.round(stat(vyD).sd * 100) / 100, vy_freq: Math.round(zc(vyD) / 2 / sec),
      pitch_wx_sd: Math.round(stat(wxD).sd * 1000) / 1000, pitch_wx_freq: Math.round(zc(wxD) / 2 / sec),
      yaw_wy_sd: Math.round(stat(wyD).sd * 1000) / 1000, yaw_wy_freq: Math.round(zc(wyD) / 2 / sec),
      roll_wz_sd: Math.round(stat(wzD).sd * 1000) / 1000, roll_wz_freq: Math.round(zc(wzD) / 2 / sec),
    };
    const txt = '帧' + out.frames + ' 时长' + out.sec + 's | 高度σ' + out.y_sd_cm + 'cm 竖直vσ' + out.vy_sd + '(' + out.vy_freq + 'Hz) | 俯仰ωσ' + out.pitch_wx_sd + '(' + out.pitch_wx_freq + 'Hz) 偏航ωσ' + out.yaw_wy_sd + '(' + out.yaw_wy_freq + 'Hz) 侧倾ωσ' + out.roll_wz_sd + '(' + out.roll_wz_freq + 'Hz)';
    UI.bigMsg('振动数据', txt, true);
    console.log('VIB_PROBE', JSON.stringify(out));
    setTimeout(() => UI.hideMsg(), 9000);
  },

  // ---------------- 主循环 ----------------
  loop(t) {
    try {
      // cannon 固定步长累加器可以承受较大帧间隔；限幅只防长时间卡顿跳变
      const dt = Math.min(0.12, (t - this.lastT) / 1000);
      this.lastT = t;
      if (this.speedshot) this.speedshotFrames = (this.speedshotFrames || 0) + 1;
      const dbg = document.getElementById('speedshotDbg');
      if (dbg && this.speedshot) {
        let off = -1;
        if (this._shotArr && this.car) {
          let bd = 1e18;
          for (let i = 0; i < this._shotArr.length; i++) {
            const dx = this._shotArr[i].x - this.car.pos.x, dz = this._shotArr[i].z - this.car.pos.z;
            const d = dx * dx + dz * dz;
            if (d < bd) bd = d;
          }
          off = Math.sqrt(bd);
        }
        dbg.textContent = 'SPD ' + Math.round(this.car.speedKmh) + ' km/h  FOV ' + Math.round(this.camFov)
          + '  GRD ' + this.car.grounded + '  t ' + (this.speedshotT || 0).toFixed(1)
          + '  FR ' + (this.speedshotFrames || 0) + '  OFF ' + off.toFixed(0) + 'm'
          + '  XY ' + this.car.pos.x.toFixed(0) + ',' + this.car.pos.z.toFixed(0);
      }
      const w = this.world;
      if (this.state === 'driving') {
        w.hour += dt / 90;
        if (w.hour >= 24) w.hour -= 24;
        w.updateSky(this.car ? this.car.pos : null);
        // 模拟加速：AI 巡路用 patrolSpeed，玩家按 L 用 timeScale（4x）
        const simSteps = this.aiActive && this.aiMode === 'route'
          ? Math.round(this.patrolSpeed || 1)
          : Math.round(this.timeScale || 1);
        for (let i = 0; i < simSteps; i++) this.updateDriving(dt);
        // 振动探针：按 M 后采样车身状态，用于定位上下坡/腾空的震动频率与轴
        if (this._vibSampling && this.car) {
          const b = this.car.body;
          this._vibSamples.push({
            t: performance.now(),
            y: b.position.y, vy: b.velocity.y,
            wx: b.angularVelocity.x, wy: b.angularVelocity.y, wz: b.angularVelocity.z,
          });
          if (performance.now() >= this._vibEnd) this.reportVibration();
        }
      } else if (this.state === 'paused') {
        w.update(dt, this.camPos);
      } else if (this.state === 'scenic') {
        this.scenicT += dt;
        if (this.scenicFixed) this.camPos.set(this.scenicPos.x, this.scenicPos.y, this.scenicPos.z);
        w.update(dt, this.camPos);
        if (this.scenicFixed) {
          this.camera.position.set(this.scenicPos.x, this.scenicPos.y, this.scenicPos.z);
          this.camera.lookAt(this.scenicLook.x, this.scenicLook.y, this.scenicLook.z);
          this.camera.fov = this.scenicFov || 68;
          this.camera.updateProjectionMatrix();
        } else {
          const look = this.scenicLook || { x: 450, y: 40, z: -350 };
          const base = this.scenicBase || { x: -1350, z: -1500 };
          const dx0 = base.x - look.x, dz0 = base.z - look.z;
          const dist = Math.hypot(dx0, dz0);
          const a0 = Math.atan2(dz0, dx0);
          const ang = a0 + this.scenicT * 0.04;
          const hy = w.terrainHeight(base.x, base.z);
          this.camera.position.set(look.x + Math.cos(ang) * dist, hy + 135, look.z + Math.sin(ang) * dist);
        this.camera.lookAt(look.x, look.y, look.z);
        this.camera.fov = 68;
        this.camera.updateProjectionMatrix();
      }
      } else if (this.state === 'menu') {
        w.update(dt, this.camPos);
        // 展台相机：围绕所选车辆缓慢环绕，选车即换模型
        const c = this.car;
        this.menuT = (this.menuT || 0) + dt;
        const ang = this.menuT * 0.3;
        const px = c.pos.x + Math.sin(ang) * 6.6;
        const pz = c.pos.z + Math.cos(ang) * 6.6;
        this.camera.position.set(px, c.pos.y + 2.1 + Math.sin(ang * 2) * 0.25, pz);
        this.camera.lookAt(c.pos.x, c.pos.y + 0.55, c.pos.z);
        this.camera.fov = lerp(this.camera.fov, 46, 0.08);
        this.camera.updateProjectionMatrix();
        this.camPos.copy(this.camera.position);
      }
      // GPU 径向速度模糊：场景先渲染到纹理，再全屏后处理
      this.renderer.setRenderTarget(this.fxRT);
      this.renderer.render(this.scene, this.camera);
      this.renderer.setRenderTarget(null);
      if (this.fxMat) {
        this.fxMat.uniforms.f.value = this.speedBlurF || 0;
      }
      this.renderer.render(this.fxScene, this.fxCam);
    } catch (e) {
      window.__lastErr = (e && e.message) || String(e);
      if (this.speedshot) {
        const dbg = document.getElementById('speedshotDbg');
        if (dbg) dbg.textContent = 'ERR ' + ((e && e.message) || e) + ' FR ' + (this.speedshotFrames || 0);
      }
      console.error('loop error', e);
    }
    requestAnimationFrame(tt => this.loop(tt));
  },

  updateDriving(dt) {
    if (this.devMode) {
      this.updateDevFlight(dt);
      return;
    }
    const c = this.car, w = this.world;
    // 飞跃慢动作：预测滞空 >1.8s 且起飞 0.3s 后，放慢 10 倍持续 3 秒（现实时间），
    // 超时或落地恢复；本次跳跃只触发一次，落地按滞空/距离加分
    if (!this.slowmoActive && c.airborne && c.jumpPredicted > 1.8 && c.airTime > 0.3
      && !(this.slowmoJumpX === c.jumpStartX && this.slowmoJumpZ === c.jumpStartZ)) {
      this.slowmoActive = true;
      this.slowmoStarted = true;
      this.slowmoT = 3;
      this.slowmoJumpX = c.jumpStartX;
      this.slowmoJumpZ = c.jumpStartZ;
    }
    if (this.slowmoActive) {
      this.slowmoT -= dt;
      if (this.slowmoT <= 0 || !c.airborne) {
        this.slowmoActive = false;
        this.slowmoT = 0;
        this.slowmo = 1;
      } else {
        this.slowmo = 0.1;
      }
    } else {
      this.slowmo = 1;
      if (!c.airborne) {
        this.slowmoStarted = false;
        this.slowmoJumpX = null;
        this.slowmoJumpZ = null;
      }
    }
    // 慢动作期间在屏幕下方实时显示飞跃距离，直到落地
    if (this.jumpHud) {
      if (this.slowmoStarted && c.airborne) {
        const jd = Math.hypot(c.pos.x - c.jumpStartX, c.pos.z - c.jumpStartZ);
        this.jumpHud.textContent = '飞跃距离 ' + jd.toFixed(1) + ' m';
        this.jumpHud.style.display = 'block';
      } else {
        this.jumpHud.style.display = 'none';
      }
    }
    w.physics.slowmo = this.slowmo < 1;
    if (c.landing) {
      if (!this.landScored) {
        this.landScored = true;
        const pts = Math.round(c.jumpPredicted * 55 + c.jumpDist * 3);
        if (pts > 5) {
          this.skillScore += pts;
          UI.popup('+' + pts + ' 危险标志', 'orange');
        }
      }
    } else {
      this.landScored = false;
    }
    dt *= this.slowmo;
    const k = this.keys;
    const inp = c.input;
    this.speedBlurF = clamp((c.speedKmh - 40) / 160, 0, 1);
    if (this.speedshot) {
      this.speedshotT += dt;
      inp.throttle = 1;
      inp.brake = 0;
      inp.steer = 0;
      inp.handbrake = false;
      inp.horn = false;
    } else if (this.aiActive) {
      this.updateAI(dt);
    } else {
      inp.throttle = (k.KeyW || k.ArrowUp) ? 1 : 0;
      inp.brake = (k.KeyS || k.ArrowDown) ? 1 : 0;
      inp.steer = ((k.KeyA || k.ArrowLeft) ? 1 : 0) - ((k.KeyD || k.ArrowRight) ? 1 : 0);
      inp.handbrake = !!k.Space;
      inp.horn = !!k.KeyH;
    }

    if (this.raceCountdown > 0) {
      this.raceCountdown -= dt;
      inp.throttle = 0; inp.brake = 0; inp.steer = 0; inp.handbrake = false;
      const n = Math.ceil(this.raceCountdown);
      if (n > 0 && n <= 3) UI.bigMsg(String(n), '', true);
      else if (n === 0) { UI.bigMsg('出发!', '', true); setTimeout(() => UI.hideMsg(), 900); this.raceStarted = true; }
    } else if (this.raceActive && this.raceStarted) {
      this.raceTime += dt;
      this.updateOpponents(dt);
      this.racePlayerArc = (this.racePlayerArc || 0) + c.speed * dt;
      if (this.raceTest && this.oppRoute) {
        const arr = this.oppRoute.samples;
        const spd = this.raceTargetSpeed(this.raceTestAi, arr, this.car.spec.grip || 1);
        this.raceRail(this.car, this._testRailOp || (this._testRailOp = {}), spd, dt, arr);
        this.racePlayerIdx = this.raceTestAi.routeIdx;
      }
      // 实时排名
      const totalLen = this.oppRoute.samples[this.oppRoute.samples.length - 1].d;
      const pp = Math.min(1, this.racePlayerArc / totalLen);
      const ranks = [{ type: 'player', p: pp }, ...this.opponents.map((o, i) => ({ type: 'op', p: o.progress, i }))];
      ranks.sort((a, b) => b.p - a.p);
      this.racePosition = ranks.findIndex(r => r.type === 'player') + 1;
      // 测试用提前完赛
      const finFrac = parseFloat(new URLSearchParams(location.search).get('racefinish') || '1');
      if (this.raceTest && pp >= finFrac && !this.raceFinishedEarly) {
        this.raceFinishedEarly = true;
        this.finishRace();
      }
    }

    // 坠穿兜底
    if (c.pos.y < -100) {
      c.resetToNearestRoad();
      UI.toast('已从深渊复位');
    }

    // 物理（小步积分）
    const h = 1 / 120;
    let acc = 0;
    while (acc < dt) {
      const s = Math.min(h, dt - acc);
      c.update(s, w);
      acc += s;
    }
    if (this.speedshot) this.speedshotRail(dt);
    if (inp.horn) AudioSys.horn();
    AudioSys.update(c);

    // 碰撞：场景物件
    this.handlePropCollisions();
    // 水域阻力（避免水下起飞与失控）
    if (w.terrainHeight(c.pos.x, c.pos.z) < CFG.waterLevel - 0.4) {
      c.scaleHorizontalVelocity(Math.max(0, 1 - 2.2 * dt));
    }
    // 车流碰撞 + 擦肩
    if (this.traffic) this.traffic.update(dt, c.pos, c.speed);
    this.handleTraffic(dt);
    // 滑移痕：低速漂移/手刹甩尾也留痕（只限向前行驶，倒挡不冒烟不留痕）
    const driftingNow = c.grounded && c.vFwd > 1.5 &&
      (Math.abs(c.slipAngleR) > 0.22 || (c.input.handbrake && Math.abs(c.yawRate) > 0.3));
    // 漂移留痕已按需求删除（driftingNow 仍供冒烟判定使用）
    // 漂移胎烟：只从两个后轮接地触点冒烟，效果更淡
    if (w.smoke) {
      if (driftingNow) {
        const k = Math.min(1, Math.abs(c.slipAngleR) * 1.6 + (c.input.handbrake ? 0.5 : 0));
        const spdK = Math.min(1, c.speed / 25);
        const wheelR = c.wheelR || 0.34;
        for (let i = 2; i < 4; i++) {
          const ww = c.wheelWorldPos(i);
          w.smoke.emit(ww.x, ww.y - wheelR + 0.06, ww.z,
            0.7 + k * 0.8,
            (Math.random() - 0.5) * 1.1 * spdK,
            (Math.random() - 0.5) * 1.1 * spdK,
            0.55 + k * 0.75);
        }
      }
      w.smoke.update(dt);
    }
    // 轮子调试面板（F9）：实时显示每个轮是否绕自己的轮心转
    if (this.wheelDbg && $('wheelDbg')) {
      const dbgRows = [];
      const bp = c.body.position;
      const bq = c.body.quaternion;
      const invQ = this._dbgQ || (this._dbgQ = new THREE.Quaternion());
      invQ.set(bq.x, bq.y, bq.z, bq.w).invert();
      const midX = [], midZ = [];
      for (let i = 0; i < 4; i++) {
        c.vehicle.updateWheelTransform(i);
        const wt = c.vehicle.wheelInfos[i].worldTransform;
        const wp = new THREE.Vector3(wt.position.x, wt.position.y, wt.position.z);
        const wm = c.wheelMeshes[i];
        const dp = new THREE.Vector3();
        if (wm) wm.getWorldPosition(dp);
        const local = wp.clone().sub(bp).applyQuaternion(invQ);
        if (i < 2) { midX.push(local.x); midZ.push(local.z); }
        dbgRows.push(
          '轮' + i +
          ' 转向=' + (c.vehicle.wheelInfos[i].steering * 180 / Math.PI).toFixed(1) + '°' +
          ' 显示-物理偏差=' + (wm ? (dp.distanceTo(wp) * 100).toFixed(1) : '?') + 'cm'
        );
      }
      dbgRows.push('前轴中点(车身坐标) x=' + ((midX[0] + midX[1]) / 2).toFixed(3) + ' z=' + ((midZ[0] + midZ[1]) / 2).toFixed(3));
      $('wheelDbg').textContent = dbgRows.join('\n');
    }
    // 路边物体掠过的“刷刷”声（树/桩快速经过）
    if (w.treeData && AudioSys.ctx) {
      this._whooshCd = (this._whooshCd || 0) - dt;
      if (this._whooshCd <= 0 && c.speed > 18) {
        const fwdX = Math.sin(c.yaw), fwdZ = Math.cos(c.yaw);
        for (let j = 0; j < w.treeData.length; j += 2) {
          const t = w.treeData[j];
          const dx = t.x - c.pos.x, dz = t.z - c.pos.z;
          const fwd = dx * fwdX + dz * fwdZ;
          const lat = Math.abs(-dx * fwdZ + dz * fwdX);
          if (fwd > -0.8 && fwd < 0.8 && lat > 2.5 && lat < 9) {
            AudioSys.whoosh(0.04 + Math.min(0.09, c.speed / 750));
            this._whooshCd = 0.13;
            break;
          }
        }
      }
    }
    if (w.tailTrail && typeof w.tailTrail.updateRibbon === 'function') {
      // 用插值后的车身姿态(与视觉车身一致)，避免拖尾因物理固定步长/高帧率不同步而高频抖
      const ip = c.body ? c.body.interpolatedPosition : c.pos;
      const iq = c.body ? c.body.interpolatedQuaternion : null;
      const bodyY = ip.y - c.COM_OFFSET;
      const localLights = c.tailLightLocal || [
        { x: 0.55, y: 0.58, z: -2.3 },
        { x: -0.55, y: 0.58, z: -2.3 }
      ];
      let lamps, boxLamps = null;
      if (iq) {
        // 用车身完整姿态（航向+俯仰+侧倾）把尾灯局部坐标变换到世界坐标，
        // 上下坡时灯位与光带方向才会跟着车身坡度走
        const qx = iq.x, qy = iq.y, qz = iq.z, qw = iq.w;
        const m00 = 1 - 2 * (qy * qy + qz * qz);
        const m01 = 2 * (qx * qy - qw * qz);
        const m02 = 2 * (qx * qz + qw * qy);
        const m10 = 2 * (qx * qy + qw * qz);
        const m11 = 1 - 2 * (qx * qx + qz * qz);
        const m12 = 2 * (qy * qz - qw * qx);
        const m20 = 2 * (qx * qz - qw * qy);
        const m21 = 2 * (qy * qz + qw * qx);
        const m22 = 1 - 2 * (qx * qx + qy * qy);
        const widths = c.tailLightWidths;
        const gains = c.tailLightGains;
        lamps = localLights.map((light, i) => ({
          x: ip.x + m00 * light.x + m01 * light.y + m02 * light.z,
          y: bodyY + m10 * light.x + m11 * light.y + m12 * light.z,
          z: ip.z + m20 * light.x + m21 * light.y + m22 * light.z,
          rx: m00,
          rz: m20,
          w: widths && widths[i] != null ? widths[i] : 0.6,
          g: gains && gains[i] != null ? gains[i] : 1
        }));
        // 长方体空心光管：左右尾灯中心各一条
        boxLamps = [
          { x: -0.60, y: 0.565, z: -1.78 },
          { x: 0.60, y: 0.565, z: -1.78 },
        ].map(l => ({
          x: ip.x + m00 * l.x + m01 * l.y + m02 * l.z,
          y: bodyY + m10 * l.x + m11 * l.y + m12 * l.z,
          z: ip.z + m20 * l.x + m21 * l.y + m22 * l.z,
          rx: m00, rz: m20, w: 0.42,
        }));
      } else {
        const yawSin = Math.sin(c.yaw);
        const yawCos = Math.cos(c.yaw);
        const rightX = yawCos;
        const rightZ = -yawSin;
        const widths = c.tailLightWidths;
        const gains = c.tailLightGains;
        lamps = localLights.map((light, i) => ({
          x: ip.x + light.x * rightX + light.z * yawSin,
          y: bodyY + light.y,
          z: ip.z + light.x * rightZ + light.z * yawCos,
          rx: rightX,
          rz: rightZ,
          w: widths && widths[i] != null ? widths[i] : 0.6,
          g: gains && gains[i] != null ? gains[i] : 1
        }));
        // 长方体空心光管：左右尾灯中心各一条
        boxLamps = [
          { x: -0.60, y: 0.565, z: -1.78 },
          { x: 0.60, y: 0.565, z: -1.78 },
        ].map(l => ({
          x: ip.x + l.x * rightX + l.z * yawSin,
          y: bodyY + l.y,
          z: ip.z + l.x * rightZ + l.z * yawCos,
          rx: rightX, rz: rightZ, w: 0.42,
        }));
      }
      w.tailTrail.updateRibbon(dt, lamps, w.darkness || 0, Math.abs(c.speed));
      if (w.tailTrailBox) w.tailTrailBox.updateRibbon(dt, boxLamps, w.darkness || 0, Math.abs(c.speed));
    } else if (w.tailTrail) {
      const trailNight = w.hour > 19.6 || w.hour < 5.4;
      const speed = Math.abs(c.speed);

      if (trailNight && speed > 1.5) {
        const yawSin = Math.sin(c.yaw);
        const yawCos = Math.cos(c.yaw);
        const rightX = yawCos;
        const rightZ = -yawSin;
        const backX = -yawSin;
        const backZ = -yawCos;

        const localLights = c.tailLightLocal || [
          { x: 0.55, y: 0.58, z: -2.3 },
          { x: -0.55, y: 0.58, z: -2.3 }
        ];

        const speed01 = Math.min(1, Math.max(0, (speed - 2) / 38));
        const segmentLength = 0.8 + speed * 0.13;
        const spacing = 0.105 + speed01 * 0.12;
        const segmentCount = Math.min(
          34,
          Math.max(8, Math.ceil(segmentLength / spacing))
        );
        const pointSize = 0.09 + speed01 * 0.105;
        const lifetime = 1.55 + speed01 * 1.35;
        const bodyY = c.pos.y - c.COM_OFFSET;

        for (const light of localLights) {
          const lampX =
            c.pos.x +
            light.x * rightX +
            light.z * yawSin;
          const lampY = bodyY + light.y;
          const lampZ =
            c.pos.z +
            light.x * rightZ +
            light.z * yawCos;

          for (let i = 0; i < segmentCount; i++) {
            const t = i / Math.max(1, segmentCount - 1);
            const back = t * segmentLength;
            const taper = 1 - t * 0.38;
            const wave = Math.sin(i * 1.73 + performance.now() * 0.006) * 0.006;
            const yDrop = t * t * (0.025 + speed01 * 0.045);

            w.tailTrail.add(
              lampX + backX * back + rightX * wave,
              lampY - yDrop,
              lampZ + backZ * back + rightZ * wave,
              pointSize * taper,
              lifetime * (0.82 + t * 0.32),
              0.75 + taper * 0.5
            );

            // 较大的低强度点形成柔和外辉光。
            if ((i & 1) === 0) {
              w.tailTrail.add(
                lampX + backX * back + rightX * wave,
                lampY - yDrop,
                lampZ + backZ * back + rightZ * wave,
                pointSize * (2.05 - t * 0.35),
                lifetime * (0.9 + t * 0.25),
                0.2 + speed01 * 0.12
              );
            }
          }
        }
      }

      w.tailTrail.update(dt);
    }
    // 技能
    this.handleSkills(dt);
    // 测速区间
    this.handleSpeedZone();
    // 比赛检查点
    this.handleRaceCheckpoints();

    w.update(dt, this.camPos);
    // 阴影跟随玩家
    w.sun.position.add(c.pos);
    w.sun.target.position.copy(c.pos);
    w.sun.target.updateMatrixWorld();

    // 车灯（L 键切换：0 自动 / 1 常亮 / 2 关闭）
    const lk = this.headlightMode === 1 ? 1 : (this.headlightMode === 2 ? 0 : (w.darkness || 0));
    c.setLights(lk);

    this.updateCamera(dt);
    UI.update(dt, c, w, this.traffic, this);
    if (this.mapOpen) {
      this._bigMapRefresh = (this._bigMapRefresh || 0) + dt;
      if (this._bigMapRefresh >= 0.12) {
        this._bigMapRefresh = 0;
        UI.drawBigMap(w, c, this.traffic, this);
      }
    }
  },

  handlePropCollisions() {
    const c = this.car;
    const colliders = this.world.colliders;
    for (let i = 0; i < colliders.length; i++) {
      const col = colliders[i];
      const dx = c.pos.x - col.x, dz = c.pos.z - col.z;
      const d2 = dx * dx + dz * dz;
      const rr = col.r + 0.85;
      if (d2 > rr * rr) continue;
      const d = Math.sqrt(d2) || 0.01;
      const nx = dx / d, nz = dz / d;
      const overlap = rr - d;
      c.displace(nx * overlap, nz * overlap);
      const vn = c.vel.x * nx + c.vel.z * nz;
      if (vn < 0) {
        c.applyImpact(nx, nz, vn, 1.4);
        if (vn < -4) {
          AudioSys.impact(Math.min(1, -vn / 20));
          this.shake = Math.min(1, this.shake + Math.min(0.9, -vn / 26));
          this.skillScore = Math.max(0, this.skillScore - 400);
          UI.popup('-400 撞击', 'red');
        }
      }
    }
  },

  handleTraffic(dt) {
    const c = this.car;
    let minDist = 1e9;
    for (const tc of this.traffic.cars) {
      const dx = c.pos.x - tc.visual.position.x, dz = c.pos.z - tc.visual.position.z;
      const d = Math.hypot(dx, dz);
      minDist = Math.min(minDist, d);
      if (d < 2.9 && d > 0.01) {
        const nx = dx / d, nz = dz / d;
        const overlap = 2.9 - d;
        c.displace(nx * overlap, nz * overlap);
        tc.visual.position.x -= nx * overlap * 0.5;
        tc.visual.position.z -= nz * overlap * 0.5;
        const vn = c.vel.x * nx + c.vel.z * nz;
        if (vn < 0) {
          c.applyImpact(nx, nz, vn, 1.25);
          if (vn < -5) { AudioSys.impact(Math.min(1, -vn / 18)); this.shake = Math.min(1, this.shake + 0.4); }
        }
      }
    }
    // 擦肩而过
    if (minDist < 2.5 && this.car.speedKmh > 45 && this.nearMissCd <= 0) {
      this.skillScore += 300;
      UI.popup('擦肩而过 +300', 'blue');
      this.nearMissCd = 1.8;
    }
    this.nearMissCd = Math.max(0, this.nearMissCd - dt);
  },

  handleSkills(dt) {
    const c = this.car;
    // 漂移里程碑
    if (c.driftScore >= this.driftMilestone && this.driftPopupCd <= 0) {
      const mult = Math.max(1, Math.floor(c.driftMult));
      const gain = 500 * mult;
      this.skillScore += gain;
      UI.popup('漂移 +' + gain + ' ×' + mult);
      this.driftMilestone += 500;
      this.driftPopupCd = 0.8;
    }
    this.driftPopupCd = Math.max(0, this.driftPopupCd - dt);
    // 空中
    if (c.airborne && !this.lastAirborne) this.airStart = c.airTime;
    if (!c.airborne && this.lastAirborne && c.airTime > 0.6 && c.speed > 22) {
      this.skillScore += 400;
      UI.popup('飞跃 +400', 'green');
      this.shake = Math.min(1, this.shake + 0.35);
      AudioSys.impact(0.4);
    }
    this.lastAirborne = c.airborne;
    // 极速
    if (c.speedKmh > 185 && this.topSpeedCd <= 0) {
      this.skillScore += 500;
      UI.popup('极速 ' + Math.round(c.speedKmh) + ' km/h +500', 'blue');
      this.topSpeedCd = 18;
    }
    this.topSpeedCd = Math.max(0, this.topSpeedCd - dt);
    // 卡住自动复位
    if (c.airborne && c.airTime > 2.2 && c.speed < 3 && this.recoverCd <= 0) {
      this.respawnCar();
      UI.toast('车辆卡住，自动复位');
      this.recoverCd = 5;
    }
    this.recoverCd = Math.max(0, this.recoverCd - dt);
    // 撞树惩罚冷却
  },

  handleSpeedZone() {
    const c = this.car;
    const x = c.pos.x, z = c.pos.z;
    const inZone = Math.abs(x) < 430 && z > -300 && z < 240;
    if (inZone && !this.speedZone.inZone) {
      this.speedZone.inZone = true; this.speedZone.best = 0;
      UI.toast('进入测速区间！压出你的极速');
    }
    if (this.speedZone.inZone) {
      this.speedZone.best = Math.max(this.speedZone.best, c.speedKmh);
      if (!inZone) {
        this.speedZone.inZone = false;
        if (this.speedZone.best > 90) {
          const gain = Math.round(this.speedZone.best - 90);
          this.skillScore += gain;
          UI.popup('测速 ' + Math.round(this.speedZone.best) + ' km/h +' + gain, 'green');
        }
      }
    }
  },

  handleRaceCheckpoints() {
    if (!this.raceActive || !this.raceStarted) return;
    const c = this.car;
    if (this.raceCpNext < this.raceCheckpoints.length) {
      const cp = this.raceCheckpoints[this.raceCpNext];
      if (Math.hypot(c.pos.x - cp.x, c.pos.z - cp.z) < 30) {
        this.raceCpIdx++;
        this.raceCpNext++;
        UI.popup('检查点 ' + this.raceCpIdx + '/' + this.raceCheckpoints.length, 'green');
        if (this.raceCpNext >= this.raceCheckpoints.length) this.finishRace();
      }
    }
  },

  finishRace() {
    window.__finDbg = JSON.stringify({
      pos: this.racePosition,
      pp: this.oppRoute ? Math.min(1, this.racePlayerArc / this.oppRoute.samples[this.oppRoute.samples.length - 1].d) : -1,
      opps: this.opponents.map(o => +o.progress.toFixed(3)),
    });
    this.raceActive = false;
    const t = this.raceTime;
    const bonus = Math.round(Math.max(0, this.racePar * 12 - t * 5)) + 500;
    this.skillScore += bonus;
    const d = t - this.racePar;
    this.raceFinishPos = this.racePosition;
    const posTxt = this.raceFinishPos > 0 ? '第 ' + this.raceFinishPos + ' 名 · ' : '';
    UI.bigMsg(fmtTime(t), posTxt + (d <= 0 ? '领先目标 ' : '落后目标 ') + fmtTime(Math.abs(d)) + ' · 奖励 +' + bonus, true);
    setTimeout(() => UI.hideMsg(), 4200);
    UI.popup('完赛！+'+bonus, 'green');
    AudioSys.impact(0.3);
  },

  updateCamera(dt) {
    const c = this.car;
    const p = c.visual.position;
    // 相机用插值后的 yaw（c.yaw 来自未插值四元数，有 30-48Hz 抖动，导致车尾左右震）
    const iq = c.body ? c.body.interpolatedQuaternion : null;
    const yaw = iq
      ? Math.atan2(2 * (iq.x * iq.z + iq.y * iq.w), 1 - 2 * (iq.x * iq.x + iq.y * iq.y))
      : c.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const drift = clamp(c.slipAngleR * 1.6, -1.2, 1.2);
    const spdK = clamp(c.speed / 70, 0, 1); // 0..1 极速程度
    const now = performance.now() / 1000;
    // Cockpit and hood cameras are rigidly mounted in the car's local space.
    // They deliberately ignore speed offsets, interpolation, shake and dynamic FOV.
    if (this.camMode === 1 || this.camMode === 2) {
      const eye = this._fixedCamEye || (this._fixedCamEye = new THREE.Vector3());
      const aim = this._fixedCamAim || (this._fixedCamAim = new THREE.Vector3());
      if (this.camMode === 1) {
        const cc = c.spec.camCockpit || [0.36, 0.65, -0.10];
        eye.set(cc[0], cc[1], cc[2]);
        aim.set(cc[0], Math.max(0.25, cc[1] - 0.02), 20);
      } else {
        const hc = c.spec.camHood || [0, 0.70, 1.18];
        eye.set(hc[0], hc[1], hc[2]);
        aim.set(hc[0], Math.max(0.2, hc[1] - 0.22), 20);
      }
      c.visual.updateMatrixWorld(true);
      c.visual.localToWorld(eye);
      c.visual.localToWorld(aim);
      this.camPos.copy(eye);
      this.camLook.copy(aim);
      this.camera.position.copy(eye);
      this.camera.up.set(0, 1, 0).applyQuaternion(c.visual.quaternion);
      this.applyLookAround(dt, aim);
      this.camera.lookAt(aim);
      this.camFov = this.camMode === 1 ? 68 : 70;
      this.camera.fov = this.camFov;
      this.camera.near = 0.04;
      this.camera.updateProjectionMatrix();
      if (this.fxMat && this.fxMat.uniforms.shake) this.fxMat.uniforms.shake.value.set(0, 0);
      this.shake = Math.max(0, this.shake - dt * 2.2);
      return;
    }
    this.camera.up.set(0, 1, 0);
    if (this.camera.near !== 0.1) {
      this.camera.near = 0.1;
      this.camera.updateProjectionMatrix();
    }
    let tx, ty, tz, lookX, lookY, lookZ, rate;
    if (this.camMode === 0) {
      // 追逐视角：加速度滞后偏移（加速拉远/刹车怼近）+ 高度随动 + 单层垂直低通
      const T = this.chaseTune;
      const dist = T.dist + spdK * T.pull;
      const height = (T.height || 2.30) - spdK * 0.28;
      // 自然跟随：地面用平滑地面高度，滞空时平滑跟随车身实际高度
      const targetBaseY = c.airborne ? p.y : (c.groundY > -500 ? c.groundY : p.y);
      this._camBaseY = this._camBaseY == null ? targetBaseY : lerp(this._camBaseY, targetBaseY, Math.min(1, (c.airborne ? 6 : 18) * dt));
      const baseY = this._camBaseY;
      if (!this.speedshot) {
        const accelRaw = (c.speed - this.chasePrevSpeed) / Math.max(dt, 1e-4);
        this.chasePrevSpeed = c.speed;
        this.chaseAccel = lerp(this.chaseAccel || 0, accelRaw, Math.min(1, 6 * dt));
        const accel = Math.abs(this.chaseAccel) < 0.5 ? 0 : this.chaseAccel;
        const k = accel >= 0 ? T.accK : T.brkK;
        const targetOff = clamp(accel * k, -T.brkMax, T.accMax);
        this.chaseOff = lerp(this.chaseOff, targetOff, Math.min(1, T.rate * dt));
        const targetH = clamp(accel * T.hgtK * (accel < 0 ? 1.5 : 1), -0.34, 0.22);
        this.chaseHeight = lerp(this.chaseHeight, targetH, Math.min(1, T.rate * dt));
        tx = p.x - fx * (dist + this.chaseOff);
        tz = p.z - fz * (dist + this.chaseOff);
        const targetY = baseY + height + this.chaseHeight;
        if (this.camPosY == null) this.camPosY = targetY;
        else this.camPosY = lerp(this.camPosY, targetY, Math.min(1, (c.airborne ? 12 : 9) * dt));
        ty = this.camPosY;
      } else {
        tx = p.x - fx * dist;
        ty = baseY + height;
        tz = p.z - fz * dist;
      }
      // 地面夹紧：追逐相机不得低于其所在位置的地形（上坡/过坡顶时相机滞后会穿地）
      if (!c.airborne && this.world && this.world.terrainHeight) {
        const camGround = this.world.terrainHeight(tx, tz);
        if (ty < camGround + 1.6) ty = camGround + 1.6;
      }
      lookX = p.x + fx * 7.5;
      // 视线目标直接对准车身实际高度（不用滞后的 baseY），下坡时车不会跑出画面
      const targetLookY = (c.airborne ? p.y : (c.groundY > -500 ? c.groundY : p.y)) + 0.6 - spdK * 0.1;
      this.camLookYSmooth = this.camLookYSmooth == null ? targetLookY : lerp(this.camLookYSmooth, targetLookY, Math.min(1, (c.airborne ? 10 : 16) * dt));
      lookY = this.camLookYSmooth;
      lookZ = p.z + fz * 7.5;
      if (this.lookActive || this.lookYaw || this.lookPitch) {
        const o = { tx, ty, tz, cx: p.x, cy: p.y + 1.0, cz: p.z };
        this.applyCarOrbit(dt, o);
        tx = o.tx; ty = o.ty; tz = o.tz;
        lookX = p.x; lookY = p.y + 1.0; lookZ = p.z;
      }
      rate = 12;
    } else if (this.camMode === 1) {
      // 真实驾驶室：驾驶座眼位，头随转向/油门微动
      const lean = -c.steer * 0.05;
      const bob = Math.sin(now * 13) * 0.006 + c.bodyVy * 0.005;
      tx = p.x + rx * lean + fx * 0.2;
      ty = p.y + 0.76 + bob;
      tz = p.z + rz * lean + fz * 0.2;
      lookX = p.x + fx * 20; lookY = p.y + (0.72 - spdK * 0.04); lookZ = p.z + fz * 20;
      rate = 18;
    } else if (this.camMode === 2) {
      // 引擎盖视角：贴近前机盖，视野压向路面，带引擎振动
      const vib = Math.sin(now * 31) * 0.006 * (1 + spdK);
      tx = p.x + fx * 1.12 + rx * c.steer * 0.05;
      ty = p.y + 0.78 + vib;
      tz = p.z + fz * 1.12 + rz * c.steer * 0.05;
      lookX = p.x + fx * 20; lookY = p.y + (0.58 - spdK * 0.22); lookZ = p.z + fz * 20;
      rate = 16;
    } else {
      const dist = 13.2, height = 4.8;
      tx = p.x - fx * dist;
      ty = (c.groundY > -500 ? c.groundY : p.y) + height;
      tz = p.z - fz * dist;
      lookX = p.x + fx * 5; lookY = p.y + 0.5; lookZ = p.z + fz * 5;
      if (this.lookActive || this.lookYaw || this.lookPitch) {
        const o = { tx, ty, tz, cx: p.x, cy: p.y + 1.0, cz: p.z };
        this.applyCarOrbit(dt, o);
        tx = o.tx; ty = o.ty; tz = o.tz;
        lookX = p.x; lookY = p.y + 1.0; lookZ = p.z;
      }
      rate = 2.8;
    }
    this.shake = Math.max(0, this.shake - dt * 2.2);
    // Chase camera locks the car in-frame. Controlled shake is applied later to
    // the whole rendered image, so the car does not jitter independently.
    if (this.camMode === 0 || this.speedshot) {
      this.camPos.set(tx, ty, tz);
      this.camLook.set(lookX, lookY, lookZ);
    } else {
      this.camPos.x = lerp(this.camPos.x, tx, Math.min(1, rate * dt));
      this.camPos.y = lerp(this.camPos.y, ty, Math.min(1, rate * dt));
      this.camPos.z = lerp(this.camPos.z, tz, Math.min(1, rate * dt));
      this.camLook.x = lerp(this.camLook.x, lookX, Math.min(1, 8 * dt));
      this.camLook.y = lerp(this.camLook.y, lookY, Math.min(1, 8 * dt));
      this.camLook.z = lerp(this.camLook.z, lookZ, Math.min(1, 8 * dt));
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
    const targetFov = this.camMode === 0 ? 64 + spdK * 18 : 62;
    this.camFov = lerp(this.camFov, targetFov, Math.min(1, dt * 4.5));
    this.camera.fov = this.camFov;
    this.camera.updateProjectionMatrix();
    if (this.fxMat && this.fxMat.uniforms.shake) {
      const impact = this.shake;
      const road = 0; // 追逐视角的周期性屏幕抖动已删除（保留撞击抖动）
      const sx = Math.sin(now * 37.0) * road * 0.00042
        + Math.sin(now * 19.0 + 0.8) * impact * 0.0028;
      const sy = Math.sin(now * 43.0 + 1.7) * road * 0.00034
        + Math.sin(now * 23.0) * impact * 0.0022;
      this.fxMat.uniforms.shake.value.set(sx, sy);
    }
  },

  // 按住 V 时用鼠标绕机位转动视角；松开后平滑回中
  applyLookAround(dt, look) {
    if (!this.lookActive && (this.lookYaw || this.lookPitch)) {
      const r = Math.min(1, 6 * dt);
      this.lookYaw *= (1 - r);
      this.lookPitch *= (1 - r);
      if (Math.abs(this.lookYaw) < 0.0008) this.lookYaw = 0;
      if (Math.abs(this.lookPitch) < 0.0008) this.lookPitch = 0;
    }
    if (!this.lookYaw && !this.lookPitch) return;
    const dir = this._lookDir || (this._lookDir = new THREE.Vector3());
    const right = this._lookRight || (this._lookRight = new THREE.Vector3());
    dir.subVectors(look, this.camPos).normalize();
    right.crossVectors(this.camera.up, dir).normalize();
    dir.applyAxisAngle(this.camera.up, this.lookYaw);
    dir.applyAxisAngle(right, this.lookPitch);
    look.copy(this.camPos).addScaledVector(dir, 40);
  },

  // 按住 V 时绕车中心环视（外部视角）：偏航/俯仰绕车旋转，松开回中
  applyCarOrbit(dt, o) {
    if (!this.lookActive && (this.lookYaw || this.lookPitch)) {
      const r = Math.min(1, 6 * dt);
      this.lookYaw *= (1 - r);
      this.lookPitch *= (1 - r);
      if (Math.abs(this.lookYaw) < 0.0008) this.lookYaw = 0;
      if (Math.abs(this.lookPitch) < 0.0008) this.lookPitch = 0;
    }
    if (!this.lookYaw && !this.lookPitch) return;
    const off = this._orbOff || (this._orbOff = new THREE.Vector3());
    const axis = this._orbAxis || (this._orbAxis = new THREE.Vector3());
    const up = this._orbUp || (this._orbUp = new THREE.Vector3(0, 1, 0));
    off.set(o.tx - o.cx, o.ty - o.cy, o.tz - o.cz);
    off.applyAxisAngle(up, this.lookYaw);
    axis.crossVectors(up, off).normalize();
    off.applyAxisAngle(axis, this.lookPitch);
    o.tx = o.cx + off.x;
    o.ty = o.cy + off.y;
    o.tz = o.cz + off.z;
  },
};

Game.init();
