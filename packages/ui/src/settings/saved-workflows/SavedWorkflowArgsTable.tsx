// INV-01 类型闭合：守住位置 ARG_TYPES；改错故障：下拉出现后端不认识的类型。
// INV-02 单一列宽：守住位置 columns 常量；改错故障：表头与数据行错位。
// INV-03 受控输入：守住位置 控件 value 与 onChange；改错故障：输入框自持状态，外部重置失效。
// INV-04 错误键外用：守住位置 error 取值；改错故障：行错误串到相邻行。
// INV-05 布尔专用控件：守住位置 defaultText 的三态选择；改错故障：布尔默认值被填成任意字符串。
// INV-06 空串即无：守住位置 none 与空串互换；改错故障：占位项被当成字面量 none。
// INV-07 必填开关：守住位置 required 的 Switch；改错故障：必填状态无法回传。
// INV-08 增删由外层：守住位置 onAdd 与 onRemove；改错故障：组件内部维护行，父级表单失同步。
// INV-09 行键稳定：守住位置 key 与 data-workflow-arg-row；改错故障：重排后输入焦点跳到别行。
// INV-10 名称错误高亮：守住位置 empty_name 与 duplicate_name；改错故障：重名不提示。
// INV-11 默认值错误高亮：守住位置 invalid_default；改错故障：非法默认值静默保存。
// INV-12 文案走 intl：守住位置 所有 aria-label 与列头；改错故障：出现硬编码中文。
// INV-13 网格即布局：守住位置 表头与行共用 columns；改错故障：窄容器下两处错位。
// INV-14 无行不占位：守住位置 rows 的遍历；改错故障：空态写死在组件内，与上层不一致。
// INV-15 错误段独立：守住位置 error 段的段落；改错故障：错误挤进输入框破坏对齐。
// INV-16 删除语义：守住位置 X 按钮的 aria-label；改错故障：读屏只念图标。
// INV-17 表格不持有校验：守住位置 错误类型来源；改错故障：组件内重复实现校验规则。
// INV-18 增行置底：守住位置 底部按钮区；改错故障：新增行入口随内容滚动丢失。
//
// 模块职责：渲染保存工作流的参数声明表，包含增删行与按类型出控件。
// 状态所有权：行数据、错误与增删回调全部由父级表单持有，本组件只做投影。
// 阅读顺序：类型常量与列宽 → 组件签名 → 行渲染 → 错误提示 → 底部增行。
import { Plus, X } from "lucide-react";
import type { ZCodeSavedWorkflowArgType } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  SavedWorkflowArgRow,
  SavedWorkflowArgRowError,
} from "@/settings/saved-workflows/savedWorkflowArgsForm.js";

// ARG_TYPES 四种可选类型与后端参数模型一一对应。
// ARG_TYPES 顺序即下拉顺序，不要按字母重排。
// 新增 ARG_TYPES 项必须同步默认值控件与校验规则。
const ARG_TYPES: readonly ZCodeSavedWorkflowArgType[] = ["string", "number", "boolean", "json"];

/** 详情页「参数」声明表：可增删行，默认值按类型出控件。 */
// 组件只投影父级状态，行数据与错误都从 props 读。
// onChange 用行键定位，避免下标在增删后漂移。
// onAdd 与 onRemove 交给外层，组件不自行改行集合。
// intl 只在这里取一次，供列头与控件复用。
// 外层容器用 rounded-lg 与 border 画圆角边框，行之间只画分隔线。
// 列数与 columns 的轨数必须一致，否则整行错位。
export function SavedWorkflowArgsTable({
  rows,
  errors,
  onChange,
  onAdd,
  onRemove,
}: {
  rows: readonly SavedWorkflowArgRow[];
  errors: Record<string, SavedWorkflowArgRowError>;
  onChange: (key: string, patch: Partial<SavedWorkflowArgRow>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const { intl } = useZCodeIntl();
  // 表头与数据行共用 columns 的网格列宽。
  // 列宽用 minmax 保证名称与描述可伸缩。
  // 末尾 28px 给删除按钮留固定位。
  const columns = "grid-cols-[minmax(0,1.4fr)_112px_64px_minmax(0,1fr)_minmax(0,1.6fr)_28px]";
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div
        className={cn(
          "grid items-center gap-3 bg-surface px-3 py-1.5 text-ui-sm text-foreground-subtle",
          columns,
        )}
      >
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.name" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.type" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.required" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.default" })}</span>
        <span>{intl.formatMessage({ id: "workflows.hub.detail.args.description" })}</span>
        <span aria-hidden="true" />
      </div>
      {rows.map((row) => {
        // 行错误按 errors[row.key] 取，缺失即该行无错。
        // 名称错误同时标在 Input 与行下方。
        // defaultValue 错误只影响默认值控件。
        //
        const error = errors[row.key];
        return (
          <div
            key={row.key}
            className="border-t border-border px-3 py-2"
            data-workflow-arg-row={row.name}
          >
            <div className={cn("grid items-center gap-3", columns)}>
              <Input
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.name" })}
                className={cn(
                  "h-7 font-mono",
                  error === "empty_name" || error === "duplicate_name" ? "border-destructive" : "",
                )}
                value={row.name}
                onChange={(event) => onChange(row.key, { name: event.target.value })}
              />
              <Select
                value={row.type}
                onValueChange={(value) =>
                  onChange(row.key, { type: value as ZCodeSavedWorkflowArgType })
                }
              >
                <SelectTrigger size="sm" className="h-7 w-full font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ARG_TYPES.map((type) => (
                    <SelectItem key={type} value={type} className="font-mono">
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Switch
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.required" })}
                checked={row.required}
                onCheckedChange={(checked) => onChange(row.key, { required: checked })}
              />
              {row.type === "boolean" ? (
                <Select
                  value={row.defaultText === "" ? "none" : row.defaultText}
                  onValueChange={(value) =>
                    onChange(row.key, { defaultText: value === "none" ? "" : value })
                  }
                >
                  <SelectTrigger size="sm" className="h-7 w-full font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    <SelectItem value="true" className="font-mono">
                      true
                    </SelectItem>
                    <SelectItem value="false" className="font-mono">
                      false
                    </SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.default" })}
                  className={cn(
                    "h-7 font-mono",
                    error === "invalid_default" && "border-destructive",
                  )}
                  value={row.defaultText}
                  onChange={(event) => onChange(row.key, { defaultText: event.target.value })}
                />
              )}
              <Input
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.description" })}
                className="h-7"
                value={row.description}
                onChange={(event) => onChange(row.key, { description: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "workflows.hub.detail.args.remove" })}
                onClick={() => onRemove(row.key)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            {error ? (
              <p className="mt-1 text-ui-sm text-destructive">
                {intl.formatMessage({ id: `workflows.hub.detail.args.error.${error}` })}
              </p>
            ) : null}
          </div>
        );
      })}
      <div className="border-t border-border px-2 py-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-icon="inline-start"
          className="text-foreground-subtle"
          onClick={onAdd}
        >
          <Plus className="size-3" aria-hidden="true" />
          {intl.formatMessage({ id: "workflows.hub.detail.args.add" })}
        </Button>
      </div>
    </div>
  );
}
