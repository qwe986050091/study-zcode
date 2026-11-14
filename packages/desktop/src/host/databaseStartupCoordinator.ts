import { randomUUID } from "node:crypto";
import {
  classifyDatabaseStartupError,
  canRetryDatabaseStartup,
  databaseStartupErrorDetails,
  databaseMigrationFactsSchema,
  type DatabaseStartupState,
  type DatabaseMigrationFacts,
  type StartupDiskSummary,
} from "@zcode/shared";

type Report = (
  phase: DatabaseStartupState["phase"],
  databasePhase?: DatabaseStartupState["databasePhase"],
  details?: { databaseId: string; migration?: DatabaseMigrationFacts; finalDatabase?: boolean },
) => void;

/** 每窗口一个启动所有者。失败只由显式 retry 推进，刷新和重复请求不重新执行 SQL。 */
// 职责：持有启动状态机（starting → preparing_* → starting_services → ready | failed），
// 把 prepare 上报的 phase / migration 事实归一成 DatabaseStartupState 并发布。
// 输入输出：输入 prepare(report) 与 publish(state)；snapshot 返回 structuredClone。
// 副作用：调用 publish（失败被吞，不影响数据库执行结果）；不直接写数据库。
// 失败语义：prepare 抛错 → 记录 failedPhase / errorCode / sqliteCode 等并上报 failed，
// 不重试；retry 仅在 !running && canRetry && attemptId 匹配时才推进。
// 维护的不变量：start 幂等（started 标志）；retry 换代时 attemptId 重新生成并清空
// migration/baseline，旧 attemptId 的 retry 请求被忽略；sequence 每次发布单调 +1。

export class DatabaseStartupCoordinator {
  private readonly baselines = new Map<string, string | null | undefined>();
  private readonly migrations = new Map<string, DatabaseMigrationFacts>();
  private running = false;
  private started = false;
  private state: DatabaseStartupState;
  constructor(
    private readonly options: {
      startupId?: string;
      prepare: (report: Report) => Promise<void>;
      publish: (state: DatabaseStartupState) => void;
    },
  ) {
    const now = Date.now();
    this.state = {
      schemaVersion: 1,
      startupId: options.startupId ?? randomUUID(),
      attemptId: randomUUID(),
      sequence: 0,
      startedAt: now,
      updatedAt: now,
      phase: "starting",
      disk: [],
    };
  }
  // 只读快照：structuredClone 隔离内部 state，调用方拿到的是值拷贝，不能回写。
  get snapshot(): DatabaseStartupState {
    return structuredClone(this.state);
  }
  // 发布当前状态；publish 抛错必须吞掉——通知失败不能改变数据库启动结果。
  publish(): void {
    try {
      this.options.publish(this.snapshot);
    } catch {
      /* 通知故障不能改变数据库执行结果。 */
    }
  }
  // 更新磁盘观测：整体替换 disk 并推进 sequence / updatedAt。
  // 磁盘数据是瞬时观测，不做累积（跌幅已由采样器内部保留峰值）。
  updateDisk(disk: StartupDiskSummary[]): void {
    this.state = { ...this.state, disk, sequence: this.state.sequence + 1, updatedAt: Date.now() };
    this.publish();
  }
  // 启动一次（幂等）：started 置位后重复调用直接返回，保证 prepare 不重复执行 SQL。
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.run();
  }
  // 重试一次失败启动（换代）。
  // 三道门槛：非 running、canRetryDatabaseStartup(state) 为真、attemptId 与当前一致；
  // attemptId 是防陈旧请求的 fencing token——旧窗口/旧渲染进程的重试不能推进新一次启动。
  // 换代时清空 migrations 与 baselines，避免把上一轮的迁移事实带进新 attempt。
  async retry(attemptId: string): Promise<void> {
    if (this.running || !canRetryDatabaseStartup(this.state) || attemptId !== this.state.attemptId)
      return;
    this.migrations.clear();
    this.baselines.clear();
    this.state = {
      ...this.state,
      migration: undefined,
      currentMigration: undefined,
      migrationBaselines: undefined,
      finalDatabase: undefined,
      attemptId: randomUUID(),
      startedAt: Date.now(),
      phase: "starting",
      errorCode: undefined,
      sqliteCode: undefined,
      systemCode: undefined,
      migrationId: undefined,
      failedPhase: undefined,
      databasePhase: undefined,
      disk: [],
    };
    await this.run();
  }
  // 执行一轮 prepare 并把所有 report 归一成 state。
  // running 保证同一时刻只有一次 prepare；finally 必清 running，避免失败后永久锁死重试。
  // 失败语义：prepare 抛错时不向外抛出，而是转成 failed 状态再发布（调用方看到的是状态）。
  private async run(): Promise<void> {
    this.running = true;
    const report: Report = (phase, databasePhase, details) => {
      if (details) {
        // 仅首次可信锁内值可替换 unknown；后续无事实通知不能抹掉起点。
        if (
          !this.baselines.has(details.databaseId) ||
          this.baselines.get(details.databaseId) === undefined
        )
          this.baselines.set(details.databaseId, details.migration?.lastAppliedMigrationId);
      }
      if (details?.migration) {
        const previous = this.migrations.get(details.databaseId);
        const next = details.migration;
        // 预检可能发现待迁移、拿锁后却由别的执行者完成；需求不丢，执行/提交不虚增。
        const kind =
          previous?.kind === "upgrade" || next.kind === "upgrade"
            ? "upgrade"
            : previous?.kind === "initialize" || next.kind === "initialize"
              ? "initialize"
              : "none";
        this.migrations.set(details.databaseId, { ...next, kind });
      }
      const migration = this.migrations.size
        ? [...this.migrations.values()].reduce<DatabaseMigrationFacts>(
            (sum, facts) => ({
              kind:
                sum.kind === "upgrade" || facts.kind === "upgrade"
                  ? "upgrade"
                  : sum.kind === "initialize" || facts.kind === "initialize"
                    ? "initialize"
                    : "none",
              executedCount: sum.executedCount + facts.executedCount,
              committedCount: sum.committedCount + facts.committedCount,
            }),
            { kind: "none", executedCount: 0, committedCount: 0 },
          )
        : undefined;
      this.state = {
        ...this.state,
        phase,
        databasePhase,
        migration,
        // tasks-index 是固定内部 ID，会话库 ID 由 CLI 对真实路径哈希生成。
        migrationBaselines: [...this.baselines].map(([databaseId, lastAppliedMigrationId]) => ({
          databaseId,
          databaseKind: databaseId === "tasks-index" ? "tasks-index" : "session",
          lastAppliedMigrationId,
        })),
        currentMigration: details?.migration,
        finalDatabase: details?.finalDatabase,
        sequence: this.state.sequence + 1,
        updatedAt: Date.now(),
      };
      this.publish();
    };
    report("starting");
    try {
      await this.options.prepare(report);
      report("ready");
    } catch (error) {
      this.state = {
        ...this.state,
        failedPhase: this.state.phase,
        errorCode: classifyDatabaseStartupError(error),
        ...databaseStartupErrorDetails(error),
      };
      const update = (
        error as { migrationUpdate?: { databaseId?: unknown; migration?: unknown } } | null
      )?.migrationUpdate;
      const facts = databaseMigrationFactsSchema.safeParse(update?.migration);
      report(
        "failed",
        undefined,
        facts.success && typeof update?.databaseId === "string"
          ? { databaseId: update.databaseId, migration: facts.data }
          : undefined,
      );
    } finally {
      this.running = false;
    }
  }
}
