// dev/verify_city3.js — GLB程序化城市导入验证
(async () => {
  const out = { ok: false };
  try {
    if (Game.mapIndex !== 3) await Game.switchMap(3);
    await new Promise(r => setTimeout(r, 800));
    const w = Game.world;
    out.map = { id: w.map.id, name: w.map.name };
    out.model = w.glbModel ? {
      meshes: (() => { let n = 0; w.glbModel.traverse(o => { if (o.isMesh) n++; }); return n; })(),
      pos: w.glbModel.position.toArray().map(v => +v.toFixed(1)),
    } : null;
    out.driveBounds = w.glbDriveBounds;
    out.colliders = { total: w.colliders.length, glb: w.colliders.filter(c => c.type === 'glbBuilding').length };
    out.roadBodies = (w.roadBodies || []).length;
    out.startLine = w.startLine ? { x: +w.startLine.x.toFixed(1), y: +w.startLine.y.toFixed(1), z: +w.startLine.z.toFixed(1) } : null;
    out.surface = w.getSurface(0, 20, 0);
    out.errors = { err: window.__err || null, worldError: window.__worldError || null };
    out.ok = !!out.model && out.roadBodies > 0 && !out.errors.err && !out.errors.worldError;
    Game.camera.position.set(0, w.terrainHeight(0, 0) + 90, 220);
    Game.camera.lookAt(0, w.terrainHeight(0, 0) + 15, 0);
    Game.camera.fov = 55; Game.camera.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 800));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
