// 数据层：会话 → 轮次树。唯一的状态来源，负责持久化、路径计算、搜索。
// 每个会话是一棵树（turns.root 是虚根）；"当前看到的对话"= 从根沿每个节点的 pick 走到叶子的那条路径。
const KEY = 'su.v3'

// 水色主题：h 是深处的色相，h2 是亮部/流线的色相，sat 是整体饱和度
export const THEMES = [
  { name: '深海', h: 0.5, h2: 0.56, sat: 1 },
  { name: '极光', h: 0.4, h2: 0.5, sat: 1 },
  { name: '靛夜', h: 0.62, h2: 0.7, sat: 1 },
  { name: '紫霞', h: 0.76, h2: 0.88, sat: 0.95 },
  { name: '玫瑰', h: 0.93, h2: 0.03, sat: 0.9 },
  { name: '熔金', h: 0.07, h2: 0.12, sat: 0.95 },
  { name: '森苔', h: 0.28, h2: 0.18, sat: 0.8 },
  { name: '月白', h: 0.58, h2: 0.6, sat: 0.16 },
]

// groups：用户自己建的分组 [{ id, name, theme }]，数量不限；会话用 s.group 指向它，null = 未分组。
// 会话的水色跟着分组走（未分组的用自己的 s.theme）。folded 记录折叠了哪些分组，axes 记录全部会话视图开着哪两个维度
export const state = load() ?? { sessions: [], current: null, groups: [], folded: [], axes: { g: true, t: true } }
export const groupOf = (s) => state.groups.find((g) => g.id === s.group)
export const themeOf = (s) => THEMES[groupOf(s)?.theme ?? s.theme] ?? THEMES[0]
export const uid = () => Math.random().toString(36).slice(2, 10)
// 必须是函数声明（会提升）：上面的 load() 在模块初始化时就要用它
export function isLive(t) {
  return t.status === 'thinking' || t.status === 'answering'
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    if (!Array.isArray(s?.sessions) || !s.sessions.every((x) => x.turns?.root)) return null
    // 刷新页面时还在生成的轮次，流已经断了
    s.sessions.forEach((x, i) => {
      Object.values(x.turns).forEach((t) => isLive(t) && (t.status = 'stopped'))
      x.theme ??= i % 8 // 旧存档没有主题字段
    })
    if (!Array.isArray(s.groups)) {
      // 旧存档里"水色就是分组"：把用到的每种水色转成一个真正的分组
      const names = s.groups ?? {}
      s.groups = [...new Set(s.sessions.map((x) => x.theme))].map((i) => ({ id: `g${i}`, name: names[i] || THEMES[i].name, theme: i }))
      s.sessions.forEach((x) => (x.group = `g${x.theme}`))
      s.folded = []
    }
    s.folded ??= []
    s.axes ??= { g: true, t: true }
    return s
  } catch {
    return null
  }
}

let timer
export function save() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch {} // 隐私模式/配额满：退化为不持久化，不影响使用
  }, 300)
}

export const current = () => state.sessions.find((s) => s.id === state.current)

// 时间分组（和常见侧边栏一致），置顶的不论时间单独一列
export const BUCKETS = [['pin', '置顶'], ['today', '今天'], ['yesterday', '昨天'], ['week', '7 天内'], ['month', '30 天内'], ['earlier', '更早']]
// ponytail: 按 24 小时折算自然日，夏令时切换当天可能差一格；需要严格日历日时改用 setDate
export function bucketOf(s, now = Date.now()) {
  if (s.pin) return 'pin'
  const days = Math.ceil((new Date(now).setHours(0, 0, 0, 0) - s.at) / 864e5) // 距今天 0 点几个自然日，≤0 就是今天
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days <= 6 ? 'week' : days <= 29 ? 'month' : 'earlier'
}

/** 顶部会话架上的会话：置顶在前，归档的不出现（正在看的那个除外）。Alt+数字 也按这个顺序。 */
export const shelfList = () => state.sessions.filter((s) => !s.archived || s.id === state.current).sort((a, b) => !!b.pin - !!a.pin)

/** 新会话默认留在当前分组里（像在一个项目里新开对话）；group 传 null 则不进任何分组。 */
export function newSession(title = '新会话', group = current()?.group ?? null) {
  const s = {
    id: uid(), title, at: Date.now(), cursor: 'root', group, theme: current()?.theme ?? 0,
    turns: { root: { id: 'root', parent: null, children: [], pick: 0 } },
  }
  state.sessions.unshift(s)
  state.current = s.id
  return s
}

export function removeSession(id) {
  const group = current()?.group
  state.sessions = state.sessions.filter((s) => s.id !== id)
  if (state.current === id) state.current = (shelfList()[0] ?? newSession('新会话', group)).id
}

/** 新建分组：水色取现有分组里用得最少的一种，之后可以随时换。 */
export function addGroup(name = '新分组', theme) {
  const used = THEMES.map((_, i) => state.groups.filter((g) => g.theme === i).length)
  const g = { id: uid(), name, theme: theme ?? used.indexOf(Math.min(...used)) }
  state.groups.push(g)
  return g
}

/** 删除分组只是解散它：里面的会话一个不删，回到"未分组"，并保留原来的水色。 */
export function removeGroup(id) {
  const g = state.groups.find((x) => x.id === id)
  state.sessions.forEach((s) => s.group === id && Object.assign(s, { group: null, theme: g.theme }))
  state.groups = state.groups.filter((x) => x.id !== id)
  state.folded = state.folded.filter((x) => x !== id)
}

/** 派生：整个会话（含所有支流）复制一份，从副本上继续，原会话不动。 */
export function cloneSession(s) {
  const c = structuredClone(s)
  Object.assign(c, { id: uid(), title: `${s.title} 副本`.slice(0, 40), at: Date.now(), pin: false, archived: false })
  Object.values(c.turns).forEach((t) => isLive(t) && (t.status = 'stopped')) // 生成流属于原会话
  state.sessions.unshift(c)
  state.current = c.id
  return c
}

/** 归档 / 恢复。归档的是当前会话时，视线移到别的会话上。 */
export function archive(s, on) {
  s.archived = on
  if (on) s.pin = false
  if (on && state.current === s.id) state.current = (shelfList().find((x) => x.id !== s.id) ?? newSession('新会话', s.group)).id
}

/** 当前可见路径：从根沿 pick 走到叶子。 */
export function path(s) {
  const out = []
  for (let t = s.turns.root; t.children.length; ) out.push((t = s.turns[t.children[Math.min(t.pick, t.children.length - 1)]]))
  return out
}

/** 在 parentId 下长出新一轮。父节点已有孩子时，这就是一条新支流。 */
export function addTurn(s, parentId, q, refs = []) {
  const t = { id: uid(), parent: parentId, children: [], pick: 0, q, refs, think: '', ms: 0, blocks: [], status: 'thinking' }
  const p = s.turns[parentId]
  s.turns[t.id] = t
  p.pick = p.children.push(t.id) - 1
  s.cursor = t.id
  s.at = Date.now()
  if (parentId === 'root' && s.title === '新会话') s.title = q.slice(0, 22)
  return t
}

/** 让某一轮出现在可见路径上（沿途把各级 pick 拨过去），并把视线移到它。 */
export function reveal(s, id) {
  for (let t = s.turns[id]; t.parent; t = s.turns[t.parent]) {
    const p = s.turns[t.parent]
    p.pick = p.children.indexOf(t.id)
  }
  s.cursor = id
}

export const answerText = (t) => t.blocks.filter((b) => b.type === 'text').map((b) => b.md).join('\n')

/** 回答的一句话摘要（去掉代码块和 Markdown 符号）：叠层和会话墙用它来代表这一轮的回答。 */
export const gistOf = (t, n = 80) => answerText(t).replace(/```[\s\S]*?(```|$)/g, ' ').replace(/[*`#>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, n)

/** 把会话当前路径导出成 Markdown（业务块也转成文本，表格转 Markdown 表格）。 */
export function toMarkdown(s) {
  const block = (b) =>
    b.type === 'text' ? b.md
    : b.type === 'metrics' ? b.items.map((m) => `- ${m.label}：${m.value}${m.delta ? `（${m.delta}）` : ''}`).join('\n')
    : b.type === 'table' ? [b.cols, b.cols.map(() => '---'), ...b.rows].map((r) => `| ${r.join(' | ')} |`).join('\n')
    : ''
  return `# ${s.title}\n\n` + path(s).map((t, i) => `## ${i + 1}. ${t.q}\n\n${t.blocks.map(block).filter(Boolean).join('\n\n')}`).join('\n\n---\n\n') + '\n'
}

/** 跨所有会话搜问题和回答。 */
// ponytail: 子串匹配 + 全量扫描；轮次上万或要语义搜索时换倒排/向量索引
export function search(query) {
  const q = query.trim().toLowerCase()
  const out = []
  if (!q) return out
  for (const s of state.sessions)
    for (const t of Object.values(s.turns)) {
      if (t.id === 'root') continue
      if (t.q.toLowerCase().includes(q)) out.push({ kind: '问', s, t, text: t.q })
      const a = answerText(t).replace(/[*`#]/g, ''), i = a.toLowerCase().indexOf(q) // 片段里不露 Markdown 符号
      if (i >= 0) out.push({ kind: '答', s, t, text: (i > 24 ? '…' : '') + a.slice(Math.max(0, i - 24), i + 80).replace(/\s+/g, ' ') })
    }
  return out.slice(0, 40)
}

// 自检：分叉后 reveal 能把路径拨到另一条支流上
if (import.meta.env.DEV) {
  const s = { title: 'x', turns: { root: { id: 'root', parent: null, children: [], pick: 0 } } }
  const a = addTurn(s, 'root', 'a'), b = addTurn(s, a.id, 'b')
  addTurn(s, a.id, 'c')
  console.assert(path(s).map((t) => t.q).join() === 'a,c', 'path 应走最新支流')
  reveal(s, b.id)
  console.assert(path(s).map((t) => t.q).join() === 'a,b' && s.cursor === b.id, 'reveal 应切回旧支流')
  const noon = new Date(2026, 10, 17, 12).getTime(), ago = (h) => bucketOf({ at: noon - h * 36e5 }, noon)
  const keep = [[...state.groups], state.sessions]
  const g = addGroup('t'), x = { group: g.id, theme: 0 }
  state.sessions = [x]
  removeGroup(g.id)
  console.assert(x.group === null && x.theme === g.theme && !state.groups.includes(g), '删除分组应保留会话并回到未分组')
  ;[state.groups, state.sessions] = keep
  console.assert([ago(1), ago(13), ago(24 * 6), ago(24 * 7), ago(24 * 40)].join() === 'today,yesterday,week,month,earlier' && bucketOf({ pin: true, at: 0 }, noon) === 'pin', 'bucketOf 时间分组')
}
