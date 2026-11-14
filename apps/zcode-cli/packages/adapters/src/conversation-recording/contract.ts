import type { Logger, SessionEvent } from "@zcode/contracts";

/*
 * ============================================================
 * conversation-recording / contract.ts —— 完整对话记录的对外契约
 *
 * 定位：定义“用户显式开启的原始记录模式”的数据形状与写入端口，是 adapters 与
 * bootstrap 之间的稳定边界；实现方只管落盘，不参与模型请求决策。
 *
 * 输入输出：provider_exchange 记录一次 HTTP 请求/响应（含原始 header/body）；
 * session event 记录会话事件流。二者都由调用方序列化后交给 recorder。
 *
 * 副作用：记录内容会写入用户指定目录，属于敏感数据（不脱敏、不裁剪）。
 *
 * 失败语义：端口实现不得抛错、不得阻塞或改变模型请求；写入失败只在实现内部记日志。
 *
 * 不变量：记录是旁路能力，任何记录失败都不能反噬 agent 主路径；close 之后不再保证
 * 新记录的落盘顺序。
 * ============================================================
 */

/**
 * 完整对话记录的对外契约。
 *
 * 这是用户显式开启的原始记录模式：header、请求体、响应体都不脱敏、不裁剪。
 * 输出目录因此必须按敏感数据处理，见 docs/design/v2/conversation-recording.md。
 */
export interface ConversationProviderExchangeRecord {
  /** 记录种类判别字段，恒为 provider_exchange。 */
  type: "provider_exchange";
  /** 发起请求的 ISO 时间戳，是排序与回放的起点。 */
  capturedAt: string;
  /** 请求结束（成功或失败）的 ISO 时间戳；异常中断时可能缺失。 */
  completedAt?: string;
  /** 从发起至结束的耗时，单位毫秒；用于分析延迟分布。 */
  durationMs?: number;
  /** 所属 session；无上下文时为 undefined，落盘归入 no-session 目录。 */
  sessionId?: string;
  /** 顶层任务链 id，跨 session/turn 关联同一用户任务。 */
  traceId?: string;
  /** 单轮对话 id，用于把请求归位到具体 turn。 */
  turnId?: string;
  /** provider 标识（如 openai、zai），回放时用于还原配置。 */
  providerId: string;
  /** 实际请求的模型 id。 */
  modelId: string;
  /** 请求快照：method/url/headers/body；body 可能因不可读而缺失。 */
  request: {
    /** 大写 HTTP 方法，无法识别时按 GET。 */
    method: string;
    /** 完整请求 URL。 */
    url: string;
    /** 实际发送的请求头（已合并 init 覆盖），可能包含凭据，故整体敏感。 */
    headers: Record<string, string>;
    /** 原始请求体文本；非文本或不可读时为 undefined。 */
    body?: string;
  };
  /** 响应快照；请求在拿到响应前就失败时整体缺失。 */
  response?: {
    /** HTTP 状态码。 */
    status: number;
    /** 响应头。 */
    headers: Record<string, string>;
    /** 原始响应体文本；读取失败或无 body 时为 undefined。 */
    body?: string;
  };
  /** 请求/响应阶段的异常；与 response 可能同时存在（body 读取失败）。 */
  error?: {
    /** 错误类型名，空串时省略。 */
    name?: string;
    /** 错误消息，必填。 */
    message: string;
    /** 堆栈；无堆栈时省略。 */
    stack?: string;
  };
}

/** 记录是旁路能力：实现不得抛错，也不得阻塞或改变模型请求。 */
export interface ConversationCapturePort {
  recordProviderExchange(record: ConversationProviderExchangeRecord): void;
}

/**
 * 按 session 落盘 capture.jsonl / events.jsonl 的写入端口。
 * 写入失败只在实现内部记录日志，不向调用方抛出。
 */
export interface ConversationRecorder extends ConversationCapturePort {
  /** 追加一条原始会话事件；事件顺序按调用顺序排队。 */
  recordSessionEvent(event: SessionEvent): void;
  /** 等待所有排队写入完成；关闭后不再保证新记录的落盘顺序。 */
  close(): Promise<void>;
}

export interface CreateConversationRecorderOptions {
  /** 可选 logger；写入失败时用于告警，避免静默丢记录。 */
  logger?: Logger;
  /** 记录根目录，内部再按 session 分目录写 capture.jsonl / events.jsonl。 */
  rootDir: string;
}
