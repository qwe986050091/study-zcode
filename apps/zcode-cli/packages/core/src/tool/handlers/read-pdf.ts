// ============================================================
// Read 工具 PDF 分支
// ============================================================
// 两条互斥路径，由入参 `pages` 决定：
//   1) native：整份 PDF 以 base64 作为 file block 交给支持 PDF 输入的模型；
//      上限 READ_PDF_NATIVE_MAX_INPUT_BYTES，可选 pdfDocumentPort 只用于页数门禁。
//   2) pages：按页范围渲染成图片，再交给支持图片输入的模型；需要 pdfDocumentPort
//      与 imageProcessorPort，任一缺席都 fail closed 成 PDF_CONFIGURATION_ERROR。
// 之所以分两条：整份 PDF 对 provider 是原生文档输入；指定页范围则要本地渲染，
// 两者预算、错误码与所需端口完全不同，混成一条会让"缺端口"和"页数太多"难归因。
//
// 错误口径：本文件把 PdfDocumentPortError 穷尽映射成 ReadErrorCode（文档错误类别 →
// 稳定工具错误码），不做字符串解析；`cancelled` 没有对应码，因为它必须先转成
// CoreErrorType.ToolCancelled（见 rethrowPdfCancellation），否则 executor 会误判。
// 所有失败以 ToolHandlerFailure（result:false）返回，而端口缺失/未知异常仍抛出：
// 前者是模型可读的业务失败，后者是接线故障，应由 executor 归因。
//
// 反直觉：`isPdfPath && supportsPdfForExecution` 才进本分支。模型不支持 PDF 时，
// .pdf 会落到文本读取路径（由 io adapter 决定行为），而不是在这里报"模型不支持"，
// 因为 text 分支仍可能给出可用的降级结果。
// ============================================================

import { basename } from "node:path";
import {
  CoreErrorType,
  READ_IMAGE_MAX_BASE64_BYTES,
  READ_IMAGE_MAX_DIMENSION,
  READ_IMAGE_TARGET_BYTES,
  READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
  READ_MAX_OUTPUT_TOKENS,
  READ_PDF_EXTRACT_MAX_INPUT_BYTES,
  READ_PDF_MAX_PAGES_PER_REQUEST,
  READ_PDF_NATIVE_MAX_INPUT_BYTES,
  READ_PDF_NATIVE_MAX_PAGES,
  READ_PDF_RENDER_TIMEOUT_MS,
  ReadErrorCode,
  ReadInputJsonSchema,
  ReadPdfInputJsonSchema,
  PdfDocumentPortError,
  createCoreError,
  parseReadPdfPageRange,
  type JsonSchema,
  type ModelMessageContent,
  type PdfDocumentErrorCode,
  type ReadImageOutput,
  type ReadInput,
  type ReadOutput,
  type ReadPartsOutput,
  type ReadPdfOutput,
  type TraceContext,
} from "@zcode/contracts";
import type {
  ToolExecutionContext,
  ToolExecutionModelContext,
  ToolHandlerFailure,
} from "../types.js";

// provider description 里的 PDF 条目：只在模型支持 PDF 输入时插入，避免告诉不支持的模型
// 一个它会失败的读取方式。文案与 READ_PDF_MAX_PAGES_PER_REQUEST=20 硬绑定。
const READ_PROVIDER_PDF_DESCRIPTION_LINE =
  '- Reads PDFs via the `pages` parameter (e.g. "1-5", max 20 pages/request; required for PDFs over 10 pages).';
// PdfDocumentPortError.code → ReadErrorCode 的穷尽映射表。
// `cancelled: undefined` 不是遗漏：取消不允许被折叠成业务错误，必须由
// rethrowPdfCancellation 转成 ToolCancelled 后才能终止工具生命周期。
const READ_ERROR_CODE_BY_PDF_DOCUMENT_ERROR = {
  cancelled: undefined,
  corrupted: ReadErrorCode.PDF_INVALID,
  io_error: ReadErrorCode.PDF_IO_ERROR,
  page_out_of_range: ReadErrorCode.PDF_PAGE_OUT_OF_RANGE,
  password_protected: ReadErrorCode.PDF_PASSWORD_PROTECTED,
  permission_denied: ReadErrorCode.PDF_PERMISSION_DENIED,
  process_failed: ReadErrorCode.PDF_PROCESS_FAILED,
  timeout: ReadErrorCode.PDF_TIMEOUT,
  unavailable: ReadErrorCode.PDF_CONFIGURATION_ERROR,
} satisfies Record<PdfDocumentErrorCode, ReadErrorCode | undefined>;
// 根因：120 秒只属于 Poppler 子进程；executor 若使用同一上限，会提前占用
// 可用性检查、图片规范化和 finally 清理的时间，因此 pages 分支保留独立外层预算。
export const READ_PDF_TOOL_TIMEOUT_MS = READ_PDF_RENDER_TIMEOUT_MS + 30_000;

/**
 * 判断路径是否是 PDF（仅后缀判断，大小写不敏感，不做文件头嗅探）。
 * 返回 true 只代表"值得尝试 PDF 分支"，真正的有效性仍由 magic/端口校验决定。
 */
export function isPdfPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".pdf");
}

/**
 * 当前模型是否原生支持 PDF 输入。
 *
 * `supportsPdf !== true` 一律当 false（fail closed）：缺省/未知能力不能冒险把
 * base64 文档塞给 provider。该判断同时决定工具 schema（是否带 `pages`）与描述文案，
 * 保证模型看到的契约与实际分派一致。
 */
export function supportsPdfForExecution(context: ToolExecutionModelContext): boolean {
  return context.model?.properties.inputFormat.supportsPdf === true;
}

// 三态：true/false 是模型的明确声明，undefined 表示"未知"。
// pages 分支只拒绝**明确不支持图片**的模型（false）；未知时不擅自拦截，
// 保持与旧行为兼容，同时让 provider 自己的报错成为最终证据。
function supportsImagesForExecution(context: ToolExecutionModelContext): boolean | undefined {
  return context.model?.properties.inputFormat.supportsImage;
}

/**
 * 按当前模型能力选择 Read 的运行时/provider schema。
 * 支持 PDF → 带 `pages` 的 schema；否则用纯路径 schema，避免向模型暴露一个
 * 会被 `readPdfFile` 立即拒绝的参数。
 */
export function resolveReadInputSchema(context: ToolExecutionModelContext): JsonSchema {
  return supportsPdfForExecution(context) ? ReadPdfInputJsonSchema : ReadInputJsonSchema;
}

/**
 * 在基础描述中注入 PDF 用法说明（仅当模型支持 PDF）。
 *
 * 插入位置：紧跟 `- Reads images` 这一行之后，保持"读文本/图片/PDF/视频"的能力列表顺序；
 * 找不到锚点行时退化为追加到末尾，而不是丢文案——描述顺序只是可读性，不是正确性。
 * 纯字符串处理，无副作用；不得改变基础描述的其他行。
 */
export function resolveReadProviderDescription(
  baseDescription: string,
  context: ToolExecutionModelContext,
): string {
  if (!supportsPdfForExecution(context)) return baseDescription;
  const lines = baseDescription.split("\n");
  const imageLineIndex = lines.findIndex((line) => line.startsWith("- Reads images"));
  if (imageLineIndex < 0) return `${baseDescription}\n${READ_PROVIDER_PDF_DESCRIPTION_LINE}`;
  lines.splice(imageLineIndex + 1, 0, READ_PROVIDER_PDF_DESCRIPTION_LINE);
  return lines.join("\n");
}

/**
 * 按入参动态抬高本次调用的超时预算。
 *
 * 只在"模型支持 PDF + 路径是 .pdf + 给了 pages"时返回 READ_PDF_TOOL_TIMEOUT_MS；
 * 其余一律 undefined，表示交给 entry 默认 30s。为什么不一刀切提高默认值：
 * 普通文本读取不该为 PDF 渲染的 2 分钟预算买单；pages 之外的整份 PDF 读取也不需要
 * 渲染进程，仍走默认预算。
 * 纯函数、无 I/O；context 缺席时返回 undefined（提供给无法拿到模型能力的调用方）。
 */
export function resolveReadTimeoutBudgetMs(
  input: unknown,
  context?: ToolExecutionModelContext,
): number | undefined {
  if (!context || !supportsPdfForExecution(context) || !isRecord(input)) return undefined;
  return typeof input.file_path === "string" &&
    isPdfPath(input.file_path) &&
    typeof input.pages === "string"
    ? READ_PDF_TOOL_TIMEOUT_MS
    : undefined;
}

/**
 * PDF 分支入口：校验前置条件并按 `pages` 分派 native / 逐页渲染。
 *
 * 输入：filePath 已通过工作区约束；pages 是可选页范围字符串（1-indexed）。
 * 输出：整份 PDF（ReadPdfOutput）或页图片（ReadPartsOutput）；业务失败以
 * ToolHandlerFailure 返回，不抛异常。
 * 前置门禁顺序：先拒绝"有 pages 但模型明确不支持图片"，再做 stat/空文件检查，
 * 最后才分派。先做能力检查可以避免为一个注定失败的渲染读取整份文件。
 * 副作用：读取文件/调用 PDF 渲染子进程；取消时由端口信号统一终止。
 * 失败：stat/read 的 port 异常原样冒泡（接线/IO 故障）；文件类型、大小、页范围等
 * 业务问题映射为稳定 ReadErrorCode。
 */
export async function readPdfFile(
  input: Pick<ReadInput, "pages"> & { filePath: string },
  context: ToolExecutionContext,
): Promise<ReadOutput | ToolHandlerFailure> {
  if (input.pages !== undefined && supportsImagesForExecution(context) === false) {
    return failure(
      ReadErrorCode.PDF_PAGES_IMAGES_UNSUPPORTED,
      "The current model supports PDF input but does not support image input; remove the pages parameter.",
    );
  }
  const fileSystemPort = context.fileSystemPort;
  if (!fileSystemPort) {
    return failure(
      ReadErrorCode.PDF_CONFIGURATION_ERROR,
      "FileSystemPort is not configured for Read tool.",
    );
  }
  const trace = createToolTrace(context);
  const stat = await fileSystemPort.stat(
    { path: input.filePath, trace },
    { signal: context.abortSignal },
  );
  if (stat.kind !== "file") {
    return failure(ReadErrorCode.PDF_INVALID, `Path is not a regular file: ${input.filePath}`);
  }
  if (stat.sizeBytes === 0) {
    return failure(ReadErrorCode.PDF_INVALID, `PDF file is empty: ${input.filePath}`);
  }

  return input.pages === undefined
    ? await readNativePdf(input.filePath, stat.sizeBytes, trace, context)
    : await readPdfPages(input.filePath, input.pages, stat.sizeBytes, trace, context);
}

/**
 * native 路径：把整份 PDF 以 base64 交给 provider 原生解析。
 *
 * 只受 READ_PDF_NATIVE_MAX_INPUT_BYTES 限制；若存在 pdfDocumentPort，额外用
 * getPageCount 做页数门禁（超过 READ_PDF_NATIVE_MAX_PAGES 就要求 pages 参数）。
 * 缺失 pdfDocumentPort 不是错误：页数门禁是可选增强，没有端口就跳过。
 * 返回前必须校验 `%PDF-` magic：错误后缀的文件不能作为 PDF 发给 provider，
 * 否则失败发生在 provider 侧且错误更难归因。
 */
async function readNativePdf(
  filePath: string,
  sizeBytes: number,
  trace: TraceContext,
  context: ToolExecutionContext,
): Promise<ReadPdfOutput | ToolHandlerFailure> {
  if (sizeBytes > READ_PDF_NATIVE_MAX_INPUT_BYTES) {
    return failure(
      ReadErrorCode.PDF_TOO_LARGE,
      `PDF file exceeds maximum allowed size of ${formatFileSize(READ_PDF_NATIVE_MAX_INPUT_BYTES)}.`,
    );
  }

  if (context.pdfDocumentPort) {
    try {
      const pageCount = await context.pdfDocumentPort.getPageCount(
        { filePath, trace },
        { signal: context.abortSignal },
      );
      if (pageCount !== undefined && pageCount > READ_PDF_NATIVE_MAX_PAGES) {
        return failure(
          ReadErrorCode.PDF_TOO_MANY_PAGES,
          `This PDF has ${pageCount} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request.`,
        );
      }
    } catch (error) {
      rethrowPdfCancellation(error, context.abortSignal);
      // 根因：adapter 已用 undefined 表达 pdfinfo 的普通执行或解析失败；继续吞掉
      // port 抛出的未知异常会掩盖实现故障。这里只转换取消，其余异常保持原因向上冒泡。
      throw error;
    }
  }

  const read = await context.fileSystemPort!.readBinaryFile(
    { path: filePath, maxBytes: READ_PDF_NATIVE_MAX_INPUT_BYTES, trace },
    { signal: context.abortSignal },
  );
  if (!hasPdfMagic(read.content)) {
    return failure(
      ReadErrorCode.PDF_INVALID,
      `File is not a valid PDF (missing %PDF- header): ${filePath}`,
    );
  }
  return {
    type: "pdf",
    filePath,
    base64: Buffer.from(read.content).toString("base64"),
    originalSize: read.sizeBytes,
  };
}

/**
 * pages 路径：把指定页范围渲染成图片，返回有序的 ReadPartsOutput。
 *
 * 预算：READ_PDF_EXTRACT_MAX_INPUT_BYTES（比 native 宽松，因为渲染只取部分页）；
 * 页范围最多 READ_PDF_MAX_PAGES_PER_REQUEST 页。开放区间 "3-" 解析出的 lastPage 是
 * Infinity，这里必须拒绝：渲染端口需要具体末页，且开放区间可能一次渲染整份大文档。
 * 两个端口都必需：没有 pdfDocumentPort 无法渲染，没有 imageProcessorPort 无法把
 * 渲染结果压进 provider 的图片预算，任一缺失都返回配置错误而不是读半份。
 * 渲染后固定按 pageNumber 升序排序：多页文档的顺序决定模型理解，不能让 adapter 的
 * 并行完成顺序影响结果顺序。
 * 失败：PdfDocumentPortError 经穷尽映射成稳定错误码；取消转 ToolCancelled；
 * 未知异常原样冒泡。
 */
async function readPdfPages(
  filePath: string,
  pagesInput: string,
  sizeBytes: number,
  trace: TraceContext,
  context: ToolExecutionContext,
): Promise<ReadPartsOutput | ToolHandlerFailure> {
  if (sizeBytes > READ_PDF_EXTRACT_MAX_INPUT_BYTES) {
    return failure(
      ReadErrorCode.PDF_TOO_LARGE,
      `PDF file exceeds maximum allowed size for text extraction (${formatFileSize(READ_PDF_EXTRACT_MAX_INPUT_BYTES)}).`,
    );
  }
  const range = parseReadPdfPageRange(pagesInput);
  if (!range) {
    return failure(
      ReadErrorCode.PDF_INVALID,
      `Invalid pages parameter: "${pagesInput}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
    );
  }
  if (
    range.lastPage === Number.POSITIVE_INFINITY ||
    range.lastPage - range.firstPage + 1 > READ_PDF_MAX_PAGES_PER_REQUEST
  ) {
    // 注意：Infinity 必须单独判，`lastPage - firstPage + 1` 对它也是 Infinity，
    // 但显式列出是为了让"开放区间不可渲染"成为可读的意图，而不是算术上的巧合。
    return failure(
      ReadErrorCode.PDF_INVALID,
      `Page range "${pagesInput}" exceeds maximum of ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request. Please use a smaller range.`,
    );
  }
  if (!context.pdfDocumentPort) {
    return failure(
      ReadErrorCode.PDF_CONFIGURATION_ERROR,
      "PDF page extraction is not configured in this runtime.",
    );
  }
  if (!context.imageProcessorPort) {
    return failure(
      ReadErrorCode.PDF_CONFIGURATION_ERROR,
      "ImageProcessorPort is not configured for PDF page extraction.",
    );
  }

  try {
    const renderedPages = await context.pdfDocumentPort.renderPages(
      {
        filePath,
        firstPage: range.firstPage,
        lastPage: range.lastPage,
        trace,
      },
      { signal: context.abortSignal },
    );
    const preparedPages = await Promise.all(
      renderedPages.map(async (page) => {
        const prepared = await context.imageProcessorPort!.prepareForModel(
          {
            data: page.data,
            maxBase64Bytes: READ_IMAGE_MAX_BASE64_BYTES,
            maxDimension: READ_IMAGE_MAX_DIMENSION,
            maxRawBytes: READ_IMAGE_TARGET_BYTES,
            maxTokens: READ_MAX_OUTPUT_TOKENS,
            mediaType: page.mediaType,
            tokenToBase64CharRatio: READ_IMAGE_TOKEN_TO_BASE64_CHAR_RATIO,
            trace,
          },
          { signal: context.abortSignal },
        );
        return {
          type: "image" as const,
          pageNumber: page.pageNumber,
          base64: Buffer.from(prepared.data).toString("base64"),
          mimeType: isReadImageMime(prepared.mediaType) ? prepared.mediaType : page.mediaType,
          originalSize: page.data.byteLength,
          transformedSize: prepared.transformedSizeBytes,
          resized: prepared.resized,
          compressed: prepared.compressed,
          compressionStrategy: prepared.strategy,
          dimensions: {
            originalWidth: prepared.originalWidth,
            originalHeight: prepared.originalHeight,
            displayWidth: prepared.width,
            displayHeight: prepared.height,
          },
        } satisfies ReadImageOutput & { pageNumber: number };
      }),
    );
    preparedPages.sort((left, right) => left.pageNumber - right.pageNumber);
    // 为什么保留 filePath/numParts/originalSize：tool result 只投影图片，结构化 output
    // 仍要给 UI 与调试一条"这组图来自哪个 PDF、共几页"的可追踪线索。
    return {
      type: "parts",
      filePath,
      numParts: preparedPages.length,
      originalSize: sizeBytes,
      pages: preparedPages,
    };
  } catch (error) {
    rethrowPdfCancellation(error, context.abortSignal);
    if (error instanceof PdfDocumentPortError) {
      const errorCode = READ_ERROR_CODE_BY_PDF_DOCUMENT_ERROR[error.code];
      if (errorCode === undefined) throw error;
      // 根因：adapter 已提供稳定错误类别，统一折叠成 PDF_INVALID 会让 executor、
      // telemetry 和调用方无法区分环境故障与输入错误；core 只做穷尽映射，不解析文案。
      return failure(errorCode, error.message);
    }
    throw error;
  }
}

/**
 * 把 PDF 端口错误里的"取消"统一转成 CoreErrorType.ToolCancelled。
 *
 * 背景：ExecutionPort/runtime shutdown 可能通过端口返回 cancelled，而调用方的
 * AbortSignal 未必已中止。若让 PdfDocumentPortError 直接冒泡，executor 会把它当
 * 普通内部失败，工具生命周期无法按取消收口（不变量 1 的终态会错）。
 * 顺序上先判端口取消码，再判 signal：signal 已中止时保留原错误，让上层取消链处理
 * 自己的错误对象，不在这里二次包装。
 */
function rethrowPdfCancellation(error: unknown, signal: AbortSignal): void {
  // 根因：ExecutionPort 在 runtime shutdown 时可以返回 cancelled，而不改变调用方的
  // AbortSignal。端口错误若直接冒泡，executor 又会把它归为普通内部失败；在 Core
  // 边界转换为统一 ToolCancelled，才能同时停止读取并正确收口工具生命周期。
  if (error instanceof PdfDocumentPortError && error.code === "cancelled") {
    throw createCoreError(CoreErrorType.ToolCancelled, error.message, {
      cause: error,
      recoverable: true,
    });
  }
  if (signal.aborted) {
    throw error;
  }
}

/**
 * 把整份 PDF 输出投影成模型可见内容：一段说明 + 一个 application/pdf file block。
 *
 * 为什么带文字说明：file block 本身没有文件名/大小语义，说明行让模型知道读到的是
 * 哪份文件；`source` 里的 placeholder/sizeBytes 供 UI 与附件追踪使用。
 * base64 直接内联（native 路径已受 20MB 上限约束），不走 artifact，因为 provider
 * 需要原生文档字节而不是引用。
 */
export function formatReadPdfOutput(output: ReadPdfOutput): ModelMessageContent {
  return [
    {
      type: "text",
      text: `PDF file read: ${output.filePath} (${formatFileSize(output.originalSize)})`,
    },
    {
      type: "file",
      mediaType: "application/pdf",
      name: basename(output.filePath),
      dataUrl: `data:application/pdf;base64,${output.base64}`,
      source: {
        id: "read-pdf",
        kind: "inline",
        mimeType: "application/pdf",
        placeholder: basename(output.filePath),
        sizeBytes: output.originalSize,
      },
    },
  ];
}

/**
 * 把逐页渲染结果投影成模型可见内容：一段页数说明 + 每页一个 image block。
 *
 * 每个 image block 的 source.id 带页码，既保证多页图片在投影/落盘时有唯一身份，
 * 也让 UI 能按页定位。sizeBytes 优先用 transformedSize（实际载荷），缺省才退回
 * 原始渲染字节：预算是按真实发送字节算的，不能用未压缩大小误导（不变量 4）。
 */
export function formatReadPdfPagesOutput(output: ReadPartsOutput): ModelMessageContent {
  return [
    {
      type: "text",
      text: `PDF pages extracted: ${output.numParts} page(s) from ${output.filePath} (${formatFileSize(output.originalSize)})`,
    },
    ...output.pages.map((page) => ({
      type: "image" as const,
      mediaType: page.mimeType,
      dataUrl: `data:${page.mimeType};base64,${page.base64}`,
      source: {
        id: `read-pdf-page-${page.pageNumber}`,
        kind: "inline" as const,
        mimeType: page.mimeType,
        placeholder: `PDF page ${page.pageNumber}`,
        sizeBytes: page.transformedSize ?? page.originalSize,
      },
    })),
  ];
}

/**
 * 人类可读的二进制文件大小（1024 进制，最多一位小数，整数时省略 `.0`）。
 * 仅用于模型/UI 文案；不要把它当作预算计算函数——预算是字节精确比较。
 * 边界：负数/0 会落到 "N bytes" 分支，不做额外防御。
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${oneDecimal(bytes / 1024)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${oneDecimal(bytes / (1024 * 1024))}MB`;
  return `${oneDecimal(bytes / (1024 * 1024 * 1024))}GB`;
}

function oneDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/u, "");
}

// 只认文件头前 5 个字节 `%PDF-`：这是 PDF 规范要求的魔数。
// 不验证则把任意二进制当 PDF 发给 provider，失败会推迟到 provider 侧且难以归因。
function hasPdfMagic(data: Uint8Array): boolean {
  return data.byteLength >= 5 && Buffer.from(data.subarray(0, 5)).toString("ascii") === "%PDF-";
}

function isReadImageMime(value: string): value is ReadImageOutput["mimeType"] {
  return (
    value === "image/jpeg" ||
    value === "image/png" ||
    value === "image/gif" ||
    value === "image/webp"
  );
}

// 统一的业务失败形状。注意这里是"返回失败"而非抛错：executor 会把 ToolHandlerFailure
// 序列化成与成功结果配对的 tool_result（不变量 1），throw 则会走内部失败归因。
function failure(errorCode: ReadErrorCode, message: string): ToolHandlerFailure {
  return { result: false, errorCode, message };
}

function createToolTrace(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as TraceContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
