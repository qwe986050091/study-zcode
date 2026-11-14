// ============================================================
// memory/extraction —— turn 结束后的记忆抽取：判定、prompt 与串行调度器
// ============================================================
//
// 【定位】Extraction 把“本次对话里值得长期保留的事实”写回 memoryRoot。
//   本文件不执行模型或工具，只负责三件事：判断该不该跑、拼 prompt、
//   用游标（cursor）把多次调度串行化。
//
// 【读写边界】纯内存逻辑；不读 SessionStore、不写 memory 目录。
//   消息快照由调用方截断后传入（见 project-memory-extraction）。
//
// 【游标口径】cursor 是“已处理到的消息 id”，只在 skip 或执行成功/无操作时前进；
//   执行报错或 abort 不前进，让下一次调度重新覆盖同一段消息。
//
// 【过期口径】快照不可变；执行期间新到的调度只保留最新 pending，旧的被合并丢弃。
// ============================================================
import type { MessageId, MessageWithParts, ToolPart } from "@zcode/contracts";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import { formatMemoryManifest } from "./recall/manifest.js";
import type { MemoryManifestEntry } from "./recall/types.js";

// 少于 3 个词的 user 文本不足以承载可抽取事实（多为“继续/好的”类噪声）。
const MINIMUM_USER_WORDS = 3;

/**
 * 单次 Extraction 的终态。
 * success / no-op 会推进游标；error / aborted 不推进，允许下一次调度重试同一段。
 */
export type MemoryExtractionExecutionStatus = "success" | "no-op" | "error" | "aborted";

/**
 * 调度时刻冻结的消息与路径快照。
 * boundaryMessageId：调度时刻的最新对话消息 id，也是本次处理的右边界。
 * durableMessages：仅含该边界为止的活动分支消息（不含后续 turn）。
 * memoryRoot / workingDirectory / workspaceRoot：工具路径解析口径；
 *   workingDirectory 可因 Bash cd 变化，workspaceRoot 始终是会话工作区。
 */
export interface MemoryExtractionSnapshot {
  boundaryMessageId: MessageId;
  durableMessages: readonly MessageWithParts[];
  memoryRoot: string;
  workingDirectory: string;
  workspaceRoot: string;
}

/**
 * 是否执行本次抽取的判定结果。
 * run：需要执行，messageCount 为游标之后的消息数，也是 prompt 中的“最近若干条”。
 * skip：不执行，reason 区分“本轮已直接写过记忆”与“没有可抽取的用户正文”。
 */
export type MemoryExtractionDecision =
  | { decision: "run"; messageCount: number }
  | {
      decision: "skip";
      messageCount: number;
      reason: "direct-memory-write" | "no-user-prose";
    };

/**
 * 调度器交给执行函数的入参。
 * abortSignal 由调度器统一持有：shutdown 会中止正在运行的那一次。
 * messageCount 来自判定结果，不是调用方自行计数。
 */
export interface MemoryExtractionExecutionInput {
  abortSignal: AbortSignal;
  messageCount: number;
  snapshot: MemoryExtractionSnapshot;
}

/**
 * 后台抽取调度器：同一时刻最多一次执行，期间新调度只保留最新快照。
 * 泛型 TSnapshot 允许上层携带自己的执行上下文（如 model、tools）。
 * drain：等待当前及已排队的工作结束。
 * getCursor：读取已处理到的消息 id，供调用方持久化或诊断。
 * hasPendingWork：是否有运行中或待执行的快照。
 * schedule：提交快照（可传 Promise，读取失败视为一次 error）。
 * shutdown：中止执行并丢弃 pending，之后 schedule 一律忽略。
 */
export interface MemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
> {
  drain(): Promise<void>;
  getCursor(): MessageId | undefined;
  hasPendingWork(): boolean;
  schedule(snapshot: TSnapshot | Promise<TSnapshot>): void;
  shutdown(): void;
}

/**
 * 生成 Extraction 的 agent 提示词。
 * 输入：现有 manifest（用于要求先读再改，避免重复文件）与本批消息数。
 * 输出：完整 prompt 字符串。
 * 副作用：无（纯字符串拼接）。
 * 失败语义：manifest 为空时只是省略“已有文件”段落，不抛错。
 * 不变量：提示词把可用工具限定为只读检索 + 记忆目录内 Edit/Write/rm，
 *   与 evaluateMemoryAgentToolPolicy 的拒绝口径同源。
 */
export function buildMemoryExtractionPrompt(input: {
  manifest: readonly MemoryManifestEntry[];
  messageCount: number;
}): string {
  // manifest 只在非空时注入：空目录强行列出会浪费 token 且无参考价值。
  const existingMemories =
    input.manifest.length > 0
      ? `\n\n## Existing memory files\n\n${formatMemoryManifest(input.manifest)}\n\nCheck this list before writing \u2014 update an existing file rather than creating a duplicate.`
      : "";

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${input.messageCount} messages above and use them to update your persistent memory systems.`,
    "",
    "Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only, and Bash rm with paths inside the memory directory only. All other tools \u2014 MCP, Agent, write-capable Bash, etc \u2014 will be denied.",
    "",
    "You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 \u2014 issue all Read calls in parallel for every file you might update; turn 2 \u2014 issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.",
    "",
    `You MUST only use content from the last ~${input.messageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further \u2014 no grepping source files, no reading code to confirm a pattern exists, no git commands.${existingMemories}`,
    "",
    "If nothing is worth saving, output only 'Nothing to save.' Do not explain why.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.",
    "",
    "Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt \u2014 it is already in your context above.",
  ].join("\n");
}

/**
 * 判断游标之后的消息是否值得跑一次 Extraction（纯计算，不读盘）。
 * 输入：调度快照与上次处理到的 cursor。
 * 输出：run / skip（带 messageCount 与原因）。
 * 副作用：无。
 * 失败语义：不抛错；cursor 在快照中找不到时退化为“整段快照都算新消息”。
 * 不变量：两个 skip 条件互斥且优先于 run——
 *   assistant 已直接写过记忆时再抽取必然重复；没有合格用户正文则无信息可抽。
 */
export function evaluateMemoryExtraction(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): MemoryExtractionDecision {
  const messageCount = countMessagesAfterCursor(snapshot.durableMessages, cursor);

  if (containsDirectMemoryWrite(snapshot, cursor)) {
    // 本次对话已由 assistant 直接写入记忆：再抽取会重复且可能覆盖更新，跳过。
    return { decision: "skip", messageCount, reason: "direct-memory-write" };
  }

  if (!containsEligibleUserProse(snapshot.durableMessages, cursor)) {
    // 只有纯工具轮、合成消息或过短文本：没有可抽取的用户事实。
    return { decision: "skip", messageCount, reason: "no-user-prose" };
  }

  return { decision: "run", messageCount };
}

/**
 * 创建串行化的 Extraction 调度器（闭包持有 cursor 与运行态）。
 * 输入：execute 回调，负责真正跑模型与工具并返回终态。
 * 输出：MemoryExtractionScheduler。
 * 副作用：execute 期间会读写 memory 目录；调度器本身只维护内存状态。
 * 失败语义：快照 Promise reject 或 execute 抛错都不向上抛——
 *   该次不推进 cursor，后续调度会重试；shutdown 后丢弃所有 pending。
 * 不变量：同一时刻最多一个 execute；运行中新调度只覆盖 latestPending，
 *   即“合并到最新快照”，不排长队。
 */
export function createMemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
>(
  execute: (
    input: Omit<MemoryExtractionExecutionInput, "snapshot"> & { snapshot: TSnapshot },
  ) => Promise<MemoryExtractionExecutionStatus>,
): MemoryExtractionScheduler<TSnapshot> {
  let cursor: MessageId | undefined;
  let latestPending: Promise<SnapshotAcquisition<TSnapshot>> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdownController = new AbortController();

  const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
    const decision = evaluateMemoryExtraction(snapshot, cursor);
    const snapshotEnd = snapshot.boundaryMessageId;

    if (decision.decision === "skip") {
      // skip 是终态：推进游标，避免同一段消息在后续调度中被反复判定。
      if (snapshotEnd) cursor = snapshotEnd;
      return;
    }

    let status: MemoryExtractionExecutionStatus;
    try {
      status = await execute({
        abortSignal: shutdownController.signal,
        messageCount: decision.messageCount,
        snapshot,
      });
    } catch {
      // 执行抛错：不推进游标，下次调度可重试同一段；错误由上层 telemetry 记录。
      return;
    }

    // 只有未被 shutdown 打断的成功/无操作才推进；abort/error 保留重试机会。
    if (!shuttingDown && (status === "success" || status === "no-op") && snapshotEnd) {
      cursor = snapshotEnd;
    }
  };

  const run = async (first: Promise<SnapshotAcquisition<TSnapshot>>): Promise<void> => {
    try {
      let current: Promise<SnapshotAcquisition<TSnapshot>> | undefined = first;
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          current,
          shutdownController.signal,
        );
        if (acquisition.status === "shutdown" || shuttingDown) break;
        if (acquisition.status === "acquired") {
          try {
            await processSnapshot(acquisition.snapshot);
          } catch {
            // 本次 error 不推进 cursor；latest pending 仍按既有 coalescing 语义继续。
          }
        }
        current = shuttingDown ? undefined : latestPending;
        // 消费即清空，避免同一 pending 被下一轮循环重复取出。
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) {
        await running;
      }
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined;
    },
    schedule(snapshot) {
      // shutdown 后不再接受新工作，避免关闭中的 runtime 继续访问模型与磁盘。
      if (shuttingDown) return;
      const acquisition = acquireSnapshot(snapshot);
      if (running) {
        // 运行中：只保留最新快照，旧的未执行调度被合并丢弃（不是排队）。
        latestPending = acquisition;
        return;
      }

      running = run(acquisition);
    },
    shutdown() {
      if (shuttingDown) return;
      // ZCode 关闭单个 session 后进程仍继续运行；旧 scheduler 只让调用方
      // 放弃等待，running/pending Extraction 仍可能继续请求模型和写 Memory。
      shuttingDown = true;
      latestPending = undefined;
      shutdownController.abort();
    },
  };
}

/**
 * 快照获取的两种结果。
 * error 表示调用方传入的 Promise 读取失败；调度器把它当作一次不可重试的空跑，
 * 不推进 cursor（与 execute 抛错的处理保持一致）。
 */
type SnapshotAcquisition<TSnapshot> =
  | { status: "acquired"; snapshot: TSnapshot }
  | { status: "error" };

/**
 * 等待快照时的三态结果：shutdown 只表示“放弃等待”，不取消已提交的读取。
 */
type SnapshotAcquisitionWait<TSnapshot> = SnapshotAcquisition<TSnapshot> | { status: "shutdown" };

/**
 * 把“快照 Promise 或具体快照”统一成不会 reject 的 acquisition。
 * 失败语义：同步/异步读取错误都折叠为 error 状态，避免 unhandled rejection 打断调度循环。
 */
function acquireSnapshot<TSnapshot>(
  snapshot: TSnapshot | Promise<TSnapshot>,
): Promise<SnapshotAcquisition<TSnapshot>> {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: "acquired", snapshot: value }),
    () => ({ status: "error" }),
  );
}

/**
 * 等待快照或 shutdown，二者先到者胜。
 * 失败语义：abort 后立即返回 shutdown；快照自身的 error 状态照原样透传。
 * 副作用：注册/移除一次 abort 监听（一次性）。
 */
function waitForSnapshotAcquisitionOrShutdown<TSnapshot>(
  acquisition: Promise<SnapshotAcquisition<TSnapshot>>,
  signal: AbortSignal,
): Promise<SnapshotAcquisitionWait<TSnapshot>> {
  if (signal.aborted) return Promise.resolve({ status: "shutdown" });

  return new Promise((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve({ status: "shutdown" });
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void acquisition.then((result) => {
      cleanup();
      resolve(result);
    });
  });
}

/**
 * 计算游标之后的消息条数（游标消息本身不算新消息）。
 * 失败语义：无 cursor 或 cursor 不在快照中时返回快照总长度——
 *   宁可多算（重试覆盖），也不漏掉尚未处理的消息。
 */
function countMessagesAfterCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): number {
  if (!cursor) return messages.length;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1;
}

/**
 * 判断游标之后是否有 assistant 已直接修改记忆目录。
 * 输入：快照与游标；只检查 assistant 消息中的 Write/Edit ToolPart。
 * 输出：boolean；路径必须成功解析到 memoryRoot 内才算数。
 * 副作用：无。
 * 失败语义：解析抛错/越界/缺 file_path 都跳过该 part，不中断判定。
 * 不变量：这里用 resolveContainedMemoryFilePath（允许写子目录），
 *   与执行期 resolveSafeMemoryFilePath 的“安全子集”不同，避免误判为未写。
 */
function containsDirectMemoryWrite(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): boolean {
  const messages = messagesAfterFoundCursor(snapshot.durableMessages, cursor);
  if (!messages) return false;

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      if (!isMemoryMutationToolPart(part)) continue;
      const filePath = part.state.input.file_path;
      // 没有 file_path 的 Edit/Write（例如参数不完整）无法证明写进了记忆目录，跳过。
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (
        resolveContainedMemoryFilePath({
          filePath,
          rootDir: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 判断游标之后是否存在“像样的”用户正文。
 * 口径：非 meta user 消息 + 非 ignored/非 synthetic 的 text part + 至少 3 个词。
 * 副作用：无。
 * 失败语义：cursor 丢失时退化为整段快照；找不到合格文本返回 false（走 skip）。
 * 不变量：system-reminder、合成消息、纯工具轮都不算信号，避免无意义的后台模型调用。
 */
function containsEligibleUserProse(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): boolean {
  const messagesAfterCursor = messagesAfterFoundCursor(messages, cursor) ?? messages;
  for (const message of messagesAfterCursor) {
    if (!isNonMetaUserMessage(message)) continue;
    for (const part of message.parts) {
      // ignored（被用户忽略）与 synthetic（运行时合成）文本不代表用户真实意图。
      if (
        part.type === "text" &&
        part.ignored !== true &&
        part.synthetic !== true &&
        countWords(part.text) >= MINIMUM_USER_WORDS
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 取游标之后的消息；找不到 cursor 时返回 undefined 以区分“空数组”。
 * 返回 undefined 让调用方决定退化策略（计为全部或整段扫描）。
 */
function messagesAfterFoundCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): readonly MessageWithParts[] | undefined {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1);
}

/**
 * 是否为“非 meta 的真实 user 消息”。
 * 口径：role=user、非 synthetic、可见性不是 model-only（后者是内部注入，不算用户输入）。
 */
function isNonMetaUserMessage(message: MessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.info.synthetic !== true &&
    message.info.visibility !== "model-only"
  );
}

/**
 * ToolPart 类型守卫：只认 Write/Edit，供 containsDirectMemoryWrite 读取 input.file_path。
 */
function isMemoryMutationToolPart(part: MessageWithParts["parts"][number]): part is ToolPart {
  return part.type === "tool" && (part.tool === "Write" || part.tool === "Edit");
}

/**
 * 按空白切分计词；中文等无空格文本会被整体算作 1 个词。
 * 这是启发式下限，只用于过滤“继续/好”类噪声，不追求精确分词。
 */
function countWords(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}
