// 【模块】已保存工作流中枢容器：只做编排，持有刷新序号、各分组加载态与列表/详情视图。
// 【边界】列表加载、搜索过滤、删除确认与错误重试全部下沉到全局组和项目组，容器不直接读文件。
// 【契约】子组通过状态回调上报 loaded、empty、count 三项投影，容器据此算出页头总数与空态。
// 【权衡】任一时刻只有一份 readiness 真值，任何组都不得自行推断兄弟组状态，宁可多一次上报。
// INV-01 【不变量】列表态顺序恒为全局组在前、项目组其后，详情态只渲染命中组且不带页头；守住位置：渲染主分支；改错故障：串组后用户把全局工作流当项目档运行，落点错误。
// INV-02 【不变量】readiness 只由所属组回调写入，键取工作流身份键，容器不代子组推断；守住位置：状态回调入口；改错故障：汇总数虚高或空态误判，用户看不到真实条数。
// INV-03 【不变量】首屏 spinner 仅在没有任何组回报 loaded 时出现，且不阻断子组挂载；守住位置：anyLoaded 计算；改错故障：提前收掉加载态会闪出空列表，用户以为工作流被删光。
// INV-04 【不变量】空态卡要求项目候选非空、全部加载完成且全部为空，与全局组空满无关；守住位置：allProjectsEmpty 判定；改错故障：已有全局档时误报空态，引导用户重复创建。
// INV-05 【不变量】页头总数等于各已加载组条数之和，未加载组按 0 计而不是整表跳过；守住位置：totalCount 归约；改错故障：刷新途中数字跳变，用户无法确认收藏是否丢失。
// INV-06 【不变量】刷新序号单调递增，每次变更让所有组重拉，不做局部定向失效；守住位置：handleMoved 与刷新按钮；改错故障：搬移文件后源组残留旧卡片，点开即报找不到。
// INV-07 【不变量】同一深链对象只消费一次，引用相同即视为重复投递并直接返回；守住位置：consumedRef 守卫；改错故障：重复消费把用户从刚打开的详情弹回列表。
// INV-08 【失败路径】深链指向的项目不在候选内时只消费不跳转，绝不留下悬挂详情；守住位置：深链 effect 的项目命中判断；改错故障：留下空白详情页，返回键语义失效。
// INV-09 【失败路径】详情所属项目被关闭时必须复位为列表，且复位只能发生在 effect 内；守住位置：项目存在性校验 effect；改错故障：渲染期改状态触发告警并可能陷入循环。
// INV-10 【不变量】活动 workspace 缺失时不伪造当前标记，空态创建目标退化为第一个候选项目；守住位置：activeKey 与 emptyCardTarget；改错故障：把工作流建到用户没打开的项目里。
// INV-11 【不变量】全局组的运行与移动落点只允许本机项目，远程 workspace 一律过滤；守住位置：localProjects 派生；改错故障：远程档被搬到本地目录，内容与仓库错配。
// INV-12 【不变量】工作流设置入口与它指向的设置行同进同退，读不到 offeredMode 时不渲染；守住位置：showWorkflowSettings 计算；改错故障：点进去是空设置页，用户找不到模式行。
// INV-13 【不变量】目录监听是列表唯一外部变更源，搜索过滤只在子组内做纯投影，不改 readiness；守住位置：子组数据契约；改错故障：过滤态下总数与可见卡片不一致，用户以为数据丢失。
// INV-14 【失败路径】删除确认在子组内完成，容器只在成功后推进刷新序号，不做乐观移除；守住位置：删除回调链；改错故障：取消确认后卡片已消失，用户以为误删。
// INV-15 【失败路径】加载失败不得计为已加载，重试必须复用同一刷新序号通道；守住位置：readiness 写入与重试；改错故障：失败被当成空，空态卡诱导用户重建已有工作流。
// INV-16 【生命周期】组常驻挂载以持续回报状态，隐藏只作用于外层容器的可见性；守住位置：列表容器样式切换；改错故障：卸载即断监听，回到页面看到过期列表。
// INV-17 【设计权衡】详情页独占整页，页头与工具行仅在列表态出现，返回统一回列表而非上一页；守住位置：详情早返回分支；改错故障：详情里冒出刷新与设置按钮，两态状态互相污染。
// INV-18 【设计权衡】创建与修订只预填草稿不代发消息，目标项目必须显式传入；守住位置：空态创建回调与创建透传；改错故障：静默发出草稿，用户在未知项目里多出一条会话。
import { useSavedWorkflowProjectOptions } from "@/project-sidebar/useSavedWorkflowProjectOptions.js";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Settings2 } from "lucide-react";
import {
  TID_WORKFLOWS_CREATE_VIA_CHAT,
  TID_WORKFLOWS_EMPTY,
  TID_WORKFLOWS_OPEN_SETTINGS,
  TID_WORKFLOWS_REFRESH,
  readDynamicWorkflowOfferedMode,
  resolveWorkspaceKey,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useDynamicWorkflowAvailability } from "@/hooks/useDynamicWorkflowAvailability.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { type AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import { AutomationRefreshIcon } from "@/settings/AutomationDesignPrimitives.js";
import { SETTINGS_FRAME_CONTENT_CLASSNAME } from "@/settings/SettingsPageParts.js";
import { buildSavedWorkflowCreatePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import { SavedWorkflowProjectGroup } from "@/settings/saved-workflows/SavedWorkflowProjectGroup.js";
import { SavedWorkflowGlobalGroup } from "@/settings/saved-workflows/SavedWorkflowGlobalGroup.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";
import type {
  SavedWorkflowGroupState,
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
} from "@/settings/saved-workflows/savedWorkflowContract.js";

export type {
  SavedWorkflowProjectTarget,
  SavedWorkflowsOpenArtifactParams,
  SavedWorkflowsOpenRunParams,
  SavedWorkflowLaunchTarget,
};

/** 深链目标：默认 project（缺 scope 兼容旧调用），或 global（无 workspaceKey）。 */
export type SavedWorkflowsOpenTarget =
  | { scope?: "project"; workspaceKey: string; name: string }
  | { scope: "global"; name: string };

interface SavedWorkflowsSectionProps {
  /** 页头（标题切换 + 副标题）；只在列表态渲染，详情页与定时任务编辑页一样独占整页。 */
  header?: ReactNode;
  /** 活动 workspace：只用来打「当前」标记和作全局空态的创建目标。 */
  workspacePath?: string | null;
  workspaceIdentity?: string;
  /** 「运行」= GUI 直接启动：accepted 后切到新会话。 */
  onNavigateToLaunchedRun?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
  /** 「通过对话创建」/「在对话里修订」：只预填草稿，不发送；target = 所属项目（空态卡取活动项目）。 */
  onCreateViaChat?: (prompt: string, target: SavedWorkflowProjectTarget) => void;
  /** 运行历史「查看实例」：切到发起它的会话并打开实例详情页。 */
  onOpenWorkflowRun?: (params: SavedWorkflowsOpenRunParams) => void;
  /** 产物 chip → `workflow-artifact` tab。 */
  onOpenWorkflowArtifact?: (params: SavedWorkflowsOpenArtifactParams) => void;
  /** 深链直接落到详情页；定位后由调用方清空。project 需 workspaceKey，global 只需 name。 */
  openWorkflow?: SavedWorkflowsOpenTarget | null;
  onOpenWorkflowConsumed?: () => void;
}

type SavedWorkflowsView =
  | { mode: "list" }
  | { mode: "detail"; scope: "project"; workspaceKey: string; name: string }
  | { mode: "detail"; scope: "global"; name: string };

/** 全局组的 readiness 用固定键 `"global"`，与项目组的 workspaceKey 同存一张表。 */
// 【不变量】全局组用固定键存放状态，与项目身份键共用一张表，汇总时只需取一次。
// 【失败路径】项目身份键理论上可能解析出同一字面量，靠统一解析函数保证命名空间互斥。
// 【设计权衡】常量键省掉一份独立状态，代价是两套键空间必须长期保持不重叠。
const GLOBAL_READINESS_KEY = "global";

function resolveOptionKey(option: AutomationWorkspaceOption): string {
  return resolveWorkspaceKey({
    workspacePath: option.workspacePath,
    ...(option.workspaceIdentity ? { workspaceIdentity: option.workspaceIdentity } : {}),
  });
}

/**
 * 已保存工作流中枢：顶部固定「全局」组，
 * 其下按已打开项目分组。页只持有刷新计数器、每组的加载态、详情态；「项目」= `buildAutomationWorkspaceOptions`。
 */
export function SavedWorkflowsSection({
  header,
  workspacePath,
  workspaceIdentity,
  onNavigateToLaunchedRun,
  onCreateViaChat,
  onOpenWorkflowRun,
  onOpenWorkflowArtifact,
  openWorkflow,
  onOpenWorkflowConsumed,
}: SavedWorkflowsSectionProps) {
  const { intl, locale } = useZCodeIntl();
  const openSettingsTab = useTabStore((store) => store.openSettingsTab);
  // launch.md「The hub page」「The user's choice」：标题行的「工作流设置」直达设置 › 常规的模式行，
  // 旁边写当前生效模式。中枢只在生效模式不是关闭时出现，所以这里不处理关闭态。
  // 链接与它要打开的设置行同进同退：行在快照就绪后总是出现，唯一例外是旧 Host 的快照没有
  // offeredMode（readDynamicWorkflowOfferedMode 读不到），行不出，链接也不出——否则点过去是一个找不到的设置。
  // 【不变量】设置入口可见性与 offeredMode 的读取结果同源，未知快照一律不显示链接。
  // 【失败路径】旧 Host 快照缺 offeredMode 时按不可用处理，不回退到默认模式蒙混过关。
  // 【设计权衡】宁可少一个入口，也不让用户点进 dynamicWorkflowConfig 里不存在的设置行。
  // 【生命周期】模式值随可用性快照更新，组件不额外缓存，避免陈旧值压过真实值。
  const dynamicWorkflowConfig = useDynamicWorkflowAvailability().config;
  const dynamicWorkflowMode = dynamicWorkflowConfig?.mode;
  const showWorkflowSettings =
    dynamicWorkflowConfig !== null &&
    readDynamicWorkflowOfferedMode(dynamicWorkflowConfig) !== undefined;
  // 【并发】先写入待跳转意图再打开设置页，两帧之间的渲染不会读到空意图。
  // 【失败路径】设置页已打开时只切分区，不重复开标签，避免多份实例抢同一份状态。
  // 【生命周期】回调只依赖打开设置页的动作，跨渲染保持引用稳定。
  const handleOpenWorkflowSettings = useCallback(() => {
    setPendingSettingsSectionIntent("general");
    openSettingsTab();
  }, [openSettingsTab]);
  // 【不变量】项目候选是页面唯一分组来源，分组数量、顺序与身份键都直接取自这里。
  // 【失败路径】候选为空时只渲染全局组与无工作区提示，绝不构造占位项目。
  // 【并发】候选更新与状态上报异步到达，键相同即合并、键不同即视为新组。
  const projects = useSavedWorkflowProjectOptions();
  // 全局组的运行 / 移动落点只能是本机项目：过滤掉远程 workspace。
  const localProjects = useMemo(
    () => projects.filter((project) => !project.workspaceIdentity),
    [projects],
  );

  const [view, setView] = useState<SavedWorkflowsView>({ mode: "list" });
  const [refreshSeq, setRefreshSeq] = useState(0);
  // 【不变量】readiness 只存子组上报的三项投影，不存工作流正文，容器不持有业务实体。
  // 【失败路径】上报键冲突时后写覆盖先写，因此键必须含 workspaceIdentity 而非仅路径。
  // 【生命周期】表项不随组卸载清理，重挂后由子组重新上报覆盖，避免列表闪一下再回填。
  // 【设计权衡】用一张表换掉逐组 state，牺牲局部性换取页头汇总的单一真值。
  const [readiness, setReadiness] = useState<Record<string, SavedWorkflowGroupState>>({});

  // 活动 workspace（由调用方以 prop 传入）：打「当前」标记、全局组默认落点与全局空态的创建目标。
  const activeKey = useMemo(
    () =>
      workspacePath
        ? resolveWorkspaceKey({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
          })
        : null,
    [workspaceIdentity, workspacePath],
  );

  // 【不变量】三项字段全等时返回原对象，React 跳过重渲染，抑制重复上报风暴。
  // 【失败路径】只比较 loaded 会漏掉同组条数变化，页头数字停在旧值。
  // 【并发】读取与写入都收在同一个 updater 内，慢速并发上报不会互相覆盖字段。
  // 【生命周期】回调依赖为空数组，跨刷新周期保持同一引用，子组 memo 才真正生效。
  const handleStateChange = useCallback((key: string, next: SavedWorkflowGroupState) => {
    setReadiness((current) => {
      const prev = current[key];
      if (
        prev &&
        prev.loaded === next.loaded &&
        prev.empty === next.empty &&
        prev.count === next.count
      ) {
        return current;
      }
      return { ...current, [key]: next };
    });
  }, []);

  // 全局组「移到项目…」搬走一份文件后两组都要重拉。项目组没有会改动两组内容的动作（「提升为全局」
  // 只是开会话，全局档由模型另存，靠全局组的目录监听自然出现），所以只有全局组回调它。
  // 【并发】搬移跨两组写盘，用单调刷新序号代替定向失效，避免任一组读到中间态。
  // 【设计权衡】只让全局组触发 handleMoved，项目组没有同时改动两组的动作，少一条回调就少一处竞态。
  const handleMoved = useCallback(() => setRefreshSeq((seq) => seq + 1), []);

  // 深链：把 openWorkflow 落到对应详情页，然后消费。project 不在候选里就只消费不跳转。
  // 【不变量】同一深链对象只消费一次，引用相同即视为重复投递并直接返回。
  // 【失败路径】未命中候选项目时仍调用消费回调，防止调用方反复重投同一深链。
  // 【并发】守卫在 effect 内推进，严格模式双执行时第二次被引用比较拦下。
  // 【生命周期】深链被清空时同步清空守卫，下一次深链才能重新进入。
  // 【设计权衡】用 ref 而非 state 记录已消费项，省一次渲染也不参与依赖追踪。
  const consumedRef = useRef<SavedWorkflowsOpenTarget | null>(null);
  useEffect(() => {
    if (!openWorkflow) {
      consumedRef.current = null;
      return;
    }
    if (consumedRef.current === openWorkflow) return;
    consumedRef.current = openWorkflow;
    if (openWorkflow.scope === "global") {
      setView({ mode: "detail", scope: "global", name: openWorkflow.name });
    } else if (
      projects.some((project) => resolveOptionKey(project) === openWorkflow.workspaceKey)
    ) {
      setView({
        mode: "detail",
        scope: "project",
        workspaceKey: openWorkflow.workspaceKey,
        name: openWorkflow.name,
      });
    }
    onOpenWorkflowConsumed?.();
  }, [onOpenWorkflowConsumed, openWorkflow, projects]);

  // 项目详情打开后项目被关闭：回退到列表（用 effect，不在渲染里 setState）。
  useEffect(() => {
    if (
      view.mode === "detail" &&
      view.scope === "project" &&
      !projects.some((project) => resolveOptionKey(project) === view.workspaceKey)
    ) {
      setView({ mode: "list" });
    }
  // 【失败路径】项目在详情打开后被关闭时回落到列表，避免详情读不到项目而整块空白。
  // 【不变量】复位只在 effect 中发生，渲染期不写状态，杜绝渲染循环。
  // 【生命周期】依赖含项目候选与视图，候选刷新会重新校验一次详情归属。
  }, [projects, view]);

  // 全局空态卡的创建目标：活动项目，活动项目不在候选里则第一个候选（项目档创建）。
  // 【不变量】创建目标优先活动项目，缺失时退化为第一个候选，不返回半成品对象。
  // 【失败路径】无候选项目时返回空值，空态按钮点击即无效，不会写到未知名下。
  // 【设计权衡】emptyCardTarget 只挑项目不挑全局档，空态卡语义就是在一个项目里创建。
  const emptyCardTarget = useMemo<SavedWorkflowProjectTarget | null>(() => {
    const active = projects.find((project) => resolveOptionKey(project) === activeKey);
    const target = active ?? projects[0];
    if (!target) return null;
    return {
      projectId: target.projectId,
      hostId: target.hostId,
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
  }, [activeKey, projects]);

  const handleCreateFromEmpty = useCallback(() => {
    if (!emptyCardTarget) return;
    onCreateViaChat?.(buildSavedWorkflowCreatePrompt(locale), emptyCardTarget);
  }, [emptyCardTarget, locale, onCreateViaChat]);

  const globalGroupCommonProps = {
    refreshSeq,
    onStateChange: handleStateChange,
    onNavigateToLaunchedRun,
    onCreateViaChat,
    onOpenWorkflowRun,
    onOpenWorkflowArtifact,
    localProjects,
    activeProjectKey: activeKey,
    onMoved: handleMoved,
  };

  // 详情态：只渲染选中的那一组（它内部渲染整页详情），不带页头 / 工具行。
  // 【不变量】全局详情不接收项目候选，刷新序号沿用容器值，返回即回列表。
  // 【失败路径】详情内切换到另一个全局档时靠名称重建，不残留上一个详情的滚动与选中态。
  // 【设计权衡】详情走早返回而非隐藏列表，保证同一时刻只有一套焦点与滚动容器。
  if (view.mode === "detail" && view.scope === "global") {
    return (
      <SavedWorkflowGlobalGroup
        {...globalGroupCommonProps}
        mode={{ kind: "detail", name: view.name }}
        onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }
  // 【失败路径】详情项目不在候选内时这里不渲染，交给上面的 effect 复位，短暂留白而非报错。
  // 【不变量】详情组以工作流身份键作 key，跨项目切换必然重建组件树。
  // 【生命周期】当前标记跟随活动 workspace，详情期间切项目只改标记不换数据源。
  if (view.mode === "detail") {
    const project = projects.find((candidate) => resolveOptionKey(candidate) === view.workspaceKey);
    if (project) {
      return (
        <SavedWorkflowProjectGroup
          key={view.workspaceKey}
          project={project}
          isCurrent={activeKey === view.workspaceKey}
          refreshSeq={refreshSeq}
          mode={{ kind: "detail", name: view.name }}
          onStateChange={handleStateChange}
          onOpenDetail={(name) =>
            setView({ mode: "detail", scope: "project", workspaceKey: view.workspaceKey, name })
          }
          onBack={() => setView({ mode: "list" })}
          onNavigateToLaunchedRun={onNavigateToLaunchedRun}
          onCreateViaChat={onCreateViaChat}
          onOpenWorkflowRun={onOpenWorkflowRun}
          onOpenWorkflowArtifact={onOpenWorkflowArtifact}
        />
      );
    }
    // 项目在详情打开后被关闭：上面的 effect 会把 view 复位为列表，这里先落回列表渲染。
  }

  const globalReady = readiness[GLOBAL_READINESS_KEY];
  // 【不变量】任一已加载组即撤掉首屏 spinner，未返回的组继续在后台加载。
  // 【失败路径】所有组都返回空也算已加载，用户看到空态而不是无限转圈。
  // 【生命周期】spinner 只覆盖不卸载列表容器，目录监听在首屏期间持续有效。
  const anyLoaded =
    Boolean(globalReady?.loaded) ||
    projects.some((project) => readiness[resolveOptionKey(project)]?.loaded);
  // 全局空态卡只看项目组：所有项目组都加载且空时出现，忽略全局组的空/满。
  const allProjectsLoaded =
    projects.length > 0 &&
    projects.every((project) => readiness[resolveOptionKey(project)]?.loaded);
  // 【不变量】空态要求项目候选非空、全部加载完成、全部为空三个条件同时成立。
  // 【失败路径】加载途中任一条件不成立即不显示空态，避免半成品判定。
  // 【设计权衡】allProjectsEmpty 有意忽略全局组空满，全局档存在时项目仍为空也照样给创建引导。
  const allProjectsEmpty =
    allProjectsLoaded && projects.every((project) => readiness[resolveOptionKey(project)]?.empty);
  // 标题旁的总数 = 各已加载组（含全局组）的合法工作流条数之和。
  // 【不变量】总数以全局组计数为初值，逐项目累加已加载项，未加载项贡献 0。
  // 【失败路径】某组重载期间计数回落，完成后回升，数字允许短暂下降但不长期错位。
  // 【并发】汇总在渲染期从状态快照算出，不写回状态，多组回报不会触发连锁渲染。
  const totalCount = projects.reduce(
    (sum, project) => {
      const entry = readiness[resolveOptionKey(project)];
      return sum + (entry?.loaded ? entry.count : 0);
    },
    globalReady?.loaded ? globalReady.count : 0,
  );

  return (
    <div data-automations-content className={cn(SETTINGS_FRAME_CONTENT_CLASSNAME, "flex flex-col")}>
      {header}

      <div className="mt-8 flex items-center justify-between">
        <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.sectionTitle" })}
          {totalCount > 0 ? (
            <span className="ml-1 font-normal text-foreground-subtlest">{totalCount}</span>
          ) : null}
        </h2>
        <div className="flex items-center gap-3">
          {showWorkflowSettings ? (
            <Button
              type="button"
              variant="ghost"
              size="lg"
              data-testid={TID_WORKFLOWS_OPEN_SETTINGS}
              className="text-foreground-subtle hover:text-foreground"
              onClick={handleOpenWorkflowSettings}
            >
              <Settings2 className="size-4" aria-hidden="true" />
              <span>{intl.formatMessage({ id: "workflows.hub.openSettings" })}</span>
              {dynamicWorkflowMode ? (
                <span className="ml-0.5 text-ui-sm text-foreground-subtlest">
                  {intl.formatMessage({
                    id: `settings.dynamicWorkflow.option.${dynamicWorkflowMode}`,
                  })}
                </span>
              ) : null}
            </Button>
          ) : null}
          <ControlHintTooltip title={intl.formatMessage({ id: "workflows.hub.refresh" })}>
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={intl.formatMessage({ id: "workflows.hub.refresh" })}
              data-testid={TID_WORKFLOWS_REFRESH}
              onClick={() => setRefreshSeq((seq) => seq + 1)}
            >
              <AutomationRefreshIcon className="size-3.5" aria-hidden="true" />
            </Button>
          </ControlHintTooltip>
        </div>
      </div>

      {!anyLoaded ? (
        <div className="mt-8 flex h-40 items-center justify-center">
          <Spinner className="size-5" />
        </div>
      ) : null}

      {/* 组始终挂载才能各自加载并回报状态（未就绪 / 空项目组内部渲染 null；全局组空也显示）；
         首屏 spinner 只是覆盖在上，不阻断加载。全局组恒置顶，项目组在其下。 */}
      <div className={cn("flex flex-col", anyLoaded ? "mt-5" : "hidden")}>
        <SavedWorkflowGlobalGroup
          {...globalGroupCommonProps}
          mode={{ kind: "list" }}
          onOpenDetail={(name) => setView({ mode: "detail", scope: "global", name })}
          onBack={() => setView({ mode: "list" })}
        />

        {projects.length === 0 ? (
          <p className="mt-8 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "workflows.hub.noWorkspace" })}
          </p>
        ) : allProjectsEmpty ? (
          <div
            data-testid={TID_WORKFLOWS_EMPTY}
            className="mt-8 flex h-[226px] w-full items-center justify-center rounded-2xl border border-card-border bg-background px-4"
          >
            <div className="flex translate-y-2 flex-col items-center gap-5">
              <div className="flex flex-col items-center gap-1.5 text-center">
                <p className="text-ui-base font-medium leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.title" })}
                </p>
                <p className="max-w-[420px] text-ui-base leading-5 text-foreground-subtlest">
                  {intl.formatMessage({ id: "workflows.hub.empty.hint" })}
                </p>
              </div>
              <Button
                type="button"
                size="lg"
                data-icon="inline-start"
                data-testid={TID_WORKFLOWS_CREATE_VIA_CHAT}
                onClick={handleCreateFromEmpty}
              >
                <Plus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "workflows.hub.createViaChat" })}
              </Button>
            </div>
          </div>
        ) : null}

        {projects.map((project) => {
          const workspaceKey = resolveOptionKey(project);
          return (
            <SavedWorkflowProjectGroup
              key={workspaceKey}
              project={project}
              isCurrent={activeKey === workspaceKey}
              refreshSeq={refreshSeq}
              mode={{ kind: "list" }}
              onStateChange={handleStateChange}
              onOpenDetail={(name) =>
                setView({ mode: "detail", scope: "project", workspaceKey, name })
              }
              onBack={() => setView({ mode: "list" })}
              onNavigateToLaunchedRun={onNavigateToLaunchedRun}
              onCreateViaChat={onCreateViaChat}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onOpenWorkflowArtifact={onOpenWorkflowArtifact}
            />
          );
        })}
      </div>
    </div>
  );
}
