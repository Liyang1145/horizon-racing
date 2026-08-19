// dev/verify_steering.js — 方向盘视觉验证（配合 dev/eval_async.mjs 使用）
// 用法：
//   node dev\eval_async.mjs "file:///C:/你的本地路径/horizon-racing/index.html" "@dev\verify_steering.js" 1000 1280 720 "window.__stage==='input'" shots\steer_918_cockpit.png
(async () => {
  const out = { ok: false };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const qSnap = rigs => rigs.map(r => r.node.quaternion.toArray().map(v => +v.toFixed(3)));
  const qDiff = (a, b) => {
    let n = 0;
    for (let i = 0; i < a.length; i++) {
      let changed = false;
      for (let j = 0; j < 4; j++) if (Math.abs(a[i][j] - b[i][j]) > 0.02) changed = true;
      if (changed) n++;
    }
    return n;
  };
  try {
    out.boot = { stage: window.__stage, err: window.__err || null, rej: window.__rej || null };
    Game.start();
    await sleep(200);
    const car = Game.car;
    out.car = car.spec.id;

    // ---- 保时捷 918：12 个 Steering* 节点应全部一起旋转 ----
    const rigs = car.steerWheels || [];
    out.p918 = { parts: rigs.length };
    out.p918.names = rigs.map(r => r.node.name || (r.node.type || 'node'));
    out.p918.q0 = qSnap(rigs);
    out.p918.s0 = { steer: +car.steer.toFixed(3), vis: +car.steerVisual.toFixed(3) };
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    await sleep(70);
    out.p918.mid = { steer: +car.steer.toFixed(3), vis: +car.steerVisual.toFixed(3), q: qSnap(rigs) };
    await sleep(630);
    out.p918.held = { steer: +car.steer.toFixed(3), vis: +car.steerVisual.toFixed(3), q: qSnap(rigs) };
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }));
    await sleep(120);
    out.p918.rel = { steer: +car.steer.toFixed(3), vis: +car.steerVisual.toFixed(3), q: qSnap(rigs) };
    await sleep(500);
    out.p918.returned = { steer: +car.steer.toFixed(3), vis: +car.steerVisual.toFixed(3), q: qSnap(rigs) };
    const h = out.p918.held, m = out.p918.mid, r = out.p918.returned;
    out.p918.rotatedParts = qDiff(out.p918.q0, h.q);
    out.p918.checks = {
      parts12: out.p918.parts === 12,
      heldNegative: h.vis < -0.15,
      midSmoothBetween: m.vis < -0.01 && m.vis > h.vis,
      releaseLag: out.p918.rel.vis < -0.02,           // 松键后视觉角仍滞后于物理
      returnedNearZero: Math.abs(r.vis) < 0.05,
      allPartsRotated: out.p918.rotatedParts === out.p918.parts,
      noErrors: !(window.__err || window.__rej || window.__startError),
    };

    // ---- GT：轮圈 + 辐条 rig 一起平滑旋转 ----
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'gt'), false);
    const gt = Game.car;
    const grigs = gt.steerWheels || [];
    out.gt = { parts: grigs.length, names: grigs.map(r => r.node.name || (r.node.type || 'node')) };
    out.gt.q0 = qSnap(grigs);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    await sleep(500);
    out.gt.held = { steer: +gt.steer.toFixed(3), vis: +gt.steerVisual.toFixed(3), q: qSnap(grigs) };
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA' }));
    await sleep(300);
    out.gt.returned = { steer: +gt.steer.toFixed(3), vis: +gt.steerVisual.toFixed(3), q: qSnap(grigs) };
    out.gt.rotatedParts = qDiff(out.gt.q0, out.gt.held.q);
    out.gt.checks = {
      parts1: out.gt.parts === 1,
      heldNegative: out.gt.held.vis < -0.25,
      allPartsRotated: out.gt.rotatedParts === out.gt.parts,
      returnedSmooth: out.gt.returned.vis < 0 && Math.abs(out.gt.returned.vis) < Math.abs(out.gt.held.vis),
    };

    // ---- 回到 918 并保持左转向 + 驾驶舱视角，供截图 ----
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA' }));
    await sleep(700);
    Game.camMode = 1;
    if (UI && UI.hideMsg) UI.hideMsg();
    const hud = document.getElementById('hud');
    if (hud) hud.style.display = 'none';
    out.screenshot = {
      car: Game.car.spec.id,
      camMode: Game.camMode,
      steer: +Game.car.steer.toFixed(3),
      steerVisual: +Game.car.steerVisual.toFixed(3),
    };

    out.ok = out.p918.checks.parts12 && out.p918.checks.allPartsRotated
      && out.p918.checks.midSmoothBetween && out.gt.checks.allPartsRotated && out.p918.checks.noErrors;
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && (e.stack || e.message);
    return JSON.stringify(out);
  }
})();
