// ============================================================
//  CITY TREES — 海特洛市植被（新海诚风二次元）
//  ------------------------------------------------------------
//  樱花 / 悬铃木 / 棕榈 / 灌木绿篱 / 花瓣雨。
//  树冠为手绘贴图 + 十字面片（billboard cross），避免低模球体观感。
//  只通过 window.CITY 注册；不创建 Light；对象全部加入 world.cityRoot。
//
//  性能：
//  - 树干：1 组 InstancedMesh（樱花/悬铃木/棕榈共用圆柱 + setColorAt）
//  - 樱花冠、悬铃木冠：各 1 组 InstancedMesh（2 个交叉 Plane 合并几何）
//  - 棕榈冠：2 组 InstancedMesh（水平放射 Plane，两种手绘变体）
//  - 树下花瓣：1 组 InstancedMesh
//  - 灌木/绿篱/盆栽/AO 接地椭圆：CITY.mergeByMaterial 合并
//  - 花瓣雨：THREE.Points + CITY.registerUpdate
// ============================================================
(() => {
  'use strict';

  const CITY = window.CITY;
  if (!CITY) {
    console.warn('[city_trees] 未找到 window.CITY，已跳过（请先加载 city_core.js）。');
    return;
  }

  const TAU = Math.PI * 2;

  // ---------- 小工具 ----------
  const lambert = (color) => new THREE.MeshLambertMaterial({ color });

  const ensureCityRoot = (world) => {
    if (!world.cityRoot) {
      const g = new THREE.Group();
      g.name = 'cityRoot';
      world.scene.add(g);
      world.cityRoot = g;
    }
  };

  const groundY = (world, x, z, fallback) => {
    if (world && typeof world.terrainHeight === 'function') {
      try {
        const y = world.terrainHeight(x, z);
        if (isFinite(y)) return y;
      } catch (e) { /* 忽略 */ }
    }
    return (fallback !== undefined && fallback !== null && isFinite(fallback)) ? fallback : 0;
  };

  const dryEnough = (world, x, z, fallback) => {
    if (!world || typeof world.localWaterLevel !== 'function') return true;
    try {
      const gy = groundY(world, x, z, fallback);
      return gy >= world.localWaterLevel(x, z) + 0.45;
    } catch (e) { return true; }
  };

  const inAnyLot = (x, z, pad) => {
    const lots = CITY.lots || [];
    for (const l of lots) {
      const c = Math.cos(l.yaw || 0);
      const s = Math.sin(l.yaw || 0);
      const dx = x - l.x;
      const dz = z - l.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      if (Math.abs(lx) < l.w / 2 + pad && Math.abs(lz) < l.d / 2 + pad) return true;
    }
    return false;
  };

  const propOk = (world, x, z, r) => {
    if (!CITY.propSpot(world, x, z, r)) return false;
    if (inAnyLot(x, z, r + 0.5)) return false;
    // 高架空中走廊（桥墩/匝道）显式避让，额外留 1.5m 净距
    if (CITY.inReserved && CITY.inReserved(x, z, r + 1.5)) return false;
    return true;
  };

  const isNear = (spots, x, z, minD) => {
    for (let i = 0; i < spots.length; i++) {
      if (Math.hypot(spots[i].x - x, spots[i].z - z) < minD) return true;
    }
    return false;
  };

  const markSpot = (spots, x, z, type) => { spots.push({ x, z, type }); };

  const roadSideArrays = (world, roadId, sideOffset) => {
    const base = CITY.roadEdges(world, roadId, sideOffset);
    const a = [];
    const b = [];
    for (const e of base) {
      const half = ((e.s && e.s.w) || 8) / 2 + sideOffset;
      a.push(e);
      b.push({
        x: e.s.x - e.nx * half,
        z: e.s.z - e.nz * half,
        nx: -e.nx,
        nz: -e.nz,
        road: e.road,
        s: e.s,
      });
    }
    const sortByD = (p, q) => ((p.s && p.s.d) || 0) - ((q.s && q.s.d) || 0);
    a.sort(sortByD);
    b.sort(sortByD);
    return [a, b];
  };

  const collectAlong = (world, list, interval, maxOut, out, spots, opts = {}) => {
    const r = opts.r || 0.5;
    const minD = opts.minD || 4;
    let last = -Infinity;
    for (const e of list) {
      if (out.length >= maxOut) break;
      const d = (e.s && typeof e.s.d === 'number') ? e.s.d : 0;
      if (d - last < interval - 0.5) continue;
      const gy = groundY(world, e.x, e.z, e.s ? e.s.h : 0);
      if (!propOk(world, e.x, e.z, r)) continue;
      if (!dryEnough(world, e.x, e.z, gy)) continue;
      if (isNear(spots, e.x, e.z, minD)) continue;
      if (opts.filter && !opts.filter(e, gy)) continue;
      out.push({ x: e.x, z: e.z, road: e.road, s: e.s, ground: gy });
      last = d;
    }
  };

  const thinEvenly = (arr, max) => {
    if (arr.length <= max) return arr;
    const out = [];
    for (let i = 0; i < max; i++) {
      out.push(arr[Math.min(arr.length - 1, Math.floor((i + 0.5) * arr.length / max))]);
    }
    return out;
  };

  // ---------- 手绘树冠贴图（256×256，边缘完全透明羽化） ----------
  const grain = (g, w, h, n, alpha) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = CITY.chance(0.5)
        ? 'rgba(255,255,255,' + alpha + ')'
        : 'rgba(30,20,30,' + alpha + ')';
      g.fillRect(CITY.rand(0, w), CITY.rand(0, h), 1 + CITY.rand(0, 2), 1 + CITY.rand(0, 2));
    }
  };

  const paintSakuraCrown = (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    const puff = (bx, by, r, c0, c1, a, outline) => {
      const grad = g.createRadialGradient(bx, by, 0, bx, by, r);
      grad.addColorStop(0, c0 + a.toFixed(3) + ')');
      grad.addColorStop(0.7, c1 + (a * 0.96).toFixed(3) + ')');
      grad.addColorStop(1, c1 + '0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(bx, by, r, 0, TAU);
      g.fill();
      if (outline) {
        g.strokeStyle = outline;
        g.lineWidth = Math.max(1.2, r * 0.10);
        g.beginPath();
        g.arc(bx, by, r * 0.92, 0, TAU);
        g.stroke();
      }
    };
    // 中心主团
    puff(cx, cy, w * 0.16, 'rgba(255,246,250,', 'rgba(247,200,216,', 0.96, 'rgba(210,130,160,0.35)');
    // 一圈 7 团，形成不规则云朵轮廓
    for (let i = 0; i < 7; i++) {
      const ang = i / 7 * TAU + CITY.rand(-0.2, 0.2);
      const dist = w * (0.20 + CITY.rand(0, 0.08));
      const bx = cx + Math.cos(ang) * dist;
      const by = cy + Math.sin(ang) * dist * 0.88;
      const r = w * (0.09 + CITY.rand(0, 0.06));
      puff(bx, by, r, 'rgba(255,240,246,', 'rgba(244,190,208,', 0.92, 'rgba(205,125,155,0.3)');
    }
    // 外层 6 小团，拉开轮廓
    for (let i = 0; i < 6; i++) {
      const ang = i / 6 * TAU + CITY.rand(-0.28, 0.28);
      const dist = w * (0.30 + CITY.rand(0, 0.10));
      const bx = cx + Math.cos(ang) * dist;
      const by = cy + Math.sin(ang) * dist * 0.85;
      const r = w * (0.07 + CITY.rand(0, 0.06));
      puff(bx, by, r, 'rgba(251,215,228,', 'rgba(232,168,192,', 0.88, 'rgba(200,115,150,0.28)');
    }
    // 粉白高光点
    for (let i = 0; i < 14; i++) {
      const bx = cx + CITY.rand(-w * 0.26, w * 0.26);
      const by = cy + CITY.rand(-h * 0.24, h * 0.16);
      const r = w * (0.035 + CITY.rand(0, 0.045));
      const grad = g.createRadialGradient(bx, by, 0, bx, by, r);
      grad.addColorStop(0, 'rgba(255,252,254,0.9)');
      grad.addColorStop(1, 'rgba(251,215,228,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(bx, by, r, 0, TAU);
      g.fill();
    }
    grain(g, w, h, 180, 0.05);
  };

  const paintPlaneCrown = (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    const puff = (bx, by, r, c0, c1, a, outline) => {
      const grad = g.createRadialGradient(bx, by, 0, bx, by, r);
      grad.addColorStop(0, c0 + a.toFixed(3) + ')');
      grad.addColorStop(0.7, c1 + (a * 0.96).toFixed(3) + ')');
      grad.addColorStop(1, c1 + '0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(bx, by, r, 0, TAU);
      g.fill();
      if (outline) {
        g.strokeStyle = outline;
        g.lineWidth = Math.max(1.2, r * 0.10);
        g.beginPath();
        g.arc(bx, by, r * 0.92, 0, TAU);
        g.stroke();
      }
    };
    // 中心主团
    puff(cx, cy, w * 0.15, 'rgba(190,228,140,', 'rgba(96,170,74,', 0.96, 'rgba(45,95,40,0.4)');
    // 一圈 8 团
    for (let i = 0; i < 8; i++) {
      const ang = i / 8 * TAU + CITY.rand(-0.18, 0.18);
      const dist = w * (0.20 + CITY.rand(0, 0.08));
      const bx = cx + Math.cos(ang) * dist;
      const by = cy + Math.sin(ang) * dist * 0.85;
      const r = w * (0.09 + CITY.rand(0, 0.06));
      puff(bx, by, r, 'rgba(180,220,130,', 'rgba(90,160,70,', 0.94, 'rgba(42,92,38,0.32)');
    }
    // 外层 7 团，制造不规则轮廓
    for (let i = 0; i < 7; i++) {
      const ang = i / 7 * TAU + CITY.rand(-0.26, 0.26);
      const dist = w * (0.30 + CITY.rand(0, 0.10));
      const bx = cx + Math.cos(ang) * dist;
      const by = cy + Math.sin(ang) * dist * 0.82;
      const r = w * (0.07 + CITY.rand(0, 0.06));
      puff(bx, by, r, 'rgba(150,200,100,', 'rgba(74,140,60,', 0.9, 'rgba(38,86,34,0.28)');
    }
    // 暗部小团，增强手绘层次
    for (let i = 0; i < 9; i++) {
      const bx = cx + CITY.rand(-w * 0.28, w * 0.28);
      const by = cy + CITY.rand(-h * 0.24, h * 0.22);
      const r = w * (0.05 + CITY.rand(0, 0.05));
      const grad = g.createRadialGradient(bx, by, 0, bx, by, r);
      grad.addColorStop(0, 'rgba(52,112,44,0.6)');
      grad.addColorStop(1, 'rgba(42,96,40,0)');
      g.fillStyle = grad;
      g.beginPath();
      g.arc(bx, by, r, 0, TAU);
      g.fill();
    }
    grain(g, w, h, 200, 0.05);
  };

  const paintPalmCrown = (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    const fronds = 9 + Math.floor(CITY.rand(0, 4));
    g.lineCap = 'round';
    // 中心柔光团
    const glowR = w * 0.16;
    const glow = g.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    glow.addColorStop(0, 'rgba(120,190,110,0.95)');
    glow.addColorStop(0.7, 'rgba(76,150,72,0.55)');
    glow.addColorStop(1, 'rgba(60,130,60,0)');
    g.fillStyle = glow;
    g.beginPath();
    g.arc(cx, cy, glowR, 0, TAU);
    g.fill();
    // 放射状叶片：从中心向外弯曲，线宽渐细、末端透明
    for (let i = 0; i < fronds; i++) {
      const baseA = i / fronds * TAU + CITY.rand(-0.06, 0.06);
      const tipA = baseA + CITY.rand(-0.22, 0.22);
      const len = w * (0.34 + CITY.rand(0, 0.10));
      const tipX = cx + Math.cos(tipA) * len;
      const tipY = cy + Math.sin(tipA) * len;
      const ctrlR = len * 0.72;
      const ctrlA = baseA + CITY.rand(-0.12, 0.12);
      const ctrlX = cx + Math.cos(ctrlA) * ctrlR;
      const ctrlY = cy + Math.sin(ctrlA) * ctrlR;
      const grad = g.createLinearGradient(cx, cy, tipX, tipY);
      grad.addColorStop(0, 'rgba(82,160,82,0.95)');
      grad.addColorStop(0.55, 'rgba(70,150,72,0.8)');
      grad.addColorStop(1, 'rgba(62,138,66,0)');
      g.strokeStyle = grad;
      g.lineWidth = w * (0.055 + CITY.rand(0, 0.035));
      g.beginPath();
      g.moveTo(cx, cy);
      g.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
      g.stroke();
    }
    // 亮色短叶
    for (let i = 0; i < 6; i++) {
      const a = CITY.rand(0, TAU);
      const len = w * (0.16 + CITY.rand(0, 0.08));
      const grad = g.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      grad.addColorStop(0, 'rgba(150,210,120,0.8)');
      grad.addColorStop(1, 'rgba(120,190,110,0)');
      g.strokeStyle = grad;
      g.lineWidth = w * 0.03;
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      g.stroke();
    }
    grain(g, w, h, 120, 0.04);
  };

  const paintCrown = (type, g, w, h) => {
    if (type === 'sakura') paintSakuraCrown(g, w, h);
    else if (type === 'plane') paintPlaneCrown(g, w, h);
    else if (type === 'palm') paintPalmCrown(g, w, h);
  };

  // 樱花/悬铃木：两个 256 变体拼成 512×256 图集，十字面片各采一半
  const makeCrownAtlas = (type) => {
    const vA = CITY.makeCanvas(256, 256, (g, w, h) => paintCrown(type, g, w, h));
    const vB = CITY.makeCanvas(256, 256, (g, w, h) => paintCrown(type, g, w, h));
    const atlas = CITY.makeCanvas(512, 256, (g, w, h) => {
      g.drawImage(vA.image, 0, 0);
      g.drawImage(vB.image, 256, 0);
    });
    vA.dispose();
    vB.dispose();
    return atlas;
  };

  // 棕榈：两个独立 256 纹理（水平面只能整幅采样，故分两组实例）
  const makePalmTextures = () => [
    CITY.makeCanvas(256, 256, (g, w, h) => paintPalmCrown(g, w, h)),
    CITY.makeCanvas(256, 256, (g, w, h) => paintPalmCrown(g, w, h)),
  ];

  // ---------- 树冠几何 ----------
  const createCrossCrownGeometry = () => {
    // 两片垂直交叉 Plane（1×1），UV 左半=变体A、右半=变体B
    const positions = new Float32Array([
      -0.5, 0, 0,   0.5, 0, 0,   0.5, 1, 0,   -0.5, 1, 0,
       0, 0, -0.5,  0, 0, 0.5,   0, 1, 0.5,   0, 1, -0.5,
    ]);
    const normals = new Float32Array([
      0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
      1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0,
    ]);
    const uvs = new Float32Array([
      0, 0,  0.5, 0,  0.5, 1,  0, 1,
      0.5, 0,  1, 0,  1, 1,  0.5, 1,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(new THREE.BufferAttribute(new Uint16Array([
      0, 1, 2,  0, 2, 3,
      4, 5, 6,  4, 6, 7,
    ]), 1));
    geo.computeBoundingSphere();
    return geo;
  };

  const createHorizontalPlaneGeometry = () => {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2); // XZ 平面，法线 +Y
    geo.computeBoundingSphere();
    return geo;
  };

  const createAOEllipseTexture = () => CITY.makeCanvas(64, 64, (g, w, h) => {
    const cx = w / 2, cy = h / 2;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.46);
    grad.addColorStop(0, 'rgba(20,28,22,0.60)');
    grad.addColorStop(0.65, 'rgba(20,28,22,0.30)');
    grad.addColorStop(1, 'rgba(20,28,22,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  });

  // ---------- 花瓣雨（THREE.Points） ----------
  const petalSystems = [];

  const updatePetalSystem = (sys, world, night) => {
    const now = performance.now();
    let dt = (now - sys.last) / 1000;
    sys.last = now;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.05) dt = 0.05;
    const fall = 1 - night * 0.4;
    const pos = sys.geo.attributes.position;
    const time = now * 0.001;
    for (let i = 0; i < sys.count; i++) {
      const p = sys.data[i];
      p.y -= p.speed * dt * fall;
      p.x += Math.sin(time * 0.6 + p.phase) * p.driftAmp * dt * fall;
      p.z += Math.cos(time * 0.5 + p.phase * 1.3) * p.driftAmp * dt * fall;
      const gy = world.terrainHeight ? world.terrainHeight(p.x, p.z) : 0;
      if (p.y < gy + 0.2) {
        p.y = gy + p.topY;
        p.x = p.baseX + Math.sin(time * 0.13 + p.phase) * 10;
        p.z = p.baseZ + Math.cos(time * 0.17 + p.phase) * 10;
      }
      if (CITY.inReserved && CITY.inReserved(p.x, p.z, 1.0)) {
        p.x = p.baseX;
        p.z = p.baseZ;
        const baseGy = world.terrainHeight ? world.terrainHeight(p.x, p.z) : 0;
        p.y = baseGy + p.topY;
      }
      pos.setXYZ(i, p.x, p.y, p.z);
    }
    pos.needsUpdate = true;
    sys.mat.opacity = 0.9 - night * 0.35;
  };

  if (CITY.registerUpdate) {
    CITY.registerUpdate((world, night) => {
      for (const sys of petalSystems) updatePetalSystem(sys, world, night);
    });
  }

  // 树冠夜间蓝紫微光：白天 0xffffff，夜间向 0x8a90c0 过渡
  const crownLightMats = [];
  if (CITY.registerUpdate) {
    CITY.registerUpdate((world, night) => {
      for (const item of crownLightMats) {
        item.mat.color.setHex(CITY.lerpColor(item.day, item.night, night));
      }
    });
  }

  const buildPetalRain = (world, cityRoot) => {
    const count = 180;
    const rect = CITY.zoneDefs.culture.rect;
    const positions = new Float32Array(count * 3);
    const data = [];
    for (let i = 0; i < count; i++) {
      let x = CITY.rand(rect.x0, rect.x1);
      let z = CITY.rand(rect.z0, rect.z1);
      for (let attempt = 0; attempt < 40; attempt++) {
        if (!CITY.inReserved || !CITY.inReserved(x, z, 1.0)) break;
        x = CITY.rand(rect.x0, rect.x1);
        z = CITY.rand(rect.z0, rect.z1);
      }
      const gy = groundY(world, x, z, 0);
      const topY = CITY.rand(10, 18);
      const y = gy + CITY.rand(2, topY);
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      data.push({
        x, z, y,
        baseX: x, baseZ: z,
        speed: CITY.rand(0.7, 1.5),
        phase: CITY.rand(0, TAU),
        driftAmp: CITY.rand(0.4, 1.2),
        topY,
      });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const tex = CITY.makeCanvas(32, 32, (g, w, h) => {
      const r = w / 2;
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(255,240,246,1)');
      grad.addColorStop(0.55, 'rgba(255,200,220,0.9)');
      grad.addColorStop(1, 'rgba(255,180,205,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }, { srgb: false });
    const mat = new THREE.PointsMaterial({
      color: 0xffc4d6, size: 0.5, map: tex,
      transparent: true, opacity: 0.9, depthWrite: false,
      sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    cityRoot.add(points);
    petalSystems.push({ geo, mat, data, count, last: performance.now() });
    return { points, count };
  };

  // ---------- 构建阶段 ----------
  const build = (world) => {
    ensureCityRoot(world);
    const root = world.cityRoot;
    const treeSpots = [];
    const mergeList = [];
    const baseGeos = [];
    const colliderTrees = [];
    const instancedMeshes = [];

    let drawCalls = 0;
    let totalInstances = 0;
    let sakuraCount = 0;
    let planeCount = 0;
    let trimmedCount = 0;
    let palmCount = 0;
    let bushCount = 0;
    let hedgeCount = 0;
    let potCount = 0;
    let shrubCount = 0;
    let aoCount = 0;

    // ---------- 贴图 ----------
    const sakuraAtlas = makeCrownAtlas('sakura');
    const planeAtlas = makeCrownAtlas('plane');
    const palmTexs = makePalmTextures();
    const aoTex = createAOEllipseTexture();

    const matTrunk = lambert(0xffffff);
    matTrunk.emissive = new THREE.Color(0x2e2016);
    CITY.registerNight(matTrunk);

    const matSakuraCrown = new THREE.MeshBasicMaterial({
      map: sakuraAtlas, color: 0xffffff,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
    });
    const matPlaneCrown = new THREE.MeshBasicMaterial({
      map: planeAtlas, color: 0xffffff,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
    });
    const matPalmCrownA = new THREE.MeshBasicMaterial({
      map: palmTexs[0], color: 0xffffff,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
    });
    const matPalmCrownB = new THREE.MeshBasicMaterial({
      map: palmTexs[1], color: 0xffffff,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, alphaTest: 0.05,
    });
    crownLightMats.push(
      { mat: matSakuraCrown, day: 0xffffff, night: 0x8a90c0 },
      { mat: matPlaneCrown, day: 0xffffff, night: 0x8a90c0 },
      { mat: matPalmCrownA, day: 0xffffff, night: 0x8a90c0 },
      { mat: matPalmCrownB, day: 0xffffff, night: 0x8a90c0 },
    );

    const matSakuraPetal = new THREE.MeshBasicMaterial({
      color: 0xffffff, side: THREE.DoubleSide,
      transparent: true, opacity: 0.95, depthWrite: false,
    });
    const matAO = new THREE.MeshBasicMaterial({
      map: aoTex, transparent: true, depthWrite: false, opacity: 0.68, side: THREE.DoubleSide,
    });

    // 合并类材质
    const matBushGreen = [lambert(0x2f6b28), lambert(0x3f7a2e)];
    const matHedge = lambert(0x1f4a24);
    const matPot = lambert(0xb0643c);
    const matFlower = [lambert(0xe86a7a), lambert(0xf2b84c), lambert(0x8a6bb0)];

    // 几何
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 1, 7);
    const crossCrownGeo = createCrossCrownGeometry();
    const palmCrownGeo = createHorizontalPlaneGeometry();
    const petalDiscGeo = new THREE.CircleGeometry(0.09, 6);
    const aoGeo = createHorizontalPlaneGeometry();
    const bushGeo = new THREE.IcosahedronGeometry(0.5, 0);
    const hedgeGeo = new THREE.BoxGeometry(1.6, 0.65, 0.7);
    const potGeo = new THREE.CylinderGeometry(0.28, 0.22, 0.5, 7);
    const flowerGeo = new THREE.IcosahedronGeometry(0.32, 0);

    baseGeos.push(aoGeo, bushGeo, hedgeGeo, potGeo, flowerGeo);

    // ---------- 位置采集 ----------
    const sakuraTrees = [];
    let cultureCand = [];
    for (const rid of ['culture1', 'culture2', 'culture3']) {
      const sides = roadSideArrays(world, rid, 1.5);
      for (const side of sides) {
        collectAlong(world, side, 12, Infinity, cultureCand, treeSpots, { r: 0.5, minD: 4 });
      }
    }
    cultureCand = thinEvenly(cultureCand, 50);
    for (const c of cultureCand) {
      if (isNear(treeSpots, c.x, c.z, 4)) continue;
      c.type = 'sakura';
      sakuraTrees.push(c);
      markSpot(treeSpots, c.x, c.z, 'sakura');
    }

    const oldRect = CITY.zoneDefs.old.rect;
    let oldAdded = 0;
    let oldAttempts = 0;
    while (oldAdded < 30 && oldAttempts < 320) {
      oldAttempts++;
      const x = CITY.rand(oldRect.x0, oldRect.x1);
      const z = CITY.rand(oldRect.z0, oldRect.z1);
      const gy = groundY(world, x, z, 0);
      if (!propOk(world, x, z, 0.6)) continue;
      if (!dryEnough(world, x, z, gy)) continue;
      if (isNear(treeSpots, x, z, 4)) continue;
      sakuraTrees.push({ x, z, ground: gy, type: 'sakura' });
      markSpot(treeSpots, x, z, 'sakura');
      oldAdded++;
    }
    sakuraCount = sakuraTrees.length;

    const planeTrees = [];
    const trimmedTrees = [];
    let planeCand = [];
    for (const rid of ['cross', 'northsouth', 'ring']) {
      const sides = roadSideArrays(world, rid, 1.5);
      for (const side of sides) {
        collectAlong(world, side, 16, Infinity, planeCand, treeSpots, { r: 0.5, minD: 5 });
      }
    }
    planeCand = thinEvenly(planeCand, 160);
    for (const c of planeCand) {
      if (isNear(treeSpots, c.x, c.z, 5)) continue;
      const zone = CITY.zoneAt(c.x, c.z);
      if (zone === 'cbd') {
        c.type = 'trimmed';
        trimmedTrees.push(c);
        markSpot(treeSpots, c.x, c.z, 'trimmed');
      } else if (zone === 'old' || zone === 'mix') {
        c.type = 'plane';
        planeTrees.push(c);
        markSpot(treeSpots, c.x, c.z, 'plane');
      }
    }
    planeCount = planeTrees.length;
    trimmedCount = trimmedTrees.length;

    const palmTrees = [];
    let palmCand = [];
    for (const rid of ['coast']) {
      const sides = roadSideArrays(world, rid, 2.6);
      for (const side of sides) {
        collectAlong(world, side, 18, Infinity, palmCand, treeSpots, {
          r: 0.8, minD: 8,
          filter: (e, gy) => dryEnough(world, e.x, e.z, gy),
        });
      }
    }
    palmCand = thinEvenly(palmCand, 60);
    for (const c of palmCand) {
      if (isNear(treeSpots, c.x, c.z, 8)) continue;
      c.type = 'palm';
      palmTrees.push(c);
      markSpot(treeSpots, c.x, c.z, 'palm');
    }
    palmCount = palmTrees.length;

    // 滨海低矮灌丛
    const seaRect = CITY.zoneDefs.seaside.rect;
    let shrubAttempts = 0;
    while (shrubCount < 26 && shrubAttempts < 400) {
      shrubAttempts++;
      const x = CITY.rand(seaRect.x0, seaRect.x1);
      const z = CITY.rand(seaRect.z0, seaRect.z1);
      const gy = groundY(world, x, z, 0);
      if (!dryEnough(world, x, z, gy)) continue;
      if (!propOk(world, x, z, 0.4)) continue;
      if (isNear(treeSpots, x, z, 3)) continue;
      const bush = new THREE.Mesh(bushGeo, CITY.pick(matBushGreen));
      bush.position.set(x, gy + 0.2, z);
      const s = CITY.rand(0.5, 1.0);
      bush.scale.set(s, s * 0.7, s);
      mergeList.push(bush);
      markSpot(treeSpots, x, z, 'shrub');
      shrubCount++;
    }

    // CBD 楼前方块绿篱
    const cbdLots = (CITY.lots || []).filter(l => l.zone === 'cbd');
    for (const lot of cbdLots) {
      if (hedgeCount >= 36) break;
      const nr = world.nearestRoad ? world.nearestRoad(lot.x, lot.z) : null;
      if (!nr) continue;
      const dx = lot.x - nr.px;
      const dz = lot.z - nr.pz;
      const dist = Math.hypot(dx, dz);
      if (dist < 5) continue;
      const ux = dx / dist;
      const uz = dz / dist;
      const off = nr.s.w / 2 + (CITY.pal.cbd ? CITY.pal.cbd.sidewalk * 0.55 : 3.0);
      const hx = nr.px + ux * off;
      const hz = nr.pz + uz * off;
      if (!propOk(world, hx, hz, 0.6)) continue;
      if (isNear(treeSpots, hx, hz, 2.2)) continue;
      const tx = -uz;
      const tz = ux;
      const hedgeN = 1 + Math.floor(CITY.rand(0, 3));
      for (let k = 0; k < hedgeN; k++) {
        const kk = k - (hedgeN - 1) / 2;
        const kx = hx + tx * kk * 1.7;
        const kz = hz + tz * kk * 1.7;
        if (!propOk(world, kx, kz, 0.5)) continue;
        const gy = groundY(world, kx, kz, 0);
        const hedge = new THREE.Mesh(hedgeGeo, matHedge);
        hedge.position.set(kx, gy + 0.35, kz);
        hedge.rotation.y = Math.atan2(-tz, tx);
        hedge.scale.set(CITY.rand(0.9, 1.2), CITY.rand(0.85, 1.15), 1);
        mergeList.push(hedge);
        hedgeCount++;
      }
      markSpot(treeSpots, hx, hz, 'hedge');
    }

    // 老城巷口盆栽小花簇
    let potAttempts = 0;
    while (potCount < 18 && potAttempts < 300) {
      potAttempts++;
      const x = CITY.rand(oldRect.x0, oldRect.x1);
      const z = CITY.rand(oldRect.z0, oldRect.z1);
      const gy = groundY(world, x, z, 0);
      if (!dryEnough(world, x, z, gy)) continue;
      if (!propOk(world, x, z, 0.4)) continue;
      if (isNear(treeSpots, x, z, 2.5)) continue;
      const pot = new THREE.Mesh(potGeo, matPot);
      pot.position.set(x, gy + 0.25, z);
      mergeList.push(pot);
      const flower = new THREE.Mesh(flowerGeo, CITY.pick(matFlower));
      flower.position.set(x, gy + 0.62 + CITY.rand(0, 0.15), z);
      const fs = CITY.rand(0.7, 1.2);
      flower.scale.set(fs, fs * 0.8, fs);
      mergeList.push(flower);
      markSpot(treeSpots, x, z, 'pot');
      potCount++;
    }
    bushCount = shrubCount + hedgeCount + potCount;

    // ---------- 所有成熟行道树 ----------
    const allTrees = [...sakuraTrees, ...planeTrees, ...trimmedTrees, ...palmTrees];
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v3 = new THREE.Vector3();
    const col = new THREE.Color();

    // 为每棵树定高/定冠幅
    for (const t of allTrees) {
      if (t.type === 'sakura') {
        t.trunkH = CITY.rand(2.2, 3.0);
        t.crownW = CITY.rand(2.6, 4.0);
        t.crownH = CITY.rand(2.4, 3.6);
      } else if (t.type === 'plane') {
        t.trunkH = CITY.rand(3.0, 4.2);
        t.crownW = CITY.rand(2.8, 4.5);
        t.crownH = CITY.rand(2.8, 4.6);
      } else if (t.type === 'trimmed') {
        t.trunkH = CITY.rand(1.8, 2.4);
        t.crownW = CITY.rand(2.0, 2.8);
        t.crownH = CITY.rand(1.8, 2.6);
      } else if (t.type === 'palm') {
        t.trunkH = CITY.rand(8.0, 10.0);
        t.crownW = CITY.rand(4.0, 6.0);
      }
    }

    // AO 接地椭圆（合并，不占 InstancedMesh 实例）
    for (const t of allTrees) {
      const gy = t.ground != null ? t.ground : groundY(world, t.x, t.z, t.s ? t.s.h : 0);
      const ao = new THREE.Mesh(aoGeo, matAO);
      ao.position.set(t.x, gy + 0.04, t.z);
      const w = (t.crownW || 3) * 0.95;
      const d = (t.crownW || 3) * 0.72;
      ao.scale.set(w, d, 1); // 水平面本地 Y 映射到世界 Z
      mergeList.push(ao);
      aoCount++;
    }

    // ---------- 树干：1 组 InstancedMesh ----------
    if (allTrees.length) {
      const trunkMesh = new THREE.InstancedMesh(trunkGeo, matTrunk, allTrees.length);
      for (let i = 0; i < allTrees.length; i++) {
        const t = allTrees[i];
        const gy = t.ground != null ? t.ground : groundY(world, t.x, t.z, t.s ? t.s.h : 0);
        const sx = t.type === 'palm' ? CITY.rand(0.38, 0.5) : CITY.rand(0.85, 1.15);
        const sz = t.type === 'palm' ? CITY.rand(0.38, 0.5) : CITY.rand(0.85, 1.15);
        const leanX = t.type === 'palm' ? CITY.rand(-0.06, 0.08) : CITY.rand(-0.04, 0.04);
        const leanZ = t.type === 'palm' ? CITY.rand(-0.05, 0.05) : CITY.rand(-0.04, 0.04);
        q.setFromEuler(new THREE.Euler(leanX, CITY.rand(0, TAU), leanZ));
        v3.set(t.x, gy + t.trunkH / 2, t.z);
        m4.compose(v3, q, new THREE.Vector3(sx, t.trunkH, sz));
        trunkMesh.setMatrixAt(i, m4);
        if (t.type === 'palm') {
          trunkMesh.setColorAt(i, col.setHex(CITY.lerpColor(0x9a7b5a, 0x7d6248, CITY.rand(0, 1))));
        } else {
          trunkMesh.setColorAt(i, col.setHex(CITY.lerpColor(0x6b4c2c, 0x5a3e26, CITY.rand(0, 1))));
        }
      }
      trunkMesh.castShadow = true;
      trunkMesh.receiveShadow = true;
      trunkMesh.frustumCulled = false;
      trunkMesh.instanceMatrix.needsUpdate = true;
      if (trunkMesh.instanceColor) trunkMesh.instanceColor.needsUpdate = true;
      root.add(trunkMesh);
      instancedMeshes.push(trunkMesh);
      drawCalls++;
      totalInstances += allTrees.length;
    }

    // ---------- 樱花冠：十字面片 InstancedMesh ----------
    if (sakuraTrees.length) {
      const mesh = new THREE.InstancedMesh(crossCrownGeo, matSakuraCrown, sakuraTrees.length);
      for (let i = 0; i < sakuraTrees.length; i++) {
        const t = sakuraTrees[i];
        const gy = t.ground != null ? t.ground : groundY(world, t.x, t.z, t.s ? t.s.h : 0);
        q.setFromEuler(new THREE.Euler(0, (i % 2) ? Math.PI * 0.25 : 0, 0));
        v3.set(t.x, gy + t.trunkH * 0.88, t.z);
        m4.compose(v3, q, new THREE.Vector3(t.crownW, t.crownH, t.crownW));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.setHex(0xffffff));
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      root.add(mesh);
      instancedMeshes.push(mesh);
      drawCalls++;
      totalInstances += sakuraTrees.length;
    }

    // ---------- 悬铃木/CBD 修剪乔木冠：十字面片 InstancedMesh ----------
    const planeCrownTrees = [...planeTrees, ...trimmedTrees];
    if (planeCrownTrees.length) {
      const mesh = new THREE.InstancedMesh(crossCrownGeo, matPlaneCrown, planeCrownTrees.length);
      for (let i = 0; i < planeCrownTrees.length; i++) {
        const t = planeCrownTrees[i];
        const gy = t.ground != null ? t.ground : groundY(world, t.x, t.z, t.s ? t.s.h : 0);
        q.setFromEuler(new THREE.Euler(0, (i % 2) ? Math.PI * 0.25 : 0, 0));
        v3.set(t.x, gy + t.trunkH * 0.9, t.z);
        m4.compose(v3, q, new THREE.Vector3(t.crownW, t.crownH, t.crownW));
        mesh.setMatrixAt(i, m4);
        mesh.setColorAt(i, col.setHex(t.type === 'trimmed' ? 0xc2d6c2 : 0xffffff));
      }
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      root.add(mesh);
      instancedMeshes.push(mesh);
      drawCalls++;
      totalInstances += planeCrownTrees.length;
    }

    // ---------- 棕榈冠：水平放射 Plane，两种贴图变体 ----------
    if (palmTrees.length) {
      const halfA = Math.ceil(palmTrees.length / 2);
      const groups = [
        { mat: matPalmCrownA, count: halfA, trees: palmTrees.slice(0, halfA) },
        { mat: matPalmCrownB, count: palmTrees.length - halfA, trees: palmTrees.slice(halfA) },
      ];
      for (const grp of groups) {
        if (!grp.trees.length) continue;
        const mesh = new THREE.InstancedMesh(palmCrownGeo, grp.mat, grp.trees.length);
        for (let i = 0; i < grp.trees.length; i++) {
          const t = grp.trees[i];
          const gy = t.ground != null ? t.ground : groundY(world, t.x, t.z, t.s ? t.s.h : 0);
          q.setFromEuler(new THREE.Euler(0, CITY.rand(0, TAU), 0));
          v3.set(t.x, gy + t.trunkH - 0.2, t.z);
          m4.compose(v3, q, new THREE.Vector3(t.crownW, 1, t.crownW));
          mesh.setMatrixAt(i, m4);
          mesh.setColorAt(i, col.setHex(0xffffff));
        }
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        root.add(mesh);
        instancedMeshes.push(mesh);
        drawCalls++;
        totalInstances += grp.trees.length;
      }
    }

    // ---------- 樱花树下落瓣：InstancedMesh（逐点 propOk 过滤） ----------
    if (sakuraTrees.length) {
      const petalSpots = [];
      for (const t of sakuraTrees) {
        for (let k = 0; k < 6; k++) {
          let placed = false;
          for (let attempt = 0; attempt < 10; attempt++) {
            const a = CITY.rand(0, TAU);
            const rad = CITY.rand(0.4, 1.6);
            const px = t.x + Math.cos(a) * rad;
            const pz = t.z + Math.sin(a) * rad;
            if (propOk(world, px, pz, 0.15)) {
              petalSpots.push({ x: px, z: pz, ground: groundY(world, px, pz, t.ground) });
              placed = true;
              break;
            }
          }
          if (!placed) petalSpots.push({ x: t.x, z: t.z, ground: t.ground });
        }
      }
      const petalMesh = new THREE.InstancedMesh(petalDiscGeo, matSakuraPetal, petalSpots.length);
      for (let i = 0; i < petalSpots.length; i++) {
        const spot = petalSpots[i];
        q.setFromEuler(new THREE.Euler(-Math.PI / 2, CITY.rand(0, TAU), 0));
        const ps = CITY.rand(0.7, 1.3);
        v3.set(spot.x, spot.ground + 0.06, spot.z);
        m4.compose(v3, q, new THREE.Vector3(ps, ps, ps));
        petalMesh.setMatrixAt(i, m4);
        petalMesh.setColorAt(i, col.setHex(CITY.lerpColor(0xf7c8d8, 0xe8a8c0, CITY.rand(0, 1))));
      }
      petalMesh.castShadow = false;
      petalMesh.receiveShadow = false;
      petalMesh.frustumCulled = false;
      petalMesh.instanceMatrix.needsUpdate = true;
      if (petalMesh.instanceColor) petalMesh.instanceColor.needsUpdate = true;
      root.add(petalMesh);
      instancedMeshes.push(petalMesh);
      drawCalls++;
      totalInstances += petalSpots.length;
    }

    // ---------- 碰撞 ----------
    for (const t of sakuraTrees) colliderTrees.push({ x: t.x, z: t.z, r: 0.9, type: 'tree' });
    for (const t of planeTrees) colliderTrees.push({ x: t.x, z: t.z, r: 0.9, type: 'tree' });
    for (const t of trimmedTrees) colliderTrees.push({ x: t.x, z: t.z, r: 0.9, type: 'tree' });
    for (const t of palmTrees) colliderTrees.push({ x: t.x, z: t.z, r: 1.2, type: 'tree' });
    for (const c of colliderTrees) CITY.addCollider(world, c.x, c.z, c.r, c.type);

    // ---------- 合并静态植被（灌木/绿篱/盆栽/AO 椭圆） ----------
    let mergedDrawCalls = 0;
    if (mergeList.length) {
      const merged = CITY.mergeByMaterial(mergeList, root);
      mergedDrawCalls = merged.length;
      for (const mesh of merged) {
        if (mesh.material === matAO) mesh.castShadow = false;
      }
      drawCalls += mergedDrawCalls;
    }

    // 释放临时基础几何
    for (const g of baseGeos) {
      try { g.dispose(); } catch (e) { /* ignore */ }
    }

    // ---------- 花瓣雨 ----------
    const petalRain = buildPetalRain(world, root);
    drawCalls += 1;

    return {
      sakuraCount,
      planeCount,
      trimmedCount,
      palmCount,
      bushCount,
      shrubCount,
      hedgeCount,
      potCount,
      aoCount,
      petalPoints: petalRain.count,
      drawCalls,
      instancedMeshCount: instancedMeshes.length,
      totalInstances,
      mergedDrawCalls,
      colliderCount: colliderTrees.length,
    };
  };

  CITY.stages.push({ name: 'cityTrees', fn: build });
})();
