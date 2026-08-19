// ============================================================
//  CITY POST — 海特洛市色彩分级 / 晕影 / 车辆接触阴影
//  ------------------------------------------------------------
//  只注册两个 CITY 阶段 + 一个 applyGrade 开关；不创建 Light。
//  切回阿尔卑斯时由 world.placeProps 调用 CITY.applyGrade(false) 还原。
// ============================================================
(() => {
  'use strict';
  if (typeof window === 'undefined' || !window.CITY) return;
  const C = window.CITY;

  // 城市色彩分级：提高饱和度/对比度 + 轻微暖色，配合 CSS 电影晕影。
  // 直接作用于游戏画布与 DOM，最终截图与玩家看到的完全一致。
  C.applyGrade = (on) => {
    if (typeof document === 'undefined') return;
    let el = document.getElementById('cityGradeVignette');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cityGradeVignette';
      el.style.cssText = [
        'position:fixed', 'inset:0', 'pointer-events:none', 'z-index:50',
        'background:radial-gradient(ellipse at 50% 42%, rgba(0,0,0,0) 52%, rgba(18,12,28,0.30) 100%),',
        'linear-gradient(to bottom, rgba(255,196,140,0.07), rgba(110,140,220,0.06))',
        'mix-blend-mode:multiply',
      ].join(';') + ';';
      document.body.appendChild(el);
    }
    el.style.display = on ? 'block' : 'none';
    const cv = document.getElementById('game');
    if (cv) {
      cv.style.filter = on
        ? 'saturate(1.08) contrast(1.04) brightness(1.01)'
        : '';
    }
  };

  // 安装城市后期管线（色阶轻量化 / 边缘线 / 分级 / 晕影），可被特殊地图直接调用
  C.installPost = (world) => {
      C.applyGrade(true);
      if (!C._postInstalled) {
        C._postInstalled = true;
        const renderer = world.renderer;
        const rt = new THREE.WebGLRenderTarget(
          renderer.domElement.width, renderer.domElement.height,
          { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, format: THREE.RGBAFormat }
        );
        const quadScene = new THREE.Scene();
        const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        const quadMat = new THREE.ShaderMaterial({
          depthTest: false, depthWrite: false,
          uniforms: {
            tDiffuse: { value: rt.texture },
            uRes: { value: new THREE.Vector2(renderer.domElement.width, renderer.domElement.height) },
          },
          vertexShader: `
            varying vec2 vUv;
            void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
          `,
          fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform vec2 uRes;
            varying vec2 vUv;
            float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
            void main(){
              vec2 px = 1.0 / uRes;
              vec4 c = texture2D(tDiffuse, vUv);
              float lc = luma(c.rgb);
              float lL = luma(texture2D(tDiffuse, vUv + vec2(-px.x, 0.0)).rgb);
              float lR = luma(texture2D(tDiffuse, vUv + vec2( px.x, 0.0)).rgb);
              float lD = luma(texture2D(tDiffuse, vUv + vec2(0.0, -px.y)).rgb);
              float lU = luma(texture2D(tDiffuse, vUv + vec2(0.0,  px.y)).rgb);
              float edge = clamp(abs(lc - lL) + abs(lc - lR) + abs(lc - lD) + abs(lc - lU), 0.0, 1.0);
              vec3 col = c.rgb;
              // 饱和度增强 + 极轻色阶（保持通透，避免“脏”感）
              float g = luma(col);
              col = mix(vec3(g), col, 1.28);
              float band = floor(g * 4.0) / 4.0;
              col = mix(col, vec3(band * 1.02), 0.08);
              // 边缘轻压：只做极轻的轮廓，不再压暗
              col = mix(col, col * 0.92, smoothstep(0.20, 0.90, edge) * 0.12);
              // 暖亮部 / 冷暗部
              col *= vec3(1.04, 1.01, 0.98);
              col = mix(col, col * vec3(0.94, 0.97, 1.06), smoothstep(0.25, 0.75, 1.0 - g) * 0.22);
              // 电影晕影
              float v = smoothstep(1.25, 0.35, length(vUv - 0.5) * 1.5);
              col *= mix(0.94, 1.0, v);
              gl_FragColor = vec4(col, c.a);
            }
          `,
        });
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat);
        quadScene.add(quad);
        const orig = renderer.render.bind(renderer);
        renderer.render = function (scene, camera, renderTarget, forceClear) {
          // three 内部渲染（如阴影贴图）会带 renderTarget，直接原路执行，避免递归
          if (renderTarget) { orig(scene, camera, renderTarget, forceClear); return; }
          const g = (typeof Game !== 'undefined') ? Game : null;
          const isMainScene = g && scene === g.scene;
          if (g && g.world && g.world.isCity && isMainScene) {
            const w = renderer.domElement.width, h = renderer.domElement.height;
            if (rt.width !== w || rt.height !== h) rt.setSize(w, h);
            quadMat.uniforms.uRes.value.set(w, h);
            quadMat.uniforms.tDiffuse.value = rt.texture;
            const target = renderer.getRenderTarget ? renderer.getRenderTarget() : null;
            renderer.setRenderTarget(rt);
            orig(scene, camera);
            renderer.setRenderTarget(target);   // 输出回主循环期望的目标（通常是 fxRT）
            orig(quadScene, quadCam);
          } else {
            orig(scene, camera);
          }
        };
        C._post = { rt, quadMat, orig, quadScene, quadCam };
      }
      return { graded: true, post: true };
  };

  // 阶段 1：应用分级 + 后处理
  C.stages.push({
    name: 'cityPost',
    fn(world) { return C.installPost(world); },
  });

  // 阶段 2：车辆接触阴影（软椭圆，跟随车辆，解决“车轮悬浮”观感）
  C.stages.push({
    name: 'cityCarShadow',
    fn(world) {
      const tex = C.makeCanvas(128, 64, (g) => {
        const grd = g.createRadialGradient(64, 32, 4, 64, 32, 62);
        grd.addColorStop(0, 'rgba(10,12,18,0.55)');
        grd.addColorStop(0.55, 'rgba(10,12,18,0.30)');
        grd.addColorStop(1, 'rgba(10,12,18,0)');
        g.fillStyle = grd;
        g.fillRect(0, 0, 128, 64);
      }, { srgb: false });
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0.9,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(7.0, 3.6), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 1;
      world.scene.add(mesh);
      C.registerUpdate((w) => {
        const car = (typeof Game !== 'undefined') ? Game.car : null;
        if (!car || !car.visual) { mesh.visible = false; return; }
        mesh.visible = car.visual.visible !== false;
        if (!mesh.visible) return;
        mesh.position.set(car.pos.x, w.terrainHeight(car.pos.x, car.pos.z) + 0.04, car.pos.z);
        mesh.rotation.z = car.visual.rotation ? car.visual.rotation.y : 0;
      });
      return { contactShadow: true };
    },
  });
})();
