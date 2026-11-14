// ============================================================
// project-memory-dream —— 后台记忆整合（dream / consolidation）
// ============================================================
//
// 【职责】在满足节流条件时，后台把最近若干会话的 transcript 交给受限 agent，
//   由它合并 / 去重 / 清理 memory 目录；完成后把本次改动的文件登记为
//   pendingMemoryUpdate，并在下一个 turn 以 memory_update 提醒注入。
//
// 【触发条件（全部满足才真正执行）】
//   1. project Memory 已启用、非 remote workspace、有 sessionStore/fileSystemPort/modelIoDir；
//   2. evaluateAutoDreamTiming 判定非 skip（整合自身的节流）；
//   3. 与当前 workspace 同源、非当前会话的主任务 transcript >= 5 个；
//   4. 成功 acquireDreamLock（跨进程互斥，防止两个 CLI 同时整合）。
//
// 【锁语义】acquireDreamLock 返回 null 表示未拿到锁 → 本次直接跳过；
//   拿到锁后若执行抛错，用 restoreDreamLockAfterFailure 把 mtime 还原，
//   让下一次调度仍可重试（还原失败不再追加第二套恢复机制）。
//
// 【副作用】写 memory 目录（工具调用）、更新 memoryDreamLastScanAtMs、
//   设置 pendingMemoryUpdate、失效对应路径的 recall / read 状态；
//   telemetry 以 background + scheduler 上报。
//
// 【当前状态】产品链路暂不自动触发本函数；runProjectMemoryDream 是保留的可等待入口。
// ============================================================
import { basename, join, resolve } from "node:path";

import type { SessionInfo, TraceContext } from "../deps.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeAttachmentEntry,
} from "../../agent/message-history.js";
import {
  acquireDreamLock,
  buildMemoryDreamPrompt,
  collectDreamTouchedPaths,
  evaluateAutoDreamTiming,
  readDreamLastConsolidatedAt,
  restoreDreamLockAfterFailure,
} from "../../memory/dream.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { findLatestReadFileState } from "../../tool/read-file-state.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  prepareProjectMemoryAgentRequest,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { invalidateProjectMemoryRecallPaths } from "./project-memory-recall.js";
import { isMainMemoryTaskType, resolveEnabledProjectMemoryRoot } from "./project-memory.js";

// 至少 5 个“有新 transcript”的会话才值得整合：单会话整合收益低，不值得付后台模型成本。
const DREAM_MINIMUM_TRANSCRIPT_SESSIONS = 5;
// 单次整合最多 50 轮工具调用：给合并多文件留余量，同时设上限防止后台失控。
const DREAM_MAX_TURNS = 50;
/**
 * 待注入的“记忆已更新”通知载荷。
 */
export interface ProjectMemoryUpdate {
  /** 改动文件中，当前上下文已加载副本的路径（需要提示模型重读）。 */
  inContextPaths: string[];
  /** 本次被工具实际改动的文件（去重后）。 */
  paths: string[];
  /** 固定为 "dream"，用于区分其他来源的 memory 更新。 */
  source: "dream";
  /** 人类可读的一行摘要，注入文本使用。 */
  summary: string;
}

/**
 * 从会话列表中挑出可参与整合的 transcript 会话。
 * 输入：当前 sessionId、全部会话、workspacePath / workspaceIdentity。
 * 输出：候选会话（排除当前会话，仅保留主任务类型且同 workspace）。
 * 语义：优先用 workspaceIdentity 精确匹配 workspaceID；未配置时回退到
 *   resolve(directory) 比较，避免同一路径的软链接 / 相对路径写法差异。
 * 副作用：无。
 */
export function selectProjectDreamSessions(input: {
  currentSessionId: AgentRuntimeInternal["sessionId"];
  sessions: readonly SessionInfo[];
  workspacePath: string;
  workspaceIdentity?: string;
}): SessionInfo[] {
  const workspaceIdentity = input.workspaceIdentity?.trim();
  const workspacePath = workspaceIdentity ? undefined : resolve(input.workspacePath);

  return input.sessions.filter((session) => {
    if (session.id === input.currentSessionId) return false;
    if (!isMainMemoryTaskType(session.taskType)) return false;
    if (workspaceIdentity) return session.workspaceID === workspaceIdentity;
    return resolve(session.directory) === workspacePath;
  });
}

// 当前产品链路不自动触发 Dream；保留可等待的 handler，待 project transcript 隔离方案确定后再接线。
/**
 * Dream 入口（当前不自动接线）：完成门禁与上下文捕获后执行整合。
 * 输入：runtime + traceContext。
 * 输出：Promise<void>。
 * 副作用：同 executeProjectMemoryDream（后台写 memory 目录）。
 * 降级：未启用 / remote / 缺少 store 或 modelIoDir 时直接返回，不抛错。
 * 注意：上下文在此捕获，保证后台看到的是入口时刻的历史快照。
 */
export async function runProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  input: { traceContext: TraceContext },
): Promise<void> {
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;
  if (!runtime.modelIoDir) return;

  const context = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    operation: "project_memory_dream",
    traceContext: input.traceContext,
  });
  await executeProjectMemoryDream(runtime, context);
}

/**
 * 取出并清空 pendingMemoryUpdate，包装成 memory_update 系统提醒条目。
 * 输入：runtime。
 * 输出：附件条目；没有待处理更新时 undefined。
 * 副作用：清空 runtime.pendingMemoryUpdate（一次性消费，不会重复注入）。
 */
export function consumePendingProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
): RuntimeAttachmentEntry | undefined {
  const update = runtime.pendingMemoryUpdate;
  if (!update) return undefined;
  runtime.pendingMemoryUpdate = undefined;
  return systemReminderAttachmentEntry("memory_update", formatProjectMemoryUpdate(update));
}

/**
 * 执行一次 Dream：节流判断 → 选会话 → 检查 transcript 新鲜度 → 加锁 → 跑 agent loop。
 * 输入：runtime + 上下文快照。
 * 输出：Promise<void>。
 * 副作用：写 memory 目录、更新 memoryDreamLastScanAtMs、设置 pendingMemoryUpdate、
 *   失效 recall 路径、上报 telemetry。
 * 降级：节流 / 会话不足 / 未拿到锁都记为 metadata 并正常结束；
 *   异常记为 failed，并在已加锁时尝试还原 mtime。
 */
async function executeProjectMemoryDream(
  runtime: AgentRuntimeInternal,
  context: ProjectMemoryAgentContext,
): Promise<void> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: context.causation,
    executionKind: "background",
    operation: "project_memory_dream",
    targetKind: "project_memory",
    traceContext: context.traceContext,
    trigger: "scheduler",
  });

  await telemetry.run(async () => {
    let acquiredPriorMtimeMs: number | undefined;
    try {
      const nowMs = runtime.now().getTime();
      const lastConsolidatedAtMs = await readDreamLastConsolidatedAt(context.memoryRoot);
      const timing = evaluateAutoDreamTiming({
        lastConsolidatedAtMs,
        lastScanAtMs: runtime.memoryDreamLastScanAtMs,
        nowMs,
      });
      if (timing.decision === "skip") {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }

      // 先记录扫描时间：即使后续因会话不足提前返回，也避免每个 turn 重复 listSessions / stat。
      runtime.memoryDreamLastScanAtMs = nowMs;
      const sessions = selectProjectDreamSessions({
        currentSessionId: runtime.sessionId,
        sessions: await runtime.sessionStore!.listSessions(),
        workspacePath: context.workspaceRoot,
        workspaceIdentity: runtime.config.memory?.workspaceIdentity,
      });
      const transcriptSessionIds = await recentModelIoSessionIds(
        runtime,
        sessions,
        context,
        lastConsolidatedAtMs,
      );
      // transcript 太少：整合价值低，直接跳过（scanAt 已刷新）。
      if (transcriptSessionIds.length < DREAM_MINIMUM_TRANSCRIPT_SESSIONS) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }

      const priorMtimeMs = await acquireDreamLock({ memoryRoot: context.memoryRoot, nowMs });
      // 未拿到锁：说明另一个进程正在整合，本次直接让出。
      if (priorMtimeMs === null) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return;
      }
      acquiredPriorMtimeMs = priorMtimeMs;

      const prompt = buildMemoryDreamPrompt({
        memoryRoot: context.memoryRoot,
        sessionIds: transcriptSessionIds,
        transcriptRoot: runtime.modelIoDir!,
      });
      const request = prepareProjectMemoryAgentRequest(context, prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, context);
      const touchedPaths = new Set<string>();

      await runMemoryAgentLoop({
        executeTool: (toolCall, options) => {
          collectDreamTouchedPaths(touchedPaths, {
            rootDir: context.memoryRoot,
            toolCall,
            workingDirectory: context.workingDirectory,
            workspaceRoot: context.workspaceRoot,
          });
          return executor.execute(toolCall, {
            signal: options.abortSignal,
            traceContext: context.traceContext,
          });
        },
        maxTurns: DREAM_MAX_TURNS,
        request,
        model: context.model,
        rootDir: context.memoryRoot,
        workingDirectory: context.workingDirectory,
        workspaceRoot: context.workspaceRoot,
      });

      const paths = [...touchedPaths];
      // 只有真正改了文件才登记更新并失效缓存；空的 Dream 不该打扰下一个 turn。
      if (paths.length > 0) {
        runtime.pendingMemoryUpdate = createProjectMemoryUpdate(runtime, paths);
        invalidateProjectMemoryRecallPaths(runtime, paths);
      }
      telemetry.finishCompleted();
    } catch (error) {
      telemetry.finishFailed("execute", "internal", error);
      if (acquiredPriorMtimeMs !== undefined) {
        try {
          await restoreDreamLockAfterFailure({
            memoryRoot: context.memoryRoot,
            priorMtimeMs: acquiredPriorMtimeMs,
          });
        } catch {
          // Dream 已失败；lock 恢复失败不改变前台 turn，也不追加第二套恢复机制。
        }
      }
    }
  });
}

/**
 * 找出“自上次整合后 transcript 有变化”的会话 id。
 * 输入：runtime、候选会话、上下文、上次整合时间。
 * 输出：会话 id 列表（只含 mtime 晚于上次整合的文件）。
 * 语义：以 model-io-*.jsonl 的真实 mtime 为准，而不是 SessionStore.updated
 *   （durable session 可能因无关写入被更新，不能代表 transcript 变化）。
 * 副作用：只 stat 文件。失败：单个会话 stat 失败按“无变化”跳过，不打断整体。
 */
async function recentModelIoSessionIds(
  runtime: AgentRuntimeInternal,
  sessions: readonly SessionInfo[],
  context: ProjectMemoryAgentContext,
  lastConsolidatedAtMs: number,
): Promise<string[]> {
  const sessionIds = await Promise.all(
    sessions.map(async (session) => {
      try {
        const result = await runtime.fileSystemPort!.stat({
          path: join(runtime.modelIoDir!, `model-io-${session.id}.jsonl`),
          trace: context.traceContext,
        });
        // 修复原因：gate 以真实 transcript mtime 为准；SessionStore.updated 只描述
        // durable session，不能代替 transcript 是否在上次 consolidation 后发生变化。
        return result.kind === "file" &&
          result.mtimeMs !== undefined &&
          result.mtimeMs > lastConsolidatedAtMs
          ? String(session.id)
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return sessionIds.filter((sessionId): sessionId is string => sessionId !== undefined);
}

/**
 * 由本次改动路径构造 memory_update 载荷。
 * 输入：runtime + 改动路径。
 * 输出：ProjectMemoryUpdate。
 * 语义：inContextPaths = MEMORY.md 或已被召回 / 已读的文件（这些副本已过期）。
 * 副作用：只读 runtime 状态。
 */
function createProjectMemoryUpdate(
  runtime: AgentRuntimeInternal,
  paths: string[],
): ProjectMemoryUpdate {
  const inContextPaths = paths.filter(
    (path) =>
      basename(path) === "MEMORY.md" ||
      runtime.memoryRecallState.recalledPaths.has(path) ||
      findLatestReadFileState(runtime.readFileState, path) !== undefined,
  );
  return {
    inContextPaths,
    paths,
    source: "dream",
    summary: `consolidated ${paths.length} memory file${paths.length === 1 ? "" : "s"}`,
  };
}

/**
 * 组装 memory_update 提醒正文。
 * 输入：更新载荷。
 * 输出：多行文本（摘要 + 文件列表 + 可选过期提示 + 环境说明）。
 * 语义：把“后台已改文件”声明为 ambient 信息，明确要求模型不要主动向用户播报。
 * 副作用：无。
 */
function formatProjectMemoryUpdate(update: ProjectMemoryUpdate): string {
  const lines = [
    `Background memory consolidation updated your memory directory: ${update.summary}`,
  ];
  if (update.paths.length > 0) {
    lines.push(`Files changed: ${update.paths.join(", ")}`);
  }
  if (update.inContextPaths.length > 0) {
    lines.push(
      `Your loaded copy of ${update.inContextPaths.join(", ")} is now stale relative to disk — Read it again if you need current contents.`,
    );
  }
  lines.push(
    "This is ambient context — do not narrate it to the user unless they ask or it is directly relevant to their request.",
  );
  return lines.join("\n");
}
