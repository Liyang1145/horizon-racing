// 客观统计霓虹都市场景对象：确认广告牌/光池/光尘/高楼数量，避免依赖软渲染截图
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  try {
    await Game.switchMap(1);
    await sleep(400);
    const scene = Game.world.scene;
    let towers = 0, billboards = 0, neonSigns = 0, glowPools = 0, motes = 0, lamps = 0, holo = 0;
    const billPos = [];
    scene.traverse(o => {
      if (!o.isObject3D) return;
      const n = o.name || '';
      if (n === 'cityTower') towers++;
      else if (n === 'NeonBillboard') { billboards++; billPos.push([Math.round(o.getWorldPosition(new THREE.Vector3()).x), Math.round(o.getWorldPosition(new THREE.Vector3()).y), Math.round(o.getWorldPosition(new THREE.Vector3()).z)]); }
      else if (n === 'NeonSign') neonSigns++;
      else if (n === 'streetLamp' || n === 'StreetLamp') lamps++;
      else if (n && n.indexOf('Holo') >= 0) holo++;
      // 光池：加法混合透明圆面
      if (o.isMesh && o.material && o.material.blending === THREE.AdditiveBlending && o.material.transparent && o.geometry && o.geometry.type === 'CircleGeometry') glowPools++;
    });
    motes = Game.world.cityMotes ? Game.world.cityMotes.geometry.attributes.position.count : 0;
    // 距离行车道路 z=0 最近的 8 块广告牌
    const nearRoad = billPos.slice().sort((a, b) => Math.abs(a[2]) - Math.abs(b[2])).slice(0, 8);
    return {
      ok: true,
      towers, billboards, neonSigns, glowPools, motes, lamps, holo,
      billboardsNearRoadZ0: nearRoad,
      colliders: (Game.world.colliders || []).length,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.stack || e), lastErr: window.__lastErr || window.__worldError || null };
  }
})()
