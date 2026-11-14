import fs from 'node:fs'

const file = 'd:/code/claude-code-main/services/lsp/passiveFeedback.ts'
const map = {
  98: ['code 统一转字符串：LSP 允许 number 或 string，附件层只认 string。'],
  152: ['registrationErrors 收集 onNotification 缺失或注册抛错的服务器。'],
  163: ['先校验 onNotification 是否为函数，缺失即跳过并记入 registrationErrors。'],
  171: ['记录失败但继续下一个服务器，不让一个坏实例阻断整体注册。'],
  190: ['运行时再校验一次载荷结构，畸形通知按无效参数丢弃。'],
  207: ['结构校验通过后才放宽类型，后续逻辑只依赖 uri 与 diagnostics 两个字段。'],
  213: ['转换可能因畸形 URI 抛错，由外层 catch 计数。'],
  220: ['firstFile 缺失或 diagnostics 为 0 条即视为清空通知，直接跳过投递。'],
  235: ['注册到 pending 表，由附件系统在下一轮统一投递。'],
  245: ['成功即清零该服务器的连续失败计数，形成滑动窗口。'],
  262: ['count++ 后写回 Map，供后续通知继续累加。'],
  284: ['外层异常同样计入连续失败，避免同类错误反复刷日志。'],
  306: ['注册成功才递增 successCount。'],
  326: ['totalServers 是配置总数，successCount 是实际挂载数。'],
  349: ['diagnosticFailures 以服务器名为键，跨通知共享。'],
}

const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
const nums = Object.keys(map).map(Number).sort((a, b) => b - a)
for (const n of nums) {
  const target = lines[n - 1]
  if (target === undefined) throw new Error(`line ${n} out of range`)
  const indent = target.match(/^\s*/)[0]
  lines.splice(n - 1, 0, ...map[n].map(c => indent + '// ' + c))
}
fs.writeFileSync(file, lines.join('\n'))
console.log('inserted ' + Object.values(map).flat().length)
