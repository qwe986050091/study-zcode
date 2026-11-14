// INV-01 指令名固定单值：守住位置 DIRECTIVE_NAME；改错故障 解析不到任何引用。
// INV-02 语法放宽三种冒号：守住位置 SYNTAX 常量；改错故障 模型输出变体全部失效。
// INV-03 路径去空白后保留：守住位置 path 映射；改错故障 含空格路径被截断。
// INV-04 目的为空也保留：守住位置 purpose 判断；改错故障 空串被当未提供。
// INV-05 产物类型原样透传：守住位置 artifactKind 映射；改错故障 预览类型推断失真。
// INV-06 无路径的指令不进结果：守住位置 flatMap 分支；改错故障 空路径卡片被渲染。
// INV-07 仅流式尾部才隐藏：守住位置 streaming 判断；改错故障 终态正文被截短。
// INV-08 空内容直接原样返回：守住位置 早退分支；改错故障 空消息被误判截断。
// INV-09 代码块内样例不参与：守住位置 protectedRanges；改错故障 协议示例被吞。
// INV-10 已闭合指令不移除：守住位置 unclosedStart 判断；改错故障 正常引用丢失。
// INV-11 已换行的未闭合指令保留：守住位置 解析器边界；改错故障 后续回答整段消失。
// INV-12 单冒号前缀长度固定：守住位置 SINGLE_COLON 常量；改错故障 前缀识别偏移。
// INV-13 双指令名一起扫描：守住位置 code-comment 数组；改错故障 前缀被提前截断。
// INV-14 扩展名匹配忽略大小写：守住位置 toLowerCase；改错故障 大写后缀无法预览。
// INV-15 扩展名表按后缀匹配：守住位置 endsWith 循环；改错故障 相似后缀误判。
// INV-16 无产物类型时用推断值：守住位置 undefined 分支；改错故障 可预览文件退回无预览。
// INV-17 产物类型与推断需一致：守住位置 相等比较；改错故障 错配文件打开失败。
// INV-18 不一致返回空表示不可预览：守住位置 末行返回；改错故障 错误类型传给预览器。
//
// 模块职责：解析正文里的文件引用指令，并决定流式阶段可见文本的截断位置。
// 状态所有权：无状态；全部导出均为纯函数。
// 阅读顺序：先看指令提取，再看流式投影，最后看预览类型推断。
import {
  extractAssistantDirectives,
  findAssistantDirectivePrefixStart,
  findMarkdownCodeRanges,
  findUnclosedAssistantDirectiveStart,
} from "@/lib/assistantDirectiveParser.js";

// ZCodeFileCitationPreviewKind 是封闭联合：docx/xlsx/pptx/pdf/video/audio 六种。
// 新增预览类型必须同步 PREVIEW_EXTENSION_TO_KIND，否则 inferPreviewKindFromPath 返回 null。
// artifactKind 描述产物来源，previewKind 只决定渲染器，两者由不同映射表维护。
export type ZCodeFileCitationPreviewKind = "docx" | "xlsx" | "pptx" | "pdf" | "video" | "audio";

// start 与 end 是正文中的字符区间，替换时按这两个下标切片。
// raw 保留指令原文，回显时不必按字段重新拼装。
// path 必填（空路径指令已在提取时丢弃），其余字段按需出现。
export interface ZCodeFileCitation {
  artifactKind?: string;
  end: number;
  path: string;
  purpose?: string;
  raw: string;
  start: number;
}

export interface ZCodeFileCitationDirective {
  artifactKind?: string;
  end: number;
  path?: string;
  purpose?: string;
  raw: string;
  start: number;
}

export interface ZCodeFileCitationProjection {
  visibleText: string;
}

const ARTIFACT_KIND_TO_PREVIEW_KIND: Readonly<
  Record<string, Exclude<ZCodeFileCitationPreviewKind, "pdf">>
> = {
  audio: "audio",
  document: "docx",
  presentation: "pptx",
  video: "video",
  workbook: "xlsx",
};
const PREVIEW_EXTENSION_TO_KIND: Readonly<Record<string, ZCodeFileCitationPreviewKind>> = {
  ".docx": "docx",
  ".flac": "audio",
  ".m4a": "audio",
  ".m4v": "video",
  ".mov": "video",
  ".mp3": "audio",
  ".mp4": "video",
  ".ogg": "audio",
  ".opus": "audio",
  ".pdf": "pdf",
  ".pptx": "pptx",
  ".xlsx": "xlsx",
  ".wav": "audio",
  ".webm": "video",
  ".weba": "audio",
};
const ZCODE_FILE_CITATION_DIRECTIVE_NAME = "zcode-file-citation";
const ZCODE_FILE_CITATION_SINGLE_COLON_PREFIX_LENGTH = ":zcode".length;
const ZCODE_FILE_CITATION_SYNTAX = {
  allowSingleColon: true,
  allowSmartQuotes: true,
  allowTripleColon: true,
} as const;

// 语法开关交给 extractAssistantDirectives：单冒号、智能引号与三冒号全部开启。
// directive.parameters.path 先 trim，非空才写入结果；空路径不产生 path 字段。
// 返回值只保留 start/end/raw/path，解析器的其余字段不透传。
export function extractZCodeFileCitationDirectives(content: string): ZCodeFileCitationDirective[] {
  return extractAssistantDirectives(
    content,
    ZCODE_FILE_CITATION_DIRECTIVE_NAME,
    ZCODE_FILE_CITATION_SYNTAX,
  ).map((directive) => ({
    start: directive.start,
    end: directive.end,
    raw: directive.raw,
    ...(directive.parameters?.path?.trim() ? { path: directive.parameters.path.trim() } : {}),
    ...(directive.parameters?.purpose !== undefined
      ? { purpose: directive.parameters.purpose }
      : {}),
    ...(directive.parameters?.artifact_kind !== undefined
      ? { artifactKind: directive.parameters.artifact_kind }
      : {}),
  }));
}

export function extractZCodeFileCitations(content: string): ZCodeFileCitation[] {
  return extractZCodeFileCitationDirectives(content).flatMap((directive) =>
    directive.path
      ? [
          {
            ...directive,
            path: directive.path,
          },
        ]
      : [],
  );
}

/**
 * 仅在流式尾部隐藏未闭合 citation。完整 citation 继续交给 remark 插件投影为正文链接，
 * 卡片是否生成仍由终态 row gate 决定。异常模型输出若已换行继续正文，则保留原文，避免
 * 一个缺失 `}` 的指令把后续回答全部吞掉；代码块中的协议样例也不参与隐藏。
 */
export function projectZCodeFileCitations(
  content: string,
  options: { streaming: boolean },
): ZCodeFileCitationProjection {
  // 终态或空内容原样返回，streaming 为假时不做任何裁剪。
  // 只有 options.streaming 为真且内容非空时才检查未闭合尾部。
  // 先算 findMarkdownCodeRanges，代码块内的协议样例不参与隐藏。
  // findUnclosedAssistantDirectiveStart 命中才切片，否则继续看前缀起点。
  if (!options.streaming || !content) return { visibleText: content };

  const protectedRanges = findMarkdownCodeRanges(content);
  const unclosedStart = findUnclosedAssistantDirectiveStart(
    content,
    ZCODE_FILE_CITATION_DIRECTIVE_NAME,
    protectedRanges,
    ZCODE_FILE_CITATION_SYNTAX,
  );
  if (unclosedStart === null) {
    const prefixStart = findAssistantDirectivePrefixStart(
      content,
      ["code-comment", ZCODE_FILE_CITATION_DIRECTIVE_NAME],
      protectedRanges,
      {
        minimumSingleColonPrefixLength: ZCODE_FILE_CITATION_SINGLE_COLON_PREFIX_LENGTH,
        singleColonDirectiveNames: [ZCODE_FILE_CITATION_DIRECTIVE_NAME],
        tripleColonDirectiveNames: [ZCODE_FILE_CITATION_DIRECTIVE_NAME],
      },
    );
    return prefixStart === null
      ? { visibleText: content }
      : { visibleText: content.slice(0, prefixStart) };
  }

  return {
    visibleText: content.slice(0, unclosedStart),
  };
}

// path 先 trim 并转小写，大小写与首尾空白不影响扩展名匹配。
// 遍历 PREVIEW_EXTENSION_TO_KIND 的键，用 endsWith 逐个比对。
// 首个命中的扩展名即返回对应 kind，全部未命中返回 null。
function inferPreviewKindFromPath(path: string): ZCodeFileCitationPreviewKind | null {
  const normalizedPath = path.trim().toLowerCase();
  for (const [extension, kind] of Object.entries(PREVIEW_EXTENSION_TO_KIND)) {
    if (normalizedPath.endsWith(extension)) return kind;
  }
  return null;
}

export function resolveZCodeFileCitationPreviewKind(params: {
  artifactKind?: string;
  path: string;
}): ZCodeFileCitationPreviewKind | null {
  const inferredKind = inferPreviewKindFromPath(params.path);
  if (params.artifactKind === undefined) return inferredKind;

  const artifactKind = ARTIFACT_KIND_TO_PREVIEW_KIND[params.artifactKind.trim().toLowerCase()];
  return artifactKind && artifactKind === inferredKind ? artifactKind : null;
}
