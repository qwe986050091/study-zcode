// 会话间消息投递协议：发送方只声明“请求”，不等待对端确认，避免跨会话调用互相阻塞。
// requestId 是幂等键；重放同一条请求必须沿用，接收方据此去重。
export interface SessionMessageSendRequested {
  content: string;
  createdAt: string;
// 发送方会话 ID 由调用方注入，接收方据此决定是否信任该来源。
  fromSessionId: string;
  messageId: string;
  requestId: string;
// 目标会话 ID 决定投递路由；找不到目标时按失败结果回报而不是抛出。
  toSessionId: string;
}

// 投递结果分别携带 messageId 与 requestId；failed 必须带 error 说明，便于发送方决定是否重试。
export interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}
