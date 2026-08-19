// 验证雨天：水坑、湿路、云、天空
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    const w = Game.world;
    w.hour = 12;
    w.weather = 1; // 雨
    for (let i = 0; i < 120; i++) { w.updateWeather(1 / 30, { x: 0, z: 0 }); }
    await sleep(100);
    const puddles = w.puddles || [];
    const visPuddles = puddles.filter(p => p.material.opacity > 0.01).length;
    return {
      ok: true,
      weather: w.weather, weatherAmt: r3(w.weatherAmt),
      puddleCount: puddles.length, visPuddles,
      puddleOpacity: puddles.length ? r3(puddles[0].material.opacity) : -1,
      roadRoughness: w.roadMats && w.roadMats[0] ? r3(w.roadMats[0].roughness) : -1,
      roadEnvMap: w.roadMats && w.roadMats[0] ? r3(w.roadMats[0].envMapIntensity) : -1,
      cloudCoverage: w.cloudUniforms ? r3(w.cloudUniforms.uCoverage.value) : -1,
      err: window.__lastErr || window.__startError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null };
  }
})()
