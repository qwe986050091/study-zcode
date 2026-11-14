// ============================================================
// 内联草稿记作「模型写过的文件」（docs/dynamic-workflow/launch.md「Script files」→
// 「An inline draft counts as written by the model」）
// ============================================================
// Edit / Write 拒绝会话没读过的文件（FILE_NOT_READ）：模型不能改它没见过的字节。内联草稿恰好是
// 这条已经成立的文件——它的字节就是产生它的那次调用的 `script` 入参。不记这一笔，NOTE 要求的
// 第一次 `Edit` 必然失败，补救是把模型自己刚写的两万 token 脚本整个 `Read` 一遍，正是草稿文件
// 要省掉的那笔开销。
//
// **只由内联分支调用**：saved 拷贝（带模型没见过的元数据块）、沿用前驱脚本的新草稿（脚本可能
// 来自别的会话或压缩之前）、中枢直接启动与 GUI 设置修订写下的草稿都不是模型本次亲手写的字节，
// 记了就是替模型担保它没看过的内容。
//
// 与草稿本身一样**尽力而为**：stat 不到就不记，模型的第一次 Edit 退回「先 Read」的老路。

import { createReadFileStateMetadataFromEntry } from "../read-file-state-metadata.js";
import { createReadFileStateKey, normalizeReadFileStateMtimeMs } from "../read-file-state.js";
import type { ReadFileStateEntry, ToolExecutionContext } from "../types.js";

// 只有这三个工具会「刚写下模型可见的脚本字节」，所以 read-state 的 sourceTool 被收窄成这个
// 联合：加到第四个工具时，类型检查会迫使调用方在这里也认领一次口径。
export type WorkflowDraftAuthoringTool = "CreateWorkflow" | "AmendWorkflow" | "FillWorkflowHole";

const CRLF_PATTERN = /\r\n/gu;
const LF = "\n";

/**
 * 把刚写下的草稿登记进会话的 read-file-state。
 *
 * 输入：`draft.path` 是草稿绝对/解析后路径，`draft.source` 是工具实际写下的原文（不是模型
 * 传入的未归一化文本），`toolName` 决定 sourceTool 与 metadata 的工具归因。
 * 输出：`Promise<void>`；成功时产生两类副作用——(1) 更新内存 readFileState（后续 Edit/Write
 * 的 stale 校验读它），(2) 通过 `recordReadFileStateMetadata` 写进 tool part metadata（冷恢复
 * 的唯一来源，不写则 resume 后 read-state 丢失）。
 * 失败语义：**尽力而为**，任何 stat 失败或端口缺席都静默返回——草稿本身已经写好，这里只是
 * 优化，不能让一次成功的工作流调用因为「记不住读过」而失败。降级后果是模型第一次 Edit 收到
 * FILE_NOT_READ，需要先 Read。
 * 维护的不变量：登记的 content 恒为 LF、revision/mtime 与落盘后真实文件一致，因此不会让
 * 紧随其后的 Edit 被误判 stale。
 */
export async function recordAuthoredWorkflowDraft(
  context: ToolExecutionContext,
  draft: { path: string; source: string; toolName: WorkflowDraftAuthoringTool },
): Promise<void> {
  const { fileSystemPort, readFileState } = context;
  // 端口或内存表缺席（精简 runtime / 单测）就没有可登记的去处；直接返回，不抛。
  if (readFileState === undefined || fileSystemPort === undefined) return;

  let revision: { id: string; mtimeMs?: number; sizeBytes?: number } | undefined;
  try {
    // 与 Edit / Write 之后的 stale 校验读同一个端口，revision 的口径因此一致。stat 发生在写之后：
    // 记下的 mtime 不早于草稿的真实 mtime，其后任何外部改动都会让 mtime 前进并判 stale。
    const info = await fileSystemPort.stat(
      { path: draft.path, trace: context.traceContext },
      { signal: context.abortSignal },
    );
    revision = info.revision;
  } catch {
    // stat 失败（文件被立刻删掉、只读挂载、端口实现不支持）只意味着「没有可靠 revision」。
    // 宁可不登记，也不拿一个猜出来的 mtime 冒充事实——那会让后续 Edit 的 stale 判定失真。
    return;
  }
  // 端口返回空 revision 是合法状态（部分 FS 不提供），同样无法支撑 stale 校验。
  if (revision === undefined) return;

  const entry: ReadFileStateEntry = {
    path: draft.path,
    // 端口读回的文本统一成 LF（FileSystemReadTextResult.content），快照跟随同一口径。
    content: draft.source.replace(CRLF_PATTERN, LF),
    offset: undefined,
    limit: undefined,
    isPartialView: false,
    readAt: new Date(),
    sourceTool: draft.toolName,
    revisionId: revision.id,
    mtimeMs: normalizeReadFileStateMtimeMs(revision.mtimeMs),
    // 端口没给 size 时按写下的原文算：content 已归一化成 LF，字节数与磁盘上那份可能差在
    // CRLF 上，但这是唯一不引入额外 stat 的保守估计。
    sizeBytes: revision.sizeBytes ?? Buffer.byteLength(draft.source, "utf8"),
  };
  // key 用 offset=1 / limit=undefined，与「整文件读」的 key 同形——否则 Edit 走
  // findLatestReadFileState 时找不到这条记录，等于没登记。
  readFileState.set(createReadFileStateKey(draft.path, 1, undefined), entry);

  // resume 只从 tool part metadata 恢复 read-state（read-file-state-hydrator.ts），不落这一笔，
  // 会话恢复后同一个 bug 原样回来。
  const metadata = createReadFileStateMetadataFromEntry({
    completedAt: entry.readAt,
    entry,
    toolName: draft.toolName,
  });
  if (metadata !== undefined) context.recordReadFileStateMetadata?.(metadata);
}
