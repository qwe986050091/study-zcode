// INV-01 空引用不渲染：守住位置 长度判断；改错故障 消息下方留空药丸。
// INV-02 文案随数量切换单复数：守住位置 条件标识；改错故障 单条引用显示复数文案。
// INV-03 数量以字符串传入：守住位置 占位参数；改错故障 格式化器拿到数字报错。
// INV-04 展示文本按优先级回退：守住位置 或运算链；改错故障 空选中文本显示空白行。
// INV-05 删除按钮仅在传入回调时出现：守住位置 条件渲染；改错故障 只读场景出现删除入口。
// INV-06 删除先阻断冒泡：守住位置 事件处理；改错故障 点删除同时打开引用详情。
// INV-07 打开与只读共用同一行结构：守住位置 双分支；改错故障 有回调与无回调排版不同。
// INV-08 打开入口使用按钮语义：守住位置 元素选择；改错故障 键盘无法触发详情。
// INV-09 无打开回调时降级为容器：守住位置 分支入口；改错故障 只读行仍可聚焦。
// INV-10 引用键取自数据标识：守住位置 键属性；改错故障 同批引用复用错误节点。
// INV-11 位置信息由来源标题拼装：守住位置 模板拼接；改错故障 用户无法定位幻灯片。
// INV-12 幻灯片序号按一基展示：守住位置 加一运算；改错故障 首屏显示第零页。
// INV-13 备注为空时不渲染：守住位置 双条件；改错故障 空白备注占两行高度。
// INV-14 备注最多显示两行：守住位置 截断类名；改错故障 长备注撑爆药丸。
// INV-15 删除按钮无障碍名同源：守住位置 变量复用；改错故障 朗读内容与提示不一致。
// INV-16 删除按钮悬停才显现：守住位置 透明度类名；改错故障 列表常驻一排垃圾桶。
// INV-17 内容对齐透传给药丸：守住位置 属性透传；改错故障 组合框与消息对齐不一致。
// INV-18 全部删除由药丸承载：守住位置 属性透传；改错故障 缺少清空引用入口。
//
// 模块职责：PPTX 元素引用药丸的列表渲染与打开、删除交互。
// 状态所有权：无状态；引用数组与回调全部由调用方传入。
// 阅读顺序：先看文本回退，再看组件分支，最后看每行的打开与删除结构。
import { PresentationIcon, Trash2Icon } from "lucide-react";
import type { AttachmentHoverCardContentProps } from "@/components/ai-elements/attachments.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PptxElementReference } from "@/lib/pptxElementReference.js";
import { ContextAttachmentPill } from "@/v4/composer/ContextAttachmentPill.js";

// getReferenceText 优先取 reference.selectedText。
// 其次取 reference.text。
// 再回退到 reference.nodeName 与 reference.nodeType。
// getReferenceText 的四级回退经逻辑或串联，保证返回非空。
function getReferenceText(reference: PptxElementReference) {
  return reference.selectedText || reference.text || reference.nodeName || reference.nodeType;
}

// references.length 为 0 时直接返回 null。
// label 按 references.length 取 one 或 many 两条文案。
// removeLabel 单独经 intl.formatMessage 格式化。
export function PptxElementReferenceChip({
  references,
  contentAlign = "start",
  onOpen,
  onRemove,
  onRemoveAll,
}: {
  references: readonly PptxElementReference[];
  contentAlign?: AttachmentHoverCardContentProps["align"];
  onOpen?: (reference: PptxElementReference) => void;
  onRemove?: (id: string) => void;
  onRemoveAll?: () => void;
}) {
  const { intl } = useZCodeIntl();
  if (references.length === 0) {
    return null;
  }
  const label = intl.formatMessage(
    {
      id: references.length === 1 ? "chat.pptxElements.one" : "chat.pptxElements.many",
    },
    { count: String(references.length) },
  );
  const removeLabel = intl.formatMessage({ id: "chat.pptxElements.remove" });
  // ContextAttachmentPill 承接 icon 与 onRemoveAll。
  // 逐条 map 出 reference 对应的引用行。
  // onOpen 存在时才把引用行渲染成按钮。
  return (
    <ContextAttachmentPill
      contentAlign={contentAlign}
      icon={<PresentationIcon className="size-4 shrink-0 text-foreground-subtle" />}
      label={label}
      onRemoveAll={onRemoveAll}
      removeLabel={removeLabel}
    >
      {references.map((reference) => (
        <div
          key={reference.id}
          className="group/context flex min-h-7 items-start gap-1 rounded-lg px-1 py-0.5 text-ui-base/relaxed hover:bg-menu-hover"
        >
          {onOpen ? (
            <button
              type="button"
              className="flex min-w-0 flex-1 items-start gap-2 rounded-md px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              onClick={() => onOpen(reference)}
            >
              <PresentationIcon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{getReferenceText(reference)}</span>
                <span className="block truncate font-mono text-ui-sm text-foreground-subtle">
                  {reference.sourceTitle} · {reference.slideIndex + 1} · {reference.nodeId}
                </span>
                {reference.comment?.trim() ? (
                  <span className="line-clamp-2 text-ui-base/relaxed text-foreground-subtle">
                    {reference.comment}
                  </span>
                ) : null}
              </span>
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-start gap-2 px-1 py-0.5">
              <PresentationIcon className="mt-1 size-4 shrink-0 text-foreground-subtle" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{getReferenceText(reference)}</div>
                <div className="truncate font-mono text-ui-sm text-foreground-subtle">
                  {reference.sourceTitle} · {reference.slideIndex + 1} · {reference.nodeId}
                </div>
                {reference.comment?.trim() ? (
                  <div className="line-clamp-2 text-ui-base/relaxed text-foreground-subtle">
                    {reference.comment}
                  </div>
                ) : null}
              </div>
            </div>
          )}
          {onRemove ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="mt-0.5 size-5 shrink-0 rounded-sm text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover/context:opacity-100 focus-visible:opacity-100"
              aria-label={removeLabel}
              title={removeLabel}
              onClick={(event) => {
                event.stopPropagation();
                onRemove(reference.id);
              }}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      ))}
    </ContextAttachmentPill>
  );
}
