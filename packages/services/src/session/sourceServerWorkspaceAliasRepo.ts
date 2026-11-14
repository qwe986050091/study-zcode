// 本文件只做一件事：把同一物理路径下漂移的多条 remote workspace identity 收敛成 canonical。
// 依赖 tasks 库迁移与 off-peak 冲突取消，保证读到的表结构与 CLI 侧完全一致。
import { runTasksDatabaseMigrations } from "#src/session/tasksDatabase/migrations.js";
import { cancelConflictingOffPeakBindings } from "#src/session/offPeakWorkspaceIdentityMigration.js";
import { runSessionDatabaseIdentityMigration } from "@zcode/shared/sqlite-migrations";
/* eslint-disable max-lines -- R3 canonical alias、双库备份、ledger 与幂等合并属于同一迁移事务边界。 */
// sha256 用于 abandoned 之后的活跃度基线；randomUUID 同时充当 migrationId 与 session 库代际。
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
// 配置目录只做 rename 与递归 rm，避免出现半拷贝文件；读取内容仅用于相等性比较。
// 全部走 promises 版本，避免同步 IO 阻塞同进程内其他 workspace 的解析。
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE,
  WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE,
  WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
  WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE,
  type SourceServerMigrationReport,
  type SourceServerMigrationReportRow,
} from "@zcode/shared";
// getWorkspaceHash 决定 sessions 下目录名，算法必须与 CLI 侧一致，否则会读到空目录并漏合并。
import { getDataBaseDir, getTasksIndexDatabasePath, getWorkspaceHash } from "#src/paths.js";

// node:sqlite 是同步驱动，同一连接上的语句天然串行，因此不引入连接池或队列。
type Database = InstanceType<typeof DatabaseSync>;
const require = createRequire(import.meta.url);
// backup 在库内部完成一致性快照，避免迁移过程中读到写了一半的页面。
// require 形式规避 ESM 对 node:sqlite 的类型与导出差异。
const { backup, DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

// 所有外部依赖均可注入：单测据此固定时钟、migrationId、备份根与双库路径。
export interface SourceServerWorkspaceAliasRepoOptions {
  taskDbPath?: string;
  sessionDbPath?: string;
  backupRoot?: string;
  now?: () => number;
  migrationId?: () => string;
// 每个阶段提交后回调一次；钩子抛错会把 ledger 标 failed，因此只允许幂等的观测或清理。
  afterPhaseCommitted?: (phase: WorkspaceMigrationPhase) => Promise<void> | void;
}

// 数组顺序即恢复语义：越靠前代表该阶段及其之前的工作已持久化，可直接跳过。
// 顺序是唯一真相，禁止在中间插入新阶段，否则旧 ledger 的 phase 会整体错位。
export const WORKSPACE_MIGRATION_PHASES = [
  "preflight",
  "backups-created",
  "task-db-merged",
  "session-db-merged",
// 配置目录合并排在双库之后：文件系统无法回滚，必须让 DB 先落定再动文件。
// alias-published 之前的所有步骤都可能被 resume 重放，每一步都必须幂等。
  "config-dirs-merged",
  "alias-published",
  "completed",
] as const;

// 用字面量联合而非 string，让 ledger 解析与阶段比较在编译期就受集合约束。
export type WorkspaceMigrationPhase = (typeof WORKSPACE_MIGRATION_PHASES)[number];

// 用数组下标比较进度，避免再维护一份枚举造成顺序漂移。
function hasReachedMigrationPhase(
  current: WorkspaceMigrationPhase,
  target: WorkspaceMigrationPhase,
): boolean {
// 用 >= 而非 ==：恢复时只要越过该阶段，就必须跳过其副作用而不是重做。
  return WORKSPACE_MIGRATION_PHASES.indexOf(current) >= WORKSPACE_MIGRATION_PHASES.indexOf(target);
}

// 未知 phase 返回 null，由调用方视为 ledger 损坏并拒绝继续恢复。
function parseMigrationPhase(value: string): WorkspaceMigrationPhase | null {
  return WORKSPACE_MIGRATION_PHASES.includes(value as WorkspaceMigrationPhase)
    ? (value as WorkspaceMigrationPhase)
    : null;
}

// legacyRouteHint 只服务于新 URL Server 的首次绑定，已有 alias 与 variants 的裁决不使用它。
export interface ResolveCanonicalWorkspaceKeyInput {
  workspacePath: string;
  legacyRouteHint?: string;
}

// mergedKeys 只含本次真正改写的身份线；空数组代表无需搬运，调用方可跳过提示。
export interface ResolveCanonicalWorkspaceKeyResult {
  canonicalKey: string;
  mergedKeys: string[];
  migrationId?: string;
}

// 身份冲突不可重试：同一 taskId 的两个身份字段取值不同，只能由用户放弃或人工修复。
export class SourceServerWorkspaceIdentityConflictError extends Error {
  public readonly code = WORKSPACE_TASK_IDENTITY_CONFLICT_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly conflicts: WorkspaceTaskIdentityConflict[] = [],
  ) {
// conflicts 随错误一起抛出，上层可直接渲染冲突清单，无需再次查库。
    super(`Source Server workspace task identity conflict: ${workspacePath}`);
    this.name = "SourceServerWorkspaceIdentityConflictError";
  }
}

// 配置冲突同样不可重试：同名不同内容的文件无法自动裁决，强行合并会丢数据。
export class SourceServerWorkspaceConfigConflictError extends Error {
  public readonly code = WORKSPACE_CONFIG_FILE_CONFLICT_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly relativePath: string,
    public readonly sourceKey: string,
  ) {
// 错误信息必须带相对路径与 sourceKey，否则用户无法定位是哪条身份线产生的冲突。
    super(`Source Server workspace config conflict: ${workspacePath} (${relativePath})`);
    this.name = "SourceServerWorkspaceConfigConflictError";
  }
}

// 计划分叉表示冻结 variants 之外又出现新身份线，重试也不会收敛，必须暴露给用户。
export class SourceServerWorkspaceMigrationPlanDivergedError extends Error {
  public readonly code = WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE;
  public readonly retryable = false;

  public constructor(
    workspacePath: string,
    public readonly newVariants: string[],
  ) {
    super(`Source Server workspace migration plan diverged: ${workspacePath}`);
    this.name = "SourceServerWorkspaceMigrationPlanDivergedError";
  }
}

// session 库代际变化意味着备份已不代表当前库，继续合并会写错数据，必须中止。
export class SourceServerWorkspaceSessionGenerationChangedError extends Error {
  public readonly code = WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE;
  public readonly retryable = false;

  public constructor(workspacePath: string) {
    super(`Source Server workspace session database generation changed: ${workspacePath}`);
    this.name = "SourceServerWorkspaceSessionGenerationChangedError";
  }
}

// 活跃度聚合行：canonical 选择只依赖这两个字段，查询必须按 workspace_key 分组。
interface WorkspaceActivityRow {
  workspace_key: string;
  last_active_at: number;
}

// 冲突任务与来源身份线，既用于抛错，也用于落 workspace_migration_conflicts 审计。
interface WorkspaceTaskIdentityConflict {
  taskId: string;
  sourceKey: string;
}

// v1 是历史算法；v2 增加 bootstrap 表并对无列 node-order 做过滤，两者绝不能混用。
type WorkspaceActivityDigestVersion = 1 | 2;

// 基线固定算法版本，避免算法升级本身被误判成 abandoned 之后的活跃度变化。
interface WorkspaceActivityDigestBaseline {
  version: WorkspaceActivityDigestVersion;
  digests: Record<string, string>;
}

// 目录也显式记录：空目录与文件缺失在合并语义上不同，必须先比结构再比内容。
type SessionConfigEntries = Map<string, { kind: "directory" } | { kind: "file"; content: Buffer }>;

// 只有同时具备 workspace_key 与 workspace_path 的表才能按物理路径反查身份线。
// 新增表时必须确认其 workspace_path 语义与其他表一致，否则会误判归属。
const WORKSPACE_PATH_TABLES = [
  "tasks",
  "task_group_members",
  "automations",
  "off_peak_tasks",
] as const;
// 上限阻止 task DB 提交后新身份线反复出现导致无限增量合并，超过即判定计划分叉。
const MAX_FOLLOW_UP_MIGRATIONS = 3;

// 活动迁移的内存视图，字段与 ledger 行一一对应；phase 决定从哪一步继续。
interface ActiveWorkspaceMigration {
  migrationId: string;
  canonicalKey: string;
  variants: string[];
  phase: WorkspaceMigrationPhase;
  taskBackupPath: string;
  sessionBackupPath: string | null;
  sessionDatabaseGeneration: string | null;
}

// 只认 ssh/wsl/docker 三种历史前缀；新 server identity 不能被当作可合并 variant。
function isLegacyRemoteKey(value: string): boolean {
  return (
    isRemoteWorkspaceIdentity(value) &&
    (value.startsWith("remote:ssh:") ||
      value.startsWith("remote:wsl:") ||
      value.startsWith("remote:docker:"))
  );
}

// 用 sqlite_master 探测而非 try/catch 查询：迁移前后的库都可能缺表，探测必须无副作用。
function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

// 通过 PRAGMA table_info 判断列存在，兼容只跑过部分迁移的旧库。
function hasColumn(db: Database, table: string, column: string): boolean {
  if (!hasTable(db, table)) return false;
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>
  ).some((row) => row.name === column);
}

// busy_timeout 让本进程与 CLI 并发写同库时等待而非立即报 SQLITE_BUSY。
// 每个入口自行 open/close，Repo 不持有长连接，避免跨 await 的隐式事务泄漏。
function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
// 显式开启外键：合并顺序若遗漏关联表，删除 source 行时应立刻暴露而不是静默留脏数据。
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}

// 回滚失败不能再抛：原始迁移错误才是调用方唯一有用的诊断信息。
function rollbackQuietly(db: Database): void {
  try {
    if (db.isTransaction) db.exec("ROLLBACK");
  } catch {
    // SQLite 可能已自动回滚，或清理也遇到 IO 故障；不能用二次错误覆盖原始迁移错误。
  }
}

// meta_json 键与索引列的对应表；冲突判定要求两侧取值一致，缺失视为未知而非冲突。
const TASK_IDENTITY_META_FIELDS = [
  ["cronAutomationId", "cron_automation_id"],
  ["offPeakTaskId", "off_peak_task_id"],
  ["forkedFromTaskId", "forked_from_task_id"],
] as const;

// CLI 事实列单独投影：标题、时间与删除标记由 CLI 写，索引合并不得让它们互相污染。
interface TaskCliFactsRow {
  cli_title: string | null;
  cli_title_source: string | null;
  cli_created_at: number | null;
  cli_updated_at: number | null;
  cli_last_outcome: string | null;
  cli_deleted: number | null;
  handoff_pending: number;
}

/**
 * Bug 原因：项目化索引从 cli_* 列投影标题、时间与状态；只合并旧列会在删除 source 后丢失
 * 其中较新的 CLI 事实。沿用 TaskIndexRepo.applyCliFacts 的规则：时间取最早/最晚，
 * 较新 outcome 为空时保留旧值，custom 标题不被非 custom 覆盖，待交接标记取并集。
 */
// custom 标题优先于自动生成标题，即使后者更新时间更晚也不覆盖。
function mergeTaskCliFacts(newer: TaskCliFactsRow, older: TaskCliFactsRow): TaskCliFactsRow {
  const title =
    older.cli_title_source === "custom" && newer.cli_title_source !== "custom" ? older : newer;
// 创建时间取最早、更新时间取最晚，保证合并后不丢失任一侧的历史边界。
  const times = (key: "cli_created_at" | "cli_updated_at") =>
    [newer[key], older[key]].filter((value): value is number => value !== null);
  const created = times("cli_created_at");
  const updated = times("cli_updated_at");
  return {
    cli_title: title.cli_title,
    cli_title_source: title.cli_title_source,
    cli_created_at: created.length ? Math.min(...created) : null,
    cli_updated_at: updated.length ? Math.max(...updated) : null,
    cli_last_outcome: newer.cli_last_outcome ?? older.cli_last_outcome,
    cli_deleted:
      newer.cli_deleted === null && older.cli_deleted === null
        ? null
        : Math.max(newer.cli_deleted ?? 0, older.cli_deleted ?? 0),
    handoff_pending: newer.handoff_pending | older.handoff_pending,
  };
}

// 合并只需要身份字段与更新时间；其余 meta 内容在 JSON 层整体浅合并。
interface WorkspaceTaskMetaRow {
  meta_json: string;
  updated_at: number;
  cron_automation_id: string | null;
  off_peak_task_id: string | null;
  forked_from_task_id: string | null;
}

// 损坏的 meta_json 返回 null 而不抛错：历史库存在非 JSON 脏数据，读取必须容错。
function parseMetaRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// 预检与写事务共用此函数，确保会不会冲突与实际怎么写不会出现两套规则。
function mergeTaskMetaJson(
  canonical: WorkspaceTaskMetaRow,
  source: WorkspaceTaskMetaRow,
  canonicalKey: string,
): { status: "merged"; metaJson: string } | { status: "identity-conflict" } {
  const canonicalMeta = parseMetaRecord(canonical.meta_json);
  const sourceMeta = parseMetaRecord(source.meta_json);
  // Bug 原因：历史身份可能只回填索引列，相同 JSON 也可能对应不同身份。
  // 与 TaskIndexRepo 读取一致，先补齐有效身份，再由预检和写事务共用同一冲突规则。
// 索引列可能是历史回填的唯一来源，因此 meta 缺失时要回退到列值再比较。
  for (const [key, column] of TASK_IDENTITY_META_FIELDS) {
    const canonicalValue = canonicalMeta?.[key] ?? canonical[column] ?? undefined;
    const sourceValue = sourceMeta?.[key] ?? source[column] ?? undefined;
    if (
      canonicalValue !== undefined &&
      sourceValue !== undefined &&
      canonicalValue !== sourceValue
    ) {
      return { status: "identity-conflict" };
    }
    if (canonicalMeta && canonicalValue !== undefined) canonicalMeta[key] = canonicalValue;
    if (sourceMeta && sourceValue !== undefined) sourceMeta[key] = sourceValue;
  }
  if (!canonicalMeta || !sourceMeta) {
    return canonical.meta_json === source.meta_json
      ? { status: "merged", metaJson: canonical.meta_json }
      : { status: "identity-conflict" };
  }
  const [older, newer] =
    canonical.updated_at <= source.updated_at
      ? [canonicalMeta, sourceMeta]
      : [sourceMeta, canonicalMeta];
  const merged = { ...older, ...newer };
  if ("workspaceIdentity" in merged) merged.workspaceIdentity = canonicalKey;
  return { status: "merged", metaJson: JSON.stringify(merged) };
}

// 类本身无全局可变状态：除按路径串行化的队列外，数据都在 SQLite 与文件系统里。
export class SourceServerWorkspaceAliasRepo {
  private readonly taskDbPath: string;
  private readonly sessionDbPath: string;
  private readonly backupRoot: string;
  private readonly now: () => number;
  private readonly createMigrationId: () => string;
  private readonly afterPhaseCommitted?: SourceServerWorkspaceAliasRepoOptions["afterPhaseCommitted"];
// 键是 trim 后的物理路径；同路径的读改写链必须串行，不同路径可并发。
  private readonly workspaceOperations = new Map<string, Promise<void>>();

// 默认路径必须与 CLI 完全一致，否则 Source Server 会看到另一套库与配置目录。
  public constructor(options: SourceServerWorkspaceAliasRepoOptions = {}) {
    this.taskDbPath = options.taskDbPath ?? getTasksIndexDatabasePath();
    this.sessionDbPath =
      options.sessionDbPath ?? join(getDataBaseDir(), ".zcode", "cli", "db", "db.sqlite");
// 备份放在 server 目录而非 cli 目录，避免 CLI 清理缓存时误删迁移快照。
    this.backupRoot =
      options.backupRoot ?? join(getDataBaseDir(), ".zcode", "server", "migration-backups");
    this.now = options.now ?? Date.now;
    this.createMigrationId = options.migrationId ?? randomUUID;
    this.afterPhaseCommitted = options.afterPhaseCommitted;
  }

// 对外唯一读入口：先取得同路径串行权，再进入可能写 ledger 与文件的内部实现。
  public async resolveCanonicalWorkspaceKey(
    input: ResolveCanonicalWorkspaceKeyInput,
    options: { ignoreAbandoned?: boolean } = {},
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
// 内部实现拿到的是规范化路径，后续所有查询与目录计算都必须使用它。
    return await this.runWorkspaceOperation(input.workspacePath, (workspacePath) =>
      this.resolveCanonicalWorkspaceKeyInternal({ ...input, workspacePath }, options),
    );
  }

// 通用串行化包装：本次抛错不阻塞队列，下一项仍可从已提交的 ledger 恢复。
  private async runWorkspaceOperation<T>(
    rawWorkspacePath: string,
    operation: (workspacePath: string) => Promise<T>,
  ): Promise<T> {
// 入口先规范化：Windows 大小写、尾部分隔符与空格都会让同一 workspace 落出两条 alias。
// 只 trim 不做 realpath：符号链接与大小写由上层统一处理，Repo 不擅自改写用户路径。
// 队列键、查询条件与目录计算都必须复用这个值。
    const workspacePath = rawWorkspacePath.trim();
// 空路径属于调用方错误：直接拒绝，避免用空串写出全局 alias。
// 这里不返回默认 key，因为任一默认值都会让不同 workspace 意外共享身份。
    if (!workspacePath) throw new Error("workspacePath is required");
    // Bug 原因：alias/ledger 读取后的异步 IO 会让同路径解析交错，返回不同 canonical，
    // 甚至重复搬运配置目录。三个修改入口按规范化路径串行，覆盖读取、提交和连接关闭。
// 读取当前队尾而不是固定队列；尾部任务完成后会被删除，避免 Map 无限增长。
    const previous = this.workspaceOperations.get(workspacePath) ?? Promise.resolve();
    const result = previous.then(() => operation(workspacePath));
    // 失败仍返回给当前调用方；队列继续消费下一项，让其从已提交的 ledger 恢复。
// 队列里存吞掉错误的 settled promise：错误只回传本次调用方，不污染后续任务。
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.workspaceOperations.set(workspacePath, settled);
    try {
// 本次调用的错误原样回传，队列中的 settled 已吞掉错误供后续任务继续。
      return await result;
    } finally {
// 只有自己仍是队尾时才删除，避免误删后续排入的任务。
// 该判断同时防止同一路径在两个微任务间互相覆盖队列项。
      if (this.workspaceOperations.get(workspacePath) === settled) {
        this.workspaceOperations.delete(workspacePath);
      }
    }
  }

// 核心状态机：读 ledger → 校验 session 代际 → 续跑冻结计划 → 否则重新扫描并合并。
  private async resolveCanonicalWorkspaceKeyInternal(
    input: ResolveCanonicalWorkspaceKeyInput,
    options: { ignoreAbandoned?: boolean } = {},
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const { workspacePath } = input;
// 首次启动时 tasks 库目录可能不存在；创建失败留给 open 报出更准确的错误。
    await mkdir(join(this.taskDbPath, ".."), { recursive: true }).catch(() => undefined);
    const taskDb = openDatabase(this.taskDbPath);
    let sessionDb: Database | null = null;
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
// running/failed 且 phase 非空的行仍是 resume owner，必须先于任何重新选主。
      const activeMigration = this.readActiveMigration(taskDb, workspacePath);
// 用 stat 判断而非 open：库不存在时不应落盘空文件，否则会伪造出一个新代际。
      const sessionDatabaseExists = await stat(this.sessionDbPath).then(
        (value) => value.isFile(),
        () => false,
      );
// 计划声称备份过 session 库、实际文件却消失，只能判定代际已变并中止。
      if (activeMigration?.sessionBackupPath && !sessionDatabaseExists) {
        this.failActiveMigration(
          taskDb,
          activeMigration.migrationId,
          WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
        );
        throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
      }
// 库存在才打开；不存在时保持 null，让后续逻辑区分“无库”与“库为空”。
      if (sessionDatabaseExists) {
// 仅当库真实存在才打开；后续所有 session 操作都以 sessionDb 非空为前提。
        sessionDb = openDatabase(this.sessionDbPath);
      }
// 只有计划声明了 session 备份且库已打开，才需要校验代际一致性。
// 没有备份的计划不允许在这里写代际，避免污染未参与合并的库。
      if (activeMigration?.sessionBackupPath && sessionDb) {
// 代际标识用于证明当前库就是备份时那个库，是恢复安全性的核心证据。
        let currentGeneration = this.readSessionDatabaseGeneration(sessionDb);
        if (
          activeMigration.sessionDatabaseGeneration &&
          !currentGeneration &&
          activeMigration.phase === "preflight"
        ) {
// preflight 阶段可按 ledger 中的期望值幂等补写，避免崩溃留下无 owner 的库变更。
          currentGeneration = this.ensureSessionDatabaseGeneration(
            sessionDb,
            activeMigration.sessionDatabaseGeneration,
          );
        }
// 计划未记录代际说明它是旧版本创建的，需要补写或逐行证明可接管。
// 该分支只在存在 session 备份时进入，没有备份的计划不应触碰当前库。
        if (!activeMigration.sessionDatabaseGeneration) {
// preflight 尚未修改任何数据，可直接生成新代际并写回 ledger。
          if (activeMigration.phase === "preflight") {
            currentGeneration = this.ensureSessionDatabaseGeneration(sessionDb);
          } else {
// 越过 preflight 后不能凭空生成代际，必须逐行证明备份内容已被当前库覆盖。
            currentGeneration = await this.adoptLegacySessionDatabaseGeneration(
              sessionDb,
              workspacePath,
              activeMigration,
            );
          }
          if (currentGeneration) {
// 先改内存再持久化，保证后续阶段比较的是同一份期望值。
            activeMigration.sessionDatabaseGeneration = currentGeneration;
            taskDb
              .prepare(
                "UPDATE workspace_migration_ledger SET session_db_generation = ?, updated_at = ? WHERE migration_id = ?",
              )
              .run(currentGeneration, this.now(), activeMigration.migrationId);
          }
        }
        if (
          !activeMigration.sessionDatabaseGeneration ||
          currentGeneration !== activeMigration.sessionDatabaseGeneration
        ) {
          this.failActiveMigration(
            taskDb,
            activeMigration.migrationId,
            WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
          );
          throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
        }
      }
// 冻结计划未包含 session 库，但恢复期间库出现了，需要判断能否安全忽略。
      if (activeMigration && sessionDb && !activeMigration.sessionBackupPath) {
// 若新库已承载本 workspace 的数据，就无法证明可并入旧计划，必须失败。
        if (this.hasSessionDatabaseOwnedState(sessionDb, workspacePath, activeMigration.variants)) {
          // Bug 原因：plan 冻结时没有 session DB，恢复期间新出现的空库不应被误杀；
          // 只有新代际已经承载本 workspace/variant 数据时，才无法证明可安全并入。
          this.failActiveMigration(
            taskDb,
            activeMigration.migrationId,
            WORKSPACE_SESSION_GENERATION_CHANGED_ERROR_CODE,
          );
          throw new SourceServerWorkspaceSessionGenerationChangedError(workspacePath);
        }
        // frozen plan 没有 session backup 且新库不含 owned state：显式排除该 generation，
        // 后续阶段不得依赖“UPDATE 恰好匹配不到行”来维持无副作用。
// 走到这里说明 hasSessionDatabaseOwnedState 为假，排除该代际不会丢已归属数据。
        sessionDb.close();
// 置空而非关闭后继续使用：后续阶段会把它当作“本次不涉及 session 库”。
        sessionDb = null;
      }
      // frozen plan 明确排除的晚到空库保持不变；只接管本次实际参与解析/合并的库。
// 统一走 Agent 的正式迁移建表，避免 Repo 自建表结构与账本分叉。
      if (sessionDb) runSessionDatabaseIdentityMigration(sessionDb);
// 有活动计划时不再扫描活跃度：重新选主会改写 canonical 并产生第二条 ledger。
      if (activeMigration) {
        // Bug 原因：task DB 已提交、session DB 尚未提交时重新扫描活跃度会反向选主，
        // 甚至创建第二条 migration。活动 ledger 是恢复 owner，计划必须原样续跑。
        return await this.runMigrationPlan({
          taskDb,
          sessionDb,
          workspacePath,
// 计划原样续跑，已完成阶段全部跳过，保证备份与已提交数据不被重做。
          migration: activeMigration,
        });
      }
// retry 入口通过 ignoreAbandoned 绕过用户放弃的短路，其余入口必须尊重该决定。
      const abandonedMigration = options.ignoreAbandoned
        ? null
        : this.readLatestAbandonedMigration(taskDb, workspacePath);
// abandoned 是用户冻结的 canonical；直接返回空 mergedKeys，不再触发任何合并。
      if (abandonedMigration) {
        // Bug 原因：放弃合并只写 alias，但旧入口仍因遗留 variant 再次进入 mergeVariants，
        // 于是同一冲突会立刻阻塞重开并创建第二条 ledger。abandoned 是用户明确选择的
        // 冻结 canonical；只有 retryFailedWorkspace 显式清除 abandoned 后才允许重新合并。
// 返回空 mergedKeys 让调用方知道本次没有搬运任何数据。
// 不写 alias：abandon 提交时已写过，重复写只会刷新 updated_at。
// 不清理 failed 标记：abandon 行本身就是用户可见的冻结结果。
        return { canonicalKey: abandonedMigration.canonicalKey, mergedKeys: [] };
      }
// alias 是已发布结果，优先于重新扫描；只有确实存在未归并身份线才继续搬运。
      const existing = taskDb
// 以物理路径为主键查询，一个路径只能有一个 canonical，天然幂等。
        .prepare("SELECT canonical_key FROM workspace_alias WHERE path = ?")
// 查询参数只有物理路径，因此不可能命中别的 workspace 的 alias。
// 返回 undefined 与空串含义不同：前者代表尚未发布，后者代表损坏数据。
// 这里不校验 canonical 是否仍属于 variants，收敛性由后续合并流程保证。
        .get(workspacePath) as { canonical_key: string } | undefined;
// 扫描全部相关表与配置目录，得到当前所有历史身份线，作为后续裁决输入。
      const variants = this.findVariants(taskDb, sessionDb, workspacePath);
// hint 来自旧路由，可能带空白或是空串，统一 trim 后再参与比较与写入。
      const legacyRouteHint = input.legacyRouteHint?.trim();
      if (
        legacyRouteHint &&
        isLegacyRemoteKey(legacyRouteHint) &&
        !variants.includes(legacyRouteHint) &&
// hint 必须证明自己写过数据才允许进入 variants；否则重装客户端会带来脏 key。
// 该探测同时看任务库、会话库与配置目录，任一非空即视为已使用。
// 探测本身只读，失败不会阻止后续分支，但会抛错并由调用方回滚。
        (await this.hasWorkspaceOwnedStateForHint(taskDb, workspacePath, legacyRouteHint))
      ) {
// 只有 hint 确实拥有数据才纳入，避免把陌生 key 拉进本次合并。
// hint 与扫描结果可能重复，前面已用 includes 去重。
        variants.push(legacyRouteHint);
// 排序让 ledger 中的 variants 与扫描结果保持同一顺序，便于审计比对。
        variants.sort();
      }
      if (existing) {
// 过滤后仍保持扫描顺序，具体落库前再排序，避免同一输入产生不同 ledger 内容。
        const mergedKeys = variants.filter((key) => key !== existing.canonical_key);
// 已发布 alias：无新增身份线时不再搬运，直接清理历史 failed 标记。
        if (mergedKeys.length === 0) {
          this.markFailedPathResolved(taskDb, workspacePath);
// alias 已收敛且无新身份线，直接返回既有 canonical。
// 同时清理 failed 标记，避免用户看到已解决的旧冲突。
          return { canonicalKey: existing.canonical_key, mergedKeys: [] };
        }
        return await this.mergeVariants({
          taskDb,
          sessionDb,
          workspacePath,
          canonicalKey: existing.canonical_key,
          variants: [existing.canonical_key, ...mergedKeys],
          mergedKeys,
        });
      }
// 完全无历史：只能采用调用方给的稳定 server identity，不能凭空造 key。
      if (variants.length === 0) {
        const hint = input.legacyRouteHint?.trim();
        // 新 URL Server 没有旧 SSH 路由；仅初次无历史绑定可使用稳定 server identity。
        // 已有 alias 与历史 variants 的裁决顺序保持不变，避免改变 CLI 配置目录。
// 新 URL Server 没有旧 SSH 路由，hint 必须是合法的 remote identity。
// 普通本地路径不能充当 Source Server 的 canonical。
// 抛错而非回退到 workspacePath：后者会把本地身份写进远端表。
        if (!hint || !isRemoteWorkspaceIdentity(hint)) {
// 缺少 hint 属于调用方契约错误；不写 alias，避免把不可恢复的空绑定持久化。
          throw new Error("A legacyRouteHint is required for a new Source Server workspace");
        }
// hint 本身即 canonical，写入后后续入口可直接命中 existing 分支。
        this.writeAlias(taskDb, workspacePath, hint);
        this.markFailedPathResolved(taskDb, workspacePath);
// 首次绑定直接采用 hint 作为 canonical，后续调用都会命中 existing 分支。
// mergedKeys 为空：本次只是建立映射，没有任何历史身份线需要搬运。
// 返回前已清理该路径的 failed 标记，用户不会再看到旧的冲突提示。
        return { canonicalKey: hint, mergedKeys: [] };
      }
// 唯一身份线无需裁决，直接发布 alias 并清理历史 failed 标记。
      if (variants.length === 1) {
// 单元素分支下 variants[0] 必定存在，非空断言仅用于满足类型收窄。
        const canonicalKey = variants[0]!;
        this.writeAlias(taskDb, workspacePath, canonicalKey);
        this.markFailedPathResolved(taskDb, workspacePath);
// 单身份线场景直接返回，mergedKeys 为空表示无需写 ledger 或备份。
// alias 已写入，下一次调用会命中 existing 分支。
        return { canonicalKey, mergedKeys: [] };
      }

// 多身份线按最近活跃度选主，同活跃度用字典序兜底，保证结果可复现。
      const canonicalKey = this.chooseCanonicalKey(taskDb, sessionDb, workspacePath, variants);
      const mergedKeys = variants.filter((key) => key !== canonicalKey);
      return await this.mergeVariants({
        taskDb,
        sessionDb,
        workspacePath,
        canonicalKey,
        variants,
        mergedKeys,
      });
    } finally {
      sessionDb?.close();
      taskDb.close();
    }
  }

// 合并唯一入口：预检冲突、确认配置目录可并、写 frozen ledger，再由计划执行器搬运。
// 每次合并都归属同一 migrationId，禁止绕过 ledger 直接改写 alias。
  private async mergeVariants(input: {
    taskDb: Database;
    sessionDb: Database | null;
    workspacePath: string;
    canonicalKey: string;
    variants: string[];
    mergedKeys: string[];
    followUpDepth?: number;
  }): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const {
      taskDb,
      sessionDb,
      workspacePath,
      canonicalKey,
      variants,
      mergedKeys,
// 递归深度只用于限制新身份线无限出现，不改变 ledger 的冻结内容。
      followUpDepth = 0,
    } = input;
    const identityConflicts = this.findTaskIdentityConflicts(
      taskDb,
      workspacePath,
      canonicalKey,
      mergedKeys,
    );
    if (identityConflicts.length > 0) {
      this.recordTaskIdentityConflicts(taskDb, {
        workspacePath,
        canonicalKey,
        variants,
        conflicts: identityConflicts,
      });
      throw new SourceServerWorkspaceIdentityConflictError(workspacePath);
    }
    try {
      await this.assertSessionConfigDirectoriesMergeable(workspacePath, canonicalKey, mergedKeys);
    } catch (error) {
      if (error instanceof SourceServerWorkspaceConfigConflictError) {
        this.recordConfigConflict(taskDb, {
          workspacePath,
          canonicalKey,
          variants,
          conflict: error,
        });
      }
      throw error;
    }
// migrationId 在写 ledger 前生成：备份目录、冲突行与报告都以它为主键。
// 测试可注入确定性生成器，从而重放同一计划。
    const migrationId = this.createMigrationId();
// 每次尝试独占备份目录，失败重试不会覆盖上一次可恢复的快照。
    const migrationDir = join(this.backupRoot, migrationId);
// 备份文件名固定，恢复时无需解析 ledger 才能定位快照。
    const taskBackupPath = join(migrationDir, "tasks-index.sqlite");
// 无 session 库时写 null：null 与空串在恢复语义中代表完全不同的计划形态。
    const sessionBackupPath = sessionDb ? join(migrationDir, "db.sqlite") : null;
// 先取随机值占位，随后由 ensure 真正写库；内存值与库内值必须一致。
    const sessionDatabaseGeneration = sessionDb
      ? (this.readSessionDatabaseGeneration(sessionDb) ?? randomUUID())
      : null;
// 先落 ledger 再动数据：任何崩溃都能凭这一行判断从哪个阶段继续。
    this.writeLedger(taskDb, {
      migrationId,
      workspacePath,
      canonicalKey,
      variants,
// 初始即 running 且 phase 为 preflight：计划已冻结但尚无任何副作用。
      status: "running",
      taskBackupPath,
      sessionBackupPath,
      sessionDatabaseGeneration,
    });
    try {
// 只有存在 session 库才写代际，task-only 计划不得在该库留下痕迹。
      if (sessionDb && sessionDatabaseGeneration) {
        // 先持久化 frozen ledger，再给 session DB 写 identity；中途崩溃时 preflight
        // resume 可按 ledger 中的期望 generation 幂等补写，不留下无 owner 的数据库变更。
// 幂等写入期望代际，恢复时据此识别当前库是否仍是计划冻结的那一个。
        this.ensureSessionDatabaseGeneration(sessionDb, sessionDatabaseGeneration);
      }
// 钩子在 ledger 提交后触发；抛错会把迁移标 failed，但不回滚已写 ledger。
      await this.afterPhaseCommitted?.("preflight");
    } catch (error) {
      taskDb
        .prepare(
          "UPDATE workspace_migration_ledger SET status = 'failed', error = ?, updated_at = ? WHERE migration_id = ?",
        )
        .run(
          error instanceof Error ? error.message.slice(0, 1_000) : String(error),
          this.now(),
          migrationId,
        );
      throw error;
    }
    return await this.runMigrationPlan({
      taskDb,
      sessionDb,
      workspacePath,
      migration: {
        migrationId,
        canonicalKey,
        variants,
// 内存中的计划也从 preflight 开始，与刚写入的 ledger 保持完全一致。
// 若此处与 writeLedger 的常量不一致，恢复时会把已完成阶段重做一遍。
        phase: "preflight",
        taskBackupPath,
        sessionBackupPath,
        sessionDatabaseGeneration,
      },
// 深度透传给续跑入口，保证恢复路径与首次执行使用同一递归上限。
      followUpDepth,
    });
  }

// 活动计划读取：只看 running/failed 且 phase 非空的行，completed 不再参与恢复。
  private readActiveMigration(
    db: Database,
    workspacePath: string,
  ): ActiveWorkspaceMigration | null {
    const row = db
      .prepare(`
        SELECT migration_id, canonical_key, variant_keys_json, phase,
               task_backup_path, session_backup_path, session_db_generation
        FROM workspace_migration_ledger
        WHERE path = ? AND status IN ('running', 'failed') AND phase IS NOT NULL
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(workspacePath) as
      | {
          migration_id: string;
          canonical_key: string;
          variant_keys_json: string;
          phase: string;
          task_backup_path: string;
          session_backup_path: string | null;
// 代际允许为空：旧计划可能根本不涉及 session 库。
// 读到 null 时调用方不能假定库不存在，仍需按备份路径判断。
          session_db_generation: string | null;
        }
      | undefined;
// 无活动计划返回 null，调用方据此进入重新扫描分支。
    if (!row) return null;
// phase 必须映射到已知阶段，否则视为 ledger 损坏而非空计划。
    const phase = parseMigrationPhase(row.phase);
    let variants: unknown;
    try {
// variants 是冻结快照，解析失败与结构不合法同样按损坏处理。
      variants = JSON.parse(row.variant_keys_json);
    } catch {
// JSON 解析失败时将 variants 置空，由紧随其后的结构校验统一拒绝。
      variants = null;
    }
    if (
      !phase ||
      !Array.isArray(variants) ||
      variants.some((value) => typeof value !== "string") ||
// canonical 必须出现在冻结 variants 中，否则合并会产生计划外的第五条身份线。
      !variants.includes(row.canonical_key)
    ) {
// 校验 canonical 必须属于 variants，否则后续合并会凭空多出一条身份线。
      throw new Error(`Invalid active Source Server migration ledger: ${row.migration_id}`);
    }
    return {
// 内存视图与写回字段一一对应，避免恢复时漏字段导致计划悄悄改变。
      migrationId: row.migration_id,
      canonicalKey: row.canonical_key,
      variants,
      phase,
// 备份路径原样回填，恢复时不再重新推导目录结构。
      taskBackupPath: row.task_backup_path,
      sessionBackupPath: row.session_backup_path,
      sessionDatabaseGeneration: row.session_db_generation,
    };
  }

// 只把最新一条为 abandoned 的记录当作冻结决定，更早的记录已被新尝试覆盖。
  private readLatestAbandonedMigration(
    db: Database,
    workspacePath: string,
  ): { canonicalKey: string } | null {
    const row = db
      .prepare(`
        SELECT canonical_key, status
        FROM workspace_migration_ledger
        WHERE path = ?
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
      .get(workspacePath) as
      | { canonical_key: string; status: "running" | "completed" | "failed" | "abandoned" }
      | undefined;
// 排序键与报告一致：updated_at、created_at、rowid，同一毫秒也能确定唯一最新行。
    return row?.status === "abandoned" ? { canonicalKey: row.canonical_key } : null;
  }

// 失败标记按阶段决定是否释放 resume owner：只有未搬数据的阶段能清空 phase。
  private failActiveMigration(db: Database, migrationId: string, errorCode: string): void {
    // Bug 原因：session generation 异常过去无条件保留 phase，连尚未搬运数据的计划也无法
    // abandon。仅 preflight/backups-created 可安全释放 resume owner；post-merge 继续保留。
    db.prepare(`
      UPDATE workspace_migration_ledger
      SET status = 'failed',
          phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
          error = ?, updated_at = ?
      WHERE migration_id = ?
    `).run(errorCode, this.now(), migrationId);
  }

// 计划执行器只消费冻结 variants，新出现的身份线不会被静默并入本次计划。
  private async runMigrationPlan(input: {
    taskDb: Database;
    sessionDb: Database | null;
    workspacePath: string;
    migration: ActiveWorkspaceMigration;
    followUpDepth?: number;
  }): Promise<ResolveCanonicalWorkspaceKeyResult> {
// 只解构出不可变的计划字段，避免在长流程中误改 input。
// 后续阶段的推进只通过局部 phase 变量与 ledger 提交体现。
    const { taskDb, sessionDb, workspacePath, migration } = input;
// 全部字段取自 ledger 快照，避免执行期间重新扫描导致计划漂移。
    const { migrationId, canonicalKey, variants, taskBackupPath, sessionBackupPath } = migration;
// 首次调用深度为 0；只有增量合并会递增，用于限制递归轮次。
    const followUpDepth = input.followUpDepth ?? 0;
    const mergedKeys = variants.filter((key) => key !== canonicalKey);
// phase 是局部游标：每完成一步就前移，进程崩溃时以最后一次提交为准。
    let phase = migration.phase;
// 增量结果单独收集，最终与原 mergedKeys 去重后返回调用方。
    let followUpMergedKeys: string[] = [];
// completed 计划无需再预检，恢复入口只补写完成状态。
    if (phase !== "completed") {
// 重新扫描只用于发现冻结集合之外的漏网身份线，不会替换原计划。
      const newVariants = this.findVariants(taskDb, sessionDb, workspacePath).filter(
// 只保留冻结集合之外的 key，已在计划内的身份线无需重复报告。
// newVariants 为空表示没有冻结集合外的并发写入，可以安全继续。
        (variant) => !variants.includes(variant),
      );
// task DB 尚未提交时发现新身份线：继续会返回不完整结果，必须显式失败。
      if (newVariants.length > 0 && !hasReachedMigrationPhase(phase, "task-db-merged")) {
        // Bug 原因：resume 只消费 frozen variants，新出现的身份线会被当次迁移遗漏；
        // 继续发布 alias 会返回“已完成”但结果不完整，因此必须保留原计划并显式失败。
        taskDb
          .prepare(
            `UPDATE workspace_migration_ledger
             SET status = 'failed',
                 phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
                 error = ?, updated_at = ?
             WHERE migration_id = ?`,
          )
// 先把 ledger 标成稳定错误码再抛错，报告与异常因此指向同一原因。
// 仅在 task DB 未提交阶段释放 resume owner；已合并的计划必须保留恢复入口。
// 使用固定错误码而非错误消息，避免报告依赖本地化文案。
          .run(WORKSPACE_MIGRATION_PLAN_DIVERGED_ERROR_CODE, this.now(), migrationId);
// 错误携带新 key，便于判断是并发写入还是扫描范围变化。
        throw new SourceServerWorkspaceMigrationPlanDivergedError(workspacePath, newVariants);
      }
      const identityConflicts = this.findTaskIdentityConflicts(
        taskDb,
        workspacePath,
        canonicalKey,
        mergedKeys,
      );
      if (identityConflicts.length > 0) {
        // Bug 原因：首次 preflight 后到恢复前仍可能出现同 taskId 的另一条身份线；旧恢复
        // 直接跳过 preflight，mergeTaskDatabase 只保留冲突 task，却继续 rekey 其余关联表并
        // 最终标 completed，形成不可解释的部分搬运第三态。恢复必须复检并复用原 ledger。
        this.recordTaskIdentityConflicts(taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflicts: identityConflicts,
        });
        throw new SourceServerWorkspaceIdentityConflictError(workspacePath);
      }
      try {
        // Bug 原因：frozen plan 首次 preflight 后仍可能新增配置；恢复若只执行旧计划，
        // DB 已搬完后才在文件移动阶段发现冲突，会留下跨介质的部分迁移。
        await this.assertSessionConfigDirectoriesMergeable(workspacePath, canonicalKey, mergedKeys);
      } catch (error) {
        if (error instanceof SourceServerWorkspaceConfigConflictError) {
          this.recordConfigConflict(taskDb, {
            migrationId,
            workspacePath,
            canonicalKey,
            variants,
            conflict: error,
          });
        }
        throw error;
      }
    }
    taskDb
      .prepare(
// 恢复前先清掉 failed 标记并把状态置 running，表示本进程已接管该计划。
// 该更新在预检之后、备份之前，保证失败时仍能留下可读的接管痕迹。
        "UPDATE workspace_migration_ledger SET status = 'running', error = NULL, updated_at = ? WHERE migration_id = ?",
      )
      .run(this.now(), migrationId);
// completed 写入后进程可能未返回就退出，恢复不能把它降级回 running。
    if (phase === "completed") {
      // Bug 原因：completed phase 写入成功后进程可能在返回前退出；恢复入口不能把它降回 running。
      taskDb
        .prepare(
// completed 计划只补写 status，不重跑任何阶段，避免把完成态降级。
// 这也是崩溃恢复唯一允许对 completed 行执行写操作的地方。
          "UPDATE workspace_migration_ledger SET status = 'completed', error = NULL, updated_at = ? WHERE migration_id = ?",
        )
        .run(this.now(), migrationId);
    }
    try {
// 备份必须早于任何修改；已越过该阶段说明快照已存在且不可覆盖。
      if (!hasReachedMigrationPhase(phase, "backups-created")) {
// 目录权限收紧到 0700：库内含会话与任务内容，不应被同机其他用户读取。
        await mkdir(dirname(taskBackupPath), { recursive: true, mode: 0o700 });
// ensure 语义是已存在即跳过，保证 resume 不重复备份。
        await this.ensureDatabaseBackup(taskDb, taskBackupPath);
// 计划未包含 session 库时跳过该库备份，保持 task-only 计划的形态。
// sessionBackupPath 已声明时 sessionDb 必须已打开，否则属于不一致并抛错。
        if (sessionBackupPath) {
// ledger 声明有 session 备份但库未打开，属于不一致状态，必须中止。
          if (!sessionDb) {
// 用绝对路径报错，便于用户直接定位缺失的库文件。
            throw new Error(`Source Server session database is missing: ${this.sessionDbPath}`);
          }
// 双库备份完成才推进阶段；任一失败都不会留下已备份的错误标记。
          await this.ensureDatabaseBackup(sessionDb, sessionBackupPath);
        }
// 备份阶段提交后，后续 resume 会跳过备份并直接复用已有快照。
// 提交失败则整个计划停在 preflight，重启后会重新尝试备份。
        phase = await this.commitMigrationPhase(taskDb, migrationId, "backups-created");
      }
// task 库合并是一个整体事务，成功后立刻提交阶段，避免重复搬运。
      if (!hasReachedMigrationPhase(phase, "task-db-merged")) {
// 只处理 mergedKeys，canonical 自身数据保持不动。
        this.mergeTaskDatabase(taskDb, workspacePath, canonicalKey, mergedKeys);
// 合并与阶段提交顺序严格：数据提交成功才允许记录阶段。
// 若在这里崩溃，恢复时会重跑本阶段，因此合并本身必须幂等。
        phase = await this.commitMigrationPhase(taskDb, migrationId, "task-db-merged");
      }
// session 库缺失时该步骤退化为 no-op，但阶段仍推进以保持进度单调。
// 已越过该阶段时不重复 UPDATE session 表，避免无意义写锁。
// 阶段判断放在调用前，保证 no-op 分支也不会产生副作用。
      if (!hasReachedMigrationPhase(phase, "session-db-merged")) {
// 只改 workspace_id，不改 directory/path，避免破坏会话的文件定位。
        this.mergeSessionDatabase(sessionDb, workspacePath, canonicalKey, mergedKeys);
// session 合并完成后推进阶段；之后不再重复执行该 UPDATE。
        phase = await this.commitMigrationPhase(taskDb, migrationId, "session-db-merged");
      }
// 配置目录是唯一不可回滚的介质，因此排在两个 DB 都提交之后。
      if (!hasReachedMigrationPhase(phase, "config-dirs-merged")) {
// 合并顺序由 mergedKeys 决定，canonical 目录是唯一保留目标。
        await this.mergeSessionConfigDirectories(workspacePath, canonicalKey, mergedKeys);
// 目录合并不可回滚，提交该阶段即表示文件已不可逆地收敛到 canonical。
        phase = await this.commitMigrationPhase(taskDb, migrationId, "config-dirs-merged");
      }
// alias 最后发布：在它之前任何失败都不会让入口读到半成品映射。
      if (!hasReachedMigrationPhase(phase, "alias-published")) {
        this.writeAlias(taskDb, workspacePath, canonicalKey);
// alias 发布后所有入口都应读到同一 canonical，后续只剩完成态收尾。
        phase = await this.commitMigrationPhase(taskDb, migrationId, "alias-published");
      }
// phase 与 status 在同一次提交内写入，避免完成态出现窗口。
      if (!hasReachedMigrationPhase(phase, "completed")) {
// 阶段提交成功后回调；钩子失败会让本次返回错误，但数据已完整可读。
        phase = await this.commitMigrationPhase(taskDb, migrationId, "completed", "completed");
      }
      this.markFailedPathResolved(taskDb, workspacePath);
// 完成原计划后再扫描一次，捕获 task DB 提交期间并发写入的新身份线。
      followUpMergedKeys = this.findVariants(taskDb, sessionDb, workspacePath).filter(
// 完成后再扫描，canonical 自身不参与增量合并。
// 结果用于决定是否发起 follow-up 迁移，而不是修改当前计划。
        (variant) => variant !== canonicalKey,
      );
    } catch (error) {
      if (
        error instanceof SourceServerWorkspaceIdentityConflictError &&
// 冲突异常自带明细时直接复用，避免二次扫描任务库。
// 审计写入仍走同一事务，报告不会看到半条冲突。
        error.conflicts.length > 0
      ) {
        this.recordTaskIdentityConflicts(taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflicts: error.conflicts,
        });
        throw error;
      }
      if (error instanceof SourceServerWorkspaceConfigConflictError) {
        this.recordConfigConflict(taskDb, {
          migrationId,
          workspacePath,
          canonicalKey,
          variants,
          conflict: error,
        });
        throw error;
      }
      taskDb
        .prepare(
          "UPDATE workspace_migration_ledger SET status = 'failed', error = ?, updated_at = ? WHERE migration_id = ?",
        )
        .run(
          error instanceof Error ? error.message.slice(0, 1_000) : String(error),
          this.now(),
          migrationId,
        );
      throw error;
    }
// 新身份线不能塞回已完成的 ledger，另起一次迁移才能保持两次事务可审计。
    if (followUpMergedKeys.length > 0) {
// 达到上限说明身份线仍在增长，继续递归只会拖住打开流程。
      if (followUpDepth >= MAX_FOLLOW_UP_MIGRATIONS) {
        throw new SourceServerWorkspaceMigrationPlanDivergedError(
          workspacePath,
          followUpMergedKeys,
        );
      }
      // Bug 原因：task DB 已提交后出现的新 variant 不能清 phase/abandon，也不能让 frozen
      // plan 永久重抛。先完成原计划，再用独立 ledger/备份做增量合并，保持两次事务可审计。
// 增量计划以 canonical 加新 key 为 variants，重用同一套预检与备份流程。
      const followUp = await this.mergeVariants({
        taskDb,
        sessionDb,
        workspacePath,
        canonicalKey,
        variants: [canonicalKey, ...followUpMergedKeys],
        mergedKeys: followUpMergedKeys,
// followUpDepth 加一后透传，多轮增量仍受同一上限约束。
        followUpDepth: followUpDepth + 1,
      });
      return {
// 增量合并的 migrationId 覆盖原计划，调用方记录的是最后一次尝试。
        ...followUp,
// 去重后合并，调用方看到本路径累计被改写的全部身份线。
        mergedKeys: [...new Set([...mergedKeys, ...followUp.mergedKeys])],
      };
    }
// 首次执行返回新 migrationId，恢复路径的返回值由外层决定是否透出。
    return { canonicalKey, mergedKeys, migrationId };
  }

// session 库合并按身份线与物理路径双条件定位，防止误改同线但不同路径的会话。
  private mergeSessionDatabase(
    sessionDb: Database | null,
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): void {
// 缺 sessionDb、缺 session 表或 mergedKeys 为空时直接返回，不制造空事务。
    if (!sessionDb || !hasTable(sessionDb, "session") || mergedKeys.length === 0) return;
// 占位符按 key 数量动态生成，key 值始终参数绑定，不拼进 SQL 文本。
    const placeholders = mergedKeys.map(() => "?").join(", ");
// IMMEDIATE 立即取写锁，避免先读后写时被 CLI 插入新行破坏条件。
    sessionDb.exec("BEGIN IMMEDIATE");
    try {
      sessionDb
        .prepare(
          `UPDATE session SET workspace_id = ?
             WHERE workspace_id IN (${placeholders})
               AND (directory = ? OR path = ?)`,
        )
// directory 与 path 任一等于物理路径都视为归属，兼容两代 schema。
        .run(canonicalKey, ...mergedKeys, workspacePath, workspacePath);
// 单条 UPDATE 提交；失败走 rollbackQuietly，错误向上抛给阶段执行器。
      sessionDb.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(sessionDb);
      throw error;
    }
  }

// 判断新库是否已承载本 workspace 数据，这是能否安全忽略该库的唯一依据。
  private hasSessionDatabaseOwnedState(
    db: Database,
    workspacePath: string,
    variants: string[],
  ): boolean {
// session 与 sessions 两代表名都要探测，历史库可能只建了其中一张。
    for (const table of ["session", "sessions"]) {
      if (!hasTable(db, table)) continue;
// 按优先级取第一个存在的身份列，避免同一表多列时产生重复谓词。
      const workspaceColumn = ["workspace_id", "workspace_key", "workspace_identity"].find(
        (column) => hasColumn(db, table, column),
      );
// 路径列可能同时存在，全部纳入 OR 条件，宁可多查也不漏判归属。
      const pathColumns = ["directory", "path", "workspace_path"].filter((column) =>
        hasColumn(db, table, column),
      );
// 谓词与参数同步累积，保证 prepare 与 get 的绑定顺序一致。
      const predicates: string[] = [];
      const values: string[] = [];
// 身份列条件与路径列条件之间是 OR：任一命中都算该 workspace 拥有数据。
      if (workspaceColumn && variants.length > 0) {
// 身份列用 IN 匹配全部 variants，参数数量与 key 数一致。
        predicates.push(`${workspaceColumn} IN (${variants.map(() => "?").join(", ")})`);
        values.push(...variants);
      }
// 每个路径列一条等值条件，值统一是物理路径。
      for (const column of pathColumns) {
        predicates.push(`${column} = ?`);
        values.push(workspacePath);
      }
      if (
        predicates.length > 0 &&
        db.prepare(`SELECT 1 FROM ${table} WHERE ${predicates.join(" OR ")} LIMIT 1`).get(...values)
      ) {
        return true;
      }
    }
    return false;
  }

// 代际读取只认 scope = session 的一行；空串按缺失处理。
  private readSessionDatabaseGeneration(db: Database): string | null {
// 旧库没有身份表属于正常状态，由调用方决定补写还是拒绝。
    if (!hasTable(db, "zcode_database_identity")) return null;
    const row = db
      .prepare("SELECT identity FROM zcode_database_identity WHERE scope = 'session' LIMIT 1")
      .get() as { identity: string } | undefined;
// trim 后为空视为无代际，避免把空白串当成有效证据。
    return row?.identity?.trim() || null;
  }

// 旧计划没记录代际：只能逐行比对备份与当前库，证明备份已被覆盖后才接管。
  private async adoptLegacySessionDatabaseGeneration(
    currentDb: Database,
    workspacePath: string,
    migration: ActiveWorkspaceMigration,
  ): Promise<string | null> {
// 备份文件不存在时无法证明任何事，直接返回 null 让上层判定代际异常。
    if (!migration.sessionBackupPath || !(await this.pathExists(migration.sessionBackupPath))) {
      return null;
    }
// 只读比较也走正常 open，复用 busy_timeout 与一致的表探测逻辑。
    const backupDb = openDatabase(migration.sessionBackupPath);
    try {
// 两边都无 session 表说明备份没有业务数据，可以共用同一新代际。
      if (!hasTable(backupDb, "session") || !hasTable(currentDb, "session")) {
        return !hasTable(backupDb, "session") && !hasTable(currentDb, "session")
          ? this.persistAdoptedSessionGeneration(currentDb, backupDb)
          : null;
      }
// 读取备份的全部会话行作为基准，包含时间戳用于检测后续写入。
      const backupRows = backupDb
        .prepare("SELECT id, workspace_id, directory, path, time_updated FROM session")
        .all() as unknown as Array<{
        id: string;
        workspace_id: string | null;
        directory: string;
        path: string | null;
        time_updated: number;
      }>;
// 备份为空：只要当前库没有本 workspace 的 owned state，就认为两者等价。
      if (backupRows.length === 0) {
        return this.hasSessionDatabaseOwnedState(currentDb, workspacePath, migration.variants)
          ? null
          : this.persistAdoptedSessionGeneration(currentDb, backupDb);
      }
// 预编译按 id 查询，逐行比对，避免把当前库全部会话读入内存。
      const findCurrent = currentDb.prepare(
        "SELECT workspace_id, directory, path, time_updated FROM session WHERE id = ?",
      );
// 已越过 session-db-merged 时，备份中的旧 workspace_id 应已改写成 canonical。
      const mergedKeys = new Set(
        migration.variants.filter((variant) => variant !== migration.canonicalKey),
      );
// 任何一行不满足预期都返回 null：宁可拒绝接管，也不能猜测备份仍有效。
      for (const row of backupRows) {
        const current = findCurrent.get(row.id) as
          | {
              workspace_id: string | null;
              directory: string;
              path: string | null;
              time_updated: number;
            }
          | undefined;
// 只有属于本路径的行才允许出现 workspace_id 改写，其他行必须原样保留。
        const belongsToWorkspace = row.directory === workspacePath || row.path === workspacePath;
// 预期值随阶段变化：已合并时旧 workspace_id 应变成 canonical。
// 未合并或行不属于本路径时，workspace_id 必须原样保留。
        const expectedWorkspaceId =
// 三个条件同时成立才允许改写，避免把其他路径的会话误判为已合并。
          belongsToWorkspace &&
          hasReachedMigrationPhase(migration.phase, "session-db-merged") &&
          row.workspace_id &&
          mergedKeys.has(row.workspace_id)
            ? migration.canonicalKey
            : row.workspace_id;
        if (
          !current ||
// 当前库的 workspace_id 必须已是预期值，否则说明备份后又被改写。
// 任一字段不一致都返回 null，拒绝接管而不是部分接受。
          current.workspace_id !== expectedWorkspaceId ||
          current.directory !== row.directory ||
          current.path !== row.path ||
// 当前行比备份旧说明备份后仍有写入，备份不能代表当前库。
          current.time_updated < row.time_updated
        ) {
          return null;
        }
      }
// 全部行校验通过才写代际，两库写同一值以保证后续比较一致。
      return this.persistAdoptedSessionGeneration(currentDb, backupDb);
    } finally {
// 无论校验成功与否都关闭备份连接，避免 Windows 下快照文件被长期占用。
// 关闭发生在返回或抛错之后，不影响已得出的接管结论。
      backupDb.close();
    }
  }

// 两个库写同一随机代际：任一侧被替换都会在下一次比较中暴露。
  private persistAdoptedSessionGeneration(currentDb: Database, backupDb: Database): string {
// 一次接管只生成一个代际，两个库共用才能证明它们来自同一次快照。
// 用随机值而非时间戳，避免同毫秒多次迁移产生相同标识。
    const identity = randomUUID();
// 先写备份库：备份是证据，证据先具备代际才允许当前库引用同一值。
    this.ensureSessionDatabaseGeneration(backupDb, identity);
    return this.ensureSessionDatabaseGeneration(currentDb, identity);
  }

// 已有代际时优先返回库内值，传入的期望值只在首次写入时生效。
  private ensureSessionDatabaseGeneration(db: Database, identity: string = randomUUID()): string {
    // 修复原因：Repo 曾直接建表，绕过 Agent 的正式账本；复用同一 migration 接管存量表。
// 建表与补列统一交给 Agent 的迁移账本，Repo 不重复定义 schema。
    runSessionDatabaseIdentityMigration(db);
// 先读后写，保证并发首次初始化时不会覆盖已落盘的代际。
    const existing = this.readSessionDatabaseGeneration(db);
// 已有代际直接复用，保证同一库在多次迁移中保持稳定标识。
// 不校验传入 identity 与库内值是否相同，调用方应先读后决定。
    if (existing) return existing;
// 单行插入而非 upsert：已有行时前面的读已拦截，此处只处理首次初始化。
    db.prepare("INSERT INTO zcode_database_identity (scope, identity) VALUES ('session', ?)").run(
// 插入参数就是刚生成的代际，写库后即成为后续比较的唯一依据。
      identity,
    );
// 返回实际写入值，调用方据此更新 ledger 而不是回读。
    return identity;
  }

// 阶段提交 = 更新 ledger + 触发钩子，顺序固定，钩子看不到未提交阶段。
  private async commitMigrationPhase(
    db: Database,
    migrationId: string,
    phase: WorkspaceMigrationPhase,
    status: "running" | "completed" = "running",
  ): Promise<WorkspaceMigrationPhase> {
    db.prepare(
// 阶段推进同时清空 error：上一步的失败信息不应残留在成功阶段上。
// WHERE 只按 migrationId 定位，保证不会误改同路径的其他计划。
      "UPDATE workspace_migration_ledger SET phase = ?, status = ?, error = NULL, updated_at = ? WHERE migration_id = ?",
    ).run(phase, status, this.now(), migrationId);
// 钩子异常不吞掉，交由上层标 failed 并保留已提交的阶段信息。
    await this.afterPhaseCommitted?.(phase);
    return phase;
  }

// 目录名由 hash(路径, 身份线) 决定，换 canonical 必然换目录，合并即搬目录。
  private getSessionConfigDirectory(workspacePath: string, workspaceKey: string): string {
    return join(
      dirname(this.taskDbPath),
      "sessions",
// 入参顺序不可交换，必须与 CLI 侧构造保持完全一致。
      getWorkspaceHash(workspacePath, workspaceKey),
    );
  }

// 预检只读不写：把冲突提前到备份之前，避免搬到一半才发现内容不同。
  private async assertSessionConfigDirectoriesMergeable(
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): Promise<void> {
// seen 以相对路径为键累积首个来源，后续来源只需与之比较。
    const seen = new Map<
      string,
      ({ kind: "directory" } | { kind: "file"; content: Buffer }) & { workspaceKey: string }
    >();
// canonical 目录作为基准先入 seen，合并方向因此固定为向 canonical 收敛。
    for (const workspaceKey of [canonicalKey, ...mergedKeys]) {
      const entries = await this.readSessionConfigEntries(
        this.getSessionConfigDirectory(workspacePath, workspaceKey),
      );
// 遍历整棵子树，空目录也产生一条记录以参与结构比较。
      for (const [relativePath, entry] of entries) {
// relativePath 首次出现直接登记，预检阶段不复制内容、保持零副作用。
        const existing = seen.get(relativePath);
        if (!existing) {
// workspaceKey 记录首个来源，冲突时用于指出是哪条身份线先写入了该路径。
          seen.set(relativePath, { ...entry, workspaceKey });
          continue;
        }
// 类型必须一致：目录与文件同名即冲突，不能靠覆盖解决。
        const matches =
          existing.kind === entry.kind &&
          (existing.kind === "directory" ||
// 目录只需类型一致；文件要求逐字节相同，避免二进制配置被文本比较误判。
            (entry.kind === "file" && existing.content.equals(entry.content)));
// 结构或内容任一不一致即冲突，错误中携带相对路径与首个来源 key。
// 冲突在预检阶段抛出，此时尚未备份或搬移任何文件。
        if (!matches) {
          throw new SourceServerWorkspaceConfigConflictError(
            workspacePath,
            relativePath,
            workspaceKey,
          );
        }
      }
    }
  }

// 递归读取目录，用相对路径作为跨来源比较的稳定键。
  private async readSessionConfigEntries(
    root: string,
    relativeRoot = "",
  ): Promise<SessionConfigEntries> {
// 以相对路径为键，保证不同来源的同名文件能直接命中比较。
    const result: SessionConfigEntries = new Map();
    if (!(await this.pathExists(root))) return result;
// withFileTypes 省掉逐条 stat，减少合并期间的 IO 次数。
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
// 绝对路径只用于读取内容，不写入任何持久化结构。
      const absolutePath = join(root, entry.name);
// 目录自身与子树都要登记，否则空目录会在合并时被静默丢掉。
      if (entry.isDirectory()) {
// 目录先登记自身再递归子项；相对路径统一用正斜杠以保证跨平台键一致。
        result.set(relativePath, { kind: "directory" });
// 递归结果并入同一 Map，调用方无需感知层级。
        const nested = await this.readSessionConfigEntries(absolutePath, relativePath);
        for (const item of nested) result.set(...item);
        continue;
      }
// 文件内容整块读入内存：配置目录通常很小，换取简单可靠的内容比较。
      if (entry.isFile()) {
// 读失败按冲突抛出：无法比较内容的文件不能参与合并。
        result.set(relativePath, { kind: "file", content: await readFile(absolutePath) });
        continue;
      }
// 非文件非目录条目（如符号链接）无法可靠比较，直接按冲突拒绝。
      throw new SourceServerWorkspaceConfigConflictError(root, relativePath, root);
    }
    return result;
  }

// 并行读取各身份线快照，为 abandon 时的活跃度基线提供一致输入。
  private async readVariantConfigSnapshots(
    workspacePath: string,
    variants: string[],
  ): Promise<Map<string, SessionConfigEntries>> {
// Map 的键顺序与 variants 一致，便于冲突报告按身份线顺序展示。
    return new Map(
// 并发只发生在不同 variant 之间，单个目录内部仍是顺序递归。
      await Promise.all(
// 每个 variant 一个读取任务，结果按原顺序组成 Map 条目。
        variants.map(
          async (variant) =>
            [
              variant,
// 每个 variant 的目录独立读取，互不共享 Map，避免跨身份线串数据。
              await this.readSessionConfigEntries(
                this.getSessionConfigDirectory(workspacePath, variant),
              ),
// as const 让元组推断为 [string, SessionConfigEntries]，Map 构造无需再标注。
            ] as const,
        ),
      ),
    );
  }

// 目标目录不存在则整体 rename，存在则逐项合并后删除来源目录。
  private async mergeSessionConfigDirectories(
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): Promise<void> {
// canonical 目录是唯一保留目标，所有来源最终都收敛到它。
    const canonicalDir = this.getSessionConfigDirectory(workspacePath, canonicalKey);
    for (const sourceKey of mergedKeys) {
      const sourceDir = this.getSessionConfigDirectory(workspacePath, sourceKey);
// 来源目录不存在属于正常：该身份线可能从未写过配置。
      if (sourceDir === canonicalDir || !(await this.pathExists(sourceDir))) continue;
// 目标目录首次出现时整体 rename，是最快且无冲突的路径。
      if (!(await this.pathExists(canonicalDir))) {
        await mkdir(dirname(canonicalDir), { recursive: true });
// 原子 rename 避免先拷贝再删除造成的中间态。
        await rename(sourceDir, canonicalDir);
        continue;
      }
      await this.mergeSessionConfigDirectoryContents({
        sourceDir,
        canonicalDir,
        workspacePath,
        sourceKey,
      });
// force 允许目录在内层合并后已为空或已消失，避免误报错误。
      await rm(sourceDir, { recursive: true, force: true });
    }
  }

// 逐项递归：目录下钻，文件要求内容完全一致后才删除来源。
  private async mergeSessionConfigDirectoryContents(input: {
    sourceDir: string;
    canonicalDir: string;
    workspacePath: string;
    sourceKey: string;
    relativeRoot?: string;
  }): Promise<void> {
// relativeRoot 只在递归时非空，用于拼接冲突报告中的相对路径。
    const { sourceDir, canonicalDir, workspacePath, sourceKey, relativeRoot = "" } = input;
// 目标目录可能仍不存在，这里补齐并接受已存在。
    await mkdir(canonicalDir, { recursive: true });
// 顺序遍历来源目录；先取 dirent，避免每个条目再 stat 一次。
    const entries = await readdir(sourceDir, { withFileTypes: true });
    for (const entry of entries) {
// 来源与目标都按条目名拼接，保证 rename 的是同一相对位置。
      const sourcePath = join(sourceDir, entry.name);
// 目标路径由目标目录加同名条目组成，是合并的唯一落点。
      const canonicalPath = join(canonicalDir, entry.name);
      const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
// stat 失败一律视为不存在，交由后续 rename 决定成败。
      const canonicalStat = await stat(canonicalPath).catch(() => null);
// 目标缺失即可直接搬运，这是唯一无冲突的快路径。
      if (!canonicalStat) {
// rename 保持 inode 与权限不变，避免复制带来的元数据丢失。
        await rename(sourcePath, canonicalPath);
        continue;
      }
// 两侧都是目录时递归合并，子项冲突规则与顶层一致。
      if (entry.isDirectory() && canonicalStat.isDirectory()) {
        await this.mergeSessionConfigDirectoryContents({
          sourceDir: sourcePath,
          canonicalDir: canonicalPath,
          workspacePath,
          sourceKey,
          relativeRoot: relativePath,
        });
        await rm(sourcePath, { recursive: true, force: true });
        continue;
      }
// 只有两侧都是文件才做内容比较；目录与文件同名已在上层判为冲突。
      if (entry.isFile() && canonicalStat.isFile()) {
// 同时读两侧内容，比较结果只用于判定来源是否可删。
        const [sourceContent, canonicalContent] = await Promise.all([
          readFile(sourcePath),
          readFile(canonicalPath),
        ]);
// 内容不同即冲突：静默覆盖会让用户丢失其中一侧的配置。
        if (!sourceContent.equals(canonicalContent)) {
          throw new SourceServerWorkspaceConfigConflictError(
            workspacePath,
            relativePath,
            sourceKey,
          );
        }
// 内容一致后删除来源文件，force 允许并发清理导致的已不存在。
// 删除发生在比较之后，绝不能先删再比。
        await rm(sourcePath, { force: true });
        continue;
      }
      throw new SourceServerWorkspaceConfigConflictError(workspacePath, relativePath, sourceKey);
    }
  }

// 只关心存在性，不区分文件与目录；stat 错误一律折叠为 false。
  private async pathExists(path: string): Promise<boolean> {
    return await stat(path).then(
      () => true,
      () => false,
    );
  }

// 先写 .tmp 再 rename，避免崩溃后留下看起来完整的半截快照。
  private async ensureDatabaseBackup(db: Database, backupPath: string): Promise<void> {
// 已存在即认为备份完成，resume 不需要校验内容。
    if (await this.pathExists(backupPath)) return;
// tmp 与目标同目录，保证 rename 在同一文件系统内原子完成。
    const temporaryPath = `${backupPath}.tmp`;
    await rm(temporaryPath, { force: true });
    await backup(db, temporaryPath);
// rename 成功才出现正式文件，读取方永远不会看到写一半的库。
    await rename(temporaryPath, backupPath);
  }

// 报告只统计每个路径最新一条 ledger：旧的 failed 已被后续尝试覆盖，不应重复提示。
// 用 (updated_at, created_at, rowid) 三元组比较，避免同毫秒写入时选错最新行。
// 只读打开 task 库并跑迁移，保证 UI 查询不会因缺表而崩溃。
  public async getFailedPathCount(): Promise<number> {
    const taskDb = openDatabase(this.taskDbPath);
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const row = taskDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_migration_ledger current
           WHERE current.status = 'failed'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_migration_ledger newer
               WHERE newer.path = current.path
                 AND (newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at
                     AND (newer.created_at > current.created_at
                       OR (newer.created_at = current.created_at
                         AND newer.rowid > current.rowid))))
             )`,
        )
        .get() as { count: number };
      return row.count;
    } finally {
      taskDb.close();
    }
  }

// 与 failed 计数同构，只是状态换成 abandoned，两处必须保持同样的最新行判定。
// 单独方法而非参数化，避免调用方传错状态字符串导致统计口径漂移。
  public async getAbandonedPathCount(): Promise<number> {
    const taskDb = openDatabase(this.taskDbPath);
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
      const row = taskDb
        .prepare(
          `SELECT COUNT(*) AS count
           FROM workspace_migration_ledger current
           WHERE current.status = 'abandoned'
             AND NOT EXISTS (
               SELECT 1 FROM workspace_migration_ledger newer
               WHERE newer.path = current.path
                 AND (newer.updated_at > current.updated_at
                   OR (newer.updated_at = current.updated_at
                     AND (newer.created_at > current.created_at
                       OR (newer.created_at = current.created_at
                         AND newer.rowid > current.rowid))))
             )`,
        )
        .get() as { count: number };
      return row.count;
    } finally {
      taskDb.close();
    }
  }

// 报告同时读双库：task 库存 ledger 与冲突，session 库用于重算 abandoned 基线。
// session 库不存在时按 null 处理，报告仍可展示 task 侧审计。
// 排序与活动计划读取一致，保证最新一条在两处指同一行。
  public async listMigrationReports(): Promise<SourceServerMigrationReport> {
    const taskDb = openDatabase(this.taskDbPath);
    const sessionDb = await stat(this.sessionDbPath).then(
      (value) => (value.isFile() ? openDatabase(this.sessionDbPath) : null),
      () => null,
    );
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
// 一次性取出全部 ledger 供 UI 展示历史；数量级是迁移次数，可接受全量读取。
      const ledgerRows = taskDb
        .prepare(`
          SELECT migration_id, path, canonical_key, variant_keys_json, status, phase,
                 task_backup_path, session_backup_path, error, updated_at,
                 abandoned_at, abandoned_trigger, abandoned_activity_json
          FROM workspace_migration_ledger
          ORDER BY updated_at DESC, created_at DESC, rowid DESC
        `)
        .all() as unknown as Array<{
        migration_id: string;
        path: string;
        canonical_key: string;
        variant_keys_json: string;
        status: "running" | "completed" | "failed" | "abandoned";
        phase: string | null;
        task_backup_path: string;
        session_backup_path: string | null;
        error: string | null;
        updated_at: number;
// 放弃时间只对 abandoned 行有值，其余状态为 null。
// abandoned_at 只对 abandoned 行有值，报告据此判断是否重算活跃度基线。
        abandoned_at: number | null;
        abandoned_trigger: string | null;
        abandoned_activity_json: string | null;
      }>;
// 冲突按 migrationId 预编译查询，避免逐行 prepare 造成 N+1 开销。
// 排序固定 kind/key/source，保证同一迁移的报告顺序稳定。
      const readConflicts = taskDb.prepare(`
        SELECT conflict_kind, conflict_key, task_id, relative_path, source_key,
               canonical_key, reason
        FROM workspace_migration_conflicts
        WHERE migration_id = ?
        ORDER BY conflict_kind, conflict_key, source_key
      `);
// 按 ledger 顺序逐行 push，最终顺序即 updated_at 降序，调用方无需再排。
      const rows: SourceServerMigrationReportRow[] = [];
// 逐行组装：abandoned 行要先重算活跃度，才能判断是否已 diverged。
// 其余状态直接透传，报告层不再做二次状态推断。
      for (const ledger of ledgerRows) {
        const variantKeys = this.parseVariantKeys(ledger.variant_keys_json);
// 默认沿用 ledger 状态，只有 abandoned 且基线存在时才可能升级为 diverged。
        let status: SourceServerMigrationReportRow["status"] = ledger.status;
// 只有 abandoned 且写过基线才需要重算；variant JSON 损坏会退化为空数组。
        if (ledger.status === "abandoned" && ledger.abandoned_activity_json) {
// 基线自带算法版本，重算必须用同一版本，否则升级本身会被误判成分叉。
          const baseline = this.parseAbandonedActivity(ledger.abandoned_activity_json);
// 只比较非 canonical 身份线：canonical 的活动属于保留方，不构成放弃后的变化。
          const current = await this.computeVariantActivityDigests(
            taskDb,
            sessionDb,
            ledger.path,
// canonical 的活跃度不属于放弃范围，只重算被放弃的身份线。
            variantKeys.filter((key) => key !== ledger.canonical_key),
            baseline.version,
          );
// 键已排序且摘要固定，字符串比较即可；任一 variant 变化都视为 diverged。
          if (JSON.stringify(current) !== JSON.stringify(baseline.digests)) {
            status = "abandoned-diverged";
          }
        }
// 冲突行与 ledger 一起返回，UI 无需再次打开数据库。
        const conflicts = readConflicts.all(ledger.migration_id) as unknown as Array<{
          conflict_kind: "task-identity" | "config-file";
          conflict_key: string;
          task_id: string | null;
          relative_path: string | null;
          source_key: string;
          canonical_key: string;
          reason: string;
        }>;
// 可选字段用条件展开：协议层要求缺失即不出现该键，而不是出现 undefined。
        rows.push({
// migrationId 是报告行与冲突明细的关联键，必须原样透出。
// 前端据此发起 retry/abandon，不能改写或截断。
          migrationId: ledger.migration_id,
// 报告以物理路径标识 workspace，与 alias 主键保持一致。
          workspacePath: ledger.path,
// canonicalKey 是计划冻结时选定的目标，即使后续 diverged 也保留原值。
          canonicalKey: ledger.canonical_key,
// variantKeys 含被合并的全部身份线，用于展示本次迁移的影响范围。
          variantKeys,
// status 可能被 upgraded 成 diverged，因此不能直接用 ledger.status。
          status,
// phase 为 null 表示计划已不可恢复，省略该键以免被误读为可续跑。
          ...(ledger.phase ? { phase: ledger.phase } : {}),
// errorCode 只存稳定错误码，详细错误文本不落库，避免审计表随消息膨胀。
          ...(ledger.error ? { errorCode: ledger.error } : {}),
// 备份路径可空：冲突审计行没有快照，省略该键避免 UI 展示空路径。
          ...(ledger.task_backup_path ? { taskBackupPath: ledger.task_backup_path } : {}),
// session 备份只在双库计划中出现，缺失即表示本次不涉及该库。
          ...(ledger.session_backup_path ? { sessionBackupPath: ledger.session_backup_path } : {}),
// updatedAt 必填，UI 用它排序并判断报告新鲜度。
          updatedAt: ledger.updated_at,
// 放弃时间只在 abandoned 行存在，用非空判断而不是真假值。
          ...(ledger.abandoned_at !== null ? { abandonedAt: ledger.abandoned_at } : {}),
// trigger 目前只有 user，保留字段便于未来区分自动放弃。
          ...(ledger.abandoned_trigger ? { abandonedTrigger: ledger.abandoned_trigger } : {}),
// 冲突字段同样条件展开：taskId 只属于身份冲突，relativePath 只属于配置冲突。
          conflicts: conflicts.map((conflict) => ({
// 冲突类型直接复用库内枚举，UI 据此分组为任务冲突与配置冲突。
            kind: conflict.conflict_kind,
// key 对身份冲突是 taskId，对配置冲突是相对路径。
            key: conflict.conflict_key,
// taskId 只属于身份冲突行，配置冲突必须省略该键。
            ...(conflict.task_id ? { taskId: conflict.task_id } : {}),
// relativePath 只属于配置冲突行，用非空判断避免空串占位。
            ...(conflict.relative_path ? { relativePath: conflict.relative_path } : {}),
// sourceKey 指向冲突来源身份线，帮助用户判断该放弃哪一侧。
            sourceKey: conflict.source_key,
// canonicalKey 记录冲突发生时计划选定的目标身份线，便于事后复核。
            canonicalKey: conflict.canonical_key,
// reason 原样透传库内稳定错误码，前端据此选择文案与操作入口。
            reason: conflict.reason,
          })),
        });
      }
// 顶层包一层 rows，便于未来追加版本号或统计字段而不破坏调用方。
      return { rows };
    } finally {
      sessionDb?.close();
      taskDb.close();
    }
  }

// 放弃是用户显式决策，必须经过同路径串行化，避免与正在恢复的迁移交错。
// migrationId 可选：不传时放弃该路径最新一条 failed 记录。
  public async abandonFailedWorkspace(workspacePath: string, migrationId?: string): Promise<void> {
    return await this.runWorkspaceOperation(workspacePath, (normalizedPath) =>
      this.abandonFailedWorkspaceInternal(normalizedPath, migrationId),
    );
  }

// 只允许放弃 phase 为空的 failed 行：phase 非空说明它仍是 crash resume owner。
// 放弃不删除 taskBackupPath 与 sessionBackupPath，保留后续人工取证入口。
  private async abandonFailedWorkspaceInternal(
    workspacePath: string,
    migrationId?: string,
  ): Promise<void> {
    const taskDb = openDatabase(this.taskDbPath);
    const sessionDb = await stat(this.sessionDbPath).then(
      (value) => (value.isFile() ? openDatabase(this.sessionDbPath) : null),
      () => null,
    );
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
// 取最新 failed 行；带 migrationId 时精确定位，避免误放弃用户刚重试的新计划。
      const ledger = taskDb
        .prepare(`
          SELECT migration_id, canonical_key, variant_keys_json, phase
          FROM workspace_migration_ledger
          WHERE path = ? AND status = 'failed'
            ${migrationId ? "AND migration_id = ?" : ""}
          ORDER BY updated_at DESC, created_at DESC, rowid DESC
          LIMIT 1
        `)
        .get(workspacePath, ...(migrationId ? [migrationId] : [])) as
        | {
            migration_id: string;
            canonical_key: string;
            variant_keys_json: string;
            phase: string | null;
          }
        | undefined;
// 无 failed 行属于调用方状态错误，直接抛出不写任何审计。
      if (!ledger) throw new Error(`No failed Source Server migration for path: ${workspacePath}`);
// phase 非空代表可 resume，abandon 会销毁恢复所需信息，必须拒绝。
      if (ledger.phase !== null) {
        // phase 非空的 failed ledger 仍是 crash resume owner，不能被 abandon 销毁。
        throw new Error(`Source Server resumable migration cannot be abandoned: ${workspacePath}`);
      }
      const variantKeys = this.parseVariantKeys(ledger.variant_keys_json);
// 只对非 canonical 身份线取基线，canonical 的后续活动不属于放弃范围。
      const abandonedVariants = variantKeys.filter((key) => key !== ledger.canonical_key);
// 配置快照在加写锁前并行读取，避免大目录延长 task 库写锁持有时间。
// 拿到快照后再进入事务，保证写锁内只剩纯内存与 SQL 操作。
      const configSnapshots = await this.readVariantConfigSnapshots(
        workspacePath,
        abandonedVariants,
      );
      const now = this.now();
      taskDb.exec("BEGIN IMMEDIATE");
      try {
        // 配置 IO 期间其他进程可能已完成或换了计划；取得写锁后复查，避免旧 abandon
        // 覆盖新 ledger/alias。updated_at 可在同一毫秒内重复，必须比较状态与冻结计划本身。
        const current = taskDb
          .prepare(`
          SELECT canonical_key, variant_keys_json
          FROM workspace_migration_ledger
          WHERE migration_id = ? AND path = ? AND status = 'failed' AND phase IS NULL
        `)
          .get(ledger.migration_id, workspacePath) as
          | { canonical_key: string; variant_keys_json: string }
          | undefined;
        if (
          !current ||
// 复查条件同时包含状态、phase 与冻结计划；只比 updated_at 会被同毫秒写入绕过。
          current.canonical_key !== ledger.canonical_key ||
          current.variant_keys_json !== ledger.variant_keys_json
        ) {
// retryable 标记用于区分并发冲突与业务拒绝，调用方可据此自动重试一次。
          throw Object.assign(
            new Error(`Source Server migration changed during abandon: ${workspacePath}`),
            { retryable: true },
          );
        }
// session 用普通 BEGIN 固定读快照：本操作只读该库，不需要写锁。
        sessionDb?.exec("BEGIN");
        taskDb
          .prepare(`
          UPDATE workspace_migration_ledger
          SET status = 'abandoned', phase = NULL, abandoned_at = ?,
              abandoned_trigger = 'user', abandoned_activity_json = NULL, updated_at = ?
          WHERE migration_id = ?
        `)
          .run(now, now, ledger.migration_id);
// abandon 同时发布 alias，确保旧入口不会再因遗留 variant 触发合并。
        this.writeAlias(taskDb, workspacePath, ledger.canonical_key);
        // Bug 原因：旧实现先算 digest 再开启 ledger 事务，事务触发器/并发 task 写入会在
        // abandoned 提交前落盘，却被误判成“放弃后的 divergence”。先提交逻辑状态，再在
        // 同一未提交事务的最终视图上取 DB 基线；session DB 用读事务固定同一轮快照。
        // config 文件已在加写锁前并行读取，避免目录大小直接延长 task DB 写锁。
// 基线在 ledger 已改 abandoned 的未提交视图上计算，避免提交前后的并发写入被误算。
        const activity = await this.computeVariantActivityDigests(
          taskDb,
          sessionDb,
          workspacePath,
          abandonedVariants,
          2,
          configSnapshots,
        );
        taskDb
          .prepare(
            "UPDATE workspace_migration_ledger SET abandoned_activity_json = ? WHERE migration_id = ?",
          )
// 显式写入算法版本，后续升级才能按 v2 回放而不是误判 diverged。
          .run(JSON.stringify({ schemaVersion: 2, digests: activity }), ledger.migration_id);
// 先提交 session 读事务再提交 task 写事务，顺序与加锁顺序一致以避免死锁。
        sessionDb?.exec("COMMIT");
// task 写事务最后提交：alias、abandon 状态与基线在同一事务内生效。
        taskDb.exec("COMMIT");
      } catch (error) {
// 先回滚 session 读事务再回滚 task，顺序与加锁顺序相反以避免死锁。
        if (sessionDb) rollbackQuietly(sessionDb);
        rollbackQuietly(taskDb);
        throw error;
      }
    } finally {
      sessionDb?.close();
      taskDb.close();
    }
  }

// 重试同样串行化：它会绕过 abandoned 短路重新扫描，必须与放弃互斥。
  public async retryFailedWorkspace(
    workspacePath: string,
    migrationId?: string,
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    return await this.runWorkspaceOperation(workspacePath, (normalizedPath) =>
      this.retryFailedWorkspaceInternal(normalizedPath, migrationId),
    );
  }

// 先独立读一次 canonical 并立即关库，避免长事务跨越整个重试流程。
  private async retryFailedWorkspaceInternal(
    workspacePath: string,
    migrationId?: string,
  ): Promise<ResolveCanonicalWorkspaceKeyResult> {
    const taskDb = openDatabase(this.taskDbPath);
    let canonicalKey: string | undefined;
    try {
      await runTasksDatabaseMigrations(taskDb, "source-server");
// 只读取 canonical 供 hint 使用；不在这里做任何写入，避免跨内部入口持有事务。
      const failed = taskDb
        .prepare(`
        SELECT canonical_key
        FROM workspace_migration_ledger
        WHERE path = ? AND status IN ('failed', 'abandoned')
          ${migrationId ? "AND migration_id = ?" : ""}
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
        .get(workspacePath, ...(migrationId ? [migrationId] : [])) as
        | { canonical_key: string }
        | undefined;
// 复用最近一次 failed/abandoned 的 canonical 作为 hint，保持用户可见身份稳定。
      canonicalKey = failed?.canonical_key;
    } finally {
      taskDb.close();
    }
// failed 与 abandoned 都可重试；两者都没有说明调用方状态错误。
    if (!canonicalKey)
      throw new Error(`No retryable Source Server migration for path: ${workspacePath}`);
    // retry 只绕过本次 abandoned 短路；若仍冲突会创建新的 failed attempt，原审计保留。
    // 当前操作已占有同路径队列，直接复用内部入口，避免重新排队后等待自身。
// 重排同一路径会等待自身造成死锁，因此直接调用 resolveCanonicalWorkspaceKeyInternal。
    return await this.resolveCanonicalWorkspaceKeyInternal(
      {
        workspacePath,
        legacyRouteHint: canonicalKey,
      },
// 仅本调用忽略 abandoned，其他入口仍尊重用户冻结的 canonical。
      { ignoreAbandoned: true },
    );
  }

// variant 读侧容错：非数组或非字符串元素一律过滤，脏 ledger 不应中断报告。
  private parseVariantKeys(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
// 类型守卫过滤非字符串元素，防止后续 includes/比较时抛错。
        ? parsed.filter((value): value is string => typeof value === "string")
        : [];
    } catch {
      return [];
    }
  }

// 优先识别 schemaVersion 2 envelope，其余形态一律按 v1 回放。
  private parseAbandonedActivity(raw: string): WorkspaceActivityDigestBaseline {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        if (
// 只有版本与 digests 都合法才走 v2，半截结构按旧格式处理。
          record.schemaVersion === 2 &&
          record.digests &&
          typeof record.digests === "object" &&
          !Array.isArray(record.digests)
        ) {
          return {
            version: 2,
            digests: this.parseDigestMap(record.digests as Record<string, unknown>),
          };
        }
        // Bug 原因：旧 abandoned 行没有算法版本；若直接用新增 bootstrap/过滤 node-order
        // 后的算法比较，升级本身就会制造 divergence。无 envelope 的行必须固定按 v1 回放。
// 无 envelope 的行固定 v1：算法升级不能让历史基线被动改变。
        return { version: 1, digests: this.parseDigestMap(record) };
      }
      return { version: 1, digests: {} };
    } catch {
      return { version: 1, digests: {} };
    }
  }

// 只保留字符串值；数字或对象摘要无法比较，静默丢弃比整体失败更安全。
  private parseDigestMap(input: Record<string, unknown>): Record<string, string> {
    return Object.fromEntries(
      Object.entries(input).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

// 摘要覆盖任务库、会话库与配置目录：任一维度变化都说明放弃后仍有写入。
  private async computeVariantActivityDigests(
    taskDb: Database,
    sessionDb: Database | null,
    workspacePath: string,
    variants: string[],
    version: WorkspaceActivityDigestVersion = 2,
    configSnapshots?: ReadonlyMap<string, SessionConfigEntries>,
  ): Promise<Record<string, string>> {
// 输出按 variant 索引的摘要表，供 JSON 持久化与逐键比较。
    const result: Record<string, string> = {};
// 先排序再计算，保证同一集合产生稳定输出，可直接比较字符串。
    for (const variant of [...variants].sort()) {
// 每个 variant 独立哈希，避免不同身份线之间发生摘要串扰。
      const hash = createHash("sha256");
      this.updateDatabaseActivityHash(
        hash,
        taskDb,
        workspacePath,
        variant,
// 表集合按版本分支：v2 增加 bootstrap 表，v1 保持历史回放口径。
        version === 1
          ? [
              "tasks",
              "task_group_members",
              "task_group_view_node_orders",
              "automations",
              "automation_runs",
              "off_peak_tasks",
            ]
          : [
              "tasks",
              "task_group_members",
              "task_group_workspace_bootstraps",
              "task_group_view_node_orders",
              "automations",
              "automation_runs",
              "off_peak_tasks",
            ],
        version,
      );
// session 库缺失时跳过该维度，基线仍可检测任务与配置变化。
      if (sessionDb) {
        this.updateDatabaseActivityHash(
          hash,
          sessionDb,
          workspacePath,
          variant,
          ["session", "sessions"],
          version,
        );
      }
// 调用方可传入已读快照，避免在写事务内重复遍历目录。
      const configEntries =
        configSnapshots?.get(variant) ??
        (await this.readSessionConfigEntries(
          this.getSessionConfigDirectory(workspacePath, variant),
        ));
// 条目按路径排序后哈希，文件系统枚举顺序不影响摘要。
      for (const [relativePath, entry] of [...configEntries.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
// 路径参与哈希，文件改名同样应被视为活跃度变化。
        hash.update(relativePath);
// 类型参与哈希，文件变目录或反之都必须反映到摘要。
        hash.update(entry.kind);
// 目录只贡献路径与类型；空目录同样影响摘要，从而能检测结构变化。
        if (entry.kind === "file") hash.update(entry.content);
      }
// 存 hex 字符串而非 Buffer，便于 JSON 持久化与人工比对。
      result[variant] = hash.digest("hex");
    }
    return result;
  }

// 表级摘要需要版本无关的规范化：列排序、行排序、类型归一缺一不可。
  private updateDatabaseActivityHash(
    hash: ReturnType<typeof createHash>,
    db: Database,
    workspacePath: string,
    workspaceKey: string,
    tables: string[],
    version: WorkspaceActivityDigestVersion,
  ): void {
    for (const table of tables) {
      if (!hasTable(db, table)) continue;
// 按优先级找身份列；path 与 workspace_path 存物理路径，其余存身份 key。
      const column = [
        "workspace_key",
        "workspace_identity",
        "workspace_id",
        "workspace_path",
        "path",
      ].find((candidate) => hasColumn(db, table, candidate));
// 无身份列时全表参与哈希，再由版本决定是否按 node_key 过滤。
      let rows = (
        column
          ? db
// 列名来自上面的白名单探测，不来自外部输入，因此可安全拼进 SQL。
// 值始终参数绑定，避免身份 key 中的特殊字符破坏语句。
              .prepare(`SELECT * FROM ${table} WHERE ${column} = ?`)
              .all(column === "workspace_path" || column === "path" ? workspacePath : workspaceKey)
          : db.prepare(`SELECT * FROM ${table}`).all()
      ) as unknown[];
// v2 对无列的表按 node_key 首元素过滤，避免不同 workspace 的排序记录互相干扰。
      if (version === 2 && !column && table === "task_group_view_node_orders") {
        rows = rows.filter((row) => {
          const nodeKey = (row as { node_key?: unknown }).node_key;
          if (typeof nodeKey !== "string") return false;
          try {
// node_key 由 CLI 写入，结构应为数组；解析失败直接返回 false 表示不匹配。
// 这里不复用 map 的解析结果，避免把异常扩散到整个摘要计算。
            const parsed = JSON.parse(nodeKey) as unknown;
            return Array.isArray(parsed) && parsed[0] === workspaceKey;
          } catch {
            return false;
          }
        });
      }
// 列名排序保证对象键顺序稳定；bigint 与 Buffer 显式转换，JSON 才能无损表达。
      const normalized = rows.map((row) =>
        Object.fromEntries(
          Object.entries(row as Record<string, unknown>)
// 列名排序必须与行内规范化一致，否则同一对象会得到不同键序。
            .sort(([left], [right]) => left.localeCompare(right))
// 先按列名排序再映射，消除不同查询返回列顺序的差异。
            .map(([key, item]) => [
// 键名参与规范化对象，保证不同列顺序产生的 JSON 完全一致。
              key,
// bigint 在 JSON 中不可序列化，统一转十进制字符串。
              typeof item === "bigint"
                ? item.toString()
// Buffer 转 base64，保证二进制列在摘要中可比较且可持久化。
                : Buffer.isBuffer(item)
                  ? item.toString("base64")
// 普通值原样保留；null 与数字在 JSON 中已可比较。
                  : item,
            ]),
        ),
      );
// 行排序消除查询顺序差异，使同一数据必然得到同一摘要。
      normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
// hash.update(table) 让表名参与哈希，防止结构相同但语义不同的表互相抵消。
      hash.update(table);
// 行数组整体参与哈希，列名与行序已规范化，结果只随数据内容变化。
// 空表也会贡献一个空数组的 JSON，保证“表存在但无行”与“表不存在”可区分。
      hash.update(JSON.stringify(normalized));
    }
  }

// 身份线扫描覆盖所有可能落过 workspace_key 的表，任一遗漏都会导致漏合并。
  private findVariants(
    taskDb: Database,
    sessionDb: Database | null,
    workspacePath: string,
  ): string[] {
// 用 Set 去重：同一身份线可能同时出现在任务表、会话表与配置目录。
    const variants = new Set<string>();
    for (const table of WORKSPACE_PATH_TABLES) {
      if (
        !hasTable(taskDb, table) ||
        !hasColumn(taskDb, table, "workspace_key") ||
        !hasColumn(taskDb, table, "workspace_path")
      ) {
        continue;
      }
      const rows = taskDb
        .prepare(
          `SELECT DISTINCT workspace_key FROM ${table}
           WHERE workspace_path = ? AND workspace_key LIKE 'remote:%'`,
        )
        .all(workspacePath) as unknown as Array<{ workspace_key: string }>;
      for (const row of rows)
// 只收集历史 remote 前缀，新 server identity 已由 alias 承担。
        if (isLegacyRemoteKey(row.workspace_key)) variants.add(row.workspace_key);
    }
// 这两张表没有 path 列，只能解析 identity 中的 workspacePath 再比对。
    for (const table of ["task_group_workspace_bootstraps", "automation_runs"] as const) {
      if (!hasTable(taskDb, table) || !hasColumn(taskDb, table, "workspace_key")) continue;
      const rows = taskDb
// 只取历史 remote 前缀，避免把新 server identity 当 variant 重复合并。
// DISTINCT 消除同表多行带来的重复 key，减少后续集合操作。
        .prepare(`SELECT DISTINCT workspace_key FROM ${table} WHERE workspace_key LIKE 'remote:%'`)
        .all() as unknown as Array<{ workspace_key: string }>;
      for (const row of rows) {
        if (
          isLegacyRemoteKey(row.workspace_key) &&
          parseRemoteWorkspaceIdentity(row.workspace_key)?.workspacePath === workspacePath
        ) {
// 这些表没有 path 列，只能靠 identity 内嵌的 workspacePath 判定归属。
// 解析失败或路径不符的行会被条件过滤，不会进入 variants。
          variants.add(row.workspace_key);
        }
      }
    }
    if (hasTable(taskDb, "task_group_view_node_orders")) {
      const rows = taskDb
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all() as unknown as Array<{ node_key: string }>;
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.node_key) as unknown;
// node_key 是 JSON 数组，首元素为身份线；只处理 node_type = task 的行。
          const workspaceKey = Array.isArray(parsed) ? parsed[0] : null;
          if (
            typeof workspaceKey === "string" &&
// 三个条件全满足才纳入：字符串、历史前缀、路径匹配。
// 任一不满足说明该排序记录不属于本 workspace。
            isLegacyRemoteKey(workspaceKey) &&
            parseRemoteWorkspaceIdentity(workspaceKey)?.workspacePath === workspacePath
          ) {
// node_key 首元素即身份线；解析失败的行已被 catch 跳过。
            variants.add(workspaceKey);
          }
        } catch {
          // 非结构化 node key 不属于 workspace task 排序记录。
        }
      }
    }
    if (sessionDb && hasTable(sessionDb, "session")) {
      const rows = sessionDb
        .prepare(
// 会话库按 directory/path 归属反查 workspace_id，补足任务库未覆盖的身份线。
          "SELECT DISTINCT workspace_id FROM session WHERE (directory = ? OR path = ?) AND workspace_id LIKE 'remote:%'",
        )
        .all(workspacePath, workspacePath) as unknown as Array<{ workspace_id: string }>;
      for (const row of rows)
        if (isLegacyRemoteKey(row.workspace_id)) variants.add(row.workspace_id);
    }
// 统一排序后返回，让后续 ledger 与用户可见顺序可复现。
    return [...variants].sort();
  }

// hint 只有在确实拥有数据时才纳入 variants，避免把陌生 key 写进 alias。
  private async hasWorkspaceOwnedStateForHint(
    taskDb: Database,
    workspacePath: string,
    workspaceKey: string,
  ): Promise<boolean> {
// 先查带身份列的业务表，任一命中即可返回 true。
    for (const table of [
      "tasks",
      "task_group_members",
      "task_group_workspace_bootstraps",
      "automations",
      "automation_runs",
      "off_peak_tasks",
    ] as const) {
      if (
        hasTable(taskDb, table) &&
        hasColumn(taskDb, table, "workspace_key") &&
// 任意一行存在即证明该身份线写过数据，LIMIT 1 避免全表扫描。
        taskDb.prepare(`SELECT 1 FROM ${table} WHERE workspace_key = ? LIMIT 1`).get(workspaceKey)
      ) {
        return true;
      }
    }
    if (hasTable(taskDb, "task_group_view_node_orders")) {
      const rows = taskDb
        .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
        .all() as unknown as Array<{ node_key: string }>;
      if (
        rows.some((row) => {
          try {
            const parsed = JSON.parse(row.node_key) as unknown;
            return Array.isArray(parsed) && parsed[0] === workspaceKey;
          } catch {
            return false;
          }
        })
      ) {
        return true;
      }
    }
// 文件系统也算 owned state：即使库中无行，非空配置目录仍代表该身份线被使用过。
    const configDir = this.getSessionConfigDirectory(workspacePath, workspaceKey);
// 目录不存在即无状态；存在但为空同样视为未使用。
    if (!(await this.pathExists(configDir))) return false;
// 只读目录名不递归内容，判定成本与目录规模无关。
    return (await readdir(configDir)).length > 0;
  }

// 选主只依据活跃度：最近写过的身份线作为 canonical 最符合用户直觉。
// 所有候选先初始化为 0，未出现在任何表中的 key 也能参与排序。
  private chooseCanonicalKey(
    taskDb: Database,
    sessionDb: Database | null,
    workspacePath: string,
    variants: string[],
  ): string {
// Map 同时充当候选集合与得分表，避免再维护一份 variants 副本。
    const activity = new Map(variants.map((key) => [key, 0]));
    for (const table of WORKSPACE_PATH_TABLES) {
      if (
        !hasTable(taskDb, table) ||
        !hasColumn(taskDb, table, "workspace_key") ||
        !hasColumn(taskDb, table, "workspace_path") ||
        !hasColumn(taskDb, table, "updated_at")
      ) {
        continue;
      }
      const rows = taskDb
        .prepare(
          `SELECT workspace_key, MAX(updated_at) AS last_active_at FROM ${table}
           WHERE workspace_path = ? GROUP BY workspace_key`,
        )
        .all(workspacePath) as unknown as WorkspaceActivityRow[];
      for (const row of rows) {
        if (activity.has(row.workspace_key)) {
          activity.set(
            row.workspace_key,
            Math.max(activity.get(row.workspace_key) ?? 0, row.last_active_at),
          );
        }
      }
    }
    if (sessionDb && hasTable(sessionDb, "session")) {
      const rows = sessionDb
        .prepare(
          "SELECT workspace_id AS workspace_key, MAX(time_updated) AS last_active_at FROM session WHERE directory = ? OR path = ? GROUP BY workspace_id",
        )
        .all(workspacePath, workspacePath) as unknown as WorkspaceActivityRow[];
      for (const row of rows) {
        if (activity.has(row.workspace_key)) {
          activity.set(
            row.workspace_key,
            Math.max(activity.get(row.workspace_key) ?? 0, row.last_active_at),
          );
        }
      }
    }
// 排序只决定 canonical，不改变 variants 集合本身。
    return [...variants].sort((left, right) => {
// 活跃度降序；相等时回退字典序，保证同一数据每次都选出同一 canonical。
      const activityOrder = (activity.get(right) ?? 0) - (activity.get(left) ?? 0);
// 活跃度相同则以字典序定序，保证 canonical 选择可复现。
      return activityOrder || left.localeCompare(right);
// 排序后取首项；variants 非空由调用方保证，非空断言仅用于类型收窄。
    })[0]!;
  }

// task 库合并是一个 BEGIN IMMEDIATE 事务：预检冲突、逐 task 合并、关联表 rekey 全原子。
// 任何一步抛错都整体回滚，绝不留下部分搬运的第三态。
  private mergeTaskDatabase(
    db: Database,
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): void {
// 只有 tasks 表存在才可能产生任务合并，否则整个步骤 no-op。
    if (!hasTable(db, "tasks")) return;
    db.exec("BEGIN IMMEDIATE");
    try {
// 写锁内复检：独立预检与实际写入之间仍有竞态窗口。
      const conflicts = this.findTaskIdentityConflicts(db, workspacePath, canonicalKey, mergedKeys);
      if (conflicts.length > 0) {
        // Bug 原因：独立 preflight 与真正写事务之间仍有竞态窗口。冲突复检必须在
        // BEGIN IMMEDIATE 取得写锁后完成，失败时由本事务整体回滚，再写审计报告。
        throw new SourceServerWorkspaceIdentityConflictError(workspacePath, conflicts);
      }
      const listTasks = db.prepare(
        "SELECT task_id, title, created_at, updated_at, pinned, archived, deleted, title_overridden, searchable_text, unread_at, last_unread_at, task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json FROM tasks WHERE workspace_key = ? AND workspace_path = ?",
      );
      const findCanonical = db.prepare(
        "SELECT task_id, title, created_at, updated_at, pinned, archived, deleted, title_overridden, searchable_text, unread_at, last_unread_at, task_status, provider, mode, model, migration_source, forked_from_task_id, cron_automation_id, off_peak_task_id, meta_json FROM tasks WHERE workspace_key = ? AND task_id = ?",
      );
// 预编译本事务用到的全部语句，逐个 source 循环复用，避免重复解析 SQL。
// canonical 缺该 task 时直接搬家，并顺手改写 meta 中的 workspaceIdentity。
      const moveTask = db.prepare(
        "UPDATE tasks SET workspace_key = ?, workspace_identity = ?, meta_json = ? WHERE workspace_key = ? AND task_id = ?",
      );
// 已存在同 taskId 时按字段语义合并：时间取边界、布尔取 OR、标题尊重 overridden。
      const mergeTask = db.prepare(`
        UPDATE tasks SET
          created_at = MIN(created_at, ?),
          updated_at = MAX(updated_at, ?),
          pinned = MAX(pinned, ?),
          archived = MAX(archived, ?),
          deleted = MAX(deleted, ?),
          title = CASE WHEN title_overridden = 1 THEN title WHEN ? = 1 THEN ? ELSE title END,
          title_overridden = MAX(title_overridden, ?),
          searchable_text = CASE WHEN searchable_text <> '' THEN searchable_text ELSE ? END,
          unread_at = ?,
          last_unread_at = ?,
          task_status = ?,
          provider = ?,
          mode = ?,
          model = ?,
          migration_source = ?,
          forked_from_task_id = ?,
          cron_automation_id = ?,
          off_peak_task_id = ?,
          meta_json = ?
        WHERE workspace_key = ? AND task_id = ?
      `);
// 合并完成后删除 source 行，避免同一 taskId 在两个身份线下重复出现。
      const deleteTask = db.prepare("DELETE FROM tasks WHERE workspace_key = ? AND task_id = ?");
      // 只跑过 tasks schema 迁移的库没有项目化列，此时旧列已是全部事实。
// 旧库缺 cli_updated_at 列时 hasCliFacts 为假，cli 事实整体不可读。
      const hasCliFacts = hasColumn(db, "tasks", "cli_updated_at");
// cli 事实用独立语句读写；缺列时退化为 SELECT NULL WHERE 0，调用点无需分支。
      const readCliFacts = db.prepare(
        hasCliFacts
          ? "SELECT cli_title, cli_title_source, cli_created_at, cli_updated_at, cli_last_outcome, cli_deleted, handoff_pending FROM tasks WHERE workspace_key = ? AND task_id = ?"
          : "SELECT NULL WHERE 0",
      );
// 写回仍以 canonicalKey + taskId 定位，保证与主合并落在同一行。
      const writeCliFacts = db.prepare(
        hasCliFacts
          ? "UPDATE tasks SET cli_title = ?, cli_title_source = ?, cli_created_at = ?, cli_updated_at = ?, cli_last_outcome = ?, cli_deleted = ?, handoff_pending = ? WHERE workspace_key = ? AND task_id = ?"
          : "SELECT NULL WHERE 0",
      );
      for (const sourceKey of mergedKeys) {
// 逐个 source 串行合并：后一个 source 看到的是前一个已合并的结果，顺序因此重要。
// 这也是预检必须按同一顺序累积合并结果的原因。
// 按 sourceKey 与物理路径双条件取行，防止误并同 key 但不同路径的任务。
        const rows = listTasks.all(sourceKey, workspacePath) as unknown as Array<{
          task_id: string;
          title: string;
          created_at: number;
          updated_at: number;
          pinned: number;
          archived: number;
          deleted: number;
          title_overridden: number;
          searchable_text: string;
          unread_at: number | null;
          last_unread_at: number;
          task_status: string | null;
          provider: string | null;
          mode: string;
          model: string | null;
          migration_source: string | null;
          forked_from_task_id: string | null;
          cron_automation_id: string | null;
          off_peak_task_id: string | null;
          meta_json: string;
        }>;
        for (const row of rows) {
// 用 taskId 判断是否同一条任务；身份冲突已在事务开头拦截。
// 无同名 task 时直接改 key，无需字段级合并。
          const existing = findCanonical.get(canonicalKey, row.task_id) as typeof row | undefined;
          if (!existing) {
// 只在 meta 确实带 workspaceIdentity 时改写，避免给旧 meta 凭空加字段。
            const meta = parseMetaRecord(row.meta_json);
// 只有 meta 带 workspaceIdentity 时才改写；无该字段的旧 meta 原样搬走。
            const movedMetaJson =
              meta && "workspaceIdentity" in meta
// 重写身份字段而非追加，防止同一 key 出现两份取值。
                ? JSON.stringify({ ...meta, workspaceIdentity: canonicalKey })
                : row.meta_json;
// workspace_identity 与 workspace_key 同步更新，保持两列语义一致。
            moveTask.run(canonicalKey, canonicalKey, movedMetaJson, sourceKey, row.task_id);
            continue;
          }
// meta 合并与预检使用同一函数，冲突判定因此不会出现两套口径。
          const metaMerge = mergeTaskMetaJson(existing, row, canonicalKey);
// 理论上预检已拦截；此处兜底并携带具体 taskId，事务整体回滚。
          if (metaMerge.status === "identity-conflict") {
            throw new SourceServerWorkspaceIdentityConflictError(workspacePath, [
              { taskId: row.task_id, sourceKey },
            ]);
          }
          // Bug 原因：只合并壳字段后删除 source 会永久丢失正文索引和未读状态。
          // 在删除前保留可搜索正文，并延续索引已有的未读 marker 合并规则。
// 未读时间取两者较大值：任一侧有未读就保留最新一次未读时刻。
          const unreadAt =
            existing.unread_at !== null && row.unread_at !== null
              ? Math.max(existing.unread_at, row.unread_at)
              : (existing.unread_at ?? row.unread_at);
          // Bug 原因：meta 已按新旧合并，查询投影却保留 canonical 旧值，导致状态过滤和身份反查失真。
          // 从合并后的 meta 重建投影；旧 meta 未携带的字段沿用索引列，保留历史回填的身份。
// 投影字段必须从合并后的 meta 重建，否则状态过滤与身份反查会读到旧值。
          const mergedMeta = parseMetaRecord(metaMerge.metaJson);
// 以 updated_at 决定新旧，仅用于缺省字段回退，不用于 cli 事实裁决。
          const [newer, older] =
            existing.updated_at <= row.updated_at ? [row, existing] : [existing, row];
// meta 优先、索引列兜底：旧 meta 未携带的字段沿用历史回填值。
          const project = (key: string, legacyValue: string | null): string | null => {
            const value = mergedMeta?.[key];
            return typeof value === "string" ? value : legacyValue;
          };
// 参数顺序与 SQL 占位符严格对应；时间/布尔/标题交给 SQL 的 MIN/MAX/CASE 处理。
          mergeTask.run(
// 创建时间取两侧最小值，由 SQL MIN 完成，避免在 JS 里再算一遍。
            row.created_at,
// 更新时间取两侧最大值，保证合并后不会因旧行覆盖而回退。
            row.updated_at,
// pinned 取两侧最大值：任一侧置顶即保持置顶。
            row.pinned,
// 归档同理取最大值，避免合并后已归档任务重新出现。
            row.archived,
// 删除标记取最大值，任一侧删除即视为删除，保留墓碑。
            row.deleted,
            row.title_overridden,
// 标题回退值；是否采用由 SQL 中的 title_overridden CASE 决定。
            row.title,
            row.title_overridden,
// 仅当 canonical 正文为空时才用来源正文，避免覆盖更完整的索引。
            row.searchable_text,
// 已算好的未读时间直接写入，SQL 不再重复比较。
            unreadAt,
// last_unread_at 取三方最大，确保合并后不会把已读状态回退。
            Math.max(existing.last_unread_at, row.last_unread_at, unreadAt ?? 0),
// 每个投影字段都取较新一侧的列值，缺失时回退较旧一侧。
            project("status", newer.task_status ?? older.task_status),
// provider 取较新一侧，缺失时回退较旧值。
            project("provider", newer.provider ?? older.provider),
// mode 在两侧都有值，直接用较新一侧。
            project("mode", newer.mode),
// model 可为空，较新一侧为空时保留旧值。
            project("model", newer.model ?? older.model),
// 迁移来源只用于审计，取有值的一侧即可。
            project("migrationSource", newer.migration_source ?? older.migration_source),
// fork 来源必须保留，否则任务树会断链。
            project("forkedFromTaskId", newer.forked_from_task_id ?? older.forked_from_task_id),
// cron 绑定只取一个值；两侧不同会在预检阶段被判为身份冲突。
            project("cronAutomationId", newer.cron_automation_id ?? older.cron_automation_id),
// off-peak 绑定同理，写事务只会在无冲突时走到这里。
            project("offPeakTaskId", newer.off_peak_task_id ?? older.off_peak_task_id),
// 合并后的 meta 整串写回，身份字段已指向 canonical。
            metaMerge.metaJson,
            canonicalKey,
            row.task_id,
          );
// cli 事实单独合并，避免主合并抬高 updated_at 后影响标题与状态裁决。
          if (hasCliFacts) {
// 以 canonical 行为基准读取 cli 事实，source 侧单独读一次，两行同事务内可见。
            const canonicalFacts = readCliFacts.get(
              canonicalKey,
              row.task_id,
            ) as unknown as TaskCliFactsRow;
// source 行尚未删除，仍在同一 sourceKey 下可读。
            const sourceFacts = readCliFacts.get(
              sourceKey,
              row.task_id,
            ) as unknown as TaskCliFactsRow;
            // Bug 原因：旧 ACP ID 合并只抬高 updated_at、不改 cli_*，两列在存量库中会分叉；按
            // updated_at 选胜者会把较旧的状态/标题配上较新的 cli_updated_at。CLI 事实只按自身
            // 时间裁决，无事实的一方不胜出，同时间沿用 source 优先。
// 无 cli_updated_at 视为负无穷：没有事实的一侧永远不胜出。
            const cliTime = (facts: TaskCliFactsRow) =>
              facts.cli_updated_at ?? Number.NEGATIVE_INFINITY;
// 时间相同时 source 优先，保证合并方向确定。
            const facts =
              cliTime(canonicalFacts) <= cliTime(sourceFacts)
                ? mergeTaskCliFacts(sourceFacts, canonicalFacts)
                : mergeTaskCliFacts(canonicalFacts, sourceFacts);
// 写回后 cli 列与主字段处于同一事务，外部看不到中间态。
            writeCliFacts.run(
// 逐字段写回合并结果，顺序与 UPDATE 占位符一致。
              facts.cli_title,
// 标题来源参与写回，保证 custom 标记不会在合并中丢失。
              facts.cli_title_source,
// cli 创建时间取两侧最早，与主字段的时间边界规则一致。
              facts.cli_created_at,
// cli 更新时间取两侧最晚，代表最后一次 CLI 侧变更。
              facts.cli_updated_at,
// outcome 取有值的一侧，较新一侧为空时保留旧值。
              facts.cli_last_outcome,
// 删除标记取最大值，任一侧删除过即视为已删除。
              facts.cli_deleted,
// handoff_pending 是位标记，合并时取按位或保留任一侧的待交接状态。
              facts.handoff_pending,
              canonicalKey,
              row.task_id,
            );
          }
// 只有所有字段与 cli 事实都写成功后才删 source 行。
          deleteTask.run(sourceKey, row.task_id);
        }
// 关联表先删 canonical 已存在的同 taskId 行，再整体 rekey，避免主键冲突。
        if (hasTable(db, "task_group_members")) {
          db.prepare(`DELETE FROM task_group_members
            WHERE workspace_key = ? AND EXISTS (
              SELECT 1 FROM task_group_members target
              WHERE target.workspace_key = ? AND target.task_id = task_group_members.task_id
            )`).run(sourceKey, canonicalKey);
          db.prepare(
            "UPDATE task_group_members SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?",
          ).run(canonicalKey, canonicalKey, sourceKey);
        }
// bootstrap 是每 workspace 单行标记，重复会让后续初始化判断失真。
        if (hasTable(db, "task_group_workspace_bootstraps")) {
// 先查 canonical 是否已有 bootstrap 行，决定丢弃来源还是整行改 key。
          const canonicalBootstrap = db
            .prepare("SELECT 1 FROM task_group_workspace_bootstraps WHERE workspace_key = ?")
            .get(canonicalKey);
// 已存在则删除来源，否则整行改 key；两条路径都不会产生重复标记。
          if (canonicalBootstrap) {
            db.prepare("DELETE FROM task_group_workspace_bootstraps WHERE workspace_key = ?").run(
              sourceKey,
            );
          } else {
            db.prepare(
              "UPDATE task_group_workspace_bootstraps SET workspace_key = ? WHERE workspace_key = ?",
            ).run(canonicalKey, sourceKey);
          }
        }
// 排序 node_key 内嵌身份线，必须单独改写而不是走 workspace_key 列。
        this.migrateTaskNodeOrders(db, sourceKey, canonicalKey);
// automations 只做 key rekey，业务字段无需合并。
        this.updateWorkspaceIdentityColumns(db, "automations", sourceKey, canonicalKey);
// runs 先于 off-peak 处理：外部执行记录只 rekey，不影响绑定关系。
        this.updateWorkspaceIdentityColumns(db, "automation_runs", sourceKey, canonicalKey);
// off-peak 绑定可能指向同一时间槽，rekey 前必须先取消冲突绑定。
        cancelConflictingOffPeakBindings(db, sourceKey, canonicalKey, this.now());
// off-peak 任务最后 rekey，此时冲突绑定已取消，更新不会破坏唯一约束。
        this.updateWorkspaceIdentityColumns(db, "off_peak_tasks", sourceKey, canonicalKey);
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

// node_key 形如 [workspaceKey, taskId]，只处理 task 类型且首元素等于 source 的行。
  private migrateTaskNodeOrders(db: Database, sourceKey: string, canonicalKey: string): void {
    if (!hasTable(db, "task_group_view_node_orders")) return;
// 一次性取出全部 task 排序行，迁移发生在单事务内，规模可控。
    const rows = db
      .prepare("SELECT node_key FROM task_group_view_node_orders WHERE node_type = 'task'")
      .all() as unknown as Array<{ node_key: string }>;
// 目标 node_key 已存在时删除来源行，避免同一排序位出现两条记录。
    const deleteRow = db.prepare(
      "DELETE FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
    );
// 目标 node_key 不存在时 updateRow 原位改写，原有排序值保持不变。
    const updateRow = db.prepare(
      "UPDATE task_group_view_node_orders SET node_key = ? WHERE node_type = 'task' AND node_key = ?",
    );
// 逐行查目标存在性；node_key 是主键的一部分，冲突必须显式处理。
    const targetExists = db.prepare(
      "SELECT 1 FROM task_group_view_node_orders WHERE node_type = 'task' AND node_key = ?",
    );
    for (const row of rows) {
// 解析失败的行直接跳过：非 JSON node_key 不属于 workspace 排序记录。
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.node_key);
      } catch {
        continue;
      }
// 只认两元素数组且首元素匹配的行；其他结构不属于本迁移范围。
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== sourceKey) continue;
// 用 JSON.stringify 重建 key，保持与写入方完全相同的序列化格式。
      const canonicalNodeKey = JSON.stringify([canonicalKey, parsed[1]]);
// 目标已存在时删除来源，等价于集合去重。
      if (targetExists.get(canonicalNodeKey)) {
// 删除的是旧 key，保留 canonical 侧原有排序值。
        deleteRow.run(row.node_key);
      } else {
// targetExists 为假时 updateRow 把 row.node_key 改写成 canonicalNodeKey。
        updateRow.run(canonicalNodeKey, row.node_key);
      }
    }
  }

// 兼容两种 schema：有 workspace_identity 列时两列同步更新，否则只改 key。
  private updateWorkspaceIdentityColumns(
    db: Database,
    table: "automations" | "automation_runs" | "off_peak_tasks",
    sourceKey: string,
    canonicalKey: string,
  ): void {
    if (!hasTable(db, table) || !hasColumn(db, table, "workspace_key")) return;
// 两列必须同值，否则按 identity 反查时会漏掉已 rekey 的行。
    if (hasColumn(db, table, "workspace_identity")) {
      db.prepare(
        `UPDATE ${table} SET workspace_key = ?, workspace_identity = ? WHERE workspace_key = ?`,
      ).run(canonicalKey, canonicalKey, sourceKey);
      return;
    }
    db.prepare(`UPDATE ${table} SET workspace_key = ? WHERE workspace_key = ?`).run(
      canonicalKey,
      sourceKey,
    );
  }

// 预检按写入顺序累积每个 taskId 的合并结果，与写事务使用同一条冲突规则。
  private findTaskIdentityConflicts(
    db: Database,
    workspacePath: string,
    canonicalKey: string,
    mergedKeys: string[],
  ): WorkspaceTaskIdentityConflict[] {
// 无 tasks 表时不可能存在任务身份冲突。
    if (!hasTable(db, "tasks")) return [];
    const listTasks = db.prepare(
      "SELECT task_id, meta_json, updated_at, cron_automation_id, off_peak_task_id, forked_from_task_id FROM tasks WHERE workspace_key = ? AND workspace_path = ?",
    );
    const findCanonical = db.prepare(
      "SELECT task_id, meta_json, updated_at, cron_automation_id, off_peak_task_id, forked_from_task_id FROM tasks WHERE workspace_key = ? AND task_id = ?",
    );
    // Bug 原因：写事务按 mergedKeys 顺序把 source 逐个并入 canonical，后一个 source 比较的是
    // 已累积的合并结果；预检只比 canonical 快照，canonical 缺该 task 或缺身份字段时会漏掉
    // source 之间的冲突，备份后才在写事务里失败，每次打开都重新建账、备份两库。
    // 预检按同一顺序累积每个 taskId 的合并结果，和写事务用同一条冲突规则。
// merged 保存每个 taskId 的累积结果，canonical 缺失时以首个 source 为基。
    const merged = new Map<string, WorkspaceTaskMetaRow>();
// 冲突列表按发现顺序累积，调用方据此一次性落审计并抛错。
// conflicts 为空表示可安全进入写事务，无需回滚。
    const conflicts: WorkspaceTaskIdentityConflict[] = [];
    for (const sourceKey of mergedKeys) {
// 按 sourceKey 与物理路径取该身份线下的全部任务，作为冲突比较输入。
      const rows = listTasks.all(sourceKey, workspacePath) as unknown as Array<
        WorkspaceTaskMetaRow & { task_id: string }
      >;
      for (const row of rows) {
// 优先使用已累积结果；没有才回退 canonical 的原始行。
        const target =
          merged.get(row.task_id) ??
          (findCanonical.get(canonicalKey, row.task_id) as WorkspaceTaskMetaRow | undefined);
// canonical 与累积结果都没有该 task，直接登记为后续比较的基。
        if (!target) {
// 首次见到该 task 时以当前行为基，后续 source 都与它比较。
// 直接引用行对象即可，不需要拷贝。
          merged.set(row.task_id, row);
          continue;
        }
// 复用写事务同一函数，保证预检结论与真实写入一致。
        const result = mergeTaskMetaJson(target, row, canonicalKey);
// 一发现冲突就记录并跳过累加，继续扫描其余 task 以收集完整冲突集。
        if (result.status === "identity-conflict") {
// 冲突按发现顺序累积，报告中的 sourceKey 能指出是哪条身份线引入的。
          conflicts.push({ taskId: row.task_id, sourceKey });
          continue;
        }
        // 无冲突时每个身份字段至多一个取值，取并集即写事务投影后的有效身份。
// identity-conflict 已 continue，此处 target 与 row 的身份字段至多一侧有值。
        merged.set(row.task_id, {
          meta_json: result.metaJson,
          updated_at: Math.max(target.updated_at, row.updated_at),
// 身份字段取首个有值的一侧；无冲突时两侧至多一个取值。
          cron_automation_id: target.cron_automation_id ?? row.cron_automation_id,
// 与 cron 字段同理，用于后续 source 的冲突比较。
          off_peak_task_id: target.off_peak_task_id ?? row.off_peak_task_id,
// fork 来源也属于身份，必须在累加结果中保留以便检出冲突。
          forked_from_task_id: target.forked_from_task_id ?? row.forked_from_task_id,
        });
      }
    }
// 返回空数组表示可安全进入写事务；非空由调用方转成审计行与异常。
    return conflicts;
  }

// 冲突审计必须与 ledger 同事务写入，否则报告与实际状态可能不一致。
// 同一 migrationId 可复用：重试时替换冲突集合而不是无限追加历史。
// 只有在 preflight/backups-created 阶段才清空 phase，之后的阶段保留 resume owner。
// 若找不到既有 ledger，则新建一条 failed 行并记录 canonical 与 variants 快照。
// 冲突行按 taskId 落库，reason 固定为稳定错误码，便于 UI 分组展示。
// 本方法自身开事务，调用方不应再包一层，避免嵌套 BEGIN。
  private recordTaskIdentityConflicts(
    db: Database,
    input: {
      migrationId?: string;
      workspacePath: string;
      canonicalKey: string;
      variants: string[];
      conflicts: WorkspaceTaskIdentityConflict[];
    },
  ): void {
    const existing = input.migrationId
      ? (db
          .prepare("SELECT migration_id FROM workspace_migration_ledger WHERE migration_id = ?")
          .get(input.migrationId) as { migration_id: string } | undefined)
      : (db
          .prepare(`
            SELECT migration_id
            FROM workspace_migration_ledger
            WHERE path = ? AND status = 'failed'
              AND error = 'workspace-task-identity-conflict'
            ORDER BY updated_at DESC, created_at DESC, rowid DESC
            LIMIT 1
          `)
          .get(input.workspacePath) as { migration_id: string } | undefined);
    const migrationId = existing?.migration_id ?? this.createMigrationId();
    const now = this.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        // Bug 原因：冲突 ledger 幂等去重后直接 return，后续新增/消失的冲突不会更新报告。
        // 复用同一 migrationId，但事务性替换当前冲突集，仍不重复备份或新建 ledger。
        // preflight/backups-created 尚未搬运数据，可清 phase 让用户 abandon；之后的 phase
        // 保留 resume owner，禁止把部分迁移伪装成普通冲突。
        db.prepare(`
          UPDATE workspace_migration_ledger
          SET canonical_key = ?, variant_keys_json = ?, status = 'failed',
              phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
              error = 'workspace-task-identity-conflict', updated_at = ?
          WHERE migration_id = ?
        `).run(input.canonicalKey, JSON.stringify(input.variants), now, migrationId);
        db.prepare("DELETE FROM workspace_migration_conflicts WHERE migration_id = ?").run(
          migrationId,
        );
      } else {
        db.prepare(`
          INSERT INTO workspace_migration_ledger (
            migration_id, path, canonical_key, variant_keys_json, status,
            task_backup_path, session_backup_path, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'failed', '', NULL, 'workspace-task-identity-conflict', ?, ?)
        `).run(
          migrationId,
          input.workspacePath,
          input.canonicalKey,
          JSON.stringify(input.variants),
          now,
          now,
        );
      }
// 冲突明细逐条插入，source_key 指出是哪条身份线引入了该 taskId。
// task_id 与 conflict_key 同值，便于按任务查询或按冲突键去重。
// reason 使用固定字符串，避免把本地化文案写进审计表。
      const insertConflict = db.prepare(`
        INSERT INTO workspace_migration_conflicts (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        ) VALUES (?, ?, 'task-identity', ?, ?, NULL, ?, ?,
          'task-identity-metadata-conflict', ?)
      `);
// 循环复用同一预编译语句；冲突数等于任务数，属于一次性小批量写入。
// 任一条插入失败都会回滚整个事务，报告不会出现半套冲突。
      for (const conflict of input.conflicts) {
// 每条冲突单独插入，sourceKey 与 canonicalKey 同时落库便于双向追溯。
// 参数顺序与 INSERT 占位符一一对应，task_id 与 conflict_key 同值。
        insertConflict.run(
          migrationId,
          input.workspacePath,
          conflict.taskId,
          conflict.taskId,
          conflict.sourceKey,
          input.canonicalKey,
          now,
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

// 配置冲突的审计结构与身份冲突一致，但只记录相对路径与来源 key。
// 同一个 failed ledger 被复用时先清空旧冲突，再写入当前完整冲突集。
// pre-merge 阶段清零 phase 允许用户 abandon；已搬数据的阶段必须保留恢复能力。
// 新建 ledger 时 phase 显式为 NULL，表示该冲突不可自动续跑。
// 冲突记录写在同一事务内，保证报告与 ledger 状态一致。
// 本方法只在异常路径调用，正常合并不应产生任何冲突行。
  private recordConfigConflict(
    db: Database,
    input: {
      migrationId?: string;
      workspacePath: string;
      canonicalKey: string;
      variants: string[];
      conflict: SourceServerWorkspaceConfigConflictError;
    },
  ): void {
    const existing = input.migrationId
      ? (db
          .prepare("SELECT migration_id FROM workspace_migration_ledger WHERE migration_id = ?")
          .get(input.migrationId) as { migration_id: string } | undefined)
      : (db
          .prepare(`
        SELECT migration_id
        FROM workspace_migration_ledger
        WHERE path = ? AND status = 'failed'
          AND error = 'workspace-config-file-conflict'
        ORDER BY updated_at DESC, created_at DESC, rowid DESC
        LIMIT 1
      `)
          .get(input.workspacePath) as { migration_id: string } | undefined);
    const migrationId = existing?.migration_id ?? this.createMigrationId();
    const now = this.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (existing) {
        // 仅 pre-merge phase 能安全转成可 abandon 冲突；DB 已提交后的冲突必须保留 resume owner。
        db.prepare(`
          UPDATE workspace_migration_ledger
          SET canonical_key = ?, variant_keys_json = ?, status = 'failed',
              phase = CASE WHEN phase IN ('preflight', 'backups-created') THEN NULL ELSE phase END,
              error = 'workspace-config-file-conflict', updated_at = ?
          WHERE migration_id = ?
        `).run(input.canonicalKey, JSON.stringify(input.variants), now, migrationId);
        db.prepare("DELETE FROM workspace_migration_conflicts WHERE migration_id = ?").run(
          migrationId,
        );
      } else {
        db.prepare(`
          INSERT INTO workspace_migration_ledger (
            migration_id, path, canonical_key, variant_keys_json, status, phase,
            task_backup_path, session_backup_path, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'failed', NULL, '', NULL,
            'workspace-config-file-conflict', ?, ?)
        `).run(
          migrationId,
          input.workspacePath,
          input.canonicalKey,
          JSON.stringify(input.variants),
          now,
          now,
        );
      }
      db.prepare(`
        INSERT INTO workspace_migration_conflicts (
          migration_id, path, conflict_kind, conflict_key, task_id, relative_path,
          source_key, canonical_key, reason, created_at
        ) VALUES (?, ?, 'config-file', ?, NULL, ?, ?, ?,
          'workspace-config-file-conflict', ?)
      `).run(
        migrationId,
        input.workspacePath,
        input.conflict.relativePath,
        input.conflict.relativePath,
// sourceKey 指出冲突来源身份线，canonicalKey 指出预期目标。
// 两者都写入，后续可以判断冲突是向 canonical 收敛还是反向写入。
        input.conflict.sourceKey,
        input.canonicalKey,
        now,
      );
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

// alias 是读路径的唯一权威：写入即代表该路径的历史身份线已收敛。
// 用 upsert 而非先删后插，保证并发读永远能看到一条有效映射。
// created_at 只在首次插入时写，updated_at 每次刷新，便于审计最近一次发布。
// 本方法不自身开事务，调用方负责把 alias 与 ledger 变更放在同一事务。
// 失败时抛给上层回滚，绝不吞掉错误留下半发布状态。
// alias 是读路径的唯一权威：写入即代表该路径的历史身份线已收敛。
// 用 upsert 而非先删后插，保证并发读永远能看到一条有效映射。
// created_at 只在首次插入时写，updated_at 每次刷新，便于审计最近一次发布。
// 本方法不自身开事务，调用方负责把 alias 与 ledger 变更放在同一事务。
// 失败时抛给上层回滚，绝不吞掉错误留下半发布状态。
  private writeAlias(db: Database, workspacePath: string, canonicalKey: string): void {
    const now = this.now();
    db.prepare(`
      INSERT INTO workspace_alias (path, canonical_key, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET canonical_key = excluded.canonical_key, updated_at = excluded.updated_at
    `).run(workspacePath, canonicalKey, now, now);
  }

// 成功发布 alias 后把该路径所有 failed 行标 completed，清理用户可见的错误。
// 只改 status/error，不动 phase 与备份路径，保留历史迁移的审计信息。
// 一次性按 path 更新，避免逐条查询；同一路径的旧尝试都应被视为已解决。
// 该更新与 alias 写入共享事务，任何一步失败都不会出现“已解决但无映射”。
  private markFailedPathResolved(db: Database, workspacePath: string): void {
    db.prepare(`
      UPDATE workspace_migration_ledger
      SET status = 'completed', error = NULL, updated_at = ?
      WHERE path = ? AND status = 'failed'
    `).run(this.now(), workspacePath);
  }

// ledger 是迁移的唯一事实来源：计划、阶段、备份路径与代际都在这一行。
// 新建时 phase 固定为 preflight，status 由调用方决定 running 或 failed。
// variants 以 JSON 数组存储，读侧解析失败会按 ledger 损坏处理。
// 备份路径即使尚未真正创建也要先写入，恢复时才能定位预期快照。
// session_db_generation 可空，表示本次计划不涉及 session 库。
// 插入不包事务：调用方紧接着的写操作应与之同事务才能保证原子性。
  private writeLedger(
    db: Database,
    input: {
      migrationId: string;
      workspacePath: string;
      canonicalKey: string;
      variants: string[];
      status: "running" | "completed" | "failed";
      taskBackupPath: string;
      sessionBackupPath: string | null;
      sessionDatabaseGeneration: string | null;
    },
  ): void {
    const now = this.now();
    db.prepare(`
      INSERT INTO workspace_migration_ledger (
        migration_id, path, canonical_key, variant_keys_json, status, phase,
        task_backup_path, session_backup_path, created_at, updated_at,
        session_db_generation
      ) VALUES (?, ?, ?, ?, ?, 'preflight', ?, ?, ?, ?, ?)
    `).run(
// 新 ledger 的 migrationId 由调用方或随机生成器给定，是后续所有审计的关联键。
      input.migrationId,
      input.workspacePath,
      input.canonicalKey,
      JSON.stringify(input.variants),
// 初始状态由调用方决定；正常建计划传 running，冲突审计传 failed。
      input.status,
// task 备份路径落库，恢复时无需再拼目录名。
      input.taskBackupPath,
// null 与空串语义不同：null 表示计划未包含 session 库。
      input.sessionBackupPath,
      now,
      now,
// 代际是恢复时判断“同一库”的唯一证据，必须与备份同时写入。
      input.sessionDatabaseGeneration,
    );
  }
}
