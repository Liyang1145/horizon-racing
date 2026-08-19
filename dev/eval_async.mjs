// CDP 异步求值工具：等待页面后执行支持 await 的表达式并打印结果
// 用法: node eval_async.mjs <url> <expr> [waitMs] [width] [height] [readyExpr]
import { spawn, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const url = process.argv[2];
let expr = process.argv[3];
if (expr && expr.startsWith('@')) expr = readFileSync(expr.slice(1), 'utf8');
const waitMs = parseInt(process.argv[4] || '20000', 10);
const width = process.argv[5] || '800';
const height = process.argv[6] || '500';
const readyExpr = process.argv[7] || '';
const shotFile = process.argv[8] || '';
const port = 9700 + Math.floor(Math.random() * 200);
const profile = process.env.TEMP + '\\cdp-eval-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
const chrome = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--noerrdialogs',
  '--allow-file-access-from-files',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
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
  await send('Emulation.setDeviceMetricsOverride', { width: +width, height: +height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  if (readyExpr) {
    const t0 = Date.now();
    for (;;) {
      try {
        const ev = await send('Runtime.evaluate', { expression: readyExpr, returnByValue: true });
        if (ev && ev.result && ev.result.value) break;
      } catch (e) {}
      if (Date.now() - t0 > 300000) break;
      await sleep(400);
    }
  }
  await sleep(waitMs);
  const ev = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('EVAL_RESULT:', JSON.stringify(ev && ev.result && ev.result.value));
  if (shotFile) {
    // 等几帧让相机动效/渲染落地
    await sleep(900);
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(shotFile, Buffer.from(shot.data, 'base64'));
    console.log('SAVED ' + shotFile + ' ' + Math.round(shot.data.length / 1024) + 'KB');
  }
  try { ws.close(); } catch (e) {}
  await cleanup();
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  await cleanup();
  process.exit(1);
}
