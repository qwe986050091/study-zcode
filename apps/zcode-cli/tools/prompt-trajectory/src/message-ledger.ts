/**
 * 文件职责：JSONL 消息账本，把请求体与消息逐条追加到同一文件。
 * 职责：管理文件句柄、分配递增 requestIndex、拆分写入 request/message 条目。
 * 输入：OpenAI Chat Completions 的 messages 或 Responses 的 input 数组。
 * 副作用：open 时创建/截断目标文件（"w"），进入后持续写盘；必须显式 close。
 * 失败语义：I/O 失败直接抛出不吞错；请求体缺 messages/input 或消息缺 role 时抛 Error，
 * 已写入的前序条目不回滚，读取端需容忍尾部不完整。
 * 不变量：requestIndex 从 1 开始单调递增；同一次请求内 messageIndex 从 0 连续递增。
 */

import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import type { JsonObject, OpenAiMessage, TrajectoryJsonlEntry } from "./types.js";

/**
 * 账本实例：持有已打开的文件句柄与下一个请求序号。
 * 不直接构造，统一通过 MessageLedger.open 获取，保证目录与文件状态一致。
 */
export class MessageLedger {
  /**
   * 内部构造：只保存句柄与请求计数，不做 I/O。
   * requestIndex 初值 0，表示尚未记录任何请求；首次写入时自增为 1。
   */
  private constructor(
    private readonly file: FileHandle,
    private requestIndex: number,
  ) {}

  /**
   * 打开（或截断重建）账本文件。
   * 输入：绝对或相对路径；不存在的父目录会递归创建。
   * 输出：已持有写句柄、请求计数归零的实例。
   * 副作用：mkdir 与 open("w")；若文件已存在会被清空，旧内容不保留。
   * 失败语义：目录创建或打开失败时错误原样上抛，调用方负责清理。
   */
  static async open(path: string): Promise<MessageLedger> {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, "w");
    return new MessageLedger(file, 0);
  }

  /**
   * 关闭底层文件句柄。
   * 幂等性：依赖 FileHandle.close，重复调用由运行时决定；调用后不应再 record。
   * 失败语义：关闭失败直接抛出，不吞错。
   */
  async close(): Promise<void> {
    await this.file.close();
  }

  /**
   * 记录一次请求：先写 request 骨架，再逐条写消息。
   * 输入：完整请求体（messages 或 Responses input），会被解构取出消息数组。
   * 输出：本次请求的 requestIndex（1 基），供后续 recordAssistantMessage 关联。
   * 副作用：立即追加 1+N 行 JSONL，N 为消息条数。
   * 失败语义：先自增序号再写盘；若后续校验失败会抛错且计数不回滚，
   * 一次失败的记录会留下空号，读取端不能假定序号连续。
   * 不变量：bodyWithoutMessages 不含 messages/input，消息只以 message 条目出现一次。
   */
  async recordRequestBody(body: JsonObject): Promise<number> {
    const messages = requestMessagesFromBody(body);
    if (!messages) {
      throw new Error("OpenAI request body must contain a messages or input array.");
    }

    // 先占用序号再写盘：失败时空号保留，避免同一序号对应两份不同请求。
    this.requestIndex += 1;
    const requestIndex = this.requestIndex;
    // 剥离 messages/input，避免同一份消息在 JSONL 中重复存储两遍。
    const { input: _input, messages: _messages, ...bodyWithoutMessages } = body;
    await this.write({
      kind: "request",
      requestIndex,
      bodyWithoutMessages,
    });

    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      // 缺 role 的消息无法参与重组，按损坏记录直接拒绝，而不是猜测默认角色。
      if (!isOpenAiMessage(message)) {
        throw new Error(`OpenAI request message ${messageIndex} is missing role.`);
      }
      await this.write({
        kind: "message",
        message,
        messageIndex,
        requestIndex,
      });
    }

    return requestIndex;
  }

  /**
   * 补录请求结束后拿到的 assistant 回复。
   * 输入：触发请求的 requestIndex 与回复消息；message 为 null 表示无回复，静默跳过。
   * 输出：无；仅追加一条不带 messageIndex 的 message 条目。
   * 副作用：写盘一行。
   * 失败语义：写失败抛出；null 属正常分支，不算失败。
   * 不变量：不校验 requestIndex 是否存在，调用方必须保证它来自 recordRequestBody。
   */
  async recordAssistantMessage(requestIndex: number, message: OpenAiMessage | null): Promise<void> {
    if (!message) return;
    await this.write({
      kind: "message",
      message,
      requestIndex,
    });
  }

  /**
   * 序列化单条条目并写入当前句柄。
   * 不变量：每行恰好一条 JSON，末尾补 "\n"，保证流式逐行读取可用。
   * 失败语义：循环引用导致序列化失败、或写盘失败时直接抛出。
   * 并发：未做串行保护，依赖调用方 await 顺序执行。
   */
  private async write(entry: TrajectoryJsonlEntry): Promise<void> {
    await this.file.write(`${JSON.stringify(entry)}\n`);
  }
}

/**
 * 从请求体提取消息数组。
 * 口径：优先 Chat Completions 的 messages；否则把 Responses 的 input 逐项归一化为消息。
 * 输出：消息数组；两者都不存在时返回 undefined，由调用方判定为非法请求。
 * 无副作用；input 项转换失败时返回空数组而非抛错。
 */
function requestMessagesFromBody(body: JsonObject): unknown[] | undefined {
  if (Array.isArray(body.messages)) return body.messages;
  if (!Array.isArray(body.input)) return undefined;

  return body.input.flatMap((item) => responseInputItemToMessage(item));
}

/**
 * 把 Responses 协议的 input 项归一化成 OpenAI 消息。
 * 口径：带 role 的项深拷贝后直接复用；function_call 转为 assistant+tool_calls；
 * function_call_output 转为 tool 消息并保留 call_id。
 * 输出：0 或 1 条消息的数组；未知类型返回空数组（忽略而不是报错）。
 * 副作用：对带 role 的项做 JSON 深拷贝，隔离后续修改；不修改入参。
 */
function responseInputItemToMessage(item: unknown): OpenAiMessage[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) return [];
  const record = item as Record<string, unknown>;
  if (typeof record.role === "string") {
    return [JSON.parse(JSON.stringify(record)) as OpenAiMessage];
  }
  // function_call/output 在 Responses 里没有 role，必须转成 Chat Completions 形状才能统一重组。
  if (record.type === "function_call") {
    return [
      {
        content: "",
        role: "assistant",
        tool_calls: [
          {
            id: typeof record.call_id === "string" ? record.call_id : undefined,
            type: "function",
            function: {
              arguments: typeof record.arguments === "string" ? record.arguments : "",
              name: typeof record.name === "string" ? record.name : "",
            },
          },
        ],
      },
    ];
  }
  if (record.type === "function_call_output") {
    return [
      {
        content: typeof record.output === "string" ? record.output : JSON.stringify(record.output),
        role: "tool",
        tool_call_id: typeof record.call_id === "string" ? record.call_id : undefined,
      },
    ];
  }
  return [];
}

/**
 * 运行时判定是否为可用消息。
 * 口径：非空普通对象且 role 为字符串；数组与 null 均拒绝。
 * 用途：写入前守卫，失败由调用方抛错；本函数不抛错。
 */
function isOpenAiMessage(value: unknown): value is OpenAiMessage {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as { role?: unknown }).role === "string",
  );
}
