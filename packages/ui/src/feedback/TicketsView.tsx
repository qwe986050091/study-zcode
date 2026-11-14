// 反馈工单列表视图：展示用户自己提交的反馈单，支持选中、复制单号与手动刷新
// 数据来自注入的 feedbackService，组件只持有展示投影，不承担服务端事实
// 列表为一次性拉取 50 条的快照模型，没有游标分页、筛选与排序入口
// 以下 INV 注释逐条固定状态机边界、失败语义与竞态处理，修改时同步核对
// INV-01 列表拉取是覆盖式快照而非合并；守住位置：loadList 的 setItems 分支；改错故障：刷新后残留已删除工单，用户看到幽灵条目
// INV-02 加载标志必须与请求成对复位；守住位置：loadList 的 finally；改错故障：请求抛错后刷新按钮永久禁用，用户无法重试
// INV-03 错误状态在每次拉取开始时先清空；守住位置：loadList 开头清空 error；改错故障：重试成功后旧错误提示仍挂在列表顶部
// INV-04 首屏骨架只在无数据且加载中显示；守住位置：分支 loadingList && items.length === 0；改错故障：已有数据被骨架替换，列表闪烁丢失上下文
// INV-05 空态判定必须同时满足非加载、零条目、无错误；守住位置：空态渲染条件；改错故障：拉取失败时显示暂无工单，掩盖真实故障
// INV-06 刷新时的转圈是页脚内联态，不替换列表；守住位置：分支 loadingList && items.length > 0；改错故障：刷新整页白屏，用户失去滚动位置
// INV-07 选中态由外部 store 单一持有，列表只读不写；守住位置：FeedbackTicketList 的 selected 计算；改错故障：列表自存选中副本，与详情面板不一致
// INV-08 复制反馈单号前需探测剪贴板能力；守住位置：handleCopyTicketId 的能力守卫；改错故障：非安全上下文点击无反应且无日志，问题不可诊断
// INV-09 复制成功提示固定 1600 毫秒后自动回退；守住位置：copiedResetTimerRef 的定时回调；改错故障：对勾常驻，用户无法判断是否复制过新单号
// INV-10 连续复制必须清除前一个定时器；守住位置：handleCopyTicketId 的清理分支；改错故障：快速连点后对勾提前消失，反馈与操作错位
// INV-11 定时器句柄在卸载时清理；守住位置：卸载 effect 的 cleanup；改错故障：切换页面后出现状态更新告警与控制台噪声
// INV-12 复制失败走 warn 日志而非用户弹窗；守住位置：writeText 的拒绝分支；改错故障：剪贴板权限被拒时弹窗打断，用户被迫确认
// INV-13 列表请求存在竞态窗口，后发结果未必最后到达；守住位置：loadList 的 setItems；改错故障：慢响应覆盖新响应，用户看到旧列表
// INV-14 依赖数组只含 feedbackService；守住位置：loadList 的依赖列表；改错故障：服务实例变化后仍用旧闭包，请求打到失效客户端
// INV-15 首次挂载即触发加载，不等待用户交互；守住位置：挂载 effect；改错故障：面板打开后空白，用户误以为没有历史工单
// INV-16 列表为空时列表组件渲染 null；守住位置：FeedbackTicketList 提前返回；改错故障：空态下方多出一条空卡片边框，布局错位
// INV-17 工单标识以 id 作为 key，避免重排时错用行状态；守住位置：items.map 的 key；改错故障：复制对勾跟随错误行，用户复制到别的单号
// INV-18 行布局在窄屏降级为单列堆叠；守住位置：列表行与表头的响应式类名；改错故障：手机端列挤压导致单号截断不可读
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CopyIcon, Inbox, Loader2, PlusCircle, RefreshCcw } from "lucide-react";
import type { FeedbackTicketSummary } from "@zcode/shared";
import type { IFeedbackService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { FeedbackErrorTip, StatusIndicator } from "@/feedback/feedbackBadges.js";
import { ScrollFadeViewport } from "@/components/ui/scroll-fade-viewport.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { formatRelativeTime } from "@/feedback/feedbackUserView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";

// 边界：本组件只接收 feedbackService 与 onCreateNew 两个注入依赖，不读路由与全局单例
// 权衡：服务由上层注入而非组件内构造，测试可替换实现，代价是调用方必须保证实例稳定
// 不变量：组件自身只保存列表、加载、错误、复制中单号四份投影状态
// 资源：四个 useState 与一个定时器引用构成该组件的全部生命周期资源
// 失败路径：反馈服务抛错时组件不崩溃，错误收敛到 error 字段并渲染提示条
// 并发：同一时刻可能有一次进行中的拉取，重复触发按后到者覆盖处理
// 不变量：创建入口 onCreateNew 为纯回调透传，组件不关心工单创建流程
export function TicketsView({
  feedbackService,
  onCreateNew,
}: {
  feedbackService: IFeedbackService;
  onCreateNew: () => void;
}) {
  const selectedTicketId = useFeedbackStore((state) => state.selectedTicketId);
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  const copiedResetTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [items, setItems] = useState<FeedbackTicketSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedTicketId, setCopiedTicketId] = useState<string | null>(null);

  // 分页：请求固定 mine 为真、limit 为 50，即只取本人最近 50 条，无游标翻页
  // 权衡：一次性取 50 条换取实现简单，超过上限的工单在列表不可见且无提示
  // 筛选：当前没有任何筛选或排序参数，服务端返回顺序即展示顺序
  // 不变量：进入请求前先置加载中并清空旧错误，保证重试路径从干净状态开始
  // 失败路径：捕获异常后只保留错误文案，不清空已有条目，避免刷新失败丢数据
  // 并发：本函数不取消在途请求，两个请求交错时以最后完成的响应覆盖当前列表
  // 资源：每次调用复用同一 feedbackService 引用，不创建新连接或新订阅
  // 不变量：加载标志在 finally 复位，成功与失败路径都会解除按钮禁用
  // 权衡：依赖仅 feedbackService，回调身份稳定，可安全作为其他 effect 的依赖
  const loadList = useCallback(async () => {
    setLoadingList(true);
    setError(null);
    try {
      const result = await feedbackService.list({ mine: true, limit: 50 });
      setItems(result.items);
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoadingList(false);
    }
  }, [feedbackService]);

  // 时序：挂载后立即发起首次拉取，依赖数组只跟随 loadList 的身份变化
  // 不变量：loadList 变化必然重新拉取，避免闭包持有过期的服务实例
  // 并发：开发期严格模式的双次挂载会产生两次请求，由覆盖语义吸收
  // 失败路径：拉取错误已在 loadList 内部收敛，本 effect 不再重复处理
  useEffect(() => {
    void loadList();
  }, [loadList]);

  // 资源：此 effect 只登记卸载清理函数，不产生额外渲染状态
  // 生命周期：卸载时清除复制提示定时器，防止延迟回调写入已卸载实例
  // 不变量：句柄为 null 表示当前没有挂起的定时器，清理前必须判空
  // 失败路径：缺少清理会让定时器在页面切换后仍持有闭包，形成短暂内存滞留
  // 权衡：仅在卸载时清理，重复复制的清理职责交给复制处理函数
  useEffect(() => {
    return () => {
      if (copiedResetTimerRef.current !== null) {
        globalThis.clearTimeout(copiedResetTimerRef.current);
      }
    };
  }, []);

  // 失败路径：剪贴板接口缺失时记录 warn 并直接返回，不进入复制中状态
  // 不变量：能力探测同时检查 navigator 存在性与 writeText 可调用性
  // 并发：写剪贴板为异步操作，期间再次点击会叠加多个待决 Promise
  // 资源：成功分支写入单号状态并登记 1600 毫秒复位定时器
  // 不变量：登记新定时器前先清除旧句柄，保证至多一个定时器生效
  // 失败路径：写入被拒时只记录原因，不改变对勾状态，用户可再次尝试
  // 日志：失败日志携带单号与原因字段，便于回溯剪贴板权限问题
  // 权衡：提示时长写死 1600 毫秒，不做可配置，避免增加额外偏好项
  const handleCopyTicketId = useCallback(
    (ticketId: string) => {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        logger.warn(formatMessage({ id: "feedback.detail.issueCopyFailed" }), {
          issueId: ticketId,
          reason: "clipboard-unavailable",
        });
        return;
      }

      void navigator.clipboard.writeText(ticketId).then(
        () => {
          setCopiedTicketId(ticketId);
          if (copiedResetTimerRef.current !== null) {
            globalThis.clearTimeout(copiedResetTimerRef.current);
          }
          copiedResetTimerRef.current = globalThis.setTimeout(() => {
            setCopiedTicketId(null);
            copiedResetTimerRef.current = null;
          }, 1600);
        },
        (copyError: unknown) => {
          logger.warn(formatMessage({ id: "feedback.detail.issueCopyFailed" }), {
            issueId: ticketId,
            error: copyError instanceof Error ? copyError.message : String(copyError),
          });
        },
      );
    },
    [formatMessage],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-popover">
      {loadingList && items.length === 0 ? (
        <TicketsInitialLoadingState />
      ) : (
        <ScrollFadeViewport className="px-6 pb-4 pt-3">
          {error && items.length === 0 ? (
            <div className="pb-2">
              <FeedbackErrorTip message={error} />
            </div>
          ) : null}
          {!loadingList && items.length === 0 && !error ? (
            <EmptyState onCreateNew={onCreateNew} />
          ) : null}
          <FeedbackTicketList
            items={items}
            selectedTicketId={selectedTicketId}
            copiedTicketId={copiedTicketId}
            onCopyTicketId={handleCopyTicketId}
          />
          {loadingList && items.length > 0 ? (
            <div className="flex items-center justify-center py-2 text-ui-xs text-foreground-subtle">
              <Loader2 className="mr-1.5 size-3 animate-spin" />
              {formatMessage({ id: "common.loading" })}
            </div>
          ) : null}
        </ScrollFadeViewport>
      )}
      <div className="flex shrink-0 items-center justify-between gap-2 px-6 pb-6 pt-2">
        <Button
          type="button"
          variant="ghost"
          size="icon-lg"
          onClick={() => void loadList()}
          disabled={loadingList}
          aria-label={formatMessage({ id: "common.refresh" })}
          className="rounded-xl text-foreground-subtle hover:text-foreground"
        >
          {loadingList ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCcw className="size-4" />
          )}
        </Button>
        <Button size="lg" onClick={onCreateNew} className="rounded-lg">
          <PlusCircle />
          {formatMessage({ id: "feedback.tickets.newFeedback" })}
        </Button>
      </div>
    </div>
  );
}

// 职责：独立导出首屏骨架组件，便于其他入口复用同一加载视觉
// 不变量：骨架只读国际化文案，不感知列表数据与服务状态
export function TicketsInitialLoadingState() {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 py-8 text-center text-ui-base text-foreground-subtle">
      <Loader2 className="size-4 animate-spin text-primary" />
      <span>{intl.formatMessage({ id: "common.loading" })}</span>
    </div>
  );
}

// 职责：纯展示组件，接收已选中的单号与复制中单号，不触达服务
// 不变量：选中与复制状态由父级持有，组件内不出现本地副本
// 权衡：三列网格在桌面清晰可扫，窄屏降级为堆叠以避免列宽挤压
export function FeedbackTicketList({
  items,
  selectedTicketId,
  copiedTicketId,
  onCopyTicketId,
}: {
  items: FeedbackTicketSummary[];
  selectedTicketId: string | null;
  copiedTicketId: string | null;
  onCopyTicketId: (ticketId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  // 不变量：零条目时不渲染外壳，避免空态下方出现多余边框
  // 失败路径：去掉提前返回会让表头与空列表容器同时出现，布局多出一层
  if (items.length === 0) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="hidden grid-cols-[7.5rem_minmax(0,1fr)_13rem] gap-3 border-b border-border px-3 py-2 text-ui-xs font-medium text-foreground-subtle md:grid">
        <span>{formatMessage({ id: "feedback.tickets.column.status" })}</span>
        <span>{formatMessage({ id: "feedback.tickets.column.description" })}</span>
        <span>{formatMessage({ id: "feedback.tickets.column.id" })}</span>
      </div>
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const selected = selectedTicketId === item.id;
          const copied = copiedTicketId === item.id;
          const copyLabel = formatMessage({
            id: copied ? "feedback.detail.issueCopied" : "feedback.detail.issueCopy",
          });
          return (
            <li
              key={item.id}
              className={cn(
                "grid gap-2 px-3 py-2.5 md:grid-cols-[7.5rem_minmax(0,1fr)_13rem] md:items-center md:gap-3",
                selected ? "bg-card-selected" : "bg-card",
              )}
            >
              <div className="flex min-w-0 items-center justify-between gap-2 md:block">
                <StatusIndicator status={item.status} />
                <span className="shrink-0 text-ui-xs text-foreground-subtle md:hidden">
                  {formatRelativeTime(item.created_at, formatMessage)}
                </span>
              </div>
              <div className="min-w-0">
                <div className="line-clamp-2 text-ui-base leading-5 text-foreground md:truncate">
                  {item.title}
                </div>
                <div className="mt-1 hidden text-ui-xs text-foreground-subtle md:block">
                  {formatRelativeTime(item.created_at, formatMessage)}
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-ui-xs text-foreground-subtle md:hidden">
                  {formatMessage({ id: "feedback.tickets.issuePrefix" })}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-ui-xs text-foreground">
                  {item.id}
                </span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={copyLabel}
                  title={copyLabel}
                  onClick={() => onCopyTicketId(item.id)}
                  className="shrink-0 text-foreground-subtle hover:text-foreground"
                >
                  {copied ? (
                    <Check className="size-3 text-success" />
                  ) : (
                    <CopyIcon className="size-3" />
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// 职责：空态只承担说明与创建引导，不包含刷新或筛选入口
// 权衡：创建按钮复用外部回调，空态自身不引入新的服务依赖
function EmptyState({ onCreateNew }: { onCreateNew: () => void }) {
  const { intl } = useZCodeIntl();
  const formatMessage = intl.formatMessage;
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 pt-12 text-center">
      <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-card">
        <Inbox className="size-4 text-foreground-subtle" />
      </div>
      <div className="text-ui-base font-medium text-foreground">
        {formatMessage({ id: "feedback.tickets.empty.title" })}
      </div>
      <p className="text-ui-base leading-5 text-foreground-subtle">
        {formatMessage({ id: "feedback.tickets.empty.description" })}
      </p>
      <Button size="sm" variant="outline" onClick={onCreateNew} className="mt-1 rounded-lg">
        <PlusCircle />
        {formatMessage({ id: "feedback.tickets.empty.action" })}
      </Button>
    </div>
  );
}
