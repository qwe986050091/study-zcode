# ZC-DEEP-b67

> 批次：B67（12 文件，按 31.4% 口径计算目标 741 行；复算清单中 SavedWorkflowCard 按 31.0% 落点偏贴线，补 2 行后实际 +787）。
> 执行分三波：4 + 4 + 4（并发上限 5），每文件独立 spec。
> 基线快照：`d:\code\_annot_baseline\ZC-deep-b67\orig`；开工前 12 文件均为 `newComments=0`（30% 口径 needLines=739）。

## 校验

```
node zc-verify.mjs ZC-deep-b67
SUMMARY files=12 deletedNonZero=0 nonCommentAdded=0 starSlash=0 syntaxErrorFiles=0 added=787

node check-batch.mjs ZC-deep-b67 ZC-deep-b67-files.txt
TOTAL added=787 hardBad=0 suspicious=0
```

逐文件密度（`密度 / 总行 / 代码行 / 注释行 / 本次新增 / 路径`）：

```
31.23   340   253    79   65  packages/ui/src/MessageChangeSummaryPanel.tsx
31.23   343   253    79   65  packages/ui/src/v4/useV4SessionQuotaBanner.ts
31.30   511   377   118   65  apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts
31.30   512   377   118   65  apps/zcode-cli/packages/core/src/workflow/scheduler/collection-planner.ts
31.32   643   463   145   67  apps/zcode-cli/packages/adapters/src/config/index.ts
31.37   477   357   112   66  packages/ui/src/app-shell/WorkflowRunPhaseList.tsx
31.39   544   395   124   66  packages/desktop/src/host/serverRemoteConnection.ts
31.40   295   207    65   64  packages/ui/src/components/ai-elements/audio-player.tsx
31.53   486   352   111   66  packages/desktop/src/host/remoteMediaPreviewProxy.ts
31.54   382   260    82   66  packages/ui/src/lib/markdownFileLink.ts
31.76   339   255    81   66  packages/ui/src/ToolCallBlocks/renderers/get-workflow-run.tsx
31.88   308   229    73   66  packages/ui/src/settings/saved-workflows/SavedWorkflowCard.tsx
SUMMARY files=12 coreBelow30=0 needLines=0 min=31.23 median=31.38 newComments=787
PASS: all 12 file(s) >= 30% (mode=code)
```

## 明细

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | ---: |
| `ui/app-shell/WorkflowRunPhaseList.tsx` | 运行详情阶段脊线渲染 | INV-01~18；展开态与名册门都是组件局部集合；runningIds 由 runningKey 派生且只依赖该串；自动展开只做并集并保留原引用；落点键含 openedAt 保证只落一次；高亮定时器必须在 cleanup 清除 | 66 |
| `ui/components/ai-elements/audio-player.tsx` | 音频播放器组件族 | INV-01~18；media-chrome 是唯一渲染出口且不接管播放状态；媒体元素只能由 AudioPlayerElement 产出；AudioPlayerProps 用 Omit 去掉 audio；样式变量先写、调用方 style 后展开；自定义属性需断言 CSSProperties | 64 |
| `ui/lib/markdownFileLink.ts` | Markdown 文件链接解析 | INV-01~18；解析唯一入口是 parseMarkdownFileLinkTarget；URI 解码只允许一次且必须在 normalize 内；尾缀优先级为 hash 行、行列、纯行号；全部不匹配降级为无行号；file 协议只在 parseFileUrlPath 内处理 | 66 |
| `ui/MessageChangeSummaryPanel.tsx` | 消息变更汇总面板 | INV-01~18；turnSummary 优先 buildTurnChangeSummary 再兜底入参 summary；memo 依赖必须是 changeDetails 与 summary；单复数只看 fileCount 是否等于 1；count 必须传字符串；快照键取 snapshot.path；快照依赖只保留 changeDetails | 65 |
| `ui/settings/saved-workflows/SavedWorkflowCard.tsx` | 已保存工作流单卡 | INV-01~18；参数芯片上限只由 MAX_ARG_CHIPS 决定；超出折叠为 +N 徽标；argNames 取 Object.keys 保持声明序；entry.args 缺失按空对象兜底；徽标种类只由 savedWorkflowRunBadgeKind 归一；状态 switch 位于 never 早返回之后 | 66 |
| `ui/ToolCallBlocks/renderers/get-workflow-run.tsx` | 运行详情卡投影 | INV-01~18；一切事实取自 toolCall.raw 的 display；查询错误与运行失败必须分层；错误态丢弃旧 display；kind 必须等于 get_workflow_run；折叠行摘要 memo 只依赖 intl 与 run；有摘要才让摘要占折叠行 | 66 |
| `ui/v4/useV4SessionQuotaBanner.ts` | 会话额度横幅 hook | INV-01~18；providerId 与 modelId 先 trim 归一；纯空白 provider 退化为 null；四个 GLM 套餐 id 集中判定；运行态只认 prewarming 与 running；1005 只在 Start Plan 内接管；3008/3009/3010 必须叠加 Start Plan 边界 | 65 |
| `adapters/config/index.ts` | ConfigPort 进程内实现 | INV-01~18；get 三层回退链固定；本模块无缓存层；set 每次整体替换 sources 不追加历史；广播顺序单 key 在前、allHandlers 在后；订阅异常冒泡但 store 已写入；initial 一律以 System 写入 | 67 |
| `core/runtime/methods/target-completion-verification.ts` | 目标完成校验裁判 | INV-01~18；三道前置门各自 return null；null 语义是本轮不需验证；通过后 updateTargetStatus 紧跟 recordTargetChanged；completedTarget 用 input.target 兜底；模型快照只取一次；媒体策略投影在发请求前执行 | 65 |
| `core/workflow/scheduler/collection-planner.ts` | 可探索集合扩张器 | INV-01~18；plannerRunner 缺失返回空增量；每轮集合开头 throwIfAborted；阶段与 explorable 联合过滤；unseen 由已完成减去已分析；先写 lastCompletionAt 再重读集合；latest 从 nextSnapshot 重读 | 65 |
| `desktop/host/remoteMediaPreviewProxy.ts` | 远端媒体本机代理 | INV-01~18；token 是唯一访问凭据；scopeKey 固化 workspaceIdentity 与 remoteSessionId；lease 存活四条件同时满足；路径先 resolve 再判归属；格式与 expectedKind 双向一致；单文件上限在 prepare 固化 | 66 |
| `desktop/host/serverRemoteConnection.ts` | 远端物理连接封装 | INV-01~18；端点归一先剥 /ws 与 /ws/host 再拼接；协议只接受 http(s) 与 ws(s)；http 到 ws 换算只执行一次并回写协议；两条探测都经 authenticatedUrl；server-info 用 schema 校验；capability 同时要求 2xx 与 schema | 66 |

合计 **787**，与 `zc-verify` 的 `added` 一致。

## 关键不变量（抽取）

### 1. 阶段落点高亮定时器必须在 cleanup 清除

`WorkflowRunPhaseList.tsx` 在 effect 清理时同时清除定时器与 landed。
漏清会在卸载后仍写状态，控制台报更新已卸载组件，且再次进入时旧定时器抢先清空高亮。

### 2. URI 解码只允许发生一次

`markdownFileLink.ts` 把解码收口在 normalizeMarkdownFilePath。
多处解码会让含 `%25` 的路径被连续还原两次，最终指向不存在的文件。

### 3. 查询错误与运行失败必须分层

`get-workflow-run.tsx` 只在非运行且 status 为 failed 时判定运行失败。
合并两者会把一次查询超时显示成「工作流失败」，用户据此重跑本已成功的任务。

### 4. set 的广播顺序固定为单 key 在前

`adapters/config/index.ts` 先通知单 key 订阅者，再通知 allHandlers。
调换会让设置页整体刷新先执行，单 key 订阅读到已被覆盖的旧值。

### 5. 端点归一必须先剥结尾的 /ws

`serverRemoteConnection.ts` 先剥再拼固定路径。
不剥会拼出 `/ws/ws`，握手阶段直接 404，且错误信息里看不到真实原因。

## 与本批相关的故障模式

| 写错的位置 | 线上表现 |
| --- | --- |
| 阶段高亮定时器漏清 | 卸载后写状态，旧定时器抢先清空高亮 |
| URI 解码多次执行 | 含 %25 的路径被还原两次，指向不存在文件 |
| 查询错误并入运行失败 | 超时被显示为工作流失败，用户重复重跑 |
| 配置广播顺序调换 | 设置页读到旧值，单 key 订阅失效 |
| 端点未剥 /ws | 拼出 /ws/ws，握手 404 |
| 额度横幅 provider 不 trim | 空白的 provider 绕过套餐判定 |
| 完成校验前置门改为抛错 | 关闭验证的会话无法续跑 |
| planner 缺少 throwIfAborted | 取消后仍多跑完一个集合 |
| lease 只判过期不判 scope | 换代后旧快照仍被回传 |
| 参数芯片上限两处不一致 | 显示 3 个却报错误的剩余数 |

## 顺延

B67 复算清单共 20 个候选，本批取 12 个，其余顺延到 B68，开工前用更新后的工作树重新测量后确定。

> 说明：每文件独立 spec（≤150 行），4 文件一组并行（并发上限 5），逐文件密度校验。
> 目标行数按 `round(code × 0.314) − 当前注释行` 计算，实测 31.23%~31.88%，`suspicious=0`；
> `SavedWorkflowCard.tsx` 首轮落点 31.00，补 2 行后为 31.88。
