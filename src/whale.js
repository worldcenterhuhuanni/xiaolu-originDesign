// 鲸鱼场景的主角：一小群俯视视角的 DeepSeek 蓝小肥鲸，在整个页面里巡游（画在背景画布和舞台之间的一层 2D canvas 上）。
// 游法参考 dsh-ascii-whales 插件：身体是一条"头带着走"的脊柱链，转弯时整条身子顺着弯、尾巴一路摆过去，所以看起来是活的。
// 造型是 Q 版比例的矢量画：圆圆的大脑袋占了小半个身子、胖肚子、短尾柄、心形尾鳍、圆桨一样的胸鳍；
// 头顶一对会眨的大眼睛、腮红、吻端一道微笑；沿脊柱一层层叠出柔和的明暗，头上一块高光，像个软胶玩具。
// 交互：鼠标靠近会受惊（瞪大眼）加速躲开，点击会把附近的吓跑；最大的那头是贪吃鬼，背景里的饵（bg.js 的粒子）都往它嘴里游，
// 它会一口一口地张嘴吃，AI 越忙吃得越急、越吃越胖，答完后喷一次水，再慢慢瘦回去。
// 不变形的三条约束（改参数时别破坏）：头部几节几乎不弯；后段每节的弯曲上限保证转弯半径大于身体半宽；转向角速度是缓动的，不会突变。
import gsap from 'gsap'

const N = 22, LIGHT = [-0.5, -0.86] // 脊柱节点数；光从左上方来（和背景的光柱一致）
const STIFF = 6, BEND_HEAD = 0.03, BEND_BODY = 0.1 // 前 STIFF 节是刚硬的头；每节最大弯角（弧度）
const FAT = 0.22, WIDEST = 0.22 // 吃撑后最多胖多少；身体最胖处的半宽
const clamp = (v, a, b) => Math.max(a, Math.min(b, v))
const rand = (a, b) => a + Math.random() * (b - a)
/** 身体半宽（占体长的比例）沿脊柱的分布，s=0 头 → 1 尾端。头是钝的（吻端由 band 里的半圆收口）。 */
function hw(s) {
  if (s < 0.28) return 0.15 + (WIDEST - 0.15) * Math.sin((s / 0.28) * Math.PI / 2)
  if (s < 0.86) return 0.028 + (WIDEST - 0.028) * (1 - (s - 0.28) / 0.58) ** 1.2
  return 0.028 * (1 - (s - 0.86) / 0.14)
}
if (import.meta.env.DEV) {
  for (const s of [0.28, 0.86]) console.assert(Math.abs(hw(s - 1e-6) - hw(s + 1e-6)) < 1e-3, '鲸鱼轮廓在分段处不连续', s)
  // 最急的弯：每节长 1/(N-1)、弯 BEND_BODY，转弯半径必须大于最胖处的半宽（含吃胖的部分），否则内侧轮廓会自交 = 变形
  console.assert(1 / (N - 1) / BEND_BODY > WIDEST * (1 + FAT), '鲸鱼身体弯曲上限过大，会变形')
}

export function createWhale() {
  const cv = document.createElement('canvas')
  cv.id = 'whale'
  cv.setAttribute('aria-hidden', 'true')
  document.getElementById('bg').after(cv)
  gsap.set(cv, { autoAlpha: 0 })
  const ctx = cv.getContext('2d')
  let W = 0, H = 0, dpr = 1
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2)
    W = innerWidth, H = innerHeight
    cv.width = W * dpr, cv.height = H * dpr
  }
  resize()
  addEventListener('resize', resize)

  // 一大两小（数值 = 相对大小，增减这个数组就能改数量），小的先画、更淡，像游在更深处
  const min = Math.min(W, H), base = clamp(min * 0.4, 160, 400)
  const pod = [0.56, 0.72, 1].map((size, i, all) => {
    const a = (i / all.length) * Math.PI * 2 + rand(-0.4, 0.4), dir = i % 2 ? -1 : 1, orbit = min * rand(0.28, 0.4)
    const L = base * size, heading = a + dir * Math.PI / 2, nodes = new Float32Array(N * 2)
    for (let k = 0; k < N; k++) {
      nodes[k * 2] = W / 2 + Math.cos(a) * orbit * (W / min) * 0.9 - Math.cos(heading) * (L / (N - 1)) * k
      nodes[k * 2 + 1] = H / 2 + Math.sin(a) * orbit - Math.sin(heading) * (L / (N - 1)) * k
    }
    return { L, nodes, heading, dir, orbit, speed: 30, turn: 0, phase: rand(0, 6), wander: 0, alarm: 0, full: 0, alpha: 0.66 + 0.34 * size }
  })
  const leader = pod[pod.length - 1]
  if (import.meta.env.DEV) window.__whaleHead = () => [leader.nodes[0], leader.nodes[1]] // 调试用：自动化测试拿它追着鲸鱼放鼠标

  const ptr = { x: 0, y: 0, on: false }
  addEventListener('pointermove', (e) => (ptr.x = e.clientX, ptr.y = e.clientY, ptr.on = e.pointerType !== 'touch'))
  addEventListener('pointerdown', (e) => { for (const w of pod) if (Math.hypot(w.nodes[0] - e.clientX, w.nodes[1] - e.clientY) < w.L + 120) w.alarm = 1 })
  document.documentElement.addEventListener('pointerleave', () => (ptr.on = false))

  /** 游动：几股意愿（惯性、随机游荡、绕页面中心巡游、互相让开、别出界、躲鼠标）合成一个想去的方向，头按缓动的转向速度拐过去，身体跟上。 */
  function swim(w, dt, energy) {
    const n = w.nodes, L = w.L, hx = n[0], hy = n[1], m = Math.min(W, H)
    let dx = Math.cos(w.heading), dy = Math.sin(w.heading)
    w.wander = clamp(w.wander + (Math.random() - 0.5) * dt * 3, -1, 1)
    dx += Math.cos(w.heading + w.wander) * 0.45, dy += Math.sin(w.heading + w.wander) * 0.45
    const rx = (hx - W / 2) / (W / m), ry = hy - H / 2, r = Math.hypot(rx, ry) || 1, radial = clamp((w.orbit - r) / w.orbit, -1, 1)
    dx += ((-ry / r) * w.dir + (rx / r) * radial * 0.9) * 0.55, dy += ((rx / r) * w.dir + (ry / r) * radial * 0.9) * 0.55
    for (const o of pod) if (o !== w) for (let k = 0; k < N; k += 5) {
      const ox = hx - o.nodes[k * 2], oy = hy - o.nodes[k * 2 + 1], d = Math.hypot(ox, oy), range = (L + o.L) * 0.42
      if (d < range && d > 1e-3) (dx += (ox / d) * (1 - d / range) * 3, dy += (oy / d) * (1 - d / range) * 3)
    }
    // 别出界：靠近边缘就往回拐；真出界了这股力会压过躲鼠标的力，不会被赶出屏幕
    const over = Math.max(-hx, hx - W, -hy, hy - H)
    if (over > -L * 0.3) {
      const f = clamp((over + L * 0.3) / (L * 0.4), 0, 1) * (over > 0 ? 12 : 3.5), d = Math.hypot(W / 2 - hx, H / 2 - hy) || 1
      dx += ((W / 2 - hx) / d) * f, dy += ((H / 2 - hy) / d) * f
    }
    // 躲鼠标：头或身子离鼠标太近就往反方向拐，越近越慌——主要靠加速游开，转向只稍微灵一点
    let scare = 0
    if (ptr.on) for (const k of [0, 7]) {
      const ax = n[k * 2] - ptr.x, ay = n[k * 2 + 1] - ptr.y, d = Math.hypot(ax, ay) || 1, R = L * 0.5 + 90
      if (d < R) (dx += (ax / d) * (1 - d / R) * 8, dy += (ay / d) * (1 - d / R) * 8, scare = Math.max(scare, 1 - d / R))
    }
    w.alarm += (scare - w.alarm) * Math.min(1, dt * (scare > w.alarm ? 6 : 0.9))

    // 转向：角速度朝目标缓动（不突变），并且有上限
    const want = Math.atan2(dy, dx) - w.heading, maxRate = 0.75 + 1.1 * w.alarm
    w.turn += (clamp(Math.atan2(Math.sin(want), Math.cos(want)) * 2.5, -maxRate, maxRate) - w.turn) * Math.min(1, dt * 4)
    w.heading += w.turn * dt
    const cruise = (26 + L * 0.04) * (1 + 0.8 * energy)
    w.speed += (cruise * (1 + 2.2 * w.alarm) - w.speed) * Math.min(1, dt * (1.2 + 3 * w.alarm))
    w.phase += dt * (2.2 + w.speed / 18)
    n[0] += Math.cos(w.heading) * w.speed * dt, n[1] += Math.sin(w.heading) * w.speed * dt
    // 身体：每一节被前一节拖着走，相邻两节的夹角有上限（头部几乎不弯），所以转弯时整条身子弯成平滑的弧
    const seg = L / (N - 1)
    let prev = w.heading + Math.PI
    for (let k = 1; k < N; k++) {
      const px = n[k * 2 - 2], py = n[k * 2 - 1], a = Math.atan2(n[k * 2 + 1] - py, n[k * 2] - px) - prev, lim = k < STIFF ? BEND_HEAD : BEND_BODY
      prev += clamp(Math.atan2(Math.sin(a), Math.cos(a)), -lim, lim)
      n[k * 2] = px + Math.cos(prev) * seg, n[k * 2 + 1] = py + Math.sin(prev) * seg
    }
    if (Math.random() < dt * (1.2 + 16 * w.alarm)) bubble(n[N * 2 - 2], n[N * 2 - 1], 14, 5)
  }

  // 水花：尾巴甩出的气泡、喷水的水珠和水环，都是"一个会变大变淡的圈"
  const fx = []
  const bubble = (x, y, v, grow, r = rand(1.5, 4), decay = 0.8) => fx.push({ x, y, vx: rand(-v, v), vy: rand(-v, v), r, grow, life: 1, decay })

  const X = new Float32Array(N), Y = new Float32Array(N), NX = new Float32Array(N), NY = new Float32Array(N), HW = new Float32Array(N)
  /** 脊柱上 s 处的位置、指向尾巴的切线、法线和半宽。 */
  function at(s) {
    const f = s * (N - 1), i = Math.min(N - 2, f | 0), u = f - i
    return { x: X[i] + (X[i + 1] - X[i]) * u, y: Y[i] + (Y[i + 1] - Y[i]) * u, tx: NY[i], ty: -NX[i], nx: NX[i], ny: NY[i], hw: HW[i] + (HW[i + 1] - HW[i]) * u }
  }
  /** 沿脊柱铺一条色带：scale = 相对身体的宽度，bias = 朝受光一侧偏多少。 */
  function band(scale, bias, fill) {
    const pts = [], lit = (k) => bias * (NX[k] * LIGHT[0] + NY[k] * LIGHT[1])
    for (let k = 0; k < N; k++) { const o = HW[k] * (lit(k) + scale); pts.push(X[k] + NX[k] * o, Y[k] + NY[k] * o) }
    for (let k = N - 1; k >= 0; k--) { const o = HW[k] * (lit(k) - scale); pts.push(X[k] + NX[k] * o, Y[k] + NY[k] * o) }
    // 吻端用半圆收口：鲸鱼的头是圆钝的，不是尖的
    const r = HW[0] * scale, cx = X[0] + NX[0] * HW[0] * lit(0), cy = Y[0] + NY[0] * HW[0] * lit(0)
    for (let j = 1; j < 10; j++) { const a = (j / 10) * Math.PI; pts.push(cx + (-NX[0] * Math.cos(a) - NY[0] * Math.sin(a)) * r, cy + (-NY[0] * Math.cos(a) + NX[0] * Math.sin(a)) * r) }
    const c = pts.length
    ctx.beginPath()
    ctx.moveTo((pts[c - 2] + pts[0]) / 2, (pts[c - 1] + pts[1]) / 2)
    for (let i = 0; i < c; i += 2) ctx.quadraticCurveTo(pts[i], pts[i + 1], (pts[i] + pts[(i + 2) % c]) / 2, (pts[i + 1] + pts[(i + 3) % c]) / 2)
    ctx.fillStyle = fill
    ctx.fill()
  }
  /** 一片圆润的鳍：从 (x,y) 沿 (ux,uy) 伸出去的椭圆，根部深、尖端浅。 */
  function paddle(x, y, ux, uy, len, wide) {
    const g = ctx.createLinearGradient(x, y, x + ux * len, y + uy * len)
    g.addColorStop(0, '#3a55e6'); g.addColorStop(1, '#b9c8ff')
    ctx.fillStyle = g
    ctx.beginPath(); ctx.ellipse(x + ux * len * 0.5, y + uy * len * 0.5, len * 0.56, wide, Math.atan2(uy, ux), 0, 7); ctx.fill()
  }
  const dot = (x, y, r, fill, ry = r, rot = 0) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.ellipse(x, y, r, ry, rot, 0, 7); ctx.fill() }

  let clock = 0
  function draw(w, chew) {
    const n = w.nodes, L = w.L, fat = 1 + FAT * w.full
    // 渲染用的脊柱：在骨架上叠一层摆动波——头不摆，从胸鳍往后逐渐放大，游得越快摆得越开
    for (let k = 0; k < N; k++) {
      const s = k / (N - 1), a = Math.max(k - 1, 0), b = Math.min(k + 1, N - 1), back = Math.max(0, s - 0.25) / 0.75
      const tx = n[b * 2] - n[a * 2], ty = n[b * 2 + 1] - n[a * 2 + 1], d = Math.hypot(tx, ty) || 1
      const off = Math.sin(w.phase - s * 3.6) * L * 0.05 * back * back * (0.6 + 0.4 * Math.min(1, w.speed / 60))
      X[k] = n[k * 2] - (ty / d) * off, Y[k] = n[k * 2 + 1] + (tx / d) * off
      HW[k] = hw(s) * L * fat
    }
    for (let k = 0; k < N; k++) {
      const a = Math.max(k - 1, 0), b = Math.min(k + 1, N - 1), tx = X[b] - X[a], ty = Y[b] - Y[a], d = Math.hypot(tx, ty) || 1
      NX[k] = -ty / d, NY[k] = tx / d
    }
    ctx.globalAlpha = w.alpha

    // 胸鳍：两片圆桨，向后斜伸，一下一下地划水
    const p = at(0.3)
    for (const side of [-1, 1]) {
      const a = 1.0 + 0.3 * Math.sin(w.phase * 0.5 + side)
      paddle(p.x + side * p.nx * p.hw * 0.75, p.y + side * p.ny * p.hw * 0.75, side * p.nx * Math.sin(a) + p.tx * Math.cos(a), side * p.ny * Math.sin(a) + p.ty * Math.cos(a), L * 0.21, L * 0.062)
    }
    // 尾鳍：两片圆叶向两侧斜伸，合起来是个心形
    const t = at(0.95)
    for (const side of [-1, 1]) {
      const ux = t.tx * 0.5 + side * t.nx * 0.87, uy = t.ty * 0.5 + side * t.ny * 0.87
      paddle(t.x - t.tx * L * 0.02, t.y - t.ty * L * 0.02, ux, uy, L * 0.23, L * 0.075)
    }
    // 身体：最外一圈深蓝并带一圈辉光，往里一层层叠得越来越亮、越来越偏向受光面——圆滚滚的体积感就是这么来的
    ctx.shadowColor = 'rgb(77 107 254 / 0.6)'
    ctx.shadowBlur = L * 0.12
    band(1, 0, '#2a3cc0')
    ctx.shadowBlur = 0
    band(0.92, 0.04, '#4460f6')
    for (let i = 0; i < 9; i++) band(0.84 - i * 0.075, 0.08 + i * 0.04, 'rgb(140 166 255 / 0.12)')
    // 头：一块软胶玩具似的高光
    const hl = at(0.1), ha = Math.atan2(hl.ty, hl.tx)
    dot(hl.x + LIGHT[0] * hl.hw * 0.42, hl.y + LIGHT[1] * hl.hw * 0.42, L * 0.055, 'rgb(255 255 255 / 0.3)', L * 0.03, ha)
    dot(hl.x + LIGHT[0] * hl.hw * 0.66, hl.y + LIGHT[1] * hl.hw * 0.66, L * 0.014, 'rgb(255 255 255 / 0.5)')
    // 脸：头顶一对会眨的大眼睛（受惊时瞪圆）、眼睛后面的腮红
    const e = at(0.085), c = at(0.19), blink = (clock + w.phase) % 4.4 < 0.13 && w.alarm < 0.3 ? 0.12 : 1, er = L * 0.03 * (1 + 0.3 * w.alarm)
    for (const side of [-1, 1]) {
      dot(c.x + side * c.nx * c.hw * 0.66, c.y + side * c.ny * c.hw * 0.66, L * 0.034, 'rgb(255 138 176 / 0.6)', L * 0.022, ha)
      const ex = e.x + side * e.nx * e.hw * 0.56, ey = e.y + side * e.ny * e.hw * 0.56
      dot(ex, ey, er * blink, '#0a1238', er, ha)
      if (blink === 1) {
        dot(ex + LIGHT[0] * er * 0.4, ey + LIGHT[1] * er * 0.4, er * 0.36, '#fff')
        dot(ex - LIGHT[0] * er * 0.4, ey - LIGHT[1] * er * 0.4, er * 0.16, 'rgb(255 255 255 / 0.8)')
      }
    }
    // 嘴：吻端一道微笑；吃东西（或受惊）时张成一个小圆口
    const fx0 = X[0] - e.tx * HW[0] * 0.62, fy0 = Y[0] - e.ty * HW[0] * 0.62, open = Math.max(chew, w.alarm * 0.8)
    if (open > 0.2) {
      dot(fx0, fy0, L * 0.012 + L * 0.02 * open, '#2a0f3d', L * 0.03 * open, ha + Math.PI / 2)
      dot(fx0 + e.tx * L * 0.008, fy0 + e.ty * L * 0.008, L * 0.014 * open, '#ff7fa3')
    } else {
      const sw = HW[0] * 0.3
      ctx.strokeStyle = '#1b2a96'; ctx.lineWidth = L * 0.009; ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(fx0 + e.nx * sw + e.tx * sw * 0.35, fy0 + e.ny * sw + e.ty * sw * 0.35)
      ctx.quadraticCurveTo(fx0 - e.tx * sw * 0.5, fy0 - e.ty * sw * 0.5, fx0 - e.nx * sw + e.tx * sw * 0.35, fy0 - e.ny * sw + e.ty * sw * 0.35)
      ctx.stroke()
    }
    // 头顶的气孔
    const h = at(0.27)
    dot(h.x, h.y, L * 0.014, 'rgb(20 30 110 / 0.5)', L * 0.007, Math.atan2(h.ny, h.nx))
    return h
  }

  let shown = false, busy = false
  const out = new Float32Array([-0.7, 0, -0.2, 0])
  return {
    /** 每帧调用一次。energy = AI 的忙碌程度。返回 [嘴x, 嘴y, 嘴前方x, 嘴前方y]（裁剪空间）：饵先绕到嘴前方，再被吸进嘴里。 */
    tick(dt, energy, on) {
      if (on !== shown) gsap.to(cv, { autoAlpha: (shown = on) ? 1 : 0, duration: 0.8, overwrite: 'auto' })
      if (!on) return out
      clock += dt
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      let blow
      for (const w of pod) {
        if (dt) swim(w, dt, energy)
        // 贪吃鬼平时一口一口慢慢吃，AI 一忙就嚼得飞快；其余的只在受惊时张嘴
        const chew = w === leader ? Math.max(0.6 * Math.max(0, Math.sin(clock * 2)), energy * (0.5 + 0.5 * Math.abs(Math.sin(clock * 7)))) : 0
        const h = draw(w, chew)
        if (w === leader) blow = h
      }
      // 吃得越久越胖；忙完（energy 落回 0）从气孔喷一次水，然后慢慢瘦回去
      leader.full = clamp(leader.full + dt * (energy > 0.05 ? energy * 0.07 : -0.12), 0, 1)
      if (energy > 0.3) busy = true
      else if (busy && energy < 0.05) {
        busy = false
        for (let i = 0; i < 16; i++) bubble(blow.x, blow.y, 70, 4, rand(2, 5), 1.1)
        bubble(blow.x, blow.y, 0, 110, 6, 1.2), bubble(blow.x, blow.y, 0, 60, 3, 0.9)
      }
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.2
      for (let i = fx.length - 1; i >= 0; i--) {
        const b = fx[i]
        if ((b.life -= dt * b.decay) <= 0) { fx.splice(i, 1); continue }
        b.x += b.vx * dt, b.y += b.vy * dt, b.r += b.grow * dt
        ctx.strokeStyle = `rgb(205 228 255 / ${b.life * 0.6})`
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 7); ctx.stroke()
      }
      const n = leader.nodes, hx = Math.cos(leader.heading), hy = Math.sin(leader.heading)
      out[0] = (n[0] / W) * 2 - 1, out[1] = 1 - (n[1] / H) * 2
      out[2] = ((n[0] + hx * leader.L * 0.9) / W) * 2 - 1, out[3] = 1 - ((n[1] + hy * leader.L * 0.9) / H) * 2
      return out
    },
  }
}
