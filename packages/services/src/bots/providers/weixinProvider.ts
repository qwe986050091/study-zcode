/* eslint-disable max-lines -- 微信 iLink provider 集中处理轮询、文本/媒体解析、发送和 typing 协议。 */
// 微信 iLink 渠道适配器（L1 深度注释）。
// 边界：只做 iLink HTTP 协议 <-> 统一 BotInboundMessage/BotOutboundMessage 的翻译；
// 授权、ownership、入站去重与落库、重试节奏全部在 botsService / weixinChannelRuntime（INV-01、INV-10）。
//
// 本文件维持/依赖的不变量（新增项用 INV-WX 前缀，避免与全批表编号冲突）：
// INV-02：发送成功 = HTTP 2xx 且 ret/errcode 同时为 0；由 requestWeixinJson 统一裁决。
// INV-03：message_id 缺失时返回 undefined 交给上层 fail-open，绝不伪造 id（readWeixinMessageId）。
// INV-04：附件必须同时有 downloadUrl 与 aesKey 才下载；缺任一项返回 null，绝不上交密文。
// INV-08：token 只经 loadCredential 读取，只进 Authorization 头，不写日志、不进错误消息。
// INV-10：本文件不重试；一次请求一次结果，失败抛错由 runtime 退避。
// INV-12：不持有定时器/连接；信号只透传给 fetch，停止由调用方的 AbortSignal 表达。
// INV-WX01：响应无新游标时沿用入参 buf，绝不清空，否则服务端会整段重放历史消息。
//
// 出站协议映射：message_type=2 表示 bot 消息，message_state=2 则必须表示已完成的终态消息，
// item_list[].type=1 表示 text_item。三个字面量改动会直接改变服务端语义。
import { Buffer } from "node:buffer";
import { createDecipheriv, randomInt, randomUUID } from "node:crypto";
import type {
  BotInboundAttachment,
  BotConfig,
  BotInboundMessage,
  BotOutboundMessage,
} from "@zcode/shared";
import type { BotProviderAdapter, BotTypingTarget } from "./types.js";
// 统一请求封装负责超时、响应体消费与 abort 传播；本文件不直接碰 fetch（下载路径除外）。
import { fetchBotProviderJson } from "#src/bots/providers/providerRequest.js";

// 内置 iLink 网关地址。导出给 weixinRegistration 复用，两个链路的域名只允许在这里定义。
export const DEFAULT_WEIXIN_ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
// bot API 公共前缀。注册文件里有一份同名副本，两处漂移会表现为“扫码成功但轮询 404”。
const WEIXIN_BOT_API_PREFIX = "/ilink/bot";
// 能力协商版本：服务端按它决定返回的字段形状（例如 item_list 结构），不是展示用 UA。
const WEIXIN_CHANNEL_VERSION = "2.0.0";
// 出站消息类型：2 = bot 发出。与入站过滤处的字面量 2 同义，必须同步修改。
const WEIXIN_MESSAGE_TYPE_BOT = 2;
// 消息状态：2 = 一次成型的终态消息。缺省会让服务端把消息当草稿挂起，不投递给用户。
const WEIXIN_MESSAGE_STATE_FINISH = 2;
// iLink CDN 媒体加密方式。密钥固定 16 字节；换成 CBC 需要 IV，而协议不下发 IV。
const WEIXIN_CDN_AES_ALGORITHM = "aes-128-ecb";
// 长轮询超时。空闲时服务端会挂起请求几十秒，默认 15s 会把正常等待误判为失败。
const WEIXIN_GET_UPDATES_TIMEOUT_MS = 90_000;

// 依赖注入面刻意只暴露凭据读取：便于单测替换来源，也避免 adapter 产生日志副作用。
interface WeixinProviderDeps {
  loadCredential(key: string): Promise<string | null>;
}

// getupdates 返回口径：messages 可直接投递；rawMessageCount/rawMessageDiagnostics 只用于
// 上层 debug 定位“raw>0 但 parsed=0”的丢消息；buf 是下一轮游标，undefined 表示未推进。
interface WeixinGetUpdatesResult {
  messages: BotInboundMessage[];
  rawMessageDiagnostics?: string[];
  rawMessageCount?: number;
  buf?: string;
}

// getconfig 的最小响应形状：只建模 typing_ticket，其余字段保持 unknown，
// 避免把 contact/self/profile 这类联系人资料引入类型后被顺手写进日志。
interface WeixinTestResponse {
  contact?: unknown;
  self?: unknown;
  profile?: unknown;
  ret?: number;
  typing_ticket?: string;
}

// 外部数据的一律先过这里再做字段读取，禁止对 payload 直接 as 断言。
// 数组也是 object，必须显式排除，否则数组会伪装成结构化消息对象。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 字符串字段口径：类型不符一律回落 ""，这样调用方的 `a || b` 别名链不会被 undefined 短路。
// 代价是“字段缺失”与“字段存在但类型错”不可区分；需要区分的场景改用 readNumber。
function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

// 数值字段口径：只接受有限数。NaN/Infinity 会破坏大小计算与 JSON 序列化，一律视为缺失。
function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// 兼容 number/string 双形态。统一成 string 是为了让去重键类型稳定：
// 超过 2^53 的数字 id 在 number 形态下已丢精度，比较时会漏判重复。
function readNumberOrString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  // 字符串原样返回而不 trim：去重键要保留服务端原值，trim 会把带空格 id 与正常 id 合并。
  if (typeof value === "string") {
    return value;
  }
  // 数字统一 String 化且不做补零；同一解析结果内比较稳定，跨进程也不受 number 精度影响。
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

// AES 密钥口径：iLink 下发的 aes_key 有三种真实形态，必须全部接受，
// 否则同一张图在不同版本上会一半能看一半解密失败：
// 1) 32 位 hex 明文；2) base64 解码后正好 16 字节的二进制密钥；
// 3) base64 解码后是 32 位 hex 文本（把 hex 当字符串又做了一次 base64）。
// 顺序不可颠倒：32 位 hex 本身也是合法 base64 字符集，先解 base64 会把 hex 解成 24 字节垃圾。
// 全部失败返回 null 而不是空 Buffer：全零密钥会让 ECB “成功”解出乱码，把错误推迟到落盘之后。
function parseWeixinAesKey(value: string): Buffer | null {
  // 先 trim 掉 base64 里常见的换行与空格；带换行的密钥会让 Buffer.from 解出 0 字节。
  const trimmed = value.trim();
  // 32 位 hex 必须先于 base64 判定：hex 字符集同时是合法 base64，先解会得到 24 字节垃圾。
  if (/^[a-f0-9]{32}$/iu.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 16) {
      return decoded;
    }
    // base64 解出来可能仍是 32 位 hex 文本；转成 utf8 后再复用同一条 hex 判定。
    const decodedText = decoded.toString("utf8").trim();
    if (/^[a-f0-9]{32}$/iu.test(decodedText)) {
      return Buffer.from(decodedText, "hex");
    }
  } catch {
    return null;
  }
  return null;
}

// 解密单块 CDN 媒体。ECB 无 IV，Node 的 Decipher 会对最后一块做 PKCS7 去填充，
// 因此必须一次性拿到完整密文，无法边下边解。
// [失败路径] 密钥错、密文截断、padding 非法都会在 final() 抛错并向上传播：
// 上层按 INV-04 丢弃整块附件，绝不允许把半截明文交给落盘层。
// [权衡] ECB 不提供完整性校验，密文改一位不会报错、只会得到错误明文；
// 所以“解密成功”不等于“内容可信”，magic bytes/MIME 校验责任在下游。
function decryptWeixinCdnMedia(data: Uint8Array, aesKey: string): Uint8Array {
  const key = parseWeixinAesKey(aesKey);
  if (!key) {
    throw new Error("Weixin attachment AES key is invalid.");
  }
  // 微信 iLink CDN 返回 AES-128-ECB + PKCS7 padding 的密文字节；直接保存会得到不可识别的 data 文件。
  // ECB 模式第三参必须传 null；传空 Buffer 会让 Node 抛 IV length 错误而不是走无 IV 分支。
  const decipher = createDecipheriv(WEIXIN_CDN_AES_ALGORITHM, key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

// 域名由常量派生而不是读 bot 配置：登录、轮询、发送必须指向同一网关。
// 读 bot.webhookUrl 会把出站回执地址当成 API 主机，表现为发送全部 404。
function getWeixinApiBaseUrl(): string {
  // 微信 iLink 是内置通道地址，不应复用 webhookUrl，否则旧配置会把出站 Webhook 当成微信 API。
  return DEFAULT_WEIXIN_ILINK_BASE_URL.replace(/\/+$/u, "");
}

// INV-08：token 只从 credentialRef 指向的 secret 现读现用，本文件不做任何缓存。
// 不缓存的直接收益：解绑或换绑后下一轮轮询立即用新 token，不会继续消费旧账号的消息；
// 缓存则必须额外处理过期与并发刷新，漏一处就是“换绑后仍收到旧账号消息”的幽灵问题。
// [失败路径] credentialRef 缺失返回 null，交给 requestWeixinJson 统一转成可读错误。
async function readAccessToken(bot: BotConfig, deps: WeixinProviderDeps): Promise<string | null> {
  return bot.credentialRef ? deps.loadCredential(bot.credentialRef) : null;
}

// X-WECHAT-UIN 要求“十进制数字的 base64 文本”，不是随机二进制；
// 服务端只用 X-WECHAT-UIN 区分客户端实例，不参与鉴权，所以每次请求重新随机即可。
// [权衡] 不做进程内固定值：固定能省一次随机调用，但多窗口会看起来是同一客户端。
function buildRandomWechatUin(): string {
  return Buffer.from(String(randomInt(0, 0x1_0000_0000)), "utf8").toString("base64");
}

// 鉴权头口径：AuthorizationType 必须是字面量 ilink_bot_token，Bearer 前缀不可省。
// 缺任一项服务端只回 401/ret 非 0，不会指出缺哪一项，因此这两行不允许被“简化”。
// [资源] 每次重新构造：headers 里含 token，不进入任何长生命周期对象，避免闭包持有过期凭据。
function buildHeaders(token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    // 服务端只认这个字面量；写成 Bearer 或整项省略都会得到 401 且不说明缺哪项。
    AuthorizationType: "ilink_bot_token",
    // Bearer 前缀不可省：token 本身不带 scheme，服务端按整串校验。
    Authorization: `Bearer ${token}`,
    "X-WECHAT-UIN": buildRandomWechatUin(),
  };
}

// base_info.channel_version 是能力协商字段，每个请求体都必须带。
// 展开顺序让 ...body 覆盖默认值：未来需要降级版本时，以调用方显式传入的 base_info 为准。
// 非对象 body 原样返回，让异常入参由服务端报错，而不是在这里被静默改写成 {}。
function appendBaseInfo(body: unknown): unknown {
  if (!isRecord(body)) {
    return body;
  }
  return {
    // 每个请求体都必须带 channel_version，服务端据此决定响应字段形状。
    base_info: { channel_version: WEIXIN_CHANNEL_VERSION },
    // 展开放在 base_info 之后，调用方显式传入的 base_info 才能覆盖默认版本。
    ...body,
  };
}

// 所有 iLink 调用的唯一出口：拼 URL、注入凭据、合并 base_info、裁决错误。
// 输入：path 为 /ilink/bot 之后的部分；body 缺省发 {}（服务端不接受空 body）；
//   timeoutMs 由调用方决定——getupdates 需要 90s，其余沿用统一封装的 15s。
// 输出：解析后的 JSON 原样返回，调用方需要 data 时自行解包。
// [失败路径] token 缺失、HTTP 非 2xx、ret/errcode 非 0 一律必须 throw，错误消息只含 path 与服务端文案。
//   abort 的 reason 不做包装：runtime 靠 signal.aborted 区分“主动停止”和“真失败”。
// INV-02：HTTP 200 + ret!=0 必须当失败，否则上层会把未投递的消息记成已投递。
async function requestWeixinJson(
  bot: BotConfig,
  deps: WeixinProviderDeps,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<unknown> {
  // 先取凭据再建连接：没有 token 时不发注定 401 的请求，也避免把网络错误与鉴权错误混在一起。
  // 先取 token 再建连接；没有 token 时不发注定 401 的请求，鉴权错误与网络错误也能分开。
  const token = await readAccessToken(bot, deps);
  if (!token?.trim()) {
    throw new Error("Weixin iLink bot token is missing. Scan the Weixin login QR code first.");
  }
  const response = await fetchBotProviderJson<unknown>(
    `${getWeixinApiBaseUrl()}${WEIXIN_BOT_API_PREFIX}${path}`,
    {
      method: "POST",
      headers: buildHeaders(token.trim()),
      body: JSON.stringify(appendBaseInfo(body ?? {})),
      signal,
    },
    timeoutMs,
  );
  if (!response.ok) {
    // 只报 HTTP status 状态码，不回显响应体：错误体可能包含服务端诊断里的请求参数。
    throw new Error(`Weixin iLink ${path} failed: HTTP ${response.status}`);
  }
  // payload 已是解析后的 JSON；这里再判 isRecord，防止代理返回 HTML 时读字段抛错。
  const payload = response.payload;
  const data = isRecord(payload) ? payload : null;
  const ret = readNumber(data, "ret");
  const errcode = readNumber(data, "errcode");
  // 双口径判定：不同接口分别用 ret 与 errcode，任一存在且非 0 即失败；
  // 两者都缺失说明响应不是协议对象（如代理返回的 HTML），此时交由字段读取处回落到“无消息”。
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    // 文案优先 errmsg，其次 message，最后用两个错误码拼出可定位的兜底串（不含 token）。
    const message = readString(data, "errmsg") || readString(data, "message") || `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim();
    throw new Error(`Weixin iLink ${path} failed: ${message}`);
  }
  // 本函数不做任何重试：这里的异常由 runtime 统一按退避节奏重试，
  // adapter 内重发会让两次 sendmessage 携带不同 client_id，服务端当成两条消息。
  // 非对象原样返回；下游 isRecord 会再兜一次，不需要在这里预转成空对象。
  return payload;
}

// 兼容两种包裹：{data:{...}} 与扁平 {...}。
// 用 "in" 而不是真值判断，是为了区分“没有 data 字段”和“data: null”。
// [失败路径] data 显式为 null 时会退化成 {}，同层 msgs 也随之丢失；
// 这是协议兼容的已知代价，出现时只能在诊断日志里表现为 raw=0。
function unwrapData(payload: unknown): unknown {
  if (!isRecord(payload)) {
    // 没有 data 包裹时返回扁平 payload；iLink 多数接口是这种形态。
    return payload;
  }
  // 用 in 而不是真值判断，才能区分无 data 字段与 data 为 null 两种响应。
  if ("data" in payload) {
    return payload.data;
  }
  return payload;
}

// 把任意 payload 收敛成可读字段的容器，下游不必重复判空。
// 注意它不处理顶层数组：消息列表一定在容器字段（msgs/messages/...）里。
function readMessagesContainer(payload: unknown): Record<string, unknown> {
  const data = unwrapData(payload);
  return isRecord(data) ? data : {};
}

// 文本项口径：优先 text_item.text（协议主字段），再回落到把 item 自身当文本容器。
// text_item 存在但 text 为空时继续回落，因为部分版本会用空 text_item 当占位项。
function readWeixinTextItem(item: unknown): string {
  if (!isRecord(item)) {
    return "";
  }
  // text_item 不是对象时置 null，避免对字符串索引 .text 得到 undefined 后继续误判。
  const textItem = isRecord(item.text_item) ? item.text_item : null;
  // 三级回落顺序就是协议优先级：内层 text_item.text 最权威，content 只作最后兜底。
  return readString(textItem, "text") || readString(item, "text") || readString(item, "content");
}

// 类型判定顺序：结构化字段（image_item）优先于启发式字符串匹配，
// 否则文件名里带 "image" 的普通文件会被误判成图片。
// 后缀表必须含 svg：公众号常把矢量图当普通文件上传，缺 mime 时只能看后缀。
function inferWeixinAttachmentKind(item: Record<string, unknown>): BotInboundAttachment["kind"] {
  if (isRecord(item.image_item)) {
    return "image";
  }
  // 显式 kind/media_type 优先于文件名启发式；否则名字带 image 的普通文件会被当图片。
  const explicit = readString(item, "kind") || readString(item, "media_type") || readString(item, "mediaType") || readString(item, "type_name");
  const mimeType = readString(item, "mime_type") || readString(item, "mimeType");
  const filename = readString(item, "filename") || readString(item, "file_name") || readString(item, "name");
  // 三类半信息拼在一起再匹配：只有 mime、只有文件名、只有 kind 三种形态都能覆盖。
  const normalized = `${explicit} ${mimeType} ${filename}`.toLowerCase();
  if (normalized.includes("image") || normalized.includes("photo") || normalized.includes("picture") || /\.(svg|png|jpe?g|gif|webp|heic|bmp)$/iu.test(filename)) {
    return "image";
  }
  if (normalized.includes("audio") || normalized.includes("voice")) {
    // audio 与 voice 同义；iLink 语音消息两种字段值都出现过。
    return "audio";
  }
  if (normalized.includes("video")) {
    return "video";
  }
  // 无任何线索时落到 file，而不是猜 image：误判成图片会让下游按图片预览并直接失败。
  return "file";
}

// 把一个 item_list 元素翻译成统一附件；null 表示“本来就不是附件”或“信息不足无法下载”。
// 过滤文本项：item_list 中文本与媒体混排，文本已由 readWeixinText 汇总，这里再算一次会重复。
// media 展开：iLink 的 image_item.media 既可能是数字 id，也会是带 full_url/aes_key/len 的对象，
// 展开后统一按同名字段读取，调用方无需区分 media 的两种形态。
// 标识/下载地址/内联数据三者有任一即可；全无说明这条 item 只是装饰（如撤回占位），返回 null。
function readWeixinAttachmentItem(item: unknown, index: number): BotInboundAttachment | null {
  if (!isRecord(item)) {
    return null;
  }
  // 文本项在 item_list 里与媒体混排，已由 readWeixinText 汇总，再算一次会重复。
  if (readWeixinTextItem(item)) {
    return null;
  }
  const media =
    isRecord(item.image_item) ? item.image_item :
      isRecord(item.file_item) ? item.file_item :
        isRecord(item.video_item) ? item.video_item :
          isRecord(item.audio_item) ? item.audio_item :
            isRecord(item.media_item) ? item.media_item :
              item;
  // 嵌套 media 只接受对象；数字 media 是 id 形态，不能当容器展开。
  const mediaPayload = isRecord(media.media) ? media.media : null;
  // 内存合并顺序 [...media, ...mediaPayload]：嵌套 media 覆盖外层同名字段。
  // 反序会让 image_item.aeskey（外层旧密钥）盖掉 media.aes_key（实际加密密钥），解密必然失败。
  // 内层覆盖外层：media.aes_key 才是实际密钥，外层 aeskey 可能已被替换成旧值。
  const mediaSource = mediaPayload ? { ...media, ...mediaPayload } : media;
  const providerFileId =
    readNumberOrString(mediaSource, "file_id") ||
    readNumberOrString(mediaSource, "fileId") ||
    readNumberOrString(mediaSource, "media_id") ||
    readNumberOrString(mediaSource, "mediaId") ||
    readNumberOrString(mediaSource, "id") ||
    readNumberOrString(mediaSource, "encrypt_query_param") ||
    readNumberOrString(mediaSource, "encryptQueryParam") ||
    // 微信图片消息的 image_item 只返回 media 字段，没有 file_id/md5；这里将 media 作为后续下载和去重的资源标识。
    // image_item 只有 media 字段时用它作资源标识；缺它会让图片既不能去重也不能下载。
    readNumberOrString(mediaSource, "media") ||
    readNumberOrString(mediaSource, "md5");
  const downloadUrl =
    readString(mediaSource, "url") ||
    readString(mediaSource, "download_url") ||
    readString(mediaSource, "downloadUrl") ||
    // 微信 image_item.media 内的 full_url 是实际图片下载地址，旧逻辑只读 url/download_url 会把纯图片消息丢掉。
    // full_url 是图片消息的实际下载地址；只读 url 会把纯图片消息丢掉。
    readString(mediaSource, "full_url") ||
    readString(mediaSource, "fullUrl");
  // 内联 base64 与 URL 是并列来源；三者全无的 item 只是装饰，返回 null 更诚实。
  const dataBase64 =
    readString(mediaSource, "data_base64") ||
    readString(mediaSource, "dataBase64") ||
    readString(mediaSource, "base64");
  // data_base64 是服务端把内容内联进消息的形态（小图/表情）：存在时无需再下载，
  // 上层可直接用内存数据落盘，所以它和 file_id、url 一样是独立的可投递条件。
  // 三者全无只能说明这条 item 没有可用媒体句柄，返回 null 比返回一个必然下载失败的附件更好。
  // providerFileId/downloadUrl/dataBase64 全空才返回 null；任一项存在下游就能取到字节。
  if (!providerFileId && !downloadUrl && !dataBase64) {
    return null;
  }
  // 合并后再推断：kind 可能来自外层 item，也可能只在 media 内层下发。
  const kind = inferWeixinAttachmentKind({ ...item, ...mediaSource });
  // 缺名时按 kind 生成稳定默认名，同一消息多个附件用 index 保证不重名。
  const filename =
    readString(mediaSource, "filename") ||
    readString(mediaSource, "file_name") ||
    readString(mediaSource, "name") ||
    // 缺名时给稳定默认名：文件名参与落盘与扩展名推断；index 保证同消息多附件不重名。
    // 这里只“生成”名字，真正净化必须在落盘侧完成（INV-09）。
    (kind === "image" ? `weixin-image-${index + 1}.jpg` : `weixin-attachment-${index + 1}`);
  const mimeType =
    readString(mediaSource, "mime_type") ||
    readString(mediaSource, "mimeType") ||
    inferMimeTypeFromFilename(filename) ||
    (kind === "image" ? "image/jpeg" : kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "application/octet-stream");
  // size 系列四个别名，mid_size 是图片实际大小；thumb_size 只是缩略图体积。
  const sizeBytes =
    readNumber(mediaSource, "size") ??
    readNumber(mediaSource, "sizeBytes") ??
    readNumber(mediaSource, "file_size") ??
    readNumber(mediaSource, "len") ??
    // image_item 没有通用 size 字段，mid_size 是实际图片资源大小，thumb_size 只用于缩略图预览。
    readNumber(mediaSource, "mid_size");
  const aesKey =
    readString(mediaSource, "aes_key") ||
    readString(mediaSource, "aesKey") ||
    readString(mediaSource, "aeskey");
  // 条件展开而不是显式赋 undefined：可选字段不产生 undefined 键，
  // 避免下游用 "providerMetadata" in attachment 之类的存在性判断被误导。
  return {
    id: providerFileId || downloadUrl || `weixin-${index + 1}`,
    kind,
    filename,
    mimeType,
    ...(sizeBytes ? { sizeBytes } : {}),
    ...(providerFileId ? { providerFileId } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    // 密钥只放进 providerMetadata 的固定键；下载阶段靠 weixinAesKey 取值。
    ...(aesKey ? { providerMetadata: { weixinAesKey: aesKey } } : {}),
  };
}

// 只覆盖图片后缀：其他类型要么自带 mime 字段，要么统一 application/octet-stream。
// 在这里穷举会把“猜错 mime”引成下游预览失败，收益为负。
function inferMimeTypeFromFilename(filename: string): string {
  // svg 必须先判：它的后缀不会被后续 png/jpeg 规则命中，顺序写反会漏掉矢量图。
  if (/\.svg$/iu.test(filename)) {
    return "image/svg+xml";
  }
  if (/\.png$/iu.test(filename)) {
    return "image/png";
  }
  // jpe?g 同时覆盖 .jpg 与 .jpeg；拆成两条容易漏掉其中一个常见后缀。
  if (/\.jpe?g$/iu.test(filename)) {
    return "image/jpeg";
  }
  if (/\.gif$/iu.test(filename)) {
    return "image/gif";
  }
  if (/\.webp$/iu.test(filename)) {
    // webp 不在 iLink 默认推导里但公众号图片常见；显式列出避免回落成 octet-stream。
    return "image/webp";
  }
  return "";
}

// 第二条附件入口：轮询链路把已解析附件重新包成 id/kind/attachments 结构回灌给
// parseCallback，这里负责原样还原，保证附件不因二次解析而丢失。
// kind 必须在白名单内：非法值返回 null，防止下游按未知 kind 走错渲染分支。
// providerMetadata 只保留 string 值：它是把 weixinAesKey 透传到下载阶段的载体，
// 数字/对象无法参与解密，保留只会污染类型。
function readWeixinDirectAttachment(
  item: unknown,
  index: number,
): BotInboundAttachment | null {
  if (!isRecord(item)) {
    return null;
  }
  // kind 必须是字符串才进白名单；数字或对象直接判非法，不做 stringify 兜底。
  const kind = readString(item, "kind");
  if (
    kind !== "image" &&
    kind !== "audio" &&
    kind !== "video" &&
    kind !== "file"
  ) {
    return null;
  }
  // id 缺失时用 index 合成占位值；它只在同条消息内区分附件，绝不参与去重。
  const id = readString(item, "id") || `weixin-${index + 1}`;
  const filename = readString(item, "filename") || `${id}.${kind}`;
  const mimeType =
    // mimeType 与 mime_type 两种拼写都接受；回灌结构来自上层，两种历史写法都存在。
    readString(item, "mimeType") ||
    readString(item, "mime_type") ||
    (kind === "image" ? "image/jpeg" : kind === "audio" ? "audio/mpeg" : kind === "video" ? "video/mp4" : "application/octet-stream");
  // size 是旧字段名；用 ?? 而不是 ||，尺寸为 0 时也要保留原值。
  const sizeBytes = readNumber(item, "sizeBytes") ?? readNumber(item, "size");
  // providerFileId 是统一字段，file_id 是 iLink 原始名；两者都缺时该附件无法再下载。
  const providerFileId = readString(item, "providerFileId") || readString(item, "file_id");
  // 下载地址与 dataBase64 至少有一个；两者皆无时下游无从取得字节。
  const downloadUrl = readString(item, "downloadUrl") || readString(item, "download_url");
  // 内联数据与 URL 的取舍由上层决定，本文件只搬运，不提前解码。
  const dataBase64 = readString(item, "dataBase64") || readString(item, "data_base64");
  // providerMetadata 必须是对象才处理；数组或字符串会让 Object.entries 产出下标键。
  const providerMetadata = isRecord(item.providerMetadata)
    ? Object.fromEntries(
      Object.entries(item.providerMetadata)
        // 只保留 string 值：weixinAesKey 是字符串，数字或对象无法参与 createDecipheriv。
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    )
    : null;
  return {
    id,
    kind,
    filename,
    mimeType,
    // 与 readWeixinAttachmentItem 同口径：null 表示“字段不存在”，不写进对象。
    // null 表示字段不存在而不是 0；写成真值判断会把合法 size 0 一起吞掉。
    ...(sizeBytes !== null ? { sizeBytes } : {}),
    ...(providerFileId ? { providerFileId } : {}),
    ...(downloadUrl ? { downloadUrl } : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(providerMetadata && Object.keys(providerMetadata).length > 0 ? { providerMetadata } : {}),
  };
}

// 正文汇总：顶层 text/content/message 可用就立即返回；否则按顺序把 item_list 的文本项
// 用 \n 拼接（多段文本本身就是一条消息）；最后才看 inner.text，避免包装层覆盖正文。
// 注意 `message` 既可能是字符串正文也可能是 msg 包装对象，两者分别由 readString 与 isRecord 判定。
function readWeixinText(message: Record<string, unknown>): string {
  const text = readString(message, "text") || readString(message, "content") || readString(message, "message");
  // 顶层命中正文即返回，不再看 item_list；否则同一段文字会被汇总两次。
  if (text) {
    return text;
  }
  const inner = isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
  const itemList = Array.isArray(message.item_list) ? message.item_list : Array.isArray(inner?.item_list) ? inner.item_list : [];
  // 多段文本按换行拼成一条消息；join 之前用 filter(Boolean) 去掉空占位项。
  return itemList.map(readWeixinTextItem).filter(Boolean).join("\n") || readString(inner, "text") || readString(inner, "content");
}

// 两类来源合并：item_list（iLink 原生）在前，attachments（回灌的统一结构）在后。
// [权衡] 两个列表的 index 各自从 0 开始，缺 providerFileId 时生成的 weixin-N 可能撞名；
// 真实 iLink 附件几乎总带 media/md5，撞名只会出现在回灌路径，上层按数组顺序消费。
function readWeixinAttachments(message: Record<string, unknown>): BotInboundAttachment[] {
  const inner = isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
  const itemList = Array.isArray(message.item_list) ? message.item_list : Array.isArray(inner?.item_list) ? inner.item_list : [];
  // 回灌路径的 attachments 与 item_list 并列读取；漏掉任一来源都会丢图或丢文件。
  const directAttachments = Array.isArray(message.attachments)
    ? message.attachments
    : Array.isArray(inner?.attachments)
      ? inner.attachments
      : [];
  return [
    // 原生 item_list 先入数组，回灌附件后追加；顺序决定下游展示顺序，不能交换。
    ...itemList
    .map((item, index) => readWeixinAttachmentItem(item, index))
    // 类型守卫过滤 null；地图后判空会让下游拿到 null 附件并解引用崩溃。
    .filter((attachment): attachment is BotInboundAttachment => attachment !== null),
    // 回灌下标从 0 重算，缺 providerFileId 时可能与 item_list 的 weixin-N 撞名。
    ...directAttachments
      .map((item, index) => readWeixinDirectAttachment(item, index))
      .filter((attachment): attachment is BotInboundAttachment => attachment !== null),
  ];
}

// 发送者身份是 ownership 判定的唯一来源，尽量取到；返回 "" 时 buildInboundMessage 会整条丢弃，
// 绝不把不明来源的消息记到别的用户名下（INV-01）。
// 兼容 from/sender 两种嵌套：不同 iLink 版本把 wxid 放在不同层级。
function readWeixinUserId(message: Record<string, unknown>): string {
  // from/sender 两套嵌套都取，因为不同 iLink 版本把 wxid 放在不同层级。
  const from = isRecord(message.from) ? message.from : null;
  const sender = isRecord(message.sender) ? message.sender : null;
  return (
    // from_user_id 优先：它是入站事件里唯一明确标注发送者的字段。
    readString(message, "from_user_id") ||
    readString(message, "from") ||
    readString(message, "from_user") ||
    readString(message, "fromUser") ||
    readString(message, "user") ||
    readString(message, "user_id") ||
    readString(message, "userId") ||
    readString(from, "id") ||
    // wxid 是微信侧稳定账号标识；id 可能是会话内临时值，换会话就变。
    readString(from, "wxid") ||
    readString(sender, "id") ||
    readString(sender, "wxid")
  );
}

// room 系列字段存在即群聊；私聊返回 undefined 而不是 ""，让 chatType 的真值判断成立，
// 同时保持 BotActor.chatId 缺省，避免下游把空串当有效会话 id。
function readWeixinChatId(message: Record<string, unknown>): string | undefined {
  return (
    // room 存在即群聊；该字段同时用作群会话 id，不能只当布尔标记。
    readString(message, "room") ||
    readString(message, "room_id") ||
    readString(message, "roomId") ||
    readString(message, "chat") ||
    readString(message, "chat_id") ||
    // chatId 别名放最后，前面的 room 系列才是 iLink 原始字段。
    readString(message, "chatId") ||
    undefined
  );
}

// 仅用于展示：缺失返回 undefined 而不是空串，让上层回落到 providerUserId。
function readWeixinDisplayName(message: Record<string, unknown>): string | undefined {
  // 展示名同样兼容 from/sender 嵌套；这里缺失只影响显示，不影响路由。
  const from = isRecord(message.from) ? message.from : null;
  const sender = isRecord(message.sender) ? message.sender : null;
  const inner = isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
  return (
    readString(message, "name") ||
    readString(message, "displayName") ||
    // 昵称在不同客户端有 name/nickname 两种叫法，都试一次成本最低。
    readString(message, "nickname") ||
    readString(from, "name") ||
    readString(from, "nickname") ||
    readString(sender, "name") ||
    readString(sender, "nickname") ||
    // 群消息常把发送者昵称放在 msg 内层，外层只剩群 id。
    readString(inner, "sender_name") ||
    undefined
  );
}

// 去重键口径（INV-03）：字符串形态优先，避免大整数在 number 形态下丢精度；
// 顶层找不到再看 msg/message 内层，iLink 经常把 message_id 放在内层。
// 全部缺失返回 undefined —— 绝不用随机值或时间戳伪造，否则同一消息每轮都是新 id，去重完全失效。
// [失败路径] 数字型 id 走最后的 readNumber 兜底并转 string，保证返回值类型始终是 string。
function readWeixinMessageId(message: Record<string, unknown>): string | undefined {
  const inner = isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
  // messageId 别名链只用字符串口径；这一步不读 number，避免大整数在拼接前丢精度。
  const messageId =
    readString(message, "id") ||
    readString(message, "msgid") ||
    readString(message, "msgId") ||
    // message_id 可能以数字下发，用 readNumberOrString 转成字符串后再比较。
    readNumberOrString(message, "message_id") ||
    readString(inner, "id") ||
    readString(inner, "msgid") ||
    readString(inner, "msgId") ||
    readNumberOrString(inner, "message_id");
  // 非空即返回；空串继续走数字兜底，避免把空串当有效去重键。
  if (messageId) {
    return messageId;
  }
  // 字符串别名全落空后才读数字 id，且只接受有限数，NaN 不能当 id。
  const numericId =
    readNumber(message, "id") ??
    readNumber(message, "msgid") ??
    readNumber(message, "msgId") ??
    readNumber(inner, "id") ??
    readNumber(inner, "msgid") ??
    readNumber(inner, "msgId");
  // 数字兜底也统一转 string；返回类型稳定，上层去重表不必处理两种类型。
  return numericId === null ? undefined : String(numericId);
}

// 消息列表字段名随 iLink 版本/接口变化（msgs/messages/updates/items/list），逐个尝试兼容成本最低。
// 单对象也接受，避免只推一条时被当成格式错误；非对象元素在 filter 处丢弃，防止后续解引用崩溃。
function readWeixinMessages(payload: unknown): Record<string, unknown>[] {
  const container = readMessagesContainer(payload);
  // 五个别名的顺序只是兼容列表；任一命中即可，全缺失时返回空数组。
  const rawMessages = container.msgs ?? container.messages ?? container.updates ?? container.items ?? container.list;
  if (Array.isArray(rawMessages)) {
    // 数组元素逐个过 isRecord，非对象元素在此丢弃，后续字段读取才不会崩溃。
    return rawMessages.filter(isRecord);
  }
  if (isRecord(rawMessages)) {
    return [rawMessages];
  }
  return [];
}

// 游标读取（INV-WX01）：多别名按优先级取，全为空串时返回 undefined。
// 这里依赖 `||` 把 "" 折叠成 undefined，正好让 getWeixinUpdates 用 ?? 保留旧游标；
// 改成 `??` 链会让服务端返回空串时把游标清空，下一轮从头重放全部历史消息。
function readNextBuf(payload: unknown): string | undefined {
  const container = readMessagesContainer(payload);
  return (
    // get_updates_buf 是当前协议主字段，其余别名只为兼容旧版本服务端。
    readString(container, "get_updates_buf") ||
    readString(container, "buf") ||
    readString(container, "next_buf") ||
    readString(container, "nextBuf") ||
    readString(container, "getUpdatesBuf") ||
    // syncKey 是更老的同步游标名；全空时返回 undefined，让调用方用 ?? 保留旧值。
    readString(container, "syncKey") ||
    undefined
  );
}

// context_token 是回复时必须回带的会话凭据（sendmessage 与 typing 都要用）；
// 缺失就返回 undefined，不构造假值，让服务端按“无上下文的新会话”处理。
function readWeixinContextToken(message: Record<string, unknown>): string | undefined {
  const inner = isRecord(message.msg) ? message.msg : isRecord(message.message) ? message.message : null;
  return (
    // context_token 顶层优先；回复时必须原样回带，改一个字符服务端就降级成新会话。
    readString(message, "context_token") ||
    readString(message, "contextToken") ||
    // context 是短别名；只有字符串才接受，对象形态的上下文不在此透传。
    readString(message, "context") ||
    readString(inner, "context_token") ||
    undefined
  );
}

// client_id 是 iLink 要求的客户端消息标识。每次 send 生成新值：
// 配合 INV-10（adapter 不自动重试），只有上层显式重试才会产生新 id，
// 因此超时重试可能被服务端当成两条消息（client_id 不同）——这是已知取舍，不是遗漏。
function buildWeixinClientId(): string {
  return `zcode-weixin-${randomUUID()}`;
}

// 文本硬换行：任意换行序列统一成 CRLF，保证 /status 这类多行输出在微信客户端不被折叠。
// 只做换行归一，不 trim、不截断：截断会破坏代码块，长度预算由上层按平台限制处理。
function buildWeixinText(message: BotOutboundMessage): string {
  // Bugfix: 微信 iLink 纯文本在不同客户端上对 LF 的处理不完全一致。
  // 发送前统一成 CRLF，把业务层的多行回复表达为文本硬换行，避免 /status 这类状态行被折叠。
  return message.text.replace(/\r\n|\r|\n/g, "\r\n");
}

// 入站消息的唯一装配点：过滤 -> 归一 -> 构造统一消息。
// 过滤顺序有语义：
// 1) message_type===2 是 bot 自己消息的回显，必须丢弃，否则机器人会和自己的回复互相触发；
// 2) 正文与附件都为空（已读回执/撤回占位）不投递，否则上层会产生空回复；
// 3) 没有 userId 不投递，身份未知无法做 ownership 判定（INV-01）。
// chatId 存在即群聊；chatType 只影响展示与回复路由，不参与权限。
// providerMessageId/providerContextToken 允许缺失：前者交给上层 fail-open 去重（INV-03），
// 后者让发送退化为无 context_token 的会话，接受与否由服务端决定。
function buildInboundMessage(botId: string, rawMessage: Record<string, unknown>): BotInboundMessage | null {
  // 这里刻意用字面量 2（与 WEIXIN_MESSAGE_TYPE_BOT 同义）：两者必须同步，
  // 否则 bot 回显会被当用户输入再次触发回复，形成自激循环。
  if (readNumber(rawMessage, "message_type") === 2) {
    return null;
  }
  // 统一 trim：全空白正文按空处理，避免只含空格的消息被当成有效输入。
  const text = readWeixinText(rawMessage).trim();
  // 附件先于空判计算；纯图片消息没有正文也必须能通过过滤。
  const attachments = readWeixinAttachments(rawMessage);
  const userId = readWeixinUserId(rawMessage).trim();
  if ((!text && attachments.length === 0) || !userId) {
    return null;
  }
  // chatId 只在这里读一次，actor.chatType 与 chatId 必须来自同一个判断。
  const chatId = readWeixinChatId(rawMessage);
  return {
    botId,
    text,
    // 空数组不写入字段：下游用 in 判断附件存在时不会被空数组误导。
    ...(attachments.length > 0 ? { attachments } : {}),
    actor: {
      provider: "weixin",
      botId,
      providerUserId: userId,
      displayName: readWeixinDisplayName(rawMessage),
      chatType: chatId ? "group" : "private",
      chatId,
      providerMessageId: readWeixinMessageId(rawMessage),
      providerContextToken: readWeixinContextToken(rawMessage),
    },
  };
}

// 诊断摘要只保留“形状”，必须不含任何正文内容：只输出 key 与 typeof。
// 用于定位 raw>0 但 parsed=0 时到底是字段改名还是嵌套结构变化。
// 三处截断（itemTypes 6 项、media 键 8/12 项）会把单条日志压到几百字节以内，
// 因为它随每条消息进入 debug 日志。任何含正文的字段都不得加入返回值。
function summarizeWeixinRawMessage(rawMessage: Record<string, unknown>, index: number): string {
  const inner = isRecord(rawMessage.msg) ? rawMessage.msg : isRecord(rawMessage.message) ? rawMessage.message : null;
  const itemList = Array.isArray(rawMessage.item_list)
    ? rawMessage.item_list
    : Array.isArray(inner?.item_list)
      ? inner.item_list
      : [];
  // 只取前 6 个 item 的 type；日志随每条消息打印，必须有长度上限。
  const itemTypes = itemList
    .filter(isRecord)
    // 三个类型别名都试；全缺失时写 unknown，才能区分“无类型”与“类型为 0”。
    .map((item) => readNumber(item, "type") ?? readNumber(item, "item_type") ?? readNumber(item, "message_type") ?? "unknown")
    .slice(0, 6)
    .join(",");
  // 只看第一个 item 的键：同条消息里媒体结构通常一致，全量打印会淹没日志。
  const firstItem = itemList.find(isRecord);
  // image_item/file_item/... 五种形态依次探测，命中即止；避免对不存在的键反复取属性。
  const firstMedia =
    isRecord(firstItem?.image_item) ? firstItem.image_item :
      isRecord(firstItem?.file_item) ? firstItem.file_item :
        isRecord(firstItem?.video_item) ? firstItem.video_item :
          isRecord(firstItem?.audio_item) ? firstItem.audio_item :
            isRecord(firstItem?.media_item) ? firstItem.media_item :
              null;
  // 值只输出 typeof 或 array，绝不输出内容；正文与密钥都不能进诊断日志。
  const mediaTypes = firstMedia
    ? Object.entries(firstMedia)
      .slice(0, 8)
      .map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`)
      .join(",")
    : "none";
  // 必须同时记录 media 与 nestedMedia 两层的键：媒体信息有时在外层、有时在 media 内，
  // 只打一层无法区分“字段没下发”和“下发了但多嵌了一层”这两种完全不同的故障。
  // 嵌套 media 单独再探一层；只打外层无法区分字段没下发与多套了一层。
  const nestedMedia = firstMedia && isRecord(firstMedia.media) ? firstMedia.media : null;
  // nestedMedia 同样按 8 项截断，两层键名加起来仍在单条日志预算内。
  const nestedMediaTypes = nestedMedia
    ? Object.entries(nestedMedia)
      .slice(0, 8)
      .map(([key, value]) => `${key}:${Array.isArray(value) ? "array" : typeof value}`)
      .join(",")
    : "none";
  return [
    `index=${index}`,
    `messageType=${readNumber(rawMessage, "message_type") ?? "none"}`,
    // 只记正文长度不记正文；textLen>0 而 attachments=0 能直接指向文本解析分支。
    `textLen=${readWeixinText(rawMessage).trim().length}`,
    `attachments=${readWeixinAttachments(rawMessage).length}`,
    // 身份缺失是 buildInboundMessage 丢弃消息的主因，单列一项便于一眼归因。
    `hasUserId=${readWeixinUserId(rawMessage).trim() ? "yes" : "no"}`,
    `itemList=${itemList.length}`,
    `itemTypes=${itemTypes || "none"}`,
    `itemKeys=${firstItem ? Object.keys(firstItem).slice(0, 12).join(",") : "none"}`,
    `mediaKeys=${firstMedia ? Object.keys(firstMedia).slice(0, 12).join(",") : "none"}`,
    `mediaTypes=${mediaTypes}`,
    `nestedMediaKeys=${nestedMedia ? Object.keys(nestedMedia).slice(0, 12).join(",") : "none"}`,
    `nestedMediaTypes=${nestedMediaTypes}`,
    `keys=${Object.keys(rawMessage).slice(0, 12).join(",")}`,
    // 内层键名单独列出：字段改名常发生在 msg 包装层而不是顶层。
    `innerKeys=${inner ? Object.keys(inner).slice(0, 12).join(",") : "none"}`,
  ].join(" ");
}

// 长轮询拉取一批更新，由 weixinChannelRuntime 每轮调用一次。
// 输入：buf 是上一轮持久化的服务端游标；signal 来自 runtime 的 AbortController（停止/换绑时中断）。
// 返回 messages/diagnostics/buf 三段：可投递消息、诊断字段与下一轮游标。
// 副作用：一次 HTTP POST。不写盘、不起定时器——游标持久化由 runtime 在本批消息全部处理完后完成，
// 保证“处理失败时游标不前进”，不会跳过未处理消息。
// [失败路径] 超时/HTTP 非 2xx/ret!=0 直接抛错；runtime 记 error 状态并退避 5s 重试（INV-10：
// 重试节奏只允许一个所有者，adapter 内部不得自行重试）。
// 超时口径：显式 90s。用默认 15s 会把“空闲时服务端正常挂起”误判成失败，轮询永远拿不到消息。
export async function getWeixinUpdates(params: {
  bot: BotConfig;
  deps: WeixinProviderDeps;
  buf?: string;
  signal?: AbortSignal;
}): Promise<WeixinGetUpdatesResult> {
  const payload = await requestWeixinJson(
    params.bot,
    params.deps,
    "/getupdates",
    {
      // 首次启动没有游标时发空串（“从头同步”），不能省略字段：服务端把缺字段当协议错误。
      get_updates_buf: params.buf ?? "",
    },
    params.signal,
    WEIXIN_GET_UPDATES_TIMEOUT_MS,
  );
  // 解析后的消息数可能远少于 rawMessageCount；差额就是被过滤掉的回显或空消息。
  const rawMessages = readWeixinMessages(payload);
  // 原始条数/诊断与解析结果分开返回：被过滤掉的消息也必须留证据，否则丢消息无法归因。
  // 诊断数组下标必须与 rawMessages 一一对应，只为排障存在，绝不参与业务判断或投递。
  // messages 与 buf 必须同批返回：先持久化 buf 再处理消息会永久跳过本批；
  // 先处理消息再持久化 buf 最坏只是重复拉取，由上层按 providerMessageId 去重。
  return {
    rawMessageCount: rawMessages.length,
    // 诊断只随结果返回不落盘；含形状不含正文，由上层决定是否写 debug 日志。
    rawMessageDiagnostics: rawMessages.map(summarizeWeixinRawMessage),
    messages: rawMessages
      .map((message) => buildInboundMessage(params.bot.id, message))
      .filter((message): message is BotInboundMessage => message !== null),
    // [失败路径] 服务端偶发不回游标时回落到入参 buf：宁可从旧位置重复拉取（上层按 id 去重），
    // 也不能让游标归零，否则下一轮会整段重放历史消息。
    buf: readNextBuf(payload) ?? params.buf,
  };
}

// [并发] 适配器对象没有共享可变状态：token 每请求现读、游标由调用方持久化、typing ticket 不缓存，
// 因此多个 bot 或多轮请求并发进入不会互相覆盖。唯一的串行化点是 runtime 的轮询锁，不在本文件。
// 构造渠道适配器。deps 只承载凭据读取；返回对象无内部可变状态，
// 因此可以按 provider 单例复用，不需要 close/dispose（INV-12 在本文件没有资源要释放）。
export function createWeixinBotProvider(deps: WeixinProviderDeps): BotProviderAdapter {
  return {
    // 连通性检查：只验证 token 可读且 /getconfig 返回 ret==0。
    // 不校验 getconfig 响应内容、不发测试消息——测试按钮不应该向真实用户投递内容。
    // enabled=false 时不发请求：已禁用的机器人还在后台打接口，会让用户误以为没关掉。
    // [失败路径] 异常不在此捕获，由调用方统一按 Error 展示，避免两套文案。
    async test(bot) {
      if (!bot.enabled) {
        return { ok: false, message: "Weixin bot is disabled." };
      }
      // 没有 credentialRef 就不发请求：拿不到 token 的 getconfig 只会返回 401。
      if (!bot.credentialRef) {
        return { ok: false, message: "Weixin iLink bot token is missing. Scan the Weixin login QR code first." };
      }
      // 只验证可达性与 ret==0，必须不发测试消息：测试按钮不应向真实用户投递内容。
      await requestWeixinJson(bot, deps, "/getconfig");
      return {
        ok: true,
        message: "Weixin iLink API is reachable.",
      };
    },

    // 出站文本发送：iLink 只接受 msg.item_list 结构，文本必须包在 type=1 的 text_item 里。
    // [事务] 无本地状态：请求成功即返回 void；失败抛错，由上层决定重试或回报失败。
    // INV-02 风险：sendmessage 响应通常只回 ret、不回 message_id，所以这里无法回填
    // providerMessageId；上层只能以“无异常”作为投递成功依据。若服务端将来返回 id，
    // 必须在 requestWeixinJson 的返回值中取出并向上返回，不能继续丢弃。
    // from_user_id 取扫码得到的 providerUserId；为空时不提前拦截，让服务端给出真实原因，
    // 而不是一条本地猜测的 weixin 报错。
    // send 只发一次不重试；重试由 runtime 统一决策，adapter 内部重发会产生两条消息。
    async send(bot, message) {
      // Bugfix: 微信 iLink 发送协议必须走 /ilink/bot/sendmessage，并把文本放进 msg.item_list。
      // 之前把 openclaw-weixin 当成本地 gateway 依赖，会导致 ZCode 不能独立完成微信接入。
      // 发送必须走 /ilink/bot/sendmessage；绕开它服务端会按草稿或未知协议处理。
      await requestWeixinJson(bot, deps, "/sendmessage", {
        msg: {
          // from_user_id 取扫码得到的 providerUserId；为空不提前拦截，让服务端给出真实原因。
          from_user_id: bot.providerUserId ?? "",
          // to_user_id 必须是入站读到的同一 providerUserId；换绑后旧 id 会发进错误会话。
          to_user_id: message.providerUserId,
          // client_id 每次新生成；配合不重试策略，只有上层显式重试才会出现两条不同 id。
          client_id: buildWeixinClientId(),
          // message_type=2：bot 消息；message_state=2：一次成型的终态消息。
          // 缺 message_state 会让服务端把消息当草稿挂起，用户侧永远收不到。
          // message_type=2 表示 bot 发出；写成 1 会被服务端当用户消息回显并再次触发。
          message_type: WEIXIN_MESSAGE_TYPE_BOT,
          // 缺省 message_state 会让服务端按草稿挂起，用户侧永远收不到这条消息。
          message_state: WEIXIN_MESSAGE_STATE_FINISH,
          // 只有入站带 context_token 时才回带；编造 token 会被服务端直接丢弃。
          // 只有入站带 token 才回带；编造 token 会被服务端直接丢弃整条消息。
          ...(message.providerContextToken ? { context_token: message.providerContextToken } : {}),
          // type=1 表示文本项；text 已做 CRLF 归一，保证多行回复的换行语义稳定。
          item_list: [
            {
              // type=1 是文本项的类型字面量；改成其他值服务端就不再按 text_item 解析。
              type: 1,
              // 文本必须嵌在 text_item.text；把 text 直接放 item 顶层协议不认。
              text_item: { text: buildWeixinText(message) },
            },
          ],
        },
      });
    },

    // typing 指示：iLink 要求先换 typing_ticket 再发状态，两步都必须带 ilink_user_id。
    // ticket 口径：与 (bot, user, context_token) 绑定且会过期，所以每次现取，本文件不缓存。
    // [权衡] 不缓存 = 每 4s 一次的 typing 心跳变成两次往返；缓存 = 必须同时处理过期与换绑失效，
    // 一旦失效就是“发不出去也不报错”的静默卡顿。当前以正确性换一次额外请求。
    // [失败路径] getconfig 未返回 typing_ticket 时静默返回：typing 是装饰性副作用，
    // 不能因为对方关闭输入态就中断真正的入站处理（INV-07 的静默降级）。
    // status=1 表示“开始输入”；iLink 无“停止输入”指令，因此 adapter 不实现 stopTyping。
    async sendTyping(bot, target: BotTypingTarget) {
      // [权衡] 上层对群聊传的是 chatId（actor.chatId ?? providerUserId），而字段名是
      // ilink_user_id；群场景下服务端可能不接受 room id，此时只会影响 typing 展示，不影响消息收发。
      // 先换 ticket 再发状态：两步分离是 iLink 协议要求，直接发 sendtyping 会被拒。
      const config = (await requestWeixinJson(bot, deps, "/getconfig", {
        ilink_user_id: target.providerUserId,
        ...(target.providerContextToken ? { context_token: target.providerContextToken } : {}),
      })) as WeixinTestResponse;
      if (!config.typing_ticket) {
        return;
      }
      await requestWeixinJson(bot, deps, "/sendtyping", {
        ilink_user_id: target.providerUserId,
        typing_ticket: config.typing_ticket,
        status: 1,
      });
    },

    // 附件下载：iLink CDN 返回 AES-128-ECB 密文，必须先解密再交给落盘层。
    // 前置条件：downloadUrl 与 providerMetadata.weixinAesKey 同时存在。缺任一项返回 null，
    // 表示“本 adapter 无法提供该附件”，由上层决定跳过或提示，绝不伪装成空文件（INV-04）。
    // INV-04 缺口：这里只校验 HTTP 状态，没有大小上限、没有超时，必须由调用方接收 signal；
    // 调用方必须自行限制并发与体积，否则超大附件会把进程内存打满。
    // [失败路径] 解密异常向上抛出，不返回部分明文；调用方按“整块失败”丢弃。
    // [资源] 一次性 arrayBuffer 读入内存，峰值内存约等于附件大小；不流式解密是因为
    // ECB + PKCS7 必须整块处理尾部 padding，无法边下边解。
    async downloadAttachment(_bot, attachment) {
      // 密钥随消息下发，非法/缺失都视为不可下载；不能退回“直接保存密文”。
      // 密钥只从 providerMetadata 取，不上溯消息级字段；缺失即视为该附件不可下载。
      const aesKey = attachment.providerMetadata?.weixinAesKey;
      // 两个条件缺一不可：只有 URL 会存下密文，只有密钥则无从取字节（INV-04）。
      if (!attachment.downloadUrl || !aesKey) {
        return null;
      }
      // 不使用 bot/凭据：URL 是预签名地址，鉴权由 CDN 校验，这里再带 token 反而会泄露凭据。
      // 直接 fetch 而不走统一封装：预签名 URL 自带鉴权，附件体积也不适合 JSON 响应封装。
      const response = await fetch(attachment.downloadUrl);
      if (!response.ok) {
        throw new Error(`Weixin attachment download failed: HTTP ${response.status}`);
      }
      return {
        attachment,
        data: decryptWeixinCdnMedia(new Uint8Array(await response.arrayBuffer()), aesKey),
      };
    },

    // 轮询链路把本文件解析出的消息再包成 {botId, messages:[...]} 回灌到这里，走与 webhook 相同的
    // 业务管线。因此这不是对外 HTTP 回调，没有签名可验：payload 由本进程 runtime 构造（INV-05 不适用）。
    // botId 缺失返回空数组：没有归属的消息无法路由，也不能猜一个。
    parseCallback(payload): BotInboundMessage[] {
      if (!isRecord(payload)) {
        return [];
      }
      // botId 由 runtime 回灌时写入；缺失说明不是本进程构造的 payload，直接返回空数组。
      const botId = readString(payload, "botId");
      if (!botId) {
        return [];
      }
      // 复用与 getupdates 相同的读取与装配，保证轮询与回灌两条链路过滤口径一致。
      return readWeixinMessages(payload)
        .map((message) => buildInboundMessage(botId, message))
        .filter((message): message is BotInboundMessage => message !== null);
    },
  };
}
