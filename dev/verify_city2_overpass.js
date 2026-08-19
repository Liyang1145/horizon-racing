// dev/verify_city2_overpass.js — 海特洛2 高架走行验证
(async () => {
  const out = { ok: false };
  try {
    if (Game.mapIndex !== 2) await Game.switchMap(2);
    await new Promise(r => setTimeout(r, 600));
    const w = Game.world;
    const op = w.overpasses && w.overpasses[0];
    const deck = op.decks.find(d => d.kind === 'main');
    const idx = Math.floor(deck.pts.length * 0.55);
    const mid = deck.pts[idx];
    const nxt = deck.pts[Math.min(idx + 6, deck.pts.length - 1)];
    const yaw = Math.atan2(nxt.x - mid.x, nxt.z - mid.z);
    Game.start('free');
    await new Promise(r => setTimeout(r, 400));
    const c = Game.car;
    c.reset(new THREE.Vector3(mid.x, mid.y + 0.5, mid.z), yaw);
    Game.keys = Game.keys || {};
    Game.keys['KeyW'] = true;
    await new Promise(r => setTimeout(r, 1200));
    Game.keys['KeyW'] = false;
    out.pos = { x: +c.pos.x.toFixed(1), y: +c.pos.y.toFixed(1), z: +c.pos.z.toFixed(1) };
    out.speed = +(c.speed || 0).toFixed(1);
    out.deckY = +mid.y.toFixed(1);
    out.surface = w.getSurface(c.pos.x, c.pos.z, c.pos.y);
    out.aboveGround = Math.abs(c.pos.y - (out.deckY + 0.1)) < 1.4;
    out.onRoad = !!(out.surface && out.surface.road);
    out.ok = out.aboveGround && out.onRoad && out.speed > 2;
    Game.camera.position.set(mid.x - 8, mid.y + 2.2, mid.z + 6);
    Game.camera.lookAt(mid.x + 20, mid.y + 0.8, mid.z);
    Game.camera.fov = 52; Game.camera.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 500));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && e.message;
    return JSON.stringify(out);
  }
})();
