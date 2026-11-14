/* eslint-disable max-lines -- Telegram provider 集中处理 Bot API 文本、按钮、媒体解析和附件下载。 */
// 文件职责：Telegram Bot API 适配器，只做协议翻译（update -> BotInboundMessage，
// BotOutboundMessage -> sendMessage/sendChatAction），不持有授权、幂等或任务状态。
// 调用关系：
//   telegramChannelRuntime --getUpdates--> processProviderCallback -> parseCallback
//   botsService --send / sendTyping / acknowledgeCallback / downloadAttachment--> Bot API
// 维护/依赖的不变量：
// INV-01：正文与 callback_data 只当命令文本；身份字段只取 Telegram 的 from/chat，不据正文推断。
// INV-02：send() 逐条校验 Bot API 的 ok，任何非 ok 都抛错，不向上伪装成已投递。
// INV-03：providerMessageId 缺失时仍放行（fail-open），但绝不伪造 id，去重交给上层。
// INV-04：附件下载对两步请求都校验 HTTP 状态，并用同一个 AbortController 施加 30s 上限；
//   字节数上限不在这里强制，由 botsService 落盘前按 5MB 校准（见 downloadAttachment）。
// INV-09：filename 原样来自远端 file_name，本文件不拼任何路径，净化与落盘在 botsService。
// INV-10：内部不重试；send 失败转成带 retryAfter 的稳定 Error，由上层决定补发。
// INV-12：不持有长连接与常驻定时器（仅单次下载的 timeout），每次调用重新取 token，无 close 状态。
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
  SelectionPrompt,
} from "@zcode/shared";
// 菜单顺序是唯一事实源：本地 slash 解析、飞书菜单和 Telegram 菜单必须共用同一份顺序，
// 否则三个渠道展示的命令次序会漂移，用户在不同端看到的序号也对不上。
import { BOT_MENU_COMMAND_ORDER } from "../commandOrder.js";
import type { BotProviderAdapter } from "./types.js";
// 只用统一封装而不是原生 fetch：providerRequest 会在同一个 AbortSignal 下读完响应体，
// 避免"拿到响应头就撤掉 deadline"导致 Bot actor 串行队列被单个悬挂请求长期占住。
import { fetchBotProvider, fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";

// 依赖注入而不是直接引入 credentialService：适配器只拿到 loadCredential 能力，
// 无法枚举或写入凭据，天然满足 INV-08"凭据只读、不外泄"。
interface TelegramProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

// 仅用于 setMyCommands 的线上结构；description 必须是英文短句（Telegram 客户端原样展示）。
interface TelegramBotCommand {
  command: string;
  description: string;
}

// 比 providerRequest 默认 15s 更宽松：getFile + 文件下载共用一个 deadline，
// 大文件在弱网下 15s 不够；30s 是"能下完"和"卡住时不拖死回调"之间的折中。
const TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 30_000;

// 响应字段全部 optional：Bot API 出错时仍返回 JSON（ok:false + description），
// 因此不能靠类型断言认为 result 一定存在。ok 必须显式比较 true，见 test/send。
interface TelegramGetMeResponse {
  ok?: boolean;
  description?: string;
  result?: {
    username?: string;
    first_name?: string;
  };
}

// file_size 是 Telegram 侧记录的大小，可能缺失；它只作 sizeBytes 提示，
// 真实字节数以 arrayBuffer 长度为准（上层据此做大小上限判定）。
interface TelegramFileResponse {
  ok?: boolean;
  description?: string;
  result?: {
    file_path?: string;
    file_size?: number;
  };
}

// Telegram 客户端菜单只显示英文：命令名受 Bot API 约束（小写、可含下划线），
// 中文别名由 commandParser 在解析侧支持，不写进菜单，避免同一菜单中英混杂。
// 这些字符串是用户可见文案，改动等于改产品文案，不是内部标识。
const telegramCommandDescriptions = {
  bind: "Bind this chat",
  help: "Show help",
  status: "Show current status",
  new: "Create a new task",
  workspace: "Select project",
  model: "Select model",
  mode: "Select mode",
  thoughtLevel: "Select thinking level",
  reply: "Select reply detail",
} as const;

// 配置键 -> 线上命令名。必须逐项显式映射，不能把键名直接下发：
// camelCase（thoughtLevel）会被 Bot API 拒绝，且 workspace 对外应叫 /project，
// thoughtLevel 的既有别名是 /think，用户已经在用，不能为了"整齐"改成 thought_level。
// Bot API 要求命令名 1~32 字符、只含小写字母/数字/下划线；这里全部满足，
// 新增命令若带驼峰或中文会整批 setMyCommands 被拒，而不是只跳过那一条。
const telegramCommandNames = {
  bind: "bind",
  help: "help",
  status: "status",
  new: "new",
  workspace: "project",
  model: "model",
  mode: "mode",
  thoughtLevel: "think",
  reply: "reply",
} as const;

// 外部 payload 的类型闸门：Telegram update 是任意 JSON，所有字段读取都必须先过这里，
// 否则 null/数组会被当成对象索引，抛出 TypeError 而不是返回空解析结果。
// 不做 schema 级校验（不引入 zod）：update 形态太多，严格校验会把新字段/new_* 变体
// 整条拒掉；这里只保证"读字段不会炸"，语义完整性由下面各解析函数的必填项把关。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 按 3900 切分：留出 Telegram 单条 4096 的上限余量，避免把正文顶到边界后被拒。
// 只按长度硬切，不做换行/单词边界处理：[权衡] 按字符数切保证每条都发得出去，
// 代价是可能切开代理对（emoji 被拆到两条消息里显示为乱码）。
// 空串返回 [""]，让调用方仍走一次 sendMessage，保持"一次 outbound 至少一次请求"的语义。
// 长度按 UTF-16 code unit 计（String.length），因此 1 个 emoji 占 2，实际字符数少于 3900；
// 这个偏差方向是安全的（更保守），不会把正文顶到 4096 之上。
function splitTelegramText(text: string): string[] {
  const limit = 3900;
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += limit) {
    chunks.push(text.slice(index, index + limit));
  }
  return chunks.length > 0 ? chunks : [text];
}

// answerCallbackQuery 的 text 会作为浮动 toast 展示，Telegram 上限 200 字符；
// 截到 177 + "..." 留出省略号空间。先把换行/连续空白压成单空格：
// toast 不保留换行，原样发送会把多行错误压成一团并挤掉前缀。
function truncateCallbackToast(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

// 普通消息（非按钮）解析。输入是单条 update，输出是统一入站消息或 null。
// 口径：
// - text 优先、caption 兜底：图片/文件消息的说明文字在 caption，丢了这个字段会导致
//   带附件的提问变成"只有附件没有正文"。
// - userId 必填：没有 from.id 无法定位身份，按 INV-01 不能猜，直接返回 null。
// - chatType 只有明确 "private" 才按私聊，其余（group/supergroup/channel/缺失）统一归为
//   group，失败方向偏向更严格的群语义，避免私聊专属状态被群消息污染。
// - providerMessageId 可缺失（fail-open，INV-03）：Telegram 正常消息的 message_id 是整数，
//   这里额外接受字符串只是防御代理/云端变体；两者都没有就交给上层按"无幂等键"处理，不伪造。
// - 纯附件消息 text 为空但 attachments 非空，仍必须投递，否则用户发图即丢消息。
// botId 来自调用方而非 update：Telegram update 里没有"这条消息属于哪个 ZCode bot"，
// 只能由 runtime 按轮询的 token 注入；缺失时 parseCallback 会直接丢弃（见末尾）。
// message_id 只在单个 chat 内唯一（不同 chat 会重号），因此幂等键必须连同 chatId 一起用，
// 只存 message_id 会把两个群的同号消息误判为重复。
function readTelegramPrivateMessage(
  botId: string,
  update: Record<string, unknown>,
): BotInboundMessage | null {
  const message = isRecord(update.message) ? update.message : null;
  if (!message) {
    return null;
  }
  const chat = isRecord(message.chat) ? message.chat : null;
  const from = isRecord(message.from) ? message.from : null;
  const text =
    typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "";
  const userId =
    typeof from?.id === "number" || typeof from?.id === "string" ? String(from.id) : "";
  const chatType = chat?.type === "private" ? "private" : "group";
  const attachments = readTelegramAttachments(message);
  if ((!text && attachments.length === 0) || !userId) {
    return null;
  }
  return {
    botId,
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    actor: {
      provider: "telegram",
      botId,
      providerUserId: userId,
      displayName:
        typeof from?.username === "string"
          ? from.username
          : typeof from?.first_name === "string"
            ? from.first_name
            : undefined,
      chatType,
      chatId:
        typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : undefined,
      providerMessageId:
        typeof message.message_id === "number" || typeof message.message_id === "string"
          ? String(message.message_id)
          : undefined,
    },
  };
}

// 把 Telegram 的 document/video/audio/voice/photo 统一映射成 BotInboundAttachment。
// - file_id 是唯一下载凭据，缺失即无法取文件，返回 null 而不是产出"空附件"，
//   否则上层会为一条永远下不动的附件反复报错。
// - filename 优先 file_name；Telegram 对 photo/voice 不给名字，用调用方给的 fallback。
//   远端文件名只透传，不在这里做净化（INV-09 的落盘环节在 botsService）。
// - mimeType 缺失时按 kind 给默认值：下游按 mimeType 分流图片/音频，空串会走错分支。
// - sizeBytes 只在 Telegram 明确给出数字时写入，避免用 0 冒充"已知为 0 字节"。
function readTelegramFileAttachment(
  value: unknown,
  kind: BotInboundAttachment["kind"],
  fallbackName: string,
): BotInboundAttachment | null {
  if (!isRecord(value)) {
    return null;
  }
  const providerFileId = typeof value.file_id === "string" ? value.file_id : "";
  if (!providerFileId) {
    return null;
  }
  const filename =
    typeof value.file_name === "string" && value.file_name.trim() ? value.file_name : fallbackName;
  return {
    id: providerFileId,
    kind,
    filename,
    mimeType:
      typeof value.mime_type === "string" && value.mime_type.trim()
        ? value.mime_type
        : defaultMimeTypeForAttachmentKind(kind),
    ...(typeof value.file_size === "number" ? { sizeBytes: value.file_size } : {}),
    providerFileId,
  };
}

// photo 是一个"多尺寸数组"，Telegram 按边长升序排列，且各尺寸 file_id 不同。
// 取最后一个即最大图；若取第一个会只拿到缩略图，模型看到的图会糊到无法辨认。
function readTelegramPhotoAttachment(
  message: Record<string, unknown>,
): BotInboundAttachment | null {
  if (!Array.isArray(message.photo) || message.photo.length === 0) {
    return null;
  }
  const photo = message.photo.filter(isRecord).at(-1);
  if (!photo) {
    return null;
  }
  return readTelegramFileAttachment(photo, "image", "telegram-photo.jpg");
}

// 缺省 MIME 只覆盖 Telegram 常见形态：image 一律按 jpeg（photo 实际就是 jpeg），
// 其余未知类型落到 application/octet-stream，让下游按"不可预览文件"处理而不是猜。
function defaultMimeTypeForAttachmentKind(kind: BotInboundAttachment["kind"]): string {
  if (kind === "image") return "image/jpeg";
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "application/octet-stream";
}

// 一条 Telegram 消息最多同时带一种媒体（document 与 photo 互斥），
// 仍按固定顺序全部尝试并在最后过滤 null：顺序决定 attachments 数组下标，
// 上层按附件序号引用文件，改动顺序会让已发出的引用失效。
// 注意 voice 与 audio 都映射成 kind=audio，二者语义不同（语音条 vs 音乐），
// 目前只用 filename/mimeType 区分，属于已知的信息损失。
function readTelegramAttachments(message: Record<string, unknown>): BotInboundAttachment[] {
  return [
    readTelegramPhotoAttachment(message),
    readTelegramFileAttachment(message.document, "file", "telegram-document"),
    readTelegramFileAttachment(message.video, "video", "telegram-video.mp4"),
    readTelegramFileAttachment(message.audio, "audio", "telegram-audio"),
    readTelegramFileAttachment(message.voice, "audio", "telegram-voice.ogg"),
  ].filter((attachment): attachment is BotInboundAttachment => attachment !== null);
}

// 按钮回调解析。关键口径：
// - 身份取 callback_query.from，而不是 message.from：后者是"按钮所在卡片由谁发出"，
//   在群聊里可能是机器人自己，用错会把操作记到别人头上并绕过授权（INV-01）。
// - data 是客户端回传串，只当命令文本解码，绝不据此提升权限（INV-11）。
// - providerMessageId 优先 callback_query.id：它是"这一次点击"的唯一标识，
//   同一条卡片被连点两次得到不同 id，上层据此识别重复点击；缺失时退回源消息 id。
//   两者都没有则留空，走 INV-03 的 fail-open，不编造。
function readTelegramCallbackMessage(
  botId: string,
  update: Record<string, unknown>,
): BotInboundMessage | null {
  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  if (!callbackQuery) {
    return null;
  }
  const message = isRecord(callbackQuery.message) ? callbackQuery.message : null;
  const chat = isRecord(message?.chat) ? message.chat : null;
  const from = isRecord(callbackQuery.from) ? callbackQuery.from : null;
  const data = typeof callbackQuery.data === "string" ? callbackQuery.data : "";
  const userId =
    typeof from?.id === "number" || typeof from?.id === "string" ? String(from.id) : "";
  if (!data || !userId) {
    return null;
  }
  const commandText = decodeTelegramCallbackData(data);
  return {
    botId,
    text: commandText,
    actor: {
      provider: "telegram",
      botId,
      providerUserId: userId,
      displayName:
        typeof from?.username === "string"
          ? from.username
          : typeof from?.first_name === "string"
            ? from.first_name
            : undefined,
      chatType: chat?.type === "private" ? "private" : "group",
      chatId:
        typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : undefined,
      providerMessageId:
        typeof callbackQuery.id === "string"
          ? callbackQuery.id
          : typeof message?.message_id === "number" || typeof message?.message_id === "string"
            ? String(message.message_id)
            : undefined,
    },
  };
}

// acknowledgeCallback 只需要 callback_query.id，单独抽出来是为了让"取不到 id 就不发请求"
// 这一判断与消息解析解耦：payload 可能是 {botId, update} 包装，也可能已是裸 update，
// 两处（解析与 ACK）都按同一兼容口径解开包装，避免一处成功一处失败。
function readTelegramCallbackId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const update = isRecord(payload.update) ? payload.update : payload;
  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  return typeof callbackQuery?.id === "string" ? callbackQuery.id : null;
}

// 撤回按钮需要 chat_id + message_id 二元组，且 message_id 必须是 number（Bot API 要求整数）；
// chat id 保持字符串是为了与 actor.chatId 同型，出请求时不需要再转换类型。
// 任一缺失返回 null：宁可不撤按钮，也不能猜一个 message_id 去改别人的消息。
function readTelegramCallbackMessageRef(
  payload: unknown,
): { chatId: string; messageId: number } | null {
  if (!isRecord(payload)) {
    return null;
  }
  const update = isRecord(payload.update) ? payload.update : payload;
  const callbackQuery = isRecord(update.callback_query) ? update.callback_query : null;
  const message = isRecord(callbackQuery?.message) ? callbackQuery.message : null;
  const chat = isRecord(message?.chat) ? message.chat : null;
  const chatId =
    typeof chat?.id === "number" || typeof chat?.id === "string" ? String(chat.id) : "";
  const messageId = typeof message?.message_id === "number" ? message.message_id : null;
  return chatId && messageId !== null ? { chatId, messageId } : null;
}

// 把 SelectionPrompt 的一个选项编码成 callback_data（≤64 字节）。
// 不是所有 action 都能带原始 id：workspace/task 的 id 可能是远程 identity 或长路径，
// 直接拼进 data 会超过 64 字节被 Telegram 整条拒收；因此除 permission/elicitation/model
// 这些短值场景外，一律只回传"当前列表序号"，由上层用已有的数字序号解析复用。
// 编码格式与 decodeTelegramCallbackData 必须成对维护，改一侧等于让另一侧静默失效。
// 安全口径（INV-11）：data 只是路由信息，选项归属与越权校验在 botsService 完成。
function buildSelectionCallbackData(
  selection: SelectionPrompt,
  optionId: string,
  index: number,
): string {
  if (selection.action === "permission.respond") {
    return `zc:permission:${index + 1}`;
  }
  if (selection.action === "elicitation.respond") {
    return selection.token ? `zc:e:${selection.token}:${index + 1}` : `zc:elicitation:${index + 1}`;
  }
  if (selection.action === "model.provider.set") {
    return `zc:cmd:/model provider ${index + 1}`;
  }
  if (selection.action === "model.set") {
    return `zc:cmd:/model model ${index + 1}`;
  }
  // Telegram callback_data 最多 64 字节，workspace/task id 可能是远程 identity 或长路径。
  // 这里只回传当前列表序号，后续命令解析复用已有的数字选项解析，避免长 id 被 Telegram 拒收。
  return `zc:${selection.action.replace(".set", "")}:${index + 1}`;
}

// 生成 inline_keyboard：每个选项独占一行，取消按钮单独成行。
// 一选项一行而不是两列并排：label 可能很长，并排会让文字被截断到无法区分。
// showCancel 默认 true（只有显式 false 才隐藏），保证任何 pending selection 都有退出路径；
// 取消统一用固定 data "zc:cancel"，不携带 selection id，避免把过期 id 也发出去。
function buildSelectionReplyMarkup(selection: SelectionPrompt): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const cancelRows =
    selection.showCancel === false
      ? []
      : [
          // Bugfix: Telegram 原生按钮以前没有取消入口，用户只能手敲 0 才能退出 pending selection。
          [{ text: selection.cancelLabel ?? "Cancel", callback_data: "zc:cancel" }],
        ];
  return {
    inline_keyboard: [
      ...selection.options.map((option, index) => [
        {
          text: option.label,
          callback_data: buildSelectionCallbackData(selection, option.id, index),
        },
      ]),
      ...cancelRows,
    ],
  };
}

// callback_data -> 命令文本的反向编码。所有分支最终都产出以 "/" 开头的命令或原始文本，
// 因为下游只认 parseBotCommand 的语法；[权衡] 宁可多一层"编码->文本->再解析"，
// 也不让适配器直接调用业务函数，否则权限判定会绕过 botsService 的统一入口（INV-01）。
// 未知前缀原样返回：不能被识别成命令就不会获得任何操作能力，最多成为一条普通消息。
function decodeTelegramCallbackData(data: string): string {
  if (data === "zc:cancel") {
    return "/cancel";
  }
  if (data.startsWith("zc:e:")) {
    const [, , token, value] = data.split(":");
    return token && value ? `/elicitation ${token} ${value}` : "/elicitation";
  }
  if (data.startsWith("zc:cmd:")) {
    return data.slice("zc:cmd:".length);
  }
  if (data.startsWith("zc:")) {
    return `/${data.slice(3).replace(":", " ")}`;
  }
  return data;
}

// 菜单注册内容：顺序严格跟随 BOT_MENU_COMMAND_ORDER（与本地命令表同源）。
// help/bind 无条件保留：前者是排障入口，后者是首次接入唯一手段，即使被策略关闭也要可见；
// 其余按 bot.allowedCommands[command] !== false 过滤，区分"显式禁用"与"字段缺失"（默认启用）。
// Telegram 单次 setMyCommands 上限 100 条，当前 9 条远低于上限，因此不做分批。
function buildTelegramCommands(bot: BotConfig): TelegramBotCommand[] {
  return BOT_MENU_COMMAND_ORDER.filter(
    (command) => command === "help" || command === "bind" || bot.allowedCommands[command] !== false,
  ).map((command) => ({
    command: telegramCommandNames[command],
    description: telegramCommandDescriptions[command],
  }));
}

// 工厂返回无状态适配器：token 每次调用现取（INV-08 不缓存、不落日志），
// 因此不存在"关闭后仍持有连接"的问题，close 语义天然幂等（INV-12）。
// deps 只暴露 loadCredential 一个能力，适配器不可能读到别的 bot 的凭据。
export function createTelegramBotProvider(deps: TelegramProviderDeps): BotProviderAdapter {
  async function loadToken(bot: BotConfig): Promise<string | null> {
    return bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;
  }

  // getMe 返回三态：null=拿不到 token 或请求失败；{} 或缺字段=拿到了但不是可用结果；
  // 正常对象=Bot API 应答。调用方必须再判 ok，不能只看非 null。
  // 不重试（INV-10）：test/resolveName 属于用户触发的即时操作，重试只会放大等待时间。
  // token 拼在 URL path 里，因此任何日志/错误都绝不能带上完整 URL（INV-08）；
  // 这里抛出的错误只来自封装层（超时/网络），不会把 URL 写进 message。
  async function getMe(bot: BotConfig): Promise<TelegramGetMeResponse | null> {
    const token = await loadToken(bot);
    if (!token?.trim()) {
      return null;
    }
    const response = await fetchBotProviderJson<TelegramGetMeResponse>(
      `https://api.telegram.org/bot${token}/getMe`,
    );
    if (!response.ok) {
      return null;
    }
    return response.payload ?? {};
  }

  return {
    // 连通性探测。三类失败必须区分，否则用户无法判断该换 token 还是查网络：
    // 1) 没配 credentialRef -> 本地配置问题；2) getMe 为 null -> 网络/HTTP 失败；
    // 3) ok !== true -> Bot API 明确拒绝，description 是唯一可读原因，原样透出。
    // 名字优先 first_name（人能读），没有才退 username。
    async test(bot) {
      if (!bot.credentialRef) {
        return { ok: false, message: "Telegram bot token is missing." };
      }
      const payload = await getMe(bot);
      if (!payload) {
        return { ok: false, message: "Telegram getMe failed." };
      }
      const name = payload.result?.first_name || payload.result?.username;
      return {
        ok: payload.ok === true,
        name,
        message:
          payload.ok === true
            ? "Telegram bot is reachable."
            : (payload.description ?? "Telegram getMe failed."),
      };
    },

    // 保存 bot 时用它补人类可读名称；失败返回 null 让上层保留用户填写的名字，
    // 不能因为一次网络错误让保存流程失败（名称只是展示增强）。
    async resolveName(bot) {
      const payload = await getMe(bot);
      return payload?.ok === true
        ? payload.result?.first_name || payload.result?.username || null
        : null;
    },

    // 命令菜单同步。两种模式：
    // - enabled=false：deleteMyCommands 清空菜单，且 catch 掉错误（删除 bot 的清理动作，
    //   失败不应阻断本地配置落盘）；[权衡] 吞错意味着远端可能残留旧菜单，但下次启用会覆盖。
    // - enabled=true：setMyCommands 覆盖默认 scope 的菜单，失败向上抛，由 runtime 记 warn。
    // 只登记英文名，中文命令由 parser 支持：客户端菜单是"发现入口"，不是权限清单。
    // [并发] 同一 token 若被多个 bot 配置复用，这里没有加锁，后写覆盖先写，属已知限制。
    async syncCommands(bot) {
      const token = await loadToken(bot);
      if (!token?.trim()) {
        return;
      }
      if (!bot.enabled) {
        await fetchBotProvider(`https://api.telegram.org/bot${token}/deleteMyCommands`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        }).catch(() => undefined);
        return;
      }

      const defaultCommands = buildTelegramCommands(bot);
      // Bugfix: Telegram 菜单不会自动从我们支持的 slash commands 推导。
      // 这里只同步默认英文菜单；中文命令由 parser 支持，避免 Telegram 客户端菜单显示中英混杂。
      await fetchBotProvider(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commands: defaultCommands }),
      });
    },

    // 出站发送。要点：
    // - 长文本先切块再逐条发；只有最后一块挂 reply_markup，因为审批/选择按钮必须
    //   贴在与最终决策上下文相邻的那条消息上，挂在第一条会让用户在正文没读完时误点。
    // - 先按 Markdown 发，只有"明确的格式拒绝"（HTTP 400 且 description 命中
    //   parse/entities/markdown，或无 description）才降级纯文本重发一次；
    //   限流(429)、封禁(403)、结果未知都不能重发，否则会重复投递（INV-02/INV-10）。
    // - 成功判据是 response.ok 且 payload.ok === true 双条件：HTTP 200 也可能携带 ok:false。
    // - 失败抛 Error 并附带 deliveryRejected（明确被拒）与 retryAfter（限流秒数），
    //   让上层区分"可稍后重试"和"永久失败"。
    // [失败路径] 任一块失败立即抛出，已发送的前序块保留：不尝试撤回，避免二次副作用。
    // chat_id 用 providerUserId：Telegram 私聊里 user id 与 chat id 数值相同，
    // 单聊场景两者可互换；群聊则由 actor.chatId 承载，本函数只看接收者，故沿用该字段。
    // 返回值只有 void：Bot API 会在 result.message_id 返回新消息 id，但本适配器不解包，
    // 上层无法据此记录 providerMessageId——需要消息 id 的场景不能依赖 Telegram send。
    async send(bot: BotConfig, message: BotOutboundMessage) {
      const token = await loadToken(bot);
      if (!token?.trim()) throw new Error("Telegram bot token is missing");
      const selection = message.selection;
      const replyMarkup = selection ? buildSelectionReplyMarkup(selection) : undefined;
      const chunks = splitTelegramText(message.text);
      for (const [index, text] of chunks.entries()) {
        // Bugfix: 长 Plan 会被拆成多条消息，审批提示位于最后一条。
        // 按钮必须跟随最终决策上下文，不能挂在尚未发送完整正文的第一条上。
        const shouldAttachReplyMarkup = index === chunks.length - 1 && replyMarkup;
        const send = (markdown: boolean) =>
          fetchBotProviderJson<{
            ok?: boolean;
            description?: string;
            error_code?: number;
            parameters?: { retry_after?: number };
          }>(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              chat_id: message.providerUserId,
              text,
              ...(markdown ? { parse_mode: "Markdown" } : {}),
              ...(shouldAttachReplyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
          });
        let response = await send(true);
        // 只有明确的格式拒绝才改纯文本；限流、封禁和结果未知不能盲目重发。
        if (
          response.status === 400 &&
          (!response.payload?.description ||
            /parse|entities|markdown/i.test(response.payload.description))
        )
          response = await send(false);
        if (!response.ok || response.payload?.ok !== true) {
          throw Object.assign(
            new Error(
              `Telegram send failed (${response.payload?.error_code ?? response.status}): ${response.payload?.description ?? "unknown delivery result"}`,
            ),
            {
              deliveryRejected: response.payload?.ok === false,
              retryAfter: response.payload?.parameters?.retry_after,
            },
          );
        }
      }
    },

    // typing 没有"停止"接口，Telegram 侧约 5s 自动消失，因此这里只在调用时发一次，
    // 由上层按间隔重复调用；token 缺失时静默返回而不是抛错（INV-07 不支持即降级）。
    // 注意：sendChatAction 的失败会向上抛，是否忽略由调用方的 typing 调度决定。
    async sendTyping(bot: BotConfig, target) {
      const token = await loadToken(bot);
      if (!token?.trim()) {
        return;
      }
      await fetchBotProvider(`https://api.telegram.org/bot${token}/sendChatAction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: target.providerUserId,
          action: "typing",
        }),
      });
    },

    // 回调 ACK。Telegram 要求点击后尽快 answerCallbackQuery，否则客户端一直转圈；
    // 因此即使后面业务失败，也必须先把 ACK 发出去。_message 参数是协议占位（其他渠道用来
    // 覆盖共享卡片），Telegram 不需要，故不读取。
    // 第二步 editMessageReplyMarkup 清空按钮：只在有 toast 文本时做，表示"这次交互已有结论"，
    // 防止同一条卡片被继续点击；失败被吞掉，因为按钮残留不影响本次结果（重试点击会被幂等层拦住）。
    async acknowledgeCallback(
      bot: BotConfig,
      payload: unknown,
      text?: string,
      _message?: BotOutboundMessage,
      signal?: AbortSignal,
    ) {
      const token = await loadToken(bot);
      const callbackQueryId = readTelegramCallbackId(payload);
      if (!token?.trim() || !callbackQueryId) {
        return;
      }
      await fetchBotProvider(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          ...(text?.trim() ? { text: truncateCallbackToast(text) } : {}),
        }),
      });
      const messageRef = readTelegramCallbackMessageRef(payload);
      if (messageRef && text?.trim()) {
        await fetchBotProvider(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal,
          body: JSON.stringify({
            chat_id: messageRef.chatId,
            message_id: messageRef.messageId,
            reply_markup: { inline_keyboard: [] },
          }),
        }).catch(() => undefined);
      }
    },

    // 附件下载：先用 file_id 换 file_path，再从 /file/bot<token>/<file_path> 拉字节。
    // 资源与失败口径：
    // - 用一个 AbortController 覆盖两步，30s 是总预算而不是每步各 30s，避免"两段都慢"时翻倍。
    // - 两个响应都校验 HTTP 状态；getFile 还要求 payload.ok === true 且 file_path 非空，
    //   否则拼出的下载 URL 会指向 404，错误更难定位。
    // - 返回前用 Telegram 报的 file_size 覆盖 sizeBytes（更可信），但真实字节数以上层为准；
    //   本函数不做大小截断，超限由 botsService 在落盘前拒绝（INV-04）。
    // - 任一环节失败抛错，绝不返回半截数据；token/fileId 缺失返回 null 表示"无从下载"。
    // - AbortError 统一改写成稳定文案，避免上层依赖底层 fetch 的错误形态。
    // [资源] finally 必清 timeout，任何分支（含 catch 抛错）都不会泄漏定时器（INV-12）。
    // file_path 由 Telegram 返回，直接拼到固定的 /file/bot 前缀后面：
    // 域名是常量，远端只能控制路径部分，不能把请求导向任意主机（INV-09）。
    // sizeBytes 覆盖只改展示值，不改 data 长度；上层必须按字节数再判一次上限。
    async downloadAttachment(bot, attachment) {
      const token = await loadToken(bot);
      if (!token?.trim() || !attachment.providerFileId) {
        return null;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TELEGRAM_ATTACHMENT_DOWNLOAD_TIMEOUT_MS);
      try {
        const fileResponse = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file_id: attachment.providerFileId }),
          signal: controller.signal,
        });
        if (!fileResponse.ok) {
          throw new Error(`Telegram getFile failed: HTTP ${fileResponse.status}`);
        }
        const filePayload = (await fileResponse.json()) as TelegramFileResponse;
        const filePath = filePayload.result?.file_path;
        if (filePayload.ok !== true || !filePath) {
          throw new Error(filePayload.description ?? "Telegram getFile did not return file_path.");
        }
        const response = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Telegram file download failed: HTTP ${response.status}`);
        }
        return {
          attachment: {
            ...attachment,
            ...(typeof filePayload.result?.file_size === "number"
              ? { sizeBytes: filePayload.result.file_size }
              : {}),
          },
          data: new Uint8Array(await response.arrayBuffer()),
        };
      } catch (error) {
        if ((error as { name?: unknown })?.name === "AbortError") {
          // Bugfix: Telegram 文件接口卡住时要快速失败，避免 bot 回调一直没有可见结果。
          throw new Error("Telegram file download timed out.");
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },

    // 入站统一入口：payload 既可能是 {botId, update}，也可能已是裸 update。
    // botId 必填且只从 payload 取：它决定消息归属哪个 bot 配置，缺失时宁可丢弃整条
    // update（返回 []），也不允许用 Telegram update 内容反推，否则跨 bot 串消息（INV-01）。
    // 普通消息优先于按钮回调：一条 update 只会命中其一，顺序只影响可读性。
    // 返回 [] 是合法结果（未知 update 类型），上层只记 debug、不报错。
    // 已知不支持的形态：edited_message / channel_post / my_chat_member 等。
    // 它们要么没有可回复的正文，要么会与"新消息"语义混淆，宁可丢弃也不误触发任务。
    // 这里不消费 update_id：offset 的推进由 telegramChannelRuntime 负责，
    // 若适配器也维护去重游标，两处游标会各自推进并互相覆盖。
    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      const botId = typeof payload.botId === "string" ? payload.botId : "";
      const update = isRecord(payload.update) ? payload.update : payload;
      if (!botId) {
        return [];
      }
      const message =
        readTelegramPrivateMessage(botId, update) ?? readTelegramCallbackMessage(botId, update);
      return message ? [message] : [];
    },
  };
}
