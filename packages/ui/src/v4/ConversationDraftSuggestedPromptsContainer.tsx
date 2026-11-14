// 做：把推荐 Prompt 的点击收敛成一次 latest-wins 的 Composer 写入，并承载插件安装与启用流程。
// 不做：不直接调用服务或 Repo，不维护第二份草稿；Composer 只接受 store 的 requestComposerTextInsert。
// 依赖：workspace 服务解析、插件管理 RPC、Composer 插入回执与推荐轮换模块。
// 边界：所有 async 续作都必须重查 requestVersion 与 abort，任何过期结果只能丢弃，不能补写。
//
// 不变量（INV）：
// INV-01 断言：每次用户选择入口必须先自增 requestVersion —— 守住它的位置：handleSelect 首行 —— 改错故障：两次快速点击的迟到结果互相覆盖草稿。
// INV-02 断言：任何 await 之后写 Composer 前都要重查 requestVersion —— 守住它的位置：各回调的版本守卫 —— 改错故障：旧推荐项在切换后仍写入，用户看到张冠李戴的 prompt。
// INV-03 断言：abort 既表示取消也表示陈旧，catch 必须先判断 aborted 再决定是否上报 —— 守住它的位置：handleMutation 的 catch 与各 return 守卫 —— 改错故障：用户主动取消被弹成失败提示。
// INV-04 断言：Plugin 推荐项必须在可信解析后一次性写入，不允许先写 prompt 再补 mention —— 守住它的位置：handleSelect 的 plugin 分支 —— 改错故障：Composer 出现两阶段更新，光标与提及被破坏。
// INV-05 断言：draftRevision 必须在旧 operation 取消收敛之后、新 operation 开始之前捕获 —— 守住它的位置：cancelOperation await 之后 —— 改错故障：程序性写入被误判为用户编辑，推荐项直接放弃。
// INV-06 断言：关闭或超出确认态的 Popover 必须同时取消同一 operation —— 守住它的位置：onDismiss 与 cancelOperation —— 改错故障：迟到安装结果继续写 Composer。
// INV-07 断言：安装超时必须调用 cancelPluginOperation，而不只是结束 UI 等待 —— 守住它的位置：timeoutRequest 的定时器回调 —— 改错故障：远端仍在安装，成功后污染已关闭的流程。
// INV-08 断言：onDynamicPluginOperationProgress 的订阅必须在 finally dispose —— 守住它的位置：handleSelect 的 finally —— 改错故障：每次点击泄漏一个进度订阅。
// INV-09 断言：workspace 或 attachment 变化必须自增版本、清反馈并取消活动 operation —— 守住它的位置：清理 effect —— 改错故障：切换窗口后旧 Host 的结果写进新 workspace。
// INV-10 断言：组件卸载时的清理不得留下 Popover 反馈 —— 守住它的位置：同一清理 effect —— 改错故障：重新挂载时看到上一次的失败浮层。
// INV-11 断言：关闭推荐必须先持久化设置再回写引导记录 —— 守住它的位置：closeRecommendations —— 改错故障：设置未落盘，重启后推荐复活。
// INV-12 断言：回写引导记录失败不得阻断关闭流程 —— 守住它的位置：updateRecordPreferences 的 catch —— 改错故障：换号同步失败时用户无法关闭推荐。
// INV-13 断言：埋点必须早于导航与插件解析且不可 await —— 守住它的位置：handleSelect 的 isDesktop 分支 —— 改错故障：网络阻塞点击，或导航后丢事件。
// INV-14 断言：Automations 类推荐项命中后必须直接返回，不触碰 Composer —— 守住它的位置：两个 onOpenAutomations 分支 —— 改错故障：本应跳转的项被写入草稿。
// INV-15 断言：同一时刻只允许一个插件操作 Popover —— 守住它的位置：activeOperationRef 的赋值与校验 —— 改错故障：两个 Popover 抢同一锚点，界面抖动。
// INV-16 断言：确认态必须等 Composer 插入落地后再打开 —— 守住它的位置：waitForComposerTextInsertApplied 之后 —— 改错故障：输入区增高导致浮层先出现在旧坐标。
// INV-17 断言：安装只允许官方 Marketplace 且 sourceTrust 为 official —— 守住它的位置：handleMutation 的前置校验 —— 改错故障：第三方插件被自动安装。
// INV-18 断言：proactive 的窗格必须注册与注销成对 —— 守住它的位置：首个 useEffect 的清理函数 —— 改错故障：轮换 pane 泄漏，推荐项越滚越多。
// INV-19 断言：缺少 onOpenAutomations 时必须过滤掉跳转型推荐项 —— 守住它的位置：items 的 useMemo —— 改错故障：点击无响应或调用未定义函数。
//
import { useIsOfficeMode } from "@/hooks/useInterfaceMode.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useOnboardingRecordService } from "@/hooks/useOnboardingRecordService.js";
import {
  advanceRecommendedPromptPane,
  getRecommendedPromptsForPane,
  getRecommendedPromptsRevision,
  registerRecommendedPromptPane,
  subscribeRecommendedPrompts,
  unregisterRecommendedPromptPane,
} from "@/v4/featureSuggestedPromptRotation.js";
/* oxlint-disable eslint(max-lines) -- 推荐 Prompt 同时收口 latest-wins、取消、可信解析、操作反馈和 Composer 收尾，拆分会打散这条状态机。 */
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import type { AutomationsNavigationTab } from "@/lib/taskNavigationHistory.js";
import { reportPromptTemplateClick } from "@/lib/promptTemplateTelemetry.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/zcodeDraftSkillInvalidation.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  ConversationDraftSuggestedPrompts,
  type DraftSuggestedPromptItem,
} from "@/v4/ConversationDraftSuggestedPrompts.js";
import { buildDraftSuggestedPluginMention } from "@/v4/draftSuggestedPromptPrefill.js";
import { resolveDraftSuggestedPromptText } from "@/v4/draftSuggestedPromptItems.js";
import {
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS,
  DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
} from "@/v4/draftSuggestedPromptItems.js";
import {
  resolveDraftSuggestedPluginFlowStage,
  resolveSuggestedPluginClientBoundary,
  type ConversationDraftSuggestedPromptsContainerProps,
  type DraftSuggestedPluginFlow,
  type DraftSuggestedPluginOperation,
  trackDraftSuggestedPluginOperation,
} from "@/v4/ConversationDraftSuggestedPluginFlow.js";
import { useDraftSuggestedPromptItems } from "@/v4/useDraftSuggestedPromptItems.js";
import { useDraftSuggestedPluginActionPopover } from "@/v4/useDraftSuggestedPluginActionPopover.js";
import { getComposerDraftRevision } from "@/v4/composer/composerDraftRevision.js";
import { useComposerTextInsertApplied } from "@/v4/useComposerTextInsertApplied.js";

// [契约] 两种写操作共用同一条流程与确认文案，因此用联合类型而不是两个回调。
// [权衡] 新增 mutation 种类必须同时补 finishMutation 的文案 id，否则会落到 undefined 的 i18n key。
// [契约] install 需要官方 Marketplace 校验，enable 不需要；这个差异只允许出现在 handleMutation 里。
type PluginMutationKind = "install" | "enable";

// [权衡] 10 秒覆盖官方 Marketplace 的慢网络安装；调小会让正常安装被误判超时。
// [失败路径] 超时不是放弃等待，而是取消远端操作，见 timeoutRequest。
// [契约] 该值必须与服务端安装超时同向，不能一边超时一边继续安装。
const INSTALL_OPERATION_TIMEOUT_MS = 10_000;

type Props = ConversationDraftSuggestedPromptsContainerProps & {
  proactive?: boolean;
  onOpenAutomations?: (automationTab?: AutomationsNavigationTab) => void;
};

// [契约] 仅在 crypto.randomUUID 不可用时作为兜底 id 的一部分，保证同进程内不重复。
// [并发] 自增在 JS 单线程内安全；不要改成随机数，保留可读的时序信息便于排查。
// [权衡] 不持久化：operation id 只在本窗口生命周期内有效。
let draftSuggestedPluginOperationSequence = 0;

// [契约] 每个 operation 携带独立 AbortController，取消一个不会波及其它推荐项。
// [失败路径] randomUUID 在部分 WebView 缺失，因此保留时间戳加序号的兜底路径。
// [并发] 返回值必须立刻写入 activeOperationRef，否则取消时找不到对应 operation。
function createDraftSuggestedPluginOperation(
  requestVersion: number,
): DraftSuggestedPluginOperation {
  return {
    operationId:
      globalThis.crypto?.randomUUID?.() ??
      `suggested-${Date.now()}-${requestVersion}-${++draftSuggestedPluginOperationSequence}`,
    abort: new AbortController(),
  };
}

// [契约] 统一把未知异常转成可展示字符串，避免 catch 里出现 [object Object]。
// [权衡] 这里保留原始 message 供 toast 展示；日志侧仍只记录错误消息，不记录配置内容。
// [失败路径] 非 Error 输入直接 String 化，不进一步分类：分类由调用方的文案决定。
function toPluginMutationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// [契约] 所有跨 Host 能力都来自 props 或 hook，组件本身不解析 workspace 与远程身份。
// [契约] isDesktop 只控制埋点，isWebRemoteControl 只控制插件解析的客户端边界，二者不可互换。
// [权衡] proactive 同时决定推荐来源、布局与关闭入口，拆成多个布尔值会引入非法组合。
// [依赖] 组件假定外层已提供 Intl、Platform 与 Workspace 服务解析上下文。
export function ConversationDraftSuggestedPromptsContainer({
  className,
  proactive = false,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  onOpenAutomations,
  isDesktop = false,
  isWebRemoteControl = false,
}: Props) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const isOfficeMode = useIsOfficeMode();
  const { update } = useSettings();
  const onboardingRecordService = useOnboardingRecordService();
  const recommendationPaneId = useId();
  // [契约] office 与 coding 各自独立的轮换队列，模式切换不能复用另一模式的游标。
  // [权衡] 用 useIsOfficeMode 而不是读设置原文，避免组件与设置结构耦合。
  // [失败路径] 模式变化会触发 pane 重新注册，旧 pane 的注销由 effect 清理函数负责。
  const recommendationMode = isOfficeMode ? "office" : "coding";
  // [并发] 外部 store 的 revision 让组件只在轮换或重置时重算，避免每次渲染都取全量推荐。
  // [契约] subscribe 与 getSnapshot 必须来自同一模块，否则并发渲染会读到撕裂快照。
  // [权衡] 不把推荐列表放进 props：轮换游标属于模块级状态，需要跨实例共享。
  const recommendationRevision = useSyncExternalStore(
    subscribeRecommendedPrompts,
    getRecommendedPromptsRevision,
  );
  useEffect(() => {
    // [契约] 非主动推荐不注册 pane，避免占用轮换队列的槽位。
    // [资源] 注册与注销必须成对，依赖包含 paneId 与 mode，任一变化都会先注销再注册。
    // [权衡] 这里用 effect 而非 useMemo 注册：注册是副作用，严格模式下必须可回滚。
    if (!proactive) return;
    registerRecommendedPromptPane(recommendationPaneId, recommendationMode);
    return () => unregisterRecommendedPromptPane(recommendationPaneId);
  }, [proactive, recommendationMode, recommendationPaneId]);
  // [契约] 推荐项只由 paneId、mode、revision 三个因素决定，workspace 变化不应改变轮换结果。
  // [并发] revision 参与依赖，保证 advance 之后同一渲染周期内拿到新列表。
  // [权衡] 不复用 allItems 的过滤逻辑：主动推荐是另一套来源，二者只在渲染层汇合。
  const recommendedItems = useMemo(
    () => getRecommendedPromptsForPane(recommendationPaneId, recommendationMode),
    [recommendationMode, recommendationPaneId, recommendationRevision],
  );
  const [closing, setClosing] = useState(false);
  // [契约] 关闭是持久化操作，不是纯 UI 隐藏；必须写设置，否则下次启动仍会显示。
  // [失败路径] 设置写入失败会 toast 并保持开启状态，避免用户以为已关闭。
  // [并发] 关闭期间用 closing 禁用重复点击，但不取消正在进行的插件操作。
  const closeRecommendations = async () => {
    setClosing(true);
    try {
      // 关闭按钮与引导、设置页共用持久化设置，避免另一份本地开关重新显示推荐。
      // [契约] proactiveSuggestionsEnabled 是唯一开关，关闭按钮与设置页写同一字段。
      // [失败路径] update 抛错时整个关闭流程失败，符合没有持久化就不算关闭。
      // [权衡] 先写设置再回写引导记录：顺序反了会在设置失败时留下不一致的记录。
      await update({ proactiveSuggestionsEnabled: false });
      // 手动修改反向回写 record，换号同步时不会把已关闭的推荐复活；失败不阻塞关闭流程。
      // [契约] 引导记录是账号级镜像，换号同步时用它恢复开关状态。
      // [失败路径] 回写失败只 warn，不阻塞关闭；设置已经生效，记录可后续收敛。
      // [并发] `onboardingRecordService?.updateRecordPreferences` 用可选链：该服务在部分平台不存在。
      await onboardingRecordService
        ?.updateRecordPreferences({ proactiveSuggestionsEnabled: false })
        .catch((cause: unknown) => {
          logger.warn("[v4-suggested-prompts] 回写引导记录失败", { error: String(cause) });
        });
    } catch (error) {
      logger.warn("[v4-suggested-prompts] 关闭推荐失败", { error: String(error) });
      toast(intl.formatMessage({ id: "chat.officeSuggestions.closeError" }));
    } finally {
      setClosing(false);
    }
  };
  // [契约] workspace 服务解析可能尚未就绪，rpcReady 决定 plugin 流程是否可走。
  // [失败路径] 未就绪时服务对象仍可能是代理，调用会 reject 并被 catch 捕获。
  // [依赖] 远程身份来自 resolution.remoteSessionId，不能直接用 props 里的 remoteSessionId。
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // Plugin RPC 是异步的；草稿、Popover 和 chip 都只允许最后一次点击收尾。
  // [并发] `requestVersionRef` 只增不减，用来丢弃所有基于旧点击的异步结果。
  // [契约] 每次 handleSelect 入口自增；内部流程只读不写，避免中途改变自己的基线。
  // [失败路径] 忘记在 await 后比较版本，是本文件最容易引入的竞态回归。
  const requestVersionRef = useRef(0);
  const activeOperationRef = useRef<DraftSuggestedPluginOperation | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // [契约] 身份 key 统一为 workspaceIdentity 去空白或 workspacePath，与 Host 侧口径一致。
  // [契约] 只用于日志与本地比较，不参与远端请求参数拼接。
  // [失败路径] 用路径代替 identity 会让同一工作区的不同远端身份混在一起。
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  // [契约] 非主动推荐来自 useDraftSuggestedPromptItems，组件不直接调用 clientScenesService。
  // [并发] rpcReady 为 false 时 hook 返回空列表，渲染层自然退化为不显示。
  // [权衡] 把 workspaceKey 传给 hook 而不是在组件内拼请求，保持一致的去重口径。
  const allItems = useDraftSuggestedPromptItems({
    clientScenesService: resolution.services.clientScenesService,
    rpcReady: resolution.rpcReady,
    workspaceKey,
  });
  // [契约] Automations 跳转项只有在调用方提供 onOpenAutomations 时才出现。
  // [权衡] 过滤放在渲染层而非数据源，保证同一份推荐可被不同容器复用。
  // [失败路径] 漏掉过滤会出现可点击但无处理函数的空操作项。
  const items = useMemo(
    () =>
      (proactive ? recommendedItems : allItems).filter(
        (item) =>
          !item.actions?.some(
            (action) =>
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS ||
              action === DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK,
          ) || Boolean(onOpenAutomations),
      ),
    [allItems, onOpenAutomations, proactive, recommendedItems],
  );
  const {
    // [契约] Popover 状态由 hook 持有，组件只读取投影，不复制一份本地状态。
    // [失败路径] clear 需要 operationId 才能只关闭对应操作，传空会清掉所有反馈。
    clearPluginActionPopover,
    pluginActionPopover,
    showPluginActionPopover,
    showPluginActionResultPopover,
  } = useDraftSuggestedPluginActionPopover();
  // [契约] 包一层 useCallback 是为了稳定引用，避免清理 effect 每次渲染都重新执行。
  // [权衡] 不在此处取消 operation：清反馈与取消是两件事，取消需要额外 RPC。
  // [失败路径] 只清 UI 不取消 operation 时，迟到结果仍会被版本守卫拦住。
  const clearOperationFeedback = useCallback(
    (operationId?: string) => {
      clearPluginActionPopover(operationId);
    },
    [clearPluginActionPopover],
  );
  // [契约] 等待 Composer 真正应用插入，而不是等 requestComposerTextInsert 返回。
  // [失败路径] 传 abort signal 让取消的等待立即结束，不占用后续流程。
  const waitForComposerTextInsertApplied = useComposerTextInsertApplied(
    workspacePath,
    workspaceIdentity,
  );

  // [契约] 只有存在的可选字段才展开，避免把 undefined 显式传给 RPC 造成 schema 失败。
  // [契约] remoteSessionId 取解析结果而不是 props，保证与当前 Host 绑定一致。
  // [依赖] 依赖数组只列原始值，防止对象身份变化导致回调重建。
  const targetParams = useCallback(
    () => ({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(resolution.remoteSessionId ? { remoteSessionId: resolution.remoteSessionId } : {}),
    }),
    [resolution.remoteSessionId, workspaceIdentity, workspacePath],
  );

  // [并发] cancellation 缓存保证同一 operation 的重复取消只发一次 RPC。
  // [失败路径] 取消 RPC 失败只 warn：本地 abort 已生效，迟到结果仍被版本与 abort 双重拦截。
  // [资源] finally 等待 pending 收敛并清空 activeOperationRef，避免悬挂的 operation 影响下一次点击。
  const cancelOperation = useCallback(
    (operation: DraftSuggestedPluginOperation): Promise<void> => {
      // [契约] 返回同一个 promise，调用方可以安全地重复 await。
      // [失败路径] abort 先于 RPC 执行：即使服务端取消失败，本地也不再接受结果。
      // [并发] 不在 finally 里抛错，保证取消是幂等且不破坏调用方流程的。
      if (operation.cancellation) return operation.cancellation;
      operation.abort.abort();
      operation.cancellation = (async () => {
        try {
          await resolution.services.pluginManagementService.cancelPluginOperation({
            operationId: operation.operationId,
          });
        } catch (error) {
          logger.warn("[v4-suggested-prompts] 取消旧插件操作失败，继续丢弃其迟到结果", {
            operationId: operation.operationId,
            error: error instanceof Error ? error.message : String(error),
            workspaceKey,
          });
        } finally {
          await operation.pending?.catch(() => undefined);
          if (activeOperationRef.current === operation) {
            activeOperationRef.current = null;
          }
        }
      })();
      return operation.cancellation;
    },
    [resolution.services.pluginManagementService, workspaceKey],
  );

  useEffect(() => {
    return () => {
      // workspace/attachment 切换后立即移除旧反馈，远端迟到结果继续由版本与 abort 双重拦截。
      requestVersionRef.current += 1;
      clearOperationFeedback();
      // [资源] 清理必须取消活动 operation，否则切换 Host 后旧 RPC 仍在跑。
      // [并发] 版本自增先于取消，保证取消过程中到达的结果已经过期。
      // [契约] 依赖包含 remoteSessionId 与 workspaceKey：同一路径换远端身份也要清理。
      const active = activeOperationRef.current;
      if (active) void cancelOperation(active);
    };
  }, [cancelOperation, clearOperationFeedback, resolution.remoteSessionId, workspaceKey]);

  // [契约] 只有版本仍是最新时才写入 Composer，返回 null 表示本次结果应被丢弃。
  // [契约] mention 由可信解析结果构造，不再读 referenceCatalog，避免二次 RPC 与校验分叉。
  // [权衡] prepend-if-missing 让正文已有同一插件时不重复插入。
  const prependResolvedPlugin = useCallback(
    (plugin: { stableId: string; label: string }, requestVersion: number, icon?: string) => {
      if (requestVersion !== requestVersionRef.current) return null;
      // 推荐流程的状态与展示图标都由目标 Host 的同一次可信解析返回；当前不存在
      // workspace 级 Plugin，再读取 referenceCatalog 会重复校验并引入额外 RPC。
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(
          workspacePath,
          mention.markdown,
          workspaceIdentity,
          mention,
          "prepend-if-missing",
        );
    },
    [workspaceIdentity, workspacePath],
  );

  // [契约] expectedRevision 存在时必须同时校验版本与草稿 revision，缺一不可。
  // [失败路径] revision 不匹配返回 null，调用方据此关闭流程而不是覆盖用户编辑。
  // [契约] 不传 expectedRevision 的调用只用于用户刚刚点击、尚未插入其它内容的场景。
  const replacePlainPrompt = useCallback(
    (prompt: string, requestVersion: number, expectedRevision?: number) => {
      if (
        requestVersion !== requestVersionRef.current ||
        (expectedRevision !== undefined &&
          getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision)
      ) {
        return null;
      }
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, prompt, workspaceIdentity);
    },
    [workspaceIdentity, workspacePath],
  );

  // [契约] 版本与 draftRevision 双重校验后才允许写入。
  // [契约] 写入方式取决于正文是否已有插件引用，decision 在本函数内一次完成。
  // [失败路径] 返回 null 表示放弃，不得再回退到普通 prompt 写入。
  const replaceWithResolvedPluginAndPrompt = useCallback(
    (
      plugin: { stableId: string; label: string },
      prompt: string,
      requestVersion: number,
      expectedRevision: number,
      icon?: string,
    ) => {
      if (
        requestVersion !== requestVersionRef.current ||
        getComposerDraftRevision(workspacePath, workspaceIdentity) !== expectedRevision
      ) {
        return null;
      }
      // [契约] 正文已有任意插件引用时，交给 Composer 统一解析全部内联提及。
      // [权衡] 目标插件已存在则保留原位置，否则只补一次前置引用；旧路径会让其余引用退化为裸文本。
      // [失败路径] 用 stableId 精确匹配，不能用 label，label 可被本地化。
      if (prompt.includes("](plugin://")) {
        // 正文已有插件引用时交给 Composer 解析全部内联提及。目标插件已在正文中就保留
        // 原位置，否则只补一次前置引用；单个 mention 的旧路径会让其余引用退化为裸文本。
        const hasTarget = prompt.includes(`(plugin://${plugin.stableId})`);
        const text = hasTarget
          ? prompt
          : `${buildDraftSuggestedPluginMention(plugin, icon).markdown} ${prompt}`;
        return useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(workspacePath, text, workspaceIdentity);
      }
      const mention = buildDraftSuggestedPluginMention(plugin, icon);
      const text = prompt.trim() ? `${mention.markdown} ${prompt.trim()}` : mention.markdown;
      return useZCodeSessionStore
        .getState()
        .requestComposerTextInsert(workspacePath, text, workspaceIdentity, mention);
    },
    [workspaceIdentity, workspacePath],
  );

  // [契约] 变更插件前必须失效延迟草稿会话，否则旧 skill 快照继续生效。
  // [并发] 失效与解析之间都要重查版本，任一步之后过期都返回 null。
  // [失败路径] 解析结果不是 checking 时返回 null：插件已变化，不能按旧结论写入。
  const revalidateAndPrependPlugin = useCallback(
    async (current: DraftSuggestedPluginFlow, requestVersion: number) => {
      await invalidateDeferredDraftSessionForSkillChange({
        workspacePath,
        workspaceIdentity,
        reason: "suggested-prompt-plugin-change",
      });
      if (requestVersion !== requestVersionRef.current) return null;
      const resolved =
        await resolution.services.pluginManagementService.resolveSuggestedPluginReference({
          ...targetParams(),
          ...resolveSuggestedPluginClientBoundary(isWebRemoteControl),
          stableId: current.plugin.stableId,
          operationId: current.operationId,
        });
      if (requestVersion !== requestVersionRef.current) return null;
      if (resolveDraftSuggestedPluginFlowStage(resolved) !== "checking") return null;
      return prependResolvedPlugin(current.plugin, requestVersion, resolved.icon);
    },
    [
      isWebRemoteControl,
      prependResolvedPlugin,
      resolution.services.pluginManagementService,
      targetParams,
      workspaceIdentity,
      workspacePath,
    ],
  );

  // [契约] 成功文案按 kind 区分，安装成功不能复用启用成功的 i18n key。
  // [并发] 只有 operationId 仍是活动操作时才清空引用，防止清掉后来者的引用。
  // [失败路径] succeeded 只影响文案与样式，不在这里触发重试。
  const finishMutation = useCallback(
    (flow: DraftSuggestedPluginFlow, kind: PluginMutationKind, succeeded: boolean) => {
      const active = activeOperationRef.current;
      if (active?.operationId === flow.operationId) activeOperationRef.current = null;
      // 成功态不能固定使用 installSucceeded，否则仅启用已安装插件时误显示“安装成功”。
      const messageId = `chat.draft.suggestedPrompt.pluginFlow.${kind}${
        succeeded ? "Succeeded" : "Failed"
      }`;
      showPluginActionResultPopover(flow, messageId, succeeded);
    },
    [showPluginActionResultPopover],
  );

  // [契约] 确认与取消都绑定同一 operation 与 requestVersion，避免旧确认作用于新流程。
  // [失败路径] onDismiss 必须清反馈并取消 operation，否则迟到结果会继续写 Composer。
  // [权衡] 取消不再依赖固定倒计时：倒计时会打断阅读且无法表达明确取消。
  const showMutationConfirmation = useCallback(
    (
      flow: DraftSuggestedPluginFlow,
      operation: DraftSuggestedPluginOperation,
      requestVersion: number,
      kind: PluginMutationKind,
      onAction: () => void,
    ) => {
      showPluginActionPopover(
        flow,
        `chat.draft.suggestedPrompt.pluginFlow.${kind}Confirmation`,
        "confirmation",
        {
          label: intl.formatMessage({
            id: "chat.draft.suggestedPrompt.pluginFlow.confirm",
          }),
          onAction,
          onDismiss: () => {
            if (
              requestVersion !== requestVersionRef.current ||
              activeOperationRef.current !== operation
            ) {
              return;
            }
            // 确认态曾依赖固定倒计时退出，既会打断仍在阅读的用户，也无法表达明确取消意图。
            // 现在仅由 Popover 外部主指针点击关闭，并取消同一 operation 以继续拦截迟到结果。
            clearOperationFeedback(operation.operationId);
            void cancelOperation(operation);
          },
        },
      );
    },
    [cancelOperation, clearOperationFeedback, intl, showPluginActionPopover],
  );

  // [契约] 入口重新校验 operation 身份、版本以及安装来源，任一不符直接返回。
  // [失败路径] 返回而不是抛错：这属于过期操作，不应该在 UI 上产生失败提示。
  // [契约] install 与 enable 共用后续解析、插入与结果流程，只在写操作处分支。
  const handleMutation = useCallback(
    async function runPluginMutation(
      flow: DraftSuggestedPluginFlow,
      requestVersion: number,
      kind: PluginMutationKind,
    ) {
      const operation = activeOperationRef.current;
      if (
        !operation ||
        operation.operationId !== flow.operationId ||
        requestVersion !== requestVersionRef.current ||
        (kind === "install" &&
          (!flow.result?.pluginName ||
            flow.result.marketplace !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID ||
            flow.result.sourceTrust !== "official"))
      ) {
        return;
      }
      showPluginActionPopover(
        flow,
        kind === "install"
          ? "chat.draft.suggestedPrompt.pluginFlow.installing"
          : "chat.draft.suggestedPrompt.pluginFlow.enabling",
        "progress",
      );
      let installTimedOut = false;
      let mutationCompleted = false;
      // [契约] 失败后换新 operation 恢复确认态，让用户可以立即重试。
      // [并发] 旧 operation 先 abort，再登记新 operation，防止超时结果覆盖重试状态。
      // [失败路径] 失败只提示一次 toast，不写本地设置，也不关闭推荐。
      // [权衡] 保留原 flow 的其余字段，只替换 operationId，避免丢失锚点信息。
      const restoreInstallConfirmation = (errorMessage: string) => {
        // 安装失败结果态会把操作入口一起收走；恢复同一 PopoverContent 并换新 operation，
        // 既允许立即重试，也防止超时或失败的旧 operation 迟到覆盖新状态。
        operation.abort.abort();
        const retryOperation = createDraftSuggestedPluginOperation(requestVersion);
        const retryFlow: DraftSuggestedPluginFlow = {
          ...flow,
          operationId: retryOperation.operationId,
        };
        activeOperationRef.current = retryOperation;
        logger.warn("[v4-suggested-prompts] 推荐插件安装失败，恢复确认态以便重试", {
          error: errorMessage,
          operationId: flow.operationId,
          pluginId: flow.plugin.stableId,
          workspaceKey,
        });
        toast(
          intl.formatMessage(
            { id: "chat.draft.suggestedPrompt.pluginFlow.installFailureToast" },
            { pluginLabel: flow.plugin.label, error: errorMessage },
          ),
          { variant: "warning" },
        );
        showMutationConfirmation(
          retryFlow,
          retryOperation,
          requestVersion,
          "install",
          () => void runPluginMutation(retryFlow, requestVersion, "install"),
        );
      };
      try {
        if (kind === "install") {
          let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
          const installRequest = resolution.services.pluginManagementService.installPlugin({
            ...targetParams(),
            telemetry: {
              entry: "recommended_prompt",
              client_kind: isWebRemoteControl ? "mobile" : "desktop",
            },
            pluginName: flow.result!.pluginName!,
            marketplace: flow.result!.marketplace!,
            scope: "user",
            operationId: flow.operationId,
          });
          // [资源] finally 清理定时器，无论成功、失败还是超时都不留下悬挂的 timer。
          // [并发] 与 timeoutRequest 通过 Promise.race 竞争，只允许一个结果生效。
          // [失败路径] 定时器在超时后必须自行清理，否则 race 已结算仍占着句柄。
          // [契约] 这里不吞错：安装错误继续向上抛给 catch 分类。
          const timedInstallRequest = installRequest.finally(() => {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
          });
          // [失败路径] 超时先 cancelOperation 再 reject，让远端停止写入。
          // [契约] 只 reject 不 resolve，保证 race 的失败分支可被 catch 识别。
          // [并发] installTimedOut 标记用于区分用户取消与安装超时，catch 据此决定是否恢复确认态。
          // [权衡] 超时文案通过 intl 生成，随当前语言变化。
          const timeoutRequest = new Promise<never>((_, reject) => {
            // 安装超时后必须主动取消同一 operation；仅结束 UI 等待会允许远端迟到成功继续污染草稿。
            timeoutHandle = setTimeout(() => {
              installTimedOut = true;
              void cancelOperation(operation);
              reject(
                new Error(
                  intl.formatMessage({
                    id: "chat.draft.suggestedPrompt.pluginFlow.installTimedOut",
                  }),
                ),
              );
            }, INSTALL_OPERATION_TIMEOUT_MS);
          });
          // [契约] trackDraftSuggestedPluginOperation 把异常收敛到 operation 的 abort 语义内。
          // [失败路径] result 为 null 表示操作被取消，主流程直接 return，不进入成功分支。
          // [契约] 诊断中的 error 与空 installedPlugins 都视为安装失败。
          const result = await trackDraftSuggestedPluginOperation(
            operation,
            Promise.race([timedInstallRequest, timeoutRequest]),
          );
          const errorDiagnostic = result.diagnostics.find(
            (diagnostic) => diagnostic.severity === "error",
          );
          if (errorDiagnostic || result.installedPlugins.length === 0) {
            restoreInstallConfirmation(
              errorDiagnostic?.message ??
                intl.formatMessage({
                  id: "chat.draft.suggestedPrompt.pluginFlow.installReturnedEmpty",
                }),
            );
            return;
          }
        } else {
          await trackDraftSuggestedPluginOperation(
            operation,
            resolution.services.pluginManagementService.setPluginEnabled({
              ...targetParams(),
              telemetry: {
                entry: "recommended_prompt",
                client_kind: isWebRemoteControl ? "mobile" : "desktop",
              },
              pluginId: flow.plugin.stableId,
              enabled: true,
              operationId: flow.operationId,
            }),
          );
        }
        // [契约] 置位表示服务端写操作已成功，后续失败不能再走恢复确认态重试。
        // [失败路径] 否则用户会重复安装同一个插件，产生重复副作用。
        // [并发] 置位在 abort 检查之前，保证取消不会被误判为安装失败。
        mutationCompleted = true;
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        // [契约] 解析后写入 Composer，返回的 requestId 用于等待真正的应用结果。
        // [失败路径] 为 null 表示插件已变化或版本过期，按 mutation 失败收尾但不重试。
        // [并发] 每一步之间都重查 abort 与版本，减少无谓的 Composer 写入。
        const composerRequestId = await trackDraftSuggestedPluginOperation(
          operation,
          revalidateAndPrependPlugin(flow, requestVersion),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (composerRequestId === null) {
          finishMutation(flow, kind, false);
          return;
        }
        const applied = await trackDraftSuggestedPluginOperation(
          operation,
          waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        finishMutation(flow, kind, applied);
      } catch (error) {
        if (
          (operation.abort.signal.aborted && !installTimedOut) ||
          requestVersion !== requestVersionRef.current
        )
          return;
        if (kind === "install" && !mutationCompleted) {
          restoreInstallConfirmation(toPluginMutationErrorMessage(error));
          return;
        }
        logger.warn(`[v4-suggested-prompts] 推荐插件${kind === "install" ? "安装" : "启用"}失败`, {
          error: toPluginMutationErrorMessage(error),
          operationId: flow.operationId,
          pluginId: flow.plugin.stableId,
          workspaceKey,
        });
        finishMutation(flow, kind, false);
      }
    },
    [
      cancelOperation,
      finishMutation,
      intl,
      revalidateAndPrependPlugin,
      resolution.services.pluginManagementService,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceKey,
    ],
  );

  // [契约] 选择入口是唯一的版本自增点，所有子流程共享本次 requestVersion。
  // [契约] 先埋点再导航，保证点击事实不被后续分支吞掉。
  // [失败路径] 任何提前 return 都要保证没有遗留的 Popover 或订阅。
  const handleSelect = useCallback(
    async (item: DraftSuggestedPromptItem) => {
      // [并发] 先算新值再赋值，避免在中间状态被其它回调读到。
      // [契约] 自增必须发生在任何 await 之前，否则旧流程仍有窗口写回。
      // [失败路径] 若两次点击落在同一事件循环，第二个版本号会正确覆盖第一个。
      const requestVersion = requestVersionRef.current + 1;
      requestVersionRef.current = requestVersion;
      const templateName = resolveDraftSuggestedPromptText(item.label, locale);
      const prompt = resolveDraftSuggestedPromptText(item.prompt, locale);
      // [契约] 埋点是旁路观测，必须 void 掉 promise，不能让它阻塞点击。
      // [契约] 只在桌面触发：Web 端由另一条链路统计，重复上报会翻倍。
      // [失败路径] reportPromptTemplateClick 内部失败不应影响后续任何分支。
      if (isDesktop) {
        // 埋点是旁路观测，必须早于导航或异步插件解析，且不能阻塞既有交互。
        void reportPromptTemplateClick(platform, {
          templateId: item.id,
          templateName,
          templatePrompt: prompt,
        });
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS_OFFPEAK)
      ) {
        onOpenAutomations("idle");
        return;
      }
      if (
        onOpenAutomations &&
        item.actions?.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)
      ) {
        onOpenAutomations();
        return;
      }
      // [契约] 只在 item.plugin 存在时构造，label 在这里本地化一次，供后续所有流程复用。
      // [契约] stableId 不做二次解析，它已经是可信标识。
      // [失败路径] 不要在此处补默认 icon：icon 必须来自解析结果。
      const plugin = item.plugin
        ? {
            stableId: item.plugin.stableId,
            label: resolveDraftSuggestedPromptText(item.plugin.label, locale),
          }
        : undefined;

      // 无 Plugin 的推荐项没有远端校验，继续立即替换普通草稿；Plugin-backed 推荐项必须等
      // 可信解析后一次性决定写入纯 prompt 还是 Plugin + prompt，避免 Composer 两阶段更新。
      // [契约] 无插件或 RPC 未就绪时立即替换草稿，这条路径不产生 Popover。
      // [失败路径] 之后必须 return，避免继续走插件解析写出第二个版本。
      // [权衡] 先写草稿再取消旧 operation，是为了让用户立刻看到反馈。
      if (!plugin || !resolution.rpcReady) {
        replacePlainPrompt(prompt, requestVersion);
      }

      // [并发] 手动切换视为预期接管：`activeOperationRef` 的旧操作取消但不提示取消。
      // [契约] 必须先清旧反馈再取消，否则旧 Popover 会残留在新流程的锚点上。
      // [失败路径] 取消后重查版本，若期间又有新点击则放弃本次。
      const previous = activeOperationRef.current;
      if (previous) {
        // 手动切换推荐项属于预期接管：关闭旧反馈，但不显示取消或中断提示。
        clearOperationFeedback(previous.operationId);
        setCancelling(true);
        await cancelOperation(previous);
        if (requestVersion !== requestVersionRef.current) return;
        setCancelling(false);
      }
      if (!plugin || !resolution.rpcReady) return;
      // 在旧 operation 取消收敛后再取基线：旧 operation 可能刚把自己的普通 prompt
      // 交给 Composer 消费；它属于本次推荐流程的程序性写入，不应让新推荐项被误判为用户编辑。
      // [契约] 基线必须在旧 operation 收敛之后取，否则会把它刚写入的 prompt 当成用户编辑。
      // [契约] 该 revision 用于后续所有写入前的一致性校验。
      // [失败路径] 取基线本身是同步的，不需要等待。
      const draftRevision = getComposerDraftRevision(workspacePath, workspaceIdentity);

      // [契约] 每个推荐项点击生成独立 operation，登记为当前活动操作。
      // [并发] 登记之后才能订阅进度，否则进度事件到达时找不到活动操作。
      // [失败路径] 未登记就发请求会在取消时漏掉本 operation。
      const operation = createDraftSuggestedPluginOperation(requestVersion);
      activeOperationRef.current = operation;
      const checkingFlow: DraftSuggestedPluginFlow = {
        anchorItemId: item.id,
        operationId: operation.operationId,
        plugin,
        stage: "unavailable",
      };
      // missing 的可信解析需要等待官方 Marketplace 刷新，旧流程直到请求完成才
      // 打开确认 Popover，网络等待期间看起来像点击卡住。先订阅同一 operation 的本地检查结果，
      // 只更新现有唯一 Popover 的 phase，后续确认/操作/结果继续复用同一挂载点。
      // [契约] 进度订阅只用于把 checking 提前展示，不改变最终阶段判定。
      // [并发] 回调里同时校验 aborted、活动操作身份、版本与 draftRevision，任一不符即忽略。
      // [失败路径] 订阅必须在 finally dispose，否则每次点击都会多一个监听。
      // [权衡] 复用同一个 Popover 只改 phase，避免多浮层争夺同一锚点。
      const progressSubscription =
        resolution.services.pluginManagementService.onDynamicPluginOperationProgress(
          operation.operationId,
        )((event) => {
          if (
            event.state !== "refreshing" ||
            operation.abort.signal.aborted ||
            activeOperationRef.current !== operation ||
            requestVersion !== requestVersionRef.current ||
            getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision
          ) {
            return;
          }
          showPluginActionPopover(
            checkingFlow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
        });
      try {
        const result = await trackDraftSuggestedPluginOperation(
          operation,
          resolution.services.pluginManagementService.resolveSuggestedPluginReference({
            ...targetParams(),
            ...resolveSuggestedPluginClientBoundary(isWebRemoteControl),
            stableId: plugin.stableId,
            operationId: operation.operationId,
          }),
        );
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        if (getComposerDraftRevision(workspacePath, workspaceIdentity) !== draftRevision) {
          clearOperationFeedback(operation.operationId);
          activeOperationRef.current = null;
          return;
        }
        const flow: DraftSuggestedPluginFlow = {
          anchorItemId: item.id,
          operationId: operation.operationId,
          plugin,
          result,
          stage: resolveDraftSuggestedPluginFlowStage(result),
        };
        // [契约] 已可用时一次性写入插件 mention 与 prompt，不打开确认 Popover。
        // [失败路径] 写入后仍要重查 abort 与版本，再清理活动操作。
        // [契约] 这里清空 activeOperationRef，表示流程结束，不需要取消。
        if (flow.stage === "checking") {
          replaceWithResolvedPluginAndPrompt(
            flow.plugin,
            prompt,
            requestVersion,
            draftRevision,
            result.icon,
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          activeOperationRef.current = null;
          clearOperationFeedback(flow.operationId);
          return;
        }
        // [契约] 先把同一 Popover 置为 checking，再写入纯 prompt，避免等待期间看起来卡住。
        // [失败路径] composerRequestId 为 null 时关闭反馈并结束，不进入确认态。
        // [契约] 安装与启用只在 `flow.stage` 走到插入落地后才打开确认，见下一条。
        if (flow.stage === "missing" || flow.stage === "disabled") {
          // disabled 无需刷新 Marketplace，不一定有 Agent 进度通知；在写入纯 prompt 前也先让
          // 同一个 Popover 进入 checking，随后等待 Composer 落地并原地切换确认态。
          showPluginActionPopover(
            flow,
            "chat.draft.suggestedPrompt.pluginFlow.checking",
            "progress",
          );
          const composerRequestId = replacePlainPrompt(prompt, requestVersion, draftRevision);
          if (composerRequestId === null) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          // 确认 Popover 先于 Composer 消费纯 prompt 打开时，输入区随后增高会让
          // 推荐项锚点整体移动，浮层因而先按旧坐标出现再跳位。安装与开启都等插入落地后再测量锚点。
          const applied = await trackDraftSuggestedPluginOperation(
            operation,
            waitForComposerTextInsertApplied(composerRequestId, operation.abort.signal),
          );
          if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current)
            return;
          if (!applied) {
            clearOperationFeedback(flow.operationId);
            activeOperationRef.current = null;
            return;
          }
          // [契约] missing 走安装，disabled 走启用；两者文案与 RPC 不同但流程共用。
          // [失败路径] 这里不能把 disabled 当 missing，否则会对已安装插件重复安装。
          // [契约] 确认回调在点击时才调用 handleMutation，避免提前触发写操作。
          const kind: PluginMutationKind = flow.stage === "missing" ? "install" : "enable";
          showMutationConfirmation(
            flow,
            operation,
            requestVersion,
            kind,
            () => void handleMutation(flow, requestVersion, kind),
          );
          return;
        }
        // [契约] 非需要确认的阶段直接写普通 prompt，并关闭本 operation 的反馈。
        // [失败路径] 该调用不传 revision，因为 draftRevision 已在入口校验过。
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(flow.operationId);
        activeOperationRef.current = null;
      } catch (error) {
        if (operation.abort.signal.aborted || requestVersion !== requestVersionRef.current) return;
        // [失败路径] 解析失败时回退到普通 prompt，保证点击仍有可见结果。
        // [契约] 日志只记录错误消息与 pluginId，不记录用户输入内容。
        // [并发] 回退写入同样受版本与 revision 校验，过期则不写。
        logger.warn("[v4-suggested-prompts] 推荐插件可信解析失败", {
          error: error instanceof Error ? error.message : String(error),
          pluginId: plugin.stableId,
          workspaceKey,
        });
        replacePlainPrompt(prompt, requestVersion, draftRevision);
        clearOperationFeedback(operation.operationId);
        activeOperationRef.current = null;
      } finally {
        // [资源] finally 统一释放，无论成功、失败、取消还是提前 return。
        // [失败路径] 漏掉 dispose 会让旧订阅继续触发 showPluginActionPopover。
        // [并发] dispose 只解绑本 operation 的进度，不影响其它推荐项。
        progressSubscription.dispose();
      }
    },
    [
      cancelOperation,
      clearOperationFeedback,
      isDesktop,
      isWebRemoteControl,
      locale,
      onOpenAutomations,
      platform,
      replacePlainPrompt,
      replaceWithResolvedPluginAndPrompt,
      resolution.rpcReady,
      resolution.services.pluginManagementService,
      handleMutation,
      showMutationConfirmation,
      showPluginActionPopover,
      targetParams,
      waitForComposerTextInsertApplied,
      workspaceIdentity,
      workspaceKey,
      workspacePath,
    ],
  );

  return (
    <div data-v4-draft-suggested-prompts-slot="true" className={cn(!proactive && "h-8", className)}>
      <ConversationDraftSuggestedPrompts
        // 绝对定位让推荐区脱离 Composer 的正常结构，调试和间距语义都不直观。
        // 旧场景推荐保留固定槽位；主动推荐列表必须由内容撑高，否则多行会溢出并覆盖下方内容。
        items={items}
        layout={proactive ? "list" : "chips"}
        onSelect={handleSelect}
        onRefresh={proactive ? () => advanceRecommendedPromptPane(recommendationPaneId) : undefined}
        onClose={proactive ? closeRecommendations : undefined}
        disabled={cancelling || closing}
        refreshDisabled={Boolean(pluginActionPopover)}
        pluginActionPopover={pluginActionPopover}
      />
    </div>
  );
}
