// 远端 prompt 附件的「暂存传输」服务：把 Host 本地附件上传到远端私有目录，并向 renderer
// 暴露可取消、可观察进度的 stage 接口。
//
// 职责边界：
// - 只负责把本地路径上传并改写为远端路径，不决定会话归属，也不持久化到任何业务表；
// - 每个 operationId 在服务内至多有一个 owner record，重试即替换并回收旧 record；
// - attachment 的清理（cancel/cleanup/dispose）必须先让旧 operation 失效，再尝试删远端文件。
//
// 失败语义：
// - 上传成功但 chmod/落盘阶段失败时，会在抛错前尽力删除远端文件（见 remotePromptAttachments）；
// - 断网导致 cleanup 失败时不重建远端连接，交给 Host 重建后的 janitor 按时间回收；
// - 已 dispose 后任何 stage 直接拒绝，保证窗口关闭后不会再有新上传。
//
// 大纲不变量 #18 相关（seq/dispose 语义）：
// - operationId 是「一次暂存操作」的序号键：同 id 重试会让旧 record 失效，旧的回调无法再写
//   record.ref，从而不会误删后来者创建的文件；
// - dispose 幂等，且会等待所有 pending cleanup 结算（allSettled），不因单个坏连接阻塞退出。

import { Emitter } from "@zcode/rpc";
import type { IRemoteBackend } from "@zcode/server/remote";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
  PromptAttachmentTransferProgress,
} from "@zcode/services";
import type { ZCodePromptAttachment } from "@zcode/shared";
import {
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";

/** 单次 stage 的内部控制记录：controller 负责取消，ref 是远端已落盘路径，bytes 用于进度回放。 */
interface TransferRecord {
  controller: AbortController;
  ref?: string;
  bytes: number;
}

/** 附件归属范围：三者必须同时匹配，防止 A 会话的 operationId 被 B 会话复用。 */
type AttachmentScope = Pick<
  PromptAttachmentStageParams,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId"
>;

/** 对外服务类型在标准接口上追加 dispose：attachment 关闭时必须可主动释放暂存资源。 */
export type RemotePromptAttachmentTransferService = IPromptAttachmentTransferService & {
  dispose(): Promise<void>;
};

// 统一的取消错误：name=AbortError 让上层按「用户/生命周期取消」处理，而不是普通失败。
function canceled(): Error {
  return Object.assign(new Error("Remote attachment transfer canceled"), { name: "AbortError" });
}

// 创建远端附件暂存服务的说明：
// 输入：backend 只需 exec/upload 两项能力；options.scope 限定该 attachment 只能服务固定工作区，
//   onJanitorError 用于把后台清扫失败上报给上层（不影响主流程）。
// 输出：stage/adopt/cancel/cleanup/onDynamicProgress/dispose 的标准接口实现。
// 副作用：构造时即异步触发一次过期暂存清扫；stage 会向远端上传文件并改写附件路径。
// 失败语义：scope 不匹配、已 dispose、上传失败均抛错；取消路径统一抛 AbortError。
// 维护的不变量：records 中「当前 operationId 对应记录」是唯一 owner，跨 await 的旧流程
//   必须重新校验 isCurrent 才允许发出进度/返回结果（#18 的序号语义）。
/** 只有 owning attachment 持有暂存记录；Source 业务服务与登录态保持远端权威。 */
export function createRemotePromptAttachmentTransferService(
  backend: Pick<IRemoteBackend, "exec" | "upload">,
  options: { scope?: AttachmentScope; onJanitorError?: (error: unknown) => void } = {},
): RemotePromptAttachmentTransferService {
  const records = new Map<string, TransferRecord>();
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();
  let disposed = false;

  void cleanupStaleRemotePromptAttachments(backend).catch((error) => {
    options.onJanitorError?.(error);
  });

  // 每个 operationId 一个进度 emitter，最后一个监听者移除即销毁，避免长会话累积。
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

  // 回收单条 record：先删账本（使旧流程 isCurrent 失效），再 abort，最后尽力删远端文件。
  const cleanupRecord = async (operationId: string, record: TransferRecord) => {
    // 先使旧操作失效；跨 await 的旧 cleanup 不能删除重试创建的新 record。
    if (records.get(operationId) === record) records.delete(operationId);
    record.controller.abort();
    if (record.ref) await cleanupRemotePromptAttachment(backend, record.ref);
  };
  // 取消入口：先广播 canceled 进度，再走统一的 record 回收；无记录时静默成功。
  const cleanup = async (operationId: string) => {
    const record = records.get(operationId);
    if (record) {
      emitters
        .get(operationId)
        ?.fire({ operationId, phase: "canceled", uploadedBytes: 0, totalBytes: record.bytes });
      await cleanupRecord(operationId, record);
    }
  };

  return {
    // 暂存一次附件：写入 owner record -> 上传并改写路径 -> 发 committing/complete。
    // 任何阶段被取消或被新的同 operationId 覆盖，都会走 catch 清理并抛 AbortError。
    async stage(params): Promise<PromptAttachmentStageResult> {
      if (disposed) throw new Error("Remote attachment transfer is disposed");
      if (
        options.scope &&
        (params.workspacePath !== options.scope.workspacePath ||
          params.workspaceIdentity !== options.scope.workspaceIdentity ||
          params.remoteSessionId !== options.scope.remoteSessionId)
      ) {
        throw new Error("Remote attachment scope mismatch");
      }
      const previous = records.get(params.operationId);
      const record: TransferRecord = {
        controller: new AbortController(),
        bytes: Math.max(0, params.sizeBytes ?? 0),
      };
      // 同 operationId admission 必须在第一个 await 前完成，避免两次 stage 同时成为 owner。
      records.set(params.operationId, record);
      const isCurrent = () =>
        !disposed &&
        !record.controller.signal.aborted &&
        records.get(params.operationId) === record;
      const emitter = getEmitter(params.operationId);
      let lastPercent = -1;
      let lastEmittedAt = 0;
      let lastUploadedBytes = 0;
      try {
        if (previous) await cleanupRecord(params.operationId, previous);
        if (!isCurrent()) throw canceled();
        const attachment: ZCodePromptAttachment = {
          kind: params.mime.startsWith("image/") ? "image" : "file",
          filename: params.fileName,
          localPath: params.localPath,
          mimeType: params.mime,
          sizeBytes: params.sizeBytes ?? 0,
        } as ZCodePromptAttachment;
        const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
        const materialized = await materializeRemotePromptAttachments(
          {
            taskId: params.sessionId,
            traceId: `${workspaceKey}\u0000${params.remoteSessionId ?? ""}\u0000${params.operationId}`,
            content: "",
            attachments: [attachment],
          },
          {
            backend,
            uploadOptions: {
              signal: record.controller.signal,
              onProgress(progress) {
                if (!isCurrent()) return;
                const totalBytes = Math.max(progress.totalBytes, record.bytes);
                record.bytes = totalBytes;
                lastUploadedBytes = Math.max(lastUploadedBytes, progress.uploadedBytes);
                const percent =
                  totalBytes > 0 ? Math.floor((lastUploadedBytes / totalBytes) * 100) : 0;
                const now = Date.now();
                if (percent <= lastPercent && now - lastEmittedAt < 100) return;
                lastPercent = Math.max(lastPercent, percent);
                lastEmittedAt = now;
                emitter.fire({
                  operationId: params.operationId,
                  phase: "uploading",
                  uploadedBytes: lastUploadedBytes,
                  totalBytes,
                });
              },
            },
          },
        );
        const ref = materialized.attachments?.[0]?.localPath?.trim();
        if (!ref) throw new Error("Remote attachment staging returned no path");
        record.ref = ref;
        // 上传忽略 abort 或 chmod 晚完成时也须清理；旧实现只抛错，漏掉已经上传的文件。
        if (!isCurrent()) throw canceled();
        for (const phase of ["committing", "complete"] as const) {
          if (!isCurrent()) throw canceled();
          emitter.fire({
            operationId: params.operationId,
            phase,
            uploadedBytes: record.bytes,
            totalBytes: record.bytes,
          });
        }
        return { operationId: params.operationId, ref, bytes: record.bytes, staged: true };
      } catch (error) {
        const aborted = record.controller.signal.aborted;
        if (aborted && records.get(params.operationId) === record) {
          emitter.fire({
            operationId: params.operationId,
            phase: "canceled",
            uploadedBytes: 0,
            totalBytes: record.bytes,
          });
        }
        await cleanupRecord(params.operationId, record).catch(() => {});
        if (aborted) throw canceled();
        throw error;
      }
    },
    // renderer 已接管引用后调用：仅把账本条目移交给调用方，不再由本服务负责删除。
    async adopt(operationId) {
      if (records.get(operationId)?.ref) records.delete(operationId);
    },
    // cancel 与 cleanup 语义一致（都回收并删远端文件），保留两个名字以兼容接口两侧调用方。
    cancel: cleanup,
    cleanup,
    // 动态进度订阅：同一 operationId 的多次订阅共享同一个 emitter 生命周期。
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
    // 幂等关闭：标记 disposed 后并发结算全部 pending cleanup，最后销毁所有 emitter。
    async dispose() {
      if (disposed) return;
      disposed = true;
      const pending = [...records].map(([id, record]) => cleanupRecord(id, record));
      for (const emitter of emitters.values()) emitter.dispose();
      emitters.clear();
      // 断网无法 cleanup 时保留既有 janitor 回收；不能为了删除暂存而重建远端连接。
      await Promise.allSettled(pending);
    },
  };
}
