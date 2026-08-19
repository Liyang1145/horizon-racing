// ============================================================
//  界面 — 菜单 / HUD / 表盘 / 迷你地图 / 弹窗
// ============================================================
'use strict';

const $ = id => document.getElementById(id);

const UI = {
  els: {}, carIndex: 0, state: { season: 1, weather: 0, hour: 9.5 },
  raf: 0, lastMenuT: 0,

  init() {
    for (const id of ['game','loading','loadFill','loadTxt','menu','menuCanvas','btnFree','btnRace','btnAIDemo','btnRoutePatrol','btnTune','tuneBox',
      'carPrev','carNext','carName','carEngine','stTop','stAcc','stHand','stDrift','carDesc',
      'seasonChips','weatherChips','timeChips','mapChips','vol','tDrift','tDriftV','tCounter','tCounterV',
      'tSmall','tSmallV','tRearGrip','tRearGripV','tHandbrake','tHandbrakeV','hud','speedFx','minimap','gauge','gear','speedNum',
      'rpmFill','score','popups','msg','msgBig','msgSub','toast','hint','help','racePanel',
      'raceTime','raceDelta','raceCheck','racePar','racePos','pause','btnResume','btnRestart','btnToMenu','topInfo',
      'bigmap','bigmapCanvas','bigmapInfo']) {
      this.els[id] = $(id);
    }
    this.buildChips();
    if (this.els.carPrev) this.els.carPrev.onclick = () => {
      this.carIndex = (this.carIndex + CAR_SPECS.length - 1) % CAR_SPECS.length;
      this.updateCarCard();
      if (Game.state === 'menu') Game.setMenuCar(this.carIndex);
    };
    if (this.els.carNext) this.els.carNext.onclick = () => {
      this.carIndex = (this.carIndex + 1) % CAR_SPECS.length;
      this.updateCarCard();
      if (Game.state === 'menu') Game.setMenuCar(this.carIndex);
    };
    // 默认展示车辆：保时捷 918（截图演示与开局默认车）
    this.carIndex = CAR_SPECS.findIndex(x => x.id === 'p918');
    this.els.btnFree.onclick = () => Game.start('free');
    if (this.els.btnRace) this.els.btnRace.onclick = () => Game.start('free');
    if (this.els.btnAIDemo) this.els.btnAIDemo.onclick = () => Game.start('free');
    if (this.els.btnRoutePatrol) this.els.btnRoutePatrol.onclick = () => Game.start('free');
    if (this.els.btnTune) this.els.btnTune.onclick = () => this.els.tuneBox.classList.toggle('open');
    this.els.vol.oninput = () => AudioSys.setVolume(this.els.vol.value / 100);
    // 漂移调参滑条（本地保存）
    try {
      const saved = JSON.parse(localStorage.getItem('horizonTuning') || '{}');
      for (const k of Object.keys(TUNING)) if (typeof saved[k] === 'number') TUNING[k] = saved[k];
    } catch (e) { /* ignore */ }
    for (const [elId, key, min, max] of [
      ['tDrift', 'drift', 50, 170], ['tCounter', 'counter', 50, 200],
      ['tSmall', 'smallAngle', 0, 100],
      ['tRearGrip', 'rearGrip', 40, 160], ['tHandbrake', 'handbrake', 40, 160],
    ]) {
      const el = this.els[elId], lb = this.els[elId + 'V'];
      el.min = min; el.max = max;
      el.value = Math.round(clamp(TUNING[key], min / 100, max / 100) * 100);
      lb.textContent = key === 'smallAngle' ? Math.round(TUNING[key] * 100) + '%' : TUNING[key].toFixed(1);
      el.oninput = () => {
        TUNING[key] = el.value / 100;
        lb.textContent = key === 'smallAngle' ? Math.round(TUNING[key] * 100) + '%' : TUNING[key].toFixed(1);
        try { localStorage.setItem('horizonTuning', JSON.stringify(TUNING)); } catch (e2) { /* ignore */ }
      };
    }
    this.els.btnResume.onclick = () => Game.togglePause(false);
    this.els.btnRestart.onclick = () => { Game.respawnCar(); Game.togglePause(false); };
    this.els.btnToMenu.onclick = () => Game.toMenu();
    this.updateCarCard();
    this.initGaugeCanvas();
    this.initMinimapCanvas();
    this.initBigMapCanvas();
    this.showMenu();
  },

  // ---------------- 大地图 ----------------
  initBigMapCanvas() {
    const cv = this.els.bigmapCanvas;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = 1024 * dpr;
    cv.height = 1024 * dpr;
    this.bigmapCtx = cv.getContext('2d');
  },

  drawBigMap(world, car, traffic, game) {
    const cv = this.els.bigmapCanvas;
    const ctx = this.bigmapCtx;
    if (!cv || !ctx || !world || !car) return;
    const S = cv.width;
    const center = S * 0.5;
    const extent = CFG.worldHalf + 180;
    const scale = S * 0.88 / (extent * 2);
    const px = (x, z) => ({ x: center + x * scale, y: center - z * scale });
    const cacheKey = `${world.map.id}:${world.season}:${S}`;

    if (!this._bigMapBase || this._bigMapKey !== cacheKey) {
      const base = document.createElement('canvas');
      base.width = S;
      base.height = S;
      const b = base.getContext('2d');
      const col = new THREE.Color();

      const bg = b.createLinearGradient(0, 0, S, S);
      bg.addColorStop(0, '#0f2630');
      bg.addColorStop(0.48, '#19352f');
      bg.addColorStop(1, '#0b202a');
      b.fillStyle = bg;
      b.fillRect(0, 0, S, S);

      // Terrain mosaic with altitude shading.
      const step = 48;
      for (let x = -CFG.worldHalf; x <= CFG.worldHalf; x += step) {
        for (let z = -CFG.worldHalf; z <= CFG.worldHalf; z += step) {
          const p = px(x, z);
          const water = world.seaMask(x, z) > 0.5 || world.lakeMask(x, z) > 0.5;
          if (water) {
            const wg = b.createLinearGradient(p.x, p.y - step * scale, p.x, p.y + step * scale);
            wg.addColorStop(0, '#23789a');
            wg.addColorStop(1, '#164f70');
            b.fillStyle = wg;
          } else {
            const h = world.terrainHeight(x, z);
            world.terrainColor(x, h, z, 0, col);
            const lift = clamp((h - 30) / 300, 0, 1);
            col.lerp(new THREE.Color(0xc9d5d0), lift * 0.22);
            b.fillStyle = '#' + col.getHexString();
          }
          const d = step * scale * 1.08;
          b.fillRect(p.x - d * 0.5, p.y - d * 0.5, d, d);
        }
      }

      // Subtle coordinate grid and contour feel.
      b.strokeStyle = 'rgba(220,242,242,0.07)';
      b.lineWidth = Math.max(1, S / 1200);
      for (let m = -2000; m <= 2000; m += 500) {
        const a = px(m, -CFG.worldHalf), c1 = px(m, CFG.worldHalf);
        b.beginPath(); b.moveTo(a.x, a.y); b.lineTo(c1.x, c1.y); b.stroke();
        const d = px(-CFG.worldHalf, m), e = px(CFG.worldHalf, m);
        b.beginPath(); b.moveTo(d.x, d.y); b.lineTo(e.x, e.y); b.stroke();
      }

      // Roads use a dark casing, bright asphalt core and colored dirt routes.
      for (const route of world.trafficRoutes) {
        const arr = route.samples;
        if (!arr.length) continue;
        const dirt = arr[0].mat === 'dirt';
        const drawRoad = (stroke, width) => {
          b.strokeStyle = stroke;
          b.lineWidth = width;
          b.lineJoin = 'round';
          b.lineCap = 'round';
          b.beginPath();
          for (let i = 0; i < arr.length; i += 2) {
            const p = px(arr[i].x, arr[i].z);
            if (i === 0) b.moveTo(p.x, p.y); else b.lineTo(p.x, p.y);
          }
          b.stroke();
        };
        const width = Math.max(3, arr[0].w * scale * 0.56);
        drawRoad('rgba(4,13,18,0.72)', width + Math.max(4, S / 180));
        drawRoad(dirt ? '#d7b47b' : '#f1f4f2', width);
        if (!dirt) drawRoad('rgba(65,101,105,0.62)', Math.max(1, width * 0.18));
      }

      // Route labels.
      const routeNames = {
        ring: '湖谷环线', cross: '东西高速', northsouth: '山谷大道',
        lakeloop: '湖岸公路', mountain: '雪山垭口', coast: '南部公路',
        northpass: '高地景观道', southloop: '越野环线', switchbacks: '天梯发卡弯'
      };
      b.font = `600 ${Math.max(17, S * 0.012)}px "Segoe UI","Microsoft YaHei",sans-serif`;
      b.textAlign = 'center';
      b.textBaseline = 'middle';
      for (const route of world.trafficRoutes) {
        const arr = route.samples;
        const name = routeNames[route.id];
        if (!name || !arr.length) continue;
        const s = arr[Math.floor(arr.length * 0.52)];
        const p = px(s.x, s.z);
        b.fillStyle = 'rgba(4,14,18,0.76)';
        b.fillRect(p.x - name.length * S * 0.0062, p.y - S * 0.012, name.length * S * 0.0124, S * 0.024);
        b.fillStyle = 'rgba(242,249,246,0.90)';
        b.fillText(name, p.x, p.y);
      }

      b.strokeStyle = 'rgba(255,255,255,0.24)';
      b.lineWidth = Math.max(2, S / 500);
      b.strokeRect(S * 0.025, S * 0.025, S * 0.95, S * 0.95);
      this._bigMapBase = base;
      this._bigMapKey = cacheKey;
    }

    ctx.clearRect(0, 0, S, S);
    ctx.drawImage(this._bigMapBase, 0, 0);

    // Live traffic.
    if (traffic && traffic.cars) {
      ctx.fillStyle = 'rgba(237,247,245,0.88)';
      for (const tc of traffic.cars) {
        const p = px(tc.visual.position.x, tc.visual.position.z);
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(2.5, S * 0.003), 0, TAU);
        ctx.fill();
      }
    }

    // Player marker with a Horizon-style magenta halo.
    const pp = px(car.pos.x, car.pos.z);
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
    ctx.strokeStyle = `rgba(255,48,132,${0.35 + pulse * 0.35})`;
    ctx.lineWidth = Math.max(3, S * 0.004);
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, S * (0.012 + pulse * 0.004), 0, TAU);
    ctx.stroke();
    ctx.save();
    ctx.translate(pp.x, pp.y);
    // 地图坐标：世界 +z → 画布上方、+x → 画布右方（y 轴取反），
    // 因此画布旋转角 = +yaw（用 -yaw 会让箭头左右镜像）
    ctx.rotate(car.yaw);
    ctx.fillStyle = '#ff2f86';
    ctx.beginPath();
    ctx.moveTo(0, -S * 0.018);
    ctx.lineTo(S * 0.011, S * 0.012);
    ctx.lineTo(0, S * 0.007);
    ctx.lineTo(-S * 0.011, S * 0.012);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    const info = this.els.bigmapInfo;
    if (info) {
      const nr = world.nearestRoad(car.pos.x, car.pos.z);
      const names = {
        ring: '湖谷环线', cross: '东西高速', northsouth: '山谷大道',
        lakeloop: '湖岸公路', mountain: '雪山垭口', coast: '南部公路',
        northpass: '高地景观道', southloop: '越野环线', switchbacks: '天梯发卡弯'
      };
      info.textContent = `${names[nr && nr.s && nr.s.road] || '阿尔卑斯湖谷'}  ·  ${Math.round(car.speedKmh)} km/h`;
    }
  },

  drawBigMapLegacy(world, car, traffic, game) {
    const cv = this.els.bigmapCanvas, ctx = this.bigmapCtx;
    const S = cv.width, c = S / 2;
    const worldSize = CFG.worldHalf * 2;
    const scale = (S * 0.94) / (worldSize + 400);
    // 标准北向大地图：北在上、东在右（不再左右镜像）
    const px = (x, z) => ({ x: c + x * scale, y: c - z * scale });
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#111a22';
    ctx.fillRect(0, 0, S, S);
    // 地形色块（草/田野/山地/雪线）
    const col = new THREE.Color();
    const tStep = 60;
    for (let wx = -CFG.worldHalf; wx <= CFG.worldHalf; wx += tStep) {
      for (let wz = -CFG.worldHalf; wz <= CFG.worldHalf; wz += tStep) {
        const h = world.terrainHeight(wx, wz);
        if (world.seaMask(wx, wz) > 0.5 || world.lakeMask(wx, wz) > 0.5) continue;
        world.terrainColor(wx, h, wz, 0, col);
        const p = px(wx, wz);
        ctx.fillStyle = '#' + col.getHexString();
        ctx.fillRect(p.x - scale * tStep * 0.6, p.y - scale * tStep * 0.6, scale * tStep * 1.2, scale * tStep * 1.2);
      }
    }
    // 水域
    ctx.fillStyle = 'rgba(50,110,150,0.85)';
    const step = 50;
    for (let wx = -CFG.worldHalf; wx <= CFG.worldHalf; wx += step) {
      for (let wz = -CFG.worldHalf; wz <= CFG.worldHalf; wz += step) {
        if (world.seaMask(wx, wz) > 0.5 || world.lakeMask(wx, wz) > 0.5) {
          const p = px(wx, wz);
          ctx.fillRect(p.x - scale * step / 2, p.y - scale * step / 2, scale * step, scale * step);
        }
      }
    }
    // 道路（沥青主色，土路用棕色）
    for (const r of world.trafficRoutes) {
      const dirt = r.samples[0] && r.samples[0].mat === 'dirt';
      ctx.strokeStyle = dirt ? 'rgba(170,150,110,0.95)' : 'rgba(235,237,240,0.92)';
      ctx.lineWidth = Math.max(2, r.samples[0].w * scale * 0.55);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      const arr = r.samples;
      for (let i = 0; i < arr.length; i += 3) {
        const p = px(arr[i].x, arr[i].z);
        if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // 漂移圈
    if (world.driftCircles) {
      for (const c of world.driftCircles) {
        const pc = px(c.x, c.z);
        ctx.strokeStyle = 'rgba(255,120,90,0.8)';
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(pc.x, pc.y, c.R * scale, 0, TAU); ctx.stroke();
      }
    }
    // 起点
    if (world.startLine) {
      const p = px(world.startLine.x, world.startLine.z);
      ctx.fillStyle = '#ffd25e';
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, TAU); ctx.fill();
    }
    // 检查点
    if (game.raceActive && game.raceCheckpoints) {
      for (let i = 0; i < game.raceCheckpoints.length; i++) {
        const cp = game.raceCheckpoints[i];
        const p = px(cp.x, cp.z);
        ctx.fillStyle = i <= game.raceCpIdx ? 'rgba(120,210,140,0.6)' : 'rgba(255,210,90,0.9)';
        ctx.beginPath(); ctx.arc(p.x, p.y, i === game.raceCpNext ? 5 : 3, 0, TAU); ctx.fill();
      }
    }
    // 车流
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const tc of traffic.cars) {
      const p = px(tc.visual.position.x, tc.visual.position.z);
      ctx.fillRect(p.x - 2, p.y - 2, 4, 4);
    }
    // 玩家箭头（北在上、东在左的坐标系）
    const pp = px(car.pos.x, car.pos.z);
    ctx.save();
    ctx.translate(pp.x, pp.y);
    ctx.rotate(Math.atan2(Math.sin(car.yaw), Math.cos(car.yaw)));
    ctx.fillStyle = '#ffd25e';
    ctx.beginPath();
    ctx.moveTo(0, -13); ctx.lineTo(9, 9); ctx.lineTo(0, 5); ctx.lineTo(-9, 9);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    // 边框
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, S - 2, S - 2);
  },

  buildChips() {
    const seasonNames = ['春', '夏', '秋', '冬'];
    const weatherNames = ['晴', '雨', '雪'];
    const timeNames = [['清晨', 6.2], ['上午', 9.5], ['正午', 13], ['黄昏', 18.5], ['夜晚', 22.2]];
    const mk = (parent, items, cb) => {
      if (!parent) return;
      parent.innerHTML = '';
      items.forEach((it, i) => {
        const d = document.createElement('div');
        d.className = 'chip';
        d.textContent = Array.isArray(it) ? it[0] : it;
        d.onclick = () => {
          cb(i);
          [...parent.children].forEach(c => c.classList.remove('on'));
          d.classList.add('on');
        };
        parent.appendChild(d);
      });
    };
    mk(this.els.mapChips, MAPS.map(m => m.name), i => {
      Game.switchMap(i).then(() => {
        [...this.els.mapChips.children].forEach((c, k) => c.classList.toggle('on', k === Game.mapIndex));
      }).catch(e => console.error('switch map fail', e));
    });
    mk(this.els.seasonChips, seasonNames, i => { this.state.season = i; if (Game.world) { Game.world.season = i; Game.world.applySeason(); } });
    mk(this.els.weatherChips, weatherNames, i => { this.state.weather = i; if (Game.world) Game.world.weather = i; });
    mk(this.els.timeChips, timeNames, i => { this.state.hour = timeNames[i][1]; if (Game.world) { Game.world.hour = timeNames[i][1]; Game.world.updateSky(); } });
    if (this.els.seasonChips && this.els.seasonChips.children[1]) this.els.seasonChips.children[1].classList.add('on');
    if (this.els.weatherChips && this.els.weatherChips.children[0]) this.els.weatherChips.children[0].classList.add('on');
    if (this.els.timeChips && this.els.timeChips.children[1]) this.els.timeChips.children[1].classList.add('on');
    if (this.els.mapChips && this.els.mapChips.children[0]) this.els.mapChips.children[0].classList.add('on');
  },

  updateCarCard() {
    const s = CAR_SPECS[this.carIndex];
    this.els.carName.textContent = s.name;
    this.els.carEngine.textContent = s.engine + ' · ' + s.hp + ' HP';
    this.els.carDesc.textContent = s.desc;
    if (this.els.btnFree) {
      this.els.btnFree.innerHTML = '<b>进入世界</b><span>驾驶 ' + s.name + ' 自由探索</span>';
    }
    if (this.els.carLocked) {
      this.els.carLocked.textContent = s.id === 'p918' ? 'S2 998' : 'S1 900';
    }
    const set = (el, v) => el.style.width = (v * 100) + '%';
    set(this.els.stTop, s.stats.top); set(this.els.stAcc, s.stats.acc);
    set(this.els.stHand, s.stats.hand); set(this.els.stDrift, s.stats.drift);
  },

  setLoading(p, txt) {
    this.els.loadFill.style.width = (p * 100) + '%';
    this.els.loadTxt.textContent = txt || '';
  },

  showLoading(txt) {
    this.els.loading.classList.remove('hidden');
    this.els.loadFill.style.width = '0%';
    this.els.loadTxt.textContent = txt || '正在生成世界…';
  },

  // ---------------- 菜单背景（程序化绘制） ----------------
  showMenu() {
    // 默认展示车辆：保时捷 918（截图演示与开局默认车）
    this.carIndex = CAR_SPECS.findIndex(x => x.id === 'p918');
    this.els.menu.classList.remove('hidden');
    this.els.hud.classList.add('hidden');
    this.els.pause.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    // 同步滑条显示值与当前调参（AI 秀结束后恢复）
    for (const [elId, key] of [['tDrift', 'drift'], ['tCounter', 'counter'], ['tSmall', 'smallAngle'],
      ['tRearGrip', 'rearGrip'], ['tHandbrake', 'handbrake']]) {
      const el = this.els[elId], lb = this.els[elId + 'V'];
      if (!el) continue;
      el.value = Math.round(clamp(TUNING[key], el.min / 100, el.max / 100) * 100);
      lb.textContent = key === 'smallAngle' ? Math.round(TUNING[key] * 100) + '%' : TUNING[key].toFixed(1);
    }
    // 菜单背景改为 3D 展台（真实车辆模型），由 Game.loop 渲染
    if (Game.state === 'menu') Game.setMenuCar(this.carIndex);
  },

  drawMenuBg(dt) {
    const cv = this.els.menuCanvas, ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const t = performance.now() / 1000;
    // 天空
    const hour = this.state.hour;
    const day = clamp(Math.sin((hour - 6) / 24 * TAU), 0.1, 1);
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, `rgb(${10 + 26 * day},${30 + 70 * day},${70 + 90 * day})`);
    grad.addColorStop(0.55, `rgb(${120 + 70 * day},${170 + 50 * day},${210 - 40 * day})`);
    grad.addColorStop(1, `rgb(${220 * day + 60},${180 * day + 40},${130 * day + 40})`);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    // 太阳
    const sx = W * 0.72, sy = H * 0.18;
    const sg = ctx.createRadialGradient(sx, sy, 4, sx, sy, H * 0.22);
    sg.addColorStop(0, 'rgba(255,244,210,0.95)');
    sg.addColorStop(0.25, 'rgba(255,214,120,0.45)');
    sg.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(sx, sy, H * 0.22, 0, TAU); ctx.fill();
    // 远山
    const hill = (base, amp, col, sp) => {
      ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) {
        const y = base - amp * (0.5 + 0.5 * Math.sin(x * 0.004 * sp + t * 0.02 * sp));
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
    };
    hill(H * 0.72, H * 0.10, `rgba(${30 + 20 * day},${60 + 25 * day},${90 + 20 * day},0.9)`, 1);
    hill(H * 0.82, H * 0.08, `rgba(${40 + 25 * day},${75 + 30 * day},${100 + 20 * day},0.95)`, 1.4);
    // 道路
    ctx.save();
    const roadBase = H * 0.96, vanishingY = H * 0.42;
    ctx.fillStyle = '#2a2d33';
    ctx.beginPath();
    ctx.moveTo(W * 0.15, H); ctx.lineTo(W * 0.85, H);
    ctx.lineTo(W * 0.54, vanishingY); ctx.lineTo(W * 0.46, vanishingY);
    ctx.closePath(); ctx.fill();
    // 道路虚线
    ctx.strokeStyle = 'rgba(255,214,90,0.85)'; ctx.lineWidth = 3;
    ctx.setLineDash([26, 34]);
    ctx.beginPath(); ctx.moveTo(W * 0.5, vanishingY); ctx.lineTo(W * 0.5, H); ctx.stroke();
    ctx.setLineDash([]);
    // 路侧草
    ctx.strokeStyle = '#4a7d3a';
    for (let i = 0; i < 60; i++) {
      const y = H - Math.random() * H * 0.3;
      const p = (y - vanishingY) / (H - vanishingY);
      const half = W * (0.15 + 0.35 * p);
      const x = W * 0.5 + (Math.random() * 2 - 1) * (half + 40);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rand(-6, 6), y - 8); ctx.stroke();
    }
    ctx.restore();
    // 车辆剪影
    const carY = H * 0.88;
    const carX = W * 0.5 + Math.sin(t * 0.6) * W * 0.18;
    ctx.fillStyle = '#16181d';
    ctx.beginPath();
    ctx.ellipse(carX, carY, W * 0.075, 9, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#1c1f26';
    ctx.fillRect(carX - W * 0.055, carY - 16, W * 0.11, 9);
    ctx.fillRect(carX - W * 0.038, carY - 26, W * 0.076, 12);
    ctx.fillStyle = '#ffb04d';
    ctx.fillRect(carX - W * 0.052, carY - 2, W * 0.008, 5);
    ctx.fillRect(carX + W * 0.044, carY - 2, W * 0.008, 5);
    // 灯光眩光
    const gg = ctx.createRadialGradient(carX, carY - 4, 2, carX, carY - 4, 60);
    gg.addColorStop(0, 'rgba(255,220,150,0.5)');
    gg.addColorStop(1, 'rgba(255,220,150,0)');
    ctx.fillStyle = gg; ctx.fillRect(carX - 70, carY - 64, 140, 90);
    // 粒子
    ctx.fillStyle = 'rgba(255,240,210,0.6)';
    for (let i = 0; i < 26; i++) {
      const px = (Noise.hash2(i, Math.floor(t * 0.4)) * W + t * 8 * (i % 3 + 1)) % W;
      const py = H * 0.2 + (Noise.hash2(i, 99) * H * 0.5 + t * 30 * (i % 2 + 1)) % (H * 0.5);
      ctx.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(t + i));
      ctx.fillRect(px, py, 2, 2);
    }
    ctx.globalAlpha = 1;
  },

  hideMenu() {
    cancelAnimationFrame(this.raf);
    this.els.menu.classList.add('hidden');
    this.els.hud.classList.remove('hidden');
  },

  // ---------------- 表盘 ----------------
  initGaugeCanvas() {
    const cv = this.els.gauge;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = 420 * dpr / 2; cv.height = 420 * dpr / 2;
    this.gaugeCtx = cv.getContext('2d');
  },

  // ---------------- 高速屏幕特效（边缘压暗 + 速度线） ----------------
  drawSpeedFx(car) {
    const cv = this.els.speedFx;
    const W = innerWidth, H = innerHeight;
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    // 40 km/h 起渐入，200+ km/h 拉满（GPU 径向模糊在 main.js 处理）
    const f = clamp((car.speedKmh - 40) / 160, 0, 1);
    if (f < 0.01) return;
    const cx = W / 2, cy = H * 0.40;
    const minD = Math.min(W, H), maxD = Math.max(W, H);
    const a = f;
    const t = performance.now() / 1000;

    // Clean speed presentation: edge compression and road sheen only.
    // Deliberately no discrete white streaks or screen-space taillight columns.
    const vignette = ctx.createRadialGradient(cx, cy, minD * 0.16, cx, cy, maxD * 0.78);
    vignette.addColorStop(0, 'rgba(4,8,14,0)');
    vignette.addColorStop(0.56, `rgba(4,8,14,${(0.035 * a).toFixed(3)})`);
    vignette.addColorStop(1, `rgba(2,5,10,${(0.22 * a).toFixed(3)})`);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);

    const leftFlow = ctx.createLinearGradient(0, 0, W * 0.24, 0);
    leftFlow.addColorStop(0, `rgba(24,42,58,${(0.16 * a).toFixed(3)})`);
    leftFlow.addColorStop(0.55, `rgba(32,52,68,${(0.045 * a).toFixed(3)})`);
    leftFlow.addColorStop(1, 'rgba(32,52,68,0)');
    ctx.fillStyle = leftFlow;
    ctx.fillRect(0, 0, W * 0.30, H);
    const rightFlow = ctx.createLinearGradient(W, 0, W * 0.76, 0);
    rightFlow.addColorStop(0, `rgba(24,42,58,${(0.16 * a).toFixed(3)})`);
    rightFlow.addColorStop(0.55, `rgba(32,52,68,${(0.045 * a).toFixed(3)})`);
    rightFlow.addColorStop(1, 'rgba(32,52,68,0)');
    ctx.fillStyle = rightFlow;
    ctx.fillRect(W * 0.70, 0, W * 0.30, H);

    const roadSheen = ctx.createLinearGradient(0, H * 0.48, 0, H);
    roadSheen.addColorStop(0, 'rgba(170,205,220,0)');
    roadSheen.addColorStop(0.65, `rgba(170,205,220,${(0.025 * a).toFixed(3)})`);
    roadSheen.addColorStop(1, `rgba(210,225,235,${(0.055 * a).toFixed(3)})`);
    ctx.fillStyle = roadSheen;
    ctx.fillRect(0, H * 0.48, W, H * 0.52);
    return;

    // ---- 车底接触阴影（柔和） ----
    const cs = ctx.createRadialGradient(cx, H * 0.80, 4, cx, H * 0.80, maxD * 0.10);
    cs.addColorStop(0, `rgba(5,7,12,${(0.16 * a).toFixed(3)})`);
    cs.addColorStop(1, 'rgba(5,7,12,0)');
    ctx.fillStyle = cs;
    ctx.save(); ctx.translate(cx, H * 0.80); ctx.scale(1.5, 0.55);
    ctx.fillRect(-maxD * 0.10, -maxD * 0.10, maxD * 0.20, maxD * 0.20); ctx.restore();

    // ---- 灭点光束（God Rays）：宽软光柱，极淡 ----
    ctx.lineCap = 'round';
    const rayN = 6 + Math.round(f * 6);
    for (let i = 0; i < rayN; i++) {
      const ph = Noise.hash2(i, 3);
      const ang = Math.PI * (i % 2 === 0 ? 0.06 : 0.94) + (ph - 0.5) * 0.85;
      const len = maxD * (0.85 + ph * 0.3);
      const x0 = cx + Math.cos(ang) * minD * 0.10;
      const y0 = cy + Math.sin(ang) * minD * 0.10;
      ctx.strokeStyle = `rgba(255,250,235,${((0.014 + Noise.hash2(i, 5) * 0.022) * a).toFixed(3)})`;
      ctx.lineWidth = 18 + Noise.hash2(i, 7) * 36;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len); ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // ---- 空气尘埃飞掠 ----
    const dustN = 10 + Math.round(f * 14);
    for (let i = 0; i < dustN; i++) {
      const seed = i * 13 + Math.floor(t * 18) % 7;
      const ph = Noise.hash2(seed, 17);
      const y = H * (0.08 + ph * 0.86);
      const edge = Noise.hash2(seed, 19) > 0.5 ? 1 : -1;
      const off = ((t * (3.8 + f * 6) * (0.6 + Noise.hash2(seed, 23) * 1.3) + Noise.hash2(seed, 29) * 9) % 1);
      const x = cx + edge * (W * 0.55 + off * W * 0.62);
      const tl = H * (0.010 + Noise.hash2(seed, 31) * 0.022) * (0.6 + f * 0.9);
      ctx.strokeStyle = `rgba(238,244,255,${((0.05 + Noise.hash2(seed, 37) * 0.10) * a).toFixed(3)})`;
      ctx.lineWidth = 0.8 + Noise.hash2(seed, 41) * 0.7;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - edge * tl, y); ctx.stroke();
    }

    // ---- 路面反光 + 天空氛围 ----
    const isNight = Game && Game.world && (Game.world.hour > 19.6 || Game.world.hour < 5.4);
    const sheen = ctx.createLinearGradient(0, H * 0.55, 0, H);
    sheen.addColorStop(0, 'rgba(255,242,214,0)');
    sheen.addColorStop(0.5, `rgba(255,238,200,${((isNight ? 0.015 : 0.04) * a).toFixed(3)})`);
    sheen.addColorStop(1, `rgba(255,240,210,${((isNight ? 0.03 : 0.07) * a).toFixed(3)})`);
    ctx.fillStyle = sheen; ctx.fillRect(0, H * 0.55, W, H * 0.45);
    const skyWash = ctx.createLinearGradient(0, 0, 0, H * 0.5);
    skyWash.addColorStop(0, `rgba(120,180,255,${(0.05 * a).toFixed(3)})`);
    skyWash.addColorStop(0.6, 'rgba(120,180,255,0)');
    ctx.fillStyle = skyWash; ctx.fillRect(0, 0, W, H * 0.5);

    // ---- 夜间尾灯光轨：柔和红色光柱从尾灯向后拉（异环风格） ----
    if (isNight && f > 0.2) {
      const flick = 0.85 + 0.15 * Math.sin(t * 31);
      for (const sx of [-0.048, 0.048]) {
        const x0 = cx + W * sx;
        const y0 = H * 0.78;
        // 亮芯
        const core = ctx.createLinearGradient(0, y0, 0, H * 1.08);
        core.addColorStop(0, `rgba(255,70,50,${(0.5 * a * flick).toFixed(3)})`);
        core.addColorStop(0.45, `rgba(255,40,30,${(0.22 * a).toFixed(3)})`);
        core.addColorStop(1, 'rgba(255,35,25,0)');
        ctx.fillStyle = core;
        ctx.fillRect(x0 - W * 0.005, y0, W * 0.01, H * 0.3);
        // 外辉光
        const glow = ctx.createLinearGradient(0, y0, 0, H * 1.08);
        glow.addColorStop(0, `rgba(255,60,45,${(0.18 * a).toFixed(3)})`);
        glow.addColorStop(0.6, `rgba(255,40,35,${(0.08 * a).toFixed(3)})`);
        glow.addColorStop(1, 'rgba(255,35,30,0)');
        ctx.fillStyle = glow;
        ctx.fillRect(x0 - W * 0.016, y0, W * 0.032, H * 0.3);
      }
    }

    // ---- 车身锚点：轻微清掉车位的叠层，保持可读 ----
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.translate(cx, H * 0.68);
    ctx.scale(1, 1.15);
    const hole = ctx.createRadialGradient(0, 0, minD * 0.04, 0, 0, minD * (0.12 + 0.02 * f));
    hole.addColorStop(0, 'rgba(0,0,0,0.7)');
    hole.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hole;
    ctx.fillRect(-W, -H, W * 2, H * 2);
    ctx.restore();
  },
  drawGauge(car) {
    const cv = this.els.gauge, ctx = this.gaugeCtx;
    const S = cv.width, c = S / 2, R = S * 0.42;
    const spd = Math.min(car.speedKmh, 320);
    const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    ctx.clearRect(0, 0, S, S);
    // 外圈
    ctx.lineWidth = S * 0.055;
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath(); ctx.arc(c, c, R, a0, a0 + sweep); ctx.stroke();
    // 速度弧（分段渐变）
    const segs = 60;
    for (let i = 0; i < segs; i++) {
      const f = i / segs;
      const a1 = a0 + sweep * f, a2 = a0 + sweep * (i + 1) / segs;
      const val = f * 320;
      const col = val > 200 ? `hsl(${lerp(45, 0, (val - 200) / 120)},100%,55%)` : `hsl(${lerp(140, 45, val / 200)},95%,52%)`;
      ctx.strokeStyle = col;
      ctx.lineWidth = S * 0.05;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(c, c, R, a1, a2); ctx.stroke();
      if (val > spd) break;
    }
    // 刻度
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let v = 0; v <= 300; v += 20) {
      const a = a0 + sweep * (v / 320);
      ctx.lineWidth = v % 100 === 0 ? 3 : 1.5;
      ctx.beginPath();
      ctx.moveTo(c + Math.cos(a) * R * 0.86, c + Math.sin(a) * R * 0.86);
      ctx.lineTo(c + Math.cos(a) * R * 0.94, c + Math.sin(a) * R * 0.94);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `${S * 0.055}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(v, c + Math.cos(a) * R * 0.7, c + Math.sin(a) * R * 0.7);
    }
    // 指针
    const a = a0 + sweep * (spd / 320);
    ctx.save();
    ctx.translate(c, c); ctx.rotate(a);
    ctx.fillStyle = '#ffd25e';
    ctx.beginPath();
    ctx.moveTo(R * 0.05, -S * 0.016); ctx.lineTo(R * 0.78, -S * 0.008);
    ctx.lineTo(R * 0.78, S * 0.008); ctx.lineTo(R * 0.05, S * 0.016);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.fillStyle = '#0e1218';
    ctx.beginPath(); ctx.arc(c, c, S * 0.05, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2; ctx.stroke();
    // 转速内弧
    const rpmF = car.engineRpm / car.spec.redline;
    const r2 = R * 0.55;
    ctx.lineWidth = S * 0.025;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.arc(c, c, r2, a0, a0 + sweep); ctx.stroke();
    ctx.strokeStyle = `rgba(255,${Math.round(210 - rpmF * 150)},50,0.9)`;
    ctx.beginPath(); ctx.arc(c, c, r2, a0, a0 + sweep * clamp(rpmF, 0, 1)); ctx.stroke();
    // RPM 文字
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = `bold ${S * 0.05}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillText(Math.round(car.engineRpm).toLocaleString() + ' rpm', c, c + S * 0.26);
  },

  // ---------------- 迷你地图 ----------------
  initMinimapCanvas() {
    const cv = this.els.minimap;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = 432 * dpr / 2; cv.height = 432 * dpr / 2;
    this.minimapCtx = cv.getContext('2d');
  },

  drawMinimap(car, world, traffic, game) {
    const cv = this.els.minimap, ctx = this.minimapCtx;
    const S = cv.width, c = S / 2, R = S * 0.46;
    const scale = R / 260; // 每米像素
    const yaw = car.yaw;
    const px = (x, z) => {
      const dx = x - car.pos.x, dz = z - car.pos.z;
      // 屏幕实测：车头朝 +z 时 +x（东）在屏幕左侧，因此地图横向镜像以匹配屏幕
      return { x: c + (-dx * Math.cos(yaw) + dz * Math.sin(yaw)) * scale, y: c + (-dx * Math.sin(yaw) - dz * Math.cos(yaw)) * scale };
    };
    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.clip();
    // 背景
    ctx.fillStyle = '#1a2417';
    ctx.fillRect(0, 0, S, S);
    // 水域
    ctx.fillStyle = 'rgba(58,124,160,0.8)';
    const step = 520 / 24;
    for (let gx = 0; gx < 24; gx++) for (let gz = 0; gz < 24; gz++) {
      const wx = car.pos.x + (gx - 12) * step, wz = car.pos.z + (gz - 12) * step;
      if (world.seaMask(wx, wz) > 0.5 || world.lakeMask(wx, wz) > 0.5) {
        const p = px(wx, wz);
        ctx.fillRect(p.x - scale * step / 2, p.y - scale * step / 2, scale * step, scale * step);
      }
    }
    // 道路
    ctx.strokeStyle = 'rgba(236,238,240,0.9)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const r of world.trafficRoutes) {
      const arr = r.samples;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i += 2) {
        const p = px(arr[i].x, arr[i].z);
        if (!started) { ctx.moveTo(p.x, p.y); started = true; }
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    }
    // 起点
    if (world.startLine) {
      const p = px(world.startLine.x, world.startLine.z);
      ctx.fillStyle = '#ffd25e';
      ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, TAU); ctx.fill();
    }
    // 检查点（比赛）
    if (game.raceActive && game.raceCheckpoints) {
      for (let i = 0; i < game.raceCheckpoints.length; i++) {
        const cp = game.raceCheckpoints[i];
        const p = px(cp.x, cp.z);
        ctx.fillStyle = i <= game.raceCpIdx ? 'rgba(120,210,140,0.5)' : 'rgba(255,210,90,0.95)';
        ctx.beginPath(); ctx.arc(p.x, p.y, i === game.raceCpNext ? 4.5 : 2.8, 0, TAU); ctx.fill();
      }
    }
    // 车流
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    for (const tc of traffic.cars) {
      const p = px(tc.visual.position.x, tc.visual.position.z);
      ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3);
    }
    // 比赛对手
    if (game.opponents && game.opponents.length) {
      ctx.fillStyle = 'rgba(255,120,90,0.95)';
      for (const op of game.opponents) {
        const p = px(op.car.visual.position.x, op.car.visual.position.z);
        ctx.beginPath(); ctx.arc(p.x, p.y, 2.4, 0, TAU); ctx.fill();
      }
    }
    ctx.restore();
    // 车头箭头
    ctx.save();
    ctx.translate(c, c);
    ctx.fillStyle = '#ffd25e';
    ctx.beginPath();
    ctx.moveTo(0, -11); ctx.lineTo(8, 8); ctx.lineTo(0, 4); ctx.lineTo(-8, 8);
    ctx.closePath(); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(c, c, R, 0, TAU); ctx.stroke();
  },

  // ---------------- 弹窗 / 消息 ----------------
  popup(text, cls) {
    const d = document.createElement('div');
    d.className = 'pop ' + (cls || '');
    d.textContent = text;
    this.els.popups.appendChild(d);
    setTimeout(() => d.remove(), 1700);
    while (this.els.popups.children.length > 4) this.els.popups.firstChild.remove();
  },

  toast(text, ms) {
    this.els.toast.textContent = text;
    this.els.toast.style.opacity = 1;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => this.els.toast.style.opacity = 0, ms || 2200);
  },

  bigMsg(title, sub, hold) {
    this.els.msgBig.textContent = title || '';
    this.els.msgSub.textContent = sub || '';
    clearTimeout(this._msgT);
    if (hold) { this._msgHold = hold; this.els.msg.style.opacity = 1; }
    else {
      this.els.msg.style.opacity = 1;
      this._msgT = setTimeout(() => this.els.msg.style.opacity = 0, 1300);
    }
  },

  hideMsg() {
    clearTimeout(this._msgT);
    this.els.msg.style.opacity = 0;
  },

  updateTopInfo(world) {
    const S = SEASONS[world.season];
    const times = ['清晨', '上午', '正午', '黄昏', '夜晚'];
    let tn = '—';
    if (world.hour < 7.5) tn = times[0];
    else if (world.hour < 11) tn = times[1];
    else if (world.hour < 16) tn = times[2];
    else if (world.hour < 20.5) tn = times[3];
    else tn = times[4];
    const w = ['晴', '雨', '雪'][world.weather];
    this.els.topInfo.innerHTML = `
      <div class="chipInfo">☀ ${S.name}</div>
      <div class="chipInfo">${w}</div>
      <div class="chipInfo">${tn} ${Math.floor(world.hour)}:${world.hour % 1 ? '30' : '00'}</div>
      <div class="chipInfo">${CAR_SPECS[this.carIndex].name}</div>`;
  },

  update(dt, car, world, traffic, game) {
    this.els.speedNum.textContent = Math.round(car.speedKmh);
    this.els.gear.textContent = car.gear === 0 ? 'R' : (car.gear > 0 ? (car.autoShift ? 'D' + car.gear : car.gear) : 'N');
    this.els.rpmFill.style.width = clamp(car.engineRpm / car.spec.redline * 100, 0, 100) + '%';
    this.els.score.textContent = Math.round(car.driftScore + game.skillScore);
    this.drawGauge(car);
    if (!game.nofx) this.drawSpeedFx(car);
    this.drawMinimap(car, world, traffic, game);
    this.updateTopInfo(world);
    if (game.raceActive) {
      this.els.racePanel.classList.remove('hidden');
      this.els.raceTime.textContent = fmtTime(game.raceTime);
      const d = game.raceTime - game.racePar;
      this.els.raceDelta.textContent = (d <= 0 ? '-' : '+') + fmtTime(Math.abs(d)) + (d <= 0 ? ' 领先目标' : ' 落后目标');
      this.els.raceDelta.style.color = d <= 0 ? '#7fe08a' : '#ff8a6a';
      this.els.raceCheck.textContent = `检查点 ${game.raceCpIdx}/${game.raceCheckpoints.length}`;
      this.els.racePar.textContent = `目标 ${fmtTime(game.racePar)}`;
      const total = (game.opponents ? game.opponents.length : 0) + 1;
      this.els.racePos.textContent = `${game.racePosition || 1}/${total}`;
    } else this.els.racePanel.classList.add('hidden');
  },

  showHelp(v) { this.els.help.classList.toggle('hidden', !v); },
};
