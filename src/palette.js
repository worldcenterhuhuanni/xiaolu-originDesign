// ⌘K 面板：不输入时列出会话（快速切换/新建），输入后跨所有会话搜问题和回答原文。
// 用原生 <dialog>：Esc 关闭、焦点陷阱、遮罩都是平台给的。
import { state, path, search } from './store.js'
import { esc } from './blocks.js'

const $dlg = document.getElementById('palette')
const $in = document.getElementById('pq')
const $list = document.getElementById('pr')
let items = [], on = 0, pick

function mark(text, q) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1
  return i < 0 ? esc(text) : esc(text.slice(0, i)) + `<mark>${esc(text.slice(i, i + q.length))}</mark>` + esc(text.slice(i + q.length))
}

function draw() {
  const q = $in.value.trim()
  items = q
    ? search(q).map((r) => ({ ...r, sub: r.s.title }))
    : [{ kind: '＋', text: '新会话' }, ...state.sessions.map((s) => ({ kind: '会话', s, text: s.title, sub: `${path(s).length} 轮` }))]
  on = Math.min(on, Math.max(0, items.length - 1))
  $list.innerHTML = items.length
    ? items.map((r, i) => `<li role="option" data-i="${i}" class="${i === on ? 'on' : ''}" aria-selected="${i === on}"><em>${r.kind}</em><span>${mark(r.text, q)}</span><small>${esc(r.sub ?? '')}</small></li>`).join('')
    : '<li class="none">没有找到。换个词试试——搜索范围是所有会话的问题和回答。</li>'
  $list.querySelector('.on')?.scrollIntoView({ block: 'nearest' })
}

function choose(i) {
  const r = items[i]
  if (!r) return
  $dlg.close()
  pick(r)
}

export function openPalette() {
  if ($dlg.open) return
  $in.value = ''
  on = 0
  $dlg.showModal()
  draw()
}

export function initPalette(onPick) {
  pick = onPick
  $in.addEventListener('input', () => ((on = 0), draw()))
  $in.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      on = (on + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % (items.length || 1)
      draw()
    } else if (e.key === 'Enter') choose(on)
  })
  $list.addEventListener('click', (e) => choose(+e.target.closest('[data-i]')?.dataset.i))
  $dlg.addEventListener('click', (e) => e.target === $dlg && $dlg.close()) // 点遮罩关闭
}
