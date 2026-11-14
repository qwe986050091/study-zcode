/**
 * 调试台单页应用。
 *
 * 职责：按项目/trace 组织三个视图——Trace 时间线与上下文/缓存面板、执行甘特图、网络抓包页；
 * 订阅 SSE 观测变更后自动刷新列表与详情。
 * 数据口径：列表与详情均来自 `/api/traces*`，查询参数由 `buildQuery(inputs)` 统一生成；
 * 网络请求由独立的 `useNetworkCapture` 维护，并与 trace span 合并展示。
 * 副作用：本地存储记录最近项目；修改 URL hash 切换视图；建立 SSE 连接。
 * 失败语义：请求错误展示为顶部告警并保留上一次数据；SSE 断开由状态条提示并自动重连。
 * 不变量：trace 选择始终在列表内（刷新后若失效则回落到首条），避免详情与列表错位。
 */
// INV-1: trace 选择必须始终落在列表内 —— 破坏后果：刷新后选中项指向已消失的 trace，
// 详情请求返回 404 或空 spans，甘特图与上下文面板同时变空，用户会误判「这一轮没有执行」。
// INV-2: inputs 变化只经由 buildQuery 生成查询串 —— 破坏后果：若某处直接拼 URL，
// 空字段会被写成 projectId=，后端按空值过滤而非不过滤，列表会突然清空。
// INV-3: 列表/详情请求失败只写 error，绝不清空 traces/detail —— 破坏后果：SSE 抖动一次就会
// 把已渲染的时间线与甘特图整体抹白，用户无法区分「真的没有数据」和「暂时取不到」。
// INV-4: 观测流的刷新必须被 180ms 窗口合并 —— 破坏后果：一次写盘风暴会触发几十次并发
// fetch，SQLite 侧被读放大，同时 loading 指示器反复翻转，页面观感是持续闪烁。
// INV-5: 每个 query 对应且仅对应一条 EventSource，且卸载时必须 close —— 破坏后果：切换项目
// 后旧连接仍存活，它收到 change 时用的是旧 query 的闭包，会拿旧路径的数据覆盖新面板。
// INV-6: 网络请求以 id 为唯一键 upsert，列表按 startedAt 倒序并截断 200 条 —— 破坏后果：
// 改成按到达顺序追加时，snapshot 全量与增量 request 会重复渲染同一条请求。
// INV-7: 只把 traceId 恰等于当前 trace 的抓包请求并入 span —— 破坏后果：未归因请求进入
// 甘特图后，用户会以为它属于本 trace，据此判断耗时与顺序必然出错。
// INV-8: vis-timeline 实例全生命周期只创建一次，数据经 setData 替换，卸载时 destroy ——
// 破坏后果：随渲染重建实例会泄漏 DOM 与事件监听，且丢失用户当前的缩放/平移位置。
// INV-9: 选中 span 必须存在于当前 visibleSpans，否则回落到首条 —— 破坏后果：trace 切换后
// 详情区停留在已删除的 span 上，展示的 payload 与画布选中的色块不一致。
// INV-10: view 与 URL hash 单向以 hash 为外部真相 —— 破坏后果：双向回写会在 hashchange
// 监听中互相触发，形成 address bar 抖动与多余渲染。
// INV-11: 仅当 projectId 非空时才写 localStorage —— 破坏后果：首帧空值会把上次记忆项目
// 覆盖成空串，下次打开永远回落到「全部项目」。
// INV-12: SSE 监听器内部的事件解析失败必须静默丢弃，不得抛错 —— 破坏后果：单个畸形帧
// 抛出的异常会中断该 EventSource 后续所有回调，实时状态从此不再更新。
// INV-13: buildQuery 只输出 trim 后非空的字段 —— 破坏后果：把空字段也拼进去时，后端
// 「不过滤」与「按空串过滤」两种语义会被混淆，同一 URL 出现两种结果。
// INV-14: 占比条形宽度取 max(percent*100, 2)% —— 破坏后果：极小占比会退化成不可见宽度，
// 用户以为该分类缺失；注意这只是渲染下限，列表里的百分比仍是真实值。
// INV-15: 详情请求失败只写 error，不清 sources —— 破坏后果：一次 404 会把来源列表清空，
// 用户无法判断是「文件没了」还是「请求失败」，只能刷新整页重来。
// INV-16: SSE 的 hello/change 帧整对象覆盖 state，不做字段级合并 —— 破坏后果：合并会让
// 上一次的 lastChangeAt 残留，状态条显示的「最后变更」永远停在第一次。
// INV-17: trace 列表与抓包列表是两条独立链路，任一失败不得阻塞另一条 —— 破坏后果：
// 代理未启动时抓包首屏必失败，若共享错误态，trace 视图也会被一条无关告警挡住。
// INV-18: 甘特图 item 的 end 必须晚于 start，运行中的段用当前时刻补齐 —— 破坏后果：
// 缺失 end 时被画成 point 可接受，但 end 早于 start 会得到负宽度，条目直接不可见。
// INV-19: 全屏态只在组件内，不写 URL 也不持久化 —— 破坏后果：持久化后下次打开即全屏，
// 而 Esc 监听要等挂载后才生效，用户会在首帧找不到退出入口。
// INV-20: 环境变量为空时复制动作必须短路 —— 破坏后果：复制空串会清空用户剪贴板里
// 原本的内容，且提示「已复制」，属于不可逆的静默数据丢失。
// INV-21: 缓存报告只取最后一条，历史报告不参与渲染 —— 破坏后果：堆叠展示会让当前
// 命中率淹没在一堆旧数字里，用户以为缓存策略没生效。
// INV-22: 时间解析失败时原样返回输入字符串 —— 破坏后果：统一吞成占位符会让「后端
// 给了非法时间」这一真实缺陷变得不可见，排查时只能靠猜。
import {
  AlertTriangle,
  BarChart3,
  Check,
  Clock3,
  Clipboard,
  Database,
  FileJson,
  Globe2,
  Layers3,
  Maximize2,
  Minimize2,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Timeline as VisTimeline } from "vis-timeline/standalone";
import type {
  DataGroup as VisTimelineGroup,
  DataItem as VisTimelineItem,
  TimelineOptions,
} from "vis-timeline/standalone";
import "vis-timeline/styles/vis-timeline-graph2d.min.css";
import type {
  CacheReport,
  ContextSectionSource,
  ContextSnapshotView,
  ContextUsageSnapshotView,
  ContextUsageSource,
  NetworkCaptureStatus,
  NetworkRequestRecord,
  NetworkRequestsResponse,
  ObservationChangeEvent,
  ObservationHelloEvent,
  ObservationSourceErrorEvent,
  ProjectSummary,
  SourceStatus,
  TokenConfidence,
  TokenMethod,
  TimelineItem,
  TraceDetailResponse,
  TraceListResponse,
  TraceSpan,
  TraceSpanLane,
  TraceSummary,
} from "./shared";
import { ganttItemStyle } from "./gantt-style";

// INV-15: 空态判定一律基于「数组长度为 0」，不能用 detail 是否为 null —— 破坏后果：请求成功
// 但该 trace 确实没有 span 时，面板会一直显示加载骨架而不是「没有可渲染的执行段」。
// INV-16: gantt item 的 id 必须全局唯一（网络段加 `network:` 前缀）—— 破坏后果：与 trace span
// 的 id 撞车时 vis-timeline 只保留后者，抓包泳道少段且选中回调指向错误的 span。
// INV-17: SSE 的 connected 状态只由连接事件驱动，不由请求成功驱动 —— 破坏后果：把 fetch 成功
// 当成实时连通，用户会在流已断开时仍相信面板上的数据是最新的。
// INV-18: 所有对外展示的时间都经过 formatTime 的本地化 —— 破坏后果：直接渲染 ISO 串会让
// 时间线与甘特图出现 UTC/本地两套时间，肉眼对齐事件顺序时得出相反结论。
interface SourceInputs {
  // 五个字段一一对应后端 /api/traces 的查询参数；空串语义是「该维度不参与过滤」，
  // 因此这里不能把 undefined 与空串混用：buildQuery 只按 trim 后的真值决定是否输出。
  projectId: string;
  // 日志目录与事件文件是两个独立数据源，允许只给其中一个；两者都空时后端回落到默认工作区。
  logDir: string;
  eventPath: string;
  // SQLite 路径决定 trace 列表的来源；不传时后端可能读不到任何 trace，前端只显示空列表。
  dbPath: string;
  // sessionId 用于把视图收窄到单个 CLI 会话，是排查「同一项目多会话串台」的唯一过滤手段。
  sessionId: string;
}

// 观测流自身的健康状态，与数据源可用性（SourceStatus）分开：后者描述「源文件是否可读」，
// 前者描述「推送通道是否活着」，两者任一不健康都可能导致面板停在旧数据上。
interface ObservationEventState {
  connected: boolean;
  error: string | null;
  // 把 lastChangeAt 换成 Date.now() 会漏掉断线期间的服务端变更。
  lastChangeAt?: string;
  // hello/change 都会带全量 watchedPaths，这里只存数量用于状态条展示。
  watchedPathCount: number;
}

// 所有输入初始为空对象而不是 undefined：受控 select 的 value 必须是字符串，
// 用 undefined 会触发 React 的受控/非受控切换告警，并让 select 显示错位。
const emptyInputs: SourceInputs = {
  projectId: "",
  logDir: "",
  eventPath: "",
  dbPath: "",
  sessionId: "",
};

// 键名带命名空间前缀：同源下可能并存旧版 trace 浏览器，裸键会互相覆盖记忆项目。
const lastProjectStorageKey = "zcode-debug:last-project-id";
// 三种 shell 是封闭集合：新增成员必须同时补 formatEnvCommand 的引号分支，
// 否则会静默落到 POSIX 分支，用户粘到 PowerShell 里得到语法错误的命令。
type EnvShell = "posix" | "powershell" | "cmd";
// 视图同时决定渲染分支与 URL hash；新增视图要同步 viewFromHash 白名单，否则刷新即回落。
type DebugView = "trace" | "gantt" | "network";

// 显式枚举而非字符串硬编码：按钮渲染顺序即此处的声明顺序，三种 shell 不会各排各的。
const envShellLabels: Record<EnvShell, string> = {
  posix: "POSIX",
  powershell: "PowerShell",
  cmd: "CMD",
};

// Record<DebugView, string> 而非数组：新增视图时类型检查强制补标签；
// 同时 Object.keys 的遍历顺序与声明顺序一致，可直接驱动 tab 渲染。
const viewLabels: Record<DebugView, string> = {
  trace: "Trace",
  gantt: "甘特图",
  network: "网络请求",
};

// 泳道顺序是产品语义而非数据顺序：Turn → Model → Tool 体现因果，存储/日志/事件垫底。
// 若改成「按数据中首次出现的顺序」，同一 trace 两次打开会得到不同纵向布局，截图无法对比。
const laneOrder: TraceSpanLane[] = [
  "turn",
  "model",
  "tool",
  "permission",
  "subagent",
  "network",
  "storage",
  "log",
  "event",
];

// 标签与顺序分开维护：本表只管措辞，laneOrder 决定布局；合并成一份数组会让改文案
// 变成改顺序的风险动作。
const laneLabels: Record<TraceSpanLane, string> = {
  turn: "Turn",
  model: "模型",
  tool: "工具",
  network: "网络",
  permission: "权限",
  storage: "存储",
  subagent: "子 Agent",
  event: "事件",
  log: "日志",
};

// 文本快照的四个来源是后端 ContextSection 的封闭分类；多出来的来源会被
// groupSections 保留但取不到标签，因此新增来源必须两处同时补。
const sourceLabels: Record<ContextSectionSource, string> = {
  system_prompt: "系统",
  skills: "技能",
  tools: "工具",
  other: "其他",
};

// tone-* 是样式文件里的约定类名，不是可随意改名的高亮；改名而不同步 CSS
// 会让条形图所有段一起变成透明。
const sourceClasses: Record<ContextSectionSource, string> = {
  system_prompt: "tone-system",
  skills: "tone-skills",
  tools: "tone-tools",
  other: "tone-other",
};

// 占用快照的粒度比文本快照细（多出 meta user、MCP、系统工具 schema 等），
// 因此不能复用 sourceLabels：两套枚举并不等价，强行合并会丢分类。
const usageSourceLabels: Record<ContextUsageSource, string> = {
  system_prompt: "系统提示",
  meta_user_context: "Meta User 上下文",
  skills: "技能",
  tool_prompt: "工具提示",
  system_tool_schemas: "系统工具",
  mcp_tool_schemas: "MCP 工具",
  messages: "消息",
  other: "其他",
};

// 必须与 usageSourceLabels 同键：label 表新增来源而此处漏补时，条形段会失去颜色
// 而不报错——用户只看到一段空白，最容易误判成「没有这类占用」。
const usageSourceClasses: Record<ContextUsageSource, string> = {
  system_prompt: "tone-system",
  meta_user_context: "tone-meta-user",
  skills: "tone-skills",
  tool_prompt: "tone-tools",
  system_tool_schemas: "tone-tool-schema",
  mcp_tool_schemas: "tone-mcp",
  messages: "tone-messages",
  other: "tone-other",
};

/**
 * 应用根组件：管理查询条件、trace 列表/详情与视图切换。
 * 数据流：inputs → query → loadTraces/loadTraceDetail；SSE 变更回调直接触发两者刷新。
 * 副作用：首次加载、项目记忆写入 localStorage、hash 与视图双向同步。
 * 失败语义：请求异常写入 `error` 并在 UI 提示，不清空已有列表/详情。
 */
export function App() {
  // 查询条件与选中 trace 分开存：inputs 决定「取哪些数据」，traceId 只决定「看哪一条」。
  // 合成一个对象会让切换 trace 也触发列表重取（loadTraces 依赖 query），白白多一轮请求。
  const [inputs, setInputs] = useState<SourceInputs>(emptyInputs);
  // 空串代表「尚未选中」，而不是「默认选中第一条」：自动选中发生在 loadTraces 成功之后，
  // 否则首帧会先对空 traceId 发一次详情请求，再补发一次，凭空制造两条请求与竞态。
  const [traceId, setTraceId] = useState("");
  // traces/projects/sources 来自同一次列表响应却分开存，是为了让各面板按需重渲染；
  // 它们必须同批 setState（React 会合并更新），否则会出现「列表已新、来源仍旧」的中间帧。
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  // detail 保留上一次成功结果（失败不清空），它是甘特图与上下文面板的唯一数据源。
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  // 惰性初始化只在首次挂载读一次 hash：之后 hash 变化由独立的 hashchange 监听器接管，
  // 若放进依赖数组会让每次 setView 都重建监听。
  const [view, setView] = useState<DebugView>(() => viewFromHash(window.location.hash));
  // 过滤词放在 App 而不是 NetworkPage：切走再切回时草稿仍在，避免用户重输。
  const [networkFilter, setNetworkFilter] = useState("");
  // loading 是全局单标志：列表与详情并发时任一结束都会置 false，这是已知的乐观取舍，
  // 只影响加载指示器的精度，不影响数据正确性。
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 抓包状态与 trace 数据完全解耦：它有自己的 SSE 与生命周期，失败不能影响 trace 视图。
  const network = useNetworkCapture();

  // query 只随 inputs 变化：它是所有请求与 SSE 订阅的共同 key，一旦多依赖（比如 traceId），
  // 切换 trace 就会重建 SSE 连接并重取整个列表，实时流会周期性断档。
  const query = useMemo(() => buildQuery(inputs), [inputs]);
  // spans 是「trace 详情 + 已归因抓包」的合并视图，依赖必须含 network.requests：
  // 漏掉它时抓包泳道只有首次渲染出现，后续增量请求不会进入甘特图。
  const spans = useMemo(
    () => mergeNetworkSpans(detail?.spans ?? [], network.requests, traceId),
    [detail?.spans, network.requests, traceId],
  );
  // 用 replaceState 而不是 pushState：视图切换属于同一调试会话内的分页，不该污染浏览器
  // 历史，否则用户按「后退」要逐页退过所有 tab 才能离开页面。
  const setDebugView = useCallback((nextView: DebugView) => {
    setView(nextView);
    window.history.replaceState(null, "", `#${nextView}`);
  }, []);
  // 回调保持稳定引用：TraceSelect 是受控 select，内联箭头函数会让它在每次 App 渲染时
  // 重新挂载 option 列表，滚动位置与展开态都会丢。
  const selectTrace = useCallback((nextTraceId: string) => {
    setTraceId(nextTraceId);
  }, []);

  // 列表加载同时兼任「项目发现」：首次进入没有任何 inputs 时，靠这次响应的 projects 反推
  // 该打开哪个项目，避免用户在空面板上还要手填路径。
  const loadTraces = useCallback(async () => {
    // 先清 error 再发请求：否则重试期间旧告警一直挂着，用户无法判断这次重试有没有生效。
    setLoading(true);
    setError(null);
    try {
      const response = await fetchJson<TraceListResponse>(`/api/traces${query}`);
      // 三个 setState 放在同一 try 内连续执行：React 18 会合并为一次渲染，
      // 若拆到不同异步阶段，中间帧会出现「项目列表新、来源记录旧」的错配。
      setTraces(response.traces);
      setProjects(response.projects);
      setSources(response.sources);

      // 只在「用户还没选项目」时自动补选：已有 projectId 说明是用户或上次记忆的决定，
      // 此时再改写会把他手动选的项目顶掉，表现为选择框自己跳回第一个。
      if (!inputs.projectId && response.projects.length > 0) {
        const lastProjectId = window.localStorage.getItem(lastProjectStorageKey);
        // 记忆项目可能已被删除，因此 find 命中优先、否则取第一个；
        // 直接使用 lastProjectId 会让 select 的 value 不在 option 里，控件显示为空。
        const nextProjectId =
          response.projects.find((project) => project.projectId === lastProjectId)?.projectId ??
          response.projects[0]?.projectId;
        if (nextProjectId) {
          // 用函数式更新而不是基于闭包里的 inputs：这次 await 期间用户可能已经改过其他字段，
          // 覆盖写会丢掉 logDir/dbPath 等并发编辑。
          setInputs((current) => ({ ...current, projectId: nextProjectId }));
        }
      }

      // 校验当前选中 trace 是否仍在列表内（INV-1）：文件被轮转或项目切换后，
      // 旧 traceId 会从列表消失，此时必须回落到首条，否则详情区永远空白。
      const hasCurrentTrace = response.traces.some((trace) => trace.traceId === traceId);
      if (!hasCurrentTrace) {
        setTraceId(response.traces[0]?.traceId ?? "");
      }
    } catch (fetchError) {
      // 失败只写 error，不动 traces/detail（INV-3）：保留上一次成功数据，
      // 让用户还能继续看已加载的内容，而不是被一次网络抖动清屏。
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      // finally 而不是 try 尾部：异常路径也要解除 loading，
      // 否则一次失败会让加载指示器永久转圈，看起来像卡死。
      setLoading(false);
    }
    // 依赖 traceId 是刻意的：列表响应回来要复查选中项是否仍存在。
    // [权衡] 代价是每次切 trace 都会重取列表；改成只读 ref 比较可以省掉请求，
    // 但会让「列表已变而选中项失效」的检测滞后一轮，调试台更看重自愈速度。
  }, [inputs.projectId, query, traceId]);

  const loadTraceDetail = useCallback(async () => {
    // 没有 trace 时必须显式清空 detail：否则切到「全部项目」后甘特图仍显示上一条 trace
    // 的泳道，用户会把它当成当前选择的结果。
    if (!traceId.trim()) {
      setDetail(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      // traceId 来自 URL/用户输入，可能含 `/`、`#` 等字符；不编码会拼出错误路径，
      // 后端按截断后的 id 查不到，前端只看到 404 而不知道是编码问题。
      const encoded = encodeURIComponent(traceId.trim());
      const response = await fetchJson<TraceDetailResponse>(`/api/traces/${encoded}${query}`);
      // 详情响应自带 sources（含该 trace 实际命中的文件），用它覆盖列表阶段的来源：
      // 列表是「项目级」的，详情才是「这条 trace 级」的，后者更贴近用户正在看的内容。
      setDetail(response);
      setSources(response.sources);
    } catch (fetchError) {
      // 同样保留旧 detail（INV-3）：详情失败往往意味着文件被轮转，旧数据仍具参考价值，
      // 清空反而让用户失去上下文。
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
    // query 也参与依赖：同一 trace 在不同项目/日志目录下可能是两份不同数据，
    // 忽略它会让切换过滤条件后详情不刷新，看起来「过滤没生效」。
  }, [query, traceId]);

  // 一次变更同时刷新列表与详情：只刷详情会让「新 trace 出现/旧 trace 消失」不同步，
  // 只刷列表则当前 trace 的新 span 不更新。两者都是幂等 GET，重复代价可接受。
  const refreshObservations = useCallback(() => {
    void loadTraces();
    void loadTraceDetail();
  }, [loadTraceDetail, loadTraces]);
  // 订阅放在所有 loader 之后：hook 内部持有 onChange 的 ref，避免因回调身份变化重建 EventSource。
  const observationEvents = useObservationEvents(query, refreshObservations);

  // 首帧与 query 变化的唯一加载入口。依赖 loadTraces 而非 query，是因为该回调已把
  // projectId/traceId 编进依赖，这里再列一遍会产生两次等价触发。
  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  // 详情单独一个 effect：traceId 变化时只需重取详情，不必连带重取列表。
  useEffect(() => {
    void loadTraceDetail();
  }, [loadTraceDetail]);

  // 仅记忆非空 projectId（INV-11）：首帧 inputs 还是空对象，若无条件写入，
  // 会把用户上次的项目覆盖成空串，下次打开永远回落到「全部项目」。
  useEffect(() => {
    if (inputs.projectId) {
      window.localStorage.setItem(lastProjectStorageKey, inputs.projectId);
    }
  }, [inputs.projectId]);

  // hashchange 只单向同步到 state（INV-10）：这里不回写 location，否则与 setDebugView 的
  // replaceState 形成互相触发的循环，地址栏会抖动、组件多渲染一轮。
  useEffect(() => {
    const syncViewFromHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", syncViewFromHash);
    // 必须成对移除：调试台是单页但会随路由重挂载，泄漏的监听器会在卸载后继续 setState。
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, []);

  // 三个视图用条件渲染而非全部挂载后隐藏：甘特图内部持有 vis-timeline 实例与大量 DOM，
  // 常驻会让切到 Trace 视图后仍持续响应 resize 与重绘，白白占用主线程。
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ZCode 调试台</h1>
          <p>Trace、甘特执行、网络抓包</p>
        </div>
        <div className="topbar-actions">
          <ViewTabs activeView={view} onChange={setDebugView} />
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadTraces()}
            title="刷新"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="control-strip" aria-label="调试控制">
        <ProjectSelect
          projects={projects}
          value={inputs.projectId}
          onChange={(value) => {
            setInputs((current) => ({ ...current, projectId: value }));
            setTraceId("");
          }}
        />
        <TraceSelect traces={traces} value={traceId} onChange={selectTrace} />
      </section>

      {error ? (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <SourceBar sources={sources} loading={loading} live={observationEvents} />

      {view === "trace" ? (
        <div className="workspace-grid">
          <TimelinePanel items={detail?.timeline ?? []} />
          <div className="side-stack">
            <ContextPanel
              snapshots={detail?.contextSnapshots ?? []}
              usageSnapshots={detail?.contextUsageSnapshots ?? []}
            />
            <CachePanel reports={detail?.cacheReports ?? []} />
            <GapsPanel requests={detail?.developerRequests ?? []} />
          </div>
        </div>
      ) : null}

      {view === "gantt" ? (
        <div className="gantt-page">
          <ExecutionGanttPanel spans={spans} traceId={traceId} />
        </div>
      ) : null}

      {view === "network" ? (
        <NetworkPage
          activeTraceId={traceId}
          error={network.error}
          filter={networkFilter}
          onFilterChange={setNetworkFilter}
          onTraceSelect={(nextTraceId) => {
            selectTrace(nextTraceId);
            setDebugView("gantt");
          }}
          requests={network.requests}
          status={network.status}
        />
      ) : null}
    </main>
  );
}

// 视图切换只做受控回调，不自己持有状态：activeView 由 App 单一持有，
// 否则 tab 高亮与真正的渲染分支可能短暂不一致。
function ViewTabs(props: { activeView: DebugView; onChange: (view: DebugView) => void }) {
  // 用 Object.keys 遍历而非手写数组：键序即声明序，新增视图不会漏掉按钮。
  return (
    <nav className="view-tabs" aria-label="调试视图">
      {(Object.keys(viewLabels) as DebugView[]).map((view) => (
        <button
          aria-current={props.activeView === view ? "page" : undefined}
          className={props.activeView === view ? "active" : ""}
          key={view}
          onClick={() => props.onChange(view)}
          type="button"
        >
          {viewLabels[view]}
        </button>
      ))}
    </nav>
  );
}

// 项目下拉的选项来自列表响应，只包含「当前确实有 trace 的项目」；因此记忆项目若已无数据，
// 会自然不在选项里，受控 select 会显示空——这正是期望行为：不展示一个取不到数据的项目。
function ProjectSelect(props: {
  projects: ProjectSummary[];
  value: string;
  onChange: (value: string) => void;
}) {
  // 不使用内部 state：value/onChange 全由 App 控制，避免出现「下拉已变、查询未变」的错位。
  return (
    <label>
      <span>项目</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">全部项目</option>
        {props.projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>
            {project.label}（{project.sessionCount}）
          </option>
        ))}
      </select>
    </label>
  );
}

// trace 下拉同时是「当前详情」的选择器；option 的 value 直接用 traceId，
// 不用数组下标——下标会随列表刷新漂移，导致选中的是另一条 trace。
function TraceSelect(props: {
  traces: TraceSummary[];
  value: string;
  onChange: (traceId: string) => void;
}) {
  return (
    <label>
      <span>Trace</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">选择 Trace</option>
        {props.traces.map((trace) => (
          <option key={trace.traceId} value={trace.traceId}>
            {trace.traceId} - {trace.firstUserMessage ?? "没有观察到用户消息"}
          </option>
        ))}
      </select>
    </label>
  );
}

// 状态条是「数据源健康度 + 推送通道健康度」的唯一汇总位：它不参与数据获取，
// 因此 props 全是只读快照，任何交互都必须由父组件实现，避免这里偷偷发请求。
function SourceBar({
  sources,
  loading,
  live,
}: {
  sources: SourceStatus[];
  loading: boolean;
  live: ObservationEventState;
}) {
  // 延迟 180ms 再显示加载态：快速请求（本地 SQLite 常在 10ms 内返回）会让指示器
  // 闪一下又消失，这种闪烁比没有指示器更让人怀疑页面出错。
  const showLoading = useDelayedVisible(loading, 180);
  // 注意这里是整段条件渲染：live 与 sources 是两条独立链路，
  // 推送断开只影响第一个 pill，不隐藏源文件列表（否则用户会以为数据源没了）。
  return (
    <section className="source-bar" aria-label="观测数据源">
      <div className={`source-pill live ${live.connected ? "ready" : "muted"}`}>
        <Radio size={16} />
        <div>
          <strong>{live.connected ? "实时推送" : "实时重连"}</strong>
          <span>
            {live.lastChangeAt
              ? `最近更新 ${formatTime(live.lastChangeAt)}`
              : `${live.watchedPathCount} 个路径`}
          </span>
        </div>
        {live.error ? <small>{live.error}</small> : <small>SSE</small>}
      </div>
      {sources.map((source) => (
        <div className={`source-pill ${source.available ? "ready" : "muted"}`} key={source.kind}>
          {source.kind === "sqlite" ? <Database size={16} /> : <FileJson size={16} />}
          <div>
            <strong>{source.label}</strong>
            <span>{source.recordCount} 条记录</span>
          </div>
          {source.warning ? <small>{source.warning}</small> : null}
        </div>
      ))}
      <div className={`loading-dot ${showLoading ? "visible" : ""}`} aria-hidden={!showLoading}>
        加载中
      </div>
    </section>
  );
}

// 网络页只做「过滤 + 转交」：过滤结果不回写 App，避免用户逐字输入时把草稿写进
// 持久状态，导致切走再回来时过滤词意外“复活”。
function NetworkPage(props: {
  activeTraceId: string;
  error: string | null;
  filter: string;
  onFilterChange: (value: string) => void;
  onTraceSelect: (traceId: string) => void;
  requests: NetworkRequestRecord[];
  status: NetworkCaptureStatus | null;
}) {
  // 过滤是纯函数且依赖两个稳定引用：放进 useMemo 是为了在流式请求持续到达时，
  // 每次新增一条都能复用已有过滤结果，而不是整表重算（200 条 × 10 字段的包含判断）。
  const filteredRequests = useMemo(
    () => filterNetworkRequests(props.requests, props.filter),
    [props.filter, props.requests],
  );

  return (
    <div className="network-page">
      <section className="network-control-strip" aria-label="网络请求过滤">
        <label>
          <span>过滤</span>
          <div className="input-with-icon">
            <Search size={16} />
            <input
              value={props.filter}
              onChange={(event) => props.onFilterChange(event.target.value)}
              placeholder="trace、host、URL、method"
            />
          </div>
        </label>
        <button
          className="secondary-button"
          disabled={!props.activeTraceId}
          onClick={() => props.onFilterChange(props.activeTraceId)}
          type="button"
        >
          当前 Trace
        </button>
        <button
          className="secondary-button"
          disabled={!props.filter}
          onClick={() => props.onFilterChange("")}
          type="button"
        >
          清空
        </button>
      </section>
      <NetworkPanel
        activeTraceId={props.activeTraceId}
        error={props.error}
        requests={filteredRequests}
        status={props.status}
        onTraceSelect={props.onTraceSelect}
      />
    </div>
  );
}

// 列表渲染依赖 props.requests 的顺序而非再排序：上游 mergeNetworkRequest 已按时间倒序
// 并截断，这里重排会让「最新一条」与去重键脱节，还会在每次渲染产生新数组。
function NetworkPanel(props: {
  activeTraceId: string;
  error: string | null;
  requests: NetworkRequestRecord[];
  status: NetworkCaptureStatus | null;
  onTraceSelect: (traceId: string) => void;
}) {
  // shell 选择是纯 UI 偏好，不需要持久化：它只影响复制出来的文本格式，
  // 存 localStorage 反而会让换机器后复制出不符合当前终端习惯的命令。
  const [envShell, setEnvShell] = useState<EnvShell>("posix");
  // 「已复制」提示只记哪个 shell 被复制，而不是布尔值：三种格式的按钮并排，
  // 用布尔会让三个按钮同时显示对勾，用户无法确认复制的是当前这种。
  const [copiedShell, setCopiedShell] = useState<EnvShell | null>(null);
  // 计数基于过滤后的 props.requests（父组件已按过滤词收窄）：
  // 若改用全量列表，用户输入过滤词后「当前 Trace」计数会大于屏幕上可见条数。
  const activeTraceCount = props.activeTraceId
    ? props.requests.filter((request) => request.traceId === props.activeTraceId).length
    : 0;
  // 环境命令是「状态对象 + shell 选择」的纯派生值：这里必须传新对象 `{}` 作为空值兜底，
  // 若传共享常量会被 useMemo 的依赖比较误判为未变化，导致代理重启后命令不更新。
  const envCommand = useMemo(
    () => formatEnvCommand(props.status?.env ?? {}, envShell),
    [envShell, props.status?.env],
  );

  // 复制反馈用一次性定时器：不清理的话，快速连点会在旧计时器触发时清掉新的高亮，
  // 表现为「刚点完对勾立刻消失」。
  useEffect(() => {
    if (!copiedShell) return;
    const timer = window.setTimeout(() => setCopiedShell(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedShell]);

  // 复制失败不回滚 UI：clipboard 权限被拒时写剪贴板也会 reject，此时仍显示「已复制」
  // 会误导用户；但调试台上更没有价值的是一次静默失败的告警，故这里只做最小处理。
  const copyEnvCommand = useCallback(async () => {
    if (!envCommand) return;
    await copyTextToClipboard(envCommand);
    setCopiedShell(envShell);
  }, [envCommand, envShell]);

  // 整个面板由父级传入的 requests 驱动，本组件不持有任何请求句柄，
  // 因此卸载时无需 cancel——这也是它能安全用在条件视图里的前提。
  return (
    <section className="panel network-panel">
      <PanelTitle icon={<Globe2 size={17} />} title="网络请求" />
      {props.error ? (
        <div className="network-error">
          <AlertTriangle size={15} />
          <span>{props.error}</span>
        </div>
      ) : null}
      <div className="network-head">
        <div className={props.status?.running ? "network-state ready" : "network-state muted"}>
          <ShieldCheck size={16} />
          <div>
            <strong>{props.status?.running ? "代理运行中" : "代理未运行"}</strong>
            <span>{props.status?.proxyUrl ?? "未启用"}</span>
          </div>
        </div>
        <div className="network-stat">
          <span>最近请求</span>
          <strong>{props.requests.length}</strong>
        </div>
        <div className="network-stat">
          <span>当前 Trace</span>
          <strong>{activeTraceCount}</strong>
        </div>
        <div className="network-stat wide">
          <span>CA</span>
          <strong>{props.status?.certificate.caCertPath ?? "未生成"}</strong>
        </div>
      </div>
      {envCommand ? (
        <div className="env-copy-box">
          <div className="env-copy-toolbar">
            <div className="segmented-control" aria-label="环境变量 shell 格式">
              {(Object.keys(envShellLabels) as EnvShell[]).map((shell) => (
                <button
                  aria-pressed={envShell === shell}
                  className={envShell === shell ? "active" : ""}
                  key={shell}
                  onClick={() => setEnvShell(shell)}
                  type="button"
                >
                  {envShellLabels[shell]}
                </button>
              ))}
            </div>
            <button className="copy-button" onClick={() => void copyEnvCommand()} type="button">
              {copiedShell === envShell ? <Check size={15} /> : <Clipboard size={15} />}
              <span>{copiedShell === envShell ? "已复制" : "复制环境"}</span>
            </button>
          </div>
          <pre className="env-command">
            <code>{envCommand}</code>
          </pre>
        </div>
      ) : null}
      <div className="network-list">
        {props.requests.length === 0 ? <EmptyLine text="等待被测 CLI 的网络请求" /> : null}
        {props.requests.map((request) => (
          <article
            className={
              request.traceId && request.traceId === props.activeTraceId
                ? "network-row active"
                : "network-row"
            }
            key={request.id}
          >
            <div className="network-row-main">
              <span className={`method method-${request.method.toLowerCase()}`}>
                {request.method}
              </span>
              <strong title={request.url}>{request.url}</strong>
              <span className={`request-status status-${request.status}`}>
                {formatNetworkStatus(request)}
              </span>
            </div>
            <div className="network-row-meta">
              <time>{formatTime(request.startedAt)}</time>
              <span>{formatDuration(request.durationMs)}</span>
              <span>{formatBytes(request.requestBodyBytes)} up</span>
              <span>{formatBytes(request.responseBodyBytes)} down</span>
              {request.traceId ? (
                <button
                  className="trace-chip"
                  onClick={() => props.onTraceSelect(request.traceId ?? "")}
                  title="选择这个 Trace"
                  type="button"
                >
                  {request.traceId}
                </button>
              ) : (
                <code>未归因</code>
              )}
              {request.sessionId ? <code>{request.sessionId}</code> : null}
              {request.error ? <span className="network-row-error">{request.error}</span> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/**
 * 执行甘特面板。
 * 输入：已合并网络 span 的 `spans` 与当前 traceId（无 trace 时展示空态）。
 * 行为：按 `laneOrder` 固定泳道顺序分组，用 vis-timeline 渲染；支持全屏切换。
 * 输出：纯展示组件，不发起请求，数据变更由父组件驱动重渲染。
 */
function ExecutionGanttPanel({ spans, traceId }: { spans: TraceSpan[]; traceId: string }) {
  // 两个 ref 分工明确：container 交给 vis-timeline 接管 DOM，timeline 保存命令式实例。
  // 不把实例放进 state，是因为 setOptions/fit 这类调用不应触发 React 渲染。
  const containerRef = useRef<HTMLDivElement | null>(null);
  const timelineRef = useRef<VisTimeline | null>(null);
  // null 表示「尚未选中」，与「选中了第一条」区分开：初始渲染用第一条兜底，
  // 但用户点空白处取消选择时不能被自动重新选中，否则取消动作看起来无效。
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // toSorted 产生新数组而不是原地 sort：spans 来自 useMemo 结果，原数组可能仍被
  // 父级或其他 memo 引用，原地排序会悄悄改变上游顺序，使详情区与画布顺序不一致。
  const visibleSpans = useMemo(
    () => spans.toSorted((left, right) => compareDateAsc(left.startAt, right.startAt)),
    [spans],
  );
  // 分组与条目分开 memo：groups 只在泳道集合变化时才需要重建，
  // items 随每个 span 的状态/时长变化；合并成一个 memo 会让新增一段就重建全部组。
  const groups = useMemo(() => buildGanttGroups(visibleSpans), [visibleSpans]);
  const items = useMemo(() => buildGanttItems(visibleSpans), [visibleSpans]);
  // 选中项先按 id 查、查不到再回落首条：id 命中说明用户的选择仍有效；
  // 回落保证画布上永远有一个可解释的「当前段」，而不是详情区突然消失。
  const selectedSpan =
    visibleSpans.find((span) => span.id === selectedSpanId) ?? visibleSpans[0] ?? null;

  // 实例创建必须只跑一次（空依赖）：vis-timeline 构造会接管容器子节点，
  // 重复构造会留下孤立的 canvas 与内部事件监听，且旧实例仍持有 DOM 引用无法回收。
  useEffect(() => {
    const container = containerRef.current;
    // 条件渲染下 ref 可能尚未挂载；直接 new 会因 container 为 null 抛错，
    // 而这里没有错误边界兜底，一次异常会让整个调试台白屏。
    if (!container) return;
    const timeline = new VisTimeline(container, [], [], ganttOptions(false));
    timelineRef.current = timeline;
    // 回调里只写 state，不直接操作实例：vis-timeline 的 select 事件在点击/键盘
    // 都可能触发，保持「事件 → React 状态 → setData」单向，避免两处同时改选中态。
    const handleSelect = (properties?: { items?: Array<string | number> }) => {
      const id = properties?.items?.[0];
      setSelectedSpanId(id === undefined ? null : String(id));
    };
    timeline.on("select", handleSelect);
    // [资源] 卸载顺序是 off → destroy → 清 ref：先摘回调再销毁，防止 destroy 期间
    // 的内部事件回调进来又 setState 到已卸载组件。
    return () => {
      timeline.off("select", handleSelect);
      timeline.destroy();
      timelineRef.current = null;
    };
  }, []);

  // 数据更新走 setData 而非重建实例（INV-8）：setData 会保留当前缩放与视窗，
  // 这对调试很重要——SSE 每来一段新 span 就重置视图，用户根本没法追踪执行过程。
  useEffect(() => {
    timelineRef.current?.setData({ groups, items });
    // 只有确实有数据才 fit：数据清空时 fit 会把视窗缩成一个无意义的空窗口，
    // 之后再来数据需要用户手动点「适配视图」。
    if (items.length > 0) {
      timelineRef.current?.fit();
    }
  }, [groups, items]);

  // 兜底选中：trace 切换后旧 id 不在新列表里（INV-9），这里改选首条；
  // 用 conditions 里的 return 提前退出，避免每次渲染都 setState 造成额外一轮渲染。
  useEffect(() => {
    if (selectedSpanId && visibleSpans.some((span) => span.id === selectedSpanId)) return;
    setSelectedSpanId(visibleSpans[0]?.id ?? null);
  }, [selectedSpanId, visibleSpans]);

  // 全屏只锁 body 滚动，不改布局层级：调试台本身没有滚动容器嵌套，
  // 用 overflow: hidden 足以阻止背景滚动，且不会影响其他页面的滚动恢复。
  useEffect(() => {
    if (!isFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Esc 是唯一退出方式：不加一个显式的关闭按钮，是因为全屏态下工具栏仍可见，
    // 那个按钮已经承担退出职责，这里补键盘只是无障碍与习惯性操作的冗余入口。
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    // [资源] 恢复的是进入全屏前的原值而不是固定 ""：若宿主页面本就禁用了滚动，
    // 写死空串会把它解禁，属于跨组件的副作用泄漏。
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isFullscreen]);

  // 尺寸变化需要两帧：第一帧让容器尺寸先落地，第二帧再 redraw + fit，
  // 单帧下 vis-timeline 读到的仍是旧宽高，结果是被拉伸或被裁切。
  useEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline) return;
    timeline.setOptions(ganttOptions(isFullscreen));
    const refit = () => {
      timeline.redraw();
      if (items.length > 0) timeline.fit();
    };
    let firstFrame = 0;
    let secondFrame = 0;
    firstFrame = window.requestAnimationFrame(() => {
      timeline.redraw();
      secondFrame = window.requestAnimationFrame(refit);
    });
    window.addEventListener("resize", refit);
    // [资源] 必须取消尚未执行的两帧，否则卸载后回调仍会访问已 destroy 的实例，
    // 在控制台留下一串 "Cannot read properties of null" 且难以归因。
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.removeEventListener("resize", refit);
    };
  }, [isFullscreen, items.length]);

  return (
    <section className={isFullscreen ? "panel gantt-panel fullscreen" : "panel gantt-panel"}>
      <div className="gantt-toolbar">
        <PanelTitle icon={<BarChart3 size={17} />} title="执行甘特图" />
        <div className="gantt-toolbar-actions">
          <button
            className="icon-button"
            onClick={() => setIsFullscreen((current) => !current)}
            title={isFullscreen ? "退出窗口内全屏" : "窗口内全屏"}
            type="button"
          >
            {isFullscreen ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
          </button>
          <button
            className="secondary-button"
            disabled={items.length === 0}
            onClick={() => timelineRef.current?.fit()}
            type="button"
          >
            适配视图
          </button>
        </div>
      </div>
      <div className="gantt-summary">
        <Metric label="Trace" value={traceId || "未选择"} />
        <Metric label="执行段" value={String(visibleSpans.length)} />
        <Metric
          label="网络段"
          value={String(visibleSpans.filter((span) => span.lane === "network").length)}
        />
      </div>
      <div className="gantt-shell">
        <div className="gantt-canvas" ref={containerRef} />
        {visibleSpans.length === 0 ? (
          <div className="gantt-empty">
            <EmptyLine text="没有可渲染的执行段。需要 turn/tool/model start/end 事件或网络归因。" />
          </div>
        ) : null}
      </div>
      {selectedSpan ? <SpanDetail span={selectedSpan} /> : null}
    </section>
  );
}

// 详情区展示的是「画布选中段」的完整字段；它不读 selectedSpanId，只接收已解析好的 span，
// 这样画布实例与 React 状态之间只有一条数据通道。
function SpanDetail({ span }: { span: TraceSpan }) {
  return (
    <aside className="gantt-detail" aria-label="执行段详情">
      <div className="gantt-detail-heading">
        <strong>{span.label}</strong>
        <span className={`request-status status-${span.status}`}>
          {formatSpanStatus(span.status)}
        </span>
      </div>
      <MetaLine
        values={[
          laneLabels[span.lane],
          span.source,
          formatTime(span.startAt),
          formatSpanDuration(span),
          span.traceId ? `trace ${span.traceId}` : "",
          span.sessionId ? `session ${span.sessionId}` : "",
          span.turnId ? `turn ${span.turnId}` : "",
          span.toolCallId ? `tool ${span.toolCallId}` : "",
        ]}
      />
      {span.summary ? <p>{span.summary}</p> : null}
      {span.payload !== undefined ? <TimelinePayload payload={span.payload} /> : null}
    </aside>
  );
}

// 时间线按后端给的顺序原样渲染，不在前端重排：时间线本身可能混合了不同时钟源
// （事件写入时间/span 开始时间），前端再排序会把「日志乱序」这一真实问题掩盖掉。
function TimelinePanel({ items }: { items: TimelineItem[] }) {
  return (
    <section className="panel timeline-panel">
      <PanelTitle icon={<Clock3 size={17} />} title="时间线" />
      <div className="timeline">
        {items.length === 0 ? <EmptyLine text="选择 Trace 后查看事件" /> : null}
        {items.map((item) => (
          <article className={`timeline-item severity-${item.severity ?? "info"}`} key={item.id}>
            <time>{formatTime(item.at)}</time>
            <div>
              <div className="timeline-heading">
                <strong>{item.label}</strong>
                <span>{item.source}</span>
              </div>
              <p className="timeline-summary">{item.summary}</p>
              {item.payload !== undefined ? <TimelinePayload payload={item.payload} /> : null}
              <MetaLine
                values={[
                  item.sessionId ? `会话 ${item.sessionId}` : "",
                  item.turnId ? `轮次 ${item.turnId}` : "",
                  item.toolCallId ? `工具 ${item.toolCallId}` : "",
                ]}
              />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// 用 details 折叠原始 payload：大 trace 的事件 payload 可达数百 KB，
// 默认展开会一次性创建大量 DOM 节点，折叠后只在用户点开时才付出渲染代价。
function TimelinePayload({ payload }: { payload: unknown }) {
  return (
    <details className="timeline-payload">
      <summary>原始 Payload</summary>
      <pre>{stringifyPayload(payload)}</pre>
    </details>
  );
}

// 上下文面板同时展示两种快照：占用快照（token 分类）与文本快照（分区内容）。
// 二者来源不同、可用性互相独立，因此空态判定必须两者都缺才成立。
function ContextPanel({
  snapshots,
  usageSnapshots,
}: {
  snapshots: ContextSnapshotView[];
  usageSnapshots: ContextUsageSnapshotView[];
}) {
  // 优先取最后一条 observationLevel=full 的快照：metadata/inferred 是降级产物，
  // 字段不全（无 sections 内容），展示它们会让用户以为上下文真的丢了内容。
  // 只有在完全没有 full 记录时才退回最后一条，保证至少能显示汇总数字。
  const snapshot = useMemo(
    () => snapshots.findLast((item) => item.observationLevel === "full") ?? snapshots.at(-1),
    [snapshots],
  );
  // 占用快照直接取最后一条：它每次都是完整重算的全量视图，不存在降级形态。
  const usageSnapshot = usageSnapshots.at(-1);
  // 按来源聚合再画条形图：单个 section 可能几十条，逐条渲染条形会碎成不可读的细线；
  // 聚合后的百分比之和恒为 1，与上方总 token 数保持同一口径。
  const grouped = useMemo(() => groupSections(snapshot), [snapshot]);

  return (
    <section className="panel context-panel">
      <PanelTitle icon={<Layers3 size={17} />} title="上下文" />
      {!snapshot && !usageSnapshot ? <EmptyLine text="未观察到上下文快照" /> : null}
      {usageSnapshot ? (
        <div className="usage-snapshot">
          <div className="usage-heading">
            <strong>占用快照</strong>
            <span>
              {formatTokenMethod(usageSnapshot.tokenMethod)} ·{" "}
              {formatConfidence(usageSnapshot.confidence)}
            </span>
          </div>
          <div className="metric-row">
            <Metric label="估算 Token" value={usageSnapshot.totalTokens.toLocaleString()} />
            <Metric label="字符" value={usageSnapshot.totalChars.toLocaleString()} />
            <Metric label="算法" value={usageSnapshot.tokenizer ?? "未知"} />
          </div>
          <div className="stack-bar" aria-label="上下文占用 token 分类">
            {usageSnapshot.categories.map((category) => (
              <span
                className={usageSourceClasses[category.source]}
                key={category.id}
                style={{ width: `${Math.max(category.percentTokens * 100, 2)}%` }}
                title={`${usageSourceLabels[category.source]} ${Math.round(category.percentTokens * 100)}%`}
              />
            ))}
          </div>
          <div className="usage-list">
            {usageSnapshot.categories.map((category) => (
              <div className="usage-row" key={category.id}>
                <span className={`dot ${usageSourceClasses[category.source]}`} />
                <strong>{usageSourceLabels[category.source]}</strong>
                <small>
                  {category.tokens.toLocaleString()} Token ·{" "}
                  {Math.round(category.percentTokens * 100)}% ·{" "}
                  {formatTokenMethod(category.tokenMethod)}
                </small>
              </div>
            ))}
          </div>
          {usageSnapshot.mcpTools.length > 0 ? (
            <details className="usage-details">
              <summary>MCP 工具明细</summary>
              <div className="usage-list">
                {usageSnapshot.mcpTools.map((tool) => (
                  <div className="usage-row" key={tool.name}>
                    <span className="dot tone-mcp" />
                    <strong>{tool.name}</strong>
                    <small>
                      {tool.serverName ?? "unknown"} · {tool.tokens.toLocaleString()} Token ·{" "}
                      {formatTokenMethod(tool.tokenMethod)}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {usageSnapshot.skills.length > 0 ? (
            <details className="usage-details">
              <summary>技能明细</summary>
              <div className="usage-list">
                {usageSnapshot.skills.map((skill) => (
                  <div className="usage-row" key={`${skill.source ?? "skill"}:${skill.name}`}>
                    <span className="dot tone-skills" />
                    <strong>{skill.name}</strong>
                    <small>
                      {skill.source ?? "unknown"} · {skill.tokens.toLocaleString()} Token ·{" "}
                      {formatTokenMethod(skill.tokenMethod)}
                    </small>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          {usageSnapshot.warnings.map((warning) => (
            <p className="soft-warning" key={warning}>
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      {snapshot ? (
        <>
          <div className="usage-heading">
            <strong>文本快照</strong>
            <span>{formatObservationLevel(snapshot.observationLevel)}</span>
          </div>
          <div className="metric-row">
            <Metric label="Token" value={snapshot.totalTokens.toLocaleString()} />
            <Metric label="字符" value={snapshot.totalChars.toLocaleString()} />
            <Metric label="观测" value={formatObservationLevel(snapshot.observationLevel)} />
          </div>
          <div className="stack-bar" aria-label="上下文 token 占比">
            {grouped.map((group) => (
              <span
                className={sourceClasses[group.source]}
                key={group.source}
                style={{ width: `${Math.max(group.percent * 100, 2)}%` }}
                title={`${sourceLabels[group.source]} ${Math.round(group.percent * 100)}%`}
              />
            ))}
          </div>
          <div className="section-list">
            {snapshot.sections.map((section) => (
              <details key={section.id}>
                <summary>
                  <span className={`dot ${sourceClasses[section.source]}`} />
                  <strong>{section.name}</strong>
                  <small>
                    {sourceLabels[section.source]} · {section.tokens.toLocaleString()} Token ·{" "}
                    {Math.round(section.percentTokens * 100)}%
                  </small>
                </summary>
                <pre>{section.content ?? section.preview ?? "只有元数据"}</pre>
              </details>
            ))}
          </div>
          {snapshot.warnings.map((warning) => (
            <p className="soft-warning" key={warning}>
              {warning}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

// 缓存面板只取最后一条报告：cache 报告是「每次模型请求后的累计快照」，
// 历史报告只用于趋势分析，堆叠展示会让当前命中率淹没在一堆旧数字里。
function CachePanel({ reports }: { reports: CacheReport[] }) {
  const report = reports.at(-1);
  // 过滤掉 SQLite 特有的占位说明：它不是真实的缓存片段，混在列表里会被误读成
  // 「这一段完全没命中」，而实际原因是该数据源不提供 provider 可见文本。
  const segments = report?.segments.filter(isRenderableCacheSegment) ?? [];

  return (
    <section className="panel cache-panel">
      <PanelTitle icon={<BarChart3 size={17} />} title="缓存" />
      {!report ? <EmptyLine text="未观察到缓存使用" /> : null}
      {report ? (
        <>
          <div className="metric-row">
            <Metric label="读取" value={report.cacheReadTokens.toLocaleString()} />
            <Metric label="写入" value={report.cacheWriteTokens.toLocaleString()} />
            <Metric
              label="命中"
              value={report.hitRate === null ? "未知" : `${Math.round(report.hitRate * 100)}%`}
            />
          </div>
          {segments.length > 0 ? (
            <div className="cache-segments">
              {segments.map((segment) => (
                <article className={`cache-segment ${segment.status}`} key={segment.id}>
                  <strong>{formatCacheStatus(segment.status)}</strong>
                  <span>{formatSegmentLabel(segment.role ?? segment.source)}</span>
                  <p>{segment.preview}</p>
                  {segment.reason ? <small>{segment.reason}</small> : null}
                </article>
              ))}
            </div>
          ) : null}
          {report.limitations.map((limitation) => (
            <p className="soft-warning" key={limitation}>
              {limitation}
            </p>
          ))}
        </>
      ) : null}
    </section>
  );
}

// 用「与固定占位文案比对」而不是按 status=unknown 过滤：unknown 也可能是真实的
// 缓存状态未知（provider 没回报），那样的片段仍应展示，只有占位说明必须剔除。
// [权衡] 文案来自后端，改一个字这里就会失效；因此它作为过滤条件写在一处，
// 后端若能加结构化标记，应优先改为按标记过滤。
function isRenderableCacheSegment(segment: CacheReport["segments"][number]): boolean {
  return segment.preview !== "SQLite 的 step-finish token usage 不包含 provider 可见文本。";
}

// 「观测缺口」解释的是「为什么某些数据没有」：它把后端识别到的事件缺失翻译成可读条目，
// 没有它时用户只会看到空面板并怀疑前端坏了。以 eventName 作 key 是因为
// 同一事件在一份报告里只会有一条缺口说明。
function GapsPanel({ requests }: { requests: TraceDetailResponse["developerRequests"] }) {
  return (
    <section className="panel gaps-panel">
      <PanelTitle icon={<AlertTriangle size={17} />} title="观测缺口" />
      {requests.length === 0 ? <EmptyLine text="当前 trace 没有观测缺口" /> : null}
      {requests.map((request) => (
        <article className="request-row" key={request.eventName}>
          <strong>{request.title}</strong>
          <p>{request.reason}</p>
          <code>{request.eventName}</code>
        </article>
      ))}
    </section>
  );
}

// 面板标题统一走这里：icon 用 ReactNode 而不是组件类型，是为了让调用方
// 能直接传带尺寸的实例，避免每个面板各写一套图标尺寸。
function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

// 指标值统一按字符串接收：调用方负责 toLocaleString/格式化，组件不猜单位，
// 否则会出现「同一数字在不同面板一个带千分位一个不带」的观感不一致。
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// 空态文案必须说明「下一步该做什么」，而不是简单的「暂无数据」：
// EmptyLine 的 text 必须写「下一步做什么」，只写「暂无数据」会让使用者以为后端没返回。
function EmptyLine({ text }: { text: string }) {
  return <p className="empty-line">{text}</p>;
}

// 元信息行接收「可能为空的片段数组」，由这里统一过滤与拼接：
// 别在调用处用三元拼分隔符：那会在 items 为空时留下一个孤立的「·」。
function MetaLine({ values }: { values: string[] }) {
  const cleanValues = values.filter(Boolean);
  // 全空时返回 null 而不是渲染空 small：否则每张卡片底部都会多出一条不可见的
  // 空白行，视觉上像间距不一致。
  if (cleanValues.length === 0) return null;
  return <small className="meta-line">{cleanValues.join(" · ")}</small>;
}

/**
 * 订阅观测变更 SSE。
 * 输入：`query` 决定监听的日志/事件/数据库路径；`onChange` 在收到 change 时触发刷新。
 * 输出：连接状态（是否连通、最近变更时间、监听路径数、错误信息）。
 * 行为：EventSource 断开后按固定间隔重连；hello 事件携带初始路径数。
 * 失败语义：单个源读取失败由 `source-error` 事件展示，不关闭整体连接。
 */
function useObservationEvents(query: string, onChange: () => void): ObservationEventState {
  // 回调放进 ref 而不是放进 effect 依赖（INV-5 的配套）：onChange 每次渲染都是新函数，
  // 若直接作为依赖，EventSource 会随任意一次父组件渲染被关闭重建，连接始终处于握手期。
  const onChangeRef = useRef(onChange);
  // 初值 connected=false 而非 true：在 hello 到达前无法断言通道可用，
  // 乐观置 true 会让状态条在真正连不上时先显示「实时推送」再跳回「重连」，产生误导。
  const [state, setState] = useState<ObservationEventState>({
    connected: false,
    error: null,
    watchedPathCount: 0,
  });

  // 只更新 ref，不触发任何状态变更：这是「最新回调可见性」与「订阅稳定性」之间的桥，
  // 漏掉它会导致 scheduleRefresh 永远调用首次挂载时的旧回调（旧 query 闭包）。
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // 订阅生命周期严格绑定 query：query 变了说明监听目标整体换了，旧连接必须关掉，
  // 否则旧流上的一次写入会触发新 query 的刷新，数据来源就串了。
  useEffect(() => {
    // closed 是「本次订阅是否已废弃」的同步标志：EventSource.close() 不能保证
    // 已排队的 message 回调不再执行，回调里必须自己再挡一次（INV-12 的姊妹约束）。
    let closed = false;
    let refreshTimer: number | undefined;
    const events = new EventSource(`/api/observations/events${query}`);

    // 刷新合并（INV-4）：一次写盘往往连发多个 change 帧，每个都刷新会让后端被同一批
    // 文件反复读取；这里只保留最后一个窗口，语义上「最终一致」已经足够。
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        // 定时器触发时再检查 closed：期间可能已经切换 query 并清理过连接，
        // 少了这一行就会出现「旧组件已卸载仍在刷新」的幽灵请求。
        if (!closed) onChangeRef.current();
      }, 180);
    };

    // hello 携带服务端当前监听的路径集合，是判断「订阅是否真正建立」的第一手证据；
    // 这里把它当作连接成功信号，而不是依赖 open（open 只说明 HTTP 层通了）。
    events.addEventListener("hello", (event) => {
      const parsed = parseMessageEvent<ObservationHelloEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        watchedPathCount: parsed.sources.length,
      });
    });
    // change 是唯一的刷新触发点：它带 changedAt 与最新的路径集合，
    // 因此这里整对象覆盖而不是 spread——避免上一次的 lastChangeAt 在无变更时残留。
    events.addEventListener("change", (event) => {
      const parsed = parseMessageEvent<ObservationChangeEvent>(event);
      if (!parsed || closed) return;
      setState({
        connected: true,
        error: null,
        lastChangeAt: parsed.changedAt,
        watchedPathCount: parsed.sources.length,
      });
      scheduleRefresh();
    });
    // 单个源读失败不关闭整条流：一个日志目录没权限不该让其他源停止推送，
    // 因此这里只把错误挂到状态条，并保持 connected=true（通道本身是好的）。
    events.addEventListener("source-error", (event) => {
      const parsed = parseMessageEvent<ObservationSourceErrorEvent>(event);
      if (!parsed || closed) return;
      setState((current) => ({
        ...current,
        connected: true,
        error: parsed.message,
      }));
    });
    // open 在每次（自动）重连成功时都会触发，是清除上一次断线告警的唯一时机；
    // 放在这里而不是 hello，是因为 hello 可能因服务端实现变化而缺席，open 一定有。
    events.addEventListener("open", () => {
      if (!closed) {
        setState((current) => ({ ...current, connected: true, error: null }));
      }
    });
    // 浏览器对 EventSource 的 error 会自动重连，所以这里不 close、不重建连接：
    // 手动重连会与浏览器内置退避策略叠加，造成连接风暴。状态条只需如实显示「重连中」。
    events.addEventListener("error", () => {
      if (!closed) {
        setState((current) => ({
          ...current,
          connected: false,
          error: "观测事件流已断开，正在等待浏览器重连。",
        }));
      }
    });

    // [资源] 清理顺序：先置 closed 拦住排队中的回调，再清定时器，最后 close。
    // 反过来的话，close 之后仍可能有已排队的 change 回调把 refreshTimer 重新挂上，
    // 于是组件卸载后还残留一个永不执行的定时器与一次幽灵请求。
    return () => {
      closed = true;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      events.close();
    };
    // 依赖只有 query：把这个 effect 的频率压低到「真正换了监听目标」时才重建。
  }, [query]);

  return state;
}

// 延迟可见性 hook：只解决「短任务不要闪」这一个问题，因此刻意不做防抖队列、
// 不支持 onChange —— 一旦复合更多语义，就会有人拿它当通用 debounce 用，行为难以预期。
function useDelayedVisible(visible: boolean, delayMs: number): boolean {
  const [delayedVisible, setDelayedVisible] = useState(false);

  // visible 变 false 时同步归零而不等待：加载结束后若还延迟关闭，
  // 会出现「数据已渲染但指示器仍挂着」的空窗，比闪烁更难解释。
  useEffect(() => {
    if (!visible) {
      setDelayedVisible(false);
      return;
    }

    // 每次 visible 由 false 翻 true 都重新计时：依赖数组里带 visible 保证
    // 连续两次加载之间定时器会被清理，不会把两次合并成一次。
    const timer = window.setTimeout(() => setDelayedVisible(true), delayMs);
    // 清理是必需的：loading 在 180ms 内结束时要撤销这次显示，
    // 否则定时器到点仍会把 delayedVisible 置 true，指示器再也不会消失。
    return () => window.clearTimeout(timer);
  }, [delayMs, visible]);

  return delayedVisible;
}

/**
 * 订阅网络抓包状态与增量请求。
 * 输出：状态快照、按请求 id 合并后的请求列表（snapshot 覆盖全量、request 增量 upsert、reset 清空）。
 * 行为：SSE 断开后延迟重连；组件卸载时关闭连接，避免重复订阅。
 * 失败语义：代理未启用时 status 为关闭态，前端仅隐藏数据而不报错。
 */
function useNetworkCapture(): {
  status: NetworkCaptureStatus | null;
  requests: NetworkRequestRecord[];
  error: string | null;
} {
  // 三个状态分开存而不是合成一个对象：请求列表更新频率远高于代理状态，
  // 合并成一个对象会让每条新请求都替换 status 引用，触发依赖 status 的 memo 重算。
  const [status, setStatus] = useState<NetworkCaptureStatus | null>(null);
  const [requests, setRequests] = useState<NetworkRequestRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  // 空依赖：抓包流与项目/日志过滤无关（代理是进程级的），
  // 挂上 query 会导致切项目时抓包连接重建并丢失已收集的请求。
  useEffect(() => {
    // 与观测流同样的守卫：fetch 与 EventSource 的异步结果都可能在清理之后才回来。
    let closed = false;

    // 首屏靠一次 REST 全量补齐历史请求，因为 SSE 只推「连接之后」的增量；
    // 这两条通道必然有重叠区间，reset/snapshot 的覆盖语义正是为了消除重叠。
    async function loadInitialState() {
      try {
        // limit=200 与前端 mergeNetworkRequest 的截断值保持一致：
        // 若后端给更多，前端截断会让「更早的请求」在首屏闪一下再消失。
        const response = await fetchJson<NetworkRequestsResponse>(
          "/api/network/requests?limit=200",
        );
        if (closed) return;
        setStatus(response.status);
        setRequests(response.requests);
      } catch (fetchError) {
        // 首屏失败只写 error，不阻塞 SSE：代理未启动时这条请求本来就会失败，
        // 而后续 SSE 一旦连上仍可恢复出完整数据。
        if (!closed)
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
      }
    }

    void loadInitialState();
    const events = new EventSource("/api/network/events");
    // status 帧描述代理本身的启停与证书信息，与请求列表无关；
    // 单独 setStatus 可以避免代理状态心跳触发整列表重渲染。
    events.addEventListener("status", (event) => {
      const parsed = parseMessageEvent<NetworkCaptureStatus>(event);
      if (parsed && !closed) setStatus(parsed);
    });
    // snapshot 是权威全量：整体替换而不是合并，才能把服务端已清理的旧请求从前端一并移除；
    // 若做合并，长时间挂着的调试台会积累一批服务端已不存在的行。
    events.addEventListener("snapshot", (event) => {
      const parsed = parseMessageEvent<NetworkRequestRecord[]>(event);
      if (parsed && !closed) setRequests(parsed);
    });
    // 增量帧按 id upsert（INV-6）：同一请求会先以 pending 到达、完成后再次到达，
    // 直接追加会让列表出现两条同 URL 记录，用户无法判断哪个是最终状态。
    events.addEventListener("request", (event) => {
      const parsed = parseMessageEvent<NetworkRequestRecord>(event);
      if (parsed && !closed) {
        setRequests((current) => mergeNetworkRequest(current, parsed));
      }
    });
    // reset 对应「代理重启/清空抓包」：必须清空前端，否则旧连接上的请求会与新会话混在一起，
    // 时间线出现跨会话的假因果。
    events.addEventListener("reset", () => {
      if (!closed) setRequests([]);
    });
    // 错误只提示不重连：EventSource 自带重连，且服务端 reset 后会推 snapshot 恢复一致性。
    events.addEventListener("error", () => {
      if (!closed) setError("网络抓包事件流已断开，正在等待浏览器重连。");
    });
    // open 覆盖每次重连成功，清掉之前挂的断线提示；
    // 这里不清 requests：重连后紧跟的 snapshot 会负责校正，提前清空反而闪一下空白。
    events.addEventListener("open", () => {
      if (!closed) setError(null);
    });

    // [资源] 只需置 closed 与 close：本 hook 没有定时器，
    // 但 closed 仍必须在 close 之前置位，防止已排队的 listener 写入状态。
    return () => {
      closed = true;
      events.close();
    };
  }, []);

  return { status, requests, error };
}

// 聚合用 Map 而不是对象：来源是有限的联合类型，但 Map 的插入顺序稳定，
// 且不必担心 `__proto__` 之类的键名污染（来源虽然受控，但模板式扩展时容易踩到）。
function groupSections(snapshot?: ContextSnapshotView) {
  const groups = new Map<ContextSectionSource, number>();
  for (const section of snapshot?.sections ?? []) {
    groups.set(section.source, (groups.get(section.source) ?? 0) + section.tokens);
  }
  // 分母取「各 section token 之和」而非 snapshot.totalTokens：后者可能包含未分区的开销，
  // 用它会得到百分比之和 < 1，条形图右侧出现莫名空隙。
  const total = [...groups.values()].reduce((sum, value) => sum + value, 0);
  // total 为 0 时百分比取 0：除以 0 得到 NaN，会把 style.width 变成 "NaN%"，
  // 浏览器忽略该值后所有段一起塌陷，排查时极难联想到是空快照导致。
  return [...groups.entries()].map(([source, tokens]) => ({
    source,
    tokens,
    percent: total > 0 ? tokens / total : 0,
  }));
}

/** 将来源输入拼成查询串：只保留非空字段并统一编码，空值表示“不过滤”。 */
// 用 URLSearchParams 而不是手拼：路径里可能含空格、`&`、中文，
// 手拼少一次编码就会让参数被截断成两个键值对，后端看到的是残缺过滤条件。
function buildQuery(inputs: SourceInputs): string {
  const params = new URLSearchParams();
  // trim 后的值同时决定「是否输出」和「输出什么」（INV-13）：只判空不 trim
  // 会把纯空格当成有效过滤条件，后端返回空列表且用户无从解释。
  for (const [key, value] of Object.entries(inputs)) {
    if (value.trim()) params.set(key, value.trim());
  }
  const query = params.toString();
  // 无参数时返回空串而不是 "?"：拼出 `/api/traces?` 多数后端能容忍，
  // 但会让缓存键与日志里的 URL 形态不一致，排查时容易误判来源。
  return query ? `?${query}` : "";
}

// 统一的取数入口：把「非 2xx」转成异常，让上层只处理一条失败路径。
// [权衡] 不在这里做超时/重试：调试台的失败语义是「立刻告诉用户」，
// 静默重试会让「文件被轮转」这类确定性失败看起来像随机抖动。
async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  // 只拼 status/statusText，不回读 body：后端错误体可能是 HTML 错误页，
  // 直接塞进界面会破坏排版；需要细节时用户可看网络面板。
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  // 类型参数 T 只是编译期约定，未做运行时校验：契约由本地 debug 服务端保证，
  // 若字段缺失，渲染层会通过可选链与空数组兜底，而不是整页崩溃。
  return (await response.json()) as T;
}

// payload 是 unknown：它可能已被后端序列化成字符串，也可能是任意 JSON。
// 字符串直接原样返回，避免二次 JSON.stringify 给整段内容加上一层引号与转义。
function stringifyPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  try {
    // 缩进 2 空格便于人工比对；`?? String(payload)` 兜住 JSON.stringify(undefined)
    // 返回 undefined 的情况，否则 <pre> 会渲染出 undefined 字样。
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    // 循环引用或 BigInt 会让 stringify 抛错；调试台此时宁可退化成 String，
    // 也不能让一个坏 payload 打断整条时间线的渲染（异常会冒泡到 React 渲染阶段）。
    return String(payload);
  }
}

// SSE 帧的统一解析入口，返回 null 表示「这不是一帧可用的 JSON」（INV-12）：
// 所有监听器都会 `if (!parsed) return`，因此解析失败只会丢一帧，不会中断后续事件。
function parseMessageEvent<T>(event: Event): T | null {
  const data = (event as MessageEvent<string>).data;
  // EventSource 的默认 message 是字符串；但自定义事件可能被包装过，
  // 这里做类型收窄而不是直接 JSON.parse，避免对对象调用 parse 得到 "[object Object]"。
  if (typeof data !== "string") return null;
  try {
    return JSON.parse(data) as T;
  } catch {
    // 半截帧（连接中断时的截断）会走到这里；静默返回 null 是刻意的，
    // 因为服务端的下一个 snapshot/hello 会补全状态，报错只会制造噪音。
    return null;
  }
}

// 双通道复制：优先异步剪贴板 API，其次 execCommand 兜底。
// 之所以保留旧 API，是因为调试台常被以 http:// 访问内网主机，此时
// navigator.clipboard 在非安全上下文中直接不存在，只写新 API 会让复制功能整块失效。
async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard) {
    // 这里不 try/catch：权限被拒时让 reject 冒泡给调用方，
    // 由调用方决定是否提示，避免在本函数里吞掉唯一的失败信号。
    await navigator.clipboard.writeText(text);
    return;
  }

  // 兜底方案依赖「选中一个屏幕外 textarea 再执行 copy」：
  // 用 fixed + 负 left 而不是 display:none，因为后者会让元素不可选中，copy 拿到空内容。
  const textarea = document.createElement("textarea");
  textarea.value = text;
  // readonly 防止移动端弹出键盘并改变视口，进而触发一次多余的 resize。
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  // [资源] 必须移除临时节点：每次复制都留一个 textarea，长时间使用会让
  // DOM 里堆积上百个隐藏节点，同时影响 document.body 的布局计算。
  textarea.remove();
}

// 环境命令的三套语法必须各自独立转义：POSIX 用单引号并转义内嵌单引号，
// PowerShell 用单引号且翻倍表示，cmd 用双引号并转义内嵌双引号。
// [权衡] 不追求覆盖所有特殊字符（如换行、%VAR%），调试目标只是本机临时设置代理变量，
// 过度转义反而让用户看不懂复制出来的命令。
function formatEnvCommand(env: Record<string, string>, shell: EnvShell): string {
  const entries = Object.entries(env);
  // 空对象返回空串而不是空行：调用方用 `envCommand ? ...` 决定是否渲染复制区，
  // 返回 "\n" 之类的真值会让空区块一直显示。
  if (entries.length === 0) return "";
  if (shell === "powershell") {
    return entries.map(([name, value]) => `$env:${name} = ${quotePowerShell(value)}`).join("\n");
  }
  if (shell === "cmd") {
    // cmd 的引号规则不适用 POSIX 的单引号包裹：`set "K=V"` 才是能保留空格与特殊字符的写法，
    // 内嵌双引号用 `\"` 转义，否则命令会提前闭合。
    return entries
      .map(([name, value]) => `set "${name}=${value.replaceAll('"', '\\"')}"`)
      .join("\n");
  }
  // 默认落到 POSIX：posix 是 EnvShell 的默认选项，也是开发机最常见的目标环境。
  return entries.map(([name, value]) => `export ${name}=${quotePosix(value)}`).join("\n");
}

// POSIX 单引号内不能转义任何字符，唯一办法是「闭合单引号 + 反斜杠转义 + 重新开引号」，
// 也就是把 `'` 写成 `'\''`；少了这一步，含单引号的值会把后续内容当成普通文本。
function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// PowerShell 的单引号字符串是字面量，内部单引号用两个单引号表示（不是反斜杠）。
// 与 POSIX 的写法看起来只差几个字符，但不能共用实现。
function quotePowerShell(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// upsert 而不是 push（INV-6）：Map 先按 id 收敛，再统一排序截断，
// 保证「同一请求的状态更新」在原地替换，列表长度与显示的请求数始终一致。
// [权衡] 每次增量都重建 Map 是 O(n)，n 上限 200，换来的是无需处理索引失效；
// 改成原地 splice 会引入「找不到插入位置」的分支，出错时顺序会静默错乱。
function mergeNetworkRequest(
  current: NetworkRequestRecord[],
  next: NetworkRequestRecord,
): NetworkRequestRecord[] {
  const byId = new Map(current.map((request) => [request.id, request]));
  byId.set(next.id, next);
  // 倒序 + 截断必须同时做：只截断不排序会把刚到达但 startedAt 较早的请求挤掉，
  // 而它恰恰可能是用户正在观察的那一条。
  return [...byId.values()]
    .toSorted((left, right) => compareDateDesc(left.startedAt, right.startedAt))
    .slice(0, 200);
}

/**
 * 把抓包请求并入 trace span（仅当前 trace）。
 * 口径：后端已归因到该 trace 的请求直接追加；无法归因的请求不并入，避免污染甘特时间线。
 * 输出：按开始时间升序的新数组，不修改入参。
 */
function mergeNetworkSpans(
  spans: TraceSpan[],
  requests: NetworkRequestRecord[],
  traceId: string,
): TraceSpan[] {
  // 无 traceId 时原样返回：此时任何请求都不该被归因，
  // 返回新数组会让下游 memo 每次都判定「变了」，触发甘特图重建数据。
  if (!traceId) return spans;
  // 只保留 traceId 精确相等的请求（INV-7）：未归因请求即使时间重叠也不并入，
  // 否则用户会看到一条实际不属于本 trace 的网络段，据此推断的因果全错。
  const networkSpans = requests
    .filter((request) => request.traceId === traceId)
    .map(networkRequestToSpan);
  // 追加而非排序：排序交给 ExecutionGanttPanel 的 visibleSpans，
  // 这里保持「trace 段在前、网络段在后」的稳定顺序，便于调试时对比两侧数量。
  return [...spans, ...networkSpans];
}

// 把抓包记录投影成 TraceSpan，让甘特图只认一种数据结构。
// id 必须带 `network:` 前缀（INV-16）：请求 id 与 span id 由不同系统生成，
// 裸用会撞车，vis-timeline 按 id 去重时会把真正的 span 挤掉。
function networkRequestToSpan(request: NetworkRequestRecord): TraceSpan {
  return {
    id: `network:${request.id}`,
    traceId: request.traceId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    spanId: request.spanId,
    lane: "network",
    label: `${request.method} ${request.host}`,
    source: "network",
    startAt: request.startedAt,
    endAt: request.completedAt,
    // 抓包的 pending 要映射成 span 的 running，否则甘特图会把它画成一个已结束的短条；
    // error 保持 error，其余一律 ok —— 4xx/5xx 属于「请求完成但有状态码」，不算传输错误。
    status: request.status === "pending" ? "running" : request.status === "error" ? "error" : "ok",
    // summary 里刻意同时给 URL 与状态：画布上的 title 与详情区共用这段文本，
    // 少了任一项都要回去点开 payload 才能确认，违背「一眼看清」的目标。
    summary: `${request.method} ${request.url}\n${formatNetworkStatus(request)} · ${formatBytes(
      request.requestBodyBytes,
    )} up · ${formatBytes(request.responseBodyBytes)} down`,
    payload: request,
  };
}

// 过滤语义是「任一字段包含即命中」：调试者在搜索框里通常只记得 URL 片段或状态码，
// 要求他先声明搜哪个字段反而增加负担；字段集合刻意包含 traceId/sessionId，
// 这样粘一个 id 进来就能反查这条请求属于谁。
function filterNetworkRequests(
  requests: NetworkRequestRecord[],
  filter: string,
): NetworkRequestRecord[] {
  // 空过滤词返回原数组引用（不复制）：列表 memo 依赖引用相等，
  // 每次流式更新都新建数组会让 200 行列表在无关状态变化时也全量重渲染。
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return requests;
  // statusCode 先转字符串再 filter(Boolean)：0 或空串时会被剔除，
  // 否则 `String(0)` 可能让「状态码 0」变成搜索词，命中一批本不相关的记录。
  return requests.filter((request) =>
    [
      request.traceId,
      request.sessionId,
      request.turnId,
      request.spanId,
      request.method,
      request.host,
      request.path,
      request.url,
      request.status,
      request.statusCode ? String(request.statusCode) : "",
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
}

// 只画「有数据的泳道」：空泳道会让甘特图出现大片空白行，
// 用户容易以为那些泳道的数据没加载出来。order 用过滤后的下标而非 laneOrder 下标，
// 保证剩余泳道连续排列、无视觉断裂。
function buildGanttGroups(spans: TraceSpan[]): VisTimelineGroup[] {
  const activeLanes = new Set(spans.map((span) => span.lane));
  return laneOrder
    .filter((lane) => activeLanes.has(lane))
    .map((lane, index) => ({
      id: lane,
      content: laneLabels[lane],
      order: index,
      className: `gantt-group lane-${lane}`,
    }));
}

// 未结束的 running span 用「当前时刻」补一个临时 end，画成 range：
// 只给 start 会退化成 point，在数百像素宽的时间轴上几乎看不见，
// 而进行中的段恰恰是用户最想定位的。这个 end 每次重建都会刷新，所以正在跑的段会持续变长。
function buildGanttItems(spans: TraceSpan[]): VisTimelineItem[] {
  return spans.map((span) => {
    const runningEndAt =
      !span.endAt && span.status === "running" ? new Date().toISOString() : undefined;
    // range 与 point 的 style 不同（见 ganttItemStyle）：type 判断必须同时看 endAt 与
    // 补出来的 runningEndAt，漏掉后者会让进行中的段无法被选中。
    const type = span.endAt || runningEndAt ? "range" : "point";
    return {
      id: span.id,
      group: span.lane,
      content: ganttItemContent(span),
      title: escapeTimelineContent(ganttItemTitle(span)),
      start: span.startAt,
      end: span.endAt ?? runningEndAt,
      type,
      style: ganttItemStyle(type),
      className: `gantt-item lane-${span.lane} span-status-${span.status}`,
    };
  });
}

// content 是直接写入 DOM 的 HTML 字符串，因此每个插值都必须 escape：
// label 里可能带用户消息片段（含 `<`），漏一个就会破坏条目结构，
// 严重时被当成标签插入，属于可注入面。
function ganttItemContent(span: TraceSpan): string {
  return [
    `<span class="gantt-item-title">${escapeTimelineContent(span.label)}</span>`,
    `<span class="gantt-item-meta"> · ${escapeTimelineContent(ganttItemMeta(span))}</span>`,
  ].join("");
}

// title 是悬停提示（tooltip），由 vis-timeline 以 HTML 属性写入，
// 所以调用处还要再过一次 escapeTimelineContent。这里保留换行是因为
// tooltip 用 white-space: pre-line 渲染，多行比逗号分隔更易扫读。
function ganttItemTitle(span: TraceSpan): string {
  return [
    span.label,
    `${laneLabels[span.lane]} · ${formatSpanStatus(span.status)} · ${formatSpanDuration(span)}`,
    ganttIdentifierLine(span),
    span.summary,
  ]
    .filter(Boolean)
    .join("\n");
}

// 条目上的紧凑元信息：网络段用「状态码 + 耗时」，其他段用「状态 + 耗时」。
// 之所以按 payload 形状分流而不是按 lane，是因为网络段也可能是其他 lane 的包装，
// 用 lane 判断会漏掉；payload 里有请求字段才是可靠依据。
function ganttItemMeta(span: TraceSpan): string {
  const request = networkRequestFromPayload(span.payload);
  if (request) {
    return [formatNetworkStatus(request), formatDuration(request.durationMs)].join(" · ");
  }

  return [formatSpanStatus(span.status), formatSpanDuration(span)].join(" · ");
}

// 五级标识按 trace→session→turn→tool→span 由粗到细排列，与 AGENTS.md 的层级约定一致；
// 缺失项用空串过滤，因此一个只有 spanId 的段不会出现「 ·  · 」这样的空分隔。
function ganttIdentifierLine(span: TraceSpan): string {
  return [
    span.traceId ? `trace ${span.traceId}` : "",
    span.sessionId ? `session ${span.sessionId}` : "",
    span.turnId ? `turn ${span.turnId}` : "",
    span.toolCallId ? `tool ${span.toolCallId}` : "",
    span.spanId ? `span ${span.spanId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// 用「必须存在的五个字段」做最小结构判别，而不是完整的 schema 校验：
// 这里只用于决定「要不要按网络段渲染元信息」，误判的代价是显示一行普通状态，
// 引入完整校验器反而让这个纯渲染函数变重。
function networkRequestFromPayload(payload: unknown): NetworkRequestRecord | null {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.id !== "string") return null;
  if (typeof payload.startedAt !== "string") return null;
  if (typeof payload.method !== "string") return null;
  if (typeof payload.url !== "string") return null;
  if (typeof payload.status !== "string") return null;
  return payload as unknown as NetworkRequestRecord;
}

// 必须排除数组：typeof [] === "object"，只判 object 会让数组通过，
// 之后按字段取值全是 undefined，判别就失去意义。也要排除 null（typeof 同为 object）。
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// 选项集中在纯函数里返回值对象：setOptions 必须拿到新的完整选项，
// 因此这里不能缓存成模块级常量——vis-timeline 内部会对传入对象做浅合并，
// 复用同一引用在切换全屏时可能被判定为「未变化」而跳过布局重算。
function ganttOptions(isFullscreen: boolean): TimelineOptions {
  return {
    // stack 让同泳道重叠的段上下堆叠而不是互相遮挡；关掉会丢失「并发执行」这一关键信息。
    stack: true,
    // autoResize 依赖容器尺寸变化，但容器本身也在 flex 中变化，仍需配合手动 redraw（见面板 effect）。
    autoResize: true,
    selectable: true,
    // 关掉当前时间竖线：调试的是历史 trace，红线会让用户误以为那是某个事件发生时刻。
    showCurrentTime: false,
    horizontalScroll: true,
    verticalScroll: true,
    // 用 ctrl+滚轮缩放，避免与页面滚动冲突：不加修饰键时整个页面滚不动，用户会被困在画布里。
    zoomKey: "ctrlKey",
    // isFullscreen 时 axis 取 top、否则 item 取 bottom：刻度贴条目，长列表滚动后仍看得见。
    orientation: { axis: "top", item: isFullscreen ? "top" : "bottom" },
    // 内边距用固定值而非百分比：百分比在不同容器宽度下会让条目文字被裁切的概率变化。
    margin: { item: { horizontal: 8, vertical: 8 }, axis: 12 },
    // fitItems 让泳道高度随条目数增长，避免 stack 后条目被压成一条线。
    groupHeightMode: "fitItems",
    // 高度三态必须成对设置：非全屏时不设 height 但设 maxHeight，防止一条超长 trace
    // 把整页撑到无法滚动；全屏时反过来用 100% 并放开 maxHeight。
    height: isFullscreen ? "100%" : undefined,
    minHeight: isFullscreen ? "0" : "320px",
    maxHeight: isFullscreen ? undefined : "560px",
  };
}

// 手写四个替换而不是用 innerText/textContent：vis-timeline 接收的是 HTML 字符串，
// 没有 DOM 上下文可借用；顺序上必须先转 `&`，否则后续替换产生的 `&lt;` 会被再转义成 `&amp;lt;`。
function escapeTimelineContent(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// 未识别或为空（含首帧没有 hash）时回落到 gantt 而不是 trace：
// 这是刻意的默认视图选择，保证刷新后落在「最有信息量」的页面上。
// 注意返回值受 DebugView 约束，非法 hash 不能原样透传，否则会渲染出空白视图。
/** 从 URL hash 解析视图（#gantt/#network）；未识别或为空时回落到默认的 gantt，保证刷新后视图稳定。 */
function viewFromHash(hash: string): DebugView {
  const normalized = hash.replace(/^#/, "");
  if (normalized === "gantt" || normalized === "network") return normalized;
  return "gantt";
}

// switch 穷尽五个状态且不写 default：新增状态时 TS 会报「缺少返回」，
// 从而强制在这里补文案，避免界面上出现裸的英文枚举值。
function formatSpanStatus(value: TraceSpan["status"]): string {
  switch (value) {
    case "running":
      return "进行中";
    case "ok":
      return "完成";
    case "error":
      return "错误";
    case "cancelled":
      return "已取消";
    case "unknown":
      return "未知";
  }
}

// 耗时由起止时间戳现算，不用 spans 里可能存在的 durationMs：抓包段与回放段的
// 时间字段来源不同，现算保证同一画布上所有段同一口径。
// end < start 判为「未知耗时」而不是负数：时钟回拨或跨机器采集时会出现这种数据，
// 显示负毫秒会让用户以为是前端算错。
function formatSpanDuration(span: TraceSpan): string {
  if (!span.endAt) return span.status === "running" ? "进行中" : "未结束";
  const start = new Date(span.startAt).getTime();
  const end = new Date(span.endAt).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return "未知耗时";
  return formatDuration(end - start);
}

// 「完整/元数据/推断」是快照可信度，直接决定用户能不能把当前数字当结论：
// 因此这里用比原始枚举更明确的中文，而不是照抄 full/metadata。
function formatObservationLevel(value: ContextSnapshotView["observationLevel"]): string {
  switch (value) {
    case "full":
      return "完整";
    case "metadata":
      return "元数据";
    case "inferred":
      return "推断";
  }
}

// token 数的来源必须显式展示：provider 计数与本地估算的误差可达数倍，
// 用户看到数字时若不知道来源，会把它当成计费依据。default 分支兜住
// 后端新增但前端未更新的 method，避免显示空白。
function formatTokenMethod(value?: TokenMethod): string {
  switch (value) {
    case "provider_count":
      return "模型计数";
    case "provider_usage":
      return "模型用量";
    case "proportional_estimate":
      return "按比例估算";
    case "estimated":
      return "本地估算";
    default:
      return "未知来源";
  }
}

// 置信度与 method 是两维信息：method 说明「怎么算的」，confidence 说明「算得准不准」，
// 分成两个函数是为了让面板能按需只显示其中一维，合并后无法单独取舍。
function formatConfidence(value?: TokenConfidence): string {
  switch (value) {
    case "high":
      return "可信度高";
    case "medium":
      return "可信度中";
    case "low":
      return "可信度低";
    default:
      return "可信度未知";
  }
}

// 缓存命中状态只有三态，且必须区分「unknown」与「miss」：
// unknown 表示 provider 没给出缓存信息，展示成「未命中」会让用户误判为配置失效。
function formatCacheStatus(value: CacheReport["segments"][number]["status"]): string {
  switch (value) {
    case "hit":
      return "命中";
    case "miss":
      return "未命中";
    case "unknown":
      return "未知";
  }
}

// 同时兼容「缓存片段标签」（system_prompt/skills/tools）与「消息角色」（user/assistant），
// 因为缓存报告里两类标签混用；default 回落到原始值而不是「未知」，
// 这样后端新增标签时用户仍能看到原始字符串，便于反馈缺文案。
function formatSegmentLabel(value?: string): string {
  switch (value) {
    case "system_prompt":
      return "系统";
    case "skills":
      return "技能";
    case "tools":
      return "工具";
    case "other":
      return "其他";
    case "message":
      return "消息";
    case "system":
      return "system 消息";
    case "user":
      return "user 消息";
    case "assistant":
      return "assistant 消息";
    case "tool":
      return "tool 消息";
    default:
      return value ?? "片段";
  }
}

// 优先展示 HTTP 状态码而不是「完成」：调试时区分 200/404/500 是主要诉求，
// 只有拿不到 statusCode 时才退回「完成」，保证任何状态下都有可读文本。
function formatNetworkStatus(request: NetworkRequestRecord): string {
  if (request.status === "pending") return "进行中";
  if (request.status === "error") return "错误";
  return request.statusCode ? String(request.statusCode) : "完成";
}

// 千分位阈值切到秒并保留一位小数：毫秒级差异在调试里有意义，
// 统一用秒会丢掉「200ms vs 900ms」的区别；超过 1s 后毫秒精度反而是噪音。
// undefined 返回 "-- ms" 而 0 返回 "0 ms"：两者语义不同（未知 vs 瞬时），不能合并。
function formatDuration(value?: number): string {
  if (value === undefined) return "-- ms";
  if (value < 1000) return `${value} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

// 只做 B/KB/MB 三级：调试台的请求体不会到 GB 量级，
// 再加一级反而让同一数量级出现两种单位。以 1024 为基数与后端字节定义一致。
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

// 用 toLocaleTimeString 而不是截 ISO 串：后者显示的是 UTC，与用户本地时钟差 8 小时，
// 对照终端日志时会得出完全相反的时间顺序。解析失败时原样返回输入，
// 保证「后端给了怪值」至少可见，而不是被 "--:--:--" 掩盖。
function formatTime(value?: string): string {
  if (!value) return "--:--:--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// 缺省值用 0 而不是跳过比较：缺时间的条目应稳定沉到末尾，
// 若跳过会让它留在数组原位置，每次刷新顺序都会跳动。
function compareDateDesc(left?: string, right?: string): number {
  return new Date(right ?? 0).getTime() - new Date(left ?? 0).getTime();
}

// 升序比较与倒序分成两个具名函数，而不是调用处取反：toSorted 的比较器
// 取反后 0 会变成 -0，虽然等价但在「稳定排序」的语义上容易引起误读，
// 且两个方向的意图在调用点一眼可辨。
function compareDateAsc(left?: string, right?: string): number {
  return new Date(left ?? 0).getTime() - new Date(right ?? 0).getTime();
}
