import fs from 'node:fs'

const file = 'd:/code/claude-code-main/services/settingsSync/index.ts'
const map = {
  64: ['DEFAULT_MAX_RETRIES=3 仅服务启动路径，redownloadUserSettings 显式传 0。'],
  96: ['先拉远端做比对：拉取失败就无法增量，直接放弃本次上传。'],
  97: ['fetchUserSettings 已内部重试，此处失败只记事件，不再重试。'],
  105: ['projectId 来自 git remote 哈希，null 表示只同步全局设置与用户记忆。'],
  106: ['本地条目按四个 key 收集：用户设置、用户记忆、项目设置、项目记忆。'],
  107: ['远端为空时以空对象参与比对，等价于首次全量上传。'],
  110: ['pickBy 只保留本地值与远端不同的 key，值都是字符串可直接不等比较。'],
  116: ['没有变更就不发 PUT，避免无意义的写入与埋点噪音。'],
  123: ['上传成功与失败都只记事件，调用方是后台任务，不感知结果。'],
  146: ['测试钩子只清引用，不取消在途请求。'],
  164: ['复用同一个 downloadPromise，并行调用者拿到一致结果。'],
  166: ['首次调用才真正发起请求，之后命中缓存。'],
  191: ['覆盖旧缓存：/reload-plugins 需要看到最新远端内容。'],
  214: ['maxRetries 决定总请求次数，0 表示只尝试一次。'],
  221: ['远端为空不算失败，返回 false 表示未应用任何设置。'],
  229: ['走到这里 data 必存在：success 且非空。'],
  237: ['落盘由 applyRemoteEntriesToLocal 统一处理，单文件失败互不影响。'],
  247: ['编译期开关关闭时直接 false，连诊断日志都不产生。'],
  261: ['非首方 API 或非首方 BaseURL 一律不同步，避免把设置发往第三方端点。'],
  265: ['只要求 user:inference scope，CCR 的文件描述符 token 不含 user:profile。'],
  272: ['端点由 OAuth 配置的 BASE_API_URL 派生，路径固定 user_settings。'],
  282: ['有 accessToken 才构造 Bearer 与 beta 头。'],
  291: ['无 token 时回传 error，由调用方标记 skipRetry。'],
  301: ['先刷新令牌，避免一次注定 401 的往返。'],
  304: ['鉴权头缺失按永久失败处理，重试没有意义。'],
  320: ['validateStatus 只放行 200/404，剩余状态码统一走错误分类。'],
  327: ['404 表示远端尚无设置，按成功且空处理。'],
  337: ['schema 校验失败不标记 skipRetry，但也不把半成品数据交给上层。'],
  355: ['classifyAxiosError 把错误分成 auth/timeout/network/unknown 四类。'],
  381: ['上界 maxRetries+1：3 次重试最多 4 次请求。'],
  384: ['成功立即返回，不再消耗剩余重试预算。'],
  388: ['skipRetry 标记永久失败，例如鉴权缺失。'],
  397: ['getRetryDelay 随 attempt 增长，避免瞬时打爆服务端。'],
  466: ['先 stat 再读，避免把超大文件整个读进内存。'],
  472: ['空文件或纯空白不参与同步，等于本地没有可上传内容。'],
  560: ['三个计数器只在真正写入成功后推进，用于驱动缓存失效。'],
  565: ['下载侧按字节数兜底校验，与上传前的 stat 上限一致。'],
  586: ['markInternalWrite 抑制变更检测，启动期写入不该触发热重载。'],
  639: ['只有设置文件真的写过才重置设置缓存。'],
  642: ['只有记忆文件真的写过才清理 CLAUDE.md 缓存。'],
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
