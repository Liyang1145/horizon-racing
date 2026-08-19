(async () => {
  try {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 700; i++) {
      if (typeof Game !== 'undefined' && Game.car && Game.world && window.__P918_READY) break;
      await sleep(300);
    }
    if (typeof Game === 'undefined' || !Game.world) return { error: 'not ready' };
    const w = Game.world;
    const rt = w.trafficRoutes.find(r => r.id === 'switchbacks');
    if (!rt) return { error: 'no switchbacks route' };
    const r3 = v => Math.round(v * 1000) / 1000;
    const out = {
      samples: rt.samples.length,
      length: r3(rt.samples[rt.samples.length - 1].d),
      first: rt.samples[0] ? [rt.samples[0].x, rt.samples[0].z] : null,
      last: rt.samples[rt.samples.length - 1] ? [rt.samples[rt.samples.length - 1].x, rt.samples[rt.samples.length - 1].z] : null,
      zRange: rt.samples.length ? [Math.min(...rt.samples.map(s => s.z)), Math.max(...rt.samples.map(s => s.z))].map(r3) : null,
    };
    // AI 巡路跑发夹弯
    Game.startRoutePatrol();
    Game.patrolRoutes = ['switchbacks'];
    Game.patrolSpeed = 6;
    Game.placeAIRoute(0);
    await sleep(1000);
    const trace = [];
    for (let i = 0; i < 90; i++) {
      await sleep(350);
      trace.push({
        idx: Game.ai.routeIdx,
        speed: r3(Game.car.speedKmh),
        off: r3(Game.ai.routeMaxOff),
      });
      if (Game.ai.routeIdx >= rt.samples.length - 3) break;
    }
    out.trace = trace.slice(0, 8).concat(trace.slice(-4));
    out.completed = Game.ai.routeIdx >= rt.samples.length - 3;
    out.finalIdx = Game.ai.routeIdx;
    out.maxOff = r3(Game.ai.routeMaxOff);
    out.err = window.__lastErr || null;
    return out;
  } catch (e) {
    return { error: String(e && e.stack || e), message: String(e && e.message || e) };
  }
})()
