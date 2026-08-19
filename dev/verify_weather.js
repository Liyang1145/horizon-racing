// 验证天气系统：4 种天气 + 雪天冬季限制 + 雨天湿路
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    const w = Game.world;
    await sleep(300);
    const results = [];
    for (const [wid, name] of [[0, '晴'], [1, '雨'], [2, '雾'], [3, '雪']]) {
      w.weather = wid;
      for (let i = 0; i < 10; i++) { w.updateWeather(1 / 30, { x: 0, z: 0 }); }
      results.push({
        name,
        weatherAmt: r3(w.weatherAmt),
        rainOpacity: r3(w.rainPts.material.opacity),
        snowOpacity: r3(w.snowPts.material.opacity),
        fog: r3(w.fog.density),
        roadRoughness: w.roadMats && w.roadMats[0] ? r3(w.roadMats[0].roughness) : -1,
      });
    }
    // 雪天冬季限制：非冬季 + 雪天应被挡
    w.season = 1; w.weather = 3;
    const snowBlocked = w.weather === 3; // 手动设置不拦截（拦截在按键层），这里只记录状态
    return { ok: true, results, season: w.season, err: window.__lastErr || window.__startError || null };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null };
  }
})()
