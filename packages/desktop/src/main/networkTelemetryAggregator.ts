// 桌面 main 进程内的网络遥测聚合器：把每条 NetworkObservation 与 ARMS 的 api 事件，
// 按 transport 加归一化接口名折叠成低基数统计桶，供上层周期 flush 后上报。
// 本模块只做 buckets 的内存累积与口径换算；不负责采样决策、不负责上报传输、不负责持久化，进程重启后这些计数会清零。
//
// INV-01 断言：接口名在入桶前必须经过 canonicalInterface 归一化 —— 守住它的位置：getOrCreateBucket 与 resolveBucketInterface —— 改错故障：原始 URL 直接成为标签，ARMS 维度爆炸导致查询超时与费用激增。
// INV-02 断言：每个 transport 的非 other 桶数量必须不超过 128，超出的一律并入 other —— 守住它的位置：resolveBucketInterface 的 transportBucketCount 判断 —— 改错故障：动态接口把内存与上报体积撑爆，main 进程常驻内存持续上涨。
// INV-03 断言：只有已存在的桶可以绕过容量上限 —— 守住它的位置：resolveBucketInterface 开头的 buckets.has 短路 —— 改错故障：满额后稳定接口每次都被改写为 other，同名接口的统计在窗口间来回跳变。
// INV-04 断言：桶键必须是 transport 与接口名的组合，且用空字符分隔 —— 守住它的位置：bucketKey —— 改错故障：http 与 ws 的同名接口互相覆盖，错误率与延迟被混算。
// INV-05 断言：HTTP 接口名必须只保留 host 与归一化后的 path，不能带 query、hash 与用户凭据 —— 守住它的位置：normalizeHttpInterface 的 URL 解析分支 —— 改错故障：token 或邮箱进入 ARMS 标签，构成隐私事故。
// INV-06 断言：非静态白名单的 path 段一律折叠为 :id —— 守住它的位置：normalizeHttpPathSegment —— 改错故障：用户 slug 与邮箱原样上报，标签基数随用户数线性增长。
// INV-07 断言：静态路径段白名单只能显式登记后扩张 —— 守住它的位置：STATIC_HTTP_PATH_SEGMENTS —— 改错故障：把动态段当静态白名单放行，等价于取消脱敏。
// INV-08 断言：本地文件路径必须统一归为 local_file，绝不上报绝对路径 —— 守住它的位置：normalizeHttpInterface 的三个前置判定 —— 改错故障：操作系统账户名出现在遥测标签里，泄露终端身份。
// INV-09 断言：分阶段耗时只在有限且非负时入样本 —— 守住它的位置：pushIfPositive —— 改错故障：连接复用产生的缺失值被当成零，把分位数拉低造成性能假象。
// INV-10 断言：总耗时 durationMs 无条件入样本，与失败样本配对 —— 守住它的位置：recordNetworkObservation 首行的 push —— 改错故障：失败请求被排除后成功率下降，但延迟反而变好看。
// INV-11 断言：失败计数与错误种类计数必须在同一分支内一起累加 —— 守住它的位置：recordNetworkObservation 的 else 分支 —— 改错故障：failCount 与 errorCounts 之和不一致，错误占比失真。
// INV-12 断言：未知错误类型必须一律折叠为 other，不能透传原始字符串 —— 守住它的位置：normalizeErrorKind —— 改错故障：上游新增错误码直接成为新键，枚举与统计口径脱节。
// INV-13 断言：重试次数等于 attempt 减一后累加，不是把 attempt 求和 —— 守住它的位置：recordNetworkObservation 的 attempt 分支 —— 改错故障：重试率被高估，重试告警频繁误报。
// INV-14 断言：错误种类并列时取 NETWORK_ERROR_KIND_ORDER 中靠前者 —— 守住它的位置：buildStats 的 primaryErrorKind 循环 —— 改错故障：并列错误在不同机器上选出不同 primary，看板数据不可复现。
// INV-15 断言：flush 是破坏性读取，取走即清空全局桶 —— 守住它的位置：flushInterfaceNetworkStats 中的 buckets.clear —— 改错故障：同一批观测被重复上报，请求量整体翻倍。
// INV-16 断言：flush 前必须丢弃没有任何耗时样本的空桶 —— 守住它的位置：flushInterfaceNetworkStats 的 durations.length 判断 —— 改错故障：零样本接口占用配额，把真实接口挤出上报窗口。
// INV-17 断言：每个 transport 必须最多保留 maxPerTransport 条，并按 requestTotal 降序截断 —— 守住它的位置：flushInterfaceNetworkStats 的排序与 slice —— 改错故障：长尾接口占满配额，主接口统计整批丢失。
// INV-18 断言：ARMS 事件的 success 判定必须兼容布尔、数字与 2xx/3xx 状态码 —— 守住它的位置：ingestArmsApiEvent 的 ok 计算 —— 改错故障：上报端只给数字 1 时全部记为失败，成功率跌到零。
import { computeAggregateStats, type AggregateStats } from "./resourceMetricsStats.js";
import type { NetworkObservation, NetworkTransportKind } from "@zcode/rpc";

// 错误种类是上报契约的一部分：枚举值一旦改名，历史看板与告警规则会同时失效。
// 新增种类必须同时补进 NETWORK_ERROR_KIND_ORDER，否则它永远选不上 primary。
// 不要为了细分 4xx 在这里加 http_4xx 之类的新值，分母口径会被拆散。
// 未知值在归一化阶段统一落到 other，不在这里做兜底。
export type NetworkErrorKind =
  | "timeout"
  | "dns_failure"
  | "connection_reset"
  | "proxy_error"
  | "tls_error"
  | "server_error"
  | "client_error"
  | "other";

// 这里的顺序不只是展示顺序，它同时是 buildStats 选择 primary 时的并列裁决顺序。
// 越靠前优先级越高：超时与 DNS 失败比 5xx 更能说明链路问题，因此排在最前。
// 调整顺序等于改变线上看板的 primary 分布，属于数据口径变更，要单独评审。
// readonly 只有编译期约束，禁止把这个数组对外导出后被运行期改写。
// 该数组同时用于构造 NETWORK_ERROR_KINDS 集合，两处必须保持一致。
const NETWORK_ERROR_KIND_ORDER: readonly NetworkErrorKind[] = [
  "timeout",
  "dns_failure",
  "connection_reset",
  "proxy_error",
  "tls_error",
  "server_error",
  "client_error",
  "other",
];

// 这是跨进程传输的形状：字段只能是可结构化克隆的纯数据，不能带 Map 或 Set。
// errorCounts 用可选字段而非全量键，避免零值键把序列化体积撑大。
// 各阶段耗时统一由 resourceMetricsStats 计算，保持与其他资源指标一致的算法。
// InterfaceNetworkStats 对外导出的字段增删属于协议变更，会导致消费端解析失败，改动必须同步消费端。
export interface InterfaceNetworkStats {
  transport: NetworkTransportKind;
  interface: string;
  requestTotal: number;
  successCount: number;
  failCount: number;
  retryCount: number;
  primaryErrorKind?: NetworkErrorKind;
  primaryErrorCount: number;
  duration: AggregateStats;
  dns: AggregateStats;
  tcp: AggregateStats;
  tls: AggregateStats;
  ttfb: AggregateStats;
  download: AggregateStats;
  errorCounts: Partial<Record<NetworkErrorKind, number>>;
}

// 桶内保存原始样本数组，分位数只由 flushInterfaceNetworkStats 调 computeAggregateStats 时一次性计算，不做增量聚合。
// 因此单个桶的内存随观测条数线性增长，flush 周期就是内存上界的主要来源。
// successCount 与 failCount 分开累加，requestTotal 只在 buildStats 里求和。
// errorCounts 用 Map 是为避开原型链键污染，导出时再转成普通对象。
interface InterfaceBucket {
  transport: NetworkTransportKind;
  interface: string;
  durations: number[];
  dns: number[];
  tcp: number[];
  tls: number[];
  ttfb: number[];
  download: number[];
  successCount: number;
  failCount: number;
  retryCount: number;
  errorCounts: Map<NetworkErrorKind, number>;
}

// 模块级单例：main 进程内所有窗口、所有 transport 共用这一份内存状态。
// 不做持久化也不做定时清理，生命周期完全由调用方的 flush 节奏决定。
// 若在这里再缓存按窗口切分的子表，flush 的破坏性语义会立刻失效。
// 测试需要隔离时应调用 resetNetworkTelemetryAggregator，不要直接操作这个 Map。
const buckets = new Map<string, InterfaceBucket>();
// MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT 由 resolveBucketInterface 按 transport 分别计算，http 与 ws 各自拥有 128 个名额，互不挤占。
// MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT 导出是为了让测试能构造边界，不要在业务代码里复制这个数字。
// 调大它不会提升准确性，只会把基数爆炸的代价推迟到下游。
// 它和 flush 的 maxPerTransport 是两个不同维度的限制，不要合并成一个。
export const MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT = 128;

// NETWORK_ERROR_KINDS 只用于 normalizeErrorKind 的成员判定，判定结果再回写为枚举值。
// 集合与顺序数组同源，新增种类只需改数组这一处。
// 不要在 NETWORK_ERROR_KINDS 里追加 NETWORK_ERROR_KIND_ORDER 之外的大小写变体，归一化已经先做小写处理，加了也不会命中。
const NETWORK_ERROR_KINDS = new Set<string>(NETWORK_ERROR_KIND_ORDER);

// STATIC_HTTP_PATH_SEGMENTS 的语义是已知静态路由段，不是看起来像英文单词的段；登记错会让用户 slug 进入标签。
// 漏登记只会让该段折叠成 :id，信息变粗但安全；错登记则直接泄露用户数据。
// users、projects、sessions 这类段之所以能登记，是因为标识在它们的下一段。
// 不要为了报表好看把租户名或邮箱域名后缀加进 STATIC_HTTP_PATH_SEGMENTS，加了会让它们原样成为 ARMS 标签。
// 纯数字段无需登记，任何未被命中的段都会统一折叠。
/**
 * 只有仓内已知、低基数的 API 路由段可以进入 ARMS；其他段统一视为动态标识。
 * 新增静态接口时必须显式登记，避免把用户 slug、邮箱或路径片段误当作安全路由。
 */
const STATIC_HTTP_PATH_SEGMENTS = new Set([
  "anthropic",
  "api",
  "authorize",
  "availability",
  "balance",
  "billing",
  "biz",
  "bootstrap",
  "cancel",
  "claim",
  "client",
  "coding-plan",
  "configs",
  "customer",
  "electron",
  "enterprise",
  "event",
  "getCustomerInfo",
  "health",
  "latest",
  "manifest",
  "messages",
  "mcp",
  "mobile-view-state",
  "models",
  "oauth",
  "off-peak",
  "order",
  "orders",
  "organization",
  "pay",
  "pending",
  "platform",
  "preview",
  "pricing",
  "projects",
  "releases",
  "remote-control",
  "report",
  "reset",
  "responses",
  "rpc-host-capability",
  "scenes",
  "server-info",
  "sessions",
  "snapshot",
  "status",
  "subscription",
  "tasks",
  "ticket",
  "token",
  "upload-credential",
  "usage",
  "users",
  "v1",
  "v2",
  "v3",
  "v4",
  "windows",
  "workspace-bridge",
  "zcode-plan",
]);

// 入参来自上游上报，可能是任意大小写或带空白的字符串，必须先 trim 再小写。
// 空串与纯空白视为未知，落到 other，不能当作合法种类。
// 未命中集合的值一律 other，绝不把原始值写进统计键。
// 不要在调用点重复做同样的归一化，唯一入口就是这里。
function normalizeErrorKind(value: string | undefined): NetworkErrorKind {
  const normalized = value?.trim().toLowerCase();
  return normalized && NETWORK_ERROR_KINDS.has(normalized)
    ? (normalized as NetworkErrorKind)
    : "other";
}

// 用空字符作分隔符，是因为接口名里可能含冒号与斜杠，用它们拼键会产生歧义。
// 拼接结果同时是 Map 的键，任何分隔符改动都会让旧桶瞬间变成孤儿。
// 不要在这里再做大小写归一化，canonicalInterface 已经处理过。
// bucketKey 返回的键只用于内存索引，不进入上报载荷。
function bucketKey(transport: NetworkTransportKind, iface: string): string {
  return `${transport}\0${iface}`;
}

// http 走 URL 归一化，其余 transport 只做字符白名单清洗，两条路径不能合并。
// canonicalInterface 处理非 http 的接口名时，来源常为插件与本地扩展：路径分隔符会被替换成下划线，否则不能当标签。
// 清洗后为空时回退为 unknown，避免空字符串成为 Map 的键。
// 长度截断到 120 是上报侧字段限制，这个截断不能挪到 URL 解析之前。
function canonicalInterface(transport: NetworkTransportKind, value: string): string {
  if (transport === "http") {
    return normalizeHttpInterface(value);
  }
  const normalized = value.trim().replace(/[^a-zA-Z0-9_.:-]+/gu, "_");
  return (normalized || "unknown").slice(0, 120);
}

// 这是基数保护的唯一闸门：所有建桶路径都必须先经过它。
// 已存在的桶直接放行，否则高基数场景下稳定接口会被反复挤进 other。
// transportBucketCount 每次调用都会现扫全表，属于与桶数同阶的热路径，桶数已被上限压住。
// 预留一个名额给 other，保证被拒绝的接口仍有地方落账。
// 不要改成按 transport 维护独立计数字段，桶的删除路径会让计数漂移。
function resolveBucketInterface(transport: NetworkTransportKind, value: string): string {
  const iface = canonicalInterface(transport, value);
  if (buckets.has(bucketKey(transport, iface))) {
    return iface;
  }
  let transportBucketCount = 0;
  for (const bucket of buckets.values()) {
    if (bucket.transport === transport) {
      transportBucketCount += 1;
    }
  }
  if (
    iface !== "other" &&
    // 减一是给 other 桶预留位置，否则 other 自己也会被拒绝，观测直接丢失。
    // 判断必须在计数完成之后、返回之前，顺序颠倒会让第 128 个桶被误放行。
    // 上限触发后返回 other，而不是丢弃样本，宁可粗粒度也不能缺数据。
    // 若把 other 也纳入同样的上限判断，所有观测会挤到未知桶上形成雪崩。
    transportBucketCount >= MAX_NETWORK_INTERFACE_BUCKETS_PER_TRANSPORT - 1
  ) {
    return "other";
  }
  return iface;
}

function getOrCreateBucket(observation: NetworkObservation): InterfaceBucket {
  const iface = resolveBucketInterface(observation.transport, observation.interface);
  const key = bucketKey(observation.transport, iface);
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      transport: observation.transport,
      interface: iface,
      durations: [],
      dns: [],
      tcp: [],
      tls: [],
      ttfb: [],
      download: [],
      successCount: 0,
      failCount: 0,
      retryCount: 0,
      errorCounts: new Map(),
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

// 未上报与上报为零是两种语义：前者是连接复用没有该阶段，后者是耗时确实为零。
// 负数与 NaN、Infinity 都丢弃，否则分位数计算会被污染。
// 不要把缺失值补成零，那会把中位数与均值整体拉低。
// 这里只写样本数组，不更新计数，计数由 recordNetworkObservation 负责。
function pushIfPositive(target: number[], value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return;
  }
  target.push(value);
}

// 这是写入侧唯一入口，所有来源都必须先转成 NetworkObservation 再进来。
// 先建桶再写样本：建桶失败时不能留下半截统计。
// 总耗时无条件写入，阶段耗时按可用性写入，两者口径不同不能共用同一个过滤。
// 该函数没有返回值也不抛错，异常输入由各字段自身过滤，调用方无需包 try。
export function recordNetworkObservation(observation: NetworkObservation): void {
  const bucket = getOrCreateBucket(observation);
  // [缺陷 D-14-1] durations 直接 push observation.durationMs，没有有限性校验；pushIfPositive 的过滤只覆盖阶段耗时，所以 :284「异常输入由各字段自身过滤」在 durations 上不成立。
  bucket.durations.push(observation.durationMs);
  pushIfPositive(bucket.dns, observation.dnsMs);
  pushIfPositive(bucket.tcp, observation.tcpMs);
  pushIfPositive(bucket.tls, observation.tlsMs);
  pushIfPositive(bucket.ttfb, observation.ttfbMs);
  pushIfPositive(bucket.download, observation.downloadMs);

  if (observation.ok) {
    bucket.successCount += 1;
  } else {
    bucket.failCount += 1;
    const kind = normalizeErrorKind(observation.errorKind);
    bucket.errorCounts.set(kind, (bucket.errorCounts.get(kind) ?? 0) + 1);
  }

  // attempt 缺省为 1 表示首次尝试，此时不产生重试计数。
  // 重试数是 attempt 减一的累加，不是把 attempt 求和。
  // 单条观测 attempt 为 3 时贡献 2 次重试，跨观测是相加关系。
  // 不要在这里把 attempt 归一到布尔值，会丢失重试次数信息。
  const attempt = observation.attempt ?? 1;
  if (attempt > 1) {
    bucket.retryCount += attempt - 1;
  }
}

// 这是 HTTP 指标标签的唯一生成器，返回值的基数直接决定看板可用性。
// url 优先于 name：ARMS 事件里 name 就是完整链接，但调用方也可能只给名字。
// 解析失败与本地路径都返回固定值，绝不让原始字符串穿透。
// normalizeHttpInterface 的输出由 slice(0, 120) 截断，截断后可能产生同前缀碰撞，这是有意接受的权衡。
export function normalizeHttpInterface(name?: string, url?: string): string {
  const raw = (url ?? name ?? "").trim();
  if (!raw) {
    return "unknown";
  }
  if (
    /^file:/iu.test(raw) ||
    /^[a-zA-Z]:[\\/]/u.test(raw) ||
    // Bug 根因：枚举常见根目录会漏掉 /opt、/root、/mnt 等合法 POSIX 绝对路径。
    raw.startsWith("/")
  ) {
    return "local_file";
  }
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (parsed.protocol === "file:" || !parsed.host) {
      return "local_file";
    }
    const path = parsed.pathname
      .split("/")
      .map((segment) => normalizeHttpPathSegment(segment))
      .join("/")
      .replace(/\/+$/u, "");
    return `${parsed.host}${path}`.slice(0, 120);
  } catch {
    return "unknown";
  }
}

// 先解码再判定：编码后的百分号形式与明文必须得到同一结果。
// 空段保留原样，保证尾部斜杠在拼接阶段还能被识别。
// 命中白名单才保留，其余一律折叠，这是默认拒绝而不是默认放行。
// 不要为了保留订单号之类的可读性把数字段加进 STATIC_HTTP_PATH_SEGMENTS，数字正是高基数的来源。
// normalizeHttpPathSegment 只处理单段，路径整体的去尾斜杠由 normalizeHttpInterface 负责。
function normalizeHttpPathSegment(segment: string): string {
  const decoded = safeDecodeURIComponent(segment);
  if (!decoded || STATIC_HTTP_PATH_SEGMENTS.has(decoded)) {
    return decoded;
  }
  // Bug 根因：旧实现默认保留未命中规则的 segment，邮箱和短用户 slug 会直接进入 ARMS。
  return ":id";
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 入参是外部上报的松散 JSON，字段类型全部不可信，必须逐项做类型收窄。
// 只接受 api 与含 resource 的事件类型，其余静默丢弃，避免污染接口统计。
// 成功判定兼容布尔、数字与字符串三种形态，这是上报端历史差异导致的。
// 数值字段统一走 Number 转换并做有限性校验，防止字符串数字被当成 NaN。
export function ingestArmsApiEvent(event: Record<string, unknown>): void {
  const eventType = String(event.event_type ?? event.type ?? "").toLowerCase();
  if (eventType !== "api" && !eventType.includes("resource")) {
    return;
  }

  const url =
    typeof event.name === "string" ? event.name : typeof event.url === "string" ? event.url : "";
  const statusCode =
    typeof event.status_code === "number"
      ? event.status_code
      : typeof event.status_code === "string"
        ? Number(event.status_code)
        : undefined;
  const successFlag = event.success;
  const ok =
    successFlag === true ||
    successFlag === 1 ||
    successFlag === "1" ||
    (typeof statusCode === "number" && statusCode >= 200 && statusCode < 400);

  const times = typeof event.times === "number" ? event.times : 1;
  const duration =
    typeof event.duration === "number"
      ? event.duration
      : typeof event.duration === "string"
        ? Number(event.duration)
        : 0;

  recordNetworkObservation({
    transport: "http",
    interface: normalizeHttpInterface(url, url),
    durationMs: Number.isFinite(duration) ? duration : 0,
    ok,
    statusCode: Number.isFinite(statusCode) ? statusCode : undefined,
    errorKind: ok ? undefined : classifyHttpError(statusCode),
    attempt: times,
    dnsMs: readDurationField(event, "dns_duration"),
    tcpMs: readDurationField(event, "connect_duration"),
    tlsMs: readDurationField(event, "ssl_duration"),
    ttfbMs: readDurationField(event, "first_byte_duration"),
    downloadMs: readDurationField(event, "download_duration"),
  });
}

function readDurationField(event: Record<string, unknown>, key: string): number | undefined {
  const raw = event[key];
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function classifyHttpError(statusCode?: number): string {
  if (statusCode === 408) {
    return "timeout";
  }
  if (statusCode === 0) {
    return "connection_reset";
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return "server_error";
  }
  if (statusCode !== undefined && statusCode >= 400) {
    return "client_error";
  }
  return "other";
}

function buildStats(bucket: InterfaceBucket): InterfaceNetworkStats {
  const requestTotal = bucket.successCount + bucket.failCount;

  const errorCounts: Partial<Record<NetworkErrorKind, number>> = {};
  for (const [kind, count] of bucket.errorCounts) {
    errorCounts[kind] = count;
  }
  let primaryErrorKind: NetworkErrorKind | undefined;
  let primaryErrorCount = 0;
  for (const kind of NETWORK_ERROR_KIND_ORDER) {
    const count = errorCounts[kind] ?? 0;
    if (count > primaryErrorCount) {
      primaryErrorKind = kind;
      primaryErrorCount = count;
    }
  }

  return {
    transport: bucket.transport,
    interface: bucket.interface,
    requestTotal,
    successCount: bucket.successCount,
    failCount: bucket.failCount,
    retryCount: bucket.retryCount,
    primaryErrorKind,
    primaryErrorCount,
    duration: computeAggregateStats(bucket.durations),
    dns: computeAggregateStats(bucket.dns),
    tcp: computeAggregateStats(bucket.tcp),
    tls: computeAggregateStats(bucket.tls),
    ttfb: computeAggregateStats(bucket.ttfb),
    download: computeAggregateStats(bucket.download),
    errorCounts,
  };
}

// 破坏性读取：函数返回即清空全局桶，调用方必须一次消费完返回值。
// 先建快照再清空，顺序颠倒会丢掉本轮观测。
// 按 transport 分组后各自排序截断，配额不会跨 transport 挪用。
// flushInterfaceNetworkStats 的默认 maxPerTransport 取 40 是上报载荷的保守值，调大要评估下游写入压力。
export function flushInterfaceNetworkStats(maxPerTransport = 40): InterfaceNetworkStats[] {
  const grouped = new Map<NetworkTransportKind, InterfaceNetworkStats[]>();

  for (const bucket of buckets.values()) {
    if (bucket.durations.length === 0) {
      continue;
    }
    const stats = buildStats(bucket);
    const list = grouped.get(stats.transport) ?? [];
    list.push(stats);
    grouped.set(stats.transport, list);
  }

  // 这一行是 flush 的提交点：只有全部快照构建完成后才允许清空。
  // buckets.clear() 不是重置计数，桶对象会随 Map 一起失效，旧引用不要继续使用。
  // 与 resetNetworkTelemetryAggregator 里的同名调用语义不同，后者是丢弃而非上报。
  // 若未来改成失败重试，需要在清空前持久化快照，否则本轮数据永久丢失。
  buckets.clear();

  const result: InterfaceNetworkStats[] = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => b.requestTotal - a.requestTotal);
    result.push(...list.slice(0, maxPerTransport));
  }

  return result;
}

export function resetNetworkTelemetryAggregator(): void {
  buckets.clear();
}
