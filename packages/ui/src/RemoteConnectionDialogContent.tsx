// ============================================================================
// RemoteConnectionDialogContent —— 远程连接向导的步骤内容与共享逻辑
//
// 职责边界：
// 对外暴露的三个函数由 `useRemoteBoundaryAcknowledgement`、`getRecentRemoteWorkspaceHistory` 与 `formatDeviceCardMeta` 承担，其余是两步表单 UI。
//   表单与目录浏览 UI。只读 props 与回调，不持有连接状态、不发起 Host 连接。
// 连接生命周期与凭据校验由 `useRemoteConnectionForm` 承担，同步实现留在 `RemoteSyncActions` 里。
//
// 不变量（INV）：
//   INV-01 介绍状态读取/保存失败不得伪装成连接失败｜useRemoteBoundaryAcknowledgement 的 catch｜改错会让用户以为远程不可用
//   INV-02 全局确认框被占用时必须走 onBlocked 并返回 false｜pendingRequest 分支｜改错会把并发占用误当用户取消
//   INV-03 已确认版本为 1 时直接放行｜version === 1 短路｜改错会重复弹介绍
//   INV-04 每次 await 之后必须复核 isCurrent｜isCurrent 调用点｜改错会把过期结果写进已卸载流程
//   INV-05 版本持久化必须同时更新设置与广播｜persistVersion｜改错会让其它窗口仍看到未读
//   INV-06 最近目录必须按 lastOpenedAt 倒序｜getRecentRemoteWorkspaceHistory 的 sort｜改错会把最旧目录当成最近
//   INV-07 最近目录必须过滤隐藏目录｜basename startsWith 判断｜改错会让 .zcode 挤占展示位
//   INV-08 最近目录必须排除已绑定会话目录｜remoteConversationWorkspaceBySourceServerId 判断｜改错会重复展示同一目录
//   INV-09 设备摘要只展示用户可读信息｜formatDeviceCardMeta｜改错会暴露设备标识
//   INV-10 类型切换只在设置入口出现｜addingDevice 计算｜改错会让聊天入口出现切换器
//   INV-11 校验失败后焦点必须落到首个错误字段｜validationAttempt effect｜改错会让用户找不到错误
//   INV-12 表单提交必须 preventDefault｜onSubmit 回调｜改错会触发页面刷新并丢失草稿
//   INV-13 services 未就绪时必须显示 loading 而非空白｜!services 分支｜改错会让目录步白屏
//   INV-14 目录选择按钮需同时满足路径、ready、未选择中｜disabled 组合｜改错会提交未就绪目录
//   INV-15 重命名保存必须防重入｜renameStatus === saving 判断｜改错会并发提交同一名称
//   INV-16 重命名失败必须回到 failed 态｜saveName 的 catch｜改错会一直停在 saving
//   INV-17 设备名草稿必须随 props 同步｜deviceName effect｜改错会展示上一个设备的名称
//   INV-18 同步入口可见性统一由 shouldShowRemoteSyncActions 决定｜canShowRemoteSyncActions｜改错会出现无 Host 的同步入口
//   INV-19 MCP 同步必须先选择路径｜mcpDisabled 的 trim 判断｜改错会把空路径同步到远端
//   INV-20 快速打开分组必须保留两个来源｜quickOpenGroups｜改错会丢失最近目录或远端记录
//   INV-21 目录导航与选中必须分离｜navigationRevision 与 selectedPath｜改错会让点击行直接打开目录
//   INV-22 本文件只新增注释，不改变任何运行时行为｜全文件｜违反即破坏注释工程只增不改约束
// ============================================================================
/* eslint-disable max-lines -- 远程连接向导的多个步骤暂集中在同一文件，避免拆分时扩大 SSH/Docker/WSL 回归面。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  DockerContainerInfo,
  RemoteAssetInstallMode,
  RemoteTarget,
  RemoteWorkspaceSessionEntry,
  SourceServerWorkspaceHistoryEntry,
  SSHConfigAliasOption,
  WSLDistro,
} from "@zcode/shared";
import type {
  IMcpSyncService,
  IPluginSyncService,
  IServiceAccessor,
  ISkillSyncService,
  IZCodeAgentService,
} from "@zcode/services";
import { TID_SSH_CONFIG_IMPORT } from "@zcode/shared/test-ids";
import {
  AlertTriangleIcon,
  ArrowLeftIcon,
  CheckIcon,
  ChevronDownIcon,
  FileCodeIcon,
  FolderIcon,
  LoaderIcon,
} from "lucide-react";
import { DirectoryBrowser } from "@/DirectoryBrowser.js";
import {
  RemoteConnectionFields,
  RemoteSegmentedControl,
  SshConfigAliasPicker,
} from "@/RemoteConnectionFields.js";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import type { RemoteFormFieldError } from "@/lib/remoteConnectionWizard.js";
import { REMOTE_KIND_PRESENTATION } from "@/remote-connection/RemoteConnectionTags.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useConfirmDialogStore } from "@/store/confirmDialogStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { ensureSourceServerBoundaryAcknowledged } from "@/lib/sourceServerBoundaryOnboarding.js";
import { logger } from "@/logger.js";
import { type AppSettingsConversationWorkspaceMap } from "@/remote/remoteWorkspaceProjection.js";
import {
  RemoteSyncDialogs,
  RemoteSyncDropdownButton,
  shouldShowRemoteSyncActions,
} from "@/settings/RemoteSyncActions.js";
export { RemoteConnectionConnectingStep } from "@/remote-connection/RemoteConnectionConnectingStep.js";

/** 旧字段包含展示即已读，且扩到 3 会破坏回滚；只在有效确认后写新介绍标记。 */
// [契约] 该 hook 只负责介绍确认，不参与任何连接建立或凭据校验。
// 返回函数接收 isCurrent 以便在异步边界后判断调用方是否仍然有效。
// onBlocked 用于告知调用方：确认框被其它请求占用，本次不是用户取消。
// 所有失败都收敛为返回 isCurrent，绝不向调用方抛错。
// 依赖数组包含 settingService/syncAppSettings/confirm/intl，任一变化都会重建回调。
export function useRemoteBoundaryAcknowledgement() {
  // [契约] 设置服务是可选的：远端/预览环境可能没有 base workspace 服务。
  // 缺失时 hook 退化为直接放行，不阻塞连接流程。
  // 不要在这里构造第二个服务实例，依赖必须由 Provider 注入。
  const settingService = useOptionalBaseWorkspaceServices()?.settingService;
  // [契约] 广播同步是可选的，Web 端可能没有跨窗口设置同步能力。
  // 只有本地持久化成功后才调用广播，避免其它窗口先于本窗口看到新版本。
  // 广播失败不回滚本地设置，版本已确认的事实优先。
  const syncAppSettings = useOptionalPlatform()?.syncAppSettings;
  // [契约] 介绍弹窗复用全局确认框，不新建独立 Dialog。
  // 全局框同一时刻只能有一个请求，占用判断必须走 store 而非本地状态。
  // confirm 的稳定引用由 hook 内部保证，这里不额外包一层。
  const confirm = useConfirmDialog();
  const { intl } = useZCodeIntl();
  return useCallback(
    async (isCurrent: () => boolean, onBlocked?: () => void): Promise<boolean> => {
      // [失败路径] 没有设置服务时视为环境不支持，直接按当前有效性放行。
      // 不能返回 true 常量：调用方可能已卸载，需要 isCurrent 的真实结果。
      // 该分支不写任何持久化，也不会弹窗。
      if (!settingService) return isCurrent();
      try {
        // [并发] 读取设置后必须先复核 isCurrent，await 期间调用方可能已卸载。
        // 读取失败进入外层 catch，统一记录 warn 并放行。
        // 不要缓存 settings 到模块级变量，每个窗口的设置版本可能不同。
        const settings = await settingService.get();
        // [失败路径] 调用方已失效时返回 false，表示本次确认没有完成。
        // 返回 false 而不是抛错，避免卸载路径产生未处理拒绝。
        // 该判断必须在任何写入或弹窗前执行。
        if (!isCurrent()) return false;
        // [契约] 版本 1 表示已确认，后续扩到 2 会改变本分支语义。
        // 旧字段包含展示即已读，不能因为展示次数增加而重复弹窗。
        // `remoteBoundaryIntroAcknowledgedVersion === 1` 的短路放在 `pendingRequest` 判断之前，已读用户不会再弹窗。
        if (settings.remoteBoundaryIntroAcknowledgedVersion === 1) return true;
        // 全局确认框拒绝并发请求；完成动作由调用方保留，不能把占用误当用户取消。
        // `useConfirmDialogStore` 同一时刻只持有 `pendingRequest` 一个请求，第二个请求必须走 onBlocked。
        // 被占用时调用 onBlocked 并返回 false，明确告知调用方是「占用」而非「取消」。
        // 占用不能自动排队：介绍确认依赖用户主动发起的连接动作。
        // 读取 store 快照而不是 hook 值，避免订阅导致本 hook 额外重渲染。
        // 该分支不写入版本，未读状态保持，下一次操作可重试。
        if (useConfirmDialogStore.getState().pendingRequest) {
          onBlocked?.();
          return false;
        }
        // [事务] 确认、持久化与广播由共享工具统一编排，hook 只提供回调。
        // targetVersion 固定为 1，与上面的已读短路保持一致。
        // currentVersion 透传服务端值，工具内部据此决定是否需要弹窗。
        // isCurrent 原样透传，保证工具在弹窗前后都能判断有效性。
        // 返回值直接作为 hook 结果，不做二次解释。
        return await ensureSourceServerBoundaryAcknowledged({
          currentVersion: settings.remoteBoundaryIntroAcknowledgedVersion,
          targetVersion: 1,
          isCurrent,
          requestAcknowledgement: () =>
            confirm({
              intent: "source-server-boundary",
              presentation: "source-server-boundary",
              title: intl.formatMessage({ id: "remote.sourceServerBoundaryTitle" }),
              description: intl.formatMessage({ id: "remote.sourceServerBoundaryDescription" }),
              confirmLabel: intl.formatMessage({ id: "common.gotIt" }),
              requiredAcknowledgement: true,
              showKeyboardHints: false,
            }),
          // [事务] 先写本地设置，成功后广播；广播失败不影响已持久化的事实。
          // patch 使用 satisfies 约束字段名，防止拼写错误静默通过。
          // 只写版本字段，不整份覆盖 settings，避免抹掉并发修改。
          // 该方法可能被工具重复调用，写入必须幂等。
          // 不要把广播放进 settingService.update 内部，二者职责不同。
          persistVersion: async (version) => {
            const patch = {
              remoteBoundaryIntroAcknowledgedVersion: version,
            } satisfies Partial<AppSettings>;
            // [失败路径] 本地写入失败会抛到外层 catch，版本保持未读。
            // 失败后本次连接流程仍按 isCurrent 放行，不阻断用户操作。
            // 写入是单字段 patch，不需要先读后写。
            await settingService.update(patch);
            // [并发] 广播在本地写入之后调用，保证本窗口是最新版本。
            // `syncAppSettings` 来自可选平台能力，缺失时用 `?.` 静默跳过广播。
            // 广播不 await，避免跨窗口 IPC 阻塞确认流程。
            syncAppSettings?.(patch);
          },
        });
      } catch (cause) {
        // 说明的读取/保存失败不能伪装成远程连接失败；保持未读，下一次主动使用重试。
        logger.warn("[RemoteBoundaryAcknowledgement] 读取或保存远程介绍状态失败", cause);
        // [失败路径] 异常时既不放行确认也不算已读，交由调用方按有效性决定。
        // 返回 isCurrent 而非 true，避免在卸载后继续推进连接。
        // 该路径必须记录 warn，便于区分「未读」与「读取失败」。
        return isCurrent();
      }
    },
    [settingService, syncAppSettings, confirm, intl],
  );
}

// [契约] basename 同时兼容 Windows 反斜杠与 POSIX 正斜杠。
// `getPathBasename` 用 `.filter(Boolean)` 丢弃尾部分隔符产生的空段，否则 `at(-1)` 会返回空串。
// 全部分隔符时回落到原路径，保证不会返回 undefined。
function getPathBasename(workspacePath: string): string {
  return workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspacePath;
}

// `getRecentRemoteWorkspaceHistory` 每次从 `history` 派生结果，不缓存第二份最近目录状态。
// 先过滤再排序：过滤隐藏目录与已绑定会话，排序只按最后打开时间。
// 返回新数组，调用方可以安全排序或截断，不影响入参。
// 过滤条件与排序键必须一致地作用于同一条目，避免展示与排序错位。
// `getRecentRemoteWorkspaceHistory` 不读外部状态，单测可直接传入 `history` 与 `remoteConversationWorkspaceBySourceServerId`。
export function getRecentRemoteWorkspaceHistory(
  history: readonly SourceServerWorkspaceHistoryEntry[],
  remoteConversationWorkspaceBySourceServerId?: AppSettingsConversationWorkspaceMap,
): SourceServerWorkspaceHistoryEntry[] {
  // Bug 原因：Directory 记录按追加顺序保存，直接 slice(0, 3) 会把最旧目录当成最近目录；
  // 且未过滤隐藏目录，`.zcode` 之类内部路径会挤占「最近目录」位（原型 L996-999 只展示常规工作区）。
  // [契约] 复制后再链式过滤与排序，保持入参不可变。
  // 顺序敏感：过滤在排序前，排序结果才是最终展示顺序。
  // 本函数不做 `slice`，展示条数由调用方决定，写死会让单测断言失效。
  return [...history]
    .filter(
      (entry) =>
        !getPathBasename(entry.workspacePath).startsWith(".") &&
        remoteConversationWorkspaceBySourceServerId?.[entry.sourceServerId ?? ""]?.workspacePath !==
          entry.workspacePath,
    )
    // [契约] lastOpenedAt 是唯一排序键，倒序即最近优先。
    // 历史记录本身按追加顺序保存，直接取前 N 条会得到最旧目录。
    // `.sort` 只比 `right.lastOpenedAt - left.lastOpenedAt`，改成比 `workspacePath` 会丢掉时间语义。
    .sort((left, right) => right.lastOpenedAt - left.lastOpenedAt);
}

/** 设备摘要只显示用户可读信息，设备标识留在设置详情中。 */
// [契约] 设备摘要只拼接 osUser 与版本号，不暴露设备标识。
// `formatDeviceCardMeta` 用 `.filter(Boolean)` 去掉空的 `osUser` 与 `lastSeenVersion`，否则 join 后会出现多余分隔符。
// `server.lastSeenVersion` 只在拼接时补 `v` 前缀，原始字段不带前缀。
export function formatDeviceCardMeta(server: {
  sourceServerId: string;
  osUser?: string;
  lastSeenVersion?: string;
}): string {
  return [server.osUser, server.lastSeenVersion ? `v${server.lastSeenVersion}` : null]
    .filter(Boolean)
    .join(" · ");
}

// [契约] 设置步骤是受控组件：所有字段值来自 props，变更通过回调上抛。
// kind 决定展示哪些字段；availableKinds 与 onKindChange 决定是否允许切换类型。
// fieldErrors 由提交失败产生，仅用于展示，不在此处修正输入。
// loading 期间主操作禁用，但字段仍可编辑以保留用户输入。
// 该组件不直接调用连接服务，连接由 onConnect 交给上层。
export function RemoteConnectionSettingsStep({
  focusCredentials,
  kind,
  availableKinds,
  onKindChange,
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  wslDistro,
  wslUser = "",
  wslDistros,
  dockerContainer,
  manualDockerContainer,
  serverUrl,
  serverName,
  serverToken,
  serverWorkspacePath,
  dockerContainers,
  dockerAvailable,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  currentRuntimeOptionsLoading,
  currentRuntimeOptionsError,
  remoteWorkspaceSessions = [],
  fieldErrors = [],
  validationAttempt = 0,
  connectLabel,
  loading,
  onBack,
  onHostChange,
  onPortChange,
  onUsernameChange,
  onSshAuthMethodChange,
  onAssetInstallModeChange,
  onPasswordChange,
  onPrivateKeyPathChange,
  onPrivateKeyPassphraseChange,
  onWslDistroChange,
  onWslUserChange,
  onDockerContainerChange,
  onManualDockerContainerChange,
  onServerUrlChange,
  onServerNameChange,
  onServerTokenChange,
  onServerWorkspacePathChange,
  onDockerContainersRefresh,
  onApplySshConfigAlias,
  onClearSelectedSshConfigAlias,
  onConnect,
}: {
  // [契约] 为真时打开即聚焦凭据区域，跳过 Host 输入。
  // `focusCredentials` 只决定首屏是否聚焦凭据区，不参与 `fieldErrors` 校验。
  focusCredentials?: boolean;
  kind: RemoteTarget["kind"];
  // [契约] 只包含允许切换的类型，顺序即分段控件顺序。
  // `availableKinds` 为空时 `RemoteSegmentedControl` 不渲染，项目/聊天入口保持固定 `kind`。
  // 调用方必须同时提供 onKindChange，二者成对使用。
  availableKinds?: RemoteTarget["kind"][];
  onKindChange?: (kind: RemoteTarget["kind"]) => void;
  host: string;
  port: string;
  username: string;
  // `sshAuthMethod` 决定 `password` 与 `privateKeyPath` 两组字段谁可见，密码与私钥互斥。
  // `onSshAuthMethodChange` 不清空 `password` 或 `privateKeyPath`，切回来还能看到上次输入。
  // `fieldErrors` 只对 `sshAuthMethod` 当前方式的必填项产生，隐藏字段不参与校验。
  // 该值是受控 props，组件内不维护第二份鉴权状态。
  sshAuthMethod: SSHAuthMethod;
  // `assetInstallMode` 只改远端环境准备步骤，不进入 `host` 与 `port` 等连接参数。
  // 方式切换会触发远端能力检查，错误通过 currentRuntimeOptionsError 回传。
  // 该值属于提交载荷的一部分，不能只在 UI 层保存。
  // `assetInstallMode` 的缺省值由上层传入，组件不推断默认值。
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  wslDistro: string;
  // [契约] WSL 用户可选，留空表示使用发行版默认用户。
  // 该字段只在 kind 为 wsl 时参与展示与校验。
  // 空字符串与 undefined 在上层统一归一，组件不做额外转换。
  // `onWslDistroChange` 只改 `wslDistro`；`wslUser` 不能跟着清空，切回原发行版仍需保留已填用户。
  wslUser?: string;
  wslDistros: WSLDistro[];
  dockerContainer: string;
  manualDockerContainer: string;
  serverUrl: string;
  serverName: string;
  serverToken: string;
  serverWorkspacePath: string;
  dockerContainers: DockerContainerInfo[];
  // `dockerAvailable` 的 null 表示未探测，true/false 由探测结果给出，不能合并成布尔值。
  // 未探测与不可用的展示与禁用策略不同，不能合并成布尔值。
  // 探测失败不等于连接失败，只影响容器选择入口。
  // `dockerAvailable` 由 `onDockerContainersRefresh` 的上层回调更新，组件不自行探测。
  dockerAvailable: boolean | null;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  currentRuntimeOptionsLoading: boolean;
  // [契约] runtime 选项加载失败只提示，不阻断手动填写。
  // `currentRuntimeOptionsError` 展示在字段区域顶部，与 `fieldErrors` 的提交校验错误分开。
  // 空字符串表示无错误，不使用 null 以避免展示层重复判空。
  // `currentRuntimeOptionsError` 不清空 `host` 与 `port` 等已填参数，用户仍可手动提交。
  currentRuntimeOptionsError: string;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  /** 提交失败后的字段错误；为空表示尚未提交或已全部修正。 */
  // [契约] 字段错误由提交校验产生，空数组表示尚未提交或已全部修正。
  // `fieldErrors` 按 `field` 匹配到 `RemoteConnectionFields` 的字段，组件不重算校验。
  // 每次提交失败可能整体替换，组件按最新数组渲染。
  fieldErrors?: RemoteFormFieldError[];
  /** 每次提交校验失败递增，用于把焦点移到第一个出错字段。 */
  // [契约] 每次校验失败递增，作为把焦点移到首个错误字段的触发器。
  // 值为 0 表示从未提交，此时不抢焦点。
  // `validationAttempt` 的递增由上层负责，`useEffect` 只读它决定是否移焦点。
  validationAttempt?: number;
  connectLabel?: string;
  // [契约] loading 期间主操作与类型切换禁用，字段编辑保留。
  // 该标记不控制 loading 文案的展示位置，文案由步骤内部决定。
  // `loading` 与 `fieldErrors` 可同时为真，主按钮先按 `loading` 展示文案。
  loading: boolean;
  onBack: () => void;
  onHostChange: (value: string) => void;
  onPortChange: (value: string) => void;
  onUsernameChange: (value: string) => void;
  onSshAuthMethodChange: (value: SSHAuthMethod) => void;
  onAssetInstallModeChange: (value: RemoteAssetInstallMode) => void;
  onPasswordChange: (value: string) => void;
  onPrivateKeyPathChange: (value: string) => void;
  onPrivateKeyPassphraseChange: (value: string) => void;
  onWslDistroChange: (value: string) => void;
  onWslUserChange?: (value: string) => void;
  onDockerContainerChange: (value: string) => void;
  onManualDockerContainerChange: (value: string) => void;
  onServerUrlChange: (value: string) => void;
  onServerNameChange: (value: string) => void;
  onServerTokenChange: (value: string) => void;
  onServerWorkspacePathChange: (value: string) => void;
  onDockerContainersRefresh?: () => void;
  onApplySshConfigAlias: (value: SSHConfigAliasOption) => void;
  onClearSelectedSshConfigAlias: () => void;
  onConnect: () => void;
}) {
  const { intl } = useZCodeIntl();
  // [契约] formRef 只用于把焦点移到首个错误字段。
  // 不使用受控表单收集值，字段值全部由 props 驱动。
  // ref 在卸载后自动置空，查询前用可选链保护。
  const formRef = useRef<HTMLFormElement | null>(null);
  // 设置入口提供类型切换与「从 SSH config 导入」；项目/聊天入口由上一屏选好类型（RDUX-27）。
  // `addingDevice` 要求 `availableKinds` 与 `onKindChange` 同时存在，只有设置入口满足。
  // 项目/聊天入口的类型由上一屏确定，`addingDevice` 为假时 `RemoteSegmentedControl` 不出现。
  // `addingDevice` 同时控制 `RemoteSegmentedControl` 与底部按钮布局，改它会让两处错位。
  const addingDevice = Boolean(availableKinds && onKindChange);
  // [契约] 导入 SSH 配置后递增 token，驱动字段组件把焦点移到首个空 token。
  // token 只增不减，避免用布尔值造成重复触发失效。
  // `aliasFocusToken` 只驱动焦点，既不参与 `fieldErrors` 校验也不进入提交载荷。
  const [aliasFocusToken, setAliasFocusToken] = useState(0);

  // 校验失败后焦点移到第一个出错字段；DOM 顺序即页面顺序。
  useEffect(() => {
    // [契约] 首次渲染不抢焦点，只有提交校验失败后才移动。
    // 每次失败由上层递增 validationAttempt，effect 随之重跑。
    // 查询使用 aria-invalid 选择器，DOM 顺序即视觉顺序。
    if (validationAttempt === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [validationAttempt]);

  return (
    <form
      ref={formRef}
      className="flex min-h-0 flex-1 flex-col"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        onConnect();
      }}
    >
      <div
        data-testid="remote-connection-settings-scroll"
        // SSH 配置项增多时，表单内容以前没有自己的滚动边界，会继续绘制到下方按钮区域。
        // 这里把中间内容区限定为可滚动区域，让 footer 始终占据独立空间，不遮挡最后几项配置。
        className="flex-1 min-h-0 space-y-4 overflow-y-auto pr-1"
      >
        {addingDevice && availableKinds && onKindChange ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <RemoteSegmentedControl
              label={intl.formatMessage({ id: "remote.connectionType" })}
              value={kind}
              onChange={onKindChange}
              disabled={loading}
              options={availableKinds.map((connectionKind) => {
                const presentation =
                  connectionKind === "server"
                    ? undefined
                    : REMOTE_KIND_PRESENTATION[connectionKind];
                return {
                  value: connectionKind,
                  label: intl.formatMessage({ id: `remote.kind.${connectionKind}` }),
                  // 类型切换的每一项就是连接类型标签，允许使用类型色（DESIGN.md / RDUX-27）。
                  icon: presentation?.Icon,
                  selectedClassName: presentation?.selectedClassName,
                  testId: `remote-kind-${connectionKind}`,
                };
              })}
            />
            {kind === "ssh" ? (
              <SshConfigAliasPicker
                aliases={sshConfigAliases}
                selectedAlias={selectedSshConfigAlias}
                align="end"
                onApply={(option) => {
                  onApplySshConfigAlias(option);
                  setAliasFocusToken((token) => token + 1);
                }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  disabled={loading || sshConfigAliasesLoading || sshConfigAliases.length === 0}
                  data-testid={TID_SSH_CONFIG_IMPORT}
                  className="text-remote-foreground-muted hover:text-foreground"
                >
                  <FileCodeIcon />
                  {intl.formatMessage({
                    id: sshConfigAliasesLoading
                      ? "common.loading"
                      : sshConfigAliases.length === 0
                        ? "ssh.importEmpty"
                        : "ssh.importFromConfig",
                  })}
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </SshConfigAliasPicker>
            ) : null}
          </div>
        ) : null}
        {addingDevice && kind === "ssh" && sshConfigAliasesError ? (
          <div className="flex items-start gap-2 rounded-lg bg-warning-surface px-3 py-2 text-ui-sm text-warning-surface-foreground">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>{intl.formatMessage({ id: "ssh.configAliasLoadFailed" })}</span>
          </div>
        ) : null}
        {currentRuntimeOptionsError ? (
          <div className="flex items-start gap-3 rounded-md bg-warning-surface px-3 py-3 text-ui-base text-warning-surface-foreground">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{intl.formatMessage({ id: "remote.optionsLoadFailed" })}</span>
          </div>
        ) : null}

        <RemoteConnectionFields
          focusCredentials={focusCredentials}
          autoFocusHost={!focusCredentials}
          focusFirstEmptyToken={aliasFocusToken}
          sshConfigAliasMode="linked"
          fieldErrors={fieldErrors}
          runtimeOptionsError={currentRuntimeOptionsError}
          kind={kind}
          host={host}
          port={port}
          username={username}
          sshAuthMethod={sshAuthMethod}
          assetInstallMode={assetInstallMode}
          password={password}
          privateKeyPath={privateKeyPath}
          privateKeyPassphrase={privateKeyPassphrase}
          wslDistro={wslDistro}
          wslUser={wslUser}
          wslDistros={wslDistros}
          dockerContainer={dockerContainer}
          manualDockerContainer={manualDockerContainer}
          serverUrl={serverUrl}
          serverName={serverName}
          serverToken={serverToken}
          serverWorkspacePath={serverWorkspacePath}
          dockerContainers={dockerContainers}
          dockerAvailable={dockerAvailable}
          sshConfigAliases={sshConfigAliases}
          sshConfigAliasesLoading={sshConfigAliasesLoading}
          sshConfigAliasesError={sshConfigAliasesError}
          selectedSshConfigAlias={selectedSshConfigAlias}
          runtimeOptionsLoading={currentRuntimeOptionsLoading}
          remoteWorkspaceSessions={remoteWorkspaceSessions}
          applySshConfigAlias={onApplySshConfigAlias}
          clearSelectedSshConfigAlias={onClearSelectedSshConfigAlias}
          setHost={onHostChange}
          setPort={onPortChange}
          setUsername={onUsernameChange}
          setSshAuthMethod={onSshAuthMethodChange}
          setAssetInstallMode={onAssetInstallModeChange}
          setPassword={onPasswordChange}
          setPrivateKeyPath={onPrivateKeyPathChange}
          setPrivateKeyPassphrase={onPrivateKeyPassphraseChange}
          setWslDistro={onWslDistroChange}
          setWslUser={onWslUserChange}
          setDockerContainer={onDockerContainerChange}
          setManualDockerContainer={onManualDockerContainerChange}
          setServerUrl={onServerUrlChange}
          setServerName={onServerNameChange}
          setServerToken={onServerTokenChange}
          setServerWorkspacePath={onServerWorkspacePathChange}
          refreshDockerContainers={onDockerContainersRefresh}
        />
      </div>

      {/* 设置入口：取消与主操作右对齐；项目/聊天入口：左返回列表、右连接。只保留一条分隔线（RDUX-27）。 */}
      <div
        className={cn(
          "mt-5 flex items-center gap-2 border-t border-border pt-4",
          addingDevice ? "justify-end" : "justify-between",
        )}
      >
        {addingDevice ? (
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-4"
            onClick={onBack}
            disabled={loading}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            className="h-9 px-3 text-remote-foreground-muted"
            onClick={onBack}
            disabled={loading}
          >
            <ArrowLeftIcon className="size-4" />
            {intl.formatMessage({ id: "remote.selection.back" })}
          </Button>
        )}
        <Button type="submit" className="h-9 px-4" disabled={loading}>
          {loading ? (
            <>
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage({ id: "remote.connecting" })}
            </>
          ) : (
            (connectLabel ?? intl.formatMessage({ id: "remote.startConnection" }))
          )}
        </Button>
      </div>
    </form>
  );
}

// [契约] 目录步骤同样受控：路径可来自 props，也可由组件内部维护回退值。
// services 为 null 表示基础服务尚未就绪，只渲染 loading 与返回按钮。
// 选择动作必须等待目录加载完成（directoryReady）后才允许提交。
// 同步动作复用共享的 Dropdown 与 Dialog，不在此处实现同步细节。
// 该组件不持有连接状态，remoteTarget 只用于展示与能力判断。
export function RemoteConnectionDirectoryStep({
  directoryPath,
  onDirectoryPathChange,
  services,
  remoteTarget,
  localSkillSyncService,
  remoteSkillSyncService,
  localMcpSyncService,
  remoteMcpSyncService,
  localPluginSyncService,
  remotePluginSyncService,
  localZCodeAgentService,
  remoteZCodeAgentService,
  localWorkspacePath,
  selecting = false,
  onSelect,
  onBack,
  onCancel,
  onChooseLater,
  onSkillsSynced,
  onMcpSynced,
  onPluginsSynced,
  deviceName,
  profileName,
  deviceVersion,
  onRenameDevice,
  quickOpenPaths = [],
  quickOpenEntries = [],
}: {
  directoryPath?: string;
  onDirectoryPathChange?: (path: string) => void;
  services: IServiceAccessor | null;
  remoteTarget?: RemoteTarget | null;
  localSkillSyncService?: ISkillSyncService;
  remoteSkillSyncService?: ISkillSyncService | null;
  localMcpSyncService?: IMcpSyncService;
  remoteMcpSyncService?: IMcpSyncService | null;
  localPluginSyncService?: IPluginSyncService;
  remotePluginSyncService?: IPluginSyncService | null;
  localZCodeAgentService?: IZCodeAgentService;
  remoteZCodeAgentService?: IZCodeAgentService | null;
  localWorkspacePath?: string;
  selecting?: boolean;
  onSelect: (path: string) => void;
  onBack: () => void;
  onCancel: () => void;
  onChooseLater?: () => void;
  onSkillsSynced?: () => Promise<void> | void;
  onMcpSynced?: () => Promise<void> | void;
  onPluginsSynced?: () => Promise<void> | void;
  // `deviceName` 既是成功横幅的展示值，也是 `deviceNameDraft` 的初值。
  // 未提供时视为匿名设备，不展示名称行。
  // 该字段变化会同步覆盖重命名草稿。
  deviceName?: string;
  /** 线路名（原型成功横幅「线路 linux-arm64-dev」段）。 */
  // `profileName` 只在成功横幅出现，且仅当它不等于 `deviceName` 时才展示。
  // `profileName` 本身不带前缀，前缀由横幅展示层拼接。
  profileName?: string;
  /** 设备版本号，不带 v 前缀（原型成功横幅「v3.8.1」段）。 */
  // `deviceVersion` 存裸版本号，横幅展示时由拼接逻辑补 `v`。
  // `deviceVersion` 为 undefined 时横幅整段省略，不能留空的 `v` 分隔段。
  deviceVersion?: string;
  onRenameDevice?: (name: string) => Promise<void> | void;
  // `quickOpenPaths` 可为字符串或带 label 的对象，`.map` 后统一成 `{ path }` 形态。
  // 顺序即展示顺序，组件不重新排序。
  // `quickOpenPaths` 已在 `getRecentRemoteWorkspaceHistory` 里过滤排序，组件不再重排。
  quickOpenPaths?: Array<string | { path: string; label?: string }>;
  // `quickOpenGroups` 把 `quickOpenPaths` 与 `quickOpenEntries` 分成两组，不合并去重。
  // `quickOpenEntries` 为空时该组不渲染标题，避免出现空分组。
  // 条目必须包含 path，label 仅用于展示别名。
  quickOpenEntries?: Array<{ path: string; label?: string }>;
}) {
  const { intl } = useZCodeIntl();
  // [契约] 导航版本用于强制 DirectoryBrowser 重新按 initialPath 定位。
  // 点击快捷路径时同时重置 ready，防止用旧目录状态直接提交。
  // `navigationRevision` 只增不减，用相等比较驱动 `DirectoryBrowser` 重定位会失效。
  const [navigationRevision, setNavigationRevision] = useState(0);
  // [契约] ready 表示当前路径已完成一次加载，可以选择。
  // 路径变化或重新导航必须立刻置 false，避免提交不可访问目录。
  // 该状态由 DirectoryBrowser 的导航状态回调更新。
  const [directoryReady, setDirectoryReady] = useState(false);
  const [localPath, setLocalPath] = useState("");
  // [契约] 受控路径优先；未提供时用组件内部路径兜底。
  // 两种来源共享同一读取入口，后续所有逻辑只读 selectedPath。
  // 不要在两个分支里各写一套选择逻辑，否则受控与非受控行为会分叉。
  const selectedPath = directoryPath ?? localPath;
  // [契约] 写入同样按受控优先选择 setter。
  // 把 setter 抽象成一个变量，保证路径变更只有一个出口。
  // 受控模式下内部 state 不更新，避免出现两份真相。
  const setSelectedPath = onDirectoryPathChange ?? setLocalPath;
  const [renameStatus, setRenameStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [deviceNameDraft, setDeviceNameDraft] = useState(deviceName ?? "");
  // `remoteSkillSyncOpen` 等三个开关各自独立，一个弹窗打开不阻塞另外两个。
  // 打开前由 Dropdown 按钮判断能力是否可用。
  // 关闭 `remoteSkillSyncOpen` 只改本地布尔值，已完成的 `onSkillsSynced` 结果不回滚。
  const [remoteSkillSyncOpen, setRemoteSkillSyncOpen] = useState(false);
  // [契约] MCP 同步额外依赖已选路径，空路径时按钮禁用。
  // `remoteMcpSyncOpen` 不写设置，重新打开时弹窗从默认步骤开始。
  // `canSyncRemoteMcp` 与 `remoteMcpSyncOpen` 分离，禁用某类同步不必改开关状态。
  const [remoteMcpSyncOpen, setRemoteMcpSyncOpen] = useState(false);
  // [契约] 插件同步与技能/MCP 使用同一套可见性与能力判断。
  // 三类弹窗共用一个 Dropdown，避免在页面上堆叠多个入口。
  // 本地 workspace 路径单独传入，用于插件源的本地侧读取。
  const [remotePluginSyncOpen, setRemotePluginSyncOpen] = useState(false);
  useEffect(() => {
    setDeviceNameDraft(deviceName ?? "");
  }, [deviceName]);
  // `canShowRemoteSyncActions` 统一由 `shouldShowRemoteSyncActions` 算出，本文件不重复判定。
  // remoteSessionId 传 directory-step 表示当前处于目录选择阶段。
  // clientMode 固定为 desktop-continuous：该步骤只服务桌面连续链路。
  // `hasLocalSourceService` 要求 `localSkillSyncService`/`localMcpSyncService`/`localPluginSyncService` 至少一个存在，否则入口为空。
  // 能力判断只读 props，不触发任何服务调用。
  const canShowRemoteSyncActions = shouldShowRemoteSyncActions({
    remoteSessionId: remoteTarget ? "directory-step" : null,
    remoteTarget,
    clientMode: "desktop-continuous",
    hasLocalSourceService: Boolean(
      localSkillSyncService || localMcpSyncService || localPluginSyncService,
    ),
  });
  // `canSyncRemoteSkills` 必须同时满足 `canShowRemoteSyncActions`、`localSkillSyncService` 与 `remoteSkillSyncService`，缺一不可。
  // `localSkillSyncService` 或 `remoteSkillSyncService` 缺失时按钮禁用，不在 `onConnect` 时抛错。
  // 该布尔值同时传给 Dropdown 与 Dialog，保证两处一致。
  const canSyncRemoteSkills = Boolean(
    canShowRemoteSyncActions && localSkillSyncService && remoteSkillSyncService,
  );
  // [契约] MCP 同步同样要求两端服务齐备。
  // 与技能不同，MCP 还需要已选路径，由按钮层额外禁用。
  // 不在能力判断里读取路径，保持该计算只依赖服务对象。
  const canSyncRemoteMcp = Boolean(
    canShowRemoteSyncActions && localMcpSyncService && remoteMcpSyncService,
  );
  // `canSyncRemotePlugins` 的判断口径与 `localPluginSyncService` 的注入方式一致。
  // 远端服务可能尚未建立（null），此时不展示该入口。
  // `canSyncRemotePlugins` 为假时 `RemoteSyncDialogs` 仍挂载，但开关打不开。
  const canSyncRemotePlugins = Boolean(
    canShowRemoteSyncActions && localPluginSyncService && remotePluginSyncService,
  );
  // [契约] 快速打开固定分为最近目录与远端记录两组，顺序稳定。
  // 最近目录支持字符串或对象两种输入，统一投影成 { path }。
  // `quickOpenGroups` 的空组由渲染层过滤，不在 `.map` 前删除，组标题语义才稳定。
  // `quickOpenGroups` 每次渲染都由字面量重建，只是数据投影，不参与 `useMemo` 比较。
  const quickOpenGroups = [
    {
      label: "remote.recentDirectories",
      items: quickOpenPaths.map((item) => (typeof item === "string" ? { path: item } : item)),
    },
    { label: "remote.remoteRecord", items: quickOpenEntries },
  ];
  // [事务] 重命名保存是三态机：idle → saving → saved/failed。
  // [并发] saving 期间重复触发直接返回，防止并发提交。
  // `saveName` 在 `!name` 或 `name === deviceName` 时直接返回，避免空写入。
  // 失败只切状态，不抛错，避免输入框失焦路径产生未处理拒绝。
  // `saveName` 成功后不清 `deviceNameDraft`，输入框继续显示刚提交的名称。
  const saveName = async () => {
    // [契约] 提交前必须 trim，首尾空白不进入设备名。
    // 与 deviceName 比较使用 trim 后的值，避免仅空白差异触发写入。
    // `saveName` 不做长度校验，规则由 `onRenameDevice` 的上层服务负责。
    const name = deviceNameDraft.trim();
    if (!name || name === deviceName || !onRenameDevice || renameStatus === "saving") return;
    setRenameStatus("saving");
    try {
      // [失败路径] 成功与失败共享同一 try/catch，状态必须落到终态。
      // await 期间组件可能卸载，状态更新由 React 18 自动忽略。
      // 回调缺失时上面的守卫已返回，不会走到这里。
      await onRenameDevice(name);
      setRenameStatus("saved");
    } catch {
      setRenameStatus("failed");
    }
  };

  // [失败路径] 基础服务未就绪时只渲染 loading 与返回，不尝试浏览目录。
  // `!services` 分支保留 `onChooseLater`，允许跳过 `DirectoryBrowser` 直接继续。
  // 不能用空 services 继续渲染 DirectoryBrowser，否则会在内部抛错。
  // 分支内不记录错误：未就绪是正常时序，不是失败。
  if (!services) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-6 h-full">
        <div className="flex min-h-[22rem] flex-1 items-center justify-center rounded-2xl border border-border bg-card text-ui-base text-remote-foreground-muted">
          <LoaderIcon className="mr-2 size-4 animate-spin" />
          {intl.formatMessage({ id: "common.loading" })}
        </div>
        <div className="flex justify-end gap-3">
          {onChooseLater ? (
            <Button variant="ghost" onClick={onChooseLater}>
              {intl.formatMessage({ id: "remote.chooseLater" })}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="h-10 min-w-0 w-32"
            onClick={onBack}
          >
            {intl.formatMessage({ id: "common.back" })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-busy={selecting}>
      {deviceName && !onRenameDevice ? (
        <h3 className="text-ui-base font-semibold">{deviceName}</h3>
      ) : null}
      <div className="flex flex-col flex-1 min-h-0 space-y-3 overflow-y-auto">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-success-surface px-3 py-2 text-ui-sm text-success-surface-foreground">
          <div className="min-w-0">
            <span className="flex items-center gap-2">
              <CheckIcon className="size-4" />
              {intl.formatMessage({ id: "remote.status.connected" })}
              {[
                profileName && profileName !== deviceName
                  ? profileName
                  : remoteTarget
                    ? intl.formatMessage({ id: `remote.kind.${remoteTarget.kind}` })
                    : undefined,
                deviceVersion ? `v${deviceVersion}` : undefined,
              ]
                .filter(Boolean)
                .map((value) => (
                  <span key={value}>· {value}</span>
                ))}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <RemoteSyncDropdownButton
              canSyncSkills={canSyncRemoteSkills}
              canSyncMcp={canSyncRemoteMcp}
              canSyncPlugins={canSyncRemotePlugins}
              mcpDisabled={!selectedPath.trim()}
              onOpenSkillSync={() => setRemoteSkillSyncOpen(true)}
              onOpenMcpSync={() => setRemoteMcpSyncOpen(true)}
              onOpenPluginSync={() => setRemotePluginSyncOpen(true)}
            />
          </div>
        </div>
        {onRenameDevice ? (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-ui-sm text-remote-foreground-muted">
              {intl.formatMessage({ id: "remote.renameDevice" })}
            </span>
            <Input
              value={deviceNameDraft}
              aria-label={intl.formatMessage({ id: "remote.renameDevice" })}
              className="h-7 max-w-64 font-mono text-ui-sm"
              onChange={(event) => {
                setDeviceNameDraft(event.currentTarget.value);
                setRenameStatus("idle");
              }}
              disabled={renameStatus === "saving"}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void saveName();
                }
              }}
              onBlur={() => {
                void saveName();
              }}
            />
            <span role="status" className="text-ui-xs text-remote-foreground-muted">
              {intl.formatMessage({
                id:
                  renameStatus === "saved"
                    ? "remote.renameSaved"
                    : renameStatus === "failed"
                      ? "remote.renameFailed"
                      : renameStatus === "saving"
                        ? "common.loading"
                        : "remote.renameDeviceHint",
              })}
            </span>
          </div>
        ) : null}
        {quickOpenGroups.map((group) =>
          group.items.length ? (
            <div key={group.label} className="min-w-0 space-y-1.5">
              <span className="block text-ui-xs text-remote-foreground-muted">
                {intl.formatMessage({ id: group.label })}
              </span>
              <div className="flex min-w-0 flex-wrap gap-2">
                {group.items.map(({ path, label }) => (
                  <Button
                    key={path}
                    type="button"
                    variant={selectedPath === path ? "secondary" : "outline"}
                    size="sm"
                    className="max-w-full h-auto rounded-md font-mono"
                    disabled={selecting}
                    onClick={() => {
                      setNavigationRevision((revision) => revision + 1);
                      setDirectoryReady(false);
                      setSelectedPath(path);
                    }}
                  >
                    <FolderIcon className="size-3.5 shrink-0 text-remote-foreground-muted" />
                    <span className="break-all whitespace-normal text-left">{path}</span>
                    {label ? (
                      <span className="font-sans text-ui-xs text-remote-foreground-muted">
                        {label}
                      </span>
                    ) : null}
                  </Button>
                ))}
              </div>
            </div>
          ) : null,
        )}
        {/* Bugfix: 该容器之前不是 flex，导致子级 DirectoryBrowser 的 flex-1 无法拿到有效高度，
            目录项变多时 overflow-y-auto 不生效，列表不能垂直滚动。 */}
        <div
          className={cn(
            "min-h-48 flex shrink-0 overflow-hidden",
            selecting ? "pointer-events-none opacity-70" : "",
          )}
        >
          <DirectoryBrowser
            initialPath={selectedPath}
            navigationRevision={navigationRevision}
            onNavigationStateChange={setDirectoryReady}
            services={services}
            embedded
            onSelect={onSelect}
            onCancel={onCancel}
            // Bug 原因：把目录行改成“仅选中”后，点击不再执行 readdir，用户失去了进入子目录的入口。
            // 目录行保持逐级导航，父层通过 onPathChange 记录当前路径并在底部按钮统一确认。
            onPathChange={setSelectedPath}
          />
        </div>
      </div>
      <p
        className="break-all font-mono text-ui-sm text-remote-foreground-muted"
        data-testid="remote-directory-selected-path"
      >
        {intl.formatMessage({ id: "remote.directory.willOpen" }, { path: selectedPath })}
      </p>
      <div className="flex items-center justify-end gap-3 border-t border-border pt-3">
        {onChooseLater ? (
          <Button variant="ghost" className="mr-auto" disabled={selecting} onClick={onChooseLater}>
            {intl.formatMessage({ id: "remote.chooseLater" })}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="secondary"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={onBack}
          disabled={selecting}
        >
          {intl.formatMessage({ id: "common.back" })}
        </Button>
        <Button
          type="button"
          size="lg"
          className="h-10 min-w-0 px-5"
          onClick={() => selectedPath && directoryReady && !selecting && onSelect(selectedPath)}
          disabled={!selectedPath || selecting || !directoryReady}
        >
          {selecting ? (
            <>
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage({ id: "common.loading" })}
            </>
          ) : (
            intl.formatMessage({ id: "remote.openWorkspaceHere" })
          )}
        </Button>
      </div>
      <RemoteSyncDialogs
        canSyncSkills={canSyncRemoteSkills}
        canSyncMcp={canSyncRemoteMcp}
        canSyncPlugins={canSyncRemotePlugins}
        skillOpen={remoteSkillSyncOpen}
        mcpOpen={remoteMcpSyncOpen}
        pluginOpen={remotePluginSyncOpen}
        onSkillOpenChange={setRemoteSkillSyncOpen}
        onMcpOpenChange={setRemoteMcpSyncOpen}
        onPluginOpenChange={setRemotePluginSyncOpen}
        localSkillSyncService={localSkillSyncService}
        remoteSkillSyncService={remoteSkillSyncService}
        localMcpSyncService={localMcpSyncService}
        remoteMcpSyncService={remoteMcpSyncService}
        localPluginSyncService={localPluginSyncService}
        remotePluginSyncService={remotePluginSyncService}
        localZCodeAgentService={localZCodeAgentService}
        remoteZCodeAgentService={remoteZCodeAgentService}
        remoteTarget={remoteTarget}
        skillWorkspacePath=""
        mcpWorkspacePath={selectedPath.trim()}
        pluginWorkspacePath={selectedPath.trim()}
        pluginLocalWorkspacePath={localWorkspacePath}
        mcpLocalWorkspacePath={localWorkspacePath}
        onSkillsSynced={async () => {
          await onSkillsSynced?.();
        }}
        onMcpSynced={async () => {
          await onMcpSynced?.();
        }}
        onPluginsSynced={async () => {
          await onPluginsSynced?.();
        }}
      />
    </div>
  );
}
