// ============================================================
//  CITY ROADS — 海特洛市地面细节
//  ------------------------------------------------------------
//  默认阶段 cityRoadDetails 只负责：
//    人行道 / 路缘石 / 井盖与排水篦 / 老城电车轨道 /
//    老城路面补丁 / 滨海步道。
//
//  斑马线 / 停止线 / 中央路口广场标线已剥离为
//  buildRoadMarkings()，通过 CITY.roadDetails.build 暴露，
//  默认不执行，交给 city_roads_engine 统一调度，避免重复绘制。
//
//  说明：
//  - 道路主体与车道线由 world.buildRoads / buildRoadMeshes /
//    buildLaneMeshes 生成，本文件只做地面细节覆盖层。
//  - 全部对象挂到 world.cityRoot，只通过 window.CITY 注册。
//  - 所有可合并的几何体统一走 CITY.mergeByMaterial 控制 draw call。
// ============================================================
(() => {
  'use strict';

  if (!window.CITY) {
    console.warn('[city_roads] window.CITY 不存在，跳过注册（请确认 city_core.js 已先加载）');
    return;
  }

  const CITY = window.CITY;

  // ---- 与 world.buildRoadMeshes 保持一致的常量 ----
  const ROAD_MESH_Y = 0.08;   // 道路网格本身抬升 0.08
  const MARK_Y = 0.11;        // 路面上标线（斑马线/停止线）抬升
  const LID_Y = 0.095;        // 井盖/篦子抬升
  const RAIL_Y = 0.105;       // 电车轨道抬升
  const PATCH_Y = 0.105;      // 路面补丁 decal 抬升
  const BOARD_Y = 0.105;      // 滨海步道抬升
  const SW_BASE = 0.10;       // 人行道基础抬升（路面为 0.08，人行道保持在路面之上 0.02+）
  const SW_STEP = 0.006;      // 每条道路的人行道微小递增，避免交叉口 z-fight

  // ------------------------------------------------------------
  //  小工具
  // ------------------------------------------------------------

  // 平面四边形构建器：u 轴为“沿路”，v 轴为“横路”，法线永远朝上。
  function FlatBuilder() {
    this.positions = [];
    this.normals = [];
    this.uvs = [];
    this.indices = [];
  }

  FlatBuilder.prototype.addQuad = function (
    cx, y, cz,
    ux, uz, vx, vz,
    hu, hv,
    u0, v0, u1, v1
  ) {
    const n = this.positions.length / 3;
    this.positions.push(
      cx - ux * hu - vx * hv, y, cz - uz * hu - vz * hv,
      cx + ux * hu - vx * hv, y, cz + uz * hu - vz * hv,
      cx - ux * hu + vx * hv, y, cz - uz * hu + vz * hv,
      cx + ux * hu + vx * hv, y, cz + uz * hu + vz * hv
    );
    for (let i = 0; i < 4; i++) this.normals.push(0, 1, 0);
    this.uvs.push(u0, v0, u1, v0, u0, v1, u1, v1);
    this.indices.push(n, n + 1, n + 2, n + 2, n + 1, n + 3);
  };

  FlatBuilder.prototype.isEmpty = function () {
    return this.indices.length === 0;
  };

  FlatBuilder.prototype.buildGeometry = function () {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setIndex(this.indices);
    g.computeBoundingSphere();
    return g;
  };

  FlatBuilder.prototype.toMesh = function (mat) {
    return new THREE.Mesh(this.buildGeometry(), mat);
  };

  function setRepeatWrap(tex, anisotropy) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = anisotropy || 4;
    tex.needsUpdate = true;
    return tex;
  }

  // 接地阴影 / AO 贴图（本文件内部实现，不依赖其它城市模块）
  function softShadowTexture(size) {
    size = size || 128;
    return CITY.makeCanvas(size, size, function (g, w, h) {
      const r = w / 2;
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(20,22,28,0.28)');
      grad.addColorStop(0.45, 'rgba(20,22,28,0.10)');
      grad.addColorStop(0.8, 'rgba(20,22,28,0.03)');
      grad.addColorStop(1, 'rgba(20,22,28,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }, { srgb: false });
  }

  let roadAOMat = null;
  function roadAOMaterial() {
    if (roadAOMat) return roadAOMat;
    roadAOMat = new THREE.MeshBasicMaterial({
      map: softShadowTexture(128),
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    return roadAOMat;
  }

  // 把 route.samples 抽稀成“每 step 个样本取 1 个”的连续路段。
  // closed 路的 samples 末尾点本来就是首点副本，因此直接取到末尾即可自然闭合。
  function segmentsOf(route, step) {
    const arr = route.samples;
    const chosen = [];
    for (let i = 0; i < arr.length; i += step) chosen.push(arr[i]);
    if (chosen[chosen.length - 1] !== arr[arr.length - 1]) chosen.push(arr[arr.length - 1]);

    const segs = [];
    for (let k = 0; k + 1 < chosen.length; k++) {
      const a = chosen[k];
      const b = chosen[k + 1];
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const len = Math.hypot(tx, tz);
      if (len < 1e-4) continue;
      segs.push({
        a, b,
        ux: tx / len, uz: tz / len,
        mx: (a.x + b.x) / 2, mz: (a.z + b.z) / 2,
        mh: (a.h + b.h) / 2,
        len,
        w: a.w,
      });
    }
    return segs;
  }

  function tangentAt(route, i) {
    const arr = route.samples;
    const a = arr[Math.max(0, i - 1)];
    const b = arr[Math.min(arr.length - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    return { tx: tx / l, tz: tz / l };
  }

  // 按累计里程 d 在 route 上插值一个点（含朝向切线）。
  function pointAtDist(route, d) {
    const arr = route.samples;
    if (!arr || arr.length < 2) return null;
    let lo = 0;
    let hi = arr.length - 1;
    if (d <= arr[0].d) {
      lo = 0; hi = Math.min(1, arr.length - 1);
    } else if (d >= arr[hi].d) {
      lo = Math.max(0, hi - 1);
    } else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].d <= d) lo = mid; else hi = mid;
      }
    }
    const a = arr[lo];
    const b = arr[hi];
    const span = b.d - a.d;
    const t = span > 1e-6 ? (d - a.d) / span : 0;
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    return {
      x: a.x + (b.x - a.x) * t,
      z: a.z + (b.z - a.z) * t,
      h: a.h + (b.h - a.h) * t,
      w: a.w,
      tx: tx / l,
      tz: tz / l,
    };
  }

  // 滨海步道：选择 z 更小的一侧（南侧/海侧）。
  function seaSide(nx, nz) {
    if (Math.abs(nz) < 0.05) return -1;
    return nz > 0 ? -1 : 1;
  }

  // 与 city_roads_engine 同口径的路口检测（本阶段运行更早，不能读 CITY.junctions）
  function findJunctionCenters(world) {
    const samples = world.samples || [];
    if (!samples.length) return [];
    const cell = 30;
    const grid = new Map();
    const gcx = x => Math.floor(x / cell);
    const gcz = z => Math.floor(z / cell);
    const gkey = (cx, cz) => cx + ',' + cz;
    for (const s of samples) {
      const k = gkey(gcx(s.x), gcz(s.z));
      let bucket = grid.get(k);
      if (!bucket) { bucket = []; grid.set(k, bucket); }
      bucket.push(s);
    }
    const query = (x, z, R) => {
      const out = [];
      const cx = gcx(x), cz = gcz(z);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(gkey(cx + dx, cz + dz));
          if (!bucket) continue;
          for (const o of bucket) {
            if (Math.hypot(o.x - x, o.z - z) <= R) out.push(o);
          }
        }
      }
      return out;
    };
    const clusters = [];
    for (const s of samples) {
      const R = s.w / 2 + 8;
      const seen = new Map();
      let count = 0, maxW = s.w;
      const near = query(s.x, s.z, R);
      for (const o of near) {
        let arr = seen.get(o.road);
        if (!arr) { arr = []; seen.set(o.road, arr); }
        arr.push(o);
        count++;
        if (o.w > maxW) maxW = o.w;
      }
      if (seen.size < 2) continue;
      let sx = 0, sz = 0, sw = 0;
      for (const arr of seen.values()) {
        for (const e of arr) {
          const w = 1 / (Math.hypot(e.x - s.x, e.z - s.z) + 1);
          sx += e.x * w; sz += e.z * w; sw += w;
        }
      }
      clusters.push({ x: sx / sw, z: sz / sw, count, maxW });
    }
    clusters.sort((a, b) => b.count - a.count);
    const merged = [];
    for (const c of clusters) {
      let found = null;
      for (const m of merged) {
        if (Math.hypot(c.x - m.x, c.z - m.z) < 45) { found = m; break; }
      }
      if (!found) {
        merged.push({ x: c.x, z: c.z, count: c.count, maxW: c.maxW });
      } else {
        const w1 = found.count, w2 = c.count;
        found.x = (found.x * w1 + c.x * w2) / (w1 + w2);
        found.z = (found.z * w1 + c.z * w2) / (w1 + w2);
        found.count += c.count;
        if (c.maxW > found.maxW) found.maxW = c.maxW;
      }
    }
    const out = [];
    for (const c of merged) {
      const R = Math.max(8, c.maxW / 2 + 8);
      const near = query(c.x, c.z, R);
      const roadSet = new Set();
      let maxW = 0;
      for (const o of near) {
        if (Math.hypot(o.x - c.x, o.z - c.z) <= R) {
          roadSet.add(o.road);
          if (o.w > maxW) maxW = o.w;
        }
      }
      if (roadSet.size < 2) continue;
      const nr = world.nearestRoad(c.x, c.z);
      if (!nr) continue;
      if (nr.d > nr.s.w / 2 + 6) continue;
      out.push({ x: c.x, z: c.z, r: maxW / 2 + 3 });
    }
    return out;
  }

  function makeRingAOGeometry(inner, width, segments) {
    const seg = segments || 48;
    const positions = [];
    const uvs = [];
    const indices = [];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      for (let side = 0; side < 2; side++) {
        const rad = inner + width * side;
        positions.push(ca * rad, sa * rad, 0);
        // 把内沿映射到贴图中心（最深），外沿映射到贴图边缘（全透明）
        const t = side;
        uvs.push(0.5 + 0.5 * ca * t, 0.5 + 0.5 * sa * t);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      indices.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(indices);
    g.computeBoundingSphere();
    return g;
  }

  // 获取/创建城市根节点。路网引擎单独调用 buildRoadMarkings 时也能安全写入。
  function getCityRoot(world) {
    if (!world) return null;
    if (world.cityRoot) return world.cityRoot;
    const g = new THREE.Group();
    g.name = 'cityRoot';
    world.scene.add(g);
    world.cityRoot = g;
    return g;
  }

  // ------------------------------------------------------------
  //  贴图
  // ------------------------------------------------------------
  function makeSidewalkWarm() {
    return setRepeatWrap(CITY.makeCanvas(256, 256, (g) => {
      g.fillStyle = '#d9cdba';
      g.fillRect(0, 0, 256, 256);
      // 石板缝：错缝铺装
      g.strokeStyle = 'rgba(110,96,78,0.5)';
      g.lineWidth = 2;
      for (let r = 0; r < 4; r++) {
        const y = r * 64;
        g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke();
        const off = (r % 2) * 64;
        for (let x = off - 64; x < 256; x += 128) {
          g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 64); g.stroke();
        }
      }
      // 少量磨损浅斑
      for (let i = 0; i < 18; i++) {
        g.fillStyle = 'rgba(255,255,255,' + (0.04 + CITY.rand(0, 0.05)).toFixed(3) + ')';
        g.beginPath();
        g.ellipse(CITY.rand(0, 256), CITY.rand(0, 256), CITY.rand(4, 16), CITY.rand(2, 7), CITY.rand(0, 3), 0, Math.PI * 2);
        g.fill();
      }
      CITY.grain(g, 256, 256, 0.05, 500);
    }, { srgb: true }), 4);
  }

  function makeSidewalkLight() {
    return setRepeatWrap(CITY.makeCanvas(256, 256, (g) => {
      g.fillStyle = '#ccd3d8';
      g.fillRect(0, 0, 256, 256);
      // 浅灰地砖网格
      g.strokeStyle = 'rgba(105,112,120,0.45)';
      g.lineWidth = 2;
      for (let i = 0; i <= 4; i++) {
        const p = i * 64;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
        g.beginPath(); g.moveTo(0, p); g.lineTo(256, p); g.stroke();
      }
      // 对角微反光
      g.strokeStyle = 'rgba(255,255,255,0.18)';
      g.lineWidth = 6;
      for (let i = -2; i < 6; i++) {
        g.beginPath(); g.moveTo(i * 64, 0); g.lineTo(i * 64 + 64, 256); g.stroke();
      }
      CITY.grain(g, 256, 256, 0.045, 420);
    }, { srgb: true }), 4);
  }

  function makeSidewalkSeaside() {
    return setRepeatWrap(CITY.makeCanvas(256, 256, (g) => {
      g.fillStyle = '#efe7d4';
      g.fillRect(0, 0, 256, 256);
      // 米白大板 + 细缝
      g.strokeStyle = 'rgba(160,148,124,0.45)';
      g.lineWidth = 2;
      for (let i = 0; i <= 2; i++) {
        const p = i * 128;
        g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 256); g.stroke();
      }
      g.beginPath(); g.moveTo(0, 128); g.lineTo(256, 128); g.stroke();
      for (let i = 0; i < 14; i++) {
        g.fillStyle = 'rgba(255,255,255,' + (0.05 + CITY.rand(0, 0.06)).toFixed(3) + ')';
        g.beginPath();
        g.ellipse(CITY.rand(0, 256), CITY.rand(0, 256), CITY.rand(3, 12), CITY.rand(2, 6), CITY.rand(0, 3), 0, Math.PI * 2);
        g.fill();
      }
      CITY.grain(g, 256, 256, 0.04, 360);
    }, { srgb: true }), 4);
  }

  function makeManholeTex() {
    return CITY.makeCanvas(128, 128, (g) => {
      g.clearRect(0, 0, 128, 128);
      // 铸铁底
      const grad = g.createRadialGradient(64, 64, 8, 64, 64, 62);
      grad.addColorStop(0, '#4a4f56');
      grad.addColorStop(0.7, '#34383e');
      grad.addColorStop(1, '#23262b');
      g.fillStyle = grad;
      g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill();
      // 外圈
      g.strokeStyle = '#1c1f23';
      g.lineWidth = 5;
      g.beginPath(); g.arc(64, 64, 57, 0, Math.PI * 2); g.stroke();
      // 微内圈线
      g.strokeStyle = 'rgba(140,148,158,0.55)';
      g.lineWidth = 2;
      g.beginPath(); g.arc(64, 64, 38, 0, Math.PI * 2); g.stroke();
      // 中心圆点 + 放射纹
      g.fillStyle = '#262a2f';
      g.beginPath(); g.arc(64, 64, 10, 0, Math.PI * 2); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.28)';
      g.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        g.beginPath();
        g.moveTo(64 + Math.cos(a) * 12, 64 + Math.sin(a) * 12);
        g.lineTo(64 + Math.cos(a) * 55, 64 + Math.sin(a) * 55);
        g.stroke();
      }
      CITY.grain(g, 128, 128, 0.06, 160);
    }, { srgb: true });
  }

  function makeGrateTex() {
    return CITY.makeCanvas(128, 128, (g) => {
      g.fillStyle = '#2c3035';
      g.fillRect(0, 0, 128, 128);
      g.fillStyle = '#1d2024';
      for (let i = 0; i < 6; i++) {
        g.fillRect(6, 10 + i * 19, 116, 7);
      }
      g.fillStyle = 'rgba(140,148,158,0.25)';
      g.fillRect(6, 10, 116, 2);
      g.fillRect(6, 119, 116, 2);
      CITY.grain(g, 128, 128, 0.05, 120);
    }, { srgb: true });
  }

  function makeBoardwalkTex() {
    return setRepeatWrap(CITY.makeCanvas(256, 256, (g) => {
      g.fillStyle = '#c99a62';
      g.fillRect(0, 0, 256, 256);
      // 横向木板
      for (let r = 0; r < 8; r++) {
        const y = r * 32;
        g.fillStyle = r % 2 ? '#c5935a' : '#d0a26b';
        g.fillRect(0, y, 256, 30);
        g.fillStyle = 'rgba(70,42,20,0.35)';
        g.fillRect(0, y + 29, 256, 2);
        // 板端接缝
        const off = (r % 2) * 48;
        for (let x = off; x < 256; x += 96) {
          g.fillStyle = 'rgba(70,42,20,0.28)';
          g.fillRect(x, y, 2, 30);
        }
      }
      CITY.grain(g, 256, 256, 0.05, 420);
    }, { srgb: true }), 4);
  }

  function makePatchTex() {
    return CITY.makeCanvas(256, 256, (g) => {
      g.clearRect(0, 0, 256, 256);
      // 深灰补丁边线 + 裂缝 alpha
      g.fillStyle = 'rgba(38,40,45,0.32)';
      g.beginPath();
      g.ellipse(128, 132, 96, 76, 0.12, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(20,21,24,0.65)';
      g.lineWidth = 4;
      g.beginPath();
      g.ellipse(128, 132, 94, 74, 0.12, 0, Math.PI * 2);
      g.stroke();
      // 裂缝
      g.strokeStyle = 'rgba(18,19,22,0.5)';
      g.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        g.beginPath();
        let x = CITY.rand(30, 226);
        let y = CITY.rand(30, 226);
        g.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          x += CITY.rand(-24, 24);
          y += CITY.rand(-18, 18);
          g.lineTo(x, y);
        }
        g.stroke();
      }
      CITY.grain(g, 256, 256, 0.04, 180);
    }, { srgb: false });
  }

  function makeTramWarnTex() {
    return CITY.makeCanvas(128, 128, (g) => {
      g.clearRect(0, 0, 128, 128);
      g.fillStyle = '#f2c230';
      for (let i = -3; i < 8; i++) {
        g.beginPath();
        g.moveTo(i * 40, 128);
        g.lineTo(i * 40 + 56, 0);
        g.lineTo(i * 40 + 96, 0);
        g.lineTo(i * 40 + 40, 128);
        g.closePath();
        g.fill();
      }
      g.strokeStyle = 'rgba(20,20,20,0.35)';
      g.lineWidth = 2;
      g.strokeRect(2, 2, 124, 124);
    }, { srgb: true });
  }

  // ------------------------------------------------------------
  //  构建主函数
  // ------------------------------------------------------------
  function buildRoadDetails(world) {
    const root = getCityRoot(world);
    if (!root) return { sidewalkKm: 0, crosswalkCount: 0, manholeCount: 0, tramKm: 0, patchCount: 0, drawCalls: 0 };

    const routes = world.trafficRoutes || [];
    const routeIndexMap = new Map();
    routes.forEach((r, i) => routeIndexMap.set(r.id, i));

    // ---------- 贴图 / 材质 ----------
    const swTexWarm = makeSidewalkWarm();
    const swTexLight = makeSidewalkLight();
    const swTexSeaside = makeSidewalkSeaside();
    const swMatWarm = new THREE.MeshStandardMaterial({ map: swTexWarm, roughness: 0.92, metalness: 0 });
    const swMatLight = new THREE.MeshStandardMaterial({ map: swTexLight, roughness: 0.9, metalness: 0 });
    const swMatSeaside = new THREE.MeshStandardMaterial({ map: swTexSeaside, roughness: 0.9, metalness: 0 });

    const curbMat = new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.88, metalness: 0.04 });
    const manholeTex = makeManholeTex();
    const manholeMat = new THREE.MeshStandardMaterial({ map: manholeTex, roughness: 0.85, metalness: 0.35 });
    const grateTex = makeGrateTex();
    const grateMat = new THREE.MeshStandardMaterial({ map: grateTex, roughness: 0.85, metalness: 0.35 });
    const tramMat = new THREE.MeshStandardMaterial({ color: 0x4a3828, roughness: 0.38, metalness: 0.72 });
    const warnMat = new THREE.MeshBasicMaterial({ map: makeTramWarnTex(), transparent: true, depthWrite: false });
    const patchTex = makePatchTex();
    const patchMat = new THREE.MeshBasicMaterial({
      map: patchTex,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const boardMat = new THREE.MeshStandardMaterial({ map: makeBoardwalkTex(), roughness: 0.82, metalness: 0 });
    const aoMat = roadAOMaterial();
    const aoBuilder = new FlatBuilder();
    const aoMeshes = [];

    // ---------- 几何收集器 ----------
    const swBuilders = {
      warm: new FlatBuilder(),
      light: new FlatBuilder(),
      seaside: new FlatBuilder(),
    };
    const curbMeshes = [];
    const manholeMeshes = [];
    const grateBuilder = new FlatBuilder();
    const tramBuilder = new FlatBuilder();
    const warnBuilder = new FlatBuilder();
    const patchBuilder = new FlatBuilder();
    const boardBuilder = new FlatBuilder();
    const boardMeshes = [];

    let sidewalkLen = 0;
    let tramLen = 0;
    let manholeCount = 0;
    let patchCount = 0;

    const circleGeo = new THREE.CircleGeometry(0.45, 18);
    const postGeo = new THREE.BoxGeometry(0.14, 0.72, 0.14);

    // 人行道分区材质选择
    function sidewalkZone(x, z) {
      const zid = CITY.zoneAt(x, z);
      if (zid === 'old' || zid === 'culture') return 'warm';
      if (zid === 'seaside') return 'seaside';
      return 'light';
    }
    function sidewalkWidth(x, z) {
      const zid = CITY.zoneAt(x, z);
      return (zid && CITY.pal[zid] && CITY.pal[zid].sidewalk) || 3.5;
    }

    // ---------- 1. 人行道 / 2. 路缘石 / 4. 井盖篦子 ----------
    for (let rIdx = 0; rIdx < routes.length; rIdx++) {
      const route = routes[rIdx];
      const arr = route.samples;
      if (!arr || arr.length < 2) continue;
      const w0 = arr[0].w;

      // 人行道：每 2 个样本取一段，两侧连续条带
      const segs = segmentsOf(route, 2);
      for (const seg of segs) {
        const nx = -seg.uz;
        const nz = seg.ux;
        const sw = sidewalkWidth(seg.mx, seg.mz);
        const zoneKey = sidewalkZone(seg.mx, seg.mz);
        // 向道路方向多压 0.35m：中心向路内移 0.175，半宽加 0.175，
        // 外沿保持不变，内沿覆盖路肩接缝。
        const off = seg.w / 2 + sw - 0.175;
        const hv = sw / 2 + 0.175;
        const y = seg.mh + SW_BASE + rIdx * SW_STEP;
        const u1 = (seg.len + 0.24) / 4;
        const v1 = hv / 2;

        for (const side of [-1, 1]) {
          const cx = seg.mx + nx * side * off;
          const cz = seg.mz + nz * side * off;
          swBuilders[zoneKey].addQuad(
            cx, y, cz,
            seg.ux, seg.uz, nx * side, nz * side,
            seg.len / 2 + 0.12, hv,
            0, 0, u1, v1
          );
        }
        sidewalkLen += seg.len * 2;
      }

      // 路缘石：主干道 w>=12，沿左右路沿铺浅灰薄条
      if (w0 >= 12) {
        const curbSegs = segmentsOf(route, 4);
        for (const seg of curbSegs) {
          const nx = -seg.uz;
          const nz = seg.ux;
          const sw = sidewalkWidth(seg.mx, seg.mz);
          const geo = new THREE.BoxGeometry(0.25, 0.18, seg.len + 0.2);
          const y = seg.mh + 0.115;
          // 路缘石贴着人行道内沿（人行道向路内多压 0.35 后的边），
          // 不再骑在路沿正中，避免路缘与人行道之间露出黑缝。
          const curbOff = seg.w / 2 + sw / 2 - 0.35 + 0.125;
          for (const side of [-1, 1]) {
            const m = new THREE.Mesh(geo, curbMat);
            m.position.set(seg.mx + nx * side * curbOff, y, seg.mz + nz * side * curbOff);
            m.rotation.y = Math.atan2(seg.ux, seg.uz);
            curbMeshes.push(m);
          }
        }

        // 接地 AO：路缘石与人行道交界处每 8m 一条 0.35×1.2 的窄 AO 条（沿路缘）
        const total = arr[arr.length - 1].d;
        let aoDist = 4;
        while (aoDist < total) {
          const p = pointAtDist(route, aoDist);
          if (!p) break;
          const nx = -p.tz;
          const nz = p.tx;
          const sw = sidewalkWidth(p.x, p.z);
          const curbOff = p.w / 2 + sw / 2 - 0.35 + 0.125;
          const aoY = p.h + SW_BASE + rIdx * SW_STEP + 0.02;
          for (const side of [-1, 1]) {
            aoBuilder.addQuad(
              p.x + nx * side * curbOff, aoY, p.z + nz * side * curbOff,
              p.tx, p.tz, nx * side, nz * side,
              0.6, 0.175,
              0.5, 0, 0.5, 1
            );
          }
          aoDist += 8;
        }
      }

      // 井盖与排水篦
      if (w0 >= 9) {
        const isMain = w0 >= 12;
        const spacing = isMain ? CITY.rand(70, 90) : CITY.rand(130, 190);
        const total = arr[arr.length - 1].d;
        let dist = CITY.rand(20, spacing);
        let grateDist = dist + spacing * 0.5;
        let grateSide = CITY.chance(0.5) ? 1 : -1;

        while (dist < total) {
          const p = pointAtDist(route, dist);
          if (!p) break;
          const nx = -p.tz;
          const nz = p.tx;
          const lat = (CITY.rand(-1, 1)) * p.w * 0.35;
          const m = new THREE.Mesh(circleGeo, manholeMat);
          m.rotation.x = -Math.PI / 2;
          m.position.set(p.x + nx * lat, p.h + LID_Y + rIdx * 0.001, p.z + nz * lat);
          manholeMeshes.push(m);
          manholeCount++;
          dist += spacing;
        }

        while (grateDist < total) {
          const p = pointAtDist(route, grateDist);
          if (!p) break;
          const nx = -p.tz;
          const nz = p.tx;
          grateSide = -grateSide;
          const edgeOff = p.w / 2 - 0.85;
          const cx = p.x + nx * grateSide * edgeOff;
          const cz = p.z + nz * grateSide * edgeOff;
          grateBuilder.addQuad(
            cx, p.h + LID_Y + rIdx * 0.001, cz,
            p.tx, p.tz, nx * grateSide, nz * grateSide,
            0.3, 0.175,
            0, 0, 1, 1
          );
          grateDist += spacing;
        }
      }
    }

    // 注：斑马线 / 停止线 / 路口广场标线已移交路网引擎。
    // 代码保留在 buildRoadMarkings() 中，由 CITY.roadDetails 暴露，默认不在本阶段执行。

    // ---------- 5. 老城电车轨道 ----------
    for (const route of routes) {
      if (route.id !== 'old1' && route.id !== 'old2') continue;
      const rIdx = routeIndexMap.get(route.id) || 0;
      const segs = segmentsOf(route, 2);
      for (const seg of segs) {
        const nx = -seg.uz;
        const nz = seg.ux;
        const y = seg.mh + RAIL_Y + rIdx * 0.001;
        const u1 = seg.len / 6;
        for (const off of [-0.72, 0.72]) {
          const cx = seg.mx + nx * off;
          const cz = seg.mz + nz * off;
          tramBuilder.addQuad(
            cx, y, cz,
            seg.ux, seg.uz, nx, nz,
            seg.len / 2 + 0.1, 0.045,
            0, 0, u1, 1
          );
        }
        tramLen += seg.len * 2;
      }

      // 平交道口警示标线：每 200m 一个黄黑斜纹小面
      const total = route.samples[route.samples.length - 1].d;
      let dist = 100;
      while (dist < total) {
        const p = pointAtDist(route, dist);
        if (!p) break;
        const nx = -p.tz;
        const nz = p.tx;
        warnBuilder.addQuad(
          p.x, p.h + MARK_Y + rIdx * 0.001, p.z,
          p.tx, p.tz, nx, nz,
          0.7, 1.0,
          0, 0, 1, 1
        );
        dist += 200;
      }
    }

    // ---------- 6. 老城路面补丁 / 裂纹 ----------
    const oldRoutes = routes.filter(r => {
      const s = r.samples[0];
      return s && s.w >= 7 && CITY.zoneAt(s.x, s.z) === 'old';
    });
    if (oldRoutes.length) {
      patchCount = 52;
      for (let i = 0; i < patchCount; i++) {
        const route = CITY.pick(oldRoutes);
        const arr = route.samples;
        const idx = Math.floor(CITY.rand(0, arr.length - 1));
        const s = arr[idx];
        const nx = -tangentAt(route, idx).tz;
        const nz = tangentAt(route, idx).tx;
        const lat = (CITY.rand(-1, 1)) * s.w * 0.38;
        const cx = s.x + nx * lat;
        const cz = s.z + nz * lat;
        const yaw = CITY.rand(0, Math.PI);
        const ux = Math.sin(yaw);
        const uz = Math.cos(yaw);
        const vx = -uz;
        const vz = ux;
        patchBuilder.addQuad(
          cx, s.h + PATCH_Y + CITY.rand(0, 0.015), cz,
          ux, uz, vx, vz,
          CITY.rand(0.7, 1.9), CITY.rand(0.6, 1.6),
          0, 0, 1, 1
        );
      }
    }

    // ---------- 7. 滨海步道 ----------
    const coast = routes.find(r => r.id === 'coast');
    if (coast) {
      const rIdx = routeIndexMap.get(coast.id) || 0;
      const segs = segmentsOf(coast, 2);
      for (const seg of segs) {
        const nx = -seg.uz;
        const nz = seg.ux;
        const side = seaSide(nx, nz);
        const vx = nx * side;
        const vz = nz * side;
        const off = seg.w / 2 + 1.25;
        const cx = seg.mx + vx * off;
        const cz = seg.mz + vz * off;
        boardBuilder.addQuad(
          cx, seg.mh + BOARD_Y + rIdx * 0.001, cz,
          seg.ux, seg.uz, vx, vz,
          seg.len / 2 + 0.12, 1.25,
          0, 0, (seg.len + 0.24) / 4, 2.5 / 4
        );
      }

      // 矮护栏桩：每 40m 一个，与步道同材质合并
      const total = coast.samples[coast.samples.length - 1].d;
      let dist = 20;
      while (dist < total) {
        const p = pointAtDist(coast, dist);
        if (!p) break;
        const nx = -p.tz;
        const nz = p.tx;
        const side = seaSide(nx, nz);
        const px = p.x + nx * side * (p.w / 2 + 2.42);
        const pz = p.z + nz * side * (p.w / 2 + 2.42);
        const post = new THREE.Mesh(postGeo, boardMat);
        post.position.set(px, p.h + BOARD_Y + 0.36, pz);
        boardMeshes.push(post);
        dist += 40;
      }
    }

    // ---------- 合并所有几何体 ----------
    const finalMeshes = [];

    function mergeGroup(name, meshes) {
      if (!meshes || meshes.length === 0) return;
      const out = CITY.mergeByMaterial(meshes, root);
      for (let i = 0; i < out.length; i++) {
        out[i].name = name + (out.length > 1 ? '_' + i : '');
        finalMeshes.push(out[i]);
      }
    }

    mergeGroup('citySidewalk', [
      swBuilders.warm.isEmpty() ? null : swBuilders.warm.toMesh(swMatWarm),
      swBuilders.light.isEmpty() ? null : swBuilders.light.toMesh(swMatLight),
      swBuilders.seaside.isEmpty() ? null : swBuilders.seaside.toMesh(swMatSeaside),
    ].filter(Boolean));

    mergeGroup('cityCurb', curbMeshes);
    mergeGroup('cityManhole', manholeMeshes);
    mergeGroup('cityGrate', grateBuilder.isEmpty() ? [] : [grateBuilder.toMesh(grateMat)]);
    mergeGroup('cityTramRail', tramBuilder.isEmpty() ? [] : [tramBuilder.toMesh(tramMat)]);
    mergeGroup('cityTramWarn', warnBuilder.isEmpty() ? [] : [warnBuilder.toMesh(warnMat)]);
    mergeGroup('cityPatch', patchBuilder.isEmpty() ? [] : [patchBuilder.toMesh(patchMat)]);
    mergeGroup('cityBoardwalk', [boardBuilder.isEmpty() ? null : boardBuilder.toMesh(boardMat)].concat(boardMeshes).filter(Boolean));

    // ---------- 接地 AO：路缘窄条 + 路口板外缘环，合并为 1 个 draw call ----------
    if (!aoBuilder.isEmpty()) aoMeshes.push(aoBuilder.toMesh(aoMat));
    const junctions = findJunctionCenters(world);
    for (const j of junctions) {
      const ringGeo = makeRingAOGeometry(j.r, 0.5, 48);
      const ring = new THREE.Mesh(ringGeo, aoMat);
      ring.position.set(j.x, world.terrainHeight(j.x, j.z) + 0.085, j.z);
      ring.rotation.x = -Math.PI / 2;
      aoMeshes.push(ring);
    }
    mergeGroup('cityRoadAO', aoMeshes);
    for (const m of aoMeshes) {
      try { m.geometry.dispose(); } catch (e) { /* ignore */ }
    }
    for (const m of finalMeshes) {
      if (m.name && m.name.indexOf('cityRoadAO') === 0) {
        m.renderOrder = 2;
      }
    }

    // 透明 decal / 标线不投射阴影；mergeByMaterial 默认开了 castShadow，这里纠正。
    for (const m of finalMeshes) {
      if (m.material && m.material.transparent) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 2;
      }
    }

    // ---------- 统计 ----------
    const stats = {
      sidewalkKm: +(sidewalkLen / 1000).toFixed(3),
      crosswalkCount: 0,
      manholeCount,
      tramKm: +(tramLen / 1000).toFixed(3),
      patchCount,
      aoStripCount: Math.max(0, aoBuilder.indices.length / 6),
      aoRingCount: junctions.length,
      drawCalls: finalMeshes.length,
    };

    CITY.cityRoadDetails = stats;
    return stats;
  }

  // ------------------------------------------------------------
  //  道路标线（斑马线 / 停止线 / 中央路口广场标线）
  //  ------------------------------------------------------------
  //  职责已从 cityRoadDetails 阶段剥离，交给 city_roads_engine 统一调度。
  //  这里保留实现并通过 CITY.roadDetails.build 暴露；默认不执行。
  function buildRoadMarkings(world, opts) {
    opts = opts || {};
    const doCrosswalks = opts.crosswalks !== undefined ? opts.crosswalks : true;
    const doStopLines = opts.stopLines !== undefined ? opts.stopLines : doCrosswalks;
    const doJunction = opts.junctionMarking !== undefined ? opts.junctionMarking : true;

    const root = getCityRoot(world);
    if (!root) return { crosswalkCount: 0, stopLineCount: 0, junctionMarkingCount: 0, drawCalls: 0 };

    const routes = world.trafficRoutes || [];
    const routeIndexMap = new Map();
    routes.forEach((r, i) => routeIndexMap.set(r.id, i));

    const finalMeshes = [];
    function mergeGroup(name, meshes) {
      if (!meshes || meshes.length === 0) return;
      const out = CITY.mergeByMaterial(meshes, root);
      for (let i = 0; i < out.length; i++) {
        out[i].name = name + (out.length > 1 ? '_' + i : '');
        finalMeshes.push(out[i]);
      }
    }

    let crosswalkCount = 0;
    let stopLineCount = 0;
    let junctionMarkingCount = 0;

    // ---------- 斑马线与停止线 ----------
    if (doCrosswalks) {
      const mainRoutes = routes.filter(r => r.samples.length && r.samples[0].w >= 9);
      if (mainRoutes.length > 1) {
        const cell = 20;
        const grid = new Map();
        const gkey = (cx, cz) => cx + ',' + cz;
        const gcx = x => Math.floor((x + 3000) / cell);
        const gcz = z => Math.floor((z + 3000) / cell);

        for (const r of mainRoutes) {
          for (const s of r.samples) {
            const k = gkey(gcx(s.x), gcz(s.z));
            let bucket = grid.get(k);
            if (!bucket) { bucket = []; grid.set(k, bucket); }
            bucket.push({ x: s.x, z: s.z, road: s.road });
          }
        }

        function nearestOtherDist(x, z, roadId) {
          const cx = gcx(x);
          const cz = gcz(z);
          let best = 1e9;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
              const bucket = grid.get(gkey(cx + dx, cz + dz));
              if (!bucket) continue;
              for (const o of bucket) {
                if (o.road === roadId) continue;
                const d = Math.hypot(o.x - x, o.z - z);
                if (d < best) best = d;
              }
            }
          }
          return best;
        }

        const crossMat = new THREE.MeshLambertMaterial({ color: 0xf4f6f9 });
        const crossBuilder = new FlatBuilder();

        function drawCrosswalk(route, idx, s, rIdx) {
          const t = tangentAt(route, idx);
          const nx = -t.tz;
          const nz = t.tx;
          const y = s.h + MARK_Y + rIdx * 0.0015;
          const bars = 5 + Math.floor(CITY.rand(0, 3)); // 5~7
          const pitch = 0.9;
          const groupLen = bars * 0.5 + (bars - 1) * 0.4;
          const halfGroup = groupLen / 2;
          const halfAcross = s.w * 0.375;

          for (let k = 0; k < bars; k++) {
            const along = (k - (bars - 1) / 2) * pitch;
            const cx = s.x + t.tx * along;
            const cz = s.z + t.tz * along;
            crossBuilder.addQuad(
              cx, y, cz,
              t.tx, t.tz, nx, nz,
              0.25, halfAcross,
              0, 0, 1, 1
            );
          }

          if (doStopLines) {
            const stopAlong = -halfGroup - 2.2;
            crossBuilder.addQuad(
              s.x + t.tx * stopAlong, y, s.z + t.tz * stopAlong,
              t.tx, t.tz, nx, nz,
              0.2, s.w * 0.4,
              0, 0, 1, 1
            );
            stopLineCount++;
          }
        }

        const placed = [];
        for (const route of mainRoutes) {
          const arr = route.samples;
          const rIdx = routeIndexMap.get(route.id) || 0;
          // 收集靠近其它道路的样本，按沿路连续段聚类，取每段最近点作为路口
          const near = [];
          for (let i = 0; i < arr.length; i += 2) {
            const d = nearestOtherDist(arr[i].x, arr[i].z, route.id);
            if (d < 18) near.push({ i, d });
          }
          const groups = [];
          for (const c of near) {
            const last = groups[groups.length - 1];
            if (last && c.i - last[last.length - 1].i <= 8) last.push(c);
            else groups.push([c]);
          }
          for (const group of groups) {
            let best = group[0];
            for (const c of group) if (c.d < best.d) best = c;
            const s = arr[best.i];
            if (placed.some(p => p.road === route.id && Math.hypot(p.x - s.x, p.z - s.z) < 25)) continue;
            placed.push({ road: route.id, x: s.x, z: s.z });
            drawCrosswalk(route, best.i, s, rIdx);
            crosswalkCount++;
          }
        }

        if (!crossBuilder.isEmpty()) mergeGroup('cityCrosswalk', [crossBuilder.toMesh(crossMat)]);
      }
    }

    // ---------- 中央路口广场标记（cross × northsouth 双圆环） ----------
    if (doJunction) {
      const cross = routes.find(r => r.id === 'cross');
      const northsouth = routes.find(r => r.id === 'northsouth');
      if (cross && northsouth) {
        let best = null;
        for (const s of cross.samples) {
          for (const o of northsouth.samples) {
            const d = Math.hypot(o.x - s.x, o.z - s.z);
            if (!best || d < best.d) best = { d, s, o };
          }
        }
        if (best) {
          const junctionMat = new THREE.MeshLambertMaterial({ color: 0xf4f6f9 });
          const junctionMeshes = [];
          const cx = (best.s.x + best.o.x) / 2;
          const cz = (best.s.z + best.o.z) / 2;
          const cy = (best.s.h + best.o.h) / 2 + MARK_Y + 0.015;
          const ringGeo1 = new THREE.RingGeometry(2.0, 2.22, 48);
          const ringGeo2 = new THREE.RingGeometry(3.3, 3.52, 48);
          const dotGeo = new THREE.CircleGeometry(0.55, 24);
          for (const geo of [ringGeo1, ringGeo2, dotGeo]) {
            const m = new THREE.Mesh(geo, junctionMat);
            m.rotation.x = -Math.PI / 2;
            m.position.set(cx, cy, cz);
            junctionMeshes.push(m);
          }
          mergeGroup('cityJunction', junctionMeshes);
          junctionMarkingCount = 1;
        }
      }
    }

    return {
      crosswalkCount,
      stopLineCount,
      junctionMarkingCount,
      drawCalls: finalMeshes.length,
    };
  }

  // 路网引擎可读的标志与入口；默认全部关闭，避免与 city_roads_engine 重复绘制。
  CITY.roadDetails = {
    crosswalksEnabled: false,
    stopLinesEnabled: false,
    junctionMarkingEnabled: false,
    build: buildRoadMarkings,
    buildMarkings: buildRoadMarkings,
  };

  // ---------- 注册构建阶段 ----------
  CITY.stages.push({
    name: 'cityRoadDetails',
    fn: buildRoadDetails,
  });
})();
