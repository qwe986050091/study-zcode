import { z } from "zod";
import {
  isTasksStorageMigrated,
  isTasksStoragePrepared,
} from "#src/session/tasksDatabase/prepared.js";
/* eslint-disable max-lines -- 与 automationRepo 同理：off-peak 仓库集中维护 off_peak_tasks 的
   sqlite schema、状态机守卫写入与调度认领，稳定后再按读写职责拆分。 */
/* off-peak 任务仓库：off_peak_tasks 的 sqlite schema、状态机守卫写入与调度认领。
   与 automation 共用 tasks-index.sqlite 与 Repo 模式，但表/状态机/常量全部独立，
   禁止往 automations 表或 ZCodeAutomation 类型上加字段。 */
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  OFF_PEAK_TERMINAL_STATUSES,
  modelSelectionSchema,
  resolveWorkspaceKey,
  type ZCodeOffPeakTask,
  type ZCodeOffPeakTaskCreateParams,
  type ZCodeOffPeakTaskStatus,
  type ZCodeTaskMode,
} from "@zcode/shared";
import { getTasksIndexDatabasePath } from "#src/paths.js";
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type DatabaseSyncInstance = InstanceType<typeof DatabaseSync>;

/** 认领超时回收：claim_running=1 超过该时长仍未结算，视为持有者已崩溃，允许重新认领。
    独立于 automation 的 CLAIM_STALE_MS（语义相同、常量独立一份，勿互相引用）。 */
// 认领超时阈值独立于 automation，语义相同但常量不共享。
export const OFF_PEAK_CLAIM_STALE_MS = 10 * 60_000;

/** 终态 SQL IN 片段；OFF_PEAK_TERMINAL_STATUSES 的单一来源投影。 */
// TERMINAL_SQL_LIST 由 OFF_PEAK_TERMINAL_STATUSES 投影，避免两处枚举漂移。
const TERMINAL_SQL_LIST = OFF_PEAK_TERMINAL_STATUSES.map((s) => `'${s}'`).join(", ");

// OffPeakTaskRow 与表结构一一对应，可空列必须显式标注 null。
interface OffPeakTaskRow {
// 主键由 service 层生成，取号前就需要 task_id。
  off_peak_task_id: string;
// 服务端票据可空：mock 阶段或核销后为空。
  server_ticket_id: string | null;
  title: string;
// conversation_id 非空表示任务已实际跑过。
  conversation_id: string | null;
  session_id: string | null;
  /** list() 联查 tasks-index 得到的绑定会话标题；单行读取不带该列。 */
// session_title 仅联查结果带该列，故声明为可选。
  session_title?: string | null;
  prompt: string;
  permission_mode: string;
  model: string | null;
  thought_level: string | null;
  model_selection: string | null;
// 身份 key 用于隔离同路径下的不同身份。
  workspace_key: string;
// workspace_path 用于执行与展示，不参与身份判定。
  workspace_path: string;
  workspace_identity: string | null;
  project_id?: string | null;
  host_id?: string | null;
  additional_directories?: string | null;
  status: string;
  queued_at: number;
  started_at: number | null;
  ended_at: number | null;
  failure_reason: string | null;
  files_changed: number | null;
  settled_at: number | null;
// history_deleted_at 只影响列表展示，不参与状态机。
  history_deleted_at: number | null;
  registered_at: number | null;
  schedulable: number;
// queue_position 是服务端队列快照，本地排序必须用 queued_at。
  queue_position: number | null;
  next_poll_at: number | null;
// 0/1 认领位，配合 claimed_at 做崩溃回收。
  claim_running: number;
  claimed_at: number | null;
// attempt_count 用于退避与诊断，不参与终态判定。
  attempt_count: number;
  last_error: string | null;
// created_at 参与列表排序，编辑不得改写它。
  created_at: number;
// updated_at 便于排查时序问题，不参与业务判定。
  updated_at: number;
}

// 行到领域对象的唯一转换点：列 snake_case，字段 camelCase。
// 可空列统一转 undefined，调用方无需区分 null 与缺省。
function rowToTask(row: OffPeakTaskRow): ZCodeOffPeakTask {
  // 模型选择只解析一次并复用，可选字段注入与 repair 标记都依赖同一个结果。
  const modelSelection = readOffPeakModelSelection(row);
  return {
    offPeakTaskId: row.off_peak_task_id,
// 服务端字段在 mock 先行阶段可能为空。
    serverTicketId: row.server_ticket_id ?? undefined,
    title: row.title,
    conversationId: row.conversation_id ?? undefined,
    sessionId: row.session_id ?? undefined,
// 只有 list() 联查才带标题，单行读取不伪造该字段。
    // 只有 list 的联查会带 session_title，单行读取不伪造空标题。
    // 展开写法保证无标题时该键完全缺席，前端据 undefined 决定是否渲染卡片副标题。
    ...(row.session_title ? { sessionTitle: row.session_title } : {}),
    prompt: row.prompt,
    permissionMode: row.permission_mode as ZCodeTaskMode,
    ...(modelSelection ? { modelSelection } : {}),
// 历史行缺少有效 Selection 时显式标记待修复，而不是静默丢弃。
    ...(!modelSelection
      ? {
          modelSelectionIssue: {
            code: "repair-required" as const,
          },
        }
      : {}),
    workspaceKey: row.workspace_key,
    workspacePath: row.workspace_path,
    workspaceIdentity: row.workspace_identity ?? undefined,
    ...(row.project_id == null ? {} : { projectId: row.project_id }),
    ...(row.host_id == null ? {} : { hostId: row.host_id }),
// 附加目录以 JSON 存储，读出时按同一约束重新校验。
    // 附加目录以 JSON 文本存储，读出时用与写入相同的 256 条上限重新校验。
    ...(row.additional_directories == null
      ? {}
      : {
          additionalDirectories: z
            .array(z.string().min(1))
            .max(256)
            .parse(JSON.parse(row.additional_directories)),
        }),
// status 由 SQL 守卫写入，读出时只做类型收窄。
    // status 由 SQL 守卫写入，映射层只做类型收窄，不在这里推断或修正状态。
    status: row.status as ZCodeOffPeakTaskStatus,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    endedAt: row.ended_at ?? undefined,
    failureReason: row.failure_reason ?? undefined,
    filesChanged: row.files_changed ?? undefined,
    settledAt: row.settled_at ?? undefined,
    historyDeletedAt: row.history_deleted_at ?? undefined,
    registeredAt: row.registered_at ?? undefined,
// schedulable 等 0/1 列必须在领域模型里还原成布尔。
    // schedulable 列还原成布尔时必须只认精确的 1，其它脏值一律按不可调度处理。
    schedulable: row.schedulable === 1,
    queuePosition: row.queue_position ?? undefined,
    nextPollAt: row.next_poll_at ?? undefined,
    // created_at 参与列表倒序排序，不能改由 updated_at 推导，否则编辑会让顺序抖动。
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 新列优先；旧列只在测试或回滚期存在。
function readOffPeakModelSelection(row: OffPeakTaskRow): ZCodeOffPeakTask["modelSelection"] | null {
  if (row.model_selection) {
    try {
// 解析失败按缺失处理，交给调用方走修复流程。
      const parsed = modelSelectionSchema.safeParse(JSON.parse(row.model_selection));
      if (parsed.success) return parsed.data;
    } catch {
      // 继续尝试已发布旧列的单向导入。
    }
  }
  // 旧单列没有 Provider Family，不能安全迁移到任一新 Off-Peak Provider。
  return null;
}

// 写入前重新过 schema，保证落库值与读取侧同一契约。
function serializeOffPeakModelSelection(
  selection: NonNullable<ZCodeOffPeakTask["modelSelection"]>,
): string {
// 空 options 不落键，避免与「显式空对象」混淆。
  // 空 options 不写进 JSON，避免落库后与显式空对象混淆。
  // 写前用 modelSelectionSchema.parse 再序列化，保证与读取侧同一契约。
  const options = selection.options;
  return JSON.stringify(
    modelSelectionSchema.parse({
      providerId: selection.providerId,
      modelId: selection.modelId,
      ...(options && Object.keys(options).length > 0 ? { options } : {}),
    }),
  );
}

/**
 * 闲时任务存储仓库（tasks-index.sqlite，WAL、多进程安全）。
 *
 * 仓库只做存储与原子状态迁移，守卫两条不变量：
 * 终态不可逆出；单任务认领 single-flight（任务间并发不设本地上限）。
 * 排队/晋级语义在服务端，仓库不感知——schedulable 只是 host 轮询写回的快照。
 */
/** INSERT 撞上 idx_off_peak_bound_active（并发双创建的失败方）。 */
// 并发双创建时由部分唯一索引兜底，这里只识别该冲突。
export function isOffPeakBoundSessionConflict(error: unknown): boolean {
  return (
    // 错误文本匹配把 sqlite 驱动的措辞差异隔离在此，升级驱动只需改这一处。
    error instanceof Error &&
// 匹配 sqlite 原始错误文本，驱动与版本差异被隔离在此。
    /UNIQUE constraint failed: off_peak_tasks\.workspace_key, off_peak_tasks\.session_id/.test(
      error.message,
    )
  );
}

// OffPeakTaskRepo 持有单个连接，所有写操作必须自带事务边界。
export class OffPeakTaskRepo {
// migrationBackupSkipped 供启动流程判断迁移是否因已有备份而跳过。
  migrationBackupSkipped = false;
// 连接延迟到 ensureReady 才建立，构造不触碰磁盘。
  private db: DatabaseSyncInstance | null = null;
// dbPath 记录当前连接对应的路径，变化时必须先 close 旧连接。
  private dbPath: string | null = null;
// 初始化只执行一次，并发调用共享同一 Promise。
  private initializePromise: Promise<void> | null = null;
  // 同 AutomationRepo，db 路径不能依赖进程级全局 _dataBaseDir：
  // vitest threads 并发跑测试文件时全局值被互相覆盖，存在写进真实库的窗口。
  // 改为构造期固定 dbPath，测试通过依赖注入传入临时库路径，生产路径不传则回退默认。
// 构造期固定路径，避免测试线程间共享进程级全局。
  private readonly resolvedDbPath: string | null;

  constructor(
    dbPath?: string,
// startupBusyTimeoutMs 默认 5000ms，覆盖冷启动时的锁竞争。
    private readonly startupBusyTimeoutMs = 5000,
  ) {
// 空白路径按未注入处理，回退默认库路径。
    this.resolvedDbPath = dbPath?.trim() || null;
  }

// resolveDbPath 是唯一入口，便于后续替换存储位置。
  private resolveDbPath(): string {
    return this.resolvedDbPath ?? getTasksIndexDatabasePath();
  }

// 幂等初始化：已就绪时直接复用连接。
  async ensureReady(): Promise<void> {
    const path = this.resolveDbPath();
// 路径变化说明调用方换了库，必须先关旧连接。
    // 路径变化说明换了库，必须先关旧连接，否则后续写入落到上一个库。
    if (this.dbPath && this.dbPath !== path) {
      this.close();
    }
    if (!this.initializePromise) {
// 失败时回滚连接与 Promise，下次可重试。
      this.initializePromise = this.initialize(path).catch((error) => {
        this.close();
        throw error;
      });
    }
    await this.initializePromise;
  }

// 关闭默认吞掉错误；需要显式失败时用 throwOnError。
  close(options?: { throwOnError?: boolean }): void {
    let closeError: unknown;
    try {
      this.db?.close();
    // 关闭失败不向外抛：退出流程里 db.close() 的错误会掩盖真正的业务错误。
    // 先保存 closeError 再清空句柄，保证实例不会停在看似已连接的坏状态。
    } catch (error) {
      closeError = error;
      // ignore
    }
// 三个句柄同时清空，保证下次 ensureReady 重新初始化。
    this.db = null;
    this.dbPath = null;
    // 三个句柄一并清空，下次 ensureReady 才会重新建连而不是复用已完成的 Promise。
    this.initializePromise = null;
    if (options?.throwOnError && closeError) throw closeError;
  }

// 建目录 → 开库 → 设 PRAGMA → 跑结构迁移。
  private async initialize(path: string): Promise<void> {
// 库文件父目录可能尚不存在，必须先 mkdir 再 open。
    // 首次启动时库目录可能不存在，必须先建父目录再 open，否则 SQLite 无法创建文件。
    await mkdir(dirname(path), { recursive: true });
    if (!this.db) {
      this.db = new DatabaseSync(path);
      this.dbPath = path;
      this.db.exec(`PRAGMA busy_timeout = ${this.startupBusyTimeoutMs}`);
// WAL + NORMAL 兼顾多进程读与写入延迟。
      // WAL 让多进程读写互不阻塞，host 轮询与 UI 查询因此可以并发。
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
// isTasksStoragePrepared 命中时跳过全部迁移步骤。
    // 已准备完成的库直接返回，跳过迁移与 awaiting_approval 回填，热启动少做 IO。
    if (isTasksStoragePrepared(path, this.db)) return;
    if (!isTasksStorageMigrated(path, this.db))
      this.migrationBackupSkipped = (await runTasksDatabaseMigrations(this.db, path)).backupSkipped;
    // Bug 原因：早期预留了 awaiting_approval，但生产链路从未写入，UI 却把它包装成可用能力。
    // 当前确认只走普通 session；迁移遗留行回 running，随后由启动回收按真实进程状态处理。
    // WHERE status = 'awaiting_approval' 是幂等边界：重复启动不会把已是 running 的行改回。
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'running', updated_at = @now
        WHERE status = 'awaiting_approval'`,
      )
      .run({ now: Date.now() });
  }

// 未初始化即访问属于调用方错误，直接抛错。
  private getDatabase(): DatabaseSyncInstance {
    // 构造与 close 之后 db 为 null，这里必须先拦截，否则 prepare 会解引用空连接。
    if (!this.db) {
      throw new Error("OffPeakTaskRepo 未初始化：请先 await ensureReady()");
    }
    // 只有 ensureReady 成功后才会有连接，调用方依赖这一步的前置检查。
    return this.db;
  }

// 只有同库存在 tasks 表时才做标题联查。
  private hasTasksIndexTable(): boolean {
    // 独立库或迁移前没有 tasks 表，这里返回 false 让 list 走不联查的分支。
    // hasTasksIndexTable 只探测 tasks 表是否存在，表名与 type 都是常量，不依赖调用方传参。
    // 返回 Boolean 而不是行对象，调用方只关心能不能联查。
    return Boolean(
      this.getDatabase()
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tasks'`)
        .get(),
    );
  }

// getRow 单行读取不联查 tasks，session_title 保持缺省。
  private getRow(offPeakTaskId: string): OffPeakTaskRow | null {
    // 单行读取刻意不联查 tasks 表，session_title 只在 list 的联查结果里出现。
    // 若这里也补标题，联查一旦失败会让操作回执整体报错，而回执并不需要展示标题。
    const row = this.getDatabase()
      .prepare(`SELECT * FROM off_peak_tasks WHERE off_peak_task_id = ?`)
      .get(offPeakTaskId) as OffPeakTaskRow | undefined;
    // node:sqlite 的 get 无命中返回 undefined，这里统一收敛成 null。
    // 调用方因此只处理一种空值，少写一个 undefined 分支。
    return row ?? null;
  }

  // ---- 管理 CRUD ----

  /**
   * 创建即入队（status=queued）。取号在 service 层先行（POST /ticket 成功才落库），
   * 取号结果经 options 一并写入；mock 先行阶段允许不带服务端字段。
   */
// 创建即入队：状态固定 queued，认领位与尝试次数清零。
  async create(
    params: ZCodeOffPeakTaskCreateParams,
    options?: {
      /** 测试注入用；缺省 Date.now()。 */
      now?: number;
      /** service 层先取号后落库时外部指定主键（取号需先有 task_id）；缺省内部生成。 */
      offPeakTaskId?: string;
      serverTicketId?: string;
      queuePosition?: number;
      registeredAt?: number;
      /** 取号即 ready（低峰空闲时服务端可直接晋级）时随建随派。 */
      schedulable?: boolean;
    },
  ): Promise<ZCodeOffPeakTask> {
    await this.ensureReady();
    const now = options?.now ?? Date.now();
// now 与 offPeakTaskId 都可注入，便于测试构造确定性数据。
    // 主键可在取号后由 service 传入，服务端要求先有 task_id 才能发 ticket。
    // 缺省时用 offpeak 前缀加 uuid，保证跨进程唯一且日志可读。
    const offPeakTaskId = options?.offPeakTaskId ?? `offpeak-${randomUUID()}`;
// 身份 key 统一由 workspacePath/identity 解析。
    // 身份 key 由 workspacePath 与 workspaceIdentity 派生，后续所有归属校验都基于它。
    // 路径本身不参与身份判定，同一目录换身份会得到不同的 key。
    // 两个同路径不同身份的任务因此能并存，不会被误判为重复绑定。
    const workspaceKey = resolveWorkspaceKey({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    this.getDatabase()
      .prepare(
        `INSERT INTO off_peak_tasks (
          off_peak_task_id, server_ticket_id, title, conversation_id, session_id,
          prompt, permission_mode, model, thought_level, model_selection,
          workspace_key, workspace_path, workspace_identity, project_id, host_id, additional_directories,
          status, queued_at, registered_at, schedulable, queue_position,
          claim_running, attempt_count, created_at, updated_at
        ) VALUES (
          @off_peak_task_id, @server_ticket_id, @title, NULL, @session_id,
          @prompt, @permission_mode, @model, @thought_level, @model_selection,
          @workspace_key, @workspace_path, @workspace_identity, @project_id, @host_id, @additional_directories,
          'queued', @queued_at, @registered_at, @schedulable, @queue_position,
          0, 0, @now, @now
        )`,
      )
      .run({
// 绑定会话在创建时写入，conversation_id 留空表示尚未跑过。
        // 主键在 INSERT 参数里显式给出，取号与落库用的是同一个 task_id。
        off_peak_task_id: offPeakTaskId,
        server_ticket_id: options?.serverTicketId ?? null,
        // 创建不做字段兜底：缺 title 应在协议层被拦住，而不是在库里落成空标题。
        title: params.title,
        // 会话内创建绑定当前会话；conversation_id 仍等首跑回填（非空 = 已跑过）。
        // 会话内创建会绑定当前 session，conversation_id 仍等首跑回填。
        session_id: params.boundSessionId ?? null,
        prompt: params.prompt,
        permission_mode: params.permissionMode,
// 新记录只写正式 Selection，旧列保持空以免伪造身份。
        model: null,
        thought_level: null,
        // 新记录只写正式 Selection，旧列 model 与 thought_level 保持 NULL 以免伪造身份。
        model_selection: serializeOffPeakModelSelection(params.modelSelection),
        workspace_key: workspaceKey,
        workspace_path: params.workspacePath,
        workspace_identity: params.workspaceIdentity ?? null,
        project_id: params.projectId ?? null,
        host_id: params.hostId ?? null,
        additional_directories:
// additional_directories 必须先校验再序列化，超过 256 条直接抛错。
          params.additionalDirectories === undefined
            ? null
            : JSON.stringify(
                z.array(z.string().min(1)).max(256).parse(params.additionalDirectories),
              ),
// 入队时间与创建时间同值，FIFO 依赖该列。
        // 入队时间与创建时间同值，FIFO 顺序依赖 queued_at 这一列。
        queued_at: now,
        // 注册时间来自服务端取号回执，缺省为 null 表示还没取到号。
        // 该列参与轮询判断，不能拿本地 queued_at 顶替。
        registered_at: options?.registeredAt ?? null,
// 取号即 ready 时才允许立即派发。
        // 只有取号即 ready 的任务才置 1，其余等 host 轮询写回 schedulable。
        schedulable: options?.schedulable ? 1 : 0,
        queue_position: options?.queuePosition ?? null,
        now,
      });
    // 回读而不是用入参拼装，让返回对象带上 DB 端默认值与约束后的结果。
    // 感叹号安全：刚提交且主键唯一，除非另一进程在同一瞬间删除。
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

// 列表按创建时间倒序，作用域为空时返回全部身份。
  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const workspaceKey = scope?.workspacePath
      ? resolveWorkspaceKey({
          workspacePath: scope.workspacePath,
          workspaceIdentity: scope.workspaceIdentity,
        })
      : null;
    // 绑定会话标题联查 tasks-index 同库 tasks 表（卡片展示）；独立库（测试/迁移前）无该表则不联。
// withSessionTitle 只影响 session_title 展示，不参与 WHERE 过滤。
    // [边界] withSessionTitle 只决定 SELECT 是否带 title 联查：WHERE 与分页口径在两条分支完全相同。
    // 独立库（测试或迁移前）没有 tasks 表，此时退化为不联查的等价查询。
    // 是否联查由 withSessionTitle 决定一次，避免两个分支的绑定参数不一致。
    const withSessionTitle = this.hasTasksIndexTable();
    // 列表按 created_at 倒序，翻页边界稳定，编辑不会让某行跳到最前。
    // 作用域为空时 workspace_key 传 null，WHERE 条件整体放行。
    const rows = this.getDatabase()
      .prepare(
        withSessionTitle
          ? `SELECT t.*, s.title AS session_title FROM off_peak_tasks t
            LEFT JOIN tasks s ON s.workspace_key = t.workspace_key AND s.task_id = t.session_id
            WHERE (@workspace_key IS NULL OR t.workspace_key = @workspace_key)
            ORDER BY t.created_at DESC`
// 无 tasks 表时退化为不联查的等价查询。
          : `SELECT * FROM off_peak_tasks
            WHERE (@workspace_key IS NULL OR workspace_key = @workspace_key)
            ORDER BY created_at DESC`,
      )
// 空作用域传 null，表示不按身份过滤。
      .all({ workspace_key: workspaceKey }) as unknown as OffPeakTaskRow[];
    // 逐行映射不抛错，坏 JSON 列在 rowToTask 内部降级为未设置。
    return rows.map(rowToTask);
  }

// 单条读取用于操作回执，不存在返回 null。
  async get(offPeakTaskId: string): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const row = this.getRow(offPeakTaskId);
    // 查不到返回 null，与查到了但字段全空严格区分，操作回执据此提示失败。
    // 不要改成抛错：UI 删除后仍可能提交读取，抛错会把正常时序变成异常。
    return row ? rowToTask(row) : null;
  }

  /**
   * Registry 变化使已保存 Selection 失效时，保留原模型与档位供用户修复或后续可靠恢复，
   * 同时清空正式 Selection 并撤销可调度状态，避免旧配置继续被 scheduler 认领。
   */
// invalidateModelSelection 必须放在事务内，避免与用户修复并发覆盖。
  async invalidateModelSelection(
    offPeakTaskId: string,
    modelSelection: NonNullable<ZCodeOffPeakTask["modelSelection"]>,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const db = this.getDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.getRow(offPeakTaskId);
// 行已删除时直接 COMMIT 空事务，不视为错误。
      if (!current) {
        db.exec("COMMIT");
        return null;
      }
// currentSelection 先读出来，用于判断是否已被他处修复。
      // 先读当前选择判断是否已被他处修复，不能拿旧 Registry 观察覆盖用户新选的模型。
      const currentSelection = readOffPeakModelSelection(current);
      if (
        currentSelection &&
        (currentSelection.providerId !== modelSelection.providerId ||
          currentSelection.modelId !== modelSelection.modelId ||
// providerId 或 modelId 任一不同都说明已被修复，必须保留现值。
          // 任一维度不同都说明修复已发生，这里必须放行并返回现值，否则会把用户选择改回旧值。
          currentSelection.options?.reasoningLevel !== modelSelection.options?.reasoningLevel)
      ) {
        // 另一进程已完成用户修复，以更新后的值为准，不能用旧 Registry 观察覆盖它。
        db.exec("COMMIT");
        return rowToTask(current);
      }
      // SET 里 model/thought_level 是回滚快照，model_selection 置空等待用户重新选择。
      // 同时把 schedulable 置 0：旧模型配置对应的可调度标记必须一起撤销，否则调度器会继续认领。
      db.prepare(
        `UPDATE off_peak_tasks
         SET model = @model, thought_level = @thought_level,
             model_selection = NULL, schedulable = 0, updated_at = @now
         WHERE off_peak_task_id = @id`,
      ).run({
        id: offPeakTaskId,
        model: modelSelection.modelId,
        thought_level: modelSelection.options?.reasoningLevel ?? null,
        now: options?.now ?? Date.now(),
      });
// 提交前重读，保证返回的是最终落库值。
      const invalidated = this.getRow(offPeakTaskId);
      // 提交前已重读，返回的是最终落库值而不是内存里的期望值。
      // 读与写之间仍有窗口，因此比较用的是 providerId 与 modelId 两个维度。
      db.exec("COMMIT");
      return invalidated ? rowToTask(invalidated) : null;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 卡片 Delete：任何状态均可删（非终态删除的服务端核销由 service 层先行取消处理）。 */
// 物理删除单行；服务端核销由 service 层先行处理。
  async delete(offPeakTaskId: string): Promise<void> {
    await this.ensureReady();
    this.getDatabase()
      .prepare(`DELETE FROM off_peak_tasks WHERE off_peak_task_id = ?`)
      // 物理删除不检查 status，任何状态都能删。
      // 服务端核销必须先由 service 层取消，否则库里删了而服务端队列仍挂着一条任务。
      // 不级联删 tasks 与 run 历史，删除后只能靠服务端对账收敛。
      .run(offPeakTaskId);
  }

  /**
   * 仅隐藏 History 行：任务必须已经实际启动；重复调用幂等。
   * 不修改状态、session、started/ended/filesChanged 或服务端核销字段。
   */
// markHistoryDeleted 只打 history_deleted_at，不触碰 status 与执行字段。
  async markHistoryDeleted(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const row = this.getRow(offPeakTaskId);
// 从未启动过的任务不算历史，保持原样返回。
    // 从未启动的任务没有历史可隐藏，原样返回而不是报错。
    if (!row || row.started_at === null) return row ? rowToTask(row) : null;
// 重复调用幂等，保留首次隐藏时间。
    if (row.history_deleted_at !== null) return rowToTask(row);
    const now = options?.now ?? Date.now();
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET history_deleted_at = @now, updated_at = @now
        WHERE off_peak_task_id = @id AND started_at IS NOT NULL`,
      )
// 条件里再次校验 started_at，避免竞态写入。
      .run({ id: offPeakTaskId, now });
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /** 创建上限的本地预判用（权威是服务端取号 429/3103）。 */
// countNonTerminal 仅供本地预判，权威上限仍以服务端取号 429/3103 为准。
  async countNonTerminal(): Promise<number> {
    await this.ensureReady();
    // countNonTerminal 统计全部非终态行，作为取号 429/3103 之前的本地预判。
    // 权威上限在服务端，本地只提前给出可读错误，不能把它当成最终判据。
    const row = this.getDatabase()
      .prepare(
        `SELECT COUNT(*) AS n FROM off_peak_tasks WHERE status NOT IN (${TERMINAL_SQL_LIST})`,
      )
      .get() as { n: number };
    // 终态清单由 TERMINAL_SQL_LIST 投影，改 OFF_PEAK_TERMINAL_STATUSES 时这里自动跟随。
    return row.n;
  }

  /** 本会话是否已有未终态绑定任务（创建前预检；索引 idx_off_peak_bound_active 同条件）。 */
// 与部分唯一索引同条件，用于创建前快速预检。
  async hasActiveBoundTask(workspaceKey: string, sessionId: string): Promise<boolean> {
    await this.ensureReady();
    // 查询条件与部分唯一索引 idx_off_peak_bound_active 完全一致。
    // hasActiveBoundTask 预检通过后仍可能撞索引，撞上说明另一进程抢先插入。
    // status NOT IN (${TERMINAL_SQL_LIST}) 与部分唯一索引共用同一份终态清单，两处口径分叉会让预检漏判。
    const row = this.getDatabase()
      .prepare(
        `SELECT 1 AS hit FROM off_peak_tasks
         WHERE workspace_key = @workspace_key AND session_id = @session_id
           AND status NOT IN (${TERMINAL_SQL_LIST})
         LIMIT 1`,
      )
// LIMIT 1 只取一行即可判断是否存在。
      .get({ workspace_key: workspaceKey, session_id: sessionId }) as { hit: number } | undefined;
    // 只取一行判存在，LIMIT 1 让命中后立即停止，不为布尔值扫全表。
    return row !== undefined;
  }

  /** 执行中计数：keep-awake powerSaveBlocker 判据。 */
// 只统计 running，用于 keep-awake 判定。
  async countActive(): Promise<number> {
    await this.ensureReady();
    // 只统计 running，keep-awake 的 powerSaveBlocker 依据该数是否为 0 释放。
    // queued 与 paused 不能计入，否则进程永远不会进入可休眠状态。
    const row = this.getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM off_peak_tasks WHERE status = 'running'`)
      .get() as { n: number };
    return row.n;
  }

  /**
   * 编辑窗口期字段：仅 queued/paused 可编辑；票只锁队列身份，prompt 派发时才读。
   * modelSelection 只能替换为另一份明确 Selection；undefined = 不改。
   */
// 仅 queued/paused 可编辑，运行中改动会让派发语义错乱。
  async updateEditableFields(
    offPeakTaskId: string,
    params: {
      title?: string;
      prompt?: string;
      permissionMode?: string;
      modelSelection?: ZCodeOffPeakTask["modelSelection"] | null;
    },
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    const row = this.getRow(offPeakTaskId);
    // 行不存在时返回 null 而不是抛错，编辑窗口关闭属于正常交互。
    if (!row) return null;
    // 运行中改 prompt 会让派发读到的内容与已上报意图不一致，只放行 queued 与 paused。
    // 返回 null 而不是抛错，编辑窗口关闭属于预期交互而非异常。
    // 必须在读取 row 之后判断，SQL 里的守卫只能防止并发覆盖。
    if (row.status !== "queued" && row.status !== "paused") return null;
// 显式 null 表示清空选择，Off-Peak 不允许，直接拒绝。
    // 显式 null 表示清空选择，Off-Peak 没有跟随默认的语义，只能拒绝。
    if (params.modelSelection === null) return null;
// 未传选择时沿用原值，避免普通编辑丢失模型。
    // 未传选择时沿用原值；原值也解析失败则抛错，暴露损坏而不是静默清空。
    // 显式 null 已在上面拒绝，所以这里的 undefined 只表示本次不改。
    const nextModelSelection = params.modelSelection ?? readOffPeakModelSelection(row);
    if (!nextModelSelection) {
// 无有效 modelSelection 可沿用说明数据已损坏，必须抛错暴露。
      throw new Error(`Off-Peak task 缺少有效 ModelSelection: ${offPeakTaskId}`);
    }
    // 旧列是已发布版本的回滚快照，不能因普通编辑被清空；本更新只改 model_selection，
    // 不反向改写旧身份/档位，也不为新记录伪造旧值。
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks SET
          title = @title, prompt = @prompt, permission_mode = @permission_mode,
          model_selection = @model_selection, updated_at = @now
        WHERE off_peak_task_id = @id`,
      )
      .run({
        id: offPeakTaskId,
        title: params.title ?? row.title,
        prompt: params.prompt ?? row.prompt,
        permission_mode: params.permissionMode ?? row.permission_mode,
        // 只改 model_selection 而不反向改写旧列快照，否则回滚版本会读到新值。
        model_selection: serializeOffPeakModelSelection(nextModelSelection),
        now: options?.now ?? Date.now(),
      });
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  // ---- 服务端同步快照（host offPeakTaskSync 写 / scheduler 读）----

  /** 轮询/重新取号写回：仅覆盖显式传入的字段。 */
// 只覆盖显式字段，未传的列保持原值。
  async updateSchedulingSnapshot(
    offPeakTaskId: string,
    patch: {
      schedulable?: boolean;
      queuePosition?: number | null;
      nextPollAt?: number | null;
      serverTicketId?: string;
      registeredAt?: number;
      now?: number;
    },
  ): Promise<void> {
    await this.ensureReady();
    const row = this.getRow(offPeakTaskId);
    // 行已删除时静默返回：快照写入是异步轮询结果，删除先发生是正常时序。
    if (!row) return;
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks SET
          schedulable = @schedulable,
          queue_position = @queue_position,
          next_poll_at = @next_poll_at,
          server_ticket_id = @server_ticket_id,
          registered_at = @registered_at,
          updated_at = @now
        WHERE off_peak_task_id = @id`,
      )
      .run({
        id: offPeakTaskId,
// schedulable 布尔与 0/1 的转换集中在此。
        // 只在显式传入时覆盖，undefined 表示本轮未拿到该字段而不是置 0。
        // 布尔与 0/1 的转换集中在这里，SQL 绑定值永远是整数。
        schedulable: patch.schedulable === undefined ? row.schedulable : patch.schedulable ? 1 : 0,
        queue_position:
          patch.queuePosition === undefined ? row.queue_position : patch.queuePosition,
        next_poll_at: patch.nextPollAt === undefined ? row.next_poll_at : patch.nextPollAt,
// server_ticket_id 新票覆盖旧票，缺省时必须保留原票据。
        // serverTicketId 新票覆盖旧票，缺省时保留原票据，避免一次空轮询把票冲掉。
        server_ticket_id: patch.serverTicketId ?? row.server_ticket_id,
        registered_at: patch.registeredAt ?? row.registered_at,
        now: patch.now ?? Date.now(),
      });
  }

  // ---- 调度状态机 ----

  /**
   * single-flight 认领可派发任务：status=queued 且 schedulable=1 且无在途认领，
   * 原子 claim_running 0→1。FIFO 序按 queued_at（权威序由服务端取号顺序保证）。
   * 同时回收认领超时（claimed_at 过期）的僵尸认领。
   */
// 认领与僵尸回收在同一事务内完成，保证 single-flight。
  async claimDue(now: number): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    const db = this.getDatabase();
    // 僵尸复位与认领必须在同一事务内，否则两个进程会同时复位并抢到同一行。
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL
        WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
// claimed_at 超过 OFF_PEAK_CLAIM_STALE_MS 视为持有者崩溃，先复位再挑任务。
      ).run({ stale: now - OFF_PEAK_CLAIM_STALE_MS });
// 只挑可调度且未被认领的 queued 行，顺序即 FIFO。
      // WHERE 同时要求 status='queued' AND schedulable=1 AND claim_running=0，缺一项就会把已认领或不可调度的行放进候选集。
      // ORDER BY 以 queued_at 为主排序，created_at 只在同一毫秒内兜底，保证派发顺序确定。
      const dueRows = db
        .prepare(
          `SELECT * FROM off_peak_tasks
          WHERE status = 'queued' AND schedulable = 1 AND claim_running = 0
          ORDER BY queued_at ASC, created_at ASC`,
        )
        .all() as unknown as OffPeakTaskRow[];
      const claimed: ZCodeOffPeakTask[] = [];
// 认领用条件更新，changes=1 才代表抢到。
      // 认领语句复用同一个 prepared statement，循环内只换绑定参数以减少解析开销。
      // 认领写 claimed_at 时间戳：超过 OFF_PEAK_CLAIM_STALE_MS 后由 stale 回收复位。
      // WHERE claim_running = 0 是抢锁条件，changes = 1 才代表本方拿到该行。
      const claim = db.prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 1, claimed_at = @now, updated_at = @now
        WHERE off_peak_task_id = @id AND claim_running = 0`,
      );
      // 候选集在事务内查出，循环里再逐条条件更新，changes 才是抢到的证据。
      for (const row of dueRows) {
        // 历史行可能没有 Provider 身份；它们必须留在列表等待修复，但不能被
        // scheduler 认领。逐行跳过还能保证一条旧记录不阻塞后续健康任务。
// 缺 Provider 身份的历史行留在列表但跳过派发。
        // 缺 Provider 身份的历史行留在列表等待修复，但不能被 scheduler 认领。
        // 逐行跳过而不是整体失败，保证一条旧记录不阻塞后续健康任务。
        // 修复入口是 invalidateModelSelection，认领侧只做过滤不做修补。
        if (!readOffPeakModelSelection(row)) continue;
        const res = claim.run({ id: row.off_peak_task_id, now });
// changes 为 1 才说明并发下本方拿到该行。
        if (res.changes === 1) {
// 返回值反映认领后的状态，不再次读库。
          // 用 SELECT 快照加手工覆盖构造返回值，省掉一次读库且与刚写入的状态一致。
          claimed.push(rowToTask({ ...row, claim_running: 1, claimed_at: now }));
        }
      }
      // 全部认领成功后才提交，中途异常统一 ROLLBACK 回到认领前状态。
      // 崩溃窗口：COMMIT 之后、调用方 markRunning 之前进程死亡，盘上会留下「status=queued 且 claim_running=1」的中间态。
      // recoverInterrupted 只把 running 回队，不处理这种行；它只能等下一次 claimDue 按 OFF_PEAK_CLAIM_STALE_MS 过期复位。
      db.exec("COMMIT");
      return claimed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 派发成功（网关 admitted）：queued→running，回填首跑产生的 conversation/session 与
   * 本段 ticket，释放认领。守卫：仅 queued 可入 running（终态不可逆出；paused 竞态下
   * 派发结果作废，返回 null 由调用方处理）。续跑段保留首段 started_at（用户视角单任务）。
   */
// 派发成功：queued→running，并回填首跑产生的标识。
  async markRunning(
    offPeakTaskId: string,
    options: {
      startedAt: number;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    // 顺序约束：必须在网关 admitted 回执的同一段同步逻辑里调用，不能延后到异步回调。
    // 网关已受理而本地仍是 queued+claim 时，崩溃后过期复领会再次派发同一任务，服务端出现重复 run。
    // 条件 UPDATE 的 changes 是唯一成功判据：paused 竞态下返回 0，派发结果必须作废。
    // 守卫写在 WHERE 里而不是先查后改，避免检查与写入之间的窗口。
    // started_at 用 COALESCE 保留首段开始时间：续跑不刷新，UI 仍显示同一任务的原始开始时刻。
    // WHERE status = 'queued' 是唯一入口守卫，paused 或终态并发下 changes = 0。
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'running',
            started_at = COALESCE(started_at, @started_at),
            conversation_id = COALESCE(@conversation_id, conversation_id),
            session_id = COALESCE(@session_id, session_id),
            server_ticket_id = COALESCE(@server_ticket_id, server_ticket_id),
            claim_running = 0, claimed_at = NULL,
            last_error = NULL,
            updated_at = @started_at
        WHERE off_peak_task_id = @id AND status = 'queued'`,
      )
      .run({
        id: offPeakTaskId,
        // started_at 用 COALESCE 只写一次，续跑段必须沿用首段时间，用户视角才是同一任务。
        started_at: options.startedAt,
        // 传 null 时 SQL 用 COALESCE 保留原值，续跑不会把首段会话抹掉。
        conversation_id: options.conversationId ?? null,
        session_id: options.sessionId ?? null,
        server_ticket_id: options.serverTicketId ?? null,
      });
    // 返回 null 让调用方区分派发成功但状态已被改与真正的写入失败。
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /**
   * 终态落库（completed/failed/cancelled）。守卫：终态不可逆出——已终态的行拒绝二次迁移，
   * 返回 null（OffPeakRunResult 迟到兜底时调用方据此丢弃）。settled_at 由核销单独回填。
   */
// markTerminal 的条件必须排除全部终态状态。
  async markTerminal(
    offPeakTaskId: string,
    options: {
      status: "completed" | "failed" | "cancelled";
      endedAt: number;
      failureReason?: string;
      filesChanged?: number;
      /** scheduler 派发阶段的确定性错误；存在时原子累计一次派发尝试并留 last_error。 */
      dispatchError?: string;
    },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    // 终态写入用 status NOT IN 终态清单做守卫，重复结算第二次 changes 为 0。
    // failure_reason 可为空：成功与取消不写原因，绑定 @failure_reason = NULL 即可。
    // attempt_count 只按 @dispatch_attempt_inc 累加，运行期失败不消耗重试预算。
    // 终态写入同时把 schedulable 置 0，防止已结束的任务被调度器再次选中。
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = @status,
            ended_at = @ended_at,
            failure_reason = @failure_reason,
            files_changed = COALESCE(@files_changed, files_changed),
            attempt_count = attempt_count + @dispatch_attempt_inc,
            last_error = COALESCE(@dispatch_error, last_error),
            schedulable = 0,
            claim_running = 0, claimed_at = NULL,
            updated_at = @ended_at
        WHERE off_peak_task_id = @id AND status NOT IN (${TERMINAL_SQL_LIST})`,
      )
      .run({
        id: offPeakTaskId,
// 终态值由调用方给出，SQL 只负责守卫。
        // 终态值由调用方给出，SQL 只负责守卫合法性，不在这里做枚举映射。
        status: options.status,
        ended_at: options.endedAt,
        // 成功与取消通常不带失败原因，写 null 而不是空串，避免 UI 展示一条空错误。
        failure_reason: options.failureReason ?? null,
        // COALESCE 保留已有值：续跑段没统计文件数时不能把首段结果清零。
        files_changed: options.filesChanged ?? null,
// dispatchError 缺省时 attempt_count 不增加。
        // 只有派发阶段错误才累计 attempt_count，运行失败不计入重试预算。
        dispatch_attempt_inc: options.dispatchError ? 1 : 0,
        dispatch_error: options.dispatchError ?? null,
      });
    // 已终态的行拒绝二次迁移，迟到的 run 结果据此丢弃而不是覆盖终态。
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /**
   * 用户 Pause / Continue：queued ⇄ paused。
   * Pause 只停本地派发（票留服务端队列）；Continue 的票有效性判断与重取号在 service 层。
   * 已被认领派发在途（claim_running=1）的任务不可 Pause，返回 null。
   */
// 暂停/继续只做状态互换，票的有效性由 service 层判断。
  async setPaused(
    offPeakTaskId: string,
    paused: boolean,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    // 暂停只改本地状态，服务端票仍留在队列，续跑时由 service 重新判票。
    // claim_running = 0 是暂停前置：已被认领的任务 changes = 0，避免派发中途丢结果。
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = @to, updated_at = @now
        WHERE off_peak_task_id = @id AND status = @from AND claim_running = 0`,
      )
      .run({
        id: offPeakTaskId,
// 目标状态与来源状态互换，只能沿 queued⇄paused 迁移。
        // 来源与目标状态成对互换，只能沿 queued 与 paused 之间迁移。
        // 其它状态 changes 为 0，调用方据此知道本次操作没有生效。
        // claim_running 为 1 时同样不生效，避免派发中途丢结果。
        to: paused ? "paused" : "queued",
        from: paused ? "queued" : "paused",
        now: options?.now ?? Date.now(),
      });
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /**
   * 释放认领（派发失败/关机退出）：复位 single-flight 锁；带 error 时累计 attempt_count
   * 并记 last_error（供派发退避与诊断）。不改 status——任务留在 queued 等下轮认领（无 skip）。
   */
// releaseClaim 只复位 claim_running 而不改 status，任务仍留在队列。
  async releaseClaim(
    offPeakTaskId: string,
    options?: { error?: string; now?: number },
  ): Promise<void> {
    await this.ensureReady();
    // WHERE claim_running = 1 保证只释放确实持有的认领，重复调用 changes = 0、无副作用。
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL,
            attempt_count = attempt_count + @attempt_inc,
            last_error = COALESCE(@error, last_error),
            updated_at = @now
        WHERE off_peak_task_id = @id AND claim_running = 1`,
      )
      .run({
        id: offPeakTaskId,
// 只有带错误才算一次失败尝试。
        // 只有带错误才累计 attempt_count，正常关机释放不消耗重试预算。
        attempt_inc: options?.error ? 1 : 0,
        // error 为 null 时 COALESCE 保留原 last_error，不因一次干净释放抹掉诊断信息。
        error: options?.error ?? null,
        now: options?.now ?? Date.now(),
      });
  }

  /**
   * 启动回收（app 级启动时调用一次，先于任何派发）：进程死亡时残留的
   * running 置回 queued（保留 queued_at，天然仍在队首附近；保留 session_id 供 resume
   * 续跑），并清理超时认领。返回回收的任务数。
   * ⚠ 调用方必须保证调用时无在跑 off-peak loop（属主应为 app 单例进程，非每个 host）。
   */
// 启动回收把残留 running 置回 queued，保留会话供续跑。
  async recoverInterrupted(now: number): Promise<number> {
    await this.ensureReady();
    const db = this.getDatabase();
    // 回队与超时认领清理同事务，避免回收中途被别的 host 抢先认领。
    db.exec("BEGIN IMMEDIATE");
    try {
      // 进程崩溃时 running 行无人收尾，启动时统一置回 queued 并清认领。
      // 只把 running 回队而终态与 paused 不动，避免把用户暂停的任务重新拉起。
      // 调用方必须保证此时没有在跑的 off-peak loop，否则会与活跃 worker 抢同一行。
      // SET 同时清 claim_running 与 claimed_at：只改 status 会留下僵尸锁，下一轮认领会误判被占用。
      // WHERE status = 'running' 是唯一来源，终态与 paused 保持原状。
      const recovered = db
        .prepare(
          `UPDATE off_peak_tasks
          SET status = 'queued', claim_running = 0, claimed_at = NULL, updated_at = @now
          WHERE status = 'running'`,
        )
        .run({ now });
      db.prepare(
        `UPDATE off_peak_tasks
        SET claim_running = 0, claimed_at = NULL, updated_at = @now
        WHERE claim_running = 1 AND claimed_at IS NOT NULL AND claimed_at <= @stale`,
// 回收与认领必须共用 OFF_PEAK_CLAIM_STALE_MS。
      ).run({ now, stale: now - OFF_PEAK_CLAIM_STALE_MS });
      db.exec("COMMIT");
// 返回回收条数供启动日志记录。
      // changes 可能是 bigint，统一 Number 化后返回给启动日志统计。
      return Number(recovered.changes ?? 0);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 3h 时间盒到期 / ready 废票的续跑回队：running → queued，保留
   * session/conversation/started_at 供 resume 接续；清 schedulable 与位次等待重新取号后由轮询刷新。
   * 终态/paused 不可回队，返回 null（如用户已抢先取消）。
   */
// 时间盒到期回队：保留会话与开始时间，清空调度快照。
  async requeueForContinuation(
    offPeakTaskId: string,
    options?: { now?: number },
  ): Promise<ZCodeOffPeakTask | null> {
    await this.ensureReady();
    // 只有 running 可回队，终态或已取消返回 null，调用方据此放弃续跑。
    // 回队保留 session_id 与 started_at，resume 才能接上上一段上下文。
    // queue_position 置空：旧位次在重新取号后失效，避免 UI 显示过期位置。
    // WHERE status = 'running' 是唯一来源，终态或已取消时 changes = 0 并返回 null。
    const res = this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET status = 'queued', schedulable = 0, queue_position = NULL,
            claim_running = 0, claimed_at = NULL, updated_at = @now
        WHERE off_peak_task_id = @id AND status = 'running'`,
      )
      .run({ id: offPeakTaskId, now: options?.now ?? Date.now() });
    // changes 为 0 说明状态已被别处改掉，例如用户刚取消，不能强行覆盖。
    if (res.changes !== 1) return null;
    return rowToTask(this.getRow(offPeakTaskId)!);
  }

  /** 全部非终态任务（offPeakTaskSync 轮询输入：有非终态才轮）。 */
// 轮询输入：按排队时间升序，保证先到先查。
  async listNonTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    // 轮询输入按 queued_at 升序，先入队的任务先取号，新任务不会插队。
    // 空数组也要返回，调用方用长度判断还需要不需要继续轮询。
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM off_peak_tasks
        WHERE status NOT IN (${TERMINAL_SQL_LIST})
        ORDER BY queued_at ASC`,
      )
      .all() as unknown as OffPeakTaskRow[];
    // 不联查 tasks 表：轮询只需要状态与票据，标题属于展示层职责。
    return rows.map(rowToTask);
  }

  // ---- 终态核销 outbox----

  /** settle 服务端 ack 后回填；仅终态行可核销（幂等，重复回填覆盖为最新 ack 时间）。 */
// markSettled 只对终态行生效，重复回填覆盖为最新时间。
  async markSettled(offPeakTaskId: string, settledAt: number): Promise<void> {
    await this.ensureReady();
    // WHERE status IN (${TERMINAL_SQL_LIST}) 拦住非终态行：只有终态任务才有核销语义。
    this.getDatabase()
      .prepare(
        `UPDATE off_peak_tasks
        SET settled_at = @settled_at, updated_at = @settled_at
        WHERE off_peak_task_id = @id AND status IN (${TERMINAL_SQL_LIST})`,
      )
      // 核销只对终态行生效，WHERE 用 status IN 终态清单拦住非终态。
      // 重复回填覆盖成最新 ack 时间，因此必须保持幂等。
      // 不校验 changes：行不存在时静默成功，核销是补报而不是强一致操作。
      .run({ id: offPeakTaskId, settled_at: settledAt });
  }

  /** 未核销的终态任务：poll 周期捎带补报 + host 启动扫描（不新增计时器）。 */
// 未核销终态按结束时间升序补报。
  async listUnsettledTerminal(): Promise<ZCodeOffPeakTask[]> {
    await this.ensureReady();
    // 只取 settled_at 为空的终态行，已核销的不再重复上报。
    // ORDER BY ended_at ASC 让先结束的先补报，避免旧记录长期滞留。
    const rows = this.getDatabase()
      .prepare(
        `SELECT * FROM off_peak_tasks
        WHERE status IN (${TERMINAL_SQL_LIST}) AND settled_at IS NULL
        ORDER BY ended_at ASC`,
      )
      .all() as unknown as OffPeakTaskRow[];
    // 按 ended_at 升序，先结束的先补报，避免旧记录长期滞留。
    return rows.map(rowToTask);
  }
}
