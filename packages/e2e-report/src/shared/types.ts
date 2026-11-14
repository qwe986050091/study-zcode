// INV-01 数值统计四件套固定：守住位置 接口字段；改错故障 图表缺分位数无法渲染。
// INV-02 采样计数单列：守住位置 采样数字段；改错故障 均值失真时无法判断样本量。
// INV-03 时间戳为字符串：守住位置 字符串类型；改错故障 跨时区解析出现偏差。
// INV-04 失败原因可缺省：守住位置 可选字段；改错故障 通过用例被写入空错误。
// INV-05 结果标题双层保留：守住位置 两级标题；改错故障 汇总只剩最后一级。
// INV-06 通过状态用布尔：守住位置 布尔字段；改错故障 汇总统计依赖文本匹配。
// INV-07 进程按类型分组：守住位置 映射字段；改错故障 多进程数据混成一条曲线。
// INV-08 容器指标逐项同构：守住位置 统一统计类型；改错故障 面板列宽抖动。
// INV-09 覆盖率三项分开存：守住位置 覆盖数、总数与百分比；改错故障 精度丢失。
// INV-10 跳过数单独记录：守住位置 跳过字段；改错故障 分母被跳过项污染。
// INV-11 未覆盖行用数组：守住位置 数字数组；改错故障 高亮区间合并出错。
// INV-12 文件路径双份：守住位置 绝对与相对；改错故障 报告换机器后打不开。
// INV-13 报告产物路径集中：守住位置 文件映射；改错故障 查看器找不到资源。
// INV-14 可选产物不占位：守住位置 可选字段；改错故障 缺失产物显示空链接。
// INV-15 覆盖率可整体缺失：守住位置 可选容器；改错故障 未开启覆盖率时报告报错。
// INV-16 性能分组可选：守住位置 可选字段；改错故障 无容器运行时图表空白。
// INV-17 环境信息随报告：守住位置 环境对象；改错故障 不同机器结果无法比较。
// INV-18 运行标识与时间齐备：守住位置 运行标识与起止时间；改错故障 多次运行互相覆盖。
//
// 模块职责：E2E 报告在主进程、渲染层与查看器之间共享的数据形状。
// 状态所有权：纯类型声明，不含运行期状态与副作用。
// 阅读顺序：先看基础统计与用例结果，再看覆盖率，最后看报告汇总与环境。
export interface NumericStats {
  mean: number;
  peak: number;
  p95: number;
  sampleCount: number;
}

// 单条用例的稳定快照：title 与 fullTitle 两级都保留；passed 由布尔字段给结论，status 存原始文本；file/error 允许缺省。
export interface TestResultSummary {
  capturedAt: string;
  durationMs: number;
  error?: string;
  file?: string;
  fullTitle: string;
  passed: boolean;
  status: string;
  title: string;
}

// 逐进程按类型分组后每组各存 CPU 与内存统计；总量与文件清单另存一份，供曲线与归因共用。
export interface ProcessSampleSummary {
  byType: Record<
    string,
    {
      cpuPercent: NumericStats;
      memoryWorkingSetMb: NumericStats;
    }
  >;
  cpuTotalPercent: NumericStats;
  files: string[];
  memoryWorkingSetMb: NumericStats;
  sampleCount: number;
}

export interface ContainerSampleSummary {
  blockReadMb: NumericStats;
  blockWriteMb: NumericStats;
  cpuPercent: NumericStats;
  file: string;
  memoryPercent: NumericStats;
  memoryUsageMb: NumericStats;
  networkRxMb: NumericStats;
  networkTxMb: NumericStats;
  pids: NumericStats;
  sampleCount: number;
}

export interface ScriptCoverageSummary {
  coveredBytes: number;
  entryCount: number;
  percent: number;
  totalBytes: number;
  url: string;
}

export interface CoverageMetricSummary {
  covered: number;
  pct: number;
  skipped: number;
  total: number;
}

export interface SourceFileCoverageSummary {
  branches: CoverageMetricSummary;
  functions: CoverageMetricSummary;
  lines: CoverageMetricSummary;
  path: string;
  relativePath: string;
  statements: CoverageMetricSummary;
  uncoveredLines: number[];
}

// enabled 由覆盖率采集结果决定是否渲染；产物路径除 markdown/raw/summaryJson 外都可缺省，页面数与条目数分开统计。
export interface UIRendererCoverageSummary {
  capturedAt: string;
  complete?: boolean;
  enabled: boolean;
  files: {
    coverageFinalJson?: string;
    coverageSummaryJson?: string;
    htmlIndex?: string;
    lcov?: string;
    markdown: string;
    raw: string;
    rawDir?: string;
    summaryJson: string;
  };
  pageCount: number;
  rawEntryCount: number;
  rawFileCount?: number;
  reportKind?: "istanbul-instrumented" | "istanbul-source";
  rendererEntryCount: number;
  scripts: ScriptCoverageSummary[];
  sourceFileCount?: number;
  sourceFiles?: SourceFileCoverageSummary[];
  totals: {
    branches?: CoverageMetricSummary;
    coveredBytes: number;
    functions?: CoverageMetricSummary;
    lines?: CoverageMetricSummary;
    percent: number;
    statements?: CoverageMetricSummary;
    totalBytes: number;
  };
}

// 查看器入口快照：artifactDir 由产物根决定，运行标识与起止时间成对写入；覆盖率与性能两块可整体缺失。
export interface E2EReportSummary {
  artifactDir: string;
  completedAt: string;
  containerE2E: boolean;
  durationMs: number;
  environment: {
    arch: string;
    cpuModel: string;
    node: string;
    platform: string;
    totalMemoryBytes: number;
  };
  exitCode: number;
  files: {
    containerSamples: string;
    coverageHeatmap?: string;
    manifest: string;
    processSamplesGlob: string;
    summaryJson: string;
    summaryMd: string;
    tests: string;
    uiRendererCoverage?: string;
    viewerUrl?: string;
  };
  coverage?: {
    uiRenderer?: UIRendererCoverageSummary;
  };
  performance: {
    containerSamples?: ContainerSampleSummary;
    processSamples?: ProcessSampleSummary;
  };
  requestedSpecs: string[];
  runId: string;
  startedAt: string;
  tests: {
    failed: number;
    passed: number;
    results: TestResultSummary[];
    total: number;
  };
}

export interface CreateE2EReportViewerUrlOptions {
  baseUrl?: string;
  summaryJsonPath: string;
}
