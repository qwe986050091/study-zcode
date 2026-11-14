// @zcode/dynamic-workflow 根出口：把分析、编译、schema、引擎四层收敛成一份跨包稳定契约
// INV-01 包入口只做再导出，不含实现与副作用；守住位置：本文件全部 export 语句；改错故障：CLI 启动即执行分析与编译模块，冷启动变慢甚至崩溃。
// INV-02 顶层导出名是跨包契约，改名等于破坏调用方；守住位置：各 export 列表中的符号名；改错故障：bootstrap 与 core 编译失败，工作流工具整条链路不可用。
// INV-03 根入口允许带入 typescript，浏览器桶不允许；守住位置：analyzeWorkflowScript 这类重模块的再导出；改错故障：投影桶被改成引用根入口，前端包体积暴涨并构建失败。
// INV-04 每个符号只有一个来源模块，入口不做二次聚合；守住位置：各 export 的 from 路径；改错故障：同名符号两个来源，类型与运行时实现错配。
// INV-05 类型必须以 export type 形式导出；守住位置：所有 type 前缀条目；改错故障：开启 verbatimModuleSyntax 后运行时代码引入类型，Node 报导出不存在。
// INV-06 facade d.ts 常量是模型可见 API 的唯一事实源；守住位置：FACADE_DTS 与 SNIPPET_FACADE_DTS 的再导出；改错故障：模型按旧签名写脚本，编译期诊断与文档不一致。
// INV-07 留白 id 必须按名字铸成，补全前后不变；守住位置：holeSiteId 与 HOLE_SITE_ID_PATTERN 的再导出；改错故障：补全后 journal 键全部失效，运行无法续跑。
// INV-08 schema 校验只认合成器发射的子集；守住位置：validate 的再导出；改错故障：调用方拿通用 JSON Schema 来校验，合法输入被误判为违规。
// INV-09 诊断码常量对外稳定，UI 按码分流；守住位置：ARTIFACT 系列码、HOLE_CODE、PHASE_MARKER_CODE 等再导出；改错故障：前端提示文案错位，用户看到无关的修复建议。
// INV-10 引擎错误保持单一类型边界；守住位置：WorkflowError 与 WorkflowErrorCode 的再导出；改错故障：调用方按字符串判错，错误归类随文案改动而失效。
// INV-11 上限常量只在此处出口，不在调用点重写；守住位置：各类 CAPS 与 MAX_CHARS 的再导出；改错故障：两处上限漂移，超限输入一边放行一边拒绝。
// INV-12 入口只指向叶子模块，避免环；守住位置：全部 from 路径中不出现指向本包的相对导入；改错故障：引擎与 schema 互相引用，模块求值顺序不定导致未定义。
// INV-13 并发默认值集中导出，调度器不内联数字；守住位置：CONCURRENCY 系列常量；改错故障：调参与文档不一致，用户改配置后并发行为不变。
// INV-14 序列化输出是快照面，格式变更需同步基线；守住位置：serialize 系列再导出；改错故障：golden 测试与真实输出分叉，回归保护失效。
// INV-15 投影函数是纯函数，不在 core 上写回；守住位置：toActorGraph、projectControlFlow 等再导出；改错故障：同一 core 两次投影结果不同，界面图与快照对不上。
// INV-16 再导出顺序不承载语义；守住位置：export 语句的排列；改错故障：维护者误以为顺序决定初始化，把有副作用的模块提到前面。
// INV-17 新增或删除出口必须同步其他出口与依赖检查；守住位置：本文件的 export 列表；改错故障：knip 与导出引用查询报未使用，或类型检查找不到符号。
// INV-18 内部实现细节不得从入口漏出；守住位置：只导出 facade 常量、公共类型与稳定函数，不导出内部 helper；改错故障：外部包直接依赖内部路径，重构即引发跨包连锁破坏。
// 这份文件是 @zcode/dynamic-workflow 的根出口：分析、编译、schema、引擎各层在此汇成一份稳定契约，
// 改动前先确认破坏的是哪条不变量；需要新出口时优先在既有模块内新增，而不是把内部文件整体抛出。
// 排错时先看诊断码与上限常量的来源模块，再顺着 from 路径下钻，入口本身不应该有逻辑可供怀疑。
//
export { FACADE_DTS, FACADE_FILE_NAME, SNIPPET_FACADE_DTS } from "./facade/dts.js";
export {
  HOLE_SITE_ID_PATTERN,
  holePrefixOf,
  holeSiteId,
  isHoleSiteId,
// [权衡] 留白 id 是名字的 FNV-1a 32 位哈希，与嵌套深度无关，补全插入不会改号
// 撞哈希由 9012 诊断报出，入口不兜底、不重试，避免两个留白抢同一 id
// [资源] id 定长便于协议载荷有界，体内站点只加一层前缀，接龙补全不会顶到长度上界
} from "./analysis/hole-id.js";
// 世界读取上限来自 facade 段，喂给模型看的能力声明与运行时校验共用这一份
// 在调用点另写数字会让模型以为能力更大，实际请求被静默截断
export { WORLD_READ_CAPS } from "./facade/world-read-caps.js";
export { REPORT_CAPS } from "./facade/report-caps.js";
// 用户面产物：上限常量、注册表词汇、编译期清单与诊断。
// 产物上限与 id 形状成对导出，产物注册表、校验器、UI 三处都读它
// 只改一边会让合法产物在生成后被校验拒绝
export { ARTIFACT_CAPS, ARTIFACT_ID_PATTERN } from "./facade/artifact-caps.js";
export {
  // 注册表是产物种类的封闭词表，预置操作判定与族归属都由它派生
  // 入口只转出词表本身，不导出增删入口，保证产物种类在编译期就确定
  ARTIFACT_REGISTRY,
  artifactFamilyOf,
  isArtifactPresetOp,
  type ArtifactContentOp,
  type ArtifactOp,
  type ArtifactPresetOp,
  type ArtifactRow,
} from "./facade/registry.js";
export {
  // 三个诊断码分别对应声明、提升与主产物冲突，UI 与测试按码断言而不是按文案
  // 新增码要同时进这里，否则诊断在调用方退化成无分类字符串
  ARTIFACT_DECLARATION_CODE,
  ARTIFACT_HOISTING_CODE,
  ARTIFACT_PRIMARY_CONFLICT_CODE,
  collectArtifactDeclarations,
  type ArtifactDeclarations,
  type DeclaredArtifact,
} from "./analysis/artifacts.js";
export {
  collectDiagnostics,
  // [失败路径] 编译失败通过 CompileResult 的 diagnostics 返回，不抛异常，调用方无需包裹
  // 它同时是 schema 编译入口与脚本编译入口，收窄返回类型会破坏全部工作流工具
  // [资源] 该模块会带入 TypeScript 编译器，只允许出现在 Node 侧
  compileWorkflowScript,
  createWorkflowProgram,
  SCRIPT_FILE_NAME,
  type CompileDiagnostic,
  type CompileResult,
  type CreateWorkflowProgramOptions,
  type ScriptLoc,
  type WorkflowProgram,
} from "./compiler/compile.js";
// [权衡] 分析与铸造 core 合在同一个入口，保证 core 里的 id 与诊断出自同一次解读
// 浏览器侧不能走这里，投影桶只接受已冻结的 core
// 类型 AnalyzeResult 与 core 的字段契约同源，拆开会让两边定义漂移
export { analyzeWorkflowScript, type AnalyzeResult } from "./analysis/analyze.js";
export {
  MODEL_REFERENCE_CODE,
  MODEL_UNRESOLVED_CODE,
  type ModelReference,
} from "./analysis/actor-models.js";
export { collectSites, type SiteTable } from "./analysis/sites.js";
export {
  collectWorldRunCommands,
  WORLD_RUN_LITERAL_CODE,
  type WorldRunCommands,
} from "./analysis/world-run.js";
export { collectPhaseMarkerDiagnostics, PHASE_MARKER_CODE } from "./analysis/phases.js";
export { collectPhaseNames, collectSitePhases } from "./analysis/site-phases.js";
// 留白（docs/dynamic-workflow/authoring.md「Holes」）：规则 9012、站点类型、补全服务的拼接与
// 稳定性复核。
export { collectHoleDiagnostics, HOLE_CODE, HOLE_NAME_MAX_CHARS } from "./analysis/hole-sites.js";
export type { HoleSite } from "./analysis/sites.js";
export {
  checkSiteStability,
  spliceHoleBody,
  type SiteStability,
  type SplicedHoleBody,
} from "./analysis/hole-splice.js";
export { MAIN_LANE } from "./analysis/causality-graph.js";
export type { FlowHole } from "./analysis/flow-graph.js";
// interpret 是唯一把源码变成无位置依赖 core 的环节，投影阶段不再回看代码
// 绕过它自造 core 会让 within 与最终 fan-out id 停留在临时形态
export { interpret } from "./analysis/interpret.js";
export {
  toActorGraph,
  type ActorEdge,
  type ActorGraph,
  type ActorNode,
} from "./analysis/actor-graph.js";
export {
  // 因果图的虚拟入口与出口用固定 id 表示，渲染与快照都依赖这三个常量不变
  // 改名会让历史快照无法与新分析结果对齐
  SINK_ID,
  UNKNOWN_LANE,
  WORKSPACE_LANE,
  type CausalityGraph,
  type Certainty,
  type Lane,
  type NamePattern,
  type OrderEdge,
  type OrderKind,
  type Phase,
  type Region,
  type RegionKind,
  type Step,
  type StepKind,
} from "./analysis/causality-graph.js";
// [权衡] 归约按 kind 强弱逐边判定，普通画线的优先级是 data 与 control 高于 fifo 高于 seq
// 带环输入必须仍在环上收敛，不能靠补边反向撤销先前的删除
// 换成无类型归约会删掉真正的数据依赖边，图看着更干净但语义错
// 贪心不可约传递归约。display
// 裁剪层复用它对单一种类的边做无类型归约
// ——全部前向边同 kind、回边作 carry，它就退化成普通的不可约归约，且在有环输入上可靠。
export { reduceOrdering, type ReducibleEdge } from "./analysis/causality-reduce.js";
export {
  UNPHASED_ID,
  type JumpKind,
  type StructuralRegionKind,
  type TraceRegionKind,
} from "./analysis/causality-order.js";
// 控制流投影：occurrence 级 CFG 与阶段商。
export {
  // 控制流投影用三个哨兵节点表示入口、中止与汇聚，节点 id 由常量固定
  // 下游按 id 认节点，改成自增编号会让 CFG 快照与界面选择器错位
  FLOW_ABORT,
  FLOW_ENTRY,
  FLOW_SINK,
  projectControlFlow,
  type ControlFlowGraph,
  type FlowEdge,
  type FlowEdgeKind,
  type FlowNode,
  type FlowNodeKind,
  type FlowPhase,
  type FlowVia,
} from "./analysis/flow-graph.js";
export {
  actorGraphToMermaid,
  causalityGraphToMermaid,
  controlFlowToMermaid,
  handoffGraphToMermaid,
  phaseFlowToMermaid,
  phaseGraphToMermaid,
  siteGraphToMermaid,
} from "./analysis/mermaid.js";
// 因果图的规范文本形式（快照面）。
export {
  // 规范文本形式是回归基线的比较对象，字段顺序与分隔符都属于契约
  // 调整格式要同步更新基线，否则 diff 噪声淹没真实的图结构变化
  serializeCausalityGraph,
  serializeControlFlow,
  serializeHandoffGraph,
} from "./analysis/serialize.js";
// 交接图投影：板面第二层的参与者卡与交接边。
export {
  // [资源] 交接图展开 fan-out 有硬上限，防止大扇出把板面渲染拖死
  // 上限只在入口转出，调用方不要各自复制一份，否则展开度不一致
  FANOUT_EXPAND_CAP,
  projectHandoffGraph,
  UNPHASED,
  type Handoff,
  type HandoffGraph,
  type HandoffParticipant,
} from "./analysis/handoff-graph.js";
// 统一分析的核心产物与其规范文本形式：
// 站点图 / 因果图 / actor 图都是它上面的纯投影。
export {
  // core 的规范文本是样例包落盘格式，编码函数与它共享同一份字段顺序
  // 投影模块只能读 core，不能反过来改结构再序列化
  serializeCore,
  type AnalysisCore,
  type CoreActorSite,
  type CoreAskSite,
  type CoreFacts,
  type CoreFanoutSite,
  type CoreHoleSite,
  type CoreSimpleSite,
  type CoreSites,
  type CoreTypes,
} from "./analysis/core.js";
// core 的 JSON 编解码：样例包把 `AnalysisCore` 冻结成
// `core.json`，下游浏览器端在冻结产物上现场重算投影；Map 以有序 `[key, value][]` 落盘。
export {
  // [失败路径] 解码要做形状校验，坏 core.json 应报错而不是产出半空图
  // Map 以有序条目数组落盘，解码必须还原顺序，否则边序在快照间抖动
  decodeAnalysisCore,
  encodeAnalysisCore,
  type AnalysisCoreJson,
} from "./analysis/core-json.js";
export type {
  ActorSite,
  SiteEdge,
  SiteGraph,
  SiteKind,
  SiteLoc,
  SiteNode,
} from "./analysis/types.js";
export {
  // ask spec 与 workflow schema 由同一套合成逻辑产出，校验器只认它的子集
  // 手写 JSON Schema 会用到合成器不支持的构造，validate 直接判违规
  buildAskSpecs,
  synthesizeAskSchemas,
  synthesizeWorkflowSchemas,
  type SchemaSynthesisResult,
} from "./schema/synthesize.js";
// 这是运行时 schema 校验的唯一入口，子代理提交与产物发布都经过它
// 违规条目刻意做成可直接回灌模型的一行 JSON 路径，便于自动修复
// 不要在这里放宽成通用 JSON Schema，否则校验语义与合成器永久分叉
export { validate, formatViolation, formatViolations } from "./schema/validate.js";
// 每个 actor 站点的 submit profile：编译期决定子代理拿 typed / generic / 无 submit_result 工具。
export {
  GENERIC_SUBMIT_PROFILE,
  deriveActorSubmitProfiles,
  deriveActorSubmitProfilesFor,
  type ActorSubmitProfile,
} from "./schema/actor-submit-profiles.js";
export { serializeSchema } from "./schema/serialize.js";
export {
  // [资源] 联合成员数上限约束 schema 规模，超出在编译期报 SCHEMA_DIAGNOSTIC_CODE
  // 调大上限会放大模型的选择空间，先确认提示词还能稳定收敛
  MAX_UNION_MEMBERS,
  SCHEMA_DIAGNOSTIC_CODE,
  type JsonSchema,
  type JsonSchemaType,
  type JsonValue,
  type Violation,
} from "./schema/types.js";
export {
  HOST_BINDING,
  lowerWorkflow,
  lowerWorkflowScript,
  type LoweredWorkflow,
  type LowerResult,
} from "./lowering/index.js";
export {
  // [事务] 引擎是运行状态的唯一所有者，journal 写入与节点状态推进在同一条路径
  // [并发] 并发控制在引擎内做，外部只读快照，不要绕过它直接放大并发
  // 入口只导出类型与常量，不导出内部调度函数，防止调用方改写执行顺序
  WorkflowEngine,
  InMemoryJournalStore,
  ALL_EVENTS,
  NODE_KINDS,
  NON_REPORT_NODE_KINDS,
  type GetNodeOptions,
  type ListActorsOptions,
  type ListNodesOptions,
  type RunEventType,
  WorkflowError,
  INSTRUCTIONS_HEAD_MAX_CHARS,
  LAST_TOOL_NAME_MAX_CHARS,
  LAST_TOOL_TARGET_MAX_CHARS,
  NUDGE_ATTEMPTS,
  REPAIR_ATTEMPTS,
  canonicalJson,
  fnv1a,
  inputHash,
  refToString,
  type ActorId,
  type ActorRecord,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactRef,
  type ArtifactVersionRecord,
  type AskMessage,
  type AskLastTool,
  type AskProgress,
  type AskSpec,
  type AskStats,
  type Caps,
  type EngineConfig,
  type ImportedActorCandidate,
  type ImportedAskEntry,
  type ImportedInFlightAsk,
  type ImportedRunCache,
  type ImportedWorldEntry,
  type InstanceRef,
  type JournalStorePort,
  type ListEventsOptions,
  type NodeKind,
  type NodeOutcome,
  type NodeRecord,
  type NodeRecordStatus,
  type WorldReadInput,
  WORLD_READ_INPUT_MAX_BYTES,
  type PersonaSpec,
  type RunEvent,
  type RunRecord,
  type RunSettlement,
  type RunSettlementRecord,
  type RunStallInfo,
  type RunStatus,
  type RunStopReason,
  type SessionRef,
  type StoredEvent,
  type SubmitVerdict,
  type ValidateFn,
  type WorkflowDriver,
  type WorkflowErrorCode,
  type WorkflowErrorJson,
  type ProviderStopDetails,
  type WorkflowErrorMismatch,
  type WorkflowHostApi,
  type WorkflowReportSink,
  type WorldReadOp,
  type AskWaitInfo,
  type ConcurrencyChange,
  type ConcurrencyChangeReason,
} from "./engine/index.js";
export {
  // [并发] 并发控制器是节流与恢复的唯一决策点，失败退避与空闲重置都在内部完成
  // 外部只读快照与变更原因，自行加减并发会与调度器状态失去同步
  ConcurrencyController,
  CONCURRENCY_DECREASE_FACTOR,
  CONCURRENCY_FLOOR,
  CONCURRENCY_IDLE_RESET_MS,
  CONCURRENCY_INCREASE_AFTER_SUCCESSES,
  CONCURRENCY_INCREASE_STEP,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "./engine/index.js";
export {
  // 留白补全提示有长度上限，超限应被截断而不是把整段脚本塞给模型
  // 上限值从这里取，运行时与 UI 提示共用同一常量
  HOLE_PROMPT_MAX_CHARS,
  type FilledHole,
  type FillHoleResult,
  type HoleFill,
  type OpenHole,
} from "./engine/index.js";
