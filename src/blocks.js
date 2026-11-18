// 块渲染：把回答里的每个类型化块变成 HTML 字符串。
// 模型输出和业务数据都是不可信输入——所有内容先转义，再拼标签。
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

/** 最小 Markdown：段落 / 标题 / 列表 / 行内代码 / 粗体 / 围栏代码块。流式中途的半截输入也要能渲染。 */
// ponytail: 手写子集，先转义所以安全；要表格/链接/嵌套列表时换 marked + DOMPurify
export function md(src) {
  const out = []
  let list = null, code = null
  const flush = () => list && (out.push(`<ul>${list.join('')}</ul>`), (list = null))
  const pre = (lines) => `<pre><button data-copycode>复制</button><code>${esc(lines.join('\n'))}</code></pre>`
  for (const line of src.split('\n')) {
    if (line.startsWith('```')) {
      if (code) (out.push(pre(code)), (code = null))
      else (flush(), (code = []))
      continue
    }
    if (code) { code.push(line); continue }
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/)
    if (li) { (list ??= []).push(`<li>${inline(li[1])}</li>`); continue }
    flush()
    const h = line.match(/^#{1,4}\s+(.*)/)
    if (h) out.push(`<h4>${inline(h[1])}</h4>`)
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
  }
  flush()
  if (code) out.push(pre(code)) // 流式中未闭合的代码块
  return out.join('')
}

const RENDER = {
  text: (b) => `<div class="md">${md(b.md)}</div>`,
  metrics: (b) =>
    `<div class="metrics">${b.items.map((m) => `<div><small>${esc(m.label)}</small><b>${esc(m.value)}</b>${m.delta ? `<i class="${m.tone === 'good' ? 'good' : 'bad'}">${esc(m.delta)}</i>` : ''}</div>`).join('')}</div>`,
  table: (b) =>
    `<div class="tablewrap"><table><thead><tr>${b.cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`,
  actions: (b, i) =>
    `<div class="actions">${b.items.map((a, j) => `<button data-act="${i}.${j}" ${a.done ? 'disabled' : ''}>${esc(a.done ? '✓ ' + a.done : a.label)}</button>`).join('')}</div>`,
}

export const renderBlock = (b, i) => RENDER[b.type]?.(b, i) ?? ''

if (import.meta.env.DEV) {
  console.assert(!md('<img src=x onerror=alert(1)> **a**').includes('<img'), 'md 必须转义 HTML')
  console.assert(/<ul><li>a<\/li><li>b<\/li><\/ul><pre>.*<code>x&lt;y/.test(md('- a\n- b\n\n```\nx<y')), 'md 列表/未闭合代码块')
}
