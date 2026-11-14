// INV-01 协议版本是控制帧兼容的唯一判据；守住它的位置：SERVER_CLI_PROTOCOL_VERSION 常量与 serverStatusSchema.protocolVersion 的 literal 校验；改错故障：新旧端互相解析成功却语义不同，握手不再报错。
// INV-02 生命周期状态集必须覆盖 Supervisor 所有落盘取值；守住它的位置：lifecycleStateSchema 的十个枚举值；改错故障：写入未声明状态被拒绝，状态落盘失败导致停止链路卡在锁上。
// INV-03 状态快照禁止未知字段；守住它的位置：serverStatusSchema 末尾的 strict 调用；改错故障：字段名拼错时读到 undefined 而不报错，下游把缺失当缺省。
// INV-04 pid 与 port 用 null 表达无进程、未监听，不用 0 或空串冒充；守住它的位置：三处 nullable 声明；改错故障：停止态被渲染成可连接地址，控制端向不存在的端口重试。
// INV-05 generation 单调递增，用来区分同一端口上的新旧进程；守住它的位置：serverStatusSchema.generation 与 createStoppedServerStatus 的初值；改错故障：重启后沿用旧 generation，迟到心跳被当成当前进程状态。
// INV-06 crashBudget 的窗口起点可选，缺省表示尚未发生崩溃；守住它的位置：windowStartedAt 的 optional 修饰；改错故障：把缺省当 0 处理，窗口立刻过期，退避序列被重置。
// INV-07 退避节奏只能来自 CRASH_BACKOFF_MS；守住它的位置：该常量数组与 createStoppedServerStatus 里的首项取值；改错故障：各调用方写死延迟，预算判断与实际重启间隔分裂。
// INV-08 停止等待总时长必须由宽限、强杀、关闭三段推导；守住它的位置：SERVER_STOP_WAIT_TIMEOUT_MS 的加法表达式；改错故障：调大单段后等待方仍按旧总时长超时，把正常退出误报为 stop-failed。
// INV-09 请求 id 是请求与响应的唯一关联键；守住它的位置：requestBase 的 trim、非空与 128 字符上限；改错故障：空 id 或超长 id 让响应无法配对，调用方永久等待。
// INV-10 控制命令以 command 为判别字段，十个分支的字面量不得重复；守住它的位置：controlRequestSchema 的判别联合；改错故障：新增命令漏加分支，帧在解析期被拒，CLI 只能报未知命令。
// INV-11 force 只属于 apply-update，confirmation 只属于 confirm-uninstall；守住它的位置：这两个 extend 分支；改错故障：把 force 提到公共基座，任何命令都能跳过运行中任务检查。
// INV-12 响应成败只看 ok，不看 error 是否存在；守住它的位置：ok 必填与 result、error 的 optional；改错故障：成功响应带空 error 时被判失败，或失败响应被当成功读取 result。
// INV-13 core 上行消息以 type 判别，六种类型缺一不可；守住它的位置：coreMessageSchema 的六个分支；改错故障：漏掉 shutdown-ack 后停止流程只能靠超时收场，日志里出现伪超时。
// INV-14 heartbeat 与 task-activity 的 runningTasks 可选，缺省表示本次不上报明细；守住它的位置：两处 runningTasks 的 optional 与必填的 runningTaskCount；改错故障：把缺省当空数组，任务视图被错误清空。
// INV-15 任务明细结构由 shared 包裁定，此处只做安全校验；守住它的位置：runningTasksSchema 对 shared schema 的 safeParse 判定；改错故障：两处结构漂移，shared 新增字段后整批明细被丢弃。
// INV-16 发布版本号参与目录拼接，必须拒绝路径分隔与上级引用；守住它的位置：releaseManifestSchema.version 的正则；改错故障：版本号带上级引用时安装目录逃出 data root，覆盖任意文件。
// INV-17 发布清单与目录条目的大小字段为非负整数，摘要固定 64 位十六进制；守住它的位置：两处 sha256 正则与 sizeBytes 约束；改错故障：放宽后损坏归档被接受，直到解压阶段才失败。
// INV-18 目录版本号固定为 1，新增字段必须保持可选；守住它的位置：releaseCatalogSchema.schemaVersion 的 literal 1；改错故障：不兼容升版时旧 CLI 仍解析成功，读到缺失字段后按空值行事。
//
// 模块职责：定义 zcode-server-cli 与 Supervisor、core、发布流程之间的控制面契约，只声明形状与常量，不承载 IO 与状态。
// 状态所有权：运行事实（pid、port、generation、crashBudget）由 Supervisor 写入并落盘，CLI 只读快照；本文件不产生第二份状态。
// 阅读顺序：先看版本与超时常量，再看 lifecycleStateSchema 与 serverStatusSchema，然后控制请求与响应，最后 core 消息与发布清单。
import { sourceServerRunningTasksSchema, type SourceServerRunningTask } from "@zcode/shared";
import { z } from "zod";

// [契约] 版本号随控制帧字段的语义变化而升，不随新增可选字段而升。
// [兼容] 两端各自用 literal 校验对端版本，任何时候都不做范围比较。
// [失败路径] 版本不匹配必须在握手阶段失败，不能降级解析后继续。
// [权衡] 升级顺序固定为先放宽接收端，再切换发送端，避免升级窗口内互相拒绝。
export const SERVER_CLI_PROTOCOL_VERSION = 1;
export const SERVER_RUNTIME_NODE_VERSION = "22.16.0";
export const CRASH_WINDOW_MS = 5 * 60_000;
// [资源] 五档退避覆盖 1 秒到 16 秒，总和决定崩溃循环被判为耗尽前的最长恢复时间。
// [契约] nextRestartDelayMs 必须取自本数组，不能由调用方另算一份指数退避。
// [事务] 崩溃窗口 CRASH_WINDOW_MS 与退避序列共同构成 crashBudget，二者改动要一起评估。
// [失败路径] 序列取尽后必须把 exhausted 置真并停在上限，不能回到首档。
// [权衡] 用 as const 固定字面量，让下游可以直接索引而不必重复声明元组类型。
export const CRASH_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024;

// Supervisor 停止/更新链路的时间预算唯一来源；等待 Supervisor 的调用方必须由这里推导，不能各自写死。
// [契约] 宽限时间是先礼后兵的第一段：先发停止请求，超过它才进入强杀。
// [事务] 这段预算由停止链路独占，其他链路要等待 Supervisor 必须引用它而不是另设常量。
// [失败路径] 宽限设得过短会把正常收尾误判为卡死，触发不必要的 SIGKILL 与状态落盘。
// [权衡] 5 秒按远端磁盘与 swap 的收尾时间定，调小要比调大更谨慎。
// [资源] 它与强杀、control 关闭两段共同决定停止总时长，单独调整会破坏下游等待。
export const CORE_STOP_GRACE_TIMEOUT_MS = 5_000;
// Bug 原因：SIGKILL 只会被不可中断等待推迟，Rosetta + swap 的远端按事故时序推算回收约 3.5～5.4 秒；旧的
// 2 秒等待把必然结束的退出误判为 stop-failed，导致 update 失败并让 Supervisor 卡住锁。
export const CORE_KILL_TIMEOUT_MS = 10_000;
export const CORE_READY_TIMEOUT_MS = 15_000;
export const CONTROL_CLOSE_TIMEOUT_MS = 2_000;
// stop 等待方需要覆盖宽限 + 强杀等待 + control socket 关闭，另留状态落盘和锁释放余量。
export const SERVER_STOP_WAIT_TIMEOUT_MS =
  CORE_STOP_GRACE_TIMEOUT_MS + CORE_KILL_TIMEOUT_MS + CONTROL_CLOSE_TIMEOUT_MS + 3_000;

// [契约] 十个状态是 Supervisor 落盘的完整取值域，任何新增都要先改这里再改写入方。
// [状态] updating 与 uninstalling 是互斥的过渡态，进入前必须先离开 ready。
// [失败路径] 枚举收窄会让旧状态文件解析失败，表现为启动即崩溃而不是降级。
// [事务] stop-failed 是显式失败态，不能靠超时从 stopping 直接跳到 stopped。
// [权衡] crash-loop-stopped 与 crashed 分开，前者表示预算耗尽后不再自动重启。
// [边界] uninstalled 是终态，进入它之后不应再出现 ready 或 starting。
export const lifecycleStateSchema = z.enum([
  "starting",
  "ready",
  "stopping",
  "stop-failed",
  "stopped",
  "crashed",
  "crash-loop-stopped",
  "updating",
  "uninstalling",
  "uninstalled",
]);

export const crashBudgetSchema = z.object({
  windowStartedAt: z.number().int().nonnegative().optional(),
  crashCount: z.number().int().nonnegative(),
  nextRestartDelayMs: z.number().int().nonnegative(),
  exhausted: z.boolean(),
});

// [契约] 这是 CLI 读取运行状态的唯一快照形状，所有字段都必须能由 Supervisor 落盘后原样解析。
// [状态] state 与 pid 必须自洽：非停止态通常有 pid，停止态必须为 null。
// [契约] protocolVersion 带默认值，保证旧状态文件缺少该字段时仍能读出。
// [失败路径] startedAt 与 lastExitReason 的默认 null 表示未知，而不是未发生。
// [边界] strict 让未知字段直接失败，跨版本新增字段前必须确认所有读取方已升级。
export const serverStatusSchema = z
  .object({
    protocolVersion: z.literal(SERVER_CLI_PROTOCOL_VERSION).default(SERVER_CLI_PROTOCOL_VERSION),
    state: lifecycleStateSchema,
    pid: z.number().int().positive().nullable(),
    port: z.number().int().nonnegative().nullable(),
    host: z.string().min(1).nullable(),
    version: z.string().min(1),
    generation: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().nullable().default(null),
    lastExitReason: z.string().max(500).nullable().default(null),
    serviceRegistered: z.boolean(),
    runningTaskCount: z.number().int().nonnegative(),
    crashBudget: crashBudgetSchema,
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type LifecycleState = z.infer<typeof lifecycleStateSchema>;
export type CrashBudgetSnapshot = z.infer<typeof crashBudgetSchema>;
export type ServerStatus = z.infer<typeof serverStatusSchema>;

export const runtimeIdentitySchema = z
  .object({
    supervisorVersion: z.string().min(1),
    supervisorReleaseId: z.string().min(1).optional(),
    activeReleaseVersion: z.string().min(1).optional(),
    activeReleaseId: z.string().min(1).optional(),
    coreVersion: z.string().min(1).optional(),
    coreReleaseId: z.string().min(1).optional(),
  })
  .strict();
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;

export const updatePreparationResultSchema = z
  .object({
    status: z.enum(["ready", "blocked"]),
    runningTaskCount: z.number().int().nonnegative(),
  })
  .strict();
export type UpdatePreparationResult = z.infer<typeof updatePreparationResultSchema>;

// [事务] `createStoppedServerStatus` 只构造停止态：不写盘，也不发送。
// [契约] generation 固定为 0：这是从未启动的身份，不能沿用上一个进程的编号。
// [权衡] serviceRegistered 与 now 走可选参数，缺省为未注册与当前时刻。
// [失败路径] 返回值必须经过 schema 解析，字段漏填时立刻抛错而不是交给下游。
// [资源] crashBudget 初始为未耗尽且延迟取首档，保证首次启动不被预算拦截。
export function createStoppedServerStatus(
  version: string,
  options: { serviceRegistered?: boolean; now?: number } = {},
): ServerStatus {
  return serverStatusSchema.parse({
    protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
    state: "stopped",
    pid: null,
    port: null,
    host: null,
    version,
    generation: 0,
    startedAt: null,
    lastExitReason: null,
    serviceRegistered: options.serviceRegistered ?? false,
    runningTaskCount: 0,
    crashBudget: {
      crashCount: 0,
      nextRestartDelayMs: CRASH_BACKOFF_MS[0],
      exhausted: false,
    },
    updatedAt: options.now ?? Date.now(),
  });
}

const requestBase = z.object({ id: z.string().trim().min(1).max(128) });
// [契约] 判别字段为 command，十个分支覆盖状态查询、停止、重启、更新与卸载全流程。
// [事务] prepare-update 与 apply-update 分两步，前者只做运行中任务检查，后者才真正切换。
// [失败路径] confirm-uninstall 必须携带 confirmation 字符串，缺失即解析失败，避免误删。
// [权衡] force 只放在 apply-update，其它命令没有忽略检查的语义。
// [边界] running-tasks 是只读查询，不改变任何生命周期状态。
// [并发] 请求 id 由调用方生成并随响应回传，多条控制连接并存时靠它区分归属。
export const controlRequestSchema = z.discriminatedUnion("command", [
  requestBase.extend({ command: z.literal("ping") }),
  requestBase.extend({ command: z.literal("status") }),
  requestBase.extend({ command: z.literal("running-tasks") }),
  requestBase.extend({ command: z.literal("stop") }),
  requestBase.extend({ command: z.literal("restart") }),
  requestBase.extend({ command: z.literal("runtime-identity") }),
  requestBase.extend({ command: z.literal("prepare-update") }),
  requestBase.extend({ command: z.literal("apply-update"), force: z.boolean().optional() }),
  requestBase.extend({ command: z.literal("prepare-uninstall") }),
  requestBase.extend({ command: z.literal("confirm-uninstall"), confirmation: z.string() }),
]);
export type ControlRequest = z.infer<typeof controlRequestSchema>;

export const controlResponseSchema = z
  .object({
    id: z.string().min(1),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
        retryable: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ControlResponse = z.infer<typeof controlResponseSchema>;

const runningTasksSchema = z.custom<SourceServerRunningTask[]>(
  (value) => sourceServerRunningTasksSchema.safeParse(value).success,
);

// [契约] 这是 core 到 Supervisor 的唯一上行通道，以 type 判别六种消息。
// [状态] ready 携带监听地址与 generation，是唯一能把 core 转为可服务的消息。
// [权衡] 心跳里的任务明细可选，避免每秒重复上报整份任务列表。
// [失败路径] fatal 与 exit 都带原因字符串并限长 500，防止异常文本撑爆状态文件。
export const coreMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ready"),
    host: z.string().min(1),
    port: z.number().int().positive(),
    version: z.string().min(1),
    releaseId: z.string().min(1).optional(),
    generation: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("heartbeat"),
    runningTasks: runningTasksSchema.optional(),
    at: z.number().int().nonnegative(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal("task-activity"),
    runningTasks: runningTasksSchema.optional(),
    runningTaskCount: z.number().int().nonnegative(),
  }),
  z.object({ type: z.literal("shutdown-ack") }),
  z.object({ type: z.literal("fatal"), message: z.string().max(500) }),
  z.object({ type: z.literal("exit"), reason: z.string().max(500) }),
]);
export type CoreMessage = z.infer<typeof coreMessageSchema>;

export const coreCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("shutdown") }),
]);
export type CoreCommand = z.infer<typeof coreCommandSchema>;

// [契约] 清单描述已解压到本地的发布目录，releaseDir 是路径而不是 URL。
// [失败路径] version 与 releaseDir 的正则、非空校验是防路径穿越的第一道闸。
// [兼容] components、archiveSha256 等字段可选，允许旧清单只带最小字段。
// [事务] 组件摘要固定 64 位十六进制，校验失败的归档不得进入安装流程。
// [权衡] manifest 与 catalog 分成两份契约：前者描述本地已落盘内容，后者描述远端可下载项。
export const releaseManifestSchema = z
  .object({
    // version 会参与 releases/<version>-<target>-<sha> 路径拼接，不能允许 `/`、`\` 或 `..` 穿越 data root。
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    releaseDir: z.string().trim().min(1),
    nodeVersion: z.string().trim().min(1).optional(),
    releaseId: z.string().trim().min(1).optional(),
    appVersion: z.string().trim().min(1).optional(),
    target: z.string().trim().min(1).optional(),
    archiveSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .optional(),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            paths: z.array(z.string().trim().min(1)).min(1),
            sizeBytes: z.number().int().nonnegative(),
            archivePath: z.string().trim().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;

export const releaseCatalogEntrySchema = z
  .object({
    version: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u),
    appVersion: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u)
      .optional(),
    target: z.string().trim().min(1),
    archiveUrl: z.string().url(),
    manifestUrl: z.string().url().optional(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/i),
    archiveSizeBytes: z.number().int().nonnegative().optional(),
    components: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            sha256: z.string().regex(/^[a-f0-9]{64}$/i),
            sizeBytes: z.number().int().nonnegative(),
            archiveUrl: z.string().url().optional(),
            archiveSha256: z
              .string()
              .regex(/^[a-f0-9]{64}$/i)
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export const releaseCatalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    releases: z.array(releaseCatalogEntrySchema),
  })
  .strict();
export type ReleaseCatalogEntry = z.infer<typeof releaseCatalogEntrySchema>;
export type ReleaseCatalog = z.infer<typeof releaseCatalogSchema>;
