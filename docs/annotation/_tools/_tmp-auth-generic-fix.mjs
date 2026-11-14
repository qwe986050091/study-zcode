import fs from 'node:fs'
const file = 'd:/code/claude-code-main/services/mcp/auth.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const repl = [
  [2031, "this.serverName 之后只用于日志前缀与 serverKey 哈希。"],
  [2033, "this.serverConfig 保留原始配置，供 URL 与 oauth 字段读取。"],
  [2035, "this.redirectUri 由 SDK 通过 redirectUrl 读取，必须与本地 listen 端口一致。"],
  [2037, "this.handleRedirection 决定是否启动本地回调服务。"],
  [2047, "redirectUrl 是 SDK 读取回调地址的唯一入口，直接透传 redirectUri。"],
  [2103, "override 命中时不继续拼默认 CIMD 地址。"],
  [2152, "storage.read() 是同步接口，clientInformation 里不需要 await。"],
  [2204, "storage.read() 可能返回 undefined，用 {} 兜底以便展开。"],
  [2315, "_refreshInProgress 可能是本实例刚创建，也可能是并发调用留下的同一个 Promise。"],
  [2454, "existingData 提供 mcpOAuth 与其他 server 的既有记录。"],
  [2474, "serverName 冗余写入，方便直接读存储排查而非反解哈希。"],
  [2484, "scope 为 undefined 时也照写，读取侧用 ?? 兜底。"],
  [2590, "existingData 先读出来，避免覆盖别的 server 的记录。"],
  [2633, "expires_in 可能为 undefined，由 SDK 侧兜底。"],
  [2709, "existingData 可能已有上一次 step-up 写入的 scope，需要保留其他字段。"],
  [2798, "logMCPDebug 只记 serverName，不带 verifier 内容。"],
  [2886, "existingData 里除 discoveryState 外的字段要原样保留。"],
  [2940, "storage.read() 同步返回，discoveryState 不能改成异步读。"],
  [3093, "clearKeychainCache 之后必须重新 read()，否则拿到的还是旧缓存。"],
  [3108, "返回的是另一进程写入的 token，不是本进程刷新的结果。"],
  [3112, "refresh_token 可能已被另一进程轮换，直接用存储里的最新值。"],
  [3169, "成功分支事件名固定，改名会打断 BigQuery 侧归因。"],
  [3171, "失败分支事件名固定，与成功事件分开统计。"],
  [3271, "日志只带 serverName，不含 client 信息内容。"],
  [3275, "undefined 让 tokens() 走 needs-auth，而不是抛错中断请求。"],
  [3311, "undefined 让 tokens() 走 needs-auth，而不是把异常抛给调用方。"],
  [3369, "undefined 让下一次连接重新走授权码流程。"],
  [3397, "undefined 让调用方按 401 处理，不再重试本轮。"],
  [3424, "envSecret 非空即用，不再回落到 TTY 输入。"],
  [3516, "storage.read() 同步读，客户端配置不存在时返回 undefined。"],
  [3541, "storage.read() 同步读，未配置时 data 里没有 clientConfig 键。"],
  [2427, "scope 由存储原样带出，SDK 侧不依赖这里做权限判断。"],
]
for (const [n, text] of repl) {
  const idx = n - 1
  if (!/^\s*\/\/ /.test(lines[idx])) throw new Error('not comment at ' + n + ': ' + lines[idx])
  const indent = (lines[idx].match(/^\s*/) || [''])[0]
  lines[idx] = indent + '// ' + text
}
fs.writeFileSync(file, lines.join(eol), 'utf8')
console.log('replaced', repl.length)
