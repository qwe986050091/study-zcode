// ============================================================================
// RemoteConnectionConnectingStep.tsx — 远程连接向导的「连接中」阶段视图
//
// 职责边界：
//   - 只做投影：把日志里的 [source-server:<phase>] 行归并成四段阶段轨，不发起连接。
//   - 不持有连接状态：logs / loading / errorMessage / connectionReady 全部由上层传入。
//   - 原始英文日志不直接展示为阶段说明，只做日志区原文与反馈附件。
//
// 四段阶段轨（顺序固定，不能按 backend 增删）：
//   channel → identify → deploy → handshake
//   原始 phase 到四段的映射只在 normalizeRemoteConnectionPhase 维护一份；
//   侧栏详情与向导共用它，任何一侧另写映射都会让两处进度不一致。
//
// 不变量（INV）。每条注明「守住它的位置」与「改错故障」。
//
// INV-01 只有匹配 /^\[source-server:<phase>\]/ 的日志才能推进阶段。
//   守住它的位置：resolveRemoteConnectionPhases 的正则与 continue。
//   改错故障：把任意日志当阶段事件，普通 info 行会随机推进进度条。
//
// INV-02 阶段进度取历史最大下标，永不回退。
//   守住它的位置：activeIndex = Math.max(activeIndex, phaseIndex)。
//   改错故障：重连时日志从头再来，进度会从 handshake 跳回 channel。
//
// INV-03 失败只标记「出错的那一段」，已完成阶段保持 complete。
//   守住它的位置：failedIndex 只记录 level=error 的 phaseIndex。
//   改错故障：整条轨变红，用户无法判断是传输失败还是安装失败。
//
// INV-04 connectionReady 是权威终态，但存在失败阶段时不得把它当成功。
//   守住它的位置：connectionReady 表达式末尾的 failedIndex < 0。
//   改错故障：连接 session 已 ready 但部署报错时，阶段轨显示全部完成并隐藏错误面板。
//
// INV-05 publish-online 日志是 ready 的兼容替代信号。
//   守住它的位置：logs.some(startsWith("[source-server:publish-online]"))。
//   改错故障：旧 Host 不推 session ready 时，顶部已连接但阶段轨永久停在 handshake。
//
// INV-06 操作进度遇到尾部终态（ready / error）必须视为「尚无日志」。
//   守住它的位置：resolveRemoteOperationProgress 的 tail 判断。
//   改错故障：断线重试前显示上一次的「第 4/4 步 · 已用 120 分」，像是正在卡住。
//
// INV-07 percent 只在最后一条日志是 upload/download 时给出，且向下取整。
//   守住它的位置：transfer 条件与 Math.floor。
//   改错故障：把其它阶段的 progress 当百分比，进度条会在 0% 与 100% 之间乱跳。
//
// INV-08 startedAt 取本次操作首条日志时间，用于耗时展示。
//   守住它的位置：...(logs[0] ? { startedAt: logs[0].timestamp } : {})。
//   改错故障：用当前时间当起点，耗时永远显示 0s。
//
// INV-09 阶段子说明只接受结构化数据，映射不到时返回 null。
//   守住它的位置：resolveRemoteConnectionPhaseSub 的 default: return null。
//   改错故障：把原始英文日志塞进子说明，与中文阶段名混排且泄露内部细节。
//
// INV-10 凭据等待、安装确认与强制更新会把阶段强制拨到固定位置。
//   守住它的位置：waitingPhase = credentials ? channel : (install || forceUpdate) ? deploy。
//   改错故障：凭据表单出现在 handshake 段，用户以为密码是在握手后才需要。
//
// INV-11 waitingPhase 覆盖时，之前阶段 complete、当前 active、之后 pending。
//   守住它的位置：phases.map 里 waitingIndex 的三元状态。
//   改错故障：覆盖状态与日志进度混用，出现两个 active 阶段或全部 complete。
//
// INV-12 loading 且完全没有日志时，只把第一段标为 active。
//   守住它的位置：if (loading && !logs.length && index === 0)。
//   改错故障：首帧四段全是 pending，用户以为连接没启动。
//
// INV-13 logTime 只解析 HH:MM:SS，解析失败回退到 mountedAt。
//   守住它的位置：logTime 的 match 失败分支。
//   改错故障：返回 NaN 后耗时显示 NaN s，并让排序/比较全部失效。
//
// INV-14 跨日回退只在「解析结果比当前晚 12 小时以上」时执行一次。
//   守住它的位置：date.getTime() - wallNow > 12h 的单次 setDate。
//   改错故障：展示时钟略慢于日志时把当天日志算成昨天，耗时多出 24 小时。
//
// INV-15 日志自动跟随只在用户原本贴底时生效。
//   守住它的位置：shouldFollowLatestLogRef 与 scrollRemoteConnectionLogsToLatestIfFollowing。
//   改错故障：用户向上翻看历史日志，每秒被新日志拉回底部，无法阅读。
//
// INV-16 出现 errorMessage 时必须自动展开日志区。
//   守住它的位置：logsExpanded 初值与 errorMessage effect。
//   改错故障：连接失败但日志默认折叠，用户看不到失败原因也无从反馈。
//
// INV-17 errorCode 缺省但存在凭据表单时，错误分类必须用 credentials-required。
//   守住它的位置：classifyRemoteConnectionError 入参的三元覆盖。
//   改错故障：首次连接就要求密码的场景被归为「未知错误」，展示重试而不是输入框。
//
// INV-18 展示状态有严格优先级：forceUpdate > upgrading > install > loading > upgrade > failed > online > absent。
//   守住它的位置：resolveRemoteConnectionPresentation 的 state 嵌套三元。
//   改错故障：顺序调换会让「正在升级」同时显示为「连接失败」，错误面板与进度条并存。
//
// INV-19 failed 必须同时排除 loading 与 cancelled。
//   守住它的位置：const failed = status === "failed" && !loading && !cancelled。
//   改错故障：用户主动取消后界面变成失败态，底部按钮从「重试」错变「关闭」。
//
// INV-20 错误面板的主按钮必须穷尽所有 primaryAction，最后一支固定是 retry。
//   守住它的位置：onClick 里 if/else-if 链的末尾 else onRetry()。
//   改错故障：新增 action 没有分支时按钮点了没反应，用户只能关闭向导。
//
// INV-21 错误面板归属的阶段：凭据→channel，身份变更→identify，否则 failed/active/channel。
//   守住它的位置：const errorPhase 的三元回退链。
//   改错故障：错误面板挂到错误阶段，用户会在别处寻找失败原因。
//
// INV-22 反馈正文只取最后 30 条日志，并且必须经过 redactFeedbackText。
//   守住它的位置：buildRemoteConnectionFeedbackDescription 的 slice(-30) 与包层。
//   改错故障：日志里的 token / 路径原样进入反馈，造成凭据与隐私泄露。
//
// INV-23 反馈入口默认不附带日志文件与截图。
//   守住它的位置：openFeedbackSubmit 传 includeLogs: false、screenshots: []。
//   改错故障：不经用户同意就上传日志或页面截图，属于越权采集。
//
// INV-24 1s ticker 只在 loading 时运行，并在卸载或 loading 结束时清理。
//   守住它的位置：effect 顶部 if (!loading) return 与 cleanup。
//   改错故障：连接成功后仍每秒 setState，向导长时间停留时持续重渲染。
//
// INV-25 强制更新列表的 key 必须用 workspaceIdentity 优先、路径兜底。
//   守住它的位置：key={`${task.workspaceIdentity ?? task.workspacePath}:${task.sessionId}`}。
//   改错故障：只用路径时远程与本地的同名路径会撞 key，列表项复用错任务信息。
//
// ============================================================================
import { redactFeedbackText } from "@zcode/shared";
import { usePlatform } from "@/hooks/usePlatform.js";
import { RemotePasswordInput } from "@/remote-connection/RemotePasswordInput.js";
import {
  classifyRemoteConnectionError,
  resolveRemoteConnectionPresentation,
} from "@/lib/remoteConnectionPresentation.js";
import {
  RemoteConnectionStatusTag,
  RemoteConnectionKindTag,
} from "@/remote-connection/RemoteConnectionTags.js";
import {
  DesktopCommandIds,
  type SourceServerInstallPreview,
  type SourceServerOperationLog,
  type SourceServerRunningTask,
} from "@zcode/shared";
/* eslint-disable max-lines -- 连接阶段清单、日志和错误恢复共享同一视图状态，保持原子交互。 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronRightIcon,
  LoaderIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";
import { type RemoteTarget } from "@zcode/shared";
import { TID_SSH_ERROR } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import {
  formatRemoteLinkRailTarget,
  formatRemoteLinkRailDevice,
} from "@/remote-connection/RemoteLinkRail.js";
import {
  isRemoteConnectionLogScrolledToLatest,
  scrollRemoteConnectionLogsToLatestIfFollowing,
} from "@/remote-connection/remoteConnectionLogScroll.js";

/** 连接向导与侧栏详情共用的用户阶段；原始 phase 的归并规则只在这里维护一份。 */
// [权衡] 用 as const 数组而不是对象：顺序即进度，数组遍历能同时得到 index 与 titleId，
// 对象需要 Object.entries 再排序，反而多一层易错的间接。
const REMOTE_CONNECTION_PHASES = [
  ["channel", "remote.phase.channel"],
  ["identify", "remote.phase.identify"],
  ["deploy", "remote.phase.deploy"],
  ["handshake", "remote.phase.handshake"],
] as const;

// [权衡] 四态而不是布尔：阶段轨需要同时表达「未开始 / 正在做 / 做完 / 出错」，
// 用两个布尔会让「失败但曾完成」这种非法组合变得可表达。
export type RemoteConnectionPhaseStatus = "pending" | "active" | "complete" | "failed";

// [事务] 这是原始 phase 到四段轨的唯一映射：新增 backend phase 时只改这里，
// resolveRemoteConnectionPhases 与侧栏详情都复用同一个函数。
// [失败路径] 未知 phase 返回 null 而不是原样返回：
// 原样返回会让 findIndex 命中 -1 之外的偶然值，污染进度计算。
function normalizeRemoteConnectionPhase(rawPhase: string): string | null {
  if (rawPhase === "probe") return "channel";
  if (rawPhase === "directory-record") return "identify";
  if (rawPhase === "publish-online") return "handshake";
  if (rawPhase === "daemon" || rawPhase === "protocol-handshake" || rawPhase === "restart")
    return "handshake";
  if (
    rawPhase === "download" ||
    rawPhase === "preflight" ||
    rawPhase === "upload" ||
    rawPhase === "extract" ||
    rawPhase === "verify-archive" ||
    rawPhase === "verify" ||
    rawPhase === "install"
  ) {
    return "deploy";
  }
  if (rawPhase === "channel") return "channel";
  return REMOTE_CONNECTION_PHASES.some(([key]) => key === rawPhase) ? rawPhase : null;
}

// [并发] 纯函数：只读 logs 并返回新数组，不缓存上一次结果；
// 调用方可能在日志追加的同一帧重算，任何内部状态都会造成跨渲染污染。
export function resolveRemoteConnectionPhases(
  logs: ReadonlyArray<Pick<RemoteConnectionLogEntry, "message" | "level">>,
  options: { connectionReady?: boolean } = {},
) {
  // [失败路径] 初值 -1 表示「还没有任何阶段日志」：
  // 若从 0 开始，空日志会被误判成 channel 已 active，首帧就显示错误进度。
  let activeIndex = -1;
  let failedIndex = -1;
  // [性能] 单次线性扫描同时求 activeIndex 与 failedIndex：
  // 分别扫两遍会让长日志（数百行）在每次日志追加时多付一倍解析成本。
  for (const log of logs) {
    // [失败路径] 正则必须锚定行首：日志正文里可能引用其它 phase 的名字，
    // 不锚定会把「讨论 channel 的普通日志」误判成阶段事件。
    const match = /^\[source-server:([^\]]+)\]/u.exec(log.message);
    // [失败路径] 不匹配前缀的日志直接跳过：连接日志里混有大量普通信息行，
    // 逐行抛错或计入阶段都会让进度判断偏离真实流程。
    if (!match) continue;
    const phaseIndex = REMOTE_CONNECTION_PHASES.findIndex(
      ([key]) => key === normalizeRemoteConnectionPhase(match[1]!),
    );
    // [失败路径] 未知 phase 不推进也不报错：Host 可能比 UI 先支持新阶段，
    // 忽略它可以让旧版界面继续按已知阶段工作。
    if (phaseIndex < 0) continue;
    activeIndex = Math.max(activeIndex, phaseIndex);
    if (log.level === "error") failedIndex = phaseIndex;
  }
  // 修复原因：成功连接后 publish-online 不是 Renderer 日志流的可靠终结事件，
  // 仅按日志推断会出现顶部已连接但阶段轨永久停在握手中的状态。连接 session ready
  // 是同一条连接流程的权威终态；没有错误阶段时用它完成最终阶段，不改变连接中的日志进度。
  // [权衡] 两个 ready 信号取或：session ready 是新链路，publish-online 兼容旧 Host；
  // 任一成立即可，但都要求没有失败阶段（INV-04）。
  const connectionReady =
    (options.connectionReady === true ||
      logs.some((log) => log.message.startsWith("[source-server:publish-online]"))) &&
    failedIndex < 0;
  return REMOTE_CONNECTION_PHASES.map(([key, titleId], index) => ({
    key,
    titleId,
    // [失败路径] failed 优先于 connectionReady 与 active：同一阶段既报错又收到 ready 时，
    // 必须让用户看到失败，而不是被「已完成」覆盖。
    status: (failedIndex === index
      ? "failed"
      : connectionReady
        ? "complete"
        : index < activeIndex
          ? "complete"
          : index === activeIndex
            ? "active"
            : "pending") as RemoteConnectionPhaseStatus,
  }));
}

// [失败路径] percent 是可选字段：只有传输阶段能给出百分比，
// 调用方必须用 undefined 判断「无进度」，不能把 0 当成没有数据。
export interface RemoteOperationProgress {
  index: number;
  total: number;
  titleId: string;
  /** 仅最新一条是上传/下载进度时存在，0-100 整数。 */
  percent?: number;
  /** 本次操作首条日志时间；Host 每次新操作都会替换旧日志。 */
  startedAt?: number;
}

/** 侧栏详情只投影阶段与进度，不展示原始日志文本。 */
// [权衡] 侧栏只投影 index/percent/startedAt，不回传原始日志：
// 详情面板的空间有限，原文展示交给连接向导的日志区。
export function resolveRemoteOperationProgress(
  allLogs: ReadonlyArray<
    Pick<SourceServerOperationLog, "phase" | "progress" | "timestamp" | "level">
  >,
): RemoteOperationProgress {
  // 修复原因：Host 保留的是“最近一次操作”而非“进行中的操作”；断线后首次重试前、两次重试之间
  // 读到的是已结束的上一次操作，曾显示“第 4/4 步 · 已用 120 分”。终态（ready / error）
  // 说明该操作已结束，按尚无日志展示，等下一次尝试由 Host 替换日志。
  // [失败路径] Host 保留的是「最近一次操作」而不是「进行中的操作」，
  // 因此尾部终态必须清零；这个判断不能上移到调用方，否则每个入口都要重复。
  const tail = allLogs.at(-1);
  const logs = tail && (tail.phase === "ready" || tail.level === "error") ? [] : allLogs;
  // [失败路径] index 初值 0 与阶段表长度配合：
  // 空日志时仍返回第一段的标题，避免 titleId 取到 undefined。
  let index = 0;
  for (const log of logs) {
    const key = normalizeRemoteConnectionPhase(log.phase);
    // [失败路径] found 可能为 -1，只有大于 index 才写入：
    // 直接赋值会让未知 phase 把进度打回 0。
    const found = REMOTE_CONNECTION_PHASES.findIndex(([phase]) => phase === key);
    // [并发] 只允许单调递增：日志顺序可能与实际执行顺序不同（并发上传/安装），
    // 取最大值能保证进度不会因为乱序日志回退。
    if (found > index) index = found;
  }
  // [失败路径] latest 取自清零后的 logs：
  // 这样终态日志既不会给出 percent，也不会被当成某阶段的进行中依据。
  const latest = logs.at(-1);
  // [失败路径] 同时要求 progress 存在且 phase 是传输：
  // 只看 progress 会把安装阶段的内部计数当成百分比。
  const transfer =
    latest?.progress !== undefined && (latest.phase === "upload" || latest.phase === "download");
  return {
    index,
    total: REMOTE_CONNECTION_PHASES.length,
    // [失败路径] 用非空断言是安全的：index 由 findIndex 得到且初值 0，
    // 数组是模块级常量；若将来允许空阶段表，这里必须先加兜底。
    titleId: REMOTE_CONNECTION_PHASES[index]![1],
    // [失败路径] 用条件展开而不是给 undefined：percent 字段存在即代表可展示进度，
    // 显式 undefined 会让消费方难以区分「0%」与「没有进度数据」。
    ...(transfer ? { percent: Math.floor(latest.progress! * 100) } : {}),
    ...(logs[0] ? { startedAt: logs[0].timestamp } : {}),
  };
}

/**
 * 阶段子说明（原型 s-sub）：只映射有结构化数据源的场景，映射不到时留空。
 * 原始英文日志不再直接透传，避免与原型中文说明混排。
 */
// [权衡] 返回 i18n id + values 而不是成品字符串：
// 让调用方在同一渲染里使用当前 locale，切换语言时无需重算阶段。
export function resolveRemoteConnectionPhaseSub(
  phase: { key: string; status: RemoteConnectionPhaseStatus },
  context: {
    kind?: RemoteTarget["kind"];
    recognizedDeviceName?: string;
    installConfirmationPending?: boolean;
    deployErrorReason?: string;
    rawPhase?: string;
  },
): { id: string; values?: Record<string, string> } | null {
  // [失败路径] 未知 key 落到 default 返回 null：
  // 未来新增第五段阶段时，旧版 UI 不会因为缺少子说明而崩溃。
  switch (phase.key) {
    // [权衡] channel 完成后按 kind 选更具体的文案（ssh/wsl/docker）：
    // 其余阶段共用一份文案，避免为每种后端各写四句。
    case "channel":
      return phase.status === "complete"
        ? {
            id:
              context.kind && context.kind !== "server"
                ? `remote.phaseSub.channelEstablished.${context.kind}`
                : "remote.phaseSub.channelEstablished",
          }
        : null;
    // [权衡] 已识别设备优先于「新设备安装中」：
    // 同一阶段两者可能同时为真：优先展示信息量更大的 `recognizedDeviceName`。
    case "identify":
      if (context.recognizedDeviceName) {
        return {
          id: "remote.phaseSub.identifyExisting",
          values: { device: context.recognizedDeviceName },
        };
      }
      if (context.installConfirmationPending) {
        return { id: "remote.phaseSub.identifyNew" };
      }
      return null;
    // [失败路径] 失败原因优先于等待确认：
    // 上传失败后即使用户仍停在确认面板，也必须先看到失败原因。
    case "deploy":
      if (phase.status === "failed" && context.deployErrorReason) {
        return {
          id: "remote.phaseSub.uploadFailed",
          values: { reason: context.deployErrorReason },
        };
      }
      if (context.installConfirmationPending) {
        return { id: "remote.phaseSub.deployWaitingConfirm" };
      }
      if (phase.status === "active") {
        // [性能] 映射表在分支内创建：只有 deploy 且 active 的少数帧会走到这里，
        // 提到模块级会让它在整个模块生命周期常驻，收益为零。
        const descriptions: Record<string, string> = {
          extract: "remote.phaseSub.extracting",
          "verify-archive": "remote.phaseSub.verifyingArchive",
          verify: "remote.phaseSub.verifyingFiles",
          install: "remote.phaseSub.installed",
        };
        const id = context.rawPhase && descriptions[context.rawPhase];
        if (id) return { id };
      }
      return null;
    // [失败路径] 只有 restart 有子说明：协议握手本身不需要额外文案，
    // 给每个 rawPhase 都编一句会让阶段行在快速切换时抖动。
    case "handshake":
      return phase.status === "active" && context.rawPhase === "restart"
        ? { id: "remote.phaseSub.restarting" }
        : null;
    // [失败路径] ready 不是阶段表里的一段，但日志可能出现；
    // 这里只把它映射成「在线」子说明，不改变阶段轨结构。
    case "ready":
      return phase.status === "complete" || phase.status === "active"
        ? { id: "remote.phaseSub.readyOnline" }
        : null;
    default:
      return null;
  }
}

// [并发] 组件是纯投影：所有可变状态都来自 props 或本地 UI 态（展开、时钟），
// 连接生命周期的事实（logs/loading/ready）一律不得在此二次维护。
export function RemoteConnectionConnectingStep({
  kind,
  logs,
  errorMessage,
  errorCode,
  rawError,
  upgradeTarget,
  loading,
  installConfirmation,
  target,
  recognizedDeviceName,
  profileName,
  onUseRemoteDownload,
  onBack,
  onRetry,
  upgradeRequired = false,
  upgradeLoading = false,
  onUpgrade,
  connectionReady = false,
  cancelled = false,
  onCancelConnection,
  credentials,
  forceUpdate,
  onMinimize,
  onClose,
  onBackToDevices,
  backToDevicesLabel,
}: {
  forceUpdate?: { tasks?: SourceServerRunningTask[]; onConfirm: () => void; onCancel: () => void };
  credentials?: {
    passphrase: boolean;
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
  };
  onMinimize?: () => void;
  onClose?: () => void;
  onBackToDevices?: () => void;
  backToDevicesLabel?: string;
  kind: RemoteTarget["kind"];
  logs: RemoteConnectionLogEntry[];
  errorMessage: string;
  errorCode?: string;
  rawError?: string;
  upgradeTarget?: "controller" | "server";
  loading: boolean;
  installConfirmation?: {
    target: RemoteTarget;
    preview?: SourceServerInstallPreview;
    onConfirm: () => void;
    onCancel: () => void;
  };
  target?: RemoteTarget | null;
  recognizedDeviceName?: string;
  profileName?: string;
  recognizedDeviceMeta?: string;
  localVersion?: string;
  onUseRemoteDownload?: () => void;
  onBack: () => void;
  onRetry: () => void;
  upgradeRequired?: boolean;
  upgradeLoading?: boolean;
  onUpgrade?: () => void;
  connectionReady?: boolean;
  cancelled?: boolean;
  onCancelConnection?: () => void;
  onContinueToDirectory?: () => void;
}) {
  // [性能] 只解构 intl 而不是整个上下文：
  // 阶段树每次日志变化都会重渲染，多余的上下文字段会扩大依赖面。
  const { intl } = useZCodeIntl();
  // [权衡] 用 useId 而不是固定字符串：同一页面可能同时挂载向导与详情两份实例，
  // 固定 id 会让 label 的 htmlFor 指向另一个实例的输入框。
  const credentialInputId = useId();
  // [权衡] 桌面更新走 platform.executeDesktopCommand 而不是直接调 window.zcode：
  // Web 入口没有该 API，注入式平台层能在缺省实现里安全降级。
  const platform = usePlatform();
  // [性能] 只订阅 openSubmit 这一个 action：订阅整个 store 会让日志滚动等高频状态变化
  // 带着反馈入口一起重渲染。
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  // [资源] 日志容器用 ref 而不是受控滚动：滚动位置属于 DOM 瞬时状态，
  // 写进 React state 会让每次滚动都触发整棵阶段树重渲染。
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  // [并发] 跟随标记用 ref：滚动事件每秒可能触发多次，
  // 用 state 会造成「setState → 重渲染 → 再测量」的循环；它也不参与渲染输出。
  const shouldFollowLatestLogRef = useRef(true);
  // [失败路径] 同时取 id 与 timestamp 作为 effect 依赖：
  // 只依赖 length 时，Host 替换同长度日志（重试后条数相同）不会触发重新贴底。
  const latestLogId = logs.at(-1)?.id;
  // [并发] 与 latestLogId 一起作为滚动 effect 的依赖：
  // Host 重试时会替换同长度日志，只靠 length 无法感知内容已更新。
  const latestLogTimestamp = logs.at(-1)?.timestamp;
  // [权衡] 传函数而不是 Date.now()：后者每次渲染都执行一次取时，
  // 虽然开销小，但会在严格模式下产生两次不同的初值。
  const [now, setNow] = useState(Date.now);
  // [失败路径] 挂载时刻必须与 now 分离：now 每秒变化，
  // 若共用同一个 state，没有日志的阶段耗时会永远停留在 0s。
  const [mountedAt] = useState(Date.now);
  useEffect(() => {
    if (!loading) return;
    // [资源] 1s 是耗时展示的最小可读粒度：更快的 tick 只会增加重渲染，
    // 而界面上的秒数不会因此更准。
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [loading]);
  // [事务] 三个等待源互斥且优先级固定：凭据最前（没有凭据根本走不下去），
  // 其次是安装确认与强制更新（都发生在 deploy 段）。
  const waitingPhase = credentials
    ? "channel"
    : installConfirmation || forceUpdate
      ? "deploy"
      : undefined;
  // [并发] 每次渲染重新计算阶段：日志是外部高频输入，
  // useMemo 的依赖比较（数组引用每次都变）省不下计算，反而多一层维护。
  const phases = resolveRemoteConnectionPhases(logs, { connectionReady }).map(
    (phase, index, all) => {
      const waitingIndex = all.findIndex((item) => item.key === waitingPhase);
      // [事务] 覆盖逻辑只改 status，不改 key/titleId：
      // 阶段的身份必须稳定，否则 React 会按 key 重挂列表项，动画与焦点全部丢失。
      if (waitingIndex >= 0)
        return {
          ...phase,
          status: (index < waitingIndex
            ? "complete"
            : index === waitingIndex
              ? "active"
              : "pending") as RemoteConnectionPhaseStatus,
        };
      // [失败路径] 只在「loading 且零日志」时激活首段：
      // 有日志时必须尊重日志推断，否则正在 deploy 的阶段会被强行拉回 channel。
      if (loading && !logs.length && index === 0) return { ...phase, status: "active" as const };
      return phase;
    },
  );
  // [失败路径] 日志时间只有时分秒，没有日期：
  // 这里把当天日期补上，跨日由下面的 12 小时规则单独处理。
  const logTime = (timestamp: string) => {
    // [失败路径] 只接受带秒的时间：日志时间格式固定为 HH:MM:SS，
    // 宽松匹配会把正文里的「3:05」当成时间。
    const parts = String(timestamp).match(/(\d{1,2}):(\d{2}):(\d{2})/u);
    if (!parts) return mountedAt;
    // [并发] 每次调用都重新取当前时间：logTime 会在一次渲染中被多个阶段调用，
    // 若提前缓存到渲染顶部，跨分钟时各阶段会使用不同的「今天」。
    const wallNow = Date.now();
    // [失败路径] 以本机当天为基准再 setHours：
    // 用 new Date(timestamp) 会得到 Invalid Date，因为日志串没有日期部分。
    const date = new Date(wallNow);
    // [事务] 毫秒固定清零：日志精度只到秒，
    // 保留当前毫秒会让两个相邻阶段的耗时出现随机 0.5 秒级抖动。
    date.setHours(Number(parts[1]), Number(parts[2]), Number(parts[3]), 0);
    // 展示时钟可能落后新日志不到一秒；只有明显跨日才回退，不能把新日志误判为昨天。
    // [失败路径] 只回退一天且只回退一次：日志时间来自远端时钟，
    // 可能与本机有分钟级偏差，但不会差一整天以上。
    if (date.getTime() - wallNow > 12 * 60 * 60 * 1000) date.setDate(date.getDate() - 1);
    return date.getTime();
  };
  // [性能] 先复制再 reverse：logs 是 props 数组，原地反转会修改父组件持有的引用，
  // 造成难以追踪的「日志顺序自己变了」。
  const deploymentFailedLog = [...logs]
    .reverse()
    .find(
      (entry) =>
        entry.level === "error" &&
        /^\[source-server:(?:download|preflight|upload|install)\]/u.test(entry.message),
    );
  // [失败路径] rawError 优先于 errorMessage：前者是 Host 原始错误，
  // 后者可能已被本地化成面向用户的短句，分类需要原始 code/关键词。
  const errorPresentation = classifyRemoteConnectionError({
    errorCode: credentials && !errorCode ? "credentials-required" : errorCode,
    error: rawError ?? errorMessage,
    target: target ?? undefined,
    upgradeTarget,
  });
  // [事务] 展示状态只在这一处计算：错误面板、状态标签、底部按钮全部读它，
  // 任何一处另算都会出现「标签显示已连接、按钮显示重试」的分裂。
  const presentation = resolveRemoteConnectionPresentation({
    // [失败路径] 顺序不能调整：forceUpdate 是用户已确认的阻塞态，
    // 必须压过 upgrading / install / loading，否则会出现两个互相矛盾的提示。
    // [权衡] 用嵌套三元而不是查表：每个条件都带不同的优先级语义，
    // 查表会把这个顺序藏进数据里，改错时很难发现。
    state: forceUpdate
      ? "needs-upgrade"
      : upgradeLoading
        ? "updating"
        : installConfirmation
          ? "needs-install"
          : loading
            ? "bootstrapping"
            : upgradeRequired
              ? "needs-upgrade"
              : errorMessage
                ? "failed"
                : connectionReady
                  ? "online"
                  : "absent",
    errorCode: credentials && !errorCode ? "credentials-required" : errorCode,
    error: rawError ?? errorMessage,
    upgradeTarget,
    target: target ?? undefined,
    wizard: true,
  });
  // [失败路径] cancelled 必须排除：用户主动取消不是失败，
  // 否则底部按钮会从「重试」变成「关闭」，语义完全相反。
  const failed = presentation.status === "failed" && !loading && !cancelled;
  // [资源] 用 ref 直接开 <details> 而不是受控 state：
  // 这是原生展开控件，交给 state 会在错误切换时多一次渲染且丢失原生动画。
  const errorDetailsRef = useRef<HTMLDetailsElement>(null);
  // [失败路径] 初值取决于首次渲染时是否已有错误：
  // 带着 `errorMessage` 进入时 `logsExpanded` 初值为真，用户不必先点开日志。
  const [logsExpanded, setLogsExpanded] = useState(Boolean(errorMessage));

  useEffect(() => {
    // [事务] 只自动展开、不自动折叠：错误消失后用户可能仍在读日志，
    // 反向折叠会打断阅读，也丢失手动展开的意图。
    if (errorMessage) setLogsExpanded(true);
  }, [errorMessage]);

  // [性能] 回调空依赖：它只读写 ref，不依赖任何 props；
  // 加上依赖会让滚动监听在每次日志变化时重新绑定。
  const handleLogContainerScroll = useCallback(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    shouldFollowLatestLogRef.current = isRemoteConnectionLogScrolledToLatest(container);
  }, []);

  useEffect(() => {
    const container = logContainerRef.current;
    if (!container) {
      return;
    }

    // 日志持续追加会推高 scrollHeight，无条件写 scrollTop 会把向上查看历史日志的用户拉回底部。
    // 这里只在用户原本贴底时继续跟随最新日志。
    if (
      // [并发] 贴底判定与滚动必须由同一个函数完成：先判断再滚会留出一帧的空档，
      // 期间新日志可能已经把用户顶离底部。
      scrollRemoteConnectionLogsToLatestIfFollowing(container, shouldFollowLatestLogRef.current)
    ) {
      shouldFollowLatestLogRef.current = true;
    }
  }, [logs.length, latestLogId, latestLogTimestamp]);

  // [失败路径] async 函数内部不 await 也保留 async：
  // 反馈面板的打开可能在未来变成异步，调用方已按 Promise 处理（void）。
  const handleOpenFeedback = async () => {
    // 远程连接失败时用户看到的是连接日志现场。
    // 反馈入口只预填脱敏后的错误摘要，附件由用户主动选择。
    // [资源] description 在点击时构建而不是渲染时：
    // 日志最多几百条，渲染期拼接会在每次日志追加时重复做一遍字符串处理。
    openFeedbackSubmit({
      title:
        // [失败路径] 标题最长 80 字符：反馈列表按单行展示，
        // 过长的错误首行会挤掉时间与模块等可检索字段。
        errorMessage.slice(0, 80) ||
        intl.formatMessage({ id: "feedback.submit.template.section.remoteConnectFailed" }),
      type: "bug",
      module: kind === "ssh" ? "SSH连接失败" : kind === "wsl" ? "WSL连接失败" : "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildRemoteConnectionFeedbackDescription(errorMessage, logs, (id, values) =>
        intl.formatMessage({ id }, values),
      ),
      screenshots: [],
    });
  };

  // [权衡] 安装面板内联在 deploy 阶段行里，而不是独立弹窗：
  // 它属于阶段内的确认信息，弹窗会遮住阶段轨，用户失去「现在进行到哪」的上下文。
  const installPanel = installConfirmation ? (
    // 安装确认是阶段内的中性信息面板，圆角比所属阶段行低一级。
    <div className="mt-2 flex items-start gap-3 rounded-sm border border-border bg-background px-3.5 py-3 text-ui-sm text-foreground">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-medium">
          {intl.formatMessage({ id: "remote.sourceServerInstallTitle" })}
        </p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-ui-xs">
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installTarget" })}
          </dt>
          <dd className="font-mono">{formatInstallTarget(installConfirmation.target)}</dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installVersion" })}
          </dt>
          <dd className="font-mono" data-testid="remote-install-version">
            {installConfirmation.preview?.version ??
              intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installLocation" })}
          </dt>
          <dd className="break-all font-mono" data-testid="remote-install-path">
            {installConfirmation.preview?.installPath ??
              intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
          <dt className="text-remote-foreground-muted">
            {intl.formatMessage({ id: "remote.installSize" })}
          </dt>
          <dd className="font-mono">
            {installConfirmation.preview
              ? `${(installConfirmation.preview.sizeBytes / 1048576).toFixed(1)} MB`
              : intl.formatMessage({ id: "remote.infoUnavailable" })}
          </dd>
        </dl>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button type="button" size="sm" onClick={installConfirmation.onConfirm}>
            {intl.formatMessage({
              id: "remote.sourceServerInstallConfirm",
            })}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={installConfirmation.onCancel}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </div>
      </div>
    </div>
  ) : null;
  // [事务] 错误面板与凭据表单共用同一块容器：
  // 二者互斥（有 credentials 时不显示错误详情），共用能保证高度与边框一致。
  const errorPanel =
    errorMessage || credentials ? (
      // 错误和凭据等待嵌入所属阶段；详细日志只在失败后展开。
      <div
        data-testid={TID_SSH_ERROR}
        className={cn(
          "space-y-2 rounded-sm border px-3.5 py-3",
          presentation.border,
          presentation.surface,
        )}
      >
        <p
          className={cn("flex items-center gap-2 text-ui-sm font-medium", presentation.foreground)}
        >
          {upgradeLoading ? (
            <LoaderIcon className="size-4 shrink-0 animate-spin" />
          ) : (
            <AlertTriangleIcon className="size-4 shrink-0" />
          )}
          {intl.formatMessage({
            id: upgradeLoading
              ? presentation.shortMessageId
              : credentials && !errorMessage
                ? "remote.error.credentialsRequired"
                : errorPresentation.titleId,
          })}
        </p>
        {!upgradeLoading && errorMessage ? (
          <>
            <p className="text-ui-xs text-remote-foreground-muted">
              {intl.formatMessage({ id: errorPresentation.reasonId })}
            </p>
            <details ref={errorDetailsRef} className="text-ui-xs text-remote-foreground-muted">
              <summary className="cursor-pointer">
                {intl.formatMessage({ id: "remote.error.details" })}
              </summary>
              <pre className="whitespace-pre-wrap break-words">{rawError ?? errorMessage}</pre>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void navigator.clipboard.writeText(rawError ?? errorMessage);
                }}
              >
                {intl.formatMessage({ id: "chat.toolCall.copyError" })}
              </Button>
            </details>
          </>
        ) : null}
        {credentials ? (
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault();
              credentials.onSubmit();
            }}
          >
            <label htmlFor={credentialInputId} className="block text-ui-sm">
              {intl.formatMessage({
                id: credentials.passphrase ? "ssh.privateKeyPassphrase" : "ssh.password",
              })}
            </label>
            <RemotePasswordInput
              id={credentialInputId}
              autoFocus
              required
              className="mt-1"
              data-testid={
                credentials.passphrase ? "ssh-private-key-passphrase-input" : "ssh-password-input"
              }
              value={credentials.value}
              onChange={(event) => credentials.onChange(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={loading || !credentials.value}>
              {intl.formatMessage({ id: "remote.startConnection" })}
            </Button>
          </form>
        ) : null}
        <div className="flex flex-wrap gap-2 pt-1">
          {!credentials ? (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                // [失败路径] cancel 不检查 onCancelConnection 是否存在：用可选调用，
                // 嵌入侧栏时可能不传取消回调，此时按钮仍需可点且无副作用。
                if (presentation.primaryAction === "cancel") onCancelConnection?.();
                else if (presentation.primaryAction === "update-desktop")
                  void platform.executeDesktopCommand(DesktopCommandIds.CheckForUpdates);
                else if (presentation.primaryAction === "update-server" && onUpgrade) onUpgrade();
                else if (
                  ["credentials", "edit-auth", "edit-host"].includes(presentation.primaryAction)
                )
                  onBack();
                else if (["security", "details"].includes(presentation.primaryAction)) {
                  if (errorDetailsRef.current) errorDetailsRef.current.open = true;
                // [事务] 末尾 else 是穷尽兜底：primaryAction 未来新增取值时，
                // 最坏也只是重试一次，而不是按钮完全无响应。
                } else onRetry();
              }}
              disabled={loading || upgradeLoading}
            >
              {upgradeLoading ? (
                <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
              ) : null}
              {intl.formatMessage({
                id: presentation.actionMessageId,
              })}
            </Button>
          ) : null}
          {onUseRemoteDownload && errorPresentation.allowRemoteDownload ? (
            <Button type="button" variant="secondary" size="sm" onClick={onUseRemoteDownload}>
              {intl.formatMessage({ id: "remote.useRemoteDownload" })}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" size="sm" onClick={onBack}>
            {intl.formatMessage({ id: "remote.backToConnection" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              void handleOpenFeedback();
            }}
          >
            {intl.formatMessage({ id: "remoteConnection.feedback" })}
          </Button>
        </div>
      </div>
    ) : null;
  // [失败路径] 身份变更 code 单独映射到 identify：
  // 此时日志里通常没有 error 行，若按日志推断会落到 channel，错误面板出现在错误的段。
  const errorPhase = credentials
    ? "channel"
    : errorCode === "source-server-identity-change-pending"
      ? "identify"
      : (phases.find((phase) => phase.status === "failed")?.key ??
        phases.find((phase) => phase.status === "active")?.key ??
        "channel");
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 ">
      <div className="flex flex-col flex-1 min-h-0 space-y-4 overflow-y-auto">
        <div className="shrink-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-ui-base font-semibold">
              {recognizedDeviceName ??
                profileName ??
                (target
                  ? formatRemoteLinkRailDevice(target)
                  : intl.formatMessage({ id: "remote.phase.channel" }))}
            </h3>
            {kind === "server" ? (
              <span className="text-ui-xs">Server</span>
            ) : (
              <RemoteConnectionKindTag kind={kind} />
            )}
            {cancelled ? null : <RemoteConnectionStatusTag presentation={presentation} />}
          </div>
          {target ? (
            <p className="break-all font-mono text-ui-sm text-remote-foreground-muted">
              {formatRemoteLinkRailTarget(target)}
            </p>
          ) : null}
        </div>
        <ol data-testid="remote-connection-stages" className="shrink-0 space-y-0.5 py-1">
          {phases.map((phase, phaseIndex) => {
            // [性能] 每个阶段行各自扫描 logs：阶段数固定为 4，
            // 预建 phase→首末日志索引的收益不足以抵消额外的 Map 维护。
            const phaseStart = logs.find((entry) => {
              const raw = /^\[source-server:([^\]]+)\]/u.exec(entry.message)?.[1];
              return raw && normalizeRemoteConnectionPhase(raw) === phase.key;
            });
            const nextStart = logs.find((entry) => {
              const raw = /^\[source-server:([^\]]+)\]/u.exec(entry.message)?.[1];
              return (
                raw &&
                phases.findIndex((item) => item.key === normalizeRemoteConnectionPhase(raw)) >
                  phaseIndex
              );
            });
            // [性能] 取该阶段最后一条日志用于进度与子说明：
            // `logs.reverse()` 每个阶段只做一次，日志数百条量级下可接受。
            const phaseLog = [...logs].reverse().find((entry) => {
              const match = /^\[source-server:([^\]]+)\]/u.exec(entry.message);
              return match && normalizeRemoteConnectionPhase(match[1]!) === phase.key;
            });
            // [失败路径] 空字符串兜底：phaseLog 可能不存在，
            // exec("") 返回 null，可选链继续给出 undefined，不会抛错。
            const rawPhase = /^\[source-server:([^\]]+)\]/u.exec(phaseLog?.message ?? "")?.[1];
            // [失败路径] 只在阶段 active 且 rawPhase 是传输时才解析百分比：
            // 已完成阶段的最后一条日志仍带百分比，展示它会让进度条停在 100% 不消失。
            const progressMatch =
              phase.status === "active" && (rawPhase === "upload" || rawPhase === "download")
                ? phaseLog?.message.match(/(\d+(?:\.\d+)?)%/u)
                : null;
            const transfer = phaseLog?.message.match(
              /(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) MB, (\d+(?:\.\d+)?) MB\/s/u,
            );
            // [失败路径] 速率必须大于 0 才计算剩余时间：
            // 除零会得到 Infinity，Math.ceil 之后渲染成 Infinity 秒。
            const remainingSeconds =
              transfer && Number(transfer[3]) > 0
                ? Math.max(
                    0,
                    Math.ceil((Number(transfer[2]) - Number(transfer[1])) / Number(transfer[3])),
                  )
                : undefined;
            // [事务] 子说明的入参全部来自已有结构化字段：
            // 这里不解析日志正文，避免把自由文本当成协议字段。
            const phaseSub = resolveRemoteConnectionPhaseSub(phase, {
              kind,
              rawPhase,
              recognizedDeviceName,
              installConfirmationPending: Boolean(installConfirmation),
              deployErrorReason: deploymentFailedLog?.message.replace(
                /^\[source-server:[^\]]+\]\s*/u,
                "",
              ),
            });
            return (
              <li
                key={phase.key}
                className={cn(
                  "relative flex shrink-0 min-w-0 items-start gap-3 rounded-md px-2.5 py-2 text-ui-sm",
                  // 原型 .stages li.cur：当前阶段行有 surface 底色高亮。
                  phase.status === "active" && "bg-surface",
                )}
              >
                {phaseIndex < phases.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className="absolute left-5 top-8 bottom-0 border-l border-border"
                  />
                ) : null}
                <span
                  className={cn(
                    "relative z-10 mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border",
                    phase.status === "complete"
                      ? "border-success bg-success-surface text-success-surface-foreground"
                      : phase.status === "active"
                        ? phase.key === waitingPhase
                          ? "border-warning text-warning"
                          : "border-progress-surface-foreground text-progress-surface-foreground"
                        : phase.status === "failed"
                          ? "border-destructive text-destructive"
                          : "border-border text-remote-foreground-muted",
                  )}
                >
                  {phase.status === "complete" ? (
                    <CheckIcon className="size-3" />
                  ) : phase.key === waitingPhase ? (
                    <AlertTriangleIcon className="size-3 text-warning" />
                  ) : phase.status === "active" ? (
                    <LoaderIcon className="size-3 animate-spin" />
                  ) : phase.status === "failed" ? (
                    <XIcon className="size-3" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-current" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={
                        phase.status === "pending"
                          ? "text-remote-foreground-muted"
                          : phase.status === "active"
                            ? "text-foreground font-semibold"
                            : "text-foreground"
                      }
                    >
                      {intl.formatMessage({
                        id:
                          phase.key === "channel" && kind !== "server"
                            ? `remote.phase.channel.${kind}`
                            : phase.titleId,
                      })}
                    </span>
                    {phaseStart || phase.status === "active" ? (
                      <span className="text-ui-xs tabular-nums text-remote-foreground-muted">
                        {Math.max(
                          0,
                          Math.floor(
                            ((phase.status === "complete" && nextStart
                              ? logTime(nextStart.timestamp)
                              : loading
                                ? now
                                : phaseLog
                                  ? logTime(phaseLog.timestamp)
                                  : now) -
                              (phaseStart ? logTime(phaseStart.timestamp) : mountedAt)) /
                              1000,
                          ),
                        )}{" "}
                        s
                      </span>
                    ) : null}
                  </div>
                  {phaseSub ? (
                    <p className="break-words text-ui-xs text-remote-foreground-muted">
                      {intl.formatMessage({ id: phaseSub.id }, phaseSub.values)}
                    </p>
                  ) : null}
                  {phase.key === "deploy" &&
                  !phaseSub &&
                  rawPhase &&
                  phase.status === "active" &&
                  ["download", "upload", "extract", "verify-archive", "verify", "install"].includes(
                    rawPhase,
                  ) ? (
                    <p className="mt-1 text-ui-xs text-remote-foreground-muted">
                      {intl.formatMessage({
                        id:
                          rawPhase === "download"
                            ? "remote.phaseSub.downloading"
                            : rawPhase === "upload"
                              ? "remote.phaseSub.uploading"
                              : rawPhase === "extract"
                                ? "remote.phaseSub.extracting"
                                : "remote.phaseSub.verifyingFiles",
                      })}
                    </p>
                  ) : null}
                  {phase.key === "deploy" ? installPanel : null}
                  {phase.key === "deploy" && forceUpdate ? (
                    <div className="mt-2 space-y-2 rounded-sm bg-warning-surface p-3 text-warning-surface-foreground">
                      <p className="font-medium">
                        {intl.formatMessage({ id: "settings.source.forceUpdateTitle" })}
                      </p>
                      <p>
                        {intl.formatMessage({
                          id: "settings.source.forceUpdateDescription",
                        })}
                      </p>
                      {forceUpdate.tasks?.length ? (
                        <ul className="space-y-1">
                          {forceUpdate.tasks.map((task) => (
                            <li
                              key={`${task.workspaceIdentity ?? task.workspacePath}:${task.sessionId}`}
                              className="break-all text-ui-sm"
                            >
                              <span>{task.sessionId}</span>
                              <span className="ml-2 font-mono">{task.workspacePath}</span>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>
                          {intl.formatMessage({
                            id: "remote.runningTasksUnavailable",
                          })}
                        </p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          onClick={forceUpdate.onConfirm}
                        >
                          {intl.formatMessage({ id: "settings.source.forceUpdate" })}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          onClick={forceUpdate.onCancel}
                        >
                          {intl.formatMessage({ id: "remote.cancelConnection" })}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {phase.key === errorPhase && !forceUpdate ? errorPanel : null}
                  {progressMatch ? (
                    <p className="mt-1 text-ui-xs tabular-nums text-remote-foreground-muted">
                      {phaseLog?.message.match(/\([^)]+MB[^)]*\)/u)?.[0]}
                      {" · "}
                      {intl.formatMessage(
                        {
                          id:
                            remainingSeconds === undefined
                              ? "remote.transferTimeUnknown"
                              : "remote.transferTimeRemaining",
                        },
                        { seconds: remainingSeconds ?? 0 },
                      )}
                    </p>
                  ) : null}
                  {progressMatch ? (
                    <div
                      role="progressbar"
                      aria-label={intl.formatMessage({
                        id:
                          rawPhase === "download"
                            ? "remote.phaseSub.downloading"
                            : "remote.phaseSub.uploading",
                      })}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Number(progressMatch[1])}
                      className="mt-1.5 h-1 max-w-sm overflow-hidden rounded-full bg-surface"
                    >
                      <div
                        className="h-full rounded-full bg-progress-surface-foreground"
                        style={{ width: `${progressMatch[1]}%` }}
                      />
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
        {/* 日志区使用 max-h-48 语义档位，避免把原型 180px 固化为组件专属高度。 */}
        <div className="flex flex-col">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-start px-0"
            onClick={() => setLogsExpanded((expanded) => !expanded)}
          >
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", logsExpanded && "rotate-90")}
            />
            {intl.formatMessage({ id: "remote.connectionLog" })}
            <span className="text-remote-foreground-muted">
              {intl.formatMessage(
                { id: "remote.connectionLogLines" },
                { count: String(logs.length) },
              )}
            </span>
          </Button>
          {logsExpanded ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-end"
              onClick={() => {
                void navigator.clipboard.writeText(
                  logs
                    .map((entry) => `${entry.timestamp} [${entry.level}] ${entry.message}`)
                    .join("\n"),
                );
              }}
            >
              {intl.formatMessage({ id: "remote.copyLog" })}
            </Button>
          ) : null}
          {logsExpanded ? (
            <div
              data-testid="remote-connection-log"
              ref={logContainerRef}
              onScroll={handleLogContainerScroll}
              className="mt-1 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-ui-xs leading-6"
            >
              {logs.length > 0 ? (
                logs.map((entry) => (
                  <div key={entry.id} className="w-full flex min-w-0 text-foreground">
                    <span className="text-remote-foreground-muted">{entry.timestamp}</span>
                    <span
                      className={cn(
                        "mx-2",
                        entry.level === "success"
                          ? "text-success"
                          : entry.level === "warn"
                            ? "text-warning"
                            : entry.level === "error"
                              ? "text-destructive"
                              : "text-remote-foreground-muted",
                      )}
                    >
                      [{entry.level.toUpperCase()}]
                    </span>
                    <span>{entry.message}</span>
                  </div>
                ))
              ) : (
                <div className="flex items-center justify-center py-2 text-remote-foreground-muted">
                  <span>[INFO] {intl.formatMessage({ id: "remote.connectionLogEmpty" })}</span>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border pt-3">
        {failed || onMinimize ? (
          <Button type="button" variant="ghost" onClick={failed ? onBackToDevices : onMinimize}>
            {failed ? null : <MinusIcon className="size-4" />}
            {failed && backToDevicesLabel
              ? backToDevicesLabel
              : intl.formatMessage({
                  id: failed ? "remote.selection.back" : "remote.continueInBackground",
                })}
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="secondary"
          disabled={upgradeLoading}
          onClick={failed ? onClose : cancelled ? onRetry : onCancelConnection}
        >
          {intl.formatMessage({
            id: failed ? "common.close" : cancelled ? "common.retry" : "remote.cancelConnection",
          })}
        </Button>
      </div>
    </div>
  );
}

// 原型安装确认表格「目标账号」列直接展示 user@host:port，不再包整句文案。
// [失败路径] ssh 端口缺省用 22：确认面板必须展示真实连接目标，
// 留空会让用户无法判断即将安装到哪台机器。
function formatInstallTarget(target: RemoteTarget): string {
  if (target.kind === "ssh") {
    return `${target.username}@${target.host}:${target.port ?? 22}`;
  }
  if (target.kind === "wsl")
    return ["WSL", target.distro ?? "default", target.user].filter(Boolean).join(" · ");
  if (target.kind === "docker") return `Docker · ${target.container}`;
  return target.url;
}

// [资源] 只取最后 30 条：反馈正文会进入工单系统，
// 完整日志应由用户主动附加，避免无界增长。
function buildRemoteConnectionFeedbackDescription(
  errorMessage: string,
  logs: RemoteConnectionLogEntry[],
  formatMessage: (id: string, values?: Record<string, string>) => string,
) {
  // [失败路径] 日志行做 level 大写归一：与界面日志区保持一致，
  // 便于客服按 [ERROR] 直接检索。
  const logText = logs
    .slice(-30)
    .map((entry) => `${entry.timestamp} [${entry.level.toUpperCase()}] ${entry.message}`)
    .join("\n");
  // [事务] 脱敏包裹整个拼接结果而不是逐行：
  // 跨行出现的凭据（例如多行私钥）只有整体扫描才能识别。
  return redactFeedbackText(
    [
      formatMessage("feedback.submit.template.section.remoteHeading"),
      "",
      formatMessage("feedback.submit.template.section.errorSummary"),
      errorMessage || formatMessage("feedback.submit.template.section.notProvided"),
      "",
      formatMessage("feedback.submit.template.section.remoteLog"),
      logText || formatMessage("feedback.submit.template.section.remoteLogEmpty"),
      "",
      formatMessage("feedback.submit.template.section.remoteEnvironment"),
      formatMessage("feedback.submit.template.section.supplement"),
    ].join("\n"),
  );
}
