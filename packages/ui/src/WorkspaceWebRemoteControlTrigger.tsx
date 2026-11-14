// INV-01 开关前置：守住位置 外层组件；改错故障：特性关闭仍执行远程会话解析，静态渲染抛错。
// INV-02 状态色单一：守住位置 触发器展示推导；改错故障：图标颜色与提示文案互相矛盾。
// INV-03 已连接只认 active：守住位置 active 分支；改错故障：重连中途显示已连接，与弹层不一致。
// INV-04 未识别回退：守住位置 末尾默认分支；改错故障：新状态没有提示文案，悬停空白。
// INV-05 文案格式化：守住位置 全部提示；改错故障：硬编码中文文案破坏多语言。
// INV-06 会话校验：守住位置 解析器结果采用；改错故障：透传断线后的旧会话，组合出错误端点。
// INV-07 身份优先：守住位置 工作区类型判定；改错故障：远程工作区被上报成本地。
// INV-08 远程类型可缺：守住位置 identity 解析；改错故障：解析失败抛错，入口无法打开。
// INV-09 打开不阻塞：守住位置 点击处理顺序；改错故障：上报失败导致弹层打不开。
// INV-10 日志脱敏：守住位置 日志字段；改错故障：缺失值写成 undefined，难以检索。
// INV-11 紧凑可切：守住位置 尺寸与文案分支；改错故障：紧凑态仍铺满宽度，挤坏底栏。
// INV-12 图标语义：守住位置 图标类名；改错故障：错误态与空闲态同色，问题不可见。
// INV-13 读屏文案：守住位置 紧凑态隐藏文本；改错故障：图标按钮无可读名称。
// INV-14 提示合并：守住位置 触发器提示组件；改错故障：外内两层同时弹提示，互相遮挡。
// INV-15 弹层受控：守住位置 open 与回调；改错故障：弹层自持开关，与触发器不同步。
// INV-16 数据属性：守住位置 图标与按钮；改错故障：端到端测试无法定位连接状态。
// INV-17 路径透传：守住位置 弹层属性；改错故障：弹层读到错误工作区。
// INV-18 无副作用渲染：守住位置 组件体；改错故障：渲染期上报事件，重复计数。
//
// 模块职责：工作区底栏的 Web 远程控制入口按钮与状态提示。
// 状态所有权：连接状态来自轮询钩子；本组件只持弹层开关。
// 阅读顺序：文案类型 → 展示推导 → 开关外壳 → 内容组件 → 点击处理。
import { useState } from "react";
import { Smartphone } from "lucide-react";
import type { WebRemoteControlStatus } from "@zcode/shared";
import {
  buildWebRemoteControlEntryViewTelemetry,
  parseRemoteWorkspaceIdentity,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useWebRemoteControlStatus } from "@/hooks/useWebRemoteControlStatus.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { WebRemoteControlDialog } from "@/web-remote-control/index.js";
import { useWebRemoteControlFeatureEnabled } from "@/WebRemoteControlFeatureProvider.js";

// 从 intl 钩子推导文案函数类型，避免直接依赖 react-intl。
// 只服务触发器文案，不参与状态判断。
//
type FormatMessage = ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"];

// status === "error" 优先，其余状态只影响 iconClassName。
// 文案全部走 formatMessage，不在组件里拼字符串。
// 未识别状态回退 triggerStatus.idle 文案，保证 tooltip 总有可读提示。
// getWebRemoteControlTriggerPresentation 是纯函数，status 对象只需两字段。
// iconClassName 只取语义色类名，不写具体色值。
//
export function getWebRemoteControlTriggerPresentation(
  status: Pick<WebRemoteControlStatus, "status" | "mobileConnected">,
  formatMessage: FormatMessage,
): { iconClassName: string; tooltip: string } {
  if (status.status === "error") {
    return {
      iconClassName: "text-destructive",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.error" }),
    };
  }

  // 已连接只看 active，不把手机已配对当已连接。
  // 中继重连时状态会短暂降到启动或运行，但配对信息仍在。
  // 按配对信息显示已连接会与弹层真实阶段不一致。
  // text-success 只在这一支出现。
  //
  if (status.status === "active") {
    // Bugfix: relay 重连时 main 可能先把 status 降到 starting/running，
    // 但 mobileConnected 仍保留上一轮配对状态。按钮只按 active 显示已连接，
    // 避免和打开弹层后的真实连接阶段文案不一致。
    return {
      iconClassName: "text-success",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connected",
      }),
    };
  }

  if (status.status === "starting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.starting",
      }),
    };
  }

  if (status.status === "connecting") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({
        id: "webRemoteControl.triggerStatus.connecting",
      }),
    };
  }

  if (status.status === "running") {
    return {
      iconClassName: "text-warning",
      tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.waiting" }),
    };
  }

  return {
    iconClassName: "text-foreground-subtle",
    tooltip: formatMessage({ id: "webRemoteControl.triggerStatus.idle" }),
  };
}

// 先读无存储依赖的特性开关，再决定是否进入内容组件。
// 关闭时直接不渲染，连远程会话解析都不执行。
// 否则静态渲染会在缺少 Tab 存储提供者时提前抛错。
//
export function WorkspaceWebRemoteControlTrigger({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const enabled = useWebRemoteControlFeatureEnabled();

  // Bugfix: 生产默认隐藏时如果继续执行远程 session 解析 hook，会依赖 TabStoreProvider 并导致静态渲染提前抛错。
  // 这里先读无 store 依赖的 feature provider，再决定是否进入真正的入口内容。
  if (!enabled) {
    return null;
  }

  return (
    <WorkspaceWebRemoteControlTriggerContent
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      remoteSessionId={remoteSessionId}
      initialTaskId={initialTaskId}
      compact={compact}
      className={className}
    />
  );
}

// 会话解析按身份校验，取不到时保持等待态。
// tab 上的会话标识可能在断线重连后失效。
// 只采用 resolver 给出的 live session，未恢复时让弹层保持 remote-waiting。
// 状态轮询结果只影响图标与 tooltip，不阻断入口。
// workspaceIdentity 与 workspacePath 都缺失时按本地工作区上报。
//
function WorkspaceWebRemoteControlTriggerContent({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
  compact = false,
  className,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { intl } = useZCodeIntl();
  const platform = useOptionalPlatform();
  const mappedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    remoteSessionId,
    workspaceIdentity,
  );
  // 修复原因：tab 上的 remoteSessionId 可能在断线重连期间失效；远控链路同时携带
  // identity 与 session，若继续透传未注册的旧值会组合成错误 endpoint。这里只采用
  // resolver 按 identity 校验后的 live session，未恢复时让弹层保持 remote-waiting。
  // 点击先上报入口事件，失败不影响打开弹层。
  // 远程类型从身份解析，解析失败留空。
  // 日志记录路径与标识，缺省写 none。
  // 紧凑态只显示图标，完整文案交给读屏。
  //
  const currentRemoteSessionId = mappedRemoteSessionId ?? undefined;
  const [webRemoteControlOpen, setWebRemoteControlOpen] = useState(false);
  const remoteControlStatus = useWebRemoteControlStatus();
  const triggerPresentation = getWebRemoteControlTriggerPresentation(
    remoteControlStatus,
    intl.formatMessage,
  );

  return (
    <>
      <ControlHintTooltip
        title={intl.formatMessage({ id: "webRemoteControl.trigger" })}
        description={triggerPresentation.tooltip}
        side="top"
        align="center"
        triggerClassName={compact ? undefined : "w-full"}
      >
        <Button
          variant="ghost"
          onClick={() => {
            if (platform) {
              void reportAppTelemetryEvent(
                platform,
                buildWebRemoteControlEntryViewTelemetry({
                  workspaceKind:
                    workspaceIdentity?.trim() || currentRemoteSessionId ? "remote" : "local",
                  remoteKind: workspaceIdentity
                    ? parseRemoteWorkspaceIdentity(workspaceIdentity)?.kind
                    : undefined,
                }),
                "web-remote-control-entry",
              );
            }
            logger.info("[WorkspaceWebRemoteControlTrigger] 打开 Web 远程控制弹层", {
              workspacePath,
              workspaceIdentity: workspaceIdentity ?? "none",
              remoteSessionId: currentRemoteSessionId ?? "none",
              initialTaskId: initialTaskId ?? "none",
            });
            setWebRemoteControlOpen(true);
          }}
          size={compact ? "icon-lg" : "lg"}
          aria-label={intl.formatMessage({ id: "webRemoteControl.trigger" })}
          className={cn(
            compact
              ? "text-foreground hover:bg-surface-hover hover:text-foreground"
              : "w-full justify-start gap-2 text-foreground hover:bg-surface-hover hover:text-foreground",
            className,
          )}
        >
          {/* Bugfix: 触发入口以前只显示固定手机图标，用户无法从桌面端判断手机是否已连上。
              这里复用远控状态轮询结果，用语义色表达连接状态，并把入口名称和状态文案合进同一个 tooltip，
              避免桌面端 footer 外层和按钮内层同时弹出两份提示。 */}
          <Smartphone className={cn("size-4", triggerPresentation.iconClassName)} />
          {compact ? (
            <span className="sr-only">
              {intl.formatMessage({ id: "webRemoteControl.trigger" })}
            </span>
          ) : (
            intl.formatMessage({ id: "webRemoteControl.trigger" })
          )}
        </Button>
      </ControlHintTooltip>
      <WebRemoteControlDialog
        open={webRemoteControlOpen}
        onOpenChange={setWebRemoteControlOpen}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={currentRemoteSessionId}
        initialTaskId={initialTaskId}
      />
    </>
  );
}
