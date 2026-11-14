// INV-01 只读记录判定排除数组：守住位置 asRecord；改错故障 数组被当作对象读取。
// INV-02 文本字段去空白：守住位置 readText 判断；改错故障 空白串占用详情行。
// INV-03 非字符串视为缺失：守住位置 类型判断；改错故障 数字被强转成文本。
// INV-04 行标签走本地化：守住位置 标签标识查表；改错故障 详情出现原始键名。
// INV-05 状态为真显示成功图标：守住位置 严格等于真；改错故障 任意真值都显示成功。
// INV-06 状态为假显示失败图标：守住位置 严格等于假；改错故障 失败行没有标记。
// INV-07 代码值用等宽字体：守住位置 代码分支；改错故障 命令与路径难以辨认。
// INV-08 结果区始终渲染：守住位置 无条件分区；改错故障 失败时看不到结果。
// INV-09 结果文案支持占位参数：守住位置 结果参数；改错故障 数量占位符未被替换。
// INV-10 失败原因二选一：守住位置 标识优先于文本；改错故障 同时渲染两段原因。
// INV-11 建议动作二选一：守住位置 标识优先；改错故障 重复展示同一建议。
// INV-12 截图独立成节：守住位置 条件渲染；改错故障 截图信息被挤进文本。
// INV-13 权限行有项才渲染：守住位置 长度判断；改错故障 空权限显示空表。
// INV-14 `model.environmentRows` 有项才渲染：空环境显示空表属于改错故障。
// INV-15 列表按有项才渲染：守住位置 条目长度；改错故障 空列表占位撑高卡片。
// INV-16 状态行最后渲染：守住位置 分区顺序；改错故障 关键状态被折叠在最后。
// INV-17 输入文本长度用于计数：守住位置 计数变量；改错故障 结果数量始终为零。
// INV-18 本组件不解析旧格式：守住位置 只读展示模型；改错故障 详情层承担协议兼容。
//
// 模块职责：CUA 工具调用的详情卡，按模型渲染动作、结果与状态分区。
// 状态所有权：无状态；展示模型由上层构建并传入。
// 阅读顺序：先看记录与文本读取，再读详情行组件，最后看分区顺序。
import { CheckCircle2, XCircle } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { CuaDetailsModel } from "@/ToolCallBlocks/renderers/cua.js";
import { CuaScreenshotSection } from "@/ToolCallBlocks/renderers/CuaScreenshotSection.js";
import { CuaDetailListSection } from "@/ToolCallBlocks/renderers/cuaListDetails.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// readText 只接受字符串：record 为 null 或值非字符串或去空白后为空都返回 null，返回值已 trim 且不改动原记录。
function readText(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// 每行由 labelId 与 value 拼 key（`labelId:value`）；value 为空也保留这一行，布局靠 dl 的两列网格。
// status 为 true/false 时在值左侧加对勾或叉号，row.code 为真时用等宽字体；行数不裁剪。
function CuaDetailRows({ rows }: { rows: CuaDetailsModel["actionRows"] }) {
  const { intl } = useZCodeIntl();
  return (
    <dl className="grid grid-cols-[minmax(4rem,auto)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
      {rows.map((row) => (
        <div key={`${row.labelId}:${row.value}`} className="contents">
          <dt className="text-foreground-subtlest">{intl.formatMessage({ id: row.labelId })}</dt>
          <dd
            className={
              row.code
                ? "min-w-0 break-all font-mono text-foreground"
                : "min-w-0 break-words text-foreground"
            }
          >
            <span className="flex items-center gap-2">
              {row.status === true ? (
                <CheckCircle2 className="size-3.5 shrink-0 text-success" />
              ) : null}
              {row.status === false ? (
                <XCircle className="size-3.5 shrink-0 text-destructive" />
              ) : null}
              {row.value}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

// 计数只取 input.text 的长度（typedCount），不读模型里的结果数。
// actionRows 有行才渲染动作区；结果区始终渲染，失败与建议按需追加且截图与列表各自独立成 section。
export function CuaToolCallDetails({
  model,
  toolCall,
}: {
  model: CuaDetailsModel;
  toolCall: ToolCallBlockRenderContext["toolCallNode"]["toolCall"];
}) {
  const { intl } = useZCodeIntl();
  const typedCount = readText(asRecord(toolCall.input), "text")?.length ?? 0;
  // 完整 tool call JSON 混入了面向用户的 CUA 详情，暴露内部生命周期字段并制造无效入口。
  // 原始数据继续保留在协议与持久化层；这里仅渲染用户完成操作所需的信息。
  // 外层卡片的间距、分隔线与分区顺序都在这里定；条件区缺席不占位且本组件只渲染不包交互。
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface/40 p-3">
      {model.actionRows.length > 0 ? (
        <section className="space-y-2">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.action" })}
          </h4>
          <CuaDetailRows rows={model.actionRows} />
        </section>
      ) : null}
      <section
        className={
          model.actionRows.length > 0 ? "space-y-2 border-t border-border pt-3" : "space-y-2"
        }
      >
        <h4 className="text-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolCall.cua.details.result" })}
        </h4>
        <div
          className={
            model.success
              ? "flex items-center gap-2 text-sm text-foreground"
              : "flex items-center gap-2 text-sm text-destructive"
          }
        >
          {model.success ? (
            <CheckCircle2 className="size-3.5 shrink-0" />
          ) : (
            <XCircle className="size-3.5 shrink-0" />
          )}
          <span>
            {intl.formatMessage(
              { id: model.resultId },
              model.resultValues ?? { count: String(typedCount) },
            )}
          </span>
        </div>
      </section>
      {model.failureReasonId || model.failureReason ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.failureReason" })}
          </h4>
          <p className="text-sm text-foreground">
            {model.failureReasonId
              ? intl.formatMessage({ id: model.failureReasonId })
              : model.failureReason}
          </p>
        </section>
      ) : null}
      {model.suggestedActionId || model.suggestedAction ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.suggestedAction" })}
          </h4>
          <p className="text-sm text-foreground">
            {model.suggestedActionId
              ? intl.formatMessage({ id: model.suggestedActionId })
              : model.suggestedAction}
          </p>
        </section>
      ) : null}
      {model.screenshot ? <CuaScreenshotSection screenshot={model.screenshot} /> : null}
      {model.permissionRows?.length ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.permissions" })}
          </h4>
          <CuaDetailRows rows={model.permissionRows} />
        </section>
      ) : null}
      {model.environmentRows?.length ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.environment" })}
          </h4>
          <CuaDetailRows rows={model.environmentRows} />
        </section>
      ) : null}
      {model.list && model.list.items.length > 0 ? (
        <CuaDetailListSection list={model.list} />
      ) : null}
      {model.stateRows.length > 0 ? (
        <section className="space-y-2 border-t border-border pt-3">
          <h4 className="text-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.cua.details.state" })}
          </h4>
          <CuaDetailRows rows={model.stateRows} />
        </section>
      ) : null}
    </div>
  );
}
