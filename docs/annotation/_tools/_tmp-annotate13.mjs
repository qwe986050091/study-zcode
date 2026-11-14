// 为 utils/telemetry/perfettoTracing.ts 补字段级中文注释（按原始行号降序插入）
import fs from 'fs'

const file = 'd:/code/claude-code-main/utils/telemetry/perfettoTracing.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const plan = {
  65: ['name 是事件标签，Perfetto UI 直接显示；同一次区间的 B/E 两条必须同名才能配成一条轨道。'],
  66: ['cat 是分类前缀，逗号分隔可形成多级分组（如 api,retry），筛选器按前缀匹配。'],
  67: ['ph 是事件类型码：B/E 成对表示区间，X 自带 dur，i 为瞬时标记，M 为轨道元数据。'],
  72: ['args 承载自定义字段，点开事件即可查看；值必须能 JSON 序列化，否则整份 trace 写盘失败。'],
  74: ['scope 只对异步事件（b/n/e）有意义，用于区分同一 id 下的多条异步轨道。'],
  81: ['agentId 取 getAgentId()，主线程退化为 sessionId，因此主线程也有稳定轨道可挂。'],
  82: ['agentName 缺省为 main，同时决定 tid 的哈希值。'],
  83: ['parentAgentId 来自 getParentSessionId()；缺失表示顶层 agent，不写 parent_agent 元数据。'],
  84: ['processId 主线程固定为 1，子 agent 由自增计数器分配，保证每个 agent 在 Perfetto 里各占一条轨道。'],
  85: ['threadId 取 agentName 的 djb2 哈希，同名 agent 共用一条轨道（刻意取舍，避免轨道数爆炸）。'],
  92: ['name 与开始事件同名，end 时直接复用，避免两处字符串不一致导致 B/E 配不上。'],
  93: ['category 在 end 事件里沿用，Perfetto 按前缀归到同一筛选分组。'],
  94: ['startTime 是相对追踪起点的微秒数，子 span 的时间都在这个基准上累加。'],
  95: ['agentInfo 在 span 开始时快照，之后 agent 改名或注销都不影响已打开的 span。'],
  96: ['args 是开始时的参数快照，end 时与结束字段合并成一条完整事件。'],
  224: ['session_id 取启动时的会话 ID，与 trace 文件名同源，便于把文件与 transcript 对上。'],
  225: ['trace_start_time 是 ts 的零点，事件时间戳都相对本值换算。'],
  226: ['agent_count 是累计登记次数，注销不递减，因此可能大于当前活跃 agent 数。'],
  227: ['total_event_count 含元数据事件，用于判断文件是否被容量淘汰截断。'],
  503: ['success 缺省按 true 处理：上游漏传时视为成功，避免成功率被凭空拉低。'],
  504: ['error 只在失败时填充，内容原样进 trace，写入前不要带凭据或用户原文。'],
}

const numbers = Object.keys(plan).map(Number).sort((a, b) => b - a)
for (const n of numbers) {
  const target = lines[n - 1]
  if (target === undefined) throw new Error('line out of range: ' + n)
  const indent = (target.match(/^\s*/) || [''])[0]
  lines.splice(n - 1, 0, ...plan[n].map(c => indent + '// ' + c))
}

fs.writeFileSync(file, lines.join(eol), 'utf8')
console.log('inserted', numbers.length, 'field anchors; total lines', lines.length)
