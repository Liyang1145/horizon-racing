// 雨天视觉验证：切到雨天(白天),车头朝前看路,便于截图确认雨丝与水坑是否可见
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    const w = Game.world;
    w.hour = 13;           // 正午，雨天光线充足，雨丝/水坑更易看清
    w.weather = 1;         // 雨
    for (let i = 0; i < 60; i++) w.updateWeather(1 / 30, { x: 0, z: 0 });
    await sleep(400);
    // 沿当前道路往前开一段，让水坑进入视野
    Game.keys.KeyW = true;
    await sleep(1400);
    Game.keys.KeyW = false;
    await sleep(200);
    return {
      ok: true,
      weatherAmt: Math.round(w.weatherAmt * 100) / 100,
      puddles: (w.puddles || []).length,
      rainSize: w.rainPts ? w.rainPts.material.size : -1,
      rainOpacity: w.rainPts ? Math.round(w.rainPts.material.opacity * 100) / 100 : -1,
      carPos: Game.car ? [Math.round(Game.car.pos.x), Math.round(Game.car.pos.y), Math.round(Game.car.pos.z)] : null,
      err: window.__lastErr || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
})()
