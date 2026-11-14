/**
 * 面板侧到服务端的 RPC 封装。
 *
 * 职责：把 office server 的 tool 调用统一成 Promise，并把服务端错误归一成 CallError，
 * 让调用方只需处理一种失败形态。
 * 输入输出：call 的 name/args 直接映射到 callServerTool；返回值取 structuredContent 并断言为 T。
 * 失败语义：isError 或 structuredContent.error 存在时抛 CallError（带 code）；网络/宿主异常原样抛出。
 * 缓存口径：listDocuments 结果在页面生命周期内复用，除非显式 fresh；失败时清空缓存以便重试。
 * 不变量：文件内容经分块上传，本层不持有绝对路径，只使用服务端返回的 path。
 */

import { FILE_CHUNK_BYTES, type DocKind } from "#office/contract.ts";
import { getHost } from "#ui/host.ts";

/** A failed server tool call; `code` is the server's OfficeErrorCode when it sent one. */
// 失败语义：code 由服务端 OfficeErrorCode 透传，调用方据此区分可恢复错误（如文件过大）与真正的故障；
// name 固定为 "CallError"，避免被上层误判成运行时异常。
// code 缺失表示宿主/传输层失败而非领域错误；message 可直接展示，但不要用于程序分支判断。
// 构造只保存信息，不隐式上报或重试；重试策略由调用方按 code 与场景决定。
export class CallError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CallError";
  }
}

/**
 * 调用服务端 tool 并返回结构化结果。
 *
 * 输入：name 为 tool 名，args 为参数对象（默认空对象，服务端按 schema 校验）。
 * 输出：structuredContent 断言为 T；调用方负责保证 T 与服务端产出契约一致。
 * 副作用：一次跨进程 RPC，依赖 host.ready() 完成握手后才发起。
 * 失败语义：isError 或 error 字段存在时抛 CallError，优先使用服务端 message/code，其次用 content 文本。
 */
export async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const host = getHost();
  await host.ready();
  const result = await host.app.callServerTool({ name, arguments: args });
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  const error = structured?.error as { message?: string; code?: string } | undefined;
  if (result.isError || error) {
    const text = (result.content?.[0] as { text?: string } | undefined)?.text;
    throw new CallError(error?.message ?? text ?? `${name} failed`, error?.code);
  }
  return structured as T;
}

/**
 * 工作区内一份可打开文档的元信息。
 * path 为服务端返回的相对路径（UI 不拼接绝对路径）；kind 决定选用哪个查看器；
 * bytes 用于展示与大小校验；mtimeMs 缺省表示服务端未提供时间，排序时按 0 处理。
 */
export interface WorkspaceFile {
  path: string;
  kind: DocKind;
  bytes: number;
  mtimeMs?: number;
}

let listing: Promise<WorkspaceFile[]> | undefined;
// 列出工作区内本插件可打开的文档，服务端按修改时间倒序返回；fresh=true 强制重新请求。
// 页面内缓存 Promise（失败时清空缓存以便下次重试），调用方共享同一结果，不应原地修改数组。
// 返回的是元信息列表，不含文件字节；路径均为工作区相对 POSIX 路径。
/** Workspace documents, newest first. Cached for the page's lifetime unless `fresh`. */
export function listDocuments(fresh = false): Promise<WorkspaceFile[]> {
  if (fresh || !listing)
    listing = call<{ documents: WorkspaceFile[] }>("list_documents").then(
      (result) => [...result.documents].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)),
      (error) => {
        listing = undefined;
        throw error;
      },
    );
  return listing;
}

// 纯字符串切分的展示辅助：不解析真实文件系统，因此对 Windows 反斜杠路径不适用
// （服务端统一输出 POSIX 风格路径，这里以 "/" 为唯一分隔符）。
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
// 返回父目录；根目录的上级返回空串而不是 "/"，便于调用方直接按「无父目录」判断。
export const dirName = (path: string) => {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
};

// 通过系统选择器授权的 File 分块导入，桌面与 Web 都不需要暴露本机绝对路径。
// 输入为浏览器 File；输出为服务端落盘后的工作区相对路径，可直接用于打开文档。
// 分块串行上传并校验返回的 token/offset；中途失败会尽力 abort，避免残留导入槽。
/** 通过系统选择器授权的 File 分块导入，桌面与 Web 都不需要暴露本机绝对路径。 */
export async function importSelectedFile(file: File): Promise<string> {
  const { id } = await call<{ id: string }>("begin_file_import", {
    name: file.name,
    size: file.size,
  });
  try {
    for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]!);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file.slice(offset, offset + FILE_CHUNK_BYTES));
      });
      await call("write_file_import", { id, offset, data });
    }
    const result = await call<{ path: string }>("finish_file_import", { id });
    return result.path;
  } catch (error) {
    await call("cancel_file_import", { id }).catch(() => undefined);
    throw error;
  }
}
