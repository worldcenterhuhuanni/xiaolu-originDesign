// 背景 = AI 的状态 + 你的手，不是壁纸。三层叠加：
//   河（全屏 shader）：域扭曲的水流，始终向下游流动，会被流体的速度场带着弯
//   流体（fluid.js）：鼠标划过留下尾迹，点击溅起水花；AI 思考时沿回答四周注入环形涡流
//   粒子（1.2 万个，全在顶点着色器里动）：平时沿几股水道顺流而下；思考时被卷成环绕回答的涡旋并升温
//   energy 0 = 空闲，≈0.45 = 正在回答，1 = 正在思考；theme = 当前会话的水色（见 store.js 的 THEMES）
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { createFluid } from './fluid.js'

const AMBER = [1, 0.62, 0.28]

const COMMON = /* glsl */ `
  uniform float uFlow, uEnergy, uHue, uHue2, uSat, uAspect;
  vec3 hsl(float h, float s, float l){ vec3 k = mod(vec3(0., 8., 4.) + h*12., 12.); return l - s*min(l, 1.-l)*max(min(min(k-3., 9.-k), 1.), -1.); }
  vec3 toLinear(vec3 c){ return pow(max(c, 0.), vec3(2.2)); } // 管线末端的 OutputPass 会再转回 sRGB
`

const FLOW_FRAG = COMMON + /* glsl */ `
  varying vec2 vUv; uniform sampler2D uDye, uVel; uniform vec2 uPulseAt; uniform float uPulse;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
    return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ float v = 0., a = .5; for(int i = 0; i < 4; i++){ v += a*noise(p); p = p*2.03 + 17.; a *= .5; } return v; }
  void main(){
    vec2 asp = vec2(uAspect, 1.);
    vec2 p = (vUv - .5) * asp * 1.6;
    p -= texture2D(uVel, vUv).xy * .0009; // 河水被流体带着走：鼠标搅过的地方水纹跟着弯
    // 冲击波：点击或发送的位置荡开一圈
    float dr = length((vUv - uPulseAt) * asp);
    float ring = smoothstep(.05, 0., abs(dr - uPulse * .9)) * exp(-uPulse * 1.7);
    p += normalize(vUv - uPulseAt + 1e-4) * ring * .12;

    p.y += uFlow * .10; // 整体向下游流
    vec2 q = vec2(fbm(p + vec2(0., uFlow*.16)), fbm(p + vec2(5.2, 1.3) - uFlow*.05));
    vec2 r = vec2(fbm(p + 2.4*q + vec2(1.7, 9.2) + uFlow*.12), fbm(p + 2.4*q + vec2(8.3, 2.8)));
    float f = fbm(p * vec2(1.7, .7) + 2.8*r); // 横向压缩 → 纵向拉长的水纹
    float line = smoothstep(.08, 0., abs(fract(f*6.) - .5)); // 等值线 = 发光的流线

    // 深处用主色相，亮部和流线用第二色相：一套主题是两种颜色在水里交融，不是单色
    vec3 col = mix(hsl(uHue, .6*uSat, .05), hsl(uHue, .7*uSat, .28), smoothstep(.25, .85, f));
    col = mix(col, hsl(uHue2, .8*uSat, .46), smoothstep(.42, .9, r.x) * .75);
    col += hsl(uHue2, .85*uSat, .66) * line * (.22 + .30*uEnergy) * smoothstep(.2, .7, q.y);
    col += vec3(1., .68, .34) * uEnergy * .11 * smoothstep(.5, .95, q.x * r.y * 2.4); // 思考时水里泛起暖光
    col += hsl(uHue2, .9*uSat, .72) * ring * .7;
    col *= 1. - 1.1 * dot(vUv - .5, vUv - .5);
    vec3 dye = texture2D(uDye, vUv).rgb;
    gl_FragColor = vec4(toLinear(col) + .55 * dye / (1. + dye), 1.); // 染料做软压缩并封顶，叠多了也不会一片死白
  }`

const DUST_VERT = COMMON + /* glsl */ `
  uniform float uPx; varying float vA, vHeat;
  void main(){
    vec3 s = position; // 三个随机数，不是坐标
    // 顺流：各自速度不同，循环下落；整条河一起蜿蜒
    vec2 stream = vec2(s.x*2. - 1., 1. - 2.*fract(s.y + uFlow*(.03 + s.z*.08)));
    stream.x += .11*sin(stream.y*2.6 + uFlow*.35) + .05*sin(stream.y*6.1 - uFlow*.5 + 2.);
    // 辫状水道：粒子只在几股主流里亮起来，否则均匀撒点看起来像雪花而不是水
    float lane = sin(s.x*21. + 1.7*sin(stream.y*2.2 + uFlow*.25 + s.x*3.));
    float inLane = smoothstep(.1, .95, lane*.5 + .5);
    // 涡旋：绕着舞台中心的椭圆轨道，内圈转得快
    float k = fract(s.x * 7.31);
    float ang = s.y * 6.2832 + uFlow * (.5 + .9*(1. - k));
    vec2 orbit = vec2(cos(ang) * (.58 + .34*k), sin(ang) * (.70 + .26*k) + .04);
    float m = smoothstep(0., 1., uEnergy) * step(.5, s.z); // 一半粒子被卷入，其余继续顺流
    gl_Position = vec4(mix(stream, orbit, m), 0., 1.);
    gl_PointSize = (3. + s.z*7.) * uPx * mix(1., .55, m);
    vA = mix((.04 + .8*inLane) * (.3 + .7*s.z), .25 + .5*s.z, m); vHeat = m;
  }`

const DUST_FRAG = COMMON + /* glsl */ `
  varying float vA, vHeat;
  void main(){
    // 顺流时是竖向的光丝，被卷进涡旋后收成光点
    float a = smoothstep(.5, 0., length((gl_PointCoord - .5) * vec2(mix(4.5, 1., vHeat), 1.)));
    vec3 c = mix(hsl(uHue2, .8*uSat, .7), vec3(1., .72, .4), vHeat * .85);
    gl_FragColor = vec4(toLinear(c) * a * vA * (1. + .25*vHeat), 1.);
  }`

export function createBg(canvas) {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' })
  // 背景本身是柔和的流体，用不着视网膜分辨率：按 1x 渲染，高分屏上像素量直接少 3/4
  let px = 1
  renderer.setPixelRatio(px)
  const fluid = createFluid(renderer)
  const scene = new THREE.Scene(), camera = new THREE.Camera() // 两层都直接写裁剪空间坐标，相机只是占位
  const uniforms = {
    uFlow: { value: Math.random() * 50 }, uEnergy: { value: 0 }, uHue: { value: 0.5 }, uHue2: { value: 0.56 }, uSat: { value: 1 }, uAspect: { value: 1 },
    uPulse: { value: 99 }, uPulseAt: { value: new THREE.Vector2(0.5, 0.08) }, uPx: { value: px },
    uDye: { value: null }, uVel: { value: null },
  }

  const flow = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ uniforms, depthTest: false, fragmentShader: FLOW_FRAG, vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }' }),
  )
  const seeds = new Float32Array(12000 * 3).map(Math.random)
  const dust = new THREE.Points(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(seeds, 3)),
    new THREE.ShaderMaterial({ uniforms, depthTest: false, transparent: true, blending: THREE.AdditiveBlending, vertexShader: DUST_VERT, fragmentShader: DUST_FRAG }),
  )
  flow.frustumCulled = dust.frustumCulled = false
  dust.renderOrder = 1
  scene.add(flow, dust)

  const composer = new EffectComposer(renderer)
  composer.addPass(new RenderPass(scene, camera))
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.8, 0.2))
  composer.addPass(new OutputPass())

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false)
    composer.setSize(innerWidth, innerHeight)
    uniforms.uAspect.value = innerWidth / innerHeight
  }
  resize()
  addEventListener('resize', resize)

  const water = (l) => new THREE.Color().setHSL(uniforms.uHue2.value, 0.85 * uniforms.uSat.value, l).toArray()
  const uv = (cx, cy) => [cx / innerWidth, 1 - cy / innerHeight]

  const api = {
    energy: 0,
    theme: { h: 0.5, h2: 0.56, sat: 1 },
    /** 在屏幕坐标处溅起一圈水花 + 冲击波。warm = 用琥珀色（发送问题时）。 */
    splash(cx, cy, warm = false) {
      const [x, y] = uv(cx, cy)
      uniforms.uPulse.value = 0
      uniforms.uPulseAt.value.set(x, y)
      if (calm) return
      const rgb = (warm ? AMBER : water(0.5)).map((c) => c * 0.16)
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2
        fluid.splat(x + Math.cos(a) * 0.012, y + Math.sin(a) * 0.02, Math.cos(a) * 900, Math.sin(a) * 900, rgb, 0.0012)
      }
    },
  }

  // 鼠标尾迹：移动得越快，推得越猛、染得越亮
  let prev = null
  addEventListener('pointermove', (e) => {
    const [x, y] = uv(e.clientX, e.clientY)
    if (prev && !calm) {
      const dx = x - prev[0], dy = y - prev[1]
      const speed = Math.min(Math.hypot(dx * uniforms.uAspect.value, dy) * 40, 1)
      if (speed > 0.01) fluid.splat(x, y, dx * 5000, dy * 5000, water(0.5).map((c) => c * speed * 0.22), 0.0014)
    }
    prev = [x, y]
  })

  let last = performance.now(), slow = 0
  ;(function frame(now) {
    const raw = now - last
    const dt = Math.min(raw / 1000, 0.033)
    last = now
    // 自动降级：连续 1.5 秒掉到 45 帧以下，就把背景分辨率再砍一档（只降一次），保住交互流畅
    if (px === 1 && raw < 200 && (slow = raw > 22 ? slow + 1 : 0) > 70) {
      px = 0.6
      renderer.setPixelRatio(px)
      uniforms.uPx.value = px
      resize()
    }
    const u = uniforms
    u.uEnergy.value += (api.energy - u.uEnergy.value) * Math.min(1, dt * 2.2)
    // 换会话/换主题时颜色渐变过去；色相是环形的，走近的那一边
    const k = Math.min(1, dt * 1.6), turn = (cur, to) => (cur + ((((to - cur) % 1) + 1.5) % 1 - 0.5) * k + 1) % 1
    u.uHue.value = turn(u.uHue.value, api.theme.h)
    u.uHue2.value = turn(u.uHue2.value, api.theme.h2)
    u.uSat.value += (api.theme.sat - u.uSat.value) * k
    u.uPulse.value += dt
    if (!calm) {
      u.uFlow.value += dt * (0.4 + 1.5 * u.uEnergy.value) // 思考时水流变急
      // 思考中：两个注入点沿回答卡片外沿对向绕行，把水搅成环形涡流
      const e = u.uEnergy.value
      if (e > 0.08) for (const side of [0, Math.PI]) {
        const a = u.uFlow.value * 1.3 + side
        fluid.splat(0.5 + Math.cos(a) * 0.34, 0.5 + Math.sin(a) * 0.42, -Math.sin(a) * 520 * e, Math.cos(a) * 520 * e, AMBER.map((c) => c * 0.014 * e), 0.0016)
      }
      fluid.step(dt)
    }
    u.uDye.value = fluid.dye
    u.uVel.value = fluid.vel
    composer.render()
    requestAnimationFrame(frame)
  })(last)

  return api
}
