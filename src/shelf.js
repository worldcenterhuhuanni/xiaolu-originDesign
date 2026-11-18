// 会话架：顶部一排带名字的会话标签，鼠标移上去就向下展开成"全部会话"。
//   侧边栏只有一列，分了时间就看不出分组，分了组就看不出时间。这里两个维度各是一个开关（左上角）：
//     「时间」开 = 横向分列：置顶 / 今天 / 昨天 / 7 天内 / 30 天内 / 更早（点列头 = 只看这一段）
//     「分组」开 = 纵向分行：每个分组一行，带自己的水色（点组名 = 只看这一组）
//     两个都开就是一张"分组 × 时间"的表；只开一个就是普通的按时间 / 按分组列表
//   分组数量不限。最后一行永远是「＋ 新建分组」；每个分组头上直接有：新会话、改名、换色、删除（删除只解散，不删会话）
//   卡片：拖到别的分组 = 移过去，拖到「置顶」列 = 置顶；悬停展开摘要和操作（置顶、移到分组、改名、派生、归档、删除）
//   悬停即展开、移开即收起；点「全部」、按 Esc、或在里面点过任何东西则固定展开
import gsap from 'gsap'
import { state, path, save, THEMES, themeOf, removeSession, cloneSession, archive, shelfList, groupOf, addGroup, removeGroup, bucketOf, BUCKETS, isLive, gistOf } from './store.js'
import { esc } from './blocks.js'

const $shelf = document.getElementById('shelf')
const $row = document.getElementById('shelf-row')
const $wall = document.getElementById('wall')
const calm = matchMedia('(prefers-reduced-motion: reduce)').matches
const vars = (t) => `--bh:${t.h * 360};--bh2:${t.h2 * 360};--bs:${t.sat}`
const when = (ms) => new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const busy = (s) => Object.values(s.turns).some(isLive)
const find = (id) => state.sessions.find((x) => x.id === id)
const gname = (s) => groupOf(s)?.name ?? '未分组'
let h, $map, open = false, pinned = false, timer, filter = '', lens = null, only = null, archived = false, dragId = null // lens/only：只看某个时间段/某个分组

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

function card(s) {
  const p = path(s), last = p.at(-1)
  const forks = Object.values(s.turns).filter((t) => t.id !== 'root' && t.children.length > 1).length
  return `<article class="wcard${s.id === state.current ? ' cur' : ''}" data-sid="${s.id}" style="${vars(themeOf(s))}" draggable="true" tabindex="0" role="button" aria-label="打开会话 ${esc(s.title)}">
    <header><i class="orb"></i><h3>${esc(s.title)}</h3>${busy(s) ? '<b class="wlive" title="正在生成"></b>' : ''}</header>
    ${last ? `<p class="wq">${esc(last.q)}</p>` : ''}
    <small class="wg">${esc(gname(s))} · ${when(s.at)}</small>
    <div class="wx">
      <p class="wa">${last ? esc(gistOf(last, 96)) || '…' : '还没有提问'}</p>
      <small>${p.length} 轮${forks ? ` · ${forks} 处分叉` : ''} · ${when(s.at)}</small>
      <label class="wmove">分组<select data-move aria-label="移到分组"><option value="">未分组</option>${state.groups.map((g) => `<option value="${g.id}"${g.id === s.group ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}<option value="+">＋ 新建分组…</option></select></label>
      <footer>
        ${s.archived ? '' : `<button data-pin>${s.pin ? '取消置顶' : '置顶'}</button>`}<button data-rename>改名</button><button data-clone title="整个会话复制一份，从副本上继续">派生</button><button data-arch>${s.archived ? '恢复' : '归档'}</button><button data-del>删除</button>
      </footer>
    </div>
  </article>`
}

function drawWall() {
  const q = filter.trim().toLowerCase(), now = Date.now(), ax = state.axes
  const hay = (s) => [s.title, gname(s), ...path(s).map((t) => t.q)].join(' ').toLowerCase()
  const nArch = state.sessions.filter((s) => s.archived).length
  if (!nArch) archived = false
  if (only && only !== 'none' && !state.groups.some((g) => g.id === only)) only = null
  const list = state.sessions.filter((s) => !!s.archived === archived && (!q || hay(s).includes(q))).sort((a, b) => b.at - a.at)
  const by = new Map(list.map((s) => [s, bucketOf(s, now)]))
  if (lens && ![...by.values()].includes(lens)) lens = null
  // 没有会话的时间段不占列；「置顶」列常驻，它同时是拖放目标。关掉「时间」就只剩一列
  const cols = !ax.t ? [['all', '全部']] : BUCKETS.filter(([k]) => (lens ? k === lens : (k === 'pin' && !archived) || list.some((s) => by.get(s) === k)))
  const cells = (mine) => cols.map(([k, label]) => `<div class="cell" data-b="${k}" data-label="${label}">${mine.filter((s) => k === 'all' || by.get(s) === k).map(card).join('')}</div>`).join('')
  const curGroup = find(state.current)?.group ?? 'none'

  // 一行 = 一个分组。g 为 null 是"未分组"那一行：没有改名/换色/删除，只在有会话或正在拖动时出现
  const lane = (g) => {
    const id = g?.id ?? 'none', mine = list.filter((s) => (s.group ?? 'none') === id || (g === null && !groupOf(s))), folded = state.folded.includes(id)
    return `<section class="lane${mine.length || (g && !q) ? '' : ' empty'}${g ? '' : ' loose'}${id === curGroup ? ' cur' : ''}" data-lane="${id}" style="${vars(THEMES[g?.theme ?? 7])}">
      <header>
        <div><button data-fold aria-expanded="${!folded}" aria-label="${folded ? '展开' : '折叠'}分组">▸</button>${g ? `<button class="orb" data-hue title="换一种水色" aria-label="给这个分组换一种水色"></button>` : '<i class="orb"></i>'}
          <h4 data-gname class="${only === id ? 'on' : ''}" title="${only === id ? '显示全部分组' : '只看这一组'}">${esc(g?.name ?? '未分组')}</h4><small>${mine.length}</small></div>
        <nav><button data-new-in title="在这个分组里新建会话">＋ 会话</button>${g ? '<button data-grename>改名</button><button data-gdel title="解散分组，里面的会话不会被删除">删除</button>' : ''}</nav>
      </header>
      ${folded ? `<p class="wfold" style="grid-column: 2 / -1">${mine.map((s) => esc(s.title)).join('　·　') || '空'}</p>` : cells(mine)}
    </section>`
  }
  const lanes = !ax.g ? `<section class="lane flat" data-lane="all" style="${vars(themeOf(find(state.current)))}"><header><div><i class="orb"></i><h4>全部会话</h4><small>${list.length}</small></div></header>${cells(list)}</section>`
    : [...state.groups, null].filter((g) => !only || (g?.id ?? 'none') === only).map(lane).join('') +
      (archived || only ? '' : `<button class="lane newg" data-lane="new" data-newgroup><b>＋</b> 新建分组<small>点一下新建，或把会话直接拖到这里</small></button>`)

  $wall.querySelector('[data-archview]').textContent = archived ? '← 返回' : `已归档 ${nArch}`
  $wall.querySelector('[data-archview]').hidden = !nArch
  $wall.querySelector('[data-reset]').hidden = !lens && !only
  $map.className = `wmap${!ax.t || lens ? ' wrap' : ''}${ax.g ? '' : ' nog'}`
  $map.style.setProperty('--n', cols.length)
  const n = (k) => list.filter((s) => by.get(s) === k).length
  $map.innerHTML = `<div class="whead">
      <span class="axes" role="group" aria-label="视图维度"><button data-axis="g" aria-pressed="${ax.g}" title="按分组分行：${ax.g ? '点击关闭' : '点击打开'}">分组 ↓</button><button data-axis="t" aria-pressed="${ax.t}" title="按时间分列：${ax.t ? '点击关闭' : '点击打开'}">时间 →</button></span>
      ${ax.t ? cols.map(([k, label]) => `<button data-lens="${k}" class="${lens === k ? 'on' : ''}" aria-pressed="${lens === k}" title="${lens === k ? '回到全部时间' : `只看「${label}」`}">${label}<small>${n(k)}</small></button>`).join('') : '<em>按最近更新排列</em>'}
    </div>${lanes}${list.length ? '' : `<p class="wnone">${q ? '没有匹配的会话' : archived ? '没有归档的会话' : '还没有会话'}</p>`}`
}

export function openWall(pin = false) {
  clearTimeout(timer)
  pinned ||= pin
  if (!open) {
    open = true
    filter = $wall.querySelector('.wfilter').value = ''
    lens = only = null
    archived = false
    drawWall()
    $wall.classList.add('on')
    document.body.classList.add('shelf-open')
    $row.lastElementChild.setAttribute('aria-expanded', 'true')
    if (!calm) gsap.fromTo($wall.querySelectorAll('.wcard'), { autoAlpha: 0, x: -14 }, { autoAlpha: 1, x: 0, duration: 0.35, ease: 'power3.out', stagger: 0.015, clearProps: 'transform' })
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
  $wall.innerHTML = `<div class="wbar"><input class="wfilter" placeholder="筛选：输入会话名、分组名或问过的话…" aria-label="筛选会话" /><button data-newgroup class="wnew"><b>＋</b> 新建分组</button><button data-reset hidden>显示全部</button><button data-archview hidden></button></div>
    <p class="whint">点左上角的 <b>分组</b>、<b>时间</b> 可以开关这一维度　·　点时间或组名：只看这一部分　·　拖动卡片：换分组或置顶</p><div class="wmap"></div>`
  $map = $wall.lastElementChild
  const redraw = () => (save(), h.changed())
  /** 新建分组后立刻进入改名状态：名字是建组时唯一要想的事。 */
  const createGroup = (s, g = addGroup()) => {
    if (s) s.group = g.id
    redraw()
    const el = $map.querySelector(`.lane[data-lane="${g.id}"] h4`)
    el.scrollIntoView({ block: 'nearest' })
    editText(el, 16, (text) => (g.name = text))
  }
  let fresh = null // 拖到「新建分组」上建出来的组：松手后再进入改名

  // 悬停展开：稍等一下再开，避免鼠标路过就弹；移开稍等一下再收，给跨越缝隙留时间
  $shelf.addEventListener('pointerenter', (e) => e.pointerType === 'mouse' && !open && (timer = setTimeout(openWall, 170)))
  $shelf.addEventListener('pointerleave', () => {
    clearTimeout(timer)
    if (open && !pinned) timer = setTimeout(() => !dragId && !$wall.contains(document.activeElement) && closeWall(), 280)
  })
  addEventListener('pointerdown', (e) => open && !$shelf.contains(e.target) && closeWall())

  $shelf.addEventListener('click', (e) => {
    const hit = (sel) => e.target.closest(sel)
    let el
    if (hit('#wall')) pinned = true // 在里面点过东西 = 正在操作：之后内容增减把鼠标晾在外面也不自动收起
    if (e.target.isContentEditable || hit('.wfilter, .wmove')) return
    if (hit('[data-wall]')) return open && pinned ? closeWall() : openWall(true)
    if (hit('[data-archview]')) return (archived = !archived), drawWall()
    if (hit('[data-reset]')) return (lens = only = null), drawWall()
    if ((el = hit('[data-lens]'))) return (lens = lens === el.dataset.lens ? null : el.dataset.lens), drawWall()
    if ((el = hit('[data-axis]'))) {
      // 两个维度至少开一个：关掉仅剩的那个时，自动换成另一个
      const k = el.dataset.axis, ax = state.axes, other = k === 'g' ? 't' : 'g'
      ax[k] = !ax[k]
      if (!ax[k] && !ax[other]) ax[other] = true
      lens = only = null
      return redraw()
    }
    if (hit('[data-newgroup]')) return createGroup()

    // 分组头上的操作
    if ((el = hit('.lane > header'))) {
      const id = el.parentElement.dataset.lane, g = state.groups.find((x) => x.id === id)
      if (hit('[data-new-in]')) return closeWall(), h.create(g?.id ?? null)
      if (hit('[data-fold]')) return (state.folded = state.folded.includes(id) ? state.folded.filter((x) => x !== id) : [...state.folded, id]), redraw()
      if (hit('[data-hue]')) return (g.theme = (g.theme + 1) % THEMES.length), redraw()
      if (hit('[data-grename]')) return editText(el.querySelector('h4'), 16, (text) => (g.name = text))
      if (hit('[data-gdel]')) {
        const n = state.sessions.filter((s) => s.group === id).length
        if (n && !confirm(`删除分组「${g.name}」？里面的 ${n} 个会话不会被删除，会回到「未分组」。`)) return
        return removeGroup(id), redraw()
      }
      if (hit('[data-gname]')) return (only = only === id ? null : id), drawWall()
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
  })
  $wall.addEventListener('input', (e) => e.target.matches('.wfilter') && ((filter = e.target.value), drawWall()))
  // 卡片里的"移到分组"下拉：键盘和触屏不用拖也能换组
  $wall.addEventListener('change', (e) => {
    if (!e.target.matches('[data-move]')) return
    const s = find(e.target.closest('[data-sid]').dataset.sid), v = e.target.value
    if (v === '+') return createGroup(s)
    s.group = v || null
    redraw()
  })
  $wall.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return
    // 筛选后回车 = 打开第一个结果；卡片上回车 = 打开它
    const target = e.target.matches('.wfilter') ? $wall.querySelector('.wcard[data-sid]') : e.target.matches('.wcard[data-sid]') && e.target
    if (target) (closeWall(), h.pick(target.dataset.sid))
  })

  // 拖放：落在哪一行就归哪个分组（落在「新建分组」上 = 建一个新组并放进去）；
  // 落在「置顶」列就置顶，落在别的时间列则取消置顶（时间本身拖不动）
  const mark = (el) => ($wall.querySelector('.over')?.classList.remove('over'), el?.classList.add('over'))
  $wall.addEventListener('dragstart', (e) => {
    const c = e.target.closest?.('.wcard[data-sid]')
    if (!c) return
    dragId = c.dataset.sid
    e.dataTransfer.setData('text/plain', dragId)
    e.dataTransfer.effectAllowed = 'move'
    requestAnimationFrame(() => dragId && $wall.classList.add('dragging')) // 晚一帧再露出"未分组"行，否则布局一变拖动会被浏览器取消
  })
  $wall.addEventListener('dragover', (e) => {
    const lane = dragId && e.target.closest('.lane')
    if (!lane) return mark(null)
    e.preventDefault()
    mark(e.target.closest('.cell') ?? lane)
  })
  $wall.addEventListener('drop', (e) => {
    const lane = e.target.closest('.lane'), cell = e.target.closest('.cell'), s = find(dragId)
    if (!lane || !s) return
    e.preventDefault()
    const to = lane.dataset.lane
    if (to !== 'all') s.group = to === 'none' ? null : to === 'new' ? (fresh = addGroup()).id : to
    if (cell && cell.dataset.b !== 'all' && !s.archived) s.pin = cell.dataset.b === 'pin'
  })
  $wall.addEventListener('dragend', () => {
    dragId = null
    $wall.classList.remove('dragging')
    fresh ? createGroup(null, fresh) : redraw()
    fresh = null
  })
  addEventListener('resize', fit)
}
