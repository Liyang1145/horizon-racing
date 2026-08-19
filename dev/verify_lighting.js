// 验证光照/材质/车灯改动：夜晚 + F8 优化模式，检查车漆/车灯状态
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    Game.start('free');
    if (Game.traffic) Game.traffic.cars = [];
    Game.spawnCar(CAR_SPECS.findIndex(x => x.id === 'p918'), false);
    const c = Game.car, w = Game.world;
    await sleep(300);
    // 夜晚 + F8 优化模式
    w.hour = 23.5;
    w.lightClassic = false;
    w.scene.environment = w.envDay || null;
    w.updateSky(c.pos);
    c.setLights(1);
    // 采样车漆与车灯
    const paintInfo = [];
    c.visual.traverse(o => {
      if (o.isMesh && o.material && (o.material.name || '').indexOf('Body_Paint') >= 0) {
        const m = o.material;
        paintInfo.push({ color: '#' + m.color.getHexString(), metalness: m.metalness, roughness: m.roughness });
      }
    });
    const headCount = (c.headLights || []).length;
    const headIntensity = headCount ? c.headLights[0].intensity : -1;
    const headPos = headCount ? [c.headLights[0].position.x, c.headLights[0].position.y, c.headLights[0].position.z] : null;
    // 调试：找模型里所有含 Headlight 的对象及其世界位置
    const hlFound = [];
    c.visual.traverse(o => {
      if (/headlight/i.test(o.name || '')) {
        const v = new THREE.Vector3();
        o.getWorldPosition(v);
        hlFound.push({ name: o.name, isMesh: !!o.isMesh, wp: [Math.round(v.x*100)/100, Math.round(v.y*100)/100, Math.round(v.z*100)/100] });
      }
    });
    return {
      ok: true,
      hour: w.hour, lightClassic: w.lightClassic, darkness: w.darkness,
      sunIntensity: w.sun.intensity, hemiIntensity: w.hemi.intensity, fillIntensity: w.fill.intensity,
      paintInfo: paintInfo.slice(0, 2),
      headCount, headIntensity, headPos, hlFound,
      err: window.__lastErr || window.__startError || null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || null };
  }
})()
