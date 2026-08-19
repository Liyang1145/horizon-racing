// 测量发夹弯道路剖面坡度变化率：判断坡度是否还有高频毛刺（物理震动输入源）
(async () => {
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  const std = a => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
  const flips = a => { let c = 0; for (let i = 1; i < a.length; i++) if (Math.sign(a[i]) !== Math.sign(a[i - 1])) c++; return c; };
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    const w = Game.world;
    const r = w.trafficRoutes.find(x => x.id === 'switchbacks') || w.trafficRoutes[0];
    const arr = r.samples;
    const closed = arr[0].closed;
    // 1) 采样点高度序列的相邻坡度
    const segSlope = [];
    for (let i = 0; i < arr.length - 1; i++) {
      const d = Math.hypot(arr[i + 1].x - arr[i].x, arr[i + 1].z - arr[i].z) || 1;
      segSlope.push((arr[i + 1].h - arr[i].h) / d);
    }
    const dgSamples = [];
    for (let i = 1; i < segSlope.length; i++) dgSamples.push(segSlope[i] - segSlope[i - 1]);
    // 2) Catmull-Rom 插值剖面在细步长(0.5m)下的坡度变化
    const STEP = 0.5, SUB = 8;
    const cr = [];
    for (let i = 0; i < arr.length - 1; i++) {
      const a = arr[i], b = arr[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const m = Math.max(1, Math.round(len / STEP));
      for (let k = 0; k < m; k++) {
        const t = k / m;
        cr.push({
          d: a.d + (b.d - a.d) * t,
          h: w.roadProfileHeight(arr, closed, i, t),
        });
      }
    }
    const crSlope = [];
    for (let i = 1; i < cr.length; i++) {
      const dd = cr[i].d - cr[i - 1].d || 1;
      crSlope.push((cr[i].h - cr[i - 1].h) / dd);
    }
    const dgCR = [];
    for (let i = 1; i < crSlope.length; i++) dgCR.push(crSlope[i] - crSlope[i - 1]);
    return {
      ok: true,
      routeId: r.id, n: arr.length, len: r3(arr[arr.length - 1].d),
      segSlope_std: r3(std(segSlope)), segSlope_maxAbs: r3(Math.max(...segSlope.map(Math.abs))),
      dgSamples_std: r3(std(dgSamples)), dgSamples_maxAbs: r3(Math.max(...dgSamples.map(Math.abs))), dgSamples_flips: flips(dgSamples),
      cr_n: cr.length,
      crSlope_std: r3(std(crSlope)), crSlope_maxAbs: r3(Math.max(...crSlope.map(Math.abs))),
      dgCR_std: r3(std(dgCR)), dgCR_maxAbs: r3(Math.max(...dgCR.map(Math.abs))), dgCR_flips: flips(dgCR),
      err: window.__lastErr || window.__startError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null, startErr: window.__startError || null };
  }
})()
