// ============================================================
// Read Tool - File Reading Tool
// ============================================================
// Reference: file read input / output shape
// 本文件只声明 Read 的入参/输出形状与预算常量，不执行读取。真实分派在 core 的
// handlers/read.ts：按扩展名依次尝试 图片 → 视频 → PDF → 文本，所有文件系统访问都走
// FileSystemPort，路径先经工作区约束。
// 行号口径：输入 offset 是 1-based 行号（0 与 1 都表示首行），传给端口时转成 0-based；
// limit 是行数上限。输出 startLine 从 1 起、numLines 是本次返回行数、totalLines 是文件总行数。
// 截断三种：truncated（字节截断）、truncatedByTokenCap（token 裁剪，只有它让 isPartialView=true）、
// range view（offset/limit 只看了窗口，不算 partial）。空文件归一为 numLines=1、totalLines=1。
// 读取边界：READ_MAX_FILE_SIZE_BYTES 只在未给 limit 时生效；二进制扩展名与 /dev 阻塞设备在
// 入参层直接拒绝，而不是读到一半失败。

import { z } from "zod";
import { VIDEO_INPUT_MAX_BYTES } from "@zcode/shared";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";
import { getReadPdfPagesValidationFailure, READ_PDF_PAGES_DESCRIPTION } from "./read-pdf.js";

export * from "./read-pdf.js";
export * from "./read-state.js";

// 单次文本读取的字节上限；**只在未给 limit 时生效**——给了 limit 就走按行读取，不受这个
// 整文件上限约束。它是"防止一次读爆上下文"的第一道闸，不是文件的硬性大小限制。
export const READ_MAX_FILE_SIZE_BYTES = 256 * 1024;
// 文本输出的 token 预算；超出时按 truncatedByTokenCap 裁剪，并把 isPartialView 置真。
// 它与字节截断是两件事：字节截断可能发生在 256KB 门禁，token 裁剪发生在模型侧预算。
export const READ_MAX_OUTPUT_TOKENS = 25_000;
// 未给 limit 时默认最多读取的行数（2000）；超过部分以 truncated/range 语义标记，而不是失败。
export const READ_DEFAULT_MAX_LINES = 2_000;
// 图片 base64 文本的上限（5MB）；超过先压缩/缩放，仍超则拒绝。
export const READ_IMAGE_MAX_BASE64_BYTES = 5 * 1024 * 1024;
// 图片解码后的目标字节数（按 base64 的 3/4 比例反推），用于压缩策略选择。
export const READ_IMAGE_TARGET_BYTES = Math.floor((READ_IMAGE_MAX_BASE64_BYTES * 3) / 4);
// 图片缩放的边长上限（像素）；超过时等比缩小，保证视觉 token 不爆炸。
export const READ_IMAGE_MAX_DIMENSION = 2000;
// 图片原始输入文件的大小上限（20MB）；超过直接拒绝，不尝试解码。
export const READ_IMAGE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
// token 与 base64 字符数的换算比例（0.125，即约 8 字符/token）；用于预算估算，非精确计数。
export const READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO = 0.125;
// 视频原始输入文件的大小上限；直接复用 shared 的 VIDEO_INPUT_MAX_BYTES，避免两处数值漂移。
export const READ_VIDEO_MAX_INPUT_BYTES = VIDEO_INPUT_MAX_BYTES;

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

// 明确按二进制对待的扩展名黑名单：Read 只读文本（cat -n 行号视图），命中这里的文件在入参层
// 直接报"无法读取二进制"，而不是把字节流拼成乱码文本。注意它只按后缀判断，不做文件头嗅探；
// 未列出的二进制格式可能落到文本分支，由 adapter 决定实际行为。
const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  ".7z",
  ".a",
  ".bin",
  ".bz2",
  ".class",
  ".dll",
  ".dmg",
  ".dylib",
  ".exe",
  ".gz",
  ".jar",
  ".o",
  ".pyc",
  ".rar",
  ".so",
  ".tar",
  ".tgz",
  ".wasm",
  ".zip",
]);
// 会阻塞或无限输出的设备文件黑名单（/dev/zero、/dev/tty、stdin/stdout 等）。读取它们不是
// "报错"，而是可能永远不返回或撑爆内存，所以在入参层 fail fast；只做精确路径匹配。
const BLOCKING_DEVICE_PATHS = new Set([
  "/dev/console",
  "/dev/fd/0",
  "/dev/fd/1",
  "/dev/fd/2",
  "/dev/full",
  "/dev/random",
  "/dev/stderr",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/tty",
  "/dev/urandom",
  "/dev/zero",
]);

// provider 可见的基础输入形状（不含 pages）。它是 ReadInputJsonSchema 的投影源，也被 PDF
// schema extend 出去；字段描述直接进模型提示词，改文案等于改模型行为。
const ReadProviderInputBaseSchema = z.object({
  /**
   * The absolute path to the file to read.
   */
  // 目标文件的绝对路径；相对路径由上层/工作区策略处理，契约层只声明"应传绝对路径"。
  file_path: z.string().describe("The absolute path to the file to read"),
  /**
   * The line number to start reading from. Only provide if the file is too large to read at once
   */
  // 起始行号，1-based；0 与 1 都被当作首行。上限用 MAX_SAFE_INTEGER 而不是实际行数，
  // 因为此刻还不知道文件多大——越界由读取端归一/裁剪。
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "The line number to start reading from. Only provide if the file is too large to read at once",
    ),
  /**
   * The number of lines to read. Only provide if the file is too large to read at once.
   */
  // 本次读取的行数上限，必须为正整数。**只要给了 limit，就不再受 256KB 整文件门禁约束**，
  // 这是模型读大文件局部时唯一可行的路径。
  limit: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "The number of lines to read. Only provide if the file is too large to read at once.",
    ),
});

// provider 可见的 PDF 变体：在基础形状上多一个 pages。只有支持 PDF 的模型才会拿到它
//（见 core 的 resolveReadInputSchema），避免向不支持的模型暴露一个必然失败的参数。
const ReadProviderPdfInputSchema = ReadProviderInputBaseSchema.extend({
  // 页码范围（"1-5"/"3"/"10-20"），1-indexed、单请求最多 20 页；非 PDF 文件会被忽略。
  pages: z.string().optional().describe(READ_PDF_PAGES_DESCRIPTION),
});

// 运行时入参 schema：在 PDF 变体上叠加语义校验（二进制/设备/页码范围），供 handler 与
// executor 使用。它比 provider 投影更严格，因为 superRefine 不会被投影成 JSON Schema。
export const ReadInputSchema = ReadProviderPdfInputSchema.superRefine(validateReadInputSemantics);

// provider 可见的基础输入 schema（无 pages）；用于不支持 PDF 的模型。
export const ReadInputJsonSchema = toToolJsonSchema(ReadProviderInputBaseSchema);
// provider 可见的输入 schema（带 pages）；用于支持 PDF 的模型，与运行时 schema 的字段一致。
export const ReadPdfInputJsonSchema = toToolJsonSchema(ReadProviderPdfInputSchema);

// 入参的跨字段语义校验：先判 pages（只对 .pdf 生效），再判路径本身（设备/二进制扩展名）。
// pages 校验失败时直接返回，不再叠加路径问题——一次给出一个可行动的修复方向。
function validateReadInputSemantics(
  input: { file_path?: unknown; pages?: unknown },
  context: z.RefinementCtx,
): void {
  // file_path 不是字符串时直接放行：类型错误归基础 schema 管，这里只做跨字段语义；
  // 提前返回也避免对非字符串调 toLowerCase 抛 TypeError，把校验异常变成 500。
  if (typeof input.file_path !== "string") return;
  // 统一小写只用于后缀与设备名比较（Windows 路径大小写不敏感）；
  // 报错文案与后续读取仍用原始 filePath，保留用户输入的大小写。
  const filePath = input.file_path;
  const lowerPath = filePath.toLowerCase();

  // 只有 pages 是字符串时才做页码范围校验：非字符串交给基础 schema 报类型错误，
  // 若这里也报，同一字段会出现两条互相矛盾的错误。
  const pagesFailure =
    typeof input.pages === "string"
      ? getReadPdfPagesValidationFailure(filePath, input.pages)
      : undefined;
  // 页码非法就立即返回：一次只给一个可行动的错误，避免页码问题与路径问题混在一起，
  // 模型同时看到两条会不知道先改哪个。
  if (pagesFailure) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["pages"],
      message: pagesFailure.message,
    });
    return;
  }

  // 页码通过后再校验路径语义（设备文件、二进制后缀），两条规则互斥不叠加。
  validateReadPathSemantics(filePath, lowerPath, context);
}

// 路径语义校验：阻塞设备优先于二进制扩展名（设备路径往往没有后缀，先判后缀会漏掉它们）。
// 命中后按路径字段报错，模型据此能立刻改成读普通文件，而不是在读取阶段拿到超时。
function validateReadPathSemantics(
  filePath: string,
  lowerPath: string,
  context: z.RefinementCtx,
): void {
  // 先判设备路径：/dev/zero、/dev/random 这类读取会无限输出或永久阻塞，
  // 且它们多数没有扩展名，必须先于后缀判断，否则会被"无后缀即放行"漏掉。
  if (BLOCKING_DEVICE_PATHS.has(lowerPath)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["file_path"],
      message: `Cannot read '${filePath}': this device file would block or produce infinite output.`,
    });
    return;
  }

  // 取最后一个点之后的后缀；没有后缀（目录、无点文件名）时返回 undefined。
  const extension = readFileExtension(lowerPath);
  // 非二进制后缀直接放行：这里只拦"必然读不出有意义文本"的类型，不做白名单，
  // 避免把未知但可读的文本格式误判成二进制。
  if (!extension || !UNSUPPORTED_BINARY_EXTENSIONS.has(extension)) return;

  // 命中二进制后缀才报错；报错挂 file_path 字段，模型能直接定位并换用合适的工具。
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["file_path"],
    message: `This tool cannot read binary files. The file appears to be a binary ${extension} file. Please use appropriate tools for binary file analysis.`,
  });
}

// 运行时入参类型；offset/limit 可选，pages 可选，其余语义由校验函数保证。
export type ReadInput = z.infer<typeof ReadInputSchema>;

// 取路径的最后一段后缀（含点），不依赖 node:path，因为入参可能是任意平台风格路径。
// 返回 undefined 表示没有可用后缀（无点、点开头、或点在最后一段开头），此类文件不做二进制拒绝。
function readFileExtension(path: string): string | undefined {
  // 同时认 / 与 \：入参可能来自另一平台（远程 workspace 或模型手写路径），
  // 用 node:path 会按宿主平台只认一种分隔符，导致后缀判断整体失效。
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = path.slice(lastSlash + 1);
  const dotIndex = basename.lastIndexOf(".");
  // dotIndex<=0 覆盖三种情况：无点、点在首位（.bashrc 是隐藏文件而非后缀）、
  // 点在最后一段开头；都返回 undefined，由调用方当普通文本处理。
  if (dotIndex <= 0) return undefined;
  return basename.slice(dotIndex);
}

// -----------------------------------------------
// Output Types
// -----------------------------------------------

// 文本读取输出（cat -n 行号视图）。它是 Read 最常见的形态：content 带行号，startLine/numLines
// 描述本次窗口，totalLines 是全文行数。空文件归一为 numLines=1、totalLines=1，避免模型看到
// 0 行而误判文件不存在。三种截断字段的语义见文件头，只有 truncatedByTokenCap 会让
// isPartialView=true（由 handler 写入 read-state）。
export interface ReadTextOutput {
  // 判别值：文本分支。
  type: "text";
  // 被读取的文件路径（与入参一致，不回写规范化后的路径）。
  filePath: string;
  // 带行号的文本内容；行号从 startLine 起，格式为 "N→..."。
  content: string;
  // 本次返回的行数；空文件也记为 1，保证"读到了东西"这一信号不为 0。
  numLines: number;
  // 本次窗口的起始行号，1-based。
  startLine: number;
  // 文件总行数（不是本次返回行数）；用于模型判断还剩多少没读。
  totalLines: number;
  // 文件字节数；宿主未提供 stat 时缺席。
  sizeBytes?: number;
  // 本次实际读到的字节数；与 sizeBytes 不等说明发生字节截断。
  bytesRead?: number;
  // 是否因字节上限（256KB/输出预算）截断；为真表示 content 不是完整窗口。
  truncated?: boolean;
  // 是否因 token 预算被裁剪；只有它为真时 read-state 的 isPartialView 才为真。
  truncatedByTokenCap?: boolean;
  // 面向模型的"这是部分视图"提示文案；存在时说明内容不完整，需要继续读或缩小范围。
  partialViewNotice?: string;
}

// 图片读取输出：base64 原图（可能已经压缩/缩放），交给 provider 转成 image 内容块。
// originalSize 与 transformedSize 让模型/UI 知道是否发生了处理；dimensions 同时保留原始与
// 展示尺寸，避免缩放后无法回溯原图比例。
export interface ReadImageOutput {
  // 判别值：图片分支。
  type: "image";
  // 图片的 base64 数据；已按目标字节数处理，不超过 READ_IMAGE_MAX_BASE64_BYTES。
  base64: string;
  // MIME 类型；只允许这四种，避免把未知格式塞给 provider。
  mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  // 原始文件字节数；用于判断是否被压缩。
  originalSize: number;
  // 处理后字节数；未被处理时缺席。
  transformedSize?: number;
  // 是否发生过缩放；为真时 dimensions 的 display 尺寸小于 original。
  resized?: boolean;
  // 是否发生过重编码压缩；与 resized 独立（可只压缩不缩放）。
  compressed?: boolean;
  // 压缩策略名（如 "jpeg-quality"）；诊断用，缺失表示未压缩。
  compressionStrategy?: string;
  // 尺寸元数据；缺失表示宿主未提供，不能据此推断原图很小。
  dimensions?: {
    // 原始宽度（像素）。
    originalWidth?: number;
    // 原始高度（像素）。
    originalHeight?: number;
    // 展示/缩放后宽度；与 originalWidth 相同表示未缩放。
    displayWidth?: number;
    // 展示/缩放后高度。
    displayHeight?: number;
  };
}

/** Read 视频输出：不做转码/压缩，仅读取 base64 并做大小校验。 */
// 视频分支只做"读字节 + 大小校验"，不转码也不抽帧：转码成本高且会改变内容。mimeType 白名单
// 覆盖常见容器；不在白名单的视频会被拒绝，而不是以错误类型塞给 provider。
export interface ReadVideoOutput {
  // 判别值：视频分支。
  type: "video";
  // 视频原始字节的 base64；未做任何转码。
  base64: string;
  // 容器 MIME；白名单外的格式不支持。
  mimeType:
    | "video/mp4"
    | "video/quicktime"
    | "video/webm"
    | "video/x-matroska"
    | "video/x-m4v"
    | "video/x-msvideo";
  // 原始文件字节数；用于对照 READ_VIDEO_MAX_INPUT_BYTES。
  originalSize: number;
}

// Jupyter notebook 读取输出：按 cell 结构化返回，而不是把 .ipynb 当 JSON 文本。
// cells 保留 source 与可选 outputs，让模型能区分代码、markdown 与执行结果。
export interface ReadNotebookOutput {
  // 判别值：notebook 分支。
  type: "notebook";
  // notebook 文件路径。
  notebookPath: string;
  // 按文件顺序排列的 cell；不丢空 cell（空 cell 也是作者意图的一部分）。
  cells: NotebookCell[];
}

// 单个 notebook cell：类型、源码与可选的输出列表。cellType 只有 code/markdown 两种，
// raw cell 不进入这里（读取端会归一或跳过）。
export interface NotebookCell {
  // cell 类型：代码或 markdown。
  cellType: "code" | "markdown";
  // cell 源码原文（可能多行）；不做语法处理。
  source: string;
  // 代码 cell 的执行输出；markdown cell 通常没有。
  outputs?: CellOutput[];
}

// cell 的一条输出：流式文本、执行结果、错误或展示数据。text 已由读取端拼接成字符串，
// metadata 保留原始结构（如图片 MIME），本层不解析。
export interface CellOutput {
  // 输出类型：stream（stdout/stderr）、execute_result、error、display_data。
  type: "stream" | "execute_result" | "error" | "display_data";
  // 文本内容；非文本展示（如图片）可能为空，需结合 metadata 解读。
  text: string;
  // 原始输出元数据；开放结构，读取端原样透传。
  metadata?: Record<string, unknown>;
}

// PDF 的 native 路径输出：整份文件 base64 交给支持 PDF 输入的模型。pages 在这里不是页码
// 范围，而是"这份 PDF 的读取说明/已请求范围"的可选回显，缺失表示整份读取。
export interface ReadPdfOutput {
  // 判别值：PDF native 分支。
  type: "pdf";
  // PDF 文件路径。
  filePath: string;
  // 整份 PDF 的 base64；受 READ_PDF_NATIVE_MAX_INPUT_BYTES 限制。
  base64: string;
  // 原始文件字节数。
  originalSize: number;
  // 可选回显：本次读取携带的 pages 参数；缺失表示整份文档。
  pages?: string;
}

// PDF 的 pages 路径输出：把指定页范围逐页渲染成图片。numParts 与 pages.length 一致；
// pageNumber 是 1-indexed 的真实页码，用来把图片与原文页对应起来。
export interface ReadPartsOutput {
  // 判别值：PDF 分页渲染分支。
  type: "parts";
  // 源 PDF 文件路径。
  filePath: string;
  // 渲染出的页数；等于 pages.length。
  numParts: number;
  // 源文件字节数（不是渲染后图片之和）。
  originalSize: number;
  // 每页的图片输出 + 真实页码；页码 1-indexed，且落在请求范围内。
  pages: Array<ReadImageOutput & { pageNumber: number }>;
}

// 缓存命中输出：文件自上次读取后未被改动，因此不返回内容，只回一个桩让模型知道"不必重读"。
// 它不刷新 read-state 的 readAt，避免把旧内容伪装成一次新读取。
export interface ReadUnchangedOutput {
  // 判别值：file_unchanged 桩。
  type: "file_unchanged";
  // 命中缓存的文件路径；用于与原始请求对上。
  filePath: string;
}

// 七种读取结果的判别联合，由 type 字段区分；下游（formatModelContent、持久化回放）按 type
// 窄化。新增分支必须同时补齐运行时 schema、JSON 投影与模型内容格式化，缺一会在回放时
// 被 ReadOutputSchema 判为无效。
export type ReadOutput =
  | ReadTextOutput
  | ReadImageOutput
  | ReadVideoOutput
  | ReadNotebookOutput
  | ReadPdfOutput
  | ReadPartsOutput
  | ReadUnchangedOutput;

// 文本输出的运行时 schema，与 ReadTextOutput 接口一一对应；strict 保证回放时不会混入其它
// 分支的字段。字段口径见接口注释，这里只强调 schema 侧的类型约束。
export const ReadTextOutputSchema = z
  .object({
    // 判别值，锁死为 "text"。
    type: z.literal("text"),
    // 文件路径。
    filePath: z.string(),
    // 带行号的文本内容。
    content: z.string(),
    // 本次返回行数；空文件归一为 1。
    numLines: z.number().int().nonnegative(),
    // 窗口起始行号，1-based。
    startLine: z.number().int().nonnegative(),
    // 文件总行数。
    totalLines: z.number().int().nonnegative(),
    // 文件字节数；缺失表示未 stat。
    sizeBytes: z.number().int().nonnegative().optional(),
    // 实际读取字节数；用于识别字节截断。
    bytesRead: z.number().int().nonnegative().optional(),
    // 字节截断标记。
    truncated: z.boolean().optional(),
    // token 裁剪标记；只有它使 isPartialView=true。
    truncatedByTokenCap: z.boolean().optional(),
    // 部分视图提示文案。
    partialViewNotice: z.string().optional(),
  })
  .strict();

// 图片尺寸元数据的 schema：四个字段都可选，缺失表示宿主未提供对应事实，不能当作 0。
export const ReadImageDimensionsSchema = z
  .object({
    // 原图宽度（像素）。
    originalWidth: z.number().int().nonnegative().optional(),
    // 原图高度（像素）。
    originalHeight: z.number().int().nonnegative().optional(),
    // 缩放后展示宽度；与 originalWidth 相同表示未缩放。
    displayWidth: z.number().int().nonnegative().optional(),
    // 缩放后展示高度。
    displayHeight: z.number().int().nonnegative().optional(),
  })
  .strict();

// 图片输出的运行时 schema；mimeType 用 enum 锁死四种，防止 provider 收到不支持的格式。
export const ReadImageOutputSchema = z
  .object({
    // 判别值，锁死为 "image"。
    type: z.literal("image"),
    // 处理后图片的 base64。
    base64: z.string(),
    // MIME 白名单：jpeg/png/gif/webp。
    mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    // 原始文件字节数。
    originalSize: z.number().int().nonnegative(),
    // 处理后字节数；未处理时缺席。
    transformedSize: z.number().int().nonnegative().optional(),
    // 是否缩放。
    resized: z.boolean().optional(),
    // 是否重编码压缩。
    compressed: z.boolean().optional(),
    // 压缩策略名；诊断用。
    compressionStrategy: z.string().optional(),
    // 尺寸元数据；缺失表示未提供。
    dimensions: ReadImageDimensionsSchema.optional(),
  })
  .strict();

// 视频输出的运行时 schema；同样用 MIME 白名单，且不做转码。
export const ReadVideoOutputSchema = z
  .object({
    // 判别值，锁死为 "video"。
    type: z.literal("video"),
    // 视频原始字节 base64。
    base64: z.string(),
    // 容器 MIME 白名单。
    mimeType: z.enum([
      "video/mp4",
      "video/quicktime",
      "video/webm",
      "video/x-matroska",
      "video/x-m4v",
      "video/x-msvideo",
    ]),
    // 原始文件字节数。
    originalSize: z.number().int().nonnegative(),
  })
  .strict();

// notebook cell 输出的 schema；metadata 是开放 record（如图片 MIME），读取端原样透传。
export const ReadCellOutputSchema = z
  .object({
    // 输出类型四选一。
    type: z.enum(["stream", "execute_result", "error", "display_data"]),
    // 已拼接成字符串的文本内容。
    text: z.string(),
    // 原始输出元数据；开放结构。
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

// 单个 notebook cell 的 schema；outputs 只对代码 cell 有意义，但仍用可选表达。
export const ReadNotebookCellSchema = z
  .object({
    // cell 类型：code 或 markdown。
    cellType: z.enum(["code", "markdown"]),
    // cell 源码。
    source: z.string(),
    // 执行输出列表；代码 cell 才可能有。
    outputs: z.array(ReadCellOutputSchema).optional(),
  })
  .strict();

// notebook 输出的 schema；cells 顺序与文件一致。
export const ReadNotebookOutputSchema = z
  .object({
    // 判别值，锁死为 "notebook"。
    type: z.literal("notebook"),
    // notebook 文件路径。
    notebookPath: z.string(),
    // 按文件顺序排列的 cell。
    cells: z.array(ReadNotebookCellSchema),
  })
  .strict();

// PDF native 输出的 schema；pages 是可选回显，不是页码范围。
export const ReadPdfOutputSchema = z
  .object({
    // 判别值，锁死为 "pdf"。
    type: z.literal("pdf"),
    // PDF 文件路径。
    filePath: z.string(),
    // 整份 PDF 的 base64。
    base64: z.string(),
    // 原始文件字节数。
    originalSize: z.number().int().nonnegative(),
    // 可选回显的 pages 参数。
    pages: z.string().optional(),
  })
  .strict();

// PDF 分页渲染输出的 schema；pageNumber 用 positive 约束（1-indexed，0 非法）。
export const ReadPartsOutputSchema = z
  .object({
    // 判别值，锁死为 "parts"。
    type: z.literal("parts"),
    // 源 PDF 文件路径。
    filePath: z.string(),
    // 渲染出的页数；等于 pages.length。
    numParts: z.number().int().nonnegative(),
    // 源文件字节数。
    originalSize: z.number().int().nonnegative(),
    // 每页图片 + 真实页码；页码必须为正整数。
    pages: z.array(ReadImageOutputSchema.extend({ pageNumber: z.number().int().positive() })),
  })
  .strict();

// 缓存命中桩的 schema；只有判别值与路径，刻意不带内容。
export const ReadUnchangedOutputSchema = z
  .object({
    // 判别值，锁死为 "file_unchanged"。
    type: z.literal("file_unchanged"),
    // 命中缓存的文件路径。
    filePath: z.string(),
  })
  .strict();

// 输出联合：用 z.union（不是 discriminatedUnion）是因为七种分支的判别值都在字面量 type 上，
// 但保持与接口 union 的顺序一致，便于回放时按顺序命中。未知形状不会被静默放行。
export const ReadOutputSchema = z.union([
  ReadTextOutputSchema,
  ReadImageOutputSchema,
  ReadVideoOutputSchema,
  ReadNotebookOutputSchema,
  ReadPdfOutputSchema,
  ReadPartsOutputSchema,
  ReadUnchangedOutputSchema,
]);

// provider 可见的输出 schema，供跨进程回放校验；新增分支必须同时加入上面的 union 与这里。
export const ReadOutputJsonSchema = toToolJsonSchema(ReadOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

// Read 调用外壳：把一次工具调用所需的标识、入参与时间串在一起。它是事件/持久化的形状，
// 不参与执行；真实调用由 executor 构造并交给 handler。
export interface ReadToolCall {
  // 本次 tool_call 的唯一 id；结果必须按它配对。
  id: ToolCallId;
  // 工具名固定为 "Read"；判别键，不能与其它读取类工具混用。
  name: "Read";
  // 已校验的入参；offset 仍是模型传入的 1-based 值。
  input: ReadInput;
  // 追踪 id；用于把读取事件挂到当前 turn 的链路。
  traceId: TraceId;
  // 调用开始时间；用于计算 durationMs。
  startedAt: Date;
}

// Read 结果外壳：输出 + 配对信息 + 耗时。durationMs 是整条工具调用的墙钟耗时，不是纯读盘耗时；
// 纯读盘耗时在遥测的 filesystem detail 里。
export interface ReadToolResult {
  // 与 ReadToolCall.id 对应的 tool_call id。
  toolCallId: ToolCallId;
  // 七种读取结果之一；下游按 type 窄化。
  output: ReadOutput;
  // 与调用一致的追踪 id。
  traceId: TraceId;
  // 从 startedAt 到结果产出（含权限等待）的毫秒数。
  durationMs: number;
}
