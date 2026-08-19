// ============================================================
//  开放世界 — 地形 / 道路 / 植被 / 建筑 / 天空 / 天气
// ============================================================
'use strict';

// 物理高度场网格：801×801（6.75m/格）。路面由道路 Trimesh 精确支撑，
// 高度场只负责越野，保持低分辨率保证 raycast 性能（1201² 会让游戏卡死）
const HF_N = 801;

const SEASONS = [
  { name: '春', grassA: 0x86c35a, grassB: 0xa2d47a, field: 0xd9b95a, tree: 0x5a9c36, fog: 0xcfeaf0, sun: 0xfff3c8, sky: 0x84c9ea, water: 0x3a8fb4 },
  { name: '夏', grassA: 0x4f8f38, grassB: 0x67aa4c, field: 0xd0ad50, tree: 0x2c611f, fog: 0xc9e3ed, sun: 0xfff6d8, sky: 0x6db8e2, water: 0x2c86ad },
  { name: '秋', grassA: 0x9b8a45, grassB: 0xb2a052, field: 0xd9a64b, tree: 0x7c5420, fog: 0xd8cbb0, sun: 0xffdfa0, sky: 0xa8b8c0, water: 0x4a7f8a },
  { name: '冬', grassA: 0xe8ece8, grassB: 0xf2f4f0, field: 0xe4e8e2, tree: 0x6b5a44, fog: 0xd7dde0, sun: 0xfff2cf, sky: 0xaabcc8, water: 0x3f6a7d },
];

// 额外小湖：湖连接线北段、十字高速东段各一个（道路从湖上穿过，配桥）
const EXTRA_LAKES = [
  { cx: -160, cz: 1010, r: 85 },
  { cx: 220, cz: 40, r: 80 },
];

// 公开单文件版：window.__NO_LAKES = true 时删除湖泊/桥梁，恢复原地图
const NO_LAKES = typeof window !== 'undefined' && window.__NO_LAKES === true;

// 光照模式：classic=最早的原版光照（无环境反射/夜间提亮）；默认 pbr 为优化版。
// 游戏内按 F8 切换并记忆；也可用 URL ?light=classic 强制回退。
const LIGHT_CLASSIC = (() => {
  try { if (localStorage.getItem('horizonLightMode') === 'classic') return true; } catch (e) {}
  if (typeof location !== 'undefined' && /[?&]light=classic/.test(location.search)) return true;
  return typeof window !== 'undefined' && window.__LIGHT_CLASSIC === true;
})();

class GameWorld {
  constructor(scene, renderer, mapCfg) {
    this.map = mapCfg || MAPS[0];
    // 城市系地图共用同一套城市模块管线（海特洛市 / 海特洛2）
    this.isCity = this.map.id === 'city' || this.map.id === 'city2' || this.map.id === 'city3';
    this.roadDefs = this.map.roads;
    this.seasons = this.map.seasons || SEASONS;
    this.lakeWaterLevel = this.map.lakeWaterLevel != null ? this.map.lakeWaterLevel : CFG.waterLevel;
    this.scene = scene;
    this.renderer = renderer;
    this.season = 1; // 0春 1夏 2秋 3冬
    this.hour = this.map.defaultHour != null ? this.map.defaultHour : 9.5;
    this.weather = 0; // 0晴 1雨 2雾 3雪（雪天仅在冬季可选）
    this.weatherAmt = 0;
    this.colliders = [];
    this.trafficRoutes = [];
    this.samples = [];
    this.grid = null;
    this.cell = 30;
    this.props = {};
    this.clouds = [];
    this.rainPts = null; this.snowPts = null;
    this.windmills = [];
    this.lamps = [];
    this.hydrants = [];
    this.foliageMeshes = [];
    this.treeData = [];
    this.roadBodies = [];
    this.startLine = null;
    this.buildDone = false;
    this.heightEdit = null;   // 开发者模式地形编辑偏移（HF_N×HF_N，与物理高度场同网格）
    this.devBusy = false;     // 地形/道路重建进行中
  }

  // ================= 地形高度 =================
  landHeight(x, z) {
    if (this.map.id === 'alpine') return this.landHeightAlpine(x, z);
    if (this.isCity) return this.landHeightCity(x, z);
    // 主大陆：以中部高原为主，平均 ~55m
    let h = 55 + (Noise.fbm(x * 0.00030 + 3, z * 0.00030 - 7, 4) - 0.5) * 95;
    h += (Noise.fbm(x * 0.0014 + 31, z * 0.0014 - 17, 3) - 0.5) * 26;
    // 东北山地（真正的山，振幅/坡度已放缓以保证山路可驾驶）
    const ne = smoothstep(-2300, -1500, x) * smoothstep(-2300, -1500, z);
    const mt = Noise.fbm(x * 0.00052 + 999, z * 0.00052 - 333, 4);
    h += smoothstep(0.42, 0.62, mt) * ne * 200;
    // 西南低地（缓坡通向海岸）
    const sw = 1 - smoothstep(-2400, -1500, x) * smoothstep(-2400, -1500, z);
    h = lerp(h, 14, clamp(sw, 0, 1) * 0.5);
    // 边缘海
    const sea = smoothstep(2250, 2600, Math.max(Math.abs(x), Math.abs(z)));
    h = lerp(h, -18, sea);
    return h;
  }

  // 阿尔卑斯湖谷：大雪山 + 中央湖谷 + 河谷平原 + 海岸
  landHeightAlpine(x, z) {
    let h = 42 + (Noise.fbm(x * 0.00025 + 5, z * 0.00025 - 11, 4) - 0.5) * 45;
    h += (Noise.fbm(x * 0.0011 + 41, z * 0.0011 - 23, 3) - 0.5) * 16;
    const rolling = Noise.fbm(x * 0.00062 - 19, z * 0.00062 + 53, 4);
    h += (rolling - 0.5) * 54;
    const sea = smoothstep(2200, 2600, Math.max(Math.abs(x), Math.abs(z)));
    // 东北主峰群（圆形山体，最高 ~300m，坡度放缓）
    const dNE = Math.hypot(x - 1780, z + 60);
    const ne = 1 - smoothstep(550, 1250, dNE);
    const ridge = Noise.fbm(x * 0.0004 + 777, z * 0.0004 - 555, 4);
    h += smoothstep(0.40, 0.60, ridge) * ne * 280;
    // 副峰
    const dNE2 = Math.hypot(x - 2150, z - 350);
    const ne2 = 1 - smoothstep(300, 750, dNE2);
    h += smoothstep(0.42, 0.62, Noise.fbm(x * 0.0005 + 11, z * 0.0005 - 77, 4)) * ne2 * 190;
    // 西北高地
    const dNW = Math.hypot(x + 1900, z - 900);
    const nw = 1 - smoothstep(450, 950, dNW);
    h += smoothstep(0.44, 0.66, Noise.fbm(x * 0.0006 - 123, z * 0.0006 + 321, 4)) * nw * 160;
    // 中央湖谷：围绕大湖压平（无湖泊版本退回湖前地形，不再压平）
    const L = this.map.lake;
    if (!NO_LAKES && L) {
      const dv = Math.hypot(x - L.cx, z - L.cz);
      const valley = 1 - smoothstep(300, 1100, dv);
      h = lerp(h, 28, clamp(valley, 0, 1) * 0.58);
    }
    // 西南海岸低地（更宽）
    const sw = 1 - smoothstep(-2300, -1200, x) * smoothstep(-2300, -1200, z);
    h = lerp(h, 10, clamp(sw, 0, 1) * 0.38);
    // 海
    h = lerp(h, -20, sea);
    return h;
  }

  // 海特洛市：北高南低缓坡 + 北侧远山 + 南侧入海，城区近平面便于 2D 路网
  landHeightCity(x, z) {
    let h = 6.4 + (z + 1750) * 0.007;
    h += (Noise.fbm(x * 0.0012 + 77, z * 0.0012 - 19, 3) - 0.5) * 0.9;
    // 北部远山（视觉背景，也在城外形成可探索缓丘）
    const mt = smoothstep(1250, 2250, z);
    const ridge = Noise.fbm(x * 0.00045 + 911, z * 0.00045 - 211, 4);
    h += smoothstep(0.42, 0.62, ridge) * mt * 300;
    // 南部入海（z 越靠南越接近海面：z<-2050 全海，z>-1650 全陆）
    const sea = 1 - smoothstep(-2050, -1650, z);
    h = lerp(h, -20, sea);
    return h;
  }

  seaMask(x, z) {
    if (this.isCity) return 1 - smoothstep(-2100, -1650, z);
    return smoothstep(2250, 2600, Math.max(Math.abs(x), Math.abs(z)));
  }

  lakeMask(x, z) {
    if (NO_LAKES) return 0;
    if (this.map.id === 'alpine') {
      const L = this.map.lake;
      const d = Math.hypot(x - L.cx, z - L.cz);
      const ring = 1 - smoothstep(L.r * 0.55, L.r, d);
      const lakeN = Noise.fbm(x * 0.0009 + 77, z * 0.0009 - 13, 3);
      const lowland = smoothstep(90, 25, this.landHeight(x, z));
      let m = clamp(ring * lowland * (0.85 + 0.15 * lakeN), 0, 1);
      // 额外小湖
      for (const L2 of EXTRA_LAKES) {
        const d2 = Math.hypot(x - L2.cx, z - L2.cz);
        const r2 = 1 - smoothstep(L2.r * 0.55, L2.r, d2);
        const n2 = Noise.fbm(x * 0.0015 + L2.cx, z * 0.0015 - L2.cz, 2);
        const lowland2 = smoothstep(90, 25, this.landHeight(x, z));
        m = Math.max(m, clamp(r2 * lowland2 * (0.92 + 0.08 * n2), 0, 1));
      }
      return clamp(m, 0, 1);
    }
    const ne = smoothstep(-2300, -1500, x) * smoothstep(-2300, -1500, z);
    const lakeN = Noise.fbm(x * 0.0009 + 77, z * 0.0009 - 13, 3);
    const lowland = smoothstep(70, 18, this.landHeight(x, z));
    const mask = smoothstep(0.50, 0.40, lakeN) * lowland;
    return clamp(mask, 0, 1) * (1 - ne * 0.85);
  }

  baseHeight(x, z) {
    const h = this.landHeight(x, z);
    // 阿尔卑斯湖：湖床必须低于水面，否则湖水会被地形盖住看不见
    if (this.map.id === 'alpine') {
      const lm = this.lakeMask(x, z);
      const deep = smoothstep(0.35, 0.55, lm);
      return lerp(h, this.lakeWaterLevel - 2.0, deep);
    }
    return lerp(h, this.lakeWaterLevel - 2.2, this.lakeMask(x, z) * 0.82);
  }

  // 湖面/海面的局部水位：被湖遮罩覆盖的地方用高山湖水位，其余用海平面
  localWaterLevel(x, z) {
    return this.lakeMask(x, z) > 0.35 ? this.lakeWaterLevel : CFG.waterLevel;
  }

  // 道路采样 + 网格
  buildRoads() {
    const cell = this.cell;
    const gs = Math.ceil(CFG.worldHalf * 2 / cell) + 2;
    this.grid = Array.from({ length: gs }, () => Array.from({ length: gs }, () => []));
    const all = [];
    for (const rd of this.roadDefs) {
      const pts = rd.pts.map(p => new THREE.Vector3(p[0], 0, p[1]));
      const curve = new THREE.CatmullRomCurve3(pts, !!rd.closed, 'centripetal', 0.5);
      // 急弯/山路加密采样：发夹弯 2m、山路 3m、普通路 4m，
      // 保证弯道处道路网格够细，路面不会因面数不足而凸起/起棱
      const stepM = rd.id === 'switchbacks' ? 1 : (rd.id === 'mountain' ? 1.5 : 2);
      const n = Math.ceil(curve.getLength() / stepM);
      const local = [];
      for (let i = 0; i <= n; i++) {
        const p = curve.getPoint(i / n);
        local.push({ x: p.x, z: p.z });
      }
      // 平滑道路高度
      for (const s of local) s.h = Math.max(this.localWaterLevel(s.x, s.z) + (NO_LAKES ? 0.6 : 1.8), this.baseHeight(s.x, s.z));
      for (let pass = 0; pass < 2; pass++) {
        const out = [];
        for (let i = 0; i < local.length; i++) {
          // 非闭合路不环绕首尾（否则起点会被终点高度污染，导致爬升基数虚高）
          const a = i === 0 ? (rd.closed ? local[local.length - 1].h : local[i].h) : local[i - 1].h;
          const b = local[i].h;
          const c = i === local.length - 1 ? (rd.closed ? local[0].h : local[i].h) : local[i + 1].h;
          out.push({ ...local[i], h: (a + b * 2 + c) / 4 });
        }
        local.length = 0; local.push(...out);
      }
      if (rd.climb) {
        const base = local[0].h;
        for (let i = 0; i < local.length; i++) {
          const t = i / Math.max(1, local.length - 1);
          const climbT = t * t * (3 - 2 * t);
          local[i].h = Math.max(local[i].h, base + rd.climb * climbT);
        }
      }
      let dist = 0;
      for (let i = 0; i < local.length; i++) {
        if (i > 0) dist += Math.hypot(local[i].x - local[i - 1].x, local[i].z - local[i - 1].z);
        local[i].d = dist;
        local[i].w = rd.w;
        local[i].mat = rd.mat;
        local[i].road = rd.id;
        local[i].closed = !!rd.closed;
      }
      all.push(...local);
      this.trafficRoutes.push({ id: rd.id, samples: local, closed: !!rd.closed });
    }
    for (let i = 0; i < all.length; i++) {
      const s = all[i];
      const cx = Math.floor((s.x + CFG.worldHalf) / cell), cz = Math.floor((s.z + CFG.worldHalf) / cell);
      if (cx >= 0 && cx < this.grid.length && cz >= 0 && cz < this.grid.length) {
        this.grid[cx][cz].push(i);
      }
    }
    // 路口高度统一：交叉路段 44m 内的采样相互加权平均（跨路权重 ×3），
    // 消除路口台阶/鼓包（否则车压上去会像撞石头一样起飞）
    const AVG_R = 44;
    for (let pass = 0; pass < 4; pass++) {
      const hs = all.map(s => s.h);
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        const cx = Math.floor((s.x + CFG.worldHalf) / cell), cz = Math.floor((s.z + CFG.worldHalf) / cell);
        let sum = hs[i], wsum = 1;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const ii = cx + dx, jj = cz + dz;
          if (ii < 0 || jj < 0 || ii >= this.grid.length || jj >= this.grid.length) continue;
          for (const k of this.grid[ii][jj]) {
            if (k === i) continue;
            const o = all[k];
            const d = Math.hypot(o.x - s.x, o.z - s.z);
            if (d < AVG_R) {
              const w = (1 - d / AVG_R) ** 2 * (o.road === s.road ? 1 : 3);
              sum += hs[k] * w;
              wsum += w;
            }
          }
        }
        all[i].h = sum / wsum;
      }
    }
    // 交叉口贴合：窄路贴宽路、支线贴环线、非起点路贴起点路——
    // 让重叠路面的采样直接对齐主路高度，杜绝连接处一条路被地形埋掉
    const gateDef0 = this.roadDefs.find(r => r.id === 'highway')
      || this.roadDefs.find(r => r.id === 'cross')
      || this.roadDefs.find(r => r.id === 'ring');
    const gateId = gateDef0 ? gateDef0.id : null;
    const shouldSnap = (s, o) => o.w > s.w + 2 || (o.closed && !s.closed) || (o.road === gateId && s.road !== gateId);
    const snapPass = (mix) => {
      const hs = all.map(s => s.h);
      for (let i = 0; i < all.length; i++) {
        const s = all[i];
        const cx = Math.floor((s.x + CFG.worldHalf) / cell), cz = Math.floor((s.z + CFG.worldHalf) / cell);
        let best = null;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          const ii = cx + dx, jj = cz + dz;
          if (ii < 0 || jj < 0 || ii >= this.grid.length || jj >= this.grid.length) continue;
          for (const k of this.grid[ii][jj]) {
            if (k === i) continue;
            const o = all[k];
            if (o.road === s.road) continue;
            const d = Math.hypot(o.x - s.x, o.z - s.z);
            if (shouldSnap(s, o) && d < s.w / 2 + o.w / 2 + 6 && (!best || d < best.d)) best = { d, h: o.h };
          }
        }
        if (best) s.h = hs[i] * (1 - mix) + best.h * mix;
      }
    };
    snapPass(0.9);
    snapPass(0.9);
    // —— 道路高度后处理流水线 ——
    // 1) 起点坡道放缓：开局 160m 限坡 5%，随后渐隐到 ~640m 恢复自然地势。
    //    避免起步就直爬陡坡，同时不会在限坡区末端留下断崖。
    if (gateDef0) {
      const gr = this.trafficRoutes.find(r => r.id === gateDef0.id);
      if (gr) {
        const arr = gr.samples;
        let si = 0, bd = 1e9;
        for (let i = 0; i < arr.length; i++) {
          const d = Math.hypot(arr[i].x, arr[i].z);
          if (d < bd) { bd = d; si = i; }
        }
        for (let pass = 0; pass < 5; pass++) {
          for (const dir of [1, -1]) {
            let prev = arr[si];
            for (let k = 1; k <= 160; k++) {
              const cur = arr[si + dir * k];
              if (!cur || cur.road !== gateDef0.id) break;
              const seg = Math.hypot(cur.x - prev.x, cur.z - prev.z) || 1;
              // 前 40 个采样（≈160m）完全限坡，之后渐隐到 160 个采样（≈640m）
              const w = k <= 40 ? 1 : Math.max(0, 1 - (k - 40) / 120);
              const t = clamp(cur.h, prev.h - seg * 0.07, prev.h + seg * 0.05);
              cur.h = cur.h + (t - cur.h) * w;
              prev = cur;
            }
          }
        }
        const k0 = Math.max(0, si - 160), k1 = Math.min(arr.length - 1, si + 160);
        for (let pass = 0; pass < 3; pass++) {
          const hs = arr.map(s => s.h);
          for (let k = k0; k <= k1; k++) {
            const a = hs[Math.max(k0, k - 1)], b = hs[k], c = hs[Math.min(k1, k + 1)];
            arr[k].h = (a + b * 2 + c) / 4;
          }
        }
      }
    }
    // 2) 纵坡限制：铺装路 ≤32%（约18°），土路 ≤42%（约23°）。
    //    短路多迭代几轮把接口高度差摊成斜坡，长路少迭代防止整体重塑。
    const capRoad = (r, iters, dirs, maxG) => {
      const arr = r.samples;
      const n = arr.length;
      if (n < 3) return;
      for (let it = 0; it < iters; it++) {
        let changed = false;
        for (const dir of dirs) {
          const start = dir === 1 ? 1 : n - 2;
          for (let i = start; i >= 0 && i < n; i += dir) {
            const a = arr[i - dir], b = arr[i];
            const d = Math.hypot(b.x - a.x, b.z - a.z) || 1;
            let h = b.h;
            if (h > a.h + d * maxG) h = a.h + d * maxG;
            else if (h < a.h - d * maxG) h = a.h - d * maxG;
            if (h !== b.h) { b.h = h; changed = true; }
          }
        }
        if (!changed) break;
      }
    };
    for (const r of this.trafficRoutes) {
      const maxG = r.samples[0].mat === 'dirt' ? 0.42 : 0.32;
      capRoad(r, r.samples.length <= 250 ? 8 : 3, [1, -1], maxG);
    }
    // 3) 限坡后再贴合一次接口，然后只向前推几轮，把接口高度差重新摊成斜坡
    snapPass(0.95);
    for (const r of this.trafficRoutes) {
      const maxG = r.samples[0].mat === 'dirt' ? 0.42 : 0.32;
      capRoad(r, 3, [1], maxG);
    }
    // 最终平滑：限坡/接口贴合会在道路高度上留下折角（坡面行驶上下震动的来源），
    // 对每条路再做两轮平滑，消除相邻采样点之间的坡度突变。
    for (const r of this.trafficRoutes) {
      const arr = r.samples;
      for (let pass = 0; pass < 2; pass++) {
        const newH = arr.map((s, i) => {
          const a = i === 0 ? (r.closed ? arr[arr.length - 1].h : arr[i].h) : arr[i - 1].h;
          const b = arr[i].h;
          const c = i === arr.length - 1 ? (r.closed ? arr[0].h : arr[i].h) : arr[i + 1].h;
          return (a + b * 2 + c) / 4;
        });
        for (let i = 0; i < arr.length; i++) arr[i].h = newH[i];
      }
    }
    this.samples = all;
    // 道路长度
    for (const r of this.trafficRoutes) r.length = r.samples[r.samples.length - 1].d;

    // —— 路段（相邻采样点连线）网格 ——
    // 距离取“到路段中心线的投影距离”，弯道内侧不会因采样点离散而冒出绿色鼓包；
    // 地形、物理、路面颜色全部按这个距离计算，保证路面完整性。
    this.segments = [];
    const sgN = Math.ceil(CFG.worldHalf * 2 / cell) + 2;
    this.segGrid = Array.from({ length: sgN }, () => Array.from({ length: sgN }, () => []));
    const idxMap = new Map(all.map((s, i) => [s, i]));
    for (const r of this.trafficRoutes) {
      const arr = r.samples;
      for (let k = 0; k < arr.length - 1; k++) {
        const a = arr[k], b = arr[k + 1];
        const g = {
          ax: a.x, az: a.z, bx: b.x, bz: b.z,
          l2: Math.max(1e-9, (b.x - a.x) ** 2 + (b.z - a.z) ** 2),
          a: idxMap.get(a), b: idxMap.get(b),
          road: a.road, w: a.w, mat: a.mat,
        };
        const si = this.segments.push(g) - 1;
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
        const c0 = Math.max(0, Math.floor((x0 + CFG.worldHalf) / cell));
        const c1 = Math.min(sgN - 1, Math.floor((x1 + CFG.worldHalf) / cell));
        const r0 = Math.max(0, Math.floor((z0 + CFG.worldHalf) / cell));
        const r1 = Math.min(sgN - 1, Math.floor((z1 + CFG.worldHalf) / cell));
        for (let ci = c0; ci <= c1; ci++) for (let rj = r0; rj <= r1; rj++) this.segGrid[ci][rj].push(si);
      }
    }
  }

  // 最近道路：返回“到路段中心线的投影距离”，h 用投影点在线段上的高度（线性插值）
  nearestRoad(x, z) {
    const cell = this.cell;
    const cx = Math.floor((x + CFG.worldHalf) / cell), cz = Math.floor((z + CFG.worldHalf) / cell);
    let best = null, bd = 1e9;
    if (!this.segGrid) return null;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const i = cx + dx, j = cz + dz;
      if (i < 0 || j < 0 || i >= this.segGrid.length || j >= this.segGrid.length) continue;
      for (const si of this.segGrid[i][j]) {
        const g = this.segments[si];
        const abx = g.bx - g.ax, abz = g.bz - g.az;
        let tt = ((x - g.ax) * abx + (z - g.az) * abz) / g.l2;
        if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
        const px = g.ax + abx * tt, pz = g.az + abz * tt;
        const d = Math.hypot(x - px, z - pz);
        if (d < bd) { bd = d; best = { g, tt, px, pz }; }
      }
    }
    if (!best) return null;
    const sA = this.samples[best.g.a], sB = this.samples[best.g.b];
    const segH = lerp(sA.h, sB.h, best.tt);
    const near = best.tt < 0.5 ? sA : sB;
    return { s: near, d: bd, t: best.tt, segH, px: best.px, pz: best.pz };
  }

  // 交叉口多路段加权高度：取 40m 内所有道路路段按距离加权平均。
  // 轮子 raycast 兜底用它，避免在交叉口从一条路切到另一条路时
  // 高度跳变（0.5~1.5m）把车身顶得坑坑洼洼/上下抖。
  multiRoadHeight(x, z) {
    const cell = this.cell;
    const cx = Math.floor((x + CFG.worldHalf) / cell), cz = Math.floor((z + CFG.worldHalf) / cell);
    if (!this.segGrid) return null;
    let sum = 0, wsum = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const i = cx + dx, j = cz + dz;
      if (i < 0 || j < 0 || i >= this.segGrid.length || j >= this.segGrid.length) continue;
      for (const si of this.segGrid[i][j]) {
        const g = this.segments[si];
        const abx = g.bx - g.ax, abz = g.bz - g.az;
        let tt = ((x - g.ax) * abx + (z - g.az) * abz) / g.l2;
        if (tt < 0) tt = 0; else if (tt > 1) tt = 1;
        const px = g.ax + abx * tt, pz = g.az + abz * tt;
        const d = Math.hypot(x - px, z - pz);
        if (d < 40) {
          const sA = this.samples[g.a], sB = this.samples[g.b];
          const h = lerp(sA.h, sB.h, tt);
          const w = (1 - d / 40) ** 2;
          sum += h * w; wsum += w;
        }
      }
    }
    return wsum > 0 ? sum / wsum : null;
  }

  terrainHeight(x, z) {
    let h = this.baseHeight(x, z);
    const nr = this.nearestRoad(x, z);
    // 路面带：中心线两侧 55m 完全压平到路面高度（覆盖整条路面 + 宽路肩），
    // 再在 55→150m 平滑过渡到原野。硬压平区足够宽后，高度场 6.75m 网格
    // 的线性插值不会在压平带边界形成“隆起”托住车身（这是交叉口开不动的
    // 终极根因），同时保证任何地形网格角点都不会高于路面。
    if (nr && nr.d < nr.s.w / 2 + 150) {
      const hard = nr.s.w / 2 + 55;
      const w = nr.d < hard ? 1 : 1 - smoothstep(hard, nr.s.w / 2 + 150, nr.d);
      h = lerp(h, nr.segH, w);
    }
    // 开发者模式地形编辑：双线性插值叠加高度偏移
    if (this.heightEdit) {
      const N = HF_N;
      const es = CFG.worldHalf * 2 / (N - 1);
      const fx = (x + CFG.worldHalf) / es;
      const fz = (CFG.worldHalf - z) / es;
      let i0 = Math.floor(fx), j0 = Math.floor(fz);
      if (i0 < 0) i0 = 0; else if (i0 > N - 1) i0 = N - 1;
      if (j0 < 0) j0 = 0; else if (j0 > N - 1) j0 = N - 1;
      const i1 = Math.min(N - 1, i0 + 1), j1 = Math.min(N - 1, j0 + 1);
      const ti = Math.max(0, Math.min(1, fx - i0));
      const tj = Math.max(0, Math.min(1, fz - j0));
      const a = this.heightEdit[i0 * N + j0];
      const b = this.heightEdit[i0 * N + j1];
      const c = this.heightEdit[i1 * N + j0];
      const d = this.heightEdit[i1 * N + j1];
      h += (a * (1 - ti) + c * ti) * (1 - tj) + (b * (1 - ti) + d * ti) * tj;
    }
    // 路面支撑：完全压平带（路面中心线两侧 w/2+55m）内，任何地形编辑
    // 都不允许低于路面高度，防止路面悬空或被挖空
    if (nr && nr.d < nr.s.w / 2 + 55) {
      h = Math.max(h, nr.segH);
    }
    return h;
  }

  // 开发者模式：笔刷抬/降地形（delta > 0 抬升）
  applyHeightBrush(cx, cz, radius, delta) {
    if (!this.heightEdit) return;
    const N = HF_N;
    const es = CFG.worldHalf * 2 / (N - 1);
    const i0 = Math.max(0, Math.floor((cx - radius + CFG.worldHalf) / es));
    const i1 = Math.min(N - 1, Math.ceil((cx + radius + CFG.worldHalf) / es));
    const j0 = Math.max(0, Math.floor((CFG.worldHalf - (cz + radius)) / es));
    const j1 = Math.min(N - 1, Math.ceil((CFG.worldHalf - (cz - radius)) / es));
    for (let i = i0; i <= i1; i++) {
      const x = -CFG.worldHalf + i * es;
      for (let j = j0; j <= j1; j++) {
        const z = CFG.worldHalf - j * es;
        const d = Math.hypot(x - cx, z - cz);
        if (d < radius) {
          const w = Math.cos(d / radius * Math.PI / 2); // 边缘柔和衰减
          this.heightEdit[i * N + j] += delta * w;
        }
      }
    }
  }

  // 开发者模式：地形编辑后原地同步渲染网格与物理高度场（分片执行避免卡死）
  async syncTerrainAfterEdit(onProgress) {
    const N = HF_N;
    const geo = this.terrainMesh.geometry;
    const pos = geo.attributes.position;
    const total = pos.count;
    // 固定块大小分片：每块 ~20 万次计算后让出一帧，页面保持可响应
    const CHUNK = 200000;
    const runSlice = async (count, fn) => {
      let i = 0;
      while (i < count) {
        const end = Math.min(count, i + CHUNK);
        while (i < end) fn(i++);
        if (i < count) {
          if (onProgress) onProgress(i / count);
          await new Promise(r => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => r();
            ch.port2.postMessage(null);
          });
        }
      }
    };
    await runSlice(total, i => pos.setY(i, this.terrainHeight(pos.getX(i), pos.getZ(i))));
    geo.computeVertexNormals();
    const colors = geo.attributes.color;
    const nrm = geo.attributes.normal;
    const col = new THREE.Color();
    await runSlice(total, i => {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const slope = 1 - nrm.getY(i);
      this.terrainColor(x, y, z, slope, col);
      colors.setXYZ(i, col.r, col.g, col.b);
    });
    pos.needsUpdate = true;
    colors.needsUpdate = true;
    geo.computeBoundingSphere();
    if (this.physics && this.physics.ground) {
      const hf = this.physics.ground.shapes[0];
      const data = hf.data;
      const es = CFG.worldHalf * 2 / (N - 1);
      const RCHUNK = 200;
      let i = 0;
      while (i < N) {
        const end = Math.min(N, i + RCHUNK);
        while (i < end) {
          const x = -CFG.worldHalf + i * es;
          const colArr = data[i];
          for (let j = 0; j < N; j++) {
            const z = CFG.worldHalf - j * es;
            colArr[j] = this.terrainHeight(x, z);
          }
          i++;
        }
        if (i < N) {
          if (onProgress) onProgress(0.75 + i / N * 0.25);
          await new Promise(r => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => r();
            ch.port2.postMessage(null);
          });
        }
      }
      this.physics.ground.updateAABB();
    }
    if (onProgress) onProgress(1);
  }

  // 开发者模式：把手绘路点建成一条新路并重建道路/地形
  async addDevRoad(pts) {
    const id = 'devroad' + (this.devRoadN = (this.devRoadN || 0) + 1);
    this.roadDefs.push({
      id, w: 12, mat: 'asphalt', pts: pts.map(p => [Math.round(p[0]), Math.round(p[1])]),
    });
    // 移除旧道路物理网格
    for (const b of this.roadBodies || []) {
      try { this.physics.cannon.removeBody(b); } catch (e) { /* ignore */ }
    }
    this.roadBodies = [];
    for (const m of this.roadMeshes || []) this.scene.remove(m);
    this.roadMeshes = [];
    this.trafficRoutes = [];
    this.samples = [];
    this.grid = null;
    this.segments = [];
    this.segGrid = null;
    this.buildRoads();
    this.buildRoadMeshes();
    await this.syncTerrainAfterEdit();
  }

  getSurface(x, z, y) {
    // 外部 GLB 城市：模型范围内的街道/人行道统一视为可行驶路面
    // （街道物理由 GLB 三角网格 cannon Trimesh 提供）
    if (this.map.id === 'city3' && this.glbDriveBounds) {
      const b = this.glbDriveBounds;
      if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1) {
        return { muMul: 1, grip: 1.0, road: true };
      }
    }
    // 城市高架桥面：视觉/物理都在空中，地面 nearestRoad 查不到，
    // 由 buildCityOverpasses 注册的 citySurfaces 提供路面抓地。
    if (this.isCity && y != null && this.citySurfaceAt) {
      const cs = this.citySurfaceAt(x, y, z);
      if (cs) return cs;
    }
    const nr = this.nearestRoad(x, z);
    if (nr && nr.d < nr.s.w / 2 + 2.0) {
      if (nr.s.mat === 'dirt') return { muMul: 0.82, grip: 0.92, road: true };
      if (this.season === 3) return { muMul: 0.85, grip: 0.9, road: true };
      return { muMul: 1, grip: 1, road: true };
    }
    const h = this.terrainHeight(x, z);
    const wl = this.localWaterLevel(x, z);
    if (h < wl + 0.4) return { muMul: 0.42, grip: 0.35, road: false };
    if (this.season === 3 && h > wl + 0.4) return { muMul: 0.72, grip: 0.72, road: false };
    if (h < wl + 2.4) return { muMul: 0.75, grip: 0.68, road: false };
    return { muMul: 0.85, grip: 0.78, road: false };
  }

  // 高架桥面的抓地判定：水平落在桥面带宽内、垂直贴近桥面高度才算“在桥上”
  citySurfaceAt(x, y, z) {
    if (!this.citySurfaces) return null;
    for (const seg of this.citySurfaces) {
      const abx = seg.bx - seg.ax, abz = seg.bz - seg.az;
      const l2 = abx * abx + abz * abz || 1;
      let tt = ((x - seg.ax) * abx + (z - seg.az) * abz) / l2;
      tt = tt < 0 ? 0 : (tt > 1 ? 1 : tt);
      const px = seg.ax + abx * tt, pz = seg.az + abz * tt;
      const d = Math.hypot(x - px, z - pz);
      const sy = seg.ay + (seg.by - seg.ay) * tt;
      if (d < seg.w / 2 + 1.6 && Math.abs(y - sy) < 1.8) {
        return { muMul: 1, grip: 1.02, road: true };
      }
    }
    return null;
  }

  // 城市高架路：生成 3D 采样（桥面/匝道高度剖面）→ 注册抓地面 → 建 cannon Trimesh。
  // 视觉桥面/护栏/桥墩由 city_roads_engine.js 读取 this.overpasses 绘制。
  buildCityOverpasses() {
    if (!this.isCity || !this.map.overpasses) return;
    this.overpasses = [];
    this.citySurfaces = this.citySurfaces || [];
    const SEG = 40;
    for (const op of this.map.overpasses) {
      const out = { id: op.id, w: op.w, decks: [] };
      const buildCurve = (pts, mode) => {
        const curve = new THREE.CatmullRomCurve3(
          pts.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal', 0.5
        );
        const n = Math.ceil(curve.getLength() / 2);
        const arr = [];
        for (let i = 0; i <= n; i++) {
          const p = curve.getPoint(i / n);
          arr.push({ x: p.x, z: p.z });
        }
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i];
          const ground = this.terrainHeight(s.x, s.z);
          const t = i / Math.max(1, arr.length - 1);
          let h;
          if (mode === 'main') {
            // 主桥：全程保持净空，两端与匝道桥面端同高衔接
            h = ground + op.clearance;
          } else {
            // 匝道：从桥面端平滑降坡到接地端
            const slope = smoothstep(0, 1, t);
            h = lerp(ground + op.clearance, ground, slope);
          }
          s.y = h + op.deckThick / 2;
        }
        // 桥面抓地段（供 getSurface）
        for (let i = 0; i < arr.length - 1; i++) {
          const a = arr[i], b = arr[i + 1];
          this.citySurfaces.push({ ax: a.x, az: a.z, ay: a.y, bx: b.x, bz: b.z, by: b.y, w: op.w });
        }
        // 物理三角网格（与视觉共用采样，误差 0）
        if (this.physics && this.physics.cannon) {
          const w2 = op.w / 2 + 1.2;
          for (let s0 = 0; s0 < arr.length - 1; s0 += SEG) {
            const s1 = Math.min(arr.length, s0 + SEG + 1);
            const verts = [];
            for (let i = s0; i < s1; i++) {
              const s = arr[i];
              const s2 = arr[Math.min(i + 1, arr.length - 1)];
              const tx = s2.x - s.x, tz = s2.z - s.z;
              const tl = Math.hypot(tx, tz) || 1;
              const nx = -tz / tl, nz = tx / tl;
              verts.push(s.x + nx * w2, s.y + 0.06, s.z + nz * w2);
              verts.push(s.x - nx * w2, s.y + 0.06, s.z - nz * w2);
            }
            const faces = [];
            for (let i = 0; i < verts.length / 2 - 1; i++) {
              const a = i * 2, b = i * 2 + 1, c = a + 2, d = b + 2;
              faces.push(a, c, b, b, c, d);
            }
            if (faces.length < 3) continue;
            const shape = new CANNON.Trimesh(verts, faces);
            if (shape.updateTree) shape.updateTree();
            const body = new CANNON.Body({ mass: 0, collisionFilterGroup: 2, collisionFilterMask: 1 });
            body.addShape(shape);
            body.updateAABB();
            this.physics.cannon.addBody(body);
            (this.roadBodies = this.roadBodies || []).push(body);
          }
        }
        return arr;
      };
      out.decks.push({ kind: 'main', pts: buildCurve(op.main, 'main') });
      if (op.rampA) out.decks.push({ kind: 'ramp', pts: buildCurve(op.rampA, 'ramp') });
      if (op.rampB) out.decks.push({ kind: 'ramp', pts: buildCurve(op.rampB, 'ramp') });
      this.overpasses.push(out);
    }
  }

  // ================= 地形网格 =================
  buildTerrain() {
    // 渲染网格（801×801）与物理高度场（1201×1201）使用同一 terrainHeight 函数，
    // 路面边缘不再有渲染插值鼓包
    const seg = 800;
    const geo = new THREE.PlaneGeometry(CFG.worldHalf * 2, CFG.worldHalf * 2, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.terrainHeight(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const colors = new Float32Array(pos.count * 3);
    const nrm = geo.attributes.normal;
    const col = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const slope = 1 - nrm.getY(i);
      this.terrainColor(x, y, z, slope, col);
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    // 地表细节纹理：高频草纹 + 稀疏土斑，叠加在顶点色上，打破“纯色布”
    // 城市地图用更柔和的噪点（评审反馈：原纹理在城区显脏、重复感强）
    const isCity = this.isCity;
    const detailTex = canvasTex(256, 256, c => {
      c.fillStyle = '#808080';
      c.fillRect(0, 0, 256, 256);
      const n = isCity ? 9000 : 20000;
      for (let i = 0; i < n; i++) {
        const g = isCity ? 118 + Math.random() * 30 : 105 + Math.random() * 55;
        c.fillStyle = `rgba(${g},${g},${g},${isCity ? 0.22 : 0.55})`;
        c.fillRect(Math.random() * 256, Math.random() * 256, 1.5 + Math.random() * 1.5, 1.5 + Math.random() * 1.5);
      }
      const blotches = isCity ? 26 : 70;
      for (let i = 0; i < blotches; i++) {
        c.fillStyle = isCity ? 'rgba(110,116,108,0.16)' : 'rgba(70,64,50,0.35)';
        c.beginPath();
        c.ellipse(Math.random() * 256, Math.random() * 256, 12 + Math.random() * 24, 8 + Math.random() * 16, Math.random() * 3, 0, TAU);
        c.fill();
      }
    });
    detailTex.wrapS = THREE.RepeatWrapping;
    detailTex.wrapT = THREE.RepeatWrapping;
    detailTex.repeat.set(isCity ? 90 : 240, isCity ? 90 : 240);
    // PBR 材质：车灯/路灯在野外草地也能逐像素投出平滑光斑（Lambert 是逐顶点，会一块一块）
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTex, metalness: 0, roughness: isCity ? 0.9 : 0.95 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.terrainMesh = mesh;
    this.scene.add(mesh);
    this.smoke = new TireSmoke(this.scene);
    this.tailTrail = new RibbonLightTrail(this.scene);
    this.tailTrailBox = new RibbonLightTrail(this.scene, true, 0.04); // 长方体光管(左右各一条,薄)
    this.buildDriftZones();
  }

  // ================= AI 漂移场地：圆形跑道 / U 形弯 =================
  buildDriftZones() {
    const scene = this.scene;
    // 三个不同半径的圆形漂移跑道（选平坦开阔处）
    this.driftCircles = this.map.driftCircles || [
      { x: -950, z: -900, R: 25, name: '小圆 R25', dur: 18 },
      { x: 1300, z: 1200, R: 45, name: '中圆 R45', dur: 22 },
      { x: 1700, z: 300, R: 70, name: '大圆 R70', dur: 26 },
    ];
    for (const c of this.driftCircles) {
      const y = this.terrainHeight(c.x, c.z) + 0.08;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(c.R - 0.7, c.R + 0.7, 72),
        new THREE.MeshBasicMaterial({ color: 0xff5252, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(c.x, y, c.z);
      scene.add(ring);
      this.driftVisuals = this.driftVisuals || [];
      this.driftVisuals.push(ring);
      const inner = new THREE.Mesh(
        new THREE.RingGeometry(c.R - 2.6, c.R - 0.9, 72),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false })
      );
      inner.rotation.x = -Math.PI / 2;
      inner.position.set(c.x, y, c.z);
      scene.add(inner);
      this.driftVisuals.push(inner);
    }
    // U 形弯赛道：三段 180° 掉头（供拉力漂移车表演）
    this.uturnCourse = this.map.uturnCourse || {
      pts: [
        [-1620, -2180], [-1480, -2180],
        [-1420, -2190], [-1440, -2210], [-1480, -2220], [-1620, -2220],
        [-1680, -2220], [-1680, -2180], [-1620, -2180], [-1480, -2180],
        [-1420, -2190], [-1440, -2210], [-1480, -2220], [-1620, -2220],
        [-1680, -2220], [-1680, -2180],
      ],
    };
    const lineMat = new THREE.MeshBasicMaterial({ color: 0x6ecbff, transparent: true, opacity: 0.72, depthWrite: false });
    const pts = this.uturnCourse.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      const seg = new THREE.Mesh(new THREE.BoxGeometry(len, 0.05, 2.2), lineMat);
      seg.rotation.y = -Math.atan2(dz, dx);
      seg.position.set((a[0] + b[0]) / 2, this.terrainHeight((a[0] + b[0]) / 2, (a[1] + b[1]) / 2) + 0.06, (a[1] + b[1]) / 2);
      scene.add(seg);
      this.driftVisuals = this.driftVisuals || [];
      this.driftVisuals.push(seg);
    }
    // 掉头顶点标记
    for (const [px, pz] of [[-1420, -2200], [-1680, -2200]]) {
      const dot = new THREE.Mesh(
        new THREE.RingGeometry(1.6, 3.4, 24),
        new THREE.MeshBasicMaterial({ color: 0xffd25e, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
      );
      dot.rotation.x = -Math.PI / 2;
      this.driftVisuals.push(dot);
      dot.position.set(px, this.terrainHeight(px, pz) + 0.07, pz);
      scene.add(dot);
    }
  }

  // 实体物理地面：高度场覆盖整个世界
  buildPhysics() {
    this.physics = new PhysicsWorld(this);
    if (!this.heightEdit) this.heightEdit = new Float32Array(HF_N * HF_N);
  }

  terrainColor(x, y, z, slope, out) {
    const S = this.seasons[this.season];
    const n = Noise.fbm(x * 0.004 + 5, z * 0.004 - 9, 2);
    const grain = Noise.fbm(x * 0.02 + 9, z * 0.02 - 3, 2);
    const field = Noise.fbm(x * 0.0007 + 400, z * 0.0007 - 300, 2);
    let c;
    const wl = this.localWaterLevel(x, z);
    if (y < wl + 0.45) {
      c = mixColor(0x9eb79b, 0x6f8a63, clamp((y - wl + 0.45) / 0.9, 0, 1));
      c = mixColor(0xcdd5b8, c, clamp((y - wl + 0.2) / 0.6, 0, 1));
    } else if (slope > 0.34) {
      c = mixColor(0x8b8679, 0x6e6a5f, n);
    } else if (field > 0.6 && Math.abs(x - 1050) < 900 && Math.abs(z - 500) < 900) {
      c = mixColor(S.field, 0x8b7b3e, n * 0.5);
    } else {
      c = mixColor(S.grassA, S.grassB, n);
    }
    // 细颗粒草纹：让草地不再是纯色纸片
    c = mixColor(c, mixColor(S.grassA, 0x2f7a24, grain), 0.16);
    // 低频斑驳：大块深浅草色交错，打破“纯色平面”
    const mottle = Noise.fbm(x * 0.0012 + 77, z * 0.0012 - 41, 3);
    c = mixColor(c, mixColor(S.grassA, 0x2e521f, mottle), 0.16);
    // 海特洛市：低饱和公园灰绿 + 南侧沙滩 + 北侧山体
    if (this.isCity) {
      c = mixColor(0x7fa56a, 0x8fb478, n);
      if (z < -1450) c = mixColor(c, 0xe2d6a6, smoothstep(-1720, -1520, z) * 0.9);
      const mtn = smoothstep(1250, 2150, z);
      c = mixColor(c, 0x6f7d68, mtn * 0.55);
    }
    // 阿尔卑斯地图：高山雪线 + 暖色岩壁 + 湖岸沙滩
    if (this.map.id === 'alpine') {
      if (y > 270) {
        const snow = clamp((y - 270) / 110, 0, 1);
        c = mixColor(c, 0xf8fbfc, snow * 0.92);
      } else if (y > 200) {
        const rock = clamp((y - 200) / 80, 0, 1) * (0.35 + 0.65 * clamp(slope * 3, 0, 1));
        c = mixColor(c, 0x7e7468, rock * 0.8);
      }
      const shore = this.lakeMask(x, z);
      if (shore > 0.15 && shore < 0.58) {
        const sand = 1 - Math.abs(shore - 0.36) / 0.22;
        c = mixColor(c, 0xe0c27a, clamp(sand, 0, 1) * 0.85);
      }
    }
    // 路面覆盖范围内铺沥青色：路口/弯道两条路带之间的间隙也像路面，
    // 砂石草皮不会“长进”路面
    const nr = this.nearestRoad(x, z);
    if (nr && nr.d < nr.s.w / 2 + 2.5) {
      // 覆盖范围内全强度沥青，路肩边缘不会透出绿色
      c = mixColor(c, 0x2e3136, 0.92);
    } else if (nr && !this.isCity && nr.d < nr.s.w / 2 + 150) {
      // 路肩碎石带：与物理压平带（55m）和缓坡带（150m）对齐
      // 城市地图跳过：150m 土黄路肩会让街道显得几十米宽、荒凉
      const sh = 1 - smoothstep(nr.s.w / 2 + 55, nr.s.w / 2 + 150, nr.d);
      c = mixColor(c, 0x8f8263, sh * 0.8);
    }
    if (this.season === 3 && !this.isCity) {
      c = mixColor(0xf0f3ef, 0xe0e5df, clamp(slope * 2.2, 0, 1));
      if (slope > 0.34) c = mixColor(0xcfd4cf, 0x8d918a, clamp((slope - 0.34) / 0.4, 0, 1));
    }
    out.setHex(c);
  }

  // ================= 道路网格 =================
  buildRoadMeshes() {
    const byRoad = {};
    for (const s of this.samples) (byRoad[s.road] = byRoad[s.road] || []).push(s);
    const rt = this.roadTex || {};
    for (const [id, arr] of Object.entries(byRoad)) {
      const rd = this.roadDefs.find(r => r.id === id);
      const isDirt = rd.mat === 'dirt';
      const tex = isDirt ? (rt.gravel || makeRoadTexture(true)) : (rt.asphalt || makeRoadTexture(false));
      tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(1, 1);
      // 用 PBR 材质替代 Lambert：车灯/路灯能逐像素投射出平滑光斑（Lambert 是逐顶点，光斑粗糙）
      const mat = new THREE.MeshStandardMaterial({ map: tex, metalness: 0, roughness: isDirt ? 0.95 : 0.92 });
      mat.userData.isDirt = isDirt;
      mat.userData.dryRoughness = isDirt ? 0.95 : 0.92; // 记录干燥粗糙度，雨天按路面类型区分反光
      (this.roadMats = this.roadMats || []).push(mat);
      const positions = [], uvs = [], indices = [];
      // 网格比路面宽 1.2m/侧，覆盖弯道弦切与路口交界，地形不再从边缘露出
      const w2 = rd.w / 2 + 1.2;
      const vScale = w2 * 2;
      let nx = 0, nz = 1;
      const pushV = (px, pz, ph, pd) => {
        positions.push(px + nx * w2, ph + 0.08, pz + nz * w2);
        positions.push(px - nx * w2, ph + 0.08, pz - nz * w2);
        uvs.push(0, pd / vScale); uvs.push(1, pd / vScale);
      };
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        const s2 = arr[Math.min(i + 1, arr.length - 1)];
        const tx = s2.x - s.x, tz = s2.z - s.z;
        const tl = Math.hypot(tx, tz) || 1;
        nx = -tz / tl; nz = tx / tl;
        pushV(s.x, s.z, s.h, s.d);
        if (i < arr.length - 1) {
          // 细分中点：所有道路面数翻倍，急弯处更平滑，不会因面数不足凸起
          pushV((s.x + s2.x) / 2, (s.z + s2.z) / 2, (s.h + s2.h) / 2, (s.d + s2.d) / 2);
        }
      }
      for (let i = 0; i < positions.length / 2 - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = a + 2, d = b + 2;
        indices.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(indices);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true;
      this.scene.add(m);
      this.roadMeshes = this.roadMeshes || [];
      this.roadMeshes.push(m);
      this.buildRoadPhysicsMesh(arr, rd.w);
    }
    // 城市地图的车道线/路口标线由 city_roads_engine.js 统一绘制
    // （旧的全路直画会在路口重叠打架，城市路网不使用）
    if (!this.isCity) this.buildLaneMeshes(byRoad);
  }

  // 车道线独立覆盖层：高分辨率贴图 + 真实虚线比例，
  // 不随沥青颗粒一起被 mipmap 糊成一条黄带
  buildLaneMeshes(byRoad) {
    const lineTex = makeLaneTexture();
    lineTex.wrapS = THREE.RepeatWrapping;
    lineTex.wrapT = THREE.RepeatWrapping;
    // 黄虚线很细，mipmap 会把 alpha 平均没；关掉 mipmap 保持远近都清晰
    lineTex.generateMipmaps = false;
    lineTex.minFilter = THREE.LinearFilter;
    lineTex.magFilter = THREE.LinearFilter;
    const mat = new THREE.MeshLambertMaterial({ map: lineTex, transparent: true, depthWrite: false });
    const tile = 40;
    for (const [id, arr] of Object.entries(byRoad)) {
      const rd = this.roadDefs.find(r => r.id === id);
      if (!rd || rd.mat === 'dirt') continue;
      const w2 = rd.w / 2 + 1.2;
      const positions = [], uvs = [], indices = [];
      let nx = 0, nz = 1;
      const pushV = (px, pz, ph, pd) => {
        positions.push(px + nx * w2, ph + 0.11, pz + nz * w2);
        positions.push(px - nx * w2, ph + 0.11, pz - nz * w2);
        uvs.push(0, pd / tile); uvs.push(1, pd / tile);
      };
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        const s2 = arr[Math.min(i + 1, arr.length - 1)];
        const tx = s2.x - s.x, tz = s2.z - s.z;
        const tl = Math.hypot(tx, tz) || 1;
        nx = -tz / tl; nz = tx / tl;
        pushV(s.x, s.z, s.h, s.d);
        if (i < arr.length - 1) {
          pushV((s.x + s2.x) / 2, (s.z + s2.z) / 2, (s.h + s2.h) / 2, (s.d + s2.d) / 2);
        }
      }
      for (let i = 0; i < positions.length / 2 - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = a + 2, d = b + 2;
        indices.push(a, c, b, b, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      g.setIndex(indices);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = 1;
      this.roadMeshes = this.roadMeshes || [];
      this.roadMeshes.push(m);
      this.scene.add(m);
    }
  }

  async loadRoadTextures() {
    this.roadTex = await loadRoadTextures();
    return this.roadTex;
  }

  // 道路物理网格：用原始道路采样（未细分）切成 ~40 间隔/段的 cannon Trimesh。
  // 这样车轮 raycast 命中的路面与视觉完全一致（误差 0），
  // 高度场只负责越野；交叉口/陡坡不再因网格插值悬空或顶起。
  // 段数控制在 ~330 个，既让 SAP broadphase 可承受，
  // 又保持分段接触稳定（整条路 1 段会把车弹飞）。
  buildRoadPhysicsMesh(arr, w) {
    if (!this.physics || !this.physics.cannon) return;
    const w2 = w / 2 + 1.2;
    const n = arr.length;
    if (n < 3) return;
    const SEG = 40; // 每段 40 个样本间隔
    for (let s0 = 0; s0 < n - 1; s0 += SEG) {
      const s1 = Math.min(n, s0 + SEG + 1);
      const verts = [];
      for (let i = s0; i < s1; i++) {
        const s = arr[i];
        const s2 = arr[Math.min(i + 1, n - 1)];
        const tx = s2.x - s.x, tz = s2.z - s.z;
        const tl = Math.hypot(tx, tz) || 1;
        const nx = -tz / tl, nz = tx / tl;
        verts.push(s.x + nx * w2, s.h + 0.08, s.z + nz * w2);
        verts.push(s.x - nx * w2, s.h + 0.08, s.z - nz * w2);
      }
      const faces = [];
      for (let i = 0; i < verts.length / 2 - 1; i++) {
        const a = i * 2, b = i * 2 + 1, c = a + 2, d = b + 2;
        faces.push(a, c, b, b, c, d);
      }
      if (faces.length < 3) continue;
      const shape = new CANNON.Trimesh(verts, faces);
      if (shape.updateTree) shape.updateTree();
      // 道路网格不参与车身接触（Trimesh 接触会把车弹飞），只被车轮 raycast 命中：
      // 车身由高度场支撑，悬架行程（rest 0.46+travel 0.42）足以跨过
      // 交叉口 0.6m 落差命中路面，悬挂力再把车身撑到路面高度。
      // Ray 默认 group/mask=-1，与 group=2 有交集 → 轮子 raycast 正常命中。
      const body = new CANNON.Body({ mass: 0, collisionFilterGroup: 2, collisionFilterMask: 1 });
      body.addShape(shape);
      body.updateAABB();
      this.physics.cannon.addBody(body);
      (this.roadBodies = this.roadBodies || []).push(body);
    }
  }

  // ================= 植被与场景物件 =================
  async placeProps() {
    // 城市系地图：跳过阿尔卑斯植被/村庄/风车/指路牌等硬编码内容。
    if (this.isCity) {
      this._pineData = [];
      this._oakData = [];
      this.foliageMeshes = [];
      this.buildCityOverpasses();
      this.buildStartGate();
      if (this.map.id === 'city3') {
        // 外部 GLB 城市：加载模型 + 天空/后处理/接触阴影
        if (window.CITY_GLB && window.CITY_GLB.build) await window.CITY_GLB.build(this);
        else throw new Error('city_glb.js 未加载');
      } else if (window.CITY && window.CITY.buildAll) {
        window.CITY.buildAll(this);
      }
      return;
    }
    const rng = makeRng(20260731);
    // 非城市地图：还原城市色彩分级与晕影
    if (window.CITY && window.CITY.applyGrade) window.CITY.applyGrade(false);
    const scene = this.scene;
    const colliders = this.colliders;
    const treeData = this.treeData;

    const ok = (x, z, minD, maxH) => {
      if (Math.abs(x) > 2480 || Math.abs(z) > 2480) return false;
      const h = this.terrainHeight(x, z);
      if (h < this.localWaterLevel(x, z) + 0.7 || h > maxH) return false;
      const nr = this.nearestRoad(x, z);
      if (nr && nr.d < minD) return false;
      if (!NO_LAKES) {
        if (this.map.lake && Math.hypot(x - this.map.lake.cx, z - this.map.lake.cz) < this.map.lake.r + 45) return false;
        for (const L2 of EXTRA_LAKES) {
          if (Math.hypot(x - L2.cx, z - L2.cz) < L2.r + 30) return false;
        }
      }
      // 圆形漂移跑道与 U 形弯赛道周围留空，避免 AI/玩家撞树
      for (const c of this.driftCircles) {
        if (Math.hypot(x - c.x, z - c.z) < c.R + 26) return false;
      }
      if (Math.abs(x + 1600) < 170 && Math.abs(z + 2200) < 95) return false;
      const h2 = this.terrainHeight(x + 7, z + 5);
      return Math.abs(h2 - h) < 9;
    };

    const bushPos = [], rockPos = [], hayPos = [], lampPos = [], tuftPos = [], flowerPos = [];
    let guard = 0;
    // 成林生成：先撒树丛中心，再聚簇生长，最后补零星散树；
    // 第三位 = 巨树标记（更高更大，只出现在远离道路的平原深处）
    const genTrees = (count, roadClear, maxH, avoidX, clumps, clumpR) => {
      const pts = [];
      const centers = [];
      guard = 0;
      while (centers.length < clumps && guard++ < 40000) {
        const x = rng() * 4900 - 2450, z = rng() * 4900 - 2450;
        if (ok(x, z, roadClear + 8, maxH)) centers.push([x, z]);
      }
      for (const [cx, cz] of centers) {
        const n = 16 + Math.floor(rng() * 16);
        for (let k = 0; k < n && pts.length < count; k++) {
          const a = rng() * TAU;
          const r = Math.sqrt(rng()) * (14 + rng() * clumpR);
          const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
          if (ok(x, z, roadClear, maxH) && (avoidX == null || Math.abs(x - avoidX) > 260)) {
            pts.push([x, z, rng() < 0.16 ? 1 : 0]);
          }
        }
      }
      guard = 0;
      while (pts.length < count && guard++ < 90000) {
        const x = rng() * 4900 - 2450, z = rng() * 4900 - 2450;
        if (ok(x, z, roadClear, maxH) && (avoidX == null || Math.abs(x - avoidX) > 260)) {
          pts.push([x, z, rng() < 0.12 ? 1 : 0]);
        }
      }
      return pts;
    };
    // 平原树：数量更多、成片成林（松林偏高海拔，橡树偏低海拔）
    const pinePos = genTrees(3400, 16, 340, null, 170, 70);
    const oakPos = genTrees(2600, 18, 160, 820, 130, 60);
    guard = 0;
    while (bushPos.length < 900 && guard++ < 70000) {
      const x = rng() * 4800 - 2400, z = rng() * 4800 - 2400;
      if (ok(x, z, 8, 220)) bushPos.push([x, z]);
    }
    guard = 0;
    while (rockPos.length < 150 && guard++ < 30000) {
      const x = rng() * 4800 - 2400, z = rng() * 4800 - 2400;
      if (ok(x, z, 18, 360)) rockPos.push([x, z]);
    }
    guard = 0;
    while (hayPos.length < 130 && guard++ < 20000) {
      const x = rng() * 4400 - 2200, z = rng() * 4400 - 2200;
      const h = this.terrainHeight(x, z);
      const f = Noise.fbm(x * 0.0007 + 400, z * 0.0007 - 300, 2);
      if (f > 0.62 && h > this.localWaterLevel(x, z) + 0.8 && h < 90) {
        const nr = this.nearestRoad(x, z);
        if (!nr || nr.d > 35) hayPos.push([x, z]);
      }
    }

    // 路侧参照树：沿道路两侧稀疏种树（数量比之前少约一半），保留速度参照感但不再像墙
    for (const r of this.trafficRoutes) {
      const arr = r.samples;
      const treeDist = r.id === 'coast' ? 15 : 8; // 竞速环线旁的树更远，防止撞树
      for (let i = 0; i < arr.length; i += 7 + Math.floor(rng() * 8)) {
        const s = arr[i];
        if (rng() < 0.35) continue; // 稀疏化：一部分样本完全不种
        const s2 = arr[Math.min(i + 2, arr.length - 1)];
        const tx = s2.x - s.x, tz = s2.z - s.z;
        const tl = Math.hypot(tx, tz) || 1;
        for (const side of [1, -1]) {
          const d = s.w / 2 + treeDist + rng() * (r.id === 'coast' ? 8 : 6);
          const x = s.x + (-tz / tl) * side * d;
          const z = s.z + (tx / tl) * side * d;
          if (Math.abs(x) > 2480 || Math.abs(z) > 2480) continue;
          const h = this.terrainHeight(x, z);
          if (h < this.localWaterLevel(x, z) + 0.7 || h > 340) continue;
          const nr = this.nearestRoad(x, z);
          if (nr && nr.d < 10) continue; // 别离另一条路太近
          pinePos.push([x, z, 0]);
          // 更贴近路缘的近景灌木：一闪而过强化视差
          if (rng() < 0.55) {
            const d2 = s.w / 2 + 3.2 + rng() * 3.2;
            const x2 = s.x + (-tz / tl) * side * d2;
            const z2 = s.z + (tx / tl) * side * d2;
            const h2 = this.terrainHeight(x2, z2);
            if (h2 > this.localWaterLevel(x2, z2) + 0.5 && h2 < 340 && Math.abs(x2) < 2480 && Math.abs(z2) < 2480) {
              const nr2 = this.nearestRoad(x2, z2);
              if (!nr2 || nr2.d > 2.5) bushPos.push([x2, z2]);
            }
          }
        }
      }
    }

    // 路缘草簇：紧贴路肩的高频参照物，一闪而过强化视差
    for (const r of this.trafficRoutes) {
      const arr = r.samples;
      for (let i = 0; i < arr.length; i += 2) {
        const s = arr[i];
        const s2 = arr[Math.min(i + 2, arr.length - 1)];
        const tx = s2.x - s.x, tz = s2.z - s.z;
        const tl = Math.hypot(tx, tz) || 1;
        for (const side of [1, -1]) {
          const d = s.w / 2 + 2.2 + rng() * 3.2;
          const x = s.x + (-tz / tl) * side * d;
          const z = s.z + (tx / tl) * side * d;
          if (Math.abs(x) > 2480 || Math.abs(z) > 2480) continue;
          const h = this.terrainHeight(x, z);
          if (h < this.localWaterLevel(x, z) + 0.4 || h > 340) continue;
          const nr = this.nearestRoad(x, z);
          if (nr && nr.d < 1.5) continue;
          tuftPos.push([x, z]);
          // 彩色野花：路缘色彩点缀，高速下成彩色碎点飞掠
          if (rng() < 0.22) flowerPos.push([x, z, Math.floor(rng() * 3)]);
        }
      }
    }

    // 树（保存位置数据，供季节扫描线按位置变色）
    this._pineData = pinePos;
    this._oakData = oakPos;
    const pineGeo = new THREE.ConeGeometry(1.2, 2.8, 9);
    pineGeo.translate(0, 1.4, 0);
    const pineMidGeo = new THREE.ConeGeometry(0.92, 2.2, 8);
    pineMidGeo.translate(0, 1.1, 0);
    const pineTopGeo = new THREE.ConeGeometry(0.66, 1.7, 8);
    pineTopGeo.translate(0, 0.85, 0);
    const oakGeo = new THREE.IcosahedronGeometry(1.7, 1);
    oakGeo.translate(0, 2.4, 0);
    const oakMidGeo = new THREE.IcosahedronGeometry(1.05, 0);
    oakMidGeo.translate(0, 1.55, 0);
    const oakClumpGeo = new THREE.IcosahedronGeometry(0.62, 0);
    const trunkGeo = new THREE.CylinderGeometry(0.16, 0.30, 2.4, 7);
    trunkGeo.translate(0, 1.2, 0);
    const pineMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const oakMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const trunkMat = new THREE.MeshLambertMaterial({ color: 0x6b4c2c });
    const pineMesh = new THREE.InstancedMesh(pineGeo, pineMat, pinePos.length);
    const oakMesh = new THREE.InstancedMesh(oakGeo, oakMat, oakPos.length);
    const pineMidMesh = new THREE.InstancedMesh(pineMidGeo, pineMat, pinePos.length);
    const pineTopMesh = new THREE.InstancedMesh(pineTopGeo, pineMat, pinePos.length);
    const oakMidMesh = new THREE.InstancedMesh(oakMidGeo, oakMat, oakPos.length);
    const oakClumpMesh = new THREE.InstancedMesh(oakClumpGeo, oakMat, oakPos.length * 4);
    const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, pinePos.length + oakPos.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const v3 = new THREE.Vector3();
    const col = new THREE.Color();
    const S = this.seasons[this.season];
    let ti = 0;
    const addTree = (arr, scaleR) => {
      for (const e of arr) {
        const x = e[0], z = e[1];
        const g = e.length > 2 ? e[2] : 0;
        const sc = g ? 2.4 + rng() * 1.2 : scaleR();
        const y = this.terrainHeight(x, z) + 0.2;
        q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.05, rng() * TAU, (rng() - 0.5) * 0.05));
        v3.set(x, y, z);
        m4.compose(v3, q, new THREE.Vector3(sc, sc * (0.95 + rng() * 0.5), sc));
        trunkMesh.setMatrixAt(ti, m4);
        trunkMesh.setColorAt(ti, col.setHex(mixColor(0x6b4c2c, 0x59402a, rng())));
        ti++;
        // 树碰撞调细：只按树干粗细，巨树稍粗
        treeData.push({ x, z, r: 0.30 + 0.20 * sc, mesh: trunkMesh, index: ti - 1 });
      }
    };
    q.identity();
    let pi = 0;
    for (const e of pinePos) {
      const x = e[0], z = e[1], g = e[2];
      const sc = g ? 2.5 + rng() * 1.2 : 0.9 + rng() * 1.5;
      const y = this.terrainHeight(x, z) + 2.0;
      q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.05, rng() * TAU, (rng() - 0.5) * 0.05));
      v3.set(x, y, z);
      m4.compose(v3, q, new THREE.Vector3(sc, sc, sc));
      pineMesh.setMatrixAt(pi, m4);
      pineMesh.setColorAt(pi, col.setHex(mixColor(0x2d5f2c, 0x1f4a24, rng())));
      // 中层树冠：错层露出下一层
      v3.set(x, y + 2.0 * sc, z);
      m4.compose(v3, q, new THREE.Vector3(sc * 0.88, sc * 0.88, sc * 0.88));
      pineMidMesh.setMatrixAt(pi, m4);
      pineMidMesh.setColorAt(pi, col.setHex(mixColor(0x28602b, 0x1a4522, rng())));
      // 上层树冠：三层错落松枝
      v3.set(x, y + 3.6 * sc, z);
      m4.compose(v3, q, new THREE.Vector3(sc * 0.74, sc * 0.74, sc * 0.74));
      pineTopMesh.setMatrixAt(pi, m4);
      pineTopMesh.setColorAt(pi, col.setHex(mixColor(0x24582a, 0x173f20, rng())));
      pi++;
    }
    let oi = 0;
    for (const e of oakPos) {
      const x = e[0], z = e[1], g = e[2];
      const sc = g ? 2.3 + rng() * 1.1 : 0.8 + rng() * 1.4;
      const y = this.terrainHeight(x, z) + 2.2;
      q.setFromEuler(new THREE.Euler((rng() - 0.5) * 0.05, rng() * TAU, (rng() - 0.5) * 0.05));
      v3.set(x, y, z);
      m4.compose(v3, q, new THREE.Vector3(sc, sc * 0.95, sc));
      oakMesh.setMatrixAt(oi, m4);
      oakMesh.setColorAt(oi, col.setHex(mixColor(0x3c7d2e, 0x2a5f22, rng())));
      // 中层树冠：更饱满的球冠
      v3.set(x, y - 0.25 * sc, z);
      m4.compose(v3, q, new THREE.Vector3(sc * 1.12, sc * 0.92, sc * 1.12));
      oakMidMesh.setMatrixAt(oi, m4);
      oakMidMesh.setColorAt(oi, col.setHex(mixColor(0x35742a, 0x23521f, rng())));
      // 树冠团块：4 团随机偏移，立体体积感更强
      for (let c = 0; c < 4; c++) {
        const ox = (rng() - 0.5) * 3.0 * sc;
        const oy = (rng() - 0.35) * 1.8 * sc;
        const oz = (rng() - 0.5) * 3.0 * sc;
        v3.set(x + ox, y + oy, z + oz);
        m4.compose(v3, q, new THREE.Vector3(sc * 0.40, sc * 0.40, sc * 0.40));
        oakClumpMesh.setMatrixAt(oi * 4 + c, m4);
        oakClumpMesh.setColorAt(oi * 4 + c, col.setHex(mixColor(0x2f6b22, 0x1d4420, rng())));
      }
      oi++;
    }
    q.identity();
    addTree([...pinePos, ...oakPos], () => 0.7 + rng() * 1.2);
    this.foliageMeshes = [pineMesh, oakMesh];
    this.scene.add(pineMesh); this.scene.add(oakMesh);
    this.scene.add(pineMidMesh); this.scene.add(pineTopMesh);
    this.scene.add(oakMidMesh); this.scene.add(oakClumpMesh);
    this.scene.add(trunkMesh);
    this.pineTopMesh = pineTopMesh;
    this.oakClumpMesh = oakClumpMesh;
    this.pineMidMesh = pineMidMesh;
    this.oakMidMesh = oakMidMesh;
    for (const d of treeData) colliders.push({ x: d.x, z: d.z, r: d.r, type: 'tree' });

    // 灌木
    const bushGeo = new THREE.IcosahedronGeometry(0.55, 0);
    const bushMesh = new THREE.InstancedMesh(bushGeo, new THREE.MeshLambertMaterial({ color: 0xffffff }), bushPos.length);
    let bi = 0;
    for (const [x, z] of bushPos) {
      const sc = 0.5 + rng() * 1.1;
      v3.set(x, this.terrainHeight(x, z) + 0.25, z);
      m4.compose(v3, q, new THREE.Vector3(sc, sc * 0.7, sc));
      bushMesh.setMatrixAt(bi, m4);
      bushMesh.setColorAt(bi, col.setHex(mixColor(0x4d8a3a, 0x2f6b28, rng())));
      bi++;
    }
    this.scene.add(bushMesh);
    this.props.bushes = bushMesh;
    this.props.bushMesh = bushMesh;

    // 草簇：矮小密集，高速时在眼角刷刷掠过
    const tuftGeo = new THREE.ConeGeometry(0.10, 0.42, 5);
    tuftGeo.translate(0, 0.21, 0);
    const tuftMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const tuftMesh = new THREE.InstancedMesh(tuftGeo, tuftMat, tuftPos.length);
    let tui = 0;
    for (const [x, z] of tuftPos) {
      const sc = 0.8 + rng() * 1.7;
      v3.set(x, this.terrainHeight(x, z) + 0.02, z);
      m4.compose(v3, q, new THREE.Vector3(sc, sc, sc));
      tuftMesh.setMatrixAt(tui, m4);
      tuftMesh.setColorAt(tui, col.setHex(mixColor(0x5f9c3f, 0x7db457, rng())));
      tui++;
    }
    this.scene.add(tuftMesh);
    this.props.tufts = tuftMesh;

    // 野花：白/黄/红小点，路缘色彩点缀
    const flowerGeo = new THREE.IcosahedronGeometry(0.07, 0);
    const flowerMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const flowerMesh = new THREE.InstancedMesh(flowerGeo, flowerMat, flowerPos.length);
    const flowerCols = [0xf2f0e8, 0xffd94a, 0xe8485a];
    let fli = 0;
    for (const [x, z, type] of flowerPos) {
      const sc = 0.8 + rng() * 1.6;
      v3.set(x, this.terrainHeight(x, z) + 0.1, z);
      m4.compose(v3, q, new THREE.Vector3(sc, sc, sc));
      flowerMesh.setMatrixAt(fli, m4);
      flowerMesh.setColorAt(fli, col.setHex(mixColor(flowerCols[type], 0xffffff, rng() * 0.25)));
      fli++;
    }
    this.scene.add(flowerMesh);
    this.props.flowers = flowerMesh;

    // 岩石
    const rockGeo = new THREE.DodecahedronGeometry(1.1, 0);
    const rockMesh = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8d8a80 }), rockPos.length);
    let ri = 0;
    for (const [x, z] of rockPos) {
      const sc = 0.5 + rng() * 2.6;
      const y = this.terrainHeight(x, z);
      v3.set(x, y + 0.4, z);
      m4.compose(v3, new THREE.Quaternion().setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3)), new THREE.Vector3(sc, sc * 0.7, sc));
      rockMesh.setMatrixAt(ri, m4);
      rockMesh.setColorAt(ri, col.setHex(mixColor(0x9a968c, 0x6f6c64, rng())));
      colliders.push({ x, z, r: 0.9 * sc, type: 'rock' });
      ri++;
    }
    this.scene.add(rockMesh);
    this.props.rocks = rockMesh;

    // 草垛
    const hayGeo = new THREE.CylinderGeometry(0.95, 0.95, 1.15, 10);
    const hayMat = new THREE.MeshLambertMaterial({ color: 0xd6b65a });
    const hayMesh = new THREE.InstancedMesh(hayGeo, hayMat, hayPos.length);
    let hi = 0;
    for (const [x, z] of hayPos) {
      v3.set(x, this.terrainHeight(x, z) + 0.58, z);
      m4.compose(v3, q, new THREE.Vector3(1, 1, 1));
      hayMesh.setMatrixAt(hi, m4);
      colliders.push({ x, z, r: 1.1, type: 'hay' });
      hi++;
    }
    this.scene.add(hayMesh);
    this.props.hay = hayMesh;

    // 村庄房屋
    this.buildVillage();
    // 风车
    this.buildWindmills();
    // 起点拱门
    this.buildStartGate();
    // 出生点周围道路边缘的消防栓（props.js 的 buildFireHydrant）
    this.buildHydrants();
    // 指路牌
    this.buildSigns();
    // 路灯
    this.buildLamps();
    // 湖上桥梁护栏：道路跨过小湖的路段加栏杆 + 碰撞，车不会掉进湖里
    this.buildBridges();
    if (this.map.id === 'alpine') this.buildAlpineScenery();
  }

  buildBridges() {
    if (NO_LAKES) return;
    const railMat = new THREE.MeshLambertMaterial({ color: 0x7d5a38, side: THREE.DoubleSide });
    const specs = [
      { road: 'lakeconn', lake: EXTRA_LAKES[0] },
      { road: 'cross', lake: EXTRA_LAKES[1] },
    ];
    for (const sp of specs) {
      const route = this.trafficRoutes.find(r => r.id === sp.road);
      if (!route) continue;
      const arr = route.samples;
      const sel = [];
      for (let i = 0; i < arr.length; i++) {
        if (this.lakeMask(arr[i].x, arr[i].z) > 0.4) sel.push(i);
      }
      if (!sel.length) continue;
      const i0 = Math.max(0, sel[0] - 2);
      const i1 = Math.min(arr.length - 1, sel[sel.length - 1] + 2);
      for (const side of [1, -1]) {
        const positions = [], indices = [];
        for (let k = i0; k <= i1; k++) {
          const s = arr[k];
          const s2 = arr[Math.min(k + 1, arr.length - 1)];
          const tx = s2.x - s.x, tz = s2.z - s.z;
          const tl = Math.hypot(tx, tz) || 1;
          const nx = -tz / tl, nz = tx / tl;
          const ox = nx * side * (s.w / 2 + 0.7), oz = nz * side * (s.w / 2 + 0.7);
          positions.push(s.x + ox, s.h + 0.12, s.z + oz);
          positions.push(s.x + ox, s.h + 1.30, s.z + oz);
          if (k < i1) {
            const a = (k - i0) * 2, b = a + 1, c = a + 2, d = b + 2;
            indices.push(a, c, b, b, c, d);
          }
          if (k % 2 === 0) {
            this.colliders.push({ x: s.x + ox, z: s.z + oz, r: 0.38, type: 'bridge' });
          }
        }
        if (positions.length < 6) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        g.setIndex(indices);
        g.computeVertexNormals();
        const wall = new THREE.Mesh(g, railMat);
        wall.receiveShadow = true;
        this.scene.add(wall);
        this.bridgeMeshes = this.bridgeMeshes || [];
        this.bridgeMeshes.push(wall);
      }
    }
  }

  buildAlpineScenery() {
    const scene = this.scene;
    const wallMats = [
      new THREE.MeshLambertMaterial({ color: 0xf1ead7 }),
      new THREE.MeshLambertMaterial({ color: 0xd9c5a4 }),
      new THREE.MeshLambertMaterial({ color: 0xe7ded0 }),
    ];
    const wood = new THREE.MeshLambertMaterial({ color: 0x5a3423 });
    const darkWood = new THREE.MeshLambertMaterial({ color: 0x30231e });
    const roof = new THREE.MeshLambertMaterial({ color: 0x4c2c27 });
    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x7fb2c5,
      emissive: 0xffc878,
      emissiveIntensity: 0.18,
      metalness: 0.25,
      roughness: 0.35
    });

    const chalet = (x, z, yaw, scale, colorIndex) => {
      const y = this.terrainHeight(x, z);
      if (y < this.localWaterLevel(x, z) + 0.8) return;
      const g = new THREE.Group();
      const lower = new THREE.Mesh(new THREE.BoxGeometry(7.4, 2.6, 5.8), wood);
      lower.position.y = 1.3;
      const upper = new THREE.Mesh(new THREE.BoxGeometry(7.8, 2.8, 6.1), wallMats[colorIndex % wallMats.length]);
      upper.position.y = 4.0;
      const roofMesh = new THREE.Mesh(new THREE.ConeGeometry(5.8, 2.7, 4), roof);
      roofMesh.position.y = 6.65;
      roofMesh.rotation.y = Math.PI * 0.25;
      roofMesh.scale.z = 0.78;
      const balcony = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.18, 1.0), darkWood);
      balcony.position.set(0, 4.05, 3.35);
      const rail = new THREE.Group();
      for (let i = -4; i <= 4; i++) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.85, 0.10), darkWood);
        post.position.set(i * 0.82, 4.50, 3.68);
        rail.add(post);
      }
      const railTop = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.10, 0.10), darkWood);
      railTop.position.set(0, 4.88, 3.68);
      rail.add(railTop);
      for (const wx of [-2.3, 0, 2.3]) {
        const pane = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.15, 0.08), windowMat);
        pane.position.set(wx, 4.15, 3.10);
        g.add(pane);
      }
      const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.65, 2.2, 0.65), darkWood);
      chimney.position.set(2.25, 7.0, -0.4);
      g.add(lower, upper, roofMesh, balcony, rail, chimney);
      g.position.set(x, y, z);
      g.rotation.y = yaw;
      g.scale.setScalar(scale);
      scene.add(g);
      this.colliders.push({ x, z, r: 4.6 * scale, type: 'house' });
    };

    const villageSpots = [
      [-410, 760, 0.25, 1.00], [-350, 850, 0.55, 0.90], [-260, 940, 0.82, 1.08],
      [-80, 1035, 1.20, 0.92], [210, 1040, 1.55, 1.00], [410, 940, 1.92, 0.94],
      [535, 770, 2.30, 1.05], [520, 500, 2.72, 0.88], [360, 350, 3.12, 0.98],
      [-245, 385, -0.52, 0.90]
    ];
    villageSpots.forEach((p, i) => chalet(p[0], p[1], p[2], p[3], i));

    const mountainRoutes = [
      this.trafficRoutes.find(r => r.id === 'mountain'),
      this.trafficRoutes.find(r => r.id === 'switchbacks')
    ].filter(Boolean);
    if (mountainRoutes.length) {
      const poleGeo = new THREE.CylinderGeometry(0.055, 0.075, 2.4, 6);
      const poleMat = new THREE.MeshLambertMaterial({ color: 0xf3f0e7 });
      const redMat = new THREE.MeshLambertMaterial({ color: 0xe94246 });
      for (const mountain of mountainRoutes) {
        for (let i = 20; i < mountain.samples.length - 10; i += 18) {
          const s = mountain.samples[i];
          const n = mountain.samples[Math.min(i + 2, mountain.samples.length - 1)];
          const tx = n.x - s.x, tz = n.z - s.z;
          const l = Math.hypot(tx, tz) || 1;
          for (const side of [-1, 1]) {
            const x = s.x + (-tz / l) * side * (s.w / 2 + 1.9);
            const z = s.z + (tx / l) * side * (s.w / 2 + 1.9);
            const y = this.terrainHeight(x, z);
            const pole = new THREE.Mesh(poleGeo, poleMat);
            pole.position.set(x, y + 1.2, z);
            scene.add(pole);
            const band = new THREE.Mesh(new THREE.CylinderGeometry(0.061, 0.061, 0.32, 6), redMat);
            band.position.set(x, y + 1.75, z);
            scene.add(band);
          }
        }
      }
    }

    if (!NO_LAKES) {
      const pier = new THREE.Group();
      const deckMat = new THREE.MeshLambertMaterial({ color: 0x7c5538 });
      const deck = new THREE.Mesh(new THREE.BoxGeometry(4.6, 0.22, 18), deckMat);
      deck.position.set(0, 0.25, 6.5);
      pier.add(deck);
      for (const x of [-1.9, 1.9]) {
        for (const z of [-1, 4, 9, 14]) {
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 2.2, 6), darkWood);
          post.position.set(x, -0.45, z);
          pier.add(post);
        }
      }
      pier.position.set(-175, this.lakeWaterLevel + 0.05, 425);
      pier.rotation.y = -0.58;
      scene.add(pier);

      const signTex = canvasTex(512, 160, c => {
        c.fillStyle = '#f7f7f4'; c.fillRect(0, 0, 512, 160);
        c.fillStyle = '#ff2f87'; c.fillRect(0, 0, 24, 160);
        c.fillStyle = '#121820'; c.font = '900 58px "Segoe UI", sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('HORIZON ALPINE', 270, 82);
      });
      const sign = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 3.1),
        new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide })
      );
      sign.position.set(-175, this.lakeWaterLevel + 3.2, 427);
      sign.rotation.y = -0.58;
      scene.add(sign);
    }

  }

  buildVillage() {
    const rng = makeRng(77);
    const route = this.trafficRoutes.find(r => r.id === 'village')
      || this.trafficRoutes.find(r => r.id === 'lakeloop')
      || this.trafficRoutes.find(r => r.id === 'ring');
    if (!route) return;
    const sArr = route.samples;
    const houseColors = [0xc96f4a, 0xe4d8b0, 0xbfc3c8, 0xa45c3a, 0xd8b27c];
    let side = 1;
    for (let i = 40; i < sArr.length; i += 55) {
      const s = sArr[i];
      const s2 = sArr[Math.min(i + 3, sArr.length - 1)];
      const tx = s2.x - s.x, tz = s2.z - s.z;
      const tl = Math.hypot(tx, tz) || 1;
      const ox = -tz / tl * side, oz = tx / tl * side;
      const d = 20 + rng() * 12;
      const x = s.x + ox * d, z = s.z + oz * d;
      const h = this.terrainHeight(x, z);
      if (Math.abs(x) > 2400 || Math.abs(z) > 2400 || h < this.localWaterLevel(x, z) + 0.8) { side *= -1; continue; }
      const yaw2 = Math.atan2(-tx, -tz); // 房屋正面向路
      const house = buildHouse(5.6 + rng() * 2.5, 3.4 + rng() * 1.2, 7.5 + rng() * 3, pick(houseColors), rng());
      house.position.set(x, h - 0.02, z);
      house.rotation.y = yaw2 + (rng() < 0.5 ? Math.PI : 0);
      this.scene.add(house);
      this.colliders.push({ x, z, r: 5.5, type: 'house' });
      side *= -1;
    }
  }

  buildWindmills() {
    const spots = [[1040, -1560], [1260, -1660], [980, -1800], [1220, -1420]];
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8e4da });
    const bladeMat = new THREE.MeshLambertMaterial({ color: 0x3b3e44 });
    for (const [x, z] of spots) {
      const h = this.terrainHeight(x, z);
      if (h < 40 || h > 300) continue;
      const g = new THREE.Group();
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.5, 13, 8), mat);
      tower.position.y = 6.5;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(1.15, 8, 6), mat);
      cap.position.y = 13.6; cap.scale.y = 0.7;
      g.add(tower); g.add(cap);
      const blades = new THREE.Group();
      for (let i = 0; i < 4; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.55, 5.4, 0.16), bladeMat);
        b.position.y = 2.8;
        const bg = new THREE.Group();
        bg.add(b);
        bg.rotation.y = i * Math.PI / 2;
        blades.add(bg);
      }
      blades.position.y = 13.9;
      g.add(blades);
      g.position.set(x, h, z);
      this.scene.add(g);
      this.windmills.push({ blades, speed: 0.4 + Math.random() * 0.5 });
      this.colliders.push({ x, z, r: 1.8, type: 'mill' });
    }
  }

  buildStartGate() {
    // 高速起点拱门 (靠近 0,0)
    const g = new THREE.Group();
    const poleMat = new THREE.MeshLambertMaterial({ color: 0xdfe2e8 });
    const bannerTex = canvasTex(512, 96, (c) => {
      c.fillStyle = '#14171f'; c.fillRect(0, 0, 512, 96);
      c.fillStyle = '#e63946'; c.fillRect(0, 0, 512, 10); c.fillRect(0, 86, 512, 10);
      c.fillStyle = '#ffffff'; c.font = 'bold 46px "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText('H O R I Z O N  嘉年华', 256, 50);
    });
    for (const sx of [-10, 10]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 8.5, 8), poleMat);
      pole.position.set(sx, 4.25, -6);
      g.add(pole);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(22, 1.1, 1), new THREE.MeshLambertMaterial({ color: 0xd9dce2 }));
    beam.position.set(0, 8.2, -6);
    g.add(beam);
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(20, 2.3), new THREE.MeshLambertMaterial({ map: bannerTex, side: THREE.DoubleSide }));
    banner.position.set(0, 7.4, -5.4);
    banner.rotation.y = Math.PI;
    // 海特洛市不使用嘉年华横幅：起点拱门保持干净的城市观感
    if (!this.isCity) g.add(banner);
    const hwRoute = this.trafficRoutes.find(r => r.id === 'highway')
      || this.trafficRoutes.find(r => r.id === 'cross')
      || this.trafficRoutes.find(r => r.id === 'ring');
    if (!hwRoute) return;
    const hw = hwRoute.samples;
    let nearest = hw[0], nd = 1e9;
    for (const s of hw) { const d = Math.hypot(s.x, s.z); if (d < nd) { nd = d; nearest = s; } }
    const ni = hw.indexOf(nearest);
    const next = hw[Math.min(ni + 20, hw.length - 1)];
    const tx = next.x - nearest.x, tz = next.z - nearest.z;
    const gateYaw = Math.atan2(tx, tz);
    // 门横跨公路：本地 X（立柱连线）应垂直于道路方向
    g.rotation.y = gateYaw;
    // 门和出生点都对准公路中心，不再偏在路边
    g.position.set(nearest.x, nearest.h, nearest.z);
    g.name = 'startGate';
    this.scene.add(g);
    this.startLine = { x: nearest.x, z: nearest.z, yaw: gateYaw, y: nearest.h };
  }

  // 出生点周围道路边缘的消防栓：沿 startLine 的切线方向左右交替布点，
  // 横向 12m（cross 路宽 20m：半宽 10m + 2m 路肩），避开路面与出生车辆；
  // y 坐标用 terrainHeight 取真实地形高度，不会悬空或埋地。
  buildHydrants() {
    if (typeof buildFireHydrant !== 'function') return;
    const sl = this.startLine;
    if (!sl) return;
    const fx = Math.sin(sl.yaw), fz = Math.cos(sl.yaw);   // 道路前进方向
    const lx = Math.cos(sl.yaw), lz = -Math.sin(sl.yaw);  // 横向（左右）
    // [横向侧, 沿路纵向偏移]：出生点前后约 30m，左右交替，共 5 个
    const spots = [
      { side: -1, along: -14 },
      { side:  1, along:  -4 },
      { side: -1, along:   6 },
      { side:  1, along:  16 },
      { side: -1, along:  27 },
    ];
    this.hydrants = [];
    const OFF = 12.0;
    for (const sp of spots) {
      const x = sl.x + fx * sp.along + lx * OFF * sp.side;
      const z = sl.z + fz * sp.along + lz * OFF * sp.side;
      const h = this.terrainHeight(x, z);
      const hydrant = buildFireHydrant({ x, y: h, z, yaw: sl.yaw });
      this.scene.add(hydrant);
      this.hydrants.push({ x, z, y: h, yaw: sl.yaw, along: sp.along, side: sp.side });
      // 与路灯/指路牌相同的轻量静态碰撞：玩家车碰到会被推开（圆柱近似），
      // 不影响悬挂/路面物理；放在路肩外，正常驾驶不会触发。
      this.colliders.push({ x, z, r: 0.32, type: 'hydrant' });
    }
  }

  buildSigns() {
    const spots = [
      { x: -240, z: -1300, txt: '沿海公路 → 12 mi', yaw: -0.8 },
      { x: 620, z: 420, txt: '村庄 → 1.2 mi', yaw: 1.2 },
      { x: 700, z: -1120, txt: '风车山 → 3 mi', yaw: 0.5 },
      { x: -520, z: -360, txt: '嘉年华 → 前方', yaw: 0.35 },
    ];
    for (const sp of spots) {
      const h = this.terrainHeight(sp.x, sp.z);
      if (h < this.localWaterLevel(sp.x, sp.z) + 0.5) continue;
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 2.6, 6), new THREE.MeshLambertMaterial({ color: 0x777 } ));
      pole.position.y = 1.3;
      const tex = canvasTex(256, 128, c => {
        c.fillStyle = '#1a6b3c'; c.fillRect(0, 0, 256, 128);
        c.fillStyle = '#fff'; c.font = 'bold 28px "Segoe UI", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(sp.txt, 128, 64);
      });
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.9), new THREE.MeshLambertMaterial({ map: tex }));
      board.position.y = 2.6;
      g.add(pole); g.add(board);
      g.position.set(sp.x, h, sp.z);
      g.rotation.y = sp.yaw;
      this.scene.add(g);
      this.colliders.push({ x: sp.x, z: sp.z, r: 0.4, type: 'sign' });
    }
  }

  buildLamps() {
    const rng = makeRng(42);
    // 主要路网装路灯：间隔约 120m，左右交替，不装山路/发夹弯保持简洁
    const SPACING = 120;
    const ids = ['ring', 'cross', 'highway', 'village', 'coast', 'lakeloop', 'lakeconn'];
    const poolTex = canvasTex(64, 64, c => {
      const g = c.createRadialGradient(32, 32, 2, 32, 32, 30);
      g.addColorStop(0, 'rgba(255,226,150,1.0)');
      g.addColorStop(0.3, 'rgba(255,205,120,0.55)');
      g.addColorStop(1, 'rgba(255,190,105,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    });
    const glowTex = canvasTex(64, 64, c => {
      const g = c.createRadialGradient(32, 32, 4, 32, 32, 30);
      g.addColorStop(0, 'rgba(255,214,140,0.5)');
      g.addColorStop(0.45, 'rgba(255,190,110,0.18)');
      g.addColorStop(1, 'rgba(255,180,100,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    });
    this.lampPoints = [];
    this.lampGlows = [];
    for (const rid of ids) {
      const route = this.trafficRoutes.find(r => r.id === rid);
      if (!route || !route.samples || !route.samples.length) continue;
      const sArr = route.samples;
      let lastD = -1e9;
      let side = 1;
      for (let i = 0; i < sArr.length; i++) {
        const s = sArr[i];
        if (s.d - lastD < SPACING) continue;
        if (!route.closed && i + 3 >= sArr.length) continue;
        lastD = s.d;
        side = -side;
        const s2 = sArr[Math.min(i + 3, sArr.length - 1)];
        const tx = s2.x - s.x, tz = s2.z - s.z;
        const tl = Math.hypot(tx, tz) || 1;
        const x = s.x + (-tz / tl) * side * (s.w / 2 + 1.3);
        const z = s.z + (tx / tl) * side * (s.w / 2 + 1.3);
        const h = this.terrainHeight(x, z);
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 4.6, 6), new THREE.MeshLambertMaterial({ color: 0x3d4148 }));
        pole.position.y = 2.3;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.07, 0.07), pole.material);
        arm.position.set(side * 0.52, 4.55, 0);
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffdf9e, emissive: 0xffc86a, emissiveIntensity: 0 }));
        lamp.position.set(side * 1.0, 4.5, 0);
        g.add(pole); g.add(arm); g.add(lamp);
        g.position.set(x, h, z);
        g.rotation.y = Math.atan2(tx, tz) + Math.PI / 2;
        this.scene.add(g);
        this.lamps.push(lamp);
        // 真实点光源放在灯头高度（杆基 h + 4.5m），才能照亮车身与路面
        this.lampPoints.push({ x, y: h + 4.5, z });
        // 灯头光晕（billboard，夜间渐亮）
        const glow = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending
        }));
        glow.position.set(x, h + 4.5, z);
        glow.scale.set(1.05, 1.05, 1);
        glow.renderOrder = 5;
        this.scene.add(glow);
        this.lampGlows.push(glow);
        this.colliders.push({ x, z, r: 0.32, type: 'lamp' });
      }
    }
  }

  // ================= 水域 =================
  buildWater() {
    const cell = 60;
    const n = Math.ceil(CFG.worldHalf * 2 / cell);
    const verts = [], idx = [];
    const lakeAt = (x, z) => {
      return clamp(this.seaMask(x, z), 0, 1) + clamp(this.lakeMask(x, z), 0, 1);
    };
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n; j++) {
        const x = -CFG.worldHalf + i * cell, z = -CFG.worldHalf + j * cell;
        const m = lakeAt(x, z);
        if (m > 0.35) {
          const wy = clamp(this.seaMask(x, z), 0, 1) > 0.35 ? CFG.waterLevel : this.lakeWaterLevel;
          verts.push(x, wy, z);
        }
        else verts.push(x, this.localWaterLevel(x, z) - 0.5, z); // 贴近局部水面但低于水面，藏在岸边地形下
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * (n + 1) + j, b = a + 1, c = a + (n + 1), d = c + 1;
        const ma = lakeAt(-CFG.worldHalf + i * cell, -CFG.worldHalf + j * cell) > 0.5;
        const mb = lakeAt(-CFG.worldHalf + (i + 1) * cell, -CFG.worldHalf + j * cell) > 0.5;
        const mc = lakeAt(-CFG.worldHalf + i * cell, -CFG.worldHalf + (j + 1) * cell) > 0.5;
        const md = lakeAt(-CFG.worldHalf + (i + 1) * cell, -CFG.worldHalf + (j + 1) * cell) > 0.5;
        if (ma || mb || mc || md) {
          idx.push(a, c, b, b, c, d);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = new THREE.ShaderMaterial({
      transparent: true, side: THREE.DoubleSide, depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        waterColor: { value: new THREE.Color(this.seasons[this.season].water) },
        sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
        camPos: { value: new THREE.Vector3(0, 100, 0) },
      },
      vertexShader: `
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          vec3 p = position;
          p.y += sin(p.x * 0.11 + uTime * 1.2) * 0.10
               + sin(p.z * 0.09 + uTime * 0.85) * 0.10
               + sin((p.x + p.z) * 0.05 + uTime * 0.6) * 0.08;
          vWorld = (modelMatrix * vec4(p, 1.0)).xyz;
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 waterColor;
        uniform vec3 sunDir;
        uniform vec3 camPos;
        uniform float uTime;
        varying vec3 vWorld;
        varying vec3 vNormal;
        void main() {
          float w1 = sin(vWorld.x * 0.22 + uTime * 1.6) * 0.14
                   + cos(vWorld.z * 0.18 + uTime * 1.2) * 0.14;
          float w2 = sin((vWorld.x + vWorld.z) * 0.12 + uTime * 0.9) * 0.12;
          vec3 n = normalize(vNormal + vec3(w1, 0.0, w2));
          vec3 viewDir = normalize(camPos - vWorld);
          float fres = pow(1.0 - max(dot(viewDir, n), 0.0), 4.0);
          vec3 deep = waterColor * 0.28;
          vec3 shallow = waterColor * 0.62;
          vec3 base = mix(deep, shallow, fres * 0.6 + 0.15);
          vec3 refl = vec3(0.20, 0.28, 0.36) * fres * 0.45;
          vec3 h = normalize(viewDir + sunDir);
          float spec = pow(max(dot(n, h), 0.0), 240.0) * 0.55;
          float ripple = 1.0 + sin(vWorld.x * 0.35 + uTime * 2.0) * 0.02
                       + cos(vWorld.z * 0.30 + uTime * 1.7) * 0.02;
          vec3 col = (base + refl) * ripple + vec3(1.0, 0.93, 0.72) * spec;
          col = min(col, vec3(1.0));
          gl_FragColor = vec4(col, 0.94);
        }
      `,
    });
    const m = new THREE.Mesh(g, mat);
    this.scene.add(m);
    this.waterMesh = m;
  }

  // ================= 天空 =================
  buildSky() {
    const scene = this.scene;
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(4600, 24, 12),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, depthWrite: false, fog: false,
        uniforms: {
          top: { value: new THREE.Color(0x2a6fae) },
          mid: { value: new THREE.Color(0x9fd8f0) },
          bot: { value: new THREE.Color(0xd8ecf5) },
          sunDir: { value: new THREE.Vector3(0, 1, 0) },
          sunCol: { value: new THREE.Color(0xffffff) },
          warm: { value: 0 },
        },
        vertexShader: `
          varying vec3 vWorld;
          void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }
        `,
        fragmentShader: `
          uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 sunDir; uniform vec3 sunCol; uniform float warm;
          varying vec3 vWorld;
          void main(){
            vec3 d = normalize(vWorld);
            float h = clamp(d.y, -0.12, 1.0);
            // 更分明的二次元天空渐变：天顶深蓝、地平线亮白
            vec3 c = h > 0.08 ? mix(mid, top, pow(h, 0.6)) : mix(bot, mid, smoothstep(-0.12, 0.08, h));
            // 地平线柔光带（二次元常见的暖白地平线）
            c += mix(bot, vec3(1.0), 0.6) * exp(-abs(d.y) * 22.0) * 0.30;
            float s = max(dot(d, normalize(sunDir)), 0.0);
            c += sunCol * pow(s, 300.0) * 1.0;   // 利落的太阳圆盘
            c += sunCol * pow(s, 10.0) * 0.18;   // 更克制的光晕
            // 低角度暖光：日落/日出时太阳周围的金橙色光晕
            c += vec3(1.0, 0.62, 0.30) * pow(s, 14.0) * warm * 0.85;
            c += vec3(1.0, 0.72, 0.42) * pow(s, 3.0) * warm * 0.25;
            gl_FragColor = vec4(c, 1.0);
          }
        `,
      })
    );
    this.sky.position.y = 0;
    scene.add(this.sky);
    // 太阳 / 月亮
    const sunTex = canvasTex(256, 256, c => {
      const g = c.createRadialGradient(128, 128, 0, 128, 128, 128);
      g.addColorStop(0, 'rgba(255,250,220,1)');
      g.addColorStop(0.25, 'rgba(255,236,170,0.85)');
      g.addColorStop(0.55, 'rgba(255,210,120,0.18)');
      g.addColorStop(1, 'rgba(255,200,100,0)');
      c.fillStyle = g; c.fillRect(0, 0, 256, 256);
    });
    this.sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, transparent: true, depthWrite: false, fog: false }));
    this.sunSprite.scale.setScalar(900);
    scene.add(this.sunSprite);
    const moonTex = canvasTex(128, 128, c => {
      c.fillStyle = 'rgba(240,244,255,1)'; c.beginPath(); c.arc(64, 64, 42, 0, TAU); c.fill();
      c.fillStyle = 'rgba(200,206,220,0.7)'; c.beginPath(); c.arc(46, 54, 12, 0, TAU); c.fill();
      c.beginPath(); c.arc(78, 78, 9, 0, TAU); c.fill();
    });
    this.moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: moonTex, transparent: true, depthWrite: false, fog: false }));
    this.moonSprite.scale.setScalar(520);
    scene.add(this.moonSprite);
    // 星星
    const stars = [];
    const rng = makeRng(9);
    for (let i = 0; i < 900; i++) {
      const th = rng() * TAU, ph = Math.acos(rng() * 0.95);
      const r = 4400;
      stars.push(r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph) + 200, r * Math.sin(ph) * Math.sin(th));
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(stars, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xcfe0ff, size: 1.35, transparent: true, opacity: 0, depthWrite: false, fog: false, sizeAttenuation: false }));
    scene.add(this.stars);
    // 体积云：程序化 fbm 噪声云层（球壳），随天气增浓/漂移，替代 billboard 云片
    this.clouds = []; // 保留空数组，兼容旧遍历
    this.cloudUniforms = {
      uTime: { value: 0 },
      uCoverage: { value: 0.35 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.75, 0.3).normalize() },
      uSunCol: { value: new THREE.Color(0xffffff) },
      uGrey: { value: 0 },
    };
    this.cloudMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, fog: false,
      uniforms: this.cloudUniforms,
      vertexShader: `
        varying vec3 vWorld;
        void main(){ vec4 wp = modelMatrix * vec4(position,1.0); vWorld = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }
      `,
      fragmentShader: `
        uniform float uTime; uniform float uCoverage; uniform vec3 uSunDir; uniform vec3 uSunCol; uniform float uGrey;
        varying vec3 vWorld;
        float hash3(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453123); }
        float noise3(vec3 p){
          vec3 i = floor(p), f = fract(p);
          vec3 u = f*f*(3.0-2.0*f);
          return mix(
            mix(mix(hash3(i), hash3(i+vec3(1.0,0.0,0.0)), u.x), mix(hash3(i+vec3(0.0,1.0,0.0)), hash3(i+vec3(1.0,1.0,0.0)), u.x), u.y),
            mix(mix(hash3(i+vec3(0.0,0.0,1.0)), hash3(i+vec3(1.0,0.0,1.0)), u.x), mix(hash3(i+vec3(0.0,1.0,1.0)), hash3(i+vec3(1.0,1.0,1.0)), u.x), u.y),
            u.z);
        }
        float fbm3(vec3 p){
          float v = 0.0, a = 0.5;
          for(int i=0;i<4;i++){ v += a*noise3(p); p = p*2.02 + vec3(11.7,7.3,3.1); a *= 0.5; }
          return v;
        }
        void main(){
          vec3 d = normalize(vWorld);
          float horizon = smoothstep(0.0, 0.45, d.y); // 天顶少云
          // 3D 噪声采样：云随方向立体分布、随时间水平漂移
          vec3 p = d * 5.5 + vec3(uTime * 0.012, 0.0, 0.0);
          float f = fbm3(p);
          float cld = smoothstep(0.62 - uCoverage * 0.30, 0.84, f) * horizon;
          cld = clamp(cld * (0.5 + uCoverage * 1.2), 0.0, 1.0);
          float sunAmt = pow(max(dot(d, normalize(uSunDir)), 0.0), 3.0);
          vec3 col = mix(vec3(0.82,0.86,0.94), uSunCol, sunAmt * 0.6);
          col = mix(col, vec3(0.52,0.55,0.63), uGrey);
          gl_FragColor = vec4(col, cld);
        }
      `,
    });
    const cloudDome = new THREE.Mesh(new THREE.SphereGeometry(4300, 48, 24), this.cloudMat);
    cloudDome.renderOrder = 1;
    scene.add(cloudDome);
    this.cloudDome = cloudDome;
  }

  // ================= 雨雪 =================
  buildWeather() {
    // 雨：竖直雨丝贴图 + 更大尺寸，明显可见（不再是小圆点）
    const rainArr = [];
    for (let i = 0; i < 3200; i++) rainArr.push(rand(-240, 240), rand(-20, 120), rand(-240, 240));
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(rainArr, 3));
    this.rainPts = new THREE.Points(rg, new THREE.PointsMaterial({
      color: 0xd8e9f6, size: 0.55, map: rainStreakTex(), transparent: true, opacity: 0,
      depthWrite: false, alphaTest: 0.01,
    }));
    this.rainPts.frustumCulled = false;
    // 雪：稍大点
    const snowArr = [];
    for (let i = 0; i < 2000; i++) snowArr.push(rand(-240, 240), rand(-20, 120), rand(-240, 240));
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(snowArr, 3));
    this.snowPts = new THREE.Points(sg, new THREE.PointsMaterial({
      color: 0xffffff, size: 0.5, transparent: true, opacity: 0, depthWrite: false,
    }));
    this.snowPts.frustumCulled = false;
    this.scene.add(this.rainPts); this.scene.add(this.snowPts);
  }

  updateWeather(dt, camPos) {
    // 雪天仅在冬季：非冬季自动清回晴天
    if (this.weather === 3 && this.season !== 3) this.weather = 0;
    const isRain = this.weather === 1, isFog = this.weather === 2, isSnow = this.weather === 3;
    const target = (isRain || isFog || isSnow) ? 1 : 0;
    this.weatherAmt = lerp(this.weatherAmt, target, Math.min(1, dt * 1.2));
    AudioSys.weather.rain = isRain ? this.weatherAmt : 0;
    AudioSys.weather.snow = isSnow ? this.weatherAmt : 0;
    this.rainPts.material.opacity = isRain ? this.weatherAmt * 0.85 : 0;
    this.snowPts.material.opacity = isSnow ? this.weatherAmt * 0.8 : 0;
    // 雾天浓雾；雪天/雨天中等雾；晴天远景清晰
    const fogTarget = isFog ? 0.0024 : isSnow ? 0.0014 : isRain ? 0.0009 : 0.0003;
    this.fog.density = lerp(this.fog.density, fogTarget, Math.min(1, dt * 1.2));
    // 路面湿度：雨天全湿；城市地图常态半湿（赛博都市的湿滑反光街道）
    const wet = isRain ? this.weatherAmt : 0;
    if (this.roadMats) {
      for (const m of this.roadMats) {
        const isDirt = m.userData && m.userData.isDirt;
        const dry = (m.userData && m.userData.dryRoughness != null) ? m.userData.dryRoughness : 0.92;
        if (isDirt) {
          // 非铺装路（土路/砂石）：湿了只变深，不反光，保持粗糙
          m.roughness = dry;
          m.color.setScalar(lerp(1, 0.74, wet));
          m.envMapIntensity = 0;
        } else {
          // 铺装沥青路：湿了微反光，但不能太光滑——roughness 最低 0.45，避免路灯过曝
          m.roughness = lerp(dry, 0.45, wet);
          m.color.setScalar(lerp(1, 0.55, wet)); // 湿沥青更黑
          m.envMapIntensity = wet * 0.3;
        }
      }
    }
    this.updateSky();
    // 雨雪粒子：世界空间竖直下落（不整体跟车平移），飘出相机周围范围就换到另一侧刷新
    const cx = camPos && camPos.x != null ? camPos.x : 0;
    const cz = camPos && camPos.z != null ? camPos.z : 0;
    const R = 200;
    for (const p of [this.rainPts, this.snowPts]) {
      const pos = p.geometry.attributes.position;
      const isSnow = p === this.snowPts;
      const fall = (isSnow ? 5 : 68) * dt; // 雨速快一倍
      for (let i = 0; i < pos.count; i++) {
        let x = pos.getX(i), y = pos.getY(i) - fall, z = pos.getZ(i);
        if (isSnow) {
          x += Math.sin((y + i * 3) * 0.02) * dt * 2;
        }
        if (x < cx - R) x += R * 2; else if (x > cx + R) x -= R * 2;
        if (z < cz - R) z += R * 2; else if (z > cz + R) z -= R * 2;
        if (y < -25) y = 115;
        pos.setX(i, x); pos.setY(i, y); pos.setZ(i, z);
      }
      pos.needsUpdate = true;
    }
  }

  // ================= 季节 =================
  applySeason(camX, camZ, camYaw) {
    const S = this.seasons[this.season];
    const isSpring = this.season === 0;
    // 树木：只计算并暂存目标色，不立即应用——等扫描线扫到该位置再变色
    const rng = makeRng(7);
    const pineData = this._pineData || [];
    const oakData = this._oakData || [];
    const seasonCol = (winter, autumn, spring, summer) => {
      if (this.season === 3) return new THREE.Color(winter);
      if (this.season === 2) {
        const a = Array.isArray(autumn)
          ? (autumn.length > 3 ? pick(autumn) : mixColor(autumn[0], autumn[1], rng()))
          : autumn;
        return new THREE.Color(a);
      }
      if (isSpring) return new THREE.Color(mixColor(spring[0], spring[1], rng()));
      return new THREE.Color(mixColor(summer[0], summer[1], rng()));
    };
    const pineTargets = [];
    for (let i = 0; i < pineData.length; i++) {
      pineTargets.push({
        base: seasonCol(0x6b7a66, [0x9a5a20, 0x6e6e24], [0x64a53e, 0x4d8d30], [0x2d5f2c, 0x1f4a24]),
        mid: seasonCol(0x5f6e5b, [0x8a4f1e, 0x635f20], [0x5ca038, 0x438a2c], [0x28602b, 0x1a4522]),
        top: seasonCol(0x5f6e5b, [0x8a4f1e, 0x635f20], [0x5ca038, 0x438a2c], [0x24582a, 0x173f20])
      });
    }
    const oakTargets = [];
    for (let i = 0; i < oakData.length; i++) {
      oakTargets.push({
        base: seasonCol(0x5e5340, [0xb46b2a, 0xc24b2e, 0xa37a1f, 0x8a5a20], [0x6fb44a, 0x569a38], [0x3c7d2e, 0x2a5f22]),
        mid: seasonCol(0x544b3d, [0xa35f24, 0xb4422a, 0x946a1c, 0x7c4f1b], [0x5da63a, 0x478c30], [0x35742a, 0x23521f]),
        clump: [
          seasonCol(0x544b3d, [0xa35f24, 0xb4422a, 0x946a1c, 0x7c4f1b], [0x5da63a, 0x478c30], [0x2f6b22, 0x1d4420]),
          seasonCol(0x544b3d, [0xa35f24, 0xb4422a, 0x946a1c, 0x7c4f1b], [0x5da63a, 0x478c30], [0x2f6b22, 0x1d4420]),
          seasonCol(0x544b3d, [0xa35f24, 0xb4422a, 0x946a1c, 0x7c4f1b], [0x5da63a, 0x478c30], [0x2f6b22, 0x1d4420]),
          seasonCol(0x544b3d, [0xa35f24, 0xb4422a, 0x946a1c, 0x7c4f1b], [0x5da63a, 0x478c30], [0x2f6b22, 0x1d4420])
        ]
      });
    }
    this._pineTargets = pineTargets;
    this._oakTargets = oakTargets;
    if (this.props.bushMesh) {
      this.props.bushMesh.material.color.setHex(
        this.season === 3 ? 0x9aa29a :
        this.season === 2 ? 0x8a7a3f :
        isSpring ? 0x74b64a : 0x3f7d2e);
    }
    if (this.props.tufts) {
      this.props.tufts.material.color.setHex(
        this.season === 3 ? 0xc8d2c4 :
        this.season === 2 ? 0xa79a55 :
        isSpring ? 0xb5e08a : 0x8fc06a);
    }
    if (this.waterMesh) {
      if (this.waterMesh.material.uniforms) this.waterMesh.material.uniforms.waterColor.value.setHex(S.water);
      else this.waterMesh.material.color.setHex(S.water);
    }
    this.updateSky();
    // 空间扫描式季节过渡：先让一条线扫过镜头视野，再继续扫完整张地图
    this.startSeasonWave(camX == null ? 0 : camX, camZ == null ? 0 : camZ, camYaw || 0);
  }

  // 扫描线季节过渡：分帧执行，主线程每帧只处理少量顶点，不卡帧不卡声
  startSeasonWave(camX, camZ, camYaw) {
    const mesh = this.terrainMesh;
    if (!mesh) { this.seasonApplyBusy = false; return; }
    const pos = mesh.geometry.attributes.position;
    const nrm = mesh.geometry.attributes.normal;
    const colors = mesh.geometry.attributes.color;
    const count = pos.count;
    const col = new THREE.Color();
    const painted = new Uint8Array(count);
    // 视野范围：以镜头为圆心、朝镜头右侧投影分桶，扫线先横穿视野
    const VIEW_R = 1100;
    const VIEW_BW = 44;
    const VIEW_B = Math.ceil(VIEW_R * 2 / VIEW_BW);
    const WB = 100;              // 全图沿 X 分 100 个桶（约 50m/桶）
    const SWEEP_STEP = 26;       // 扫线每帧前进 26m → 视野约 1.4 秒、全图约 4.5 秒
    const BUDGET = 3500;         // 每帧最多重涂顶点数，保证帧率
    const SCAN_CHUNK = 45000;    // 建索引阶段每帧扫描顶点数
    const cosY = Math.cos(camYaw), sinY = Math.sin(camYaw);
    const viewBuckets = Array.from({ length: VIEW_B }, () => []);
    const worldBuckets = Array.from({ length: WB }, () => []);
    // 树木也按扫描线变色：视野树桶先扫，全图树桶随后
    const pineMesh = this.foliageMeshes && this.foliageMeshes[0];
    const oakMesh = this.foliageMeshes && this.foliageMeshes[1];
    const pineMidMesh = this.pineMidMesh, pineTopMesh = this.pineTopMesh;
    const oakMidMesh = this.oakMidMesh, oakClumpMesh = this.oakClumpMesh;
    const pineData = this._pineData || [], oakData = this._oakData || [];
    const pineTargets = this._pineTargets || [], oakTargets = this._oakTargets || [];
    const pinePainted = new Uint8Array(pineData.length);
    const oakPainted = new Uint8Array(oakData.length);
    const viewTreeBuckets = Array.from({ length: VIEW_B }, () => []);
    const worldTreeBuckets = Array.from({ length: WB }, () => []);
    const addTreeTask = (x, z, kind, i) => {
      const dx = x - camX, dz = z - camZ;
      if (dx * dx + dz * dz < VIEW_R * VIEW_R) {
        const s = dx * cosY - dz * sinY;
        const bi = Math.max(0, Math.min(VIEW_B - 1, Math.floor((s + VIEW_R) / VIEW_BW)));
        viewTreeBuckets[bi].push({ kind, i });
      } else {
        const bi = Math.max(0, Math.min(WB - 1, Math.floor((x + 2500) / (5000 / WB))));
        worldTreeBuckets[bi].push({ kind, i });
      }
    };
    for (let i = 0; i < pineData.length; i++) addTreeTask(pineData[i][0], pineData[i][1], 0, i);
    for (let i = 0; i < oakData.length; i++) addTreeTask(oakData[i][0], oakData[i][1], 1, i);
    const applyTree = (t) => {
      if (t.kind === 0) {
        if (pinePainted[t.i] || !pineTargets[t.i]) return;
        pinePainted[t.i] = 1;
        const tg = pineTargets[t.i];
        if (pineMesh) { pineMesh.setColorAt(t.i, tg.base); pineMesh.instanceColor.needsUpdate = true; }
        if (pineMidMesh) { pineMidMesh.setColorAt(t.i, tg.mid); pineMidMesh.instanceColor.needsUpdate = true; }
        if (pineTopMesh) { pineTopMesh.setColorAt(t.i, tg.top); pineTopMesh.instanceColor.needsUpdate = true; }
      } else {
        if (oakPainted[t.i] || !oakTargets[t.i]) return;
        oakPainted[t.i] = 1;
        const tg = oakTargets[t.i];
        if (oakMesh) { oakMesh.setColorAt(t.i, tg.base); oakMesh.instanceColor.needsUpdate = true; }
        if (oakMidMesh) { oakMidMesh.setColorAt(t.i, tg.mid); oakMidMesh.instanceColor.needsUpdate = true; }
        if (oakClumpMesh) {
          for (let c = 0; c < 4; c++) oakClumpMesh.setColorAt(t.i * 4 + c, tg.clump[c]);
          oakClumpMesh.instanceColor.needsUpdate = true;
        }
      }
    };
    const paint = (vi) => {
      if (painted[vi]) return;
      painted[vi] = 1;
      const slope = 1 - nrm.getY(vi);
      this.terrainColor(pos.getX(vi), pos.getY(vi), pos.getZ(vi), slope, col);
      colors.setXYZ(vi, col.r, col.g, col.b);
    };
    const wv = {
      phase: 'scan', scanIdx: 0,
      viewLine: -VIEW_R, viewCur: -1,
      worldX: -2500, worldCur: -1,
      viewBuckets, worldBuckets, painted,
      viewTreeBuckets, worldTreeBuckets, applyTree
    };
    if (this._waveRAF) cancelAnimationFrame(this._waveRAF);
    this._wave = wv;
    this.seasonApplyBusy = true;
    const step = () => {
      if (this._wave !== wv) return;
      let done = 0;
      if (wv.phase === 'scan') {
        const end = Math.min(count, wv.scanIdx + SCAN_CHUNK);
        for (; wv.scanIdx < end; wv.scanIdx++) {
          const x = pos.getX(wv.scanIdx), z = pos.getZ(wv.scanIdx);
          const dx = x - camX, dz = z - camZ;
          if (dx * dx + dz * dz < VIEW_R * VIEW_R) {
            const s = dx * cosY - dz * sinY;
            const bi = Math.max(0, Math.min(VIEW_B - 1, Math.floor((s + VIEW_R) / VIEW_BW)));
            viewBuckets[bi].push(wv.scanIdx);
          } else {
            const bi = Math.max(0, Math.min(WB - 1, Math.floor((x + 2500) / (5000 / WB))));
            worldBuckets[bi].push(wv.scanIdx);
          }
        }
        if (wv.scanIdx >= count) wv.phase = 'view';
      } else if (wv.phase === 'view') {
        // 视野内：一条线从左到右扫过镜头前方的地面
        wv.viewLine += SWEEP_STEP;
        const target = Math.max(0, Math.min(VIEW_B - 1, Math.floor((wv.viewLine + VIEW_R) / VIEW_BW)));
        if (target > wv.viewCur) wv.viewCur = target;
        for (let bi = 0; bi <= wv.viewCur && done < BUDGET; bi++) {
          const arr = viewBuckets[bi];
          while (arr.length && done < BUDGET) { paint(arr.pop()); done++; }
        }
        for (let bi = 0; bi <= wv.viewCur; bi++) {
          const arr = viewTreeBuckets[bi];
          while (arr.length) applyTree(arr.pop());
        }
        if (wv.viewLine >= VIEW_R && viewBuckets.every(a => a.length === 0)) wv.phase = 'world';
      } else if (wv.phase === 'world') {
        // 视野完成后再处理其它地方：继续按地图 X 扫完全图
        wv.worldX += SWEEP_STEP;
        const target = Math.max(0, Math.min(WB - 1, Math.floor((wv.worldX + 2500) / (5000 / WB))));
        if (target > wv.worldCur) wv.worldCur = target;
        for (let bi = 0; bi <= wv.worldCur && done < BUDGET; bi++) {
          const arr = worldBuckets[bi];
          while (arr.length && done < BUDGET) { paint(arr.pop()); done++; }
        }
        for (let bi = 0; bi <= wv.worldCur; bi++) {
          const arr = worldTreeBuckets[bi];
          while (arr.length) applyTree(arr.pop());
        }
        if (wv.worldCur >= WB - 1 && worldBuckets.every(a => a.length === 0)) {
          colors.needsUpdate = true;
          this._wave = null;
          this.seasonApplyBusy = false;
          return;
        }
      }
      colors.needsUpdate = true;
      this._waveRAF = requestAnimationFrame(step);
    };
    this._waveRAF = requestAnimationFrame(step);
  }

  // 截图/测试用：立即完成季节过渡（游戏内仍用扫描线，不影响体验）
  finishSeasonWave() {
    if (this._waveRAF) cancelAnimationFrame(this._waveRAF);
    const wv = this._wave;
    this._wave = null;
    this.seasonApplyBusy = false;
    if (!wv) return;
    const paintAll = arr => { while (arr.length) wv.paint(arr.pop()); };
    for (const arr of wv.viewBuckets) paintAll(arr);
    for (const arr of wv.worldBuckets) paintAll(arr);
    if (wv.applyTree) {
      for (const arr of wv.viewTreeBuckets) { while (arr.length) wv.applyTree(arr.pop()); }
      for (const arr of wv.worldTreeBuckets) { while (arr.length) wv.applyTree(arr.pop()); }
    }
    if (this.terrainMesh) this.terrainMesh.geometry.attributes.color.needsUpdate = true;
  }

  // ================= 光照与昼夜 =================
  setupLights() {
    const scene = this.scene;
    this.lightClassic = LIGHT_CLASSIC;
    this.hemi = new THREE.HemisphereLight(0xc3e2ff, 0x6f8558, 1.15);
    scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff2cc, 1.55);
    this.sun.position.set(120, 160, 60);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(3072, 3072);
    this.sun.shadow.radius = 8; // 软阴影，消除生硬黑边
    this.sun.shadow.camera.near = 10; this.sun.shadow.camera.far = 700;
    const sc = this.sun.shadow.camera;
    sc.left = -160; sc.right = 160; sc.top = 160; sc.bottom = -160;
    this.sun.shadow.bias = -0.0006;
    if (this.isCity) {
      // 海特洛市主光：4096 软阴影、更大阴影相机覆盖高架与高楼，bias 微调避免桥面/建筑漏影
      this.sun.shadow.mapSize.set(4096, 4096);
      this.sun.shadow.radius = 10;
      this.sun.shadow.bias = -0.00045;
      sc.left = -220; sc.right = 220; sc.top = 220; sc.bottom = -220;
      sc.updateProjectionMatrix();
    }
    scene.add(this.sun);
    scene.add(this.sun.target);
    // 柔和补光：缓解生硬阴影，让暗部不死黑
    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.55);
    this.fill.position.set(-160, 90, -120);
    scene.add(this.fill);
    if (this.isCity) {
      // 黄昏高光 rim：北侧冷色补光勾勒高楼轮廓，仅在 16<hour<19 且夜未深时启用
      this.cityRim = new THREE.DirectionalLight(0x7f9fd8, 0);
      this.cityRim.position.set(0, 150, 340);
      this.cityRim.visible = false;
      scene.add(this.cityRim);
      scene.add(this.cityRim.target);
    }
    // 环境反射贴图（简易全局光照）：始终生成，按模式决定是否启用
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const mkEnv = (top, mid, bot) => {
        const c = document.createElement('canvas');
        c.width = 256; c.height = 128;
        const g = c.getContext('2d');
        const grd = g.createLinearGradient(0, 0, 0, 128);
        grd.addColorStop(0, top);
        grd.addColorStop(0.45, mid);
        grd.addColorStop(1, bot);
        g.fillStyle = grd;
        g.fillRect(0, 0, 256, 128);
        const tex = new THREE.CanvasTexture(c);
        tex.mapping = THREE.EquirectangularReflectionMapping;
        const rt = pmrem.fromEquirectangular(tex);
        tex.dispose();
        return rt.texture;
      };
      // 环境亮度克制：避免银色车漆反光过曝发白
      this.envDay = mkEnv('#6fb2e0', '#d6eaf4', '#879f7f');
      this.envNight = mkEnv('#274c78', '#3c6088', '#243248');
      if (this.isCity) {
        if (this.envDay && this.envDay.dispose) this.envDay.dispose();
        if (this.envNight && this.envNight.dispose) this.envNight.dispose();
        // 海特洛市：更通透的蓝绿/深夜蓝紫渐变，车漆反射更清亮
        this.envDay = mkEnv('#8fc8ee', '#e8f2f8', '#9a9f8e');
        this.envNight = mkEnv('#203058', '#3a4a70', '#20242e');
      }
      if (!this.lightClassic) scene.environment = this.envDay;
    } catch (e) { /* 环境贴图失败不影响游戏 */ }
    // 路灯真实点光：8 盏常驻，每帧跳到玩家最近的 8 盏路灯上（避免海量光源卡顿）
    this.lampLights = [];
    for (let i = 0; i < 8; i++) {
      const ll = new THREE.PointLight(0xffd9a0, 0, this.isCity ? 130 : 90, 2);
      ll.visible = false;
      scene.add(ll);
      this.lampLights.push(ll);
    }
    if (this.isCity) {
      // 城市夜景层次：8 盏常驻暖色广场/地标灯，只在 night>0.35 后平滑亮起，不参与阴影
      const lm = (typeof window !== 'undefined' && window.CITY && window.CITY.landmarks) || {};
      const midas = lm.midas || { x: -180, z: 720 };
      const clock = lm.clock || { x: -430, z: -640 };
      const cityLightDefs = [
        { x: -20, z: -16, d: 70, i: 4.0 },  // 中央广场 cross×northsouth 四角
        { x: 20, z: -16, d: 70, i: 4.0 },
        { x: -20, z: 34, d: 70, i: 4.0 },
        { x: 20, z: 34, d: 70, i: 4.0 },
        { x: midas.x - 50, z: midas.z + 52, d: 80, i: 4.0 }, // CBD 迈达斯广场
        { x: midas.x + 50, z: midas.z + 52, d: 80, i: 4.0 },
        { x: clock.x - 48, z: clock.z + 50, d: 65, i: 3.6 }, // 老城钟楼
        { x: clock.x + 48, z: clock.z + 50, d: 65, i: 3.6 },
      ];
      this.cityNightLights = [];
      for (const def of cityLightDefs) {
        const pl = new THREE.PointLight(0xffc080, 0, def.d, 2);
        pl.position.set(def.x, this.terrainHeight(def.x, def.z) + 4.6, def.z);
        pl.castShadow = false;
        pl.visible = false;
        pl.userData.baseIntensity = def.i;
        scene.add(pl);
        this.cityNightLights.push(pl);
      }
    }
    // 大气透视：高山地图更浓的雾让远山融入天际，消除地平线硬切
    this.fog = new THREE.FogExp2(0xcfe0e8, this.map.fogDensity || 0.00055);
    scene.fog = this.fog;
  }

  updateSky(pos) {
    const S = this.seasons[this.season];
    const h = this.hour;
    // 太阳位置
    const ang = (h / 24) * TAU;
    const elev = Math.sin(ang - Math.PI / 2);
    const sunDir = new THREE.Vector3(Math.cos(ang - Math.PI / 2) * 0.75, Math.max(-0.15, elev), 0.55).normalize();
    // 白天亮度
    const day = clamp(smoothstep(5.2, 7.5, h) - smoothstep(18.5, 20.5, h), 0, 1);
    this.darkness = clamp(1 - day, 0, 1);
    const dusk = clamp(1 - Math.abs(h - 18.8) / 1.6, 0, 1);
    const dawn = clamp(1 - Math.abs(h - 6.3) / 1.6, 0, 1);
    const nightF = clamp(smoothstep(20.3, 21.6, h) + smoothstep(5.4, 4.3, h), 0, 1);
    const duskF = Math.max(dawn, dusk);
    // 海特洛市黄金时刻更早、更宽：hour=17.5 已经是浓郁暖金
    const cityGolden = this.isCity ? clamp(1 - Math.abs(h - 18.0) / 2.2, 0, 1) : 0;
    const sunWarm = Math.max(duskF, cityGolden);
    const sunCol = new THREE.Color(0xfff2cc).lerp(new THREE.Color(0xff9350), sunWarm * 0.8);
    if (this.isCity) {
      // 海特洛市主光：4600-5200K 暖金（0xffd9a8 附近），黄金时刻更通透
      sunCol.copy(new THREE.Color(0xffd9a8).lerp(new THREE.Color(0xff9a50), sunWarm * 0.55));
    }
    this.sun.color.copy(sunCol);
    // 天气光照：雨天/雾天/雪天阳光与天空整体变灰变暗
    const wthr = this.weatherAmt || 0;
    const overcast = this.weather === 1 ? wthr : this.weather === 2 ? wthr * 0.75 : this.weather === 3 ? wthr * 0.88 : 0;
    const sunMul = this.isCity ? 1.15 : 1;
    if (this.lightClassic) {
      this.sun.intensity = (0.15 + day * 1.4) * (1 - overcast * 0.78) * sunMul;
      this.hemi.intensity = (0.28 + day * 0.62) * (1 - overcast * 0.55);
      this.fill.intensity = (0.24 + day * 0.34) * (1 - overcast * 0.45);
    } else {
      // F8 真实光照：夜晚几乎黑（月光/天光极弱），白天明亮；夜间照明交给路灯与车灯
      this.sun.intensity = (0.06 + day * 1.5) * (1 - overcast * 0.8) * sunMul;
      this.hemi.intensity = (0.12 + day * 0.66) * (1 - overcast * 0.55);
      this.fill.intensity = (0.05 + day * 0.34) * (1 - overcast * 0.45);
    }
    if (this.isCity) {
      // 城市夜景暗部提亮：轻微抬升避免死黑，但不能让路面像白天
      this.hemi.intensity *= (1 + nightF * 0.30);
      this.fill.intensity *= (1 + nightF * 0.25);
    }
    this.sun.position.copy(sunDir).multiplyScalar(320);
    // 天空颜色
    // 夜间月光色调：太阳光兼职月光，冷白偏蓝
    sunCol.lerp(new THREE.Color(0xa9c4ee), nightF * (this.lightClassic ? 0 : 0.7));
    this.sun.color.copy(sunCol);
    const skyTop = new THREE.Color(0x123c66).lerp(new THREE.Color(S.sky), day);
    const skyMid = new THREE.Color(0x1d2c4a).lerp(new THREE.Color(0x9fd8f0), day);
    const skyBot = new THREE.Color(0x3a2f4a).lerp(new THREE.Color(0xd8ecf5), day);
    // 夜间天空微亮（F8 模式保持真实暗夜，只给一点月夜蓝，避免死黑）
    if (!this.lightClassic) {
      skyTop.lerp(new THREE.Color(0x1a3052), nightF * 0.2);
      skyMid.lerp(new THREE.Color(0x20304a), nightF * 0.2);
      skyBot.lerp(new THREE.Color(0x2a2438), nightF * 0.2);
    }
    // 阴天/雾天：天空向灰白压
    skyTop.lerp(new THREE.Color(0x6b7b88), overcast * 0.72);
    skyMid.lerp(new THREE.Color(0xaab6bd), overcast * 0.78);
    skyBot.lerp(new THREE.Color(0xd6dde0), overcast * 0.7);
    skyTop.lerp(new THREE.Color(0x4a3a6a), duskF * 0.35); // 黄昏天际顶部微紫
    skyMid.lerp(new THREE.Color(0xffb37a), duskF * 0.75);
    skyBot.lerp(new THREE.Color(0xffc48a), duskF * 0.5);
    if (this.isCity) {
      // 海特洛市黄金时刻天空更暖更透，同时保留新海诚蓝紫层次
      skyTop.lerp(new THREE.Color(0x5a4a7a), cityGolden * 0.55);
      skyMid.lerp(new THREE.Color(0xffb87a), cityGolden * 0.75);
      skyBot.lerp(new THREE.Color(0xffc48a), cityGolden * 0.85);
    }
    const u = this.sky.material.uniforms;
    u.top.value.copy(skyTop); u.mid.value.copy(skyMid); u.bot.value.copy(skyBot);
    u.sunDir.value.copy(sunDir);
    u.sunCol.value.copy(sunCol);
    u.warm.value = this.isCity ? Math.max(duskF, cityGolden) : duskF;
    // 黄昏/黎明时环境光转暖，草与路面染上金色
    this.hemi.color.copy(new THREE.Color(0xc3e2ff).lerp(new THREE.Color(0xffc07a), duskF * 0.55));
    this.fill.color.copy(new THREE.Color(0xbfd4ff).lerp(new THREE.Color(0xffb066), duskF * 0.5));
    if (this.isCity) {
      // 城市天空光：白天冷蓝/灰绿，黄金时刻暖橙，夜晚深蓝
      const cityHemiWarm = Math.max(duskF, cityGolden);
      const cityHemiSky = new THREE.Color(0xbcd8f0)
        .lerp(new THREE.Color(0xffc987), cityHemiWarm * 0.85)
        .lerp(new THREE.Color(0x1a2440), nightF);
      const cityHemiGround = new THREE.Color(0x8a9486)
        .lerp(new THREE.Color(0x6a6a7a), cityHemiWarm * 0.85)
        .lerp(new THREE.Color(0x1c1c28), nightF);
      this.hemi.color.copy(cityHemiSky);
      this.hemi.groundColor.copy(cityHemiGround);
    }
    // 雾
    const fogCol = new THREE.Color(S.fog).lerp(new THREE.Color(0x202638), nightF * 0.72);
    fogCol.lerp(new THREE.Color(0xe8a06a), duskF * 0.65);
    if (this.isCity) {
      // 黄金时刻城市空气也染上暖金色，远山空气透视更柔和
      fogCol.lerp(new THREE.Color(0xe8b070), cityGolden * 0.5);
    }
    const wFogCol = this.weather === 3 ? 0xe9edf2 : 0xc2ccd2; // 雪天偏白雾
    const wFogK = this.weather === 1 ? wthr * 0.75 : this.weather === 2 ? wthr * 0.9 : this.weather === 3 ? wthr * 0.9 : 0;
    fogCol.lerp(new THREE.Color(wFogCol), wFogK);
    this.fog.color.copy(fogCol);
    if (this.isCity) {
      // 城市雾密度随时间变化：白天通透、黄昏微增、夜间更浓，保持远山空气透视
      const duskOnly = clamp(1 - Math.abs(h - 18.8) / 1.6, 0, 1);
      let cityFog = lerp(0.00011, 0.00016, Math.max(duskOnly, cityGolden));
      cityFog = lerp(cityFog, 0.00022, nightF);
      const weatherFog = this.weather === 1 ? 0.0009 : this.weather === 2 ? 0.0024 : this.weather === 3 ? 0.0014 : 0;
      cityFog = lerp(cityFog, weatherFog, clamp(this.weatherAmt || 0, 0, 1));
      this.fog.density = cityFog;
    }
    this.renderer.setClearColor(fogCol);
    // 太阳/月亮/星星
    this.sunSprite.position.copy(sunDir).multiplyScalar(4500);
    this.sunSprite.material.opacity = day * 0.95 + duskF * 0.55;
    this.moonSprite.position.copy(sunDir).multiplyScalar(-4400);
    this.moonSprite.position.y = Math.max(this.moonSprite.position.y, -600);
    this.moonSprite.material.opacity = nightF * (this.isCity ? 0.55 : 0.9);
    this.stars.material.opacity = nightF * 0.62;
    // 路灯：夜间渐亮
    const lampK = clamp(nightF * 1.5, 0, 1);
    const cityLampBoost = this.isCity ? 0.55 : 1;
    for (const l of this.lamps) l.material.emissiveIntensity = lampK * 1.7;
    if (this.lampGlows) {
      for (const gl of this.lampGlows) gl.material.opacity = lampK * 0.4;
    }
    // 真实点光：把 8 盏灯跳到玩家/相机最近的 8 盏路灯上
    if (this.lampLights && this.lampPoints && this.lampPoints.length) {
      const px = pos && pos.x != null ? pos.x : (this._lampCamX || 0);
      const pz = pos && pos.z != null ? pos.z : (this._lampCamZ || 0);
      this._lampCamX = px; this._lampCamZ = pz;
      const order = [];
      for (let i = 0; i < this.lampPoints.length; i++) {
        const pt = this.lampPoints[i];
        const dx = pt.x - px, dz = pt.z - pz;
        order.push([i, dx * dx + dz * dz]);
      }
      order.sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < this.lampLights.length; i++) {
        const ll = this.lampLights[i];
        if (lampK < 0.02 || i >= order.length) { ll.visible = false; continue; }
        const pt = this.lampPoints[order[i][0]];
        ll.position.set(pt.x, pt.y, pt.z);
        // 点光源在 three.js 里要除以 π；配合 PBR 路面，亮度调高让光斑清晰可见但不过曝
        ll.intensity = lampK * 9 * cityLampBoost;
        ll.visible = true;
      }
    }
    if (this.isCity) {
      // 常驻广场/地标暖色点光：night>0.35 后平滑亮起
      const cityNightK = smoothstep(0.35, 0.7, nightF);
      if (this.cityNightLights) {
        for (const pl of this.cityNightLights) {
          if (cityNightK < 0.01) { pl.visible = false; continue; }
          pl.visible = true;
          pl.intensity = cityNightK * (pl.userData.baseIntensity || 4.0);
        }
      }
      // 黄昏高光 rim：北侧冷色补光勾勒高楼轮廓
      if (this.cityRim) {
        const rimOn = h > 16 && h < 19 && nightF < 0.5;
        const rx = pos && pos.x != null ? pos.x : (this._lampCamX || 0);
        const rz = pos && pos.z != null ? pos.z : (this._lampCamZ || 0);
        const ry = this.terrainHeight(rx, rz);
        this.cityRim.visible = rimOn;
        this.cityRim.intensity = rimOn ? 0.25 : 0;
        if (rimOn) {
          this.cityRim.position.set(rx, ry + 150, rz + 340);
          this.cityRim.target.position.set(rx, ry, rz);
          this.cityRim.target.updateMatrixWorld();
        }
      }
    }
    // 环境反射昼夜切换（仅优化模式）
    if (this.lightClassic) {
      if (this.scene.environment) this.scene.environment = null;
    } else if (this.envDay && this.envNight) {
      this.scene.environment = nightF > 0.5 ? this.envNight : this.envDay;
    }
    // 城市模块昼夜联动（窗户发光/招牌/异象/云层色调）
    if (this.isCity && window.CITY && window.CITY.updateNight) {
      try { window.CITY.updateNight(this); } catch (e) { /* 城市昼夜钩子失败不影响主循环 */ }
    }
    // 体积云：覆盖率随天气、颜色随昼夜/阴晴
    if (this.cloudUniforms) {
      const covTarget = this.weather === 0 ? 0.38 : this.weather === 2 ? 0.92 : 0.8;
      this.cloudUniforms.uCoverage.value = lerp(this.cloudUniforms.uCoverage.value, covTarget, 0.03);
      this.cloudUniforms.uSunDir.value.copy(sunDir);
      this.cloudUniforms.uSunCol.value.copy(sunCol);
      this.cloudUniforms.uGrey.value = nightF * 0.55 + (this.weather !== 0 ? wthr : 0) * 0.55;
    }
  }

  update(dt, camPos) {
    if (this.waterMesh && this.waterMesh.material.uniforms) {
      this.waterMesh.material.uniforms.uTime.value += dt;
      if (camPos && camPos.isVector3) this.waterMesh.material.uniforms.camPos.value.copy(camPos);
    }
    if (this.cloudUniforms) this.cloudUniforms.uTime.value += dt;
    for (const w of this.windmills) w.blades.rotation.z += dt * w.speed;
    // 城市模块每帧联动：云漂移/花瓣/异象呼吸 + 窗户与招牌昼夜发光
    if (this.isCity && window.CITY && window.CITY.updateNight) {
      try { window.CITY.updateNight(this); } catch (e) { /* 城市动态钩子失败不影响主循环 */ }
    }
    // 天气不为晴或正在过渡时更新（weatherAmt 从 0 启动的 gate 会死锁）
    if (this.weather !== 0 || this.weatherAmt > 0.01) this.updateWeather(dt, camPos);
  }
}

// ---------- 工具：canvas 纹理 ----------
function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// 雨丝贴图：竖直细长渐隐光条，让雨点看起来是"雨丝"而非圆点
let _rainTex = null;
function rainStreakTex() {
  if (_rainTex) return _rainTex;
  const c = document.createElement('canvas');
  c.width = 16; c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(200,225,245,0)');
  g.addColorStop(0.5, 'rgba(215,235,250,0.95)');
  g.addColorStop(1, 'rgba(200,225,245,0)');
  ctx.fillStyle = g;
  ctx.fillRect(5, 0, 6, 64);
  _rainTex = new THREE.CanvasTexture(c);
  return _rainTex;
}

// 真实路面贴图（ambientCG CC0）：加载失败时退回程序化纹理
let _roadTexPromise = null;
function loadRoadTextures() {
  if (_roadTexPromise) return _roadTexPromise;
  _roadTexPromise = new Promise(resolve => {
    const out = { asphalt: null, gravel: null };
    let left = 2;
    const done = () => { if (--left <= 0) resolve(out); };
    const loadOne = (src, key) => {
      const img = new Image();
      img.onload = () => {
        try {
          // file:// 下 THREE.Texture 直接上传 JPEG 会渲染成黑，
          // 先画到 canvas 再走 CanvasTexture（与车道线同一可靠路径）
          const cv = document.createElement('canvas');
          cv.width = img.width; cv.height = img.height;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const t = new THREE.CanvasTexture(cv);
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
          t.repeat.set(1, 1);
          if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
          else if (THREE.sRGBEncoding !== undefined) t.encoding = THREE.sRGBEncoding;
          t.anisotropy = 8;
          t.generateMipmaps = true;
          t.minFilter = THREE.LinearMipmapLinearFilter;
          t.needsUpdate = true;
          out[key] = t;
        } catch (e) { console.error('road tex apply fail', src, e); }
        done();
      };
      img.onerror = () => { console.error('road tex load fail', src); done(); };
      img.src = src;
    };
    const D = window.ROAD_TEX_DATA || {};
    loadOne(D.asphalt || 'assets/textures/asphalt_010_2k.jpg', 'asphalt');
    loadOne(D.gravel || 'assets/textures/gravel_002_2k.jpg', 'gravel');
  });
  return _roadTexPromise;
}

// 车道线贴图：2048x512 覆盖 14.4m x 40m 路面，白实线 + 黄虚线（4m 线 / 6m 空）
function makeLaneTexture() {
  return canvasTex(2048, 512, c => {
    c.clearRect(0, 0, 2048, 512);
    const wear = () => {
      for (let i = 0; i < 26; i++) {
        c.fillStyle = `rgba(28,28,30,${0.18 + Math.random() * 0.22})`;
        c.fillRect(Math.random() * 2048, Math.random() * 512, 2 + Math.random() * 5, 2 + Math.random() * 4);
      }
    };
    // 两侧白色实线（每条约 0.2m）
    c.fillStyle = 'rgba(242,242,246,0.96)';
    c.fillRect(96, 0, 29, 512);
    c.fillRect(1923, 0, 29, 512);
    // 中央黄色虚线（每条约 0.17m，4m 线段 / 6m 间隔）
    // CanvasTexture flipY=true：v=0 对应画布底部，线段画在底部 4 个区段
    c.fillStyle = 'rgba(240,196,48,1)';
    for (let i = 0; i < 4; i++) c.fillRect(1012, 460 - i * 128, 24, 51.2);
    wear();
  });
}

function makeRoadTexture(dirt) {
  return canvasTex(512, 512, c => {
    if (dirt) {
      c.fillStyle = '#8a7753'; c.fillRect(0, 0, 256, 256);
      c.fillStyle = '#8a7753'; c.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 11000; i++) {
        c.fillStyle = `rgba(${90 + Math.random() * 80},${70 + Math.random() * 70},${40 + Math.random() * 40},0.4)`;
        c.fillRect(Math.random() * 512, Math.random() * 512, 3.4 + Math.random() * 3, 2 + Math.random() * 2);
      }
      // 车辙：两条深色轮辙带
      for (let i = 0; i < 900; i++) {
        c.fillStyle = `rgba(${70 + Math.random() * 40},${52 + Math.random() * 30},${26 + Math.random() * 20},0.35)`;
        c.fillRect(92 + Math.random() * 38, Math.random() * 512, 12 + Math.random() * 18, 3 + Math.random() * 4);
        c.fillRect(382 + Math.random() * 38, Math.random() * 512, 12 + Math.random() * 18, 3 + Math.random() * 4);
      }
      // 碎石颗粒
      for (let i = 0; i < 800; i++) {
        c.fillStyle = `rgba(${150 + Math.random() * 60},${120 + Math.random() * 50},${70 + Math.random() * 40},0.5)`;
        c.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
      }
      return;
    }
    // 沥青基底：带轻微色差的深灰
    const base = c.createLinearGradient(0, 0, 512, 512);
    base.addColorStop(0, '#35383e');
    base.addColorStop(0.5, '#31343a');
    base.addColorStop(1, '#373a40');
    c.fillStyle = base; c.fillRect(0, 0, 512, 512);
    // 高频沥青颗粒
    for (let i = 0; i < 24000; i++) {
      const g = 40 + Math.random() * 36;
      c.fillStyle = `rgba(${g},${g + 2},${g + 5},0.5)`;
      c.fillRect(Math.random() * 512, Math.random() * 512, 1.2 + Math.random() * 1.8, 1.2 + Math.random() * 1.8);
    }
    // 粗颗粒与磨损斑块
    for (let i = 0; i < 1200; i++) {
      const g = 34 + Math.random() * 24;
      c.fillStyle = `rgba(${g},${g + 1},${g + 3},0.28)`;
      c.beginPath();
      c.ellipse(Math.random() * 512, Math.random() * 512, 4 + Math.random() * 14, 2.5 + Math.random() * 8, Math.random() * 3, 0, TAU);
      c.fill();
    }
    // 随机裂缝：细长深色线
    for (let i = 0; i < 60; i++) {
      c.strokeStyle = `rgba(18,20,24,${0.25 + Math.random() * 0.35})`;
      c.lineWidth = 0.8 + Math.random() * 1.4;
      const x0 = Math.random() * 512, y0 = Math.random() * 512;
      c.beginPath(); c.moveTo(x0, y0);
      let x = x0, y = y0;
      const segs = 3 + Math.floor(Math.random() * 5);
      for (let s = 0; s < segs; s++) {
        x += (Math.random() - 0.5) * 26; y += (Math.random() - 0.5) * 26;
        c.lineTo(x, y);
      }
      c.stroke();
    }
    // 沥青修补块：方形深色补丁 + 边缘
    for (let i = 0; i < 26; i++) {
      const px = Math.random() * 470, py = Math.random() * 470;
      const s = 18 + Math.random() * 42;
      c.fillStyle = `rgba(22,24,28,${0.22 + Math.random() * 0.2})`;
      c.fillRect(px, py, s, s);
      c.strokeStyle = `rgba(10,11,13,0.5)`;
      c.lineWidth = 1;
      c.strokeRect(px, py, s, s);
    }
    // 油渍/水痕
    for (let i = 0; i < 14; i++) {
      const g = 24 + Math.random() * 14;
      c.fillStyle = `rgba(${g},${g},${g + 2},0.30)`;
      c.beginPath();
      c.ellipse(60 + Math.random() * 392, 60 + Math.random() * 392, 8 + Math.random() * 22, 5 + Math.random() * 14, Math.random() * 3, 0, TAU);
      c.fill();
    }
  });
}

function buildHouse(w, h, l, color, rng) {
  const g = new THREE.Group();
  const wallMat = new THREE.MeshLambertMaterial({ color });
  const roofMat = new THREE.MeshLambertMaterial({ color: 0x4c4340 });
  const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), wallMat);
  wall.position.y = h / 2;
  g.add(wall);
  const roof = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 4), roofMat);
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(w * 1.12, h * 0.52, l * 1.1);
  roof.position.y = h + h * 0.2;
  g.add(roof);
  const doorMat = new THREE.MeshLambertMaterial({ color: 0x4a3222 });
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.1, 2.0, 0.1), doorMat);
  door.position.set(0, 1.0, l / 2 + 0.05);
  g.add(door);
  const winMat = new THREE.MeshLambertMaterial({ color: 0xbfe6ff });
  for (const sx of [-1, 1]) {
    for (const sz of [-0.25, 0.25]) {
      const win = new THREE.Mesh(new THREE.BoxGeometry(0.95, 1.0, 0.06), winMat);
      win.position.set(sx * w * 0.26, 1.9, sz * l + 0.04);
      g.add(win);
    }
  }
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.7, 0.7), new THREE.MeshLambertMaterial({ color: 0x7a4a32 }));
  chimney.position.set(w * 0.25, h + h * 0.45, 0);
  g.add(chimney);
  g.castShadow = true;
  return g;
}

// ---------- 轮胎烟雾（漂移/烧胎时的粒子） ----------
class TireSmoke {
  constructor(scene) {
    this.scene = scene;
    const tex = canvasTex(64, 64, c => {
      const g = c.createRadialGradient(32, 32, 3, 32, 32, 30);
      g.addColorStop(0, 'rgba(236,236,242,0.85)');
      g.addColorStop(0.55, 'rgba(190,190,200,0.42)');
      g.addColorStop(1, 'rgba(160,160,175,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    });
    this.pool = [];
    for (let i = 0; i < 100; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.pool.push({ s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, size: 1 });
    }
    this.ptr = 0;
  }

  emit(x, y, z, vy, vx, vz, size) {
    const p = this.pool[this.ptr];
    this.ptr = (this.ptr + 1) % this.pool.length;
    p.s.visible = true;
    p.s.position.set(x + (Math.random() - 0.5) * 0.3, y, z + (Math.random() - 0.5) * 0.3);
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.size = size;
    p.life = 0;
    p.max = 0.8 + Math.random() * 0.7;
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.s.visible) continue;
      p.life += dt;
      if (p.life >= p.max) { p.s.visible = false; continue; }
      const f = p.life / p.max;
      p.s.position.x += p.vx * dt;
      p.s.position.y += p.vy * dt - f * f * 0.6 * dt;
      p.s.position.z += p.vz * dt;
      const sc = p.size * (0.65 + f * 1.5);
      p.s.scale.set(sc, sc * 0.9, 1);
      p.s.material.opacity = Math.pow(1 - f, 1.5) * 0.3;
    }
  }
}

// ---------- 夜间尾灯拖尾（异环风格光轨） ----------
class TaillightTrail {
  constructor(scene) {
    this.scene = scene;
    const tex = canvasTex(64, 64, c => {
      const g = c.createRadialGradient(32, 32, 2, 32, 32, 30);
      g.addColorStop(0, 'rgba(255,120,90,0.95)');
      g.addColorStop(0.45, 'rgba(255,70,60,0.5)');
      g.addColorStop(1, 'rgba(255,40,40,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, 64, 64);
    });
    this.pool = [];
    for (let i = 0; i < 80; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0, blending: THREE.AdditiveBlending });
      const s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      this.pool.push({ s, life: 0, max: 1 });
    }
    this.ptr = 0;
  }

  emit(x, y, z, size) {
    const p = this.pool[this.ptr];
    this.ptr = (this.ptr + 1) % this.pool.length;
    p.s.visible = true;
    p.s.position.set(x, y, z);
    p.life = 0;
    p.max = 1.3 + Math.random() * 0.7;
    this._size = size || 0.5;
    p.s.scale.set(this._size, this._size, 1);
    p.s.material.opacity = 0.72;
  }

  update(dt) {
    for (const p of this.pool) {
      if (!p.s.visible) continue;
      p.life += dt;
      if (p.life >= p.max) { p.s.visible = false; continue; }
      const f = p.life / p.max;
      const sc = (p.s.scale.x || 0.5) * (1 + f * 0.8);
      p.s.scale.set(sc, sc, 1);
      p.s.material.opacity = Math.pow(1 - f, 1.5) * 0.72;
    }
  }
}

// ---------- 尾灯点线光轨：高速下红色发光拖尾 ----------
class LightTrail {
  constructor(scene) {
    this.MAX = 12000;
    this.count = 0;
    this.clock = 0;

    this.positions = new Float32Array(this.MAX * 3);
    this.birth = new Float32Array(this.MAX);
    this.life = new Float32Array(this.MAX);
    this.size = new Float32Array(this.MAX);
    this.intensity = new Float32Array(this.MAX);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.positions, 3)
    );
    this.geometry.setAttribute(
      'aBirth',
      new THREE.BufferAttribute(this.birth, 1)
    );
    this.geometry.setAttribute(
      'aLife',
      new THREE.BufferAttribute(this.life, 1)
    );
    this.geometry.setAttribute(
      'aSize',
      new THREE.BufferAttribute(this.size, 1)
    );
    this.geometry.setAttribute(
      'aIntensity',
      new THREE.BufferAttribute(this.intensity, 1)
    );
    this.geometry.setDrawRange(0, 0);

    this.material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: {
          value: Math.min(window.devicePixelRatio || 1, 2)
        }
      },
      vertexShader: `
        attribute float aBirth;
        attribute float aLife;
        attribute float aSize;
        attribute float aIntensity;

        uniform float uTime;
        uniform float uPixelRatio;

        varying float vAlpha;
        varying float vIntensity;

        void main() {
          float age = max(0.0, uTime - aBirth);
          float t = clamp(age / max(aLife, 0.001), 0.0, 1.0);

          float fadeIn = smoothstep(0.0, 0.045, t);
          float fadeOut = 1.0 - smoothstep(0.42, 1.0, t);
          vAlpha = fadeIn * fadeOut;
          vIntensity = aIntensity;

          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float perspective = 760.0 / max(1.0, -mv.z);
          float ageSpread = mix(1.0, 1.42, t);

          gl_PointSize = clamp(
            aSize * ageSpread * perspective * uPixelRatio,
            3.0,
            34.0
          );
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying float vIntensity;

        void main() {
          vec2 p = gl_PointCoord * 2.0 - 1.0;
          float r = length(p);
          if (r > 1.0) discard;

          float core = exp(-r * r * 28.0);
          float midGlow = exp(-r * r * 7.5);
          float outerGlow = exp(-r * r * 2.2);

          vec3 hot = vec3(1.0, 0.72, 0.52);
          vec3 red = vec3(1.0, 0.035, 0.085);
          vec3 deep = vec3(0.62, 0.0, 0.055);

          vec3 color =
              hot * core * 1.5 +
              red * midGlow * 1.15 +
              deep * outerGlow * 0.72;

          float alpha =
              (core * 0.95 + midGlow * 0.52 + outerGlow * 0.2) *
              vAlpha *
              vIntensity;

          gl_FragColor = vec4(color, alpha);
        }
      `
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);

    // 兼容可能引用旧字段的代码。
    this.g = this.geometry;
    this.p = this.points;
    this.n = 0;
  }

  add(x, y, z, size = 0.12, life = 1.8, intensity = 1) {
    if (this.count >= this.MAX) {
      const keep = Math.floor(this.MAX * 0.72);
      const start = this.count - keep;

      this.positions.copyWithin(0, start * 3, this.count * 3);
      this.birth.copyWithin(0, start, this.count);
      this.life.copyWithin(0, start, this.count);
      this.size.copyWithin(0, start, this.count);
      this.intensity.copyWithin(0, start, this.count);
      this.count = keep;
    }

    const index = this.count;
    const p = index * 3;

    this.positions[p] = x;
    this.positions[p + 1] = y;
    this.positions[p + 2] = z;
    this.birth[index] = this.clock;
    this.life[index] = life;
    this.size[index] = size;
    this.intensity[index] = intensity;

    this.count++;
    this.n = this.count;
  }

  update(dt) {
    this.clock += Math.min(Math.max(dt || 0, 0), 0.1);
    this.material.uniforms.uTime.value = this.clock;
    this.material.uniforms.uPixelRatio.value = Math.min(
      window.devicePixelRatio || 1,
      2
    );

    let firstAlive = 0;
    while (
      firstAlive < this.count &&
      this.clock - this.birth[firstAlive] > this.life[firstAlive]
    ) {
      firstAlive++;
    }

    if (firstAlive > 0) {
      this.positions.copyWithin(0, firstAlive * 3, this.count * 3);
      this.birth.copyWithin(0, firstAlive, this.count);
      this.life.copyWithin(0, firstAlive, this.count);
      this.size.copyWithin(0, firstAlive, this.count);
      this.intensity.copyWithin(0, firstAlive, this.count);
      this.count -= firstAlive;
    }

    this.n = this.count;
    this.geometry.setDrawRange(0, this.count);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aBirth.needsUpdate = true;
    this.geometry.attributes.aLife.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aIntensity.needsUpdate = true;
  }
}

// Continuous twin taillight ribbons inspired by the supplied reference image.
// Each lamp keeps its own short world-space history, producing two coherent bands
// rather than a cloud of independent particles.
class RibbonLightTrail {
  constructor(scene, hollow = false, thickness = 0.045) {
    this.maxSamples = 40;
    this.histories = [];
    this.layers = [];
    this.lampWidths = null;
    this.sampleClock = 0;
    this.n = 0;
    this.scene = scene;
    this.enabled = true;
    this.hollow = hollow; // hollow=true: 中间虚、两侧实(空心光管)
    this.halfT = thickness; // 竖直厚度的一半
    this.gainMul = hollow ? 2.0 : 1.0; // 光管稍亮
  }

  setVisible(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      for (const l of this.layers) {
        l.glow.mesh.visible = false;
        l.core.mesh.visible = false;
      }
    }
  }

  _ensure(count) {
    while (this.histories.length < count) {
      this.histories.push([]);
      this.layers.push({
        glow: this._makeLayer(this.scene),
        core: this._makeLayer(this.scene)
      });
    }
    while (this.histories.length > count) {
      this.histories.pop();
      const l = this.layers.pop();
      this.scene.remove(l.glow.mesh);
      this.scene.remove(l.core.mesh);
    }
  }

  _makeLayer(scene) {
    const geometry = new THREE.BufferGeometry();
    // 盒状截面：每个采样点 4 个顶点(左下/左上/右下/右上)，带竖直厚度
    const positions = new Float32Array(this.maxSamples * 4 * 3);
    const colors = new Float32Array(this.maxSamples * 4 * 3);
    const aW = new Float32Array(this.maxSamples * 4);
    const indices = new Uint16Array((this.maxSamples - 1) * 24);
    // 面(顶点对): 底面(0,2) 顶面(1,3) 左面(0,1) 右面(2,3)
    const faces = [[0, 2], [1, 3], [0, 1], [2, 3]];
    for (let i = 0; i < this.maxSamples - 1; i++) {
      const a = i * 4, k = i * 24;
      for (let f = 0; f < 4; f++) {
        const u = faces[f][0], vv = faces[f][1];
        const q = k + f * 6;
        indices[q] = a + u;
        indices[q + 1] = a + vv;
        indices[q + 2] = a + 4 + u;
        indices[q + 3] = a + vv;
        indices[q + 4] = a + 4 + vv;
        indices[q + 5] = a + 4 + u;
      }
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aW', new THREE.BufferAttribute(aW, 1));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.setDrawRange(0, 0);
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `
        attribute vec3 color;
        attribute float aW;
        varying vec3 vColor;
        varying float vW;
        void main() {
          vColor = color;
          vW = aW;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vW;
        void main() {
          // 普通：中心亮、边缘虚；hollow(光管)：中间亮、边缘也柔(线性软渐隐)
          float soft = ` + (this.hollow
            ? `1.0 - 0.7 * abs(vW);`
            : `smoothstep(1.0, 0.05, abs(vW));`) + `
          soft = max(soft, ` + (this.hollow ? '0.15' : '0.10') + `);
          gl_FragColor = vec4(vColor * soft, soft);
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    mesh.visible = false;
    scene.add(mesh);
    return { geometry, positions, colors, aW, mesh };
  }

  updateRibbon(dt, lamps, darkness, speed) {
    dt = Math.min(Math.max(dt || 0, 0), 0.1);
    const dark = smoothstep(0.08, 0.95, clamp(darkness || 0, 0, 1));
    // 拖尾长度随车速渐进，到 70km/h（19.44 m/s）封顶，之后不再变长
    const speedK = smoothstep(5, 42, Math.min(Math.abs(speed || 0), 19.44));
    const strength = dark * speedK;
    const targetLength = 1.0 + strength * 3.4;
    // lifeMax 下限提高：高速时历史点不会过快地增删，减少闪烁
    const lifeMax = clamp(targetLength / Math.max(4, Math.abs(speed || 0)), 0.12, 0.24);
    this.sampleClock += dt;

    for (const history of this.histories) {
      for (const p of history) p.age += dt;
      while (history.length && history[history.length - 1].age > lifeMax) history.pop();
    }

    if (lamps && lamps.length && strength > 0.015 && this.sampleClock >= 1 / 240) {
      this.sampleClock = 0;
      this._ensure(lamps.length);
      this.lampWidths = lamps.map(l => (l.w != null ? l.w : 0.6));
      this.lampGains = lamps.map(l => (l.g != null ? l.g : 1));
      for (let k = 0; k < lamps.length; k++) {
        const l = lamps[k];
        const history = this.histories[k];
        const prev = history[0];
        if (prev && Math.hypot(l.x - prev.x, l.y - prev.y, l.z - prev.z) > 7) history.length = 0;
        // 新采样点与上一帧平滑衔接，避免网格顶点跳变导致闪烁
        const p = history[0];
        history.unshift(p ? {
          x: lerp(p.x, l.x, 0.6), y: lerp(p.y, l.y, 0.6), z: lerp(p.z, l.z, 0.6),
          rx: l.rx, rz: l.rz, age: 0,
        } : {
          x: l.x, y: l.y, z: l.z, rx: l.rx, rz: l.rz, age: 0,
        });
        if (history.length > this.maxSamples) history.length = this.maxSamples;
      }
    }

    this.n = 0;
    for (const h of this.histories) this.n += h.length;
    for (let k = 0; k < this.histories.length; k++) {
      // 每条横向条带宽度不同（覆盖尾灯四边形轮廓），等宽、不扇形
      const w = (this.lampWidths && this.lampWidths[k] != null) ? this.lampWidths[k] : 0.6;
      const g = (this.lampGains && this.lampGains[k] != null) ? this.lampGains[k] : 1;
      this._buildLayer(this.layers[k].glow, this.histories[k], lifeMax, strength, w, 0.10 * this.gainMul * g);
      this._buildLayer(this.layers[k].core, this.histories[k], lifeMax, strength, w * 0.7, 0.40 * this.gainMul * g);
    }
  }

  _buildLayer(layer, history, lifeMax, strength, width, gain) {
    const n = Math.min(history.length, this.maxSamples);
    layer.mesh.visible = this.enabled && n >= 2 && strength > 0.01;
    if (!layer.mesh.visible) {
      layer.geometry.setDrawRange(0, 0);
      return;
    }
    for (let i = 0; i < n; i++) {
      const p = history[i];
      const t = clamp(p.age / Math.max(0.001, lifeMax), 0, 1);
      const fade = Math.pow(1 - t, 1.35);
      const nearFade = i === 0 ? 0.68 : 1;
      const intensity = strength * fade * gain * nearFade;
      const w = width; // 等宽，不随距离变宽（屏幕上的"变宽"由透视自然产生）
      const yDrop = t * t * 0.035;
      const halfT = this.halfT; // 竖直厚度的一半
      for (let side = 0; side < 2; side++) {
        const sign = side ? 1 : -1;
        for (let vside = 0; vside < 2; vside++) {
          const vsign = vside ? 1 : -1;
          const vi = (i * 4 + side * 2 + vside) * 3;
          const wi = i * 4 + side * 2 + vside;
          layer.aW[wi] = side ? 1 : -1;
          layer.positions[vi] = p.x + p.rx * sign * w * 0.5;
          layer.positions[vi + 1] = p.y - yDrop + vsign * halfT;
          layer.positions[vi + 2] = p.z + p.rz * sign * w * 0.5;
          layer.colors[vi] = intensity;
          layer.colors[vi + 1] = intensity * 0.035;
          layer.colors[vi + 2] = intensity * 0.055;
        }
      }
    }
    layer.geometry.setDrawRange(0, (n - 1) * 24);
    layer.geometry.attributes.position.needsUpdate = true;
    layer.geometry.attributes.color.needsUpdate = true;
    layer.geometry.attributes.aW.needsUpdate = true;
    // 不调 computeBoundingSphere：mesh frustumCulled=false，包围球只浪费 CPU
  }

  update(dt) {
    this.updateRibbon(dt, null, 0, 0);
  }
}
