// INV-01 canSave 必须严格等于 true 才渲染 trailing。守住位置：useWorkflowRunSaveSlots 中的早退判断。改错故障：缺省值被当成可保存，只读宿主也能写文件、起引擎。
// INV-02 leading 芯片不受 canSave 影响，entry 存在就渲染。守住位置：早退之前构造的 leading。改错故障：只读宿主丢失「已保存」事实，用户不知道文件已留下。
// INV-03 trailing 缺席时必须返回 null 而不是空片段。守住位置：早退返回值里的 trailing。改错故障：表头多出一个空槽，布局与对齐漂移。
// INV-04 两个槽必须共用同一个 useWorkflowRunSave 控制器。守住位置：hook 内唯一的 controller 调用。改错故障：卡与侧板各自查询，同一个 run 出现两种说法。
// INV-05 controller 参数用条件展开，undefined 时不得传键。守住位置：useWorkflowRunSave 调用里的四处条件展开。改错故障：显式 undefined 覆盖下游默认值，查询键变化导致重复请求。
// INV-06 entry 决定动词：undefined 是「保存」，有值是「再次运行」。守住位置：verb 的三元表达式。改错故障：已保存的 run 仍显示保存，用户重复保存同一工作流。
// INV-07 launching 期间按钮必须 disabled。守住位置：Button 的 disabled 属性。改错故障：连点触发多次启动，远端起多份引擎。
// INV-08 有实参或 global 档必须开窗，不能直接启动。守住位置：handleRunAgain 的 hasArgs 判断。改错故障：global 缺「运行于」项目，或带参 run 用空参重跑。
// INV-09 无实参且项目档才走窗外直接启动，失败用 toast 报原因。守住位置：handleRunAgain 末尾的 launch 分支。改错故障：静默失败，用户以为已经再次运行。
// INV-10 开窗前必须先 clearLaunchError。守住位置：setLaunchEntry 之前的一行。改错故障：上一次的错误残留，弹层一开就显示旧失败。
// INV-11 启动对话框关闭时必须把 launchEntry 置 null。守住位置：onOpenChange 回调。改错故障：弹层关闭后待启动项残留，下次点击闪回旧窗口。
// INV-12 只有启动成功才允许关闭对话框。守住位置：onSubmit 的 then 分支。改错故障：失败也关窗，错误提示无处显示。
// INV-13 启动失败文案取 result.error.reason 拼 i18n key。守住位置：toast 的模板字符串。改错故障：所有失败共用一句话，用户无法判断是缺参还是主机离线。
// INV-14 项目默认落点由 runProjectKey 决定，找不到才回退 workspacePath。守住位置：projectLabel 的查找与兜底。改错故障：再次运行默认落到别的项目，写错工作区。
// INV-15 全局档的 targets 与 defaultTargetKey 只在 global 时传。守住位置：launchEntry 的条件展开。改错故障：项目档也出现项目选择，用户被迫多选一步。
// INV-16 初始实参取 controller.runArgs，只作预填。守住位置：initialArgs 展开。改错故障：用宿主上的旧值预填，弹层显示与本次 run 不符的参数。
// INV-17 保存成功后写 announcement 到 live region，并把焦点还给槽位。守住位置：onSaved 回调。改错故障：芯片静默出现，屏幕阅读器用户与键盘用户都丢失上下文。
// INV-18 无服务上下文时边界组件传 null，且不能在 hook 内条件调用。守住位置：WorkflowRunSaveSlotsBoundary 的 services 判空。改错故障：静态渲染或回放宿主直接抛错，或违反 hook 调用规则。
//
// 模块职责：把一次 run 的保存态、项目候选、再次运行入口与两个弹层，收敛成表头的 leading 与 trailing 两个槽位。
// 状态所有权：entry、保存与启动态属于 useWorkflowRunSave；弹层开关、待启动项与播报文本属于本 hook 的局部状态。
// 阅读顺序：先看 Host 与 Slots 契约，再看 useWorkflowRunSaveSlots 的组装与早退，最后看边界组件与芯片渲染。
import { useSavedWorkflowProjectOptions } from "@/project-sidebar/useSavedWorkflowProjectOptions.js";
// 完成卡与 run 侧板表头上的那一对控件（docs/dynamic-workflow/transcript-and-notifications.md
// 「Saving the run, and running it again」）：
//
//   leading  ── 「已保存」芯片：一条关于**文件**的事实，不是运行状态，所以中性底色而非绿色；
//   trailing ── 「保存」/「再次运行」：一次 run 跑完的那一刻，用户正好知道它值不值得留下。
//
// 两个槽共用一个控制器（`useWorkflowRunSave`），因此同一个 run 在卡上与侧板上说的是同一句话。
// 返回 ReactNode 而不是渲染成组件：表头的两个插槽在结构上是分开的，但它们背后必须是同一次查询。
import { useMemo, useRef, useState, type ReactNode } from "react";
import { CheckIcon, ArrowUpRightIcon, PlayIcon, SaveIcon } from "lucide-react";
import {
  resolveWorkspaceKey,
  type ZCodeSavedWorkflowEntry,
  type ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkflowRunSave } from "@/project-workflow/useWorkflowRunSave.js";
import { useSavedWorkflowHub } from "@/v4/savedWorkflowHubContext.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { SavedWorkflowLaunchDialog } from "@/settings/saved-workflows/SavedWorkflowLaunchDialog.js";
import { WorkflowSavePopover } from "@/components/workflow-timeline/WorkflowSavePopover.js";
import {
  buildWorkflowSaveRequestPrompt,
  type WorkflowSaveDraft,
} from "@/components/workflow-timeline/workflowRunSave.js";

// 对外契约只有这一份 host：卡与侧板都按同一组字段挂载，差异只走 verbWord。
// runId 是控制器查询与再次运行的主键，缺失或串号会让两个 run 共享同一份保存态。
// workspacePath 与 workspaceIdentity 分开：前者用于文件与展示，后者用于身份隔离。
// sendLead 缺席时弹层只剩直接保存，这是手机远控壳等无消息通路的预期形态。
// runName 只用于预填与指认，不参与查询键；拿它当键会让改名后的 run 查不到旧保存。
export interface WorkflowRunSaveSlotsHost {
  sessionId?: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  runId: string;
  /** run 名：弹层用它预填说明，交给 ZCode 的那条消息用它指认「刚跑完的哪一个」。 */
  runName?: string;
  /** 转写里 SaveWorkflow 认领过这次 run 的候选（`buildWorkflowSaveCandidatesByRunId`）。 */
  candidates?: readonly ZCodeWorkflowsForRunCandidate[];
  /**
   * 两道门（只读、灰度）都开着：缺省 false。关着时整个 trailing 缺席——写文件与起引擎都
   * 属于「Resume 被收走的地方一并收走」。芯片是事实，不受这道门影响。
   */
  // 两道门（只读、灰度）任一关闭都必须传 false 或省略，不能拿 undefined 当开启。
  // 该位只关 trailing，不关 leading：芯片陈述的是文件事实，与能否写入无关。
  // 门在调用方求值，本组件不做二次权限判断，避免出现两套真相。
  // 把它改成默认 true 会让未接入控制器的宿主拿到按钮，点击后写文件失败。
  canSave?: boolean;
  /** 把那条用户消息发出去；缺席即弹层只剩「直接保存」那一半。 */
  sendLead?: (text: string) => Promise<void>;
  /**
   * 动词的词何时退成只剩图标：`card`（缺省）= 完成卡窄于 480px 时（卡上的容器查询）；
   * `never` = 永远带词（run 侧板的状态头：那里的按钮本来就都带词，且没有 wf-card 容器）。
   */
  verbWord?: "card" | "never";
}

// 返回 ReactNode 而不是组件，是因为表头两个插槽结构分离但必须共享同一次查询。
// leading 与 trailing 可以各自为 null，调用方需要同时处理两者缺失的情况。
// 任何一侧都不要在本 hook 外缓存：entry 变化时两块必须同一帧一起更新。
// 两侧共用 controller，拆开渲染会破坏同源保证，卡上与侧板的说法可能分叉。
// 新增槽位必须同时改 WorkflowRunSaveSlots 与所有调用点，否则静默漏渲染。
export interface WorkflowRunSaveSlots {
  leading: ReactNode;
  trailing: ReactNode;
}

/** 卡窄到这个宽度以下时动词只剩图标（词退到 aria-label 与提示里）。 */
const SAVE_WORD_CONTAINER = "@[480px]/wf-card:inline";

// 这是唯一组装点：查询、项目候选、动词选择与弹层状态都在这里汇合。
// hook 内不承担权限判断，canSave 只被消费；权限事实由调用方持有。
// locale 与 intl 只用于文案，不参与查询键，切换语言不应触发重新查询。
// 所有 setState 都落在本 hook 生命周期内，卸载后由 React 负责丢弃。
// 不要在这里读取 agent 或平台服务：边界组件已保证服务上下文存在。
export function useWorkflowRunSaveSlots(host: WorkflowRunSaveSlotsHost): WorkflowRunSaveSlots {
  const { intl, locale } = useZCodeIntl();
  const format = (id: string) => intl.formatMessage({ id });
  const hub = useSavedWorkflowHub();
  const anchorRef = useRef<HTMLElement | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [launchEntry, setLaunchEntry] = useState<ZCodeSavedWorkflowEntry | null>(null);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  // 控制器是 entry、保存态与启动态的唯一所有者，本组件只读它、不改它。
  // 可选字段用条件展开传入，undefined 时宁可不传，避免覆盖下游默认值。
  // onNavigateToRun 仅在 hub 可达时注入，缺失时中枢跳转入口自然消失。
  // 依赖保持扁平，任一字段变化都会重建查询；不要把整个 host 对象传进去。
  const controller = useWorkflowRunSave({
    sessionId: host.sessionId,
    workspacePath: host.workspacePath,
    ...(host.workspaceIdentity === undefined ? {} : { workspaceIdentity: host.workspaceIdentity }),
    ...(host.remoteSessionId === undefined ? {} : { remoteSessionId: host.remoteSessionId }),
    runId: host.runId,
    ...(host.candidates === undefined ? {} : { candidates: host.candidates }),
    ...(hub === null ? {} : { onNavigateToRun: hub.navigateToRun }),
  });
  const entry = controller.entry;

  // 全局档的「运行于」候选：与中枢全局组同一张表（本机项目，不含远程）。默认落在这次 run
  // 自己的项目上——从一张卡上按「再次运行」，最自然的落点就是它跑过的那个项目。
  const projects = useSavedWorkflowProjectOptions();
  const localProjects = useMemo(
    () => projects.filter((project) => !project.workspaceIdentity),
    [projects],
  );
  const runProjectKey = useMemo(
    () =>
      resolveWorkspaceKey({
        workspacePath: host.workspacePath,
        ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
      }),
    [host.workspacePath, host.workspaceIdentity],
  );

  const sendLead = host.sendLead;
  const leadHandler =
    sendLead === undefined
      ? undefined
      : async (draft: WorkflowSaveDraft) => {
          await sendLead(
            buildWorkflowSaveRequestPrompt({
              locale,
              runId: host.runId,
              ...(host.runName === undefined ? {} : { runName: host.runName }),
              name: draft.name,
              scope: draft.scope,
              description: draft.description,
            }),
          );
        };

  // 首个早返回同时挡住两种情形：还没保存成功，以及上一次启动仍在进行。
  // 有实参就必须开窗，因为参数需要用户确认，不能拿 journal 的旧值静默重跑。
  // global 档即使无实参也开窗：运行于哪个项目是用户选择，不是卡片能推断的。
  // 窗外直跑失败只报 toast，不写 launchError，因为此时没有弹层可承载错误。
  // 把开窗与直跑合流成一条路径会丢掉参数确认，或让 global 拿不到目标项目。
  const handleRunAgain = () => {
    if (entry === undefined || controller.launching) return;
    const hasArgs = entry.args !== undefined && Object.keys(entry.args).length > 0;
    // 全局档永远开窗：它需要一个「运行于」的项目，而那是用户的选择而不是卡片的推断。
    if (hasArgs || entry.scope === "global") {
      controller.clearLaunchError();
      setLaunchEntry(entry);
      return;
    }
    // 窗外路径：失败以 toast 说出来，措辞取启动器自己的原因表（与中枢的「运行」同一套）。
    void controller.launch(entry, {}).then((result) => {
      if (!result.ok) {
        toast(intl.formatMessage({ id: `workflows.hub.launch.error.${result.error.reason}` }));
      }
    });
  };

  const leading =
    entry === undefined ? null : (
      <WorkflowRunSavedChip
        entry={entry}
        label={format("chat.toolCall.workflow.saveRun.chip")}
        {...(hub === null
          ? {}
          : {
              hint: format("chat.toolCall.workflow.saveRun.chip.hint"),
              onOpen: () =>
                hub.openWorkflow({
                  name: entry.name,
                  scope: entry.scope,
                  workspacePath: host.workspacePath,
                  ...(host.workspaceIdentity ? { workspaceIdentity: host.workspaceIdentity } : {}),
                }),
            })}
      />
    );

  // 早退放在 leading 构造之后，保证关掉写入能力时「已保存」事实仍然可见。
  // trailing 必须是 null 而不是省略字段，调用方按 null 判定整个槽位不渲染。
  // 此处之后所有代码都默认可以保存，新增逻辑不要把它挪到前面。
  // 把早退上移会连带吞掉芯片，只读宿主从此看不到已保存状态。
  if (host.canSave !== true) return { leading, trailing: null };

  const verb =
    entry === undefined
      ? {
          label: format("chat.toolCall.workflow.saveRun.action"),
          icon: <SaveIcon className="size-3.5" />,
          testId: "workflow-save-open",
          onClick: (element: HTMLElement) => {
            anchorRef.current = element;
            setPopoverOpen((open) => !open);
          },
        }
      : {
          label: controller.launching
            ? format("chat.toolCall.workflow.saveRun.starting")
            : format("chat.toolCall.workflow.saveRun.runAgain"),
          icon: controller.launching ? (
            <Spinner className="size-3.5" />
          ) : (
            <PlayIcon className="size-3.5" />
          ),
          testId: "workflow-save-run-again",
          onClick: handleRunAgain,
        };

  // aria-expanded 与 aria-haspopup 只在保存态给，运行态不是弹层触发器。
  // 窄卡只隐藏文字，aria-label 仍保留完整词，保证可访问名称不随布局变化。
  // 容器查询阈值 @[480px]/wf-card 与卡宽绑定；verbWord 为 never 时不得再套隐藏类。
  // 弹层与启动对话框都锚在同一个 ref，保存成功后焦点要回到这个槽位。
  // 三个浮层共享 popoverOpen 与 launchEntry 两个开关，不能各自持有第二份开关。
  const trailing = (
    <>
      <ControlHintTooltip title={verb.label} side="top">
        <Button
          aria-expanded={entry === undefined ? popoverOpen : undefined}
          aria-haspopup={entry === undefined ? "dialog" : undefined}
          aria-label={verb.label}
          data-icon="inline-start"
          data-testid={verb.testId}
          disabled={controller.launching}
          onClick={(event) => verb.onClick(event.currentTarget)}
          size="sm"
          type="button"
          variant="outline"
        >
          {verb.icon}
          {/* 窄卡只剩图标：词退到 aria-label 与提示里，不让按钮把表头顶出卡外。 */}
          <span
            className={host.verbWord === "never" ? undefined : cn("hidden", SAVE_WORD_CONTAINER)}
          >
            {verb.label}
          </span>
        </Button>
      </ControlHintTooltip>
      <WorkflowSavePopover
        anchorRef={anchorRef}
        host={{
          ...(host.runName === undefined ? {} : { runName: host.runName }),
          directSaveUnsupported: controller.directSaveUnsupported,
          scopeLocked: controller.scopeLocked,
          saving: controller.saving,
          save: controller.save,
          checkNameTaken: controller.checkNameTaken,
          ...(leadHandler === undefined ? {} : { sendLead: leadHandler }),
          onSaved: (saved) => {
            setAnnouncement(
              format(
                saved.scope === "global"
                  ? "chat.toolCall.workflow.saveRun.announce.global"
                  : "chat.toolCall.workflow.saveRun.announce.project",
              ),
            );
            // 焦点回到那个槽位——它此刻已经是「再次运行」了。
            anchorRef.current?.focus();
          },
        }}
        onOpenChange={setPopoverOpen}
        open={popoverOpen}
      />
      <SavedWorkflowLaunchDialog
        entry={launchEntry}
        scope={launchEntry?.scope ?? "project"}
        projectLabel={
          localProjects.find(
            (project) =>
              resolveWorkspaceKey({
                workspacePath: project.workspacePath,
                ...(project.workspaceIdentity
                  ? { workspaceIdentity: project.workspaceIdentity }
                  : {}),
              }) === runProjectKey,
          )?.label ?? host.workspacePath
        }
        // 这次 run 跑过的实参就是下一次最可能要跑的那一份（journal 给的）。
        {...(controller.runArgs === undefined ? {} : { initialArgs: controller.runArgs })}
        {...(launchEntry?.scope === "global"
          ? { targets: localProjects, defaultTargetKey: runProjectKey }
          : {})}
        pending={controller.launching}
        error={controller.launchError}
        onOpenChange={(open) => (open ? undefined : setLaunchEntry(null))}
        onSubmit={(submitted, args, target) => {
          void controller
            .launch(
              submitted,
              args,
              target === undefined
                ? undefined
                : {
                    projectId: target.projectId,
                    hostId: target.hostId,
                    workspacePath: target.workspacePath,
                    ...(target.workspaceIdentity
                      ? { workspaceIdentity: target.workspaceIdentity }
                      : {}),
                    ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
                  },
            )
            .then((result) => {
              if (result.ok) setLaunchEntry(null);
            });
        }}
      />
      {/* 保存成功只播一次：芯片本身是静默出现的，屏幕阅读器需要被告知这件事发生了。 */}
      <span className="sr-only" aria-live="polite" data-testid="workflow-save-announcement">
        {announcement}
      </span>
    </>
  );

  return { leading, trailing };
}

/**
 * 只在有服务上下文时挂载控制器（spec「Gates」：没有会话上下文的卡——静态渲染、回放、分享只读
 * 时间线——就是它原来那张卡，一个控件都没有）。控制器要查 agent，而这些宿主根本没有 agent 可查；
 * 用一层边界而不是在 hook 里判空，是因为 hook 不能按条件调用。
 */
// 这一层只为满足 hook 规则：服务缺失时直接给出 null，而不是在 hook 内判空。
// 静态渲染、回放与分享只读时间线都走 null 分支，呈现为没有控件的那张卡。
// services 为 null 是正常形态而不是错误，不要在这里抛异常或打日志。
// 把判断挪进 useWorkflowRunSaveSlots 会改变 hook 调用顺序，直接触发崩溃。
export function WorkflowRunSaveSlotsBoundary({
  children,
  host,
}: {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
  host: WorkflowRunSaveSlotsHost;
}) {
  const services = useOptionalServices();
  if (services === null) return <>{children(null)}</>;
  return <WorkflowRunSaveSlotsMount host={host}>{children}</WorkflowRunSaveSlotsMount>;
}

function WorkflowRunSaveSlotsMount({
  children,
  host,
}: {
  children: (slots: WorkflowRunSaveSlots | null) => ReactNode;
  host: WorkflowRunSaveSlotsHost;
}) {
  const slots = useWorkflowRunSaveSlots(host);
  return <>{children(slots)}</>;
}

/** 「已保存」芯片：待答问题芯片的形状，`bg-surface` 中性底——它说的是文件，不是运行状态。 */
function WorkflowRunSavedChip({
  entry,
  hint,
  label,
  onOpen,
}: {
  entry: ZCodeSavedWorkflowEntry;
  hint?: string;
  label: string;
  /** 缺席即中枢不可达（手机远控壳）：芯片画成纯文字。 */
  onOpen?: () => void;
}) {
  const content = (
    <>
      <CheckIcon aria-hidden className="size-3" />
      {label}
      {onOpen === undefined ? null : (
        // 只在悬停 / 键盘聚焦时出现，平时不占位：芯片是一个词，不该在词后面留一段空白。
        <ArrowUpRightIcon
          aria-hidden
          className="hidden size-3 group-hover/saved-chip:block group-focus-visible/saved-chip:block"
        />
      )}
    </>
  );
  const className =
    "group/saved-chip flex shrink-0 items-center gap-1 rounded-full bg-surface py-0.5 pl-1.5 pr-2 text-ui-xs font-medium text-foreground-subtle";
  if (onOpen === undefined) {
    return (
      <span className={className} data-testid="workflow-saved-chip">
        {content}
      </span>
    );
  }
  return (
    <ControlHintTooltip title={hint ?? label} side="top">
      <button
        className={cn(className, "hover:bg-hover hover:text-foreground")}
        data-testid="workflow-saved-chip"
        onClick={onOpen}
        title={entry.name}
        type="button"
      >
        {content}
      </button>
    </ControlHintTooltip>
  );
}
