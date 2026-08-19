(() => {
  'use strict';

  // ============================================================
  //  CITY SKY — 海特洛市天空与氛围层
  //  ------------------------------------------------------------
  //  新海诚积云 / 丁达尔光束 / 北部远山 / 南部海平线 / 轻量异象彩蛋
  //  只通过 window.CITY 注册一个构建阶段 + 一个 update 钩子。
  //  不创建 Light；所有自发光/异象用 emissive 或 MeshBasicMaterial。
  //  天空穹顶、太阳、雾、海水由 world.buildSky/setupLights/buildWater 负责。
  // ============================================================

  if (typeof window === 'undefined' || !window.CITY) {
    console.warn('[city_sky] window.CITY 不存在，跳过注册（请确认 city_core.js 已加载）');
    return;
  }
  if (typeof THREE === 'undefined') {
    console.warn('[city_sky] THREE 不存在，跳过注册');
    return;
  }

  const C = window.CITY;
  const CFG_waterLevel = (typeof CFG !== 'undefined' && CFG.waterLevel != null) ? CFG.waterLevel : 5.0;
  const TAU = Math.PI * 2;

  // ---------- 运行时状态（全部挂在 IIFE 内部，不污染全局） ----------
  const S = {
    time: 0,
    lastTime: 0,
    cloudDrift: 0,
    moteTime: 0,
    drawItems: [],

    clouds: null,          // { meshes, count, vertexCount, puffCount }
    cloudMat: null,        // ShaderMaterial（伪体积）
    cloudMesh: null,       // 合并后的主云 mesh
    sunTmp: new THREE.Vector3(),

    rays: null,            // { material, meshes }

    mountainMats: null,    // [{ mat, baseColor, baseOpacity }]

    seaBand: null,         // { bandMat, bandMesh, fogMats, fogMeshes }

    midas: null,           // { ring, ringMat, glow, glowMat }

    motes: null,           // { points, material, base }

    panels: null,          // { material, meshes }

    seaAnomaly: null,      // { material, mesh }
  };

  // ---------- 工具 ----------
  function sunDirForHour(h, target) {
    const out = target || new THREE.Vector3();
    const ang = (h / 24) * TAU;
    const elev = Math.sin(ang - Math.PI / 2);
    return out.set(
      Math.cos(ang - Math.PI / 2) * 0.75,
      Math.max(-0.15, elev),
      0.55
    ).normalize();
  }

  function ensureCityRoot(world) {
    if (!world.cityRoot) {
      const g = new THREE.Group();
      g.name = 'cityRoot';
      if (world.scene) world.scene.add(g);
      world.cityRoot = g;
    }
    return world.cityRoot;
  }

  function markDraw(item) {
    if (item) S.drawItems.push(item);
    return item;
  }

  // ============================================================
  //  1. 新海诚积云：伪体积 ShaderMaterial + 单合并几何
  //     26 朵主云，每朵 6-12 个软边球状 puff（SphereGeometry 12×8
  //     + 平滑顶点抖动 + smooth normals）。单 draw call。
  //     着色在片元里做三调：受光面暖奶白 / 背光底部淡紫灰 /
  //     地平线金色轮廓（uDusk 控制）；uSunDir 与 world 太阳同步。
  //     东漂回卷放在顶点着色器：aBaseX + uDrift 用 mod 回卷，
  //     CPU 每帧只更新 uniform，不做逐顶点回写。
  // ============================================================
  function makePuffGeometry(px, py, pz, sx, sy, sz, seed, rotY) {
    const g = new THREE.SphereGeometry(1, 18, 12); // 高细分平滑，消除低模轮廓
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const l = Math.sqrt(x * x + y * y + z * z) || 1;
      const nx = x / l, ny = y / l, nz = z / l;
      const sum = Math.sin(nx * 10.0 + seed * 13.7) * 0.50
                + Math.sin(ny * 9.0 - seed * 7.3) * 0.42
                + Math.sin(nz * 12.0 + seed * 5.1) * 0.38
                + Math.sin((nx + nz) * 15.0 + seed * 3.3) * 0.28;
      const j = Math.max(0, Math.min(1, sum * 0.5 + 0.5));
      const d = 1.0 + (j - 0.5) * 0.62; // 半径 ±31% 不规则起伏，摆脱球体轮廓
      pos.setXYZ(i, x * d, y * d, z * d);
    }
    g.rotateY(rotY);
    g.scale(sx, sy, sz);
    g.translate(px, py, pz);
    return g;
  }

  function buildCloudGeometry() {
    const puffItems = [];
    const cloudCount = 22; // 主云 22-30 朵
    // 三个纵深带：北远山前 / 中景 CBD 天际线 / 南侧海面上空
    const bands = [
      { n: 8, z0: 1300, z1: 2000, y0: 200, y1: 380, w0: 170, w1: 300 },
      { n: 10, z0: -200, z1: 900, y0: 220, y1: 430, w0: 170, w1: 320 },
      { n: 8, z0: -1300, z1: -400, y0: 260, y1: 460, w0: 150, w1: 260 },
    ];
    for (const band of bands) {
      for (let ci = 0; ci < band.n; ci++) {
        const cx = C.rand(-1700, 1700);
        const cz = C.rand(band.z0, band.z1);
        const cy = C.rand(band.y0, band.y1);
        const W = C.rand(band.w0, band.w1);
        const H = W * C.rand(0.36, 0.44); // 宽高比约 2.5:1
        const D = W * C.rand(0.55, 0.80);
        const puffCount = 7 + Math.floor(C.rand(0, 5)); // 7..11，更高重叠度让轮廓更成团
        const baseAngle = C.rand(0, TAU);
        for (let b = 0; b < puffCount; b++) {
          const topish = b < Math.ceil(puffCount * 0.55);
          const t = b / puffCount;
          const ang = baseAngle + t * TAU + C.rand(-0.55, 0.55);
          const rad = C.rand(0.30, 0.95);
          const xo = Math.cos(ang) * W * 0.50 * rad;
          const zo = Math.sin(ang) * D * 0.50 * rad;
          const yo = topish
            ? C.rand(0.02, 0.34) * H
            : C.rand(-0.32, 0.10) * H;
          const r = H * (topish ? C.rand(0.24, 0.40) : C.rand(0.34, 0.48));
          const sx = r * C.rand(0.92, 1.25);
          const sy = r * C.rand(0.55, 0.78);
          const sz = r * C.rand(0.82, 1.12);
          const rotY = C.rand(0, TAU);
          const seed = C.rand(0, 100);
          puffItems.push({
            cx,
            g: makePuffGeometry(cx + xo, cy + yo, cz + zo, sx, sy, sz, seed, rotY),
          });
        }
      }
    }

    let totalV = 0, totalI = 0;
    for (const it of puffItems) {
      totalV += it.g.attributes.position.count;
      totalI += it.g.index ? it.g.index.count : 0;
    }
    const pos = new Float32Array(totalV * 3);
    const baseX = new Float32Array(totalV);
    const idx = new Uint32Array(totalI);
    let vOff = 0, iOff = 0;
    for (const it of puffItems) {
      const p = it.g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const vi = vOff + i;
        pos[vi * 3] = p.getX(i);
        pos[vi * 3 + 1] = p.getY(i);
        pos[vi * 3 + 2] = p.getZ(i);
        baseX[vi] = it.cx;
      }
      if (it.g.index) {
        const ig = it.g.index;
        for (let i = 0; i < ig.count; i++) idx[iOff++] = ig.getX(i) + vOff;
      }
      vOff += p.count;
      it.g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aBaseX', new THREE.BufferAttribute(baseX, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals(); // smooth normals：消除折纸棱角
    // SphereGeometry 有 2 个未被索引引用的极点顶点，computeVertexNormals 会留零向量；
    // 它们不会被渲染，但补成 (0,1,0) 避免任何边界情况。
    const norm = geo.attributes.normal;
    for (let i = 0; i < norm.count; i++) {
      const nx = norm.getX(i), ny = norm.getY(i), nz = norm.getZ(i);
      if (nx * nx + ny * ny + nz * nz < 1e-8) norm.setXYZ(i, 0, 1, 0);
    }
    geo.computeBoundingSphere();
    return { geo, vertexCount: totalV, puffCount: puffItems.length, cloudCount };
  }

  // ============================================================
  //  1b. 手绘软边云（当前启用）：大画布多层径向渐变绘制，精灵面片
  //      始终面向相机。kind: 0 白天 / 1 黄昏金边 / 2 夜间。
  //      相比几何 puff，轮廓完全柔和，符合新海诚背景画风。
  // ============================================================
  function paintCloudTexture(kind) {
    const W = 1024, H = 512;
    return C.makeCanvas(W, H, (g) => {
      g.clearRect(0, 0, W, H);
      const warm = kind === 1, night = kind === 2;
      // 所有渐变只画在每团 puff 内部：整张画布始终保持透明，避免矩形硬边
      for (let i = 0; i < 30; i++) {
        const x = C.rand(90, W - 90);
        const y = C.rand(H * 0.18, H * 0.72);
        const rx = C.rand(55, 170);
        const ry = rx * C.rand(0.42, 0.66);
        const a = night ? C.rand(0.45, 0.70) : C.rand(0.50, 0.92);
        const col = night ? '166,162,198' : '255,253,246';
        const drawEllipseGrad = (cx, cy, r, stops) => {
          g.save();
          g.translate(x, y);
          g.scale(1, ry / rx);
          const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r);
          for (const st of stops) grd.addColorStop(st[0], st[1]);
          g.fillStyle = grd;
          g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
          g.restore();
        };
        // 云体
        drawEllipseGrad(0, 0, rx, [
          [0, 'rgba(' + col + ',' + a.toFixed(2) + ')'],
          [0.55, 'rgba(' + col + ',' + (a * 0.70).toFixed(2) + ')'],
          [0.85, 'rgba(' + col + ',' + (a * 0.24).toFixed(2) + ')'],
          [1, 'rgba(' + col + ',0)'],
        ]);
        // 云底冷色阴影（只在本团下半部，向外渐隐）
        if (night) {
          drawEllipseGrad(0, ry * 0.30, rx * 0.92, [
            [0, 'rgba(58,52,80,' + (0.35 * a).toFixed(2) + ')'],
            [0.6, 'rgba(58,52,80,' + (0.14 * a).toFixed(2) + ')'],
            [1, 'rgba(58,52,80,0)'],
          ]);
        } else {
          drawEllipseGrad(0, ry * 0.30, rx * 0.92, [
            [0, warm ? 'rgba(150,126,168,' + (0.30 * a).toFixed(2) + ')' : 'rgba(172,168,192,' + (0.20 * a).toFixed(2) + ')'],
            [0.6, warm ? 'rgba(150,126,168,' + (0.10 * a).toFixed(2) + ')' : 'rgba(172,168,192,' + (0.07 * a).toFixed(2) + ')'],
            [1, 'rgba(172,168,192,0)'],
          ]);
        }
        // 底部羽化加强：更透明的一圈紫灰渐变，让云底融进天空
        drawEllipseGrad(0, ry * 0.46, rx * 1.06, [
          [0, night ? 'rgba(78,72,104,' + (0.22 * a).toFixed(2) + ')' : 'rgba(164,156,186,' + (0.16 * a).toFixed(2) + ')'],
          [0.55, night ? 'rgba(78,72,104,' + (0.08 * a).toFixed(2) + ')' : 'rgba(164,156,186,' + (0.05 * a).toFixed(2) + ')'],
          [1, 'rgba(164,156,186,0)'],
        ]);
        // 受光高光（左上，呼应黄昏太阳方向）
        if (!night) {
          drawEllipseGrad(-rx * 0.24, -ry * 0.22, rx * 0.5, [
            [0, 'rgba(255,255,252,' + (0.34 * a).toFixed(2) + ')'],
            [1, 'rgba(255,255,252,0)'],
          ]);
        }
        // 黄昏金边
        if (warm) {
          drawEllipseGrad(-rx * 0.18, -ry * 0.10, rx * 0.66, [
            [0, 'rgba(255,202,132,' + (0.30 * a).toFixed(2) + ')'],
            [0.7, 'rgba(255,202,132,' + (0.08 * a).toFixed(2) + ')'],
            [1, 'rgba(255,202,132,0)'],
          ]);
        }
      }
    }, { srgb: true });
  }

  function buildPaintedClouds(world, skyRoot) {
    const tex = [0, 1, 2].map(paintCloudTexture);
    const mats = tex.map((t, i) => new THREE.SpriteMaterial({
      map: t, transparent: true, depthWrite: false,
      opacity: i === 2 ? 0.85 : 0.95,
    }));
    const group = new THREE.Group();
    group.name = 'shinkaiPaintedClouds';
    const sprites = [];
    const bands = [
      { n: 9, z0: 1500, z1: 2150, y0: 260, y1: 420, w0: 180, w1: 320 },
      { n: 8, z0: -2400, z1: -1750, y0: 320, y1: 520, w0: 160, w1: 280 },
    ];
    for (const band of bands) {
      for (let ci = 0; ci < band.n; ci++) {
        const W = C.rand(band.w0, band.w1);
        const s = new THREE.Sprite(mats[1]);
        s.scale.set(W, W * 0.5, 1);
        s.position.set(C.rand(-1700, 1700), C.rand(band.y0, band.y1), C.rand(band.z0, band.z1));
        s.userData.baseX = s.position.x;
        s.renderOrder = 3;
        group.add(s);
        sprites.push(s);
        markDraw(s);
      }
    }
    skyRoot.add(group);
    S.cloudSprites = sprites;
    S.cloudMats = mats;
    S.cloudGroup = group;
    S.cloudKind = -1;
    return { meshes: sprites, count: sprites.length, drawCalls: sprites.length };
  }

  function buildClouds(world, skyRoot) {
    // 当前使用手绘软边云；下面的旧伪体积 shader 实现停用保留（不可达）
    return buildPaintedClouds(world, skyRoot);

    const built = buildCloudGeometry();

    // 云噪纹理：软团状灰度噪声，片元里采样以打破球面光滑感、增加蓬松细节
    const noiseTex = C.makeCanvas(128, 128, (g, w, h) => {
      g.fillStyle = '#000000';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {
        const x = C.rand(0, w);
        const y = C.rand(0, h);
        const r = C.rand(3, 16);
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        const a = 0.25 + C.rand(0, 0.5);
        grd.addColorStop(0, 'rgba(255,255,255,' + a.toFixed(2) + ')');
        grd.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, w, h);
      }
    }, { srgb: false, repeat: [1, 1] });

    const mat = new THREE.ShaderMaterial({
      fog: false,
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide,
      uniforms: {
        uDrift: { value: 0 },
        uSunDir: { value: sunDirForHour(world.hour != null ? world.hour : 17.5) },
        uNight: { value: 0 },
        uDusk: { value: 0 },
        uGrey: { value: 0 },
        uTop: { value: new THREE.Color(0xfff3e2) },
        uBot: { value: new THREE.Color(0xbcb6d4) },
        uRim: { value: new THREE.Color(0xffc987) },
        uNoiseTex: { value: noiseTex },
      },
      vertexShader: `
        attribute float aBaseX;
        uniform float uDrift;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vWorld;
        void main() {
          float base = mod(aBaseX + uDrift + 1600.0, 3200.0) - 1600.0;
          vec3 wp = position;
          wp.x = base + (position.x - aBaseX);
          vNormal = normal; // 几何已烘焙为世界空间，mesh 恒等变换
          vViewDir = cameraPosition - wp;
          vWorld = wp;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(wp, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uSunDir;
        uniform float uNight;
        uniform float uDusk;
        uniform float uGrey;
        uniform vec3 uTop;
        uniform vec3 uBot;
        uniform vec3 uRim;
        uniform sampler2D uNoiseTex;
        varying vec3 vNormal;
        varying vec3 vViewDir;
        varying vec3 vWorld;
        void main() {
          vec3 n = normalize(vNormal);
          // 双层法线扰动：中频打破球面块面感，低频保持大体积起伏
          n += vec3(
            sin(vWorld.x * 0.13 + vWorld.y * 0.07) * 0.07
            + sin(vWorld.x * 0.031 + vWorld.z * 0.027) * 0.05,
            sin(vWorld.y * 0.11 + vWorld.z * 0.09) * 0.06
            + sin(vWorld.y * 0.029 + vWorld.x * 0.023) * 0.04,
            cos(vWorld.z * 0.12 + vWorld.x * 0.08) * 0.07
            + cos(vWorld.z * 0.033 + vWorld.y * 0.031) * 0.05
          );
          n = normalize(n);
          // 云噪纹理：进一步打散球面平滑渐变，增加蓬松细节
          float nz = texture2D(uNoiseTex, vWorld.xz * 0.014 + vec2(vWorld.y * 0.006, 0.0)).r;
          n += vec3(nz - 0.5) * 0.10;
          n = normalize(n);
          vec3 sunDir = normalize(uSunDir);
          float up = clamp(n.y * 0.5 + 0.5, 0.0, 1.0);
          vec3 base = mix(uBot, uTop, smoothstep(0.15, 0.80, up));
          float sunF = max(dot(n, sunDir), 0.0);
          float sunShade = pow(sunF, 0.85);
          base += uTop * sunShade * 0.15;
          float horizon = pow(clamp(1.0 - abs(n.y), 0.0, 1.0), 2.4);
          float rim = horizon * pow(sunF, 1.5);
          base += uRim * rim * uDusk * 0.80;
          base += vec3(0.055, 0.065, 0.095) * (1.0 - sunShade) * 0.40;
          vec3 col = base;
          col *= 0.90 + nz * 0.20; // 噪点明暗，避免大面积纯色
          col = mix(col, vec3(0.30, 0.27, 0.36), uNight * 0.85);
          col *= (1.0 - uNight * 0.42);
          col = mix(col, vec3(0.55, 0.56, 0.60), uGrey * 0.55);
          // 柔和肩部压缩，避免受光面纯白过曝
          float luma = max(col.r, max(col.g, col.b));
          col = col / (1.0 + luma * 0.18);
          // 视向法线衰减 + 宽 smootherstep：让轮廓从核心到边缘柔和消隐。
          // depthWrite=false，边缘低 alpha 时内层 puff 透出，形成软体积边。
          float ndv = abs(dot(n, normalize(vViewDir)));
          float alpha = smoothstep(0.03, 0.95, ndv);
          alpha = pow(alpha, 0.75);
          // 噪声侵蚀轮廓：让球体边缘碎成蓬松絮状，而不是完整圆弧
          float edgeNoise = texture2D(uNoiseTex, vWorld.xz * 0.021 + vec2(vWorld.y * 0.011, 0.0)).r;
          alpha *= 0.55 + edgeNoise * 0.75;
          alpha *= 0.92;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    const mesh = new THREE.Mesh(built.geo, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 3;
    const group = new THREE.Group();
    group.name = 'shinkaiCumulus';
    group.add(mesh);
    skyRoot.add(group);
    markDraw(mesh);

    S.cloudMat = mat;
    S.cloudMesh = mesh;
    return {
      meshes: [mesh],
      count: built.cloudCount,
      vertexCount: built.vertexCount,
      puffCount: built.puffCount,
    };
  }

  function updateClouds(world, dt, night) {
    S.cloudDrift += dt * 0.4; // 0.4 m/s 东漂
    if (S.cloudDrift > 3200) S.cloudDrift -= 3200;
    if (S.cloudDrift < -3200) S.cloudDrift += 3200;
    // 手绘精灵云：按时段切换贴图（白天/黄昏金边/夜），缓慢东漂
    if (S.cloudSprites && S.cloudSprites.length) {
      const h = (world && world.hour != null) ? world.hour : 17.5;
      let kind = 0;
      if (h >= 18.5 || h <= 6) kind = 2;
      else if ((h >= 16 && h <= 19.5) || h <= 7.5) kind = 1;
      if (kind !== S.cloudKind && S.cloudMats) {
        for (const s of S.cloudSprites) s.material = S.cloudMats[kind];
        S.cloudKind = kind;
      }
      const grey = (world && world.weatherAmt != null && world.weather !== 0) ? world.weatherAmt : 0;
      for (const s of S.cloudSprites) {
        const wx = s.userData.baseX + S.cloudDrift;
        s.position.x = ((wx + 1600) % 3200 + 3200) % 3200 - 1600;
        if (grey > 0.01) s.material.opacity = (kind === 2 ? 0.85 : 0.95) * (1 - grey * 0.45);
      }
      return;
    }
    if (!S.cloudMat) return;
    const n = Math.max(0, Math.min(1, night || 0));
    const h = (world && world.hour != null) ? world.hour : 17.5;
    S.cloudMat.uniforms.uDrift.value = S.cloudDrift;
    S.cloudMat.uniforms.uNight.value = n;
    S.cloudMat.uniforms.uSunDir.value.copy(sunDirForHour(h, S.sunTmp));
    // 与 world.updateSky 相同的黄昏/黎明判断，驱动金色轮廓
    const dusk = Math.max(0, Math.min(1, 1 - Math.abs(h - 18.8) / 1.6));
    const dawn = Math.max(0, Math.min(1, 1 - Math.abs(h - 6.3) / 1.6));
    S.cloudMat.uniforms.uDusk.value = Math.max(dusk, dawn);
    // 可选：雨/雪/雾天气向灰白收敛
    const grey = (world && world.weatherAmt != null && world.weather !== 0) ? world.weatherAmt : 0;
    S.cloudMat.uniforms.uGrey.value = grey;
  }

  // ============================================================
  //  2. 丁达尔光束：additive 长梯形面片，合并为 1 个 draw call
  // ============================================================
  function buildRayGeometry(top, bot, topHalf, botHalf) {
    const dir = new THREE.Vector3().subVectors(bot, top).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();

    const v0 = top.clone().add(right.clone().multiplyScalar(topHalf));
    const v1 = top.clone().sub(right.clone().multiplyScalar(topHalf));
    const v2 = bot.clone().sub(right.clone().multiplyScalar(botHalf));
    const v3 = bot.clone().add(right.clone().multiplyScalar(botHalf));

    const n = new THREE.Vector3().crossVectors(dir, right).normalize();
    const pos = new Float32Array([
      v0.x, v0.y, v0.z,
      v1.x, v1.y, v1.z,
      v2.x, v2.y, v2.z,
      v3.x, v3.y, v3.z,
    ]);
    const nor = new Float32Array(12);
    for (let i = 0; i < 4; i++) {
      nor[i * 3] = n.x; nor[i * 3 + 1] = n.y; nor[i * 3 + 2] = n.z;
    }
    const uv = new Float32Array([
      1, 0,
      0, 0,
      0, 1,
      1, 1,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.computeBoundingSphere();
    return geo;
  }

  function buildRays(world, skyRoot) {
    const rayTex = C.makeCanvas(128, 256, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      // 纵向 α：0.0 → 0.35 → 0，边缘更软
      const vg = g.createLinearGradient(0, 0, 0, h);
      vg.addColorStop(0, 'rgba(255,246,214,0)');
      vg.addColorStop(0.45, 'rgba(255,240,200,0.35)');
      vg.addColorStop(0.78, 'rgba(255,232,180,0.16)');
      vg.addColorStop(1, 'rgba(255,222,160,0)');
      g.fillStyle = vg;
      g.fillRect(0, 0, w, h);
      g.globalCompositeOperation = 'destination-in';
      const hg = g.createLinearGradient(0, 0, w, 0);
      hg.addColorStop(0, 'rgba(0,0,0,0)');
      hg.addColorStop(0.3, 'rgba(0,0,0,1)');
      hg.addColorStop(0.7, 'rgba(0,0,0,1)');
      hg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = hg;
      g.fillRect(0, 0, w, h);
    }, { srgb: false });

    const material = new THREE.MeshBasicMaterial({
      color: 0xfff2cc,
      map: rayTex,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
    });

    const sunDir = sunDirForHour(world.hour != null ? world.hour : 17.5);
    const defs = [];
    // 数量降到 6：CBD 上空 3 道 + 老城上空 3 道
    for (let i = 0; i < 3; i++) {
      defs.push({ x: C.rand(-650, 650), z: C.rand(420, 1000), hLo: C.rand(110, 160) });
    }
    for (let i = 0; i < 3; i++) {
      defs.push({ x: C.rand(-820, 80), z: C.rand(-950, -350), hLo: C.rand(70, 120) });
    }

    const rayMeshes = [];
    for (const d of defs) {
      const ground = world.terrainHeight(d.x, d.z);
      // 加宽、加长：长度 240-420m，底部半宽 60-110m，顶部半宽 10-20m
      const lenH = C.rand(240, 420);
      const top = new THREE.Vector3(
        d.x + sunDir.x * lenH,
        ground + d.hLo + lenH * C.rand(0.72, 0.92),
        d.z + sunDir.z * lenH
      );
      const bot = new THREE.Vector3(d.x, ground + d.hLo, d.z);
      const geo = buildRayGeometry(top, bot, C.rand(10, 20), C.rand(60, 110));
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      rayMeshes.push(mesh);
    }

    const merged = C.mergeByMaterial(rayMeshes, skyRoot);
    for (const m of merged) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.frustumCulled = false;
      m.renderOrder = 4;
      markDraw(m);
    }
    return { material, meshes: merged, count: defs.length };
  }

  function updateRays(dt, night) {
    if (!S.rays || !S.rays.material) return;
    const mat = S.rays.material;
    const n = Math.max(0, Math.min(1, night));
    // 日间 ≤0.14，黄昏峰值 0.22；night>0.55 逐渐隐去
    const dusk = Math.max(0, 1 - Math.abs(n - 0.28) / 0.22);
    let target = 0.14 + 0.08 * dusk;
    if (n > 0.55) target *= Math.max(0, 1 - (n - 0.55) / 0.30);
    mat.opacity += (target - mat.opacity) * 0.12;
  }

  // ============================================================
  //  3. 北部远山（96 段山脊 + 竖向渐变贴图）+ 南部海平线双层
  // ============================================================
  // makeRidgeGeometry(seed, segments, baseY)：
  //   baseY(x, i) -> { y: 山脚地形高, peak: 该层山高 }
  //   沿 x 方向生成连续山脊（两层正弦 + 确定性噪声），UV 竖向
  //   映射到渐变贴图（山脚雾紫灰透明 → 山腰青灰 → 山顶淡青/雪线）。
  function makeRidgeGeometry(seed, segments, baseY) {
    const x0 = -1850, x1 = 1850;
    const raw = [];
    for (let i = 0; i <= segments; i++) raw.push(C.rand(-1, 1));
    // 两次三点平滑：去掉逐段随机产生的锯齿，让山脊线是连续曲线
    const noise = raw.slice();
    for (let pass = 0; pass < 2; pass++) {
      const prev = noise.slice();
      for (let i = 0; i <= segments; i++) {
        const a = prev[Math.max(0, i - 1)];
        const b = prev[i];
        const c = prev[Math.min(segments, i + 1)];
        noise[i] = (a + b * 2 + c) * 0.25;
      }
    }
    const pos = [];
    const uvs = [];
    const idx = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = x0 + (x1 - x0) * t;
      const b = baseY(x, i);
      const ground = b.y;
      const peak = b.peak;
      const wave1 = Math.sin(x * 0.0021 + seed * 1.7) * 0.55 + Math.sin(x * 0.0053 + seed * 2.3) * 0.30;
      const wave2 = Math.sin(x * 0.0011 + seed * 3.1) * 0.22;
      const hNorm = Math.max(0, Math.min(1, 0.50 + wave1 * 0.38 + noise[i] * 0.10 + wave2));
      const top = ground + hNorm * peak;
      pos.push(x, top, 0); // 局部 z=0，由 mesh.position.z 放置
      pos.push(x, ground, 0);
      uvs.push(t, 0); // 山脊 v=0（贴图顶部雪线）
      uvs.push(t, 1); // 山脚 v=1（贴图底部雾紫灰透明）
      if (i < segments) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }

  function makeMountainTexture(seed) {
    return C.makeCanvas(256, 256, (g, w, h) => {
      // 竖向渐变：山脚雾紫灰（透明）→ 山腰青灰 → 山顶淡青/雪线
      const grad = g.createLinearGradient(0, h, 0, 0);
      grad.addColorStop(0.00, 'rgba(158,148,174,0)');
      grad.addColorStop(0.18, 'rgba(158,148,174,0.90)');
      grad.addColorStop(0.45, 'rgba(108,126,142,0.96)');
      grad.addColorStop(0.75, 'rgba(168,196,208,0.98)');
      grad.addColorStop(1.00, 'rgba(214,228,238,1)');
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      // 朝向城市一侧的暖色晨昏光边：沿山脊顶部一条很淡的暖色渐变
      const rim = g.createLinearGradient(0, 0, 0, h * 0.22);
      rim.addColorStop(0, 'rgba(255,196,138,0.38)');
      rim.addColorStop(0.5, 'rgba(255,186,126,0.12)');
      rim.addColorStop(1, 'rgba(255,186,126,0)');
      g.fillStyle = rim;
      g.fillRect(0, 0, w, h * 0.22);
      C.grain(g, w, h, 0.05, 360);
    }, { srgb: true });
  }

  function buildMountains(world, skyRoot) {
    // 由近到远：z=1600 最近最高 400m，z=2300 最远最矮 180m
    const layers = [
      { z: 1600, peak: 400, opacity: 0.90 },
      { z: 1800, peak: 320, opacity: 0.85 },
      { z: 2050, peak: 250, opacity: 0.70 },
      { z: 2300, peak: 180, opacity: 0.55 },
    ];
    const group = new THREE.Group();
    group.name = 'northMountains';
    const mats = [];
    const meshes = [];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      const tex = makeMountainTexture(li * 11 + 3);
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        color: 0xffffff,
        transparent: true,
        opacity: L.opacity,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      mats.push({ mat, baseColor: 0xffffff, baseOpacity: L.opacity });
      // 前层山脊 + 稍大深色垫底山脊（同材质合并为 1 个 draw call，增加厚度）
      const frontGeo = makeRidgeGeometry(li * 11 + 3, 96, (x, i) => ({
        y: world.terrainHeight(x, L.z),
        peak: L.peak,
      }));
      const backGeo = makeRidgeGeometry(li * 11 + 9, 96, (x, i) => ({
        y: world.terrainHeight(x, L.z),
        peak: L.peak * 1.10,
      }));
      const frontMesh = new THREE.Mesh(frontGeo, mat);
      frontMesh.position.z = L.z;
      const backMesh = new THREE.Mesh(backGeo, mat);
      backMesh.position.z = L.z + 42;
      const merged = C.mergeByMaterial([frontMesh, backMesh], group);
      for (const m of merged) {
        m.castShadow = false;
        m.receiveShadow = false;
        m.renderOrder = 2;
        meshes.push(m);
        markDraw(m);
      }
      frontGeo.dispose();
      backGeo.dispose();
    }
    skyRoot.add(group);
    return { mats, meshes, layers: layers.length };
  }

  function updateMountains(night) {
    if (!S.mountainMats) return;
    const n = Math.max(0, Math.min(1, night));
    for (const item of S.mountainMats) {
      item.mat.color.setHex(C.lerpColor(0xffffff, 0x6a6a80, n * 0.55));
      item.mat.opacity = item.baseOpacity * (1 - n * 0.35);
    }
  }

  function buildSeaBand(world, skyRoot) {
    // 远处 0.4m 高青白发光细带
    const bandMat = new THREE.MeshBasicMaterial({
      color: 0xa8f0e8,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const bandMesh = new THREE.Mesh(new THREE.PlaneGeometry(3600, 0.4), bandMat);
    bandMesh.position.set(0, CFG_waterLevel + 0.5, -2300);
    bandMesh.rotation.x = -Math.PI / 2;
    bandMesh.castShadow = false;
    bandMesh.receiveShadow = false;
    bandMesh.renderOrder = 2;
    skyRoot.add(bandMesh);
    markDraw(bandMesh);

    // 海天交界雾带：8 条低透明度水平雾带，合并为 1 个 draw call
    const fogMat = new THREE.MeshBasicMaterial({
      color: 0xd9d4ee,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const strips = [];
    const stripCount = 8;
    for (let i = 0; i < stripCount; i++) {
      const width = C.rand(400, 900);
      const depth = C.rand(4, 10);
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, depth), fogMat);
      mesh.position.set(C.rand(-1600, 1600), CFG_waterLevel + 0.3, -2300 + C.rand(-14, 14));
      mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      strips.push(mesh);
    }
    const fogMerged = C.mergeByMaterial(strips, skyRoot);
    for (const m of fogMerged) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 2;
      markDraw(m);
    }
    const fogMats = [{ material: fogMat, baseOpacity: 0.12 }];
    return { bandMat, bandMesh, fogMats, fogMeshes: fogMerged };
  }

  function updateSeaBand(world, night) {
    if (!S.seaBand) return;
    const n = Math.max(0, Math.min(1, night || 0));
    const h = (world && world.hour != null) ? world.hour : 17.5;
    const dusk = Math.max(0, Math.min(1, 1 - Math.abs(h - 18.8) / 1.6));
    const dawn = Math.max(0, Math.min(1, 1 - Math.abs(h - 6.3) / 1.6));
    const duskF = Math.max(dusk, dawn);
    // 海平线细带：白天青白，黄昏增亮，夜晚月光银
    S.seaBand.bandMat.color.setHex(C.lerpColor(0xa8f0e8, 0xd6e2ff, n * 0.9));
    S.seaBand.bandMat.opacity = 0.28 + duskF * 0.22 + n * 0.15;
    // 雾带：夜晚稍亮一点
    if (S.seaBand.fogMats) {
      for (const item of S.seaBand.fogMats) {
        item.material.opacity = item.baseOpacity * (1 + n * 0.4);
      }
    }
  }

  // ============================================================
  //  4. 轻量异象彩蛋
  // ============================================================
  function buildMidas(world, skyRoot) {
    const lm = (C.landmarks && C.landmarks.midas) || null;
    const x = lm && lm.x != null ? lm.x : -180;
    const z = lm && lm.z != null ? lm.z : 720;
    const topY = lm && lm.topY != null ? lm.topY : world.terrainHeight(x, z) + 168;

    const group = new THREE.Group();
    group.name = 'midasAnomaly';

    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x3a0a10,
      emissive: 0xff2a3c,
      emissiveIntensity: 0.5,
      roughness: 0.4,
      metalness: 0.1,
      transparent: true,
      opacity: 0.85,
      fog: false,
    });
    // 留一个小缺口的环，让水平自转可见
    const ring = new THREE.Mesh(new THREE.TorusGeometry(10, 0.55, 8, 48, Math.PI * 1.85), ringMat);
    ring.position.set(x, topY, z);
    ring.rotation.x = -Math.PI / 2;
    ring.castShadow = false;
    ring.receiveShadow = false;

    const glowMat = new THREE.MeshBasicMaterial({
      color: 0xff7a8e,
      transparent: true,
      opacity: 0.35,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    const glow = new THREE.Mesh(new THREE.SphereGeometry(2.6, 12, 10), glowMat);
    glow.position.set(x, topY, z);
    glow.castShadow = false;
    glow.receiveShadow = false;

    group.add(ring);
    group.add(glow);
    skyRoot.add(group);
    markDraw(ring);
    markDraw(glow);
    return { ring, ringMat, glow, glowMat };
  }

  function updateMidas(dt, night) {
    if (!S.midas) return;
    const n = Math.max(0, Math.min(1, night));
    const breathe = 0.80 + 0.20 * Math.sin(S.time * 1.7);
    const glowBreathe = 0.80 + 0.20 * Math.sin(S.time * 2.1);
    S.midas.ring.rotation.y += dt * 0.30; // 缓慢自转
    S.midas.ringMat.emissiveIntensity = (0.50 + n * 0.30) * breathe; // 夜间约 1.6 倍，不过曝
    S.midas.ringMat.opacity = Math.min(0.95, 0.72 + n * 0.12 + 0.10 * Math.sin(S.time * 2.3));
    S.midas.glowMat.opacity = (0.25 + n * 0.15) * glowBreathe; // 夜间约 1.6 倍
  }

  function buildMotes(world, skyRoot) {
    const count = 120;
    const posArr = new Float32Array(count * 3);
    const base = [];
    for (let i = 0; i < count; i++) {
      const x = C.rand(-1250, 1250);
      const z = C.rand(-1100, 1250);
      const y = world.terrainHeight(x, z) + 60 + C.rand(0, 100);
      posArr[i * 3] = x;
      posArr[i * 3 + 1] = y;
      posArr[i * 3 + 2] = z;
      base.push({ x, y, z, ph: i * 2.17 });
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));

    const tex = C.makeCanvas(64, 64, (g, w, h) => {
      const gr = g.createRadialGradient(w / 2, h / 2, 1, w / 2, h / 2, w / 2);
      gr.addColorStop(0, 'rgba(255,255,255,0.90)');
      gr.addColorStop(0.4, 'rgba(170,255,246,0.45)');
      gr.addColorStop(1, 'rgba(120,240,232,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, w, h);
    }, { srgb: false });

    const material = new THREE.PointsMaterial({
      color: 0x7ff0e8,
      size: 3, // 2-4 区间
      map: tex,
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
      fog: false,
    });
    const points = new THREE.Points(geo, material);
    points.frustumCulled = false;
    points.renderOrder = 5;
    skyRoot.add(points);
    markDraw(points);
    return { points, material, base, count };
  }

  function updateMotes(dt, night) {
    if (!S.motes) return;
    S.moteTime += dt;
    const pos = S.motes.points.geometry.attributes.position;
    const base = S.motes.base;
    for (let i = 0; i < base.length; i++) {
      const b = base[i];
      const lift = (S.moteTime * 1.4 + i * 37) % 100; // 缓慢上浮，到顶回卷
      pos.setX(i, b.x + Math.sin(S.moteTime * 0.35 + b.ph) * 6);
      pos.setY(i, b.y + lift * 0.9);
      pos.setZ(i, b.z + Math.cos(S.moteTime * 0.28 + b.ph) * 6);
    }
    pos.needsUpdate = true;
    const n = Math.max(0, Math.min(1, night));
    S.motes.material.opacity = 0.45 * (1 + n * 0.6); // 夜间约 1.6 倍
  }

  function buildAnomalyPanels(world, skyRoot) {
    const crackTex = C.makeCanvas(128, 192, (g, w, h) => {
      g.fillStyle = '#07030c';
      g.fillRect(0, 0, w, h);
      // 边缘光晕
      const eg = g.createRadialGradient(w / 2, h / 2, 8, w / 2, h / 2, Math.max(w, h) * 0.7);
      eg.addColorStop(0, 'rgba(110,60,200,0.16)');
      eg.addColorStop(0.55, 'rgba(80,40,170,0.10)');
      eg.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = eg;
      g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(140,80,255,0.35)';
      g.lineWidth = 8;
      g.strokeRect(6, 6, w - 12, h - 12);
      g.strokeStyle = 'rgba(190,130,255,0.80)';
      g.lineWidth = 3;
      g.strokeRect(2, 2, w - 4, h - 4);
      // 紫色裂纹
      for (let i = 0; i < 16; i++) {
        let x = C.rand(8, w - 8);
        let y = C.rand(8, h - 8);
        const alpha = 0.55 + C.rand(0, 0.30);
        g.strokeStyle = 'rgba(' + (175 + Math.floor(C.rand(0, 60))) + ',120,255,' + alpha.toFixed(2) + ')';
        g.lineWidth = 1 + C.rand(0, 2);
        g.beginPath();
        g.moveTo(x, y);
        const segs = 3 + Math.floor(C.rand(0, 4));
        for (let j = 0; j < segs; j++) {
          x += C.rand(-22, 22);
          y += C.rand(-22, 22);
          g.lineTo(x, y);
        }
        g.stroke();
      }
      // 裂纹亮芯
      for (let i = 0; i < 6; i++) {
        let x = C.rand(10, w - 10);
        let y = C.rand(10, h - 10);
        g.strokeStyle = 'rgba(235,210,255,0.8)';
        g.lineWidth = 0.8;
        g.beginPath();
        g.moveTo(x, y);
        for (let j = 0; j < 3; j++) {
          x += C.rand(-14, 14);
          y += C.rand(-14, 14);
          g.lineTo(x, y);
        }
        g.stroke();
      }
    }, { srgb: true });

    const material = new THREE.MeshBasicMaterial({
      color: 0x8a4aff,
      map: crackTex,
      transparent: true,
      opacity: 0.40,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    const defs = [
      [-500, -600, -0.5],
      [-200, -800, 0.35],
      [700, -500, -0.25],
      [1000, -300, 0.5],
    ];
    const panels = [];
    for (const d of defs) {
      const x = d[0], z = d[1];
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 1.2), material);
      mesh.position.set(x, world.terrainHeight(x, z) + 1.5, z);
      mesh.rotation.y = d[2];
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      panels.push(mesh);
    }
    const merged = C.mergeByMaterial(panels, skyRoot);
    for (const m of merged) {
      m.castShadow = false;
      m.receiveShadow = false;
      m.renderOrder = 5;
      markDraw(m);
    }
    return { material, meshes: merged, count: defs.length };
  }

  function updatePanels(night) {
    if (!S.panels) return;
    const n = Math.max(0, Math.min(1, night));
    S.panels.material.opacity = 0.40 * (1 + n * 0.6); // 夜间更明显但不过曝
  }

  function buildSeaAnomaly(world, skyRoot) {
    const material = new THREE.MeshBasicMaterial({
      color: 0x8f74ff,
      transparent: true,
      opacity: 0.08,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(240, 14, 5, 48, Math.PI * 1.85), material);
    ring.scale.set(1, 0.06, 1); // 超扁平，贴在天际线附近
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, CFG_waterLevel + 0.8, -2300);
    ring.castShadow = false;
    ring.receiveShadow = false;
    ring.renderOrder = 3;
    skyRoot.add(ring);
    markDraw(ring);
    return { material, mesh: ring };
  }

  function updateSeaAnomaly(dt, night) {
    if (!S.seaAnomaly) return;
    const n = Math.max(0, Math.min(1, night));
    S.seaAnomaly.material.opacity = 0.07 + n * 0.03; // 0.06-0.10 区间
    S.seaAnomaly.material.color.setHex(C.lerpColor(0x8f74ff, 0x74d8ff, n * 0.5));
    S.seaAnomaly.mesh.rotation.y += dt * 0.05;
    S.seaAnomaly.mesh.rotation.x = -Math.PI / 2 + Math.sin(S.time * 0.04) * 0.05;
  }

  // ============================================================
  //  统一更新钩子
  // ============================================================
  function updateAll(world, night) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let dt = S.lastTime ? (now - S.lastTime) / 1000 : 0;
    if (!(dt > 0 && dt < 0.1)) dt = 0.016; // 首帧/后台切回用固定步长兜底
    S.lastTime = now;
    S.time += dt;

    const n = Math.max(0, Math.min(1, night || 0));
    updateClouds(world, dt, n);
    updateRays(dt, n);
    updateMountains(n);
    updateSeaBand(world, n);
    updateMidas(dt, n);
    updateMotes(dt, n);
    updatePanels(n);
    updateSeaAnomaly(dt, n);
  }

  // ============================================================
  //  构建阶段
  // ============================================================
  C.stages.push({
    name: 'citySky',
    fn(world) {
      S.drawItems.length = 0;
      const root = ensureCityRoot(world);
      const skyRoot = new THREE.Group();
      skyRoot.name = 'citySky';
      root.add(skyRoot);

      const clouds = buildClouds(world, skyRoot);
      const rays = buildRays(world, skyRoot);
      const mountains = buildMountains(world, skyRoot);
      const seaBand = buildSeaBand(world, skyRoot);
      const midas = buildMidas(world, skyRoot);
      const motes = buildMotes(world, skyRoot);
      const panels = buildAnomalyPanels(world, skyRoot);
      const seaAnomaly = buildSeaAnomaly(world, skyRoot);

      S.clouds = clouds;
      S.rays = rays;
      S.mountainMats = mountains.mats;
      S.seaBand = seaBand;
      S.midas = midas;
      S.motes = motes;
      S.panels = panels;
      S.seaAnomaly = seaAnomaly;

      // 注册唯一的 update 钩子（CITY.updateNight 会每帧调用 updateFns）
      C.registerUpdate(updateAll);

      // 立即套用一次昼夜状态，让初始 opacity/颜色与当前 world.hour 对齐。
      // 这里直接按 city_core 的同一公式计算 night，避免在构建期触发其它模块的 updateFns。
      const h = world.hour != null ? world.hour : 12;
      let initialNight = 0;
      if (h >= 18) initialNight = Math.min(1, (h - 18) / 2);
      else if (h <= 7) initialNight = Math.min(1, (7 - h) / 2);
      S.lastTime = 0;
      updateAll(world, initialNight);
      // updateAll 内部会推进 lastTime，这里重设避免首帧 dt 跳变
      S.lastTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

      return {
        clouds: clouds.count,
        rays: rays.count,
        mountains: mountains.layers,
        motes: motes.count,
        anomalies: 4, // 迈达斯环 / 青粒 / 紫纹面板 / 远海异象
        drawCalls: S.drawItems.length,
      };
    },
  });
})();
