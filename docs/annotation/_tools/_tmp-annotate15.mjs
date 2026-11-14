// 为 entrypoints/sdk/coreSchemas.ts 补抽样判定为「不达标」的组（按原始行号降序插入）
import fs from 'fs'

const file = 'd:/code/claude-code-main/entrypoints/sdk/coreSchemas.ts'
const raw = fs.readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const plan = {
  606: ['transcript_path 指向当前会话的 JSONL；SessionStart 触发时文件可能尚未创建，hook 需容忍读不到。'],
  336: ['annotations 是服务端自报的能力提示，不参与本地权限判定，不能代替 allow/deny 规则。'],
  337: ['destructive 提示操作可能不可逆，宿主可加二次确认，但服务端可能误报或漏报。'],
  338: ['openWorld 表示会访问外部世界（网络、第三方系统），沙箱策略可对这类工具收紧权限。'],
  1871: ['duration_ms 是整轮墙钟时间，含等待用户与工具执行，不能与 duration_api_ms 相加比较。'],
  1872: ['duration_api_ms 只累计 API 往返时间，不含工具执行与权限等待，用于区分慢在模型还是慢在工具。'],
  1874: ['num_turns 是生成这份结果时的轮次计数，宿主用于展示与埋点，不参与计费。'],
  1875: ['result 是最后一轮的文本输出；结构化输出另放 structured_output，不要假设两条输出同时存在。'],
  1876: ['stop_reason 直接透传 API 的停止原因，可能为 null，null 不代表异常。'],
  1877: ['total_cost_usd 是本地按价格表估算的累计值，不是账单，服务端折扣与缓存优惠不会反映进来。'],
  1878: ['usage 是聚合后的用量，缓存读写单独成列，不要与 inputTokens 相加。'],
  1879: ['modelUsage 以模型名为键；子代理或多模型回退时会有多条记录。'],
  1880: ['permission_denials 记录本次被拒绝的工具调用，宿主可展示这些条目并引导用户修改规则。'],
  1881: ['structured_output 仅在请求 json_schema 输出且解析成功时出现，值是对象而非字符串。'],
  1882: ['fast_mode_state 只在启用快速模式时出现，缺省表示本次运行未使用。'],
  1883: ['uuid 是这条结果消息的标识，用于与 transcript 中的同条记录对齐。'],
  1884: ['session_id 与 system/init 消息里的同名字段一致，是跨消息关联键。'],
  1892: ['subtype 区分四类失败：执行出错、轮次上限、预算上限、结构化输出重试超限，宿主重试策略应分开。'],
  1897: ['duration_ms 与成功分支同义：含工具执行与等待的墙钟时间。'],
  1898: ['duration_api_ms 只累计 API 往返时间，失败前已发生的调用也计入。'],
  1901: ['stop_reason 可能为 null：执行中出错时 API 没有给出正常停止原因。'],
  1902: ['total_cost_usd 含失败前已发生的调用成本，失败不等于不计费。'],
  1903: ['usage 是失败前累计的用量，可能全为 0，不能当作模型未被调用的证据。'],
  1904: ['modelUsage 与成功分支同结构，按模型名分桶。'],
  1905: ['permission_denials 与成功分支同义：被拒绝的调用仍会记录在失败结果里。'],
  1906: ['errors 是失败原因文本数组，可能多于一条；宿主应全部展示而不是只取首条。'],
  1907: ['fast_mode_state 缺省表示本次未启用快速模式。'],
  1908: ['uuid 标识这条失败结果，用于与 transcript 对齐。'],
  1909: ['session_id 与 system/init 一致，用于把结果挂回会话。'],
  1919: ['type 与 subtype 组合 system+init 是握手消息：SDK 初始化完成后发出的第一条非流式消息。'],
  1920: ['subtype 固定 init；后续 system 类消息换用其他 subtype（如 compact_boundary），分发前两个字段都要看。'],
  1921: ['agents 列出 --agent 可用的子代理类型；缺省表示本次未注册任何子代理。'],
  1922: ['apiKeySource 来自 ApiKeySourceSchema，仅用于 UI 提示与遥测，不能作为鉴权成功的依据。'],
  1923: ['betas 是本次实际启用的 beta 标识，可能因服务端不支持而少于用户请求。'],
  1924: ['claude_code_version 是 CLI 版本号，宿主按它做兼容分支，不要用 package.json 版本代替。'],
  1925: ['cwd 是 CLI 进程的工作目录，与 hook 输入里的 cwd 同源。'],
  1926: ['tools 是可用工具名列表，已含 MCP 工具；顺序不保证稳定，不要按下标取。'],
  1927: ['mcp_servers 是连接状态快照，初始化未完成时可能只含已连上的部分。'],
  1929: ['name 是配置里的 server 名，与工具前缀 mcp__<name>__ 同源。'],
  1930: ['status 是自由字符串，与 McpServerStatusSchema 的枚举不同，不要混用两套取值。'],
  1933: ['model 是本次会话实际使用的模型别名，可能已经过服务端回退。'],
  1934: ['permissionMode 只反映启动时的模式，运行中可通过 setMode 变更。'],
  1935: ['slash_commands 是可用的斜杠命令名，不含前导斜杠。'],
  1936: ['output_style 是当前输出风格名，空串表示默认风格。'],
  1937: ['skills 是已加载的技能名列表；未启用技能时为空数组而不是缺省。'],
  1938: ['plugins 是已加载插件清单，元素含 name 与安装路径。'],
  1940: ['name 是插件名，内置插件同样出现在清单里。'],
  1941: ['path 是插件安装目录，宿主加载额外资源时以它为根。'],
  1950: ['fast_mode_state 缺省表示未启用快速模式。'],
  1951: ['uuid 标识这条 init 消息，用于与 transcript 对齐。'],
  1952: ['session_id 是后续所有消息的关联键，宿主应保存下来。'],
}

const numbers = Object.keys(plan).map(Number).sort((a, b) => b - a)
for (const n of numbers) {
  const target = lines[n - 1]
  if (target === undefined) throw new Error('line out of range: ' + n)
  const indent = (target.match(/^\s*/) || [''])[0]
  lines.splice(n - 1, 0, ...plan[n].map(c => indent + '// ' + c))
}

fs.writeFileSync(file, lines.join(eol), 'utf8')
console.log('inserted', numbers.length, 'anchors; total lines', lines.length)
