/**
 * ============================================================================
 * pdf/index.ts —— Poppler（pdfinfo/pdftoppm）PDF 适配器
 * ============================================================================
 *
 * 【定位】通过 ExecutionPort 调用外部 Poppler 命令：pdfinfo 取页数，
 * pdftoppm 把指定页范围渲染成 JPEG（100 DPI）。
 *
 * 【进程与文件副作用】每次渲染创建独立临时目录，pdftoppm 输出 page-N.jpg，
 * 读取为字节后 finally 递归删除；临时目录创建/清理失败分类为 io_error。
 *
 * 【失败分类】cancelled / timeout / unavailable（未安装）/ password_protected /
 * page_out_of_range / corrupted / permission_denied / io_error / process_failed。
 * 分类只依据已知 Poppler stderr 模式，避免宽泛关键词误判。
 *
 * 【可用性缓存】unavailable 不缓存（用户装完应立即恢复）；探测超时也不缓存，
 * 因为"已启动但未及时响应"不等于缺少 Poppler。成功后才置 availabilityConfirmed。
 * ============================================================================
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PdfDocumentPortError,
  READ_PDF_AVAILABILITY_TIMEOUT_MS,
  READ_PDF_INFO_TIMEOUT_MS,
  READ_PDF_MAX_PAGES_PER_REQUEST,
  READ_PDF_RENDER_TIMEOUT_MS,
  type ExecutionPort,
  type ExecutionResult,
  type PdfDocumentPageCountRequest,
  type PdfDocumentPort,
  type PdfDocumentRenderPagesRequest,
  type PdfDocumentRenderedPage,
} from "@zcode/contracts";

export interface PopplerPdfDocumentAdapterOptions {
  executionPort: ExecutionPort;
  tempRoot?: string;
}

const BROKEN_PDF_STRUCTURE_PATTERN =
  /Syntax Error(?: \(\d+\))?: Couldn't (?:find trailer dictionary|read xref table)/iu;

/** 创建 Poppler PDF 适配器；executionPort 负责子进程，tempRoot 可覆盖临时目录父级。 */
export function createPopplerPdfDocumentAdapter(
  options: PopplerPdfDocumentAdapterOptions,
): PdfDocumentPort {
  return new PopplerPdfDocumentAdapter(options);
}

/**
 * PDF 文档端口实现。
 *
 * availabilityConfirmed 是进程级缓存：确认 pdftoppm 可用后跳过后续探测；
 * 失败/超时不置位，保证安装 Poppler 后无需重启即可恢复。
 */
class PopplerPdfDocumentAdapter implements PdfDocumentPort {
  private availabilityConfirmed = false;

  constructor(private readonly options: PopplerPdfDocumentAdapterOptions) {}

  /**
   * 用 pdfinfo 取页数。
   *
   * 返回 undefined 表示无法判定（命令失败/输出无 Pages 行/非法数字）；
   * 取消抛 cancelled。不触发 ensureAvailable（pdfinfo 与 pdftoppm 是两个包，
   * 仅在真正渲染前才要求 pdftoppm）。
   */
  async getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined> {
    const result = await this.options.executionPort.run(
      {
        command: { mode: "argv", file: "pdfinfo", args: [request.filePath] },
        timeoutMs: READ_PDF_INFO_TIMEOUT_MS,
        trace: request.trace,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (result.cancelled || options?.signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF inspection was cancelled.");
    }
    if (result.status !== "completed" || result.exitCode !== 0) return undefined;
    const match = /^Pages:\s+(\d+)\s*$/imu.exec(result.stdout.text);
    const pageCount = Number(match?.[1]);
    return Number.isSafeInteger(pageCount) && pageCount >= 0 ? pageCount : undefined;
  }

  /**
   * 渲染 [firstPage, lastPage] 为 JPEG。
   *
   * 前置 ensureAvailable；每次调用独立临时目录，成功或失败都在 finally 删除。
   * 返回按页码升序的 pageNumber/data/mediaType(image/jpeg)。
   * 取消在命令执行与文件读取阶段都会转成 cancelled；无输出页视为 corrupted。
   */
  async renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]> {
    await this.ensureAvailable(request, options?.signal);
    let directory: string;
    try {
      directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "zcode-read-pdf-"));
    } catch (error) {
      throwPdfIoError(
        error,
        options?.signal,
        "Unable to create a temporary directory for PDF page extraction.",
      );
    }
    const outputPrefix = join(directory, "page");
    let operationFailed = false;
    try {
      const result = await this.options.executionPort.run(
        {
          command: {
            mode: "argv",
            file: "pdftoppm",
            args: [
              "-jpeg",
              "-r",
              "100",
              "-f",
              String(request.firstPage),
              "-l",
              String(request.lastPage),
              request.filePath,
              outputPrefix,
            ],
          },
          timeoutMs: READ_PDF_RENDER_TIMEOUT_MS,
          trace: request.trace,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
      assertRenderSucceeded(result, request);
      return await readRenderedPages(directory, options?.signal);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        // 根因：清理错误覆盖主错误会丢失已经完成的 Poppler 稳定分类；仅当主流程
        // 成功时把清理失败暴露为 I/O 错误，失败路径继续保留原始原因。
        if (!operationFailed) {
          throwPdfIoError(error, options?.signal, "Unable to remove temporary PDF page images.");
        }
      }
    }
  }

  /**
   * 探测 pdftoppm 是否可用（进程内只成功缓存一次）。
   *
   * 取消→cancelled；命令超时→timeout（不等于未安装）；探测结果不可用→
   * unavailable 并附安装提示。见类头：失败的探测不写缓存。
   */
  private async ensureAvailable(
    request: PdfDocumentPageCountRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.availabilityConfirmed) return;
    const result = await this.options.executionPort.run(
      {
        command: { mode: "argv", file: "pdftoppm", args: ["-v"] },
        timeoutMs: READ_PDF_AVAILABILITY_TIMEOUT_MS,
        trace: request.trace,
      },
      signal ? { signal } : undefined,
    );
    if (result.cancelled || signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.");
    }
    if (result.timedOut || result.status === "timed_out") {
      // 根因：可用性探测超时表示命令已启动但未及时响应，不等于缺少 Poppler。
      throw new PdfDocumentPortError(
        "timeout",
        `PDF page extraction availability check timed out after ${READ_PDF_AVAILABILITY_TIMEOUT_MS}ms.`,
      );
    }
    if (!isAvailableProbeResult(result)) {
      throw new PdfDocumentPortError(
        "unavailable",
        "pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.",
        { cause: result.error?.cause },
      );
    }
    // 失败结果不能缓存；用户安装 Poppler 后同一进程应能立即恢复。
    this.availabilityConfirmed = true;
  }
}

/**
 * 将 pdftoppm 的执行结果映射为稳定的错误分类。
 *
 * 顺序：cancelled → timeout → exit0 成功 → password → 页范围（含 0 页=corrupted）
 * → I/O/权限（排除伴随 Command/Internal Error）→ damaged/corrupt 关键词 → 兜底
 * process_failed。detail 只拼接 stderr/stdout/error.message，且宽泛关键词只在
 * 明确 stderr 上使用，降低误判。
 */
function assertRenderSucceeded(
  result: ExecutionResult,
  request: PdfDocumentRenderPagesRequest,
): void {
  if (result.cancelled) {
    throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.");
  }
  if (result.timedOut || result.status === "timed_out") {
    throw new PdfDocumentPortError(
      "timeout",
      `PDF page extraction timed out after ${READ_PDF_RENDER_TIMEOUT_MS}ms.`,
    );
  }
  if (result.status === "completed" && result.exitCode === 0) return;

  const stderr = result.stderr.text;
  const detail = [stderr, result.stdout.text, result.error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  if (/password/iu.test(stderr)) {
    throw new PdfDocumentPortError(
      "password_protected",
      "PDF is password-protected. Please provide an unprotected version.",
    );
  }
  const pageRangeMatch = /Wrong page range given[\s\S]*last page \((\d+)\)/iu.exec(stderr);
  if (pageRangeMatch) {
    const documentPageCount = Number(pageRangeMatch[1]);
    if (documentPageCount === 0) {
      throw new PdfDocumentPortError(
        "corrupted",
        "PDF reports 0 pages (empty page tree). The PDF may be invalid.",
      );
    }
    if (Number.isSafeInteger(documentPageCount) && documentPageCount >= 1) {
      const requestedRange =
        request.firstPage === request.lastPage
          ? `page ${request.firstPage}`
          : `pages ${request.firstPage}-${request.lastPage}`;
      const exampleEnd = Math.min(documentPageCount, READ_PDF_MAX_PAGES_PER_REQUEST);
      throw new PdfDocumentPortError(
        "page_out_of_range",
        `Requested ${requestedRange} is outside the document (PDF has ${documentPageCount} page${documentPageCount === 1 ? "" : "s"}). Use a range within 1-${documentPageCount}, maximum ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request (e.g. pages: "1-${exampleEnd}").`,
      );
    }
  }
  const diagnosticLines = stderr.split("\n");
  const firstDiagnostic = diagnosticLines[0] ?? "";
  const hasCommandOrInternalError = diagnosticLines.some((line) =>
    /^(?:Command Line Error|Internal Error)(?: \(\d+\))?: /u.test(line),
  );
  const isInputIoError =
    firstDiagnostic.startsWith("I/O Error: ") && firstDiagnostic.includes(`'${request.filePath}'`);
  const isInputPermissionError = firstDiagnostic.startsWith("Permission Error: ");
  if ((isInputIoError || isInputPermissionError) && !hasCommandOrInternalError) {
    // 落入 process_failed，避免用宽泛关键词猜测错误类别。
    throw new PdfDocumentPortError(
      isInputPermissionError ? "permission_denied" : "io_error",
      `Could not render PDF: ${firstDiagnostic}`,
    );
  }
  // 根因：宽泛匹配 detail 会把文件名和无关诊断误判成密码、权限或损坏错误；
  // 这里只解析已知的 Poppler stderr，其余失败保留为 process_failed。
  if (/damaged|corrupt|invalid/iu.test(stderr) || BROKEN_PDF_STRUCTURE_PATTERN.test(stderr)) {
    throw new PdfDocumentPortError("corrupted", "PDF file is corrupted or invalid.");
  }
  throw new PdfDocumentPortError(
    "process_failed",
    detail.length > 0 ? `pdftoppm failed: ${detail}` : "pdftoppm failed.",
    { cause: result.error?.cause },
  );
}

/**
 * 列出并读取渲染出的 page-N.jpg。
 *
 * 非 page-N.jpg 命名一律忽略；按页码排序，零张输出视为 corrupted。
 * 读取阶段取消→cancelled，其余 IO 失败→io_error。
 */
async function readRenderedPages(
  directory: string,
  signal?: AbortSignal,
): Promise<PdfDocumentRenderedPage[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throwPdfIoError(error, signal, "Unable to list rendered PDF page images.");
  }
  const files = names
    .map((name) => ({ name, pageNumber: renderedPageNumber(name) }))
    .filter(
      (entry): entry is { name: string; pageNumber: number } => entry.pageNumber !== undefined,
    )
    .sort((left, right) => left.pageNumber - right.pageNumber);
  if (files.length === 0) {
    throw new PdfDocumentPortError(
      "corrupted",
      "pdftoppm produced no output pages. The PDF may be invalid.",
    );
  }
  try {
    return await Promise.all(
      files.map(async ({ name, pageNumber }) => ({
        data: new Uint8Array(
          await readFile(join(directory, name), signal === undefined ? undefined : { signal }),
        ),
        mediaType: "image/jpeg" as const,
        pageNumber,
      })),
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
        cause: error,
      });
    }
    throw new PdfDocumentPortError("io_error", "Unable to read rendered PDF page images.", {
      cause: error,
    });
  }
}

/**
 * 判定 `pdftoppm -v` 探测结果是否代表"可用"。
 *
 * pdftoppm -v 常以非 0 退出但仍打印版本到 stderr，因此接受：exit0，或
 * exit≠127 且有 stderr 文本（127=命令不存在）。其余视为未安装。
 */
function isAvailableProbeResult(result: ExecutionResult): boolean {
  if (result.status !== "completed" && result.status !== "failed") return false;
  return (
    result.exitCode === 0 ||
    (result.exitCode !== undefined && result.exitCode !== 127 && result.stderr.text.length > 0)
  );
}

/**
 * 文件系统类失败的统一包装：取消优先于 IO。
 *
 * signal 已中止说明失败很可能由取消引起，避免把取消误报成 io_error。
 */
function throwPdfIoError(error: unknown, signal: AbortSignal | undefined, message: string): never {
  if (signal?.aborted) {
    throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
      cause: error,
    });
  }
  throw new PdfDocumentPortError("io_error", message, { cause: error });
}

/** 从 `page-N.jpg` 提取页码；不匹配或非法数字返回 undefined（该文件被忽略）。 */
function renderedPageNumber(name: string): number | undefined {
  const match = /-(\d+)\.jpg$/iu.exec(name);
  const pageNumber = Number(match?.[1]);
  return Number.isSafeInteger(pageNumber) && pageNumber >= 1 ? pageNumber : undefined;
}
