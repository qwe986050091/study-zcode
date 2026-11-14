// INV-01 本模块只由 Telemetry 启用后的异步 Bootstrap 动态加载；守住位置：createOwnedAgentTelemetryRuntime 的调用方；改错故障：--help 与版本查询也会付出 OTel SDK 初始化成本，启动明显变慢。
// INV-02 每次调用工厂都新建独立的 Tracer 与 Meter Provider 及 exporter，不复用模块级单例；守住位置：createOwnedAgentTelemetryRuntime；改错故障：重复初始化后顶层 span 与指标串到别的进程实例。
// INV-03 GZIP 压缩与 timeoutMs 同时作用于 trace 与 metric 两条导出链路；守住位置：两个 exporter 的构造参数；改错故障：弱网下导出不受超时约束，进程退出被拖住。
// INV-04 Span 队列满时丢弃新数据而不是阻塞调用方；守住位置：BatchSpanProcessor 的 maxQueueSize；改错故障：遥测反压传导到 agent 主循环，用户感到卡顿。
// INV-05 Metric 使用 DELTA temporality；守住位置：temporalityPreference；改错故障：短生命周期进程的累计 Counter 在后端重置冲突，仪表盘出现负值或断崖。
// INV-06 Metric Resource 不携带进程实例 ID 与安装 ID；守住位置：metricResourceAttributes；改错故障：每次启动生成新 Series，后端基数无界增长。
// INV-07 Trace Resource 才携带 service.instance.id 与 installation_id；守住位置：resourceAttributes；改错故障：同一用户的多次会话无法在 trace 侧区分实例。
// INV-08 空的资源属性在进入 Resource 前被剔除；守住位置：compactResourceAttributes；改错故障：空字符串成为独立 Series 维度，指标聚合失真。
// INV-09 全局 Context Manager 注册失败时立即关闭本实例；守住位置：registered 分支；改错故障：同进程留下第二套 AsyncLocalStorage，异步上下文串号。
// INV-10 只有注册成功的实例在 shutdown 时反注册 Context Manager；守住位置：shutdown 的 finally；改错故障：宿主自有的 Context Manager 被误关，宿主后续 span 丢失父子关系。
// INV-11 closed 标志保证 flush 与 shutdown 幂等；守住位置：两个入口的首行判定；改错故障：重复 shutdown 触发 SDK 内部状态异常并向上抛错。
// INV-12 shutdown 必须等两个 Provider 都结束才清理上下文；守住位置：withTimeout 包裹的并行关闭；改错故障：退出时最后一批 span 与指标丢失。
// INV-13 flush 与 shutdown 共用同一个超时预算上限；守住位置：flushOptions 与 shutdownOptions 的缺省回落；改错故障：未传超时的调用方在退出路径无限期挂起。
// INV-14 shutdown 用超时兜底而不强杀导出；守住位置：withTimeout；改错故障：后端不可达时进程卡死，用户只能强杀。
// INV-15 Trace 采样采用 ParentBased 加 TraceIdRatio；守住位置：createAgentTraceSampler；改错故障：子 span 与父 span 采样决策不一致，链路断裂成孤岛。
// INV-16 每个 View 的 aggregationCardinalityLimit 固定为 250；守住位置：histogramView 与 cardinalityView；改错故障：高基数标签撑爆内存，长会话指标内存持续上涨。
// INV-17 直方图桶边界按业务量级定制且不记录 min/max；守住位置：metricViews；改错故障：百分位全部落在同一桶，延迟分析失去分辨率。
// INV-18 metricExportIntervalMs 缺省 5 分钟；守住位置：PeriodicExportingMetricReader 构造；改错故障：短命进程来不及导出任何指标，或导出过于频繁。
// INV-19 未给 metricEndpoint 时指标端点回落到 trace endpoint；守住位置：OTLPMetricExporter 构造；改错故障：指标静默发往错误端点，后端看不到指标。
// INV-20 withTimeout 结束后必定清除定时器；守住位置：withTimeout 的 finally；改错故障：遗留 timer 保持事件循环存活，CLI 退不出去。
//
// 本模块是 CLI 遥测唯一的 OTel SDK 装配点，负责 Provider、Exporter 与 Context Manager 的生命周期。
// 所有关闭动作都必须幂等且有超时上界，任何一条导出链路都不能阻塞进程退出。
// 资源属性与 temporality 的选择直接决定后端基数与 Series 语义，改动需同步 telemetry spec。
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { CompressionAlgorithm } from "@opentelemetry/otlp-exporter-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
} from "@opentelemetry/sdk-trace-base";
import {
  TELEMETRY_SCHEMA_VERSION,
  type AgentTelemetryRuntimeOwner,
  type TelemetryIdentitySnapshot,
  type TelemetryResourceContext,
} from "@zcode/contracts/telemetry";
import { AgentExecutionTelemetryRuntime } from "./agent-trace-runtime.js";
import { OtelAgentTelemetryMetrics } from "./agent-metrics.js";
import { ModelApiTelemetryStatusSink } from "./model-api-recorder.js";

// [权衡] 5 分钟导出周期让短命 CLI 进程通常来不及导出指标，换取后端写入量与进程开销的平衡。
// [并发] 取值可被 metricExportIntervalMs 覆盖，缺省值只决定未配置环境下的基线行为。
export const AGENT_METRIC_EXPORT_INTERVAL_MS = 300_000;
// [权衡] 默认 10% 采样控制后端成本，父级决策优先使同一 trace 内采样结果保持一致。
// [失败路径] 采样丢弃的 span 不进入队列，超时与错误的多数样本随之消失，排障需临时调高比例。
export const AGENT_TRACE_SAMPLE_RATIO = 0.1;

export interface CreateOwnedAgentTelemetryRuntimeOptions {
  endpoint: string;
  headers?: Record<string, string>;
  identity?: TelemetryIdentitySnapshot;
  // [资源] 单批上限决定一次网络请求的体积，过大会放大超时风险与内存峰值。
  // [权衡] 缺省 100 与队列 2000 配合，队列最多容纳 20 个待发批次。
  maxBatchSize?: number;
  // [失败路径] 队列满时丢弃最新 span 并计数，调用方只能通过 onWarning 感知采样损失。
  // [并发] 队列上限在构造期固化，运行期不可调整，扩容只能重建 Provider。
  maxQueueSize?: number;
  metricEndpoint?: string;
  metricExportIntervalMs?: number;
  metricHeaders?: Record<string, string>;
  onWarning?: (message: string, context: Record<string, unknown>) => void;
  resource: TelemetryResourceContext;
  timeoutMs?: number;
  traceSampleRatio?: number;
}

/**
 * 该模块只由异步 Bootstrap 在 Telemetry 确认启用后动态加载。不要从公共入口静态导入，
 * 否则 `--help`、版本查询和 disabled 模式仍会承担 OTel SDK 初始化成本。
 */
// [资源] 每次调用都新建 exporter、两个 Provider 与 Context Manager，调用方必须持有返回值并在退出时 shutdown。
// [权衡] 模块内不缓存任何 SDK 对象，重复调用会并行产生两条导出链路，因此只能由 Bootstrap 单点调用。
// [失败路径] 构造期不发起网络请求，端点或鉴权错误只会在首次导出时以丢弃批次的形式暴露。
export function createOwnedAgentTelemetryRuntime(
  options: CreateOwnedAgentTelemetryRuntimeOptions,
): AgentTelemetryRuntimeOwner {
  // [权衡] 3 秒缺省超时既覆盖弱网握手，又保证 CLI 退出不被遥测拖住。
  // [资源] 同一超时同时约束单次导出与 Provider 关闭，避免两处预算不一致。
  const timeoutMs = options.timeoutMs ?? 3_000;
  const exporter = new OTLPTraceExporter({
    compression: CompressionAlgorithm.GZIP,
    headers: options.headers,
    timeoutMillis: timeoutMs,
    url: options.endpoint,
  });
  // [并发] 队列满时由 SDK 丢弃 span 并回调丢弃计数，不会阻塞产生 span 的业务线程。
  // [资源] maxQueueSize 缺省 2000 与 maxBatchSize 缺省 100 形成有界内存上界，避免长会话无界增长。
  // [失败路径] exportTimeoutMillis 与 timeoutMs 一致，导出悬挂最多占用一个超时窗口，后续批次继续排队。
  const processor = new BatchSpanProcessor(exporter, {
    exportTimeoutMillis: timeoutMs,
    maxExportBatchSize: options.maxBatchSize ?? 100,
    maxQueueSize: options.maxQueueSize ?? 2_000,
    scheduledDelayMillis: 5_000,
  });
  const traceResource = resourceFromAttributes(resourceAttributes(options.resource));
  const metricResource = resourceFromAttributes(metricResourceAttributes(options.resource));
  // [并发] spanProcessors 只挂一个批量处理器，且不注册为全局 Provider，避免覆盖宿主或测试环境。
  // [失败路径] forceFlushTimeoutMillis 与导出超时一致，关闭阶段不会因残留批次无限等待。
  const provider = new BasicTracerProvider({
    forceFlushTimeoutMillis: timeoutMs,
    resource: traceResource,
    sampler: createAgentTraceSampler(options.traceSampleRatio),
    spanProcessors: [processor],
  });
  const metricExporter = new OTLPMetricExporter({
    compression: CompressionAlgorithm.GZIP,
    headers: options.metricHeaders ?? options.headers,
    // CLI Metric 不携带每进程实例 ID，必须用 DELTA 避免多个短生命周期生产者的累计
    // Counter/Histogram 在后端发生重置冲突。
    // [权衡] DELTA 让每个进程只上报增量，短命进程之间互不干扰，代价是后端需自行累加。
    // [失败路径] 若误改为 CUMULATIVE，进程重启后计数器归零会与旧 Series 冲突。
    temporalityPreference: AggregationTemporality.DELTA,
    timeoutMillis: timeoutMs,
    url: options.metricEndpoint ?? options.endpoint,
  });
  // [资源] 周期导出器持有独立定时器，只有 Provider 关闭才会停止。
  // [失败路径] 导出超时不阻断下一个周期，后端持续不可达时丢弃批次并继续计时。
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: options.metricExportIntervalMs ?? AGENT_METRIC_EXPORT_INTERVAL_MS,
    exportTimeoutMillis: timeoutMs,
  });
  const meterProvider = new MeterProvider({
    readers: [metricReader],
    resource: metricResource,
    views: metricViews(),
  });
  const contextManager = new AsyncLocalStorageContextManager();
  // [并发] 全局 Context Manager 每个进程只能注册一次，注册结果是布尔值而非异常。
  // [失败路径] 返回 false 表示宿主已占用该槽位，本实例必须自行关闭以免留下第二套异步上下文。
  // [权衡] 注册成功后本实例的生命周期与全局状态绑定，必须由 shutdown 反注册。
  const registered = context.setGlobalContextManager(contextManager.enable());
  if (!registered) {
    // 同进程宿主已注册 Context Manager 时复用宿主实例；未注册成功的本实例必须关闭，
    // 避免留下第二套 AsyncLocalStorage。
    contextManager.disable();
  }

  const tracer = provider.getTracer("@zcode/cli-agent-telemetry", String(TELEMETRY_SCHEMA_VERSION));
  const meter = meterProvider.getMeter(
    "@zcode/cli-agent-telemetry",
    String(TELEMETRY_SCHEMA_VERSION),
  );
  const metrics = new OtelAgentTelemetryMetrics(meter);
  const execution = new AgentExecutionTelemetryRuntime({
    identity: options.identity,
    metrics,
    onWarning: options.onWarning,
    tracer,
  });
  const statusSink = new ModelApiTelemetryStatusSink({
    modelExecution: execution,
    onWarning: options.onWarning,
  });
  // [事务] closed 是唯一关闭哨兵，flush 与 shutdown 都先读它，保证关闭动作幂等。
  // [并发] 只置位不清零，一旦关闭该 runtime 不可复用，需要重新走工厂。
  let closed = false;

  return {
    abandonSession(sessionId) {
      execution.abandonSession(sessionId);
      statusSink.abandonSession(sessionId);
    },
    agentExecution: execution,
    enabled: true,
    modelExecution: execution,
    statusSink,
    // [并发] flush 可被多次并发调用，closed 判定先于导出，关闭后的调用直接返回。
    // [资源] 同时冲刷 trace 与 metric 两个 Provider，等待时间由传入超时或构造期 timeoutMs 封顶。
    // [失败路径] 超时后 withTimeout 返回 undefined，未完成的导出不会取消，只是不再阻塞调用方。
    async flush(flushOptions) {
      if (closed) return;
      await withTimeout(
        Promise.all([provider.forceFlush(), meterProvider.forceFlush()]),
        flushOptions?.timeoutMs ?? timeoutMs,
      );
    },
    // [事务] 先置 closed 再执行关闭流程，重复调用一律短路，保证 SDK 只被关闭一次。
    // [资源] 关闭顺序为状态汇总器、进程级 session、两个 Provider，最后反注册 Context Manager。
    // [失败路径] Provider 关闭抛错时 finally 仍会反注册上下文，全局状态不泄漏但错误会向上冒泡。
    async shutdown(shutdownOptions) {
      if (closed) return;
      closed = true;
      statusSink.shutdown();
      execution.abandonProcess();
      try {
        await withTimeout(
          Promise.all([provider.shutdown(), meterProvider.shutdown()]),
          shutdownOptions?.timeoutMs ?? timeoutMs,
        );
      } finally {
        // [资源] 只关闭本实例注册成功的 Context Manager，宿主实例必须保持原状。
        // [失败路径] 反注册发生在 Provider 关闭之后，确保关闭期间产生的 span 仍有上下文。
        if (registered) contextManager.disable();
      }
    },
    updateIdentity(snapshot) {
      execution.updateIdentity(snapshot);
    },
  };
}

// [权衡] ParentBased 让远端父级决策优先，本地比例只作用于根 span。
// [失败路径] 比例为 0 时根 span 全部丢弃，子 span 也随之不记录，等效于关闭 trace。
export function createAgentTraceSampler(ratio = AGENT_TRACE_SAMPLE_RATIO): Sampler {
  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(ratio),
  });
}

// [资源] View 按 instrument 名匹配，未列出的 instrument 使用 SDK 默认聚合与默认基数上限。
// [权衡] 桶边界与基数上限在此集中定义，改动会直接改变后端存储结构，需与后端同步。
export function metricViews(): ViewOptions[] {
  return [
    histogramView("zcode.agent.turn.duration", [1, 5, 10, 30, 60, 300, 600]),
    histogramView("zcode.model.*.duration", [0.25, 1, 2, 5, 10, 30, 60, 120]),
    histogramView(
      "zcode.context.compaction.duration",
      [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300, 600],
    ),
    histogramView(
      "zcode.detached.operation.duration",
      [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300, 600],
    ),
    histogramView("zcode.agent.step.duration", [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300, 600]),
    histogramView("zcode.tool.execution.duration", [0.01, 0.1, 0.5, 1, 5, 30, 120, 300]),
    histogramView(
      "zcode.command.execution.duration",
      [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 120, 300, 600],
    ),
    histogramView("zcode.*.time_to_first_*", [0.25, 0.5, 1, 2, 5, 10, 30, 60]),
    histogramView("zcode.model.call.attempts", [1, 2, 3, 5, 8]),
    cardinalityView("zcode.model.attempt.tokens"),
    cardinalityView("zcode.model.attempt.stream_stall.count"),
    cardinalityView("zcode.telemetry.creation_drop.count"),
    cardinalityView("zcode.telemetry.abandoned.count"),
  ];
}

// [资源] recordMinMax 关闭以减少每次记录的附加状态，只保留分桶计数。
// [失败路径] 基数超过 250 后 SDK 拒绝新标签组合，指标表现为维度缺失而非报错。
function histogramView(instrumentName: string, boundaries: number[]): ViewOptions {
  return {
    aggregation: {
      options: { boundaries, recordMinMax: false },
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
    },
    aggregationCardinalityLimit: 250,
    instrumentName,
  };
}

function cardinalityView(instrumentName: string): ViewOptions {
  return {
    aggregationCardinalityLimit: 250,
    instrumentName,
  };
}

// [权衡] Trace 侧保留安装 ID 与实例 ID，用于区分同一用户的多次运行。
// [失败路径] 这两个字段只能在 Trace 使用，混入 Metric 会立即造成 Series 爆炸。
export function resourceAttributes(
  resource: TelemetryResourceContext,
): Record<string, string | number | boolean> {
  return telemetryResourceAttributes(resource, {
    includeInstallationId: true,
    includeServiceInstanceId: true,
  });
}

// [并发] Metric 侧显式剔除非稳定标识，保证多进程聚合时 Series 身份一致。
// [失败路径] 若与 Trace 侧共用同一份属性，基数问题不会报错，只会在后端账单上体现。
export function metricResourceAttributes(
  resource: TelemetryResourceContext,
): Record<string, string | number | boolean> {
  return telemetryResourceAttributes(resource, {
    includeInstallationId: false,
    includeServiceInstanceId: false,
  });
}

function telemetryResourceAttributes(
  resource: TelemetryResourceContext,
  options: {
    includeInstallationId: boolean;
    includeServiceInstanceId: boolean;
  },
): Record<string, string | number | boolean> {
  return compactResourceAttributes({
    "deployment.environment.name": resource.deploymentEnvironment,
    "host.arch": hostArchitecture(),
    "os.type": process.platform,
    "process.runtime.name": "nodejs",
    "process.runtime.version": process.version.replace(/^v/u, ""),
    // Metric Resource 也参与时序 Series 身份。CLI 每次启动生成的实例 ID 和安装 ID 只能
    // 属于 Trace；若进入 Metric，会在所有用户进程间制造无界基数。
    // [资源] 该字段只允许出现在 Trace Resource，Metric 侧必须为 undefined 后由压缩函数剔除。
    // [失败路径] 一旦进入 Metric，每次 CLI 启动都产生新 Series，后端基数按进程数无界增长。
    "service.instance.id": options.includeServiceInstanceId
      ? resource.serviceInstanceId
      : undefined,
    "service.name": resource.serviceName,
    "service.version": resource.cliVersion,
    "zcode.build.commit_id": resource.buildCommitId,
    "zcode.device.installation_id": options.includeInstallationId
      ? resource.installationId
      : undefined,
    "zcode.product.version": resource.productVersion,
    "zcode.runtime.distribution": resource.runtimeDistribution,
    "zcode.runtime.surface": resource.runtimeSurface,
    "zcode.telemetry.schema_owner": "cli",
    "zcode.telemetry.schema_version": TELEMETRY_SCHEMA_VERSION,
  });
}

function hostArchitecture(): string {
  switch (process.arch) {
    case "x64":
      return "amd64";
    case "ia32":
      return "x86";
    default:
      return process.arch;
  }
}

function compactResourceAttributes(
  attributes: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const compacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== "") compacted[key] = value;
  }
  return compacted;
}

// [失败路径] 超时通过 resolve undefined 表达而非 reject，调用方无法区分超时与空结果，因此只用于收尾路径。
// [资源] 定时器在 finally 中清除，promise 提前完成时不会留下悬空 timer 拖住事件循环。
// [并发] 超时入参经下限钳制到 1 毫秒，防止 0 或负值退化成忙等。
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(resolve, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
