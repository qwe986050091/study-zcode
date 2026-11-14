/* eslint-disable max-lines -- CUA 设置页同时编排插件总开关、双权限状态与授权返回恢复链；后续单独拆分组件。 */
// 设置页「电脑控制 (Computer Use)」分区：
//  - 顶部一个总开关：开/关 zcode-cua 插件（连带其 MCP server 与 skill 一起启用/禁用）。
//  - macOS 下再展示 Accessibility / Screen Recording 两个权限行（含授权引导与 stale 恢复链）。
// UI 复用 SettingsGroupCard / SettingsRow / SettingsBadge / Switch，与其它设置分区保持一致。
//
// Helper 权限状态走 useCuaPermissionStatus：事件驱动（进入页面 / 窗口重获焦点 / 显式 refresh）
// 各查一次，不再定时轮询；状态存在共享缓存里，与输入框常驻入口读同一份。
// 职责边界（ComputerUseSection.tsx）：设置页「电脑控制」分区的展示与交互编排。
// 做：插件总开关（zcode-cua 的 enabled 态）、输入框常驻入口开关、macOS 两项 TCC 权限行与授权返回恢复链。
// 不做：不做权限探测本身（useCuaPermissionStatus）、不实现 Helper 重启（cuaPermissionService）、不改 store。
// 依赖：useServices / usePlatform / 插件管理 store / cuaPermissionAction 的 recovery 状态机。
// 边界：本组件只「发起操作」，所有真实副作用都经 service 或 platform command 出去。
// 失败语义：Helper 不可用降级为 unknown 文案；重启失败 toast 并保留「重启 ZCode」兜底。
// 取舍：权限状态只在进入页面/聚焦/显式 refresh 时查，不轮询，因此 UI 会短暂滞后于系统设置。
// 安全：主动探针（真实截图）只允许跟随授权返回或显式重启，后台刷新必须保持只读。
// 身份：path 是「本机 workspace 路径」，SSH 远端的 workspacePath 不能用于本机 Helper 查询。
// 语法约束：本文件是 .tsx，`//` 只能出现在语句之间，不能进入 JSX 子节点或开标签属性。
//
// INV-01 断言：本机权限查询的路径只取 localWorkspacePath 回落 workspacePath，且仅 macOS 本机 workspace 才有值 —— 守住它的位置：path 的计算 —— 改错故障：用 SSH 远端路径查本机 Helper，状态永远 unknown。
// INV-02 断言：授权按钮的可用性与文案跟随 settled，不跟随每次查询的 status —— 守住它的位置：useCuaPermissionStatus 解构与 Button disabled —— 改错故障：文案在「验证中」与终态之间反复切，按钮宽度跳动。
// INV-03 断言：availableStatus 必须经 isCuaPermissionStatusAvailable 过滤 —— 守住它的位置：availableStatus 赋值 —— 改错故障：把「查询失败」当成「未授权」，凭空生成打开系统设置的入口。
// INV-04 断言：总开关只读插件 store 的 enabled，不维护本地副本 —— 守住它的位置：cuaEnabled —— 改错故障：双份真相，UI 显示已开启而插件实际未启用。
// INV-05 断言：插件初始化只执行一次，且必须同时具备 supportsComputerUseSettings / workspacePath / pluginService —— 守住它的位置：initRef 保护的 effect —— 改错故障：重复 initialize 覆盖 togglingPluginId；缺 service 时静默不加载。
// INV-06 断言：Helper 重启必须 single-flight，第二个调用直接复用同一 Promise —— 守住它的位置：restartPromiseRef 早退 —— 改错故障：并发轮换 broker 凭据，Helper 处于半死状态。
// INV-07 断言：重启的副作用必须完成，但 setState 只在 helperContextKey 未变时执行 —— 守住它的位置：targetContextKey 比较 —— 改错故障：切 workspace 后旧操作把新页面的升级提示写错。
// INV-08 断言：主动探针每次重启最多排一个（queuedActiveProbe），finally 里不得重复排 —— 守住它的位置：finally 的 refresh 分支 —— 改错故障：重复触发 macOS 隐私采集，系统弹窗刷屏。
// INV-09 断言：applyPendingGrant 必须先 await 已在途的 restart —— 守住它的位置：existing 的 await —— 改错故障：授权后拉起的 Helper 被旧重启覆盖，读到的仍是旧 TCC 结果。
// INV-10 断言：claim 在每个 await 之后都要用 isCuaPermissionReturnRecoveryCurrent 重新校验 —— 守住它的位置：applyPendingGrant 两处 —— 改错故障：过期 claim 触发一次无意义的 Helper 重启。
// INV-11 断言：所有 setState/toast 前必须判 mountedRef —— 守住它的位置：各异步回调 —— 改错故障：卸载后 setState，或在已销毁实例上弹 toast。
// INV-12 断言：卸载与 workspace 切换的 cleanup 都必须 cancel 进行中的 onboarding —— 守住它的位置：两个 effect 的 return —— 改错故障：孤儿原生设置页操作泄漏，返回时无人接管。
// INV-13 断言：插件切换的完成回调要同时校验 generation 与 contextKey —— 守住它的位置：isCurrent —— 改错故障：A 的完成回调把 B 的插件状态刷成失败。
// INV-14 断言：openPermissionSettings 在已有 operationId 或 checkToken 时直接早退 —— 守住它的位置：函数入口 guard —— 改错故障：双击并发打开两个原生 pane，返回事件乱序。
// INV-15 断言：点击边沿必须重新查 Helper，不能复用 lastKnown —— 守住它的位置：getStatus(includeFunctionalProbes:false) —— 改错故障：另一窗口刚完成授权，这里仍打开过期的设置 pane。
// INV-16 断言：不可用状态的重试每轮都要校验 mounted/token/contextKey/recoveryState 四项 —— 守住它的位置：循环内 early return —— 改错故障：切到 B 之后旧请求把 A 的结论写进 B 的页面。
// INV-17 断言：重试循环之后还要让出一个 macrotask 再判定 —— 守住它的位置：setTimeout(0) 与紧随的 guard —— 改错故障：concurrent commit 期间用旧 props 为 B 打开原生设置页。
// INV-18 断言：只有 denied 徽章可点击，granted/stale/unknown 保持纯展示 —— 守住它的位置：renderPermissionBadge 的 clickable —— 改错故障：已授权项被点开，弹出无意义的授权流程。
// INV-19 断言：输入框入口的持久化默认值必须用 !== false 判断 —— 守住它的位置：persistedComposerEntryHidden —— 改错故障：默认值翻转，存量用户突然看到本应隐藏的按钮。
// INV-20 断言：乐观开关失败要回滚 override 并清除 saving —— 守住它的位置：onToggleComposerEntry 的 catch/finally —— 改错故障：UI 显示已开启但配置没落盘，重启后回弹。
//
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSettings } from "@/hooks/useSettingService.js";
import type { CuaOsSupport, CuaPermissionKind, RemoteTarget } from "@zcode/shared";
import {
  DesktopCommandIds,
  isRemoteWorkspaceIdentity,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
} from "@zcode/shared";
import { isCuaPermissionStatusAvailable, type CuaPermissionRestartOptions } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCuaPermissionStatus } from "@/hooks/useCuaPermissionStatus.js";
import {
  claimCuaPermissionReturnRecovery,
  completeCuaPermissionReturnRecovery,
  captureCuaPermissionReturnRecovery,
  createCuaPermissionReturnRecoveryState,
  isCuaPermissionReturnRecoveryCurrent,
  markCuaPermissionOnboardingOpened,
  shouldRestartHelperAfterCuaPermissionReturn,
  type CuaPermissionReturnRecoveryClaim,
} from "@/lib/cuaPermissionAction.js";
import { usePluginManagementStore } from "@/store/pluginManagementStore.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";
import { supportsLocalMacCuaPermissionOnboarding } from "@/lib/cuaPlatform.js";
import { runAfterSuccessfulPluginEnabledChange } from "@/settings/pluginEnabledChange.js";
import { createCuaPermissionOnboardingOperationId } from "@/lib/cuaPermissionOnboardingOperation.js";
import { waitForAccessibilityNotStale } from "@/settings/cuaPermissionRestartVerify.js";
import { requiredCuaPermissionsForFreshStatus } from "@/settings/cuaPermissionPreparation.js";
import { ExternalLink } from "lucide-react";
import {
  isComputerUseRemoteOrLinux,
  resolveComputerUseAvailability,
} from "@/settings/computerUseAvailability.js";

// [契约] 全部 props 都是可选：设置页在远端、Web、Linux 上也会挂载本组件，缺省即代表「无本机 CUA 能力」。
// 不要给 isDesktop 之外的能力判断加默认 true，能力必须由调用方显式传入或由平台探测得出。
// 新增 prop 时同步考虑 remoteTarget/remoteSessionId 的语义，否则远端页面会误判为本机。
interface ComputerUseSectionProps {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  remoteTarget?: RemoteTarget | null;
  // SSH 远端设置页里 workspacePath 是远端路径；本机 Helper 状态查询必须使用本机 workspace 路径。
  // [契约] 这个字段存在的唯一理由就是 SSH 远端场景：workspacePath 是远端路径，本机 Helper 只认本机路径。
  // 所有本机副作用（Helper 重启、TCC 查询）都必须用 localWorkspacePath 回落后的 path，见 INV-01。
  // 不要把插件总开关也改成用 localWorkspacePath：插件属于远端 workspace，必须用 workspacePath。
  localWorkspacePath?: string | null;
}

// [契约] 组件不做数据请求的编排重试，所有重试语义在 hook 与 service 内部。
// 这里是渲染层，任何 await 之后都必须先判 mounted，再改 UI 状态。
// 不要在组件内创建第二份 pluginManagementService 或 cuaPermissionService。
export function ComputerUseSection({
  isDesktop = false,
  isMacDesktop,
  isWindowsDesktop = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  remoteTarget,
  localWorkspacePath,
}: ComputerUseSectionProps) {
  // [契约] 所有用户可见文案都走 intl；包括 toast 与按钮 title，不要拼中文字符串。
  // intl 变化时会重建下方所有 useCallback，依赖数组里必须保留它，否则切换语言后提示文案是旧 locale。
  // 错误信息本身（error.message）不翻译，作为参数插入文案。
  const { intl } = useZCodeIntl();
  const services = useServices();
  const platform = usePlatform();
  // [契约] 这是插件总开关唯一的写入通道；不要直接调 store 的 setEnabled 而绕过 service。
  // 它在某些宿主可能为 undefined，所有使用点都要早退而不是断言非空。
  // 变量拆出来是为了让 useCallback 的依赖稳定，不要内联成 services.pluginManagementService。
  const pluginManagementService = services.pluginManagementService;
  // cuaPermissionService 在 main 是可选字段（远端 host 无 CUA）；下方各 handler 在缺失时早退。
  // [契约] 该字段在远端 host 上不存在，这是「能力探测」而不是「加载失败」，因此不能 toast 报错。
  // 只有 path 与 service 同时存在才允许发起权限查询或重启，两者缺一都应该安静降级。
  // 不要在这里给一个假实现，否则 UI 会把「不可用」显示成「未授权」。
  const cuaPermissionService = services.cuaPermissionService;
  // [契约] 三个条件缺一不可：没有 remoteSessionId、没有 remoteTarget、identity 不是远程格式。
  // 只判断 identity 不够：老版本远端不带 identity，必须同时看 session 与 target。
  // 这里的结果只决定「是否展示本机能力」，不决定请求发往哪个 host。
  const isLocalWorkspace =
    !remoteSessionId &&
    !remoteTarget &&
    !(workspaceIdentity?.trim() && isRemoteWorkspaceIdentity(workspaceIdentity.trim()));
  // Windows 只复用插件总开关；macOS 才具备 TCC 权限、Helper 状态和附加设置能力。
  const supportsLocalMacWorkspace =
    !isWindowsDesktop &&
    (isMacDesktop ?? supportsLocalMacCuaPermissionOnboarding(platform)) &&
    isLocalWorkspace;
  const supportsLocalWindowsWorkspace = isWindowsDesktop && isLocalWorkspace;
  // [契约] Windows 只有插件总开关，没有 TCC 权限行；macOS 才有完整分区。
  // Linux 与远端一律走不支持分支，但那条分支必须渲染提示卡而不是 null（否则页面像加载失败）。
  // 不要用 supportsComputerUseSettings 去门禁插件开关本身：总开关在 Windows 也要能用。
  const supportsComputerUseSettings = supportsLocalMacWorkspace || supportsLocalWindowsWorkspace;
  // [契约] availability 只用于「不支持」分支的解释文案，不参与任何写操作门禁。
  // 传入的 isDesktop 这里做了 OR 兜底，是为了兼容调用方只传 isMacDesktop 的老用法。
  // 新增环境类型时先改 resolveComputerUseAvailability，不要在组件里加三元判断。
  const availability = resolveComputerUseAvailability({
    isDesktop: isDesktop || isWindowsDesktop || supportsLocalMacWorkspace,
    isMacDesktop: isMacDesktop || supportsLocalMacWorkspace,
    isWindowsDesktop,
    remoteSessionId,
    remoteTarget,
    workspaceIdentity,
  });
  // CUA 权限是 macOS 本机属性：仅完整 macOS 设置需要 Helper workspace 路径。
  const path = supportsLocalMacWorkspace ? (localWorkspacePath ?? workspacePath) : null;
  // 展示只跟 settled：fresh 每次查询开始都会落回 false，跟着它渲染会让授权按钮的文案
  // 在「验证中…」与终态之间切换、宽度随之跳变。
  // [契约] path 为 null 时 hook 必须不发请求；这是远端页面不触发本机采集的关键。
  // settled 与 status 是两套语义：settled 表示「本轮查询已落定」，专门用于按钮防抖，见 INV-02。
  // refresh 的入参 includeFunctionalProbes 决定是否允许真实截图，默认必须只读。
  const { status, settled, refresh } = useCuaPermissionStatus(path ?? null, workspaceIdentity);
  const availableStatus = status && isCuaPermissionStatusAvailable(status) ? status : null;

  // macOS 版本门槛：低版本系统上 Helper 被 LaunchServices -10825 拒启，表象是授权反复无响应。
  // 查询一次主进程判定（GetCuaOsSupport），低于地板时渲染提示卡并隐藏授权操作区。
  // 查询失败按无门槛处理，不阻塞设置页；useCuaPermissionStatus 轮询保留，仅隐藏交互入口。
  // [契约] null 表示「未知或无门槛」，不能当成「低于地板」；只有明确的 macos-below-minimum 才降级。
  // 查询失败保持 null，因为版本探测失败不应该阻塞整个设置页。
  // 这个状态只影响提示卡与授权入口的可见性，不影响权限查询本身。
  const [osSupport, setOsSupport] = useState<CuaOsSupport | null>(null);
  useEffect(() => {
    if (!supportsLocalMacWorkspace || typeof platform.executeDesktopCommand !== "function") return;
    // [资源] cancelled 是 effect 内的本地标志，不能用 mountedRef 代替：这里要防的是「effect 重跑导致的旧请求」。
    // setOsSupport 前必须判 cancelled，否则快速切换 workspace 会把 A 的版本写进 B。
    // 清理函数只置位取消，不发任何请求，保持幂等。
    let cancelled = false;
    void platform
      .executeDesktopCommand(DesktopCommandIds.GetCuaOsSupport)
      .then((result) => {
        if (!cancelled) setOsSupport(result as CuaOsSupport);
      })
      .catch(() => {
        /* 查询失败按无门槛处理，不阻塞设置页 */
      });
    return () => {
      cancelled = true;
    };
  }, [supportsLocalMacWorkspace, platform]);

  // [契约] 只有这个精确 kind 才算低于地板；未知、查询中、其它 kind 都按正常处理。
  // 低于地板时整卡替换为升级提示，同时隐藏授权操作区——因为此时授权必然失败。
  // 不要把判断散落到 JSX 各处，统一在这里取一次，避免两处口径漂移。
  const macOsBelowCuaFloor = osSupport?.kind === "macos-below-minimum";

  // 总开关 = zcode-cua 插件启用态（读自插件管理 store；切换即同步启用/禁用插件及其 MCP + skill）。
  const plugins = usePluginManagementStore((state) => state.plugins);
  const setPluginEnabled = usePluginManagementStore((state) => state.setEnabled);
  const initializePlugins = usePluginManagementStore((state) => state.initialize);
  const togglingPluginId = usePluginManagementStore((state) => state.togglingPluginId);
  // [契约] zcode-cua 缺失时按「未启用」展示，这是默认值而不是错误状态。
  // 插件 id 必须用共享常量，手写字符串在插件改名后会静默失效。
  // cuaEnabled 只反映 store 事实，切换中状态单独用 togglingPluginId 表达。
  const cuaPlugin = plugins.find((plugin) => plugin.id === ZCODE_CUA_OFFICIAL_PLUGIN_ID);
  const cuaEnabled = cuaPlugin?.enabled ?? false;
  const cuaToggling = togglingPluginId === ZCODE_CUA_OFFICIAL_PLUGIN_ID;

  // [契约] 初始化只做一次，但必须等三项前置条件齐备，见 INV-05。
  // ref 在条件不满足时不置位，保证 workspacePath 稍后就绪后仍能触发。
  // 不要把它改回 useState，否则置位本身会触发一次多余渲染。
  const initRef = useRef(false);
  useEffect(() => {
    if (
      initRef.current ||
      !supportsComputerUseSettings ||
      !workspacePath ||
      !pluginManagementService
    )
      return;
    initRef.current = true;
    // 复用 Plugins 分区同一条初始化路径，确保 store 已加载 zcode-cua 的 enabled 态。
    void initializePlugins({
      workspacePath,
      workspaceIdentity,
      pluginService: pluginManagementService,
    });
  }, [
    supportsComputerUseSettings,
    workspacePath,
    workspaceIdentity,
    pluginManagementService,
    initializePlugins,
  ]);

  // [契约] restarting 只驱动按钮的禁用与文案，不参与 single-flight 判断。
  // 真正的并发保护在 restartPromiseRef，因为 setState 是异步的，不能作为锁。
  // 卸载后不得再 setRestarting，见 INV-11。
  const [restarting, setRestarting] = useState(false);
  // 重启 single-flight：授权返回回调、双击和手动按钮共享同一 operation，不并发轮换 broker 凭据。
  // [并发] 这就是 single-flight 锁：授权返回、双击、手动按钮共享同一个 Promise。
  // 必须在 finally 里置 null，且置空发生在 setRestarting(false) 之前，保证下一次调用能重新发起。
  // 不要用 Promise 链做「排队」：并发重启会轮换 broker 凭据，语义上不允许排队，只允许复用。
  const restartPromiseRef = useRef<Promise<boolean> | null>(null);
  // [契约] 它保存的是「本次授权会话 id」，用于把返回事件与打开事件配对；不是用户会话 id。
  // workspace 变化时必须清空，否则旧 workspace 的 session 会串到新页面。
  // 读取时用 pendingGrantSessionIdRef.current 兜底，允许调用方显式传入更高优先级的值。
  const pendingGrantSessionIdRef = useRef<string | undefined>(undefined);
  const returnRecoveryRef = useRef(createCuaPermissionReturnRecoveryState());
  useEffect(() => {
    returnRecoveryRef.current = createCuaPermissionReturnRecoveryState(
      workspaceIdentity?.trim() || path || "<none>",
    );
    pendingGrantSessionIdRef.current = undefined;
  }, [path, workspaceIdentity]);
  // 重启 Helper 后验证仍持续 stale → 显示"重启 ZCode"兜底按钮。accessibility 变 granted 时自愈清除。
  // [契约] 这个状态只给「重启 ZCode」兜底按钮用，不代表权限失败。
  // 只有 stillStale 为 true 且上下文匹配时才置位；成功路径必须显式清零。
  // accessibility 变 granted 时自愈清零，不要在别处手动清，避免两条清理路径打架。
  const [verifyTimedOut, setVerifyTimedOut] = useState(false);
  // 卸载守卫：异步 fetch / 重启 / 切换完成时若组件已卸载，跳过 setState。
  // [契约] 卸载守卫必须是 ref 而不是 state：异步回调读到的是最新值，不需要重渲染。
  // 初值 true 是刻意的，effect 里再置 true 兼容 StrictMode 的二次挂载。
  // 所有 toast/setState 前都要判它，见 INV-11。
  const mountedRef = useRef(true);
  // [并发] generation 用于丢弃过期的插件切换完成回调，与 workspace 上下文一起构成双校验。
  // 卸载时自增一次，让所有在途操作立即失配，见 INV-13。
  // 不要把它和 helperContextKey 合并：一个服务多 workspace，一个只服务本机路径。
  const pluginToggleGenerationRef = useRef(0);
  const pluginToggleContextKey = [
    workspacePath ?? "",
    workspaceIdentity ?? "",
    localWorkspacePath ?? "",
    remoteSessionId ?? "",
    remoteTarget ? "remote" : "local",
  ].join("\u0000");
  const pluginToggleContextKeyRef = useRef(pluginToggleContextKey);
  pluginToggleContextKeyRef.current = pluginToggleContextKey;
  const helperContextKey = [path ?? "", workspaceIdentity?.trim() ?? ""].join("\u0000");
  const helperContextKeyRef = useRef(helperContextKey);
  helperContextKeyRef.current = helperContextKey;
  // [契约] 它表示「当前有一个原生授权流程在跑」，是打开操作的第二把锁，见 INV-14。
  // 写入必须在 openCuaPermissionOnboarding 之前，清除必须在 finally 且只清自己那个 id。
  // 卸载与切换 workspace 时要 cancel 它，否则原生 pane 会变成无主操作，见 INV-12。
  const activeOnboardingOperationIdRef = useRef<string | null>(null);
  // [并发] Symbol token 用于标识「当前这次点击的查询链」，比 boolean 更能区分前后两次点击。
  // 每个 await 之后都要比较 token，见 INV-16；比较失败说明这次点击已被更新的点击取代。
  // 不要用递增数字替代：Symbol 天然唯一，不会与历史 token 撞值。
  const permissionStatusCheckTokenRef = useRef<symbol | null>(null);
  // [契约] 卸载清理函数里必须用最新的 platform 实例，而 cleanup 的闭包会捕获旧值。
  // 这里只镜像引用，不复制能力：platform 仍是唯一的平台副作用出口。
  // 不要在渲染期间改 platformRef.current 之外的副作用，这一行是赋值不是调用。
  const platformRef = useRef(platform);
  platformRef.current = platform;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      pluginToggleGenerationRef.current += 1;
      permissionStatusCheckTokenRef.current = null;
      const operationId = activeOnboardingOperationIdRef.current;
      activeOnboardingOperationIdRef.current = null;
      if (operationId) {
        platformRef.current.cancelCuaPermissionOnboarding?.(operationId);
      }
    };
  }, []);

  // 同一设置页实例切换 workspace 时也要退出旧 participant；否则旧调用返回后会恢复错误的 Helper。
  useEffect(
    () => () => {
      permissionStatusCheckTokenRef.current = null;
      const operationId = activeOnboardingOperationIdRef.current;
      activeOnboardingOperationIdRef.current = null;
      if (operationId) {
        platformRef.current.cancelCuaPermissionOnboarding?.(operationId);
      }
    },
    [path, workspaceIdentity],
  );

  // [契约] 重启的入参是可覆盖的：调用方可以指定「授权时那个 workspace」，而不是当前 props。
  // 这是刻意的：切走后旧操作仍需完成必要副作用，但展示要服从当前 props，见 INV-07。
  // 返回 false 表示未执行或失败，调用方不需要区分（详情已在 toast 与日志里）。
  const onRestart = useCallback(
    (
      targetPath = path,
      targetWorkspaceIdentity = workspaceIdentity,
      restartOptions?: CuaPermissionRestartOptions,
    ): Promise<boolean> => {
      // [失败路径] 返回 resolved false 而不是 reject：这是「不适用」而不是错误，调用方不应弹错误。
      // 三个条件都要判，services 本身在极端情况下也可能为空。
      // 不要在这里 toast：缺少能力是环境事实，不是用户操作失败。
      if (!targetPath || !services || !cuaPermissionService) return Promise.resolve(false);
      // [并发] 这一行是 single-flight 的全部实现，见 INV-06；删除它会让并发重启轮换凭据。
      // 复用的是同一个 Promise<boolean>，因此并发调用者拿到一致结果。
      // 不要在这里 await 后再判断：那会让第二个调用排队而不是复用。
      if (restartPromiseRef.current) return restartPromiseRef.current;
      const targetContextKey = [targetPath, targetWorkspaceIdentity?.trim() ?? ""].join("\u0000");
      if (helperContextKeyRef.current === targetContextKey) {
        setVerifyTimedOut(false);
      }
      setRestarting(true);
      // [契约] 用 IIFE 而不是命名函数，是为了让「创建 Promise」与「登记到 ref」在同一个同步片段内完成。
      // async IIFE 内部的异常必须自己 catch，否则会变成未处理的 rejection。
      // 返回布尔而不是抛错：调用方（含 applyPendingGrant）只关心是否成功。
      const operation = (async (): Promise<boolean> => {
        let queuedActiveProbe = false;
        try {
          // [契约] restartOptions 必须原样透传，reason/permission_granted 会影响 host 侧日志与行为。
          // result.ok 为 false 时先 toast 再返回，两个 return false 分支的 mounted 判断刻意不同。
          // 这里不做重试：重启失败通常意味着 Helper 卡死，重试只会加剧。
          const result = await cuaPermissionService.restartHelper(
            targetPath,
            targetWorkspaceIdentity,
            restartOptions,
          );
          if (!result.ok && mountedRef.current) {
            toast(
              intl.formatMessage(
                { id: "cuaPermission.modal.restartFailed" },
                { error: result.reason ?? "unknown error" },
              ),
            );
            return false;
          }
          if (!result.ok) return false;

          // Helper socket 已健康不代表 tccd 状态已经传播完成；短轮询确认 stale 是否消失。
          // [失败路径] socket 健康不等于 tccd 已传播，必须短轮询确认 stale 是否消失。
          // 轮询函数自己处理超时，这里不要额外加定时器或 Promise.race。
          // 它返回 true 表示仍然 stale，用于显示「重启 ZCode」兜底，而不是判定重启失败。
          const stillStale = await waitForAccessibilityNotStale(() =>
            cuaPermissionService.getStatus(targetPath, targetWorkspaceIdentity),
          );
          // 授权过程中可能切换 workspace；旧操作仍完成必要副作用，但不能污染新页面的升级提示。
          if (mountedRef.current && helperContextKeyRef.current === targetContextKey) {
            setVerifyTimedOut(stillStale);
            // 后台权限轮询必须保持只读，真实截图只能跟随显式的授权返回/重启。
            // restart single-flight 已经把同一 Helper 恢复合并为一次，这里只排一个主动探针；
            // hook 会继续合并 focus/refresh，避免重复触发 macOS 隐私采集。
            refresh({ includeFunctionalProbes: true });
            queuedActiveProbe = true;
          }
          return true;
        } catch (error) {
          if (mountedRef.current) {
            toast(
              intl.formatMessage(
                { id: "cuaPermission.modal.restartFailed" },
                {
                  error: error instanceof Error ? error.message : String(error),
                },
              ),
            );
          }
          return false;
        } finally {
          restartPromiseRef.current = null;
          if (mountedRef.current) {
            setRestarting(false);
            // 失败路径仍只读刷新；成功路径已在当前 workspace 精确排入一次主动探针。
            if (!queuedActiveProbe) refresh();
          }
        }
      })();
      // [事务] 赋值必须在 IIFE 创建之后、返回之前：中间没有 await，所以不存在竞态窗口。
      // 这一行与开头的早退配对，任何重构都不能把赋值移进 async 体内部。
      // 置空在 finally 里，保证异常路径也能释放锁。
      restartPromiseRef.current = operation;
      return operation;
    },
    [path, workspaceIdentity, services, refresh, intl],
  );

  // [契约] 这个函数是「授权返回后重启 Helper」的唯一入口，手动重启按钮也复用它。
  // 它可以不传 claim：此时从 returnRecoveryRef 现场捕获，用于用户手动点重启的场景。
  // 副作用必须完成，展示刷新服从当前 props，见 INV-09/INV-10。
  const applyPendingGrant = useCallback(
    async (
      expectedClaim?: CuaPermissionReturnRecoveryClaim,
      target?: { workspacePath: string; workspaceIdentity?: string },
      onboardingSessionId?: string,
    ): Promise<boolean> => {
      // [契约] claim 捕获后立即校验一次，过期就直接返回 false，不做任何重启。
      // 返回 false 不是错误：可能用户快速切了 workspace 或重复点击。
      // 校验必须在 await 之前，且 await 之后还要再校验一次，两次都不能省。
      const claim = expectedClaim ?? captureCuaPermissionReturnRecovery(returnRecoveryRef.current);
      if (!claim || !isCuaPermissionReturnRecoveryCurrent(claim.state, claim)) {
        return false;
      }
      // 授权前若已有 restart，先等它结束，再启动一个真正位于授权之后的新 Helper。
      // [并发] 授权前若有在途重启，必须先等它结束，再发起「授权之后」的新 Helper。
      // await 之后必须重新校验 claim，因为等待期间上下文可能已变。
      // 不要把这行与 single-flight 早退合并：这里的语义是「等」，不是「复用」。
      const existing = restartPromiseRef.current;
      if (existing) await existing;
      if (!isCuaPermissionReturnRecoveryCurrent(claim.state, claim)) return false;
      // A 发起授权后切到 B，返回结果仍属于当前 renderer/host 的 A runtime。用点击时捕获的 identity
      // 完成必要 restart；只让后续展示刷新服从当前 props，不能因 UI generation 变化丢掉副作用。
      const ok = await onRestart(target?.workspacePath, target?.workspaceIdentity, {
        reason: "permission_granted",
        ...((onboardingSessionId ?? pendingGrantSessionIdRef.current)
          ? {
              onboardingSessionId: onboardingSessionId ?? pendingGrantSessionIdRef.current,
            }
          : {}),
      });
      completeCuaPermissionReturnRecovery(claim, ok);
      return ok;
    },
    [onRestart],
  );

  // 兜底:重启 Helper 后仍持续 stale 时,用户可一键重启 ZCode(复用 OAuth 登出同款 RelaunchApp)。
  // 新 ZCode 进程会干净地重新拉起 Helper,绕过当前进程里可能卡住的重启机制(孤儿/socket/状态污染)。
  // [契约] 这是最后的兜底：重启整个 ZCode 进程，绕过可能卡死的 Helper 重启机制。
  // 必须先判 executeDesktopCommand 是否可用，Web 上该能力不存在。
  // 调用后不要等待结果再提示：进程会被替换，后续代码可能不会执行。
  const onRelaunchApp = useCallback(async () => {
    if (typeof platform.executeDesktopCommand !== "function") return;
    await platform.executeDesktopCommand(DesktopCommandIds.RelaunchApp);
  }, [platform]);

  // [契约] 插件切换必须走 runAfterSuccessfulPluginEnabledChange，它负责成功判定与错误归一。
  // 禁用成功后只 toast 提示，不自动关闭权限区；权限区由 cuaEnabled 派生，会自动隐藏。
  // 启用成功后只 refresh 权限状态，绝不自动打开 macOS 授权 modal（见函数内注释）。
  const onTogglePlugin = useCallback(
    async (next: boolean) => {
      if (!pluginManagementService) return;
      // [并发] 每次切换都自增，旧回调通过 isCurrent 失配后不再影响 UI。
      // 这里同时捕获 operationContextKey，二者必须一起比较，见 INV-13。
      // 不要把它减一或复用：generation 只需单调递增。
      const operationGeneration = ++pluginToggleGenerationRef.current;
      const operationContextKey = pluginToggleContextKey;
      // 切换 zcode-cua 插件 = 同步其 MCP server + skill 一起启用/禁用。
      const completed = await runAfterSuccessfulPluginEnabledChange({
        submit: () => setPluginEnabled(ZCODE_CUA_OFFICIAL_PLUGIN_ID, next, pluginManagementService),
        isCurrent: () =>
          mountedRef.current &&
          pluginToggleGenerationRef.current === operationGeneration &&
          pluginToggleContextKeyRef.current === operationContextKey,
        onSuccess: () => {
          if (supportsLocalMacWorkspace) {
            // 权限状态和手动授权入口只在 macOS Computer Use 设置页展示。启用插件不得自动打开
            // macOS Permissions modal；刷新状态即可，避免打断用户当前工作流。
            refresh();
          }
          if (!next) {
            toast(intl.formatMessage({ id: "settings.computerUse.disabledToast" }));
          }
        },
      });
      if (!completed && mountedRef.current) {
        const message = usePluginManagementStore.getState().error;
        if (message) {
          toast(message);
        }
      }
    },
    [
      path,
      pluginManagementService,
      pluginToggleContextKey,
      refresh,
      setPluginEnabled,
      supportsLocalMacWorkspace,
      intl,
    ],
  );

  // 打开 macOS 系统设置引导用户授权指定权限（Accessibility / Screen Recording）。
  // [契约] 打开原生设置页是本文件唯一会「跳出应用」的操作，必须是最严格的防重入点。
  // 入口 guard、token、contextKey、recoveryState 四重校验缺一不可。
  // 失败分支要区分「不可用」与「已满足」，否则用户会以为授权失败。
  const openPermissionSettings = useCallback(
    async (initialPermission: CuaPermissionKind): Promise<void> => {
      if (
        typeof platform.openCuaPermissionOnboarding !== "function" ||
        activeOnboardingOperationIdRef.current ||
        permissionStatusCheckTokenRef.current
      ) {
        return;
      }
      // [并发] token 在进入函数后立即写入 ref，早于任何 await，保证后来的点击能立刻取代它。
      // finally 里只在 token 仍相等时清空，避免清掉后来者的 token。
      // 不要把它存进 state：这里不需要渲染，且 setState 会引入时序差。
      const checkToken = Symbol("cua-permission-status-check");
      permissionStatusCheckTokenRef.current = checkToken;
      const operationContextKey = helperContextKey;
      let operationId: string | null = null;
      // [契约] 捕获的是状态机对象的引用，后续用它判断「这次授权是否还是当前那次」。
      // workspace 变化时 effect 会替换整个对象，因此引用比较就是最有意义的失效信号。
      // 不要深拷贝它，拷贝会让 isCuaPermissionReturnRecoveryCurrent 永远返回 false。
      const recoveryState = returnRecoveryRef.current;
      const recoveryTarget = path
        ? {
            workspacePath: path,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          }
        : null;
      try {
        if (!path || !cuaPermissionService) {
          toast(intl.formatMessage({ id: "cuaPermission.modal.unavailable" }));
          return;
        }
        // 设置页行按钮过去直接使用 lastKnown 状态；另一窗口刚完成授权或当前刷新
        // in-flight 时仍会打开过期 pane。点击边沿重新查询 Helper，只允许当前 denied/stale 的精确项。
        // [契约] 点击边沿必须实时查询，state 里的 lastKnown 可能已被另一窗口改过，见 INV-15。
        // includeFunctionalProbes 必须为 false：这里只是判定能否打开设置页，不该触发截图。
        // 查询抛错走外层 catch，文案按是否已创建 operationId 区分。
        let currentStatus = await cuaPermissionService.getStatus(path, workspaceIdentity, {
          includeFunctionalProbes: false,
        });
        // 从系统设置授权返回后 App 会重启 Helper 才能读到新 TCC 授权，这段窗口内查询拿到的是
        // 不可用状态（授权完立刻点行按钮，预检查退化成「暂时无法确认」
        // 而非「已授权」）。状态不可用时短重试 2 次、间隔 2s，等 Helper 就绪后走到「已授权」
        // 或真实缺权分支；期间守卫失效（卸载/重复点击/上下文切换）直接放弃，不再重试。
        for (
          let attempt = 0;
          attempt < 2 && !isCuaPermissionStatusAvailable(currentStatus);
          attempt += 1
        ) {
          await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          if (
            !mountedRef.current ||
            permissionStatusCheckTokenRef.current !== checkToken ||
            helperContextKeyRef.current !== operationContextKey ||
            returnRecoveryRef.current !== recoveryState
          ) {
            return;
          }
          currentStatus = await cuaPermissionService.getStatus(path, workspaceIdentity, {
            includeFunctionalProbes: false,
          });
        }
        // React concurrent commit 可能已经收到 workspace A→B 更新但 passive effect 尚未清理 A。
        // render 同步更新的 context ref 是这段窗口内唯一可靠的失效信号；让出一个 macrotask后再判，
        // 迟到的 A 状态不能为 B 打开原生设置页。
        // [并发] 让出一个 macrotask，等 React 的 passive effect 把旧 workspace 清理掉，见 INV-17。
        // 这里不能换成 queueMicrotask：微任务仍在同一次 commit 内，旧 props 还没失效。
        // 让出后必须重新做四项 guard，否则等于没让。
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (
          !mountedRef.current ||
          permissionStatusCheckTokenRef.current !== checkToken ||
          helperContextKeyRef.current !== operationContextKey ||
          returnRecoveryRef.current !== recoveryState
        ) {
          return;
        }
        if (
          !isCuaPermissionStatusAvailable(currentStatus) ||
          !requiredCuaPermissionsForFreshStatus(currentStatus).includes(initialPermission)
        ) {
          const permissionState = isCuaPermissionStatusAvailable(currentStatus)
            ? initialPermission === "accessibility"
              ? currentStatus.accessibility
              : currentStatus.screenRecording
            : null;
          toast(
            intl.formatMessage({
              id:
                permissionState === "granted"
                  ? "cuaPermission.grantAlreadySatisfied"
                  : "cuaPermission.modal.unavailable",
            }),
          );
          refresh();
          return;
        }
        operationId = createCuaPermissionOnboardingOperationId();
        activeOnboardingOperationIdRef.current = operationId;
        const result = await platform.openCuaPermissionOnboarding({
          initialPermission,
          operationId,
          requiredPermissions: [initialPermission],
        });
        if (
          !mountedRef.current ||
          activeOnboardingOperationIdRef.current !== operationId ||
          helperContextKeyRef.current !== operationContextKey
        ) {
          return;
        }
        if (shouldRestartHelperAfterCuaPermissionReturn(result)) {
          markCuaPermissionOnboardingOpened(recoveryState);
          pendingGrantSessionIdRef.current = result.sessionId;
          const claim = claimCuaPermissionReturnRecovery(recoveryState);
          if (claim && recoveryTarget) {
            void applyPendingGrant(claim, recoveryTarget, result.sessionId);
          }
        } else if (result?.success && result.returnedFromSettings) {
          // 同一 renderer 对 main session 的重复 join 只刷新；不同窗口各自会拿到本 host 的 recovery。
          refresh();
        }
        if (result?.success === false && !result.canceled) {
          toast(
            intl.formatMessage(
              { id: "chat.cuaPermission.openFailed" },
              { error: result.error ?? "unknown error" },
            ),
          );
        }
      } catch (error) {
        if (
          mountedRef.current &&
          permissionStatusCheckTokenRef.current === checkToken &&
          helperContextKeyRef.current === operationContextKey
        ) {
          toast(
            operationId
              ? intl.formatMessage(
                  { id: "chat.cuaPermission.openFailed" },
                  {
                    error: error instanceof Error ? error.message : String(error),
                  },
                )
              : intl.formatMessage({ id: "cuaPermission.modal.unavailable" }),
          );
        }
      } finally {
        if (permissionStatusCheckTokenRef.current === checkToken) {
          permissionStatusCheckTokenRef.current = null;
        }
        if (operationId && activeOnboardingOperationIdRef.current === operationId) {
          activeOnboardingOperationIdRef.current = null;
        }
      }
    },
    [platform, path, services, workspaceIdentity, intl, applyPendingGrant, refresh],
  );

  const onManualRestart = useCallback((): void => {
    void (returnRecoveryRef.current.pending ? applyPendingGrant() : onRestart());
  }, [applyPendingGrant, onRestart]);

  // 自愈:accessibility 在后续任一次查询里变成 granted 时,清除"重启 ZCode"兜底(说明问题已解决)。
  useEffect(() => {
    if (availableStatus?.accessibility === "granted") setVerifyTimedOut(false);
  }, [availableStatus?.accessibility]);

  const renderGrantDetail = (kind: CuaPermissionKind, labelId: string): ReactNode => {
    if (typeof platform.openCuaPermissionOnboarding !== "function") return null;
    return (
      <Button
        type="button"
        variant="link"
        size="sm"
        className="text-sky-500 hover:text-sky-600 dark:text-sky-400 dark:hover:text-sky-300"
        aria-label={intl.formatMessage({ id: labelId })}
        title={intl.formatMessage({ id: labelId })}
        disabled={!settled}
        onClick={() => void openPermissionSettings(kind)}
      >
        <ExternalLink className="size-4" aria-hidden="true" />
        <span className="hidden sm:inline">
          {intl.formatMessage({
            id: settled ? labelId : "cuaPermission.status.verifying",
          })}
        </span>
      </Button>
    );
  };

  // 权限状态 → { 圆点颜色 tone, 文案 text }，保证圆点与文案同源（granted 绿/stale 黄/denied 红/unknown 灰）。
  // TCC=granted 即稳定显示 granted（绿）；功能探针（functionalProbeOk）只用于 runtime 就绪判断，
  // 不再让它在每次轮询时把显示态翻成 "verifying"（否则会 granted↔verifying 反复横跳）。
  const statusView = (
    state: "granted" | "stale" | "denied" | "unknown" | undefined,
  ): { tone: StatusDotTone; text: string } => {
    if (state === "granted") {
      return {
        tone: "green",
        text: intl.formatMessage({ id: "cuaPermission.status.granted" }),
      };
    }
    if (state === "stale") {
      // 仅兼容旧 Helper：可能是进程 lag，也可能是旧 ad-hoc CDHash 行，UI 同时提供重启与重新授权。
      return {
        tone: "amber",
        text: intl.formatMessage({ id: "cuaPermission.status.stale" }),
      };
    }
    if (state === "denied") {
      return {
        tone: "red",
        text: intl.formatMessage({ id: "cuaPermission.status.missing" }),
      };
    }
    return {
      tone: "muted",
      text: intl.formatMessage({ id: "cuaPermission.status.unknown" }),
    };
  };

  // 旧 Helper 的 stale 可能来自进程缓存，也可能来自旧 ad-hoc CDHash；先重启并验证，仍失败时同时
  // 保留重新授权入口与“重启 ZCode”兜底，避免把不可由单次 Helper 重启修复的状态误导成已解决。
  const renderRestartDetail = (): ReactNode => (
    <div className="flex flex-col items-start gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={restarting || !path}
        onClick={onManualRestart}
      >
        {restarting
          ? intl.formatMessage({ id: "cuaPermission.modal.restarting" })
          : intl.formatMessage({ id: "cuaPermission.modal.restartButton" })}
      </Button>
      {verifyTimedOut && !restarting ? (
        <div className="flex flex-col items-start gap-1">
          <span className="text-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "cuaPermission.modal.relaunchAppHint" })}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void onRelaunchApp()}>
            {intl.formatMessage({
              id: "cuaPermission.modal.relaunchAppButton",
            })}
          </Button>
        </div>
      ) : null}
    </div>
  );

  // 两项权限的状态视图（圆点 tone + 文案），与圆点同源，避免文案/颜色不同步。
  const acc = statusView(availableStatus?.accessibility);
  const screenPerm = statusView(availableStatus?.screenRecording);

  // 输入框常驻入口的显隐。隐藏开关用 useSettings().update 写入
  // （直连 settingService 只落盘不刷新共享 snapshot，输入框按钮读不到新值）。
  // 乐观更新本地开关，失败回滚并提示。
  const { settings: appSettings, update: updateAppSettings } = useSettings();
  const [composerEntryHiddenOverride, setComposerEntryHiddenOverride] = useState<boolean | null>(
    null,
  );
  const [composerEntrySaving, setComposerEntrySaving] = useState(false);
  // 默认隐藏，与 useCuaComposerEntry 同口径：只有显式存过 false 才算展示。
  // 两处必须一致，否则设置页开关的显示状态会和输入框按钮的实际显隐对不上。
  const persistedComposerEntryHidden = appSettings?.computerUseComposerEntryHidden !== false;
  const composerEntryVisible = !(composerEntryHiddenOverride ?? persistedComposerEntryHidden);
  useEffect(() => {
    if (composerEntryHiddenOverride === null) return;
    if (persistedComposerEntryHidden === composerEntryHiddenOverride) {
      setComposerEntryHiddenOverride(null);
    }
  }, [composerEntryHiddenOverride, persistedComposerEntryHidden]);
  const onToggleComposerEntry = useCallback(
    async (visible: boolean) => {
      const nextHidden = !visible;
      setComposerEntryHiddenOverride(nextHidden);
      setComposerEntrySaving(true);
      try {
        await updateAppSettings({ computerUseComposerEntryHidden: nextHidden });
      } catch (error) {
        if (mountedRef.current) {
          setComposerEntryHiddenOverride(null);
          toast(
            intl.formatMessage(
              { id: "settings.computerUse.composerEntry.saveFailed" },
              { error: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      } finally {
        if (mountedRef.current) setComposerEntrySaving(false);
      }
    },
    [intl, updateAppSettings],
  );

  // 产品需求：denied（未授权）时右侧状态徽章本身可点击，
  // 效果同「打开系统设置」授权按钮；granted/stale/unknown 保持纯展示。
  const renderPermissionBadge = (
    kind: CuaPermissionKind,
    view: { tone: StatusDotTone; text: string },
    state: "granted" | "stale" | "denied" | "unknown" | undefined,
  ): ReactNode => {
    const clickable = state === "denied";
    const badge = (
      <SettingsBadge>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot tone={view.tone} />
          {view.text}
        </span>
      </SettingsBadge>
    );
    if (!clickable) return badge;
    return (
      <button
        type="button"
        className="cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={view.text}
        onClick={() => void openPermissionSettings(kind)}
      >
        {badge}
      </button>
    );
  };

  if (!supportsComputerUseSettings) {
    // 远端 / Linux 环境若直接 return null，设置页只剩标题，会让用户误以为页面加载失败。
    // 保留入口并明确能力边界，且不渲染任何会触发本地 CUA 写操作的控件。
    return (
      <div className="rounded-lg border border-warning/40 bg-warning/10 p-4 text-ui-base text-warning">
        <p className="font-medium">
          {intl.formatMessage({ id: "settings.computerUse.unsupported.title" })}
        </p>
        <p className="mt-1 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({
            id: isComputerUseRemoteOrLinux(availability)
              ? availability.kind === "local-linux"
                ? "settings.computerUse.unsupported.linuxDescription"
                : "settings.computerUse.unsupported.remoteDescription"
              : "settings.computerUse.unsupported.remoteDescription",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 总开关：开/关 zcode-cua 插件（同步其 MCP + skill） */}
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.toggleLabel" })}
          description={intl.formatMessage({
            id: "settings.computerUse.toggleDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.toggleLabel",
              })}
              checked={cuaEnabled}
              disabled={cuaToggling || !workspacePath}
              onCheckedChange={(checked) => void onTogglePlugin(checked)}
            />
          }
        />
        {/* 输入框常驻入口的显隐开关：关闭是持久化 hidden 标记，
            重启与版本更新都不会自愈。只管按钮渲不渲染，不影响插件启用态与进行中任务。
            电脑控制关闭时按钮无论如何都不渲染（cuaComposerEntryState 的插件门），
            此时把开关置灰并改文案说明前置条件——留一个可点却看不到效果的开关会被当成坏了。 */}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.computerUse.composerEntry.label" })}
          description={intl.formatMessage({
            id: cuaEnabled
              ? "settings.computerUse.composerEntry.description"
              : "settings.computerUse.composerEntry.requiresEnabled",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.computerUse.composerEntry.label",
              })}
              checked={composerEntryVisible}
              disabled={composerEntrySaving || !cuaEnabled}
              onCheckedChange={(checked) => void onToggleComposerEntry(checked)}
            />
          }
        />
      </SettingsGroupCard>

      {/* CUA 未启用时隐藏下方权限配置，只留总开关，避免一堆禁用项。 */}
      {cuaEnabled && supportsLocalMacWorkspace ? (
        <>
          {/* macOS 版本低于 CUA Helper 承诺地板时，授权在低版本系统上无法完成
              （Helper 被 LaunchServices -10825 拒启），整卡替换为升级提示。 */}
          {macOsBelowCuaFloor ? (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
              <p className="font-medium">
                {intl.formatMessage(
                  { id: "cuaPermission.osFloorTitle" },
                  {
                    minimum: osSupport?.minimumMacOs ?? "12.0",
                    current: osSupport?.currentMacOs ?? "12 以下",
                  },
                )}
              </p>
              <p>{intl.formatMessage({ id: "cuaPermission.osFloorDescription" })}</p>
            </div>
          ) : null}
          {/* macOS 权限引导只保留在 Settings 内，CUA 操作与工具审批流不再自动弹权限 modal。 */}
          {!macOsBelowCuaFloor ? (
            <SettingsGroupCard>
              <SettingsRow
                controlLayout="wide"
                label={intl.formatMessage({
                  id: "cuaPermission.perm.accessibility",
                })}
                description={intl.formatMessage({
                  id: "cuaPermission.perm.accessibility.purpose",
                })}
                control={renderPermissionBadge(
                  "accessibility",
                  acc,
                  availableStatus?.accessibility,
                )}
                detail={
                  availableStatus?.accessibility === "granted"
                    ? undefined
                    : availableStatus?.accessibility === "stale"
                      ? renderRestartDetail()
                      : renderGrantDetail("accessibility", "chat.cuaPermission.openAccessibility")
                }
              />
              <SettingsRow
                controlLayout="wide"
                label={intl.formatMessage({
                  id: "cuaPermission.perm.screenRecording",
                })}
                description={intl.formatMessage({
                  id: "cuaPermission.perm.screenRecording.purpose",
                })}
                control={renderPermissionBadge(
                  "screen_recording",
                  screenPerm,
                  availableStatus?.screenRecording,
                )}
                detail={
                  availableStatus?.screenRecording === "granted"
                    ? undefined
                    : renderGrantDetail(
                        "screen_recording",
                        "chat.cuaPermission.openScreenRecording",
                      )
                }
              />
            </SettingsGroupCard>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
