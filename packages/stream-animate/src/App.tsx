// INV-01 首屏并行加载：守住位置 首个副作用；改错故障 配置与历史串行变慢。
// INV-02 加载失败落错误态：守住位置 捕获分支；改错故障 页面空白无提示。
// INV-03 默认选中最新一次运行：守住位置 初始化回调；改错故障 首屏没有详情。
// INV-04 切换运行时清空旧数据：守住位置 空标识分支；改错故障 残留上一次详情。
// INV-05 原始行可选：守住位置 捕获回退；改错故障 缺文件导致整页报错。
// INV-06 轮询条件由运行态决定：守住位置 判断；改错故障 无运行任务时持续请求。
// INV-07 轮询同时刷新列表与详情：守住位置 定时回调；改错故障 进度只更新一半。
// INV-08 卸载时清理定时器：守住位置 返回函数；改错故障 定时器泄漏并继续请求。
// INV-09 提交期间禁用表单：守住位置 标志位；改错故障 重复提交创建多次运行。
// INV-10 提交前清空错误：守住位置 起始处；改错故障 旧错误与结果同时显示。
// INV-11 新运行去重后置顶：守住位置 列表更新；改错故障 同一运行出现两条。
// INV-12 提交后自动选中：守住位置 标识更新；改错故障 用户仍看旧详情。
// INV-13 失败后恢复可提交：守住位置 最终分支；改错故障 按钮永久禁用。
// INV-14 详情刷新回写列表：守住位置 映射更新；改错故障 列表与详情状态不一致。
// INV-15 轮询间隔固定：守住位置 定时器参数；改错故障 高频请求压垮服务。
// INV-16 列表刷新不吞错：守住位置 直接调用；改错故障 轮询异常无人感知。
// INV-17 原始面板显示行数：守住位置 文案；改错故障 用户无法判断数据量。
// INV-18 错误文本统一提取：守住位置 工具函数；改错故障 非异常值显示为对象。
//
// 模块职责：演示页的状态编排与页面装配。
// 状态所有权：配置、表单、运行列表与当前详情都归本组件。
// 阅读顺序：先看副作用，再看提交与刷新，最后看展示分支。
import { useEffect, useMemo, useState } from "react";
import type { AppConfig, RunSummary } from "@/shared/types";
import { Aggregates } from "@/client/Aggregates";
import {
  DEFAULT_FORM,
  createRun,
  fetchConfig,
  fetchRawLines,
  fetchRun,
  fetchRuns,
  type RunFormState,
} from "@/client/api";
import { FrameCharts } from "@/client/FrameChart";
import { RunForm } from "@/client/RunForm";
import { RunHistory } from "@/client/RunHistory";
import { RunSummaryPanel } from "@/client/RunSummaryPanel";

// 首屏并行拉取 config 与 runs，减少一次串行往返。
// selectedRunId 独立于详情对象，列表刷新不会丢失选中。
// error 与 submitting 分开保存，失败时表单仍可编辑。
// hasRunningRun 由 runs 推导，避免再存一份布尔状态。
// 三个 effect 依赖各自声明，轮询只在运行中开启。
export function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [form, setForm] = useState<RunFormState>(DEFAULT_FORM);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRun, setSelectedRun] = useState<RunSummary | null>(null);
  const [rawLines, setRawLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 只判断 runs 里是否存在 running 项，不把整个列表塞进依赖。
  // useMemo 随 runs 引用变化重算，列表未变时复用旧值。
  // 结果驱动轮询开关，空闲时不创建 timer。
  // effect 只依赖布尔值，避免每次列表更新都重建定时器。
  // 运行中判定集中在此处，其他位置不再重复 some 调用。
  const hasRunningRun = useMemo(() => runs.some((run) => run.status === "running"), [runs]);

  useEffect(() => {
    void Promise.all([fetchConfig(), fetchRuns()])
      .then(([nextConfig, nextRuns]) => {
        setConfig(nextConfig);
        setRuns(nextRuns);
        setSelectedRunId(nextRuns[0]?.id ?? null);
      })
      .catch((loadError: unknown) => setError(toErrorMessage(loadError)));
  }, []);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRun(null);
      setRawLines([]);
      return;
    }
    void refreshSelectedRun(selectedRunId);
  }, [selectedRunId]);

  useEffect(() => {
    if (!hasRunningRun) {
      return;
    }
    const timer = window.setInterval(() => {
      void refreshRuns();
      if (selectedRunId) {
        void refreshSelectedRun(selectedRunId);
      }
    }, 350);
    return () => window.clearInterval(timer);
  }, [hasRunningRun, selectedRunId]);

  // 提交开始即把 submitting 置真，按钮与输入同时禁用。
  // 发起时清空旧 error，避免上一次失败文案残留。
  // 成功后按 id 去重再置顶，重复提交不会出现两行。
  // 新运行直接设为 selectedRunId，详情区立即切换。
  // 失败只写 error，列表与选中保持原样。
  const startRun = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const run = await createRun(form);
      setRuns((current) => [run, ...current.filter((item) => item.id !== run.id)]);
      setSelectedRunId(run.id);
    } catch (submitError) {
      setError(toErrorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  const refreshRuns = async () => {
    const nextRuns = await fetchRuns();
    setRuns(nextRuns);
  };

  // 详情与原始行分别由 fetchRun 和 fetchRawLines 并行读取。
  // fetchRawLines 失败时回退为空数组，详情仍可渲染。
  // 详情写回 selectedRun，同时替换 rawLines。
  // runs 中同 id 项同步更新，列表标题与状态不会滞后。
  const refreshSelectedRun = async (runId: string) => {
    const [run, lines] = await Promise.all([
      fetchRun(runId),
      fetchRawLines(runId).catch(() => []),
    ]);
    setSelectedRun(run);
    setRawLines(lines);
    setRuns((current) => current.map((item) => (item.id === run.id ? run : item)));
  };

  return (
    <main className="appShell">
      <header className="hero">
        <div>
          <p className="eyebrow">SSE frame profiler</p>
          <h1>Stream Animate</h1>
        </div>
        <button className="ghostButton" type="button" onClick={() => void refreshRuns()}>
          刷新
        </button>
      </header>

      {error ? <div className="errorBanner">{error}</div> : null}

      <div className="layout">
        <aside className="sidebar">
          <RunForm
            config={config}
            disabled={submitting}
            form={form}
            onChange={setForm}
            onSubmit={startRun}
          />
          <RunHistory runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        </aside>

        <section className="mainColumn">
          <RunSummaryPanel run={selectedRun} />
          <FrameCharts run={selectedRun} />
          <Aggregates runs={runs} />
          <RawPanel lines={rawLines} />
        </section>
      </div>
    </main>
  );
}

function RawPanel({ lines }: { lines: string[] }) {
  return (
    <section className="panel rawPanel">
      <div className="panelHeader">
        <div>
          <h2>Raw NDJSON</h2>
          <p>最近 {lines.length} 行</p>
        </div>
      </div>
      <pre>{lines.join("\n") || "暂无原始数据"}</pre>
    </section>
  );
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
