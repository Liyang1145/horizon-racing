// ============================================================
//  AI 漂移控制器 — 模拟玩家按键：手刹短按 / 规律给油 / 正打 / 反打
// ============================================================
'use strict';

function angNormAI(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

class DriftAI {
  constructor() {
    this.reset();
  }

  reset() {
    this.hbTimer = 0;
    this.hbCooldown = 0;
    this.kickTimer = 0;
    this.steerHyst = 0;
    this.wpIndex = 0;
    this.uturnStuck = 0;
    this.uturnPrevD = 1e9;
    this.routeIdx = 0;
    this.routePrevYawErr = 0;
    this.routeStuck = 0;
    this.routeMaxSlope = 0;
    this.routeMaxOff = 0;
    this.routeNan = false;
    this.routeStats = null;
  }

  // ---- 圆形漂移：绕 (cx,cz) 半径 R 持续小角度漂移 ----
  circle(car, dt, cx, cz, R, dir) {
    const inp = car.input;
    const dx = car.pos.x - cx, dz = car.pos.z - cz;
    const r = Math.hypot(dx, dz) || 1;
    const vSpeed = Math.hypot(car.vel.x, car.vel.z);
    const rErr = r - R;
    const slipMag = Math.abs(car.slipAngleR);
    const slipT = clamp(0.34 + rErr * 0.005, 0.22, 0.42) * dir;
    const vT = Math.min(15, 10 + R * 0.07);
    // 漂移由游戏内的“转向即漂移”辅助自动建立，AI 只需跟圆 + 控速
    const omegaT = (vSpeed / R) * (1 + 0.15 * rErr) * dir;
    const slipErr = slipT - car.slipAngleR;
    let steer = clamp((omegaT - car.yawRate) * 0.9 + slipErr * 0.5, -1, 1);
    let throttle = clamp((vT - vSpeed) * 0.15, 0, 1);
    inp.handbrake = false;
    inp.steer = steer;
    inp.throttle = throttle;
    inp.brake = 0;
    inp.horn = false;
    this.last = {
      state: 'bal', omegaT: +omegaT.toFixed(2), steer: +inp.steer.toFixed(2), throttle: +throttle.toFixed(2),
      hb: inp.handbrake,
      slipT: +slipT.toFixed(2), rErr: +rErr.toFixed(1),
      vSpeed: +vSpeed.toFixed(1), slip: +slipMag.toFixed(2), yawRate: +car.yawRate.toFixed(2),
    };
  }

  // ---- U 形弯：沿航点行驶，掉头处刹车 + 手刹 + 大油门漂过去 ----
  uturn(car, dt, pts) {
    const inp = car.input;
    const t = pts[this.wpIndex];
    const d = Math.hypot(t[0] - car.pos.x, t[1] - car.pos.z);
    // 捕捉半径随速度放大，避免高速绕航点转圈
    if (d < Math.max(14, Math.hypot(car.vel.x, car.vel.z) * 1.0) || (this.uturnPrevD < 45 && d > this.uturnPrevD)) {
      this.wpIndex = Math.min(pts.length - 1, this.wpIndex + 1);
    }
    this.uturnPrevD = d;
    const a = pts[Math.max(0, this.wpIndex - 1)];
    const b = pts[this.wpIndex];
    const nxt = pts[Math.min(this.wpIndex + 1, pts.length - 1)];
    const dA = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const dB = Math.atan2(nxt[0] - b[0], nxt[1] - b[1]);
    const turn = angNormAI(dB - dA);
    const sharp = Math.abs(turn) > 0.7;
    const vSpeed = Math.hypot(car.vel.x, car.vel.z);
    let tv = Math.atan2(nxt[0] - car.pos.x, nxt[1] - car.pos.z);
    const yawErr = angNormAI(tv - car.yaw);
    this.hbTimer = Math.max(0, this.hbTimer - dt);
    if (sharp) {
      // 急弯：先刹到 ~13.5，再手刹 + 油门漂过
      inp.brake = vSpeed > 13.5 ? 0.85 : 0;
      inp.throttle = vSpeed > 13.5 ? 0 : 0.6;
      if (vSpeed <= 13.5 && this.hbTimer <= 0) {
        inp.handbrake = true;
        this.hbTimer = 0.35;
      } else {
        inp.handbrake = this.hbTimer > 0;
      }
    } else {
      inp.brake = 0;
      inp.throttle = clamp((13 - vSpeed) * 0.15, 0, 1);
      inp.handbrake = this.hbTimer > 0;
    }
    // 卡住自救：速度过低太久 → 全油门朝航点
    this.uturnStuck = (this.uturnStuck || 0) + (vSpeed < 2.5 ? dt : -dt * 2);
    this.uturnStuck = clamp(this.uturnStuck, 0, 5);
    if (this.uturnStuck > 2.2) {
      inp.throttle = 1; inp.brake = 0; inp.handbrake = false;
      inp.steer = clamp(yawErr * 2.5, -1, 1);
      inp.horn = false;
      return;
    }
    // 直道轻微死区，避免小幅修正触发漂移辅助拖慢车速
    inp.steer = Math.abs(yawErr) < 0.03 ? 0 : clamp(yawErr * 1.5, -1, 1);
    inp.horn = false;
  }

  // ---- 巡路验证：沿道路采样点自动行驶，统计坡度/偏离/NaN ----
  route(car, dt, samples) {
    const inp = car.input;
    const n = samples.length;
    const vSpeed = Math.hypot(car.vel.x, car.vel.z);
    // 增量找最近采样（沿前进方向搜索，落后时全扫兜底）
    let near = Math.max(0, Math.min(n - 1, this.routeIdx || 0));
    let best = near, bd = 1e9;
    for (let i = Math.max(0, near - 6); i < Math.min(n, near + 70); i++) {
      const s = samples[i];
      const d = (s.x - car.pos.x) ** 2 + (s.z - car.pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    if (best === near && near > 0) {
      bd = 1e9;
      for (let i = 0; i < n; i++) {
        const s = samples[i];
        const d = (s.x - car.pos.x) ** 2 + (s.z - car.pos.z) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    this.routeIdx = Math.max(0, Math.min(n - 1, best));
    // 轨迹采样（调试用，最多 240 点）
    if (this.routeTrace && this.routeTrace.length < 240 && this.routeIdx % 8 === 0) {
      this.routeTrace.push([Math.round(car.pos.x), Math.round(car.pos.z), this.routeIdx]);
    }
    const s0 = samples[this.routeIdx];
    // 统计：纵向坡度 / 偏离路面的距离 / 数值异常
    if (this.routeIdx > 0) {
      const sp = samples[this.routeIdx - 1];
      const seg = Math.hypot(s0.x - sp.x, s0.z - sp.z) || 1;
      const slope = Math.abs(s0.h - sp.h) / seg;
      if (slope > (this.routeMaxSlope || 0)) this.routeMaxSlope = slope;
    }
    const offD = Math.hypot(car.pos.x - s0.x, car.pos.z - s0.z) - s0.w / 2;
    if (offD > (this.routeMaxOff || 0)) {
      this.routeMaxOff = offD;
      this.routeMaxOffX = car.pos.x;
      this.routeMaxOffZ = car.pos.z;
    }
    if (!isFinite(car.pos.x) || !isFinite(car.pos.y) || !isFinite(car.pos.z)) this.routeNan = true;
    // 前视目标点（随速度增大）
    let tIdx = this.routeIdx, acc = 0;
    const look = clamp(10 + vSpeed * 0.55, 14, 90);
    while (tIdx < n - 1 && acc < look) {
      tIdx++;
      acc += Math.hypot(samples[tIdx].x - samples[tIdx - 1].x, samples[tIdx].z - samples[tIdx - 1].z);
    }
    const t = samples[tIdx];
    const tv = Math.atan2(t.x - car.pos.x, t.z - car.pos.z);
    const yawErr = angNormAI(tv - car.yaw);
    // 有符号横向偏离（正 = 道路切线左侧），用于出弯回拉
    const s1 = samples[Math.min(this.routeIdx + 4, n - 1)];
    const tx1 = s1.x - s0.x, tz1 = s1.z - s0.z;
    const tl1 = Math.hypot(tx1, tz1) || 1;
    const offLat = ((car.pos.x - s0.x) * tz1 - (car.pos.z - s0.z) * tx1) / tl1;
    // 前方曲率 → 目标速度
    let curv = 0;
    for (let k = this.routeIdx + 3; k < Math.min(n - 1, this.routeIdx + 60); k++) {
      const h1 = Math.atan2(samples[k].x - samples[k - 1].x, samples[k].z - samples[k - 1].z);
      const h2 = Math.atan2(samples[k + 1].x - samples[k].x, samples[k + 1].z - samples[k].z);
      const step = Math.hypot(samples[k + 1].x - samples[k].x, samples[k + 1].z - samples[k].z) || 1;
      const c = Math.abs(angNormAI(h2 - h1)) / step;
      if (c > curv) curv = c;
    }
    const baseV = this.raceMode ? 56 : 48;
    const curvK = this.raceMode ? 4.5 : 5.0;
    // 低抓地力车过弯更保守，避免冲出路面
    const gripF = 0.72 + (car.spec.grip || 1) * 0.28;
    const straightV = (baseV / (1 + curv * curvK)) * (this.patrolBoost || 1) * gripF;
    // 物理弯道限速：v = √(μgR)，弯越急越慢，真正贴线过弯
    const vPhys = Math.sqrt(Math.max(18, (car.spec.grip || 1) * 9.81 / Math.max(0.0006, curv))) * 0.82;
    const targetV = clamp(Math.min(straightV, vPhys), 6, 105);
    // 偏离路面时减速并回拉，防止飞出后越跑越远
    const offPen = clamp(1 - (Math.abs(offLat) - 4) * 0.08, 0.3, 1);
    const speedV = targetV * offPen;
    // 严重偏离时强制大幅减速，先稳住再回路
    const hardOff = Math.abs(offLat) > 8 ? 0.45 : 1;
    const speedV2 = speedV * hardOff;
    inp.throttle = clamp((speedV2 - vSpeed) * 0.22 + 0.12, 0, 1);
    inp.brake = vSpeed > speedV2 + 1 ? clamp((vSpeed - speedV2) * 0.28, 0, 1) : 0;
    const yawD = yawErr - this.routePrevYawErr;
    this.routePrevYawErr = yawErr;
    inp.steer = clamp(yawErr * 2.2 + yawD * 1.4 + Math.sign(offLat) * Math.min(Math.abs(offLat) * 0.14, 0.65), -1, 1);
    inp.handbrake = false;
    inp.horn = false;
    // 卡住自救
    this.routeStuck = clamp(this.routeStuck + (vSpeed < 2.5 ? dt : -dt * 2), 0, 5);
    if (this.routeStuck > 2.4) {
      inp.throttle = 1; inp.brake = 0;
      // RWD 车手刹会锁死驱动轮（越救越卡），改为大幅反打方向挣脱
      inp.steer = clamp(yawErr * 3.5 + (car.yawRate > 0.3 ? -0.7 : car.yawRate < -0.3 ? 0.7 : 0), -1, 1);
      inp.handbrake = false;
    }
  }
}
