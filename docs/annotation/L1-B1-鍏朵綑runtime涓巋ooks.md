# L1-B1 其余 runtime 与 hooks——逐段密注索引

> 批次：L1 收尾批（函数体内逐分支中文注释）
> 范围：`apps/zcode-cli/packages/core/src/runtime/methods/` 中此前未被其他批次认领的 40 个文件，以及 `apps/zcode-cli/packages/core/src/hooks/` 中尚未注释的 12 个文件（其余 7 个 hooks 文件已由前序批次完成，hooks 19/19 全覆盖）
> 规则：只新增注释行与紧邻空行；未改代码 token、缩进、import 顺序、字符串；未格式化；保留已有文件头与英文注释
> 校验：逐文件 `git diff --no-index --numstat` 删除列全部为 0；全部新增行为注释或空行（脚本复核 0 例外）；总 +1469 行
> 说明：`sample-model.test.ts`、`session-persistence-concurrency.test.ts` 为测试文件，不在本批源码密注范围

## 文件清单（runtime/methods，40）

| 文件 | 注释主题 | +行数 | 对应链路 |
| --- | --- | --- | --- |
| `background-bash-output.ts` | 后台 Bash 输出的 runtime 薄转发：读取/取消语义与端口缺席降级 | 13 | 链路 3 |
| `background-stop-dynamic-workflow.ts` | workflow 停止唯一末端：port 缺席→不支持、未知/已结算 run→lost，先记 initiator 再 abort | 3 | 链路 8 |
| `background-stop-types.ts` | 停止结果与目标类型口径：`alreadyTerminal`、`strict`、existing/registryTask 双视图 | 4 | 链路 8 |
| `bash-shell-snapshot.ts` | session-start Bash shell 快照读写：裸 cmd.exe 特判、方言失效保留 staleSelection | 32 | 链路 5/7 |
| `browser-turn-screenshot.ts` | 轮次收尾补 Browser 终态截图：consume 每轮一张、part 先落库后补事件 | 24 | 链路 3 |
| `compact-active-helpers.ts` | compact 摘要阶段辅助：切分/重试/边界的纯函数口径 | 21 | 链路 4 |
| `compact-log-context.ts` | auto compact 决策的日志字段投影：稳定 schema，不参与决策 | 12 | 链路 4 |
| `compact-persistence.ts` | compact durable 事实与冷恢复收敛：boundary 是“已提交”唯一证据、summary 事务化 | 34 | 链路 4/5 |
| `config.ts` | runtime 配置面与会话级 getter/setter：workspaceRoot 定身份、workingDirectory 只管 cwd | 41 | 链路 0 |
| `context.ts` | Context 初始化、来源解析与历史前缀装配：就绪前输入暂存、skill 扫描失败降级 | 32 | 链路 5 |
| `context-usage-log-compact.ts` | context usage 快照的日志瘦身投影：只留诊断字段 | 19 | 链路 4 |
| `dynamic-workflow-activation.ts` | 动态工作流激活顺序：翻 runtime 状态→重注册→写 entry，entry 失败依赖历史补判 | 23 | 链路 8 |
| `dynamic-workflow-blocked-reminder.ts` | 空闲阻塞提醒：端口快照读取、pendingQuestions/holes 同源、入队失败降级 | 19 | 链路 8 |
| `dynamic-workflow-run-hole-notification.ts` | run hole 通知：读快照的 holes/scriptPath，迟到通知按 branchGeneration 丢弃 | 13 | 链路 8 |
| `dynamic-workflow-run-settings-turn.ts` | run settings 变更如何讲给模型/会话：入队与状态同步顺序 | 18 | 链路 8 |
| `embedded-search-branch.ts` | 内嵌检索分支对工具面的影响：三处共用判定、cachedTools 失效点 | 25 | 链路 10 |
| `goal-state-reminder.ts` | Goal 状态提醒延迟物化：避免 reminder 插进 tool_use 与 cancelled tool_result 之间 | 23 | 链路 8 |
| `goal-summary-title.ts` | Goal 摘要标题后台生成：写前重读校验 targetID、模型失败回落 objective | 45 | 链路 8 |
| `hooks.ts` | 生命周期 Hook 的 runtime 适配：SessionStart 一次性（失败不回滚）、续跑三重上限 | 59 | 链路 9 |
| `index.ts` | runtime 方法装配表：函数实现→prototype 绑定与分组语义 | 20 | 链路 0 |
| `model-request-session-type.ts` | 请求归因两个纯映射：session type 与 status sink 不混入主聊天 | 24 | 链路 1 |
| `model-streaming-event.ts` | 模型流式事件统一发射口：先 appendEvent 再入缓冲，保证数组只含已持久化事件 | 17 | 链路 1 |
| `plugin-reference.ts` | 插件引用 reminder 的 turn-start 注入：Session 注册表 + disallowlist 双过滤 | 22 | 链路 10 |
| `prompt-admission.ts` | prompt 准入唯一裁决点：start/steer/queue 三去向、reservation 同同步段、lease 例外 | 35 | 链路 7 |
| `reasoning-stream.ts` | reasoning delta 块合并：无 start 事件时保留 thinking 供 tool_result 重放 | 21 | 链路 1 |
| `rewind-message.ts` | 消息级 rewind：先取消旧分支后台任务并 fail closed，再写 revert/代际，最后 cascade 文件 | 55 | 链路 6 |
| `runtime-command-queue.ts` | runtime command 入队/排空：drain 单飞、promotion lease、两阶段 Stop 取消域 | 93 | 链路 7 |
| `sample-model.ts` | MCP App sampling 独立模型调用：schema 双端校验、模型由任务固定、失败也记 usage | 23 | 链路 10 |
| `session-shell-environment.ts` | session 级 Bash shell 选择与生效：选择持久化与事件顺序 | 25 | 链路 5/7 |
| `session-title.ts` | 会话标题编排：首条输入→sidecar→CAS 写回，custom 重命名优先 | 56 | 链路 5 |
| `shell-environment.ts` | resume 后 shell 变更提醒：判定条件与文案边界 | 17 | 链路 5 |
| `stable-fork-boundary.ts` | TurnComplete 前的稳定 fork 边界锚点：entry 缺失时返回空边界 | 23 | 链路 6 |
| `synthetic-notice-metadata.ts` | 合成 user notice 元数据：与真实用户输入的语义区分 | 32 | 链路 0/7 |
| `target-completion-verification-telemetry.ts` | 完成验证遥测包装：只归类并重抛，fail-open 决策留给上层 | 18 | 链路 8 |
| `title-generation-sidecar.ts` | 标题模型 sidecar：独立 60s 超时、不接 turn 取消、失败路径也写 usage | 52 | 链路 5 |
| `tool-part-metadata.ts` | ToolPart 完成元数据组装：状态字段口径 | 18 | 链路 3 |
| `turn-tool-warnings.ts` | 工具异常告警注入与事件：告警不替代工具结果（配对不变量） | 20 | 链路 2/3 |
| `workspace-checkpoint-persistence.ts` | checkpoint/文件撤销 durable 账本：事件与 artifact 的写入顺序 | 37 | 链路 5/6 |
| `workspace-fork.ts` | 消息点 fork 工作区：先复制消息/目标再动文件，同文件取最早 beforeContent | 34 | 链路 6 |
| `workspace-generate-text.ts` | 工作区级辅助模型调用（无 turn）：丢弃上游 maxOutputTokens、探测需 finish 收尾 | 31 | 链路 1 |

## 文件清单（hooks，12）

| 文件 | 注释主题 | +行数 | 对应链路 |
| --- | --- | --- | --- |
| `configured-runner-input.ts` | 配置 Hook 外部进程输入适配：payload/环境变量/超时的输入口径 | 48 | 链路 9 |
| `display-metadata.ts` | Hook 可展示元数据与文本脱敏：长度截断与凭证掩码 | 30 | 链路 9 |
| `index.ts` | hooks 包公共入口（barrel）：导出面即契约面 | 19 | 链路 9 |
| `output.ts` | Hook 输出语义归一与多 hook 合并：deny > ask > 后值，approve 只对权限事件生效 | 48 | 链路 9 |
| `runner-helpers.ts` | 执行器判定与错误工具：admission 每次现场求值，gate 抛错→blocked untrusted | 35 | 链路 9 |
| `session-mailbox.ts` | 会话邮箱未读消息接入 Hook 生命周期：未读边界与注入时机 | 25 | 链路 9 |
| `types.ts` | Hook 运行时对外契约（纯类型）：snapshot 只是装配输入，执行前仍需重验 | 30 | 链路 9 |
| `workspace-hook-policy.ts` | 工作区 Hook 策略存储与变更通知：策略收紧触发重评 | 27 | 链路 9 |
| `workspace-hook-telemetry.ts` | 信任链路观测出口：workspace 路径摘要化、保留 generation=0 | 23 | 链路 9 |
| `workspace-hook-trust-domain.ts` | 工作区 Hook 信任域子聚合：领域对象组合口径 | 14 | 链路 9 |
| `workspace-hook-trust-records.ts` | 审核选择冻结为信任记录：命令/路径/matcher/bundleDigest 的 *AtGrant | 23 | 链路 9 |
| `workspace-hook-trust-types.ts` | 信任存储与快照评估类型口径：trustState/securityRevision 字段语义 | 14 | 链路 9 |

## 超 800 行文件

- 本批注后无文件超过 800 行；最大为 `rewind-message.ts`（795 行，未触发 800 行规则）。
- 仓库中既有的超 800 行文件（`compact-active.ts`、`session-fork.ts`、`steering.ts`、`subagent.ts`、`turn-model-step.ts`、`turn.ts`）均由前序批次的已认领文件构成，非本批引入。

## 不变量引用分布（本批新增注释）

| 不变量 | 主要落点 |
| --- | --- |
| 1（tool_call 必有配对结果） | `turn-tool-warnings.ts`、`goal-state-reminder.ts`、`browser-turn-screenshot.ts` |
| 2（已提交内容不静默重放） | `compact-persistence.ts`、`model-streaming-event.ts` |
| 3（权限只能收紧） | `output.ts`、`hooks.ts`、`prompt-admission.ts` |
| 5（单 active turn / reservation） | `runtime-command-queue.ts`、`prompt-admission.ts` |
| 6（旧分支通知丢弃） | `rewind-message.ts`、`dynamic-workflow-run-hole-notification.ts` |
| 7（latest 指针先更新 / 冷恢复锚点） | `compact-persistence.ts`、`workspace-checkpoint-persistence.ts` |
| 9（续写提示 query-local） | `session-title.ts`、`title-generation-sidecar.ts`（相邻语义） |
| 10（hook 授权每次 dispatch 重验） | `runner-helpers.ts`、`workspace-hook-trust-records.ts`、`workspace-hook-policy.ts` |
| 11（CUA 无法 attest 时 fail closed） | `sample-model.ts`（MCP sampling 边界） |
| 12（fail-open 只用于裁判失败） | `target-completion-verification-telemetry.ts`、`goal-summary-title.ts` |
| 19（workspaceKey 管身份 / workspacePath 管执行） | `config.ts` |
