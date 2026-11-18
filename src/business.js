// 业务绑定的唯一接缝。界面其余部分不知道"业务"是什么，只认三样东西：
//   1. 思考步骤（文本）  2. 结构化块 metrics / table / actions  3. 动作回调 runAction
// 真实接入：把 businessAnswer 换成"模型 function calling → 调你的接口 → 把返回数据映射成块"，
// runAction 换成真实的写操作接口。下面是演示用的假数据（设备运营场景）。

const REGIONS = [
  ['华东', 1284, 37, '2.88%', '+0.9pt'],
  ['华南', 962, 14, '1.46%', '-0.2pt'],
  ['华北', 731, 9, '1.23%', '+0.1pt'],
]

export function businessAnswer(q) {
  if (!/故障|设备|周报|工单|运营/.test(q)) return null
  return {
    steps: [
      '识别意图：故障统计 · 时间范围 = 上周 · 维度 = 区域',
      '调用 ops.query({ metric: "fault", range: "last_week", group: "region" })',
      '返回 3 行，对比前一周计算环比',
      '华东环比 +0.9pt，超过告警阈值 0.5pt，建议排查',
    ],
    md: '上周三个区域共 **60 起**故障，整体故障率 **2.02%**。华东明显偏高，集中出现在 11 月 12 日固件 `v3.4.1` 推送之后。',
    blocks: [
      {
        type: 'metrics',
        items: [
          { label: '在线设备', value: '2,977' },
          { label: '故障数', value: '60', delta: '+11', tone: 'bad' },
          { label: '整体故障率', value: '2.02%', delta: '+0.4pt', tone: 'bad' },
          { label: '平均修复时长', value: '3.6h', delta: '-0.5h', tone: 'good' },
        ],
      },
      { type: 'table', cols: ['区域', '设备数', '故障数', '故障率', '环比'], rows: REGIONS },
      {
        type: 'actions',
        items: [
          { id: 'ticket', label: '为华东创建排查工单', confirm: '将在工单系统里创建一张工单，继续？' },
          { id: 'export', label: '导出明细 CSV' },
        ],
      },
    ],
  }
}

/** 执行回答里的业务动作，返回给用户看的结果文案。 */
export async function runAction(action) {
  await new Promise((r) => setTimeout(r, 500))
  if (action.id === 'export') {
    const csv = [['区域', '设备数', '故障数', '故障率', '环比'], ...REGIONS].map((r) => r.join(',')).join('\n')
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' })), download: '故障明细.csv' })
    a.click()
    URL.revokeObjectURL(a.href)
    return '已导出 故障明细.csv'
  }
  return '已创建工单 OPS-4127（演示）'
}
