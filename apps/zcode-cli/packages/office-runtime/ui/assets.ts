// 面板侧资源读取（经宿主 MCP 资源接口）：静态资源 readText/readBinary，文档字节 readFileBytes。
// 边界：本层不认识文件系统，只拼 ui:// 资源地址；资源名白名单由服务端路由负责。
// 失败语义：资源缺失或类型不符直接抛错，由调用方转成降级提示；分块缓存失败会清除以便重试。
import { ASSET_PREFIX, FILE_PREFIX, type FileHandle } from "#office/contract.ts";
import { getHost } from "#ui/host.ts";

// 通过宿主读取一个资源地址，等待 host 就绪后取第一个内容项。
// 资源不存在时抛错，调用方负责转成降级行为（字体缺失、文件读取失败等）。
async function read(uri: string) {
  const host = getHost();
  await host.ready();
  const result = await host.app.readServerResource({ uri });
  const item = result.contents[0];
  if (!item) throw new Error(`Empty resource ${uri}`);
  return item as { text?: string; blob?: string };
}

// 读取文本类静态资源（panel.html、css、json 等）；返回内容不是 text 时视为资源类型错误。
// name 是相对资源名，由调用方拼接前缀；每次调用都走宿主 RPC，不做缓存（文本通常很小）。
// 失败语义：资源不存在或类型不符直接抛错，由调用方转成可见降级提示。
export async function readText(name: string): Promise<string> {
  const item = await read(ASSET_PREFIX + name);
  if (typeof item.text !== "string") throw new Error(`Asset ${name} is not text`);
  return item.text;
}

// 把 base64 blob 解码为字节数组；返回类型显式带上 ArrayBuffer，便于直接交给 wasm / pdf.js。
function decode(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// 二进制资源缓存：按名称共享同一个 Promise，页面存续期间不重复下载。
const binaryCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

// 命中缓存时同步返回同一个 Promise 对象，调用方不得修改返回的字节（可能被其他组件复用）。
// 读取二进制资源（wasm、pdf.js cMaps 与字体）；加载失败会清除缓存，允许后续重试。
// 缓存键为完整资源名，同一名称的并发调用共享同一个 Promise；返回字节可被 FontFace/wasm 直接消费。
/** Binary asset (wasm, pdf.js cMaps and fonts); cached for the life of the page. */
export function readBinary(name: string): Promise<Uint8Array<ArrayBuffer>> {
  let cached = binaryCache.get(name);
  if (!cached) {
    cached = read(ASSET_PREFIX + name).then((item) => {
      if (typeof item.blob !== "string") throw new Error(`Asset ${name} is not binary`);
      return decode(item.blob);
    });
    cached.catch(() => binaryCache.delete(name));
    binaryCache.set(name, cached);
  }
  return cached;
}

// 按 handle 分块读取文档字节并拼成完整 ArrayBuffer；任一 chunk 非二进制即报错。
// signal 中止时抛 AbortError；读完 offset 与声明字节数不符说明文件已变化，需重新加载。
// 分块按 index 串行拉取，任何一块缺失/类型错误都会整体失败，不会返回半截文件。
/** Read a loaded document's bytes chunk by chunk. */
export async function readFileBytes(
  handle: FileHandle,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const out = new Uint8Array(handle.bytes);
  let offset = 0;
  for (let index = 0; index < handle.chunks; index++) {
    signal?.throwIfAborted();
    const item = await read(`${FILE_PREFIX}${handle.token}/${index}`);
    if (typeof item.blob !== "string") throw new Error("File chunk is not binary");
    const chunk = decode(item.blob);
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== handle.bytes) throw new Error("The file changed while it was loading; reload it.");
  return out.buffer;
}
