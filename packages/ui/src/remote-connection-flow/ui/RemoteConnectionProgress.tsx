// INV-01 进度通道只读：守住位置 ProgressContext；改错故障 消费方直接改状态。
// INV-02 发布通道独立：守住位置 PublishProgressContext；改错故障 发布方订阅自身结果。
// INV-03 发布命令必须稳定：守住位置 useState 返回；改错故障 每次渲染触发新订阅。
// INV-04 卸载清空进度：守住位置 清理 effect；改错故障 离开页面后残留旧日志。
// INV-05 阶段由日志推导：守住位置 resolveRemoteConnectionPhases；改错故障 进度与真实状态脱节。
// INV-06 活动阶段优先失败态：守住位置 active 查找；改错故障 失败被进行中掩盖。
// INV-07 无活动阶段取首段：守住位置 空值兜底；改错故障 标题访问空对象。
// INV-08 百分比按完成段数：守住位置 percent 计算；改错故障 进度长期停在零。
// INV-09 百分比取整：守住位置 取整函数；改错故障 展示长小数。
// INV-10 设备名可空：守住位置 device 回退；改错故障 字符串 undefined 透出。
// INV-11 目标格式化集中：守住位置 formatRemoteLinkRailTarget；改错故障 展示格式分叉。
// INV-12 进行中需三重条件：守住位置 progressing；改错故障 已取消仍转圈。
// INV-13 标题按优先级选择：守住位置 嵌套三元；改错故障 错误态显示连接中。
// INV-14 副标题回退当前阶段：守住位置 兜底文案；改错故障 副标题为空。
// INV-15 进度条带无障碍属性：守住位置 role 与 aria 值；改错故障 读屏无法感知进度。
// INV-16 取消与继续分开：守住位置 两个按钮；改错故障 误触直接中断连接。
// INV-17 最小化卡不发起连接：守住位置 组件职责；改错故障 渲染即触发副作用。
// INV-18 文案全部国际化：守住位置 formatMessage；改错故障 中文硬编码透出。
//
// 模块职责：提供连接进度的发布与订阅，并渲染最小化的进度卡。
// 状态所有权：进度值归 Provider；展示组件全部由 props 驱动。
// 阅读顺序：先看两个上下文，再看阶段与百分比计算，最后看卡片渲染。
import type { RemoteConnectionProgress } from "@/remote-connection-flow/contract.js";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { AlertTriangleIcon, LoaderIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { resolveRemoteConnectionPhases } from "@/remote-connection/RemoteConnectionConnectingStep.js";
import { formatRemoteLinkRailTarget } from "@/remote-connection/RemoteLinkRail.js";
import { cn } from "@/components/lib/utils.js";

// ProgressContext 只暴露进度值，消费方拿不到 setter。
// createContext(null) 表示尚未有 Provider 发布进度。
// PublishProgressContext 与 ProgressContext 分离，避免订阅自身结果。
const ProgressContext = createContext<RemoteConnectionProgress | null>(null);
const PublishProgressContext = createContext<
  ((progress: RemoteConnectionProgress | null) => void) | null
>(null);

export function RemoteConnectionProgressProvider({ children }: { children: ReactNode }) {
  // Provider 把 useState 的 publish 单独下发，引用跨渲染稳定。
  // progress 值只经 ProgressContext 给子组件，不回到发布方。
  // 清理 effect 调 publish(null)，卸载后不残留旧日志。
  const [progress, publish] = useState<RemoteConnectionProgress | null>(null);
  // 发布方只订阅稳定的命令，不能订阅自己的显示结果；否则新日志引用会形成 render/effect 回环。
  return (
    <PublishProgressContext value={publish}>
      <ProgressContext value={progress}>{children}</ProgressContext>
    </PublishProgressContext>
  );
}
export function useRemoteConnectionProgress() {
  return useContext(ProgressContext);
}
export function usePublishRemoteConnectionProgress(progress: RemoteConnectionProgress | null) {
  // useContext(PublishProgressContext) 为 null 时 publish?.() 不执行。
  // useEffect 依赖 [publish, progress]，日志更新即重发。
  // 第二个 useEffect 只依赖 publish，返回清空函数。
  const publish = useContext(PublishProgressContext);
  useEffect(() => {
    publish?.(progress);
  }, [publish, progress]);
  useEffect(() => () => publish?.(null), [publish]);
}

export function RemoteConnectionMinimizedProgress({
  view,
  cancelled,
  target,
  name,
  logs,
  error,
  reason,
  waiting,
  onResume,
  onCancel,
  ready,
}: RemoteConnectionProgress) {
  const { intl } = useZCodeIntl();
  // resolveRemoteConnectionPhases(logs) 是唯一的阶段来源。
  // find 同时匹配 active 与 failed，失败不会被进行中掩盖。
  // phases[0] 兜底保证 active 不为 undefined。
  const phases = resolveRemoteConnectionPhases(logs);
  const active =
    phases.find((phase) => phase.status === "active" || phase.status === "failed") ?? phases[0]!;
  // percent 用 filter(status === "complete").length 除以 phases.length。
  // Math.round 包住百分比，展示层不再二次取整。
  // 进度条只在 progressing 为真时渲染。
  const percent = Math.round(
    (phases.filter((phase) => phase.status === "complete").length / phases.length) * 100,
  );
  const device = name ?? (target ? formatRemoteLinkRailTarget(target) : "");
  const progressing = view === "connecting" && !cancelled && !ready;
  // title 的三元链第一层判 ready，再判 error。
  // cancelled 分支排在 progressing 之前，取消后不再显示连接中。
  // remote.minimized.${view} 是 title 的末级回退。
  const title = intl.formatMessage(
    {
      id: ready
        ? "remote.background.ready"
        : error
          ? "remote.minimized.failed"
          : cancelled
            ? "remote.connectionCancelled"
            : progressing
              ? "remote.minimized.connecting"
              : `remote.minimized.${view}`,
    },
    { device },
  );
  return (
    <div data-background-connection className="px-4 pb-3">
      <button
        type="button"
        data-testid="remote-connection-minimized"
        onClick={onResume}
        className={cn(
          "my-2 w-full rounded-lg border border-border p-2 text-left",
          error
            ? "bg-destructive-surface text-destructive-surface-foreground"
            : progressing
              ? "bg-progress-surface text-progress-surface-foreground"
              : "bg-surface text-foreground",
        )}
      >
        <span className="flex items-center gap-2 text-ui-sm font-medium">
          {error ? (
            <AlertTriangleIcon className="size-3.5 shrink-0" />
          ) : progressing ? (
            <LoaderIcon className="size-3.5 shrink-0 animate-spin" />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {!error && progressing ? <span>{percent}%</span> : null}
        </span>
        <span className="mt-1 block break-words text-ui-xs">
          {(error ? `${error} · ${reason}` : "") ||
            intl.formatMessage({
              id: !progressing
                ? "remote.minimized.resume"
                : waiting
                  ? "remote.minimized.waiting"
                  : active.titleId,
            })}
        </span>
        {!error && progressing ? (
          <span
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="mt-2 block h-1 overflow-hidden rounded-full bg-border"
          >
            <span
              className="block h-full bg-progress-surface-foreground"
              style={{ width: `${percent}%` }}
            />
          </span>
        ) : null}
        <span className="mt-1 block text-ui-sm underline">
          {intl.formatMessage({
            id: ready ? "remote.background.continue" : "remote.background.review",
          })}
        </span>
      </button>
      <button
        type="button"
        onClick={onCancel}
        className="text-ui-sm text-foreground-subtle hover:text-foreground underline"
      >
        {intl.formatMessage({ id: ready ? "common.close" : "remote.background.cancel" })}
      </button>
    </div>
  );
}
