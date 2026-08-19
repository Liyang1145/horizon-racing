// dev/verify_city3_drive.js — 在GLB模型街道上实车走行
(async () => {
  const out = { ok: false };
  try {
    if (Game.mapIndex !== 3) await Game.switchMap(3);
    await new Promise(r => setTimeout(r, 800));
    const w = Game.world;
    const roadMats = ['street', 'lane', 'side_walk', 'curb'];
    let target = null;
    w.glbModel.traverse(o => {
      if (target || !o.isMesh || !o.geometry || !o.geometry.index) return;
      const n = String((o.material && o.material.name) || '').toLowerCase();
      if (!roadMats.some(k => n.indexOf(k) !== -1)) return;
      const idx = o.geometry.index, pos = o.geometry.attributes.position;
      if (!pos) return;
      // 找一个朝向近似水平的三角形
      for (let i = 0; i < idx.count; i += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i));
        const b = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i + 1));
        const c = new THREE.Vector3().fromBufferAttribute(pos, idx.getX(i + 2));
        const nrm = new THREE.Triangle(a, b, c).getNormal(new THREE.Vector3());
        if (Math.abs(nrm.y) > 0.7) {
          target = a.add(b).add(c).divideScalar(3).applyMatrix4(w.glbModel.matrixWorld);
          break;
        }
      }
    });
    if (!target) { out.error = 'no road triangle'; return JSON.stringify(out); }
    out.teleport = target.toArray().map(v => +v.toFixed(1));
    Game.start('free');
    await new Promise(r => setTimeout(r, 400));
    const c = Game.car;
    c.reset(new THREE.Vector3(target.x, target.y + 0.5, target.z), 0);
    Game.keys = Game.keys || {};
    Game.keys['KeyW'] = true;
    await new Promise(r => setTimeout(r, 1800));
    Game.keys['KeyW'] = false;
    out.pos = { x: +c.pos.x.toFixed(1), y: +c.pos.y.toFixed(1), z: +c.pos.z.toFixed(1) };
    out.speed = +(c.speed || 0).toFixed(1);
    out.surface = w.getSurface(c.pos.x, c.pos.z, c.pos.y);
    out.aboveRoad = Math.abs(c.pos.y - target.y) < 1.5;
    out.ok = out.speed > 2 && out.aboveRoad;
    Game.camera.position.set(c.pos.x - 8, c.pos.y + 4, c.pos.z + 8);
    Game.camera.lookAt(c.pos.x + 20, c.pos.y + 1, c.pos.z + 20);
    Game.camera.fov = 52; Game.camera.updateProjectionMatrix();
    await new Promise(r => setTimeout(r, 700));
    return JSON.stringify(out);
  } catch (e) {
    out.error = e && e.message;
    return JSON.stringify(out);
  }
})();
