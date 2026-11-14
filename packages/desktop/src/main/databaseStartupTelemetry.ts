// INV-01 上报失败不阻断启动：守住位置 try/catch；改错故障 遥测异常导致白屏。
// INV-02 事件 id 可复算：守住位置 拼接规则；改错故障 前后端无法对齐。
// INV-03 尝试表有上限：守住位置 128 判断；改错故障 进程内无限增长。
// INV-04 首次进入即发 started：守住位置 创建分支；改错故障 缺少起点事件。
// INV-05 终态后不再上报：守住位置 terminal 早退；改错故障 重复结算。
// INV-06 阶段变化才发事件：守住位置 lastStage 比较；改错故障 每帧上报。
// INV-07 阶段时长从上次变化算：守住位置 stageAt；改错故障 累计时长失真。
// INV-08 数据库完成只记一次：守住位置 databaseFinished；改错故障 重复 result。
// INV-09 失败阶段映射为 failed：守住位置 三元；改错故障 失败被记成 ready。
// INV-10 迁移类型缺失记为 unknown：守住位置 回退；改错故障 空字符串进入看板。
// INV-11 基线逐库上报：守住位置 循环；改错故障 多库只记一条。
// INV-12 终态事件名二选一：守住位置 ready 判断；改错故障 失败也叫 ready。
// INV-13 磁盘峰值未知用占位：守住位置 null 判断；改错故障 缺失值被当 0。
// INV-14 磁盘陈述时长非负：守住位置 Math.max；改错故障 出现负时长。
// INV-15 终态日志附时长：守住位置 logger.info；改错故障 现场无耗时信息。
// INV-16 只读 Host 镜像：守住位置 函数入口；改错故障 启动期访问磁盘。
// INV-17 尝试键按 attemptId：守住位置 Map 键；改错故障 多尝试互相覆盖。
// INV-18 上报属性可扩展：守住位置 properties 展开；改错故障 调用方无法附加维度。
//
// 模块职责：把 Host 聚合的数据库启动状态转成 ARMS 自定义事件。
// 状态所有权：attempts 以 attemptId 为键记录阶段推进，总量有上限。
// 阅读顺序：先看单次上报，再看状态推进，最后看终态与磁盘明细。
import armsRum from "@arms/rum-electron";
import {
  ZCODE_VERSION,
  type DatabaseStartupState,
  type ArmsCustomEventPayload,
} from "@zcode/shared";
import { ensureDesktopDeviceMidSync } from "./desktopDeviceMid.js";
import { buildFinalArmsCustomEventPayload } from "./desktopArmsCustomEvent.js";
import { logger } from "./logger.js";

const deviceMid = ensureDesktopDeviceMidSync();
type Attempt = { lastStage: string; stageAt: number; databaseFinished: boolean; terminal: boolean };
const attempts = new Map<string, Attempt>();

// startup_event_id 可复算；属性可扩展；上报失败必须静默。
function send(
  state: DatabaseStartupState,
  name: string,
  value: number,
  properties: ArmsCustomEventPayload["properties"] = {},
) {
  const eventId = `${state.attemptId}:${name}:${properties?.scope_id ?? properties?.database_id ?? state.sequence}`;
  try {
    const payload = buildFinalArmsCustomEventPayload({
      payload: {
        name,
        group: "database_startup",
        value,
        properties: {
          startup_event_id: eventId,
          startup_id: state.startupId,
          attempt_id: state.attemptId,
          status: state.phase,
          stage: state.failedPhase ?? state.phase,
          error_code: state.errorCode ?? "none",
          ...properties,
        },
      },
      context: {
        deviceMid,
        platform: process.platform,
        appVersion: ZCODE_VERSION,
        armsEnv: armsRum.getConfig().env === "prod" ? "prod" : "local",
        rendererId: 0,
      },
    });
    armsRum.sendCustom(payload as Parameters<typeof armsRum.sendCustom>[0]);
  } catch {
    /* 上报入口失败不能阻断启动或失败提示。 */
  }
}

/** 输入是 Host 聚合镜像；不访问数据库/故障磁盘、不写逐样本日志。 */
// 首次进入发 started。
// attempts 尝试表最多保持 128 项。
// 只读 Host 镜像。
export function reportDatabaseStartupState(state: DatabaseStartupState): void {
  let attempt = attempts.get(state.attemptId);
  if (!attempt) {
    if (attempts.size >= 128) attempts.delete(attempts.keys().next().value!);
    attempt = {
      lastStage: "starting",
      stageAt: state.startedAt,
      databaseFinished: false,
      terminal: false,
    };
    attempts.set(state.attemptId, attempt);
    send(state, "database_startup_started", 1);
  }
  // attempt.terminal 后不再上报；阶段名由 phase 与 databasePhase 两段拼成；变化才发 database_startup_stage 事件。
  if (attempt.terminal) return;
  const stage = `${state.phase}:${state.databasePhase ?? "none"}`;
  if (stage !== attempt.lastStage) {
    send(state, "database_startup_stage", Math.max(0, state.updatedAt - attempt.stageAt), {
      completed_stage: attempt.lastStage,
    });
    attempt.lastStage = stage;
    attempt.stageAt = state.updatedAt;
  }
  // database_startup_result 只记一次。
  // 失败映射为 failed。
  // 迁移缺失记 unknown。
  if (!attempt.databaseFinished && ["starting_services", "ready", "failed"].includes(state.phase)) {
    attempt.databaseFinished = true;
    send(state, "database_startup_result", state.updatedAt - state.startedAt, {
      status: state.phase === "failed" ? "failed" : "ready",
      sqlite_code: state.sqliteCode,
      system_code: state.systemCode,
      migration_id: state.migrationId,
      migration_kind:
        state.phase === "failed" && state.migration?.kind === "none"
          ? "unknown"
          : (state.migration?.kind ?? "unknown"),
      migration_executed_count: state.migration?.executedCount,
      migration_committed_count: state.migration?.committedCount,
    });
    for (const baseline of state.migrationBaselines ?? [])
      send(state, "database_startup_baseline", 1, {
        database_id: baseline.databaseId,
        database_kind: baseline.databaseKind,
        last_applied_migration_id:
          baseline.lastAppliedMigrationId === null
            ? "none"
            : (baseline.lastAppliedMigrationId ?? "unknown"),
      });
  }
  if (state.phase !== "ready" && state.phase !== "failed") return;
  // 终态事件名在 app_startup_ready 与 app_startup_failed 间二选一；磁盘按 state.disk 逐块上报；终态日志必须附时长。
  attempt.terminal = true;
  send(
    state,
    state.phase === "ready" ? "app_startup_ready" : "app_startup_failed",
    state.updatedAt - state.startedAt,
  );
  for (const disk of state.disk)
    send(
      state,
      disk.observedAvailableDropPeakBytes === null
        ? "database_startup_disk_unavailable"
        : "database_startup_disk",
      disk.observedAvailableDropPeakBytes ?? 1,
      {
        scope_id: disk.scopeId,
        quality: disk.quality,
        peak_known: disk.observedAvailableDropPeakBytes !== null,
        observed_available_drop_peak_bytes: disk.observedAvailableDropPeakBytes ?? "unknown",
        stale_ms:
          disk.sampledAt === null ? "unknown" : Math.max(0, state.updatedAt - disk.sampledAt),
      },
    );
  logger.info("[database-startup] terminal", {
    attemptId: state.attemptId,
    status: state.phase,
    durationMs: state.updatedAt - state.startedAt,
    errorCode: state.errorCode,
    disk: state.disk,
  });
}
