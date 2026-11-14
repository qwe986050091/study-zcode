// INV-01 成功态只在分享完成后展示：守住位置 调用方挂载条件；改错故障：失败也会出现重复链接。
// INV-02 复制成功提示两秒后自动复原：守住位置 复制状态 effect；改错故障：提示常驻会让用户重复点击。
// INV-03 定时器必须随状态重建：守住位置 清理函数；改错故障：旧定时器会提前清掉新的成功态。
// INV-04 复制结果按 Promise 归一：守住位置 点击分支；改错故障：同步与异步返回值会让成功态失效。
// INV-05 复制失败回到未复制态：守住位置 失败分支；改错故障：失败仍显示已复制会误导用户。
// INV-06 链接为空时不渲染输入框：守住位置 地址条件；改错故障：空输入框会被当成可复制内容。
// INV-07 输入框聚焦即全选：守住位置 聚焦回调；改错故障：用户只能复制到半截链接。
// INV-08 标题最多两行并带完整提示：守住位置 截断样式与标题属性；改错故障：长标题撑破卡片。
// INV-09 警告区仅在有问题时出现：守住位置 问题长度判断；改错故障：空详情折叠会占据视觉空间。
// INV-10 警告条目键包含序号：守住位置 key 拼接；改错故障：同码同行的多条问题会复用节点。
// INV-11 字节类数值按量级换单位：守住位置 格式化分支；改错故障：统一字节数会让上限难以阅读。
// INV-12 非字节类数值原样输出：守住位置 回落分支；改错故障：误加单位会改变语义。
// INV-13 缺省数值统一用破折号：守住位置 空值判断；改错故障：直接输出空值会像程序错误。
// INV-14 警告文案键由问题类型决定：守住位置 文案键解析；改错故障：兜底键会让所有问题共用一句话。
// INV-15 省略条数单独提示：守住位置 省略计数分支；改错故障：用户会以为问题只有已列出的几条。
// INV-16 打开与复制并列为两个主操作：守住位置 动作区网格；改错故障：只剩复制会让用户无法直达页面。
// INV-17 关闭按钮独立于动作区：守住位置 头部右侧；改错故障：误触确认会把面板留在页面上。
// INV-18 状态区使用实时区域播报：守住位置 状态角色；改错故障：读屏不会感知分享成功。
//
// 模块职责：`ConversationShareSuccessDock` 渲染分享成功后的链接与警告，并承载复制 / 打开 / 关闭三个动作。
// 状态所有权：复制提示归本组件；链接、标题与警告由调用方传入。
// 阅读顺序：先看复制提示生命周期，再看数值与警告格式化，最后看三个动作区。
import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";
import { CheckCircle2, Copy, ExternalLink, X } from "lucide-react";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ConversationShareDisplayWarnings } from "@/store/conversationShareSelectionStore.js";
import {
  formatConversationShareAllowedArtifacts,
  formatConversationShareArtifactType,
  resolveConversationShareWarningMessageId,
} from "@/lib/conversationShareError.js";

export interface ConversationShareSuccessDockProps {
  url?: string;
  title: string;
  warnings?: ConversationShareDisplayWarnings | null;
  onOpen: () => void;
  onCopy: () => void | Promise<boolean>;
  onDismiss: () => void;
}

// formatValue 只服务警告文案的 actual/limit 两个字段：code.includes("size") 或 code === "payload_size_limit"
// 时把字节数换算成 MB/KB/B（>=1 MiB 保留一位小数，>=1 KiB 取整到 KB，更小直接给 B，避免出现 "0.0 KB"），
// 其余 code 原样 String(value)；value === undefined 统一返回 "—"，缺失参数在 formatMessage 里仍可读。
function formatValue(value: number | undefined, code: string): string {
  if (value === undefined) return "—";
  if (code.includes("size") || code === "payload_size_limit") {
    if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB`;
    return `${value} B`;
  }
  return String(value);
}

export function ConversationShareSuccessDock({
  url,
  title,
  warnings = null,
  onOpen,
  onCopy,
  onDismiss,
}: ConversationShareSuccessDockProps) {
  // copied 只表示「复制成功提示」是否显示，与 url 是否可复制无关；按钮 onClick 里用 Promise.resolve(onCopy())
  // 归一同步/异步返回值，resolve 为 true 才 setCopied(true)，reject 回落 false；初始 false 保证首次打开不显示成功文案。
  const [copied, setCopied] = useState(false);
  // 该 effect 依赖 [copied]：每次 setCopied(true) 都先 clearTimeout 上一个 2000ms 定时器再建新的，
  // 因此连续点击不会叠加多个 timer；copied 为 false 时提前 return，不注册任何计时器。
  // 父级卸载 dock 时返回的 clearTimeout 会撤销最后一个 timer，避免卸载后 setCopied(false) 触发 React 警告。
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  const { intl, locale } = useZCodeIntl();

  return (
    // 分享 dock 曾在同一输入区额外叠加 popover ring、阴影和固定宽度，
    // 切换时会产生不必要的层级光晕；这里只继承普通 Composer 的基础输入 surface。
    // 头部：role="status" 容器负责播报，右侧 dismiss 按钮只调用 onDismiss，是否卸载由父级决定；
    // 告警区：warnings.issues.length > 0 才渲染 details，key 用 `${issue.code}-${issue.rowId ?? "global"}-${index}` 防止同码多行复用节点；
    // 动作区：grid-cols-2 固定两列，onOpen 走外部浏览器，onCopy 成功后复用同一个 copied 状态切换按钮文案。
    <section
      data-conversation-share-keep-open="success-dock"
      data-testid="conversation-share-success-dock"
      className={cn("w-full overflow-hidden text-foreground", "flex flex-col gap-3 bg-popover p-3")}
    >
      <div className={cn("flex justify-between gap-3", "items-center")}>
        <div
          data-testid="conversation-share-success-status"
          role="status"
          aria-live="polite"
          className={cn("flex min-w-0 gap-2", "items-center")}
        >
          <CheckCircle2 className={"size-4 shrink-0 text-success"} aria-hidden="true" />
          <div className="min-w-0">
            <p className={cn("font-medium text-foreground", "text-ui-lg")}>
              {intl.formatMessage({ id: "conversationShare.result.title" })}
            </p>
            {null}
          </div>
        </div>
        <button
          type="button"
          data-testid="conversation-share-success-dismiss"
          aria-label={intl.formatMessage({
            id: "conversationShare.result.dismiss",
          })}
          onClick={onDismiss}
          className="flex size-7 shrink-0 items-center justify-center rounded-lg text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-input-border-focused"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className={"grid gap-1"}>
        {null}
        <p
          data-testid="conversation-share-result-title"
          className={cn("min-w-0 text-ui-base text-foreground", "line-clamp-2 break-words")}
          title={title}
        >
          {title}
        </p>
      </div>

      {url ? (
        <Input
          size="lg"
          readOnly
          aria-label={intl.formatMessage({
            id: copied ? "conversationShare.copySucceeded" : "conversationShare.copyLink",
          })}
          value={url}
          onFocus={(event) => event.currentTarget.select()}
          className={"truncate"}
        />
      ) : null}
      {warnings && warnings.issues.length > 0 ? (
        <details
          data-testid="conversation-share-success-warning"
          className={cn(
            "rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-foreground",
          )}
        >
          <summary className="cursor-pointer text-ui-base font-medium text-warning">
            {intl.formatMessage(
              { id: "conversationShare.warning.summary" },
              { count: warnings.issueCount },
            )}
          </summary>
          <ul className="mt-2 grid gap-1.5 text-ui-base leading-normal">
            {warnings.issues.map((issue, index) => (
              <li key={`${issue.code}-${issue.rowId ?? "global"}-${index}`}>
                {intl.formatMessage(
                  { id: resolveConversationShareWarningMessageId(issue) },
                  {
                    turnOrdinal: issue.turnOrdinal ?? "—",
                    artifactDisplayName: issue.artifactDisplayName ?? "—",
                    artifactType: formatConversationShareArtifactType(issue, locale),
                    extension: issue.extension ?? "—",
                    mimeType: issue.mimeType ?? "—",
                    allowedFormats: formatConversationShareAllowedArtifacts(issue, locale),
                    actual: formatValue(issue.actual, issue.code),
                    limit: formatValue(issue.limit, issue.code),
                    phase: issue.phase ?? "—",
                  },
                )}
              </li>
            ))}
          </ul>
          {warnings.omittedIssueCount ? (
            <p className="mt-2 text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "conversationShare.issue.more" },
                { count: warnings.omittedIssueCount },
              )}
            </p>
          ) : null}
        </details>
      ) : null}

      <div data-testid="conversation-share-success-actions" className={"grid grid-cols-2 gap-2"}>
        <Button
          type="button"
          size="lg"
          variant="outline"
          className={"h-10 min-w-0"}
          data-testid="conversation-share-open-browser"
          onClick={onOpen}
        >
          <ExternalLink aria-hidden="true" />
          <span className="truncate">
            {intl.formatMessage({ id: "conversationShare.result.openInBrowser" })}
          </span>
        </Button>
        <Button
          type="button"
          size="lg"
          className={"h-10 min-w-0"}
          data-testid="conversation-share-copy-link"
          onClick={() => {
            void Promise.resolve(onCopy())
              .then((success) => {
                if (success) setCopied(true);
              })
              .catch(() => setCopied(false));
          }}
        >
          <Copy aria-hidden="true" />
          <span className="truncate">
            {intl.formatMessage({
              id: copied ? "conversationShare.copySucceeded" : "conversationShare.copyLink",
            })}
          </span>
        </Button>
      </div>
    </section>
  );
}
