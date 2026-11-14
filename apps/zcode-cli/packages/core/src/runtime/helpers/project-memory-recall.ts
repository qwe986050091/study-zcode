// ============================================================
// project-memory-recall —— 语义召回（semantic recall）的预取与注入
// ============================================================
//
// 【职责】在一个 turn 开始时并行启动一次“记忆召回”预取：
//   用选择器模型从 Memory manifest 中挑出与本轮问题相关的文件并读取正文；
//   当本轮真正要发给模型时，再把结果作为 relevant_memory 系统提醒注入，
//   同时同步 readFileState。
//
// 【为什么预取】selector 是一次额外模型调用；若等主请求前串行执行，
//   会直接拉长首 token 延迟。预取与主 turn 的其余准备工作并行，代价是“可能白跑”。
//
// 【生命周期（严格三态）】
//   settled = 预取已结束（成功或失败）；consumed = 结果已被取用。
//   只有 settled && !consumed 才能注入；consume 后标记 consumed，同一预取不重复注入。
//   dispose / invalidate 会中止未完成的预取，避免过期正文进入上下文。
//
// 【降级】
//   - 非 semantic-recall 分支、已有预取、无 memoryRoot/fileSystemPort → 不启动；
//   - 模型不支持 JSON Schema 输出 → 不启动（不允许换 Provider 去猜选择器结果）；
//   - 无合法召回 query、已召回全部 manifest 条目 → 不启动；
//   - 预取抛错 → 记录空结果并置 settled，注入侧自然得到 undefined。
//
// 【副作用】启动时复制 readFileState / recalledPaths 作为一致性基线；
//   注入时写 readFileState 与 messageHistory 附件条目（注入即等价于一次读取）。
// ============================================================
import type { AgentTelemetryCausation, Model } from "@zcode/contracts";
import type { TraceContext } from "../deps.js";
import {
  canStartMemoryRecall,
  createMemoryRecallState,
  filterMemorySelections,
  findLatestMemoryRecallQuery,
  formatRelevantMemoryAttachment,
  getMemoryRecallManifest,
  isMemoryRecallQueryEligible,
  readRecalledMemories,
  recordRecalledMemories,
  runMemorySelector,
  type MemoryManifestEntry,
  type MemoryRecallState,
  type RecalledMemory,
} from "../../memory/recall/index.js";
import type { ReadFileStateMap } from "../../tool/types.js";
import {
  createReadFileStateKey,
  createReadFileStatePathKey,
  normalizeReadFileStateMtimeMs,
} from "../../tool/read-file-state.js";
import type { ProjectMemoryRetrievalBranch } from "../../memory/project-memory-retrieval-branch.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "../methods/model-runtime-headers.js";
import { withModelInvocationContext } from "../methods/runtime-model.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

/**
 * 预取结果的一对：manifest 条目 + 已读取正文。
 * 保留 entry 而不是只存 memory，是为了注入时按 filename 与最新 manifest 对齐。
 */
interface PrefetchedMemory {
  entry: MemoryManifestEntry;
  memory: RecalledMemory;
}

/**
 * 一次召回预取的生命周期对象（挂在 runtime.memoryRecallPrefetch 上）。
 */
export interface ProjectMemoryRecallPrefetch {
  /** 预取自己的取消控制器；turn 取消或 dispose 时中止。 */
  abortController: AbortController;
  /** 结果是否已被取用；置 true 后同一次预取不再注入。 */
  consumed: boolean;
  /** 解除 turn abort 转发的回调（幂等，finally 里调用）。 */
  detachTurnAbort: () => void;
  /** 已读取的候选记忆；预取未完成时为空数组。 */
  memories: PrefetchedMemory[];
  /** 预取是否已结束（无论成功或失败）；只有 settled 才允许 consume。 */
  settled: boolean;
}

/**
 * 启动一次记忆召回预取（每个 turn 至多一次）。
 * 输入：runtime、model / traceContext / turnAbortSignal、召回分支。
 * 输出：无。
 * 副作用：创建 AbortController、注册 turn abort 转发、发起后台任务。
 * 语义：门禁全部通过后，先把 readFileState 与 recalledPaths 复制成快照，
 *   再异步执行；失败被吞成空结果（不污染主 turn）。
 * 降级：任一前置条件不满足直接 return，调用方无需区分。
 * 不变量：runtime.memoryRecallPrefetch 最多存在一个未销毁的预取。
 */
export function startProjectMemoryRecallPrefetch(
  runtime: AgentRuntimeInternal,
  input: { model: Model; traceContext: TraceContext; turnAbortSignal: AbortSignal },
  retrievalBranch: ProjectMemoryRetrievalBranch,
): void {
  if (retrievalBranch !== "semantic-recall") return;
  if (runtime.memoryRecallPrefetch) return;
  if (!runtime.memoryRoot || !runtime.fileSystemPort) return;
  // Selector 必须得到严格 JSON Schema；禁止因能力不足另选一个隐式 Provider/Model。
  if (!input.model.properties.supportsJsonSchemaOutput) return;
  if (!canStartMemoryRecall(runtime.memoryRecallState)) return;

  const query = findLatestMemoryRecallQuery(runtime.messageHistory.borrowReadOnlyRuntimeEntries());
  if (!isMemoryRecallQueryEligible(query)) return;
  const recallState = runtime.memoryRecallState;
  if (hasRecalledEveryManifestEntry(recallState)) return;

  const abortController = new AbortController();
  const prefetch: ProjectMemoryRecallPrefetch = {
    abortController,
    consumed: false,
    detachTurnAbort: forwardTurnAbort(input.turnAbortSignal, abortController),
    memories: [],
    settled: false,
  };
  runtime.memoryRecallPrefetch = prefetch;

  const readFileStateSnapshot: ReadFileStateMap = new Map(runtime.readFileState);
  const recalledPathsSnapshot = new Set(recallState.recalledPaths);
  void prefetchProjectMemories(runtime, {
    abortSignal: abortController.signal,
    causation: runtime.agentTelemetry.captureCausation(),
    model: input.model,
    query,
    readFileStateSnapshot,
    recalledPathsSnapshot,
    rootDir: runtime.memoryRoot,
    state: recallState,
    traceContext: input.traceContext,
  })
    .then((memories) => {
      prefetch.memories = memories;
    })
    .catch(() => {
      prefetch.memories = [];
    })
    .finally(() => {
      prefetch.settled = true;
      prefetch.detachTurnAbort();
    });
}

/**
 * 取用已完成的预取结果并注入 relevant_memory 提醒。
 * 输入：runtime + 召回分支。
 * 输出：注入的 RuntimeMessageEntry；无可注入内容时 undefined。
 * 语义：用注入时刻的 manifest / readFileState / recalledPaths 再过滤一次，
 *   丢弃此期间已被读过的、已召回的文件，避免重复注入；正文按 manifest 顺序排列。
 * 副作用：写 runtime.readFileState（等价一次读取）、向 messageHistory 追加附件、
 *   记录 recalledPaths。同一次预取只注入一次（consumed 标记）。
 */
export function consumeSettledProjectMemoryRecall(
  runtime: AgentRuntimeInternal,
  retrievalBranch: ProjectMemoryRetrievalBranch,
): RuntimeMessageEntry | undefined {
  if (retrievalBranch !== "semantic-recall") return undefined;
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch || !prefetch.settled || prefetch.consumed) return undefined;
  prefetch.consumed = true;

  const eligibleEntries = filterMemorySelections({
    manifest: runtime.memoryRecallState.manifest ?? prefetch.memories.map(({ entry }) => entry),
    readFileState: runtime.readFileState,
    recalledPaths: runtime.memoryRecallState.recalledPaths,
    selectedFilenames: prefetch.memories.map(({ entry }) => entry.filename),
  });
  const memories = matchPrefetchedMemories(prefetch.memories, eligibleEntries);
  if (memories.length === 0) return undefined;

  // 修复原因：Recall 正文对模型等价于一次读取，必须在实际注入时同步既有 read-state，供后续 Edit/Write 使用。
  const readAt = new Date();
  for (const memory of memories) {
    runtime.readFileState.set(createReadFileStateKey(memory.filePath, undefined, memory.limit), {
      content: memory.content,
      isPartialView: false,
      limit: memory.limit,
      mtimeMs: normalizeReadFileStateMtimeMs(memory.mtimeMs),
      offset: undefined,
      path: memory.filePath,
      readAt,
      revisionId: memory.revisionId,
      sizeBytes: memory.sizeBytes,
    });
  }
  const entry = systemReminderAttachmentEntry(
    "relevant_memory",
    formatRelevantMemoryAttachment(memories),
  );
  runtime.messageHistory.addEntries([entry]);
  recordRecalledMemories(runtime.memoryRecallState, memories);
  return entry;
}

/**
 * 释放预取：清除 runtime 引用、解除 abort 监听并中止未完成的请求。
 * 输入：runtime。输出：无。
 * 副作用：可能触发后台任务取消；其 settled 回调只会写到自己那份已废弃对象上，
 *   不会影响主链路状态。
 */
export function disposeProjectMemoryRecallPrefetch(runtime: AgentRuntimeInternal): void {
  const prefetch = runtime.memoryRecallPrefetch;
  if (!prefetch) return;
  runtime.memoryRecallPrefetch = undefined;
  prefetch.detachTurnAbort();
  if (!prefetch.abortController.signal.aborted) {
    prefetch.abortController.abort();
  }
}

/**
 * 彻底重置召回状态（会话切换 / 新工作区时使用）。
 * 输入：runtime。输出：无。
 * 副作用：销毁预取 + 重建 memoryRecallState
 *   （清空 manifest、selectorMessages、recalledPaths 与字符配额计数）。
 */
export function resetProjectMemoryRecall(runtime: AgentRuntimeInternal): void {
  disposeProjectMemoryRecallPrefetch(runtime);
  runtime.memoryRecallState = createMemoryRecallState();
}

/**
 * 让指定路径的“已注入 / 已读取”状态失效（Dream 改写文件后调用）。
 * 输入：runtime + 被修改的路径集合。
 * 输出：无。
 * 副作用：销毁尚未消费的预取（其正文已过期）、删除对应 readFileState 条目
 *   与 recalledPaths 记录、清空 manifest 与 selector 缓存，迫使下次召回重新扫描。
 * 语义：路径比较使用规范化 key，避免大小写 / 分隔符差异导致漏删。
 */
export function invalidateProjectMemoryRecallPaths(
  runtime: AgentRuntimeInternal,
  paths: readonly string[],
): void {
  if (paths.length === 0) return;
  // Dream 修改文件时，已完成但尚未消费的 prefetch 仍持有旧正文；先丢弃它，
  // 避免后续 tool batch 把更新前的内容重新注入 provider context。
  disposeProjectMemoryRecallPrefetch(runtime);
  const touchedPathKeys = new Set(paths.map((path) => createReadFileStatePathKey(path)));

  for (const [key, entry] of runtime.readFileState) {
    if (touchedPathKeys.has(createReadFileStatePathKey(entry.path))) {
      runtime.readFileState.delete(key);
    }
  }
  for (const recalledPath of runtime.memoryRecallState.recalledPaths) {
    if (touchedPathKeys.has(createReadFileStatePathKey(recalledPath))) {
      runtime.memoryRecallState.recalledPaths.delete(recalledPath);
    }
  }

  // 文件已变，manifest 与 selector 历史都不可信；清空让下次调用重新扫描并重建选择器上下文。
  runtime.memoryRecallState.manifest = undefined;
  runtime.memoryRecallState.selectorMessages = undefined;
}

/**
 * 预取主流程：manifest → selector 选择 → 读取正文。
 * 输入：abortSignal、model、query、readFileState / recalledPaths 快照、rootDir、状态。
 * 输出：PrefetchedMemory[]（仅保留 manifest 中仍存在的条目）。
 * 副作用：读磁盘、一次 selector 模型调用、telemetry 上报。
 * 失败：抛出原错误——由 start* 的 .catch 统一降级为空结果。
 * 不变量：选择过滤使用“启动时”的快照，保证同一 turn 内前后判断一致。
 */
async function prefetchProjectMemories(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal: AbortSignal;
    causation?: AgentTelemetryCausation;
    model: Model;
    query: string;
    readFileStateSnapshot: ReadFileStateMap;
    recalledPathsSnapshot: ReadonlySet<string>;
    rootDir: string;
    state: MemoryRecallState;
    traceContext: TraceContext;
  },
): Promise<PrefetchedMemory[]> {
  const telemetry = runtime.agentTelemetry.detached({
    causation: input.causation,
    executionKind: "background",
    operation: "project_memory_recall",
    targetKind: "project_memory",
    traceContext: input.traceContext,
    trigger: "turn",
  });

  return telemetry.run(async () => {
    try {
      const fileSystem = runtime.fileSystemPort!;
      const manifest = await getMemoryRecallManifest({
        fileSystem,
        rootDir: input.rootDir,
        signal: input.abortSignal,
        state: input.state,
      });
      // 快照时点已全部召回：无需再付出一次 selector 调用。
      if (manifest.every((entry) => input.recalledPathsSnapshot.has(entry.filePath))) {
        telemetry.setResultType("metadata");
        telemetry.finishCompleted();
        return [];
      }

      const selection = await runMemorySelector({
        abortSignal: input.abortSignal,
        model: selectorModel(input.model, runtime, input.traceContext),
        query: input.query,
        state: input.state,
      });
      const entries = filterMemorySelections({
        manifest,
        readFileState: input.readFileStateSnapshot,
        recalledPaths: input.recalledPathsSnapshot,
        selectedFilenames: selection.selectedMemories,
      });
      const memories = await readRecalledMemories({
        entries,
        fileSystem,
        nowMs: runtime.now().getTime(),
        signal: input.abortSignal,
      });
      const entryByPath = new Map(entries.map((entry) => [entry.filePath, entry]));
      telemetry.setResultType("metadata");
      telemetry.finishCompleted();
      return memories.flatMap((memory) => {
        const entry = entryByPath.get(memory.filePath);
        return entry ? [{ entry, memory }] : [];
      });
    } catch (error) {
      if (input.abortSignal.aborted || isAbortError(error)) {
        telemetry.finishCancelled("abort_signal");
      } else {
        telemetry.finishFailed("execute", "internal", error);
      }
      throw error;
    }
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * 给选择器模型套上本次调用的元数据（操作类型、headers 刷新、trace）。
 * 输入：model + runtime + traceContext。输出：包装后的 Model。
 * 副作用：无；实际请求发生时才刷新 headers。
 */
function selectorModel(
  model: Model,
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
): Model {
  return withModelInvocationContext(model, (request) => ({
    metadata: { querySource: "project_memory_recall" },
    modelCall: { operation: "project_memory_recall" },
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext,
    }),
    traceContext,
  }));
}

/**
 * 判断 manifest 是否非空且每个条目都已召回（用于跳过预取）。
 * 输入：召回状态。输出：boolean。副作用：无。
 */
function hasRecalledEveryManifestEntry(state: MemoryRecallState): boolean {
  return (
    state.manifest !== undefined &&
    state.manifest.length > 0 &&
    state.manifest.every((entry) => state.recalledPaths.has(entry.filePath))
  );
}

/**
 * 按 manifest 顺序把预取结果与“注入时刻仍合格”的条目对齐。
 * 输入：预取结果 + 重新过滤后的条目。
 * 输出：RecalledMemory[]。
 * 语义：同一 filename 可能对应多个条目，用队列逐个消费，避免正文被重复分配。
 * 副作用：无。
 */
function matchPrefetchedMemories(
  prefetched: readonly PrefetchedMemory[],
  eligibleEntries: readonly MemoryManifestEntry[],
): RecalledMemory[] {
  const byFilename = new Map<string, RecalledMemory[]>();
  for (const { entry, memory } of prefetched) {
    const queued = byFilename.get(entry.filename) ?? [];
    queued.push(memory);
    byFilename.set(entry.filename, queued);
  }
  return eligibleEntries.flatMap((entry) => {
    const memory = byFilename.get(entry.filename)?.shift();
    return memory ? [memory] : [];
  });
}

/**
 * 把 turn 的 abort 信号转发到预取自己的 controller，并返回解绑函数。
 * 输入：turnAbortSignal + 预取 controller。
 * 输出：dispose 回调（幂等，可重复调用）。
 * 语义：turn 已取消时立即中断；否则只监听一次；解绑后不再影响预取。
 * 副作用：注册 / 移除事件监听。
 */
function forwardTurnAbort(
  turnAbortSignal: AbortSignal,
  abortController: AbortController,
): () => void {
  const abort = () => {
    if (!abortController.signal.aborted) abortController.abort(turnAbortSignal.reason);
  };
  if (turnAbortSignal.aborted) {
    abort();
    return () => {};
  }
  turnAbortSignal.addEventListener("abort", abort, { once: true });
  return () => turnAbortSignal.removeEventListener("abort", abort);
}
