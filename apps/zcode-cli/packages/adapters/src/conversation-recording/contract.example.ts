/*
 * ============================================================
 * conversation-recording / contract.example.ts —— 标准调用示例
 *
 * 定位：给 agent 模仿用的最小样例，演示如何构造一条 provider_exchange 记录；
 * 不是生产实现，也不参与运行链路。
 * 输入输出：接收 ConversationCapturePort，调用一次 recordProviderExchange 后返回 void。
 * 副作用：仅把示例记录交给端口；示例值不含真实凭据。
 * 失败语义：不捕获异常，完全沿用端口的契约（端口实现本身不应抛错）。
 * ============================================================
 */
/**
 * conversation-recording 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ConversationCapturePort } from "./contract.js";

/** 构造并提交一条假数据的 provider_exchange，演示必填字段与可选字段的组合方式。 */
export function exampleConversationRecording(capture: ConversationCapturePort): void {
  capture.recordProviderExchange({
    capturedAt: new Date().toISOString(),
    modelId: "gpt-example",
    providerId: "openai",
    request: {
      body: '{"messages":[]}',
      headers: { authorization: "Bearer example" },
      method: "POST",
      url: "https://api.example.com/v1/responses",
    },
    response: { headers: { "content-type": "application/json" }, status: 200 },
    sessionId: "sess_example",
    type: "provider_exchange",
  });
}
