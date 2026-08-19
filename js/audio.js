// ============================================================
//  音频引擎 — 实时合成发动机声浪
//  V8 核心：逐采样燃烧脉冲（720° 点火次序）+ Karplus-Strong
//  排气管道共振（汽油 V8 ≈310Hz）+ 进气亥姆霍兹共振 + 负载粗糙度
//  参考：GitHub ghurni (engine.rs) / Antonio-R1 engine-sound-generator
// ============================================================
'use strict';

// ---------- AudioWorklet：逐采样物理声浪 ----------
// 燃烧脉冲按 RPM 驱动曲轴角累积；每个汽缸在自己的点火角触发
// exp 衰减脉冲；脉冲串注入 Karplus-Strong 排气管梳状共振器
// （delay = 采样率/排气共振频率），再叠加进气带通、车身低频、
// 负载粗糙度、松油噼啪与回火。
const ENGINE_WORKLET = `
'use strict';
class HorizonEngineProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = (options && options.processorOptions) || {};
    this.sr = sampleRate;
    this.cyl = p.cylinders || 8;
    if (p.firing && p.firing.length) {
      this.firing = p.firing;
    } else if (this.cyl === 8) {
      this.firing = [0, 90, 270, 180, 540, 630, 450, 360];
    } else {
      this.firing = [];
      for (let i = 0; i < this.cyl; i++) this.firing.push(i * 720 / this.cyl);
    }
    this.exhRes = p.exhRes || 150 + this.cyl * 20;
    this.intRes = p.intRes || 400 + this.cyl * 30;
    this.pulseDecay = p.pulseDecay || 9;
    this.pulseWindow = p.pulseWindow || 0.1;
    this.exhDamp = p.exhDamp || 0.84;
    this.crackle = p.crackle || 1;
    this.rough = p.rough || 1;
    this.turbo = !!p.turbo;
    this.revLim = p.revLim || 7000;
    this.rpm = 900; this.load = 0; this.tRpm = 900; this.tLoad = 0;
    this.cut = 1; this.lim = 1; this.boost = 0;
    this.crank = Math.random() * 720;
    this.decel = 0; this.backfire = 0;
    this.rng = 0x9E3779B9 | 0;
    this.combLen = Math.max(8, Math.round(this.sr / this.exhRes));
    this.comb = new Float32Array(this.combLen);
    this.combPos = 0; this.dampLp = 0;
    this.bodyLp = 0; this.subPh = 0;
    this.iS = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.tS = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.iC = this.coeffs(this.intRes, 2.1);
    this.tC = this.coeffs(3200, 1.4);
    this.dcX = 0; this.dcY = 0;
    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (typeof m.rpm === 'number') this.tRpm = m.rpm;
      if (typeof m.load === 'number') this.tLoad = m.load;
      if (typeof m.cut === 'number') this.cut = m.cut;
      if (typeof m.lim === 'number') this.lim = m.lim;
      if (typeof m.boost === 'number') this.boost = m.boost;
      if (m.decel) this.decel = Math.round(this.sr * (0.20 + 0.25 * this.crackle));
      if (m.backfire) this.backfire = Math.round(this.sr * 0.16);
    };
  }
  rnd() {
    this.rng = (this.rng ^ (this.rng << 13)) >>> 0;
    this.rng = (this.rng ^ (this.rng >>> 17)) >>> 0;
    this.rng = (this.rng ^ (this.rng << 5)) >>> 0;
    return this.rng / 2147483647 - 1;
  }
  coeffs(f, q) {
    const w = 2 * Math.PI * Math.min(0.49, f / this.sr);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return [
      alpha / a0, 0, -alpha / a0,
      -2 * Math.cos(w) / a0,
      (1 - alpha) / a0,
    ];
  }
  bp(x, c, st) {
    const y = c[0] * x + c[1] * st.x1 + c[2] * st.x2 - c[3] * st.y1 - c[4] * st.y2;
    st.x2 = st.x1; st.x1 = x;
    st.y2 = st.y1; st.y1 = y;
    return y;
  }
  process(inputs, outputs) {
    const out = outputs[0];
    if (!out || !out[0]) return true;
    const ch = out[0];
    const L = ch.length;
    const sr = this.sr;
    const rpA = 1 - Math.exp(-1 / (0.055 * sr));
    const ldA = 1 - Math.exp(-1 / (0.032 * sr));
    let rpm = this.rpm, load = this.load;
    const firing = this.firing;
    const nf = firing.length;
    const cycle = 720;
    for (let i = 0; i < L; i++) {
      rpm += (this.tRpm - rpm) * rpA;
      load += (this.tLoad - load) * ldA;
      const rough = (0.26 + 0.74 * load) * this.rough;
      const baseAmp = 0.20 + 0.54 * load;
      this.crank = (this.crank + rpm / 60 * 360 / sr) % cycle;
      const crank = this.crank;
      let pulse = 0;
      for (let k = 0; k < nf; k++) {
        let ph = crank - firing[k];
        ph %= cycle; if (ph < 0) ph += cycle;
        const nrm = ph / cycle;
        if (nrm < this.pulseWindow) {
          pulse += Math.exp(-this.pulseDecay * (nrm / this.pulseWindow)) * (1 + this.rnd() * 0.10 * rough);
        }
      }
      pulse *= baseAmp;
      const mech = this.rnd() * baseAmp * rough * 0.075;
      // 车身低频：脉冲串重度低通 + 最低燃烧阶次的轰鸣
      this.bodyLp += (pulse - this.bodyLp) * 0.10;
      this.subPh += 2 * Math.PI * (rpm / 60 * this.cyl / 4) / sr;
      // Karplus-Strong 排气管共振
      const read = this.comb[this.combPos];
      this.dampLp += (read - this.dampLp) * 0.16;
      this.comb[this.combPos] = pulse * 0.9 + this.dampLp * (this.exhDamp + 0.06 * load) + this.rnd() * 0.018 * this.rough;
      this.combPos = (this.combPos + 1) % this.combLen;
      const exh = read;
      // 进气亥姆霍兹共振
      if ((i & 63) === 0) this.iC = this.coeffs(this.intRes * (0.9 + 0.3 * load), 2.1);
      const intake = this.bp(this.rnd() * baseAmp * (0.10 + 0.30 * load), this.iC, this.iS);
      // 涡轮
      let turbo = 0;
      if (this.turbo) {
        if ((i & 63) === 0) this.tC = this.coeffs(2300 + rpm * 0.55 + load * 1600, 1.4);
        turbo = this.bp(this.rnd() * baseAmp * 0.45, this.tC, this.tS) * this.boost * 0.6;
      }
      // 松油噼啪 / 回火
      let dec = 0, bf = 0;
      if (this.decel > 0) {
        this.decel--;
        if (this.rnd() > 0.955) dec = this.rnd() * 0.5 * (this.decel / (sr * 0.3));
      }
      if (this.backfire > 0) {
        this.backfire--;
        bf = this.rnd() * (this.backfire / (sr * 0.16)) * 0.75;
      }
      let s = pulse * 0.20
            + Math.sin(this.subPh) * baseAmp * 0.15
            + this.bodyLp * 0.70
            + exh * (0.45 + 0.55 * load) * 0.85
            + intake * (0.35 + 0.45 * load)
            + mech * 0.5
            + turbo + dec + bf;
      s *= this.lim * this.cut;
      // DC blocker + 软削波
      const d = s - this.dcX + 0.994 * this.dcY;
      this.dcX = s; this.dcY = d;
      ch[i] = Math.tanh(d * 1.35) * 0.72;
    }
    this.rpm = rpm; this.load = load;
    return true;
  }
}
registerProcessor('horizon-engine', HorizonEngineProcessor);
`;

// 每辆车的声浪参数（汽缸数、点火次序、排气/进气共振、脉冲锐度……）
function engineParams(spec) {
  const cyl = spec.cylinders || 8;
  const isV8 = cyl === 8;
  const firing = isV8
    ? [0, 90, 270, 180, 540, 630, 450, 360]   // 十字曲轴 V8：交错点火 → 煮豆怠速
    : Array.from({ length: cyl }, (_, i) => i * (720 / cyl));
  const p = {
    cylinders: cyl, firing,
    exhRes: 150 + cyl * 20,       // 汽油机规则：V8 ≈ 310Hz
    intRes: 400 + cyl * 30,       // 进气歧管亥姆霍兹
    pulseDecay: isV8 ? 9.5 : 8.5,
    pulseWindow: isV8 ? 0.095 : 0.11,
    exhDamp: 0.84,
    crackle: isV8 ? 1 : 0.7,
    rough: 1,                     // 颗粒感/粗糙度增益
    turbo: !!spec.turbo,
    revLim: spec.redline || 7000,
  };
  if (spec.id === 'gt') {              // 跑车 V8：十字曲轴点火，高转清亮带颗粒
    p.cylinders = 8;
    p.firing = [0, 90, 270, 180, 540, 630, 450, 360];
    p.exhRes = 330; p.intRes = 700; p.pulseDecay = 10.5; p.pulseWindow = 0.088;
    p.exhDamp = 0.85; p.crackle = 0.9; p.rough = 1.2;
  }
  if (spec.id === 'p918') {            // 918：平面对曲轴 V8，高转尖锐高亢
    p.firing = [0, 90, 180, 270, 360, 450, 540, 630];
    p.exhRes = 395; p.intRes = 760; p.pulseDecay = 10.0; p.pulseWindow = 0.082;
    p.exhDamp = 0.83; p.crackle = 0.65; p.rough = 1.0;
  }
  return p;
}

// ---------- 主线程逐采样引擎（ScriptProcessor 兼容路径） ----------
// 与 AudioWorklet 里的算法完全一致：燃烧脉冲 → Karplus-Strong 排气共振 →
// 进气亥姆霍兹 → 车身低频 → 负载粗糙度 → 噼啪/回火。任何浏览器都能用，
// 保证 V8 声浪在 AudioWorklet 不可用时也不是“旧声音”。
function engineState(params, sr) {
  sr = sr || 48000;
  const combLen = Math.max(8, Math.round(sr / params.exhRes));
  return {
    sr, firing: params.firing, cyl: params.cylinders,
    pulseDecay: params.pulseDecay, pulseWindow: params.pulseWindow,
    exhDamp: params.exhDamp, crackle: params.crackle, rough: params.rough,
    turbo: params.turbo,
    rpm: 900, load: 0, tRpm: 900, tLoad: 0, cut: 1, lim: 1, boost: 0,
    crank: Math.random() * 720, decel: 0, backfire: 0, rng: 0x9E3779B9 | 0,
    comb: new Float32Array(combLen), combPos: 0, dampLp: 0, bodyLp: 0, subPh: 0,
    iS: { x1: 0, x2: 0, y1: 0, y2: 0 }, tS: { x1: 0, x2: 0, y1: 0, y2: 0 },
    dcX: 0, dcY: 0,
    rnd() {
      this.rng = (this.rng ^ (this.rng << 13)) >>> 0;
      this.rng = (this.rng ^ (this.rng >>> 17)) >>> 0;
      this.rng = (this.rng ^ (this.rng << 5)) >>> 0;
      return this.rng / 2147483647 - 1;
    },
  };
}
function engineCoeffs(st, f, q) {
  const w = 2 * Math.PI * Math.min(0.49, f / st.sr);
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return [alpha / a0, 0, -alpha / a0, -2 * Math.cos(w) / a0, (1 - alpha) / a0];
}
function engineBp(st, x, c, s) {
  const y = c[0] * x + c[1] * s.x1 + c[2] * s.x2 - c[3] * s.y1 - c[4] * s.y2;
  s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
  return y;
}
function engineProcess(st, ch) {
  const sr = st.sr;
  const rpA = 1 - Math.exp(-1 / (0.055 * sr));
  const ldA = 1 - Math.exp(-1 / (0.032 * sr));
  let rpm = st.rpm, load = st.load;
  const firing = st.firing, nf = firing.length, cycle = 720;
  let iC = engineCoeffs(st, st.intRes === undefined ? 640 : st.intRes, 2.1);
  let tC = engineCoeffs(st, 3200, 1.4);
  const combN = st.comb.length;
  for (let i = 0; i < ch.length; i++) {
    rpm += (st.tRpm - rpm) * rpA;
    load += (st.tLoad - load) * ldA;
    const rough = (0.26 + 0.74 * load) * st.rough;
    const baseAmp = 0.20 + 0.54 * load;
    st.crank = (st.crank + rpm / 60 * 360 / sr) % cycle;
    const crank = st.crank;
    let pulse = 0;
    for (let k = 0; k < nf; k++) {
      let ph = crank - firing[k];
      ph %= cycle; if (ph < 0) ph += cycle;
      const nrm = ph / cycle;
      if (nrm < st.pulseWindow) {
        pulse += Math.exp(-st.pulseDecay * (nrm / st.pulseWindow)) * (1 + st.rnd() * 0.10 * rough);
      }
    }
    pulse *= baseAmp;
    const mech = st.rnd() * baseAmp * rough * 0.075;
    st.bodyLp += (pulse - st.bodyLp) * 0.10;
    st.subPh += 2 * Math.PI * (rpm / 60 * st.cyl / 4) / sr;
    const read = st.comb[st.combPos];
    st.dampLp += (read - st.dampLp) * 0.16;
    st.comb[st.combPos] = pulse * 0.9 + st.dampLp * (st.exhDamp + 0.06 * load) + st.rnd() * 0.018 * st.rough;
    st.combPos = (st.combPos + 1) % combN;
    const exh = read;
    if ((i & 63) === 0) iC = engineCoeffs(st, (st.intRes === undefined ? 640 : st.intRes) * (0.9 + 0.3 * load), 2.1);
    const intake = engineBp(st, st.rnd() * baseAmp * (0.10 + 0.30 * load), iC, st.iS);
    let turbo = 0;
    if (st.turbo) {
      if ((i & 63) === 0) tC = engineCoeffs(st, 2300 + rpm * 0.55 + load * 1600, 1.4);
      turbo = engineBp(st, st.rnd() * baseAmp * 0.45, tC, st.tS) * st.boost * 0.6;
    }
    let dec = 0, bf = 0;
    if (st.decel > 0) {
      st.decel--;
      if (st.rnd() > 0.955) dec = st.rnd() * 0.5 * (st.decel / (sr * 0.3));
    }
    if (st.backfire > 0) {
      st.backfire--;
      bf = st.rnd() * (st.backfire / (sr * 0.16)) * 0.75;
    }
    let s = pulse * 0.20
          + Math.sin(st.subPh) * baseAmp * 0.15
          + st.bodyLp * 0.70
          + exh * (0.45 + 0.55 * load) * 0.85
          + intake * (0.35 + 0.45 * load)
          + mech * 0.5
          + turbo + dec + bf;
    s *= st.lim * st.cut;
    const d = s - st.dcX + 0.994 * st.dcY;
    st.dcX = s; st.dcY = d;
    ch[i] = Math.tanh(d * 1.35) * 0.72;
  }
  st.rpm = rpm; st.load = load;
}

const AudioSys = {
  ctx: null, master: null, started: false,
  volume: 0.9, muted: false,
  noiseBuf: null, voice: null,
  weather: { rain: 0, snow: 0 },
  prevThrottle: 0, popCooldown: 0, hornUntil: 0, hornVoice: null,
  workletReady: false, pendingSpec: null,
  scriptOK: false, synthMode: 'legacy',

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 20;
    comp.ratio.value = 8; comp.attack.value = 0.004; comp.release.value = 0.24;
    const masterGain = ctx.createGain();
    masterGain.gain.value = this.volume;
    masterGain.connect(comp);
    comp.connect(ctx.destination);
    this.master = masterGain;
    this.comp = comp;
    // 音量通道：主 / 引擎 / 环境 / 音效
    this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0.9;
    this.engineGain.connect(this.master);
    this.ambientGain = ctx.createGain(); this.ambientGain.gain.value = 1.0;
    this.ambientGain.connect(this.master);
    this.sfxGain = ctx.createGain(); this.sfxGain.gain.value = 0.9;
    this.sfxGain.connect(this.master);
    // 共享噪声缓冲
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    // 全局风声
    this.wind = this._makeLoop(1.15, 'lowpass', this.ambientGain);
    this.wind.gain.gain.value = 0;
    this.wind.src.start();
    // 天气声
    this.rain = this._makeLoop(0.42, 'lowpass', this.ambientGain);
    this.rain.gain.gain.value = 0;
    this.rain.src.start();
    this.rain.bp.frequency.value = 1500;
    // ScriptProcessor 兼容引擎（所有浏览器都有）
    this.scriptOK = !!(ctx.createScriptProcessor || ctx.createJavaScriptNode);
    // 加载逐采样声浪 worklet（失败则退回下方节点图合成）
    if (window.AudioWorkletNode && ctx.audioWorklet) {
      try {
        const url = URL.createObjectURL(new Blob([ENGINE_WORKLET], { type: 'application/javascript' }));
        ctx.audioWorklet.addModule(url).then(() => {
          this.workletReady = true;
          if (this.pendingSpec) this.createCarVoice(this.pendingSpec);
        }).catch(e => {
          console.warn('AudioWorklet 声浪不可用，使用 ScriptProcessor 引擎：', e);
          this.workletReady = false;
        });
      } catch (e) {
        console.warn('AudioWorklet 加载失败，使用 ScriptProcessor 引擎：', e);
        this.workletReady = false;
      }
    }
  },

  _makeLoop(baseGain, filterType, destination) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = filterType; bp.frequency.value = 800; bp.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = baseGain;
    src.connect(bp); bp.connect(g); g.connect(destination || this.master);
    return { src, bp, gain: g };
  },

  _makeViewChain() {
    const ctx = this.ctx;
    const input = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 9000;
    filter.Q.value = 0.55;
    const gain = ctx.createGain();
    gain.gain.value = 0.92;
    input.connect(filter);
    filter.connect(gain);
    gain.connect(this.engineGain);
    return { input, filter, gain };
  },

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); },

  // 暂停时整体静音（suspend 音频上下文），恢复时继续
  setPaused(p) {
    if (!this.ctx) return;
    if (p && !this._paused) {
      this._paused = true;
      try { this.ctx.suspend(); } catch (e) { /* ignore */ }
    } else if (!p && this._paused) {
      this._paused = false;
      try { this.ctx.resume(); } catch (e) { /* ignore */ }
    }
  },

  killVoice() {
    const v = this.voice;
    if (v) {
      try {
        if (v.worklet) {
          v.node.port.postMessage({ stop: 1 });
          v.node.disconnect();
          v.gain.disconnect();
          if (v.bass) v.bass.disconnect();
          if (v.lp) v.lp.disconnect();
        } else if (v.script) {
          v.node.onaudioprocess = null;
          v.node.disconnect();
          v.gain.disconnect();
          if (v.bass) v.bass.disconnect();
          if (v.lp) v.lp.disconnect();
        } else {
          for (const o of v.oscs) o.os.stop();
          if (v.pulseSrc) v.pulseSrc.stop();
          if (v.intake) v.intake.src.stop();
          if (v.turbo) { v.turbo.osc.stop(); v.turbo.n.src.stop(); }
          v.carGain.disconnect();
        }
        if (v.viewInput) v.viewInput.disconnect();
        if (v.viewFilter) v.viewFilter.disconnect();
        if (v.viewGain && v.viewGain !== v.gain) v.viewGain.disconnect();
        if (v._squeal) v._squeal.src.stop();
      } catch (e) {}
    }
    this.voice = null;
  },

  // 为某辆车创建专属声线：优先 worklet，其次旧节点图
  createCarVoice(spec) {
    const ctx = this.ctx; if (!ctx) return null;
    this.pendingSpec = spec;
    this.killVoice();
    if (this.workletReady) {
      try {
        const node = new AudioWorkletNode(ctx, 'horizon-engine', {
          numberOfInputs: 0, numberOfOutputs: 1,
          processorOptions: engineParams(spec),
        });
        // 低音加强 + 高频整形
        const bass = ctx.createBiquadFilter();
        bass.type = 'lowshelf'; bass.frequency.value = 150; bass.gain.value = 4;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 9000;
        const view = this._makeViewChain();
        node.connect(bass); bass.connect(lp); lp.connect(view.input);
        this.voice = {
          worklet: true, node, bass, lp, gain: view.gain,
          viewInput: view.input, viewFilter: view.filter, viewGain: view.gain,
          spec, lastThrottle: 0, _squeal: null
        };
        this.synthMode = 'worklet';
        console.info('[AudioSys] 声浪路径：AudioWorklet 逐采样引擎');
        return this.voice;
      } catch (e) {
        console.warn('worklet 声线创建失败：', e);
        this.workletReady = false;
      }
    }
    if (this.scriptOK) {
      try {
        const node = ctx.createScriptProcessor(1024, 0, 1);
        const st = engineState(engineParams(spec), ctx.sampleRate);
        node.onaudioprocess = (e) => engineProcess(st, e.outputBuffer.getChannelData(0));
        const bass = ctx.createBiquadFilter();
        bass.type = 'lowshelf'; bass.frequency.value = 150; bass.gain.value = 4;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass'; lp.frequency.value = 9000;
        const view = this._makeViewChain();
        node.connect(bass); bass.connect(lp); lp.connect(view.input);
        this.voice = {
          worklet: false, script: true, node, bass, lp, gain: view.gain,
          viewInput: view.input, viewFilter: view.filter, viewGain: view.gain,
          st, spec, lastThrottle: 0, _squeal: null
        };
        this.synthMode = 'script';
        console.info('[AudioSys] 声浪路径：ScriptProcessor 逐采样引擎');
        return this.voice;
      } catch (e) {
        console.warn('ScriptProcessor 声线创建失败：', e);
        this.scriptOK = false;
      }
    }
    // —— 旧节点图（兜底）：振荡器 + 720° 脉冲循环缓冲 ——
    this.synthMode = 'legacy';
    console.info('[AudioSys] 声浪路径：旧节点图（兜底）');
    const cyl = spec.cylinders;
    const view = this._makeViewChain();
    const oscGain = ctx.createGain(); oscGain.gain.value = 0;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = i / 128 - 1;
      curve[i] = Math.tanh(x * 2.2);
    }
    shaper.curve = curve;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const carGain = ctx.createGain(); carGain.gain.value = 0.9;
    oscGain.connect(shaper);
    shaper.connect(lp); lp.connect(carGain); carGain.connect(view.input);
    const pulseGain = ctx.createGain(); pulseGain.gain.value = 0;
    const exhLow = ctx.createBiquadFilter(); exhLow.type = 'bandpass';
    exhLow.frequency.value = 78; exhLow.Q.value = 2.4;
    const exhHi = ctx.createBiquadFilter(); exhHi.type = 'bandpass';
    exhHi.frequency.value = 250; exhHi.Q.value = 1.4;
    const pulseSrc = ctx.createBufferSource();
    pulseSrc.buffer = this._pulseCycle(ctx, cyl);
    pulseSrc.loop = true;
    pulseSrc.connect(pulseGain);
    pulseGain.connect(exhLow); exhLow.connect(exhHi); exhHi.connect(shaper);
    pulseSrc.start();
    const o = [];
    const mk = (type, mult, amp, detune) => {
      const os = ctx.createOscillator(); os.type = type;
      os.frequency.value = 100 * mult;
      os.detune.value = detune || 0;
      const g = ctx.createGain(); g.gain.value = amp;
      os.connect(g); g.connect(oscGain);
      os.start();
      return { os, g };
    };
    o.push(mk('sawtooth', 1, 0.55, 4));
    o.push(mk('sawtooth', 2.003, 0.26, -3));
    o.push(mk('square', 0.5, 0.2, 5));
    o.push(mk('triangle', 3.01, 0.07, 6));
    const intake = this._makeLoop(0, 'bandpass', view.input);
    intake.bp.frequency.value = 2400; intake.bp.Q.value = 1.2;
    intake.src.start();
    let turbo = null;
    if (spec.turbo) {
      const tos = ctx.createOscillator(); tos.type = 'sine'; tos.frequency.value = 2200;
      const tg = ctx.createGain(); tg.gain.value = 0;
      tos.connect(tg); tg.connect(view.input); tos.start();
      const tn = this._makeLoop(0, 'highpass', view.input);
      tn.bp.frequency.value = 5200; tn.src.start();
      turbo = { osc: tos, g: tg, n: tn };
    }
    this.voice = {
      spec, oscs: o, lp, oscGain, intake, turbo,
      pulseSrc, pulseGain, exhLow, exhHi, carGain,
      viewInput: view.input, viewFilter: view.filter, viewGain: view.gain,
      lastThrottle: 0, _squeal: null,
    };
    return this.voice;
  },

  // 720° 点火循环脉冲缓冲（旧合成用）
  _pulseCycle(ctx, cyl) {
    const dur = 0.1;
    const N = Math.max(256, Math.floor(dur * ctx.sampleRate));
    const buf = ctx.createBuffer(1, N, ctx.sampleRate);
    const d = buf.getChannelData(0);
    const sr = ctx.sampleRate;
    const n = cyl;
    const amps = n === 8
      ? [1.0, 0.6, 0.84, 0.68, 0.96, 0.56, 0.78, 0.64]
      : Array.from({ length: n }, (_, i) => 0.85 + 0.15 * Math.sin(i * 2.1));
    const jit = n === 8 ? [-2, 2, 0, -1, 1, 2, -2, 0] : Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const t0 = ((i * (720 / n) + jit[i]) / 720) * dur;
      const f = 92 + 30 * Math.sin(i * 1.63 + 0.4);
      const i0 = Math.floor((t0 / dur) * N);
      const len = Math.floor(0.05 * sr);
      for (let k = 0; k < len; k++) {
        const tt = k / sr;
        const env = Math.exp(-tt * 52) * Math.min(1, tt / 0.0018);
        const s = Math.sin(TAU * f * tt) * 0.9
                + Math.sin(TAU * f * 1.94 * tt) * 0.38
                + Math.sin(TAU * f * 3.07 * tt) * 0.14
                + (Math.random() * 2 - 1) * 0.1;
        d[(i0 + k) % N] += amps[i] * env * s;
      }
    }
    let peak = 0;
    for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(d[i]));
    if (peak > 0.92) { const k = 0.92 / peak; for (let i = 0; i < N; i++) d[i] *= k; }
    return buf;
  },

  replaceVoice(spec) {
    this.createCarVoice(spec);
  },

  // 回火放炮（旧合成）
  _pop(voice, big) {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dest = voice && voice.viewInput ? voice.viewInput : this.master;
    const o = ctx.createOscillator(); o.type = 'square';
    const f0 = 120 + Math.random() * 160;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(38 + Math.random() * 15, t + 0.16);
    const g = ctx.createGain();
    const amp = big ? 0.34 : 0.18;
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(300, t + 0.18);
    o.connect(lp); lp.connect(g); g.connect(dest);
    o.start(t); o.stop(t + 0.2);
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(amp * 0.5, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    const nl = ctx.createBiquadFilter(); nl.type = 'bandpass';
    nl.frequency.value = 900 + Math.random() * 700; nl.Q.value = 0.8;
    n.connect(nl); nl.connect(ng); ng.connect(dest);
    n.start(t); n.stop(t + 0.1);
  },

  // 换挡撞击声
  _clunk() {
    const ctx = this.ctx; const t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 950; bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.4, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    n.connect(bp); bp.connect(g); g.connect(this.sfxGain);
    n.start(t); n.stop(t + 0.07);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(55, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.22, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
    o.connect(og); og.connect(this.sfxGain); o.start(t); o.stop(t + 0.12);
  },

  _thud(power) {
    const ctx = this.ctx; const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(75, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.28);
    const g = ctx.createGain();
    const amp = 0.25 + power * 0.5;
    g.gain.setValueAtTime(amp, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g); g.connect(this.sfxGain); o.start(t); o.stop(t + 0.32);
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(amp * 0.6, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(lp); lp.connect(ng); ng.connect(this.sfxGain);
    n.start(t); n.stop(t + 0.18);
  },

  horn() {
    if (!this.ctx || this.hornUntil > this.ctx.currentTime) return;
    const ctx = this.ctx; const t = ctx.currentTime;
    const mk = (f) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.16, t + 0.03);
      g.gain.setValueAtTime(0.16, t + 0.35);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.65);
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
      o.connect(lp); lp.connect(g); g.connect(this.sfxGain);
      o.start(t); o.stop(t + 0.7);
    };
    mk(410); mk(305); mk(205);
    this.hornUntil = t + 0.62;
  },

  viewProfile(cam) {
    return [
      { name: 'chase-exterior', gain: 0.92, cutoff: 9200, bass: 4.0, wind: 0.78 },
      { name: 'cockpit-interior', gain: 1.02, cutoff: 2600, bass: 8.5, wind: 0.38 },
      { name: 'hood-exterior', gain: 1.00, cutoff: 6200, bass: 5.5, wind: 0.72 },
      { name: 'far-exterior', gain: 0.56, cutoff: 3600, bass: 2.5, wind: 0.58 },
    ][cam] || { name: 'chase-exterior', gain: 0.92, cutoff: 9200, bass: 4.0, wind: 0.78 };
  },

  // 每帧更新声浪参数
  update(car) {
    if (!this.ctx || !this.voice) return;
    const v = this.voice;
    const spec = v.spec;
    const rpm = car.engineRpm;
    const throttle = car.input.throttle;
    const speed = car.speed;
    const t = this.ctx.currentTime;
    const slip = Math.min(1, Math.abs(car.slipAngleF) * 1.8 + Math.abs(car.slipAngleR) * 0.7);
    const load = clamp(throttle + slip * 0.35 + (rpm / spec.redline) * 0.25, 0, 1.6);
    // 视角音效区分：驾驶室引擎更近更响、风声更清晰；追逐视角整体略远
    const cam = (typeof Game !== 'undefined') ? (Game.camMode || 0) : 0;
    const view = this.viewProfile(cam);
    if (v.viewGain) v.viewGain.gain.setTargetAtTime(view.gain, t, 0.10);
    if (v.viewFilter) {
      v.viewFilter.frequency.setTargetAtTime(view.cutoff, t, 0.10);
      v.viewFilter.Q.setTargetAtTime(cam === 1 ? 0.85 : 0.55, t, 0.12);
    }
    if (v.bass) v.bass.gain.setTargetAtTime(view.bass, t, 0.12);
    // 风声
    const windT = clamp((speed / 68) ** 1.8, 0, 1);
    this.wind.gain.gain.setTargetAtTime(windT * 0.22 * view.wind, t, 0.15);
    this.wind.bp.frequency.setTargetAtTime(300 + speed * 16, t, 0.1);
    // 雨雪
    const weatherK = cam === 1 ? 0.42 : cam === 2 ? 0.75 : 1;
    this.rain.gain.gain.setTargetAtTime((this.weather.rain * 0.16 + this.weather.snow * 0.05) * weatherK, t, 0.2);
    // 轮胎尖叫
    const drift = Math.max(0, (slip - 0.18) * 1.4);
    v._squeal = v._squeal || (() => {
      const n = this._makeLoop(0, 'bandpass');
      n.bp.frequency.value = 1150; n.bp.Q.value = 2.2; n.src.start();
      return n;
    })();
    const tireK = cam === 1 ? 0.48 : cam === 2 ? 0.78 : 1;
    v._squeal.gain.gain.setTargetAtTime(clamp(drift * drift * 0.28 * tireK, 0, 0.3), t, 0.07);

    if (v.worklet) { this._updateWorklet(car, v, rpm, throttle, load, t); }
    else if (v.script) { this._updateScript(car, v, rpm, throttle, load, t); }
    else { this._updateLegacy(car, v, rpm, throttle, load, t); }
  },

  // —— ScriptProcessor 声线：直接写状态对象（算法与 worklet 一致） ——
  _updateScript(car, v, rpm, throttle, load, t) {
    const spec = v.spec, st = v.st;
    let lim = 1;
    if (rpm > spec.redline * 0.985) lim = 0.26 + 0.34 * (0.5 + 0.5 * Math.sin(t * 46));
    let cut = 1;
    if (car.shiftTimer > 0 && car.shiftTimer < 0.16) cut = 0.05;
    st.tRpm = rpm; st.tLoad = load; st.lim = lim; st.cut = cut;
    if (spec.turbo) st.boost = throttle > 0.4 ? (rpm / spec.redline) * 0.7 + throttle * 0.3 : 0;
    const lifted = v.lastThrottle > 0.45 && throttle < 0.1;
    if (lifted && rpm > 2600 && car.speed > 3) st.decel = Math.round(st.sr * (0.20 + 0.25 * st.crackle));
    if (lifted && rpm > 4600 && Math.random() < 0.22) st.backfire = Math.round(st.sr * 0.16);
    v.lastThrottle = throttle;
  },

  // —— worklet 声线：把物理状态发给逐采样合成器 ——
  _updateWorklet(car, v, rpm, throttle, load, t) {
    const spec = v.spec;
    let lim = 1;
    if (rpm > spec.redline * 0.985) {
      lim = 0.26 + 0.34 * (0.5 + 0.5 * Math.sin(t * 46));
    }
    let cut = 1;
    if (car.shiftTimer > 0 && car.shiftTimer < 0.16) cut = 0.05;
    const msg = { rpm, load, lim, cut };
    if (spec.turbo) {
      msg.boost = throttle > 0.4 ? (rpm / spec.redline) * 0.7 + throttle * 0.3 : 0;
    }
    const lifted = v.lastThrottle > 0.45 && throttle < 0.1;
    if (lifted && rpm > 2600 && car.speed > 3) msg.decel = 1;
    if (lifted && rpm > 4600 && Math.random() < 0.22) msg.backfire = 1;
    v.lastThrottle = throttle;
    v.node.port.postMessage(msg);
  },

  // —— 旧节点图声线（兜底） ——
  _updateLegacy(car, v, rpm, throttle, load, t) {
    const spec = v.spec;
    const f0 = Math.max(20, rpm / 60 * spec.cylinders / 2);
    v.oscs[0].os.frequency.setTargetAtTime(f0, t, 0.02);
    v.oscs[1].os.frequency.setTargetAtTime(f0 * 2.003, t, 0.02);
    v.oscs[2].os.frequency.setTargetAtTime(Math.max(18, f0 * 0.5), t, 0.02);
    v.oscs[3].os.frequency.setTargetAtTime(f0 * 3.01, t, 0.02);
    v.pulseSrc.playbackRate.setTargetAtTime(clamp(rpm / 1200, 0.3, 8), t, 0.02);
    let lim = 1;
    if (rpm > spec.redline * 0.985) lim = 0.28 + 0.35 * (0.5 + 0.5 * Math.sin(t * 46));
    let cut = 1;
    if (car.shiftTimer > 0 && car.shiftTimer < 0.16) cut = 0.06;
    const base = (0.055 + rpm / spec.redline * 0.12 + throttle * 0.2);
    const target = base * load * lim * cut;
    v.oscGain.gain.setTargetAtTime(clamp(target, 0, 0.9), t, 0.045);
    v.lp.frequency.setTargetAtTime(clamp(320 + rpm * 0.82 + throttle * 1700, 320, 9000), t, 0.03);
    const pulseAmp = clamp((0.14 + rpm / spec.redline * 0.10 + throttle * 0.14) * (0.55 + load * 0.55) * lim * cut, 0, 0.42);
    v.pulseGain.gain.setTargetAtTime(pulseAmp, t, 0.03);
    const isBig = spec.cylinders >= 8;
    const resF = clamp(58 + rpm * 0.016, 55, 150) * (isBig ? 1 : 1.3);
    v.exhLow.frequency.setTargetAtTime(resF, t, 0.05);
    v.exhLow.Q.setTargetAtTime(isBig ? 2.5 : 1.8, t, 0.1);
    v.exhHi.frequency.setTargetAtTime(resF * 3.1, t, 0.05);
    v.exhHi.Q.setTargetAtTime(isBig ? 1.5 : 1.0, t, 0.1);
    v.intake.gain.gain.setTargetAtTime(clamp(0.012 + throttle * 0.055 + rpm / spec.redline * 0.03, 0, 0.14), t, 0.06);
    v.intake.bp.frequency.setTargetAtTime(clamp(f0 * 8, 800, 5200), t, 0.05);
    if (v.turbo) {
      const boost = throttle > 0.4 ? (rpm / spec.redline) * 0.7 + throttle * 0.3 : 0;
      v.turbo.osc.frequency.setTargetAtTime(1600 + f0 * 5 + throttle * 900, t, 0.08);
      v.turbo.g.gain.setTargetAtTime(clamp(boost * 0.10, 0, 0.1), t, 0.1);
      v.turbo.n.gain.gain.setTargetAtTime(clamp(boost * 0.05, 0, 0.05), t, 0.1);
    }
    const lifted = v.lastThrottle > 0.45 && throttle < 0.1;
    if (lifted && rpm > 2800 && car.speed > 3 && this.popCooldown <= 0) {
      const n = 1 + Math.floor(Math.random() * (1 + Math.round(rpm / 3000)));
      for (let i = 0; i < n; i++) {
        const dt = 0.05 + Math.random() * 0.22;
        setTimeout(() => { if (this.ctx) this._pop(v, Math.random() < 0.35); }, dt * 1000);
      }
      this.popCooldown = 0.5 + Math.random() * 0.5;
    }
    this.popCooldown = Math.max(0, this.popCooldown - 1 / 60);
    v.lastThrottle = throttle;
  },

  onGear() { if (this.ctx && this.voice) this._clunk(); },
  impact(p) { if (this.ctx) this._thud(clamp(p, 0, 1)); },
  // 物体掠过的“刷刷”声：短促噪声扫频
  whoosh(vol) {
    if (!this.ctx || this.muted || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.8;
    bp.frequency.setValueAtTime(420, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.13);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0015, vol), t + 0.025);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    src.connect(bp); bp.connect(g); g.connect(this.sfxGain);
    src.start(t, Math.random() * 0.5, 0.3);
    src.stop(t + 0.3);
  },
  setVolume(type, v) {
    v = Math.max(0, Math.min(1, v));
    const t = this.ctx ? this.ctx.currentTime : 0;
    if (type === 'engine' && this.engineGain) this.engineGain.gain.setTargetAtTime(v, t, 0.05);
    else if (type === 'ambient' && this.ambientGain) this.ambientGain.gain.setTargetAtTime(v, t, 0.08);
    else if (type === 'sfx' && this.sfxGain) this.sfxGain.gain.setTargetAtTime(v, t, 0.05);
    else {
      this.volume = v;
      if (this.master) this.master.gain.setTargetAtTime(v, t, 0.05);
    }
  },
};
