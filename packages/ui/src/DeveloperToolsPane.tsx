/* oxlint-disable eslint(max-lines) -- 开发者工具面板集中展示 token 表和网络 headers，后续继续扩展时再按区块拆分。 */
// DeveloperToolsPane 是「开发者工具」面板的只读展示层：把 useSessionDebug 每秒轮询回来的会话调试快照
// 渲染成 token 汇总、逐轮 token 表与可展开的网络请求 headers，所有数值统一经下方 formatXxx 格式化。
// 不负责采集与订阅（hooks/useSessionDebug）、指标聚合口径（shared/session-debug）、headers 脱敏以及面板开关与路由。
//
// 展示口径：缺失值显示短横线而不是 0；比例字段是 0~1 的比率，由 Intl percent 换算；
// 时间按 locale 输出时分秒，非法时间戳回落到宿主记录时刻；网络条目最新在前，token 轮次保持后端顺序。
// 面板无 state、无 effect、无缓存：看起来可以顺手加 useMemo 或请求的地方都是刻意留白的。
//
// INV-01 断言：面板对 debug 数据只读、不派生新事实 —— 守住它的位置：DeveloperToolsPane 内所有取值与 formatXxx —— 改错故障：出现第二份统计口径，汇总与表格对不上。
// INV-02 断言：缺失数值一律渲染短横线而不是 0 —— 守住它的位置：formatNumber/formatPercent/formatMilliseconds 的早退分支 —— 改错故障：未返回的 token 显示成 0，用户误判用量与缓存全部失效。
// INV-03 断言：格式化的比例入参是 0~1 的比率 —— 守住它的位置：formatPercent 交给 Intl percent style —— 改错故障：调用点先乘 100 会显示成 8500% 量级。
// INV-04 断言：百分比下限被夹到 0 —— 守住它的位置：formatPercent 的 Math.max(0, value) —— 改错故障：异常比率显示成负数百分比，看起来像数据损坏。
// INV-05 断言：时间戳解析失败时回落到宿主记录时刻 —— 守住它的位置：formatTimestamp 的 Number.isFinite 三元 —— 改错故障：格式化 Invalid Date 抛 RangeError，整块面板白屏。
// INV-06 断言：网络条目倒序只作用于副本 —— 守住它的位置：networkEntries 的展开与 reverse —— 改错故障：就地 reverse 改写 hook 快照，其他消费者顺序反转。
// INV-07 断言：statusType 到消息 id 的映射穷尽且无 default —— 守住它的位置：networkStatusLabelId 的 switch —— 改错故障：新增状态返回 undefined，formatMessage 抛错导致列表崩溃。
// INV-08 断言：表格表头列数与空态 colSpan 恒为 9 —— 守住它的位置：thead 的 th 数量与空态行的 colSpan —— 改错故障：空态只占 8 列，右侧缺一条表格边框。
// INV-09 断言：逐轮表格与网络列表的空态结构互相独立 —— 守住它的位置：rounds 空态行与 networkEntries 空态卡片 —— 改错故障：合并后无数据时仍显示表头，或空态吃掉整块区域。
// INV-10 断言：headers 排序不改写入参对象 —— 守住它的位置：HeaderDetails 的 Object.entries 排序 —— 改错故障：快照对象被改写，键顺序在轮询间跳变。
// INV-11 断言：折叠展开由原生 details 持有 —— 守住它的位置：HeaderDetails 的 details/summary —— 改错故障：改成受控 state 后秒级轮询会重置展开态。
// INV-12 断言：TPS 直接取后端预算值，不在渲染期重算 —— 守住它的位置：round.tokensPerSecond 及其 null 分支 —— 改错故障：用总 token 除总耗时会在流式未结束时算出偏低瞬时值。
// INV-13 断言：重试分母为 0 时显示为无穷 —— 守住它的位置：attempt 与 maxAttempts 的拼接三元 —— 改错故障：显示 1/0，用户以为重试额度已耗尽。
// INV-14 断言：可选字段仅在存在时占位渲染 —— 守住它的位置：baseURL 与 message 的条件分支 —— 改错故障：空串仍占一行，卡片高度在请求间跳动。
// INV-15 断言：enabled 缺省为 true 且原样透传给 hook —— 守住它的位置：export function DeveloperToolsPane 的默认参数 —— 改错故障：默认 false 时嵌入非激活页签的面板永远空白。
// INV-16 断言：面板滚动发生在中间容器内 —— 守住它的位置：根节点 h-full 与中间区 min-h-0 flex-1 overflow-auto —— 改错故障：长 headers 撑破面板，整页跟着滚动。
import { ActivityIcon, BugIcon, NetworkIcon } from "lucide-react";
import type { SessionDebugNetworkEntry } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSessionDebug } from "@/hooks/useSessionDebug.js";

// [契约] 四个入参都由外层开发者工具容器注入，面板自身不读取路由、store 或平台服务。
// taskId 为 null 表示当前没有活动任务；hook 会直接返回空快照，这里不能提前 return 或渲染占位。
// workspaceIdentity 与 workspacePath 分开传：身份隔离用前者、文件与展示用后者，不要把两者合并成一个值。
// enabled 在此声明为可选，默认值只在组件形参处定义一次，别在调用方再补一套默认。
interface DeveloperToolsPaneProps {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string | null;
  enabled?: boolean;
}

// [契约] 返回字符串而不是数字：所有调用点都直接嵌进 JSX 文本，不再二次格式化。
// undefined 与 NaN/Infinity 一并显示为短横线：流式未结算时 token 字段确实可能缺省。
// 0 是有效值必须原样显示，不能与缺省共用同一个哨兵，否则零用量会被读成无数据。
// 不要在调用点写 value ?? 0 兜底：那会把「未知」变成真实的 0 用量写进表格。
function formatNumber(locale: string, value: number | undefined): string {
  // [契约] 只判 undefined 与非有限数值，不判 null：形参类型已排除 null，而 formatPercent 才允许 null。
  // Number.isFinite 同时挡住 NaN 与 ±Infinity，否则 Infinity 会被 Intl 格式化成无穷符号。
  // 不要简化成 if (!value)：0 会被当作缺省，正好丢掉「本轮零 token」这条真实信息。
  // 这个函数是逐轮表格多个数字列的唯一入口，绕过它直接拼字符串会让列宽与对齐整体失衡。
  if (value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat(locale).format(value);
}

// [契约] 入参是 0~1 的比率，乘 100 交给 Intl 的 percent style，调用点不要先乘。
// maximumFractionDigits 固定 1：表格里百分比列宽才能稳定，不随长小数左右抖动。
// 不要改成 toFixed 再拼百分号：阿拉伯语等 locale 的百分号位置与数字方向都不同。
// 该函数同时服务命中率汇总与逐轮命中率列，两边口径必须保持同一套格式化。
function formatPercent(locale: string, value: number | null | undefined): string {
  // [失败路径] 这里必须同时接受 null：cache 快照整体可空，hitRate 会以 null 透传进来。
  // 三个条件缺一不可，顺序按可读性排：null 与 undefined 分开写，避免日后被合并成 !value。
  // 早退返回短横线而不是 0%：命中率未知与命中率为零在排障上是完全不同的结论。
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 1,
    style: "percent",
  }).format(Math.max(0, value));
}

// [契约] 单位后缀硬编码为毫秒，数值本身不再带单位，避免出现重复单位的拼接。
// 小数位固定 0：亚毫秒抖动对调试无意义，还会让同一列数字宽度来回跳。
// durationMs 缺失时由调用点改用 idleMs 兜底，因此这里只负责格式化，不负责挑字段。
// 秒级以上时间走 formatTimestamp，不要在这里做单位自动换算，否则列内单位不一致。
function formatMilliseconds(locale: string, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "-";
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} ms`;
}

// `formatTimestamp` 只输出时分秒以省列宽：条目按时间倒序排列，跨天由相邻记录自行区分。
// fallback 由调用点传入 entry.recordedAt，保证 timestamp 缺失时仍有可比较的宿主时刻。
// Date.parse 对空串与非法串都返回 NaN，因此必须先判 value 真值再解析。
// 用 Intl.DateTimeFormat 而不是 toLocaleTimeString，避免不同运行时默认选项不一致。
// 若把 fallback 改成直接返回短横线，倒序列表里会出现无法排序的占位，用户失去先后感。
function formatTimestamp(locale: string, value: string | undefined, fallback: number): string {
  // [契约] 解析失败统一落到 NaN，再由下一行三元决定是否采用 fallback，两步不要合并。
  // 不要写成一步式的取值加兜底：非法串会被当成有效时间直接格式化。
  // Date.parse 对 2 月 30 日这类非法日期会静默滚动到下月，这是可接受的显示近似。
  const parsedTimestamp = value ? Date.parse(value) : Number.NaN;
  // [契约] 这一行是「解析结果不可用则回落」的唯一决策点，后续格式化不再做二次判断。
  // fallback 是宿主记录时刻，通常比请求内时间戳更晚，缺失时用它仍能保持倒序可读。
  // 不要在这里做时区换算：Intl 已按 locale 的时区规则输出，手写偏移会双重偏移。
  // 若 fallback 也非有限数值，格式化拿到的仍是非法日期，所以调用方必须传真实毫秒数。
  const timestamp = Number.isFinite(parsedTimestamp) ? parsedTimestamp : fallback;
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(timestamp));
}

// [契约] statusType 到 i18n key 的映射必须穷尽 SessionDebugNetworkEntry 状态枚举的每个成员。
// 函数没有 default 分支：新增状态时由返回值类型检查逼着补 case，而不是静默返回 undefined。
// 返回的是消息 id 而非文案，locale 切换时由调用方的 formatMessage 重新取词。
// 不要在 case 里直接调用 intl：该函数在列表 map 中被逐条调用，保持纯函数才能安全复用。
// 不要把 key 改成模板字符串拼接：i18n 抽取只能识别静态 id，动态拼接会直接缺译文。
function networkStatusLabelId(statusType: SessionDebugNetworkEntry["statusType"]): string {
  // [契约] case 顺序对应一次请求的生命周期，仅便于对照后端事件流阅读，不参与逻辑。
  // 每个 case 都 return 而不是 break：漏写 return 会让失败状态落进下一个状态的文案。
  // 不要补 default 兜底文案：那会让新增状态静默显示成旧状态，排障时被彻底误导。
  // 分支里不做任何格式化或兜底取值，状态到文案的映射保持一一对应。
  switch (statusType) {
    case "model_request_started":
      return "developerTools.network.status.started";
    case "model_request_completed":
      return "developerTools.network.status.completed";
    case "model_request_failed":
      return "developerTools.network.status.failed";
    case "model_retry_scheduled":
      return "developerTools.network.status.retry";
    case "model_stream_stalled":
      return "developerTools.network.status.stalled";
  }
}

// [契约] 折叠用原生 details/summary，面板不持有展开状态，重渲染不会丢用户已展开的面板。
// title 里的条数来自 requestHeaderCount / responseHeaderCount，可能与 headers 实际条数不一致。
// 排序只在渲染期对副本做，headers 是 hook 快照里的对象引用，不能就地改写。
// 空态与有态共用同一个 details，从空到有时展开状态被保留，这是刻意的行为。
// [权衡] 不在此处脱敏 header：脱敏属于采集侧责任，面板如实展示，改动会掩盖真实请求头。
function HeaderDetails({
  title,
  headers,
  emptyLabel,
}: {
  title: string;
  headers: Record<string, string>;
  emptyLabel: string;
}) {
  // [契约] Object.entries 已返回新数组，但排序仍只作用于它，绝不碰 headers 原对象。
  // localeCompare 不传 locale：保证不同机器、不同语言下顺序一致，便于对照截图与日志。
  // 只按 key 排序，value 不参与比较，同名 header 的先后保持输入顺序。
  // dt/dd 用 contents 参与父级两列 grid，这里再套一层容器会让键值错行。
  const entries = Object.entries(headers).sort(([left], [right]) => left.localeCompare(right));
  return (
    <details className="border-t border-border px-3 py-2">
      <summary className="cursor-default select-none text-ui-xs font-medium text-foreground-subtle">
        {title}
      </summary>
      {entries.length === 0 ? (
        <div className="pt-2 text-ui-xs text-foreground-subtle">{emptyLabel}</div>
      ) : (
        <dl className="grid grid-cols-[minmax(7rem,0.35fr)_minmax(0,1fr)] gap-x-3 gap-y-1 pt-2 text-ui-xs">
          {entries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="min-w-0 break-all font-mono text-foreground-subtle">{key}</dt>
              <dd className="min-w-0 break-all font-mono text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </details>
  );
}

// [契约] enabled 默认 true：面板被挂载即视为需要数据，容器不必显式传值。
// 组件不持有 state，也没有 effect：全部展示状态来自 hook 与 intl，重渲染是幂等的。
// 不要在这里派生命中率、TPS 等指标：口径归 hook 与 shared，面板只负责格式化与排版。
// taskId 或 workspaceIdentity 变化时由 hook 依据 scopeKey 丢弃旧快照，组件不写清理逻辑。
// [权衡] 面板内不加 ErrorBoundary：脏数据导致的渲染异常由外层容器兜底，避免出现第二套兜底分支。
export function DeveloperToolsPane({
  workspacePath,
  workspaceIdentity,
  taskId,
  enabled = true,
}: DeveloperToolsPaneProps) {
  // [契约] locale 显式传给所有 formatXxx，不读 navigator.language，保证数字格式与界面语言一致。
  // intl 与 locale 必须来自同一个 Provider 实例，混用会出现文案语言与数字格式不匹配。
  // 不要在组件内缓存 formatMessage 结果，locale 切换后必须重新取词。
  const { intl, locale } = useZCodeIntl();
  // [契约] debug 数据的唯一入口：组件不直接访问服务、store 或平台 API。
  // 传参保持字段同名简写，workspaceIdentity 的路径回退在 hook 内部完成，不要在这里拼接。
  // enabled 原样透传，不做取反或额外判断：关闭态下由 hook 自行停止轮询。
  // error 为 true 时 hook 保留上一次快照，因此提示条只能提示、不能据此清空下方区块。
  // 每一次轮询都会产出新数组与新对象，不要把这些引用塞进 memo 或 effect 依赖做等值判断。
  const debugState = useSessionDebug({ workspacePath, workspaceIdentity, taskId, enabled });
  // [契约] 副本倒序：hook 按时间正序返回，面板要从最新一条往下读。
  // reverse 必须在展开出的副本上做，就地倒序会改写 hook 快照数组，其他消费者顺序随之反转。
  // 每次渲染都得到新数组，因此该值不稳定，不能作为 memo 或 effect 的依赖。
  // 不要改成按时间戳排序：同一次重试的多条事件时间戳可能相同，稳定倒序更贴合记录顺序。
  const networkEntries = [...debugState.networkEntries].reverse();

  // [契约] 根节点 h-full 加 flex-col：高度完全由父容器决定，面板不设固定高度。
  // 中间区 min-h-0 加 overflow-auto 是面板内滚动的唯一来源，去掉任一项长 headers 就会撑破布局。
  // 两个 section 的间距统一由 space-y-5 控制，不要在单个 section 上再补 margin。
  // 以下全是 JSX 子节点，新增逻辑要放回渲染前的变量区，不要在 JSX 里做计算或条件赋值。
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-testid="developer-tools-pane">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <BugIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "developerTools.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">
        {debugState.error ? (
          <div role="alert" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "developerTools.loadError" })}
          </div>
        ) : null}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <ActivityIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "developerTools.tokenSection" })}
            </h3>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-ui-base text-foreground-subtle">
            <span>{intl.formatMessage({ id: "tokenDebug.summary.requests" })}</span>
            <span className="font-mono text-foreground">
              {formatNumber(locale, debugState.cache?.hitRateRequestCount)}
            </span>
            <span>{intl.formatMessage({ id: "tokenDebug.summary.average" })}</span>
            <span className="font-mono text-foreground">
              {formatPercent(locale, debugState.cache?.hitRate)}
            </span>
            <span>{intl.formatMessage({ id: "tokenDebug.summary.input" })}</span>
            <span className="font-mono text-foreground">
              {formatNumber(locale, debugState.cache?.totalInputTokens)}
            </span>
            <span>{intl.formatMessage({ id: "tokenDebug.summary.cacheRead" })}</span>
            <span className="font-mono text-foreground">
              {formatNumber(locale, debugState.cache?.totalCacheReadTokens)}
            </span>
          </div>
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full min-w-[38rem] border-collapse text-ui-xs">
              <thead className="sticky top-0 bg-background text-foreground-subtle">
                <tr className="border-b border-border">
                  <th className="px-2 py-1.5 text-left font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.round" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.input" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.output" })}
                  </th>
                  <th
                    className="px-2 py-1.5 text-right font-medium"
                    title={intl.formatMessage({ id: "tokenDebug.tpsDescription" })}
                  >
                    {intl.formatMessage({ id: "tokenDebug.column.tps" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.total" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.reasoning" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.cacheRead" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.cacheWrite" })}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {intl.formatMessage({ id: "tokenDebug.column.hitRate" })}
                  </th>
                </tr>
              </thead>
              <tbody>
                {debugState.rounds.length === 0 ? (
                  <tr>
                    <td className="px-2 py-3 text-center text-foreground-subtle" colSpan={9}>
                      {intl.formatMessage({ id: "tokenDebug.empty" })}
                    </td>
                  </tr>
                ) : (
                  debugState.rounds.map((round) => (
                    <tr key={round.eventKey} className="border-b border-border last:border-b-0">
                      <td className="px-2 py-1.5 font-mono text-foreground">
                        {formatNumber(locale, round.requestIndex)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.inputTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.outputTokens)}
                      </td>
                      <td
                        className="px-2 py-1.5 text-right font-mono text-foreground"
                        data-testid="token-debug-tps"
                      >
                        {round.tokensPerSecond === null
                          ? "—"
                          : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                              round.tokensPerSecond,
                            )}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.totalTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.reasoningTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.cachedInputTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatNumber(locale, round.usage.cachedWriteInputTokens)}
                      </td>
                      <td className="px-2 py-1.5 text-right font-mono text-foreground">
                        {formatPercent(locale, round.hitRate)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <NetworkIcon className="size-4 text-foreground-subtle" aria-hidden="true" />
            <h3 className="text-ui-base font-semibold text-foreground">
              {intl.formatMessage({ id: "developerTools.networkSection" })}
            </h3>
          </div>
          {networkEntries.length === 0 ? (
            <div className="rounded-md border border-border px-3 py-4 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "developerTools.network.empty" })}
            </div>
          ) : (
            <div className="space-y-2">
              {networkEntries.map((entry) => (
                <div
                  key={entry.eventKey}
                  className="overflow-hidden rounded-md border border-border"
                >
                  <div className="space-y-2 px-3 py-2">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-ui-base font-semibold text-foreground">
                          {intl.formatMessage({ id: networkStatusLabelId(entry.statusType) })}
                        </div>
                        <div className="truncate font-mono text-ui-xs text-foreground-subtle">
                          {entry.requestId ?? entry.eventKey}
                        </div>
                      </div>
                      <div className="shrink-0 font-mono text-ui-xs text-foreground-subtle">
                        {formatTimestamp(locale, entry.timestamp, entry.recordedAt)}
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-ui-xs text-foreground-subtle">
                      <span>{intl.formatMessage({ id: "developerTools.network.model" })}</span>
                      <span className="min-w-0 truncate font-mono text-foreground">
                        {entry.modelId ?? "-"}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.provider" })}</span>
                      <span className="min-w-0 truncate font-mono text-foreground">
                        {entry.providerId ?? entry.providerKind ?? "-"}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.attempt" })}</span>
                      <span className="font-mono text-foreground">
                        {entry.attempt !== undefined && entry.maxAttempts !== undefined
                          ? `${entry.attempt}/${entry.maxAttempts === 0 ? "∞" : entry.maxAttempts}`
                          : "-"}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.http" })}</span>
                      <span className="font-mono text-foreground">
                        {formatNumber(locale, entry.statusCode)}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.duration" })}</span>
                      <span className="font-mono text-foreground">
                        {formatMilliseconds(locale, entry.durationMs ?? entry.idleMs)}
                      </span>
                      <span>{intl.formatMessage({ id: "developerTools.network.retryDelay" })}</span>
                      <span className="font-mono text-foreground">
                        {formatMilliseconds(locale, entry.delayMs)}
                      </span>
                    </div>
                    {entry.baseURL ? (
                      <div className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtle">
                        {entry.baseURL}
                      </div>
                    ) : null}
                    {entry.message ? (
                      <div className="break-words rounded-md bg-surface px-2 py-1.5 text-ui-xs text-foreground">
                        {entry.message}
                      </div>
                    ) : null}
                  </div>
                  <HeaderDetails
                    title={intl.formatMessage(
                      { id: "developerTools.network.requestHeaders" },
                      { count: formatNumber(locale, entry.requestHeaderCount) },
                    )}
                    headers={entry.requestHeaders}
                    emptyLabel={intl.formatMessage({ id: "developerTools.network.noHeaders" })}
                  />
                  <HeaderDetails
                    title={intl.formatMessage(
                      { id: "developerTools.network.responseHeaders" },
                      { count: formatNumber(locale, entry.responseHeaderCount) },
                    )}
                    headers={entry.responseHeaders}
                    emptyLabel={intl.formatMessage({ id: "developerTools.network.noHeaders" })}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
