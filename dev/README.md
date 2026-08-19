# dev/ — 开发与验证辅助脚本

主项目无构建步骤，运行时不依赖本目录。这里存放开发/验证用的辅助脚本与道路规划图。

## CDP 浏览器内验证

`eval_async.mjs` / `multi_shot.mjs` 用 Chrome DevTools Protocol 加载真实游戏并执行页面内表达式：

```powershell
node dev\eval_async.mjs "file:///C:/你的本地路径/horizon-racing/index.html" `
  "@dev\verify_steering.js" 1200 1280 720 "window.__stage==='input'" `
  shots\steer_918_cockpit.png
```

- `@` 开头表示表达式从文件读取；脚本支持 `await`
- `verify_*.js` 返回 JSON 结果，内含 `ok` / 关键数据 / `error`
- 一次只开一个 Chrome 实例
- 输出截图默认放在 `shots/`（已被 .gitignore 忽略）

## 常用验证

| 脚本 | 用途 |
| --- | --- |
| `verify_steering.js` | 方向盘：12 部件整体旋转 + 平滑 + GT rig |
| `verify_steering_timing.js` | 方向盘平滑时间曲线（150ms 采样） |
| `verify_switchbacks.js` | AI 巡路验证天梯发卡弯 |
| `verify_city2.js` / `verify_city3.js` | 城市地图生成与驾驶验证 |
| `qwen_city_review.mjs` | DashScope 视觉评审（key 从环境变量 `DASHSCOPE_KEY` 读取） |

## 道路规划图

- `city_plan_v4.svg`：海特洛2 采用的最终网格路网方案
- `city_plan_v2/v3`：历史迭代方案
