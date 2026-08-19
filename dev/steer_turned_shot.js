// dev/steer_turned_shot.js — 方向盘左满舵截图的页面端准备（配合 dev/eval_async.mjs 使用）
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  try {
    Game.start();
    await sleep(900);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    await sleep(900);
    Game.camMode = 1;
    if (UI && UI.hideMsg) UI.hideMsg();
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    await sleep(300);
    out.car = Game.car.spec.id;
    out.steer = +Game.car.steer.toFixed(3);
    out.vis = +Game.car.steerVisual.toFixed(3);
    out.err = window.__err || null;
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
