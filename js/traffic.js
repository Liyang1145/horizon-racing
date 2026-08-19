// ============================================================
//  AI 车流 — 沿路网行驶的交通车辆
// ============================================================
'use strict';

class TrafficSystem {
  constructor(world, scene) {
    this.world = world;
    this.cars = [];
    // 只保留当前地图存在的路
    const want = ['coast', 'highway', 'village', 'highway_wind', 'village_highway',
      'forest', 'ring', 'cross', 'lakeloop', 'mountain', 'eastloop',
      'northway', 'northsouth', 'lakeconn', 'coastlink',
      'meadow', 'ridge', 'fieldconn', 'valley', 'northpass', 'southloop'];
    this.routePool = [];
    for (const id of want) { if (world.trafficRoutes.find(r => r.id === id)) this.routePool.push(id); }
    if (!this.routePool.length) this.routePool = [world.trafficRoutes[0].id];
    const colors = [0x2f6bb0, 0xb03434, 0xd8d8d8, 0x2f2f35, 0x9a7a34, 0x4a8a5a, 0x8a4a7a, 0x3a6a8a, 0xc8a12a];
    for (let i = 0; i < 16; i++) {
      const rid = this.routePool[i % this.routePool.length];
      const route = world.trafficRoutes.find(r => r.id === rid);
      const idx = (i * 137 + Math.random() * 200) % route.samples.length;
      const car = this.spawnCar(route, idx, pick(colors));
      this.cars.push(car);
    }
    // 立即把车摆到各自路线上，避免全部叠在原点（起点撞车堆）
    this.update(0, { x: 0, z: 0 }, 0);
    this.carMeshes = new THREE.Group();
    for (const c of this.cars) this.carMeshes.add(c.visual);
    scene.add(this.carMeshes);
  }

  spawnCar(route, idx, color) {
    const visual = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.5 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x16232e, metalness: 0.9, roughness: 0.1 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.55, 4.3), bodyMat);
    body.position.y = 0.62; body.castShadow = true;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.5, 2.0), glassMat);
    cabin.position.set(0, 1.05, -0.25);
    const wheels = [];
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x1a1c1f, roughness: 0.95 });
    for (const [wx, wz] of [[0.95, 1.35], [-0.95, 1.35], [0.95, -1.35], [-0.95, -1.35]]) {
      const w = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.24, 12), tireMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.34, wz);
      wheels.push(w);
    }
    visual.add(body, cabin, ...wheels);
    // 尾灯
    const tlMat = new THREE.MeshStandardMaterial({ color: 0x8a0d16, emissive: 0xcc1122, emissiveIntensity: 0.8 });
    for (const sx of [0.6, -0.6]) {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.12, 0.06), tlMat);
      tl.position.set(sx, 0.68, -2.16);
      visual.add(tl);
    }
    const speed = route.id === 'village' ? rand(9, 13) : route.id === 'highway' ? rand(18, 26) : rand(14, 19);
    return {
      route, idx: idx % route.samples.length, dir: Math.random() < 0.5 ? 1 : -1,
      speed: speed / 3.6, visual, wheels, bodyMat, color,
      lane: Math.random() < 0.5 ? 1 : 1, // 同侧车道
      brake: 0,
    };
  }

  update(dt, playerPos, playerSpeed) {
    const world = this.world;
    for (const c of this.cars) {
      const arr = c.route.samples;
      c.idx += c.dir * c.speed * dt / 4;
      const len = arr.length;
      if (c.idx >= len - 2) { if (c.route.closed) c.idx -= len - 2; else { c.dir *= -1; c.idx = len - 2; } }
      if (c.idx <= 1) { if (c.route.closed) c.idx += len - 2; else { c.dir *= -1; c.idx = 1; } }
      const i0 = Math.floor(c.idx), t = c.idx - i0;
      const s0 = arr[i0], s1 = arr[Math.min(i0 + 1, len - 1)];
      const x = lerp(s0.x, s1.x, t), z = lerp(s0.z, s1.z, t);
      const tx = s1.x - s0.x, tz = s1.z - s0.z;
      const tl = Math.hypot(tx, tz) || 1;
      const nx = -tz / tl, nz = tx / tl;
      const yaw = Math.atan2(tx, tz) + (c.dir < 0 ? Math.PI : 0);
      const h = world.terrainHeight(x, z);
      // 避让玩家：前方有车则刹车
      const dx = playerPos.x - x, dz = playerPos.z - z;
      const dist = Math.hypot(dx, dz);
      const ahead = (dx * tx + dz * tz) / tl > 0;
      let target = c.speed;
      if (ahead && dist < 22 && (dist < 12 || playerSpeed > 6)) {
        target = Math.min(target, Math.max(0, (dist - 5) * 1.2));
      }
      // 避让同行车辆
      for (const o of this.cars) {
        if (o === c) continue;
        if (o.route !== c.route || o.dir !== c.dir) continue;
        const oi = o.idx - c.idx;
        if (oi * c.dir > 0 && Math.abs(oi) * 4 < 14) target = Math.min(target, o.speed * 0.4);
      }
      c.speed = lerp(c.speed, target, Math.min(1, dt * 1.8));
      const side = c.dir > 0 ? 1 : -1;
      const laneOff = side * (c.route.samples[0].w / 2 - 1.35);
      c.visual.position.set(x + nx * laneOff, h, z + nz * laneOff);
      c.visual.rotation.set(0, yaw, 0);
      for (const w of c.wheels) w.rotation.x += c.speed * dt / 0.31;
    }
  }
}
