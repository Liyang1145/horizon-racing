// ============================================================
//  HORIZON 赛车 — 通用道具：消防栓（纯程序化建模）
//  构建器 buildFireHydrant(opts) 供 GameWorld 调用；
//  几何体/材质在多个消防栓之间共享，控制 draw call 与显存开销。
// ============================================================
'use strict';

// 共享资源：首次调用时构建一次，后续所有消防栓复用
const HYDRANT_ASSETS = (() => {
  let cached = null;
  return function getHydrantAssets() {
    if (cached) return cached;
    // 主体红色涂漆金属 + 出水口/螺母银灰金属
    const redMat = new THREE.MeshStandardMaterial({
      color: 0xc41e2a, metalness: 0.35, roughness: 0.40,
    });
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0xb8bdc4, metalness: 0.85, roughness: 0.35,
    });
    // 各部件几何均以“地面在 y=0、Y 轴朝上”为约定，构建时直接定位
    const geos = {
      flange:    new THREE.CylinderGeometry(0.20, 0.17, 0.06, 12),            // 底座法兰
      body:      new THREE.CylinderGeometry(0.13, 0.16, 0.55, 14),            // 主体圆柱
      dome:      new THREE.SphereGeometry(0.16, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), // 顶部圆帽（半球）
      topNut:    new THREE.CylinderGeometry(0.042, 0.042, 0.08, 5),           // 顶部五角操作螺母
      nozzle:    new THREE.CylinderGeometry(0.055, 0.055, 0.14, 10),          // 侧出水口
      nozzleCap: new THREE.CylinderGeometry(0.082, 0.088, 0.07, 5),           // 出水口五角螺帽
    };
    cached = { redMat, metalMat, geos };
    return cached;
  };
})();

// 构建一个经典红色消防栓 Group（总高约 0.82m，含底座）
// opts: { x, y, z, yaw } —— y 为地面高度，由调用方用地形高度接口提供
function buildFireHydrant(opts = {}) {
  const { redMat, metalMat, geos } = HYDRANT_ASSETS();
  const g = new THREE.Group();
  g.name = 'fireHydrant';
  g.userData.kind = 'fireHydrant';
  g.userData.radius = 0.22; // 与 world.colliders 的近似碰撞半径保持一致

  const flange = new THREE.Mesh(geos.flange, redMat);
  flange.position.y = 0.03;                       // 0 ~ 0.06
  flange.castShadow = true;
  flange.receiveShadow = true;

  const body = new THREE.Mesh(geos.body, redMat);
  body.position.y = 0.335;                        // 0.06 ~ 0.61
  body.castShadow = true;
  body.receiveShadow = true;

  const dome = new THREE.Mesh(geos.dome, redMat);
  dome.position.y = 0.61;                         // 圆帽顶 ~0.77
  dome.castShadow = true;

  const topNut = new THREE.Mesh(geos.topNut, metalMat);
  topNut.position.y = 0.78;                       // 总高 ~0.82
  topNut.castShadow = true;

  const parts = [flange, body, dome, topNut];
  // 左右两个侧出水口：横向喷嘴 + 五角螺帽（朝向垂直于车流方向）
  for (const side of [-1, 1]) {
    const nozzle = new THREE.Mesh(geos.nozzle, metalMat);
    nozzle.rotation.z = Math.PI / 2;
    nozzle.position.set(side * 0.20, 0.47, 0);
    nozzle.castShadow = true;

    const cap = new THREE.Mesh(geos.nozzleCap, metalMat);
    cap.rotation.z = Math.PI / 2;
    cap.position.set(side * 0.31, 0.47, 0);
    cap.castShadow = true;

    parts.push(nozzle, cap);
  }
  g.add(...parts);
  g.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
  g.rotation.y = opts.yaw || 0;
  return g;
}
