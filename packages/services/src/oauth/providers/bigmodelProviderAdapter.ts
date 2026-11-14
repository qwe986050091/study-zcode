// [INV] BigModel OAuth 适配器：把控制台的非标协议收敛成 OAuthProviderAdapter 契约。
// INV-01：accessToken 必须是 bigmodel.cn 业务 token，zcodeJwtToken 仅服务 Start Plan；
//         混写会让套餐预览稳定报令牌已过期（守住位置：resolveBigModelBusinessAccessToken）。
// INV-02：authCode 一次性，只允许 zcode token 路由消费；失败即中止整条登录，不落半登录态。
// INV-03：远端 userinfo 只经 string 判定后 trim，禁止把任意类型持久化为展示字段。
// INV-04：授权码不进日志，只允许脱敏前后缀（守住位置：maskOAuthCode）。
import {
  ApiError,
  BIGMODEL_PROVIDER_ID,
  type ApiClient,
  type OAuthCallbackParams,
  type OAuthProviderMeta,
  type OAuthTokenSet,
  type OAuthUserProfile,
} from "@zcode/shared";
import { readApiJson } from "../../providers/api/apiJson.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import { parseOAuthLoginAttribution } from "../callbackAttribution.js";
import type { OAuthProviderRuntimeConfig } from "../runtimeConfig.js";
import type { OAuthProviderAdapter, OAuthProviderContext } from "./providerAdapter.js";

// [字段映射] 响应体是历史包袱：`data.token` 是 zcode JWT，业务 token 只能从 `data.bigmodel.*` 取，顶层扁平写法更早。
// 顶层 access_token 是更早的扁平写法；读取优先级即语义，调整顺序会改变登录结果。
interface BigModelZcodeTokenEnvelope {
  // 业务码只在 `!== 0` 时进入失败分支；`undefined` 视为成功（旧网关不回该字段）。
  code?: number;
  // 失败时优先取 `msg.trim()` 作为用户可读文案，空串才回落拼接 code。
  msg?: string;
  // 整个业务载荷允许缺省，缺省时必须按缺 token 处理，不能回落到顶层字段。
  data?: {
    // zcode JWT，仅写入 `zcodeJwtToken`；`null` 与缺省等价。
    token?: string | null;
    // 旧扁平写法的业务 token，只在 bigmodel 子对象缺失时参与兜底。
    access_token?: string | null;
    // 同层驼峰别名，优先级低于 `access_token`，因为服务端历史上先下划线后驼峰。
    accessToken?: string | null;
    // 新版业务 token 容器；存在时优先级高于顶层扁平字段。
    bigmodel?: {
      // 业务 token 首选字段，直接用于 bigmodel.cn 鉴权，不能与 zcode JWT 混用。
      access_token?: string | null;
      // 同层驼峰别名，仅在 `access_token` 缺失时兜底。
      accessToken?: string | null;
      // Coding Plan 不返回该字段，缺失属合法；有值才写入 tokenSet。
      refresh_token?: string | null;
      // 同层驼峰别名，优先级低于 `refresh_token`。
      refreshToken?: string | null;
    } | null;
  } | null;
}

// [字段映射] customer 字段全部按 unknown 声明：远端可能返回数字/对象/空串，
// 在这里放宽类型是为了把脏数据挡在 readOptionalString 之外，而不是信任响应结构。
interface BigModelCustomerInfo {
  // 账号唯一 ID，可能为数字；只在展示前用 `readOptionalString` 收窄。
  customerNumber?: unknown;
  // 真实展示名首选，空串等同缺失，最终由 `resolveBigModelDisplayName` 兜底。
  customerName?: unknown;
  // 昵称，只在 `customerName` 为空时参与展示。
  nickName?: unknown;
  // 头像 URL，非 string 时丢弃而不是转成字符串。
  avatar?: unknown;
}

// [资源] 启动恢复是 UI 的阻塞态，没有超时会长期 pending、界面永久显示恢复中；
// 60s 是产品约定上限，改小会误杀慢网络下的正常恢复，改大则放大卡死窗口。
/** OAuth 启动恢复允许的最长等待时间（1 分钟） */
const OAUTH_USERINFO_TIMEOUT_MS = 60_000;
// 作用域固定 `bigmodelOAuth`，便于按 provider 过滤日志；授权码只以脱敏形式出现。
const log = createServiceLogger("bigmodelOAuth");

// [失败路径] 授权码是一次性凭据，日志出现全文等于泄露；短码无法保留前后缀，
// 短码只能全掩码，否则 `code.slice` 的 4+4 片段足以被拼回完整值。
function maskOAuthCode(code: string): string {
  // 短码分支必须排在切前后缀之前，否则 `slice` 会返回整串，等于没有脱敏。
  if (code.length <= 8) {
    // 用 `code.length` 生成等长掩码，日志里仍能看出凭据规模而不泄露内容。
    return "*".repeat(code.length);
  }

  // 前后 4 位足以人工比对同一次登录，同时不足以还原完整 code；三点占位固定宽度。
  return `${code.slice(0, 4)}...${code.slice(-4)}`;
}

// [失败路径] 只做类型收窄，不做 String(value) 兜底：把对象转成 [object Object]
// 会作为真实展示名持久化，后续 trim/比较都基于错误值且无法与真实数据区分。
function readOptionalString(value: unknown): string | undefined {
  // BigModel userinfo 是远端运行时数据，异常类型不能参与 trim 或持久化为展示字段。
  return typeof value === "string" ? value : undefined;
}

// 统一出口：所有展示字段先经过这里，保证空串与 `unknown` 都收敛成空字符串。
function readTrimmedString(value: unknown): string {
  // `|| ""` 把 undefined 归一为空串，调用方无需再判空即可参与 `||` 选择。
  return readOptionalString(value)?.trim() || "";
}

// [权衡] customerName 优先于 nickName，最后兜底 user：customerName 才是账号真实展示名，
// 空串在 API 语义上等同缺失，必须 trim 后再选，否则 UI 渲染成空白行。
function resolveBigModelDisplayName(customer: BigModelCustomerInfo): string {
  // 名字来源先取 customerName，再取 nickName；顺序决定最终展示，不能交换。
  const customerName = readTrimmedString(customer.customerName);
  // nickName 只是兜底，customerName 非空时即使昵称更长也不采用。
  const nickName = readTrimmedString(customer.nickName);
  // 三级兜底以 `||` 串联，空串视同缺失；返回 `user` 保证展示名永不为空。
  return customerName || nickName || "user";
}

/** BigModel OAuth 协议适配器 */
// [职责] 适配器只做协议翻译（字段命名、错误形态、token 语义），不持有会话状态；
// 所有 state 归上层 OAuth 服务，保证重登/取消时本层没有残留需要清理。
export class BigModelProviderAdapter implements OAuthProviderAdapter {
  // 对外标识直接复用 shared 常量，注册表与凭据键都由同一值派生，避免手写字符串漂移。
  readonly providerId = BIGMODEL_PROVIDER_ID;
  // meta 由构造期一次性固化，运行期改不了展示名或排序，避免 UI 排序抖动。
  readonly meta: OAuthProviderMeta;
  // 回调地址在构造时固化，授权与兑换两处必须取同一个值，否则 state 校验会失败。
  readonly redirectUri: string;
  // `apiClient` 由外部注入，适配器不自行创建请求层，测试可替换而不改协议逻辑。
  readonly apiClient: ApiClient;

  // `constructor` 只做字段固化，不能发起网络请求，实例化失败必然来自配置缺失。
  constructor(
    // config 私有持有，后续 authorizeUrl/tokenUrl 等端点都由它提供，不在类内重复常量。
    private config: OAuthProviderRuntimeConfig,
    // apiClient 由调用方注入后立即固化到实例，适配器内部不自行 new 客户端。
    apiClient: ApiClient,
  ) {
    // meta 只摘取对外可见的四项，appId/tokenUrl 等内部配置不能进入展示层。
    this.meta = {
      // id 取运行配置而不是常量，允许同一适配器按环境注册不同 provider 标识。
      id: config.id,
      // 展示名允许本地化覆盖，但必须与注册表同一来源，否则设置页与登录页会不一致。
      displayName: config.displayName,
      // enabled 由配置决定，禁用的 provider 仍保留实例，便于重新开启而无需重登。
      enabled: config.enabled,
      // order 决定登录页排序，值相同时按注册顺序稳定排列。
      order: config.order,
    };
    // redirectUri 单独提为字段，兑换时不再回读 config，保证授权与兑换使用同一地址。
    this.redirectUri = config.redirectUri;
    // `apiClient` 引用注入实例而非复制，请求层配置变更对适配器立即可见。
    this.apiClient = apiClient;
  }

// [权衡] 恒等返回而不复用 Z.AI 的二次兑换：polling ready 拿到的已是业务 token，
// 再兑换一次会打乱 Start Plan 的 code 路由并触发 HTTP 400，故此处刻意不变换。
  async normalizePolledTokenSet(tokenSet: OAuthTokenSet): Promise<OAuthTokenSet> {
    // polling ready 已返回 BigModel 业务 token；不走 Z.AI 的二次业务 token 兑换。
    return tokenSet;
  }

// [失败路径] 缺 code 或 state 立即抛错：带半截参数继续走会生成无法校验的登录请求，
// 错误停在适配器边界，上层据此判为回调不合法而非网络失败。
  parseCallbackParams(url: string): OAuthCallbackParams {
    // 用 `URL` 解析而不是手写 split，深链里出现重复参数时以首个值为准。
    const parsed = new URL(url);
    // BigModel 线上回调历史上用 authCode，新版可能回落为 code。
    // 这里同时兼容两个字段，避免控制台切换参数名时客户端直接登录失败。
    const code = parsed.searchParams.get("authCode") ?? parsed.searchParams.get("code");
    // state 只读取不比较：CSRF 校验由上层会话完成，适配器无权替它做判定。
    const state = parsed.searchParams.get("state");

    // 两个参数缺任一都不能进入兑换，因为兑换请求无法被服务端关联回发起会话。
    if (!code || !state) {
      // 文案同时点名 authCode/code 两个备选字段，让用户能区分回调地址错还是参数被网关丢弃。
      throw new Error("OAuth 回调缺少 authCode/code 或 state 参数");
    }

    // 归因参数与 code 分开解析，缺失时必须返回 undefined 而不是抛错，登录不能因营销参数失败。
    const attribution = parseOAuthLoginAttribution(parsed.searchParams);

    // 只有归因存在时才展开字段，避免把 undefined 写进回调结果后污染下游比较。
    return { code, state, ...(attribution ? { attribution } : {}) };
  }

// [权衡] 用 redirect/appId/state 三个非标参数名（而非 OAuth 标准 client_id），
// 因为 BigModel 控制台按此签名；改成标准名会被网关拒绝，故不追求形式统一。
  buildAuthorizeUrl(context: OAuthProviderContext): string {
    // 用 `URLSearchParams` 编码，state 里出现特殊字符时也能安全拼进查询串。
    const query = new URLSearchParams({
      // 回跳地址必须与注册时完全一致，服务端按字符串比对，多一个斜杠都会被拒。
      redirect: context.redirectUri,
      // appId 是控制台分配的应用标识，不是 OAuth 标准 client_id，改名会被网关直接拒绝。
      appId: this.config.appId,
      // state 必须原样透传，兑换阶段要与回调里的值一致，适配器不生成也不改写它。
      state: context.state,
    });

    // authorizeUrl 来自运行配置而非硬编码，测试环境可指向 mock 网关。
    return `${this.config.authorizeUrl}?${query.toString()}`;
  }

  // 对外入口只做一次委派，返回前复制 tokenSet，避免调用方改到内部对象。
  async exchangeToken(
    // params 来自回调解析，已保证 code 与 state 同时存在，这里不再重复校验。
    params: OAuthCallbackParams,
    // `_context` 前缀表示本层不使用，保留签名是为了满足 OAuthProviderAdapter 统一契约。
    _context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
    // 兑换失败直接向上抛，不在这里兜底成空 tokenSet，否则上层会误判登录成功。
    const tokenSet = await this.exchangeZcodeJwtToken(params, _context);

    // 返回新对象而不是原引用，防止后续步骤给 tokenSet 补充字段时回写兑换结果。
    return {
      ...tokenSet,
    };
  }

  // 实际兑换由私有方法承载，公开的 exchangeToken 只做转发，契约层因此不随实现调整。
  private async exchangeZcodeJwtToken(
    // params.code 是一次性凭据，本方法内只读取一次，失败后不能复用重试。
    params: OAuthCallbackParams,
    // context 提供 redirectUri 与 state 用于请求体，与授权阶段必须来自同一会话。
    context: OAuthProviderContext,
  ): Promise<OAuthTokenSet> {
// [权衡] 记录方法、URL 与 body 结构，但 code 必须走 maskOAuthCode：排查 400 需要
// 看 redirect_uri/state 是否与发起时一致，同时保证一次性授权码不落日志。
    log.info(undefined, "zcode token request", {
      // token 路由只接受 POST，改成 GET 会被网关按缺 body 拒绝。
      method: "POST",
      // url 必须取配置里的 tokenUrl，不能由 authorizeUrl 派生，否则测试网关与线上会串。
      url: this.config.tokenUrl,
      // 内容类型固定 JSON，服务端按此选择解析器，漏掉会得到 415 而不是业务码。
      headers: { "Content-Type": "application/json" },
      // 日志里的 body 只保留排查字段，真实请求体在下方 JSON.stringify 单独构造。
      body: {
        // provider 参与服务端路由，值必须与注册适配器时一致，否则会被当成未知渠道。
        provider: BIGMODEL_PROVIDER_ID,
        // 这里写掩码值而不是原文，日志脱敏必须在构造日志对象时就完成。
        code: maskOAuthCode(params.code),
        // `codeLength` 是排查 400 的关键证据：掩码后仍能区分空串、短码与正常码。
        codeLength: params.code.length,
        // 回跳地址必须与授权阶段一致，服务端会逐字符比对，不一致直接拒绝兑换。
        redirect_uri: context.redirectUri,
        // state 只用于核对会话，日志里保留可确认回调与发起是否同一次。
        state: context.state,
      },
    });

    try {
      // readApiJson 统一处理非 2xx 与 JSON 解析失败，抛出 ApiError 供 catch 采样。
      const payload = await readApiJson<BigModelZcodeTokenEnvelope>(
        this.apiClient,
        this.config.tokenUrl,
        {
          // 真实请求同样必须是 POST，body 里才是授权码；换成 query 会泄露到访问日志。
          method: "POST",
          // 只声明 JSON 类型，不带 Authorization：此刻还没有任何可用 token。
          headers: { "Content-Type": "application/json" },
          // zcode JWT 的后端 token 路由按 OAuth callback 授权码语义解析。
          // BigModel Start Plan 不能在后续 balance 查询阶段用 access_token 二次兑换，
          // 否则 body 与 Z.ai 登录链路不一致并触发 HTTP 400。provider 用 shared
          // 中的 OAuth provider 枚举值，避免前后端新增多 provider 后只靠 redirect_uri 猜身份。
          body: JSON.stringify({
            // 请求体 provider 与日志同源，避免两处各写字符串后路由到不同渠道。
            provider: BIGMODEL_PROVIDER_ID,
            // 唯一发送原文的位置，只在 HTTPS body 里出现，不能进入日志或错误文案。
            code: params.code,
            // 兑换时的回跳地址参与服务端校验，与授权请求必须逐字符相同。
            redirect_uri: context.redirectUri,
            // state 由服务端比对，缺失或改写都会让一次性 code 作废。
            state: context.state,
          }),
        },
      );
// [失败路径] 业务码非 0 说明网关接受了 HTTP 请求但拒绝兑换；此时 authCode 已被消费，
// 不能重试同一份 code，只能让用户重新授权，因此直接抛出可读错误终止链路。
      if (payload.code !== undefined && payload.code !== 0) {
        // BigModel 的一次性 authCode 现在只交给 zcode token 路由。
        // 如果这里失败，不能继续保存半登录态，否则 Start Plan 仍会显示未连接。
        log.warn(undefined, "zcode token business response rejected", {
          // 业务码与 msg 一起记录，由两者区分参数被拒还是服务端内部错误。
          code: payload.code,
          // msg 直接来自服务端，可能为空；排查时以 code 为准，不能把 msg 当稳定错误码。
          msg: payload.msg,
        });
        // 抛出带原始 msg 的错误而不是固定文案，用户能直接看到服务端的拒绝原因。
        throw new Error(
          payload.msg?.trim() || `BigModel zcode token 交换失败（code: ${payload.code}）`,
        );
      }
// [失败路径] data.token 是 Start Plan 的唯一凭证，缺失时连半登录都不成立：
// 提前失败优于写入空串，否则空 jwt 会让后续 Start Plan 请求稳定 401。
      const zcodeJwtToken = payload.data?.token?.trim() || "";
      // 空串与缺省都走失败分支，因为后续 Start Plan 请求必须携带非空 JWT。
      if (!zcodeJwtToken) {
        // message 用固定英文串，便于按关键字聚合告警，取值不能随响应内容变化。
        log.warn(undefined, "zcode token response missing data.token", {
          // 记录业务码用于判断是否已扣授权码，但日志不写 data 本体避免泄露。
          code: payload.code,
          // msg 可能包含上游提示，只能作为上下文附在 warn 里，不能参与控制流。
          msg: payload.msg,
        });
        // 报错点名 data.token，调用方据此判定是响应结构问题而非网络失败。
        throw new Error("BigModel zcode token 交换失败：响应缺少 data.token");
      }
// [字段映射] 业务 token 的读取顺序由 resolveBigModelBusinessAccessToken 统一维护，
// 调用点不重写 `resolveBigModelBusinessAccessToken` 的读取链，否则两处优先级不一致时会读出两种结果。
      const accessToken = resolveBigModelBusinessAccessToken(payload);
      // 业务 token 缺失与 zcode JWT 缺失分开报错，因为两者影响的功能面不同。
      if (!accessToken) {
        // Coding Plan 付费套餐仍调用 bigmodel.cn 业务接口，只能使用
        // BigModel 业务 access token；zcode JWT 只能写入 zcodejwttoken 给 Start Plan 使用。
        // 如果继续把 zcode JWT 写进 oauth:bigmodel:access_token，套餐预览会稳定报“令牌已过期”。
        log.warn(undefined, "zcode token response missing bigmodel access token", {
          // 走到这里 `payload.code` 通常为 0，仍记录以便确认不是被网关改写过的成功响应。
          code: payload.code,
          // 该分支 msg 常为空，保留字段是为了与其它 warn 的结构保持一致。
          msg: payload.msg,
        });
        // 文案精确到 data.bigmodel.access_token，避免误判成旧扁平字段缺失。
        throw new Error("BigModel zcode token 交换失败：响应缺少 data.bigmodel.access_token");
      }

// [字段映射] refresh token 允许缺省（Coding Plan 不返回），存在时才写入结果：
// 用条件展开而非写 undefined，避免下游把无凭证误判为值为 undefined 的凭证。
      const refreshToken =
        payload.data?.bigmodel?.refresh_token?.trim() ??
        // `refreshToken` 驼峰别名排在最后，只有下划线写法缺失时才采用。
        payload.data?.bigmodel?.refreshToken?.trim() ??
        // 空串表示没有 refresh token，后续条件展开据此决定是否写入字段。
        "";
      // 返回值只含契约字段，zcode JWT 与业务 token 各归其位，不能互换。
      return {
        // 该字段最终写入 oauth:bigmodel:access_token，是后续业务请求的唯一入口。
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        zcodeJwtToken,
      };
// [失败路径] 捕获后只补结构化诊断再重抛：error 本身（含 ApiError 的 status/url）是
// 上层归一化的输入，包成新 Error 会丢 status，前端无法区分鉴权失败与网络故障。
    } catch (error) {
      // BigModel callback code 是一次性的，客户端不能再先调用
      // tokenByAuthCode 消费它；zcode token 交换失败时直接中止登录并记录链路头。
      log.warn(undefined, "zcode token request failed", {
        // 统一收敛成 message 字段，非 Error 抛出值必须用 String 兜底，不能直接拼接对象。
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof ApiError
          // 只有 ApiError 才补齐请求上下文，普通 Error 没有这些字段可写。
          ? {
              // method 指向实际失败的请求动词，便于区分是授权阶段还是兑换阶段拒绝。
              method: error.method,
              // status 是 HTTP 状态码，上层据此区分 401 鉴权失败与 5xx 服务端故障。
              status: error.status,
              // url 记录实际请求地址，配置串错时能直接看出打到了哪个网关。
              url: error.url,
              // 响应头可能带限流或追踪标识，缺失时必须用空对象占位，不能让日志结构抖动。
              responseHeaders: error.responseHeaders ?? {},
            }
          // 非 ApiError 不补诊断对象，保持 warn 结构稳定而不是塞空字段。
          : {}),
      });
      // 原样重抛，不包装成新 Error，否则 ApiError 的 status/url 会丢失。
      throw error;
    }
  }

// [权衡] fetchUserInfo 只做展示信息补全，缺失一律降级为 unknown/user：
// 登录是否成功已由 token 决定，在这里抛错会把能用的登录态改成失败。
  async fetchUserInfo(
    // 入参只读取 accessToken 与 zcodeJwtToken，不修改调用方持有的 tokenSet。
    tokenSet: OAuthTokenSet,
    // `_context` 不使用，保留参数是为了与适配器接口签名一致。
    _context: OAuthProviderContext,
  ): Promise<OAuthUserProfile> {
// [失败路径] zcode JWT 不能调用 bigmodel.cn customer 接口（签名体系不同），
// 提前短路可避免一次必然 401 的请求把日志与监控刷脏，因为 zcode JWT 无法通过 customer 接口鉴权。
    if (tokenSet.zcodeJwtToken && tokenSet.accessToken === tokenSet.zcodeJwtToken) {
      // 移除 tokenByAuthCode 后 callback 阶段没有 BigModel access token。
      // zcode JWT 不能调用 bigmodel.cn 的 customer 接口，避免无意义的鉴权失败请求。
      return {
        // 没有业务 token 时无法确认身份，用 unknown 占位而不是抛错。
        id: "unknown",
        // 展示名降级为 user，保证 UI 不出现空白行；真实昵称等后续登录补全。
        username: "user",
        // displayName 与 username 分开：前者供展示，后者参与匹配，两者语义不能混用。
        displayName: "User",
      };
    }

// [资源] 这是启动恢复的关键链路，超时上限见 OAUTH_USERINFO_TIMEOUT_MS；
// 超时后让异常向上冒泡，由上层把恢复态落定为失败，而不是无限等待。
    const userinfoPayload = await readApiJson<{
      // 只声明 data 一层，远端多包一层时会落到下面的缺失兜底而不是静默成功。
      data?: BigModelCustomerInfo;
    }>(this.apiClient, this.config.userinfoUrl, {
      // userinfo 是纯读取，GET 语义也决定了不能在这里携带授权码。
      method: "GET",
      // 启动恢复登录态依赖这条 userinfo 校验链路。
      // 没有超时时网络层可能长期 pending，导致 UI 一直显示“恢复中”。
      // 这里固定 1 分钟超时，保证失败路径可及时落定，避免无限 loading。
      timeoutMs: OAUTH_USERINFO_TIMEOUT_MS,
      // 头对象只放鉴权与内容类型，超时参数必须在请求选项层设置，不能混进 headers。
      headers: {
        // BigModel customer 信息接口要求 Authorization 直接传 token，
        // 不能使用 Bearer 前缀，否则稳定返回鉴权失败。
        Authorization: tokenSet.accessToken,
        "Content-Type": "application/json",
      },
    });
// [失败路径] data 缺失等价于远端无该账号信息，返回占位 profile 而非抛错，
// 保持登录成功、展示信息待补的语义，缺失字段由 `readOptionalString` 兜底。
    const customer = userinfoPayload.data;

    // data 为空不等于账号不存在，只说明本次没取到资料，因此必须降级而不是抛错。
    if (!customer) {
      // 占位 profile 与鉴权短路返回同构，调用方无需区分两条降级路径。
      return {
        // 没有 customerNumber 时用 unknown，后续补全逻辑据此判断是否需要回填。
        id: "unknown",
        // 固定 user 而不是空串，保证下游按 username 建索引时不会生成空键。
        username: "user",
        // 展示名与 username 取值不同，是为了区分内部标识和给人看的文本。
        displayName: "User",
      };
    }

    // BigModel customerName 是账号真实展示名，nickName 只是昵称兜底；
    // 空字符串在 API 语义上等同缺失，必须 trim 后再选择，避免账号展示为空白。
    const username = resolveBigModelDisplayName(customer);

    // 成功分支同样只返回展示字段，token 不能进入 profile，避免凭据随用户信息扩散。
    return {
      // customerNumber 可能是数字，必须先收窄成 string，否则原始类型会写进 id。
      id: readOptionalString(customer.customerNumber) ?? "unknown",
      username,
      // displayName 复用已解析的 username，避免两处各算一次导致展示不一致。
      displayName: username,
      // 头像缺失时写 undefined 而不是空串，让 UI 走默认图而不是加载空 URL。
      avatarUrl: readOptionalString(customer.avatar),
    };
  }

// [兼容] 旧版只写 auth_token/refresh_token 两个 credential；在 provider 层做一次兼容读取，
// 避免升级后被误判为未登录而强制用户重新授权。
  async loadLegacyTokenSet(
    // `loadCredential` 由调用方注入，适配器不直接接触凭据存储，便于测试替换。
    loadCredential: (key: string) => Promise<string | null>,
  ): Promise<OAuthTokenSet | null> {
    // 旧版只写 auth_token 这一个键，读不到即判定旧登录态不存在。
    const accessToken = await loadCredential("auth_token");
    // 没有旧版 token 直接返回 null，不能靠 refresh_token 单独拼出登录态。
    if (!accessToken) {
      // null 表示无旧版登录态，不能返回空 tokenSet，否则上层会误判为已登录。
      return null;
    }

    // refresh_token 单独读取，旧版可能只存了 access token。
    const refreshToken = await loadCredential("refresh_token");

    // 旧版 BigModel 登录态只写 auth_token/refresh_token，
    // 如果不在 provider 层做兼容，升级后会被误判为“没有 token”。
    return {
      // 旧版字段映射到新契约时只填 accessToken，zcodeJwtToken 留空。
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
  }

// [失败路径] 归一化只保证结果一定是 Error：保留原 Error 实例以保住 stack 与 status 判定，
// 仅包装非 Error 的抛出值，使上层 catch 不必再做类型判断。
  normalizeError(error: unknown): Error {
    // 已经是 Error 必须原样返回，保留 stack 与子类信息，不能二次包装。
    if (error instanceof Error) {
      // 返回原实例而不是复制 message，上层 instanceof 判定才能继续生效。
      return error;
    }

    // 非 Error 抛出值才包装，并加 BigModel 前缀便于定位来源。
    return new Error(`BigModel OAuth 异常: ${String(error)}`);
  }
}

// [字段映射] 业务 token 优先级：bigmodel.access_token > bigmodel.accessToken >
// 顶层 access_token > 顶层 accessToken；顺序即语义，调整会让新版响应被旧字段覆盖。
function resolveBigModelBusinessAccessToken(payload: BigModelZcodeTokenEnvelope): string {
  // 四条读取由 `resolveBigModelBusinessAccessToken` 统一维护，调用点不重复分支。
  return (
    payload.data?.bigmodel?.access_token?.trim() ??
    // 新版驼峰字段排第二，仍属于 bigmodel 容器，必须优先于顶层扁平写法。
    payload.data?.bigmodel?.accessToken?.trim() ??
    // 顶层下划线字段是旧版响应，只有 bigmodel 容器整体缺失时才会命中。
    payload.data?.access_token?.trim() ??
    // 顶层驼峰写法优先级最低，保留它只为兼容早期 beta 客户端抓到的响应。
    payload.data?.accessToken?.trim() ??
    // 全部缺失返回空串，由调用方按缺 token 处理，这里不抛错以保持纯函数。
    ""
  );
}
