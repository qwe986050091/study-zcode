// INV-01 受控输入必须由父级回写：守住位置是 value 与 onChange 的配对，改错故障是输入框看似可编辑但值永远停在旧的一帧。
// INV-02 校验结论必须只由父级给出：守住位置是 nameInvalid、taken、submitDisabled 三个入参，改错故障是按钮已禁用但提示仍说名字可用。
// INV-03 提交中整块只读：守住位置是名称、作用域、描述三处的 disabled 都带着 saving，改错故障是请求飞行中还能改字段，落盘内容与界面不一致。
// INV-04 重复提交必须被拦在按钮上：守住位置是 submitDisabled 而不是内部标志，改错故障是双击发出两次写入，后一次覆盖前一次。
// INV-05 失败提示优先级最高：守住位置是提示区先判 failure 再判 taken，改错故障是拒绝原因被覆盖警告顶掉，用户以为重试就能成功。
// INV-06 遮蔽说明必须同时附着在覆盖与后果两句上：守住位置是 shadowingText 被引用两次，改错故障是用户只知道会被覆盖，不知道另一作用域将看不见它。
// INV-07 失败时弹层不得关闭：守住位置是失败只在弹层内呈现这个前提，改错故障是失败信息无处显示，用户只看到弹层消失。
// INV-08 名称后缀只是事实不是输入：守住位置是那个绝对定位且不接收指针的 span，改错故障是用户以为能改扩展名，实际保存时被无声忽略。
// INV-09 长度上限必须与父级同源：守住位置是 maxLength 取自共享常量，改错故障是前端能输入超长名字，提交时才被拒绝。
// INV-10 保存路径必须等宽排印：守住位置是 consequence 里用 code 包裹路径，改错故障是路径中的下划线与连字符混淆，用户照抄到错误目录。
// INV-11 句子占位符必须不可能出现在词条里：守住位置是 PATH_SLOT 取 NUL 字符，改错故障是普通占位串命中文案正文，句子被切在错误的位置。
// INV-12 拆分结果必须容忍缺段：守住位置是 after 的默认空串，改错故障是词条漏写占位符时整句后半段消失。
// INV-13 禁用必须给出原因：守住位置是 scopeLocked 时补的那一行说明，改错故障是下拉灰掉却没有解释，用户以为界面坏了。
// INV-14 本文件不得持有状态：守住位置是所有值都直接读 draft，改错故障是父级重置草稿后界面仍停在旧值。
// INV-15 焦点必须直达原生输入：守住位置是 nameRef 直接交给 Input，改错故障是父级聚焦落在包装节点上，光标不在输入框里。
// INV-16 可访问名必须来自可见标签：守住位置是 label 的 htmlFor 与输入框 id 成对，改错故障是读屏只念控件类型，用户不知道该填什么。
// INV-17 纯装饰元素必须对读屏隐藏：守住位置是分隔线与作用域图标的 aria-hidden，改错故障是读屏多念一串无意义内容。
// INV-18 提交标签换形不得换掉可访问名：守住位置是 Spinner 与文字同处按钮内，改错故障是加载瞬间按钮暂时没有名字。
//
// 模块职责：渲染保存弹层的下半部分，负责名称、作用域、描述三块输入以及它下面那句后果，本身不发起任何写入。
// 状态所有权：草稿、校验结论、提交中标志全部由 WorkflowSavePopover 持有，本文件只做受控渲染与事件转发。
// 阅读顺序：先看字段的受控与禁用条件，再看 WorkflowSaveConsequence 的三选一优先级，最后看 PATH_SLOT 那句拼接技巧。
// 「保存工作流」弹层里细线之下的那一半（docs/dynamic-workflow/transcript-and-notifications.md
// 「The popover」）：三个字段、一句后果、一枚「直接保存」。
//
// 与弹层壳分文件只为守住 400 行的门；这里不持有任何状态，全部由 WorkflowSavePopover 传进来。
import type { RefObject } from "react";
import { FolderIcon, GlobeIcon } from "lucide-react";
import type { ZCodeSavedWorkflowScope } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SAVED_WORKFLOW_NAME_MAX_CHARS, type WorkflowSaveDraft } from "./workflowRunSave.js";

/** agent 拒绝了这一次保存：`reason` 是词表里的原因，`detail` 是它带回来的诊断（已有界）。 */
// agent 的拒绝是本文件唯一的外部失败信号，形状被刻意压到最小：一个原因词加一段可选诊断。
// [失败路径] reason 会被原样拼进词条 id，所以它必须是词表里枚举过的值；上游传了词表外的字符串，界面暴露的就是未翻译的 key 而不是人话。
// detail 已经在 agent 侧截断过，这里只做展示不做清洗，也不再二次转义——它最终落在 pre 里，被当成纯文本。
// [权衡] 诊断用 pre 保留换行，是为了让栈或 diff 这类多行内容还能读；代价是很长的单行会横向滚动，所以限了高度。
// 失败对象整体可以不传，空位表示这一次还没有被拒绝过；用一个可选值而不是空字符串，是为了让「没失败」与「失败但没有诊断」能被区分。
// 这里不记录时间、不记录请求标识：失败展示只需要让人看懂发生了什么，多一个字段就多一处要同步的地方。
export interface WorkflowSaveFailure {
  reason: string;
  detail?: string;
}

export function WorkflowSaveFields({
  draft,
  failure,
  nameInvalid,
  nameRef,
  onDirectSave,
  pathPreview,
  saving,
  scopeLocked,
  shadowing,
  showDivider,
  submitDisabled,
  submitLabel,
  taken,
  update,
}: {
  draft: WorkflowSaveDraft;
  failure: WorkflowSaveFailure | undefined;
  nameInvalid: boolean;
  nameRef: RefObject<HTMLInputElement | null>;
  // 直接保存是唯一的写入口，组件自己不做节流也不做去重，连点保护全部压在 submitDisabled 上。
  // [并发] 父级在提交开始时把 saving 置真并让 submitDisabled 变真，两者之间只要漏掉一步，按钮就会在请求飞行中保持可点。
  // 回调身份是否稳定不影响这里的渲染，但如果父级每次渲染都换一个新函数，外层的记忆化就等于白做——所以约定是父级自己用稳定引用。
  // 组件不缓存上一次点击，也不在内部加加载标志：多一份本地状态就多一个和父级失步的机会。
  // 按钮的类型显式写成普通按钮，是因为这块内容将来可能被放进表单；默认的提交语义会在回车时意外触发整个表单。
  // [失败路径] 点击后失败不会回滚任何字段，草稿原样保留，用户改一个字符再点即可，无需重填。
  onDirectSave: () => void;
  pathPreview: string;
  saving: boolean;
  scopeLocked: boolean;
  /** 另一个作用域也占着这个名字：遮蔽会发生，在点下去之前说出来。 */
  shadowing: boolean;
  showDivider: boolean;
  submitDisabled: boolean;
  submitLabel: string;
  taken: boolean;
  update: (next: Partial<WorkflowSaveDraft>) => void;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);
  return (
    <>
      {showDivider ? (
        <div className="flex items-center gap-2 text-ui-xs text-foreground-subtlest">
          <span aria-hidden className="h-px flex-1 bg-border" />
          <span>{format("chat.toolCall.workflow.saveRun.or")}</span>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="workflow-save-name">
          {format("chat.toolCall.workflow.saveRun.name")}
        </label>
        <div className="relative">
          <Input
            aria-invalid={nameInvalid}
            className="pr-16 font-mono"
            data-testid="workflow-save-name"
            disabled={saving}
            id="workflow-save-name"
            maxLength={SAVED_WORKFLOW_NAME_MAX_CHARS}
            onChange={(event) => update({ name: event.target.value })}
            placeholder={format("chat.toolCall.workflow.saveRun.name.placeholder")}
            ref={nameRef}
            value={draft.name}
          />
          {/* 后缀是**事实**不是输入：名字是文件名，扩展名由保存路径决定，用户不该也不能改它。 */}
          <span className="pointer-events-none absolute inset-y-0 right-2 flex items-center font-mono text-ui-xs text-foreground-subtlest">
            .dwf.ts
          </span>
        </div>
        <p
          className={cn(
            "text-ui-xs",
            nameInvalid ? "text-destructive" : "text-foreground-subtlest",
          )}
          data-testid="workflow-save-name-helper"
        >
          {format(
            nameInvalid
              ? "chat.toolCall.workflow.saveRun.name.invalid"
              : "chat.toolCall.workflow.saveRun.name.helper",
          )}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-ui-sm text-foreground-subtle">
          {format("chat.toolCall.workflow.save.scope.label")}
        </span>
        <Select
          disabled={scopeLocked || saving}
          onValueChange={(value) => update({ scope: value as ZCodeSavedWorkflowScope })}
          value={draft.scope}
        >
          <SelectTrigger className="w-full" data-testid="workflow-save-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* 图标说的是「落在哪」：文件夹是这个项目，地球是这台机器上的每个项目。 */}
            <SelectItem value="project">
              <FolderIcon aria-hidden className="size-3.5 text-foreground-subtle" />
              {format("chat.toolCall.workflow.save.scope.project")}
            </SelectItem>
            <SelectItem value="global">
              <GlobeIcon aria-hidden className="size-3.5 text-foreground-subtle" />
              {format("chat.toolCall.workflow.save.scope.global")}
            </SelectItem>
          </SelectContent>
        </Select>
        {scopeLocked ? (
          <p className="text-ui-xs text-foreground-subtlest">
            {format("chat.toolCall.workflow.saveRun.scope.remoteOnly")}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-ui-sm text-foreground-subtle" htmlFor="workflow-save-description">
          {format("chat.toolCall.workflow.saveRun.description")}
        </label>
        <SettingsFormTextarea
          className="min-h-14"
          data-testid="workflow-save-description"
          disabled={saving}
          id="workflow-save-description"
          onChange={(event) => update({ description: event.target.value })}
          value={draft.description}
        />
        <p className="text-ui-xs text-foreground-subtlest">
          {format("chat.toolCall.workflow.saveRun.description.helper")}
        </p>
      </div>
      <WorkflowSaveConsequence
        failure={failure}
        pathPreview={pathPreview}
        scope={draft.scope}
        shadowing={shadowing}
        taken={taken}
      />
      <div className="flex justify-end">
        <Button
          data-testid="workflow-save-submit"
          disabled={submitDisabled}
          onClick={onDirectSave}
          type="button"
          variant="outline"
        >
          {saving ? <Spinner className="size-3.5" /> : null}
          {submitLabel}
        </Button>
      </div>
    </>
  );
}

/**
 * 同一个位置的三选一：agent 的拒绝 → 覆盖警告 → 一句后果。拒绝在场时弹层不关，因为一个字节
 * 都没写；覆盖警告与后果句都会在另一个作用域也占着这个名字时补上遮蔽那一句（与 SaveWorkflow
 * 卡同一句话）——遮蔽与覆盖是两件事，只说其中一件会让用户以为另一件不会发生。
 */
function WorkflowSaveConsequence({
  failure,
  pathPreview,
  scope,
  shadowing,
  taken,
}: {
  failure: WorkflowSaveFailure | undefined;
  pathPreview: string;
  scope: ZCodeSavedWorkflowScope;
  shadowing: boolean;
  taken: boolean;
}) {
  const { intl } = useZCodeIntl();
  const format = (id: string, values?: Record<string, string>) =>
    intl.formatMessage({ id }, values);
  // 遮蔽那一句借 SaveWorkflow 卡的原词（它本身不带句号），句号随语言由词条补上。
  const shadowingText = shadowing
    ? format("chat.toolCall.workflow.saveRun.shadowing", {
        text: format(
          scope === "global"
            ? "chat.toolCall.workflow.save.scope.hiddenByProject"
            : "chat.toolCall.workflow.save.scope.hidesGlobal",
        ),
      })
    : null;
  if (failure !== undefined) {
    return (
      <div className="text-ui-xs text-warning" data-testid="workflow-save-failure" role="status">
        <span>{format(`chat.toolCall.workflow.saveRun.error.${failure.reason}`)}</span>
        {failure.detail === undefined ? null : (
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
            {failure.detail}
          </pre>
        )}
      </div>
    );
  }
  if (taken) {
    return (
      <div
        className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-2 text-ui-sm leading-snug text-foreground-subtle"
        data-testid="workflow-save-overwrite"
      >
        {format("chat.toolCall.workflow.saveRun.overwrite")}
        {shadowingText === null ? null : ` ${shadowingText}`}
      </div>
    );
  }
  // 路径是技术值，要等宽排印（DESIGN.md 把 font-mono 留给技术值）；词条引擎只收字符串，所以
  // 用一个不会出现在文案里的占位符把句子切成前后两段，再把路径以 <code> 嵌回去。
  const [before, after = ""] = format("chat.toolCall.workflow.saveRun.consequence", {
    path: PATH_SLOT,
  }).split(PATH_SLOT);
  return (
    <p
      className="text-ui-sm leading-snug text-foreground-subtle"
      data-testid="workflow-save-consequence"
    >
      {before}
      <code className="font-mono text-ui-xs">{pathPreview}</code>
      {after}
      {shadowingText === null ? null : ` ${shadowingText}`}
    </p>
  );
}

/** 路径在句子里的占位：NUL 不会出现在任何词条里。 */
const PATH_SLOT = "\u0000";
