// INV-01 无引用时不渲染：守住位置 提前返回；改错故障 空标签占住输入区。
// INV-02 单条且带路径时显示文件名：守住位置 长度判断；改错故障 单文件引用被说成计数。
// INV-03 文件名只取末段：守住位置 分隔符正则；改错故障 长路径撑破标签。
// INV-04 混合与纯文本计数分文案：守住位置 任一判断；改错故障 混合引用被当作同源。
// INV-05 计数以字符串传入占位符：守住位置 参数类型；改错故障 本地化插值报错。
// INV-06 展开项键优先用引用标识：守住位置 键表达式；改错故障 删除一条后其余项重挂载。
// INV-07 非引用项键回退到序号与文本：守住位置 兜底拼接；改错故障 同文本重复时键冲突。
// INV-08 发送者信息三者取或：守住位置 或链；改错故障 只有时间时丢失整行。
// INV-09 标识过长时截断显示：守住位置 切片；改错故障 长标识挤掉时间。
// INV-10 时间按当前语言格式化：守住位置 语言入参；改错故障 时间显示成英文格式。
// INV-11 正文最多三行并保留换行：守住位置 截断类；改错故障 长引用淹没整个面板。
// INV-12 来源行按引用类型分流：守住位置 条件链；改错故障 表格引用不显示行号。
// INV-13 仅可删除引用显示删除键：守住位置 类型判断；改错故障 纯文本项出现无效按钮。
// INV-14 删除键随悬停显现：守住位置 分组类；改错故障 每行常驻按钮造成噪声。
// INV-15 删除键携带无障碍名称：守住位置 标签属性；改错故障 读屏只念按钮。
// INV-16 全部移除交给共用标签：守住位置 属性透传；改错故障 无法一次清空引用。
// INV-17 对齐方式默认靠前：守住位置 默认参数；改错故障 弹层内容贴右错位。
// INV-18 计数写入触发器属性：守住位置 数据属性；改错故障 测试无法确认引用条数。
//
// 模块职责：把对话选中片段渲染成带展开列表的引用标签。
// 状态所有权：无内部状态；引用列表与移除回调都由调用方注入。
// 阅读顺序：先看标签文案派生，再看展开项，最后看删除入口。
import { QuoteIcon, Trash2Icon } from "lucide-react";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  isConversationSelectionReference,
  type ConversationSelectionDisplayReference,
} from "@/lib/conversationSelectionReference.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

// references.length === 0 时返回 null，不渲染 pill。
// 单条引用且有 path 时走 chat.selections.file 文案。
// 多条且含 path 时用 chat.selections.mixedCount。
// references.map 顺序即展示顺序，不做排序。
export function ConversationSelectionReferenceChip({
  references,
  contentAlign = "start",
  onRemove,
  onRemoveAll,
}: {
  references: readonly ConversationSelectionDisplayReference[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { intl, locale } = useZCodeIntl();
  if (references.length === 0) return null;
  // filePath 只在 references.length === 1 时取 references[0].path。
  // 文件名取 filePath 末段，空值回退原串。
  // 任一 reference.path 存在即走 mixedCount。
  // count 以 String(references.length) 传入 ICU 占位。
  const filePath = references.length === 1 ? references[0]?.path : undefined;
  // 文件引用沿用共用 pill，但不能再被「对话引用」计数隐藏来源。
  const label = filePath
    ? intl.formatMessage(
        { id: "chat.selections.file" },
        { name: filePath.split(/[\\/]/).pop() ?? filePath },
      )
    : intl.formatMessage(
        {
          id: references.some((reference) => reference.path)
            ? "chat.selections.mixedCount"
            : "chat.selections.count",
        },
        { count: String(references.length) },
      );
  // removeLabel 由 chat.selections.remove 解析一次。
  // onRemove 存在时 ContextAttachmentPill 才渲染删除按钮。
  // 删除按钮可见性由 hover 状态控制。
  // onRemoveAll 交给 ContextAttachmentPill 的共用标签处理。
  const removeLabel = intl.formatMessage({ id: "chat.selections.remove" });
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<QuoteIcon className="size-4 shrink-0 text-foreground-subtle" />}
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
      triggerProps={{
        "data-conversation-selection-reference-count": references.length,
      }}
    >
      {references.map((reference, index) => (
        <div
          key={
            isConversationSelectionReference(reference)
              ? reference.id
              : `${index}:${reference.text}`
          }
          className="group/reference flex gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-menu-hover"
        >
          <QuoteIcon className="mt-0.5 size-4 shrink-0 text-foreground-subtle" />
          <div className="min-w-0 flex-1">
            {reference.senderName || reference.senderId || reference.sentAt ? (
              <div className="mb-1 text-ui-sm text-foreground-subtle">
                {reference.senderName ||
                  (reference.senderId
                    ? `${reference.senderId.slice(0, 8)}…${reference.senderId.slice(-4)}`
                    : "")}
                {reference.sentAt ? (
                  <>
                    {" "}
                    ·{" "}
                    {new Date(reference.sentAt).toLocaleTimeString(locale, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </>
                ) : null}
              </div>
            ) : null}
            <div className="line-clamp-3 whitespace-pre-wrap break-words">{reference.text}</div>
            {reference.path || isConversationSelectionReference(reference) ? (
              <div className="mt-0.5 break-words text-ui-sm text-foreground-subtlest">
                {reference.path ? (
                  reference.path
                ) : isConversationSelectionReference(reference) &&
                  reference.contentType === "markdown" ? (
                  reference.sourceTitle
                ) : isConversationSelectionReference(reference) &&
                  reference.contentType !== "markdown" ? (
                  <>
                    {intl.formatMessage({ id: `chat.selections.type.${reference.contentType}` })} ·
                    #{reference.sourceRowId}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
          {onRemove && isConversationSelectionReference(reference) ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 text-foreground-subtle opacity-0 group-hover/reference:opacity-100"
              aria-label={removeLabel}
              onClick={() => onRemove(reference.id)}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
