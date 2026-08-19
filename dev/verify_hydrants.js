// 消防栓验证脚本（供 dev/eval_async.mjs 同款 CDP eval 工具使用）：
// 校验出生点、5 个消防栓的世界坐标与地形高度、碰撞注册，并准备一张特写截图。
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  const out = { ok: true, err: null, spawn: null, hydrants: [], colliders: 0, checks: {}, scene: {} };
  try {
    const w = Game.world;
    const sl = w.startLine;
    out.err = window.__err || null;
    out.route = (w.trafficRoutes.find(r => r.id === 'highway')
      || w.trafficRoutes.find(r => r.id === 'cross')
      || w.trafficRoutes.find(r => r.id === 'ring') || {}).id || null;
    out.spawn = { x: r3(sl.x), y: r3(sl.y), z: r3(sl.z), yaw: r3(sl.yaw) };

    out.hydrants = (w.hydrants || []).map((h, i) => {
      const th = w.terrainHeight(h.x, h.z);
      const nr = w.nearestRoad(h.x, h.z);
      return {
        i, x: r3(h.x), z: r3(h.z), y: r3(h.y), terrainY: r3(th), dy: r3(h.y - th),
        roadDist: r3(nr ? nr.d : -1), along: h.along, side: h.side,
      };
    });
    out.colliders = (w.colliders || []).filter(c => c.type === 'hydrant').length;

    // 场景中的消防栓 Group / 每个组内 mesh 数量
    out.scene.groups = [];
    out.scene.meshCounts = [];
    w.scene.traverse(o => {
      if (o.isGroup && o.name === 'fireHydrant') {
        out.scene.groups.push({ x: r3(o.position.x), y: r3(o.position.y), z: r3(o.position.z) });
        let n = 0; o.traverse(c => { if (c.isMesh) n++; });
        out.scene.meshCounts.push(n);
      }
    });

    // ---- 数值校验 ----
    const ck = out.checks;
    ck.count3to5 = out.hydrants.length >= 3 && out.hydrants.length <= 5;
    ck.dyZero = out.hydrants.every(h => Math.abs(h.dy) < 1e-9);
    ck.errEmpty = !out.err;
    ck.colliderCountMatches = out.colliders === out.hydrants.length;
    ck.sceneGroupCountMatches = out.scene.groups.length === out.hydrants.length;
    ck.meshCountOk = out.scene.meshCounts.every(n => n === 8);

    // 相对出生点的沿路/横向距离：必须全部在路肩外（cross 半宽 10m，横向 ≈12m）
    const fx = Math.sin(sl.yaw), fz = Math.cos(sl.yaw);
    const lx = Math.cos(sl.yaw), lz = -Math.sin(sl.yaw);
    const rel = out.hydrants.map(h => {
      const dx = h.x - sl.x, dz = h.z - sl.z;
      return { along: r3(dx * fx + dz * fz), lateral: r3(Math.abs(dx * lx + dz * lz)) };
    });
    out.relative = rel;
    ck.lateralIn11to13 = rel.every(p => p.lateral >= 11 && p.lateral <= 13.01);
    ck.outOfRoad = out.hydrants.every(h => h.roadDist > 10.5);
    ck.minSpawnDist = r3(Math.min(...out.hydrants.map(h => Math.hypot(h.x - sl.x, h.z - sl.z))));
    ck.notBlockingSpawn = ck.minSpawnDist > 10.5;

    // 与最近路灯/起点拱门立柱的距离（仅报告，便于判断视觉拥挤）
    let minLamp = 1e9;
    for (const c of w.colliders) {
      if (c.type !== 'lamp') continue;
      for (const h of out.hydrants) minLamp = Math.min(minLamp, Math.hypot(h.x - c.x, h.z - c.z));
    }
    out.minLampDist = minLamp === 1e9 ? null : r3(minLamp);
    const poles = [
      { x: sl.x + lx * 10 + fx * -6, z: sl.z + lz * 10 + fz * -6 },
      { x: sl.x - lx * 10 + fx * -6, z: sl.z - lz * 10 + fz * -6 },
    ];
    out.minGatePoleDist = r3(Math.min(...out.hydrants.map(h =>
      Math.min(Math.hypot(h.x - poles[0].x, h.z - poles[0].z), Math.hypot(h.x - poles[1].x, h.z - poles[1].z)))));

    out.checksPass = Object.entries(ck).filter(([, v]) => typeof v === 'boolean').every(([, v]) => v);

    // ---- 截图准备：进入驾驶画面，固定相机对准 1 号消防栓 ----
    try { Game.start('free'); } catch (e) { out.startErr = String(e); }
    await sleep(350);
    const t = out.hydrants[1] || out.hydrants[0];
    if (t) {
      Game.updateCamera = function () {};
      Game.camera.position.set(t.x + 3.2, t.y + 1.35, t.z + 3.0);
      Game.camera.lookAt(t.x, t.y + 0.55, t.z);
    }
    window.__hydrantVerify = out;
    return out;
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null, err: window.__err || null };
  }
})()
