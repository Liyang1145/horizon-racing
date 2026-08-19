// 多角度连拍：先隐藏游戏 UI，逐个执行相机表达式并截图
// 用法: node multi_shot.mjs <url> <plan.json> [waitMs] [readyExpr] [width] [height]
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const url = process.argv[2];
const planFile = process.argv[3];
const waitMs = parseInt(process.argv[4] || '20000', 10);
const readyExpr = process.argv[5] || '';
const width = parseInt(process.argv[6] || '960', 10);
const height = parseInt(process.argv[7] || '540', 10);
const dsf = parseFloat(process.argv[8] || '2');
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const port = 9800 + Math.floor(Math.random() * 150);
const profile = process.env.TEMP + '\\cdp-multi-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--noerrdialogs',
  '--allow-file-access-from-files',
  '--window-size=' + width + ',' + height,
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + profile,
  'about:blank',
], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function cleanup() {
  const marker = profile.split('\\').pop();
  const mainPid = await new Promise(resolve => {
    execFile('wmic', ['process', 'where', "name='chrome.exe'", 'get', 'ProcessId,CommandLine', '/format:list'], (err, stdout) => {
      if (err) return resolve(null);
      let cmd = '', pid = '';
      for (const line of String(stdout).split('\r\n')) {
        if (line.startsWith('CommandLine=')) cmd = line.slice(12);
        else if (line.startsWith('ProcessId=')) pid = line.slice(10).trim();
        else if (line.trim() === '') {
          if (cmd.includes(marker) && cmd.includes('--headless=new') && !cmd.includes('--type=')) return resolve(pid);
          cmd = ''; pid = '';
        }
      }
      resolve(null);
    });
  });
  if (mainPid) await new Promise(r => execFile('taskkill', ['/F', '/T', '/PID', mainPid], () => r()));
  if (chrome && chrome.pid) { try { chrome.kill('SIGKILL'); } catch (e) {} }
  await sleep(1200);
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) {}
}

try {
  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {}
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('CDP not reachable');
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  };
  await new Promise(r => { ws.onopen = r; });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile: false });
  await send('Page.navigate', { url });
  if (readyExpr) {
    const t0 = Date.now();
    for (;;) {
      try {
        const ev = await send('Runtime.evaluate', { expression: readyExpr, returnByValue: true });
        if (ev && ev.result && ev.result.value) break;
      } catch (e) {}
      if (Date.now() - t0 > 90000) break;
      await sleep(400);
    }
  }
  await sleep(waitMs);
  for (const shot of plan) {
    const ev = await send('Runtime.evaluate', { expression: shot.expr, awaitPromise: true, returnByValue: true });
    const val = ev && ev.result && ev.result.value;
    if (val && String(val).startsWith('ERR')) {
      console.log('SHOT_FAIL ' + shot.out + ' :: ' + String(val));
      continue;
    }
    await sleep(800);
    const shot2 = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shot.out, Buffer.from(shot2.data, 'base64'));
    console.log('SAVED ' + shot.out + ' ' + Math.round(shot2.data.length / 1024) + 'KB');
  }
  try { ws.close(); } catch (e) {}
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  await cleanup();
  process.exit(1);
}
