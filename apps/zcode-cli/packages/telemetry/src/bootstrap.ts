// 模型遥测 Bootstrap —— 负责环境解析、身份与资源属性构造、进程级 Owner 的准备/复用/关闭。
// 主入口：同步工厂 createModelTelemetry，以及异步生命周期 prepare/shutdown/updateIdentity。
// 不负责：Span 语义与采样、OTLP 协议编码、Exporter 重试与队列（均在 otlp-exporter 与 SDK 内）。
//
// INV-01 断言：createModelTelemetry 全程同步且不做任何 I/O —— 守住它的位置：该函数体 —— 改错故障：慢盘或网络挂起时 CLI 启动首屏卡死。
// INV-02 断言：进程内至多存在一个 Owner —— 守住它的位置：preparedOwner / preparingOwner 与 createPreparedOwner 的赋值 —— 改错故障：重复创建 Provider 与连接池，指标重复上报。
// INV-03 断言：显式注入的 options.owner 永远优先于环境准备出的 Owner —— 守住它的位置：createModelTelemetry 首行兜底表达式 —— 改错故障：宿主注入被端点覆盖，身份分裂。
// INV-04 断言：Session 的 shutdown 只 flush 与 abandonSession，不关闭共享资源 —— 守住它的位置：createModelTelemetry 返回的 shutdown —— 改错故障：关闭一个 Session 导致其余会话遥测静默中断。
// INV-05 断言：无 traces 端点或显式 disabled 时不加载 OTel SDK —— 守住它的位置：prepareModelTelemetryEnv 首个体检分支 —— 改错故障：关闭遥测仍需付出 SDK 加载时间与内存。
// INV-06 断言：专用 TRACES/METRICS 端点覆盖通用端点，通用端点才补 /v1/* 路径 —— 守住它的位置：resolveOtlpTraceEndpoint / resolveOtlpMetricEndpoint —— 改错故障：地址被二次拼接，上报 404。
// INV-07 断言：只有 http/https 且可解析的端点才生效 —— 守住它的位置：validHttpUrl —— 改错故障：凭据被发往 file:/grpc: 等非预期目标。
// INV-08 断言：同一状态文件的 deviceMid 解析在进程内只跑一次 —— 守住它的位置：pendingStandaloneDeviceMidByStateFile —— 改错故障：并发生成多个 UUID，同一设备身份漂移。
// INV-09 断言：状态文件写入必须先写临时文件再 rename —— 守住它的位置：resolveStandaloneDeviceMidFromFile 加锁分支 —— 改错故障：其他进程读到半截 JSON，deviceMid 丢失。
// INV-10 断言：锁内必须二次读取状态后才生成 deviceMid —— 守住它的位置：withTelemetryStateLock 的回调 —— 改错故障：跨进程覆盖已有身份。
// INV-11 断言：只能清理自己持有的锁文件 —— 守住它的位置：withTelemetryStateLock 的 finally —— 改错故障：误删活跃锁，并发双写状态文件。
// INV-12 断言：锁清理失败与状态读写失败都只降级为缺少匿名关联 —— 守住它的位置：全部 catch 分支 —— 改错故障：遥测旁路异常打断 Agent 主链路。
// INV-13 断言：身份与资源属性只上报白名单内的合法值 —— 守住它的位置：normalizeTelemetryId / normalizeVersion / normalizeBuildCommitId —— 改错故障：换行或脏字符污染 OTLP 属性。
// INV-14 断言：身份状态只能是 authenticated/anonymous/unknown，且仅 authenticated 携带 userSubjectId —— 守住它的位置：resolveTelemetryIdentity —— 改错故障：匿名快照泄露账号标识。
// INV-15 断言：初始化异常只走 onWarning 且不携带堆栈与凭据 —— 守住它的位置：createPreparedOwner 的 catch —— 改错故障：日志泄露连接串或密钥。
// INV-16 断言：关闭超时上限 1.5s，且清空全局引用先于 await —— 守住它的位置：shutdownPreparedModelTelemetry —— 改错故障：进程退出挂起或重复关闭。
//
// [契约] 本文件是遥测的唯一装配点：模型链路只拿端口，不得直接 import OTel SDK 或 Exporter。
// [权衡] 启动耗时优先于遥测完整性：身份持久化失败一律丢关联，不做重试阻塞。
// [失败路径] 任何降级都返回 noop 端口或 undefined，业务侧表现为「照常运行、没有遥测」。
// [并发] 跨进程一致依赖状态文件锁；同进程一致依赖 preparedOwner 与在途 Promise 去重。
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  AgentTelemetryRuntimeOwner,
  AgentExecutionTelemetryPort,
  ModelApiRuntimeSurface,
  ModelExecutionTelemetryPort,
  TelemetryIdentitySnapshot,
  TelemetryResourceContext,
} from "@zcode/contracts/telemetry";
import type { ModelStatusSink } from "@zcode/contracts/model";
import { NoopAgentExecutionTelemetry } from "./agent-trace-runtime.js";

type EnvRecord = Record<string, string | undefined>;

// 锁过期阈值：锁龄超过 5 分钟且持有进程已死（或元数据无有效 pid）才允许回收残留锁。
// [权衡] 阈值不能调小：锁内容写入后 mtime 不再刷新，活跃持有者会被误判为残留。
// 调大则崩溃进程留下的锁最长会阻塞后续 CLI 五分钟，期间只降级为缺少匿名关联。
const TELEMETRY_STATE_LOCK_STALE_MS = 5 * 60_000;
const TELEMETRY_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const BUILD_COMMIT_PATTERN = /^[0-9a-f]{7,64}$/iu;
// [并发] 同一状态文件只允许一个 deviceMid 解析在途，并发调用共享同一个 Promise。
// 若各自生成 UUID 再 rename，后写者会覆盖先写者，同一设备出现两个匿名身份。
// 键为状态文件绝对路径，ZCODE_HOME 不同的进程互不干扰。
const pendingStandaloneDeviceMidByStateFile = new Map<string, Promise<string | undefined>>();
// [契约] 进程级唯一 Owner：同步工厂与所有 Session 只读取它，不得各自新建 Provider。
// 写入只发生在 createPreparedOwner 完成赋值处，以及 shutdown 清空处。
// 在 Session 层重建 Owner 会重复申请连接池并按进程维度重复上报资源属性。
let preparedOwner: AgentTelemetryRuntimeOwner | undefined;
let preparingOwner: Promise<AgentTelemetryRuntimeOwner | undefined> | undefined;
// 禁用路径与无 Owner 路径共用的空实现：方法全部空转，不产生 Span、不抛错。
// [权衡] noopExecution 是进程级单例：禁用与无 Owner 路径共用同一个空实现，调用点省掉判空。
const noopExecution = new NoopAgentExecutionTelemetry();

// [契约] options.owner 优先于进程级 preparedOwner：宿主注入的 Owner 不会被环境端点覆盖。
// 否则同一进程会出现两套身份与两套 Exporter，指标重复上报。
// sessionId 只用于 shutdown 时释放该 Session 的引用，不参与 Owner 构造。
export interface CreateModelTelemetryOptions {
  owner?: AgentTelemetryRuntimeOwner;
  sessionId?: string;
}

export interface ModelTelemetryBootstrap {
  agentExecution: AgentExecutionTelemetryPort;
  enabled: boolean;
  modelExecution: ModelExecutionTelemetryPort;
  statusSink?: ModelStatusSink;
  shutdown(): Promise<void>;
}

// [并发] 本函数必须保持同步：任何 await、readFile 或动态 import 都会把启动期 I/O 带回主链路。
// [失败路径] 拿不到 Owner 时返回 enabled=false 的全 noop 端口，调用方无需再判空。
// [契约] 返回的 shutdown 只做 abandonSession 与 flush，不关闭 Provider、Exporter 或 Context Manager。
// 关闭共享资源会让其他仍在运行的 Session 遥测静默中断且无法恢复。
// [资源] flush 的 1.5s 是硬上限：超时即放弃剩余 Span，避免进程退出被遥测拖住。
export function createModelTelemetry(
  options: CreateModelTelemetryOptions = {},
): ModelTelemetryBootstrap {
  // 显式注入优先，Endpoint 永远不能覆盖宿主提供的进程级 Owner。
  const owner = options.owner ?? preparedOwner;
  if (!owner) {
    return {
      agentExecution: noopExecution,
      enabled: false,
      modelExecution: noopExecution,
      async shutdown() {},
    };
  }
  return {
    agentExecution: owner.agentExecution,
    enabled: owner.enabled,
    modelExecution: owner.modelExecution,
    statusSink: owner.statusSink,
    async shutdown() {
      if (options.sessionId) owner.abandonSession(options.sessionId);
      // Session 只借用进程 Owner。关闭 Session 可以 flush，但不能关闭 Provider、Exporter、
      // Context Manager 或其他 Session 仍在使用的队列。
      await owner.flush({ timeoutMs: 1_500 });
    },
  };
}

export interface PrepareModelTelemetryOptions {
  buildCommitId?: string;
  cliVersion?: string;
  onWarning?: (message: string, context: Record<string, unknown>) => void;
  productVersion?: string;
  runtimeDistribution?: TelemetryResourceContext["runtimeDistribution"];
  runtimeSurface?: ModelApiRuntimeSurface;
}

// [契约] 专用 TRACES_ENDPOINT 原样生效，不再补 /v1/traces 路径。
// 通用 ENDPOINT 按规范补 /v1/traces，先去掉末尾斜杠以免出现双斜杠。
// [失败路径] 非 http/https 或不可解析的地址一律视为未配置，等价于关闭遥测。
// 返回值已经过 URL 归一化，下游不得再用字符串拼接改写。
export function resolveOtlpTraceEndpoint(env: EnvRecord): string | undefined {
  const traceEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (traceEndpoint) return validHttpUrl(traceEndpoint);
  const commonEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (!commonEndpoint) return undefined;
  const valid = validHttpUrl(commonEndpoint);
  if (!valid) return undefined;
  const parsed = new URL(valid);
  parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/v1/traces`;
  return parsed.toString();
}

// [契约] 优先级为 METRICS_ENDPOINT > 通用 ENDPOINT 补 /v1/metrics > traces 端点回退。
// ARMS 自定义接入点的 Trace 与 Metric 共用同一 URL，所以只剩 traces 配置时沿用它。
// 通用 ENDPOINT 非法时直接返回 undefined，不回退 traces，避免指标发往错误目标。
// 调整这段顺序会改变线上指标落点，属于破坏性变更。
export function resolveOtlpMetricEndpoint(env: EnvRecord): string | undefined {
  const metricEndpoint = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  if (metricEndpoint) return validHttpUrl(metricEndpoint);
  const commonEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (commonEndpoint) {
    const valid = validHttpUrl(commonEndpoint);
    if (!valid) return undefined;
    const parsed = new URL(valid);
    parsed.pathname = `${parsed.pathname.replace(/\/$/u, "")}/v1/metrics`;
    return parsed.toString();
  }
  // ARMS 的自定义 OTLP HTTP 接入点对 Trace/Metric 共用同一 URL；只有 traces 专用
  // 配置时沿用它，避免打包环境必须额外维护一套密钥和接入点。
  return resolveOtlpTraceEndpoint(env);
}

// [契约] 头部格式是逗号分隔的 key=value，键与值都做 URL 解码。
// 按首个等号切分，值中允许包含等号（例如 base64 填充），不能用 split 全切。
// [失败路径] 无等号、空键或空值的片段静默跳过，全空时返回 undefined。
// 不能让空字符串头透传给 Exporter，否则会发出非法请求头。
export function parseOtlpHeaders(value: string | undefined): Record<string, string> | undefined {
  if (!value?.trim()) return undefined;
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const key = safeDecode(pair.slice(0, separator).trim());
    const headerValue = safeDecode(pair.slice(separator + 1).trim());
    if (key && headerValue) headers[key] = headerValue;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

// [并发] 只在 CLI 异步启动边界调用：这里可以 I/O，但必须在同步 App 工厂之外 await。
// [失败路径] 没有 traces 端点或环境显式禁用时原样返回 env，且绝不加载 OTel SDK。
// deviceMid 缺失则补齐并回写 env，让随后创建的 Session 复用同一匿名身份。
// [契约] preparedOwner 已存在时不再新建，preparingOwner 保证并发调用只初始化一次。
// 返回的是新 env 对象而非就地修改入参，调用方必须使用返回值。
/**
 * 在 CLI 的异步启动边界准备身份并动态加载 OTel SDK。同步 App 工厂只借用已准备好的
 * 进程级 Owner；disabled 路径不会 import SDK/Exporter。
 */
export async function prepareModelTelemetryEnv(
  env: EnvRecord,
  options: PrepareModelTelemetryOptions = {},
): Promise<EnvRecord> {
  if (!resolveOtlpTraceEndpoint(env) || isExplicitlyDisabled(env.ZCODE_MODEL_TELEMETRY_ENABLED)) {
    return env;
  }
  const existingInstallationId = normalizeTelemetryDeviceMid(env.ZCODE_TELEMETRY_DEVICE_MID);
  const installationId =
    existingInstallationId ?? (await resolveStandaloneDeviceMid(env.ZCODE_HOME?.trim()));
  const preparedEnv = installationId ? { ...env, ZCODE_TELEMETRY_DEVICE_MID: installationId } : env;

  if (!preparingOwner && !preparedOwner) {
    preparingOwner = createPreparedOwner(preparedEnv, options);
  }
  preparedOwner = await preparingOwner;
  return preparedEnv;
}

// [资源] 先清空全局引用再 await 关闭，重复调用不会二次关闭，也不会阻塞新的准备流程。
// [并发] 若 preparingOwner 仍在途则等待其完成，避免准备与关闭竞态造成 Owner 泄漏。
// 关闭有 1.5s 上限，未导出的 Span 直接丢弃，优先保证进程能退出。
// 只关闭进程级 Owner，Session 级队列由各 Session 自己的 shutdown 处理。
export async function shutdownPreparedModelTelemetry(): Promise<void> {
  const owner = preparedOwner ?? (await preparingOwner);
  preparedOwner = undefined;
  preparingOwner = undefined;
  await owner?.shutdown({ timeoutMs: 1_500 });
}

// [契约] 登录态变化只热更新身份快照，不重建 Owner，保留已有连接与资源属性。
// Owner 尚未准备完成时静默丢弃：下次 prepare 会用最新环境重新推导身份。
// 此处必须保持同步无等待，否则会阻塞登录回调。
export function updatePreparedTelemetryIdentity(snapshot: TelemetryIdentitySnapshot): void {
  preparedOwner?.updateIdentity(snapshot);
}

// [资源] serviceInstanceId 每次进程启动随机生成，用于区分同一设备上的多个进程。
// deploymentEnvironment 回退链为 ZCODE_ENV、ZCODE_RUNTIME_ENV，最后才读 OTEL 资源属性。
// runtimeDistribution 与 runtimeSurface 以调用方显式传入值为准，环境变量只是兜底。
// [契约] 资源属性交给 Exporter 后即不可变，后续身份变化只能走 updateIdentity。
async function createPreparedOwner(
  env: EnvRecord,
  options: PrepareModelTelemetryOptions,
): Promise<AgentTelemetryRuntimeOwner | undefined> {
  const endpoint = resolveOtlpTraceEndpoint(env);
  if (!endpoint) return undefined;
  const metricEndpoint = resolveOtlpMetricEndpoint(env);
  const identity = resolveTelemetryIdentity(env);
  const resource: TelemetryResourceContext = {
    buildCommitId: normalizeBuildCommitId(options.buildCommitId ?? env.ZCODE_BUILD_COMMIT_ID),
    cliVersion: normalizeVersion(options.cliVersion),
    deploymentEnvironment:
      env.ZCODE_ENV ??
      env.ZCODE_RUNTIME_ENV ??
      resourceAttributesFromEnv(env)["deployment.environment.name"],
    installationId: normalizeTelemetryDeviceMid(env.ZCODE_TELEMETRY_DEVICE_MID),
    productVersion: normalizeVersion(options.productVersion ?? env.ZCODE_APP_VERSION),
    runtimeDistribution:
      options.runtimeDistribution ??
      resolveRuntimeDistribution(env.ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION),
    runtimeSurface:
      options.runtimeSurface ?? resolveRuntimeSurface(env.ZCODE_TELEMETRY_RUNTIME_SURFACE),
    serviceInstanceId: randomUUID(),
    serviceName: env.OTEL_SERVICE_NAME?.trim() || "zcode-cli-agent",
  };
  try {
    // [权衡] 动态 import 让禁用路径完全不加载 OTel SDK 与 Exporter，显著缩短冷启动。
    // 改成静态 import 会把 SDK 塞进启动路径，即使遥测关闭也要付出加载与内存。
    // 必须保持 await import 形式，与 ESM 打包产物和 tree-shaking 配置一致。
    // [失败路径] 模块缺失或加载抛错由外层 catch 兜底，降级为无遥测。
    const { createOwnedAgentTelemetryRuntime } = await import("./otlp-exporter.js");
    return createOwnedAgentTelemetryRuntime({
      endpoint,
      headers: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      identity,
      metricEndpoint,
      metricHeaders: parseOtlpHeaders(
        env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS,
      ),
      onWarning: options.onWarning,
      resource,
    });
  } catch (error) {
    // [失败路径] 初始化失败只上报警告并降级为无遥测，绝不向 Agent 主链路抛错。
    // 只上报错误名或类型名，禁止写入堆栈、请求头或连接串，防止日志泄密。
    // 返回 undefined 后同步工厂自然落入 noop 分支，业务表现与禁用等价。
    options.onWarning?.("Agent telemetry runtime initialization failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    return undefined;
  }
}

// [契约] 身份状态优先级：显式 IDENTITY_STATE，其次有 userSubjectId 判 authenticated，
// 再其次有合法 deviceMid 判 anonymous，其余一律 unknown。
// 只有 authenticated 才携带 userSubjectId 字段，匿名快照不得暴露账号标识。
function resolveTelemetryIdentity(env: EnvRecord): TelemetryIdentitySnapshot {
  const userSubjectId = normalizeTelemetryId(env.ZCODE_TELEMETRY_USER_SUBJECT_ID);
  const configuredState = env.ZCODE_TELEMETRY_IDENTITY_STATE?.trim();
  const identityState =
    configuredState === "authenticated" ||
    configuredState === "anonymous" ||
    configuredState === "unknown"
      ? configuredState
      : userSubjectId
        ? "authenticated"
        : normalizeTelemetryDeviceMid(env.ZCODE_TELEMETRY_DEVICE_MID)
          ? "anonymous"
          : "unknown";
  return { identityState, ...(userSubjectId ? { userSubjectId } : {}) };
}

export function normalizeTelemetryDeviceMid(value: string | undefined): string | undefined {
  return normalizeTelemetryId(value);
}

// [契约] 标识白名单限定字母数字与点、下划线、冒号、横线，长度 1~128。
// 该白名单同时阻断换行、逗号、空格，防止脏环境变量注入资源属性或请求头。
// 非法值降级为 undefined 而不是抛错，脏配置只损失关联，不影响启动。
function normalizeTelemetryId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && TELEMETRY_ID_PATTERN.test(normalized) ? normalized : undefined;
}

// [并发] 先用状态文件路径做在途去重，再进入跨进程文件锁，同进程并发不会排队等锁。
// [资源] finally 中比对 Promise 身份后再删除，避免误删后来者的在途记录。
// 状态文件固定在 zcodeHome/v2 或 ~/.zcode/v2 下，与 CLI 其余状态同目录。
async function resolveStandaloneDeviceMid(
  zcodeHome: string | undefined,
): Promise<string | undefined> {
  const stateFile = zcodeHome
    ? join(zcodeHome, "v2", "telemetry-state.json")
    : join(homedir(), ".zcode", "v2", "telemetry-state.json");
  const pending = pendingStandaloneDeviceMidByStateFile.get(stateFile);
  if (pending) return pending;
  const resolution = resolveStandaloneDeviceMidFromFile(stateFile);
  pendingStandaloneDeviceMidByStateFile.set(stateFile, resolution);
  try {
    return await resolution;
  } finally {
    if (pendingStandaloneDeviceMidByStateFile.get(stateFile) === resolution) {
      pendingStandaloneDeviceMidByStateFile.delete(stateFile);
    }
  }
}

// [事务] 无锁快路径：文件中已有合法 deviceMid 时直接返回，不加锁也不写盘。
// 加锁后必须重新读取状态，其他进程可能已在此期间写入，重复生成会造成身份分裂。
// [资源] 先写同目录临时文件再 rename，读者不会看到写了一半的 JSON。
// 临时文件名含 pid 与随机 UUID，跨进程并发写不会互相覆盖。
async function resolveStandaloneDeviceMidFromFile(stateFile: string): Promise<string | undefined> {
  try {
    const existing = await readDeviceMid(stateFile);
    if (existing) return existing;
    return await withTelemetryStateLock(stateFile, async () => {
      const state = await readTelemetryState(stateFile);
      const lockedExisting = deviceMidFromState(state);
      if (lockedExisting) return lockedExisting;
      const deviceMid = randomUUID();
      state.deviceMid = deviceMid;
      const temporary = `${stateFile}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
      await rename(temporary, stateFile);
      return deviceMid;
    });
  } catch {
    // Bug 根因：Telemetry 身份过去在同步工厂里直接做文件 I/O，慢盘会阻塞 CLI 启动；
    // 异步准备仍必须保持旁路，读写失败只缺少匿名关联，不能影响 Agent 主链路。
    return undefined;
  }
}

// [并发] 互斥靠独占创建锁文件实现，open 的 wx 标志在文件已存在时抛 EEXIST。
// [事务] 最多两轮：首轮 EEXIST 时清理残留锁再抢一次，仍失败则放弃写入。
// [资源] finally 中先 close 再 unlink，句柄未关闭时 Windows 无法删除锁文件。
// 只有本进程真正拿到锁才清理锁文件，避免删除其他活跃进程的锁。
// 抢锁失败不排队等待，直接读回已有 deviceMid，最差结果只是本次缺少匿名关联。
async function withTelemetryStateLock(
  stateFile: string,
  run: () => Promise<string>,
): Promise<string | undefined> {
  const lockFile = join(dirname(stateFile), "telemetry-state.lock");
  await mkdir(dirname(stateFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      lockHandle = await open(lockFile, "wx");
      await lockHandle.writeFile(
        JSON.stringify({ createdAt: Date.now(), pid: process.pid }),
        "utf8",
      );
      return await run();
    } catch (error) {
      if (!isFileExistsError(error) || !(await removeStaleTelemetryStateLock(lockFile))) {
        throw error;
      }
    } finally {
      if (lockHandle !== undefined) {
        await lockHandle.close();
        try {
          await unlink(lockFile);
        } catch {
          // 另一个进程可能已回收异常残留；锁清理失败不影响模型链路。
        }
      }
    }
  }
  // 另一个活跃进程正在更新同一文件时不等待；本次仅缺少匿名 device 关联。
  return await readDeviceMid(stateFile);
}

// [并发] 仅当锁龄超过 stale 阈值且元数据无有效 pid 或进程已死时才回收，避免误杀活跃锁。
// 锁龄按 mtime 计算，写入后不再刷新，长任务必须在阈值内完成状态写入。
// [失败路径] stat 或读取异常一律返回 false，宁可放弃本次写入也不冒险删锁。
async function removeStaleTelemetryStateLock(lockFile: string): Promise<boolean> {
  try {
    const metadata = await stat(lockFile);
    if (Date.now() - metadata.mtimeMs < TELEMETRY_STATE_LOCK_STALE_MS) {
      const owner = await readTelemetryState(lockFile);
      const pid =
        typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : undefined;
      if (!pid || isProcessAlive(pid)) return false;
    }
    await unlink(lockFile);
    return true;
  } catch {
    return false;
  }
}

// [契约] 用 signal 0 探测进程存在性，不真正发信号，ESRCH 表示进程已不存在。
// EPERM 等其他错误按存活处理：无权探测不等于对方已退出。
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    );
  }
}

function isFileExistsError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

// [失败路径] 文件缺失、JSON 损坏或顶层非对象一律返回空对象，调用方按无状态处理。
// 显式拒绝数组与 null，deviceMid 只可能出现在对象根上。
// 吞掉异常是设计选择：状态文件只是旁路缓存，损坏后重建即可。
async function readTelemetryState(stateFile: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function readDeviceMid(stateFile: string): Promise<string | undefined> {
  return deviceMidFromState(await readTelemetryState(stateFile));
}

function deviceMidFromState(state: Record<string, unknown>): string | undefined {
  return typeof state.deviceMid === "string" && state.deviceMid.trim()
    ? state.deviceMid.trim()
    : undefined;
}

function resolveRuntimeSurface(value: string | undefined): ModelApiRuntimeSurface {
  switch (value?.trim()) {
    case "standalone_cli":
    case "desktop_local_host":
    case "remote_workspace_host":
      return value.trim() as ModelApiRuntimeSurface;
    default:
      return "standalone_cli";
  }
}

function resolveRuntimeDistribution(
  value: string | undefined,
): TelemetryResourceContext["runtimeDistribution"] {
  switch (value?.trim()) {
    case "source":
    case "development_bundle":
    case "packaged":
    case "unknown":
      return value.trim() as TelemetryResourceContext["runtimeDistribution"];
    default:
      return "unknown";
  }
}

function normalizeVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u.test(normalized)
    ? normalized
    : undefined;
}

function normalizeBuildCommitId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && BUILD_COMMIT_PATTERN.test(normalized) ? normalized.toLowerCase() : undefined;
}

function resourceAttributesFromEnv(env: EnvRecord): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of env.OTEL_RESOURCE_ATTRIBUTES?.split(",") ?? []) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    result[safeDecode(item.slice(0, separator).trim())] = safeDecode(
      item.slice(separator + 1).trim(),
    );
  }
  return result;
}

function validHttpUrl(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return ["0", "false", "off", "disabled"].includes(value?.trim().toLowerCase() ?? "");
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
