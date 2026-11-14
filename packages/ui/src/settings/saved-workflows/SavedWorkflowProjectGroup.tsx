// 单项目工作流组：用本项目自己的 agent service 拉列表与运行历史，监听本项目的
// `<ws>/.zcode/workflows` 目录，并承载运行 / 修订 / 复制路径 / 删除 / 提升为全局 / 进详情。
// 不负责：文件解析与校验（store 的 load 承担）、跨项目排序与分组（父页承担）、
// 卡片与弹窗内部渲染（SavedWorkflowCard / SavedWorkflowLaunchDialog 自持），也不负责
// 全局档的任何事情——它与 useSavedWorkflowGlobalGroup 是并列兄弟，不共享状态。
//
// 不变量（每条都对应一次真实的线上故障形态，改前先自查）：
// INV-01 断言：每个 RPC 都带本项目 target，绝不回落到活动 workspace —— 守住它的位置：resolution 与 target/projectTarget/launchTarget —— 改错故障：在项目 A 的组里删掉或运行项目 B 的工作流。
// INV-02 断言：workspaceKey 由 path 与 identity 合成，只用于 testId 与页级状态回报 —— 守住它的位置：workspaceKey 的 useMemo 与 onStateChange —— 改错故障：远程会话的 identity 被路径覆盖，父页把状态记到另一个组上。
// INV-03 断言：target 含 remoteSessionId，projectTarget 不含 —— 守住它的位置：useSavedWorkflowProjectTargets 的返回 —— 改错故障：远程项目的对话打开到了本机同名路径。
// INV-04 断言：refresh 必须等 rpcReady 为真才发请求 —— 守住它的位置：refresh 的首个 guard —— 改错故障：连接未就绪时拉列表，组永久停在错误态直到手动刷新。
// INV-05 断言：页级 refreshSeq 首次挂载不触发第二次拉取 —— 守住它的位置：lastRefreshSeq 的 useRef 比较 —— 改错故障：每次进页都双发 list 与 runs，闪烁并放大远端负载。
// INV-06 断言：目录监听失败是常态且只记 debug，不得冒泡成组错误 —— 守住它的位置：useSavedWorkflowsDirectoryWatch 的 catch —— 改错故障：没有 workflows 目录的项目整组显示加载失败。
// INV-07 断言：empty 只在 loaded 且 entries 与 invalid 同时为空时为真 —— 守住它的位置：empty 的表达式 —— 改错故障：只有坏文件的组被当成空组隐藏，用户看不到文件损坏提示。
// INV-08 断言：卡片上的「上次运行」按工作流名匹配，不按路径 —— 守住它的位置：lastRunByWorkflowName —— 改错故障：重命名或换目录后运行历史整片消失。
// INV-09 断言：实参窗只在 launch 成功时关闭 —— 守住它的位置：launch 内的 setLaunchEntry —— 改错故障：启动被拒仍关窗，用户看不到拒绝原因也无法重试。
// INV-10 断言：无实参路径失败只能靠窗外 toast 呈现 —— 守住它的位置：handleRun 里 launch 的回调 —— 改错故障：失败无任何提示，用户以为已经跑起来。
// INV-11 断言：删除必须先确认再发 RPC，且 finally 里必做 bypass 刷新 —— 守住它的位置：handleDelete —— 改错故障：磁盘已删但列表仍显示，再点删除报「不存在」。
// INV-12 断言：busyName 在异常路径也要复位 —— 守住它的位置：handleDelete / handlePromote 的 finally —— 改错故障：一次失败后该卡片永久转圈且按钮禁用。
// INV-13 断言：远程项目不提供「提升为全局」 —— 守住它的位置：isLocalProject 及各处的 onMove 条件 —— 改错故障：提升出来的全局档落在远端 home，本机中枢永远看不见。
// INV-14 断言：详情态与列表态共用同一份 store 状态与同一个实参窗 —— 守住它的位置：mode.kind 分支与 launchDialog —— 改错故障：两处各持一份 launchEntry，详情里改完回列表丢失。
//
// 阅读顺序：resolution → targets → store 订阅 → refresh 与监听 → 动作回调 → 渲染分支。
// 状态所有者：列表与运行历史在 savedWorkflowStore（按 workspaceKey 分片），本组件只做投影。
// 并发点：launcher 与 promoter 内部有 pendingRef 防重入，本组件不再加锁，busyName 只控视觉。
// 事务边界：删除与提升都以一次 bypass 刷新收尾，不要在中途插入局部状态掩盖磁盘事实。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_LIST,
  TID_WORKFLOW_PROJECT_GROUP,
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
} from "@zcode/shared";
import { testId } from "@zcode/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { useSavedWorkflowsDirectoryWatch } from "@/settings/saved-workflows/useSavedWorkflowsDirectoryWatch.js";
import { SavedWorkflowCard } from "@/settings/saved-workflows/SavedWorkflowCard.js";
import { SavedWorkflowDetailView } from "@/settings/saved-workflows/SavedWorkflowDetailView.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import {
  buildSavedWorkflowCreatePrompt,
  buildSavedWorkflowRevisePrompt,
} from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  useSavedWorkflowLauncher,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import { useSavedWorkflowProjectTargets } from "@/settings/saved-workflows/useSavedWorkflowProjectTargets.js";
import { lastRunByWorkflowName } from "@/settings/saved-workflows/savedWorkflowRunHistory.js";
import { useSavedWorkflowPromote } from "@/settings/saved-workflows/useSavedWorkflowPromote.js";
import { useSavedWorkflowRunOpeners } from "@/settings/saved-workflows/useSavedWorkflowRunOpeners.js";
import type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";
import { selectSavedWorkflowState, useSavedWorkflowStore } from "@/store/savedWorkflowStore.js";

// 组把加载态回报给页的类型定义在 savedWorkflowContract；这里再导出，历史 import 路径不变。
export type {
  SavedWorkflowGroupMode,
  SavedWorkflowGroupState,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

// [契约] props 分三类：project / isCurrent / refreshSeq 是输入，mode 是路由，on* 是回传口。
// isCurrent 只影响「当前」小标与 data 属性，不改变任何 target，别拿它裁剪请求。
// refreshSeq 变一次就绕过缓存重拉，父页用它做页级刷新而不重建本组。
interface SavedWorkflowProjectGroupProps {
  project: AutomationWorkspaceOption;
  /** 活动 workspace 的组带「当前」小标；只影响标记，不影响任何 target。 */
  isCurrent: boolean;
  /** 页级刷新计数器；变化（非首挂）时本组绕过缓存重拉。 */
  refreshSeq: number;
  mode: SavedWorkflowGroupMode;
  onStateChange: (workspaceKey: string, state: SavedWorkflowGroupState) => void;
  onOpenDetail: (name: string) => void;
  onBack: () => void;
  /** 「运行」= GUI 直接启动：accepted 后切到新会话。 */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** 产物 chip → `workflow-artifact` tab。 */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
}

/**
 * 单个项目的工作流组：接过 v1 单项目 section 的全部
 * 职责——用**本项目**的 agent 代理拉列表 / 运行历史、监听本项目目录、运行 / 修订 / 复制 / 删除 /
 * 提升为全局 / 进详情，全部带本项目的 target。组头 = 项目名 + 「当前」小标 + 数量 +
 * 「通过对话创建」。
 */
export function SavedWorkflowProjectGroup({
  project,
  isCurrent,
  refreshSeq,
  mode,
  onStateChange,
  onOpenDetail,
  onBack,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
}: SavedWorkflowProjectGroupProps) {
  const { intl, locale } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  // [契约] 解析服务时同时传 workspacePath、remoteSessionId、identity、remoteTarget。
  // 远程项目必须走 remoteSessionId 对应的连接，只给路径会解析到本机同名 workspace。
  // services 未就绪时 agentService 仍在，但 rpcReady 为假，本轮拉取会被 refresh 拦住。
  const resolution = useWorkspaceServicesResolution(
    project.workspacePath,
    project.remoteSessionId ?? null,
    project.workspaceIdentity,
    project.remoteTarget,
  );
  const { services, rpcReady } = resolution;
  const agentService = services.zcodeAgentService;
  const fileWatcherService = services.fileWatcherService;

  // [契约] identity 存在时 resolveWorkspaceKey 以 identity 为主键，路径只作 fallback。
  // key 只用于 testId 后缀与 onStateChange 的归属，不参与 RPC；删掉它会丢测试定位。
  // 条件展开而不是传 undefined：多带一个空 identity 会改变 key 的合成结果。
  const workspaceKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: project.workspacePath,
        ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
      }),
    [project.workspacePath, project.workspaceIdentity],
  );

  // [契约] 三套坐标只在是否携带 remoteSessionId 上不同，不要混用。
  // target 供 list / runs / delete 等 RPC；projectTarget 供对话与打开实例，不带远端会话。
  // launchTarget 额外带 remoteSessionId，决定 createSession 走哪条连接、导航到哪个端点。
  // 三者都由 path / identity / remoteSessionId 派生，依赖不变时引用稳定，可安全进 effect。
  const { target, projectTarget, launchTarget } = useSavedWorkflowProjectTargets(
    project,
    resolution.remoteSessionId,
  );

  // [契约] 按 target 选择分片；远程重连换了 remoteSessionId 就会切到另一片状态。
  // 选择器内部已做 workspaceKey 归一，这里不要再自己拼 key 去读 byWorkspaceKey。
  // 未加载时返回共享空对象而不是 undefined，渲染层无需额外兜底。
  const state = useSavedWorkflowStore((store) => selectSavedWorkflowState(store, target));
  const load = useSavedWorkflowStore((store) => store.load);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // [契约] rpcReady 为假直接返回：连接未就绪时发 list 只会把组推进错误态。
  // bypassCache 透传给 store.load；非 bypass 会复用 in-flight Promise，可能拿到旧扫描。
  // 成功后 setNow，卡片上「3 分钟前」这类相对时间才会随刷新前进。
  // 这里不要 catch：store 已把失败落到 state.error，再 toast 一次会刷屏。
  const refresh = useCallback(
    async (options: { bypassCache?: boolean } = {}) => {
      if (!rpcReady) return;
      await load(target, agentService, options);
      setNow(Date.now());
    },
    [agentService, load, rpcReady, target],
  );

  useEffect(() => {
    // [契约] 挂载即拉一次；refresh 依赖变化（rpcReady 转真、target 切换）时自动重跑。
    // void 是有意的：store 已把失败落到 state.error，effect 不需要等待或 catch。
    void refresh();
  }, [refresh]);

  // 页级刷新：refreshSeq 变化（非首挂）时绕过缓存重拉。
  // [并发] 用 ref 记住上次看到的 refreshSeq，首挂时两者相等，跳过这次「页级刷新」。
  // 若不比较初值，父页每次挂载都会连带触发一次 bypass 拉取，list 与 runs 双发。
  // 比较放在 effect 里而不是渲染期，避免 StrictMode 双执行时误判。
  // 不要在这里加超时重试：绕过缓存由 refreshSeq 显式驱动，隐藏重试会掩盖连接问题。
  const lastRefreshSeq = useRef(refreshSeq);
  useEffect(() => {
    if (lastRefreshSeq.current === refreshSeq) return;
    lastRefreshSeq.current = refreshSeq;
    void refresh({ bypassCache: true });
  }, [refresh, refreshSeq]);

  // [资源] enabled 绑 rpcReady：连接未就绪不建 watcher，避免对远端路径发起无效 watch。
  // 内部 300ms 防抖后以 bypass 刷新；目录不存在时只记 debug，属常态，不冒泡成组错误。
  // 服务实例或目录变化时 effect 会 unwatch 旧 id 再重建，本组件不用手动释放。
  // 非递归只看这一层：子目录里的工作流不会被自动发现，这是刻意的（Linux 递归 watch 有既知问题）。
  useSavedWorkflowsDirectoryWatch({
    fileWatcherService,
    workspacePath: project.workspacePath,
    enabled: rpcReady,
    refresh,
  });

  // 加载态回报给页；空 = 已加载且没有合法工作流也没有坏文件；count = 合法工作流条数。
  // [契约] 三个条件缺一不可：未加载完不能算空，有坏文件也不算空。
  // 有 invalid 时仍要渲染组，否则用户看不到哪些文件坏了、为什么坏。
  // 空组隐藏但状态照常回报（见下一个 effect），父页的总空态与新建引导依赖它。
  // 不要把 empty 简化成 entries 为空：那会把损坏提示一起吞掉。
  const empty = state.loaded && state.entries.length === 0 && state.invalid.length === 0;
  const count = state.loaded ? state.entries.length : 0;
  useEffect(() => {
    onStateChange(workspaceKey, { loaded: state.loaded, empty, count });
  }, [count, empty, onStateChange, state.loaded, workspaceKey]);

  // [契约] 运行历史按工作流 name 建索引，不是按 path；改名或挪目录后仍能对上。
  // 代价是两个同名工作流共用一条「上次运行」；runs 已在 store 截断到 50 条，不再切片。
  const lastRuns = useMemo(() => lastRunByWorkflowName(state.runs), [state.runs]);

  // GUI 直接启动器：载体 = 本项目解析出的 agent service；accepted 后切到新会话。
  // [资源] 载体固定为本项目解析出的 agentService：启动发生在工作流所属项目，不是活动项目。
  // 内部用 pendingRef 做同帧防重入，并管理连接租约的 acquire/release，本组件不再加锁。
  // onNavigate 只在 accepted 后触发，跳转到新会话由页面层实现。
  const launcher = useSavedWorkflowLauncher({
    agentService,
    onNavigate: onNavigateToLaunchedRun,
  });

  // [事务] 只有 ok 才关实参窗：失败时窗口保持打开，行内展示 reason 供用户改参数重试。
  // 无实参路径本就没开窗，这里的 setLaunchEntry(null) 是无害的幂等关闭。
  // scope 固定 project：同名全局档必须由全局组去启动，绝不能在这里回落。
  // 返回值原样交给调用方，各自决定用 toast 还是行内错误呈现。
  const launch = useCallback(
    async (entry: ZCodeSavedWorkflowEntry, args: Record<string, unknown>) => {
      const result = await launcher.launch(launchTarget, {
        name: entry.name,
        scope: "project",
        args,
      });
      if (result.ok) {
        // 成功：launcher 已切到新会话，关掉实参窗（无窗路径本就没开窗）。
        setLaunchEntry(null);
      }
      return result;
    },
    [launchTarget, launcher],
  );
  // [契约] 两条路径：有实参则开窗收参，无实参则直接启动，不打扰用户。
  // 判据是 args 存在且至少一个键；只传空对象等于无实参，走直启。
  // 开窗前先 clearError，否则上次失败的红色提示会带进这一次。
  // busy 视觉由 launcher.pending 驱动，同帧双击由 hook 内的 pendingRef 兜住。
  const handleRun = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      if (entry.args && Object.keys(entry.args).length > 0) {
        launcher.clearError();
        setLaunchEntry(entry);
        return;
      }
      // 无实参项目档：不弹窗，直接启动；失败以 toast 提示（窗外路径）。
      // [失败路径] 无窗路径失败只能在窗外提示，toast 的文案 key 由 reason 直接拼出。
      // reason 是受控词表（拒绝原因、unsupported、generic），新增 reason 必须同步补 i18n。
      // 这里不 catch：launcher 把异常也转成 ok 为假的结果，不会 reject。
      void launch(entry, {}).then((result) => {
        if (!result.ok) {
          toast(intl.formatMessage({ id: `workflows.hub.launch.error.${result.error.reason}` }));
        }
      });
    },
    [intl, launch, launcher],
  );
  // [契约] 「修订」不改文件：把 name 与 path 拼进修订提示，交给对话里的模型去改。
  // 走 onCreateViaChat 只预填草稿、不自动发送，用户仍有确认机会。
  // 必须用 projectTarget 而不是 target：多带 remoteSessionId 会被当成远端会话坐标。
  const handleRevise = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      onCreateViaChat?.(
        buildSavedWorkflowRevisePrompt({ name: entry.name, path: entry.path, locale }),
        projectTarget,
      );
    },
    [locale, onCreateViaChat, projectTarget],
  );
  // [失败路径] clipboard 可能不存在（非安全上下文）：可选链让写失败静默，只记 warn 不弹错。
  // 复制成功才 toast；这是纯便利动作，失败不应打断中枢操作。
  const handleCopyPath = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => {
      void navigator.clipboard
        ?.writeText(entry.path)
        .then(() => toast(intl.formatMessage({ id: "workflows.hub.copied" })))
        .catch((error: unknown) => {
          logger.warn("[SavedWorkflows] 复制路径失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [intl],
  );
  // [事务] 先 requestConfirmation：确认框自持焦点与 Esc，本组件不另设取消态。
  // [并发] busyName 只做单卡视觉锁；真正的幂等由服务端的目录事实决定。
  // 删除失败按 reason 词表翻译，未知 reason 回落原文，不要吞掉错误。
  // 成功后若正停在被删工作流的详情页，必须 onBack，否则详情会显示一个已消失的名字。
  const handleDelete = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({ id: "workflows.hub.delete.title" }, { name: entry.name }),
        description: intl.formatMessage(
          { id: "workflows.hub.delete.description" },
          { path: entry.path },
        ),
        confirmLabel: intl.formatMessage({ id: "workflows.hub.delete.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      setBusyName(entry.name);
      try {
        // [契约] {...target, name} 保持 name 在后：先铺开坐标再落名字，target 日后扩字段也不会覆盖它。
        // 返回 ok 为假是业务拒绝（文件不存在、只读），不是异常，要走 toast 分支而不是 catch。
        // 这里只接传输层抛错；两种失败在 UI 上都显示同一条 deleteFailed。
        const result = await agentService.deleteSavedWorkflow({ ...target, name: entry.name });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.deleteFailed" },
              { reason: intl.formatMessage({ id: `workflows.hub.reason.${result.reason}` }) },
            ),
          );
          return;
        }
        toast(intl.formatMessage({ id: "workflows.hub.deleted" }, { name: entry.name }));
        if (mode.kind === "detail" && mode.name === entry.name) onBack();
      } catch (error) {
        toast(
          intl.formatMessage(
            { id: "workflows.hub.deleteFailed" },
            { reason: error instanceof Error ? error.message : String(error) },
          ),
        );
      } finally {
        setBusyName(null);
        void refresh({ bypassCache: true });
      }
    },
    [agentService, intl, mode, onBack, refresh, requestConfirmation, target],
  );
  const handleCardDelete = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handleDelete(entry),
    [handleDelete],
  );
  // 「提升为全局」：不搬文件——在本项目开新会话、
  // 自动发送概括提示，模型经 SaveWorkflow 另存全局档，源文件不动。远程项目不提供（远端
  // home 不进中枢，提升出来的东西看不见）。
  // [契约] 提升等于在本项目开新会话发概括提示，模型经 SaveWorkflow 另存全局档，源文件不动。
  // 不要改成复制或移动文件：项目档里的路径、命令、约定换到别的项目会直接跑坏。
  // 只对 local 项目开放；远端 home 不进本机中枢，提升出来的东西本机看不见。
  // busyName 与删除共用：同一时刻只允许一个卡片进行中，避免并发建会话。
  const isLocalProject = !project.remoteSessionId;
  const promoter = useSavedWorkflowPromote({ agentService, onNavigate: onNavigateToLaunchedRun });
  const handlePromote = useCallback(
    async (entry: ZCodeSavedWorkflowEntry) => {
      setBusyName(entry.name);
      try {
        const result = await promoter.promote(launchTarget, {
          name: entry.name,
          path: entry.path,
          locale,
        });
        if (!result.ok) {
          toast(
            intl.formatMessage(
              { id: "workflows.hub.promote.failed" },
              { reason: result.message ?? result.code },
            ),
          );
        }
      } finally {
        setBusyName(null);
      }
    },
    [intl, launchTarget, locale, promoter],
  );
  const handleCardPromote = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => void handlePromote(entry),
    [handlePromote],
  );
  const handleOpen = useCallback(
    (entry: ZCodeSavedWorkflowEntry) => onOpenDetail(entry.name),
    [onOpenDetail],
  );
  // 两个「打开」的门与实参构造与全局档共用（见该 hook 的注释：产物不需要 toolCallId）。
  // [契约] 项目档的 resolveTarget 恒为本项目，不随 run.cwd 反查（那是全局组的做法）。
  // 「查看实例」要求 parentSessionId 与 toolCallId 同时存在，缺一个就静默不打开。
  // 产物 chip 只要求 parentSessionId：老行没有 toolCallId 时产物仍要能打开。
  // 两个回调用条件展开注入，未传时 hook 内部自动关闭对应入口，不产生空回调。
  const resolveRunTarget = useCallback(() => projectTarget, [projectTarget]);
  const { handleOpenArtifact, handleOpenRun } = useSavedWorkflowRunOpeners({
    resolveTarget: resolveRunTarget,
    ...(onOpenWorkflowRun === undefined ? {} : { onOpenWorkflowRun }),
    ...(onOpenWorkflowArtifact === undefined ? {} : { onOpenWorkflowArtifact }),
  });
  const handleCreateViaChat = useCallback(() => {
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale), projectTarget);
  }, [locale, onCreateViaChat, projectTarget]);
  const handleMetaSaved = useCallback(() => {
    void refresh({ bypassCache: true });
  }, [refresh]);

  const launchDialog = (
    <SavedWorkflowLaunchDialog
      entry={launchEntry}
      scope="project"
      projectLabel={project.label}
      pending={launcher.pending}
      error={launcher.error}
      onOpenChange={(open) => (open ? undefined : setLaunchEntry(null))}
      onSubmit={(entry, args) => void launch(entry, args)}
    />
  );

  if (mode.kind === "detail") {
    // [失败路径] 详情可能先于列表到达：entry 查不到时所有动作按钮必须降级为 undefined。
    // 按 name 查找取第一个匹配；同名工作流以 store 的扫盘顺序为准，不要在这里再排序。
    // runs 只过滤本 name，时间与 busy 仍用组级状态，保证详情与卡片显示一致。
    const entry = state.entries.find((candidate) => candidate.name === mode.name);
    return (
      <SavedWorkflowDetailView
        target={target}
        agentService={agentService}
        name={mode.name}
        projectLabel={project.label}
        entry={entry}
        runs={state.runs.filter((run) => run.name === mode.name)}
        now={now}
        busy={busyName === mode.name}
        canOpenRun={Boolean(onOpenWorkflowRun)}
        onBack={onBack}
        onRun={() => (entry ? handleRun(entry) : undefined)}
        onRevise={() => (entry ? handleRevise(entry) : undefined)}
        onCopyPath={() => (entry ? handleCopyPath(entry) : undefined)}
        onMove={isLocalProject ? () => (entry ? void handlePromote(entry) : undefined) : undefined}
        onDelete={() => (entry ? void handleDelete(entry) : undefined)}
        onOpenRun={(run) => handleOpenRun(run, mode.name)}
        {...(onOpenWorkflowArtifact === undefined ? {} : { onOpenArtifact: handleOpenArtifact })}
        onMetaSaved={handleMetaSaved}
        launchDialog={launchDialog}
      />
    );
  }

  // 列表态：已加载且既无合法工作流也无坏文件的组不渲染（空组隐藏），但仍已回报状态给页。
  // [契约] 空组直接返回 null：不渲染标题、不留间距，父页的「全部为空」引导才成立。
  // 隐藏发生在状态回报之后，父页仍知道这个项目加载完了、只是没有内容。
  // 第二个 return 覆盖「未加载且什么都没有」：首次进入不闪一个空壳组。
  // 不要在隐藏前多做一次拉取：目录监听与 refreshSeq 已经覆盖后续变更。
  if (empty) return null;
  if (!state.loaded && state.entries.length === 0 && state.invalid.length === 0) return null;

  const invalidCount = state.invalid.length;

  return (
    <div
      data-testid={testId(TID_WORKFLOW_PROJECT_GROUP, workspaceKey)}
      data-workflow-project-current={isCurrent ? "true" : undefined}
      className="mt-8 first:mt-0"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-ui-base font-medium leading-5 text-foreground">
          <span className="truncate">{project.label}</span>
          {isCurrent ? (
            <span className="rounded-sm border border-border px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
              {intl.formatMessage({ id: "workflows.hub.group.current" })}
            </span>
          ) : null}
          {state.entries.length > 0 ? (
            <span className="font-normal text-foreground-subtlest">{state.entries.length}</span>
          ) : null}
        </h3>
        <Button
          type="button"
          size="lg"
          data-icon="inline-start"
          data-testid={testId(TID_WORKFLOWS_CREATE_VIA_CHAT, workspaceKey)}
          onClick={handleCreateViaChat}
        >
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
        </Button>
      </div>

      {state.entries.length > 0 ? (
        <div
          data-testid={testId(TID_WORKFLOWS_LIST, workspaceKey)}
          className="mt-5 grid grid-cols-1 auto-rows-[132px] gap-x-4 gap-y-4 lg:grid-cols-2"
        >
          {state.entries.map((entry) => (
            <SavedWorkflowCard
              key={entry.path}
              entry={entry}
              lastRun={lastRuns.get(entry.name)}
              now={now}
              busy={busyName === entry.name}
              onOpen={handleOpen}
              onRun={handleRun}
              onRevise={handleRevise}
              onCopyPath={handleCopyPath}
              onMove={isLocalProject ? handleCardPromote : undefined}
              onDelete={handleCardDelete}
            />
          ))}
        </div>
      ) : null}

      {state.error ? (
        <p className="mt-4 text-ui-sm text-destructive">
          {intl.formatMessage({ id: "workflows.hub.loadError" }, { error: state.error })}
        </p>
      ) : null}

      {invalidCount === 0 ? null : (
        <div
          data-workflows-invalid="true"
          className="mt-4 space-y-0.5 rounded-lg border border-warning/40 px-2.5 py-2"
        >
          <p className="text-ui-sm text-warning">
            {intl.formatMessage(
              { id: invalidCount === 1 ? "workflows.hub.invalidOne" : "workflows.hub.invalid" },
              { count: String(invalidCount) },
            )}
          </p>
          {state.invalid.map((entry) => (
            <p
              key={entry.path}
              className="min-w-0 truncate font-mono text-ui-xs text-foreground-subtlest"
              title={entry.reason}
            >
              {entry.path} — {entry.reason}
            </p>
          ))}
        </div>
      )}

      {launchDialog}
    </div>
  );
}
