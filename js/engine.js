// ============================================================
//  物理引擎 — cannon-es 世界 / 高度场地形 / 边界
//  四个轮子通过 RaycastVehicle 对地面做真正的射线悬挂
// ============================================================
'use strict';

class PhysicsWorld {
  constructor(world) {
    const cw = new CANNON.World({
      gravity: new CANNON.Vec3(0, -CFG.grav, 0),
    });
    cw.broadphase = new CANNON.SAPBroadphase(cw);
    cw.allowSleep = false;
    cw.defaultContactMaterial.friction = 0.35;
    cw.defaultContactMaterial.restitution = 0;
    this.cannon = cw;
    this.slowmo = false; // 慢动作标志：只在慢动作期间启用小步长+力补偿

    // ---------- 高度场地面（覆盖整个世界，可任意越野） ----------
    const half = CFG.worldHalf;
    // 与渲染地形网格(400 段)对齐，消除“视觉地面 vs 物理地面”的高度差
    // 高度场 6.75m/格（801×801）：路面精度由道路 Trimesh 保证，
    // 高度场只负责越野与支撑车身；高分辨率 raycast 代价过高会卡死
    const n = 801;
    const elementSize = half * 2 / (n - 1);
    const data = [];
    for (let i = 0; i < n; i++) {
      const x = -half + i * elementSize;
      const col = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        // cannon 高度场以局部 XY 为地面、+Z 为高度；
        // 绕 X 轴旋转 -90° 后局部 +Z -> 世界 +Y，行方向 j 对应世界 -Z
        const z = half - j * elementSize;
        col[j] = world.terrainHeight(x, z);
      }
      data.push(col);
    }
    const hfShape = new CANNON.Heightfield(data, { elementSize });
    const hfBody = new CANNON.Body({ mass: 0 });
    hfBody.addShape(hfShape);
    hfBody.position.set(-half, 0, half);
    hfBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    hfBody.updateAABB();
    cw.addBody(hfBody);
    this.ground = hfBody;

    // 轮子 raycast 道路兜底：高度场/Trimesh 在交叉口等位置可能让
    // raycast 够不到路面（网格插值误差、车身被弹高等），此时直接按
    // 最近道路高度生成接触，保证车轮永远有路面支撑（悬挂再拉回车身）。
    this._world = world;
    this._roadDummy = new CANNON.Body({ mass: 0 });
    this._roadDummy.collisionResponse = false;
    cw.roadFallback = (wheel, result) => {
      const src = wheel.chassisConnectionPointWorld;
      // 交叉口用多路段加权高度（无跳变），普通路段等同最近路高度
      const mh = world.multiRoadHeight(src.x, src.z);
      if (mh == null) return;
      const d = src.y - mh;
      if (d <= 0.05) return;
      // 兜底距离逐轮平滑：避免在交叉口/路段切换处 segH 跳变把车身顶得上下抖
      wheel._fbSmooth = wheel._fbSmooth === undefined ? d : lerp(wheel._fbSmooth, d, 0.35);
      result.distance = Math.max(0.08, wheel._fbSmooth);
      result.hitPointWorld.set(src.x, mh, src.z);
      result.hitNormalWorld.set(0, 1, 0);
      result.body = this._roadDummy;
    };
    // 平滑接触法线：高度场/道路网格都是平面三角片，法线在三角片边界处跳变，
    // 导致视觉上平缓的坡在物理侧让悬挂上下震动。这里用 terrainHeight 的梯度
    // 直接算连续法线（与视觉网格的顶点法线平滑一致），从根源消除法线突变。
    cw.contactNormal = (x, z, out) => {
      const e = 2.5;
      const hL = world.terrainHeight(x - e, z);
      const hR = world.terrainHeight(x + e, z);
      const hD = world.terrainHeight(x, z - e);
      const hU = world.terrainHeight(x, z + e);
      const gx = (hR - hL) / (2 * e);
      const gz = (hU - hD) / (2 * e);
      out.set(-gx, 1, -gz);
      out.normalize();
    };

    // ---------- 边界墙体（防止驶出高度场后掉落） ----------
    const wallH = 120, wallT = 10;
    const addWall = (cx, cz, sx, sz) => {
      const b = new CANNON.Body({ mass: 0 });
      b.addShape(new CANNON.Box(new CANNON.Vec3(sx / 2, wallH / 2, sz / 2)));
      b.position.set(cx, wallH / 2 - 20, cz);
      cw.addBody(b);
    };
    addWall(0, half + wallT, half * 2 + wallT * 2, wallT);
    addWall(0, -half - wallT, half * 2 + wallT * 2, wallT);
    addWall(half + wallT, 0, wallT, half * 2 + wallT * 2);
    addWall(-half - wallT, 0, wallT, half * 2 + wallT * 2);
  }

  step(dt) {
    if (this.slowmo) {
      // 慢动作：小固定步长均匀步进，避免累积后集中跑多次物理造成卡顿
      this.cannon.step(Math.max(dt, 1e-4), dt, 3);
    } else {
      // 正常驾驶：固定 1/60 步长，与任何帧率下的原版手感完全一致
      this.cannon.step(1 / 60, dt, 3);
    }
  }
}
