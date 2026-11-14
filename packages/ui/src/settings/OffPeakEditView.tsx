/* eslint-disable max-lines -- 闲时任务整页集中维护创建/编辑/History 与 composer 项目、权限、模型工具条，拆分会割裂表单状态。 */
/* 闲时任务创建/编辑整页。composer 范式：页标题 +
   返回行 + 内联保持电脑运行开关 + Settings/History tab + 标题输入 + 大 composer 盒
   （textarea + 工具条：项目/权限｜模型/推理档位）。权限四档默认 build，模型走白名单（D31）。 */
// ===== 深度注释：闲时任务创建/编辑整页 =====
// 职责边界（做什么 / 不做什么 / 依赖谁）：
// - 做：维护闲时任务表单草稿（标题、指令、权限档、模型、推理档、项目），提供脏检测、丢弃确认与提交。
// - 做：按 status 计算只读态，并在 Settings/History 两个 tab 间切换；History 复用独立组件。
// - 不做：不直接调用 Repo/Service 写任务；提交只通过 onSubmit 交给上层，运行态与历史由 Host 持久化。
// - 不做：不自行推导模型能力与推理档；全部读 Host 投影的 ModelSelectionView 与 ConfigOption。
// - 依赖：useSettings（keepAwake）、useAutomationProjectOptions（本机项目）、intl、toast、共享自动化 UI 原语。
//
// 不变量（INV，改动前逐条确认）：
// INV-01 断言：编辑态以 editing 为唯一事实，创建态才允许选项目 —— 守住它的位置：项目选择分支 —— 改错故障：编辑已有任务时把项目改掉，任务与原项目脱钩。
// INV-02 断言：createBlocked 只限制创建，不影响编辑 —— 守住它的位置：canSubmit —— 改错故障：套餐不可用时连已有任务的保存也被禁用。
// INV-03 断言：readOnly 仅由 status 决定（queued/paused 可编辑，其余只读） —— 守住它的位置：readOnly 计算 —— 改错故障：running 任务被改写导致运行时与表单分叉。
// INV-04 断言：readOnlyRef 必须在渲染期同步赋值 —— 守住它的位置：readOnly 之后 —— 改错故障：异步 handleBack 读到旧值，绕过只读保护。
// INV-05 断言：initialRef 只在首渲染建立快照 —— 守住它的位置：useRef 初始化 —— 改错故障：每次渲染重置快照，dirty 永远为 false，改动被静默丢弃。
// INV-06 断言：projectKey 只参与创建态 dirty 判断 —— 守住它的位置：dirty 表达式 —— 改错故障：编辑态把不可变项目算成改动，返回时反复弹确认。
// INV-07 断言：有未保存改动时返回必须先确认 —— 守住它的位置：handleBack —— 改错故障：误点返回直接丢草稿。
// INV-08 断言：默认标题随 locale 更新，但用户触碰后不再替换 —— 守住它的位置：title 同步 effect —— 改错故障：语言切换覆盖用户输入。
// INV-09 断言：titleTouchedRef 一旦为 true 不回退 —— 守住它的位置：标题 onChange —— 改错故障：清空标题后又被默认值填回。
// INV-10 断言：模型候选只来自 modelSelectionView 白名单 —— 守住它的位置：allowedModels —— 改错故障：提交了 Host 不认识的模型，任务创建失败。
// INV-11 断言：allowedModels 为空时不可提交 —— 守住它的位置：canSubmit —— 改错故障：提交空模型，服务端拒绝且无提示。
// INV-12 断言：推理档通过 completeNewModelSelection 解析 —— 守住它的位置：handleModelChange/初值 —— 改错故障：按模型名硬编码档位，换模型后档位错乱。
// INV-13 断言：buildOffPeakSubmissionModelSelection 只在有值时带 options —— 守住它的位置：提交构造 —— 改错故障：空字符串被当成合法档位写进任务。
// INV-14 断言：workspacePath 编辑态取 editing，创建态取选中项目 —— 守住它的位置：workspacePath 计算 —— 改错故障：创建态提交空路径，任务无法定位工作区。
// INV-15 断言：workspaceIdentity 只在编辑态透传 —— 守住它的位置：提交对象展开 —— 改错故障：创建态塞入 identity，Host 拒绝或错绑远端。
// INV-16 断言：只有 onSubmit 返回 true 才离开页面 —— 守住它的位置：handleSubmit —— 改错故障：失败后清空表单，用户需重新填写。
// INV-17 断言：非 yolo 的权限提示每次挂载只弹一次 —— 守住它的位置：fullAccessWarningShownRef —— 改错故障：每次提交都打扰用户。
// INV-18 断言：该提示是 info 而不是 warning —— 守住它的位置：showToast 参数 —— 改错故障：中性建议被渲染成橙色风险告警。
// INV-19 断言：saving 期间禁止重复提交 —— 守住它的位置：canSubmit —— 改错故障：双击创建出两条任务。
// INV-20 断言：权限档复用 buildAutomationModeOption —— 守住它的位置：modeOption —— 改错故障：闲时与定时任务的权限词表分叉。
// INV-21 断言：keepAwake 直接写 settings，不进入表单草稿 —— 守住它的位置：开关 onChange —— 改错故障：开关状态随页面离开而丢失。
// INV-22 断言：测试 id（TID_*）保持稳定 —— 守住它的位置：提交按钮与表单 —— 改错故障：E2E 定位失败。
//
// 标注约定：[契约] 提交结构；[并发] 异步返回；[权衡] 只读与可编辑的边界。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelSelectionView } from "@zcode/services";
import { completeNewModelSelection } from "@zcode/provider";
import { FolderOpen } from "lucide-react";
import {
  ZCODE_AGENT_PROVIDER,
  type ZCodeConfigOption,
  type ZCodeOffPeakTask,
  type ModelSelection,
} from "@zcode/shared";
import {
  TID_OFFPEAK_EDIT_SUBMIT,
  TID_OFFPEAK_EDIT_VIEW,
  TID_OFFPEAK_FORM_INSTRUCTIONS,
  TID_OFFPEAK_FORM_TITLE,
} from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Input } from "@/components/ui/input.js";
import { toast } from "@/components/ui/toast.js";
import {
  AUTOMATION_FORM_FIELD_CLASSNAME,
  AutomationInfoIcon,
  AutomationSettingsHistoryTabs,
  type AutomationSettingsHistoryTab,
} from "@/settings/AutomationDesignPrimitives.js";
import {
  AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
  AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
  AutomationInstructionsComposer,
  AutomationInstructionsTextarea,
  AutomationInstructionsToolbar,
} from "@/settings/AutomationInstructionsComposer.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { OffPeakEditActionsMenu } from "@/settings/OffPeakEditActionsMenu.js";
import { OffPeakHistoryTab } from "@/settings/OffPeakHistoryTab.js";
import { AutomationSwitchToggle } from "@/settings/AutomationSwitchToggle.js";
import { cn } from "@/components/lib/utils.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  AUTOMATION_DEFAULT_MODE,
  buildAutomationModeOption,
} from "@/settings/automationAgentConfigOptions.js";
import { ConfigSelect } from "@/chat-input-toolbar/display.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { resolveAutomationWorkspaceSelectionKey } from "@/settings/automationWorkspaceOptions.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import {
  OFF_PEAK_CREATE_TOOLTIP_CLASSNAME,
  resolveLocalizedOffPeakCreateTitle,
  shouldShowOffPeakModelSelectionIssue,
} from "@/settings/offPeakUiPresentation.js";
import { ModelConfigSelect, type ModelSelectGroup } from "@/ModelConfigSelect.js";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";

// 闲时白名单里的模型不存在「锁定」概念，恒返回 false；共享选择器用这个常量避免每次都新建函数。
const MODEL_ITEM_NEVER_LOCKED = () => false;

// [契约] 推理档为空时不能写入 options：空串会被服务端当成显式档位，导致模型回退到默认档。
// 只在 trim 后有内容时才展开 options，保持提交对象最小化。
export function buildOffPeakSubmissionModelSelection(
  providerId: string,
  modelId: string,
  displayedReasoningLevel: string | undefined,
): ModelSelection {
  // 空串与纯空白都视为「未指定」；不要把它写成 "default"，服务端没有这个档位。
  const reasoningLevel = displayedReasoningLevel?.trim();
  return {
    providerId,
    modelId,
    ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
  };
}

// 提交结构是跨层契约：字段名与 Host 入参一一对应，新增字段要同步服务端校验。
export interface OffPeakEditSubmit {
  // 创建态带 projectId，编辑态省略；null 与 undefined 都表示「未指定」，服务端按 workspacePath 处理。
  projectId?: string | null;
  // 提交标题是必填字符串，可以为空由上层校验；页面在提交前已 trim 并拦截空白。
  title: string;
  // 指令必填；与标题一样只做 trim 后非空校验，不限制长度。
  prompt: string;
  // 权限档用 string 而不是联合类型：合法值由共享构造器维护，跨包新增档位不需要改这里。
  permissionMode: string;
  // 提交必须带 providerId 与 modelId，缺一不可；推理档放在 options 里，不能提升为顶层字段。
  modelSelection: ModelSelection;
  // workspacePath 是任务执行目录，不是身份键；远程任务还需要 identity 才能唯一定位。
  workspacePath: string;
  // identity 可选：本地任务没有远端身份；编辑远端任务时必须原样透传，不能重新推导。
  workspaceIdentity?: string;
}

// onSubmit 返回 boolean 而不是抛错：失败由页面保留草稿，错误展示交给上层 toast。
// onOpenSession/onPause 等回调都是可选的，缺少时只隐藏入口，不阻断渲染。
// showToast 可注入，便于测试断言提示内容与 level。
interface OffPeakEditViewProps {
  editing: ZCodeOffPeakTask | null;
  /** 创建态预填（New task 页模板卡跳转）；编辑态忽略。 */
  // 模板预填只在创建态生效；编辑态忽略它，避免覆盖已有任务的标题与指令。
  // 预填标题视为用户意图，不再被 locale 默认值替换。
  initialDraft?: { title?: string; prompt?: string } | null;
  modelSelectionView: ModelSelectionView;
  defaultWorkspacePath: string;
  defaultWorkspaceIdentity?: string;
  // saving 是父级持有的提交中状态，页面只读它来禁用按钮，不维护第二份写入标志。
  saving: boolean;
  /** selected Coding Plan 或服务端 availability 不允许创建时禁用提交；编辑不受影响。 */
  // 该标记只来自上层套餐/可用性判断，页面不自行推导；默认 false 表示不阻断。
  createBlocked?: boolean;
  createBlockedTooltip?: string;
  onBack: () => void;
  // [契约] Promise<boolean> 的语义是「是否已成功落库」，不是「是否已发出请求」；页面据此决定是否离开。
  onSubmit: (input: OffPeakEditSubmit) => Promise<boolean>;
  onOpenSession?: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
  onDelete?: (task: ZCodeOffPeakTask) => void;
  onDeleteHistory?: (task: ZCodeOffPeakTask) => void;
  // 暂停/继续回调由父级决定是否提供；页面只负责在对应 state 下渲染入口。
  onPause?: (task: ZCodeOffPeakTask) => void;
  // 继续执行入口只对 paused 任务展示，是否可点由父级根据运行状态决定。
  onContinue?: (task: ZCodeOffPeakTask) => void;
  // 可注入用于测试；生产默认使用全局 toast，保持与其他设置页一致的展示位置与时长。
  showToast?: typeof toast;
}

// 同时兼容 Windows 反斜杠与 POSIX 斜杠；项目名只用于展示，不参与任何匹配。
function workspaceBasename(path: string): string {
  // 反斜杠先统一成正斜杠再分段；空段被过滤，兼容结尾带分隔符的路径。
  // 取不到 basename 时回退原路径，宁可显示长路径也不显示空白。
  return path.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? path;
}

// 页面是纯受控表单：所有持久化都发生在 onSubmit 之后，组件内不调用服务。
// editing 为 null 表示创建态；存在即编辑态，两种模式共用同一套字段与校验，仅项目与只读规则不同。
export function OffPeakEditView({
  editing,
  initialDraft,
  modelSelectionView,
  defaultWorkspacePath,
  defaultWorkspaceIdentity,
  saving,
  createBlocked = false,
  createBlockedTooltip,
  onBack,
  onSubmit,
  onOpenSession,
  onDelete,
  onDeleteHistory,
  onPause,
  onContinue,
  showToast = toast,
}: OffPeakEditViewProps) {
  // 所有用户可见文案走 intl；模型名与项目名属于数据，不翻译。
  const { intl } = useZCodeIntl();
  const { settings, update: updateSettings } = useSettings();
  // 丢弃确认使用全局 confirm 服务，保证与设置页其他确认弹窗的视觉与键盘行为一致。
  const confirmDialog = useConfirmDialog();
  // 项目候选只来自本机虚拟项目；远程 workspace 不在此列，避免把任务指到不可达路径。
  // 候选顺序由 hook 决定，页面不再排序。
  const localWorkspaceOptions = useAutomationProjectOptions();
  // 创建态的默认项目：优先与 defaultWorkspacePath 匹配且无 identity 的项，其次取第一个。
  // 带 identity 时跳过路径匹配，防止把远端 workspace 误认成本地项目。
  const preferredLocalWorkspace =
    localWorkspaceOptions.find(
      (option) => !defaultWorkspaceIdentity && option.workspacePath === defaultWorkspacePath,
    ) ?? localWorkspaceOptions[0];

  // 默认进入 Settings；tab 只是视图状态，不写入 URL，离开页面即复位。
  // tab 初值固定为 settings；从历史页返回时由父级重新挂载，不做 tab 记忆。
  const [tab, setTab] = useState<AutomationSettingsHistoryTab>("settings");
  // 用 ref 而不是 state：提示只需每次挂载弹一次，且不应触发重渲染。
  // 一旦置 true 不再复位，避免用户切换权限档后再次被提示。
  const fullAccessWarningShownRef = useRef(false);
  // ref 是给异步回调读的镜像：handleBack 在 await 之后不能再依赖闭包里的 readOnly。
  const readOnlyRef = useRef(false);
  // 记录用户是否手动改过标题，决定 locale 变化时是否覆盖默认值。
  const titleTouchedRef = useRef(false);
  // 触发按钮的 ref 只用于定位推理档气泡，不参与表单状态；不要把它接进 dirty 计算。
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  // 默认标题是创建态的占位值；编辑态永远不会使用它。
  const localizedDefaultCreateTitle = intl.formatMessage({
    id: "offPeak.create.defaultTitle",
  });
  // 模板卡可以带标题预填；预填视为用户意图，因此也不再被 locale 覆盖。
  const defaultCreateTitle = initialDraft?.title ?? localizedDefaultCreateTitle;
  // 保存上一次的默认标题，用于区分「用户没改过」和「用户恰好输入了旧默认值」。
  const previousLocalizedDefaultTitleRef = useRef(localizedDefaultCreateTitle);
  // 编辑态以任务标题为准，创建态用预填或本地化默认值；不要在这里 trim，提交时统一处理。
  const [title, setTitle] = useState(editing?.title ?? defaultCreateTitle);
  // 指令是自由文本，不做格式转换；空串是合法初始值，由 canSubmit 拦截。
  const [prompt, setPrompt] = useState(editing?.prompt ?? initialDraft?.prompt ?? "");
  // 权限档默认 build；编辑态沿用任务原值，不从全局设置推导，避免静默提权。
  const [mode, setMode] = useState<string>(editing?.permissionMode ?? AUTOMATION_DEFAULT_MODE);
  // provider 归属以编辑中的任务为准，其次取可用 provider 的第一个；这是只读展示，不写回任务。
  // provider 变化会带动 allowedModels 与推理档一起重算，三者必须同源。
  const offPeakProviderId =
    editing?.modelSelection?.providerId ?? modelSelectionView.providers[0]?.providerId ?? "";
  // 白名单是唯一模型来源：只取当前 provider 下的候选，找不到就是空数组而不是回退全部模型。
  // 依赖 modelSelectionView 与 providerId；provider 切换必须重算，不能缓存。
  const allowedModels = useMemo(
    () =>
      modelSelectionView.providers
        .find((provider) => provider.providerId === offPeakProviderId)
        ?.models.map((candidate) => candidate.modelId) ?? [],
    [modelSelectionView, offPeakProviderId],
  );
  // 编辑态尊重任务已保存的模型（即使它已不在候选里，交给上层修复），创建态取第一个白名单模型。
  const initialModel = editing ? (editing.modelSelection?.modelId ?? "") : (allowedModels[0] ?? "");
  // model 是受控选择值；只有 handleModelChange 会同时更新它和推理档。
  const [model, setModel] = useState(initialModel);
  // 推理档初值：编辑态读任务保存值，创建态用 completeNewModelSelection 推导，绝不按模型名猜。
  // 惰性初始化保证推导只执行一次，避免每次渲染重新计算。
  const [thoughtLevel, setThoughtLevel] = useState<string | undefined>(() =>
    editing
      ? editing.modelSelection?.options?.reasoningLevel
      : completeNewModelSelection(modelSelectionView, {
          providerId: offPeakProviderId,
          modelId: initialModel,
        })?.options?.reasoningLevel,
  );
  // [并发] 切模型时同步重置推理档，两步必须在同一个事件里完成，否则会提交「新模型 + 旧档位」。
  // 依赖 providerId 与 view：provider 变了但 model 没变时也要重新解析。
  const handleModelChange = useCallback(
    (value: string) => {
      // 先更新模型再解析档位；顺序反了会用旧模型解析出新档位。
      setModel(value);
      // 切换模型时同步写入推导档位，保证「模型 + 档位」始终成对更新。
      setThoughtLevel(
        completeNewModelSelection(modelSelectionView, {
          providerId: offPeakProviderId,
          modelId: value,
        })?.options?.reasoningLevel,
      );
    },
    [modelSelectionView, offPeakProviderId],
  );
  // 创建态的项目 key 用统一解析函数生成，不能手拼路径：它同时承载 projectId 与 workspace 身份。
  // 编辑态此值不参与提交，项目由 editing 锁定。
  const [createProjectKey, setCreateProjectKey] = useState(
    preferredLocalWorkspace ? resolveAutomationWorkspaceSelectionKey(preferredLocalWorkspace) : "",
  );
  // 共享选择器要求分组结构；闲时只有一个白名单组，空列表表示无模型可选。
  // 组 key 固定为 off-peak，避免与设置页其他选择器冲突。
  const modelSelectGroups = useMemo<ModelSelectGroup[]>(
    () =>
      allowedModels.length > 0
        ? [
            {
              key: "off-peak",
              label: "",
              items: allowedModels.map((allowedModel) => ({
                key: allowedModel,
                value: allowedModel,
                name: allowedModel,
              })),
            },
          ]
        : [],
    [allowedModels],
  );
  useEffect(() => {
    // 编辑态不纠正项目选择：原项目可能已不在本机列表中，强行回填会改变任务归属。
    if (editing) return;
    if (
      // 当前 key 仍在列表中时立即返回，避免每次项目刷新都重置用户选择。
      localWorkspaceOptions.some(
        (option) => resolveAutomationWorkspaceSelectionKey(option) === createProjectKey,
      )
    )
      return;
    // 重算回退项目 key 时沿用同一优先级；不要在这里改用第一个非空项目。
    const key = preferredLocalWorkspace
      ? resolveAutomationWorkspaceSelectionKey(preferredLocalWorkspace)
      : "";
    // 项目列表刷新后，如果当前 key 已失效则回落到首选项目；只在创建态执行。
    setCreateProjectKey(key);
    // 自动纠正不算用户改动，必须同步更新快照，否则 dirty 会立即为 true。
    initialRef.current.projectKey = key;
  // 依赖包含 createProjectKey：用户手动切换项目后要重新校验它是否仍然有效。
  }, [createProjectKey, editing, localWorkspaceOptions, preferredLocalWorkspace]);
  // 闲时任务模型和 reasoning 档位只读取 Host 投影的 Built-in Config，
  // 避免 Renderer 按模型名重建第二份模型事实。
  // 推理档只读 Host 投影的 ConfigOption，避免 Renderer 重建第二份模型事实。
  // formatLevelName 只做本地化展示，不改变档位取值。
  const thoughtLevelOption = useMemo<ZCodeConfigOption | null>(
    () =>
      resolveModelThoughtOption({
        modelSelectionView,
        providerId: offPeakProviderId,
        modelId: model,
        // 当前值只用于展示选中态；选项解析失败时仍展示用户此前的选择，不静默清空。
        currentValue: thoughtLevel,
        // 档位名称按 level 动态取 i18n key；新增档位必须同时补翻译，否则会显示 key 本身。
        formatLevelName: (level) => intl.formatMessage({ id: `offPeak.thought.${level}` }),
      }),
    [intl, model, modelSelectionView, offPeakProviderId, thoughtLevel],
  );
  // 只有非空字符串才算有效档位；undefined 表示模型不支持推理，提交时直接省略 options。
  const effectiveThoughtLevel =
    typeof thoughtLevelOption?.currentValue === "string" &&
    thoughtLevelOption.currentValue.trim().length > 0
      ? thoughtLevelOption.currentValue
      : undefined;

  // 丢弃草稿守卫：
  // 初值快照固定于首渲染，返回时有未保存改动 → 确认弹窗。
  // [事务] 快照必须在首渲染一次性固定：后续 editing/initialDraft 变化（如父级刷新）不应重置脏检测基准。
  // 快照包含所有会进入提交的字段，漏一项就会让该字段的修改无法被 dirty 感知。
  // projectKey 仅在创建态参与比较，但快照仍记录它，便于切换模式时保持一致。
  const initialRef = useRef({
    // 快照标题必须与 useState 初值完全一致，否则首帧就处于 dirty 状态。
    title: editing?.title ?? defaultCreateTitle,
    // 指令快照不做 trim：用户可能有意的尾部空白，提交时才统一处理。
    prompt: editing?.prompt ?? initialDraft?.prompt ?? "",
    // 快照权限档与 state 初值同源；默认值变化时两处必须一起改。
    mode: editing?.permissionMode ?? AUTOMATION_DEFAULT_MODE,
    // 模型快照取首渲染推导值；之后模型列表刷新不会重置脏检测基准。
    model: initialModel,
    // 快照允许 undefined，表示「未选择」；与 effectiveThoughtLevel 的空值语义保持一致。
    thoughtLevel: editing?.modelSelection?.options?.reasoningLevel,
    // 快照项目 key 与创建态初始值同源；两者不一致会让页面一打开就是脏的。
    projectKey: preferredLocalWorkspace
      ? resolveAutomationWorkspaceSelectionKey(preferredLocalWorkspace)
      : "",
  });
  useEffect(() => {
    // 标题解析是纯函数：把当前值、默认值、是否预填、是否触碰全部显式传入，便于单测覆盖四种组合。
    const nextTitle = resolveLocalizedOffPeakCreateTitle({
      currentTitle: title,
      hasInitialTitle: Boolean(initialDraft?.title),
      isEditing: Boolean(editing),
      nextDefaultTitle: localizedDefaultCreateTitle,
      previousDefaultTitle: previousLocalizedDefaultTitleRef.current,
      titleTouched: titleTouchedRef.current,
    });
    // 无论本次是否替换标题，都要推进「上一默认值」，否则下次切换 locale 会重复触发。
    previousLocalizedDefaultTitleRef.current = localizedDefaultCreateTitle;
    // 无变化时提前返回，避免一次多余 setState 触发整页重渲染。
    if (nextTitle === title) return;
    // 只在用户未触碰且当前值等于旧默认值时替换；这是本地化默认标题的唯一写入点。
    setTitle(nextTitle);
    // 默认标题变化属于系统行为而不是用户编辑，必须同步快照，否则 dirty 误报。
    initialRef.current.title = nextTitle;
  // 依赖包含 title 是有意的：用户输入后需要重新判断，但纯函数会因 touched 标记直接返回原值。
  }, [editing, initialDraft?.title, localizedDefaultCreateTitle, title]);
  // 逐字段比较，任何一个不同即为脏；不要用 JSON 序列化整对象比较，顺序与 undefined 会误报。
  // projectKey 用 !editing 限定，是因为编辑态项目不可变，比较它只会产生假阳性。
  // thoughtLevel 允许 undefined 相等，避免「未选择」被当成改动。
  const dirty =
    // 标题逐字比较，包括空格；不做大小写或 trim 归一化，否则用户改空格不会被感知。
    title !== initialRef.current.title ||
    // 指令比较同样保留空白差异：多一个换行也是用户改动。
    prompt !== initialRef.current.prompt ||
    // 权限档变化必须触发丢弃确认，它直接影响任务执行时的工具范围。
    mode !== initialRef.current.mode ||
    // model 变化属于重要改动：即使 prompt 与 title 未变，也要走 discard 确认。
    model !== initialRef.current.model ||
    // 推理档允许 undefined；使用严格不等比较，undefined 与 "" 视为不同（后者已被归一化为 undefined）。
    thoughtLevel !== initialRef.current.thoughtLevel ||
    // 项目变化只在创建态算脏：编辑态项目由任务锁定，比较它会产生永远为真的假阳性。
    (!editing && createProjectKey !== initialRef.current.projectKey);
  // 只读态直接返回，不弹确认：没有可丢弃的改动。
  // 确认框的按钮文案与 variant 由调用方传入，保证与设置页确认弹窗一致。
  const handleBack = useCallback(async () => {
    // 用 ref 而不是 state 判断只读：本回调可能在 await 之后执行，闭包值已过期。
    // 无改动或只读时直接离开，不弹确认；只读任务没有可丢失的草稿。
    if (!dirty || readOnlyRef.current) {
      // 此分支不 await 任何东西，退化为同步返回；不要在 onBack 后再做状态写入。
      onBack();
      return;
    }
    // 确认框用 Promise 等待用户选择；await 之后只允许读 ref 或已捕获的稳定值。
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "offPeak.discard.title" }),
      description: intl.formatMessage({ id: "offPeak.discard.description" }),
      confirmLabel: intl.formatMessage({ id: "offPeak.discard.confirm" }),
      // 丢弃草稿不可恢复，确认按钮必须使用 destructive 变体。
      confirmVariant: "destructive",
      showCloseButton: true,
      showKeyboardHints: false,
      // 专用 presentation 让确认框与自动化历史页的删除确认保持同一视觉与键盘行为。
      presentation: "automation-confirmation",
    });
    // 只有用户明确确认才离开；取消时保持原页面与草稿。
    if (confirmed) onBack();
  // 依赖包含 dirty 与 intl：locale 切换后确认文案必须更新，dirty 变化后守卫判断必须刷新。
  }, [confirmDialog, dirty, intl, onBack]);

  // keepAwake 是全局设置而不是任务字段：开关立即写入 settings，不进入草稿与 dirty 计算。
  const keepAwake = settings?.keepAwakeWhileRunning ?? false;
  // queued/paused 全字段可编辑；running 起锁定编辑、终态只读。
  // [权衡] 只有 queued/paused 允许编辑：running 正在消费任务，改写会造成运行时与表单分叉。
  // 终态（completed/failed/cancelled）同样只读，历史通过 History tab 查看。
  // 创建态 editing 为空，永远可编辑。
  const readOnly = Boolean(editing && editing.status !== "queued" && editing.status !== "paused");
  // 渲染期同步镜像，保证异步回调读到的是最新值；不要放到 effect 里，effect 可能晚于用户操作。
  readOnlyRef.current = readOnly;
  // 按统一 key 匹配项目，不能按路径比较：同一路径可能对应不同 projectId。
  const selectedProject = localWorkspaceOptions.find(
    (option) => resolveAutomationWorkspaceSelectionKey(option) === createProjectKey,
  );
  // 编辑态用任务原路径，创建态用所选项目路径；两者都不做规范化，保持与 Host 一致。
  // 空路径会在 canSubmit 中被项目存在性拦截。
  const workspacePath = editing?.workspacePath ?? selectedProject?.workspacePath ?? "";
  // [契约] 提交条件同时覆盖内容、项目、模型、推理档、保存中、创建限制与只读态；少一项都会放出非法提交。
  // title/prompt 用 trim 后长度判断，避免纯空白通过。
  // effectiveThoughtLevel 必填是有意的：推理模型缺档位会导致服务端行为不确定。
  // !saving 防重复提交，!createBlocked 只拦创建，!readOnly 拦运行中任务。
  const canSubmit =
    // 标题只校验非空白，不限制长度；长度上限由服务端契约负责。
    title.trim().length > 0 &&
    // 指令只校验非空白；真正的执行语义由服务端与运行时校验，表单不做重复解析。
    prompt.trim().length > 0 &&
    // 编辑态不要求项目存在于当前列表；创建态必须选中一个有效项目。
    Boolean(editing || selectedProject) &&
    // 模型 id 必须存在；空串代表白名单为空，此时提交必然失败。
    Boolean(model) &&
    // 推理模型必须带有效档位；用 effective 值而不是原始 state，空串不会误判为有值。
    Boolean(effectiveThoughtLevel) &&
    // saving 是父级写入标志，页面不能只看本地按钮状态。
    !saving &&
    // 只拦创建：套餐不可用时已有任务仍应允许保存修复，否则用户无法收尾存量任务。
    !createBlocked &&
    // 只读是最后一道闸：即使前面的内容都合法，运行中/终态任务也不能提交修改。
    !readOnly;

  // [并发] 提交是异步的：成功才 onBack，失败保留表单；不要在校验前 setState。
  // 依赖数组列全所有参与提交的字段，避免闭包提交旧值。
  const handleSubmit = useCallback(async () => {
    // 按钮 disabled 只是视觉提示，这里再判一次，防止回车或程序化触发绕过。
    if (!canSubmit) return;
    // 只在第一次非 yolo 提交时提示，且同一次点击继续创建，不引入二次确认。
    if (mode !== "yolo" && !fullAccessWarningShownRef.current) {
      // 在弹出提示前就置位，避免 toast 尚未渲染时用户再次点击导致重复提示。
      fullAccessWarningShownRef.current = true;
      // 权限建议是非阻塞提示，使用 warning 会把中性建议渲染成橙色警告。
      // 第一次非 Full access 提交时用 Info 提示，但同一次点击继续创建，不引入二次确认。
      // 使用 info 变体：这是权限建议而不是风险告警，橙色 warning 会误导用户。
      // durationMs 与 dismissible 保证提示可读且不阻塞操作。
      showToast(intl.formatMessage({ id: "offPeak.form.fullAccessHint" }), {
        // 8000ms 足以读完一句权限建议，又不会长期占据顶部区域。
        durationMs: 8000,
        position: "top-center",
        variant: "info",
        dismissible: true,
        dismissLabel: intl.formatMessage({ id: "common.close" }),
      });
    }
    // 提交对象按需展开可选字段：projectId 只在创建态且选中项目时出现，identity 只在编辑态出现。
    // title/prompt 在这里统一 trim，保证存储值与校验口径一致。
    // 推理档通过 buildOffPeakSubmissionModelSelection 统一构造，避免两处拼装规则分叉。
    const ok = await onSubmit({
      // 只在创建态带 projectId；编辑态项目由任务自身持有，重复传会与 workspacePath 产生冲突。
      ...(!editing && selectedProject ? { projectId: selectedProject.projectId } : {}),
      // 标题提交前 trim，避免全空白标题通过长度校验；快照仍保存未 trim 值以供脏检测。
      title: title.trim(),
      // 指令提交前 trim；这是唯一会改变用户原文的位置，不要在其他地方重复处理。
      prompt: prompt.trim(),
      // 提交原始档位字符串，不做映射；映射只发生在展示层的 buildAutomationModeOption。
      permissionMode: mode,
      // 摘要式构造保证 provider/model/推理档三者来自同一组变量，避免拼接过程中被其他字段覆盖。
      modelSelection: buildOffPeakSubmissionModelSelection(
        offPeakProviderId,
        model,
        effectiveThoughtLevel,
      ),
      // 路径原样提交，不做规范化：Host 与文件服务使用同一份字符串才能命中缓存。
      workspacePath,
      ...(editing?.workspaceIdentity ? { workspaceIdentity: editing.workspaceIdentity } : {}),
    });
    // [失败路径] 返回 false 表示上层已提示错误，页面保留全部输入供用户重试。
    if (ok) onBack();
  }, [
    // 依赖显式列出 canSubmit，而不是依赖内部字段：任何校验规则变化都能触发回调重建。
    canSubmit,
    editing,
    // 提交使用 effectiveThoughtLevel 而不是原始 state，确保空串不会进入 options。
    effectiveThoughtLevel,
    intl,
    mode,
    model,
    offPeakProviderId,
    onBack,
    // onSubmit 变化时必须重建回调，否则会用旧闭包提交到旧目标。
    onSubmit,
    prompt,
    title,
    workspacePath,
    // 创建态需要 selectedProject 提供 projectId；把它列进依赖，项目切换后提交才会带新 id。
    selectedProject,
  ]);

  // 闲时与定时任务复用同一权限 option，并通过 provider 保持会话权限词表一致。
  // 权限选项与定时任务共用同一个构造器，保证两处的档位名称、图标与顺序一致。
  const modeOption = useMemo(() => buildAutomationModeOption(mode), [mode]);
  // 创建按钮同时用于「无阻断」与「有 tooltip 包装」两种形态；按钮元素只构造一次，避免重复挂载测试 id。
  // disabled 绑 canSubmit，点击走 void handleSubmit，避免未处理的 Promise。
  const createSubmitButton = (
    <Button
      type="button"
      variant="default"
      size="lg"
      data-testid={TID_OFFPEAK_EDIT_SUBMIT}
      disabled={!canSubmit}
      onClick={() => void handleSubmit()}
    >
      {intl.formatMessage({ id: "offPeak.create.submit" })}
    </Button>
  );

  // 页面结构固定为「面包屑 + 标题 + 开关 + tab + 内容区」；不要把表单字段移出内容区，否则 History 切换会连带隐藏。
  // History 与 Settings 是互斥渲染，同一时刻只有一个表单实例，避免两份受控状态。
  // 标题与副标题的 i18n id 随编辑态切换，文案差异由翻译表承担。
  return (
    <div
      className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "relative flex flex-col gap-6")}
      data-testid={TID_OFFPEAK_EDIT_VIEW}
    >
      <SettingsBreadcrumbReporter
        items={[
          {
            label: editing?.title ?? intl.formatMessage({ id: "offPeak.create.title" }),
          },
        ]}
        onSectionSelect={() => void handleBack()}
      />

      <div className="space-y-1.5">
        <h1 data-testid="offpeak-edit-title" className="text-ui-xl font-semibold text-foreground">
          {intl.formatMessage({
            id: editing ? "offPeak.edit.title" : "offPeak.create.title",
          })}
        </h1>
        <p data-testid="offpeak-edit-subtitle" className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id: editing ? "offPeak.edit.subtitle" : "offPeak.create.subtitle",
          })}
        </p>
      </div>

      {editing?.modelSelectionIssue && shouldShowOffPeakModelSelectionIssue(editing.status) ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2 text-ui-base text-warning"
        >
          <AutomationInfoIcon className="size-4 shrink-0" aria-hidden="true" />
          {intl.formatMessage({ id: "offPeak.modelSelection.repairRequired" })}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-wrap items-center gap-4 sm:flex-nowrap">
        <div className="flex shrink-0 items-center gap-2">
          <AutomationSwitchToggle
            checked={keepAwake}
            ariaLabel={intl.formatMessage({
              id: "offPeak.form.keepAwakeLabel",
            })}
            onChange={(value) => void updateSettings({ keepAwakeWhileRunning: value })}
            color="blue"
            size="sm"
          />
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "offPeak.form.keepAwakeLabel" })}
          </span>
        </div>
      </div>

      {/* Settings/History 分段 tab（左）+ 创建按钮（右上）；与定时任务编辑页同款分段样式。 */}
      <div className="flex items-center justify-between">
        <AutomationSettingsHistoryTabs
          value={tab}
          settingsLabel={intl.formatMessage({ id: "offPeak.tab.settings" })}
          historyLabel={intl.formatMessage({ id: "offPeak.tab.history" })}
          onValueChange={setTab}
        />
        {tab !== "history" && !editing ? (
          createBlockedTooltip ? (
            <ControlHintTooltip
              title={createBlockedTooltip}
              side="top"
              align="center"
              className={OFF_PEAK_CREATE_TOOLTIP_CLASSNAME}
            >
              <span className="inline-flex">{createSubmitButton}</span>
            </ControlHintTooltip>
          ) : (
            createSubmitButton
          )
        ) : tab !== "history" && !readOnly ? (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid={TID_OFFPEAK_EDIT_SUBMIT}
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              className="inline-flex h-8 items-center rounded-lg border-0 bg-white px-3 text-ui-base font-medium text-black shadow-none outline-none transition-colors hover:bg-white/90 focus-visible:ring-0 disabled:pointer-events-none disabled:opacity-40"
            >
              {intl.formatMessage({ id: "offPeak.edit.save" })}
            </button>
            {editing ? (
              <OffPeakEditActionsMenu
                task={editing}
                {...(onPause ? { onPause } : {})}
                {...(onContinue ? { onContinue } : {})}
                {...(onDelete ? { onDelete } : {})}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {editing && tab === "settings" ? (
        <div className="flex min-h-11 items-center gap-3 rounded-[10px] bg-surface px-3 py-3 text-ui-base leading-5 text-foreground-subtle sm:py-0">
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <AutomationInfoIcon className="size-4" aria-hidden="true" />
          </span>
          {intl.formatMessage({ id: "offPeak.keepAwakeBanner" })}
        </div>
      ) : null}

      {tab === "history" ? (
        <OffPeakHistoryTab
          task={editing}
          {...(onOpenSession
            ? {
                onOpenSession: (task: ZCodeOffPeakTask) =>
                  task.sessionId
                    ? onOpenSession({
                        sessionId: task.sessionId,
                        workspacePath: task.workspacePath,
                        ...(task.workspaceIdentity
                          ? { workspaceIdentity: task.workspaceIdentity }
                          : {}),
                      })
                    : undefined,
              }
            : {})}
          {...(onDeleteHistory ? { onDelete: onDeleteHistory } : {})}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {editing?.sessionId ? (
            // 会话内创建的任务绑定并运行在创建它的会话里；露出会话标题与跳转，并提示 Stop 即取消。
            <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
              <div className="flex min-w-0 items-center gap-2 text-ui-base leading-5">
                <span className="min-w-0 truncate text-foreground">
                  {intl.formatMessage(
                    { id: "offPeak.boundSession.label" },
                    { title: editing.sessionTitle ?? editing.sessionId },
                  )}
                </span>
                {onOpenSession ? (
                  <button
                    type="button"
                    className="shrink-0 text-foreground-subtle underline-offset-2 hover:underline"
                    onClick={() =>
                      onOpenSession({
                        sessionId: editing.sessionId!,
                        workspacePath: editing.workspacePath,
                        ...(editing.workspaceIdentity
                          ? { workspaceIdentity: editing.workspaceIdentity }
                          : {}),
                      })
                    }
                  >
                    {intl.formatMessage({ id: "offPeak.goToSession" })}
                  </button>
                ) : null}
              </div>
              <span className="text-ui-base leading-5 text-foreground-subtle">
                {intl.formatMessage({ id: "offPeak.boundSession.hint" })}
              </span>
            </div>
          ) : null}
          {/* 任务标题 */}
          <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
            <span className="text-ui-base font-normal leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "offPeak.form.titleLabel" })}
            </span>
            {/* Bug 原因：闲时任务标题曾用透明边框覆盖共享 Input 状态，导致与定时任务及 Instructions 描边不一致。 */}
            <Input
              value={title}
              disabled={readOnly}
              data-testid={TID_OFFPEAK_FORM_TITLE}
              placeholder={intl.formatMessage({
                id: "offPeak.form.titlePlaceholder",
              })}
              onChange={(event) => {
                // 任何手动输入都标记为 touched；即使之后清空，也不再接受默认标题覆盖。
                titleTouchedRef.current = true;
                setTitle(event.target.value);
              }}
              className={cn(
                "h-9 rounded-lg bg-card px-2 text-foreground hover:bg-surface-hover focus-visible:bg-card",
                AUTOMATION_FORM_INPUT_TYPOGRAPHY_CLASSNAME,
              )}
            />
          </div>

          {/* 任务指令 = composer 盒：textarea + 底部工具条（项目 / 权限 | 模型） */}
          <div className={AUTOMATION_FORM_FIELD_CLASSNAME}>
            <span className="text-ui-base font-normal leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "offPeak.form.instructionsLabel" })}
            </span>
            <AutomationInstructionsComposer>
              <AutomationInstructionsTextarea
                data-testid={TID_OFFPEAK_FORM_INSTRUCTIONS}
                value={prompt}
                disabled={readOnly}
                placeholder={intl.formatMessage({
                  id: "offPeak.form.instructionsPlaceholder",
                })}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <AutomationInstructionsToolbar>
                <div className="flex min-w-0 flex-wrap items-center gap-0">
                  {/* 项目：创建态读取本机虚拟项目；编辑态锁定原项目。 */}
                  {/* 修复原因：UI 字号会随设置缩放，固定 18px 行高会在大字号下挤压项目文案。 */}
                  {editing ? (
                    <span className="flex h-7 min-w-0 items-center gap-1 rounded-full px-2 text-ui-base font-normal leading-snug text-foreground-subtle">
                      <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                      <span className="max-w-40 truncate" title={workspacePath}>
                        {workspaceBasename(workspacePath)}
                      </span>
                    </span>
                  ) : localWorkspaceOptions.length > 0 ? (
                    <Select value={createProjectKey} onValueChange={setCreateProjectKey}>
                      <SelectTrigger
                        data-testid="offpeak-project-select"
                        variant="ghost"
                        className={AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME}
                      >
                        <FolderOpen className="size-4" aria-hidden="true" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {localWorkspaceOptions.map((option) => (
                          <SelectItem
                            key={resolveAutomationWorkspaceSelectionKey(option)}
                            value={resolveAutomationWorkspaceSelectionKey(option)}
                            data-project-id={option.projectId}
                            data-project-name={option.label}
                          >
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled
                      className={cn(
                        AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                        "gap-1 px-2 text-foreground-subtlest",
                      )}
                    >
                      <FolderOpen className="size-4" aria-hidden="true" />
                      {intl.formatMessage({
                        id: "automations.form.project.localRequired",
                      })}
                    </Button>
                  )}
                  {/* Bugfix：闲时权限菜单曾单独渲染，缺少首页的模式图标和标准选中态。
                      复用 ConfigSelect，避免两处样式再次分叉。 */}
                  <ConfigSelect
                    option={modeOption}
                    provider={ZCODE_AGENT_PROVIDER}
                    onValueChange={setMode}
                    disabled={readOnly}
                    tooltipTitle={intl.formatMessage({
                      id: "chat.toolbar.mode.label",
                    })}
                    triggerVariant="ghost"
                    triggerSize="default"
                    triggerClassName={cn(
                      AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                      "w-fit max-w-56 min-w-0 shrink justify-start gap-1 px-2",
                    )}
                    labelVisibilityClassName="inline-flex min-w-0 truncate text-left"
                    restoreFocusSelector={null}
                  />
                </div>
                {/* Bug 原因：右侧组曾允许自身和子 trigger 收缩，模型与推理内容会被压成纵向多行。
                    小屏时整组占据下一行，组内始终保持单行。 */}
                <div className="flex w-full shrink-0 flex-nowrap items-center justify-end gap-0 sm:w-auto">
                  {/* 模型仍由闲时白名单驱动，只复用 New Task 的纯展示选择器。 */}
                  <ModelConfigSelect
                    modelGroups={modelSelectGroups}
                    normalizedValue={model}
                    triggerLabel={model || intl.formatMessage({ id: "offPeak.form.modelLabel" })}
                    showProviderLevel={false}
                    showManageModelsAction={false}
                    lockReasonMessage=""
                    isItemLocked={MODEL_ITEM_NEVER_LOCKED}
                    onValueChange={handleModelChange}
                    disabled={readOnly || allowedModels.length === 0}
                    tooltipTitle={intl.formatMessage({
                      id: "offPeak.form.modelLabel",
                    })}
                    contentSide="top"
                    contentAlign="end"
                    focusSelectorOnClose={null}
                    labelVisibilityClassName="inline-flex min-w-0"
                    triggerClassName={cn(
                      AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME,
                      "w-fit max-w-72 min-w-0 shrink justify-between px-2",
                    )}
                    triggerLabelClassName="inline-flex min-w-0 truncate text-left"
                  />
                  {/* 推理档位（D34）：仅推理模型显示；缺省=workspace 默认 */}
                  {thoughtLevelOption ? (
                    <ThoughtLevelCycleControl
                      intl={intl}
                      option={thoughtLevelOption}
                      provider={ZCODE_AGENT_PROVIDER}
                      disabled={readOnly}
                      triggerRef={thoughtTriggerRef}
                      triggerClassName={AUTOMATION_INSTRUCTIONS_TOOLBAR_TRIGGER_CLASSNAME}
                      interactionMode="select"
                      restoreFocusSelector={null}
                      labelVisibilityClassName="inline-flex min-w-0"
                      onValueChange={setThoughtLevel}
                    />
                  ) : null}
                </div>
              </AutomationInstructionsToolbar>
            </AutomationInstructionsComposer>
            {/* 修复原因：该文案是运行机制说明而非风险告警，橙色三角会错误强化语义；
                与复合输入额外拉开 4px，避免辅助说明贴近输入框边界。 */}
            <div className="mt-1 flex items-start gap-1.5 text-ui-base leading-5 text-foreground-subtle">
              <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
                <AutomationInfoIcon className="size-4" />
              </span>
              {intl.formatMessage({ id: "offPeak.form.permissionWarning" })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
