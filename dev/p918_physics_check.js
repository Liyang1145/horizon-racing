(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    const c = Game.car;
    await sleep(700);
    const y0 = c.yaw;
    Game.keys.KeyW = true;
    Game.keys.KeyA = true;
    const t0 = performance.now();
    const trace = [];
    while (performance.now() - t0 < 3000) {
      await sleep(150);
      trace.push({ t: r3((performance.now() - t0) / 1000), v: r3(c.speedKmh), yaw: r3(c.yaw) });
    }
    const y1 = c.yaw;
    Game.keys.KeyW = false;
    Game.keys.KeyA = false;
    let dy = y1 - y0;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    return {
      ok: true,
      carId: c.spec.id,
      grounded: c.grounded,
      finalSpeedKmh: r3(c.speedKmh),
      dyawDeg: r3(dy * 180 / Math.PI),
      trace: trace.slice(0, 6).concat(trace.slice(-4)),
      err: window.__lastErr || null,
      startErr: window.__startError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null, startErr: window.__startError || null };
  }
})()
