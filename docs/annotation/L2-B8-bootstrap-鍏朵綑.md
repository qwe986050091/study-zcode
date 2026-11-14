# L2-B8：bootstrap 其余（除 zcode-protocol-v4）逐文件密注索引

> 范围：`apps/zcode-cli/packages/bootstrap/src/` 下除 `zcode-protocol-v4/` 外的全部非测试 `.ts/.tsx`，共 **223** 个文件。
> 目标：每个导出函数/工厂上方 3–8 行说明职责、输入输出、副作用、失败语义与不变量；装配/初始化顺序敏感处写清“为什么是这个顺序”；关键字段逐字段标注口径。
> 注释纪律：仅新增注释行与紧邻空行，未改动任何代码 token、缩进、import 顺序、字符串或格式化。
> 基线：`d:\code\_annot_baseline\L2-B8\`（保持 `apps/zcode-cli/...` 相对路径）。

## 与大纲的对应

- 第 11.7 节（横向能力：Provider registry、plugins/MCP、bots）：关注配置真相、revision 热更新、secret 不可回显、capability/命名空间/OAuth 两段式/工具目录 revision。
- 第 11.5 节（Window Host 与远程）：关注窗口/Host/connection/attachment 的层级、所有权、clientMode/seq/dispose，以及 workspaceIdentity 与 workspacePath 的分工。
- 本批不涉及 `zcode-protocol-v4/`（命令准入、ProductProjection、冷恢复属于另一批次）。

## 校验结果

- 逐文件 `git --no-pager diff --no-index --numstat <基线> <当前>`：**223/223 删除列为 0**。
- 新增行类型检查：**0 行**非注释新增（全部为 `//`、`/**`、`*`、`*/` 或空行）。
- 注释闭合：与基线相比，块注释 `/*` 与 `*/` 的差值变化为 **0**；新增块注释全部闭合，块内无未转义 `*/`。
- 总新增：见下表各行 `+行数` 之和。

## 一、app/ 装配、会话、workflow 与 provider 运行时

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `apps/zcode-cli/packages/bootstrap/src/app/app-config-options.ts` | CLI 权限/locale 覆盖与有效 locale 解析 | 覆盖优先级、`auto` 只改读结果、探测回退 | 38 |
| `apps/zcode-cli/packages/bootstrap/src/app/built-in-node-repl.ts` | node_repl 内建 MCP server 的注册判定 | 宿主 seed、能力门、缺失即不注册不回退 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts` | 把内置官方插件 seed 到 storage 缓存并给出 discovery 根目录 | seed 源优先级（SEA/文件系统）、锁与原子替换、旧缓存回退的两种 undefined 语义、marketplace 分区、mode 参与指纹 | 63 |
| `apps/zcode-cli/packages/bootstrap/src/app/bundled-skills.ts` | 内置技能包发现根（SEA 解压 / 文件系统探测） | 目录常量口径、SEA 资产前缀、解析顺序与失败降级、必需资产完整性 | 22 |
| `apps/zcode-cli/packages/bootstrap/src/app/cli-default-selection.ts` | CLI 默认模型选择与普通输入 intent 补齐 | 深拷贝、commandId/admissionSeq、临时路径放行 | 23 |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | 单会话 App 的主装配入口 | 装配链为何是此顺序、owns* 所有权与关闭顺序、失败逆序回收、返回对象 last-wins 合并、附件 data URL 解码口径 | 65 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-gate.ts` | 灰度关闭时按路径剔除 dwf SKILL.md | `disabledPaths` 唯一机制、路径不存在无副作用 | 11 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-import.ts` | 续跑时重建导入缓存（nodes/actors/world/ask 队列） | 导入只读、失败行不入缓存、inputHash 分桶与消费序 | 6 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-artifact-projection.ts` | journal 行 → 用户面 artifacts 的归并投影 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-artifact-queries.ts` | 用户面产物 journal 读面与能力探测 | 已有注释：产物读面独立探测、字段不做预览序列化 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-artifact-read.ts` | 用户面产物字节读回端口实现 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-compile.ts` | 编译一次：站点表 / schema / lowering 共用 Program | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-elapsed.ts` | lineage 活动时长求和 | 已有注释：undefined vs 0、墙钟钳非负、防环 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-fill.ts` | 补全脚本留白的串行流水线 | 顺序（找 run→分析→稳定性复核→编译→引擎→宿主事实）、拒绝零副作用 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-holes.ts` | 留白（hole）编译事实与运行事件投影 | 投影输入四字段的来源与汇合口径 | 6 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-introspection.ts` | listRuns / getRunDetail 只读投影 | 绝不替兄弟会话收尸、完整实现以保证端口必装 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-journal.ts` | run service 的 journal 能力探测与 store 窄化 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-label.ts` | run 展示标签派生 | 已有注释：name→首行→runId、绝不回写 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch.ts` | 编译产物 → harness 启动与结算 | submit/resume 载荷同形、事件钩子不得打挂 run、finally 清并发上界 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-launch-anchor.ts` | run 的持久身份锚点与 launch 记录 | 锚点跨修订不变的范围边界 | 6 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-lifecycle.ts` | 本会话 run 的结算 / 关闭 / 外来终态留痕 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-lineage.ts` | resumedFrom / supersededBy 两键投影 | 已有注释：仅 stopped 有效、缺席键不噪音 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-observation.ts` | 结算 → journal 收尾与状态投影 | settleOrAbort 永不 reject 且清理监听、终态三态映射 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-progress-payload.ts` | RunEvent → 会话事件载荷（有界化 + 派生字段） | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-progress-sink.ts` | run 进度写入父会话 transcript | 已有注释：身份闸门、永不抛、append 失败降级 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-reconcile.ts` | 孤儿 run 的构造时收敛 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-replay.ts` | run 的冷回放：journal → 与 live 同形载荷 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-retune.ts` | 在飞 run 并发上界就地修改 | 引擎先于内存副本、`not_live`/`unchanged` 判定位置 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-roster.ts` | run 情势截面：阶段 / 子代理 / 健康 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-roster-events.ts` | 情势截面的事件索引（一趟扫描求“多久以前”） | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-roster-phases.ts` | 阶段表与阶段状态归约 | 已有注释：归约状态计数、`unfinished` 仅终态 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-roster-subagents.ts` | 子代理花名册：每个 actor 实例在做什么 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-sequence-capture.ts` | appendEvent sequence 截取层 | 已有注释：引用相等核对、逐方法转发不展开 class | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-service.ts` | dwf run 端口聚合（submit/amend/resume/close） | journal 硬前置、构造即孤儿收敛、close 后拒绝提交、close 幂等 | 4 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-submit.ts` | submit / resume 两个入口 | 同步铸 id 与登记、绝不预插 dwf_run、结构化拒绝枚举、条目先于 launch | 11 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-workspace.ts` | 工作区 transcript 读面 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-snippet-service.ts` | EvalWorkflowSnippet 的生产实现（瞬态保真执行） | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/embedded-search-backend.ts` | 搜索后端 internal-cli / native-binaries 解析 | env 覆盖、bfs/ugrep/rg 三种二进制映射 | 18 |
| `apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts` | 输入门面（send/steer/queue/history/续跑） | admission 前先定执行边界、历史是旁路、cli-default 只影响本次绑定 | 23 |
| `apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-model-config.ts` | 旧 CLI JSON 的 zod 校验与窄投影 | 文件头边界、投影字段语义、解析失败与形状兼容 | 22 |
| `apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts` | 旧 CLI 用户配置 → Personal 层 / Environment 默认 | 迁移“全有或全无”、null 的失败语义、只迁 main | 12 |
| `apps/zcode-cli/packages/bootstrap/src/app/locale-selection.ts` | locale 写入目标选择 | 项目层优先、`hasUiLocale` 保持用户层来源 | 12 |
| `apps/zcode-cli/packages/bootstrap/src/app/model-catalog-port.ts` | 工具层模型目录端口实现 | 已有注释：每次现读 registry、默认档位同规、providerLabel 缺席 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/node-repl-browser-broker.ts` | node_repl MCP 与 BrowserControlPort 的本机 IPC | 句柄生命周期、token/socket 口径、env 注入的不可变约定 | 23 |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-cache-fs.ts` | 官方插件缓存目录的 FS 原语与重试 | Windows 瞬时错误边界、共享预算、原子写与失败清理 | 49 |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` | 内置官方插件静态定义表 | name+version 即缓存键、硬清单/候选目录/展示顺序、字段口径 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-runtime.ts` | 官方插件 seed 后 manifest / stdio 运行时重写 | SEA vs Node 宿主前缀、execPath/Node 模式、幂等写入 | 43 |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-seed-lock.ts` | 官方插件 seed 的跨进程目录锁 | 抢锁 / 僵尸锁 / 必释放、超时错误码判定 | 11 |
| `apps/zcode-cli/packages/bootstrap/src/app/paths.ts` | CLI 存储根与 ProjectId 推导 | `cli` 幂等、debug/rollout、identity 优先口径 | 30 |
| `apps/zcode-cli/packages/bootstrap/src/app/plugin-facade.ts` | App 级插件门面（本会话启用态镜像） | 为何需要本地副本、不重读磁盘、只读装配输入的边界 | 15 |
| `apps/zcode-cli/packages/bootstrap/src/app/plugin-runtime-features.ts` | 插件启用状态 → runtimeFeatures | 只返回开启键、不设 nodeRepl、文档根注入 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts` | 进程级 Provider Registry 三层事实源启动 | 装配顺序契约、standalone 所有权、逆序释放、快照约束 | 25 |
| `apps/zcode-cli/packages/bootstrap/src/app/prompt-input.ts` | Prompt 输入归一 / 附件外置 / 历史物化 | 形态不校验、video 投影限制、artifact 降级不阻断输入 | 28 |
| `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts` | Provider Registry → modelFactory | start 门、校验与索引一致即抛、requestAuth 透传 | 30 |
| `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.ts` | Registry 选择解析（配置意图 → 执行绑定） | 文件头事实源边界、“不拥有 vs 非法”、宽松/严格推理档位 | 47 |
| `apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts` | 配置真相 + 会话覆盖 → AgentRuntimeConfig | MCP 三层顺序、模型绑定与 resume 语义、输出字段口径 | 31 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-runtime.ts` | 脚本 workflow 子代理 runtime 构造 | 依赖边界、systemPrompt 叠加、模型 pin、client ports 所有权 | 21 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-child-source.ts` | 子进程 workflow DSL 入口源码字符串 | JSONL 协议、callPath、并行/管道失败语义、禁用墙钟 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-format.ts` | 脚本 workflow 统计 / 校验 / 运行的人类可读报告 | 零值兜底、逐字段相加、展示级降级 | 20 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-meta.ts` | 脚本 meta 提取、子进程求值与内容 hash | 截断/超时/schema 失败、稳定序列化、字面量扫描原因 | 22 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-methods.ts` | script workflow facade 与工具端口装配 | runtime 懒初始化、选项子集、共享实例 | 20 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-prepare.ts` | 定义 upsert 与 run 创建/恢复 | 定义 id 由 path+hash 派生、恢复不新建、argsHash 口径 | 18 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-process.ts` | 脚本 workflow 子进程 spawn 与 request/event 桥接 | 协议信封、stderr 有界、abort 优先、失败判定 | 17 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-runtime.ts` | legacy 文件型脚本工作流执行体 | 本地限流、callIndex 只由 validate 归零、执行失败收敛为记录、activity 全生命周期、store 能力探测 | 58 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-tool-port.ts` | WorkflowPort 后端（start/getTask/waitForTask） | 来源解析优先级、副本执行、脱离 turn 取消、两张快照表的生命周期、status 收敛 | 47 |
| `apps/zcode-cli/packages/bootstrap/src/app/script-workflow-utils.ts` | 并发闸、prompt 拼装、结构化输出、统计与作用域 | FIFO 名额转交、宽松定位/严格值、旧记录 token 回算 | 39 |
| `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` | 会话读写面（模式/模型/目标/MCP/资源关闭） | owns* 所有权、close 幂等与释放顺序、开始 shutdown→drain→停 run→并行关端口→关 store | 63 |
| `apps/zcode-cli/packages/bootstrap/src/app/session-store.ts` | 会话库打开 / 端口窄化 / 关闭 / dbPath | close 所有权、能力探测窄化、迁移进度旁路、相对路径基准 | 35 |
| `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts` | 独立账号的 Provider 运行时桥 | 私有凭据键口径、entitled 显式真假、请求期来源判定与迟到签发复核 | 45 |
| `apps/zcode-cli/packages/bootstrap/src/app/startup-marks.ts` | 启动计时与插件发现阶段标记 | 各 stage 事实、suppressedBuiltins / official 默认的顺序原因 | 19 |
| `apps/zcode-cli/packages/bootstrap/src/app/subagent-observation.ts` | 子代理转录只读投影（App 拥有存储语义） | 快照字段口径、parent 校验、分页夹取、重放占位 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/app/types.ts` | App 对外契约类型 | 借用/自有所有权、能力探测语义、sessionId→traceId→turn 层级、resume 边界口径 | 47 |
| `apps/zcode-cli/packages/bootstrap/src/app/visualize-skill-gate.ts` | 终端侧剔除官方 visualize 技能 | 按 pluginId 身份过滤、协议入口显式保留 | 13 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-model.ts` | workflow actor 的模型选择与 journal pin 解析 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-permission.ts` | workflow actor 权限模式映射 | 已有注释：plan→build、未知→YOLO、交互描述 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-tools.ts` | workflow actor 工具减法表 | 已有注释：悬挂、越权、递归、escalate 身份 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-actor-transcript.ts` | actor 转录边界计数与种子截断复制 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-artifact-publish.ts` | workflow 产物发布（校验/外化/原子写） | 已 L2 完备（顺序、可重试、时钟口径齐备），按"不重复"原则未增补 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-ask-epilogue.ts` | dwf ask 的质量尾注 | 已有注释：证据与尺度、schema 探测、escalate | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-concurrency-governor.ts` | 进程级并发治理器（桶/排队/动态容量） | 单例无 dispose 只退订、admit 仅 abort 拒绝、cap 唯一改写来源 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-default-concurrency.ts` | 默认并发公式与单 run 上界归一 | 已有注释：D 不是上限、floor 4、retune 同规 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver.ts` | workflow 引擎 ↔ AgentRuntime 驱动 | driver 生命周期与释放顺序、ask/submit/cancel 的顺序敏感、turn 收容链、身份互证外抛 | 46 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-concurrency.ts` | actor 并发观察面 + run 停滞时钟 | 双层闸门互不替代、chainKey 身份、stall 上膛/归零、退订配对 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-escalation.ts` | driver 的 escalate 问答桥接 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-helpers.ts` | driver 退避 / 调度 / 命名等纯辅助 | deferred 债务语义、unref 调度器 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-model-failure.ts` | turn 被拒时模型侧失败的策略收容 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-quiescence.ts` | dispose 会话释放与静默账本 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-submit-bridge.ts` | submit_result 会话级端口 | 已有注释：untyped 守卫、单 deferred、同步裁决 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-submit-profile.ts` | submit profile 运行时守卫 | 已有注释：mono 回退 generic、untyped 直接 askFailed | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-tool-activity.ts` | actor 工具活动观察（mutating / inFlight） | 每 ask 生命周期、事件四类、脱钩快照降级 | 9 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-tool-target.ts` | 工具调用 → lastTool 目标线索 | 已有注释：按入参键名探测、保头/保尾、认不出即缺席 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-transcript.ts` | amend-resume 的转录编排 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-types.ts` | driver 共享依赖 / 工厂 / SessionState 类型 | 既有注释已覆盖导出契约，未新增 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-escalation-registry.ts` | escalate 停驻表（park / resolve / withdraw） | 内存态理由、retire 先于 settle、256 条上限 | 15 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-facade.ts` | expert workflow 门面（store/runtime/child runtime） | 按定义版本缓存、child 共享与隔离、run 快照优先于请求定义、guarded 不被抹掉 | 38 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-git-world-read.ts` | git 只读命令与安全解析 | 空前缀是正常结果、错误在 runGit 层归一 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-methods.ts` | App workflow 门面与启动 / 查询方法绑定 | 启动五步顺序、expert kind 补全、trace 回退 | 15 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-run-control.ts` | run 活体控制句柄（引擎 + 座位闸门） | 空句柄后接线、引擎裁决优先、闸门后置 | 7 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-seat-gate.ts` | run 级 ask 座位闸门 | turn step 判定、工具侧放行、abort 归还、上限夹取 | 17 |
| `apps/zcode-cli/packages/bootstrap/src/app/workflow-world-read.ts` | world 读工具集（fs/git 受限读） | changedFiles 多计划并集、diff 截断可区分、status/log 的 argv 与上限口径 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-controller.ts` | Workspace Hook 审核流程控制器 | mutation 串行、generation 单调、写前/写后失败分界、superseded→requested 事件顺序 | 56 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-mutation.ts` | 审核后 toggle 的串行写端口 | 路径/身份字段口径、重载而非打补丁、三类失败、进程内锁 | 19 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-request.ts` | 审核快照 → 协议 review 请求投影 | 逐项展示口径、pending 计数、digest 映射、关联键 | 20 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-revoke.ts` | 撤销 workspace hook 持久/即时信任 | 策略门、先落库后内存、异常收敛为 store_corrupt | 19 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-supervisor.ts` | review flow 监管至终结 | 唯一 await 点、supersede 链、timeout 补齐事件 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-telemetry.ts` | 审核链路遥测事件出口 | 事件语义契约、identity 取当前值、不含敏感内容 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-review-types.ts` | review 端口与生命周期事件类型 | 四类事件、信任存储写面、命令结果码、可注入时钟/ID | 38 |
| `apps/zcode-cli/packages/bootstrap/src/app/workspace-hook-trust.ts` | Workspace Hook 运行时安全面 | 三层启用条件、rollout 关闭行为、fail-closed 加载 | 17 |

## 二、zcode-protocol/ 协议服务、映射与 MCP UI

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/account-provider-config.ts` | Account Provider 覆盖/Registry 刷新 | 端口在场即开启（-32018/-32019）、失败语义 | 4 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/ai-sdk-warning-logger.ts` | AI SDK 告警重定向到 logger | stdio 帧通道保护、异常吞掉 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/automation-port.ts` | automation 端口装配 | Cron 工具→反向请求、递归/绑定边界、创建上限错误 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/background-work-owner.ts` | 沿 parentID 链查后台输出所有者 | 不恢复 runtime、归属校验 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/browser-control-broker.ts` | 浏览器控制端口装配 | 端口方法转发、会话级路由 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/computer-use-operation-event.ts` | 会话事件→CUA 操作事件投影 | 白名单事件、字段容错 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/dynamic-workflow-policy.ts` | 动态工作流灰度缓存与 create 门 | Host 判定、fail-closed、显式布尔 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/fork-model-selection.ts` | 派生会话 Selection 推导 | 深拷贝、兜底合并、跳过加速选型 | 9 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-broker.ts` | 交互请求 broker | 反向 elicitation/permission、deferred 竞态、abort 清理 | 19 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-preferences.ts` | workspace 交互偏好应用 | 先缓存后 registry、挂起计数 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/interaction-response-race.ts` | legacy 请求与 v4 交互应答竞速 | 注销/监听收尾、fullAccess 失败等待 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mapper.ts` | 映射纯函数门面 | re-export 边界 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp.ts` | mcp/list 与 OAuth 快照轮询 | 配置合并优先级、status/connect、5s 预算 | 15 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appTools.ts` | MCP App 工具注册/调用/claim | token+generation 实例凭证、claim/call 双计时、同 server 只暴露最大 seq 实例 | 47 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appToolsContract.ts` | App 工具登记/认领/结算契约 | 字段语义、代际与幂等 | 7 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/appToolsProtocol.ts` | 工具登记表与四个协议方法 | context 级登记表、live-only 信箱、清理顺序 | 31 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/contract.example.ts` | 内存示例 session 视图 | 示例覆盖的口径 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/contract.ts` | 处理器/session 视图契约类型 | 字段语义、错误类、归属校验 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/handlers.ts` | MCP UI 资源/采样/工具请求处理 | 实例校验、资源读取与订阅、采样/工具调用取消路由 | 44 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/index.ts` | mcp-ui 对外 re-export 入口 | 子模块分组与入口约定 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/instances.ts` | App 实例凭证/代际/在途 pin | 槽位复用、validate 撤销、pin/close | 24 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/module.ts` | 架构清单（requires/provides/入口） | 注册门语义、入口白名单 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/notifications.ts` | server 通知→会话 live-only 事件 | 逐订阅者跳过、订阅键校验 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/protocol.ts` | MCP UI 协议 schema 与事件映射 | 方法常量、订阅键 sessionId+scopeId+generation、通知映射 | 43 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/resourceContract.ts` | 资源/订阅契约与订阅键 | cursor、键格式与解析失败 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/samplingCalls.ts` | sampling 账本/并发额度/取消 | 去重、三重额度、终态不复活 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/samplingProtocol.ts` | sampling 协议入口 | 进程级账本、前后 validate、-32000 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/mcp-ui/sessionAccess.ts` | session record→最小端口视图 | guard 前后验凭证、signal 合并、pin | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/message-mapper.ts` | 消息与 part 映射 | tool part 终态、artifact URL、附件字段 | 11 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-execution.ts` | 执行上下文 re-export | 转发边界 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-io-preferences.ts` | ModelIO 写盘偏好应用 | 进程偏好+逐会话 adapter | 1 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/model-mapper.ts` | 模型选型字符串格式化/解析 | 表示口径、非法即抛 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.ts` | 官方 MCP 鉴权头反向请求端口 | 不落凭据、requestId/signal | 3 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/offpeak-port.ts` | 闲时任务创建/列表端口 | 递归守卫、会话绑定、失败分类透传 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/off-peak-tool-policy.ts` | 闲时工具灰度缓存 | 只影响新 record、纯内存 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/permission-options.ts` | 权限选项 re-export | 投影边界 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-reference-catalog.ts` | 插件参考目录与建议解析 | 目录过滤、suggested ref 解析 | 4 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugins.ts` | 插件管理 op | 安装/市场/配置写入、operationId 取消、校验 | 11 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/plugin-ui-surfaces.ts` | 插件 UI 面摊平与协议入口 | 禁用跳过、只读投影 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/process-child-processes.ts` | MCP 子进程列表投影 | 归属补齐、无 I/O | 1 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/protocol-mcp-config.ts` | 协议 MCP 配置→运行时覆盖 | name 索引、字段保留 | 6 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/provider-runtime-headers.ts` | 模型请求前刷新 provider 身份头 | 端口在场即开启、-32022/-32031 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/resource-sampler.ts` | 60s 资源采样与顺带清理 | 三件事、best effort | 7 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/runtime-cleanup.ts` | 协议进程统一清理 | 逆序、共享 deadline、mcp 双路径 | 7 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/runtime-resources.ts` | app 资源 owner（创建/停机闸门） | 幂等 close、EOF 竞态回收 | 11 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/saved-workflows.ts` | 已存工作流 CRUD | 列表/读取/移动/元数据更新与排序 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/saved-workflows-run.ts` | run journal→保存/查找工作流 | 记录缺失、候选跳过 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` | 协议 server 类与请求分派 | 生命周期、反向请求 pending/重发、v4 与旧通道分派 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | session/workspace 操作实现 | 创建/恢复闸门、send 立即 ACK、stop/compact/goal、事件统一入口 | 37 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-types.ts` | 协议 server 上下文与共享类型 | context 结构、错误码、参数解析、session record 字段口径 | 97 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-debug.ts` | 旁路观察与 debug 快照查询 | 有界状态、只读不恢复 | 7 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts` | snapshot/投影/事件映射 | DB goal 权威态合并、context usage、todo 分组、settings 有效性 | 21 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-residency.ts` | resident pool host 适配 | 五类阻塞源、去激活清理 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts` | 会话驻留池与 LRU 水位 | lease 引用、activeOperationCount>0 不 rebalance、deactivation 收尾 | 40 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/skill-reference-catalog.ts` | 技能引用目录 | session authority/现场发现、只读 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/slash-commands.ts` | `/` 命令目录装配 | 灰度剔除、发现失败降级 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/startup-resource.ts` | 启动资源获取与关闭竞态 | 迟到资源释放 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/storage-startup.ts` | 存储握手/迁移状态上报 | attempt/databaseId、ACK 顺序、失败上报 | 4 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-session-query.ts` | 子代理会话查询 | child 收集、游标分页、live 与持久化合并 | 22 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/topic-resource-port.ts` | topic 资源反向请求端口 | requestId/cancel/trace、超时 | 7 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts` | NDJSON 传输与帧队列 | 串行主队列、stop/cancel/MCP App/反向 response 旁路、错误收敛 | 72 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts` | usage 快照构建 | tz 偏移、窗口聚合、空 store 零值 | 15 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` | v4 gateway 与协议 server 绑定 | 命令执行、冷恢复、队列自动提升、帧出口 | 9 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-workspace-config.ts` | v4 workspace 配置投影 | 只投影 mode、live 快路径 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workflow-settings-answer.ts` | 工作流确认窗设置调整提取 | 仅 allow、解析失败不阻断 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace.ts` | workspace ref 构造与 ID 还原 | key/path 分离、remote fail-closed | 4 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-hook-trust.ts` | workspace 级 hook Trust 授权 | fail-closed、公开原因码、精确摘要 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace-model-runtime.ts` | workspace 呈现/连通测试/app 创建/模型查询 | 隔离键、临时 app 关闭、流式默认、不伪造容量 | 28 |

## 三、根目录与 conversation-recording / lib / runtime-subagents / session-execution

| 文件 | 职责 | 注释主题 | +行数 |
| --- | --- | --- | --- |
| `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` | OAuth 登录实现 | 超时/取消合并、凭据分支、分阶段错误码 | 31 |
| `apps/zcode-cli/packages/bootstrap/src/auth-login-abort.ts` | 登录取消助手 | 保留 signal.reason、race 防 transport 忽略 signal | 10 |
| `apps/zcode-cli/packages/bootstrap/src/auth-login-contract.ts` | 登录/配置/登出契约 | 选项与结果字段、错误码分类 | 39 |
| `apps/zcode-cli/packages/bootstrap/src/auth-login-persistence.ts` | 登录持久化与登出 | 凭据先/配置后、deleteIfValues 防并发、仓库释放 | 35 |
| `apps/zcode-cli/packages/bootstrap/src/auth-login-polling.ts` | 授权轮询 | deadline 取 min、限速、可重试状态、取消优先 | 13 |
| `apps/zcode-cli/packages/bootstrap/src/builtin-prompt-command.ts` | /init、/workflow 内置命令 | 先于自定义解析、workflow 灰度门、拒写隐藏文件 | 23 |
| `apps/zcode-cli/packages/bootstrap/src/builtin-workflow-command.ts` | 内置 workflow 内容 | 静态内容元数据、与自定义同形展开 | 14 |
| `apps/zcode-cli/packages/bootstrap/src/conversation-recording/contract.example.ts` | 记录器接线最小样例 | CLI 开关优先于配置、与宿主 sink 合并 | 4 |
| `apps/zcode-cli/packages/bootstrap/src/conversation-recording/contract.ts` | recorder 解析与 sink 组合契约 | 三级优先级、输入字段语义 | 13 |
| `apps/zcode-cli/packages/bootstrap/src/conversation-recording/index.ts` | 记录器装配实现 | enabled/目录优先级、allSettled 隔离、冻结对象 | 9 |
| `apps/zcode-cli/packages/bootstrap/src/conversation-recording/module.ts` | 模块清单 | 依赖面与架构策略一致 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/custom-command-prompt.ts` | 自定义命令 prompt 解析 | 保留名边界、executionPort 两条展开路径、仅吞 not found | 18 |
| `apps/zcode-cli/packages/bootstrap/src/custom-commands.ts` | 自定义命令发现/读取 | 配置+插件根合并、disabledPaths、名字归一 | 29 |
| `apps/zcode-cli/packages/bootstrap/src/custom-command-shell-expansion.ts` | `!` shell 片段展开 | 信任边界、env 白名单、超时/输出上限、失败不静默 | 32 |
| `apps/zcode-cli/packages/bootstrap/src/index.ts` | 根导出 | 纯 re-export，未改 | 0 |
| `apps/zcode-cli/packages/bootstrap/src/lib/plugin-storage-lock.ts` | 插件存储写串行化 | 单进程锁、禁止同根重入、异常不阻断排队 | 11 |
| `apps/zcode-cli/packages/bootstrap/src/log-retention.ts` | 启动日志保留清理 | 能力探测、fire-and-forget、失败不影响启动 | 8 |
| `apps/zcode-cli/packages/bootstrap/src/mcp-config.ts` | MCP 状态投影与 CUA 注入 | 引用相等信任、untrusted 判定、退役剔除、引用稳定 | 46 |
| `apps/zcode-cli/packages/bootstrap/src/model-config.ts` | AiSdk 执行配置合成 | 纯配置、headers 版本优先级、network 省略语义 | 27 |
| `apps/zcode-cli/packages/bootstrap/src/model-factory.ts` | 模型适配器工厂 | 依赖拼装、共享请求安全状态、装配期错误 | 12 |
| `apps/zcode-cli/packages/bootstrap/src/permission-options.ts` | 权限选项投影 | 三种 optionsPolicy、session 规则分离、user-once 裁剪 | 20 |
| `apps/zcode-cli/packages/bootstrap/src/plugins.ts` | 插件市场/安装/更新/卸载 | 市场 fail-closed 合并、内置抑制/恢复、安装记录所有权、锁分层、失败转诊断 | 211 |
| `apps/zcode-cli/packages/bootstrap/src/process-resource-sampler.ts` | 进程资源采样 | 首 tick 基线、实测间隔、异常自愈、instanceToken | 11 |
| `apps/zcode-cli/packages/bootstrap/src/provider-endpoint-routing.ts` | 端点路由端口 | 进程级缓存键、JWT 惰性读取、来源头不缓存 | 25 |
| `apps/zcode-cli/packages/bootstrap/src/provider-endpoint-routing-source-headers.ts` | 路由来源头 | 只读 deviceMid、失败静默、路径缓存 | 18 |
| `apps/zcode-cli/packages/bootstrap/src/runtime-platform-headers.ts` | 运行平台请求头 | 可打印字符净化、OS 三值归一 | 9 |
| `apps/zcode-cli/packages/bootstrap/src/runtime-subagents/contract.example.ts` | 运行态子代理配置样例 | project 来源 + namespace 前缀 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/runtime-subagents/contract.ts` | 运行态子代理配置契约 | documents/state 字段、纯解析边界 | 2 |
| `apps/zcode-cli/packages/bootstrap/src/runtime-subagents/index.ts` | 文档→AgentProfile 解析 | namespace 前缀、单文件失败不阻断、非 ready 空集 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/runtime-subagents/module.ts` | 模块清单 | requires 与独立 loader 注入 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution/contract.example.ts` | 收尾租约样例 | finalize 抛错仍释放、不替代 busy/idle | 2 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution/contract.ts` | 执行材料/租约类型 | 惰性鉴权、计数归属 record | 4 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution/index.ts` | 纯 re-export | 跳过（无新增） | 0 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution/model-context.ts` | 模型执行上下文投影 | selectionScope=execution、auth 逐字段冻结 | 6 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution/module.ts` | 模块清单 | requires 双依赖 | 1 |
| `apps/zcode-cli/packages/bootstrap/src/session-execution/residency-lease.ts` | 收尾租约计数 | 同步登记、幂等释放、非调度锁 | 5 |
| `apps/zcode-cli/packages/bootstrap/src/sessions.ts` | 会话查询 | roots/limit 语义、store 所有权 | 10 |
| `apps/zcode-cli/packages/bootstrap/src/session-transcript.ts` | 会话展示投影 | 剔除 summary/内部 user、part 去重与角色映射 | 36 |
| `apps/zcode-cli/packages/bootstrap/src/skill-command-overrides.ts` | 覆盖→disabledPaths | 仅显式 false 才禁用（opt-out） | 6 |
| `apps/zcode-cli/packages/bootstrap/src/skills.ts` | 技能发现/读取 | 双重门控、extraRoots 区分、存在性预检 | 23 |
| `apps/zcode-cli/packages/bootstrap/src/slash-command-surface.ts` | 斜杠命令保留名 | 共享 help 单一来源、归一化、拒绝展开 | 9 |
| `apps/zcode-cli/packages/bootstrap/src/startup-logging.ts` | 启动计时日志 | 单调时钟、分段/总耗时、不改启动结果 | 20 |
| `apps/zcode-cli/packages/bootstrap/src/subagents.ts` | Agent Profile 加载 | 迁移/namespace、插件模板命名、裸名别名唯一性 | 46 |
| `apps/zcode-cli/packages/bootstrap/src/telemetry-bootstrap.ts` | 遥测环境准备 | 捕获区合并、仅回填 device MID 防泄漏 | 3 |
| `apps/zcode-cli/packages/bootstrap/src/tool-call-product-visibility.ts` | 工具调用可见性过滤 | 双档判据、不误隐藏合法同名工具 | 7 |
| `apps/zcode-cli/packages/bootstrap/src/workspace-hook-trust-cli.ts` | Workspace Hook 信任 CLI | identity+digest 绑定、store 损坏 fail-closed、审计字段 | 52 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts` | 协议进程入口 | 启动顺序、资源所有权、取消/关闭、晚绑定 sink | 37 |

## 汇总

- 文件数：**223**
- 总新增注释行：**3412**
- 删除列非 0：**0**
- 注释闭合自检：**通过**

## 超 800 行文件

| 文件 | 当前行数 |
| --- | --- |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts` | 1505 |
| `apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts` | 952 |
| `apps/zcode-cli/packages/bootstrap/src/app/types.ts` | 887 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts` | 1049 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts` | 1471 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts` | 4067 |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts` | 2130 |
| `apps/zcode-cli/packages/bootstrap/src/plugins.ts` | 1611 |

## 关键发现（本批）

1. **装配顺序是硬约束**：`create-app` 先解析配置/插件/子代理，再开 session store、合成 runtimeConfig、建 MCP/execution/fs/http 端口，随后构造 model factory，最后才建 AgentRuntime 与三个 facade；script bridge、dwf actor、expert facade 共享父会话同一份 `modelFactory`，避免 child 各自冻结 Registry 视图。
2. **Provider 选择是“保存意图”不等于“执行绑定”**：Registry 校验失败只影响 runtime 绑定并记 warn，不删除已保存的 selection；历史恢复不要求模型可执行，完整选择才可绑定。
3. **MCP 三层合并有明确优先级**：plugin MCP → 用户/项目配置 → 宿主内建 server（内建最后合并且保留 identity，防同名劫持）；CUA 信任用 `configuredServers[name] === config` 的引用相等，复制字段不能继承官方权限。
4. **关闭/释放是所有权问题**：只有 `ownsSessionStore/ownsMcpPort/ownsExecutionPort` 才关闭对应资源；session-facade 的顺序是停准入 → drain → 停 dwf run → 并行关端口 → 关 store，错误只警告不阻断。
5. **协议层窄端口遵循“端口在场即能力开启”**：账号配置同步、Registry 刷新、provider 身份头等端口缺席时返回稳定错误码，不静默降级；mcp-ui 用 token+generation 与 `sessionId|scopeId|generation` 订阅键隔离旧页面/旧会话。

