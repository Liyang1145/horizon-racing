(() => {
'use strict';

// ============================================================
//  CITY ROADS ENGINE — 海特洛市 路口系统 + 道路分级标线 + 高架桥视觉
//  ------------------------------------------------------------
//  阶段 1：cityRoadEngine    路口检测 / 路口铺装板 / 分级车道线 /
//                             停止线 / 斑马线 / 导向箭头
//  阶段 2：cityOverpassVisual 高架桥面 / 护栏 / 桥墩 / 航标灯 / 桥名牌
//
//  只通过 window.CITY 注册；不创建 Light；发光体走 emissive +
//  CITY.registerNight；所有对象挂到 world.cityRoot。
// ============================================================

const CITY = window.CITY;     // 只通过 window.CITY 注册/扩展
const TAU = Math.PI * 2;
const MARK_Y = 0.10;          // 地面标线相对道路采样高度
const MARK_THIN = 0.025;      // 普通标线厚度
const MARK_THICK = 0.04;      // 停止线/斑马线厚度

// ---------- 地图与道路分级 ----------
function getCityMapDef() {
  const maps = (typeof MAPS !== 'undefined') ? MAPS : (window.GAME && window.GAME.MAPS);
  return maps ? (maps.find(m => m.id === 'city') || null) : null;
}

function classOf(mapDef, roadId) {
  const classes = (mapDef && mapDef.cityRoadClasses) || [];
  for (const c of classes) {
    if (c.ids && c.ids.indexOf(roadId) >= 0) return c;
  }
  return { key: 'lane', ids: [], lane: 'none', center: 'none', edge: 'none', markings: false };
}

function classPriority(key) {
  if (key === 'arterial') return 3;
  if (key === 'secondary') return 2;
  return 1;
}

function plateColorForJunction(j, mapDef) {
  let best = null;
  for (const id of j.roads) {
    const c = classOf(mapDef, id);
    const p = classPriority(c.key);
    if (!best || p > best.p) best = { key: c.key, p };
  }
  if (!best) best = { key: 'secondary', p: 2 };
  if (best.key === 'arterial') return 0x2e3136;
  if (best.key === 'secondary') return 0x3a3d42;
  return 0x42454b;
}

// ---------- 小工具 ----------
function yawXAxis(dx, dz) {
  // BoxGeometry 的 X 轴（长轴）对齐到 (dx, dz)
  return Math.atan2(-dz, dx);
}

function perp(x, z) {
  return { x: -z, z: x };
}

function tangentAt(route, idx) {
  const arr = route.samples;
  const n = arr.length;
  let a, b;
  if (route.closed) {
    a = arr[(idx - 1 + n) % n];
    b = arr[(idx + 1) % n];
  } else {
    a = arr[Math.max(0, idx - 1)];
    b = arr[Math.min(n - 1, idx + 1)];
  }
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return { x: 0, z: 1 };
  return { x: dx / len, z: dz / len };
}

function disposeMeshes(meshes) {
  if (!meshes) return;
  for (const m of meshes) {
    if (m && m.geometry) m.geometry.dispose();
  }
}

// ---------- 空间哈希（路口检测用） ----------
function makeSpatialHash(samples, cell) {
  const hash = new Map();
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const cx = Math.floor(s.x / cell), cz = Math.floor(s.z / cell);
    const key = cx + ',' + cz;
    let arr = hash.get(key);
    if (!arr) { arr = []; hash.set(key, arr); }
    arr.push(i);
  }
  return hash;
}

function queryHash(hash, cell, x, z, r) {
  const out = [];
  const reach = Math.max(1, Math.ceil(r / cell));
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      const arr = hash.get((cx + dx) + ',' + (cz + dz));
      if (arr) for (const i of arr) out.push(i);
    }
  }
  return out;
}

function nearJunction(x, z, junctions) {
  for (const j of junctions) {
    const rr = j.r + 1.5;
    const dx = x - j.x, dz = z - j.z;
    if (Math.abs(dx) > rr || Math.abs(dz) > rr) continue;
    if (dx * dx + dz * dz < rr * rr) return true;
  }
  return false;
}

// ---------- 带 vertexColor 的几何合并（路口铺装板专用） ----------
function mergePlateMeshes(meshes) {
  if (!meshes.length) return null;
  const geos = [];
  for (const m of meshes) {
    m.updateMatrix();
    let g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
    g.applyMatrix4(m.matrix);
    if (!g.attributes.color) {
      const n = g.attributes.position.count;
      const colors = new Float32Array(n * 3);
      colors.fill(1);
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    geos.push(g);
  }
  let totalV = 0;
  for (const g of geos) totalV += g.attributes.position.count;
  const pos = new Float32Array(totalV * 3);
  const nrm = new Float32Array(totalV * 3);
  const uv = new Float32Array(totalV * 2);
  const col = new Float32Array(totalV * 3);
  let off = 0;
  for (const g of geos) {
    const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv, c = g.attributes.color;
    pos.set(p.array.subarray(0, p.count * 3), off * 3);
    nrm.set(n.array.subarray(0, n.count * 3), off * 3);
    uv.set(u.array.subarray(0, u.count * 2), off * 2);
    col.set(c.array.subarray(0, c.count * 3), off * 3);
    off += p.count;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.computeBoundingSphere();
  for (const g of geos) g.dispose();
  return merged;
}

// ---------- 标线 Box 生成 ----------
function pushBox(meshes, cx, cz, cy, axisX, axisZ, length, width, mat, thick) {
  const geo = new THREE.BoxGeometry(length, thick, width);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(cx, cy, cz);
  mesh.rotation.y = yawXAxis(axisX, axisZ);
  meshes.push(mesh);
}

function addSolidLine(route, offset, lineWidth, mat, meshes, junctions) {
  const arr = route.samples;
  let m = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.02) continue;
    const nx = -dz / segLen, nz = dx / segLen;
    const cx = (a.x + b.x) / 2 + nx * offset;
    const cz = (a.z + b.z) / 2 + nz * offset;
    const cy = (a.h + b.h) / 2 + MARK_Y;
    if (nearJunction(cx, cz, junctions)) continue;
    pushBox(meshes, cx, cz, cy, dx, dz, segLen, lineWidth, mat, MARK_THIN);
    m += segLen;
  }
  return m;
}

function addDashedLine(route, offset, lineWidth, mat, meshes, junctions) {
  const arr = route.samples;
  const P = 6.7, DASH = 2.2;
  let m = 0;
  for (let i = 0; i < arr.length - 1; i++) {
    const a = arr[i], b = arr[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const segLen = Math.hypot(dx, dz);
    if (segLen < 0.02) continue;
    const k0 = Math.floor(a.d / P), k1 = Math.ceil(b.d / P);
    for (let k = k0; k <= k1; k++) {
      const ds = k * P, de = ds + DASH;
      const o0 = Math.max(a.d, ds), o1 = Math.min(b.d, de);
      if (o1 - o0 < 0.03) continue;
      const t0 = (o0 - a.d) / segLen, t1 = (o1 - a.d) / segLen;
      const x0 = a.x + dx * t0, z0 = a.z + dz * t0;
      const x1 = a.x + dx * t1, z1 = a.z + dz * t1;
      const h0 = a.h + (b.h - a.h) * t0, h1 = a.h + (b.h - a.h) * t1;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      const cy = (h0 + h1) / 2 + MARK_Y;
      if (nearJunction(cx, cz, junctions)) continue;
      pushBox(meshes, cx, cz, cy, dx, dz, o1 - o0, lineWidth, mat, MARK_THIN);
      m += o1 - o0;
    }
  }
  return m;
}

// ---------- 阶段一：路口检测 ----------
function detectJunctions(world) {
  const samples = world.samples;
  if (!samples || !samples.length) return [];
  const cell = 30;
  const hash = makeSpatialHash(samples, cell);
  const clusters = [];

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const R = s.w / 2 + 8;
    const seen = new Map();
    let count = 0, maxW = s.w;
    const idxs = queryHash(hash, cell, s.x, s.z, R);
    for (const k of idxs) {
      const o = samples[k];
      const d = Math.hypot(o.x - s.x, o.z - s.z);
      if (d <= R) {
        let arr = seen.get(o.road);
        if (!arr) { arr = []; seen.set(o.road, arr); }
        arr.push({ s: o, d });
        count++;
        if (o.w > maxW) maxW = o.w;
      }
    }
    if (seen.size < 2) continue;
    let sx = 0, sz = 0, sw = 0;
    for (const arr of seen.values()) {
      for (const e of arr) {
        const w = 1 / (e.d + 1);
        sx += e.s.x * w;
        sz += e.s.z * w;
        sw += w;
      }
    }
    clusters.push({ x: sx / sw, z: sz / sw, roads: Array.from(seen.keys()), count, maxW });
  }

  // 合并 45m 内的重复簇（按采样数加权合并中心）
  clusters.sort((a, b) => b.count - a.count);
  const merged = [];
  for (const c of clusters) {
    let found = null;
    for (const m of merged) {
      if (Math.hypot(c.x - m.x, c.z - m.z) < 45) { found = m; break; }
    }
    if (!found) {
      merged.push({ x: c.x, z: c.z, roads: c.roads.slice(), count: c.count, maxW: c.maxW });
    } else {
      const w1 = found.count, w2 = c.count;
      found.x = (found.x * w1 + c.x * w2) / (w1 + w2);
      found.z = (found.z * w1 + c.z * w2) / (w1 + w2);
      for (const r of c.roads) if (found.roads.indexOf(r) < 0) found.roads.push(r);
      found.count += c.count;
      if (c.maxW > found.maxW) found.maxW = c.maxW;
    }
  }

  // 只保留中心处 nearestRoad 存在、且确实覆盖 >=2 条道路的簇
  const out = [];
  for (const c of merged) {
    if (c.roads.length < 2) continue;
    const R = Math.max(8, c.maxW / 2 + 8);
    const idxs = queryHash(hash, cell, c.x, c.z, R);
    const roadSet = new Set();
    let maxW = 0;
    for (const k of idxs) {
      const o = samples[k];
      if (Math.hypot(o.x - c.x, o.z - c.z) <= R) {
        roadSet.add(o.road);
        if (o.w > maxW) maxW = o.w;
      }
    }
    if (roadSet.size < 2) continue;
    const nr = world.nearestRoad(c.x, c.z);
    if (!nr) continue;
    if (nr.d > nr.s.w / 2 + 6) continue;
    out.push({ x: c.x, z: c.z, roads: Array.from(roadSet), r: maxW / 2 + 3 });
  }
  return out;
}

// ---------- 阶段一：路口铺装板 ----------
function buildJunctionPlates(world, junctions, parent, mapDef) {
  if (!junctions.length) return null;
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  const meshes = [];
  for (const j of junctions) {
    // 路口板 y 统一取 terrainHeight+0.075：高于路面 0.08 附近、低于标线 0.10，
    // 既避免被路面盖住，也不会浮起；外缘再加一圈深灰收边改善硬切。
    const y = world.terrainHeight(j.x, j.z) + 0.075;
    const geo = new THREE.CircleGeometry(j.r, 24);
    const count = geo.attributes.position.count;
    const colors = new Float32Array(count * 3);
    const col = new THREE.Color(plateColorForJunction(j, mapDef));
    for (let i = 0; i < count; i++) {
      colors[i * 3] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(j.x, y, j.z);
    mesh.rotation.x = -Math.PI / 2;
    meshes.push(mesh);

    // 深灰收边 ring：宽 0.25，y+0.002，与路口板同一材质合并（vertexColors）
    const ring = new THREE.RingGeometry(Math.max(0.5, j.r - 0.25), j.r, 32);
    const rc = ring.attributes.position.count;
    const ringColors = new Float32Array(rc * 3);
    const ringCol = new THREE.Color(0x2a2d31);
    for (let i = 0; i < rc; i++) {
      ringColors[i * 3] = ringCol.r;
      ringColors[i * 3 + 1] = ringCol.g;
      ringColors[i * 3 + 2] = ringCol.b;
    }
    ring.setAttribute('color', new THREE.BufferAttribute(ringColors, 3));
    const ringMesh = new THREE.Mesh(ring, mat);
    ringMesh.position.set(j.x, y + 0.002, j.z);
    ringMesh.rotation.x = -Math.PI / 2;
    meshes.push(ringMesh);
  }
  const mergedGeo = mergePlateMeshes(meshes);
  for (const m of meshes) m.geometry.dispose();
  if (!mergedGeo) return null;
  const mesh = new THREE.Mesh(mergedGeo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  parent.add(mesh);
  return mesh;
}

// ---------- 阶段一：车道标线 ----------
function buildLaneMarkings(world, junctions, mapDef, mats, yellowMeshes, whiteSolidMeshes, whiteDashedMeshes) {
  let totalM = 0;
  for (const route of world.trafficRoutes) {
    const cls = classOf(mapDef, route.id);
    if (cls.key === 'lane') continue;
    const arr = route.samples;
    if (!arr || arr.length < 2) continue;
    const w = arr[0].w;
    if (cls.key === 'arterial') {
      totalM += addSolidLine(route, -0.2, 0.12, mats.yellow, yellowMeshes, junctions);
      totalM += addSolidLine(route, 0.2, 0.12, mats.yellow, yellowMeshes, junctions);
      totalM += addDashedLine(route, -3.2, 0.14, mats.whiteDash, whiteDashedMeshes, junctions);
      totalM += addDashedLine(route, 3.2, 0.14, mats.whiteDash, whiteDashedMeshes, junctions);
      totalM += addSolidLine(route, -(w / 2 - 0.4), 0.14, mats.whiteSolid, whiteSolidMeshes, junctions);
      totalM += addSolidLine(route, w / 2 - 0.4, 0.14, mats.whiteSolid, whiteSolidMeshes, junctions);
    } else if (cls.key === 'secondary') {
      totalM += addDashedLine(route, 0, 0.14, mats.whiteDash, whiteDashedMeshes, junctions);
      if (w >= 8) {
        totalM += addSolidLine(route, -(w / 2 - 0.4), 0.14, mats.whiteSolid, whiteSolidMeshes, junctions);
        totalM += addSolidLine(route, w / 2 - 0.4, 0.14, mats.whiteSolid, whiteSolidMeshes, junctions);
      }
    }
  }
  return totalM / 1000;
}

// ---------- 阶段一：停止线 / 斑马线 / 箭头 ----------
function getApproachSamples(route, j) {
  const arr = route.samples;
  let bestI = 0, bestD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    const d = Math.hypot(arr[i].x - j.x, arr[i].z - j.z);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  const near = arr[bestI];
  let outX = near.x - j.x, outZ = near.z - j.z;
  let ol = Math.hypot(outX, outZ);
  if (ol < 0.5) {
    const t = tangentAt(route, bestI);
    outX = t.x; outZ = t.z; ol = 1;
  } else {
    outX /= ol; outZ /= ol;
  }
  const res = [{ x: near.x, z: near.z, w: near.w, h: near.h, outX, outZ }];

  // 找对向的最近采样，实现双向箭头/停止线（最多 2 个方向）
  let opp = null, oppD = Infinity;
  for (let i = 0; i < arr.length; i++) {
    if (i === bestI) continue;
    const dx = arr[i].x - j.x, dz = arr[i].z - j.z;
    const d = Math.hypot(dx, dz);
    if (d < 2 || d > 80) continue;
    const dot = (dx * outX + dz * outZ) / d;
    if (dot < -0.5 && d < oppD) { oppD = d; opp = arr[i]; }
  }
  if (opp) {
    let ox = opp.x - j.x, oz = opp.z - j.z;
    let l = Math.hypot(ox, oz);
    if (l < 0.5) { ox = -outX; oz = -outZ; }
    else { ox /= l; oz /= l; }
    res.push({ x: opp.x, z: opp.z, w: opp.w, h: opp.h, outX: ox, outZ: oz });
  }
  return res;
}

function drawArrowTexture(g, w, h) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(w * 0.38, h * 0.90);
  g.lineTo(w * 0.62, h * 0.90);
  g.lineTo(w * 0.62, h * 0.64);
  g.lineTo(w * 0.84, h * 0.64);
  g.lineTo(w * 0.50, h * 0.18);
  g.lineTo(w * 0.16, h * 0.64);
  g.lineTo(w * 0.38, h * 0.64);
  g.closePath();
  g.fill();
}

function buildJunctionMarkings(world, junctions, mapDef, matWhiteSolid, whiteSolidMeshes, arrowMeshes) {
  const arrowTex = CITY.makeCanvas(256, 256, drawArrowTexture, { srgb: true });
  const arrowMat = new THREE.MeshBasicMaterial({
    map: arrowTex,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  let stopLines = 0, crosswalks = 0, arrows = 0;

  for (const j of junctions) {
    for (const roadId of j.roads) {
      const route = world.trafficRoutes.find(r => r.id === roadId);
      if (!route || route.samples.length < 2) continue;
      const cls = classOf(mapDef, roadId);
      const full = (cls.key === 'arterial' || cls.key === 'secondary');
      const apps = getApproachSamples(route, j);
      for (const app of apps) {
        const lat = perp(app.outX, app.outZ);
        // 停止线/斑马线 y 统一 sample.h + 0.105，保证压在路口板之上
        const sampleH = app.h != null ? app.h : world.terrainHeight(app.x, app.z);
        // 停止线：距路口中心 r + 2.2m，横贯路宽 ×0.8
        const sx = j.x + app.outX * (j.r + 2.2);
        const sz = j.z + app.outZ * (j.r + 2.2);
        const sy = sampleH + 0.105;
        pushBox(whiteSolidMeshes, sx, sz, sy, lat.x, lat.z, app.w * 0.8, 0.4, matWhiteSolid, MARK_THICK);
        stopLines++;

        if (!full) continue;

        // 斑马线：再向外 2.6m，6 条
        const cwDist = j.r + 2.2 + 2.6;
        const cwx = j.x + app.outX * cwDist;
        const cwz = j.z + app.outZ * cwDist;
        crosswalks++;
        for (let i = 0; i < 6; i++) {
          const off = (i - 2.5) * 0.9;
          const bx = cwx + app.outX * off;
          const bz = cwz + app.outZ * off;
          const by = sampleH + 0.105;
          pushBox(whiteSolidMeshes, bx, bz, by, lat.x, lat.z, app.w * 0.75, 0.45, matWhiteSolid, MARK_THICK);
        }

        // 直行箭头：停止线前 6m（距路口中心 r - 3.8m），每路每路口最多 2 个
        const ad = j.r + 2.2 - 6;
        if (ad > 0.5) {
          const ax = j.x + app.outX * ad;
          const az = j.z + app.outZ * ad;
          const ay = world.terrainHeight(ax, az) + 0.12;
          const dirX = -app.outX, dirZ = -app.outZ;   // 箭头指向路口
          const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.2), arrowMat);
          plane.position.set(ax, ay, az);
          // 用一组正交基把箭头平面平铺到路面：局部 +Y 指向路口方向，+Z 朝上
          const arrowMx = new THREE.Matrix4().makeBasis(
            new THREE.Vector3(-dirZ, 0, dirX),
            new THREE.Vector3(dirX, 0, dirZ),
            new THREE.Vector3(0, 1, 0)
          );
          plane.quaternion.setFromRotationMatrix(arrowMx);
          arrowMeshes.push(plane);
          arrows++;
        }
      }
    }
  }
  return { stopLines, crosswalks, arrows };
}

// ============================================================
//  阶段二：高架桥视觉
// ============================================================

// 沿 pts 生成一条宽度为 halfWidth*2、顶面 yTop/底面 yBottom（均为相对 pts.y 的偏移）
// 的连续 ribbon。返回非索引 BufferGeometry（position/normal/uv）。
function ribbonGeometry(pts, halfWidth, yTopOff, yBottomOff, vScale) {
  const pos = [], nrm = [], uv = [];
  const geo = { pos, nrm, uv };
  function quad(A, B, C, D, n, uv0, uv1, uv2, uv3) {
    pos.push(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
    pos.push(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2]);
    for (let k = 0; k < 6; k++) nrm.push(n[0], n[1], n[2]);
    uv.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
    uv.push(uv0[0], uv0[1], uv2[0], uv2[1], uv3[0], uv3[1]);
  }
  let dist = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1e-6;
    const tx = dx / len, tz = dz / len;
    const nx = -tz, nz = tx;
    const hw = halfWidth;
    const aTop = a.y + yTopOff, aBot = a.y + yBottomOff;
    const bTop = b.y + yTopOff, bBot = b.y + yBottomOff;
    const axp = a.x + nx * hw, azp = a.z + nz * hw;
    const bxp = b.x + nx * hw, bzp = b.z + nz * hw;
    const bxm = b.x - nx * hw, bzm = b.z - nz * hw;
    const axm = a.x - nx * hw, azm = a.z - nz * hw;
    const v0 = dist / vScale, v1 = (dist + len) / vScale;

    // 顶面
    quad([axp, aTop, azp], [bxp, bTop, bzp], [bxm, bTop, bzm], [axm, aTop, azm],
      [0, 1, 0], [0, v0], [0, v1], [1, v1], [1, v0]);
    // 底面
    quad([axm, aBot, azm], [axp, aBot, azp], [bxp, bBot, bzp], [bxm, bBot, bzm],
      [0, -1, 0], [0, v0], [1, v0], [1, v1], [0, v1]);
    // 侧面 +n
    quad([axp, aTop, azp], [bxp, bTop, bzp], [bxp, bBot, bzp], [axp, aBot, azp],
      [nx, 0, nz], [0, 0], [0, 1], [1, 1], [1, 0]);
    // 侧面 -n
    quad([axm, aTop, azm], [axm, aBot, azm], [bxm, bBot, bzm], [bxm, bTop, bzm],
      [-nx, 0, -nz], [0, 0], [0, 1], [1, 1], [1, 0]);

    dist += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

function offsetPoints(pts, offset) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    out.push({ x: pts[i].x + nx * offset, z: pts[i].z + nz * offset, y: pts[i].y });
  }
  return out;
}

// 桥墩避让地面道路：横向外移到路肩外，限制 ±6m
function roadNormalAt(world, sample) {
  const route = world.trafficRoutes.find(r => r.id === sample.road);
  if (!route) return { x: 1, z: 0 };
  const arr = route.samples;
  let si = arr.indexOf(sample);
  if (si < 0) si = 0;
  const a = arr[Math.max(0, si - 1)];
  const b = arr[Math.min(arr.length - 1, si + 1)];
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  return { x: -dz / len, z: dx / len };
}

function resolvePierPosition(world, x, z) {
  const nr = world.nearestRoad(x, z);
  if (!nr || nr.d >= nr.s.w / 2 + 2.5) return { x, z, ok: true };
  let dx = x - nr.px, dz = z - nr.pz;
  let d = Math.hypot(dx, dz);
  if (d < 0.05) {
    const nm = roadNormalAt(world, nr.s);
    dx = nm.x; dz = nm.z; d = 1;
  } else {
    dx /= d; dz /= d;
  }
  const targetD = nr.s.w / 2 + 2.8;
  const shift = Math.max(0, Math.min(targetD - nr.d, 6));
  if (shift < 0.05) return { x, z, ok: false };
  const nx = nr.px + dx * (nr.d + shift);
  const nz = nr.pz + dz * (nr.d + shift);
  const nr2 = world.nearestRoad(nx, nz);
  if (nr2 && nr2.d < nr2.s.w / 2 + 2.5) return { x: nx, z: nz, ok: false };
  return { x: nx, z: nz, ok: true };
}

function placePier(world, deckKind, x, z, y, normal, pierMat, pierMeshes, mainPierOut) {
  const deckBottom = y + 0.06 - 0.55;
  if (deckBottom - world.terrainHeight(x, z) < 0.8) return { piers: 0, colliders: 0 };
  const res = resolvePierPosition(world, x, z);
  if (!res.ok) return { piers: 0, colliders: 0 };
  const ground = world.terrainHeight(res.x, res.z);
  const height = deckBottom - ground;
  if (height < 0.8) return { piers: 0, colliders: 0 };

  const geo = new THREE.BoxGeometry(0.9, height, 0.9);
  const mesh = new THREE.Mesh(geo, pierMat);
  mesh.position.set(res.x, (ground + deckBottom) / 2, res.z);
  pierMeshes.push(mesh);

  let colliders = 0;
  const nr = world.nearestRoad(res.x, res.z);
  if (!nr || nr.d >= nr.s.w / 2 + 2.5) {
    CITY.addCollider(world, res.x, res.z, 1.3, 'bridgePier');
    colliders = 1;
  }
  if (deckKind === 'main') {
    mainPierOut.push({ x: res.x, z: res.z, ground, deckBottom, height, nx: normal.x, nz: normal.z });
  }
  return { piers: 1, colliders };
}

function buildPiersForDeck(world, deck, spacing, pierMat, pierMeshes, mainPierOut) {
  const pts = deck.pts;
  const n = pts.length;
  if (n < 2) return { piers: 0, colliders: 0 };
  const cum = [0];
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  const total = cum[n - 1];
  if (total < 8) return { piers: 0, colliders: 0 };
  let nextD = Math.min(spacing * 0.5, total * 0.5);
  const endLimit = total - 4;
  let piers = 0, colliders = 0;
  for (let i = 0; i < n - 1 && nextD <= endLimit; i++) {
    const segStart = cum[i], segEnd = cum[i + 1];
    while (nextD >= segStart && nextD <= segEnd && nextD <= endLimit) {
      const t = (nextD - segStart) / (segEnd - segStart || 1);
      const a = pts[i], b = pts[i + 1];
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const y = a.y + (b.y - a.y) * t;
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const res = placePier(world, deck.kind, x, z, y, { x: nx, z: nz }, pierMat, pierMeshes, mainPierOut);
      piers += res.piers;
      colliders += res.colliders;
      nextD += spacing;
    }
  }
  return { piers, colliders };
}

function buildBeacons(parent, mainPierOut) {
  if (!mainPierOut.length) return 0;
  const geo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const mat = new THREE.MeshStandardMaterial({
    color: 0x1a0000,
    emissive: 0xff3038,
    emissiveIntensity: 1.2,
    roughness: 0.5,
    metalness: 0,
  });
  CITY.registerNight(mat);
  const inst = new THREE.InstancedMesh(geo, mat, mainPierOut.length);
  const m = new THREE.Matrix4();
  for (let i = 0; i < mainPierOut.length; i++) {
    const p = mainPierOut[i];
    const bx = p.x + p.nx * 0.62;
    const bz = p.z + p.nz * 0.62;
    const by = p.ground + Math.min(2.0, Math.max(0.8, p.height * 0.5));
    m.makeTranslation(bx, by, bz);
    inst.setMatrixAt(i, m);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.castShadow = false;
  parent.add(inst);
  return 1;
}

function buildSigns(op, parent) {
  const deck = op.decks.find(d => d.kind === 'main');
  if (!deck || deck.pts.length < 2) return 0;
  const tex = CITY.makeSign('海特洛空中走廊', { bg: '#1c4b7a', fg: '#d8ecff', w: 256, h: 64 });
  const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
  const meshes = [];
  const pts = deck.pts;
  const n = pts.length;
  const ends = [
    { pt: pts[0], next: pts[1] },
    { pt: pts[n - 1], next: pts[n - 2] },
  ];
  for (const e of ends) {
    let dx = e.next.x - e.pt.x, dz = e.next.z - e.pt.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz, nz = dx;
    const off = op.w / 2 - 0.4;
    const sx = e.pt.x + nx * off;
    const sz = e.pt.z + nz * off;
    const sy = e.pt.y + 0.06 + 0.75 + 0.75 + 0.05;
    // 两端桥名牌都朝向桥外（面向驶上桥的车流）
    const dirX = -dx, dirZ = -dz;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.5), mat);
    sign.position.set(sx, sy, sz);
    sign.rotation.order = 'YXZ';
    sign.rotation.y = Math.atan2(dirX, dirZ);
    meshes.push(sign);
  }
  const merged = CITY.mergeByMaterial(meshes, parent);
  for (const m of merged) { m.castShadow = false; m.receiveShadow = false; }
  disposeMeshes(meshes);
  return merged.length;
}

// ============================================================
//  注册构建阶段
// ============================================================

CITY.stages.push({
  name: 'cityRoadEngine',
  fn(world) {
    const stats = { junctions: 0, roadMarksKm: 0, stopLines: 0, crosswalks: 0, arrows: 0, drawCalls: 0 };
    if (!world || !world.samples || !world.samples.length || !world.cityRoot) return stats;
    const parent = world.cityRoot;
    const mapDef = getCityMapDef();

    // 1. 路口检测
    const junctions = detectJunctions(world);
    CITY.junctions = junctions;
    stats.junctions = junctions.length;

    let dc = 0;
    // 2. 路口铺装板
    const plate = buildJunctionPlates(world, junctions, parent, mapDef);
    if (plate) dc++;

    // 3. 车道标线（黄实线 / 白实线 / 白虚线）
    const matYellow = new THREE.MeshStandardMaterial({ color: 0xf2c14e, roughness: 0.65, metalness: 0 });
    const matWhiteSolid = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.65, metalness: 0 });
    const matWhiteDash = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.65, metalness: 0 });
    for (const m of [matYellow, matWhiteSolid, matWhiteDash]) {
      m.polygonOffset = true;
      m.polygonOffsetFactor = -1;
      m.polygonOffsetUnits = -1;
    }

    const yellowMeshes = [], whiteSolidMeshes = [], whiteDashedMeshes = [], arrowMeshes = [];
    stats.roadMarksKm = buildLaneMarkings(world, junctions, mapDef,
      { yellow: matYellow, whiteSolid: matWhiteSolid, whiteDash: matWhiteDash },
      yellowMeshes, whiteSolidMeshes, whiteDashedMeshes);

    // 4. 停止线 / 斑马线 / 导向箭头（白实线与停止线/斑马线合并）
    const jm = buildJunctionMarkings(world, junctions, mapDef, matWhiteSolid, whiteSolidMeshes, arrowMeshes);
    stats.stopLines = jm.stopLines;
    stats.crosswalks = jm.crosswalks;
    stats.arrows = jm.arrows;

    const yellowMerged = CITY.mergeByMaterial(yellowMeshes, parent);
    const whiteSolidMerged = CITY.mergeByMaterial(whiteSolidMeshes, parent);
    const whiteDashMerged = CITY.mergeByMaterial(whiteDashedMeshes, parent);
    const arrowMerged = CITY.mergeByMaterial(arrowMeshes, parent);
    for (const m of arrowMerged) { m.castShadow = false; m.receiveShadow = false; m.renderOrder = 1; }
    dc += yellowMerged.length + whiteSolidMerged.length + whiteDashMerged.length + arrowMerged.length;

    disposeMeshes(yellowMeshes);
    disposeMeshes(whiteSolidMeshes);
    disposeMeshes(whiteDashedMeshes);
    disposeMeshes(arrowMeshes);

    stats.drawCalls = dc;
    return stats;
  },
});

CITY.stages.push({
  name: 'cityOverpassVisual',
  fn(world) {
    const stats = { decks: 0, piers: 0, colliders: 0, drawCalls: 0 };
    if (!world || !world.cityRoot || !world.overpasses || !world.overpasses.length) return stats;
    const parent = world.cityRoot;

    const deckTex = CITY.makeCanvas(128, 256, (g, w, h) => {
      g.fillStyle = '#3a3d42';
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 900; i++) {
        const v = 58 + Math.floor(CITY.rand(0, 55));
        g.fillStyle = 'rgba(' + v + ',' + v + ',' + (v + 2) + ',0.35)';
        g.fillRect(CITY.rand(0, w), CITY.rand(0, h), 1 + CITY.rand(0, 2), 1 + CITY.rand(0, 2));
      }
      g.fillStyle = '#22252a';
      g.fillRect(0, 0, w, 3);
      g.fillRect(0, h * 0.5 - 1.5, w, 3);
    }, { srgb: true, repeat: [1, 1], anisotropy: true });
    deckTex.wrapS = deckTex.wrapT = THREE.RepeatWrapping;

    const deckMat = new THREE.MeshStandardMaterial({
      map: deckTex, color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
    });
    const barrierMat = new THREE.MeshStandardMaterial({
      color: 0xb3b5ba, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    });
    const railMat = new THREE.MeshStandardMaterial({
      color: 0xd6dae0, roughness: 0.3, metalness: 0.85, side: THREE.DoubleSide,
    });
    const pierMat = new THREE.MeshStandardMaterial({ color: 0x9b9ea4, roughness: 0.85, metalness: 0 });

    const deckMeshes = [], barrierMeshes = [], railMeshes = [], pierMeshes = [];
    const mainPierOut = [];
    let piers = 0, colliders = 0, dc = 0;

    for (const op of world.overpasses) {
      for (const deck of op.decks) {
        stats.decks++;
        if (!deck.pts || deck.pts.length < 2) continue;
        const halfW = op.w / 2;
        const baseTop = 0.06;      // 顶面 = pts.y + 0.06
        const baseBot = baseTop - 0.55;

        // 桥面（顶面 + 两侧 + 底面）
        deckMeshes.push(new THREE.Mesh(ribbonGeometry(deck.pts, halfW, baseTop, baseBot, 10), deckMat));

        // 两侧混凝土护栏 + 金属压条
        const off = halfW - 0.15;
        for (const side of [-1, 1]) {
          const bpts = offsetPoints(deck.pts, side * off);
          barrierMeshes.push(new THREE.Mesh(ribbonGeometry(bpts, 0.15, baseTop + 0.75, baseTop, 3), barrierMat));
          railMeshes.push(new THREE.Mesh(ribbonGeometry(bpts, 0.16, baseTop + 0.75 + 0.06, baseTop + 0.75, 3), railMat));
        }

        // 桥墩
        const spacing = deck.kind === 'main' ? 42 : 25;
        const pr = buildPiersForDeck(world, deck, spacing, pierMat, pierMeshes, mainPierOut);
        piers += pr.piers;
        colliders += pr.colliders;
      }
      // 主桥两端桥名牌
      dc += buildSigns(op, parent);
    }

    // 同材质合并：桥面 / 护栏 / 压条 / 桥墩
    dc += CITY.mergeByMaterial(deckMeshes, parent).length;
    dc += CITY.mergeByMaterial(barrierMeshes, parent).length;
    dc += CITY.mergeByMaterial(railMeshes, parent).length;
    dc += CITY.mergeByMaterial(pierMeshes, parent).length;
    disposeMeshes(deckMeshes);
    disposeMeshes(barrierMeshes);
    disposeMeshes(railMeshes);
    disposeMeshes(pierMeshes);

    // 桥墩红色航标灯（InstancedMesh，emissive + registerNight）
    dc += buildBeacons(parent, mainPierOut);

    stats.piers = piers;
    stats.colliders = colliders;
    stats.drawCalls = dc;
    return stats;
  },
});

})();
