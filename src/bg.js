// 背景 = AI 的状态 + 你的手，不是壁纸。三层叠加：
//   河（全屏 shader）：域扭曲的水流，始终向下游流动，会被流体的速度场带着弯
//   流体（fluid.js）：鼠标划过留下尾迹，点击溅起水花；AI 思考时沿回答四周注入环形涡流
//   粒子（1.2 万个，全在顶点着色器里动）：平时沿几股水道顺流而下；思考时被卷成环绕回答的涡旋并升温
//   思考时的粒子形态有两种（EFFECTS）：ring 环绕回答转圈；vortex 沿螺旋臂被吸进中心。api.effect 切换，两者平滑过渡
//   场景有三种（SCENES）：river 河流；stars 星空——深空星云，繁星自己缓缓旋向对话框中心、越近越小、在那里消失
//            whale 鲸鱼——DeepSeek 蓝的深海，一小群俯视的小肥鲸（whale.js）满页巡游、会躲鼠标，饵料从四面八方漂进领头那只的嘴里
//   energy 0 = 空闲，≈0.45 = 正在回答，1 = 正在思考；theme = 当前会话的水色（见 store.js 的 THEMES）
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { createFluid } from './fluid.js'
import { createWhale } from './whale.js'

const AMBER = [1, 0.62, 0.28]

/** AI 思考/回答时的粒子特效。改 DEFAULT_EFFECT 换默认值；运行时用 /特效 命令切换（记在 localStorage）。 */
export const EFFECTS = { ring: '环绕', vortex: '漩涡' }
const DEFAULT_EFFECT = 'ring', EFFECT_KEY = 'su.effect'
/** 背景场景。改 DEFAULT_SCENE 换默认值；运行时用 /背景 命令切换。 */
export const SCENES = { river: '河流', stars: '星空', whale: '鲸鱼' }
const DEFAULT_SCENE = 'river', SCENE_KEY = 'su.scene'
/** 在一组选项里选一个并记住：不传 id 就轮到下一个，传了不认识的就保持原样。 */
function pick(map, key, cur, id) {
  const ids = Object.keys(map)
  id ??= ids[(ids.indexOf(cur) + 1) % ids.length]
  if (!map[id]) id = cur
  try { localStorage.setItem(key, id) } catch {}
  return id
}
const stored = (key) => { try { return localStorage.getItem(key) } catch { return null } }

const COMMON = /* glsl */ `
  uniform float uFlow, uEnergy, uHue, uHue2, uSat, uAspect, uMode, uScene, uSea; uniform vec2 uTilt, uMouth, uAhead;
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

    // 漩涡模式：河水绕中心被拧一圈（越靠中心拧得越多），中心透出暖光，四角压暗——水面跟着粒子一起陷下去
    float sw = uMode * smoothstep(0., 1., uEnergy), cr = length((vUv - vec2(.5, .44)) * asp);
    float tw = sw * 2.4 / (1. + cr * 5.);
    p = mat2(cos(tw), sin(tw), -sin(tw), cos(tw)) * p;
    p.y += uFlow * .10 * (1. - uScene) * (1. - .8*uSea); // 整体向下游流（星空里不流，只翻涌）
    vec2 q = vec2(fbm(p + vec2(0., uFlow*.16)), fbm(p + vec2(5.2, 1.3) - uFlow*.05));
    vec2 r = vec2(fbm(p + 2.4*q + vec2(1.7, 9.2) + uFlow*.12), fbm(p + 2.4*q + vec2(8.3, 2.8)));
    float f = fbm(p * vec2(1.7, .7) + 2.8*r); // 横向压缩 → 纵向拉长的水纹
    float line = smoothstep(.08, 0., abs(fract(f*6.) - .5)); // 等值线 = 发光的流线

    // 深处用主色相，亮部和流线用第二色相：一套主题是两种颜色在水里交融，不是单色
    vec3 col = mix(hsl(uHue, .6*uSat, .05), hsl(uHue, .7*uSat, .28), smoothstep(.25, .85, f));
    col = mix(col, hsl(uHue2, .8*uSat, .46), smoothstep(.42, .9, r.x) * .75);
    col += hsl(uHue2, .85*uSat, .66) * line * (.22 + .30*uEnergy) * smoothstep(.2, .7, q.y);
    col += vec3(1., .68, .34) * uEnergy * .11 * smoothstep(.5, .95, q.x * r.y * 2.4); // 思考时水里泛起暖光
    // 星空场景，从远到近四层：
    //   银河——斜贯画面的一条星云带，主题两色 + 一个对比色（色相 +0.38）交融，中间夹着暗的尘埃带
    //   星系盘——对话框背后两条缓慢旋转的旋臂，把视线引向对话框；思考时变亮
    //   远景恒星——极小的静态星点，银河里更密
    //   流星——每隔几秒划过一颗
    vec2 sc = (vUv - vec2(.5, .53)) * asp; // 以对话框中心为原点
    float well = length(sc), th = atan(sc.y, sc.x);
    vec2 mw = mat2(.906, -.423, .423, .906) * sc;
    float band = exp(-mw.y * mw.y * 6.);
    float cloud = pow(smoothstep(.25, .9, f), 1.5), cloud2 = pow(smoothstep(.35, .95, r.x), 1.5);
    vec3 accent = hsl(uHue2 + .38, .8, .5);
    vec3 space = mix(hsl(uHue, .6*uSat, .018), hsl(uHue + .08, .6*uSat, .04), vUv.y);
    space += (hsl(uHue, .85*uSat, .36) * cloud + hsl(uHue2, .9*uSat, .42) * cloud2 * .9 + accent * cloud * cloud2) * (.26 + 1.25*band);
    space += accent * pow(smoothstep(.42, .9, r.y), 1.6) * (.1 + .5*band);
    space *= 1. - .6 * band * smoothstep(.56, .3, r.y);
    space += hsl(uHue2, .7*uSat, .62) * line * .06 * (.25 + band);
    float arms = pow(.5 + .5*cos(2.*th + 6.*log(well + .05) + uFlow * .12), 2.5);
    space += (hsl(uHue2, .9*uSat, .52) * arms + accent * (1. - arms) * .3) * exp(-well * 2.6) * (.3 + .3*uEnergy) * (.5 + .9*cloud);
    space /= 1. + 1.6 * dot(space, vec3(.33)); // 软压缩：星云叠得再厚也不会被 Bloom 冲成一片白
    space += vec3(1., .9, .75) * .1 * exp(-well * well * 30.);
    vec2 g = vUv * asp * 190., gi = floor(g); float h1 = hash(gi);
    space += vec3(.8, .88, 1.) * step(.975 - .05*band, h1) * smoothstep(.32, 0., length(fract(g) - .5 - .3*(vec2(hash(gi + 3.1), hash(gi + 7.7)) - .5))) * (.3 + .6*hash(gi + 1.3)) * (.6 + .4*sin(uFlow*(1. + 4.*h1) + h1*90.));
    float mt = uFlow * .3, mid = floor(mt), mp = fract(mt) * 6.; // 每个周期的前 1/6 在飞
    vec2 ma = (vUv - vec2(.25 + .9*hash(vec2(mid, 1.)), .7 + .35*hash(vec2(mid, 2.)))) * asp, md = vec2(-.866, -.5);
    float along = dot(ma, md) - mp * 1.3, across = dot(ma, vec2(-md.y, md.x));
    space += vec3(.85, .93, 1.) * step(mp, 1.) * smoothstep(-.3, 0., along) * step(along, 0.) * exp(-across * across * 60000.) * sin(mp * 3.1416) * 1.3;
    space += vec3(1., .68, .34) * uEnergy * .05 * smoothstep(.5, .95, q.x * r.y * 2.4);
    col = mix(col, space, uScene);
    // 深海场景（鲸鱼）：DeepSeek 蓝的海水，上亮下暗；左上方斜射下来的光柱缓慢摇曳，水纹的等值线当焦散
    vec3 sea = mix(hsl(.64, .8, .03), hsl(.61, .85, .2), pow(vUv.y, 1.5));
    sea += hsl(.58, .9, .32) * cloud * .3 + hsl(uHue2, .8*uSat, .4) * cloud2 * .12;
    vec2 rp = (vUv - vec2(.28, 1.35)) * asp; float ra = atan(rp.x, -rp.y);
    float rays = noise(vec2(ra*16., uFlow*.07)) * noise(vec2(ra*37. + 5., -uFlow*.05));
    sea += hsl(.55, .8, .62) * pow(rays, 1.5) * .8 * vUv.y + hsl(.54, .9, .7) * line * .07 * vUv.y;
    col = mix(col, sea, uSea);
    col += hsl(uHue2, .9*uSat, .72) * ring * .7;
    col *= 1. - mix(1.1, .5, uScene) * dot(vUv - .5, vUv - .5);
    col = col * (1. - .45 * sw * smoothstep(.25, 1., cr)) + vec3(1., .66, .34) * sw * (.07 * exp(-cr*cr*6.) + .16 * exp(-cr*cr*90.));
    vec3 dye = texture2D(uDye, vUv).rgb;
    gl_FragColor = vec4(toLinear(col) + .55 * dye / (1. + dye), 1.); // 染料做软压缩并封顶，叠多了也不会一片死白
  }`

const DUST_VERT = COMMON + /* glsl */ `
  uniform float uPx; varying float vA, vHeat, vRot, vCore, vTint, vSpike, vFall, vFood;
  // 漩涡是个真的三维漏斗：盘面向后仰，越靠中心陷得越深；视角缓慢进动并跟着鼠标偏一点，再做透视除法。
  // 返回 (裁剪空间 xy, 透视系数 w)：w>1 在镜头近处，<1 在远处
  vec3 funnel(float ang, float rad, float t, float jit){
    vec3 p = vec3(cos(ang) * rad * 1.25, sin(ang) * rad * 1.25, 1.5*t*t + jit * .3 * rad);
    float ax = .58 + .07*sin(uFlow*.21) + .22*uTilt.y, ay = .10*sin(uFlow*.13) + .32*uTilt.x;
    p.yz = mat2(cos(ax), sin(ax), -sin(ax), cos(ax)) * p.yz;
    p.xz = mat2(cos(ay), sin(ay), -sin(ay), cos(ay)) * p.xz;
    float w = 2.3 / (2.3 + p.z);
    return vec3(p.x * w / uAspect, p.y * w + .3, w);
  }
  void main(){
    vec3 s = position; // 三个随机数，不是坐标
    // 顺流：各自速度不同，循环下落；整条河一起蜿蜒
    vec2 stream = vec2(s.x*2. - 1., 1. - 2.*fract(s.y + uFlow*(.03 + s.z*.08)));
    stream.x += .11*sin(stream.y*2.6 + uFlow*.35) + .05*sin(stream.y*6.1 - uFlow*.5 + 2.);
    // 辫状水道：粒子只在几股主流里亮起来，否则均匀撒点看起来像雪花而不是水
    float lane = sin(s.x*21. + 1.7*sin(stream.y*2.2 + uFlow*.25 + s.x*3.));
    float inLane = smoothstep(.1, .95, lane*.5 + .5);
    float k = fract(s.x * 7.31);
    // 星空（uScene=1）：每颗星沿一条很缓的螺旋线自己旋向对话框中心，越近越小越暗，到中心消失后从屏幕外重新出现。
    // 鼠标带一点视差（越亮的星越"近"，偏得越多）；思考时 uFlow 变快，星星就加速坠入
    float st = fract(s.y + uFlow * (.03 + .04*k));
    float sr = 1.95 * pow(1. - st, .8);
    float fall = smoothstep(.8, .2, sr); // 进了对话框的引力范围：拉成指向中心的光丝
    float sa = s.x * 6.2832 - 1.3*log(sr + .08) + uFlow * .02;
    vec2 starP = vec2(cos(sa) * sr / uAspect, sin(sa) * sr + .06) - uTilt * .09 * (.3 + s.z) * min(sr, 1.);
    float big = step(.965, s.z); // 少数亮星，带十字星芒
    float starSize = (1.6 + 6.*s.z*s.z*s.z + 16.*big) * (.45 + .55*min(sr, 1.)) * (1. + 1.6*fall);
    float starA = (.16 + 1.25*s.z*s.z*s.z) * smoothstep(0., .06, st) * smoothstep(.02, .3, sr) * (.62 + .38*sin(uFlow * (2. + 3.*k) + s.x * 90.));
    // 深海（uSea=1）：暗的一半粒子是饵——从四面八方漂向领头鲸的嘴（uMouth），先慢后快，绕到嘴的正前方（uAhead）再被一口吸进去；
    // 亮的一半是往上飘的气泡（思考时照常被卷去环绕对话框）
    float food = step(s.z, .5), fk = fract(s.z * 9.7);
    float ft = fract(s.y + uFlow * (.03 + .05*k)), fu = ft*ft;
    vec2 home = vec2(s.x*2. - 1., fk*2.4 - 1.2) + .05*vec2(sin(uFlow*.3 + s.y*40.), cos(uFlow*.24 + s.x*40.));
    vec2 ctrl = uAhead + (home - uAhead) * .25;
    vec2 bub = vec2(s.x*2. - 1. + .03*sin(uFlow*.9 + s.y*31.), 2.*fract(s.y + uFlow*(.02 + .05*k)) - 1.);
    vec2 seaP = mix(bub, mix(mix(home, ctrl, fu), mix(ctrl, uMouth, fu), fu), food);
    float seaSize = mix(2. + 11.*fk*fk*fk, (2.5 + 4.5*fk) * (1. - .5*fu), food);
    float seaA = mix(.01 + .26*fk*fk*fk*fk, (.06 + .9*smoothstep(.05, .6, fu)) * (.3 + .7*fk) * smoothstep(0., .05, ft) * (1. - smoothstep(.93, 1., fu)), food);
    // 涡旋：绕着舞台中心的椭圆轨道，内圈转得快
    float ang = s.y * 6.2832 + uFlow * (.5 + .9*(1. - k));
    vec2 orbit = vec2(cos(ang) * (.58 + .34*k), sin(ang) * (.70 + .26*k) + .04);
    // 漩涡（uMode=1）：四条对数螺旋臂，粒子从外缘一路被吸进漏斗底——越靠里转得越快，到底后回到外缘重来
    float t = fract(s.y + uFlow * (.07 + .07*k)); // 0 外缘 → 1 漏斗底
    float rad = 1.5 * pow(1. - t, 1.7), jit = fract(s.x * 91.7) - .5;
    float va = floor(s.x*4.) * 1.5708 + (fract(s.x*4.) - .5) * .55 - 3.4*log(rad + .05) + uFlow * .35;
    vec3 vortex = funnel(va, rad, t, jit);
    float life = smoothstep(0., .1, t) * smoothstep(0., .08, rad); // 两端淡入淡出，循环时不闪
    // 环绕只卷走一半粒子；漩涡卷走四分之三，其余继续顺流
    float m = smoothstep(0., 1., uEnergy) * step(mix(.5, .25, uMode), s.z);
    float star = step(.985, fract(s.x * 53.3)); // 少数大而亮的"星"，给景深一个参照
    gl_Position = vec4(mix(mix(mix(stream, starP, uScene), seaP, uSea), mix(orbit, vortex.xy, uMode), m), 0., 1.);
    gl_PointSize = uPx * mix(mix(mix(3. + s.z*7., starSize, uScene), seaSize, uSea), (3. + s.z*7.) * mix(.55, (.5 + .5*min(rad, 1.)) * vortex.z * (1. + 1.6*star), uMode), m);
    vTint = fract(s.x * 37.1); vSpike = uScene * (1. - m) * big * (1. - fall); vFall = uScene * (1. - m) * fall; vFood = uSea * (1. - m) * food;
    // 景深：贴近镜头的粒子又大又虚，所以调暗；越靠漏斗底越亮
    float va2 = (.25 + .5*s.z) * life * (1. + .9*(1. - min(rad, 1.)) + 1.5*star) / max(1., vortex.z * vortex.z * .7);
    vA = mix(mix(mix((.04 + .8*inLane) * (.3 + .7*s.z), starA, uScene), seaA, uSea), mix(.25 + .5*s.z, va2, uMode), m); vHeat = m;
    vCore = m * uMode * (1. - min(rad, 1.));
    // 光丝的朝向：顺流时竖直，进了漩涡就顺着它在屏幕上的运动方向
    vec2 dir = funnel(va + .05, rad, t, jit).xy - vortex.xy;
    vRot = m * uMode > .5 ? atan(dir.y, dir.x * uAspect) : mix(1.5708, sa - .5, step(.5, uScene));
  }`

const DUST_FRAG = COMMON + /* glsl */ `
  varying float vA, vHeat, vRot, vCore, vTint, vSpike, vFall, vFood;
  void main(){
    // 顺流时是竖向的光丝；被卷进环绕后收成光点，被卷进漩涡后是顺着切线的短光丝
    vec2 q = gl_PointCoord - .5, d = vec2(cos(vRot), -sin(vRot));
    float a = smoothstep(.5, 0., length(vec2(dot(q, vec2(-d.y, d.x)) * mix(mix(mix(4.5, 1. + 3.5*vFall, uScene), 1., uSea), mix(1., 3.6, uMode), vHeat), dot(q, d))));
    a = a * mix(1., a, uScene * (1. - vHeat)) // 星星的核更实
      + vSpike * .8 * (exp(-abs(q.x)*70. - abs(q.y)*7.) + exp(-abs(q.y)*70. - abs(q.x)*7.)); // 亮星的十字星芒
    // 漩涡外缘带水色、往里升温、漏斗底近白
    // 星空里的星有冷有暖，再带一点主题色
    vec3 cool = mix(hsl(uHue2, .8*uSat, .7), mix(mix(vec3(.55, .76, 1.), vec3(1., .8, .55), step(.5, vTint)), hsl(uHue2 + .38*step(.9, vTint), .85, .74), .25 + .6*step(.8, vTint)), uScene);
    cool = mix(cool, mix(vec3(.7, .9, 1.), vec3(1., .66, .5), vFood), uSea); // 深海里：气泡淡青，饵是磷虾的橙粉
    vec3 c = mix(cool, vec3(1., .72, .4), vHeat * mix(.85, .35 + .65*smoothstep(0., .5, vCore), uMode));
    c = mix(c, vec3(1., .95, .85), smoothstep(.55, 1., vCore));
    gl_FragColor = vec4(toLinear(c) * a * vA * (1. + .25*vHeat), 1.);
  }`

export function createBg(canvas) {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
  const renderer = new THREE.WebGLRenderer({ canvas, powerPreference: 'high-performance' })
  // 背景本身是柔和的流体，用不着视网膜分辨率：按 1x 渲染，高分屏上像素量直接少 3/4
  let px = 1
  renderer.setPixelRatio(px)
  const fluid = createFluid(renderer), whale = createWhale()
  const scene = new THREE.Scene(), camera = new THREE.Camera() // 两层都直接写裁剪空间坐标，相机只是占位
  const uniforms = {
    uFlow: { value: Math.random() * 50 }, uEnergy: { value: 0 }, uHue: { value: 0.5 }, uHue2: { value: 0.56 }, uSat: { value: 1 }, uAspect: { value: 1 },
    uPulse: { value: 99 }, uPulseAt: { value: new THREE.Vector2(0.5, 0.08) }, uPx: { value: px }, uMode: { value: 0 }, uScene: { value: 0 }, uTilt: { value: new THREE.Vector2() }, uSea: { value: 0 }, uMouth: { value: new THREE.Vector2(-0.7, 0) }, uAhead: { value: new THREE.Vector2(-0.2, 0) },
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
    effect: pick(EFFECTS, EFFECT_KEY, DEFAULT_EFFECT, stored(EFFECT_KEY) ?? DEFAULT_EFFECT),
    scene: pick(SCENES, SCENE_KEY, DEFAULT_SCENE, stored(SCENE_KEY) ?? DEFAULT_SCENE),
    /** 换一种思考特效 / 背景场景并记住；不传 id 就切到下一种。返回它的中文名。 */
    setEffect: (id) => EFFECTS[(api.effect = pick(EFFECTS, EFFECT_KEY, api.effect, id))],
    setScene: (id) => SCENES[(api.scene = pick(SCENES, SCENE_KEY, api.scene, id))],
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
    if (prev) u.uTilt.value.lerp({ x: prev[0] - 0.5, y: prev[1] - 0.5 }, Math.min(1, dt * 3)) // 漩涡的视角跟着鼠标偏一点
    u.uScene.value += ((api.scene === 'stars') - u.uScene.value) * Math.min(1, dt * 1.5)
    u.uSea.value += ((api.scene === 'whale') - u.uSea.value) * Math.min(1, dt * 1.5)
    const at = whale.tick(calm ? 0 : dt, u.uEnergy.value, api.scene === 'whale')
    u.uMouth.value.fromArray(at)
    u.uAhead.value.fromArray(at, 2)
    u.uMode.value += ((api.effect === 'vortex') - u.uMode.value) * Math.min(1, dt * 3)
    if (!calm) {
      u.uFlow.value += dt * (0.4 + 1.5 * u.uEnergy.value) // 思考时水流变急
      // 思考中：两个注入点沿回答卡片外沿对向绕行，把水搅成环形涡流
      const e = u.uEnergy.value
      if (e > 0.08) for (const side of [0, Math.PI]) {
        const a = u.uFlow.value * 1.3 + side
        const pull = 420 * e * u.uMode.value // 漩涡模式下水也往中心收
        fluid.splat(0.5 + Math.cos(a) * 0.34, 0.5 + Math.sin(a) * 0.42, -Math.sin(a) * 520 * e - Math.cos(a) * pull, Math.cos(a) * 520 * e - Math.sin(a) * pull, AMBER.map((c) => c * 0.014 * e), 0.0016)
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
