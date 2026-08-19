// 转向后回正：采样 yaw 角速度，看是否出现"尾巴左右甩"的振荡
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    const c = Game.car;
    await sleep(600);
    Game.keys.KeyW = true;
    await sleep(1500);
    Game.keys.KeyD = true;   // 打右
    await sleep(700);
    Game.keys.KeyD = false;  // 回正
    const samples = [];
    let crossings = 0, lastYaw = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1600) {
      await sleep(40);
      const av = c.body.angularVelocity;
      if (lastYaw !== 0 && Math.sign(av.y) !== Math.sign(lastYaw)) crossings++;
      lastYaw = av.y;
      samples.push({ yaw: r3(av.y), spd: r3(c.speedKmh) });
    }
    Game.keys.KeyW = false;
    return {
      ok: true,
      yawSignCrossingsAfterRelease: crossings,
      samples: samples.filter((s, i) => i % 4 === 0),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
})()
