// 舞台：把当前会话的可见路径渲染成"时间纵深"——当前轮在最前，上游各轮向后、向上退入景深。
// 每一轮是两件东西：你的问题是一张亮色便签，AI 的回答是一张暗色稿纸，便签压在稿纸右上角。
// 明暗对比不依赖主题色，也不需要头像。
// 上游的每一层都是完整的一张卡的顶沿：左边是那一轮回答的摘要，右边是那一轮的问题——问答成对，不只是问题列表。
// 另管右侧时间轴。只读 store，不改状态；所有点击由 main.js 统一委托处理。
import gsap from 'gsap'
import { current, path, isLive, answerText, gistOf } from './store.js'
import { renderBlock, esc } from './blocks.js'
import { SUGGESTIONS } from './seed.js'

const $stage = document.getElementById('stage')
const $rail = document.getElementById('rail')
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const els = new Map() // turnId → 场景元素
const pad = (n) => String(n).padStart(2, '0')
let shown = null

const ICON = {
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V6.5A2.5 2.5 0 0 1 7.5 4H15"/>',
  regen: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',
  ref: '<path d="M7 17 17 7"/><path d="M9 7h8v8"/>',
  up: '<path d="M7 10v10H4V10z"/><path d="M7 10l4-6.5a1.8 1.8 0 0 1 3.2 1.4L13.5 9H18a2 2 0 0 1 2 2.4l-1.2 6.9a2 2 0 0 1-2 1.7H7"/>',
  edit: '<path d="M4 20h4L19.5 8.5l-4-4L4 16z"/>',
  focus: '<path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',
}
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`

function build(t) {
  const el = document.createElement('article')
  el.className = 'scene'
  el.dataset.id = t.id
  el.innerHTML = `
    <section class="ask">
      <div class="askmeta">
        <button class="ib" data-tool="edit" title="改写这个问题重新问：生成一条新支流，原问答保留" aria-label="改写问题">${icon('edit')}</button>
        <span class="fork"></span><span class="no"></span>
      </div>
      <div class="note" title="点击展开 / 收起完整问题">
        <h2></h2>
        <div class="refs">${t.refs.map((r) => `<span class="chip">↗ ${esc(r.q)}</span>`).join('')}${(t.files ?? []).map((f) => `<span class="chip">${f.kind === 'image' ? '图片' : '文件'} · ${esc(f.name)}</span>`).join('')}</div>
      </div>
    </section>
    <section class="sheet">
      <header>
        <i class="orb" aria-hidden="true"></i><span class="status"></span><span class="gist"></span>
        <span class="grow"></span>
        <button class="ib" data-tool="focus" title="专注阅读（F）" aria-label="专注阅读">${icon('focus')}</button>
      </header>
      <i class="progress"></i>
      <div class="body">
        <nav class="outline" aria-label="本回答目录"></nav>
        <details class="think"><summary>思考过程</summary><pre></pre></details>
        <div class="answer"></div>
        <footer class="tools">
          <button data-tool="stop">${icon('stop')}停止</button>
          <button data-tool="copy">${icon('copy')}复制</button>
          <button data-tool="regen">${icon('regen')}重新生成</button>
          <button data-tool="ref">${icon('ref')}引用</button>
          <span class="grow"></span>
          <button class="ib" data-tool="up" title="有用" aria-label="有用">${icon('up')}</button>
          <button class="ib" data-tool="down" title="没用" aria-label="没用">${icon('up')}</button>
        </footer>
      </div>
    </section>`
  el.querySelector('h2').textContent = t.q
  return el
}

const STATUS = { thinking: '正在思考', answering: '正在回答', stopped: '已停止', error: '出错了' }

/** 流式期间的局部刷新：只动状态行、思考区和回答区，不重建场景。 */
export function update(t) {
  const el = els.get(t.id)
  if (!el) return // 这一轮不在当前可见路径上，它照常在后台生成
  const live = isLive(t), body = el.querySelector('.body'), think = el.querySelector('.think')
  if (el.dataset.status !== t.status) {
    think.open = t.status === 'thinking' // 思考时展开，开始回答后自动收起；之后想看再点开
    el.dataset.status = t.status
  }
  const chars = answerText(t).length
  el.querySelector('.status').textContent = STATUS[t.status] ?? `思考 ${(t.ms / 1000).toFixed(1)} 秒${chars > 300 ? ` · 约 ${Math.round(chars / 10) * 10} 字` : ''}`
  el.querySelector('.gist').textContent = gistOf(t, 90) || STATUS[t.status] || '' // 退到上游叠层时，用这句话代表这一轮的回答
  think.hidden = !t.think
  think.lastElementChild.textContent = t.think

  // 流式时跟随最新内容——但只在用户本来就停在底部时跟，往上翻了就不打扰
  const follow = live && body.scrollHeight - body.scrollTop - body.clientHeight < 80
  const answer = el.querySelector('.answer')
  answer.innerHTML = t.blocks.map(renderBlock).join('') + (t.status === 'stopped' ? '<p class="note-stop">已停止生成</p>' : '')
  if (follow) body.scrollTop = body.scrollHeight

  // 长回答（≥3 个小标题）自动出目录，常驻在回答顶部
  const heads = live ? [] : [...answer.querySelectorAll('h4')]
  el.querySelector('.outline').innerHTML = heads.length >= 3 ? heads.map((h, i) => `<button data-jump="${i}">${esc(h.textContent)}</button>`).join('') : ''
  el.querySelector('[data-tool="up"]').classList.toggle('on', t.vote === 1)
  el.querySelector('[data-tool="down"]').classList.toggle('on', t.vote === -1)
}

export function render() {
  const s = current(), p = path(s)
  if (shown !== s.id) {
    els.forEach((el) => el.remove())
    els.clear()
    shown = s.id
  }
  const keep = new Set(p.map((t) => t.id))
  for (const [id, el] of els) if (!keep.has(id)) (el.remove(), els.delete(id))

  let c = p.findIndex((t) => t.id === s.cursor)
  if (c < 0) c = p.length - 1
  s.cursor = p[c]?.id ?? 'root'

  p.forEach((t, i) => {
    let el = els.get(t.id)
    const fresh = !el
    if (fresh) {
      el = build(t)
      els.set(t.id, el)
      $stage.append(el)
      update(t)
    }
    const sib = s.turns[t.parent].children
    el.querySelector('.no').textContent = el.querySelector('.gist').dataset.no = pad(i + 1)
    el.querySelector('.fork').innerHTML = sib.length > 1
      ? `<button data-fork="-1" aria-label="上一条支流">‹</button>支流 ${sib.indexOf(t.id) + 1}/${sib.length}<button data-fork="1" aria-label="下一条支流">›</button>`
      : ''

    // d<0 上游：退入景深并向上叠，露出卡片顶沿（回答摘要 + 问题便签）；d>0 下游（溯回时）：飞到镜头前淡出
    const d = i - c, a = Math.abs(d)
    el.classList.toggle('past', d < 0)
    el.classList.toggle('cur', d === 0)
    el.style.zIndex = 100 - a
    el.style.setProperty('--d', a)
    const to = d === 0 ? { y: 0, z: 0, autoAlpha: 1 }
      : d < 0 ? { y: -50 * a, z: -150 * a, autoAlpha: a > 3 ? 0 : 1 - a * 0.16 }
      : { y: 120, z: 220, autoAlpha: 0 }
    if (fresh) gsap.set(el, { y: 140, z: 260, autoAlpha: 0 })
    gsap.to(el, { ...to, duration: calm ? 0 : 0.8, ease: 'power3.out', overwrite: 'auto' })
  })

  let empty = $stage.querySelector('.empty')
  if (!p.length && !empty) {
    empty = document.createElement('div')
    empty.className = 'empty'
    empty.innerHTML = `<h2>一条新的河</h2><p>问第一个问题，它就开始流动。</p><div>${SUGGESTIONS.map((q) => `<button data-suggest>${esc(q)}</button>`).join('')}</div>`
    $stage.append(empty)
    gsap.from(empty, { autoAlpha: 0, y: 20, duration: calm ? 0 : 0.6 })
  } else if (p.length) empty?.remove()

  // 时间轴：本会话当前路径上的所有问题，⑂ 标出有分叉的位置
  $rail.innerHTML = p.map((t, i) => {
    const n = s.turns[t.parent].children.length
    return `<button data-go="${t.id}" class="${i === c ? 'cur' : ''}${isLive(t) ? ' live' : ''}" title="${esc(t.q)}"><i>${pad(i + 1)}</i><span>${esc(t.q)}</span>${n > 1 ? `<em>⑂${n}</em>` : ''}</button>`
  }).join('')
  $rail.hidden = !p.length
}
