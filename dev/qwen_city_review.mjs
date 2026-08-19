// dev/qwen_city_review.mjs — 把城市截图批量发给阿里云 DashScope qwen3-vl-plus 评审。
// key 从环境变量 DASHSCOPE_KEY 读取，不写入仓库文件。
// 用法：
//   $env:DASHSCOPE_KEY='sk-...'; node dev\qwen_city_review.mjs <image1.png> [image2.png ...]
// 输出 JSON：{ ok, reviews:[{file, score, satisfied, issues, raw}] }
import { readFileSync } from 'node:fs';

const key = process.env.DASHSCOPE_KEY;
if (!key) {
  console.error('missing DASHSCOPE_KEY');
  process.exit(2);
}
// 模型选择：--model=xxx 参数 > REVIEW_MODEL 环境变量 > 默认 qwen3-vl-plus
const modelArg = process.argv.find(a => a.startsWith('--model='));
const model = (modelArg ? modelArg.slice(8) : '') || process.env.REVIEW_MODEL || 'qwen3.7-plus';
const files = process.argv.slice(2).filter(a => !a.startsWith('--model=') && a);
if (!files.length) {
  console.error('usage: node dev\\qwen_city_review.mjs [--model=qwen-vl-max] <img.png> ...');
  process.exit(2);
}

const system = '你是资深二次元赛车游戏画面评审员，熟悉新海诚风格与三渲二城市地图。只输出一个 JSON 对象，不要任何其它文字。字段：score 为 0-100 整数；issues 为字符串数组，列出画面中可见问题（穿模、悬浮、贴地错误、比例失调、重复感、构图差、光影不和谐、明显性能痕迹等），无问题则为空数组；satisfied 为布尔值，表示整体是否合格（>=80 分且无严重问题）。';
const user = '请评审这张赛车游戏城市地图截图。';

async function reviewOne(file) {
  const b64 = readFileSync(file).toString('base64');
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          { type: 'text', text: user },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
        ],
      },
    ],
    max_tokens: 700,
  };
  const t0 = Date.now();
  const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(resp.status + ' ' + JSON.stringify(json).slice(0, 500));
  const raw = json.choices && json.choices[0] && json.choices[0].message
    ? json.choices[0].message.content : '';
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const m = String(raw).replace(/```json|```/g, '').match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e2) { /* keep null */ } }
  }
  return {
    file,
    ms: Date.now() - t0,
    score: parsed && typeof parsed.score === 'number' ? parsed.score : null,
    satisfied: parsed && typeof parsed.satisfied === 'boolean' ? parsed.satisfied : null,
    issues: parsed && Array.isArray(parsed.issues) ? parsed.issues : null,
    raw,
  };
}

const out = { ok: true, model, reviews: [] };
for (const f of files) {
  try {
    out.reviews.push(await reviewOne(f));
  } catch (e) {
    out.reviews.push({ file: f, error: String(e && e.message || e) });
    out.ok = false;
  }
}
const all = out.reviews.every(r => r.satisfied === true);
out.allSatisfied = !!out.reviews.length && all;
out.avgScore = out.reviews.length
  ? out.reviews.reduce((s, r) => s + (r.score || 0), 0) / out.reviews.length
  : 0;
console.log(JSON.stringify(out, null, 2));
