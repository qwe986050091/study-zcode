// 本文件负责 e2e 报告 Performance Trends 面板的图表装配与渲染，只读取 trendData 派生的只读快照，不持有业务状态。
// 渲染链为 TrendPanels 到 TrendLinePanel 再到 buildLineData 与 buildLineOptions，最终交给 react-chartjs-2 的 Line。
// 数据来源是 PerformanceTrends 的 container 与 process 两组序列，进程组加 Electron 前缀后合并，空序列在合并阶段剔除。
// 所有函数均为纯派生或纯格式化，唯一外部副作用是 chart.js 全局注册与读取 DOM 计算样式，因此无需卸载清理。
// [失败路径] INV-01 trendError 非空时必须短路返回错误面板，不再读取 trends；守住位置：TrendPanels 首个条件分支；改错故障：错误提示被局部数据覆盖，用户误以为趋势正常。
// [失败路径] INV-02 trends 为 null 时按空序列处理而非抛错；守住位置：TrendPanels 对 trendData 的可选访问；改错故障：首次加载期整块面板白屏。
// [资源] INV-03 图表实例由 react-chartjs-2 托管并在卸载时销毁，本文件不持有画布或实例引用；守住位置：TrendLinePanel 的 Line 渲染；改错故障：切页后残留实例持续占用内存并抢占动画帧。
// [并发] INV-04 同一趋势快照在多次渲染间必须产出内容相同的 dataset 数组，禁止掺入时间戳或随机量；守住位置：buildLineData；改错故障：重渲染导致曲线抖动与 tooltip 数值跳变。
// [权衡] INV-05 空序列在 combineSeries 阶段剔除以降低图例开销，代价是全部为空时整体退化为占位文案；守住位置：combineSeries；改错故障：图例出现无点位空条目，用户无法区分无采样与渲染失败。
// [失败路径] INV-06 maxPointCount 取全序列最大点数，为 0 时必须渲染占位而非空图表框；守住位置：TrendLinePanel 的三元分支；改错故障：用户看到空白画布以为页面卡死。
// [权衡] INV-07 面板 meta 同时给出序列数与最大采样数，避免把多点序列误读为多序列；守住位置：TrendLinePanel 的 meta 计算；改错故障：排障时误判数据源重复上报。
// [资源] INV-08 颜色必须每次渲染实时读取 CSS 变量，模块级缓存会与主题切换脱节；守住位置：resolveChartColor 与 chartTextColor、chartGridColor；改错故障：浅色主题下文字与网格不可见。
// [失败路径] INV-09 非 var 形式的颜色（hex 或关键字）必须原样返回，不可强制包裹；守住位置：resolveChartColor 的正则不匹配分支；改错故障：自定义主题色被替换成空串，曲线变成透明。
// [失败路径] INV-10 变量取值为空串时必须回退到原色而非空白；守住位置：resolveChartColor 末尾的或运算兜底；改错故障：图表元素全部无色，用户以为数据缺失。
// [事务] INV-11 dataset 的边框色与填充色必须来自同一次颜色解析结果，禁止二次解析；守住位置：buildLineData 中 color 的复用；改错故障：主题切换瞬间出现描边与填充不一致的错帧。
// [权衡] INV-12 填充透明度固定为 0.16，兼顾叠放可读性与背景对比度；守住位置：buildLineData 的 withAlpha 调用；改错故障：多序列叠放时上层曲线完全遮住下层。
// [失败路径] INV-13 alpha 修饰只对 3 位或 6 位 hex 生效，其余格式原样返回以免拼出非法 rgba；守住位置：withAlpha 的长度判断；改错故障：非法颜色串导致整条曲线不被绘制。
// [失败路径] INV-14 3 位 hex 需先扩展为 6 位再转十进制，否则取色偏移；守住位置：hexToRgb 的长度分支；改错故障：简写主题色渲染成完全不同的色相。
// [资源] INV-15 图例与坐标轴文本色统一走 chartTextColor，仅在渲染期读取 DOM 计算样式；守住位置：buildLineOptions 的 labels 与 ticks；改错故障：无 document 环境下抛错并中断整页渲染。
// [失败路径] INV-16 tooltip 的 raw 可能为 null 或对象，必须归一为数字后再格式化；守住位置：buildLineOptions 的 tooltip 回调；改错故障：悬停显示 NaN 或 object Object 字样。
// [事务] INV-17 x 轴刻度格式与 tooltip 数值格式必须同源，避免同一时刻出现两种时间表述；守住位置：buildLineOptions 的 x 刻度回调与 formatElapsedSeconds；改错故障：排障时把 90s 与 1m 30s 当成不同采样点。
// [失败路径] INV-18 非有限秒数必须返回空串，禁止输出 NaN 分钟；守住位置：formatElapsedSeconds 的首个守卫；改错故障：脏采样让整条 x 轴刻度被 NaN 占满。
// [权衡] INV-19 单点序列放大点半径到 4、多点保持 2，避免单采样被误判为无数据；守住位置：buildLineData 的 pointRadius 三元；改错故障：只有一次采样的短任务图表看起来是空的。
// [并发] INV-20 图表使用 responsive 且关闭 maintainAspectRatio，尺寸完全交给容器样式；守住位置：buildLineOptions 顶层两项；改错故障：侧栏折叠后画布不重排，曲线被拉伸变形。
import {
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
  type TooltipItem,
} from "chart.js";
import type { ReactNode } from "react";
import { Line } from "react-chartjs-2";
import type { PerformanceTrends, TrendSeries } from "./trendData.js";
import { formatNumber } from "./format.js";

ChartJS.register(
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
);

// [并发] 该组件是无状态纯渲染函数，同一 props 多次调用结果一致，可安全参与 React 并发渲染的重复调用。
// [权衡] 错误态与数据态共用同一外层 panel 骨架，避免两套布局在状态切换时产生高度跳动。
// [失败路径] 任何 trendData 字段缺失都以可选链兜底为空数组，保证合并阶段不会因结构不完整抛错。
export function TrendPanels({
  trendError,
  trends,
}: {
  trendError?: string | null;
  trends: PerformanceTrends | null;
}) {
  // [失败路径] 该分支先于任何数据派生执行，保证失败提示不会被后到的局部数据掩盖。
  // [事务] 错误态只读取 trendError 本身，不触碰缓存的 trends，故重试成功后能自然回到数据态。
  // [权衡] 错误面板保留 summary statistics 提示，向用户说明其余统计仍可用，缩小恐慌面。
  if (trendError) {
    return (
      <Panel meta="summary statistics are still available" title="Performance Trends" wide>
        <EmptyText text={`趋势数据加载失败：${trendError}`} />
      </Panel>
    );
  }

  // [事务] 容器与进程两组 CPU 序列在派生期一次性合并，顺序固定为容器在前、进程在后。
  // [资源] 展平产生的新数组只服务于本次渲染，不写回 trends，避免上游快照被就地污染。
  // [失败路径] 进程序列加前缀后仍保留原 label，同名容器序列不会被误判成同一条而互相覆盖。
  const cpuSeries = combineSeries([
    ...(trends?.containerCpu ?? []),
    ...prefixSeries(trends?.processCpu ?? [], "Electron"),
  ]);
  // [权衡] 内存与 CPU 使用同一套合并策略，单位差异只通过 unit 参数下传，避免两份格式化逻辑漂移。
  // [资源] 单位 MB 由调用方声明而非从数据推断，防止上游换单位时静默改变坐标轴量级。
  const memorySeries = combineSeries([
    ...(trends?.containerMemory ?? []),
    ...prefixSeries(trends?.processMemory ?? [], "Electron"),
  ]);

  return (
    <section className="trendGrid">
      <TrendLinePanel title="CPU Trend" series={cpuSeries} unit="%" />
      <TrendLinePanel title="Memory Trend" series={memorySeries} unit="MB" />
    </section>
  );
}

// [权衡] 该组件同时承担面板骨架、meta 文案、图表或占位二选一，使调用方零判断。
// [并发] props 全为只读值，渲染期不引入计时器或订阅，反复挂载卸载不会累积监听。
// [失败路径] wide 仅影响类名，不参与是否渲染图表的判断，布局参数与数据可用性严格解耦。
function TrendLinePanel({
  series,
  title,
  unit,
  wide,
}: {
  series: TrendSeries[];
  title: string;
  unit: string;
  wide?: boolean;
}) {
  // [权衡] 以最大点数而非总点数判断可绘制性，单个序列有采样即出图，避免稀疏序列被全量掩盖。
  // [资源] 展开运算符对空数组天然退化为 0，无需额外长度守卫，也避免为求最大值再复制一次数组。
  // [失败路径] points 字段缺失时该行会直接抛错，因此上游趋势结构必须保证每项都带数组字段。
  // [并发] 结果只读且在同一次渲染内复用给 meta 与分支判断，不重复计算，避免两处数值不一致。
  const maxPointCount = Math.max(0, ...series.map((item) => item.points.length));
  return (
    <Panel
      meta={
        maxPointCount > 0
          ? `${series.length} series · ${maxPointCount} max samples · ${unit}`
          : "no samples"
      }
      title={title}
      wide={wide}
    >
      {maxPointCount > 0 ? (
        <div className="chartBox trendChart">
          <Line data={buildLineData(series)} options={buildLineOptions(unit)} />
        </div>
      ) : (
        <EmptyText text="没有可绘制的时间序列采样。" />
      )}
    </Panel>
  );
}

// [权衡] 通用面板只接收 title、meta、wide 与 children，把 header 结构收敛到一处，避免各面板重复排版。
// [失败路径] meta 为空时不渲染 span 占位，避免 header 出现无内容的多余间距。
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

// [权衡] 占位统一使用 empty 类名，颜色与字号继承样式表，主题切换无需再读计算样式。
// [资源] 该组件无状态且无副作用，可被任意次复用而不会留下 DOM 监听。
function EmptyText({ text }: { text: string }) {
  return <p className="empty">{text}</p>;
}

// [事务] 前缀在派生成新对象时写入 label，原序列对象保持不变，保证同一快照可被多次前缀化。
// [失败路径] 空 label 也会得到前缀加空格的结果，用于在图上区分来源进程而非留空图例。
function prefixSeries(series: TrendSeries[], prefix: string) {
  return series.map((item) => ({
    ...item,
    label: `${prefix} ${item.label}`,
  }));
}

// [权衡] combineSeries 只按 points.length > 0 过滤：不校验数值有效性，脏数据留给坐标轴格式化兜底。
// [资源] 返回新数组而不就地删除元素，调用方持有的输入数组长度保持稳定。
function combineSeries(series: TrendSeries[]) {
  return series.filter((item) => item.points.length > 0);
}

// [事务] 该函数是 dataset 的唯一构造点，颜色、点半径、张力与数据点映射都在此一次成型。
// [失败路径] 进入前已过滤空序列，此处再过滤属于防御性冗余，防止上游绕过 combineSeries 直接调用。
// [权衡] 边框宽度按 label 是否含 Total 区分层级，主线 3px、辅线 2px，用视觉权重替代额外图例分组。
// [资源] 每个 dataset 的 data 为新建的 x 与 y 对象数组，chart.js 接管后可安全丢弃原 points 引用。
// [事务] 序列顺序即 dataset 顺序，亦即图例与 tooltip 的展示顺序，任何重排都会改变用户阅读次序。
function buildLineData(series: TrendSeries[]): ChartData<"line"> {
  return {
    datasets: series
      .filter((item) => item.points.length > 0)
      .map((item) => {
        const color = resolveChartColor(item.color);
        return {
          backgroundColor: withAlpha(color, 0.16),
          borderColor: color,
          borderWidth: item.label.includes("Total") ? 3 : 2,
          data: item.points.map((point) => ({
            x: point.elapsedSeconds,
            y: point.value,
          })),
          label: item.label,
          pointRadius: item.points.length > 1 ? 2 : 4,
          tension: 0.28,
        };
      }),
  };
}

// [权衡] x 轴显式声明为 linear 而非 category，使采样间隔不均匀时仍按真实耗时等比排布。
// [失败路径] y 轴 beginAtZero 保证百分比与内存量都从 0 起读，避免截断造成斜率夸大。
// [资源] 图例与刻度的颜色在选项构造期写入，因而每次渲染都会重新读取 CSS 变量。
// [并发] tooltip 与坐标轴共用同一 unit 参数，单位切换只改一处即可全图生效。
// [失败路径] 刻度回调对入参先归一为数字，空字符串或对象不会直接进入格式化。
function buildLineOptions(unit: string): ChartOptions<"line"> {
  return {
    maintainAspectRatio: false,
    plugins: {
      legend: {
        labels: {
          color: chartTextColor(),
          usePointStyle: true,
        },
      },
      tooltip: {
        callbacks: {
          label(context: TooltipItem<"line">) {
            // [失败路径] raw 为 null 时按 0 处理，避免 tooltip 出现 null 字样。
            // [事务] dataset.label 缺失时回退为 Value，保证每条 tooltip 行都有可读前缀。
            const value = Number(context.raw ?? 0);
            return `${context.dataset.label ?? "Value"}: ${formatNumber(
              value,
              unit,
            )}`;
          },
        },
      },
    },
    responsive: true,
    scales: {
      x: {
        type: "linear",
        grid: { color: chartGridColor() },
        ticks: {
          callback(value) {
            return formatElapsedSeconds(Number(value));
          },
          color: chartTextColor(),
          maxRotation: 0,
        },
        title: { color: chartTextColor(), display: true, text: "Elapsed time" },
      },
      y: {
        beginAtZero: true,
        grid: { color: chartGridColor() },
        ticks: {
          callback(value) {
            return formatNumber(Number(value), unit);
          },
          color: chartTextColor(),
        },
        title: { color: chartTextColor(), display: true, text: unit },
      },
    },
  };
}

// [权衡] 一分钟内只显示秒，超过后显示分秒组合，用最短字符串表达耗时以减少 x 轴拥挤。
// [失败路径] 超过一小时后仍以分钟累计，长任务刻度会变成大数字，需依赖上游截断采样窗口。
function formatElapsedSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) {
    return "";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds) % 60}s`;
}

// [事务] 该函数是 var 颜色到实际色的唯一转换点，图例、描边与填充都复用它的返回值。
// [并发] 每次调用都重新读取文档根元素的计算样式，不缓存，因而主题切换后下次渲染立即生效。
// [失败路径] 正则只接受整串 var 形式，混排字符串按原始值返回，避免部分替换产生非法颜色。
// [权衡] 解析失败一律回退原值而非抛错，图表降级为默认色仍可读，优先保证页面不中断。
function resolveChartColor(color: string) {
  const cssVarMatch = color.match(/^var\((--[^)]+)\)$/u);
  if (!cssVarMatch) {
    return color;
  }
  const cssVariable = cssVarMatch[1];
  if (!cssVariable) {
    return color;
  }
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue(cssVariable)
      .trim() || color
  );
}

// [失败路径] 非 hex 颜色直接返回，透明填充退化为不透明描边色，视觉上仍可辨认。
// [事务] 3 位与 6 位 hex 分别走扩展与直接切片路径，两条路径都产出三元组供拼接。
function withAlpha(color: string, alpha: number) {
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const [red, green, blue] = hexToRgb(color);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }
  return color;
}

// [失败路径] 非法 hex 字符会让解析结果为 NaN，因此调用方必须先做长度与格式判断。
// [权衡] 返回元组而非对象，调用点可直接解构，省去属性查找与临时对象分配。
function hexToRgb(color: string): [number, number, number] {
  if (color.length === 4) {
    const red = color.charAt(1);
    const green = color.charAt(2);
    const blue = color.charAt(3);
    return [
      Number.parseInt(red + red, 16),
      Number.parseInt(green + green, 16),
      Number.parseInt(blue + blue, 16),
    ];
  }
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}

// [资源] 每次渲染重新读取 muted 变量，不做模块级缓存，保证主题热切换后文字色同步。
function chartTextColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--muted")
    .trim();
}

// [权衡] 网格与文字分别读取 line 与 muted 两个变量，用不同灰度区分结构线与文本层级。
function chartGridColor() {
  return getComputedStyle(document.documentElement)
    .getPropertyValue("--line")
    .trim();
}
