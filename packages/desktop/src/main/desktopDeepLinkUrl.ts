// INV-01 协议判定必须只认 zcode: 精确相等，绝不做前缀或包含匹配；守住位置：四个 is 开头的 Url 函数首行；改错故障：zcodex: 之类相似协议被当成深链，外部程序可诱导主进程处理任意回调
// INV-02 主机白名单是常量集合而非字符串前缀判断；守住位置：OAUTH_CALLBACK_HOSTS 与各 host 常量；改错故障：oauth 开头的相似域名被误放行，回调落到攻击者可控端点
// INV-03 路径归一必须先剥尾斜杠再补前导斜杠，空路径折算成根路径；守住位置：normalizeOAuthCallbackPath；改错故障：带尾斜杠的 callback 被判非法，浏览器唤起后应用无反应
// INV-04 带主机形态与裸路径形态必须同时支持，且两条分支判定结果一致；守住位置：各 is 开头 Url 函数的两段分支；改错故障：zcode://oauth/callback 与 zcode:oauth/callback 只有一种能唤起应用
// INV-05 裸路径解析先解构跳过首个空串，再按 host 与剩余路径拼接比对；守住位置：normalizedPath 解构那一行；改错故障：zcode:/oauth/callback 被拆错位，路径校验恒为假
// INV-06 URL 的 hostname 非空且不在白名单时必须立即返回 false，不得回退裸路径分支；守住位置：各 is 开头 Url 函数的 hostname 早退；改错故障：未知主机被重新当成裸路径解析，越权主机获得放行
// INV-07 OAuth 回调必须只认 /callback 一级子路径，不接受更深层级；守住位置：isOAuthCallbackUrl 的等值比较；改错故障：/callback/extra 被当成合法回调，state 校验落在错误端点
// INV-08 支付回调额外要求 provider、channel、status 三个查询参数齐全才算完整；守住位置：isCompleteDeepLinkUrl 的支付分支；改错故障：缺参的半截 URL 被提前返回，支付轮询拿不到最终状态
// INV-09 工作区打开必须只认 /open，且 path 既要在完整性判定中存在、也要在提取时非空；守住位置：isWorkspaceOpenUrl 与 extractWorkspaceOpenPath；改错故障：空 path 被当成打开默认目录，用户工作区跳错
// INV-10 分享导入码限定 1 到 512 位、仅允许字母数字与点下划线波浪线短横；守住位置：extractShareImportCode 的正则；改错故障：超长或含特殊字符的码被接受，服务端解析失败且无本地提示
// INV-11 解码候选必须最多三轮，任何一轮解码结果与原值相同即停止；守住位置：expandDecodedDeepLinkCandidates 的循环；改错故障：多层编码无法还原，或极端输入反复解码拖慢启动
// INV-12 解码遇到非法百分号序列必须吞掉异常并返回 null，不得上抛；守住位置：decodeDeepLinkCandidate 的 catch；改错故障：恶意参数让启动路径抛错，应用直接打不开
// INV-13 argv 候选必须既含原始单参数，也含最多 5 个相邻参数拼接；守住位置：buildArgCandidates 的双层循环；改错故障：被空格拆散的 query 拼不回完整 URL，回调静默失败
// INV-14 候选去重必须以 Set 为准，同一串只处理一次；守住位置：buildArgCandidates 的 seen 集合；改错故障：参数较多时出现平方级重复扫描，冷启动明显变慢
// INV-15 带 state 的完整候选优先返回，不完整匹配只作兜底且取第一个命中；守住位置：extractDeepLinkUrlFromArgs 的 fallbackMatch 赋值；改错故障：先遇到半截 URL 就返回，真正的完整回调被丢弃
// INV-16 深链正则大小写不敏感且允许 zcode:、双斜杠、单斜杠三种写法；守住位置：DEEP_LINK_RE 的 i 标志；改错故障：浏览器给出大写协议时被判定为无深链
// INV-17 文本清洗先剥引号再做实体与转义还原，顺序不可颠倒；守住位置：extractFromCandidate；改错故障：转义后的引号被当成定界符剥掉，URL 尾部被截断
// INV-18 打开工作区参数必须只认 --open-workspace 及其等号形式，未知参数一律忽略；守住位置：extractOpenWorkspacePathFromArgs；改错故障：误把其他参数当成路径，打开错误目录
//
// 本模块是纯函数层：从 argv 或单实例附加数据解析深链与工作区路径，不持有窗口与进程状态
// 所有非法输入返回 null 而不抛错，调用方据此决定是否唤起窗口
//
const DEEP_LINK_SCHEME = "zcode";
// DEEP_LINK_RE 用于从整段命令行文本里抠出深链，三种写法必须命中：zcode:、zcode:双斜杠、zcode:单斜杠。
// DEEP_LINK_RE 的 i 标志让大写协议同样生效，浏览器与桌面门户转交时大小写并不可控。
// 字符类排除空白与引号尖括号，保证匹配在 shell 拼接的碎片处自然截断
const DEEP_LINK_RE = /\bzcode:(?:\/\/|\/)?[^\s"'<>]+/i;
// OAUTH_CALLBACK_HOSTS 用 Set 而不是单字符串，既为将来多个回调主机留位置，也让判断保持常数级。
// 白名单是唯一放行依据，不能改成前缀比较或包含判断，否则相似域名即可绕过
const OAUTH_CALLBACK_HOSTS = new Set(["oauth"]);
// 四个主机名常量紧邻 OAUTH_CALLBACK_HOSTS 放置，集中在一处就能看全所有可被外部触达的入口。
// PAYMENT_CALLBACK_HOST 等常量同时参与等值比较与裸路径解构两处，抽常量避免两处拼写漂移。
const PAYMENT_CALLBACK_HOST = "payment";
const WORKSPACE_OPEN_HOST = "workspace";
const SHARE_IMPORT_HOST = "share";
const DEEP_LINK_ADDITIONAL_DATA_KEY = "deepLinkUrl";
const OPEN_WORKSPACE_ADDITIONAL_DATA_KEY = "openWorkspacePath";
const OPEN_WORKSPACE_ARG = "--open-workspace";

// normalizeOAuthCallbackPath 的归一必须按固定顺序做三步：剥尾斜杠、空串折算成根、补并压缩前导斜杠。
// 归一结果是全模块唯一的比较基准，各判定函数不得各自另写一套路径处理
// 这里只处理路径部分，不含查询串，参数读取一律交给 searchParams
function normalizeOAuthCallbackPath(pathname: string): string {
  // 一次性剥掉所有尾斜杠而不是只剥一个，带多个尾斜杠的路径必须与单个等价
  // 只剥尾不剥头，前导斜杠由下一行的 replace 统一补成一个，避免两种形态各自为政。
  const withoutTrailingSlash = pathname.replace(/\/+$/, "");
  const normalized = withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
  return `/${normalized.replace(/^\/+/, "")}`;
}

// 先比协议再比路径，协议不符直接返回 false，避免对非本应用的 URL 继续解析
// 该函数被完整性与单实例提取两条路径复用，任何改动都会同时影响两处
export function isOAuthCallbackUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return false;
  }

  const normalizedPath = normalizeOAuthCallbackPath(parsedUrl.pathname);
  // 带主机形态：主机命中白名单后只接受 /callback，更深层级一律拒绝
  // 主机名大小写由 URL 解析器先行小写化，这里不必再自行转换
  if (OAUTH_CALLBACK_HOSTS.has(parsedUrl.hostname)) {
    return normalizedPath === "/callback";
  }

  if (parsedUrl.hostname) {
    return false;
  }

  const [, host, ...pathParts] = normalizedPath.split("/");
  return Boolean(
    host && OAUTH_CALLBACK_HOSTS.has(host) && `/${pathParts.join("/")}` === "/callback",
  );
}

// 支付回调与 OAuth 回调结构对称，唯一差别是主机名固定为 payment
// isPaymentCallbackUrl 与 isOAuthCallbackUrl 对称是刻意的：两者共用同一套归一与两段判定，审阅时可逐行对照。
export function isPaymentCallbackUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return false;
  }

  const normalizedPath = normalizeOAuthCallbackPath(parsedUrl.pathname);
  if (parsedUrl.hostname === PAYMENT_CALLBACK_HOST) {
    return normalizedPath === "/callback";
  }

  if (parsedUrl.hostname) {
    return false;
  }

  const [, host, ...pathParts] = normalizedPath.split("/");
  return Boolean(host === PAYMENT_CALLBACK_HOST && `/${pathParts.join("/")}` === "/callback");
}

// 工作区打开复用同一套归一与两段判定，只是子路径换成 open
// isWorkspaceOpenUrl 与分享导入不同：这里保留裸路径分支，因此命令行直接传入的形态也能命中。
export function isWorkspaceOpenUrl(parsedUrl: URL): boolean {
  if (parsedUrl.protocol !== `${DEEP_LINK_SCHEME}:`) {
    return false;
  }

  const normalizedPath = normalizeOAuthCallbackPath(parsedUrl.pathname);
  if (parsedUrl.hostname === WORKSPACE_OPEN_HOST) {
    return normalizedPath === "/open";
  }

  if (parsedUrl.hostname) {
    return false;
  }

  const [, host, ...pathParts] = normalizedPath.split("/");
  return Boolean(host === WORKSPACE_OPEN_HOST && `/${pathParts.join("/")}` === "/open");
}

// 提取前先做形状判定，非法形态不进入参数读取，避免对任意链接取 path
// path 为空串与缺失都返回 null，调用方据此回落到默认工作区
export function extractWorkspaceOpenPath(parsedUrl: URL): string | null {
  if (!isWorkspaceOpenUrl(parsedUrl)) {
    return null;
  }

  const path = parsedUrl.searchParams.get("path");
  return path && path.length > 0 ? path : null;
}

// isShareImportUrl 要求协议、主机、路径三段必须同时成立，不接受裸路径形态。
// isShareImportUrl 的不对称是有意的：分享链接只由网页复制生成，始终带双斜杠与主机。
// isShareImportUrl 少一层裸路径分支，就等于少一处可被外部构造的入口。
export function isShareImportUrl(parsedUrl: URL): boolean {
  return (
    parsedUrl.protocol === `${DEEP_LINK_SCHEME}:` &&
    parsedUrl.hostname === SHARE_IMPORT_HOST &&
    normalizeOAuthCallbackPath(parsedUrl.pathname) === "/import"
  );
}

export function extractShareImportCode(parsedUrl: URL): string | null {
  if (!isShareImportUrl(parsedUrl)) return null;
  const code = parsedUrl.searchParams.get("code")?.trim();
  // 先 trim 再校验，被空白包裹的码不应因首尾空格被判非法
  // extractShareImportCode 先用正则筛字符集与长度上界，明显非法的输入不再发给服务端
  // 校验失败返回 null 而不是空串，让上层能区分没有码与码非法
  return code && /^[A-Za-z0-9._~-]{1,512}$/u.test(code) ? code : null;
}

// 解码结果与原值相同视为没有可解内容，返回 null 以终止多轮展开
// 非法百分号序列会抛 URIError，这里必须吞掉，绝不能让启动路径崩掉
// 返回 null 的两种原因在调用方等价，都是不再继续解码
function decodeDeepLinkCandidate(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded === value ? null : decoded;
  } catch {
    return null;
  }
}

// 候选列表首个元素永远是原始值，保证未编码的 URL 也能被后续匹配取到
// expandDecodedDeepLinkCandidates 最多三轮，覆盖浏览器与桌面门户常见的多层编码，又不为极端输入反复解码。
// candidates.includes 命中重复候选即停止，防止两个值互相解码形成的循环。
function expandDecodedDeepLinkCandidates(value: string): string[] {
  const candidates = [value];
  let current = value;

  // expandDecodedDeepLinkCandidates 的三轮是实测够用的上界，再深一层编码在实际唤起场景里没有出现过
  // 把上界写成字面量 3 而不是常量，是因为 expandDecodedDeepLinkCandidates 的语义是候选数量而非业务配置
  for (let index = 0; index < 3; index++) {
    const decoded = decodeDeepLinkCandidate(current);
    if (!decoded || candidates.includes(decoded)) {
      break;
    }

    candidates.push(decoded);
    current = decoded;
  }

  return candidates;
}

function buildArgCandidates(args: readonly string[]): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    if (!seen.has(value)) {
      candidates.push(value);
      seen.add(value);
    }
  };

  for (const arg of args) {
    addCandidate(arg);
  }

  for (let start = 0; start < args.length; start++) {
    let joined = "";
    // 把相邻参数拼回一个候选，用于 shell 或桌面门户把 query 按空格拆开的场景
    // 固定 5 个参数为窗口，兼顾拆分深度与候选数量，避免参数多时组合爆炸
    // 内层从 start 起累加，单参数候选已在前一轮加入，因此这里跳过首轮拼接
    for (let end = start; end < Math.min(args.length, start + 5); end++) {
      joined += args[end] ?? "";
      if (end > start) {
        addCandidate(joined);
      }
    }
  }

  return candidates;
}

function extractFromCandidate(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/g, "");
  const match = trimmed.match(DEEP_LINK_RE);
  return match?.[0].replace(/&amp;/gi, "&").replace(/\\([&=?:/])/g, "$1") ?? null;
}

// isCompleteDeepLinkUrl 里 new URL 失败即判定不完整，异常会在此处消化，调用方永远只拿到布尔值
// 四类回调各有必填参数，缺一即视为被截断的半截 URL
// 未知形态默认返回 true，保证新增深链类型不会因缺少分支而整体失效
// [缺陷 D-12-1] 完整性用 searchParams.has(...) 判存在，空值参数（?state=、?path=）也算齐全；extractDeepLinkUrlFromArgs 会据此提前返回，丢弃后面真正的完整候选。
function isCompleteDeepLinkUrl(value: string): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value);
  } catch {
    return false;
  }

  if (isOAuthCallbackUrl(parsedUrl)) {
    return parsedUrl.searchParams.has("state");
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    return (
      parsedUrl.searchParams.has("provider") &&
      parsedUrl.searchParams.has("channel") &&
      parsedUrl.searchParams.has("status")
    );
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    return parsedUrl.searchParams.has("path");
  }

  if (isShareImportUrl(parsedUrl)) {
    return extractShareImportCode(parsedUrl) !== null;
  }

  return true;
}

export function extractDeepLinkUrlFromArgs(args: readonly string[]): string | null {
  let fallbackMatch: string | null = null;

  for (const arg of buildArgCandidates(args)) {
    for (const candidate of expandDecodedDeepLinkCandidates(arg)) {
      const match = extractFromCandidate(candidate);
      if (match) {
        // Debian/xdg 的协议回调可能被浏览器或桌面门户多次编码，
        // 也可能把 query 片段拆成相邻 argv。这里先生成有限候选再多轮解码，
        // 避免浏览器确认“打开 ZCode”后主进程拿不到完整回调 URL。
        if (isCompleteDeepLinkUrl(match)) {
          return match;
        }
        // 兜底只记录第一个命中，后续完整候选仍有机会覆盖它
        // 整轮没有完整 URL 时返回兜底，宁可给出半截也不丢掉全部线索
        fallbackMatch ??= match;
      }
    }
  }

  return fallbackMatch;
}

// 只剥成对的引号，首尾引号不一致说明参数已被拼接破坏，保持原样更安全
// 盘符路径的尾引号折叠是已知的 argv 解析产物，单独修正这一种形态
function trimArgValue(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' || first === "'") && first === last) {
    return trimmed.slice(1, -1);
  }

  if (/^[A-Za-z]:(?:\\.*)?["']$/.test(trimmed)) {
    // Windows Explorer 的 Drive\shell 菜单会把 C:\ 代入 "%1"。
    // 部分 argv 解析链会把末尾反斜杠和闭合引号折叠成尾引号，这里只修正盘符绝对路径。
    return `${trimmed.slice(0, -1)}\\`;
  }

  return trimmed;
}

export function extractOpenWorkspacePathFromArgs(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (arg === OPEN_WORKSPACE_ARG) {
      const value = args[index + 1];
      const path = value ? trimArgValue(value) : "";
      if (path) {
        return path;
      }
      continue;
    }

    if (arg.startsWith(`${OPEN_WORKSPACE_ARG}=`)) {
      const path = trimArgValue(arg.slice(OPEN_WORKSPACE_ARG.length + 1));
      if (path) {
        return path;
      }
    }
  }

  return null;
}

export function createDeepLinkSingleInstanceData(args: readonly string[]): Record<string, string> {
  const url = extractDeepLinkUrlFromArgs(args);
  const openWorkspacePath = extractOpenWorkspacePathFromArgs(args);
  return {
    ...(url ? { [DEEP_LINK_ADDITIONAL_DATA_KEY]: url } : {}),
    ...(openWorkspacePath ? { [OPEN_WORKSPACE_ADDITIONAL_DATA_KEY]: openWorkspacePath } : {}),
  };
}

export function extractDeepLinkUrlFromSingleInstanceData(additionalData: unknown): string | null {
  if (!additionalData || typeof additionalData !== "object") {
    return null;
  }

  const value = (additionalData as Record<string, unknown>)[DEEP_LINK_ADDITIONAL_DATA_KEY];
  if (typeof value !== "string") {
    return null;
  }

  return extractDeepLinkUrlFromArgs([value]);
}

export function extractOpenWorkspacePathFromSingleInstanceData(
  additionalData: unknown,
): string | null {
  if (!additionalData || typeof additionalData !== "object") {
    return null;
  }

  const value = (additionalData as Record<string, unknown>)[OPEN_WORKSPACE_ADDITIONAL_DATA_KEY];
  if (typeof value !== "string") {
    return null;
  }

  return extractOpenWorkspacePathFromArgs([`${OPEN_WORKSPACE_ARG}=${value}`]);
}
