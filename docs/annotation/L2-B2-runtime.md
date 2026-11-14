# L2-B2：runtime 非 methods 目录（函数级 + 关键分支注释索引）

> 批次范围：`apps/zcode-cli/packages/core/src/runtime/` 下 **methods/ 之外**的全部非测试 `.ts`，共 78 个文件。
> 排除项：`runtime/methods/**`（其他批次负责，本批未改动）；无 `.tsx` 文件。
> 注释口径：每个导出函数/类方法上方 3~8 行说明职责、输入输出、副作用（内存态/落盘/事件）、失败与降级语义、维护的不变量；非平凡分支内部说明“为什么”；关键类型字段写口径。
> 基线：`d:\code\_annot_baseline\L2-B2\`（编辑前快照，保持相对路径）。

## 与大纲的对应

- 链路 0（Turn 生命周期）：`agent-runtime.ts`、`internal*.ts`、`execution-state.ts`、`command-queue.ts`。
- 链路 4（上下文与压缩）：`helpers/compact*.ts`、`context-usage-breakdown.ts`、`runtime-reminders.ts`。
- 链路 5（持久化与冷恢复）：`helpers/provider-request-messages.ts`、`provider-mid-conversation-system.ts`、`conversation.ts`。
- 链路 6（rewind/fork）：`helpers/rewind.ts`、`steering.ts`、`turn-file-changes.ts`。
- 链路 7（steering 与命令队列）：`command-queue.ts`、`helpers/steering.ts`。
- 链路 8（Goal 续跑）：`off-peak/*`（闲时接管与闸门）。
- 链路 10（MCP/媒体/CUA）：`helpers/attachment-*`、`media-*`、`official-cua-media.ts`。
- 不变量：#1（tool_call 必须有配对结果）、#3（权限只能收紧）、#5（单一 active turn；reservation 关闭竞态）、#6（分支代际过滤）、#8（compact 保留区间基于真实 SessionStore）、#11（CUA 占位必须 fail closed）。

## 一、runtime 顶层核心（13 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `agent-runtime.ts` | `AgentRuntime` 实例骨架：字段装配、对外门面、方法挂载 | 声明合并结构（prototype 安装 methods）、三类事实分层、busy 判定字段必须同段复合读取 | +87 |
| `command-queue.ts` | 会话级 runtime command 队列 | 稳定 FIFO、仅 task-notification 可批量、两阶段取消标记、branchGeneration 代际过滤、纯内存不落盘 | +138 |
| `deps.ts` | runtime 层统一依赖门面（re-export barrel） | 依赖注入边界、可选端口、默认实现与 fail-closed 选择 | +61 |
| `execution-state.ts` | mode / planEnabled 的唯一写入口 | “durable entry → 内存 config → 事件”三段式、新会话跳过写入、Plan 与 active Goal 互斥、失败不吞 | +7 |
| `internal.ts` | `AgentRuntimeInternal` 内部契约聚合 | Core/Turn/Hook 交叉类型拆分、内部字段口径、方法安装边界 | +48 |
| `internal-methods.ts` | core 方法的内部契约 | 方法输入输出与 `this` 状态访问口径、调用方可依赖的最小面 | +68 |
| `internal-turn-methods.ts` | turn 方法的内部契约 | turn 生命周期方法的副作用与失败收口口径 | +49 |
| `internal-hook-methods.ts` | hook 生命周期方法的内部契约 | hook 准入/执行/回调方法的边界 | +54 |
| `model-selection.ts` | `ModelSelection` 浅拷贝工具 | 拷贝不共享引用、不可变使用约定 | +9 |
| `permission-full-access.ts` | 一次性“完全访问”放行（yolo）提交入口 | receipt id 幂等、durable→内存→事件三段式、传输取消后的边界、WeakMap 防重复应用 | +56 |
| `permission-grant-recovery.ts` | “已提交但未发布”的权限放行恢复点 | 恢复顺序、标记只作辅助事实且不得让恢复失败 | +28 |
| `session-mode-port.ts` | Plan Mode 工具访问 runtime 执行态的唯一端口 | 只读门、端口最小面、与 execution-state 的一致口径 | +37 |
| `types.ts` | runtime 对外与跨方法共享类型契约 | 字段分组与口径：busy/reservation/steering/goal/rewind/fork/contextUsage | +156 |

## 二、helpers：附件、媒体与 provider（23 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `helpers/agent-listing.ts` | 可用子代理列表的收集与注入 | 列表来源合并、注入时机、空列表降级 | +33 |
| `helpers/attachment-artifacts.ts` | 附件落 artifact 的可恢复/可直接发送形态 | `metadata.recoverability` 口径、只在可直接发送的两种形态落库 | +55 |
| `helpers/attachment-data-url.ts` | 解析 data URL 的媒体类型 | 只取逗号前头部、不解析正文、非法输入返回口径 | +25 |
| `helpers/attachment-image.ts` | 图片 data URL 归一（必要时缩放重编码） | mime 归一、缩放触发条件、artifact 复用时的两种 mime 口径 | +29 |
| `helpers/attachment-media-resolver.ts` | 媒体附件 → 模型可用媒体块的统一解析 | 能力投影→预算投影两阶段、当前真实用户附件保护、超预算错误码改写 | +119 |
| `helpers/attachment-path-reference.ts` | 路径引用（而非正文）交付的引用块 | 原因码枚举、路径可定位性、降级后模型仍可读 | +65 |
| `helpers/attachment-pdf.ts` | 严格解析 inline PDF data URL | 只接受合法 PDF、非法即失败（截断后不再是 PDF） | +24 |
| `helpers/attachment-placeholder.ts` | 无法发送正文的附件降级为占位文本 | 占位文案口径、保留可识别信息、不伪造正文 | +18 |
| `helpers/attachment-video.ts` | inline 视频附件校验与降级 | 超限降级为路径引用而非丢弃 | +22 |
| `helpers/attachments.ts` | 一轮用户附件的统一解析入口 | 上浮只跨普通 user 文本、非冒泡 source、媒体降级策略差异 | +108 |
| `helpers/child-client-ports.ts` | 子会话账本 + 父会话路由的双身份端口 | sessionId 使用子、路由使用父；嵌套时 origin 保留最内层 | +24 |
| `helpers/commands.ts` | `/compact` 等命令解析 | 三态返回、缺参/非法参数的错误语义 | +47 |
| `helpers/media-attachment-path.ts` | 给 provider 可读取的媒体补源路径 | 路径补齐条件、不可定位时不伪造 | +66 |
| `helpers/media-budget.ts` | 媒体字节预算投影 | 按编码后 UTF-8 字节、min(maxModelBytes,maxInlineBytes)、最新真实用户媒体受保护 | +151 |
| `helpers/media-capability.ts` | 模型媒体能力策略 | 能力声明→可发送媒体类型、未知能力保守降级 | +51 |
| `helpers/media-observability.ts` | 媒体诊断日志 | 全部 debug 级、生产不落盘、隐私字段裁剪 | +105 |
| `helpers/official-cua-media.ts` | 官方 CUA 栅格不可见时的占位文本 | 栅格 + image_ref 成对语义、fail closed 提示 | +26 |
| `helpers/provider-business-error.ts` | 识别 provider 响应中的业务失败事实 | 结构化错误码、与传输错误的区分 | +83 |
| `helpers/provider-entry-origins.ts` | provider 请求内“投影条目 → 原始条目”映射 | 来源映射口径、合并/追加后的索引重映射 | +65 |
| `helpers/provider-mid-conversation-system.ts` | mid-conversation system 条目落点 | 正文自行 sanitize+wrap、非法位置降级为 legacy synthetic | +105 |
| `helpers/provider-request-messages.ts` | provider 中性消息投影核心渲染 | latest real user 先算、metadata 剥离、cacheControl 最后写入 | +149 |
| `helpers/runtime-provider-request-messages.ts` | provider 请求组装统一入口 | 统一入口边界、投影与渲染职责分离 | +33 |
| `helpers/persisted-remote-session-path-repair.ts` | 远端会话路径污染修复 | 污染路径识别、修复幂等、失败不阻断会话恢复 | +58 |

## 三、helpers：compact、上下文与 project memory（18 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `helpers/compact-media.ts` | compact 摘要请求的媒体降级 | 图片/文档替换为占位、CUA raster 与 image_ref 必须成对替换 | +59 |
| `helpers/compact-post-reminders.ts` | compact 后补回“已读文件”上下文 | 补回范围、去重、与新 readFileState 的一致性 | +60 |
| `helpers/compact-preservation.ts` | “保留最近轮次”翻译成 durable 消息区间 | 区间口径、不可保留消息过滤、不得伪造指针 | +51 |
| `helpers/compact-selection.ts` | compact 切分选择层（纯函数） | 基于真实 SessionStore 消息、revert/branchCut 还原、末尾 N 个 assistant 轮次 | +167 |
| `helpers/compact.ts` | compact 编排层公共出口 | manual/auto/reactive 三入口差异、失败是否终止 turn | +80 |
| `helpers/context-usage-breakdown.ts` | 上下文用量分类的贡献者明细投影 | 分类互斥、Messages 不重复计 system/meta | +76 |
| `helpers/conversation-quotes.ts` | 用户输入在模型边界的附加材料拼装 | 引用块顺序、来源标记、不污染原始历史 | +34 |
| `helpers/conversation.ts` | 会话消息 ↔ runtime 条目 ↔ 模型内容块转换边界 | 转换方向唯一、不可逆点、metadata 保留口径 | +78 |
| `helpers/data.ts` | 外部 `unknown` 的类型守卫与安全读取 | 边界校验、缺字段降级、不抛错读取 | +30 |
| `helpers/gen-ui-output.ts` | 桌面端 Gen UI 产物目录解析与创建 | 路径解析、创建时机、失败降级 | +34 |
| `helpers/plan-file-continuity.ts` | 已批准计划文件的落盘与续接引用 | 落盘时机、续接引用格式、计划丢失时的降级 | +72 |
| `helpers/project-memory-agent.ts` | project Memory 后台链路的模型调用上下文装配 | 模型选择、`skipTranscript`、后台链路隔离 | +62 |
| `helpers/project-memory-dream.ts` | 后台记忆整合（dream/consolidation） | 文件 mtime 新鲜度、跨进程锁、改写后清空未消费 prefetch | +90 |
| `helpers/project-memory-extraction.ts` | turn 结束后的后台记忆抽取调度 | 边界用 latestConversationMessageId、同刻快照、revert 后边界失效 | +73 |
| `helpers/project-memory-recall.ts` | 语义召回的预取与注入 | settled/consumed 三态、注入即读写入 readFileState、consume 时二次过滤 | +110 |
| `helpers/project-memory.ts` | project Memory 是否启用/归属 workspace 判定 | 归属判定、开关优先级、无 workspace 降级 | +36 |
| `helpers/project.ts` | 会话标题与 ProjectId 确定性生成 | 确定性输入、稳定性要求、冲突处理 | +32 |
| `helpers/runtime-reminders.ts` | 运行时系统提醒的正文构建与注入节奏 | 两套 turn 计数口径、TodoWrite/提醒间隔、去重 | +123 |

## 四、helpers 其余 + off-peak + tool-result-settlement（24 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `helpers/index.ts` | helpers 统一聚合出口（barrel） | 仅扩写文件头：纯 re-export、无逻辑无状态、导出顺序不表依赖 | +17 |
| `helpers/model-anomaly.ts` | 一次 turn 内的异常告警账本 | 纯内存态、随 turn 存活、告警去重 | +65 |
| `helpers/model-errors.ts` | provider finish reason 与错误归一 | rawFinishReason 读取、业务/传输错误区分、错误码稳定 | +104 |
| `helpers/model-tool-call-validation.ts` | 模型工具调用校验上下文 | 校验输入口径、失败归因、与 executor 校验分层 | +41 |
| `helpers/permission-broker.ts` | 带结果回填能力的权限 broker | 端口扩展形状、回填一次性、默认 deny broker | +20 |
| `helpers/permission-grant-resume.ts` | 恢复时发布 pending permission grant | 不抛错（辅助事实不得阻断恢复）、发布顺序 | +11 |
| `helpers/rewind.ts` | rewind/fork 的纯数据辅助 | checkpoint 只认 Workspace/Both scope、messageId/targetMessageId/toolMessageId 三字段归属、diff 提取 | +174 |
| `helpers/runtime-tools.ts` | 运行时工具面的首次装配 | registry + hook + executor 装配顺序、一次性初始化、工具面刷新边界 | +88 |
| `helpers/steering.ts` | steering 上限、fork 克隆与 rewind 提示文案 | guide/queue 差异、上限与丢弃、克隆不共享引用 | +67 |
| `helpers/streaming-tool-ledger.ts` | 流式工具账本与恢复锚点的唯一发射器 | 状态机、按 (attemptId,toolCallId) 增量 upsert、只保留最新锚点 | +93 |
| `helpers/subagent-interaction-broker.ts` | 子代理交互 broker 的构造上下文 | broker 生命周期、与父会话交互路由 | +17 |
| `helpers/subagent-selection.ts` | 子代理启动的模型选择解析 | 显式 profile > 内部 override > 继承父模型 | +14 |
| `helpers/tool-allowlist.ts` | 运行时工具名单的唯一推导处 | 名单来源合并、模式/权限过滤、只影响可见性不替代权限 | +45 |
| `helpers/tool-result-media-persistence.ts` | 工具结果媒体块落 artifact | 全块可归类才整体持久化、任一不可归类返回 undefined | +56 |
| `helpers/tool-result.ts` | 工具结果与零值 usage 工具 | 零值占位、累加口径、结果形状 | +46 |
| `helpers/turn-errors.ts` | 轮次错误分类、收敛与终态事件 | 取消发 TurnComplete(cancelled)、真实失败才 TurnError、externalTurnFault 沿 cause 链穿透 | +45 |
| `helpers/turn-file-changes.ts` | 单 turn 文件变更累计与汇总 | additions/deletions 为 patch 累加过程量、有 afterContent 才用真实 diff、5s 超时 | +51 |
| `off-peak/lifecycle.ts` | 闲时执行状态机与票据寿命 | 仅当前 ticket 可换票、终态幂等、state_changed 去重、错误按 code 判定 | +185 |
| `off-peak/model-binding.ts` | 闲时请求凭据绑定与票据闸门 | 凭据绑定先于请求、票据闸门、过期换票语义 | +107 |
| `off-peak/runtime.ts` | 闲时执行在 runtime 上的挂载与闸门 | 接管/让位、pendingInputs 保守为 true、dispose 仅在未接管时恢复选择 | +164 |
| `off-peak/turn.ts` | turn 循环侧的 off-peak 接管钩子 | 钩子放置点、接管后不重复起 turn | +29 |
| `tool-result-settlement/contract.example.ts` | 契约调用示例（可运行签名样板） | 示例用途、与真实契约同签名、不得作实现依赖 | +19 |
| `tool-result-settlement/contract.ts` | 工具结果结算公开类型契约（纯类型） | 直接取 methods 实现的类型、单一来源、publicEntrypoints 边界 | +15 |
| `tool-result-settlement/module.ts` | 架构治理模块清单（声明式） | 仅扩写字段口径：公开入口、依赖方向、无运行逻辑 | +15 |

## 校验与统计

- 文件数：**78**；新增注释行合计：**+5014**；删除行合计：**0**。
- 逐文件执行 `git --no-pager diff --no-index --numstat <基线> <目标>`，78/78 删除列为 0。
- 额外扫描全部 diff 新增行：仅出现 `//`、`/*`、`*/`、`*` 注释行与空行，未混入代码 token。
- 超 800 行文件（注释后）：`types.ts`（1057 行）、`agent-runtime.ts`（823 行）。
- 无整文件跳过；`helpers/index.ts`、`tool-result-settlement/contract.ts`、`module.ts` 为纯 re-export/纯声明，仅补文件头或字段口径。
- 本批未修改 `runtime/methods/**`。

## 读代码后的关键发现

1. **busy 判定是多字段复合事实**：`activeTurn`、`activeTurnStartReservation`、`activeForegroundExecution`、`foregroundPromotionLease`、`runtimeCommandDrainActive` 必须在同一同步段读取；`admitPrompt` 同步建立 reservation 才能关闭跨 await 的第二条 turn 竞态（不变量 5）。
2. **完全访问放行是 durable 优先的三段式**：先用固定 receipt id 做幂等事务提交，再发布内存 `appliedGrants`，最后发事件；事务提交后传输取消不再生效。
3. **媒体处理是“能力投影→预算投影”的强绑定两阶段**：预算按编码后 UTF-8 字节计算，最新真实用户媒体受保护；只做一半会导致“模型不支持”或请求体超限。
4. **compact 保留区间必须回查 SessionStore**：runtime 条目数与库中消息数并非一一对应，直接按 runtime 计数切库会错位；无 SessionStore 时只统计数量、不伪造指针（不变量 8）。
5. **取消与失败在 turn-errors 统一收口**：取消发 `TurnComplete(resultType:"cancelled")`，只有真实失败才 `TurnError`；`externalTurnFault` 沿 cause 链识别远端故障，避免把外部故障记成本 runtime 失败。
6. **off-peak 换票不变量**：必须先完成 lifecycle 换票（同步 resolve 等票者），再更新内存凭据；读权威队列失败时 `pendingInputs` 保持 `true`，宁可判“还有工作”也不提前完成。
