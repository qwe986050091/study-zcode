// ============================================================
// 文件定位：Bash 进度事件的预览切分器，被 bash-file-output 的共享轮询调用。
// 输入输出：一次有界尾读的解码文本 + 已读字节/文件总字节 + 上次总行数，返回短预览/完整预览。
// 副作用：无；只做字符串倒序扫描，不读文件、不推进状态。
// 失败语义：从不抛出；空文本时短预览为空、总行数沿用 previousLines。
// 不变量：预览永远取自文本尾部（最后 N 行），不会把头部内容当作最新进度。
// ============================================================
import type { ExecutionOutputPreview } from "@zcode/contracts";

// 短预览 5 行给模型/UI 做“最近在输出什么”的快速感知；完整预览 100 行供展开查看。
const SHORT_PREVIEW_LINES = 5;
const FULL_PREVIEW_LINES = 100;

/** 只扫描本次有界尾读；原始字节数用于 Windows 编码下的行数估计。 */
// 职责：从尾读文本切出短/完整预览，并给出总行数口径。
// 输入输出：text 是本次读取（尾部或整段）的文本；bytesRead/totalBytes 决定行数能否精确；
//   previousLines 是上一轮已知总行数，本轮 bytesRead=0 时原样沿用。
// 返回：text 为最后 5 行，fullText 为最后 100 行；linesEstimated=true 表示行数按字节比例估算。
export function buildBashOutputPreview(
  text: string,
  bytesRead: number,
  totalBytes: number,
  previousLines: number,
): ExecutionOutputPreview {
  let cursor = text.length;
  let shortStart = 0;
  let fullStart = 0;
  let lines = 0;
  while (cursor > 0) {
    cursor = text.lastIndexOf("\n", cursor - 1);
    lines += 1;
    if (lines === SHORT_PREVIEW_LINES) shortStart = cursor <= 0 ? 0 : cursor + 1;
    if (lines === FULL_PREVIEW_LINES) fullStart = cursor <= 0 ? 0 : cursor + 1;
  }
  // 只看得到文件尾部时，用 总字节/已读字节 的比例外推行数；估算值不能小于已知行数。
  const linesEstimated = bytesRead > 0 && bytesRead < totalBytes;
  const totalLines =
    bytesRead === 0
      ? previousLines
      : linesEstimated
        ? Math.max(previousLines, Math.round((totalBytes / bytesRead) * lines))
        : lines;
  return {
    text: text.slice(shortStart),
    fullText: text.slice(fullStart),
    totalLines,
    totalBytes,
    linesEstimated,
  };
}
