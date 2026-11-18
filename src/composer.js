// 输入台：不只是一个文本框。
//   @  引用任意一轮（当前会话直接列出，输入文字则跨所有会话搜索）
//   /  命令（新会话、搜索、导出、专注…）
//   附件：点按钮、拖进窗口、或直接粘贴；文本类文件的内容会随问题一起发给模型
//   语音输入（浏览器支持时出现）、快捷追问、每个会话各自保留草稿
//   左下角的"去向"标签始终说明这一问会落在哪：接着问 / 从第 N 轮分出支流 / 改写第 N 轮
//   当前这轮还在生成且输入为空时，发送键变成停止键
import { current, path, search, isLive } from './store.js'
import { esc } from './blocks.js'

const $ = (id) => document.getElementById(id)
const $form = $('composer'), $q = $('q'), $chips = $('chips'), $mode = $('mode'), $menu = $('menu'), $quick = $('quick'), $send = $('send'), $file = $('file'), $mic = $('mic')
const QUICK = ['展开讲讲', '举个例子', '总结成三点', '有什么风险？']
const TEXT_FILE = /\.(md|txt|csv|json|js|ts|py|log|ya?ml|html|css|sql|xml)$/i
let h, refs = [], files = [], editing = null, items = [], on = 0, trigger = null, shown = null

export const composer = {
  init, refresh,
  focus: () => $q.focus(),
  get editing() { return editing },
  addRef(ref) {
    if (!refs.some((r) => r.tid === ref.tid)) refs.push(ref)
    refresh()
    $q.focus()
  },
  edit(turn) {
    editing = turn
    $q.value = turn.q
    refresh()
    $q.focus()
  },
  cancelEdit() {
    if (!editing) return false
    editing = null
    $q.value = ''
    refresh()
    return true
  },
}

function refresh() {
  const s = current(), p = path(s)
  if (shown !== s) {
    // 换会话：旧会话的草稿留在旧会话里，新会话的草稿取回来；改写状态不跨会话
    if (shown && !editing) shown.draft = $q.value
    editing = null
    $q.value = s.draft ?? ''
    shown = s
  }
  const i = p.findIndex((t) => t.id === s.cursor), cur = p[i]
  const fork = p.length && i < p.length - 1

  // 去向标签
  $mode.className = editing ? 'edit' : fork ? 'fork' : ''
  $mode.innerHTML = editing ? `改写第 ${p.indexOf(editing) + 1} 轮 · 生成新支流 <b aria-hidden="true">×</b>`
    : !p.length ? '新会话的第一问'
    : fork ? `⑂ 从第 ${i + 1} 轮分出支流 <b aria-hidden="true">×</b>`
    : `接着第 ${p.length} 轮`
  $mode.title = editing ? '原来的问答会保留。点击取消改写' : fork ? `你正在看第 ${i + 1} 轮（共 ${p.length} 轮），现在提问不会覆盖后面的对话。点击回到最新一轮` : ''
  $mode.disabled = !editing && !fork

  $chips.innerHTML =
    refs.map((r, j) => `<span class="chip">↗ ${esc(r.q)}<button type="button" data-unref="${j}" aria-label="移除引用">×</button></span>`).join('') +
    files.map((f, j) => `<span class="chip file">${f.kind === 'image' ? '图片' : '文件'} · ${esc(f.name)}<button type="button" data-unfile="${j}" aria-label="移除附件">×</button></span>`).join('')

  const empty = !$q.value.trim()
  const live = cur && isLive(cur)
  $send.classList.toggle('stop', !!live && empty)
  $send.setAttribute('aria-label', live && empty ? '停止生成' : '发送')
  // 快捷追问：只在"上一轮答完、输入框空着"时出现，不跟你抢位置
  $quick.innerHTML = cur && cur.status === 'done' && empty && !editing ? QUICK.map((t) => `<button type="button" data-quick>${t}</button>`).join('') : ''
}

// ---------- @ 与 / 的弹出菜单 ----------

function detect() {
  const before = $q.value.slice(0, $q.selectionStart)
  let m
  if ((m = before.match(/(?:^|\s)@([^\s@]*)$/))) return openMenu('@', m[1])
  if ((m = before.match(/^\/(\S*)$/))) return openMenu('/', m[1])
  closeMenu()
}

function openMenu(kind, query) {
  const s = current()
  trigger = { len: query.length + 1 }
  if (kind === '/') items = h.commands.filter((c) => c.name.includes(query)).map((c) => ({ tag: '/', label: c.name, sub: c.hint, run: c.run }))
  else if (!query) items = path(s).map((t, i) => ({ tag: String(i + 1).padStart(2, '0'), label: t.q, sub: '本会话', ref: { sid: s.id, tid: t.id, q: t.q } })).reverse()
  else {
    const seen = new Set()
    items = search(query).filter((r) => !seen.has(r.t.id) && seen.add(r.t.id)).map((r) => ({ tag: r.kind, label: r.t.q, sub: r.s.title, ref: { sid: r.s.id, tid: r.t.id, q: r.t.q } }))
  }
  items = items.slice(0, 8)
  on = 0
  drawMenu(kind === '@' ? '没有匹配的对话。输入问题或回答里的词来搜索所有会话' : '没有这个命令')
}

function drawMenu(emptyText) {
  $menu.hidden = false
  $menu.innerHTML = items.length
    ? items.map((it, i) => `<li role="option" data-i="${i}" class="${i === on ? 'on' : ''}" aria-selected="${i === on}"><em>${esc(it.tag)}</em><span>${esc(it.label)}</span><small>${esc(it.sub ?? '')}</small></li>`).join('')
    : `<li class="none">${emptyText}</li>`
}

function closeMenu() {
  trigger = null
  $menu.hidden = true
}

function choose(i) {
  const it = items[i]
  if (!it || !trigger) return
  const pos = $q.selectionStart
  $q.value = $q.value.slice(0, pos - trigger.len) + $q.value.slice(pos) // 把触发用的 "@xxx" / "/xxx" 从文本里拿掉
  closeMenu()
  if (it.ref) composer.addRef(it.ref)
  else (refresh(), it.run())
}

// ---------- 附件 ----------

async function addFiles(list) {
  for (const f of [...list].slice(0, 5 - files.length)) {
    const kind = f.type.startsWith('image/') ? 'image' : f.type.startsWith('text/') || TEXT_FILE.test(f.name) ? 'text' : 'other'
    // 文本类文件读出内容随问题发送（截断到 2 万字，避免撑爆上下文和本地存储）；图片等只记录文件名
    files.push({ name: f.name, kind, text: kind === 'text' && f.size < 500_000 ? (await f.text()).slice(0, 20_000) : undefined })
  }
  refresh()
  $q.focus()
}

// ---------- 初始化 ----------

function init(handlers) {
  h = handlers
  $form.addEventListener('submit', (e) => {
    e.preventDefault()
    const text = $q.value.trim()
    if (!text) return $send.classList.contains('stop') ? h.stop() : undefined
    const payload = { text, refs, files, editing }
    refs = []
    files = []
    editing = null
    $q.value = ''
    if (shown) shown.draft = '' // 已经发出去的不再算草稿
    closeMenu()
    h.submit(payload)
  })

  $q.addEventListener('input', () => (detect(), refresh()))
  $q.addEventListener('click', detect)
  $q.addEventListener('keydown', (e) => {
    if (e.isComposing) return
    if (trigger) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        on = (on + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % (items.length || 1)
        return drawMenu('')
      }
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), items.length ? choose(on) : closeMenu()
      if (e.key === 'Escape') return e.stopPropagation(), closeMenu()
    }
    if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), $form.requestSubmit())
  })
  $q.addEventListener('paste', (e) => e.clipboardData.files.length && (e.preventDefault(), addFiles(e.clipboardData.files)))

  $form.addEventListener('click', (e) => {
    const hit = (sel) => e.target.closest(sel)
    let el
    if ((el = hit('[data-unref]'))) return refs.splice(+el.dataset.unref, 1), refresh()
    if ((el = hit('[data-unfile]'))) return files.splice(+el.dataset.unfile, 1), refresh()
    if ((el = hit('[data-quick]'))) return h.submit({ text: el.textContent, refs: [], files: [], editing: null })
    if ((el = hit('#menu [data-i]'))) return choose(+el.dataset.i)
    if (hit('#mode')) return composer.cancelEdit() || h.toLatest()
    if (hit('#attach')) return $file.click()
    if (hit('#at') || hit('#slash')) {
      // 按钮和键盘走同一条路：往输入框里放一个触发符
      const ch = hit('#at') ? '@' : '/'
      if (ch === '/') $q.value = '/'
      else $q.setRangeText(($q.value && !/\s$/.test($q.value.slice(0, $q.selectionStart)) ? ' ' : '') + '@', $q.selectionStart, $q.selectionEnd, 'end')
      $q.focus()
      detect()
    }
  })
  $file.addEventListener('change', () => (addFiles($file.files), ($file.value = '')))

  // 拖文件到窗口任何位置
  addEventListener('dragover', (e) => e.dataTransfer?.types.includes('Files') && (e.preventDefault(), $form.classList.add('drop')))
  addEventListener('dragleave', (e) => !e.relatedTarget && $form.classList.remove('drop'))
  addEventListener('drop', (e) => {
    $form.classList.remove('drop')
    if (e.dataTransfer?.files.length) (e.preventDefault(), addFiles(e.dataTransfer.files))
  })

  // 语音输入：浏览器没有这个能力就不显示按钮
  const Speech = window.SpeechRecognition ?? window.webkitSpeechRecognition
  if (Speech) {
    let rec = null
    $mic.hidden = false
    $mic.addEventListener('click', () => {
      if (rec) return rec.stop()
      const base = $q.value
      rec = new Speech()
      rec.lang = 'zh-CN'
      rec.interimResults = rec.continuous = true
      rec.onresult = (e) => (($q.value = base + [...e.results].map((r) => r[0].transcript).join('')), refresh())
      rec.onerror = (e) => h.toast(e.error === 'not-allowed' ? '没有麦克风权限：在浏览器地址栏里允许后再试' : `语音输入中断：${e.error}`)
      rec.onend = () => ((rec = null), $mic.classList.remove('on'))
      rec.start()
      $mic.classList.add('on')
    })
  }
}
