# L2-B7：bootstrap / zcode-protocol-v4（函数级 + 关键分支注释索引）

> 批次范围：`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/` 下全部非测试 `.ts`，共 **60 个文件**（含 `commands/` 子树）。
> 注释口径：每个导出函数/类方法/导出类上方 3~8 行说明职责、输入输出口径、副作用（durable 写入 / 事件广播 / ACK）、失败与降级语义、维护的不变量；锁序、幂等与 CAS、五种 delta 封闭集合单独成段。
> 基线：`d:\code\_annot_baseline\L2-B7\`（编辑前快照，保持相对路径）。基线取的是本轮开始时的**工作区**状态（工作区已存在与本批无关的未提交改动，本批未触碰）。
> 只新增注释行与紧邻空行；未改代码、缩进、import 顺序、字符串。

## 与大纲的对应

- 11.2 区域 A（命令准入与网关）：`command-inbox.ts`、`v4-gateway.ts`、`queue-auto-drain.ts`、`cold-session-resume.ts`、`commands/**`。
- 11.3 区域 B（投影与冷恢复）：`event-normalizer.ts`、`product-projection.ts`、`transcript-hydration.ts`、`cold-event-merge.ts`、`projection-*.ts`。
- 11.11 不变量 13~17：ACK 与 projection 分工、key gate → session gate、in-flight/live input 永远 pin、5 种 delta 封闭、live/cold 同一终态。

## 一、准入与网关（4）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `command-inbox.ts` | V4 命令 admission 唯一入口（in-flight / live input / settled 三表） | 锁序与 gate 生命周期、commandId 幂等、baseRevision/baseLogEpoch CAS、failed 终态不被 duplicate 覆盖、pin 与 per-session LRU | +46 |
| `v4-gateway.ts` | conversation / index / config 三类订阅与命令转交 | READY 水位、reserved topic frame、subscription ownership、handleCommand → inbox.execute → settle → ACK、hydration 入口、附件授权、会话回收 | +407 |
| `queue-auto-drain.ts` | 普通队列队首自动提升的纯判定 | 四条件闸门、queued/reserved/promoting 防双提升、fail-open 不另开旁路 | +15 |
| `cold-session-resume.ts` | 冷会话 runtime activation 的单飞协调器 | flight 生命周期、sessionNotFound 与 resumeFailed 结构化分型、disposeOnFailure 回滚 | +36 |

## 二、投影与冷恢复（10）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `product-projection.ts` | 会话产品投影唯一归约器 | 文件头扩写、5 种 delta 封闭集、snapshot/resync 边界、revision 记账、turn/流式/工具/交互/queue/goal/compact/fork 主干锚点 | +699 |
| `transcript-hydration.ts` | 持久 transcript/part → 等价事件序列 | 合成事实来源、与 live 共用 reducer、footprint 判据、pending 工具收口 cancelled、goal verification/subagent lifecycle | +140 |
| `event-normalizer.ts` | live/cold 事件 → canonical fact | 持久 messageId 优先的稳定身份、legacy 回退 + diagnostics、visibility/origin/placement、未知事件 stateOnly、空 toolName 透传 | +53 |
| `cold-event-merge.ts` | 冷恢复三源合并 | 合并顺序与幂等、durable 胜出/抑制、memory-only 保留、boundary 用持久 key 比对 | +96 |
| `cold-file-change-summaries.ts` | checkpoint → 单轮文件变更摘要 | checkpoint 串行聚合、afterContent patch、split turn 不兜底、artifact 失败降级 | +57 |
| `projection-rows.ts` | payload → 自包含 ConversationRow 的纯映射 | origin/状态映射、附件 ref 占位、32K head/tail 截断 | +71 |
| `projection-state.ts` | 初始快照、availability/inputRouting 派生、revision 判定 | 派生与 guard 同源、formal-proof 对照、revision 豁免键（usage/pendingCommands/workflowRuns） | +49 |
| `product-projection-bash-progress.ts` | Bash/MCP 进度与预览的纯 delta 投影 | 只修饰已存在行、终态不回退、统一清预览 | +23 |
| `stable-fork-target.ts` | 稳定 fork 目标判定 | anchor 优先级与顺序校验、不可判定 → forkTargetAmbiguous、惰性写回 | +47 |
| `replay.ts` | 浏览器回放导出桶 | 最小导出面、三段归约器复用、禁止自建 rows/availability 推导 | +5 |

## 三、命令执行（20）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `commands/input-admission.ts` | 输入准入与 held 裁决 | session_input 生命周期、Selection 过滤、admitted→promoted/cancelled/discarded/failed | +68 |
| `commands/input-intent.ts` | canonical 输入意图三入口 | 账本身份保真、sourceCommandId/queueItemId 锚点 | +39 |
| `commands/prompt-turn.ts` | 预检 → Core admission | ACK 边界、归因回滚、busy 判定只在 Core | +69 |
| `commands/executor.ts` | 命令分派 | admission 锚点、侧边会话守卫、ACK result 最小面 | +47 |
| `commands/types.ts` | 命令 handler 契约 | 权威来源、失败口径、可选能力降级 | +31 |
| `commands/attachment-refs.ts` | 附件引用 → TurnAttachment | 只读降级、不伪造正文 | +15 |
| `commands/record-access.ts` | 会话记录查找 | 缺失即拒、不降级 | +9 |
| `commands/handlers/index.ts` | 原生 handler 注册表 | type 唯一性、与 commandPayloadSchemas 同步 | +7 |
| `commands/handlers/canonical-intent-replay.ts` | edit/retry 的意图重发 | 身份保真、加速 Selection | +29 |
| `commands/handlers/session-mgmt.ts` | 创建/重命名/删除会话 | durable 事实、首条输入关联 | +30 |
| `commands/handlers/model-config.ts` | 模型/模式/thought 切换 | 同值 noop、半配置拒绝、串行 mutation | +45 |
| `commands/handlers/interaction-background.ts` | 交互应答与后台工作 | 先到者生效、迟到幂等、能力拒绝 | +59 |
| `commands/handlers/assistant-feedback.ts` | 助手反馈 handler | 行类型校验、durable 后不回失败 | +13 |
| `commands/handlers/queue.ts` | 队列操作 handler | dispatchState 状态机、admissionSeq 权威顺序、提升沿用 sourceCommandId | +69 |
| `commands/handlers/file-rewind.ts` | 文件回滚 handler | 破坏性命令不静默重发、plan/apply 边界 | +15 |
| `commands/handlers/fork-edit-retry.ts` | fork / edit / retry | 预检先于截断、不可重发语义 | +49 |
| `commands/handlers/session-flow.ts` | sendText / stop | ACK 只答接纳、stop noop、禁止静默重发 | +42 |
| `commands/handlers/selection-side-session.ts` | 选区侧会话 | child 账本隔离 | +15 |
| `commands/handlers/highspeed-metrics.ts` | 加速指标回填 | userInput 行锚定 | +12 |
| `commands/handlers/goal-compact.ts` | goal 与 compact | 落库与续跑失败、marker 状态映射 | +87 |

## 四、发布、遥测与索引（13）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `conversation-topic-publisher.ts` | 会话投影权威的 snapshot/delta 生成与多播 | seq/logEpoch 单调、5 种 delta、背压与 flush 合并、snapshot 只带尾部窗口 | +215 |
| `conversation-telemetry-facts.ts` | live 事件 → 观测事实 | 八类 fact、高频聚合、失败不阻塞主链路 | +48 |
| `conversation-telemetry-workflow-facts.ts` | 工作流进度 → 观测事实 | 锚点/终态、缺锚不发 | +12 |
| `conversation-workflow-run-deltas.ts` | workflowRun 增量的旧消费者编码与增长上界 | 整键 patch 位置、空批次、无法证明上界返回 null | +4 |
| `highspeed-metrics-persistence.ts` | 高速指标两阶段持久化 | transcript 权威、失败回滚、时间戳单调 | +26 |
| `local-ttft.ts` | 单命令 TTFT 时间线记录 | 只观测、有界表、异常吞掉 | +94 |
| `local-ttft-clock.ts` | 时钟不连续看门狗 | 回退/漂移、unref | +19 |
| `local-ttft-compaction.ts` | Compact 生命周期观测 | 同轮归并、无负时长、截断 | +10 |
| `sessions-index-projection.ts` | workspace 会话索引归约 | conflate、冷 seed 防降级 | +31 |
| `sessions-index-publisher.ts` | sessions-index 传输权威 | 单调 seq、有界重放、订阅代际 | +104 |
| `sessions-index-publisher-registry.ts` | workspace publisher 生命周期 | 同键串行、dispose 禁回写 | +36 |
| `sessions-index-fanout-throttle.ts` | 按会话 fan-out 节流 | leading+trailing、去重 | +22 |
| `workspace-config-publisher.ts` | 工作区配置整态广播 | revision/seq、幂等重放、快照降级 | +109 |

## 五、注册表、持久事实与杂项（13）

| 路径 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `persistent-command-index.ts` | session 级 lazy 幂等索引 | 优先级链（内存 → transcript → timeline → child → discarded）、精确 sourceCommandId、负结果不缓存 | +31 |
| `persistent-command-facts.ts` | durable 命令事实装载/写入 | 三处读源、四组索引、重启 discard 结算、覆盖写 | +42 |
| `interaction-registry.ts` | 交互应答登记表 | 先到者生效、token 去重、timer/队列清理、ACK 不等于 projection | +59 |
| `attachment-upload-registry.ts` | 分片上传 staging 表 | 生命周期、16/64MiB/5min 配额、begin/chunk/commit/abort 幂等 | +75 |
| `assistant-feedback-persistence.ts` | 反馈写入 transcript + event | 先落权威、append 失败补偿、durable 后不回失败 ACK | +27 |
| `create-session-command-fact.ts` | 从全局桶找回 createSession | promoted/admitted/终态三分、admitted 转 discarded、不猜测 session | +8 |
| `mcp-elicitation.ts` | elicitation ⇄ 用户提问 | 字段类型收敛、答案形状兼容、无法收敛即省略 | +19 |
| `cua-app-snapshot.ts` | CUA 工具名/入参与 App 列表解析 | pid 优先、bundle 唯一、非法条目跳过 | +38 |
| `cua-permission-observation.ts` | ToolCallResult → 权限观察 | 只认 live request_access、无法识别即 null | +8 |
| `model-config-mutation.ts` | 同 App 模型配置串行 | WeakMap tail、失败不污染后续、队尾守卫 | +7 |
| `task-list-session-membership.ts` | 任务列表可见性 | taskType 白名单、缺省 interactive | +9 |
| `topic-frame-reservation.ts` | publisher 两阶段提交句柄 | 所有权、supersede 后 commit 返回 false、水位不猜 | +9 |
| `index.ts` | v4 包导出桶 | 导出边界、不得反推内部实现 | +17 |

合计：**+3,573 行**（相对 L2-B7 基线）。

## 超 800 行清单

| 文件 | 注释后行数 | 说明 |
| --- | --- | --- |
| `product-projection.ts` | 6,433 | 只沿主干与 5 种 delta 加锚点，未逐行 |
| `v4-gateway.ts` | 4,099 | 按类方法与主干分支加锚点 |
| `transcript-hydration.ts` | 2,250 | 按合成事实来源与导出函数加锚点 |
| `conversation-topic-publisher.ts` | 1,353 | 按 snapshot/delta/背压/订阅代际加锚点 |
| `cold-event-merge.ts` | 975 | 按合并顺序与冲突口径加锚点 |

其余 55 个文件均低于 800 行。

## 校验

```powershell
git --no-pager diff --no-index --numstat `
  "d:\code\_annot_baseline\L2-B7\<相对路径>" `
  "d:\code\ZCode\<相对路径>"
```

- 60/60 文件删除列（第二列）为 `0`。
- 基线内容在修改后文件中按顺序完整出现（纯插入校验通过），新增行全部为 `//`、`/** */`、`*` 或空行。
- TypeScript `createSourceFile` 解析：60/60 `parseDiagnostics = 0`（注释闭合自检通过）。
