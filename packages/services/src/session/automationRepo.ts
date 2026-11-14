// zod 在仓库层是持久化边界的最后一道校验：DB 里的 JSON 列可能由旧版本、其他进程或手工脚本写入，
// 读取若直接强转类型，脏值会一路以“合法”形状流到 RPC 序列化才整体失败，单条坏数据拖垮整个列表。
// CONTRACT：所有 JSON 列（模型选择 / 附加目录 / 回推目标）先 JSON.parse 再 safeParse，失败一律降级为未设置。
// 权衡：降级会静默丢失配置，但比让 automation/list 整体报错更可恢复——用户还能在 UI 里重新选一次。
import { z } from "zod";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- automation 仓库集中维护 automations / automation_runs 的 sqlite schema、
   调度状态机写入与运行历史，稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AUTOMATION_CREATE_LIMIT,
  AUTOMATION_CREATE_LIMIT_ERROR_CODE,
  resolveWorkspaceKey,
  zcodeAutomationBotDeliveryTargetSchema,
  modelSelectionSchema,
  zcodeTaskModeSchema,
  type ZCodeAutomation,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeAutomationCreateParams,
  type ZCodeAutomationDispatchStatus,
  type ZCodeAutomationLifecycleStatus,
  type ModelSelection,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunDispatchStatus,
  type ZCodeAutomationRunOutcome,
  type ZCodeAutomationTrigger,
  type ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

// node:sqlite 是内置实验模块，部分 Node 版本与打包产物对它的 ESM 静态解析不稳定；
// 用 createRequire 在运行时加载，加载失败只会变成明确的运行时错误，而不是整个模块无法 import。
const require = createRequire(import.meta.url);
// 类型借 typeof import 拿到，不产生值层面的静态依赖：运行时从 require 走，类型检查从 d.ts 走，两条路互不影响。
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** 派发失败退避常量。 */
// 退避基数取 30s：短于一次 host 重启窗口就失去意义，长于用户在 UI 前能接受的等待又会显得卡住。
// 实际序列为 30s / 60s / 120s / 240s / 480s，与 DISPATCH_MAX_ATTEMPTS 共同界定总重试窗口。
export const DISPATCH_RETRY_BASE_MS = 30_000;
// 封顶防止 2^n 指数无界增长：对定时任务而言，等 15 分钟以上已不如让用户改配置或等下一个 cron 周期。
export const DISPATCH_RETRY_CAP_MS = 15 * 60_000;
// 5 次基本覆盖瞬时故障（网络抖动、目标 Host 重启、模型配置热更新）；
// 再失败视为环境性或配置性问题，循环任务放弃本轮、一次性任务直接转 failed，避免坏任务长期占用每个调度 tick。
export const DISPATCH_MAX_ATTEMPTS = 5;
/** 认领超时回收：running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。 */
// 认领是租约（running=1 + claimed_at），持有进程崩溃后无人主动释放，只能靠超时回收。
// 取 10 分钟：大于任何一次正常派发的耗世上界以免误伤健康长任务，又小于常见 cron 间隔量级，崩溃后最多错过一个周期。
export const CLAIM_STALE_MS = 10 * 60_000;

/** 创建总数超过产品上限；错误码会跨 RPC 保留在 message 中供 UI 识别。 */
export class AutomationCreateLimitError extends Error {
// 错误码要能跨 RPC 存活：Error 实例经过结构化克隆后自定义属性会丢，只剩 message 文本；
// 所以 message 里内嵌 [CODE]，UI 靠匹配常量而非文案判断创建上限，文案可以随意改。
  readonly code = AUTOMATION_CREATE_LIMIT_ERROR_CODE;

  constructor() {
    super(
      `[${AUTOMATION_CREATE_LIMIT_ERROR_CODE}] At most ${AUTOMATION_CREATE_LIMIT} automations may be retained. Delete an existing automation before creating another.`,
    );
// 显式设置 name：Error 子类默认 name 仍是 Error，会让日志与跨进程判断失去类型信息。
    this.name = "AutomationCreateLimitError";
  }
}

// AutomationRow 是 SQLite 的物理视图，列名 snake_case；它与 ZCodeAutomation 的 camelCase 有意分离。
// 列名是持久化契约，改列必须迁移；API 字段是协议契约，改动只需同步前端。
interface AutomationRow {
  automation_id: string;
  title: string;
// cron 原文按字符串保存，仓库刻意不解析：解析失败的表达式也必须能在列表里显示并被用户改掉，
// 若在写入时校验，历史脏数据将永远无法通过正常的编辑路径修复。
  cron_expr: string;
  prompt: string;
  model: string | null;
  provider: string | null;
  mode: string | null;
  thought_level: string | null;
  model_selection: string | null;
  workspace_key: string;
  workspace_path: string;
// workspace_identity 是 workspace_key 的派生输入之一（见 resolveWorkspaceKey），不是结果缓存；
// 允许为 NULL：老工作区没有记录 git 或远程身份，此时只按路径归属，后续识别到身份再由调用方重算 key。
  workspace_identity: string | null;
// 用可选列而非必选，是为了兼容尚未执行列迁移的旧库：SQLite 缺列时 SELECT * 不会返回该键，
// 读取侧统一以 == null 覆盖列不存在和值为 NULL 两种情况，避免升级瞬间全部读取失败。
  project_id?: string | null;
  host_id?: string | null;
// 以 JSON 数组字符串存储；读取时用 zod 限制元素非空且最多 256 条：
// 既防止异常大的数组撑爆解析内存，也防止空串在派发时被拼成一个不存在的 cwd 直接失败。
  additional_directories?: string | null;
  target_task_id: string | null;
// Bot 回推目标是内部路由信息，只通过 getBotDeliveryTarget 单列读取，
// 不进入 rowToAutomation 的展示模型，避免把投递凭证与路由参数泄露到 UI 协议里。
  bot_delivery_target: string | null;
// 历史版本可能写入过 local 与 remote 之外的值；读取时只认 remote，其余一律降级 local，
// 保证一个未知枚举不会把任务投递到错误的主机（宁可本地失败，也不要跨机误投）。
  location_kind: string;
// SQLite 没有原生布尔，必须统一按 0/1 存储；映射层只在边界做 === 1，不做真假值模糊判断。
// 避免字符串 "0" 在 JS 里被当成 true 这类跨语言陷阱。
  recurring: number;
// NULL 的语义是未显式限制，由 markDispatched 按一次性任务默认上限 1 解释；
// max_runs 不写默认值是刻意的：只有用户真的填过数字，UI 才需要展示这个字段。
  max_runs: number | null;
// 截止时刻是硬边界：claimDue 会先把 end < now 的任务转 completed，防止过期任务继续被 cron 认领；
// 同时 markDispatched 在 nextRunAt 越过 end_at 时也直接收尾，两条路径互为兜底。
  end_at: number | null;
// 结构化调度规则以 JSON 原文保存，仅用于回填编辑表单；
// 真正决定何时执行的是调用方算好的 next_run_at；两者不一致时必须以 next_run_at 为准，仓库不反推 cron 语义。
  schedule_rule: string | null;
// schedule_edited_by_user 为 1 时上层不再用默认模板覆盖，避免改完又被系统改回去。
  schedule_edited_by_user: number;
  run_count: number;
// 必须与 run_count 分开统计：maxRuns 只能被定时派发消耗，manual run 若也计数，
// 用户点几次“立即运行”就会把循环任务提前跑完，这是产品语义错误而不是实现细节。
  scheduled_run_count: number;
  enabled: number;
// lifecycle_status（active/paused/completed/failed）与 dispatch_status（本轮派发进度）正交：
// lifecycle_status 决定是否还参与调度，dispatch_status 描述最近一轮走到哪；claimDue 只看前者。
  lifecycle_status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  running: number;
// 认领时间戳本质是租约而不是锁：崩溃的持有者不会主动清 running，只能靠过期时间回收。
// 因此任何写 running=1 的路径都必须同时写 claimed_at，否则该行会永久卡在在途状态。
  claimed_at: number | null;
  dispatch_status: string;
// 只统计连续失败次数，成功派发或跳过都会清零；与 automation_runs.attempts 不同，
// 后者按 runId 累计，用于同一调度时刻重试时复用同一行台账，两个计数器服务于不同幂等目标。
  dispatch_attempts: number;
// 非空表示正处于退避等待：claimDue 此时只看 retry_at 而忽略 next_run_at，
// 否则一个已经过去的 next_run_at 会让每个 tick 都立即重试，把指数退避彻底绕过。
  retry_at: number | null;
// 最后一次失败原因，仅供展示；成功派发时清空。不做长度截断，截断会丢掉定位问题所需的堆栈尾部。
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

// run 行同时承担运行历史与幂等台账两个角色：run_id 唯一，同一调度时刻的重试必须命中同一行；
// 因此除 created_at 外，其余字段都允许被后续状态迁移覆盖，读取方不能假设它们只写一次。
interface AutomationRunRow {
  run_id: string;
  automation_id: string;
  workspace_key: string;
// scheduled_at 记录本轮应触发时刻而非实际执行时刻；重试期间必须保持原值。
// 这样 UI 上同一次调度只对应一条时间线，不会因为重试出现多个看起来独立的运行。
  scheduled_at: number | null;
// trigger 决定结算路径：manual 走 markManualRunDispatched（不推进 cron 与计数），
// schedule 走 markDispatched（推进 next_run_at 并消耗 maxRuns）；两条路径混用会污染调度节奏。
  trigger: string;
  model_selection: string | null;
  dispatch_status: string;
// 只由 session runtime 回写，可能多次上报 running 到 succeeded/failed/stopped；
// markRunOutcome 用 CASE 保证一旦进入终态，迟到的 running 回写不能把它改回去。
  outcome: string | null;
// 派发成功后才写入，并通过 COALESCE 更新：迟到的回写不能把已固定的 session 抹成 NULL。
  session_id: string | null;
  error: string | null;
// attempts 认领即加一，失败也保留；manual run 初始 attempts=1 表示已交给直接派发方。
// scheduler 只有在 updated_at 超过 CLAIM_STALE_MS 后才把它当崩溃残留重新认领。
  attempts: number;
  created_at: number;
  updated_at: number;
}

// 认领结果必须同时返回 automation 与 run：调用方要用 workspace_path 解析目标 Host、
// 又要用 runId 做后续结算；分两次查询会出现状态漂移（中间可能被别的进程改掉）。
export interface ClaimedManualAutomationRun {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}

// 纯函数映射，不做 IO，除 zod 解析外不抛异常，便于在事务内对刚写入的行做回读等价构造。
// 注意它必须与 writeRow 的列集合保持一致：新增字段时两边都要改，否则编辑会静默丢字段。
function rowToAutomation(row: AutomationRow): ZCodeAutomation {
// modelSelection 单独抽出：旧列不可回退的语义特殊，混在对象字面量里容易被后续改动误删。
  // modelSelection 只解析一次并复用，缺失时下方展开语法让该键整体缺席。
  // 解析失败在这里降级为 undefined，不能让单条脏 JSON 把整个 list 拖垮。
  const modelSelection = readAutomationModelSelection(row);
  return {
    // automationId 直接来自列，不重新生成；它是 run 台账与 UI 操作的主键锚点。
    // 若在这里改写 id，run 历史与 automation 的关联会断。
    automationId: row.automation_id,
    // title 只做原样透传；空标题必须由协议层拦截，映射层不补默认文案。
    title: row.title,
// cronExpr 原样透传，映射层不解析也不校验：无法解析的表达式同样要能显示在 UI 上被改掉。
// automationId 之类的身份字段由仓库生成，调用方不能自带，避免多端生成相同 id 撞唯一键。
    // cronExpr 原样透传而不解析，调用方才能把无法解析的历史表达式改掉。
    cronExpr: row.cron_expr,
    // prompt 原样透传，这里是派发时真正提交给模型的输入。
    prompt: row.prompt,
    ...(modelSelection ? { modelSelection } : {}),
    // 历史版本曾把空字符串写进 mode，旧读取逻辑又直接强转为枚举，导致
    // automation/list 在协议层校验整个数组时被单条脏数据拖垮。历史非法值按未设置兼容。
// 历史版本把空串写进过 mode，旧读取逻辑直接强转枚举，导致单条脏数据让整个数组在协议层校验失败；
// 这里按未设置兼容，写入路径则由 assertValidAutomationMode 严格拦截，读写策略不对称是刻意的。
    mode: normalizeAutomationMode(row.mode),
    // workspaceKey 与 workspacePath 同时暴露：前者做归属校验，后者做派发。
    workspaceKey: row.workspace_key,
// workspaceKey 用于归属校验，workspacePath 用于实际派发 cwd 与 Host；两者不可互相推导。
// 两者不能互相推导，跨机场景下 key 稳定而 path 可能随机器变化。
    workspacePath: row.workspace_path,
// workspaceIdentity 允许为空（老工作区未记录 git 或远程标识）；空值只影响 key 派生，
// 不影响读取，因此不要在这里补默认值，否则会改变归属判定结果。
    workspaceIdentity: row.workspace_identity ?? undefined,
    ...(row.project_id == null ? {} : { projectId: row.project_id }),
    ...(row.host_id == null ? {} : { hostId: row.host_id }),
    ...(row.additional_directories == null
      ? {}
      : {
          additionalDirectories: z
            .array(z.string().min(1))
            .max(256)
            .parse(JSON.parse(row.additional_directories)),
        }),
// undefined 表示未绑定任务，与 null 在 DB 层等价，但 API 层用 undefined 让 JSON 序列化直接省略该键。
    targetTaskId: row.target_task_id ?? undefined,
// 白名单式归一：只有精确等于 remote 才算远程，其余（含脏值）都按本地处理。
// location_kind 的兜底是安全默认值：误判成本本地高于远程。
    locationKind: row.location_kind === "remote" ? "remote" : "local",
// 只认精确的 1：历史数据里可能出现过 2 或字符串 "1"，宽泛判断会把一次性任务误当成循环任务，
// 进而让它永远不被 maxRuns 收尾。
    // recurring 只认精确的 1：历史脏值 2 或 "1" 必须按一次性处理，否则 maxRuns 永远收不了尾。
    recurring: row.recurring === 1,
    // maxRuns 缺省为 undefined，markDispatched 才按一次性任务默认 1 解释。
    maxRuns: row.max_runs ?? undefined,
    endAt: row.end_at ?? undefined,
    scheduleRule: row.schedule_rule
      ? (JSON.parse(row.schedule_rule) as ZCodeAutomation["scheduleRule"])
      : undefined,
    ...(row.schedule_edited_by_user === 1 ? { scheduleEditedByUser: true } : {}),
// runCount 含 manual，用于 Card 累计展示；maxRuns 判定必须用 scheduledRunCount，
// scheduled_run_count 不再派生第二个字段，避免展示层误用。
    runCount: row.run_count,
// enabled 由 lifecycleStatus 推导（active=1，其余=0），但读取时以列为准：
// 两者在历史数据里可能不一致，claimDue 依据列值，若以 lifecycle 覆盖会让已完成任务被重新认领。
    // enabled 以列为准而不由 lifecycleStatus 反推，claimDue 只信这一列。
    // 若用 lifecycle 覆盖，已完成任务会被重新认领并重复触发。
    enabled: row.enabled === 1,
    lifecycleStatus: row.lifecycle_status as ZCodeAutomationLifecycleStatus,
    nextRunAt: row.next_run_at ?? undefined,
// 最近一次成功派发时间（不是运行结束时间）：它由 markDispatched 写，
// 因此失败重试期间不会更新，UI 上“上次运行”不会因为一次失败而跳动。
    // lastRunAt 是最近一次成功派发时间，失败重试期间保持不变。
    lastRunAt: row.last_run_at ?? undefined,
// 直接强转而不做 safeParse：这是内部状态机字段，非法值应当暴露出来而不是静默降级；
// dispatch_status 读取端只做展示，不据此改变调度，所以强转的爆炸半径可控。
    dispatchStatus: row.dispatch_status as ZCodeAutomationDispatchStatus,
    dispatchAttempts: row.dispatch_attempts,
    retryAt: row.retry_at ?? undefined,
// last_error 空串也算有值，但 UI 上等价于没有错误；这里只把 NULL 归一为 undefined。
// 必须保留空串，以免把上游写入的真实信息丢掉。
    lastError: row.last_error ?? undefined,
    // createdAt 用于列表稳定排序，不能用 updatedAt 推导。
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 旧列（model/provider/thought_level）只允许通过独立 importer 读取，此处单一入口保证不扩散；
// 新列损坏或明确清空（JSON null）时不能复活旧选择，否则用户改回默认会被旧值悄悄覆盖。
function readAutomationModelSelection(row: AutomationRow): ZCodeAutomation["modelSelection"] {
  // 旧字段只能经过独立 importer；新字段损坏或明确清空时不能复活旧选择。
  return readSerializedModelSelection(row.model_selection);
}

// 序列化前用 schema.parse 而非 safeParse：自己写出去的数据不合法说明调用方传错。
// 此时必须直接抛错，否则会写入一条将来读不出来的记录。
function serializeAutomationModelSelection(
  selection: ZCodeAutomation["modelSelection"],
): string | null {
// 返回 null 表示缺配置或未迁移，与 JSON 字符串 null（明确跟随工作区默认）严格区分；
// DB 里分别是 SQL NULL 和文本；语义不同必须走不同兜底分支。
  if (!selection) return null;
  const options = selection.options;
// 只挑选协议字段再 parse：调用方可能传入带额外属性的对象，直接整体序列化会把内部字段持久化下来。
  const parsed = modelSelectionSchema.parse({
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(options && Object.keys(options).length > 0 ? { options } : {}),
  });
// 返回规范化后的 JSON：字段顺序与默认值由 zod 输出决定，便于后续做文本级比较与迁移。
  return JSON.stringify(parsed);
}

// 读路径的宽松归一：解析失败返回 undefined（视为未设置），绝不抛错，保证列表接口永远可用。
// 与之配对的写路径 assertValidAutomationMode 是严格的，宽松只用于兼容历史。
function normalizeAutomationMode(mode: string | null): ZCodeAutomation["mode"] | undefined {
  const parsed = zcodeTaskModeSchema.safeParse(mode);
  return parsed.success ? parsed.data : undefined;
}

// Repo 是绕过 RPC 时的最终持久化边界：即使调用方直接调 create/update，也不能把非法 mode 写进库。
// 读取兼容脏数据不等于允许继续制造脏数据，这两件事必须由不同函数表达。
function assertValidAutomationMode(mode: unknown): void {
// undefined 与 null 都表示不改或未设置，是合法输入；空串不在此列，会被 schema 判为非法。
  if (mode === undefined || mode === null) return;
  if (!zcodeTaskModeSchema.safeParse(mode).success) {
    // 读取兼容历史脏数据不代表允许继续写脏数据；Repo 是绕过 RPC 时的最终持久化边界。
// 错误信息里带上原值：这类问题通常来自前端拼装或旧客户端，日志里没有原值就无法复现。
    throw new Error(`Invalid automation mode: ${String(mode)}`);
  }
}

// run 的映射保持只读语义：outcome 与 dispatch_status 只是上报结果，映射层不做任何状态推断。
function rowToRun(row: AutomationRunRow): ZCodeAutomationRun {
// run 的模型选择是首次派发时冻结的值；解析失败按 undefined 处理，
// 调用方会回退到 automation 上的配置，而不是让历史列表整体失败。
  const modelSelection = readSerializedModelSelection(row.model_selection);
  return {
    runId: row.run_id,
    automationId: row.automation_id,
    workspaceKey: row.workspace_key,
    scheduledAt: row.scheduled_at ?? undefined,
// trigger 同样采用强转：历史 run 可能带未知值，展示层容忍而调度层只按已知值分支。
    trigger: row.trigger as ZCodeAutomationTrigger,
    ...(modelSelection ? { modelSelection } : {}),
    // run 的 dispatch_status 只描述本条落库进度，调度层不据它推进 cron。
    dispatchStatus: row.dispatch_status as ZCodeAutomationRunDispatchStatus,
    outcome: (row.outcome as ZCodeAutomationRunOutcome | null) ?? undefined,
    sessionId: row.session_id ?? undefined,
    error: row.error ?? undefined,
    // attempts 是 run 行自己的计数，与 automation.dispatch_attempts 语义不同。
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 通用容错读取：这一列既可能是 SQL NULL，也可能是被外部工具改坏的文本。
// 任何异常都收敛为 undefined，保证一个坏 run 不会让整个历史页打不开。
function readSerializedModelSelection(value: string | null): ModelSelection | undefined {
// model_selection 空串与 NULL 等价：早期写入路径曾在缺值时落过空串。
  if (!value) return undefined;
  try {
// JSON.parse 在 try 内：语法错误（例如手工 SQL 写坏）与结构不合法（schema 失败）都走同一条降级路径。
    const parsed = modelSelectionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 退避重试时间：now + min(BASE * 2^(attempts-1), CAP)。 */
// attempts 必须用 Math.max(0, attempts - 1) 兜底，纯函数便于单测与外部复用。
// 防止调用方传 0 或负数时算出小数延迟，导致退避时间不可预期。
export function computeRetryAt(now: number, attempts: number): number {
// 指数退避加封顶：Math.min 保证极端情况下仍是有限等待，不会因 attempts 很大而溢出成 Infinity。
  const backoff = Math.min(
    DISPATCH_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    DISPATCH_RETRY_CAP_MS,
  );
// 以调用方给定的 now 为基准而非内部取时间：便于调度器用同一 tick 的时间戳批量计算，保证一致性。
  return now + backoff;
}

/**
 * automation 存储仓库：automations（定义 + 调度状态）与 automation_runs（运行历史 + runId 幂等台账），
 * 与 task index 同库 tasks-index.sqlite（WAL、多进程安全）。
 *
 * 仓库只做存储与原子状态迁移；cron 表达式解析 / next_run_at 计算由调用方（scheduler / 管理层）
 * 用 cron 库算好后传入，仓库不感知 cron 语义。
 */
// AutomationRepo 与 task index 共库 tasks-index.sqlite 且使用 WAL，因此写操作必须考虑多进程并发。
// 跨进程没有共享内存锁，只能用 BEGIN IMMEDIATE 串行化，再用条件 UPDATE 做比较并交换式状态迁移。
// 仓库不感知 cron 语义：next_run_at 由调用方算好传入，避免把调度策略耦合进存储层。
export class AutomationRepo {
// 迁移时若因空间或权限原因跳过备份，需要把这个事实暴露给上层做告警；
// 放在实例字段而非模块全局，避免同进程多个 repo 之间互相覆盖。
  migrationBackupSkipped = false;
// 连接懒加载：构造时不动磁盘，第一次 ensureReady 才建立，避免模块 import 阶段就产生副作用。
// null 同时是未初始化的哨兵，getDatabase 据此给出可诊断的错误而不是难查的解引用异常。
  private db: DatabaseSyncInstance | null = null;
// dbPath 记录当前连接真正打开的路径，用于检测运行期路径被切换时是否需要重连。
  private dbPath: string | null = null;
// 以 Promise 而非布尔做就绪标记：并发调用 ensureReady 会共享同一次初始化，
// 避免两个请求同时建连、同时跑迁移导致唯一约束冲突；失败后置回 null，允许下次重试。
  private initializePromise: Promise<void> | null = null;
  // db 路径不能从进程级全局 _dataBaseDir（getTasksIndexDatabasePath）解析：
  // vitest threads 池会在同一进程并发跑多个测试文件，各文件的 setDataBaseDir(tempDir)
  // 互相覆盖全局值，导致 repo 与裸 SQL 操作在并发窗口内写进真实库 ~/.zcode/v2（历史脏数据
  // /tmp/ws 系列即因此污染）。改为构造期固定一份 dbPath，测试通过依赖注入传入临时库路径，
  // 生产路径不传则回退 getTasksIndexDatabasePath，向后兼容。
// 构造期一次性固定路径，绝不每次读全局 getTasksIndexDatabasePath：
// vitest threads 池会在同一进程并发跑多个测试文件，各自的 setDataBaseDir 会互相覆盖全局值，
// 曾因此让 repo 与裸 SQL 在竞态窗口内写进真实库 ~/.zcode/v2（历史脏数据即源于此）。
  private readonly resolvedDbPath: string | null;

// 依赖注入点：测试传临时库路径即可完全隔离；生产不传则回退全局解析函数，保持向后兼容。
  constructor(
    dbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {
// 空白字符串按未指定处理，避免传入空串时拼出目录路径导致 mkdir 打开当前工作目录。
    this.resolvedDbPath = dbPath?.trim() || null;
  }

// 只在真正建连时求值一次；若注入路径为空则退回全局路径，保证老调用方行为不变。
  private resolveDbPath(): string {
// 用 ?? 而非 ||：只有 null/undefined 才回退，注入的空串已在上游被归一。
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

// 幂等入口：所有公共方法第一步都调它，保证调用方无需关心初始化时序。
// 若目标路径与已连接路径不一致则先关闭旧连接，支持测试在同一实例上切换数据目录。
  async ensureReady(): Promise<void> {
// 先取路径再判断：路径变化必须断开重连，否则后续 SQL 会写进上一个数据库（跨工作区污染）。
    const path = this.resolveDbPath();
// 静默关闭旧连接而不抛错：主动切换是合法场景，只有当新连接也失败时才应把错误抛给调用方。
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
// 双重检查：这里没有 await，JS 单线程保证同 tick 内只有一个调用者进入，
// 后续并发调用直接 await 同一个 Promise。
    if (!this.initializePromise) {
// 失败时先关闭半初始化连接并把 Promise 复位，否则后续 ensureReady 会永远拿到同一个 rejected Promise，
// 否则表现为磁盘问题修好后 initializePromise 仍一直 rejected。
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

// 默认吞掉关闭错误：退出流程里关闭失败不应掩盖真正的业务错误。
// 需要严格语义的场景可传 throwOnError 显式要求抛出。
  close(options?: { throwOnError?: boolean }): void {
// 先捕获后抛出，保证 this.db 一定被置空，否则一次关闭失败会让实例永久处于看似已连接的坏状态。
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore
    }
    this.db = null;
    this.dbPath = null;
// 必须复位 Promise：close 后再次 ensureReady 应该真正重新初始化，而不是复用已完成的旧 Promise 什么都不做。
    // 复位 initializePromise，close 后 ensureReady 才会真正重建连接。
    this.initializePromise = null;
// 复位完成后再抛：调用方即使收到异常，也不会留下一个半关闭的实例。
    if (options?.throwOnError && closeError) throw closeError;
  }

// initialize 先建目录，再建连接并设置 PRAGMA，最后按需跑迁移。
// 任一步失败都向上抛，由 ensureReady 的 catch 统一收尾（关闭连接并复位 Promise）。
  private async initialize(path: string): Promise<void> {
// 目录可能位于用户从未创建过的位置（首次启动或临时测试目录），必须先建父目录再 open。
    // mkdir recursive 先建父目录，否则独立库路径首次 open 会失败。
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
// 同步打开：node:sqlite 的 API 是同步的，这里用 async 只是为了包住前面的 mkdir。
      this.db = new DatabaseSync(path);
      this.dbPath = path;
// busy_timeout 让跨进程写锁竞争时等待而不是立即 SQLITE_BUSY；5s 默认值足够覆盖一次迁移或批量写入。
// 该 PRAGMA 是阻塞式重试，不会让 Node 事件循环真正忙等，代价可接受。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
// WAL 让读不阻塞写，scheduler 与 UI 查询因此可以并发。
// 代价是必须在 close 时正常关闭，否则会残留 -wal 文件（由迁移与上层清理负责）。
      this.db.exec("PRAGMA journal_mode = WAL");
// NORMAL 在 WAL 下只保证应用级崩溃不丢数据，不保证断电级持久性；
// 调度状态可以从 next_run_at 重算，用这点持久性换写入延迟是划算的。
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
// 已就绪标记写在库内元数据里，命中即跳过迁移；这是启动热路径，必须尽量少做 IO。
    if (isTasksStoragePrepared(path, this.db)) return;
// 迁移结果里的 backupSkipped 要向上冒泡：备份被跳过意味着回滚能力缺失，运维需要知道。
    if (!isTasksStorageMigrated(path, this.db))
      this.migrationBackupSkipped = (await runTasksDatabaseMigrations(this.db, path)).backupSkipped;
  }

// 所有内部读写都经此取连接，保证未初始化不会变成难查的空指针，而是一句可操作的提示。
  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
// 提示里直接给出修复方式：这类问题几乎都来自新加的调用方忘了先 await ensureReady。
      throw new Error("AutomationRepo 未初始化：请先 await ensureReady()");
    }
    return this.db;
  }

  // workspaceKey 传入时强制归属校验（写/单查路径,防跨 workspace 越界）；省略=不加过滤,
  // 供 scheduler/host 跨 workspace 的调度状态机使用。
// workspaceKey 传了就是强归属校验（写路径与单条查询，防跨 workspace 越界）；
// 省略则不加过滤，供 scheduler 与 host 这类需要跨 workspace 扫描调度状态机的内部调用使用。
  private getRow(automationId: string, workspaceKey?: string): AutomationRow | null {
    const row = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .get({ id: automationId, workspace_key: workspaceKey ?? null }) as AutomationRow | undefined;
// 统一把 undefined 归一成 null：SQLite 的 get 在无命中时返回 undefined，
// 上层只需处理 null 一种不存在，减少分支。
    return row ?? null;
  }

  // ---- 管理 CRUD ----

// 创建走显式事务：计数检查与插入必须原子，否则多窗口或 CronCreate 并发请求会同时通过旧计数。
// 返回值通过回读行构造，保证与真实落库内容一致（含 DB 端默认值与约束后的结果）。
  async create(
// 参数即协议对象，仓库不裁剪字段：多余字段在序列化时被忽略，缺字段由 zod 在 RPC 层先拦。
    params: ZCodeAutomationCreateParams,
// nextRunAt 与 lifecycleStatus 是仓库唯一无法自行推导的调度信息，必须由调用方显式给出。
// lifecycleStatus 缺省为 active；completed 用于创建即终态的场景（例如目标时间已过）。
    options: { nextRunAt: number | null; lifecycleStatus?: ZCodeAutomationLifecycleStatus },
  ): Promise<ZCodeAutomation> {
    // 写在 await 之前：非法 mode 必须在碰磁盘前被拒，否则会先建目录再回滚。
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const now = Date.now();
// 前缀让 id 在日志与 URL 里自解释；uuid 保证跨进程唯一，避免多端同时创建撞键。
// 同一 id 也作为 run_id 的前缀，便于从一条 run 反查所属任务。
    const automationId = `automation-${randomUUID()}`;
    // workspaceKey 由 path 与 identity 派生，之后所有归属校验都用这份快照。
    // 不要用原始 path 当 key：同一目录换身份会得到不同 key，混用会串权限。
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const db = this.getDatabase();
    // 仅在 UI 或事务外先 list 再 create，会让多窗口/CronCreate 并发请求同时通过旧计数。
    // BEGIN IMMEDIATE 串行化“全状态总数检查 + 插入”，确保本地任务索引不会突破 20 条。
    // BEGIN IMMEDIATE 立即拿写锁，把计数检查与 INSERT 串行化。
    // 若用 DEFERRED，两个进程可能同时读到旧计数并各自插入。
    // 上限统计全部状态，用户不能靠制造 completed 行绕过 AUTOMATION_CREATE_LIMIT。
    db.exec("BEGIN IMMEDIATE");
    try {
// 计数在事务内读，且统计全部状态（含 completed/failed）：上限是保留总量而非活跃量，
// 否则用户可以靠不断制造终态任务绕过限制。
      const countRow = db.prepare("SELECT COUNT(*) AS count FROM automations").get() as {
        count: number | bigint;
      };
// 用 Number 转换：SQLite 的 COUNT 可能返回 bigint，直接与 number 比较会因类型不同出错。
// 判断放在插入之前而不是靠唯一约束，是为了给出明确的业务错误码而非底层 SQL 报错。
      if (Number(countRow.count) >= AUTOMATION_CREATE_LIMIT) {
// 抛业务错误后由外层 catch 统一 ROLLBACK：这里不自己回滚，避免两条回滚路径互相干扰。
        throw new AutomationCreateLimitError();
      }
      db.prepare(
        `INSERT INTO automations (
          automation_id, title, cron_expr, prompt, model, provider, model_selection,
          workspace_key, workspace_path, workspace_identity, project_id, host_id, additional_directories, target_task_id, bot_delivery_target, location_kind,
          recurring, max_runs, end_at, schedule_rule, schedule_edited_by_user,
          run_count, enabled, lifecycle_status,
          next_run_at, last_run_at, running, claimed_at,
          dispatch_status, dispatch_attempts, retry_at, last_error,
          mode, thought_level,
          created_at, updated_at
        ) VALUES (
          @automation_id, @title, @cron_expr, @prompt, @model, @provider, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity, @project_id, @host_id, @additional_directories, @target_task_id, @bot_delivery_target, 'local',
          @recurring, @max_runs, @end_at, @schedule_rule, 0,
          0, @enabled, @lifecycle_status,
          @next_run_at, NULL, 0, NULL,
          'idle', 0, NULL, NULL,
          @mode, @thought_level,
          @created_at, @updated_at
        )`,
      ).run({
        // automationId 在事务外生成，事务内只负责绑定；失败重试会得到新 id。
        automation_id: automationId,
// 创建时不做 ?? 合并：必填字段由协议保证，缺值应尽早暴露而不是静默落成空标题。
        title: params.title,
        // cron_expr 不在这里校验：无法解析的历史表达式也要能保存后被用户改掉。
        cron_expr: params.cronExpr,
        // prompt 缺省不做兜底，缺值应在协议层被 zcode 校验拦住。
        prompt: params.prompt,
// 旧三列在新建时一律写 NULL，不落任何值：迁移由独立 importer 完成，
// 这样回滚到旧版本也不会读到一个半新半旧的混合配置。
        model: null,
        provider: null,
        // 任务配置的显式空值与尚未迁移的 SQL NULL 分开；run 的 SQL NULL 冻结语义不变。
// 关键区分：未传 modelSelection 时写文本 null（跟随工作区默认），不是 SQL NULL。
// 这里必须用 ?? 而不是 ||：空对象等合法值不能被当成假值而误写成跟随默认。
// run 的 SQL NULL 冻结语义不同，不要照搬到这里。
        model_selection: serializeAutomationModelSelection(params.modelSelection) ?? "null",
// 已在入口用 assertValidAutomationMode 校验，这里只需处理缺省。
        mode: params.mode ?? null,
        thought_level: null,
// 落库的是派生 key 而非原始路径：后续所有归属校验都基于它，路径变化不会让任务失联。
        // 落库的是派生 key 而非原始路径，后续归属校验都基于它。
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
// 显式写 null 而不是省略列：保证 INSERT 的列集合固定，便于将来按列做迁移与审计。
        project_id: params.projectId ?? null,
        host_id: params.hostId ?? null,
        additional_directories:
          params.additionalDirectories === undefined
            ? null
            : JSON.stringify(
                z.array(z.string().min(1)).max(256).parse(params.additionalDirectories),
              ),
// 任务绑定是创建时固定的：绑定关系影响权限判定（hasTaskBinding），不应在后续编辑里漂移。
        target_task_id: params.targetTaskId ?? null,
        bot_delivery_target: params.botDeliveryTarget
          ? JSON.stringify(params.botDeliveryTarget)
          : null,
// 布尔在写入前就转成 0/1，repo 之外不必知道 SQLite 没有布尔类型。
        recurring: params.recurring ? 1 : 0,
// 缺省落 NULL 而非 1：只有 markDispatched 在判定时才把一次性任务默认成上限 1，写入层不猜业务语义。
        max_runs: params.maxRuns ?? null,
        end_at: params.endAt ?? null,
        schedule_rule: params.scheduleRule ? JSON.stringify(params.scheduleRule) : null,
// enabled 必须与 lifecycleStatus 同源推导，绝不能分两处各写一次：
// 两者不一致会让 claimDue 认领一个已完成的任务，或漏掉一个本应参与调度的任务。
        // enabled 必须与 lifecycleStatus 同源，分两处写会出现已完成仍被认领。
        enabled: options.lifecycleStatus === "completed" ? 0 : 1,
// 默认 active 而不是 paused：创建即生效是产品预期，暂停需要用户显式操作。
        lifecycle_status: options.lifecycleStatus ?? "active",
        // next_run_at 由调用方算好传入，仓库不解析 cron。
        next_run_at: options.nextRunAt,
        // created_at 与 updated_at 用同一个 now，避免创建瞬间就出现 updated 早于 created。
        created_at: now,
        updated_at: now,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
// 回读而不是用入参拼装：让返回值包含 DB 端生成或约束的结果（例如列默认值、类型收敛）。
// 感叹号是安全的：插入刚提交且 id 唯一，除非有别的进程在同一瞬间删除。
    return rowToAutomation(this.getRow(automationId)!);
  }

// scope 省略表示列出全部 workspace，供跨工作区汇总面板使用；传了就按派生 key 过滤。
// 这里不做分页：产品上限是 20 条（见 AUTOMATION_CREATE_LIMIT），全量返回比引入分页协议更简单。
// 排序用 created_at DESC 而非 updated_at：列表顺序要稳定，避免编辑一条任务后它跳到最前面。
  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    // scope 为空表示跨 workspace 汇总，此时 workspaceKey 传 null 让 WHERE 整体放行。
    // 传了路径就必须重新派生 key：只给 path 时 identity 缺省，key 会与创建时不一致。
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    // 列表不做分页：产品上限是 AUTOMATION_CREATE_LIMIT，全量返回比引入分页协议更简单。
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automations
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({ workspace_key: workspaceKey }) as unknown as AutomationRow[];
    // 逐行映射保持只读语义：单条脏数据由 rowToAutomation 内部降级，不拖垮整个列表。
    return rows.map(rowToAutomation);
  }

  /** 首次派发专用读取：列表可以展示未绑定任务，但派发不能把损坏值当成跟随默认。 */
// 首次派发专用读取，容错策略与列表读取不同：列表可以展示未绑定，派发不能把损坏值当成默认。
// 返回 undefined 表示跟随工作区默认，抛错表示配置存在但不可用，两者对调用方的处置完全不同。
// 抛错而非回退默认是安全选择：静默跑错模型比明确失败更难排查。
  async getModelSelectionForDispatch(
    automationId: string,
    workspaceKey: string,
  ): Promise<ModelSelection | undefined> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
// 归属校验失败与不存在返回同一个错误：不区分存在但属于别人，避免被用来探测其他工作区的任务 id。
    if (!row) throw new Error("Automation 不存在或不属于当前工作区");
    const selection = readAutomationModelSelection(row);
    if (selection) return selection;
    // 迁移已把旧默认写为 JSON null。SQL NULL 是缺配置，不能借旧列决定执行默认值。
// 迁移已把跟随工作区默认写成 JSON 文本 null，与 SQL NULL（缺配置或未迁移）区分开。
// 比较 model_selection === "null" 是刻意的：它检查持久化表示而不是解析后语义。
// 只有明确跟随默认才放行 undefined；其余情况必须要求用户重选，避免旧默认值悄悄生效。
    const followsWorkspace = row.model_selection === "null";
    if (!followsWorkspace) throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    return undefined;
  }

  /**
   * 仅供后台派发读取 Bot 回推目标；该内部来源信息不进入 automation 展示模型。
   */
  async getBotDeliveryTarget(
    automationId: string,
    workspaceKey?: string,
  ): Promise<ZCodeAutomationBotDeliveryTarget | undefined> {
    await this.ensureReady();
    const raw = this.getRow(automationId, workspaceKey)?.bot_delivery_target;
    // bot_delivery_target 为 NULL 时按未配置处理，不构造空对象。
    if (!raw) return undefined;
    try {
      const parsed = zcodeAutomationBotDeliveryTargetSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // Bug 原因：历史/外部写入的脏 JSON 不能拖垮任务列表或 scheduler；无效来源按未配置处理。
      return undefined;
    }
  }

// 只回答该任务是否绑定在本 workspace，不返回任务内容，最小化权限查询的爆炸半径。
// 过去实现是拉全量列表再序列化，任意无关展示字段损坏都会让安全判定失败，属于过度取数。
// 现在直接 SELECT 1 并严格限定 workspace_key，命中即返回，也能走索引。
  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    await this.ensureReady();
    // scope 同时带 path 与 identity，resolveWorkspaceKey 才能算出与创建时一致的 key。
    // 授权语义：返回 false 必须按拒绝处理，不能回退成「在列表里找得到就算绑定」，
    // 那会绕开 workspace_key 过滤，让同名 taskId 跨工作区通过判定。
    const workspaceKey = resolveWorkspaceKey(scope);
    // CronCreate 过去为判断一个 session 的归属而读取并序列化完整列表，任意无关
    // 展示字段损坏都会让安全查询失败。这里仅查询授权判据本身，并严格限定 workspaceKey。
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS bound FROM automations
        WHERE workspace_key = @workspace_key AND target_task_id = @target_task_id
        LIMIT 1`,
      )
      .get({ workspace_key: workspaceKey, target_task_id: scope.targetTaskId }) as
      | { bound: number }
      | undefined;
    return row !== undefined;
  }

  async get(automationId: string, workspaceKey?: string): Promise<ZCodeAutomation | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    // 不在时返回 null 而不是抛错：UI 删除后仍可能提交读取。
    return row ? rowToAutomation(row) : null;
  }

  /** maxRuns 的生命周期口径只统计定时派发；manual run 仅属于 Card 累计展示。 */
// `getScheduledRunCount` 只数定时派发；manual run 计入 `run_count` 仅供 Card 累计展示。
// 返回 null 表示任务不存在（调用方据此放弃收尾），返回 0 表示存在但尚未跑过，两者不能合并。
// 单独开这个读方法，是为了让调用方不必为一个计数去解析整行（含多处 JSON 列）。
  async getScheduledRunCount(automationId: string, workspaceKey?: string): Promise<number | null> {
    await this.ensureReady();
    const row = this.getRow(automationId, workspaceKey);
    // null 表示任务不存在，0 表示存在但尚未跑过，两者不能合并。
    return row?.scheduled_run_count ?? null;
  }

  /**
   * 编辑定义字段。调用方按需传入重算后的 nextRunAt（改 cron_expr 时）与新的 lifecycleStatus
   * （改 recurring/max_runs 时），仓库不感知 cron 语义。改 cron_expr 时清空 retry 态。
   */
// 读改写模式：先读整行复制成 next，再整体写回。新增字段时只需在 next 里补一行，
// 不会出现部分列忘记更新的静默 bug；代价是一次额外读，单行读成本可忽略。
// update 不是事务：读与写之间有窗口，并发编辑同一任务可能后写覆盖先写。
  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    options?: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomationLifecycleStatus;
      resetRetry?: boolean;
    },
    workspaceKey?: string,
  ): Promise<ZCodeAutomation | null> {
    // 编辑同样要过 mode 校验：读取宽容易脏数据，但写入必须严格。
    assertValidAutomationMode(params.mode);
    await this.ensureReady();
    const existing = this.getRow(automationId, workspaceKey);
// 不存在时返回 null 而非抛错：调用方多为乐观 UI，删除后仍可能提交编辑，静默失败体验更好。
    if (!existing) return null;
    const now = Date.now();
    // ...existing 先复制整行，再逐字段覆盖；不这么做会让未传字段被写回 NULL。
    const next: AutomationRow = {
      ...existing,
      title: params.title ?? existing.title,
      // undefined 表示本次不改 cron，只有显式传入才覆盖，避免编辑标题时清空调度。
      // 改 cron 时调用方必须同时传重算后的 nextRunAt，否则 next_run_at 会停在旧周期。
      cron_expr: params.cronExpr ?? existing.cron_expr,
      prompt: params.prompt ?? existing.prompt,
      // 旧三列只供回滚保留；标题等编辑不能清除尚未迁入的旧选择，也不能参与新版运行读取。
      model: existing.model,
      provider: existing.provider,
// 三态合并：undefined 表示不改，null 表示显式清空（写文本 null 跟随工作区默认），对象表示新值。
// 写入前必须序列化：DB 列是文本，直接塞对象会变成 [object Object]。
// 显式清空不能落 SQL NULL：那会被读路径当成未迁移，导致旧的 model 与 provider 列被重新启用。
      model_selection:
        params.modelSelection === undefined
          ? existing.model_selection
          : (serializeAutomationModelSelection(params.modelSelection ?? undefined) ?? "null"),
      // mode 三态合并：undefined 不改，null 表示未设置，其余值已在入口过 schema。
      mode: params.mode === undefined ? existing.mode : params.mode,
      thought_level: existing.thought_level,
      recurring: params.recurring === undefined ? existing.recurring : params.recurring ? 1 : 0,
      max_runs: params.maxRuns === undefined ? existing.max_runs : params.maxRuns,
      end_at: params.endAt === undefined ? existing.end_at : params.endAt,
      schedule_rule:
        params.scheduleRule === undefined
          ? existing.schedule_rule
          : params.scheduleRule
            ? JSON.stringify(params.scheduleRule)
            : null,
      schedule_edited_by_user:
        params.scheduleEditedByUser === undefined
          ? existing.schedule_edited_by_user
          : params.scheduleEditedByUser
            ? 1
            : 0,
// nextRunAt 由调用方按新 cron 重算后传入：undefined 保持，null 清空（例如转 completed）。
// 仓库绝不自己算时间：cron 解析在管理层的依赖里，放这里会让存储层耦合调度库。
// 这是唯一允许调用方直接改写 next_run_at 的编辑路径，其他状态迁移都走 markDispatched。
      next_run_at: options?.nextRunAt === undefined ? existing.next_run_at : options.nextRunAt,
      lifecycle_status: options?.lifecycleStatus ?? existing.lifecycle_status,
      dispatch_attempts: options?.resetRetry ? 0 : existing.dispatch_attempts,
      retry_at: options?.resetRetry ? null : existing.retry_at,
      dispatch_status: options?.resetRetry ? "idle" : existing.dispatch_status,
      // enabled 完整由 lifecycleStatus 推导：仅当调用方显式改了生命周期时才动它
      // （active→入调度=1；completed/failed/paused→出调度=0），否则保持原值。
      // 修复：原实现在 completed/failed 时错误保留 existing.enabled，可能出现「已完成但仍被 claimDue 认领」。
// enabled 完全由 lifecycleStatus 推导：active 入调度为 1，completed/failed/paused 出调度为 0。
// 修复过一个真实 bug：原实现在 completed/failed 时保留 existing.enabled，
// 于是已完成的任务仍会被 claimDue 认领，造成重复执行。
      enabled: options?.lifecycleStatus
        ? options.lifecycleStatus === "active"
          ? 1
          : 0
        : existing.enabled,
      updated_at: now,
    };
    // writeRow 只覆盖可编辑列，running 与 claimed_at 等运行时状态保持原样。
    // 若把整行 UPDATE 全列，编辑定义会意外释放正在进行的认领。
    this.writeRow(next);
    return rowToAutomation(next);
  }

// 返回 changes>0 而不是无条件成功：调用方据此区分真的删了与本来就不存在或不属于你。
// run 历史不在这里级联删除：保留审计线索，由 pruneRuns 按时间统一清理。
  async delete(automationId: string, workspaceKey?: string): Promise<boolean> {
    await this.ensureReady();
    // DELETE 带 workspace_key 条件，防止跨工作区删除别人的任务。
    const result = this.getDatabase()
      .prepare(
        `DELETE FROM automations
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({ id: automationId, workspace_key: workspaceKey ?? null });
    // changes 为 0 说明本来就不存在或不属于当前工作区。
    return result.changes > 0;
  }

  /** 暂停 / 恢复。paused ↔ active，保留 next_run_at / run_count。 */
// 暂停与恢复只动 enabled 与 lifecycle_status，保留 next_run_at 与 run_count：
// 暂停三天后恢复，不应因为错过若干次而立刻补跑，也不该清零累计展示。
// 恢复后何时触发由 scheduler 依据 next_run_at 判定，repo 不在这里改时间。
  async setEnabled(automationId: string, enabled: boolean, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET enabled = @enabled,
            lifecycle_status = @lifecycle_status,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        id: automationId,
        // enabled 与 lifecycle_status 必须成对写：只改一个会让 claimDue 与实际状态脱节。
        // 暂停三天后恢复不应立刻补跑，next_run_at 保持原值。
        enabled: enabled ? 1 : 0,
        // 只有 active 才允许被 claimDue 认领，paused 必须同步置 enabled=0。
        lifecycle_status: enabled ? "active" : "paused",
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /** 终态任务手动重跑：回 active、清计数与重试态，nextRunAt 由调用方重算传入。 */
// restart 必须把 run_count、retry_at、claimed_at 全部归零。
// 否则 restart 后 scheduledRunCount 仍不小于 maxRuns，下一轮派发会立刻又判 completed。
// nextRunAt 仍由调用方重算传入；清空 last_error 避免 UI 继续展示旧失败原因。
  async restart(
    automationId: string,
    options: { nextRunAt: number | null },
    workspaceKey?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET lifecycle_status = 'active',
            enabled = 1,
            run_count = 0,
            scheduled_run_count = 0,
            dispatch_attempts = 0,
            retry_at = NULL,
            dispatch_status = 'idle',
            running = 0,
            claimed_at = NULL,
            next_run_at = @next_run_at,
            last_error = NULL,
            updated_at = @now
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      .run({
        // WHERE 只认 automation_id，workspace_key 过滤另行拼在条件里。
        id: automationId,
        // restart 必须同时清零 scheduled_run_count，否则下一轮派发会立刻又判 completed。
        // dispatch_attempts 与 retry_at 一并归零，避免继承上一轮的退避状态。
        // last_error 清空，避免 UI 继续展示旧失败原因。
        next_run_at: options.nextRunAt,
        // restart 用当前时间刷新 updated_at，便于 UI 感知重跑操作。
        // nextRunAt 仍由调用方算好，仓库不感知 cron 语义。
        now: Date.now(),
        workspace_key: workspaceKey ?? null,
      });
  }

  /**
   * 立即运行：写入由当前 host 直接持有的 manual run，不修改 automation 的 cron 计划/生命周期。
   * 直派路径过去没有占用 automation running 锁，连续点击会并发投递到同一个 target task，
   * 进而让模型配置 revision 互相踩踏。这里复用 scheduler 的 single-flight 锁；host 派发结算后释放。
   * attempts=1 表示已经交给直接派发方；scheduler 只会在认领超时后做崩溃恢复。
   */
// 立即运行写入一条由当前 host 直接持有的 manual run，不改 cron 计划与生命周期。
// 过去直派路径没有占用 automation 的 single-flight 锁，连点会并发投递到同一个 target task，
// 导致模型配置 revision 互相踩踏；现在复用 scheduler 的 running 锁，host 结算后释放。
  async runNow(
    automationId: string,
    options: { now: number },
    workspaceKey?: string,
  ): Promise<ClaimedManualAutomationRun | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    // 立即运行也要先回收过期认领，否则崩溃进程的 running=1 会挡住这次操作。
    // 整段放在同一事务里，占锁与写 manual run 行不会出现中间态。
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: options.now - CLAIM_STALE_MS });

      const row = this.getRow(automationId, workspaceKey);
      // 行不存在时提交空事务并返回 null，调用方按任务已删除处理。
      // runNow 不抛错，因为 UI 可能刚删除就点了立即运行。
      if (!row) {
        db.exec("COMMIT");
        return null;
      }

      // 进入事务后先回收过期认领，避免崩溃进程留下的 running 挡住这次立即运行。
      // 回收阈值与 scheduler 共用 CLAIM_STALE_MS，两处不能各写一个常量。
      // 回收只清 running 与 claimed_at，不动 next_run_at，原 cron 节奏保持不变。
      const claimed = db
        .prepare(
          `UPDATE automations
          SET running = 1, claimed_at = @now, updated_at = @now
          WHERE automation_id = @id
            AND running = 0
            AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
        )
        .run({
          id: automationId,
          now: options.now,
          workspace_key: workspaceKey ?? null,
        });
// 认领失败视为别人已抢先，正常返回 null：不抛错，因为这是预期内的竞态结果。
// changes 不等于 1 说明候选在 SELECT 与 UPDATE 之间被抢走，绝不能把它当成派发成功。
      // 占锁失败说明定时触发或别的 host 已抢先，必须放弃并返回 null。
      // 这里绝不能继续写 run 行，否则会造出一条没人派发的 claimed run。
      if (claimed.changes !== 1) {
        db.exec("COMMIT");
        return null;
      }

// manual run 的 runId 每次都新生成（不同于 schedule 按时刻确定），因此天然幂等、不会误命中历史行。
      // manual 的 runId 每次新生成，不复用调度时刻，因此不会误命中历史行。
      // 前缀带上 automationId，日志里可以直接反查所属任务。
      // manual 的 runId 每次新生成，不复用调度时刻，因此不会误命中历史 run。
      // 前缀带 automationId，日志里可以直接反查所属任务。
      // 若改用 scheduledAt 做 id，连点两次会撞同一行并互相覆盖。
      const runId = `${automationId}:manual:${randomUUID()}`;
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (
          @run_id, @automation_id, @workspace_key, @scheduled_at, 'manual',
          @model_selection, 'claimed', 1, @now, @now
        )`,
      ).run({
        run_id: runId,
        automation_id: automationId,
        workspace_key: row.workspace_key,
        scheduled_at: options.now,
        // 认领尚未经过目标 Host 解析；原意图仍在 automation，run 等首次派发再固定。
        model_selection: null,
        now: options.now,
      });
      db.exec("COMMIT");
      return {
        // 用占锁前的 SELECT 快照加 running 与 claimed_at 覆盖，等价于提交后回读。
        // 返回的 `automation` 由 `row` 展开后覆盖 `running: 1` 与 `claimed_at`，等价于提交后回读。
        automation: rowToAutomation({
          ...row,
          running: 1,
          claimed_at: options.now,
          updated_at: options.now,
        }),
        // run 的 model_selection 先写 null，首次派发成功后才由 fixRunModelSelection 固定。
        // 手工构造与 INSERT 的列一一对应，新增列时这里必须同步补。
        run: rowToRun({
          run_id: runId,
          automation_id: automationId,
          workspace_key: row.workspace_key,
          scheduled_at: options.now,
          trigger: "manual",
          model_selection: null,
          dispatch_status: "claimed",
          outcome: null,
          session_id: null,
          error: null,
          // attempts 初始为 1 表示已交给直接派发方，scheduler 只会在认领超时后做崩溃恢复。
          attempts: 1,
          created_at: options.now,
          updated_at: options.now,
        }),
      };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- 调度状态机 ----

  /**
   * single-flight 认领到期项：原子 running=0→1。同时回收认领超时（claimed_at 过期）的僵尸项。
   * due 判定同时看 next_run_at 与 retry_at，任一到期即 due。
   */
// single-flight 认领到期项：整段在一个 BEGIN IMMEDIATE 事务里完成，保证选出候选与逐个认领之间
// 不会被其他进程插入；返回数组只包含真正认领成功的行，调用方可以放心直接派发。
// 这里不做 cron 计算：due 只比较已存的时间戳，调度语义完全由调用方的 next_run_at 承载。
  async claimDue(now: number): Promise<ZCodeAutomation[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    // 候选查询与逐条认领同事务，防止两进程在窗口内同时认领同一 automation。
    db.exec("BEGIN IMMEDIATE");
    try {
      // 截止日期是计划边界；过期任务先转终态，避免继续被正常 cron 或 retry 认领。
      db.prepare(
        `UPDATE automations
        SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
            retry_at = NULL, running = 0, claimed_at = NULL, updated_at = @now
        WHERE enabled = 1 AND end_at IS NOT NULL AND end_at < @now`,
      ).run({ now });
      // 先回收僵尸认领（持有者崩溃，running=1 但 claimed_at 过期）。
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });
      // 认领条件：enabled 且未在途。
      // - 有 retry_at（transient 退避中）：只按 retry_at 到期认领，忽略 next_run_at——
      //   否则 next_run_at 仍停在过去会让退避被绕过、每 tick 立即重试。next_run_at 保持不变，
      //   保证重试复用同一个 runId（scheduler 以 next_run_at 作 scheduledAt）。
      // - 无 retry_at：按 next_run_at 到期认领。
      // dueRows 在事务内一次查出，循环里只做条件更新。
      const dueRows = db
        .prepare(
          `SELECT * FROM automations
          WHERE enabled = 1 AND running = 0
            AND (
              (retry_at IS NOT NULL AND retry_at <= @now)
              OR (retry_at IS NULL AND next_run_at IS NOT NULL AND next_run_at <= @now)
            )`,
        )
        .all({ now }) as unknown as AutomationRow[];
      // 只收集 changes=1 的行，调用方可以直接对这些行派发。
      const claimed: ZCodeAutomation[] = [];
      // claim 语句复用同一 prepared statement，循环内只换绑定参数。
      const claim = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, dispatch_status = 'claimed', updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      // 逐行条件更新，单行失败不影响后面的候选。
      for (const row of dueRows) {
        const res = claim.run({ id: row.automation_id, now });
// 命中才构造返回值；构造用 SELECT 时的快照，这里手工覆盖 running 与 claimed_at 对齐刚写入的状态。
        // 只有条件更新命中才构造返回值：SELECT 快照可能已被别的进程改过。
        // 手工覆盖 running 与 claimed_at，保证返回值与刚写入的状态一致。
        if (res.changes === 1) {
          claimed.push(
            rowToAutomation({
              ...row,
              running: 1,
              claimed_at: now,
              dispatch_status: "claimed",
            }),
          );
        }
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 认领 UI「立即运行」产生的 manual run。
   * 立即运行不能改 next_run_at，否则会污染原 cron 节奏；manual run 使用 automation_runs
   * 作队列，短暂占用 automation running 锁来避免和定时触发并发投递同一个 task。
   */
// manual run 以 automation_runs 作队列：run 行先落库（claimed），调度侧再来认领，
// 这样点按钮与真正派发解耦，多个 scheduler 实例也只有一个能拿到。
// 认领同样占用 automation 的 running 锁，避免与定时触发并发投递同一个 target task。
  async claimManualRuns(now: number): Promise<ClaimedManualAutomationRun[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    // manual run 的认领整段包在 BEGIN IMMEDIATE 里，保证取候选与占锁之间没有插入窗口。
    // 用 IMMEDIATE 而不是 DEFERRED：写锁在事务开始就拿到，两个 scheduler 会直接串行。
    // 事务跨两条 UPDATE，中途任何异常都由外层 catch 统一 ROLLBACK。
    // 取候选与占锁必须在同一 IMMEDIATE 事务内，否则两个 scheduler 会抢同一行。
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL
        WHERE running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
      ).run({ stale: now - CLAIM_STALE_MS });

// 用扁平别名（a_ 与 r_ 前缀）而不是嵌套对象：node:sqlite 只返回平铺列，
// 别名让两表同名列不会互相覆盖，代价是构造时必须手工拆回两个 Row。
      // 两个表各取一份快照再拼装，node:sqlite 不返回嵌套对象，别名是唯一能区分同名列的办法。
      // 别名统一加 a_ 与 r_ 前缀，构造时必须手工拆回 automation 与 run 两个 Row。
      // 查询条件是 trigger=manual 且 dispatch_status=claimed，已结算的 run 不再进入候选。
      const rows = db
        .prepare(
          `SELECT
            a.automation_id AS a_automation_id,
            a.title AS a_title,
            a.cron_expr AS a_cron_expr,
            a.prompt AS a_prompt,
            a.model AS a_model,
            a.provider AS a_provider,
            a.model_selection AS a_model_selection,
            a.mode AS a_mode,
            a.thought_level AS a_thought_level,
            a.workspace_key AS a_workspace_key,
            a.workspace_path AS a_workspace_path,
            a.workspace_identity AS a_workspace_identity,
            a.project_id AS a_project_id,
            a.host_id AS a_host_id,
            a.additional_directories AS a_additional_directories,
            a.target_task_id AS a_target_task_id,
            a.location_kind AS a_location_kind,
            a.recurring AS a_recurring,
            a.max_runs AS a_max_runs,
            a.end_at AS a_end_at,
            a.schedule_rule AS a_schedule_rule,
            a.schedule_edited_by_user AS a_schedule_edited_by_user,
            a.run_count AS a_run_count,
            a.scheduled_run_count AS a_scheduled_run_count,
            a.enabled AS a_enabled,
            a.lifecycle_status AS a_lifecycle_status,
            a.next_run_at AS a_next_run_at,
            a.last_run_at AS a_last_run_at,
            a.running AS a_running,
            a.claimed_at AS a_claimed_at,
            a.dispatch_status AS a_dispatch_status,
            a.dispatch_attempts AS a_dispatch_attempts,
            a.retry_at AS a_retry_at,
            a.last_error AS a_last_error,
            a.bot_delivery_target AS a_bot_delivery_target,
            a.created_at AS a_created_at,
            a.updated_at AS a_updated_at,
            r.run_id AS r_run_id,
            r.automation_id AS r_automation_id,
            r.workspace_key AS r_workspace_key,
            r.scheduled_at AS r_scheduled_at,
            r.trigger AS r_trigger,
            r.model_selection AS r_model_selection,
            r.dispatch_status AS r_dispatch_status,
            r.outcome AS r_outcome,
            r.session_id AS r_session_id,
            r.error AS r_error,
            r.attempts AS r_attempts,
            r.created_at AS r_created_at,
            r.updated_at AS r_updated_at
          FROM automation_runs r
          JOIN automations a ON a.automation_id = r.automation_id
          WHERE r.trigger = 'manual'
            AND r.dispatch_status = 'claimed'
            AND a.running = 0
            AND (r.attempts = 0 OR r.updated_at <= @stale)
          ORDER BY r.created_at ASC`,
        )
        .all({ stale: now - CLAIM_STALE_MS }) as unknown as Array<Record<string, unknown>>;

      // 返回数组只收集真正抢到 automation 锁的行，没抢到的直接跳过且不报错。
      // 调用方据此只对返回项派发，避免把同一 target task 投递两次。
      // 只把真正抢到 automation 锁的 run 放进 claimed，没抢到的静默跳过。
      const claimed: ClaimedManualAutomationRun[] = [];
      // automation 的占锁语句复用同一个 prepared statement，循环里只换 id 绑定参数。
      // 条件 running = 0 是 single-flight 的核心，changes 为 1 才代表本轮拥有该任务。
      // claimAutomation 的条件 running = 0 是 single-flight 核心，changes=1 才算拿到。
      const claimAutomation = db.prepare(
        `UPDATE automations
        SET running = 1, claimed_at = @now, updated_at = @now
        WHERE automation_id = @id AND running = 0`,
      );
      // run 行的 attempts 自增与 automation 占锁分开执行，先占锁再记账。
      // 条件里重复写 trigger 与 dispatch_status，防止预处理之后行被别的进程改掉。
      // claimRun 在占锁成功后单独自增 attempts，失败路径不能白加一次。
      const claimRun = db.prepare(
        `UPDATE automation_runs
        SET attempts = attempts + 1, updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status = 'claimed'`,
      );

      // 逐行尝试占锁，单行失败只跳过自己，不影响后面排队的 manual run。
      // 顺序由 SQL 的 created_at ASC 决定，先点按钮的先派发。
      // 顺序不靠内存排序：SQL 的 `ORDER BY created_at ASC` 直接决定派发先后。
      for (const row of rows) {
        // 扁平别名在循环里先取出主键，后面的占锁与构造都依赖这两个变量。
        // 类型断言只是还原 SQL 列的类型，运行期不产生任何转换。
        // 扁平别名先取出主键，占锁与构造都依赖它，不能从 run 行反推。
        const automationId = row["a_automation_id"] as string;
        // run_id 与 automation_id 分别取自两张表，不能互相推导。
        // runId 取自 run 表，与 automationId 分属两张表，必须分别读取。
        const runId = row["r_run_id"] as string;
        // 用 UPDATE 的 changes 做比较并交换，读与写之间不再有单独窗口。
        // claimed_at 与 running 同时写，缺一个就会留下无法回收的僵尸锁。
        const res = claimAutomation.run({ id: automationId, now });
        // 占锁失败说明该 automation 已被定时触发或另一个 scheduler 拿走，本轮必须放弃这条 run。
        // 不抛错也不重试：run 仍是 claimed，下个 tick 会重新进入候选。
        // 占锁失败说明定时触发或别的 host 已拿走，本轮必须放弃这条 run。
        if (res.changes !== 1) continue;
        // 占锁成功后才给 run 记一次尝试，避免失败路径把 attempts 白加一。
        // 该 UPDATE 也带 trigger 与 dispatch_status 守卫，行若被改则静默不生效。
        claimRun.run({ run_id: runId, now });
        // 返回对象用内存构造而不是再查一次库，减少一次读且与刚写入的状态一致。
        // 内存构造返回对象而不是回读，减少一次查询且与刚写入的状态一致。
        // 新增 automation 列时这里的字段列表必须同步补，否则调用方读到 undefined。
        claimed.push({
          // manual run 的返回对象也走同一映射，避免展示字段与 list 分支不一致。
          automation: rowToAutomation({
            automation_id: automationId,
            title: row["a_title"] as string,
            // cron 原文原样搬回 automation 行，manual 派发不解析也不改写调度表达式。
            cron_expr: row["a_cron_expr"] as string,
            // prompt 是派发时的真实输入，纵使列是 NOT NULL 也按原值透传。
            prompt: row["a_prompt"] as string,
            model: (row["a_model"] as string | null) ?? null,
            provider: (row["a_provider"] as string | null) ?? null,
            model_selection: (row["a_model_selection"] as string | null) ?? null,
            mode: (row["a_mode"] as string | null) ?? null,
            thought_level: (row["a_thought_level"] as string | null) ?? null,
            workspace_key: row["a_workspace_key"] as string,
            workspace_path: row["a_workspace_path"] as string,
            workspace_identity: (row["a_workspace_identity"] as string | null) ?? null,
            project_id: row["a_project_id"] as string | null,
            host_id: row["a_host_id"] as string | null,
            additional_directories: row["a_additional_directories"] as string | null,
            target_task_id: (row["a_target_task_id"] as string | null) ?? null,
            location_kind: row["a_location_kind"] as string,
            recurring: row["a_recurring"] as number,
            max_runs: (row["a_max_runs"] as number | null) ?? null,
            end_at: (row["a_end_at"] as number | null) ?? null,
            schedule_rule: (row["a_schedule_rule"] as string | null) ?? null,
            schedule_edited_by_user: row["a_schedule_edited_by_user"] as number,
            run_count: row["a_run_count"] as number,
            scheduled_run_count: row["a_scheduled_run_count"] as number,
            enabled: row["a_enabled"] as number,
            lifecycle_status: row["a_lifecycle_status"] as string,
            // manual 运行不得改动 next_run_at，这里只做原值回填以保持对象完整。
            next_run_at: (row["a_next_run_at"] as number | null) ?? null,
            last_run_at: (row["a_last_run_at"] as number | null) ?? null,
            running: 1,
            claimed_at: now,
            dispatch_status: row["a_dispatch_status"] as string,
            dispatch_attempts: row["a_dispatch_attempts"] as number,
            retry_at: (row["a_retry_at"] as number | null) ?? null,
            last_error: (row["a_last_error"] as string | null) ?? null,
            bot_delivery_target: (row["a_bot_delivery_target"] as string | null) ?? null,
            created_at: row["a_created_at"] as number,
            updated_at: now,
          }),
          run: rowToRun({
            run_id: runId,
            automation_id: row["r_automation_id"] as string,
            workspace_key: row["r_workspace_key"] as string,
            scheduled_at: (row["r_scheduled_at"] as number | null) ?? null,
            trigger: row["r_trigger"] as string,
            model_selection: (row["r_model_selection"] as string | null) ?? null,
            dispatch_status: row["r_dispatch_status"] as string,
            outcome: (row["r_outcome"] as string | null) ?? null,
            session_id: (row["r_session_id"] as string | null) ?? null,
            error: (row["r_error"] as string | null) ?? null,
// 与 claimRun 的 attempts 自增保持一致：DB 已加一，内存对象也要加一，否则调用方看到的次数偏小。
            // SQL 刚把 attempts 加一，内存对象必须同步加一，否则调用方看到的次数偏小。
            attempts: (row["r_attempts"] as number) + 1,
            created_at: row["r_created_at"] as number,
            updated_at: now,
          }),
        });
      }
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 派发成功结算：展示总数与定时派发数各 +1、写 last_run_at、清重试态、复位 running；
   * 循环任务回 active（nextRunAt 由调用方按实际派发时间重算传入）；
   * 有限次任务达 max_runs 转 completed（enabled=0、next_run_at=NULL）。
   */
// 派发成功结算：展示总数与定时派发数各加一、写 last_run_at、清重试态、复位 running。
// 循环任务回 active 并使用调用方按实际派发时间重算的 nextRunAt；有限次任务达上限转 completed。
// 只有一条 UPDATE，单语句本身原子，因此不再包事务。
  async markDispatched(
    automationId: string,
    options: { dispatchedAt: number; nextRunAt: number | null },
  ): Promise<void> {
    await this.ensureReady();
    // 先读整行拿到 run_count 与 scheduled_run_count，再决定是否收尾。
    const row = this.getRow(automationId);
// markDispatched 发现行已删除时静默丢弃回写：派发是在途异步操作，删除先发生是正常时序。
// 若这里抛错，会让 host 的结算流程反复重试一条已不存在的记录。
    if (!row) return; // 已删除，丢弃回写，避免复活
    // runCount 含 manual，只用于 Card 累计展示。
    const runCount = row.run_count + 1;
    const scheduledRunCount = row.scheduled_run_count + 1;
    // 有限次任务（recurring=0）达上限即 completed。未显式设 max_runs 时按一次性任务处理（默认上限 1），
    // 否则一次性 cron 会一直停在 active 并被 cron 反复触发，永不结束。这里必须使用独立的
    // scheduled_run_count；run_count 还包含 manual run，只能用于 Card 累计展示。
// 一次性任务未显式设 max_runs 时按上限 1 处理：否则一次性 cron 会一直停在 active 被反复触发，永不结束。
// 判定必须用 scheduled_run_count：run_count 含 manual，用它会把手动运行也算进配额。
// recurring 用 === 0 严格判断，脏值不会让任务被误判为已达上限而突然停用。
    // recurring === 0 才参与 maxRuns 判定；脏值不会被误判为已达标。
    // max_runs 缺省按 1 处理，否则一次性 cron 会永远停在 active。
    const reachedMax = row.recurring === 0 && scheduledRunCount >= (row.max_runs ?? 1);
    // nextRunAt 越过 end_at 即收尾，和 claimDue 的过期扫描互为兜底。
    const reachedEnd = row.end_at !== null && (options.nextRunAt ?? Infinity) > row.end_at;
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET run_count = @run_count,
            scheduled_run_count = @scheduled_run_count,
            last_run_at = @dispatched_at,
            dispatch_status = 'dispatched',
            dispatch_attempts = 0,
            retry_at = NULL,
            last_error = NULL,
            running = 0,
            claimed_at = NULL,
            lifecycle_status = @lifecycle_status,
            enabled = @enabled,
            next_run_at = @next_run_at,
            updated_at = @now
        WHERE automation_id = @id`,
      )
      .run({
        id: automationId,
        // run_count 用内存里的 row.run_count 加一，避免 UPDATE 内再做一次读。
        run_count: runCount,
        // scheduled_run_count 与 run_count 分开写，maxRuns 只消费前者。
        scheduled_run_count: scheduledRunCount,
        // last_run_at 写实际派发时间而不是调度时刻，UI 的上次运行时间才不跳。
        dispatched_at: options.dispatchedAt,
        lifecycle_status: reachedMax || reachedEnd ? "completed" : "active",
        enabled: reachedMax || reachedEnd ? 0 : 1,
        next_run_at: reachedMax || reachedEnd ? null : options.nextRunAt,
        now: options.dispatchedAt,
      });
  }

  /**
   * 派发失败：transient 累加 attempts 并按退避写 retry_at；达上限后循环任务放弃本轮跳下一个
   * next_run_at（调用方传入），有限次任务转 failed。permanent 直接 failed 终态停用。
   */
// transient 走指数退避；达上限后循环任务放弃本轮，一次性任务转 failed。
// permanent（配置或权限类）直接 failed 终态停用，不再浪费重试窗口。
// 两类都复位 running，否则任务会永久卡在在途状态直到 CLAIM_STALE_MS 过期。
  async markDispatchFailed(
    automationId: string,
    options: {
      failedAt: number;
      error: string;
      kind: "transient" | "permanent";
      /** transient 达上限后，循环任务的下一个正常 next_run_at（调用方重算）。 */
      nextRunAt?: number | null;
    },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(automationId);
    if (!row) return;
    const db = this.getDatabase();
    const now = options.failedAt;
    // permanent 直接 failed 终态并停用，不写 retry_at，避免反复重试配置错误。
    if (options.kind === "permanent") {
      db.prepare(
        `UPDATE automations
        SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
            enabled = 0, running = 0, claimed_at = NULL,
            last_error = @error, updated_at = @now
        WHERE automation_id = @id`,
      ).run({ id: automationId, error: options.error, now });
      return;
    }
    // attempts 基于行里的 dispatch_attempts 加一，必须避免使用内存缓存，否则多进程会丢计数。
    const attempts = row.dispatch_attempts + 1;
    // 达上限必须区分循环与一次性：循环任务放弃本轮而不是永久停掉。
    if (attempts >= DISPATCH_MAX_ATTEMPTS) {
// 循环任务：放弃本轮并跳到下一个正常排期，保持 dispatch_status 为 idle；
// 若写成 failed 会永久停掉一个本来健康的周期任务。
      if (row.recurring === 1) {
        // 循环任务：放弃本轮，跳下一个正常 next_run_at，清重试态回 idle。
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              running = 0, claimed_at = NULL, next_run_at = @next_run_at,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({
          id: automationId,
          next_run_at: options.nextRunAt ?? null,
          error: options.error,
          now,
        });
      } else {
        db.prepare(
          `UPDATE automations
          SET dispatch_status = 'failed_to_dispatch', lifecycle_status = 'failed',
              enabled = 0, running = 0, claimed_at = NULL,
              last_error = @error, updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: automationId, error: options.error, now });
      }
      return;
    }
    // 未达上限：写退避 retry_at，复位 running 等下轮重认领。
    // 顺序约束：running 复位与 retry_at 必须在同一条 UPDATE 里落地，拆成两次时崩溃窗口会留下
    //「running=1 但 retry_at 已写」的组合，任务要等 CLAIM_STALE_MS 过期才可能被再次认领。
    db.prepare(
      `UPDATE automations
      SET dispatch_status = 'failed_to_dispatch', dispatch_attempts = @attempts,
          retry_at = @retry_at, running = 0, claimed_at = NULL,
          last_error = @error, updated_at = @now
      WHERE automation_id = @id`,
    ).run({
      id: automationId,
      attempts,
      // retry_at 由 computeRetryAt 按 30s 起步指数退避，claimDue 只认这一列。
      // 若继续看 next_run_at，已过去的时刻会让每个 tick 立即重试，退避被绕过。
      retry_at: computeRetryAt(now, attempts),
      error: options.error,
      now,
    });
  }

  /** 关机/退出时释放认领：清 running、保留 next_run_at，不记失败不推进。 */
  async releaseClaim(automationId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, dispatch_status = 'idle', updated_at = @now
        WHERE automation_id = @id AND running = 1`,
      )
      // releaseClaim 只清 running 与 claimed_at，不推进 next_run_at。
      // 关机释放不算失败，dispatch_status 回 idle 供下一轮重新认领。
      // 正常退出必须走这里而不是 markDispatchFailed：后者会累加 dispatch_attempts，
      // 几次重启就足以耗尽 DISPATCH_MAX_ATTEMPTS，把健康任务误判成 failed。
      .run({ id: automationId, now: Date.now() });
  }

  /** manual run 结束后只释放 single-flight 锁，不修改 automation 的调度状态。 */
// manual run 结束后只释放 single-flight 锁，不触碰调度状态：手动运行不应改变 cron 节奏或生命周期。
  async releaseManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET running = 0, claimed_at = NULL, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      // releaseManualClaim 带 workspace_key 条件，防止跨工作区释放别人的锁。
      // changes=0 表示锁已被 scheduler 回收或归属不符，调用方必须停止续租，不能把释放失败当成可重试错误。
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /** host 仍持有 queued/running manual run 时续租，避免长任务被 scheduler 当作僵尸认领回收。 */
// 续租：host 仍持有 queued 或 running 的 manual run 时定期刷新 claimed_at，
// 避免长任务被 scheduler 当成僵尸（超过 CLAIM_STALE_MS）而重复认领。
  async touchManualClaim(automationId: string, workspaceKey: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automations
        SET claimed_at = @now, updated_at = @now
        WHERE automation_id = @id
          AND workspace_key = @workspace_key
          AND running = 1`,
      )
      // touchManualClaim 必须在 CLAIM_STALE_MS 到期前调用；晚于这个窗口，scheduler 已把本轮当僵尸重新认领，
      // 续租只能改 claimed_at，无法撤回已经发生的重复派发。running=1 才续租，已释放的锁不会被重新写活。
      .run({ id: automationId, workspace_key: workspaceKey, now: Date.now() });
  }

  /**
   * 错过触发窗口：原子地记一条 skipped run + 把 next_run_at 前推到下一个未来触发点 + 复位认领。
   * 不计 run_count。用于 scheduler 启动/恢复后发现 next_run_at 已远早于 now 的补偿跳过。
   * finalize=true 用于纯一次性任务：目标时刻已错过即终态（completed + 停用 + 清空调度），
   * 不得再从兼容性 scheduleRule 推导出后续周期继续执行。
   */
// 错过触发窗口的补偿：原子地记一条 skipped run、前推 next_run_at、复位认领，且不增加 run_count。
// 典型场景是应用启动时发现 next_run_at 已远早于 now，若不跳过会立刻补跑一次历史时刻的任务。
// run 用 upsert：同一调度时刻可能已被认领过（已有行），这里只改状态而不新建。
  async skipAndReschedule(params: {
    automationId: string;
    runId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    reason: string;
    nextRunAt: number | null;
    finalize?: boolean;
  }): Promise<void> {
    await this.ensureReady();
    const db = this.getDatabase();
    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, 'schedule', 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      ).run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        // scheduledAt 保留应触发时刻，跳过与重试共用同一个时间线锚点。
        // 若这里写 Date.now()，同一调度时刻的重试会被拆成多条历史。
        // 该值与 runId 一起决定幂等命中，不能由仓库自行推导。
        scheduled_at: params.scheduledAt,
        // skip run 用 run_id upsert：同一调度时刻已有认领行时只改状态，不新建第二条。
        // attempts 保持 0，跳过不是一次失败尝试，不应消耗重试预算。
        reason: params.reason,
        now,
      });
      // finalize 用于纯一次性任务：目标时刻已错过就直接 completed。
      // 此时必须清 next_run_at 与 enabled，否则兼容性 scheduleRule 会推出下一周期继续跑。
      // dispatch_status 回 idle 并清掉 retry_at，避免 UI 显示成失败待重试。
      if (params.finalize) {
        db.prepare(
          `UPDATE automations
          SET lifecycle_status = 'completed', enabled = 0, next_run_at = NULL,
              running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        ).run({ id: params.automationId, now });
      } else {
        db.prepare(
          `UPDATE automations
          SET next_run_at = @next_run_at, running = 0, claimed_at = NULL,
              dispatch_status = 'idle', dispatch_attempts = 0, retry_at = NULL,
              updated_at = @now
          WHERE automation_id = @id`,
        // 非 finalize 分支只前推 next_run_at，保留 active 让任务继续参与调度。
        // nextRunAt 必须由调用方按 cron 重算，仓库不解析表达式。
        // 若传 null，任务会停在无下次触发时间但仍 active 的矛盾状态。
        ).run({ id: params.automationId, next_run_at: params.nextRunAt, now });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- 运行历史 automation_runs ----

  /** 确保 run 历史存在。用于 host outcome 回写兜底，不增加 attempts，避免和 scheduler retry 计数互相污染。 */
// host outcome 回写的兜底：run 行可能因进程在认领与落库之间崩溃而缺失，
// INSERT 冲突即忽略，保证幂等补行。
// 关键：不增加 attempts，避免和 scheduler 的 retry 计数互相污染（两边各加一会提前放弃）。
  async ensureRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO NOTHING`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        // ensureRunClaimed 用 ON CONFLICT DO NOTHING，host 迟到回报可安全补行。
        // attempts 写 0，补行不能与 scheduler 的重试计数互相污染。
        // run_id 由调度方生成，该函数只负责保证行存在，不改变任何计数。
        trigger: params.trigger,
        now,
      });
  }

  /** 认领时 upsert 一行 run（run_id 冲突即命中本轮 retry，不新建）。 */
// 认领时写 run 行：run_id 冲突说明是同一轮的 retry，复用原行而非新建，
// 否则历史里会出现多条看起来不同的运行，用户无法理解重试关系。
// 冲突时清空 outcome 与 error 并自增 attempts，语义是新的一轮尝试开始。
  async upsertRunClaimed(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    modelSelection?: ModelSelection;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          model_selection, dispatch_status, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, @model_selection, 'claimed', 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'claimed',
          model_selection = COALESCE(automation_runs.model_selection, excluded.model_selection),
          outcome = NULL,
          error = NULL,
          attempts = attempts + 1,
          updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        // upsertRunClaimed 命中同一 run_id 说明是本轮 retry，复用原行而不是新建。
        // 冲突分支清空 outcome 与 error，语义是新的一轮尝试开始。
        // attempts 在冲突分支自增，历史里因此不会出现多条相似运行。
        trigger: params.trigger,
        // run 的 Selection 只在首次派发时冻结，冲突时用 COALESCE 保留已有值。
        // 若每次 retry 都覆盖，同一 run 会中途换模型导致上下文不一致。
        model_selection: serializeAutomationModelSelection(params.modelSelection),
        now,
      });
  }

  /**
   * Select 首次形成 Submission 时原子固定 run Selection；之后调用只能读回原值。
   * 旧派发在每次 transient retry 都重新读取 Host preferred，导致同一 run 换模型。
   */
// Select 首次形成 Submission 时原子固定 run 的选择；之后调用只能读回原值。
// 旧实现在每次 transient retry 都重读 Host preferred，导致同一 run 中途换模型、上下文不一致。
// 返回固定后的值而非 void，让调用方直接使用权威结果，不必再查一次。
  async fixRunModelSelection(runId: string, selection: ModelSelection): Promise<ModelSelection> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.prepare(
      `UPDATE automation_runs
       SET model_selection = COALESCE(model_selection, @model_selection), updated_at = @now
       WHERE run_id = @run_id`,
    ).run({
      run_id: runId,
      model_selection: serializeAutomationModelSelection(selection),
      now: Date.now(),
    });
    // fixRunModelSelection 先 UPDATE 再回读，返回权威值而不是内存里的入参。
    // COALESCE 保证第二次调用只能读回首次固定的值。
    const row = db
      .prepare(`SELECT model_selection FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as Pick<AutomationRunRow, "model_selection"> | undefined;
    const fixed = row ? readSerializedModelSelection(row.model_selection) : undefined;
    // 读不到固定值说明 run 不存在或写入失败，必须抛错而不是回退默认模型。
    if (!fixed) throw new Error(`Automation run 不存在或无法固定模型选择: ${runId}`);
    return fixed;
  }

  /** 派发结果回写 run（dispatched 回填 session_id / failed_to_dispatch 记 error）。 */
// 只回写 run 台账，不碰 automation：automation 的推进由 markDispatched 与 markDispatchFailed 负责，
// 职责分离让派发结果与调度推进可以独立重放。
// 同一条语句同时覆盖 dispatched（回填 session_id）与 failed_to_dispatch（记 error）。
  async markRunDispatch(params: {
    runId: string;
    dispatchStatus: ZCodeAutomationRunDispatchStatus;
    sessionId?: string | null;
    error?: string | null;
  }): Promise<void> {
    await this.ensureReady();
    // 崩溃顺序：先落 run 台账再推进 automation 时，中间被杀只会延迟认领回收（等 CLAIM_STALE_MS），不会重复派发；
    // 反序会留下「automation 已释放、run 仍 claimed」的台账，迟到回报会把已结束的一轮又写一次。
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET dispatch_status = @dispatch_status,
            session_id = COALESCE(@session_id, session_id),
            error = @error,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: params.runId,
        // markRunDispatch 只回写 run 台账，automation 的推进由 markDispatched 负责。
        // 失败与成功共用一条 SQL，session_id 用 COALESCE 保留已回填值。
        dispatch_status: params.dispatchStatus,
        session_id: params.sessionId ?? null,
        // 成功结算时 error 写 null 清空上一轮失败原因。
        error: params.error ?? null,
        now: Date.now(),
      });
  }

  /**
   * manual run 首次派发成功结算：原子更新 run 台账与累计运行次数。
   * 手动运行过去只更新 automation_runs，Card 的 runCount 因而只统计定时触发；
   * 同一个 runId 还可能由 direct host、scheduler 崩溃恢复或迟到回报重复结算，所以必须以
   * dispatch_status 首次进入 dispatched 作为幂等边界。manual 不推进 cron/maxRuns/lifecycle，
   * 也不释放 single-flight claim，claim 仍由真实 turn 终态收口。
   */
// manual run 首次派发成功结算：原子更新 run 台账与累计运行次数。
// 过去只更新 automation_runs，导致 Card 的 runCount 只统计定时触发。
// 同一 runId 可能被 direct host、scheduler 崩溃恢复或迟到回报重复结算，
// 因此必须以 dispatch_status 首次进入 dispatched 作为幂等边界。
  async markManualRunDispatched(params: {
    runId: string;
    sessionId?: string | null;
    dispatchedAt: number;
  }): Promise<boolean> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      // 先按 run_id 且 trigger=manual 取行，定时 run 不会被这条路径结算。
      // 取不到说明调用方拿的是过期或被删的 runId。
      const run = db
        .prepare(
          `SELECT automation_id, workspace_key, dispatch_status
          FROM automation_runs
          WHERE run_id = @run_id AND trigger = 'manual'`,
        )
        .get({ run_id: params.runId }) as
        | Pick<AutomationRunRow, "automation_id" | "workspace_key" | "dispatch_status">
        | undefined;
// 已结算或不存在都返回 false：调用方据此判断本次是否真的记了一次，不再重复做 UI 提示。
      // 已 dispatched 直接返回 false，保证重复回报只记一次 run_count。
      if (!run || run.dispatch_status === "dispatched") {
        db.exec("COMMIT");
        return false;
      }

      db.prepare(
        `UPDATE automation_runs
        SET dispatch_status = 'dispatched',
            session_id = COALESCE(@session_id, session_id),
            error = NULL,
            updated_at = @now
        WHERE run_id = @run_id AND trigger = 'manual' AND dispatch_status <> 'dispatched'`,
      ).run({
        run_id: params.runId,
        // manual 回写 session_id 用 COALESCE，重复回报不会把已填值覆盖成 NULL。
        // trigger=manual 条件保证这条路径碰不到定时 run。
        session_id: params.sessionId ?? null,
        // updated_at 用调用方给的 dispatchedAt，而不是仓库自己取时间。
        now: params.dispatchedAt,
      });
      // 只有 automation 行仍在同一 workspace 时才加 run_count；changes=0 说明归属已变。
      // 崩溃窗口约束：run 行置 dispatched 与 run_count 自增必须在同一事务里。若拆成两次提交，
      // 中间崩溃会留下「计数已加、状态仍 claimed」，迟到的同 runId 回报会通过幂等检查再加一次。
      const automationUpdate = db
        .prepare(
          `UPDATE automations
          SET run_count = run_count + 1,
              last_run_at = @dispatched_at,
              updated_at = @now
          WHERE automation_id = @automation_id AND workspace_key = @workspace_key`,
        )
        .run({
          automation_id: run.automation_id,
          workspace_key: run.workspace_key,
          dispatched_at: params.dispatchedAt,
          now: params.dispatchedAt,
        });
      db.exec("COMMIT");
      return automationUpdate.changes > 0;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** session runtime 回写运行结果（running / succeeded / failed / stopped）。 */
// 回写运行结果（running/succeeded/failed/stopped）。同一个 run 可能被多次上报，
// 因此用 CASE 做状态机保护：一旦进入终态，迟到的 running 不能把它回滚。
// 这条 SQL 同时保护 outcome 与 error，两个字段必须一起演进，否则会出现成功但仍带错误的组合。
  async markRunOutcome(
    runId: string,
    outcome: ZCodeAutomationRunOutcome,
    error?: string,
  ): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `UPDATE automation_runs
        SET outcome = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN outcome
              ELSE @outcome
            END,
            error = CASE
              WHEN @outcome = 'running' AND outcome IS NOT NULL AND outcome <> 'running' THEN error
              ELSE COALESCE(@error, error)
            END,
            updated_at = @now
        WHERE run_id = @run_id`,
      )
      // markRunOutcome 用 CASE 做状态机保护：终态一旦写入，迟到的 running 不能回滚。
      // outcome 与 error 必须一起演进，否则会出现成功但仍带错误的组合。
      // running 回写只更新 updated_at，不覆盖已经固定的 session_id。
      .run({ run_id: runId, outcome, error: error ?? null, now: Date.now() });
  }

  /** 错过触发窗口：落一条 skipped run（session_id=null），不计 run_count。 */
  async recordSkippedRun(params: {
    runId: string;
    automationId: string;
    workspaceKey: string;
    scheduledAt: number | null;
    trigger: ZCodeAutomationTrigger;
    reason: string;
  }): Promise<void> {
    await this.ensureReady();
    const now = Date.now();
    this.getDatabase()
      .prepare(
        `INSERT INTO automation_runs (
          run_id, automation_id, workspace_key, scheduled_at, trigger,
          dispatch_status, error, attempts, created_at, updated_at
        ) VALUES (@run_id, @automation_id, @workspace_key, @scheduled_at, @trigger, 'skipped', @reason, 0, @now, @now)
        ON CONFLICT(run_id) DO UPDATE SET
          dispatch_status = 'skipped', error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run({
        run_id: params.runId,
        automation_id: params.automationId,
        workspace_key: params.workspaceKey,
        scheduled_at: params.scheduledAt,
        // recordSkippedRun 的 upsert 让同一调度时刻重复跳过保持幂等。
        // skip 行 attempts=0，不计入 run_count 也不消耗重试预算。
        trigger: params.trigger,
        // 跳过原因写入 error 列，UI 与日志可据此解释为何没有执行。
        // 冲突分支只覆盖 dispatch_status 与 error，不新建第二条历史。
        reason: params.reason,
        now,
      });
  }

// 按 created_at 倒序：run 时间线以创建时刻为准，重试只更新行而不产生新行，排序因此稳定。
// 同样支持 workspaceKey 过滤，防止通过伪造 automationId 读取别人工作区的运行历史。
  async listRuns(automationId: string, workspaceKey?: string): Promise<ZCodeAutomationRun[]> {
    await this.ensureReady();
    // listRuns 按 created_at 倒序，重试只更新原行，因此时间线稳定。
    // workspace_key 过滤防止伪造 automationId 读取别人的运行历史。
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM automation_runs
        WHERE automation_id = @id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)
        ORDER BY created_at DESC`,
      )
      .all({
        id: automationId,
        workspace_key: workspaceKey ?? null,
      }) as unknown as AutomationRunRow[];
    // run 映射保持只读：outcome 与 dispatch_status 不在展示层做推断。
    return rows.map(rowToRun);
  }

  async getRun(runId: string): Promise<ZCodeAutomationRun | null> {
    await this.ensureReady();
    const row = this.getDatabase()
      .prepare(`SELECT * FROM automation_runs WHERE run_id = @run_id`)
      .get({ run_id: runId }) as AutomationRunRow | undefined;
    // run 不存在时返回 null，调用方据此区分已删除与零值记录。
    // getRun 返回 null 而不是抛错，轮询方可能在删除后仍提交查询。
    return row ? rowToRun(row) : null;
  }

  async deleteRun(runId: string, workspaceKey?: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(
        `DELETE FROM automation_runs
        WHERE run_id = @run_id
          AND (@workspace_key IS NULL OR workspace_key = @workspace_key)`,
      )
      // deleteRun 同样带 workspace_key 条件，避免跨工作区删除审计记录。
      // 单条删除不级联，pruneRuns 负责按时间统一清理。
      .run({ run_id: runId, workspace_key: workspaceKey ?? null });
  }

  /** 保留策略：删除超过 maxAgeMs 的历史 run（防无限增长）。 */
// 保留策略按 created_at 而非 updated_at：重试会刷新 updated_at，用后者会让老 run 永不淘汰。
// 返回删除行数，便于调用方观测清理规模；changes 可能是 bigint，统一 Number 化后再返回。
  async pruneRuns(maxAgeMs: number): Promise<number> {
    await this.ensureReady();
    // pruneRuns 按 created_at 淘汰而不是 updated_at：重试会刷新后者。
    // 用 Date.now() - maxAgeMs 作为唯一阈值，调用方不需要自己算时间。
    const res = this.getDatabase()
      .prepare(`DELETE FROM automation_runs WHERE created_at < ?`)
      .run(Date.now() - maxAgeMs);
    return Number(res.changes ?? 0);
  }

// 单条 UPDATE 全列覆盖，是 update 的最终落盘路径；列集合必须与 AutomationRow 的编辑语义一致，
// 新增可编辑字段时这里和 rowToAutomation 都要补，否则会出现改了读不回来。
// 刻意不写 running、claimed_at、run_count 等运行时列：编辑定义不能意外释放或篡改正在进行的状态。
  private writeRow(row: AutomationRow): void {
    this.getDatabase()
      .prepare(
        `UPDATE automations SET
          title = @title, cron_expr = @cron_expr, prompt = @prompt, model = @model, provider = @provider,
          model_selection = @model_selection,
          mode = @mode, thought_level = @thought_level,
          recurring = @recurring, max_runs = @max_runs, end_at = @end_at,
          schedule_rule = @schedule_rule,
          schedule_edited_by_user = @schedule_edited_by_user,
          next_run_at = @next_run_at, lifecycle_status = @lifecycle_status,
          dispatch_attempts = @dispatch_attempts, retry_at = @retry_at, dispatch_status = @dispatch_status,
          enabled = @enabled, updated_at = @updated_at
        WHERE automation_id = @automation_id`,
      )
      .run({
        automation_id: row.automation_id,
        // writeRow 是 update 的唯一落盘路径，列集合必须与 AutomationRow 的编辑语义一致。
        // 新增可编辑字段时这里和 rowToAutomation 都要补，否则改了读不回来。
        // 模型三列原样写回：旧列只作回滚快照，不能让编辑顺手清空。
        // schedule_rule 与 schedule_edited_by_user 成对写回，避免编辑后默认模板又覆盖用户配置。
        // dispatch_attempts 与 retry_at 由调用方在 next 里算好，这里不再推导。
        // 故意不写 running 与 claimed_at：编辑定义不能释放进行中的认领。
        title: row.title,
        // cron_expr 原样写回，编辑标题不会顺手规范化调度表达式。
        // 若在这里 trim 或重排，用户看到的表达式会与保存值不一致。
        cron_expr: row.cron_expr,
        // prompt 是派发输入，写回时不能顺手 trim，空白差异会改变模型收到的内容。
        prompt: row.prompt,
        // 旧列 model 与 provider 只作回滚快照，编辑时原样写回而不参与新版读取。
        model: row.model,
        provider: row.provider,
        model_selection: row.model_selection,
        mode: row.mode,
        thought_level: row.thought_level,
        recurring: row.recurring,
        max_runs: row.max_runs,
        end_at: row.end_at,
        schedule_rule: row.schedule_rule,
        schedule_edited_by_user: row.schedule_edited_by_user,
        next_run_at: row.next_run_at,
        lifecycle_status: row.lifecycle_status,
        dispatch_attempts: row.dispatch_attempts,
        retry_at: row.retry_at,
        dispatch_status: row.dispatch_status,
        // enabled 已由 update 按 lifecycleStatus 推导，写回时不再二次判断。
        // 若这里再推导一次，completed 任务可能被写回 enabled=1 并被 claimDue 认领。
        // updated_at 用 next.updated_at 而不是 Date.now()，保证一次编辑只产生一个时间戳。
        // 缺少这一列会让编辑后的排序与并发判断失真。
        enabled: row.enabled,
        // updated_at 由调用方在 next 里统一赋值，写回时不再取一次时间。
        updated_at: row.updated_at,
      });
  }
}
