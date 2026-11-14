// INV-01 富预览字符阈值：守住位置 十八万常量；改错故障 超大文件整文件高亮卡死。
// INV-02 富预览行数阈值：守住位置 一千二常量；改错故障 超长文件仍在主线程比较。
// INV-03 来源文案缺省回退未暂存：守住位置 default 分支；改错故障 空来源显示空标题。
// INV-04 不可用文案分三档：守住位置 分支表；改错故障 二进制与截断共用错误文案。
// INV-05 缓存键只含来源与路径：守住位置 模板拼接；改错故障 不同来源互相覆盖。
// INV-06 查找内容仅 patch 可用：守住位置 可用性判断；改错故障 非 patch 也进入查找。
// INV-07 优先用整文件正文：守住位置 双侧非空判断；改错故障 命中差异文件头伪行。
// INV-08 降级后只搜可见行：守住位置 过滤与映射；改错故障 命中预览中不存在的行。
// INV-09 省略标记行不参与查找：守住位置 标记行数解析；改错故障 搜索定位到折叠提示。
// INV-10 错误信息优先 message：守住位置 实例判断；改错故障 错误显示成对象字符串。
// INV-11 结构化错误再读 message：守住位置 键存在判断；改错故障 第三方错误信息丢失。
// INV-12 逻辑行数不计尾换行：守住位置 结尾判断；改错故障 行数阈值提前触发。
// INV-13 缺失一侧即走 patch：守住位置 空值判断；改错故障 空文件被当作整文件删除。
// INV-14 字符超限走 patch：守住位置 字符数求和；改错故障 大文件整文件比较。
// INV-15 行数超限走 patch：守住位置 两侧取最大；改错故障 单侧超长仍走富预览。
// INV-16 预览计划三态互斥：守住位置 联合类型；改错故障 同一文件走两条渲染路径。
// INV-17 纯文本降级只认文本类型：守住位置 文件类型收口；改错故障 结构化文件丢失语义渲染。
// INV-18 本模块不持有差异状态：守住位置 纯函数；改错故障 组件缓存过期差异。
//
// 模块职责：Git 面板的差异预览降级策略、查找内容与文案映射。
// 状态所有权：无状态；差异数据由调用方传入。
// 阅读顺序：先看阈值与文案映射，再读查找内容，最后看预览计划与降级收口。
import type { GitChangeSourceId, GitDiffResult } from "@zcode/shared";
import { getFiletypeFromFileName } from "@pierre/diffs";
import {
  getPatchPreviewLineContent,
  getPlainTextPatchContentLines,
  getPlainTextPatchFallbackLines,
  parseTruncatedMarkerOmittedLineCount,
} from "@/lib/patchDiffPreview.js";

const MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT = 180_000;
const MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT = 1_200;

export type GitPaneDiffPreviewPlan =
  | {
      kind: "rich";
    }
  | {
      kind: "patch";
    }
  | {
      kind: "plain-text";
      lines: string[];
    };

export function getSourceMessageId(sourceId: GitChangeSourceId): string {
  switch (sourceId) {
    case "unstaged":
      return "git.source.unstaged";
    case "staged":
      return "git.source.staged";
    case "branch":
      return "git.source.branch";
    case "last-turn":
      return "git.source.lastTurn";
    default:
      return "git.source.unstaged";
  }
}

export function getDiffFallbackMessageId(
  availability: GitDiffResult["availability"],
): string {
  switch (availability) {
    case "binary":
      return "git.diff.binaryTitle";
    case "truncated":
      return "git.diff.truncatedTitle";
    default:
      return "git.diff.unavailableTitle";
  }
}

export function getDiffCacheKey(sourceId: GitChangeSourceId, path: string): string {
  return `${sourceId}:${path}`;
}

// 仅 patch 可用时处理。
// beforeContent 与 afterContent 都非空时直接拼接两者。
// 否则取可见行：plain-text 计划直接用 lines，其余走 getPlainTextPatchContentLines。
// 先用 parseTruncatedMarkerOmittedLineCount 剔除省略标记行。
// 再用 getPatchPreviewLineContent 剥掉 diff marker。
// 两侧正文都是 null 时返回 null，交给调用方判定无内容。
export function getGitPaneDiffFindContent(diff: GitDiffResult | null): string | null {
  if (diff?.availability !== "patch") {
    return null;
  }

  if (diff.beforeContent !== null && diff.afterContent !== null) {
    return `${diff.beforeContent}\n${diff.afterContent}`;
  }

  if (diff.patch) {
    const previewPlan = getGitPaneDiffPreviewPlan(diff);
    const visibleLines =
      previewPlan.kind === "plain-text"
        ? previewPlan.lines
        : getPlainTextPatchContentLines(diff.patch);

    // 全文内容降级后若直接搜索原始 patch，Git 文件头、index 和 hunk 头会
    // 产生预览中不存在的伪命中。查找必须复用实际可见行，并剥掉不会显示的 diff marker。
    return visibleLines
      .filter((line) => parseTruncatedMarkerOmittedLineCount(line) === null)
      .map(getPatchPreviewLineContent)
      .join("\n");
  }

  if (diff.beforeContent === null && diff.afterContent === null) {
    return null;
  }

  return `${diff.beforeContent ?? ""}\n${diff.afterContent ?? ""}`;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }

  return String(error);
}

function countLogicalLines(content: string | null): number {
  if (!content) {
    return 0;
  }

  let lineCount = content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }

  return lineCount;
}

// 无 patch 直接返回假。
// beforeContent 或 afterContent 为 null 时直接返回 true。
// 两侧长度求和后与 MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT 比较。
// 行数取 countLogicalLines 两侧结果的较大者。
// 字符数或行数任一超过阈值就返回 true。
// 本函数只读 diff 字段，不读任何渲染状态。
export function shouldRenderPatchOnlyGitDiffPreview(diff: GitDiffResult): boolean {
  if (diff.availability !== "patch" || !diff.patch) {
    return false;
  }

  // Repo 全文读取失败时 patch 仍然有效，但缺失的一侧不能再补成空文件交给
  // MultiFileDiff。把“不完整内容对”并入既有 patch 安全预检，避免整文件误判为增删。
  if (diff.beforeContent === null || diff.afterContent === null) {
    return true;
  }

  const fullContentCharCount =
    (diff.beforeContent?.length ?? 0) + (diff.afterContent?.length ?? 0);
  if (fullContentCharCount > MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT) {
    return true;
  }

  const fullContentLineCount = Math.max(
    countLogicalLines(diff.beforeContent),
    countLogicalLines(diff.afterContent),
  );

  return fullContentLineCount > MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT;
}

// 没有 patch 时返回 { kind: "rich" }。
// 纯文本降级最优先。
// 其次判断 patch 专用。
// 再尝试整段 patch 文本。
// 最后回退 patch 预览。
export function getGitPaneDiffPreviewPlan(diff: GitDiffResult | null): GitPaneDiffPreviewPlan {
  if (diff?.availability !== "patch" || !diff.patch) {
    return { kind: "rich" };
  }

  const reviewFallbackLines = shouldRenderPlainTextDiffPreview(diff.patch);
  if (reviewFallbackLines) {
    return {
      kind: "plain-text",
      lines: reviewFallbackLines,
    };
  }

  if (!shouldRenderPatchOnlyGitDiffPreview(diff)) {
    return { kind: "rich" };
  }

  const fullPatchFallbackLines = getPlainTextPatchFallbackLines(diff.patch);
  if (fullPatchFallbackLines) {
    return {
      kind: "plain-text",
      lines: fullPatchFallbackLines,
    };
  }

  // Review 面板展开大文件时，MultiFileDiff 会在 React render 阶段同步比较
  // before/after 整文件，并在初始高亮前构建整文件 plain AST。大文件只需要先看变更 hunk，
  // 因此超阈值时改走 PatchDiff，保留异步高亮 worker，同时避开整文件主线程开销。
  return { kind: "patch" };
}

// getPlainTextPatchFallbackLines 返回空时直接返回 null。
// 只有 patch 含 /dev/null 一侧时才继续判断文件类型。
// 由 getPatchContentFileName 取首个 --- 或 +++ 行的文件名。
// getFiletypeFromFileName 结果为 text 时返回 fallbackLines。
// 其余类型返回 null，保留 PatchDiff 的语义化渲染路径。
export function shouldRenderPlainTextDiffPreview(patch: string): string[] | null {
  const fallbackLines = getPlainTextPatchFallbackLines(patch);
  if (!fallbackLines) {
    return null;
  }

  const lines = patch.split(/\r?\n/);
  const isCreatedOrDeletedPatch =
    lines.some((line) => line === "--- /dev/null") ||
    lines.some((line) => line === "+++ /dev/null");
  if (!isCreatedOrDeletedPatch) {
    return fallbackLines;
  }

  const patchFileName = getPatchContentFileName(lines);
  if (!patchFileName) {
    return null;
  }

  // review 面板只该把纯文本新增/删除文件降级成轻量 preview。
  // 底层通用 fallback 为了避免文件变更展开空白，会覆盖 JSON 等结构化文件；
  // 这里重新按文件类型收口，避免结构化文件绕过 PatchDiff 的语义化渲染路径。
  return getFiletypeFromFileName(patchFileName) === "text"
    ? fallbackLines
    : null;
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    const fileName = line.slice(4).trim();
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}
