// INV-01 同一触发点再点一次是关闭：守住位置 切换函数；改错故障：总是打开会让按钮无法收起弹层。
// INV-02 换触发点则移动锚点并保持打开：守住位置 锚点比较；改错故障：不比较锚点会让第二个入口永远打不开。
// INV-03 弹层只挂载表单，关闭即卸载：守住位置 内容渲染；改错故障：常驻表单会让模型清单订阅一直在跑。
// INV-04 模型清单订阅只活在打开期间：守住位置 表单挂载点；改错故障：关闭后仍订阅会持续消耗请求。
// INV-05 初始草稿在打开那一刻定下：守住位置 初始状态；改错故障：随运行状态重算会把正在改的表单拽回。
// INV-06 运行状态变化不拽回正在编辑的表单：守住位置 初始值来源；改错故障：用效果同步会让输入被覆盖。
// INV-07 任何改动清掉上一次的拒绝提示：守住位置 草稿更新；改错故障：旧错误一直挂着会让用户以为新值仍失败。
// INV-08 没有实际改动时 Apply 不可用：守住位置 按钮禁用条件；改错故障：可点会让空修订打到服务端。
// INV-09 Apply 前清空拒绝提示并进入等待：守住位置 提交开头；改错故障：残留提示会与新结果混淆。
// INV-10 命令被拒时记录原因并停在弹层：守住位置 拒绝分支；改错故障：直接关闭会让用户看不到拒绝原因。
// INV-11 命令抛错按通用失败展示：守住位置 失败回调；改错故障：不展示会让点击看起来毫无反应。
// INV-12 成功且结果类型匹配才回调新 run 身份：守住位置 成功分支；改错故障：类型不符仍回调会让调用方拿到空身份。
// INV-13 成功后关闭弹层：守住位置 成功末尾；改错故障：不关闭会让用户重复提交同一次修订。
// INV-14 弹层内部点击不向 run 卡冒泡：守住位置 点击拦截；改错故障：冒泡会让卡身折叠，弹层瞬间消失。
// INV-15 回车与空格在弹层内不触发外层折叠：守住位置 按键拦截；改错故障：数字框回车会被卡当成切换。
// INV-16 点触发点本身不算点击外部：守住位置 外部交互判断；改错故障：会先关再被同一次点击重新打开。
// INV-17 思考档仅在具体模型上可改：守住位置 档位回调；改错故障：会话模型上改档位不会生效。
// INV-18 后果句为空时仍占一行高：守住位置 后果段落；改错故障：第一次改动时页脚会往下跳。
//
// 模块职责：提供运行设置的配置弹层与其开关状态，一次 Apply 即一次运行中修订。
// 状态所有权：开关、锚点、草稿、等待与拒绝提示都在组件内；命令由宿主注入。
// 阅读顺序：先看开关与锚点的复用规则，再看弹层的交互拦截，最后看表单的草稿、Apply 与拒绝展示。
// ============================================================
// 「配置」弹层
// ============================================================
// run 卡的 Configure 钮、详情页的 Configure 钮与详情页摘要行的模型段打开同一个弹层：两个字段、
// 一句后果、Apply。Apply 就是一次 GUI 修订——`amendWorkflowRunSettings` 命令，不经模型轮、不开
// 确认窗；那一下点击就是
// 同意，与中枢的「运行」同一条规则。
//
// 一个弹层、多个触发点：锚点是**打开它的那个元素**（虚拟锚），所以详情页上两个入口各自对齐。
// 表单只在打开时挂载——模型清单的订阅也随之只活在打开期间。

import { useCallback, useRef, useState, type RefObject } from "react";
import type { CommandAck, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  WorkflowRunSettingsBoundField,
  WorkflowRunSettingsModelField,
} from "./WorkflowRunSettingsFields.js";
import {
  useWorkflowSettingsModelChoices,
  type WorkflowSettingsModelScope,
} from "./useWorkflowSettingsModelChoices.js";
import {
  describeWorkflowRunSettingsRejection,
  initialWorkflowRunSettingsDraft,
  workflowRunDefaultConcurrency,
  workflowRunSettingsChange,
  workflowRunSettingsConsequenceId,
  workflowRunSettingsRejectionDetail,
  workflowRunSettingsRejectionMessageId,
  type WorkflowRunSettingsChange,
  type WorkflowRunSettingsDraft,
  type WorkflowRunSettingsRejection,
} from "./workflowRunSettings.js";

/** 宿主给弹层的一切：模型清单的作用域、会话模型、以及发命令的那一下。 */
export interface WorkflowRunSettingsHost extends WorkflowSettingsModelScope {
  /** 发 `amendWorkflowRunSettings`（宿主补 workId 与会话），回 ACK。 */
  apply: (change: WorkflowRunSettingsChange) => Promise<CommandAck>;
}

/** 被接受后新 run 的两把钥匙（ACK.result）。 */
export interface WorkflowRunSettingsAccepted {
  runId: string;
  toolCallId: string;
}

/** 触发点的开关与锚点：点同一个触发点再点一次是关，点另一个是移过去重开。 */
// 开关与 anchorRef 成对出现：锚点就是打开它的那个元素，两者不能只改其中一个
// 同一 element 再点一次关闭，换元素则先关旧锚点再以新锚点重开
// [失败路径] 不比较 anchorRef 会让第二个触发点永远打不开：open 已为真，toggle 走不到开分支
// 锚点存在 useRef 而不是 state：它只服务于比较，进 state 会让每次开关多一帧重渲染
// 返回 open 与 toggleFrom：调用方只说「点我」，锚点由这里自己记
// 锚点与开关同源，避免出现开关为真但锚点为空的中间态
export function useWorkflowRunSettingsPopoverState() {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const toggleFrom = useCallback(
    (element: HTMLElement) => {
      if (open && anchorRef.current === element) {
        setOpen(false);
        return;
      }
      anchorRef.current = element;
      setOpen(true);
    },
    [open],
  );
  return { anchorRef, open, setOpen, toggleFrom };
}

// 弹层用虚拟锚对齐触发点，内容渲染在门户里
// 内部点击一律阻止冒泡，避免 run 卡误判为点卡身
// 回车与空格同样阻止冒泡，数字框输入不被外层截走
// 点击触发点本身不算外部点击，否则会关了又开
// [失败路径] 不拦外部点击会让弹层在一次点击里关闭又重开
// 表单只在打开时存在，关闭即卸载并释放订阅
export function WorkflowRunSettingsPopover({
  anchorRef,
  host,
  onAccepted,
  onOpenChange,
  open,
  run,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  run: WorkflowRunState;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        align="end"
        className="gap-2.5"
        data-testid="workflow-run-settings-popover"
        // 弹层 portal 在外，但 React 事件仍沿组件树冒泡：不拦的话，点弹层空白处会让 run 卡以为
        // 点了卡身而收起（卡身整张是折叠开关），数字框里的回车也会被卡当成 Enter 切换。
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        // 点打开它的那个触发点本身不算「点在外面」：否则先被关掉、再被那一下点击重新打开。
        onInteractOutside={(event) => {
          const target = event.target;
          if (target instanceof Node && anchorRef.current?.contains(target)) event.preventDefault();
        }}
      >
        <WorkflowRunSettingsForm
          host={host}
          onClose={() => onOpenChange(false)}
          run={run}
          {...(onAccepted === undefined ? {} : { onAccepted })}
        />
      </PopoverContent>
    </Popover>
  );
}

// 格式化函数随语言上下文记忆化，避免每帧重建
// 模型清单、会话模型项与思考档规则来自共享 hook
// [边界] 表单只认打开时的 run 快照，运行状态后续变化不回流到这里
// draft、pending 与拒绝提示各自独立：提交中不锁草稿，用户仍可继续改
// 改动只 setDraft 并清掉上次的拒绝原因，不会顺带发命令
// 拒绝详情按 reason 裁剪，只有通用失败才把原始文本给用户，避免泄漏内部错误结构
function WorkflowRunSettingsForm({
  host,
  onAccepted,
  onClose,
  run,
}: {
  host: WorkflowRunSettingsHost;
  onAccepted?: (accepted: WorkflowRunSettingsAccepted) => void;
  onClose: () => void;
  run: WorkflowRunState;
}) {
  const { intl } = useZCodeIntl();
  const format = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );
  // 清单、会话模型那一项、触发器文案、换模型的思考档规则：与确认窗共用一份
  // （useWorkflowSettingsModelChoices.ts）。
  const choices = useWorkflowSettingsModelChoices(host);

  // 起点在打开那一刻定下：run 状态在弹层开着时变了，也不该把用户正在改的表单拽回去。
  // initial 用 useState 惰性初始化：initialWorkflowRunSettingsDraft 只跑一次
  // 弹层打开期间 run 变化不会重建 initial，否则用户改到一半会被冲掉
  // [失败路径] 改成 useEffect 同步 run 后，每次轮询都会把 draft 拽回起点
  // 提交时用 draft 与 initial 的差算出 patch，等于没改就不发命令
  // initial 同时充当重置目标与 diff 基准，两者必须是同一份快照
  // 初始值只在首次渲染读取 run，之后不再跟随
  const [initial] = useState(() => initialWorkflowRunSettingsDraft(run));
  const [draft, setDraft] = useState<WorkflowRunSettingsDraft>(initial);
  const [pending, setPending] = useState(false);
  const [rejection, setRejection] = useState<WorkflowRunSettingsRejection | undefined>(undefined);
  const defaultConcurrency = workflowRunDefaultConcurrency(run);
  const change = workflowRunSettingsChange(initial, draft, defaultConcurrency);
  const updateDraft = (next: WorkflowRunSettingsDraft) => {
    setDraft(next);
    setRejection(undefined);
  };

  const draftModel = draft.model;
  const face = choices.describe(draftModel);
  const handleModelChange = (value: string) => {
    updateDraft({ ...draft, model: choices.pick(value, draftModel) });
  };

  // 没有实际改动时直接返回：按钮本该已禁用，这里是防止回车或程序化点击绕过
  // 提交前先清掉 rejection 并置 pending，避免旧拒绝提示留在等待态旁边
  // 命令被拒时把 rejection 的原因码连同状态存下，弹层不关，等用户改完再试
  // 命令抛错按通用失败展示：错误文本只进 detail，用户可见主提示仍用通用文案
  // 成功且结果类型匹配才回调新 run 身份，随后关闭
  // 等待状态只用于禁用按钮与切换文案，不参与修订计算
  const handleApply = () => {
    if (change === undefined) return;
    setPending(true);
    setRejection(undefined);
    host.apply(change).then(
      (ack) => {
        const next = describeWorkflowRunSettingsRejection(ack);
        if (next !== undefined) {
          logger.warn("[workflow-run] 调整设置被拒绝", {
            reasonCode: ack.reasonCode,
            runId: run.runId,
            status: ack.status,
          });
          setRejection(next);
          setPending(false);
          return;
        }
        const result = ack.result;
        if (result?.type === "amendWorkflowRunSettings") {
          onAccepted?.({ runId: result.runId, toolCallId: result.toolCallId });
        }
        onClose();
      },
      (error: unknown) => {
        logger.warn("[workflow-run] 调整设置命令失败", { runId: run.runId, error: String(error) });
        setRejection({
          reason: "generic",
          code: error instanceof Error ? error.message : String(error),
        });
        setPending(false);
      },
    );
  };

  const rejectionDetail =
    rejection === undefined ? undefined : workflowRunSettingsRejectionDetail(rejection);
  // consequenceId 随 run.status 与 change 变化，没有改动时算出空文案
  // 空后果也要占住一行高度，否则第一次改动时页脚会整体跳一下
  // 该 id 只用来取文案，不参与 canSubmit 判断，改文案不会改变可提交性
  const consequenceId = workflowRunSettingsConsequenceId(run.status, change);
  return (
    <>
      <PopoverTitle>{format("chat.toolCall.workflow.run.settings.title")}</PopoverTitle>
      <WorkflowRunSettingsModelField
        disabled={pending || choices.loading}
        groups={choices.groups}
        leadingItem={choices.sessionModelItem}
        noCatalog={choices.noCatalog}
        onLevelChange={(level) => {
          if (draftModel.kind !== "model" || level === draftModel.level) return;
          updateDraft({ ...draft, model: { ...draftModel, level } });
        }}
        onValueChange={handleModelChange}
        thoughtOption={face.thoughtOption}
        triggerLabel={face.triggerLabel}
        value={face.value}
        {...(draftModel.kind === "session"
          ? { badge: { text: choices.sessionBadge, tone: "subtle" as const } }
          : face.unavailable
            ? {
                badge: {
                  text: format("chat.toolCall.workflow.run.settings.model.unavailable"),
                  tone: "warning" as const,
                },
              }
            : {})}
      />
      <WorkflowRunSettingsBoundField
        bound={draft.bound}
        defaultConcurrency={defaultConcurrency}
        disabled={pending}
        onChange={(bound) => updateDraft({ ...draft, bound })}
      />
      {/* 没改动时后果句为空，但留一行高（min-h-lh），第一次改动时页脚不往下跳。 */}
      <p
        className="min-h-lh text-ui-sm text-foreground-subtle"
        data-testid="workflow-run-settings-consequence"
      >
        {consequenceId === undefined ? null : format(consequenceId)}
      </p>
      {rejection === undefined ? null : (
        <div
          className="text-ui-xs text-warning"
          data-testid="workflow-run-settings-rejection"
          role="status"
        >
          <span>
            {format(workflowRunSettingsRejectionMessageId(rejection), {
              code: rejection.code,
              message: rejection.message ?? rejection.code,
            })}
          </span>
          {rejectionDetail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejectionDetail}
            </pre>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button
          data-testid="workflow-run-settings-apply"
          disabled={change === undefined || pending || face.unavailable}
          onClick={handleApply}
          size="default"
          type="button"
          variant="default"
        >
          {pending ? <Spinner className="size-3.5" /> : null}
          {format(
            pending
              ? "chat.toolCall.workflow.run.settings.applying"
              : "chat.toolCall.workflow.run.settings.apply",
          )}
        </Button>
      </div>
    </>
  );
}
