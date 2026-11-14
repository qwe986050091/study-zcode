// INV-01 单次订阅：守住位置 Provider 内的任务 hook 调用；改错故障：每条历史回复各自请求全量群状态。
// INV-02 上下文稳定：守住位置 value 的 useMemo；改错故障：每次渲染新建对象导致整棵子树更新。
// INV-03 成员名独立：守住位置 成员名 hook 的订阅点；改错故障：改名触发任务状态重算。
// INV-04 只展示关联投递：守住位置 unresolved 的命令关联过滤；改错故障：无关投递在操作栏出现。
// INV-05 未解决限定：守住位置 状态过滤；改错故障：成功投递也显示警告图标。
// INV-06 空态不渲染：守住位置 长度判断后的早退；改错故障：空图标常驻操作栏。
// INV-07 未知优先：守住位置 标签取文案的三元判断；改错故障：同时存在未知与失败时提示成失败。
// INV-08 标签同源：守住位置 aria-label 与 title 共用同一字符串；改错故障：读屏与悬浮提示不一致。
// INV-09 禁用按条目：守住位置 busyId 与投递 id 的比较；改错故障：一个投递处理中，其它投递也被禁用。
// INV-10 未知给双选：守住位置 unknown 分支的两个确认按钮；改错故障：未知状态只剩重发，无法声明已收到。
// INV-11 失败给重发：守住位置 failed 分支的重试按钮；改错故障：失败投递没有恢复入口。
// INV-12 同步门控：守住位置 syncing 条件；改错故障：任务未激活时仍可操作投递。
// INV-13 序号仅多条目：守住位置 长度大于一的判断；改错故障：单条投递也显示 1/1。
// INV-14 回调不吞错：守住位置 Connected 版对返回值的 void 处理；改错故障：未处理拒绝在控制台报错。
// INV-15 无群组不渲染：守住位置 group 判断；改错故障：未启用群组仍显示投递图标。
// INV-16 列表同源：守住位置 投递过滤使用的任务标识；改错故障：上下文与列表来自不同任务。
// INV-17 气泡不溢出：守住位置 最大宽度；改错故障：窄屏下气泡超出视口。
// INV-18 文案全走字典：守住位置 所有 formatMessage；改错故障：界面出现硬编码语言。
//
// 模块职责：聚合群投递状态并在轮次操作栏提供失败重发与未知确认入口。
// 状态所有权：投递数据归群任务 hook；本文件只派生未解决列表与展示标签。
// 阅读顺序：上下文 Provider → 动作栏主体 → 未解决过滤 → 气泡操作 → 连接版包装。
import { DeliveryContext } from "@/v4/botGroupDeliveryContext.js";
import { useContext, useMemo, type ReactNode } from "react";
import { CircleAlertIcon } from "lucide-react";
import type { BotGroupDelivery } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useBotGroupTask } from "@/hooks/useBotGroupTask.js";

import { useBotGroupMemberNames } from "@/hooks/useBotGroupMemberNames.js";
import { BotGroupMemberNamesContext } from "@/v4/BotGroupMemberNamesContext.js";

// Provider 把群任务状态与成员名合并成一份交付上下文。
// 值对象用 memo 固定，避免子树因每次渲染的新对象而更新。
//
export function BotGroupDeliveryProvider({
  taskId,
  workspacePath,
  workspaceIdentity,
  children,
}: {
  taskId: string | null;
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}) {
  // 同一任务只订阅一次群状态，历史回复不各自请求全量 Bot 状态。
  const { context, provider, busyId, retry, reconcile, retryPreparation } = useBotGroupTask(
    taskId,
    workspacePath,
    workspaceIdentity,
  );
  // 成员名单独订阅：名称变化只影响展示，不触发任务状态重算。
  // 上下文为空时 hook 返回空映射，组件照常渲染。
  // 成员名只用于展示，不参与投递状态判定。
  //
  const memberNames = useBotGroupMemberNames(context);
  const value = useMemo(
    () => ({
      context,
      provider,
      busyId,
      retry,
      reconcile,
      retryPreparation,
      taskId,
    }),
    [context, provider, busyId, retry, reconcile, retryPreparation, taskId],
  );
  return (
    <DeliveryContext.Provider value={value}>
      <BotGroupMemberNamesContext.Provider value={memberNames}>
        {children}
      </BotGroupMemberNamesContext.Provider>
    </DeliveryContext.Provider>
  );
}

// 动作栏只展示未解决投递，重试与确认全部通过回调上抛。
// 入参分别承载数据、禁用标识与交互，组件自身不持有状态。
// 轮次标识只用于挂测试锚点，不参与数据筛选。
//
export function BotGroupDeliveryAction({
  turnId,
  sourceCommandIds,
  syncing,
  results,
  busyId,
  onRetry,
  onReconcile,
}: {
  turnId: string;
  sourceCommandIds: readonly string[];
  syncing: boolean;
  results: BotGroupDelivery[];
  busyId?: string | null;
  onRetry: (id: string) => void;
  onReconcile: (id: string, received: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  // Bug 原因：任务级恢复面板与队列浮层重叠，还重复展示正文；只在已关联轮次的操作栏展示。
  // 只保留与当前轮次关联且失败或未知的投递，其余状态不打扰用户。
  // 命令标识为空表示没有关联命令，直接排除。
  // 过滤保持原始投递顺序，不做额外排序。
  //
  const unresolved = results.filter(
    (result) =>
      result.sourceCommandId &&
      sourceCommandIds.includes(result.sourceCommandId) &&
      (result.status === "failed" || result.status === "unknown"),
  );
  // 没有未解决投递时整块不渲染，避免空图标常驻。
  // 早退发生在取文案之前，空态不产生多余的翻译调用。
  //
  if (!unresolved.length) return null;
  // 整体标签按是否存在未知状态取文案，未知优先于失败。
  // 标签同时用于无障碍名与悬浮提示，两处保持同一字符串。
  //
  const label = intl.formatMessage({
    id: unresolved.some((result) => result.status === "unknown")
      ? "bots.group.deliveryUnknown"
      : "bots.group.deliveryFailed",
  });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-warning"
          aria-label={label}
          title={label}
          data-bot-group-delivery={turnId}
        >
          <CircleAlertIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-w-[calc(100vw-2rem)] gap-2"
        data-bot-group-delivery-actions={turnId}
      >
        {unresolved.map((result, index) => (
          <div key={result.id} className="flex flex-col gap-1">
            <span className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({
                id:
                  result.status === "unknown"
                    ? "bots.group.deliveryUnknown"
                    : "bots.group.deliveryFailed",
              })}
              {unresolved.length > 1 ? ` (${index + 1}/${unresolved.length})` : null}
            </span>
            {syncing ? (
              <div className="flex flex-wrap gap-1">
                {result.status === "unknown" ? (
                  <>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busyId === result.id}
                      onClick={() => onReconcile(result.id, true)}
                    >
                      {intl.formatMessage({ id: "bots.group.confirmReceived" })}
                    </Button>
                    <Button
                      variant="ghost"
                      size="xs"
                      disabled={busyId === result.id}
                      onClick={() => onReconcile(result.id, false)}
                    >
                      {intl.formatMessage({ id: "bots.group.confirmNotReceived" })}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busyId === result.id}
                    onClick={() => onRetry(result.id)}
                  >
                    {intl.formatMessage({ id: "bots.group.resend" })}
                  </Button>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}

// 连接版从上下文取任务与投递，未启用群组时整块隐藏。
// 只在同步中展示操作按钮，避免对已收敛的投递重复操作。
//
export function ConnectedBotGroupDeliveryAction({
  turnId,
  sourceCommandIds,
}: {
  turnId: string;
  sourceCommandIds: readonly string[];
}) {
  // 上下文缺失或群组未启用时直接返回空，不做兜底请求。
  // 任务标识取自上下文快照，保证与投递列表同源。
  //
  const value = useContext(DeliveryContext);
  const context = value?.context;
  if (!value || !context?.group) return null;
  return (
    <BotGroupDeliveryAction
      turnId={turnId}
      sourceCommandIds={sourceCommandIds}
      syncing={context.group.enabled && context.activeTaskId === value.taskId}
      results={Object.values(context.group.deliveries ?? {}).filter(
        (result) => result.taskId === value.taskId,
      )}
      busyId={value.busyId}
      onRetry={(id) => {
        void value.retry(id);
      }}
      onReconcile={(id, received) => {
        void value.reconcile(id, received);
      }}
    />
  );
}
