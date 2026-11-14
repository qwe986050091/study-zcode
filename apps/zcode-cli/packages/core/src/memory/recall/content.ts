// ============================================================
// memory/recall/content —— 读取被选中记忆的正文并按预算注入
// ============================================================
//
// 【定位】Semantic Recall 的最后一步：把 selector 选中的文件读成正文，
//   作为一条独立的 user attachment 追加，而不是塞进系统提示词。
//
// 【读写边界】只读文件（readTextFileRange），不写记忆或索引。
// 【预算口径】单文件 200 行 / 4096 字节，先到者截断；截断时在尾部附上
//   原文件路径提示，避免模型以为正文到此结束。
// 【失败语义】单文件读取失败被丢弃（allSettled），不阻断其它文件；
//   全部失败返回空数组，调用方视为“本轮无召回”。
// 【不变量】每个结果携带 revisionId 与 mtimeMs，供 readFileState 做编辑冲突检测。
// ============================================================
import type { FileSystemPort } from "@zcode/contracts";

import type { MemoryManifestEntry, RecalledMemory } from "./types.js";

// 单文件行数上限：召回正文只用于提示，不是完整阅读。
const MEMORY_CONTENT_LINE_LIMIT = 200;
// 单文件字节上限，与行数上限共同约束单个 attachment 的体积。
const MEMORY_CONTENT_BYTE_LIMIT = 4096;
// 超过 1 天即打“可能过期”提示；按自然日向下取整。
const STALE_DAY_MS = 86_400_000;

/**
 * 并发读取所有选中记忆的正文。
 * 输入：manifest entry、FileSystemPort、当前时间、可选 abortSignal。
 * 输出：成功的 RecalledMemory 列表；顺序与输入 entries 一致（allSettled 保序）。
 * 副作用：只读文件系统。
 * 失败语义：单个文件读取失败被过滤掉，不返回 error 也不抛错；
 *   全部失败时返回空数组。
 * 不变量：召回不阻断对话——任何 I/O 问题都只能降级为“少召回几篇”。
 */
export async function readRecalledMemories(input: {
  entries: readonly MemoryManifestEntry[];
  fileSystem: FileSystemPort;
  nowMs: number;
  signal?: AbortSignal;
}): Promise<RecalledMemory[]> {
  const settled = await Promise.allSettled(
    input.entries.map((entry) =>
      readRecalledMemory(input.fileSystem, entry, input.nowMs, input.signal),
    ),
  );
  return settled
    .filter(
      (result): result is PromiseFulfilledResult<RecalledMemory> => result.status === "fulfilled",
    )
    .map((result) => result.value);
}

/**
 * 把召回结果拼成一条 user attachment 的正文。
 * 输入：已读取的 RecalledMemory 列表（可为空）。
 * 输出：Markdown 文本；空列表时为 ""。
 * 副作用：无。
 * 不变量：免责声明只在第一个文件前出现一次，避免每篇记忆都重复提示；
 *   其措辞要求模型“仅在确实相关时使用”，降低无关召回污染回答的风险。
 */
export function formatRelevantMemoryAttachment(memories: readonly RecalledMemory[]): string {
  return memories
    .map(
      (memory, index) =>
        `${
          index === 0
            ? "Retrieved for possible relevance — use only if it actually applies to what the user asked.\n\n"
            : ""
        }${memory.header}\n\n${memory.content}`,
    )
    .join("\n\n");
}

/**
 * 读取单个记忆文件并应用行数/字节预算。
 * 输入：文件系统、manifest entry（含 filePath/mtimeMs）、当前时间、abortSignal。
 * 输出：RecalledMemory（content/header/limit/revisionId/sizeBytes）。
 * 副作用：只读文件；abort 时 readTextFileRange 抛错并冒泡给 allSettled。
 * 失败语义：读取失败向上抛，由 readRecalledMemories 丢弃该文件。
 * 不变量：content 已去掉 BOM、统一为 LF；limit 只在截断时设置，表示实际保留行数。
 */
async function readRecalledMemory(
  fileSystem: FileSystemPort,
  entry: MemoryManifestEntry,
  nowMs: number,
  signal?: AbortSignal,
): Promise<RecalledMemory> {
  const result = await fileSystem.readTextFileRange(
    { path: entry.filePath, offsetLine: 0, limitLines: MEMORY_CONTENT_LINE_LIMIT },
    { signal },
  );
  // 先按行取前 200 行；BOM 和 CRLF 在这里统一，后续字节计算才可比。
  const normalized = result.content.replace(/^\uFEFF/u, "").replace(/\r\n/gu, "\n");
  const byteLimited = limitCompleteLinesByBytes(normalized);
  // totalLines 由文件系统端口给出，是判断“是否还有更多行”的唯一依据。
  const lineTruncated = result.totalLines > MEMORY_CONTENT_LINE_LIMIT;
  const truncated = byteLimited.truncated || lineTruncated;
  // 截断提示必须带原路径，否则模型无法按需用 Read 补读完整内容。
  const content = truncated
    ? `${byteLimited.content}\n\n> This memory file was truncated (${
        byteLimited.truncated
          ? `${MEMORY_CONTENT_BYTE_LIMIT} byte limit`
          : `first ${MEMORY_CONTENT_LINE_LIMIT} lines`
      }). Use the Read tool to view the complete file at: ${entry.filePath}`
    : byteLimited.content;

  return {
    content,
    filePath: entry.filePath,
    header: memoryHeader(entry.filePath, entry.mtimeMs, nowMs),
    limit: truncated ? byteLimited.lineCount : undefined,
    mtimeMs: entry.mtimeMs,
    revisionId: result.revision?.id,
    sizeBytes: result.sizeBytes,
  };
}

/**
 * 按 UTF-8 字节预算保留“完整行”。
 * 输入：已归一化的内容；输出：保留内容、保留行数、是否截断。
 * 副作用：无。
 * 失败语义：不抛错；第一行就超预算时返回空内容且 truncated=true。
 * 不变量：绝不把一行切成两半；字节数包含行间换行符（1 字节），
 *   与最终 join("\n") 的实际体积一致。
 */
function limitCompleteLinesByBytes(content: string): {
  content: string;
  lineCount: number;
  truncated: boolean;
} {
  const lines = content === "" ? [""] : content.split("\n");
  const selected: string[] = [];
  let selectedBytes = 0;

  for (const line of lines) {
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const nextBytes = selectedBytes + separatorBytes + Buffer.byteLength(line, "utf8");
    if (nextBytes > MEMORY_CONTENT_BYTE_LIMIT) {
      return { content: selected.join("\n"), lineCount: selected.length, truncated: true };
    }
    selected.push(line);
    selectedBytes = nextBytes;
  }

  return { content: selected.join("\n"), lineCount: selected.length, truncated: false };
}

/**
 * 生成记忆文件的注入头：路径 + 可选“可能过期”提醒。
 * 输入：文件路径、文件 mtime、当前时间。
 * 输出：Markdown 头文本；1 天内为简短形式，更久则附加过期警告。
 * 副作用：无。
 * 不变量：mtime 是召回时的 stat 值（不是内容里的时间戳），
 *   因此即便文件被改写，警告反映的也是真实修改时间。
 */
function memoryHeader(filePath: string, mtimeMs: number, nowMs: number): string {
  // 未来时间戳（时钟回拨）按 0 天处理，避免出现负数天数。
  const daysOld = Math.max(0, Math.floor((nowMs - mtimeMs) / STALE_DAY_MS));
  if (daysOld <= 1) return `Memory: ${filePath}:`;
  return `This memory is ${daysOld} days old. Memories are point-in-time observations, not live state — claims about code behavior or file:line citations may be outdated. Verify against current code before asserting as fact.\n\nMemory: ${filePath}:`;
}
