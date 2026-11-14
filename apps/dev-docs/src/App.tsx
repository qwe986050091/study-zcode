/* eslint-disable max-lines -- 文档站首屏、结构表格和概念索引需要共享筛选与高亮状态，先集中在单入口组件维护。 */
// ZCode 开发者文档站的单入口：顶部导航在四个视图间切换（stdio 抓包 / 协议字段 / 能力地图 / 边界图谱）。
// 数据来源分两类：静态协议文档来自 @/data/protocolDocs，stdio 帧在 real 模式下轮询 Vite 本地 API 读取
// tap proxy 写入的 NDJSON，mock 模式下由前端定时器合成，两种模式互斥切换。
// 视图选择写入 URL 的 view 参数（replaceState，不产生历史记录），刷新后保持当前视图；
// 搜索词与选中概念只在内存中维护，不持久化。
// ============================================================================
// App.tsx — ZCode 开发者文档站单入口（四视图 / 静态协议 / stdio 抓包）
//
// 职责边界：
//   - 只做视图编排与展示：协议文档来自 @/data/protocolDocs 的静态常量。
//   - stdio 真实帧来自同源 /api/dev/stdio-traffic（Vite 侧读取 tap 代理写的 NDJSON）。
//   - mock 帧完全由前端定时器合成，不写回任何后端，也不参与真实链路的任何判断。
//   - 不持久化搜索词、选中概念与方向筛选；只把 view 写进 URL query。
//
// 两套数据源必须互斥（由 trafficSourceMode 单点控制）：
//   real：1s 轮询，整表替换；帧 id = workspaceHash + 文件内序号 + 时间戳。
//   mock：1800ms 合成一帧，头部插入后重排并截断 48 条；id 带自增序号。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 URL 的 view 参数只认四个合法值，其余一律回退 stdio。
//   守住它的位置：getInitialDocsView 的四值白名单比较。
//   改错故障：把任意 query 直接写进 activeView，会渲染到不存在的分支（整页空白）。
//
// INV-02 视图切换必须用 replaceState，不得改成 pushState。
//   守住它的位置：selectView 里的 window.history.replaceState。
//   改错故障：每切一次视图压一条历史，用户点返回要按很多次才能离开文档站。
//
// INV-03 stdio 视图内联渲染，两个图谱视图必须懒加载并包 Suspense。
//   守住它的位置：activeView 三元分支里的 CapabilityMapView / FeatureBoundaryGraphView。
//   改错故障：改成静态 import 会把 ELK / React Flow 打进首屏包，首屏体积成倍增长。
//
// INV-04 视图分支的最后一支固定是 protocol，不允许出现「无匹配」的空渲染。
//   守住它的位置：最外层 activeView 判断的最后一个 else。
//   改错故障：新增视图时漏补分支会静默落进 protocol，看起来像数据结构错乱。
//
// INV-05 搜索词只在 protocol 视图渲染输入框；stdio 用独立的 trafficQuery。
//   守住它的位置：query 输入框外层的 activeView === "protocol" 判断。
//   改错故障：两视图共用一份搜索词，切过去后残留关键词，列表莫名为空。
//
// INV-06 结构列表的搜索过滤只影响列表，不影响 activeConcept 的详情展示。
//   守住它的位置：activeConcept 取自未过滤的 conceptById，而不是 filteredConcepts。
//   改错故障：搜索把选中概念过滤掉后详情整块消失，用户以为概念数据丢了。
//
// INV-07 activeConceptId 失效时必须回退到 concepts[0]，不能渲染 undefined。
//   守住它的位置：activeConcept 表达式末尾的 ?? concepts[0]。
//   改错故障：id 拼错或概念表为空时，ConceptPanel 取 kind 会抛 TypeError 并白屏。
//
// INV-08 real 模式轮询必须在切模式与卸载时清理。
//   守住它的位置：两个 real effect 返回的 window.clearInterval。
//   改错故障：切到 mock 后真实计时器仍在跑，两套数据源交替覆盖列表，帧不停闪烁。
//
// INV-09 非 real 模式下 effect 必须早退，不能「先拉一次再返回」。
//   守住它的位置：两个 real effect 顶部的 trafficSourceMode !== "real" 判断。
//   改错故障：mock 下仍写入 realTraffic，合成列表被真实数据整体替换。
//
// INV-10 请求失败必须清空 records，同时保留上一次 logDir。
//   守住它的位置：fetchRealTraffic 的 catch 里那次函数式 setRealTraffic。
//   改错故障：保留过期 records 会让人以为还在实时抓包，但 latest 时间已不动。
//
// INV-11 response.records 不是数组时必须兜底为空数组。
//   守住它的位置：setRealTraffic 里的 Array.isArray 判断。
//   改错故障：后端异常返回对象时，下游 map 直接抛错，整个视图白屏。
//
// INV-12 帧 id 必须在重复轮询同一文件时保持稳定。
//   守住它的位置：mapTapRecordToFrame 的 real-${workspaceHash}-${index}-${ts}。
//   改错故障：用数组下标或随机数生成 id，每秒轮询都会重置选中帧，详情反复跳动。
//
// INV-13 无 direction 的 tap 记录必须丢弃（返回 null 后被 filter 掉）。
//   守住它的位置：mapTapRecordToFrame 的首个 if。
//   改错故障：direction 为空时 directionLabel[...] 取到 undefined，徽标渲染成空白仍占位。
//
// INV-14 raw 缺失时必须有兜底文本，不能落到空字符串。
//   守住它的位置：mapTapRecordToFrame 返回对象的 raw 字段。
//   改错故障：详情面板 raw 区一片空白，无法判断这条记录到底抓到了什么。
//
// INV-15 配对只按 messageId 关联 request 与 response，notification 不参与。
//   守住它的位置：linkTrafficFrames 里的两个 kind 分支。
//   改错故障：把 notification 也塞进 map，同 id 的事件会被错配成「响应」。
//
// INV-16 选中帧必须走四级回退链，过滤不得把详情区变成空态。
//   守住它的位置：selectedFrame 的四个 ?? 串联。
//   改错故障：只用 filteredFrames.find，搜索无命中时详情消失，用户丢失阅读上下文。
//
// INV-17 配对帧必须从完整 trafficFrames 里取，不能从 filteredFrames 取。
//   守住它的位置：linkedFrame 的查找来源。
//   改错故障：按「上行」筛选时对应的下行响应被过滤，配对区永远不显示。
//
// INV-18 方向过滤先于文本搜索，且空查询直接放行。
//   守住它的位置：filteredFrames 里 directionMatches 的提前 return。
//   改错故障：顺序反了会让语料拼接白算；空查询若当成匹配空串则会把所有帧滤掉。
//
// INV-19 只有点中最新的那一帧才恢复 follow，点历史帧必须停止跟随。
//   守住它的位置：TrafficFrameRow 的 onSelect 里 frame.id === trafficFrames[0]?.id。
//   改错故障：一直保持 follow，用户点历史帧后下一秒就被跳回最新，看不了细节。
//
// INV-20 mock 模式必须把列表截断到 48 条，且每次插入后重新排序。
//   守住它的位置：合成定时器里的 sortTrafficFramesByNewest(...).slice(0, 48)。
//   改错故障：只插不截，长时间开着页面内存与渲染成本线性上涨。
//
// INV-21 两种数据源的时间戳展示口径必须一致（HH:MM:SS.mmm）。
//   守住它的位置：formatTrafficTimestamp 与 formatIsoTrafficTimestamp 的统一实现。
//   改错故障：格式混用后「按时间倒序」会退化成字符串比较，最新帧排到列表中间。
//
// INV-22 latest 展示优先用文件 updatedAt，缺失才退回最新帧时间。
//   守住它的位置：real 数据 effect 里 setLastUpdatedAt 的三元表达式。
//   改错故障：文件长时间无新记录时 latest 显示旧帧时间，被误读为「已经停止抓包」。
//
// INV-23 展示型格式化函数一律不得抛错（ISO 非法、raw 非 JSON、bytes 缺失都要兜底）。
//   守住它的位置：formatIsoTrafficTimestamp / formatRawLine / mapTapRecordToFrame。
//   改错故障：一条脏数据就中断整个列表渲染，而 tap 文件恰好由外部进程写入。
//
// ============================================================================
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpenText,
  Boxes,
  Braces,
  Database,
  FileJson,
  Filter,
  GitCompareArrows,
  GitBranch,
  Hash,
  HardDrive,
  LinkIcon,
  ListFilter,
  Moon,
  Network,
  Pause,
  Play,
  Radio,
  Search,
  Sun,
  Terminal,
  Waypoints,
} from "lucide-react";
import {
  concepts,
  flows,
  protocolSurfaces,
  stdioTrafficFrames,
  stdioTrafficLogFields,
  structures,
  type Concept,
  type ConceptKind,
  type FieldDoc,
  type StdioTrafficDirection,
  type StdioTrafficFrame,
  type StdioTrafficKind,
  type StructureDoc,
} from "@/data/protocolDocs.js";

// 概念静态索引：id 唯一，用于链接跳转与详情面板回查；缺失时调用方自行兜底。
// [权衡] 在模块顶层建 Map 而不是渲染时 find：ConceptLinks 会被字段表每个单元格调用，
//   线性查找会随字段数量乘性放大。
const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
// 两个重型图谱视图懒加载：首屏只加载 stdio 视图，切到对应 view 时才拉取 ELK/React Flow 代码。
// [资源] 懒加载边界放在模块级：若改成组件内 lazy(() => ...)，每次渲染都会新建组件类型，
//   Suspense 会反复卸载重挂，图谱的缩放与选中状态全部丢失。
const CapabilityMapView = lazy(() => import("@/capability-map/CapabilityMapView.js"));
const FeatureBoundaryGraphView = lazy(
  () => import("@/feature-boundary-graph/FeatureBoundaryGraphView.js"),
);

// 概念分类的中文标签与徽标配色：键为 ConceptKind 枚举，新增分类时两表都需补齐。
// [权衡] 用 Record<ConceptKind, string> 而不是 Partial：新增分类时 TS 立即报缺键，
//   这是两张映射表唯一的「完整性守卫」。
const kindLabel: Record<ConceptKind, string> = {
  compat: "兼容字段",
  id: "ID",
  protocol: "协议",
  runtime: "运行态",
  state: "状态",
};

// 分类徽标样式：背景/前景/边框三件套随分类变化，语义色沿用协议图节点配色。
// [权衡] 样式值必须写成完整字面量类名：Tailwind 只扫描源码中出现的字符串，
//   动态拼 `bg-${kind}` 会被 purge 掉，最终徽标透明。
const kindClassName: Record<ConceptKind, string> = {
  compat: "bg-warning/12 text-foreground border-warning/35",
  id: "bg-brand/12 text-foreground border-brand/35",
  protocol: "bg-file-node text-file-node-foreground border-file-node-hover",
  runtime: "bg-command-node text-command-node-foreground border-command-node-hover",
  state: "bg-skill-node text-skill-node-foreground border-skill-node-hover",
};

// 顶层视图标识；stdio 抓包是默认视图。
// [权衡] 用联合字面量而不是 enum：view 会写进 URL，字面量能直接复用于白名单比较，
//   也避免 enum 在运行时生成额外对象。
type DocsView = "capabilities" | "boundary" | "protocol" | "stdio";
// 方向筛选值："all" 表示不过滤，其余值与 StdioTrafficDirection 一一对应。
type DirectionFilter = StdioTrafficDirection | "all";
// 数据源模式：real 轮询本地 API，mock 用前端合成帧演示。
type TrafficSourceMode = "real" | "mock";
// 真实数据源状态：loading 首次加载中，empty 有目录无记录，missing 未找到 tap 文件，error 读取失败。
// [失败路径] 五个状态必须穷尽：徽标文案与空态提示都按状态分流，
//   新增状态时要同步补 if 链，否则会落进「等待」兜底并误导用户。
type RealTrafficStatus = "loading" | "ready" | "empty" | "missing" | "error";

// 从 URL 的 view 参数恢复初始视图；参数缺失、拼写错误或非四个合法值时一律回退到 "stdio"。
// 不校验来源，仅做白名单比对，避免把任意 query 写进状态。
// [失败路径] 只做白名单比对，不做 decode / trim / 模糊匹配：view 来自用户可编辑的 URL，
//   任何「宽松解析」都会扩大可注入面；未知值一律视为未指定。
function getInitialDocsView(): DocsView {
  const view = new URLSearchParams(window.location.search).get("view");
  return view === "capabilities" || view === "boundary" || view === "protocol" || view === "stdio"
    ? view
    : "stdio";
}

interface StdioTrafficApiRecordEnvelope {
  // 记录在接口返回数组中的序号，用于拼出稳定的帧 id（同一文件重读时序号稳定）。
  index: number;
  // 单条 NDJSON 解析后的对象；字段宽松，需在映射时做类型收窄。
  record: StdioTrafficTapRecord;
}

// /api/dev/stdio-traffic 的响应体：描述 tap 文件位置、记录内容与读取状态。
interface StdioTrafficApiResponse {
  // 数据源状态，直接透传到 UI 徽标；非 ready/empty 时 error 可能有值。
  status: RealTrafficStatus;
  // tap 输出目录（未展开 ~），用于在缺失文件时提示用户去哪里找。
  logDir: string;
  // 记录列表，按文件写入顺序；接口异常时可能缺失或非数组，调用方需兜底为空数组。
  records: StdioTrafficApiRecordEnvelope[];
  // 读取失败原因，仅 status=error 时出现。
  error?: string;
  // 实际读取的 NDJSON 文件绝对路径，仅找到文件时出现。
  filePath?: string;
  // 文件最后修改时间（ISO 字符串），用于展示 latest 时间戳。
  updatedAt?: string;
  // 工作区哈希，参与帧 id 生成，避免不同 workspace 的序号冲突。
  workspaceHash?: string;
}

// tap proxy 单条抓包记录：字段全部为可选，因为 stderr 行与非 JSON 行只有 raw/ts/direction。
interface StdioTrafficTapRecord {
  // 写入时间（ISO 字符串），缺失时帧时间显示占位符。
  ts?: string;
  // 产生该记录的工作区标识，仅用于排查，不参与 UI。
  workspaceKey?: string;
  // 代理进程 pid；记录来源进程的调试信息。
  proxyPid?: number;
  // 被代理的 agent 进程 pid；可能为空。
  pid?: number | null;
  // 流向；缺失时该记录无法归类，映射阶段返回 null 丢弃。
  direction?: StdioTrafficDirection;
  // 原始字节数；缺失时用 raw 字符串长度近似。
  bytes?: number;
  // 原始行文本（单行 JSON 或 stderr 文本），用于详情面板原文展示。
  raw?: string;
  // 解析后的 JSON-RPC 消息对象；解析失败时为 undefined。
  message?: unknown;
  // JSON 解析错误文本；非空表示该行不是合法 JSON。
  parseError?: string | null;
  // JSON-RPC id，数字或字符串；存在 id 且无 method 表示 response。
  id?: unknown;
  // JSON-RPC method，存在表示 request/notification。
  method?: unknown;
  // 会话 id，来自消息 params；用于按会话排查。
  sessionId?: unknown;
  // 输入 id，来自消息 params；用于把发送、事件与终态收口关联起来。
  inputId?: unknown;
}

// 本地维护的真实流量状态，形状与接口响应对齐，并保证 records 恒为数组。
interface RealTrafficState {
  // 当前数据源状态；请求失败时置为 error，但保留上次 logDir。
  status: RealTrafficStatus;
  // tap 目录，默认展示 "~/.zcode/v2/dev/stdio-traffic"。
  logDir: string;
  // 记录列表；加载失败时会清空，避免展示过期数据。
  records: StdioTrafficApiRecordEnvelope[];
  // 错误文本，仅 status=error 时有值。
  error?: string;
  // 实际读取文件路径，仅命中文件时有值。
  filePath?: string;
  // 文件更新时间；优先用于 latest 展示。
  updatedAt?: string;
  // 工作区哈希，展示在侧栏并参与帧 id。
  workspaceHash?: string;
}

// 流向的展示文案：stderr 走独立颜色，其余两类按"上行 app→agent / 下行 agent→app"区分。
const directionLabel: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "stderr",
  "agent-to-app": "agent -> app",
  "app-to-agent": "app -> agent",
};

// 流向徽标配色：三类各用一种协议图语义色，与 directionLabel 的键集合保持一致。
const directionClassName: Record<StdioTrafficDirection, string> = {
  "agent-stderr": "border-command-node-hover bg-command-node text-command-node-foreground",
  "agent-to-app": "border-skill-node-hover bg-skill-node text-skill-node-foreground",
  "app-to-agent": "border-file-node-hover bg-file-node text-file-node-foreground",
};

// 搜索归一化：统一小写并去首尾空白；空串表示"无搜索条件"，调用方据此跳过过滤。
// [权衡] 只在比较时归一，不回写 state：输入框要保留用户原始大小写，
//   边输边转小写会让光标位置与 IME 组合态错乱。
function normalizeText(value: string) {
  return value.toLowerCase().trim();
}

// 结构文档匹配：query 为空视为命中全部；否则在标题/路径/用途/新旧结构/迁移说明
// 以及全部字段的 name/type/meaning/owner/oldName/notes 组成的文本中做子串匹配。
// [失败路径] query 已由调用方归一为小写，这里只把语料整体降一次；
//   若逐字段 toLowerCase，字段越多重复转换越多。
// [权衡] 用子串匹配而不是分词：文档站只求「找得到」，引入切词会多一个中文分词依赖。
function matchesStructure(structure: StructureDoc, query: string) {
  if (!query) return true;
  const haystack = [
    structure.title,
    structure.path,
    structure.purpose,
    structure.oldShape ?? "",
    structure.newShape,
    structure.migration,
    ...structure.fields.flatMap((field) => [
      field.name,
      field.type,
      field.meaning,
      field.owner,
      field.oldName ?? "",
      field.notes ?? "",
    ]),
  ]
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
}

// 概念匹配：query 为空视为命中全部；匹配名称、摘要、生命周期、owner、来源与别名列表。
// [权衡] 别名参与匹配但不参与展示：用户可能按旧字段名搜索，
//   命中后仍展示规范名，避免同一概念在界面里出现两种叫法。
function matchesConcept(concept: Concept, query: string) {
  if (!query) return true;
  return [
    concept.name,
    concept.summary,
    concept.lifecycle,
    concept.owner,
    concept.source,
    ...(concept.aliases ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
}

// 把 "HH:MM:SS.mmm" 解析成"当日毫秒数"，仅用于同一天内的帧排序。
// 缺段按 0 处理、毫秒补到 3 位；跨午夜或不同日期的帧重新加载后顺序可能失真，
// 但 tap 文件本身按写入顺序追加，UI 已另按文件顺序兜底。
// [失败路径] 任一段 parseInt 失败会得到 NaN，比较恒为 false，
//   排序退化为「保持原顺序」而不是抛错——这是刻意的降级。
function trafficTimestampToMs(timestamp: string) {
  const [timePart = "00:00:00", millisecondPart = "0"] = timestamp.split(".");
  // [失败路径] 解构默认值只兜「段缺失」，兜不住「段非法」：
  // 非法段会得到 NaN 并让整个时间变成 NaN，排序随之退化为稳定顺序。
  const [hours = 0, minutes = 0, seconds = 0] = timePart
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const milliseconds = Number.parseInt(millisecondPart.padEnd(3, "0").slice(0, 3), 10) || 0;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

// 按时间倒序返回新数组（最新的在前），不修改入参，供列表与"最新帧"共用。
// [并发] 必须先复制再排序：入参可能正是已提交的 state 引用，
//   原地 sort 会让 React 认为没变化而跳过重渲染。
function sortTrafficFramesByNewest(frames: StdioTrafficFrame[]) {
  return [...frames].sort(
    (first, second) =>
      trafficTimestampToMs(second.timestamp) - trafficTimestampToMs(first.timestamp),
  );
}

// 把 Date 格式化为 "HH:MM:SS.mmm"（本地时区），与 tap 记录时间戳的展示口径一致。
// [权衡] 手写补零而不是 toLocaleTimeString：后者受系统 locale 影响可能变成 12 小时制，
//   而排序与展示都依赖固定的 24 小时零填充格式。
function formatTrafficTimestamp(date: Date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${hours}:${minutes}:${seconds}.${milliseconds}`;
}

// 把 ISO 时间转成展示用短时间：undefined/空串返回占位符，非法日期原样返回原文，
// 避免因上游时间字段异常导致整行渲染成 Invalid Date。
// [失败路径] 非法日期返回原文而不是占位符：占位符会让人以为字段为空，
//   原文至少能看出上游写入了什么脏值。
function formatIsoTrafficTimestamp(value: string | undefined) {
  if (!value) {
    return "--:--:--.---";
  }

  const date = new Date(value);
  // [失败路径] NaN 判断必须用 getTime()：直接比较 Date 对象永远为 false，
  // 非法时间会一路传到 toLocale 渲染层变成 Invalid Date。
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return formatTrafficTimestamp(date);
}

// 类型守卫：只认普通对象（排除 null 与数组），供解析任意 unknown 的 JSON-RPC 消息。
// [权衡] 刻意不引入 zod 之类的运行时 schema：tap 记录是开发期调试数据，
//   结构会随协议演进变化，宽松读取比严格校验更不容易因新增字段而整体失败。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 宽松读取字符串字段：非字符串统一返回 undefined，调用方用 ?? 提供展示兜底。
function readString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

// 读取 JSON-RPC id：允许数字或字符串，统一转为字符串用于配对；其他类型（null/对象）视为无 id。
// [权衡] 数字 id 统一转字符串：JSON-RPC 允许 id 为数字或字符串，
//   而 Map 的键必须同类型才能配对，1 与 "1" 在真实链路里应视为同一请求。
function readMessageId(value: unknown) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

// 读取 message.params.payload；任一层不是普通对象时返回 undefined，不抛错。
function getMessagePayload(message: unknown) {
  if (!isRecord(message) || !isRecord(message.params)) {
    return undefined;
  }
  return isRecord(message.params.payload) ? message.params.payload : undefined;
}

// JSON-RPC 帧类型判定（互斥状态机）：stderr 行优先；有 method 时按有无 id 区分
// request / notification；无 method 但有 id 为 response；两者都没有则归为 notification。
// [失败路径] 四个分支覆盖全部组合，末尾 return 是兜底而非死代码：
//   上游若同时缺 method 与 id（tap 写了半行），仍要给出可展示的 kind。
function getTrafficRecordKind(record: StdioTrafficTapRecord): StdioTrafficKind {
  if (record.direction === "agent-stderr") {
    return "stderr";
  }

  if (record.method) {
    return typeof record.id === "undefined" ? "notification" : "request";
  }

  if (typeof record.id !== "undefined") {
    return "response";
  }

  return "notification";
}

// 生成列表里的单行摘要：stderr 截取前 160 字符；解析失败优先展示 parse error；
// 有 payload.type 时直接用它（流式事件最常用）；response 区分 error/result；
// 其余退回 method 或 raw 前 160 字符。摘要只求可读，不保证信息完整，完整内容看 raw。
// [权衡] 优先级按「越接近真实语义越靠前」：payload.type > response 的 error/result > method。
//   反过来先展示 method，会让所有流式事件长得一样，列表失去区分度。
function getTrafficRecordSummary(record: StdioTrafficTapRecord, kind: StdioTrafficKind) {
  if (kind === "stderr") {
    return (record.raw ?? "stderr").slice(0, 160);
  }

  // [失败路径] parseError 优先于 payload.type：一行解析失败的 JSON 不会有可信 payload，
  // 先判断 payload 会展示出「看起来正常」的错误摘要。
  if (record.parseError) {
    return `parse error: ${record.parseError}`;
  }

  // [失败路径] payload 可能来自 params.payload，也可能整层缺失；
  // 取值前必须经过 isRecord 收窄，不能直接对 unknown 取属性。
  const payload = getMessagePayload(record.message);
  const payloadType = readString(payload?.type);
  if (payloadType) {
    return payloadType;
  }

  if (kind === "response") {
    if (isRecord(record.message) && isRecord(record.message.error)) {
      return readString(record.message.error.message) ?? "response error";
    }
    return "response result";
  }

  return readString(record.method) ?? (record.raw ?? "traffic record").slice(0, 160);
}

// 详情面板的原文美化：能解析成 JSON 就按 2 空格缩进重排，解析失败或空串时原样返回，
// 保证非 JSON 的 stderr 行也能完整展示。
// [失败路径] JSON.parse 必须 try/catch：stderr 行与写入一半的行都不是合法 JSON。
// [权衡] 只做缩进美化不做转义：详情区用 code + pre-wrap 渲染，HTML 转义交给 React。
function formatRawLine(raw: string) {
  // [失败路径] 空行必须原样返回：trim 后为空说明这行只有空白，
  // 强行 JSON.parse 会抛错并进入 catch，反而多一次异常开销。
  const trimmed = raw.trim();
  // [失败路径] 只有空白的 raw 直接原样返回：这是合法的空行，不是解析失败。
  if (!trimmed) {
    return raw;
  }

  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

// 把一条 tap 记录映射成 UI 帧；无 direction 的记录无法归类，返回 null 由调用方过滤丢弃。
// 帧 id 由 workspaceHash + 文件内序号 + 时间戳组成，重复轮询同一文件时保持不变，
// 因此选中态可在刷新间保留；bytes 缺失时以 raw 长度近似（非精确字节数，仅用于展示量级）。
// [权衡] bytes 缺失时用 raw.length 近似：多字节字符会偏大，
//   但这里只用于展示量级，不值得为精确字节数在浏览器里重新编码。
function mapTapRecordToFrame(
  envelope: StdioTrafficApiRecordEnvelope,
  workspaceHash: string | undefined,
): StdioTrafficFrame | null {
  const record = envelope.record;
  // [失败路径] direction 缺失说明这行不是 tap 代理写的结构化记录，
  // 丢弃比猜测更安全：猜错方向会让上行/下行筛选结果失真。
  if (!record.direction) {
    return null;
  }

  // [事务] kind 在一次映射内只算一次，并同时喂给 getTrafficRecordSummary：
  // 两处各算一次可能因 record 的宽松类型产生不一致的判定。
  const kind = getTrafficRecordKind(record);
  return {
    id: `real-${workspaceHash ?? "workspace"}-${envelope.index}-${record.ts ?? ""}`,
    timestamp: formatIsoTrafficTimestamp(record.ts),
    direction: record.direction,
    kind,
    method: readString(record.method),
    messageId: readMessageId(record.id),
    sessionId: readString(record.sessionId),
    inputId: readString(record.inputId),
    summary: getTrafficRecordSummary(record, kind),
    bytes: typeof record.bytes === "number" ? record.bytes : (record.raw ?? "").length,
    raw: record.raw ?? JSON.stringify(record.message ?? record),
  };
}

// 按 messageId 给 request/response 互相打上 linkedId，便于详情面板展示"配对帧"。
// 同一 id 出现多次时后写覆盖先写（以文件中较晚的记录为准）；只做浅拷贝补充字段，不修改入参帧。
// 无 id 或对端缺失的帧原样返回，linkedId 保持 undefined。
// [并发] 这个函数是纯的：只返回新数组与新对象，绝不修改入参帧。
//   入参可能正是上一轮 state，原地写 linkedId 会造成「数据变了但引用没变」。
function linkTrafficFrames(frames: StdioTrafficFrame[]) {
  const requestByMessageId = new Map<string, StdioTrafficFrame>();
  // [并发] 只建对端索引而不是双向边表：配对是「单向查一次」，
  // 双向写入会让同一 id 重复入表，后写覆盖先写的语义变得难以推理。
  const responseByMessageId = new Map<string, StdioTrafficFrame>();

  for (const frame of frames) {
    // [失败路径] 无 messageId 的帧原样返回：stderr 与 notification 没有可配对的对端，
    // 强行给它们编号会让详情面板显示错误的「配对帧」。
    if (!frame.messageId) {
      continue;
    }
    if (frame.kind === "request") {
      requestByMessageId.set(frame.messageId, frame);
    } else if (frame.kind === "response") {
      responseByMessageId.set(frame.messageId, frame);
    }
  }

  return frames.map((frame) => {
    if (!frame.messageId) {
      return frame;
    }
    const linkedFrame =
      frame.kind === "request"
        ? responseByMessageId.get(frame.messageId)
        : frame.kind === "response"
          ? requestByMessageId.get(frame.messageId)
          : undefined;
    return linkedFrame ? { ...frame, linkedId: linkedFrame.id } : frame;
  });
}

// 真实流量映射入口：先逐条转帧（丢弃无 direction 的记录），再按 messageId 配对；
// 返回值未排序，排序由调用方统一处理。
// [权衡] 先 map 再 filter，而不是在 map 里返回 undefined：
//   这样类型守卫能让下游直接拿到非空 StdioTrafficFrame[]，避免逐处判空。
function mapRealTrafficFrames(realTraffic: RealTrafficState) {
  return linkTrafficFrames(
    realTraffic.records
      .map((envelope) => mapTapRecordToFrame(envelope, realTraffic.workspaceHash))
      .filter((frame): frame is StdioTrafficFrame => frame !== null),
  );
}

// mock 模式合成帧：仅用于演示，按序号取模决定帧种类——
// 每 7 帧一次 stderr、每 5 帧一次 send(request) 与一次 ack(response)，其余为 session/event 通知。
// id 带序号保证唯一；内容固定模板，不代表真实协议字段的完整性。
// [失败路径] id 必须带 sequence：同一毫秒内合成两帧时时间戳会重复，
//   仅靠时间戳无法在列表里区分它们。
function createLiveStdioTrafficFrame(sequence: number, timestamp: string): StdioTrafficFrame {
  const inputId = `inp_live_${String(sequence % 100).padStart(2, "0")}`;
  const messageId = String(20 + sequence);
  // [权衡] 事件序号与 messageId 共用同一基数：演示时 send/ack/event 三类帧
  // 在视觉上保持连续编号，便于讲解同一轮输入内的先后关系。
  const eventSeq = 20 + sequence;

  if (sequence % 7 === 4) {
    return {
      id: `live-stderr-${sequence}`,
      timestamp,
      direction: "agent-stderr",
      kind: "stderr",
      sessionId: "sess_6b6a",
      summary: "provider heartbeat",
      bytes: 96,
      raw: `[zcode-agent] provider heartbeat seq=${eventSeq} status=streaming`,
    };
  }

  if (sequence % 5 === 1) {
    return {
      id: `live-send-${sequence}`,
      timestamp,
      direction: "app-to-agent",
      kind: "request",
      method: "session/send",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "new user input",
      bytes: 586,
      raw: `{
  "id": ${messageId},
  "method": "session/send",
  "params": {
    "sessionId": "sess_6b6a",
    "inputId": "${inputId}",
    "content": "debug live stdio frame ${sequence}"
  }
}`,
    };
  }

  if (sequence % 5 === 2) {
    return {
      id: `live-ack-${sequence}`,
      timestamp,
      direction: "agent-to-app",
      kind: "response",
      messageId,
      sessionId: "sess_6b6a",
      inputId,
      summary: "session/send accepted",
      bytes: 104,
      latencyMs: 8,
      raw: `{
  "id": ${messageId},
  "result": {
    "accepted": true,
    "inputId": "${inputId}"
  }
}`,
    };
  }

  return {
    id: `live-event-${sequence}`,
    timestamp,
    direction: "agent-to-app",
    kind: "notification",
    method: "session/event",
    sessionId: "sess_6b6a",
    inputId,
    summary: sequence % 3 === 0 ? "message.part.delta" : "turn.progress",
    bytes: 520 + (sequence % 6) * 24,
    raw: `{
  "method": "session/event",
  "params": {
    "sessionId": "sess_6b6a",
    "seq": ${eventSeq},
    "payload": {
      "type": "${sequence % 3 === 0 ? "message.part.delta" : "turn.progress"}",
      "inputId": "${inputId}"
    }
  }
}`,
  };
}

// 文档站根组件：持有视图、搜索词、当前概念与主题四项跨视图状态，
// 并把 stdio 视图整体挂到子组件，避免其轮询状态污染协议视图。
// 切换视图只改 URL query（replaceState），不做页面跳转；除懒加载 import 外无网络副作用。
// [权衡] activeView 用惰性初值函数而不是 useState(getInitialDocsView())：
//   后者每次渲染都会执行一次 URL 解析。
export function App() {
  // [权衡] 传函数而不是调用结果：useState(getInitialDocsView) 只在首次渲染解析 URL，
  // 写成 useState(getInitialDocsView()) 则每次渲染都读一次 location。
  const [activeView, setActiveView] = useState<DocsView>(getInitialDocsView);
  // [权衡] 搜索词不写进 URL：它是临时筛选条件，写进 history 会让返回键行为变复杂，
  // 且与 view 参数的生命周期完全不同（view 需要跨刷新保持）。
  const [query, setQuery] = useState("");
  // 默认选中 inputId：它是协议迁移后"用户输入归属"的核心概念，作为首屏讲解入口。
  // [失败路径] 初值必须是 conceptById 里真实存在的 id：
  // 虽然读取处有 ?? concepts[0] 兜底，但初值写错会让首屏选中态与详情区对不上号。
  const [activeConceptId, setActiveConceptId] = useState("inputId");
  // [权衡] 主题只放本地 state，不写 localStorage：文档站是开发辅助页面，
  //   刷新回到浅色可接受；写存储会与主应用的同一个主题键互相覆盖。
  const [isDark, setIsDark] = useState(false);
  // [并发] 归一化在渲染期直接算，不用 useMemo：只是 toLowerCase + trim，
  //   比依赖比较更便宜，且保证永远与 query 同拍。
  const normalizedQuery = normalizeText(query);
  // 概念被搜索过滤掉后仍可能处于选中态，详情区用 activeConcept 继续展示，列表则只列命中项。
  // [失败路径] 这里必须用未过滤的 conceptById 回查：selected 概念可能被搜索隐藏，
  //   但详情区仍要能展示它，否则搜索会「顺手删掉」正在读的内容。
  const activeConcept = conceptById.get(activeConceptId) ?? concepts[0];

  // 搜索只影响结构列表的展示范围，不改变路由、滚动位置或当前选中概念。
  // [性能] 结构表是静态常量，依赖只有归一化后的 query：
  //   依赖写成 query 会让每个字符都触发整张字段表的重新过滤。
  const filteredStructures = useMemo(
    () => structures.filter((structure) => matchesStructure(structure, normalizedQuery)),
    [normalizedQuery],
  );

  // 概念索引列表只列命中项；详情区仍用未过滤的 activeConcept，避免搜索时详情闪空。
  // [失败路径] 命中为空时列表区留空，但不回退成全量：
  //   否则用户会以为搜索没生效。
  const filteredConcepts = useMemo(
    () => concepts.filter((concept) => matchesConcept(concept, normalizedQuery)),
    [normalizedQuery],
  );

  // [失败路径] URL 必须基于 window.location.href 构造，不能手工拼字符串：
  //   这样才能保留 hash 与其他 query 参数，不会把 #concept-xxx 丢掉。
  const selectView = useCallback((view: DocsView) => {
    setActiveView(view);
    // 用 replaceState 而非 pushState：视图切换不堆历史记录，避免用户返回时需多次回退。
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(null, "", url);
  }, []);

  // 标题下方的一句话说明：随视图变化，帮助用户确认当前看到的是哪类文档。
  // [权衡] 用嵌套三元而不是查表：文案只与四个视图一一对应，
  //   查表会多一份 Record<DocsView, string> 的维护成本且更容易漏键。
  const viewDescription =
    activeView === "capabilities"
      ? "产品能力群、维护边界与跨域语义关系"
      : activeView === "boundary"
        ? "feature-boundary-planner YAML 的节点、关系与边界"
        : activeView === "protocol"
          ? "trace / input / session 数据结构迁移与协议字段说明"
          : "Agent stdio 实时抓包与协议帧检查";

  return (
    <div className={isDark ? "dark min-h-dvh" : "min-h-dvh"}>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="sticky top-0 z-20 border-b border-border bg-header/95 backdrop-blur">
          <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-8 shrink-0 place-items-center rounded-lg border border-card-border bg-card">
                <Network className="size-4 text-brand" />
              </div>
              <div className="min-w-0">
                <h1 className="text-ui-lg font-medium">ZCode Developer Docs</h1>
                <p className="text-ui-sm text-foreground-subtle">{viewDescription}</p>
              </div>
            </div>
            <div className="flex min-w-0 flex-col gap-2 md:flex-row md:items-center">
              <nav className="grid grid-cols-4 rounded-lg border border-border bg-surface p-0.5">
                <ViewButton
                  active={activeView === "stdio"}
                  icon={<Radio className="size-4" />}
                  label="stdio 抓包"
                  mobileLabel="stdio"
                  onClick={() => selectView("stdio")}
                />
                <ViewButton
                  active={activeView === "protocol"}
                  icon={<Braces className="size-4" />}
                  label="协议字段"
                  mobileLabel="协议"
                  onClick={() => selectView("protocol")}
                />
                <ViewButton
                  active={activeView === "capabilities"}
                  icon={<Waypoints className="size-4" />}
                  label="能力地图"
                  mobileLabel="能力"
                  onClick={() => selectView("capabilities")}
                />
                <ViewButton
                  active={activeView === "boundary"}
                  icon={<GitBranch className="size-4" />}
                  label="Feature Boundary"
                  mobileLabel="边界"
                  onClick={() => selectView("boundary")}
                />
              </nav>
              {activeView === "protocol" ? (
                <label className="relative min-w-0 flex-1 md:w-80 md:flex-none">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
                  <input
                    className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="搜索字段、结构、概念"
                  />
                </label>
              ) : null}
              <button
                className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-surface text-foreground hover:bg-surface-hover"
                type="button"
                onClick={() => setIsDark((value) => !value)}
                aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
                title={isDark ? "切换浅色主题" : "切换深色主题"}
              >
                {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </button>
            </div>
          </div>
        </header>

        {activeView === "stdio" ? (
          // stdio 视图与入口同文件，直接内联渲染，不需要懒加载和 Suspense 包裹。
          <StdioTrafficView />
        ) : activeView === "boundary" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载 Feature Boundary 图谱…
              </main>
            }
          >
            <FeatureBoundaryGraphView />
          </Suspense>
        ) : activeView === "capabilities" ? (
          <Suspense
            fallback={
              <main className="grid min-h-[680px] place-items-center p-4 text-ui-base text-foreground-subtle">
                正在加载能力地图…
              </main>
            }
          >
            <CapabilityMapView />
          </Suspense>
        ) : (
          // 剩余分支固定为 protocol 视图；懒加载组件均包 Suspense，加载期展示占位文案。
          <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[240px_minmax(0,1fr)_300px]">
            <aside className="hidden lg:block">
              <div className="sticky top-20 rounded-lg border border-card-border bg-card p-2">
                <div className="px-2 py-1 text-ui-sm font-medium text-foreground-subtle">
                  结构目录
                </div>
                <nav className="mt-1 flex flex-col gap-1">
                  {structures.map((structure) => (
                    <a
                      className="rounded-md px-2 py-1.5 text-ui-sm text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
                      href={`#${structure.id}`}
                      key={structure.id}
                    >
                      {structure.title}
                    </a>
                  ))}
                </nav>
              </div>
            </aside>

            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border border-card-border bg-card p-4">
                <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-brand">
                      <GitCompareArrows className="size-4" />
                      数据结构迁移
                    </div>
                    <h2 className="text-ui-lg font-medium">
                      从 `traceId` 混用到 `traceId + inputId` 双轴模型
                    </h2>
                    <p className="mt-2 max-w-3xl text-ui-base leading-6 text-foreground-subtle">
                      这次变更把“观测链路”和“用户输入归属”拆开：`traceId`
                      保持日志与协议事件追踪，`inputId` 负责每次发送、排队、stop
                      和终态收口。`sessionId` 仍是 agent server 生成的会话主键。
                    </p>
                  </div>
                  <div className="grid min-w-56 gap-2 rounded-lg border border-border bg-surface p-3 text-ui-sm">
                    <Metric label="结构" value={String(structures.length)} />
                    <Metric label="概念" value={String(concepts.length)} />
                    <Metric label="协议面" value={String(protocolSurfaces.length)} />
                  </div>
                </div>
              </section>

              <section className="grid gap-3 md:grid-cols-3">
                <SummaryCard
                  icon={<Hash className="size-4" />}
                  title="sessionId"
                  body="会话主键，server 生成。UI/task 进入 ZCode Protocol 前必须拿到它。"
                  conceptId="sessionId"
                  onSelect={setActiveConceptId}
                />
                <SummaryCard
                  icon={<Network className="size-4" />}
                  title="traceId"
                  body="观测链路，UUID 格式，不再用作每次 prompt 的 run id。"
                  conceptId="traceId"
                  onSelect={setActiveConceptId}
                />
                <SummaryCard
                  icon={<Boxes className="size-4" />}
                  title="inputId"
                  body="每次用户输入的归属，贯穿 send、turn event、stream event 和 UI 收口。"
                  conceptId="inputId"
                  onSelect={setActiveConceptId}
                />
              </section>

              <section className="rounded-lg border border-card-border bg-card p-4" id="flow">
                <div className="mb-3 flex items-center gap-2">
                  <Braces className="size-4 text-brand" />
                  <h2 className="text-ui-base font-medium">发送链路</h2>
                </div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                  {flows.map((step, index) => (
                    <div className="rounded-lg border border-border bg-surface p-3" key={step.id}>
                      <div className="mb-2 flex items-center justify-between gap-2">
                        <span className="font-mono text-ui-sm text-foreground-subtle">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="rounded-full border border-border px-2 py-0.5 text-ui-sm text-foreground-subtle">
                          {step.actor}
                        </span>
                      </div>
                      <h3 className="text-ui-base font-medium">{step.title}</h3>
                      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
                        {step.detail}
                      </p>
                      <ConceptLinks
                        ids={step.conceptIds}
                        activeId={activeConceptId}
                        onSelect={setActiveConceptId}
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section className="space-y-4">
                {filteredStructures.map((structure) => (
                  <StructureSection
                    activeConceptId={activeConceptId}
                    key={structure.id}
                    onSelectConcept={setActiveConceptId}
                    structure={structure}
                  />
                ))}
                {filteredStructures.length === 0 ? (
                  // 搜索无结果时给出显式空态，避免用户误以为结构数据未加载。
                  <div className="rounded-lg border border-card-border bg-card p-4 text-ui-base text-foreground-subtle">
                    没有匹配的数据结构。
                  </div>
                ) : null}
              </section>
            </div>

            <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
              <ConceptPanel
                activeConcept={activeConcept}
                activeConceptId={activeConceptId}
                filteredConcepts={filteredConcepts}
                onSelect={setActiveConceptId}
              />
              <ProtocolPanel activeConceptId={activeConceptId} onSelect={setActiveConceptId} />
            </aside>
          </main>
        )}
      </div>
    </div>
  );
}

// 顶部视图切换按钮：active 通过 aria-pressed 暴露给读屏；窄屏用 mobileLabel 压缩文案。
// [权衡] 用 aria-pressed 而不是 aria-current：这是一组筛选按钮而非导航链接，
//   读屏应播报「按下 / 未按下」。
function ViewButton({
  active,
  icon,
  label,
  mobileLabel,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  mobileLabel?: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center justify-center gap-1.5 rounded-md px-2 text-ui-sm ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">{mobileLabel ?? label}</span>
    </button>
  );
}

// 概览区的一行指标（标签 + 等宽数字），value 由调用方转成字符串，本组件不做格式化。
// [权衡] value 由调用方 String() 转换：本组件不做数字格式化，
//   避免同一个组件出现「有时带千分位、有时不带」的不一致。
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-foreground-subtle">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

// 三个核心概念卡片：点击同时触发锚点跳转与选中回调；conceptId 必须存在于 concepts，
// 否则 href 指向不存在的锚点，只高亮详情区而页面不滚动。
// [失败路径] onClick 不 preventDefault：默认行为负责滚动到锚点，
//   回调只同步选中态；去掉 href 会让「点击后定位到详情」失效。
function SummaryCard({
  body,
  conceptId,
  icon,
  onSelect,
  title,
}: {
  body: string;
  conceptId: string;
  icon: ReactNode;
  onSelect: (conceptId: string) => void;
  title: string;
}) {
  return (
    <a
      className="group rounded-lg border border-card-border bg-card p-4 hover:border-border-hover hover:bg-card-selected"
      href={`#concept-${conceptId}`}
      onClick={() => onSelect(conceptId)}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="grid size-8 place-items-center rounded-lg border border-border bg-surface text-brand">
          {icon}
        </div>
        <ArrowRight className="size-4 text-foreground-subtlest group-hover:text-foreground" />
      </div>
      <h3 className="font-mono text-ui-base font-medium">{title}</h3>
      <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{body}</p>
    </a>
  );
}

// 单个协议结构区块：标题/路径/用途 + 新旧结构对照 + 迁移说明 + 字段表。
// oldShape 为空表示该结构没有可直接引用的旧版本，此时展示固定说明文案而非空白。
// [权衡] 旧结构缺失时渲染固定文案而不是隐藏整块：两列布局需要保持对称，
//   否则新结构独占整行，新旧对照关系在视觉上消失。
function StructureSection({
  activeConceptId,
  onSelectConcept,
  structure,
}: {
  activeConceptId: string;
  onSelectConcept: (conceptId: string) => void;
  structure: StructureDoc;
}) {
  return (
    <article
      className="scroll-mt-20 rounded-lg border border-card-border bg-card"
      id={structure.id}
    >
      <div className="border-b border-border p-4">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <BookOpenText className="size-4 text-brand" />
          <h2 className="text-ui-base font-medium">{structure.title}</h2>
          <span className="rounded-full border border-border px-2 py-0.5 font-mono text-ui-sm text-foreground-subtle">
            {structure.path}
          </span>
        </div>
        <p className="text-ui-base leading-6 text-foreground-subtle">{structure.purpose}</p>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {structure.oldShape ? (
            <CodePanel label="旧结构" value={structure.oldShape} />
          ) : (
            <CodePanel label="旧结构" value="无直接旧结构，属于新增协议结构说明。" />
          )}
          <CodePanel label="新结构" value={structure.newShape} />
        </div>
        <div className="mt-3 rounded-lg border border-border bg-accent/60 p-3 text-ui-sm leading-5 text-foreground">
          {structure.migration}
        </div>
      </div>
      <FieldTable
        activeConceptId={activeConceptId}
        fields={structure.fields}
        onSelectConcept={onSelectConcept}
      />
    </article>
  );
}

// 代码片段面板：保留换行与空白，长行自动折行；value 为已格式化好的纯文本，不做语法高亮。
// [性能] whitespace-pre-wrap 与 break-words 必须成对：只 pre 会让长 JSON 行撑出横向滚动，
//   只 wrap 会把缩进吃掉。
function CodePanel({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="mb-2 text-ui-sm font-medium text-foreground-subtle">{label}</div>
      <code className="block whitespace-pre-wrap break-words font-mono text-ui-sm leading-5 text-foreground">
        {value}
      </code>
    </div>
  );
}

// 字段明细表：每行一个 FieldDoc，行 key 用 name+source 保证同名字段来自不同结构时不冲突；
// 表格强制最小宽度并横向滚动，避免窄屏把类型/含义挤压到不可读。
// [权衡] min-w-[920px] 配合外层 overflow-x-auto：字段多且内容长，
//   允许横向滚动优于压缩到不可读；窄屏下这是唯一需要横向滚动的区域。
function FieldTable({
  activeConceptId,
  fields,
  onSelectConcept,
}: {
  activeConceptId: string;
  fields: FieldDoc[];
  onSelectConcept: (conceptId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[920px] border-collapse text-left text-ui-sm">
        <thead className="bg-surface text-foreground-subtle">
          <tr>
            <Th>字段</Th>
            <Th>类型</Th>
            <Th>状态</Th>
            <Th>含义</Th>
            <Th>Owner</Th>
            <Th>关联概念</Th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field) => (
            <tr className="border-t border-border align-top" key={`${field.name}-${field.source}`}>
              <td className="w-44 p-3">
                <div className="font-mono text-foreground">{field.name}</div>
                {field.oldName ? (
                  <div className="mt-1 font-mono text-foreground-subtlest">
                    old: {field.oldName}
                  </div>
                ) : null}
              </td>
              <td className="w-56 p-3 font-mono text-foreground-subtle">{field.type}</td>
              <td className="w-24 p-3">
                <RequiredBadge required={field.required} />
              </td>
              <td className="min-w-80 p-3">
                <p className="leading-5 text-foreground">{field.meaning}</p>
                {field.notes ? (
                  <p className="mt-1 leading-5 text-foreground-subtle">{field.notes}</p>
                ) : null}
                <p className="mt-1 font-mono text-ui-xs leading-5 text-foreground-subtlest">
                  {field.source}
                </p>
              </td>
              <td className="w-36 p-3 text-foreground-subtle">{field.owner}</td>
              <td className="w-56 p-3">
                <ConceptLinks
                  activeId={activeConceptId}
                  ids={field.conceptIds}
                  onSelect={onSelectConcept}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// 表头单元格：统一底部边线样式，仅承载文本。
function Th({ children }: { children: ReactNode }) {
  return <th className="border-b border-border px-3 py-2 font-medium">{children}</th>;
}

// 字段必填性徽标：required 必填、optional 可选、其余（如 deprecated 兼容字段）显示"兼容"。
// [失败路径] 第三个分支覆盖 deprecated 等兼容值：
//   required 的实际取值比「必填/可选」多，不能用二值判断兜底。
function RequiredBadge({ required }: { required: FieldDoc["required"] }) {
  const label = required === "required" ? "必填" : required === "optional" ? "可选" : "兼容";
  const className =
    required === "required"
      ? "border-brand/35 bg-brand/12 text-foreground"
      : required === "optional"
        ? "border-border bg-surface text-foreground-subtle"
        : "border-warning/35 bg-warning/12 text-foreground";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 ${className}`}>{label}</span>
  );
}

// 概念链接组：id 未在概念索引中命中时降级显示原始 id，保证链接不丢；点击同步更新选中概念。
// [失败路径] concept 未命中时降级展示原始 id：静态数据里允许出现指向未收录概念的引用，
//   直接读 concept.name 会抛 TypeError 并中断整张字段表。
function ConceptLinks({
  activeId,
  ids,
  onSelect,
}: {
  activeId: string;
  ids: string[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const concept = conceptById.get(id);
        // [失败路径] 只做字符串比较，不回查 concept：id 可能指向未收录概念，
        // 此时仍要能把当前项高亮出来。
        const active = id === activeId;
        return (
          <a
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-ui-xs ${
              active
                ? "border-brand bg-brand text-foreground-inverse"
                : "border-border bg-tag text-foreground"
            }`}
            href={`#concept-${id}`}
            key={id}
            onClick={() => onSelect(id)}
            title={concept?.summary ?? id}
          >
            <LinkIcon className="size-3" />
            {concept?.name ?? id}
          </a>
        );
      })}
    </div>
  );
}

// 右侧概念索引面板：上部展示当前选中概念的详情（不存在时留空），
// 下部列出搜索命中的概念；列表高度上限 420px 并内部滚动，避免撑高整页。
// [权衡] 详情与索引列表放在同一张卡片：详情随选中项变化，
//   拆成两块会让右栏在无选中项时出现空洞。
// [性能] 列表容器固定 max-h 并内部滚动，避免几十个概念把整页高度撑开。
function ConceptPanel({
  activeConcept,
  activeConceptId,
  filteredConcepts,
  onSelect,
}: {
  activeConcept: Concept | undefined;
  activeConceptId: string;
  filteredConcepts: Concept[];
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card">
      <div className="border-b border-border p-3">
        <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-brand">
          <Hash className="size-4" />
          概念索引
        </div>
        {activeConcept ? (
          <div className="scroll-mt-20" id={`concept-${activeConcept.id}`}>
            <div className="mt-2 flex items-center gap-2">
              <code className="font-mono text-ui-base font-medium">{activeConcept.name}</code>
              <span
                className={`rounded-full border px-2 py-0.5 text-ui-xs ${kindClassName[activeConcept.kind]}`}
              >
                {kindLabel[activeConcept.kind]}
              </span>
            </div>
            <p className="mt-2 text-ui-sm leading-5 text-foreground-subtle">
              {activeConcept.summary}
            </p>
            <dl className="mt-3 grid gap-2 text-ui-sm">
              <DetailRow label="生命周期" value={activeConcept.lifecycle} />
              <DetailRow label="Owner" value={activeConcept.owner} />
              <DetailRow label="来源" value={activeConcept.source} mono />
            </dl>
            {activeConcept.related.length > 0 ? (
              <ConceptLinks
                activeId={activeConceptId}
                ids={activeConcept.related}
                onSelect={onSelect}
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="max-h-[420px] overflow-y-auto p-2">
        {filteredConcepts.map((concept) => (
          <a
            className={`mb-1 block rounded-md px-2 py-1.5 text-ui-sm ${
              concept.id === activeConceptId
                ? "bg-selected text-foreground"
                : "text-foreground-subtle hover:bg-menu-hover hover:text-foreground"
            }`}
            href={`#concept-${concept.id}`}
            key={concept.id}
            onClick={() => onSelect(concept.id)}
          >
            <span className="font-mono">{concept.name}</span>
            <span className="ml-2 text-foreground-subtlest">{kindLabel[concept.kind]}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

// 概念详情中的单行定义（dt/dd）：mono 为 true 时用等宽字体展示源码路径等标识符。
// [权衡] 用 dl/dt/dd 而不是 div：概念详情本质是「术语-定义」对，
//   语义结构对读屏更友好，样式成本几乎为零。
function DetailRow({ label, mono, value }: { label: string; mono?: boolean; value: string }) {
  return (
    <div>
      <dt className="text-foreground-subtlest">{label}</dt>
      <dd className={`mt-0.5 leading-5 text-foreground ${mono ? "font-mono text-ui-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

// @zcode/protocol 协议面速览：每个 surface 展示标题、摘要、字段名与关联概念链接，
// 只读静态数据，不参与搜索过滤。
// [权衡] 协议面不参与搜索过滤：它是全局速览，
//   跟着搜索词变化会让右栏在输入时反复塌缩，打断阅读。
function ProtocolPanel({
  activeConceptId,
  onSelect,
}: {
  activeConceptId: string;
  onSelect: (conceptId: string) => void;
}) {
  return (
    <section className="rounded-lg border border-card-border bg-card p-3">
      <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
        <Network className="size-4" />
        @zcode/protocol
      </div>
      <div className="space-y-2">
        {protocolSurfaces.map((surface) => (
          <div className="rounded-lg border border-border bg-surface p-3" key={surface.id}>
            <h3 className="text-ui-base font-medium">{surface.title}</h3>
            <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{surface.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {surface.fields.map((field) => (
                <span
                  className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle"
                  key={field}
                >
                  {field}
                </span>
              ))}
            </div>
            <ConceptLinks activeId={activeConceptId} ids={surface.conceptIds} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </section>
  );
}

// stdio 抓包视图：在"真实 tail"与"mock replay"两种数据源间切换，列表按时间倒序展示，
// 右侧固定展示选中帧详情与配对帧。帧列表长度在 mock 模式上限 48 条；real 模式上限由接口 limit=400 控制。
// 副作用：real 模式每秒轮询 /api/dev/stdio-traffic（interval 在卸载/切模式时清理）；
// mock 模式每 1800ms 合成一帧。两种模式互相切换时都会重置跟随态并重新设置选中帧。
// [并发] 本组件的所有副作用都由 trafficSourceMode 单点分流：
//   任何新增的取数逻辑都必须先判断模式，否则两套数据源会互相覆盖写 trafficFrames。
function StdioTrafficView() {
  // mock 回放的首屏种子：静态示例帧按时间倒序，只计算一次，切换回 mock 时用于重置。
  // [权衡] 依赖数组为空是刻意的：种子帧是构建期常量，
  //   依赖 stdioTrafficFrames 会在热更新时重建数组，让 startMockReplay 的重置语义漂移。
  const initialFrames = useMemo(() => sortTrafficFramesByNewest(stdioTrafficFrames), []);
  // 当前展示用的帧列表：real 模式每次轮询整体替换，mock 模式在头部插入并截断。
  // [并发] 这是唯一承载列表的 state，real 与 mock 都只能通过 setTrafficFrames 写入；
  // 任何绕过它直接改数组元素的写法都会让「整表替换」的语义失效。
  const [trafficFrames, setTrafficFrames] = useState<StdioTrafficFrame[]>([]);
  // [权衡] 搜索词留在本地 state 而不写 URL：帧列表每秒变化，
  //   把高频输入同步到 history 会产生大量 replaceState，且刷新后也无意义。
  const [trafficQuery, setTrafficQuery] = useState("");
  // [失败路径] 初值必须是 all：若默认某个方向，首屏会「看起来没抓到包」，
  //   实际只是另一半方向的帧被过滤了。
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>("all");
  // [权衡] 默认 real 而不是 mock：默认态应反映真实链路，
  //   否则开发者第一次打开会把合成数据当成 agent 真的在跑。
  const [trafficSourceMode, setTrafficSourceMode] = useState<TrafficSourceMode>("real");
  // 是否跟随最新帧：为 true 时新帧到达会自动选中，用户手动选中历史帧后置为 false。
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  // 当前选中帧 id；为空串表示尚未选中，渲染时按回退链取第一帧。
  // [失败路径] 用空串而不是 null：让「尚未选中」与「选中帧被轮转掉」
  //   走同一条回退链，不需要额外的 undefined 分支。
  const [selectedFrameId, setSelectedFrameId] = useState("");
  // latest 展示时间：real 模式优先用文件 updatedAt，mock 模式用最新合成帧时间。
  // [失败路径] 初值用占位符而不是空串：占位符在等宽字体下宽度固定，
  // 首帧数据到达时 latest 文案不会发生左右跳动。
  const [lastUpdatedAt, setLastUpdatedAt] = useState("--:--:--.---");
  // 真实数据源状态；初值固定 logDir，避免加载期间侧栏出现空路径。
  // [失败路径] 初值就带上 logDir：首屏 loading 期间侧栏也要显示候选路径，
  // 否则用户会先看到一行空白的 source 卡片。
  const [realTraffic, setRealTraffic] = useState<RealTrafficState>({
    status: "loading",
    logDir: "~/.zcode/v2/dev/stdio-traffic",
    records: [],
  });
  // mock 帧序号：用 ref 保存，避免每帧更新都触发额外渲染。
  // [并发] 序号用 ref 而不是 state：定时器里自增不应触发渲染，
  //   渲染只由 setTrafficFrames 驱动，避免一次合成产生两次提交。
  const liveSequenceRef = useRef(0);
  // [性能] 归一化与 real 列表无关，不放进 filteredFrames 的 useMemo 体内：
  // 放在外面可以让过滤器只依赖归一化结果，而不是原始输入。
  const normalizedTrafficQuery = normalizeText(trafficQuery);
  // latest 展示取最大时间戳对应的帧：列表已按时间倒序，第 0 项即最新。
  // [失败路径] 这里依赖「trafficFrames 恒为时间倒序」这个前提：
  //   任何新增写入路径都必须经过 sortTrafficFramesByNewest，否则 latest 会取错。
  const latestFrame = trafficFrames[0];
  // [权衡] 抽成布尔常量而不是到处写 === "mock"：
  //   它同时被 effect 早退、按钮文案与徽标复用，集中一处便于核对语义。
  const isMockReplayEnabled = trafficSourceMode === "mock";

  // 拉取一次真实流量：limit=400 限制单次返回量，no-store 禁用缓存保证 tail 实时；
  // 非 2xx 抛错并落到 catch，统一把状态置为 error 且清空记录（保留 logDir 便于提示路径）。
  // 注意：请求没有 AbortController，组件卸载后仍可能有一次 in-flight 响应写回状态。
  // [资源] 没有 AbortController 是有意的取舍：文档站单页、请求极轻，
  //   卸载后的一次写回不会再触发渲染；加中断反而要额外处理 AbortError 分支。
  const fetchRealTraffic = useCallback(async () => {
    try {
      // [权衡] no-store 必须保留：tap 文件每秒追加，任何 HTTP 缓存都会让面板停止更新。
      const response = await fetch("/api/dev/stdio-traffic?limit=400", { cache: "no-store" });
      // [失败路径] 非 2xx 必须抛错走统一 catch：直接解析错误响应体，
      // 会把 HTML 错误页当成 JSON 再抛一次 JSON 解析异常，错误信息反而丢失。
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = (await response.json()) as StdioTrafficApiResponse;
      // records 非数组时兜底为空，防止后端异常返回导致后续 map 崩溃。
      // [失败路径] 成功分支整表替换而不是合并：接口返回即快照，
      //       合并会残留已被截断或轮转掉的历史帧。
      setRealTraffic({
        status: data.status,
        logDir: data.logDir,
        records: Array.isArray(data.records) ? data.records : [],
        error: data.error,
        filePath: data.filePath,
        updatedAt: data.updatedAt,
        workspaceHash: data.workspaceHash,
      });
    } catch (error) {
      // 失败时保留上一次的 logDir（用函数式更新），只把状态与错误信息改掉，并清空记录防展示过期数据。
      setRealTraffic((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        records: [],
      }));
    }
  }, []);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      // mock 模式下不轮询真实接口，避免两套数据源同时写 trafficFrames。
      return;
    }

    void fetchRealTraffic();
    // 1s 轮询：tap 文件由本地进程追加写入，用 setInterval 而非递归 setTimeout 保持固定节奏。
    // [资源] 1s 是展示精度与文件 IO 的折中：更快会放大 tap 文件读取，
    //     更慢则看不清流式事件之间的先后关系。
    const timer = window.setInterval(() => {
      void fetchRealTraffic();
    }, 1000);

    // [资源] 清理函数是 effect 的唯一出口：切换模式或卸载时若漏掉，
    // 旧计时器会继续每秒写入已卸载组件的 state。
    return () => window.clearInterval(timer);
  }, [fetchRealTraffic, trafficSourceMode]);

  useEffect(() => {
    if (trafficSourceMode !== "real") {
      // 退出 real 模式时不再用真实数据覆盖 mock 列表。
      return;
    }

    // [失败路径] 每次 realTraffic 变化都全量重算并整表替换：
    // 增量合并需要处理文件截断与 workspace 切换，收益不抵复杂度。
    const realFrames = sortTrafficFramesByNewest(mapRealTrafficFrames(realTraffic));
    setTrafficFrames(realFrames);
    setLastUpdatedAt(
      realTraffic.updatedAt
        ? formatIsoTrafficTimestamp(realTraffic.updatedAt)
        : (realFrames[0]?.timestamp ?? "--:--:--.---"),
    );
    // [并发] 用函数式更新读取最新选中 id：轮询每秒触发一次，
    // 闭包里的 selectedFrameId 可能已过期，直接比较会误判为「被轮转掉」。
    setSelectedFrameId((currentFrameId) =>
      // 跟随最新时总选第一帧；不跟随时仅在选中帧已被轮转掉（文件截断/换 workspace）时回退。
      isFollowingLatest || !realFrames.some((frame) => frame.id === currentFrameId)
        ? (realFrames[0]?.id ?? "")
        : currentFrameId,
    );
  }, [isFollowingLatest, realTraffic, trafficSourceMode]);

  useEffect(() => {
    if (!isMockReplayEnabled) {
      // 只有 mock 模式才启动合成定时器；切回 real 时该 effect 会被清理。
      return;
    }

    // mock replay 只用于演示；真实调试默认走 Vite 本地 API 读取 tap proxy 的 NDJSON。
    // [权衡] 1800ms 刻意不是整秒：与 real 的 1s 轮询错开，
    //     切换模式时能一眼看出节奏变化，也避免两套计时器同拍触发。
    const timer = window.setInterval(() => {
      liveSequenceRef.current += 1;
      // [失败路径] 合成帧的时间戳必须取当前时钟而不是复用上一帧：
      // 否则刚插入的新帧在倒序排序里可能落到中间，follow 会选错。
      const nextFrame = createLiveStdioTrafficFrame(
        liveSequenceRef.current,
        formatTrafficTimestamp(new Date()),
      );

      setTrafficFrames((currentFrames) =>
        // 每帧都重新排序并截断到 48 条：mock 时间戳为本地时钟，倒序保证第一项始终最新。
        // [并发] 用函数式 set 基于上一轮列表拼接：定时器闭包会捕获旧 trafficFrames，
        // 直接依赖闭包变量会丢掉两次 tick 之间用户触发的重置。
        sortTrafficFramesByNewest([nextFrame, ...currentFrames]).slice(0, 48),
      );
      setLastUpdatedAt(nextFrame.timestamp);

      if (isFollowingLatest) {
        setSelectedFrameId(nextFrame.id);
      }
    // [失败路径] 每帧都重新排序并截断：只插不截会让列表无限增长，
    //     只截不排则最新合成帧可能不在第一位，follow 会选错帧。
    }, 1800);

    // [资源] mock 计时器同样必须清理：退出回放后仍在合成帧，
    // 会让下一次进入 real 的第一秒看到凭空多出来的一条记录。
    return () => window.clearInterval(timer);
  }, [isFollowingLatest, isMockReplayEnabled]);

  // 恢复跟随态并立即选中当前最新帧；trafficFrames 为空时选中空串，详情区会显示空态提示。
  // [失败路径] 列表为空时选中空串交给回退链与详情空态兜住，
  //   不能提前 return，否则「跟随」按钮在空列表上点不动。
  const followLatest = () => {
    setIsFollowingLatest(true);
    setSelectedFrameId(trafficFrames[0]?.id ?? "");
  };

  // 启动 mock 回放：序号归零、用静态种子帧重置列表，并强制回到跟随最新。
  // [事务] 五个 set 必须一起提交：序号、列表、时间、跟随态、选中帧。
  //   若分两次渲染，中间会出现「新列表 + 旧选中 id」的闪烁。
  const startMockReplay = () => {
    // [事务] 序号归零必须与列表重置同时发生：否则新序列的 id 会与旧种子帧 id 段重叠，
    // React 列表 key 冲突会导致行状态错乱。
    liveSequenceRef.current = 0;
    setTrafficFrames(initialFrames);
    setLastUpdatedAt(initialFrames[0]?.timestamp ?? "--:--:--.---");
    setIsFollowingLatest(true);
    setTrafficSourceMode("mock");
    setSelectedFrameId(initialFrames[0]?.id ?? "");
  };

  // 停止 mock 回放：切回 real 并立刻拉取一次，避免等待下一个 1s 轮询才出数据。
  // [并发] 立即 fetch 一次是必要的：轮询 effect 要等下一个 tick，
  //   否则最长 1s 内列表仍是 mock 数据，徽标却已变成 real tail。
  const stopMockReplay = () => {
    // [权衡] 停止回放时归零而不是保留：再次进入 mock 会重放同一组序列，
    // 便于按固定脚本演示，而不是每次接上上次的随机位置。
    liveSequenceRef.current = 0;
    setTrafficSourceMode("real");
    void fetchRealTraffic();
  };

  // 手动刷新按钮按当前模式分流：mock 模式重放种子，real 模式只重新拉取（不清空现有列表）。
  // [权衡] mock 下「刷新」等价于重放种子而不是继续合成：
  //   这样能复现同一组示例帧，便于对照协议文档逐条讲解。
  const refreshTrafficSource = () => {
    if (trafficSourceMode === "mock") {
      startMockReplay();
      return;
    }

    void fetchRealTraffic();
  };

  // 过滤后再排序：方向过滤优先，其次在 id/时间/方向/kind/method/各 id/摘要/raw 中做子串搜索；
  // 空查询直接放行，排序保证过滤结果仍是最新在前。
  // [性能] 搜索语料在每次过滤时拼接：帧上限 real 400 / mock 48，
  //   预建索引的收益不足以抵消额外的失效维护成本。
  const filteredFrames = useMemo(
    () =>
      sortTrafficFramesByNewest(
        trafficFrames.filter((frame) => {
          // [失败路径] all 必须显式放行，而不是依赖「没有匹配项就不过滤」：
          // 后者会把未知 direction 的帧也放进列表，与方向过滤的语义相反。
          const directionMatches = directionFilter === "all" || frame.direction === directionFilter;
          if (!directionMatches) {
            return false;
          }
          // [失败路径] 空查询直接放行而不是拿空串去 includes：
          // 后者虽然恒为 true，但每次过滤都要白拼一次长语料。
          if (!normalizedTrafficQuery) {
            return true;
          }
          const haystack = [
            frame.id,
            frame.timestamp,
            frame.direction,
            frame.kind,
            frame.method ?? "",
            frame.messageId ?? "",
            frame.sessionId ?? "",
            frame.inputId ?? "",
            frame.summary,
            frame.raw,
          ]
            .join(" ")
            .toLowerCase();
          return haystack.includes(normalizedTrafficQuery);
        }),
      ),
    [directionFilter, normalizedTrafficQuery, trafficFrames],
  );

  // 选中帧回退链：当前选中（过滤结果内）→ 当前选中（未过滤列表内）→ 过滤结果第一帧 → 全部第一帧。
  // 这样即使选中的帧被搜索/方向过滤隐藏，详情面板仍能展示它而不是跳到别的帧。
  // [失败路径] 四级回退是「详情永不消失」的唯一保障：
  //   去掉任一环都会出现「列表有帧但右侧空白」的状态。
  const selectedFrame =
    filteredFrames.find((frame) => frame.id === selectedFrameId) ??
    trafficFrames.find((frame) => frame.id === selectedFrameId) ??
    filteredFrames[0] ??
    trafficFrames[0];

  // 配对帧从完整列表里找（不受过滤影响），保证请求/响应配对展示不因当前筛选缺失。
  // [失败路径] linkedId 指向的帧可能已被截断（real 轮转 / mock 48 条上限），
  //   find 失败时返回 undefined，配对区整体不渲染而不是展示半截信息。
  const linkedFrame = selectedFrame?.linkedId
    ? trafficFrames.find((frame) => frame.id === selectedFrame.linkedId)
    : undefined;
  // 状态徽标文案：mock 模式固定 "mock replay"，real 模式 ready 显示 "real tail"，其余直接展示状态枚举。
  // [权衡] ready 映射成 real tail 而不是直接显示枚举：
  //   「状态词」面向人，「枚举值」面向排障，混用会让徽标语义模糊。
  const trafficStatusLabel =
    trafficSourceMode === "mock"
      ? "mock replay"
      : realTraffic.status === "ready"
        ? "real tail"
        : realTraffic.status;
  const trafficStatusClassName =
    trafficSourceMode === "mock"
      ? "border-warning/35 bg-warning/12 text-foreground"
      : realTraffic.status === "ready"
        ? "border-success/35 bg-success/12 text-foreground"
        : "border-border bg-surface text-foreground-subtle";
  // 源路径展示：mock 模式写死说明文本，real 模式优先实际文件路径，缺失时退回目录/默认目录。
  // [失败路径] 三级兜底（filePath → logDir → 常量）保证 source 卡片永不为空，
  //   空路径会让用户不知道该去哪个目录找 tap 文件。
  const sourcePath =
    trafficSourceMode === "mock"
      ? "mock replay"
      : (realTraffic.filePath ?? realTraffic.logDir ?? "~/.zcode/v2/dev/stdio-traffic");
  // 空列表文案按状态给出可操作提示：missing 提示如何开启抓取，error 附带原因，其余为等待态。
  // [失败路径] 每种状态都要给可操作提示：missing 说明如何开启抓取，
  //   error 附带原始错误文本；只写「暂无数据」会让用户无从下手。
  const emptyTrafficMessage =
    trafficSourceMode === "mock"
      ? "mock replay 暂无 frame。"
      : realTraffic.status === "missing"
        ? "没有找到 stdio tap 文件。先在开发环境 Help 里打开抓取开关并启动一个 agent。"
        : realTraffic.status === "error"
          ? `读取 stdio tap 失败：${realTraffic.error ?? "unknown error"}`
          : "等待真实 stdio traffic。";

  return (
    <main className="grid w-full gap-4 px-4 py-4 xl:grid-cols-[minmax(0,1fr)_320px]">
      <div className="min-w-0">
        <section className="rounded-lg border border-card-border bg-card">
          <div className="border-b border-border p-3">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <Activity className="size-4 text-brand" />
                <h2 className="whitespace-nowrap text-ui-lg font-medium">Traffic Inspector</h2>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-ui-xs ${trafficStatusClassName}`}
                >
                  {trafficStatusLabel}
                </span>
                <span className="font-mono text-ui-sm text-foreground-subtle">
                  latest {lastUpdatedAt}
                </span>
              </div>
              <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                <label className="relative min-w-0 sm:w-72">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-foreground-subtlest" />
                  <input
                    className="h-8 w-full rounded-lg border border-input-border bg-input pl-8 pr-3 text-ui-base text-foreground outline-none placeholder:text-foreground-subtlest focus:border-input-border-focused focus:bg-input-focused"
                    value={trafficQuery}
                    onChange={(event) => setTrafficQuery(event.target.value)}
                    placeholder="搜索 method、id、inputId、raw"
                  />
                </label>
                <div className="flex rounded-lg border border-border bg-surface p-0.5">
                  <DirectionButton
                    active={directionFilter === "all"}
                    icon={<ListFilter className="size-3.5" />}
                    label="全部"
                    onClick={() => setDirectionFilter("all")}
                  />
                  <DirectionButton
                    active={directionFilter === "app-to-agent"}
                    icon={<ArrowUp className="size-3.5" />}
                    label="上行"
                    onClick={() => setDirectionFilter("app-to-agent")}
                  />
                  <DirectionButton
                    active={directionFilter === "agent-to-app"}
                    icon={<ArrowDown className="size-3.5" />}
                    label="下行"
                    onClick={() => setDirectionFilter("agent-to-app")}
                  />
                  <DirectionButton
                    active={directionFilter === "agent-stderr"}
                    icon={<Terminal className="size-3.5" />}
                    label="stderr"
                    onClick={() => setDirectionFilter("agent-stderr")}
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="grid min-h-[calc(100dvh-160px)] lg:grid-cols-[minmax(0,0.9fr)_minmax(520px,1.1fr)]">
            <div className="min-w-0 border-b border-border lg:border-b-0 lg:border-r">
              <div className="grid grid-cols-[84px_120px_minmax(0,1fr)_88px] border-b border-border bg-surface px-3 py-2 text-ui-sm font-medium text-foreground-subtle">
                <span>时间</span>
                <span>方向</span>
                <span>方法 / 摘要</span>
                <span className="text-right">大小</span>
              </div>
              <div className="max-h-[520px] overflow-y-auto">
                {filteredFrames.map((frame) => (
                  <TrafficFrameRow
                    active={frame.id === selectedFrame?.id}
                    frame={frame}
                    key={frame.id}
                    onSelect={() => {
                      setSelectedFrameId(frame.id);
                      // 只有点中最新的那一帧才恢复跟随；点历史帧后停止自动跳转，方便查看细节。
                      setIsFollowingLatest(frame.id === trafficFrames[0]?.id);
                    }}
                  />
                ))}
                {filteredFrames.length === 0 ? (
                  <div className="p-4 text-ui-base text-foreground-subtle">
                    {emptyTrafficMessage}
                  </div>
                ) : null}
              </div>
            </div>

            <TrafficFrameDetail frame={selectedFrame} linkedFrame={linkedFrame} />
          </div>
        </section>
      </div>

      <aside className="space-y-4 xl:sticky xl:top-20 xl:self-start">
        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <HardDrive className="size-4" />
            Tail Source
          </div>
          <div className="grid gap-2">
            <TrafficStat label="状态" value={trafficStatusLabel} />
            <TrafficStat label="跟随" value={isFollowingLatest ? "latest" : "selected"} />
            <TrafficStat label="帧数" value={String(trafficFrames.length)} />
            <TrafficStat
              label="最新方向"
              value={latestFrame ? directionLabel[latestFrame.direction] : "-"}
            />
            <TrafficStat label="workspaceHash" value={realTraffic.workspaceHash ?? "-"} />
          </div>
          <div className="mt-3 rounded-lg border border-border bg-surface p-2">
            <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-foreground-subtle">
              <Terminal className="size-4" />
              source
            </div>
            <code className="block break-words font-mono text-ui-xs leading-5 text-foreground">
              {sourcePath}
            </code>
          </div>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <Filter className="size-4" />
            Controls
          </div>
          <div className="grid gap-2">
            <InspectorAction
              active={isFollowingLatest}
              icon={<Radio className="size-4" />}
              label="Follow latest"
              onClick={followLatest}
            />
            <InspectorAction
              active={isMockReplayEnabled}
              icon={
                isMockReplayEnabled ? <Pause className="size-4" /> : <Play className="size-4" />
              }
              label={isMockReplayEnabled ? "Stop mock replay" : "Start mock replay"}
              onClick={isMockReplayEnabled ? stopMockReplay : startMockReplay}
            />
            <InspectorAction
              icon={<FileJson className="size-4" />}
              label={trafficSourceMode === "mock" ? "Reset mock" : "Reload real source"}
              onClick={refreshTrafficSource}
            />
          </div>
        </section>

        <section className="rounded-lg border border-card-border bg-card p-3">
          <div className="mb-3 flex items-center gap-2 text-ui-sm font-medium text-brand">
            <Database className="size-4" />
            record 字段
          </div>
          <div className="space-y-2">
            {stdioTrafficLogFields.map((field) => (
              <div className="rounded-lg border border-border bg-surface p-2" key={field.name}>
                <div className="flex items-center justify-between gap-2">
                  <code className="font-mono text-ui-sm text-foreground">{field.name}</code>
                  <span className="font-mono text-ui-xs text-foreground-subtlest">
                    {field.type}
                  </span>
                </div>
                <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{field.meaning}</p>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </main>
  );
}

// 侧栏统计卡片：label/value 均为纯文本，value 过长时截断并保留 title 悬浮提示。
// [权衡] 截断但保留 title：workspaceHash 与路径可能很长，
//   撑破侧栏比悬浮查看更影响阅读。
function TrafficStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <div className="text-ui-sm text-foreground-subtle">{label}</div>
      <div className="mt-1 truncate font-mono text-ui-base text-foreground" title={value}>
        {value}
      </div>
    </div>
  );
}

// 方向筛选按钮：与视图按钮共用 aria-pressed 语义，文案不随窄屏变化（本身已足够短）。
// [权衡] 文案不随断点变化：四个方向词本身已足够短，
//   再加一份 mobileLabel 只会增加两处需要同步的文案。
function DirectionButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`inline-flex h-7 items-center gap-1 rounded-md px-2 text-ui-sm whitespace-nowrap ${
        active
          ? "bg-card text-foreground shadow-sm"
          : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

// 列表单行：时间 / 方向徽标 / method 或 kind + messageId / 字节数四列固定栅格，与表头列宽一致。
// 无 method 的帧（stderr、response）用 kind 作为主文案，避免出现空标题。
// [失败路径] 主文案用 frame.method ?? frame.kind：stderr 与 response 没有 method，
//   直接渲染 method 会出现空标题行，用户无法判断这条是什么。
function TrafficFrameRow({
  active,
  frame,
  onSelect,
}: {
  active: boolean;
  frame: StdioTrafficFrame;
  onSelect: () => void;
}) {
  return (
    <button
      className={`grid w-full grid-cols-[84px_120px_minmax(0,1fr)_88px] items-start gap-0 border-b border-border px-3 py-2 text-left hover:bg-surface-hover ${
        active ? "bg-selected" : ""
      }`}
      type="button"
      onClick={onSelect}
    >
      <span className="font-mono text-ui-sm text-foreground-subtle">{frame.timestamp}</span>
      <span
        className={`mr-2 inline-flex w-fit rounded-full border px-2 py-0.5 font-mono text-ui-xs ${directionClassName[frame.direction]}`}
      >
        {directionLabel[frame.direction]}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-ui-sm text-foreground">
          {frame.method ?? frame.kind}
          {frame.messageId ? (
            <span className="text-foreground-subtlest"> #{frame.messageId}</span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-ui-sm text-foreground-subtle">
          {frame.summary}
        </span>
      </span>
      <span className="text-right font-mono text-ui-sm text-foreground-subtle">{frame.bytes}b</span>
    </button>
  );
}

// 帧详情面板：展示方向/时间/主文案/摘要、可选标识 pill、配对帧与格式化后的完整 raw。
// frame 为空（列表为空或选中的帧已被销毁）时给出显式提示，不渲染空面板。
// [失败路径] frame 为空必须给显式提示而不是 return null：
//   右侧整块消失会让布局塌成单列，看起来像页面出错。
function TrafficFrameDetail({
  frame,
  linkedFrame,
}: {
  frame: StdioTrafficFrame | undefined;
  linkedFrame: StdioTrafficFrame | undefined;
}) {
  if (!frame) {
    // 列表为空或选中帧被移除时的兜底提示，避免详情区出现空白。
    return (
      <div className="p-4 text-ui-base text-foreground-subtle">请选择一条 traffic frame。</div>
    );
  }

  return (
    <aside className="min-w-0 p-3">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-2">
            <span
              className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-ui-xs ${directionClassName[frame.direction]}`}
            >
              {directionLabel[frame.direction]}
            </span>
            <span className="font-mono text-ui-sm text-foreground-subtle">{frame.timestamp}</span>
          </div>
          <h3 className="truncate text-ui-base font-medium">{frame.method ?? frame.kind}</h3>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{frame.summary}</p>
        </div>
      </div>

      <div className="grid gap-2 text-ui-sm">
        <DetailPill label="kind" value={frame.kind} />
        {frame.messageId ? <DetailPill label="id" value={frame.messageId} /> : null}
        {frame.sessionId ? <DetailPill label="session" value={frame.sessionId} /> : null}
        {frame.inputId ? <DetailPill label="input" value={frame.inputId} /> : null}
        {typeof frame.latencyMs === "number" ? (
          <DetailPill label="latency" value={`${frame.latencyMs}ms`} />
        ) : null}
      </div>

      {linkedFrame ? (
        <div className="mt-3 rounded-lg border border-border bg-surface p-3">
          <div className="mb-1 flex items-center gap-2 text-ui-sm font-medium text-foreground">
            <GitCompareArrows className="size-4 text-brand" />
            配对帧
          </div>
          <p className="font-mono text-ui-sm text-foreground-subtle">
            {linkedFrame.timestamp} · {linkedFrame.method ?? linkedFrame.kind}
            {linkedFrame.messageId ? ` #${linkedFrame.messageId}` : ""}
          </p>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">{linkedFrame.summary}</p>
        </div>
      ) : null}

      <div className="mt-3">
        <div className="mb-2 flex items-center gap-2 text-ui-sm font-medium text-foreground-subtle">
          <FileJson className="size-4" />
          raw line
        </div>
        <code className="block max-h-[calc(100dvh-420px)] min-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-ui-sm leading-5 text-foreground">
          {formatRawLine(frame.raw)}
        </code>
      </div>
    </aside>
  );
}

// 详情中的标识行（label + 等宽 value），value 由调用方判空后决定是否渲染该行。
// [权衡] 行由调用方判空后决定是否渲染：本组件不处理 undefined，
//   避免出现「标签在、值空着」的半个 pill。
function DetailPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-2 py-1.5">
      <span className="text-foreground-subtle">{label}</span>
      <span className="min-w-0 truncate font-mono text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

// 侧栏操作按钮：active 仅控制品牌色边框，表示"当前生效/已启用"状态（如跟随最新、mock 模式）。
// [权衡] active 只控制边框与底色，不禁用点击：
//   「跟随最新」在已激活时仍应可点（幂等重选最新帧）。
function InspectorAction({
  active = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2 text-left text-ui-sm text-foreground hover:bg-surface-hover ${
        active ? "border-brand/35 bg-selected" : "border-border bg-surface"
      }`}
      type="button"
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
