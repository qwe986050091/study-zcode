// INV-01 自动扫描是七条件同时成立：守住位置 shouldAutoScanOnboardingSessions 的与运算；改错故障 漏判任一条件都会在扫描中或已有候选时重复开跑。
// INV-02 已扫描标记由调用方持有：守住位置 hasAutoScannedInCurrentEntry 只读不改写；改错故障 hook 内自行重置语义，每次进入向导都会被再扫一遍。
// INV-03 迁移入口必须互斥：守住位置 函数开头对 runningFinishRef.current 的早返回；改错故障 重复渲染或严格模式双调用会让同一批会话被导入两次。
// INV-04 互斥锁只在 finally 释放：守住位置 finally 中的复位语句；改错故障 失败路径提前退出会让此后所有迁移被永久挡住。
// INV-05 开跑前整体重建执行态：守住位置 首次 setFinishExecution 传入完整初始对象；改错故障 沿用上一轮计数，进度与总数对不上。
// INV-06 sessionTotalCount 记的是 workspace 组数：守住位置 取 selectedWorkspaceGroups.length；改错故障 用候选会话数当总数，进度会中途超过 100%。
// INV-07 workspace 之间有严格先后：守住位置 循环内的 await 串行推进；改错故障 改成并发会让同一批会话的计量错乱且失败点无法定位。
// INV-08 空结果必须当作失败：守住位置 importSessions 返回假值时的抛错；改错故障 静默继续会让用户以为导入成功而实际零迁移。
// INV-09 失败即中断整轮：守住位置 只有一个 try 包住全部阶段；改错故障 吞掉会话错误继续跑 agents 与 settings，最终状态自相矛盾。
// INV-10 agents 文件只在选中时计入：守住位置 selected 判定与 total 取 1 或 0；改错故障 未选中仍累加总数，进度永远差一格。
// INV-11 copy 抛错先记账再上抛：守住位置 catch 内先补 completed 与 failed；改错故障 计数停在上一阶段，界面显示进行中而实际已结束。
// INV-12 agents 结果按 status 分流：守住位置 copied 与 skipped 的三元累加；改错故障 跳过被记成失败，用户误以为文件迁移出错。
// INV-13 settings 阶段有独立开关：守住位置 includeSettingsSelections 的默认值与条件；改错故障 关闭开关后仍导入当前勾选，越过调用方的裁剪意图。
// INV-14 settings 阶段可整体跳过：守住位置 selectedCount 与 additional 的联合判定；改错故障 零选择仍进入阶段，写完阶段名后立刻结束。
// INV-15 currentTaskLabel 随阶段切换：守住位置 每个阶段开始前的那次提交；改错故障 标签停留在上一阶段，用户看到已完成步骤的名字。
// INV-16 成功态是 running=false 且 finished=true：守住位置 全部阶段之后的那次提交；改错故障 只置 finished 不置 running，界面按钮保持禁用。
// INV-17 异常归一化为可展示文本：守住位置 catch 中的 Error 判定；改错故障 直接塞入异常对象，渲染层拿到不可序列化的值而崩溃。
// INV-18 自动触发只认 wizard 与 migration：守住位置 useEffect 开头的三条件早返回；改错故障 其他步骤触发迁移，未选定的 workspace 被按空集执行。
//
// 模块职责：把向导里选定的 workspace 会话、agents 文件与设置选择串成一次有序迁移，并对外暴露唯一的进度状态与重置入口。
// 状态所有权：finishExecution 与 runningFinishRef 归本 hook 所有，组件只读进度；会话、文件与设置的导入事实分别归三个外部 hook。
// 阅读顺序：先看 shouldAutoScanOnboardingSessions 与分组函数，再看 startUnifiedMigration 的阶段顺序，最后看触发用的 effect 与重置。
import { useCallback, useEffect, useRef, useState } from "react";
import type { SettingsSyncSelection } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getPathLeaf } from "@/lib/path.js";
import type { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import type { useSettingsSync } from "@/hooks/useSettingsSync.js";
import {
  createInitialFinishExecutionState,
  type FinishExecutionState,
} from "@/onboarding/OnboardingFlowParts.js";
import type { OnboardingView, OnboardingWizardStep } from "@/onboarding/OnboardingDialogParts.js";
import type { OnboardingAgentsFileMigrationState } from "@/onboarding/useOnboardingAgentsFileMigration.js";

// 纯判定函数，无副作用：只读 params 的七个字段，返回值决定迁移步骤是否自动开跑。
// 七个条件是严格的与关系，任一条不满足都返回 false，没有「部分满足也扫描」的降级路径。
// candidateCount 必须为 0 才扫描：已有候选项时再扫会覆盖用户当前看到的选择界面。
// isScanning 与 scanError 两道闸门分别挡住并发扫描和失败后的自动重试风暴。
// hasAutoScannedInCurrentEntry 由调用方在每次进入向导时重置，函数本身既不持有也不改写它。
export function shouldAutoScanOnboardingSessions(params: {
  view: OnboardingView;
  wizardStep: OnboardingWizardStep;
  supported: boolean;
  isScanning: boolean;
  candidateCount: number;
  scanError: string | null;
  hasAutoScannedInCurrentEntry: boolean;
}): boolean {
  return (
    params.view === "wizard" &&
    params.wizardStep === "session" &&
    params.supported &&
    !params.isScanning &&
    params.candidateCount === 0 &&
    !params.scanError &&
    !params.hasAutoScannedInCurrentEntry
  );
}

// 输入顺序即输出顺序：flatMap 保证分组顺序与用户在向导里的勾选次序一致，不额外排序。
// 零匹配的 workspace 直接丢弃而不是产出空组，避免进度总数虚高、循环里空转一次。
// sessionIds 只取 workspacePath 完全相等的候选，跨 workspace 的会话不会被顺手带走。
// label 只用 getPathLeaf 生成展示文本，不能拿它做匹配键——同名目录在不同路径下会冲突。
// 每个分组都是新对象，调用方可以把它当作一次导入的边界，不会被后续筛选改写。
function groupWorkspaceCandidates(
  workspacePaths: string[],
  allCandidates: ReturnType<typeof useClaudeSessionMigration>["candidates"],
) {
  return workspacePaths.flatMap((workspacePath) => {
    const matches = allCandidates.filter((candidate) => candidate.workspacePath === workspacePath);
    if (matches.length === 0) {
      return [];
    }

    return [
      {
        workspacePath,
        label: getPathLeaf(workspacePath),
        sessionIds: matches.map((candidate) => candidate.sessionId),
      },
    ];
  });
}

// 对外契约：入参决定自动触发时机，返回 finishExecution 快照与 resetFinishExecution 两个出口。
// finishExecution 是本 hook 唯一的进度事实，组件只读不写，推进全部走内部 setFinishExecution。
// options.includeSettingsSelections 缺省视为 true，调用方显式传 false 才关闭当前勾选的导入。
// 回调依赖数组逐项列出，agentsFileMigration 与 settingsSync.actions 变化会重建回调并触发新的 effect。
// 这里不直接持有服务实例，会话、agents 文件与设置导入都通过外部 hook 暴露的能力完成。
export function useOnboardingMigration(
  view: OnboardingView,
  wizardStep: OnboardingWizardStep,
  selectedWorkspacePaths: string[],
  additionalSettingsSelections: SettingsSyncSelection[],
  sessionMigration: ReturnType<typeof useClaudeSessionMigration>,
  agentsFileMigration: OnboardingAgentsFileMigrationState,
  settingsSync: ReturnType<typeof useSettingsSync>,
  options: { includeSettingsSelections?: boolean } = {},
) {
  const { intl } = useZCodeIntl();
  const [finishExecution, setFinishExecution] = useState<FinishExecutionState>(
    createInitialFinishExecutionState,
  );
  // 用 ref 而不是 state 做互斥：本轮渲染内同步可见，连续两次调用不会都读到 false。
  // 写入发生在任何 await 之前，保证同一事件循环里的第二次进入直接早返回。
  // 成功、失败、异常三种收尾都归到 finally，避免某条路径忘记解锁。
  // 锁只保护「一次迁移」，不保护重复计数——计数仍需依赖函数式更新累加。
  // 不要改成依赖禁用态之类的界面状态，那会随渲染时序滞后，挡不住同帧内的重入。
  const runningFinishRef = useRef(false);

  const startUnifiedMigration = useCallback(async () => {
    if (runningFinishRef.current) {
      return;
    }

    runningFinishRef.current = true;
    const selectedWorkspaceGroups = groupWorkspaceCandidates(
      selectedWorkspacePaths,
      sessionMigration.candidates,
    );

    setFinishExecution({
      started: true,
      running: true,
      finished: false,
      sessionCompletedCount: 0,
      sessionTotalCount: selectedWorkspaceGroups.length,
      sessionImportedCount: 0,
      sessionSkippedCount: 0,
      sessionFailedCount: 0,
      agentsFileCompletedCount: 0,
      agentsFileTotalCount: agentsFileMigration.selected ? 1 : 0,
      agentsFileImportedCount: 0,
      agentsFileSkippedCount: 0,
      agentsFileFailedCount: 0,
      currentTaskLabel: null,
      error: null,
    });

    try {
      // 逐个 workspace 串行 await，上一个的结果确认后才推进下一个，失败点因此可精确归因。
      // index 严格递增，不跳过不重排；workspace 缺失时 continue 只是防御异常数据，不是正常路径。
      // 每轮先写 currentTaskLabel 再发起导入，用户能看到当前正在处理哪个目录。
      // 计数一律基于函数式更新累加，避免闭包里读到过期的 current 而造成丢失。
      // 任一轮抛错会直接离开循环，后续 workspace 与其他阶段都不再执行，收口交给外层 catch。
      for (let index = 0; index < selectedWorkspaceGroups.length; index += 1) {
        const workspace = selectedWorkspaceGroups[index];
        if (!workspace) {
          continue;
        }

        setFinishExecution((current) => ({
          ...current,
          currentTaskLabel: intl.formatMessage(
            { id: "onboarding.finish.currentWorkspace" },
            { workspace: workspace.label },
          ),
        }));

        const result = await sessionMigration.importSessions(workspace.sessionIds);
        if (!result) {
          throw new Error(sessionMigration.importError ?? "Session migration failed");
        }

        setFinishExecution((current) => ({
          ...current,
          sessionCompletedCount: current.sessionCompletedCount + 1,
          sessionImportedCount: current.sessionImportedCount + result.imported.length,
          sessionSkippedCount: current.sessionSkippedCount + result.skipped.length,
          sessionFailedCount: current.sessionFailedCount + result.failed.length,
        }));
      }

      // 只有用户在向导里选中 agents 文件时才进入该阶段，total 在开跑时已固定为 1 或 0。
      // copied 与 skipped 是两种成功，计数按 status 分流；failed 只由 catch 分支累加。
      // copy 抛错时先把 completed 与 failed 补齐再上抛，保证「总数 = 完成数」在失败时仍成立。
      // 先写 currentTaskLabel 再调用，是为了失败时用户看到的阶段名与真正执行的阶段一致。
      if (agentsFileMigration.selected) {
        setFinishExecution((current) => ({
          ...current,
          currentTaskLabel: intl.formatMessage({
            id: "onboarding.finish.currentAgentsFile",
          }),
        }));

        try {
          const result = await agentsFileMigration.copy();
          setFinishExecution((current) => ({
            ...current,
            agentsFileCompletedCount: current.agentsFileCompletedCount + 1,
            agentsFileImportedCount:
              current.agentsFileImportedCount + (result.status === "copied" ? 1 : 0),
            agentsFileSkippedCount:
              current.agentsFileSkippedCount + (result.status === "skipped" ? 1 : 0),
          }));
        } catch (copyError) {
          setFinishExecution((current) => ({
            ...current,
            agentsFileCompletedCount: current.agentsFileCompletedCount + 1,
            agentsFileFailedCount: current.agentsFileFailedCount + 1,
          }));
          throw copyError;
        }
      }

      // 默认 true 是保持旧行为的兼容选择：不传 options 的调用方仍然导入当前勾选的设置项。
      // 关闭开关后 selectedCount 直接归零，但 additionalSettingsSelections 仍然生效，两者语义不同。
      // 联合判定用或：任一来源非空就进入设置阶段，否则整段跳过，连 currentTaskLabel 都不写。
      // additional 是本次迁移临时追加的项，不写入 settingsSync 的持久选择，只影响这一次导入。
      // 此处不读取导入结果：设置导入的失败由 settingsSync 自身状态承载，本 hook 不重复记账。
      const includeSettingsSelections = options.includeSettingsSelections ?? true;
      const selectedSettingsCount = includeSettingsSelections ? settingsSync.selectedCount : 0;
      if (selectedSettingsCount > 0 || additionalSettingsSelections.length > 0) {
        setFinishExecution((current) => ({
          ...current,
          currentTaskLabel: intl.formatMessage({
            id: "onboarding.finish.currentSettings",
          }),
        }));
        await settingsSync.actions.startImportWithAdditionalSelections(
          additionalSettingsSelections,
          { includeCurrentSelections: includeSettingsSelections },
        );
      }

      setFinishExecution((current) => ({
        ...current,
        running: false,
        finished: true,
        currentTaskLabel: null,
      }));
    } catch (error) {
      setFinishExecution((current) => ({
        ...current,
        running: false,
        finished: true,
        error: error instanceof Error ? error.message : String(error),
        currentTaskLabel: null,
      }));
    } finally {
      runningFinishRef.current = false;
    }
  }, [
    additionalSettingsSelections,
    agentsFileMigration,
    intl,
    selectedWorkspacePaths,
    sessionMigration,
    settingsSync.actions,
    settingsSync.selectedCount,
    options.includeSettingsSelections,
  ]);

  // 自动触发只有一条路径：进入 wizard 的 migration 步骤且尚未开跑时调用一次。
  // finishExecution.started 是幂等闸门，它由 startUnifiedMigration 内首次提交置为 true。
  // 三条件里任一不满足就早返回，切回上一步再进来不会重跑已完成的迁移。
  // 依赖数组包含 started 与回调本身，回调因依赖变化重建时会重新求值，但仍受 started 约束。
  // 该 effect 没有清理函数，也没有取消令牌：离开向导不会中止已在飞的导入，这是既有语义。
  useEffect(() => {
    if (view !== "wizard" || wizardStep !== "migration" || finishExecution.started) {
      return;
    }

    void startUnifiedMigration();
  }, [finishExecution.started, startUnifiedMigration, view, wizardStep]);

  const resetFinishExecution = useCallback(() => {
    setFinishExecution(createInitialFinishExecutionState());
  }, []);

  return { finishExecution, resetFinishExecution };
}
