// ============================================================
//  CITY GLB — 把外部 GLB 城市模型（procedural_city_6）作为一张地图导入
//  ------------------------------------------------------------
//  由 world.placeProps 在海特洛3（city3）调用 CITY_GLB.build(world)。
//  - 加载 assets/models/procedural_city_6_data.js（GLB 以 base64 JS 内嵌，file:// 直开可用）
//  - 自动居中、贴地、适应地形高度
//  - 街道/人行道路面生成 cannon Trimesh，车轮可真实行驶
//  - 建筑生成轻量圆柱碰撞，避免穿楼
//  - 天空/后处理/车辆接触阴影复用 CITY 管线
// ============================================================
(() => {
  'use strict';
  if (typeof window === 'undefined' || !window.CITY) return;

  const C = window.CITY;

  function b64ToArrayBuffer(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // 首选：base64 JS 资产（file:// 下 script 标签没有 CORS 限制）；
  // 数据脚本按需注入，未选择该地图时不解析 52MB。
  function loadEmbedded() {
    return new Promise((resolve, reject) => {
      if (window.PROCEDURAL_CITY_6_B64) { resolve(window.PROCEDURAL_CITY_6_B64); return; }
      const s = document.createElement('script');
      s.src = 'assets/models/procedural_city_6_data.js';
      s.onload = () => {
        if (window.PROCEDURAL_CITY_6_B64) resolve(window.PROCEDURAL_CITY_6_B64);
        else reject(new Error('PROCEDURAL_CITY_6_B64 missing'));
      };
      s.onerror = () => reject(new Error('embedded GLB script load fail'));
      document.head.appendChild(s);
    });
  }

  function parseGLB(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const loader = new THREE.GLTFLoader();
      loader.parse(arrayBuffer, '', resolve, err => reject(new Error('GLB parse fail: ' + (err && err.message || err))));
    });
  }

  async function build(world) {
    if (typeof UI !== 'undefined' && UI.setLoading) UI.setLoading(UI.loadP || 0.4, '加载程序化城市模型…');
    let gltf = null;
    try {
      const b64 = await loadEmbedded();
      gltf = await parseGLB(b64ToArrayBuffer(b64));
    } catch (e) {
      throw new Error('程序化城市模型加载失败（assets/models/procedural_city_6_data.js 缺失或损坏）: ' + (e && e.message || e));
    }
    const model = gltf.scene;

    // 包围盒 -> 居中 + 贴地 + 适配地形
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const groundY = world.terrainHeight(0, 0) - box.min.y + 0.05;
    model.position.set(-center.x, groundY, -center.z);
    model.updateMatrixWorld(true);
    world.glbModel = model;
    world.glbDriveBounds = {
      x0: -center.x + box.min.x - 8, x1: -center.x + box.max.x + 8,
      z0: -center.z + box.min.z - 8, z1: -center.z + box.max.z + 8,
    };

    // 视觉属性：阴影 + 半透明玻璃保持原样
    if (!world.cityRoot) {
      const root = new THREE.Group();
      root.name = 'cityRoot';
      world.scene.add(root);
      world.cityRoot = root;
    }
    const meshList = [];
    model.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        meshList.push(o);
      }
    });
    world.cityRoot.add(model);

    // ---- 路面物理：街道/车道/人行道/路缘 -> cannon Trimesh（与视觉共用世界矩阵） ----
    const roadMatNames = ['citygen_streets', 'citygen_lanes', 'side_walks', 'curb', 'citygen_curb', 'citygen_lanes_white', 'citygen_lanes_secondary_color', 'citygenside_walks'];
    const isRoadMat = mat => {
      if (!mat) return false;
      const n = String(mat.name || '').toLowerCase();
      return roadMatNames.some(k => n.indexOf(k) !== -1) || n.indexOf('street') !== -1;
    };
    let roadTris = 0, bodies = 0;
    const tmp = new THREE.Matrix4();
    for (const m of meshList) {
      if (!isRoadMat(m.material)) continue;
      const geo = m.geometry;
      if (!geo || !geo.attributes.position || !geo.index) continue;
      const pos = geo.attributes.position;
      const idx = geo.index;
      const verts = [];
      tmp.multiplyMatrices(model.matrixWorld, m.matrixWorld);
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(tmp);
        verts.push(v.x, v.y + 0.05, v.z + 0.02);
      }
      const faces = [];
      for (let i = 0; i < idx.count; i += 3) {
        const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
        if (a === b || b === c || a === c) continue;
        faces.push(a, c, b); // three 是逆时针正面，cannon 朝向无所谓，双面可行
        roadTris++;
      }
      if (!faces.length) continue;
      // 超大网格切段，避免 cannon 一次性吃太多
      for (let s = 0; s < faces.length; s += 90000) {
        const sub = faces.slice(s, s + 90000);
        const shape = new CANNON.Trimesh(verts, sub);
        if (shape.updateTree) shape.updateTree();
        const body = new CANNON.Body({ mass: 0, collisionFilterGroup: 2, collisionFilterMask: 1 });
        body.addShape(shape);
        body.updateAABB();
        world.physics.cannon.addBody(body);
        (world.roadBodies = world.roadBodies || []).push(body);
        bodies++;
      }
      m.userData.cityGlbRoad = true;
    }

    // ---- 建筑碰撞（轻量圆柱推挤） ----
    let colliders = 0;
    for (const m of meshList) {
      if (isRoadMat(m.material) || m.userData.cityGlbRoad) continue;
      const n = String((m.name || '') + ' ' + (m.material && m.material.name || '')).toLowerCase();
      if (n.indexOf('tree') !== -1 || n.indexOf('foliage') !== -1 || n.indexOf('grass') !== -1 || n.indexOf('plane') !== -1) continue;
      const b = new THREE.Box3().setFromObject(m);
      if (b.isEmpty()) continue;
      const s = b.getSize(new THREE.Vector3());
      if (s.y < 3 || s.x < 2 || s.z < 2) continue;
      if (s.x > 200 || s.z > 200) continue;
      const c = b.getCenter(new THREE.Vector3());
      const r = Math.min(Math.hypot(s.x, s.z) * 0.5, 9);
      world.colliders.push({ x: c.x, z: c.z, r, type: 'glbBuilding' });
      colliders++;
    }

    // ---- 城市天空/后处理/接触阴影 ----
    C.buildStages(world, ['citySky', 'cityPost', 'cityCarShadow']);

    if (typeof UI !== 'undefined' && UI.setLoading) UI.setLoading(UI.loadP || 0.4, '程序化城市就绪');
    return {
      meshCount: meshList.length,
      roadTris, roadBodies: bodies, colliders,
      size: { x: +size.x.toFixed(1), y: +size.y.toFixed(1), z: +size.z.toFixed(1) },
      center: { x: +center.x.toFixed(1), y: +center.y.toFixed(1), z: +center.z.toFixed(1) },
    };
  }

  window.CITY_GLB = { build };
})();
