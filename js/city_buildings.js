// ============================================================
//  CITY BUILDINGS — 海特洛市（新海诚风二次元都市）建筑生成模块
//  ------------------------------------------------------------
//  只通过 window.CITY 注册阶段/暴露数据。
//  全部逻辑包在 IIFE 内，不向全局词法作用域声明任何 const/let/function。
//  两个阶段：
//    cityPlan      调用 CITY.computeLots、过滤地标/高架走廊、预计算楼高/立面变体
//    cityBuildings 按地块生成建筑、屋顶细节、店铺门面、地标并合并网格
//
//  立面贴图方案（本文件内自带 HQ 绘制器，不依赖 CITY.makeFacade 的内部样式）：
//    - 每个 facade 贴图覆盖 6m×4m 一个立面单元，scaleSideUV(geo, bw/6, bh/4)
//    - cbd/mix：512×1024；old/culture/seaside：512×512
//    - 窗格 3-4 列 × 2-3 行；窗宽约 1.0-1.6m、窗高约 0.95-1.6m
//    - 每扇窗：深灰外框 2px + 玻璃竖渐变 + 白色斜反光 + 窗台投影线
// ============================================================
(() => {
  'use strict';

  const CITY = window.CITY;
  CITY.landmarks = CITY.landmarks || {};
  const FACADE_VARIANTS = 8;
  const ZONES = ['old', 'culture', 'cbd', 'seaside', 'mix'];
  const ZONE_INDEX = { old: 0, culture: 1, cbd: 2, seaside: 3, mix: 4 };

  // 单次使用的几何体：合并完成后统一 dispose
  const geosScratch = [];

  // 14 个中文店招名字池（原 8 个池扩到 14 个）
  const SHOP_NAME_POOL = [
    '七海海鲜', '海特罗咖啡', '绘空町书店', '迈达斯便利店', '桥间地杂货',
    '老城面包房', '海风照相馆', '中央药局', '未闻浦冰室', '海风便利店',
    '滨海租车', '海盐冰淇淋', '猫町画廊', '新赫兰德银行'
  ];
  const SHOP_TEXT = {
    old: ['七海海鲜', '桥间地杂货', '老城面包房', '海风照相馆', '海特罗咖啡'],
    culture: ['绘空町书店', '猫町画廊', '文创杂货铺', '海特罗咖啡', '绘空町书店'],
    cbd: ['新赫兰德银行', '迈达斯便利店', '海特罗咖啡', '中央药局', '新赫兰德银行'],
    seaside: ['未闻浦冰室', '海风便利店', '滨海租车', '海盐冰淇淋', '未闻浦冰室'],
    mix: ['迈达斯便利店', '海特罗咖啡', '七海海鲜', '中央药局', '桥间地杂货']
  };
  function shopTextFor(zone, i) {
    const arr = SHOP_TEXT[zone] || SHOP_NAME_POOL;
    return arr[((i || 0) % arr.length + arr.length) % arr.length];
  }

  // ---------- 小工具 ----------
  function hexColor(n) {
    return '#' + ('00000' + (n >>> 0).toString(16)).slice(-6);
  }

  function floorInt(lo, hi) {
    return Math.floor(CITY.rand(lo, hi + 0.999));
  }

  function localToWorld(lot, lx, ly, lz) {
    const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw);
    return {
      x: lot.x + lx * c + lz * s,
      y: (lot.baseY || 0) + ly,
      z: lot.z - lx * s + lz * c
    };
  }

  function placePart(mesh, lot, lx, ly, lz, localYaw) {
    const p = localToWorld(lot, lx, ly, lz);
    mesh.position.set(p.x, p.y, p.z);
    mesh.rotation.order = 'YXZ';
    mesh.rotation.y = lot.yaw + (localYaw || 0);
    return mesh;
  }

  // 墙面 UV 按 6m×4m 一个单元平铺，并叠加每个 lot 的确定性偏移。
  // BoxGeometry 6 个面都处理：顶面/底面随后会被屋顶与地面盖住，缩放不影响视觉。
  function scaleSideUV(geo, su, sv, uOff, vOff) {
    const uv = geo.attributes.uv;
    if (!uv) return geo;
    const arr = uv.array;
    const uo = uOff || 0, vo = vOff || 0;
    for (let f = 0; f < 6; f++) {
      for (let i = 0; i < 4; i++) {
        const vi = f * 4 + i;
        arr[vi * 2] = arr[vi * 2] * su + uo;
        arr[vi * 2 + 1] = arr[vi * 2 + 1] * sv + vo;
      }
    }
    uv.needsUpdate = true;
    return geo;
  }

  function uvOffsets(lot) {
    const idx = lot && lot.idx != null ? Math.abs(lot.idx) : 0;
    return { u: (idx % 7) * 0.13, v: (idx % 5) * 0.17 };
  }

  // ---------- 确定性 hash / 手绘颗粒（不消耗 CITY.rng） ----------
  function fractSin(s) {
    const x = Math.sin(s) * 43758.5453;
    return x - Math.floor(x);
  }
  function hash2(a, b, seed) {
    return fractSin(a * 127.1 + b * 311.7 + seed * 74.7 + 13.7);
  }
  function grain(g, w, h, seed, alpha, n) {
    for (let i = 0; i < n; i++) {
      const x = hash2(i, 1, seed) * w;
      const y = hash2(i, 2, seed) * h;
      const v = hash2(i, 3, seed);
      g.fillStyle = v < 0.5 ? 'rgba(255,255,255,' + alpha + ')' : 'rgba(0,0,0,' + alpha + ')';
      g.fillRect(x, y, 1 + v * 2, 1 + v * 2);
    }
  }
  function shadeColor(hex, t) {
    let r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
    if (t >= 0) {
      r = Math.round(r + (255 - r) * t);
      g = Math.round(g + (255 - g) * t);
      b = Math.round(b + (255 - b) * t);
    } else {
      const k = 1 + t;
      r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k);
    }
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  // ---------- 接地阴影 / AO 贴图（本文件内部实现，不依赖其它城市模块） ----------
  function softShadowTexture(size) {
    size = size || 128;
    return CITY.makeCanvas(size, size, function (g, w, h) {
      const r = w / 2;
      const grad = g.createRadialGradient(r, r, 0, r, r, r);
      grad.addColorStop(0, 'rgba(20,22,28,0.62)');
      grad.addColorStop(0.6, 'rgba(20,22,28,0.30)');
      grad.addColorStop(1, 'rgba(20,22,28,0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
    }, { srgb: false });
  }

  let buildingAOMat = null;
  function buildingAOMaterial() {
    if (buildingAOMat) return buildingAOMat;
    buildingAOMat = new THREE.MeshBasicMaterial({
      map: softShadowTexture(128),
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    return buildingAOMat;
  }

  let buildingAOCount = 0;

  // 把建筑 footprint 边界映射到 AO 贴图中心（最深），椭圆外沿映射到贴图边缘（透明），
  // 这样楼根处能看到一圈清晰的接地阴影，而不是只有贴图边缘的淡出部分。
  function setBuildingAOUV(geo, bw, bd, major, minor) {
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;
    const hx = (bw / major) * 0.5;  // footprint 半宽归一化到 PlaneGeometry(1,1) 的坐标范围
    const hz = (bd / minor) * 0.5;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const fx = Math.abs(px), fy = Math.abs(py);
      let dx = 0, dy = 0;
      if (fx > hx && 0.5 - hx > 1e-6) dx = (fx - hx) / (0.5 - hx);
      if (fy > hz && 0.5 - hz > 1e-6) dy = (fy - hz) / (0.5 - hz);
      // 让楼根附近更长时间停留在贴图中心（最深），AO 更明显
      const t = Math.pow(Math.min(1, Math.hypot(dx, dy)), 1.7);
      const rr = Math.hypot(px, py) || 1;
      uv.setXY(i, 0.5 + 0.5 * (px / rr) * t, 0.5 + 0.5 * (py / rr) * t);
    }
    uv.needsUpdate = true;
  }

  function addBuildingAO(lot, meshes, world) {
    const base = Math.max(lot.bw, lot.bd);
    const factor = lot.zone === 'cbd' ? 1.45 : 1.25;
    const major = base * factor;
    const minor = major * 0.8;  // 椭圆短轴 = 长轴 × 0.8，确保沿深度方向也能露出 AO 边缘
    const baseY = (lot.baseY !== undefined && lot.baseY !== null) ? lot.baseY : world.terrainHeight(lot.x, lot.z);
    // 混凝土地基板：让建筑“长”在地上，而不是直接插进草地
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(lot.bw + 0.7, 0.28, lot.bd + 0.7),
      slabMaterial()
    );
    placePart(slab, lot, 0, 0.14, 0, 0);
    slab.receiveShadow = true;
    meshes.push(slab);
    const geo = new THREE.PlaneGeometry(1, 1);
    setBuildingAOUV(geo, lot.bw, lot.bd, major, minor);
    geo.rotateX(-Math.PI / 2);
    geosScratch.push(geo);
    const m = new THREE.Mesh(geo, buildingAOMaterial());
    m.position.set(lot.x, baseY + 0.03, lot.z);
    m.rotation.y = lot.yaw || 0;
    m.scale.set(major, 1, minor);
    meshes.push(m);
    buildingAOCount++;
  }

  // ---------- 每分区 8 个立面变体样式表 ----------
  // 单元：6m 宽 × 4m 高。winW/winH/stripH 单位：米。
  // 前 5 个为既有样式，后 3 个为新增多样性样式（双联窗/阳台横条/玻璃幕墙/圆角窗/错位窗）。
  // wall/glass 按 (styleIdx % paletteLength) 循环取值，保证相邻 lot（variant 相差 5）
  // 的墙色一定不同，从贴图层面消除“整排同一堵墙”的重复感。
  const FACADE_STYLES = (function () {
    const P = CITY.pal;
    function S(type, cols, rows, winW, winH, lit, wall, glass, extra) {
      const s = { type: type, cols: cols, rows: rows, winW: winW, winH: winH, lit: lit, wall: wall, glass: glass, frame: '#2b3038' };
      if (extra) {
        s.woodGrid = !!extra.woodGrid;
        s.arch = !!extra.arch;
        s.stripH = extra.stripH || 0.9;
        s.glassMull = extra.glassMull || 1.2;
      }
      return s;
    }
    const W = (zone, i) => P[zone].walls[i % P[zone].walls.length];
    const G = (zone, i) => P[zone].glass[i % P[zone].glass.length];
    return {
      old: [
        S('std', 3, 2, 1.60, 1.35, 0.38, W('old', 0), G('old', 0)),
        S('wood', 4, 2, 1.15, 1.25, 0.42, W('old', 1), G('old', 1), { woodGrid: true }),
        S('arch', 3, 2, 1.45, 1.35, 0.35, W('old', 2), G('old', 2), { arch: true }),
        S('std', 4, 3, 1.05, 1.00, 0.40, W('old', 3), G('old', 1)),
        S('std', 3, 2, 1.60, 1.40, 0.30, W('old', 4), G('old', 2)),
        S('double', 3, 2, 1.55, 1.30, 0.40, W('old', 5), G('old', 0)),
        S('round', 3, 2, 1.35, 1.20, 0.36, W('old', 0), G('old', 1)),
        S('offset', 4, 2, 1.10, 1.25, 0.38, W('old', 1), G('old', 2))
      ],
      culture: [
        S('wood', 3, 2, 1.35, 1.25, 0.45, W('culture', 0), G('culture', 0), { woodGrid: true }),
        S('arch', 3, 2, 1.45, 1.35, 0.42, W('culture', 1), G('culture', 1), { arch: true }),
        S('wood', 4, 2, 1.10, 1.20, 0.40, W('culture', 2), G('culture', 2), { woodGrid: true }),
        S('std', 3, 2, 1.60, 1.35, 0.35, W('culture', 3), G('culture', 0)),
        S('std', 4, 2, 1.15, 1.25, 0.38, W('culture', 0), G('culture', 1)),
        S('double', 3, 2, 1.50, 1.30, 0.42, W('culture', 1), G('culture', 0)),
        S('round', 3, 2, 1.35, 1.20, 0.40, W('culture', 2), G('culture', 1)),
        S('offset', 4, 2, 1.05, 1.20, 0.38, W('culture', 3), G('culture', 2))
      ],
      mix: [
        S('std', 3, 2, 1.60, 1.35, 0.40, W('mix', 0), G('mix', 0)),
        S('strip', 2, 2, 0, 0, 0.45, W('mix', 1), G('mix', 1), { stripH: 1.05 }),
        S('narrow', 4, 2, 0.95, 1.55, 0.40, W('mix', 2), G('mix', 0)),
        S('std', 4, 2, 1.25, 1.30, 0.36, W('mix', 3), G('mix', 2)),
        S('strip', 3, 3, 0, 0, 0.42, W('mix', 4), G('mix', 1), { stripH: 0.78 }),
        S('double', 3, 2, 1.55, 1.35, 0.40, W('mix', 1), G('mix', 0)),
        S('glass', 4, 3, 0, 0, 0.38, W('mix', 2), G('mix', 1), { glassMull: 1.5 }),
        S('offset', 4, 2, 1.05, 1.30, 0.36, W('mix', 3), G('mix', 2))
      ],
      cbd: [
        S('std', 3, 2, 1.60, 1.40, 0.45, W('cbd', 0), G('cbd', 0)),
        S('strip', 2, 2, 0, 0, 0.50, W('cbd', 1), G('cbd', 1), { stripH: 1.10 }),
        S('narrow', 4, 2, 0.95, 1.65, 0.45, W('cbd', 2), G('cbd', 0)),
        S('strip', 3, 3, 0, 0, 0.42, W('cbd', 3), G('cbd', 2), { stripH: 0.72 }),
        S('std', 4, 2, 1.25, 1.30, 0.40, W('cbd', 4), G('cbd', 1)),
        S('glass', 4, 3, 0, 0, 0.46, W('cbd', 1), G('cbd', 0), { glassMull: 1.5 }),
        S('glass', 5, 4, 0, 0, 0.42, W('cbd', 2), G('cbd', 1), { glassMull: 1.2 }),
        S('round', 3, 2, 1.45, 1.35, 0.40, W('cbd', 3), G('cbd', 2))
      ],
      seaside: [
        S('std', 3, 2, 1.60, 1.35, 0.30, W('seaside', 0), G('seaside', 0)),
        S('narrow', 3, 2, 1.15, 1.45, 0.28, W('seaside', 1), G('seaside', 1)),
        S('arch', 3, 2, 1.45, 1.30, 0.32, W('seaside', 2), G('seaside', 2), { arch: true }),
        S('std', 4, 2, 1.15, 1.25, 0.26, W('seaside', 3), G('seaside', 0)),
        S('wood', 3, 2, 1.35, 1.25, 0.30, W('seaside', 0), G('seaside', 1), { woodGrid: true }),
        S('double', 3, 2, 1.50, 1.30, 0.28, W('seaside', 1), G('seaside', 0)),
        S('round', 3, 2, 1.35, 1.20, 0.26, W('seaside', 2), G('seaside', 1)),
        S('offset', 4, 2, 1.05, 1.20, 0.28, W('seaside', 3), G('seaside', 2))
      ]
    };
  })();

  function styleFor(zone, variant) {
    const arr = FACADE_STYLES[zone] || FACADE_STYLES.mix;
    return arr[Math.abs(variant || 0) % arr.length];
  }
  function facadeSeed(zone, variant) {
    return (variant || 0) * 17 + zone.length * 131 + 7;
  }

  // ---------- HQ 立面绘制 ----------
  function forEachFacadeWindow(style, seed, cb) {
    const sideM = 0.25, topM = 0.25, bottomM = 0.25;
    const availW = 6 - sideM * 2;
    const availH = 4 - topM - bottomM;
    const type = style.type || 'std';
    if (type === 'strip' || type === 'balcony') {
      const rows = style.rows || 2;
      const cellH = availH / rows;
      const h = style.stripH || 0.9;
      for (let r = 0; r < rows; r++) {
        const y = topM + r * cellH + (cellH - h) / 2;
        const lit = hash2(r, 0, seed) < (style.lit || 0.4);
        cb(r, 0, sideM, y, availW, h, lit);
      }
      return;
    }
    const cols = style.cols || 3;
    const rows = style.rows || 2;
    const cellW = availW / cols;
    const cellH = availH / rows;
    if (type === 'glass') {
      // 玻璃幕墙：几乎占满单元的大分格，只留极细竖挺，突出反射渐变
      const w = cellW - 0.08;
      const h = cellH - 0.08;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = sideM + c * cellW + (cellW - w) / 2;
          const y = topM + r * cellH + (cellH - h) / 2;
          const lit = hash2(c, r, seed) < (style.lit || 0.4);
          cb(c, r, x, y, w, h, lit);
        }
      }
      return;
    }
    const w = Math.min(style.winW || 1.2, cellW - 0.22);
    const h = Math.min(style.winH || 1.2, cellH - 0.22);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let x = sideM + c * cellW + (cellW - w) / 2;
        if (type === 'offset') {
          // 错位窗：奇数行向右、偶数行向左错开半窗，打破棋盘重复
          x += (r % 2 ? cellW * 0.18 : -cellW * 0.18);
        }
        const y = topM + r * cellH + (cellH - h) / 2;
        const lit = hash2(c, r, seed) < (style.lit || 0.4);
        cb(c, r, x, y, w, h, lit);
      }
    }
  }

  function roundedTopRectPath(g, X, Y, W, H, r) {
    const rr = Math.min(r, W / 2);
    g.beginPath();
    g.moveTo(X, Y + H);
    g.lineTo(X, Y + rr);
    g.arcTo(X, Y, X + rr, Y, rr);
    g.lineTo(X + W - rr, Y);
    g.arcTo(X + W, Y, X + W, Y + rr, rr);
    g.lineTo(X + W, Y + H);
    g.closePath();
  }

  function roundedRectPath(g, X, Y, W, H, r) {
    const rr = Math.min(r, W / 2, H / 2);
    g.beginPath();
    g.moveTo(X + rr, Y);
    g.lineTo(X + W - rr, Y);
    g.arcTo(X + W, Y, X + W, Y + rr, rr);
    g.lineTo(X + W, Y + H - rr);
    g.arcTo(X + W, Y + H, X + W - rr, Y + H, rr);
    g.lineTo(X + rr, Y + H);
    g.arcTo(X, Y + H, X, Y + H - rr, rr);
    g.lineTo(X, Y + rr);
    g.arcTo(X, Y, X + rr, Y, rr);
    g.closePath();
  }

  function drawWindowMap(g, style, seed, c, r, x, y, ww, hh, lit, pxX, pxY) {
    const X = x * pxX, Y = y * pxY, W = ww * pxX, H = hh * pxY;
    const frame = style.frame || '#2b3038';
    // 深色玻璃：即使远景被 mipmap 压缩，也能读出清晰的深色窗洞
    const glassTop = shadeColor(style.glass, -0.25);
    const glassBot = shadeColor(style.glass, -0.80);
    const type = style.type || 'std';
    // 物理尺度换算成像素，保证远近看都有窗框厚度
    const fx = Math.max(2, 0.05 * pxX);
    const fy = Math.max(2, 0.05 * pxY);
    const sillH = Math.max(2, 0.05 * pxY);
    const sillW = Math.max(4, 0.14 * pxX);

    const fillGlassGrad = (gx, gy, gw, gh) => {
      const grad = g.createLinearGradient(0, gy, 0, gy + gh);
      grad.addColorStop(0, glassTop);
      grad.addColorStop(1, glassBot);
      g.fillStyle = grad;
      g.fillRect(Math.round(gx), Math.round(gy), Math.round(gw), Math.round(gh));
      // 玻璃顶部天空反光
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.fillRect(Math.round(gx), Math.round(gy), Math.round(gw), Math.max(2, Math.round(gh * 0.20)));
    };
    const drawSill = () => {
      // 窗台上方 2px 高光（玻璃底部受光边）
      const hiH = Math.max(1, Math.round(0.02 * pxY));
      g.fillStyle = 'rgba(255,255,255,0.30)';
      g.fillRect(Math.round(X), Math.round(Y + H - hiH), Math.round(W), hiH);
      // 窗台投影线
      g.fillStyle = 'rgba(20,22,26,0.6)';
      g.fillRect(Math.round(X - sillW / 2), Math.round(Y + H), Math.round(W + sillW), sillH);
    };
    const drawWarm = (gx, gy, gw, gh, alpha) => {
      if (!lit) return;
      g.fillStyle = 'rgba(255,207,122,' + (alpha || 0.32) + ')';
      g.fillRect(Math.round(gx), Math.round(gy), Math.round(gw), Math.round(gh));
    };
    const drawSheen = (gx, gy, gw, gh) => {
      // 主斜向反光带（较宽，明显）
      g.fillStyle = 'rgba(255,255,255,0.26)';
      g.beginPath();
      g.moveTo(gx + gw * 0.16, gy); g.lineTo(gx + gw * 0.44, gy);
      g.lineTo(gx + gw * 0.12, gy + gh); g.lineTo(gx + gw * 0.01, gy + gh);
      g.closePath();
      g.fill();
      // 副反光带（右上角细条）
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      g.moveTo(gx + gw * 0.68, gy); g.lineTo(gx + gw * 0.82, gy);
      g.lineTo(gx + gw * 0.62, gy + gh); g.lineTo(gx + gw * 0.52, gy + gh);
      g.closePath();
      g.fill();
    };
    // CBD strip / 玻璃幕墙额外叠加淡蓝色水平渐变，模拟天空反射
    const drawBlueSheen = (gx, gy, gw, gh) => {
      const hg = g.createLinearGradient(gx, 0, gx + gw, 0);
      hg.addColorStop(0, 'rgba(170,210,235,0.28)');
      hg.addColorStop(0.45, 'rgba(170,210,235,0.06)');
      hg.addColorStop(1, 'rgba(170,210,235,0.30)');
      g.fillStyle = hg;
      g.fillRect(Math.round(gx), Math.round(gy), Math.round(gw), Math.round(gh));
    };

    if (type === 'arch') {
      const rad = Math.min(0.55, ww / 2) * pxX;
      roundedTopRectPath(g, X, Y, W, H, rad);
      const grad = g.createLinearGradient(0, Y, 0, Y + H);
      grad.addColorStop(0, glassTop);
      grad.addColorStop(1, glassBot);
      g.fillStyle = grad;
      g.fill();
      drawWarm(X, Y, W, H);
      g.strokeStyle = frame;
      g.lineWidth = Math.max(2, 0.045 * pxY);
      g.stroke();
      drawSill();
      return;
    }

    if (type === 'round') {
      roundedRectPath(g, X, Y, W, H, Math.min(0.5, ww / 2, hh / 2) * pxX);
      const grad = g.createLinearGradient(0, Y, 0, Y + H);
      grad.addColorStop(0, glassTop);
      grad.addColorStop(1, glassBot);
      g.fillStyle = grad;
      g.fill();
      drawWarm(X, Y, W, H);
      g.strokeStyle = frame;
      g.lineWidth = Math.max(2, 0.04 * pxY);
      g.stroke();
      drawSill();
      return;
    }

    if (type === 'double') {
      // 双联窗：一个窗洞内两根竖框，左右各一扇玻璃，削弱大窗洞的“纸片”感
      g.fillStyle = frame;
      g.fillRect(Math.round(X - fx), Math.round(Y - fy), Math.round(W + fx * 2), Math.round(H + fy * 2));
      const mullW = Math.max(2, 0.055 * pxX);
      const paneW = (W - mullW) / 2;
      for (let p = 0; p < 2; p++) {
        const gx = X + p * (paneW + mullW);
        fillGlassGrad(gx, Y, paneW, H);
        drawSheen(gx, Y, paneW, H);
        drawWarm(gx, Y, paneW, H);
      }
      g.fillStyle = frame;
      g.fillRect(Math.round(X + paneW), Math.round(Y), mullW, Math.round(H));
      drawSill();
      return;
    }

    if (type === 'glass') {
      // 玻璃幕墙：上深下浅竖向渐变 + 斜向反光条，高楼不再像窗格纸
      g.fillStyle = frame;
      g.fillRect(Math.round(X - fx), Math.round(Y - fy), Math.round(W + fx * 2), Math.round(H + fy * 2));
      fillGlassGrad(X, Y, W, H);
      drawBlueSheen(X, Y, W, H);
      // 竖向幕墙竖挺（比 strip 更细更密）
      const mull = (style.glassMull || 1.2) * pxX;
      const mw = Math.max(1, Math.round(0.03 * pxX));
      g.fillStyle = frame;
      for (let mx = X + mull; mx < X + W - 1; mx += mull) {
        g.fillRect(Math.round(mx - mw / 2), Math.round(Y), mw, Math.round(H));
      }
      // 两道斜向反光，强化玻璃转折
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.beginPath();
      g.moveTo(X + W * 0.12, Y); g.lineTo(X + W * 0.34, Y);
      g.lineTo(X + W * 0.06, Y + H); g.lineTo(X + W * 0, Y + H);
      g.closePath();
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.beginPath();
      g.moveTo(X + W * 0.62, Y); g.lineTo(X + W * 0.88, Y);
      g.lineTo(X + W * 0.58, Y + H); g.lineTo(X + W * 0.44, Y + H);
      g.closePath();
      g.fill();
      // 底部玻璃阴影，增加体量
      g.fillStyle = 'rgba(10,14,18,0.25)';
      g.fillRect(Math.round(X), Math.round(Y + H * 0.72), Math.round(W), Math.round(H * 0.28));
      drawWarm(X, Y, W, H, 0.30);
      drawSill();
      return;
    }

    if (type === 'balcony') {
      // 阳台横条：上部玻璃门、下部阳台板与竖向栏杆，打破横向连续带
      g.fillStyle = frame;
      g.fillRect(Math.round(X - fx), Math.round(Y - fy), Math.round(W + fx * 2), Math.round(H + fy * 2));
      const glassH = H * 0.62;
      fillGlassGrad(X, Y, W, glassH);
      drawSheen(X, Y, W, glassH);
      drawWarm(X, Y, W, glassH, 0.30);
      // 阳台板
      const slabY = Y + H * 0.70;
      g.fillStyle = 'rgba(120,126,136,0.9)';
      g.fillRect(Math.round(X), Math.round(slabY), Math.round(W), Math.round(H * 0.30));
      g.fillStyle = 'rgba(20,22,26,0.45)';
      g.fillRect(Math.round(X), Math.round(slabY), Math.round(W), Math.max(2, Math.round(0.03 * pxY)));
      // 栏杆细柱
      g.fillStyle = frame;
      const railN = Math.max(3, Math.floor(W / (0.35 * pxX)));
      for (let i = 0; i <= railN; i++) {
        const rx = X + (i / railN) * W;
        g.fillRect(Math.round(rx - 1), Math.round(Y), 2, Math.round(H));
      }
      drawSill();
      return;
    }

    if (type === 'strip') {
      g.fillStyle = frame;
      g.fillRect(Math.round(X - fx), Math.round(Y - fy), Math.round(W + fx * 2), Math.round(H + fy * 2));
      fillGlassGrad(X, Y, W, H);
      drawBlueSheen(X, Y, W, H);
      // 竖向细分（每 1.2m 一根）
      const mull = 1.2 * pxX;
      const mw = Math.max(2, 0.045 * pxX);
      g.fillStyle = frame;
      for (let mx = X + mull; mx < X + W - 1; mx += mull) {
        g.fillRect(Math.round(mx - mw / 2), Math.round(Y), mw, Math.round(H));
      }
      // 横向长反光
      g.fillStyle = 'rgba(255,255,255,0.16)';
      g.beginPath();
      g.moveTo(X + W * 0.1, Y); g.lineTo(X + W * 0.55, Y);
      g.lineTo(X + W * 0.35, Y + H); g.lineTo(X + W * 0.05, Y + H);
      g.closePath();
      g.fill();
      // 底部玻璃阴影，增加体量
      g.fillStyle = 'rgba(10,14,18,0.25)';
      g.fillRect(Math.round(X), Math.round(Y + H * 0.72), Math.round(W), Math.round(H * 0.28));
      drawWarm(X, Y, W, H, 0.30);
      drawSill();
      return;
    }

    // 标准窗 / 竖向窄窗 / 木格窗 / 错位窗
    g.fillStyle = frame;
    g.fillRect(Math.round(X - fx), Math.round(Y - fy), Math.round(W + fx * 2), Math.round(H + fy * 2));
    fillGlassGrad(X, Y, W, H);
    // 顶部内阴影（过梁感）
    g.fillStyle = 'rgba(10,14,18,0.22)';
    g.fillRect(Math.round(X), Math.round(Y), Math.round(W), Math.max(2, Math.round(0.05 * pxY)));
    drawSheen(X, Y, W, H);
    // 底部玻璃阴影
    g.fillStyle = 'rgba(10,14,18,0.25)';
    g.fillRect(Math.round(X), Math.round(Y + H * 0.72), Math.round(W), Math.round(H * 0.28));
    // 亮窗内透
    drawWarm(X, Y, W, H);
    // 少数窗帘色块
    if (lit && hash2(c * 3 + 1, r * 5 + 2, seed) < 0.35) {
      const curtain = ['rgba(190,120,110,0.38)', 'rgba(120,150,170,0.38)', 'rgba(160,140,110,0.38)'];
      const ci = Math.floor(hash2(c * 7 + 2, r * 11 + 3, seed) * curtain.length);
      g.fillStyle = curtain[ci % curtain.length];
      g.fillRect(Math.round(X + W * 0.12), Math.round(Y + H * 0.5), Math.round(W * 0.76), Math.round(H * 0.42));
    }
    // 木格窗细分
    if (style.woodGrid) {
      g.fillStyle = frame;
      g.fillRect(Math.round(X), Math.round(Y + H * 0.48), Math.round(W), Math.max(2, Math.round(0.035 * pxY)));
      g.fillRect(Math.round(X + W * 0.33), Math.round(Y), Math.max(2, Math.round(0.035 * pxX)), Math.round(H));
      g.fillRect(Math.round(X + W * 0.66), Math.round(Y), Math.max(2, Math.round(0.035 * pxX)), Math.round(H));
    }
    // 窗台投影线
    drawSill();
  }

  function drawWindowEmissive(g, style, x, y, ww, hh, lit, pxX, pxY) {
    if (!lit) return;
    const X = x * pxX, Y = y * pxY, W = ww * pxX, H = hh * pxY;
    const type = style.type || 'std';
    if (type === 'arch') {
      roundedTopRectPath(g, X, Y, W, H, Math.min(0.5, ww / 2) * pxX);
      g.fillStyle = '#ffffff';
      g.fill();
    } else if (type === 'round') {
      roundedRectPath(g, X, Y, W, H, Math.min(0.5, ww / 2, hh / 2) * pxX);
      g.fillStyle = '#ffffff';
      g.fill();
    } else if (type === 'double') {
      const mullW = Math.max(2, 0.055 * pxX);
      const paneW = (W - mullW) / 2;
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(X), Math.round(Y), Math.round(paneW), Math.round(H));
      g.fillRect(Math.round(X + paneW + mullW), Math.round(Y), Math.round(paneW), Math.round(H));
    } else if (type === 'balcony') {
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(X), Math.round(Y), Math.round(W), Math.round(H * 0.62));
    } else {
      g.fillStyle = '#ffffff';
      g.fillRect(Math.round(X), Math.round(Y), Math.round(W), Math.round(H));
    }
  }

  function drawFacadeMap(g, w, h, style, seed, pxX, pxY) {
    // 墙面压暗，避免黄昏/低角度阳光把浅色墙打爆成纯白
    g.fillStyle = shadeColor(style.wall, -0.18);
    g.fillRect(0, 0, w, h);
    forEachFacadeWindow(style, seed, function (c, r, x, y, ww, hh, lit) {
      drawWindowMap(g, style, seed, c, r, x, y, ww, hh, lit, pxX, pxY);
    });
    // 楼层分格线：贴图顶边一条细横线，重复后每 4m 一条
    g.fillStyle = 'rgba(28,32,38,0.55)';
    g.fillRect(0, 0, w, Math.max(2, Math.round(pxY * 0.05)));
    // 最底部 4% 高度的深色墙裙/楼板带（约 0.16m），强化楼根接地与楼层节奏
    const skirtH = Math.max(3, Math.round(h * 0.04));
    g.fillStyle = 'rgba(18,20,24,0.62)';
    g.fillRect(0, h - skirtH, w, skirtH);
    grain(g, w, h, seed, 0.035, 260);
  }

  function drawFacadeEmissive(g, w, h, style, seed, pxX, pxY) {
    g.fillStyle = '#000000';
    g.fillRect(0, 0, w, h);
    forEachFacadeWindow(style, seed, function (c, r, x, y, ww, hh, lit) {
      drawWindowEmissive(g, style, x, y, ww, hh, lit, pxX, pxY);
    });
  }

  function makeFacadeHQ(zone, variant) {
    const style = styleFor(zone, variant);
    const seed = facadeSeed(zone, variant);
    const HQ = zone === 'cbd' || zone === 'mix';
    const W = 512, H = HQ ? 1024 : 512;
    const pxX = W / 6, pxY = H / 4;
    const map = CITY.makeCanvas(W, H, function (g, w, h) {
      drawFacadeMap(g, w, h, style, seed, pxX, pxY);
    }, { srgb: true });
    const emi = CITY.makeCanvas(W, H, function (g, w, h) {
      drawFacadeEmissive(g, w, h, style, seed, pxX, pxY);
    }, { srgb: false });
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    emi.wrapS = emi.wrapT = THREE.RepeatWrapping;
    map.anisotropy = 8;
    emi.anisotropy = 8;
    map.generateMipmaps = true;
    map.minFilter = THREE.LinearMipmapLinearFilter;
    emi.generateMipmaps = true;
    emi.minFilter = THREE.LinearMipmapLinearFilter;
    return { map: map, emissiveMap: emi };
  }

  // ---------- 材质 ----------
  function facadeMaterial(zone, variant) {
    const key = 'city.facade.' + zone + '.' + variant;
    return CITY.std(key, function () {
      const fac = makeFacadeHQ(zone, variant);
      const mat = new THREE.MeshStandardMaterial({
        map: fac.map,
        emissiveMap: fac.emissiveMap,
        emissive: 0xffc27a,
        emissiveIntensity: 0.1,
        roughness: 0.8,
        metalness: 0.06
      });
      mat.userData.cityFacade = true;
      CITY.registerNight(mat);
      return mat;
    });
  }

  function makeShopFrontHQ(zone, text) {
    const P = CITY.pal[zone];
    text = text || '商店';
    return CITY.makeCanvas(512, 512, function (g, w, h) {
      g.fillStyle = hexColor(P.walls[0]);
      g.fillRect(0, 0, w, h);
      // 招牌带
      g.fillStyle = '#23272f';
      g.fillRect(w * 0.03, h * 0.03, w * 0.94, h * 0.2);
      g.strokeStyle = '#3a3f47';
      g.lineWidth = 3;
      g.strokeRect(w * 0.03, h * 0.03, w * 0.94, h * 0.2);
      g.fillStyle = '#ffd98a';
      g.font = 'bold ' + Math.round(h * 0.12) + 'px "Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, h * 0.13);
      // 细密遮阳棚条纹
      const ay = h * 0.26, ah = h * 0.16;
      g.fillStyle = hexColor(P.awning[0]);
      g.fillRect(0, ay, w, ah);
      const stripes = 14;
      for (let i = 0; i < stripes; i++) {
        g.fillStyle = i % 2 ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.10)';
        g.fillRect(i * w / stripes, ay, w / stripes + 0.5, ah);
      }
      // 落地玻璃
      const gy = h * 0.44, gh = h * 0.56;
      const grad = g.createLinearGradient(0, gy, 0, gy + gh);
      grad.addColorStop(0, shadeColor(P.glass[0], 0.5));
      grad.addColorStop(1, shadeColor(P.glass[0], -0.3));
      g.fillStyle = grad;
      g.fillRect(0, gy, w, gh);
      // 玻璃反光
      g.fillStyle = 'rgba(255,255,255,0.22)';
      g.beginPath();
      g.moveTo(w * 0.1, gy); g.lineTo(w * 0.25, gy);
      g.lineTo(w * 0.08, gy + gh); g.lineTo(0, gy + gh);
      g.closePath(); g.fill();
      g.beginPath();
      g.moveTo(w * 0.55, gy); g.lineTo(w * 0.7, gy);
      g.lineTo(w * 0.52, gy + gh); g.lineTo(w * 0.44, gy + gh);
      g.closePath(); g.fill();
      // 门框/竖挺
      g.fillStyle = '#3a3e46';
      g.fillRect(0, gy, w, 4);
      g.fillRect(w * 0.47, gy, w * 0.06, gh);
      g.fillRect(w * 0.2, gy, 3, gh);
      g.fillRect(w * 0.8, gy, 3, gh);
      // 门把手
      g.fillStyle = '#d8d8d0';
      g.fillRect(w * 0.44, gy + gh * 0.5, 4, 14);
      g.fillRect(w * 0.53, gy + gh * 0.5, 4, 14);
      grain(g, w, h, zone.length * 131 + 7, 0.04, 350);
    }, { srgb: true });
  }

  function makeShopEmissiveHQ() {
    return CITY.makeCanvas(512, 512, function (g, w, h) {
      g.fillStyle = '#000000';
      g.fillRect(0, 0, w, h);
      // 招牌整条发光
      g.fillStyle = '#ffffff';
      g.fillRect(w * 0.03, h * 0.03, w * 0.94, h * 0.2);
      // 遮阳棚亮条纹
      const ay = h * 0.26, ah = h * 0.16;
      for (let i = 0; i < 14; i += 2) {
        g.fillStyle = 'rgba(255,255,255,0.8)';
        g.fillRect(i * w / 14, ay, w / 14 + 0.5, ah);
      }
      // 玻璃微弱内透
      g.fillStyle = 'rgba(255,255,255,0.14)';
      g.fillRect(0, h * 0.44, w, h * 0.56);
    }, { srgb: false });
  }

  let shopEmissiveTex = null;
  function shopEmissiveTexture() {
    if (shopEmissiveTex) return shopEmissiveTex;
    shopEmissiveTex = makeShopEmissiveHQ();
    shopEmissiveTex.wrapS = shopEmissiveTex.wrapT = THREE.RepeatWrapping;
    shopEmissiveTex.anisotropy = 8;
    shopEmissiveTex.generateMipmaps = true;
    shopEmissiveTex.minFilter = THREE.LinearMipmapLinearFilter;
    return shopEmissiveTex;
  }

  function shopMaterial(zone, variant) {
    const v = ((variant || 0) % 5 + 5) % 5;
    const key = 'city.shop.' + zone + '.' + v;
    return CITY.std(key, function () {
      const map = makeShopFrontHQ(zone, shopTextFor(zone, v));
      map.wrapS = map.wrapT = THREE.RepeatWrapping;
      map.anisotropy = 8;
      map.generateMipmaps = true;
      map.minFilter = THREE.LinearMipmapLinearFilter;
      const mat = new THREE.MeshStandardMaterial({
        map: map,
        emissiveMap: shopEmissiveTexture(),
        emissive: 0xffc27a,
        emissiveIntensity: 0.1,
        roughness: 0.62,
        metalness: 0.05
      });
      CITY.registerNight(mat);
      return mat;
    });
  }

  function roofMaterial(zone) {
    return CITY.std('city.roof.' + zone, function () {
      return new THREE.MeshStandardMaterial({
        color: CITY.pick(CITY.pal[zone].roofs),
        roughness: 0.88,
        metalness: 0.06
      });
    });
  }

  function detailMaterial(name) {
    return CITY.std('city.detail.' + name, function () {
      if (name === 'tank') {
        return new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.55, metalness: 0.55 });
      }
      if (name === 'ac') {
        return new THREE.MeshStandardMaterial({ color: 0xaab3bd, roughness: 0.42, metalness: 0.75 });
      }
      if (name === 'antenna') {
        return new THREE.MeshStandardMaterial({ color: 0x7d858f, roughness: 0.38, metalness: 0.85 });
      }
      return new THREE.MeshStandardMaterial({ color: 0x1c3550, roughness: 0.3, metalness: 0.65 });
    });
  }

  function trimMaterial() {
    return CITY.std('city.trim', function () {
      return new THREE.MeshStandardMaterial({ color: 0x353a42, roughness: 0.7, metalness: 0.35 });
    });
  }

  function slabMaterial() {
    return CITY.std('city.slab', function () {
      return new THREE.MeshStandardMaterial({ color: 0xc9ccc9, roughness: 0.9, metalness: 0.02 });
    });
  }

  function beaconMaterial() {
    return CITY.std('city.beacon', function () {
      const mat = new THREE.MeshStandardMaterial({
        color: 0x3a0000,
        emissive: 0xff2222,
        emissiveIntensity: 1.8,
        roughness: 0.5
      });
      CITY.registerNight(mat);
      return mat;
    });
  }

  function clockFaceMaterial() {
    return CITY.std('city.clockface', function () {
      const mat = new THREE.MeshStandardMaterial({
        color: 0xf4ecd8,
        emissive: 0xfff0c8,
        emissiveIntensity: 0.5,
        roughness: 0.6
      });
      CITY.registerNight(mat);
      return mat;
    });
  }

  function deptSignMaterial() {
    return CITY.std('city.deptsign', function () {
      const map = CITY.makeSign('海特洛百货', {
        w: 512, h: 128,
        bg: '#8a2f2f', fg: '#ffd98a', border: '#2b2f38'
      });
      const mat = new THREE.MeshStandardMaterial({
        map: map,
        emissive: 0xffc27a,
        emissiveMap: map,
        emissiveIntensity: 0.3,
        roughness: 0.6
      });
      CITY.registerNight(mat);
      return mat;
    });
  }

  let detailGeoCache = null;
  function detailGeos() {
    if (detailGeoCache) return detailGeoCache;
    detailGeoCache = {
      tank: new THREE.CylinderGeometry(1.0, 1.25, 2.1, 8),
      ac: new THREE.BoxGeometry(1.5, 0.95, 0.95),
      antenna: new THREE.CylinderGeometry(0.05, 0.11, 4.2, 6),
      solar: new THREE.BoxGeometry(2.1, 0.08, 1.4),
      beacon: new THREE.BoxGeometry(0.7, 0.7, 0.7)
    };
    return detailGeoCache;
  }

  // ---------- 预生成全部材质/贴图 ----------
  function ensureAssets() {
    for (let z = 0; z < ZONES.length; z++) {
      const zone = ZONES[z];
      for (let v = 0; v < FACADE_VARIANTS; v++) facadeMaterial(zone, v);
      shopMaterial(zone);
      roofMaterial(zone);
    }
    detailMaterial('tank');
    detailMaterial('ac');
    detailMaterial('antenna');
    detailMaterial('panel');
    trimMaterial();
    beaconMaterial();
    clockFaceMaterial();
    deptSignMaterial();
    detailGeos();
    shopEmissiveTexture();
  }

  // ---------- 屋顶细节 ----------
  function addRoofDetails(lot, meshes) {
    const G = detailGeos();
    const top = lot.floors * CITY.pal[lot.zone].floorH;
    const R = Math.max(1.2, Math.min(lot.bw, lot.bd) * 0.5 - 1.4);
    const area = lot.bw * lot.bd;
    let n = area > 1200 ? 5 : (area > 600 ? 4 : (area > 250 ? 3 : (area > 90 ? 2 : 1)));
    if (CITY.chance(0.2)) n = Math.min(n + 1, 6);

    const types = ['tank', 'ac', 'antenna', 'solar'];
    for (let i = 0; i < n; i++) {
      const type = CITY.pick(types);
      const ang = CITY.rand(0, Math.PI * 2);
      const rr = Math.sqrt(CITY.rand(0.15, 1)) * R;
      const lx = Math.cos(ang) * rr;
      const lz = Math.sin(ang) * rr;

      if (type === 'tank') {
        const m = new THREE.Mesh(G.tank, detailMaterial('tank'));
        placePart(m, lot, lx, top + 1.05, lz, CITY.rand(0, Math.PI));
        meshes.push(m);
      } else if (type === 'ac') {
        const m = new THREE.Mesh(G.ac, detailMaterial('ac'));
        placePart(m, lot, lx, top + 0.475, lz, CITY.rand(0, Math.PI));
        meshes.push(m);
      } else if (type === 'antenna') {
        const m = new THREE.Mesh(G.antenna, detailMaterial('antenna'));
        placePart(m, lot, lx, top + 2.1, lz, 0);
        meshes.push(m);
      } else {
        const m = new THREE.Mesh(G.solar, detailMaterial('panel'));
        placePart(m, lot, lx, top + 0.3, lz, CITY.rand(0, Math.PI));
        m.rotation.x = -0.55;
        meshes.push(m);
      }
    }

    // CBD 楼顶红色航空警示灯
    if (lot.zone === 'cbd') {
      const m = new THREE.Mesh(G.beacon, beaconMaterial());
      placePart(m, lot, 0, top + 1.4, 0, 0);
      meshes.push(m);
    }
  }

  // ---------- 建筑转角深色收边 + 勒脚（几何压条，随墙合并） ----------
  function addCornerTrim(lot, meshes, bh) {
    const mat = trimMaterial();
    const t = 0.3, ph = 1.05, pt = 0.25;
    const bw = lot.bw, bd = lot.bd;
    const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let i = 0; i < corners.length; i++) {
      const sx = corners[i][0], sz = corners[i][1];
      const geo = new THREE.BoxGeometry(t, bh, t);
      geosScratch.push(geo);
      const m = new THREE.Mesh(geo, mat);
      placePart(m, lot, sx * (bw / 2 - t / 2), bh / 2, sz * (bd / 2 - t / 2), 0);
      meshes.push(m);
    }
    const skirt = [
      { w: bw + pt * 2, h: ph, d: pt, lx: 0, lz: bd / 2 + pt / 2 },
      { w: bw + pt * 2, h: ph, d: pt, lx: 0, lz: -(bd / 2 + pt / 2) },
      { w: pt, h: ph, d: bd, lx: bw / 2 + pt / 2, lz: 0 },
      { w: pt, h: ph, d: bd, lx: -(bw / 2 + pt / 2), lz: 0 }
    ];
    for (let i = 0; i < skirt.length; i++) {
      const p = skirt[i];
      const geo = new THREE.BoxGeometry(p.w, p.h, p.d);
      geosScratch.push(geo);
      const m = new THREE.Mesh(geo, mat);
      placePart(m, lot, p.lx, ph / 2, p.lz, 0);
      meshes.push(m);
    }
  }

  // ---------- CBD 女儿墙压顶（0.8m 高薄 Box，深灰） ----------
  function addParapetBoxes(lot, meshes, topY, bw, bd) {
    const mat = trimMaterial();
    const t = 0.22, h = 0.8;
    const y = topY + h / 2;
    const parts = [
      { w: bw + t, h: h, d: t, lx: 0, lz: bd / 2 },
      { w: bw + t, h: h, d: t, lx: 0, lz: -bd / 2 },
      { w: t, h: h, d: bd, lx: bw / 2, lz: 0 },
      { w: t, h: h, d: bd, lx: -bw / 2, lz: 0 }
    ];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const geo = new THREE.BoxGeometry(p.w, p.h, p.d);
      geosScratch.push(geo);
      const m = new THREE.Mesh(geo, mat);
      placePart(m, lot, p.lx, y, p.lz, 0);
      meshes.push(m);
    }
  }

  // ---------- 店铺门面（贴墙 Plane，偏移 0.06m 防 z-fight） ----------
  function addShopFront(lot, meshes, nr) {
    if (!nr) return;
    const bw = lot.bw, bd = lot.bd;
    const c = Math.cos(lot.yaw), s = Math.sin(lot.yaw);
    const vx = nr.px - lot.x, vz = nr.pz - lot.z;
    const lx = vx * c - vz * s;
    const lz = vx * s + vz * c;

    let axis, side, wallLen;
    if (Math.abs(lx) >= Math.abs(lz)) {
      axis = 'x'; side = lx >= 0 ? 1 : -1; wallLen = bd;
    } else {
      axis = 'z'; side = lz >= 0 ? 1 : -1; wallLen = bw;
    }

    const shopW = Math.max(4, Math.min(wallLen * 0.86, 18));
    const shopH = Math.max(3.2, Math.min(5.6, lot.floors * CITY.pal[lot.zone].floorH * 0.55));
    const shopY = Math.max(2.0, shopH * 0.5 + 0.25);
    const lcx = axis === 'x' ? side * bw / 2 : 0;
    const lcz = axis === 'z' ? side * bd / 2 : 0;
    const p = localToWorld(lot, lcx, shopY, lcz);

    let nx, nz;
    if (axis === 'x') { nx = c * side; nz = -s * side; }
    else { nx = s * side; nz = c * side; }

    const mat = shopMaterial(lot.zone, lot.idx % 5);
    const geo = new THREE.PlaneGeometry(shopW, shopH);
    geosScratch.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.x + nx * 0.06, p.y, p.z + nz * 0.06);
    mesh.rotation.y = Math.atan2(nx, nz);
    meshes.push(mesh);
  }

  // ---------- 标准建筑（单栋） ----------
  function buildBuilding(lot, meshes, world, nr) {
    const P = CITY.pal[lot.zone];
    const bw = lot.bw, bd = lot.bd;
    const bh = lot.floors * P.floorH;
    const wallMat = facadeMaterial(lot.zone, lot.variant);

    // 墙面 Box：单材质，侧面 UV 按 6m×4m 一个单元平铺 + 确定性相位偏移
    const wallGeo = new THREE.BoxGeometry(bw, bh, bd);
    const wallUv = uvOffsets(lot);
    scaleSideUV(wallGeo, bw / 6, bh / 4, wallUv.u, wallUv.v);
    geosScratch.push(wallGeo);
    const wall = new THREE.Mesh(wallGeo, wallMat);
    placePart(wall, lot, 0, bh / 2, 0, 0);
    meshes.push(wall);

    // 接地阴影：每栋楼底部一个椭圆 AO 面，消除“悬浮感”
    addBuildingAO(lot, meshes, world);

    // 转角深色收边 + 勒脚
    addCornerTrim(lot, meshes, bh);

    // 屋顶：老城/文创用四棱锥尖顶，其余用扁平 Box
    const roofMat = roofMaterial(lot.zone);
    if (lot.zone === 'old' || lot.zone === 'culture') {
      const roofH = 2.6 + (lot.floors <= 3 ? 1.3 : 0.7);
      const radius = Math.max(bw, bd) * 0.72;
      const roofGeo = new THREE.ConeGeometry(radius, roofH, 4);
      geosScratch.push(roofGeo);
      const roof = new THREE.Mesh(roofGeo, roofMat);
      placePart(roof, lot, 0, bh + roofH / 2, 0, Math.PI / 4);
      meshes.push(roof);
    } else {
      const over = 0.4;
      const rt = 0.5;
      const roofGeo = new THREE.BoxGeometry(bw + over * 2, rt, bd + over * 2);
      geosScratch.push(roofGeo);
      const roof = new THREE.Mesh(roofGeo, roofMat);
      placePart(roof, lot, 0, bh + rt / 2, 0, 0);
      meshes.push(roof);
      addRoofDetails(lot, meshes);
      // CBD 女儿墙压顶
      if (lot.zone === 'cbd') addParapetBoxes(lot, meshes, bh + 0.5, bw, bd);
    }

    // 离道路中心 < 45m 的低层建筑贴店铺门面
    if (!lot.noShop && nr && nr.d < 45 && lot.floors <= 8) {
      addShopFront(lot, meshes, nr);
    }
  }

  // ---------- 地块规划 ----------
  function landmarkSkip(lot) {
    const spots = [
      { x: -180, z: 720, hw: 26, hd: 26 },   // 迈达斯科技中心 44×44
      { x: -430, z: -640, hw: 11, hd: 11 },  // 老城钟楼
      { x: -160, z: -720, hw: 34, hd: 19 }   // 老城百货 60×30
    ];
    for (let i = 0; i < spots.length; i++) {
      const r = spots[i];
      const hw = r.hw + Math.max(lot.w, lot.d) * 0.5;
      const hd = r.hd + Math.max(lot.w, lot.d) * 0.5;
      if (Math.abs(lot.x - r.x) < hw && Math.abs(lot.z - r.z) < hd) return true;
    }
    return false;
  }

  function enforceHeightDiff(prev, cur) {
    const P = CITY.pal[cur.zone];
    const hp = prev.floors * CITY.pal[prev.zone].floorH;
    const hc = cur.floors * P.floorH;
    if (Math.max(hp, hc) < Math.min(hp, hc) * 1.3) {
      const target = hc <= hp ? hp / 1.3 : hp * 1.3;
      let f = Math.round(target / P.floorH);
      f = Math.max(P.floorLo, Math.min(P.floorHi, f));
      if (f === cur.floors) {
        f = Math.max(P.floorLo, Math.min(P.floorHi, cur.floors + (hc <= hp ? -1 : 1)));
      }
      cur.floors = f;
    }
  }

  function planLots(lots) {
    for (let i = 0; i < lots.length; i++) {
      const l = lots[i];
      const P = CITY.pal[l.zone];
      const margin = 1.5 + CITY.rand(0, 1.5);
      const side = Math.max(5, Math.min(l.w, l.d) - margin * 2);
      l.bw = side;
      l.bd = side;
      l.floors = floorInt(P.floorLo, P.floorHi);
      const zoneIndex = ZONE_INDEX[l.zone] !== undefined ? ZONE_INDEX[l.zone] : 0;
      // 确定性分配：相邻 idx 的 variant 相差 5（模 8），同分区相邻楼样式必不同；
      // 8 个样式表内 wall 色按 (styleIdx % paletteLength) 循环，因此相邻楼墙色也不同。
      l.variant = (l.idx * 5 + zoneIndex * 3) % FACADE_VARIANTS;
      l.wallIdx = l.idx % CITY.pal[l.zone].walls.length;
    }
    // 与左邻（同分区前一个地块）错开立面变体与楼高，同街区高度差 ≥ 30%
    for (let i = 1; i < lots.length; i++) {
      const p = lots[i - 1], l = lots[i];
      if (p.zone !== l.zone) continue;
      if (p.variant === l.variant) l.variant = (l.variant + 5) % FACADE_VARIANTS;
      enforceHeightDiff(p, l);
    }
  }

  // ---------- 地标辅助 ----------
  function tangentYaw(world, nr) {
    if (!nr || !nr.s) return 0;
    const route = world.trafficRoutes ? world.trafficRoutes.find(function (r) { return r.id === nr.s.road; }) : null;
    if (!route) return 0;
    const si = route.samples.indexOf(nr.s);
    if (si < 0) return 0;
    const a = route.samples[Math.max(0, si - 3)];
    const b = route.samples[Math.min(si + 3, route.samples.length - 1)];
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  function placeFacingPlane(mesh, lot, lx, ly, lz, nx, nz, offset) {
    const p = localToWorld(lot, lx, ly, lz);
    mesh.position.set(p.x + nx * (offset || 0), p.y, p.z + nz * (offset || 0));
    mesh.rotation.y = Math.atan2(nx, nz);
    return mesh;
  }

  function addLandmarkCollider(world, x, z, w, d) {
    const nr = world.nearestRoad(x, z);
    if (nr && nr.d < 48) {
      CITY.addCollider(world, x, z, Math.hypot(w, d) * 0.31, 'building');
    }
  }

  // ---------- 地标 1：迈达斯科技中心（CBD，-180,720） ----------
  function buildMidas(meshes, world, stats) {
    const x = -180, z = 720;
    const baseY = world.terrainHeight(x, z);
    const nr = world.nearestRoad(x, z);
    const yaw = tangentYaw(world, nr);
    const lot = { x: x, z: z, baseY: baseY, yaw: yaw, zone: 'cbd', bw: 44, bd: 44, floors: 40 };
    const mat = facadeMaterial('cbd', 0);

    function box(w, h, d, yCenter) {
      const geo = new THREE.BoxGeometry(w, h, d);
      const uv = uvOffsets(lot);
      scaleSideUV(geo, w / 6, h / 4, uv.u, uv.v);
      geosScratch.push(geo);
      const m = new THREE.Mesh(geo, mat);
      placePart(m, lot, 0, yCenter, 0, 0);
      meshes.push(m);
    }

    // 40 层约 160m，顶部三段收分
    box(44, 96, 44, 48);
    addBuildingAO(lot, meshes, world);
    box(34, 40, 34, 116);
    box(22, 24, 22, 148);
    addParapetBoxes(lot, meshes, 160, 22, 22);

    const antennaH = 14;
    const antennaGeo = new THREE.CylinderGeometry(0.08, 0.22, antennaH, 6);
    geosScratch.push(antennaGeo);
    const antenna = new THREE.Mesh(antennaGeo, detailMaterial('antenna'));
    placePart(antenna, lot, 0, 160 + antennaH / 2, 0, 0);
    meshes.push(antenna);

    const beaconGeo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    geosScratch.push(beaconGeo);
    const beacon = new THREE.Mesh(beaconGeo, beaconMaterial());
    placePart(beacon, lot, 0, 160 + antennaH + 0.4, 0, 0);
    meshes.push(beacon);

    CITY.landmarks.midas = { x: x, z: z, topY: baseY + 160 + antennaH };
    stats.buildingCount++;
    stats.floorsMin = Math.min(stats.floorsMin, 40);
    stats.floorsMax = Math.max(stats.floorsMax, 40);
    stats.zones.cbd = (stats.zones.cbd || 0) + 1;
    addLandmarkCollider(world, x, z, 44, 44);
  }

  // ---------- 地标 2：老城钟楼（-430,-640） ----------
  function buildClockTower(meshes, world, stats) {
    const x = -430, z = -640;
    const baseY = world.terrainHeight(x, z);
    const nr = world.nearestRoad(x, z);
    const yaw = tangentYaw(world, nr);
    const lot = { x: x, z: z, baseY: baseY, yaw: yaw, zone: 'old', bw: 14, bd: 14, floors: 3 };
    const wallMat = facadeMaterial('old', 2);
    const roofMat = roofMaterial('old');
    const baseH = 3 * CITY.pal.old.floorH;
    const towerH = 7.5;
    const spireH = 9;

    const baseGeo = new THREE.BoxGeometry(14, baseH, 14);
    const clockUv = uvOffsets(lot);
    scaleSideUV(baseGeo, 14 / 6, baseH / 4, clockUv.u, clockUv.v);
    geosScratch.push(baseGeo);
    const base = new THREE.Mesh(baseGeo, wallMat);
    placePart(base, lot, 0, baseH / 2, 0, 0);
    meshes.push(base);
    addBuildingAO(lot, meshes, world);

    const towerGeo = new THREE.BoxGeometry(7, towerH, 7);
    scaleSideUV(towerGeo, 7 / 6, towerH / 4, clockUv.u, clockUv.v);
    geosScratch.push(towerGeo);
    const tower = new THREE.Mesh(towerGeo, wallMat);
    placePart(tower, lot, 0, baseH + towerH / 2, 0, 0);
    meshes.push(tower);

    const spireGeo = new THREE.ConeGeometry(4.4, spireH, 8);
    geosScratch.push(spireGeo);
    const spire = new THREE.Mesh(spireGeo, roofMat);
    placePart(spire, lot, 0, baseH + towerH + spireH / 2, 0, 0);
    meshes.push(spire);

    // 四个方向的简单表盘圆面（发光）
    const faceMat = clockFaceMaterial();
    const faceGeo = new THREE.CircleGeometry(2.1, 16);
    const f = 3.5 + 0.08;
    const fy = baseH + towerH * 0.55;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const sides = [
      { lx: f, lz: 0, nx: c, nz: -s },
      { lx: -f, lz: 0, nx: -c, nz: s },
      { lx: 0, lz: f, nx: s, nz: c },
      { lx: 0, lz: -f, nx: -s, nz: -c }
    ];
    for (let i = 0; i < sides.length; i++) {
      const face = new THREE.Mesh(faceGeo, faceMat);
      placeFacingPlane(face, lot, sides[i].lx, fy, sides[i].lz, sides[i].nx, sides[i].nz, 0.08);
      meshes.push(face);
    }

    CITY.landmarks.clock = { x: x, z: z, topY: baseY + baseH + towerH + spireH };
    stats.buildingCount++;
    stats.floorsMin = Math.min(stats.floorsMin, 3);
    stats.floorsMax = Math.max(stats.floorsMax, 3);
    stats.zones.old = (stats.zones.old || 0) + 1;
    addLandmarkCollider(world, x, z, 14, 14);
  }

  // ---------- 地标 3：老城百货（-160,-720，60×30，屋顶大招牌） ----------
  function buildDepartmentStore(meshes, world, stats) {
    const x = -160, z = -720;
    const baseY = world.terrainHeight(x, z);
    const nr = world.nearestRoad(x, z);
    const yaw = tangentYaw(world, nr);
    const floors = 5;
    const bh = floors * CITY.pal.old.floorH;
    const lot = { x: x, z: z, baseY: baseY, yaw: yaw, zone: 'old', bw: 60, bd: 30, floors: floors, noShop: true };
    const wallMat = facadeMaterial('old', 5 % FACADE_VARIANTS);
    const roofMat = roofMaterial('old');

    const wallGeo = new THREE.BoxGeometry(60, bh, 30);
    const deptUv = uvOffsets(lot);
    scaleSideUV(wallGeo, 60 / 6, bh / 4, deptUv.u, deptUv.v);
    geosScratch.push(wallGeo);
    const wall = new THREE.Mesh(wallGeo, wallMat);
    placePart(wall, lot, 0, bh / 2, 0, 0);
    meshes.push(wall);
    addBuildingAO(lot, meshes, world);

    addCornerTrim(lot, meshes, bh);

    const roofGeo = new THREE.BoxGeometry(60.8, 0.6, 30.8);
    geosScratch.push(roofGeo);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    placePart(roof, lot, 0, bh + 0.3, 0, 0);
    meshes.push(roof);

    addRoofDetails(lot, meshes);

    // 屋顶大招牌：朝向最近道路
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const vx = nr ? nr.px - x : 0, vz = nr ? nr.pz - z : 0;
    const lx = vx * c - vz * s;
    const lz = vx * s + vz * c;
    let nx, nz;
    if (Math.abs(lx) >= Math.abs(lz)) {
      const side = lx >= 0 ? 1 : -1;
      nx = c * side; nz = -s * side;
    } else {
      const side = lz >= 0 ? 1 : -1;
      nx = s * side; nz = c * side;
    }
    const signGeo = new THREE.PlaneGeometry(24, 6);
    geosScratch.push(signGeo);
    const sign = new THREE.Mesh(signGeo, deptSignMaterial());
    placeFacingPlane(sign, lot, 0, bh + 0.6 + 3, 0, nx, nz, 0);
    meshes.push(sign);

    CITY.landmarks.dept = { x: x, z: z, topY: baseY + bh + 0.6 + 6 };
    stats.buildingCount++;
    stats.floorsMin = Math.min(stats.floorsMin, floors);
    stats.floorsMax = Math.max(stats.floorsMax, floors);
    stats.zones.old = (stats.zones.old || 0) + 1;
    addLandmarkCollider(world, x, z, 60, 30);
  }

  // ---------- 地标 4：滨海酒店（沿 coast 路 2~3 栋 6~8 层） ----------
  function buildSeasideHotels(meshes, world, stats) {
    const hotels = [];
    const route = world.trafficRoutes ? world.trafficRoutes.find(function (r) { return r.id === 'coast'; }) : null;
    const fractions = [0.28, 0.5, 0.72];

    if (route && route.samples.length > 8) {
      for (let i = 0; i < fractions.length; i++) {
        const si = Math.floor(fractions[i] * (route.samples.length - 1));
        const s = route.samples[si];
        const a = route.samples[Math.max(0, si - 3)];
        const b = route.samples[Math.min(si + 3, route.samples.length - 1)];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz) || 1;
        const yaw = Math.atan2(dx, dz);
        let nx = dz / len, nz = -dx / len;
        if (nz > 0) { nx = -nx; nz = -nz; }
        const off = 42;
        const hx = s.x + nx * off;
        const hz = s.z + nz * off;
        const floors = 6 + Math.floor(CITY.rand(0, 3));
        const lot = {
          x: hx, z: hz, baseY: s.h, yaw: yaw,
          bw: 24, bd: 14, floors: floors,
          variant: i % FACADE_VARIANTS,
          zone: 'seaside', noShop: true
        };
        const nr = world.nearestRoad(hx, hz);
        buildBuilding(lot, meshes, world, nr);
        if (nr && nr.d < 48) {
          CITY.addCollider(world, hx, hz, Math.hypot(24, 14) * 0.31, 'building');
        }
        stats.buildingCount++;
        stats.floorsMin = Math.min(stats.floorsMin, floors);
        stats.floorsMax = Math.max(stats.floorsMax, floors);
        stats.zones.seaside = (stats.zones.seaside || 0) + 1;
        hotels.push({ x: hx, z: hz, floors: floors, topY: s.h + floors * CITY.pal.seaside.floorH + 0.5 });
      }
    } else {
      // 兜底：coast 路缺失时，沿海岸 z≈-1440 摆三栋
      const fixed = [[-780, -1440], [0, -1440], [720, -1440]];
      for (let i = 0; i < fixed.length; i++) {
        const hx = fixed[i][0], hz = fixed[i][1];
        const floors = 6 + Math.floor(CITY.rand(0, 3));
        const lot = {
          x: hx, z: hz, baseY: world.terrainHeight(hx, hz), yaw: Math.PI / 2,
          bw: 24, bd: 14, floors: floors,
          variant: i % FACADE_VARIANTS,
          zone: 'seaside', noShop: true
        };
        const nr = world.nearestRoad(hx, hz);
        buildBuilding(lot, meshes, world, nr);
        if (nr && nr.d < 48) {
          CITY.addCollider(world, hx, hz, Math.hypot(24, 14) * 0.31, 'building');
        }
        stats.buildingCount++;
        stats.floorsMin = Math.min(stats.floorsMin, floors);
        stats.floorsMax = Math.max(stats.floorsMax, floors);
        stats.zones.seaside = (stats.zones.seaside || 0) + 1;
        hotels.push({ x: hx, z: hz, floors: floors, topY: lot.baseY + floors * CITY.pal.seaside.floorH + 0.5 });
      }
    }
    CITY.landmarks.hotels = hotels;
  }

  // ---------- 阶段 1：地块规划 ----------
  CITY.stages.push({
    name: 'cityPlan',
    fn: function (world) {
      CITY.computeLots(world);
      let lots = CITY.lots;
      // 高架走廊避让：core 内部已按 pad 6 过滤，这里再按 pad 8 过滤一次
      lots = lots.filter(function (l) {
        return !landmarkSkip(l) && !CITY.inReserved(l.x, l.z, 8);
      });
      lots.forEach(function (l, i) { l.idx = i; });
      CITY.lots = lots;
      planLots(lots);
      return { lotCount: lots.length };
    }
  });

  // ---------- 阶段 2：建筑生成与合并 ----------
  CITY.stages.push({
    name: 'cityBuildings',
    fn: function (world) {
      if (!world.cityRoot) {
        const g = new THREE.Group();
        g.name = 'cityRoot';
        if (world.scene) world.scene.add(g);
        world.cityRoot = g;
      }

      ensureAssets();
      buildingAOCount = 0;

      const meshes = [];
      const stats = {
        lotCount: CITY.lots.length,
        buildingCount: 0,
        floorsMin: 999,
        floorsMax: 0,
        drawCalls: 0,
        landmark: null,
        zones: { old: 0, culture: 0, cbd: 0, seaside: 0, mix: 0 }
      };
      CITY.landmarks = {};

      for (let i = 0; i < CITY.lots.length; i++) {
        const lot = CITY.lots[i];
        const nr = world.nearestRoad(lot.x, lot.z);
        lot.nrD = nr ? nr.d : 999;
        lot.baseY = world.terrainHeight(lot.x, lot.z);
        buildBuilding(lot, meshes, world, nr);
        if (nr && nr.d < 48) {
          CITY.addCollider(world, lot.x, lot.z, Math.hypot(lot.bw, lot.bd) * 0.31, 'building');
        }
        stats.buildingCount++;
        stats.floorsMin = Math.min(stats.floorsMin, lot.floors);
        stats.floorsMax = Math.max(stats.floorsMax, lot.floors);
        stats.zones[lot.zone] = (stats.zones[lot.zone] || 0) + 1;
      }

      buildMidas(meshes, world, stats);
      buildClockTower(meshes, world, stats);
      buildDepartmentStore(meshes, world, stats);
      buildSeasideHotels(meshes, world, stats);

      const merged = CITY.mergeByMaterial(meshes, world.cityRoot);
      // 接地 AO 是透明贴地 decal：不写深度、不投阴影、最后绘制，避免与路面 z-fight
      for (let i = 0; i < merged.length; i++) {
        const m = merged[i];
        if (m.material && m.material.transparent) {
          m.castShadow = false;
          m.receiveShadow = false;
          m.renderOrder = 2;
        }
      }
      stats.drawCalls = merged.length;
      stats.landmark = CITY.landmarks;
      stats.materialCount = CITY.matCache.size;
      stats.aoFaces = buildingAOCount;
      // 纹理：facade 40套(map+emi)=80 + shop map 5 + shop emissive 1 + dept sign 1 + AO 1 = 88
      stats.textureCount = 5 * FACADE_VARIANTS * 2 + 5 + 1 + 1 + 1;
      stats.texturePixels =
        2 * FACADE_VARIANTS * 2 * 512 * 1024 +
        3 * FACADE_VARIANTS * 2 * 512 * 512 +
        5 * 512 * 512 + 1 * 512 * 512 + 1 * 512 * 128 + 1 * 128 * 128;

      for (let i = 0; i < geosScratch.length; i++) geosScratch[i].dispose();
      geosScratch.length = 0;

      if (stats.floorsMin === 999) stats.floorsMin = 0;
      if (stats.drawCalls > 160) {
        console.warn('[CITY buildings] drawCalls over budget:', stats.drawCalls);
      }
      return stats;
    }
  });
})();
