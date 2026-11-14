// WebFetch 工具面的全部数值口径集中在这里。
//
// 网络层（webfetch-network）、正文抽取与截断（webfetch-content）、缓存（webfetch-cache）、
// URL 校验（webfetch-url）以及工具注册与结果预算（webfetch.ts）都从这里取值；改一个数字
// 会同时改变「何时超时、多大算大、缓存多久、重定向几次」，因此不要在调用点另写字面量。
// 这些是构建期常量而非配置项：模型无法通过入参放宽任何一条上限。

/**
 * registry 中注册的工具名，也是权限规则 key、hook matcher 与遥测 toolName 的对齐字符串。
 * 改名会同时让历史权限记忆、审计记录与遥测维度失去关联，必须四处同步。
 */
export const WEBFETCH_TOOL_NAME = "WebFetch";
/**
 * 单次网络 GET 的硬超时（毫秒），按「每一跳重定向」分别计时。
 * 同一数值也是 tool entry 的 timeout.defaultMs 与 maxMs，且 allowCallOverride=false，
 * 所以模型无法要求更长等待；超时向上表现为 FetchFailed，而不是让工具挂死。
 */
export const DEFAULT_WEBFETCH_TIMEOUT_MS = 60_000;
/**
 * URL 字符串长度上限（UTF-16 码点字符数，parser 前先查）。
 * 超限立即 InvalidUrl，避免超长输入进入 `new URL` 与后续日志/审计字段。
 */
export const MAX_WEBFETCH_URL_CHARS = 2_000;
/**
 * 单次响应体允许读入的最大字节数（原始 HTTP 响应体，由 adapter 按读取字节执行）。
 * 交给 httpClientPort 的 maxResponseBytes；超限由 adapter 抛 too_large，
 * 本工具再翻译成 ResponseTooLarge，而不是把半个 body 当成正文去抽取。
 */
export const MAX_WEBFETCH_RESPONSE_BYTES = 10 * 1024 * 1024;
/**
 * 送进小模型做 prompt 处理的正文上限，单位是**字符**而非字节（反直觉之处）。
 * 超限由 truncateContentForModel 截断并追加提示；同一个数值也被 maybePersistRawContent
 * 拿去做字节比较，用于判断「正文足够大，需要先把原文落 artifact」——那处存在字符/字节
 * 口径混用，但「被截断 ⇒ 必已落盘」的结论仍然成立（见 webfetch-content.ts）。
 */
export const MAX_MODEL_INPUT_CHARS = 100_000;
/**
 * 模型可见结果的字节预算，供 resultBudget 的 maxInlineBytes / maxModelBytes /
 * preview.maxBytes 与 tool.metadata.maxOutputBytes 使用。
 * 数值与 MAX_MODEL_INPUT_CHARS 相同但单位是字节；两者不可互换，混用会导致
 * 中文/emoji 正文的截断点提前或超出预算。
 */
export const MAX_WEBFETCH_MODEL_BYTES = 100_000;
/**
 * 按 URL 缓存已抽取正文的存活时间（15 分钟），与工具描述里对模型承诺的缓存窗口一致。
 * 过期条目在 getWebFetchCache 读取时惰性删除，所以 TTL 到期不会立即释放内存。
 */
export const CACHE_TTL_MS = 15 * 60 * 1000;
/**
 * 缓存总字节预算（按 CachedFetchContent.sizeBytes 累加，即抽取后正文大小）。
 * 单条超过它直接不缓存；总量超过按 Map 插入顺序淘汰最旧项——读命中会重排到末尾，
 * 因此实际等价于按「最近使用」淘汰，而不统计访问频率。
 */
export const CACHE_MAX_BYTES = 50 * 1024 * 1024;
/**
 * 跟随重定向的最大跳数。网络层循环条件是 `<= MAX_REDIRECTS`，即实际最多发起
 * MAX_REDIRECTS+1 次 GET；越过上限统一报 TooManyRedirects，而不是继续把请求打出去。
 */
export const MAX_REDIRECTS = 10;

/**
 * 出站请求的 User-Agent，带项目标识与主页，便于目标站点识别流量来源。
 * 部分站点会按 UA 直接拒绝通用客户端；修改时不要抹掉可联系的项目标识。
 */
export const WEBFETCH_USER_AGENT = "ZCode-WebFetch/0.1 (+https://zcode.ai; coding-agent-cli)";
