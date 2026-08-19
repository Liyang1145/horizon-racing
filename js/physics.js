// ============================================================
//  车辆物理 — cannon-es RaycastVehicle 真四轮悬挂
//  每个轮子独立向地面发射射线，计算悬挂力 / 抓地力 / 驱动力
// ============================================================
'use strict';

// 近光投影贴图：倒三角光斑（近处收窄、向前展开），上方留透明，
// 只把光压到路面上，不再横向扫成一条线或照亮树冠
function makeHeadlightCookie() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const x = c.getContext('2d');
  x.clearRect(0, 0, 512, 512);
  const grad = x.createLinearGradient(0, 512, 0, 0);
  grad.addColorStop(0, 'rgba(255,246,222,1)');
  grad.addColorStop(0.4, 'rgba(255,240,205,0.95)');
  grad.addColorStop(0.7, 'rgba(255,234,185,0.72)');
  grad.addColorStop(1, 'rgba(255,226,168,0.42)');
  x.fillStyle = grad;
  x.beginPath();
  x.moveTo(256, 470);
  x.lineTo(54, 28);
  x.lineTo(458, 28);
  x.closePath();
  x.fill();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  return t;
}

// ---------- 保时捷 918 GLB 模型（base64 内嵌，首次加载后缓存，克隆共享几何体） ----------
const Porsche918Model = (() => {
  let cache = null;
  let promise = null;

  function decodeB64(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  // GLTFLoader 会把节点名里的 . 和空格规范成 _，统一用归一化名称匹配
  const normName = n => (n || '').replace(/[.\s]/g, '');

  function prepare(root) {
    // 移除无关节点（路面组 / 相机 / 灯光 / 网格辅助）
    const drop = [];
    root.traverse(o => {
      if (/^(RoadGroup|Camera|Light|Grid)/.test(normName(o.name))) drop.push(o);
    });
    for (const o of drop) {
      if (o.parent) o.parent.remove(o);
    }
    // 模型本身已是左舵（Blender 与游戏轴向一致），不镜像；
    // 之前的镜像会把整台车水平反转（方向盘翻到右边、车身文字反向）。
    window.__P918_READY = true;
    return root;
  }

  function load() {
    if (cache) return Promise.resolve(cache);
    if (promise) return promise;
    promise = new Promise((resolve, reject) => {
      const b64 = window.PORSCHE918_GLB_B64;
      if (!b64) { reject(new Error('918 GLB missing')); return; }
      const loader = new THREE.GLTFLoader();
      const url = URL.createObjectURL(new Blob([decodeB64(b64)], { type: 'application/octet-stream' }));
      loader.load(url, gltf => {
        URL.revokeObjectURL(url);
        try {
          cache = prepare(gltf.scene);
          resolve(cache);
        } catch (e) {
          reject(e);
        }
      }, undefined, err => {
        URL.revokeObjectURL(url);
        reject(err);
      });
    });
    return promise;
  }

  function cloneForCar() {
    if (!cache) throw new Error('918 model not loaded');
    return cache.clone(true);
  }

  return { load, cloneForCar, isReady: () => !!cache };
})();

class Car {
  constructor(spec, scene, world) {
    this.spec = spec;
    this.world = world;
    this.driftAssistOff = false; // U 形弯 AI 直道阶段临时关闭“转向即漂移”
    this.aiDrift = false;        // AI 漂移秀强制启用漂移特性（即使是下压力车）
    this.mass = spec.mass;
    this.wheelbase = spec.wheelbase || 2.64;
    this.track = spec.track || 1.6;
    this.wheelR = spec.wheelR || 0.34;
    this.rest = 0.32;
    this.cd = 0.34 + (spec.id === 'muscle' ? 0.1 : 0) + (spec.id === 'gt' ? -0.04 : 0);
    this.frontArea = 2.05;
    this.COM_OFFSET = 0.5; // 视觉地面 到 质心 的高度

    // 轮位 (local x, local z; +z 前进, +x 右侧)
    this.wheelPos = [
      { x: this.track / 2, z: this.wheelbase / 2, front: true },
      { x: -this.track / 2, z: this.wheelbase / 2, front: true },
      { x: this.track / 2, z: -this.wheelbase / 2, front: false },
      { x: -this.track / 2, z: -this.wheelbase / 2, front: false },
    ];
    if (spec.id === 'p918') {
      const ft = spec.frontTrack || this.track;
      const rt = spec.rearTrack || this.track;
      this.wheelPos = [
        { x: ft / 2, z: this.wheelbase / 2, front: true },
        { x: -ft / 2, z: this.wheelbase / 2, front: true },
        { x: rt / 2, z: -this.wheelbase / 2, front: false },
        { x: -rt / 2, z: -this.wheelbase / 2, front: false },
      ];
    }
    this.pos = new THREE.Vector3(0, 3, 0);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.yawRate = 0;
    this.steer = 0;
    this.bodyVy = 0;
    this.groundY = 0;
    this.engineRpm = 900;
    this.gear = 1;
    this.revRatio = 3.2;
    this.shiftTimer = 0;
    this.autoShift = true;
    this.input = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false };
    this.speed = 0;
    this.wheelSpin = [0, 0, 0, 0];
    this.suspVis = [0, 0, 0, 0];
    this.slipAngleF = 0;
    this.slipAngleR = 0;
    this.airborne = false;
    this.airTime = 0;
    this.driftScore = 0;
    this.driftMult = 1;
    this.driftPopupCd = 0;
    this.nearMissCd = 0;
    this.overtime = 0;
    this.lastCollide = 0;
    this.gearChanges = 0;
    this.maxSpeedSeen = 0;
    this.grounded = false;
    this.brakeRamp = 0; // 刹车力渐进建立（0→1，约 0.18s），避免瞬间点头刮底盘
    // —— 飞跃慢动作（不加落地缓冲）：预测滞空 / 落地标记（加分用） ——
    this.jumpPredicted = 0;
    this.jumpVy = 0;
    this.jumpGroundY = 0;
    this.jumpStartX = 0; this.jumpStartZ = 0;
    this.jumpPredLandX = 0; this.jumpPredLandZ = 0;
    this.jumpDist = 0;
    this.landing = false;
    this.landingT = 0;

    this._q1 = new THREE.Quaternion();
    this._q2 = new THREE.Quaternion();
    this._q3 = new THREE.Quaternion();
    this._q4 = new THREE.Quaternion();
    this._qSteer = new THREE.Quaternion();
    // 方向盘视觉：所有 Steering* 节点一起转 + 平滑
    this.steerWheels = [];
    this.steerVisual = 0;
    this._steerLastT = 0;
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();

    this.buildVisual(scene);
    window.__carStage = 'visual';
    this.initPhysics();
    window.__carStage = 'physics';
  }

  // ---------------- 物理车身 ----------------
  initPhysics() {
    const cw = this.world.physics.cannon;
    const s = this.spec;
    this.body = new CANNON.Body({
      mass: s.mass,
      // 底盘碰撞盒做薄做短：静止时底盘离地保持足够间隙，
      // 重刹点头/压路肩时底盘不会刮地（刮地会产生巨大碰撞冲击，车被弹飞）
      shape: new CANNON.Box(new CANNON.Vec3(0.95, 0.30, 1.8)),
      position: new CANNON.Vec3(0, 4, 0),
    });
    this.body.linearDamping = 0.025;
    // 角阻尼调低：漂移中正打方向能持续转下去，不被物理引擎悄悄“回正”
    this.body.angularDamping = 0.10;
    this.body.allowSleep = false;
    cw.addBody(this.body);

    this.vehicle = new CANNON.RaycastVehicle({
      chassisBody: this.body,
      indexRightAxis: 0,  // x
      indexUpAxis: 1,     // y
      indexForwardAxis: 2,// z
    });
    const wheelOpts = {
      radius: this.wheelR,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 55,
      suspensionRestLength: 0.34,
      frictionSlip: 1.5,
      dampingRelaxation: 2.6,
      dampingCompression: 4.6,
      maxSuspensionForce: 90000,
      rollInfluence: 0.02,
      // 叉乘 up×axle 得到前进方向：axle 必须为 -x，否则驱动力反向
      axleLocal: new CANNON.Vec3(-1, 0, 0),
      maxSuspensionTravel: 0.28,
      customSlidingRotationalSpeed: -28,
      useCustomSlidingRotationalSpeed: true,
    };
    if (s.id === 'p918') {
      // 918：偏硬的赛道悬挂 + 高抓地；坡面震动已由接触法线平滑解决，不靠软悬挂掩盖
      wheelOpts.suspensionStiffness = 52;
      wheelOpts.suspensionRestLength = 0.35;
      wheelOpts.frictionSlip = 2.2;
      wheelOpts.dampingRelaxation = 6.5;
      wheelOpts.dampingCompression = 9.0;
      wheelOpts.maxSuspensionForce = 120000;
      wheelOpts.rollInfluence = 0.03;
      wheelOpts.maxSuspensionTravel = 0.27;
    }
    for (let i = 0; i < 4; i++) {
      const wp = this.wheelPos[i];
      this.vehicle.addWheel({
        ...wheelOpts,
        chassisConnectionPointLocal: new CANNON.Vec3(wp.x, 0.08, wp.z),
      });
    }
    this.vehicle.addToWorld(cw);
  }

  // 换车 / 移除时清理物理世界中的车身与预步进监听
  destroy() {
    const cw = this.world.physics.cannon;
    try {
      this.vehicle.removeFromWorld(cw);
    } catch (e) { /* ignore */ }
    cw.removeBody(this.body);
  }

  // ---------------- 外观：不同车型独立模型 ----------------
  buildVisual(scene) {
    window.__carStage = 'visual:start';

    const s = this.spec;
    if (s.id === 'p918') return this.buildP918Visual(scene);

    const g = new THREE.Group();
    const body = new THREE.Group();
    body.position.y = -this.COM_OFFSET;

    const paint = new THREE.MeshStandardMaterial({
      color: s.color,
      metalness: 0.68,
      roughness: 0.26
    });
    const dark = new THREE.MeshStandardMaterial({
      color: 0x111318,
      metalness: 0.45,
      roughness: 0.48
    });
    const pillarMat = new THREE.MeshStandardMaterial({
      color: 0x25282e,
      metalness: 0.25,
      roughness: 0.68
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x09131d,
      metalness: 0.82,
      roughness: 0.1,
      transparent: true,
      opacity: 0.78
    });
    const gtGlass = new THREE.MeshStandardMaterial({
      color: 0x0b1d2a,
      metalness: 0.68,
      roughness: 0.13,
      transparent: true,
      opacity: 0.82
    });
    const chrome = new THREE.MeshStandardMaterial({
      color: 0xd8dce2,
      metalness: 1,
      roughness: 0.18
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: s.accent,
      metalness: 0.5,
      roughness: 0.42
    });
    const lampPodMat = new THREE.MeshStandardMaterial({
      color: 0xffe7a8,
      emissive: 0xffbf58,
      emissiveIntensity: 1.5,
      metalness: 0.1,
      roughness: 0.22
    });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 0xfff8e8,
      emissive: 0xfff0ce,
      emissiveIntensity: 2.2,
      metalness: 0.12,
      roughness: 0.16
    });
    const brakeMat = new THREE.MeshStandardMaterial({
      color: 0x9c0715,
      emissive: 0xff1028,
      emissiveIntensity: 1.8,
      metalness: 0.2,
      roughness: 0.22
    });
    this.brakeMat = brakeMat;

    const exMat = new THREE.MeshStandardMaterial({
      color: 0x9298a0,
      metalness: 0.96,
      roughness: 0.25
    });
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x686d76,
      metalness: 0.9,
      roughness: 0.35
    });
    const caliperMat = new THREE.MeshStandardMaterial({
      color: s.id === 'rally' ? 0xffd000 : 0xd61a24,
      metalness: 0.55,
      roughness: 0.34
    });

    const finish = (m, shadows = true) => {
      m.castShadow = shadows;
      m.receiveShadow = shadows;
      body.add(m);
      return m;
    };

    const mkBox = (w, h, l, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      return finish(m);
    };

    const mkSphere = (
      rx, ry, rz, mat, x, y, z, seg = 24, rxn = 0, ryn = 0, rzn = 0
    ) => {
      const widthSeg = Math.max(12, seg);
      const heightSeg = Math.max(8, Math.floor(seg * 0.55));
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, widthSeg, heightSeg),
        mat
      );
      m.scale.set(rx, ry, rz);
      m.position.set(x, y, z);
      m.rotation.set(rxn, ryn, rzn);
      return finish(m);
    };

    const mkCyl = (
      r, h, mat, x, y, z, axis = 'y', seg = 18, r2 = r
    ) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r2, h, seg),
        mat
      );
      if (axis === 'x') m.rotation.z = Math.PI / 2;
      if (axis === 'z') m.rotation.x = Math.PI / 2;
      m.position.set(x, y, z);
      return finish(m);
    };

    const mkTorus = (
      major, tube, mat, x, y, z, rx = 0, ry = 0, rz = 0, radial = 10, tubular = 32
    ) => {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(major, tube, radial, tubular),
        mat
      );
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      return finish(m);
    };

    // Longitudinal-section loft. Each section is:
    // [z, halfWidth, sideHeight, shoulderHeight, crownHeight].
    const mkLoft = (sections, mat, profile = [-1, -0.90, -0.48, 0, 0.48, 0.90, 1], shoulderU = 0.90) => {
      const geo = new THREE.BufferGeometry();
      const pos = [];
      const idx = [];
      const row = profile.length;

      for (const sec of sections) {
        const [z, halfW, sideY, shoulderY, crownY] = sec;
        for (const u of profile) {
          const au = Math.abs(u);
          let y;
          if (au >= shoulderU) {
            const t = (1 - au) / (1 - shoulderU);
            y = sideY + (shoulderY - sideY) * Math.max(0, Math.min(1, t));
          } else {
            const t = 1 - au / shoulderU;
            y = shoulderY + (crownY - shoulderY) * Math.sin(t * Math.PI * 0.5);
          }
          pos.push(u * halfW, y, z);
        }
      }

      for (let iz = 0; iz < sections.length - 1; iz++) {
        for (let ix = 0; ix < row - 1; ix++) {
          const a = iz * row + ix;
          const b = a + 1;
          const c = a + row;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
      }

      for (const end of [0, sections.length - 1]) {
        const sec = sections[end];
        const center = pos.length / 3;
        pos.push(0, (sec[2] + sec[4]) * 0.5, sec[0]);
        const base = end * row;
        for (let ix = 0; ix < row - 1; ix++) {
          if (end === 0) idx.push(center, base + ix + 1, base + ix);
          else idx.push(center, base + ix, base + ix + 1);
        }
      }

      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      return finish(new THREE.Mesh(geo, mat));
    };

    const addWing = (width, z, y, chord, rise, wingMat = dark) => {
      mkBox(width, 0.065, chord, wingMat, 0, y, z, -0.08);
      for (const side of [-1, 1]) {
        mkBox(0.055, rise, 0.22, dark, side * width * 0.36, y - rise * 0.5, z + 0.02, -0.06);
        mkBox(0.045, 0.2, chord + 0.08, dark, side * (width * 0.5 + 0.015), y + 0.045, z, -0.08);
      }
    };

    const addMirror = (side, x, y, z) => {
      mkSphere(0.16, 0.075, 0.12, paint, side * x, y, z, 16, 0, 0, side * -0.08);
      mkCyl(0.022, 0.18, dark, side * (x - 0.08), y - 0.07, z - 0.01, 'y', 10);
    };

    const addCockpit = (sporty = true, exteriorFrame = true, compact = false) => {
      // 相机约在 (0, 1.06, 0.2)：仪表台和方向盘位于视野底部。
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x33373d, metalness: 0.32, roughness: 0.55 });
      mkBox(1.5, 0.15, 0.38, pillarMat, 0, 0.84, 0.68, -0.09);
      mkBox(1.38, 0.055, 0.38, dark, 0, 0.945, 0.68, -0.09);
      mkBox(0.48, 0.13, 0.08, dark, 0.32, 0.985, 0.52, -0.12);
      for (const x of [0.21, 0.32, 0.43]) {
        mkBox(0.055, 0.04, 0.035, accentMat, x, 1.015, 0.475, -0.12);
      }

      // 方向盘总成：轮圈 + 两条辐条放进同一个 rig，转向时一起旋转
      const steerRig = new THREE.Group();
      steerRig.position.set(0.38, 0.82, 0.30);
      steerRig.rotation.x = -0.2;
      const wheel = new THREE.Mesh(
        new THREE.TorusGeometry(0.19, 0.025, 12, 32),
        wheelMat
      );
      wheel.scale.y = 0.88;
      wheel.castShadow = true; wheel.receiveShadow = true;
      steerRig.add(wheel);
      const spokeH = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.03, 0.04), wheelMat);
      spokeH.castShadow = true; spokeH.receiveShadow = true;
      steerRig.add(spokeH);
      const spokeV = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.23, 0.04), wheelMat);
      spokeV.castShadow = true; spokeV.receiveShadow = true;
      steerRig.add(spokeV);
      body.add(steerRig);
      if (!this.steerWheels) this.steerWheels = [];
      this.steerWheels.push({
        node: steerRig,
        axis: new THREE.Vector3(0, 0, 1),
        base: steerRig.quaternion.clone(),
      });

      mkCyl(0.035, 0.18, chrome, 0.38, 0.78, 0.36, 'z', 14);

      if (exteriorFrame) {
        for (const side of [-1, 1]) {
          mkBox(0.17, 0.62, 0.16, pillarMat, side * 0.52, 1.06, 0.66, -0.42, 0, side * -0.08);
        }
        mkBox(1.5, 0.12, 0.14, pillarMat, 0, 1.3, 0.35, -0.04);
        mkBox(1.3, 0.04, 0.06, chrome, 0, 1.23, 0.43, -0.42);
      }

      if (sporty) {
        for (const side of [-1, 1]) {
          if (compact) {
            mkBox(0.30, 0.39, 0.18, dark, side * 0.34, 0.72, -0.30, -0.10);
          } else {
            mkSphere(0.29, 0.31, 0.38, dark, side * 0.34, 0.76, -0.28, 18);
          }
          mkBox(compact ? 0.32 : 0.38, 0.12, compact ? 0.32 : 0.38, dark, side * 0.34, 0.52, -0.24, 0.08);
          mkBox(0.08, compact ? 0.34 : 0.42, 0.08, accentMat, side * 0.34, compact ? 0.78 : 0.84, -0.28, 0.12);
        }
        mkBox(0.2, 0.28, 0.66, dark, 0, 0.66, -0.05, -0.04);
        mkCyl(0.025, 0.22, chrome, 0.06, 0.84, 0.18, 'y', 10);
        mkSphere(0.055, 0.055, 0.055, dark, 0.06, 0.97, 0.18, 14);
      }
    };

    let frontZ = 2.25;
    let rearZ = -2.25;
    let lampY = 0.58;
    let lampX = 0.58;
    let trailRearZ = -2.3;

    if (s.id === 'gt') {
      frontZ = 2.38;
      rearZ = -2.35;
      trailRearZ = -2.39;
      lampY = 0.61;
      lampX = 0.6;

      // A single continuous shell carries the nose, waist, shoulders and tail.
      mkLoft([
        [-2.38, 0.50, 0.34, 0.47, 0.51],
        [-2.24, 0.80, 0.34, 0.57, 0.62],
        [-1.86, 0.94, 0.33, 0.64, 0.70],
        [-1.48, 0.99, 0.33, 0.69, 0.75],
        [-1.08, 0.95, 0.32, 0.65, 0.72],
        [-0.58, 0.90, 0.31, 0.57, 0.64],
        [ 0.00, 0.88, 0.31, 0.56, 0.63],
        [ 0.56, 0.90, 0.31, 0.61, 0.69],
        [ 1.02, 0.96, 0.33, 0.69, 0.77],
        [ 1.40, 0.99, 0.34, 0.72, 0.80],
        [ 1.78, 0.92, 0.32, 0.64, 0.71],
        [ 2.10, 0.79, 0.30, 0.54, 0.61],
        [ 2.38, 0.46, 0.29, 0.42, 0.47]
      ], paint);

      mkBox(1.78, 0.12, 3.65, dark, 0, 0.29, -0.02);
      for (const side of [-1, 1]) {
        mkBox(0.07, 0.11, 2.48, dark, side * 0.93, 0.30, -0.02);
        mkBox(0.07, 0.23, 0.62, dark, side * 0.922, 0.49, -0.70, 0.04, side * -0.08);
        mkBox(0.025, 0.16, 0.48, accentMat, side * 0.955, 0.49, -0.72, 0.04, side * -0.08);
      }

      // Low closed canopy with a continuous windscreen and roof line.
      mkLoft([
        [-1.15, 0.58, 0.71, 0.80, 0.86],
        [-0.87, 0.68, 0.67, 1.00, 1.14],
        [-0.38, 0.69, 0.65, 1.17, 1.29],
        [ 0.20, 0.67, 0.65, 1.18, 1.30],
        [ 0.66, 0.61, 0.68, 1.04, 1.15],
        [ 0.88, 0.48, 0.70, 0.84, 0.90]
      ], gtGlass);
      mkBox(0.96, 0.035, 0.58, paint, 0, 1.292, -0.08, -0.01);
      for (const side of [-1, 1]) {
        mkBox(0.06, 0.45, 0.08, pillarMat, side * 0.59, 0.96, 0.63, -0.42, 0, side * -0.08);
        mkBox(0.055, 0.39, 0.08, pillarMat, side * 0.62, 0.95, -0.82, 0.38, 0, side * 0.06);
        mkBox(0.055, 0.055, 1.18, pillarMat, side * 0.54, 1.19, -0.08);
      }

      addCockpit(true, false, true);
      addMirror(1, 0.91, 0.91, 0.50);
      addMirror(-1, 0.91, 0.91, 0.50);

      mkBox(0.64, 0.025, 0.54, dark, 0, 0.785, 1.12, -0.05);
      for (const x of [-0.22, -0.11, 0, 0.11, 0.22]) {
        mkBox(0.018, 0.025, 0.48, accentMat, x, 0.804, 1.12, -0.05);
      }

      // Compact nose and recessed lighting.
      mkBox(1.34, 0.17, 0.16, dark, 0, 0.40, 2.31, -0.06);
      mkBox(1.62, 0.04, 0.32, dark, 0, 0.265, 2.27, -0.08);
      for (const side of [-1, 1]) {
        mkBox(0.42, 0.025, 0.13, dark, side * 0.55, 0.555, 2.29, -0.11, side * -0.06);
        mkBox(0.36, 0.02, 0.065, lampMat, side * 0.55, 0.575, 2.355, -0.11, side * -0.06);
      }

      // Rear deck, engine cover, lamp bar and diffuser.
      mkLoft([
        [-2.12, 0.77, 0.52, 0.62, 0.67],
        [-1.78, 0.82, 0.61, 0.70, 0.76],
        [-1.24, 0.70, 0.69, 0.82, 0.88]
      ], paint);
      mkBox(1.28, 0.045, 0.66, glass, 0, 0.82, -1.43, 0.07);
      for (const x of [-0.44, -0.22, 0, 0.22, 0.44]) {
        mkBox(0.025, 0.035, 0.60, dark, x, 0.85, -1.43, 0.07);
      }
      // 尾灯：左右两盏独立小灯，与夜间拖尾两个发射点（±0.6, 0.61, -2.39）对齐
      for (const side of [-1, 1]) {
        mkBox(0.24, 0.045, 0.12, brakeMat, side * 0.60, 0.62, -2.365);
      }
      mkBox(1.78, 0.10, 0.42, dark, 0, 0.31, -2.20, 0.10);
      for (const x of [-0.69, -0.36, 0, 0.36, 0.69]) {
        mkBox(0.03, 0.19, 0.54, dark, x, 0.31, -2.23, 0.10);
      }
      for (const x of [-0.48, -0.26, 0.26, 0.48]) {
        mkCyl(0.052, 0.18, exMat, x, 0.40, -2.39, 'z', 16, 0.062);
      }

      addWing(1.55, -1.98, 0.98, 0.28, 0.20, dark);
      mkBox(1.43, 0.03, 0.09, accentMat, 0, 0.975, -2.03, -0.07);
    } else if (false && s.id === 'gt') {
      frontZ = 2.34;
      rearZ = -2.34;
      trailRearZ = -2.38;
      lampY = 0.62;
      lampX = 0.6;

      // 多个高分段曲面构成主体，GT 总面数显著高于 3000。
      mkSphere(0.99, 0.25, 2.2, paint, 0, 0.5, -0.02, 40);
      mkSphere(0.93, 0.19, 1.38, paint, 0, 0.58, 0.92, 36, -0.08);
      mkSphere(0.91, 0.25, 0.88, paint, 0, 0.58, -1.48, 34, 0.05);
      mkSphere(0.72, 0.1, 0.94, paint, 0, 0.67, 1.46, 30, -0.08);
      mkSphere(0.78, 0.08, 0.6, paint, 0, 0.63, 2.02, 28, -0.16);
      mkBox(1.78, 0.16, 3.75, paint, 0, 0.39, -0.02);

      for (const side of [-1, 1]) {
        mkSphere(0.48, 0.26, 0.55, paint, side * 0.72, 0.5, 1.33, 24);
        mkSphere(0.49, 0.28, 0.58, paint, side * 0.72, 0.51, -1.34, 24);
        mkSphere(0.17, 0.24, 1.52, paint, side * 0.88, 0.48, -0.02, 24);
        mkBox(0.075, 0.13, 2.65, dark, side * 0.965, 0.29, -0.06);
        mkBox(0.07, 0.19, 0.72, dark, side * 0.925, 0.55, -0.54, 0.05, side * -0.06);
        mkBox(0.1, 0.25, 0.64, dark, side * 0.88, 0.64, -0.74, 0.05, side * -0.1);
        mkBox(0.08, 0.16, 0.46, accentMat, side * 0.91, 0.47, -0.77, 0.04, side * -0.1);
      }

      mkBox(1.86, 0.07, 0.66, dark, 0, 0.27, 2.18, -0.12);
      mkBox(1.42, 0.045, 0.44, dark, 0, 0.32, 2.43, -0.18);
      for (const side of [-1, 1]) {
        mkBox(0.45, 0.055, 0.64, dark, side * 0.54, 0.31, 2.2, -0.12, side * -0.08);
        mkBox(0.5, 0.065, 0.09, lampMat, side * 0.57, 0.59, 2.31, -0.12, side * -0.06);
        mkSphere(0.1, 0.035, 0.2, lampMat, side * 0.76, 0.61, 2.27, 16);
      }

      // 低矮玻璃舱和中置发动机盖。
      mkSphere(0.7, 0.43, 0.94, glass, 0, 0.91, -0.08, 34, -0.03);
      mkBox(1.34, 0.055, 0.86, glass, 0, 1.08, 0.37, -0.42);
      mkBox(1.31, 0.045, 0.75, glass, 0, 1.04, -0.67, 0.4);
      mkBox(1.28, 0.08, 0.68, paint, 0, 1.22, -0.24, -0.02);
      mkBox(0.1, 0.43, 0.78, pillarMat, 0, 1.06, -0.55, 0.36);

      addCockpit(true);
      addMirror(1, 0.91, 0.91, 0.54);
      addMirror(-1, 0.91, 0.91, 0.54);

      mkBox(1.44, 0.075, 0.72, glass, 0, 0.85, -1.3, 0.08);
      for (const x of [-0.48, -0.24, 0, 0.24, 0.48]) {
        mkBox(0.028, 0.045, 0.66, dark, x, 0.9, -1.3, 0.08);
      }

      mkBox(1.86, 0.12, 0.48, dark, 0, 0.3, -2.18, 0.08);
      mkBox(1.55, 0.04, 0.17, brakeMat, 0, 0.63, -2.305);
      for (const side of [-1, 1]) {
        mkBox(0.32, 0.065, 0.08, brakeMat, side * 0.76, 0.61, -2.28, 0, side * -0.08);
        mkBox(0.41, 0.12, 0.2, dark, side * 0.56, 0.39, -2.32);
      }

      // 扩散器、纵向鳍片、四出排气。
      mkBox(1.82, 0.055, 0.7, dark, 0, 0.25, -2.17, 0.12);
      for (const x of [-0.72, -0.4, 0, 0.4, 0.72]) {
        mkBox(0.035, 0.2, 0.66, dark, x, 0.31, -2.2, 0.12);
      }
      for (const x of [-0.54, -0.31, 0.31, 0.54]) {
        mkCyl(0.055, 0.2, exMat, x, 0.39, -2.38, 'z', 16, 0.065);
      }

      addWing(1.78, -2.0, 1.18, 0.46, 0.42, dark);
      mkBox(1.68, 0.045, 0.14, accentMat, 0, 1.175, -2.08, -0.08);
    } else if (s.id === 'muscle') {
      frontZ = 2.46;
      rearZ = -2.38;
      trailRearZ = -2.45;
      lampY = 0.68;
      lampX = 0.58;

      mkBox(1.94, 0.42, 4.62, paint, 0, 0.57, 0);
      mkSphere(0.98, 0.2, 1.75, paint, 0, 0.68, 0.45, 28);
      mkBox(1.82, 0.16, 1.86, paint, 0, 0.84, 1.25, -0.03);
      mkBox(0.82, 0.13, 1.35, paint, 0, 0.98, 1.12, -0.03);
      mkBox(0.32, 0.11, 0.96, dark, 0, 1.03, 1.08);
      mkBox(0.46, 0.05, 0.7, accentMat, 0, 1.095, 1.1);

      for (const side of [-1, 1]) {
        mkSphere(0.46, 0.28, 0.56, paint, side * 0.73, 0.54, 1.39, 20);
        mkSphere(0.47, 0.29, 0.58, paint, side * 0.73, 0.54, -1.38, 20);
        mkBox(0.06, 0.18, 3.25, dark, side * 0.975, 0.31, 0);
        mkBox(0.1, 0.055, 3.58, accentMat, side * 0.74, 0.85, 0.18);
      }

      mkBox(1.9, 0.34, 0.46, dark, 0, 0.56, 2.42, 0.06);
      mkBox(1.52, 0.07, 0.08, chrome, 0, 0.62, 2.66);
      for (const side of [-1, 1]) {
        mkCyl(0.145, 0.075, lampMat, side * 0.58, 0.69, 2.65, 'z', 24);
        mkBox(0.34, 0.06, 0.1, dark, side * 0.58, 0.45, 2.66);
      }

      mkBox(1.55, 0.46, 1.65, glass, 0, 1.08, -0.48);
      mkBox(1.45, 0.1, 1.55, paint, 0, 1.36, -0.5);
      mkBox(0.1, 0.5, 1.48, pillarMat, 0, 1.1, -0.48);
      mkBox(1.46, 0.08, 0.12, pillarMat, 0, 1.35, 0.27);
      addCockpit(false);
      addMirror(1, 0.98, 0.97, 0.15);
      addMirror(-1, 0.98, 0.97, 0.15);

      mkBox(1.92, 0.18, 0.56, paint, 0, 0.69, -2.32, 0.04);
      mkBox(1.72, 0.13, 0.12, dark, 0, 0.43, -2.53);
      for (const side of [-1, 1]) {
        for (const x of [-0.16, 0.16]) {
          mkBox(0.26, 0.13, 0.07, brakeMat, side * 0.54 + x, 0.69, -2.52);
        }
        mkCyl(0.078, 0.2, exMat, side * 0.52, 0.37, -2.55, 'z', 16, 0.09);
      }
      mkBox(1.55, 0.045, 0.34, dark, 0, 0.31, 2.53, -0.08);
    } else if (s.id === 'rally') {
      frontZ = 2.18;
      rearZ = -2.16;
      trailRearZ = -2.22;
      lampY = 0.68;
      lampX = 0.57;

      mkBox(1.84, 0.48, 4.12, paint, 0, 0.65, 0);
      mkSphere(0.91, 0.2, 1.88, paint, 0, 0.72, 0.06, 26);
      for (const side of [-1, 1]) {
        mkSphere(0.5, 0.33, 0.58, paint, side * 0.72, 0.57, 1.28, 22);
        mkSphere(0.5, 0.33, 0.58, paint, side * 0.72, 0.57, -1.28, 22);
        mkBox(0.09, 0.22, 2.9, dark, side * 0.94, 0.35, 0);
      }

      mkBox(1.66, 0.44, 1.74, glass, 0, 1.08, -0.22);
      mkBox(1.56, 0.1, 1.62, paint, 0, 1.36, -0.24);
      mkBox(0.085, 0.5, 1.66, pillarMat, 0, 1.1, -0.22);
      mkBox(1.56, 0.08, 0.12, pillarMat, 0, 1.35, 0.58);
      addCockpit(true);

      mkBox(1.46, 0.08, 1.22, paint, 0, 0.94, 1.2, -0.05);
      mkBox(0.48, 0.12, 0.58, dark, 0, 1.02, 1.15, -0.05);
      mkBox(0.36, 0.09, 0.42, accentMat, 0, 1.085, 1.17, -0.05);

      mkBox(1.8, 0.18, 0.5, dark, 0, 0.43, 2.14, 0.08);
      mkBox(1.52, 0.055, 0.38, dark, 0, 0.31, 2.35, -0.08);
      for (const side of [-1, 1]) {
        mkBox(0.42, 0.16, 0.08, lampMat, side * 0.56, 0.7, 2.24);
        mkCyl(0.13, 0.1, lampPodMat, side * 0.27, 0.78, 2.27, 'z', 20);
      }

      mkBox(1.78, 0.18, 0.5, dark, 0, 0.43, -2.12, -0.04);
      for (const side of [-1, 1]) {
        mkBox(0.43, 0.18, 0.08, brakeMat, side * 0.57, 0.69, -2.22);
      }
      mkCyl(0.33, 0.18, dark, 0, 0.88, -2.22, 'z', 24);
      mkCyl(0.2, 0.19, chrome, 0, 0.88, -2.31, 'z', 16);
      mkCyl(0.07, 0.2, dark, 0, 0.88, -2.34, 'z', 12);

      addWing(1.68, -1.94, 1.37, 0.35, 0.32, dark);
      mkBox(0.82, 0.075, 0.28, dark, 0, 1.44, -0.38);
      mkCyl(0.06, 0.22, exMat, 0.58, 0.41, -2.27, 'z', 14, 0.07);
    } else if (s.id === 'drift') {
      frontZ = 2.2;
      rearZ = -2.17;
      trailRearZ = -2.24;
      lampY = 0.63;
      lampX = 0.58;

      mkBox(1.88, 0.43, 4.2, paint, 0, 0.59, 0);
      mkSphere(0.94, 0.2, 1.95, paint, 0, 0.67, 0.05, 28);
      mkBox(1.62, 0.12, 1.42, paint, 0, 0.9, 1.14, -0.05);

      for (const side of [-1, 1]) {
        mkSphere(0.49, 0.29, 0.59, paint, side * 0.73, 0.52, 1.3, 22);
        mkSphere(0.51, 0.3, 0.6, paint, side * 0.73, 0.52, -1.3, 22);
        mkBox(0.1, 0.21, 3.05, dark, side * 0.95, 0.3, -0.02);
        mkBox(0.06, 0.08, 2.8, accentMat, side * 0.88, 0.76, -0.1);
        mkBox(0.09, 0.18, 0.68, dark, side * 0.9, 0.54, -0.72, 0.04);
      }

      mkBox(1.66, 0.43, 1.72, glass, 0, 1.07, -0.28);
      mkBox(1.55, 0.09, 1.58, paint, 0, 1.34, -0.3);
      mkBox(0.085, 0.5, 1.65, pillarMat, 0, 1.09, -0.27);
      addCockpit(true);
      addMirror(1, 0.94, 0.95, 0.17);
      addMirror(-1, 0.94, 0.95, 0.17);

      mkBox(1.84, 0.16, 0.46, dark, 0, 0.38, 2.18, 0.08);
      mkBox(1.6, 0.045, 0.42, dark, 0, 0.28, 2.37, -0.09);
      for (const side of [-1, 1]) {
        mkBox(0.48, 0.12, 0.08, lampMat, side * 0.57, 0.64, 2.26, -0.05, side * -0.05);
      }

      mkBox(1.82, 0.15, 0.5, dark, 0, 0.38, -2.13, -0.04);
      for (const side of [-1, 1]) {
        mkBox(0.5, 0.13, 0.08, brakeMat, side * 0.57, 0.64, -2.23, 0, side * -0.04);
      }
      addWing(1.76, -1.94, 1.34, 0.42, 0.45, dark);
      mkCyl(0.085, 0.22, exMat, 0.57, 0.4, -2.3, 'z', 16, 0.1);
    } else if (s.id === 'hatch') {
      frontZ = 2.05;
      rearZ = -2.04;
      trailRearZ = -2.1;
      lampY = 0.72;
      lampX = 0.57;

      mkBox(1.82, 0.46, 3.92, paint, 0, 0.62, 0);
      mkSphere(0.9, 0.2, 1.78, paint, 0, 0.69, 0.06, 26);

      for (const side of [-1, 1]) {
        mkSphere(0.47, 0.29, 0.56, paint, side * 0.7, 0.55, 1.19, 20);
        mkSphere(0.47, 0.29, 0.56, paint, side * 0.7, 0.55, -1.17, 20);
        mkBox(0.065, 0.18, 2.75, dark, side * 0.91, 0.32, 0);
      }

      mkBox(1.65, 0.44, 1.62, glass, 0, 1.06, -0.25);
      mkBox(1.55, 0.1, 1.5, paint, 0, 1.32, -0.28);
      mkBox(0.08, 0.49, 1.52, pillarMat, 0, 1.08, -0.28);
      mkBox(1.5, 0.08, 0.12, pillarMat, 0, 1.31, 0.46);
      addCockpit(false);
      addMirror(1, 0.92, 0.94, 0.2);
      addMirror(-1, 0.92, 0.94, 0.2);

      mkBox(1.56, 0.1, 1.08, paint, 0, 0.91, 1.33, -0.05);
      mkBox(1.76, 0.16, 0.45, dark, 0, 0.38, 2.03, 0.08);
      mkBox(1.48, 0.045, 0.35, dark, 0, 0.29, 2.22, -0.08);
      for (const side of [-1, 1]) {
        mkBox(0.42, 0.14, 0.08, lampMat, side * 0.55, 0.66, 2.13);
      }

      mkBox(1.62, 0.31, 0.68, glass, 0, 1.02, -1.8, 0.3);
      mkBox(1.7, 0.16, 0.5, paint, 0, 0.69, -1.99, -0.02);
      mkBox(1.7, 0.15, 0.4, dark, 0, 0.38, -2.04, -0.04);
      for (const side of [-1, 1]) {
        mkBox(0.38, 0.23, 0.08, brakeMat, side * 0.61, 0.74, -2.11, 0, side * -0.04);
      }

      mkBox(1.55, 0.055, 0.34, dark, 0, 1.3, -1.88, 0.1);
      mkBox(0.7, 0.045, 0.2, accentMat, 0, 1.34, -1.98, 0.1);
      mkCyl(0.065, 0.2, exMat, 0.52, 0.39, -2.17, 'z', 14, 0.075);
    }

    // 所有车型都保留独立灯体，尾灯局部位置也供拖尾逻辑使用。
    for (const side of [-1, 1]) {
      if (s.id !== 'gt') {
        mkBox(
          s.id === 'muscle' ? 0.42 : 0.5,
          s.id === 'hatch' ? 0.16 : 0.095,
          0.055,
          lampMat,
          side * lampX,
          lampY,
          frontZ
        );
      }
      mkBox(
        s.id === 'muscle' ? 0.48 : (s.id === 'gt' ? 0.28 : 0.54),
        s.id === 'hatch' ? 0.18 : (s.id === 'gt' ? 0.065 : 0.105),
        0.055,
        brakeMat,
        side * lampX,
        lampY,
        rearZ
      );
    }

    this.tailLightLocal = [
      new THREE.Vector3(lampX, lampY, trailRearZ),
      new THREE.Vector3(-lampX, lampY, trailRearZ)
    ];

    this.headLights = [];
    this.headTargets = [];
    const cookieTex = makeHeadlightCookie();
    // 光源对齐到可见大灯：GT 大灯在 (±0.55, 0.575, 2.355)，其他车型用 lampX/lampY/frontZ
    const hlX = s.id === 'gt' ? 0.55 : lampX;
    const hlY = s.id === 'gt' ? 0.575 : lampY;
    const hlZ = s.id === 'gt' ? 2.355 : frontZ;
    for (const side of [0.62, -0.62]) {
      const sl = new THREE.SpotLight(0xfff1c2, 0, 85, 0.58, 0.3, 0.5);
      sl.position.set(side * hlX, hlY, hlZ);
      sl.target.position.set(side * 1.5, -2.5, 15);
      sl.map = cookieTex;
      sl.castShadow = true;
      sl.shadow.mapSize.set(1024, 1024);
      sl.shadow.camera.near = 0.2;
      sl.shadow.camera.far = 90;
      sl.shadow.bias = -0.006;
      body.add(sl);
      scene.add(sl.target);
      this.headLights.push(sl);
      this.headTargets.push({
        light: sl,
        pos: new THREE.Vector3(),
        smooth: new THREE.Vector3(side * 1.5, -2.5, 15)
      });
    }
    // 内饰氛围灯：照亮仪表台 / 方向盘 / A 柱，白天弱、夜晚稍强
    // 范围/衰减收紧，避免灯光穿透车底照到地面形成"车底光团"
    this.interiorLight = new THREE.PointLight(0xffd9a8, 0.6, 1.4, 2.0);
    this.interiorLight.position.set(0.36, 0.85, 0.26);
    body.add(this.interiorLight);

    g.add(body);
    this.chassis = body;

    this.wheelMeshes = [];
    const tireMat = new THREE.MeshStandardMaterial({
      color: 0x111216,
      metalness: 0.05,
      roughness: 0.96
    });
    const rimColor =
      s.id === 'rally' ? 0xffd000 :
      s.id === 'drift' ? 0xf1f2f5 :
      s.id === 'muscle' ? 0x666970 :
      s.id === 'gt' ? 0xdfe3e8 :
      0xb8bdc5;
    const rimMat = new THREE.MeshStandardMaterial({
      color: rimColor,
      metalness: 0.92,
      roughness: 0.22
    });
    const hubMat = new THREE.MeshStandardMaterial({
      color: 0xd8dbe0,
      metalness: 0.88,
      roughness: 0.26
    });

    const spokeCount =
      s.id === 'gt' ? 10 :
      s.id === 'rally' ? 12 :
      s.id === 'drift' ? 6 :
      s.id === 'muscle' ? 5 :
      8;

    for (let i = 0; i < 4; i++) {
      const wg = new THREE.Group();
      const wp = this.wheelPos[i];
      const outerSign = wp.x >= 0 ? 1 : -1;

      const tire = new THREE.Mesh(
        new THREE.CylinderGeometry(this.wheelR, this.wheelR, 0.29, 36),
        tireMat
      );
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      tire.receiveShadow = true;
      wg.add(tire);

      const sidewallOuter = new THREE.Mesh(
        new THREE.TorusGeometry(this.wheelR * 0.79, this.wheelR * 0.18, 10, 36),
        tireMat
      );
      sidewallOuter.rotation.y = Math.PI / 2;
      sidewallOuter.position.x = 0.151 * outerSign;
      wg.add(sidewallOuter);

      const sidewallInner = sidewallOuter.clone();
      sidewallInner.position.x = -0.151 * outerSign;
      wg.add(sidewallInner);

      const rim = new THREE.Mesh(
        new THREE.CylinderGeometry(
          this.wheelR * 0.66,
          this.wheelR * 0.66,
          0.305,
          30
        ),
        rimMat
      );
      rim.rotation.z = Math.PI / 2;
      rim.castShadow = true;
      wg.add(rim);

      const rimLipOuter = new THREE.Mesh(
        new THREE.TorusGeometry(this.wheelR * 0.59, 0.025, 8, 32),
        chrome
      );
      rimLipOuter.rotation.y = Math.PI / 2;
      rimLipOuter.position.x = 0.165 * outerSign;
      wg.add(rimLipOuter);

      const rimLipInner = rimLipOuter.clone();
      rimLipInner.position.x = -0.165 * outerSign;
      wg.add(rimLipInner);

      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(
          this.wheelR * 0.47,
          this.wheelR * 0.47,
          0.07,
          28
        ),
        discMat
      );
      disc.rotation.z = Math.PI / 2;
      wg.add(disc);

      const discHub = new THREE.Mesh(
        new THREE.CylinderGeometry(
          this.wheelR * 0.18,
          this.wheelR * 0.18,
          0.24,
          18
        ),
        hubMat
      );
      discHub.rotation.z = Math.PI / 2;
      wg.add(discHub);

      for (let k = 0; k < spokeCount; k++) {
        const a = k / spokeCount * Math.PI * 2;
        const sp = new THREE.Mesh(
          new THREE.BoxGeometry(
            0.17,
            Math.max(0.045, this.wheelR * 0.1),
            Math.max(0.045, this.wheelR * 0.08)
          ),
          rimMat
        );
        sp.position.set(
          0.115 * outerSign,
          Math.cos(a) * this.wheelR * 0.28,
          Math.sin(a) * this.wheelR * 0.28
        );
        sp.rotation.x = a;
        wg.add(sp);
      }

      for (let k = 0; k < 5; k++) {
        const a = k / 5 * Math.PI * 2;
        const bolt = new THREE.Mesh(
          new THREE.CylinderGeometry(0.015, 0.015, 0.26, 8),
          dark
        );
        bolt.rotation.z = Math.PI / 2;
        bolt.position.set(
          0,
          Math.cos(a) * this.wheelR * 0.12,
          Math.sin(a) * this.wheelR * 0.12
        );
        wg.add(bolt);
      }

      const caliper = new THREE.Mesh(
        new THREE.BoxGeometry(0.09, this.wheelR * 0.32, this.wheelR * 0.18),
        caliperMat
      );
      caliper.position.set(0, 0, -this.wheelR * 0.38);
      wg.add(caliper);

      wg.position.set(wp.x, this.rest, wp.z);
      g.add(wg);
      this.wheelMeshes.push(wg);
    }

    this.visual = g;
    scene.add(g);
    window.__carStage = 'visual:ready';
  }

  // ---------------- 保时捷 918：真实 GLB 模型 ----------------
  buildP918Visual(scene) {
    // 外层组由 applyVisual 直接对齐车身位置/姿态；内层组承载模型居中偏移
    const root = new THREE.Group();
    const model = Porsche918Model.cloneForCar();
    // 模型世界轮心 y≈0.345、轴距中心 z≈2.2805、车体中心 x=-5；
    // 游戏静止时 cannon 轮心相对车身为 y≈-0.26，根节点按此偏移对齐。
    model.position.set(5, -0.29 - 0.345, -2.2805);
    root.add(model);
    this.visual = root;
    this.chassis = root;
    scene.add(root);

    // 轮子节点：cannon 世界变换（悬挂压缩 / 前轮转向 / 旋转）直接驱动
    const wheelNames = [
      'DEF-Wheel.Ft.L_320_631', 'DEF-Wheel.Ft.R_327_644',
      'DEF-Wheel.Bk.L_334_657', 'DEF-Wheel.Bk.R_341_670',
    ];
    this.wheelMeshes = [];
    this.wheelSpinNodes = [];
    this.rimMeshes = [];
    this.tireMeshes = [];
    for (const nm of wheelNames) {
      const want = nm.replace(/[.\s]/g, '');
      let found = null;
      model.traverse(o => { if (!found && (o.name || '').replace(/[.\s]/g, '') === want) found = o; });
      // 把轮子重新挂到车身根组：applyVisual 写入的是车身局部坐标
      if (found) root.attach(found);
      // 记录原模型轮子位置（车身局部），轮子刚性固定用，不再随悬挂移动
      if (found) found.userData.fixedPos = found.position.clone();
      this.wheelMeshes.push(found);
      if (found) {
        // 保存模型自带的基础姿态（含倾角/主销），转向只叠加在车身 Y 轴上
        found.userData.baseQuat = found.quaternion.clone();
        // 只在轮心（found 原点）放一个自转组；仅把“轮胎+轮毂”网格挂进去。
        // 卡钳/轴头/前杠等其它部件留在原地，只转向、绝不跟着转。
        const spin = new THREE.Group();
        spin.name = 'spin_' + this.wheelMeshes.length;
        spin.userData.baseQuat = spin.quaternion.clone();
        found.add(spin);
        const spinNames = new Set([
          'Object_950', 'Object_965', // 左前胎/毂
          'Object_969', 'Object_984', // 右前胎/毂
          'Object_988', 'Object_1003', // 左后胎/毂
          'Object_1007', 'Object_1022', // 右后胎/毂
        ]);
        const targets = [];
        found.traverse(o => { if (o.isMesh && spinNames.has(o.name)) targets.push(o); });
        // 轮子不再镜像后，模型自带的变换已让轮胎/轮毂几何中心位于轮心，
        // 直接挂进自转组即可，不再需要平移对中。
        for (const o of targets) spin.attach(o);
        // 静态件（卡钳/轴头/前杠等）收进“原点=轮心”的 static 组
        const staticGroup = new THREE.Group();
        staticGroup.name = 'static_' + this.wheelMeshes.length;
        found.add(staticGroup);
        const staticMeshes = [];
        found.traverse(o => { if (o.isMesh && !spinNames.has(o.name)) staticMeshes.push(o); });
        for (const o of staticMeshes) staticGroup.attach(o);
        // 记录轮毂基准横向位置（供“轮毂左右偏移”滑条微调）
        const rimNames = ['Object_965', 'Object_984', 'Object_1003', 'Object_1022'];
        const rimMesh = targets.find(o => o.name === rimNames[this.wheelMeshes.length - 1]);
        if (rimMesh) { rimMesh.userData.baseX = rimMesh.position.x; rimMesh.userData.baseSX = rimMesh.scale.x; }
        this.rimMeshes[this.wheelMeshes.length - 1] = rimMesh || null;
        // 记录轮胎基准横向位置（供“轮胎左右偏移”滑条微调）
        const tireNames = ['Object_950', 'Object_969', 'Object_988', 'Object_1007'];
        const tireMesh = targets.find(o => o.name === tireNames[this.wheelMeshes.length - 1]);
        if (tireMesh) { tireMesh.userData.baseX = tireMesh.position.x; tireMesh.userData.baseSX = tireMesh.scale.x; }
        this.tireMeshes[this.wheelMeshes.length - 1] = tireMesh || null;
        // 清掉被掏空的外壳节点（保留 found 和 spin）
        for (let pass = 0; pass < 3; pass++) {
          const empties = [];
          found.traverse(o => {
            if (o !== found && o !== spin && !o.isMesh && o.children.length === 0) empties.push(o);
          });
          if (!empties.length) break;
          for (const o of empties) if (o.parent) o.parent.remove(o);
        }
        this.wheelSpinNodes.push(spin);
      } else {
        this.wheelSpinNodes.push(null);
      }
    }

    // 尾灯：克隆整条红色灯带 + 底座材质，刹车/手刹时发光
    this.brakeMats = [];
    const paintFix = [];
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      let changed = false;
      const out = arr.map(m => {
        if (m && m.name === 'Tail_Light_Base') {
          // Object_934 = 灯带小发光片(点点)要亮；Object_931 = 底座整条,保持暗不发光,只让点点露出来
          const c = m.clone();
          const isDot = o.name === 'Object_934';
          c.color = new THREE.Color(isDot ? 0x9a0a10 : 0x1a0507);
          c.emissive = new THREE.Color(isDot ? 0xff1512 : 0x000000);
          c.emissiveIntensity = 0;
          c.metalness = 0.2;
          c.roughness = 0.35;
          if (isDot) this.brakeMats.push(c); // 只有发光点点受刹车/夜光控制
          changed = true;
          return c;
        }
        if (m && m.name === 'Window_Glass_Red') {
          // 红色尾灯玻璃：几乎全透明，不挡后面 LED 发光点点
          const c = m.clone();
          c.color = new THREE.Color(0x5a0a10);
          c.emissive = new THREE.Color(0x000000);
          c.emissiveIntensity = 0;
          c.metalness = 0.15;
          c.roughness = 0.4;
          c.transparent = true;
          c.opacity = 0.06;
          c.depthWrite = false;
          changed = true;
          return c;
        }
        if (m && m.name === 'Body_Paint_-_GT_Silver_Metalic') {
          // 深色金属漆：F8 优化模式有环境贴图，纯金属漆 + 深底色才有真实反光层次
          const c = m.clone();
          c.color = new THREE.Color(0x1f2329);
          c.metalness = 1.0;
          c.roughness = 0.28;
          paintFix.push(c);
          changed = true;
          return c;
        }
        return m;
      });
      if (changed) o.material = Array.isArray(o.material) ? out : out[0];
    });
    this.brakeMat = this.brakeMats[0] || new THREE.MeshStandardMaterial({ color: 0xff1028 });

    // 尾灯拖尾发射点：从灯带(Object_934)几何里自动聚类出所有小发光片，每个发一条拖尾
    this.tailLightLocal = [];
    this.tailLightWidths = [];
    this.tailLightGains = [];
    {
      root.updateMatrixWorld(true);
      const grid = new Map();
      const v = new THREE.Vector3();
      root.traverse(o => {
        if (!o.isMesh || o.name !== 'Object_934') return;
        const pos = o.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          o.localToWorld(v); // root 此刻在原点、无旋转 → 车身局部坐标
          const kx = Math.round(v.x * 30), ky = Math.round(v.y * 30), kz = Math.round(v.z * 30);
          const key = kx + ',' + ky + ',' + kz;
          if (!grid.has(key)) grid.set(key, [0, 0, 0, 0]);
          const g = grid.get(key);
          g[0] += v.x; g[1] += v.y; g[2] += v.z; g[3]++;
        }
      });
      const cells = [];
      for (const g of grid.values()) if (g[3] >= 3) cells.push([g[0] / g[3], g[1] / g[3], g[2] / g[3], g[3]]);
      const pieces = [];
      const used = new Set();
      for (let i = 0; i < cells.length; i++) {
        if (used.has(i)) continue;
        used.add(i);
        let sx = cells[i][0], sy = cells[i][1], sz = cells[i][2], sn = cells[i][3];
        for (let j = i + 1; j < cells.length; j++) {
          if (used.has(j)) continue;
          if (Math.hypot(cells[j][0] - sx, cells[j][1] - sy, cells[j][2] - sz) < 0.030) {
            sx = (sx * sn + cells[j][0] * cells[j][3]) / (sn + cells[j][3]);
            sy = (sy * sn + cells[j][1] * cells[j][3]) / (sn + cells[j][3]);
            sz = (sz * sn + cells[j][2] * cells[j][3]) / (sn + cells[j][3]);
            sn += cells[j][3];
            used.add(j);
          }
        }
        pieces.push([sx, sy, sz]);
      }
      pieces.sort((a, b) => a[0] - b[0]);
      for (const p of pieces) {
        this.tailLightLocal.push(new THREE.Vector3(p[0], p[1] + 0.5, p[2] + 0.10));
        this.tailLightWidths.push(0.04);
        // 靠近尾灯中心(|x|≈0.615)的 led 小光带拖尾关掉，越靠边越实
        const dCenter = Math.abs(Math.abs(p[0]) - 0.615);
        this.tailLightGains.push(clamp(dCenter / 0.15, 0, 1));
      }
    }

    // 前车灯：两盏扇形近光（cookie 倒三角光斑：近车窄、向前展开），照亮前方路面
    this.headLights = [];
    this.headTargets = [];
    root.updateMatrixWorld(true);
    const headCookie = makeHeadlightCookie();
    const hlPts = [];
    model.traverse(o => {
      if (/Headlight_glass/i.test(o.name || '')) {
        const v = new THREE.Vector3();
        o.getWorldPosition(v);
        hlPts.push(v.clone());
      }
    });
    // 玻璃节点在模型里多为单侧/居中，取世界 Y/Z 精确定位，X 用标准大灯间距
    const hlY = hlPts.length ? hlPts.reduce((s, p) => s + p.y, 0) / hlPts.length : 0.62;
    const hlZ = hlPts.length ? Math.max(...hlPts.map(p => p.z)) : 2.30;
    const hlX = 0.55;
    for (const side of [hlX, -hlX]) {
      const sl = new THREE.SpotLight(0xfff1c2, 0, 90, 0.62, 0.32, 0.5);
      sl.position.set(side, hlY, hlZ);
      sl.target.position.set(side * 2.4, -2.0, hlZ + 14);
      sl.map = headCookie;
      sl.castShadow = false;
      root.add(sl);
      scene.add(sl.target); // target 在世界空间，配合 headTargets 每帧按世界坐标定位
      this.headLights.push(sl);
      this.headTargets.push({
        light: sl,
        pos: new THREE.Vector3(),
        smooth: new THREE.Vector3(side * 2.4, -2.0, hlZ + 14),
      });
    }

    // 内饰氛围灯：照亮左舵驾驶位（范围/衰减收紧，避免穿透车底照到地面）
    this.interiorLight = new THREE.PointLight(0xffd9a8, 0.6, 1.4, 2.0);
    this.interiorLight.position.set(-0.30, 0.10, 0.45);
    root.add(this.interiorLight);

    // 环境反光强度：F8 优化模式靠环境贴图出金属反光，这里给足强度（经典模式无贴图时影响很小）
    root.traverse(o => {
      if (!o.isMesh || !o.material) return;
      const arr = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of arr) {
        if (m && m.isMeshStandardMaterial && 'envMapIntensity' in m) m.envMapIntensity = 0.9;
      }
    });

    // 方向盘总成：轮圈/辐条/饰条等所有 Steering* 节点一起转
    // （GLB 里这些是 12 个平级节点：trim / wheel.001~009 / wheel / stitching）
    this.steerWheels = this.steerWheels || [];
    const steerCandidates = [];
    root.traverse(o => {
      const raw = String(o.name || '');
      const n = raw.replace(/[.\s]/g, '');
      if (/^Steering/i.test(n) || /steering/i.test(raw)) steerCandidates.push(o);
    });
    // 父节点也是候选时只保留最外层，避免双重旋转
    const tops = steerCandidates.filter(o =>
      !steerCandidates.some(p => o !== p && p.children && p.children.indexOf(o) !== -1)
    );
    for (const node of tops) {
      node.updateWorldMatrix(true, true);
      let rimMesh = null;
      node.traverse(o => { if (!rimMesh && o.isMesh) rimMesh = o; });
      const axisLocal = new THREE.Vector3(0, 0, 1);
      if (rimMesh && rimMesh.geometry && rimMesh.geometry.attributes.position) {
        const b = new THREE.Box3().setFromObject(rimMesh);
        const sz = b.getSize(new THREE.Vector3());
        const thinWorld = new THREE.Vector3(1, 0, 0);
        if (sz.y < sz.x && sz.y < sz.z) thinWorld.set(0, 1, 0);
        else if (sz.z < sz.x && sz.z < sz.y) thinWorld.set(0, 0, 1);
        const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
        axisLocal.copy(thinWorld).transformDirection(inv).normalize();
      }
      this.steerWheels.push({ node, axis: axisLocal, base: node.quaternion.clone() });
    }

    // 918 主动尾翼：80km/h 支架升尾翼，120km/h 尾翼再微微抬角度（平滑过渡）
    let wingGroup = null, strutGroup = null;
    root.traverse(o => {
      const n = (o.name || '').replace(/[.\s]/g, '');
      if (!wingGroup && n === 'Spoiler_269_545') wingGroup = o;
      if (!strutGroup && n === 'Spoiler_detail_271_549') strutGroup = o;
    });
    this.wingRig = null;
    if (wingGroup && strutGroup) {
      const rig = new THREE.Group();
      rig.name = 'wingRig';
      root.add(rig);
      rig.attach(wingGroup);
      rig.attach(strutGroup);
      rig.updateWorldMatrix(true, true);
      this.wingRig = rig;
      this.wingRigBaseY = rig.position.y;
      this.wingGroup = wingGroup;
      this.wingBaseQ = wingGroup.quaternion.clone();
      this.wingAxis = new THREE.Vector3(1, 0, 0);
      this.wingRise = 0;
      this.wingTilt = 0;
      this._wingLastT = 0;
    }

    window.__carStage = 'visual:ready';
  }

  setLights(on) {
    const k = typeof on === 'number' ? clamp(on, 0, 1) : (on ? 1 : 0);
    const p = k * 15;
    if (this.headLights) for (const l of this.headLights) l.intensity = p;
    if (this.interiorLight) this.interiorLight.intensity = 0.4 + k * 0.8;
  }

  reset(pos, yaw) {
    const b = this.body;
    const y = pos.y + this.COM_OFFSET;
    b.position.set(pos.x, y, pos.z);
    b.velocity.setZero();
    b.angularVelocity.setZero();
    b.quaternion.setFromEuler(0, yaw, 0);
    this.vehicle.setSteeringValue(0, 0);
    this.vehicle.setSteeringValue(0, 1);
    this.vehicle.setSteeringValue(0, 2);
    this.vehicle.setSteeringValue(0, 3);
    for (let i = 0; i < 4; i++) {
      const w = this.vehicle.wheelInfos[i];
      w.rotation = 0; w.deltaRotation = 0;
      w.engineForce = 0; w.brake = 0;
      w.suspensionLength = w.suspensionRestLength;
    }
    this.pos.set(pos.x, y, pos.z);
    this.groundY = pos.y;
    this.vel.set(0, 0, 0);
    this.speed = 0;
    this.yaw = yaw;
    this.yawRate = 0;
    this.bodyVy = 0;
    this.steer = 0;
    this.engineRpm = 1000;
    this.gear = 1;
    this.shiftTimer = 0;
    this.driftScore = 0;
    this.driftMult = 1;
    this.airTime = 0;
    this.airborne = false;
    this.applyVisual();
  }

  setVelocity(v) {
    this.body.velocity.set(v.x, v.y, v.z);
  }

  displace(dx, dz) {
    this.body.position.x += dx;
    this.body.position.z += dz;
  }

  applyImpact(nx, nz, vn, bounce) {
    this.body.velocity.x -= nx * vn * bounce;
    this.body.velocity.z -= nz * vn * bounce;
  }

  scaleHorizontalVelocity(k) {
    this.body.velocity.x *= k;
    this.body.velocity.z *= k;
  }

  get speedKmh() { return this.speed * 3.6; }

  wheelWorldPos(i) {
    const wt = this.vehicle.wheelInfos[i].worldTransform;
    return new THREE.Vector3(wt.position.x, wt.position.y, wt.position.z);
  }

  resetToNearestRoad() {
    const w = this.world;
    const nr = w.nearestRoad(this.pos.x, this.pos.z);
    if (!nr) {
      const h = w.terrainHeight(0, 0);
      this.reset(new THREE.Vector3(0, h, 0), 0);
      return;
    }
    const route = w.trafficRoutes.find(r => r.id === nr.s.road);
    const arr = route.samples;
    let i = arr.indexOf(nr.s);
    if (i < 0) i = Math.floor(nr.d / 4);
    const nxt = arr[Math.min(i + 1, arr.length - 1)] || arr[Math.max(0, i - 1)];
    const yaw = Math.atan2(nxt.x - nr.s.x, nxt.z - nr.s.z);
    this.reset(new THREE.Vector3(nr.s.x, nr.s.h, nr.s.z), yaw);
  }

  // ---------------- 主更新 ----------------
  update(dt, world) {
    const inp = this.input;
    const s = this.spec;
    const vehicle = this.vehicle;
    const bp = this.body.position;
    const T = P918_TUNE;
    const p918 = s.id === 'p918';
    if (p918) return this.updateP918(dt, world);

    // 转向（带速度感应）
    // 漂移/侧滑时大幅增强转向与响应速度，反打方向能迅速把车拉回来；
    // 手刹漂移一开始就给足转向响应，而不是等侧滑大到失控才介入；
    // 越野路面也放宽转向（草地抓地低、容易推头，需要更大的前轮角度）
    const surfC = world.getSurface(bp.x, bp.z, bp.y);
    const offRoad = !surfC.road;
    // 硬刹车过弯：S+AD 走“极致制动”路线——全轮强刹、稳定压弯，不进入漂移逻辑
    const brakingHard = inp.brake > 0.3 && inp.throttle === 0 && !inp.handbrake;
    const slipRear = Math.abs(this.slipAngleR);
    const sliding = (slipRear > 0.35 && this.speed > 8) || (inp.handbrake && this.speed > 10);
    const baseSteer = p918
      ? 0.62 * clamp(1.18 - this.speed / 58, 0.30, 1.08) * T.steerMax
      : (offRoad
        ? 0.58 * clamp(1.18 - this.speed / 55, 0.2, 1.12) + 0.04
        : 0.56 * clamp(1.08 - this.speed / 48, 0.16, 1.08) + 0.03);
    // 反打增益随漂移角度连续变化：角度小轻修、角度大猛打（最高 ~2.6×），
    // “小角反打减弱”滑条控制小角度端的起点：调大后小漂移角时反打保持很弱
    const smallStart = 0.10 + clamp(TUNING.smallAngle, 0, 1) * 0.45;
    const counterBoost = p918
      ? 1
      : (1 + clamp((slipRear - smallStart) / 0.45, 0, 1) * 1.6) * clamp(TUNING.counter, 0.4, 2);
    // 硬刹车时禁用漂移转向增益：车头贴线、不会越打越甩
    const steerBoost = p918 ? 1 : ((sliding && !brakingHard) ? counterBoost : (offRoad ? 1.42 : 1));
    // 方向盘物理极限 ~60°，增益再大也只到满锁
    const maxSteer = Math.min(baseSteer * steerBoost, 1.05);
    const steerTarget = inp.steer * maxSteer;
    const steerRate = p918
      ? Math.min(7.2 * T.steerK, 16)
      : Math.min(sliding ? (3.4 + counterBoost * 2.6) : (offRoad ? 5.0 : 3.2), 10);
    this.steer += clamp(steerTarget - this.steer, -steerRate * dt, steerRate * dt);
    vehicle.setSteeringValue(this.steer, 0);
    vehicle.setSteeringValue(this.steer, 1);
    if (p918) {
      // 918 后轮转向：低速反向（缩小转弯半径）、高速同向（稳定）。
      // 反向相位用 -this.steer，与“正转向=正横摆”的既有约定一致。
      const spdKmh = this.speed * 3.6;
      const rearPhase = spdKmh < 55 ? -1 : 1;
      const rearK = spdKmh < 55
        ? lerp(0.18, 0.03, clamp(spdKmh / 55, 0, 1))
        : lerp(0.03, 0.09, clamp((spdKmh - 55) / 140, 0, 1));
      const rearSteer = this.steer * rearK * rearPhase * T.steerMax;
      vehicle.setSteeringValue(rearSteer, 2);
      vehicle.setSteeringValue(rearSteer, 3);
    }

    // 每个轮子根据路面设置抓地系数（frictionSlip 即摩擦系数）
    for (let i = 0; i < 4; i++) {
      const wt = vehicle.wheelInfos[i].worldTransform;
      const surf = world.getSurface(wt.position.x, wt.position.z, wt.position.y);
      let slip = (surf.road ? 1.55 : 1.32) * surf.muMul * surf.grip * (s.grip || 1);
      if (p918) {
        const w = vehicle.wheelInfos[i];
        // 918 控制面板：悬挂刚度 / 阻尼 / 侧倾抑制实时生效（平滑过渡防突变）
        w.suspensionStiffness = lerp(w.suspensionStiffness, 52 * T.suspStiff, Math.min(1, dt * 8));
        w.dampingCompression = lerp(w.dampingCompression, 6.8 * T.dampComp, Math.min(1, dt * 8));
        w.dampingRelaxation = lerp(w.dampingRelaxation, 4.6 * T.dampRelax, Math.min(1, dt * 8));
        w.maxSuspensionForce = 120000;
        w.rollInfluence = 0.03 * T.rollK;
        slip *= T.gripK;
        // 918 更强的基础抓地（半热熔胎级别 + 四驱贴地感）
        slip *= 1.12;
      }
      // 极致下压力：高速时空气动力学压地，额外抓地，大幅转向不甩尾
      if (this.spec.downforce && this.speed > 15) {
        slip *= 1 + this.spec.downforce * clamp((this.speed - 15) / 55, 0, 1) * 0.5;
      }
      // 刹车压弯稳定：硬刹车时全轮抓地提升（稳定型/下压力车更强），
      // 重刹过弯不再甩尾失控，而是贴着转向线极限减速
      if (brakingHard && this.speed > 3) {
        slip *= 1 + inp.brake * (this.spec.grip >= 1 ? 0.55 : 0.35);
      }
      // 低速手刹：后轮锁死失去抓地（起漂/原地掉头）；
      // 6→14 m/s 渐进释放锁止，高速手刹靠反打控车
      if (i >= 2 && inp.handbrake) {
        const gripK = clamp(TUNING.rearGrip, 0.4, 1.6);
        slip *= (this.speed < 6 ? 0.18 : (this.speed < 14 ? 0.18 + (this.speed - 6) / 8 * 0.34 : 0.52)) * gripK;
      }
      // 以下漂移特性只作用于“漂移型”车（grip < 1.0），下压力/稳定型车完全不受影响
      const driftType = (s.grip || 1) < 1.0 || this.aiDrift;
      if (driftType) {
        // 动力漂移：滑起来后持续给油，后轮保持打滑（大马力后驱特性），
        // 让漂移可以连续维持（正打给油会一直转下去）
        if (i >= 2 && !inp.handbrake && inp.throttle > 0 && Math.abs(this.slipAngleR) > 0.15) {
          slip *= 0.62;
        }
        // 漂移辅助（摩擦式）：高速转弯时，按“横向加速度需求”降低后轮摩擦，
        // 转弯即起漂；侧滑角接近 0.28 后回补抓地，漂移自稳定（不振荡）
        if (i >= 2 && !inp.handbrake && !this.driftAssistOff && this.speed > 6) {
          const lat = Math.abs(this.yawRate) * this.speed; // 横向加速度需求 (m/s²)
          if (lat > 2.8) {
            const driftF = clamp(1.25 - lat * 0.18, 0.42, 1);
            const slipK = clamp(1 - Math.max(0, Math.abs(this.slipAngleR) - 0.28) * 1.4, 0.6, 1);
            slip *= driftF * slipK;
          }
        }
      }
      vehicle.wheelInfos[i].frictionSlip = clamp(slip, 0.18, p918 ? 3.4 : 2.0);
    }

    // 驱动 / 制动
    const reversing = this.gear === 0;
    const revDrive = reversing && inp.brake > 0 && inp.throttle === 0;
    const gr = reversing ? this.revRatio : (this.gear > 0 ? s.gears[this.gear - 1] : 0);
    const tqShape = torqueShape(this.engineRpm);
    // 918 混动：电机在低转提供即时扭矩，整条曲线更饱满（低转不“肉”）
    const tqFac = p918 ? (0.68 + 0.32 * tqShape) : tqShape;
    const torque = revDrive
      ? s.torque * tqFac * 0.85 * (p918 ? T.torqueK : 1)
      : (gr > 0 ? s.torque * tqFac * inp.throttle * (p918 ? T.torqueK : 1) : 0);
    const driveForce = gr > 0 ? torque * gr * s.fd / this.wheelR * 0.88 : 0;
    let driven = [];
    if (s.drive === 'FWD') driven = [0, 1];
    else if (s.drive === 'RWD') driven = [2, 3];
    else driven = [0, 1, 2, 3];
    const maxTraction = this.mass * 9.81 * (p918 ? 1.55 : 1.3) / driven.length;
    // 红线断油：到红线后不再输出动力，形成自然极速
    const rpmCut = clamp((s.redline - this.engineRpm) / 700, 0, 1);
    // 倒挡限速（约 40 km/h）
    const revCut = reversing ? clamp(1 - Math.max(0, this.speed - 7) / 4, 0, 1) : 1;
    // 918 前后扭矩分配：后轴为主（V8+后电机），转向时略微前移帮助车头入弯
    const frontShare = p918
      ? clamp(0.32 + clamp(Math.abs(this.steer), 0, 1) * 0.08, 0.22, 0.5)
      : 0.5;
    for (let i = 0; i < 4; i++) {
      // cannon 的驱动力方向固定为 up × 轮轴(局部+x) = -z（相对车头）；
      // 前进取负号，倒挡取正号
      const sign = reversing ? 1 : -1;
      if (!((!reversing || revDrive) && driven.includes(i))) {
        vehicle.applyEngineForce(0, i);
        continue;
      }
      let perWheel = Math.min(driveForce / driven.length, maxTraction) * rpmCut * revCut;
      if (p918 && !reversing) {
        // 前两轮各占 frontShare/2，后两轮各占 (1-frontShare)/2
        const share = (i < 2 ? frontShare : (1 - frontShare)) / 2;
        perWheel = Math.min(driveForce * share, maxTraction) * rpmCut * revCut;
      }
      vehicle.applyEngineForce(sign * perWheel, i);
    }
    // 松开刹车即重置渐进，下一次重刹重新渐进建立
    if (inp.brake === 0) this.brakeRamp = 0;
    if (inp.handbrake) {
      // 低速大制动力锁死后轮起漂，6→14 m/s 渐进减小，高速保持可控甩尾
      // 给油时手刹锁止略松，车速不掉，漂移能持续
      const hb = this.mass * (this.speed < 14 ? (60 - Math.max(0, this.speed - 6) / 8 * 40) : 10) / 60
        * clamp(TUNING.handbrake, 0.4, 1.6) * (inp.throttle > 0 ? 0.7 : 1);
      vehicle.setBrake(hb, 2); vehicle.setBrake(hb, 3);
      vehicle.setBrake(0, 0);  vehicle.setBrake(0, 1);
    } else if (reversing) {
      // 倒挡：S 即倒车油门；不施加任何自动刹停/驻车（坡上不会被锁死）
      for (let i = 0; i < 4; i++) vehicle.setBrake(0, i);
    } else if (inp.brake > 0) {
      // 高性能刹车片：制动总量 = 原版 × 2（前 62% / 后 38%），
      // 保留原版高速衰减曲线——重刹既给力又不至于把车头压翻
      const spdK = clamp(1.22 - this.speed * 0.011, 0.55, 1.15);
      // 制动力在 ~0.18s 内渐进到满值（刹车片咬合过程）
      this.brakeRamp = Math.min(1, this.brakeRamp + dt * 5.5);
      const bF = this.mass * (p918 ? 24 : 22) / 60 * spdK * this.brakeRamp * (p918 ? T.brakeF : 1);
      const bR = this.mass * (p918 ? 11.2 : 13.2) / 60 * spdK * this.brakeRamp * (p918 ? T.brakeR : 1);
      vehicle.setBrake(bF, 0); vehicle.setBrake(bF, 1);
      vehicle.setBrake(bR, 2); vehicle.setBrake(bR, 3);
    } else {
      this.brakeRamp = 0;
      for (let i = 0; i < 4; i++) vehicle.setBrake(0, i);
    }

    // 真·空气下压力：速度² 比例向下压车身（GT 等大尾翼车型 1.0，
    // 其它车也有基础 0.45 的空气下压力，保证重刹不翘头）。
    // 注意：游戏用 1/120 双子步调用 update，而 cannon 累加到 1/60 才真正步进一次，
    // applyForce 是累加型力——必须按 dt*60 折算，保证每个物理步恰好施加一次，
    // 否则下压力翻倍，起伏路面会把车压得一顿一顿开不动。
    // 正常驾驶：dfK = min(1, dt*60)，与任何帧率下的原版完全一致；
    // 仅慢动作激活时反比补偿（小步长每帧积分，力需放大）
    const dfK = this.world && this.world.physics && this.world.physics.slowmo
      ? Math.min(20, 1 / Math.max(1e-4, dt * 60))
      : Math.min(1, dt * 60);
    const dfBase = this.spec.downforce || 0.45;
    if (this.grounded && this.speed > 6) {
      const t = clamp((this.speed - 6) / 50, 0, 1);
      const F = this.mass * 9.81 * dfBase * (0.35 + 0.85 * t) * dfK * (p918 ? T.downforceK : 1);
      this.body.applyForce(new CANNON.Vec3(0, -F, 0));
    }
    // 制动防点头：刹车时在车尾施加向下力（屁股下压），抵消车头下沉、防止车尾翘起
    const brakeTotal = vehicle.wheelInfos[0].brake + vehicle.wheelInfos[1].brake
      + vehicle.wheelInfos[2].brake + vehicle.wheelInfos[3].brake;
    if (brakeTotal > 8 && this.grounded && this.speed > 1.5) {
      const Fb = brakeTotal * (this.COM_OFFSET / (this.wheelbase * 0.5)) * 1.6 * dfK;
      this.body.applyForce(new CANNON.Vec3(0, -Fb, 0), new CANNON.Vec3(0, 0.05, -this.wheelbase * 0.55));
    }
    // 物理步进
    world.physics.step(dt);

    // 低速自转抑制（稳定性）：只衰减横摆，不再锁线速度——
    // 坡上松油/挂倒挡时车可以自然溜动，不会被“自动驻车”钉死
    if (inp.throttle === 0 && this.gear !== 0 && !inp.handbrake && this.grounded && this.speed < 3) {
      this.body.angularVelocity.y *= Math.max(0, 1 - 5 * dt);
    }

    // 稳定性：手刹漂移不自动收油、不自动回正，反打由玩家控制；
    // 只保留上限保护，防止转速太高反打拉不回来
    // 上限放宽：正打方向（顺着漂移打）时允许持续转下去，不夹住
    const yawLim = 1.7 + this.speed * 0.06;
    // 正打方向：顺着当前旋转打，漂移应持续转下去
    const steeringInto = inp.steer * this.yawRate > 0.1;
    if (brakingHard && this.speed > 4) {
      if (p918) {
        // 918 循迹刹车：强阻尼 + 朝向转向方向的受控横摆，
        // 刹车+转向一起按时车头收线（半径更小）且不会甩飞
        const targetYaw = inp.steer * Math.min(1.05, 0.18 + this.speed * 0.014);
        this.body.angularVelocity.y *= Math.max(0, 1 - dt * (6 + inp.brake * 5));
        this.body.angularVelocity.y += (targetYaw - this.body.angularVelocity.y) * Math.min(1, dt * 3);
        this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -1.25, 1.25);
      } else {
        // 刹车压弯稳定：抑制横摆、收紧转速上限，极致减速不失控
        this.body.angularVelocity.y *= Math.max(0, 1 - dt * (2.0 + inp.brake * 2.8));
        const yawCapB = 0.9 + this.speed * 0.05;
        this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -yawCapB, yawCapB);
      }
    } else if (inp.handbrake) {
      // 漂移强度滑条：调高 = 允许转得更快更野；
      // 正打时放宽上限不夹住旋转，反打时维持正常上限便于控制
      const hbLim = ((steeringInto ? 3.0 : 1.6) + this.speed * 0.03) * clamp(TUNING.drift, 0.5, 1.7);
      this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -hbLim, hbLim);
    } else {
      this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -yawLim, yawLim);
    }
    // 俯仰/侧倾阻尼：稳定车身，避免急刹点头弹起后轮；起跳后不空中乱翻
    if (this.grounded) {
      const pitchDamp = p918 ? 12 : 7;
      this.body.angularVelocity.x *= Math.max(0, 1 - pitchDamp * dt);
      this.body.angularVelocity.z *= Math.max(0, 1 - (p918 ? 4.2 : 3.2) * dt);
      this.body.angularVelocity.x = clamp(this.body.angularVelocity.x, -1.9, 1.9);
      this.body.angularVelocity.z = clamp(this.body.angularVelocity.z, -2.2, 2.2);
    } else if (this.airborne) {
      this.body.angularVelocity.x *= Math.max(0, 1 - 2.4 * dt);
      this.body.angularVelocity.z *= Math.max(0, 1 - 2.4 * dt);
      this.body.angularVelocity.y *= Math.max(0, 1 - 1.5 * dt);
      this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -1.5, 1.5);
    }

    // ---- 同步镜像数据 ----
    this.pos.set(bp.x, bp.y, bp.z);
    const bv = this.body.velocity;
    this.vel.set(bv.x, bv.y, bv.z);
    this.bodyVy = bv.y;
    const q = this.body.quaternion;
    const fx = 2 * (q.x * q.z + q.y * q.w);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    this.yaw = Math.atan2(fx, fz);
    this.yawRate = this.body.angularVelocity.y;
    this.speed = Math.hypot(bv.x, bv.z);
    this.maxSpeedSeen = Math.max(this.maxSpeedSeen, this.speedKmh);

    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    const vLx = bv.x * cosY - bv.z * sinY;
    const vLz = bv.x * sinY + bv.z * cosY;
    this.vFwd = vLz; // 车头方向速度：倒挡时为负，用于胎痕/起烟判定
    const fwdSpeed = Math.abs(vLz) > 1 ? vLz : 0;
    const slipLat = Math.atan2(vLx, Math.max(2.5, Math.abs(fwdSpeed)) * Math.sign(fwdSpeed || 1));
    this.slipAngleR = slipLat;
    this.slipAngleF = slipLat - this.steer;

    // 接地状态（含飞跃慢动作的起飞/落地标记，不加落地缓冲）
    const wasGrounded = this.grounded;
    this.grounded = this.vehicle.numWheelsOnGround > 0;
    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.12) {
        this.landing = true;
        this.landingT = 0.5;
        this.jumpDist = Math.hypot(this.pos.x - this.jumpStartX, this.pos.z - this.jumpStartZ);
      }
      if (this.landing) {
        this.landingT -= dt;
        if (this.landingT <= 0) this.landing = false;
      }
      this.airTime = 0;
      this.airborne = false;
      let sum = 0, cnt = 0;
      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheelInfos[i];
        if (w.isInContact || w.raycastResult.body) {
          sum += w.worldTransform.position.y;
          cnt++;
        }
      }
      if (cnt > 0) this.groundY = lerp(this.groundY, sum / cnt, 0.5);
    } else {
      if (wasGrounded) {
        this.jumpVy = Math.max(0, -this.body.velocity.y);
        this.jumpGroundY = this.world ? this.world.terrainHeight(this.pos.x, this.pos.z) : this.pos.y;
        this.jumpStartX = this.pos.x;
        this.jumpStartZ = this.pos.z;
        this.jumpDist = 0;
      }
      this.airTime += dt;
      this.airborne = this.airTime > 0.12;
      // 抛物线落点预测：用当前位置/速度 + 重力逐帧积分，
      // 沿轨迹采样前方地形高度直到碰到地面，得到真实滞空时间与落点。
      // 不再假设落地高度等于起飞点高度（跳崖/下坡时地面在变化）。
      const g = CFG.grav;
      const clear = Math.max(0.45, this.pos.y - this.jumpGroundY);
      const step = 1 / 30;
      let vx = this.body.velocity.x, vy = this.body.velocity.y, vz = this.body.velocity.z;
      let cx = this.pos.x, cy = this.pos.y, cz = this.pos.z;
      let tPred = this.airTime;
      for (let t = 0; t < 24 && vy > -250; t += step) {
        vy -= g * step;
        const damp = 1 - 0.025 * step; // cannon 线性阻尼
        vx *= damp; vy *= damp; vz *= damp;
        cx += vx * step; cy += vy * step; cz += vz * step;
        tPred += step;
        const ground = this.world ? this.world.terrainHeight(cx, cz) : this.jumpGroundY;
        if (cy - clear <= ground) break;
      }
      this.jumpPredicted = tPred;
      this.jumpPredLandX = cx;
      this.jumpPredLandZ = cz;
    }

    // 发动机与变速箱
    const wheelRpm = Math.abs(vLz) / (TAU * this.wheelR) * 60;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      this.engineRpm = Math.max(1000, this.engineRpm - 5200 * dt);
    } else {
      const targetRpm = this.gear > 0 ? wheelRpm * gr * s.fd
        : (reversing ? Math.max(900, wheelRpm * this.revRatio * s.fd * 0.9) : 950);
      const rpmRate = 1500 + Math.abs(targetRpm - this.engineRpm) * 1.6;
      this.engineRpm += clamp(targetRpm - this.engineRpm, -rpmRate * dt, rpmRate * dt);
      if (this.speed < 1.5 && this.gear > 0) this.engineRpm = Math.max(this.engineRpm, 950 + inp.throttle * 1400);
    }
    if (reversing) this.engineRpm = Math.min(this.engineRpm, 4300);
    if (this.engineRpm > s.redline) this.engineRpm = s.redline;
    // 低速手刹锁死后轮时发动机自由空转（烧胎/起漂有转速有声浪）
    if (inp.handbrake && this.speed < 6 && !reversing) {
      this.engineRpm = Math.max(this.engineRpm, 1500 + inp.throttle * 2600);
    }
    if (this.autoShift && this.shiftTimer <= 0) {
      if (this.gear === 0) {
        // 倒挡：按 W（想前进）立即回前进挡（不要求先停稳，坡上后溜也能切回）
        if (inp.throttle > 0) this.doShift(1);
        else if (inp.throttle === 0 && inp.brake === 0 && this.speed < 0.5) this.doShift(1);
      } else if (this.gear === 1) {
        // 停住踩刹车 → 进倒挡
        if (inp.brake > 0 && inp.throttle === 0 && this.speed < 1.2) this.doShift(-1);
        else if (this.engineRpm > s.redline * 0.86 && this.gear < s.gears.length) this.doShift(1);
        else if (this.engineRpm < 2150 && this.gear > 1 && this.speed > 3) this.doShift(-1);
      } else {
        // 刹停后逐挡降回 D1，避免卡在 D3 进不了倒挡
        if (this.speed < 2.5 && this.gear > 1) this.doShift(-1);
        else if (this.engineRpm > s.redline * 0.86 && this.gear < s.gears.length) this.doShift(1);
        else if (this.engineRpm < 2150 && this.gear > 1 && this.speed > 3) this.doShift(-1);
      }
    }

    // 漂移计分
    const slipMag = Math.abs(this.slipAngleF) + Math.abs(this.slipAngleR);
    if (slipMag > 0.28 && this.speed > 9 && this.grounded) {
      this.driftScore += slipMag * this.speed * dt * 3;
      this.driftMult = Math.min(3, this.driftMult + slipMag * dt * 2.2);
    } else if (this.driftMult > 1) {
      this.driftMult = Math.max(1, this.driftMult - dt * 0.7);
    }
    if (slipMag > 0.4 && this.speed > 12) this.overtime += dt;

    // 坠穿兜底：若掉到世界以下，直接复位
    if (bp.y < -80) this.resetToNearestRoad();

    // 近光灯目标点：平滑跟随车头前方路面，避免车身俯仰让光斑乱晃
    if (this.headTargets && this.headTargets.length) {
      const fwd = this._hfwd || (this._hfwd = new THREE.Vector3(0, 0, 1));
      const right = this._hright || (this._hright = new THREE.Vector3(1, 0, 0));
      fwd.set(0, 0, 1).applyQuaternion(this.body.quaternion);
      right.set(1, 0, 0).applyQuaternion(this.body.quaternion);
      for (let i = 0; i < this.headTargets.length; i++) {
        const t = this.headTargets[i];
        const side = i === 0 ? 1 : -1;
        t.pos.copy(bp).addScaledVector(fwd, 14).addScaledVector(right, side * 1.5);
        t.pos.y -= 2.2;
        if (t.smooth.distanceTo(t.pos) > 30) t.smooth.copy(t.pos);
        t.smooth.lerp(t.pos, Math.min(1, dt * 30));
        t.light.target.position.copy(t.smooth);
      }
    }

    this.applyVisual();
  }

  // ---------------- 保时捷 918 独立物理（干净实现，不继承 GT 漂移逻辑） ----------------
  updateP918(dt, world) {
    const inp = this.input;
    const s = this.spec;
    const vehicle = this.vehicle;
    const bp = this.body.position;
    const T = P918_TUNE;
    const spd = this.speed;
    const spdKmh = spd * 3.6;

    // —— 转向：速度感应前轮 + 小角度后轮转向（缩小半径、不削弱驱动）——
    const maxFront = 0.50 * clamp(1.14 - spdKmh / 55, 0.34, 1.04) * T.steerMax;
    const steerTarget = inp.steer * maxFront;
    const steerRate = 7.5 * T.steerK;
    this.steer += clamp(steerTarget - this.steer, -steerRate * dt, steerRate * dt);
    vehicle.setSteeringValue(this.steer, 0);
    vehicle.setSteeringValue(this.steer, 1);
    const rearPhase = spdKmh < 55 ? -1 : 1;
    const rearK = spdKmh < 55
      ? lerp(0.045, 0.012, clamp(spdKmh / 55, 0, 1))
      : lerp(0.015, 0.045, clamp((spdKmh - 55) / 150, 0, 1));
    vehicle.setSteeringValue(this.steer * rearK * rearPhase * T.steerMax, 2);
    vehicle.setSteeringValue(this.steer * rearK * rearPhase * T.steerMax, 3);

    // —— 每轮抓地（干净：无漂移辅助、无漂移系数）——
    for (let i = 0; i < 4; i++) {
      const w = vehicle.wheelInfos[i];
      const surf = world.getSurface(w.worldTransform.position.x, w.worldTransform.position.z, w.worldTransform.position.y);
      let slip = (surf.road ? 3.0 : 1.5) * surf.muMul * surf.grip * (s.grip || 1) * T.gripK;
      if (spdKmh > 20) slip *= 1 + 0.5 * clamp((spdKmh - 20) / 80, 0, 1);
      if (inp.brake > 0.3 && inp.throttle === 0 && !inp.handbrake && spdKmh > 8) {
        slip *= 1 + inp.brake * 0.35;
      }
      if (i >= 2 && inp.handbrake) slip *= 0.5;
      // 更软更阻尼：吸收坡面起伏，消除上下震动
      w.suspensionStiffness = lerp(w.suspensionStiffness, 52 * T.suspStiff, Math.min(1, dt * 6));
      w.dampingCompression = lerp(w.dampingCompression, 9.0 * T.dampComp, Math.min(1, dt * 6));
      w.dampingRelaxation = lerp(w.dampingRelaxation, 6.5 * T.dampRelax, Math.min(1, dt * 6));
      w.maxSuspensionForce = 120000;
      w.rollInfluence = 0.03 * T.rollK;
      w.frictionSlip = clamp(slip, 0.2, 5.0);
    }

    // —— 驱动：油门始终生效（转向不影响给油），混动四驱 ——
    const reversing = this.gear === 0;
    const revDrive = reversing && inp.brake > 0 && inp.throttle === 0;
    const gr = reversing ? this.revRatio : (this.gear > 0 ? s.gears[this.gear - 1] : 0);
    const tqShape = torqueShape(this.engineRpm);
    const tqFac = 0.70 + 0.30 * tqShape;
    const throttle = reversing ? 0 : inp.throttle;
    const torque = revDrive
      ? s.torque * tqFac * 0.85 * T.torqueK
      : (gr > 0 ? s.torque * tqFac * throttle * T.torqueK : 0);
    const driveForce = gr > 0 ? torque * gr * s.fd / this.wheelR * 0.88 : 0;
    const rpmCut = clamp((s.redline - this.engineRpm) / 700, 0, 1);
    const revCut = reversing ? clamp(1 - Math.max(0, spd - 7) / 4, 0, 1) : 1;
    const maxTraction = this.mass * 9.81 * 1.7 / 4;
    const frontShare = clamp(0.38 + clamp(Math.abs(this.steer), 0, 1) * 0.06, 0.30, 0.48);
    for (let i = 0; i < 4; i++) {
      const active = (!reversing || revDrive);
      if (!active) { vehicle.applyEngineForce(0, i); continue; }
      const share = (i < 2 ? frontShare : (1 - frontShare)) / 2;
      const f = Math.min(driveForce * share, maxTraction) * rpmCut * revCut;
      vehicle.applyEngineForce(reversing ? f : -f, i);
    }

    // —— 制动：稳定、不点头翘尾 ——
    if (inp.brake === 0) this.brakeRamp = 0;
    if (inp.handbrake) {
      const hb = this.mass * 0.6 * clamp(1 - Math.max(0, spd - 6) / 10, 0.3, 1);
      vehicle.setBrake(hb, 2); vehicle.setBrake(hb, 3);
      vehicle.setBrake(0, 0); vehicle.setBrake(0, 1);
    } else if (reversing) {
      for (let i = 0; i < 4; i++) vehicle.setBrake(0, i);
    } else if (inp.brake > 0) {
      this.brakeRamp = Math.min(1, this.brakeRamp + dt * 6);
      const spdK = clamp(1.2 - spd * 0.010, 0.55, 1.12);
      const bF = this.mass * 23 / 60 * spdK * this.brakeRamp * T.brakeF;
      const bR = this.mass * 12 / 60 * spdK * this.brakeRamp * T.brakeR;
      vehicle.setBrake(bF, 0); vehicle.setBrake(bF, 1);
      vehicle.setBrake(bR, 2); vehicle.setBrake(bR, 3);
    } else {
      this.brakeRamp = 0;
      for (let i = 0; i < 4; i++) vehicle.setBrake(0, i);
    }

    // —— 下压力 ——
    const dfK = world.physics && world.physics.slowmo
      ? Math.min(20, 1 / Math.max(1e-4, dt * 60))
      : Math.min(1, dt * 60);
    if (this.grounded && spdKmh > 8) {
      const t = clamp((spdKmh - 8) / 60, 0, 1);
      const F = this.mass * 9.81 * 0.85 * (0.35 + 0.75 * t) * dfK * T.downforceK;
      this.body.applyForce(new CANNON.Vec3(0, -F, 0));
    }
    // 制动防点头：刹车时在车尾施加向下力（屁股下压），抵消车头下沉、防止车尾翘起
    const brakeTotal = vehicle.wheelInfos[0].brake + vehicle.wheelInfos[1].brake
      + vehicle.wheelInfos[2].brake + vehicle.wheelInfos[3].brake;
    if (brakeTotal > 8 && this.grounded && spd > 1.5) {
      const Fb = brakeTotal * (this.COM_OFFSET / (this.wheelbase * 0.5)) * 1.6 * dfK;
      this.body.applyForce(new CANNON.Vec3(0, -Fb, 0), new CANNON.Vec3(0, 0.05, -this.wheelbase * 0.55));
    }

    world.physics.step(dt);

    // —— 稳定：干净横摆上限 + 循迹刹车 ——
    const brakingHard = inp.brake > 0.3 && inp.throttle === 0 && !inp.handbrake;
    if (brakingHard && spd > 4) {
      const targetYaw = inp.steer * Math.min(1.0, 0.16 + spd * 0.014);
      this.body.angularVelocity.y *= Math.max(0, 1 - dt * (5 + inp.brake * 4));
      this.body.angularVelocity.y += (targetYaw - this.body.angularVelocity.y) * Math.min(1, dt * 3);
      this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -1.2, 1.2);
    } else {
      this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -(1.4 + spd * 0.05), 1.4 + spd * 0.05);
    }
    if (this.grounded) {
      const pitchDamp = 12;
      this.body.angularVelocity.x *= Math.max(0, 1 - pitchDamp * dt);
      this.body.angularVelocity.z *= Math.max(0, 1 - 4.0 * dt);
      this.body.angularVelocity.x = clamp(this.body.angularVelocity.x, -1.5, 1.5);
      this.body.angularVelocity.z = clamp(this.body.angularVelocity.z, -1.8, 1.8);
    } else if (this.airborne) {
      this.body.angularVelocity.x *= Math.max(0, 1 - 2.0 * dt);
      this.body.angularVelocity.z *= Math.max(0, 1 - 2.0 * dt);
      this.body.angularVelocity.y = clamp(this.body.angularVelocity.y, -1.2, 1.2);
    }

    // —— 同步镜像 ——
    this.pos.set(bp.x, bp.y, bp.z);
    const bv = this.body.velocity;
    this.vel.set(bv.x, bv.y, bv.z);
    this.bodyVy = bv.y;
    const q = this.body.quaternion;
    const fx = 2 * (q.x * q.z + q.y * q.w);
    const fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    this.yaw = Math.atan2(fx, fz);
    this.yawRate = this.body.angularVelocity.y;
    this.speed = Math.hypot(bv.x, bv.z);
    this.maxSpeedSeen = Math.max(this.maxSpeedSeen, this.speedKmh);
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw);
    const vLx = bv.x * cosY - bv.z * sinY;
    const vLz = bv.x * sinY + bv.z * cosY;
    this.vFwd = vLz;
    const fwdSpeed = Math.abs(vLz) > 1 ? vLz : 0;
    const slipLat = Math.atan2(vLx, Math.max(2.5, Math.abs(fwdSpeed)) * Math.sign(fwdSpeed || 1));
    this.slipAngleR = slipLat;
    this.slipAngleF = slipLat - this.steer;

    // —— 接地 / 滞空 / 落点预测 ——
    const wasGrounded = this.grounded;
    this.grounded = vehicle.numWheelsOnGround > 0;
    if (this.grounded) {
      if (!wasGrounded && this.airTime > 0.12) {
        this.landing = true;
        this.landingT = 0.5;
        this.jumpDist = Math.hypot(this.pos.x - this.jumpStartX, this.pos.z - this.jumpStartZ);
      }
      if (this.landing) {
        this.landingT -= dt;
        if (this.landingT <= 0) this.landing = false;
      }
      this.airTime = 0;
      this.airborne = false;
      let sum = 0, cnt = 0;
      for (let i = 0; i < 4; i++) {
        const w = vehicle.wheelInfos[i];
        if (w.isInContact || w.raycastResult.body) { sum += w.worldTransform.position.y; cnt++; }
      }
      if (cnt > 0) this.groundY = lerp(this.groundY, sum / cnt, 0.5);
    } else {
      if (wasGrounded) {
        this.jumpVy = Math.max(0, -bv.y);
        this.jumpGroundY = world.terrainHeight(this.pos.x, this.pos.z);
        this.jumpStartX = this.pos.x; this.jumpStartZ = this.pos.z; this.jumpDist = 0;
      }
      this.airTime += dt;
      this.airborne = this.airTime > 0.12;
      const g = CFG.grav;
      const clear = Math.max(0.45, this.pos.y - this.jumpGroundY);
      const step = 1 / 30;
      let px = this.body.velocity.x, py = this.body.velocity.y, pz = this.body.velocity.z;
      let cx = this.pos.x, cy = this.pos.y, cz = this.pos.z, tPred = this.airTime;
      for (let t = 0; t < 24 && py > -250; t += step) {
        py -= g * step;
        const damp = 1 - 0.025 * step;
        px *= damp; py *= damp; pz *= damp;
        cx += px * step; cy += py * step; cz += pz * step;
        tPred += step;
        const ground = world.terrainHeight(cx, cz);
        if (cy - clear <= ground) break;
      }
      this.jumpPredicted = tPred;
      this.jumpPredLandX = cx; this.jumpPredLandZ = cz;
    }

    // —— 发动机 / 变速箱 ——
    const wheelRpm = Math.abs(vLz) / (TAU * this.wheelR) * 60;
    if (this.shiftTimer > 0) {
      this.shiftTimer -= dt;
      this.engineRpm = Math.max(1000, this.engineRpm - 5200 * dt);
    } else {
      const targetRpm = this.gear > 0 ? wheelRpm * gr * s.fd
        : (reversing ? Math.max(900, wheelRpm * this.revRatio * s.fd * 0.9) : 950);
      const rpmRate = 1500 + Math.abs(targetRpm - this.engineRpm) * 1.6;
      this.engineRpm += clamp(targetRpm - this.engineRpm, -rpmRate * dt, rpmRate * dt);
      if (this.speed < 1.5 && this.gear > 0) this.engineRpm = Math.max(this.engineRpm, 950 + inp.throttle * 1400);
    }
    if (reversing) this.engineRpm = Math.min(this.engineRpm, 4300);
    if (this.engineRpm > s.redline) this.engineRpm = s.redline;
    if (this.autoShift && this.shiftTimer <= 0) {
      if (this.gear === 0) {
        if (inp.throttle > 0) this.doShift(1);
        else if (inp.throttle === 0 && inp.brake === 0 && this.speed < 0.5) this.doShift(1);
      } else if (this.gear === 1) {
        if (inp.brake > 0 && inp.throttle === 0 && this.speed < 1.2) this.doShift(-1);
        else if (this.engineRpm > s.redline * 0.86 && this.gear < s.gears.length) this.doShift(1);
      } else {
        if (this.speed < 2.5 && this.gear > 1) this.doShift(-1);
        else if (this.engineRpm > s.redline * 0.86 && this.gear < s.gears.length) this.doShift(1);
        else if (this.engineRpm < 2150 && this.gear > 1 && this.speed > 3) this.doShift(-1);
      }
    }

    if (bp.y < -80) this.resetToNearestRoad();

    if (this.headTargets && this.headTargets.length) {
      const fwd = this._hfwd || (this._hfwd = new THREE.Vector3(0, 0, 1));
      const right = this._hright || (this._hright = new THREE.Vector3(1, 0, 0));
      fwd.set(0, 0, 1).applyQuaternion(this.body.quaternion);
      right.set(1, 0, 0).applyQuaternion(this.body.quaternion);
      for (let i = 0; i < this.headTargets.length; i++) {
        const t = this.headTargets[i];
        const side = i === 0 ? 1 : -1;
        t.pos.copy(bp).addScaledVector(fwd, 14).addScaledVector(right, side * 1.5);
        t.pos.y -= 2.2;
        if (t.smooth.distanceTo(t.pos) > 30) t.smooth.copy(t.pos);
        t.smooth.lerp(t.pos, Math.min(1, dt * 30));
        t.light.target.position.copy(t.smooth);
      }
    }

    this.applyVisual();
  }

  doShift(d) {
    const s = this.spec;
    if (this.shiftTimer > 0) return;
    const ng = this.gear + d;
    if (d > 0) {
      if (ng > s.gears.length) return;
    } else {
      if (ng < 0) return;
      if (ng === 0 && this.speed > 2.5) return; // 高速不能挂倒挡
    }
    if (d < 0 && ng > 0) {
      const nr = this.speed / (TAU * this.wheelR) * 60 * s.gears[ng - 1] * s.fd;
      if (nr > s.redline * 1.08) return;
    }
    this.gear = ng;
    this.shiftTimer = 0.32 / (this.spec.id === 'p918' ? Math.max(0.35, P918_TUNE.shiftSpeed) : 1);
    this.gearChanges++;
    AudioSys.onGear();
  }

  applyVisual() {
    const g = this.visual;
    // 用 cannon 的插值状态做渲染：固定步长(1/60)与高帧率不同步时，
    // 原始 body.position/quaternion 会“一顿一顿”，产生 30~48Hz 数值抖动。
    const bp = this.body.interpolatedPosition, bq = this.body.interpolatedQuaternion;
    g.position.set(bp.x, bp.y, bp.z);
    g.quaternion.set(bq.x, bq.y, bq.z, bq.w);
    if (this.spec.id === 'p918') {
      // 918：转向组（含卡钳/轴头）只绕车身 Y 轴转；内层轮胎+轮毂单独自转
      const UP = this._axUp || (this._axUp = new THREE.Vector3(0, 1, 0));
      this._q1.set(bq.x, bq.y, bq.z, bq.w).invert();
      for (let i = 0; i < 4; i++) {
        this.vehicle.updateWheelTransform(i);
        const wt = this.vehicle.wheelInfos[i].worldTransform;
        const wm = this.wheelMeshes[i];
        // 轮子刚性固定：用原模型位置（车身局部），不随悬挂/地面起伏移动，避免穿模；
        // 物理（cannon 悬挂）照常运算，仅视觉轮子不再做悬挂位移。
        if (wm.userData.fixedPos) {
          wm.position.copy(wm.userData.fixedPos);
        } else {
          wm.position.set(wt.position.x - bp.x, wt.position.y - bp.y, wt.position.z - bp.z)
            .applyQuaternion(this._q1);
        }
        // cannon 相对姿态 = 转向(Y) * 自转(轮轴)
        this._q3.set(wt.quaternion.x, wt.quaternion.y, wt.quaternion.z, wt.quaternion.w);
        this._q3.premultiply(this._q1);
        // 转向组：绕车身局部 Y 叠加在模型基础姿态上（保留主销/倾角）
        this._q2.setFromAxisAngle(UP, this.vehicle.wheelInfos[i].steering);
        wm.quaternion.copy(this._q2).multiply(wm.userData.baseQuat);
        // 内层轮胎+轮毂：去掉转向后剩下的自转，绕轮轴独立旋转
        const inner = this.wheelSpinNodes[i];
        if (inner && inner.userData.baseQuat) {
          this._q4.copy(this._q2).invert().multiply(this._q3);
          inner.quaternion.copy(this._q4).multiply(inner.userData.baseQuat);
        }
        // 四个轮毂各自的左右偏移滑条：沿轮轴（自转组局部 X）微调
        const rim = this.rimMeshes && this.rimMeshes[i];
        if (rim) {
          const rimKey = ['rimFL', 'rimFR', 'rimRL', 'rimRR'][i];
          const rimOff = P918_TUNE[rimKey] || 0;
          rim.position.x = (rim.userData.baseX || 0) + rimOff;
          // 移到对侧（越过车中线）时自动镜像，保持朝外面朝外
          const rimSX = Math.abs(rim.userData.baseSX || 1);
          rim.scale.x = Math.abs(rimOff) > 0.8 ? -rimSX : rimSX;
        }
        // 四个轮胎各自的左右偏移滑条：沿轮轴（自转组局部 X）微调
        const tire = this.tireMeshes && this.tireMeshes[i];
        if (tire) {
          const tireKey = ['tireFL', 'tireFR', 'tireRL', 'tireRR'][i];
          const tireOff = P918_TUNE[tireKey] || 0;
          tire.position.x = (tire.userData.baseX || 0) + tireOff;
          const tireSX = Math.abs(tire.userData.baseSX || 1);
          tire.scale.x = Math.abs(tireOff) > 0.8 ? -tireSX : tireSX;
        }
      }
      // 方向盘随转向旋转（约 1.1 倍轮转角，平滑过渡）
      this.updateSteerVisual();
      // 918 主动尾翼：较低速窄区间内快速升起，高度更大、角度更明显
      if (this.wingRig) {
        const now = performance.now() / 1000;
        const dts = this._wingLastT ? Math.min(0.1, now - this._wingLastT) : 0.016;
        this._wingLastT = now;
        const spd = this.speedKmh;
        const riseTarget = smoothstep(42, 78, spd) * 0.15;
        const tiltTarget = smoothstep(70, 108, spd) * 0.26;
        const rate = Math.min(1, dts * 8);
        this.wingRise += (riseTarget - this.wingRise) * rate;
        this.wingTilt += (tiltTarget - this.wingTilt) * rate;
        this.wingRig.position.y = this.wingRigBaseY + this.wingRise;
        this._qSteer.setFromAxisAngle(this.wingAxis, this.wingTilt);
        this.wingGroup.quaternion.copy(this.wingBaseQ).multiply(this._qSteer);
      }
      const braking = this.input.brake > 0.1 || this.input.handbrake;
      const nightK = this.world ? (this.world.darkness || 0) : 0;
      const runK = nightK * 4.0; // 夜间行车灯：更亮的发光点点
      this.brakeMat.emissiveIntensity = braking ? 6.0 : runK;
      if (this.brakeMats) {
        for (const m of this.brakeMats) m.emissiveIntensity = braking ? 6.0 : runK;
      }
      return;
    }
    // 轮子：使用 cannon 的轮子世界变换（含悬挂压缩 / 转向 / 旋转）
    for (let i = 0; i < 4; i++) {
      this.vehicle.updateWheelTransform(i);
      const wt = this.vehicle.wheelInfos[i].worldTransform;
      const wm = this.wheelMeshes[i];
      this._q1.set(bq.x, bq.y, bq.z, bq.w).invert();
      // 世界坐标差要先转回车身局部坐标，否则轮子会随车身旋转叠加（双倍转角）
      wm.position.set(wt.position.x - bp.x, wt.position.y - bp.y, wt.position.z - bp.z)
        .applyQuaternion(this._q1);
      this._q2.set(wt.quaternion.x, wt.quaternion.y, wt.quaternion.z, wt.quaternion.w);
      wm.quaternion.copy(this._q1.multiply(this._q2));
    }
    // GT 方向盘：轮圈+辐条一起平滑旋转
    this.updateSteerVisual();
    const braking = this.input.brake > 0.1 || this.input.handbrake;
    const nightK = this.world ? (this.world.darkness || 0) : 0;
    const runK = nightK * 4.0; // 夜间行车灯：更亮的发光点点
    this.brakeMat.emissiveIntensity = braking ? 6.0 : runK;
    if (this.brakeMats) {
      for (const m of this.brakeMats) m.emissiveIntensity = braking ? 6.0 : runK;
    }
  }

  // 方向盘视觉：所有方向盘部件一起平滑旋转（轮圈/辐条/饰条）
  updateSteerVisual() {
    if (!this.steerWheels || !this.steerWheels.length) return;
    const now = performance.now() / 1000;
    const dt = this._steerLastT ? Math.min(0.1, now - this._steerLastT) : 0.016;
    this._steerLastT = now;
    const target = -this.steer * 1.1;
    const rate = Math.min(1, dt * 7.5); // 约 0.13s 平滑，避免生硬
    this.steerVisual += (target - this.steerVisual) * rate;
    for (const rig of this.steerWheels) {
      this._qSteer.setFromAxisAngle(rig.axis, this.steerVisual);
      rig.node.quaternion.copy(rig.base).multiply(this._qSteer);
    }
  }
}
