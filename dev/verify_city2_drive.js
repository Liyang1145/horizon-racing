// dev/verify_city2_drive.js — 海特洛2 地面走行验证
(async () => {
  const out = { ok: false };
  try {
    if (Game.mapIndex !== 2) await Game.switchMap(2);
    await new Promise(r => setTimeout(r, 600));
    Game.start('free');
    await new Promise(r => setTimeout(r, 300));
    const w = Game.world, c = Game.car;
    const start = { x: c.pos.x, z: c.pos.z };
    Game.keys = Game.keys || {};
    Game.keys['KeyW'] = true;
    await new Promise(r => setTimeout(r, 2000));
    Game.keys['KeyW'] = false;
    out.dist = +Math.hypot(c.pos.x - start.x, c.pos.z - start.z).toFixed(1);
    out.speed = +(c.speed || 0).toFixed(1);
    out.onGround = Math.abs(c.pos.y - w.terrainHeight(c.pos.x, c.pos.z)) < 1.2;
    out.err = window.__err || null;
    out.ok = out.dist > 8 && out.speed > 0 && out.onGround && !out.err;
    Game.camera.position.set(c.pos.x - 7, c.pos.y + 2, c.pos.z + 6);
    Game.camera.lookAt(c.pos.x + 12, c.pos.y + 0.8, c.pos.z + 12);
    Game.camera.fov = 54; Game.camera.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 500));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && e.message;
    return JSON.stringify(out);
  }
})();
