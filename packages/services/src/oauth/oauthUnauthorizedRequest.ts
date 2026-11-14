// 文件职责：判定「某个出站请求是否携带当前 OAuth 登录凭据」，为 401 处理提供登出候选。
// 本文件只做候选判定，真正登出必须由 OAuthService 在会话变更队列内复核（见文末注释）。
// INV-01：只有请求 origin/pathname 命中当前平台业务前缀或 userinfo 接口才可能是 OAuth 请求
//   （守住位置：isOAuthBusinessRequest）。破坏后：普通 401 被当成登录失效，用户被无故登出。
// INV-02：请求头 token 必须与磁盘上「当前 provider」的 access token 完全一致
//   （守住位置：isCurrentBusinessOAuthCredentialRequest）。破坏后：旧平台 token 的 401
//   会清掉刚完成切换的新登录。
// INV-03：读凭据前后各读一次 active_provider，两次一致才返回 true；破坏后则用旧快照误判。
import {
  BIGMODEL_PROVIDER_ID,
  ZAI_PROVIDER_ID,
  buildBigModelApiUrl,
  buildRuntimeZaiBusinessUrl,
} from "@zcode/shared";
import type { ICredentialService } from "#src/credential/credential.js";
import { resolveBigModelUserinfoUrl } from "#src/oauth/providers/bigmodelProviderConfig.js";
import { resolveZaiUserinfoUrl } from "#src/oauth/providers/zaiProviderConfig.js";

// env 里的 base url 可能为空、被改错或不是 http(s)。解析失败返回 null 而不是抛错，
// 让调用方按「不是 OAuth 业务请求」处理：配置错误最多导致漏判登出，
// 绝不能因为环境变量写错就让 401 之后的登出判定全部失效。
function tryResolveHttpUrl(resolve: () => string | URL): URL | null {
  try {
    // resolve 延迟执行：只有调用方需要时才拼域名，失败由 catch 兜住。
    const url = new URL(resolve());
    // 只放行 http(s)：file:/ipc: 等协议不可能是 OAuth 业务请求。
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    // 构造 URL 抛错返回 null：调用方按「非 OAuth 请求」处理。
    return null;
  }
}

// 业务 token 也用于 PAT 签发与支付，只盯三条身份接口会漏掉这些入口的失效；
// 前缀而非精确路径：新增同前缀接口无需改表，但新前缀必须确认只接受登录 token。
const OAUTH_BUSINESS_PREFIXES = ["/api/biz/", "/api/pay/"] as const;

// 判定流程是「有 token -> 当前平台业务请求 -> token 精确匹配 -> provider 未被切换」四段短路，
// 前一段不成立立即返回，避免为无关请求读取磁盘凭据。
// [并发] 两次 await 之间平台可能已切换；末尾必须重读 active_provider 比对，不能复用首读快照。
async function isCurrentBusinessOAuthCredentialRequest(options: {
  // input 是待判定请求地址：业务域与 userinfo 都基于它比较。
  input: string | URL;
  // 请求头用于取 authorization：token 只从请求本身取。
  headers: Headers;
  // 只读 load：判定过程不写任何凭据，避免误改登录态。
  credentialService: Pick<ICredentialService, "load">;
  // env 供域名解析注入；缺省时各 resolver 用 process.env。
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  // 取原始 authorization 并 trim：空值与缺失都归一成空串。
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  // 无 authorization 头就没有候选 token，直接返回 false。
  if (!authorization) return false;

  // 首读 active_provider：后续业务域与 token 都以它为基准。
  const provider = await options.credentialService.load("oauth:active_provider");
  // 先判是否业务请求：不是就直接返回，避免为无关请求读 access token。
  if (!(await isOAuthBusinessRequest({ ...options, provider }))) return false;

  // [失败路径] token 缺失或与请求头不符说明用的是旧凭据，其 401 与当前登录无关。
  const accessToken = (
    await options.credentialService.load(`oauth:${provider}:access_token`)
  )?.trim();
  // 同时接受裸 token 与 Bearer 形式：两平台请求头写法不一致。
  if (!accessToken || (authorization !== accessToken && authorization !== `Bearer ${accessToken}`))
    // token 不匹配立即判否：旧凭据的 401 不能清掉当前登录。
    return false;
  // 读取磁盘期间可能切换平台，不能拿上一平台残留 token 的 401 清理当前登录。
  return (await options.credentialService.load("oauth:active_provider")) === provider;
}

// provider 可由调用方传入以避免重复读盘；未传时以磁盘的 active_provider 为准。
// 只识别 BigModel 与 ZAI：其他平台的 401 一律不进入 OAuth 登出流程。
export async function isOAuthBusinessRequest(options: {
  // input 是待判定的出站请求地址，字符串与 URL 都接受。
  input: string | URL;
  // 仅需 load：provider 未传时才读一次 active_provider。
  credentialService: Pick<ICredentialService, "load">;
  // env 可注入固定域名，避免测试依赖真实环境变量。
  env?: NodeJS.ProcessEnv;
  // provider 可选：调用方已读过时传入，传 null 表示明确无登录。
  provider?: string | null;
}): Promise<boolean> {
  // provider 可由调用方传入避免重复读盘；缺省才读 active_provider。
  const provider =
    options.provider ?? (await options.credentialService.load("oauth:active_provider"));
  // 只认两个内置 provider：其他平台 401 不触发 OAuth 登出。
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return false;
  // env 缺省 process.env：域名解析与真实发请求共用同一份配置。
  const env = options.env ?? process.env;
  // 候选请求先归一成 URL：非 http(s) 或非法字符串在这里被拦下。
  const requestUrl = tryResolveHttpUrl(() => options.input);
  // 非 http(s) 或无法解析的输入直接排除，避免把内部 IPC/文件 URL 当成 OAuth 请求。
  if (!requestUrl) return false;
  // 业务域名按平台分别解析，两条分支都读同一份 env，保证与真实发请求时的 base url 一致，
  // 避免 base url 硬编码后随环境替换而漂移，保证与真实请求同域。
  const buildBusinessUrl = (path: string) =>
    // 按 provider 选择 URL 构造函数：两者接受的 env 键不同。
    provider === BIGMODEL_PROVIDER_ID
      // BigModel 用 API 域拼路径：域名随 env 变化，不能硬编码。
      ? buildBigModelApiUrl(env, path)
      // ZAI 用 runtime 业务域：同一 path 在不同平台拼出不同 origin。
      : buildRuntimeZaiBusinessUrl(env, path);
  // 业务 token 也用于 PAT 签发和支付；仅检查三条身份接口会让这些入口的失效漏掉。
  // 域名/环境及 token 精确匹配仍由当前凭据分类器负责，模型 PAT 不会被当成登录 token。
  // 同时比较 origin 与 pathname 前缀：只比 pathname 会把别名域名下的同名路径误判为 OAuth 请求。
  if (
    OAUTH_BUSINESS_PREFIXES.some((path) => {
      // expected 解析失败按 null 处理：配置错误时该前缀直接跳过。
      const expected = tryResolveHttpUrl(() => buildBusinessUrl(path));
      // 三条件同时成立才算业务请求：origin、pathname 前缀与可解析的 expected。
      return (
        expected !== null &&
        requestUrl.origin === expected.origin &&
        requestUrl.pathname.startsWith(expected.pathname)
      );
    })
  )
    // 任一业务前缀命中即返回 true：origin 与 pathname 都已比对。
    return true;
  // userinfo 用精确 pathname 匹配（非前缀）：它是「取用户信息」的唯一入口，相邻路径不属于 OAuth 语义。
  const userinfo = tryResolveHttpUrl(() =>
    // 按 provider 分支解析 userinfo：两个平台的接口域名不同。
    provider === BIGMODEL_PROVIDER_ID
      // BigModel 优先取专用 userinfo URL：缺省时 resolver 自己回退业务域。
      ? resolveBigModelUserinfoUrl(env)
      // ZAI 的 userinfo 域名独立解析：与 BigModel 不共用 env 键。
      : resolveZaiUserinfoUrl(env),
  );
  // userinfo 用精确 pathname 匹配：前缀比较会把相邻接口误当成身份端点。
  return (
    userinfo !== null &&
    requestUrl.origin === userinfo.origin &&
    requestUrl.pathname === userinfo.pathname
  );
}

/** Host 私有的只读身份核验材料，不进入 RPC、配置或日志。 */
// 返回 Host 私有的只读核验材料（真实 URL + 裸 token + 空响应语义），供上层二次确认；
// 不进 RPC/配置/日志，避免 token 外泄。
// [权衡] 本地构造 customerInfo 探针而非解析原始请求：后者可能指向已下线接口。
export async function resolveOAuthBusinessCredentialValidationRequest(options: {
  // input 作为候选请求：只有命中业务前缀或 userinfo 才会返回材料。
  input: string | URL;
  // 原始请求头是唯一 token 来源：不接受调用方另行传入字符串。
  headers: Headers;
  // 只读 load 即可：核验材料全部现读，避免从 cache 复制旧 token。
  credentialService: Pick<ICredentialService, "load">;
  // env 供域名解析注入：缺省回落 process.env。
  env?: NodeJS.ProcessEnv;
}): Promise<{ url: string; authorization: string; emptyBodyMeansInvalid: boolean } | null> {
  // 先固定 provider：后续 URL 与 token 都必须基于同一个登录事实源。
  const provider = await options.credentialService.load("oauth:active_provider");
  // 非内置 provider 直接返回 null：其他平台的 401 不进入 OAuth 核验。
  if (provider !== BIGMODEL_PROVIDER_ID && provider !== ZAI_PROVIDER_ID) return null;
  // 复用候选判定；随后再读一次 active_provider，把「构造探针期间平台被切换」也排除掉。
  if (!(await isCurrentBusinessOAuthCredentialRequest(options))) return null;
  // 再读一次 active_provider：构造探针期间切号则放弃，避免用旧 provider 的 URL。
  if ((await options.credentialService.load("oauth:active_provider")) !== provider) return null;
  // env 缺省取 process.env：生产调用不传，测试可注入固定域名。
  const env = options.env ?? process.env;
  // 探针 URL 也必须过 http(s) 校验：非 http 输入无法用于出站请求。
  const url = tryResolveHttpUrl(() =>
    // 按 provider 选域名：两个平台的 business base url 来自不同 env 键。
    provider === BIGMODEL_PROVIDER_ID
      // BigModel 的 customerInfo 路径固定；域名由 buildBigModelApiUrl 按 env 拼出。
      ? buildBigModelApiUrl(env, "/api/biz/customer/getCustomerInfo")
      // ZAI 走 runtime 业务域：路径与 BigModel 相同，域名按 provider 解析。
      : buildRuntimeZaiBusinessUrl(env, "/api/biz/customer/getCustomerInfo"),
  );
  // 解析失败返回 null：环境变量写错时跳过探针，而不是抛出阻断 401 流程。
  if (!url) return null;
  // [失败路径] 这里的非空断言成立，因为上面的候选判定已确保 authorization 非空；
  // 去掉 Bearer 是必须的——两平台只接受裸 token，带 Bearer 会被判格式错而非登录失效。
  const token = options.headers
    .get("authorization")!
    .trim()
    .replace(/^Bearer\s+/i, "");
  // 返回三元组：URL、裸 token 与空响应语义，调用方据此二次确认登录。
  return {
    // 输出真实 URL 字符串：探针必须命中与业务请求相同的 origin。
    url: url.toString(),
    // 两平台 customerInfo 都要求裸业务 token；加 Bearer 会把格式拒绝误判成登录失效。
    authorization: token,
    // BigModel 注销后 customerInfo 返回零字节200；不扩散到 ZAI 或任意空业务响应。
    emptyBodyMeansInvalid: provider === BIGMODEL_PROVIDER_ID,
  };
}

// 对外别名 isCurrentOAuthBusinessCredentialRequest：保留旧名给调用方，逻辑不在这里复制。
export async function isCurrentOAuthBusinessCredentialRequest(options: {
  // input 原样传给底层：域名与 pathname 判定都在那一层完成。
  input: string | URL;
  // 凭据比对依赖原始 authorization 头，不能只看解析后的用户信息。
  headers: Headers;
  // 仅需 load：本函数只读 active_provider 与 access token。
  credentialService: Pick<ICredentialService, "load">;
  // env 透传到底层判据，保证业务域名解析与真实请求同源。
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  // 公开别名只做转发：内部实现保留给 resolveOAuthBusinessCredentialValidationRequest 复用。
  return isCurrentBusinessOAuthCredentialRequest(options);
}

// 这里只判定候选请求；实际退出须由 OAuthService 在会话变更队列内复核，不能依赖异步旧快照。
// 先比 zcode JWT 再退回业务 token：JWT 命中可短路，避免为每条请求读多次磁盘凭据。
export async function isCurrentOAuthCredentialRequest(options: {
  // input 可为字符串或 URL：tryResolveHttpUrl 统一归一成 URL 再比较。
  input: string | URL;
  // headers 为 Fetch Headers：authorization 取值大小写不敏感。
  headers: Headers;
  // 只需 load：JWT 判据不写任何凭据，避免拿到写权限。
  credentialService: Pick<ICredentialService, "load">;
  // env 可注入以便测试：缺省时回落到 process.env。
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  // 先 trim 再比较：请求头两侧空白会让 Bearer 前缀匹配失败。
  const authorization = options.headers.get("authorization")?.trim() ?? "";
  // 无 authorization 头直接排除：没有 token 就谈不上 OAuth 凭据。
  if (!authorization) return false;
  // zcodejwttoken 缺失归一成空串：后面用 currentJwt 真值判断，无需区分 null。
  const currentJwt = (await options.credentialService.load("zcodejwttoken"))?.trim() ?? "";
  // 命中共享 JWT 即短路：BigModel 与 ZAI 共用，先比它省一次 access token 读取。
  if (currentJwt && authorization === `Bearer ${currentJwt}`) return true;
  // 业务 token 分支复用同一判据：JWT 未命中时才读磁盘凭据。
  return isCurrentBusinessOAuthCredentialRequest(options);
}
