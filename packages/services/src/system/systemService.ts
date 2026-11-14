// 系统信息服务：聚合 homedir/platform 与集成终端 shell，探测目标由调用方决定。
// 探测部分只做归一化与执行，超时、重试与判定阈值都必须由调用方显式传入。
// probeIntranet 不读全局配置，也不替调用方选择产品策略。
//
// INV-01：归一化后的目标集合里不存在 host 为空或 URL 非法的项（守住它的位置：
//   normalizeTcpTarget/normalizeServiceTarget 返回 null 后被 filter 剔除）。
//   破坏后果：空 host 会让 socket.connect 抛同步异常，整个 probeIntranet 直接 reject，
//   用户看到的是探测失败而不是某目标不可达，其余目标也拿不到结果。
// INV-02：timeoutMs 必须恒在 [100, 10000]，attempts 恒在 [1, 3]，requiredSuccessCount 恒在
//   [1, totalTargets]（守住它的位置：三个 normalize 函数）。破坏后果：0 次尝试会让
//   lastError 恒为空且结果永远 reachable=false；超大超时会让一次探测拖住整个设置页。
// INV-03：reachable=true 时 attemptCount 等于真正成功的轮次（守住它的位置：
//   runProbeWithRetry/runServiceProbeWithRetry 的 return）。破坏后果：UI 用 attemptCount
//   区分一次就通与重试后才通，写错会把偶发连通误报为稳定可用。
// INV-04：探测永不因单个目标失败而整体 reject（守住它的位置：两个 run*WithRetry 的 catch）。
//   破坏后果：一个断网 IP 会让整批结果丢失，isIntranet 被判为 false，把用户误导向外网链路。
// INV-05：套接字在 resolve/reject 之前必定 destroy，且只 settle 一次（守住它的位置：
//   probeTcpPort 的 finalize）。破坏后果：未销毁的连接泄漏文件描述符，重复探测后 EMFILE；
//   重复 settle 会让 Promise 状态与实际上报不一致。
// INV-06：isIntranet 要求 totalTargets > 0 与 reached >= required 同时成立（守住它的位置：
//   probeIntranet 的 return）。破坏后果：空目标列表被判成在内网，让外网用户走内网代理。
//
// probeIntranet 不负责选择目标与阈值，阈值由调用方给出，避免策略散落在两处。
import { homedir } from "node:os";
import { Socket } from "node:net";
import type {
  IntegratedTerminalShellOption,
  IntranetProbeRequest,
  IntranetProbeResult,
  IntranetProbeServiceResponse,
  IntranetProbeServiceTarget,
  IntranetProbeServiceTargetResult,
  IntranetProbeTarget,
  IntranetProbeTcpTarget,
  IntranetProbeTcpTargetResult,
  SystemInfo,
} from "@zcode/shared";
import type { ISystemService } from "./system.js";
import { listIntegratedTerminalShellOptions } from "./integratedTerminalShells.js";

// 800ms 是经验值：内网 RTT 通常低于 5ms，公网 TCP SYN 超时常见 1s 以上；
// DEFAULT_PROBE_TIMEOUT_MS 取 800ms：内网快速放行，公网黑洞也在 1 秒内返回。
// 重试 2 次、上限 3 次：重试吸收丢包与 DNS 抖动，上限防止调用方传大值拖住探测队列。
// 默认端口 22 只是兜底：SSH 端口是最常见的可探内网假设，调用方通常显式给端口。
const DEFAULT_PROBE_TIMEOUT_MS = 800;
const DEFAULT_PROBE_ATTEMPTS = 2;
const MAX_PROBE_ATTEMPTS = 3;
const DEFAULT_PROBE_PORT = 22;

// NormalizedProbeTarget 只保留探测真正需要的字段，与协议类型必须解耦。
// 并在构造期一次性算好 targetId、端口与超时，执行阶段不再做任何判断。
interface NormalizedProbeTarget {
  kind: "tcp";
  targetId: string;
  host: string;
  port: number;
  timeoutMs: number;
}

interface NormalizedServiceProbeTarget {
  kind: "service";
  targetId: string;
  url: string;
  expectedMarker?: string;
  token?: string;
  timeoutMs: number;
}

// 判别联合让执行分支靠 kind 收窄，避免用类型断言把 service 字段读到 tcp 上。
// 新增探测类型时必须同步扩展这里，否则 resolveProbeStrategy 会误判为 mixed。
type NormalizedTarget = NormalizedProbeTarget | NormalizedServiceProbeTarget;

interface TcpProbeParams {
  host: string;
  port: number;
  timeoutMs: number;
}

// 依赖注入点：平台、env、可执行性判断、两种探测实现与时钟都可替换。
// CreateSystemServiceOptions 不是为测试而设：桌面与远端跑同一份代码但布局不同，
// 只有显式注入才能在不给每个平台编译分支的前提下复用同一套判定逻辑。
// 各注入项由装配层决定：env/platform 描述目标机器，tcpProbe/serviceProbe 描述可用网络栈。
interface CreateSystemServiceOptions {
  env?: NodeJS.ProcessEnv;
  isExecutable?: (path: string) => boolean;
  platform?: NodeJS.Platform;
  tcpProbe?: (params: TcpProbeParams) => Promise<number>;
  serviceProbe?: (params: ServiceProbeParams) => Promise<ServiceProbeResult>;
  now?: () => number;
}

interface ServiceProbeParams {
  url: string;
  timeoutMs: number;
  token?: string;
}

interface ServiceProbeResult {
  latencyMs: number;
  marker?: string;
}

// 非数字、NaN、Infinity 都退回默认值而不是抛错：这些值可能来自跨进程协议，
// 属于不可信输入，抛错会变成一次未捕获的 RPC 异常。取整用 floor，
// 保证 2.9 不会被当成 3 次尝试，从而绕过用户实际能看到的配置。
function normalizeProbeAttempts(attempts: number | undefined): number {
  if (typeof attempts !== "number" || !Number.isFinite(attempts)) {
    return DEFAULT_PROBE_ATTEMPTS;
  }

  // 夹紧后再用于循环上界：调用方依赖 attempts 恒有限，否则 for 循环会不终止。
  return Math.min(MAX_PROBE_ATTEMPTS, Math.max(1, Math.floor(attempts)));
}

// 阈值的语义是至少几个目标可达，必须夹在 [1, totalTargets]：小于 1 会让空目标
// 也算成功（破坏 INV-06），大于 totalTargets 则永远不可能成立，用户只会看到
// 永远不在内网却找不到原因。totalTargets<=0 时返回 1 只是占位，
// 真正的判定在此之前已被 totalTargets > 0 拦掉。
function normalizeRequiredSuccessCount(
  requiredSuccessCount: number | undefined,
  totalTargets: number,
): number {
  if (totalTargets <= 0) {
    return 1;
  }

  if (typeof requiredSuccessCount !== "number" || !Number.isFinite(requiredSuccessCount)) {
    return 1;
  }

  return Math.min(totalTargets, Math.max(1, Math.floor(requiredSuccessCount)));
}

// normalizeProbeTimeout 下限 100ms：传 0 会让超时立刻触发、把正常目标判死；上限 10s 防止一次探测
// 长时间占住设置页；两个边界必须落在用户可感知的量级，不能随手写魔数。
function normalizeProbeTimeout(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.min(10_000, Math.max(100, Math.floor(timeoutMs)))
    : DEFAULT_PROBE_TIMEOUT_MS;
}

// TCP 目标只接受非空 host，其余字段全部兜底或丢弃。返回 null 而不是抛错，
// 让上层用一次 filter 剔除非法项（INV-01），批量探测里混入脏数据不会连累其他目标。
// [失败路径] 这里不做 DNS 解析或主机名格式校验：是否可达由探测本身回答，
// 提前校验反而会拒绝 localhost、IPv6 字面量等合法但写法特殊的输入。
function normalizeTcpTarget(target: IntranetProbeTcpTarget): NormalizedProbeTarget | null {
  const host = target.host.trim();
  if (host.length === 0) {
    return null;
  }

  // 端口用整数判断而非 Number() 强转：接受字符串 22 会让类型约束失效，
  // 宁可退回默认端口，并在结果里体现真实的连接失败原因。
  const resolvedPort =
    typeof target.port === "number" &&
    Number.isInteger(target.port) &&
    target.port >= 1 &&
    target.port <= 65535
      ? target.port
      : DEFAULT_PROBE_PORT;

  return {
    kind: "tcp",
    targetId: target.id?.trim() || `${host}:${resolvedPort}`,
    host,
    port: resolvedPort,
    timeoutMs: normalizeProbeTimeout(target.timeoutMs),
  };
}

// HTTP 目标必须能构造 URL 且只允许 http/https：file: 与 ftp: 交给 fetch
// 会抛出不同类型的异常，提前拦掉可让失败原因保持单一（不可达），也避免本地文件读取。
// 空 url 与解析失败都返回 null，由上层统一计为被过滤项。
// expectedMarker 与 token 去掉空白后为空即视作未配置，否则空串会被当成
// 必须匹配空标记，导致任何不带 marker 的服务都被判为不匹配。
// [权衡] 不强制要求 https：内网常是自签证书的明文 HTTP，强制升级会直接不可用。
function normalizeServiceTarget(
  target: IntranetProbeServiceTarget,
): NormalizedServiceProbeTarget | null {
  const urlText = target.url.trim();
  if (urlText.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlText);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return null;
  }

  const expectedMarker = target.expectedMarker?.trim();
  const token = target.token?.trim();

  return {
    kind: "service",
    targetId: target.id?.trim() || parsedUrl.toString(),
    url: parsedUrl.toString(),
    expectedMarker: expectedMarker && expectedMarker.length > 0 ? expectedMarker : undefined,
    token: token && token.length > 0 ? token : undefined,
    timeoutMs: normalizeProbeTimeout(target.timeoutMs),
  };
}

// 分发只看 kind；未知 kind 落到 TCP 分支，是为兼容旧客户端只发 host/port 的请求。
function normalizeProbeTarget(target: IntranetProbeTarget): NormalizedTarget | null {
  if (target.kind === "service") {
    return normalizeServiceTarget(target);
  }

  return normalizeTcpTarget(target);
}

// TCP 重试循环：只有最后一次失败的结果会被返回，中间失败只保留 message。
// 保留最后一次错误文本，是因为超时与拒绝连接对用户的可行动信息完全不同
// （前者查防火墙，后者查服务）。重试之间不 sleep：内网探测追求最短判定时间，
// 退避会把 3 次尝试拖到秒级，失去快速判定的意义。
// 成功时 attemptCount 返回当前轮次，供 UI 区分稳定连通与抖动后连通（INV-03）。
async function runProbeWithRetry(
  target: NormalizedProbeTarget,
  attempts: number,
  tcpProbe: (params: TcpProbeParams) => Promise<number>,
): Promise<IntranetProbeTcpTargetResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const latencyMs = await tcpProbe({
        host: target.host,
        port: target.port,
        timeoutMs: target.timeoutMs,
      });
      return {
        targetId: target.targetId,
        kind: "tcp",
        host: target.host,
        port: target.port,
        reachable: true,
        attemptCount: attempt,
        latencyMs,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    targetId: target.targetId,
    kind: "tcp",
    host: target.host,
    port: target.port,
    reachable: false,
    attemptCount: attempts,
    latencyMs: null,
    error: lastError || "probe failed",
  };
}

// 探测端点的响应来自网络，属于完全不可信输入，必须逐字段校验后再使用。
// parseProbeServiceResponse 只校验 ok 与 marker；其余字段必须原样透传，不能把协议演进绑死在探测实现上。
// 校验失败统一抛 Error，由重试循环记为该轮失败，而不是让异常穿透到 RPC 层。
function parseProbeServiceResponse(payload: unknown): IntranetProbeServiceResponse {
  if (!payload || typeof payload !== "object") {
    throw new Error("invalid service response");
  }

  const response = payload as IntranetProbeServiceResponse;
  if (typeof response.ok !== "boolean") {
    throw new Error("invalid service response: missing ok");
  }

  if (
    "marker" in response &&
    response.marker !== undefined &&
    typeof response.marker !== "string"
  ) {
    throw new Error("invalid service response: marker must be string");
  }

  return response;
}

// 用 fetch 加 AbortController 实现 HTTP 探测，而不是 node:http：
// 需要 https、重定向与代理环境变量的一致行为，手写实现会漏掉其中一项。
// 超时必须由 AbortController 承担，fetch 本身没有 timeout 选项；
// marker 只在响应 ok 后读取，ok=false 视为服务存活但不可用，仍按失败处理。
// [失败路径] AbortError 被翻译成带毫秒数的 message，让用户知道是超时而非被拒绝。
async function probeServiceEndpoint(params: ServiceProbeParams): Promise<ServiceProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    // token 通过自定义请求头传递而不是 query：query 会进入服务端访问日志与浏览器历史，
    // 泄漏内网探测凭据。未配置时传 undefined，保持请求头为空。
    const response = await fetch(params.url, {
      method: "GET",
      headers: params.token ? { "x-zcode-intranet-token": params.token } : undefined,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const responseBody = parseProbeServiceResponse(await response.json());
    if (!responseBody.ok) {
      throw new Error("service returned ok=false");
    }

    return {
      latencyMs: Math.max(0, Date.now() - startedAt),
      marker: responseBody.marker,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`timeout(${params.timeoutMs}ms)`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

// 服务探测的重试与 TCP 版同构，但多一层语义校验：HTTP 200 只说明端点活着，
// expectedMarker 才能确认这是目标服务而不是同端口上的其他应用或登录页。
// marker 不匹配按失败重试，因为滚动发布期间可能新旧实例混跑。
// 失败结果同样保留最后一次原因，便于区分超时、HTTP 状态与 marker 不匹配。
// [权衡] 不在 probeServiceEndpoint 内校验 marker：那是传输层实现，替换注入后校验会丢。
async function runServiceProbeWithRetry(
  target: NormalizedServiceProbeTarget,
  attempts: number,
  serviceProbe: (params: ServiceProbeParams) => Promise<ServiceProbeResult>,
): Promise<IntranetProbeServiceTargetResult> {
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await serviceProbe({
        url: target.url,
        timeoutMs: target.timeoutMs,
        token: target.token,
      });

      // 严格不等比较：marker 缺失（undefined）也算不匹配，不能把没带标记当作通过，
      // 否则一个恰好返回 200 的陌生服务就能让整批判定翻转。
      if (target.expectedMarker && result.marker !== target.expectedMarker) {
        throw new Error(
          `marker mismatch(expected=${target.expectedMarker}, actual=${result.marker ?? "<empty>"})`,
        );
      }

      return {
        targetId: target.targetId,
        kind: "service",
        url: target.url,
        reachable: true,
        attemptCount: attempt,
        latencyMs: result.latencyMs,
        marker: result.marker,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    targetId: target.targetId,
    kind: "service",
    url: target.url,
    reachable: false,
    attemptCount: attempts,
    latencyMs: null,
    error: lastError || "probe failed",
  };
}

// resolveProbeStrategy 只描述探测方式供 UI 说明，返回值不参与 isIntranet 判定。
// 空数组被 every 判为 true 会落到 tcp-connect，这是有意为之：无目标时策略无意义。
function resolveProbeStrategy(targets: NormalizedTarget[]): IntranetProbeResult["strategy"] {
  if (targets.every((target) => target.kind === "tcp")) {
    return "tcp-connect";
  }
  if (targets.every((target) => target.kind === "service")) {
    return "service-http";
  }
  return "mixed";
}

// 手写 Socket 探测而不是直接 net.connect：需要同时处理 connect/timeout/error
// 三条终止路径，并保证只 settle 一次。Node 的 Socket 超时后不会自动断开，
// 不显式 destroy 会一直占用描述符（INV-05）。
// 超时用 socket.setTimeout 而不是外层 setTimeout：前者与 error 事件共用同一条
// 清理路径，不会出现外部计时器已触发而 socket 仍在连接中的窗口。
// 计时必须在建连前开始，使 latencyMs 包含 DNS 解析时间，反映用户真实等待。
function probeTcpPort(params: TcpProbeParams): Promise<number> {
  const { host, port, timeoutMs } = params;
  const startedAt = Date.now();

  return new Promise<number>((resolve, reject) => {
    const socket = new Socket();
    // settled 是幂等闸门：connect 与 timeout 可能在同一 tick 内先后触发，
    // 没有它会出现 resolve 后再 reject（被静默忽略）或重复 destroy 的竞态。
    let settled = false;

    const finalize = (handler: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      handler();
    };

    // 监听器用 once：终止事件只应处理一次，removeAllListeners 只是兜底；
    // 先注册再 connect，避免本机端口极快连通时错过 connect 事件。
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      const latencyMs = Math.max(0, Date.now() - startedAt);
      finalize(() => resolve(latencyMs));
    });
    socket.once("timeout", () => {
      finalize(() => reject(new Error(`timeout(${timeoutMs}ms)`)));
    });
    socket.once("error", (error) => {
      // [资源] 错误路径同样走 finalize：先摘监听器再 destroy，最后才 reject，
      // 保证调用方拿到失败时描述符已释放，重试循环里不会累积泄漏。
      finalize(() => reject(error));
    });
    socket.connect(port, host);
  });
}

// 服务工厂：把可注入依赖固化在闭包里，返回的方法每次使用的是创建时的 env 与 platform，
// 而不是调用时的 process.*。这保证同一进程内多个实例（桌面本地与远端）互不串味，
// 也让 createSystemService 的测试无需污染 process.env。
// [权衡] 不在工厂里做参数校验：默认值本身合法，额外校验不能收敛任何非法输入。
// 非法输入已在各 normalize 函数里被收敛。
export function createSystemService(options: CreateSystemServiceOptions = {}): ISystemService {
  // tcpProbe/serviceProbe 的注入来自装配层：桌面本地与远端共用本文件，但套接字与 fetch 的实现可能不同。
  // 缺省时才落到本机实现；调用方传入的实现必须自行遵守 timeoutMs，本文件不再二次包裹超时。
  const tcpProbe = options.tcpProbe ?? probeTcpPort;
  const serviceProbe = options.serviceProbe ?? probeServiceEndpoint;
  // now 只用于 checkedAt：调用方注入固定时钟可让探测结果在测试里稳定复现。
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;

  return {
    // info() 的调用方是设置页系统信息卡，只读取展示字段，不参与探测决策。
    async info(): Promise<SystemInfo> {
      // 这里读真实进程值而不是注入的 options：该接口回报的是当前进程所在机器，
      // 与探测用的 platform 语义不同，混用会让远端面板显示错误的本机信息。
      // homedir 与 platform 每次都重新取：容器或远程会话中账户目录可能在进程存续期间被替换。
      return { homedir: homedir(), platform: process.platform };
    },

    // shell 探测依赖 env 与 isExecutable，必须原样透传，否则在远端或容器场景
    // 会按宿主机的 PATH 判断出一个在目标机上并不存在的 shell。
    // listIntegratedTerminalShells 的调用方是终端设置页；真正 spawn 由终端会话负责。
    async listIntegratedTerminalShells(): Promise<IntegratedTerminalShellOption[]> {
      return listIntegratedTerminalShellOptions({
        env,
        isExecutable: options.isExecutable,
        platform,
      });
    },

    // probeIntranet 主流程：归一化 → 计算阈值 → 并发执行 → 汇总。
    // 非法目标在此被静默剔除（INV-01），totalTargets 只能报告有效目标数，
    // 因此 UI 上的 3/5 可达不会因为脏数据而分母虚高。
    // 阈值必须在归一化之后计算，否则 totalTargets 为 0 时阈值恒为 1，判定提前失效。
    async probeIntranet(request: IntranetProbeRequest): Promise<IntranetProbeResult> {
      const normalizedTargets = request.targets
        .map(normalizeProbeTarget)
        .filter((target): target is NormalizedTarget => target !== null);
      // attempts 来自 renderer 的探测请求，属于跨进程输入，非法值在 normalize 内必须收敛为 1..3。
      const attempts = normalizeProbeAttempts(request.attempts);
      const requiredSuccessCount = normalizeRequiredSuccessCount(
        request.requiredSuccessCount,
        normalizedTargets.length,
      );

      // 并发而非串行：每个目标最坏 attempts*timeout，串行会线性叠加。
      // 两个 run*WithRetry 内部已保证不抛错，因此 Promise.all 不会被单个目标拒绝
      // （INV-04），也不需要 allSettled 再过滤，少一层分支。
      // Promise.all 的并发上限等于目标数：目标由调用方挑选，本文件不再限流，避免与调用方的队列策略重复。
      const results = await Promise.all(
        normalizedTargets.map((target) => {
          if (target.kind === "service") {
            return runServiceProbeWithRetry(target, attempts, serviceProbe);
          }
          return runProbeWithRetry(target, attempts, tcpProbe);
        }),
      );
      // 只统计 reachable=true：attemptCount 大于 0 不代表成功，重试耗尽的记录同样带轮次。
      // reachedTargetCount 是 UI 展示分子；与 totalTargets 一起由调用方解读，本文件不据此缓存结论。
      const reachedTargetCount = results.filter((result) => result.reachable).length;

      return {
        isIntranet: normalizedTargets.length > 0 && reachedTargetCount >= requiredSuccessCount,
        reachedTargetCount,
        requiredSuccessCount,
        totalTargets: normalizedTargets.length,
        checkedAt: now(),
        // checkedAt 由注入时钟提供，便于测试与远端时间对齐，不在实现里直读 Date.now。
        strategy: resolveProbeStrategy(normalizedTargets),
        results,
      };
    },
  };
}
