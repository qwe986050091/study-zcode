import { TaskGroupRepository } from "#src/task-groups/index.js";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/**
 * ============================================================================
 * services/session/taskIndexRepo.ts —— task 索引的 SQLite 仓库
 * ============================================================================
 *
 * 【定位】task 行集合与组织态（pin/archive/group/unread）的持久化仓库：
 *   独立于 conversation transcript，按 workspace_key + task_id 索引。
 *
 * 【只展示当前 provider】appendZCodeAgentIndexedProviderFilter 强制按
 *   provider 过滤：ZCode Agent 列表只展示当前 glm runtime 产生的 task；
 *   旧 Claude Code 导入不再例外，否则非 glm 历史会混入项目树。
 *
 * 【迁移】tasks 数据库有自己的 prepared/migrated 状态与 migrations；
 *   未就绪时不能执行查询，不能把空结果当成"没有任务"。
 *
 * 【状态边界】本仓库只负责 task 行与组织态；conversation 正文/运行态
 *   来自 CLI projection，不能在这里缓存第二份。
 * ============================================================================
 */
/* eslint-disable max-lines -- task 索引仓库集中维护 sqlite schema、查询和状态写入，迁移稳定后再按读写职责拆分。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  normalizeAgentProviderToZCodeAgent,
  zcodeTaskMetaSchema,
  resolveWorkspaceKey,
  type ZCodeProvider,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListItem,
} from "#src/session/zcodeTaskListTypes.js";

import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getTasksIndexDatabasePath, getZCodeDataRootDir } from "#src/paths.js";
import { projectStorage, type ProjectMigrationContext } from "#src/project-storage/index.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

// node:sqlite 是 Node 内置模块，无法用静态 ESM import 引入；
// 用 createRequire 包一层既能拿到同步 DatabaseSync，又不会让打包器把它当成外部可选依赖。
// 同步 API 是有意选择：tasks-index 的读写都很短，事务边界的确定性比让出事件循环更重要。
// 代价是长事务会阻塞事件循环，因此本文件所有事务都必须保持语句级、绝不在其中做网络 IO。
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

// CONTRACT: 列表/统计类查询必须经过这里追加 provider 过滤，不能各自拼 SQL。
// 集中一处是为了让“当前 runtime 视图”这条产品规则只有一份实现，
// 否则任一调用点漏加过滤，非 glm 历史就会重新出现在项目树里。
function appendZCodeAgentIndexedProviderFilter(
  where: string[],
  args: Array<string | number>,
  provider: ZCodeProvider,
): void {
  // Bugfix: ZCode Agent 列表入口只展示当前 glm runtime 产生的 task。
  // 旧 Claude Code 导入也不再例外，否则非 glm 历史数据仍会混入项目树与任务区。
  where.push("provider = ?");
  args.push(provider);
}
// 用 InstanceType 推导实例类型，避免手写 node:sqlite 的类形状：
// Node 小版本升级时类型签名可能微调，这里保持一致即可自动跟随。
// SQLInputValue 同理，用于迁移写入时对绑定参数做显式收窄。
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;
type SQLInputValue = import("node:sqlite").SQLInputValue;

// tasks 表的行投影，snake_case 与 SQLite 列名一一对应，是 TaskIndexRow 与 DB 的唯一契约；新增列必须两边同步。
// 列分两类：
//   - cli_*：CLI 事实（标题、时间、结局、删除），只由 applyCliFacts 写入；
//   - 产品壳列：pinned/archived/unread/handoff 等，由本仓库的组织态接口写入。
// meta_json 是完整 meta 的权威副本，标量列只是查询/排序用的索引投影；
// 读取时谁优先由 readPresentation 统一决定，调用方不得自行拼装。
interface TaskIndexRow {
  cli_title?: string | null;
  cli_title_source?: string | null;
  cli_created_at?: number | null;
  cli_updated_at?: number | null;
  cli_last_outcome?: "completed" | "interrupted" | "error" | null;
  // CLI 侧删除标记与产品壳 deleted 分开存：前者是外部事实，后者是本地意图；
  // 过滤时用 coalesce(cli_deleted,0)，避免任一来源的删除被另一边回滚覆盖。
  cli_deleted?: number | null;
  // handoff_pending 是位掩码（1=待推送删除, 2=待推送标题, 4=CLI 孤儿），读写必须统一用位运算。
  // 用位运算而不是多个布尔列，是为了让一次 UPDATE 能部分清除某位而不丢其他待办；
  // 位的含义只在 applyCliFacts / applyCliDeletion / markCliOrphan 中读写。
  handoff_pending?: number;

  workspace_key: string;
  workspace_path: string;
  // workspace_identity 只是身份投影，workspace_key 才是主键隔离依据。
  // 允许为 null 是为了兼容旧行：远端身份可能只体现在 workspace_key 里，
  // 读取时由 resolveTaskIndexRowWorkspaceIdentity 做一致性校验后再对外暴露。
  workspace_identity: string | null;
  task_id: string;
  title: string;
  task_status: string | null;
  provider: string | null;
  mode: string;
  model: string | null;
  migration_source: string | null;
  forked_from_task_id: string | null;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  created_at: number;
  updated_at: number;
  unread_at: number | null;
  last_unread_at: number;
  pinned: number;
  archived: number;
  deleted: number;
  title_overridden: number;
  searchable_text: string;
  meta_json: string;
}

// 迁移专用行：早期 z-code-2 把 wrapper id 写进 task_id，真实 session id 留在 acp_session_id。
// 该列只在迁移路径读取，主流程的 SELECT 列表刻意不含它，
// 避免“双 ID 兜底”扩散到 read/send/subscribe 等热路径。
interface LegacyAcpTaskIndexRow extends TaskIndexRow {
  acp_session_id: string | null;
}

// 落库时的完整写入意图：meta + 组织态快照。
// 单独建模而不是直接复用 ZCodeTaskMeta，是为了把“哪些组织态允许在 insert 时决定”显式化：
// deleted/archived/pinned 必须由调用方明确给出，不能从 meta 里猜。
interface TaskIndexWriteRecord {
  meta: ZCodeTaskMeta;
  pinned: boolean;
  archived: boolean;
  deleted: boolean;
  titleOverridden: boolean;
}

// 组织态增量补丁；undefined 表示“不改”，调用方不能用 false/null 表达同一语义，
// 因此 SQL 侧全部用 coalesce(?,列) 而不是先读后写。
interface TaskIndexStatePatch {
  pinned?: boolean;
  archived?: boolean;
  unreadAt?: number;
}

// 关键业务逻辑：聊天内容搜索只需要可匹配文本，不需要把完整超长会话无限塞进 sqlite 索引。
// 这里做上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
// TASK_SEARCH_SNIPPET_MAX_CHARS 等摘要窗口参数前后半径不对称，是因为匹配点通常出现在句首，
// 正文侧给更大空间，snippet 才能覆盖命中点周围的上下文。
// 这些值同时决定 sqlite 行体量与 IPC 负载，修改前必须按产品可见的性能预算评估，
// 调整前需确认 TaskSearchDialog 的展示宽度，不要单方面放大。
const TASK_SEARCH_SNIPPET_PREFIX_RADIUS = 20;
const TASK_SEARCH_SNIPPET_SUFFIX_RADIUS = 72;
const TASK_SEARCH_SNIPPET_MAX_CHARS = 140;
const TASK_SEARCH_SNIPPET_LIMIT = 4;
// scope 固定为 task-index-repo，方便按模块过滤迁移与写入失败日志；
// 本文件只记录 warn/info，高频 listTaskMetas 查询一律静默，否则会让日志随 UI 轮询膨胀。
const logger = createServiceLogger("task-index-repo");

// 身份 key 的唯一入口：identity 优先、路径兜底，与全局 Workspace Identity 规则一致。
// 直接拼接字符串会让不同远端的相同路径被当成同一 workspace，
// 因此本文件所有持久化与查询都必须经过这里（或 normalizeWorkspaceKeys）。
function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
  return resolveWorkspaceKey(params);
}

// 读取侧的身份自愈：列投影与主键不一致时以 workspace_key 为准。
// 原因：workspace_key 参与主键隔离，是“这行属于谁”的唯一事实；
// 残留的 identity 列若被采信，同一实体在 activity join 时会被投影到另一个远端。
// 无法判定时返回 undefined 而不是退回 workspacePath，把歧义显式交给上层。
function resolveTaskIndexRowWorkspaceIdentity(row: TaskIndexRow): string | undefined {
  const columnIdentity = row.workspace_identity?.trim();
  if (columnIdentity === row.workspace_key) {
    return columnIdentity;
  }
  // workspace_key 是 SQLite 查询与主键隔离的真实依据；只要它是统一格式的远端 identity，
  // 返回值就必须与它一致，不能让残留的 workspace_identity 列把实体投影到另一个远端。
  if (isRemoteWorkspaceIdentity(row.workspace_key)) {
    return row.workspace_key;
  }
  // identity 投影与主键不一致时不能采用，也不能把远端实体退回 workspacePath，
  // 否则相同路径的不同远端会在侧栏 activity join 时串行。
  return undefined;
}

// 行 -> 领域对象的总入口，展示字段有明确优先序：
// cli_* 列（CLI 事实）覆盖 meta_json 的旧值，title_overridden 决定用自定义还是 CLI 标题。
// interrupted 归一为 completed 是产品口径：中断的会话在列表上仍是“已结束”，
// 不新增枚举值，否则侧栏与统计等下游会到处判空。
function rowToMeta(row: TaskIndexRow): ZCodeTaskMeta {
  const meta = readPresentation(row);
  return {
    ...meta,
    // 自定义标题优先取 title，否则回落到 CLI 标题；两者都空时返回空串而不是 undefined。
    title: row.title_overridden === 1 ? row.title : (row.cli_title ?? ""),
    // 两个来源都要看：新协议写 title_overridden，旧行只有 cli_title_source；
    // 任一命中即视为用户自定义，避免升级后旧自定义标题被 CLI 标题覆盖。
    // 该字段决定列表标题取 title 还是 cli_title，与 readPresentation 的取值规则必须一致。
    titleOverridden: row.title_overridden === 1 || row.cli_title_source === "custom",
    // cli_created_at 为空时回落到 0，排序键必须是数字，null 参与排序的位置不可预期。
    createdAt: row.cli_created_at ?? 0,
    updatedAt: row.cli_updated_at ?? 0,
    // cli_last_outcome 是 CLI 事实，优先级高于 meta_json 里的旧 status 字段。
    status:
      row.cli_last_outcome === "interrupted" ? "completed" : (row.cli_last_outcome ?? undefined),
  };
}

// meta_json 是展示字段的权威副本，但解析必须“永不抛”：
// 迁移中断、手工改库、跨版本字段收紧都会导致非法 JSON。
// 此时 rowToMeta 降级为标量列投影，让列表仍然可用——丢展示细节优于整页报错。
// 注意 rowToMeta 只补齐身份与组织态，不覆盖调用方随后显式设置的字段。
function readPresentation(row: TaskIndexRow): ZCodeTaskMeta {
  // 先算身份再解析 meta_json，两个分支都要用它覆盖，防止旧 JSON 把实体投影到别的远端。
  const workspaceIdentity = resolveTaskIndexRowWorkspaceIdentity(row);
  try {
    // 用 safeParse 而不是 parse：schema 随协议演进只会收紧，
    // 旧行不能因为 schema 新增必填字段就整条读不出来。
    // 解析成功也要再覆盖一次主键投影，防止 meta_json 里的 taskId 与实际行不一致。
    // safeParse 与 JSON.parse 双层容错：手工改库或迁移中断留下的坏 JSON 不能让列表整页失败。
    const parsed = zcodeTaskMetaSchema.safeParse(JSON.parse(row.meta_json));
    // 成功分支仍需覆盖 taskId/workspaceIdentity 等主键投影，meta_json 内的值不可信。
    if (parsed.success) {
      return {
        ...(parsed.data as ZCodeTaskMeta),
        // SQLite 使用这些字段查询并隔离实体，旧 meta_json 里的 identity
        // 可能缺失或属于旧远端。读取时必须与行主键投影一致，sessions-index 才能
        // 按 workspaceKey + taskId 附加 running activity。
        // taskId 强制用行主键覆盖，meta_json 里的值可能属于迁移前的旧 id。
        taskId: row.task_id,
        // workspacePath 同样以列为准，JSON 里的旧路径可能已被移动或规范化。
        workspacePath: row.workspace_path,
        workspaceIdentity,
        // unread 是 tasks-index 产品壳状态；标量列必须覆盖可能来自其他 Host 的旧 meta_json。
        // unreadAt 为 undefined 时不下发该字段，前端据此隐藏未读点而不是收到 0。
        unreadAt: row.unread_at ?? undefined,
        // cron 身份以 meta_json 为准；cron_automation_id 列是索引投影，仅作兜底：
        // 历史行 meta_json 里可能还没有该字段，回退读列，下次写入会自动回填进 meta_json。
        cronAutomationId: parsed.data.cronAutomationId ?? row.cron_automation_id ?? undefined,
        // off-peak 身份同款策略：meta_json 为准、列兜底——存量迁移只写列即可生效。
        offPeakTaskId: parsed.data.offPeakTaskId ?? row.off_peak_task_id ?? undefined,
        titleOverridden: row.title_overridden === 1,
      };
    }
    // 解析失败降级为标量列投影并记 warn，丢展示细节优于整页报错。
    logger.warn(
      undefined,
      `读取 task index meta_json 非法 taskId=${row.task_id}`,
      parsed.error.flatten(),
    );
  } catch (error) {
    logger.warn(undefined, `读取 task index meta_json 失败 taskId=${row.task_id}`, error);
  }

  return {
    taskId: row.task_id,
    // traceId 由 taskId 派生，旧 meta_json 缺该字段时仍能得到可追踪标识。
    traceId: `zcode-${row.task_id}`,
    title: "",
    titleOverridden: row.title_overridden === 1,
    // 降级分支只填列投影，parsed.data 的字段一律不带入，坏 JSON 不会把空值写回展示。
    workspacePath: row.workspace_path,
    workspaceIdentity,
    createdAt: 0,
    updatedAt: 0,
    mode: row.mode as ZCodeTaskMeta["mode"],
    model: row.model ?? undefined,
    // 旧行 provider 列可能残留三方 CLI 值；meta 回退投影时统一归一为 glm。
    provider: row.provider
      ? normalizeAgentProviderToZCodeAgent(row.provider as ZCodeTaskMeta["provider"])
      : undefined,
    migrationSource: (row.migration_source as ZCodeTaskMeta["migrationSource"]) ?? undefined,
    forkedFromTaskId: row.forked_from_task_id ?? undefined,
    cronAutomationId: row.cron_automation_id ?? undefined,
    offPeakTaskId: row.off_peak_task_id ?? undefined,
    unreadAt: row.unread_at ?? undefined,
  };
}

// 序列化收敛到一处，保证写库格式（含 cron/off-peak 身份）只有一种；
// 若各调用点自行 JSON.stringify，很容易某处漏字段导致列与 meta_json 不一致。
/** 序列化 meta 到 meta_json。cron 身份随 meta 一起写入（单一来源），另在 writeRecord 投影到 cron_automation_id 索引列。 */
function serializeMetaJson(meta: ZCodeTaskMeta): string {
  return JSON.stringify(meta);
}

// limit 的边界收敛：非有限值或非正数一律视为“不限条数”，而不是静默改成 0 条。
// floor 是为了让 SQLite 收到整数（浮点会被驱动拒绝）。
// 返回 null 而非 undefined，便于调用方用 === null 判断是否拼 LIMIT 子句。
function normalizeLimit(limit: number | undefined): number | null {
  // non-finite、0 或负数统一映射为 null，调用方据此不拼 LIMIT 子句，而不是被静默截成 0 条。
  // Math.floor 保证绑定值仍是整数，sqlite 驱动收到小数会直接抛出类型错误。
  return typeof limit === "number" && Number.isFinite(limit) && limit > 0
    ? Math.floor(limit)
    : null;
}

// 多 workspace 查询前必须去重 + 排序：
//   - 去重避免 IN (...) 的重复占位符放大 SQL 参数个数；
//   - 排序让拼出的 SQL 稳定，利于语句缓存与日志比对。
// 空白 key 被过滤，防止一次身份解析失败把查询放宽成“匹配所有空 key 行”。
function normalizeWorkspaceKeys(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): string[] {
  // 返回前先排序，调用方直接展开成占位符，不会因顺序不同造成参数与 SQL 错位。
  return [
    // Set 去重后再 sort，使 IN (?) 的占位符数量与 key 顺序在重试时保持稳定。
    // 空白 key 必须过滤：空串参与 workspace_key 等值匹配会命中所有脏行，把查询放宽成全表。
    ...new Set(scopes.map((scope) => workspaceKey(scope)).filter((key) => key.trim().length > 0)),
  ].sort((left, right) => left.localeCompare(right));
}

// 摘要先压平空白再截断：换行/制表符在列表里会撑破布局，
// 且截断必须发生在归一化之后，否则会出现“看着很短却占多行”的摘要。
function normalizeSearchSnippetText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, TASK_SEARCH_SNIPPET_MAX_CHARS);
}

// 全局会话搜索 (TaskSearchDialog) 期望命中正文时返回若干片段做摘要展示。
// 以匹配点为中心截窗，去重相近窗口，最多 4 条；
// 全部未命中（title 命中）时回退一条整段摘要，避免下方空白。
// 搜索摘要按“命中点周围截窗”生成，而不是整段返回：
// 正文可能很长，全量回传会让列表 IPC 负载与前端渲染成本失控。
// 算法是线性的（逐次 indexOf 前进），长文本也不会退化；
// 最多 N 条且区间去重，保证结果稳定、可断言。
function buildSearchSnippets(searchableText: string, search: string | null): string[] {
  if (!search || !searchableText.trim()) {
    return [];
  }

  // 大小写折叠只做一次，且要与 SQL 侧 LOWER() 的口径保持一致；
  // 两边规则不同就会出现“列表命中但摘要为空”的错位。
  // 折叠规则必须与 SQL 侧 LOWER() 一致，否则会出现列表判定命中、摘要阶段却匹配不到的错位。
  const normalizedSearch = search.toLocaleLowerCase();
  const normalizedText = searchableText.toLocaleLowerCase();
  const snippets: string[] = [];
  const snippetRanges: Array<{ start: number; end: number }> = [];
  // searchStart 必须单调前进，否则每次命中都从头 indexOf 会让大文本退化成平方复杂度。
  let searchStart = 0;

  // 循环上限 4 条由 TASK_SEARCH_SNIPPET_LIMIT 固定，命中很多也不能放大 IPC 负载。
  while (snippets.length < TASK_SEARCH_SNIPPET_LIMIT && searchStart < normalizedText.length) {
    const matchIndex = normalizedText.indexOf(normalizedSearch, searchStart);
    if (matchIndex < 0) {
      break;
    }

    // 窗口左边界必须用 Math.max 夹到 0 以上，否则 slice 收到负数会按尾部计数摘出无关文本。
    const start = Math.max(0, matchIndex - TASK_SEARCH_SNIPPET_PREFIX_RADIUS);
    const end = Math.min(
      searchableText.length,
      matchIndex + normalizedSearch.length + TASK_SEARCH_SNIPPET_SUFFIX_RADIUS,
    );
    // 省略号只在真正截断时加，前端据此判断片段是否完整，否则摘要会比正文多出三个点。
    const prefix = start > 0 ? "..." : "";
    const suffix = end < searchableText.length ? "..." : "";
    // 片段先压平空白再截断，否则换行会把列表行高撑破。
    const snippet = normalizeSearchSnippetText(
      `${prefix}${searchableText.slice(start, end)}${suffix}`,
    );
    // 只判断 [start,end) 区间是否相交即可：相交会说明两段 snippet 展示的内容重复，必须合并。
    // 丢弃后继续向前找，避免同一关键词连续出现时返回多条近乎一样的片段。
    const overlapsExistingSnippet = snippetRanges.some(
      (range) => Math.min(range.end, end) - Math.max(range.start, start) > 0,
    );
    // 同一个关键词在很近的位置多次出现时，摘要窗口会高度重叠；服务端先合并近重复摘要。
    if (snippet && !overlapsExistingSnippet) {
      snippets.push(snippet);
      snippetRanges.push({ start, end });
    }
    // 指针至少前进一个搜索词长度，否则零宽命中会原地循环，函数永不返回。
    searchStart = matchIndex + normalizedSearch.length;
  }

  if (snippets.length === 0) {
    // title 命中但正文没命中时，仍给一条整段摘要兜底，避免标题下方空白。
    const fallbackSnippet = normalizeSearchSnippetText(searchableText);
    return fallbackSnippet ? [fallbackSnippet] : [];
  }

  return snippets;
}

// 列表项 = meta + 可选摘要。没有摘要时不挂空数组，
// 让前端用 searchSnippets 是否存在直接判断“是否正文命中”；
// searchSnippet 保留首条，是为了兼容只读单字段的旧调用方。
function rowToTaskListItem(row: TaskIndexRow, search: string | null): ZCodeTaskListItem {
  // 列表项必须以 rowToMeta 的展示优先序为底，不能在列表路径另拼一套字段。
  const meta = rowToMeta(row);
  // search 为 null 时 buildSearchSnippets 返回空数组，列表项不挂摘要字段。
  const snippets = buildSearchSnippets(row.searchable_text, search);
  if (snippets.length === 0) {
    return meta;
  }
  // 同时保留 searchSnippet 与 searchSnippets 以兼容只读首条的旧调用方，新代码只能两个字段都写。
  return { ...meta, searchSnippet: snippets[0], searchSnippets: snippets };
}

// 旧 meta_json 的自愈式重建：以解析结果为底，再用 fallback（标量列）覆盖关键字段。
// 只在迁移路径调用，因此可以容忍较弱校验：
//   - 非对象/解析失败按空对象处理；
//   - 缺失字段用列值补齐，最后统一交给 schema 校验。
// 任何情况下都不抛，否则单行脏 JSON 会阻断整库迁移。
function migrateLegacyTaskMetaJson(
  rawMetaJson: string,
  fallback: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    mode: string;
    provider?: string;
    model?: string;
    status?: ZCodeTaskMeta["status"];
  },
): ZCodeTaskMeta {
  // 解析失败一律退化为空对象，让下面的 fallback 标量列接管；抛错会中断整库迁移循环。
  let parsed: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(rawMetaJson) as unknown;
    // 只接受普通对象；数组和 null 都会让 Object.keys 展开出错误字段，必须排除。
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      parsed = raw as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }
  // 最终对象逐字段赋值，缺省值在此一并补齐，后面 schema.parse 才不会因缺字段抛错。
  const meta = {
    ...parsed,
    taskId: fallback.taskId,
    traceId:
      typeof parsed.traceId === "string" && parsed.traceId
        ? parsed.traceId
        : `zcode-${fallback.taskId}`,
    // 标题强制取列投影，旧 meta_json 里的标题可能已被 CLI 覆盖，不能反向污染。
    title: fallback.title,
    workspacePath: fallback.workspacePath,
    workspaceIdentity: fallback.workspaceIdentity,
    createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : fallback.createdAt,
    // updatedAt 同理以标量列为准，保证排序键与迁移后的列表次序一致。
    updatedAt: fallback.updatedAt,
    mode: typeof parsed.mode === "string" ? parsed.mode : fallback.mode,
    provider: typeof parsed.provider === "string" ? parsed.provider : fallback.provider,
    model: typeof parsed.model === "string" ? parsed.model : fallback.model,
    status: typeof parsed.status === "string" ? parsed.status : fallback.status,
    migrationSource: undefined,
  };
  // 最终仍走 schema.parse 兜底：缺必填字段会抛错，迁移期由调用方捕获并按行跳过。
  return zcodeTaskMetaSchema.parse(meta) as ZCodeTaskMeta;
}

// 仓库职责边界（写在此处以避免被序列化到实例上）：
//   - 拥有 tasks 表的 schema 就绪、读写与迁移；
//   - 不缓存 conversation 正文，运行态由 CLI projection 提供；
//   - 所有写操作经 enqueueWrite 串行，多语句写操作显式事务。
// 实例是 per-Host 的：多窗口共享同一 sqlite 文件，靠 WAL + busy_timeout 协调。
export class TaskIndexRepo {
  // 迁移备份被跳过时置真，供 main 进程决定是否提示用户；
  // 这是启动诊断信息、不属于任务事实，因此刻意不写入 meta 或数据库。
  // 每次 initialize 都会重新赋值，避免跨 Host 复用时残留上一次的结果。
  /** 启动迁移结果，供 main 提示；不参与任务事实或组织状态。 */
  migrationBackupSkipped = false;
  private db: DatabaseSyncInstance | null = null;
  private dbPath: string | null = null;
  private initializePromise: Promise<void> | null = null;
  // 每个 (workspace, task) 一条写链，而不是全局串行：
  //   - 全局锁会让不同任务的写入互相阻塞，批量更新时明显卡顿；
  //   - 按 key 串行保证同一任务上的“读-改-写”顺序与调用顺序一致。
  // 链在完成后立即清理，避免长时间运行后 Map 无界增长。
  private readonly writeChains = new Map<string, Promise<void>>();

  // 依赖全部可选，便于测试与不同 Host 装配：
  //   - migrationSettings/storageHostId 透传给 project-storage 迁移；
  //   - startupDbPath 允许 Host 指定专用库文件，缺省走标准路径；
  //   - startupBusyTimeoutMs 覆盖多窗口并发时的等待预算。
  // 构造期不做任何 IO，真正的初始化推迟到 ensureReady 首次调用。
  constructor(
    private readonly migrationSettings?: ProjectMigrationContext["settings"],
    private readonly storageHostId?: string,
    private readonly startupDbPath?: string,
    private readonly startupBusyTimeoutMs = 5000,
  ) {}

  // admitTaskGroup 把任务登记到组织库投影，供侧栏与分组查询复用。
  // 只在 local Host 且无远端身份时执行：
  //   - 远端成员由控制端服务验证投影后写入，本机重复登记会产生双份事实；
  //   - 带 workspaceIdentity 的行属于远端实体，同样不登记。
  /** Host 装配层共用迁移后的组织库；UI 只能通过 project/remote-projects 服务访问。 */
  private admitTaskGroup(meta: ZCodeTaskMeta, archived: boolean, deleted: boolean) {
    if (this.storageHostId && this.storageHostId !== "local") return;
    // 本机只登记本机事实；远程成员由控制端服务验证远端投影后写入。
    // 早退只跳过组织库投影，tasks 主表行仍由 writeRecord 写入，两者不能互相替代。
    if (meta.workspaceIdentity?.trim()) return;
    new TaskGroupRepository(this.getDatabase()).admit([
      { ...meta, hostId: "local", archived, deleted },
    ]);
  }

  // 仅供服务层拿 getOrganizationDatabase 的底层连接做组织态查询；UI 不得直接使用，
  // 因此这里只做就绪保证，不额外包装连接（事务责任留在调用方）。
  async getOrganizationDatabase() {
    await this.ensureReady();
    return this.getDatabase();
  }

  // 项目仓库与应用共享同一个 sqlite 连接，避免两个连接对同一文件交叉加锁；
  // 每次调用重新构造轻量包装，代价可忽略，也不会持有过期状态。
  async getProjectRepository() {
    await this.ensureReady();
    return projectStorage.repository(this.getDatabase(), this.storageHostId);
  }

  // 所有公开入口的第一步：确保库文件存在、schema 与迁移就绪。
  // 用共享的 initializePromise 做并发去重：
  //   - 多窗口/多请求同时进入时 initializePromise 只跑一次迁移；
  //   - 失败时清空 promise 并关闭连接，让下一次调用走完整的幂等初始化。
  // dbPath 变化（测试切库）时先关闭旧连接，防止句柄泄漏到新路径。
  async ensureReady(): Promise<void> {
    const path = this.startupDbPath ?? getTasksIndexDatabasePath();
    // 路径变更说明切换了库，必须先 close 旧连接，否则文件句柄泄漏到新库。
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    // 并发进入时只允许一个初始化在跑，多窗口同时启动不会重复执行迁移。
    if (!this.initializePromise) {
      // 失败时清空 promise 并关连接，下一个调用方才能重新走完整的幂等初始化，而不是复用坏状态。
      this.initializePromise = this.initialize(path).catch((error) => {
        // 释放失败连接；迁移后修复可能已部分提交，重试仍走原幂等初始化。
        this.close();
        throw error;
      });
    }
    // 等待的是同一个 promise，并发调用共享一次初始化与一次迁移。
    await this.initializePromise;
  }

  // 关闭是幂等的：db/promise/写链一起清空，避免后续调用复用已关闭的连接。
  // close 异常默认吞掉（多数是已关闭），只有显式 throwOnError 才抛给调用方；
  // 写链清空是有意的：进程退出时不再等待未完成写入，宁可让下次启动按 handoff 对账。
  close(options?: { throwOnError?: boolean }): void {
    // 先把异常存起来继续清理，close 抛错时也必须重置 db 与 initializePromise。
    let closeError: unknown;
    try {
      this.db?.close();
    } catch (error) {
      closeError = error;
      // ignore close errors
    }
    // 先把连接引用置空再做可选抛错，保证 close 失败时对象也不会留下已关闭句柄。
    this.db = null;
    this.dbPath = null;
    this.initializePromise = null;
    // 退出时不等未完成写链，丢弃它们并由下次启动的 handoff 对账补齐删除意图。
    this.writeChains.clear();
    if (options?.throwOnError && closeError) throw closeError;
  }

  // 初始化顺序不可调换：
  //   1. 建目录并打开连接（含 PRAGMA）；
  //   2. tasks 库自身迁移；
  //   3. project-storage 迁移（可能跨库校验）；
  //   4. 存量回填与 legacy id 迁移。
  // 前一步失败就不应继续，避免在半升级的 schema 上执行后续写操作。
  private async initialize(path: string): Promise<void> {
    // 先建父目录再打开数据库：node:sqlite 不会自动创建目录，
    // 缺目录时报错信息晦涩（SQLITE_CANTOPEN），难以定位。
    // recursive 让重复初始化保持幂等。
    await mkdir(dirname(path), { recursive: true });
    // 已有连接时跳过打开，重复初始化保持幂等，不会重复执行迁移。
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      // 多窗口 Host 共用 tasks-index；写事务和首次 schema 升级应短暂等待，而不是立即 SQLITE_BUSY。
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
      this.db.exec("PRAGMA foreign_keys = ON");
      // WAL + synchronous=NORMAL 是“多窗口、读多写少”场景的折中：
      // 读不会被写阻塞，崩溃时最多丢失最后一次 checkpoint 的尾部事务。
      // foreign_keys=ON 保证跨表引用（如 off_peak_tasks）不会留下悬空绑定。
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    // tasks 库与组织库的迁移分开执行且各自幂等，便于独立回滚；
    // 这里合并两个 backupSkipped 再上报，调用方只需看一个标志。
    // 迁移内部自行管理事务，外层不要再包 BEGIN，否则会与之冲突。
    const taskMigration = await runTasksDatabaseMigrations(this.db, path);
    const migration = await projectStorage.migrate(this.getDatabase(), {
      settings: this.migrationSettings,
      hostId: this.storageHostId,
      backupDirectories: [join(getZCodeDataRootDir(), "backup")],
      warn: (message, details) => createServiceLogger("project-migration").warn(message, details),
    });
    this.migrationBackupSkipped = taskMigration.backupSkipped || migration.backupSkipped;
    // 回填必须在迁移之后：off_peak_tasks 表由迁移创建，
    // 早于迁移执行会查不到表而静默跳过，导致历史会话永久缺投影。
    this.backfillOffPeakTaskMarkers();
    // Bugfix: z-code-2 早期列表 task_id 是 wrapper id，真实 ZCode session id 在旧列
    // acp_session_id。直接运行时映射会让 read/send/subscribe 到处变成双 ID 兜底；
    // 初始化时把索引行迁到真实 session id，后续统一走新协议正常路径。
    this.migrateLegacyAcpTaskIds();
  }

  // 用 PRAGMA table_info 做列存在性探测，而不是 try/catch 试探查询：
  // 前者不产生 sqlite 错误日志，也不污染连接状态。
  // table 只允许内部常量传入（当前仅 tasks），不要拼接外部输入。
  private hasColumn(table: string, column: string): boolean {
    const columns = this.getDatabase().prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    // 列名比较区分大小写，探测名必须与建表语句完全一致，否则会误判为缺列并跳过迁移。
    return columns.some((item) => item.name === column);
  }

  // 用一条 UPDATE...WHERE EXISTS 完成回填，而不是先查再逐行写：
  //   - 单语句天然原子，中途失败不会留下半回填状态；
  //   - 只改投影列、不动 meta_json，下次展示更新会自动把值写进 meta。
  // 条件带 workspace_key 是为了防止跨 workspace 的同名 session 误绑。
  /**
   * 存量回填（幂等，每次 bootstrap 自愈）：打点上线前产生的 off-peak 会话行没有
   * offPeakTaskId。off_peak_tasks 与 tasks 同库（tasks-index.sqlite），按 session 绑定
   * join 只补投影列——rowToMeta 以列兜底即可生效，下次展示更新会回填 meta_json。
   * 全新安装时 off_peak_tasks 可能尚未由 OffPeakTaskRepo 建表，需 guard。
   */
  private backfillOffPeakTaskMarkers(): void {
    const database = this.getDatabase();
    // hasOffPeakTable 为 false 时整段回填跳过，越权建表会让 off_peak_tasks 的 schema 漂移。
    const hasOffPeakTable = database
      // 用 sqlite_master 探测表存在性，全新安装时 off_peak_tasks 可能还没被创建。
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'off_peak_tasks'`)
      .get();
    // 全新安装时 OffPeakTaskRepo 可能还没建表，跳过即可；
    // 不能在这里建表：建表归属该 repo，越权会导致 schema 定义漂移。
    // 缺表说明 OffPeakTaskRepo 尚未建表，此处直接返回，越权建表会让 schema 定义漂移。
    if (!hasOffPeakTable) {
      return;
    }
    database
      .prepare(
        `UPDATE tasks SET off_peak_task_id = (
          SELECT o.off_peak_task_id FROM off_peak_tasks o
          WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
        )
        WHERE off_peak_task_id IS NULL
          AND EXISTS (
            SELECT 1 FROM off_peak_tasks o
            WHERE o.session_id = tasks.task_id AND o.workspace_key = tasks.workspace_key
          )`,
      )
      .run();
  }

  // 一次性数据修复：把 wrapper id 行迁到真实 ZCode session id。
  // 之所以放在 initialize 时机，是因为越晚迁移，越多上层接口得保留 task_id/acp_session_id 双 ID 兜底。
  // 迁移整体在一个 IMMEDIATE 事务内完成，失败回滚后下次启动重试（幂等）。
  // 迁移后顺带清空 acp_session_id，避免重复进入该分支。
  private migrateLegacyAcpTaskIds(): void {
    // 新库没有该历史列，直接跳过；不采用“缺列就 ALTER”的做法，
    // 因为该列已废弃，重建只会扩大 schema 与后续维护面。
    if (!this.hasColumn("tasks", "acp_session_id")) {
      return;
    }

    // 迁移全程复用同一连接，事务内不能在打开第二个 DatabaseSync 对同一文件加写锁。
    const db = this.getDatabase();
    // SELECT 明确列出 acp_session_id，主流程投影刻意不含它，双 ID 兜底不能扩散到 read/send 热路径。
    // WHERE 同时排除 acp_session_id 为空与等于 task_id 的行，空值或同值都说明无需迁移。
    const rows = db
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          acp_session_id,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE acp_session_id IS NOT NULL
          AND trim(acp_session_id) <> ''
          AND trim(acp_session_id) <> task_id`,
      )
      .all() as unknown as LegacyAcpTaskIndexRow[];
    // 零候选时提前返回，不必空跑 BEGIN IMMEDIATE 去抢写锁。
    if (rows.length === 0) {
      return;
    }

    // findTarget 的 prepare 必须在 BEGIN 之前完成，事务内只做 execute 才能缩短持锁窗口。
    // 命中目标行说明用户已先打开过真实 session，必须走合并分支而不是改主键。
    const findTarget = db.prepare(
      `SELECT
        workspace_key,
        workspace_path,
        workspace_identity,
        task_id,
        title,
        task_status,
        provider,
        mode,
        model,
        migration_source,
        forked_from_task_id,
        created_at,
        updated_at,
        unread_at,
        last_unread_at,
        pinned,
        archived,
        deleted,
        title_overridden,
        searchable_text,
        meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
      FROM tasks
      WHERE workspace_key = ? AND task_id = ?`,
    );
    // 三个预编译语句对应迁移的三种结果：
    //   - updateRow：目标行不存在，原地改主键；
    //   - updateTarget + deleteOld：目标行已存在，合并后删除旧行。
    // 三个 prepare 放在事务外，减少 BEGIN IMMEDIATE 持有时间。
    // updateRow 仅在目标行不存在时执行，改 task_id 并清空 acp_session_id，防止下次启动重复迁移。
    const updateRow = db.prepare(
      `UPDATE tasks
      SET task_id = @task_id,
        title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json,
        acp_session_id = NULL
      WHERE workspace_key = @workspace_key AND task_id = @old_task_id`,
    );
    // 合并写不更新 workspace_key：目标行已归属同一 workspace，
    // 只有由 source 行带来的展示与组织态需要覆盖。
    // 刻意不写 acp_session_id（保留目标行原值），旧行删除负责消除重复。
    // 合并写同时重写 meta_json，标量列与 JSON 不会出现版本错位。
    const updateTarget = db.prepare(
      `UPDATE tasks
      SET title = @title,
        task_status = @task_status,
        provider = @provider,
        mode = @mode,
        model = @model,
        migration_source = @migration_source,
        forked_from_task_id = @forked_from_task_id,
        created_at = @created_at,
        updated_at = @updated_at,
        unread_at = @unread_at,
        last_unread_at = @last_unread_at,
        pinned = @pinned,
        archived = @archived,
        deleted = @deleted,
        title_overridden = @title_overridden,
        searchable_text = @searchable_text,
        meta_json = @meta_json
      WHERE workspace_key = @workspace_key AND task_id = @task_id`,
    );
    // 删除旧行必须与合并写同事务紧跟执行，否则中途失败会留下两条同源任务，
    // 否则 listTaskMetas 会出现重复项且组织态分裂。
    const deleteOld = db.prepare(`DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?`);

    // BEGIN IMMEDIATE 立即拿写锁，避免两个进程同时通过前置校验后互相覆盖。
    db.exec("BEGIN IMMEDIATE");
    try {
      // migrated 计数只用于日志：数量为 0 时保持静默，否则每次冷启动都会产生噪声。
      let migrated = 0;
      for (const row of rows) {
        // 逐行 trim 后再判空，历史脏数据可能有空白 acp_session_id，跳过后不能拼出错误主键。
        const nextTaskId = row.acp_session_id?.trim();
        // trim 后为空说明 acp_session_id 只有空白，跳过而不是把空串写成 task_id。
        if (!nextTaskId) {
          continue;
        }
        // 目标行可能已存在（用户先打开过真实 session），此时走合并而非改主键；
        // 合并策略见 buildLegacyAcpMigratedRow，原则是“任一来源有值就不丢”。
        const target = findTarget.get(row.workspace_key, nextTaskId) as TaskIndexRow | undefined;
        const merged = this.buildLegacyAcpMigratedRow(row, target ?? null, nextTaskId);
        // 先合并再删除旧行，顺序反了会让合并读不到 source 的展示字段。
        if (target) {
          // 合并写按目标主键定位，source 行的删除由 deleteOld 单独负责，两者职责不重叠。
          updateTarget.run(merged);
          deleteOld.run(row.workspace_key, row.task_id);
        } else {
          // 无目标分支复用 updateRow，WHERE 用 old_task_id 定位，保证只改这一行的主键。
          updateRow.run({ ...merged, old_task_id: row.task_id });
        }
        // 只有真正执行过改主键或合并才计数，continue 跳过的行不能算迁移成功。
        migrated += 1;
      }
      db.exec("COMMIT");
      if (migrated > 0) {
        // 数量取自 migrated 而不是 rows.length，跳过空 acp_session_id 的行不计入。
        logger.info(undefined, `已迁移 legacy ACP task_id 到 ZCode session id 数量=${migrated}`);
      }
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // 合并规则集中在这里，便于审计“迁移会不会丢数据”：
  //   - 时间取极值（created 取小、updated 取大），先保留最早与最新事实；
  //   - 组织态取或（pinned/archived/title_overridden），任一来源为真即保留；
  //   - deleted 以 source 优先：旧行的删除意图不应被目标行覆盖；
  //   - 文本优先非空值，searchable_text 用逻辑或兜底。
  private buildLegacyAcpMigratedRow(
    source: LegacyAcpTaskIndexRow,
    target: TaskIndexRow | null,
    taskId: string,
  ): Record<string, SQLInputValue> {
    // 先把旧行 meta 归一（taskId 换成新 id），后续合并都以它为基准，
    // 避免直接展开未知形状的 JSON 造成字段污染。
    // 先把 source 的 taskId 换成新 id 再合并，旧 wrapper id 不能写回 meta_json。
    const sourceMeta = migrateLegacyTaskMetaJson(source.meta_json, {
      taskId,
      workspacePath: source.workspace_path,
      workspaceIdentity: source.workspace_identity ?? undefined,
      title: source.title,
      createdAt: source.created_at,
      updatedAt: source.updated_at,
      mode: source.mode,
      provider: source.provider ?? undefined,
      model: source.model ?? undefined,
      status: source.task_status ? (source.task_status as ZCodeTaskMeta["status"]) : undefined,
    });
    // 无目标分支必须只改写 task_id 与 acp_session_id，其余列原样搬运，代价最小且风险最低。
    // [边界] target 为空走复制分支：只换 task_id/acp_session_id，workspace_key 等列必须逐字保留。
    if (!target) {
      return {
        workspace_key: source.workspace_key,
        task_id: taskId,
        title: source.title,
        task_status: source.task_status,
        provider: source.provider,
        mode: source.mode,
        model: source.model,
        // 迁移后清空 migration_source，避免已迁移行被再次判定成待迁移。
        migration_source: null,
        forked_from_task_id: source.forked_from_task_id,
        created_at: source.created_at,
        updated_at: source.updated_at,
        unread_at: source.unread_at,
        // 取旧值与 unread_at 的较大者，watermark 必须单调不减，否则重启后旧时间戳会被复用。
        last_unread_at: Math.max(source.last_unread_at, source.unread_at ?? 0),
        pinned: source.pinned,
        archived: source.archived,
        deleted: source.deleted,
        title_overridden: source.title_overridden,
        searchable_text: source.searchable_text,
        meta_json: JSON.stringify(sourceMeta),
      };
    }

    // 有目标行时以 sourceMeta 为底（保证 id/标题等已归一），
    // 再用 target 行的时间与状态覆盖——target 通常是用户最近实际操作过的实体。
    const targetMeta = migrateLegacyTaskMetaJson(target.meta_json, {
      ...sourceMeta,
      taskId,
      // workspacePath 取目标行，source 的路径可能只是同一 workspace 的旧写法。
      workspacePath: target.workspace_path,
      // identity 必须用目标行投影，null 归一成 undefined 才能过 meta schema 校验。
      workspaceIdentity: target.workspace_identity ?? undefined,
      title: target.title || source.title,
      // createdAt 取较小值保留最早创建事实，取大值会让老任务在默认排序里被顶到前面。
      createdAt: Math.min(target.created_at, source.created_at),
      updatedAt: Math.max(target.updated_at, source.updated_at),
      mode: target.mode || source.mode,
      // provider 依次回落到 target 与 source，两者都空时保持 undefined 而不是猜默认值。
      provider: target.provider ?? source.provider ?? undefined,
      model: target.model ?? source.model ?? undefined,
      status: target.task_status
        ? (target.task_status as ZCodeTaskMeta["status"])
        : source.task_status
          ? (source.task_status as ZCodeTaskMeta["status"])
          : undefined,
    });
    // source 的自定义标题优先，target 标题只在 source 未覆盖时兜底，防止用户改名被合并覆盖。
    const title = source.title_overridden === 1 ? source.title : target.title || source.title;
    // updatedAt 取较大值，冷启动同步不能把最近一次活动时间往回调。
    const updatedAt = Math.max(target.updated_at, source.updated_at);
    // 两行 unread_at 都非空时取 max，只有一方有值时直接用它，其中 null 参与 Math.max 会被当成 0。
    const unreadAt =
      source.unread_at !== null && target.unread_at !== null
        ? Math.max(source.unread_at, target.unread_at)
        : (source.unread_at ?? target.unread_at);
    return {
      workspace_key: source.workspace_key,
      task_id: taskId,
      title,
      task_status: target.task_status ?? source.task_status,
      provider: target.provider ?? source.provider,
      mode: target.mode || source.mode,
      model: target.model ?? source.model,
      migration_source: null,
      forked_from_task_id: target.forked_from_task_id ?? source.forked_from_task_id,
      created_at: Math.min(target.created_at, source.created_at),
      updated_at: updatedAt,
      unread_at: unreadAt,
      // watermark 三元取最大，合并后仍大于任一方的历史 marker，旧端 CAS 清除才不会被误命中。
      last_unread_at: Math.max(source.last_unread_at, target.last_unread_at, unreadAt ?? 0),
      // 组织态按位取或，任一来源为 1 就保留，合并不能把用户 pin 过的任务还原成未 pin。
      pinned: source.pinned === 1 || target.pinned === 1 ? 1 : 0,
      // 归档取或，不能因为目标行未归档就把已归档任务放回默认列表。
      archived: source.archived === 1 || target.archived === 1 ? 1 : 0,
      // deleted 以 source 为准，旧行的删除意图不能被 target 的 0 覆盖，否则已删任务会复活。
      deleted: source.deleted === 1 ? 1 : target.deleted,
      // 自定义标记取或，任一行改过标题就保留，否则合并会把用户改名降级成 default。
      title_overridden: source.title_overridden === 1 || target.title_overridden === 1 ? 1 : 0,
      // 正文索引用逻辑或兜底，target 为空串时仍保留 source 全文，避免合并后搜索能力退化。
      searchable_text: target.searchable_text || source.searchable_text,
      // 返回前把 title/updatedAt/unreadAt 回写 meta_json，标量列与 JSON 在同一事务内保持一致。
      meta_json: JSON.stringify({
        ...targetMeta,
        title,
        updatedAt,
        unreadAt: unreadAt ?? undefined,
        migrationSource: undefined,
      }),
    };
  }

  // 未初始化即抛错，而不是惰性初始化：
  // 惰性化会让“忘记 await ensureReady”的调用点在任意时机触发迁移，
  // 显式失败能在测试与开发期立刻暴露生命周期错误。
  private getDatabase(): DatabaseSyncInstance {
    if (!this.db) {
      // 惰性初始化会让迁移在任意时机触发，事务边界与调用方预期不一致。
      throw new Error("task index sqlite 尚未初始化");
    }
    return this.db;
  }

  // 写链 key 使用一个不会出现在路径或 taskId 中的未打印字符分隔，
  // 避免 workspace 路径与 taskId 拼接后发生碰撞；只用于内存 Map，不落库。
  private writeKey(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): string {
    // 用 NUL 连接 workspaceKey 与 taskId，任一含分隔符也不会拼出相同字符串。
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  // 单任务写串行化：同一个 key 上的操作严格按入队顺序执行。
  // 关键点：
  //   - previous.catch(...) 让前一个失败不阻断后续（每个操作自己负责回滚）；
  //   - completion 吞掉结果与错误，只用于排序，不改变对调用方的返回；
  //   - 通过 identity 比较后删除，防止误删后来者建立的链。
  // 返回原始 promise，调用方仍能感知自己的成功或失败。
  private enqueueWrite<T>(
    params: { workspacePath: string; workspaceIdentity?: string; taskId: string },
    operation: () => Promise<T> | T,
  ): Promise<T> {
    // 入队 key 由 writeKey 归一，同一任务的不同写法才能落到同一条链。
    const key = this.writeKey(params);
    // 无前序时用已 resolve 的 promise 占位，
    // 让首次写入与后续写入都走 writeChains 同一条代码路径，减少分支。
    const previous = this.writeChains.get(key) ?? Promise.resolve();
    // 前序失败不能阻断后续操作，回滚由每个 operation 自己负责。
    const result = previous.catch(() => undefined).then(operation);
    const completion = result.then(
      () => undefined,
      () => undefined,
    );
    // 先登记再等链尾，后来者从 Map 取到的就是最新 completion。
    this.writeChains.set(key, completion);
    // finally 里必须再校验一次是同一个 completion 才删除：
    // 若期间已有新写入把 Map 覆盖成新链，直接 delete 会切断后来的串行化。
    void completion.finally(() => {
      // 回调在写入 settle 后异步执行，不阻塞 result 返回给调用方。
      if (this.writeChains.get(key) === completion) {
        this.writeChains.delete(key);
      }
    });
    // 返回本次 operation 的结果而不是链尾，调用方只关心自己的写入是否生效。
    return result;
  }

  // 单行读取的唯一入口：SELECT 列表必须与 TaskIndexRow 列级一致，
  // 否则 rowToMeta 会拿到 undefined，把列投影误判成“字段缺失”。
  // 返回 null 而不是 undefined，避免调用方在真值判断上出现风格分裂。
  private getTaskRow(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): TaskIndexRow | null {
    // 此处按 workspaceKey 归一后查询，跨 Host 的同名 taskId 不会互相覆盖。
    // 列名必须精确：workspace_identity 缺失会让身份自愈退化为 undefined，实体投影到错误远端。
    // cli_* 与 handoff_pending 一并取出，applyCliFacts 的标题合并与位掩码判断都依赖它们。
    // 查询必须固定按主键两列定位，不拼动态条件才能复用 SQLite 的预编译语句缓存。
    const row = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE workspace_key = ? AND task_id = ?`,
      )
      // 未命中时驱动返回 undefined，这里统一转成 null，调用方不必区分两种空值。
      .get(workspaceKey(params), params.taskId) as TaskIndexRow | undefined;
    return row ?? null;
  }

  // 幂等 upsert：既是“首次建行”，也是“整行覆盖”。
  // 关键约束：
  //   - 只有需要落 CLI 事实的路径可以调用（applyCliFacts / deleteArchivedTask）；
  //   - 正文索引 searchable_text 与未读 unread_at 不归它管理，
  //     ON CONFLICT 分支显式保留，防止被默认值清空；
  //   - 事务可嵌套：调用方已有事务时复用（isTransaction），不重复 BEGIN。
  private writeRecord(record: TaskIndexWriteRecord): ZCodeTaskMeta {
    const database = this.getDatabase();
    // 嵌套事务检测：node:sqlite 没有自动 savepoint 语义，
    // 因此由本方法判断是否需要自己开事务，避免 BEGIN 时报
    // “cannot start a transaction within a transaction”。
    // ownTransaction 为 false 时直接复用连接上的事务，失败由最外层统一回滚。
    const ownTransaction = !database.isTransaction;
    if (ownTransaction) database.exec("BEGIN IMMEDIATE");
    try {
      // 本方法只在预留行首次落 CLI 事实时调用，正文索引与未读 CAS marker 都不归它写：
      // 读一次现有行，ON CONFLICT 时原样保留 searchable_text / unread_at。
      // existing 只用于 searchableText 兜底，其余列一律取 record 的新值以免旧值回灌。
      const existing = this.getTaskRow({
        workspacePath: record.meta.workspacePath,
        workspaceIdentity: record.meta.workspaceIdentity,
        taskId: record.meta.taskId,
      });
      // 先读一次现有行只为拿正文索引：upsert 的 excluded 无法引用旧行，
      // 所以取出来再回填。缺失时用空串，保证新行列非空（满足 NOT NULL 约束）。
      // ON CONFLICT 的冲突键必须是主键两列，换成别的列会插入重复任务行。
      // upsert 分支的 unread_at 回落 tasks.unread_at，未读状态不能被默认值清空。
      // last_unread_at 取 MAX 保持 watermark 单调，否则旧端 CAS 令牌会被重复命中。
      const searchableText = existing?.searchable_text ?? "";
      this.getDatabase()
        .prepare(
          // INSERT 的列清单必须覆盖 TaskIndexRow 中所有可写列，漏列会让该字段永远停在默认值。
          // ON CONFLICT 分支逐列写 excluded，新增列时两处必须同步，否则更新路径会静默丢字段。
          `INSERT INTO tasks (
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          last_unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json
        ) VALUES (
          @workspace_key,
          @workspace_path,
          @workspace_identity,
          @task_id,
          @title,
          @task_status,
          @provider,
          @mode,
          @model,
          @migration_source,
          @forked_from_task_id,
          @cron_automation_id,
          @off_peak_task_id,
          @created_at,
          @updated_at,
          @unread_at,
          @last_unread_at,
          @pinned,
          @archived,
          @deleted,
          @title_overridden,
          @searchable_text,
          @meta_json
        )
        ON CONFLICT(workspace_key, task_id) DO UPDATE SET
          workspace_path = excluded.workspace_path,
          workspace_identity = excluded.workspace_identity,
          title = excluded.title,
          task_status = excluded.task_status,
          provider = excluded.provider,
          mode = excluded.mode,
          model = excluded.model,
          migration_source = excluded.migration_source,
          forked_from_task_id = excluded.forked_from_task_id,
          cron_automation_id = excluded.cron_automation_id,
          off_peak_task_id = excluded.off_peak_task_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          unread_at = tasks.unread_at,
          last_unread_at = MAX(tasks.last_unread_at, COALESCE(tasks.unread_at, 0)),
          pinned = excluded.pinned,
          archived = excluded.archived,
          deleted = excluded.deleted,
          title_overridden = excluded.title_overridden,
          searchable_text = excluded.searchable_text,
          meta_json = excluded.meta_json`,
        )
        .run({
          // 落库 key 统一经 workspaceKey 计算，直接拼路径会让不同远端的同名目录发生主键碰撞。
          workspace_key: workspaceKey(record.meta),
          workspace_path: record.meta.workspacePath,
          workspace_identity: record.meta.workspaceIdentity ?? null,
          task_id: record.meta.taskId,
          title: record.meta.title,
          // 可选字段统一用 ?? null 绑定，undefined 会被驱动拒绝并让整个事务回滚。
          task_status: record.meta.status ?? null,
          provider: record.meta.provider ?? null,
          mode: record.meta.mode,
          model: record.meta.model ?? null,
          // migration_source 是索引投影，随 meta 同步写，缺失时写 null 而不是留 undefined。
          migration_source: record.meta.migrationSource ?? null,
          // 派生来源列用于列表分组，null 表示非派生，不能用空串代替。
          forked_from_task_id: record.meta.forkedFromTaskId ?? null,
          // cron automation 身份从 meta 投影到索引列（meta_json 里也保留一份，见 serializeMetaJson）。
          cron_automation_id: record.meta.cronAutomationId ?? null,
          // off-peak 身份（D48）同款投影。
          off_peak_task_id: record.meta.offPeakTaskId ?? null,
          // created_at 只在首次建行时落定，后续 upsert 不改写它，否则按创建时间排序会乱。
          created_at: record.meta.createdAt,
          // updated_at 必须直接采用 meta 值而不取 now()，否则 CLI 事实时间会被本地时钟污染。
          updated_at: record.meta.updatedAt,
          unread_at: record.meta.unreadAt ?? null,
          last_unread_at: record.meta.unreadAt ?? 0,
          // 组织态初值由调用方显式给出，writeRecord 不从 meta 猜测 pinned/archived。
          pinned: record.pinned ? 1 : 0,
          archived: record.archived ? 1 : 0,
          // 删除位必须来自入参，误判会让任务直接从列表消失且只能靠 CLI 事实恢复。
          deleted: record.deleted ? 1 : 0,
          // 布尔一律折算成 0/1 存储，sqlite 没有原生布尔类型，直接绑 true 会得到非预期数值。
          title_overridden: record.titleOverridden ? 1 : 0,
          searchable_text: searchableText,
          // meta_json 必须走 serializeMetaJson 单一出口，各调用点自行 stringify 会漏掉 cron 身份等字段。
          meta_json: serializeMetaJson(record.meta),
        });
      // 项目身份投影与 task 行放在同一事务内写入：
      // 若分开提交，崩溃后可能出现“任务存在但项目树缺节点”，
      // 冷启动只能靠扫全表补救，成本远高于一次同步写。
      projectStorage.admitTaskIdentity(database, record.meta, this.storageHostId);
      if (record.titleOverridden)
        database
          .prepare(
            // 置位 2 表示有未推送的自定义标题，条件带 cli_title_source IS NULL 避免覆盖 CLI 已确认的标题。
            "UPDATE tasks SET handoff_pending=handoff_pending | 2 WHERE workspace_key=? AND task_id=? AND cli_title_source IS NULL",
          )
          .run(workspaceKey(record.meta), record.meta.taskId);

      // 写后重读，而不是直接返回内存对象：
      // sqlite 的默认值/表达式（如 last_unread_at 的 MAX 合并）可能改写实际值，
      // 以库为准才能保证返回的 meta 与下一次查询一致。
      const persisted = this.getTaskRow(record.meta);
      // 读回缺失说明本次写入未生效，必须抛错触发回滚，不能把半成品 meta 返回给调用方。
      if (!persisted) {
        throw new Error(`task index 写入后缺少 task: ${record.meta.taskId}`);
      }
      // 组织库登记与任务行同一事务，登记失败会连同任务写入一起回滚，不会留下双份事实。
      this.admitTaskGroup(rowToMeta(persisted), persisted.archived === 1, persisted.deleted === 1);
      // 只有 ownTransaction 为真才 COMMIT，嵌套调用时事务成败必须由外层决定。
      if (ownTransaction) database.exec("COMMIT");
      return rowToMeta(persisted);
    } catch (error) {
      // 回滚前确认 isTransaction，嵌套分支的失败必须继续抛给外层处理。
      if (ownTransaction && database.isTransaction) database.exec("ROLLBACK");
      throw error;
    }
  }

  // 对账要全量读取（含已删除与未迁移行），因此不能用 listTaskMetas：
  // 后者带 cli_created_at / deleted 过滤，会漏掉的正是需要修复的那些行。
  // 结果附带 handoffPending，让同步器知道哪些行还有未推送的意图。
  async listReconciliationRows(target: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<Array<{ meta: ZCodeTaskMeta; handoffPending: number }>> {
    await this.ensureReady();
    const rows = this.getDatabase()
      // 只按 workspace_key 收窄，不能加 provider 条件，否则非当前 provider 的孤儿行永远无法对账。
      .prepare("SELECT * FROM tasks WHERE workspace_key=?")
      .all(workspaceKey(target)) as unknown as TaskIndexRow[];
    // handoffPending 缺省按 0 返回，旧行没有该列时同步器不会把缺失误判成有待推送意图。
    return rows.map((row) => ({ meta: rowToMeta(row), handoffPending: row.handoff_pending ?? 0 }));
  }

  // subagent 派生行是旧版本误建的索引，CLI 确认 child 后删除；
  // 只删索引，不碰会话正文与 cli_deleted——正文归属 CLI，本仓库无权推断删除。
  // 走 enqueueWrite 是为了与同一 task 的其他写入保持顺序。
  /** CLI 确认 child 后移除旧版本误建的派生行，不修改会话正文或 CLI deleted。 */
  async removeSubagentIndexRow(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    // 删除走 enqueueWrite 的同一条链，避免与 applyCliFacts 的 UPDATE 交错。
    // 回调里只执行 DELETE 索引行，不修改 cli_deleted 与会话正文，正文归属 CLI。
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        // 按主键删除，行不存在时更新 0 行也静默成功，重复调用保持幂等。
        .prepare("DELETE FROM tasks WHERE workspace_key=? AND task_id=?")
        .run(workspaceKey(target), target.taskId);
    });
  }

  // 标记孤儿只用位或，不能直接删除：CLI 可能只是暂时不可见（首次加载/远端断连），
  // 由 syncer 结合后续事实决定是否清理，避免误删用户仍然存在的会话。
  async markCliOrphan(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    // 置孤儿位也要排队，迟到的事实写入不会覆盖刚标记的状态。
    return this.enqueueWrite(target, () => {
      this.getDatabase()
        .prepare(
          // 位 4 表示 CLI 暂时看不到该行，只标记不删除，避免首次加载或远端断连时误删会话。
          // 位或保留 2 号标题位与 1 号删除位，重复标记结果不变，置位操作必须幂等。
          // 真正的清理交给 syncer 结合后续事实决定，本仓库无权推断会话已消失。
          "UPDATE tasks SET handoff_pending=handoff_pending | 4 WHERE workspace_key=? AND task_id=?",
        )
        .run(workspaceKey(target), target.taskId);
    });
  }

  // CLI 明确删除是唯一可信的删除来源；列表里缺席不算删除。
  // 事务内必须同时做三件事：落 cli_deleted 事实、清 handoff 位 1（意图已消费）、
  // 把组织库标记为 deleted，保证投影与事实同步推进。
  // 失败回滚后 handoff 位仍在，下一轮同步会重试。
  /** 仅 syncer 消费 CLI 明确删除，不以列表缺席推断删除。 */
  async applyCliDeletion(target: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<void> {
    await this.ensureReady();
    return this.enqueueWrite(target, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          // 一条 UPDATE 同时落 cli_deleted、deleted 并清位 1，三件事必须原子，否则同步器会重复消费删除意图。
          // ~1 只清除待推送删除位，标题位 2 与孤儿位 4 必须保留，不能一并清空。
          // WHERE 必须按 workspace_key 与 task_id 定位，缺失目标时更新 0 行也不报错，调用方以重读结果判定。
          "UPDATE tasks SET cli_deleted=1,deleted=1,handoff_pending=handoff_pending & ~1 WHERE workspace_key=? AND task_id=?",
        ).run(workspaceKey(target), target.taskId);
        // 删除后重读拿最新组织态，组织库也要同步置 deleted，投影不能落后于事实。
        const row = this.getTaskRow(target);
        // row 可能已被并发清理，判空后再登记，避免对不存在的行写组织库。
        if (row) this.admitTaskGroup(rowToMeta(row), row.archived === 1, true);
        db.exec("COMMIT");
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // CLI 事实写入端口：title/time/status/deleted 只能从这里进入。
  // 与组织态写者分离的原因：
  //   - 组织操作（pin/archive/unread）不产生 CLI 事实，不应伪造时间戳；
  //   - applyCliFacts 作为单一写入者让“谁覆盖谁”可审计。
  // 整段在一个 IMMEDIATE 事务内执行，标题合并逻辑见下方 UPDATE 的 CASE 分支。
  /** 仅 syncer 调用：CLI 事实是唯一来源，组织态写者不得合成这些值。 */
  async applyCliFacts(params: {
    meta: ZCodeTaskMeta;
    titleSource?: string;
    lastOutcome?: "completed" | "interrupted" | "error";
    deleted?: boolean;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    // applyCliFacts 自身就是写入者，仍要入队，保证与组织态写入按调用顺序串行。
    // 事务内不做网络 IO，CLI 事实以外的数据只能通过参数传入。
    return this.enqueueWrite(params.meta, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        // 先探一次行是否存在：
        //   - 预留行（created_at=0 且无 cli 时间）首次拿到事实时需补齐整行；
        //   - 同时要保留用户在预留期间做的组织操作（pin/archive/自定义标题）。
        // 事实写入前必须先看现有行，缺失与预留行两种状态走完全不同的补齐路径。
        const existing = this.getTaskRow(params.meta);
        // 预留行尚无 CLI 事实。首条事实补齐 provider/展示基线，保留预留后发生的组织操作。
        // existing 为空表示从未建行，cli_created_at 为空且 created_at 为 0 表示只有预留占位。
        // 两条判定合并后调 writeRecord，否则首条 CLI 事实会丢掉 provider 与展示基线。
        // 预留期间用户可能已 pin 或改标题，writeRecord 入参必须带着 existing 的组织态快照。
        if (!existing || (existing.cli_created_at == null && existing.created_at === 0))
          this.writeRecord({
            meta: {
              ...params.meta,
              ...(existing?.title_overridden === 1 ? { title: existing.title } : {}),
            },
            pinned: existing?.pinned === 1,
            archived: existing?.archived === 1,
            deleted: existing?.deleted === 1,
            titleOverridden: existing?.title_overridden === 1,
          });
        // 标题来源分 default/custom：custom 一旦写入就不会被非 custom 覆盖，
        // default 作为兜底，让 CLI 标题可以随会话演进继续更新。
        // 未声明来源一律按 default 处理，自定义标题必须显式传 custom，否则会被 CLI 标题覆盖。
        const source = params.titleSource ?? "default";
        // 整个事实写入收敛成一条 UPDATE，语句级原子即可覆盖标题与 cli_ 前缀列及 handoff_pending 全部字段。
        // CASE 表达式按参数顺序绑定下方 17 个实参，增删任一分支都得同步改 run 列表。
        // 拆成多条语句会在中途失败时留下标题已更新而 handoff 位未清的混合状态。
        // cli_title 分支保护 custom 来源，CLI 的 default 标题不能覆盖用户改名后的值。
        // cli_created_at 直接覆盖而 cli_updated_at 取 max，重发旧快照不会让排序时间回退。
        // title 与 title_overridden 联动：位 2 置位期间本地标题与自定义标记都必须优先。
        // handoff_pending 用位 1 表删除与位 2 表标题及位 4 表孤儿，-1 掩码必须保留其余位。
        db.prepare(`UPDATE tasks SET
          cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          cli_title_source=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title_source ELSE ? END,
          cli_created_at=?,cli_updated_at=max(coalesce(cli_updated_at,0),?),
          cli_last_outcome=coalesce(?,cli_last_outcome),cli_deleted=max(coalesce(cli_deleted,0),?),
          title=CASE WHEN (handoff_pending & 2)<>0 THEN title WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END,
          title_overridden=CASE WHEN (handoff_pending & 2)<>0 THEN title_overridden WHEN ?='custom' OR cli_title_source='custom' THEN 1 ELSE 0 END,
          updated_at=?,created_at=?,task_status=coalesce(?,task_status),deleted=max(deleted,?),
          handoff_pending=(handoff_pending & ~4) & CASE WHEN ?=1 THEN ~1 ELSE -1 END & CASE WHEN ?=title AND ?='custom' THEN ~2 ELSE -1 END
          WHERE workspace_key=? AND task_id=?`).run(
          source,
          params.meta.title,
          source,
          source,
          params.meta.createdAt,
          params.meta.updatedAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          source,
          params.meta.title,
          source,
          params.meta.updatedAt,
          params.meta.createdAt,
          params.lastOutcome ?? null,
          params.deleted ? 1 : 0,
          params.deleted ? 1 : 0,
          params.meta.title,
          source,
          workspaceKey(params.meta),
          params.meta.taskId,
        );
        // 强解引用前 getTaskRow 刚在同一事务内写过这一行，读不到就必须抛错回滚，主键不一致不能静默。
        const persisted = this.getTaskRow(params.meta)!;
        this.admitTaskGroup(
          rowToMeta(persisted),
          persisted.archived === 1,
          persisted.deleted === 1,
        );
        db.exec("COMMIT");
        return rowToMeta(persisted);
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // 未读清除采用 CAS（unread_at = expected）：多端并发清除时只有一方成功，
  // 返回 cleared=false 让调用方区分“已清”与“marker 已被更新、不该清”。
  // 清除时把现值吸收进 last_unread_at，保证 watermark 单调递增，
  // 重启后即使时钟回拨也不会复用旧时间戳。
  async clearTaskUnreadIfMatches(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    expectedUnreadAt: number;
  }): Promise<{ meta: ZCodeTaskMeta; cleared: boolean }> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        // 旧库补列时 watermark 默认为 0；清除前必须吸收现存 marker，避免重启后时钟回拨复用旧值。
        const updated = db
          .prepare(
            // WHERE 带 unread_at=? 构成 CAS，多端同时清除时只有一方 changes 为 1，另一端只能拿到 cleared=false。
            // deleted=0 排除已删行，避免对已删除任务产生清除成功的结果，列表状态会自相矛盾。
            // 同一条语句先把现值吸收进 last_unread_at 再置 NULL，watermark 不会因清除而丢失。
            "UPDATE tasks SET last_unread_at=max(last_unread_at,unread_at),unread_at=NULL WHERE workspace_key=? AND task_id=? AND deleted=0 AND unread_at=?",
          )
          .run(workspaceKey(params), params.taskId, params.expectedUnreadAt);
        // 更新后重读而不是只信 changes，行可能在本事务开始前已被另一个写者删除。
        // 缺失或 deleted=1 时下面抛错回滚，调用方不能拿到 cleared=true 却对应不到任务。
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        db.exec("COMMIT");
        // changes 是 bigint，先 Number 再与 0 比较，直接比较在部分驱动版本上结果不可靠。
        return { meta: rowToMeta(row), cleared: Number(updated.changes) > 0 };
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // 删除“已归档任务”是两步意图：本地 tombstone + 待推送删除位。
  // 实现要点：
  //   - 归档/未删除校验与写入同事务，避免确认框停留期间状态被另一端改掉；
  //   - 重复删除直接返回 null（幂等），防止重试把 CLI seed 回来的行再删一次；
  //   - 返回最新 meta 供 UI 乐观更新，失败则整体回滚、不留半状态。
  async deleteArchivedTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    return this.enqueueWrite(params, () => {
      const database = this.getDatabase();
      // 写锁在删除前取得，归档状态判断与删除之间不会被其他写者插入。
      database.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 确认框可能停留期间被另一端恢复；归档检查必须与 tombstone 写入同事务，
        // 不能先读后删。已删除/不存在也跳过，避免重试从 CLI seed 后复活。
        // deleteArchivedTask 的三个前置条件缺一不可：
        //   - row 不存在说明已无可删对象；
        //   - 已删除说明是重试，直接成功返回；
        //   - 未归档说明调用方状态过期，不能凭旧 UI 状态删用户任务。
        if (!row || row.deleted === 1 || row.archived !== 1) {
          database.exec("COMMIT");
          return null;
        }
        // 复用 upsert 让 deleted/archived 与 meta_json 一次落库；
        // 随后再单独置 handoff 位，是为了让“已落库的删除意图”独立于推送状态存在。
        const meta = this.writeRecord({
          meta: rowToMeta(row),
          pinned: row.pinned === 1,
          archived: true,
          deleted: true,
          titleOverridden: row.title_overridden === 1,
        });
        // 删除事实交给 CLI；持久化意图使中途断线后仍可按既有 handoff 对账完成。
        database
          .prepare(
            "UPDATE tasks SET handoff_pending=handoff_pending | 1 WHERE workspace_key=? AND task_id=?",
          )
          .run(row.workspace_key, row.task_id);
        database.exec("COMMIT");
        // 返回写后 meta 供 UI 乐观更新，失败路径已在事务内整体回滚。
        return meta;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // 组织态写入（pin/archive/unread），不触碰任何 cli_* 或标题列。
  // 语义约定：
  //   - patch 字段缺失表示“不改”，用 coalesce 保持原值；
  //   - unreadAt 必须比历史 watermark 更新，否则会被抬高（见下方计算）；
  //   - 事务内先校验行存在，否则“更新 0 行”会被当成成功静默吞掉。
  async updateTaskState(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    patch: TaskIndexStatePatch;
  }): Promise<ZCodeTaskMeta> {
    await this.ensureReady();
    // 状态写同样入队，pinned 与 archived 的并发更新不会互相覆盖。
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        if (!row || row.deleted === 1)
          throw new Error(`task index 中不存在 task: ${params.taskId}`);
        // 用 in 而不是真值判断：unreadAt 允许显式传入以表示清除，
        // 这两种意图在 SQL 里走不同的 CASE 分支，必须在这里区分。
        const hasUnread = "unreadAt" in params.patch;
        // marker 的 watermark 在清除后仍保留；旧手机 CAS 不能清除同毫秒内的新未读。
        // CAS 令牌至少要比上一个 watermark 大 1，
        // 这样旧手机基于旧值发起的清除请求无法命中，天然避免“清除新未读”。
        const unread =
          typeof params.patch.unreadAt === "number"
            ? Math.max(params.patch.unreadAt, row.last_unread_at + 1, (row.unread_at ?? 0) + 1)
            : null;
        // coalesce 让 null 表示不改，false 仍会写入 0，两种意图不能混用同一个参数。
        db.prepare(`UPDATE tasks SET pinned=coalesce(?,pinned),archived=coalesce(?,archived),
          unread_at=CASE WHEN ? THEN ? ELSE unread_at END,
          last_unread_at=max(last_unread_at,coalesce(?,0)) WHERE workspace_key=? AND task_id=?`).run(
          params.patch.pinned === undefined ? null : Number(params.patch.pinned),
          params.patch.archived === undefined ? null : Number(params.patch.archived),
          Number(hasUnread),
          unread,
          hasUnread ? unread : null,
          workspaceKey(params),
          params.taskId,
        );
        // 更新前已校验 row 存在，此处强解引用；真读不到只可能是并发删除，交由事务回滚暴露。
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // 展示缓存端口：只接受 mode/model/thoughtLevel 等非事实字段，
  // 类型层面就排除 title/time/status/deleted，防止绕过 applyCliFacts 改写事实。
  // searchableText 允许在同一事务内更新，保证正文索引与展示字段版本一致；
  // 传 undefined 时保留旧值（coalesce），避免展示更新顺手清空搜索索引。
  /** 展示缓存不接受 title/time/status/deleted；CLI 事实由独立端口写入。 */
  async updateTaskPresentation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    presentation: Partial<
      Pick<
        ZCodeTaskMeta,
        | "mode"
        | "model"
        | "thoughtLevel"
        | "lastError"
        | "target"
        | "migrationSource"
        | "cronAutomationId"
        | "offPeakTaskId"
      >
    >;
    searchableText?: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    // updateTaskPresentation 与 applyCliFacts 共用一条链，后到的补丁必须看到先落库的事实。
    return this.enqueueWrite(params, () => {
      const db = this.getDatabase();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = this.getTaskRow(params);
        // 行不存在时返回 null 而不是抛错：展示更新可能先于事实写入到达，
        // 调用方（projection 同步）跳过即可，不应视为故障。
        // 返回 null 让 projection 同步区分「任务不存在」与「更新成功但值为空」。
        if (!row) {
          db.exec("COMMIT");
          return null;
        }
        // 以现有 meta 为底再叠加补丁，保证未提供的字段不被清空；
        // serializeMetaJson 前不重新读库，否则同一事务内会引入新的读放大。
        // 展开顺序固定为 meta 在前、presentation 在后，合并时同名字段必须以后者为准。
        // meta 先在内存合成再整体序列化，避免同一事务内为每个字段重复读库。
        const meta = { ...rowToMeta(row), ...params.presentation };
        this.getDatabase()
          .prepare(
            // searchableText 传 null 时 coalesce 保留旧索引，展示更新不会顺手清空搜索能力。
            `UPDATE tasks SET mode=?,model=?,migration_source=?,cron_automation_id=?,off_peak_task_id=?,meta_json=?,searchable_text=coalesce(?,searchable_text) WHERE workspace_key=? AND task_id=?`,
          )
          .run(
            meta.mode,
            meta.model ?? null,
            meta.migrationSource ?? null,
            meta.cronAutomationId ?? null,
            meta.offPeakTaskId ?? null,
            serializeMetaJson(meta),
            // undefined 必须先归一成 null 才能触发 coalesce，直接绑定会被驱动拒绝并回滚事务。
            params.searchableText ?? null,
            workspaceKey(params),
            params.taskId,
          );
        const result = rowToMeta(this.getTaskRow(params)!);
        this.admitTaskGroup(result, row.archived === 1, row.deleted === 1);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  // 面向内部服务的精简列表：不做搜索摘要、不分页，只返回 meta。
  // 过滤条件里的 cli_created_at IS NOT NULL 是关键——
  // 预留行（还没有 CLI 事实）不属于用户可见任务，混进来会出现空标题条目。
  async listTaskMetas(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    pinned?: boolean;
    archived?: boolean;
    includeDeleted?: boolean;
  }): Promise<ZCodeTaskMeta[]> {
    await this.ensureReady();
    // listTaskMetas 支持不传 workspacePath 查询全部任务，但 workspaceKey 只接受必填路径。
    // 先把可选入参收窄成明确的 workspace target，避免类型层把全量查询和 workspace 查询混在一起。
    // 全量查询（不传 workspacePath）与单 workspace 查询共用一条 SQL，
    // 用 NULL 参数关闭该条件；先收窄成 null/具体 key 两种状态，
    // 避免在 SQL 里出现空串匹配而意外退化成全表语义。
    // workspaceIdentity 与 workspacePath 一起传入 workspaceKey，远端身份优先规则在这里生效。
    // 空串 key 会与所有空白 workspace_key 相等，必须先判空再调 workspaceKey。
    const targetWorkspaceKey = params.workspacePath
      // 只有传了 workspacePath 才计算 key，全量查询保持 null，不能把空串当通配。
      ? workspaceKey({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        })
      : null;
    // cli_created_at IS NOT NULL 排除只有预留行的任务，空标题条目不能进入用户列表。
    // 删除过滤要把 deleted 与 cli_deleted 一起判断，任一为真都说明用户不该再看到。
    // include_deleted 打开时短路整条删除条件，仅供对账与 tombstone 读取复用。
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
          AND cli_created_at IS NOT NULL
          AND (@include_deleted = 1 OR (deleted = 0 AND coalesce(cli_deleted,0) = 0))
          -- Bugfix: ZCode Agent 列表只接受当前 glm provider；Claude Code 导入也属于非 glm 历史数据。
          AND (@provider IS NULL OR provider = @provider)
          AND (@pinned IS NULL OR pinned = @pinned)
          AND (@archived IS NULL OR archived = @archived)
        ORDER BY cli_updated_at DESC, cli_created_at DESC, task_id DESC`,
      )
      .all({
        workspace_key: targetWorkspaceKey,
        include_deleted: params.includeDeleted ? 1 : 0,
        // provider 为空时不加条件，内部同步需要读全量，列表入口则必须显式传入。
        provider: params.provider ?? null,
        pinned: typeof params.pinned === "boolean" ? (params.pinned ? 1 : 0) : null,
        archived: typeof params.archived === "boolean" ? (params.archived ? 1 : 0) : null,
      }) as unknown as TaskIndexRow[];
    // 精简列表只返回 meta，不构建搜索摘要，摘要成本留给 queryTaskList 的搜索路径。
    return rows.map(rowToMeta);
  }

  // 删除 tombstone 列表供上层与 CLI 结果做差集：
  // CLI 仍保留会话内容，若这里不返回，已删除任务会在冷启动后重新出现。
  // 只返回 id 数组以控制 IPC 体积；provider 过滤与列表口径保持一致。
  /**
   * 读取 workspace 下的删除 tombstone。
   *
   * CLI session store 会继续保留会话内容；如果列表 join 只读取 active/pinned/archived，
   * deleted task 会因“不在 archived 集合”被误判成普通 task，并在冷启动后重新出现。
   */
  async listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<string[]> {
    await this.ensureReady();
    // 先算出唯一身份 key 再复用（查询参数与后续比较），
    // 避免在参数处再次调用导致潜在的不一致。
    // 直接传 params.workspacePath 会绕过 identity 优先规则，多远端场景会读错 workspace。
    const workspaceKeyValue = workspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    // 只取本地 deleted=1 的 tombstone，cli_deleted 不参与，CLI 删除由事实列单独表达。
    // tombstone 必须回传给上层参与差集，否则 CLI 仍保留的会话会在冷启动后重新出现。
    // ORDER BY task_id 让差集结果稳定，便于缓存与测试断言。
    const rows = this.getDatabase()
      .prepare(
        `SELECT task_id
        FROM tasks
        WHERE workspace_key = @workspace_key
          AND deleted = 1
          AND (@provider IS NULL OR provider = @provider)
        ORDER BY task_id`,
      )
      .all({
        workspace_key: workspaceKeyValue,
        // tombstone 的 provider 过滤要与列表口径一致，否则同一任务在两个接口里一删一存。
        provider: params.provider ?? null,
      }) as Array<{ task_id: string }>;
    return rows.map((row) => row.task_id);
  }

  // 列表主查询：分页 + 分类（pinned/archived/default）+ 关键词搜索。
  // 实现策略：
  //   - where 片段与参数并行累积，保证顺序与占位符严格对应；
  //   - 先算总数再取当前页，hasMore 由 total>rows 得出（比多取一条更直观）；
  //   - 排序固定追加 task_id 作为最后 tie-breaker，避免同秒更新导致分页抖动。
  async queryTaskList(
    params: ZCodeTaskListQuery & { provider?: ZCodeProvider },
  ): Promise<ZCodeTaskListResult> {
    await this.ensureReady();
    // 空 scope 直接返回空结果：sqlite 的 IN () 是语法错误，
    // 提前短路也避免构造出 targetTaskId 为空的「无条件全表」查询。
    const workspaceKeys = normalizeWorkspaceKeys(params.workspaceScopes);
    // 返回空分页对象而不是抛错，首次加载的空项目不必走异常分支。
    if (workspaceKeys.length === 0) {
      // 空结果必须带 total=0 与 hasMore=false，前端分页不能停在加载态。
      return { items: [], total: 0, hasMore: false };
    }

    // 搜索词先 trim：全空格应视为“无搜索”而不是 LIKE 全通配（虽等价但会绕开摘要构建）。
    // LIKE 参数用小写并配合 LOWER(列)，与 buildSearchSnippets 的折叠口径一致。
    // 全空格搜索视为无搜索，否则 LIKE 的 %% 会命中全部行并触发无谓的摘要构建。
    const search = params.search?.trim();
    // LIKE 参数在这里一次性构造并复用两次（标题 + 正文），
    // 保证两条匹配分支使用完全相同的模式串，不会出现只改一边的偏差。
    // LIKE 模式串只构造一次并复用给标题与正文两个占位符，两边口径不能分叉。
    // 模式串必须 toLocaleLowerCase，SQL 侧配 LOWER(列) 才能做到大小写无关匹配。
    const normalizedSearchLike =
      search && search.length > 0 ? `%${search.toLocaleLowerCase()}%` : null;
    // 基础过滤三条共同表达“用户可见任务”：
    //   - 未删除（本地意图与 CLI 事实都要为否）；
    //   - 已有 CLI 事实（排除预留行）；
    //   - 落在给定 workspace 集合内。
    // 后续分类与搜索都以 AND 追加，任何分支都不允许清空这些前提。
    const where = [
      "deleted = 0",
      "coalesce(cli_deleted,0) = 0",
      "cli_created_at IS NOT NULL",
      `workspace_key IN (${workspaceKeys.map(() => "?").join(", ")})`,
    ];
    // args 从 workspaceKeys 拷贝，后续 push 不会改动调用方传入的数组。
    const args: Array<string | number> = [...workspaceKeys];
    // provider 过滤走公共函数而不是内联 push，确保所有列表入口的追加口径一致；
    // 未指定 provider 时不加条件，供同步/对账等内部调用读取全量。
    if (params.provider) {
      // appendZCodeAgentIndexedProviderFilter 同时改写 where 与 args，调用方不能只传 where。
      appendZCodeAgentIndexedProviderFilter(where, args, params.provider);
    }
    // 三类视图互斥：pinned 必须排除已归档，archived 只看归档，
    // default 同时排除两者，三者并集正好覆盖全部可见任务且不重复。
    if (params.kind === "pinned") {
      where.push("pinned = 1", "archived = 0");
    } else if (params.kind === "archived") {
      where.push("archived = 1");
    } else {
      where.push("pinned = 0", "archived = 0");
    }
    if (normalizedSearchLike) {
      // 之前只按 title 模糊匹配，没有命中聊天正文；TaskSearchDialog 长期搜不到内容。
      // 现在 title 或 searchable_text 任一命中即视为匹配，正文摘要在结果阶段构建。
      where.push(
        // 标题命中要按展示口径取列：title_overridden=1 时用 title，否则用 cli_title。
        "(LOWER(CASE WHEN title_overridden=1 THEN title ELSE cli_title END) LIKE ? OR LOWER(searchable_text) LIKE ?)",
      );
    }

    if (normalizedSearchLike) {
      args.push(normalizedSearchLike, normalizedSearchLike);
    }
    // COUNT 与分页查询共用同一 whereClause 与 args：
    // 两处各拼一次极易出现“总数与页内数据口径不一致”的分页 bug。
    // whereClause 定型后不能再 push，否则 args 与占位符错位会让查询直接抛错。
    const whereClause = where.join(" AND ");
    // COUNT 与分页查询分两次执行，是为了让 hasMore 语义明确；
    // 代价是多一次索引扫描，可接受（listTaskMetas 频率远低于写入）。
    // 若将来数据量显著增长，再考虑改成窗口函数一次取回。
    // 先算总数再取当前页，hasMore 由 total 与 rows 直接比较得出，不必多取一条再截断。
    const totalRow = this.getDatabase()
      .prepare(`SELECT COUNT(1) AS total FROM tasks WHERE ${whereClause}`)
      .get(...args) as { total: number } | undefined;
    // COUNT 结果缺失时按 0 处理，空表首查不会因 undefined 让 hasMore 变 NaN。
    const total = totalRow?.total ?? 0;

    // limit 为 null 表示不限量，此时不拼 LIMIT 子句；
    // 不传 -1：sqlite 虽支持但语义隐晦，且部分驱动会做参数校验。
    const limit = normalizeLimit(params.limit);
    const listArgs: Array<string | number> = [...args];
    if (limit !== null) {
      listArgs.push(limit);
    }
    // 两种排序共用同一组兜底键：先按用户选择的维度，再按另一时间与 id 稳定排序，
    // 保证翻页时不会因为时间相同而出现漂移或重复。
    // 两种排序都追加 task_id 兜底，翻页时同时间戳的行不会漂移或重复。
    const orderBy =
      params.sortBy === "created"
        ? "cli_created_at DESC, cli_updated_at DESC, task_id DESC"
        : "cli_updated_at DESC, cli_created_at DESC, task_id DESC";
    const rows = this.getDatabase()
      .prepare(
        `SELECT
          workspace_key,
          workspace_path,
          workspace_identity,
          task_id,
          title,
          task_status,
          provider,
          mode,
          model,
          migration_source,
          forked_from_task_id,
          cron_automation_id,
          off_peak_task_id,
          created_at,
          updated_at,
          unread_at,
          pinned,
          archived,
          deleted,
          title_overridden,
          searchable_text,
          meta_json, cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending
        FROM tasks
        WHERE ${whereClause}
        ORDER BY ${orderBy}${limit === null ? "" : " LIMIT ?"}`,
      )
      .all(...listArgs) as unknown as TaskIndexRow[];
    // workspacePurpose 属于请求上下文而非持久化事实，因此在返回阶段按 key 回填；
    // 不写进 tasks 表：同一 workspace 在不同窗口的用途语义可能不同。
    // Map 以 row.workspace_key 为键，同一 workspace 的多行只查一次用途映射。
    const workspacePurposeByKey = new Map(
      params.workspaceScopes.flatMap((scope) =>
        scope.workspacePurpose ? [[workspaceKey(scope), scope.workspacePurpose] as const] : [],
      ),
    );

    return {
      items: rows.map((row) => {
        // 摘要只在搜索请求下构建，search 为 null 时列表项不挂摘要字段。
        const item = rowToTaskListItem(row, search ?? null);
        // 按行主键查用途映射，映射缺失时保持原 item，不写入 undefined 字段。
        const workspacePurpose = workspacePurposeByKey.get(row.workspace_key);
        return workspacePurpose ? { ...item, workspacePurpose } : item;
      }),
      total,
      // 用 total 与实际返回行数比较，只有被 LIMIT 截掉的部分才算还有下一页。
      hasMore: total > rows.length,
    };
  }

  // getTaskRow 单任务读取：已删除视为不存在，与 listTaskMetas 口径一致，
  // 否则会出现“列表看不到但详情还能打开”的状态矛盾。
  // 调用方需自行处理 null（会话可能已被 CLI 删除，而 UI 仍持有旧引用）。
  async getTaskMeta(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): Promise<ZCodeTaskMeta | null> {
    await this.ensureReady();
    // 详情读取复用 getTaskRow，列表与详情的列投影不会各自漂移。
    const row = this.getTaskRow(params);
    // 这里刻意不检查 cli_deleted：CLI 删除事实由同步器处理，
    // 读路径提前过滤会让调用方无法在删除落库前完成最后一次渲染。
    // 本地 deleted=1 视为不存在，与列表口径一致，否则会出现列表看不到但详情还能打开。
    // 返回前统一走 rowToMeta，详情与列表不会出现字段口径差异。
    if (!row || row.deleted === 1) {
      return null;
    }
    return rowToMeta(row);
  }
}
