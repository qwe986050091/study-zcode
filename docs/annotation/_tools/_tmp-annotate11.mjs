import fs from 'node:fs'

const plans = [
  {
    file: 'd:/code/claude-code-main/services/mcp/config.ts',
    map: {
      1028: ["case 'project' 从 .mcp.json 的 mcpServers 读取查重。"],
      1039: ["case 'user' 从用户级配置对象查重。"],
      1050: ["case 'local' 从项目本地配置查重。"],
      1078: ["写入 project：目标文件是项目根 .mcp.json。"],
      1111: ["写入 user：更新用户级 mcpServers 条目。"],
      1127: ["写入 local：更新项目本地覆盖条目。"],
      1161: ["删除 project 条目：重写 .mcp.json 并清理空对象。"],
      1198: ["删除 user 条目：从用户配置对象里 delete。"],
      1220: ["删除 local 条目：本地覆盖不允许残留同名。"],
      1345: ["case 'project' 只聚合 .mcp.json，不合并 user/local。"],
      1423: ["case 'user' 返回用户级配置并带上校验错误。"],
      1448: ["case 'local' 返回项目本地配置并带上校验错误。"],
      1473: ["case 'enterprise' 读企业策略下发的 server 白名单。"],
      1674: ['servers 为空说明插件没有 MCP 条目，跳过。'],
      1682: ['mcpErrors 逐条转成 plugin 错误，供 UI 汇总展示。'],
    },
  },
  {
    file: 'd:/code/claude-code-main/services/policyLimits/index.ts',
    map: {
      118: ['loadingCompletePromise 已存在时保持单例，不重复建 Promise。'],
      123: ['只有 isPolicyLimitsEligible() 为真才创建加载 Promise。'],
      129: ['超时回调先确认 resolve 还在，避免加载完成后重复 resolve。'],
      166: ['非数组对象递归排序键名，标量直接返回。'],
      169: ['Object.entries 排序后重建，保证 jsonStringify 结果稳定。'],
      282: ['有 apiKey 时优先走 API key 鉴权。'],
      296: ['无 API key 时回退到 OAuth accessToken。'],
      417: ['safeParse 失败说明响应结构不符，按无效响应处理。'],
      436: ['switch(kind) 按 classifyAxiosError 的四类分派重试。'],
      468: ['磁盘缓存同样要过 schema，脏数据按无缓存处理。'],
      508: ['不合格直接返回 null，策略限制整体 fail open。'],
      525: ['拉取失败且存在旧缓存时沿用 cachedRestrictions。'],
      545: ['服务端给出非空限制才覆盖缓存，空对象视为无策略。'],
      599: ['无缓存时按未限制放行，返回 true。'],
      600: ['无缓存时仍先看 isEssentialTrafficOnly 的强制拒绝名单。'],
      611: ['缺失 restriction 视为无限制，放行。'],
      624: ['不合格直接返回 null，调用方按无缓存处理。'],
      663: ['加载完成后才刷新 sessionCache，避免半成品覆盖。'],
      686: ['清缓存后重新判断资格，不合格直接返回。'],
      722: ['轮询入口先判资格，避免无凭证时反复请求。'],
      735: ['序列化结果变化只记诊断日志，不刷新 UI。'],
      750: ['pollingIntervalId 非空说明轮询已启动，重复调用直接返回。'],
      754: ['不合格不启动轮询。'],
      764: ['cleanupRegistered 保证退出清理只注册一次。'],
    },
  },
  {
    file: 'd:/code/claude-code-main/services/remoteManagedSettings/index.ts',
    map: {
      106: ['已有 loadingCompletePromise 时保持单例。'],
      144: ['非数组对象递归排序键名，标量直接返回。'],
      147: ['Object.keys 排序后逐键重建，匹配 Python sort_keys。'],
      410: ['switch(kind) 按错误类别分派重试策略。'],
      495: ['不合格直接返回 null，远端设置整体 fail open。'],
      541: ['非空设置才覆盖缓存。'],
      575: ['ENOENT 表示缓存本来就不存在，不算错误。'],
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
