// 本文件只做接线——提问/生成流程、键盘与滚轮、鼠标交互、各模块之间的跳转。
// 模块分工：store 数据 · stage 舞台与时间轴 · shelf 会话架 · composer 输入台 · palette 搜索 · bg 背景 · ai/business 适配
import gsap from 'gsap'
import './style.css'
import { createBg } from './bg.js'
import { state, current, path, newSession, addTurn, reveal, save, answerText, toMarkdown, themeOf, shelfList } from './store.js'
import { seed } from './seed.js'
import { think } from './ai.js'
import { runAction } from './business.js'
import * as stage from './stage.js'
import { initShelf, renderShelf, shelfOpen, openWall, closeWall } from './shelf.js'
import { composer } from './composer.js'
import { initPalette, openPalette } from './palette.js'

const $ = (id) => document.getElementById(id)
const $q = $('q'), $toast = $('toast'), $stage = $('stage'), $send = $('send')
const bg = createBg($('bg'))
if (import.meta.env.DEV) window.bg = bg // 调试用：控制台里 bg.energy = 1、bg.setEffect('vortex')、bg.setScene('stars') 直接看背景
const live = new Map() // turnId → { ctl, turn }：正在生成的轮次，可以同时有多条支流、多个会话在生成

if (!state.sessions.length) seed()
if (!current()) state.current = state.sessions[0].id

// ---------- 视图同步 ----------

function refresh() {
  const s = current(), theme = themeOf(s), root = document.documentElement.style
  stage.render()
  renderShelf()
  composer.refresh()
  root.setProperty('--h', theme.h * 360)
  root.setProperty('--h2', theme.h2 * 360)
  root.setProperty('--sat', theme.sat)
  bg.theme = theme
  save()
}

function toast(msg) {
  $toast.textContent = msg
  gsap.killTweensOf($toast)
  gsap.timeline().fromTo($toast, { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.3 }).to($toast, { autoAlpha: 0, duration: 0.4 }, '+=2.2')
}

const copy = (text, ok) => navigator.clipboard.writeText(text).then(() => toast(ok), () => toast('复制失败：浏览器没有给剪贴板权限'))

const syncEnergy = () => {
  const all = [...live.values()]
  bg.energy = all.some((x) => x.turn.status === 'thinking') ? 1 : all.length ? 0.45 : 0
}

// ---------- 提问与生成 ----------

/** 一轮真正发给模型的文字 = 问题 + 文本附件的内容。 */
const promptOf = (t) => t.q + (t.files ?? []).filter((f) => f.text).map((f) => `\n\n[附件 ${f.name}]\n${f.text}`).join('')

/** 上下文 = 这一轮的祖先链 + 它引用的其他轮次。 */
function history(s, t) {
  const msgs = []
  for (let a = s.turns[t.parent]; a.parent; a = s.turns[a.parent]) msgs.unshift({ role: 'user', content: promptOf(a) }, { role: 'assistant', content: answerText(a) })
  const cited = t.refs.map((r) => state.sessions.find((x) => x.id === r.sid)?.turns[r.tid]).filter(Boolean).map((x) => `问：${x.q}\n答：${answerText(x)}`)
  if (cited.length) msgs.push({ role: 'user', content: `以下是我引用的其他对话片段，供参考：\n\n${cited.join('\n\n')}` }, { role: 'assistant', content: '好的，我会结合这些片段回答。' })
  return msgs
}

function ask(q, { s = current(), parentId = s.cursor, refs = [], files = [] } = {}) {
  const t = addTurn(s, parentId, q, refs)
  if (files?.length) t.files = files
  const r = $send.getBoundingClientRect()
  bg.splash(r.left + r.width / 2, r.top, true)
  refresh()
  run(s, t)
}

async function run(s, t) {
  const ctl = new AbortController(), t0 = performance.now()
  live.set(t.id, { ctl, turn: t })
  syncEnergy()
  try {
    for await (const ev of think(promptOf(t), history(s, t), ctl.signal)) {
      if (ev.type === 'think') t.think += ev.delta
      else {
        if (t.status === 'thinking') {
          t.status = 'answering'
          t.ms = performance.now() - t0
          syncEnergy()
        }
        const tail = t.blocks.at(-1)
        if (ev.type === 'block') t.blocks.push(ev.block)
        else if (tail?.type === 'text') tail.md += ev.delta
        else t.blocks.push({ type: 'text', md: ev.delta })
      }
      stage.update(t)
    }
    t.status = 'done'
  } catch (err) {
    t.status = err.name === 'AbortError' ? 'stopped' : 'error'
    if (t.status === 'error') t.blocks.push({ type: 'text', md: `**没能拿到回答**：${err.message}\n\n检查网络或模型配置后，点「重新生成」再试。` })
  }
  t.ms ||= performance.now() - t0
  live.delete(t.id)
  syncEnergy()
  stage.update(t)
  refresh() // 别的会话在后台答完，会话架上的"正在生成"也要熄掉
}

// ---------- 导航 ----------

function step(dir) {
  const s = current(), p = path(s)
  const i = p.findIndex((t) => t.id === s.cursor) + dir
  if (i < 0 || i >= p.length) return
  s.cursor = p[i].id
  refresh()
}

function fork(dir, t = current().turns[current().cursor]) {
  const s = current(), parent = s.turns[t?.parent]
  if (!parent || parent.children.length < 2) return
  const n = parent.children.length
  parent.pick = (parent.children.indexOf(t.id) + dir + n) % n
  s.cursor = parent.children[parent.pick]
  refresh()
}

function toLatest() {
  const s = current()
  s.cursor = path(s).at(-1)?.id ?? 'root'
  refresh()
}

function openSession(id) {
  state.current = id
  closeWall()
  refresh()
}

function createSession(group) {
  newSession('新会话', group) // 不传 = 留在当前分组
  closeWall()
  refresh()
  $q.focus()
}

const focusMode = (on = !document.body.classList.contains('focus')) => document.body.classList.toggle('focus', on) // 专注阅读：当前这轮撑满，上游叠层和时间轴让位

function exportSession() {
  const s = current()
  if (!path(s).length) return toast('这个会话还没有内容可导出')
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([toMarkdown(s)], { type: 'text/markdown' })), download: `${s.title}.md` })
  a.click()
  URL.revokeObjectURL(a.href)
  toast(`已导出 ${s.title}.md（当前支线的 ${path(s).length} 轮）`)
}

const stopCurrent = () => live.get(current().cursor)?.ctl.abort()

// ---------- 舞台上的点击（统一委托） ----------

$stage.addEventListener('click', async (e) => {
  const hit = (sel) => e.target.closest(sel)
  const s = current()
  const sceneOf = (el) => el.closest('.scene')
  const turnOf = (el) => s.turns[sceneOf(el).dataset.id]
  let el
  if ((el = hit('[data-suggest]'))) return ask(el.textContent)
  if ((el = hit('[data-fork]'))) return fork(+el.dataset.fork, turnOf(el))
  if ((el = hit('.scene.past'))) return (s.cursor = el.dataset.id), refresh() // 点上游的叠层 = 溯回那一轮
  if ((el = hit('[data-copycode]'))) return copy(el.nextElementSibling.textContent, '已复制代码')
  if ((el = hit('[data-jump]'))) return sceneOf(el).querySelectorAll('.answer h4')[el.dataset.jump].scrollIntoView({ behavior: 'smooth', block: 'start' })
  if ((el = hit('.note'))) return sceneOf(el).classList.toggle('askopen') // 长问题默认折叠到 3 行
  if ((el = hit('[data-tool]'))) {
    const t = turnOf(el), tool = el.dataset.tool
    if (tool === 'stop') live.get(t.id)?.ctl.abort()
    if (tool === 'focus') focusMode()
    if (tool === 'regen') ask(t.q, { parentId: t.parent, refs: t.refs, files: t.files }) // 重新生成 = 同一个问题的另一条支流，旧回答保留
    if (tool === 'copy') copy(answerText(t), '已复制回答')
    if (tool === 'edit') composer.edit(t)
    if (tool === 'ref') (composer.addRef({ sid: s.id, tid: t.id, q: t.q }), toast('已引用。可以切到任何支流或会话后再提问'))
    if (tool === 'up' || tool === 'down') {
      const v = tool === 'up' ? 1 : -1
      t.vote = t.vote === v ? 0 : v
      stage.update(t)
      save()
    }
    return
  }
  if ((el = hit('[data-act]'))) {
    // 业务动作：有副作用的先确认，结果写回块里（刷新后仍可见）
    const t = turnOf(el), [bi, ai] = el.dataset.act.split('.')
    const action = t.blocks[bi].items[ai]
    if (action.done || (action.confirm && !confirm(action.confirm))) return
    el.disabled = true
    try {
      action.done = await runAction(action)
      toast(action.done)
    } catch (err) {
      toast(`操作失败：${err.message}`)
    }
    stage.update(t)
    save()
  }
})
$('rail').addEventListener('click', (e) => {
  const el = e.target.closest('[data-go]')
  if (el) (current().cursor = el.dataset.go), refresh()
})
$('new-btn').onclick = () => createSession() // 固定在左上角，会话再多位置也不变
$('search-btn').onclick = openPalette
$('export-btn').onclick = exportSession

// ---------- 键盘 ----------

addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') return e.preventDefault(), openPalette()
  if ($('palette').open) return
  const typing = document.activeElement === $q
  if (e.key === 'Escape') {
    // 一层层退：会话墙 → 改写 → 专注 → 输入焦点 → 最后才是打开会话墙
    if (shelfOpen()) return closeWall()
    if (composer.cancelEdit()) return
    if (document.body.classList.contains('focus')) return focusMode(false)
    return typing ? $q.blur() : openWall(true)
  }
  if (e.target !== $q && e.target.matches?.('input, textarea, [contenteditable]')) return // 别的输入框（筛选、改名）里的按键不算快捷键
  if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
    const s = shelfList()[+e.code.slice(5) - 1]
    return s && (e.preventDefault(), openSession(s.id))
  }
  if (shelfOpen() || (typing && !e.altKey)) return // 输入时方向键归输入框；Alt+方向键仍可导航
  const nav = { ArrowUp: () => step(-1), ArrowDown: () => step(1), ArrowLeft: () => fork(-1), ArrowRight: () => fork(1) }[e.key]
  if (nav) return e.preventDefault(), nav()
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key.toLowerCase() === 'f') return focusMode()
  if (e.key.length === 1) $q.focus() // 不用先点输入框，直接打字
})

// 滚轮：当前轮内容还能滚就滚内容；滚到头之后要停一下再继续滚，才会溯回上一轮 / 回到下一轮
// （读长回答读到底时，不能因为多滚了一点就被带走）
let acc = 0, lastStep = 0, lastWheel = 0, lastRead = 0
$stage.addEventListener('wheel', (e) => {
  const now = performance.now()
  const body = e.target.closest('.scene.cur .body')
  if (body && (e.deltaY < 0 ? body.scrollTop > 0 : body.scrollTop + body.clientHeight < body.scrollHeight - 1)) return (lastRead = now), (acc = 0)
  if (now - lastRead < 500) return (lastRead = now) // 惯性滚动还没停
  if (now - lastWheel > 200) acc = 0
  lastWheel = now
  acc += e.deltaY
  if (Math.abs(acc) > 100 && now - lastStep > 450) {
    step(Math.sign(acc))
    acc = 0
    lastStep = now
  }
}, { passive: true })

// ---------- 鼠标 ----------

addEventListener('pointermove', (e) => {
  // 视差：上游各层按深度错开一点
  $stage.style.setProperty('--px', (e.clientX / innerWidth - 0.5).toFixed(3))
  $stage.style.setProperty('--py', (e.clientY / innerHeight - 0.5).toFixed(3))
  // 聚光：稿纸和会话卡表面、边缘的高光跟着鼠标走
  const card = e.target.closest?.('.scene.cur .sheet, .wcard')
  if (card) {
    const r = card.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top
    card.style.setProperty('--mx', `${x}px`)
    card.style.setProperty('--my', `${y}px`)
  }
  // 磁吸：鼠标靠近发送按钮时，按钮朝它凑过来
  const r = $send.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2)
  $send.style.translate = Math.hypot(dx, dy) < 80 ? `${dx * 0.28}px ${dy * 0.28}px` : ''
})
addEventListener('pointerdown', (e) => bg.splash(e.clientX, e.clientY)) // 点哪里，哪里的水溅起来

// ---------- 组装 ----------

initShelf({ pick: openSession, create: createSession, changed: refresh })
composer.init({
  toast, toLatest,
  stop: stopCurrent,
  submit({ text, refs, files, editing }) {
    // 改写 = 在原问题旁边长出一条新支流；否则从当前看到的这一轮往下问
    ask(text, editing ? { parentId: editing.parent, refs: refs.length ? refs : editing.refs, files } : { refs, files })
  },
  commands: [
    { name: '新会话', hint: '在当前分组里开一个新会话', run: () => createSession() },
    { name: '搜索', hint: '跨所有会话搜问题和回答 · ⌘K', run: openPalette },
    { name: '全部会话', hint: '按分组和时间铺开所有会话 · Esc', run: () => openWall(true) },
    { name: '背景', hint: '切换背景场景：河流 / 星空 / 鲸鱼', run: () => toast(`背景：${bg.setScene()}`) },
    { name: '特效', hint: '切换 AI 回答时的背景特效：环绕 / 漩涡', run: () => toast(`回答特效：${bg.setEffect()}`) },
    { name: '专注', hint: '专注阅读当前这轮 · F', run: () => focusMode() },
    { name: '导出', hint: '把当前支线导出为 Markdown', run: exportSession },
    { name: '回到最新', hint: '跳到这条支线的最后一轮', run: toLatest },
    { name: '停止', hint: '停止当前这轮的生成', run: stopCurrent },
  ],
})
initPalette((r) => {
  if (!r.s) return createSession()
  state.current = r.s.id
  if (r.t) reveal(r.s, r.t.id)
  closeWall()
  refresh()
})
refresh()
