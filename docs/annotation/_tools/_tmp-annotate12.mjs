// 为 services/mcp/types.ts 补字段级中文注释（按原始行号降序插入）
import fs from 'fs'

const file = 'd:/code/claude-code-main/services/mcp/types.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const plan = {
  78: ['command 是进程启动命令：PATH 可解析的可执行名或绝对路径；空串被 min(1) 拒掉，', '但命令是否存在要到建连阶段才暴露，配置校验不查文件系统。'],
  79: ['args 缺省为空数组而非 undefined：连接层直接展开成 argv，省去空值判断；', '元素顺序即进程参数顺序，含空格的参数由调用方自己加引号。'],
  108: ['xaa 为 true 时才启用跨应用访问（XAA/SEP-990）；IdP 参数取自 settings.xaaIdp，', '单个 server 只存开关，不重复保存 issuer/clientId，避免多处配置漂移。'],
  116: ['判别值 sse：服务端推送的单向长连接，写入仍走 HTTP POST。'],
  117: ['url 不校验 scheme：http:// 的本地调试端点同样允许，非法协议留到建连阶段报错。'],
  118: ['headers 是建连时的静态请求头，长期不变的令牌直接写在这里；', '需要运行时刷新凭据时改用 headersHelper，同名键的先后由合并实现决定，不要依赖顺序。'],
  129: ['判别值 sse-ide：IDE 扩展以 SSE 暴露的 MCP 服务，仅供进程内插件使用。'],
  130: ['url 由 IDE 扩展在建连时下发，不受用户配置文件控制。'],
  131: ['ideName 标识来源 IDE，用于状态展示与同源去重：同名 IDE 只保留一条连接。'],
  132: ['ideRunningInWindows 由 IDE 扩展上报，用于区分 Windows 宿主的路径与 shell 约定。'],
  139: ['判别值 ws-ide：IDE 以 WebSocket 暴露的 MCP 服务，与 sse-ide 互为替代传输。'],
  140: ['url 由 IDE 扩展下发，通常指向本机回环地址上的监听端口。'],
  141: ['ideName 与 sse-ide 同义：标识来源 IDE，参与状态展示与去重。'],
  142: ['authToken 是可选的本地握手令牌，IDE 进程重启后失效，不落盘保存。'],
  143: ['ideRunningInWindows 与 sse-ide 同义：由 IDE 上报的宿主平台标记。'],
  151: ['判别值 http：Streamable HTTP，请求-响应式，不保持长连接。'],
  152: ['url 同样不校验 scheme，非法协议留到建连阶段报错。'],
  153: ['headers 是每个请求都附带的静态头，适合长期不变的鉴权令牌。'],
  154: ['headersHelper 是运行时执行的命令，命令输出的 JSON 合并进请求头，用于短期凭据。'],
  155: ['oauth 只描述本 server 的授权服务器；IdP 侧参数走 settings.xaaIdp 全局共享。'],
  162: ['判别值 ws：通用 WebSocket，双向长连接，适合服务端主动推送工具调用。'],
  163: ['url 由用户配置，接受 ws:// 与 wss:// 两种 scheme。'],
  164: ['headers 用于握手阶段的静态鉴权头。'],
  165: ['headersHelper 与 http/sse 同义：握手前执行命令取动态请求头。'],
  173: ['判别值 sdk：进程内注册的实现，不产生子进程也不建网络连接。'],
  174: ['name 是注册键：连接层按 name 从进程内注册表取实例，取不到即连接失败。'],
  181: ['判别值 claudeai-proxy：CLI 自己合成的只读配置，指向 claude.ai 连接器代理。'],
  182: ['url 指向代理入口，由 CLI 拼接，用户配置里传进来会被忽略。'],
  183: ['id 是连接器标识，用于回查 claude.ai 侧配置与授权状态。'],
  231: ['scope 只记来源，不参与连接等价性判断：哈希与比较都会先剔除。'],
  244: ['mcpServers 以 server 名为键；同名声明在合并时按优先级覆盖，键名不做大小写归一。'],
  309: ['ServerResource 在 MCP 原始 Resource 上补 server 字段，便于从资源反查归属服务端。'],
  318: ['description 会拼进工具提示；空串表示服务端没给描述，展示层不要伪造。'],
  319: ['inputJSONSchema 是服务端声明的入参 schema，本地只透传、不校验。'],
  326: ['isMcp 用于 skip-prefix 场景：工具名没有 mcp__ 前缀时靠本字段识别归属。'],
  333: ['name 与 configs 的键一一对齐：连接对象已释放时只剩这份可序列化快照。'],
  334: ['type 复用五种连接状态，取值集合与 MCPServerConnection 的判别值完全一致。'],
  335: ['capabilities 可缺省：failed 与 pending 状态下服务端还没报能力表。'],
  341: ['clients 按 name 与 configs 对齐，只含可序列化字段，不含 client 实例。'],
  342: ['configs 是合并后的最终配置，键名即 server 名，值里带 scope 标记。'],
  343: ['tools 是工具池快照，顺序不保证与 tools/list 的返回顺序一致。'],
  344: ['resources 以 server 名为键；空数组表示已查询过且无资源，不等于未查询。'],
}

const numbers = Object.keys(plan).map(Number).sort((a, b) => b - a)
for (const n of numbers) {
  const target = lines[n - 1]
  if (target === undefined) throw new Error('line out of range: ' + n)
  const indent = (target.match(/^\s*/) || [''])[0]
  const block = plan[n].map(c => indent + '// ' + c)
  lines.splice(n - 1, 0, ...block)
}

fs.writeFileSync(file, lines.join(eol), 'utf8')
console.log('inserted', numbers.length, 'fields ->', numbers.length * 1, 'anchors; total lines', lines.length)
