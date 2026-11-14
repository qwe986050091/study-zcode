// INV-01 卡片自身即按钮：守住位置 role 与 tabIndex；改错故障 键盘无法打开详情。
// INV-02 只拦真实子控件：守住位置 interactive !== card；改错故障 整卡点击从未生效。
// INV-03 点击与键盘共用判定：守住位置 isInteractiveDescendant；改错故障 两条路径行为分叉。
// INV-04 键盘只认回车与空格：守住位置 key 判断；改错故障 任意键都打开详情。
// INV-05 子控件键盘事件不重复：守住位置 提前返回；改错故障 一次按键打开两次。
// INV-06 空格需阻止默认滚动：守住位置 preventDefault；改错故障 页面随空格滚动。
// INV-07 无 markdown 时用通用输出：守住位置 hasMarkdown 分支；改错故障 卡片空白。
// INV-08 失败态优先展示错误：守住位置 toolCall.output 判断；改错故障 错误被成功内容掩盖。
// INV-09 复制前确认能力存在：守住位置 clipboard 判断；改错故障 无剪贴板环境抛错。
// INV-10 复制成功才切换图标：守住位置 then 两支；改错故障 图标先于写入变化。
// INV-11 复制按钮阻止冒泡：守住位置 stopPropagation；改错故障 点复制同时打开详情。
// INV-12 查看全部同样阻止冒泡：守住位置 事件处理；改错故障 重复打开面板。
// INV-13 正文与渐隐同节点：守住位置 max-height 与 mask；改错故障 底部渐隐失效。
// INV-14 快照提示始终附带：守住位置 snapshotNotice；改错故障 部分字段缺失无提示。
// INV-15 计划文件路径可选：守住位置 planFilePath 判断；改错故障 无路径时渲染空标签。
// INV-16 标题与图标走国际化：守住位置 formatMessage；改错故障 硬编码文案。
// INV-17 无输出时只回快照提示：守住位置 末尾返回；改错故障 渲染空容器。
// INV-18 卡片样式集中在 section：守住位置 className；改错故障 悬浮与聚焦态不一致。
//
// 模块职责：渲染 switch_mode 工具调用的计划卡片，并处理复制、打开详情与降级输出。
// 状态所有权：仅复制态为本地状态；计划正文与回调均来自工具调用上下文。
// 阅读顺序：先看交互判定，再看事件处理，最后看两种渲染分支。
import { useState, type KeyboardEvent, type MouseEvent } from "react";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { ToolOutput } from "@/components/ai-elements/tool.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getToolCallErrorText } from "@/lib/toolError.js";
import { extractPlanToolCallContent, getPlanFileLabel } from "@/lib/planToolCall.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import { ArrowRightIcon, CheckIcon, CopyIcon, NotepadTextIcon } from "lucide-react";

// target 不是 Element 时 isInteractiveDescendant 直接返回 false。
// interactive 等于 card 时不算子控件，否则整卡点击全被自己吃掉。
// isInteractiveDescendant 只拦复制、展开与正文链接等真实子控件。
function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("button, a, input, textarea, select, [role='button']");
  // 卡片自身带 role=button，旧 closest 会让卡片任意位置都命中自己，
  // 结果“点击卡片打开详情”从未执行。这里只拦截复制/展开/正文链接等真实子控件。
  return interactive !== null && interactive !== card;
}

// section 自身承担 role=button，不额外套按钮元素。
// 点击与键盘路径都经 isInteractiveDescendant 判定。
// snapshotNotice 在两种内容分支都附带。
export function SwitchModeToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const { toolCall } = context.toolCallNode;
  const errorText = getToolCallErrorText(toolCall);
  const { markdown, planFilePath } = extractPlanToolCallContent(toolCall, context.workspacePath);
  const snapshotNotice = (
    <ToolSnapshotFieldNotice
      refs={toolCall.snapshotRefs ?? []}
      onLoadFullToolCallFields={
        context.onLoadFullToolCallFields
          ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
          : undefined
      }
    />
  );
  const hasMarkdown = typeof markdown === "string" && markdown.length > 0;
  const [copiedMarkdown, setCopiedMarkdown] = useState<string | null>(null);
  const copied = copiedMarkdown === markdown;

  // markdown 或 onOpenPlanDetail 缺失时 openDetail 直接返回。
  // planFilePath 存在时才展开进 payload，避免写入 undefined。
  // onOpenPlanDetail 只收到 toolCallId/markdown/planFilePath 三个字段。
  const openDetail = () => {
    if (!markdown || !context.onOpenPlanDetail) return;
    context.onOpenPlanDetail({
      toolCallId: toolCall.toolId,
      markdown,
      ...(planFilePath ? { planFilePath } : {}),
    });
  };

  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!isInteractiveDescendant(event.target, event.currentTarget)) openDetail();
  };

  // handleCardKeyDown 只接管 Enter 与 Space。
  // 子控件按键会冒泡，先经 isInteractiveDescendant 排除。
  // preventDefault 阻止 Space 滚动页面。
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    // 内部按钮的 keydown 会继续冒泡到整卡，导致一次键盘操作重复打开详情。
    // 与点击路径共用交互元素判定，只允许整卡自身接管 Enter / Space。
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    openDetail();
  };

  // navigator.clipboard.writeText 不可用时 handleCopy 直接返回。
  // 写入成功才把 copiedMarkdown 设为当前 markdown。
  // 写入失败把 copiedMarkdown 复位为 null。
  const handleCopy = () => {
    if (!markdown || typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
    void navigator.clipboard.writeText(markdown).then(
      () => setCopiedMarkdown(markdown),
      () => setCopiedMarkdown(null),
    );
  };

  // hasMarkdown 为真时渲染计划卡片。
  // errorText 存在时回退到 ToolOutput。
  // 两者都缺失时只留 snapshotNotice 提示。
  if (hasMarkdown) {
    return (
      <>
        <section
          role={context.onOpenPlanDetail ? "button" : undefined}
          tabIndex={context.onOpenPlanDetail ? 0 : undefined}
          aria-label={intl.formatMessage({ id: "planTool.panel.open" })}
          onClick={handleCardClick}
          onKeyDown={handleCardKeyDown}
          className="group w-full min-w-0 overflow-hidden rounded-xl border border-card-border bg-card text-foreground shadow-xs outline-none transition-colors hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <header className="flex h-10 min-w-0 items-start gap-2 px-4 pt-4">
            <div className="flex shrink-0 items-center gap-2">
              <NotepadTextIcon className="size-4 shrink-0 text-foreground-subtle" />
              <h3 className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "planTool.panel.planTab" })}
              </h3>
            </div>
            {planFilePath ? (
              <code
                className="min-w-0 truncate text-ui-sm text-foreground-subtlest"
                title={planFilePath}
              >
                {getPlanFileLabel(planFilePath)}
              </code>
            ) : null}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({
                  id: copied ? "planTool.panel.copied" : "planTool.panel.copy",
                })}
                onClick={(event) => {
                  event.stopPropagation();
                  handleCopy();
                }}
              >
                {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
              </Button>
            </div>
          </header>
          <div className="relative overflow-hidden">
            {/* max-height 与 mask 分层后，长正文会按完整内容高度计算渐变，
            导致实际可见区域没有底部渐隐；两者必须落在同一个裁切节点。 */}
            <div className="max-h-64 overflow-hidden px-4 pt-2 pb-12 [mask-image:linear-gradient(to_bottom,black_0%,black_30%,transparent_100%)]">
              <MessageResponse
                className="min-w-0 break-words text-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_li]:text-foreground-subtle [&_p]:text-foreground-subtle"
                workspacePath={context.workspacePath}
                theme={context.theme}
                codePreviewSettings={context.codePreviewSettings}
                onOpenCodeViewer={context.onOpenCodeViewer}
                onOpenFileLink={context.onOpenFileLink}
                onOpenExternalUrl={context.onOpenBrowserUrl}
              >
                {markdown}
              </MessageResponse>
            </div>
            <Button
              type="button"
              variant="default"
              size="lg"
              className="absolute bottom-6 left-1/2 h-10 -translate-x-1/2 rounded-full !pr-4.5 pl-6 shadow-xs"
              onClick={(event) => {
                event.stopPropagation();
                openDetail();
              }}
            >
              {intl.formatMessage({ id: "planTool.panel.viewFull" })}
              <ArrowRightIcon data-icon="inline-end" className="size-4" />
            </Button>
          </div>
        </section>
        {snapshotNotice}
      </>
    );
  }

  // switch_mode 的有效信息通常就是那段 markdown 结果，不应该再套一层通用工具卡片。
  // 只有当 provider 没给出 markdown、或者当前是失败态时，才回退到最小输出块，避免 UI 彻底空白。
  if (toolCall.output !== undefined || errorText) {
    return (
      <>
        <ToolOutput errorText={errorText} output={errorText ? undefined : toolCall.output} />
        {snapshotNotice}
      </>
    );
  }

  return snapshotNotice;
}
