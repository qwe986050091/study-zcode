// 话题资源契约：在可信 Host 渠道内回复消息、读取话题附件。
// 生产者是 bootstrap 的协议适配层（createProtocolTopicResourcePort），消费者是 core tool（发送/读取）。
// 身份（taskId/inputId/authorizationId/messageId）必须来自可信输入解析，模型不能自行指定或替换。
// 跨进程不变量：授权 id 在入队时由 Host 固定，历史资源读取不得借用后续重新授权版本。

import type { TraceContext } from "../tracing/tracer.js";

/** 仅用于当前任务已经接收的话题附件，身份由可信输入解析，不能由模型指定。 */
// 能力边界：reply 需要 Host 渠道的显式发送授权，read 需要入队时固定的授权 id；
// 两者都只处理「当前任务已接收」的资源，缺省时不允许 CLI 自行寻找其他机器人凭据。
export interface TopicResourcePort {
  /** 同一可信 Host 渠道的显式发送能力；缺省不允许 CLI 自行寻找其他机器人凭据。 */
  // 发送一条渠道回复；signal 负责取消/断连传播，trace 只用于协议侧关联，不含凭据。
  // 实现必须走统一请求入口（超时/鉴权/取消归一化），不允许 tool 直接访问网络。
  reply?(
    request: import("@zcode/shared").ChannelReplyRequest,
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<import("@zcode/shared").ChannelReplyResult>;
  // 读取当前任务某条话题消息里的第 resourceIndex 个附件：返回可引用的 ref 与元数据。
  // taskId/inputId 定位任务，authorizationId 固定入队时的授权版本，messageId 定位消息；
  // 满足条件的资源不存在时由协议层返回错误，不能回退到其他消息或重新授权。
  read(
    request: {
      // 当前任务身份；与 runtime 的 session/turn 关联，不允许模型伪造。
      taskId: string;
      // 产生该任务的可信输入 id；用于与入队时的资源清单对齐。
      inputId: string;
      // 入队时由 Host 注入的授权版本；历史请求不能借用后续重新授权的版本。
      authorizationId: string;
      // 话题内消息 id；资源索引只在消息内有效。
      messageId: string;
      // 该消息附件列表中的序号（从 0 开始）；越界由 Host 拒绝。
      resourceIndex: number;
    },
    context: { signal: AbortSignal; trace?: TraceContext },
  ): Promise<{ ref: string; fileName: string; mime: string; bytes: number }>;
}
