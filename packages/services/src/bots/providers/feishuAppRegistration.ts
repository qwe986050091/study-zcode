type FeishuAppRegistrationDomain = "feishu" | "lark";

// 文件不变量表（飞书应用一键注册：init 探测 -> begin 拿 device code -> poll 换 client_secret）：
// INV-08：app_secret 只在内存中从 poll 响应交给调用方，不写日志、不拼进 URL、不落盘；
//   本文件不做任何凭据缓存，返回即交棒（守住它的位置：pollFeishuAppRegistration 的 success 分支）。
// INV-05：一次注册会话的身份只由 device_code 承担，poll 必须带同一个 code；
//   服务端拒绝、过期、限速都翻译成稳定 status，不靠异常文本表达。
// INV-10：本文件不重试也不 sleep，轮询节奏由调用方按返回的 interval 决定；
//   slow_down 只被翻译成更大的间隔，不在内部循环。
// [失败路径] 失败分两类：begin 阶段的能力缺失/协议缺字段直接 throw（调用方无法继续）；
// poll 阶段的用户侧结果映射成 union status（access_denied/expired/error），调用方无需 try/catch。
interface FeishuAppRegistrationBeginResult {
  // device_code 是轮询凭据，等价于「未完成的授权」；只在内存中流转，不可写日志。
  deviceCode: string;
  // qrUrl 已注入 from/source/tp 三个来源参数，可直接编码成二维码；userCode 供手工输入兜底。
  qrUrl: string;
  userCode: string;
  // interval 单位为秒，来自 begin 响应；缺省 5 秒（见 beginFeishuAppRegistration 的 ?? 5）。
  interval: number;
  // expiresAt 是本地时间戳（Date.now() + expire_in），只用于让 UI 停止轮询；
  // 真正的过期仍以服务端 expired_token 为准，两边不一致时以服务端为事实。
  expiresAt: number;
  // domain 是调用方请求的域，pollDomain 是实际发起轮询的域；
  // Lark 租户的这两个值会不同（见 poll 里 tenant_brand 的切域分支）。
  domain: FeishuAppRegistrationDomain;
  pollDomain?: FeishuAppRegistrationDomain;
}

// 轮询结果是一个封闭状态机，而不是「返回值或异常」：
// pending 表示继续等，success 携带凭据，其余三个是终态。
// [权衡] 用 union 而不是 throw：UI 必须区分「用户拒绝」与「网络/协议错误」，
// 异常只能靠 message 文本区分，既不可本地化也无法被单测稳定断言。
type FeishuAppRegistrationPollResult =
  // interval=0 是特殊的「立即重试」信号，仅在检测到租户域切换时产生（见 poll 的 tenant_brand 分支）。
  | {
      status: "pending";
      interval: number;
      domain: FeishuAppRegistrationDomain;
      pollDomain?: FeishuAppRegistrationDomain;
    }
  // 只有 client_id 与 client_secret 同时非空才会进入该分支（见 poll 的 && 判断）。
  // appName 与 openId 是可选补充信息，缺失不影响凭据可用性，因此不参与成功判定。
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: FeishuAppRegistrationDomain;
      appName?: string;
      openId?: string;
    }
  // 三个终态共用一支：它们的区别只体现在 status 上，携带的 message 仅对 error 有效。
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: FeishuAppRegistrationDomain;
    };

// init 只用来探测服务端是否支持 client_secret 注册路径，不携带任何凭据。
// [失败路径] 字段可选是刻意的：老环境可能完全不返回该字段，此时按「不支持」处理而不是崩溃。
interface FeishuAppRegistrationInitResponse {
  supported_auth_methods?: string[];
}

// begin 响应全部字段可选：不同环境可能用 verification_uri 代替 complete 形式，也可能不返回 user_code。
// 因此「必填」校验只能放在 beginFeishuAppRegistration 里显式做，不能指望类型系统。
interface FeishuAppRegistrationBeginResponse {
  device_code?: string;
  verification_uri_complete?: string;
  verification_uri?: string;
  user_code?: string;
  // interval 单位为秒；缺省时由本地补 5，防止调用方以 0 间隔热轮询。
  interval?: number;
  expire_in?: number;
}

// poll 响应来自多个版本的服务端，同一信息有多个候选位置，所以字段全部 optional：
// 应用名可能是 app_name / client_name / name，也可能嵌在 app.app_name / app.name；
// 租户品牌只在 user_info.tenant_brand 出现。这是兼容性要求，不是疏漏。
// 错误字段沿用 OAuth 2.0 device flow 的 error / error_description 命名。
interface FeishuAppRegistrationPollResponse {
  client_id?: string;
  client_secret?: string;
  app_name?: string;
  client_name?: string;
  name?: string;
  app?: {
    app_name?: string;
    name?: string;
  };
  user_info?: {
    open_id?: string;
    tenant_brand?: FeishuAppRegistrationDomain;
  };
  error?: string;
  error_description?: string;
}

// 两个 accounts 域名：feishu 对应中国区租户，lark 对应海外租户。
// 注册入口固定走 feishu（见 begin 的 pollDomain），lark 域只在 poll 阶段被切换使用。
const FEISHU_ACCOUNTS_URL = "https://accounts.feishu.cn";
const LARK_ACCOUNTS_URL = "https://accounts.larksuite.com";
// 同一个 path 承载 init/begin/poll 三个动作，具体动作由 body.action 选择。
const FEISHU_APP_REGISTRATION_PATH = "/oauth/v1/app/registration";
// [权衡] 10 秒覆盖整次往返（含响应体解析）：注册是低频人工操作，超时过短会挡住弱网用户，
// 过长则让 UI 长时间无反馈；这里不区分连接超时与读取超时。
const FEISHU_APP_REGISTRATION_TIMEOUT_MS = 10_000;
// source 会出现在二维码 URL 上供服务端统计来源；保持 SDK 前缀再加产品名，便于排查是谁发起的注册。
const FEISHU_APP_REGISTRATION_SOURCE = "node-sdk/zcode";

// 把域枚举映射成 accounts 基址。未知值一律按 feishu 处理，
// 避免拼出空基址让 fetch 直接以 invalid URL 失败，那样错误比「域写错」更难定位。
function getAccountsBaseUrl(domain: FeishuAppRegistrationDomain): string {
  return domain === "lark" ? LARK_ACCOUNTS_URL : FEISHU_ACCOUNTS_URL;
}

// 在未知记录上做「只接受 string」的取值：数字、对象、数组一律当缺失，返回空串。
// [权衡] 返回 "" 而不是 undefined，让调用方不必同时处理两种缺失形态；
// 代价是调用方无法区分「字段不存在」与「字段是空串」，而这两者在注册流程里语义相同。
function readString(record: Record<string, unknown> | null | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

// 应用名按「平铺字段优先、嵌套 app 兜底」的顺序解析，兼容 node-sdk 的多种响应形态。
// 每一级都先 trim：服务端可能返回纯空白，不 trim 的话空白串为真值，会阻断后续候选。
// 全部缺失时返回 undefined，让 success 分支用展开语法彻底省略该字段，而不是写入空字符串。
function readRegistrationAppName(response: FeishuAppRegistrationPollResponse): string | undefined {
  // 先收窄成 Record：类型上 app 是对象，运行时仍可能是 null 或数组。
  const app = typeof response.app === "object" && response.app !== null ? response.app as Record<string, unknown> : null;
  return (
    response.app_name?.trim() ||
    response.client_name?.trim() ||
    response.name?.trim() ||
    readString(app, "app_name").trim() ||
    readString(app, "name").trim() ||
    undefined
  );
}

// 注册接口的唯一出口：固定 POST form 编码 + 固定超时，无重试、无缓存。
// [失败路径] 这里没有先检查 response.ok 就解析 JSON：服务端返回 4xx/5xx 且响应体非 JSON 时，
// response.json() 抛的是 SyntaxError，而不是可读的协议错误；上游只按字段判空，
// 该异常会直接冒泡给调用方，最终在 UI 上呈现为「注册服务不可用」而非具体原因。
// [权衡] 不做运行时 schema 校验：接口没有公开 schema，宽松解析 + 上层字段判空
// 比强校验更耐服务端版本漂移，代价是错误更晚暴露。
async function postRegistration<T>(
  domain: FeishuAppRegistrationDomain,
  body: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${getAccountsBaseUrl(domain)}${FEISHU_APP_REGISTRATION_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
    // AbortSignal.timeout 同时覆盖连接、响应头与响应体读取，不需要像 providerRequest 那样手工合并外部 signal。
    signal: AbortSignal.timeout(FEISHU_APP_REGISTRATION_TIMEOUT_MS),
  });
  // JSON 解析失败不会被捕获，调用方看到 SyntaxError；调用方应统一按「注册服务不可用」处理。
  return (await response.json()) as T;
}

// 一键创建应用的第一步：探测能力 -> begin 拿 device code -> 重写二维码来源参数。
// 副作用：两次 POST（init 与 begin），无缓存、无重试（INV-10）。
// 失败语义：能力不支持、缺 device_code、URL 非法三种情况都直接 throw，调用方据此提示「当前环境不支持」。
export async function beginFeishuAppRegistration(
  domain: FeishuAppRegistrationDomain = "feishu",
): Promise<FeishuAppRegistrationBeginResult> {
  // Bugfix: 对齐 @larksuiteoapi/node-sdk registerApp：一键创建应用总是先从 Feishu accounts issuer
  // 获取二维码，Lark 租户在 poll 阶段根据 tenant_brand 再切到 accounts.larksuite.com。
  // 因此这里的 pollDomain 恒为 feishu，与调用方传入的 domain 解耦：begin 必须发生在能签发
  // device_code 的 Feishu issuer 上；若改成按 domain 选基址，Lark 租户会在 begin 阶段直接拿不到 code。
  const pollDomain: FeishuAppRegistrationDomain = "feishu";
  // init 先探能力再 begin：避免服务端已经分配 device code，却因不支持 client_secret 而作废。
  const initResponse = await postRegistration<FeishuAppRegistrationInitResponse>(pollDomain, {
    action: "init",
  });
  // supported_auth_methods 缺失时 ?. 返回 undefined，includes 为 false，即 fail-closed 判定「不支持」。
  // 这与「先用 begin 试探」相比多一次请求，但能把「环境不支持」与「用户拒绝」区分开。
  if (!initResponse.supported_auth_methods?.includes("client_secret")) {
    throw new Error("Current Feishu environment does not support client_secret registration.");
  }

  // archetype 选 PersonalAgent；auth_method 固定 client_secret；
  // request_user_info=open_id 让 poll 结果带上用户 open_id，供上层建立「应用-用户」绑定。
  const beginResponse = await postRegistration<FeishuAppRegistrationBeginResponse>(pollDomain, {
    action: "begin",
    archetype: "PersonalAgent",
    auth_method: "client_secret",
    request_user_info: "open_id",
  });
  // 两个字段缺一不可：device_code 是轮询凭据，verification_uri_complete 是二维码内容。
  // 这里只校验存在性不校验格式，URL 解析放在下一行，格式错误会以 TypeError 冒泡。
  if (!beginResponse.device_code || !beginResponse.verification_uri_complete) {
    throw new Error("Feishu app registration did not return a device code.");
  }
  const qrUrl = new URL(beginResponse.verification_uri_complete);
  // SDK registerApp 使用 from=sdk/source=node-sdk[/source]/tp=sdk；这里保留 zcode 来源方便排查。
  // 三个参数用 set 而不是 append：服务端可能已带同名字段，重复会让统计口径出现两条。
  qrUrl.searchParams.set("from", "sdk");
  qrUrl.searchParams.set("source", FEISHU_APP_REGISTRATION_SOURCE);
  qrUrl.searchParams.set("tp", "sdk");
  // expire_in 缺省 600 秒：与 device flow 常见实现一致，避免字段缺失时 expiresAt 落在过去。
  const expireInSeconds = beginResponse.expire_in ?? 600;
  return {
    deviceCode: beginResponse.device_code,
    qrUrl: qrUrl.toString(),
    // user_code 可能不返回：空串让 UI 隐藏手工输入入口，而不是显示 "undefined"。
    userCode: beginResponse.user_code ?? "",
    // interval 缺省 5 秒，防止服务端漏字段时调用方以 0 间隔热轮询。
    interval: beginResponse.interval ?? 5,
    // expiresAt 只在本地用于「到点停止轮询」，与服务端过期是两套判据，前者宽松、后者权威。
    expiresAt: Date.now() + expireInSeconds * 1000,
    domain,
    pollDomain,
  };
}

// 轮询一次并翻译成状态机。调用间隔由调用方按上次返回的 interval 安排，本函数不 sleep、不重试（INV-10）。
// 输入：deviceCode 必填；domain 是调用方视角，pollDomain 是上次落点（首次等于 domain）。
// 副作用：一次 POST；不修改任何模块级状态，因此可被并发调用（同类请求由调用方串行）。
export async function pollFeishuAppRegistration(params: {
  deviceCode: string;
  domain?: FeishuAppRegistrationDomain;
  pollDomain?: FeishuAppRegistrationDomain;
}): Promise<FeishuAppRegistrationPollResult> {
  // pollDomain 缺省取 domain：首次轮询与 begin 保持一致；后续由 pending 结果里的 pollDomain 带回来。
  const domain = params.domain ?? "feishu";
  const pollDomain = params.pollDomain ?? domain;
  // 没有 device_code 的本地格式校验：缺失时服务端会返回 error，统一落到 error 分支，减少两套判空。
  const pollResponse = await postRegistration<FeishuAppRegistrationPollResponse>(pollDomain, {
    action: "poll",
    device_code: params.deviceCode,
  });
  // 结果域以服务端 tenant_brand 为准：用户在 Lark 租户完成授权时，返回的凭据只能在 lark 域使用。
  const resultDomain = pollResponse.user_info?.tenant_brand ?? domain;
  // 已授权的租户品牌与当前轮询域不一致时，先返回 pending + interval=0，让调用方立刻用新域再轮询一次。
  // [权衡] 不在本函数内部循环切域，是为了保持「一次调用一次请求」的边界；代价是调用方若忽略
  // interval=0，最多多等一个普通周期，但不会死循环。pollDomain 必须显式带回，否则调用方无从得知切域。
  if (pollResponse.user_info?.tenant_brand === "lark" && pollDomain !== "lark") {
    return {
      status: "pending",
      interval: 0,
      domain: resultDomain,
      pollDomain: "lark",
    };
  }
  // 凭据齐备才判定成功：client_id 对应 appId，client_secret 对应 appSecret。
  // [失败路径] 服务端若返回空字符串 secret，&& 为假会落到下面的 pending 分支并一直等到过期；
  // 这是宽松解析的代价，调用方必须用 begin 给出的 expiresAt 兜底，不能无限轮询。
  if (pollResponse.client_id && pollResponse.client_secret) {
    const appName = readRegistrationAppName(pollResponse);
    return {
      status: "success",
      appId: pollResponse.client_id,
      appSecret: pollResponse.client_secret,
      domain: resultDomain,
      // appName 只在非空时通过展开语法加入，避免把 undefined 显式写进结果对象。
      ...(appName ? { appName } : {}),
      openId: pollResponse.user_info?.open_id,
    };
  }
  // 无 error 或 authorization_pending 都表示「用户尚未操作完」：前者兼容不返回错误码的环境。
  // interval 固定 5 秒而非沿用服务端值，因为 pending 响应通常不再重复下发 interval。
  if (!pollResponse.error || pollResponse.error === "authorization_pending") {
    return { status: "pending", interval: 5, domain: resultDomain };
  }
  // slow_down 是 OAuth device flow 的限速信号：把间隔翻倍到 10 秒，仍保持 pending 而不是失败。
  if (pollResponse.error === "slow_down") {
    return { status: "pending", interval: 10, domain: resultDomain };
  }
  // access_denied 与 expired_token 是两个可直接展示的终态，不携带 message：原因已由 status 表达。
  // 调用方据此分别渲染「已拒绝授权」与「二维码已过期，请重新生成」，无需解析文案。
  if (pollResponse.error === "access_denied") {
    return { status: "access_denied", domain: resultDomain };
  }
  if (pollResponse.error === "expired_token") {
    return { status: "expired", domain: resultDomain };
  }
  // 兜底错误保留原始 error 与 description 便于排查；description 缺失时写 unknown，
  // 避免模板字符串把 undefined 拼进用户可见文案。
  return {
    status: "error",
    message: `${pollResponse.error}: ${pollResponse.error_description ?? "unknown"}`,
    domain: resultDomain,
  };
}
