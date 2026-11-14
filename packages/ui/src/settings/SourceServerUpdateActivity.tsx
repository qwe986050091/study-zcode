// INV-01 阶段文案穷举：守住位置 映射函数；改错故障 未知阶段显示空白。
// INV-02 探测与预检同文案：守住位置 合并判断；改错故障 同阶段两种说法。
// INV-03 未知阶段回退准备中：守住位置 末尾默认；改错故障 显示未定义。
// INV-04 进度百分比取整：守住位置 四舍五入；改错故障 出现超长小数。
// INV-05 无进度不显示百分比：守住位置 空值判断；改错故障 显示非法数值。
// INV-06 数字格式按语言：守住位置 记忆化格式器；改错故障 千分位与语言不符。
// INV-07 进度条语义随状态切换：守住位置 展开属性；改错故障 读屏读到三个百分数。
// INV-08 无进度且活动时脉冲：守住位置 条件类名；改错故障 卡住时无反馈。
// INV-09 日志展开初值随活动：守住位置 初始化；改错故障 进行中默认收起。
// INV-10 活动且有日志自动展开：守住位置 副作用；改错故障 新日志被折叠隐藏。
// INV-11 展开可手动切换：守住位置 点击处理；改错故障 用户无法收起日志。
// INV-12 最近日志与更新日志文案区分：守住位置 条件文案；改错故障 两处标题相同。
// INV-13 时间戳按语言格式化：守住位置 格式化调用；改错故障 十二小时制混入。
// INV-14 错误与警告分级着色：守住位置 类名判断；改错故障 错误日志与普通行同色。
// INV-15 空日志显示等待：守住位置 空数组分支；改错故障 日志区完全空白。
// INV-16 日志行键含时间与阶段：守住位置 键拼接；改错故障 同毫秒日志渲染错位。
// INV-17 展开状态由调用方持有：守住位置 受控组件；改错故障 两个实例互相影响。
// INV-18 进度容器不撑破布局：守住位置 高度类；改错故障 日志变长挤变形。
//
// 模块职责：来源服务器更新的阶段进度与操作日志展示。
// 状态所有权：日志由调用方传入，展开状态归本组件。
// 阅读顺序：先看阶段映射，再看活动组件，最后看日志列表。
import { useEffect, useMemo, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { SourceServerOperationLog } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

// phase 为 probe 或 preflight 时共用 checking 文案。
// download 与 upload 分别映射 downloading 与 uploading。
// extract 与 verify-archive 分属解压、校验两步。
// restart 走 restarting，daemon 合到 reconnecting。
// 其余未知 phase 回退 preparing。
function resolveUpdatePhaseMessageId(phase: string): string {
  if (phase === "probe" || phase === "preflight") {
    return "settings.source.updatePhase.checking";
  }
  if (phase === "download") return "settings.source.updatePhase.downloading";
  if (phase === "upload") return "settings.source.updatePhase.uploading";
  if (phase === "extract") return "remote.phaseSub.extracting";
  if (phase === "verify-archive") return "remote.phaseSub.verifyingArchive";
  if (phase === "verify") return "remote.phaseSub.verifyingFiles";
  if (phase === "restart") return "remote.phaseSub.restarting";
  if (phase === "install") return "settings.source.updatePhase.installing";
  if (phase === "daemon" || phase === "protocol-handshake") {
    return "settings.source.updatePhase.reconnecting";
  }
  if (phase === "ready") return "settings.source.updatePhase.completed";
  return "settings.source.updatePhase.preparing";
}

// expanded 初值取 active，进行中默认展开。
// 进度百分比取 logs.at(-1) 的 progress。
// numberFormatter 用 Intl.NumberFormat 按 locale 构造。
// latestProgress 为 undefined 时不渲染数值。
// active 且有日志时 useEffect 把 expanded 置真。
// 点击 Button 时 setExpanded 取反，用户可手动收起。
export function SourceServerUpdateActivity({
  active,
  logs,
  recent = false,
}: {
  active: boolean;
  recent?: boolean;
  logs: readonly SourceServerOperationLog[];
}) {
  const { intl, locale } = useZCodeIntl();
  const [expanded, setExpanded] = useState(active);
  // latest 取 logs.at(-1)，空数组得到 undefined。
  // latestProgress 可能缺席，undefined 表示暂无进度。
  // progressPercent 用 Math.round 取整到整数百分比。
  // undefined 不进入 numberFormatter.format 调用。
  // 只读最新一条，历史日志不参与进度计算。
  const latest = logs.at(-1);
  const latestProgress = latest?.progress;
  const progressPercent =
    latestProgress === undefined ? undefined : Math.round(latestProgress * 100);
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
    [locale],
  );

  useEffect(() => {
    if (active && logs.length > 0) setExpanded(true);
  }, [active, logs.length]);

  return (
    <div className="basis-full space-y-2 border-t border-border pt-2">
      {!recent ? (
        <>
          <div className="flex min-w-0 items-center gap-2 text-ui-xs">
            {active ? (
              <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
            ) : null}
            <span className="min-w-0 flex-1 font-medium">
              {intl.formatMessage({
                id: resolveUpdatePhaseMessageId(latest?.phase ?? "update"),
              })}
            </span>
            {progressPercent !== undefined ? (
              <span className="shrink-0 tabular-nums">
                {numberFormatter.format(progressPercent)}%
              </span>
            ) : null}
          </div>
          <div
            role="progressbar"
            aria-label={intl.formatMessage({ id: "settings.source.updateProgress" })}
            aria-valuemin={0}
            aria-valuemax={100}
            {...(progressPercent === undefined
              ? { "aria-busy": active }
              : { "aria-valuenow": progressPercent })}
            className="h-1 overflow-hidden rounded-full bg-surface"
          >
            <span
              className={cn(
                "block h-full rounded-full bg-progress-surface-foreground",
                progressPercent === undefined && active && "w-1/2 animate-pulse",
              )}
              style={progressPercent === undefined ? undefined : { width: `${progressPercent}%` }}
            />
          </div>
        </>
      ) : null}
      <Button
        data-source-server-log-toggle
        type="button"
        variant="ghost"
        size="xs"
        className="h-6 px-0 text-current hover:bg-transparent"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} />
        {intl.formatMessage(
          { id: recent ? "settings.source.recentLog" : "settings.source.updateLog" },
          { count: logs.length },
        )}
      </Button>
      {expanded ? <SourceServerLogList logs={logs} /> : null}
    </div>
  );
}

/** 最近日志列表；设备卡页脚与更新进度共用，展开状态由调用方持有。 */
// logs.length 为 0 时渲染 updateLogWaiting 文案。
// timestamp 经 toLocaleTimeString 按 locale 格式化，hour12 关闭。
// entry.level 为 error 或 warn 时套对应文字色。
// key 用 timestamp 加 phase 加 index 拼接，同毫秒不撞键。
// 容器用 max-h-36 与 overflow-y-auto 限高滚动。
export function SourceServerLogList({ logs }: { logs: readonly SourceServerOperationLog[] }) {
  const { intl, locale } = useZCodeIntl();
  return (
    <div
      data-source-server-log
      className="max-h-36 space-y-1 overflow-y-auto rounded-lg bg-surface px-3 py-2 font-mono text-ui-xs leading-5 text-foreground-subtle"
    >
      {logs.length > 0 ? (
        logs.map((entry, index) => (
          <div
            key={`${entry.timestamp}-${entry.phase}-${index}`}
            className={cn(
              "flex min-w-0 gap-2",
              entry.level === "error" && "text-destructive",
              entry.level === "warn" && "text-warning",
            )}
          >
            <span
              data-source-server-log-timestamp
              className="shrink-0 text-remote-foreground-muted"
            >
              {new Date(entry.timestamp).toLocaleTimeString(locale, {
                hour12: false,
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}
            </span>
            <span className="min-w-0 break-words">{entry.message}</span>
          </div>
        ))
      ) : (
        <p>{intl.formatMessage({ id: "settings.source.updateLogWaiting" })}</p>
      )}
    </div>
  );
}
