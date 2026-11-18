// 流体模拟（Stam 稳定流体，GPU 上跑）：速度场 + 染料场。
// 外部通过 splat() 往某个位置注入速度和染料——鼠标划过、点击、AI 思考的涡流都走这一个入口。
// 每帧 step()：涡度增强 → 散度 → 压力迭代 → 减梯度（保证不可压缩，才会卷出漩涡）→ 平流。
import * as THREE from 'three'

const SIM = 128, DYE = 384, PRESSURE_ITERS = 10
const VERT = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }'
const HEAD = 'varying vec2 vUv; uniform vec2 uTexel;\n'
const NEIGHBORS = 'vec2 L = vUv - vec2(uTexel.x, 0.), R = vUv + vec2(uTexel.x, 0.), B = vUv - vec2(0., uTexel.y), T = vUv + vec2(0., uTexel.y);'

const FRAG = {
  splat: `uniform sampler2D uT; uniform vec2 uP; uniform vec3 uC; uniform float uR, uAspect;
    void main(){ vec2 d = vUv - uP; d.x *= uAspect; gl_FragColor = vec4(texture2D(uT, vUv).rgb + exp(-dot(d, d) / uR) * uC, 1.); }`,
  advect: `uniform sampler2D uV, uS; uniform float uDt, uDecay;
    void main(){ vec2 c = vUv - uDt * texture2D(uV, vUv).xy * uTexel; gl_FragColor = vec4(texture2D(uS, c).rgb / (1. + uDecay * uDt), 1.); }`,
  curl: `uniform sampler2D uV;
    void main(){ ${NEIGHBORS} gl_FragColor = vec4(.5 * (texture2D(uV, R).y - texture2D(uV, L).y - texture2D(uV, T).x + texture2D(uV, B).x), 0., 0., 1.); }`,
  vorticity: `uniform sampler2D uV, uC; uniform float uDt, uCurl;
    void main(){ ${NEIGHBORS}
      float l = texture2D(uC, L).x, r = texture2D(uC, R).x, t = texture2D(uC, T).x, b = texture2D(uC, B).x, c = texture2D(uC, vUv).x;
      vec2 f = .5 * vec2(abs(t) - abs(b), abs(r) - abs(l)); f = f / (length(f) + 1e-4) * uCurl * c; f.y *= -1.;
      gl_FragColor = vec4(clamp(texture2D(uV, vUv).xy + f * uDt, -1000., 1000.), 0., 1.); }`,
  divergence: `uniform sampler2D uV;
    void main(){ ${NEIGHBORS} gl_FragColor = vec4(.5 * (texture2D(uV, R).x - texture2D(uV, L).x + texture2D(uV, T).y - texture2D(uV, B).y), 0., 0., 1.); }`,
  pressure: `uniform sampler2D uP, uD;
    void main(){ ${NEIGHBORS} gl_FragColor = vec4((texture2D(uP, L).x + texture2D(uP, R).x + texture2D(uP, B).x + texture2D(uP, T).x - texture2D(uD, vUv).x) * .25, 0., 0., 1.); }`,
  gradient: `uniform sampler2D uP, uV;
    void main(){ ${NEIGHBORS} gl_FragColor = vec4(texture2D(uV, vUv).xy - vec2(texture2D(uP, R).x - texture2D(uP, L).x, texture2D(uP, T).x - texture2D(uP, B).x), 0., 1.); }`,
}

export function createFluid(renderer) {
  const scene = new THREE.Scene(), camera = new THREE.Camera()
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2))
  quad.frustumCulled = false
  scene.add(quad)

  const target = (size, filter) => new THREE.WebGLRenderTarget(size, size, { type: THREE.HalfFloatType, minFilter: filter, magFilter: filter, depthBuffer: false })
  const pair = (size, filter) => {
    const p = { read: target(size, filter), write: target(size, filter), swap: () => ([p.read, p.write] = [p.write, p.read]) }
    return p
  }
  const vel = pair(SIM, THREE.LinearFilter), dye = pair(DYE, THREE.LinearFilter), prs = pair(SIM, THREE.NearestFilter)
  const div = target(SIM, THREE.NearestFilter), curl = target(SIM, THREE.NearestFilter)

  const mats = Object.fromEntries(Object.entries(FRAG).map(([k, frag]) => [k, new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: HEAD + frag, depthTest: false, depthWrite: false, uniforms: { uTexel: { value: new THREE.Vector2(1 / SIM, 1 / SIM) } } })]))

  function pass(name, out, values) {
    const m = mats[name]
    for (const k in values) (m.uniforms[k] ??= { value: null }).value = values[k]
    quad.material = m
    renderer.setRenderTarget(out)
    renderer.render(scene, camera)
  }

  return {
    get dye() { return dye.read.texture },
    get vel() { return vel.read.texture },
    /** 在 (x,y)（0..1，原点左下）注入速度 (dx,dy) 和颜色 rgb；radius 是高斯半径的平方。 */
    splat(x, y, dx, dy, rgb, radius = 0.0025) {
      const base = { uP: new THREE.Vector2(x, y), uR: radius, uAspect: innerWidth / innerHeight }
      pass('splat', vel.write, { ...base, uT: vel.read.texture, uC: new THREE.Vector3(dx, dy, 0) })
      vel.swap()
      pass('splat', dye.write, { ...base, uT: dye.read.texture, uC: new THREE.Vector3(...rgb) })
      dye.swap()
      renderer.setRenderTarget(null)
    },
    step(dt) {
      pass('curl', curl, { uV: vel.read.texture })
      pass('vorticity', vel.write, { uV: vel.read.texture, uC: curl.texture, uDt: dt, uCurl: 26 })
      vel.swap()
      pass('divergence', div, { uV: vel.read.texture })
      for (let i = 0; i < PRESSURE_ITERS; i++) {
        pass('pressure', prs.write, { uP: prs.read.texture, uD: div.texture })
        prs.swap()
      }
      pass('gradient', vel.write, { uP: prs.read.texture, uV: vel.read.texture })
      vel.swap()
      pass('advect', vel.write, { uV: vel.read.texture, uS: vel.read.texture, uDt: dt, uDecay: 0.35 })
      vel.swap()
      pass('advect', dye.write, { uV: vel.read.texture, uS: dye.read.texture, uDt: dt, uDecay: 1.4 }) // 染料 1 秒左右散尽，不挡正文
      dye.swap()
      renderer.setRenderTarget(null)
    },
  }
}
