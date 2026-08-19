// ============================================================
//  CITY CORE — 海特洛市（新海诚风二次元都市）公共契约层
//  ------------------------------------------------------------
//  本文件是所有城市模块（city_buildings/roads/props/trees/sky）的
//  共享基础：命名空间 window.CITY、分区与配色、确定性随机、贴图工厂、
//  地块规划、几何合并、夜间材质注册、构建阶段管线。
//
//  规则：
//  1. 全部模块用 IIFE 包裹，禁止在顶层声明 const/let/function，
//     以免与其它经典脚本共享的全局词法作用域冲突。
//  2. 各模块只写自己的文件；需要扩展时给 CITY 增加属性/阶段即可。
//  3. 不要在本文件里创建任何场景对象（Mesh/Light 等），只提供数据与工具。
// ============================================================
'use strict';

(() => {
  const C = {
    version: 'city-20260815',

    // 构建阶段：各模块按加载顺序 push 自己的构建函数。
    // 每个阶段签名：(world) => { ... return statsObject }。
    stages: [],

    // 规划结果
    lots: [],      // 建筑地块 [{x,z,w,d,yaw,zone,idx,keep}]
    blocks: [],    // 街区（预留）
    colliders: [], // 城市静态碰撞注册

    // 道具占位点（props 阶段填充，trees 阶段读取避让）
    lampSpots: [],   // 路灯灯杆位置 [{x,z}]
    fenceSpots: [],  // 护栏采样位置 [{x,z}]（约每 3m 一个）

    // 夜间材质与动态钩子
    nightMats: [],
    updateFns: [],

    // 统计
    stats: {},
  };

  // ---------- 确定性随机（种子固定，地图可复现） ----------
  C.rng = (typeof makeRng === 'function') ? makeRng(20260815) : Math.random;
  const rng = C.rng;
  C.rand = (a, b) => a + rng() * (b - a);
  C.pick = arr => arr[Math.floor(rng() * arr.length)];
  C.chance = p => rng() < p;

  // ---------- 分区定义（平面矩形，优先级从高到低） ----------
  // 城市总体：北高南低、靠山面海。z 向北为正。
  C.zoneDefs = {
    cbd:      { rect: { x0: -850, x1: 850,  z0: 380,  z1: 1180 },  name: '新赫兰德区 CBD' },
    culture:  { rect: { x0: 420,  x1: 1320, z0: -920, z1: 250 },  name: '绘空町 文创街区' },
    old:      { rect: { x0: -920, x1: 80,   z0: -1080, z1: -280 }, name: '桥间地 老城区' },
    seaside:  { rect: { x0: -1150, x1: 1220, z0: -1650, z1: -1080 }, name: '未闻浦 滨海区' },
    mix:      { rect: { x0: -1000, x1: 1220, z0: -280, z1: 380 },  name: '过渡商住区' },
  };
  C.cityBounds = { x0: -1350, x1: 1420, z0: -1700, z1: 1350 };

  // ---------- 高架/立交预留走廊（路网引擎专用，其它模块必须避让） ----------
  // kind: 'skyway' 高架快速路；'ramp' 上下匝道
  C.reserved = [
    { x0: -1280, x1: 1280, z0: 490, z1: 555, kind: 'skyway', h: 8.5 },
    { x0: -1310, x1: -1150, z0: 480, z1: 620, kind: 'ramp', h: 8.5 },
    { x0: 1150, x1: 1310, z0: 480, z1: 620, kind: 'ramp', h: 8.5 },
  ];
  C.inReserved = (x, z, pad = 2) => {
    for (const r of C.reserved) {
      if (x >= r.x0 - pad && x <= r.x1 + pad && z >= r.z0 - pad && z <= r.z1 + pad) return r;
    }
    return null;
  };

  C.zoneAt = (x, z) => {
    for (const id of ['cbd', 'culture', 'old', 'seaside', 'mix']) {
      const r = C.zoneDefs[id].rect;
      if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) return id;
    }
    return null;
  };

  // ---------- 分区美术参数（新海诚：通透、冷暖分区） ----------
  C.pal = {
    old: {
      floorLo: 2, floorHi: 6, floorH: 3.15,
      lotMin: 13, lotMax: 26, sidewalk: 2.6, density: 0.85,
      walls: [0xe7d6bd, 0xdcc5a4, 0xcfaa85, 0xc8b08f, 0xb98d6a, 0xd8c8ac],
      roofs: [0x8a4a3c, 0x9c6b4e, 0x6e4a38, 0xa97452],
      trim: [0xf2e8d6, 0xe0d0b8],
      glass: [0x9fb8c8, 0xb9cfd8, 0x8fa8b8],
      windowLight: 0xffd98a,
      accents: [0xb04a3e, 0xd0783c, 0x8a5a44],
      awning: [0xc94f42, 0xd9903f, 0x3f6b52],
    },
    mix: {
      floorLo: 6, floorHi: 12, floorH: 3.2,
      lotMin: 18, lotMax: 42, sidewalk: 4.0, density: 0.68,
      walls: [0xe8e4da, 0xd8dbe0, 0xcfd6dd, 0xddd3c4, 0xcbd2da],
      roofs: [0x5d6570, 0x6b7280, 0x7a6f62],
      trim: [0xf0eee8, 0xffffff],
      glass: [0x9fc0d8, 0x8fb4cc, 0xb9d4e4],
      windowLight: 0xffe0a0,
      accents: [0x4a6b8a, 0xb0593e, 0x5588a8],
      awning: [0x3e6b8a, 0xb0593e, 0x5a6b52],
    },
    cbd: {
      floorLo: 15, floorHi: 40, floorH: 4.0,
      lotMin: 34, lotMax: 78, sidewalk: 5.5, density: 0.5,
      walls: [0xdce4ec, 0xc8d4e0, 0xb9c8d6, 0xcfdae4, 0xaebfce],
      roofs: [0x59616c, 0x6b7380, 0x4f5864],
      trim: [0xeef2f6, 0xdfe7ee],
      glass: [0x9fc8e4, 0x87b4d4, 0xb0d4ea],
      windowLight: 0xffe2a8,
      accents: [0x3e6b8a, 0x7a8fa0, 0x4a5a70],
      awning: [0x3e5a70, 0x6b4a3e, 0x4a6b6b],
    },
    seaside: {
      floorLo: 2, floorHi: 8, floorH: 3.2,
      lotMin: 15, lotMax: 36, sidewalk: 4.0, density: 0.5,
      walls: [0xf2efe6, 0xe8f0f2, 0xf5e9d6, 0xeef4ee],
      roofs: [0xc66b4a, 0x4a7a86, 0xd9905a],
      trim: [0xffffff, 0xf5f0e4],
      glass: [0xbfdce4, 0xa8ccd8, 0xd0e8ec],
      windowLight: 0xffd9a0,
      accents: [0x3e8a86, 0xd0783c, 0x6b8a4a],
      awning: [0x3e8a86, 0xd0783c, 0xe8e0c8],
    },
    culture: {
      floorLo: 3, floorHi: 5, floorH: 3.2,
      lotMin: 11, lotMax: 20, sidewalk: 2.4, density: 0.88,
      walls: [0xd9c3a8, 0xc8b294, 0xb9a486, 0xcfb99a],
      roofs: [0x6e4a38, 0x8a5a44, 0x594438],
      trim: [0x594438, 0x4a382e],
      glass: [0xbfd0c8, 0xd8b98f, 0xa8bcb0],
      windowLight: 0xffcf8a,
      accents: [0xc94f42, 0xd9903f, 0x8a5a44],
      awning: [0xb04a3e, 0xd9903f, 0x3f6b52],
    },
  };

  // ---------- 通用工具 ----------
  C.lerpColor = (c1, c2, t) => {
    if (c1 === undefined || c2 === undefined) return c1 === undefined ? c2 : c1;
    const r = Math.round(((c1 >> 16) & 255) + (((c2 >> 16) & 255) - ((c1 >> 16) & 255)) * t);
    const g = Math.round(((c1 >> 8) & 255) + (((c2 >> 8) & 255) - ((c1 >> 8) & 255)) * t);
    const b = Math.round((c1 & 255) + ((c2 & 255) - (c1 & 255)) * t);
    return (r << 16) | (g << 8) | b;
  };
  C.mixHex = (c1, c2, t) => C.lerpColor(parseInt(c1, 16), parseInt(c2, 16), t);
  C.hex = n => '#' + ('00000' + (n >>> 0).toString(16)).slice(-6);
  C.hexStr = s => parseInt(s.replace('#', ''), 16);

  // 材质缓存：key -> material（避免重复创建海量材质）
  C.matCache = new Map();
  C.std = (key, make) => {
    if (!C.matCache.has(key)) C.matCache.set(key, make());
    return C.matCache.get(key);
  };

  // ---------- Canvas 贴图工厂 ----------
  C.makeCanvas = (w, h, draw, opts = {}) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    draw(g, w, h);
    const tex = new THREE.CanvasTexture(c);
    if (opts.srgb !== false && THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    if (opts.repeat) {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.repeat.set(opts.repeat[0], opts.repeat[1]);
    }
    if (opts.anisotropy) tex.anisotropy = 4;
    return tex;
  };

  // 手绘感噪点/笔触颗粒
  C.grain = (g, w, h, alpha = 0.05, n = 600) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = 'rgba(' + (rng() < 0.5 ? '255,255,255' : '0,0,0') + ',' + alpha + ')';
      g.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
    }
  };

  // 建筑立面贴图：平涂墙 + 窗格 + 分格线 + 手绘颗粒。
  // opts: {w,h,wall,trim,glass,glassLit,cols,rows,seed,lit(0..1),frameColor,seams}
  C.makeFacade = (opts) => {
    const W = opts.w || 256, H = opts.h || 512;
    const seed = opts.seed || 7;
    const cvs = C.makeCanvas(W, H, (g) => {
      g.fillStyle = opts.wall;
      g.fillRect(0, 0, W, H);
      const cols = opts.cols || 6, rows = opts.rows || 14;
      const litT = Math.min(0.8, (opts.lit || 0.3) + 0.12);
      const m = Math.round(W * 0.05), top = Math.round(H * 0.03);
      const bw = (W - m * 2) / cols, bh = (H - top - m) / rows;
      const frame = opts.frameColor || 'rgba(30,34,42,0.95)';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = m + c * bw, y = top + r * bh;
          const lit = ((Math.sin((c + 7.3) * 12.9898 + (r + 3.1) * 78.233 + seed) * 43758.5453) % 1 + 1) % 1 < litT;
          g.fillStyle = lit ? opts.glassLit : opts.glass;
          g.fillRect(x + 1, y + 1, bw - 2, bh - 2);
          g.fillStyle = frame;
          g.fillRect(x, y, bw, 2);
          g.fillRect(x, y + bh - 2, bw, 2);
          g.fillRect(x, y, 2, bh);
          g.fillRect(x + bw - 2, y, 2, bh);
          // 窗帘/反光细节
          if (lit && ((c * 7 + r * 13 + seed) % 5) === 0) {
            g.fillStyle = 'rgba(255,255,255,0.18)';
            g.fillRect(x + bw * 0.15, y + bh * 0.2, bw * 0.7, bh * 0.18);
          }
        }
      }
      // 横向楼层分格线
      g.fillStyle = opts.seam || 'rgba(255,255,255,0.14)';
      for (let r = 1; r < rows; r++) {
        const y = top + r * bh;
        g.fillRect(0, y - 1, W, 2);
      }
      // 底部裙楼线
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(0, H - Math.round(H * 0.05), W, Math.round(H * 0.05));
      // 立面底部 AO 渐变：最底部 12% 高度叠加深灰蓝渐变，模拟街面反光阴影
      const ao = g.createLinearGradient(0, H * 0.88, 0, H);
      ao.addColorStop(0, 'rgba(20,22,28,0)');
      ao.addColorStop(1, 'rgba(20,22,28,0.28)');
      g.fillStyle = ao;
      g.fillRect(0, H * 0.88, W, H * 0.12);
      C.grain(g, W, H, 0.04, 400);
    }, { srgb: true });
    const emi = C.makeCanvas(W, H, (g) => {
      g.fillStyle = '#000000'; g.fillRect(0, 0, W, H);
      const cols = opts.cols || 6, rows = opts.rows || 14;
      const litT2 = Math.min(0.8, (opts.lit || 0.3) + 0.12);
      const m = Math.round(W * 0.05), top = Math.round(H * 0.03);
      const bw = (W - m * 2) / cols, bh = (H - top - m) / rows;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const lit = ((Math.sin((c + 7.3) * 12.9898 + (r + 3.1) * 78.233 + seed) * 43758.5453) % 1 + 1) % 1 < litT2;
          if (lit) {
            g.fillStyle = '#ffffff';
            g.fillRect(m + c * bw + 1, top + r * bh + 1, bw - 2, bh - 2);
          }
        }
      }
    }, { srgb: false });
    // 关键：建筑立面 UV 会按“每 4m×4m 一个贴图单元”放大到 >1，
    // 必须 RepeatWrapping，否则墙面只会显示贴图边缘的纯墙色（窗户全部消失）。
    cvs.wrapS = cvs.wrapT = THREE.RepeatWrapping;
    emi.wrapS = emi.wrapT = THREE.RepeatWrapping;
    return { map: cvs, emissiveMap: emi };
  };

  // 店铺底层贴图：落地玻璃门 + 遮阳棚 + 招牌带
  C.makeShopFront = (opts) => {
    const W = opts.w || 256, H = opts.h || 256;
    return C.makeCanvas(W, H, (g) => {
      g.fillStyle = opts.wall; g.fillRect(0, 0, W, H);
      // 玻璃门
      const gh = H * 0.52, gy = H - gh;
      g.fillStyle = opts.glass || '#9fc8e4';
      g.fillRect(0, gy, W, gh);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(W * 0.08, gy + gh * 0.08, W * 0.08, gh * 0.84);
      g.fillRect(W * 0.5, gy + gh * 0.08, W * 0.08, gh * 0.84);
      // 门框
      g.fillStyle = opts.frame || '#3a3e46';
      g.fillRect(0, gy, W, 3);
      g.fillRect(W * 0.47, gy, W * 0.06, gh);
      // 遮阳棚
      const ay = H * 0.3, ah = H * 0.18;
      g.fillStyle = opts.awning || '#c94f42';
      g.fillRect(0, ay, W, ah);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = i % 2 ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.08)';
        g.fillRect(i * W / 6, ay, W / 6, ah);
      }
      // 招牌带
      g.fillStyle = opts.signBg || '#2b2f38';
      g.fillRect(W * 0.04, H * 0.04, W * 0.92, H * 0.22);
      g.fillStyle = opts.signText || '#ffd98a';
      g.font = 'bold ' + Math.round(H * 0.16) + 'px "Microsoft YaHei",sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(opts.text || '商店', W / 2, H * 0.15);
      C.grain(g, W, H, 0.04, 250);
    }, { srgb: true });
  };

  // 广告/指路牌文字贴图
  C.makeSign = (text, opts = {}) => {
    const W = opts.w || 256, H = opts.h || 96;
    return C.makeCanvas(W, H, (g) => {
      g.fillStyle = opts.bg || '#f4f4f0';
      g.fillRect(0, 0, W, H);
      g.strokeStyle = opts.border || '#2b2f38';
      g.lineWidth = 4;
      g.strokeRect(2, 2, W - 4, H - 4);
      g.fillStyle = opts.fg || '#22262e';
      g.font = 'bold ' + Math.round(H * 0.5) + 'px "Microsoft YaHei",sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(text, W / 2, H / 2);
    }, { srgb: true });
  };

  // ---------- 地块规划 ----------
  // 以道路为骨架，在分区矩形内铺格点地块，避开道路与已有地块。
  // 每个地块朝向最近道路的切线（建筑立面平行道路）。
  C.computeLots = (world) => {
    C.lots = [];
    const defs = C.zoneDefs;
    const rngLocal = C.rng;
    const hash = [];
    const cell = 40;
    const key = (x, z) => (Math.floor((x - C.cityBounds.x0) / cell) * 1000 + Math.floor((z - C.cityBounds.z0) / cell));
    const overlaps = (x, z, r) => {
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
        const arr = hash[key(x + i * cell, z + j * cell)];
        if (!arr) continue;
        for (const l of arr) {
          if (Math.hypot(l.x - x, l.z - z) < r + Math.max(l.w, l.d) * 0.55) return true;
        }
      }
      return false;
    };
    for (const zoneId of ['old', 'culture', 'cbd', 'seaside', 'mix']) {
      const r = defs[zoneId].rect;
      const P = C.pal[zoneId];
      const step = P.lotMin * 0.75 + (P.lotMax - P.lotMin) * 0.3;
      for (let x = r.x0 + step / 2; x < r.x1; x += step) {
        for (let z = r.z0 + step / 2; z < r.z1; z += step) {
          const jx = (rngLocal() - 0.5) * step * 0.7;
          const jz = (rngLocal() - 0.5) * step * 0.7;
          const px = x + jx, pz = z + jz;
          if (C.inReserved(px, pz, 6)) continue;
          const nr = world.nearestRoad ? world.nearestRoad(px, pz) : null;
          if (!nr) continue;
          const w = P.lotMin + rngLocal() * (P.lotMax - P.lotMin);
          const d = P.lotMin * 0.8 + rngLocal() * (P.lotMax * 0.8 - P.lotMin * 0.8);
          // 地块中心到路沿的净距必须盖得住地块半宽 + 人行道 + 安全边距
          const clear = nr.d - nr.s.w / 2 - P.sidewalk - 0.8 - Math.max(w, d) * 0.5;
          if (clear < 0) continue;
          const rSize = Math.max(w, d) * 0.62;
          if (overlaps(px, pz, rSize)) continue;
          // 朝向：立面平行最近道路切线（从 trafficRoutes 按引用找当前采样）
          let next = null;
          if (world.trafficRoutes && nr.s) {
            const route = world.trafficRoutes.find(r => r.id === nr.s.road);
            if (route) {
              const si = route.samples.indexOf(nr.s);
              if (si >= 0) next = route.samples[Math.min(si + 3, route.samples.length - 1)];
            }
          }
          const yaw = next ? Math.atan2(next.x - nr.s.x, next.z - nr.s.z) : (rngLocal() * Math.PI - Math.PI / 2);
          const lot = { x: px, z: pz, w, d, yaw, zone: zoneId, idx: C.lots.length, keep: rngLocal() < P.density };
          C.lots.push(lot);
          let h = hash[key(px, pz)];
          if (!h) { h = []; hash[key(px, pz)] = h; }
          h.push(lot);
        }
      }
    }
    // 密度筛除后编号重排
    const kept = C.lots.filter(l => l.keep);
    kept.forEach((l, i) => l.idx = i);
    C.lots = kept;
    C.stats.lotCount = C.lots.length;
    return C.lots;
  };

  C.pointInLot = (x, z, pad = 0.8) => {
    for (const l of C.lots) {
      if (!l.built) continue;
      const c = Math.cos(l.yaw), s = Math.sin(l.yaw);
      const dx = x - l.x, dz = z - l.z;
      const lx = dx * c - dz * s;      // 沿宽度（垂直道路）
      const lz = dx * s + dz * c;      // 沿深度（平行道路）
      if (Math.abs(lx) < l.w / 2 + pad && Math.abs(lz) < l.d / 2 + pad) return l;
    }
    return null;
  };

  // 是否适合放置街头道具：不在路面上、不在建筑地块里、不在高架预留走廊里、在城市范围内
  C.propSpot = (world, x, z, r) => {
    const nr = world.nearestRoad ? world.nearestRoad(x, z) : null;
    if (!nr || nr.d < nr.s.w / 2 + 0.9 + r) return false;
    if (C.pointInLot(x, z, r + 0.6)) return false;
    if (C.inReserved(x, z, r + 1.5)) return false;
    if (x < C.cityBounds.x0 || x > C.cityBounds.x1 || z < C.cityBounds.z0 || z > C.cityBounds.z1) return false;
    return true;
  };

  // 沿道路侧边的人行道带（供路灯/栏杆/行道树使用）
  C.roadEdges = (world, roadId, sideOffset) => {
    const out = [];
    const route = world.trafficRoutes ? world.trafficRoutes.find(r => r.id === roadId) : null;
    if (!route) return out;
    const off = sideOffset || 0;
    for (let i = 0; i < route.samples.length; i += 2) {
      const a = route.samples[i];
      const b = route.samples[Math.min(i + 2, route.samples.length - 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      out.push({
        x: a.x + nx * (a.w / 2 + off), z: a.z + nz * (a.w / 2 + off),
        nx, nz, road: roadId, s: a,
      });
    }
    return out;
  };

  // ---------- 几何合并（同材质合并为一个 draw call） ----------
  C.mergeByMaterial = (meshes, parent = null) => {
    const byMat = new Map();
    for (const m of meshes) {
      if (!m || !m.geometry) continue;
      const key = m.material.uuid;
      if (!byMat.has(key)) byMat.set(key, { mat: m.material, geos: [] });
      m.updateMatrix();
      byMat.get(key).geos.push(m.geometry.clone().applyMatrix4(m.matrix));
    }
    const out = [];
    for (const { mat, geos } of byMat.values()) {
      const attrNames = ['position', 'normal', 'uv'];
      const totalV = geos.reduce((s, g) => s + (g.attributes.position ? g.attributes.position.count : 0), 0);
      const totalI = geos.reduce((s, g) => s + (g.index ? g.index.count : 0), 0);
      const merged = new THREE.BufferGeometry();
      for (const name of attrNames) {
        const arr = new Float32Array(totalV * (name === 'position' || name === 'normal' ? 3 : 2));
        let off = 0;
        for (const g of geos) {
          const a = g.attributes[name];
          if (a) arr.set(a.array, off);
          off += a ? a.count * a.itemSize : 0;
        }
        merged.setAttribute(name, new THREE.BufferAttribute(arr, name === 'uv' ? 2 : 3));
      }
      if (totalI) {
        const idx = new Uint32Array(totalI);
        let vOff = 0, iOff = 0;
        for (const g of geos) {
          const ig = g.index;
          for (let i = 0; i < ig.count; i++) idx[iOff++] = ig.getX(i) + vOff;
          vOff += g.attributes.position.count;
        }
        merged.setIndex(new THREE.BufferAttribute(idx, 1));
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      if (parent) parent.add(mesh);
      out.push(mesh);
      for (const g of geos) g.dispose();
    }
    return out;
  };

  // ---------- 夜间/动态钩子 ----------
  // 建筑窗户等发光材质注册进来，updateNight 统一调整发光强度。
  C.registerNight = (mat, makeUpdater) => {
    if (!mat) return;
    if (!C.nightMats.includes(mat)) C.nightMats.push(mat);
    if (makeUpdater) C.updateFns.push(makeUpdater);
  };
  C.registerUpdate = fn => { C.updateFns.push(fn); };

  C.updateNight = (world) => {
    const h = world.hour != null ? world.hour : 12;
    // 夜晚 = 18 点后 2 小时渐入 / 清晨 7 点前 2 小时渐出（全天平滑）
    let night = 0;
    if (h >= 18) night = Math.min(1, (h - 18) / 2);
    else if (h <= 7) night = Math.min(1, (7 - h) / 2);
    for (const m of C.nightMats) {
      if (m.emissiveIntensity !== undefined) {
        // 支持独立夜间提亮曲线（例如树冠：白天不发光，夜间微光防死黑）
        const lift = m.userData && m.userData.cityNightLift;
        if (lift != null) m.emissiveIntensity = night * lift;
        else m.emissiveIntensity = 0.08 + night * 2.4;
      }
    }
    for (const fn of C.updateFns) {
      try { fn(world, night); } catch (e) { /* 动态钩子失败不影响主流程 */ }
    }
    return night;
  };

  // 碰撞注册（与 world.colliders 同一轻量机制）
  C.addCollider = (world, x, z, r, type = 'city') => {
    world.colliders.push({ x, z, r, type });
    C.colliders.push({ x, z, r, type });
  };

  // ---------- 构建总管线 ----------
  // only: 可选阶段名数组，只运行这些阶段（city3 等特殊地图用）
  C.buildStages = (world, only) => {
    if (!world.cityRoot) {
      const g = new THREE.Group();
      g.name = 'cityRoot';
      world.scene.add(g);
      world.cityRoot = g;
    }
    const stats = { stages: {} };
    for (const stage of C.stages) {
      if (only && only.indexOf(stage.name) === -1) continue;
      const t0 = performance.now();
      try {
        const s = stage.fn(world) || {};
        stats.stages[stage.name] = s;
      } catch (e) {
        console.error('[CITY stage fail]', stage.name, e);
        window.__worldError = window.__worldError || ('city.' + stage.name + ' :: ' + (e && e.message));
        throw e;
      }
      const dt = performance.now() - t0;
      stats.stages[stage.name] = stats.stages[stage.name] || {};
      stats.stages[stage.name].ms = Math.round(dt);
    }
    C.stats = stats;
    return stats;
  };
  C.buildAll = (world) => C.buildStages(world, null);

  window.CITY = C;
})();
