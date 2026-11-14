import { z } from "zod";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import type {
  MessageWithParts,
  ReadSessionContextInput,
  ReadSessionContextOutput,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";

// topic 授权的运行时 schema：只校验读取附件所需的准入字段，不覆盖业务语义。
// 解析失败即视为"没有可用授权"；除两个可选快照外，所有字段均为必填非空字符串。
const identitySchema = z.object({
  // 触发本轮输入的命令 id，也是 attachment.inputId 的比对源；用于把附件绑定到具体一轮输入。
  sourceCommandId: z.string().min(1),
  // 机器人群聊来源：授权 id 与资源定位都从这里取，缺任一项都无法读取附件。
  botGroupSource: z.object({
    // 机器人自身 id，仅用于来源归属校验。
    botId: z.string().min(1),
    // 群聊 id，与 threadId 一起构成话题定位。
    chatId: z.string().min(1),
    // 话题（thread）id；附件资源按话题维度存储。
    threadId: z.string().min(1),
    // 授权 id：调用 topicResourcePort.read 时透传，决定可访问的资源范围。
    authorizationId: z.string().min(1),
    // 旧版快照：按消息记录资源条数（正整数 count 即该消息可用的资源索引上界）。
    topicHistory: z
      .object({
        resourceMessages: z.array(
          z.object({ messageId: z.string(), count: z.number().int().positive() }),
        ),
      })
      .optional(),
    // 新版快照：按消息携带 attachments 数组，数组长度即该消息的资源索引上界。
    topicContext: z
      .object({
        messages: z.array(
          z.object({ id: z.string(), attachments: z.array(z.unknown()).optional() }),
        ),
      })
      .optional(),
  }),
});
// 附件 artifact 必须是纯 base64 data URL；捕获组 1 为 mime，组 2 为 base64 正文。
const dataUrlPattern = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/;
// 从文件名提取扩展名（1~12 位字母数字），用于落盘 artifact 的类型提示；取不到时用 "bin"。
const extensionPattern = /\.([a-zA-Z0-9]{1,12})$/;

// 读取"当前会话某一轮输入所授权"的 topic 附件，并把二进制物化为工具结果 artifact。
// 输入：messages 为已加载的会话消息；input 为 ReadSessionContext 入参（必须带 attachment，
// 且 sessionId 等于当前执行上下文）；context 提供 abortSignal、topicResourcePort、
// artifactStore 与 traceContext。
// 输出：成功时 status=success、source=local、strategy=topic，path 指向写入的 artifact，
// content 为附件元数据 JSON（fileName/mime/bytes/path）。
// 失败语义：任何校验不通过都抛 Error（跨会话、无授权、索引越界、尺寸/编码不符、
// 运行时缺少 port/store、物化失败），由上层转换为 failed 输出；不做静默降级。
// 副作用：读取 artifactStore 中的内容，并按 session 保留期写入一个新的二进制 artifact。
export async function readTopicResourceFromSession(
  messages: MessageWithParts[],
  input: ReadSessionContextInput,
  context: ToolExecutionContext,
): Promise<ReadSessionContextOutput> {
  // 入口先响应取消，避免在已取消的工具调用上继续回溯历史消息。
  context.abortSignal.throwIfAborted();
  // topic 附件只对产生它的当前会话可见；跨会话或缺少 attachment 一律拒绝。
  if (input.sessionId !== context.sessionId || !input.attachment)
    throw new Error("Topic attachments require the current session");
  // canonical 来源存在时不得回退 legacy 字段，否则旧授权可覆盖新的可信输入事实。
  const candidates = messages.filter(({ info }) => info.role === "user" && !info.synthetic);
  let identity: z.infer<typeof identitySchema> | undefined;
  // 从最新消息往前扫描：授权按轮次写入，最近的记录才对应当前这次输入。
  for (const { info } of candidates.toReversed()) {
    const metadata = info.metadata;
    // canonical 字段一旦存在就以它为准；即使值为 undefined 也不回退 legacy inputIntent。
    const intent =
      metadata && Object.hasOwn(metadata, "conversationInputIntent")
        ? metadata.conversationInputIntent
        : metadata?.inputIntent;
    // 该消息没有输入意图元数据，无法提供授权，继续向前回溯。
    if (intent === undefined) continue;
    const parsed = identitySchema.safeParse(intent);
    if (parsed.success) {
      // 指定 inputId 时只认对应命令的授权；不匹配则继续向前找同一轮输入写入的记录。
      if (input.attachment.inputId && parsed.data.sourceCommandId !== input.attachment.inputId)
        continue;
      identity = parsed.data;
      break;
    }
    // 结构上明显是旧授权（含 botGroupSource 或 canonical 字段已有值）但 schema 不匹配时终止回溯，
    // 避免退回到更早、可能已失效或越权的授权记录。
    if (intent && typeof intent === "object" && Reflect.has(intent, "botGroupSource")) break;
    if (metadata && Object.hasOwn(metadata, "conversationInputIntent") && metadata.inputIntent)
      break;
  }
  if (!identity) throw new Error("No admitted topic authorization is available for this input");
  // 带 inputId 表示按 A1 快照读取：必须确认消息/资源序号确实属于当前授权快照。
  if (input.attachment.inputId) {
    // A1 只属于所选快照，不允许把另一轮的消息或资源序号拼到当前文件索引上。
    // 旧快照按 count 判界（index < count），新快照按 attachments 数组是否存在该点位。
    const source = identity.botGroupSource;
    const resourceIndex = input.attachment.index ?? 0;
    const indexed = source.topicHistory
      ? source.topicHistory.resourceMessages.some(
          (record) =>
            record.messageId === input.attachment!.messageId && resourceIndex < record.count,
        )
      : !!source.topicContext?.messages.find((record) => record.id === input.attachment!.messageId)
          ?.attachments?.[resourceIndex];
    if (!indexed) throw new Error("Resource is not indexed in the selected history snapshot");
  }
  // 读取能力与落盘能力必须成对存在：只读不落盘会让大附件无法以 path 形式转交模型。
  const port = context.topicResourcePort;
  const store = context.artifactStore;
  if (!port || !store?.writeToolResultBinaryArtifact)
    throw new Error("Topic attachment retrieval is unavailable on this runtime");
  // 复用当前调用的取消信号与 traceContext，保证后台 IO 可被取消且可观测。
  const options = { signal: context.abortSignal, trace: context.traceContext };
  const index = input.attachment.index ?? 0;
  const attachment = await port.read(
    {
      taskId: context.sessionId,
      inputId: identity.sourceCommandId,
      authorizationId: identity.botGroupSource.authorizationId,
      messageId: input.attachment.messageId,
      resourceIndex: index,
    },
    options,
  );
  context.abortSignal.throwIfAborted();
  // 字节数必须是安全整数且在协议上限内：拒绝负数/NaN/超大文件，避免后续解码与落盘失控。
  if (
    !Number.isSafeInteger(attachment.bytes) ||
    attachment.bytes < 0 ||
    attachment.bytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes
  )
    throw new Error("Invalid topic attachment size");
  const artifact = await store.readToolResultArtifact(
    { uri: attachment.ref, trace: options.trace },
    options,
  );
  const encoded = dataUrlPattern.exec(artifact.content);
  // artifact 必须是 data URL、mime 与授权声明一致，且 base64 长度不超过协议上限对应的保守上界。
  if (
    !encoded ||
    encoded[1] !== attachment.mime ||
    encoded[2]!.length > Math.ceil(PROTOCOL_V4_LIMITS.attachmentMaxBytes / 3) * 4
  )
    throw new Error("Invalid topic attachment artifact");
  const bytes = Buffer.from(encoded[2]!, "base64");
  // 解码长度与 base64 重编码必须完全一致，防止非法字符或填充差异导致内容与声明尺寸不符。
  if (bytes.length !== attachment.bytes || bytes.toString("base64") !== encoded[2])
    throw new Error("Topic attachment size or encoding mismatch");
  context.abortSignal.throwIfAborted();
  // 落盘为 session 级二进制 artifact：模型只拿到 path 与元数据，字节内容不进入上下文。
  const result = await store.writeToolResultBinaryArtifact(
    {
      sessionId: context.sessionId,
      toolCallId: context.toolCallId,
      toolName: "ReadSessionContext",
      content: bytes,
      contentType: attachment.mime,
      retention: "session",
      trace: options.trace,
      extension: extensionPattern.exec(attachment.fileName)?.[1]?.toLowerCase() ?? "bin",
    },
    options,
  );
  // 写盘后再核对取消：已取消的调用即使产物已生成，也不能当作成功结果返回。
  context.abortSignal.throwIfAborted();
  // 物化失败（没有 path）时抛错，避免返回一个不可被后续工具引用的结果。
  if (!result.path) throw new Error("Topic attachment could not be materialized");
  return {
    // success + source=local：附件已落到本地 artifact，不是远端会话内容。
    status: "success",
    sessionId: input.sessionId,
    strategy: "topic",
    query: input.query,
    source: "local",
    // path 为 artifact 存储路径，供后续工具按路径读取，不内联字节。
    path: result.path,
    // content 是附件元数据 JSON（fileName/mime/bytes/path），不是附件正文。
    content: JSON.stringify({
      fileName: attachment.fileName,
      mime: attachment.mime,
      bytes: attachment.bytes,
      path: result.path,
    }),
    messageCount: 1,
    selectedMessageCount: 1,
    truncated: false,
    references: [{ messageId: input.attachment.messageId, index }],
  };
}
