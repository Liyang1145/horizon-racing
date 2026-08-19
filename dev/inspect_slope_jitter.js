// 探针：把车放到发夹弯(switchbacks)最陡的一段，高频率采样车身俯仰/竖直/相机，
// 区分“物理抖动”与“相机抖动”。
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  const std = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const detrend = a => { // 减去 5 点滑动平均，得到高频残余
    const out = [];
    for (let i = 0; i < a.length; i++) {
      let s = 0, n = 0;
      for (let j = Math.max(0, i - 2); j <= Math.min(a.length - 1, i + 2); j++) { s += a[j]; n++; }
      out.push(a[i] - s / n);
    }
    return out;
  };
  const signFlips = a => { let c = 0; for (let i = 1; i < a.length; i++) if (Math.sign(a[i]) !== Math.sign(a[i - 1]) && a[i] !== 0) c++; return c; };
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false);
    const c = Game.car, w = Game.world;
    await sleep(300);
    // 找发夹弯最陡的爬升段
    const r = w.trafficRoutes.find(x => x.id === 'switchbacks') || w.trafficRoutes[0];
    const arr = r.samples;
    let best = -1, bestSlope = 0, bestI = 0;
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      const d = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const sl = Math.abs(b.h - a.h) / d;
      if (sl > bestSlope) { bestSlope = sl; bestI = i; best = sl; }
    }
    // 沿上坡方向摆放
    const a = arr[bestI], b = arr[bestI + 1];
    const up = b.h >= a.h ? b : a;
    const lo = b.h >= a.h ? a : b;
    const yaw = Math.atan2(up.x - lo.x, up.z - lo.z);
    c.reset(new THREE.Vector3(lo.x, lo.h + 0.1, lo.z), yaw);
    await sleep(700); // 悬挂落地
    // 满油门 ~2.5s，用 requestAnimationFrame 按真实帧率采样
    Game.keys.KeyW = true;
    const S = { pitchRate: [], vy: [], vx: [], vz: [], bodyX: [], bodyY: [], bodyZ: [], camX: [], camY: [], camZ: [], speed: [] };
    await new Promise(resolve => {
      const t0 = performance.now();
      const tick = () => {
        if (performance.now() - t0 > 2500) return resolve();
        const b = c.body;
        S.pitchRate.push(b.angularVelocity.x);
        S.vy.push(b.velocity.y);
        S.vx.push(b.velocity.x);
        S.vz.push(b.velocity.z);
        S.bodyX.push(b.position.x); S.bodyY.push(b.position.y); S.bodyZ.push(b.position.z);
        const cp = Game.camera.position;
        S.camX.push(cp.x); S.camY.push(cp.y); S.camZ.push(cp.z);
        S.speed.push(c.speedKmh);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    Game.keys.KeyW = false;
    const prD = detrend(S.pitchRate), vyD = detrend(S.vy);
    return {
      ok: true,
      routeId: r.id, sampleAt: bestI, slope: r3(bestSlope),
      n: S.pitchRate.length,
      speedKmh_avg: r3(S.speed.reduce((x, y) => x + y, 0) / S.speed.length),
      speedKmh_max: r3(Math.max(...S.speed)),
      grounded: c.grounded,
      // 物理抖动（去趋势高频残余）：水平 + 竖直 + 俯仰
      bodyX_std: r3(std(detrend(S.bodyX))), bodyZ_std: r3(std(detrend(S.bodyZ))),
      bodyY_std: r3(std(detrend(S.bodyY))),
      vx_std: r3(std(detrend(S.vx))), vz_std: r3(std(detrend(S.vz))), vy_std: r3(std(vyD)),
      vy_maxAbs: r3(Math.max(...S.vy.map(Math.abs))),
      pitchRate_std: r3(std(prD)), pitchRate_maxAbs: r3(Math.max(...S.pitchRate.map(Math.abs))), pitchRate_flips: signFlips(prD),
      // 相机抖动（去趋势高频残余，应≈车身）
      camX_std: r3(std(detrend(S.camX))), camY_std: r3(std(detrend(S.camY))), camZ_std: r3(std(detrend(S.camZ))),
      err: window.__lastErr || window.__startError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null, startErr: window.__startError || null };
  }
})()
