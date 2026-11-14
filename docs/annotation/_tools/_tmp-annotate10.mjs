import fs from 'node:fs'

const plans = [
  {
    file: 'd:/code/claude-code-main/cli/transports/SSETransport.ts',
    map: {
      101: ['逐行解析字段，SSE 的 event/id/data 每个占一行。'],
      110: ['没有冒号的行不符合 SSE 规范，直接跳过。'],
      120: ['按 field 名分派，event/id/data 各有不同的拼接规则。'],
      121: ["case 'event' 写入帧类型，handleSSEFrame 据此判别 client_event。"],
      124: ["case 'id' 写入序号文本，readStream 稍后解析成 sequence_num。"],
      127: ["case 'data' 多行按换行拼接，符合 SSE 规范。"],
      352: ['没有 body 就无法读流，按普通断线交给 handleConnectionError。'],
      399: ['while(true) 由 done 或异常退出，读流是长连接主循环。'],
      401: ['done 表示服务端关闭流，跳出循环进入重连。'],
      407: ['按服务端发送顺序逐帧处理，保证序号单调。'],
      415: ['非数字 id 不参与去重，直接投递。'],
      416: ['seenSequenceNums 命中即重复帧，只告警不重复投递。'],
      431: ['集合超限后遍历裁剪，只保留距水位 200 以内的序号。'],
      432: ['低于阈值的序号已不可能再次出现，删除以控制内存。'],
      438: ['水位只增不减，乱序到达的旧帧不覆盖。'],
      460: ['abort 是主动 close 的信号，readStream 静默返回。'],
      541: ['closing/closed 后不再调度重连，避免关闭后又被拉起。'],
      642: ['livenessTimer 存在才需要清理，保持「有 timer 即计时中」的不变量。'],
      655: ['authHeaders 为空说明无凭证，直接返回避免发出注定 401 的请求。'],
      672: ['最多 POST_MAX_RETRIES 次，每次间隔指数增长。'],
      680: ['200/201 视为写入成功，剩余状态进入错误分类。'],
      766: ['reconnectTimer 存在才清理，close() 可能被重复调用。'],
    },
  },
  {
    file: 'd:/code/claude-code-main/cli/transports/WebSocketTransport.ts',
    map: {
      201: ['lastSentId 非空才带 X-Last-Request-Id，首连不带续传头。'],
      277: ['onData 未注册时丢弃消息，Transport 使用方应尽早注册。'],
      311: ['ws 已被 close 置空时直接返回，避免空引用。'],
      330: ['与 Bun 分支一致，Node 的 message 也只在 onData 存在时投递。'],
      440: ['isBunWs 决定摘监听用 removeEventListener 还是 off。'],
      468: ['ws 存在才需要 close，doDisconnect 可能被重复调用。'],
      488: ['只有 bridge 会话上报 closed 事件，print 模式不采样。'],
      519: ['4003 是 token 过期专码，才尝试 refreshHeaders 换新凭证。'],
      522: ['Authorization 真变了才算刷新成功，否则按永久失败处理。'],
      592: ['预算未耗尽才继续重连，elapsed 按总时长计算。'],
      630: ['只有 bridge 会话上报重连尝试，避免 print 模式刷事件。'],
      686: ['缓冲为空直接返回，没有可重放的消息。'],
      690: ['lastId 存在才做确认点匹配，否则全量重放。'],
      694: ['找到确认点才裁剪，lastConfirmedIndex 为 -1 表示服务端未确认。'],
      701: ['确认点之后无剩余消息时不重放，直接进入发送循环。'],
      719: ['messagesToReplay 为空则跳过重放，避免空转。'],
      732: ['逐条重放，顺序即原始发送顺序。'],
      735: ['success=false 说明连接再次断开，停止重放交给重连调度。'],
      829: ['connected 且有 ws 才探活，重连期间不发 ping。'],
      886: ['pingInterval 存在才清理，stop 可能被重复调用。'],
      902: ['keepalive 同样要求 connected 且有 ws。'],
      921: ['keepAliveInterval 存在才清理，与 stop 保持幂等。'],
    },
  },
  {
    file: 'd:/code/claude-code-main/services/lsp/passiveFeedback.ts',
    map: {
      30: ['case 1 是 LSP Error 级，映射成 error。'],
      32: ['case 2 是 Warning 级，映射成 warning。'],
      34: ['case 3 是 Information 级，映射成 info。'],
      36: ['case 4 是 Hint 级，按最低优先级 info 处理。'],
      229: ['通知里 firstFile 缺失或 diagnostics 为空时无法构造附件，直接跳过。'],
      277: ['failures.count>=3 才告警，避免偶发失败刷屏。'],
      304: ['注册路径同样以阈值 3 告警，与通知路径共用计数语义。'],
      341: ['只有 registrationErrors 非空才输出汇总，全成功保持安静。'],
    },
  },
  {
    file: 'd:/code/claude-code-main/services/settingsSync/index.ts',
    map: {
      229: ['result.success=false 表示拉取失败，不能拿半成品做比对。'],
      365: ['schema 校验失败即视为无效远端数据，不进入应用阶段。'],
      384: ['按 classifyAxiosError 的 kind 分派重试策略。'],
      385: ["case 'auth' 是鉴权失败，重试无意义直接跳过。"],
      391: ["case 'timeout' 可重试，按退避继续。"],
      393: ["case 'network' 同样可重试。"],
      423: ['attempt 超过 maxRetries 才判定耗尽。'],
      448: ['authHeaders.error 存在说明无凭证，直接标记永久失败。'],
      500: ['超过 MAX_FILE_SIZE_BYTES 的条目跳过，避免把超大设置上传。'],
      525: ['userSettingsPath 存在才处理用户设置文件。'],
      527: ['content 非空才写入，空内容等价于未设置。'],
      535: ['userMemoryContent 非空才写用户记忆。'],
      543: ['localSettingsPath 只在有项目上下文时存在。'],
      545: ['项目设置内容非空才写。'],
      553: ['项目记忆内容非空才写。'],
      567: ['parentDir 存在才创建目录，避免路径为空时 mkdir 当前目录。'],
      603: ['下载侧同样按 MAX_FILE_SIZE_BYTES 拒绝超大文件。'],
      615: ['userSettingsContent 非空才落盘。'],
      617: ['条件同时校验 userSettingsPath 与 exceedsSizeLimit。'],
      624: ['writeFileForSync 返回 true 才推进 appliedCount 与 settingsWritten。'],
      633: ['userMemoryContent 非空才写用户记忆。'],
      635: ['未超限才写，超限时记日志并跳过。'],
      636: ['写成功才推进 appliedCount 与 memoryWritten。'],
      647: ['projectSettingsContent 非空才写项目设置。'],
      649: ['项目设置同样校验路径与大小上限。'],
      655: ['写成功才推进 appliedCount 与 settingsWritten。'],
      664: ['projectMemoryContent 非空才写项目记忆。'],
      666: ['未超限才写项目记忆。'],
      667: ['写成功才推进 appliedCount 与 memoryWritten。'],
    },
  },
]

for (const { file, map } of plans) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const nums = Object.keys(map).map(Number).sort((a, b) => b - a)
  for (const n of nums) {
    const target = lines[n - 1]
    if (target === undefined) throw new Error(`${file}: line ${n} out of range`)
    const indent = target.match(/^\s*/)[0]
    lines.splice(n - 1, 0, ...map[n].map(c => indent + '// ' + c))
  }
  fs.writeFileSync(file, lines.join('\n'))
  console.log(`${file}: inserted ${Object.values(map).flat().length}`)
}
