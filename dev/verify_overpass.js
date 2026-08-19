// dev/verify_overpass.js — 高架桥物理走行验证（配合 eval_async.mjs 使用）
// 用法：
//   node "$env:TEMP\codo_tools\eval_async.mjs" <url> "@dev\verify_overpass.js" 1200 1500 720 "window.__stage==='input'" <shot.png>
(async () => {
  const out = { ok: false };
  try {
    if (Game.mapIndex !== 1) await Game.switchMap(1);
    await new Promise(r => setTimeout(r, 600));
    const w = Game.world;
    const op = w.overpasses && w.overpasses[0];
    if (!op) { out.error = 'no overpass data'; return JSON.stringify(out); }
    const deck = op.decks.find(d => d.kind === 'main');
    const idx = Math.floor(deck.pts.length * 0.55);
    const mid = deck.pts[idx];
    const nxt = deck.pts[Math.min(idx + 6, deck.pts.length - 1)];
    const yaw = Math.atan2(nxt.x - mid.x, nxt.z - mid.z);
    // 把车放到桥面中段，车头沿桥面切线（避免横穿桥面造成侧向漂移）
    Game.start('free');
    await new Promise(r => setTimeout(r, 400));
    const c = Game.car;
    c.reset(new THREE.Vector3(mid.x, mid.y + 0.5, mid.z), yaw);
    c.setVelocity(new THREE.Vector3(0, 0, 0));
    Game.keys = Game.keys || {};
    Game.keys['KeyW'] = true;
    await new Promise(r => setTimeout(r, 1200));
    Game.keys['KeyW'] = false;
    out.pos = { x: +c.pos.x.toFixed(1), y: +c.pos.y.toFixed(1), z: +c.pos.z.toFixed(1) };
    out.speed = +((c.speed || 0)).toFixed(1);
    out.deckY = +mid.y.toFixed(1);
    out.groundY = +w.terrainHeight(mid.x, mid.z).toFixed(1);
    out.surface = w.getSurface(c.pos.x, c.pos.z, c.pos.y);
    out.aboveGround = Math.abs(c.pos.y - (out.deckY + 0.1)) < 1.4;
    out.onRoad = !!(out.surface && out.surface.road);
    out.moved = out.speed > 2;
    out.ok = out.aboveGround && out.onRoad && out.moved;
    // 相机上桥
    const cam = Game.camera;
    cam.position.set(mid.x - 8, mid.y + 2.2, mid.z + 6);
    cam.lookAt(mid.x + 20, mid.y + 0.8, mid.z);
    cam.fov = 52; cam.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 600));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
