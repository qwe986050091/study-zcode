// INV-01 [契约] 本文件是逻辑历史到 wire 消息的唯一投影入口，只读入参并在内存里构造新数组与新对象；守住位置：toAiSdkMessages 的 transformedMessages 及下游各个 toAiSdk 转换函数；改错故障：一旦在投影里改写 message，session 事实、UI 可见 query 和标题种子会一起被污染。
// INV-02 [契约] 输出顺序必须与输入顺序一致，tool 结果的后置媒体只能紧跟在该结果之后；守住位置：主循环里只有 role 不是 tool 时才调用 flushPendingToolMedia，循环结束后再调用一次；改错故障：媒体 part 被提前或延后发出，assistant 的 tool-call 与结果错位，provider 报找不到对应结果。
// INV-03 [并发] 后置媒体只用一个 pendingToolMediaParts 累积器，flush 之后必须立刻清空；守住位置：flushPendingToolMedia 内的 push 与重置两句；改错故障：忘记清空会让同一批媒体重复挂到后续每一条 user 消息前面。
// INV-04 [失败路径] tool 消息缺少 toolCallId 或 toolName 时在请求前抛出 InvalidModelRequest，不允许降级成普通消息；守住位置：case "tool" 开头的守卫分支；改错故障：残缺历史被发到 wire，服务端返回无法关联的 tool_result，整轮请求失败。
// INV-05 [失败路径] tool_reference 只要出现在工具结果以外就抛错，不做文本化兜底；守住位置：contentBlockToAiSdkAssistantParts 与 contentBlockToAiSdkUserParts 的 tool_reference 分支；改错故障：引用被当成普通文本投递，服务端无法展开工具定义且没有任何提示。
// INV-06 [权衡] 含 video 的 tool 结果在所有 provider kind 上强制 textify 并把媒体后置，因为 SDK 的 tool result part 没有 video 变体；守住位置：case "tool" 中 messageTextifyToolResult 对 textify 开关与 toolResultHasVideoMedia 取或；改错故障：视频走内嵌路径被静默丢弃，模型只能看到工具名看不到画面。
// INV-07 [失败路径] 帧引用在媒体不可投递时整条结果改写成 error-text，且不得与媒体不可用占位同现；守住位置：frameReferenceFailure 及其在 output 三元里的最高优先级；改错故障：可行动的 frame_id 与占位文本并存，模型会对没见过的画面编造坐标动作。
// INV-08 [权衡] 结构化结果整体文本化时，只要存在 tool_reference 就放弃整体路径改为逐块投影；守住位置：toAiSdkToolResultOutput 的 hasToolReferences 判定；改错故障：引用被压成工具名文本，Anthropic 侧无法展开定义，后续 tool-call 全部失效。
// INV-09 [契约] tool 结果的 output 变体只有 error-text、text、content 三种，content 为空数组时必须回落成 text；守住位置：toAiSdkToolResultOutput 末尾的 value.length 三元；改错故障：空 content 触发 SDK 断言失败，或在历史里留下无法渲染的空结果。
// INV-10 [权衡] 空 text 块与 reasoning 块在工具结果中直接丢弃，但空图片和空视频必须回显显式 ERROR 文本；守住位置：contentBlockToAiSdkToolResultParts 的 text、reasoning、image、video 分支；改错故障：媒体静默消失，模型误以为工具什么都没返回。
// INV-11 [资源] 图片与文件先经 dataUrlToDataContent 解析，解析失败即视为空或损坏，不再回退原始 dataUrl；守住位置：image 与 file 分支对 data 的判定；改错故障：完整 dataUrl 被塞进 wire，请求体积暴涨且部分端点直接返回 400。
// INV-12 [契约] assistant 内容为纯文本且没有 toolCall 时直接返回字符串，其余情况统一展开为 part 数组；守住位置：toAiSdkAssistantContent 的提前返回；改错故障：所有 assistant 都变成数组，部分端点的文本前缀匹配和缓存命中失效。
// INV-13 [契约] assistant 的 part 顺序固定为内容块在前、tool-call 在后，调用方不得重排；守住位置：toAiSdkAssistantContent 末尾的展开拼接；改错故障：tool-call 前移会让文本与调用交错，SDK 校验或 provider 解析直接报错。
// INV-14 [权衡] 仅当 providerKind 为 openai、apiFormat 为 openai-responses、无 previousResponseId 与 conversation 且 store 不为 false 时，才丢弃带 itemId 的 reasoning；守住位置：shouldStripStoredReasoningForOpenAiResponsesStatelessReplay 的三段提前返回；改错故障：有状态回放也被裁剪会丢失思考上下文，反过来保留失效引用会让续轮变 5xx。
// INV-15 [权衡] 无正文且无 providerOptions 的 reasoning 空壳只在请求投影边界移除；守住位置：contentBlockToAiSdkAssistantParts 的 reasoning 分支；改错故障：空壳在历史回放时被 metadata 补全成有效 thinking，模型凭空产生推理内容。
// INV-16 [契约] 空工具名按方言投影：Anthropic 保留空串，其余方言替换为 empty_tool_name；守住位置：projectToolNameForProvider 的 apiFormat 分支与 providerKind 兜底分支；改错故障：OpenAI-compatible wire 校验失败，或 Anthropic 回放的工具名被改写后对不上历史。
// INV-17 [权衡] 空白 user 内容在 wire 边界降级为常量 EMPTY_USER_CONTENT_FALLBACK，不回写历史；守住位置：toAiSdkUserContent 的两条返回路径；改错故障：空白 user 被 provider trim 后视为缺失 prompt，整轮请求被拒或模型答非所问。
// INV-18 [契约] cacheControl 必须挂在具体 part 或消息的 providerOptions.anthropic 上，tool 结果要挂在结果块内；守住位置：providerOptionsForCacheControl 与 case "tool" 的展开位置；改错故障：SDK 合并连续 tool 消息只保留首条外层选项，批次末尾的缓存标记丢失或错挂到别条结果。
//
// 模块职责：把 contracts 的 ModelInputMessage 历史投影成 AI SDK 的 ModelMessage 线格式，负责工具名占位、媒体降级、推理块裁剪与空内容兜底，不做网络请求也不落盘。
// 状态所有权：输入历史由 session 持有且只读，pendingToolMediaParts 只是本函数栈内的临时累积器，投影结果一次性返回，不在模块级缓存任何消息。
// 阅读顺序：先看 toAiSdkMessages 的 role 分诊与待发媒体队列，再看 tool 结果的两级降级，最后看 assistant 与 user 的分块投影和空值兜底。
// ============================================================
// Vercel AI SDK protocol transforms
// 定位：把 contracts 的 ModelInputMessage 投影为 AI SDK 的 ModelMessage 线格式（wire projection）。
// 输入：逻辑历史 + 投影选项（apiFormat/providerKind/toolSearch/stripMedia/inputFormat/cacheControl）。
// 输出：可直接交给 SDK 的消息数组；工具结果含媒体时拆出后置 user part。
// 副作用：纯函数，无网络/落盘；仅在内存中构造新对象，不改入参。
// 失败语义：非法结构（缺 toolCallId/toolName、tool_reference 越位、ToolSearch 未启用）抛
//       AiSdkModelAdapterError(InvalidModelRequest)，在请求前 fail-closed；本函数不吞错。
// 不变量：历史事实不被改写（空 user 的 fallback 只在 wire 边界生成）；tool_reference 必须留在工具结果内。
// ============================================================

import { type ModelMessage as AiSdkModelMessage, type ToolResultPart } from "ai";
import {
  ModelErrorCode,
  modelMessageContentToText,
  type ModelCacheControl,
  type ModelInputMessage,
  type ModelInputFormat,
  type ModelMessageContent,
  type ModelMessageContentBlock,
} from "@zcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";
import { providerOptionsForReasoningBlock } from "./anthropic-reasoning-metadata.js";
import {
  shouldTextifyStructuredToolResults,
  toStructuredToolResultText,
  undeliverableFrameReferenceText,
  toToolResultMediaUserParts,
  toolResultHasVideoMedia,
} from "./tool-result-media-projection.js";
import { dataUrlToDataContent, unsupportedInputMediaText } from "./media-transform-policy.js";
import { normalizeOpenAiCompatibleSystemMessages } from "./system-message-compat.js";

// [契约] 这里的选项只影响 wire 投影，不改变 session 里的历史事实，同一份历史可以按不同选项重复投影。
// [契约] toolSearchEnabled 只在 providerKind 为 anthropic 时决定 tool_reference 能否投影为 custom part，其余情况一律按非法结构处理。
// [权衡] apiFormat 与 providerOptions.apiFormat 都可以给，resolveApiFormat 让显式字段优先，用于覆盖 provider 的默认方言。
// [边界] stripMedia 只保留文本表示，用于不支持多模态的端点降级，它不能让媒体凭空消失，必须留下可读文本。
// [权衡] inputFormat 决定图片、视频、文件是否可投递，缺省交给 unsupportedInputMediaText 判空，投影层不猜端点能力。
export interface AiSdkMessageTransformOptions {
  /** 是否启用 Anthropic ToolSearch；tool_reference 块据此决定能否投影为 custom part。 */
  toolSearchEnabled?: boolean;
  /** 线协议格式（如 anthropic-messages/openai-responses），缺省从 providerOptions.apiFormat 推导。 */
  apiFormat?: string;
  /** 提供方级选项（如 openai.previousResponseId/store），影响 reasoning 回放裁剪。 */
  providerOptions?: Record<string, unknown>;
  /** 提供方方言；决定工具名占位、system 消息归一化与响应回放策略。 */
  providerKind?: "openai" | "anthropic" | "openai-compatible" | "gateway" | "custom";
  /** 是否剥离媒体（仅保留文本），用于不支持多模态的端点降级。 */
  stripMedia?: boolean;
  /** 请求声明的输入格式；用于判定图片/视频/文件是否可投递。 */
  inputFormat?: ModelInputFormat;
}

type AiSdkAssistantMessage = Extract<AiSdkModelMessage, { role: "assistant" }>;
type AiSdkAssistantContent = AiSdkAssistantMessage["content"];
type AiSdkAssistantContentPart = Extract<AiSdkAssistantContent, unknown[]>[number];
type AiSdkToolResultOutput = ToolResultPart["output"];
type AiSdkProviderOptions = NonNullable<
  Extract<AiSdkModelMessage, { role: "system" }>["providerOptions"]
>;
type AiSdkAssistantTransformOptions = AiSdkMessageTransformOptions & {
  stripOpenAiResponsesStoredReasoning?: boolean;
};

/**
 * 把逻辑消息历史整体投影为 AI SDK 线消息，是请求序列化的唯一入口。
 * 输入：messages（已通过上层归一化）+ options；输出新的消息数组，不修改原数组。
 * 副作用：无；失败语义：结构性错误抛 InvalidModelRequest（请求前 fail-closed）。
 * 关键不变量：含视频的 tool result 一律 textify 并把媒体后置为 user part；
 *            帧引用不可投递时整条结果改写成 error-text，避免诱导模型臆测画面。
 */
export function toAiSdkMessages(
  messages: ModelInputMessage[],
  options: AiSdkMessageTransformOptions = {},
): AiSdkModelMessage[] {
  // [契约] openai-compatible 方言先做 system 消息归一化，其余方言原样进入投影，归一化不触碰 user、assistant、tool。
  // [契约] 无状态回放的推理裁剪开关在入口处只算一次，整个循环共用同一个布尔值，避免每条消息重复读 providerOptions。
  // [并发] pendingToolMediaParts 是循环外层唯一的可变累积器，所有 tool 分支只追加，只有 flush 读取并清空。
  // [失败路径] 当前消息不是 tool 时必须先 flush 再分诊，否则后置媒体会插进 tool 消息中间，破坏连续 tool 结果的合并。
  // [契约] switch 按 system、user、assistant、tool 四态穷举，未识别的 role 直接落空，不生成占位消息。
  // [失败路径] 循环结束后必须再 flush 一次，用于历史以 tool 消息结尾的情况，否则最后一批媒体永远不会发出。
  const normalizedMessages =
    options.providerKind === "openai-compatible"
      ? normalizeOpenAiCompatibleSystemMessages(messages)
      : messages;
  const shouldStripOpenAiResponsesStoredReasoning =
    shouldStripStoredReasoningForOpenAiResponsesStatelessReplay(options);

  const transformedMessages: AiSdkModelMessage[] = [];
  // 工具结果无法内嵌的媒体先累积，遇到非 tool 消息时统一 flush 成一条 user 消息，
  // 以保证媒体 part 紧跟在对应 tool-result 之后且不打断 tool 消息的连续合并。
  let pendingToolMediaParts: Extract<AiSdkUserContent, unknown[]> = [];
  const textifyStructuredToolResults = shouldTextifyStructuredToolResults(options);
  const flushPendingToolMedia = () => {
    if (pendingToolMediaParts.length === 0) return;
    transformedMessages.push({ role: "user", content: pendingToolMediaParts });
    pendingToolMediaParts = [];
  };

  for (const message of normalizedMessages) {
    if (message.role !== "tool") {
      flushPendingToolMedia();
    }

    switch (message.role) {
      case "system":
        transformedMessages.push({
          role: "system",
          content: modelMessageContentToText(message.content),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "user":
        transformedMessages.push({
          role: "user",
          content: toAiSdkUserContent(message.content, options),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;

      case "assistant": {
        transformedMessages.push({
          role: "assistant",
          content: toAiSdkAssistantContent(message.content, message.toolCalls, {
            ...options,
            stripOpenAiResponsesStoredReasoning: shouldStripOpenAiResponsesStoredReasoning,
          }),
          ...providerOptionsForCacheControl(message.cacheControl),
        });
        break;
      }

      // [失败路径] toolCallId 为空或 toolName 缺失时立即抛 InvalidModelRequest，并带上 role 上下文，便于上层定位是历史数据问题。
      // [契约] toolName 先经 projectToolNameForProvider 投影再写入 part，空名占位只允许发生在这一层。
      // [权衡] messageTextifyToolResult 由全局 textify 开关与工具结果是否含视频共同决定，两者取或。
      // [失败路径] frameReferenceFailure 优先于一切 output 计算，命中即整条 error-text，不再尝试内嵌任何内容块。
      // [资源] 只有帧引用未失败、需要 textify 且不是错误结果时才拆后置媒体，错误结果不再附带媒体。
      // [契约] cacheControl 展开在 tool-result 块内部而不是消息外层，因为 SDK 合并连续 tool 消息时只保留首条的外层选项。
      // [并发] toolMediaParts 只追加到 pendingToolMediaParts，不立刻 push 消息，等遇到非 tool 消息或循环结束时统一发出。
      case "tool": {
        if (!message.toolCallId || message.toolName === undefined) {
          throw new AiSdkModelAdapterError(
            ModelErrorCode.InvalidModelRequest,
            "Tool model messages require toolCallId and toolName",
            { context: { role: message.role } },
          );
        }
        const toolName = projectToolNameForProvider(message.toolName, options);
        // 含 video 的 tool result 在所有 provider kind 上都强制 textify + 后置投影：
        // AI SDK tool result part 无 video 变体，anthropic 内嵌路径同样会丢失视频内容。
        const messageTextifyToolResult =
          textifyStructuredToolResults || toolResultHasVideoMedia(message.content);

        // 通用 fail-closed：帧引用结果在媒体不可投递时整体错误化（约束：
        // 引用文本不得与"媒体不可用"占位符同现，否则 actionable frame_id 会诱导
        // 模型对未见过画面的坐标产生动作）。
        const frameReferenceFailure = undeliverableFrameReferenceText(message.content, options);

        const toolMediaParts =
          frameReferenceFailure === undefined &&
          messageTextifyToolResult &&
          message.isError !== true
            ? toToolResultMediaUserParts(message.content, {
                ...options,
                toolName,
              })
            : [];
        transformedMessages.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName,
              // SDK 合并连续 tool message 时只保留首条的 providerOptions；
              // 缓存标记必须跟随具体结果块，避免批次末尾标记丢失或被移到其他结果。
              ...providerOptionsForCacheControl(message.cacheControl),
              output: frameReferenceFailure
                ? { type: "error-text", value: frameReferenceFailure }
                : toAiSdkToolResultOutput(
                    message.content,
                    options,
                    message.isError === true,
                    messageTextifyToolResult,
                  ),
            },
          ],
        });
        pendingToolMediaParts.push(...toolMediaParts);
        break;
      }
    }
  }

  flushPendingToolMedia();
  return transformedMessages;
}

type AiSdkUserContent = Extract<AiSdkModelMessage, { role: "user" }>["content"];

/**
 * 计算单个 tool 结果的 SDK output 变体：错误→error-text；结构化结果或媒体降级→text；
 * 否则逐块转换 content。tool_reference 在任何降级路径都必须保留，否则服务端无法展开工具定义。
 */
// [契约] isError 优先级最高，直接产出 error-text 并把内容压成纯文本，不再尝试保留媒体。
// [契约] 字符串内容原样走 text 变体，不做任何解析，保持工具原始输出形态。
// [权衡] 需要整体 textify 时只要存在 tool_reference 就退出文本化，交给逐块分支处理。
// [权衡] stripMedia 与 textify 同时生效时，非引用块转文本，引用块仍按原结构投影。
// [失败路径] flatMap 结果为空时回落到整段文本，避免产出空 content 让 SDK 断言失败。
// [契约] 该函数是 tool 结果 output 变体的唯一出口，调用方必须传对 isError 与 textifyStructuredContent。
function toAiSdkToolResultOutput(
  content: ModelMessageContent,
  options: AiSdkMessageTransformOptions,
  isError = false,
  textifyStructuredContent = false,
): AiSdkToolResultOutput {
  if (isError) {
    return { type: "error-text", value: modelMessageContentToText(content) };
  }

  if (typeof content === "string") return { type: "text", value: content };

  const hasToolReferences = content.some((block) => block.type === "tool_reference");
  if (textifyStructuredContent && !hasToolReferences) {
    return { type: "text", value: toStructuredToolResultText(content, options) };
  }

  if (options.stripMedia && !hasToolReferences) {
    return { type: "text", value: modelMessageContentToText(content) };
  }

  // 工具引用不是媒体：媒体降级不能把引用变成名字文本，否则服务端无法展开定义。
  const value = content.flatMap((block) => {
    if (block.type !== "tool_reference" && (textifyStructuredContent || options.stripMedia)) {
      const text = textifyStructuredContent
        ? toStructuredToolResultText([block], options)
        : modelMessageContentToText([block]);
      return text ? [{ type: "text" as const, text }] : [];
    }
    return contentBlockToAiSdkToolResultParts(block, options);
  });
  return value.length > 0
    ? { type: "content", value }
    : { type: "text", value: modelMessageContentToText(content) };
}

/**
 * 把单个内容块转成 tool-result 的 content part；不可投递媒体转成说明文本，
 * 空图片/空视频给出显式 ERROR 文本让模型向用户说明，而不是静默丢失。
 */
// [契约] text 块长度为 0 时返回空数组，是否补占位交给上层决定，不在这里造文本。
// [失败路径] tool_reference 仅在 anthropic 且启用 ToolSearch 时投影为 custom part，否则抛 InvalidModelRequest。
// [权衡] reasoning 块在工具结果内一律丢弃，工具输出不应携带模型推理内容。
// [资源] 图片先判可投递性再解析 dataUrl，解析失败回显 ERROR 文本而不是内嵌损坏数据。
// [契约] 视频块在这里恒返回空数组，媒体由 tool-result-media-projection 拆成后置 user part。
// [权衡] 文件块优先使用已有 text，没有 text 才看 dataUrl，两者都没有则退化为纯文本描述。
function contentBlockToAiSdkToolResultParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): Extract<AiSdkToolResultOutput, { type: "content" }>["value"] {
  switch (block.type) {
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "tool_reference":
      if (options.providerKind !== "anthropic" || !options.toolSearchEnabled) {
        throw new AiSdkModelAdapterError(
          ModelErrorCode.InvalidModelRequest,
          "Tool references require active Anthropic ToolSearch",
        );
      }
      return [
        {
          type: "custom",
          providerOptions: { anthropic: { type: "tool-reference", toolName: block.toolName } },
        },
      ];

    case "reasoning":
      return [];

    case "image": {
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          { type: "text", text: "ERROR: Image file is empty or corrupted. Inform the user." },
        ];
      }
      return [{ type: "image-data", data: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      // AI SDK tool result part 无 video 变体：视频媒体统一由 tool-result-media-projection
      // 拆成后置 user part（toolResultHasVideoMedia 对含 video 的 tool result 在所有
      // provider kind 上强制 textify），这里不产出内嵌 part。
      return [];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) {
        return [{ type: "text", text: block.text }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (data) {
        return [
          {
            type: "file-data",
            data: data.data,
            mediaType: block.mediaType,
            ...(block.name ? { filename: block.name } : {}),
          },
        ];
      }
      return [{ type: "text", text: modelMessageContentToText([block]) }];
    }

    case "resource_link":
      return [{ type: "text", text: modelMessageContentToText([block]) }];
  }
}

/**
 * 组装 assistant 消息内容：纯文本且无 toolCall 时直接返回字符串（保持原样），
 * 否则把文本/推理块展开成 part，并把 toolCalls 追加为 tool-call part（顺序固定）。
 */
// [契约] toolCalls 先整体映射为 tool-call part，工具名同样经过方言投影。
// [契约] 纯文本且没有 toolCall 时直接返回字符串，保持与上游一致的轻量形态。
// [边界] 字符串为空时产出空 part 数组，但只要存在 toolCall 就仍返回数组而不是字符串。
// [契约] 最终顺序是内容块在前、tool-call 在后，调用方不得再重排。
function toAiSdkAssistantContent(
  content: ModelMessageContent,
  toolCalls: ModelInputMessage["toolCalls"],
  options: AiSdkAssistantTransformOptions,
): AiSdkAssistantContent {
  const toolCallParts =
    toolCalls?.map(
      (toolCall): AiSdkAssistantContentPart => ({
        type: "tool-call",
        toolCallId: toolCall.id,
        toolName: projectToolNameForProvider(toolCall.name, options),
        input: toolCall.input,
      }),
    ) ?? [];

  if (typeof content === "string" && toolCallParts.length === 0) {
    return content;
  }

  const contentParts =
    typeof content === "string"
      ? content.length > 0
        ? [{ type: "text" as const, text: content }]
        : []
      : content.flatMap((block) => contentBlockToAiSdkAssistantParts(block, options));

  return [...contentParts, ...toolCallParts];
}

/**
 * 把单个内容块转成 assistant part：仅保留有效 reasoning/text；媒体类块退化为文本，
 * 因为 assistant 历史不应再携带图片/视频/文件。tool_reference 出现在 assistant 属于非法结构。
 */
// [失败路径] tool_reference 出现在 assistant 内容里属于非法结构，直接抛错而不是降级成文本。
// [权衡] 命中无状态回放且块带 OpenAI itemId 时丢弃该 reasoning 块，避免失效引用导致续轮 5xx。
// [权衡] 无正文且无 providerOptions 的 reasoning 空壳在此移除，防止回放时被 metadata 补全成有效 thinking。
// [契约] reasoning 的 providerOptions 由 providerOptionsForReasoningBlock 统一生成，不在本函数手写。
// [权衡] 图片、视频、文件、资源链接在 assistant 历史中退化为文本，不再携带二进制内容。
function contentBlockToAiSdkAssistantParts(
  block: ModelMessageContentBlock,
  options: AiSdkAssistantTransformOptions,
): AiSdkAssistantContentPart[] {
  switch (block.type) {
    case "tool_reference":
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        "Tool references must appear inside tool results",
      );
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "reasoning": {
      if (
        options.stripOpenAiResponsesStoredReasoning === true &&
        hasOpenAiStoredReasoningItemId(block.providerOptions)
      ) {
        // 部分 Responses 兼容端点不支持无 previousResponseId 时回放 store=true 的
        // reasoning item_reference；只在 Responses 无状态回放边界丢弃该引用，避免工具结果续轮变成 5xx。
        return [];
      }
      // 没有正文和 provider 元数据的流式 reasoning 空壳会在历史回放时被
      // Anthropic metadata 补全误认为有效 thinking；只在请求投影边界移除精确空壳。
      if (block.text.length === 0 && Object.keys(block.providerOptions ?? {}).length === 0) {
        return [];
      }
      const providerOptions = providerOptionsForReasoningBlock(block, options);

      return [
        {
          type: "reasoning",
          text: block.text,
          ...providerOptions,
        } as AiSdkAssistantContentPart,
      ];
    }

    case "image":
    case "video":
    case "file":
    case "resource_link": {
      const text = modelMessageContentToText([block]);
      return text.length > 0 ? [{ type: "text", text }] : [];
    }
  }
}

/**
 * 判定是否为“OpenAI Responses 无状态回放”：providerKind=openai、apiFormat=openai-responses、
 * 且没有 previousResponseId/conversation、store 未显式 false。命中才允许丢弃 store=true 的 reasoning。
 */
function shouldStripStoredReasoningForOpenAiResponsesStatelessReplay(
  options: AiSdkMessageTransformOptions,
): boolean {
  if (options.providerKind !== "openai") return false;
  if (resolveApiFormat(options) !== "openai-responses") return false;
  const openaiOptions = objectRecord(options.providerOptions?.openai);
  if (typeof openaiOptions.previousResponseId === "string") return false;
  if (typeof openaiOptions.conversation === "string") return false;
  if (openaiOptions.store === false) return false;
  return true;
}

/** 线协议格式解析：显式 apiFormat 优先，其次 providerOptions.apiFormat，均无则 undefined。 */
function resolveApiFormat(options: AiSdkMessageTransformOptions): string | undefined {
  if (typeof options.apiFormat === "string") return options.apiFormat;
  const apiFormat = options.providerOptions?.apiFormat;
  return typeof apiFormat === "string" ? apiFormat : undefined;
}

/**
 * 工具名投影：非字符串或空名在多数 provider 上不可用。Anthropic 保留空名，
 * 其余（含 OpenAI-compatible）替换为占位 empty_tool_name，避免 wire 校验失败。
 */
function projectToolNameForProvider(
  toolName: unknown,
  options: AiSdkMessageTransformOptions,
): string {
  if (typeof toolName !== "string") {
    throw new AiSdkModelAdapterError(
      ModelErrorCode.InvalidModelRequest,
      "Tool model messages require toolCallId and toolName",
    );
  }
  if (toolName.trim().length > 0) return toolName;

  const apiFormat = resolveApiFormat(options);
  if (apiFormat !== undefined) {
    return apiFormat === "anthropic-messages" ? toolName : "empty_tool_name";
  }

  // OpenAI-compatible wire 不可靠接受空 function name，但历史中的原始
  // 名称仍需保留给 Anthropic 回放；占位值只在 provider 投影边界生成。
  return options.providerKind === "anthropic" ? toolName : "empty_tool_name";
}

/** 判定 reasoning 块是否带 OpenAI 远端 item_id（store 回放引用），用于无状态回放时裁剪。 */
function hasOpenAiStoredReasoningItemId(providerOptions: unknown): boolean {
  const openaiOptions = objectRecord(objectRecord(providerOptions).openai);
  return typeof openaiOptions.itemId === "string" && openaiOptions.itemId.length > 0;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

const EMPTY_USER_CONTENT_FALLBACK = "(no content)";

/**
 * 构造 user 消息内容：字符串空值降级为固定占位，content 数组为空亦降级。
 * 占位只在 wire 边界生成，避免空白 user 被 provider trim 后丢失 prompt。
 */
// [契约] 字符串空值与空 part 数组都降级为常量 EMPTY_USER_CONTENT_FALLBACK，占位只在 wire 边界生成。
// [失败路径] 空白 user 会被 provider trim 后当成缺失 prompt，fallback 是防止整轮请求被拒的最后一道兜底。
// [权衡] stripMedia 在 user 侧最先判断，命中即转文本，不再继续解析 dataUrl。
// [资源] 图片解析失败回显 ERROR 文本，视频则借 file part 交给 patch 后的 SDK 转成 video block。
// [契约] 文件块依次判断已有 text、stripMedia、可投递性、dataUrl，顺序不可调换。
// [契约] resource_link 与不可投递媒体都退化为 modelMessageContentToText 的文本结果，条目不丢。
function toAiSdkUserContent(
  content: ModelMessageContent,
  options: AiSdkMessageTransformOptions,
): AiSdkUserContent {
  // 附件-only query 拆出 prompt attachment 后可能留下空 user
  // content，空白占位又可能被 provider trim 后视为缺失 prompt。只在 wire
  // 序列化边界使用固定 fallback，避免改写 session 事实、UI 可见 query 和标题种子。
  if (typeof content === "string") return content || EMPTY_USER_CONTENT_FALLBACK;

  const parts = content.flatMap((block) => contentBlockToAiSdkUserParts(block, options));
  return parts.length > 0 ? parts : EMPTY_USER_CONTENT_FALLBACK;
}

/**
 * 把用户内容块转成 SDK user part：媒体在 stripMedia 或不可投递时退化为文本；
 * video 无原生 part，借 file part + mediaType 交由 patch 后的 SDK 转成 video_url/block。
 */
function contentBlockToAiSdkUserParts(
  block: ModelMessageContentBlock,
  options: AiSdkMessageTransformOptions,
): Extract<AiSdkUserContent, unknown[]> {
  switch (block.type) {
    case "tool_reference":
      throw new AiSdkModelAdapterError(
        ModelErrorCode.InvalidModelRequest,
        "Tool references must appear inside tool results",
      );
    case "text":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "reasoning":
      return block.text.length > 0 ? [{ type: "text", text: block.text }] : [];

    case "image": {
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          {
            type: "text",
            text: "ERROR: Image file is empty or corrupted. Inform the user.",
          },
        ];
      }
      return [{ type: "image", image: data.data, mediaType: block.mediaType }];
    }

    case "video": {
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = dataUrlToDataContent(block.dataUrl);
      if (!data) {
        return [
          {
            type: "text",
            text: "ERROR: Video file is empty or corrupted. Inform the user.",
          },
        ];
      }
      // AI SDK 无 video part 类型；mediaType 为自由 string，video/* file part 由
      // patch 后的 @ai-sdk/openai-compatible / @ai-sdk/anthropic 转成 video_url / video block。
      return [{ type: "file", data: data.data, mediaType: block.mediaType }];
    }

    case "file": {
      if (block.text !== undefined && block.text.length > 0) {
        return [{ type: "text", text: block.text }];
      }
      if (options.stripMedia) {
        return [{ type: "text", text: modelMessageContentToText([block]) }];
      }
      const unsupportedText = unsupportedInputMediaText(block, options.inputFormat);
      if (unsupportedText) {
        return [
          {
            type: "text",
            text: unsupportedText,
          },
        ];
      }
      const data = block.dataUrl ? dataUrlToDataContent(block.dataUrl) : undefined;
      if (data) {
        return [
          {
            type: "file",
            data: data.data,
            filename: block.name,
            mediaType: block.mediaType,
          },
        ];
      }
      return [{ type: "text", text: modelMessageContentToText([block]) }];
    }

    case "resource_link":
      return [{ type: "text", text: modelMessageContentToText([block]) }];
  }
}

/** 把 cacheControl 标记挂到 anthropic providerOptions；无标记返回空对象以保持展开语义。 */
function providerOptionsForCacheControl(
  cacheControl: ModelCacheControl | undefined,
): { providerOptions: AiSdkProviderOptions } | Record<string, never> {
  if (!cacheControl) {
    return {};
  }

  return {
    providerOptions: {
      anthropic: {
        cacheControl: { ...cacheControl },
      },
    },
  };
}
