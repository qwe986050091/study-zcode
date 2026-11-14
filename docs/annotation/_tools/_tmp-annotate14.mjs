// 为 utils/telemetry/perfettoTracing.ts 补齐分支注释（当前行号，降序插入）
import fs from 'fs'

const file = 'd:/code/claude-code-main/utils/telemetry/perfettoTracing.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const plan = {
  158: '命中已分配的数值 pid 直接复用，避免同一 agent 在多条轨道上分裂。',
  175: '已登记过就返回缓存条目，重复调用不会重复写元数据事件。',
  211: '遍历全部未闭合 span，逐个按 TTL 判断。',
  212: '超过 30 分钟未结束视为泄漏：补一条 E 事件标 evicted，轨道上留下缺口而非永久悬挂。',
  258: '未到容量上限直接返回，淘汰只在真正超限时发生。',
  290: 'env 未设置或被显式置假时静默关闭追踪；外部构建整块已被 feature() 消除。',
  318: '写盘间隔必须是正整数秒，0、负数与非数字都视为不启用周期写。',
  334: 'unref 让定时器不阻止进程退出；部分宿主没有 unref，先判空再调用。',
  352: '已写过就跳过，避免 exit 兜底覆盖掉更完整的异步快照。',
  370: '未启用时不产生元数据事件，调用方无需自己判开关。',
  432: '未启用时连 registry 都不写，避免退出时误写出空轨道。',
  455: '未启用时没有内存要释放，直接返回。',
  473: '未启用返回空串，end 侧会忽略空 id，调用方不必判空。',
  532: '空 spanId 只来自未启用的 start，直接丢弃。',
  535: 'span 被 TTL 清理或 id 拼错时静默返回，不补发孤立的 E 事件。',
  601: '只有测得 setup 耗时才画子 span，否则轨道上会多出一段零长度区间。',
  624: '只给失败的重试画区间，最后一次成功尝试归入 First Token，不重复计时。',
  698: '采样时长必须为正才画区间，ttlt 缺失或早于首个 token 时跳过。',
  747: '未启用返回空串，工具侧把 null 与空串同等对待。',
  791: '空 spanId 或未启用时静默返回。',
  794: 'span 已过期被清理，补 E 事件会与 evicted 版本重复，直接丢弃。',
  828: '未启用返回空串，等待时间不入 trace。',
  870: '空 spanId 或未启用时直接返回。',
  873: 'span 不存在说明已被 TTL 清理，跳过以免出现孤立结束事件。',
  910: '未启用时空转，瞬时事件没有配对要求。',
  935: '未启用时不写计数器，避免事件数组被空值撑大。',
  957: '未启用返回空串，交互层不必分支。',
  993: '空 spanId 或未启用时直接返回。',
  996: '交互 span 已被 closeOpenSpans 补过 incomplete 结束，跳过以免重复。',
  1026: '先停清理定时器，再停写盘定时器，两者开关彼此独立。',
  1030: '写盘定时器可能从未启动，判空后再 clearInterval。',
  1040: '会话结束时把仍打开的 span 逐个补成 incomplete 结束，保证 B/E 配对。',
  1065: '未启用、无路径或已最终写过时不做周期写。',
  1086: '最终写只执行一次；已写过说明 exit 兜底先跑过，跳过以免重复。',
  1117: '同步兜底同样只执行一次，避免覆盖更完整的异步快照。',
  1164: '重置前先停定时器，否则清理回调会在状态清空后继续跑。',
}

const numbers = Object.keys(plan).map(Number).sort((a, b) => b - a)
for (const n of numbers) {
  const target = lines[n - 1]
  if (target === undefined) throw new Error('line out of range: ' + n)
  if (!/\b(if|for|while|case)\b/.test(target)) {
    throw new Error('not a branch line ' + n + ': ' + target.trim())
  }
  const indent = (target.match(/^\s*/) || [''])[0]
  lines.splice(n - 1, 0, indent + '// ' + plan[n])
}

fs.writeFileSync(file, lines.join(eol), 'utf8')
console.log('inserted', numbers.length, 'branch anchors; total lines', lines.length)
