(() => {
  'use strict';

  const CITY = window.CITY;
  if (!CITY) {
    console.warn('[city_props] window.CITY 不存在，已跳过注册');
    return;
  }

  const CITY_ROAD_IDS = [
    'cross', 'northsouth', 'ring', 'coast',
    'old1', 'old2', 'old3',
    'mix1', 'mix2',
    'cbd1', 'cbd2', 'cbd3', 'cbd4',
    'culture1', 'culture2', 'culture3',
    'seaside1', 'seaside2',
  ];
  const MAIN_ROAD_IDS = ['cross', 'northsouth', 'northblvd', 'southblvd', 'westave', 'eastave', 'ring', 'coast'];
  const BILLBOARD_TEXTS = ['海特洛市', '绘空町', '七海百货', '迈达斯科技', '未闻浦水族馆'];
  const BILLBOARD_COLORS = [0x35e8ff, 0xff3ec8, 0xffc21a, 0x4d7bff, 0xff7a3c];
  const BIKE_COLORS = [0xc94f42, 0x3e8a86, 0xd9903f, 0x4a6b8a, 0x6b8a4a];

  // ---------- 通用小工具 ----------
  function routeById(world, id) {
    return (world.trafficRoutes || []).find(r => r.id === id) || null;
  }

  function allCityRoutes(world) {
    return (world.trafficRoutes || []).filter(r => CITY_ROAD_IDS.indexOf(r.id) >= 0);
  }

  function groundY(world, x, z, fallback) {
    if (world && typeof world.terrainHeight === 'function') {
      try { return world.terrainHeight(x, z); } catch (e) { /* 回退 */ }
    }
    return fallback != null ? fallback : 0;
  }

  function addCollider(world, x, z, r, type) {
    if (!world) return;
    if (typeof CITY.addCollider === 'function') {
      CITY.addCollider(world, x, z, r, type);
    } else if (world.colliders) {
      world.colliders.push({ x, z, r, type });
    }
  }

  function getCityRoot(world) {
    if (!world.cityRoot) {
      const g = new THREE.Group();
      g.name = 'cityRoot';
      world.scene.add(g);
      world.cityRoot = g;
    }
    return world.cityRoot;
  }

  function tangentAt(route, i) {
    const arr = route.samples;
    if (!arr || !arr.length) return { tx: 1, tz: 0, nx: 0, nz: 1 };
    const a = arr[i] || arr[0];
    let b;
    if (route.closed) b = arr[(i + 1) % arr.length];
    else b = arr[Math.min(i + 1, arr.length - 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    if (dx === 0 && dz === 0) {
      const c = arr[Math.max(0, i - 1)];
      dx = a.x - c.x; dz = a.z - c.z;
    }
    const len = Math.hypot(dx, dz) || 1;
    return { tx: dx / len, tz: dz / len, nx: -dz / len, nz: dx / len };
  }

  function routeLength(route) {
    if (route.length != null) return route.length;
    return route.samples && route.samples.length ? route.samples[route.samples.length - 1].d : 0;
  }

  // local +X 朝向 (dx,dz)
  function yawXToDir(dx, dz) { return Math.atan2(-dz, dx); }
  // local +Z 朝向 (dx,dz)
  function yawZToDir(dx, dz) { return Math.atan2(dx, dz); }

  function rotOffset(yaw, ox, oz) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    return { x: c * ox + s * oz, z: -s * ox + c * oz };
  }

  function addPart(arr, geo, mat, origin, yaw, ox, oy, oz) {
    const r = rotOffset(yaw, ox, oz);
    const m = new THREE.Mesh(geo, mat);
    m.position.set(origin.x + r.x, origin.y + oy, origin.z + r.z);
    m.rotation.y = yaw;
    m.castShadow = true;
    m.receiveShadow = true;
    arr.push(m);
    return m;
  }

  function addInstanced(root, geo, mat, items) {
    if (!geo || !items || !items.length) return null;
    const mesh = new THREE.InstancedMesh(geo, mat, items.length);
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      p.set(it.x, it.y, it.z);
      e.set(0, it.yaw || 0, 0);
      q.setFromEuler(e);
      s.set(it.sx || 1, it.sy || 1, it.sz || 1);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.cityProps = true;
    root.add(mesh);
    return mesh;
  }

  function mergeParts(parts, root, kind) {
    if (!parts.length) return 0;
    const out = CITY.mergeByMaterial(parts, root);
    let n = 0;
    for (const m of out) {
      m.userData.cityProps = true;
      m.userData.kind = kind || 'cityProp';
      n++;
    }
    return n;
  }

  function bakeGeometry(parts) {
    if (!parts.length) return null;
    const out = CITY.mergeByMaterial(parts);
    return out && out.length ? out[0].geometry : null;
  }

  function meshAt(geo, mat, x, y, z) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    return m;
  }

  function inReserved(x, z, pad) {
    if (typeof CITY.inReserved === 'function') return CITY.inReserved(x, z, pad);
    return null;
  }

  function validSpot(world, x, z, r) {
    if (typeof CITY.propSpot === 'function') return CITY.propSpot(world, x, z, r);
    if (inReserved(x, z, r + 1.5)) return false;
    if (!world.nearestRoad) return true;
    const nr = world.nearestRoad(x, z);
    if (!nr) return false;
    return nr.d >= nr.s.w / 2 + 0.9 + r;
  }

  function isTooClose(items, x, z, min) {
    for (const it of items) {
      if (Math.hypot(it.x - x, it.z - z) < min) return true;
    }
    return false;
  }

  function nearOtherRoad(x, z, excludeId, routes, threshold) {
    const t2 = threshold * threshold;
    for (const r of routes) {
      if (r.id === excludeId) continue;
      const arr = r.samples;
      for (let i = 0; i < arr.length; i += 4) {
        const s = arr[i];
        const dx = s.x - x;
        const dz = s.z - z;
        if (dx * dx + dz * dz < t2) return true;
      }
    }
    return false;
  }

  // ---------- 路口计算 ----------
  function routeBounds(route) {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const s of route.samples) {
      if (s.x < x0) x0 = s.x; if (s.x > x1) x1 = s.x;
      if (s.z < z0) z0 = s.z; if (s.z > z1) z1 = s.z;
    }
    return { x0, x1, z0, z1 };
  }

  function boundsOverlap(a, b, margin) {
    return a.x0 - margin <= b.x1 && a.x1 + margin >= b.x0 &&
           a.z0 - margin <= b.z1 && a.z1 + margin >= b.z0;
  }

  function findIntersection(A, B, maxD) {
    const a = A.samples, b = B.samples;
    if (!a.length || !b.length) return null;
    const stepA = a.length > 2400 ? 6 : (a.length > 1200 ? 4 : 2);
    const stepB = b.length > 2400 ? 6 : (b.length > 1200 ? 4 : 2);
    const maxD2 = maxD * maxD;
    let best = maxD2, bi = -1, bj = -1;
    for (let i = 0; i < a.length; i += stepA) {
      const sx = a[i].x, sz = a[i].z;
      for (let j = 0; j < b.length; j += stepB) {
        const dx = b[j].x - sx, dz = b[j].z - sz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bi = i; bj = j; }
      }
    }
    if (bi < 0) return null;
    const li = Math.max(0, bi - stepA), hi = Math.min(a.length - 1, bi + stepA);
    const lj = Math.max(0, bj - stepB), hj = Math.min(b.length - 1, bj + stepB);
    best = maxD2;
    let ri = bi, rj = bj;
    for (let i = li; i <= hi; i++) {
      const sx = a[i].x, sz = a[i].z;
      for (let j = lj; j <= hj; j++) {
        const dx = b[j].x - sx, dz = b[j].z - sz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; ri = i; rj = j; }
      }
    }
    if (best >= maxD2) return null;
    return {
      routeA: A, routeB: B, ia: ri, ib: rj,
      x: (a[ri].x + b[rj].x) / 2,
      z: (a[ri].z + b[rj].z) / 2,
    };
  }

  function collectIntersections(routes) {
    const bounds = routes.map(routeBounds);
    const out = [];
    for (let i = 0; i < routes.length; i++) {
      for (let j = i + 1; j < routes.length; j++) {
        if (!boundsOverlap(bounds[i], bounds[j], 12)) continue;
        const inter = findIntersection(routes[i], routes[j], 10);
        if (inter) out.push(inter);
      }
    }
    return out;
  }

  function cornerPositions(inter, offA, offB) {
    const da = tangentAt(inter.routeA, inter.ia);
    const db = tangentAt(inter.routeB, inter.ib);
    const out = [];
    for (const sa of [-1, 1]) {
      for (const sb of [-1, 1]) {
        out.push({
          x: inter.x + da.nx * sa * offA + db.nx * sb * offB,
          z: inter.z + da.nz * sa * offA + db.nz * sb * offB,
        });
      }
    }
    return out;
  }

  // ============================================================
  //  1. 路灯
  // ============================================================
  function buildLampPoleGeometry(style) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const parts = [];
    if (style === 'retro') {
      parts.push(meshAt(new THREE.CylinderGeometry(0.09, 0.15, 0.28, 10), mat, 0, 0.14, 0));
      parts.push(meshAt(new THREE.CylinderGeometry(0.05, 0.08, 5.6, 8), mat, 0, 2.9, 0));
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0, 5.6, 0),
        new THREE.Vector3(0.38, 5.64, 0),
        new THREE.Vector3(0.8, 5.48, 0),
        new THREE.Vector3(1.2, 5.15, 0),
      ]);
      parts.push(new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.035, 6, false), mat));
      parts.push(meshAt(new THREE.CylinderGeometry(0.055, 0.06, 0.14, 8), mat, 0, 5.62, 0));
    } else if (style === 'modern') {
      parts.push(meshAt(new THREE.CylinderGeometry(0.1, 0.18, 0.3, 10), mat, 0, 0.15, 0));
      parts.push(meshAt(new THREE.CylinderGeometry(0.04, 0.07, 6.2, 8), mat, 0, 3.25, 0));
      parts.push(meshAt(new THREE.BoxGeometry(0.85, 0.06, 0.06), mat, 0.42, 6.2, 0));
    } else {
      parts.push(meshAt(new THREE.CylinderGeometry(0.12, 0.2, 0.34, 10), mat, 0, 0.17, 0));
      parts.push(meshAt(new THREE.CylinderGeometry(0.05, 0.08, 5.6, 8), mat, 0, 2.95, 0));
      parts.push(meshAt(new THREE.BoxGeometry(0.65, 0.07, 0.05), mat, 0.32, 5.7, 0));
    }
    return bakeGeometry(parts);
  }

  function buildLampHeadGeometry(style) {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const parts = [];
    if (style === 'retro') {
      parts.push(meshAt(new THREE.SphereGeometry(0.17, 10, 8), mat, 1.2, 5.15, 0));
    } else if (style === 'modern') {
      parts.push(meshAt(new THREE.BoxGeometry(0.55, 0.09, 0.16), mat, 0.85, 6.2, 0));
    } else {
      parts.push(meshAt(new THREE.CylinderGeometry(0.12, 0.12, 0.26, 10), mat, 0.7, 5.7, 0));
    }
    return bakeGeometry(parts);
  }

  function lampPoleMaterial(style) {
    if (style === 'retro') return new THREE.MeshStandardMaterial({ color: 0x2e2a26, metalness: 0.8, roughness: 0.4 });
    if (style === 'seaside') return new THREE.MeshStandardMaterial({ color: 0xf2efe6, metalness: 0.55, roughness: 0.45 });
    return new THREE.MeshStandardMaterial({ color: 0x454b54, metalness: 0.85, roughness: 0.35 });
  }

  function lampHeadMaterial(style) {
    if (style === 'retro') return new THREE.MeshStandardMaterial({ color: 0xfff3d6, emissive: 0xffc46a, emissiveIntensity: 0.1 });
    if (style === 'seaside') return new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff0c0, emissiveIntensity: 0.1 });
    return new THREE.MeshStandardMaterial({ color: 0xe8f0fa, emissive: 0xa8c8ff, emissiveIntensity: 0.1 });
  }

  function buildStreetLamps(world, root, cityRoutes) {
    if (!world.lamps) world.lamps = [];
    if (!world.lampPoints) world.lampPoints = [];
    if (CITY.lampSpots) CITY.lampSpots.length = 0; else CITY.lampSpots = [];
    const poleItems = { retro: [], modern: [], seaside: [] };
    const headItems = { retro: [], modern: [], seaside: [] };
    const glowPositions = [];
    const headY = { retro: 5.15, modern: 6.2, seaside: 5.7 };
    let total = 0;

    const lampRoutes = cityRoutes.filter(r => r.samples.length && r.samples[0].w >= 8);
    for (const route of lampRoutes) {
      const arr = route.samples;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d - lastD < 30) continue;
        if (route.closed && i === arr.length - 1) continue;
        if (!route.closed && (s.d < 15 || len - s.d < 15)) continue;
        lastD = s.d;
        side = -side;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 1.2;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (inReserved(x, z, 2.5)) continue;
        const y = groundY(world, x, z, s.h);
        const zone = typeof CITY.zoneAt === 'function' ? CITY.zoneAt(x, z) : null;
        const style = (zone === 'old' || zone === 'culture') ? 'retro' : (zone === 'seaside' ? 'seaside' : 'modern');
        const yaw = yawXToDir(dir.nx * side, dir.nz * side);
        poleItems[style].push({ x, y, z, yaw });
        headItems[style].push({ x, y, z, yaw });
        world.lampPoints.push({ x, y: y + (headY[style] || 6), z });
        glowPositions.push(x, y + (headY[style] || 6), z);
        CITY.lampSpots.push({ x, z });
        addCollider(world, x, z, 0.3, 'lamp');
        total++;
      }
    }

    let drawCalls = 0;
    for (const style of ['retro', 'modern', 'seaside']) {
      if (!poleItems[style].length) continue;
      const poleGeo = buildLampPoleGeometry(style);
      const poleMat = lampPoleMaterial(style);
      const pm = addInstanced(root, poleGeo, poleMat, poleItems[style]);
      if (pm) drawCalls++;
      const headGeo = buildLampHeadGeometry(style);
      const headMat = lampHeadMaterial(style);
      const hm = addInstanced(root, headGeo, headMat, headItems[style]);
      if (hm) {
        drawCalls++;
        world.lamps.push(hm);
        CITY.registerNight(headMat);
      }
    }
    // 软光晕：全部灯头合为一个 Points（1 draw call），夜晚由 world.updateSky 统一渐亮
    if (glowPositions.length) {
      const glowTex = CITY.makeCanvas(128, 128, (g, w, h) => {
        const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        grd.addColorStop(0, 'rgba(255,214,150,0.75)');
        grd.addColorStop(0.25, 'rgba(255,200,130,0.30)');
        grd.addColorStop(0.6, 'rgba(255,190,120,0.08)');
        grd.addColorStop(1, 'rgba(255,190,120,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, w, h);
      }, { srgb: false });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3));
      const pm = new THREE.Points(geo, new THREE.PointsMaterial({
        map: glowTex, size: 2.8, sizeAttenuation: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0,
      }));
      pm.renderOrder = 6;
      root.add(pm);
      if (!world.lampGlows) world.lampGlows = [];
      world.lampGlows.push(pm);
      drawCalls++;
    }
    return {
      total,
      retro: poleItems.retro.length,
      modern: poleItems.modern.length,
      seaside: poleItems.seaside.length,
      drawCalls,
      lampPointsAdded: total,
      lampSpots: CITY.lampSpots.length,
    };
  }

  // ============================================================
  //  2. 护栏
  // ============================================================
  function buildRailingMetalGeometry() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const parts = [];
    const L = 6;
    const postGeo = new THREE.BoxGeometry(0.07, 0.95, 0.07);
    const railGeo = new THREE.BoxGeometry(L, 0.06, 0.05);
    for (const x of [-L / 2, 0, L / 2]) parts.push(meshAt(postGeo, mat, x, 0.475, 0));
    parts.push(meshAt(railGeo, mat, 0, 0.85, 0));
    parts.push(meshAt(railGeo, mat, 0, 0.5, 0));
    return bakeGeometry(parts);
  }

  function buildRailings(world, root, cityRoutes) {
    const items = [];
    const glassItems = [];
    if (CITY.fenceSpots) CITY.fenceSpots.length = 0; else CITY.fenceSpots = [];
    for (const id of ['cross', 'northsouth', 'ring']) {
      const route = routeById(world, id);
      if (!route || !route.samples.length) continue;
      const arr = route.samples;
      const len = routeLength(route);
      let nextD = 3;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d < nextD) continue;
        nextD += 6;
        if (route.closed && i === arr.length - 1) continue;
        if (!route.closed && (s.d < 10 || len - s.d < 10)) continue;
        if (nearOtherRoad(s.x, s.z, id, cityRoutes, 7)) continue;
        const dir = tangentAt(route, i);
        const zone = typeof CITY.zoneAt === 'function' ? CITY.zoneAt(s.x, s.z) : null;
        const sw = (CITY.pal[zone] && CITY.pal[zone].sidewalk) || 4;
        const off = s.w / 2 + sw + 0.25;
        for (const side of [-1, 1]) {
          const x = s.x + dir.nx * side * off;
          const z = s.z + dir.nz * side * off;
          if (inReserved(x, z, 4)) continue;
          const y = groundY(world, x, z, s.h);
          const yaw = yawXToDir(dir.tx, dir.tz);
          items.push({ x, y, z, yaw });
          // 护栏占位采样：约每 3m 一个，供行道树避让（树木阶段在 props 之后执行）
          for (const along of [-3, 0, 3]) {
            CITY.fenceSpots.push({ x: x + dir.tx * along, z: z + dir.tz * along });
          }
          if (zone === 'cbd') glassItems.push({ x, y, z, yaw });
        }
      }
    }
    let drawCalls = 0;
    if (items.length) {
      const geo = buildRailingMetalGeometry();
      const mat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, metalness: 0.85, roughness: 0.35 });
      const m = addInstanced(root, geo, mat, items);
      if (m) drawCalls++;
    }
    if (glassItems.length) {
      const geo = new THREE.BoxGeometry(5.6, 0.7, 0.03);
      const mat = new THREE.MeshStandardMaterial({ color: 0x9fd0e8, transparent: true, opacity: 0.4, metalness: 0.1, roughness: 0.2, side: THREE.DoubleSide });
      const m = addInstanced(root, geo, mat, glassItems);
      if (m) drawCalls++;
    }
    return { segments: items.length, glassSegments: glassItems.length, drawCalls, fenceSpots: CITY.fenceSpots.length };
  }

  // ============================================================
  //  3. 红绿灯
  // ============================================================
  function buildTrafficLightPrototype() {
    const grayMat = new THREE.MeshStandardMaterial({ color: 0x6d747e, metalness: 0.7, roughness: 0.4 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0x2b0a0a, emissive: 0xff2222, emissiveIntensity: 0.12 });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x0a2b10, emissive: 0x22ee66, emissiveIntensity: 0.12 });
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
      return m;
    };
    add(new THREE.CylinderGeometry(0.08, 0.13, 3.6, 10), grayMat, 0, 1.8, 0);
    add(new THREE.BoxGeometry(1.9, 0.13, 0.12), grayMat, 0.95, 3.4, 0);
    add(new THREE.BoxGeometry(0.38, 0.95, 0.3), grayMat, 1.84, 3.4, 0);
    add(new THREE.BoxGeometry(0.22, 0.2, 0.06), grayMat, 1.84, 3.4, 0.17);
    add(new THREE.BoxGeometry(0.22, 0.2, 0.06), redMat, 1.84, 3.67, 0.17);
    add(new THREE.BoxGeometry(0.22, 0.2, 0.06), greenMat, 1.84, 3.13, 0.17);
    g.userData.redMat = redMat;
    g.userData.greenMat = greenMat;
    return g;
  }

  function buildTrafficLights(world, root, cityRoutes, intersections) {
    const crossRoute = routeById(world, 'cross');
    const nsRoute = routeById(world, 'northsouth');
    const ringRoute = routeById(world, 'ring');
    if (!crossRoute || !nsRoute || !ringRoute) return { signals: 0, drawCalls: 0 };

    const items = [];
    function addSignalCorners(inter, offA, offB, maxN) {
      if (!inter) return;
      const corners = cornerPositions(inter, offA, offB);
      let placed = 0;
      for (const c of corners) {
        if (placed >= maxN) break;
        if (!validSpot(world, c.x, c.z, 0.4)) continue;
        const y = groundY(world, c.x, c.z, inter.routeA.samples[inter.ia].h);
        items.push({ x: c.x, y, z: c.z, yaw: yawXToDir(inter.x - c.x, inter.z - c.z) });
        placed++;
      }
    }

    const main = intersections.find(int =>
      (int.routeA.id === 'cross' && int.routeB.id === 'northsouth') ||
      (int.routeA.id === 'northsouth' && int.routeB.id === 'cross'));
    if (main) addSignalCorners(main, crossRoute.samples[0].w / 2 + 2.8, nsRoute.samples[0].w / 2 + 2.8, 4);

    const ringList = intersections.filter(int =>
      (int.routeA.id === 'ring' && (int.routeB.id === 'cross' || int.routeB.id === 'northsouth')) ||
      (int.routeB.id === 'ring' && (int.routeA.id === 'cross' || int.routeA.id === 'northsouth')));
    ringList.forEach((inter, idx) => {
      const other = inter.routeA.id === 'ring' ? inter.routeB : inter.routeA;
      const offOther = other.samples[0].w / 2 + 2.8;
      addSignalCorners(inter, ringRoute.samples[0].w / 2 + 2.8, offOther, idx === 0 ? 2 : 1);
    });

    if (!items.length) return { signals: 0, drawCalls: 0 };

    const proto = buildTrafficLightPrototype();
    const merged = CITY.mergeByMaterial(proto.children);
    let drawCalls = 0;
    for (const m of merged) {
      const inst = addInstanced(root, m.geometry, m.material, items);
      if (inst) drawCalls++;
    }
    CITY.registerNight(proto.userData.redMat);
    CITY.registerNight(proto.userData.greenMat);
    for (const it of items) addCollider(world, it.x, it.z, 0.35, 'trafficLight');
    return { signals: items.length, drawCalls };
  }

  // ============================================================
  //  4. 长椅
  // ============================================================
  function buildBenches(world, root, cityRoutes) {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x8a6848, roughness: 0.7, metalness: 0.05 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x3a3f45, metalness: 0.75, roughness: 0.4 });
    const seatGeo = new THREE.BoxGeometry(2.0, 0.07, 0.65);
    const backGeo = new THREE.BoxGeometry(2.0, 0.45, 0.07);
    const legGeo = new THREE.BoxGeometry(0.08, 0.42, 0.5);
    const armGeo = new THREE.BoxGeometry(0.08, 0.12, 0.55);
    const parts = [];
    let count = 0;

    for (const route of cityRoutes) {
      const arr = route.samples;
      if (!arr.length) continue;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d - lastD < 150) continue;
        lastD = s.d;
        side = -side;
        const zone = typeof CITY.zoneAt === 'function' ? CITY.zoneAt(s.x, s.z) : null;
        if (zone !== 'old' && zone !== 'culture' && zone !== 'seaside') continue;
        if (!route.closed && (s.d < 12 || len - s.d < 12)) continue;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 1.8;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.8)) continue;
        const y = groundY(world, x, z, s.h);
        const yaw = yawZToDir(-dir.nx * side, -dir.nz * side);
        const origin = { x, y, z };
        addPart(parts, seatGeo, woodMat, origin, yaw, 0, 0.46, 0);
        addPart(parts, backGeo, woodMat, origin, yaw, 0, 0.78, -0.30);
        addPart(parts, legGeo, metalMat, origin, yaw, -0.8, 0.22, 0);
        addPart(parts, legGeo, metalMat, origin, yaw, 0.8, 0.22, 0);
        addPart(parts, armGeo, woodMat, origin, yaw, -1.0, 0.62, 0);
        addPart(parts, armGeo, woodMat, origin, yaw, 1.0, 0.62, 0);
        addCollider(world, x, z, 0.7, 'bench');
        count++;
      }
    }
    const drawCalls = mergeParts(parts, root, 'bench');
    return { count, drawCalls };
  }

  // ============================================================
  //  5. 分类垃圾桶
  // ============================================================
  function buildTrashBins(world, root, cityRoutes) {
    const blueMat = new THREE.MeshStandardMaterial({ color: 0x3a7bd5, roughness: 0.5, metalness: 0.3 });
    const greenMat = new THREE.MeshStandardMaterial({ color: 0x3f8f5f, roughness: 0.5, metalness: 0.3 });
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, metalness: 0.85, roughness: 0.35 });
    const bodyGeo = new THREE.BoxGeometry(0.45, 0.85, 0.4);
    const lidGeo = new THREE.BoxGeometry(0.5, 0.08, 0.45);
    const parts = [];
    let pairs = 0;

    for (const id of MAIN_ROAD_IDS) {
      const route = routeById(world, id);
      if (!route || !route.samples.length) continue;
      const arr = route.samples;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d - lastD < 80) continue;
        lastD = s.d;
        side = -side;
        if (route.closed && i === arr.length - 1) continue;
        if (!route.closed && (s.d < 12 || len - s.d < 12)) continue;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 1.6;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.4)) continue;
        const y = groundY(world, x, z, s.h);
        const yaw = yawXToDir(dir.tx, dir.tz);
        const origin = { x, y, z };
        addPart(parts, bodyGeo, blueMat, origin, yaw, -0.35, 0.45, 0);
        addPart(parts, lidGeo, steelMat, origin, yaw, -0.35, 0.9, 0);
        addPart(parts, bodyGeo, greenMat, origin, yaw, 0.35, 0.45, 0);
        addPart(parts, lidGeo, steelMat, origin, yaw, 0.35, 0.9, 0);
        const r1 = rotOffset(yaw, -0.35, 0);
        const r2 = rotOffset(yaw, 0.35, 0);
        addCollider(world, x + r1.x, z + r1.z, 0.35, 'bin');
        addCollider(world, x + r2.x, z + r2.z, 0.35, 'bin');
        pairs++;
      }
    }
    const drawCalls = mergeParts(parts, root, 'bin');
    return { pairs, bins: pairs * 2, drawCalls };
  }

  // ============================================================
  //  6. 自动售货机
  // ============================================================
  function makeVendingPanelTexture() {
    return CITY.makeCanvas(256, 256, (g, W, H) => {
      g.fillStyle = '#0e1622';
      g.fillRect(0, 0, W, H);
      const col = '#4dd8ff';
      g.shadowColor = col;
      g.shadowBlur = 18;
      g.strokeStyle = col;
      g.lineWidth = 6;
      g.strokeRect(14, 14, W - 28, H - 28);
      g.fillStyle = '#e8f7ff';
      g.shadowBlur = 22;
      g.font = 'bold 38px "Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('自动售卖机', W / 2, H / 2 - 20);
      g.font = 'bold 26px "Segoe UI",sans-serif';
      g.fillStyle = '#9fe8ff';
      g.shadowBlur = 12;
      g.fillText('DRINKS', W / 2, H / 2 + 46);
    }, { srgb: true });
  }

  function buildVendingMachines(world, root, cityRoutes, intersections) {
    const candidates = [];
    const desired = 16;
    const zoneOK = z => z === 'old' || z === 'mix' || z === 'culture';

    for (const inter of intersections) {
      if (!zoneOK(CITY.zoneAt(inter.x, inter.z))) continue;
      const offA = inter.routeA.samples[0].w / 2 + 3.2;
      const offB = inter.routeB.samples[0].w / 2 + 3.2;
      const corners = cornerPositions(inter, offA, offB);
      for (const c of corners) {
        if (!zoneOK(CITY.zoneAt(c.x, c.z))) continue;
        if (!validSpot(world, c.x, c.z, 0.5)) continue;
        if (isTooClose(candidates, c.x, c.z, 18)) continue;
        candidates.push({ x: c.x, z: c.z, faceX: inter.x, faceZ: inter.z });
      }
    }

    if (candidates.length < 12) {
      for (const route of cityRoutes) {
        const arr = route.samples;
        if (!arr.length) continue;
        let lastD = -999;
        let side = 1;
        for (let i = 0; i < arr.length && candidates.length < desired; i++) {
          const s = arr[i];
          if (s.d - lastD < 150) continue;
          lastD = s.d;
          side = -side;
          if (route.closed && i === arr.length - 1) continue;
          if (!zoneOK(CITY.zoneAt(s.x, s.z))) continue;
          const dir = tangentAt(route, i);
          const off = s.w / 2 + 2.8;
          const x = s.x + dir.nx * side * off;
          const z = s.z + dir.nz * side * off;
          if (!validSpot(world, x, z, 0.5)) continue;
          if (isTooClose(candidates, x, z, 18)) continue;
          candidates.push({ x, z, faceX: s.x, faceZ: s.z });
        }
      }
    }

    const list = candidates.slice(0, desired);
    if (!list.length) return { count: 0, drawCalls: 0 };

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2f5b8f, roughness: 0.45, metalness: 0.4 });
    const panelTex = makeVendingPanelTexture();
    const panelMat = new THREE.MeshStandardMaterial({
      map: panelTex,
      emissive: 0xffffff,
      emissiveMap: panelTex,
      emissiveIntensity: 0.2,
      roughness: 0.5,
      metalness: 0.1,
    });
    CITY.registerNight(panelMat);
    const bodyGeo = new THREE.BoxGeometry(0.95, 1.8, 0.8);
    const panelGeo = new THREE.BoxGeometry(0.85, 1.1, 0.06);
    const parts = [];

    for (const c of list) {
      const y = groundY(world, c.x, c.z, 0);
      const yaw = yawZToDir(c.faceX - c.x, c.faceZ - c.z);
      const origin = { x: c.x, y, z: c.z };
      addPart(parts, bodyGeo, bodyMat, origin, yaw, 0, 0.9, 0);
      addPart(parts, panelGeo, panelMat, origin, yaw, 0, 1.05, 0.41);
      addCollider(world, c.x, c.z, 0.45, 'vending');
    }
    const drawCalls = mergeParts(parts, root, 'vending');
    return { count: list.length, drawCalls };
  }

  // ============================================================
  //  7. 公交站牌
  // ============================================================
  function buildBusStops(world, root, cityRoutes) {
    const signTex = CITY.makeSign('海特洛巴士', { w: 256, h: 96, bg: '#2b6cb0', fg: '#ffffff', border: '#ffffff' });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x8a929c, metalness: 0.8, roughness: 0.35 });
    const canopyMat = new THREE.MeshStandardMaterial({ color: 0xbfe0f0, transparent: true, opacity: 0.6, roughness: 0.3, metalness: 0.1 });
    const signMat = new THREE.MeshStandardMaterial({ map: signTex, roughness: 0.55 });
    const postGeo = new THREE.CylinderGeometry(0.045, 0.06, 2.7, 8);
    const canopyGeo = new THREE.BoxGeometry(3.4, 0.08, 1.3);
    const signGeo = new THREE.BoxGeometry(1.0, 0.6, 0.04);
    const parts = [];
    let count = 0;

    for (const id of ['cross', 'northsouth']) {
      const route = routeById(world, id);
      if (!route || !route.samples.length) continue;
      const arr = route.samples;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d - lastD < 300) continue;
        lastD = s.d;
        side = -side;
        if (!route.closed && (s.d < 20 || len - s.d < 20)) continue;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 4.0;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.5)) continue;
        const y = groundY(world, x, z, s.h);
        const yaw = yawZToDir(-dir.nx * side, -dir.nz * side);
        const origin = { x, y, z };
        addPart(parts, postGeo, metalMat, origin, yaw, -1.2, 1.35, 0);
        addPart(parts, postGeo, metalMat, origin, yaw, 1.2, 1.35, 0);
        addPart(parts, canopyGeo, canopyMat, origin, yaw, 0, 2.65, 0);
        addPart(parts, signGeo, signMat, origin, yaw, 0, 1.5, 0);
        addCollider(world, x, z, 0.5, 'busStop');
        count++;
      }
    }
    const drawCalls = mergeParts(parts, root, 'busStop');
    return { count, drawCalls };
  }

  // ============================================================
  //  8. 红色邮筒
  // ============================================================
  function buildPostboxes(world, root, cityRoutes) {
    const redMat = new THREE.MeshStandardMaterial({ color: 0xc82a2a, roughness: 0.4, metalness: 0.3 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1e1f22, metalness: 0.5, roughness: 0.6 });
    const bodyGeo = new THREE.CylinderGeometry(0.26, 0.3, 1.1, 12);
    const capGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.12, 12);
    const slotGeo = new THREE.BoxGeometry(0.1, 0.03, 0.03);
    const parts = [];
    const list = [];

    for (const id of ['old1', 'old2', 'old3']) {
      const route = routeById(world, id);
      if (!route || !route.samples.length) continue;
      const arr = route.samples;
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length && list.length < 6; i++) {
        const s = arr[i];
        if (s.d - lastD < 180) continue;
        lastD = s.d;
        side = -side;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 1.8;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.35)) continue;
        const y = groundY(world, x, z, s.h);
        const yaw = yawZToDir(-dir.nx * side, -dir.nz * side);
        list.push({ x, y, z, yaw });
      }
    }

    for (const it of list) {
      const origin = { x: it.x, y: it.y, z: it.z };
      addPart(parts, bodyGeo, redMat, origin, it.yaw, 0, 0.55, 0);
      addPart(parts, capGeo, redMat, origin, it.yaw, 0, 1.12, 0);
      addPart(parts, slotGeo, darkMat, origin, it.yaw, 0, 1.05, 0.27);
      addCollider(world, it.x, it.z, 0.35, 'postbox');
    }
    const drawCalls = mergeParts(parts, root, 'postbox');
    return { count: list.length, drawCalls };
  }

  // ============================================================
  //  9. 自行车停放点
  // ============================================================
  function buildBikeFrameGeometry() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const parts = [];
    const add = (w, h, d, x, y, z, rx, ry, rz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      if (rx) m.rotation.x = rx;
      if (ry) m.rotation.y = ry;
      if (rz) m.rotation.z = rz;
      parts.push(m);
    };
    add(0.62, 0.05, 0.05, 0.12, 0.82, 0);
    add(0.55, 0.05, 0.05, 0.12, 0.52, 0);
    add(0.05, 0.65, 0.05, -0.18, 0.5, 0);
    add(0.05, 0.4, 0.05, 0.42, 0.66, 0);
    add(0.05, 0.45, 0.05, 0.42, 0.3, 0);
    add(0.28, 0.06, 0.14, -0.18, 0.97, 0);
    add(0.42, 0.045, 0.045, 0.46, 0.92, 0);
    add(0.16, 0.06, 0.12, 0.02, 0.32, 0);
    return bakeGeometry(parts);
  }

  function buildBicycles(world, root, cityRoutes) {
    const frameItems = new Map();
    const wheelItems = [];
    let stands = 0;
    let bikes = 0;

    for (const id of MAIN_ROAD_IDS) {
      const route = routeById(world, id);
      if (!route || !route.samples.length) continue;
      const arr = route.samples;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d - lastD < 120) continue;
        lastD = s.d;
        side = -side;
        if (route.closed && i === arr.length - 1) continue;
        if (!route.closed && (s.d < 12 || len - s.d < 12)) continue;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 2.0;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.8)) continue;
        const y = groundY(world, x, z, s.h);
        const yaw = yawXToDir(dir.tx, dir.tz);
        const n = 3 + Math.floor(CITY.rand(0, 3));
        for (let k = 0; k < n; k++) {
          const lx = -0.9 + k * 0.6;
          const rr = rotOffset(yaw, lx, 0);
          const bx = x + rr.x;
          const bz = z + rr.z;
          const col = BIKE_COLORS[(stands + k) % BIKE_COLORS.length];
          if (!frameItems.has(col)) frameItems.set(col, []);
          frameItems.get(col).push({ x: bx, y, z: bz, yaw });
          for (const wx of [-0.25, 0.45]) {
            const ww = rotOffset(yaw, lx + wx, 0);
            wheelItems.push({ x: x + ww.x, y: y + 0.32, z: z + ww.z, yaw });
          }
          bikes++;
        }
        addCollider(world, x, z, 0.8, 'bikeRack');
        stands++;
      }
    }

    let drawCalls = 0;
    const frameGeo = buildBikeFrameGeometry();
    for (const [col, items] of frameItems) {
      const mat = new THREE.MeshStandardMaterial({ color: col, metalness: 0.55, roughness: 0.55 });
      const m = addInstanced(root, frameGeo, mat, items);
      if (m) drawCalls++;
    }
    if (wheelItems.length) {
      const wheelGeo = new THREE.TorusGeometry(0.32, 0.03, 6, 14);
      const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1e1f22, metalness: 0.7, roughness: 0.5 });
      const m = addInstanced(root, wheelGeo, wheelMat, wheelItems);
      if (m) drawCalls++;
    }
    return { stands, bikes, drawCalls };
  }

  // ============================================================
  //  10. 招牌广告
  // ============================================================
  function makeBillboardTexture(text, colorHex) {
    return CITY.makeCanvas(512, 256, (g, W, H) => {
      const hex = '#' + ('000000' + colorHex.toString(16)).slice(-6);
      g.fillStyle = '#0b0e14';
      g.fillRect(0, 0, W, H);
      g.shadowColor = hex;
      g.shadowBlur = 24;
      g.strokeStyle = hex;
      g.lineWidth = 6;
      g.strokeRect(12, 12, W - 24, H - 24);
      g.fillStyle = '#ffffff';
      g.shadowBlur = 28;
      g.shadowColor = hex;
      g.font = 'bold ' + (text.length <= 4 ? 96 : 72) + 'px "Microsoft YaHei",sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, W / 2, H / 2 - 18);
      g.font = 'bold 30px "Segoe UI",sans-serif';
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.shadowBlur = 14;
      g.fillText('HAITELO CITY', W / 2, H / 2 + 64);
    }, { srgb: true });
  }

  function buildBillboards(world, root, cityRoutes) {
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x3c4148, metalness: 0.8, roughness: 0.4 });
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.09, 2.6, 8);
    const legGeo = new THREE.CylinderGeometry(0.07, 0.1, 3.2, 8);
    const smallPanelGeo = new THREE.BoxGeometry(3.8, 1.7, 0.14);
    const bigPanelGeo = new THREE.BoxGeometry(6.0, 2.8, 0.18);
    const textMats = new Map();
    function matForText(idx) {
      if (!textMats.has(idx)) {
        const tex = makeBillboardTexture(BILLBOARD_TEXTS[idx], BILLBOARD_COLORS[idx]);
        const m = new THREE.MeshStandardMaterial({
          map: tex, emissive: 0xffffff, emissiveMap: tex,
          emissiveIntensity: 0.25, roughness: 0.6, metalness: 0.2,
        });
        CITY.registerNight(m);
        textMats.set(idx, m);
      }
      return textMats.get(idx);
    }

    const parts = [];
    let count = 0;
    const desired = 20;

    for (const route of cityRoutes) {
      const arr = route.samples;
      if (!arr.length) continue;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      for (let i = 0; i < arr.length && count < desired; i++) {
        const s = arr[i];
        if (s.d - lastD < 160) continue;
        lastD = s.d;
        side = -side;
        if (route.closed && i === arr.length - 1) continue;
        if (!route.closed && (s.d < 15 || len - s.d < 15)) continue;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 2.8;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.7)) continue;
        const big = (count % 3 === 0);
        if (inReserved(x, z, big ? 3.5 : 2.5)) continue;
        const y = groundY(world, x, z, s.h);
        const yaw = yawZToDir(-dir.nx * side, -dir.nz * side);
        const origin = { x, y, z };
        const textIdx = count % BILLBOARD_TEXTS.length;
        if (big) {
          addPart(parts, legGeo, metalMat, origin, yaw, -2.6, 1.6, 0);
          addPart(parts, legGeo, metalMat, origin, yaw, 2.6, 1.6, 0);
          addPart(parts, bigPanelGeo, matForText(textIdx), origin, yaw, 0, 4.4, 0);
          addCollider(world, x, z, 1.0, 'billboard');
        } else {
          addPart(parts, poleGeo, metalMat, origin, yaw, 0, 1.3, 0);
          addPart(parts, smallPanelGeo, matForText(textIdx), origin, yaw, 0, 3.45, 0);
          addCollider(world, x, z, 0.7, 'billboard');
        }
        count++;
      }
    }
    const drawCalls = mergeParts(parts, root, 'billboard');
    return { count, drawCalls };
  }

  // ============================================================
  //  11. 电线杆与电线
  // ============================================================
  function buildUtilityPoleGeometry() {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const parts = [];
    parts.push(meshAt(new THREE.CylinderGeometry(0.09, 0.14, 7.2, 8), mat, 0, 3.6, 0));
    parts.push(meshAt(new THREE.BoxGeometry(1.6, 0.1, 0.09), mat, 0, 6.8, 0));
    return bakeGeometry(parts);
  }

  function buildUtilityPoles(world, root, cityRoutes) {
    const woodMat = new THREE.MeshStandardMaterial({ color: 0x6b4f36, roughness: 0.8, metalness: 0.05 });
    const concMat = new THREE.MeshStandardMaterial({ color: 0xb9b0a0, roughness: 0.85, metalness: 0.05 });
    const poleGeo = buildUtilityPoleGeometry();
    const woodItems = [];
    const concItems = [];
    const wirePositions = [];
    let poles = 0;

    for (const id of ['old1', 'old2', 'old3', 'culture1', 'culture2', 'culture3']) {
      const route = routeById(world, id);
      if (!route || !route.samples.length) continue;
      const arr = route.samples;
      const len = routeLength(route);
      let lastD = -999;
      let side = 1;
      const routePoles = [];
      for (let i = 0; i < arr.length; i++) {
        const s = arr[i];
        if (s.d - lastD < 55) continue;
        lastD = s.d;
        side = -side;
        if (!route.closed && (s.d < 8 || len - s.d < 8)) continue;
        const dir = tangentAt(route, i);
        const off = s.w / 2 + 2.2;
        const x = s.x + dir.nx * side * off;
        const z = s.z + dir.nz * side * off;
        if (!validSpot(world, x, z, 0.4)) continue;
        if (inReserved(x, z, 3)) continue;
        const y = groundY(world, x, z, s.h);
        const zone = typeof CITY.zoneAt === 'function' ? CITY.zoneAt(x, z) : null;
        const isOld = zone === 'old' || id.indexOf('old') === 0;
        const yaw = yawXToDir(dir.nx, dir.nz);
        const item = { x, y, z, yaw };
        routePoles.push(item);
        if (isOld) woodItems.push(item);
        else concItems.push(item);
        addCollider(world, x, z, 0.35, 'utilityPole');
        poles++;
      }
      for (let k = 0; k + 1 < routePoles.length; k++) {
        const A = routePoles[k];
        const B = routePoles[k + 1];
        for (let wire = 0; wire < 3; wire++) {
          const offL = (wire - 1) * 0.5;
          const ra = rotOffset(A.yaw, offL, 0);
          const rb = rotOffset(B.yaw, offL, 0);
          const ax = A.x + ra.x, az = A.z + ra.z, ay = A.y + 6.8;
          const bx = B.x + rb.x, bz = B.z + rb.z, by = B.y + 6.8;
          for (let t = 0; t < 7; t++) {
            const u0 = t / 7;
            const u1 = (t + 1) / 7;
            const sag0 = -0.7 * 4 * u0 * (1 - u0);
            const sag1 = -0.7 * 4 * u1 * (1 - u1);
            const mix = (a, b, u) => a + (b - a) * u;
            wirePositions.push(
              mix(ax, bx, u0), mix(ay, by, u0) + sag0, mix(az, bz, u0),
              mix(ax, bx, u1), mix(ay, by, u1) + sag1, mix(az, bz, u1),
            );
          }
        }
      }
    }

    let drawCalls = 0;
    if (woodItems.length) {
      const m = addInstanced(root, poleGeo, woodMat, woodItems);
      if (m) drawCalls++;
    }
    if (concItems.length) {
      const m = addInstanced(root, poleGeo, concMat, concItems);
      if (m) drawCalls++;
    }
    if (wirePositions.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(wirePositions, 3));
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x2b2622 }));
      line.userData.cityProps = true;
      line.frustumCulled = false;
      root.add(line);
      drawCalls++;
    }
    return { poles, wood: woodItems.length, concrete: concItems.length, wireSegments: wirePositions.length / 6, drawCalls };
  }

  // ============================================================
  //  12. 消防栓
  // ============================================================
  function getHydrantPrototype() {
    if (typeof buildFireHydrant === 'function') {
      try {
        const g = buildFireHydrant({ x: 0, y: 0, z: 0, yaw: 0 });
        const merged = CITY.mergeByMaterial(g.children);
        if (merged.length >= 2) {
          const red = merged.find(m => m.material && m.material.color && m.material.color.getHex() === 0xc41e2a) || merged[0];
          const metal = merged.find(m => m !== red) || merged[1];
          return { redGeo: red.geometry, redMat: red.material, metalGeo: metal.geometry, metalMat: metal.material };
        }
      } catch (e) { /* 回退到简化款 */ }
    }
    const redMat = new THREE.MeshStandardMaterial({ color: 0xc41e2a, metalness: 0.35, roughness: 0.4 });
    const metalMat = new THREE.MeshStandardMaterial({ color: 0xb8bdc4, metalness: 0.85, roughness: 0.35 });
    const g = new THREE.Group();
    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      g.add(m);
    };
    add(new THREE.CylinderGeometry(0.14, 0.17, 0.6, 12), redMat, 0, 0.32, 0);
    add(new THREE.SphereGeometry(0.16, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), redMat, 0, 0.62, 0);
    add(new THREE.CylinderGeometry(0.18, 0.2, 0.08, 12), metalMat, 0, 0.04, 0);
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 6), metalMat, 0, 0.74, 0);
    const merged = CITY.mergeByMaterial(g.children);
    const red = merged.find(m => m.material === redMat) || merged[0];
    const metal = merged.find(m => m.material === metalMat) || merged[1];
    return { redGeo: red.geometry, redMat: red.material, metalGeo: metal.geometry, metalMat: metal.material };
  }

  function buildHydrants(world, root, cityRoutes, intersections) {
    const items = [];
    for (const inter of intersections) {
      const offA = inter.routeA.samples[0].w / 2 + 1.6;
      const offB = inter.routeB.samples[0].w / 2 + 1.6;
      const corners = cornerPositions(inter, offA, offB);
      for (const c of corners) {
        if (!validSpot(world, c.x, c.z, 0.35)) continue;
        if (isTooClose(items, c.x, c.z, 12)) continue;
        items.push({ x: c.x, y: groundY(world, c.x, c.z, inter.routeA.samples[inter.ia].h), z: c.z, yaw: CITY.rand(0, Math.PI * 2) });
      }
    }
    if (items.length < 15) {
      for (const id of MAIN_ROAD_IDS) {
        const route = routeById(world, id);
        if (!route || !route.samples.length) continue;
        const arr = route.samples;
        const len = routeLength(route);
        let lastD = -999;
        let side = 1;
        for (let i = 0; i < arr.length && items.length < 15; i++) {
          const s = arr[i];
          if (s.d - lastD < 120) continue;
          lastD = s.d;
          side = -side;
          if (route.closed && i === arr.length - 1) continue;
          if (!route.closed && (s.d < 10 || len - s.d < 10)) continue;
          const dir = tangentAt(route, i);
          const off = s.w / 2 + 1.8;
          const x = s.x + dir.nx * side * off;
          const z = s.z + dir.nz * side * off;
          if (!validSpot(world, x, z, 0.35)) continue;
          if (isTooClose(items, x, z, 12)) continue;
          items.push({ x, y: groundY(world, x, z, s.h), z, yaw: CITY.rand(0, Math.PI * 2) });
        }
      }
    }

    const list = items.slice(0, 15);
    if (!list.length) return { count: 0, drawCalls: 0 };
    const proto = getHydrantPrototype();
    let drawCalls = 0;
    const red = addInstanced(root, proto.redGeo, proto.redMat, list);
    if (red) drawCalls++;
    const metal = addInstanced(root, proto.metalGeo, proto.metalMat, list);
    if (metal) drawCalls++;
    for (const it of list) addCollider(world, it.x, it.z, 0.3, 'hydrant');
    return { count: list.length, drawCalls };
  }

  // ============================================================
  //  注册阶段
  // ============================================================
  CITY.stages.push({
    name: 'cityProps',
    fn(world) {
      const stats = { skipped: false, reason: '' };
      if (!world || !world.map || world.map.id !== 'city') {
        stats.skipped = true;
        stats.reason = '非海特洛市地图，跳过';
        return stats;
      }
      if (!world.trafficRoutes || !world.trafficRoutes.length) {
        stats.skipped = true;
        stats.reason = '路网尚未生成';
        return stats;
      }

      const root = getCityRoot(world);
      const cityRoutes = allCityRoutes(world);
      if (!cityRoutes.length) {
        stats.skipped = true;
        stats.reason = '未找到城市道路';
        return stats;
      }

      const collidersBefore = world.colliders ? world.colliders.length : 0;
      const intersections = collectIntersections(cityRoutes);

      stats.lamps = buildStreetLamps(world, root, cityRoutes);
      stats.railings = buildRailings(world, root, cityRoutes);
      stats.trafficLights = buildTrafficLights(world, root, cityRoutes, intersections);
      stats.benches = buildBenches(world, root, cityRoutes);
      stats.trashBins = buildTrashBins(world, root, cityRoutes);
      stats.vendingMachines = buildVendingMachines(world, root, cityRoutes, intersections);
      stats.busStops = buildBusStops(world, root, cityRoutes);
      stats.postboxes = buildPostboxes(world, root, cityRoutes);
      stats.bicycles = buildBicycles(world, root, cityRoutes);
      stats.billboards = buildBillboards(world, root, cityRoutes);
      stats.utilityPoles = buildUtilityPoles(world, root, cityRoutes);
      stats.hydrants = buildHydrants(world, root, cityRoutes, intersections);

      stats.collidersAdded = world.colliders.length - collidersBefore;
      stats.drawCalls =
        (stats.lamps.drawCalls || 0) +
        (stats.railings.drawCalls || 0) +
        (stats.trafficLights.drawCalls || 0) +
        (stats.benches.drawCalls || 0) +
        (stats.trashBins.drawCalls || 0) +
        (stats.vendingMachines.drawCalls || 0) +
        (stats.busStops.drawCalls || 0) +
        (stats.postboxes.drawCalls || 0) +
        (stats.bicycles.drawCalls || 0) +
        (stats.billboards.drawCalls || 0) +
        (stats.utilityPoles.drawCalls || 0) +
        (stats.hydrants.drawCalls || 0);
      stats.lampsRegistered = !!(world.lamps && world.lamps.length);
      return stats;
    },
  });
})();
