// INV-01 目录项统一收敛为 DirectoryItem（RunningSubagentSummary 与 ZCodeSessionEndedSubagent 的联合）；守住它：第 28 行的类型别名。新增字段若只加在单侧，StatusIcon 与 DirectoryRow 的分支会读到 undefined。
// INV-02 打开请求只替换 childSessionId/subagentType/title，其余维度全部继承 tab；守住它：buildSubagentDirectoryOpenRequest 的返回对象。漏传 rootSessionId 或 parentSessionId 会让新标签找不到父会话。
// INV-03 [失败路径] workspaceIdentity 与 remoteSessionId 用条件展开而非固定键；守住它：buildSubagentDirectoryOpenRequest 与 scope 的两处展开。写成 undefined 键会让下游按字段存在性判远程，误判成本地会话。
// INV-04 StatusIcon 的 switch 覆盖 running/waiting/blocked/success/failed/cancelled/lost 七态且不留 default；守住它：StatusIcon。协议新增状态若不同步补分支，该行渲染空白图标，用户以为子代理已消失。
// INV-05 [权衡] DirectoryRow 用 memo 包裹，但父层 handleOpen 每次渲染新建，memo 的比较实际只在 onOpen 引用不变时命中；守住它：DirectoryRow 的 props 形状。缓存收益有限，勿据此删掉 memo 或改成内联箭头。
// INV-06 时间戳用 "endedAt" in item 判别联合后再取 endedAt 或 startedAt；守住它：DirectoryRow 的 timestamp 表达式。直取 startedAt 会让已结束项丢失结束时间，排序观感与真实生命周期不符。
// INV-07 SubagentDirectorySidePane 必须用 V4PaneConversationProvider 包住子内容；守住它：外层组件的 JSX 结构。内层 useV4Conversation 依赖该 Provider 提供 layer，拆掉即取到错误 pane 的会话层或直接抛错。
// INV-08 [并发] scope 的 useMemo 依赖必须含 remoteSessionId/workspaceIdentity/workspacePath 三项；守住它：scope 的依赖数组。漏项会让 Provider 复用上一个 workspace 的作用域，新 pane 读到旧会话快照。
// INV-09 [资源] 每个生效的 lease 都必须在 effect 清理函数里 release；守住它：acquire 所在 useEffect 的 return。漏释放会让侧栏关闭后引用与订阅常驻，长时间开关面板会累积句柄。
// INV-10 [并发] parentSessionId 变化时先释放旧 lease 再获取新 lease；守住它：该 effect 的依赖数组与清理顺序。顺序颠倒会让两个 lease 同时有效，快照在父子会话间串台。
// INV-11 useSessionSubagents 的 enabled 必须等到 projection.snapshot 非空；守住它：enabled 表达式。提前放行会在 lease 未就绪时发出 ended 查询，拿到空列表或别的工作区数据。
// INV-12 refreshKey 绑定 subagents?.revision，缺省 0；守住它：useSessionSubagents 的 refreshKey 入参。去掉它，子代理结束触发的快照变更不会带动已结束分页刷新。
// INV-13 running 回落常量 EMPTY_RUNNING，而不是每次写空数组；守住它：模块级 EMPTY_RUNNING 与 running 的取值。现造空数组会让空态下的派生比较次次不等，重复渲染。
// INV-14 [权衡] 已结束计数用快照的 endedTotal，而非 directory.ended.items.length；守住它：标题处的 endedTotal。分页只加载首页时用 items 长度会把总数显示成已加载条数。
// INV-15 [失败路径] directory.error 只渲染固定文案 loadFailed，不透出原始错误；守住它：error 分支的提示节点。暴露原文会把远端地址与路径细节带到界面，也破坏文案一致性。
// INV-16 [事务] 加载更多仅在 nextCursor 存在时出现，且 loading 期间 disabled；守住它：下一页按钮的渲染条件与 disabled。去掉任一条件会重复追加同一页或并发翻页。
// INV-17 [事务] 打开动作只能经 handleOpen 组装请求后交给回调，侧栏不直接改 tab 或路由；守住它：handleOpen 的唯一出口。侧栏是展示投影，自写导航会产生两份打开路径。
// INV-18 行 key 用 childSessionId；守住它：两处 DirectoryRow 的 key。换成下标后，running 项转入 ended 时行实例被复用，图标与标题短暂错位。
//
// 模块职责：子代理目录侧栏——把当前会话下的运行中与已结束子代理汇成两段列表，并把点击转成一次带作用域的子会话打开请求。
// 状态所有权：会话快照与 lease 归 V4 会话层，已结束分页归 useSessionSubagents，本组件只持局部 lease 句柄与派生的展示值。
// 阅读顺序：buildSubagentDirectoryOpenRequest → StatusIcon/DirectoryRow → 外层 scope → 内层 lease 与目录查询 → running/ended/error 三段渲染。
import { memo, useEffect, useMemo, useState } from "react";
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  BanIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PauseCircleIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSessionSubagents } from "@/hooks/useSessionSubagents.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenScopedSubagentSideTabRequest,
  SubagentDirectorySidePaneTab,
} from "@/lib/workspaceSidePane.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";
import {
  V4PaneConversationProvider,
  useV4Conversation,
} from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";

type DirectoryItem = RunningSubagentSummary | ZCodeSessionEndedSubagent;

const EMPTY_RUNNING: readonly RunningSubagentSummary[] = [];

// 纯函数：把侧栏 tab 的既有作用域与目录项的 childSessionId/subagentType/title 合并成一个打开请求。
// [事务] 请求是「打开即定位」的唯一凭据：childSessionId 一旦与 tab.parentSessionId 不匹配，目标 pane 会落到别的父会话下。
// workspaceIdentity 与 remoteSessionId 刻意不覆盖，只沿用 tab；目录项里没有身份字段，若在这里补默认值就等于替调用方决定本地/远程。
// [失败路径] 缺字段时返回的对象仍要结构完整，下游按可选键判分支；若删掉某个键，打开会被当成不带作用域的普通会话。
// title 只用于标签展示，不参与定位；改错只会显示错名字，但会让用户以为打开了另一份会话。
export function buildSubagentDirectoryOpenRequest(
  tab: SubagentDirectorySidePaneTab,
  item: DirectoryItem,
): OpenScopedSubagentSideTabRequest {
  return {
    workspacePath: tab.workspacePath,
    ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    rootSessionId: tab.rootSessionId,
    parentSessionId: tab.parentSessionId,
    childSessionId: item.childSessionId,
    subagentType: item.subagentType,
    title: item.title,
  };
}

function StatusIcon({ status }: { status: DirectoryItem["status"] }) {
  const className = "size-4 shrink-0";
  // 七态穷举，无 default：返回值类型由 DirectoryItem 的 status 联合收窄，漏一个分支 TypeScript 会报缺少返回值。
  // running 用旋转图标，waiting 与 blocked 共用暂停图标——两者对用户都是「没在跑但没结束」。
  // success/failed/cancelled/lost 各自独立图标，不要合并成「非成功」：取消与丢失的处理动作不同。
  // 图标统一 aria-hidden，语义由行内状态文案承担，避免读屏重复播报状态。
  switch (status) {
    case "running":
      return <LoaderCircleIcon aria-hidden className={`${className} animate-spin`} />;
    case "waiting":
    case "blocked":
      return <PauseCircleIcon aria-hidden className={className} />;
    case "success":
      return <CheckCircle2Icon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "cancelled":
      return <BanIcon aria-hidden className={className} />;
    case "lost":
      return <CircleDashedIcon aria-hidden className={className} />;
  }
}

const DirectoryRow = memo(function DirectoryRow({
  item,
  onOpen,
}: {
  item: DirectoryItem;
  onOpen: (item: DirectoryItem) => void;
}) {
  const { intl } = useZCodeIntl();
  // 用 in 判别联合成员，而不是给两个接口都补可选字段；endedAt 只存在于 ZCodeSessionEndedSubagent。
  // 运行中项退回 startedAt：侧栏展示的是「这个子代理多久以前开始或结束」，两者语义一致。
  // [权衡] 时间格式化交给 formatTaskRelativeTime，本组件不做日期计算，避免与任务列表的相对时间口径分叉。
  // summary 与 timestamp 都可选，缺失时渲染 null 而不是空字符串，否则 flex 布局会多出无内容的间隙。
  // 整行是 button，onClick 直接回传 item；键盘可达性由原生 button 保证，不要改成 div 加 role。
  const timestamp = "endedAt" in item ? item.endedAt : item.startedAt;
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-left text-ui-base transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
      onClick={() => onOpen(item)}
    >
      <span className="mt-0.5 text-foreground-subtle">
        <StatusIcon status={item.status} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate font-medium text-foreground">{item.title}</span>
          <span className="shrink-0 text-ui-sm text-foreground-subtlest">
            {intl.formatMessage({ id: `subagentDirectory.status.${item.status}` })}
          </span>
        </span>
        {item.summary ? (
          <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
            {item.summary}
          </span>
        ) : null}
      </span>
      {timestamp ? (
        <span className="shrink-0 text-ui-sm text-foreground-subtlest">
          {formatTaskRelativeTime(timestamp, intl)}
        </span>
      ) : null}
    </button>
  );
});

export const SubagentDirectorySidePane = memo(function SubagentDirectorySidePane({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  // 把 tab 的三个作用域字段投影成 PaneWorkspaceScope，键名与请求体保持一致，避免两处拼装规则漂移。
  // [并发] useMemo 只为稳定引用，不是缓存计算：scope 变化时 Provider 会重建会话层，依赖漏项等于让新 workspace 沿用旧层。
  // 条件展开保留「未提供」与「提供空串」的区别；统一成空串会让远端身份判断从缺失变成空值。
  // [权衡] 不在这里做 trim 或路径规范化，规范化属于上层；此处改写会让同一路径出现两种 scope 引用。
  const scope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
      ...(tab.remoteSessionId ? { remoteSessionId: tab.remoteSessionId } : {}),
    }),
    [tab.remoteSessionId, tab.workspaceIdentity, tab.workspacePath],
  );
  return (
    <V4PaneConversationProvider scope={scope}>
      <SubagentDirectoryContents
        tab={tab}
        onOpenSubagentSession={onOpenSubagentSession}
      />
    </V4PaneConversationProvider>
  );
});

const SubagentDirectoryContents = memo(function SubagentDirectoryContents({
  tab,
  onOpenSubagentSession,
}: {
  tab: SubagentDirectorySidePaneTab;
  onOpenSubagentSession: (request: OpenScopedSubagentSideTabRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  const projection = useConversationProjection(lease);
  const subagents = projection.snapshot?.subagents;
  useEffect(() => {
    // [资源] lease 是本 pane 对父会话的读租约：acquire 之后才允许 projection 订阅，release 必须与它成对。
    // [并发] effect 依赖 layer 与 tab.parentSessionId；两者任一变化都要先走清理函数释放旧租约，再申请新的。
    // setLease 触发一次额外渲染，projection 在 lease 到位前保持空快照——这是刻意的两段式，不要在渲染期直接取租约。
    // [失败路径] 清理时释放的是闭包捕获的 nextLease 而非 state 里的 lease；用 state 会在快速切换会话时释放错对象。
    // 父会话 id 变更时旧订阅先退订，避免旧快照的回调写进新 pane。
    // 不要给 acquire 结果加全局缓存：每个 pane 有自己的生命周期，共享租约会让任一面板卸载就切断他人的订阅。
    const nextLease = layer.acquire(tab.parentSessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, tab.parentSessionId]);
  // 已结束子代理的分页数据源：查询条件与 scope 同源，sessionId 固定为 tab.parentSessionId。
  // [并发] enabled 等待 projection.snapshot 非空，保证租约已生效；提前查询会以错身份命中别的工作区。
  // refreshKey 取快照的 revision，子代理状态推进时驱动已结束列表重取，而不是靠定时轮询。
  // [权衡] running 列表直接来自快照，ended 列表才走分页接口：前者要求实时，后者允许按需加载。
  // running 缺省复用 EMPTY_RUNNING，endedTotal 缺省为 0；两个默认值都表示「快照尚未到达」，不是「确实没有子代理」。
  // handleOpen 只做请求组装后转交回调，本组件不持有打开后的状态，也不写任何 store。
  // [失败路径] 目录查询失败由 directory.error 统一呈现，running 段不因此清空——两段数据源独立，一段失败不该抹掉另一段。
  const directory = useSessionSubagents({
    enabled: projection.snapshot !== null,
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    remoteSessionId: tab.remoteSessionId,
    sessionId: tab.parentSessionId,
    refreshKey: subagents?.revision ?? 0,
  });
  const running = subagents?.running ?? EMPTY_RUNNING;
  const endedTotal = subagents?.endedTotal ?? 0;
  const handleOpen = (item: DirectoryItem) => {
    onOpenSubagentSession(buildSubagentDirectoryOpenRequest(tab, item));
  };

  return (
    <div className="flex size-full min-h-0 flex-col bg-background">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "subagentDirectory.title" })}
        </h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        <section>
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.running" })} · {running.length}
          </h3>
          {running.length > 0 ? (
            running.map((item) => (
              <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
            ))
          ) : (
            <p className="px-3 py-3 text-ui-base text-foreground-subtlest">
              {intl.formatMessage({ id: "subagentDirectory.runningEmpty" })}
            </p>
          )}
        </section>

        <section className="mt-5">
          <h3 className="px-3 pb-1.5 text-ui-sm font-medium text-foreground-subtlest">
            {intl.formatMessage({ id: "subagentDirectory.ended" })} · {endedTotal}
          </h3>
          {directory.ended.items.map((item) => (
            <DirectoryRow key={item.childSessionId} item={item} onOpen={handleOpen} />
          ))}
          {directory.ended.nextCursor ? (
            <div className="px-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={directory.loading}
                onClick={() => void directory.loadMore()}
              >
                {intl.formatMessage({ id: "subagentDirectory.showMore" })}
              </Button>
            </div>
          ) : null}
        </section>

        {directory.error ? (
          <p role="alert" className="mx-3 mt-4 text-ui-sm text-[var(--color-danger)]">
            {intl.formatMessage({ id: "subagentDirectory.loadFailed" })}
          </p>
        ) : null}
      </div>
    </div>
  );
});
