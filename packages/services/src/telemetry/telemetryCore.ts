// 本文件是 telemetry 的装配、去重、上报与落盘状态的唯一入口，整条链路按「尽力而为」设计：
// 任何失败都必须降级为丢事件，不得把异常反向抛给触发埋点的业务调用方。
// INV-01：出网只能经过 sendReportAttempt；端点重写、身份头、detail 脱敏必须同源，
//         绕过该函数会让带 Authorization 的头或未清洗的 detail 直出（守住：sendReport / sendReportAttempt）。
// INV-02：上报必须先经 trackReport 登记再返回，flushPendingReports 只依据这个集合等待退出；
//         未登记的请求在进程退出时静默丢失（守住：trackReport / flushPendingReports）。
// INV-03：dailyActiveInFlight 只允许在持有 telemetry-state.lock 的临界区内增删；
//         锁外改动会让并发实例各发一次 daily_active，按日去重失效（守住：reportAppDailyActive）。
// INV-04：deviceMid 一旦生成即持久化，同一 state 文件的所有进程必须读到同一个值；
//         否则服务端会把同一设备算成两台，billing 与设备维度看板同时失真（守住：ensureDeviceMidInLockedState）。
// INV-05：deviceMidCacheByStateFile 只允许缓存未决 Promise，失败必须自清除；
//         否则一次瞬时锁超时会让本进程后续所有上报永久失败（守住：ensureTelemetryDeviceMid）。
// INV-06：退出等待受总 deadline 约束，超时只告警放行；改成无限等待会顶住进程退出（守住：flushPendingReports）。
/* oxlint-disable eslint(max-lines) -- telemetry state lock、deviceMid 编排和上报路径共享同一状态文件，拆分会增加锁语义漂移风险。 */
import {
  createUuid,
  ZCODE_VERSION,
  ZCODE_ENV,
  ZCODE_TELEMETRY_REPORT_ENDPOINT,
  buildZCodeSourceHeadersFromContext,
  rewriteZCodeEndpointUrl,
  sanitizeTelemetryEventDetail,
  type TelemetryEventPayload,
  type TelemetryRendererContext,
  type OAuthLoginAttribution,
} from "@zcode/shared";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { version } from "node:os";
import { dirname, join } from "node:path";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

// 端点固定取自 shared 的构建期常量，本文件不读环境变量：上报目标必须与二进制一起审计，
// 运行时可改等于可被劫持到未知主机。空字符串代表该构建不启用上报，所有入口退化为 no-op。
const REPORT_ENDPOINT = ZCODE_TELEMETRY_REPORT_ENDPOINT;

// session_create 的 eventId 由 (userId, sessionId) 确定性哈希得出，跨进程、跨重启稳定，
// 服务端据此把「同一会话被重复回调」幂等去重。
// [权衡] 用 SHA-256 而不是 uuidv4：随机 ID 每次回调都变，重放会被计成新会话；
// 代价是 ID 可被预测，但 eventId 不承担授权语义，可接受。
// 末两步位掩码把第 6/8 字节改成 RFC 4122 变体，使下游 UUID 解析器不会拒收自定义哈希值。
function sessionCreateEventId(userId: string, sessionId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["zcode:session_create:v1", userId, sessionId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x80;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// [并发] 锁重试窗口约为 200 × 10ms ≈ 2s，是「启动期多进程抢锁」与「上报不阻塞太久」的折中：
// 调小会让合法的短临界区被误判超时，调大则在最坏情况下更久地拖住调用方。
// LOCK_STALE_MS 必须显著大于任一临界区耗时（临界区内只有文件读写，没有网络），
// 否则会把仍在工作的持有者当成孤儿锁删除，让两个进程同时进入临界区。
const LOCK_RETRY_DELAY_MS = 10;
// 重试上限与延迟共同决定最长等待时间，改动任意一个都必须重新评估另一个。
const LOCK_RETRY_COUNT = 200;
const LOCK_STALE_MS = 5 * 60 * 1000;
// in-flight 占位的寿命必须大于单次上报的最坏耗时（两次 5s 超时加退避），
// 否则占位先过期，第二个进程会在第一个仍在发送时重复上报当天事件。
const DAILY_ACTIVE_IN_FLIGHT_TTL_MS = 5 * 60 * 1000;
const REPORT_REQUEST_TIMEOUT_MS = 5_000;
const REPORT_RETRY_DELAY_MS = 300;
// 429 走更长退避：限流窗口通常以秒计，300ms 后重试基本必然再次被拒。
const REPORT_RATE_LIMIT_RETRY_DELAY_MS = 1_000;
// 有界重试：公共 /event/report 的故障多为瞬断，两次足以覆盖抖动；
// 无限重试会在服务端故障时堆满待发请求，并让进程无法退出。
const REPORT_MAX_ATTEMPTS = 2;

// 依赖注入面：默认值全部指向真实环境，测试可替换 fetch、时钟与随机源以消除不确定性。
// loadUserId 与 loadAuthorization 分离，是因为前者每条事件都要用，后者只在出网时读一次。
interface TelemetryCoreDependencies {
  fetchImpl?: typeof fetch;
  loadUserId?: () => Promise<string>;
  loadAuthorization?: (userId: string) => Promise<string | null>;
  loadMarketingParams?: () => Promise<OAuthLoginAttribution | null>;
  randomUUID?: () => string;
  now?: () => number;
  appVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  releaseChannel?: string;
  osVersion?: string;
  homeDir?: string;
  resolveZCodeEndpointOrigin?: () => Promise<string> | string;
  requestTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  warn?: (message: string) => void;
}

// 失败分类只用于重试决策与脱敏日志，不进入请求体：枚举变化不影响服务端契约。
type TelemetryFailureCategory =
  | "network"
  | "timeout"
  | "http_408"
  | "http_429"
  | "http_5xx"
  | "http_4xx"
  | "http_other";

// 携带 category 与 retryable 的错误类型，让重试决策不依赖对错误消息的字符串匹配；
// 否则任何措辞调整都会悄悄改变线上重试行为。
class TelemetryReportError extends Error {
  constructor(
    readonly category: TelemetryFailureCategory,
    readonly retryable: boolean,
    status?: number,
  ) {
    super(
      status === undefined
        ? `Telemetry report failed: ${category}`
        : `Telemetry report failed with status ${status}`,
    );
  }
}

// 持久化状态只有这三项，且都必须在并发实例间收敛：lastDailyActiveDate 是全局去重依据，
// deviceMid 是设备身份，dailyActiveInFlight 是跨进程占位。
// 新增字段时要同时考虑旧文件兼容（缺失即 undefined）与「锁内读改写」约束。
interface TelemetryState {
  lastDailyActiveDate?: string;
  deviceMid?: string;
  dailyActiveInFlight?: {
    date: string;
    startedAt: number;
  };
}

// 锁文件内容约定：pid 用于判活，createdAt 仅供人工排查（过期判定以 mtime 为准）。
interface TelemetryLockOwner {
  pid: number;
  createdAt: number;
}

// [并发] 进程内 deviceMid 单飞表，key 是 state 文件的绝对路径而不是固定常量：
// 同一进程可能承载多个 homeDir 的 core（测试、远端 server），按文件隔离才不会串号。
// 存 Promise 而不是值，后到调用方直接等同一个在途锁，避免 burst 场景重复抢锁。
const deviceMidCacheByStateFile = new Map<string, Promise<string>>();

// [权衡] 只归并为 macos/windows/linux 三档而不上报原始 platform：
// 看板按这三档聚合，新增取值会让历史曲线断点；未知平台一律落 linux 是既定口径。
function normalizeOsCategory(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}

// 自然日以客户端时区为准而不是 UTC：daily_active 的业务含义是用户本地的一天。
// en-CA 的 yyyy-mm-dd 形式保证字符串序与日期序一致，无需再做一次 Date 解析。
// [失败路径] 依赖运行时 IANA 时区库，非法时区名会抛 RangeError 并上抛，
// 不静默改用 UTC：那会让同一用户在不同机器上算出不同的「同一天」，导致重复上报。
function toLocalDateKey(timestamp: number, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date(timestamp));
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

// [权衡] 显式 homeDir 时沿用旧布局 ~/.zcode/v2/telemetry-state.json，否则走平台配置目录：
// 两条路径必须与存量安装对齐，换路径等于让老用户的按日去重状态归零。
function resolveTelemetryStateFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.json");
  }
  return join(getAppConfigDir(), "telemetry-state.json");
}

function resolveTelemetryLockFile(homeDir?: string): string {
  if (homeDir) {
    return join(homeDir, ".zcode", "v2", "telemetry-state.lock");
  }
  return join(getAppConfigDir(), "telemetry-state.lock");
}

// 占位只在 TTL 内有效：持它的进程可能在发送请求时被强杀，标记会残留到磁盘；
// `isFreshDailyActiveInFlight` 过期即视为僵尸，让下一次启动重新尝试，而不是永久跳过当天。
// `date` 与当前日期不匹配同样视为无效：跨天后的旧占位不得拦住新一天的上报。
function isFreshDailyActiveInFlight(
  value: TelemetryState["dailyActiveInFlight"],
  date: string,
  timestamp: number,
): boolean {
  if (!value || value.date !== date) {
    return false;
  }

  return timestamp - value.startedAt < DAILY_ACTIVE_IN_FLIGHT_TTL_MS;
}

// [失败路径] 状态文件损坏或缺失一律返回空状态，不抛错：telemetry 是旁路能力，
// 读不到状态最多丢一次去重信息，绝不能因为一个坏 JSON 让应用启动失败。
// 直接把解析结果当状态返回，使新增字段在旧文件上自然取到 undefined。
async function readTelemetryState(homeDir?: string): Promise<TelemetryState> {
  try {
    const raw = await readFile(resolveTelemetryStateFile(homeDir), "utf-8");
    const parsed = JSON.parse(raw) as TelemetryState;
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

// [资源] 写前递归建目录：首次运行或用户清理过 .zcode 时目标目录不存在。
// [权衡] 直接 writeFile 而非 tmp 加 rename：所有调用方都持有 telemetry-state.lock，
// 序列化后的写入窗口极短，原子性由锁保证而不是靠替换文件。
async function writeTelemetryState(state: TelemetryState, homeDir?: string): Promise<void> {
  const telemetryStateFile = resolveTelemetryStateFile(homeDir);
  await mkdir(dirname(telemetryStateFile), { recursive: true });
  await writeFile(telemetryStateFile, JSON.stringify(state, null, 2), "utf-8");
}

// 可注入的 sleep 让测试无需真实等待；生产实现只服务锁重试与上报退避。
async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// [并发] 孤儿锁判定：mtime 超过 LOCK_STALE_MS 且（读不到 owner 或 owner 进程已死）才回收。
// 只看 mtime 会误杀长临界区，只看 pid 会在 pid 被系统复用时误判存活，两个条件同时成立才动手。
// 删除失败（被别的进程先删）不算错误，交给上层重试循环重新抢锁。
async function removeStaleTelemetryLockIfNeeded(
  lockFile: string,
  timestamp: number,
): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (timestamp - metadata.mtimeMs < LOCK_STALE_MS) {
      const owner = await readTelemetryLockOwner(lockFile);
      if (!owner || isProcessAlive(owner.pid)) {
        return false;
      }
    }

    await unlink(lockFile).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function readTelemetryLockOwner(lockFile: string): Promise<TelemetryLockOwner | null> {
  try {
    const raw = await readFile(lockFile, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TelemetryLockOwner>;
    if (
      typeof parsed.pid === "number" &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.createdAt === "number" &&
      Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    return null;
  }

  return null;
}

// [失败路径] 用 kill(pid, 0) 探测存在性：ESRCH 表示进程确实不存在；
// EPERM 等其它错误表示进程存在但无权限发信号，必须按「存活」处理，否则会删掉活锁。
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code !== "ESRCH"
    );
  }
}

// [并发] 跨进程互斥靠 O_EXCL 创建锁文件（open 的 wx 模式），这是各平台都支持的唯一原子原语。
// 临界区内只做状态读写，禁止发起网络请求：[权衡] 一旦把 fetch 放进锁内，
// 同机首个慢请求会把后续所有上报堵在锁外，最终稳定报锁超时。
// 释放顺序固定为 close 再 unlink：先 unlink 再 close 会让另一进程在文件仍打开时创建同名锁。
async function withTelemetryStateLock<T>(
  homeDir: string | undefined,
  run: (state: TelemetryState) => Promise<T>,
): Promise<T> {
  const lockFile = resolveTelemetryLockFile(homeDir);
  await mkdir(dirname(lockFile), { recursive: true });

  for (let attempt = 0; attempt < LOCK_RETRY_COUNT; attempt += 1) {
    try {
// [事务] 抢到锁后立刻写入 owner 元数据（pid 与 createdAt）：
// 崩溃若发生在这行之后，后续进程能据 pid 判定是否孤儿；发生在这行之前锁文件为空，
// 只能靠 mtime 超时回收——这正是下面旧锁兼容分支存在的原因。
      const handle = await open(lockFile, "wx");
      try {
        // Bugfix: 旧锁文件只有一个空文件，崩溃后 5 分钟内无法判断是否为孤儿锁。
        // 新锁写入 owner pid，让后续进程能安全回收“刚残留但持有进程已退出”的锁。
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: Date.now(),
          }),
          "utf-8",
        );
// [事务] 状态必须在锁内读取，否则会出现「读到旧值 → 写回时覆盖别人刚提交的去重标记」。
        const state = await readTelemetryState(homeDir);
        return await run(state);
      } finally {
// [资源] 先关句柄再删锁文件，顺序不可交换；unlink 失败被吞掉是因为
// 孤儿回收路径可能已经删过，该失败不影响本次状态写入结果。
        await handle.close();
        await unlink(lockFile).catch(() => {});
      }
    } catch (error) {
      const isLockConflict =
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "EEXIST";
      if (!isLockConflict) {
        throw error;
      }

      // Bugfix: 崩溃/强退后 telemetry-state.lock 可能遗留在磁盘上，后续所有启动都会直接卡死到超时。
      // 这里按 mtime 识别明显过期的孤儿锁并自动回收，避免用户目录里一个陈旧空文件把上报永久锁死。
      const removedStaleLock = await removeStaleTelemetryLockIfNeeded(lockFile, Date.now());
      if (removedStaleLock) {
        continue;
      }

      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }

// [失败路径] 耗尽重试后抛错，由上报入口当成一次失败并丢弃事件；
// 绝不降级为「无锁写状态」——那会直接破坏 INV-03 的按日去重。
  throw new Error("Telemetry state lock timeout");
}

// 对外只暴露 homeDir 与 randomUUID，调用方无需感知锁实现与状态文件布局。
export interface EnsureTelemetryDeviceMidOptions {
  homeDir?: string;
  randomUUID?: () => string;
}

// 记住已确定的 deviceMid，使后续调用直接命中缓存、不再进文件锁（见 INV-05）。
function rememberDeviceMid(telemetryStateFile: string, deviceMid: string): string {
  deviceMidCacheByStateFile.set(telemetryStateFile, Promise.resolve(deviceMid));
  return deviceMid;
}

/** 调用方必须已持有 telemetry-state.lock；只在 state 缺失 deviceMid 时生成并写回。 */
// [事务] 前置契约：调用方已持有 telemetry-state.lock，本函数内不得再次取锁（会自锁到超时）。
// 仅在 state 缺字段时生成并写回，因此同一文件在并发下最多产生一个 deviceMid。
async function ensureDeviceMidInLockedState(
  state: TelemetryState,
  options: EnsureTelemetryDeviceMidOptions,
): Promise<string> {
  const telemetryStateFile = resolveTelemetryStateFile(options.homeDir);
// 已有值直接复用：device_mid 表达设备身份，绝不能因为换登录账号而重新生成。
  if (state.deviceMid) {
    return rememberDeviceMid(telemetryStateFile, state.deviceMid);
  }

  // device_mid 独立生成，不再复用首条事件的 eventId：让它表达「设备标识」而非
  // 「某次上报」，并与 ARMS 侧（desktopDeviceMid）读取的同一字段保持同值。
  const deviceMid = (options.randomUUID ?? createUuid)();
  state.deviceMid = deviceMid;
  await writeTelemetryState(state, options.homeDir);
  return rememberDeviceMid(telemetryStateFile, deviceMid);
}

/**
 * 确保 telemetry-state.json 里存在 deviceMid 并返回它。
 *
 * Bug 根因：远端 zcode-server 所在主机没有 Desktop main 进程，过去没有任何进程会在那里写
 * telemetry-state.json；buildZCodeSourceHeaders() 又只读不生成，于是远端发往 ZCode endpoint 的
 * 请求永远缺 X-Device-Mid，billing/balance 被服务端拒绝为 parameter error，Start Plan 在远程
 * 工作区被判成未开通。这里把 telemetry 上报内部的 ensure 逻辑抽成独立入口，供远端 server 启动时
 * 调用：同一个文件、同一个字段、同一把 telemetry-state.lock，与同机 CLI 得到同一个设备身份。
 */
export function ensureTelemetryDeviceMid(
  options: EnsureTelemetryDeviceMidOptions = {},
): Promise<string> {
  const telemetryStateFile = resolveTelemetryStateFile(options.homeDir);
// [并发] 命中缓存即返回同一个 Promise，所有并发调用共享一次加锁与一次生成。
  const cached = deviceMidCacheByStateFile.get(telemetryStateFile);
  if (cached) {
    return cached;
  }

  // Bugfix: message_completion / agent_step 等高频埋点之前每条都抢 telemetry-state.lock，
  // 即使 deviceMid 已经落盘也会在 burst 场景里把 2 秒锁等待打满。这里按 state 文件缓存
  // deviceMid 的读取 promise，只在首次缺失或首次读取时进入文件锁。
// [失败路径] 失败时必须清除缓存，且只有「当前条目仍是自己」时才删：
// 否则会误删后来者已建立的新在途 Promise，导致下一轮重复加锁。
  const pending = withTelemetryStateLock(options.homeDir, async (state) =>
    ensureDeviceMidInLockedState(state, options),
  ).catch((error) => {
    if (deviceMidCacheByStateFile.get(telemetryStateFile) === pending) {
      deviceMidCacheByStateFile.delete(telemetryStateFile);
    }
    throw error;
  });
  deviceMidCacheByStateFile.set(telemetryStateFile, pending);
  return pending;
}

// 依赖全部可注入（fetch、时钟、uuid、homeDir），这是让上报路径可在测试中确定性复现的前提；
// 生产默认值必须与桌面端实际环境一致，注入点只服务测试与远端 server 变体。
export function createTelemetryCore(dependencies: TelemetryCoreDependencies = {}) {
// 默认值在此一次性固化，函数体内不再回落到全局对象，保证注入后行为完全确定。
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const loadUserId = dependencies.loadUserId ?? (async () => "");
  const loadMarketingParams = dependencies.loadMarketingParams ?? (async () => null);
// 日志走统一 service logger：生产只落 warn 及以上，重试细节用 debug 且不含 payload。
  const telemetryLogger = createServiceLogger("telemetry-core");
  const warn = dependencies.warn ?? ((message: string) => telemetryLogger.warn(undefined, message));
  let didWarnMarketingParamsLoadFailure = false;
  const randomUUID = dependencies.randomUUID ?? (() => createUuid());
  const now = dependencies.now ?? Date.now;
  const appVersion = dependencies.appVersion ?? ZCODE_VERSION;
  const platform = dependencies.platform ?? process.platform;
  const osVersion = dependencies.osVersion ?? version();
  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REPORT_REQUEST_TIMEOUT_MS;
  const retrySleep = dependencies.sleep ?? sleep;
// [并发] 在途集合由 JS 单线程串行访问，无需额外加锁；它是退出屏障的唯一数据来源。
  const pendingReports = new Set<Promise<void>>();
  const deviceMidOptions: EnsureTelemetryDeviceMidOptions = {
    homeDir: dependencies.homeDir,
    randomUUID,
  };

// [失败路径] 只有 408/429/5xx 判为可重试，它们表示「服务端暂时处理不了」；
// 4xx 是请求本身有问题（鉴权、参数、脱敏），重试只会放大错误并浪费配额。
// 归类结果同时决定退避时长与日志里的 category，改分类等于改线上重试行为。
  function classifyHttpFailure(status: number): TelemetryReportError {
    if (status === 408) {
      return new TelemetryReportError("http_408", true, status);
    }
    if (status === 429) {
      return new TelemetryReportError("http_429", true, status);
    }
    if (status >= 500 && status <= 599) {
      return new TelemetryReportError("http_5xx", true, status);
    }
    if (status >= 400 && status <= 499) {
      return new TelemetryReportError("http_4xx", false, status);
    }
    return new TelemetryReportError("http_other", false, status);
  }

// 单次投递只负责一次 POST，不做重试与日志，便于把「传输」与「重试策略」分开测试。
// [权衡] 鉴权读取失败时降级匿名而不是中止：丢 Authorization 只影响归因，不影响事件入库。
  async function sendReportAttempt(
    endpoint: string,
    body: string,
    headers: Record<string, string>,
    userId: string,
  ): Promise<void> {
// [失败路径] 凭据读取整体包在 try 里：凭据后端可能抛错（文件损坏、keychain 不可用），
// 这条链路任何异常都必须降级为匿名上报，不能让埋点打断业务调用方。
// 变量先置 null 再尝试赋值，保证异常分支下请求头里不会残留半成品凭据。
    let authorization: string | null = null;
    try {
      authorization = (await dependencies.loadAuthorization?.(userId)) ?? null;
    } catch {
      // 凭据不可读时匿名上报，不打印原始异常，也不阻断业务事件。
    }
// [资源] 超时用 AbortController 加 setTimeout 实现，finally 中必须 clearTimeout，
// 否则每次上报都会留下一个定时器，长期运行会持续累积。
    const abortController = new AbortController();
// 计时从请求发出前开始，覆盖建连与响应体读取；超时后 abort 让 fetch 立即失败。
    const timeout = setTimeout(() => abortController.abort(), requestTimeoutMs);
    let response: Response;
    try {
// [并发] 注入的 fetchImpl 必须支持 signal；超时后迟到的响应被丢弃，不会回写任何状态。
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
          ...(authorization ? { Authorization: authorization } : {}),
        },
        // 不把带身份的上报转发至服务端重定向目标。
// [权衡] redirect 设为 error 会让 3xx 直接失败，换取 Authorization 与 X-Device-Mid
// 绝不会被转发到第三方主机；代价是端点迁移必须同步改配置，不能靠重定向兜底。
        redirect: "error",
        body,
        signal: abortController.signal,
      });
    } catch {
// [失败路径] 用 signal.aborted 区分超时与网络错误：两者都可重试，但 category 不同，
// 这是排查「本地网络差」还是「服务端慢」的唯一线索。
      throw new TelemetryReportError(abortController.signal.aborted ? "timeout" : "network", true);
    } finally {
      clearTimeout(timeout);
    }

// [失败路径] 非 2xx 一律抛出（redirect 设为 error 也已覆盖 3xx），
// 调用方只接受「成功即入库」，不处理部分成功语义。
    if (!response.ok) {
      throw classifyHttpFailure(response.status);
    }
  }

// 组装并投递一条事件：脱敏、鉴权、端点重写、有界重试全部收口在这里，
// 保证 reportEvent、app_launch、daily_active 三个入口走完全相同的出网策略。
// 任何入口若自行拼请求体，都会绕过 INV-01 的脱敏与身份头一致性。
  async function sendReport(
    payload: TelemetryEventPayload,
    context: TelemetryRendererContext,
    eventId: string,
    userId: string,
    deviceMid: string,
  ): Promise<void> {
    // 构建期未配置事件上报端点时不上报（见 docs/desktop/build-time-optional-capabilities.md）
// [失败路径] 构建期未注入端点时这里是空实现：整条链路静默 no-op，
// 不写状态文件也不生成 deviceMid，避免私有构建因缺少上报能力产生副作用与告警。
    if (!REPORT_ENDPOINT) return;
    let marketingParams: OAuthLoginAttribution | null = null;
    try {
      marketingParams = await loadMarketingParams();
    } catch {
      // 修复原因：营销归因只是 telemetry 的附加上下文，凭据损坏或暂时不可读
      // 不应阻断原事件；同一 core 只告警一次，避免高频埋点持续刷屏。
      if (!didWarnMarketingParamsLoadFailure) {
        didWarnMarketingParamsLoadFailure = true;
        // 凭据后端异常可能带本机路径或堆栈；生产日志只保留固定、脱敏的降级事件。
        warn("Telemetry marketing attribution load failed; continuing without attribution");
      }
    }
// [权衡] 手工拼装请求体而不是直接序列化 payload：出网字段与后端契约一一对应，
// 新增字段必须显式列出，防止内部上下文字段被整体透传泄露。
    const requestBody = JSON.stringify({
      event_id: eventId,
      client_timezone: context.clientTimezone,
      client_language: context.clientLanguage,
      element_name: payload.elementName,
      event_region: payload.eventRegion,
      event_type: payload.eventType,
      event_text: payload.eventText ?? "",
      // 修复原因：Host/Main 或旧 Renderer 可绕过 UI 清洗，最终出网统一禁止错误原文与登录 URL 秘密。
      event_extra_detail: sanitizeTelemetryEventDetail(
        payload.elementName,
        payload.eventExtraDetail,
      ),
      user_id: userId,
      screen_resolution: context.screenResolution,
      app_version: appVersion,
      device_os_category: normalizeOsCategory(platform),
      device_os_version: osVersion,
      device_mid: deviceMid,
      mac_id: "",
      marketing_params: JSON.stringify(marketingParams ?? {}),
// 可选字段用条件展开而不是写 null：后端会区分「缺字段」与「显式清空」。
      ...(payload.talkId ? { talk_id: payload.talkId } : {}),
      ...(payload.messageId ? { message_id: payload.messageId } : {}),
    });

// [失败路径] 端点重写缺 origin 时回落到常量端点，保证子系统缺失不会中断上报。
    const endpoint = String(
      rewriteZCodeEndpointUrl(
        REPORT_ENDPOINT,
        (await dependencies.resolveZCodeEndpointOrigin?.()) ?? REPORT_ENDPOINT,
      ),
    );

// [并发] 身份头由 shared 统一构造，deviceMid 与 endpointOrigin 必须与本次实际请求的端点一致，
// 否则服务端按 origin 校验失败，会把事件判为跨域伪造。
    const headers = buildZCodeSourceHeadersFromContext({
      appVersion,
      platform,
      arch: dependencies.arch ?? process.arch,
      osVersion,
      releaseChannel: dependencies.releaseChannel ?? ZCODE_ENV,
      clientLanguage: context.clientLanguage,
      clientTimezone: context.clientTimezone,
      deviceMid,
      endpointOrigin: new URL(endpoint).origin,
    });
// [并发] startedAt 与 attempts 只在本函数栈内，不共享：并发上报互不影响计数与耗时统计。
    const startedAt = Date.now();
// lastError 保存最后一次可判定类别的失败，供重试耗尽后的告警与上抛复用。
    let lastError: TelemetryReportError | null = null;
    let attempts = 0;
// [失败路径] 重试上限是常量而非自适应：可预测的耗时有价值，
// 因为调用方可能在退出屏障里等待这条 promise。
    for (let attempt = 1; attempt <= REPORT_MAX_ATTEMPTS; attempt += 1) {
      attempts = attempt;
      try {
        await sendReportAttempt(endpoint, requestBody, headers, userId);
        return;
      } catch (error) {
        lastError =
          error instanceof TelemetryReportError ? error : new TelemetryReportError("network", true);
// [失败路径] 不可重试或次数耗尽共用同一出口，保证每条事件最多一次告警、一次上抛，
// 不会出现「已放弃却继续循环」造成的重复上报。
        if (!lastError.retryable || attempt === REPORT_MAX_ATTEMPTS) {
          break;
        }

        // 修复原因：公共 /event/report 过去遇到瞬时网络故障会直接丢事件。这里只记录脱敏的
        // attempt 元数据并有界重试，禁止把 payload、响应体或原始错误写入生产日志。
        telemetryLogger.debug(
          undefined,
          `retry event=${payload.elementName} eventId=${eventId} attempt=${attempt} category=${lastError.category}`,
        );
        await retrySleep(
          lastError.category === "http_429"
            ? REPORT_RATE_LIMIT_RETRY_DELAY_MS
            : REPORT_RETRY_DELAY_MS,
        );
      }
    }

// [失败路径] 走到这里时 lastError 理论上有值，兜底构造只为让类型收窄成立，
// 不再额外增加分支。
    const finalError = lastError ?? new TelemetryReportError("network", true);
    warn(
      `Telemetry report failed; event=${payload.elementName} eventId=${eventId} attempts=${attempts} category=${finalError.category} elapsedMs=${Date.now() - startedAt}`,
    );
    throw finalError;
  }

// [并发] 登记在途上报供退出时等待；finally 删除自身，成功与失败都留不下悬挂条目。
  function trackReport(report: Promise<void>): Promise<void> {
    const tracked = report.finally(() => pendingReports.delete(tracked));
    pendingReports.add(tracked);
    return tracked;
  }

// [资源] 退出屏障：等待在途上报结束，但受总 deadline 约束——
// 进程退出不能被一个慢请求无限拖延，超时后只告警放行（见 INV-06）。
  async function flushPendingReports({ timeoutMs }: { timeoutMs: number }): Promise<void> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve();
      }, timeoutMs);
    });

    try {
      // 修复原因：退出 drain 如果只拍一次 Set 快照，会漏掉屏障等待期间刚进入 Main 的 IPC
      // 上报。每批 settled 后重新读取集合，直到为空或命中同一个总 deadline。
// [并发] 每轮重新读取集合并重新等待，而不是只拍一次快照：
// 等待期间新进入的 IPC 上报也必须被同一个屏障覆盖，否则退出时会静默丢事件。
      while (!timedOut && pendingReports.size > 0) {
        await Promise.race([Promise.allSettled(pendingReports), deadline]);
      }
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }

// [失败路径] 超时仍有残留说明上报被卡住；告警只报数量不报事件名，避免高频日志膨胀。
    if (pendingReports.size > 0) {
      warn(`Telemetry flush timed out; pending=${pendingReports.size}`);
    }
  }

  return {
// 通用业务埋点入口：只有未显式传入 userId 时才回落本地登录态，避免每条事件都读一次凭据。
    reportEvent(input: {
      context: TelemetryRendererContext;
      elementName: string;
      eventRegion: string;
      eventType: string;
      eventText?: string;
      eventExtraDetail: Record<string, string>;
      userId?: string;
      talkId?: string;
      messageId?: string;
    }): Promise<void> {
      return trackReport(
        (async () => {
          const userId = input.userId ?? (await loadUserId());
          // 重复回调/跨宿主重报同一 Session 必须保留事件身份；不能每次生成随机 ID。
          // UUIDv8 表达应用自定义的 SHA-256 映射，来源与设备变化不产生新的创建事件。
          const eventId =
// [权衡] 仅 session_create 且带 talkId 时使用确定性 eventId；其它事件保持随机 UUID，
// 因为它们的语义是「又发生了一次」，去重应由服务端按业务键完成。
            input.elementName === "session_create" && input.talkId
              ? sessionCreateEventId(userId, input.talkId)
              : randomUUID();
          const deviceMid = await ensureTelemetryDeviceMid(deviceMidOptions);

          await sendReport(
            {
              elementName: input.elementName,
              eventRegion: input.eventRegion,
              eventType: input.eventType,
              eventText: input.eventText,
              eventExtraDetail: input.eventExtraDetail,
              userId,
              talkId: input.talkId,
              messageId: input.messageId,
            },
            input.context,
            eventId,
            userId,
            deviceMid,
          );
        })(),
      );
    },

// app_launch 不做按日去重：每次启动都是真实冷启动，采样交由服务端处理。
    reportAppLaunch(context: TelemetryRendererContext): Promise<void> {
      return trackReport(
        (async () => {
          const eventId = randomUUID();
          const userId = await loadUserId();
          const deviceMid = await ensureTelemetryDeviceMid(deviceMidOptions);

          await sendReport(
            {
              elementName: "app_launch",
              eventRegion: "app",
              eventType: "view",
              eventExtraDetail: {},
              userId,
            },
            context,
            eventId,
            userId,
            deviceMid,
          );
        })(),
      );
    },

// [事务] `reportAppDailyActive` 三阶段提交：短锁判定并占位 → 锁外发送 → 短锁提交完成态。
// 崩溃落在阶段之间时，in-flight 标记会在 TTL 后过期，当天自动重试，不会永久漏报。
    reportAppDailyActive(context: TelemetryRendererContext): Promise<void> {
      return trackReport(
        (async () => {
          const timestamp = now();
          const today = toLocalDateKey(timestamp, context.clientTimezone);
          const userId = await loadUserId();
          const pendingReport = await withTelemetryStateLock(
            dependencies.homeDir,
            async (state) => {
// 已提交过当天即短路：桌面 Main、远端 server、CLI 共享同一状态文件，这是全局去重点。
              if (state.lastDailyActiveDate === today) {
                return null;
              }

// 另一个进程正在发送同一天的事件，让它独占，避免并发双发。
              if (isFreshDailyActiveInFlight(state.dailyActiveInFlight, today, timestamp)) {
                return null;
              }

              const eventId = randomUUID();
              const deviceMid = await ensureDeviceMidInLockedState(state, deviceMidOptions);
              // Bugfix: 之前 reportAppDailyActive 会在持锁状态下直接执行网络请求。
              // 启动期 app_launch / app_daily_active / reportEvent 一旦并发，后来的调用会一直卡在锁外，
              // 最终稳定打出 "Telemetry state lock timeout"。这里改成短锁写入 in-flight 标记，
              // 锁外发送网络请求，成功后再短锁提交完成态，既保留跨实例去重，也不再把整个 telemetry 通道锁死。
              state.dailyActiveInFlight = {
                date: today,
                startedAt: timestamp,
              };
              await writeTelemetryState(state, dependencies.homeDir);
              return { eventId, deviceMid };
            },
          );

// 判定阶段返回空表示「今天已上报或他人正在上报」，按成功返回，不抛错。
          if (!pendingReport) {
            return;
          }

          try {
            await sendReport(
              {
                elementName: "app_daily_active",
                eventRegion: "app",
                eventType: "view",
                eventExtraDetail: {},
                userId,
              },
              context,
              pendingReport.eventId,
              userId,
              pendingReport.deviceMid,
            );
          } catch (error) {
            await withTelemetryStateLock(dependencies.homeDir, async (state) => {
              if (state.dailyActiveInFlight?.date === today) {
                delete state.dailyActiveInFlight;
                await writeTelemetryState(state, dependencies.homeDir);
              }
            });
            throw error;
          }

          await withTelemetryStateLock(dependencies.homeDir, async (state) => {
// [事务] 先写完成态再清 in-flight，顺序固定：反过来会出现「标记已清但完成态未写」的窗口，
// 崩溃在该窗口内会让下一次启动把当天再报一遍。
            state.lastDailyActiveDate = today;
            if (state.dailyActiveInFlight?.date === today) {
              delete state.dailyActiveInFlight;
            }
            await writeTelemetryState(state, dependencies.homeDir);
          });
        })(),
      );
    },

    flushPendingReports,
  };
}
