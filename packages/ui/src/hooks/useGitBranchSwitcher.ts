// useGitBranchSwitcher：Git 分支下拉框的全部交互状态与调用编排入口——展开列表、切换分支、
// 新建并切换、冲突后提交再重试切换，都由这一个 hook 持有并串起来。
// 边界：不实现任何 Git 命令、不判定脏文件冲突、不拼装提示文案（分别在 gitService 与
// git-branch-switcher/display.js、switchAssist.js 中）；不持有全局 Git 摘要，只通过 onRefreshGit 请求上层刷新。
//
// 不变量清单（任一条被破坏都会在真实桌面/Web 会话里产生可见故障，改动前逐条核对）：
// INV-01 断言：workspacePath 变化必须清空分支快照与切换辅助态 —— 守住它的位置：首个重置 useEffect 的依赖 —— 改错故障：切换工作区后仍显示上一仓库分支，并可能对错误仓库发起切换。
// INV-02 断言：currentBranchName 或 headRefType 变化且下拉框已关闭时，必须丢弃 branchesResult —— 守住它的位置：openRef 守卫的 useEffect —— 改错故障：外部切分支后标签长期显示旧分支名，用户误以为切换失败。
// INV-03 断言：下拉框展开期间禁止清空 branchesResult —— 守住它的位置：同一 useEffect 的提前返回 —— 改错故障：列表在展开瞬间闪烁并跌回单一分支视图。
// INV-04 断言：HEAD 重置 useEffect 不得触发任何 RPC 或 onRefreshGit —— 守住它的位置：该 effect 回调体 —— 改错故障：watcher 回灌与刷新形成自激回路，CPU 与日志暴涨。
// INV-05 断言：每次展开都必须重新读取分支列表，禁止复用上次快照 —— 守住它的位置：依赖 open 的 useEffect —— 改错故障：切换成功后再展开仍看到旧分支名与已删除分支。
// INV-06 断言：loadingBranches 必须在 finally 复位 —— 守住它的位置：loadBranches 的 try/finally —— 改错故障：一次 RPC 抛错后列表永久停在骨架屏。
// INV-07 断言：result.ok 为 false 时必须先尝试 prepareSwitchAssistState，再回退普通提示 —— 守住它的位置：handleMutationResult 的失败分支 —— 改错故障：可自动提交解决的冲突被降级成一次性错误，用户无法继续。
// INV-08 断言：prepareSwitchAssistState 返回 false 才允许 notifyMutationFailure —— 守住它的位置：handleMutationResult 中等待分支的判断 —— 改错故障：同一次失败出现错误提示与失败卡片双重反馈。
// INV-09 断言：进入 blocked 步骤前必须清空 commitMessage 与 commitError —— 守住它的位置：prepareSwitchAssistState 的 setState 序列 —— 改错故障：上一轮残留输入被带入新冲突，产生错误提交信息。
// INV-10 断言：成功路径只有 didChange 或 created 为真时才回调 onRefreshGit —— 守住它的位置：handleMutationResult 尾部判断 —— 改错故障：切到当前分支的 no-op 触发多余全量刷新，与 watcher 互相拉扯。
// INV-11 断言：成功路径必须先更新本地 branchesResult 再做全局刷新 —— 守住它的位置：setBranchesResult 局部投影 —— 改错故障：全局摘要尚未回灌时下拉框回落到旧分支，出现可见跳动。
// INV-12 断言：mutationPending 必须在每个 try/finally 的 finally 复位 —— 守住它的位置：switchBranch、createBranchAndSwitch、commitAndSwitchBranch —— 改错故障：任一异常后所有分支按钮永久禁用，只能重启窗口。
// INV-13 断言：提交前必须用 hasGitCommitIdentity 拦截身份缺失 —— 守住它的位置：commitAndSwitchBranch 的早退分支 —— 改错故障：无用户名或邮箱时发起提交，git 报错并卡在 commit 步骤无法自愈。
// INV-14 断言：空提交信息必须回落到 buildGitBranchAutoCommitMessage —— 守住它的位置：nextCommitMessage 的取值 —— 改错故障：提交因空信息失败，自动重试切换的整条链路中断。
// INV-15 断言：stagePaths 为空时不得调用 stagePaths —— 守住它的位置：stagePaths 长度判断 —— 改错故障：对空路径集发起 RPC，返回无意义错误并阻断后续提交。
// INV-16 断言：提交成功后必须先 onRefreshGit 再发起切换 —— 守住它的位置：commitAndSwitchBranch 的调用顺序 —— 改错故障：切换读到提交前的状态，工作区仍被视为脏而再次 blocked。
// INV-17 断言：分支名校验只在 trim 后为空时报错，不得改写用户输入 —— 守住它的位置：createBranchAndSwitch 开头 —— 改错故障：合法输入被静默改造，创建出非预期名字的分支。
// INV-18 断言：成功路径必须收敛下拉框、创建对话框与切换辅助态 —— 守住它的位置：成功分支的 setState 序列 —— 改错故障：切换成功后浮层同时留在屏幕上，遮住编辑器。
//
// 阅读提示：本文件所有等待点都可能跨越组件卸载，内部不再二次校验挂载状态，
// 依赖 React 对已卸载组件 setState 的静默丢弃语义；不要在这里补挂载守卫而引入额外渲染分支。
// 所有提示都必须经 intl.formatMessage 走国际化，直接传英文字符串会在中文或日文环境露出原文。
// 所有日志只记录路径、分支名、issue code 与错误消息，禁止把文件内容或凭据写入日志。
// mutationPending 是全局互斥位而非单个按钮的加载态，改动前先核对三处调用与互斥关系。
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitBranchMutationResult,
  GitLocalBranchListResult,
  GitRepositorySummary,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchAutoCommitMessage,
  getPrimaryGitBranchIssue,
  resolveGitBranchIssueMessageId,
  resolveGitBranchSuccessMessageId,
  summarizeGitBranchIssuePaths,
} from "@/git-branch-switcher/display.js";
import {
  buildGitBranchSwitchAssistState,
  formatGitBranchIssuePathList,
  hasGitCommitIdentity,
  type GitBranchSwitchAssistDialogStep,
  type GitBranchSwitchAssistState,
} from "@/git-branch-switcher/switchAssist.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

// [契约] 选项只接收 Git 摘要的投影值，不接收 gitService 或 store：hook 内部自行取服务，外部再传会造成双份实例与订阅撕裂。
// currentBranchName 允许为 null（游离 HEAD 或仓库未就绪），调用方必须原样透传而非兜底成空串，空串会被当成真实分支名参与比较。
// onRefreshGit 是唯一的全局刷新出口，禁止改成直接把摘要写入某个 store，否则与 watcher 回灌形成两个写者。
interface UseGitBranchSwitcherOptions {
  workspacePath: string;
  // gitSummary 是 HEAD 的真实来源(由文件 watcher 实时回灌)。传入它的当前分支/HEAD 类型，
  // 用于在底层 HEAD 变化时丢弃可能过期的本地分支快照。
  currentBranchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  onRefreshGit: () => void;
}

// 所有状态都住在 hook 内，组件卸载即消失；不放进 Zustand 是刻意选择，分支快照属于瞬时投影，跨窗口共享只会引入过期数据。
// 返回对象是扁平结构，新增字段必须同步组件侧消费方；不要在返回里塞内联函数，否则每次渲染都产生新引用并打穿 memo。
// 这里不做 workspacePath 合法性校验，由调用方保证已就绪；在 hook 内抛错会让整个分支下拉框在首帧崩溃。
export function useGitBranchSwitcher({
  workspacePath,
  currentBranchName,
  headRefType,
  onRefreshGit,
}: UseGitBranchSwitcherOptions) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  // [契约] 步骤与辅助态必须成对演进：步骤非空而辅助态为空时，提交卡片会渲染空数据并读到未定义属性。
  // [权衡] 拆成两个 useState 而不是一个联合对象，是为了让步骤切换不重建整份辅助态；代价是两处写点必须同步。
  // 关闭对话框统一走 resetSwitchAssistState，不要手动只把步骤置空，否则残留辅助态会在下次 blocked 时被复用。
  const [switchAssistStep, setSwitchAssistStep] = useState<GitBranchSwitchAssistDialogStep | null>(
    null,
  );
  const [switchAssistState, setSwitchAssistState] = useState<GitBranchSwitchAssistState | null>(
    null,
  );
  const [branchesResult, setBranchesResult] = useState<GitLocalBranchListResult | null>(null);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);

  const resetSwitchAssistState = useCallback(() => {
    setSwitchAssistStep(null);
    setSwitchAssistState(null);
    setCommitMessage("");
    setCommitError(null);
  }, []);

  // [并发] 展开动作可被快速连点，这里没有请求序号或中断控制；最后一次先返回、前一次后返回时，旧快照会覆盖新快照。
  // 当前接受这个风险，因为列表内容在短窗口内基本一致；若要修，加递增序号丢弃过期响应，不要用防抖掩盖延迟。
  // 依赖里的 intl 参与错误文案，切到另一语言后必须换出新的回调，否则提示沿用旧语言。
  const loadBranches = useCallback(async () => {
    setLoadingBranches(true);

    try {
      // 返回值整体替换而不合并，避免上一工作区的分支残留在数组里，这里刻意不做展开旧数组的写法。
      // RPC 期间 workspacePath 可能已切换，成功回调会把旧仓库结果写进新工作区，这是已知窗口，由外层重置 effect 兜底。
      const nextResult = await gitService.getLocalBranches({ workspacePath });
      setBranchesResult(nextResult);
    // [失败路径] 读列表失败只提示不抛，保持下拉框可再次点击重试；抛出去会被错误边界吞掉，用户看不到任何反馈。
    // 错误对象类型未知，必须经 getErrorMessage 归一化；直接把原对象插进国际化变量会显示成一串无意义文本。
    // 这里不清空 branchesResult：保留上一次成功快照比清空更可用，清空会让列表瞬间跌回单一分支视图。
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 读取本地分支失败", {
        workspacePath,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setLoadingBranches(false);
    }
  }, [gitService, intl, workspacePath]);

  // [契约] 工作区切换的重置清单必须与新增状态同步维护；漏掉任何一个，都会把上一仓库的临时值带进新仓库。
  // [事务] 这一组 setState 在同一个 effect 内同步执行，React 合并成一次渲染，不要拆成多个 effect 而引入中间可见态。
  // resetSwitchAssistState 是稳定引用，可安全放进依赖；若改为内联函数，本 effect 每次渲染后重跑并反复清空列表。
  useEffect(() => {
    setOpen(false);
    setCreateDialogOpen(false);
    setCreateBranchName("");
    setBranchesResult(null);
    resetSwitchAssistState();
  }, [resetSwitchAssistState, workspacePath]);

  // [权衡] 用 ref 镜像展开态，是为了让下面的重置 effect 只在 HEAD 变化时触发；把展开态放进依赖，关闭下拉框的一瞬也会清空快照。
  // 赋值写在渲染期而不是 effect 里，保证 HEAD 与展开态在同一次提交中读到最新值；挪进 effect 会晚一帧。
  // 不要改成布局 effect 同步，这里的读取发生在后续 effect 中，渲染期直接赋值已经足够。
  const openRef = useRef(open);
  openRef.current = open;
  // [契约] 这是 HEAD 变化的唯一响应点：只清本地快照，绝不发起 RPC 或刷新，避免与 watcher 回灌形成自激。
  // 依赖必须是 currentBranchName 与 headRefType 这类原始值；若传入整个摘要对象，引用每次刷新都变，会退化成无限清空。
  useEffect(() => {
    // 关键业务逻辑：gitSummary 的 HEAD 一旦变化(例如外部命令切分支、watcher 实时回灌)，
    // 就丢弃上一次展开下拉框时缓存的本地分支快照，让底部分支标签回落到 gitSummary.branchName。
    // 否则 branchesResult.currentBranchName 的旧值会长期遮挡真实分支名，出现“切了不变”。
    // 注意：这里只重置本地 UI state，不触发任何刷新 / RPC，避免重新引入 refresh<->watcher 自激回路。
    if (openRef.current) {
      // 下拉框展开时正展示实时列表，不清空以免列表闪烁；关闭后下次展开会通过 loadBranches 重新拉取。
      return;
    }
    setBranchesResult(null);
  }, [currentBranchName, headRefType]);

  // [资源] 每次展开都重新拉取，依赖里带展开态让关闭时也重跑一次，但提前返回保证不发请求。
  // loadBranches 自身作为依赖，语言或工作区变化会连带触发一次重新拉取，这是期望行为，不要去掉。
  // 不要在展开时并发重置切换辅助态：列表与提交卡片是两条独立路径，交叉重置会让卡片刚出现就消失。
  useEffect(() => {
    if (!open) {
      return;
    }

    // 关键业务逻辑：分支列表每次展开都重新读取一次，避免切换成功后还复用上一次打开时的旧快照。
    void loadBranches();
  }, [loadBranches, open]);

  // [契约] 这里是所有非自动可解失败的唯一提示出口；新增错误码必须先接进 messageId 解析，否则会退回原始 detail 文案。
  // 依赖里的数字格式化器随语言重建，不要把格式化结果缓存到模块级常量，切换语言后会显示旧分隔符。
  const notifyMutationFailure = useCallback(
    (result: GitBranchMutationResult) => {
      const issue = getPrimaryGitBranchIssue(result.issues);
      const messageId = resolveGitBranchIssueMessageId(issue);
      // [失败路径] 问题列表为空说明服务端只回了失败却未给原因，此时只能给通用错误；不要猜测成冲突而误导用户。
      // 提前返回是必要的，下面所有分支都假定问题非空并直接读取其路径字段。
      if (!issue) {
        toast(intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }));
        return;
      }

      // [契约] 命中已知错误码时，分支名优先取问题详情，其次回退结果里的分支名；顺序颠倒会把目标分支名覆盖成摘要里的当前分支名。
      // 可见路径与剩余数量由摘要函数截断，超出的部分只报数量；不要把全部路径塞进提示，长列表会撑爆提示条。
      // 额外路径为空时传空串而不是省略变量，国际化模板里保留占位符，省略会让其他语言的句式断掉。
      if (messageId) {
        const { visiblePaths, remainingCount } = summarizeGitBranchIssuePaths(issue.paths);
        const extraPaths =
          remainingCount > 0
            ? intl.formatMessage(
                { id: "git.branchSwitcher.error.moreFiles" },
                { count: numberFormatter.format(remainingCount) },
              )
            : "";
        toast(
          intl.formatMessage(
            { id: messageId },
            {
              branchName: issue.detail ?? result.branchName ?? "",
              paths: formatGitBranchIssuePathList(locale, visiblePaths),
              extraPaths,
            },
          ),
        );
        return;
      }

      // [权衡] 未知错误码走兜底文案：优先问题详情（更具体），再回退原始消息，两者都空才用通用文案。
      // 不要在这里把错误码拼给用户看，码值只用于日志排查。
      const fallbackMessage = issue.detail?.trim() || issue.message.trim();
      toast(
        fallbackMessage.length > 0
          ? fallbackMessage
          : intl.formatMessage({ id: "git.branchSwitcher.error.unknown" }),
      );
    },
    [intl, locale, numberFormatter],
  );

  // [事务] 返回真表示已接管失败并切到失败卡片，调用方必须立即返回，禁止再走普通错误提示。
  // 构建辅助态本身可能抛错（内部要读差异与提交身份），调用方用等待包在 try 里；这里不捕获，是为了让异常走请求失败提示。
  // [契约] 进入卡片前清空提交信息与提交错误，避免上一次的残留输入被误提交。
  const prepareSwitchAssistState = useCallback(
    async (result: GitBranchMutationResult): Promise<boolean> => {
      const nextSwitchAssistState = await buildGitBranchSwitchAssistState({
        gitService,
        workspacePath,
        result,
      });
      // [失败路径] 返回空代表这批问题不属于可自动提交类型，交回调用方走普通提示；不要在这里补兜底提示，会造成双重反馈。
      // 返回假与抛异常是两种语义：假是「不适用」，异常是「读取失败」，调用方据此分流。
      if (!nextSwitchAssistState) {
        return false;
      }

      // 关键业务逻辑：overwrite 型阻塞不再直接 toast，而是转成“失败卡片 -> 提交 -> 自动重试切换”流程。
      // 这样用户能先看见真正受影响的文件，再决定是否提交当前更改继续。
      setOpen(false);
      setCreateDialogOpen(false);
      setCommitError(null);
      setCommitMessage("");
      setSwitchAssistState(nextSwitchAssistState);
      setSwitchAssistStep("blocked");
      return true;
    },
    [gitService, workspacePath],
  );

  // [契约] 成功与失败两条路径都必须收敛界面状态；只加成功分支而漏掉失败分支，会让下拉框停在中间态。
  // 动作名只用于日志，不参与面向用户的文案；把它拼进提示会在中文日志之外露出半截英文。
  const handleMutationResult = useCallback(
    async (result: GitBranchMutationResult, actionLabel: string) => {
      // [失败路径] 先写告警日志再判定是否转卡片：日志只记问题码，不记文件内容，避免把用户源码写进日志文件。
      // [契约] 转入失败卡片成功后必须返回，否则会出现错误提示与失败卡片同时出现。
      // 普通错误提示只在辅助态不适用时调用，顺序不可交换。
      if (!result.ok) {
        logger.warn("[GitBranchSwitcher] 分支变更被阻塞", {
          workspacePath,
          action: result.action,
          branchName: result.branchName,
          issues: result.issues.map((issue) => issue.code),
        });
        if (await prepareSwitchAssistState(result)) {
          return;
        }
        notifyMutationFailure(result);
        return;
      }

      const successMessageId = resolveGitBranchSuccessMessageId(result);
      if (successMessageId && result.branchName) {
        toast(intl.formatMessage({ id: successMessageId }, { branchName: result.branchName }));
      }

      logger.info(`[GitBranchSwitcher] ${actionLabel}成功`, {
        workspacePath,
        branchName: result.branchName,
        action: result.action,
        didChange: result.didChange,
        created: result.created,
      });

      setOpen(false);
      setCreateDialogOpen(false);
      setCreateBranchName("");
      resetSwitchAssistState();
      // [事务] 成功后就地投影当前快照，让列表立刻反映新分支，避免等待全局摘要回灌造成一次可见跳动。
      // 当前值为空时原样返回，不凭空造一份列表；造出来的列表缺少真实分支集合，会误导用户。
      setBranchesResult((current) =>
        current
          ? {
              ...current,
              currentBranchName: result.summary.branchName,
              headRefType: result.summary.headRefType,
              branches: current.branches.map((branch) => ({
                ...branch,
                isCurrent:
                  result.summary.branchName !== null && branch.name === result.summary.branchName,
              })),
            }
          : current,
      );
      // 关键业务逻辑：只有真正发生分支变更时才刷新全局 Git 状态。
      // 切到当前分支这类 no-op 已经是成功结果，但没必要再触发一轮额外重拉。
      // [权衡] 切到当前分支属于成功的空操作，不刷新全局；无条件刷新会让 watcher 与刷新互相拉扯，产生额外请求与日志噪音。
      // 新建分支必须单独判断：此时变更标记可能为假，但摘要必须重拉。
      if (result.didChange || result.created) {
        onRefreshGit();
      }
    },
    [
      intl,
      notifyMutationFailure,
      onRefreshGit,
      prepareSwitchAssistState,
      resetSwitchAssistState,
      workspacePath,
    ],
  );

  // [事务] 发起切换后立即关闭下拉框，避免切换完成前用户再点第二个分支；互斥位只负责禁用按钮，不能替代这里的关闭。
  // [失败路径] 请求异常只提示不抛，并在 finally 复位互斥位，保证按钮可用。
  const switchBranch = useCallback(
    async (targetBranchName: string) => {
      setOpen(false);
      setMutationPending(true);

      try {
        const result = await gitService.switchBranch({
          workspacePath,
          targetBranchName,
        });
        await handleMutationResult(result, "切换分支");
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitBranchSwitcher] 切换分支请求失败", {
          workspacePath,
          targetBranchName,
          error: message,
        });
        toast(
          intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
        );
      // [资源] 互斥位必须在 finally 复位；放到 try 尾部会在请求抛错时让所有分支按钮永久禁用，只能重启窗口。
      // 复位后不再触发任何刷新，避免与成功分支里已发出的刷新重复。
      } finally {
        setMutationPending(false);
      }
    },
    [gitService, handleMutationResult, intl, workspacePath],
  );

  // [契约] 创建前只做去空白判空，不改写分支名；折叠空格或改大小写会创建出与用户输入不一致的分支。
  // 创建与切换是同一个请求语义，不要拆成两次调用：拆开会在创建成功但切换失败时留下用户不知道的新分支。
  // [失败路径] 异常只提示并复位互斥位，不关闭创建对话框，让用户改个名字直接重试。
  const createBranchAndSwitch = useCallback(async () => {
    const branchName = createBranchName.trim();
    // [契约] 空名早退发生在置位互斥之前，所以这里不需要复位；把它挪进 try 内部就必须补 finally。
    // 错误提示走国际化键，不要拼接原始输入，避免把非法字符回显进提示。
    if (branchName.length === 0) {
      toast(intl.formatMessage({ id: "git.branchSwitcher.error.invalidBranchName" }));
      return;
    }

    setMutationPending(true);

    try {
      const result = await gitService.createBranchAndSwitch({
        workspacePath,
        branchName,
      });
      await handleMutationResult(result, "创建并切换分支");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 创建并切换分支请求失败", {
        workspacePath,
        branchName,
        error: message,
      });
      toast(
        intl.formatMessage({ id: "git.branchSwitcher.error.requestFailed" }, { error: message }),
      );
    } finally {
      setMutationPending(false);
    }
  }, [createBranchName, gitService, handleMutationResult, intl, workspacePath]);

  const openSwitchCommitDialog = useCallback(() => {
    setCommitError(null);
    setSwitchAssistStep("commit");
  }, []);

  const closeSwitchAssistDialog = useCallback(() => {
    resetSwitchAssistState();
  }, [resetSwitchAssistState]);

  // [事务] 这是三段式链路：可选暂存、提交、重新切换；任何一段抛错都会终止后续，不再尝试切换。
  // 辅助态可能在提交过程中被关闭置空，函数内对它的读取全部在等待之前完成。
  const commitAndSwitchBranch = useCallback(async () => {
    if (!switchAssistState) {
      return;
    }

    // [契约] 身份缺失必须在这里拦截并停在提交步骤；继续提交会让 git 以非零码失败，且错误文案对用户不可理解。
    // 只设置提交错误而不改步骤，是为了让用户补全配置后原地重试；退回失败卡片会丢失已填的提交信息。
    // 不要在此处自动写入用户名或邮箱，那会污染用户的全局 git 配置。
    if (!hasGitCommitIdentity(switchAssistState.identity)) {
      setCommitError(
        intl.formatMessage({
          id: "git.branchSwitcher.commitDialog.identityMissing",
        }),
      );
      return;
    }

    const nextCommitMessage =
      commitMessage.trim() || buildGitBranchAutoCommitMessage(switchAssistState.targetBranchName);

    setCommitError(null);
    setMutationPending(true);

    try {
      logger.info("[GitBranchSwitcher] 开始提交并重试切换分支", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        stagedPathCount: switchAssistState.stagePaths.length,
      });

      // [事务] 只有非空路径集才暂存；空数组调用暂存接口会返回无意义错误并阻断后续提交。
      // 暂存范围严格使用辅助态给出的路径集，不要改成暂存全部，否则会把用户的无关改动一并提交。
      if (switchAssistState.stagePaths.length > 0) {
        await gitService.stagePaths({
          workspacePath,
          paths: switchAssistState.stagePaths,
        });
      }
      // [事务] 提交成功后立刻刷新全局，再发起切换：先刷新能保证切换读到新的暂存状态，否则仍会被判定为脏而再次阻塞。
      // 提交与切换之间没有回滚；若切换失败，用户已获得一个新提交，提示文案必须如实说明这一点。
      await gitService.commit({
        workspacePath,
        message: nextCommitMessage,
      });
      onRefreshGit();

      const result = await gitService.switchBranch({
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
      });
      await handleMutationResult(result, "提交后切换分支");
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitBranchSwitcher] 提交并切换分支失败", {
        workspacePath,
        targetBranchName: switchAssistState.targetBranchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage(
          { id: "git.branchSwitcher.commitDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [
    commitMessage,
    gitService,
    handleMutationResult,
    intl,
    onRefreshGit,
    switchAssistState,
    workspacePath,
  ]);

  // [契约] 返回的是稳定引用（各回调均有依赖约束），组件侧可直接解构；新增字段要同步更新使用方，避免解构到空值。
  // 不要把快照设置器或重置函数暴露出去，外部改写快照会绕过投影逻辑并引入第二个写者。
  return {
    open,
    setOpen,
    createDialogOpen,
    setCreateDialogOpen,
    createBranchName,
    setCreateBranchName,
    commitMessage,
    setCommitMessage,
    commitError,
    switchAssistStep,
    switchAssistState,
    branchesResult,
    loadingBranches,
    mutationPending,
    switchBranch,
    createBranchAndSwitch,
    openSwitchCommitDialog,
    closeSwitchAssistDialog,
    commitAndSwitchBranch,
  };
}
