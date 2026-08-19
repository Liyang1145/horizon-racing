// 转向时车屁股左右震排查：采样 yaw 角速度、roll、后轮横向位移，看是否有振荡
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
    await sleep(1500); // 加速
    Game.keys.KeyD = true; // 转向
    const samples = [];
    let maxYaw = 0, maxRoll = 0, signYaw = 0, crossings = 0;
    let lastYaw = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 1600) {
      await sleep(50);
      const av = c.body.angularVelocity;
      maxYaw = Math.max(maxYaw, Math.abs(av.y));
      maxRoll = Math.max(maxRoll, Math.abs(av.z));
      if (lastYaw !== 0 && Math.sign(av.y) !== Math.sign(lastYaw)) crossings++;
      lastYaw = av.y;
      samples.push({ yaw: r3(av.y), roll: r3(av.z), spd: r3(c.speedKmh) });
    }
    Game.keys.KeyD = false;
    Game.keys.KeyW = false;
    return {
      ok: true,
      maxYawRate: r3(maxYaw),       // yaw 角速度峰值(rad/s)
      maxRollRate: r3(maxRoll),     // roll 角速度峰值
      yawSignCrossings: crossings,  // yaw 符号翻转次数(振荡指标)
      samples: samples.filter((s, i) => i % 4 === 0),
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
})()
