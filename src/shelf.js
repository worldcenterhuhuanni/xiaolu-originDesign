// 会话架：顶部一排带名字的会话标签，鼠标移上去，下面就升起一个三维场景——所有分组和会话。
//   沿用主舞台的语言（卡片向纵深叠层），只是高了一层：
//     每个分组是一叠卡片：最新的会话在最前，越旧越往深处退，露出带标题和时间的顶沿
//     分组之间是 Cover Flow：当前分组正对你，其余向两侧转开、退远
//   操作：滚轮纵向 / ↑↓ = 沿时间往深处翻；滚轮横向 / ←→ / 点侧面那叠 / 点底部的名字 = 换分组；点卡片 = 打开会话
//   第一叠「最近」跨所有分组按时间排（= 传统侧边栏）；最后一叠虚线的是「新建分组」。分组数量不限。
//   把会话拖到另一叠或底部的名字上 = 换分组；最前面那张卡上有：移组、置顶、改名、派生、归档、删除
//   用 CSS 3D 而不是把文字画进 WebGL：文字清晰，改名、拖拽、下拉这些原生交互都还在
import gsap from 'gsap'
import { state, path, save, THEMES, themeOf, removeSession, cloneSession, archive, shelfList, groupOf, addGroup, removeGroup, bucketOf, BUCKETS, isLive, gistOf } from './store.js'
import { esc } from './blocks.js'

const $shelf = document.getElementById('shelf')
const $row = document.getElementById('shelf-row')
const $wall = document.getElementById('wall')
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const vars = (t) => `--bh:${t.h * 360};--bh2:${t.h2 * 360};--bs:${t.sat}`
const busy = (s) => Object.values(s.turns).some(isLive)
const find = (id) => state.sessions.find((x) => x.id === id)
const gname = (s) => groupOf(s)?.name ?? '未分组'
const LABEL = Object.fromEntries(BUCKETS)
const RANGE = { '': null, today: ['today'], week: ['today', 'yesterday', 'week'], month: ['today', 'yesterday', 'week', 'month'] }
const STEP = 30, DEEP = 6 // 每往深处一张：上移 30px（正好露出顶沿）；正对的那叠最多看见 6 条顶沿，侧面的只留 2 条
// book：正对着的是哪一叠；fronts：每一叠翻到了第几张
let h, $flow, $pills, open = false, pinned = false, timer, filter = '', range = '', book = 'recent', fronts = {}, archived = false, dragId = null

export const shelfOpen = () => open

export function renderShelf() {
  const list = shelfList()
  $row.innerHTML = list.map((s, i) => {
    const cur = s.id === state.current
    return `<button class="tab${cur ? ' cur' : ''}${busy(s) ? ' live' : ''}" data-sid="${s.id}" style="${vars(themeOf(s))}" title="${esc(s.title)} · ${esc(gname(s))}${i < 9 ? ` · Alt+${i + 1}` : ''}" ${cur ? 'aria-current="true"' : ''}><i class="orb"></i><span>${esc(s.title)}</span></button>`
  }).join('') + `<button class="more" data-wall aria-expanded="${open}">全部 ${list.length}</button>`
  fit()
  if (open) drawWall()
}

/** 一排放不下时，只隐藏放不下的那些（当前会话永远保留），不滚动也不压缩。 */
function fit() {
  const tabs = [...$row.querySelectorAll('.tab')]
  const room = Math.min(920, innerWidth - 420) - $row.lastElementChild.offsetWidth
  let used = 0, cut = tabs.length
  tabs.forEach((t) => (t.hidden = false))
  for (let i = 0; i < tabs.length; i++) if ((used += tabs[i].offsetWidth + 6) > room) { cut = i; break }
  tabs.forEach((t, i) => (t.hidden = i >= cut))
  const cur = tabs.findIndex((t) => t.classList.contains('cur'))
  if (cur >= cut && cut > 0) (tabs[cut - 1].hidden = true), (tabs[cur].hidden = false)
}

/** 一张会话卡。顶沿（标题 + 时间）在叠层里始终露着；下面的内容只有翻到最前时看得见。tag：这一段时间的第一张才写段名。 */
function card(s, tag, now) {
  const last = path(s).at(-1), d = new Date(s.at)
  const time = now - s.at < 864e5 && d.getDate() === new Date(now).getDate() ? d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : `${d.getMonth() + 1}/${d.getDate()}`
  return `<article class="wcard${s.id === state.current ? ' cur' : ''}" data-sid="${s.id}" style="${vars(themeOf(s))}" draggable="true" tabindex="0" role="button" aria-label="打开会话 ${esc(s.title)}">
    <header><i class="orb"></i><h3>${esc(s.title)}</h3>${busy(s) ? '<b class="wlive" title="正在生成"></b>' : ''}<time>${tag ? `<b>${tag}</b>` : ''}${time}</time></header>
    ${last ? `<p class="wq">${esc(last.q)}</p><p class="wa">${esc(gistOf(last, 110)) || '…'}</p>` : '<p class="wa">还没有提问</p>'}
    <footer>
      <label class="wmove" title="移到分组"><select data-move aria-label="移到分组"><option value="">未分组</option>${state.groups.map((g) => `<option value="${g.id}"${g.id === s.group ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}<option value="+">＋ 新建分组…</option></select></label>
      ${s.archived ? '' : `<button data-pin>${s.pin ? '取消置顶' : '置顶'}</button>`}<button data-rename>改名</button><button data-clone title="整个会话复制一份，从副本上继续">派生</button><button data-arch>${s.archived ? '恢复' : '归档'}</button><button data-del>删除</button>
    </footer>
  </article>`
}

function drawWall() {
  const q = filter.trim().toLowerCase(), now = Date.now()
  const hay = (s) => [s.title, gname(s), ...path(s).map((t) => t.q)].join(' ').toLowerCase()
  const age = new Map(state.sessions.map((s) => [s, bucketOf({ at: s.at }, now)])) // 不看置顶的纯时间段
  const nArch = state.sessions.filter((s) => s.archived).length
  if (!nArch) archived = false
  const list = state.sessions.filter((s) => !!s.archived === archived && (!q || hay(s).includes(q)) && (!RANGE[range] || RANGE[range].includes(age.get(s))))
  const loose = list.some((s) => !groupOf(s))
  const all = ['recent', ...state.groups, ...(loose ? [null] : [])]
  const idOf = (g) => (g === 'recent' ? 'recent' : g?.id ?? 'none')
  if (q || !all.some((g) => idOf(g) === book)) book = 'recent' // 筛选结果跨分组，统一在「最近」里看

  const info = all.map((g) => {
    const id = idOf(g), real = g && g !== 'recent'
    // 叠放顺序：置顶在最前，其余按最近更新
    const mine = (g === 'recent' ? list : list.filter((s) => (groupOf(s)?.id ?? 'none') === id)).sort((a, b) => !!b.pin - !!a.pin || b.at - a.at)
    return { id, real, mine, name: g === 'recent' ? '最近' : g?.name ?? '未分组', theme: g === 'recent' ? themeOf(find(state.current)) : THEMES[g?.theme ?? 7] }
  })
  const stack = ({ id, real, mine, name, theme }) => {
    let prev
    const cards = mine.map((s) => {
      const k = s.pin ? 'pin' : age.get(s), tag = k !== prev ? LABEL[k] : ''
      prev = k
      return card(s, tag, now)
    }).join('')
    const none = q ? '没有匹配的会话' : range ? '这个时间范围里没有会话' : archived ? '没有归档的会话' : real ? '这个分组还是空的<small>把会话拖到这里，或点下面的「＋ 会话」</small>' : '还没有会话'
    return `<section class="stack" data-book="${id}" style="${vars(theme)}">
      <div class="pile">${cards || `<p class="wempty">${none}</p>`}</div>
      <header class="cap">
        ${real ? '<button class="orb" data-hue title="换一种水色" aria-label="给这个分组换一种水色"></button>' : '<i class="orb"></i>'}
        <h4 ${real ? 'data-gname title="点击改名"' : ''}>${esc(name)}</h4><small>${mine.length}</small>
        <nav><button data-new-in title="${id === 'recent' ? '在当前分组里新建会话' : '在这个分组里新建会话'}">＋ 会话</button>${real ? '<button data-grename>改名</button><button data-gdel title="解散分组，里面的会话不会被删除">删除</button>' : ''}</nav>
      </header>
    </section>`
  }
  $wall.querySelector('[data-archview]').textContent = archived ? '← 返回' : `已归档 ${nArch}`
  $wall.querySelector('[data-archview]').hidden = !nArch
  $wall.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.range === range))
  $flow.innerHTML = info.map(stack).join('') +
    (archived ? '' : '<section class="stack newg" data-book="new" data-newgroup role="button" tabindex="0" aria-label="新建分组"><div class="pile"><p class="wempty"><b>＋</b>新建分组<small>点一下，或把会话拖到这里</small></p></div></section>')
  $pills.innerHTML = info.map(({ id, name, mine, theme }) => `<button class="pill" data-book="${id}" style="${vars(theme)}"><i class="orb"></i>${esc(name)}<small>${mine.length}</small></button>`).join('') +
    (archived ? '' : '<button class="pill add" data-book="new" data-newgroup title="新建分组"><b>＋</b>新建分组</button>')
  layout(true)
}

/** 把每一叠、每一张卡摆到它在三维空间里的位置。instant：重建内容后直接就位，不做过渡。 */
function layout(instant) {
  const stacks = [...$flow.children], dur = instant || calm ? 0 : 0.75
  const fi = Math.max(0, stacks.findIndex((el) => el.dataset.book === book))
  const first = Math.min(392, innerWidth * 0.29), gap = Math.min(168, innerWidth / 8.5) // 第一叠侧面的紧挨着中间那叠，再往外依次收拢
  stacks.forEach((el, i) => {
    const d = i - fi, a = Math.abs(d), sign = Math.sign(d)
    el.classList.toggle('front', d === 0)
    el.style.zIndex = 100 - a
    // 正对的那叠在原位；两侧的依次排开、后退，并朝中间转过来
    gsap.to(el, { x: sign * (first + (a - 1) * gap), z: a ? -230 - (a - 1) * 110 : 0, rotationY: -sign * 46, autoAlpha: a > 3 ? 0 : 1, duration: dur, ease: 'power3.out', overwrite: 'auto' })
    const cards = el.querySelectorAll('.wcard'), f = (fronts[el.dataset.book] = Math.min(fronts[el.dataset.book] ?? 0, Math.max(0, cards.length - 1)))
    cards.forEach((c, j) => {
      const k = j - f
      c.classList.toggle('top', k === 0)
      c.style.zIndex = 50 - Math.abs(k)
      c.style.setProperty('--k', Math.max(0, k))
      // k>0 更旧：往深处、往上退，露出顶沿；k<0 已经翻过去的：迎面飞出镜头
      gsap.to(c, k < 0 ? { y: 120, z: 200, autoAlpha: 0, duration: dur, ease: 'power3.out', overwrite: 'auto' }
        : { y: -STEP * k, z: -78 * k, autoAlpha: k > (a ? 2 : DEEP) ? 0 : 1, duration: dur, ease: 'power3.out', overwrite: 'auto' })
    })
  })
  for (const p of $pills.children) p.classList.toggle('on', p.dataset.book === book)
  $pills.querySelector('.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/** 转到某一叠 / 相邻的一叠。 */
function turnTo(id) {
  book = id
  layout()
}
function turnBy(dir) {
  const ids = [...$flow.children].map((el) => el.dataset.book).filter((id) => id !== 'new')
  turnTo(ids[Math.max(0, Math.min(ids.length - 1, ids.indexOf(book) + dir))])
}
/** 在正对的那一叠里沿时间翻：dir=1 往更旧，-1 往回。 */
function dive(dir) {
  fronts[book] = Math.max(0, (fronts[book] ?? 0) + dir)
  layout()
}

export function openWall(pin = false) {
  clearTimeout(timer)
  pinned ||= pin
  if (!open) {
    open = true
    filter = $wall.querySelector('.wfilter').value = ''
    range = ''
    fronts = {}
    archived = false
    book = groupOf(find(state.current) ?? {})?.id ?? 'recent' // 从你正在用的那个分组开始看
    drawWall()
    $wall.classList.add('on')
    document.body.classList.add('shelf-open')
    $row.lastElementChild.setAttribute('aria-expanded', 'true')
    // 一叠叠从深处升上来
    if (!calm) gsap.from($flow.children, { y: 140, z: '-=420', duration: 0.8, ease: 'power3.out', stagger: { each: 0.05, from: 'center' } })
  }
  if (pin) $wall.querySelector('.wfilter').focus()
}

export function closeWall() {
  clearTimeout(timer)
  if (!open) return
  open = pinned = false
  $wall.classList.remove('on')
  document.body.classList.remove('shelf-open')
  $row.lastElementChild?.setAttribute('aria-expanded', 'false')
  if ($wall.contains(document.activeElement)) document.activeElement.blur()
}

/** 就地改名（会话名、分组名共用）：回车或失焦保存，Esc 放弃。 */
function editText(el, max, commit) {
  el.contentEditable = 'plaintext-only'
  el.focus()
  getSelection().selectAllChildren(el)
  const done = (keep) => {
    el.removeEventListener('blur', onBlur)
    const text = el.textContent.trim().slice(0, max)
    if (keep && text) commit(text)
    save()
    h.changed()
  }
  const onBlur = () => done(true)
  el.addEventListener('blur', onBlur)
  el.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter' && !e.isComposing) (e.preventDefault(), done(true))
    if (e.key === 'Escape') done(false)
  })
}

export function initShelf(handlers) {
  h = handlers
  $wall.innerHTML = `<div class="wbar"><input class="wfilter" placeholder="筛选：输入会话名、分组名或问过的话…" aria-label="筛选会话" />
      <span class="wrange" role="group" aria-label="时间范围">${[['', '全部时间'], ['today', '今天'], ['week', '7 天内'], ['month', '30 天内']].map(([k, t]) => `<button data-range="${k}">${t}</button>`).join('')}</span>
      <button data-archview hidden></button></div>
    <div class="flow"></div>
    <nav class="pills" aria-label="分组"></nav>
    <p class="whint">滚轮上下：沿时间往深处翻　·　左右：换分组　·　点卡片打开　·　把会话拖到另一叠就是换分组</p>`
  $flow = $wall.querySelector('.flow')
  $pills = $wall.querySelector('.pills')
  const redraw = () => (save(), h.changed())
  /** 新建分组后立刻转到它并进入改名状态：名字是建组时唯一要想的事。s：顺手放进去的会话。 */
  const createGroup = (s, g = addGroup()) => {
    if (s) s.group = g.id
    book = g.id
    redraw()
    editText($flow.querySelector(`.stack[data-book="${g.id}"] h4`), 16, (text) => (g.name = text))
  }
  let fresh = null // 拖到「新建分组」上建出来的组：松手后再进入改名

  // 悬停展开：稍等一下再开，避免鼠标路过就弹；鼠标离开场景和顶栏（比如回到下面的输入台）稍等一下再收
  const leave = (e) => {
    clearTimeout(timer)
    if ($shelf.contains(e.relatedTarget) || $wall.contains(e.relatedTarget)) return
    if (open && !pinned) timer = setTimeout(() => !dragId && !$wall.contains(document.activeElement) && closeWall(), 320)
  }
  $shelf.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && (clearTimeout(timer), !open && (timer = setTimeout(openWall, 170))))
  $wall.addEventListener('pointerenter', () => clearTimeout(timer))
  $shelf.addEventListener('pointerleave', leave)
  $wall.addEventListener('pointerleave', leave)
  addEventListener('pointerdown', (e) => open && !$shelf.contains(e.target) && !$wall.contains(e.target) && closeWall())

  const click = (e) => {
    const hit = (sel) => e.target.closest(sel)
    let el
    if (hit('#wall')) pinned = true // 在里面点过东西 = 正在操作：之后鼠标挪开也不自动收起
    if (e.target.isContentEditable || hit('.wfilter, .wmove')) return
    if (hit('[data-wall]')) return open && pinned ? closeWall() : openWall(true)
    if (hit('[data-archview]')) return (archived = !archived), (fronts = {}), drawWall()
    if ((el = hit('[data-range]'))) return (range = el.dataset.range), (fronts = {}), drawWall()
    if (hit('[data-newgroup]')) return createGroup()
    if ((el = hit('.pill'))) return turnTo(el.dataset.book)
    if (e.target === $wall || e.target === $flow) return closeWall() // 点空白处 = 离开
    const st = hit('.stack')
    if (st && st.dataset.book !== book) return turnTo(st.dataset.book) // 侧面的那叠：先转过来

    // 这一叠下面的题签：分组自己的操作
    if (hit('.cap')) {
      const id = st.dataset.book, g = state.groups.find((x) => x.id === id)
      if (hit('[data-new-in]')) return closeWall(), h.create(id === 'recent' ? undefined : g?.id ?? null)
      if (hit('[data-hue]')) return (g.theme = (g.theme + 1) % THEMES.length), redraw()
      if (hit('[data-grename], [data-gname]')) return editText(st.querySelector('h4'), 16, (text) => (g.name = text))
      if (hit('[data-gdel]')) {
        const n = state.sessions.filter((s) => s.group === id).length
        if (n && !confirm(`删除分组「${g.name}」？里面的 ${n} 个会话不会被删除，会回到「未分组」。`)) return
        return removeGroup(id), redraw()
      }
      return
    }

    if (!(el = hit('[data-sid]'))) return
    const s = find(el.dataset.sid)
    if (hit('[data-pin]')) return (s.pin = !s.pin), redraw()
    if (hit('[data-arch]')) return archive(s, !s.archived), redraw()
    if (hit('[data-clone]')) return cloneSession(s), closeWall(), redraw()
    if (hit('[data-rename]')) return (el.draggable = false), editText(el.querySelector('h3'), 40, (text) => (s.title = text))
    if (hit('[data-del]')) {
      if (!confirm(`删除会话「${s.title}」？其中的所有轮次和支流都会一起删除，无法恢复。`)) return
      removeSession(s.id)
      return redraw()
    }
    closeWall()
    if (s.id !== state.current) h.pick(s.id)
  }
  $shelf.addEventListener('click', click)
  $wall.addEventListener('click', click)

  $wall.addEventListener('input', (e) => e.target.matches('.wfilter') && ((filter = e.target.value), (fronts = {}), drawWall()))
  // 卡片上的"移到分组"下拉：键盘和触屏不用拖也能换组
  $wall.addEventListener('change', (e) => {
    if (!e.target.matches('[data-move]')) return
    const s = find(e.target.closest('[data-sid]').dataset.sid), v = e.target.value
    if (v === '+') return createGroup(s)
    s.group = v || null
    redraw()
  })

  // 滚轮：纵向沿时间翻，横向换分组。攒够一段距离才走一步，触控板的惯性不会一下翻到底
  let acc = 0, axis = ''
  $wall.addEventListener('wheel', (e) => {
    if (e.target.closest('.wbar, select, [contenteditable]')) return
    e.preventDefault()
    const ax = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? 'x' : 'y', v = ax === 'x' ? e.deltaX : e.deltaY
    if (ax !== axis) (acc = 0), (axis = ax)
    if (Math.abs((acc += v)) < 50) return
    ax === 'x' ? turnBy(Math.sign(acc)) : dive(Math.sign(acc))
    acc = 0
  }, { passive: false })

  addEventListener('keydown', (e) => {
    if (!open || e.isComposing) return
    const typing = e.target.matches?.('input, textarea, select, [contenteditable]')
    if (e.key === 'Enter') {
      // 筛选后回车 = 打开最前面那张；卡片 / 新建分组 上回车 = 点它
      const target = e.target.matches?.('.wfilter') ? $flow.querySelector('.stack.front .wcard.top') : e.target.matches?.('.wcard, .stack.newg') && e.target
      return target && target.click()
    }
    if (typing) return
    const nav = { ArrowLeft: () => turnBy(-1), ArrowRight: () => turnBy(1), ArrowDown: () => dive(1), ArrowUp: () => dive(-1) }[e.key]
    if (nav) (e.preventDefault(), nav())
  })
  // Tab 到叠在后面的卡片时，把它翻到最前，键盘用户看得见自己在哪
  $flow.addEventListener('focusin', (e) => {
    const c = e.target.closest?.('.wcard'), st = c?.closest('.stack')
    if (!c || c !== e.target || c.classList.contains('top') || st.dataset.book !== book) return
    fronts[book] = [...st.querySelectorAll('.wcard')].indexOf(c)
    layout()
  })

  // 拖放：落在哪一叠（或底部哪个名字）上就归哪个分组；落在「新建分组」上 = 建一个新组并放进去；「最近」不是分组，不接收
  const mark = (el) => ($wall.querySelector('.over')?.classList.remove('over'), el?.classList.add('over'))
  $wall.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.wcard[data-sid]')
    if (!c) return
    dragId = c.dataset.sid
    e.dataTransfer.setData('text/plain', dragId)
    e.dataTransfer.effectAllowed = 'move'
  })
  $wall.addEventListener('dragover', (e) => {
    const b = dragId && e.target.closest('[data-book]')
    if (!b || b.dataset.book === 'recent') return mark(null)
    e.preventDefault()
    mark(b)
  })
  $wall.addEventListener('drop', (e) => {
    const to = e.target.closest('[data-book]')?.dataset.book, s = find(dragId)
    if (!to || to === 'recent' || !s) return
    e.preventDefault()
    s.group = to === 'none' ? null : to === 'new' ? (fresh = addGroup()).id : to
    book = s.group ?? 'none' // 松手后转到目标那一叠，让人看见它确实进去了
    fronts[book] = 0
  })
  $wall.addEventListener('dragend', () => {
    dragId = null
    mark(null)
    fresh ? createGroup(null, fresh) : redraw()
    fresh = null
  })
  addEventListener('resize', () => (fit(), open && layout(true)))
}
