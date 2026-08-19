// 尾灯拖尾验证：夜晚驾驶 918，确认 8 个小发光片各发红光拖尾
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    const w = Game.world;
    w.hour = 22;
    w.updateSky();
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    await sleep(600);
    Game.keys.KeyW = true;
    await sleep(2500);
    const tt = w.tailTrail;
    return {
      ok: true,
      tailLightCount: Game.car.tailLightLocal ? Game.car.tailLightLocal.length : -1,
      widths: Game.car.tailLightWidths || null,
      histories: tt ? tt.histories.length : -1,
      histLen0: tt && tt.histories[0] ? tt.histories[0].length : -1,
      speedKmh: Math.round(Game.car.speedKmh),
      err: window.__lastErr || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e) };
  }
})()
