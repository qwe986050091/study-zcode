import fs from 'fs'

const TAG_STOP = new Set(['STEP', 'INV', 'TODO', 'FIXME', 'NOTE', 'SAFETY', 'XXX', 'HACK'])
const CN_NOUN = /(缓冲区|边界|残行|换行|指针|计数|位置|偏移|目录|文件|路径|参数|配置|规则|权限|窗口|阈值|消息|会话|连接|进程|线程|缓存|索引|映射|集合|节点|字段|标记|长度|队列|句柄|状态|数组|对象|字节|摘要|快照|分段|视图|正则|转义|扫描|字符串|字符|引号|文本|枚举|事件|任务|标识|文案)/
const PRECOND = /(前提|前置|依赖|必须先|先于|在.{0,12}之前|之后|顺序|调用前|调用后|传入|返回|失败|否则|会|导致|造成|破坏|panic|死锁|回滚|重放|越界|不变量|INV-|保证|确保|无法|不能|只能|必须|拒绝|抛出|未|若|如果|一旦|冲突|泄漏|泄露|只有|才|截断|说明|便于|以免|避免|取决于|用于|供|风险|收益|直到|算起|对应|双重|互斥|优先级|重复)/
const INVARIANT = /(唯一|不可变|幂等|原子|有序|单调|只读|线程安全|可重入|有界|不共享|恒定|固定|稳定|从\s*\d+\s*开始)/
const STRUCTURAL_MARKER = /^(?:```|~~~|eslint-|prettier-|@ts-|#region\b|#endregion\b|\*+$|[═─━]{3,})/
const HEADING = /[:：]\s*$/
const SENTENCE_END = /[。！？!?；;.：:]\s*$/

function identTokens(s) {
  return (s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter(t => !TAG_STOP.has(t))
}
function isWeak(content) {
  if (STRUCTURAL_MARKER.test(content)) return false
  if (HEADING.test(content)) return false
  if (identTokens(content).length > 0) return false
  if (/\d/.test(content)) return false
  if (/`[^`]+`/.test(content)) return false
  if (CN_NOUN.test(content)) return false
  if (PRECOND.test(content)) return false
  if (INVARIANT.test(content)) return false
  return true
}

const file = process.argv[2]
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
const isC = l => /^\s*\/\//.test(l)
const content = l => l.replace(/^\s*\/\/\s?/, '').trim()
for (let i = 0; i < lines.length; i++) {
  if (!isC(lines[i])) continue
  const body = content(lines[i])
  if (!body) continue
  let s = i
  while (s - 1 >= 0 && isC(lines[s - 1]) && !SENTENCE_END.test(content(lines[s - 1]))) s--
  let e = i
  while (e + 1 < lines.length && isC(lines[e + 1]) && !SENTENCE_END.test(content(lines[e]))) e++
  const unit = lines.slice(s, e + 1).map(content).join('')
  if (isWeak(unit)) console.log(i + 1, '|', body)
}
