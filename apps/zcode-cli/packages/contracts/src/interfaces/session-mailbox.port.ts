// 会话信箱契约：跨 session 异步消息的投递。生产者是其它 session/协调者写入的信封，
// 消费者是目标 session 的 hook（UserPromptSubmit/PostToolUse/Stop）与运行时排队入口。
// CLI core 只消费已解析的结构化信封，不直接触碰文件/网络；drain 的原子移动与排序由 adapter 保证。
// 跨进程不变量：一条信封只能被成功投递一次（unread→read 的移动必须先完成再返回）。

import type { SessionId } from "./shared.js";

// 投递到目标 session 的一封信。字段集合即落盘/传输格式，version 不匹配必须整封拒绝，
// 不能按缺省值补齐，否则会把格式错误的信封伪装成合法消息注入模型上下文。
export interface SessionMailboxEnvelope {
  // 信封格式版本，当前仅支持 1；升级语义变化时要同步所有读写端。
  version: 1;
  // 信封身份，供收件侧去重与审计；不保证全局唯一时可与 fromSessionId 组合使用。
  messageId: string;
  // 发送方 session；仅用于溯源，不参与权限判定。
  fromSessionId: SessionId;
  // 收件方 session；adapter 必须校验该值与目录身份一致，防止跨会话越权读取。
  toSessionId: SessionId;
  // 消息正文；已是可信输入解析后的纯文本，消费端不得把它当命令重新解析。
  content: string;
  // ISO 时间串；用于展示与排序，写入后不可变。
  createdAt: string;
}

// drain 的消费边界：返回的信封已经在 adapter 内从 unread 原子移动到 read，
// core 拿到即视为「已投递」，重复调用不会再次返回同一封信。
export interface SessionMailboxPort {
  // 读取并消费目标 session 的未读消息：按文件名排序取前 limit 条（缺省 20），
  // 返回前逐条完成 unread→read 的原子移动；signal 中途取消时已返回的部分仍算已投递。
  // 实现必须拒绝越出信箱根目录的 session id，并在并发 drain 下保证同一封信不重复交付。
  drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]>;
}
