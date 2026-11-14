// ============================================================
// project-memory-extraction —— turn 结束后的后台记忆抽取调度
// ============================================================
//
// 【职责】在主 turn 结束时按需调度一次后台 Extraction：
//   扫描该 workspace 的 Memory manifest，让后台 agent 把本次对话中值得
//   长期保留的事实写入 memory 目录。
//
// 【快照边界（为什么不直接用 runtime 计数）】
//   调度发生在 turn 末尾，但真正执行是异步的。这里记录
//   latestConversationMessageId 作为边界，并回查 SessionStore 的当前活动分支，
//   截取“到该消息为止”的 durable 消息，保证后台看到的是与调度时刻一致的历史，
//   不会把后续 turn 的内容吞进来。边界消息已被 revert 掉时该次执行直接失败。
//
// 【开关 / 降级】
//   - shuttingDown 或 memory.extractionEnabled === false → 不调度；
//   - 未启用 project Memory、remote workspace、缺少 sessionStore/fileSystemPort → 跳过；
//   - 无边界消息（还没有真实对话）→ 跳过；
//   - drain 默认 60s 有界等待，超时就放行（不阻塞 session close）。
//
// 【副作用】后台会读写 memory 目录（经受限 executor）并上报 telemetry；
//   调度本身只读 SessionStore，不写库。
// ============================================================
import { selectActiveConversationBranch, type TraceContext } from "../deps.js";
import {
  buildMemoryExtractionPrompt,
  createMemoryExtractionScheduler,
  type MemoryExtractionScheduler,
  type MemoryExtractionSnapshot,
} from "../../memory/extraction.js";
import { runMemoryAgentLoop } from "../../memory/memory-agent-loop.js";
import { scanMemoryManifest } from "../../memory/recall/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  prepareProjectMemoryAgentRequest,
  captureProjectMemoryAgentContext,
  createProjectMemoryAgentToolExecutor,
  type ProjectMemoryAgentContext,
} from "./project-memory-agent.js";
import { resolveEnabledProjectMemoryRoot } from "./project-memory.js";

// Extraction 最多 5 轮工具调用：抽取是一次短任务，轮数上限防止后台失控。
const EXTRACTION_MAX_TURNS = 5;
// 关闭会话时最多等待 60s；超时即放行，避免后台任务拖住进程退出。
const EXTRACTION_DRAIN_TIMEOUT_MS = 60_000;

/**
 * Extraction 的调度快照：Memory 执行上下文 + 抽取边界与 durable 消息截断。
 * boundaryMessageId：调度时刻的最新对话消息 id；
 * durableMessages：只含该消息为止的活动分支消息（不含后续 turn）。
 */
interface ProjectMemoryExtractionSnapshot
  extends MemoryExtractionSnapshot, ProjectMemoryAgentContext {}

/**
 * 调度器类型别名：把 Extraction 快照与调度器接口绑定，供 runtime 字段使用。
 */
export type ProjectMemoryExtractionScheduler =
  MemoryExtractionScheduler<ProjectMemoryExtractionSnapshot>;

/**
 * 判断当前 runtime 是否启用了 project Memory。
 * 输入：this（void 绑定的 runtime）。
 * 输出：boolean。
 * 语义：等价于 resolveEnabledProjectMemoryRoot(...) !== undefined。
 * 副作用：无。
 */
export function isProjectMemoryEnabled(this: AgentRuntimeInternal): boolean {
  return resolveEnabledProjectMemoryRoot(this.config, this.workspaceRoot) !== undefined;
}

/**
 * 调度一次后台记忆抽取（异步，不阻塞当前 turn）。
 * 输入：runtime + 本 turn 的 model 与 traceContext。
 * 输出：无。
 * 副作用：注册后台任务；会读取 SessionStore，执行期写 memory 目录。
 * 语义：先捕获上下文与调度边界，再用 Promise.all(messages, getSession) 异步取回
 *   同一时刻的 durable 快照，最后按 revert 还原活动分支并截断到边界。
 * 降级：任何门禁不满足直接 return（不抛错）；边界消息不在活动分支时该次执行失败。
 * 不变量：只把边界之前的消息交给 Extraction，后续 turn 不会渗入本次快照。
 */
export function scheduleProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: { model: ProjectMemoryAgentContext["model"]; traceContext: TraceContext },
): void {
  // 进程正在关闭：不再新起后台任务，避免与 drain 竞争。
  if (runtime.shuttingDown) return;
  // 原因：headless 只关闭自动 Extraction，必须在读取快照或访问文件前返回，避免后台副作用。
  if (runtime.config.memory?.extractionEnabled === false) return;
  // Bash cd 只改变执行 cwd，project Memory 身份必须继续使用会话 workspace root。
  const memoryRoot = resolveEnabledProjectMemoryRoot(runtime.config, runtime.workspaceRoot);
  if (!memoryRoot) return;
  if (runtime.isRemoteWorkspace()) return;
  if (!runtime.sessionStore || !runtime.fileSystemPort) return;

  const snapshotBase = captureProjectMemoryAgentContext(runtime, {
    memoryRoot,
    model: input.model,
    operation: "project_memory_extract",
    traceContext: input.traceContext,
  });
  const snapshotBoundaryMessageId = runtime.latestConversationMessageId;
  if (!snapshotBoundaryMessageId) return;
  const durableMessages = runtime.sessionStore.messages({ sessionID: runtime.sessionId });
  const session = runtime.sessionStore.getSession(runtime.sessionId);
  const snapshot = Promise.all([durableMessages, session]).then(
    ([messages, scheduledSession]): ProjectMemoryExtractionSnapshot => {
      const activeMessages = selectActiveConversationBranch(messages, {
        branchCutAfterMessageId: scheduledSession?.revert?.branchCutAfterMessageID,
        rewindCreatedMessageId: scheduledSession?.revert?.createdMessageID,
        rewindKeptMessageIds: scheduledSession?.revert?.keptMessageIDs,
        rewindTargetMessageId: scheduledSession?.revert?.targetMessageID,
      });
      const boundaryIndex = activeMessages.findIndex(
        (message) => message.info.id === snapshotBoundaryMessageId,
      );
      if (boundaryIndex < 0) {
        throw new Error("Extraction boundary is missing from the scheduled active branch");
      }
      return {
        ...snapshotBase,
        boundaryMessageId: snapshotBoundaryMessageId,
        durableMessages: activeMessages.slice(0, boundaryIndex + 1),
      };
    },
  );

  // 惰性创建单例调度器；同一 runtime 的多次调度串行排队，不并发写 memory。
  runtime.memoryExtractionScheduler ??= createMemoryExtractionScheduler((extraction) =>
    executeProjectMemoryExtraction(runtime, extraction),
  );
  runtime.memoryExtractionScheduler.schedule(snapshot);
}

/**
 * 等待所有已排队的 Extraction 结束（有界）。
 * 输入：timeoutMs（默认 60s；显式 null 表示不限时）。
 * 输出：Promise<void>。
 * 副作用：无（只等待）。
 * 语义：无调度器直接返回；null 走自然结束（benchmark）；否则与超时竞速。
 * 降级：超时视为“放行”，不取消任务、不抛错——后台失败不应阻止 session close。
 */
export async function drainMemoryExtractions(
  this: AgentRuntimeInternal,
  timeoutMs: number | null = EXTRACTION_DRAIN_TIMEOUT_MS,
): Promise<void> {
  const scheduler = this.memoryExtractionScheduler;
  if (!scheduler) return;
  // benchmark 显式等待自然结束；普通 session close 仍保留原有有界取消清理。
  if (timeoutMs === null) {
    await scheduler.drain();
    return;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      scheduler.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * 执行单次 Extraction：扫描 manifest → 构造 prompt → 跑受限 agent loop。
 * 输入：runtime + abortSignal / 消息数 / 快照。
 * 输出：Promise<"success" | "aborted" | "error">。
 * 副作用：读写 memory 目录（工具调用）、上报 telemetry。
 * 失败 / 降级：abort 或 AbortError 记为 cancelled 并返回 "aborted"；
 *   其他错误记为 failed 并返回 "error"，不向上抛（调度器只关心批处理进度）。
 */
async function executeProjectMemoryExtraction(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    messageCount: number;
    snapshot: ProjectMemoryExtractionSnapshot;
  },
) {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.snapshot.causation,
    executionKind: "background",
    operation: "project_memory_extract",
    targetKind: "project_memory",
    traceContext: input.snapshot.traceContext,
    trigger: "scheduler",
  });

  return telemetry.run(async () => {
    try {
      const manifest = await scanMemoryManifest({
        fileSystem: runtime.fileSystemPort!,
        rootDir: input.snapshot.memoryRoot,
        signal: input.abortSignal,
      });
      // 扫描期间可能已被取消，先检查再继续构造 prompt，避免取消后仍有模型调用。
      if (input.abortSignal.aborted) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      const prompt = buildMemoryExtractionPrompt({
        manifest,
        messageCount: input.messageCount,
      });
      const request = prepareProjectMemoryAgentRequest(input.snapshot, prompt);
      const executor = createProjectMemoryAgentToolExecutor(runtime, input.snapshot);

      await runMemoryAgentLoop({
        abortSignal: input.abortSignal,
        executeTool: (toolCall, options) =>
          executor.execute(toolCall, {
            signal: options.abortSignal,
            traceContext: input.snapshot.traceContext,
          }),
        maxTurns: EXTRACTION_MAX_TURNS,
        request,
        model: input.snapshot.model,
        rootDir: input.snapshot.memoryRoot,
        workingDirectory: input.snapshot.workingDirectory,
        workspaceRoot: input.snapshot.workspaceRoot,
      });
      telemetry.finishCompleted();
      return "success" as const;
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
        return "aborted" as const;
      }
      telemetry.finishFailed("execute", "internal", error);
      return "error" as const;
    }
  });
}

/**
 * 判断错误是否为 AbortError（仅匹配 DOMException，保持与平台一致）。
 * 输入 / 输出：纯判断。副作用：无。
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
