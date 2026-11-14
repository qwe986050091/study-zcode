// ============================================================
// SqliteSessionStore —— 会话持久化的唯一落地点（SessionStorePort 实现）
// ============================================================
// 定位：把 runtime 的会话事实（session / message / part / session_entry / todo /
// usage…）写进同一个 SQLite 文件，并向外提供五套端口的实现。本文件只做三件事：
// 打开数据库、做故障注入守卫、把调用转发给 repositories/*；SQL 与排序语义在
// 各 repository 里，读代码时不要在这里找。
//
// 【消息与 part 的写入顺序】
//   固定的两步：先 saveMessage(info)，再对每个 part 调 savePart(part)。
//   顺序有硬约束而不是习惯——part.message_id 带 references message(id)，且迁移时在
//   同一连接上打开的 foreign_keys 之后一直未关闭，先写 part 会直接被外键拒绝。反过来
//   「消息已写、part 未写」是合法且可被读到的中间态：message 与后续 part 之间没有事务
//   包裹，投影会先看到一条没有 part 的消息。
//
// 【投影重建的触发点】
//   本文件不维护任何内存缓存，库就是事实源。读侧每次 messages() 都按
//   (sequence is null, sequence, time_created, rowid) 重放 message、按 message_id
//   归组 part，从零重建整条 transcript。主要入口有：resume、rewind、session fork /
//   workspace fork、compact 保留段计算、workspace checkpoint；另有 highspeed-metrics-
//   persistence 与 persistent-command-facts 等统计/回放路径也会直接调 messages()。
//   因此任何一次写入都会立刻反映在下一次重放里，不存在 "写完要通知某处刷新" 的链路。
//
// 【失败与并发】
//   - 单行写（saveMessage/savePart/…）各自是一条 INSERT ... ON CONFLICT 语句，自身
//     原子；但跨多行的语义（fork bundle、共享上下文导入、状态迁移）必须走
//     begin immediate / commit / rollback 的事务包装，见下面对应方法。
//   - sequence 在同一语句的子查询里取 max+1，依赖 SQLite 单写者模型，因此同库并发
//     写不会拿到重复序号；跨进程写靠 busy_timeout（迁移结束后为 5s）等待写锁，
//     等不到就抛 SQLITE_BUSY，本层不重试，由调用方决定是否重放。
//   - 写失败一律上抛，不做吞异常或降级；半成品由事务回滚或交给下次读取按现状呈现。
// ============================================================
import type { MigrationResult } from "@zcode/shared/sqlite-migrations";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";
import { DatabaseSync } from "node:sqlite";
import type {
  CollaborationMode,
  ClaimLegacySessionWorkspaceInput,
  RepairLegacyRemoteSessionWorkspaceInput,
  RepairRemoteSessionPathsInput,
  CreateScriptWorkflowActivityInput,
  CreateScriptWorkflowRunInput,
  CreateSessionTaskLinkInput,
  CreateSessionInput,
  FileDiff,
  ForkCommitBundle,
  ForkChildSessionMetadata,
  GoalStatus,
  InputHistoryAttachment,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  ListSessionsInput,
  AppUsageQueryInput,
  AppUsageQueryResult,
  LocalSettingStorePort,
  MessageId,
  MessageInfo,
  MessagePart,
  MessageWithParts,
  ModelUsageRecord,
  PartId,
  PermissionRuleset,
  ProjectId,
  SessionEntryInfo,
  SessionEntryType,
  ScriptWorkflowActivityRecord,
  ScriptWorkflowDefinitionRecord,
  ScriptWorkflowEventRecord,
  ScriptWorkflowRunRecord,
  ScriptWorkflowRunStatus,
  ScriptWorkflowStorePort,
  SessionGoal,
  SessionId,
  SessionInfo,
  SessionInputDelivery,
  SessionInputRecord,
  SessionInputStatus,
  SessionTaskLinkRecord,
  SessionRevert,
  SessionStorePort,
  SharedContextImportCommitBundle,
  SharedContextImportTransition,
  TaskUsageQueryInput,
  TaskUsageQueryResult,
  TodoItem,
  ToolUsageRecord,
  TurnUsageRecord,
  UpsertScriptWorkflowDefinitionInput,
  UpdateScriptWorkflowActivityInput,
  UpdateSessionInput,
  UpdateScriptWorkflowRunInput,
  UsageStorePort,
} from "@zcode/contracts";
// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。
import type { JournalStorePort } from "@zcode/dynamic-workflow";
import {
  accountSessionTargetUsage,
  clearSessionTarget,
  cloneSessionTargetForFork,
  createSessionTarget,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  readSessionTarget,
  recoverInterruptedSessionTargetRun,
  setSessionTarget,
  startSessionTargetRun,
  updateSessionTargetSummaryTitle,
  updateSessionTargetStatus,
} from "../session-target.js";
import { SqliteSessionMigrationError } from "./errors.js";
import {
  DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS,
  runSqliteSessionMigrationsAsync,
  type AsyncSqliteMigrationOptions,
} from "./migration-runner.js";
import type {
  ForkCommitFaultStage,
  SessionStoreDebugCounts,
  SqliteSessionStoreOptions,
} from "./options.js";
import { getDefaultSessionDbPath } from "./paths.js";
import { maybeThrowStorageFsFault } from "../fs-fault-injection.js";
import * as debugRepository from "./repositories/debug.js";
import { createDwfJournalStore } from "./repositories/dwf-journal.js";
import * as inputHistoryRepository from "./repositories/input-history.js";
import * as localSettingsRepository from "./repositories/local-settings.js";
import * as messageRepository from "./repositories/messages.js";
import * as scriptWorkflowActivityRepository from "./repositories/script-workflow-activities.js";
import * as scriptWorkflowRunRepository from "./repositories/script-workflow-runs.js";
import * as sessionEntryRepository from "./repositories/session-entries.js";
import * as sessionInputRepository from "./repositories/session-inputs.js";
import * as sessionRepository from "./repositories/sessions.js";
import * as todoRepository from "./repositories/todos.js";
import * as usageRepository from "./repositories/usage.js";

// 从 v4/command_fact 条目里取出 fork 出的 child sessionId；任何一层形状不符都返回 null。
// 这是幂等判断的唯一依据：拿不到 id 说明事实行损坏，调用方应当报错而不是重新建一个 child。
function forkChildSessionId(entry: SessionEntryInfo): SessionId | null {
  if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return null;
  const ack = (entry.data as Record<string, unknown>).ack;
  if (!ack || typeof ack !== "object" || Array.isArray(ack)) return null;
  const result = (ack as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const sessionId = (result as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? (sessionId as SessionId) : null;
}

// fork bundle 落库前的整体自检：所有被复制的 message / part / entry 都必须已经归属
// child session，且引用（anchor、compact boundary、tool 附件）只能指向 bundle 内的
// message。裸 copy 一个父会话的 id 进来会让 child transcript 指向父库的行——读侧不会
// 报错，只会在父会话被删/改写后静默错位，所以这里宁可整批拒绝。
function assertForkBundleChildLocal(bundle: ForkCommitBundle): void {
  const childId = String(bundle.child.id);
  const commandResult = bundle.commandFact.ack.result as unknown;
  const result =
    commandResult && typeof commandResult === "object" && !Array.isArray(commandResult)
      ? (commandResult as Record<string, unknown>)
      : null;
  const sessionId = typeof result?.sessionId === "string" ? result.sessionId.trim() : "";
  const isForkResult =
    result?.type === "forkAssistant" ||
    result?.type === "createSelectionSideSession" ||
    (result?.type === "editUserQuery" && result.disposition === "fork");
  if (!isForkResult || !sessionId || sessionId !== childId) {
    // 缺失或非 fork 的 command result 会留下无法重放到 child 的幂等事实。
    throw new Error("Fork bundle command result is missing, invalid, or not child-local");
  }
  const messageIds = new Set(bundle.messages.map((message) => String(message.info.id)));
  const assertMessage = (value: unknown, field: string) => {
    if (typeof value === "string" && !messageIds.has(value)) {
      throw new Error(`Fork bundle ${field} is not child-local: ${value}`);
    }
  };
  const targetIds = new Set<string>();
  if (bundle.goal) targetIds.add(bundle.goal.source.targetID);
  for (const message of bundle.messages) {
    if (String(message.info.sessionID) !== childId) {
      throw new Error("Fork bundle message session is not child-local");
    }
    if (message.info.role === "assistant" && !messageIds.has(String(message.info.parentID))) {
      throw new Error("Fork bundle assistant parent is not child-local");
    }
    const anchor = message.info.anchor;
    for (const id of anchor?.orderedMessageIds ?? []) {
      assertMessage(id, "anchor orderedMessageId");
    }
    assertMessage(anchor?.boundaryMessageId, "anchor boundaryMessageId");
    if (anchor?.goalBoundary?.kind === "snapshot") {
      if (String(anchor.goalBoundary.target.sessionID) !== childId) {
        throw new Error("Fork bundle anchor goal session is not child-local");
      }
      targetIds.add(anchor.goalBoundary.target.targetID);
    }
    for (const part of message.parts) {
      if (
        String(part.sessionID) !== childId ||
        String(part.messageID) !== String(message.info.id)
      ) {
        throw new Error("Fork bundle part owner is not child-local");
      }
      if (part.type === "timeline") {
        assertMessage(part.anchorMessageId, "timeline anchorMessageId");
        if (part.timelineType === "context_compaction") {
          assertMessage(part.summaryMessageId, "timeline summaryMessageId");
        }
        if (part.timelineType === "goal_verification") targetIds.add(part.targetId);
      }
      if (part.type === "compaction") {
        assertMessage(part.tail_start_id, "compaction tail_start_id");
        assertMessage(part.summaryMessageId, "compaction summaryMessageId");
        const boundary = part.compactBoundary;
        assertMessage(boundary?.lastSummarizedMessageId, "compact lastSummarizedMessageId");
        for (const id of boundary?.summaryMessageIds ?? []) {
          assertMessage(id, "compact summaryMessageId");
        }
        for (const id of boundary?.attachmentMessageIds ?? []) {
          assertMessage(id, "compact attachmentMessageId");
        }
        for (const id of boundary?.hookResultMessageIds ?? []) {
          assertMessage(id, "compact hookResultMessageId");
        }
        assertMessage(boundary?.preservedSegment?.headMessageId, "compact preserved head");
        assertMessage(boundary?.preservedSegment?.anchorMessageId, "compact preserved anchor");
        assertMessage(boundary?.preservedSegment?.tailMessageId, "compact preserved tail");
      }
      if (part.type === "tool" && part.state.status === "completed") {
        for (const attachment of part.state.attachments ?? []) {
          if (
            String(attachment.sessionID) !== childId ||
            String(attachment.messageID) !== String(message.info.id)
          ) {
            throw new Error("Fork bundle tool attachment owner is not child-local");
          }
        }
      }
    }
  }
  if (bundle.goal && String(bundle.goal.source.sessionID) !== childId) {
    throw new Error("Fork bundle goal session is not child-local");
  }
  for (const entry of bundle.entries) {
    if (String(entry.sessionID) !== childId) {
      throw new Error("Fork bundle verifier entry session is not child-local");
    }
    const data =
      entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)
        ? (entry.data as Record<string, unknown>)
        : {};
    const payload =
      data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)
        ? (data.payload as Record<string, unknown>)
        : {};
    assertMessage(payload.anchorAssistantMessageId, "verifier assistant anchor");
    if (typeof payload.targetId === "string" && !targetIds.has(payload.targetId)) {
      throw new Error("Fork bundle verifier target is not child-local");
    }
  }
}


/**
 * SessionStorePort 等的 SQLite 实现。五个端口共用一个 DatabaseSync 实例，因此
 * 「同一个库、同一串行写队列」是这套实现的基本假设：没有连接池，也没有 per-call
 * 加锁，所有写请求在 JS 侧天然串行，跨进程才需要靠 SQLite 的写锁。
 *
 * 注意本类的 async 方法内部都是同步 SQLite 调用：await 只是接口形状，不代表异步 IO。
 * 但 await 之间会让出微任务队列，所以「先 saveMessage 再 savePart」这种多语句序列
 * 仍可能被别的写入穿插，不能当成事务使用。
 */
export class SqliteSessionStore
  implements
    SessionStorePort,
    InputHistoryStorePort,
    LocalSettingStorePort,
    ScriptWorkflowStorePort,
    UsageStorePort
{
  private readonly db: DatabaseSync;
  private readonly dbPath: string;
  private readonly forkCommitFaultAt?: ForkCommitFaultStage;
  private dwfJournalStore?: JournalStorePort;

  private constructor(
    db: DatabaseSync,
    dbPath: string,
    options: SqliteSessionStoreOptions,
    readonly migrationResult: MigrationResult,
  ) {
    this.db = db;
    this.dbPath = dbPath;
    this.forkCommitFaultAt = options.forkCommitFaultAt;
  }

  /**
   * 打开（必要时创建）数据库并跑完迁移。失败分两段处理：
   *   - 打开阶段失败包成 SqliteSessionMigrationError(open_failed)，带上 dbPath 便于
   *     定位是目录不可写还是文件损坏；
   *   - 迁移阶段失败先 close 再原样抛出——close 自己的异常被吞掉，不允许覆盖迁移错误。
   * startupLockTimeoutMs 只作用于打开与迁移的等锁预算；迁移结束后 runner 会把
   * busy_timeout 调回 5s，后续业务写的等锁上限与这里不是同一个值。
   */
  static async open(options: SqliteSessionStoreOptions = {}, migrationOptions?: AsyncSqliteMigrationOptions): Promise<SqliteSessionStore> {
    const dbPath = options.dbPath ?? getDefaultSessionDbPath();
    const startupLockTimeoutMs =
      options.startupLockTimeoutMs ?? DEFAULT_SQLITE_STARTUP_LOCK_TIMEOUT_MS;
    let db: DatabaseSync;
    try {
      if (dbPath !== ":memory:") {
        maybeThrowStorageFsFault({ operation: "mkdir", path: dirname(dbPath) });
        await mkdir(dirname(dbPath), { recursive: true });
      }
      maybeThrowStorageFsFault({ operation: "sqliteOpen", path: dbPath });
      db = new DatabaseSync(dbPath, { timeout: startupLockTimeoutMs });
    } catch (error) {
      throw new SqliteSessionMigrationError(`Failed to open SQLite session database at ${dbPath}`, {
        cause: error,
        dbPath,
        kind: "open_failed",
      });
    }
    try {
      const migration = await runSqliteSessionMigrationsAsync(db, dbPath, migrationOptions ?? { lockWaitTimeoutMs: startupLockTimeoutMs });
      return new SqliteSessionStore(db, dbPath, options, migration);
    } catch (error) {
      try { db.close(); } catch { /* 关闭失败不能覆盖迁移错误。 */ }
      throw error;
    }
  }

  static async openStartup(options: SqliteSessionStoreOptions = {}, migrationOptions: AsyncSqliteMigrationOptions = {}) {
    return SqliteSessionStore.open(options, migrationOptions);
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  private throwBeforeWrite(): void {
    maybeThrowStorageFsFault({ operation: "sqliteRun", path: this.dbPath });
  }

  private maybeThrowForkCommitFault(stage: ForkCommitFaultStage): void {
    if (this.forkCommitFaultAt === stage) {
      throw new Error(`injected fork commit fault: ${stage}`);
    }
  }

  async createSession(input: CreateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.createSession(this.db, input);
  }

  async createForkedSessionWithMetadata(
    input: CreateSessionInput,
    metadata: ForkChildSessionMetadata,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    if (!input.parentID || String(input.parentID) !== metadata.parentSessionId) {
      throw new Error("Fork child metadata parent does not match session parentID");
    }
    const orderedMessageIds = metadata.forkTarget.orderedMessageIds;
    // compact 覆盖首轮 query 时，input 前稳定前缀合法为空；boundaryMessageId 仍记录
    // 被编辑 input，供幂等事实定位，但不会被复制进 child。
    const validBoundary =
      metadata.forkTarget.boundaryMessageId.trim().length > 0 &&
      (orderedMessageIds.length === 0 ||
        orderedMessageIds.at(-1) === metadata.forkTarget.boundaryMessageId);
    if (!metadata.sourceCommandId.trim() || !validBoundary) {
      throw new Error("Fork child metadata is invalid");
    }

    // command key 是 (parentSessionId, sourceCommandId)；session_entry.id 是全库主键，
    // 必须把 parent 纳入 id，避免两个 session 恰好复用 commandId 时互相覆盖事实。
    const entryId = `v4_command_fact:child:${metadata.parentSessionId}:${metadata.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: input.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const childSessionId = forkChildSessionId(existing);
        if (!childSessionId) {
          throw new Error(`Fork child command fact is corrupt: ${entryId}`);
        }
        const child = sessionRepository.getSession(this.db, childSessionId);
        if (!child) {
          throw new Error(`Fork child session is missing: ${childSessionId}`);
        }
        this.db.exec("commit");
        return child;
      }

      const child = sessionRepository.createSession(this.db, input);
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: input.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: {
            commandId: metadata.sourceCommandId,
            status: "accepted",
            revisionAtDecision: 0,
            result: { type: "forkAssistant", sessionId: String(child.id) },
          },
          metadata,
        },
      });
      this.db.exec("commit");
      return child;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /**
   * 一次性提交整个 fork bundle：child session → 复制的 message/part → goal → entries →
   * initial input → 最后写 command_fact。全程一个 begin immediate 事务，任一步抛错
   * （含 forkCommitFaultAt 注入的测试故障）都 rollback，读者要么看到完整 child，要么
   * 什么都看不到。
   *
   * 两个与顺序相关的点：
   *   - command_fact 放在最后写是约定（便于把它当作提交标记）。原子性由单事务 rollback
   *     保证——提前写同样会被回滚，不会留下"事实存在但 child 不存在"的假成功；
   *   - 每次进入事务先按 (parentSessionId, sourceCommandId) 查已有 fact，命中就直接
   *     返回旧 child——重复提交同一 bundle 不会产生第二个会话。
   */
  async commitForkBundle(bundle: ForkCommitBundle): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { child, commandFact, initialInput } = bundle;
    if (
      !child.parentID ||
      String(child.parentID) !== commandFact.parentSessionId ||
      (initialInput && String(initialInput.sessionID) !== String(child.id)) ||
      commandFact.ack.commandId !== commandFact.sourceCommandId
    ) {
      throw new Error("Fork commit bundle identity is invalid");
    }
    const entryId = `v4_command_fact:child:${commandFact.parentSessionId}:${commandFact.sourceCommandId}`;
    this.db.exec("begin immediate");
    try {
      const existing = sessionEntryRepository
        .sessionEntries(this.db, {
          sessionID: child.parentID,
          type: "v4/command_fact",
        })
        .find((entry) => entry.id === entryId);
      if (existing) {
        const existingChildId = forkChildSessionId(existing);
        const existingChild = existingChildId
          ? sessionRepository.getSession(this.db, existingChildId)
          : null;
        if (!existingChild) throw new Error(`Fork bundle command fact is corrupt: ${entryId}`);
        this.db.exec("commit");
        return existingChild;
      }

      assertForkBundleChildLocal(bundle);
      const persistedChild = sessionRepository.createSession(this.db, child);
      this.maybeThrowForkCommitFault("afterChild");
      for (const message of bundle.messages) {
        const messageSource = bundle.copySources?.messages[message.info.id];
        await messageRepository.saveMessage(
          this.db,
          message.info,
          messageSource ? { sessionID: child.parentID, id: messageSource } : undefined,
        );
        for (const part of message.parts) {
          const partSource = bundle.copySources?.parts[part.id];
          await messageRepository.savePart(
            this.db,
            part,
            partSource ? { sessionID: child.parentID, id: partSource } : undefined,
          );
        }
      }
      this.maybeThrowForkCommitFault("afterMessages");
      if (bundle.goal) {
        cloneSessionTargetForFork(this.db, {
          source: bundle.goal.source,
          sessionID: child.id,
          status: bundle.goal.status,
        });
      }
      this.maybeThrowForkCommitFault("afterGoal");
      for (const entry of bundle.entries) {
        sessionEntryRepository.saveSessionEntry(this.db, entry);
      }
      this.maybeThrowForkCommitFault("afterEntries");
      if (initialInput) {
        await sessionInputRepository.saveSessionInput(this.db, initialInput);
      }
      this.maybeThrowForkCommitFault("afterInput");
      const now = Date.now();
      sessionEntryRepository.saveSessionEntry(this.db, {
        id: entryId,
        sessionID: child.parentID,
        type: "v4/command_fact",
        time: { created: now, updated: now },
        data: {
          source: "child",
          ack: commandFact.ack,
          metadata: commandFact.metadata,
        },
      });
      this.maybeThrowForkCommitFault("afterCommandFact");
      this.maybeThrowForkCommitFault("beforeCommit");
      this.db.exec("commit");
      return persistedChild;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /**
   * 共享上下文导入同样是「会话 + 首条 model-only 消息 + provenance 条目」的三件套，
   * 一个事务内完成。幂等键是 provenance.id（内含 session 命名空间，见下方守卫）；
   * 若 session 已存在但条目缺失，说明上一次导入被截断，这里报错而不是补写——补写会
   * 猜错 provenance 的内容。
   */
  async commitSharedContextImportBundle(
    bundle: SharedContextImportCommitBundle,
  ): Promise<SessionInfo> {
    this.throwBeforeWrite();
    const { session, contextMessage, provenance } = bundle;
    if (
      String(contextMessage.info.sessionID) !== String(session.id) ||
      String(provenance.sessionID) !== String(session.id) ||
      // session_entry.id 是全库主键，saveSessionEntry 的 on conflict(id)
      // 会把 session_id 改绑到后写入者。provenance id 若不含 session 命名空间，同一个
      // share 导入到第二个会话时会夺走第一个会话的条目（旧会话 transcript 静默丢失）。
      // 这里在唯一写入口做守卫，覆盖所有调用方，而不是只修某一个构造点。
      !provenance.id.includes(String(session.id)) ||
      contextMessage.info.role !== "user" ||
      contextMessage.info.visibility !== "model-only" ||
      contextMessage.info.source !== "shared_context"
    ) {
      throw new Error("Shared context import bundle identity is invalid");
    }
    this.db.exec("begin immediate");
    try {
      const existing = sessionRepository.getSession(this.db, session.id);
      if (existing) {
        const entry = sessionEntryRepository
          .sessionEntries(this.db, { sessionID: session.id, type: provenance.type })
          .find((candidate) => candidate.id === provenance.id);
        if (!entry) throw new Error("Shared context import session is incomplete");
        this.db.exec("commit");
        return existing;
      }
      const persisted = sessionRepository.createSession(this.db, session);
      await messageRepository.saveMessage(this.db, contextMessage.info);
      for (const part of contextMessage.parts) {
        await messageRepository.savePart(this.db, part);
      }
      sessionEntryRepository.saveSessionEntry(this.db, provenance);
      this.db.exec("commit");
      return persisted;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  /**
   * 共享上下文导入的状态迁移（compare-and-set）：先比对条目的当前 status 是否在
   * expectedStatus 里，不匹配就 rollback 并返回 false（并发或重复调用只会有一次成功）；
   * 匹配时更新 provenance 条目；若能按 entryId 找到那条 model-only 消息，也同步更新其
   * sharedContextStatus（找不到时只更新条目）。两处更新必须在同一事务里，否则读侧会看到
   * 「条目说已导入、消息说还在导入」的裂缝。
   */
  async transitionSharedContextImport(input: SharedContextImportTransition): Promise<boolean> {
    this.throwBeforeWrite();
    this.db.exec("begin immediate");
    try {
      const entry = sessionEntryRepository
        .sessionEntries(this.db, { sessionID: input.sessionID, type: "v4/shared_context_import" })
        .find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === input.contextId,
          );
        });
      if (!entry) {
        this.db.exec("rollback");
        return false;
      }
      const data = entry.data as Record<string, unknown>;
      const expected = Array.isArray(input.expectedStatus)
        ? input.expectedStatus
        : [input.expectedStatus];
      if (!expected.includes(data.status as SharedContextImportTransition["status"])) {
        this.db.exec("rollback");
        return false;
      }
      sessionEntryRepository.saveSessionEntry(this.db, {
        ...entry,
        time: { ...entry.time, updated: Date.now() },
        data: {
          ...data,
          status: input.status,
          ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        },
      });
      const contextMessage = (
        await messageRepository.messages(this.db, { sessionID: input.sessionID })
      ).find((message) => {
        const metadata = message.info.metadata;
        return Boolean(
          metadata &&
          typeof metadata === "object" &&
          (metadata as Record<string, unknown>).contextId === input.contextId,
        );
      });
      if (contextMessage) {
        await messageRepository.saveMessage(this.db, {
          ...contextMessage.info,
          metadata: {
            ...(contextMessage.info.metadata ?? {}),
            sharedContextStatus: input.status,
          },
        });
      }
      this.db.exec("commit");
      return true;
    } catch (error) {
      this.db.exec("rollback");
      throw error;
    }
  }

  async updateSession(input: UpdateSessionInput): Promise<SessionInfo> {
    this.throwBeforeWrite();
    return sessionRepository.updateSession(this.db, input);
  }

  async softDeleteSession(sessionID: SessionId, timeDeleted = Date.now()): Promise<void> {
    this.throwBeforeWrite();
    sessionRepository.softDeleteSession(this.db, sessionID, timeDeleted);
  }

  async getSession(sessionID: SessionId): Promise<SessionInfo | null> {
    return sessionRepository.getSession(this.db, sessionID);
  }

  async listSessions(input: ListSessionsInput = {}): Promise<SessionInfo[]> {
    return sessionRepository.listSessions(this.db, input);
  }

  async claimLegacySessionWorkspace(input: ClaimLegacySessionWorkspaceInput): Promise<number> {
    this.throwBeforeWrite();
    return sessionRepository.claimLegacySessionWorkspace(this.db, input);
  }

  async repairLegacyRemoteSessionWorkspace(
    input: RepairLegacyRemoteSessionWorkspaceInput,
  ): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairLegacyRemoteSessionWorkspace(this.db, input);
  }

  async repairRemoteSessionPaths(input: RepairRemoteSessionPathsInput): Promise<boolean> {
    this.throwBeforeWrite();
    return sessionRepository.repairRemoteSessionPaths(this.db, input);
  }

  // 下面四个 message/part 写入口是投影的唯一数据来源。共同约定：
  //   - 单条写没有事务，写入即对后续读取可见（message 先落、part 随后补齐）；
  //   - copyFrom 用于 fork/复制场景，源行缺失会抛错，不允许静默丢旧版快照；
  //   - 写成功后 repository 会 touchSession 推进会话活动时间，故「写 part」也会把
  //     会话顶到列表前面。
  // 失败语义：异常原样上抛，不回滚已写入的前序行——多行一致性由调用方用事务方法
  // （commitForkBundle / commitSharedContextImportBundle）保证，而不是这几个方法。
  async saveMessage(
    input: MessageInfo,
    copyFrom?: Parameters<SessionStorePort["saveMessage"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.saveMessage(this.db, input, copyFrom);
  }

  async removeMessage(input: { sessionID: SessionId; messageID: MessageId }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removeMessage(this.db, input);
  }

  async savePart(
    input: MessagePart,
    copyFrom?: Parameters<SessionStorePort["savePart"]>[1],
  ): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.savePart(this.db, input, copyFrom);
  }

  async removePart(input: {
    sessionID: SessionId;
    messageID: MessageId;
    partID: PartId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return messageRepository.removePart(this.db, input);
  }

  async messageWithParts(input: {
    sessionID: SessionId;
    messageID: MessageId;
  }): Promise<MessageWithParts | null> {
    return messageRepository.messageWithParts(this.db, input);
  }

  // 整体重放一个会话的投影：两次按 session_id 过滤的查询（message、part），再在内存
  // 里按 message_id 归组。
  // 调用方都是「要重建完整上下文」的场景（resume / rewind / fork / compact 保留段 /
  // checkpoint），不要拿它做单条查询——单条走 messageWithParts。
  // 返回空数组表示会话无消息，而不是会话不存在；会话本身是否存在由 getSession 判断。
  async messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]> {
    return messageRepository.messages(this.db, input);
  }

  async saveSessionEntry(input: SessionEntryInfo): Promise<void> {
    this.throwBeforeWrite();
    return sessionEntryRepository.saveSessionEntry(this.db, input);
  }

  async sessionEntries(input: {
    sessionID: SessionId;
    type?: SessionEntryType | string;
  }): Promise<SessionEntryInfo[]> {
    return sessionEntryRepository.sessionEntries(this.db, input);
  }

  // ── session_input 账本──

  async saveSessionInput(input: {
    id: string;
    sessionID: SessionId;
    kind: string;
    delivery: SessionInputDelivery;
    payload: { text: string; [key: string]: unknown };
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.saveSessionInput(this.db, input);
  }

  async commitPermissionFullAccess(
    input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
  }

  async updateSessionInputs(
    input: Parameters<NonNullable<SessionStorePort["updateSessionInputs"]>>[0],
  ): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.updateSessionInputs(this.db, input);
  }

  async promoteSessionInput(input: {
    id: string;
    sessionID: SessionId;
    message: MessageInfo;
    parts: MessagePart[];
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.promoteSessionInput(this.db, input);
  }

  async markSessionInputPromoted(input: {
    id: string;
    sessionID: SessionId;
    promotedMessageID: MessageId;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.markSessionInputPromoted(this.db, input);
  }

  async settleSessionInput(input: {
    id: string;
    sessionID: SessionId;
    status: "cancelled" | "discarded" | "failed";
    reason?: string;
  }): Promise<void> {
    this.throwBeforeWrite();
    return sessionInputRepository.settleSessionInput(this.db, input);
  }

  async listSessionInputs(input: {
    sessionID: SessionId;
    status?: SessionInputStatus;
  }): Promise<SessionInputRecord[]> {
    return sessionInputRepository.listSessionInputs(this.db, input);
  }

  async getSessionInputById(id: string): Promise<SessionInputRecord | null> {
    return sessionInputRepository.getSessionInputById(this.db, id);
  }

  async readTodos(input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return todoRepository.readTodos(this.db, input);
  }

  async updateTodos(input: { sessionID: SessionId; todos: TodoItem[] }): Promise<void> {
    this.throwBeforeWrite();
    return todoRepository.updateTodos(this.db, input);
  }

  async readTarget(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return readSessionTarget(this.db, input);
  }

  async setTarget(input: {
    objective: string;
    sessionID: SessionId;
    status?: GoalStatus;
    tokenBudget?: number | null;
  }): Promise<SessionGoal> {
    return setSessionTarget(this.db, {
      objective: input.objective,
      sessionID: input.sessionID,
      status: input.status ?? "active",
      tokenBudget: input.tokenBudget,
    });
  }

  async cloneTargetForFork(input: {
    source: SessionGoal;
    sessionID: SessionId;
    status?: GoalStatus;
  }): Promise<SessionGoal> {
    this.throwBeforeWrite();
    return cloneSessionTargetForFork(this.db, {
      source: input.source,
      sessionID: input.sessionID,
      status: input.status ?? input.source.status,
    });
  }

  async createTarget(input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
  }): Promise<SessionGoal | null> {
    return createSessionTarget(this.db, input);
  }

  async updateTargetStatus(input: {
    sessionID: SessionId;
    status: GoalStatus;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetStatus(this.db, input);
  }

  async startTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  }): Promise<SessionGoal | null> {
    return startSessionTargetRun(this.db, input);
  }

  async heartbeatTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  }): Promise<SessionGoal | null> {
    return heartbeatSessionTargetRun(this.db, input);
  }

  async finishTargetRun(input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  }): Promise<SessionGoal | null> {
    return finishSessionTargetRun(this.db, input);
  }

  async recoverInterruptedTargetRun(input: { sessionID: SessionId }): Promise<SessionGoal | null> {
    return recoverInterruptedSessionTargetRun(this.db, input);
  }

  async accountTargetUsage(input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  }): Promise<SessionGoal | null> {
    return accountSessionTargetUsage(this.db, input);
  }

  async updateTargetSummaryTitle(input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  }): Promise<SessionGoal | null> {
    return updateSessionTargetSummaryTitle(this.db, input);
  }

  async clearTarget(input: { sessionID: SessionId }): Promise<boolean> {
    return clearSessionTarget(this.db, input);
  }

  async recordModelUsage(input: ModelUsageRecord): Promise<void> {
    return usageRepository.recordModelUsage(this.db, input);
  }

  async upsertTurnUsage(input: TurnUsageRecord): Promise<void> {
    return usageRepository.upsertTurnUsage(this.db, input);
  }

  async upsertToolUsage(input: ToolUsageRecord): Promise<void> {
    return usageRepository.upsertToolUsage(this.db, input);
  }

  async pruneUsage(input?: { beforeTime?: number }): Promise<void> {
    return usageRepository.pruneUsage(this.db, input);
  }

  async queryAppUsage(input: AppUsageQueryInput): Promise<AppUsageQueryResult> {
    return usageRepository.queryAppUsage(this.db, input);
  }

  async queryTaskUsage(input: TaskUsageQueryInput): Promise<TaskUsageQueryResult> {
    return usageRepository.queryTaskUsage(this.db, input);
  }

  async recordInputHistory(input: {
    projectID: ProjectId;
    sessionID?: SessionId;
    text: string;
    attachments?: InputHistoryAttachment[];
    kind: InputHistoryKind;
    time?: { created?: number };
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recordInputHistory(this.db, input);
  }

  async recallPreviousInputHistory(input: {
    projectID: ProjectId;
    skip?: number;
  }): Promise<InputHistoryEntry | null> {
    return inputHistoryRepository.recallPreviousInputHistory(this.db, input);
  }

  async getProjectPermission(projectID: ProjectId): Promise<PermissionRuleset | null> {
    return localSettingsRepository.getProjectPermission(this.db, projectID);
  }

  async saveProjectPermission(input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  }): Promise<PermissionRuleset> {
    return localSettingsRepository.saveProjectPermission(this.db, input);
  }

  getProjectPermissionMode(projectID: ProjectId): CollaborationMode | null {
    return localSettingsRepository.getProjectPermissionMode(this.db, projectID);
  }

  saveProjectPermissionMode(input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  }): CollaborationMode {
    return localSettingsRepository.saveProjectPermissionMode(this.db, input);
  }

  async setRevert(input: {
    sessionID: SessionId;
    revert: SessionRevert;
    summary?: { additions: number; deletions: number; files: number; diffs?: FileDiff[] };
  }): Promise<void> {
    return sessionRepository.setRevert(this.db, input);
  }

  async clearRevert(sessionID: SessionId): Promise<void> {
    return sessionRepository.clearRevert(this.db, sessionID);
  }

  async upsertScriptWorkflowDefinition(
    input: UpsertScriptWorkflowDefinitionInput,
  ): Promise<ScriptWorkflowDefinitionRecord> {
    return scriptWorkflowRunRepository.upsertScriptWorkflowDefinition(this.db, input);
  }

  async createScriptWorkflowRun(
    input: CreateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.createScriptWorkflowRun(this.db, input);
  }

  async updateScriptWorkflowRun(
    input: UpdateScriptWorkflowRunInput,
  ): Promise<ScriptWorkflowRunRecord> {
    return scriptWorkflowRunRepository.updateScriptWorkflowRun(this.db, input);
  }

  async getScriptWorkflowRun(runId: string): Promise<ScriptWorkflowRunRecord | null> {
    return scriptWorkflowRunRepository.getScriptWorkflowRun(this.db, runId);
  }

  async listScriptWorkflowRuns(input?: {
    cwd?: string;
    limit?: number;
    statuses?: readonly ScriptWorkflowRunStatus[];
  }): Promise<ScriptWorkflowRunRecord[]> {
    return scriptWorkflowRunRepository.listScriptWorkflowRuns(this.db, input);
  }

  async createScriptWorkflowActivity(
    input: CreateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.createScriptWorkflowActivity(this.db, input);
  }

  async updateScriptWorkflowActivity(
    input: UpdateScriptWorkflowActivityInput,
  ): Promise<ScriptWorkflowActivityRecord> {
    return scriptWorkflowActivityRepository.updateScriptWorkflowActivity(this.db, input);
  }

  async findCachedScriptWorkflowActivity(input: {
    callPath: string;
    inputHash: string;
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord | null> {
    return scriptWorkflowActivityRepository.findCachedScriptWorkflowActivity(this.db, input);
  }

  async listScriptWorkflowActivities(input: {
    runId: string;
  }): Promise<ScriptWorkflowActivityRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowActivities(this.db, input);
  }

  async appendScriptWorkflowEvent(input: {
    activityId?: string;
    id: string;
    payload?: unknown;
    phase?: string;
    runId: string;
    type: string;
  }): Promise<ScriptWorkflowEventRecord> {
    return scriptWorkflowActivityRepository.appendScriptWorkflowEvent(this.db, input);
  }

  async listScriptWorkflowEvents(input: {
    limit?: number;
    runId: string;
  }): Promise<ScriptWorkflowEventRecord[]> {
    return scriptWorkflowActivityRepository.listScriptWorkflowEvents(this.db, input);
  }

  async createSessionTaskLink(input: CreateSessionTaskLinkInput): Promise<SessionTaskLinkRecord> {
    return scriptWorkflowActivityRepository.createSessionTaskLink(this.db, input);
  }

  /**
   * dynamic-workflow 执行引擎的 durable journal（dwf_* 表）。端口是同步的，所以这里返回
   * 端口对象本身而不是逐方法转发——引擎持有它、按自己的节奏读写。
   */
  workflowJournalStore(): JournalStorePort {
    this.dwfJournalStore ??= createDwfJournalStore(this.db);
    return this.dwfJournalStore;
  }

  debugMigrationIds(): string[] {
    return debugRepository.debugMigrationIds(this.db);
  }

  debugCounts(sessionID?: SessionId): SessionStoreDebugCounts {
    return debugRepository.debugCounts(this.db, sessionID);
  }
}

export function createSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open(options);
}

export function openStartupSqliteSessionStore(
  options: SqliteSessionStoreOptions = {},
): Promise<SqliteSessionStore> {
  return SqliteSessionStore.open(options);
}

export { getDefaultSessionDbPath };
