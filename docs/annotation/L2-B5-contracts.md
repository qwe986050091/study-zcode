# L2-B5：contracts 契约包（函数级 + 关键分支注释索引）

> 批次范围：`apps/zcode-cli/packages/contracts/src/` 下全部非测试 `.ts`，共 **120 个文件**（无 `.tsx`，无测试文件）。
> 注释口径：每个导出类型/接口/函数上方 3~8 行块注释，说明“固化的事实 / 谁生产 / 谁消费 / 跨进程与持久化不变量”；事件 payload 与投影 state 逐字段写口径；reducer 分支写“改变哪部分投影、为什么不能深合并”；已有文件头保留并扩写；纯 re-export barrel 不注。
> 基线：`d:\code\_annot_baseline\L2-B5\`（保持相对路径，编辑前快照）。校验方式：`git --no-pager diff --no-index --numstat <baseline> <current>`，逐文件删除列必须为 0。
> 合计新增 **+9289 行**，所有文件删除列 = **0**；4 个文件原本已超 800 行，1 个文件（`workflow/index.ts`）经注释后越过 800 行。

## 与大纲的对应

- 术语表（第七节）：turn / model step / part / ledger / settlement / cold resume / compact / steering / branchGeneration / checkpoint / stable fork / admission / trustState / fail closed / fail open / CUA frame。
- 不变量 #7（事件序号定序）、#8（compact 保留区间基于真实 SessionStore）、#13（reducer 幂等、合并键不重复）、#16（`session_input` 账本终态不可回退）、#17（branchGeneration 代际过滤）。
- 主链路：事件信封 → reducer 投影（链路 5 冷恢复）、session_input 账本 → message/parts（链路 5 持久化）、run/roster/hole → 工作流投影（链路 9）。

## 一、包根与横切契约（11 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `src/index.ts` | 契约包根出口 | 对外唯一入口、出口边界与命名稳定性、跨包 import 不得深入子目录 | +20 |
| `capabilities/index.ts` | capability 声明闭集 | 能力声明是准入依据而非展示标签、未知能力 fail closed | +6 |
| `commands/index.ts` | 自定义命令（slash command）契约 | 作用域解析优先级、diagnostic code 稳定值、元数据与来源可追踪 | +76 |
| `config/index.ts` | 配置键/值/作用域契约 | 层级优先级（system→user→project→session→CLI→env）、安全配置必须可溯源、未知键处理 | +70 |
| `errors/index.ts` | `CoreError` 类型与工厂 | 错误是一等对象、类型码做流程判断而非文案、retryable 只在明确可重试时置真 | +41 |
| `logging/logger.ts` | 日志级别与条目契约 | 级别语义（debug 不落盘）、context 字段口径、密钥/用户内容禁止入日志 | +78 |
| `network/public-egress-ip.ts` | 公网出口 IP 归一化与阻断 | IP 字面量归一、私网/保留段判定、SSRF 阻断原因码 | +29 |
| `path/git-bash.ts` | Windows ↔ Git Bash 路径转换 | 盘符/分隔符/转义的双向映射、仅用于 shell 边界的展示与传参 | +15 |
| `path/index.ts` | 纯 re-export | —（不注） | +0 |
| `plugins/index.ts` | 插件市场与宿主命令常量 | 官方/内联 marketplace 判定、manifest 身份、host command 属进程协议值不可改名 | +106 |
| `skills/index.ts` | skill 作用域/来源/诊断 | scope 与 source 不互替、诊断码稳定、policy 决定可见性而非执行权 | +49 |
| `time/local-date.ts` | 本地 ISO 日期格式化 | 用本地时区而非 UTC、仅展示用途不得参与定序 | +10 |

## 二、events：事件信封与投影（7 个 + 1 re-export）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `events/event-reducer.ts` | 事件 → `SessionProjection` 的唯一折叠入口 | live `apply` 与 cold `reduce` 共用同一 reducer；无状态纯函数、未知事件只推进 `updatedAt`、旧字段降级不丢历史 | +26 |
| `events/event-reducer-helpers.ts` | reducer 的投影基线与子投影写入器 | `initialSessionProjection` 冷启动基线、数组必须是新实例、流式账本/anchor/compact/后台任务各自的分支口径 | +15 |
| `events/session.events.ts` | 全部 session 事件信封与 payload 形状 | `sequenceNumber` 是唯一日志 cursor（timestamp 不定序）、payload 身份字段是幂等合并键、跨进程协议值不改名 | +597 |
| `events/stream-recovery.events.ts` | 流中断恢复的账本状态与恢复锚点 | `(attemptId, toolCallId)` 双键语义、anchor 只保留最近一个、discard 的稳定错误名/结束原因 | +97 |
| `events/in-memory-session-event-store.ts` | 内存事件存储（测试/嵌入用） | 顺序追加、`sequenceNumber` 单调、只做存储不做投影 | +18 |
| `events/session-event-retention.ts` | 事件保留策略与瘦身 | transient 事件窗口、sealed turn 宽限期、`slimRetainedModelRequest` 只瘦身不改语义 | +42 |
| `events/index.ts` | 纯 re-export | —（不注） | +0 |

## 三、hooks：hook 契约与工作区信任（3 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `hooks/index.ts` | hook 事件/输入/裁决/配置 schema | 事件名闭集与白名单同步、allow 不等于放行（只能收紧）、`hookSpecificOutput` 判别键必须与输入一致、patch 为整体替换不深合并 | +253 |
| `hooks/workspace-hook-trust.ts` | 工作区 hook 信任七态与准入映射 | 七态 → 四类准入的唯一映射、只有 `trusted_persistent` 可执行、摘要绑定失效即 stale、原因码可追加不可复用 | +103 |
| `hooks/workspace-hook-trust-store.ts` | trust store 契约门面与 runtime policy | schema 权威实现在 shared（禁止 zod3 重实现）、store 整体替换、损坏读侧 fail closed、`policyRevision` 做 CAS | +15 |

## 四、interfaces：会话、存储与账本（10 个 + 1 re-export）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `interfaces/session-store.port.ts` | 持久层端口：message/part/`session_input` 账本/标题/可见性 | `session_input` 状态机 `admitted→promoted/cancelled/discarded/failed` 与 `promoted_message_id` 外键；promotion 必须与 message/parts 同事务；终态不可回退；账本与 message 是分层事实 | +953 |
| `interfaces/session.port.ts` | 会话投影与运行态契约 | `SessionStatus` 只有 `TurnComplete` 能置 idle、steering 拒绝原因闭集、`branchGeneration` 代际过滤、权限模式继承 | +264 |
| `interfaces/shared.ts` | 跨模块 ID 与基础类型别名 | 各 ID 的生成者与消费边界、`traceId` 位于 `sessionId` 之上、不得用同型 string 互串 | +42 |
| `interfaces/session-mailbox.port.ts` | 会话级信箱端口 | 信封只投递不解释、顺序与去重由实现层保证 | +18 |
| `interfaces/input-history.port.ts` | 输入历史存储端口 | 历史条目是展示事实、附件只存引用、与 message 投影无耦合 | +26 |
| `interfaces/runtime-input-presentation.ts` | 运行时输入呈现 schema | 展示层字段可缺省、解析失败降级而不阻断输入 | +12 |
| `interfaces/topic-resource.port.ts` | 话题资源端口 | 资源按话题隔离、生命周期归宿主 | +17 |
| `interfaces/automation.port.ts` | 自动化（cron）端口 | 创建限额错误码、上下文与幂等键、失败阶段分类 | +38 |
| `interfaces/model-catalog.port.ts` | 可用模型目录端口 | 目录是只读快照、不得在会话内隐式刷新 | +8 |
| `interfaces/off-peak.port.ts` | 闲时任务端口 | 失败阶段/错误类别不可混用、配额失败与资格失败分流 | +25 |
| `interfaces/index.ts` | 纯 re-export | —（不注） | +0 |

## 五、interfaces：工作流 / 子代理 / 协作（11 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `interfaces/dynamic-workflow-run.port.ts` | 动态工作流 run 的提交/修订/查询契约 | `runId ≡ workId ≡ backgroundTaskId`、run 无独立 session（进度追加父会话）、run 与父会话投影不可深合并、拒绝原因闭集 | +292 |
| `interfaces/dynamic-workflow-run-hole.port.ts` | run 内的 hole 定位与填充 | `(siteId, ordinal)` 定位、只允许填本 run 拥有的 hole、诊断码稳定 | +35 |
| `interfaces/dynamic-workflow-run-retune.port.ts` | run 运行中调参 | 调参边界与拒绝原因、生效代际不可跨 run 泄漏 | +22 |
| `interfaces/dynamic-workflow-run-roster.port.ts` | run 的 phase/subagent 花名册视图 | 花名册是投影快照、lastTool/ask/wait 只表达最近事实、展示字段有界 | +65 |
| `interfaces/dynamic-workflow-run-workspace.port.ts` | run 工作区节点视图 | 节点状态机、结果查询按节点隔离、摘要与全文分离 | +50 |
| `interfaces/dynamic-workflow-snippet.port.ts` | 工作流片段求值端口 | 求值输入/诊断/结果形状、片段与 run 脚本的边界 | +36 |
| `interfaces/workflow.port.ts` | 静态工作流端口 | 任务状态快照是只读事实、启动请求与选项分离 | +47 |
| `interfaces/workflow-escalate.port.ts` | 工作流升级问题端口 | escalate 问题只升级不决策、结果三态 | +19 |
| `interfaces/workflow-submit.port.ts` | 工作流结果提交端口 | accepted/rejected 判别、violation 结构化、提交一次不可改 | +45 |
| `interfaces/subagent.port.ts` | 子代理启动/运行契约 | 子会话归属父 trace、隔离级别、请求与选项分离、取消语义 | +97 |
| `interfaces/coordinator-response.port.ts` | coordinator 响应端口 | 响应请求/结果只承载协作消息，不携带会话状态 | +21 |
| `interfaces/context-source.port.ts` | 环境与用户指令来源契约 | `EnvInfo` 是快照不回填、指令来源 scope 与优先级、project type 判定 | +95 |

## 六、interfaces：基础设施端口（11 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `interfaces/execution.port.ts` | 子进程/命令执行端口 | shell 方言与选择来源、超时/取消/截断语义、命令与展示分离 | +84 |
| `interfaces/file-system.port.ts` | 文件系统端口 | 错误码闭集（读/写/权限分流）、原子写入由实现层保证、路径规范化 | +70 |
| `interfaces/http-client.port.ts` | HTTP 客户端端口 | 重定向策略、egress 策略（出口信息）、错误细节结构 | +30 |
| `interfaces/image-processor.port.ts` | 图片缩放处理端口 | 缩放请求/结果、错误码、尺寸上限 | +38 |
| `interfaces/pdf-document.port.ts` | PDF 页数/渲染端口 | 页数探测与渲染分离、渲染结果引用、错误码 | +28 |
| `interfaces/browser-control.port.ts` | 浏览器后端与 CUA 控制端口 | 后端能力描述、会话上下文种类、CUA 占位 fail closed、帧与交互边界 | +100 |
| `interfaces/mcp.port.ts` | MCP server 配置与传输契约 | transport 类型闭集、协议版本、隔离级别、OAuth 凭据来源、运行时来源标注 | +117 |
| `interfaces/permission.port.ts` | 权限规则/更新/审批契约 | 规则行为 allow/deny/ask、能力分组、`PermissionUpdate` 只增规则、权限只能收紧 | +62 |
| `interfaces/permission-full-access.ts` | 全量放行的固定条目与回执 schema | 全放行是显式用户事实、回执可校验、不得由 hook 伪造 | +10 |
| `interfaces/provider-endpoint-routing.port.ts` | provider 端点路由决策端口 | 决策与解析选项分离、路由不得绕过 egress 策略 | +18 |
| `interfaces/tool-artifact-store.port.ts` | 工具大结果落盘端口 | 保留策略、读写请求/结果、二进制与大文本分流、引用而非内容回灌 | +31 |

## 七、model：模型请求与媒体契约（6 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `model/index.ts` | 模型请求/结果/用量/流事件总契约 | 请求字段口径（retry budget、usage summary）、`ModelNetworkStatusEvent`、流事件不可乱序、provider 无关 | +744 |
| `model/model.ts` | 模型属性、选项与请求结果形状 | properties/options 不互替、请求与结果对称、可选字段缺省语义 | +68 |
| `model/invocation-context.ts` | 模型调用上下文（auth/deps/trace） | AsyncLocalStorage 上下文、auth 来源可追溯、依赖注入边界 | +75 |
| `model/image-media.ts` | 图片 MIME 探测与 data URL 解析 | 魔数优先于声明、base64 大小上限、media type 归一 | +63 |
| `model/media-policy.ts` | 各 provider 可见媒体块判定 | 不支持媒体必须降级为文本占位、判定集中在契约层避免 adapter 漂移 | +63 |
| `model/content-protection.ts` | 内容保护标记 | 标记只表达“不得外泄”，不改变请求形状 | +12 |

## 八、telemetry 与 tracing（4 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `telemetry/index.ts` | 模型 API 遥测契约 | operation/actor/cause 闭集、schema 版本、字段脱敏、与 agent 层 operation 映射 | +393 |
| `telemetry/agent-execution.ts` | agent 执行遥测契约 | 操作/启动面/输入来源枚举、schema 版本、采样字段不携带用户内容 | +420 |
| `tracing/tracer.ts` | trace/span 上下文契约 | `traceId` 传播、span 父子关系、跨进程不丢上下文 | +138 |
| `tracing/local-turn-preparation.ts` | 本地 turn 准备阶段的观测事实 | begin/observe 成对、事实只读、失败不影响主流程 | +51 |

## 九、tools：工具契约（52 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `tools/contract.ts` | 工具副作用/权限/预算总契约 | sideEffectScope 闭集、workspace 变更判定、权限 pattern 来源、结果预算策略 | +96 |
| `tools/json-schema.ts` | 工具 JSON Schema 版本与归一化 | schema 版本号、归一化不得改变语义 | +15 |
| `tools/agent.ts` | Agent（子代理）工具输入输出 | agent 类型枚举、内容块结构、输出与 subagent 端口对齐 | +50 |
| `tools/apply-patch.ts` | apply_patch 工具 schema | 文件变更形状、diff 应用口径、失败整批回滚语义 | +31 |
| `tools/ask-user-question.ts` | 交互提问工具 schema | 选项/多选/自定义输入、chip 宽度为展示常量 | +47 |
| `tools/automation.ts` | cron 自动化工具 schema | 相对延迟判定、创建/更新输入、时间字段口径 | +61 |
| `tools/bash.ts` | bash 工具输入输出 | 后台执行、超时与输出预算、shell 选择 | +54 |
| `tools/create-workflow.ts` | 动态工作流创建工具 | saved source、参数与路径互斥、错误码 | +57 |
| `tools/deferred-tool-call.ts` | 延迟工具调用包装 | 固定工具名、wrapper schema 不承载业务语义 | +17 |
| `tools/edit.ts` | edit 工具输入输出 | 精确替换语义、diff hunk 结构 | +43 |
| `tools/escalate.ts` | escalate 工具输入输出 | 升级问题不携带决策、结果三态 | +15 |
| `tools/eval-workflow-snippet.ts` | 片段求值工具 | 超时上下限、错误来源标注 | +33 |
| `tools/fill-workflow-hole.ts` | 填洞工具 | hole 归属校验、诊断结构 | +14 |
| `tools/get-workflow-run.ts` | run 查询工具 | 查询输入、usage/actor schema、展示上限 | +82 |
| `tools/get-workflow-run-roster.ts` | roster 查询工具 | schema 与展示上限、状态枚举对齐端口 | +54 |
| `tools/glob.ts` | glob 工具 schema | 匹配模式与输出形状、结果排序稳定 | +32 |
| `tools/grep.ts` | grep 工具 schema | output mode 闭集、行号与上下文口径 | +42 |
| `tools/list-models.ts` | 模型列表工具 | 目录快照、条目字段 | +18 |
| `tools/list-saved-workflows.ts` | 已存工作流列表工具 | 只读列表、输出形状 | +11 |
| `tools/list-workflow-runs.ts` | run 列表工具 | 生命周期状态/停止原因闭集、limit 上下限 | +25 |
| `tools/node-repl.ts` | JS 执行工具 | 运行时输入与输出、执行边界 | +43 |
| `tools/off-peak.ts` | 闲时任务工具 | 任务状态枚举、创建输入、配额失败分流 | +44 |
| `tools/performance.ts` | 命令/文件系统执行遥测 schema | 状态与耗时字段口径、只观测不改行为 | +65 |
| `tools/plan-mode.ts` | 进入/退出 plan mode 工具 | 计划字符上限、两工具互斥、退出必须带计划事实 | +75 |
| `tools/read.ts` | read 工具与读取上限 | 字节/token/行数三重上限、图片缩放上限、截断标记 | +195 |
| `tools/read-pdf.ts` | PDF 读取工具 | 原生/抽取两种路径上限、页数限制、超时 | +52 |
| `tools/read-session-context.ts` | 会话上下文读取工具 | 策略枚举、token 上限、只读投影 | +68 |
| `tools/read-state.ts` | 已读文件状态 | 记录“读过什么”，防止写前未读 | +14 |
| `tools/resolve-workflow-question.ts` | 解决工作流问题工具 | 问题解析结果、三态输出 | +13 |
| `tools/respond-to-coordinator.ts` | 回复 coordinator 工具 | 内容长度上限、只承载协作消息 | +28 |
| `tools/resume-workflow-run.ts` | 恢复 run 工具 | 恢复前置条件与输出 | +10 |
| `tools/saved-workflow.ts` | 已存工作流文件布局常量 | 目录/扩展名/命名规则闭集、跨平台路径 | +49 |
| `tools/save-workflow.ts` | 保存工作流工具 | sentinel 冲突、overwrite 只是展示事实、错误来源 | +41 |
| `tools/send-message.ts` | 发消息工具 | 内容长度上限、目标与去重 | +28 |
| `tools/skill.ts` | skill 执行工具 | 结构化输出、runtime 输入 | +29 |
| `tools/submit-result.ts` | 提交结果工具 | 提交一次不可改、typed schema | +22 |
| `tools/target.ts` | Goal 目标与完成校验 | 状态机、目标字符上限、校验查询/兜底原因 | +95 |
| `tools/task-output.ts` | 后台任务输出工具 | 别名、提供者描述、输出上限 | +35 |
| `tools/task-stop.ts` | 停止后台任务工具 | 停止语义与输出 | +21 |
| `tools/todo.ts` | todo 工具 | 状态/优先级枚举、条目形状 | +46 |
| `tools/tool-result-metadata.ts` | 工具结果展示元数据 | schema 版本、各类展示上限、CUA/ MCP 展示键、不携带全文 | +130 |
| `tools/tool-search.ts` | 工具检索工具 | 检索模式、默认结果数、beta 标记 | +46 |
| `tools/webfetch.ts` | 网页抓取工具 | 重定向链条、输出形状、egress 约束 | +38 |
| `tools/websearch.ts` | 网页搜索工具 | provider 原生参数映射、来源结构 | +57 |
| `tools/workflow.ts` | 工作流工具脚本契约 | 脚本长度上限、runId 模式、输出状态 | +38 |
| `tools/workflow-observation-display.ts` | 工作流观测展示上限 | 日志/字符/actor/run 多层上限、截断策略 | +35 |
| `tools/workflow-settings.ts` | 工作流可调设置与模型绑定 | 绑定条数上限、调参 schema | +18 |
| `tools/write.ts` | write 工具输入输出 | 覆盖语义、diff hunk 结构 | +44 |
| `tools/index.ts` | 纯 re-export | —（不注） | +0 |

## 十、compact / rewind / workflow（4 个）

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `compact/index.ts` | 压缩触发、边界与时间线契约 | 触发类型、microcompact 策略、boundary payload 分段、checkpoint 不能充当 preserved segment anchor | +121 |
| `rewind/index.ts` | 回退范围/策略/目标状态 | 回退目标三态、branch cut 语义、scope 与 strategy 不互替 | +120 |
| `workflow/index.ts` | 静态工作流定义与运行状态 | 种类/phase/状态闭集、脚本章节模型、与动态 run 契约的边界 | +240 |
| `workflow/script.ts` | 工作流脚本元数据 schema | phase meta、agent 隔离级别、脚本元信息可校验 | +108 |

## 超 800 行文件（5 个）

| 文件 | 基线行数 | 注释后行数 | 说明 |
| --- | --- | --- | --- |
| `interfaces/session-store.port.ts` | 1273 | 2226 | 原本已超限；本批 +953 |
| `events/session.events.ts` | 1363 | 1960 | 原本已超限；本批 +597 |
| `model/index.ts` | 1095 | 1839 | 原本已超限；本批 +744 |
| `interfaces/dynamic-workflow-run.port.ts` | 1147 | 1439 | 原本已超限；本批 +292 |
| `workflow/index.ts` | 829 | 1069 | 本批注释后越过 800（+240） |

> 上述超限均为注释行导致；按仓库规范，文件行数超限属既有约束，本批未做拆分（任务要求禁止改代码）。

## 纯 re-export 未注（+0）

`events/index.ts`、`interfaces/index.ts`、`path/index.ts`、`tools/index.ts`。
