// ============================================================
// PDF Document Port - PDF 页数探测与逐页渲染能力边界
// ============================================================
// core 的 Read PDF 分支不做 PDF 解析：native 路径只用 getPageCount 做页数门禁，
// pages 路径用 renderPages 把指定页渲染成图片再交给 ImageProcessorPort。
// 实现是子进程（Poppler），因此错误必须带稳定分类（超时/取消/损坏/加密等），
// 由调用方穷尽映射成 ReadErrorCode，禁止解析子进程输出文案。
// 端口不缓存文档；filePath 的权限/工作区约束由调用方在进入前完成。

import type { TraceContext } from "../tracing/tracer.js";

// 页数探测请求。filePath 必须是调用方已校验过的本地绝对路径；
// trace 在该端口是**必填**（不像多数端口可选），因为每次探测都可能拉起子进程，
// 必须无条件留下可关联的日志线索。
export interface PdfDocumentPageCountRequest {
  filePath: string;
  trace: TraceContext;
}

// 逐页渲染请求。firstPage/lastPage 是 1-indexed 的**闭区间**且必须是具体页号：
// 开放区间（lastPage=Infinity）在调用方被拒绝，因为可能一次渲染整份大文档。
export interface PdfDocumentRenderPagesRequest extends PdfDocumentPageCountRequest {
  firstPage: number;
  lastPage: number;
}

// 单页渲染产物。data 是 JPEG 原始字节（固定 image/jpeg，不做其他格式协商）；
// pageNumber 是 1-indexed 源页号，用于调用方按页排序与在投影结果里定位。
export interface PdfDocumentRenderedPage {
  data: Uint8Array;
  mediaType: "image/jpeg";
  pageNumber: number;
}

// 稳定错误分类。cancelled 是唯一不能折叠成业务错误的码：调用方必须先把它转成
// ToolCancelled，否则工具终态会被误判；其余各自对应一个 ReadErrorCode
// （corrupted→PDF_INVALID、io_error→PDF_IO_ERROR、page_out_of_range→…、
// password_protected→…、permission_denied→…、process_failed→…、timeout→…、
// unavailable→PDF_CONFIGURATION_ERROR）。新增码必须同步更新该穷尽映射。
export type PdfDocumentErrorCode =
  | "cancelled"
  | "corrupted"
  | "io_error"
  | "page_out_of_range"
  | "password_protected"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

// 端口错误。code 以构造参数形式直接挂到实例上，调用方按 code 分支；
// options 透传 ErrorOptions（cause），用于保留子进程失败根因但不改变分类。
export class PdfDocumentPortError extends Error {
  constructor(
    readonly code: PdfDocumentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfDocumentPortError";
  }
}

// PDF 文档端口。getPageCount 是可失败探测：返回 undefined 表示页数不可知
// （普通执行/解析失败），调用方应跳过页数门禁而不是当作 0 页；抛错才表示
// 取消/加密/损坏等需要归因的故障。renderPages 返回的页序由调用方负责排序，
// 端口不保证数组顺序，但必须保证每页自带正确 pageNumber。
// 两个方法都必须响应 options.signal，取消时应终止子进程而不是等待其自然结束。
export interface PdfDocumentPort {
  getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined>;
  renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]>;
}
