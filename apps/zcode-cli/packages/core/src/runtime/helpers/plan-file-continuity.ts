// ============================================================
// plan-file-continuity —— 已批准计划文件的落盘与“续接引用”
// ============================================================
//
// 【职责】
//   1. 把用户批准的 plan 写到 workspace 内的固定路径
//      （.zcode/plans/plan-<sessionId>.md），供后续 turn / 冷恢复复用；
//   2. 在需要时把该文件内容包装成 plan_file_reference 系统提醒附件，
//      让模型知道“已有一份计划，若仍相关就继续执行”。
//
// 【为什么落在 workspace 而不是内存】
//   plan 的生命周期跨 turn、跨重启、甚至跨进程；只有落盘才能让新会话
//   （fork / resume）继续引用同一份计划，也方便用户直接查看与编辑。
//
// 【副作用】
//   - write：经 FileSystemPort 原子写（atomic + createParents）；
//   - read：只读文件；
//   - 附件条目会进入 messageHistory，并由上层持久化为 plan_file_reference 来源。
//
// 【失败/降级】
//   - 空 plan：抛 InvalidInput（recoverable）——空计划没有引用价值；
//   - 读文件 not_found：返回 undefined，视作“没有计划”，不报错；
//   - 文件存在但内容全空白：同样返回 undefined；
//   - 其他读取错误（权限等）：原样抛出，由调用方决定是否影响当前 turn。
//
// 【不变量】计划文件路径只由 workspaceRoot + sessionId 决定，不含时间戳，
//   保证同一会话重复 ExitPlanMode 时覆盖同一份文件而不是产生副本。
// ============================================================
import { join } from "node:path";
import {
  CoreErrorType,
  PLAN_MODE_MAX_PLAN_CHARS,
  createCoreError,
  isFileSystemPortError,
  type FileSystemPort,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

// 读取上限按“计划最大字符数 × 4 字节 + 少量余量”估算，避免读到异常巨大的文件；
// 超出上限时由 FileSystemPort 报错，而不是截断出一份不完整计划。
const PLAN_FILE_REFERENCE_MAX_BYTES = PLAN_MODE_MAX_PLAN_CHARS * 4 + 1024;

/**
 * 计算已批准计划文件的路径。
 * 输入：sessionId + workspaceRoot。
 * 输出：<workspaceRoot>/.zcode/plans/plan-<sanitized>.md。
 * 语义：sessionId 经 sanitizePlanFileSessionId 规约后嵌入文件名，避免路径穿越/非法字符。
 * 副作用：无（纯路径拼接）。
 * 失败：规约后为空时抛 InvalidInput（recoverable: false）。
 */
export function resolveApprovedPlanFilePath(input: {
  sessionId: SessionId | string;
  workspaceRoot: string;
}): string {
  return join(
    input.workspaceRoot,
    ".zcode",
    "plans",
    `plan-${sanitizePlanFileSessionId(input.sessionId)}.md`,
  );
}

/**
 * 原子写入已批准的 plan 文件。
 * 输入：plan 文本、sessionId、workspaceRoot、FileSystemPort，可选 abortSignal / trace。
 * 输出：{ path }。
 * 副作用：落盘（atomic=true、createParents=true、utf8），覆盖同会话旧计划。
 * 失败：plan 全空白时抛 InvalidInput（recoverable: true）；
 *       写盘错误透传 FileSystemPort 错误；abortSignal 触发时由底层中断。
 */
export async function writeApprovedPlanFile(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  plan: string;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<{ path: string }> {
  if (!input.plan.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "ExitPlanMode plan cannot be empty", {
      recoverable: true,
    });
  }

  const path = resolveApprovedPlanFilePath(input);
  await input.fileSystemPort.writeTextFile(
    {
      atomic: true,
      content: input.plan,
      createParents: true,
      encoding: "utf8",
      path,
      trace: input.traceContext,
    },
    { signal: input.abortSignal },
  );
  return { path };
}

/**
 * 读取计划文件并构造 plan_file_reference 提醒条目。
 * 输入：同 write（透传 abortSignal / trace）。
 * 输出：RuntimeMessageEntry | undefined。
 * 副作用：只读文件；不写 messageHistory（由调用方决定何时注入）。
 * 降级：not_found → undefined（没有计划）；内容空白 → undefined；
 *       其他读取错误继续抛出，不做静默。
 * 注意：本函数不负责注入去重，同一 turn 内重复调用会得到等价条目。
 */
export async function readApprovedPlanFileReferenceEntry(input: {
  abortSignal?: AbortSignal;
  fileSystemPort: FileSystemPort;
  sessionId: SessionId | string;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<RuntimeMessageEntry | undefined> {
  const path = resolveApprovedPlanFilePath(input);
  let content: string;
  try {
    const read = await input.fileSystemPort.readTextFile(
      {
        maxBytes: PLAN_FILE_REFERENCE_MAX_BYTES,
        path,
        trace: input.traceContext,
      },
      { signal: input.abortSignal },
    );
    content = read.content;
  } catch (error) {
    // not_found 是正常状态（该会话从未产生计划），不应被当成故障。
    if (isFileSystemPortError(error) && error.code === "not_found") {
      return undefined;
    }
    throw error;
  }

  // 空文件等价于“无计划”：注入空引用会让模型误以为计划存在。
  if (!content.trim()) return undefined;
  return systemReminderAttachmentEntry(
    "plan_file_reference",
    formatPlanFileReference({ planContent: content, planFilePath: path }),
  );
}

/**
 * 组装计划文件引用文本。
 * 输入：计划路径与内容。
 * 输出：发给模型的多行文本（路径 + 内容 + 续接提示）。
 * 副作用：无。
 * 注意：内容是原样嵌入，不做转义；调用方应保证其来自本会话的计划文件。
 */
export function formatPlanFileReference(input: {
  planContent: string;
  planFilePath: string;
}): string {
  return [
    `A plan file exists from plan mode at: ${input.planFilePath}`,
    "",
    "Plan contents:",
    "",
    input.planContent,
    "",
    "If this plan is relevant to the current work and not already complete, continue working on it.",
  ].join("\n");
}

/**
 * 把 sessionId 规约成安全的文件名片段。
 * 输入：SessionId | string。
 * 输出：仅含 [A-Za-z0-9._-] 的片段。
 * 失败：规约后为空时抛 InvalidInput（recoverable: false）——
 *   否则会写成一个通用文件名，导致不同会话互相覆盖计划。
 * 副作用：无。
 */
function sanitizePlanFileSessionId(sessionId: SessionId | string): string {
  const sanitized = String(sessionId)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!sanitized) {
    throw createCoreError(CoreErrorType.InvalidInput, "Session id cannot produce a plan file name", {
      recoverable: false,
    });
  }
  return sanitized;
}
