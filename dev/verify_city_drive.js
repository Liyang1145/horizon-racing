// 城市地图开车视角截图：切到城市、进入自由漫游、开车穿街、看真实街道密度
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await Game.switchMap(1);
    await sleep(300);
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    await sleep(400);
    // 沿 h2 路（z=0）向东开，穿过城市街区
    Game.keys.KeyW = true;
    await sleep(2500);
    Game.keys.KeyW = false;
    return {
      ok: true,
      mapId: Game.world.map.id,
      carPos: [Math.round(Game.car.pos.x), Math.round(Game.car.pos.y), Math.round(Game.car.pos.z)],
      speedKmh: Math.round(Game.car.speedKmh),
      err: window.__lastErr || window.__startError || window.__worldError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || window.__worldError || null };
  }
})()
