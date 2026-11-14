// 本地 workspace 的附件传输实现：不真正上传，只把 localPath 原样作为引用返回。
// INV：staged 恒为 false，进度事件不伪造，UI 不能对本地文件展示上传进度。
// 操作事件按 operationId 分桶，最后一个监听者移除时自动销毁，避免 Map 无限增长。
// 远端上传实现在其他模块，本文件只覆盖本地零拷贝路径。
import { stat } from "node:fs/promises";
import { Emitter } from "@zcode/rpc";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentTransferProgress,
} from "./promptAttachmentTransfer.js";

/** 本地 workspace 保持 localPath 零拷贝，不伪造上传进度。 */
// 工厂函数：每次调用产生独立的 emitter 表，互不干扰。
// 返回对象满足完整接口，远端相关方法退化为空实现。
export function createLocalPromptAttachmentTransferService(): IPromptAttachmentTransferService {
// operationId 到 Emitter 的映射；按操作隔离进度事件，避免不同附件串台。
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();
// 惰性创建：没有订阅者时不分配 emitter；同一 operationId 复用同一个实例。
  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };

  return {
// 实例方法；stage 只读一次文件大小，adopt/cancel/cleanup 在本地无副作用。
// sizeBytes 优先采用调用方给的值；缺失或非正数时才 stat 本地文件。
// stat 失败按 0 处理而不是抛错：大小只用于展示，不应阻断发送。
    async stage(params) {
      const bytes =
        typeof params.sizeBytes === "number" && params.sizeBytes > 0
          ? params.sizeBytes
          : await stat(params.localPath)
              .then((value) => value.size)
              .catch(() => 0);
      return {
        operationId: params.operationId,
        ref: params.localPath,
        bytes,
        staged: false,
      };
    },
// 本地路径无需认领，保持空实现以满足契约。
    async adopt() {},
    async cancel() {},
    async cleanup() {},
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
  };
}
