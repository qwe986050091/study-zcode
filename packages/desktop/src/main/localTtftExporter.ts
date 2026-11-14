// localTtftExporter.ts —— Main 侧本地 TTFT 遥测出口：必须校验批次、去重、下样到 OTLP 指标与链路
//
// INV-01 只有 kind 为 first_output 且 outcome 为 success 的记录才计入 TTFT 直方图；守住位置：consume 内的 first_output 分支；改错故障：失败或取消的等待被当成首输出时延，看板 TTFT 被拖慢到完全失真
// INV-02 TTFT 的采样点是首个输出 token 到达，而不是首字节也不是请求发出；守住位置：duration 记录的 end 减 start；改错故障：把首字节当首 token，时延被系统性低估，优化决策建立在错误基线上
// INV-03 timingReliable 为 false 的记录一律不能下样到任何直方图；守住位置：first_output、first_text 与 excluded 三处判据；改错故障：跨进程时钟不可比的样本混入分布，出现负值或极大离群点
// INV-04 阶段可靠性按来源分级：cli 看 cliTimingReliable，renderer 看 timingReliable，其余看 quality 不等于 clock_invalid；守住位置：intervals 循环内的 reliable 三元分支；改错故障：不同时钟域的区间被并列比较，同 stage 的 P95 抖动无意义
// INV-05 guided 发送模式的记录不进入默认 TTFT 分布；守住位置：first_output 分支的 sendMode 判据；改错故障：用户引导态的长等待混入自动态，默认体验指标长期偏高
// INV-06 系统内耗时长用 userWaitMs 从端到端时延中扣除，且扣除值不得超过总时延；守住位置：systemDuration 记录的守卫条件；改错故障：结果为负被直方图当作越界值丢弃，系统耗时分布永久缺失
// INV-07 去重键由 rendererInstanceId、observationId 与 checkpoint 共同决定，同一键只计一次；守住位置：dedupe.admit 与三处 remember 调用；改错故障：重连或重放产生重复样本，计数类指标翻倍
// INV-08 服务与模型标签最多保留 16 组，超出者一律折叠为 other；守住位置：modelLabels 的 size 判据与正则白名单；改错故障：自定义模型名撑爆基数，时序库写入量与内存随用户输入无界增长
// INV-09 标签中不得出现任何用户内容、路径、会话或请求标识；守住位置：labels 对象字面量；改错故障：隐私数据随指标出境，且无法从已落库的时序中撤回
// INV-10 队列上限 32 批，满时整批按记录数计入 queue_full 丢弃；守住位置：enqueue 内的 queue.length 判据；改错故障：无界排队把内存打满，长时间会话后 Main 进程 OOM
// INV-11 单批序列化后超过 256KiB 直接丢弃，不再进入解析与校验；守住位置：enqueue 的 size 判据；改错故障：超大载荷占用解析时间，IPC 线程被单个异常输入长时间阻塞
// INV-12 schema 校验失败的批次只计数不抛错，且告警必须带 issues 供定位；守住位置：safeParse 失败分支；改错故障：异常沿 IPC 抛回渲染进程，采样失败被放大成功能不可用
// INV-13 同一时刻只有一个 drain 循环，draining 在 finally 中复位；守住位置：draining 的单飞赋值与 finally；改错故障：并发消费导致同一批被 shift 两次或顺序错乱，span 重复导出
// INV-14 shutdown 之后 enqueue 一律静默返回，队列残量直接丢弃；守住位置：closed 判据与 shutdown 首两行；改错故障：退出阶段仍写入已关闭的 meter，进程退出被未 flush 的导出拖住
// INV-15 现在仪表必须采用 DELTA 累积性，每个导出周期只上报周期内增量；守住位置：OTLPMetricExporter 的 temporalityPreference；改错故障：后端按累加解读重复计数，同一窗口的量被反复相加
// INV-16 未配置合法 endpoint 时整条链路停用，不注册 reader 也不入队；守住位置：endpoint 计算与 enqueue 首行守卫；改错故障：无地址却在本地累积，队列打满后全是丢弃却查不到原因
// INV-17 单次导出的硬超时是 3000ms，超时按失败计并计入 trace_export 丢弃；守住位置：exportWithin 与调用处；改错故障：后端挂起时 drain 永久阻塞，队列只进不出，后续样本全被 queue_full 丢弃
// INV-18 详情区间必须闭合才落样，open 区间与 detail_truncated 记录分别计数；守住位置：details 过滤与 truncated 判据；改错故障：未闭合区间被当成已完成耗时，长尾被人为截短
import { createLocalTtftSpans } from "./localTtftSpans.js";
import { LocalTtftExportDedupe } from "./localTtftExportDedupe.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import {
  AggregationTemporality,
  AggregationType,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { LOCAL_TTFT_BUCKETS_MS, localTtftBatchSchema, type LocalTtftBatch } from "@zcode/shared";
import {
  createRendererActionTraceExporter,
  parseRendererActionTraceHeaders,
  validHttpUrl,
} from "./rendererActionTraceExporter.js";

// MAX_QUEUE 取 32 批而不是无界：单批最多数百条记录，32 批足以吸收一次重连风暴，又能把最坏内存钉在可估范围
// [权衡] 上限一旦被顶满说明消费侧已卡住（通常是导出端超时），此时丢弃比继续排队安全，队列长度本身就是背压信号
// 3000ms 的导出超时必须短于 5000ms 的上报周期，否则周期叠加后仍会在上一次未完成时再次发起
// 无 endpoint 时不注册 reader，指标写入本地但不落任何后端；enqueue 首行会因此直接返回
// 把两个常量提到模块顶部，是为了让容量与超时的取舍集中可见，改值时不会漏掉两处使用点
// [失败路径] 超时只影响单次导出而不重启 reader，下一周期仍会重试，避免一次网络抖动形成永久停摆
// 两个数值都以毫秒计，单位不写进变量名而由注释约定，改单位时必须同步 OTEL 的 timeoutMillis
const MAX_QUEUE = 32;
const EXPORT_TIMEOUT_MS = 3000;

/** 只接收已冻结的观测事实；Main 不参与 session/command 状态裁决。 */
export function createLocalTtftExporter(options: {
  env: Record<string, string | undefined>;
  now?: () => number;
  version: string;
  logger: { warn(...args: unknown[]): void };
}) {
  const exporter = createRendererActionTraceExporter(options.env);
  // endpoint 优先取 metrics 专用变量，再回退到通用 OTLP 变量并补 /v1/metrics 路径
  // 只接受 http 或 https 且能被 URL 解析的值；解析失败时整条链路关停，而不是猜一个默认地址
  // 必须先去掉结尾斜杠再拼路径，避免出现双斜杠；拼错时后端返 404，指标静默丢失且本地不留痕迹
  // [隐私] headers 与链路导出必须共用同一套 OTEL_EXPORTER_OTLP_HEADERS 解析，认证令牌只出现在请求头，不进入任何标签
  // metrics 专用 headers 存在时优先，便于把指标与链路发往不同后端
  // [权衡] 复用链路导出器的 headers 解析而不是再写一份，代价是两者耦合：改解析规则会同时影响链路与指标
  // resource 固定 service.name 与 schema_version，使后端能用同一套查询区分版本与协议代际
  const endpoint =
    validHttpUrl(options.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) ??
    validHttpUrl(
      options.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? `${options.env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/metrics`
        : undefined,
    );
  const resource = resourceFromAttributes({
    "service.name": "zcode-local-ttft",
    "service.version": options.version,
    "os.type": process.platform,
    "zcode.telemetry.schema_version": 1,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: endpoint
      ? [
          new PeriodicExportingMetricReader({
            exporter: new OTLPMetricExporter({
              url: endpoint,
              headers: parseRendererActionTraceHeaders(
                options.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS ??
                  options.env.OTEL_EXPORTER_OTLP_HEADERS,
              ),
              temporalityPreference: AggregationTemporality.DELTA,
              timeoutMillis: EXPORT_TIMEOUT_MS,
            }),
            exportIntervalMillis: 5000,
            exportTimeoutMillis: EXPORT_TIMEOUT_MS,
          }),
        ]
      : [],
    views: [
      {
        instrumentName: "zcode.local_ttft.*",
        aggregation: {
          type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
          options: { boundaries: LOCAL_TTFT_BUCKETS_MS },
        },
        // 两条 view 覆盖同一批 zcode.local_ttft 前缀的仪表：直方图走显式桶，计数类仪表不套桶
        // [权衡] 用固定边界而不是指数桶，是为了让不同版本、不同机器的 P95 可横向比较；代价是超界值落进两端桶
        // 边界面来自 shared 包的 LOCAL_TTFT_BUCKETS_MS，渲染进程的判定与后端看板共用同一张表，改边界必须整体发布
        // aggregationCardinalityLimit 256 是硬上限，超出后新标签组合被丢弃，防止自定义模型名撑爆内存
        // instrumentType 必须与创建时的仪表类型一致，否则该仪表不会被这条 view 匹配，边界随之失效
        // [失败路径] view 未命中时仪表按默认聚合导出，桶边界与看板不再对齐，P95 会突然漂移且无从告警
        // DELTA 累积性让每个周期只带增量，去重与周期对齐由导出端负责，后端不需要再做差分
        instrumentType: InstrumentType.HISTOGRAM,
        aggregationCardinalityLimit: 256,
      },
      {
        instrumentName: "zcode.local_ttft.*",
        instrumentType: InstrumentType.COUNTER,
        aggregationCardinalityLimit: 256,
      },
    ],
  });
  const meter = meterProvider.getMeter("@zcode/local-ttft", "1");
  const duration = meter.createHistogram("zcode.local_ttft.duration", { unit: "ms" });
  const stageDuration = meter.createHistogram("zcode.local_ttft.stage.duration", { unit: "ms" });
  const stageObservation = meter.createHistogram("zcode.local_ttft.stage.observation.duration", {
    unit: "ms",
  });
  const preparationObservation = meter.createHistogram(
    "zcode.local_ttft.preparation.observation.duration",
    { unit: "ms" },
  );
  const systemDuration = meter.createHistogram("zcode.local_ttft.system.duration", { unit: "ms" });
  const preparationDuration = meter.createHistogram("zcode.local_ttft.preparation.duration", {
    unit: "ms",
  });
  const attemptDuration = meter.createHistogram("zcode.local_ttft.attempt.duration", {
    unit: "ms",
  });
  const executionDuration = meter.createHistogram("zcode.local_ttft.execution.duration", {
    unit: "ms",
  });
  const failureWait = meter.createHistogram("zcode.local_ttft.no_output.wait", { unit: "ms" });
  const textDuration = meter.createHistogram("zcode.local_ttft.first_text.duration", {
    unit: "ms",
  });
  const outcomes = meter.createCounter("zcode.local_ttft.records");
  const drops = meter.createCounter("zcode.local_ttft.dropped");
  const queue: LocalTtftBatch[] = [];
  // 去重窗口按 Main 的单调时钟推进，窗口内的同一观测只落样一次；now 由外部注入，测试可替换时间源
  // admit 返回的 remember 对 stage 与 detail 同样生效：同一观测的阶段区间重复上报不会摊薄分布
  // modelLabels 是与去重无关的第二道闸，只负责把标签基数压在 16 组以内
  // closed 与 draining 都在闭包外声明供 enqueue 与 shutdown 共享，它们不是线程安全变量，靠 Node 单线程事件循环保证顺序
  // [并发] consume 的循环只在微任务里推进，enqueue 是同步函数，二者不会真正并行，因此队列不需要锁
  // 队列元素是 schema 校验后的批次，consume 内不再做形状检查，避免同一份校验跑两次
  // [权衡] 去重放在 Main 而不是渲染进程：渲染进程每次重连都是新实例，只有 Main 能跨实例看到重复
  const dedupe = new LocalTtftExportDedupe(options.now);
  const modelLabels = new Set<string>();
  let draining: Promise<void> | undefined;
  let closed = false;
  const consume = async () => {
    // [并发] 单消费者循环：draining 未复位前 enqueue 不会启动第二个循环，队列因此可以当单线程结构使用
    // closed 在循环条件里复查：shutdown 可能落在两批之间，此时立刻停手而不是把残量导完
    // shift 出来的批次先把 renderer_capacity 丢弃数计入，再逐条判去重；两类丢弃语义不同，看板上必须分开
    // [失败路径] 循环体内的异常由外层 catch 兜住并计 export_error，该批就此放弃而不重试；重试由渲染进程侧负责
    // 整批处理完才导出一次 span 集合，避免每条记录一次网络往返
    // 批次之间不 await 任何定时器，队列长度即是背压
    // [权衡] 不按批设置单批超时：批内是纯 CPU 计算，唯一的外部等待是链路导出，超时必须已在那一步兜住
    while (queue.length && !closed) {
      const batch = queue.shift()!;
      drops.add(batch.dropped, { reason: "renderer_capacity" });
      const spans: ReadableSpan[] = [];
      for (const record of batch.records) {
        const remember = dedupe.admit(batch.rendererInstanceId, record.observationId, record.start);
        if (!remember) {
          drops.add(1, { reason: "dedupe_window_or_capacity" });
          continue;
        }
        const key = record.observationId;
        const pair = `${record.provider ?? "unknown"}/${record.model ?? "unknown"}`;
        if (modelLabels.size < 16 && /^[a-zA-Z0-9._:/-]{1,128}$/.test(pair)) modelLabels.add(pair);
        // [隐私] 标签必须只允许 provider、model、quality、visibility、send_mode、版本与平台，均为枚举或白名单值
        // provider 与 model 先过 modelLabels 白名单，未登记的组合一律输出 other，原始字符串不外泄
        // 白名单正则限制长度为 128 与有限的字符集，带空格、引号或用户输入的名字无法进入标签
        // 缺省值统一为 unknown、foreground 与 idle，保证后端按标签聚合时不出现空字符串分组
        // app_version 与 os 来自构建期常量与平台名，不含用户名或主机名
        // [失败路径] 标签一旦带上自由文本，时序库的基数会在一天内失控，且已写入的点无法回滚
        // [权衡] 折叠成 other 会损失长尾模型的可观测性，换来的是后端稳定与隐私边界清晰
        const labels = {
          provider: modelLabels.has(pair) ? (record.provider ?? "unknown") : "other",
          model: modelLabels.has(pair) ? (record.model ?? "unknown") : "other",
          quality: record.quality,
          visibility: record.visibility ?? "foreground",
          send_mode: record.sendMode ?? "idle",
          app_version: options.version,
          os: process.platform,
        };
        const firstRecord = remember(`${key}:${record.kind}:${record.checkpointId ?? ""}`);
        if (firstRecord) {
          outcomes.add(1, {
            kind: record.kind,
            outcome: record.outcome,
            quality: record.quality,
            send_mode: labels.send_mode,
            visibility: labels.visibility,
          });
          if (record.truncated) drops.add(1, { reason: "detail_truncated" });
          if (
            // TTFT 的唯一定义：首个输出 token 到达；不含对请求排队时间或用户输入时间的任何补偿
            // 四条判据必须同时成立：kind 为 first_output、outcome 为 success、timingReliable 不为 false、sendMode 不是 guided
            // quality 为 clock_invalid 的记录在这里不能下样，但在上游 outcomes 计数里仍然可见，二者分工不同
            // duration 记录端到端时延，systemDuration 记录扣除用户等待后的系统内耗，两个分布不能互相替代
            // executionMs 由渲染进程直接给出时不再重算，避免跨进程边界再做减法引入时钟误差
            // [权衡] 只用一条 first_output 记录而不从阶段区间拼装，是为了让 TTFT 与用户感知严格对齐
            // [失败路径] 若把 outcome 判据放宽到任意记录，取消与失败的长等待会把 P99 拉到分钟级，指标失去指导意义
            record.kind === "first_output" &&
            record.outcome === "success" &&
            record.timingReliable !== false &&
            record.sendMode !== "guided"
          ) {
            duration.record(record.end - record.start, labels);
            if ((record.userWaitMs ?? 0) <= record.end - record.start)
              systemDuration.record(record.end - record.start - (record.userWaitMs ?? 0), labels);
            if (record.executionMs !== undefined)
              executionDuration.record(record.executionMs, labels);
          }
          if (
            record.kind === "first_text" &&
            record.outcome === "success" &&
            record.timingReliable !== false
          )
            textDuration.record(record.end - record.start, labels);
          if (
            record.kind === "excluded" &&
            ["failed", "cancelled", "rejected", "interrupted"].includes(record.outcome) &&
            record.timingReliable !== false
          )
            failureWait.record(record.end - record.start, { ...labels, outcome: record.outcome });
        }
        const intervals = record.intervals.filter((interval) =>
          remember(`${key}:stage:${interval.stage}`),
        );
        for (const interval of intervals) {
          const reliable =
            interval.source === "cli"
              ? record.cliTimingReliable !== false
              : interval.source === "renderer"
                ? record.timingReliable !== false
                : record.quality !== "clock_invalid";
          if (reliable)
            stageObservation.record(interval.end - interval.start, {
              ...labels,
              stage: interval.stage,
              clock_source: interval.source,
            });
        }
        const details = (record.details ?? []).filter((detail) =>
          remember(`${key}:detail:${detail.id}:${detail.end === undefined ? "open" : "closed"}`),
        );
        for (const detail of details) {
          if (
            detail.end === undefined ||
            (detail.source === "cli"
              ? record.cliTimingReliable === false
              : record.timingReliable === false)
          )
            continue;
          const histogram = detail.stage === "attempt" ? attemptDuration : preparationObservation;
          histogram.record(detail.end - detail.start, {
            ...labels,
            stage: detail.stage,
            role: detail.role ?? "preparation",
            outcome: detail.outcome ?? "completed",
          });
        }
        // 默认体验分布在 Renderer 已确定整条输入的前后台与时钟质量后落样；
        // 累计阶段观察另用 observation instrument，避免先报前台再切后台污染默认分布。
        if (
          (record.kind === "first_output" || record.firstOutputKind) &&
          record.outcome === "success"
        ) {
          for (const interval of record.intervals) {
            if (record.quality === "complete" && remember(`${key}:success-stage:${interval.stage}`))
              stageDuration.record(interval.end - interval.start, {
                ...labels,
                stage: interval.stage,
              });
          }
          for (const detail of record.details ?? []) {
            if (
              detail.stage !== "attempt" &&
              detail.end !== undefined &&
              record.quality === "complete" &&
              remember(`${key}:success-detail:${detail.id}`)
            )
              preparationDuration.record(detail.end - detail.start, {
                ...labels,
                stage: detail.stage,
              });
          }
        }
        spans.push(
          ...createLocalTtftSpans({ ...record, intervals, details }, resource, firstRecord, record),
        );
      }
      // [失败路径] 链路导出失败只降级不重试：本批 span 计入 trace_export 丢弃，指标链路继续前进
      // exportWithin 用 3000ms 定时器兜底，定时器 unref 之后不会单独阻止进程退出
      // 导出回调与超时谁先到谁结算，后到者被 clearTimeout 或布尔短路吞掉，不会重复 resolve
      // 导出器同步抛错同样按失败处理，避免一次坏数据打断整个 drain 循环
      // 丢弃数量按 span 条数计而不是按批计，使丢样率能与实际样本量对齐
      // 告警只带 span 数量不带观测内容，日志本身也不能成为隐私出口
      // [权衡] 宁可丢 span 也不阻塞队列：链路数据的价值低于 TTFT 指标，且后端不可用是常态而非异常
      if (exporter && spans.length && !(await exportWithin(exporter, spans))) {
        drops.add(spans.length, { reason: "trace_export" });
        options.logger.warn("[local-ttft] trace export failed or timed out", {
          spans: spans.length,
        });
      }
    }
  };
  return {
    enqueue(input: unknown): void {
      if (closed || !exporter || !endpoint) return;
      let size: number;
      try {
        size = Buffer.byteLength(JSON.stringify(input));
      } catch {
        return;
      }
      // [失败路径] 体积上限在解析之前判定；先序列化再量长度是唯一能覆盖非 JSON 输入的做法
      // 序列化本身可能抛错（循环引用或不可序列化的值），该异常被就地吞掉并直接返回，不计数也不告警
      // 超限批次计入 oversized；它不属于采样失败，用独立原因区分便于定位是哪个上游在灌数据
      // schema 校验失败计入 invalid 并打印 issues，issues 里的路径能直接指到出错字段
      // 队列满时按 records.length 计丢弃而不是按批，否则一次大风暴的丢弃量会被严重低估
      // enqueue 全程同步且不 await，IPC 消息处理不会被导出节奏拖慢
      // [权衡] 丢弃优先于阻塞发送方：渲染进程的采样线程不能被 Main 的导出节奏反向拖住
      if (size > 256 * 1024) {
        drops.add(1, { reason: "oversized" });
        return;
      }
      const parsed = localTtftBatchSchema.safeParse(input);
      if (!parsed.success) {
        drops.add(1, { reason: "invalid" });
        options.logger.warn("[local-ttft] rejected invalid batch", { issues: parsed.error.issues });
        return;
      }
      if (queue.length >= MAX_QUEUE) {
        drops.add(parsed.data.records.length, { reason: "queue_full" });
        return;
      }
      queue.push(parsed.data);
      draining ??= Promise.resolve()
        .then(consume)
        .catch(() => {
          drops.add(1, { reason: "export_error" });
        })
        .finally(() => {
          draining = undefined;
        });
    },
    async shutdown(): Promise<void> {
      // [资源] shutdown 顺序固定：先置 closed 截断新入口，再清空队列，最后并行关闭 meter 与导出器
      // 清空队列等于放弃未导出的批次，这些样本不补计数；退出路径上的统计不追求完整
      // 关闭 meter 时会做最后一次 flush，必须发生在 closed 置位之后，否则 flush 期间新样本还能进来
      // 导出器可能因无 endpoint 而未创建，全部用 allSettled 包住，任一失败都不阻塞退出
      // [权衡] 用 allSettled 而非 all：关闭阶段的异常没有处理意义，卡住进程退出才是真正事故
      // shutdown 不等待 draining 结束：正在跑的导出会被自身的 3000ms 超时截断
      closed = true;
      queue.length = 0;
      await Promise.allSettled([meterProvider.shutdown(), exporter?.shutdown()]);
    },
  };
}

function exportWithin(exporter: SpanExporter, spans: ReadableSpan[]): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), EXPORT_TIMEOUT_MS);
    timer.unref();
    try {
      exporter.export(spans, (result) => {
        clearTimeout(timer);
        resolve(result.code === 0);
      });
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}
