// E2E 报告查看器根组件，负责加载摘要、聚合趋势并选择渲染视图。
// 数据只从 reportData 与 trendData 进入，面板一律向下传参，不二次请求。
// 本文件不含写操作，所有输出都是已加载快照的纯投影。
// 视图切换由状态分支完成，不依赖路由，也不回写 URL。
// INV-01 报告只在挂载时加载一次，空依赖锁定生命周期；守住位置：App 的 useEffect 依赖数组；改错故障：依赖抖动会重复请求摘要并让加载屏反复闪烁。
// INV-02 摘要必选而趋势可选，二者合并在同一状态对象；守住位置：ReportState 结构；改错故障：把趋势提为必填会让单个接口失败拖垮整页渲染。
// INV-03 摘要是致命错误、趋势是可降级错误，两层 catch 各管一档；守住位置：App 内层与外层 catch；改错故障：趋势异常被当致命错误时用户看不到已加载成功的摘要。
// INV-04 错误态优先于加载态判定；守住位置：App 的返回分支顺序；改错故障：顺序颠倒会让失败提示被加载屏永久覆盖。
// INV-05 状态对象为 null 只表示加载中，不表示空数据；守住位置：!report 分支；改错故障：把 null 当空报告会误显示“无测试结果”。
// INV-06 失败徽标取退出码非零与用例失败数的并集；守住位置：ReportView 的 failed 派生；改错故障：只看退出码会漏标“用例失败但进程正常退出”的运行。
// INV-07 覆盖率是可选子对象，缺失按 disabled 展示；守住位置：uiCoverage 派生；改错故障：无条件读取 totals 会在未开启覆盖率时抛错白屏。
// INV-08 覆盖率卡片的来源计数缺失时回落到 renderer 脚本数；守住位置：UI 覆盖率卡片 detail 分支；改错故障：字段混用会把脚本数标成源文件数。
// INV-09 覆盖率百分比优先取行覆盖率再回落总百分比；守住位置：UI 覆盖率卡片 value 取值顺序；改错故障：顺序颠倒会显示比实际更乐观的数字。
// INV-10 统计值缺失一律显示 n/a 而非 0；守住位置：statsValue 的空值短路；改错故障：显示 0 会让“未采样”被读成“零消耗”。
// INV-11 采样条数提示与实际图表来自同一条采样记录；守住位置：sampleHint 入参；改错故障：两处取不同字段时用户对不上图表样本数。
// INV-12 容器指标文案随 containerE2E 切换；守住位置：容器块写入卡片 detail；改错故障：非容器运行标注 docker stats 会把排障引向错误方向。
// INV-13 测试表格在零结果时注入合成占位行；守住位置：TestsPanel 的长度三元；改错故障：空数组直接渲染会得到没有数据行的裸表格。
// INV-14 占位行恒为通过且状态 unknown，不参与失败聚合；守住位置：emptyResult 返回值；改错故障：占位行标失败会让空报告被判定为 FAILED。
// INV-15 表格行 key 由完整标题与采集时间拼接；守住位置：结果行 key；改错故障：重名用例重跑后复用旧节点，行内数据错位。
// INV-16 Spec 列表为空时给出全量配置兜底文案；守住位置：specRows 三元；改错故障：空数组渲染零行，用户无法确认本次运行范围。
// INV-17 产物面板中 viewer URL 允许回落到当前地址；守住位置：artifactRows 首行；改错故障：摘要缺字段时链接为空，报告无法自引用。
// INV-18 环境面板的字节数统一走 formatBytes，不在模板拼单位；守住位置：environmentRows 内存行；改错故障：手拼单位会让同一面板出现 B 与 MB 混排。
// INV-19 趋势与覆盖率面板的数据只从 report 单向下传；守住位置：TrendPanels 与 CoveragePanel 的 props；改错故障：面板自取数据会与摘要版本错位，图表与指标对不上。
import {
  ActivityIcon,
  CheckCircle2Icon,
  ClockIcon,
  CpuIcon,
  GaugeIcon,
  HardDriveIcon,
  MemoryStickIcon,
  XCircleIcon,
// [资源] 图标按需具名导入，未被引用的导出会被打包器裁掉。
// [权衡] 统一走图标组件而非内联 SVG，牺牲少量节点换取风格一致。
} from "lucide-react";
// [事务] 视图切换不引入路由库，App 单点根据 report 与 error 选择界面。
// [权衡] 放弃可收藏的深链，换取静态托管下的零配置启动。
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type {
  E2EReportSummary,
  TestResultSummary,
} from "../shared/types.js";
import { TrendPanels } from "./ChartPanels.js";
import { CoveragePanel } from "./CoveragePanel.js";
import {
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
} from "./format.js";
// [资源] 摘要加载细节封装在 reportData，App 只消费结果与异常。
// [权衡] 首屏一次性读全量摘要，牺牲大报告首屏延迟换取面板零请求。
import { loadReportSummary } from "./reportData.js";
// [事务] 趋势加载以摘要为输入，保证趋势与摘要出自同一份快照。
// [失败路径] 趋势链路异常由 App 内层处理，不得上抛成整页失败。
import { loadPerformanceTrends } from "./trendData.js";
import type { PerformanceTrends } from "./trendData.js";

// [事务] ReportState 是加载结果的唯一载体，子组件不得另存副本。
// [权衡] 摘要与趋势合并成一个状态，牺牲类型粒度换取提交的原子性。
// [并发] 拆成两个 state 会让界面出现摘要已到、趋势未到的中间态。
interface ReportState {
  summary: E2EReportSummary;
  trends: PerformanceTrends | null;
  trendError: string | null;
}

// [事务] App 只做编排，渲染细节全部下沉到 ReportView 与 StateScreen。
// [资源] 组件卸载后的写入由 React 忽略，effect 内不再额外加取消标记。
export function App() {
  const [report, setReport] = useState<ReportState | null>(null);
  // [失败路径] error 非空即整体终止渲染，不展示任何半成品面板。
  // [事务] error 与 report 互斥写入，任何时刻只有一者承载界面。
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // [资源] void 前缀显式丢弃 promise，避免触发未处理拒绝告警。
    // [并发] 空依赖保证只有一次在途请求，热重载重复挂载不会叠加拉取。
    void loadReportSummary()
      .then(async ({ summary, summaryUrl }) => {
        try {
          // [事务] 趋势请求在摘要落地后串行发起，避免并发读取正在写的文件。
          // [资源] summaryUrl 作为基准路径，保证趋势与摘要同源同版本。
          // [失败路径] 该 await 抛出即转入内层 catch，摘要仍要正常提交。
          const trends = await loadPerformanceTrends(summary, summaryUrl);
          // [事务] 成功路径一次提交三元组，避免 trends 与 trendError 残留互相矛盾。
          // [并发] 提交发生在 promise 回调中，由 React 自动批处理合并为一次渲染。
          setReport({ summary, trendError: null, trends });
        } catch (loadError: unknown) {
          setReport({
            summary,
            // [失败路径] 只记录趋势异常，摘要保持可用，页面降级而非空白。
            // [权衡] 错误文案取 message 而非堆栈，牺牲诊断深度换取用户可读。
            trendError:
              loadError instanceof Error ? loadError.message : String(loadError),
            trends: null,
          });
        }
      })
      // [失败路径] 外层 catch 只接摘要失败，此时 report 保持 null。
      // [事务] 该分支不回写 report，避免错误态与数据态同时存在。
      .catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });
  // [资源] 空依赖数组声明生命周期：挂载时拉取一次，卸载后不再写入。
  // [权衡] 不做轮询刷新：`useEffect` 空依赖只拉一次，牺牲实时性换可预测性。
  }, []);

  // [失败路径] 错误分支优先返回并短路后续所有数据分支。
  // [事务] 该分支不渲染报告面板，防止脏数据进入 DOM 树。
  if (error) {
    // [失败路径] detail 直接透出原始 message，方便用户复制给维护者。
    // [权衡] 不细分网络与解析错误：统一走 `StateScreen`，牺牲分类指引换实现简单。
    return <StateScreen title="报告加载失败" detail={error} />;
  }
  if (!report) {
    // [资源] 加载屏是唯一零请求的渲染分支，不产生任何副作用。
    // [失败路径] 该屏长时间驻留说明请求悬挂，应排查 reportData 的 fetch。
    return <StateScreen title="报告加载中" detail="Reading summary.json" />;
  }

  return <ReportView report={report} />;
}

// [事务] ReportView 只读入参，不持有可变状态，渲染是纯函数。
// [权衡] 用 props 逐层传递而非 context，牺牲样板换取数据流向可见。
function ReportView({ report }: { report: ReportState }) {
  const { summary } = report;
  // [事务] 失败结论在此计算一次，所有状态徽标复用同一结果。
  // [权衡] 退出码与用例数取并集，宁可误报失败也不漏报。
  const failed = summary.exitCode !== 0 || summary.tests.failed > 0;
  const uiCoverage = summary.coverage?.uiRenderer;
  return (
    <main className="shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Desktop E2E Report</p>
          <h1>{summary.runId}</h1>
          <p className="path">{summary.artifactDir}</p>
        </div>
        <div className="heroMeta">
          <span className={failed ? "status fail" : "status pass"}>
            {failed ? <XCircleIcon size={16} /> : <CheckCircle2Icon size={16} />}
            {failed ? "FAILED" : "PASSED"}
          </span>
          <span>开始 {formatDateTime(summary.startedAt)}</span>
          <span>完成 {formatDateTime(summary.completedAt)}</span>
        </div>
      </header>

      <section className="metricGrid">
        <MetricCard
          detail={`${summary.tests.failed} failed`}
          icon={<CheckCircle2Icon />}
          label="测试"
          value={`${summary.tests.passed}/${summary.tests.total}`}
        />
        <MetricCard
          detail={`exit ${summary.exitCode}`}
          icon={<ClockIcon />}
          label="总耗时"
          value={formatDuration(summary.durationMs)}
        />
        <MetricCard
          detail={
            uiCoverage
              ? `${uiCoverage.sourceFileCount ?? uiCoverage.rendererEntryCount} ${
                  uiCoverage.sourceFileCount === undefined
                    ? "renderer scripts"
                    : "source files"
                }`
              : "disabled"
          }
          icon={<GaugeIcon />}
          label="UI 覆盖率"
          value={statsValue(
            uiCoverage?.totals.lines?.pct ?? uiCoverage?.totals.percent,
            "%",
          )}
        />
        <MetricCard
          detail={sampleHint(summary.performance.processSamples)}
          icon={<CpuIcon />}
          label="Electron CPU P95"
          value={statsValue(summary.performance.processSamples?.cpuTotalPercent.p95, "%")}
        />
        <MetricCard
          detail={sampleHint(summary.performance.processSamples)}
          icon={<MemoryStickIcon />}
          label="Electron 内存峰值"
          value={statsValue(summary.performance.processSamples?.memoryWorkingSetMb.peak, "MB")}
        />
        <MetricCard
          detail={sampleHint(summary.performance.containerSamples)}
          icon={<GaugeIcon />}
          label="容器 CPU P95"
          value={statsValue(summary.performance.containerSamples?.cpuPercent.p95, "%")}
        />
        <MetricCard
          detail={summary.containerE2E ? "docker stats" : "non-container"}
          icon={<HardDriveIcon />}
          label="容器块写入峰值"
          value={statsValue(summary.performance.containerSamples?.blockWriteMb.peak, "MB")}
        />
      </section>

      <TrendPanels trends={report.trends} trendError={report.trendError} />

      <CoveragePanel coverage={uiCoverage} />

      <TestsPanel results={summary.tests.results} />

      <section className="gridTwo">
        <InfoPanel title="Specs" rows={specRows(summary)} />
        <InfoPanel title="Artifacts" rows={artifactRows(summary)} />
        <InfoPanel title="Environment" rows={environmentRows(summary)} />
      </section>
    </main>
  );
}

function MetricCard(props: {
  detail: string;
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <article className="metric">
      <div className="metricIcon">{props.icon}</div>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <small>{props.detail}</small>
    </article>
  );
}

// [事务] 表格无内部状态，排序与截断由上游决定的顺序呈现。
// [失败路径] 零结果仍渲染表头，保证空态与有数据态结构一致。
function TestsPanel({ results }: { results: TestResultSummary[] }) {
  return (
    <Panel title="Tests" meta={`${results.length} recorded`} wide>
      <div className="tableWrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Duration</th>
              <th>Test</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {(results.length > 0 ? results : [emptyResult()]).map((result) => (
              <tr key={`${result.fullTitle}-${result.capturedAt}`}>
                <td>
                  <span className={result.passed ? "pill pass" : "pill fail"}>
                    {result.passed ? "PASS" : "FAIL"}
                  </span>
                </td>
                <td>{formatDuration(result.durationMs)}</td>
                <td>
                  {result.fullTitle}
                  {result.error ? <pre>{result.error}</pre> : null}
                </td>
                <td>
                  <code>{result.file ?? "n/a"}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function InfoPanel({ rows, title }: { rows: Array<[string, string]>; title: string }) {
  return (
    <Panel title={title}>
      <dl className="infoList">
        {rows.map(([label, value]) => (
          <div key={`${label}-${value}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function Panel(props: {
  children: ReactNode;
  meta?: string;
  title: string;
  wide?: boolean;
}) {
  return (
    <section className={props.wide ? "panel wide" : "panel"}>
      <div className="panelHeader">
        <h2>{props.title}</h2>
        {props.meta ? <span>{props.meta}</span> : null}
      </div>
      {props.children}
    </section>
  );
}

// [资源] 加载与失败共用同一屏，差异只在文案。
// [失败路径] 该组件不依赖 report，任何阶段都可安全渲染。
function StateScreen({ detail, title }: { detail: string; title: string }) {
  return (
    <main className="stateScreen">
      <ActivityIcon size={28} />
      <h1>{title}</h1>
      <p>{detail}</p>
    </main>
  );
}

// [失败路径] 未指定 spec 时回落到全量配置文案，避免出现空列表。
// [权衡] 行号由数组下标生成，牺牲稳定标识换取顺序直观。
function specRows(summary: E2EReportSummary): Array<[string, string]> {
  const specs =
    summary.requestedSpecs.length > 0
      ? summary.requestedSpecs
      : ["all configured desktop e2e specs"];
  return specs.map((spec, index) => [`Spec ${index + 1}`, spec]);
}

// [失败路径] 文件字段缺失统一显示 n/a，避免界面出现 undefined。
// [事务] 产物清单是摘要字段的镜像，不在此处探测文件是否真实存在。
function artifactRows(summary: E2EReportSummary): Array<[string, string]> {
  return [
    // [失败路径] viewerUrl 缺失时回落到当前地址，保证报告可自引用。
    // [权衡] 直接沿用 location 而不规范化查询参数，牺牲一致性换取零依赖。
    // [事务] URL 只读不写，避免刷新时把临时筛选条件写进历史记录。
    ["Viewer URL", summary.files.viewerUrl ?? window.location.href],
    ["Summary JSON", summary.files.summaryJson],
    ["Summary Markdown", summary.files.summaryMd],
    ["Coverage heatmap", summary.files.coverageHeatmap ?? "n/a"],
    ["UI renderer coverage", summary.files.uiRendererCoverage ?? "n/a"],
    ["Manifest", summary.files.manifest],
    ["Test results", summary.files.tests],
    ["Process samples", summary.files.processSamplesGlob],
    ["Container samples", summary.files.containerSamples],
  ];
}

// [事务] 环境信息取自采集时快照，不与当前机器实测值比对。
// [失败路径] 数值缺失时由格式化器兜底，避免直接暴露 undefined。
function environmentRows(summary: E2EReportSummary): Array<[string, string]> {
  return [
    ["Platform", `${summary.environment.platform} / ${summary.environment.arch}`],
    ["Node", summary.environment.node],
    ["CPU", summary.environment.cpuModel],
    ["Memory", formatBytes(summary.environment.totalMemoryBytes)],
    ["Container", summary.containerE2E ? "yes" : "no"],
  ];
}

// [失败路径] 占位行标记通过，避免污染失败聚合结论。
// [事务] 占位行仅在渲染期合成，不写入摘要，刷新后自然消失。
function emptyResult(): TestResultSummary {
  return {
    capturedAt: "",
    durationMs: 0,
    fullTitle: "No test results were recorded",
    passed: true,
    status: "unknown",
    title: "No test results",
  };
}

// [失败路径] 采样对象缺失返回 no samples，与真实零采样区分。
// [资源] 提示文案是纯函数，不缓存也不订阅采样流。
function sampleHint(summary: { sampleCount: number } | undefined) {
  return summary ? `${summary.sampleCount} samples` : "no samples";
}

// [事务] 单位后缀由调用点传入：`statsValue` 只做空值判断与格式化。
// [失败路径] 值为 undefined 时短路返回 n/a，不进入格式化器。
function statsValue(value: number | undefined, suffix: string) {
  return value === undefined ? "n/a" : formatNumber(value, suffix);
}
