// ============================================================
// Script Workflow Contracts —— legacy 脚本工作流（*.workflow.js）的运行时与持久化契约
// ============================================================
//
// 【定位】这里定义的是"脚本工作流"这一条独立链路：用户/内置的 .workflow.js 脚本在
// 子进程里执行，脚本内每次 agent() 调用通过 ScriptWorkflowStorePort 落成一条
// activity（SQLite），run/activity/event/task-link 四张记录构成可恢复、可缓存的执行台账。
//
// 【阶段划分】meta（name/description/phases/whenToUse）在发现脚本时解析并校验，属于
// 编译期/装载期契约；agent 的 prompt 与 opts 在脚本真正执行到该调用时才校验并落库，
// 属于运行期契约。两者共用本文件的 zod schema，避免编辑器侧与运行侧对同一脚本
// 给出不同校验结果。
//
// 【边界】artifact / ask / hole 等脚本侧能力不在本文件：它们属于 dynamic-workflow
// 包的编译期/运行期 facade（引擎 Boundary A/B 与 Journal 契约）。本文件只覆盖
// legacy 脚本工作流的存储形状，且依赖 SQLite 会话库，不进入 NodeWorkflowStore 的
// run.json/JSONL 体系；expert 工作流的 durable 契约见 ./index.ts。
//
// 【不变量】所有时间戳是 epoch 毫秒（number），与 expert workflow 的 ISO 字符串不同；
// run 以 status 为唯一权威状态，activity 的 attempt/callIndex/callPath/inputHash 决定
// 缓存命中；记录一经创建不再删除，只能改状态与补 result/error。
// ============================================================

import { z } from "zod";
import type { SessionId } from "../interfaces/shared.js";

// agent() 单次调用的资源上限（tools/skills/turns/timeoutMs）。上限写在 schema 里而不是
// 只在运行时钳制，是为了让脚本作者在提交前就看到非法配置；具体执行端仍会按同一组
// 常量做二次校验，跨进程时两端口径必须一致，不能各自放宽。
const MAX_WORKFLOW_AGENT_TOOLS = 128;
const MAX_WORKFLOW_AGENT_SKILLS = 64;
const MAX_WORKFLOW_AGENT_TURNS = 200;
const MAX_WORKFLOW_AGENT_TIMEOUT_MS = 86_400_000;

// 脚本声明的单个阶段：title 必填且用作阶段唯一标识（UI 展示、currentPhase 落库都用它），
// detail 是给人看的说明，model 表示该阶段默认使用的模型。strict() 意味着脚本 meta 里
// 多写字段会被直接判非法，防止拼写错误静默失效。
export const WorkflowScriptPhaseMetaSchema = z
  .object({
    detail: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    title: z.string().min(1),
  })
  .strict();
export type WorkflowScriptPhaseMeta = z.infer<typeof WorkflowScriptPhaseMetaSchema>;

// 脚本级 meta：发现/校验阶段即被 readWorkflowScriptDocument 解析，写进定义记录并用于
// 列表展示。phases 默认空数组；superRefine 额外保证 phase title 唯一——因为 title 是
// run.currentPhase 与 activity.phase 的连接键，重名会让阶段归属产生歧义。
export const WorkflowScriptMetaSchema = z
  .object({
    description: z.string().min(1),
    name: z.string().min(1),
    phases: z.array(WorkflowScriptPhaseMetaSchema).default([]),
    whenToUse: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((meta, context) => {
    const seen = new Set<string>();
    for (const [index, phase] of meta.phases.entries()) {
      if (!seen.has(phase.title)) {
        seen.add(phase.title);
        continue;
      }
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate workflow phase title: ${phase.title}`,
        path: ["phases", index, "title"],
      });
    }
  });
export type WorkflowScriptMeta = z.infer<typeof WorkflowScriptMetaSchema>;

// agent 执行隔离级别。当前 schema 只承认 "worktree"（在独立 git worktree 中跑子 agent），
// 但 legacy 执行端尚未实现该隔离，实际仍是同工作目录执行；schema 先固定词表，
// 避免脚本作者写入 "container"/"sandbox" 之类未来可能引入但当前无效的值。
export const WorkflowAgentIsolationSchema = z.enum(["worktree"]);
export type WorkflowAgentIsolation = z.infer<typeof WorkflowAgentIsolationSchema>;

// 单次 agent() 调用的可选项，运行期由脚本传入并在落库前校验：
// agentType/label/phase/model/systemPrompt/instructions 是 persona 与提示词配置；
// schema 用于要求子 agent 返回结构化 JSON（由 parseStructuredResponse 消费）；
// tools/skills/maxTurns/timeoutMs 受上面常量约束；isolation 见上。strict() 让未知键
// 直接失败，因为这些 opts 会原样持久化进 activity，拼错键会导致恢复时无法解释。
export const WorkflowAgentOptionsSchema = z
  .object({
    agentType: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    isolation: WorkflowAgentIsolationSchema.optional(),
    label: z.string().min(1).optional(),
    maxTurns: z.number().int().positive().max(MAX_WORKFLOW_AGENT_TURNS).optional(),
    model: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    schema: z.record(z.unknown()).optional(),
    skills: z.array(z.string().min(1)).max(MAX_WORKFLOW_AGENT_SKILLS).optional(),
    systemPrompt: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(MAX_WORKFLOW_AGENT_TIMEOUT_MS).optional(),
    tools: z.array(z.string().min(1)).max(MAX_WORKFLOW_AGENT_TOOLS).optional(),
  })
  .strict();
export type WorkflowAgentOptions = z.infer<typeof WorkflowAgentOptionsSchema>;

// agent() 的调用输入：prompt 必填；callPath 是脚本内调用的稳定位置标识（用于缓存与
// UI 分组），phase 覆盖 run 当前阶段。callPath + inputHash 是 findCachedScriptWorkflowActivity
// 的查找键，因此 callPath 必须稳定可复现，不能包含随机量或时间戳。
export const WorkflowAgentCallInputSchema = z
  .object({
    callPath: z.string().min(1).optional(),
    phase: z.string().min(1).optional(),
    opts: WorkflowAgentOptionsSchema.optional(),
    prompt: z.string().min(1),
  })
  .strict();
export type WorkflowAgentCallInput = z.infer<typeof WorkflowAgentCallInputSchema>;

// run 状态词表（持久化取值）。paused 是脚本显式挂起或等待子任务后的人为暂停；
// completed/failed/cancelled 为终态，写终态时必须同时写 completedAt。
export const SCRIPT_WORKFLOW_RUN_STATUSES = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ScriptWorkflowRunStatus = (typeof SCRIPT_WORKFLOW_RUN_STATUSES)[number];

// activity 状态词表。除常规生命周期外有两个特殊值：cached 表示本次调用命中
// callPath+inputHash 的历史结果、未真正派发子 agent；lost 表示 run 结束时该活动
// 仍无终态（进程中断等），属于"状态未知"的兜底而非业务失败。
export const SCRIPT_WORKFLOW_ACTIVITY_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "cached",
  "lost",
] as const;
export type ScriptWorkflowActivityStatus = (typeof SCRIPT_WORKFLOW_ACTIVITY_STATUSES)[number];

// 定义来源：builtin 随产品分发、随版本覆盖；user 由用户放置，需 trusted 才可执行
// （脚本是任意代码，未信任的定义只展示不运行）。
export type ScriptWorkflowSource = "builtin" | "user";
// 定义作用域/优先级：builtin（内置）< user（用户目录）< project（项目目录）< explicit
// （命令显式指定路径）。解析同名定义时按此顺序取最具体的一份，explicit 永远最高。
export const SCRIPT_WORKFLOW_DEFINITION_SCOPES = [
  "builtin",
  "explicit",
  "project",
  "user",
] as const;
export type ScriptWorkflowDefinitionScope = (typeof SCRIPT_WORKFLOW_DEFINITION_SCOPES)[number];

// 已发现的脚本工作流定义（SQLite 中的一行）。scriptHash 是脚本文本的内容哈希，
// 与 run.scriptHash 比对即可判断"这次 run 跑的是不是当前这份脚本"；
// scriptPath 可缺省（内置定义以 id 定位）；timeCreated/timeUpdated 是毫秒，
// 用于列表排序与增量刷新。enabled/trusted 是执行前的两道闸门，二者任一为 false
// 都必须拒绝启动，不能只靠 UI 隐藏。
export interface ScriptWorkflowDefinitionRecord {
  enabled: boolean;
  id: string;
  meta: WorkflowScriptMeta;
  name: string;
  scope: ScriptWorkflowDefinitionScope;
  scriptHash: string;
  scriptPath?: string;
  source: ScriptWorkflowSource;
  timeCreated: number;
  timeUpdated: number;
  trusted: boolean;
}

// run 级统计：agentCalls 为全部 agent 活动数，cachedAgentCalls 是其中命中缓存的次数，
// failedAgentCalls 为失败次数，toolCalls 为子 agent 内工具调用总数。tokens 的六个
// 分量来自子会话用量累加，total 是落库时已算好的总 token 数（含 reasoning），
// 读取方不要用其他分量自行相加，以免与写入端口径不一致。
export interface ScriptWorkflowRunStats {
  agentCalls: number;
  cachedAgentCalls: number;
  failedAgentCalls: number;
  toolCalls: number;
  tokens: {
    cacheRead: number;
    cacheWrite: number;
    input: number;
    output: number;
    reasoning: number;
    total: number;
  };
}

// 统计的运行时校验镜像：写入 SQLite 前与从库里读回时都走这一份，保证 stats 的形状
// 不会因某次 run 只写了部分分量而漂移。全部为非负整数，strict() 禁止额外键。
export const ScriptWorkflowRunStatsSchema = z
  .object({
    agentCalls: z.number().int().nonnegative(),
    cachedAgentCalls: z.number().int().nonnegative(),
    failedAgentCalls: z.number().int().nonnegative(),
    tokens: z
      .object({
        cacheRead: z.number().int().nonnegative(),
        cacheWrite: z.number().int().nonnegative(),
        input: z.number().int().nonnegative(),
        output: z.number().int().nonnegative(),
        reasoning: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict(),
    toolCalls: z.number().int().nonnegative(),
  })
  .strict();

// 一次脚本工作流 run 的台账行（SQLite）。id 由调用端生成（wf_ 前缀，需满足
// WORKFLOW_RUN_ID_PATTERN），kind 固定 "script" 用于与 expert run 区分；args/argsHash
// 保存本次调用参数及其哈希，用于同参数重跑与展示；budgetSpent/budgetTotal 是 token
// 预算的已用/上限（上限可缺省表示不限）；definitionId 与 scriptHash/scriptPath 共同
// 固定"这跑的是哪份定义、哪份脚本"；currentPhase 是最近进入的阶段（来自 meta.phases
// 的 title）；parentSessionId 记录发起该 run 的父会话；failure 是原始错误对象，
// 读取方需自行格式化；startedAt 可缺省（尚未真正开跑），终态时必须有 completedAt。
export interface ScriptWorkflowRunRecord {
  args?: unknown;
  argsHash?: string;
  budgetSpent: number;
  budgetTotal?: number;
  completedAt?: number;
  createdAt: number;
  currentPhase?: string;
  cwd: string;
  definitionId?: string;
  failure?: unknown;
  id: string;
  kind: "script";
  name: string;
  parentSessionId?: SessionId;
  scriptHash: string;
  scriptPath?: string;
  startedAt?: number;
  stats?: ScriptWorkflowRunStats;
  status: ScriptWorkflowRunStatus;
  updatedAt: number;
}

// 一条活动记录：脚本里的一次 agent()/workflow()/log()/phase() 调用。
// callPath 是脚本内的稳定调用路径，callIndex 是本次 run 内的递增序号，两者一起用于
// UI 排序与缓存重建；inputHash 是 prompt+opts 的哈希，与 callPath 组合成缓存键；
// attempt 表示同一 callPath 的第几次执行（重跑/重试时递增）；parentActivityId 支持
// workflow() 嵌套调用的树形结构；childSessionId 是真正执行该活动的子会话，
// result/error 保留原始值不做结构化，prompt/opts 冗余存一份以便脱离脚本也能复现。
export interface ScriptWorkflowActivityRecord {
  attempt: number;
  callIndex: number;
  callPath: string;
  childSessionId?: SessionId;
  completedAt?: number;
  createdAt: number;
  error?: unknown;
  id: string;
  inputHash: string;
  label?: string;
  opts?: WorkflowAgentOptions;
  parentActivityId?: string;
  phase?: string;
  prompt?: string;
  result?: unknown;
  runId: string;
  startedAt?: number;
  status: ScriptWorkflowActivityStatus;
  type: "agent" | "workflow" | "log" | "phase";
  updatedAt: number;
}

// run 事件行：脚本通过事件流向外播报进度。sequence 在单个 run 内单调递增，
// 是事件顺序的唯一权威（createdAt 毫秒可能同刻）；payload 为任意可序列化内容，
// type 由脚本自定义（非枚举），因此消费方必须容忍未知 type。appendScriptWorkflowEvent
// 只追加不修改，重放方按 sequence 排序即可还原时间线。
export interface ScriptWorkflowEventRecord {
  activityId?: string;
  createdAt: number;
  id: string;
  payload?: unknown;
  phase?: string;
  runId: string;
  sequence: number;
  type: string;
}

// 会话任务链接：把脚本工作流产出的子会话挂到会话树上，供 UI 递归展示与"哪些子会话
// 属于哪个 run"的反查。depth 从根算起（根=0），parentLinkId 指向上一条链接（不是
// childSessionId），rootWorkflowRunId 让任意深度的链接都能回溯到最初 run；
// status 是字符串而非枚举，跟随子会话自身状态透传；path 是展示用的层级路径。
export interface SessionTaskLinkRecord {
  activityId?: string;
  agentType?: string;
  childSessionId: SessionId;
  createdAt: number;
  depth: number;
  id: string;
  label?: string;
  model?: string;
  parentLinkId?: string;
  parentSessionId?: SessionId;
  path: string;
  phase?: string;
  role: string;
  rootWorkflowRunId?: string;
  status: string;
  updatedAt: number;
}

// 定义 upsert 入参：以 id 为幂等键，重复发现同一脚本时更新 meta/hash/enabled 等字段。
// enabled/scope/trusted 可缺省，缺省交给出端口决定默认值（通常为 enabled=true、
// scope=user、trusted=false），调用方不要自己假设缺省语义。
export interface UpsertScriptWorkflowDefinitionInput {
  enabled?: boolean;
  id: string;
  meta: WorkflowScriptMeta;
  name: string;
  scope?: ScriptWorkflowDefinitionScope;
  scriptHash: string;
  scriptPath?: string;
  source: ScriptWorkflowSource;
  trusted?: boolean;
}

// 建 run 入参：id 由调用端生成并在落库前做格式校验；status 缺省通常是 pending，
// 由执行端随后 update 为 running。stats 允许在建 run 时预置（例如恢复场景），
// 后续以 updateScriptWorkflowRun 为准覆盖。
export interface CreateScriptWorkflowRunInput {
  args?: unknown;
  argsHash?: string;
  budgetTotal?: number;
  cwd: string;
  definitionId?: string;
  id: string;
  name: string;
  parentSessionId?: SessionId;
  scriptHash: string;
  scriptPath?: string;
  stats?: ScriptWorkflowRunStats;
  status?: ScriptWorkflowRunStatus;
}

// 更新 run 入参：只改显式传入的字段；completedAt/currentPhase/startedAt 允许传 null
// 表示"清空"（例如从终态回到 running 的续跑），而 undefined 表示"不动"，
// 出端实现必须区分这两种语义，否则续跑会残留旧的完成时间。
export interface UpdateScriptWorkflowRunInput {
  budgetSpent?: number;
  completedAt?: number | null;
  currentPhase?: string | null;
  failure?: unknown;
  id: string;
  startedAt?: number | null;
  stats?: ScriptWorkflowRunStats;
  status?: ScriptWorkflowRunStatus;
}

// 建活动入参：调用方提供 id 与 callIndex/callPath/inputHash，落库时 attempt 由出端
// 依据同一 callPath 的历史条数计算；status 缺省为 queued，由执行端改为 running。
export interface CreateScriptWorkflowActivityInput {
  callIndex: number;
  callPath: string;
  id: string;
  inputHash: string;
  label?: string;
  opts?: WorkflowAgentOptions;
  parentActivityId?: string;
  phase?: string;
  prompt?: string;
  runId: string;
  status?: ScriptWorkflowActivityStatus;
  type: ScriptWorkflowActivityRecord["type"];
}

// 更新活动入参：childSessionId/startedAt/completedAt 传 null 表示清空、undefined 表示
// 不动；result/error 一旦写入即视为该活动已有结论，成功路径只写 result，失败路径只
// 写 error，二者不共存。
export interface UpdateScriptWorkflowActivityInput {
  childSessionId?: SessionId | null;
  completedAt?: number | null;
  error?: unknown;
  id: string;
  result?: unknown;
  startedAt?: number | null;
  status?: ScriptWorkflowActivityStatus;
}

// 建会话链接入参：depth 缺省由出端按 parentLinkId 推导；activityId 与
// rootWorkflowRunId 都是可选，因为链接也可能来自非工作流场景（例如普通子 agent）。
export interface CreateSessionTaskLinkInput {
  activityId?: string;
  agentType?: string;
  childSessionId: SessionId;
  depth?: number;
  id: string;
  label?: string;
  model?: string;
  parentLinkId?: string;
  parentSessionId?: SessionId;
  path: string;
  phase?: string;
  role: string;
  rootWorkflowRunId?: string;
  status: string;
}

// 脚本工作流的持久化端口（实现落在 SessionStore 的 SQLite 侧，bootstrap 通过
// isScriptWorkflowStore 做能力探测）。语义要点：
// - create*/update* 返回落库后的完整记录，调用方不要用入参自行拼状态；
// - findCachedScriptWorkflowActivity 以 runId+callPath+inputHash 查历史成功结果，
//   命中后才能把新活动标为 cached，且缓存不跨 run（runId 是隔离边界）；
// - get/get* 返回 null 表示不存在，list* 返回按时间倒序的数组（空结果返回 []）；
// - appendScriptWorkflowEvent 只追加，sequence 由出端在 run 内递增分配；
// - 所有方法都是 Promise，出端负责事务与并发，调用方不得假设两次写之间的可见性。
export interface ScriptWorkflowStorePort {
  appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord>;
  createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord>;
  createScriptWorkflowRun(input: CreateScriptWorkflowRunInput): Promise<ScriptWorkflowRunRecord>;
  createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord>;
  findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null>;
  getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null>;
  listScriptWorkflowActivities(input: { runId: string }): Promise<ScriptWorkflowActivityRecord[]>;
  listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]>;
  listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]>;
  upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord>;
  updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord>;
  updateScriptWorkflowRun(input: UpdateScriptWorkflowRunInput): Promise<ScriptWorkflowRunRecord>;
}
