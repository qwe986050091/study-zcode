import { structuredPatch } from "diff";
import type { DiffHunk } from "@zcode/contracts";

// patch 展示的上下文行数固定 3 行：与 unified diff 习惯一致，直接影响模型看到的体积。
const CONTEXT_LINES = 3;
// diff 是同步 CPU 计算；超时 5s 后 diff 库返回 undefined，这里降级为空 hunks 而非抛错。
const DIFF_TIMEOUT_MS = 5_000;

/**
 * 计算 old→new 的结构化 patch（仅内存计算，不读写文件）。
 * 输入：filePath 只作为左右文件名；oldContent/newContent 为完整文本。
 * 输出：DiffHunk[]；两侧无差异、或 diff 计算超时（库返回 undefined）时返回 []。
 * 失败语义：不抛出，超时被降级成“无变更”，调用方不能把 [] 当成“内容相同”的强证据。
 * 消费者：apply-patch 落盘后生成展示 patch，以及 countPatchLines 统计增删行。
 */
export const createStructuredPatch = ({
  filePath,
  newContent,
  oldContent,
}: {
  filePath: string;
  newContent: string;
  oldContent: string;
}): DiffHunk[] => {
  const patch = structuredPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    undefined,
    undefined,
    {
      context: CONTEXT_LINES,
      timeout: DIFF_TIMEOUT_MS,
    },
  );

  return patch?.hunks ?? [];
};

/**
 * 统计结构化 patch 的增删行数，用于工具结果展示（不是文件行数）。
 * 口径：hunk.lines 的每一行首字符是 unified diff 标记，`+` 记新增、`-` 记删除；
 * 上下文行（前缀空格）与 hunk 头都不计入。行内容本身以 `+`/`-` 开头时仍只算一次标记。
 * 纯函数、无副作用；空 patch 返回 {0,0}。
 */
export const countPatchLines = (
  structuredPatch: DiffHunk[],
): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;

  for (const hunk of structuredPatch) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }

  return { additions, deletions };
};
