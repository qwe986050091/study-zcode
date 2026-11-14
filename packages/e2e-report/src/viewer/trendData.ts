// 本模块是 E2E 报告 viewer 的趋势数据装配层：从 summary.json 指向的 NDJSON 采样产物里
// 读出进程指标与容器 stats，折算成容器 CPU/内存、进程总量与按 type 拆分后的多序列折线数据。
// 不负责：不解析 summary 结构与校验其版本、不做图表渲染与坐标轴刻度、不做跨 run 聚合；
// 采样文件缺失或损坏时只降级为空序列，绝不抛错中断整页报告渲染。
//
// INV-01 断言：两个候选路径按「summary 同级 perf 目录优先、绝对产物路径兜底」的顺序尝试 —— 守住它的位置：buildArtifactCandidates —— 改错故障：顺序颠倒会先请求宿主机不存在的 /workspace 绝对路径，首屏多一次必然失败的请求且拖慢渲染。
// INV-02 断言：候选列表里为空的项必须在请求前被过滤掉 —— 守住它的位置：buildArtifactCandidates 末尾的 filter —— 改错故障：fetch(null) 会抛 TypeError 并冒泡成未捕获异常，整块趋势图空白。
// INV-03 断言：每个候选 URL 只请求一次，去重后按序回退 —— 守住它的位置：fetchTextFromCandidates 里的 unique —— 改错故障：重复候选会重复请求同一文件，日志重复且弱网下等待时间翻倍。
// INV-04 断言：单次 fetch 抛错或非 2xx 时继续尝试下一个候选，最终返回 null —— 守住它的位置：fetchTextFromCandidates 的 try/catch 与循环 —— 改错故障：一旦改成直接 return 或 rethrow，宿主机查看容器产物时趋势图整体消失而不是空图。
// INV-05 断言：无论采样是否成功，loadPerformanceTrends 必须返回四个键齐全的对象 —— 守住它的位置：loadPerformanceTrends 的 return 字面量 —— 改错故障：viewer 读取 containerCpu[0] 时抛错，整个报告路由白屏。
// INV-06 断言：进程采样与容器采样必须并发拉取 —— 守住它的位置：loadPerformanceTrends 里的 Promise.all —— 改错故障：串行 await 使两条链路耗时相加，大文件下首屏明显变慢。
// INV-07 断言：时间轴起点优先取 summary.startedAt，其次取最早可用采样时间，全不可解析时为 0 —— 守住它的位置：resolveRunStartTime 的候选顺序 —— 改错故障：改用首个采样点会让首点横坐标不为 0，与报告头部展示的耗时对不上。
// INV-08 断言：采样行必须先按 capturedAt 升序排序再计算耗时 —— 守住它的位置：toProcessTrendRows 与 toContainerTrendRows 的 sort —— 改错故障：乱序 NDJSON 会画出回折折线，并让部分点耗时被 Math.max 压成 0。
// INV-09 断言：没有 capturedAt 的行在排序前就被剔除 —— 守住它的位置：两个 toTrendRows 的类型谓词 filter —— 改错故障：Date.parse(undefined) 得到 NaN，比较器返回 NaN 导致排序结果不确定。
// INV-10 断言：耗时分秒必须单调不为负，且非法时间解析为 0 —— 守住它的位置：elapsedSeconds —— 改错故障：采样时钟回拨会画出负横坐标，图表 X 轴出现左侧空白区。
// INV-11 断言：CPU 与内存缺失值一律按 0 计，不产生 NaN —— 守住它的位置：toFiniteNumber 与 roundMetric —— 改错故障：NaN 进入 SVG path 会让整条折线消失，且不报任何错误。
// INV-12 断言：容器内存取 MemUsage 斜杠前的已用量而非 limit —— 守住它的位置：parseBytePair 解构的第一项 —— 改错故障：误取 limit 会把内存图画成一条不随负载变化的水平线。
// INV-13 断言：docker 的 1000 进制单位与 1024 进制单位必须分别换算 —— 守住它的位置：parseBytes 的 multipliers 表 —— 改错故障：把 kB 当 KiB 会让内存值系统性偏小约 2.3%，长期趋势对比结论失真。
// INV-14 断言：进程序列颜色从索引 1 开始，索引 0 固定留给 Total —— 守住它的位置：buildProcessSeries 中 processColorAt 的入参偏移 —— 改错故障：Total 与首个 type 同色，图例无法区分两条线。
// INV-15 断言：颜色取值必须对色板长度取模，越界回退到蓝色 —— 守住它的位置：processColorAt —— 改错故障：type 超过六种时得到 undefined 色值，折线透明不可见。
// INV-16 断言：同一 type 的多条 metric 必须累加而非覆盖 —— 守住它的位置：toProcessTrendRows 里 Map 的 get 兜底 0 再累加 —— 改错故障：多进程同类场景只剩最后一条，内存曲线整体偏低一个数量级。
// INV-17 断言：NDJSON 中无法解析的单行只能跳过，不得中断整文件 —— 守住它的位置：parseNdjson 的 flatMap 内 try/catch —— 改错故障：尾部半行日志会让整段采样全部丢弃，趋势图出现空窗。
// INV-18 断言：metric 的 type 缺失时统一归入 unknown 桶而不是丢弃 —— 守住它的位置：toProcessTrendRows 里 metric.type 的默认值 —— 改错故障：未标注类型的采样从图表消失，总量与分项之和不再相等。
//
// 单位口径：进程内存源数据为 KB、容器内存为带单位字符串，最终统一折算成 MB 输出。
// 降级口径：任一数据源为空时对应系列仍然存在但 points 为空，由渲染层决定显示空态。
//
// 修改提示：新增字段时同步 TrendPoint 与 TrendSeries，别在 toSeries 里做隐式单位换算。
// 修改提示：候选路径与时间基准是本文件唯二的外部契约，改动前先确认旧产物仍能读。
// 修改提示：所有解析函数对坏输入返回 0 而不是抛错，新增分支请沿用同一约定。
import type { E2EReportSummary } from "../shared/types.js";

// 字节与 KB 两个换算常量分开定义，避免在热路径里重复做除法
// [契约] 容器 stats 的 MemUsage 是字节，进程指标的 memoryWorkingSetKb 是 KB，两处除法系数不同，不可互换
// 把 KILOBYTES_PER_MB 改成 1000 会让进程内存整体偏大 2.4%，与容器内存曲线口径不一致
const BYTES_PER_MB = 1024 * 1024;
const KILOBYTES_PER_MB = 1024;

export interface TrendPoint {
  capturedAt: string;
  elapsedSeconds: number;
  label: string;
  value: number;
}

// [契约] series 的 label 会直接进图例，改动即改变导出文件名与快照对比结果
// color 存的是 CSS 变量名而非具体色值，深浅色主题下由样式层解析，不要在此写死十六进制
export interface TrendSeries {
  color: string;
  label: string;
  points: TrendPoint[];
  unit: string;
}

export interface PerformanceTrends {
  containerCpu: TrendSeries[];
  containerMemory: TrendSeries[];
  processCpu: TrendSeries[];
  processMemory: TrendSeries[];
}

// 采样文件是 NDJSON，每行一条快照，字段全部可选：解析时任何一项缺失都必须能继续
// [权衡] 这里只声明用到的字段而不复用协议类型，是为了让 viewer 能读旧版产物而不挑版本
// capturedAt 是 ISO 字符串，直接交给 Date.parse；不要改成数字时间戳，旧产物会整体变 NaN
interface ProcessSampleLine {
  capturedAt?: string;
  metrics?: Array<{
    cpuPercent?: number;
    memoryWorkingSetKb?: number;
    type?: string;
  }>;
}

interface ContainerSampleLine {
  capturedAt?: string;
  stats?: {
    BlockIO?: string;
    CPUPerc?: string;
    MemUsage?: string;
    NetIO?: string;
  };
}

interface ProcessTrendRow {
  capturedAt: string;
  cpuByType: Map<string, number>;
  elapsedSeconds: number;
  label: string;
  memoryByType: Map<string, number>;
  totalCpu: number;
  totalMemoryMb: number;
}

// 进程分项配色表：索引 0 留给 Total，其余按 type 名字典序依次分配
// [契约] 这六个变量名必须与主题样式表里的定义同名，写错时折线取不到颜色而退化为透明
// 色板长度即最大可区分曲线数，超出的 type 会循环复用颜色，图例上出现同色多条线属于预期
const PROCESS_COLORS = [
  "var(--chart-blue)",
  "var(--chart-amber)",
  "var(--chart-green)",
  "var(--chart-purple)",
  "var(--chart-red)",
  "var(--chart-cyan)",
];

export async function loadPerformanceTrends(
  summary: E2EReportSummary,
  summaryUrl: string,
): Promise<PerformanceTrends> {
  // [并发] 两路拉取互不依赖，必须并行；写成两个 await 会让总耗时从最大值变成求和
  // Promise.all 在此是安全的：loadProcessSamples 与 loadContainerSamples 内部已把失败吞成空数组
  // 若未来给任一分支加 throw，这里会整体 reject，而 loadPerformanceTrends 的调用方没有兜底
  const [processLines, containerLines] = await Promise.all([
    loadProcessSamples(summary, summaryUrl),
    loadContainerSamples(summary, summaryUrl),
  ]);

  // [契约] 时间基准必须在两次换算前一次性确定，两个 toTrendRows 各算一次会出现横轴错位
  // 首次调用时 summary 可能没有 startedAt，此处允许回退到采样时间，属于预期降级
  const runStartTime = resolveRunStartTime(summary, processLines, containerLines);
  const processRows = toProcessTrendRows(processLines, runStartTime);
  const containerRows = toContainerTrendRows(containerLines, runStartTime);
  return {
    // [契约] 容器维度固定只有一条系列，颜色与单位写死，不像进程那样按 type 拆分
    // 键名 containerCpu 与 containerMemory 及 processCpu 与 processMemory 是 viewer 的读取契约，不可改名
    containerCpu: [
      toSeries(
        "Container",
        "%",
        "var(--chart-cyan)",
        containerRows,
        (row) => row.cpuPercent,
      ),
    ],
    containerMemory: [
      toSeries(
        "Container Memory",
        "MB",
        "var(--chart-green)",
        containerRows,
        (row) => row.memoryUsageMb,
      ),
    ],
    processCpu: buildProcessSeries(processRows, "cpu"),
    processMemory: buildProcessSeries(processRows, "memory"),
  };
}

// [契约] 进程采样是文件数组，任一文件缺失只影响自己的点，不能让其他文件一起丢
// 候选相对路径固定落到 summary 同级的 perf 目录，文件名只取 basename，不带源目录层级
// files 为 undefined 时返回空数组，调用方据此绘制空态而不是报错
async function loadProcessSamples(summary: E2EReportSummary, summaryUrl: string) {
  const files = summary.performance.processSamples?.files ?? [];
  const texts = await Promise.all(
    files.map((file) =>
      fetchTextFromCandidates(
        buildArtifactCandidates(summaryUrl, file, `./perf/${basename(file)}`),
      ),
    ),
  );
  return texts.flatMap((text) => parseNdjson<ProcessSampleLine>(text ?? ""));
}

// 容器采样只有一个文件，取不到时返回空数组，与进程路径保持同样的降级语义
// [契约] summary 里的 containerSamples 可能为空字符串，仍会走候选拼装并被请求失败兜住
async function loadContainerSamples(summary: E2EReportSummary, summaryUrl: string) {
  const file = summary.files.containerSamples;
  const text = await fetchTextFromCandidates(
    buildArtifactCandidates(summaryUrl, file, `./perf/${basename(file)}`),
  );
  return parseNdjson<ContainerSampleLine>(text ?? "");
}

// [契约] 先 filter 再 sort：排序器拿到的每个元素都保证有可解析的 capturedAt
// 排序用 Date.parse 差值，稳定排序保证同一毫秒的采样维持文件原始顺序
// firstTime 由外部传入而不是在此推断，保证进程与容器共用同一条时间轴
function toProcessTrendRows(lines: ProcessSampleLine[], firstTime: number) {
  const rows = lines
    .filter((line): line is ProcessSampleLine & { capturedAt: string } =>
      Boolean(line.capturedAt),
    )
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  return rows.map((line) => {
    const cpuByType = new Map<string, number>();
    const memoryByType = new Map<string, number>();
    let totalCpu = 0;
    let totalMemoryMb = 0;
    for (const metric of line.metrics ?? []) {
      // [契约] type 为空串或缺失统一归入 unknown，而不是跳过该条 metric
      // 归桶保证总量等于各分项之和这条恒等式始终成立，图例条数与数据一致
      // 改成过滤掉无 type 项会让总量与分项对不上，用户会看到分项之和小于 Total
      const type = metric.type || "unknown";
      const cpu = toFiniteNumber(metric.cpuPercent);
      const memoryMb = toFiniteNumber(metric.memoryWorkingSetKb) / KILOBYTES_PER_MB;
      totalCpu += cpu;
      totalMemoryMb += memoryMb;
      // [契约] 同 type 多条 metric 必须累加：一个 type 下可能有多个进程实例
      // 初次出现时 get 返回 undefined，用 0 兜底；漏掉兜底会拼出 NaN 并传染整条曲线
      // 内存同理，两边累加口径保持一致，否则 CPU 图与内存图的 type 数量会对不上
      cpuByType.set(type, (cpuByType.get(type) ?? 0) + cpu);
      memoryByType.set(type, (memoryByType.get(type) ?? 0) + memoryMb);
    }
    return {
      capturedAt: line.capturedAt,
      cpuByType,
      elapsedSeconds: elapsedSeconds(firstTime, line.capturedAt),
      label: elapsedLabel(firstTime, line.capturedAt),
      memoryByType,
      totalCpu,
      totalMemoryMb,
    };
  });
}

// 容器行只取 CPUPerc 与 MemUsage，BlockIO 与 NetIO 尚未进入趋势图，属预留字段
// [契约] 排序与过滤规则必须与进程行完全一致，否则两张图横轴刻度会错开
function toContainerTrendRows(lines: ContainerSampleLine[], firstTime: number) {
  const rows = lines
    .filter((line): line is ContainerSampleLine & { capturedAt: string } =>
      Boolean(line.capturedAt),
    )
    .sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
  return rows.map((line) => {
    const stats = line.stats ?? {};
    // [契约] MemUsage 形如 12.3MiB 斜杠 1GiB，解构第一项是用量，第二项是上限，不能取反
    // stats 缺失时用空对象兜底，parseBytePair 再对 undefined 返回 0，两级兜底缺一不可
    // 上限值当前不参与绘图，但解析函数仍成对返回，便于后续加利用率曲线
    const [memoryUsageBytes] = parseBytePair(stats.MemUsage);
    return {
      capturedAt: line.capturedAt,
      cpuPercent: parsePercent(stats.CPUPerc),
      elapsedSeconds: elapsedSeconds(firstTime, line.capturedAt),
      label: elapsedLabel(firstTime, line.capturedAt),
      memoryUsageMb: memoryUsageBytes / BYTES_PER_MB,
    };
  });
}

// [契约] type 名集合按字典序排序，保证同一份数据每次渲染的图例顺序与配色稳定
// 集合从所有行并集出来而非取首行，中途才出现的 type 也要有完整序列
// [权衡] 缺失点补 0 而不是断线：进程重启造成的空档会被画成掉零，这是当前可接受的失真
function buildProcessSeries(rows: ProcessTrendRow[], metric: "cpu" | "memory") {
  const typeNames = [
    ...new Set(
      rows.flatMap((row) =>
        [...(metric === "cpu" ? row.cpuByType : row.memoryByType).keys()],
      ),
    ),
  ].sort();
  const unit = metric === "cpu" ? "%" : "MB";
  const totalSeries = toSeries(
    "Total",
    unit,
    processColorAt(0),
    rows,
    (row) => (metric === "cpu" ? row.totalCpu : row.totalMemoryMb),
  );
  const typeSeries = typeNames.map((type, index) =>
    toSeries(
      type,
      unit,
      processColorAt(index + 1),
      rows,
      (row) =>
        (metric === "cpu" ? row.cpuByType : row.memoryByType).get(type) ?? 0,
    ),
  );
  // [契约] 返回值首元素恒为 Total，viewer 依赖该位置做总量高亮
  // 分项颜色从索引 1 起分配，避免与 Total 撞色；调整顺序会改变既有快照
  // 分项数量为 0 时仍返回只含 Total 的数组，不要返回空数组
  return [totalSeries, ...typeSeries];
}

// 取模保证任意 type 数量都能拿到颜色；色板为空时回退蓝色，防止 undefined 进入 SVG
// 索引由调用方保证语义（0 为 Total），此处只做边界收敛
function processColorAt(index: number) {
  return PROCESS_COLORS[index % PROCESS_COLORS.length] ?? "var(--chart-blue)";
}

// [契约] 所有系列共用同一 rows，points 与 rows 一一对应，长度必须相等
// value 在出口处才做两位小数取整，中间过程保留精度以免累加误差扩散
function toSeries<
  T extends { capturedAt: string; elapsedSeconds: number; label: string },
>(
  label: string,
  unit: string,
  color: string,
  rows: T[],
  readValue: (row: T) => number,
): TrendSeries {
  return {
    color,
    label,
    points: rows.map((row) => ({
      capturedAt: row.capturedAt,
      elapsedSeconds: row.elapsedSeconds,
      label: row.label,
      value: roundMetric(readValue(row)),
    })),
    unit,
  };
}

// [契约] 候选顺序固定：先 summary 同级相对路径，再产物里的绝对路径
// 相对路径优先是因为宿主机查看报告时容器内的 /workspace 绝对路径必然不存在
// 两个候选都拼不出时返回空数组，交由 unique 与请求循环自然跳过，不在此抛错
function buildArtifactCandidates(
  summaryUrl: string,
  artifactPath: string | undefined,
  relativeToSummary: string,
) {
  return [
    resolveRelativeToSummary(summaryUrl, relativeToSummary),
    artifactPath ? toViteFsUrl(artifactPath) : null,
  ].filter((url): url is string => Boolean(url));
}

// [失败路径] 网络错误、非 2xx、跨域失败都视为该候选不可用，静默换下一个
// 全部候选失败返回 null，调用方用空串兜底，绝不向上一层层抛异常
// [资源] 响应体在此一次读完即释放；不要保留 response 引用，采样文件可能很大
async function fetchTextFromCandidates(candidates: string[]) {
  for (const url of unique(candidates)) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.text();
      }
    } catch {
      // 读趋势数据允许 fallback：容器产物里的 /workspace 路径在宿主机查看时
      // 不存在，需要回退到 summary.json 旁边的 perf 目录。
    }
  }
  return null;
}

function resolveRelativeToSummary(summaryUrl: string, relativePath: string) {
  return new URL(relativePath, new URL(summaryUrl, window.location.href)).toString();
}

// [契约] Vite 开发与预览服务器只允许通过 /@fs/ 前缀读取工作区外的绝对路径
// 已带 /@fs/ 前缀的路径原样拼接，重复加前缀会得到嵌套前缀的 404
// Windows 盘符路径先统一反斜杠再补前缀，否则 URL 解析会把盘符当成协议名
// 相对路径在此返回 null，交由上一级候选（summary 同级路径）处理，不要猜基准目录
function toViteFsUrl(rawPath: string) {
  const normalized = rawPath.replace(/\\/gu, "/");
  if (normalized.startsWith("/@fs/")) {
    return new URL(normalized, window.location.origin).toString();
  }
  if (normalized.startsWith("/")) {
    return new URL(`/@fs${normalized}`, window.location.origin).toString();
  }
  if (/^[a-zA-Z]:\//u.test(normalized)) {
    return new URL(`/@fs/${normalized}`, window.location.origin).toString();
  }
  return null;
}

// [失败路径] 逐行解析，单行 JSON 损坏只丢弃该行，粒度控制在行级
// 空行与纯空白行先过滤，避免 JSON.parse 抛错走到 catch 里做无用功
// flatMap 用单元素数组或空数组表达保留与丢弃，比 filter 加 map 少一次遍历
function parseNdjson<T>(text: string) {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

// docker 的 CPUPerc 形如 12.34% 的字符串，只去掉百分号，不做 0 到 100 截断
// 多核场景下该值可超过 100，属于 docker 原生语义，不要在此归一化
function parsePercent(value: string | undefined) {
  return toFiniteNumber(value?.replace("%", ""));
}

function parseBytePair(value: string | undefined): [number, number] {
  const parts = (value ?? "").split("/");
  return [parseBytes(parts[0]), parseBytes(parts[1])];
}

// [契约] 只接受数字加可选单位的紧凑格式，带空格说明或其他修饰一律判为无效返回 0
// 单位大小写不敏感，但 kB 与 MB 同 KiB 与 MiB 语义不同，必须分开映射
// [权衡] 无法识别的单位按 1 处理而非 0，避免个别异常值把整条内存曲线拉平
// 非法输入返回 0 会让图表出现掉零点，这是刻意选择：宁可少一个点也不抛错
function parseBytes(value: string | undefined) {
  const match = value?.trim().match(/^([\d.]+)\s*([kmgt]?i?b)?$/iu);
  if (!match) {
    return 0;
  }
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return 0;
  }
  const unit = (match[2] ?? "B").toLowerCase();
  const multipliers: Record<string, number> = {
    b: 1,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
  };
  return amount * (multipliers[unit] ?? 1);
}

// [契约] 基准时间优先级：summary.startedAt、首个进程采样、首个容器采样
// 三级回退是为了兼容早期产物：老 summary 没有 startedAt，只能靠采样时间推断
// 每个候选都要 Date.parse 后校验有限性，空串会得到 NaN 而必须被跳过
// 全部失败返回 0，此时横轴变成 Unix 纪元起的绝对秒数，仅用于兜底不崩
function resolveRunStartTime(
  summary: E2EReportSummary,
  processLines: ProcessSampleLine[],
  containerLines: ContainerSampleLine[],
) {
  const candidates = [
    summary.startedAt,
    processLines.find((line) => line.capturedAt)?.capturedAt,
    containerLines.find((line) => line.capturedAt)?.capturedAt,
  ];
  for (const candidate of candidates) {
    const time = Date.parse(candidate ?? "");
    if (Number.isFinite(time)) {
      return time;
    }
  }
  return 0;
}

// [契约] 用 Math.max 夹住负值：采样时钟早于基准时按 0 计
// Date.parse 失败得到 NaN，Math.max 对它仍是 NaN，所以必须显式做有限性判断
// 返回整秒而非毫秒，坐标轴与图例文案都依赖这个粒度，改小会让标签过长
function elapsedSeconds(firstTime: number, capturedAt: string) {
  const elapsedMs = Math.max(0, Date.parse(capturedAt) - firstTime);
  if (!Number.isFinite(elapsedMs)) {
    return 0;
  }
  return Math.round(elapsedMs / 1000);
}

function elapsedLabel(firstTime: number, capturedAt: string) {
  const seconds = elapsedSeconds(firstTime, capturedAt);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function basename(path: string) {
  return path.replace(/\\/gu, "/").split("/").at(-1) ?? path;
}

function roundMetric(value: number) {
  return Math.round(toFiniteNumber(value) * 100) / 100;
}

function toFiniteNumber(value: number | string | undefined) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function unique(values: string[]) {
  return [...new Set(values)];
}
