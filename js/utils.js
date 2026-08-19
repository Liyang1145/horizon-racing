// ============================================================
//  HORIZON 赛车 — 工具 / 配置 / 噪声 / 车辆数据
// ============================================================
'use strict';

const CFG = {
  worldHalf: 2700,          // 世界半宽 (m)
  waterLevel: 5.0,          // 湖面高度
  roadWidth: 7.6,
  grav: 9.81,
  fps: 60,
};

// ---------- 漂移调参（菜单滑条实时调整） ----------
const TUNING = {
  drift: 1.0,      // 漂移强度：手刹旋转上限
  counter: 1.0,    // 反打增益：随漂移角度的反打力度
  rearGrip: 1.0,   // 后轮抓地：越小越容易起漂
  handbrake: 1.0,  // 手刹力度
  smallAngle: 0,   // 小角度反打抑制：0~1，越大则小漂移角时反打越弱
};

// ---------- 保时捷 918 实时调参（游戏内 O 键控制面板，不沿用 GT 漂移调参） ----------
const P918_TUNE = {
  suspStiff: 1.0,   // 悬挂刚度
  dampComp: 1.0,    // 压缩阻尼
  dampRelax: 1.0,   // 回弹阻尼
  gripK: 1.0,       // 轮胎抓地
  steerK: 1.0,      // 转向响应
  steerMax: 1.0,    // 前轮最大转角
  brakeF: 1.0,      // 前刹车
  brakeR: 1.0,      // 后刹车
  downforceK: 1.0,  // 空气下压力
  torqueK: 1.0,     // 动力输出
  rollK: 1.0,       // 侧倾抑制
  shiftSpeed: 1.0,  // 换挡速度
  rimOffsetX: 0,    // 旧版单滑条偏移（米，保留兼容）
  rimFL: 0,         // 左前轮毂左右偏移（米，沿轮轴）
  rimFR: 0,         // 右前轮毂左右偏移（米）
  rimRL: 0,         // 左后轮毂左右偏移（米）
  rimRR: 0,         // 右后轮毂左右偏移（米）
  tireFL: 0,        // 左前轮胎左右偏移（米，沿轮轴）
  tireFR: 0,        // 右前轮胎左右偏移（米）
  tireRL: 0,        // 左后轮胎左右偏移（米）
  tireRR: 0,        // 右后轮胎左右偏移（米）
};

// ---------- 地图配置（规整路网：大环线 + 十字干道 + 村庄/湖区/雪山支线） ----------
const MAPS = [
  {
    id: 'alpine', name: '阿尔卑斯湖谷',
    desc: '雪山 + 大湖 + 河谷平原；大环线 + 十字高速 + 湖岸 + 雪山垭口 + 沿海赛环',
    fogDensity: 0.00030,
    seasons: [
      { name: '春', grassA: 0x4fa53a, grassB: 0x63c050, field: 0xc9a94f, tree: 0x3c7d2c, fog: 0xdbeef2, sun: 0xfff1c4, sky: 0x5cb2e8, water: 0x22a0d8 },
      { name: '夏', grassA: 0x33912b, grassB: 0x4fbc45, field: 0xd8b65c, tree: 0x2f6b22, fog: 0xcfe8ef, sun: 0xfff6d8, sky: 0x3f9fe0, water: 0x1a90d0 },
      { name: '秋', grassA: 0x9c8a3a, grassB: 0xb29b44, field: 0xdfa84c, tree: 0x7c5420, fog: 0xdacaa8, sun: 0xffdfa0, sky: 0x9fb6c0, water: 0x3f7f96 },
      { name: '冬', grassA: 0xe8efe9, grassB: 0xf4f8f4, field: 0xecefe8, tree: 0x5e5038, fog: 0xe4ecef, sun: 0xfff4d8, sky: 0xa8c2d8, water: 0x3a7090 },
    ],
    roads: [
      // 湖谷大环线：绕湖区一圈的平滑闭合干线
      { id: 'ring', w: 20, mat: 'asphalt', closed: true, pts: [
        [-1500, -1150], [-1000, -1450], [-400, -1500], [300, -1450], [900, -1150],
        [1350, -800], [1500, -250], [1450, 350], [1150, 850], [600, 1100],
        [0, 1150], [-550, 1100], [-1100, 900], [-1450, 500], [-1580, 0], [-1570, -600],
      ] },
      // 东西高速：穿中心 (0,0)，西端穿入大环线，与南北大道呈正十字交叉，东端沿河谷接大环线东南点
      { id: 'cross', w: 20, mat: 'asphalt', pts: [[-2200, -150], [-1500, -220], [-900, -120], [-380, -120], [0, 0], [450, 80], [700, -300], [900, -1150]] },
      // 南北大道：湖西侧纵贯（位于湖岸环线以西），与东西高速正十字交叉
      { id: 'northsouth', w: 20, mat: 'asphalt', pts: [[-470, -2100], [-482, -1550], [-488, -1100], [-484, -700], [-482, -300], [-482, 0], [-484, 400], [-487, 750], [-470, 1110], [-410, 1600], [-310, 2050]] },
      // 湖岸风景环线：紧贴大湖一圈
      { id: 'lakeloop', w: 12, mat: 'asphalt', closed: true, pts: [[-320, 680], [-80, 880], [240, 960], [540, 830], [650, 570], [450, 370], [110, 330], [-240, 410], [-450, 570]] },
      // 湖连接线：环线北侧 → 湖岸环线西北口
      { id: 'lakeconn', w: 14, mat: 'asphalt', pts: [[0, 1150], [-200, 950], [-320, 680]] },
      // 雪山垭口土路：大环线东南 → 东北主峰 → 大环线东北（越野爬山）
      { id: 'mountain', w: 13, mat: 'dirt', pts: [
        [1350, -800], [1600, -700], [1850, -550], [2050, -350], [2150, -100],
        [2100, 150], [1950, 320], [1700, 380], [1450, 350],
      ] },
      // 天梯发卡弯：从东北环线经东侧山腹连续 U 弯爬上主峰平台，终点接 mountain 路
      { id: 'switchbacks', w: 12, mat: 'asphalt', climb: 170, pts: [
        [1350, -800], [1362, -800], [1374, -800], [1386, -801],
        [1398, -801], [1410, -801], [1422, -801], [1434, -801],
        [1446, -801], [1458, -802], [1470, -802], [1482, -802],
        [1494, -802], [1506, -802], [1518, -802], [1530, -803],
        [1542, -803], [1554, -803], [1566, -803], [1578, -803],
        [1590, -803], [1602, -804], [1614, -804], [1626, -804],
        [1638, -804], [1650, -804], [1662, -804], [1674, -805],
        [1686, -805], [1698, -805], [1710, -805], [1722, -805],
        [1734, -805], [1746, -806], [1758, -806], [1770, -806],
        [1782, -806], [1794, -806], [1806, -807], [1818, -807],
        [1830, -807], [1842, -807], [1854, -807], [1866, -807],
        [1878, -808], [1890, -808], [1902, -808], [1914, -808],
        [1926, -808], [1938, -808], [1950, -809], [1962, -809],
        [1974, -809], [1986, -809], [1998, -809], [2010, -809],
        [2022, -810], [2034, -810], [2046, -810], [2058, -810],
        [2070, -810], [2082, -810], [2094, -810], [2106, -810],
        [2118, -810], [2130, -810], [2142, -810], [2154, -810],
        [2166, -810], [2178, -810], [2190, -810], [2202, -810],
        [2214, -810], [2226, -810], [2238, -810], [2250, -810],
        [2262, -807], [2271, -800], [2277, -789], [2277, -777],
        [2272, -766], [2263, -758], [2251, -755], [2239, -755],
        [2227, -755], [2215, -755], [2203, -755], [2191, -755],
        [2179, -755], [2167, -755], [2155, -755], [2143, -755],
        [2131, -755], [2119, -755], [2107, -755], [2095, -755],
        [2083, -755], [2071, -755], [2059, -755], [2047, -755],
        [2036, -751], [2027, -743], [2023, -732], [2024, -720],
        [2030, -709], [2039, -702], [2051, -700], [2063, -700],
        [2075, -700], [2087, -700], [2099, -700], [2111, -700],
        [2123, -700], [2135, -700], [2147, -700], [2159, -700],
        [2171, -700], [2183, -700], [2195, -700], [2207, -700],
        [2219, -700], [2231, -700], [2243, -700], [2255, -700],
        [2266, -695], [2274, -686], [2277, -674], [2276, -662],
        [2269, -652], [2258, -646], [2246, -645], [2234, -645],
        [2222, -645], [2210, -645], [2198, -645], [2186, -645],
        [2174, -645], [2162, -645], [2150, -645], [2138, -645],
        [2126, -645], [2114, -645], [2102, -645], [2090, -645],
        [2078, -645], [2066, -645], [2054, -645], [2042, -644],
        [2032, -638], [2025, -628], [2023, -616], [2026, -605],
        [2033, -596], [2044, -591], [2056, -590], [2068, -590],
        [2080, -590], [2092, -590], [2104, -590], [2116, -590],
        [2128, -590], [2140, -590], [2152, -590], [2164, -590],
        [2176, -590], [2188, -590], [2200, -590], [2212, -590],
        [2224, -590], [2236, -590], [2248, -590], [2260, -588],
        [2270, -581], [2276, -571], [2277, -559], [2273, -547],
        [2264, -539], [2253, -535], [2241, -535], [2229, -535],
        [2217, -535], [2205, -535], [2193, -535], [2181, -535],
        [2169, -535], [2157, -535], [2145, -535], [2133, -535],
        [2121, -535], [2109, -535], [2097, -535], [2085, -535],
        [2073, -535], [2061, -535], [2049, -535], [2037, -532],
        [2028, -524], [2023, -513], [2023, -501], [2029, -490],
        [2038, -483], [2050, -480], [2062, -480], [2074, -480],
        [2086, -480], [2098, -480], [2110, -480], [2122, -480],
        [2134, -480], [2146, -480], [2158, -480], [2170, -480],
        [2182, -480], [2194, -480], [2206, -480], [2218, -480],
        [2230, -480], [2242, -480], [2254, -480], [2265, -476],
        [2273, -467], [2277, -456], [2276, -444], [2270, -433],
        [2260, -427], [2248, -425], [2236, -425], [2224, -425],
        [2212, -425], [2200, -425], [2188, -425], [2176, -425],
        [2164, -425], [2152, -425], [2140, -425], [2128, -425],
        [2116, -425], [2104, -425], [2092, -425], [2080, -425],
        [2068, -425], [2056, -425], [2044, -425], [2032, -425],
        [2020, -425], [2008, -425], [1996, -425], [1984, -425]
      ] },
      { id: 'coast', w: 16, mat: 'asphalt', closed: true, pts: [
        [-1250, -1550], [-1600, -1850], [-1900, -2180], [-2080, -2450], [-2000, -2580],
        [-1600, -2600], [-1150, -2530], [-750, -2380], [-600, -2180], [-640, -1950],
        [-660, -1600], [-700, -1550], [-950, -1550],
      ] },
      // 海岸连接线：大环线西南角 → 沿海赛环北端
      { id: 'coastlink', w: 14, mat: 'asphalt', pts: [[-1500, -1150], [-1380, -1350], [-1250, -1550]] },
      // 湖谷内环：大湖以南的河谷社区环路
      { id: 'valley', w: 14, mat: 'asphalt', closed: true, pts: [
        [-800, -200], [-560, -400], [-200, -520], [180, -420], [420, -150],
        [300, 100], [0, 150], [-350, 50],
      ] },
      // 西北高地观景道：大环线西北 → 高地尽头（死路观景点）
      { id: 'northpass', w: 11, mat: 'dirt', pts: [[-1100, 900], [-1300, 1100], [-1550, 1250], [-1800, 1300], [-2000, 1150]] },
      // 南谷越野环线：大环线内侧的平坦原野土路
      { id: 'southloop', w: 12, mat: 'dirt', closed: true, pts: [
        [-700, -800], [-900, -1050], [-600, -1250], [-200, -1200], [0, -950], [-300, -700],
      ] },
    ],
    lake: { cx: 100, cz: 650, r: 340 },
    lakeWaterLevel: 36,
    driftCircles: [
      { x: -400, z: -1150, R: 25, name: '小圆 R25', dur: 18 },
      { x: 200, z: -1350, R: 45, name: '中圆 R45', dur: 22 },
      { x: 700, z: -1700, R: 70, name: '大圆 R70', dur: 26 },
    ],
    uturnCourse: {
      pts: [
        [-1250, -1250], [-1110, -1250],
        [-1050, -1260], [-1070, -1280], [-1110, -1290], [-1250, -1290],
        [-1310, -1290], [-1310, -1250], [-1250, -1250], [-1110, -1250],
        [-1050, -1260], [-1070, -1280], [-1110, -1290], [-1250, -1290],
        [-1310, -1290], [-1310, -1250],
      ],
    },
  },

  // ---------- 海特洛市（新海诚风二次元滨海都市；2D 平面路网） ----------
  {
    id: 'city', name: '海特洛市',
    desc: '新海诚风滨海都市：老城街巷 + CBD 高楼 + 滨海大道 + 文创樱花街',
    fogDensity: 0.00022,
    defaultHour: 17.5,
    seasons: [
      { name: '春', grassA: 0x7d9a68, grassB: 0x8fa878, field: 0x8a9470, tree: 0x4a7a3a, fog: 0xd8e4ec, sun: 0xffe6c0, sky: 0x7db8e8, water: 0x2a90c8 },
      { name: '夏', grassA: 0x6b8f58, grassB: 0x7fa568, field: 0x9a9a68, tree: 0x3c6b30, fog: 0xcfe4ee, sun: 0xfff2d0, sky: 0x5caee0, water: 0x1f90cc },
      { name: '秋', grassA: 0xa09060, grassB: 0xb0a070, field: 0xc0a068, tree: 0x8a6a3a, fog: 0xd8d0bc, sun: 0xffe2a8, sky: 0x9fb6c8, water: 0x3f8098 },
      { name: '冬', grassA: 0xd8ddce, grassB: 0xe2e6d8, field: 0xdde0d0, tree: 0x6a6258, fog: 0xe2e8ee, sun: 0xfff0d0, sky: 0xa8c2d8, water: 0x3a7090 },
    ],
    roads: [
      // 东西主街（城市横轴）：必须保留 id 'cross'，起点拱门与出生点沿它布置
      { id: 'cross', w: 16, mat: 'asphalt', pts: [[-1350, 30], [-900, 45], [-450, 30], [-120, 12], [0, 10], [180, 8], [450, 25], [900, 40], [1350, 35]] },
      // 南北大道（城市纵轴）
      { id: 'northsouth', w: 16, mat: 'asphalt', pts: [[0, -1600], [2, -1400], [-4, -1150], [-2, -900], [0, -600], [4, -300], [0, 0], [0, 150], [2, 350], [8, 600], [16, 950], [24, 1250]] },
      // 外环快速路
      { id: 'ring', w: 12, mat: 'asphalt', closed: true, pts: [[-1050, -1300], [1050, -1300], [1350, -1000], [1350, 1050], [-1250, 1050], [-1250, -1000], [-1050, -1300]] },
      // 滨海大道
      { id: 'coast', w: 12, mat: 'asphalt', pts: [[-1350, -1420], [-800, -1450], [-300, -1470], [300, -1470], [900, -1450], [1350, -1420]] },
      // 桥间地老城区街巷（窄、弯曲）
      { id: 'old1', w: 8, mat: 'asphalt', pts: [[-820, -420], [-640, -560], [-420, -640], [-240, -580], [-100, -430], [-40, -320]] },
      { id: 'old2', w: 7, mat: 'asphalt', pts: [[-860, -760], [-660, -920], [-420, -980], [-220, -880], [-60, -740]] },
      { id: 'old3', w: 7, mat: 'asphalt', pts: [[-900, -480], [-680, -460], [-480, -480], [-280, -440]] },
      // 过渡商住区次干道
      { id: 'mix1', w: 9, mat: 'asphalt', pts: [[-520, -250], [-500, -20], [-520, 200], [-500, 360]] },
      { id: 'mix2', w: 9, mat: 'asphalt', pts: [[460, -250], [470, -20], [460, 200], [470, 360]] },
      // 新赫兰德 CBD 街道
      { id: 'cbd1', w: 10, mat: 'asphalt', pts: [[-720, 420], [-700, 700], [-720, 950], [-700, 1150]] },
      { id: 'cbd2', w: 10, mat: 'asphalt', pts: [[720, 420], [700, 700], [720, 950], [700, 1150]] },
      { id: 'cbd3', w: 9, mat: 'asphalt', pts: [[-820, 760], [-300, 730], [300, 760], [820, 740]] },
      { id: 'cbd4', w: 9, mat: 'asphalt', pts: [[-820, 1060], [-300, 1090], [300, 1060], [820, 1090]] },
      // 绘空町文创街巷（樱花街）
      { id: 'culture1', w: 7, mat: 'asphalt', pts: [[440, -640], [660, -700], [860, -680], [1060, -600], [1260, -500]] },
      { id: 'culture2', w: 6, mat: 'asphalt', pts: [[460, -920], [700, -960], [940, -910], [1180, -840]] },
      { id: 'culture3', w: 6, mat: 'asphalt', pts: [[600, -300], [760, -250], [960, -300], [1160, -240]] },
      // 未闻浦滨海道路
      { id: 'seaside1', w: 8, mat: 'asphalt', pts: [[-1000, -1220], [-700, -1280], [-300, -1310], [300, -1310], [900, -1260]] },
      { id: 'seaside2', w: 7, mat: 'asphalt', pts: [[-1100, -1560], [-600, -1590], [0, -1600], [600, -1590], [1150, -1560]] },
    ],
    // 城市道路分级（供 city_roads_engine.js 的路口/车道线/铺装系统使用）
    cityRoadClasses: [
      { key: 'arterial',  ids: ['cross', 'northsouth', 'ring'], lane: 'dashed-white', center: 'double-yellow', edge: 'solid-white', markings: true },
      { key: 'secondary', ids: ['coast', 'mix1', 'mix2', 'cbd1', 'cbd2', 'cbd3', 'cbd4', 'old1', 'old2', 'old3'], lane: 'dashed-white', center: 'dashed-white', edge: 'solid-white', markings: true },
      { key: 'lane',      ids: ['culture1', 'culture2', 'culture3', 'seaside1', 'seaside2'], lane: 'none', center: 'none', edge: 'none', markings: false },
    ],
    // 高架快速路（海特洛空中走廊）：跨 CBD 的立交桥。
    // 由 world.buildCityOverpasses() 生成物理三角网格 + 采样数据，
    // 由 city_roads_engine.js 依据 world.overpasses 生成桥面/护栏/桥墩视觉。
    overpasses: [
      {
        id: 'skyway', w: 10, clearance: 8, deckThick: 0.55, rampLen: 170,
        main: [[-1180, 522], [-800, 512], [-400, 508], [0, 512], [400, 518], [800, 520], [1180, 518]],
        rampA: [[-1180, 522], [-1235, 540], [-1260, 570]],
        rampB: [[1180, 518], [1235, 540], [1260, 570]],
      },
    ],
    driftCircles: [
      { x: 0, z: 1500, R: 45, name: '北山观景台 R45', dur: 22 },
    ],
    uturnCourse: {
      pts: [
        [-80, 1480], [-80, 1580], [-20, 1590], [0, 1600], [20, 1590], [80, 1580],
        [80, 1480], [20, 1470], [0, 1460], [-20, 1470], [-80, 1480],
      ],
    },
  },

  // ---------- 海特洛2（v4 简净网格路网：先路后楼；平滑滨海S弯路） ----------
  {
    id: 'city2', name: '海特洛2',
    desc: '重写路网：规整网格 + 老城/文创错落巷网 + 平滑滨海弯路 + 全部路口规范化',
    fogDensity: 0.00018,
    defaultHour: 17.5,
    seasons: [
      { name: '春', grassA: 0x7d9a68, grassB: 0x8fa878, field: 0x8a9470, tree: 0x4a7a3a, fog: 0xd8e4ec, sun: 0xffe6c0, sky: 0x7db8e8, water: 0x2a90c8 },
      { name: '夏', grassA: 0x6b8f58, grassB: 0x7fa568, field: 0x9a9a68, tree: 0x3c6b30, fog: 0xcfe4ee, sun: 0xfff2d0, sky: 0x5caee0, water: 0x1f90cc },
      { name: '秋', grassA: 0xa09060, grassB: 0xb0a070, field: 0xc0a068, tree: 0x8a6a3a, fog: 0xd8d0bc, sun: 0xffe2a8, sky: 0x9fb6c8, water: 0x3f8098 },
      { name: '冬', grassA: 0xd8ddce, grassB: 0xe2e6d8, field: 0xdde0d0, tree: 0x6a6258, fog: 0xe2e8ee, sun: 0xfff0d0, sky: 0xa8c2d8, water: 0x3a7090 },
    ],
    roads: [
      { id: 'cross', w: 16, mat: 'asphalt', pts: [[-900, 0], [900, 0]] },
      { id: 'northsouth', w: 16, mat: 'asphalt', pts: [[0, -1520], [0, 880]] },
      { id: 'northblvd', w: 16, mat: 'asphalt', pts: [[-900, 880], [900, 880]] },
      { id: 'southblvd', w: 16, mat: 'asphalt', pts: [[-900, -450], [900, -450]] },
      { id: 'westave', w: 16, mat: 'asphalt', pts: [[-900, -1500], [-900, 880]] },
      { id: 'eastave', w: 16, mat: 'asphalt', pts: [[900, -1500], [900, 880]] },
      { id: 's3', w: 9, mat: 'asphalt', pts: [[-450, -950], [-450, 880]] },
      { id: 's4', w: 9, mat: 'asphalt', pts: [[450, -950], [450, 880]] },
      { id: 'mixline', w: 9, mat: 'asphalt', pts: [[-900, 450], [900, 450]] },
      { id: 'sealine', w: 9, mat: 'asphalt', pts: [[-900, -950], [900, -950]] },
      { id: 'old1', w: 7, mat: 'asphalt', pts: [[-900, -720], [0, -720]] },
      { id: 'old2', w: 7, mat: 'asphalt', pts: [[-900, -580], [0, -580]] },
      { id: 'old3', w: 7, mat: 'asphalt', pts: [[-675, -950], [-675, -450]] },
      { id: 'culture1', w: 6, mat: 'asphalt', pts: [[450, -700], [1280, -700]] },
      { id: 'culture2', w: 6, mat: 'asphalt', pts: [[450, -580], [1280, -580]] },
      { id: 'culture3', w: 6, mat: 'asphalt', pts: [[760, -950], [760, -260]] },
      { id: 'coast', w: 12, mat: 'asphalt', pts: [
        [-900, -1500], [-750, -1491], [-600, -1489], [-450, -1493], [-300, -1503],
        [-150, -1517], [0, -1529], [150, -1538], [300, -1541], [450, -1536],
        [600, -1526], [750, -1513], [900, -1500],
      ] },
      { id: 'pier', w: 7, mat: 'asphalt', pts: [[0, -1529], [0, -1630]] },
    ],
    cityRoadClasses: [
      { key: 'arterial', ids: ['cross', 'northsouth', 'northblvd', 'southblvd', 'westave', 'eastave'], lane: 'dashed-white', center: 'double-yellow', edge: 'solid-white', markings: true },
      { key: 'secondary', ids: ['s3', 's4', 'mixline', 'sealine', 'coast'], lane: 'dashed-white', center: 'dashed-white', edge: 'solid-white', markings: true },
      { key: 'lane', ids: ['old1', 'old2', 'old3', 'culture1', 'culture2', 'culture3', 'pier'], lane: 'none', center: 'none', edge: 'none', markings: false },
    ],
    overpasses: [
      {
        id: 'skyway', w: 10, clearance: 8, deckThick: 0.55, rampLen: 170,
        main: [[-1180, 522], [-800, 512], [-400, 508], [0, 512], [400, 518], [800, 520], [1180, 518]],
        rampA: [[-1180, 522], [-1235, 540], [-1260, 570]],
        rampB: [[1180, 518], [1235, 540], [1260, 570]],
      },
    ],
    driftCircles: [
      { x: 0, z: 1500, R: 45, name: '北山观景台 R45', dur: 22 },
    ],
    uturnCourse: {
      pts: [
        [-80, 1480], [-80, 1580], [-20, 1590], [0, 1600], [20, 1590], [80, 1580],
        [80, 1480], [20, 1470], [0, 1460], [-20, 1470], [-80, 1480],
      ],
    },
  },

  // ---------- 程序化都市GLB（外部城市模型导入：procedural_city_6） ----------
  {
    id: 'city3', name: '程序化都市GLB',
    desc: '导入外部程序化城市模型(procedural_city_6)：真实街道/建筑/树木/路缘，车轮可在模型街道上行驶',
    fogDensity: 0.00015,
    defaultHour: 17.5,
    seasons: [
      { name: '春', grassA: 0x7d9a68, grassB: 0x8fa878, field: 0x8a9470, tree: 0x4a7a3a, fog: 0xd8e4ec, sun: 0xffe6c0, sky: 0x7db8e8, water: 0x2a90c8 },
      { name: '夏', grassA: 0x6b8f58, grassB: 0x7fa568, field: 0x9a9a68, tree: 0x3c6b30, fog: 0xcfe4ee, sun: 0xfff2d0, sky: 0x5caee0, water: 0x1f90cc },
      { name: '秋', grassA: 0xa09060, grassB: 0xb0a070, field: 0xc0a068, tree: 0x8a6a3a, fog: 0xd8d0bc, sun: 0xffe2a8, sky: 0x9fb6c8, water: 0x3f8098 },
      { name: '冬', grassA: 0xd8ddce, grassB: 0xe2e6d8, field: 0xdde0d0, tree: 0x6a6258, fog: 0xe2e8ee, sun: 0xfff0d0, sky: 0xa8c2d8, water: 0x3a7090 },
    ],
    // 模型周围一圈可驾驶环路；模型内部街道由 GLB 三角网格提供车轮物理
    roads: [
      { id: 'ring', w: 14, mat: 'asphalt', closed: true, pts: [[-260, -240], [260, -240], [260, 240], [-260, 240]] },
    ],
    driftCircles: [
      { x: 0, z: 1500, R: 45, name: '北山观景台 R45', dur: 22 },
    ],
    uturnCourse: {
      pts: [
        [-80, 1480], [-80, 1580], [-20, 1590], [0, 1600], [20, 1590], [80, 1580],
        [80, 1480], [20, 1470], [0, 1460], [-20, 1470], [-80, 1480],
      ],
    },
  },
];

// ---------- 数学工具 ----------
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const TAU = Math.PI * 2;
const angLerp = (a, b, t) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return a + d * t;
};
const fmtTime = s => {
  s = Math.max(0, s);
  const m = Math.floor(s / 60), ss = s - m * 60;
  return m + ':' + (ss < 10 ? '0' : '') + ss.toFixed(ss < 10 ? 2 : 1);
};

// ---------- 确定性哈希噪声 (value noise + fbm) ----------
const Noise = (() => {
  function hash2(x, y) {
    let n = x * 374761393 + y * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    n = n ^ (n >> 16);
    return ((n >>> 0) % 100000) / 100000;
  }
  const fade = t => t * t * (3 - 2 * t);
  function vnoise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = fade(xf), v = fade(yf);
    const a = hash2(xi, yi), b = hash2(xi + 1, yi);
    const c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, oct, lac = 2.0, gain = 0.5) {
    let amp = 1, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += vnoise(x * f, y * f) * amp;
      norm += amp;
      amp *= gain; f *= lac;
    }
    return sum / norm;
  }
  return { vnoise, fbm, hash2 };
})();

// ---------- 颜色 ----------
const mixColor = (c1, c2, t) => {
  const r = lerp((c1 >> 16) & 255, (c2 >> 16) & 255, t);
  const g = lerp((c1 >> 8) & 255, (c2 >> 8) & 255, t);
  const b = lerp(c1 & 255, c2 & 255, t);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
};
const hexColor = c => '#' + ('00000' + c.toString(16)).slice(-6);

// ---------- 车辆数据 ----------
const CAR_SPECS = [
  {
    id: 'gt', name: '烈焰 GT', brand: 'HORIZON', engine: '5.2L V8 自然吸气 · 中置后驱',
    hp: 620, mass: 1280, drive: 'RWD', cylinders: 8, turbo: false,
    redline: 8200, torque: 700, gears: [3.42, 2.21, 1.58, 1.19, 0.94, 0.75], fd: 4.05,
    wheelbase: 2.62, track: 1.64, wheelR: 0.34,
    color: 0xd81e3a, accent: 0xffffff, grip: 1.22, downforce: 1,
    stats: { acc: 0.96, top: 0.97, hand: 0.85, drift: 0.82 },
    desc: '极致下压力超跑：大尾翼 + 空气动力学，高速大幅转向依然稳如泰山，不漂移。'
  },
  {
    id: 'p918', name: '保时捷 918 Spyder', brand: 'PORSCHE', engine: '4.6L V8 混动 · 四驱',
    hp: 887, mass: 1690, drive: 'AWD', cylinders: 8, turbo: false,
    redline: 9150, torque: 1280, gears: [3.91, 2.29, 1.58, 1.19, 0.97, 0.83, 0.67], fd: 3.09,
    wheelbase: 2.65, frontTrack: 1.66, rearTrack: 1.61, wheelR: 0.36,
    color: 0xcfd6dc, accent: 0xffd200, grip: 1.28, downforce: 1.0,
    stats: { acc: 1.0, top: 0.99, hand: 0.98, drift: 0.6 },
    desc: '真实 887 匹混合动力四驱超跑：7 速 PDK、四轮独立悬挂、空气动力学下压力，稳准狠不甩尾。',
    camCockpit: [0.33, 0.28, 0.10],
    camHood: [0, 0.10, 1.15],
    glb: true,
  },
];

// 扭矩曲线：rpm -> 0..1
const torqueShape = rpm => {
  const t = rpm / 8200;
  const base = Math.pow(Math.sin(t * Math.PI * 0.84), 0.9) * (1 - 0.14 * t);
  return clamp(base, 0.05, 1);
};

// 种子随机
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------- 公共命名空间（控制台 / 工具脚本 / 后续模块的稳定入口） ----------
// 只做别名暴露，不改动内部裸 const 全局的引用方式，避免破坏既有模块。
window.GAME = {
  version: '20260813',
  CFG,
  TUNING,
  P918_TUNE,
  MAPS,
  CAR_SPECS,
  Noise,
  clamp,
  lerp,
  smoothstep,
  helpers: { rand, randInt, pick, angLerp, mixColor, hexColor, makeRng, torqueShape },
  // 地址栏 ?debug=1 时打开巡路 / 道路审计等冗长日志
  DEBUG: typeof location !== 'undefined' && new URLSearchParams(location.search).has('debug'),
};
