// INV-01 表单只渲染不持有状态：守住位置 props.draft；改错故障 放弃后仍残留编辑。
// INV-02 脏标记由上层计算：守住位置 dirty 属性；改错故障 按钮显隐与真实差异脱节。
// INV-03 保存中两个按钮同时禁用：守住位置 disabled={saving}；改错故障 重复提交覆盖。
// INV-04 说明为必填项：守住位置 descriptionError；改错故障 空说明被静默保存。
// INV-05 错误文案用内联段落呈现：守住位置 descriptionError 分支；改错故障 仅边框变色无提示。
// INV-06 何时使用的帮助文案常驻：守住位置 whenToUse.help；改错故障 填写规则不可见。
// INV-07 参数表整块交给子组件：守住位置 SavedWorkflowArgsTable；改错故障 行校验逻辑分裂两份。
// INV-08 行错误按 key 索引：守住位置 rowErrors 属性；改错故障 重排后错误错位到别的行。
// INV-09 新增与删除行都上抛：守住位置 onRowAdd 与 onRowRemove；改错故障 子组件私自改数组。
// INV-10 放弃不做二次确认：守住位置 onDiscard 直连；改错故障 多一层弹窗打断流程。
// INV-11 说明输入实时上抛：守住位置 onChange；改错故障 失焦才同步导致脏标记延迟。
// INV-12 标签与输入框用 id 关联：守住位置 htmlFor 与 id 成对；改错故障 点击标签不聚焦。
// INV-13 测试标识只挂在输入与按钮：守住位置 data-testid 常量；改错故障 E2E 选择器漂移。
// INV-14 错误态同时挂 aria-invalid：守住位置 aria-invalid；改错故障 读屏用户无感知。
// INV-15 按钮仅在脏时出现：守住位置 条件渲染；改错故障 无改动也显示保存按钮。
// INV-16 国际化键集中声明：守住位置 TID 与 formatMessage；改错故障 文案硬编码散落。
// INV-17 保存按钮带加载指示：守住位置 Spinner 条件渲染；改错故障 长请求看似无响应。
// INV-18 布局只用 flex 与间距类：守住位置 section 容器；改错故障 表单在窄屏溢出。
//
// 模块职责：渲染工作流详情页的基本信息区，把编辑意图原样上抛给详情视图。
// 状态所有权：草稿、脏标记与保存态全部由 SavedWorkflowDetailView 持有。
// 阅读顺序：先看 props 契约，再看三块字段渲染，最后看脏态操作区。
import {
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_DETAIL_WHEN_TO_USE,
  TID_WORKFLOW_META_DISCARD,
  TID_WORKFLOW_META_SAVE,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import type {
  SavedWorkflowArgRow,
  SavedWorkflowArgRowError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";
import { SavedWorkflowArgsTable } from "@/settings/saved-workflows/SavedWorkflowArgsTable.js";

export interface SavedWorkflowMetaDraft {
  description: string;
  whenToUse: string;
  rows: SavedWorkflowArgRow[];
}

// draft 是唯一数据来源，SavedWorkflowMetaForm 内部不持有本地草稿副本。
// onDescriptionChange 等 8 个回调全部由 SavedWorkflowDetailView 注入。
// 错误分两层：descriptionError 管说明字段，rowErrors 按 row key 管参数行。
// 本组件不 useState 草稿，避免与上层 draft 出现两份真相。
interface SavedWorkflowMetaFormProps {
  draft: SavedWorkflowMetaDraft;
  rowErrors: Record<string, SavedWorkflowArgRowError>;
  descriptionError: boolean;
  dirty: boolean;
  saving: boolean;
  onDescriptionChange: (value: string) => void;
  onWhenToUseChange: (value: string) => void;
  onRowChange: (key: string, patch: Partial<SavedWorkflowArgRow>) => void;
  onRowAdd: () => void;
  onRowRemove: (key: string) => void;
  onDiscard: () => void;
  onSave: () => void;
}

/**
 * 详情页「基本信息」表单：说明 / 何时使用 / 参数表
 * 行内可编，脏了才浮出「放弃 / 保存」。状态由 SavedWorkflowDetailView 持有，这里只渲染。
 */
// 解构顺序与 SavedWorkflowMetaFormProps 一致，draft 在前回调在后。
// 函数体只读 props 并返回 JSX，唯一调用是 useZCodeIntl 取 intl。
// 输入变更全部走上抛回调，组件不直接改动 draft。
// 组件无内部状态，可直接用固定 draft 做快照测试。
export function SavedWorkflowMetaForm({
  draft,
  rowErrors,
  descriptionError,
  dirty,
  saving,
  onDescriptionChange,
  onWhenToUseChange,
  onRowChange,
  onRowAdd,
  onRowRemove,
  onDiscard,
  onSave,
}: SavedWorkflowMetaFormProps) {
  // 文案统一走 intl 实例。
  // formatMessage 的 id 统一用 workflows.hub.detail.* 前缀。
  // 所有文案取自 intl.formatMessage，组件内不拼自然语言。
  // 键缺失时由 IntlProvider 兜底显示 id，不静默返回空串。
  const { intl } = useZCodeIntl();
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-ui-base font-medium leading-5 text-foreground-subtle">
        {intl.formatMessage({ id: "workflows.hub.detail.basics" })}
      </h2>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="workflow-meta-description" className="text-ui-base font-medium">
          {intl.formatMessage({ id: "workflows.hub.detail.description" })}
        </label>
        <SettingsFormTextarea
          id="workflow-meta-description"
          data-testid={TID_WORKFLOW_DETAIL_DESCRIPTION}
          rows={2}
          value={draft.description}
          aria-invalid={descriptionError}
          className={cn(descriptionError && "border-destructive")}
          onChange={(event) => onDescriptionChange(event.target.value)}
        />
        {descriptionError ? (
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "workflows.hub.detail.meta.descriptionRequired" })}
          </p>
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="workflow-meta-when" className="text-ui-base font-medium">
          {intl.formatMessage({ id: "workflows.hub.detail.whenToUse" })}
        </label>
        <SettingsFormTextarea
          id="workflow-meta-when"
          data-testid={TID_WORKFLOW_DETAIL_WHEN_TO_USE}
          rows={2}
          value={draft.whenToUse}
          onChange={(event) => onWhenToUseChange(event.target.value)}
        />
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.detail.whenToUse.help" })}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-ui-base font-medium">
          {intl.formatMessage({ id: "workflows.hub.detail.args" })}
        </span>
        <SavedWorkflowArgsTable
          rows={draft.rows}
          errors={rowErrors}
          onChange={onRowChange}
          onAdd={onRowAdd}
          onRemove={onRowRemove}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "workflows.hub.detail.meta.note" })}
        </p>
        {dirty ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="lg"
              data-testid={TID_WORKFLOW_META_DISCARD}
              disabled={saving}
              onClick={onDiscard}
            >
              {intl.formatMessage({ id: "workflows.hub.detail.meta.discard" })}
            </Button>
            <Button
              type="button"
              size="lg"
              data-testid={TID_WORKFLOW_META_SAVE}
              disabled={saving}
              onClick={onSave}
            >
              {saving ? <Spinner className="size-3.5" /> : null}
              {intl.formatMessage({ id: "workflows.hub.detail.meta.save" })}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
