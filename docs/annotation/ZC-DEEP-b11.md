# ZC-DEEP-b11

> 批次：B11。基线快照：`d:\code\_annot_baseline\ZC-deep-b11a\orig`、`ZC-deep-b11b\orig`（两个子批并行，合并校验见下）。

## 校验

```
node zc-verify.mjs ZC-deep-b11a
SUMMARY files=3 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=1213

node zc-verify.mjs ZC-deep-b11b
SUMMARY files=2 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=906

deep-density --only b11a
30.37  2036  1505  457  403  packages/ui/src/settings/McpSettingsSection.tsx
30.60  1879  1425  436  418  packages/ui/src/settings/PluginsSection.tsx
30.92  1796  1310  405  392  packages/ui/src/GitActionMenu.tsx
SUMMARY files=3 coreBelow30=0 needLines=0 min=30.37 median=30.60 newComments=1213
PASS: all 3 file(s) >= 30% (mode=code)

deep-density --only b11b
33.08  2410  1735  574  443  packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts
34.12  2106  1483  506  463  apps/zcode-cli/packages/debug/src/App.tsx
SUMMARY files=2 coreBelow30=0 needLines=0 min=33.08 median=33.60 newComments=906
PASS: all 2 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `packages/ui/src/settings/PluginsSection.tsx` | 插件设置：市场列表、详情、安装/卸载与配置草稿 | INV-1~18；commands 折回 plugins；插件读写必须用目标服务解析而非当前 Provider；storeMatchesTarget 三键同时比较；不匹配时列表投影为空；storeItemById 是唯一合并点；详情渲染三条件；targetKey 变化清空选中；草稿 null 与 undefined 语义分离；空操作不发请求；失败保留草稿；启停单飞由 store 保证；卸载走确认流程并刷新 | 418 |
| `packages/ui/src/settings/McpSettingsSection.tsx` | MCP 设置：server 列表、连接状态刷新与 OAuth 轮询 | INV-1~16；workspace key 与 store 同构；不匹配时 servers/status 投影为空；projectionReady=false 只渲染 loading；refreshKey 空值清空 last；刷新经串行队列单飞；rerun 读 latestRun 而非重放闭包；发送前/响应后/合并前三处校验 key；status-only 仅用于 OAuth；unsupported 后双向标记并停止轮询；OAuth 是有界循环且 deadline 不续期；follow-up 上限 10 且需 key 匹配 | 403 |
| `packages/ui/src/GitActionMenu.tsx` | Git 操作菜单：提交、推送、分支切换的弹窗与状态 | INV-1~16；可用性只由 canUseGitActionMenu 决定；primaryAction 派生与置灰；commit 弹窗 state 是打开瞬间快照；提交禁用三来源缺一不可；identity null 与 false 语义不同；includeUnstaged 先 stage 再 commit；committed 只在成功后置位；失败不关闭弹窗不清 message；mutationPending 覆盖三个 await；关闭时一次性重置全部字段；打开先置 open 再 refresh；分支切换需同时刷新 Git 与弹窗状态 | 392 |
| `apps/zcode-cli/packages/debug/src/App.tsx` | 调试控制台：trace 列表/时间线、SSE 观测流与 URL hash 视图 | INV-1~14；选中 trace 必须落在列表内；查询串只由 buildQuery 生成；请求失败只写 error 不清数据；刷新按 180ms 窗口合并；每个 query 仅一条 EventSource 且卸载 close；请求按 id upsert 并截断 200 条；仅同 traceId 的抓包并入 span；vis-timeline 只创建一次并 destroy；选中 span 回落到首条；hash 是唯一外部真相；projectId 非空才写 localStorage；畸形 SSE 帧静默丢弃 | 463 |
| `packages/ui/src/v4/telemetry/conversationTelemetrySupervisor.ts` | 会话遥测监督器：事实去重、点击配对、串行上报与终态汇总 | INV-1~14；去重键为 sessionId+eventId；send_click 与 send_result 严格 1:1；后台 seed 无 click 直接跳过；等待渲染定时器双路径清除；agent_step 每个 detached 子代理只报一次；汇总后按 openToolCallIds 排空迟到终态；workflow 终态只认 run-settled；上报经 enqueueReport 串行且首条立即发起；reportTail 仅在仍是队尾时置空；前台判定按 session 引用计数；切后台清 stall 跟踪；未激活生命周期事实先缓冲 | 443 |

合计 **2119**（1213 + 906），与两次 `added` 之和一致。

## 关键不变量（抽取）

- 插件：`storeMatchesTarget` 必须同时比对 workspace key、authority、configScope，否则会把 A 的凭据渲染到 B。
- MCP：刷新必须串行，且发送前/响应后/合并前三处校验 workspace key，否则旧快照覆盖新状态、状态灯回退。
- Git：commit 弹窗 state 只是打开瞬间快照；commit 成功才置 committed，push 失败走独立文案，避免重复提交。
- 调试台：一个 query 只能对应一条 EventSource 并在卸载时 close，否则旧闭包会把旧数据覆盖到新面板。
- 遥测：send_click 与 send_result 严格 1:1，reportTail 只在仍是队尾时置空，否则并发上报反序、漏斗失真。

## 进度

本批前：5 文件全部 below30（needLines=1980）。
本批后：5 文件全部 ≥30%（min 30.37%、needLines=0）。
