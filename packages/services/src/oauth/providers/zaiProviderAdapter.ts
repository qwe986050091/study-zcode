// ZAI（Z.AI / BigModel）OAuth 适配器：把后端非标准 token 响应翻译成仓库统一的 OAuthTokenSet，
// 并在同一个 adapter 边界内完成「OAuth token → 业务 JWT」的交换。
// INV-01：exchangeToken 返回的 accessToken 必须是 /api/auth/z/login 换出的业务 token，
//         守住位置 exchangeToken 与 normalizePolledTokenSet；破坏后果是下游业务接口 401，
//         且已持久化的 token 无法靠重试自愈，用户只能重新登录。
// INV-02：lastBackendUserProfile 只在「本 state 且字段有效」时写入、消费一次即清空，
//         守住位置 exchangeToken/fetchUserInfo；破坏后果是 UI 长期显示兜底昵称 User。
// INV-03：日志只出现掩码后的 code/token 与长度，任何分支都不能落盘原文，
//         守住位置 maskOAuthCode/maskAccessToken/sanitizeTokenPayloadForLog。
// INV-04：所有错误统一收敛为 Error 再抛出，ApiError 子类字段保留给 logTokenResponseError 采样。
import { Buffer } from "node:buffer";
import {
  ApiError,
  type ApiClient,
  formatLogPrefix,
  ZAI_PROVIDER_ID,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { ZaiBusinessTokenResolver } from "../../providers/zaiBusinessTokenResolver.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

// 后端 token 响应信封：code/msg 是业务状态，data 才是载荷。字段全可选是刻意的——
// 同一路由同时服务 Z.ai 与 BigModel，缺字段属既定契约而非异常，存在性校验集中在 exchangeToken。
// [失败路径] code !== 0 与 data.token / data.zai.access_token 缺失分属「后端拒绝」与
// 「协议不匹配」，必须给出可分辨的文案，前端才能引导不同处置。
interface ZaiBackendTokenPayload {
  // code 是业务状态码，只有严格等于 0 才算兑换成功，undefined 也走失败分支。
  code?: number;
  // msg 承载后端可读错误文案，缺失时由 exchangeToken 用本地兜底文案补齐。
  msg?: string;
  // data 是 token 载荷，整体可能为 null，取值前必须逐层可选链，否则缺信封时抛 TypeError。
  data?: {
    // token 是 zcode 自有服务 JWT，与 zai.access_token 职责不同，缺任意一个都必须让登录失败。
    token?: string;
    // zai 节点可能为 null，BigModel 路由可只回 token 而不回该节点，因此按可选处理。
    zai?: {
      // access_token 是 Z.AI 侧 OAuth token，必须先经 resolver 换成业务 JWT 才能持久化。
      access_token?: string;
    } | null;
    // expires_in 是相对秒数，必须经 normalizeExpiresIn 换成绝对时间戳后再落盘。
    expires_in?: number;
    // user 是可选内联资料，存在且字段有效时才写入 lastBackendUserProfile 缓存。
    user?: ZaiBackendUserPayload;
  } | null;
}

// 后端 user 的原始形状，字段全可选，映射成 OAuthUserProfile 时逐字段兜底而不是抛错。
interface ZaiBackendUserPayload {
  // user_id 映射为 OAuthUserProfile.id，缺失时落 unknown，参与凭据键因此不能换成 username。
  user_id?: string;
  // email 只作 username 的第二顺位来源，避免把邮箱当昵称直接展示。
  email?: string;
  // avatar 可能是 base64 裸串或绝对 URL，统一经 normalizeBackendAvatarUrl 归一。
  avatar?: string;
  // name 是用户可见昵称的首选来源，优先级高于 email 与 id。
  name?: string;
  // created_at 只随 rawProfile 透出，本适配器不解析也不参与任何判定。
  created_at?: string;
}

// userinfo 有两种包装：OIDC 直出（sub/name 在顶层）与网关包装（嵌在 data 下），
// fetchUserInfo 用 data 优先、payload 兜底的方式兼容两者，因此这里不能把任一种写成必需字段。
// [权衡] 拆成两个接口再做运行时判别仍无法排除双包装同时出现，收益不抵复杂度。
interface ZaiUserInfoPayload {
  // data 是网关包装层，存在即优先于顶层字段，OIDC 直出时该键缺失。
  data?: {
    // sub 是 OIDC 主体标识，fetchUserInfo 以它作为 id 的第一顺位。
    sub?: string;
    // id 是部分网关回的等价标识，sub 缺失时才读取，两者不同源不得混用。
    id?: string;
    // name 是 userinfo 侧昵称首选，优先于 preferred_username 与 email。
    name?: string;
    // preferred_username 是 name 缺失时的次选，属 OIDC 标准字段。
    preferred_username?: string;
    // email 仅在 name 与 preferred_username 都缺失时兜底成 username。
    email?: string;
    // picture 直接作为 avatarUrl，不走后端 avatar 的 base64 嗅探逻辑。
    picture?: string;
  };
  // 顶层 sub 供 OIDC 直出结构使用，与 data.sub 同义但层级不同。
  sub?: string;
  // 顶层 id 是网关直出时的主体标识，优先级低于 sub。
  id?: string;
  // 顶层 name 对应直出昵称，只有 data 缺失时才会被读到。
  name?: string;
  // 顶层 preferred_username 是直出结构的昵称次选，仍排在 name 之后。
  preferred_username?: string;
  // 顶层 email 只兜底 username，不参与 id 判定。
  email?: string;
  // 顶层 picture 与 data.picture 同义，取值层级由 data 是否存在决定。
  picture?: string;
}

// 两档超时的分工：userinfo 在「恢复登录态」关键路径上，超时过短会误判掉慢网下的有效登录；
// 业务 token 交换在登录流程内同步等待，超时必须比 userinfo 更短，避免兑换失败把用户长时间卡住。
// 两者都是上限而非期望值，正常请求应远小于该值返回。
/** OAuth 启动恢复允许的最长等待时间（1 分钟） */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
// 10 秒上限只覆盖 /api/auth/z/login 一次兑换，超时即整体登录失败，适配器内不做重试。
const ZAI_BUSINESS_TOKEN_TIMEOUT_MS = 10_000;
// log 前缀固定 zaiOAuth 加 pid，便于在并发进程日志里按 pid 区分同一账号的多实例。
const log = (...args: unknown[]) => console.log(formatLogPrefix("zaiOAuth", process.pid), ...args);

// 后端只给相对秒数，这里必须先换算成绝对时间戳，并注入 now 便于测试。
// [事务] 换算必须在响应到达后、持久化前完成：若把相对值落盘，进程重启或长休眠后
// 过期判定会整体漂移，用户会在 token 仍有效时被判下线。
// 0/NaN 一律视为「未声明」返回 undefined，交给上层默认策略，而不是当成已过期。
function normalizeExpiresIn(raw: number | undefined, now: () => number): number | undefined {
  // 0 与 NaN 一律视为后端未声明过期时间，必须走 undefined 分支而不是当成已过期。
  if (!raw || !Number.isFinite(raw)) {
    // 返回 undefined 让调用方省略 expiresAt 键，维持「缺省即未知」的语义。
    return undefined;
  }

  // 秒转毫秒后叠加注入时钟，保证测试可用固定 now 复现同一过期时间。
  return now() + raw * 1000;
}

// 后端 avatar 只给 base64 裸串、不带 MIME，类型必须靠魔数嗅探，否则浏览器按错误类型渲染会显示空图。
// 判定顺序按签名长度与常见度：PNG/JPEG/GIF/WEBP 的签名互不前缀，先长后短不会误命中。
// 兜底 image/png 与历史行为一致——宁可类型略偏，也不返回 null 让 UI 走无头像分支。
function inferBase64ImageMimeType(decoded: Buffer): string {
  // PNG 必须同时匹配完整 8 字节签名，只看首字节会把其它格式误判成 image/png。
  if (
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    // 命中 PNG 签名即返回，本分支排在 JPEG/GIF/WEBP 之前，依赖签名之间互不为前缀。
    return "image/png";
  }

  // JPEG 只校验 ff d8 ff 三字节，长度必须够 3 才读，否则短 buffer 会读到 undefined。
  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    // JPEG 分支排在 PNG 之后不影响判定，因为 PNG 签名首字节是 0x89 而这里是 0xff。
    return "image/jpeg";
  }

  // GIF 用 ascii 比较前 3 字节，长度不足 6 时直接跳过，不会越界读到 undefined。
  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    // GIF 签名只认 GIF87a/GIF89a 的共同前缀，后续版本字节不参与判定。
    return "image/gif";
  }

  // WEBP 必须同时满足 RIFF 头与偏移 8 处的 WEBP 标记，缺任一段都会退到兜底。
  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    // WEBP 分支放最后，因为它的两段签名检查最重，短签名格式已在前面的分支返回。
    return "image/webp";
  }

  // 四种签名都不命中时兜底 image/png，与历史行为一致，宁可类型略偏也不返回 null。
  return "image/png";
}

// 判断这串字符真的是 base64 图片，而不是任意短串被误当图片：先正则卡住字母表与填充位，
// 再解码后按 base64 重新编码比对，剔除 Buffer 解码器静默丢弃非法字符的情况。
// [失败路径] 任一校验不过返回 null 由调用方回退原值；长度小于 16 的廉价短路避免对昵称跑完整解码。
function toBase64ImageDataUrl(raw: string): string | null {
  // 先剔除所有空白字符，base64 允许换行分段，带空白的串在正则里会被直接判非法。
  const normalized = raw.replace(/\s/g, "");
  // 长度或字母表任一不合规即返回 null，正则同时锁住 +/ 与最多两个尾部填充位。
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    // 返回 null 表示这串按图片处理失败，调用方保留原值而不是抛错。
    return null;
  }

  // Buffer 解码器会静默丢弃非法字符，所以解码本身不能证明输入合法。
  const decoded = Buffer.from(normalized, "base64");
  // Buffer 解码结果为空说明输入全是非法字符，直接按失败处理。
  if (decoded.length === 0) {
    // 空解码结果必须返回 null，否则会生成 data:image/png;base64, 这样的空图片地址。
    return null;
  }

  // 重新用 toString 编码并去掉尾部填充，用于和输入做规范化比对。
  const encoded = decoded.toString("base64").replace(/=+$/, "");
  // 重编码与原文不一致时必须判失败，说明解码器丢过字符，这串不是合法 base64 图片。
  if (encoded !== normalized.replace(/=+$/, "")) {
    // 比对失败返回 null，防止把静默截断后的半张图当完整头像渲染。
    return null;
  }

  // 拼成 data URL 时复用已解码 buffer 嗅探 MIME，避免对同一串二次解码。
  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

// 优先级：已是 data URL 或 http(s) 绝对地址就原样返回（后端语义已完备）；否则尝试
// 按 base64 转 data URL；仍失败则原样保留。不补域名是因为后端改为直出可展示地址后，
// 再拼前缀会把正确 URL 改坏——「不加工」比「猜测补齐」更安全。
function normalizeBackendAvatarUrl(avatar: string | undefined): string | undefined {
  // trim 只去掉首尾空白，空串与全空白都归为无头像，必须避免把空白串当 URL 渲染。
  const trimmed = avatar?.trim();
  // 空值直接返回 undefined，让 toBackendUserProfile 省略 avatarUrl 键而不是写空字符串。
  if (!trimmed) {
    // 返回 undefined 而不抛错：avatar 缺失只影响展示，不能因此让登录失败。
    return undefined;
  }

  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    // 已是 data URL 或 http(s) 地址就原样返回，服务端语义已完备，再加工会改坏正确 URL。
    return trimmed;
  }

  // 不是绝对地址时按 base64 裸串再试一次，成功即得到可直接渲染的 data URL。
  const dataUrl = toBase64ImageDataUrl(trimmed);
  // 转成 data URL 后立即返回，不再走后面保留原值的分支。
  if (dataUrl) {
    // 返回 dataUrl 而不是 trimmed，浏览器才能按嗅探出的 MIME 渲染。
    return dataUrl;
  }

  // ZAI 后端现在稳定返回可展示 URL 或 base64，客户端继续拼 chat.z.ai 前缀会改坏服务端语义。
  // 这里只保留原值，避免把后端返回的 avatar 二次加工成错误地址。
  return trimmed;
}

// 映射：user_id→id；username 取 name，其次 email，最后 id；displayName 与 username 同源
// （后端没有独立展示名，UI 两处必须一致，否则侧栏与日志各显示一套）。
// 缺失 user 时返回固定兜底三元组而非抛错：token 已兑换成功，昵称缺失不该让登录失败。
function toBackendUserProfile(user: ZaiBackendUserPayload | undefined): OAuthUserProfile {
  // 缺失 user 时必须走固定兜底而不是抛错，前提是 token 已兑换成功，昵称缺失不该中断登录。
  if (!user) {
    // 兜底三元组固定为 unknown/user/User，保证 UI 与日志都显示同一套占位文案。
    return {
      // id 固定 unknown，不能伪造 provider 侧标识，避免兜底值参与凭据键。
      id: "unknown",
      // username 固定小写 user，UI 侧栏在缺资料时以它作为占位名。
      username: "user",
      // displayName 用首字母大写的 User，与 username 的小写占位刻意不同，展示位大小写由这里定。
      displayName: "User",
    };
  }

  // user_id 缺失才落 unknown，已有值时原样保留，凭据键依赖它的稳定性。
  const id = user.user_id ?? "unknown";
  // ZAI 后端 token body 里的 user.name 才是用户可见昵称，之前只读 email，
  // 导致登录成功后侧栏和日志都显示 phone.local 邮箱；avatar 只做必要的 base64 展示格式归一化。
  const username = user.name?.trim() || user.email || id;
  // avatar 归一结果可能为 undefined，条件展开时据此决定是否写 avatarUrl 键。
  const avatarUrl = normalizeBackendAvatarUrl(user.avatar);

  // 返回对象按 OAuthUserProfile 契约组装，avatarUrl 与 rawProfile 都走条件或尾字段。
  return {
    // 返回处的 id 直接复用 user_id 算出的常量，不做二次兜底。
    id,
    username,
    // displayName 复用 username 变量而不是重新读 user.name，避免两处取值口径分叉。
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    // rawProfile 保留后端原始对象，后续诊断必须能按字段回溯，因此不参与 UI 渲染。
    rawProfile: user,
  };
}

// 「有意义」= 至少一个可展示字段非空白。空对象与全空白字符串都算缺失：
// 后端偶发返回 data.user 但不填内容，若当成有效用户缓存，fetchUserInfo 会被短路，
// UI 长期停在兜底文案。exchangeToken 与 fetchUserInfo 共用这一处判定，避免口径分叉。
function hasMeaningfulBackendUser(
  // 参数类型放宽到 undefined，调用方不必先判空，判定收敛在本函数内。
  user: ZaiBackendUserPayload | undefined,
): user is ZaiBackendUserPayload {
  // undefined 与 null 都走 false 分支，避免可选链前先解构导致 TypeError。
  if (!user) {
    // 返回 false 表示缺失，让 exchangeToken 清空缓存而不是写入兜底资料。
    return false;
  }

  // 四处 trim 后取或，任一非空即返回 true，空白字符串不算有效字段。
  return Boolean(
    user.user_id?.trim() || user.email?.trim() || user.name?.trim() || user.avatar?.trim(),
  );
}

// 长度不超过 8 时全掩，防止短码被还原；否则保留前 4 后 4 位，便于人工比对日志与回执。
// 授权码是一次性凭据，日志里任何可还原形式都按泄露处理。
function maskOAuthCode(code: string): string {
  // code.length 不超过 8 时无法保留前后各 4 位，只能全掩避免短码被还原。
  if (code.length <= 8) {
    // 返回与 code 等长的星号，保留长度信息但不暴露任何字符。
    return "*".repeat(code.length);
  }

  // 前 4 与后 4 各取一次，code 中段永远不进入日志字符串。
  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

// 与 code 同一掩码规则，但 token 长期有效、泄露后果更重：任何日志（含异常对象序列化）
// 都不得出现完整值；需要长度信息时另写 tokenLength 独立字段。
function maskAccessToken(token: string): string {
  // token 与 code 共用 8 位阈值，短 token 必须全掩，否则前 4 后 4 会直接拼出原文。
  if (token.length <= 8) {
    // 等长星号只暴露 token 长度，不暴露任何可枚举字符。
    return "*".repeat(token.length);
  }

  // 长 token 只保留两端各 4 位，中间的签名主体不落盘。
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

// 构造脱敏副本而不是就地改写：后续还要用 tokenPayload 的原文去兑换业务 token，
// 就地改会让真实登录失败，所以这是「只读投影」。
// [权衡] 只复制到敏感字段所在层级，其余嵌套引用共享，必须避免对未知结构做无意义深拷贝。
function sanitizeTokenPayloadForLog(tokenPayload: ZaiBackendTokenPayload): unknown {
  // 没有 data 时原样返回，脱敏只针对 data 下的敏感字段，不改写信封其余部分。
  if (!tokenPayload.data) {
    // 返回同一个 tokenPayload 引用而不是副本，因为没有敏感字段需要遮蔽。
    return tokenPayload;
  }

  // 先取出 data.token 供后续决定是否掩码，undefined 时省略该键而不是写空值。
  const token = tokenPayload.data.token;
  // zai 可能为 null，这里必须用可选链取值，取不到时后续不写 access_token。
  const zaiAccessToken = tokenPayload.data.zai?.access_token;

  // 构造新对象而不是就地删改，tokenPayload 的原文还要用于兑换业务 token。
  return {
    ...tokenPayload,
    // data 逐层展开后只覆盖敏感键，其余字段沿用原引用以减少拷贝。
    data: {
      ...tokenPayload.data,
      ...(token
        // token 存在时才追加掩码键，否则整个条件对象为空，不产生多余字段。
        ? {
            // 原 token 键被掩码值替换，日志里不会再出现完整 JWT。
            token: maskAccessToken(token),
            // 单独给出 tokenLength，排查长度问题时不依赖被掩码的字符串。
            tokenLength: token.length,
          }
        // 条件为假时展开空对象，保证 data 结构不出现 token 键。
        : {}),
      ...(tokenPayload.data.zai
        // zai 节点存在才重建，null 时保持原值，避免把 null 变成空对象。
        ? {
            // zai 内部同样逐层展开，access_token 是需要遮蔽的唯一敏感键。
            zai: {
              ...tokenPayload.data.zai,
              ...(zaiAccessToken
                // access_token 存在时才追加掩码，缺失时 zai 只保留其它字段。
                ? {
                    // Z.AI token 与 zcode JWT 用同一掩码规则，日志里无法还原原文。
                    access_token: maskAccessToken(zaiAccessToken),
                    // 长度单独记录，与上面的 tokenLength 命名区分两个不同凭据。
                    accessTokenLength: zaiAccessToken.length,
                  }
                // 缺失 access_token 时展开空对象，zai 键仍保留但不含该字段。
                : {}),
            },
          }
        // zai 整体缺失时展开空对象，最终 data 里不会凭空出现 zai 键。
        : {}),
    },
  };
}

// 只在 ApiError 时补链路信息：非 HTTP 错误没有状态码与响应头，再打一遍只会产生无信息量的重复日志。
// 本函数不吞、不改写异常，调用方 catch 后仍须原样 rethrow，保证错误类型不被适配器篡改。
function logTokenResponseError(error: unknown): void {
  // 只处理 ApiError，其它异常没有状态码与响应头，必须跳过以免重复打印无信息量。
  if (!(error instanceof ApiError)) {
    // 非 ApiError 直接返回，不吞异常，调用方仍负责 rethrow。
    return;
  }

  // 后端 4xx/5xx 排查需要响应里的 request id；直接记录完整 headers 会把 cookie 等敏感值落盘。
  // readApiJson 只透出安全的链路追踪头，这里把它们和状态码一起打印出来，方便后端按 x-request-id 定位。
  log("token response error", {
    // 记录请求方法与地址，后端按 x-request-id 定位时需要二者配对。
    method: error.method,
    // url 原样打印，便于区分 token 与 userinfo 两条路由的失败。
    url: error.url,
    // 状态码是区分鉴权失败与服务端故障的第一判据。
    status: error.status,
    // 只打印 readApiJson 透出的链路追踪头，cookie 等敏感值已被过滤。
    responseHeaders: error.responseHeaders ?? {},
  });
}

/** ZAI OAuth 协议适配器 */
export class ZaiProviderAdapter implements OAuthProviderAdapter {
// 实例是「有状态单例」：meta/redirectUri/apiClient 构造后只读，lastBackendUserProfile 是唯一可变字段。
// [并发] 该缓存无锁，只面向单进程内的串行登录，必须用 state 做归属校验；
// 若将来允许并发登录，必须改成以 state 为键的 Map，否则后一次登录会覆盖前一次的 user。
  readonly providerId = ZAI_PROVIDER_ID;
  // meta 由 config 四个字段投影而来，构造后不再变更，UI 读它决定 provider 排序与开关。
  readonly meta: OAuthProviderMeta;
  // redirectUri 单独存一份而不是每次读 config，回调 URL 必须与授权请求完全一致。
  readonly redirectUri: string;
  // apiClient 由外部注入，便于测试替换传输层，适配器不自行建连接。
  readonly apiClient: ApiClient;
  // resolver 只负责 OAuth token 换业务 JWT，超时与登录域都在构造期固化。
  private readonly businessTokenResolver: ZaiBusinessTokenResolver;
  // 缓存只在 exchangeToken 写入、fetchUserInfo 消费，是类内唯一可变字段。
  private lastBackendUserProfile: {
    // state 记归属，读取时必须与本次 context.state 相等，否则视为另一次登录。
    state: string;
    // profile 是已映射好的资料，消费时直接返回，不再重复做字段兜底。
    profile: OAuthUserProfile;
  } | null = null;

  // constructor 只做字段固化，不能在这里发网络请求，登录域与超时选择在此一次定死。
  constructor(
    // config 存为私有字段，authorizeUrl/tokenUrl/appId 都必须从它派生，避免多处配置源。
    private config: OAuthProviderRuntimeConfig,
    // apiClient 作为参数注入而不是在类内新建，测试可传替身。
    apiClient: ApiClient,
  ) {
    // meta 只挑四个展示与调度字段，不把 redirectUri 等运行期配置漏给 UI。
    this.meta = {
      // id 直接用配置值，必须与 ZAI_PROVIDER_ID 一致，否则适配器注册表查不到。
      id: config.id,
      // displayName 原样透传，UI 只能用它渲染登录按钮，不在适配器里做本地化。
      displayName: config.displayName,
      // enabled 透传配置开关，禁用后 restoreCachedSession 会按未登录处理。
      enabled: config.enabled,
      // order 决定多 provider 的展示顺序，原样透传避免适配器自行排序。
      order: config.order,
    };
    // redirectUri 固定成实例字段，token 交换与授权请求必须提交同一个值。
    this.redirectUri = config.redirectUri;
    // apiClient 赋值后即只读，所有请求共用同一传输层实例。
    this.apiClient = apiClient;
// 解析器在构造期绑定，必须与 meta 一同固化：登录域在启动配置时确定，
// 运行期切换会让同一进程内不同请求打到不同业务域，token 与接口随之错配。
// businessLoginUrl 允许配置覆盖，是为本地/测试环境把请求指向测试业务域。
    this.businessTokenResolver = new ZaiBusinessTokenResolver({
      // resolver 复用外层 apiClient，请求头与重试策略与 OAuth 主链路保持一致。
      apiClient,
      // 测试 OAuth app 返回的 ZAI access_token 需要打到测试业务域换业务 token；
      // 如果继续硬编码生产 api.z.ai，本地测试登录会在 OAuth token 成功后失败。
      loginUrl: config.businessLoginUrl ?? "https://api.z.ai/api/auth/z/login",
      // 超时取模块常量而不是 config，避免运行期改配置导致兑换行为漂移。
      timeoutMs: ZAI_BUSINESS_TOKEN_TIMEOUT_MS,
    });
  }

// 兼容两种参数名：标准 code 与旧 deep link 的 authCode。state 缺失既是关联失败
// 也失去 CSRF 校验依据，因此与 code 同样视为致命。
// [失败路径] 异常由上层转成失败状态，消息里不含 URL 原文，避免把有效授权码写进日志。
  parseCallbackParams(url: string): OAuthCallbackParams {
    // 回调 URL 必须是绝对地址，构造失败由上层按无效回调处理。
    const parsed = new URL(url);
    // code 优先标准参数名，authCode 只兼容旧 deep link，两者取其一。
    const code = parsed.searchParams.get("code") ?? parsed.searchParams.get("authCode");
    // state 只读标准参数名，缺失即无法做归属与 CSRF 校验。
    const state = parsed.searchParams.get("state");

    // 任一缺失都抛错，不尝试用空串继续，否则会拿无效凭据去换 token。
    if (!code || !state) {
      // 文案列出两种 code 参数名，方便定位是旧链接还是新回调缺参。
      throw new Error("OAuth 回调缺少 code/authCode 或 state 参数");
    }

    // 归属解析是可选增强，失败时返回 undefined 而不是中断回调。
    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    // attribution 为空时省略该键，保持 OAuthCallbackParams 的既有形状。
    return { code, state, ...(attribution ? { attribution } : {}) };
  }

// 只拼最小必需参数：redirect_uri 必须与 token 交换时提交的完全一致，否则后端按注册回调校验会拒绝；
// response_type 固定 code（隐式流拿不到后端需要的授权码）。state 原样透传，
// 回调阶段靠它做归属与缓存匹配，任何重编码都会破坏匹配。
  buildAuthorizeUrl(context: OAuthProviderContext): string {
    // 用 URLSearchParams 统一编码，避免手拼字符串时 state 中的特殊字符被截断。
    const query = new URLSearchParams({
      // redirect_uri 取 context 而不是 this，保证与本次授权请求注册的回调一致。
      redirect_uri: context.redirectUri,
      // 固定授权码模式，隐式流拿不到后端需要的 code。
      response_type: "code",
      // client_id 取 appId 配置，必须与后端注册的 OAuth 应用一致。
      client_id: this.config.appId,
      // state 原样透传，回调阶段靠它匹配缓存，重编码会破坏匹配。
      state: context.state,
    });

    // authorizeUrl 与查询串拼接后返回，调用方直接跳转，不再二次加工。
    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

// polling 与 deep link 两条入口在此汇合：都必须在落盘前换成业务 token，
// 否则同一种登录因入口不同而产生两种 accessToken 语义，下游无法区分。
// [事务] 交换失败即整体失败，不返回半成品，避免把不可用 token 持久化。
  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // CLI flow 的 ready.access_token 仍是 Z.AI OAuth token，而 Desktop
    // oauth:zai:access_token 的既有契约是 /api/auth/z/login 返回的业务 token。
    // polling 与 deep link 必须在同一 adapter 边界完成转换，避免两种登录方式落盘语义分裂。
    return {
      ...tokenSet,
      // 这里是唯一改写 token 语义的位置，返回副本不改动入参 tokenSet，调用方可安全复用原值。
      accessToken: await this.businessTokenResolver.resolve(tokenSet.accessToken),
    };
  }

  // callback 换 token 的入口，必须在这里完成业务 JWT 兑换，保证落盘值符合 INV-01。
  async exchangeToken(
    // params 只提供 code 与 state，redirect_uri 必须一律取 context，避免两处来源不一致。
    params: OAuthCallbackParams,
    // context 携带 state/redirectUri/now，是本次登录归属与时钟注入的唯一来源。
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    // 后端 OAuth token 路由排查时，原日志只记录了 404 结果，看不到客户端实际请求形态。
    // 这里记录 method/url/headers/body 结构，同时脱敏一次性 code，避免敏感授权码落盘。
    log("token request", {
      // 日志里的 method 只复刻真实请求，不能参与实际调用，改错会让排查误判路由。
      method: "POST",
      // url 取实例配置，与下面 readApiJson 的目标必须一致，否则日志会指向错误后端。
      url: this.config.tokenUrl,
      // 只记录 Content-Type，其它头可能带 cookie，不能进日志。
      headers: { "Content-Type": "application/json" },
      // 日志用 body 描述请求形状，必须与真实 body 分开构造，避免把脱敏值发出去。
      body: {
        // provider 固定枚举值，日志里出现它是为了确认兑换路由没有落错登录域。
        provider: ZAI_PROVIDER_ID,
        // 日志里 code 只留掩码，一次性授权码不得以可还原形式落盘。
        code: maskOAuthCode(params.code),
        // codeLength 补足长度信息，排查截断时不必依赖被掩码的字符串。
        codeLength: params.code.length,
        // redirect_uri 记录本次授权实际使用的回调，和 token 请求体保持同源。
        redirect_uri: context.redirectUri,
        // state 一并记录，便于把本次兑换与回调日志按同一值串联。
        state: context.state,
      },
    });

// [失败路径] 网络/HTTP 层异常经 logTokenResponseError 采样后原样抛出，
// 保证上层拿到的错误类型与字段不被适配器改写。
    let tokenPayload: ZaiBackendTokenPayload;
    try {
      // 响应按信封类型解析，readApiJson 失败会抛 ApiError，交给下面的 catch 采样。
      tokenPayload = await readApiJson<ZaiBackendTokenPayload>(
        this.apiClient,
        this.config.tokenUrl,
        {
          // 真实请求用 POST，与日志保持一致；改成 GET 会让后端按缺 body 拒绝。
          method: "POST",
          // 显式声明 JSON，后端靠它选择解析器，缺失会按表单格式读 body。
          headers: { "Content-Type": "application/json" },
          // zcode OAuth token 后端现在同时服务 Z.ai 和 BigModel。
          // 显式传 provider 枚举值，避免只依赖 redirect_uri 推断登录域导致兑换错路由。
          body: JSON.stringify({
            // 请求体同样带 provider，服务端据此决定回哪套 token 字段。
            provider: ZAI_PROVIDER_ID,
            // 真实请求发送原始 code，不能用掩码值，否则兑换必然失败。
            code: params.code,
            // redirect_uri 必须与授权请求一致，后端会做比对，取错来源会直接拒绝。
            redirect_uri: context.redirectUri,
            // state 原样回传，后端与本地都靠它确认这次回调属于哪个会话。
            state: context.state,
          }),
        },
      );
    } catch (error) {
      // 先采样再抛，采样只读错误字段，不改变异常本身。
      logTokenResponseError(error);
      // 原样重抛而不是包一层，保留 ApiError 类型供上层区分 HTTP 失败。
      throw error;
    }

    // ZAI token 响应在 adapter 内会立刻映射成 OAuthTokenSet，Root 层只能看到归一化后的登录结果，
    // 因此排查线上返回结构时看不到最终 response body。这里在映射前打印脱敏 body，保留 code/msg/data 结构，
    // 同时避免完整 access token 落盘。
    log("token final response body", sanitizeTokenPayloadForLog(tokenPayload));

// 信封约定 code === 0 成功，必须用严格不等号：undefined 也走失败分支，
// 缺 code 说明响应根本不是该后端契约（如网关错误页被解析成 JSON）。
// 优先透出后端 msg，缺失时才用本地兜底文案，避免通用错误吞掉可诊断信息。
    if (tokenPayload.code !== 0) {
      // msg 为空或全空白时回落本地文案，保证调用方永远拿到可展示的错误串。
      throw new Error(tokenPayload.msg?.trim() || "ZAI 后端 token 交换失败");
    }

// 两个 token 职责不同：zcodeJwtToken 供 zcode 自有服务识别身份，accessToken 供 Z.AI 业务调用。
// 任一缺失都不能继续——拿另一个冒充只会在后续调用点以 401 暴露，更难定位。
// 因此分别对 data.token 与 data.zai.access_token 做存在性校验，并在文案里给出缺失的字段路径。
    const zcodeJwtToken = tokenPayload.data?.token;
    // 缺 zcode JWT 即无法访问自有服务，必须在兑换阶段失败而不是等下游 401。
    if (!zcodeJwtToken) {
      // 文案点明缺失的是 data.token，与下面 access_token 的报错可区分。
      throw new Error("Token 交换失败：响应缺少 data.token");
    }

    // 从 zai 节点取 OAuth token，节点缺失时得到 undefined 并由下一行拦截。
    const accessToken = tokenPayload.data?.zai?.access_token;
    // 缺 Z.AI token 意味着拿不到业务 JWT，兑换不能半途返回。
    if (!accessToken) {
      // 文案点明缺失的是 data.zai.access_token，便于后端按字段定位契约漂移。
      throw new Error("Token 交换失败：响应缺少 data.zai.access_token");
    }
    // Z.AI 业务接口只认 /api/auth/z/login 返回的平台 JWT。
    // 这里在登录阶段完成转换，让 oauth:zai:access_token 持久化的就是业务 token，后续不再做兜底二次交换。
// [事务] 交换在返回 OAuthTokenSet 之前完成：成功则持久化的就是业务 token，
// 失败则整个登录失败，不存在「先落 OAuth token 再补换」的中间态。
// 不做二次兜底重试，重试交回登录入口，避免在适配器内隐藏失败次数。
    const businessAccessToken = await this.businessTokenResolver.resolve(accessToken);

    // data.user 可能为 null，这里统一收敛成 undefined 再交给有效性判定。
    const backendUser = tokenPayload.data?.user ?? undefined;
// 兑换响应已带回 user，先缓存给紧随其后的 fetchUserInfo 消费，省掉一次可能超时的 userinfo 请求。
// [并发] 写入是整体替换而非合并，新会话的 user 必须覆盖旧值，避免沿用上次的昵称。
    if (hasMeaningfulBackendUser(backendUser)) {
      // 此分支只写不清，清空由 else 分支负责，两条路径合起来保证缓存与本次响应一致。
      this.lastBackendUserProfile = {
        // 缓存绑定本次 state，读取时靠它排除跨会话消费。
        state: context.state,
        // 写入前先完成映射，fetchUserInfo 命中时可直接返回，不再做兜底。
        profile: toBackendUserProfile(backendUser),
      };
    } else {
      // 后端偶发不返回 data.user（或只返回空对象）时，之前会缓存 unknown/User 并短路后续 userinfo。
      // 这样登录后 UI 会长期显示兜底文案。缺失有效 user 时不缓存，允许 fetchUserInfo 走远端补偿。
      this.lastBackendUserProfile = null;
    }
// 用 context.now 而非 Date.now，保留测试注入固定时钟的能力；
// 未声明时省略 expiresAt 字段而不是写 null，维持「缺省即未知」语义。
    const expiresAt = normalizeExpiresIn(tokenPayload.data?.expires_in, context.now);

    // 返回前所有校验与兑换已完成，这里只组装最终 token 集合。
    return {
      // 对外暴露业务 JWT 而不是 OAuth token，这是 INV-01 的落点。
      accessToken: businessAccessToken,
      zcodeJwtToken,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  // 资料入口：优先消费兑换缓存，未命中才回源 userinfo，两条路径都不能因资料缺失丢登录。
  async fetchUserInfo(
    // 只用到 tokenSet.accessToken 作为 Bearer，其余字段不参与资料获取。
    tokenSet: OAuthTokenSet,
    // 下划线前缀只表示形参名避开未使用告警，函数体仍读 _context.state 做缓存归属校验。
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
// 命中必须同时满足「存在」与「state 相同」：state 不同属于另一次登录，
// 消费它会把 A 会话的昵称贴到 B 会话上。
// [资源] 命中即置空，保证一次兑换只被消费一次，否则远端资料更新永远不生效。
    if (this.lastBackendUserProfile?.state === _context.state) {
      // 先取资料再置空，顺序不能反，否则刚读到的对象会被自己清掉。
      const profile = this.lastBackendUserProfile.profile;
      // 命中即清空，保证一次兑换只被消费一次，远端资料更新才有机会生效。
      this.lastBackendUserProfile = null;
      // 返回缓存资料后不再请求 userinfo，省掉一次可能超时 60 秒的远端调用。
      return profile;
    }

    // 缓存未命中才走这里，请求失败按异常抛给上层，由登录流程收敛状态。
    const userinfoPayload = await readApiJson<ZaiUserInfoPayload>(
      this.apiClient,
      this.config.userinfoUrl,
      {
        // userinfo 是只读接口，必须用 GET，改成 POST 会被网关按未知路由拒绝。
        method: "GET",
        // 启动恢复登录态会阻塞 UI 的“恢复中”落定。
        // 如果这里没有超时兜底，弱网下请求可能长期挂起，界面会一直停在 loading。
        // 这里统一限制为 1 分钟，超时后按失败路径收敛状态，避免无限等待。
        timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
        // headers 里只放 Authorization 与 Content-Type，避免把桌面端标识等无关头带给第三方域。
        headers: {
          // Bearer 取 tokenSet.accessToken，必须是业务 JWT 才能通过 Z.AI 鉴权。
          Authorization: `Bearer ${tokenSet.accessToken}`,
          "Content-Type": "application/json",
        },
      },
    );
// 双包装兼容：优先 data（网关包装），否则把 payload 本身当 OIDC 直出结构。
// [失败路径] 缺字段不抛错，sub/id/name 全缺时必须回落 unknown：此时 token 已可用，
// 登录必须按成功收敛，资料缺失交给 UI 用 OAuthUserProfile 兜底展示。
    const user = userinfoPayload.data ?? userinfoPayload;

    // 按 sub、id 顺序回落，两者都缺时必须落 unknown，避免把空串当合法主体。
    const id = user.sub ?? user.id ?? "unknown";
    // 四级回落 name→preferred_username→email→id，保证 username 永不为空串。
    const username = user.name ?? user.preferred_username ?? user.email ?? id;

    // 组装 OAuthUserProfile，字段全部来自 userinfo，不再读兑换缓存。
    return {
      // 返回处的 id 复用 userinfo 算出的值，不做二次兜底。
      id,
      username,
      // userinfo 路径没有独立展示名，displayName 直接绑定 username 变量。
      displayName: username,
      // 这里不做 base64 归一，picture 按 OIDC 约定已是可展示 URL。
      avatarUrl: user.picture,
    };
  }

// 归一保证调用方永远拿到 Error：抛字符串/对象会丢堆栈与 instanceof，上层无法区分 OAuth 失败与代码缺陷；
// 已是 Error 的原样返回，保留 ApiError 的 status/responseHeaders 供日志采样。
  normalizeError(error: unknown): Error {
    // instanceof 判定覆盖 ApiError 等子类，保住 status 与 responseHeaders 供日志采样。
    if (error instanceof Error) {
      // 返回原对象而不是重建 Error，堆栈指向真正抛出点。
      return error;
    }

    // 非 Error 值用 String 序列化后包装，保证调用方拿到的永远是 Error 实例。
    return new Error(`ZAI OAuth 异常: ${String(error)}`);
  }
}
