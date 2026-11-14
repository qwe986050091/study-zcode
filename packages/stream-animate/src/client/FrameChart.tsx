// INV-01 守住位置：FrameCharts 首分支对 run?.metrics 判空并早返回占位面板；改错故障：首帧直接取属性会抛错，整块可视化白屏
// INV-02 守住位置：两档图表固定取 run.metrics.frames 的 "60" 与 "120" 键；改错故障：键名漂移会让 FrameChart 收到 undefined 并在解构处崩溃
// INV-03 守住位置：embedded 与 showForecast 的默认值写在解构参数上；改错故障：默认值散落到函数体后会出现两处取值来源，内嵌场景难以预测
// INV-04 守住位置：chartHeight 由 embedded 决定为 200 或 220；改错故障：SVG 与容器高度不一致会让内嵌图表撑破卡片或留出空白
// INV-05 守住位置：gutter 为 42 的左侧刻度区宽度，轴起点、柱位与 actualEndX 共用；改错故障：任一处写死别的数值，柱子就会与 Y 轴错位
// INV-06 守住位置：barWidth 与 gap 依据 totalFrames 是否大于 240 成对切换；改错故障：只改其中一个会让长序列的柱子重叠或出现可疑缝隙
// INV-07 守住位置：chartFrameCount 为真实桶数加预测帧数；改错故障：漏掉预测帧会让画布偏窄，预测折线被裁到可视区之外
// INV-08 守住位置：chartWidth 取最小宽度与内容宽度的较大者；改错故障：少掉下限会让少量帧被强行拉伸，读出的节奏感失真
// INV-09 守住位置：maxChars 的下界固定为 1；改错故障：全零帧场景会出现除零，柱高变为 Infinity 或 NaN 并污染整条 SVG
// INV-10 守住位置：maxChars 汇总 scenario.maxChars 与两条趋势序列的峰值；改错故障：只取 scenario.maxChars 会让预测峰值冲破画布顶部
// INV-11 守住位置：actualEndX 标记真实区与预测区的分界，色带、分界线与标签都引用它；改错故障：各算一次会让三者的位置互相错开
// INV-12 守住位置：observedPath 与 predictedPath 在渲染前预计算；改错故障：把计算塞进 JSX 会让每次渲染重复拼路径，高频推送时明显掉帧
// INV-13 守住位置：滚动副作用的依赖为 nonEmptyFrames 与 totalFrames；改错故障：漏依赖会让图表停在旧位置，新帧到达后用户看不到
// INV-14 守住位置：滚动使用 smooth 行为并定位到 scrollWidth；改错故障：直接赋值 scrollLeft 会在高频更新下产生跳动，滚动过程被反复打断
// INV-15 守住位置：预测区的色带、分界线与折线同时受 forecast 与 forecastFrames 约束；改错故障：任一条件缺失会在无预测数据时画出空色带
// INV-16 守住位置：柱高与柱顶 y 都基于 chartHeight 减 28 的可视高度；改错故障：两处基准不同会让柱顶越过顶部刻度文字
// INV-17 守住位置：buildTrendPath 在点集为空时返回空串；改错故障：返回 undefined 会让调用方误判有路径并渲染出非法 d 属性
// INV-18 守住位置：roundPathValue 统一保留一位小数；改错故障：保留原始浮点会让 d 字符串显著变长，序列化与重绘成本随之上升
//
// 模块职责：把 RunSummary 中的帧统计渲染为柱状图与趋势/预测折线，并在新帧到来时把视图滚到最右端
// 状态所有权：组件只读 run 与 scenario，唯一内部持有物是滚动容器的 ref，没有受控输入也没有向上写回
// 阅读顺序：先看 FrameCharts 的空态与两档入口，再看 FrameChart 的布局常量、路径预计算、滚动副作用与柱体映射，最后看三个纯函数
import type { FrameScenario, FrameTrendPoint, RunSummary } from "@/shared/types";
import { useEffect, useRef } from "react";

// 入口容错：metrics 缺失时只渲染空面板，不进入下方图表分支
// 该早返回同时承担首帧未到达时的占位职责，避免对空值取属性
// 固定只渲染 60fps 与 120fps 两个档位，键名来自 shared 中的约定
// 两档共用同一实现，差异仅由传入的 scenario 与 title 决定
// 若新增档位必须同步 shared 类型，否则键名缺失会让组件收到空场景
// 改错后果：去掉空态分支会在首帧抛错，整块可视化直接白屏
export function FrameCharts({ run }: { run: RunSummary | null }) {
  if (!run?.metrics) {
    return (
      <section className="panel chartEmpty">
        <h2>帧可视化</h2>
        <p>等待 SSE 数据。</p>
      </section>
    );
  }

  return (
    <section className="charts">
      <FrameChart scenario={run.metrics.frames["60"]} title="60fps" />
      <FrameChart scenario={run.metrics.frames["120"]} title="120fps" />
    </section>
  );
}

// 对外契约：scenario 与 title 必填，其余三项都带默认值
// embedded 默认 false，同时决定外层类名与画布高度上限
// showForecast 默认 true，关闭后预测色带与预测线一并消失
// subtitle 缺省时由组件用帧数与非空帧数拼出摘要，调用方无需重算
// 改错后果：把 scenario 改成可选会让内部所有取数分支都要补空判，数据来源随之发散
interface FrameChartProps {
  embedded?: boolean;
  scenario: FrameScenario;
  showForecast?: boolean;
  subtitle?: string;
  title: string;
}

export function FrameChart({
  embedded = false,
  scenario,
  showForecast = true,
  subtitle,
  title,
}: FrameChartProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const chartHeight = embedded ? 200 : 220;
  const gutter = 42;
  // 密度阈值以 totalFrames 判断，超过 240 帧时收窄柱宽与间隙
  // 收窄的目的不是截断数据，而是让全部帧位仍能落在画布内
  // 柱宽与间隙必须成对取值，只改一侧会让柱子重叠或出现缝隙
  // 该常量还参与真实区终点与趋势路径的横坐标计算
  // 改错后果：只调柱宽不调间隙，长序列区间的柱子会彼此压住
  const barWidth = scenario.totalFrames > 240 ? 4 : 7;
  const gap = scenario.totalFrames > 240 ? 1 : 2;
  const forecast = showForecast ? scenario.forecast : undefined;
  const forecastFrames = forecast?.horizonFrames ?? 0;
  const chartFrameCount = scenario.buckets.length + forecastFrames;
  const chartWidth = Math.max(embedded ? 520 : 720, gutter + chartFrameCount * (barWidth + gap) + 20);
  // 统一量纲：柱高与趋势线都使用同一个归一化基准
  // 下界取 1，避免全零场景出现除零得到无穷大或非数
  // 同时纳入场景峰值与两条趋势序列的峰值，防止预测值溢出画布
  // 只取场景峰值时，预测段的峰值会被裁到图表顶部之外
  // 改错后果：去掉下界后，空数据帧的柱高会变成非数并破坏整条 SVG
  const maxChars = Math.max(
    1,
    scenario.maxChars,
    maxTrendChars(forecast?.observed),
    maxTrendChars(forecast?.predicted),
  );
  const actualEndX = gutter + scenario.buckets.length * (barWidth + gap);
  const observedPath = buildTrendPath(forecast?.observed ?? [], {
    barWidth,
    chartHeight,
    gap,
    gutter,
    maxChars,
  });
  const predictedPath = buildTrendPath(forecast?.predicted ?? [], {
    barWidth,
    chartHeight,
    gap,
    gutter,
    maxChars,
  });

  // 布局副作用：依赖变化后把滚动容器推到最右端，跟随最新帧
  // 依赖只取非空帧数与总帧数，保证每来一批新数据才触发一次
  // 早返回用于处理 ref 尚未挂载的情况，首次提交后才会真正滚动
  // 使用平滑滚动而非直接赋值，避免高频到达时画面来回抖动
  // 改错后果：把桶数组整体放进依赖会因引用变化频繁触发，滚动被反复打断
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      return;
    }
    scroller.scrollTo({ behavior: "smooth", left: scroller.scrollWidth });
  }, [scenario.nonEmptyFrames, scenario.totalFrames]);

  return (
    <article className={embedded ? "embeddedChart" : "panel chartPanel"}>
      <div className="panelHeader">
        <div>
          <h2>{title}</h2>
          <p>{subtitle ?? `${scenario.totalFrames} frames · ${scenario.nonEmptyFrames} non-empty · max ${scenario.maxChars} chars`}</p>
          {forecast ? (
            <p>
              smooth window {forecast.windowFrames} frames · forecast {forecast.horizonFrames} frames
            </p>
          ) : null}
        </div>
        <div className="chartMeta">
          <strong>{scenario.frameMs.toFixed(2)}ms/frame</strong>
          <span>
            <i className={forecast ? "legendLine actual" : "legendLine raw"} />
            {forecast ? "smoothed" : "raw"}
          </span>
          {forecast ? (
            <span>
              <i className="legendLine predicted" />
              predicted
            </span>
          ) : null}
        </div>
      </div>
      <div className="chartScroller" ref={scrollerRef}>
        <svg
          aria-label={`${title} chars per frame`}
          height={chartHeight + 46}
          role="img"
          width={chartWidth}
        >
          <line
            className="axis"
            x1={gutter}
            x2={chartWidth - 10}
            y1={chartHeight}
            y2={chartHeight}
          />
          <line className="axis" x1={gutter} x2={gutter} y1={12} y2={chartHeight} />
          <text className="axisLabel" x={8} y={22}>
            chars
          </text>
          <text className="axisLabel" x={chartWidth - 58} y={chartHeight + 32}>
            frame
          </text>
          {forecastFrames > 0 ? (
            <>
              <rect
                className="futureBand"
                height={chartHeight - 12}
                width={chartWidth - actualEndX - 10}
                x={actualEndX}
                y={12}
              />
              <line
                className="futureDivider"
                x1={actualEndX}
                x2={actualEndX}
                y1={12}
                y2={chartHeight}
              />
              <text className="futureLabel" x={actualEndX + 10} y={30}>
                forecast
              </text>
            </>
          ) : null}
          {scenario.buckets.map((bucket) => {
            const height = Math.max(1, (bucket.chars / maxChars) * (chartHeight - 28));
            const x = gutter + bucket.frameIndex * (barWidth + gap);
            const y = chartHeight - height;
            return (
              <rect
                className={bucket.chars > 0 ? "bar active" : "bar"}
                height={height}
                key={bucket.frameIndex}
                rx={2}
                width={barWidth}
                x={x}
                y={y}
              >
                <title>
                  frame {bucket.frameIndex}: {bucket.chars} chars
                </title>
              </rect>
            );
          })}
          {observedPath ? <path className="speedLine" d={observedPath} /> : null}
          {predictedPath ? <path className="forecastLine" d={predictedPath} /> : null}
        </svg>
      </div>
    </article>
  );
}

// 空点集直接返回空串，调用方据此不渲染路径节点
// 首点用移动指令、后续用连线指令，首段误用连线会从原点拉出斜线
// 横坐标取柱中心而非柱左边，否则趋势线整体偏移半个柱宽
// 纵坐标与柱高共用同一缩放公式，不共用时线与柱的高度对不上
// 坐标统一保留一位小数，缩短路径字符串并降低高频重绘开销
// 改错后果：保留原始浮点会让路径属性显著变长，刷新时序列化成本上升
function buildTrendPath(
  points: FrameTrendPoint[],
  options: {
    barWidth: number;
    chartHeight: number;
    gap: number;
    gutter: number;
    maxChars: number;
  },
) {
  if (points.length === 0) {
    return "";
  }
  return points
    .map((point, index) => {
      const x = options.gutter + point.frameIndex * (options.barWidth + options.gap) + options.barWidth / 2;
      const y = options.chartHeight - (point.chars / options.maxChars) * (options.chartHeight - 28);
      return `${index === 0 ? "M" : "L"} ${roundPathValue(x)} ${roundPathValue(y)}`;
    })
    .join(" ");
}

function maxTrendChars(points: FrameTrendPoint[] | undefined) {
  return points?.reduce((max, point) => Math.max(max, point.chars), 0) ?? 0;
}

function roundPathValue(value: number) {
  return Math.round(value * 10) / 10;
}
