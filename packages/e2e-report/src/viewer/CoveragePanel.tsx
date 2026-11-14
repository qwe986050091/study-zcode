// INV-01 无覆盖率数据时渲染禁用态而不是空白：守住位置 组件首个早返回；改错故障：直接读合计会在缺数据时抛错，整个报告页白屏。
// INV-02 文件行按覆盖率升序、同值按路径升序：守住位置 派生行的排序比较器；改错故障：只按覆盖率排序时同值行顺序随输入抖动，diff 噪声掩盖真实变化。
// INV-03 排序不修改入参数组：先展开再排序，守住位置 同一行；改错故障：原地排序会改动上游共享数组，其它面板顺序被连带改变。
// INV-04 元信息在两种统计口径间二选一：有行覆盖用行口径，否则退到字节口径，守住位置 元信息的三元表达式；改错故障：混用两种口径会让同一面板的数字自相矛盾。
// INV-05 指标网格固定四项顺序：行、语句、函数、分支，守住位置 指标网格；改错故障：顺序随数据变化会让跨报告对比失去可比性。
// INV-06 产物路径缺失统一显示占位：守住位置 产物列表的三处取值；改错故障：直接渲染空值会让用户以为产物已生成。
// INV-07 表格分支互斥：有文件级数据走明细表，否则走脚本字节表，守住位置 行数判断的三元；改错故障：两个表同时渲染会让读者无法判断哪个是权威口径。
// INV-08 表格行键必须稳定唯一：明细用路径，脚本用地址，守住位置 两处键取值；改错故障：用下标当键会让排序后行状态错位。
// INV-09 未覆盖行列表有展示上限：超过十二条折叠为省略计数，守住位置 未覆盖行格式化；改错故障：全量输出会让单行撑爆表格布局。
// INV-10 脚本名解析失败时回退原始地址：守住位置 脚本名函数的兜底分支；改错故障：抛错会让整张表因一个非法地址无法渲染。
// INV-11 百分比一律经统一格式化：守住位置 数字格式化的调用点；改错故障：各面板各自拼接小数会让精度与符号不一致。
// INV-12 子组件只接收它需要的字段：守住位置 指标卡与面板容器的签名；改错故障：整块摘要透传会让子组件隐式依赖数据形状，重构即破。
// INV-13 面板容器只有在传入副标题时才渲染它：守住位置 条件渲染；改错故障：总是渲染会让空副标题占位，标题错位。
// INV-14 缺省值用可选链而非非空断言：守住位置 源文件列表的取值；改错故障：断言会让缺字段在运行期变成未捕获异常。
// INV-15 文本全部走框架转义，不注入原始标记：守住位置 所有文本节点；改错故障：用原始标记渲染路径名会让构建产物里的特殊字符变成注入面。
// INV-16 数字展示不做本地化分组：报告用于机器比对，守住位置 覆盖率数值；改错故障：按语言插入千分位会让复制出的数字无法直接比较。
// INV-17 本组件不发起数据请求：摘要完全由父级注入，守住位置 组件签名；改错故障：内部拉取会让报告在离线打开时出现空面板。
// INV-18 样式类名与既有报告页保持一致：守住位置 各处类名；改错故障：另起类名会让新面板脱离既有排版与主题。
//
// 模块职责：渲染界面渲染器的覆盖率面板，含四项指标、产物路径与文件级或脚本级明细表。
// 状态所有权：无本地状态；所有数据由属性注入，排序与派生值在渲染期一次性计算。
// 阅读顺序：先看无数据早返回，再看派生与元信息，最后看两个表格分支与三个展示辅助函数。
import type { ReactNode } from "react";
import type { UIRendererCoverageSummary } from "../shared/types.js";
import { formatNumber } from "./format.js";

// 面板只消费注入的覆盖率摘要，不关心采集过程
// [失败路径] 摘要缺失是正常状态而不是异常，必须走禁用态分支
// 组件签名保持窄：一个可选对象即可表达全部输入
// 渲染结果与数据一一对应，不做跨渲染缓存
// [权衡] 不拆更细的容器组件，避免为单页报告引入额外层级
export function CoveragePanel({
  coverage,
}: {
  coverage?: UIRendererCoverageSummary;
}) {
  // 无数据时给出明确说明而不是空面板，避免读者误判为采集失败
  // [失败路径] 该分支必须先于任何合计访问，否则缺数据直接抛错
  // 空态与正常态共用 <Panel wide>，保证宽度一致。
  // 说明文案直接面向使用者，不出现 sourceFiles 之类的字段名。
  // 该分支只用 !coverage 判断，不访问可选链。
  if (!coverage) {
    return (
      <Panel title="Coverage" meta="disabled" wide>
        <p className="empty">本次运行没有启用 UI coverage。</p>
      </Panel>
    );
  }

  const sourceFiles = coverage.sourceFiles ?? [];
  // 排序口径：覆盖率低的文件优先暴露，同值再按路径稳定排序
  // [失败路径] 原地排序会污染上游数组，其它消费者顺序被悄悄改变
  // [...sourceFiles] 先展开再 sort，保证入参不可变。
  // lines.pct 同值时用 relativePath.localeCompare() 做次级键。
  // sourceFileRows 只在本组件生命周期内使用，无需 useMemo()。
  // [权衡] 不给 sourceFileRows 做虚拟滚动，报告页文件量级可控。
  const sourceFileRows = [...sourceFiles].sort(
    (left, right) =>
      left.lines.pct - right.lines.pct ||
      left.relativePath.localeCompare(right.relativePath),
  );
  const lineMetric = coverage.totals.lines;
  const meta = lineMetric
    ? `${formatCoverageMetric(lineMetric)} lines · ${sourceFiles.length} files`
    : `${coverage.totals.percent}% bundle bytes · ${coverage.rendererEntryCount} scripts`;

  // 正常态的元信息在行口径与字节口径之间二选一，不混用
  // [失败路径] 同时展示两种口径会让同一标题下的数字互相矛盾
  // Lines/Statements/Functions/Branches 四项指标固定顺序。
  // 产物路径缺失时显示 not mapped 占位而不是留空。
  // lineMetric 存在时走行口径，否则走字节口径。
  // [权衡] `meta` 不展示时间戳：报告时间由页头统一负责。
  return (
    <Panel title="UI Renderer Coverage" meta={meta} wide>
      <div className="coverageMetricGrid">
        <CoverageMetric label="Lines" total={coverage.totals.lines} />
        <CoverageMetric label="Statements" total={coverage.totals.statements} />
        <CoverageMetric label="Functions" total={coverage.totals.functions} />
        <CoverageMetric label="Branches" total={coverage.totals.branches} />
      </div>

      <dl className="coverageArtifacts">
        <div>
          <dt>Istanbul HTML</dt>
          <dd>
            <code>{coverage.files.htmlIndex ?? "n/a"}</code>
          </dd>
        </div>
        <div>
          <dt>LCOV</dt>
          <dd>
            <code>{coverage.files.lcov ?? "n/a"}</code>
          </dd>
        </div>
        <div>
          <dt>Coverage JSON</dt>
          <dd>
            <code>{coverage.files.coverageFinalJson ?? "n/a"}</code>
          </dd>
        </div>
      </dl>

      {sourceFileRows.length > 0 ? (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Lines</th>
                <th>Statements</th>
                <th>Functions</th>
                <th>Branches</th>
                <th>Uncovered lines</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {sourceFileRows.map((file) => (
                <tr key={file.path}>
                  <td>{formatCoverageMetric(file.lines)}</td>
                  <td>{formatCoverageMetric(file.statements)}</td>
                  <td>{formatCoverageMetric(file.functions)}</td>
                  <td>{formatCoverageMetric(file.branches)}</td>
                  <td>{formatUncoveredLines(file.uncoveredLines)}</td>
                  <td>
                    <code>{file.relativePath}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="tableWrap">
          <table>
            <thead>
              <tr>
                <th>Coverage</th>
                <th>Covered bytes</th>
                <th>Total bytes</th>
                <th>Script</th>
              </tr>
            </thead>
            <tbody>
              {coverage.scripts.map((script) => (
                <tr key={script.url}>
                  <td>{formatNumber(script.percent, "%")}</td>
                  <td>{script.coveredBytes}</td>
                  <td>{script.totalBytes}</td>
                  <td>
                    <code>{scriptName(script.url)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// 指标卡只接收标签与可选合计，不感知覆盖率整体结构
// [失败路径] 缺合计时显示占位而不是零，零会被误读为覆盖率为零
// 分子分母同时展示为 covered/total，避免只看 pct 丢失样本量。
// pct 经 formatNumber() 统一格式化，保证各卡片精度一致。
// CoverageMetric 内部无状态，纯由 props 决定输出。
// [权衡] 不为复用再抽小单元：四张卡片差异仅在 `label`。
function CoverageMetric({
  label,
  total,
}: {
  label: string;
  total?: {
    covered: number;
    pct: number;
    total: number;
  };
}) {
  return (
    <div className="coverageMetric">
      <span>{label}</span>
      <strong>{total ? formatNumber(total.pct, "%") : "n/a"}</strong>
      <small>{total ? `${total.covered}/${total.total}` : "not mapped"}</small>
    </div>
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

function formatCoverageMetric(
  total:
    | {
        covered: number;
        pct: number;
        total: number;
      }
    | undefined,
) {
  if (!total) {
    return "n/a";
  }
  return `${formatNumber(total.pct, "%")} (${total.covered}/${total.total})`;
}

function formatUncoveredLines(lines: number[]) {
  if (lines.length === 0) {
    return "-";
  }
  if (lines.length <= 12) {
    return lines.join(", ");
  }
  return `${lines.slice(0, 12).join(", ")} ... +${lines.length - 12}`;
}

function scriptName(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").at(-1) || url;
  } catch {
    return url;
  }
}
