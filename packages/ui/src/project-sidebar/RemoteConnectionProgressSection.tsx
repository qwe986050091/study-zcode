// INV-01 URL 直连不查来源域：守住位置 目标类型判断；改错故障 直连查不到阶段日志。
// INV-02 身份解析允许失败：守住位置 可选链；改错故障 脏身份串导致整块崩溃。
// INV-03 展示时钟不参与判定：守住位置 独立 hook；改错故障 展示刷新干扰超时逻辑。
// INV-04 卸载即停表：守住位置 清理函数；改错故障 详情关闭后仍每秒重渲染。
// INV-05 只有连接中才投影进度：守住位置 连接态判断；改错故障 已完成连接显示旧进度。
// INV-06 无来源域退回标题态：守住位置 标识判断；改错故障 直连显示空白进度条。
// INV-07 日志按资料标识隔离：守住位置 标识过滤；改错故障 多设备阶段互相串台。
// INV-08 进度解析统一入口：守住位置 解析函数；改错故障 两处算法漂移。
// INV-09 秒数下限为零：守住位置 最大值包裹；改错故障 时钟回拨出现负耗时。
// INV-10 一分钟内按秒展示：守住位置 阈值分支；改错故障 五十九秒显示成零分。
// INV-11 超过一分钟拆时分：守住位置 分钟换算；改错故障 长连接只显示总秒数。
// INV-12 恢复次数可缺省：守住位置 默认值；改错故障 未提供上限时不显示恢复提示。
// INV-13 分段状态三态：守住位置 下标比较；改错故障 当前段与已完成段同色。
// INV-14 百分比缺省用满格动画：守住位置 空值分支；改错故障 未知进度显示零宽条。
// INV-15 失败态才展示错误块：守住位置 状态判断；改错故障 离线时仍显示旧错误。
// INV-16 错误分类走共享规则：守住位置 分类函数；改错故障 文案与连接页不一致。
// INV-17 复制内容绑定原文：守住位置 已复制字符串；改错故障 新错误显示已复制。
// INV-18 复制失败提示原因：守住位置 捕获分支；改错故障 剪贴板失败无反馈。
//
// 模块职责：远程身份详情里的连接进度与失败原因展示。
// 状态所有权：阶段日志由连接管理服务提供，展示时钟与复制态归本组件。
// 阅读顺序：先看来源标识解析，再看进度投影，最后看失败态与复制。
import { useEffect, useState } from "react";
import { Check, Copy, LoaderCircle } from "lucide-react";
import { buildRemoteHostWorkspaceIdentity, parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type { RemoteProjectHost } from "@/project-sidebar/contract.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useRemoteDevicePresentationInput } from "@/hooks/useSourceServerStatuses.js";
import { useSourceServerOperationLogs } from "@/hooks/useSourceServerOperationLogs.js";
import {
  classifyRemoteConnectionError,
  type RemoteConnectionStatus,
} from "@/lib/remoteConnectionPresentation.js";
import { resolveRemoteOperationProgress } from "@/remote-connection/RemoteConnectionConnectingStep.js";

/** 与 Host 侧 resolveProjectHostService 相同的解析；URL Server 直连不属于 Source 管理域。 */
// URL 直连没有来源域。
// 其余目标用 parseRemoteWorkspaceIdentity 解析身份串。
// 解析失败时返回 undefined，调用方按无来源域处理。
// sourceServerId 为空时调用方不投影阶段日志。
// 不缓存也不改写 host.target，保持与宿主侧一致。
// 算法与宿主侧 resolveProjectHostService 保持一致。
function sourceServerIdForHost(host: RemoteProjectHost): string | undefined {
  if (host.target?.kind === "server") return undefined;
  return parseRemoteWorkspaceIdentity(buildRemoteHostWorkspaceIdentity(host.id, "/"))
    ?.sourceServerId;
}

/** 只用于展示的时钟，详情关闭（组件卸载）即停止，不参与任何超时判定。 */
// active 为 false 时不启动定时器。
// 每秒用 setNow 推进一次展示时钟。
// active 变为 false 时 clearInterval 清掉定时器。
// now 只驱动展示，不参与任何超时判定。
// 返回值恒为 number，调用方无需判空。
function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/**
 * 远程身份详情顶部的连接区，只在详情打开时挂载。
 * 修复原因：侧栏原 (i) 诊断 Tooltip 读取 requestId 文本日志，Host 合并时丢了 onLog 注入、
 * Main 也从未登记该 requestId，连接期间始终为空；改读连接管理服务的结构化操作日志（唯一 owner），
 * 并且只展示用户可读的阶段、进度和失败原因，不展示原始日志。
 */
// 详情打开时父级才挂载 RemoteConnectionProgressSection。
// 阶段日志只取 sourceServerManagementService 的操作日志。
// profileId 只在 connecting 为 true 时解析。
// copiedError 绑定错误原文，错误变化即失效。
// 不展示原始日志行，只投影用户可读阶段与失败原因。
export function RemoteConnectionProgressSection({
  host,
  status,
  error,
}: {
  host: RemoteProjectHost;
  status: RemoteConnectionStatus;
  error?: string;
}) {
  const { intl } = useZCodeIntl();
  const management = useBaseWorkspaceServices().sourceServerManagementService;
  const sourceServerId = sourceServerIdForHost(host);
  const device = useRemoteDevicePresentationInput(sourceServerId);
  // URL Server 直连没有 Source 管理域，也就没有阶段日志可投影，连接中只保留标题状态。
  const connecting = status === "connecting" && sourceServerId !== undefined;
  const profileId = connecting ? device?.profileId : undefined;
  const { logsByProfileId } = useSourceServerOperationLogs(
    management,
    profileId ? [profileId] : [],
  );
  const now = useNow(connecting);
  // 修复原因：布尔值会让新错误沿用“已复制”；记录被复制的原文，错误变化后自然失效。
  const [copiedError, setCopiedError] = useState<string>();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);

  // progress 只在 connecting 分支内计算。
  // startedAt 缺失时不显示耗时。
  // 恢复提示取自 device.recoveryAttempt。
  // 分段条按 progress.total 铺满。
  // 全部文案经 intl.formatMessage 国际化。
  if (connecting) {
    const progress = resolveRemoteOperationProgress(
      profileId ? (logsByProfileId[profileId] ?? []) : [],
    );
    const seconds =
      progress.startedAt === undefined
        ? undefined
        : Math.max(0, Math.floor((now - progress.startedAt) / 1000));
    const meta = [
      msg("remote.progress.step", { current: progress.index + 1, total: progress.total }),
      ...(seconds === undefined
        ? []
        : [
            seconds < 60
              ? msg("remote.progress.elapsedSeconds", { seconds })
              : msg("remote.progress.elapsedMinutesSeconds", {
                  minutes: Math.floor(seconds / 60),
                  seconds: seconds % 60,
                }),
          ]),
      ...(device?.recoveryAttempt
        ? [
            msg("workspaceSidebar.recoveringAutomaticShort", {
              attempt: device.recoveryAttempt,
              limit: device.recoveryLimit ?? 3,
            }),
          ]
        : []),
    ];
    return (
      <div
        data-testid="remote-connection-progress"
        className="mt-3 rounded-lg bg-progress-surface px-2.5 py-2"
      >
        <div className="flex items-center gap-2 font-medium text-progress-surface-foreground">
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          />
          <span className="min-w-0 break-words">
            {msg(progress.titleId)}
            {progress.percent === undefined ? null : ` ${progress.percent}%`}
          </span>
        </div>
        <div className="mt-2 flex gap-1" aria-hidden="true">
          {Array.from({ length: progress.total }, (_, index) => {
            const state =
              index < progress.index ? "complete" : index === progress.index ? "active" : "pending";
            return (
              <div
                key={index}
                data-progress-segment={state}
                className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/10"
              >
                <div
                  className={cn(
                    "h-full rounded-full bg-progress-surface-foreground transition-[width] duration-200",
                    state === "active" &&
                      progress.percent === undefined &&
                      "animate-pulse motion-reduce:animate-none",
                  )}
                  style={{
                    width:
                      state === "complete"
                        ? "100%"
                        : state === "active"
                          ? `${progress.percent ?? 100}%`
                          : "0%",
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="mt-1.5 break-words text-remote-foreground-muted">{meta.join(" · ")}</div>
      </div>
    );
  }

  if (!error || (status !== "failed" && status !== "offline")) return null;
  const reason = classifyRemoteConnectionError({
    errorCode: device?.errorCode,
    error,
    target: host.target ?? undefined,
  });
  return (
    <div
      data-testid="remote-connection-failure"
      className="mt-3 rounded-lg bg-destructive-surface px-2.5 py-2 text-destructive-surface-foreground"
    >
      <div className="break-words font-medium">{msg(reason.titleId, reason.values)}</div>
      <div className="mt-0.5 break-words">{msg(reason.reasonId, reason.values)}</div>
      <button
        type="button"
        data-testid="remote-connection-copy-error"
        className="mt-1.5 inline-flex items-center gap-1 hover:underline"
        onClick={() => {
          void navigator.clipboard
            .writeText(error)
            .then(() => setCopiedError(error))
            .catch((cause) => {
              logger.warn("[project-sidebar] 复制连接错误失败", cause);
              toast(String(cause));
            });
        }}
      >
        {copiedError === error ? (
          <Check aria-hidden="true" className="size-3.5" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5" />
        )}
        {msg(copiedError === error ? "remote.progress.copied" : "remote.progress.copyError")}
      </button>
    </div>
  );
}
