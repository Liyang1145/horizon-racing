// 刹车稳定性测试：918 加速后重刹，采样俯仰/侧倾角速度、高度、横移，判断是否"侧飞/翻车"
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    const c = Game.car;
    await sleep(600);
    // 加速到一定速度
    Game.keys.KeyW = true;
    await sleep(2300);
    Game.keys.KeyW = false;
    const vBefore = c.speedKmh;
    // 重刹
    const t0 = performance.now();
    let maxPitchRate = 0, maxRollRate = 0, maxH = c.pos.y, minH = c.pos.y, maxYVel = 0;
    const samples = [];
    Game.keys.KeyS = true;
    while (performance.now() - t0 < 1600) {
      await sleep(60);
      const av = c.body.angularVelocity;
      maxPitchRate = Math.max(maxPitchRate, Math.abs(av.x));
      maxRollRate = Math.max(maxRollRate, Math.abs(av.z));
      maxH = Math.max(maxH, c.pos.y);
      minH = Math.min(minH, c.pos.y);
      maxYVel = Math.max(maxYVel, Math.abs(c.bodyVy));
      samples.push({ v: r3(c.speedKmh), h: r3(c.pos.y), px: r3(av.x), pz: r3(av.z) });
    }
    Game.keys.KeyS = false;
    await sleep(300);
    return {
      ok: true,
      vBeforeBrake: r3(vBefore),
      vAfterBrake: r3(c.speedKmh),
      grounded: c.grounded,
      maxPitchRate: r3(maxPitchRate),   // 俯仰角速度(rad/s)，大=前后翻
      maxRollRate: r3(maxRollRate),     // 侧倾角速度(rad/s)，大=侧翻/侧飞
      heightRange: [r3(minH), r3(maxH)],
      maxVerticalVel: r3(maxYVel),
      samples: samples.filter((s, i) => i % 5 === 0),
      err: window.__lastErr || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null };
  }
})()
