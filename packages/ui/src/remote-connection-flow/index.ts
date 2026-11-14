// =============================================================================
// useRemoteConnectionFlow —— 远端连接弹窗的状态机与副作用编排（单文件、约 2k 行）。
//
// 这个 hook 是"设备 → 目录 → 连接 → 完成"四步向导的全部大脑：
//   device（选择设备/新建）→ settings（填表单/确认边界）→ connecting（真实连接）
//   → directory（选远端目录）→ 完成并关闭；中间任一步可最小化为后台任务。
//
// 三层问题必须分开看，混在一起就会写出难以复现的竞态：
//   1) 意图（intent）：用户想连哪里、连上后去哪个目录。存在 pendingCompletionIntentRef；
//   2) 请求（request）：一次具体的连接尝试。身份是 requestId + operationEpoch；
//   3) 会话（session）：连接成功后的 attachment/sessionId，可能被"已存在会话"复用。
// 任何一个异步回调回来，都要同时判断"我还是不是当前意图/当前请求"。
//
// 为什么用 ref 而不是 state 承载这些身份：await 之后闭包里的 state 是旧值，
// 只有 ref 能读到"此刻"的归属；用 state 会出现"旧请求覆盖新请求 UI"的经典 bug。
//
// 不变量表（编号本文件内唯一）：
// INV-01：entryEpochRef 是"当前入口"的唯一代号，任何跨 await 的写回前都必须比对它
//         （守住：isCurrent() / entryEpochRef.current === operationEpoch 的全部检查点）。
// INV-02：activeRequestIdRef 是"当前连接请求"的唯一身份；非当前请求的迟到结果只能
//         释放临时 session，绝不允许修改 UI（守住：discardStaleResult / 所有 requestId 比较）。
// INV-03：closeDialog 必须自增 entryEpoch，使所有在途回调立即失效；少加一次就会出现
//         "关窗后仍弹错误"（守住：closeDialog 首段、handleCancelConnection 首段）。
// INV-04：ownsConnectedSessionRef 决定关闭时是否回收 session：只回收本次新建的 attachment，
//         复用的/设备管理的临时 attachment 按各自规则处理（守住：closeDialog 的 session 段）。
// INV-05：sessionsAtStart 是连接开始那一刻的 session 快照，用于判断"本次是否新建"；
//         用实时 store 判断会把并发创建的会话误判成"已有"，从而泄漏 attachment。
// INV-06：device-management 完成后立即释放本次独占的 attachment，但不销毁 Source 的
//         物理连接（它由 Source owner 持有）。
// INV-07：最小化（minimizedRef）不终止流程：完成动作转入 pendingBackgroundCompletion，
//         由后台通知的"继续"按钮（resumeBackground）恢复；期间不得 applyOpenState(true)。
// INV-08：完成动作必须经过边界确认 acknowledgeBoundary，且确认前后都要重验
//         isCurrent() && !minimizedRef.current —— 确认对话框本身是异步的。
// INV-09：后台完成消费后即使 open/loading 未变，也必须释放 Root 的入口门禁
//         （onFlowActiveChange(flowActive || backgroundActive)）。
// INV-10：错误只有三件套：error（展示文案）、errorCode（分类）、rawError（原始信息）；
//         step 一律由 getRemoteConnectionCompletionDialogState 推导，不手工拼。
// INV-11：只有 source-server-install-required 允许在连接内部被"内联确认"，
//         其余错误一律上抛到统一 catch，避免在弹窗里套弹窗。
// INV-12：自动升级最多尝试一次（automaticServerUpdateAttempted），否则
//         "升级 → 重连 → 仍需升级" 会形成无限循环。
// INV-13：升级前必须核对失败 profile 与目标一致（isSameSourceServerUpdateTarget），
//         否则会把另一台设备的升级结果应用到当前目标。
// INV-14：取消必须先撤销 epoch、再做副作用；顺序反了会让旧 finally 清掉新流程的 busy。
// INV-15：关闭时清空 pendingCompletionIntentRef，下一次连接不得继承上一次的目录意图。
// INV-16：表单校验失败只递增 validationAttempt（RDUX-27），不写 error 横幅。
// INV-17：handleConnect 入口必须二次防重（loading），因为 React 的 disabled 生效有延迟。
// INV-18：事件顺序固定：updatePendingRemoteTarget（含 onFlowTargetChange）先于 onConnect，
//         保证通知层在连接开始前就知道目标；关闭时 onFlowTargetChange(null)。
// INV-19：setConnectedSessionId 必须早于 onConnectionReady / onSelectProject，
//         因为目录浏览器和投影都从 sessionsById 读 services。
// INV-20：目录提交被取消（remote-connection-canceled）时只回收"本次新建"的 attachment，
//         并清空意图、标记 cancelled，不得复用错误横幅。
// INV-21：force 更新的确认 Promise 必须挂在 forceDecisionRef 上，组件卸载时以 false 结算，
//         避免 owner 永久等待。
// INV-22：目录提交成功后要清空整条连接态（目录、日志、requestId、target、识别名），
//         否则下次打开会闪回上一次的"已连接"视图。
// INV-23：识别设备名（recognizedDeviceName）纯展示，快照读取失败不得中断连接流程。
// INV-24：upgradeLoading 的清理必须受 isCurrent 保护：旧更新的 finally 无权清理新流程。
// =============================================================================
import { toast } from "@/components/ui/toast.js";
import { RemoteConnectionSelection } from "@/remote-connection/RemoteConnectionSelection.js";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { profileMatchesRemoteTarget } from "@/lib/remoteConnectionWizard.js";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import {
  createUuid,
  getSourceServerUpdateTarget,
  isSameSourceServerUpdateTarget,
  DEFAULT_REMOTE_ASSET_INSTALL_MODE,
  resolveWorkspaceKey,
  ZCODE_VERSION,
  type ConnectionProfile,
  type SourceServerRunningTask,
  type RemoteTarget,
} from "@zcode/shared";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useSourceServerManagementSnapshot } from "@/hooks/useSourceServerManagementSnapshot.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  buildRemoteTarget,
  buildRemoteTargetFromProfile,
  findPreferredSourceConnectionProfile,
  findSourceServerUpgradeProfileId,
  getRemoteWizardStepCopy,
  collectRemoteFormFieldErrors,
  formatRemoteDraftPreview,
  withDefaultRemoteResourcePackages,
} from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
} from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import {
  classifyRemoteConnectionError,
  formatRemoteConnectionError,
} from "@/lib/remoteConnectionPresentation.js";
import { runSourceServerUpdate } from "@/lib/sourceServerUpdateAction.js";
import { startUserAction, type UserActionHandle } from "@/lib/userActionTelemetry.js";
import {
  useRemoteBoundaryAcknowledgement,
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionSettingsStep,
  formatDeviceCardMeta,
} from "@/RemoteConnectionDialogContent.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import {
  RemoteConnectionWizardHeader,
  type RemoteWizardStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { loadConnectionProfileCredentials } from "@/root/reconnectRemoteWorkspaceHistoryEntry.js";

import {
  normalizeRemoteConnectionOptions,
  type RemoteConnectionFlowOptions,
} from "@/remote-connection-flow/contract.js";
export type { RemoteConnectionFlowOptions } from "@/remote-connection-flow/contract.js";

// 完成意图：连接成功后"要做什么"，与"怎么连"（表单/目标）分开保存。
// 之所以用 ref 存整个对象而不是几个 useState：连接过程中会经历多次 await，
// 每次都要读"用户最初想要的那个目录"，用 state 会读到中间被清空的值。
// directToDirectory 决定完成页是直接进目录还是先给成功页；localWorkspacePath 只用于
// 目录提交时记录"本地侧对应目录"，远端链路本身不消费它。
// announceReusedConnection 只在发现可复用会话时为 true，让 onConnect 侧知道
// "这次不会新建 attachment"，从而跳过部分初始化。
interface RemoteConnectionCompletionIntent {
  preferredDirectoryPath?: string;
  options?: {
    directToDirectory?: boolean;
    localWorkspacePath?: string;
    announceReusedConnection?: boolean;
  };
}

// 连接流程 hook。返回的对象被弹窗组件直接展开使用，因此这里既是"状态容器"也是
// "视图模型"；但它不渲染任何东西，所有 UI 决策都以 step / error / cancelled 表达。
// 入参先经过 normalizeRemoteConnectionOptions 归一：两个调用方（Root 设备卡 / 设置页）
// 传的字段集合不同，归一后本函数内部只面对一套可选字段，避免到处写 undefined 兜底。
export function useRemoteConnectionFlow(options: RemoteConnectionFlowOptions) {
  const {
    openIntentId,
    completion,
    onDeviceConnected,
    onCancelled,
    onConnect,
    onConnectionReady,
    onSelectProject,
    onCancelSession,
    localWorkspacePath,
    controlledOpen,
    onOpenChange,
    isWindowsDesktop,
    remoteWorkspaceSessions,
    onFlowActiveChange,
    onFlowRequestIdChange,
    onFlowTargetChange,
    preferredKind,
    preferredWslDistro,
    preferredSourceServerId,
    preferredProfileId,
    preferredDirectoryPath,
    preferredTarget,
    onProjectIntentCleared,
    initialFailure,
  } = normalizeRemoteConnectionOptions(options);
  // addingDevice 是"纯新增设备"语义：意图是设备管理，且没有任何指定的来源/线路/目标。
  // 三者都为空的判断不能简化成 completion 单条件——从设备卡"管理此设备"进入时
  // completion 同样是 device-management，但带着身份，必须直接进连接而不是新建表单。
  const addingDevice =
    completion === "device-management" &&
    !preferredSourceServerId &&
    !preferredProfileId &&
    !preferredTarget;
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  // 边界确认（首次连接远端时的"你知道数据会离开本机吗"）是异步的：
  // 它可能打开一个对话框并等待用户点击，所以每个调用点前后都必须重验 epoch（INV-08）。
  const acknowledgeBoundary = useRemoteBoundaryAcknowledgement();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  // 受控/非受控双模式：外部传了 controlledOpen 就完全听外部的（设置页需要自己控制），
  // 否则本 hook 自持一个 open。applyOpenState 是唯一写入口，避免两条路径互相打架。
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // minimizedRef 而不是 state：它在 await 回调里被读取，state 会读到旧值。
  // 语义是"用户把弹窗收起了，但流程还在跑"，与"取消"完全不同（INV-07）。
  const minimizedRef = useRef(false);
  const confirmationPending = useConfirmDialogStore((state) => Boolean(state.pendingRequest));
  const [discardPending, setDiscardPending] = useState(false);
  // completionRunning 是"完成动作正在执行"的可见状态，参与 flowActive，
  // 保证 Root 不会在收尾期间把入口门禁放开。
  const [completionRunning, setCompletionRunning] = useState(false);
  // blockedCompletion 保存"被确认对话框挡住、稍后要重放"的完成动作。
  // 用 state 存函数（而不是 ref）是刻意的：它需要在确认框关闭时触发一次重渲染来重放，
  // 用 ref 就只能在其它 state 变化时"顺带"执行，时序不可控。
  const [blockedCompletion, setBlockedCompletion] = useState<(() => Promise<void>) | null>(null);
  // 重放闸门：确认请求结束（confirmationPending=false）且没有正在丢弃时才继续。
  // 这里的两个前置条件是防"确认关闭"与"完成回调"抢跑的关键（见下方注释）。
  useEffect(() => {
    if (confirmationPending || discardPending || !blockedCompletion) return;
    // 在关闭确认的 owner 处理完选择后重入，避免确认关闭与完成回调抢跑。
    setBlockedCompletion(null);
    const epoch = entryEpochRef.current;
    setCompletionRunning(true);
    void blockedCompletion()
      .catch((cause) => {
        if (entryEpochRef.current !== epoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        applyOpenState(true);
      })
      .finally(() => {
        if (entryEpochRef.current === epoch) setCompletionRunning(false);
      });
  }, [confirmationPending, discardPending, blockedCompletion]);
  // 后台完成的"续体"：最小化时把 finishConnection 的剩余部分挂在这里，
  // 由通知的"继续"按钮调用。它只在 minimizedRef 为真期间有意义，关闭时必须清空。
  const pendingBackgroundCompletion = useRef<(() => Promise<void>) | null>(null);
  // 后台是否已就绪（供 UI 显示"连接已在后台完成"）。与 pendingBackgroundCompletion 成对：
  // 前者是可见状态，后者是可执行动作；两者分开才能做到"隐藏动作但不丢状态"。
  const [backgroundReady, setBackgroundReady] = useState(false);
  // SSH alias 的凭据加载是异步的（可能弹密码框），期间连接按钮应显示 loading 而不是报错。
  const [aliasCredentialsPending, setAliasCredentialsPending] = useState(false);
  // 下面三个 ref 是竞态防护的核心（INV-01/02/03）：
  //   activeRequestIdRef：本次连接请求的 id，用来丢弃迟到的 onConnect 结果；
  //   entryEpochRef：入口代号，用户每次"关闭/取消/重新开始"都会自增；
  //   refreshingIntentRef：openIntentId 的"正在刷新"标记，防止同一意图被重复消费。
  // 三者都不能用 state，否则 await 之后读到的是渲染时刻的旧值。
  const activeRequestIdRef = useRef<string | null>(null);
  const entryEpochRef = useRef(0);
  const refreshingIntentRef = useRef<number | null>(null);
  const [refreshingIntent, setRefreshingIntent] = useState(false);
  // 已消费的 openIntentId：外部用"递增 id"表达"请重新打开并处理一次"，
  // 同一个 id 只允许触发一次，否则每次重渲染都会重新初始化表单。
  const consumedOpenIntentIdRef = useRef<number | undefined>(undefined);
  // 旁路遥测句柄：与 requestId 绑定，避免旧请求的 finish 结算到新请求的 trace 上。
  const activeTraceRef = useRef<{ requestId: string; trace: UserActionHandle } | null>(null);
  const cancelActiveTrace = useCallback(() => {
    const active = activeTraceRef.current;
    activeTraceRef.current = null;
    active?.trace.cancel();
  }, []);
  useEffect(() => cancelActiveTrace, [cancelActiveTrace]);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState<string>();
  const [rawError, setRawError] = useState<string>();
  // 0 表示尚未提交；每次提交校验失败递增，表单据此显示内联错误并聚焦第一个出错字段（RDUX-27）。
  const [validationAttempt, setValidationAttempt] = useState(0);
  const [focusCredentials, setFocusCredentials] = useState(false);
  const [directoryPath, setDirectoryPath] = useState("");
  const consumedKindPreferenceRef = useRef<string | null>(null);
  const [step, setCurrentStep] = useState<RemoteWizardStep>("device");
  // Root 常驻挂载，设置入口的首帧也直接展示分类表单，不等待 effect 隐藏旧选择屏。
  const currentStep = addingDevice && step === "device" ? "settings" : step;
  // ownsConnectedSessionRef 表示"当前 session 是否由本次流程独占"（INV-04）。
  // 只有它为真才在关闭时回收：复用已有会话、或设备管理借用 Source 的会话时，
  // 回收会直接把用户正在用的东西关掉。
  const ownsConnectedSessionRef = useRef(false);
  // id 同时存 state 与 ref：state 驱动渲染（目录浏览器订阅），ref 供 await 回调读取。
  // 两个值只能通过 setConnectedSessionId 一起写，任何一处单独 setState 都会让二者漂移，
  // 于是"关闭时该回收谁"会用错值——这是这个文件最容易写错的地方。
  const [connectedSessionId, setConnectedSessionIdState] = useState<string | null>(null);
  const connectedSessionIdRef = useRef<string | null>(null);
  const setConnectedSessionId = useCallback((sessionId: string | null) => {
    connectedSessionIdRef.current = sessionId;
    setConnectedSessionIdState(sessionId);
  }, []);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  const [pendingInstallConfirmation, setPendingInstallConfirmation] = useState<RemoteTarget | null>(
    null,
  );
  // upgradeProfileId 非空表示"当前在等一次 Source 升级"，UI 据此显示升级进度与日志；
  // upgradeLoading 单独存在，是因为升级可能被外部取消，此时 profileId 仍需保留给重试按钮。
  const [upgradeProfileId, setUpgradeProfileId] = useState<string | null>(null);
  const [upgradeLoading, setUpgradeLoading] = useState(false);
  // 强制更新确认：pendingForceUpdate 携带"当前有哪些运行中任务"用于提示，
  // 真正的决策通过 forceDecisionRef 的 Promise 回传（runSourceServerUpdate 在等它）。
  const [pendingForceUpdate, setPendingForceUpdate] = useState<{
    tasks?: SourceServerRunningTask[];
  } | null>(null);
  const forceDecisionRef = useRef<((confirmed: boolean) => void) | null>(null);
  // 结算只能走这一处：先取出 resolve 再置空，保证同一次确认只 resolve 一次。
  // 顺序反了（先置空再取）会拿到 undefined，owner 永远等下去。
  const settleForceUpdate = (confirmed: boolean) => {
    const resolve = forceDecisionRef.current;
    forceDecisionRef.current = null;
    setPendingForceUpdate(null);
    resolve?.(confirmed);
  };
  // 卸载时以 false 结算（INV-21）：确认框还开着、组件却已销毁时，
  // owner 侧的 await 必须得到一个明确结果，否则整个升级链路悬挂。
  useEffect(
    () => () => {
      forceDecisionRef.current?.(false);
      forceDecisionRef.current = null;
    },
    [],
  );
  // 识别结果（设备名 / Source id）来自连接后的 session，纯展示用途（INV-23）。
  // 单独存 sourceServerId 而不是从 session 实时读：会话可能在完成前被回收，
  // 而设备名需要在这之后仍然显示在成功页上。
  const [recognizedDeviceName, setRecognizedDeviceName] = useState<string | undefined>();
  const [recognizedSourceServerId, setRecognizedSourceServerId] = useState<string | undefined>();
  const [
    remoteConversationWorkspaceBySourceServerId,
    setRemoteConversationWorkspaceBySourceServerId,
  ] = useState<Record<string, { workspacePath: string; lastResolvedAt: number }>>({});
  /** 当前连接使用的线路名（SSH alias / 线路 displayName）；无名线路由消费方回退 user@host:port。 */
  const [activeProfileName, setActiveProfileName] = useState<string | undefined>();
  // 四个 consumed*Ref 记录"外部偏好/意图已被消费"的标记。
  // 为什么需要它们：props 里的 preferred* 在整个弹窗生命周期内都可能存在，
  // 而"用一次就够"（例如 preferredTarget 只在首次打开时决定连哪台），
  // 记录消费后可避免每次重渲染都重新套用旧偏好、覆盖用户当下的修改。
  const consumedPreferredSourceServerIdRef = useRef<string | null>(null);
  const consumedPreferredProfileIdRef = useRef<string | null>(null);
  const consumedPreferredTargetRef = useRef<RemoteTarget | null>(null);
  // 本次连接的完成意图（目录 / 选项），由 startRemoteConnection 写入，
  // 由 finishConnection 读取。生命周期严格限定在"一次连接"内（INV-15）。
  const pendingCompletionIntentRef = useRef<RemoteConnectionCompletionIntent>({});
  // 目录选择是"进行中"状态，要和 ref 成对维护：ref 用于事件回调里防重入，
  // state 用于渲染按钮的 loading 态。
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs } = useRemoteConnectionLogs(connectingRequestId);
  const open = controlledOpen ?? uncontrolledOpen;
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setServerUrl,
    setServerName,
    setServerToken,
    setServerWorkspacePath,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
    resetDraft,
    discoveryLoading,
    discoveryError,
  } = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
    // preserveDraftOnOpen：关闭弹窗不销毁草稿。用户经常"看一眼"目标再回来继续填，
    // 每次打开都重置会让人反复输入主机名/密钥路径。
    preserveDraftOnOpen: true,
    // discoverAll 只在"新增设备"时关闭：设备管理已有明确身份，无需扫描全部
    // Docker/WSL 资源（那会触发一串探测命令，明显拖慢打开速度）。
    discoverAll: !addingDevice,
  });
  // 目录浏览器所需的 services 从 session store 里按 id 取，而不是由本 hook 持有：
  // services 的归属方是 workspace session，本 hook 只是"借用"来浏览目录。
  // 这也是 INV-19 的原因——必须先把 sessionId 写进 store/state，这里才能取到值。
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const sourceManagement = baseServices.sourceServerManagementService;
  // 合同层：管理快照统一走 useSourceServerManagementSnapshot（双事件订阅 + in-flight/queued 队列 + generation 判序），
  // 不再各自手写订阅（§8.1.4 全部消费方收敛为统一 hook）。
  // enabled 用 open || minimizedRef.current：最小化后弹窗虽关闭，但后台完成仍需要
  // "Source 是否在线"的判断（deferCompletion 会核对 online 状态），此时不能停订阅。
  // 直接写 open 会让后台流程读到过期快照，误判设备离线并回收 session。
  const { snapshot: sourceManagementSnapshot, applySnapshot: applySourceManagementSnapshot } =
    useSourceServerManagementSnapshot(sourceManagement, { enabled: open || minimizedRef.current });
  const { logsByProfileId: sourceOperationLogs } = useSourceServerOperationLogs(
    sourceManagement,
    upgradeProfileId ? [upgradeProfileId] : [],
  );
  // 只在"彻底空闲"（关闭 + 停在设备页 + 无目标/无会话/未连接）时重置消费标记。
  // 若在关闭瞬间无条件重置，最小化后的后台流程会在下一次渲染里被当成"还没消费偏好"，
  // 从而用旧的 preferredTarget 覆盖后台正在进行的连接。
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    ) {
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
    }
  }, [open, currentStep, pendingRemoteTarget, connectedSessionId, loading]);
  // 打开时读取"每个 Source 上次使用的会话目录"，用于 quickOpen 的目录建议。
  // 这是一次纯读取，失败静默（.catch(() => undefined)）：拿不到建议就退化成手动选目录，
  // 不该因为一个设置读取失败挡住整个连接流程。
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void baseServices.settingService
      .get()
      .then((settings) => {
        if (!disposed) {
          setRemoteConversationWorkspaceBySourceServerId(
            settings.remoteConversationWorkspaceBySourceServerId ?? {},
          );
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [baseServices.settingService, open]);
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  // flowActive 是"这个流程是否仍然占据着入口"的聚合判断，Root 用它来阻止用户
  // 在连接过程中开启第二个流程。四个来源缺一不可：
  //   基础快照（步骤/loading/session）由 isRemoteConnectionFlowActive 判定；
  //   upgradeLoading：升级期间弹窗可能已回到 selection，但后台仍有写操作；
  //   blockedCompletion：完成动作被确认框挡住，此时仍属于同一流程；
  //   completionRunning：完成动作正在执行（含 onSynced 类副作用）。
  // 少算任何一项，用户都能在收尾期间再开一个连接，导致两个流程争抢同一 Source。
  const flowActive =
    isRemoteConnectionFlowActive(flowSnapshot) ||
    upgradeLoading ||
    Boolean(blockedCompletion) ||
    completionRunning;
  const recognizedServer = useMemo(
    () =>
      recognizedSourceServerId
        ? (sourceManagementSnapshot?.servers.find(
            (server) => server.sourceServerId === recognizedSourceServerId,
          ) ?? null)
        : null,
    [recognizedSourceServerId, sourceManagementSnapshot],
  );
  // 日志按 phase 三选一：connectingRequestId 存在时取实时日志，另两路为升级日志：
  //   1) connectingRequestId 存在 → 本次连接的实时日志（最高优先级）；
  //   2) rawError 与 initialFailure.message 相同 → 外部传入的历史失败日志；
  //   3) 都没有 → 空。
  // 用"内容相同"判断而不是 id 判断，是因为 initialFailure 是上游重放的一次失败快照，
  // 没有 requestId 可对；把它限定在 rawError 一致时展示，可避免旧失败日志串到新连接上。
  // 升级日志始终追加在尾部：升级与连接是串行阶段，合并展示能保留完整因果链。
  const visibleConnectionLogs = useMemo(() => {
    const updateLogs = upgradeProfileId ? (sourceOperationLogs[upgradeProfileId] ?? []) : [];
    return [
      ...(connectingRequestId
        ? connectionLogs
        : rawError === initialFailure?.message
          ? (initialFailure?.logs ?? [])
          : []),
      ...updateLogs.map((entry, index) => ({
        id: `source-update-${entry.timestamp}-${entry.phase}-${index}`,
        level: entry.level,
        message: `[source-server:${entry.phase}] ${entry.message}${
          entry.progress === undefined || entry.message.startsWith("upload progress:")
            ? ""
            : ` ${(entry.progress * 100).toFixed(1)}%`
        }`,
        timestamp: new Date(entry.timestamp).toLocaleTimeString(locale, {
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      })),
    ];
  }, [
    connectionLogs,
    connectingRequestId,
    initialFailure,
    rawError,
    locale,
    sourceOperationLogs,
    upgradeProfileId,
  ]);
  // 快速打开目录的两组候选，语义不同，不能混排：
  //   paths：本机记录过的历史目录（按打开时间倒序，取前 3），用相对时间做标签；
  //   entries：Source 声明的目录（declaredWorkspaces），用"远端记录"做标签。
  // localKeys 用 resolveWorkspaceKey 归一后去重，保证同一个目录不会既出现在"历史"
  // 又出现在"远端声明"里——两者点下去的后果不同（前者带本地工作区映射，后者没有），
  // 重复展示会让用户选到"看起来一样但行为不同"的项。
  // 当前正在使用的目录需要从历史里剔除（remoteConversationWorkspaceBySourceServerId），
  // 因为"恢复到已在使用的目录"没有意义。
  const quickOpenDirectoryData = useMemo(() => {
    if (!recognizedSourceServerId || !sourceManagementSnapshot) {
      return {
        paths: [] as Array<{ path: string; label?: string }>,
        entries: [] as Array<{ path: string; label?: string }>,
      };
    }
    const localEntries = sourceManagementSnapshot.workspaceHistory
      .filter(
        (entry) =>
          entry.sourceServerId === recognizedSourceServerId &&
          remoteConversationWorkspaceBySourceServerId[recognizedSourceServerId]?.workspacePath !==
            entry.workspacePath,
      )
      .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
    const localKeys = new Set(localEntries.map((entry) => resolveWorkspaceKey(entry)));
    const server = sourceManagementSnapshot.servers.find(
      (candidate) => candidate.sourceServerId === recognizedSourceServerId,
    );
    return {
      paths: localEntries.slice(0, 3).map((entry) => ({
        path: entry.workspacePath,
        // 原型 q-time：本地记录显示相对时间（昨天 / 8月20日），远端记录显示「远端记录」。
        label: formatTaskRelativeTime(entry.lastOpenedAt, intl),
      })),
      entries: (server?.declaredWorkspaces ?? [])
        .filter((entry) => !localKeys.has(resolveWorkspaceKey(entry)))
        .map((entry) => ({
          path: entry.workspacePath,
          label: intl.formatMessage({ id: "remote.remoteRecord" }),
        })),
    };
  }, [
    intl,
    recognizedSourceServerId,
    remoteConversationWorkspaceBySourceServerId,
    sourceManagementSnapshot,
  ]);

  // 后台状态参与门禁但不在依赖里：minimizedRef 变化本身不触发渲染，
  // 这里每次渲染时读取"当前值"，配合 flowActive 的变化把最新结果推给 Root（INV-09）。
  // 若把 backgroundActive 做成 state，最小化瞬间会触发一次额外渲染，
  // 而该渲染发生在 setBackgroundReady 之前，会把门禁错误地放开一小段。
  const backgroundActive = minimizedRef.current;
  useEffect(() => {
    // 后台完成消费后即使 loading/open 都未改变，也必须释放 Root 的入口门禁。
    onFlowActiveChange?.(flowActive || backgroundActive);
  }, [flowActive, backgroundActive, onFlowActiveChange]);

  // requestId 的三处写入必须原子完成：ref（竞态判断）、state（日志订阅）、
  // 回调（Root 侧的入口门禁）。少写一处就会出现"日志不刷新"或"Root 认为还在连"。
  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      activeRequestIdRef.current = requestId;
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  // 目标变更同样三处联动：本地 state、表单回填（WSL 的 distro/user）、
  // 以及通知层（onFlowTargetChange）。WSL 回填是必须的，因为"已保存线路"只带 target，
  // 表单若不同步，用户返回配置页会看到空 distro 并重新输入。
  const updatePendingRemoteTarget = useCallback(
    (target: RemoteTarget | null) => {
      setPendingRemoteTarget(target);
      // 已保存 WSL 线路曾只更新连接目标，返回配置却使用空值或上一线路的表单。
      // 在接受目标的同一入口回填两项，省略参数也必须清空旧输入。
      if (target?.kind === "wsl") {
        setWslDistro(target.distro ?? "");
        setWslUser(target.user ?? "");
      }
      // 在 onConnect 前同步告知通知层；最小化不清空目标，退出或改选沿用同一清理入口。
      onFlowTargetChange?.(target);
    },
    [onFlowTargetChange, setWslDistro, setWslUser],
  );
  // 卸载时清空目标（INV-18 的收尾）：通知层据此撤掉"正在连接 xxx"的状态，
  // 否则文件被卸载后仍会残留一个指向旧目标的进行中提示。
  useEffect(() => () => onFlowTargetChange?.(null), [onFlowTargetChange]);

  // open 的唯一写入口：受控模式下只通知外部（外部才是真相），
  // 非受控模式下同时写本地 state。两种模式都调用 onOpenChange 回调，保持可观测。
  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  // 重置"用户可见的反馈"，不碰流程身份（requestId/session/epoch）。
  // 这个区分很重要：开始新连接与关闭弹窗都会调它，但只有后者会再调 closeDialog
  // 去撤销身份；如果 resetFeedback 顺手清了 requestId，进行中的迟到的回调会被误判为"当前"。
  const resetFeedback = () => {
    setCancelled(false);
    setError("");
    setErrorCode(undefined);
    setRawError(undefined);
    setValidationAttempt(0);
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  // 回收 session 时吞掉错误只记 warn：回收是"清理动作"，失败意味着泄漏一个 attachment，
  // 但把它抛给用户没有任何可操作性（用户无法手动释放），只会在关闭流程里再弹一个错误。
  // 因此日志是这里的唯一观测手段。
  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  // 关闭弹窗 = "作废整个入口"。函数体分四段，顺序不能乱：
  //   A. 撤销身份（epoch++）与在途动作（force 确认、遥测、完成回调）；
  //   B. 重置 form 与 intent；
  //   C. 按所有权回收 session / 取消进行中的连接；
  //   D. 清空全部可见状态并关闭。
  // A 必须在 C 之前：回收动作会 await，期间旧 run 的 finally 可能回来；
  // 先自增 epoch 才能让那些回调看到"我已不是当前流程"而放弃写回（INV-03）。
  // keepOpen 供"内部重置但仍保持弹窗打开"（如切换意图）使用；
  // preserveSession 供设备管理使用——它不拥有 session，回收会误伤 Source 的物理连接。
  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean; keepOpen?: boolean }) => {
      settleForceUpdate(false);
      cancelActiveTrace();
      entryEpochRef.current += 1;
      setBlockedCompletion(null);
      setCompletionRunning(false);
      minimizedRef.current = false;
      pendingBackgroundCompletion.current = null;
      setBackgroundReady(false);
      refreshingIntentRef.current = null;
      setRefreshingIntent(false);
      // resetDraft 会清空表单，但保留"打开时的偏好"（preserveDraftOnOpen 的语义只在
      // 打开时生效）；这里必须清，否则下一次打开会带着上次失败的主机名。
      resetDraft();
      setDirectoryPath("");
      consumedKindPreferenceRef.current = null;
      consumedPreferredSourceServerIdRef.current = null;
      consumedPreferredProfileIdRef.current = null;
      consumedPreferredTargetRef.current = null;
      setAliasCredentialsPending(false);
      setFocusCredentials(false);
      // 关闭确认可能早于连接完成，异步确认后必须释放当前 attachment，不能读旧闭包。
      // 读 ref 而不是 state 闭包：关闭可能发生在异步确认之后，此时闭包里的
      // connectedSessionId 还是打开确认框那一刻的旧值（INV-04 的落地细节）。
      const sessionId = connectedSessionIdRef.current;
      if (!options?.preserveSession && sessionId && ownsConnectedSessionRef.current) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // Bugfix: 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
        // 两个分支互斥：前者处理"已连上但未提交"，后者处理"还在连、没有 sessionId"。
        // 若合并成一个条件，已连上的场景会走 cancelPendingRemoteConnection（按 requestId 取消，
        // 但请求已经完成），结果 session 永远不会被回收。
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      // 新增设备回到 settings（让用户直接重新填），其余回到 device（选设备）。
      // 这个判断依赖 addingDevice 而非 completion，与 currentStep 的派生规则保持一致。
      setCurrentStep(addingDevice ? "settings" : "device");
      // 顺序：先把 ref 清空再写 state（setConnectedSessionId 会同时写两者）。
      // 这里直接调 setConnectedSessionId(null) 即可，它会处理 ref。
      setConnectedSessionId(null);
      ownsConnectedSessionRef.current = false;
      updatePendingRemoteTarget(null);
      setPendingInstallConfirmation(null);
      setUpgradeProfileId(null);
      setUpgradeLoading(false);
      setRecognizedDeviceName(undefined);
      setRecognizedSourceServerId(undefined);
      setActiveProfileName(undefined);
      // 清空意图（INV-15）：否则下次连接会继承这次的"首选目录"，
      // 表现为"我明明没选目录，弹窗却直接跳到了上次那个目录"。
      pendingCompletionIntentRef.current = {};
      updateConnectingRequestId(null);
      if (!options?.keepOpen) applyOpenState(false);
    },
    [
      addingDevice,
      cancelActiveTrace,
      cancelPendingRemoteConnection,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
      updatePendingRemoteTarget,
    ],
  );

  // 关闭前的确认策略：三种状态三种文案，且"是否真的需要确认"取决于流程阶段，
  // 而不是弹窗是否打开。
  //   connecting + loading：正在连接，关闭意味着停止（会真的取消请求）；
  //   已连上（connectedSessionId 非空）：关闭意味着离开已连接的会话；
  //   其余（form 阶段）：直接放行，不打断用户。
  // 注意这里只"征询"不"执行"，执行统一交给 withConfirmedDiscard 的 epoch 复核。
  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  // confirm 与 execute 的两段式包装，中间隔着一次 epoch 复核。
  // 关键点是"确认期间流程可能已经变化"（比如后台刚好完成、或另一个入口已关闭），
  // 所以确认返回后必须比对 epoch，避免用旧确认去执行一次针对旧状态的关闭。
  // discardPending 参与 completion 重放闸门：丢弃动作未结束时不得重放完成函数。
  const withConfirmedDiscard = async (discard: () => void | Promise<void>) => {
    const epoch = entryEpochRef.current;
    setDiscardPending(true);
    try {
      const confirmed = await confirmRemoteFlowDiscard();
      if (confirmed && entryEpochRef.current === epoch) await discard();
    } finally {
      setDiscardPending(false);
    }
  };
  // 关闭请求：先记录"是否处于后台"，因为 closeDialog 会把 minimizedRef 置回 false；
  // 之后再读就永远是 false，父组件会误以为这是一次普通取消而不是"后台任务被放弃"。
  const handleCloseRequest = () =>
    withConfirmedDiscard(() => {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled?.(background);
    });

  const updateRequiredServer = useCallback(
    async (
      profileId: string,
      target: Exclude<RemoteTarget, { kind: "server" }>,
    ): Promise<boolean> => {
      // upgradeLoading 时直接拒绝：同一个 profile 的升级不允许并发，
      // 否则两条升级流会各自写 Source 目录，后完成的那条覆盖先完成的。
      if (!sourceManagement || upgradeLoading) return false;
      // epoch 在这里拍一次快照：整个升级过程（可能包含用户确认 + 下载）跨多次 await，
      // 所有写回都通过 isCurrent() 校验（INV-24）。
      const epoch = entryEpochRef.current;
      const isCurrent = () => entryEpochRef.current === epoch;
      setUpgradeLoading(true);
      try {
        const next = await runSourceServerUpdate({
          management: sourceManagement,
          profileId,
          expectedTarget: getSourceServerUpdateTarget(target),
          // 强制更新确认：只有"升级会打断运行中任务"时才会被调用。
          // 这里的 snapshot 仅用于展示任务清单；读取失败（catch → undefined）时
          // 仍然弹出确认框，只是不带任务明细。绝不能因为读不到清单就返回 true，
          // 那等于绕过 force=false 的保护，在用户不知情时杀掉任务。
          confirmForce: async () => {
            if (!isCurrent()) return false;
            // 清单只是确认的附加信息，读取失败不能绕过或替换 force=false 守卫。
            const snapshot = await sourceManagement.getSnapshot().catch(() => undefined);
            if (!isCurrent()) return false;
            if (snapshot) applySourceManagementSnapshot(snapshot);
            const tasks = snapshot?.states.find(
              (state) => state.profileId === profileId,
            )?.runningTasks;
            setPendingForceUpdate({ tasks });
            // Promise 交给上层 UI（forceDecisionRef），由 settleForceUpdate 结算；
            // 组件卸载时以 false 兜底（INV-21）。
            return await new Promise<boolean>((resolve) => {
              forceDecisionRef.current = resolve;
            });
          },
        });
        // 升级被取消（next 为空）或流程已作废时返回 false，且不写任何状态：
        // 调用方据此决定"不重连"，避免用一次未完成的升级去连接。
        if (!isCurrent() || !next) return false;
        applySourceManagementSnapshot(next);
        // 成功后清空错误三件套：上一次失败的红字必须消失，否则用户会以为升级失败了。
        setError("");
        setErrorCode(undefined);
        setRawError(undefined);
        return true;
      } catch (updateError) {
        if (!isCurrent()) return false;
        const failure = updateError as {
          code?: unknown;
          retryable?: unknown;
        };
        // remote-target-changed 是"目标已变"的特殊错误：继续升级会作用到错误的机器上，
        // 因此清空 profileId（撤掉升级 UI），只给一句"连接不可用"，让用户重新选择。
        // 这里刻意不展示原始错误文本——它对用户没有意义，还会误导成网络故障。
        if (failure.code === "remote-target-changed") {
          setUpgradeProfileId(null);
          setErrorCode(undefined);
          setRawError(undefined);
          setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
          return false;
        }
        // 其它错误保留错误码与原始信息：errorCode 供上层做分类重试，rawError 供诊断面板。
        setErrorCode(typeof failure.code === "string" ? failure.code : undefined);
        setRawError(getErrorMessage(updateError));
        setError(
          formatRemoteConnectionError({
            fallback: getErrorMessage(updateError),
            reasonCode: typeof failure.code === "string" ? failure.code : undefined,
            retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
            formatMessage: intl.formatMessage,
          }),
        );
        return false;
      } finally {
        if (isCurrent()) setUpgradeLoading(false);
      }
    },
    [applySourceManagementSnapshot, confirmDialog, intl, sourceManagement, upgradeLoading],
  );

  // 一次连接尝试的完整主体（也是本文件最长的函数）。参数即"意图"：
  //   target：归一后的目标；confirmSourceServerInstall：是否已获得安装许可；
  //   preferredDirectoryPath/options：完成后的去向；
  //   automaticServerUpdateAttempted：防止自动升级循环（INV-12）。
  // 执行顺序：占位（防重）→ 记录意图 → 起 requestId → onConnect → 识别 → 完成/延迟完成。
  // 任何一步失败都走同一个 catch，保证错误呈现方式统一（INV-10）。
  const startRemoteConnection = async (
    target: RemoteTarget,
    confirmSourceServerInstall = false,
    preferredDirectoryPath?: string,
    options?: RemoteConnectionCompletionIntent["options"],
    automaticServerUpdateAttempted = false,
  ) => {
    // 资源包默认值在这一层补齐：调用方（表单/快速入口/升级后重连）不必各自记得加，
    // 否则会出现"同一目标从不同入口连，安装的资源不一样"的差异。
    const nextTarget = withDefaultRemoteResourcePackages(target);

    // 同步占位而不是先 setLoading：这里在事件入口，必须立刻挡住第二次点击（INV-17 的姊妹点）。
    if (activeRequestIdRef.current) {
      // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    // 自增 epoch 是"作废之前所有在途回调"的动作（INV-01）：
    // 这里用 ++ 而不是读当前值，因为用户可能在上一次失败尚未收尾时就点了重试。
    const operationEpoch = ++entryEpochRef.current;
    setDirectoryPath("");
    // 意图必须在 onConnect 之前落盘：onConnect 内部可能很快回调 onConnectionReady，
    // 而 finishConnection 读的是这个 ref（INV-15 的正向使用）。
    pendingCompletionIntentRef.current = {
      preferredDirectoryPath,
      options,
    };

    // INV-18：先写目标（含通知层），再发起连接；顺序反了通知层会在连接已开始时
    // 仍显示上一个目标，用户看到"正在连接 A"实际连的是 B。
    updatePendingRemoteTarget(nextTarget);
    setLoading(true);
    // 快照当前所有 session id（INV-05）：连接完成后用它判断"这个 sessionId 是新的，
    // 还是复用了已有会话"。不能事后用 store 实时判断——并发创建的会话会被误判成"已有"，
    // 于是关闭时不会回收，attachment 泄漏。
    const sessionsAtStart = new Set(
      Object.keys(useRemoteWorkspaceSessionStore.getState().sessionsById),
    );
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setUpgradeProfileId(null);
    setCurrentStep("connecting");
    // 旁路遥测与 requestId 绑定：finishTrace 只有在"当前 handle 仍属于我这个请求"时
    // 才结算，避免旧请求把新请求的耗时/结果结掉（那会让成功率统计完全失真）。
    // 用 requestId 而不是 epoch：遥测需要区分"同一次入口下的多次重试"。
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: nextTarget.kind,
    });
    activeTraceRef.current = { requestId, trace };
    const finishTrace = (finish: (action: UserActionHandle) => void) => {
      if (activeTraceRef.current?.requestId !== requestId) return;
      activeTraceRef.current = null;
      finish(trace);
    };
    try {
      let sessionId: string;
      try {
        const context = confirmSourceServerInstall
          ? { confirmSourceServerInstall: true }
          : undefined;
        sessionId = options?.announceReusedConnection
          ? await onConnect(nextTarget, requestId, context, { announceReusedConnection: true })
          : await onConnect(nextTarget, requestId, context);
      } catch (error) {
        // 内层 catch 只处理"需要安装 Source Server"这一种可协商错误（INV-11）。
        // 其余错误原样抛出给外层，保证错误呈现逻辑只有一套。
        if (activeRequestIdRef.current !== requestId) return;
        const reasonCode =
          error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (reasonCode !== "source-server-install-required") throw error;
        if (!confirmSourceServerInstall) {
          // 安装确认内联在连接阶段，避免在远程弹窗里再套一个确认弹窗，且能让用户看到真实目标。
          // 快照刷新只是为了"安装确认页"能显示真实状态；失败不阻断（?. + catch）。
          // 每次 await 后重验 requestId：这段逻辑可能跨越几百毫秒，用户随时可能取消。
          const snapshot = await sourceManagement?.getSnapshot().catch(() => undefined);
          if (activeRequestIdRef.current !== requestId) return;
          if (snapshot) applySourceManagementSnapshot(snapshot);
          const failure = error as {
            resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
          };
          // WSL 的实际目标是连接时才解析出来的（distro/user 可能来自默认值），
          // 安装确认必须展示"真正要装的机器"，否则用户会在 A 机器上授权、实际装到 B。
          const installTarget =
            nextTarget.kind === "wsl" ? (failure.resolvedWslTarget ?? nextTarget) : nextTarget;
          updatePendingRemoteTarget(installTarget);
          setPendingInstallConfirmation(installTarget);
          // 这次请求以"用户待确认"结束，遥测按 cancel 结算（不是失败）。
          finishTrace((action) => action.cancel());
          return;
        }
        throw error;
      }
      // 取消/关闭先撤销请求归属；迟到结果只释放临时 session，不能复活旧流程。
      // INV-02：requestId 已不是当前值 ⇒ 本次结果是"迟到结果"。
      // 处理方式只有一个：如果是本次新建的 session，释放它；绝不改 UI。
      // 用 sessionsAtStart 判断"新建"（INV-05），否则会误杀复用的会话。
      const discardStaleResult = () => {
        if (activeRequestIdRef.current === requestId) return false;
        if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
        return true;
      };
      if (discardStaleResult()) return;
      const connectedSourceServerId =
        useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId]?.sourceServerId;
      // 识别时刻由连接结果驱动：directory-record 完成后 session 才携带 sourceServerId，
      // 此时展示「已识别为现有设备」并刷新快照，确保新识别设备的名称与目录历史立即可用。
      if (connectedSourceServerId) {
        setRecognizedSourceServerId(connectedSourceServerId);
        try {
          const nextSnapshot = await sourceManagement?.getSnapshot();
          if (discardStaleResult()) return;
          if (nextSnapshot) {
            // 经统一 hook 的 generation 判序入口写入，防止旧快照后至覆盖新内容。
            applySourceManagementSnapshot(nextSnapshot);
            setRecognizedDeviceName(
              nextSnapshot.servers.find(
                (server) => server.sourceServerId === connectedSourceServerId,
              )?.displayName,
            );
          }
        } catch {
          // 设备名仅用于展示；快照读取失败时保留连接结果，不打断流程。
          // 即 INV-23：识别是"锦上添花"，失败只影响展示名，不能把已成功的连接判成失败。
        }
      }
      if (discardStaleResult()) return;
      // 后台只保留本次意图的完成动作；不能在网络结果到达时恢复旧页面。
      // 设备管理只需 Source 身份，立即释放本次独占 attachment。
      // 两个条件都是"设备管理"的例外：它不拥有 session（不回收），
      // 且完成后立刻把临时 attachment 还给 Source（下面 await handleCancelSession）。
      ownsConnectedSessionRef.current =
        completion !== "device-management" && !sessionsAtStart.has(sessionId);
      if (completion === "device-management" && !sessionsAtStart.has(sessionId)) {
        await handleCancelSession(sessionId);
        // 回收是 await，回来后再判一次迟到：期间用户可能已经关窗。
        if (discardStaleResult()) return;
      }
      // INV-19：先把 sessionId 写进 store/state，后续 onConnectionReady / onSelectProject
      // 才能从 sessionsById 取到 services（目录浏览器依赖它）。
      setConnectedSessionId(completion === "device-management" ? null : sessionId);
      // 完成动作（可能被推迟到后台再执行）。它的每个分支都必须先问三个问题：
      //   1) 我还是当前 epoch 吗？（用户可能已取消/重新开始）
      //   2) 用户是不是把弹窗收起了？（收起就转交 deferCompletion）
      //   3) 边界确认过了吗？（首次连接需要用户确认数据外发）
      // 三者任一不满足都不应产生目录/项目副作用。
      const finishConnection = async () => {
        const isCurrent = () => entryEpochRef.current === operationEpoch;
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        // 读取/保存介绍也会跨过收起事件；前台权限必须与 epoch 一起在 await 后重验。
        const acknowledged =
          !connectedSourceServerId ||
          (await acknowledgeBoundary(
            () => isCurrent() && !minimizedRef.current,
            () => setBlockedCompletion(() => finishConnection),
          ));
        // 确认对话框关闭后重新校验两件事（INV-08）：epoch 与"是否已被收起"。
        // 只校验 epoch 不够——用户完全可能在确认框弹出期间点了最小化。
        if (!isCurrent()) return;
        if (minimizedRef.current) {
          deferCompletion();
          return;
        }
        if (!acknowledged) return;
        if (completion === "device-management") {
          // 设备管理没有目录/项目副作用；只回收本次独占的临时 attachment，物理连接仍由 Source owner 保持。
          // 聊天返回仍需校验成员资格；必须等完成方确认，失败沿用本 flow 的错误和重试边界。
          await onDeviceConnected?.(
            connectedSourceServerId,
            () => isCurrent() && !minimizedRef.current,
          );
          if (!isCurrent()) return;
          if (minimizedRef.current) {
            deferCompletion();
            return;
          }
          finishTrace((action) => action.complete({ resultSource: "platform_result" }));
          closeDialog({ preserveSession: true });
          return;
        }
        // 外部接管完成流程（Root 的快速连接）：本 hook 只负责连上并把 session 交出去，
        // 之后的目录/项目决策由调用方处理。交出去之后不再关闭弹窗——那会让接管方失去上下文。
        if (onConnectionReady) {
          await onConnectionReady(sessionId);
          if (entryEpochRef.current !== operationEpoch) return;
          finishTrace((action) => action.complete({ resultSource: "platform_result" }));
          return;
        }
        if (preferredDirectoryPath?.trim()) {
          // 目录提交开始后由项目 owner 接管 attachment；取消 UI 不能回收可能已提交成功的会话。
          // 失败仍由下面的 catch 回收或恢复目录选择，介绍等待阶段的取消则由 flow 负责。
          // 先摘掉本 hook 对 session 的渲染引用：提交目录后 attachment 归项目 owner，
          // 目录浏览器不该再基于它渲染（否则会出现"两个 owner 看着同一个 session"）。
          setConnectedSessionId(null);
          try {
            await onSelectProject(
              sessionId,
              preferredDirectoryPath,
              options?.localWorkspacePath ?? localWorkspacePath,
            );
            if (entryEpochRef.current !== operationEpoch) return;
            // 成功路径必须把整条连接态清干净（INV-22）。逐项清理而不是只 setStep：
            // 残留的 directoryPath / target / requestId 会在下一次打开时被当成"当前状态"，
            // 表现为弹窗一打开就闪回上一次的成功视图。
            pendingCompletionIntentRef.current = {};
            minimizedRef.current = false;
            setDirectoryPath("");
            resetConnectionLogs();
            setCurrentStep("device");
            setConnectedSessionId(null);
            updatePendingRemoteTarget(null);
            setRecognizedDeviceName(undefined);
            updateConnectingRequestId(null);
            applyOpenState(false);
            finishTrace((action) => action.complete({ resultSource: "platform_result" }));
            return;
          } catch (selectionError) {
            // 失败时若流程已作废：这是"迟到失败"，只能回收本次新建的 session，
            // 不能把错误写到已经属于新流程的 UI 上。
            if (entryEpochRef.current !== operationEpoch) {
              if (!sessionsAtStart.has(sessionId)) void handleCancelSession(sessionId);
              return;
            }
            if (
              selectionError &&
              typeof selectionError === "object" &&
              "code" in selectionError &&
              selectionError.code === "remote-connection-canceled"
            ) {
              // 成员移除属于意图取消，不是可改目录的 IO 错误；只回收本次新建的 attachment。
              // 这里必须 await 回收（而不是 void）：紧接着要清空 UI，若回收还在飞行中，
              // 用户可能已经点了重试，导致新旧两个回收动作互相覆盖。
              if (!sessionsAtStart.has(sessionId)) await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              // 清空意图并通知上层"项目意图已清除"，避免它继续拿旧目录重试（INV-20）。
              pendingCompletionIntentRef.current = {};
              onProjectIntentCleared?.();
              resetFeedback();
              setCancelled(true);
              finishTrace((action) => action.cancel());
              return;
            }
            // 历史目录可能已被删除或权限变化；保留连接并回退目录浏览器，不能把快速入口变成死路。
            // 注意这里没有 return：故意落到下面的"成功页"逻辑，让用户仍能看到已连上、
            // 并手动选择另一个目录，而不是把一次成功的连接判为失败。
            setError(getErrorMessage(selectionError));
          }
        }
        // 没有外部接管、也没有目录意图（或目录失败）→ 展示成功页，由用户继续选目录。
        // step 由 getRemoteConnectionCompletionDialogState 推导（INV-10），不手工写死。
        const completionState = getRemoteConnectionCompletionDialogState("success", {
          directToDirectory: true,
        });
        setConnectedSessionId(sessionId);
        setCurrentStep(completionState.step);
        minimizedRef.current = false;
        applyOpenState(completionState.open);
        finishTrace((action) => action.complete({ resultSource: "platform_result" }));
      };
      // 最小化时的延迟完成（INV-07）：把"接下来要做的事"包成一个续体挂起，
      // 同时发一条带"继续"按钮的通知。真正的恢复执行发生在 resumeBackground。
      // 注意这里仍然 setConnectedSessionId：后台也需要知道 session 属于谁，
      // 但设备管理不持有 session，所以置 null。
      const deferCompletion = () => {
        setConnectedSessionId(completion === "device-management" ? null : sessionId);
        const continueConnection = async () => {
          // 恢复时先重查 Source 状态：最小化期间设备可能掉线/被移除，
          // 用旧快照继续会把一个已失效的连接当成成功。
          if (connectedSourceServerId && sourceManagement) {
            const latest = await sourceManagement.getSnapshot();
            if (entryEpochRef.current !== operationEpoch) return;
            applySourceManagementSnapshot(latest);
            if (
              !latest.servers.some((server) => server.sourceServerId === connectedSourceServerId) ||
              !latest.states.some(
                (state) =>
                  state.sourceServerId === connectedSourceServerId && state.state === "online",
              )
            ) {
              // 设备不在线 ⇒ 回收本次新建的 session，并保持"最小化"状态以便 UI 展示失败。
              // minimizedRef 仍为 true 是刻意的：此时弹窗没打开，若置 false，
              // 门禁会被短暂放开，用户可能趁这个窗口再开一个连接。
              if (completion !== "device-management" && !sessionsAtStart.has(sessionId))
                await handleCancelSession(sessionId);
              if (entryEpochRef.current !== operationEpoch) return;
              setConnectedSessionId(null);
              minimizedRef.current = true;
              setError(intl.formatMessage({ id: "project.connectionUnavailable" }));
              return;
            }
          }
          // 状态仍然可用 → 继续执行原本的完成动作。
          await finishConnection();
        };
        pendingBackgroundCompletion.current = continueConnection;
        setBackgroundReady(true);
        toast(intl.formatMessage({ id: "remote.background.ready" }), {
          variant: "info",
          dismissible: true,
          dismissLabel: intl.formatMessage({ id: "common.close" }),
          dedupeKey: `remote-connection:${openIntentId ?? 0}:${operationEpoch}`,
          actionLabel: intl.formatMessage({ id: "remote.background.continue" }),
          // 通知的 continue 按钮需 epoch 与 phase 同时命中，缺一不显示。
          //   epoch：这次连接是否还是入口的当前流程；
          //   pendingBackgroundCompletion 的引用相等：是否还是"这一条"后台任务。
          // 只判 epoch 不够——同一 epoch 内可能先后产生多个后台续体（例如先最小化、
          // 恢复后又最小化），点旧通知必须无效，否则会执行已废弃的续体。
          onAction: () => {
            if (
              entryEpochRef.current !== operationEpoch ||
              pendingBackgroundCompletion.current !== continueConnection
            )
              return;
            resumeBackground();
          },
        });
        // 后台就绪本身也视为"这次连接流程已完成（对用户而言）"，遥测按 complete 结算。
        finishTrace((action) => action.complete({ resultSource: "platform_result" }));
      };
      await finishConnection();
    } catch (connectError) {
      // 迟到的失败结果直接丢弃（INV-02）：requestId 已不是当前值说明用户已取消或重开。
      if (activeRequestIdRef.current !== requestId) return;
      // 用户主动取消不是错误：只标记 cancelled，不写 error 三件套。
      // 若把它写进 error，UI 会在用户点"停止"之后弹出一条红色失败提示。
      if (
        connectError &&
        typeof connectError === "object" &&
        "code" in connectError &&
        connectError.code === "remote-connection-canceled"
      ) {
        resetFeedback();
        setCancelled(true);
        finishTrace((action) => action.cancel());
        return;
      }
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const failure = connectError as {
        code?: unknown;
        retryable?: unknown;
        profileId?: unknown;
        resolvedWslTarget?: Required<Extract<RemoteTarget, { kind: "wsl" }>>;
      };
      const reasonCode = typeof failure.code === "string" ? failure.code : undefined;
      const errorMessage = formatRemoteConnectionError({
        fallback: getErrorMessage(connectError),
        reasonCode,
        retryable: typeof failure.retryable === "boolean" ? failure.retryable : undefined,
        formatMessage: intl.formatMessage,
      });
      // 错误三件套一起写（INV-10）：code 供分类、raw 供诊断、message 供展示。
      // 缺任何一个都会让上层（重试按钮 / 诊断面板）拿到不完整状态。
      setErrorCode(reasonCode);
      setRawError(getErrorMessage(connectError));
      setError(errorMessage);
      setCurrentStep(completionState.step);
      // 最小化时不要自动把弹窗拉起来：用户已经收起了它，失败信息由通知层承载，
      // 强行弹窗会打断用户正在做的事。
      if (!minimizedRef.current) applyOpenState(completionState.open);
      finishTrace((action) => action.fail({ failureStage: "remote_connect" }));
      // 升级是"可自愈"的失败：如果目标不是 server 类型（说明是 SSH/WSL/Docker 线路），
      // 尝试自动升级后重连。server 类型没有本地 Source 可升级，直接停在错误页。
      if (reasonCode === "source-server-upgrade-required" && nextTarget.kind !== "server") {
        const failedTarget =
          nextTarget.kind === "wsl" ? (failure.resolvedWslTarget ?? nextTarget) : nextTarget;
        updatePendingRemoteTarget(failedTarget);
        await resumeRequiredServerUpdate(
          failedTarget,
          { preferredDirectoryPath, options },
          operationEpoch,
          automaticServerUpdateAttempted,
          typeof failure.profileId === "string" ? failure.profileId : undefined,
        );
      }
    } finally {
      // 所有失去归属的返回都结束旁路遥测；显式取消已在撤销请求前同步结算。
      // finishTrace 内部会判 requestId，所以这里可以无条件调用：若已被结算则 no-op。
      finishTrace((action) => action.cancel());
      // 成功恢复原目录会先清空 requestId；仍属同一流程时必须结束 busy，取消/重试则由新 epoch 接管。
      // 这个 epoch 判断是"旧流程不得清掉新流程 loading"的唯一防线（INV-01/14）：
      // 若去掉，用户取消后立刻重试，旧的 finally 会把新连接的 loading 置 false，
      // 表现为按钮瞬间恢复可点，用户再点一次就产生了并发连接。
      if (entryEpochRef.current === operationEpoch) {
        activeRequestIdRef.current = null;
        setLoading(false);
      }
    }
  };

  // "连接失败 → 自动升级 → 重连"的闭环。传入的 epoch 是失败那次连接的操作代号，
  // 整个升级过程都以它为"我是否还有权修改 UI"的判据。
  // failedProfileId 来自连接失败响应，只有在它存在且仍指向同一目标时才允许升级（INV-13）。
  const resumeRequiredServerUpdate = async (
    target: Exclude<RemoteTarget, { kind: "server" }>,
    intent: RemoteConnectionCompletionIntent,
    epoch: number,
    automaticServerUpdateAttempted = false,
    failedProfileId?: string,
  ): Promise<void> => {
    if (!sourceManagement) return;
    const isCurrent = () => entryEpochRef.current === epoch;
    try {
      const snapshot = await sourceManagement.getSnapshot();
      if (!isCurrent()) return;
      applySourceManagementSnapshot(snapshot);
      // Profile ID 标识可编辑记录，不能先覆盖失败目标再匹配；WSL 使用失败响应的实际身份。
      if (target.kind === "wsl" && (!target.distro?.trim() || !target.user?.trim())) {
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      const failedProfile = failedProfileId
        ? snapshot.profiles.find(
            (profile) =>
              profile.profileId === failedProfileId && profile.lifecycleState !== "retired",
          )
        : undefined;
      // INV-13 的核对：失败响应给的 profileId 必须仍存在、未退役、且目标一致。
      // 三者任一不满足就拒绝升级——否则可能把 A 设备的 profile 当成 B 设备升级，
      // 升级结果写进错误机器的 Source 目录。
      if (
        failedProfileId &&
        (!failedProfile || !isSameSourceServerUpdateTarget(failedProfile.target, target))
      ) {
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      const profileId = findSourceServerUpgradeProfileId(snapshot, target, failedProfileId);
      setUpgradeProfileId(profileId);
      // 找不到可升级 profile 时，还要区分一种"不是我们能修"的情况：
      // controller 需要升级（即 Host 侧版本太旧）。此时静默返回，让用户自己升级桌面端；
      // 报错反而会引导用户去点一个永远失败的"更新远端"按钮。
      if (!profileId) {
        const controllerUpdate = snapshot.states.some(
          (state) =>
            state.state === "needs-upgrade" &&
            state.upgradeTarget === "controller" &&
            snapshot.profiles.some(
              (profile) =>
                profile.profileId === state.profileId &&
                (!failedProfileId || profile.profileId === failedProfileId) &&
                profileMatchesRemoteTarget(profile, target),
            ),
        );
        if (controllerUpdate) return;
        throw new Error(intl.formatMessage({ id: "project.connectionUnavailable" }));
      }
      // INV-12：已经自动升级过一次仍然要求升级 ⇒ 说明升级没有解决问题（或版本不兼容），
      // 必须停下并让用户看到错误，否则会无限"升级→重连→再升级"。
      if (automaticServerUpdateAttempted) return;
      // 原项目交接曾只展示 initialFailure，绕过普通连接的自动更新。两种入口共用同一受保护
      // 更新链与意图 epoch：取消后不得恢复旧项目，更新后的连接也不得形成自动更新循环。
      // updateRequiredServer 返回 false 表示用户取消/升级失败，此时不重连。
      if (!(await updateRequiredServer(profileId, target)) || !isCurrent()) return;
      // 升级成功后先清 requestId（旧请求已彻底结束），再发起一次新连接并标记
      // automaticServerUpdateAttempted=true，把"最多一次"的约束传下去。
      updateConnectingRequestId(null);
      await startRemoteConnection(
        target,
        false,
        intent.preferredDirectoryPath,
        intent.options,
        true,
      );
    } catch (cause) {
      if (!isCurrent()) return;
      // 快照失败后只清空 Profile 会留下无效的“更新远端”按钮；清除旧升级错误，
      // 展示真实失败并沿用显式重试，重新连接后再由 Host 快照确认是否需要更新。
      setUpgradeProfileId(null);
      setErrorCode(undefined);
      setRawError(getErrorMessage(cause));
      setError(getErrorMessage(cause));
      logger.warn("[SSHDialog] 读取或核验升级目标失败", cause);
    }
  };

  const formSnapshot = {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    selectedSshConfigAlias,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    serverUrl,
    serverName,
    serverToken,
    serverWorkspacePath,
  };

  // 表单提交入口。三层职责：防重（INV-17）、校验（INV-16）、启动（带意图）。
  // 注意它不复用 pendingRemoteTarget 的草稿值，而是每次从 formSnapshot 重新构建：
  // 用户可能在失败后改了 host 却没点"重试"，直接重发旧 target 会连到错误的机器。
  const handleConnect = async () => {
    if (loading) {
      // Bugfix: React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    const { target: nextTarget } = buildRemoteTarget(intl, formSnapshot);
    if (!nextTarget) {
      // Bugfix: 必填项缺失属于表单校验，不应该和真实连接失败共用顶部错误条。
      // 错误改为显示在对应字段下方（RDUX-27），这里只记录一次失败提交。
      setValidationAttempt((attempt) => attempt + 1);
      return;
    }

    // 校验通过后才清错误：先清再校验会让字段下方刚出现的红字被抹掉。
    resetFeedback();
    setAliasCredentialsPending(false);
    updatePendingRemoteTarget(nextTarget);
    // 记录线路名用于头部展示与"返回修改线路"。空串归一成 undefined，
    // 避免 UI 出现一个空白的线路标签占位。
    setActiveProfileName(selectedSshConfigAlias?.trim() || undefined);
    // 手动设备连接完成后统一选目录；已有项目保持原来的明确目录意图。
    await startRemoteConnection(
      nextTarget,
      false,
      // 外部偏好只在入口初始化；重新读取 props 会让「新建连接」复活旧设备目录。
      pendingCompletionIntentRef.current.preferredDirectoryPath,
      {
        ...pendingCompletionIntentRef.current.options,
        directToDirectory: true,
      },
    );
  };

  // 安装确认：先打日志再判空，是为了在"确认框消失但回调仍到达"的边界情况下留下证据。
  // 真正发起连接时必须带上原来的意图（目录/选项），不能只传 target——
  // 否则用户点确认后会落到设备首页而不是预期的目录。
  const handleConfirmInstall = useCallback(() => {
    logger.lifecycle.info("[remote-connection] 用户确认安装", {
      hasTarget: Boolean(pendingInstallConfirmation),
      activeRequestId: activeRequestIdRef.current,
      loading,
    });
    if (!pendingInstallConfirmation) return;
    const target = pendingInstallConfirmation;
    const intent = pendingCompletionIntentRef.current;
    setPendingInstallConfirmation(null);
    void startRemoteConnection(target, true, intent.preferredDirectoryPath, intent.options);
  }, [pendingInstallConfirmation, startRemoteConnection, loading]);

  // 取消安装有两种语义：
  //   device-management：整个入口作废，走 closeDialog + onCancelled；
  //   普通连接：只撤销这一次"待安装"状态，保留用户可以改表单重试。
  // 两者都先自增 epoch，确保已经排入事件队列的确认回调失效（INV-14）。
  const handleCancelInstall = useCallback(() => {
    if (completion === "device-management" && onCancelled) {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled(background);
      return;
    }
    // 安装确认可能已排入事件队列；取消先撤销归属，旧确认不能重新发起连接。
    entryEpochRef.current += 1;
    setPendingInstallConfirmation(null);
    resetFeedback();
    setCancelled(true);
  }, [closeDialog, completion, onCancelled]);

  // 连接中的"取消"：这是最容易被写出竞态的函数，顺序必须是
  //   结算后台动作 → 撤销遥测 → 记下 requestId → 自增 epoch → 清 UI → 最后才发 cancel RPC。
  // 为什么 cancel RPC 放最后：它可能立刻触发 fail 回调，而回调看到旧 epoch 会直接 return；
  // 先自增再发，保证"取消产生的失败"不会被当成新的连接失败展示出来（INV-14）。
  const handleCancelConnection = useCallback(() => {
    if (completion === "device-management" && onCancelled) {
      const background = minimizedRef.current;
      closeDialog();
      onCancelled(background);
      return;
    }
    settleForceUpdate(false);
    cancelActiveTrace();
    const requestId = activeRequestIdRef.current;
    entryEpochRef.current += 1;
    setBlockedCompletion(null);
    setCompletionRunning(false);
    const sessionId = connectedSessionIdRef.current;
    if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
    setConnectedSessionId(null);
    updateConnectingRequestId(null);
    setLoading(false);
    // 取消先撤销 epoch，旧更新的 finally 不再有权清理 busy；在 owner 的取消入口同步收口。
    setUpgradeLoading(false);
    setPendingInstallConfirmation(null);
    setAliasCredentialsPending(false);
    resetFeedback();
    // cancelled 与 error 互斥：取消只标记 cancelled，不写错误文案。
    setCancelled(true);
    // requestId 来自本次取消前读取的值（此时 activeRequestIdRef 已被清空），
    // 用 ref 而不是 state，避免拿到上一次渲染的陈旧 id 取消错请求。
    if (requestId) void cancelPendingRemoteConnection(requestId);
  }, [
    cancelActiveTrace,
    cancelPendingRemoteConnection,
    closeDialog,
    completion,
    onCancelled,
    updateConnectingRequestId,
  ]);

  // 重试入口："用已确定的 target 再连一次"。三条分支：
  //   1) 没有 target（用户还没选过设备）→ 退回表单提交；
  //   2) SSH 既无密码也无密钥 → 不拨号，进"补凭据"态（否则必然认证失败）；
  //   3) 正常 → 带上意图与"是否已自动升级过"重连。
  // 第 2 条是关键：凭据缺失是"缺输入"而不是"连接错误"，用错状态会让用户看到
  // 一条 authentication failed 的红字，然后无从下手。
  const handleStartPendingRemoteConnection = useCallback(
    (automaticServerUpdateAttempted = false) => {
      if (!pendingRemoteTarget) {
        void handleConnect();
        return;
      }

      if (
        pendingRemoteTarget.kind === "ssh" &&
        !pendingRemoteTarget.password &&
        !pendingRemoteTarget.privateKeyPath
      ) {
        resetFeedback();
        setAliasCredentialsPending(true);
        return;
      }
      const intent = pendingCompletionIntentRef.current;
      void startRemoteConnection(
        pendingRemoteTarget,
        false,
        intent.preferredDirectoryPath,
        intent.options,
        automaticServerUpdateAttempted,
      );
    },
    [handleConnect, pendingRemoteTarget, startRemoteConnection],
  );

  // 用户手动点"更新远端"：与自动升级共用 updateRequiredServer（同一套确认/日志/快照），
  // 区别只有两点：允许再次尝试（不传 automatic 标记），且升级成功后立刻重连。
  // server 类型没有可升级的本地 Source，直接返回。
  const handleUpgradeRequiredServer = useCallback(async () => {
    if (!upgradeProfileId || !pendingRemoteTarget || pendingRemoteTarget.kind === "server") return;
    if (await updateRequiredServer(upgradeProfileId, pendingRemoteTarget)) {
      handleStartPendingRemoteConnection(true);
    }
  }, [
    handleStartPendingRemoteConnection,
    pendingRemoteTarget,
    upgradeProfileId,
    updateRequiredServer,
  ]);

  // 从目录页返回连接页：必须真正回收 session，而不是只把 step 改回去。
  // 这里直接调 onCancelSession（而不是 handleCancelSession 的吞错版本），
  // 因为"回收失败"意味着 session 可能被别的 owner 持有，此时切回连接页会看到
  // 一个指向旧 session 的界面；展示错误并停留在当前页是更安全的选择。
  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    try {
      await onCancelSession(connectedSessionId);
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // Bugfix: 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
      // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
      // ref 与 state 都要设：ref 用于事件入口的同步防重（两次点击之间 React 还没重渲染），
      // state 用于渲染"提交中"的禁用态。
      const epoch = entryEpochRef.current;
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        // 提交期间用户可能已取消/切目标：此时 session 已被别人接管，不能再清状态。
        if (entryEpochRef.current !== epoch) return;
        // 成功路径与 startRemoteConnection 的收尾完全同构（INV-22）：
        // 清意图、清目录、清日志、回设备页、断开本地引用、清目标与 requestId、关窗。
        // 任何一项遗漏都会在下一次打开时留下"上次已连接"的残影。
        pendingCompletionIntentRef.current = {};
        minimizedRef.current = false;
        setDirectoryPath("");
        resetConnectionLogs();
        setCurrentStep("device");
        setConnectedSessionId(null);
        updatePendingRemoteTarget(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        if (entryEpochRef.current !== epoch) return;
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        // 失败分两种（由 getRemoteConnectionDirectoryFailureState 判定）：
        //   session 已不在 store 里 → 连接事实上已死，必须回到连接页重来；
        //   session 还在 → 只有"进入目录"失败，保留连接让用户换一个目录再试。
        // 这正是把它抽成纯函数的原因：这个判断涉及多个输入，写在 catch 里极易写反。
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        if (entryEpochRef.current === epoch) resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
      updatePendingRemoteTarget,
    ],
  );

  // "回放一次已发生的失败"。上游（如通知点击、项目恢复）可能带着上次失败的 code 打开弹窗，
  // 这里负责把 UI 直接摆到"连接页 + 该错误"，必要时继续触发安装确认或升级。
  // 三处 target 修正决定用户看到的是不是"真出问题的那台机器"：
  //   failedTarget：升级失败时实际尝试的目标；
  //   resolvedWslTarget：WSL 解析后的具体发行版（否则只显示一个模糊的 wsl 目标）；
  //   表单回填：保证用户点"返回修改"时字段是失败时的那份配置。
  const acceptInitialFailure = (
    target: RemoteTarget,
    initialFailure?: RemoteConnectionOpenPreference["initialFailure"],
  ) => {
    if (!initialFailure) return false;
    if (initialFailure.code === "source-server-upgrade-required" && initialFailure.failedTarget) {
      target = { ...target, ...initialFailure.failedTarget };
    }
    if (
      (initialFailure.code === "source-server-install-required" ||
        initialFailure.code === "source-server-upgrade-required") &&
      target.kind === "wsl"
    ) {
      target = initialFailure.resolvedWslTarget ?? target;
    }
    updatePendingRemoteTarget(target);
    setKind(target.kind);
    if (target.kind === "ssh") {
      setHost(target.host);
      setPort(String(target.port ?? 22));
      setUsername(target.username);
      setPassword(target.password ?? "");
      setPrivateKeyPath(target.privateKeyPath ?? "");
      setPrivateKeyPassphrase(target.privateKeyPassphrase ?? "");
      setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
      setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    } else if (target.kind === "wsl") {
      setWslDistro(target.distro ?? "");
      setWslUser(target.user ?? "");
    } else if (target.kind === "docker") {
      setDockerContainer(target.container);
      setManualDockerContainer(target.container);
    } else {
      setServerUrl(target.url);
      setServerName(target.name ?? "");
      setServerToken(target.token ?? "");
    }
    // 直接进 connecting 而不是 settings：用户是来"看这次失败"的，
    // 先展示失败现场与重试按钮，比把他丢回表单更符合意图。
    setCurrentStep("connecting");
    setErrorCode(initialFailure.code);
    setRawError(initialFailure.message);
    // 展示文案走统一格式化：code 能映射出更友好的说明，映射不到才回退原始 message。
    setError(
      formatRemoteConnectionError({
        fallback: initialFailure.message,
        reasonCode: initialFailure.code,
        formatMessage: intl.formatMessage,
      }),
    );
    // 需要安装时直接弹出安装确认（回到"待确认"而不是"失败"）；
    // 这样上游重放失败时，用户看到的是可操作的确认框，而不是一条死路错误。
    if (initialFailure.code === "source-server-install-required")
      setPendingInstallConfirmation(target);
    if (initialFailure.code === "source-server-upgrade-required" && target.kind !== "server") {
      void resumeRequiredServerUpdate(
        target,
        pendingCompletionIntentRef.current,
        entryEpochRef.current,
        false,
        initialFailure.profileId,
      );
    }
    return true;
  };

  const handleSelectProfile = (
    profile: ConnectionProfile,
    preferredDirectoryPath?: string,
    selectOptions?: {
      initialFailure?: RemoteConnectionOpenPreference["initialFailure"];
      directToDirectory?: boolean;
      localWorkspacePath?: string;
    },
  ) => {
    // 选中已有线路也开一个新 epoch：它与"新建连接"是同一层级的入口动作，
    // 旧流程的任何在途回调都必须在此刻失效。
    const entryEpoch = ++entryEpochRef.current;
    resetFeedback();
    // 清掉上一轮遗留的"待安装/待升级"提示：用户已经选了别的线路，旧提示会误导。
    setPendingInstallConfirmation(null);
    setUpgradeProfileId(null);
    // 凭据缺失时也保留目录意图，不能等真正拨号才记录。
    pendingCompletionIntentRef.current = { preferredDirectoryPath, options: selectOptions };
    setDirectoryPath("");
    setActiveProfileName(profile.displayName);
    setRecognizedSourceServerId(profile.sourceServerId);
    setRecognizedDeviceName(
      sourceManagementSnapshot?.servers.find(
        (server) => server.sourceServerId === profile.sourceServerId,
      )?.displayName,
    );
    // Bug 原因：外部连接入口过去先在原界面直接执行 connectProfile，导致 toast、静默连接和
    // 弹窗进度三套反馈并存。精确 Profile intent 在加载凭据前就进入连接屏，后续安装/升级/
    // 失败/重试全部由同一个连接步骤承接。
    setCurrentStep("connecting");
    void (async () => {
      try {
        const target = buildRemoteTargetFromProfile(profile);
        const failure = selectOptions?.initialFailure;
        if (
          failure?.code === "source-server-upgrade-required" &&
          failure.failedTarget &&
          !isSameSourceServerUpdateTarget(target, failure.failedTarget)
        ) {
          // 新 Profile 的凭据也不能混入旧失败目标；先交回原身份，让恢复校验提供显式重试。
          acceptInitialFailure(failure.failedTarget, failure);
          return;
        }
        setKind(target.kind);
        // Bug 原因：设备首屏之前只把 Profile 的非敏感 metadata 传给 Host，
        // Host manager.connect 不会替 UI 解析 credential refs，密码线路因此必然认证失败。
        const credentials = await loadConnectionProfileCredentials({
          profile,
          loadCredential: baseServices.credentialService.load,
        });
        // 凭据读取是异步的（可能读 keychain / 解密），返回时必须确认本次入口仍有效，
        // 否则会把 A 线路的凭据填进 B 线路的表单（串号，属于安全事故）。
        if (entryEpochRef.current !== entryEpoch) return;
        if (target.kind === "ssh") {
          const hasPasswordAuth = Boolean(credentials?.password);
          const expectsPrivateKeyPassphrase =
            profile.target.kind === "ssh" &&
            Boolean(profile.target.privateKeyPassphraseCredentialKey);
          const hasPrivateKeyAuth = Boolean(
            target.privateKeyPath &&
            (!expectsPrivateKeyPassphrase || credentials?.privateKeyPassphrase),
          );
          if (!hasPasswordAuth && !hasPrivateKeyAuth) {
            // Bug 原因：Profile ref 存在但 value 缺失时，旧路径仍以空认证 target 发起 SSH，
            // 把“需要交互凭据”误报成服务端认证失败。认证链不完整必须在网络调用前 fail closed。
            updatePendingRemoteTarget(target);
            // 补凭据时仍保留原线路配置，返回设置不能变成空白的新连接。
            setKind("ssh");
            // 自动换目标不能混用常驻表单中上一设备的凭据，缺凭据只能重新输入。
            setPassword("");
            setPrivateKeyPassphrase("");
            setServerToken("");
            setHost(target.host);
            setPort(String(target.port ?? 22));
            setUsername(target.username);
            setPrivateKeyPath(target.privateKeyPath ?? "");
            setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
            setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
            setErrorCode("credentials-required");
            setError(intl.formatMessage({ id: "remote.error.credentialsRequired" }));
            return;
          }
        }
        const targetWithCredentials =
          target.kind === "ssh" && credentials
            ? {
                ...target,
                ...(credentials.password ? { password: credentials.password } : {}),
                ...(credentials.privateKeyPassphrase
                  ? {
                      privateKeyPassphrase: credentials.privateKeyPassphrase,
                    }
                  : {}),
              }
            : target;
        // 已保存线路可能直接进入连接屏；返回修改用户名/密钥时必须编辑这条线路，而非旧表单草稿。
        if (targetWithCredentials.kind === "ssh") {
          setHost(targetWithCredentials.host);
          setPort(String(targetWithCredentials.port ?? 22));
          setUsername(targetWithCredentials.username);
          setPrivateKeyPath(targetWithCredentials.privateKeyPath ?? "");
          setSshAuthMethod(targetWithCredentials.privateKeyPath ? "privateKey" : "password");
          setPassword(targetWithCredentials.password ?? "");
          setPrivateKeyPassphrase(targetWithCredentials.privateKeyPassphrase ?? "");
          setAssetInstallMode(
            targetWithCredentials.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE,
          );
        }
        updatePendingRemoteTarget(targetWithCredentials);
        if (acceptInitialFailure(targetWithCredentials, selectOptions?.initialFailure)) return;
        await startRemoteConnection(
          targetWithCredentials,
          false,
          preferredDirectoryPath,
          selectOptions,
        );
      } catch (cause) {
        // 这里捕获的是"准备阶段"的失败（构建 target、读凭据），不是网络失败：
        // 仍展示在连接页，让用户能看到具体原因并返回修改，而不是空白表单。
        if (entryEpochRef.current !== entryEpoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
      }
    })();
  };
  // 新的 openIntent 到达：这是一个"外部要求重新打开并处理"的信号。
  // 顺序刻意是"先记录后台状态 → 再 closeDialog(keepOpen)"，因为 closeDialog 会
  // 把 minimizedRef 复位；先读才能知道这次是否要从后台恢复（需要额外刷新快照）。
  // keepOpen 保证用户看到的是"原地重置"而不是一闪而过的关闭动画。
  const acceptOpenIntent = useEffectEvent(() => {
    // 新入口先撤销旧 epoch/等待点，再由下面的偏好 effect 消费；恢复卡片不走这里。
    const wasBackground = minimizedRef.current;
    closeDialog({ keepOpen: true });
    if (wasBackground && sourceManagement) {
      const epoch = entryEpochRef.current;
      refreshingIntentRef.current = epoch;
      setRefreshingIntent(true);
      // 后台订阅保持存活，新入口仍须先读最新 Profile，不能消费旧快照的已编辑线路。
      void sourceManagement
        .getSnapshot()
        .then((snapshot) => {
          if (entryEpochRef.current === epoch) applySourceManagementSnapshot(snapshot);
        })
        .catch((cause) => {
          if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
        })
        .finally(() => {
          if (refreshingIntentRef.current !== epoch) return;
          refreshingIntentRef.current = null;
          setRefreshingIntent(false);
        });
    }
  });
  useEffect(() => {
    if (!open || openIntentId === undefined || consumedOpenIntentIdRef.current === openIntentId)
      return;
    // 先标记已消费再判门禁：即使这次因为流程活跃而被拒绝，同一个 id 也不该反复尝试。
    // 否则每次 flowActive 变化都会重跑这段，产生"延迟生效"的怪异行为。
    consumedOpenIntentIdRef.current = openIntentId;
    // Root 用 flowActive 拒绝新增意图；显式替换已有 openIntentId 仍需撤销等待中的完成动作。
    // 这里额外挡升级中：升级会重写 Source 目录，此时重开意图会与升级的写操作交叉。
    if (isRemoteConnectionFlowActive(flowSnapshot) || upgradeLoading) return;
    acceptOpenIntent();
  }, [open, openIntentId, flowActive]);

  // 种类偏好（例如从 WSL 页面点"连接"）：只允许落在"当前平台支持的种类"上，
  // 不支持就直接忽略——静默降级到默认种类，好过把用户丢进一个永远连不上的表单。
  const applyKindPreference = useEffectEvent(() => {
    if (!preferredKind || !availableKinds.includes(preferredKind)) return;
    // 外部 WSL/UNC 意图只在新入口消费一次；恢复收起的表单不能覆盖用户草稿。
    resetDraft();
    setKind(preferredKind);
    if (preferredKind === "wsl") setWslDistro(preferredWslDistro ?? "");
    setCurrentStep("settings");
  });
  useEffect(() => {
    if (!open || !preferredKind || preferredTarget || preferredProfileId || preferredSourceServerId)
      return;
    const key = `${preferredKind}:${preferredWslDistro ?? ""}`;
    if (consumedKindPreferenceRef.current === key) return;
    consumedKindPreferenceRef.current = key;
    applyKindPreference();
  }, [
    open,
    preferredKind,
    preferredWslDistro,
    preferredTarget,
    preferredProfileId,
    preferredSourceServerId,
    openIntentId,
  ]);

  // 应用"指定目标"（设备卡/快速连接传入的完整 target）。
  // 关键点是清空三个凭据字段：只替换 host/url 而保留上一目标的密码，
  // 会让一次"连 B 机器"的请求带着 A 的密码发出，既失败又有泄露风险。
  // 清理时机选在 applyPreferredTarget 换目标时而非关闭时，连续改地址同样需要清。
  const applyPreferredTarget = useEffectEvent((target: RemoteTarget) => {
    entryEpochRef.current += 1;
    setFocusCredentials(false);
    // 只替换地址会把上一目标的密码/token 带进新请求；清理发生在换目标而非收起时。
    setPassword("");
    setPrivateKeyPassphrase("");
    setServerToken("");
    setKind(target.kind);
    updatePendingRemoteTarget(target);
    pendingCompletionIntentRef.current = {
      preferredDirectoryPath,
      options: { directToDirectory: true },
    };
    if (target.kind === "ssh") {
      setHost(target.host);
      setPort(String(target.port ?? 22));
      setUsername(target.username);
      setPrivateKeyPath(target.privateKeyPath ?? "");
      setSshAuthMethod(target.privateKeyPath ? "privateKey" : "password");
      // 已有线路必须沿用保存的下载侧，不能被新建表单的默认值覆盖。
      setAssetInstallMode(target.assetInstallMode ?? DEFAULT_REMOTE_ASSET_INSTALL_MODE);
    } else if (target.kind === "wsl") {
      setWslDistro(target.distro ?? "");
      setWslUser(target.user ?? "");
    } else if (target.kind === "docker") {
      setManualDockerContainer(target.container);
      setDockerContainer(target.container);
    } else {
      setServerUrl(target.url);
      setServerName(target.name ?? "");
    }
    // 有 initialFailure 时由 acceptInitialFailure 决定停在哪一页（连接页/安装确认），
    // 否则停在表单页让用户确认或补充凭据。
    if (!acceptInitialFailure(target, initialFailure)) setCurrentStep("settings");
  });
  useEffect(() => {
    if (
      !open &&
      currentStep === "device" &&
      !pendingRemoteTarget &&
      !connectedSessionId &&
      !loading
    )
      consumedPreferredTargetRef.current = null;
    if (
      !open ||
      !preferredTarget ||
      preferredProfileId ||
      loading ||
      connectedSessionId ||
      consumedPreferredTargetRef.current === preferredTarget
    )
      return;
    // 先登记消费再应用（与 openIntent 一致）：应用过程中会触发多次 setState，
    // 若不先登记，重渲染会让这个 effect 再次命中同一个 preferredTarget，形成循环。
    consumedPreferredTargetRef.current = preferredTarget;
    applyPreferredTarget(preferredTarget);
  }, [
    open,
    preferredTarget,
    preferredProfileId,
    loading,
    connectedSessionId,
    currentStep,
    pendingRemoteTarget,
    openIntentId,
  ]);

  // 设备卡入口：不带目录意图（undefined），但要求连上后直达目录页，
  // 因为用户是从"这台设备"点进来的，他的下一步必然是选一个目录。
  const openPreferredSourceDirectory = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, undefined, { directToDirectory: true });
  });
  const openPreferredProfile = useEffectEvent((profile: ConnectionProfile) => {
    handleSelectProfile(profile, preferredDirectoryPath, {
      directToDirectory: true,
      initialFailure,
    });
  });

  useEffect(() => {
    if (
      !open ||
      !preferredProfileId ||
      refreshingIntentRef.current !== null ||
      loading ||
      connectedSessionId ||
      consumedPreferredProfileIdRef.current === preferredProfileId ||
      !sourceManagementSnapshot
    ) {
      return;
    }
    const profile = sourceManagementSnapshot.profiles.find(
      (candidate) =>
        candidate.profileId === preferredProfileId && candidate.lifecycleState !== "retired",
    );
    // 找不到（可能已删除/退役）就保持"未消费"状态：等快照刷新后还能命中。
    // 这与"消费后失败"不同——后者会让这次意图永久丢失，用户点设备卡毫无反应。
    if (!profile) return;

    consumedPreferredProfileIdRef.current = preferredProfileId;
    openPreferredProfile(profile);
  }, [
    connectedSessionId,
    loading,
    open,
    openIntentId,
    preferredProfileId,
    refreshingIntent,
    sourceManagementSnapshot,
  ]);

  useEffect(() => {
    if (
      !open ||
      !preferredSourceServerId ||
      refreshingIntentRef.current !== null ||
      loading ||
      connectedSessionId ||
      consumedPreferredSourceServerIdRef.current === preferredSourceServerId ||
      !sourceManagementSnapshot
    ) {
      return;
    }
    const profile = findPreferredSourceConnectionProfile(
      sourceManagementSnapshot,
      preferredSourceServerId,
    );
    if (!profile) return;

    // Bug 原因：侧栏设备组虽然已知 sourceServerId，弹窗入口过去只接受连接类型，
    // 打开后只能重置到设备首屏。这里一次性消费设备意图，并复用设备卡既有直达目录链路。
    consumedPreferredSourceServerIdRef.current = preferredSourceServerId;
    openPreferredSourceDirectory(profile);
  }, [
    connectedSessionId,
    loading,
    open,
    openIntentId,
    preferredSourceServerId,
    refreshingIntent,
    sourceManagementSnapshot,
  ]);

  // 弹窗开关的统一入口（Radix Dialog 的 onOpenChange）。
  // 打开方向：清掉"最小化"标记再置 open——否则后台通知会与前台弹窗并存，
  // 用户会看到同一个连接同时出现在两处且状态不同步。
  // 关闭方向：一律走 handleCloseRequest（含确认与 session 回收），不能直接 applyOpenState(false)，
  // 否则"已连接但还没选目录"的 session 会泄漏。
  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      minimizedRef.current = false;
      applyOpenState(true);
      return;
    }

    void handleCloseRequest();
  };

  // 头部文案是"状态 → 文案"的纯映射，输入包含 lineName / deviceName / 是否就绪 / 是否有错 /
  // 是否升级中 / 是否已取消。把它们一起传进去而不是在组件里拼，
  // 是为了让"取消"与"失败"能显示不同的标题（取消不该出现 red 语气的标题）。
  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind, {
    lineName:
      activeProfileName ??
      (pendingRemoteTarget ? formatRemoteLinkRailTarget(pendingRemoteTarget) : undefined),
    deviceName: recognizedDeviceName,
    connectionReady: Boolean(connectedSessionId) && !error,
    hasError: Boolean(error),
    updating: upgradeLoading,
    cancelled,
  });

  // 凭据错误要内联补输入而非只显示红字，故按 errorCode 再分一次类。
  // 两个来源都要看：errorCode 是结构化的权威判据，rawError ?? error 是兜底文本
  // （有些错误码缺失，只能靠文本特征识别认证失败）。
  const credentialCategory = classifyRemoteConnectionError({
    errorCode,
    error: rawError ?? error,
  }).category;
  const needsCredentials =
    aliasCredentialsPending ||
    credentialCategory === "credentials" ||
    credentialCategory === "authentication";
  const passphraseRequired =
    pendingRemoteTarget?.kind === "ssh" && Boolean(pendingRemoteTarget.privateKeyPath);
  // 找到"当前连接对应的 Source 状态"，用于安装预览与升级目标。
  // 两个匹配条件：
  //   1) state.profileId 等于正在升级的 profile（升级优先，因为它是用户当下关心的）；
  //   2) 否则按 target 反查 profile（新建连接没有 profileId，只能靠目标匹配）。
  // server 类型没有 Source 状态，显式排除，避免把 URL 误匹配到某台本地 Source。
  const currentConnectionState = sourceManagementSnapshot?.states.find(
    (state) =>
      state.profileId === upgradeProfileId ||
      sourceManagementSnapshot.profiles.some(
        (profile) =>
          profile.profileId === state.profileId &&
          pendingRemoteTarget &&
          pendingRemoteTarget.kind !== "server" &&
          profileMatchesRemoteTarget(profile, pendingRemoteTarget),
      ),
  );
  // 恢复后台连接（通知"继续" / 重新打开弹窗都会走到这里）。
  // 没有续体时只把弹窗打开：可能只是"查看后台状态"，不需要执行任何动作。
  // 有续体时"先消费再执行"（INV-07 的关键）：否则用户在完成前连点两次继续，
  // 同一次完成动作会被重放两遍（会重复调 onSelectProject）。
  const resumeBackground = () => {
    const finish = pendingBackgroundCompletion.current;
    if (!finish) {
      handleOpenChange(true);
      return;
    }
    const operationEpoch = entryEpochRef.current;
    // 先消费再运行，重复按钮和旧 toast 不能重复恢复。
    pendingBackgroundCompletion.current = null;
    minimizedRef.current = false;
    // 通知继续曾跳过前台通知，资格查询期间原草稿仍可发送；先由原 owner 恢复禁发，再等待 IO。
    // 这里的顺序（先开弹窗，再等 finish 的 async IO）是有意的：
    // 用户点了继续就应该立刻看到连接页在"处理中"，而不是等几秒后界面才出现。
    applyOpenState(true);
    setBackgroundReady(false);
    setCompletionRunning(true);
    void finish()
      .catch((cause) => {
        // 快照读取也可能延迟失败；取消或换入口后不能用旧错误重新打开弹窗。
        if (entryEpochRef.current !== operationEpoch) return;
        setError(getErrorMessage(cause));
        setCurrentStep("connecting");
        // 显式继续也会等待资格 IO；用户再次收起后，迟到错误只能更新原后台操作。
        // 也就是说：错误只写进状态，是否重新打开由用户当前是否最小化决定。
        if (!minimizedRef.current) applyOpenState(true);
      })
      .finally(() => {
        // 同理，旧 epoch 的 finally 无权清掉新流程的 completionRunning（否则门禁提前放开）。
        if (entryEpochRef.current === operationEpoch) setCompletionRunning(false);
      });
  };
  // 用户从任意入口把弹窗重新打开（open 变 true）时，若之前是最小化状态，
  // 必须走一次 resumeBackground 把"待完成动作"接上；否则会出现
  // "结果已经算出来，但没有任何按钮能把它消费掉"的悬挂状态。
  const resumeOpenedBackground = useEffectEvent(() => {
    // 普通入口只更新受控 open，曾绕过后台恢复，导致已完成结果挂在没有继续入口的连接页。
    // 复用同一恢复动作：在途时解除后台标记，完成后一次消费结果，保留取消与代际保护。
    if (minimizedRef.current) resumeBackground();
  });
  useEffect(() => {
    if (open) resumeOpenedBackground();
  }, [open]);
  // 后台通知里的目标展示要"脱敏"：SSH 只保留 host/username/port，server 只保留 url/name。
  // 不能直接传 pendingRemoteTarget——它可能带 password / privateKeyPassphrase / token，
  // 而通知卡片会被序列化进系统通知，等于把凭据写到系统日志里。
  const displayTarget = useMemo(
    () =>
      pendingRemoteTarget?.kind === "ssh"
        ? {
            kind: "ssh" as const,
            host: pendingRemoteTarget.host,
            username: pendingRemoteTarget.username,
            port: pendingRemoteTarget.port,
          }
        : pendingRemoteTarget?.kind === "server"
          ? {
              kind: "server" as const,
              url: pendingRemoteTarget.url,
              name: pendingRemoteTarget.name,
            }
          : pendingRemoteTarget,
    [pendingRemoteTarget],
  );
  // 目录页回调的"代际快照"：这些回调会被传给下层组件，可能在任意时刻被调用（含收起后）。
  // 闭包里捕获当前 epoch，回调触发时先比对，避免一个早已过期的按钮去改现在的状态。
  // 注意这是渲染期读取 ref，值本身不会触发重渲染，仅用于身份校验。
  const directoryEpoch = entryEpochRef.current;
  // 返回给弹窗组件的视图模型：按"阶段"分区（header / minimizedProgress / selectionStep /
  // settingsStep / connectingStep / directoryStep），组件只负责把 props 透传给子步骤。
  // 这种"一个大对象"的形状让弹窗侧无需理解状态机，也让本文件成为唯一的真相来源。
  return {
    open,
    currentStep,
    error,
    handleOpenChange,
    header: {
      currentStep,
      deviceManagement: completion === "device-management",
      hideHeading: currentStep === "connecting" && !cancelled,
      title: stepCopy.title,
      description: stepCopy.description,
      // 表单屏头部的实时目标预览，与连接页头部的「类型 + 等宽目标」同构（RDUX-27）。
      settingsPreview:
        currentStep === "settings"
          ? { kind, target: formatRemoteDraftPreview(formSnapshot) }
          : undefined,
      // 收起与关闭是两件事（INV-07）：收起只改可见性，流程继续；关闭才回收 session。
      // 这里不判 loading/connectedSessionId，保证任何阶段都能收起——
      // 历史上这个按钮被门禁挡过，用户在表单页会以为"收起功能坏了"。
      onMinimize: () => {
        // Bug 原因：收起按钮过去被 loading/connectedSessionId 门禁，填写配置和连接失败
        // 等 idle 步骤会看起来像功能被删除。收起始终只改 visibility；状态清理由关闭负责。
        minimizedRef.current = true;
        applyOpenState(false);
      },
      onClose: () => {
        // Bugfix: 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
        void handleCloseRequest();
      },
    } satisfies ComponentProps<typeof RemoteConnectionWizardHeader>,
    // 后台通知的数据：只有"弹窗关闭且处于最小化"时才存在。
    // operationId 用 `${openIntentId}:${epoch}` 组成：openIntentId 区分外部入口，
    // epoch 区分同一入口内的多次尝试，二者合起来才能保证通知不会串到另一次连接上。
    // error 在 credentials-required 时被清空：这类"错误"其实要用户补输入，
    // 通知里显示成失败会让用户以为连接坏了。
    minimizedProgress:
      !open && minimizedRef.current
        ? {
            operationId: `${openIntentId ?? 0}:${directoryEpoch}`,
            view: currentStep,
            cancelled,
            target: displayTarget,
            name: recognizedDeviceName ?? activeProfileName,
            logs: visibleConnectionLogs,
            error: errorCode === "credentials-required" ? "" : error,
            reason: error
              ? intl.formatMessage({
                  id: classifyRemoteConnectionError({
                    errorCode,
                    target: pendingRemoteTarget ?? undefined,
                  }).reasonId,
                })
              : "",
            waiting:
              aliasCredentialsPending ||
              Boolean(pendingInstallConfirmation) ||
              Boolean(pendingForceUpdate) ||
              errorCode === "credentials-required",
            ready: backgroundReady,
            sourceServerId: recognizedSourceServerId ?? preferredSourceServerId,
            profileId:
              preferredProfileId ??
              sourceManagementSnapshot?.profiles.find(
                (profile) =>
                  pendingRemoteTarget &&
                  pendingRemoteTarget.kind !== "server" &&
                  profileMatchesRemoteTarget(profile, pendingRemoteTarget),
              )?.profileId,
            // 两个回调都先做代际校验（epoch）：通知是"可停留很久的 UI"，
            // 用户很可能在连接早已结束之后才点它，此时任何动作都是越权的。
            // onResume 额外要求"还有续体或尚未就绪"：已经完成且无可执行动作时，
            // 点"继续"只应该打开弹窗看结果，不应再次触发 resumeBackground 的重放逻辑。
            onCancel: () => {
              if (entryEpochRef.current === directoryEpoch) void handleCloseRequest();
            },
            onResume: () => {
              if (
                entryEpochRef.current !== directoryEpoch ||
                (backgroundReady && !pendingBackgroundCompletion.current)
              )
                return;
              resumeBackground();
            },
          }
        : null,
    // SSH alias 缺凭据时的内联输入框。提交复用 handleConnect 而不是自己拼 target：
    // 表单里已经被 applySshConfigAlias 填好了 alias 的 host/username/port，
    // 再走一遍统一构建能保证"内联补密码"与"手动填表"产生完全一致的 target。
    aliasCredentials: aliasCredentialsPending
      ? {
          password,
          onPasswordChange: setPassword,
          onSubmit: () => {
            void handleConnect();
          },
        }
      : null,
    selectionStep: {
      snapshot: sourceManagementSnapshot,
      aliases: sshConfigAliases,
      distros: wslDistros,
      containers: dockerContainers,
      availableKinds,
      dockerAvailable,
      loading: discoveryLoading,
      discoveryError,
      remoteConversationWorkspaceBySourceServerId,
      // 三条选择路径（profile / target / alias）都必须先 onProjectIntentCleared：
      // 用户主动换了目标，说明旧的"打开某个项目目录"的意图作废，
      // 不清会让完成阶段跳回上一个项目。
      onSelectProfile: (profile, path) => {
        onProjectIntentCleared?.();
        handleSelectProfile(profile, path, { directToDirectory: true });
      },
      // "新建连接"：清空目标与草稿，但保留 announceReusedConnection——
      // 这次是显式新建，若命中可复用会话要提示用户，而不是静默复用。
      onNewConnection: (nextKind) => {
        entryEpochRef.current += 1;
        pendingCompletionIntentRef.current = { options: { announceReusedConnection: true } };
        updatePendingRemoteTarget(null);
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind(nextKind);
        setActiveProfileName(undefined);
        setAliasCredentialsPending(false);
        setFocusCredentials(false);
        onProjectIntentCleared?.();
        resetFeedback();
        setCurrentStep("settings");
      },
      // 直接选目标（已发现的 Docker/WSL 资源）：不走表单，直接发起连接。
      // 注意这里不设 pendingCompletionIntent：默认走到"成功页由用户选目录"，
      // 因为这类快速入口没有外部指定的目录意图。
      onSelectTarget: (target) => {
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind(target.kind);
        if (target.kind === "wsl") setWslDistro(target.distro ?? "");
        if (target.kind === "docker") setDockerContainer(target.container);
        setActiveProfileName(undefined);
        onProjectIntentCleared?.();
        void startRemoteConnection(target);
      },
      onSelectAlias: (alias) => {
        resetDraft();
        setDirectoryPath("");
        setRecognizedDeviceName(undefined);
        setRecognizedSourceServerId(undefined);
        setKind("ssh");
        applySshConfigAlias(alias);
        setActiveProfileName(alias.alias);
        pendingCompletionIntentRef.current = {};
        onProjectIntentCleared?.();
        resetFeedback();
        const target: RemoteTarget = {
          kind: "ssh",
          host: alias.host?.trim() || alias.alias,
          username: alias.username?.trim() ?? "",
          port: alias.port,
          sshConfigAlias: alias.alias,
          privateKeyPath: alias.privateKeyPath,
          assetInstallMode: DEFAULT_REMOTE_ASSET_INSTALL_MODE,
        };
        updatePendingRemoteTarget(target);
        // alias 的三段式：缺用户名 → 回表单补（表单有完整字段）；
        // 缺私钥 → 进连接页并弹出内联密码框（用密码走这条 alias）；
        // 都有 → 直接连。分段的原因是"缺什么就补什么"，避免把用户丢回一个大表单。
        if (!target.username) {
          setCurrentStep("settings");
          return;
        }
        if (!target.privateKeyPath) {
          setAliasCredentialsPending(true);
          setCurrentStep("connecting");
          return;
        }
        void startRemoteConnection(target);
      },
    } satisfies ComponentProps<typeof RemoteConnectionSelection>,
    // 表单页：字段全部是"受控值 + setter"，本 hook 不在这里做任何校验，
    // 校验结果由 fieldErrors 下发（规则唯一来源见 collectRemoteFormFieldErrors）。
    // availableKinds 只在新增设备时下发，非新增时传 undefined 由组件回退为只读展示。
    settingsStep: {
      availableKinds: addingDevice ? availableKinds : undefined,
      // 只有"新增设备"才允许切种类：从既有设备进入时种类由设备决定，
      // 切换会让"编辑这条线路"变成"新开一条不同类型的线路"，语义混乱。
      // 切种类要作废 epoch 并清空目标/草稿：不同种类的字段完全不可复用。
      onKindChange: addingDevice
        ? (nextKind: RemoteTarget["kind"]) => {
            if (nextKind === kind) return;
            entryEpochRef.current += 1;
            resetDraft();
            setKind(nextKind);
            updatePendingRemoteTarget(null);
            setActiveProfileName(undefined);
            setRecognizedSourceServerId(undefined);
            setRecognizedDeviceName(undefined);
            resetFeedback();
          }
        : undefined,
      connectLabel:
        completion === "device-management"
          ? intl.formatMessage({ id: "remote.addAndConnect" })
          : undefined,
      kind: kind,
      host: host,
      port: port,
      username: username,
      sshAuthMethod: sshAuthMethod,
      assetInstallMode: assetInstallMode,
      password: password,
      privateKeyPath: privateKeyPath,
      privateKeyPassphrase: privateKeyPassphrase,
      wslDistro: wslDistro,
      wslUser: wslUser,
      wslDistros: wslDistros,
      dockerContainer: dockerContainer,
      manualDockerContainer: manualDockerContainer,
      serverUrl: serverUrl,
      serverName: serverName,
      serverToken: serverToken,
      serverWorkspacePath: serverWorkspacePath,
      dockerContainers: dockerContainers,
      dockerAvailable: dockerAvailable,
      sshConfigAliases: sshConfigAliases,
      sshConfigAliasesLoading: sshConfigAliasesLoading,
      sshConfigAliasesError: sshConfigAliasesError,
      selectedSshConfigAlias: selectedSshConfigAlias,
      currentRuntimeOptionsLoading: currentRuntimeOptionsLoading,
      currentRuntimeOptionsError: currentRuntimeOptionsError,
      remoteWorkspaceSessions: remoteWorkspaceSessions,
      // 错误由当前字段值实时计算，字段改为有效即消失；唯一规则来源为 collectRemoteFormFieldErrors。
      // validationAttempt 是"是否曾经提交过"的开关：没提交过就不该一打开表单就满屏红字。
      fieldErrors: validationAttempt > 0 ? collectRemoteFormFieldErrors(intl, formSnapshot) : [],
      validationAttempt,
      focusCredentials: focusCredentials,
      loading: loading,
      // 表单页返回：新增设备没有"上一页"（列表里没有它），直接关闭；
      // 其余情况回到设备选择页并清掉错误，保留用户的表单草稿（preserveDraftOnOpen）。
      onBack: () => {
        if (addingDevice) {
          void handleCloseRequest();
          return;
        }
        resetFeedback();
        setCurrentStep("device");
      },
      onHostChange: setHost,
      onPortChange: setPort,
      onUsernameChange: setUsername,
      onSshAuthMethodChange: setSshAuthMethod,
      onAssetInstallModeChange: setAssetInstallMode,
      onPasswordChange: setPassword,
      onPrivateKeyPathChange: setPrivateKeyPath,
      onPrivateKeyPassphraseChange: setPrivateKeyPassphrase,
      onWslDistroChange: setWslDistro,
      onWslUserChange: setWslUser,
      onDockerContainerChange: setDockerContainer,
      onManualDockerContainerChange: setManualDockerContainer,
      onServerUrlChange: setServerUrl,
      onServerNameChange: setServerName,
      onServerTokenChange: setServerToken,
      onServerWorkspacePathChange: setServerWorkspacePath,
      onDockerContainersRefresh: refreshDockerContainers,
      onApplySshConfigAlias: applySshConfigAlias,
      onClearSelectedSshConfigAlias: clearSelectedSshConfigAlias,
      onConnect: () => {
        void handleConnect();
      },
    } satisfies ComponentProps<typeof RemoteConnectionSettingsStep>,
    // 连接页：所有字段都是"当前连接的可观测事实"，不在这里做二次推导。
    // cancelled / error / errorCode / rawError 分开传，是因为页面要区分
    // "用户取消"（中性）与"连接失败"（红色），以及失败时的结构化分类与原始文本。
    connectingStep: {
      backToDevicesLabel: addingDevice
        ? intl.formatMessage({ id: "settings.source.newConnection" })
        : undefined,
      // 连接页的关闭也走 handleCloseRequest：此处不直接 applyOpenState(false)，
      // 因为"连接已建立但还没进目录"时必须先回收 attachment，
      // 直接关 UI 会让 session 变成无主对象（只能靠超时清理）。
      onClose: () => {
        void handleCloseRequest();
      },
      onBackToDevices: () => {
        // keepOpen：用户要回到设备列表，而不是关掉整个弹窗。
        // closeDialog 会清空流程状态并撤销 epoch，等价于"放弃本次连接"。
        closeDialog({ keepOpen: true });
        // 返回列表不是重开同一外部入口，不能立即再次消费仍在 props 中的偏好。
        // 这里把当前偏好标记为"已消费"，是为了避免重渲染时 effect 立刻又把它应用一遍，
        // 表现为"点了返回却又自动跳回连接页"。
        consumedKindPreferenceRef.current = preferredKind
          ? `${preferredKind}:${preferredWslDistro ?? ""}`
          : null;
        consumedPreferredSourceServerIdRef.current = preferredSourceServerId ?? null;
        consumedPreferredProfileIdRef.current = preferredProfileId ?? null;
        consumedPreferredTargetRef.current = preferredTarget ?? null;
        onProjectIntentCleared?.();
      },
      forceUpdate: pendingForceUpdate
        ? {
            ...pendingForceUpdate,
            onConfirm: () => settleForceUpdate(true),
            onCancel: handleCancelConnection,
          }
        : undefined,
      // 内联凭据框：passphrase 与 password 共用一个输入位，但写回不同字段。
      // 判断依据是"target 是否带私钥路径"——带私钥说明缺的是 passphrase，
      // 否则缺的是登录密码。用同一个校验（value 非空）避免两条分支各写一套。
      credentials: needsCredentials
        ? {
            passphrase: passphraseRequired,
            value: passphraseRequired ? privateKeyPassphrase : password,
            onChange: passphraseRequired ? setPrivateKeyPassphrase : setPassword,
            onSubmit: () => {
              if (pendingRemoteTarget?.kind !== "ssh") return;
              const value = passphraseRequired ? privateKeyPassphrase : password;
              if (!value) return;
              const target = {
                ...pendingRemoteTarget,
                ...(passphraseRequired ? { privateKeyPassphrase: value } : { password: value }),
              };
              // 带上原意图重连：补完凭据后用户仍然期望直接进到原定目录，
              // 而不是重新走一遍选择流程。
              const intent = pendingCompletionIntentRef.current;
              setAliasCredentialsPending(false);
              void startRemoteConnection(
                target,
                false,
                intent.preferredDirectoryPath,
                intent.options,
              );
            },
          }
        : undefined,
      onMinimize: () => {
        minimizedRef.current = true;
        applyOpenState(false);
      },
      kind: kind,
      logs: visibleConnectionLogs,
      errorMessage: error,
      errorCode: errorCode,
      rawError: rawError,
      upgradeTarget: sourceManagementSnapshot?.states.find(
        (state) =>
          state.profileId === upgradeProfileId ||
          sourceManagementSnapshot.profiles.some(
            (profile) =>
              profile.profileId === state.profileId &&
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          ),
      )?.upgradeTarget,
      cancelled: cancelled,
      onCancelConnection: handleCancelConnection,
      loading: loading || upgradeLoading,
      upgradeRequired: Boolean(upgradeProfileId),
      // 强制更新确认框打开时不再显示升级 loading：两者是"等待用户"与"等待机器"，
      // 同时显示会让用户以为升级已经在跑，从而不去处理那个确认框。
      upgradeLoading: upgradeLoading && !pendingForceUpdate,
      onUpgrade: () => {
        void handleUpgradeRequiredServer();
      },
      // "已就绪"必须同时满足"有 session"与"无错误"：连接成功后若错误仍在（例如目录预检失败），
      // 直接放用户进目录页会让他以为一切正常。onContinueToDirectory 是纯视图切换，
      // 不做任何 IO，所以不需要代际校验。
      connectionReady: Boolean(connectedSessionId) && !error,
      onContinueToDirectory: () => setCurrentStep("directory"),
      target: pendingRemoteTarget,
      recognizedDeviceName: recognizedDeviceName,
      profileName: activeProfileName,
      recognizedDeviceMeta: recognizedServer ? formatDeviceCardMeta(recognizedServer) : undefined,
      localVersion: ZCODE_VERSION,
      // "改从远端下载资源包"：只对 SSH 目标有意义（远端自己有网络，可以从源站取）。
      // 这里不改资产安装模式以外的任何字段，并保留原意图重连，
      // 因为用户只是换下载方式，不是换目标。
      onUseRemoteDownload:
        pendingRemoteTarget?.kind === "ssh"
          ? () => {
              const target = {
                ...pendingRemoteTarget,
                assetInstallMode: "remote-download" as const,
              };
              const intent = pendingCompletionIntentRef.current;
              updatePendingRemoteTarget(target);
              void startRemoteConnection(
                target,
                false,
                intent.preferredDirectoryPath,
                intent.options,
              );
            }
          : undefined,
      // 安装确认：preview 来自当前 Source 状态（可能还没刷新到，故用可选链）。
      // onConfirm 加代际校验：确认框是"可停留 UI"，用户可能在连接已作废后才点确认；
      // 没有这道校验就会用旧的 target 直接发起一次新连接。
      installConfirmation: pendingInstallConfirmation
        ? {
            target: pendingInstallConfirmation,
            preview: currentConnectionState?.installPreview,
            onConfirm: () => {
              if (entryEpochRef.current !== directoryEpoch) return;
              handleConfirmInstall();
            },
            onCancel: handleCancelInstall,
          }
        : undefined,
      // "返回修改"：放弃当前连接并回到表单。它比"取消"多做两件事——
      // 保留 errorCode==="credentials-required" 的焦点态（让用户直接落在密码框），
      // 并且只回到 settings 而不是关闭弹窗。
      // 同样先 withConfirmedDiscard（已连接 / 正在连接时需要用户确认）。
      onBack: () => {
        void withConfirmedDiscard(async () => {
          cancelActiveTrace();
          const epoch = ++entryEpochRef.current;
          setBlockedCompletion(null);
          setCompletionRunning(false);
          const sessionId = connectedSessionIdRef.current;
          if (sessionId && ownsConnectedSessionRef.current) void handleCancelSession(sessionId);
          setConnectedSessionId(null);
          // 必须先清 activeRequestIdRef 再取消请求：取消 RPC 可能同步触发回调，
          // 若 ref 仍指向旧请求，回调会认为"我还是当前请求"并写回错误。
          activeRequestIdRef.current = null;
          if (loading) {
            await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
            // 取消是 await，过期后直接返回，避免清掉新流程的 loading。
            if (entryEpochRef.current !== epoch) return;
            setLoading(false);
          }
          setFocusCredentials(errorCode === "credentials-required");
          setPendingInstallConfirmation(null);
          resetFeedback();
          updateConnectingRequestId(null);
          setCurrentStep("settings");
        });
      },
      // 重试：两条路径。
      //   普通失败 → 直接用同一 target 重连（不重新读表单，避免用户改了表单却没提交）；
      //   identity-change-pending → 需要先确认设备身份变更（指纹变化），
      //     确认成功后才有资格继续连接。这个分支放在这里而不是让用户"先点别处确认"，
      //     是因为身份变更确认是一次性的安全动作，与重试是同一意图。
      onRetry: () => {
        if (errorCode !== "source-server-identity-change-pending") {
          handleStartPendingRemoteConnection();
          return;
        }
        const profileId =
          preferredProfileId ??
          sourceManagementSnapshot?.profiles.find(
            (profile) =>
              pendingRemoteTarget &&
              pendingRemoteTarget.kind !== "server" &&
              profileMatchesRemoteTarget(profile, pendingRemoteTarget),
          )?.profileId;
        if (!profileId || !sourceManagement) return;
        const epoch = entryEpochRef.current;
        // 复用 upgradeLoading 作为"确认身份变更中"的忙碌态：两者都是"正在对 Source
        // 做一次受保护的写操作"，共用同一个 UI 反馈位可以避免再加一个状态。
        void (async () => {
          if (entryEpochRef.current !== epoch) return;
          setUpgradeLoading(true);
          try {
            const snapshot = await sourceManagement.confirmIdentityChange(profileId);
            if (entryEpochRef.current !== epoch) return;
            applySourceManagementSnapshot(snapshot);
            setUpgradeLoading(false);
            handleStartPendingRemoteConnection();
          } catch (cause) {
            if (entryEpochRef.current === epoch) setError(getErrorMessage(cause));
          } finally {
            if (entryEpochRef.current === epoch) setUpgradeLoading(false);
          }
        })();
      },
    } satisfies ComponentProps<typeof RemoteConnectionConnectingStep>,
    // 目录页把本地与远端的 service 成对传入同步弹窗：
    // 左侧（local*）来自 baseServices，右侧（remote*）来自当前 session 的 services。
    // 任一右侧缺失都传 null，让同步弹窗自行降级——绝不能用本地 service 顶替，
    // 那会把"同步到远端"变成"同步到自己"。
    directoryStep: {
      directoryPath,
      onDirectoryPathChange: (path) => {
        if (entryEpochRef.current === directoryEpoch) setDirectoryPath(path);
      },
      services: directoryBrowserServices,
      remoteTarget: pendingRemoteTarget,
      localSkillSyncService: baseServices.skillSyncService,
      remoteSkillSyncService: directoryBrowserServices?.skillSyncService ?? null,
      localMcpSyncService: baseServices.mcpSyncService,
      remoteMcpSyncService: directoryBrowserServices?.mcpSyncService ?? null,
      localPluginSyncService: baseServices.pluginSyncService,
      remotePluginSyncService: directoryBrowserServices?.pluginSyncService ?? null,
      localZCodeAgentService: baseServices.zcodeAgentService,
      remoteZCodeAgentService: directoryBrowserServices?.zcodeAgentService ?? null,
      localWorkspacePath: localWorkspacePath,
      // selecting 用 state 而非 ref：这里要驱动按钮的禁用与文案。
      // onSelect 内部还有一次 ref 防重（见 handleSelectDirectory），两层各管一件事。
      selecting: selectingDirectory,
      onSelect: (path) => {
        void handleSelectDirectory(path);
      },
      onBack: () => {
        void withConfirmedDiscard(handleBackToConnection);
      },
      onCancel: () => {
        void handleCloseRequest();
      },
      // "稍后选择"：只释放未绑定项目的临时 attachment，Host 的设备连接独立保留。
      // 必须判 selectingDirectoryRef：提交目录的过程中关闭弹窗，会在 realpath 尚未结束时
      // 把 session 拿走，导致 onSelectProject 拿着已释放的 session 继续执行。
      onChooseLater: () => {
        // 只释放未绑定项目的临时 attachment；Host 的设备连接独立保留。
        if (!selectingDirectoryRef.current) closeDialog();
      },
      onSkillsSynced: async () => undefined,
      onMcpSynced: async () => undefined,
      onPluginsSynced: async () => undefined,
      deviceName: recognizedDeviceName,
      profileName: activeProfileName,
      deviceVersion: recognizedServer?.lastSeenVersion,
      // 重命名设备：只有"已经识别出 Source"才允许（否则不知道该改谁）。
      // 名称是本地显示名，不改远端主机名，因此不需要重连；但写回前仍要校验 epoch，
      // 因为 rename 是一次网络/磁盘写，期间用户可能已经离开这个目录页。
      onRenameDevice:
        recognizedSourceServerId && sourceManagement
          ? async (name) => {
              const snapshot = await sourceManagement.renameSource(recognizedSourceServerId, name);
              if (entryEpochRef.current !== directoryEpoch) return;
              applySourceManagementSnapshot(snapshot);
              setRecognizedDeviceName(name);
            }
          : undefined,
      // 两组快速入口分开传（不合并排序）：历史目录会让本地工作区映射跟着恢复，
      // 远端声明目录则只做远端选择，行为不同，UI 需要分组展示才能表达差异。
      quickOpenPaths: quickOpenDirectoryData.paths,
      quickOpenEntries: quickOpenDirectoryData.entries,
    } satisfies ComponentProps<typeof RemoteConnectionDirectoryStep>,
  };
}
