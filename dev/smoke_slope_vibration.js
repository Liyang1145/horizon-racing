// 冒烟验证：Catmull-Rom 坡面平滑改动后，游戏能否正常初始化 + 车辆能否正常行驶。
// 采样车身竖直振动（body.y 波动 / 竖直速度均值）作为坡面震动的粗略指标。
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false);
    const c = Game.car;
    const w = Game.world;
    await sleep(500);
    const roadCount = (w.roadBodies || []).length;
    const sampleCounts = (w.trafficRoutes || []).map(r => r.samples.length);
    // 驱动 4 秒采样车身竖直运动
    Game.keys.KeyW = true;
    const t0 = performance.now();
    const ys = [], vy = [];
    let lastY = c.body.position.y, lastT = t0;
    while (performance.now() - t0 < 4000) {
      await sleep(50);
      const now = performance.now();
      const y = c.body.position.y;
      ys.push(y);
      const dt = Math.max(1e-3, (now - lastT) / 1000);
      vy.push((y - lastY) / dt);
      lastY = y; lastT = now;
    }
    Game.keys.KeyW = false;
    const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
    const sd = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
    const vyAbs = vy.map(Math.abs);
    const vyMean = vyAbs.reduce((a, b) => a + b, 0) / vyAbs.length;
    const p = c.body.position;
    return {
      ok: true,
      stage: window.__stage,
      err: window.__lastErr || window.__startError || null,
      roadCount, sampleCounts,
      carId: c.spec.id,
      grounded: c.grounded,
      speedKmh: r3(c.speedKmh),
      bodyY_sd_m: r3(sd),
      meanAbsVy_ms: r3(vyMean),
      yRange_m: r3(Math.max(...ys) - Math.min(...ys)),
      posFinite: isFinite(p.x) && isFinite(p.y) && isFinite(p.z),
      pos: [r3(p.x), r3(p.y), r3(p.z)],
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null, startErr: window.__startError || null };
  }
})()
