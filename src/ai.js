// AI 适配层：think() 是异步生成器，吐三种事件 ——
//   { type:'think', delta }  思考过程   { type:'text', delta }  回答正文   { type:'block', block }  业务块
// 默认演示模式。接真模型：在 .env.local 里配 OpenAI 兼容的流式端点
//   VITE_AI_BASE_URL=https://api.xxx.com/v1  VITE_AI_KEY=sk-...  VITE_AI_MODEL=...
// ponytail: key 直接进浏览器，仅限本机原型；上线前加服务端代理，并在代理里挂 function calling 产出业务块。
import { businessAnswer } from './business.js'
import { LONG_MD } from './seed.js'

const { VITE_AI_BASE_URL: BASE, VITE_AI_KEY: KEY, VITE_AI_MODEL: MODEL } = import.meta.env

export async function* think(question, history, signal) {
  if (!KEY) return yield* mock(question, signal)
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, stream: true, messages: [...history, { role: 'user', content: question }] }),
  })
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 160)}`)
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  for (let buf = ''; ; ) {
    const { value, done } = await reader.read()
    if (done) return
    const lines = (buf + value).split('\n')
    buf = lines.pop()
    for (const line of lines) {
      const data = line.startsWith('data:') && line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      const d = JSON.parse(data).choices?.[0]?.delta ?? {}
      if (d.reasoning_content) yield { type: 'think', delta: d.reasoning_content } // 带推理输出的模型（如 deepseek-reasoner）
      if (d.content) yield { type: 'text', delta: d.content }
    }
  }
}

const sleep = (ms, signal) =>
  new Promise((res, rej) => {
    if (signal?.aborted) return rej(new DOMException('aborted', 'AbortError'))
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new DOMException('aborted', 'AbortError'))), { once: true })
  })

async function* mock(q, signal) {
  const long = /方案|详细|步骤|完整/.test(q) && { steps: ['用户要可执行的方案，不是结论', '按 止血 → 圈定范围 → 定位 → 修复 → 恢复条件 → 复盘 组织'], md: LONG_MD }
  const a = long || businessAnswer(q) || {
    steps: ['理解问题', '当前是演示模式，没有接入模型', '改为介绍可以直接上手的操作'],
    md: `（演示模式：还没接入模型）\n\n你问的是「${q}」。接上模型后，这里是流式的 Markdown 回答，上方是模型的思考过程。\n\n现在可以先试界面本身：\n- **滚轮 / ↑ ↓**：溯回上游的任何一轮\n- 溯回去之后直接提问：从那里**分出一条支流**，原来的对话不会被覆盖\n- **引用到提问**：把任何一轮带进下一个问题，跨支流、跨会话都行\n- 问一句带「设备故障」的话：看业务数据卡片和可执行动作`,
  }
  for (const s of a.steps) {
    await sleep(520, signal)
    yield { type: 'think', delta: s + '\n' }
  }
  await sleep(400, signal)
  for (let i = 0; i < a.md.length; i += 3) {
    yield { type: 'text', delta: a.md.slice(i, i + 3) }
    await sleep(16, signal)
  }
  for (const block of a.blocks ?? []) {
    await sleep(260, signal)
    yield { type: 'block', block: structuredClone(block) }
  }
}
