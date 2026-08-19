// 验证城市地图：切换到霓虹都市，检查建筑/路灯/全息/错误
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const r3 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1000) / 1000 : v;
  try {
    await Game.switchMap(1);
    await sleep(400);
    const w = Game.world;
    const buildings = (w.colliders || []).filter(c => c.type === 'building').length;
    const lamps = (w.colliders || []).filter(c => c.type === 'lamp').length;
    // 数一下场景里 cityTower / NeonSign / 全息（统计 tower group）
    let towerCount = 0, neonCount = 0;
    w.scene.traverse(o => {
      if (o.name === 'cityTower') towerCount++;
      if (o.name === 'NeonSign') neonCount++;
    });
    return {
      ok: true,
      mapId: w.map.id, mapName: w.map.name,
      roadCount: (w.roadBodies || []).length,
      towerCount, neonCount, buildings, lamps,
      terrainAtCenter: r3(w.terrainHeight(0, 0)),
      err: window.__lastErr || window.__startError || window.__worldError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || window.__worldError || null };
  }
})()
