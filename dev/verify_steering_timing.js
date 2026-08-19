// dev/verify_steering_timing.js — 方向盘平滑时间曲线（配合 dev/eval_async.mjs 使用）
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const out = {};
  try {
    Game.start();
    await sleep(300);
    const curve = (label, idx) => {
      const c = Game.car;
      const s = { t: 0, steer: +c.steer.toFixed(3), vis: +c.steerVisual.toFixed(3) };
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
      return (async () => {
        const pts = [s];
        for (let i = 1; i <= 10; i++) {
          await sleep(150);
          pts.push({ t: i * 150, steer: +c.steer.toFixed(3), vis: +c.steerVisual.toFixed(3) });
        }
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }));
        await sleep(400);
        pts.push({ t: 'rel', steer: +c.steer.toFixed(3), vis: +c.steerVisual.toFixed(3) });
        out[label] = pts;
      })();
    };
    await curve('p918', CAR_SPECS.findIndex(x => x.id === 'p918'));
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false);
    await sleep(200);
    await curve('gt', CAR_SPECS.findIndex(x => x.id === 'gt'));
    out.err = window.__err || window.__rej || null;
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
