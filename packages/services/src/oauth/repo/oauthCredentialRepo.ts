/* eslint-disable max-lines -- OAuth 凭据仓储集中维护 ZAI/BigModel 登录镜像 key 边界，拆分会让鉴权事实源更难追踪。 */
// OAuth 凭据仓储：把 provider 维度的登录事实（token / user_info / 归属参数）镜像到加密凭据服务。
// 本文件不产生登录事实，只负责命名空间、覆盖语义与损坏态恢复；任何 key 改名都等于强制全体用户登出。
//
// INV-01：oauth:<provider>:* 是唯一命名空间，同一 provider 的读写必须走同一 key 构造函数（守住：accessTokenKey/refreshTokenKey/userInfoKey）。
//   破坏后果：写入与读取各走一套 key，导致登录后立即被判为未登录，旧密文也永远留在磁盘上。
// INV-02：zcode JWT 只有一份，由 ZAI/BigModel 共享；登出这两个 provider 时必须一起删除（守住：shouldClearZcodeJwtOnLogout）。
//   破坏后果：残留 JWT 让已登出的账号继续换取额度，或让另一个 provider 读到错配的身份。
// INV-03：解密失败等价于本地登录态不可信，必须整体清理而不是返回 null（守住：clearCorruptOAuthSession）。
//   破坏后果：半清理状态下 active provider 指向已空的密钥组，用户无法自助恢复登录。
// INV-04：active provider 是互斥域的唯一事实源，token 只能写到当前 active provider 下（守住：saveActiveTokenSet）。
//   破坏后果：并发登录两个 provider 时后写者覆盖前者，UI 显示的账号与实际 token 不一致。
// INV-05：refresh token 缺省代表「该 provider 不支持刷新」，必须显式 delete 旧值而不是保留（守住：saveTokenSet）。
//   破坏后果：服务端已吊销的 refresh token 被反复取出重试，刷新链路永久 401。
import { Buffer } from "node:buffer";
import type {
  OAuthLoginAttribution,
  OAuthProviderId,
  OAuthTokenSet,
  OAuthUserProfile,
} from "@zcode/shared";
import { BIGMODEL_PROVIDER_ID, isCredentialDecryptError, ZAI_PROVIDER_ID } from "@zcode/shared";
import type { ICredentialService } from "../../credential/credential.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";

// active provider 独立于 provider 命名空间：它描述「当前登录的是谁」，清理单个 provider 时不能顺手删掉，
// 否则重新登录会失去默认账号，启动恢复退化为未登录。
const ACTIVE_PROVIDER_KEY = "oauth:active_provider";
// 归属参数与 provider 无关，故放在全局 key：换 provider 登录不应把渠道来源丢掉。
const LOGIN_ATTRIBUTION_KEY = "oauth:login_attribution";
// [权衡] 该 key 不带 provider 前缀，因为 ZAI 与 BigModel 共用同一份 Start Plan JWT；
// 带上前缀会强迫 balance/runtime 去猜当前 provider，猜错就读不到额度。
const ZCODE_JWT_TOKEN_KEY = "zcodejwttoken";
// 默认清理集合：损坏态下必须在不知道当前 provider 的情况下也能把已知命名空间清干净，
// 因此这里硬编码内置 provider，而不是依赖调用方传入。
const KNOWN_OAUTH_PROVIDER_IDS = [BIGMODEL_PROVIDER_ID, ZAI_PROVIDER_ID] as const;
// 损坏恢复里的清理失败只降级记录：这条日志是排查「登出后仍显示旧账号」的唯一线索。
const log = createServiceLogger("oauthCredentialRepo");

// 可注入项只覆盖 provider 集合与派生凭据清理回调：加密实现与存储位置不允许替换，否则密钥来源会分叉。
interface OAuthCredentialRepoOptions {
  // providerIds 是外部追加的 provider：与内置两个合并后用于损坏清理。
  providerIds?: readonly OAuthProviderId[];
  // 回调只负责派生凭据清理：SSH 等独立凭据不在这条链路里。
  onCorruptOAuthSessionCleared?: (providerIds: readonly OAuthProviderId[]) => Promise<void>;
}

// key 只能由 provider 拼出，禁止调用方自带字符串：key 拼错不会报错，只会静默读到 null。
function accessTokenKey(provider: OAuthProviderId): string {
  // 前缀固定 oauth:，与读取侧共用同一个构造函数；调用方自带字符串会绕开这层保证。
  return `oauth:${provider}:access_token`;
}

// 与 access token 同构命名：删除时按前缀成组清理才不需要枚举每种凭据的拼写。
function refreshTokenKey(provider: OAuthProviderId): string {
  // 删除时依赖这个字面量；改名会让旧密文永久滞留，且刷新链路读不到新 key。
  return `oauth:${provider}:refresh_token`;
}

// userInfoKey 与 tokenKey 同构：只换末段后缀，provider 前缀保持 oauth: 不变。
function userInfoKey(provider: OAuthProviderId): string {
  // user_info 单独成 key：清 profile 时不能连带删 token，否则在线会话立刻掉线。
  return `oauth:${provider}:user_info`;
}

// 合并内置与外部 provider 后再去重保序：清理顺序稳定，日志与回调里的 provider 列表才可复现。
function collectKnownOAuthProviderIds(
  // 默认空数组让调用方可省略该参数：缺省时只清理内置 provider。
  providerIds: readonly OAuthProviderId[] = [],
): OAuthProviderId[] {
// 用 Set 去重：外部注入与内置列表重叠时重复 clearProvider 会多打一轮 delete，且回调会收到重复 id。
  const uniqueProviderIds = new Set<OAuthProviderId>(KNOWN_OAUTH_PROVIDER_IDS);
  // 遍历外部 provider：每个 id 都追加到 Set，重复的由 Set 自动忽略。
  for (const providerId of providerIds) {
    // Set 会按插入顺序保序，因此外部 provider 必须追加在内置之后；否则清理顺序变化会让日志里的 provider 列表不可复现。
    uniqueProviderIds.add(providerId);
  }
  // 转数组返回新副本：调用方修改结果不会影响内置常量 KNOWN_OAUTH_PROVIDER_IDS。
  return [...uniqueProviderIds];
}

// 头像可能以裸 base64 存入，恢复时要补回 data URL 的 MIME；按魔数判断而不是信任后端字段。
// 兜底返回 png：浏览器对错误 MIME 的 base64 会显示裂图，而 png 至少能触发 onError 走占位图。
function inferBase64ImageMimeType(decoded: Buffer): string {
  // 只按字节魔数判断：文件名与后端 MIME 字段都可被上游随意填写，信任它们会把非图片当成头像渲染。
  if (
    // PNG 魔数 89 50 4E 47 只判前四字节；长度不足 8 的片段必须留给兜底分支，不能在这里抛错。
    decoded.length >= 8 &&
    decoded[0] === 0x89 &&
    decoded[1] === 0x50 &&
    decoded[2] === 0x4e &&
    decoded[3] === 0x47
  ) {
    // 命中 PNG 魔数返回 image/png：前四字节已足以区分 png 与其它格式。
    return "image/png";
  }

  // JPEG 以 FF D8 FF 开头；长度 3 是能区分该魔数的最短前缀，避免把空 Buffer 判成 jpeg。
  if (decoded.length >= 3 && decoded[0] === 0xff && decoded[1] === 0xd8 && decoded[2] === 0xff) {
    // 返回 image/jpeg：FF D8 FF 是 jpeg 文件头的最短判别前缀。
    return "image/jpeg";
  }

  // GIF 头是 ASCII 的 GIF 三字母，用 toString 比较比逐字节写三个魔数常量更省。
  if (decoded.length >= 6 && decoded.toString("ascii", 0, 3) === "GIF") {
    // 返回 image/gif：GIF 三字母在偏移 0，后续字节无需再判。
    return "image/gif";
  }

  // WEBP 条件块：必须同时满足 RIFF 容器与偏移 8 的 WEBP 标记。
  if (
    decoded.length >= 12 &&
    decoded.toString("ascii", 0, 4) === "RIFF" &&
    // WEBP 必须同时命中 RIFF 容器与偏移 8 的 WEBP 标记；只看 RIFF 会把 wav/avi 误判成图片。
    decoded.toString("ascii", 8, 12) === "WEBP"
  ) {
    // 双标记都命中才返回 image/webp：单看 RIFF 会误判 wav/avi。
    return "image/webp";
  }

  // 未知格式回落 png：浏览器对错误 MIME 会触发 img onError，页面至少能切到占位图。
  return "image/png";
}

// 只接受「可无损往返」的 base64：这既过滤掉普通 URL/昵称，也避免把半截字符串当成头像展示。
// [失败路径] 任意一步不满足返回 null，由调用方回退到原文，绝不抛错阻塞登录恢复。
function toBase64ImageDataUrl(raw: string): string | null {
  // 先去掉所有空白（含换行）：base64 常被按 76 列折行，不清理会让下面的字符集正则必然失败。
  const normalized = raw.replace(/\s/g, "");
  // 长度下限 16 过滤昵称与短 ID；字符集白名单保证 Buffer.from 解码不会静默跳过字符。
  if (normalized.length < 16 || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    // 长度不足或字符集不符返回 null：调用方按非 base64 处理，不改写原文。
    return null;
  }

  // 先用宽松解码拿到字节，再用下一步的往返比较验证它确实是合法 base64。
  const decoded = Buffer.from(normalized, "base64");
  // 全 padding 或纯空白输入会解出空 Buffer，它不可能是头像，直接判为非 base64。
  if (decoded.length === 0) {
    // 解出空 Buffer 返回 null：全 padding 输入不可能是头像数据。
    return null;
  }

// 往返比较前去掉填充：不同后端对 padding 的处理不一致，严格比较会把合法头像误判为非 base64。
  // 往返比较：Buffer 遇到非法字符会跳过，只有再编码回原串才能证明无损；两边都去 padding 以兼容后端差异。
  const encoded = decoded.toString("base64").replace(/=+$/, "");
  // 往返比较失败即非法 base64：Buffer 解码会跳过非法字符，只有再编码一致才算无损。
  if (encoded !== normalized.replace(/=+$/, "")) {
    // 返回 null 让上层回退原文：宁可显示坏字符串，也不把非 base64 当头像渲染。
    return null;
  }

  // MIME 由字节魔数推断，而不是信任后端字段；拼上 data: 前缀后可直接作为 img src。
  return `data:${inferBase64ImageMimeType(decoded)};base64,${normalized}`;
}

// ZAI 的历史数据可能已是 data URL、http URL 或裸 base64，三种都必须能直接作为 <img> 的 src，所以统一在这里归一。
function normalizeStoredZaiAvatarUrl(avatar: string | undefined): string | undefined {
// 先 trim 再判断形态：后端偶尔返回带空白的 base64，不 trim 会让正则与往返比较全部失败。
  const trimmed = avatar?.trim();
// 空头像返回 undefined 而不是空串：空串会被当作合法 src，触发一次无意义的图片请求。
  if (!trimmed) {
    // 该分支只处理假值：trim 后为空串或原值缺失，都归一到 undefined。
    return undefined;
  }

// 已是可直接渲染的形态就原样返回：重复包一层 data: 前缀会让浏览器拒绝加载。
  if (/^data:image\/[^;]+;base64,/i.test(trimmed) || /^https?:\/\//i.test(trimmed)) {
    // 命中 data:image 或 https?:// 正则即返回原文，不再做 base64 往返校验。
    return trimmed;
  }

// 非 data/http 形态才尝试 base64 还原：先排除合法 URL，避免把短 URL 误判成 base64 后改写。
  // 到这里只剩裸 base64 一种可能；还原失败就原样返回，保留原文比返回 undefined 更能暴露数据问题。
  const dataUrl = toBase64ImageDataUrl(trimmed);
  // dataUrl 非空说明往返校验通过：裸 base64 已转成可直接渲染的 data URL。
  if (dataUrl) {
    // 返回转换结果：调用方拿到的 src 已带 MIME，无需再判格式。
    return dataUrl;
  }

  // 兜底返回 trimmed：让 UI 至少拿到可显示文本，而不是静默丢掉头像字段。
  return trimmed;
}

// 兼容「按后端 data.user 原样持久化」的旧记录：恢复时现场映射展示字段，而不是要求重新登录。
function toOAuthUserProfileFromRawZaiUser(raw: Record<string, unknown>): OAuthUserProfile | null {
  // raw 来自持久化密文，必须当成不可信输入：每个字段先做 typeof 收窄，直接信任会在 UI 渲染时抛 TypeError。
  const id = typeof raw.user_id === "string" ? raw.user_id : "unknown";
  // name 先 trim 再存：后端昵称常带首尾空白，直接展示会让布局抖动。
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  // email 不做 trim：它只用于展示与退化，保持原值避免改变用户可见字符。
  const email = typeof raw.email === "string" ? raw.email : "";
// 展示名按 name→email→id 退化：三者都空时上层已返回 null，这里只需保证用户名永不为空串。
// [权衡] 不用 id 覆盖 name：id 是后端主键，用户改昵称后 UI 不应突然变成一串数字。
  const username = name || email || id;
  // 头像可能缺字段或为空串，统一交给归一函数；它返回 undefined 时下面的展开不会写入该键。
  const avatarUrl = normalizeStoredZaiAvatarUrl(
    typeof raw.avatar === "string" ? raw.avatar : undefined,
  );

  // name/email/id 全空说明这不是可用账号（例如后端错误体被当成 user 落盘）：返回 null 让上层回退未登录。
  if (!name && !email && id === "unknown") {
    // 该判据覆盖「只有 id=unknown」的情况：后端错误体被当成 user 落盘时走这里。
    return null;
  }

  // 构造 profile 字面量：rawProfile 保留原文，供后续账号态排查。
  return {
    // id 直接取收窄后的值：unknown 只会在上方全空判据里被拦下。
    id,
    username,
    // displayName 与 username 同值：ZAI 旧记录没有独立昵称字段。
    displayName: username,
    ...(avatarUrl ? { avatarUrl } : {}),
    // rawProfile 原样挂回：调用方靠它还原后端 data.user 结构。
    rawProfile: raw,
  };
}

/** OAuth 凭据仓储：统一 provider 命名空间 */
// 仓储只依赖 ICredentialService：加密落盘与文件路径都由该服务负责，本层只看得到凭据读写接口，不碰密钥。
export class OAuthCredentialRepo {
// 构造后不再变化：损坏清理遍历的就是这份快照，运行期追加 provider 不会被清到。
  private readonly knownProviderIds: OAuthProviderId[];

// knownProviderIds 在构造时固化：运行期若动态扩表，损坏清理可能漏掉新 provider 或误删外部 provider。
  constructor(
    // credentialService 由构造参数注入：加密与落盘位置都在该服务，仓储只调接口。
    private credentialService: ICredentialService,
    // options 带默认值：调用方不传 providerIds 时只清理内置两个 provider。
    options: OAuthCredentialRepoOptions = {},
  ) {
// 初始化即合并去重：把归一放在构造函数里，避免每个清理入口各自拼列表而漏掉 provider。
    this.knownProviderIds = collectKnownOAuthProviderIds(options.providerIds);
// 回调原样保存（不包 try/catch）：调用点负责吞掉失败，便于把「派生清理失败」与「主清理失败」区分开。
    this.onCorruptOAuthSessionCleared = options.onCorruptOAuthSessionCleared;
  }

  // onCorruptOAuthSessionCleared 可选：未注入时损坏清理只做本地密文 delete。
  private readonly onCorruptOAuthSessionCleared?: (
    // 回调参数是本次清理的 provider 列表：与 knownProviderIds 同源，便于派生凭据对齐。
    providerIds: readonly OAuthProviderId[],
  ) => Promise<void>;

// 对外只暴露异步门面：调用方无法绕过解密异常分类直接触达凭据服务。
  async getActiveProvider(): Promise<OAuthProviderId | null> {
// 直接委托而不是缓存：active provider 可能被其它窗口改写，缓存会让本进程长期认为旧账号仍在线。
    return this.loadActiveProvider();
  }

// 与 getActiveProvider 成对：写入同样不缓存，保证下一次读取能立刻看到登出结果。
  async setActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    // 前置条件：provider 必须来自登录流程校验过的 id；这里不做白名单校验，任意字符串都会被写成 active 事实源。
    await this.saveActiveProvider(provider);
  }

// [失败路径] 解密失败不向上抛：active provider 读不出来意味着本机密钥已变（换机/重置），
// 此时清理可恢复数据比让整个启动流程失败更有用。
  async loadActiveProvider(): Promise<OAuthProviderId | null> {
    try {
      // load 返回 null 表示未登录；返回非法字符串的责任在写入侧，这里不做二次校验。
      return await this.credentialService.load(ACTIVE_PROVIDER_KEY);
    } catch (error) {
      // 只有 isCredentialDecryptError 命中才等价于本机密钥已变；IO/权限错误原样上抛，避免把可恢复故障误判成要清空登录态。
      if (!isCredentialDecryptError(error)) {
        // 非解密 error 原样抛出：只有密钥变化才走损坏清理，环境故障不能清空登录态。
        throw error;
      }

      // 清理后返回 null：损坏态下重试只会再次失败，交给用户重新登录是唯一可自愈的路径。
      await this.clearCorruptOAuthSession();
      // 清理完成后返回 null：调用方按未登录继续，不再重试已损坏的密文。
      return null;
    }
  }

// 传 null 表示登出：必须 delete 而不是写空串，否则 loadActiveProvider 会返回非法 provider id。
  async saveActiveProvider(provider: OAuthProviderId | null): Promise<void> {
    // provider 为 null 表示登出：进入 delete 分支，不写入任何占位值。
    if (!provider) {
      // delete 而不是写空串：空串会被 loadActiveProvider 当成合法 provider id 返回给调用方。
      await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
      // 提前 return 跳过 save：登出只需要删除指针，无需再写一次空值。
      return;
    }

    // App 登录恢复为 oauth:* 镜像，active provider 是互斥 provider 域的唯一事实源。
    // 保存失败原样上抛：active provider 是互斥域的唯一事实源，吞错会让内存态与磁盘态分叉。
    await this.credentialService.save(ACTIVE_PROVIDER_KEY, provider);
  }

// 先取 active provider 再取 token：两跳读取之间没有事务，切换账号的瞬间可能读到另一 provider 的 token，
// 因此结果只用于展示/恢复，写路径必须各自重新确认 provider。
  async loadActiveTokenSet(): Promise<OAuthTokenSet | null> {
    // 写前重新读一次 active provider：调用方持有的可能是上一次登录的 provider。
    const provider = await this.loadActiveProvider();
    // active 为 null 表示未登录：直接结束，不再调用 loadTokenSet 读空命名空间。
    if (!provider) {
      // 返回 null 而不是空 tokenSet：上层按未登录处理，不会误以为已有会话。
      return null;
    }

// 不做回退候选 provider：active provider 已由登录流程确定，回退会让两个账号的 token 互相污染。
    // loadActiveProvider 与 loadTokenSet 两跳之间没有事务，切换账号的瞬间可能读到另一 provider 的 token。
    const tokenSet = await this.loadTokenSet(provider);
    // 有 token 就返回；没有也不回退到其它 provider，避免把两个账号的凭据混在一起。
    if (tokenSet) {
      // tokenSet 非空直接返回：access 与 JWT 都已读到，无需在本层再合并。
      return tokenSet;
    }

    // 兜底返回 null：tokenSet 为空说明 access key 缺失，等价于无会话。
    return null;
  }

// [失败路径] active provider 缺失时直接抛错：静默写入任意 provider 会让下一次启动读到错配的账号。
  async saveActiveTokenSet(tokenSet: OAuthTokenSet): Promise<void> {
    // 前置条件：写 token 前必须确认 active provider；否则 token 会落到上一个账号的命名空间，按 active 读回时串号。
    const provider = await this.loadActiveProvider();
    // provider 为 null 时进入拒绝分支：saveActiveTokenSet 不允许在无 active 时猜目标命名空间。
    if (!provider) {
      // 缺 active 时抛错而不是静默跳过：静默会让 token 永远不落盘，UI 却显示登录成功。
      throw new Error("保存当前登录 token 前缺少 active provider");
    }
    // provider 确定后才落盘：saveTokenSet 内部不再读 active，避免同一次写入读两遍。
    await this.saveTokenSet(provider, tokenSet);
  }

// 与 loadActiveTokenSet 同构：profile 只作为展示数据，缺失时返回 null 而不影响 token 可用性。
  async loadActiveUserProfile(): Promise<OAuthUserProfile | null> {
    // 顺序约束：先取 active 再读 profile；反序会读到上一个账号的展示数据，切号瞬间尤其明显。
    const provider = await this.loadActiveProvider();
    // active 为 null 走空返回分支：profile 的命名空间未知，任何 provider 都不能代替。
    if (!provider) {
      // 失败后果：active 缺失只能返回 null，不能回退到任意 provider，否则会把别人的头像显示成当前账号。
      return null;
    }

// profile 缺失不代表会话失效：保留 null 返回，避免账号页因为一次读失败就跳回登录。
    // profile 只从当前 active provider 读取；跨 provider 回退会把另一个账号的头像显示给当前用户。
    const profile = await this.loadUserProfile(provider);
    // profile 非空即返回：displayName/avatarUrl 已由 loadUserProfile 归一。
    if (profile) {
      // 原样返回归一结果：本层不再拼 active provider，避免与 loadUserProfile 重复校验。
      return profile;
    }

    // profile 为空返回 null：调用方按未登录展示，token 仍可继续使用。
    return null;
  }

// [失败路径] 无 active provider 时拒绝写入：profile 若落在错误命名空间，下次登录会显示上一位用户的头像与名字。
  async saveActiveUserProfile(profile: OAuthUserProfile): Promise<void> {
    // 写入前重读 active：profile 必须跟随当前账号，不能沿用调用方缓存的旧 provider。
    const provider = await this.loadActiveProvider();
    // active 缺失直接抛错：profile 落到错误命名空间会让下次登录显示上一位用户。
    if (!provider) {
      // 抛错让调用方感知失败：静默返回会让账号页显示旧 user_info，排查时看不出写入被跳过。
      throw new Error("保存当前登录 user 前缺少 active provider");
    }
    // provider 已确认非空才落盘；saveUserProfile 内部不再校验 active，避免同一次写入读两遍。
    await this.saveUserProfile(provider, profile);
  }

// 只持久化白名单字段（channel_id/utm_*）且要求非空：归属参数会进埋点，不能让任意扩展字段上送。
  async saveLoginAttribution(attribution: OAuthLoginAttribution): Promise<void> {
// flatMap 过滤空值而不是写空串：loadLoginAttribution 以「无有效字段」为删除信号，空串会绕过该判断。
    // flatMap 只保留非空白字符串值：空值写进密文会让 loadLoginAttribution 的「无有效字段」判断失效。
    const persistAttribution = Object.fromEntries(
      Object.entries(attribution).flatMap(([key, value]) => {
        // 只保留非空白字符串：空值写进密文会让「无有效字段」的删除信号失效，归属被误判为存在。
        const trimmed = typeof value === "string" ? value.trim() : "";
        // 只保留非空字符串：空值写进密文会让 loadLoginAttribution 的「无有效字段」信号失效。
        return trimmed ? [[key, trimmed]] : [];
      }),
    );

    // persistAttribution 全空必须早返回：空对象落盘后，loadLoginAttribution 每次登录都会多走一遍「解析后删除」。
    if (Object.keys(persistAttribution).length === 0) {
      // 提前 return 不写 LOGIN_ATTRIBUTION_KEY：写入空对象会让读取侧把空值当成有效归属。
      return;
    }

// 整包覆盖而非合并：归属参数属于一次登录的事实，合并会把上一次渠道残留到本次会话。
    await this.credentialService.save(LOGIN_ATTRIBUTION_KEY, JSON.stringify(persistAttribution));
  }

// 读取同样做白名单过滤：旧版本可能写入过已废弃字段，直接透传会把脏数据带进新的埋点链路。
  async loadLoginAttribution(): Promise<OAuthLoginAttribution | null> {
    // 显式声明为 string | null：try 内赋值、catch 内直接返回，读取结果只在这两种形态间流转。
    let raw: string | null;
    try {
// 归属信息损坏不值得阻断登录：解密失败按未登录处理，不触发 OAuth 会话清理。
      // 读取失败分两类：解密错误降级为 null，其它错误（IO/权限）继续上抛，避免把环境问题吞成「没有归因」。
      raw = await this.credentialService.load(LOGIN_ATTRIBUTION_KEY);
    } catch (error) {
      // 分支条件：只有 isCredentialDecryptError 命中才降级，其余错误类型直接走 throw。
      if (!isCredentialDecryptError(error)) {
        // 非解密 error 原样抛出：归因读取失败不该被误判成密文损坏。
        throw error;
      }
      // 损坏归因按不存在处理：返回 null 且不触发 OAuth 会话清理。
      return null;
    }

    // 读不到密文即无归因：返回 null 而不是空对象，调用方按缺席渲染。
    if (!raw) {
      // 空值直接返回 null：空串 JSON.parse 会抛，提前返回省一次异常。
      return null;
    }

    try {
      // 旧密文可能是 { params, expiresAt } 包装或扁平字段，JSON.parse 后两种形状都要能读，不能假设新格式。
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // 兼容本分支早期保存过的 { params, expiresAt } 结构；取消 TTL 后只读取 params。
      const storedParams =
        parsed.params && typeof parsed.params === "object"
          // 新格式取 params 子对象：早期密文带 expiresAt 包装，直接读顶层会读不到渠道字段。
          ? (parsed.params as Record<string, unknown>)
          // 旧格式本身就是扁平字段，直接用 parsed 作为读取源。
          : parsed;

      // 三个键各自 trim 后判空：单个键为空就丢弃，而不是保留空串占位。
      const params = Object.fromEntries(
        Object.entries(storedParams).flatMap(([key, value]) =>
          // 白名单三键：channel_id/utm_source/utm_campaign 之外的键一律丢弃，避免脏数据进埋点。
          (key === "channel_id" || key === "utm_source" || key === "utm_campaign") &&
          typeof value === "string" &&
          value.trim()
            // 命中白名单且非空才保留：value.trim() 为空说明该渠道字段无效。
            ? [[key, value.trim()]]
            // 未命中的键返回空数组：flatMap 会把它整体丢掉，不产生空串占位。
            : [],
        ),
      ) as OAuthLoginAttribution;
      // 白名单全空视为密文失效：顺手 delete 掉，避免每次登录重复解析同一份无用数据。
      if (Object.keys(params).length === 0) {
        // 三个白名单键全被过滤掉说明 LOGIN_ATTRIBUTION_KEY 已失效，顺手删除可避免每次登录重复解析同一份无用数据。
        await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
        // 无有效归属返回 null：调用方按「没有渠道来源」处理，而不是拿到空对象。
        return null;
      }
      // 返回过滤后的 params：只有三个白名单键，且值都已 trim。
      return params;
    } catch {
      // JSON 解析失败同样删除：损坏的归因没有修复价值，保留只会让每次启动都走异常分支。
      await this.credentialService.delete(LOGIN_ATTRIBUTION_KEY);
      // JSON 解析失败也返回 null 并删除：损坏归因没有修复价值，保留只会让每次启动都走异常分支。
      return null;
    }
  }

// [事务] 顺序固定：先清 provider 命名空间，再删 active 指针。反序若中途失败，
// active 已空而 token 仍在，用户会被判未登录却仍持有可用的密文。
  async clearActiveSession(): Promise<void> {
    // 读 active 时若命中解密失败，loadActiveProvider 内部已完成损坏清理；这里继续删指针是幂等的。
    const activeProvider = await this.loadActiveProvider();
    // active 为空时跳过 clearProvider，但仍要执行下面的 delete，保证指针不会指向已删除的命名空间。
    if (activeProvider) {
      // 先清 provider 命名空间：clearProvider 内部按 access→refresh→user_info 逐个 delete。
      await this.clearProvider(activeProvider);
    }
    // 再删 active 指针：顺序反了会让中途失败留下「无指针但有 token」的半登出态。
    await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
  }

// 没有 access token 即视为无会话：不能因为 refresh token 存在就返回 half set，
// 否则调用方会拿空 access 去请求并触发无意义的 401。
// [失败路径] 任一字段解密失败都走整体清理，不接受「部分读到」的中间态。
  async loadTokenSet(provider: OAuthProviderId): Promise<OAuthTokenSet | null> {
    try {
      // access token 是会话存在的唯一判据；它缺失时直接返回 null，不再读 refresh 与 JWT。
      const accessToken = await this.credentialService.load(accessTokenKey(provider));
      // access token 是会话存在的唯一判据：它缺失就不再读 refresh 与 JWT。
      if (!accessToken) {
        // 无 access 直接返回 null：此时 refresh 存在也不算会话，避免调用方拿空 access 去请求。
        return null;
      }

// refresh token 可以是 null（不支持刷新），因此不能当作会话存在的前提；access token 才是。
      // refresh 允许为 null（provider 不支持刷新），因此它的值不参与「是否有会话」的判断。
      const refreshToken = await this.credentialService.load(refreshTokenKey(provider));

      // JWT 取值分两支：内置 provider 读共享 key，自定义 provider 直接置 null。
      const zcodeJwtToken =
        provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID
// JWT 与 provider 不是一一对应：这里只按内置 provider 判断，避免自定义 provider 读到别人的 JWT。
// [权衡] 读取失败会与 access token 一起走整体清理，代价是该 provider 需重新登录，但不会留下混用身份的窗口。
          // 共享 JWT 只在内置 provider 下读取；自定义 provider 读到它会把别人的身份带进请求。
          ? await this.credentialService.load(ZCODE_JWT_TOKEN_KEY)
          // 自定义 provider 不读共享 JWT：否则会把 ZAI/BigModel 的身份带进自己的请求。
          : null;

      // 返回 tokenSet：只包含确实存在的字段，缺省键由条件展开省略。
      return {
        // accessToken 必然存在：上面已判空，构造对象时无需再做兼容。
        accessToken,
        // 用条件展开而不是写 undefined：输出对象里不会出现值为 undefined 的键，调用方无需判断存在性。
        ...(refreshToken ? { refreshToken } : {}),
        ...(zcodeJwtToken ? { zcodeJwtToken } : {}),
      };
    } catch (error) {
      // 只有解密失败才清理会话；isCredentialDecryptError 之外的错误上抛，避免把环境问题判成登出。
      if (!isCredentialDecryptError(error)) {
        // 非解密 error 原样抛出：上层据此区分密文损坏与磁盘/权限故障。
        throw error;
      }

      // 只有解密失败才等价于登录态损坏；IO/权限错误原样上抛，避免把环境问题清成「用户被登出」。
      await this.clearCorruptOAuthSession();
      // 清理后返回 null：损坏态下重试只会再失败，交给用户重新登录是唯一自愈路径。
      return null;
    }
  }

// 轻量路径只读两个 key 且用 Promise.all：启动早期需要尽快拿到可用凭据，不等待 refresh/user_info。
  async loadCachedSessionTokens(
    // provider 决定 accessTokenKey 的命名空间；它与 JWT key 不同，后者全局共享。
    provider: OAuthProviderId,
  ): Promise<{ key: string; value: string }[] | null> {
    try {
      // 两个 key 并行读：启动早期只等一次 IO，不必串行等 JWT 再等 access token。
      return await Promise.all(
        // 缺失的 key 归一成空串而不是 null：调用方按「值是否为空」判断，避免两种空值形态。
        [ZCODE_JWT_TOKEN_KEY, accessTokenKey(provider)].map(async (key) => ({
          // 原样回传 key：调用方靠它区分哪个值是 JWT、哪个是 access token。
          key,
          // 缺失与空白都归一成空串：调用方只判 value 是否为空，不再区分 null。
          value: (await this.credentialService.load(key))?.trim() ?? "",
        })),
      );
    } catch (error) {
      // isCredentialDecryptError 命中时必须交给下面的清理边界；其它错误说明是环境问题，直接上抛。
      if (!isCredentialDecryptError(error)) throw error;
      // 启动轻量检查曾绕过仓储的解密异常分类，导致业务 token 损坏时恢复直接失败。
// 这里返回 null 而不是空数组：空数组会被上层当作「读取成功但值为空」，掩盖了密钥已变的事实。
      // 复用既有 OAuth 清理边界，不读取 refresh token，也不触发远端资料迁移。
      await this.clearCorruptOAuthSession();
      // 损坏态返回 null：空数组会被上层当成读取成功但值为空，掩盖密钥已变的事实。
      return null;
    }
  }

// 覆盖语义：access token 必须写；refresh token 缺失时删除旧值而不是保留，
// 因为服务端可能在本次刷新中撤销了旧 refresh token。
  async saveTokenSet(provider: OAuthProviderId, tokenSet: OAuthTokenSet): Promise<void> {
    // access token 无条件写入：它为空的 tokenSet 由上层类型与调用点保证不会传进来。
    await this.credentialService.save(accessTokenKey(provider), tokenSet.accessToken);

// [权衡] 逐字段写入而非整包 JSON：单个 key 损坏只影响对应字段，恢复时能定位到具体凭据。
    if (tokenSet.refreshToken) {
      // 写入的是本次刷新拿到的值，不保留上一代 refresh token，避免重放已吊销的凭据。
      await this.credentialService.save(refreshTokenKey(provider), tokenSet.refreshToken);
    } else {
      // 缺 refreshToken 时显式 delete：保留旧值会让服务端已吊销的凭据被反复重试。
      await this.credentialService.delete(refreshTokenKey(provider));
    }

// 只有这两个 provider 消费 zcode JWT；其它 provider 写入或删除它都会破坏当前登录的额度查询。
    if (provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID) {
// 两个分支都必须落盘：有 JWT 就覆盖写入，缺省则删除旧值，保留旧 JWT 会让 balance/runtime 继续以旧身份请求。
      if (tokenSet.zcodeJwtToken) {
        // BigModel Start Plan 与 Z.ai Start Plan 一样消费 zcode JWT。
        // JWT 必须在 OAuth callback 阶段随 tokenSet 落盘，后续 balance/runtime 只读取它，
        // 不能再拿 BigModel access token 拼另一个 /oauth/token body 临时兑换。
        await this.credentialService.save(ZCODE_JWT_TOKEN_KEY, tokenSet.zcodeJwtToken);
      } else {
        // 缺 JWT 时删除旧值：残留的旧 JWT 会让 balance/runtime 继续以旧身份请求。
        await this.credentialService.delete(ZCODE_JWT_TOKEN_KEY);
      }
    }
  }

// 按 provider 读取而不是读 active：调用方（如账号切换列表）可能需要在非当前账号上做展示。
  async loadUserProfile(provider: OAuthProviderId): Promise<OAuthUserProfile | null> {
    // 前置条件：provider 必须与写入时一致；这里不校验账号是否存在，未知 id 只会读到 null 而不是报错。
    return this.loadUserProfileFromKey(userInfoKey(provider), provider);
  }

// profile 解析失败一律返回 null 而不是抛错：用户信息是展示数据，不能让损坏的缓存阻断登录。
  private async loadUserProfileFromKey(
    // key 由 loadUserProfile 按 provider 拼好传入，本方法不再拼前缀，避免命名规则分叉。
    key: string,
    // provider 仅用于旧格式回填：只有 ZAI 才走 user_id/name 映射分支。
    provider?: OAuthProviderId,
  ): Promise<OAuthUserProfile | null> {
    // 读取与解析分开 try：读取阶段的解密错误要清会话，解析阶段的坏数据只需要返回 null。
    let raw: string | null;
    try {
      // key 由调用方按 provider 构造；这里不再拼前缀，避免两处命名规则分叉。
      raw = await this.credentialService.load(key);
    } catch (error) {
      // 只有解密错误才降级返回 null；IO/权限错误继续上抛，避免把环境故障吞成坏数据。
      if (!isCredentialDecryptError(error)) {
        // 非解密 error 原样抛出：调用方据此区分「密钥变了」与「磁盘暂时不可读」。
        throw error;
      }

      // 命中解密错误即整体清理：半清理会让 active 指向已空的密钥组。
      await this.clearCorruptOAuthSession();
      // 清理后返回 null：损坏 profile 不可恢复，让上层按未登录继续。
      return null;
    }

    // 读不到密文即视为无 profile：返回 null 而不是抛错，账号页按未登录渲染。
    if (!raw) {
      // 空值直接返回 null：JSON.parse 空串必抛，提前返回省一次异常。
      return null;
    }

    try {
      // 按 Partial 解析：旧密文可能缺 avatarUrl/rawProfile，逐字段校验比整体断言安全。
      const parsed = JSON.parse(raw) as Partial<OAuthUserProfile>;
      // 三个展示字段必须同时是 string：缺一说明密文来自更早版本，转旧格式分支。
      if (
        // typeof 三个展示字段都是 string 才按新格式接受；缺一说明密文来自更早版本，交给下面的旧格式分支。
        typeof parsed.id === "string" &&
        typeof parsed.username === "string" &&
        typeof parsed.displayName === "string"
      ) {
// 只接受字符串头像：历史数据里 avatarUrl 可能是对象或 null，透传会让 <img src> 收到非字符串。
        const avatarUrl = typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined;
        // rawProfile 只在是对象时接受：密文里可能是 null 或字符串，原样透传会让调用方按对象访问时抛错。
        const rawProfile =
          typeof parsed.rawProfile === "object" && parsed.rawProfile !== null
            // 对象分支直接取原值：ZAI 旧记录依赖 rawProfile 回溯后端 data.user。
            ? parsed.rawProfile
            // 非对象一律置 undefined：条件展开时该键不会出现在返回对象里，调用方无需判存在性。
            : undefined;
        // 返回归一化 profile：字段逐个显式列出，避免密文里的多余键泄漏到调用方。
        return {
          // id 已在上面的 typeof 校验中确认是 string，这里直接透传，不再做二次收窄。
          id: parsed.id,
          // username 同为已校验字符串，不做 trim 以免改变既有账号的显示名。
          username: parsed.username,
          // displayName 与 username 分开保存：旧记录两者可能不同，读取时不能互相覆盖。
          displayName: parsed.displayName,
          ...(avatarUrl ? { avatarUrl } : {}),
          ...(rawProfile ? { rawProfile } : {}),
        };
      }

// ZAI 旧记录是后端 data.user 原文，只有该 provider 能按 user_id/name/avatar 回填；
// 其它 provider 套用这套映射会得到 id=unknown 的假账号。
      // 旧格式只对 ZAI 生效：其它 provider 套用 user_id/name 映射会得到 id=unknown 的假账号。
      if (provider === ZAI_PROVIDER_ID && typeof parsed === "object" && parsed !== null) {
        // ZAI user_info 现在按后端 data.user 原样持久化，
        // 启动恢复时需要从 user_id/name/avatar 重新映射展示字段。
// 归一化失败（无 id/name/email）时继续落到 return null，而不是返回部分字段的半成品 profile。
        const zaiProfile = toOAuthUserProfileFromRawZaiUser(parsed as Record<string, unknown>);
        // 映射成功才返回：toOAuthUserProfileFromRawZaiUser 返回 null 表示旧记录字段全空。
        if (zaiProfile) {
          // 直接返回映射结果：rawProfile 已原样带出，上层可继续按 data.user 排查账号态。
          return zaiProfile;
        }
      }
    } catch {
      // ignore parse error and fallback to null
    }

    // 新旧格式都无法识别时返回 null：损坏 profile 只影响展示，不能让读取抛错阻断登录。
    return null;
  }

// 覆盖写入，不做字段级合并：合并会让已删除的 avatar 或旧 email 永久残留。
  async saveUserProfile(provider: OAuthProviderId, profile: OAuthUserProfile): Promise<void> {
    // ZAI 后端返回的 data.user 是后续账号态排查与恢复的源数据，
    // 之前只保存归一化展示字段会丢失 email/name/avatar 原始结构。
    const persistProfile =
      // ZAI 优先持久化后端 data.user 原文，其余 provider 存归一化 profile；两者结构不同，读侧已分别处理。
      provider === ZAI_PROVIDER_ID && profile.rawProfile ? profile.rawProfile : profile;

    // 整包 JSON 落盘：save 为覆盖写，不做字段合并，避免已删除的 avatar 残留。
    await this.credentialService.save(userInfoKey(provider), JSON.stringify(persistProfile));
  }

// 只删 user_info：profile 失效不代表 token 失效，误删 token 会让仍在运行的会话立刻掉线。
  async clearUserProfile(provider: OAuthProviderId): Promise<void> {
    // 前置条件：provider 必须与保存时一致；用错 provider 会删掉另一个账号的展示数据，且不会报错。
    await this.credentialService.delete(userInfoKey(provider));
  }

// 清理按字段逐个 delete 且顺序无关：任一步失败都会留下其它字段，但不会产生新的可读会话。
// 共享 JWT 单独判断，避免清 BigModel 时误删仍在使用的 ZAI 会话。
  async clearProvider(provider: OAuthProviderId): Promise<void> {
    // 三个 key 逐个 delete：凭据服务没有批量删除接口；中途失败最多留下不可组合使用的孤立字段。
    // 顺序约束：access token 必须最先删；它是会话存在的唯一判据，先删它就能保证中途失败也不会留下可用会话。
    await this.credentialService.delete(accessTokenKey(provider));
    // refresh token 必须与 access token 一起删：只删 access 会让刷新链路继续用旧凭据换新 token。
    await this.credentialService.delete(refreshTokenKey(provider));
    // user_info 最后删：展示数据残留不产生可读会话，但不删会显示已登出账号的旧资料。
    await this.credentialService.delete(userInfoKey(provider));
    // 共享 JWT 只在登出内置 provider 时删除；清自定义 provider 时删它会误伤当前登录。
    if (shouldClearZcodeJwtOnLogout(provider)) {
      // 共享 JWT 的删除条件由 shouldClearZcodeJwtOnLogout 决定，与 saveTokenSet 的写入条件一致。
      await this.credentialService.delete(ZCODE_JWT_TOKEN_KEY);
    }
  }

// 串行清理而非 Promise.all：凭据服务底层可能对同一文件加锁，并发写会相互失败。
  async clearAll(providers: OAuthProviderId[]): Promise<void> {
    // 串行而非 Promise.all：凭据服务可能对同一存储文件加锁，并发 delete 会互相失败。
    for (const provider of providers) {
      // 逐个 provider 串行清理：clearProvider 内部已按 access→refresh→user_info 顺序 delete。
      await this.clearProvider(provider);
    }

    // 最后删 active 指针：先清命名空间再失效指针，中途失败时用户至少处于可重新登录的状态。
    await this.saveActiveProvider(null);
  }

  // 损坏清理的唯一入口：loadActiveProvider、loadTokenSet 等解密失败分支都汇到这里。
  private async clearCorruptOAuthSession(): Promise<void> {
    // AES-GCM 解密失败说明当前运行时已经无法信任本地 OAuth 登录态。
    // 等价于强制登出已注册 OAuth provider：先清 provider 命名空间与共享 zcode JWT，
    // 再通知 service 层清理 Start/Coding Plan 这类派生模型凭据，同时避免误删 SSH 等其他独立凭据。
// 不读取 active provider 再清理：active 本身可能正是损坏的那个，读它会再次触发解密失败。
    // 清理面覆盖所有已知 provider：漏掉的那个会在下次启动继续抛同样的解密错误。
    for (const provider of this.knownProviderIds) {
      // 遍历 knownProviderIds 全清：漏掉任一 provider，下次启动仍会抛同样的解密错误。
      await this.clearProvider(provider);
    }
    // 最后删 active 指针：命名空间清空后指针必须失效，否则下次启动会指向空密钥组。
    await this.credentialService.delete(ACTIVE_PROVIDER_KEY);
    try {
      // 回调在 OAuth 密文清完之后才执行：即使回调抛错，主登录态也已回到可重新登录的未登录态。
      await this.onCorruptOAuthSessionCleared?.(this.knownProviderIds);
    } catch (error) {
      // 派生模型 provider 清理失败不能阻断 OAuth 损坏态恢复。
      // 主 OAuth 凭据已经删除，用户必须能回到可重新登录的未登录态。
// 这里必须用 warn 而非 error：主 OAuth 密文已经删除，用户能重新登录，派生凭据残留属于可恢复降级。
      log.warn(undefined, "clear derived provider keys after corrupt OAuth session failed", error);
    }
  }
}

// 共享 JWT 的删除条件与写入条件必须一致；两处若分叉，会留下「登出后仍可查额度」的漏洞。
function shouldClearZcodeJwtOnLogout(provider: OAuthProviderId): boolean {
  // 删除条件与 saveTokenSet 的写入条件必须一致；任一侧分叉都会留下登出后仍可查额度的残留。
  return provider === ZAI_PROVIDER_ID || provider === BIGMODEL_PROVIDER_ID;
}
