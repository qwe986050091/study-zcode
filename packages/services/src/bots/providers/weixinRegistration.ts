import { DEFAULT_WEIXIN_ILINK_BASE_URL } from "./weixinProvider.js";

// 微信 iLink 扫码登录：二维码版的 device flow 适配。
// 职责：申请二维码、轮询扫码状态、把 bot_token 交回调用方；不落盘、不写凭据、不重试。
// 边界：状态机与串行调度在调用方（UI + botsService），本文件每次调用都是无状态的一次往返。
//
// 本文件维持/依赖的不变量（INV-WX 前缀为本批新增，自洽编号）：
// INV-WX07：状态查询超时只代表“仍在等手机确认”，必须返回 pending，不能当失败。
// INV-WX08：只有 success 且 bot_token 非空才算成功；空 token 返回 error，绝不上交给写库方。
// INV-WX09：未知或缺失状态一律 pending，避免把协议新增状态误报成过期让用户重扫。
// INV-WX10：无本地状态、无缓存、无内部重试；qrCode 由调用方持有，重扫由用户触发。
// INV-08：bot_token 只出现在 success 返回值中，不写日志、不拼进错误消息。
// begin 的返回契约：qrCode 是轮询键（不透明，不得解析或改写），qrUrl 交给前端渲染二维码，
// interval 是建议轮询间隔（秒），expiresAt 是本地推算的展示用过期时刻，因为真正的截止由服务端的 expired 决定：
// 轮询何时停止由服务端返回的 expired 决定，本层与调用方都不按 expiresAt 主动截止。
// 刻意不返回 baseUrl：服务端回来的 baseurl 属于内部网关细节，暴露给前端会诱导前端直连。
interface WeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

// qrCode 必须原样回传 begin 给的值：它是服务端的会话键，编码或改写都会导致永远 pending。
interface WeixinRegistrationPollParams {
  qrCode: string;
}

// 五态结果机：pending/scanned 带下一轮间隔；success 带 token 与可选 botId；expired/error 终止。
// 调用方按 status 分支，不允许在 success 之外读取 botToken 字段。
// [权衡] expired/error 不用 throw 表达：扫码过期是正常业务终态，抛错会让 UI 只能弹 toast，
// 无法在扫码区域内展示“重新扫码”的引导。
type WeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

// 申请二维码的响应形状：所有字段可选且留多别名，服务端不同版本对 qrcode/qr_code 与 qrcode_img_content/qrcode_url 各用一套拼写。
// expires_in/expire_time 同理，任一缺失都不算类型错误。
interface WeixinQrBeginResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  data?: unknown;
  qrcode?: string;
  qr_code?: string;
  qrcode_url?: string;
  qrcode_img_content?: string;
  expire_time?: number;
  expires_in?: number;
}

// 轮询响应：status 既可能是 number 也可能是 string（归一逻辑见 normalizeQrStatus）；
// bot_token/token、ilink_bot_id/bot_id 是历史别名，必须同时接受。
// baseurl/base_url 声明了但当前未被使用，原因见 getWeixinRegistrationBaseUrl（属已知缺口）。
interface WeixinQrPollResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  data?: unknown;
  status?: string | number;
  bot_token?: string;
  token?: string;
  ilink_bot_id?: string;
  bot_id?: string;
  baseurl?: string;
  base_url?: string;
}

// 本文件私有的 API 前缀副本：provider 只导出网关地址而不导出这个前缀，因此这里不扩大其导出面。
// 代价是必须人工保持一致——前缀漂移会表现为“扫码成功、后续轮询 404”，且错误信息不会指出原因。
const WEIXIN_BOT_API_PREFIX = "/ilink/bot";
// 轮询间隔 3s：状态接口本身是长等待，间隔再短只会增加堆积，不会更快拿到结果。
const WEIXIN_LOGIN_INTERVAL_SECONDS = 3;
// 二维码默认有效期 120s：服务端未返回 expires_in 时的兜底，只用于 UI 倒计时。
const WEIXIN_LOGIN_EXPIRE_SECONDS = 120;
// 单次请求 30s：状态接口会挂起等手机确认，但必须有界，
// 否则一个卡死的请求会让 UI 的串行轮询器永远排不上下一轮。
const WEIXIN_LOGIN_REQUEST_TIMEOUT_MS = 30_000;

// 与 provider 侧同口径的本地副本：注册链路不依赖 adapter 实例，避免为了三个纯函数引入耦合。
// [权衡] 复制代码的代价是口径可能漂移；收益是登录流程可独立测试，且不额外暴露 adapter 内部符号。
function isRecord(value: unknown): value is Record<string, unknown> {
  // 排除 null：typeof null 也是 object，不排除会让后续属性读取抛 TypeError。
  return typeof value === "object" && value !== null;
}

// 类型不符一律回落 ""，让调用方的别名链用 || 串联时不会被 undefined 短路。
function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  // 非 string 一律回落空串，让调用方的 || 别名链继续尝试下一个字段，而不是被 undefined 短路。
  // 不 trim：token 与状态值是否允许空白由调用方判断，helper 擅自 trim 会改写凭据原文。
  return typeof value === "string" ? value : "";
}

// 只接受有限数：NaN/Infinity 参与 expiresAt 计算会得到 Invalid Date，倒计时直接崩坏。
function readNumber(record: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = record?.[key];
  // 只接受有限数：NaN/Infinity 参与 expiresAt 会算出 Invalid Date，倒计时直接崩坏。
  // 不接受字符串数字：隐式转换会把 "3x" 变成 3，宁可回落 null 走默认值。
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// 登录网关与 provider 共用同一个常量；登录时尚无 bot 配置，不能读 bot.webhookUrl 之类的字段。
// 当前忽略轮询响应里的 baseurl：若 iLink 按地域或租户返回不同网关，这里会继续打默认域名，
// 表现为登录成功但后续 getupdates 鉴权失败——属于待确认风险，切换前必须先做域名白名单校验。
function getWeixinRegistrationBaseUrl(): string {
  // 去掉尾部斜杠：调用方会再拼 /ilink/bot，重复斜杠会让部分网关直接 404。
  return DEFAULT_WEIXIN_ILINK_BASE_URL.replace(/\/+$/u, "");
}

// 与 provider 的 unwrapData 语义不同：这里是浅合并 { ...payload, ...payload.data }，
// 保留外层 ret/errcode，同时让 data 内字段覆盖同名键。
// 若像 provider 那样直接返回 data，外层错误码会丢失，下面的 ret/errcode 检查就形同虚设。
// 非对象返回 {}：让字段读取得到空值，由调用方按“缺字段”给出明确错误，而不是 TypeError。
function unwrapData(payload: unknown): Record<string, unknown> {
  // 非对象返回空表：后续 readString 得到空值，由调用方按「缺字段」报错，不会抛 TypeError。
  if (!isRecord(payload)) {
    return {};
  }
  // data 是对象时浅合并；data 内字段覆盖外层同名键，但外层 ret/errcode 仍保留，错误码检查才不会失效。
  // 只做一层：data 里再嵌套 data 属于未出现过的形状，递归会掩盖协议错误。
  return isRecord(payload.data) ? { ...payload, ...payload.data } : payload;
}

// 注册链路的唯一 HTTP 出口：GET 且无鉴权（扫码前还没有 token），固定 30s 超时。
// iLink-App-ClientVersion: 1 是协议要求的客户端版本协商头，必须随每次登录请求发送。
// 失败语义：HTTP 非 2xx 抛错；ret/errcode 非 0 抛服务端 errmsg；响应不是 JSON 时抛 SyntaxError。
// [失败路径] 只有 AbortSignal.timeout 产生的 DOMException("TimeoutError") 会被上层识别为“继续等”，
// 其余异常原样上抛——网络错误与协议错误必须让用户看见，不能伪装成轮询中。
// INV-08：错误消息只拼 errmsg 与错误码，绝不回显响应体或 query（qrCode 是会话键，等同凭据）。
async function getWeixinRegistrationJson<T>(baseUrl: string, path: string): Promise<T & Record<string, unknown>> {
  // URL 由网关地址、固定前缀与调用方 path 拼成；path 自带 query，前缀里不能再带重复斜杠。
  const response = await fetch(`${baseUrl}${WEIXIN_BOT_API_PREFIX}${path}`, {
    method: "GET",
    headers: { "iLink-App-ClientVersion": "1" },
    // [资源] 每次请求独立计时，计时器随请求结束释放；不接收调用方 signal，
    // 因为 UI 卸载与本层生命周期无关，残留计时器会没有所有者可清理。
    signal: AbortSignal.timeout(WEIXIN_LOGIN_REQUEST_TIMEOUT_MS),
  });
  // 非 2xx 先抛：错误响应体形状不可信，不尝试从中解析 ret/errmsg。
  if (!response.ok) {
    throw new Error(`Weixin login ${path} failed: HTTP ${response.status}`);
  }
  // 先浅合并再读错误码：部分网关把 ret 放在 data 内，直接读外层会漏判。
  const payload = unwrapData(await response.json()) as T & Record<string, unknown>;
  const ret = readNumber(payload, "ret");
  const errcode = readNumber(payload, "errcode");
  // 与 provider 同口径：ret 与 errcode 任一存在且非 0 即失败；两者都缺失视为成功，
  // 因为部分网关只返回数据体，不返回错误码字段。
  if ((ret !== null && ret !== 0) || (errcode !== null && errcode !== 0)) {
    // 优先用服务端 errmsg；没有就把两个码拼进消息，且绝不回显响应体或 query。
    throw new Error(readString(payload, "errmsg") || `ret=${ret ?? ""} errcode=${errcode ?? ""}`.trim());
  }
  // 返回合并后的原始对象，调用方按各自的字段别名取值，本层不做形状归一。
  return payload;
}

// 状态归一：number 0/1/2 对应 pending/scanned/success，3/4 都按 expired 处理。
// string 别名表覆盖服务端已出现过的拼写，其中 "scaned" 是真实存在的历史拼写错误，
// 必须保留：删掉它会让真实返回落到 pending，用户会一直停在“等待扫码”。
// 未知值与缺失一律 pending（INV-WX09）：协议新增状态时宁可多轮询一次，
// 也不能误判成 expired，把用户刚扫的码作废。
// [失败路径] 数字字符串（例如 "2"）当前会落到 pending；若服务端改用字符串数字，
// 表现是状态永不前进，需要在这里补 string 数字分支。
function normalizeQrStatus(status: unknown): "pending" | "scanned" | "success" | "expired" | "error" {
  // 数字态先判：旧网关用 0/1/2/3/4 表达五态，顺序与字符串别名表不同。
  if (typeof status === "number") {
    if (status === 0) return "pending";
    if (status === 1) return "scanned";
    if (status === 2) return "success";
    // 3 与 4 都映射过期：一个表示超时，一个表示用户取消，处理方式相同——只能重扫。
    if (status === 3 || status === 4) return "expired";
  }
  // 既不是数字也不是字符串（缺失/null/对象）按 pending，不猜成失败。
  if (typeof status !== "string") {
    return "pending";
  }
  // 统一小写再比对：服务端大小写不稳定，严格相等会把 Confirmed 判成未知状态。
  const normalized = status.toLowerCase();
  // 成功同义集合：confirmed/authorized 来自不同版本的回调语义，都表示手机端已确认。
  if (["confirmed", "confirm", "authorized", "success", "ok"].includes(normalized)) {
    return "success";
  }
  // scaned 是服务端真实存在过的拼写错误；删掉它会让真实响应落到 pending，用户永远停在等待扫码。
  if (["scaned", "scanned", "scan", "confirmed_wait"].includes(normalized)) {
    return "scanned";
  }
  // 取消与超时都按过期处理：二维码已失效，继续轮询只会拿到同样的状态。
  if (["expired", "timeout", "cancel", "cancelled", "canceled"].includes(normalized)) {
    return "expired";
  }
  // 显式失败才返回 error；error 分支会透传 errmsg，其余状态不透传。
  if (["error", "failed", "fail"].includes(normalized)) {
    return "error";
  }
  // 未识别状态返回 pending：协议新增状态时宁可多问一轮，也不能把刚扫的码判成过期。
  return "pending";
}

// 申请登录二维码。bot_type=3 是 iLink 的 bot 类型枚举，写死在 query 里：
// 改错会拿到个人号二维码，扫码成功后没有 bot_token（调用方会一直卡在 success 缺字段）。
// qrUrl 回落顺序：qrcode_img_content -> qrcode_url -> qrCode 本身（qrCode 可能已是 URL）。
// 三者皆无就无法展示二维码，直接抛错；这里不吞异常，因为缺少二维码时流程无法继续。
// expiresAt 用本地 Date.now() 加 expires_in：服务端返回的绝对时间 expire_time 当前未使用，
// 所以设备时钟偏差只影响展示倒计时，不影响服务端真实有效期（服务端仍会自己判过期）。
export async function beginWeixinRegistration(): Promise<WeixinRegistrationBeginResult> {
  // 每次现算 baseUrl 而不是模块级常量：测试替换 DEFAULT_WEIXIN_ILINK_BASE_URL 后，这里能立即生效。
  const baseUrl = getWeixinRegistrationBaseUrl();
  // bot_type=3 是 iLink 的机器人类型枚举；写错会拿到个人号二维码，成功响应里没有 bot_token。
  const payload = await getWeixinRegistrationJson<WeixinQrBeginResponse>(baseUrl, "/get_bot_qrcode?bot_type=3");
  // qrCode 是两个服务端字段名的第一个非空值；它是不透明轮询键，后续必须原样回传。
  const qrCode = readString(payload, "qrcode") || readString(payload, "qr_code");
  // qrUrl 按「图片内容 → 图片地址 → qrCode 本身」回落；三者都没有就无法展示二维码。
  const qrUrl = readString(payload, "qrcode_img_content") || readString(payload, "qrcode_url") || qrCode;
  if (!qrCode || !qrUrl) {
    // 两个字段任一缺失都无法开始：qrCode 用于轮询，qrUrl 用于展示，不能用彼此兜底冒充。
    throw new Error("Weixin login did not return a QR code.");
  }
  // 服务端没给 expires_in 时用本地兜底；expiresAt 只做倒计时，真实过期仍由服务端判定。
  const expireSeconds = readNumber(payload, "expires_in") ?? WEIXIN_LOGIN_EXPIRE_SECONDS;
  return {
    qrCode,
    qrUrl,
    interval: WEIXIN_LOGIN_INTERVAL_SECONDS,
    expiresAt: Date.now() + expireSeconds * 1000,
  };
}

// 查询一次扫码状态。调用方负责串行调度：上一次返回后才排下一次，避免长等待请求堆叠。
// 输入 qrCode 原样拼进 query，必须 encodeURIComponent：会话键可能含 = 或 &，不编码会截断 query。
// 输出严格五态；[失败路径] 超时被翻译成 pending，其余异常上抛。
// INV-WX08：success 分支必须校验 bot_token 非空，否则返回 error——空 token 被写进 credential，
// 会得到“保存成功但轮询永远 401”的坏状态，且之后无法自动恢复，只能重新扫码。
// 本函数不写任何本地状态，因此不存在需要回滚的中间态；半成品只可能出现在调用方。
// [并发] 本函数不做串行化，调用方可能同时发起多个轮询；因为没有共享状态，后到结果只会覆盖 UI，
// 由调用方按 qrCode 匹配丢弃过期结果，所以这里不需要锁，也不能靠锁来保证顺序。
export async function pollWeixinRegistration(
  params: WeixinRegistrationPollParams,
): Promise<WeixinRegistrationPollResult> {
  // 前置条件：qrCode 必须是 beginWeixinRegistration 原样返回的串；本函数不做存在性校验，改写它只会永远 pending。
  const baseUrl = getWeixinRegistrationBaseUrl();
  // 类型写成响应形状与索引签名的交集：既能读到已声明字段，也允许读取 qrcode_status 这类别名。
  let payload: WeixinQrPollResponse & Record<string, unknown>;
  try {
    payload = await getWeixinRegistrationJson<WeixinQrPollResponse>(
      baseUrl,
      `/get_qrcode_status?qrcode=${encodeURIComponent(params.qrCode)}`,
    );
  // 只有超时被翻译成 pending，其它异常继续上抛：网络断开与协议错误必须让用户看见。
  } catch (error) {
    // AbortSignal.timeout 产生的是 DOMException 的 TimeoutError；按类型与 name 双重判断，避免其它 AbortError 混入。
    if (error instanceof DOMException && error.name === "TimeoutError") {
      // Bugfix: 微信扫码状态接口可能长时间挂起等待手机端确认，超时不代表登录失败。
      // 返回 pending 让 UI 串行继续轮询，避免把正常等待误报成错误。
      return { status: "pending", interval: WEIXIN_LOGIN_INTERVAL_SECONDS };
    }
    // 网络断开、HTTP 5xx、非法 JSON 属于“重试也不会自愈”的失败，原样上抛让用户重新扫码。
    throw error;
  }
  // status 的三个别名按新到旧排列；全部缺失时 normalizeQrStatus 返回 pending（INV-WX09）。
  const status = normalizeQrStatus(payload.status ?? payload["qrcode_status"] ?? payload["qr_status"]);
  if (status === "success") {
    // bot_token 与 token 是不同版本的服务端字段名；取到空串就说明协议说成功但没给凭据。
    const botToken = readString(payload, "bot_token") || readString(payload, "token");
    if (!botToken) {
      // 明确区分“协议说成功但没给凭据”：不能当成功返回，否则上层会写入空 token。
      return { status: "error", message: "Weixin login succeeded but did not return bot_token." };
    }
    return {
      status: "success",
      botToken,
      // botId 只用于回填展示名，缺失不影响凭据可用性；因此不参与成功判定。
      botId: readString(payload, "ilink_bot_id") || readString(payload, "bot_id") || undefined,
    };
  }
  // 过期是确定终态：不携带 message，UI 侧有本地化文案，透传服务端原文反而可能暴露内部措辞。
  if (status === "expired") {
    return { status: "expired" };
  }
  if (status === "error") {
    // error 才透传 errmsg：这里的信息对用户有意义（如“账号受限”），且不含凭据。
    return { status: "error", message: readString(payload, "errmsg") || "Weixin login failed." };
  }
  // pending/scanned 统一回带固定间隔：服务端不返回 interval，不写死会让调用方拿 undefined 排定时器。
  return { status, interval: WEIXIN_LOGIN_INTERVAL_SECONDS };
}
