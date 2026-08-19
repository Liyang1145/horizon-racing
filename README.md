# HORIZON · 地平线赛车
作者唯一提示：全项目包括readme由ai构建。主要为0731flash。
目前一些主要问题：保时捷声浪。城市地图构建。悬挂系统、漂移系统还原。卡顿。
作者是准大一，啥都不懂，自己烧些零花钱搞个小游戏玩，致敬一下地平线。现在由于精力不够、ds大幅上涨，所以自己很难继续发展了。
希望有大佬和更强的模型做更好的游戏。
ai分割线


致敬《极限竞速：地平线》系列的浏览器开放世界赛车游戏。**纯本地、离线、零构建、零依赖**：
经典 `<script>` + Three.js r128 + cannon-es，双击 `index.html` 即玩。

## 快速开始

- 双击 `启动游戏.bat`（自动用 Chrome 带本地文件访问参数打开）；
  或者直接用 Chrome / Edge 打开 `index.html`（资产已内嵌，file:// 直开即可）。
- 首次进入等世界生成完成（约 2~5 秒），点击 **进入世界** 开始自由漫游。
- 主菜单可切换 6 辆车（默认保时捷 918）和 4 张地图。

## 地图

| 地图 | 说明 |
| --- | --- |
| 阿尔卑斯湖谷 | 默认地图：湖谷环线、天梯发卡弯山路、雪山垭口、南北大道、越野环线 |
| 海特洛市 | 程序化生成的新海诚风三渲二动漫城市：网格路网、CBD、旧城、滨海大道、高架 |
| 海特洛2 | 道路规划 v4 版本：更疏朗的网格路网、正规十字/T 字路口、平滑滨海 S 弯路 |
| 程序化都市 GLB | 导入外部程序化城市模型（procedural_city_6）：真实街道/建筑/树木，车轮可在模型街道上行驶 |

## 操作

| 按键 | 功能 |
| --- | --- |
| W / ↑ | 油门 |
| S / ↓ | 刹车（停住按 S 进倒挡，再按 W 回前进挡） |
| A / D | 转向 |
| 空格 | 手刹（漂移） |
| Q / E | 手动降挡 / 升挡 |
| C | 切换视角（追逐 / 驾驶舱 / 引擎盖 / 远距） |
| H | 喇叭 |
| R | 复位到道路 |
| T / Y / U | 切换时间 / 季节 / 天气 |
| M | 打开/关闭动态大地图 |
| F | 全屏 |
| F1 | 操作帮助 |
| Esc | 暂停 |
| P | 画面/音量/相机滑条面板 |
| V + 鼠标 | 环视 |
| L | 游戏加速 ×4 |
| I / H | 进入 / 退出开发者模式（自由飞行、地形笔刷、画路） |

## 特色

- **真四轮物理**：cannon-es RaycastVehicle，四轮独立悬挂/抓地/驱动，整张地图都是实体地形，可自由越野
- **真·开放世界**：程序化地形（高原/山地/海岸/湖泊）+ 手调路网 + 车流 AI + 漂移/飞跃/擦肩/极速技能分
- **四季与昼夜**：季节联动地形、植被、天空与路面附着力；日出到深夜，路灯/车灯/星空自动开关
- **天气**：晴天 / 雨天 / 雾天，雨幕、雨声、光照、环境音全部联动
- **车辆**：6 辆车（含保时捷 918 GLB 完整车模，主动尾翼 + 后轮转向 + 全总成同步旋转的方向盘）
- **画面**：电影级后处理（色调/色带/描边/暗角）、动态 FOV、飞跃慢动作、尾灯光带、真实沥青贴图
- **发动机声浪**：AudioWorklet 逐采样合成（十字曲轴 V8 点火次序、排气管共振、回火放炮），每车独立
- **动漫城市**：程序化街块与立面、店铺招牌、路灯、树木、高架路、有轨电车与滨海大道

## 文件结构

```
horizon-racing/
├── index.html            # 入口（脚本加载顺序固定，勿重排）
├── 启动游戏.bat          # Windows 启动器（自动找 Chrome）
├── lib/                  # three.min.js / cannon-es.js / GLTFLoader.js（全部本地）
├── js/
│   ├── utils.js          # 常量：MAPS / CAR_SPECS / TUNING / P918_TUNE / 数学与噪声
│   ├── world.js          # 程序化世界：地形、路网、城市地表、高架、物理地面
│   ├── engine.js         # 物理世界：高度场碰撞、水域、天气粒子
│   ├── physics.js        # 车辆：RaycastVehicle 四轮悬挂、918 独立物理、视觉总成
│   ├── main.js           # 主循环、输入、相机、地图/菜单、AI 车流
│   ├── traffic.js / ai.js / ui.js / audio.js
│   └── city_*.js         # 城市管线：街块、建筑立面、道路/路口、道具、树木、天空、后处理、GLB 导入
├── assets/
│   ├── models/           # porsche918_glb.js、procedural_city_6_data.js（base64 JS 内嵌）
│   └── textures/         # ambientCG CC0 沥青/碎石贴图 + 内嵌路面纹理
└── dev/                  # 开发验证脚本（不影响运行）
```

## 开发与调试

- 无构建步骤；改动后逐文件语法检查：`node --check js\*.js`（每个文件单独跑）
- 公共命名空间：`window.GAME`（`MAPS` / `CAR_SPECS` / `CFG` / `TUNING` / `P918_TUNE` / `DEBUG`）
- 调试钩子：`window.__stage` / `__err` / `__carStage` / `__P918_READY` 等是截图与巡路工具读取的契约
- URL 参数：`?debug=1` 冗长日志、`?nofx=1` 关后处理、`?speedshot=1` 全速截图、`?scenic=1` 观景、
  `?patrol=1&speed=8` AI 巡路验证、`?raceai=1` 自动人机赛
- 浏览器内验证脚本（一次只开一个 Chrome 实例）：

```powershell
node dev\eval_async.mjs "file:///C:/你的路径/horizon-racing/index.html" "@dev\verify_steering.js" 1200 1280 720 "window.__stage==='input'"
```

- `dev/qwen_city_review.mjs`：DashScope 视觉评审工具，key 从环境变量 `DASHSCOPE_KEY` 读取，不写入仓库
- 驾驶手感默认值（`TUNING` / `P918_TUNE`）经过大量调校，请勿随意改动

## 版权与素材

- 游戏代码以 MIT 协议开源（见 `LICENSE`）。
- 路面纹理来自 [ambientCG](https://ambientcg.com/)（CC0）。
- 发动机声浪合成思路参考 GitHub 上的 ghurni / Antonio-R1 engine-sound-generator。
- 保时捷 918 与程序化城市 GLB 为导入模型，版权归原模型作者；本项目是个人爱好者作品，与 Porsche AG 无关。
