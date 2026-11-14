import type {
  CreateFeedbackTicketInput,
  FeedbackAttachment,
  FeedbackAttachmentKind,
  FeedbackComment,
  FeedbackListQuery,
  FeedbackListResult,
  FeedbackTicketDetail,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type { Event } from "@zcode/rpc";
import { createServiceDescriptor } from "../descriptors.js";

// 上传进度按 progressId 独立成流：同一工单可并行多个附件，因此进度不能挂在工单对象上。
// uploadedBytes 单调递增；canceled 是终态，客户端收到后应停止等待并释放本地临时状态。
export interface FeedbackUploadProgress {
  id: string;
  phase: "preparing" | "uploading" | "complete" | "canceled";
  uploadedBytes: number;
  totalBytes: number;
}

// operationId 让创建具备幂等性：同一 operationId 的重试应复用结果，而不是新建工单。
// 缺省时由实现生成一次性标识，此时调用方需自行保证不重复提交。
export interface FeedbackCreateOptions {
  operationId?: string;
}

// 契约以「文本 + 附件」为主：所有上传接口返回附件元数据，不返回二进制内容。
// 取消类方法（cancelCreate、cancelUpload）是尽力而为，返回成功不代表远端一定已停止。
export interface IFeedbackService {
  // 创建是唯一会生成工单的操作；成功后返回完整详情，客户端据此直接替换本地临时条目。
  create(
    input: CreateFeedbackTicketInput,
    options?: FeedbackCreateOptions,
  ): Promise<FeedbackTicketDetail>;
  // 取消按 operationId 而非工单 id：创建尚未完成时可能还没有服务端 id。
  cancelCreate(operationId: string): Promise<void>;
  list(query?: FeedbackListQuery): Promise<FeedbackListResult>;
  get(id: string): Promise<FeedbackTicketDetail>;
  // 追加评论不回传整份详情，避免并发评论时互相覆盖；调用方按返回的评论自行拼接。
  comment(id: string, body: string): Promise<FeedbackComment>;
  uploadAttachment(
    id: string,
    kind: FeedbackAttachmentKind,
    file: { path: string; filename?: string; contentType?: string; messageId?: string },
  ): Promise<FeedbackAttachment>;
  // 带进度版本额外要求 progressId：进度事件通过 onDynamicUploadProgress 单独订阅。
  uploadAttachmentWithProgress(
    id: string,
    kind: FeedbackAttachmentKind,
    file: { path: string; filename?: string; contentType?: string; messageId?: string },
    progressId: string,
  ): Promise<FeedbackAttachment>;
  // 取消上传后已写入的部分由实现清理；调用方不应再复用该 progressId。
  cancelUpload(progressId: string): Promise<void>;
  // 事件绑定在工单 id 上，取消订阅即停止推送；未开始的进度流不会补发历史事件。
  onDynamicUploadProgress(id: string): Event<FeedbackUploadProgress>;
  // base64 入参用于无法访问本地路径的远端场景，代价是额外编解码开销，本地优先用路径版本。
  uploadAttachmentData(
    id: string,
    kind: FeedbackAttachmentKind,
    file: {
      dataBase64: string;
      filename: string;
      contentType: string;
      messageId?: string;
    },
  ): Promise<FeedbackAttachment>;
  // full 决定导出完整日志还是精简包；日志可能在导出瞬间仍在写入，实现需自行截断到一致点。
  attachLogsFromExport(id: string, options?: { full?: boolean }): Promise<FeedbackAttachment>;
  // 设备信息在调用时采集而非缓存，保证版本号与运行环境与当前进程一致。
  getDeviceSnapshot(): Promise<import("@zcode/shared").FeedbackDeviceInfo>;
  // 先生成归档再上传：调用方拿到路径后可自行上传或清理，避免服务端长时间持有临时文件。
  prepareCompactLogArchive(options?: { full?: boolean; progressId?: string }): Promise<{
    path: string;
    size: number;
  }>;
  // 清理必须显式调用：服务不记录已生成归档的生命周期，避免与调用方的删除时机竞争。
  cleanupPreparedLogArchive(path: string): Promise<void>;
  // 仅在桌面端有意义：把已生成的归档在文件管理器中定位，远端环境下应由实现忽略或降级。
  revealLogArchive(path: string): Promise<void>;
}

// 服务标识与 RPC 频道一一对应：本地直连与远程转发共用该 token，不能按传输方式分叉实现。
// 组装方只依赖此常量取服务，避免各处硬编码频道名。
export const IFeedbackService = createServiceDescriptor<IFeedbackService>(ServiceChannels.Feedback);
