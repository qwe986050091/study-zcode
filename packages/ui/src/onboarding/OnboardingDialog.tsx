/* eslint-disable max-lines -- onboarding 弹窗集中编排欢迎页、会话迁移、外部导入和最终执行状态，拆开会增加跨步骤状态传递复杂度 */
// OnboardingDialog：onboarding 引导与迁移弹窗的编排层，串联 welcome 与 wizard 两个视图、
// 步骤顺序推进、外部导入选择聚合、AGENTS.md 覆盖迁移确认，以及最终迁移执行的进度汇总。
// 职责边界：会话扫描、迁移执行、设置写入分别由 useClaudeSessionMigration / useOnboardingMigration /
// useSettingsSync 等服务持有；本文件只做编排、门控与展示投影，不保存迁移队列的第二份事实。
// 不负责：各步骤内部 UI（OnboardingFlowParts、OnboardingDialogParts）、迁移任务的串行与重试、i18n 文案内容。
//
// INV-01 断言：ONBOARDING_STEP_ORDER 是向导前进与后退的唯一顺序真源 —— 守住它的位置：ONBOARDING_STEP_ORDER 与 goToPreviousWizardStep/goToNextWizardStep —— 改错故障：侧边栏高亮与下一步落点错位，用户会跳过导入步骤。
// INV-02 断言：进入 wizard 的初始步骤恒为 session —— 守住它的位置：onboardingDialogRequested effect 与欢迎页 onOpenMigration —— 改错故障：直接落到 migration 时执行状态尚未准备，进度显示 0/0。
// INV-03 断言：settingsSync.state.open 由真转假时必须复位 view、步骤、选中项与执行结果 —— 守住它的位置：第一个 useEffect —— 改错故障：再次打开残留上次的选中工作区与完成态。
// INV-04 断言：同一 workspacePath 只会在候选列表出现一次，sessionCount 为命中次数 —— 守住它的位置：workspaceCandidates 的 Map 去重 —— 改错故障：同一工作区重复列出，迁移时重复处理同一批会话。
// INV-05 断言：候选按 sessionCount 降序排列，且只影响展示顺序 —— 守住它的位置：workspaceCandidates 的 sort —— 改错故障：默认选中集合的视觉顺序与用户预期不符，排查时被误判为状态错误。
// INV-06 断言：首次拿到候选时整体全选，之后只做交集过滤不再重新全选 —— 守住它的位置：initializedWorkspaceSelectionRef —— 改错故障：增量扫描时反复全选，覆盖用户手动取消的选择。
// INV-07 断言：候选清空时必须复位 initializedWorkspaceSelectionRef —— 守住它的位置：setSelectedWorkspacePaths 的空分支 —— 改错故障：下一次扫描拿到的候选不会被默认选中，用户误以为没有可迁移会话。
// INV-08 断言：每个 session 步骤入口最多自动扫描一次 —— 守住它的位置：autoScannedSessionStepRef 与 shouldAutoScanOnboardingSessions —— 改错故障：频繁进出步骤触发重复扫描，两次结果互相覆盖。
// INV-09 断言：离开 session 步骤要清零自动扫描标记 —— 守住它的位置：view 与 wizardStep 的 effect —— 改错故障：返回 session 步骤不再自动扫描，界面停在空列表。
// INV-10 断言：会话、外部导入、AGENTS.md 三项全空时禁止进入 migration —— 守住它的位置：beginMigrationDisabled —— 改错故障：进入空迁移页，进度恒为 0%，用户卡在这一步。
// INV-11 断言：settingsTaskCount 恒为 0，代理设置不计入迁移任务 —— 守住它的位置：settingsTaskCount 常量与 includeSettingsSelections 传参 —— 改错故障：分母虚增导致进度条永远到不了 100%。
// INV-12 断言：总任务数包含外部导入项数量，完成数只累加会话、AGENTS.md 与设置已完成数 —— 守住它的位置：totalExecutionTaskCount 与 completedExecutionTaskCount —— 改错故障：分子分母口径不一致，进度回退或提前满格。
// INV-13 断言：总数为 0 时进度取 finished 为 100%，否则为 0% —— 守住它的位置：overallProgress 三元表达式 —— 改错故障：空任务出现 NaN% 文本或长期停在 0%。
// INV-14 断言：选中 AGENTS.md 迁移时必须二次确认后才切到 migration —— 守住它的位置：handleBeginMigration 的 confirmDialog 分支 —— 改错故障：未确认就覆盖 ~/.zcode/AGENTS.md，原内容不可恢复。
// INV-15 断言：迁移运行中关闭弹窗必须走二次确认 —— 守住它的位置：handleCloseRequest 与 Dialog 的 onOpenChange —— 改错故障：Esc 或遮罩点击直接中断长任务，用户丢失进度提示。
// INV-16 断言：非运行态关闭弹窗不加确认，直接关闭 —— 守住它的位置：handleCloseRequest 的首个分支 —— 改错故障：仅浏览时就弹确认，形成多余打扰。
// INV-17 断言：plugins 与代理设置步骤只以注释占位，不进入顺序数组与 switch —— 守住它的位置：ONBOARDING_STEP_ORDER 与 renderWizardBody —— 改错故障：启用占位后缺少对应状态，切换步骤直接白屏。
// INV-18 断言：agents-file 步骤的外层描述恒为空串，由步骤内部展示路径说明 —— 守住它的位置：dialogDescription 分支 —— 改错故障：头部与正文出现两段重复说明。
//
// 阅读提示：本文件的判断多为入口门控与引用相等依赖，改门控条件必须同步检查对应 useEffect 的依赖数组。
// 数据来源：workspaceCandidates 只由 sessionMigration.candidates 派生，这里不发起任何额外扫描请求。
// 出口收敛：关闭弹窗只有 handleCloseRequest 与 settingsSync.actions.close 两个出口，子组件不得绕开。
// 步骤扩展：新增步骤需同时改 ONBOARDING_STEP_ORDER、wizardStep 联合类型与 renderWizardBody 的 switch。
//
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useSettingsSync } from "@/hooks/useSettingsSync.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import { logger } from "@/logger.js";
import {
  getOnboardingStepMessageKey,
  OnboardingWizardSidebar,
  OnboardingWizardFooter,
  OnboardingWizardHeader,
  type OnboardingView,
  type OnboardingWizardStep,
} from "@/onboarding/OnboardingDialogParts.js";
import {
  OnboardingExternalAgentImportStep,
  OnboardingMigrationStep,
  OnboardingSessionsStep,
  OnboardingWelcomeView,
  OnboardingFinishStep,
  type OnboardingWorkspaceCandidate,
} from "@/onboarding/OnboardingFlowParts.js";
import { OnboardingAgentsFileStep } from "@/onboarding/OnboardingAgentsFileStep.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import {
  shouldAutoScanOnboardingSessions,
  useOnboardingMigration,
} from "@/onboarding/useOnboardingMigration.js";
import { useOnboardingAgentsFileMigration } from "@/onboarding/useOnboardingAgentsFileMigration.js";
import { useServices } from "@/hooks/useServices.js";
import { useExternalAgentImportCategoryState } from "@/settings/ExternalAgentImportDialog.js";

// [契约] 再导出让打开弹窗前的调用方复用同一份自动扫描判定，避免入口与向导各写一份阈值。
// 此处只做转发，实现与依赖仍在 useOnboardingMigration.ts；调整判定条件请改实现处。
export { shouldAutoScanOnboardingSessions } from "@/onboarding/useOnboardingMigration.js";

// [契约] 数组顺序即向导步序：后退取前一项，前进取后一项，索引为 -1 时按已到首步处理。
// plugins-import 与代理设置步骤只保留注释占位，说明是产品上被隐藏，而不是漏了实现。
// 往数组加步骤前先确认 renderWizardBody 已有对应 case，否则切换后正文渲染为空。
// 改顺序会改变用户心智模型和既有测试的步骤断言，不属于纯展示调整。
const ONBOARDING_STEP_ORDER: OnboardingWizardStep[] = [
  "session",
  "skills-import",
  "mcp-import",
  // 插件导入步骤未启用。
  // "plugins-import",
  "commands-import",
  "agents-file",

  "migration",
];

// [契约] 三个 props 均由宿主注入：workspacePath 决定扫描与写入目录，workspaceIdentity 决定身份隔离键。
// 不传 isDesktop 时 useClaudeSessionMigration 按非桌面降级，会话扫描能力随之变化。
// 组件不自行读取当前上下文补全路径，缺省即按无工作区处理。
export function OnboardingDialog(props: {
  workspacePath?: string;
  workspaceIdentity?: string;
  isDesktop?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  // [契约] settingsSync.state.open 是弹窗显隐的唯一开关，本地 view 与 wizardStep 只是它的从属投影。
  // 关闭后的本地状态由复位 effect 统一清理，因此不要在 props 变化时自行关窗。
  // 路径与身份同时下发，避免远程工作区按本地路径误匹配缓存。
  const settingsSync = useSettingsSync({
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  // workspacePath 显式兜底为 null：hook 以 null 表示尚无工作区，与 undefined 的语义不同。
  // isDesktop 直传：只有桌面端有本地会话目录可扫，Web 端走不支持分支并隐藏扫描入口。
  const sessionMigration = useClaudeSessionMigration({
    workspacePath: props.workspacePath ?? null,
    isDesktop: props.isDesktop,
  });
  const onboardingDialogRequested = useZCodeStore((state) => state.onboardingDialogRequested);
  const clearOnboardingDialogRequest = useZCodeStore((state) => state.clearOnboardingDialogRequest);
  const [view, setView] = useState<OnboardingView>("welcome");
  const [wizardStep, setWizardStep] = useState<OnboardingWizardStep>("session");
  const [selectedWorkspacePaths, setSelectedWorkspacePaths] = useState<string[]>([]);
  // 两个 ref 都是一次性初始化标记，用 ref 而非 state，避免初始化动作本身再触发一轮渲染。
  // initializedWorkspaceSelectionRef 管默认全选只做一次，autoScannedSessionStepRef 管自动扫描只做一次。
  // 候选清空或工作区切换时必须复位它们，否则第二次进入会静默跳过初始化。
  const initializedWorkspaceSelectionRef = useRef(false);
  const autoScannedSessionStepRef = useRef(false);

  // 引导阶段没有 Scope 选择，target 恒为当前上下文 workspace，直接注入其 service。
  const { settingsSyncService } = useServices();

  // [权衡] 三类导入 hook 常驻调用，但 enabled 只在对应步骤为 true，等于把拉取推迟到用户真正进入该步。
  // enabled 同时要求 view 为 wizard：停在 welcome 不预热，避免只打开弹窗就去读外部目录。
  // 三份 state 各自持有 loading 与 error，切换步骤互不取消，也不共用单一当前分类。
  const skillsImportState = useExternalAgentImportCategoryState({
    category: "skills",
    enabled: view === "wizard" && wizardStep === "skills-import",
    settingsSyncService,
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  const mcpImportState = useExternalAgentImportCategoryState({
    category: "mcpServers",
    enabled: view === "wizard" && wizardStep === "mcp-import",
    settingsSyncService,
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  /*
   * 插件导入步骤未启用。
   * const pluginsImportState = useExternalAgentImportCategoryState({
   *   category: "plugins",
   *   enabled: view === "wizard" && wizardStep === "plugins-import",
   *   settingsSyncService,
   *   workspacePath: props.workspacePath,
   *   workspaceIdentity: props.workspaceIdentity,
   * });
   */
  const commandsImportState = useExternalAgentImportCategoryState({
    category: "commands",
    enabled: view === "wizard" && wizardStep === "commands-import",
    settingsSyncService,
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });
  // [契约] AGENTS.md 迁移只取 selected 与 status 做门控和文案占位，真正执行在 hook 内。
  // sourcePath 与 targetPath 可能为空，确认弹窗里的默认值仅是展示兜底，真实路径以 hook 返回为准。
  // 与外部导入不同，这项必须在进入 migration 前二次确认，因为它会覆盖目标文件。
  const agentsFileMigration = useOnboardingAgentsFileMigration({
    enabled: view === "wizard" && wizardStep === "agents-file",
    workspacePath: props.workspacePath,
    workspaceIdentity: props.workspaceIdentity,
  });

  // [契约] 候选工作区是对 sessionMigration.candidates 的纯投影，memo 依赖只有候选数组本身。
  // 去重键用 workspacePath 而非 label：同名目录在父路径不同时属于不同工作区。
  // sessionCount 只用于排序与展示，迁移执行不读它，因此改错不会影响真实任务数。
  // 每次重算都返回新数组，调用方不要把它当稳定引用塞进其它 memo 的依赖。
  const workspaceCandidates = useMemo<OnboardingWorkspaceCandidate[]>(() => {
    const byWorkspace = new Map<string, OnboardingWorkspaceCandidate>();

    // [并发] 这里原地累加 current.sessionCount：Map 中存的是本函数刚创建的对象，就地修改安全。
    // 若将来改成缓存候选对象，必须改为生成新对象，否则会污染上一次渲染的结果。
    // 同一工作区出现多次代表多会话，去重与计数都在这个循环内完成，不再额外遍历。
    for (const candidate of sessionMigration.candidates) {
      const current = byWorkspace.get(candidate.workspacePath);
      if (current) {
        current.sessionCount += 1;
        continue;
      }

      byWorkspace.set(candidate.workspacePath, {
        workspacePath: candidate.workspacePath,
        label: getPathLeaf(candidate.workspacePath),
        sessionCount: 1,
      });
    }

    return [...byWorkspace.values()].sort((left, right) => right.sessionCount - left.sessionCount);
  }, [sessionMigration.candidates]);

  const externalImportSelections = useMemo(
    () => [
      ...skillsImportState.selections,
      ...mcpImportState.selections,
      ...commandsImportState.selections,
    ],
    [commandsImportState.selections, mcpImportState.selections, skillsImportState.selections],
  );
  // 三类导入的 selections 拼接成扁平数组交给迁移执行，拼接顺序即任务展示顺序。
  // 门控用 selectedCount、执行用 selections，两者都来自同一批 hook 状态，不要另算一份。
  const totalExternalImportSelectedCount =
    skillsImportState.selectedCount +
    mcpImportState.selectedCount +
    commandsImportState.selectedCount;
  // [契约] 迁移执行队列归 useOnboardingMigration 所有，本文件只消费 finishExecution 的计数与 running/finished。
  // includeSettingsSelections 固定 false：代理设置步骤隐藏后，不能把默认勾选偷偷计入任务。
  // 选中工作区与导入项都以数组引用入参，引用变化即代表任务集合变化。
  // resetFinishExecution 用于关闭或重新请求时清空执行结果，否则会残留上次完成态。
  const { finishExecution, resetFinishExecution } = useOnboardingMigration(
    view,
    wizardStep,
    selectedWorkspacePaths,
    externalImportSelections,
    sessionMigration,
    agentsFileMigration,
    settingsSync,
    // 代理设置步骤未启用，不导入其默认选择。
    { includeSettingsSelections: false },
  );

  useEffect(() => {
    // [契约] 关闭时把 view、wizardStep、选中项、执行结果与两个一次性标记一并复位，保证下次打开干净。
    // 依赖里保留 resetFinishExecution：它是 hook 返回的稳定回调，但换实现后不能假设永远不变。
    // 这里只处理关闭方向，打开方向分别由 onboardingDialogRequested 与欢迎页入口负责。
    // 不要挪到卸载清理：弹窗常驻挂载，只有开关状态变化，没有卸载时机。
    if (!settingsSync.state.open) {
      setView("welcome");
      setWizardStep("session");
      setSelectedWorkspacePaths([]);
      resetFinishExecution();
      initializedWorkspaceSelectionRef.current = false;
      autoScannedSessionStepRef.current = false;
      return;
    }
  }, [settingsSync.state.open, resetFinishExecution]);

  useEffect(() => {
    // 请求携带 migration 时直接进 wizard，其余一律回 welcome，避免用户错过欢迎页说明。
    // 先切 view 与 step 再 reopen，保证弹窗出现瞬间就是目标步骤，不会闪一帧欢迎页。
    // reopen 是唯一打开出口，与 handleCloseRequest 的 close 配对，不要在此直接改 open 字段。
    // clearOnboardingDialogRequest 最后调用：先清标志再做后续会导致请求被丢弃或重复触发。
    if (!onboardingDialogRequested) {
      return;
    }

    setView(onboardingDialogRequested === "migration" ? "wizard" : "welcome");
    setWizardStep("session");
    resetFinishExecution();
    settingsSync.actions.reopen();
    clearOnboardingDialogRequest();
  }, [
    clearOnboardingDialogRequest,
    onboardingDialogRequested,
    resetFinishExecution,
    settingsSync.actions,
  ]);

  useEffect(() => {
    if (view !== "wizard" || wizardStep !== "session") {
      autoScannedSessionStepRef.current = false;
    }
  }, [view, wizardStep]);

  useEffect(() => {
    if (
      !shouldAutoScanOnboardingSessions({
        view,
        wizardStep,
        supported: sessionMigration.supportState.supported,
        isScanning: sessionMigration.isScanning,
        candidateCount: sessionMigration.candidates.length,
        scanError: sessionMigration.scanError,
        hasAutoScannedInCurrentEntry: autoScannedSessionStepRef.current,
      })
    ) {
      return;
    }

    // 先置标记再发起扫描：scan 是异步的，若先等待再置标记，依赖变化会插入第二次扫描。
    // 扫描失败由 hook 写入 scanError，这里不清标记也不自动重试，重试入口留给步骤内用户操作。
    // shouldAutoScanOnboardingSessions 集中了全部前置条件：步骤、支持态、扫描中、已有候选与错误。
    autoScannedSessionStepRef.current = true;
    void sessionMigration.scan();
  }, [
    sessionMigration.candidates.length,
    sessionMigration.isScanning,
    sessionMigration.scan,
    sessionMigration.scanError,
    sessionMigration.supportState.supported,
    view,
    wizardStep,
  ]);

  useEffect(() => {
    // [事务] 候选变化时把选中集合收敛为旧选中与新候选的交集：候选消失即取消选中，不自动勾选新增项。
    // 只有首次拿到候选时才整体全选，之后增量扫描不会覆盖用户的手动取消。
    // 在 setState 的 updater 里读 ref 属于既有写法，挪到外层计算会与扫描结果产生时序竞态。
    setSelectedWorkspacePaths((previous) => {
      const nextWorkspacePaths = [
        ...new Set(sessionMigration.candidates.map((candidate) => candidate.workspacePath)),
      ];

      // 候选清空代表工作区或身份切换，必须复位初始化标记，否则候选回来时不会被默认全选。
      // 返回空数组后下一轮才能重新走全选分支，这里不能保留旧选中做惰性兼容。
      if (nextWorkspacePaths.length === 0) {
        initializedWorkspaceSelectionRef.current = false;
        return [];
      }

      if (!initializedWorkspaceSelectionRef.current) {
        initializedWorkspaceSelectionRef.current = true;
        return nextWorkspacePaths;
      }

      return previous.filter((workspacePath) => nextWorkspacePaths.includes(workspacePath));
    });
  }, [sessionMigration.candidates]);

  // [权衡] 会话并非唯一来源：外部导入或 AGENTS.md 任一有选中即可进入迁移，三项全空才禁用按钮。
  // settingsTaskCount 固定为 0，代理设置既不展示也不计入分母，避免进度条永远差一项。
  const selectedWorkspaceCount = selectedWorkspacePaths.length;
  // 暂时隐藏数据迁移向导里的代理设置步骤，同时不把默认选中的代理设置暗中计入迁移任务。
  const settingsTaskCount = 0;
  /** 既无会话也无外部导入项时，禁止进入迁移步骤。 */
  const beginMigrationDisabled =
    selectedWorkspaceCount === 0 &&
    totalExternalImportSelectedCount === 0 &&
    !agentsFileMigration.selected;
  const settingsCompletedTaskCount = useMemo(
    () =>
      settingsSync.state.tasks.filter(
        (task) => task.status !== "pending" && task.status !== "running",
      ).length,
    [settingsSync.state.tasks],
  );
  const totalExecutionTaskCount =
    finishExecution.sessionTotalCount +
    finishExecution.agentsFileTotalCount +
    settingsTaskCount +
    externalImportSelections.length;
  const completedExecutionTaskCount =
    finishExecution.sessionCompletedCount +
    finishExecution.agentsFileCompletedCount +
    settingsCompletedTaskCount;
  // [契约] 总任务数等于会话、AGENTS.md、设置任务与外部导入项之和，完成数只累加前三类中的已完成部分。
  // 外部导入的完成度由各自 hook 内部持有，这里不追加完成数，否则分子分母口径不一致。
  // 总数为 0 时不能直接相除：finished 视为 100%，否则视为 0%，以免出现 NaN% 的进度文本。
  // 取整只用于展示，完成判定必须以 finished 为准，不要反过来用百分比判断是否结束。
  const overallProgress =
    totalExecutionTaskCount > 0
      ? Math.round((completedExecutionTaskCount / totalExecutionTaskCount) * 100)
      : finishExecution.finished
        ? 100
        : 0;

  const stepMessageKey = getOnboardingStepMessageKey(wizardStep);
  const dialogTitle =
    view === "welcome"
      ? intl.formatMessage({ id: "onboarding.dialog.title" })
      : intl.formatMessage({ id: `onboarding.step.${stepMessageKey}` });
  // agents-file 步骤外层描述留空，由步骤内部给出针对源路径与目标路径的具体说明。
  // 若在此补齐描述，头部会出现两段语义相近的文案，且与步骤内状态可能不同步。
  const dialogDescription =
    view === "welcome"
      ? intl.formatMessage({ id: "onboarding.dialog.description" })
      : wizardStep === "agents-file"
        ? ""
        : intl.formatMessage({ id: `onboarding.stepDescription.${stepMessageKey}` });

  const toggleWorkspaceSelection = (workspacePath: string) => {
    setSelectedWorkspacePaths((previous) =>
      previous.includes(workspacePath)
        ? previous.filter((current) => current !== workspacePath)
        : [...previous, workspacePath],
    );
  };

  const clearWorkspaceSelection = () => {
    setSelectedWorkspacePaths([]);
  };

  const selectAllWorkspaces = () => {
    setSelectedWorkspacePaths(workspaceCandidates.map((workspace) => workspace.workspacePath));
  };

  // [失败路径] indexOf 返回 -1 说明当前步骤不在顺序表内，此时按首步之前处理，回到欢迎页。
  // 首步再后退也回 welcome，而不是停在 session，用户可重新阅读说明或换入口。
  // 前一项取不到时兜底 session，防止数组被裁剪后把 undefined 传进 setWizardStep。
  const goToPreviousWizardStep = useCallback(() => {
    const currentIndex = ONBOARDING_STEP_ORDER.indexOf(wizardStep);
    if (currentIndex <= 0) {
      setView("welcome");
      return;
    }
    setWizardStep(ONBOARDING_STEP_ORDER[currentIndex - 1] ?? "session");
  }, [wizardStep]);

  // [契约] 只前进到下一个非 migration 步骤，migration 只能由 handleBeginMigration 在确认后进入。
  // 若把 migration 放进来，用户会绕过 AGENTS.md 覆盖确认，直接开始不可逆写入。
  const goToNextWizardStep = useCallback(() => {
    const currentIndex = ONBOARDING_STEP_ORDER.indexOf(wizardStep);
    const nextStep = ONBOARDING_STEP_ORDER[currentIndex + 1];
    if (nextStep && nextStep !== "migration") {
      setWizardStep(nextStep);
    }
  }, [wizardStep]);

  // [失败路径] 仅当选中 AGENTS.md 迁移才弹二次确认；取消则记日志并原地返回，步骤不推进。
  // 确认文案里的源与目标是展示兜底，真实写入路径以 hook 的 status 为准，冲突时以 hook 为真。
  // 确认过程是异步的，期间可能重复点击；确认弹窗自身串行，这里不再叠加本地 loading 标记。
  const handleBeginMigration = useCallback(async () => {
    if (agentsFileMigration.selected) {
      const confirmed = await confirmDialog({
        confirmVariant: "destructive",
        title: intl.formatMessage({ id: "onboarding.agentsFile.confirmTitle" }),
        description: intl.formatMessage(
          { id: "onboarding.agentsFile.confirmDescription" },
          {
            source: agentsFileMigration.status?.sourcePath ?? "~/.claude/CLAUDE.md",
            target: agentsFileMigration.status?.targetPath ?? "~/.zcode/AGENTS.md",
          },
        ),
        confirmLabel: intl.formatMessage({ id: "onboarding.agentsFile.confirmAction" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });

      if (!confirmed) {
        logger.info("[OnboardingDialog] AGENTS.md migration canceled by user", {
          workspacePath: props.workspacePath ?? null,
          workspaceIdentity: props.workspaceIdentity ?? null,
        });
        return;
      }
    }

    setWizardStep("migration");
  }, [
    agentsFileMigration.selected,
    agentsFileMigration.status?.sourcePath,
    agentsFileMigration.status?.targetPath,
    confirmDialog,
    intl,
    props.workspaceIdentity,
    props.workspacePath,
  ]);

  // [资源] 非运行态直接 close：没有后台任务可中断，也不该为一次浏览加确认。
  // 运行态必须先确认：关闭只隐藏弹窗，迁移任务不会停，用户却会失去进度与错误反馈。
  // 日志带上当前任务标签与百分比，便于定位关掉再打开后进度回退的反馈。
  // 确认结果只决定是否 close，不在此调用 resetFinishExecution，复位交给关闭 effect 统一处理。
  const handleCloseRequest = useCallback(async () => {
    if (!finishExecution.running) {
      settingsSync.actions.close();
      return;
    }

    logger.info("[OnboardingDialog] migration close requested while running", {
      workspacePath: props.workspacePath ?? null,
      workspaceIdentity: props.workspaceIdentity ?? null,
      currentTaskLabel: finishExecution.currentTaskLabel,
      overallProgress,
    });

    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "onboarding.migration.confirmCloseTitle" }),
      description: intl.formatMessage({
        id: "onboarding.migration.confirmCloseDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "onboarding.migration.confirmCloseConfirm" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });

    if (!confirmed) {
      logger.info("[OnboardingDialog] migration close canceled by user", {
        workspacePath: props.workspacePath ?? null,
        workspaceIdentity: props.workspaceIdentity ?? null,
      });
      return;
    }

    settingsSync.actions.close();
  }, [
    confirmDialog,
    finishExecution.currentTaskLabel,
    finishExecution.running,
    intl,
    overallProgress,
    props.workspaceIdentity,
    props.workspacePath,
    settingsSync.actions,
  ]);

  // 这里的分支必须覆盖 ONBOARDING_STEP_ORDER 的全部取值，漏写 case 会返回空正文。
  // migration 按 finished 二次分支：未完成展示执行进度，完成后切结果页并带上设置成败计数。
  const renderWizardBody = () => {
    switch (wizardStep) {
      case "session":
        return (
          <OnboardingSessionsStep
            migration={sessionMigration}
            workspaceCandidates={workspaceCandidates}
            selectedWorkspacePaths={selectedWorkspacePaths}
            onToggleWorkspace={toggleWorkspaceSelection}
            onSelectAll={selectAllWorkspaces}
            onClearSelection={clearWorkspaceSelection}
          />
        );
      case "skills-import":
        return (
          <OnboardingExternalAgentImportStep
            category="skills"
            state={skillsImportState}
            workspacePath={props.workspacePath}
          />
        );
      case "mcp-import":
        return (
          <OnboardingExternalAgentImportStep
            category="mcpServers"
            state={mcpImportState}
            workspacePath={props.workspacePath}
          />
        );
      /*
       * 插件导入步骤未启用。
       * case "plugins-import":
       *   return (
       *     <OnboardingExternalAgentImportStep
       *       category="plugins"
       *       state={pluginsImportState}
       *       workspacePath={props.workspacePath}
       *     />
       *   );
       */
      case "commands-import":
        return (
          <OnboardingExternalAgentImportStep
            category="commands"
            state={commandsImportState}
            workspacePath={props.workspacePath}
          />
        );
      case "agents-file":
        return <OnboardingAgentsFileStep migration={agentsFileMigration} />;

      case "migration":
        return finishExecution.finished ? (
          <OnboardingFinishStep
            overallProgress={overallProgress}
            finishExecution={finishExecution}
            settingsImportedCount={settingsSync.state.result?.successCount ?? 0}
            settingsSkippedCount={settingsSync.state.result?.skippedCount ?? 0}
            settingsFailedCount={settingsSync.state.result?.failedCount ?? 0}
          />
        ) : (
          <OnboardingMigrationStep
            overallProgress={overallProgress}
            finishExecution={finishExecution}
          />
        );
    }
  };

  return (
    <Dialog
      open={settingsSync.state.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          // onboarding 迁移执行中即使隐藏了右上角关闭按钮，Radix 仍会响应遮罩点击和 Esc。
          // 之前这里直接 close 会把长时间迁移任务瞬间关掉，用户也拿不到二次确认；统一收口到确认逻辑后才不会误关。
          void handleCloseRequest();
        }
      }}
    >
      <DialogContent
        className="h-[calc(100vh-6rem)] max-w-4xl max-h-168 overflow-hidden rounded-2xl p-0"
        showCloseButton
      >
        <DialogTitle className="sr-only">{dialogTitle}</DialogTitle>
        <DialogDescription className="sr-only">{dialogDescription}</DialogDescription>

        {view === "welcome" ? (
          <OnboardingWelcomeView
            onStart={settingsSync.actions.close}
            onOpenMigration={() => {
              setView("wizard");
              setWizardStep("session");
            }}
          />
        ) : (
          <div className="flex h-full min-h-0 min-w-0">
            <OnboardingWizardSidebar currentStep={wizardStep} />
            <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-hidden p-6">
              <OnboardingWizardHeader title={dialogTitle} description={dialogDescription} />
              <div className="min-h-0 flex-1">{renderWizardBody()}</div>
              <OnboardingWizardFooter
                currentStep={wizardStep}
                selectedWorkspaceCount={selectedWorkspaceCount}
                settingsTaskCount={settingsTaskCount}
                finishRunning={finishExecution.running}
                finishReady={finishExecution.finished}
                onBackToWelcome={() => setView("welcome")}
                onBackStep={goToPreviousWizardStep}
                onNextStep={goToNextWizardStep}
                onBeginMigration={() => void handleBeginMigration()}
                onFinish={settingsSync.actions.finish}
                beginMigrationDisabled={beginMigrationDisabled}
              />
              {/*
                暂时隐藏数据迁移向导里的代理设置步骤，批量选择按钮随步骤一起隐藏。
                onAgentSettingsBulkToggle={toggleAgentSettingsBulk}
                agentSettingsBulkToggleDisabled={agentSettingsBulkToggleDisabled}
                agentSettingsBulkIsClear={agentSettingsFullySelected}
              */}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
