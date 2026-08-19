// dev/verify_city_drive2.js — 城市地面道路实车走行验证（配合 eval_async.mjs）
// 用法：
//   node "$env:TEMP\codo_tools\eval_async.mjs" <url> "@dev\verify_city_drive2.js" 1200 1500 720 "window.__stage==='input'" <shot.png>
(async () => {
  const out = { ok: false };
  try {
    if (Game.mapIndex !== 1) await Game.switchMap(1);
    await new Promise(r => setTimeout(r, 600));
    Game.start('free');
    await new Promise(r => setTimeout(r, 300));
    const w = Game.world, c = Game.car;
    const start = { x: c.pos.x, y: c.pos.y, z: c.pos.z };
    Game.keys = Game.keys || {};
    Game.keys['KeyW'] = true;
    await new Promise(r => setTimeout(r, 2000));
    Game.keys['KeyW'] = false;
    out.start = { x: +start.x.toFixed(1), y: +start.y.toFixed(1), z: +start.z.toFixed(1) };
    out.pos = { x: +c.pos.x.toFixed(1), y: +c.pos.y.toFixed(1), z: +c.pos.z.toFixed(1) };
    out.speed = +(c.speed || 0).toFixed(1);
    out.dist = +Math.hypot(c.pos.x - start.x, c.pos.z - start.z).toFixed(1);
    out.ground = +w.terrainHeight(c.pos.x, c.pos.z).toFixed(2);
    out.onGround = Math.abs(c.pos.y - out.ground) < 1.2;
    out.err = window.__err || null;
    out.ok = out.dist > 8 && out.speed > 0 && out.onGround && !out.err;
    const cam = Game.camera;
    cam.position.set(c.pos.x - 7, c.pos.y + 2, c.pos.z + 6);
    cam.lookAt(c.pos.x + 12, c.pos.y + 0.8, c.pos.z + 12);
    cam.fov = 54; cam.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 500));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
