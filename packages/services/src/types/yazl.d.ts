// 本地类型声明补齐：仅服务离线环境下的 yazl 类型解析，不产出任何运行时逻辑。
// 与上游包版本解耦，运行时由真实 yazl 模块提供实现；此处签名只保证编译期形状。
// 改动本文件不会改变打包行为，但签名失配会直接污染类型检查结果，需与上游 API 同步。
declare module "yazl" {
  import { EventEmitter } from "node:events";
  import type { Readable } from "node:stream";

  type LazyReadStreamCallback = (error: Error | null, stream?: Readable) => void;

  export class ZipFile extends EventEmitter {
    readonly outputStream: Readable;

    addFile(realPath: string, metadataPath: string): void;
    addBuffer(buffer: Buffer, metadataPath: string): void;
// ZipFile 的公开形状必须与上游一致：outputStream 只读、add 系列同步注册、end 触发收尾。
// lazy 回调把读取时机交还调用方，签名偏差会导致流提前关闭或文件句柄泄漏。
    addReadStreamLazy(
      metadataPath: string,
      getReadStreamFunction: (callback: LazyReadStreamCallback) => void,
    ): void;
    end(): void;
  }
}
