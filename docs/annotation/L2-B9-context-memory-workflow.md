# L2-B9：context / memory / workflow（函数级 + 关键分支注释索引）

> 批次范围：`apps/zcode-cli/packages/core/src/` 下 `context/`（14 个）、`memory/`（14 个）、`workflow/`（31 个）全部非测试 `.ts` 文件，共 **59 个**。
> `runtime/methods/dynamic-workflow-run-*` 已在既有批次认领（大纲第八节，`docs/annotation` 无重复批次），本批只覆盖 `workflow/` 目录内的引擎代码，故跳过。
> 目标：把文件头地图升级为函数级中文注释，重点回答"输入输出口径 / 副作用 / 失败语义 / 维护哪条不变量"，并写明上下文段落的来源、缓存口径与失效时机，以及 workflow 引擎的调度条件、重试与终止条件、进度事件。

## 与大纲的对应

- 链路 4（上下文预算与压缩）：`context/builder.ts`、`context/dynamic-sections.ts`、`context/sections/*`、`memory/recall/*`、`memory/dream.ts`、`memory/extraction.ts`。
- 第十节（内核扩展）：`context/sections/*`、`workflow/*` 与 `dynamic-workflow-run-*` 的深化；本批完成 `context`、`memory`、`workflow` 的 L2 化。
- 不变量落点：#1（tool_call 配对，见 memory-agent-loop）、#2（已提交内容不重放，见 recall/selector 迟到响应）、#6（分支代际，见 runtime 事件）、#7（latest 指针/恢复锚点，见 lifecycle/resume 语义）。

## 文件索引

| 路径（相对 `packages/core/src/`） | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `context/builder.ts` | Context Prefix 组装器（身份 + 动态段 + skills + meta user） | 三条身份路径互斥；stable/dynamic 分区与 ephemeral 缓存；meta_user 附件包装；customSystemPrompt 跳过默认体系 | +63 |
| `context/dynamic-sections.ts` | Desktop 行为 / Session Guidance / Output Style / Context Management 段 | 各段触发条件与空值语义；缓存口径；compact 提示与运行时判定边界 | +18 |
| `context/index.ts` | context 模块 barrel | 公开导出边界与内部分层 | +8 |
| `context/types.ts` | Context 段 / 构建配置 / 结果类型契约 | `ContextSource` 封闭枚举；字段口径；stable 段禁止动态内容 | +27 |
| `context/utils.ts` | token 估算工具 | 估算公式与除数来源；仅诊断不截断 | +10 |
| `context/sections/cli-prefix.ts` | CLI/product 短身份前缀 | stable 前缀；workflow actor 不注入；文案变更影响缓存 | +6 |
| `context/sections/current-date.ts` | 当前日期段 | meta_user/dynamic；按会话快照固定，跨零点不失效 | +6 |
| `context/sections/desktop.ts` | Desktop 宿主与 Gen UI 协议段 | stable；输出目录缺席语义；widget 数据不可信 | +10 |
| `context/sections/env-info.ts` | 平台 / cwd / 工作区 / git 环境段 | dynamic；执行模型口径；git 快照不自动刷新；仓库判定 | +24 |
| `context/sections/identity.ts` | 默认 agent 身份段 | stable；安全/Harness 文案逐字复用；outputStyle 只改开场 | +13 |
| `context/sections/memory.ts` | 记忆目录使用说明段（非记忆内容） | dynamic；default-index 才提示维护 MEMORY.md；过期记忆需先验证 | +11 |
| `context/sections/request-user-context.ts` | 用户指令 / 项目记忆索引 meta user 附件 | meta_user/dynamic；固定标题；来源归一化与截断标记 | +30 |
| `context/sections/skills.ts` | 可用技能清单段 | 预算不足降级而非截断；稳定排序；qualified/bare alias | +16 |
| `context/sections/workflow-actor.ts` | 工作流子代理身份段 | stable；persona 叠加顺序；工具面先于证据标准；产物通道 | +17 |
| `memory/directory.ts` | 幂等预创建 memoryRoot | 失败仅 debug 降级，不阻断上下文 | +23 |
| `memory/dream.ts` | 后台记忆整合的判定 / 锁 / prompt | 24h+10min 时间闸门；锁 mtime 与 PID 存活；只读 + rm 采集 | +108 |
| `memory/extraction.ts` | 记忆抽取判定与串行调度 | cursor 前进 / 不前进规则；coalesce 最新快照；skip 条件；快照读取失败降级 | +139 |
| `memory/index-content.ts` | MEMORY.md 索引生成与限额 | 200 行 / 25k 字符；先剥 frontmatter 再 lexer；只删顶层注释；截断退整行 | +53 |
| `memory/memory-agent-loop.ts` | 受限记忆 agent 循环与工具策略 | 两段式权限；拒绝也闭合 tool_call；工具目录完整下发；媒体投影用请求副本 | +114 |
| `memory/memory-file-path.ts` | 记忆文件路径边界解析 | contained 与 safe 两级；敏感段归一化（大小写 / ADS / 尾部点空格 / 双向符） | +53 |
| `memory/origin-session.ts` | 写入记忆时补 originSessionId | 只补一次；非 map/YAML 错误放行；保留 CRLF | +32 |
| `memory/project-memory-retrieval-branch.ts` | 检索分支编译期开关 | default-index 与 semantic-recall 口径；不可运行时翻转 | +26 |
| `memory/project-root.ts` | workspace 身份 → 记忆目录映射 | identity 优先；win32 小写；sha256 前 16 位防碰撞；slug 仅可读性 | +37 |
| `memory/recall/content.ts` | 召回正文读取与预算注入 | 200 行 / 4096 字节；截断提示带原路径；过期头；单文件失败丢弃 | +62 |
| `memory/recall/index.ts` | recall barrel 与会话配额 | 61440 字符配额；状态生命周期；路径去重 | +35 |
| `memory/recall/manifest.ts` | 扫描目录生成 manifest | filename 相对 POSIX 口径；mtime 来源；200 条新到旧；frontmatter 前 30 行；abort 不写缓存 | +91 |
| `memory/recall/selector.ts` | 辅助模型挑选记忆文件 | fail-open 空结果；abort 迟到响应不污染粘性对话；过滤已读 / 已召回；schema 二次校验 | +91 |
| `memory/recall/types.ts` | recall 共享类型与分类枚举 | 逐字段口径（filename/mtimeMs/revisionId/sizeBytes 等）；纯类型文件说明 | +43 |
| `workflow/definition.ts` | expert 工作流定义装载与校验 | schema 校验；版本兼容；阶段映射；默认策略口径 | +13 |
| `workflow/expert.ts` | workflow barrel | 定义 / 运行时 / 类型导出边界 | +2 |
| `workflow/lifecycle.ts` | 快照生命周期纯函数（恢复 / 取消 / 重开 / seed / prompt 更新） | 各转换输入输出、幂等与失败语义；只改 status 不抹历史 | +48 |
| `workflow/scheduler.ts` | DAG 调度循环 | 调度条件；并发与连续错误口径；completed / error_threshold / deadlock 终止；frontier 事件去重 | +30 |
| `workflow/expert/critic-loop.ts` | final critic 验收与打回重做 | 四条返回路径；maxReopens=2；迭代耗尽只置阶段 failed 不抛错；事件顺序 | +77 |
| `workflow/expert/failures.ts` | 错误 → WorkflowFailure 与恢复动作 | CoreError 优先 / 文本兜底；cause 链 8 层防环；recoverable/retryable 不变量 | +73 |
| `workflow/expert/formatters.ts` | 快照 → 人类可读文案 | 状态标记口径；稳定行解析；完成回执裁剪 | +30 |
| `workflow/expert/graph-artifacts.ts` | 阶段产物 → 图的两类增量 | 静默跳过 vs 抛错边界；闸门补边；先节点后边；changed=false 不落盘 | +54 |
| `workflow/expert/ids.ts` | phase 节点 / 边 / 文件名 / id 生成口径 | 双射与去重；空图退化；路径安全字符；终态集合 | +55 |
| `workflow/expert/phase-runner.ts` | 单阶段整段子会话执行 | 快照 → 图 → 事件顺序；迟到 session 回执丢弃；abort 不写 failed；失败两级落盘 | +48 |
| `workflow/expert/prompts.ts` | 提示词 / 阶段摘要 / 报告 / 初始图构造 | 只给路径不给内容；JSON 契约开关；空图退化；线性链 dependsOn+edges | +78 |
| `workflow/expert/retry-state.ts` | retry 前快照重放预处理 | 范围回退链；reconcile active；阶段重置丢弃字段；变更去重 | +41 |
| `workflow/expert/run-loop.ts` | 按 phaseOrder 推进 run 的主循环 | 跳过已完成；complete 即 break；abort→cancelled；其他→paused；报告先写后置状态 | +64 |
| `workflow/expert/runtime-context.ts` | 单 run 内存上下文与 store/事件代理 | 事件先落库后回调；快照补丁白名单；artifact/activity 去重；controller dispose | +173 |
| `workflow/expert/runtime.ts` | 命令门面 start/resume/retry/cancel/status/events | 状态准入；后台先写 running；cancel 先落盘再 abort；limit 边界语义 | +93 |
| `workflow/expert/scheduled-phase.ts` | 阶段级图调度适配与收尾 | 端口注入；planner 解析抛错；非 completed 抛错升级；摘要取调度后快照 | +47 |
| `workflow/expert/types.ts` | expert 运行时契约类型 | 命令参数口径；abort 穿透；reportPath 空值；别名兼容 | +123 |
| `workflow/expert/parsers/critic.ts` | critic 输出解析与提案去重 | 宽松 JSON 提取；verdict 归一；提案去重与非法项丢弃 | +47 |
| `workflow/expert/parsers/graph-seed.ts` | 图种子解析 | schema 校验；未知端点 / 自环 / 成环拒绝；失败返回 null | +62 |
| `workflow/expert/parsers/json.ts` | 模型输出 JSON 提取工具 | 思考 / 代码块剥离；括号配对；失败 undefined | +60 |
| `workflow/expert/parsers/node-prompts.ts` | 节点 prompt 更新解析 | 只接受已知节点；重复项去重；失败返回 null | +37 |
| `workflow/expert/parsers/planner-result.ts` | planner 结果解析 | 严格 schema；非法即抛错（与 graph-seed 相反） | +28 |
| `workflow/scheduler/collection-events.ts` | 集合事件常量 / 载荷类型 | 事件名与阶段绑定；消费方 | +29 |
| `workflow/scheduler/collection-planner.ts` | 可探索集合的规划与图合入 | 展开条件；frontier 目标；maxPlannerRuns；累计 errorCount；重复 / 自环 / 成环抛错 | +54 |
| `workflow/scheduler/collection-runtime.ts` | collection planner 运行时端口聚合 | 依赖注入边界 | +6 |
| `workflow/scheduler/events.ts` | 调度事件日志与快照写入 | 先快照 / 图记录再事件；时间戳统一 | +46 |
| `workflow/scheduler/graph.ts` | 调度视图与快照纯函数 | ready 口径；工程优先 + 集合轮转；完成口径 failed 不算；deadlock 诊断 | +102 |
| `workflow/scheduler/node-runner.ts` | 单节点执行与重试 | started → artifact → completed 顺序；失败 attempts 达 maxAttempts 才 failed；abort 不计数 | +28 |
| `workflow/scheduler/planner-expansion.ts` | 集合展开的图补丁 | 新节点 / 边 / 集合合入顺序；重复检测 | +46 |
| `workflow/scheduler/prompts.ts` | scheduler 提示词构造 | planner / 节点 prompt 注入位置；JSON 契约 | +30 |
| `workflow/scheduler/types.ts` | scheduler 依赖 / 运行结果类型 | runner / planner 端口；activity 结果；abort 传播 | +94 |

合计 **+2884 行**（59 个文件）。

## 校验

- 基线：`d:\code\_annot_baseline\L2-B9\`（编辑前按仓库相对路径快照）。
- 零删除：对 59 个文件逐一执行 `git --no-pager diff --no-index --numstat <基线> <当前>`，删除列全部为 **0**。
- 新增行性质：扫描全部 diff 的 `+` 行，仅包含 `//`、`/*`、`*`、`*/` 与空行，未夹带任何代码 token。
- 注释闭合：59 个文件 `/*` 与 `*/` 计数全部相等，块注释正文无未转义 `*/`。
- 语法自检：用 TypeScript `createSourceFile` 解析 59 个文件，`parseDiagnostics` 为 **0/59**。
- 超 800 行文件：**无**。最大 `workflow/lifecycle.ts` 667 行，其次 `workflow/expert/runtime-context.ts` 547 行、`context/builder.ts` 486 行。

## 关键发现

1. **上下文缓存失效口径**：`builder.ts` 把 section 分成 `cli_prefix`（独立 system 消息、不带 cacheControl）、`stable`（身份/custom prompt/workflow actor/desktop，合并为一条带 `ephemeral` 的 system 消息）、`dynamic`（desktop 行为、memory、env、git、date 等，另一条带 `ephemeral`）和 `meta_user` 附件。stable 正文或 section 顺序一变，provider 前缀缓存立即失效；dynamic 内容（cwd、git 状态、环境、技能清单）变化只影响 dynamic 块，不破坏 stable 前缀。`currentDate` 来自会话快照并按会话固定，跨零点不会触发重建。`customSystemPrompt` 不是"只替换正文"，而是整体跳过默认 system 体系与动态段。
2. **DAG 调度器有三个正常退出点**：全部可执行节点终结且无在飞节点 → `completed`；连续节点失败达到 `maxConsecutiveErrors` → 先等在飞节点收尾，再 `paused/error_threshold`；无 ready、无 active 但仍有阻塞节点 → `paused/deadlock`。成功结算会把连续错误计数清零，`frontier_changed` 只有在 ready/active/blocked 集合的序列化 key 变化时才发。
3. **expert 主循环的失败语义是"暂停而非失败"**：按 `definition.phaseOrder` 推进，已 `completed` 的阶段直接跳过（resume/retry 幂等）；遇到 `behavior === "complete"` 写报告后 `break`；普通异常统一转为 `paused` 并写入 `failure/recoveryActions`，只有 abort 才走 `cancelWorkflowSnapshot` 落成 `cancelled`。事件与快照顺序固定为"先写快照/图记录，再发事件"。
4. **critic 迭代耗尽不会终止 run**：`finalCritic.maxIterations=3`，节点重开预算硬编码 `maxReopens=2`。pass 或无提案或被拒时直接返回；迭代耗尽只把 `final_critic` 阶段置为 `failed` 并发出 `critic_iteration_limit_reached`，不抛错，后续 `complete` 阶段仍会写报告并把 run 置为 `completed`——critic 结论更接近"咨询意见"而非硬门禁，阅读时不要把它当作 run 成功与否的唯一判据。
5. **记忆召回是 fail-open 的**：selector 在 manifest 为空、全部已召回、模型调用异常、JSON 解析失败或 abort 迟到响应时统一返回空结果（不注入任何记忆），最多选 5 条，并过滤"本会话已读过文件"和"已召回路径"。召回正文按 200 行 / 4096 字节截断，单个文件读取失败只丢弃该文件；`memoryRoot` 目录预创建失败也只记 debug 日志，不阻断上下文组装。

## 附带观察（已在注释中标注，未改代码）

- `expert/runtime.ts` 的 `events({limit:0})` / 负 limit 经 `slice(-Math.max(0, limit))` 实际返回全量事件，调用方若想"不返回"需自行短路。
- `scheduler.ts` 传给 `node-runner` 的 `maxAttempts` 复用了 `strategy.executor.maxConsecutiveErrors`，节点级重试与调度器级连续错误阈值共享同一个数字，调整时需同时评估两侧语义。
