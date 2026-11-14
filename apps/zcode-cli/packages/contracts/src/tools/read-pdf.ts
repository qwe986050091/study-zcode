// ============================================================
// Read PDF Contract
// ============================================================
// 本文件只声明 PDF 读取的常量、错误码与页码范围解析，不执行读取或渲染。读取分两路：
//   1) native：整份 PDF 以 base64 交给支持 PDF 输入的模型（20MB 上限、10 页门禁）；
//   2) pages：按页范围本地渲染成图片（100MB 上限、每请求最多 20 页）。
// 页码口径：全部为 **1-indexed**；"3-" 这种开放区间解析为 firstPage=3、lastPage=Infinity，
// 页数按 21 计（MAX_PAGES_PER_REQUEST+1），从而落到"范围过大"而不是"非法格式"。
// 边界：pages 只对 .pdf 后缀生效；非 PDF 路径不会被 pages 校验拦下，交给 Read 的其他分支。
// 错误码 7/8 是入参校验（非法/超限），10-20 由 core handler 从 PdfDocumentPortError 穷尽映射。

// native 路径（整份 base64）的输入字节上限。超过即 PDF_TOO_LARGE，不降级为 pages。
export const READ_PDF_NATIVE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
// pages 路径（本地渲染）的输入字节上限，比 native 宽松：渲染不需要把整份文档塞进请求。
export const READ_PDF_EXTRACT_MAX_INPUT_BYTES = 100 * 1024 * 1024;
// native 路径的页数门禁：超过 10 页的 PDF 必须显式给 pages，避免整份大文档一次性进上下文。
export const READ_PDF_NATIVE_MAX_PAGES = 10;
// 单次 pages 请求的页数上限；也是 READ_PDF_PAGES_DESCRIPTION 文案里写死的那个 20。
export const READ_PDF_MAX_PAGES_PER_REQUEST = 20;
// 读取 PDF 元信息（页数等）的超时；短超时因为这一步只读结构，不渲染。
export const READ_PDF_INFO_TIMEOUT_MS = 10_000;
// 探测渲染能力/可用性的超时；比 info 更短，失败应尽快降级。
export const READ_PDF_AVAILABILITY_TIMEOUT_MS = 5_000;
// 整页渲染的超时；core handler 在其基础上再加 30s 作为工具外层预算，两者刻意分开。
export const READ_PDF_RENDER_TIMEOUT_MS = 120_000;
// 暴露给模型的 pages 参数说明；文案与 READ_PDF_MAX_PAGES_PER_REQUEST 硬绑定，改动上限必须同步。
export const READ_PDF_PAGES_DESCRIPTION =
  'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.';

// PDF 读取的稳定错误码表和模型侧错误分类。数字是跨进程/跨版本的协议值，不能重排或复用：
// 7/8 来自入参校验（本文件），10-20 来自 core handler 对 PdfDocumentPortError 的穷尽映射。
// 注意：取消（cancelled）刻意没有对应码，它必须先转成 CoreErrorType.ToolCancelled，
// 否则 executor 会把"被取消"记成一次业务失败。
export const ReadErrorCode = {
  // pages 字符串不符合 "N" / "N-M" / "N-" 格式。
  PDF_INVALID_PAGES: 7,
  // 页码范围超过单请求 20 页上限（含开放区间按 21 页计）。
  PDF_PAGE_RANGE_TOO_LARGE: 8,
  // pages 分支需要图片输入，但模型明确声明不支持图片。
  PDF_PAGES_IMAGES_UNSUPPORTED: 10,
  // pages 分支缺 PdfDocumentPort/ImageProcessorPort 等必需端口（接线故障）。
  PDF_CONFIGURATION_ERROR: 11,
  // PDF 文件损坏/结构非法。
  PDF_INVALID: 12,
  // 输入字节数超过对应路径上限。
  PDF_TOO_LARGE: 13,
  // native 路径页数超过 READ_PDF_NATIVE_MAX_PAGES 且未给 pages。
  PDF_TOO_MANY_PAGES: 14,
  // 渲染/读取在超时预算内未完成。
  PDF_TIMEOUT: 15,
  // PDF 有密码保护，无法在无人值守下解锁。
  PDF_PASSWORD_PROTECTED: 16,
  // 请求页码超出文档实际页数。
  PDF_PAGE_OUT_OF_RANGE: 17,
  // 文件系统/宿主权限不足。
  PDF_PERMISSION_DENIED: 18,
  // 底层 I/O 失败。
  PDF_IO_ERROR: 19,
  // PDF 子进程（如 Poppler）执行失败。
  PDF_PROCESS_FAILED: 20,
} as const;

// 错误码联合类型；core handler 用穷尽映射保证没有遗漏任何 PdfDocumentPortError。
export type ReadErrorCode = (typeof ReadErrorCode)[keyof typeof ReadErrorCode];

// 解析后的页码范围：两端都是 1-indexed 闭区间。lastPage 可能是 Number.POSITIVE_INFINITY，
// 表示 "N-" 这种开放到文档末尾的写法；调用方必须先判 Infinity 再算页数。
export interface ReadPdfPageRange {
  // 起始页，1 起。
  firstPage: number;
  // 结束页，含；Infinity 表示开放到文档末尾。
  lastPage: number;
}

// pages 入参校验的失败结果，只可能是 7/8 两种码（其余 PDF 错误发生在真正读取之后）。
// 返回它而不是抛错，因为校验发生在 schema superRefine 与 handler 前段，需要转成结构化结果。
export interface ReadPdfPagesValidationFailure {
  // 失败类别：7=格式非法，8=范围超限。
  errorCode: typeof ReadErrorCode.PDF_INVALID_PAGES | typeof ReadErrorCode.PDF_PAGE_RANGE_TOO_LARGE;
  // 面向模型/用户的说明，包含合法格式与 1-indexed 事实。
  message: string;
}

// 把模型传的 pages 字符串解析成 1-indexed 闭区间。接受三种写法："3"、"1-5"、"3-"。
// 返回 undefined 表示格式非法或边界不成立（0 起、末页小于起始页、溢出安全整数），调用方
// 统一映射成 PDF_INVALID_PAGES。纯函数、不抛异常；"3-" 的 lastPage 是 Infinity 而不是某个月
// 实际页数，因为此刻还没打开文档，开放区间要靠后续页数校验决定是否超限。
export function parseReadPdfPageRange(value: string): ReadPdfPageRange | undefined {
  const normalized = value.trim();
  // 先单独处理 "N-"：它要求 lastPage=Infinity，不能让通用正则把它当成缺少结束页而拒绝。
  if (/^\d+-$/u.test(normalized)) {
    const firstPage = Number(normalized.slice(0, -1));
    return Number.isSafeInteger(firstPage) && firstPage >= 1
      ? { firstPage, lastPage: Number.POSITIVE_INFINITY }
      : undefined;
  }
  const match = /^(\d+)(?:-(\d+))?$/u.exec(normalized);
  if (!match) return undefined;
  const firstPage = Number(match[1]);
  const lastPage = Number(match[2] ?? match[1]);
  if (
    !Number.isSafeInteger(firstPage) ||
    !Number.isSafeInteger(lastPage) ||
    firstPage < 1 ||
    lastPage < firstPage
  ) {
    return undefined;
  }
  return { firstPage, lastPage };
}

// 计算请求页数。开放区间（lastPage=Infinity）直接返回上限+1=21，而不是真实页数：此刻还没
// 打开文档，返回一个"必然超限"的哨兵值，让校验稳定落到 PDF_PAGE_RANGE_TOO_LARGE，而不是
// 依赖文档页数才能判定。
function readPdfPageCount(range: ReadPdfPageRange): number {
  return range.lastPage === Number.POSITIVE_INFINITY
    ? READ_PDF_MAX_PAGES_PER_REQUEST + 1
    : range.lastPage - range.firstPage + 1;
}

// pages 入参的提前校验：只对 .pdf 后缀生效（其他文件即使带 pages 也交给 Read 其他分支），
// 且 pages 未提供时直接通过。返回结构化失败而非抛错，供 Read 的 superRefine 与 handler
// 复用同一套文案与错误码；这里只判格式与页数上限，不打开文件、不校验页码是否越界。
export function getReadPdfPagesValidationFailure(
  filePath: string,
  pages: string | undefined,
): ReadPdfPagesValidationFailure | undefined {
  if (pages === undefined || !filePath.toLowerCase().endsWith(".pdf")) return undefined;

  const range = parseReadPdfPageRange(pages);
  if (!range) {
    return {
      errorCode: ReadErrorCode.PDF_INVALID_PAGES,
      message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
    };
  }
  if (readPdfPageCount(range) > READ_PDF_MAX_PAGES_PER_REQUEST) {
    return {
      errorCode: ReadErrorCode.PDF_PAGE_RANGE_TOO_LARGE,
      message: `Page range "${pages}" exceeds maximum of ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request. Please use a smaller range.`,
    };
  }
  return undefined;
}
