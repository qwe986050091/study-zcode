// 提示词附件的跨机搬运协议：本地 host 走零拷贝路径，远端 host 先暂存再由 runtime 消费。
// 边界：只声明 Renderer 可见的 stage/adopt/cancel/cleanup 契约，不暴露 SSH/WSL/Docker 后端细节。
// 不变量：operationId 全链路唯一，用于把进度事件、取消与清理精确关联到同一次搬运。
// 失败路径：stage 抛错时不会自动回收已暂存数据，调用方必须走 cancel/cleanup，否则占用远端磁盘。
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

// phase 单调前进：uploading → committing → complete；canceled 是唯一可从任意阶段进入的终态。
// 进度事件可能与取消交叉到达，消费方必须把 canceled 之后的事件全部丢弃，不能按到达顺序推断状态。
export type PromptAttachmentTransferPhase = "uploading" | "committing" | "complete" | "canceled";

export interface PromptAttachmentTransferProgress {
  operationId: string;
  phase: PromptAttachmentTransferPhase;
  uploadedBytes: number;
  totalBytes: number;
}

// workspaceIdentity 与 remoteSessionId 共同参与远端寻址；只传 workspacePath 在多工作区下会歧义。
// sizeBytes 允许缺失：长度未知时上传侧按流式处理，进度展示必须能降级为不定量。
export interface PromptAttachmentStageParams {
  operationId: string;
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  localPath: string;
  fileName: string;
  mime: string;
  sizeBytes?: number;
}

export interface PromptAttachmentStageResult {
  operationId: string;
  ref: string;
  bytes: number;
  staged: boolean;
}

/**
 * Renderer 只消费这个 host 服务，不直接依赖 SSH/WSL/Docker backend。
 * 本地 host 返回零拷贝路径，remote host wrapper 则先完成跨机暂存。
 */
export interface IPromptAttachmentTransferService {
  stage(params: PromptAttachmentStageParams): Promise<PromptAttachmentStageResult>;
  adopt(operationId: string): Promise<void>;
  cancel(operationId: string): Promise<void>;
  cleanup(operationId: string): Promise<void>;
  onDynamicProgress(operationId: string): Event<PromptAttachmentTransferProgress>;
}

export const IPromptAttachmentTransferService =
  createServiceDescriptor<IPromptAttachmentTransferService>(
    ServiceChannels.PromptAttachmentTransfer,
  );
