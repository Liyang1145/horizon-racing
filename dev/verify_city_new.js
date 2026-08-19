// dev/verify_city_new.js — 浏览器端城市地图生成验证（配合 eval_async.mjs 使用）
// 用法：
//   node "$env:TEMP\codo_tools\eval_async.mjs" <url> "@dev\verify_city_new.js" 1200 1500 720 "window.__stage==='input'" <shot.png>
(async () => {
  const out = { ok: false };
  try {
    out.before = { mapIndex: Game.mapIndex, stage: window.__stage, err: window.__err || null };
    if (Game.mapIndex !== 1) await Game.switchMap(1);
    await new Promise(r => setTimeout(r, 800));
    const w = Game.world;
    out.map = { id: w.map.id, name: w.map.name, mapIndex: Game.mapIndex };
    out.scene = {
      children: w.scene.children.length,
      cityRoot: !!(w.cityRoot && w.cityRoot.children.length),
      cityRootChildren: w.cityRoot ? w.cityRoot.children.length : 0,
    };
    out.city = {
      lots: (window.CITY && CITY.lots || []).length,
      stages: window.CITY && CITY.stats && Object.keys(CITY.stats.stages || {}).length,
      junctions: (window.CITY && CITY.junctions || []).length,
      reserved: (window.CITY && CITY.reserved || []).length,
    };
    out.overpass = {
      defs: (w.overpasses || []).length,
      surfaces: (w.citySurfaces || []).length,
      roadBodies: (w.roadBodies || []).length,
    };
    const col = w.colliders || [];
    out.colliders = {
      total: col.length,
      building: col.filter(c => c.type === 'building').length,
      bridgePier: col.filter(c => c.type === 'bridgePier').length,
      tree: col.filter(c => c.type === 'tree').length,
      lamp: col.filter(c => c.type === 'lamp').length,
    };
    out.startLine = w.startLine ? { x: +w.startLine.x.toFixed(2), y: +w.startLine.y.toFixed(2), z: +w.startLine.z.toFixed(2) } : null;
    const sl = w.startLine;
    const hAt = (x, z) => +w.terrainHeight(x, z).toFixed(2);
    out.heights = {
      spawn: sl ? hAt(sl.x, sl.z) : null,
      cbd: hAt(-180, 720),
      old: hAt(-430, -640),
      beach: hAt(0, -1500),
      skywayMid: hAt(0, 520),
    };
    if (w.overpasses && w.overpasses[0] && w.overpasses[0].decks[0]) {
      const p = w.overpasses[0].decks[0].pts;
      const mid = p[Math.floor(p.length / 2)];
      out.heights.skywayDeck = +mid.y.toFixed(2);
    }
    out.errors = { err: window.__err || null, worldError: window.__worldError || null, lastErr: window.__lastErr || null };
    out.ok = !out.errors.err && !out.errors.worldError && out.map.id === 'city';
    // 注意 getSurface 签名是 (x, z, y)
    // 摆相机看 CBD（默认黄昏）
    const c = Game.camera;
    c.position.set(30, 26, 210);
    c.lookAt(0, 70, 820);
    c.fov = 58; c.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 600));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
