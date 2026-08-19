// dev/verify_city2.js — 海特洛2（v4路网）浏览器端生成验证
(async () => {
  const out = { ok: false };
  try {
    out.before = { mapIndex: Game.mapIndex, stage: window.__stage, err: window.__err || null };
    if (Game.mapIndex !== 2) await Game.switchMap(2);
    await new Promise(r => setTimeout(r, 800));
    const w = Game.world;
    out.map = { id: w.map.id, name: w.map.name, mapIndex: Game.mapIndex };
    out.scene = { children: w.scene.children.length, cityRootChildren: w.cityRoot ? w.cityRoot.children.length : 0 };
    out.city = {
      lots: (window.CITY && CITY.lots || []).length,
      stages: window.CITY && CITY.stats && Object.keys(CITY.stats.stages || {}).length,
      junctions: (window.CITY && CITY.junctions || []).length,
    };
    out.overpass = { defs: (w.overpasses || []).length, surfaces: (w.citySurfaces || []).length, roadBodies: (w.roadBodies || []).length };
    out.roads = (w.trafficRoutes || []).map(r => r.id);
    out.colliders = { total: (w.colliders || []).length };
    out.startLine = w.startLine ? { x: +w.startLine.x.toFixed(2), y: +w.startLine.y.toFixed(2), z: +w.startLine.z.toFixed(2) } : null;
    out.heights = {
      spawn: +w.terrainHeight(w.startLine.x, w.startLine.z).toFixed(2),
      coast: +w.terrainHeight(0, -1529).toFixed(2),
      cbd: +w.terrainHeight(-450, 800).toFixed(2),
    };
    out.errors = { err: window.__err || null, worldError: window.__worldError || null };
    out.ok = !out.errors.err && !out.errors.worldError && out.map.id === 'city2';
    Game.camera.position.set(0, 220, 1000);
    Game.camera.lookAt(0, 20, 0);
    Game.camera.fov = 55; Game.camera.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 600));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
