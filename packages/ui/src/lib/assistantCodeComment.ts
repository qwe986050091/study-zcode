// INV-01 指令名固定为 code-comment：守住位置 提取入口；改错故障：改名会让既有消息里的注释全部失效。
// INV-02 代码块内的同形文本不算指令：守住位置 保护区间判断；改错故障：把示例当指令会让展示文本被误删。
// INV-03 标题、正文、文件三项去空白后都非空才产出：守住位置 字段校验；改错故障：缺字段的指令会生成空卡片。
// INV-04 起始行必须是正整数：守住位置 整数解析；改错故障：零或负数会让区间指向文件头之前。
// INV-05 结束行为空时等于起始行：守住位置 区间构造；改错故障：缺省结束行会让卡片不知道覆盖到哪。
// INV-06 结束行小于起始行视为无区间：守住位置 区间合法性；改错故障：倒置区间会让高亮算出负长度。
// INV-07 优先级只接受零到三的单个数字：守住位置 优先级解析；改错故障：多位或负数会被当成合法档位。
// INV-08 区间与优先级缺失时不写对应字段：守住位置 结果组装；改错故障：写空字段会让下游误以为已指定。
// INV-09 整行只有指令时连换行一起删除：守住位置 替换区间；改错故障：只删指令会留下只含空白的行。
// INV-10 指令与正文同行时只替换成一个空格：守住位置 替换分支；改错故障：整段删除会让两侧文字粘连。
// INV-11 流式未闭合指令裁到文本末尾：守住位置 流式分支；改错故障：不裁会把内部协议原文闪给用户。
// INV-12 非流式不裁剪未闭合指令：守住位置 分支条件；改错故障：裁剪会让已完成的文本凭空少一截。
// INV-13 前缀残留从候选开始处裁到末尾：守住位置 前缀探测；改错故障：残留会让用户看到半截协议标记。
// INV-14 路径分隔符统一为正斜杠再去尾部斜杠：守住位置 路径归一；改错故障：反斜杠会让跨平台比较失败。
// INV-15 Windows 路径比较时忽略大小写：守住位置 比较键；改错故障：大小写不一致会让文件被判定在工作区外。
// INV-16 文件必须位于工作区之内才产出卡片：守住位置 相对路径解析；改错故障：越界路径会让卡片指向不可读位置。
// INV-17 卡片 id 由起始偏移与绝对路径拼成：守住位置 id 构造；改错故障：只用偏移会让不同文件互相覆盖。
// INV-18 卡片数量受上限截断：守住位置 返回收尾；改错故障：不设上限会让长消息渲染出海量卡片。
//
// 模块职责：从助手消息里提取 code-comment 指令，生成可见注释卡片并把协议原文从展示文本中抹去。
// 状态所有权：无状态；保护区间、替换项与可见文本都是单次调用的局部值。
// 阅读顺序：先看指令提取的字段校验，再看替换区间计算与流式裁剪，最后看工作区相对路径与卡片构造。
import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
  overlapsAssistantTextRanges,
} from "@/lib/assistantDirectiveParser.js";
import {
  resolveAssistantRawFilePath,
  type AssistantFilePathResolveOptions,
} from "@/lib/assistantFileReferences.js";

// 优先级是四个固定档位，数字越小越靠前
// 提取时只接受单字符数字，不接受多位或负数
// [失败路径] 宽松解析会把非法优先级当成最低档，排序静默错位
// 类型本身不校验，校验在提取函数里完成
// 档位只影响展示顺序，不影响是否提取
export type AssistantCodeCommentPriority = 0 | 1 | 2 | 3;

// 注释的最小形态：标题、正文、文件、原文起止偏移
// 行号区间与优先级都是可选的，缺省表示未指定
// sourceStart 与 sourceEnd 指向原始消息，供替换与稳定 id 使用
// [边界] 字段缺失时下游按未指定处理，而不是补默认值
// 卡片形态在此基础上追加解析后的路径与 id
// 标题与正文都是去空白后的文本，不再二次裁剪
export interface AssistantCodeComment {
  body: string;
  endLine?: number;
  file: string;
  priority?: AssistantCodeCommentPriority;
  sourceEnd: number;
  sourceStart: number;
  startLine?: number;
  title: string;
}

export interface AssistantCodeCommentCard extends AssistantCodeComment {
  displayPath: string;
  id: string;
  path: string;
}

export interface AssistantCodeCommentProjection {
  comments: AssistantCodeComment[];
  visibleText: string;
}

const CODE_COMMENT_DIRECTIVE_NAME = "code-comment";

// 只接受纯数字串，空值与带符号的数字都不算
// 解析后必须大于零才算有效
// [失败路径] 把零当作有效行号会让区间指向文件头之前
// 无效值统一返回空，由调用方决定是否使用区间
// 行号解析与优先级解析各自独立，不共享校验
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : undefined;
}

function parsePriority(value: string | undefined): AssistantCodeCommentPriority | undefined {
  if (!value || !/^[0-3]$/.test(value)) return undefined;
  return Number.parseInt(value, 10) as AssistantCodeCommentPriority;
}

// findMarkdownCodeRanges 先算出保护区间，块内指令不算数。
// parameters 缺失或 start 落在保护区间内时返回空数组。
// title、body、file 三者 trim 后都必须非空。
// startLine 有效才写区间，parsedEndLine 缺省时取 startLine。
// parsePriority 返回 undefined 时省略 priority 字段。
// 参数字典取自 directive.parameters，缺键按 undefined 处理。
export function extractAssistantCodeComments(content: string): AssistantCodeComment[] {
  const protectedRanges = findMarkdownCodeRanges(content);
  return extractAssistantDirectives(content, CODE_COMMENT_DIRECTIVE_NAME).flatMap((directive) => {
    if (
      !directive.parameters ||
      overlapsAssistantTextRanges(directive.start, directive.start + 1, protectedRanges)
    ) {
      return [];
    }

    const title = directive.parameters.title?.trim();
    const body = directive.parameters.body?.trim();
    const file = directive.parameters.file?.trim();
    if (!title || !body || !file) return [];

    const startLine = parsePositiveInteger(directive.parameters.start);
    const parsedEndLine = parsePositiveInteger(directive.parameters.end);
    const hasValidRange =
      startLine !== undefined && (parsedEndLine === undefined || parsedEndLine >= startLine);
    const priority = parsePriority(directive.parameters.priority);

    return [
      {
        title,
        body,
        file,
        sourceStart: directive.start,
        sourceEnd: directive.end,
        ...(hasValidRange
          ? {
              startLine,
              endLine: parsedEndLine ?? startLine,
            }
          : {}),
        ...(priority !== undefined ? { priority } : {}),
      },
    ];
  });
}

// lastIndexOf 与 indexOf 分别定位 lineStart 与 nextNewline。
// prefix 与 suffix 都为空时整行连换行一起删除。
// [失败路径] 只删 sourceStart 到 sourceEnd 会留下空白行。
// 否则把 sourceStart 到 sourceEnd 替换成一个空格。
function replacementForComment(
  content: string,
  comment: AssistantCodeComment,
): { end: number; replacement: string; start: number } {
  const lineStart = content.lastIndexOf("\n", comment.sourceStart - 1) + 1;
  const nextNewline = content.indexOf("\n", comment.sourceEnd);
  const lineEnd = nextNewline < 0 ? content.length : nextNewline;
  const prefix = content.slice(lineStart, comment.sourceStart);
  const suffix = content.slice(comment.sourceEnd, lineEnd);
  if (!prefix.trim() && !suffix.trim()) {
    return {
      start: lineStart,
      end: nextNewline < 0 ? lineEnd : nextNewline + 1,
      replacement: "",
    };
  }
  return {
    start: comment.sourceStart,
    end: comment.sourceEnd,
    replacement: " ",
  };
}

// 先调用 extractAssistantCodeComments 再逐条算 replacement。
// streaming 为真时找 findUnclosedAssistantDirectiveStart，裁到 content.length。
// [失败路径] 不裁剪会让未闭合协议原文直接进入 Markdown。
// streaming 为假时跳过裁剪，未闭合指令按普通文本展示。
// replacements 按 start 降序应用，前面偏移保持有效。
// 返回 comments 与抹除替换区间后的 visibleText。
export function projectAssistantCodeComments(
  content: string,
  options: { streaming: boolean },
): AssistantCodeCommentProjection {
  const comments = extractAssistantCodeComments(content);
  const replacements = comments.map((comment) => replacementForComment(content, comment));

  if (options.streaming) {
    const protectedRanges = findMarkdownCodeRanges(content);
    const unclosedStart = findUnclosedAssistantDirectiveStart(
      content,
      CODE_COMMENT_DIRECTIVE_NAME,
      protectedRanges,
    );
    if (unclosedStart !== null) {
      // 流式尾部如果直接交给 Markdown，会在闭合前把内部协议原文闪给用户。
      replacements.push({ start: unclosedStart, end: content.length, replacement: "" });
    } else {
      const prefixStart = findAssistantDirectivePrefixStart(
        content,
        [CODE_COMMENT_DIRECTIVE_NAME, "zcode-file-citation"],
        protectedRanges,
        {
          minimumSingleColonPrefixLength: ":zcode".length,
          singleColonDirectiveNames: ["zcode-file-citation"],
          tripleColonDirectiveNames: ["zcode-file-citation"],
        },
      );
      if (prefixStart !== null) {
        replacements.push({ start: prefixStart, end: content.length, replacement: "" });
      }
    }
  }

  let visibleText = content;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    visibleText =
      visibleText.slice(0, replacement.start) +
      replacement.replacement +
      visibleText.slice(replacement.end);
  }

  return { comments, visibleText };
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function isWindowsWorkspacePath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function resolveWorkspaceRelativePath(workspacePath: string, filePath: string): string | null {
  const normalizedWorkspace = normalizePath(workspacePath);
  const normalizedFile = normalizePath(filePath);
  const windows = isWindowsWorkspacePath(workspacePath);
  const comparedWorkspace = windows ? normalizedWorkspace.toLowerCase() : normalizedWorkspace;
  const comparedFile = windows ? normalizedFile.toLowerCase() : normalizedFile;
  if (!comparedFile.startsWith(`${comparedWorkspace}/`)) return null;
  return normalizedFile.slice(normalizedWorkspace.length + 1);
}

export function buildAssistantCodeCommentCards(
  content: string,
  workspacePath: string,
  limit = 50,
  options: AssistantFilePathResolveOptions = {},
): AssistantCodeCommentCard[] {
  return extractAssistantCodeComments(content)
    .flatMap((comment) => {
      const path = resolveAssistantRawFilePath(workspacePath, comment.file, options);
      const displayPath = path ? resolveWorkspaceRelativePath(workspacePath, path) : null;
      if (!path || !displayPath) return [];
      return [
        {
          ...comment,
          id: `code-comment:${comment.sourceStart}:${path}`,
          path,
          displayPath,
        },
      ];
    })
    .slice(0, limit);
}
